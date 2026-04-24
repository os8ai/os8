import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const Database = require('better-sqlite3');
const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs');

// --- Test harness ---

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);

    CREATE TABLE ai_containers (
      id TEXT PRIMARY KEY,
      provider_id TEXT,
      name TEXT,
      type TEXT,
      has_login INTEGER DEFAULT 0,
      login_command TEXT,
      display_order INTEGER DEFAULT 0
    );
    INSERT INTO ai_containers (id, provider_id, name, type, has_login, display_order) VALUES
      ('claude', 'anthropic', 'Claude', 'cli', 1, 0),
      ('local',  'local',     'Local',  'http', 0, 1);

    CREATE TABLE ai_providers (id TEXT PRIMARY KEY, name TEXT, api_key_env TEXT);
    INSERT INTO ai_providers VALUES ('anthropic', 'Anthropic', 'ANTHROPIC_API_KEY'), ('local', 'Local', NULL);

    CREATE TABLE ai_model_families (
      id TEXT PRIMARY KEY,
      container_id TEXT NOT NULL,
      display_name TEXT,
      name TEXT,
      launcher_model TEXT,
      launcher_backend TEXT,
      supports_vision INTEGER DEFAULT 0,
      eligible_tasks TEXT,
      cap_chat INTEGER DEFAULT 0,
      display_order INTEGER DEFAULT 0
    );
    INSERT INTO ai_model_families (id, container_id, display_name, name, eligible_tasks, cap_chat, display_order) VALUES
      ('claude-opus',          'claude', 'Claude Opus',     'Claude Opus',     'conversation', 4, 1),
      ('claude-sonnet',        'claude', 'Claude Sonnet',   'Claude Sonnet',   'conversation', 3, 2),
      ('local-qwen3-6-35b-a3b','local',  'Qwen 3.6 35B',    'Qwen',            'conversation', 4, 3);

    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      color TEXT,
      backend TEXT,
      model TEXT,
      owner_name TEXT,
      myself_preamble TEXT,
      display_order INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT,
      status TEXT DEFAULT 'active',
      setup_complete INTEGER DEFAULT 1
    );

    CREATE TABLE agent_models (
      agent_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      family_id TEXT,
      PRIMARY KEY (agent_id, mode)
    );
  `);
  return db;
}

function seedAgent(db, id, opts = {}) {
  db.prepare(`
    INSERT INTO agents (id, app_id, name, slug, color, backend, model)
    VALUES (?, 'app1', ?, ?, '#8b5cf6', 'claude', ?)
  `).run(id, opts.name || id, opts.slug || id, opts.model || null);
}

function setMode(db, mode) {
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_mode', ?)`).run(mode);
}

