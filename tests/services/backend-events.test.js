import { describe, it, expect, beforeAll } from 'vitest';

const fs = require('fs');
const path = require('path');
const {
  ClaudeTranslator,
  GeminiTranslator,
  CodexTranslator,
  createTranslator
} = require('../../src/services/backend-events');
const {
  RUN_STARTED,
  RUN_FINISHED,
  TEXT_MESSAGE_START,
  TEXT_MESSAGE_CONTENT,
  TEXT_MESSAGE_END,
  TOOL_CALL_START,
  TOOL_CALL_ARGS,
  TOOL_CALL_END,
  TOOL_CALL_RESULT,
  REASONING_START,
  REASONING_CONTENT,
  REASONING_END
} = require('../../src/shared/agui-events');

const FIXTURE_DIR = path.join(__dirname, '../fixtures/stream-transcripts');

function loadFixture(name) {
  const raw = fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
  return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

function replay(translator, events) {
  const out = [];
  for (const e of events) {
    for (const ag of translator.translate(e)) {
      out.push(ag);
    }
  }
  return out;
}

function typeSequence(events) {
  return events.map(e => e.type);
}

describe('ClaudeTranslator — fixture replay', () => {
  let fixture;
  beforeAll(() => { fixture = loadFixture('claude-toolcall.jsonl'); });

  it('emits the expected ag-ui event sequence for the 2-tool transcript', () => {
    const tr = new ClaudeTranslator();
    const events = replay(tr, fixture);

    expect(typeSequence(events)).toEqual([
      RUN_STARTED,                      // system/init
      REASONING_START,                  // thinking block (block 0)
      REASONING_CONTENT,                // thinking deltas
      REASONING_CONTENT,
      REASONING_CONTENT,
      REASONING_END,
      TOOL_CALL_START,                  // Read tool_use (block 1)
      TOOL_CALL_ARGS,                   // empty initial fragment
      TOOL_CALL_ARGS,                   // {"fi
      TOOL_CALL_ARGS,                   // le_path"
      TOOL_CALL_ARGS,                   // : "/
      TOOL_CALL_ARGS,                   // tmp/p
      TOOL_CALL_ARGS,                   // rob
      TOOL_CALL_ARGS,                   // e.txt"}
      TOOL_CALL_END,
      TOOL_CALL_START,                  // Bash tool_use (block 2)
      TOOL_CALL_ARGS,                   // empty
      TOOL_CALL_ARGS,                   // {"com
      TOOL_CALL_RESULT,                 // Read tool result (interleaved)
      TOOL_CALL_ARGS,                   // mand
      TOOL_CALL_ARGS,                   // ": "l
      TOOL_CALL_ARGS,                   // s /tmp"
      TOOL_CALL_ARGS,                   // , "descri
      TOOL_CALL_ARGS,                   // ption":
      TOOL_CALL_ARGS,                   // "List file
      TOOL_CALL_ARGS,                   // s in /tmp"}
      TOOL_CALL_END,
      TOOL_CALL_RESULT,                 // Bash tool result
      TEXT_MESSAGE_START,               // text block (block 0 of msg 2)
      TEXT_MESSAGE_CONTENT,             // 8 text deltas
      TEXT_MESSAGE_CONTENT,
      TEXT_MESSAGE_CONTENT,
      TEXT_MESSAGE_CONTENT,
      TEXT_MESSAGE_CONTENT,
      TEXT_MESSAGE_CONTENT,
      TEXT_MESSAGE_CONTENT,
      TEXT_MESSAGE_END,
      RUN_FINISHED                      // result event
    ]);
  });

  it('uses native session_id as runId', () => {
    const tr = new ClaudeTranslator();
    replay(tr, fixture);
    expect(tr.runId).toBe('62c92b88-84aa-4647-b282-89540c022819');
  });

  it('uses native content_block.id as toolCallId', () => {
    const tr = new ClaudeTranslator();
    const events = replay(tr, fixture);
    const toolStarts = events.filter(e => e.type === TOOL_CALL_START);
    expect(toolStarts).toHaveLength(2);
    expect(toolStarts[0].toolCallId).toBe('toolu_01Hdj4zStKRs7L29ByaMGmDq');
    expect(toolStarts[0].toolCallName).toBe('Read');
    expect(toolStarts[1].toolCallId).toBe('toolu_01B63pWW1YyDUtLBVKuh7hBv');
    expect(toolStarts[1].toolCallName).toBe('Bash');
  });

  it('uses native message.id as messageId for text/reasoning blocks', () => {
    const tr = new ClaudeTranslator();
    const events = replay(tr, fixture);
    const reasoningStart = events.find(e => e.type === REASONING_START);
    const textStart = events.find(e => e.type === TEXT_MESSAGE_START);
    expect(reasoningStart.messageId).toBe('msg_01JSKpKfjFbBivr83a1xybb6');
    expect(textStart.messageId).toBe('msg_01JwyfChp9hNy2BBB3zeBT47');
  });

  it('streams tool args via input_json_delta fragments', () => {
    const tr = new ClaudeTranslator();
    const events = replay(tr, fixture);
    const readToolId = 'toolu_01Hdj4zStKRs7L29ByaMGmDq';
    const readArgs = events.filter(e => e.type === TOOL_CALL_ARGS && e.toolCallId === readToolId);
    const reassembled = readArgs.map(e => e.delta).join('');
    expect(reassembled).toBe('{"file_path": "/tmp/probe.txt"}');
  });

  it('back-references tool_result to native toolCallId', () => {
    const tr = new ClaudeTranslator();
    const events = replay(tr, fixture);
    const results = events.filter(e => e.type === TOOL_CALL_RESULT);
    expect(results).toHaveLength(2);
    expect(results[0].toolCallId).toBe('toolu_01Hdj4zStKRs7L29ByaMGmDq');
    expect(results[0].content).toContain('hello from os8');
    expect(results[1].toolCallId).toBe('toolu_01B63pWW1YyDUtLBVKuh7hBv');
  });

  it('emits RUN_FINISHED with result text and duration', () => {
    const tr = new ClaudeTranslator();
    const events = replay(tr, fixture);
    const finished = events.find(e => e.type === RUN_FINISHED);
    expect(finished).toBeDefined();
    expect(finished.result).toContain('hello from os8');
    expect(typeof finished.durationMs).toBe('number');
  });

  it('emits RUN_STARTED only once even across multiple sources', () => {
    const tr = new ClaudeTranslator();
    const events = replay(tr, fixture);
    expect(events.filter(e => e.type === RUN_STARTED)).toHaveLength(1);
  });

  it('reset() clears bookkeeping for reuse', () => {
    const tr = new ClaudeTranslator({ runId: 'r1' });
    replay(tr, fixture);
    expect(tr.openBlocks.size).toBe(0); // all closed naturally
    tr.reset();
    expect(tr._runStartedEmitted).toBe(false);
    expect(tr.currentMessageId).toBe(null);
  });
});

describe('GeminiTranslator — fixture replay', () => {
  let fixture;
  beforeAll(() => { fixture = loadFixture('gemini-toolcall.jsonl'); });

  it('emits expected ag-ui event sequence', () => {
    const tr = new GeminiTranslator();
    const events = replay(tr, fixture);

    // Init → user message (skipped) → assistant deltas → tool_uses → tool_results → assistant deltas → result
    expect(events[0].type).toBe(RUN_STARTED);

    const lastType = events[events.length - 1].type;
    expect([RUN_FINISHED]).toContain(lastType);

    const toolStarts = events.filter(e => e.type === TOOL_CALL_START);
    expect(toolStarts).toHaveLength(2);
    expect(toolStarts[0].toolCallId).toBe('read_file_1776312971358_0');
    expect(toolStarts[0].toolCallName).toBe('read_file');
    expect(toolStarts[1].toolCallId).toBe('list_directory_1776312971421_1');
  });

  it('uses native tool_id as toolCallId — no synthesis', () => {
    const tr = new GeminiTranslator();
    const events = replay(tr, fixture);
    const ids = events
      .filter(e => e.type === TOOL_CALL_START)
      .map(e => e.toolCallId);
    expect(ids).toEqual(['read_file_1776312971358_0', 'list_directory_1776312971421_1']);
  });

  it('emits TOOL_CALL_END immediately after TOOL_CALL_START (atomic)', () => {
    const tr = new GeminiTranslator();
    const events = replay(tr, fixture);
    for (let i = 0; i < events.length - 1; i++) {
      if (events[i].type === TOOL_CALL_START) {
        expect(events[i + 1].type).toBe(TOOL_CALL_END);
        expect(events[i + 1].toolCallId).toBe(events[i].toolCallId);
      }
    }
  });

  it('synthesizes messageId per delta-run and emits proper start/end pair', () => {
    const tr = new GeminiTranslator();
    const events = replay(tr, fixture);
    const starts = events.filter(e => e.type === TEXT_MESSAGE_START);
    const ends = events.filter(e => e.type === TEXT_MESSAGE_END);
    // Each START must have a matching END
    expect(starts.length).toBe(ends.length);
    // messageIds are unique per run
    const startIds = starts.map(e => e.messageId);
    expect(new Set(startIds).size).toBe(startIds.length);
  });

  it('emits TOOL_CALL_RESULT with status mapping', () => {
    const tr = new GeminiTranslator();
    const events = replay(tr, fixture);
    const results = events.filter(e => e.type === TOOL_CALL_RESULT);
    expect(results).toHaveLength(2);
    // Both errored in the fixture (sandboxed out of /tmp)
    expect(results[0].isError).toBe(true);
    expect(results[1].isError).toBe(true);
  });

  it('uses session_id as runId', () => {
    const tr = new GeminiTranslator();
    replay(tr, fixture);
    expect(tr.runId).toBe('7abd3d06-8077-4a55-8a1e-6856bdc6fa53');
  });
});

describe('CodexTranslator — fixture replay', () => {
  let fixture;
  beforeAll(() => { fixture = loadFixture('codex-toolcall.jsonl'); });

  it('emits expected ag-ui event sequence', () => {
    const tr = new CodexTranslator();
    const events = replay(tr, fixture);

    expect(events[0].type).toBe(RUN_STARTED);
    expect(events[events.length - 1].type).toBe(RUN_FINISHED);

    const toolStarts = events.filter(e => e.type === TOOL_CALL_START);
    expect(toolStarts).toHaveLength(2);
    expect(toolStarts[0].toolCallId).toBe('item_0');
    expect(toolStarts[1].toolCallId).toBe('item_1');
  });

  it('uses thread_id as runId, item.id as toolCallId/messageId', () => {
    const tr = new CodexTranslator();
    const events = replay(tr, fixture);
    expect(tr.runId).toBe('019d9480-fdd6-7872-8473-2d0f65a0c7be');

    const textStart = events.find(e => e.type === TEXT_MESSAGE_START);
    expect(textStart.messageId).toBe('item_2');
  });

  it('collapses agent_message into a single TEXT_MESSAGE start/content/end beat', () => {
    const tr = new CodexTranslator();
    const events = replay(tr, fixture);
    const textStarts = events.filter(e => e.type === TEXT_MESSAGE_START);
    const textContents = events.filter(e => e.type === TEXT_MESSAGE_CONTENT);
    const textEnds = events.filter(e => e.type === TEXT_MESSAGE_END);

    expect(textStarts).toHaveLength(1);
    expect(textContents).toHaveLength(1);
    expect(textEnds).toHaveLength(1);

    expect(textContents[0].delta).toContain('hello from os8');
  });

  it('emits TOOL_CALL_RESULT with exitCode and content', () => {
    const tr = new CodexTranslator();
    const events = replay(tr, fixture);
    const results = events.filter(e => e.type === TOOL_CALL_RESULT);
    expect(results).toHaveLength(2);
    expect(results[0].exitCode).toBe(0);
    expect(results[0].isError).toBe(false);
    expect(results[0].content).toBeDefined();
  });
});

describe('createTranslator factory', () => {
  it('returns a ClaudeTranslator for "claude"', () => {
    expect(createTranslator('claude')).toBeInstanceOf(ClaudeTranslator);
  });

  it('returns a GeminiTranslator for "gemini"', () => {
    expect(createTranslator('gemini')).toBeInstanceOf(GeminiTranslator);
  });

  it('returns a CodexTranslator for "codex"', () => {
    expect(createTranslator('codex')).toBeInstanceOf(CodexTranslator);
  });

  it('returns null for unknown backend', () => {
    expect(createTranslator('grok')).toBe(null);
    expect(createTranslator('unknown')).toBe(null);
  });

  it('passes opts to the translator', () => {
    const tr = createTranslator('claude', { runId: 'r1' });
    expect(tr.runId).toBe('r1');
  });
});
