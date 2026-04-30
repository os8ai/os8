/**
 * Unit tests for the buildSdk helper used by preload-external-app.js.
 *
 * The preload script itself only runs inside an Electron renderer (it
 * imports `electron`'s `contextBridge`), so we test the pure SDK builder
 * directly against synthetic capability lists. The full BrowserView-side
 * integration is a manual smoke test in PR 1.19.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub `electron` before requiring the preload module — the top-level
// IIFE in preload-external-app.js touches contextBridge/ipcRenderer.
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(async () => ({ ok: false })) },
}));

// JSDOM-friendly globals for the IIFE.
beforeEach(() => {
  globalThis.window = globalThis.window || {
    location: { search: '', pathname: '/', hash: '' },
  };
  globalThis.history = globalThis.history || { replaceState: vi.fn() };
  globalThis.URLSearchParams = globalThis.URLSearchParams || URLSearchParams;
});

const { buildSdk } = require('../src/preload-external-app');

describe('buildSdk — capability gating', () => {
  it('empty caps → empty SDK', () => {
    const sdk = buildSdk([]);
    expect(Object.keys(sdk)).toEqual([]);
  });

  it('blob.readonly exposes read+list, not write/delete', () => {
    const sdk = buildSdk(['blob.readonly']);
    expect(sdk.blob).toBeDefined();
    expect(typeof sdk.blob.read).toBe('function');
    expect(typeof sdk.blob.list).toBe('function');
    expect(sdk.blob.write).toBeUndefined();
    expect(sdk.blob.delete).toBeUndefined();
  });

  it('blob.readwrite exposes all four methods', () => {
    const sdk = buildSdk(['blob.readwrite']);
    expect(typeof sdk.blob.read).toBe('function');
    expect(typeof sdk.blob.list).toBe('function');
    expect(typeof sdk.blob.write).toBe('function');
    expect(typeof sdk.blob.delete).toBe('function');
  });

  it('db.readonly exposes query but not execute', () => {
    const sdk = buildSdk(['db.readonly']);
    expect(typeof sdk.db.query).toBe('function');
    expect(sdk.db.execute).toBeUndefined();
  });

  it('db.readwrite exposes both query and execute', () => {
    const sdk = buildSdk(['db.readwrite']);
    expect(typeof sdk.db.query).toBe('function');
    expect(typeof sdk.db.execute).toBe('function');
  });

  it('imagegen + youtube → both wrappers', () => {
    const sdk = buildSdk(['imagegen', 'youtube']);
    expect(typeof sdk.imagegen.get).toBe('function');
    expect(typeof sdk.imagegen.post).toBe('function');
    expect(typeof sdk.youtube.get).toBe('function');
    expect(sdk.speak).toBeUndefined();
    expect(sdk.x).toBeUndefined();
  });

  it('telegram.send → sdk.telegram.send only', () => {
    const sdk = buildSdk(['telegram.send']);
    expect(typeof sdk.telegram.send).toBe('function');
  });

  it('google.calendar.readonly → calendar wrapper', () => {
    const sdk = buildSdk(['google.calendar.readonly']);
    expect(typeof sdk.googleCalendar.get).toBe('function');
    expect(sdk.googleDrive).toBeUndefined();
    expect(sdk.googleGmail).toBeUndefined();
  });

  it('mcp.<server>.<tool> exposes sdk.mcp callable', () => {
    const sdk = buildSdk(['mcp.tavily.search']);
    expect(typeof sdk.mcp).toBe('function');
  });

  it('mcp.<server>.* wildcard also exposes sdk.mcp', () => {
    const sdk = buildSdk(['mcp.tavily.*']);
    expect(typeof sdk.mcp).toBe('function');
  });

  it('combined caps build the union', () => {
    const sdk = buildSdk([
      'blob.readwrite', 'db.readonly', 'imagegen', 'telegram.send', 'mcp.tavily.*',
    ]);
    expect(sdk.blob.write).toBeDefined();
    expect(sdk.db.query).toBeDefined();
    expect(sdk.db.execute).toBeUndefined();   // only readonly declared
    expect(sdk.imagegen).toBeDefined();
    expect(sdk.telegram.send).toBeDefined();
    expect(typeof sdk.mcp).toBe('function');
  });
});

describe('buildSdk — call wiring', () => {
  let fetchMock;
  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
  });

  function ok(json) {
    return { ok: true, status: 200, json: async () => json };
  }
  function fail(status, body) {
    return { ok: false, status, json: async () => body };
  }

  it('blob.read fetches /_os8/api/blob/<key> and returns a Blob', async () => {
    fetchMock.mockResolvedValue({
      ok: true, status: 200,
      blob: async () => new Blob(['hello']),
    });
    const sdk = buildSdk(['blob.readonly']);
    const r = await sdk.blob.read('foo');
    expect(fetchMock).toHaveBeenCalledWith('/_os8/api/blob/foo');
    expect(r).toBeInstanceOf(Blob);
  });

  it('blob.write PUTs to /_os8/api/blob/<key>', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    const sdk = buildSdk(['blob.readwrite']);
    const data = new Blob(['data']);
    await sdk.blob.write('foo', data);
    expect(fetchMock).toHaveBeenCalledWith('/_os8/api/blob/foo',
      expect.objectContaining({ method: 'PUT' }));
  });

  it('db.query POSTs JSON', async () => {
    fetchMock.mockResolvedValue(ok({ rows: [{ x: 1 }] }));
    const sdk = buildSdk(['db.readonly']);
    const r = await sdk.db.query('SELECT 1');
    expect(fetchMock).toHaveBeenCalledWith('/_os8/api/db/query',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: 'SELECT 1', params: [] }),
      }));
    expect(r.rows).toEqual([{ x: 1 }]);
  });

  it('mcp(server, tool, body) POSTs to /_os8/api/mcp/<server>/<tool>', async () => {
    fetchMock.mockResolvedValue(ok({ result: 'ok' }));
    const sdk = buildSdk(['mcp.tavily.*']);
    const r = await sdk.mcp('tavily', 'search', { query: 'foo' });
    expect(fetchMock).toHaveBeenCalledWith('/_os8/api/mcp/tavily/search',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ query: 'foo' }),
      }));
    expect(r.result).toBe('ok');
  });

  it('non-OK response throws structured error with status + body', async () => {
    fetchMock.mockResolvedValue(fail(403, {
      error: 'capability not declared',
      required: ['blob.readwrite'],
      declared: ['blob.readonly'],
    }));
    const sdk = buildSdk(['blob.readwrite']);
    await expect(sdk.blob.write('x', new Blob([])))
      .rejects.toMatchObject({ status: 403 });
  });
});
