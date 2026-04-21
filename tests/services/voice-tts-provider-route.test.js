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
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
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

  it('accepts kokoro', async () => {
    const app = makeApp(db);
    const { status, body } = await postJson(app, '/api/voice/tts-provider', { provider: 'kokoro' });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    // Stored as the active provider.
    const stored = db.prepare(`SELECT value FROM settings WHERE key = 'tts_provider'`).get();
    expect(stored.value).toBe('kokoro');
  });

  it('accepts elevenlabs (regression)', async () => {
    const app = makeApp(db);
    const { status, body } = await postJson(app, '/api/voice/tts-provider', { provider: 'elevenlabs' });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it('accepts openai (regression)', async () => {
    const app = makeApp(db);
    const { status, body } = await postJson(app, '/api/voice/tts-provider', { provider: 'openai' });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
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
