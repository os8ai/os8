import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const Database = require('better-sqlite3');
const TTSService = require('../../src/services/tts');

function makeDb({ provider, kokoroFamily = true } = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE env_variables (id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, value TEXT NOT NULL, encrypted INTEGER DEFAULT 0);
    CREATE TABLE ai_model_families (
      id TEXT PRIMARY KEY,
      container_id TEXT NOT NULL,
      name TEXT NOT NULL,
      launcher_model TEXT
    );
  `);
  if (provider) {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('tts_provider', ?)`).run(provider);
  }
  if (kokoroFamily) {
    db.prepare(`INSERT INTO ai_model_families (id, container_id, name, launcher_model) VALUES ('local-kokoro-v1', 'local', 'Kokoro', 'kokoro-v1')`).run();
  }
  return db;
}

describe('TTSService.isAvailableAsync (Phase 3-5 follow-up — accurate availability)', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it('reports no_provider when none is selected', async () => {
    const db = makeDb({ provider: null });
    const result = await TTSService.isAvailableAsync(db);
    expect(result).toEqual({ available: false, provider: null, reason: 'no_provider' });
    db.close();
  });

  it('cloud providers — defers to sync isAvailable (no API key set)', async () => {
    const db = makeDb({ provider: 'openai' });
    // No fetch should happen — cloud path is sync.
    global.fetch = vi.fn();
    const result = await TTSService.isAvailableAsync(db);
    expect(result.provider).toBe('openai');
    expect(result.available).toBe(false);
    expect(result.reason).toBe('no_api_key');
    expect(global.fetch).not.toHaveBeenCalled();
    db.close();
  });

  it('cloud providers — available when API key is set', async () => {
    const db = makeDb({ provider: 'elevenlabs' });
    db.prepare(`INSERT INTO env_variables (id, key, value) VALUES ('1', 'ELEVENLABS_API_KEY', 'sk_xxx')`).run();
    global.fetch = vi.fn();
    const result = await TTSService.isAvailableAsync(db);
    expect(result.available).toBe(true);
    expect(result.provider).toBe('elevenlabs');
    expect(global.fetch).not.toHaveBeenCalled();
    db.close();
  });

  it('local provider (kokoro) — launcher_down when /api/health unreachable', async () => {
    const db = makeDb({ provider: 'kokoro' });
    global.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const result = await TTSService.isAvailableAsync(db);
    expect(result).toEqual({ available: false, provider: 'kokoro', reason: 'launcher_down' });
    db.close();
  });

  it('local provider — model_not_serving when launcher reachable but model not in caps', async () => {
    const db = makeDb({ provider: 'kokoro' });
    global.fetch = vi.fn(async (url) => {
      if (url.endsWith('/api/health')) return { ok: true, json: async () => ({}) };
      if (url.endsWith('/api/status/capabilities')) {
        return { ok: true, json: async () => ({ conversation: { model: 'gemma-4-31B-it-nvfp4', base_url: 'http://localhost:8000' } }) };
      }
    });
    const result = await TTSService.isAvailableAsync(db);
    expect(result).toEqual({ available: false, provider: 'kokoro', reason: 'model_not_serving' });
    db.close();
  });

  it('local provider — available when launcher reachable AND model is serving', async () => {
    const db = makeDb({ provider: 'kokoro' });
    global.fetch = vi.fn(async (url) => {
      if (url.endsWith('/api/health')) return { ok: true, json: async () => ({}) };
      if (url.endsWith('/api/status/capabilities')) {
        return { ok: true, json: async () => ({ tts: [{ model: 'kokoro-v1', base_url: 'http://localhost:8880' }] }) };
      }
    });
    const result = await TTSService.isAvailableAsync(db);
    expect(result).toEqual({ available: true, provider: 'kokoro' });
    db.close();
  });

  it('local provider — handles old-shape capabilities (object per task) too', async () => {
    const db = makeDb({ provider: 'kokoro' });
    global.fetch = vi.fn(async (url) => {
      if (url.endsWith('/api/health')) return { ok: true, json: async () => ({}) };
      if (url.endsWith('/api/status/capabilities')) {
        return { ok: true, json: async () => ({ tts: { model: 'kokoro-v1', base_url: 'http://localhost:8880' } }) };
      }
    });
    const result = await TTSService.isAvailableAsync(db);
    expect(result.available).toBe(true);
    db.close();
  });

  it('local provider — optimistic when no matching family is seeded', async () => {
    // Family table is empty for kokoro — can't prove unavailable, return available.
    const db = makeDb({ provider: 'kokoro', kokoroFamily: false });
    global.fetch = vi.fn(async (url) => {
      if (url.endsWith('/api/health')) return { ok: true, json: async () => ({}) };
      if (url.endsWith('/api/status/capabilities')) return { ok: true, json: async () => ({}) };
    });
    const result = await TTSService.isAvailableAsync(db);
    expect(result.available).toBe(true);
    db.close();
  });
});
