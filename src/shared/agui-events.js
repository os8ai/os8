/**
 * ag-ui event vocabulary for OS8 SSE streams.
 *
 * Mirrors the ag-ui protocol event names (https://docs.ag-ui.com) so future
 * third-party ag-ui clients can be supported with an adapter instead of a
 * rewrite. Transport remains SSE — this module standardizes event shapes only.
 *
 * See AGUI_RECON.md for the mapping from legacy OS8 event types to these.
 */

const crypto = require('crypto');

const RUN_STARTED = 'RUN_STARTED';
const RUN_FINISHED = 'RUN_FINISHED';
const RUN_ERROR = 'RUN_ERROR';

const STEP_STARTED = 'STEP_STARTED';
const STEP_FINISHED = 'STEP_FINISHED';

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

const STATE_SNAPSHOT = 'STATE_SNAPSHOT';
const STATE_DELTA = 'STATE_DELTA';
const MESSAGES_SNAPSHOT = 'MESSAGES_SNAPSHOT';

const CUSTOM = 'CUSTOM';

const EVENT_TYPES = Object.freeze({
  RUN_STARTED,
  RUN_FINISHED,
  RUN_ERROR,
  STEP_STARTED,
  STEP_FINISHED,
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
  STATE_SNAPSHOT,
  STATE_DELTA,
  MESSAGES_SNAPSHOT,
  CUSTOM
});

function newRunId() {
  return `run_${crypto.randomUUID()}`;
}

function newMessageId() {
  return `msg_${crypto.randomUUID()}`;
}

function newToolCallId() {
  return `tool_${crypto.randomUUID()}`;
}

function buildEvent(type, payload = {}) {
  return { type, timestamp: Date.now(), ...payload };
}

function serializeEvent(type, payload = {}) {
  return `data: ${JSON.stringify(buildEvent(type, payload))}\n\n`;
}

function emit(client, type, payload = {}) {
  if (!client || typeof client.write !== 'function') return;
  try {
    client.write(serializeEvent(type, payload));
  } catch {}
}

function broadcast(clients, type, payload = {}) {
  if (!clients) return;
  const frame = serializeEvent(type, payload);
  for (const client of clients) {
    try {
      client.write(frame);
    } catch {}
  }
}

module.exports = {
  RUN_STARTED,
  RUN_FINISHED,
  RUN_ERROR,
  STEP_STARTED,
  STEP_FINISHED,
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
  STATE_SNAPSHOT,
  STATE_DELTA,
  MESSAGES_SNAPSHOT,
  CUSTOM,
  EVENT_TYPES,
  newRunId,
  newMessageId,
  newToolCallId,
  buildEvent,
  serializeEvent,
  emit,
  broadcast
};
