import { describe, it, expect } from 'vitest';

const {
  createStreamState,
  processSSEChunk,
  finalizeStream
} = require('../../src/services/http-stream-synth');

// Helpers — simulate one OpenAI SSE delta payload (the JSON object after `data: `).
const textChunk = (content, finish_reason = null) => ({
  choices: [{ delta: { content }, ...(finish_reason ? { finish_reason } : {}) }]
});

// Tool-call delta. Fragment ids are optional — they only appear on the first
// fragment for a given index in real OpenAI streams.
const toolCallChunk = (index, args, opts = {}) => ({
  choices: [{
    delta: {
      tool_calls: [{
        index,
        ...(opts.id ? { id: opts.id } : {}),
        ...(opts.type ? { type: opts.type } : {}),
        function: {
          ...(opts.name ? { name: opts.name } : {}),
          arguments: args
        }
      }]
    },
    ...(opts.finish_reason ? { finish_reason: opts.finish_reason } : {})
  }]
});

// Convenience: drain processSSEChunk + finalizeStream into a flat events array.
function runStream(state, chunks) {
  const events = [];
  for (const c of chunks) {
    for (const e of processSSEChunk(state, c)) events.push(e);
  }
  for (const e of finalizeStream(state)) events.push(e);
  return events;
}

describe('http-stream-synth — text-only stream', () => {
  it('opens a text content block and streams text_delta', () => {
    const state = createStreamState();
    const events = runStream(state, [
      textChunk('Hello'),
      textChunk(' world'),
      textChunk('!', 'stop')
    ]);

    // Sequence: content_block_start{text} → 3× content_block_delta{text_delta}
    //         → content_block_stop → result
    expect(events[0]).toMatchObject({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } }
    });
    expect(events.slice(1, 4)).toEqual([
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '!' } } }
    ]);
    expect(events[4]).toEqual({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 0 }
    });
    expect(events[5]).toMatchObject({ type: 'result', subtype: 'success', result: 'Hello world!' });
    expect(state.parseFailure).toBe(null);
  });

  it('does not open a text block when the stream has no content deltas', () => {
    const state = createStreamState();
    const events = runStream(state, [{ choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    // Only the result line remains — no text block to open.
    expect(events.filter(e => e.event?.type === 'content_block_start')).toEqual([]);
    expect(events.find(e => e.type === 'result')).toMatchObject({ result: '' });
  });
});

describe('http-stream-synth — single tool_call', () => {
  it('synthesizes content_block_start{tool_use} → input_json_delta → stop', () => {
    const state = createStreamState();
    const events = runStream(state, [
      toolCallChunk(0, '{"path":"/tmp/', { id: 'call_abc', name: 'Read', type: 'function' }),
      toolCallChunk(0, 'foo.txt"}'),
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ]);

    expect(events[0]).toMatchObject({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 1,                   // 0 reserved for text; tool_use starts at 1
        content_block: { type: 'tool_use', id: 'call_abc', name: 'Read', input: {} }
      }
    });
    expect(events[1]).toMatchObject({
      event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"/tmp/' } }
    });
    expect(events[2]).toMatchObject({
      event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'foo.txt"}' } }
    });
    expect(events[3]).toMatchObject({
      event: { type: 'content_block_stop', index: 1 }
    });
    expect(events[4]).toMatchObject({ type: 'result', subtype: 'success' });
    expect(state.parseFailure).toBe(null);
    expect(state.finishReason).toBe('tool_calls');
  });

  it('treats empty accumulated args as {} (zero-param tool call)', () => {
    const state = createStreamState();
    const events = runStream(state, [
      toolCallChunk(0, '', { id: 'call_x', name: 'NoArgsTool', type: 'function' }),
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ]);
    expect(state.parseFailure).toBe(null);
    expect(events.find(e => e.event?.type === 'content_block_stop')).toBeDefined();
  });
});

