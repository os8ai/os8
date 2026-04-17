import { describe, it, expect, beforeAll } from 'vitest';

const fs = require('fs');
const path = require('path');
const { StreamStateTracker, labelStep } = require('../../src/services/stream-tracker');

const FIXTURE_PATH = path.join(
  __dirname,
  '../fixtures/stream-transcripts/claude-toolcall.jsonl'
);

describe('StreamStateTracker — behavior lock (Claude fixture replay)', () => {
  let fixture;

  beforeAll(() => {
    const raw = fs.readFileSync(FIXTURE_PATH, 'utf8');
    fixture = raw
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line));
  });

  it('emits the expected callback sequence for a 2-tool transcript', () => {
    const calls = [];
    const tracker = new StreamStateTracker({
      onStepStart: (args) => calls.push(['onStepStart', args]),
      onStepComplete: (args) => calls.push(['onStepComplete', args]),
      onThinkingStart: (args) => calls.push(['onThinkingStart', args]),
      onThinkingEnd: (args) => calls.push(['onThinkingEnd', args])
    });

    for (const event of fixture) {
      tracker.processEvent(event);
    }

    const normalized = calls.map(([name, args]) => {
      const a = { ...args };
      if (typeof a.durationMs === 'number') a.durationMs = '<number>';
      return [name, a];
    });

    expect(normalized).toEqual([
      ['onThinkingStart', { blockIndex: 0 }],
      ['onThinkingEnd', { blockIndex: 0 }],
      ['onStepStart', {
        blockIndex: 1,
        blockType: 'tool_use',
        toolName: 'Read',
        toolInput: '',
        label: 'Reading file',
        stepIndex: 1
      }],
      ['onStepComplete', { blockIndex: 1, durationMs: '<number>', stepIndex: 1 }],
      ['onStepStart', {
        blockIndex: 2,
        blockType: 'tool_use',
        toolName: 'Bash',
        toolInput: '',
        label: 'Running command',
        stepIndex: 2
      }],
      ['onStepComplete', { blockIndex: 2, durationMs: '<number>', stepIndex: 2 }]
    ]);

    for (const [name, args] of calls) {
      if (name === 'onStepComplete') {
        expect(typeof args.durationMs).toBe('number');
        expect(args.durationMs).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('ignores non-stream_event types', () => {
    const calls = [];
    const tracker = new StreamStateTracker({
      onStepStart: () => calls.push('onStepStart'),
      onStepComplete: () => calls.push('onStepComplete'),
      onThinkingStart: () => calls.push('onThinkingStart'),
      onThinkingEnd: () => calls.push('onThinkingEnd')
    });

    tracker.processEvent({ type: 'system', subtype: 'init' });
    tracker.processEvent({ type: 'rate_limit_event' });
    tracker.processEvent({ type: 'assistant', message: {} });
    tracker.processEvent({ type: 'user', message: {} });
    tracker.processEvent({ type: 'result', result: 'final' });

    expect(calls).toEqual([]);
  });

  it('reset() clears state and stepCount', () => {
    const tracker = new StreamStateTracker({});
    for (const event of fixture) {
      tracker.processEvent(event);
    }
    expect(tracker.stepCount).toBe(2);

    tracker.reset();

    expect(tracker.stepCount).toBe(0);
    expect(tracker.currentBlock).toBe(null);
  });

  it('refined label fires once input buffer exceeds 150 chars', () => {
    const calls = [];
    const tracker = new StreamStateTracker({
      onStepStart: (args) => calls.push(args)
    });

    tracker.processEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_x', name: 'Bash', input: {} }
      }
    });
    tracker.processEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"command":"npm test","description":"' + 'x'.repeat(150) + '"}'
        }
      }
    });

    expect(calls.length).toBe(2);
    expect(calls[0].label).toBe('Running command');
    expect(calls[1].label).toBe('Running tests');
  });
});

describe('labelStep', () => {
  it('labels Read with full path when path is short (≤40 chars)', () => {
    expect(labelStep('Read', '{"file_path":"/tmp/probe.txt"}')).toBe('Reading /tmp/probe.txt');
  });

  it('labels Read with basename when path exceeds 40 chars', () => {
    const longPath = '/very/long/directory/tree/segment/deep/foo.js';
    expect(longPath.length).toBeGreaterThan(40);
    expect(labelStep('Read', `{"file_path":"${longPath}"}`)).toBe('Reading foo.js');
  });

  it('labels Read generically with empty input', () => {
    expect(labelStep('Read', '')).toBe('Reading file');
  });

  it('labels Bash generically with empty input', () => {
    expect(labelStep('Bash', '')).toBe('Running command');
  });

  it('labels Bash for npm test', () => {
    expect(labelStep('Bash', '{"command":"npm test"}')).toBe('Running tests');
  });

  it('labels Bash for git subcommands', () => {
    expect(labelStep('Bash', '{"command":"git status"}')).toBe('Git: status');
  });

  it('labels Edit with full path when short', () => {
    expect(labelStep('Edit', '{"file_path":"/app/src/foo.js"}')).toBe('Editing /app/src/foo.js');
  });

  it('labels unknown tool by tool name', () => {
    expect(labelStep('SomeNewTool', '')).toBe('SomeNewTool');
  });
});
