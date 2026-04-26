import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const Database = require('better-sqlite3');
const express = require('express');
const http = require('http');

// HTTP-level contract tests for GET / PATCH /api/settings/context-limits.
// Spins up just the settings-api router with stubbed deps it doesn't need
// for these two endpoints, then exercises the routes over a real socket.

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);`);
  return db;
}

function makeApp(db) {
  // Fresh-require so the route reads the freshly-seeded settings table each
  // test. The route module also hard-requires SettingsService and
  // ContextLimits at top-level, so we drop their cached copies too.
  delete require.cache[require.resolve('../../src/routes/settings-api')];
  delete require.cache[require.resolve('../../src/services/context-limits')];
  delete require.cache[require.resolve('../../src/services/settings')];
  delete require.cache[require.resolve('../../src/services/ai-registry')];
  const createSettingsApiRouter = require('../../src/routes/settings-api');

  // The settings-api router takes a deps bag; the context-limits routes
  // don't use any of these directly, but the router constructor calls
  // AIRegistryService.getAllowedEnvKeys for the unrelated /env routes at
  // mount time. Stub it to an empty array; we never hit those paths here.
  const stubDeps = {
    SettingsService: require('../../src/services/settings'),
    EnvService: { get: () => null, set: () => {} },
    AgentService: { /* unused */ },
    AIRegistryService: {
      getAllowedEnvKeys: () => [],
      getContainer: () => null,
      getProvider: () => null
    },
    ensureTelegramWatchers: () => {},
    agentState: {},
    DEFAULT_CLAUDE_TIMEOUT_MS: 60000
  };

  const app = express();
  app.use(express.json());
  app.use('/api', createSettingsApiRouter(db, stubDeps));
  return app;
}

async function request(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const data = body !== undefined ? JSON.stringify(body) : null;
      const headers = data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {};
      const req = http.request({ host: '127.0.0.1', port, path, method, headers }, response => {
        let buf = '';
        response.on('data', c => buf += c);
        response.on('end', () => {
          server.close();
          try { resolve({ status: response.statusCode, body: JSON.parse(buf) }); }
          catch { resolve({ status: response.statusCode, body: buf }); }
        });
      });
      req.on('error', err => { server.close(); reject(err); });
      if (data) req.write(data);
      req.end();
    });
  });
}

// --- Tests ------------------------------------------------------------------

describe('GET /api/settings/context-limits', () => {
  let db;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  it('returns both stored values plus the cliOverhead map', async () => {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('context_limit_local_tokens', '50000')`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('context_limit_proprietary_tokens', '175000')`).run();
    const app = makeApp(db);
    const { status, body } = await request(app, 'GET', '/api/settings/context-limits');
    expect(status).toBe(200);
    expect(body.localTokens).toBe(50000);
    expect(body.proprietaryTokens).toBe(175000);
    expect(body.cliOverhead).toBeDefined();
    expect(body.cliOverhead.opencode).toBeGreaterThan(0);
  });

  it('returns fallback values when settings are missing', async () => {
    const app = makeApp(db);
    const { status, body } = await request(app, 'GET', '/api/settings/context-limits');
    expect(status).toBe(200);
    expect(body.localTokens).toBe(60000);
    expect(body.proprietaryTokens).toBe(200000);
    expect(body.cliOverhead).toEqual(expect.objectContaining({
      opencode: expect.any(Number),
      claude: expect.any(Number),
      gemini: expect.any(Number),
      codex: expect.any(Number),
      grok: expect.any(Number)
    }));
  });

  it('reflects user-customized cliOverhead values', async () => {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('cli_overhead_opencode_tokens', '12000')`).run();
    const app = makeApp(db);
    const { body } = await request(app, 'GET', '/api/settings/context-limits');
    expect(body.cliOverhead.opencode).toBe(12000);
  });
});