describe('http-stream-synth — parallel tool_calls (multiple indices)', () => {
  it('opens distinct claude block_indices for each openai index', () => {
    const state = createStreamState();
    const events = runStream(state, [
      toolCallChunk(0, '{"a":1}', { id: 'call_a', name: 'ToolA', type: 'function' }),
      toolCallChunk(1, '{"b":2}', { id: 'call_b', name: 'ToolB', type: 'function' }),
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ]);

    const starts = events.filter(e => e.event?.type === 'content_block_start');
    expect(starts).toHaveLength(2);
    expect(starts[0].event.index).toBe(1);
    expect(starts[0].event.content_block.id).toBe('call_a');
    expect(starts[1].event.index).toBe(2);
    expect(starts[1].event.content_block.id).toBe('call_b');

    const stops = events.filter(e => e.event?.type === 'content_block_stop');
    expect(stops.map(s => s.event.index).sort()).toEqual([1, 2]);
  });

  it('handles interleaved fragments across openai indices', () => {
    const state = createStreamState();
    const events = runStream(state, [
      toolCallChunk(0, '{"path":', { id: 'call_a', name: 'Read', type: 'function' }),
      toolCallChunk(1, '{"cmd":',  { id: 'call_b', name: 'Bash', type: 'function' }),
      toolCallChunk(0, '"/a"}'),
      toolCallChunk(1, '"ls"}'),
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ]);

    // Each tool's full args, reconstructed by concatenating per-index fragments,
    // must parse to a valid JSON object.
    const callA = state.toolCalls.get(0);
    const callB = state.toolCalls.get(1);
    expect(JSON.parse(callA.accumArgs)).toEqual({ path: '/a' });
    expect(JSON.parse(callB.accumArgs)).toEqual({ cmd: 'ls' });
    expect(state.parseFailure).toBe(null);
  });
});

describe('http-stream-synth — text + tool_call mix', () => {
  it('emits text block then tool_use block, both closed before result', () => {
    const state = createStreamState();
    const events = runStream(state, [
      textChunk('Reading the file now.'),
      toolCallChunk(0, '{"path":"/x"}', { id: 'call_z', name: 'Read', type: 'function' }),
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ]);

    const types = events.map(e => e.event?.type || e.type);
    // Order: text start → text delta → tool_use start → input_json_delta
    //      → tool_use stop → text stop → result
    expect(types).toEqual([
      'content_block_start',  // text (index 0)
      'content_block_delta',  // text_delta
      'content_block_start',  // tool_use (index 1)
      'content_block_delta',  // input_json_delta
      'content_block_stop',   // tool_use stop (closed first)
      'content_block_stop',   // text stop (closed last)
      'result'
    ]);
    expect(events.find(e => e.type === 'result').result).toBe('Reading the file now.');
  });
});

describe('http-stream-synth — parse failure', () => {
  it('flags state.parseFailure when accumulated args are not valid JSON', () => {
    const state = createStreamState();
    runStream(state, [
      toolCallChunk(0, '{"path": broken', { id: 'call_bad', name: 'Read', type: 'function' }),
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ]);
    expect(state.parseFailure).not.toBe(null);
    expect(state.parseFailure.toolCallId).toBe('call_bad');
    expect(state.parseFailure.name).toBe('Read');
    expect(state.parseFailure.detail).toMatch(/invalid JSON/);
  });

  it('emits result with subtype=error and error_code on parse failure', () => {
    const state = createStreamState();
    const events = runStream(state, [
      toolCallChunk(0, 'not json at all', { id: 'call_x', name: 'Bash', type: 'function' }),
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ]);
    const result = events.find(e => e.type === 'result');
    expect(result.subtype).toBe('error');
    expect(result.error_code).toBe('tool_call_parse_failed');
  });

  it('flags parse failure when id/name never arrive', () => {
    const state = createStreamState();
    runStream(state, [
      toolCallChunk(0, 'some args'),  // no id, no name
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ]);
    expect(state.parseFailure).not.toBe(null);
    expect(state.parseFailure.detail).toMatch(/missing id or name/);
  });
});

describe('http-stream-synth — robustness', () => {
  it('handles an empty stream (no chunks at all)', () => {
    const state = createStreamState();
    const events = runStream(state, []);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'result', subtype: 'success', result: '' });
  });

  it('captures finish_reason from a frame with no delta', () => {
    const state = createStreamState();
    runStream(state, [{ choices: [{ delta: {}, finish_reason: 'length' }] }]);
    expect(state.finishReason).toBe('length');
  });

  it('finalizeStream is idempotent — second call does not double-emit stops', () => {
    const state = createStreamState();
    runStream(state, [
      toolCallChunk(0, '{"x":1}', { id: 'call_y', name: 'T', type: 'function' }),
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ]);
    // Second finalize: tool block already finished; only the result line re-emits.
    const second = finalizeStream(state);
    expect(second.filter(e => e.event?.type === 'content_block_stop')).toHaveLength(0);
  });
});
