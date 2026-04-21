import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Test the createHttpProcess ensureModel integration end-to-end. Mocks
// LauncherClient (for ensure/touch responses) and global fetch (for the
// /v1/chat/completions data-plane call). The synthesizer + SSE plumbing
// stay live so we exercise the full happy path the user actually hits.

const LauncherClient = require('../../src/services/launcher-client');
const { getBackend } = require('../../src/services/backend-adapter');
const { createProcess } = require('../../src/services/cli-runner');

// Helper: collect stream-json lines + exit info from a created process.
function drainProcess(proc) {
  const lines = [];
  let exitInfo = null;
  proc.onData(chunk => { lines.push(chunk); });
  return new Promise(resolve => {
    proc.onExit(info => {
      exitInfo = info;
      resolve({ lines: lines.join('').split('\n').filter(Boolean).map(l => JSON.parse(l)), exitInfo });
    });
  });
}

// Build an OpenAI-shape SSE stream from a sequence of content chunks.
// Returns a ReadableStream the fetch mock can use as `response.body`.
function makeSSEStream(chunks, finishReason = 'stop') {
  const encoder = new TextEncoder();
  const frames = chunks.map(c => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
  frames.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`);
  frames.push(`data: [DONE]\n\n`);
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    }
  });
}

describe('createHttpProcess + ensureModel (Phase 2B)', () => {
  let originalEnsure, originalTouch, originalFetch;

  beforeEach(() => {
    originalEnsure = LauncherClient.ensureModel;
    originalTouch = LauncherClient.touch;
    originalFetch = global.fetch;
  });
  afterEach(() => {
    LauncherClient.ensureModel = originalEnsure;
    LauncherClient.touch = originalTouch;
    global.fetch = originalFetch;
  });

  it('ready-on-first-call: ensures, posts to /v1/chat/completions, fires touch on success', async () => {
    let ensureCalls = 0;
    let touchCalled = null;
    LauncherClient.ensureModel = vi.fn(async () => {
      ensureCalls++;
      return {
        status: 'ready',
        instance_id: 'ollama-qwen3-coder-30b',
        port: 11434, base_url: 'http://localhost:11434',
        model: 'qwen3-coder-30b', backend: 'ollama', evicted: []
      };
    });
    LauncherClient.touch = vi.fn(async (id) => { touchCalled = id; });
    global.fetch = vi.fn(async (url) => {
      if (url.endsWith('/v1/chat/completions')) {
        return { ok: true, body: makeSSEStream(['Hello', ' world']) };
      }
    });

    const proc = createProcess(getBackend('local'), [], {
      stdinData: 'say hi',
      promptViaStdin: 'say hi',
      model: 'qwen3-coder-30b',
      taskType: 'conversation',
      launcherModel: 'qwen3-coder-30b',
      launcherBackend: 'ollama'
    });
    const { lines, exitInfo } = await drainProcess(proc);

    expect(LauncherClient.ensureModel).toHaveBeenCalledTimes(1);
    expect(LauncherClient.ensureModel.mock.calls[0][0]).toMatchObject({
      model: 'qwen3-coder-30b', backend: 'ollama'
    });
    expect(global.fetch).toHaveBeenCalled();
    expect(global.fetch.mock.calls[0][0]).toBe('http://localhost:11434/v1/chat/completions');

    // Wait a tick so the fire-and-forget touch has a chance to fire.
    await new Promise(r => setImmediate(r));
    expect(touchCalled).toBe('ollama-qwen3-coder-30b');

    expect(exitInfo.exitCode).toBe(0);
    const result = lines.find(l => l.type === 'result');
    expect(result.result).toBe('Hello world');
  });

  it('loading then ready: emits system_status, polls, then proceeds', async () => {
    let ensureCalls = 0;
    LauncherClient.ensureModel = vi.fn(async () => {
      ensureCalls++;
      if (ensureCalls === 1) {
        return { status: 'loading', instance_id: 'vllm-qwen3-coder-next', port: 8000, base_url: null, model: 'qwen3-coder-next', backend: 'vllm', evicted: [] };
      }
      return { status: 'ready', instance_id: 'vllm-qwen3-coder-next', port: 8000, base_url: 'http://localhost:8000', model: 'qwen3-coder-next', backend: 'vllm', evicted: [] };
    });
    LauncherClient.touch = vi.fn(async () => {});
    global.fetch = vi.fn(async () => ({ ok: true, body: makeSSEStream(['done']) }));

    const proc = createProcess(getBackend('local'), [], {
      stdinData: 'go', promptViaStdin: 'go', model: 'qwen3-coder-next',
      launcherModel: 'qwen3-coder-next', launcherBackend: 'vllm'
    });
    const { lines, exitInfo } = await drainProcess(proc);

    expect(ensureCalls).toBeGreaterThanOrEqual(2);
    const statusEvt = lines.find(l => l.type === 'stream_event' && l.event?.type === 'system_status');
    expect(statusEvt).toBeDefined();
    expect(statusEvt.event.code).toBe('model_loading');
    expect(statusEvt.event.model).toBe('qwen3-coder-next');
    expect(exitInfo.exitCode).toBe(0);
  }, 15_000);  // up to one poll cycle (1s) + a bit of slack

  it('BUDGET_EXCEEDED from ensureModel: exits with stderr `launcher_error:BUDGET_EXCEEDED:`', async () => {
    LauncherClient.ensureModel = vi.fn(async () => {
      const err = new Error('no eviction candidates remain');
      err.code = 'BUDGET_EXCEEDED';
      throw err;
    });
    global.fetch = vi.fn();

    const proc = createProcess(getBackend('local'), [], {
      stdinData: 'x', promptViaStdin: 'x', model: 'm',
      launcherModel: 'qwen3-coder-next', launcherBackend: 'vllm'
    });
    const { exitInfo } = await drainProcess(proc);
    expect(exitInfo.exitCode).toBe(1);
    expect(exitInfo.stderr).toMatch(/^launcher_error:BUDGET_EXCEEDED: /);
  });

  it('LAUNCHER_UNREACHABLE from ensureModel: exits with stderr `launcher_error:LAUNCHER_UNREACHABLE:`', async () => {
    LauncherClient.ensureModel = vi.fn(async () => {
      const err = new Error('Launcher unreachable: ECONNREFUSED');
      err.code = 'LAUNCHER_UNREACHABLE';
      throw err;
    });
    global.fetch = vi.fn();

    const proc = createProcess(getBackend('local'), [], {
      stdinData: 'x', promptViaStdin: 'x', model: 'm',
      launcherModel: 'gemma-4-31B-it-nvfp4', launcherBackend: 'vllm'
    });
    const { exitInfo } = await drainProcess(proc);
    expect(exitInfo.exitCode).toBe(1);
    expect(exitInfo.stderr).toMatch(/^launcher_error:LAUNCHER_UNREACHABLE: /);
  });

  it('legacy path (no launcherModel) still works via getCapabilities', async () => {
    // No launcherModel passed — should fall back to capabilities lookup.
    LauncherClient.ensureModel = vi.fn();
    LauncherClient.getCapabilities = vi.fn(async () => ({
      conversation: [{ instance_id: 'vllm-x', model: 'x', model_id: 'x', base_url: 'http://localhost:8000', priority: 0 }]
    }));
    LauncherClient.touch = vi.fn(async () => {});
    global.fetch = vi.fn(async () => ({ ok: true, body: makeSSEStream(['hi']) }));

    const proc = createProcess(getBackend('local'), [], {
      stdinData: 'q', promptViaStdin: 'q', model: 'x'
      // no launcherModel
    });
    const { lines, exitInfo } = await drainProcess(proc);

    expect(LauncherClient.ensureModel).not.toHaveBeenCalled();
    expect(LauncherClient.getCapabilities).toHaveBeenCalled();
    expect(exitInfo.exitCode).toBe(0);
    const result = lines.find(l => l.type === 'result');
    expect(result.result).toBe('hi');
  });
});
