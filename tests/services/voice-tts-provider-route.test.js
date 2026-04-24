import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const Database = require('better-sqlite3');
const express = require('express');
const http = require('http');

// Spin up the voice router with an in-memory DB and exercise the
// /tts-provider route. Verifies dynamic whitelist (Object.keys(PROVIDERS))
// accepts kokoro and rejects bogus.

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE env_variables (
      id TEXT PRIMARY KEY,
      key TEXT UNIQUE NOT NULL,
      value TEXT NOT NULL,
      encrypted INTEGER DEFAULT 0
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      voice_id TEXT,
      voice_name TEXT,
      gender TEXT
    );
    CREATE TABLE agent_voices (
      agent_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      voice_id TEXT,
      voice_name TEXT,
      PRIMARY KEY (agent_id, provider)
    );
  `);
  return db;
}

function makeApp(db) {
  const createVoiceRouter = require('../../src/routes/voice');
  // The voice router takes a {EnvService, SettingsService} bag for paths we
  // don't exercise here. Stub with no-ops; the /tts-provider handler doesn't
  // touch them.
  const stubServices = {
    EnvService: { get: () => null, set: () => {} },
    SettingsService: { getVoiceSettings: () => ({}), setVoiceSettings: () => {} }
  };
  const app = express();
  app.use(express.json());
  app.use('/api/voice', createVoiceRouter(db, stubServices));
  return app;
}

async function getJson(app, path) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const req = http.request({
        host: '127.0.0.1', port, path, method: 'GET'
      }, response => {
        let buf = '';
        response.on('data', c => buf += c);
        response.on('end', () => {
          server.close();
          try { resolve({ status: response.statusCode, body: JSON.parse(buf) }); }
          catch { resolve({ status: response.statusCode, body: buf }); }
        });
      });
      req.on('error', err => { server.close(); reject(err); });
      req.end();
    });
  });
}

async function postJson(app, path, body) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const data = JSON.stringify(body);
      const req = http.request({
        host: '127.0.0.1', port, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
      }, response => {
        let buf = '';
        response.on('data', c => buf += c);
        response.on('end', () => {
          server.close();
          try { resolve({ status: response.statusCode, body: JSON.parse(buf) }); }
          catch { resolve({ status: response.statusCode, body: buf }); }
        });
      });
      req.on('error', err => { server.close(); reject(err); });
      req.write(data);
      req.end();
    });
  });
}

describe('POST /api/voice/tts-provider — dynamic whitelist (Phase 3-5 follow-up)', () => {
  let db;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  it('accepts kokoro and stores it in the local slot', async () => {
    const app = makeApp(db);
    const { status, body } = await postJson(app, '/api/voice/tts-provider', { provider: 'kokoro' });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    // Kokoro is IS_LOCAL=true → goes to the local mode's slot.
    const stored = db.prepare(`SELECT value FROM settings WHERE key = 'tts_provider_local'`).get();
    expect(stored?.value).toBe('kokoro');
  });

  it('accepts elevenlabs and stores it in the proprietary slot', async () => {
    const app = makeApp(db);
    const { status, body } = await postJson(app, '/api/voice/tts-provider', { provider: 'elevenlabs' });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const stored = db.prepare(`SELECT value FROM settings WHERE key = 'tts_provider_proprietary'`).get();
    expect(stored?.value).toBe('elevenlabs');
  });

  it('accepts openai and stores it in the proprietary slot', async () => {
    const app = makeApp(db);
    const { status, body } = await postJson(app, '/api/voice/tts-provider', { provider: 'openai' });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const stored = db.prepare(`SELECT value FROM settings WHERE key = 'tts_provider_proprietary'`).get();
    expect(stored?.value).toBe('openai');
  });

  it('accepts empty string (deselect)', async () => {
    const app = makeApp(db);
    const { status, body } = await postJson(app, '/api/voice/tts-provider', { provider: '' });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it('rejects bogus provider with 400 and a message naming valid options', async () => {
    const app = makeApp(db);
    const { status, body } = await postJson(app, '/api/voice/tts-provider', { provider: 'bogus' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/Invalid provider/);
    expect(body.error).toMatch(/kokoro/);
    expect(body.error).toMatch(/elevenlabs/);
    expect(body.error).toMatch(/openai/);
  });
});

describe('GET /api/voice/tts-providers — mode-filtered list', () => {
  let db;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  it('returns only cloud providers in proprietary mode (default) — no None entry', async () => {
    const app = makeApp(db);
    const { status, body } = await getJson(app, '/api/voice/tts-providers');
    expect(status).toBe(200);
    expect(body.mode).toBe('proprietary');
    const ids = body.providers.map(p => p.value);
    expect(ids).not.toContain('');       // None is no longer a pickable option
    expect(ids).toContain('elevenlabs');
    expect(ids).toContain('openai');
    expect(ids).not.toContain('kokoro');
  });

  it('returns only local providers in local mode — no None entry', async () => {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('ai_mode', 'local')`).run();
    const app = makeApp(db);
    const { status, body } = await getJson(app, '/api/voice/tts-providers');
    expect(status).toBe(200);
    expect(body.mode).toBe('local');
    const ids = body.providers.map(p => p.value);
    expect(ids).not.toContain('');
    expect(ids).toContain('kokoro');
    expect(ids).not.toContain('elevenlabs');
    expect(ids).not.toContain('openai');
  });

  it('reports the current provider for the active mode (pinned)', async () => {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('tts_provider_proprietary', 'openai')`).run();
    const app = makeApp(db);
    const { body } = await getJson(app, '/api/voice/tts-providers');
    expect(body.current).toBe('openai');
    expect(body.source).toBe('pinned');
  });

  it('auto-picks and persists a cloud provider when the slot is empty but a key is configured', async () => {
    // Empty proprietary slot + ElevenLabs key present → resolver picks + persists.
    db.prepare(`INSERT INTO env_variables (id, key, value) VALUES ('1', 'ELEVENLABS_API_KEY', 'sk_xxx')`).run();
    const app = makeApp(db);
    const { body } = await getJson(app, '/api/voice/tts-providers');
    expect(body.current).toBe('elevenlabs');
    expect(body.source).toBe('auto');
    // And stickiness — the slot is now filled.
    const stored = db.prepare(`SELECT value FROM settings WHERE key = 'tts_provider_proprietary'`).get();
    expect(stored?.value).toBe('elevenlabs');
  });

  it('prefers elevenlabs over openai when both are configured', async () => {
    db.prepare(`INSERT INTO env_variables (id, key, value) VALUES ('1', 'ELEVENLABS_API_KEY', 'sk_e')`).run();
    db.prepare(`INSERT INTO env_variables (id, key, value) VALUES ('2', 'OPENAI_API_KEY', 'sk_o')`).run();
    const app = makeApp(db);
    const { body } = await getJson(app, '/api/voice/tts-providers');
    expect(body.current).toBe('elevenlabs');
  });

  it('falls back to openai when only openai has a key', async () => {
    db.prepare(`INSERT INTO env_variables (id, key, value) VALUES ('1', 'OPENAI_API_KEY', 'sk_o')`).run();
    const app = makeApp(db);
    const { body } = await getJson(app, '/api/voice/tts-providers');
    expect(body.current).toBe('openai');
    expect(body.source).toBe('auto');
  });

  it('returns source=none when no cloud provider is configured in proprietary mode', async () => {
    const app = makeApp(db);
    const { body } = await getJson(app, '/api/voice/tts-providers');
    expect(body.current).toBe('');
    expect(body.source).toBe('none');
  });

  it('auto-picks kokoro in local mode (local providers are always configured)', async () => {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('ai_mode', 'local')`).run();
    const app = makeApp(db);
    const { body } = await getJson(app, '/api/voice/tts-providers');
    expect(body.current).toBe('kokoro');
    expect(body.source).toBe('auto');
  });

  it('keeps each mode\'s pick independent — flipping mode does not clobber the other slot', async () => {
    // Seed a proprietary pick, then flip to local and set a local pick.
    db.prepare(`INSERT INTO settings (key, value) VALUES ('tts_provider_proprietary', 'elevenlabs')`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('ai_mode', 'local')`).run();
    const app = makeApp(db);
    await postJson(app, '/api/voice/tts-provider', { provider: 'kokoro' });
    // Both slots retain their values.
    const prop = db.prepare(`SELECT value FROM settings WHERE key = 'tts_provider_proprietary'`).get();
    const loc = db.prepare(`SELECT value FROM settings WHERE key = 'tts_provider_local'`).get();
    expect(prop?.value).toBe('elevenlabs');
    expect(loc?.value).toBe('kokoro');
  });
});