// Freeze a temp home so AgentService.getPaths doesn't touch ~/os8.
function withTempHome(fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-test-'));
  const origHome = process.env.OS8_HOME;
  process.env.OS8_HOME = tempDir;
  try {
    return fn(tempDir);
  } finally {
    if (origHome) process.env.OS8_HOME = origHome;
    else delete process.env.OS8_HOME;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// Force module re-require so AgentService reads process.env.OS8_HOME freshly.
function freshAgentService() {
  delete require.cache[require.resolve('../../src/services/agent')];
  delete require.cache[require.resolve('../../src/services/routing')];
  delete require.cache[require.resolve('../../src/config')];
  return require('../../src/services/agent');
}

// --- Tests ---

describe('AgentService.getAgentModel / saveAgentModel (Phase B per-mode)', () => {
  let db;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  it('saveAgentModel upserts one row per (agent, mode)', () => {
    seedAgent(db, 'a1');
    const AgentService = freshAgentService();

    AgentService.saveAgentModel(db, 'a1', 'proprietary', 'claude-opus');
    AgentService.saveAgentModel(db, 'a1', 'local',       'local-qwen3-6-35b-a3b');

    const rows = db.prepare('SELECT mode, family_id FROM agent_models WHERE agent_id = ? ORDER BY mode').all('a1');
    expect(rows).toEqual([
      { mode: 'local',       family_id: 'local-qwen3-6-35b-a3b' },
      { mode: 'proprietary', family_id: 'claude-opus' }
    ]);
  });

  it('saveAgentModel with null or "auto" clears the row', () => {
    seedAgent(db, 'a1');
    const AgentService = freshAgentService();

    AgentService.saveAgentModel(db, 'a1', 'proprietary', 'claude-opus');
    AgentService.saveAgentModel(db, 'a1', 'proprietary', null);
    expect(db.prepare('SELECT 1 FROM agent_models WHERE agent_id = ? AND mode = ?').get('a1', 'proprietary')).toBeUndefined();

    AgentService.saveAgentModel(db, 'a1', 'local', 'local-qwen3-6-35b-a3b');
    AgentService.saveAgentModel(db, 'a1', 'local', 'auto');
    expect(db.prepare('SELECT 1 FROM agent_models WHERE agent_id = ? AND mode = ?').get('a1', 'local')).toBeUndefined();
  });

  it('getAgentModel defaults to current ai_mode when mode arg omitted', () => {
    seedAgent(db, 'a1');
    const AgentService = freshAgentService();
    AgentService.saveAgentModel(db, 'a1', 'proprietary', 'claude-opus');
    AgentService.saveAgentModel(db, 'a1', 'local',       'local-qwen3-6-35b-a3b');

    setMode(db, 'proprietary');
    expect(AgentService.getAgentModel(db, 'a1')).toBe('claude-opus');

    setMode(db, 'local');
    expect(AgentService.getAgentModel(db, 'a1')).toBe('local-qwen3-6-35b-a3b');
  });

  it('getAgentModel returns null when no pin for the requested mode', () => {
    seedAgent(db, 'a1');
    const AgentService = freshAgentService();
    AgentService.saveAgentModel(db, 'a1', 'proprietary', 'claude-opus');

    expect(AgentService.getAgentModel(db, 'a1', 'local')).toBeNull();
  });
});

describe('AgentService.getConfig / updateConfig — mode-aware agentModel', () => {
  it('updateConfig with agentModel writes to agent_models under current ai_mode', () => {
    withTempHome(() => {
      const db = makeDb();
      seedAgent(db, 'a1');
      const AgentService = freshAgentService();

      setMode(db, 'proprietary');
      AgentService.updateConfig(db, 'a1', { agentModel: 'claude-opus' });

      setMode(db, 'local');
      AgentService.updateConfig(db, 'a1', { agentModel: 'local-qwen3-6-35b-a3b' });

      // Both rows present, not clobbering each other.
      const rows = db.prepare('SELECT mode, family_id FROM agent_models WHERE agent_id = ? ORDER BY mode').all('a1');
      expect(rows).toEqual([
        { mode: 'local',       family_id: 'local-qwen3-6-35b-a3b' },
        { mode: 'proprietary', family_id: 'claude-opus' }
      ]);

      // Legacy agents.model column untouched by the new write path.
      const row = db.prepare('SELECT model FROM agents WHERE id = ?').get('a1');
      expect(row.model).toBeNull();

      db.close();
    });
  });

  it('getConfig.agentModel returns the pin for the current ai_mode', () => {
    withTempHome(() => {
      const db = makeDb();
      seedAgent(db, 'a1');
      const AgentService = freshAgentService();
      AgentService.saveAgentModel(db, 'a1', 'proprietary', 'claude-opus');
      AgentService.saveAgentModel(db, 'a1', 'local',       'local-qwen3-6-35b-a3b');

      setMode(db, 'proprietary');
      expect(AgentService.getConfig(db, 'a1').agentModel).toBe('claude-opus');

      setMode(db, 'local');
      expect(AgentService.getConfig(db, 'a1').agentModel).toBe('local-qwen3-6-35b-a3b');
    });
  });

  it('getConfig.agentModel is undefined under local mode when only a cloud pin exists (the cross-mode guard)', () => {
    withTempHome(() => {
      const db = makeDb();
      seedAgent(db, 'a1');
      const AgentService = freshAgentService();
      AgentService.saveAgentModel(db, 'a1', 'proprietary', 'claude-opus');

      setMode(db, 'local');
      // No local pin → undefined → callers fall through to the local cascade.
      // This is the whole point: a cloud override can't leak into local mode.
      expect(AgentService.getConfig(db, 'a1').agentModel).toBeUndefined();
    });
  });

  it('agentModel=null via updateConfig clears only the current mode bucket, preserving the other', () => {
    withTempHome(() => {
      const db = makeDb();
      seedAgent(db, 'a1');
      const AgentService = freshAgentService();
      AgentService.saveAgentModel(db, 'a1', 'proprietary', 'claude-opus');
      AgentService.saveAgentModel(db, 'a1', 'local',       'local-qwen3-6-35b-a3b');

      setMode(db, 'local');
      AgentService.updateConfig(db, 'a1', { agentModel: null });

      // Proprietary pin survives; local bucket cleared.
      expect(AgentService.getAgentModel(db, 'a1', 'local')).toBeNull();
      expect(AgentService.getAgentModel(db, 'a1', 'proprietary')).toBe('claude-opus');
    });
  });
});

describe('Migration 0.3.16 — backfill agents.model into agent_models', () => {
  it('places each agent in the mode bucket matching its family container', () => {
    const db = makeDb();
    // Phase B migration expects the table to already be creatable; emulate
    // a pre-migration DB by dropping agent_models first.
    db.exec('DROP TABLE agent_models');

    seedAgent(db, 'cloud_agent', { model: 'claude-opus' });
    seedAgent(db, 'local_agent', { model: 'local-qwen3-6-35b-a3b' });
    seedAgent(db, 'auto_agent',  { model: null });
    // Orphan — points at a family that no longer exists.
    seedAgent(db, 'orphan_agent', { model: 'ghost-family' });

    const migration = require('../../src/migrations/0.3.16-agent-models-per-mode');
    const logger = { log: () => {} };
    return migration.up({ db, logger }).then(() => {
      const rows = db.prepare('SELECT agent_id, mode, family_id FROM agent_models ORDER BY agent_id').all();
      expect(rows).toEqual([
        { agent_id: 'cloud_agent', mode: 'proprietary', family_id: 'claude-opus' },
        { agent_id: 'local_agent', mode: 'local',       family_id: 'local-qwen3-6-35b-a3b' }
      ]);

      // Legacy column nulled after backfill for every agent.
      const models = db.prepare('SELECT id, model FROM agents ORDER BY id').all();
      for (const r of models) {
        expect(r.model).toBeNull();
      }

      db.close();
    });
  });

  it('is idempotent — running twice produces the same state', async () => {
    const db = makeDb();
    db.exec('DROP TABLE agent_models');
    seedAgent(db, 'a1', { model: 'claude-opus' });

    const migration = require('../../src/migrations/0.3.16-agent-models-per-mode');
    const logger = { log: () => {} };
    await migration.up({ db, logger });
    await migration.up({ db, logger });

    const count = db.prepare('SELECT COUNT(*) AS c FROM agent_models').get().c;
    expect(count).toBe(1);
    db.close();
  });
});

describe('GET /api/ai/models/options — filter by current ai_mode', () => {
  function attach(db) {
    delete require.cache[require.resolve('../../src/services/routing')];
    delete require.cache[require.resolve('../../src/services/ai-registry')];
    delete require.cache[require.resolve('../../src/routes/ai-registry')];
    const createRouter = require('../../src/routes/ai-registry');
    const app = express();
    app.use(express.json());
    app.use('/api/ai', createRouter(db));
    return app;
  }

  async function get(app, p) {
    return new Promise((resolve, reject) => {
      const http = require('http');
      const server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        http.get({ host: '127.0.0.1', port, path: p }, response => {
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
  }

  it('proprietary mode excludes local families', async () => {
    const db = makeDb();
    setMode(db, 'proprietary');
    const app = attach(db);
    const { body } = await get(app, '/api/ai/models/options');
    const ids = body.map(o => o.value);
    expect(ids).toContain('claude-opus');
    expect(ids).toContain('claude-sonnet');
    expect(ids).not.toContain('local-qwen3-6-35b-a3b');
    db.close();
  });

  it('local mode returns only local families', async () => {
    const db = makeDb();
    setMode(db, 'local');
    const app = attach(db);
    const { body } = await get(app, '/api/ai/models/options');
    const ids = body.map(o => o.value);
    expect(ids).toEqual(['local-qwen3-6-35b-a3b']);
    db.close();
  });
});
