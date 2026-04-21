/**
 * Backend event translators — convert raw CLI stream-json events into ag-ui events.
 *
 * Each backend produces structurally different stream events (Claude: block-indexed
 * stream_events; Gemini: flat per-message events; Codex: thread/turn/item model).
 * This module normalizes them to the ag-ui vocabulary with NATIVE IDs from each
 * backend wherever possible (no synthesis):
 *
 *   - Claude: session_id → runId, message.id → messageId, content_block.id → toolCallId
 *   - Gemini: session_id → runId, tool_id → toolCallId
 *   - Codex:  thread_id → runId, item.id → toolCallId / messageId
 *
 * See AGUI_RECON.md round 3 for the full event-shape mapping per backend.
 *
 * Usage:
 *   const translator = new ClaudeTranslator({ runId });
 *   for (const aguiEvent of translator.translate(rawJsonEvent)) {
 *     emit(client, aguiEvent.type, aguiEvent);
 *   }
 */

const {
  RUN_STARTED,
  RUN_FINISHED,
  RUN_ERROR,
  TEXT_MESSAGE_START,
  TEXT_MESSAGE_CONTENT,
  TEXT_MESSAGE_END,
  TOOL_CALL_START,
  TOOL_CALL_ARGS,
  TOOL_CALL_END,
  TOOL_CALL_RESULT,
  REASONING_START,
  REASONING_CONTENT,
  REASONING_END,
  newMessageId
} = require('../shared/agui-events');

/**
 * ClaudeTranslator — stateful translator for Claude Code stream-json events.
 *
 * Maintains per-run bookkeeping:
 *   - currentMessageId (set on message_start, used for text/reasoning blocks)
 *   - openBlocks (Map<index, {blockType, toolCallId?}>) — tracks which block
 *     types are currently open so content_block_stop can emit the right END
 *     event without re-inspecting the stream.
 *
 * Stateless events (system, result, user/tool_result) are handled directly.
 */
class ClaudeTranslator {
  /**
   * @param {object} [opts]
   * @param {string} [opts.runId] - Optional pre-assigned runId. If omitted, captured from session_id at first system/init event.
   */
  constructor({ runId } = {}) {
    this.runId = runId || null;
    this.currentMessageId = null;
    this.openBlocks = new Map();
    this._runStartedEmitted = false;
  }

  /**
   * Translate a single raw Claude stream-json event into zero or more ag-ui events.
   * @param {object} event - Parsed JSON object from one stream-json line
   * @returns {Array<object>} ag-ui events to emit (each has at least { type })
   */
  translate(event) {
    if (!event || typeof event !== 'object') return [];

    if (event.type === 'stream_event' && event.event) {
      return this._translateStreamEvent(event.event);
    }

    switch (event.type) {
      case 'system':
        return this._translateSystemEvent(event);
      case 'user':
        return this._translateUserEvent(event);
      case 'result':
        return this._translateResultEvent(event);
      default:
        return [];
    }
  }

  _translateSystemEvent(event) {
    const out = [];
    if (event.subtype === 'init') {
      if (event.session_id && !this.runId) {
        this.runId = event.session_id;
      }
      if (!this._runStartedEmitted && this.runId) {
        out.push({
          type: RUN_STARTED,
          runId: this.runId,
          model: event.model,
          tools: event.tools
        });
        this._runStartedEmitted = true;
      }
    }
    return out;
  }

  _translateStreamEvent(e) {
    switch (e.type) {
      case 'message_start':
        return this._handleMessageStart(e);
      case 'content_block_start':
        return this._handleBlockStart(e);
      case 'content_block_delta':
        return this._handleBlockDelta(e);
      case 'content_block_stop':
        return this._handleBlockStop(e);
      case 'message_stop':
      case 'message_delta':
        return [];
      default:
        return [];
    }
  }

  _handleMessageStart(e) {
    this.currentMessageId = e.message?.id || newMessageId();
    const out = [];
    if (!this._runStartedEmitted && this.runId) {
      out.push({
        type: RUN_STARTED,
        runId: this.runId,
        model: e.message?.model
      });
      this._runStartedEmitted = true;
    }
    return out;
  }

  _handleBlockStart(e) {
    const block = e.content_block;
    if (!block) return [];
    const idx = e.index ?? 0;

    if (block.type === 'tool_use') {
      const toolCallId = block.id;
      this.openBlocks.set(idx, { blockType: 'tool_use', toolCallId });
      return [{
        type: TOOL_CALL_START,
        runId: this.runId,
        parentMessageId: this.currentMessageId,
        toolCallId,
        toolCallName: block.name
      }];
    }

    if (block.type === 'thinking') {
      this.openBlocks.set(idx, { blockType: 'thinking' });
      return [{
        type: REASONING_START,
        runId: this.runId,
        messageId: this.currentMessageId
      }];
    }

    if (block.type === 'text') {
      this.openBlocks.set(idx, { blockType: 'text' });
      return [{
        type: TEXT_MESSAGE_START,
        runId: this.runId,
        messageId: this.currentMessageId,
        role: 'assistant'
      }];
    }

    return [];
  }

