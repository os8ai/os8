import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const LauncherClient = require('../../src/services/launcher-client');
const { LAUNCHER_ERROR_CODES } = LauncherClient;

describe('LauncherClient.ensureModel (Phase 2B)', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it('POSTs to /api/serve/ensure with the right body shape', async () => {
    let captured = null;
    global.fetch = vi.fn(async (url, opts) => {
      captured = { url, body: JSON.parse(opts.body) };
      return {
        ok: true,
        json: async () => ({
          status: 'ready',
          instance_id: 'ollama-qwen3-coder-30b',
          port: 11434,
          base_url: 'http://localhost:11434',
          model: 'qwen3-coder-30b',
          backend: 'ollama',
          evicted: []
        })
      };
    });
    const result = await LauncherClient.ensureModel({ model: 'qwen3-coder-30b', backend: 'ollama' });
    expect(captured.url).toBe('http://localhost:9000/api/serve/ensure');
    expect(captured.body).toEqual({ model: 'qwen3-coder-30b', backend: 'ollama', wait: false });
    expect(result.status).toBe('ready');
    expect(result.base_url).toBe('http://localhost:11434');
    expect(result.instance_id).toBe('ollama-qwen3-coder-30b');
  });

  it('threads `wait: true` through when requested', async () => {
    let captured = null;
    global.fetch = vi.fn(async (_url, opts) => {
      captured = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ status: 'ready', instance_id: 'x', port: 1, base_url: 'http://x', model: 'm', backend: 'b', evicted: [] }) };
    });
    await LauncherClient.ensureModel({ model: 'm', backend: 'b', wait: true });
    expect(captured.wait).toBe(true);
  });

  it('returns status=loading without throwing', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: 'loading', instance_id: 'vllm-x', port: 8000, base_url: 'http://localhost:8000', model: 'x', backend: 'vllm', evicted: [] })
    }));
    const r = await LauncherClient.ensureModel({ model: 'x', backend: 'vllm' });
    expect(r.status).toBe('loading');
  });

  it('throws BAD_REQUEST when model is missing from the call', async () => {
    global.fetch = vi.fn();
    await expect(LauncherClient.ensureModel({ model: '', backend: 'vllm' }))
      .rejects.toMatchObject({ code: LAUNCHER_ERROR_CODES.BAD_REQUEST });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('throws LAUNCHER_UNREACHABLE on fetch network error', async () => {
    global.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    await expect(LauncherClient.ensureModel({ model: 'x', backend: 'vllm' }))
      .rejects.toMatchObject({ code: LAUNCHER_ERROR_CODES.LAUNCHER_UNREACHABLE });
  });

  it('throws BUDGET_EXCEEDED on 409 with structured detail', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      json: async () => ({ detail: { code: 'BUDGET_EXCEEDED', message: 'no eviction candidates' } })
    }));
    const err = await LauncherClient.ensureModel({ model: 'x', backend: 'vllm' }).catch(e => e);
    expect(err.code).toBe(LAUNCHER_ERROR_CODES.BUDGET_EXCEEDED);
    expect(err.message).toBe('no eviction candidates');
    expect(err.status).toBe(409);
  });

  it('throws START_FAILED on 500 with structured detail', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      statusText: 'Internal',
      json: async () => ({ detail: { code: 'START_FAILED', message: 'docker spawn failed' } })
    }));
    const err = await LauncherClient.ensureModel({ model: 'x', backend: 'vllm' }).catch(e => e);
    expect(err.code).toBe(LAUNCHER_ERROR_CODES.START_FAILED);
    expect(err.message).toMatch(/docker spawn failed/);
  });

  it('falls back to HTTP-status-based code when launcher omits structured detail', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false, status: 400, statusText: 'Bad Request',
      json: async () => ({ detail: 'unknown model name foo' })
    }));
    const err = await LauncherClient.ensureModel({ model: 'foo' }).catch(e => e);
    expect(err.code).toBe(LAUNCHER_ERROR_CODES.BAD_REQUEST);
    expect(err.message).toMatch(/unknown model/);
  });

  it('exports LAUNCHER_ERROR_CODES with the expected shape', () => {
    expect(LAUNCHER_ERROR_CODES).toHaveProperty('LAUNCHER_UNREACHABLE');
    expect(LAUNCHER_ERROR_CODES).toHaveProperty('BUDGET_EXCEEDED');
    expect(LAUNCHER_ERROR_CODES).toHaveProperty('START_FAILED');
    expect(LAUNCHER_ERROR_CODES).toHaveProperty('MODEL_LOAD_TIMEOUT');
  });
});

describe('LauncherClient.touch (Phase 2B)', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it('POSTs to /api/serve/touch with instance_id', async () => {
    let captured = null;
    global.fetch = vi.fn(async (url, opts) => {
      captured = { url, body: JSON.parse(opts.body) };
      return { ok: true, json: async () => ({ touched: true }) };
    });
    await LauncherClient.touch('ollama-qwen3-coder-30b');
    expect(captured.url).toBe('http://localhost:9000/api/serve/touch');
    expect(captured.body).toEqual({ instance_id: 'ollama-qwen3-coder-30b' });
  });

  it('swallows errors silently (fire-and-forget)', async () => {
    global.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    // Should not throw.
    await expect(LauncherClient.touch('whatever')).resolves.toBeUndefined();
  });

  it('no-ops when instanceId is falsy (defensive)', async () => {
    global.fetch = vi.fn();
    await LauncherClient.touch(null);
    await LauncherClient.touch('');
    await LauncherClient.touch(undefined);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