describe('PATCH /api/settings/context-limits', () => {
  let db;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  it('accepts a localTokens-only update', async () => {
    const app = makeApp(db);
    const { status, body } = await request(app, 'PATCH', '/api/settings/context-limits', { localTokens: 50000 });
    expect(status).toBe(200);
    expect(body.localTokens).toBe(50000);
    // Persisted
    const stored = db.prepare(`SELECT value FROM settings WHERE key = 'context_limit_local_tokens'`).get();
    expect(stored.value).toBe('50000');
  });

  it('accepts a proprietaryTokens-only update', async () => {
    const app = makeApp(db);
    const { status, body } = await request(app, 'PATCH', '/api/settings/context-limits', { proprietaryTokens: 150000 });
    expect(status).toBe(200);
    expect(body.proprietaryTokens).toBe(150000);
  });

  it('accepts both fields in one call', async () => {
    const app = makeApp(db);
    const { status, body } = await request(app, 'PATCH', '/api/settings/context-limits', {
      localTokens: 50000,
      proprietaryTokens: 150000
    });
    expect(status).toBe(200);
    expect(body.localTokens).toBe(50000);
    expect(body.proprietaryTokens).toBe(150000);
    expect(body.cliOverhead).toBeDefined();
  });

  it('accepts cliOverhead updates', async () => {
    const app = makeApp(db);
    const { status, body } = await request(app, 'PATCH', '/api/settings/context-limits', {
      cliOverhead: { opencode: 12000, claude: 18000 }
    });
    expect(status).toBe(200);
    expect(body.cliOverhead.opencode).toBe(12000);
    expect(body.cliOverhead.claude).toBe(18000);
    // Persisted under the canonical key shape.
    const stored = db.prepare(`SELECT value FROM settings WHERE key = 'cli_overhead_opencode_tokens'`).get();
    expect(stored.value).toBe('12000');
  });

  it('returns 400 for negative cliOverhead values', async () => {
    const app = makeApp(db);
    const { status, body } = await request(app, 'PATCH', '/api/settings/context-limits', {
      cliOverhead: { opencode: -100 }
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/between 0 and/);
  });

  it('returns 400 for unknown backendId in cliOverhead', async () => {
    const app = makeApp(db);
    const { status, body } = await request(app, 'PATCH', '/api/settings/context-limits', {
      cliOverhead: { mystery: 5000 }
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/Unknown backend/);
  });

  it('returns 400 with a descriptive message for below-minimum values', async () => {
    const app = makeApp(db);
    const { status, body } = await request(app, 'PATCH', '/api/settings/context-limits', { localTokens: 100 });
    expect(status).toBe(400);
    expect(body.error).toMatch(/between/);
  });

  it('returns 400 for above-maximum values', async () => {
    const app = makeApp(db);
    const { status, body } = await request(app, 'PATCH', '/api/settings/context-limits', { proprietaryTokens: 99999999 });
    expect(status).toBe(400);
    expect(body.error).toMatch(/between/);
  });

  it('returns 400 for non-integer input', async () => {
    const app = makeApp(db);
    const { status } = await request(app, 'PATCH', '/api/settings/context-limits', { localTokens: 'abc' });
    expect(status).toBe(400);
  });

  it('persists writes — subsequent GET reflects the new values', async () => {
    const app = makeApp(db);
    await request(app, 'PATCH', '/api/settings/context-limits', { localTokens: 50000, proprietaryTokens: 150000 });
    const { status, body } = await request(app, 'GET', '/api/settings/context-limits');
    expect(status).toBe(200);
    expect(body.localTokens).toBe(50000);
    expect(body.proprietaryTokens).toBe(150000);
    expect(body.cliOverhead).toBeDefined();
  });

  it('one invalid field rejects the whole call (no partial write)', async () => {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('context_limit_local_tokens', '60000')`).run();
    const app = makeApp(db);
    const { status } = await request(app, 'PATCH', '/api/settings/context-limits', {
      localTokens: 80000,            // valid
      proprietaryTokens: 100         // invalid
    });
    expect(status).toBe(400);
    // localTokens NOT updated — validation runs before persistence.
    const stored = db.prepare(`SELECT value FROM settings WHERE key = 'context_limit_local_tokens'`).get();
    expect(stored.value).toBe('60000');
  });
});
