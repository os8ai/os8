/**
 * AgUiReducer — client-side reducer for ag-ui events.
 *
 * Ingests parsed ag-ui SSE frames and maintains structured state:
 *   - runs:      Map<runId, RunState>
 *   - messages:  Map<messageId, MessageState>     (text deltas joined into final content)
 *   - toolCalls: Map<toolCallId, ToolCallState>   (args fragments joined as they stream)
 *   - reasoning: Map<messageId, ReasoningState>
 *
 * Consumers can:
 *   - Call `ingest(parsedFrame)` for each SSE frame received
 *   - Call `getState()` for a snapshot
 *   - Call `subscribe(cb)` for change notifications
 *
 * State shape is read-only by convention. Mutating returned Maps will not
 * notify subscribers and may corrupt internal bookkeeping.
 *
 * Unknown ag-ui event types and legacy types (`stream`, `done`, etc.) are
 * silently ignored — consumers can layer this reducer atop existing legacy
 * handlers without conflict.
 */

// Event type constants (mirror src/shared/agui-events.js — strings are the contract)
const RUN_STARTED = 'RUN_STARTED';
const RUN_FINISHED = 'RUN_FINISHED';
const RUN_ERROR = 'RUN_ERROR';
const TEXT_MESSAGE_START = 'TEXT_MESSAGE_START';
const TEXT_MESSAGE_CONTENT = 'TEXT_MESSAGE_CONTENT';
const TEXT_MESSAGE_END = 'TEXT_MESSAGE_END';
const TOOL_CALL_START = 'TOOL_CALL_START';
const TOOL_CALL_ARGS = 'TOOL_CALL_ARGS';
const TOOL_CALL_END = 'TOOL_CALL_END';
const TOOL_CALL_RESULT = 'TOOL_CALL_RESULT';
const REASONING_START = 'REASONING_START';
const REASONING_CONTENT = 'REASONING_CONTENT';
const REASONING_END = 'REASONING_END';

export class AgUiReducer {
  constructor() {
    this.state = {
      runs: new Map(),
      messages: new Map(),
      toolCalls: new Map(),
      reasoning: new Map()
    };
    this._subscribers = new Set();
  }

  /**
   * Ingest one parsed ag-ui event. Returns the (mutated) state object.
   * Safe to call with unknown or malformed events (no-op).
   *
   * @param {object} event - Parsed JSON from one SSE `data:` line
   * @returns {object} the current state
   */
  ingest(event) {
    if (!event || typeof event !== 'object' || !event.type) return this.state;

    switch (event.type) {
      case RUN_STARTED:        this._runStarted(event); break;
      case RUN_FINISHED:       this._runFinished(event); break;
      case RUN_ERROR:          this._runError(event); break;
      case TEXT_MESSAGE_START: this._textStart(event); break;
      case TEXT_MESSAGE_CONTENT: this._textContent(event); break;
      case TEXT_MESSAGE_END:   this._textEnd(event); break;
      case TOOL_CALL_START:    this._toolStart(event); break;
      case TOOL_CALL_ARGS:     this._toolArgs(event); break;
      case TOOL_CALL_END:      this._toolEnd(event); break;
      case TOOL_CALL_RESULT:   this._toolResult(event); break;
      case REASONING_START:    this._reasoningStart(event); break;
      case REASONING_CONTENT:  this._reasoningContent(event); break;
      case REASONING_END:      this._reasoningEnd(event); break;
      default: return this.state; // unknown / legacy / not applicable — skip notify
    }

    this._notify();
    return this.state;
  }

  _runStarted({ runId, model, tools }) {
    if (!runId) return;
    const existing = this.state.runs.get(runId) || {};
    this.state.runs.set(runId, {
      ...existing,
      runId,
      status: 'working',
      model: model || existing.model,
      tools: tools || existing.tools,
      startedAt: existing.startedAt || Date.now()
    });
  }

  _runFinished({ runId, result, status }) {
    if (!runId) return;
    const existing = this.state.runs.get(runId) || { runId };
    this.state.runs.set(runId, {
      ...existing,
      status: status === 'error' ? 'error' : 'finished',
      finishedAt: Date.now(),
      result
    });
  }

