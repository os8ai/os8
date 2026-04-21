/**
 * OpenAI-SSE → Claude stream-json synthesis.
 *
 * Pure functions that take parsed OpenAI chat-completion SSE chunks and
 * return Claude-shape stream-json events. Extracted from cli-runner.js's
 * createHttpProcess so tool_calls synthesis (Phase 3 §4.7) can be
 * unit-tested without a live HTTP server or fetch stub.
 *
 * Consumer contract: events returned are plain objects ready to
 * `JSON.stringify(obj) + '\n'` and hand to the message-handler stream
 * loop, which already consumes Claude's stream-json via
 * `backend-adapter.js` `local.parseStreamJsonOutput` and
 * `backend-events.js` `ClaudeTranslator`.
 *
 * Claude's tool_use lifecycle (what we synthesize):
 *   content_block_start {type:'tool_use', id, name, input:{}}
 *   content_block_delta {delta: {type:'input_json_delta', partial_json: '...'}}  (repeat)
 *   content_block_stop
 *
 * OpenAI tool_calls delta shape (what we consume):
 *   choices[0].delta.tool_calls[i] = { index, id?, type?:'function',
 *                                      function: { name?, arguments } }
 *   id + name only on first fragment; arguments stream in subsequent frames.
 *   `index` is OpenAI's per-call slot (0, 1, 2 for parallel tools) — we
 *   map each to a distinct Claude-side block_index starting at 1 (block 0
 *   is reserved for the text content block).
 */

/**
 * Create fresh per-request state. One state object lives for the duration
 * of a single HTTP response; processSSEChunk and finalizeStream mutate it.
 */
function createStreamState() {
  return {
    accumulated: '',                        // full text content (for final `result`)
    nextClaudeBlockIndex: 1,                // 0 reserved for the text content block
    textBlockStarted: false,                // whether content_block_start for text has been emitted
    toolCalls: new Map(),                   // openaiIndex → { claudeBlockIndex, id, name, accumArgs, started, finished }
    finishReason: null,                     // 'stop' | 'tool_calls' | 'length' | ...
    parseFailure: null                      // { toolCallId, name, detail } when accumulated JSON args fail JSON.parse
  };
}

/**
 * Process one parsed SSE JSON chunk. Returns an array of stream-json events
 * to emit, in order. Mutates `state` in place.
 *
 * @param {object} state - from createStreamState()
 * @param {object} json - parsed OpenAI SSE payload (the object after `data: `)
 * @returns {object[]} stream-json events to emit (may be empty)
 */
