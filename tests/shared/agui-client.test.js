import { describe, it, expect, beforeAll } from 'vitest';

const fs = require('fs');
const path = require('path');
const {
  ClaudeTranslator,
  GeminiTranslator,
  CodexTranslator
} = require('../../src/services/backend-events');

// AgUiReducer is an ES module; vitest handles the import
import { AgUiReducer } from '../../src/shared/agui-client.js';

const FIXTURE_DIR = path.join(__dirname, '../fixtures/stream-transcripts');

function loadFixture(name) {
  const raw = fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
  return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

function runPipeline(translator, fixture) {
  const reducer = new AgUiReducer();
  for (const raw of fixture) {
    for (const aguiEvent of translator.translate(raw)) {
      reducer.ingest(aguiEvent);
    }
  }
  return reducer;
}

describe('AgUiReducer — basic ingest semantics', () => {
  it('ingest is a no-op for null / undefined / events without type', () => {
    const r = new AgUiReducer();
    expect(() => r.ingest(null)).not.toThrow();
    expect(() => r.ingest(undefined)).not.toThrow();
    expect(() => r.ingest({})).not.toThrow();
    expect(r.state.runs.size).toBe(0);
    expect(r.state.messages.size).toBe(0);
  });

  it('ingest silently ignores unknown event types (legacy events)', () => {
    const r = new AgUiReducer();
    r.ingest({ type: 'stream', text: 'hi' });
    r.ingest({ type: 'done', text: 'bye' });
    r.ingest({ type: 'CUSTOM', name: 'whatever' });
    expect(r.state.runs.size).toBe(0);
    expect(r.state.messages.size).toBe(0);
  });

  it('subscribe returns an unsubscribe function', () => {
    const r = new AgUiReducer();
    let calls = 0;
    const unsub = r.subscribe(() => calls++);
    r.ingest({ type: 'RUN_STARTED', runId: 'r1' });
    expect(calls).toBe(1);
    unsub();
    r.ingest({ type: 'RUN_FINISHED', runId: 'r1' });
    expect(calls).toBe(1);
  });

  it('reset() clears all state and notifies subscribers', () => {
    const r = new AgUiReducer();
    r.ingest({ type: 'RUN_STARTED', runId: 'r1' });
    expect(r.state.runs.size).toBe(1);
    let notified = false;
    r.subscribe(() => { notified = true; });
    r.reset();
    expect(r.state.runs.size).toBe(0);
    expect(notified).toBe(true);
  });
});

describe('AgUiReducer — run lifecycle', () => {
  it('RUN_STARTED creates a run with status=working', () => {
    const r = new AgUiReducer();
    r.ingest({ type: 'RUN_STARTED', runId: 'r1', model: 'claude-opus' });
    const run = r.getRun('r1');
    expect(run.status).toBe('working');
    expect(run.model).toBe('claude-opus');
    expect(typeof run.startedAt).toBe('number');
  });

  it('RUN_FINISHED transitions to finished, preserves startedAt', () => {
    const r = new AgUiReducer();
    r.ingest({ type: 'RUN_STARTED', runId: 'r1' });
    const startedAt = r.getRun('r1').startedAt;
    r.ingest({ type: 'RUN_FINISHED', runId: 'r1', result: 'all done' });
    const run = r.getRun('r1');
    expect(run.status).toBe('finished');
    expect(run.startedAt).toBe(startedAt);
    expect(run.result).toBe('all done');
    expect(typeof run.finishedAt).toBe('number');
  });

  it('RUN_FINISHED with status=cancelled keeps finished bucket', () => {
    const r = new AgUiReducer();
    r.ingest({ type: 'RUN_STARTED', runId: 'r1' });
    r.ingest({ type: 'RUN_FINISHED', runId: 'r1', result: 'cancelled', status: 'cancelled' });
    expect(r.getRun('r1').status).toBe('finished');
  });

  it('RUN_ERROR sets status=error', () => {
    const r = new AgUiReducer();
    r.ingest({ type: 'RUN_ERROR', runId: 'r1', message: 'kaboom' });
    expect(r.getRun('r1').status).toBe('error');
    expect(r.getRun('r1').error).toBe('kaboom');
  });

  it('RUN_FINISHED without prior RUN_STARTED still records the run', () => {
    const r = new AgUiReducer();
    r.ingest({ type: 'RUN_FINISHED', runId: 'r1', result: 'late' });
    expect(r.getRun('r1').status).toBe('finished');
  });
});

describe('AgUiReducer — text messages', () => {
  it('joins text deltas into final content', () => {
    const r = new AgUiReducer();
    r.ingest({ type: 'TEXT_MESSAGE_START', messageId: 'm1', runId: 'r1' });
    r.ingest({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'Hel' });
    r.ingest({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'lo' });
    r.ingest({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: ' world' });
    r.ingest({ type: 'TEXT_MESSAGE_END', messageId: 'm1' });
    const msg = r.getMessage('m1');
    expect(msg.content).toBe('Hello world');
    expect(msg.completed).toBe(true);
  });

  it('synthesizes message if CONTENT arrives before START', () => {
    const r = new AgUiReducer();
    r.ingest({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'orphan' });
    expect(r.getMessage('m1').content).toBe('orphan');
    expect(r.getMessage('m1').completed).toBe(false);
  });

  it('defaults role to assistant', () => {
    const r = new AgUiReducer();
    r.ingest({ type: 'TEXT_MESSAGE_START', messageId: 'm1' });
    expect(r.getMessage('m1').role).toBe('assistant');
  });
});

describe('AgUiReducer — tool calls', () => {
  it('joins tool args fragments into final args string', () => {
    const r = new AgUiReducer();
    r.ingest({ type: 'TOOL_CALL_START', toolCallId: 't1', toolCallName: 'Read' });
    r.ingest({ type: 'TOOL_CALL_ARGS', toolCallId: 't1', delta: '{"file' });
    r.ingest({ type: 'TOOL_CALL_ARGS', toolCallId: 't1', delta: '_path":"/tmp/x"}' });
    r.ingest({ type: 'TOOL_CALL_END', toolCallId: 't1' });
    const tc = r.getToolCall('t1');
    expect(tc.args).toBe('{"file_path":"/tmp/x"}');
    expect(tc.name).toBe('Read');
    expect(tc.status).toBe('complete');
  });

  it('TOOL_CALL_START with inline args (Gemini/Codex shape) seeds args field', () => {
    const r = new AgUiReducer();
    r.ingest({
      type: 'TOOL_CALL_START',
      toolCallId: 't1',
      toolCallName: 'list_directory',
      args: { dir_path: '/tmp' }
    });
    const tc = r.getToolCall('t1');
    expect(tc.args).toBe('{"dir_path":"/tmp"}');
  });

  it('TOOL_CALL_RESULT updates result, isError, exitCode', () => {
    const r = new AgUiReducer();
    r.ingest({ type: 'TOOL_CALL_START', toolCallId: 't1', toolCallName: 'Bash' });
    r.ingest({ type: 'TOOL_CALL_END', toolCallId: 't1' });
    r.ingest({ type: 'TOOL_CALL_RESULT', toolCallId: 't1', content: 'output here', isError: false, exitCode: 0 });
    const tc = r.getToolCall('t1');
    expect(tc.result).toBe('output here');
    expect(tc.isError).toBe(false);
    expect(tc.exitCode).toBe(0);
    expect(tc.status).toBe('result-received');
  });

  it('TOOL_CALL_RESULT without prior TOOL_CALL_START still records', () => {
    const r = new AgUiReducer();
    r.ingest({ type: 'TOOL_CALL_RESULT', toolCallId: 't1', content: 'late', isError: true });
    expect(r.getToolCall('t1').result).toBe('late');
    expect(r.getToolCall('t1').isError).toBe(true);
  });
});

describe('AgUiReducer — reasoning', () => {
  it('joins reasoning deltas into final content', () => {
    const r = new AgUiReducer();
    r.ingest({ type: 'REASONING_START', messageId: 'm1', runId: 'r1' });
    r.ingest({ type: 'REASONING_CONTENT', messageId: 'm1', delta: 'I will ' });
    r.ingest({ type: 'REASONING_CONTENT', messageId: 'm1', delta: 'do X' });
    r.ingest({ type: 'REASONING_END', messageId: 'm1' });
    const r2 = r.getReasoning('m1');
    expect(r2.content).toBe('I will do X');
    expect(r2.completed).toBe(true);
  });

  it('synthesizes reasoning if CONTENT arrives before START', () => {
    const r = new AgUiReducer();
    r.ingest({ type: 'REASONING_CONTENT', messageId: 'm1', delta: 'orphan' });
    expect(r.getReasoning('m1').content).toBe('orphan');
  });
});

describe('Pipeline — Claude translator → reducer (fixture replay)', () => {
  let fixture;
  beforeAll(() => { fixture = loadFixture('claude-toolcall.jsonl'); });

  it('produces one finished run with the full result text', () => {
    const tr = new ClaudeTranslator();
    const r = runPipeline(tr, fixture);

    const runs = Array.from(r.state.runs.values());
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('finished');
    expect(runs[0].result).toContain('hello from os8');
    expect(typeof runs[0].finishedAt).toBe('number');
  });

  it('produces two completed text messages (one per assistant turn — but only one has text block)', () => {
    const tr = new ClaudeTranslator();
    const r = runPipeline(tr, fixture);

    // Fixture has 2 message_starts; first message has thinking + tool_use blocks (no text), second has text only
    const messages = Array.from(r.state.messages.values());
    expect(messages).toHaveLength(1);
    expect(messages[0].completed).toBe(true);
    expect(messages[0].content).toContain('hello from os8');
    expect(messages[0].messageId).toBe('msg_01JwyfChp9hNy2BBB3zeBT47');
  });

  it('produces two tool calls with native IDs, joined args, and back-referenced results', () => {
    const tr = new ClaudeTranslator();
    const r = runPipeline(tr, fixture);

    const tcRead = r.getToolCall('toolu_01Hdj4zStKRs7L29ByaMGmDq');
    expect(tcRead).toBeDefined();
    expect(tcRead.name).toBe('Read');
    expect(tcRead.args).toBe('{"file_path": "/tmp/probe.txt"}');
    expect(tcRead.status).toBe('result-received');
    expect(tcRead.result).toContain('hello from os8');

    const tcBash = r.getToolCall('toolu_01B63pWW1YyDUtLBVKuh7hBv');
    expect(tcBash).toBeDefined();
    expect(tcBash.name).toBe('Bash');
    expect(JSON.parse(tcBash.args)).toMatchObject({
      command: 'ls /tmp',
      description: 'List files in /tmp'
    });
    expect(tcBash.result).toBeDefined();
  });

  it('captures reasoning content for the thinking block', () => {
    const tr = new ClaudeTranslator();
    const r = runPipeline(tr, fixture);

    const reasoning = r.getReasoning('msg_01JSKpKfjFbBivr83a1xybb6');
    expect(reasoning).toBeDefined();
    expect(reasoning.completed).toBe(true);
    expect(reasoning.content).toContain('handle both operations');
  });
});

describe('Pipeline — Gemini translator → reducer (fixture replay)', () => {
  let fixture;
  beforeAll(() => { fixture = loadFixture('gemini-toolcall.jsonl'); });

  it('produces one finished run', () => {
    const tr = new GeminiTranslator();
    const r = runPipeline(tr, fixture);
    const runs = Array.from(r.state.runs.values());
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('finished');
  });

  it('produces atomic tool calls with native tool_id and isError=true (sandboxed)', () => {
    const tr = new GeminiTranslator();
    const r = runPipeline(tr, fixture);

    const tcRead = r.getToolCall('read_file_1776312971358_0');
    expect(tcRead).toBeDefined();
    expect(tcRead.name).toBe('read_file');
    expect(tcRead.status).toBe('result-received');
    expect(tcRead.isError).toBe(true);
    expect(tcRead.result).toContain('Path not in workspace');
  });

  it('produces text messages from delta-runs', () => {
    const tr = new GeminiTranslator();
    const r = runPipeline(tr, fixture);

    const messages = Array.from(r.state.messages.values());
    expect(messages.length).toBeGreaterThanOrEqual(1);
    for (const m of messages) {
      expect(m.completed).toBe(true);
      expect(m.content.length).toBeGreaterThan(0);
    }
  });
});

describe('Pipeline — Codex translator → reducer (fixture replay)', () => {
  let fixture;
  beforeAll(() => { fixture = loadFixture('codex-toolcall.jsonl'); });

  it('produces one finished run with native thread_id as runId', () => {
    const tr = new CodexTranslator();
    const r = runPipeline(tr, fixture);
    const run = r.getRun('019d9480-fdd6-7872-8473-2d0f65a0c7be');
    expect(run).toBeDefined();
    expect(run.status).toBe('finished');
  });

  it('produces tool calls with item.id as toolCallId, exitCode 0', () => {
    const tr = new CodexTranslator();
    const r = runPipeline(tr, fixture);

    const tc0 = r.getToolCall('item_0');
    expect(tc0).toBeDefined();
    expect(tc0.name).toBe('Bash');
    expect(tc0.exitCode).toBe(0);
    expect(tc0.result).toContain('private/tmp');
    expect(tc0.status).toBe('result-received');
  });

  it('produces a single completed text message with the agent_message text', () => {
    const tr = new CodexTranslator();
    const r = runPipeline(tr, fixture);

    const msg = r.getMessage('item_2');
    expect(msg).toBeDefined();
    expect(msg.completed).toBe(true);
    expect(msg.content).toContain('hello from os8');
  });
});