  _handleBlockDelta(e) {
    const idx = e.index ?? 0;
    const block = this.openBlocks.get(idx);
    if (!block) return [];
    const delta = e.delta;
    if (!delta) return [];

    if (delta.type === 'input_json_delta' && block.blockType === 'tool_use') {
      return [{
        type: TOOL_CALL_ARGS,
        runId: this.runId,
        toolCallId: block.toolCallId,
        delta: delta.partial_json || ''
      }];
    }

    if (delta.type === 'thinking_delta' && block.blockType === 'thinking') {
      return [{
        type: REASONING_CONTENT,
        runId: this.runId,
        messageId: this.currentMessageId,
        delta: delta.thinking || ''
      }];
    }

    if (delta.type === 'text_delta' && block.blockType === 'text') {
      return [{
        type: TEXT_MESSAGE_CONTENT,
        runId: this.runId,
        messageId: this.currentMessageId,
        delta: delta.text || ''
      }];
    }

    return [];
  }

  _handleBlockStop(e) {
    const idx = e.index ?? 0;
    const block = this.openBlocks.get(idx);
    if (!block) return [];
    this.openBlocks.delete(idx);

    if (block.blockType === 'tool_use') {
      return [{
        type: TOOL_CALL_END,
        runId: this.runId,
        toolCallId: block.toolCallId
      }];
    }
    if (block.blockType === 'thinking') {
      return [{
        type: REASONING_END,
        runId: this.runId,
        messageId: this.currentMessageId
      }];
    }
    if (block.blockType === 'text') {
      return [{
        type: TEXT_MESSAGE_END,
        runId: this.runId,
        messageId: this.currentMessageId
      }];
    }
    return [];
  }

  _translateUserEvent(event) {
    // tool_result events arrive wrapped as user messages
    const content = event.message?.content;
    if (!Array.isArray(content)) return [];

    const out = [];
    for (const part of content) {
      if (part.type === 'tool_result' && part.tool_use_id) {
        out.push({
          type: TOOL_CALL_RESULT,
          runId: this.runId,
          toolCallId: part.tool_use_id,
          content: part.content,
          isError: part.is_error || false
        });
      }
    }
    return out;
  }

  _translateResultEvent(event) {
    if (event.session_id && !this.runId) {
      this.runId = event.session_id;
    }
    return [{
      type: event.is_error ? RUN_ERROR : RUN_FINISHED,
      runId: this.runId,
      result: event.result,
      durationMs: event.duration_ms,
      status: event.is_error ? 'error' : (event.subtype || 'completed'),
      usage: event.usage
    }];
  }

  reset() {
    this.currentMessageId = null;
    this.openBlocks.clear();
    this._runStartedEmitted = false;
  }
}

/**
 * GeminiTranslator — stateful translator for Gemini CLI stream-json events.
 *
 * Gemini's stream is flat (no block indices). Tool calls are atomic — full
 * parameters arrive in a single tool_use event. Text deltas have no native
 * messageId, so we synthesize one per contiguous run of delta:true messages.
 */
class GeminiTranslator {
  constructor({ runId } = {}) {
    this.runId = runId || null;
    this.currentMessageId = null;
    this._inDeltaRun = false;
    this._runStartedEmitted = false;
  }

  translate(event) {
    if (!event || typeof event !== 'object') return [];

    switch (event.type) {
      case 'init': {
        const out = [];
        if (event.session_id && !this.runId) {
          this.runId = event.session_id;
        }
        if (!this._runStartedEmitted && this.runId) {
          out.push({ type: RUN_STARTED, runId: this.runId, model: event.model });
          this._runStartedEmitted = true;
        }
        return out;
      }

      case 'message': {
        if (event.role !== 'assistant') return [];
        return this._handleAssistantMessage(event);
      }

      case 'tool_use':
        return this._handleToolUse(event);

      case 'tool_result':
        return this._handleToolResult(event);

      case 'result': {
        const out = this._closeOpenTextRun();
        out.push({
          type: event.status === 'error' ? RUN_ERROR : RUN_FINISHED,
          runId: this.runId,
          status: event.status,
          stats: event.stats
        });
        return out;
      }

      default:
        return [];
    }
  }

  _handleAssistantMessage(event) {
    const out = [];
    const text = event.content || '';

    if (event.delta) {
      // Streaming delta — open a new message session if this is the first delta
      if (!this._inDeltaRun) {
        this.currentMessageId = newMessageId();
        this._inDeltaRun = true;
        out.push({
          type: TEXT_MESSAGE_START,
          runId: this.runId,
          messageId: this.currentMessageId,
          role: 'assistant'
        });
      }
      out.push({
        type: TEXT_MESSAGE_CONTENT,
        runId: this.runId,
        messageId: this.currentMessageId,
        delta: text
      });
    } else {
      // Non-delta — close any open delta session
      if (this._inDeltaRun) {
        out.push({
          type: TEXT_MESSAGE_END,
          runId: this.runId,
          messageId: this.currentMessageId
        });
        this._inDeltaRun = false;
        this.currentMessageId = null;
      }
    }

    return out;
  }