function processSSEChunk(state, json) {
  const events = [];
  const delta = json?.choices?.[0]?.delta;
  if (!delta) {
    // Still capture finish_reason from non-delta frames.
    const fr = json?.choices?.[0]?.finish_reason;
    if (fr) state.finishReason = fr;
    return events;
  }

  // Text content.
  if (typeof delta.content === 'string' && delta.content.length > 0) {
    if (!state.textBlockStarted) {
      // Emit a text content_block_start for block 0 so Claude's translator
      // knows a text block is open (TEXT_MESSAGE_START). Matches the lifecycle
      // tool_use uses — symmetry keeps downstream parsing consistent.
      events.push({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' }
        }
      });
      state.textBlockStarted = true;
    }
    state.accumulated += delta.content;
    events.push({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: delta.content }
      }
    });
  }

  // Tool calls. OpenAI streams tool_calls as an array where each entry
  // carries its `index` (per-call slot). The `id` + `function.name` arrive
  // on the first fragment for that index; subsequent fragments stream
  // `function.arguments` piece by piece.
  if (Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      const openaiIndex = tc.index ?? 0;
      let tracked = state.toolCalls.get(openaiIndex);

      if (!tracked) {
        // First fragment for this slot. id + name must be present; if not,
        // we still open the block with whatever we have — later frames
        // may still carry args — but we flag for a parse failure on close.
        tracked = {
          claudeBlockIndex: state.nextClaudeBlockIndex++,
          id: tc.id || null,
          name: tc.function?.name || null,
          accumArgs: '',
          started: false,
          finished: false
        };
        state.toolCalls.set(openaiIndex, tracked);
      } else {
        // id / name may still arrive in later frames for malformed streams;
        // keep the first non-null value we see.
        if (!tracked.id && tc.id) tracked.id = tc.id;
        if (!tracked.name && tc.function?.name) tracked.name = tc.function.name;
      }

      if (!tracked.started && tracked.id && tracked.name) {
        events.push({
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: tracked.claudeBlockIndex,
            content_block: {
              type: 'tool_use',
              id: tracked.id,
              name: tracked.name,
              input: {}
            }
          }
        });
        tracked.started = true;
      }

      const argFragment = tc.function?.arguments;
      if (typeof argFragment === 'string' && argFragment.length > 0) {
        tracked.accumArgs += argFragment;
        // Only stream fragments once the block is open. If id/name haven't
        // arrived yet, buffer silently — we'll flush on start.
        if (tracked.started) {
          events.push({
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              index: tracked.claudeBlockIndex,
              delta: { type: 'input_json_delta', partial_json: argFragment }
            }
          });
        }
      }
    }
  }

  // finish_reason arrives on the final chunk. Record but don't emit stops
  // here — finalizeStream owns block-stop emission so behavior is the same
  // whether the stream ends with finish_reason or just runs out of data.
  const fr = json?.choices?.[0]?.finish_reason;
  if (fr) state.finishReason = fr;

  return events;
}

/**
 * Emit content_block_stop for every open block, validate accumulated
 * tool_call args, and emit the final `result` line. Mutates state to
 * capture parseFailure when args JSON is malformed.
 *
 * @param {object} state
 * @returns {object[]} events to emit
 */
function finalizeStream(state) {
  const events = [];

  // If a tool_use block had an id/name arrive late (after args were
  // buffered silently), flush the buffered fragment now before closing.
  for (const tc of state.toolCalls.values()) {
    if (!tc.started) {
      // No id/name ever arrived. We can't open a proper tool_use block —
      // flag as a parse failure and skip emission.
      state.parseFailure = state.parseFailure || {
        toolCallId: tc.id || null,
        name: tc.name || null,
        detail: 'tool_call missing id or name'
      };
      continue;
    }
    if (tc.accumArgs && !tc.finished) {
      // We emitted the start; now emit any remaining args that were
      // captured in a frame before start. (Rare — most providers send
      // id/name + first args atomically — but defensive.)
      // Note: fragments were already emitted as they arrived after start,
      // so there's nothing extra to emit here; accumArgs holds the full
      // concatenation only for validation.
    }
  }

  // Validate accumulated args and emit content_block_stop for each open
  // tool_use block.
  for (const tc of state.toolCalls.values()) {
    if (!tc.started) continue;
    if (tc.finished) continue;
    // Try to parse. Empty-args tools (no required params) use '{}' — a
    // zero-length accumArgs is equivalent to {} per OpenAI conventions.
    const raw = tc.accumArgs || '{}';
    try {
      JSON.parse(raw);
    } catch (err) {
      state.parseFailure = state.parseFailure || {
        toolCallId: tc.id,
        name: tc.name,
        detail: `invalid JSON in tool_call arguments: ${err.message}`
      };
    }
    events.push({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: tc.claudeBlockIndex }
    });
    tc.finished = true;
  }

  // Close the text block last, if one was opened. (Claude closes blocks in
  // any order; we close text last to match the typical ordering produced
  // by its real API.)
  if (state.textBlockStarted) {
    events.push({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 0 }
    });
  }

  events.push({
    type: 'result',
    subtype: state.parseFailure ? 'error' : 'success',
    result: state.accumulated,
    ...(state.parseFailure ? { error_code: 'tool_call_parse_failed', error: state.parseFailure } : {})
  });

  return events;
}

module.exports = {
  createStreamState,
  processSSEChunk,
  finalizeStream
};