  _runError({ runId, message }) {
    if (!runId) return;
    const existing = this.state.runs.get(runId) || { runId };
    this.state.runs.set(runId, {
      ...existing,
      status: 'error',
      finishedAt: Date.now(),
      error: message
    });
  }

  _textStart({ messageId, runId, role }) {
    if (!messageId) return;
    this.state.messages.set(messageId, {
      messageId,
      runId,
      role: role || 'assistant',
      content: '',
      completed: false,
      startedAt: Date.now()
    });
  }

  _textContent({ messageId, delta, runId, role }) {
    if (!messageId) return;
    const existing = this.state.messages.get(messageId);
    if (existing) {
      existing.content += (delta || '');
    } else {
      // Content arrived without a START — synthesize the message
      this.state.messages.set(messageId, {
        messageId,
        runId,
        role: role || 'assistant',
        content: delta || '',
        completed: false,
        startedAt: Date.now()
      });
    }
  }

  _textEnd({ messageId }) {
    if (!messageId) return;
    const existing = this.state.messages.get(messageId);
    if (existing) {
      existing.completed = true;
      existing.finishedAt = Date.now();
    }
  }

  _toolStart({ toolCallId, toolCallName, parentMessageId, runId, args }) {
    if (!toolCallId) return;
    let initialArgs = '';
    if (args !== undefined) {
      initialArgs = typeof args === 'string' ? args : JSON.stringify(args);
    }
    this.state.toolCalls.set(toolCallId, {
      toolCallId,
      runId,
      name: toolCallName,
      parentMessageId,
      args: initialArgs,
      result: null,
      isError: false,
      status: 'streaming',
      startedAt: Date.now()
    });
  }

  _toolArgs({ toolCallId, delta }) {
    if (!toolCallId) return;
    const existing = this.state.toolCalls.get(toolCallId);
    if (existing) {
      existing.args += (delta || '');
    }
  }

  _toolEnd({ toolCallId }) {
    if (!toolCallId) return;
    const existing = this.state.toolCalls.get(toolCallId);
    if (existing) {
      existing.status = 'complete';
      existing.endedAt = Date.now();
    }
  }

  _toolResult({ toolCallId, content, isError, exitCode }) {
    if (!toolCallId) return;
    const existing = this.state.toolCalls.get(toolCallId) || { toolCallId };
    this.state.toolCalls.set(toolCallId, {
      ...existing,
      result: content,
      isError: !!isError,
      exitCode: exitCode !== undefined ? exitCode : existing.exitCode,
      status: 'result-received',
      resultAt: Date.now()
    });
  }

  _reasoningStart({ messageId, runId }) {
    if (!messageId) return;
    this.state.reasoning.set(messageId, {
      messageId,
      runId,
      content: '',
      completed: false,
      startedAt: Date.now()
    });
  }

  _reasoningContent({ messageId, delta }) {
    if (!messageId) return;
    const existing = this.state.reasoning.get(messageId);
    if (existing) {
      existing.content += (delta || '');
    } else {
      this.state.reasoning.set(messageId, {
        messageId,
        content: delta || '',
        completed: false,
        startedAt: Date.now()
      });
    }
  }

  _reasoningEnd({ messageId }) {
    if (!messageId) return;
    const existing = this.state.reasoning.get(messageId);
    if (existing) {
      existing.completed = true;
      existing.finishedAt = Date.now();
    }
  }

  /**
   * Subscribe to state updates. Returns an unsubscribe function.
   */
  subscribe(callback) {
    this._subscribers.add(callback);
    return () => this._subscribers.delete(callback);
  }

  _notify() {
    for (const cb of this._subscribers) {
      try { cb(this.state); } catch {}
    }
  }

  getState() { return this.state; }
  getRun(runId) { return this.state.runs.get(runId); }
  getMessage(messageId) { return this.state.messages.get(messageId); }
  getToolCall(toolCallId) { return this.state.toolCalls.get(toolCallId); }
  getReasoning(messageId) { return this.state.reasoning.get(messageId); }

  /**
   * Clear all bookkeeping. Notifies subscribers with the empty state.
   */
  reset() {
    this.state = {
      runs: new Map(),
      messages: new Map(),
      toolCalls: new Map(),
      reasoning: new Map()
    };
    this._notify();
  }
}

export default AgUiReducer;
