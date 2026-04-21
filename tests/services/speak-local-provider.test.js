import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const Database = require('better-sqlite3');
const SpeakService = require('../../src/services/speak');

// Regression: SpeakService.generateAudio used to throw "API key not configured"
// for any provider whose getApiKey returned null — which is the correct return
// value for local providers (Kokoro, API_KEY_ENV=null). The fix treats null
// as "no auth needed" only when the provider declares no key requirement.

function makeDb({ provider } = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE env_variables (id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, value TEXT NOT NULL, encrypted INTEGER DEFAULT 0);
  `);
  if (provider) {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('tts_provider', ?)`).run(provider);
  }
  return db;
}

describe('SpeakService.generateAudio — null-API_KEY_ENV providers', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it('does NOT throw "API key not configured" for Kokoro (the regression)', async () => {
    const db = makeDb({ provider: 'kokoro' });
    // Stub fetch so generateAudio's launcher call returns a tiny audio blob.
    global.fetch = vi.fn(async (url) => {
      if (url.endsWith('/api/status/capabilities')) {
        return { ok: true, json: async () => ({ tts: [{ base_url: 'http://localhost:8880' }] }) };
      }
      if (url.endsWith('/v1/audio/speech')) {
        return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
      }
    });
    const result = await SpeakService.generateAudio(db, 'hello', { voiceId: 'af_bella', returnBase64: true });
    expect(result.success).toBe(true);
    expect(result.base64).toBe(Buffer.from([1, 2, 3]).toString('base64'));
    db.close();
  });

  it('still throws for cloud providers when API key is missing', async () => {
    const db = makeDb({ provider: 'openai' });
    await expect(SpeakService.generateAudio(db, 'hello', { voiceId: 'nova' }))
      .rejects.toThrow(/API key not configured/);
    db.close();
  });

  it('throws "No TTS provider configured" when none is selected', async () => {
    const db = makeDb({ provider: null });
    await expect(SpeakService.generateAudio(db, 'hello'))
      .rejects.toThrow(/No TTS provider configured/);
    db.close();
  });
});
