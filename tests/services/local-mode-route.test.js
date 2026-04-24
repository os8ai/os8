import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const Database = require('better-sqlite3');
const express = require('express');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE ai_model_families (
      id TEXT PRIMARY KEY,
      container_id TEXT NOT NULL,
      name TEXT NOT NULL,
      launcher_model TEXT,
      launcher_backend TEXT,
      supports_vision INTEGER DEFAULT 0,
      eligible_tasks TEXT,
      display_order INTEGER DEFAULT 0
    );
  `);
  return db;
}

function makeApp(db) {
  delete require.cache[require.resolve('../../src/services/launcher-client')];
  delete require.cache[require.resolve('../../src/routes/ai-registry')];
  const createRouter = require('../../src/routes/ai-registry');

  const app = express();
  app.use(express.json());
  app.use('/api/ai', createRouter(db));
  return app;
}

async function request(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const data = body ? JSON.stringify(body) : null;
      const req = http.request({
        host: '127.0.0.1', port, path, method,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
      }, response => {
        let out = '';
        response.on('data', c => out += c);
        response.on('end', () => {
          server.close();
          try { resolve({ status: response.statusCode, body: JSON.parse(out) }); }
          catch { resolve({ status: response.statusCode, body: out }); }
        });
      });
      req.on('error', err => { server.close(); reject(err); });
      if (data) req.write(data);
      req.end();
    });
  });
}

describe('POST /api/ai/local-mode/start (Phase B)', () => {
  let db;
  let originalFetch;
  let ensureCalls;

  beforeEach(() => {
    db = makeDb();
    originalFetch = global.fetch;
    ensureCalls = [];
  });
  afterEach(() => {
    global.fetch = originalFetch;
    db.close();
  });

  it('calls ensureModel for all three triplet slots and sets ai_mode=local', async () => {
    global.fetch = vi.fn(async (url, opts) => {
      if (url.endsWith('/api/serve/ensure')) {
        ensureCalls.push(JSON.parse(opts.body));
        return { ok: true, json: async () => ({ status: 'loading' }) };
      }
      return { ok: true, json: async () => ({}) };
    });

    const app = makeApp(db);
    const { status, body } = await request(app, 'POST', '/api/ai/local-mode/start');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.mode).toBe('local');
    expect(body.slots).toHaveLength(3);
    expect(body.slots.map(s => s.slot)).toEqual(['chat', 'image', 'voice']);

    // Three ensure posts, one per slot, carrying the triplet models.
    expect(ensureCalls).toHaveLength(3);
    const models = ensureCalls.map(c => c.model).sort();
    expect(models).toEqual(['flux1-kontext-dev', 'kokoro-v1', 'qwen3-6-35b-a3b']);
    // wait=false so we don't block the HTTP request.
    for (const c of ensureCalls) expect(c.wait).toBe(false);

    // ai_mode persisted.
    const row = db.prepare("SELECT value FROM settings WHERE key = 'ai_mode'").get();
    expect(row.value).toBe('local');
  });

  it('propagates per-slot launcher errors without failing the whole call', async () => {
    global.fetch = vi.fn(async (url, opts) => {
      if (url.endsWith('/api/serve/ensure')) {
        const { model } = JSON.parse(opts.body);
        if (model === 'flux1-kontext-dev') {
          return {
            ok: false,
            status: 409,
            statusText: 'Conflict',
            json: async () => ({ detail: { code: 'BUDGET_EXCEEDED', message: 'VRAM full' } })
          };
        }
        return { ok: true, json: async () => ({ status: 'ready' }) };
      }
      return { ok: true, json: async () => ({}) };
    });

    const app = makeApp(db);
    const { status, body } = await request(app, 'POST', '/api/ai/local-mode/start');
    expect(status).toBe(200);
    const bySlot = Object.fromEntries(body.slots.map(s => [s.slot, s]));
    expect(bySlot.image.status).toBe('error');
    expect(bySlot.image.error.code).toBe('BUDGET_EXCEEDED');
    expect(bySlot.chat.status).toBe('ready');
    expect(bySlot.voice.status).toBe('ready');

    // Mode flip still happens — partial-failure UX is handled by the UI
    // reading /local-status. (A more conservative design would refuse to flip
    // on any error, but that prevents recovery when one slot is flaky.)
    const row = db.prepare("SELECT value FROM settings WHERE key = 'ai_mode'").get();
    expect(row.value).toBe('local');
  });

  it('surfaces launcher-unreachable as a structured per-slot error', async () => {
    global.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const app = makeApp(db);
    const { status, body } = await request(app, 'POST', '/api/ai/local-mode/start');
    expect(status).toBe(200);
    for (const s of body.slots) {
      expect(s.status).toBe('error');
      expect(s.error.code).toBe('LAUNCHER_UNREACHABLE');
    }
  });
});

describe('POST /api/ai/local-mode/stop (Phase B)', () => {
  let db;
  let originalFetch;

  beforeEach(() => {
    db = makeDb();
    db.prepare("INSERT INTO settings (key, value) VALUES ('ai_mode', 'local')").run();
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    db.close();
  });

  it('sets ai_mode=proprietary and does not call the launcher', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    global.fetch = fetchSpy;

    const app = makeApp(db);
    const { status, body } = await request(app, 'POST', '/api/ai/local-mode/stop');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.mode).toBe('proprietary');

    const row = db.prepare("SELECT value FROM settings WHERE key = 'ai_mode'").get();
    expect(row.value).toBe('proprietary');

    // Stop MUST NOT invoke the launcher — per v2 plan, other tools may be
    // using it and we don't stop their residents.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
