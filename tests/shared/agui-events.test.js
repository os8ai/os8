import { describe, it, expect } from 'vitest';

const {
  RUN_STARTED,
  TEXT_MESSAGE_CONTENT,
  TOOL_CALL_START,
  EVENT_TYPES,
  newRunId,
  newMessageId,
  newToolCallId,
  buildEvent,
  serializeEvent,
  emit,
  broadcast
} = require('../../src/shared/agui-events');

function parseFrame(frame) {
  expect(frame).toMatch(/^data: /);
  expect(frame).toMatch(/\n\n$/);
  return JSON.parse(frame.slice(6, -2));
}

describe('agui-events — event type constants', () => {
  it('exports top-level constants matching ag-ui names', () => {
    expect(RUN_STARTED).toBe('RUN_STARTED');
    expect(TEXT_MESSAGE_CONTENT).toBe('TEXT_MESSAGE_CONTENT');
    expect(TOOL_CALL_START).toBe('TOOL_CALL_START');
  });

  it('EVENT_TYPES registry contains the full ag-ui vocabulary', () => {
    const expected = [
      'RUN_STARTED', 'RUN_FINISHED', 'RUN_ERROR',
      'STEP_STARTED', 'STEP_FINISHED',
      'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END',
      'TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END', 'TOOL_CALL_RESULT',
      'REASONING_START', 'REASONING_CONTENT', 'REASONING_END',
      'STATE_SNAPSHOT', 'STATE_DELTA', 'MESSAGES_SNAPSHOT',
      'CUSTOM'
    ];
    for (const key of expected) {
      expect(EVENT_TYPES[key]).toBe(key);
    }
  });

  it('EVENT_TYPES is frozen', () => {
    expect(Object.isFrozen(EVENT_TYPES)).toBe(true);
  });
});

describe('agui-events — ID generators', () => {
  it('newRunId produces unique prefixed IDs', () => {
    const a = newRunId();
    const b = newRunId();
    expect(a).toMatch(/^run_[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });

  it('newMessageId produces unique prefixed IDs', () => {
    const a = newMessageId();
    expect(a).toMatch(/^msg_[0-9a-f-]{36}$/);
    expect(a).not.toBe(newMessageId());
  });

  it('newToolCallId produces unique prefixed IDs', () => {
    const a = newToolCallId();
    expect(a).toMatch(/^tool_[0-9a-f-]{36}$/);
    expect(a).not.toBe(newToolCallId());
  });
});

describe('agui-events — buildEvent / serializeEvent', () => {
  it('buildEvent wraps type and timestamp around payload', () => {
    const before = Date.now();
    const e = buildEvent(RUN_STARTED, { runId: 'r1', threadId: 't1' });
    const after = Date.now();

    expect(e.type).toBe('RUN_STARTED');
    expect(e.runId).toBe('r1');
    expect(e.threadId).toBe('t1');
    expect(e.timestamp).toBeGreaterThanOrEqual(before);
    expect(e.timestamp).toBeLessThanOrEqual(after);
  });

  it('buildEvent defaults payload to empty', () => {
    const e = buildEvent(RUN_STARTED);
    expect(e.type).toBe('RUN_STARTED');
    expect(typeof e.timestamp).toBe('number');
  });

  it('serializeEvent produces a valid SSE frame', () => {
    const frame = serializeEvent(RUN_STARTED, { runId: 'r1' });
    const parsed = parseFrame(frame);
    expect(parsed).toMatchObject({ type: 'RUN_STARTED', runId: 'r1' });
  });
});

describe('agui-events — emit', () => {
  it('writes one SSE frame to a client', () => {
    const writes = [];
    const client = { write: (s) => writes.push(s) };

    emit(client, TEXT_MESSAGE_CONTENT, { messageId: 'm1', delta: 'hi' });

    expect(writes).toHaveLength(1);
    expect(parseFrame(writes[0])).toMatchObject({
      type: 'TEXT_MESSAGE_CONTENT',
      messageId: 'm1',
      delta: 'hi'
    });
  });

  it('is safe when client is null or missing write()', () => {
    expect(() => emit(null, RUN_STARTED, {})).not.toThrow();
    expect(() => emit(undefined, RUN_STARTED, {})).not.toThrow();
    expect(() => emit({}, RUN_STARTED, {})).not.toThrow();
  });

  it('swallows write errors (disconnected client)', () => {
    const client = { write: () => { throw new Error('disconnected'); } };
    expect(() => emit(client, RUN_STARTED, {})).not.toThrow();
  });
});

describe('agui-events — broadcast', () => {
  it('writes to every client in a Set', () => {
    const writesA = [];
    const writesB = [];
    const clients = new Set([
      { write: (s) => writesA.push(s) },
      { write: (s) => writesB.push(s) }
    ]);

    broadcast(clients, TEXT_MESSAGE_CONTENT, { messageId: 'm1', delta: 'x' });

    expect(writesA).toHaveLength(1);
    expect(writesB).toHaveLength(1);
    expect(parseFrame(writesA[0])).toMatchObject({ type: 'TEXT_MESSAGE_CONTENT' });
  });

  it('continues to remaining clients when one throws', () => {
    const writes = [];
    const clients = new Set([
      { write: () => { throw new Error('gone'); } },
      { write: (s) => writes.push(s) }
    ]);

    broadcast(clients, RUN_STARTED, { runId: 'r1' });

    expect(writes).toHaveLength(1);
  });

  it('is safe with null clients', () => {
    expect(() => broadcast(null, RUN_STARTED, {})).not.toThrow();
  });

  it('sends identical frames to all clients', () => {
    const writesA = [];
    const writesB = [];
    const clients = [
      { write: (s) => writesA.push(s) },
      { write: (s) => writesB.push(s) }
    ];

    broadcast(clients, RUN_STARTED, { runId: 'r1' });

    const a = parseFrame(writesA[0]);
    const b = parseFrame(writesB[0]);
    expect(a).toEqual(b);
  });
});

