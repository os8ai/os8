import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const Database = require('better-sqlite3');
const express = require('express');

// Build a minimal in-memory DB matching what /api/ai/local-status reads.
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
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
  const insert = db.prepare(`
    INSERT INTO ai_model_families (id, container_id, name, launcher_model, launcher_backend, supports_vision, eligible_tasks, display_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run('local-gemma-4-31b',     'local', 'Gemma',         'gemma-4-31B-it-nvfp4', 'vllm',    0, 'conversation,summary,planning', 0);
  insert.run('local-qwen3-coder-30b', 'local', 'Qwen Coder',    'qwen3-coder-30b',      'ollama',  0, 'coding,jobs',                   1);
  insert.run('local-qwen3-6-35b-a3b', 'local', 'Qwen Vision',   'qwen3-6-35b-a3b',      'vllm',    1, 'conversation',                  2);
  insert.run('local-flux1-schnell',   'local', 'Flux Schnell',  'flux1-schnell',        'comfyui', 0, 'image',                         3);
  insert.run('local-kokoro-v1',       'local', 'Kokoro',        'kokoro-v1',            'kokoro',  0, null,                            4);
  // A non-local family — should NOT appear in local-status.
  insert.run('claude-opus',           'claude', 'Opus',         null,                   null,      0, null,                            10);
  return db;
}

// Build the route under test by attaching a single endpoint to a mini app.
// This avoids pulling all the route's dependencies (BillingService, etc.)
// while exercising the same handler closure as the real router.
function makeApp(db) {
  // Stub the LauncherClient by re-requiring after stubbing globals — the
  // route's `require('../services/launcher-client')` runs at handler-time
  // (lazy require inside the handler), so module replacement works via
  // require cache mutation.
  delete require.cache[require.resolve('../../src/services/launcher-client')];
  delete require.cache[require.resolve('../../src/routes/ai-registry')];
  const RoutingService = require('../../src/services/routing');
  const createRouter = require('../../src/routes/ai-registry');

  const app = express();
  app.use(express.json());
  app.use('/api/ai', createRouter(db, RoutingService));
  return app;
}

async function get(app, path) {
  const res = await new Promise((resolve, reject) => {
    const req = { method: 'GET', url: path, headers: {}, query: {}, body: {}, params: {} };
    // Use supertest-lite via Node's http
    const http = require('http');
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      http.get({ host: '127.0.0.1', port, path }, response => {
        let data = '';
        response.on('data', c => data += c);
        response.on('end', () => {
          server.close();
          try { resolve({ status: response.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: response.statusCode, body: data }); }
        });
      }).on('error', err => { server.close(); reject(err); });
    });
  });
  return res;
}

describe('GET /api/ai/local-status (Phase 3 §0 acceptance #7)', () => {
  let db;
  let originalFetch;

  beforeEach(() => {
    db = makeDb();
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    db.close();
  });

  it('reports launcher unreachable when /api/health fails', async () => {
    global.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const app = makeApp(db);
    const { status, body } = await get(app, '/api/ai/local-status');
    expect(status).toBe(200);
    expect(body.ai_mode).toBe('proprietary');
    expect(body.launcher.reachable).toBe(false);
    expect(body.families).toHaveLength(5);  // only local families, not claude-opus
    // Every family is offline when launcher is unreachable.
    for (const f of body.families) {
      expect(f.serving).toBe(false);
      expect(f.served_tasks).toEqual([]);
    }
  });

  it('reports per-family serving status from launcher capabilities', async () => {
    global.fetch = vi.fn(async (url) => {
      if (url.endsWith('/api/health')) return { ok: true, json: async () => ({}) };
      if (url.endsWith('/api/status/capabilities')) {
        return {
          ok: true,
          json: async () => ({
            // Old shape: {taskType: {model, base_url}}
            conversation: { model: 'gemma-4-31B-it-nvfp4', base_url: 'http://localhost:8000' },
            summary:      { model: 'gemma-4-31B-it-nvfp4', base_url: 'http://localhost:8000' },
            // New (Phase 2) shape: {taskType: [array]}
            coding:       [{ model: 'qwen3-coder-30b', base_url: 'http://localhost:11434' }],
            jobs:         [{ model: 'qwen3-coder-30b', base_url: 'http://localhost:11434' }],
            tts:          [{ model: 'kokoro-v1', base_url: 'http://localhost:8880' }]
          })
        };
      }
    });

    const app = makeApp(db);
    const { status, body } = await get(app, '/api/ai/local-status');
    expect(status).toBe(200);
    expect(body.launcher.reachable).toBe(true);

    const byId = Object.fromEntries(body.families.map(f => [f.id, f]));
    expect(byId['local-gemma-4-31b'].serving).toBe(true);
    expect(byId['local-gemma-4-31b'].served_tasks.sort()).toEqual(['conversation', 'summary']);

    expect(byId['local-qwen3-coder-30b'].serving).toBe(true);
    expect(byId['local-qwen3-coder-30b'].served_tasks.sort()).toEqual(['coding', 'jobs']);

    expect(byId['local-kokoro-v1'].serving).toBe(true);
    expect(byId['local-kokoro-v1'].served_tasks).toEqual(['tts']);

    // qwen3-6-35b-a3b and flux1-schnell aren't being served in this scenario.
    expect(byId['local-qwen3-6-35b-a3b'].serving).toBe(false);
    expect(byId['local-flux1-schnell'].serving).toBe(false);
  });

  it('exposes supports_vision and eligible_tasks on every family', async () => {
    global.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const app = makeApp(db);
    const { body } = await get(app, '/api/ai/local-status');
    const byId = Object.fromEntries(body.families.map(f => [f.id, f]));
    expect(byId['local-qwen3-6-35b-a3b'].supports_vision).toBe(true);
    expect(byId['local-gemma-4-31b'].supports_vision).toBe(false);
    expect(byId['local-gemma-4-31b'].eligible_tasks).toBe('conversation,summary,planning');
    expect(byId['local-flux1-schnell'].eligible_tasks).toBe('image');
  });

  it('reflects the current ai_mode setting', async () => {
    global.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    db.prepare(`INSERT INTO settings (key, value) VALUES ('ai_mode', 'local')`).run();
    const app = makeApp(db);
    const { body } = await get(app, '/api/ai/local-status');
    expect(body.ai_mode).toBe('local');
  });

  it('excludes non-local families from the families list', async () => {
    global.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const app = makeApp(db);
    const { body } = await get(app, '/api/ai/local-status');
    expect(body.families.every(f => f.id.startsWith('local-'))).toBe(true);
    expect(body.families.find(f => f.id === 'claude-opus')).toBeUndefined();
  });
});