  _closeOpenTextRun() {
    if (!this._inDeltaRun) return [];
    const out = [{
      type: TEXT_MESSAGE_END,
      runId: this.runId,
      messageId: this.currentMessageId
    }];
    this._inDeltaRun = false;
    this.currentMessageId = null;
    return out;
  }

  _handleToolUse(event) {
    // Close any open text run before a tool call (Gemini interleaves freely)
    const out = this._closeOpenTextRun();
    out.push({
      type: TOOL_CALL_START,
      runId: this.runId,
      toolCallId: event.tool_id,
      toolCallName: event.tool_name,
      args: event.parameters
    });
    out.push({
      type: TOOL_CALL_END,
      runId: this.runId,
      toolCallId: event.tool_id
    });
    return out;
  }

  _handleToolResult(event) {
    return [{
      type: TOOL_CALL_RESULT,
      runId: this.runId,
      toolCallId: event.tool_id,
      content: event.output,
      isError: event.status === 'error'
    }];
  }

  reset() {
    this.currentMessageId = null;
    this._inDeltaRun = false;
    this._runStartedEmitted = false;
  }
}

/**
 * CodexTranslator — stateful translator for Codex JSONL events.
 *
 * Codex uses a thread/turn/item model. Tool calls and assistant messages
 * both arrive as items. Text doesn't stream — it appears once at completion
 * in an `agent_message` item, so TEXT_MESSAGE_START/CONTENT/END collapse
 * into a single beat per message.
 */
class CodexTranslator {
  constructor({ runId } = {}) {
    this.runId = runId || null;
    this._runStartedEmitted = false;
    this._inProgressTools = new Map(); // item.id → toolCallName
  }

  translate(event) {
    if (!event || typeof event !== 'object') return [];

    switch (event.type) {
      case 'thread.started': {
        const out = [];
        if (event.thread_id && !this.runId) {
          this.runId = event.thread_id;
        }
        if (!this._runStartedEmitted && this.runId) {
          out.push({ type: RUN_STARTED, runId: this.runId });
          this._runStartedEmitted = true;
        }
        return out;
      }

      case 'turn.started':
        return [];

      case 'item.started':
        return this._handleItemStarted(event);

      case 'item.completed':
        return this._handleItemCompleted(event);

      case 'turn.completed':
        return [{
          type: RUN_FINISHED,
          runId: this.runId,
          usage: event.usage
        }];

      default:
        return [];
    }
  }

  _handleItemStarted(event) {
    const item = event.item;
    if (!item) return [];

    if (item.type === 'command_execution') {
      this._inProgressTools.set(item.id, 'Bash');
      return [{
        type: TOOL_CALL_START,
        runId: this.runId,
        toolCallId: item.id,
        toolCallName: 'Bash',
        args: { command: item.command }
      }];
    }
    return [];
  }

  _handleItemCompleted(event) {
    const item = event.item;
    if (!item) return [];

    if (item.type === 'command_execution') {
      this._inProgressTools.delete(item.id);
      return [
        {
          type: TOOL_CALL_END,
          runId: this.runId,
          toolCallId: item.id
        },
        {
          type: TOOL_CALL_RESULT,
          runId: this.runId,
          toolCallId: item.id,
          content: item.aggregated_output,
          isError: item.exit_code !== 0,
          exitCode: item.exit_code
        }
      ];
    }

    if (item.type === 'agent_message') {
      // Codex emits final text once — collapse start/content/end into one beat
      return [
        {
          type: TEXT_MESSAGE_START,
          runId: this.runId,
          messageId: item.id,
          role: 'assistant'
        },
        {
          type: TEXT_MESSAGE_CONTENT,
          runId: this.runId,
          messageId: item.id,
          delta: item.text
        },
        {
          type: TEXT_MESSAGE_END,
          runId: this.runId,
          messageId: item.id
        }
      ];
    }

    return [];
  }

  reset() {
    this._runStartedEmitted = false;
    this._inProgressTools.clear();
  }
}

/**
 * Factory — picks the right translator for a backend ID.
 * @param {string} backendId - 'claude' | 'gemini' | 'codex'
 * @param {object} opts - Passed to the translator constructor
 * @returns {ClaudeTranslator | GeminiTranslator | CodexTranslator | null}
 */
function createTranslator(backendId, opts = {}) {
  switch (backendId) {
    case 'claude': return new ClaudeTranslator(opts);
    // Phase 3 (os8-3-3): the local HTTP backend synthesizes Claude-shape
    // stream-json (message_start, content_block_start{tool_use},
    // input_json_delta, content_block_stop, message_stop) in
    // src/services/http-stream-synth.js. ClaudeTranslator handles it
    // unchanged — TOOL_CALL_START/ARGS/END/RESULT ag-ui events fire
    // for qwen3-coder tool calls just as they would for Claude Code's.
    case 'local':  return new ClaudeTranslator(opts);
    case 'gemini': return new GeminiTranslator(opts);
    case 'codex':  return new CodexTranslator(opts);
    default: return null;
  }
}

module.exports = {
  ClaudeTranslator,
  GeminiTranslator,
  CodexTranslator,
  createTranslator
};
