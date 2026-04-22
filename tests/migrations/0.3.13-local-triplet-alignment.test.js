import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const Database = require('better-sqlite3');
const MIGRATION = require('../../src/migrations/0.3.13-local-triplet-alignment');

// Simulate a post-0.3.12 DB: 7 local families seeded, Phase-3-2 cascade
// populated. The migration should:
//   - add local-flux1-kontext-dev
//   - widen qwen3-6-35b-a3b's eligible_tasks + bump caps
//   - zero caps on retired local families
//   - regenerate the local cascade
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE ai_providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, api_key_env TEXT);
    CREATE TABLE ai_containers (
      id TEXT PRIMARY KEY, provider_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'cli', name TEXT NOT NULL DEFAULT '',
      has_login INTEGER DEFAULT 0, display_order INTEGER DEFAULT 0
    );
    CREATE TABLE ai_model_families (
      id TEXT PRIMARY KEY,
      container_id TEXT NOT NULL,
      name TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      cli_model_arg TEXT,
      cost_tier INTEGER DEFAULT 3,
      cap_chat INTEGER DEFAULT 3,
      cap_jobs INTEGER DEFAULT 3,
      cap_planning INTEGER DEFAULT 3,
      cap_coding INTEGER DEFAULT 3,
      cap_summary INTEGER DEFAULT 3,
      cap_image INTEGER DEFAULT 0,
      eligible_tasks TEXT,
      display_order INTEGER DEFAULT 0,
      launcher_model TEXT,
      launcher_backend TEXT,
      supports_vision INTEGER DEFAULT 0
    );
    CREATE TABLE ai_models (id TEXT PRIMARY KEY, family_id TEXT, api_model_id TEXT, is_latest INTEGER DEFAULT 0);
    CREATE TABLE ai_account_status (provider_id TEXT PRIMARY KEY, login_exhausted_until TEXT, api_exhausted_until TEXT);
    CREATE TABLE env_variables (id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, value TEXT NOT NULL);
    CREATE TABLE routing_cascade (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_type TEXT NOT NULL,
      priority INTEGER NOT NULL,
      family_id TEXT NOT NULL REFERENCES ai_model_families(id),
      access_method TEXT NOT NULL DEFAULT 'api',
      enabled INTEGER DEFAULT 1,
      is_auto_generated INTEGER DEFAULT 1,
      mode TEXT NOT NULL DEFAULT 'proprietary',
      UNIQUE(task_type, mode, priority)
    );
  `);

  db.prepare(`INSERT INTO ai_providers (id, name) VALUES ('local', 'Local')`).run();
  db.prepare(`INSERT INTO ai_providers (id, name, api_key_env) VALUES ('anthropic', 'Anthropic', 'ANTHROPIC_API_KEY')`).run();
  db.prepare(`INSERT INTO ai_containers (id, provider_id, type, name, has_login) VALUES ('local', 'local', 'http', 'Local', 0)`).run();
  db.prepare(`INSERT INTO ai_containers (id, provider_id, type, name, has_login) VALUES ('claude', 'anthropic', 'cli', 'Claude', 1)`).run();

  const insertFamily = db.prepare(`
    INSERT INTO ai_model_families (id, container_id, name, cli_model_arg, cost_tier,
      cap_chat, cap_jobs, cap_planning, cap_coding, cap_summary, cap_image,
      eligible_tasks, display_order, launcher_model, launcher_backend, supports_vision)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // Cloud family used so non-empty proprietary cascade is plausible
  insertFamily.run('claude-sonnet', 'claude', 'Sonnet', 'sonnet', 3, 4, 4, 3, 4, 4, 0, null, 0, null, null, 0);
  // Retired local families — should get caps zeroed
  insertFamily.run('local-gemma-4-31b',      'local', 'Gemma',            'gemma-4-31B-it-nvfp4', 1, 3, 2, 3, 2, 3, 0, 'conversation,summary,planning', 0, 'gemma-4-31B-it-nvfp4', 'vllm',   0);
  insertFamily.run('local-gemma-4-e2b',      'local', 'Gemma E2B',        'gemma-4-E2B-it',       1, 2, 1, 1, 1, 3, 0, 'conversation,summary',          1, 'gemma-4-E2B-it',       'vllm',   0);
  insertFamily.run('local-qwen3-coder-30b',  'local', 'Qwen3 Coder 30B',  'qwen3-coder-30b',      1, 2, 4, 3, 4, 2, 0, 'coding,jobs',                   2, 'qwen3-coder-30b',      'ollama', 0);
  insertFamily.run('local-qwen3-coder-next', 'local', 'Qwen3 Coder Next', 'qwen3-coder-next',     1, 2, 5, 4, 5, 2, 0, 'coding,jobs',                   3, 'qwen3-coder-next',     'vllm',   0);
  insertFamily.run('local-flux1-schnell',    'local', 'Flux Schnell',     'flux1-schnell',        1, 0, 0, 0, 0, 0, 4, 'image',                         4, 'flux1-schnell',        'comfyui', 0);
  // Survivors
  insertFamily.run('local-qwen3-6-35b-a3b',  'local', 'Qwen3.6',          'qwen3-6-35b-a3b',      1, 3, 3, 3, 2, 3, 0, 'conversation',                  5, 'qwen3-6-35b-a3b',      'vllm',   1);
  insertFamily.run('local-kokoro-v1',        'local', 'Kokoro',           'kokoro-v1',            1, 0, 0, 0, 0, 0, 0, null,                            6, 'kokoro-v1',            'kokoro', 0);

  // Seed a plausible local cascade that the migration should regenerate.
  db.prepare(`INSERT INTO routing_cascade (task_type, priority, family_id, access_method, mode, is_auto_generated) VALUES ('conversation', 0, 'local-gemma-4-31b', 'api', 'local', 1)`).run();
  db.prepare(`INSERT INTO routing_cascade (task_type, priority, family_id, access_method, mode, is_auto_generated) VALUES ('coding', 0, 'local-qwen3-coder-30b', 'api', 'local', 1)`).run();
  db.prepare(`INSERT INTO routing_cascade (task_type, priority, family_id, access_method, mode, is_auto_generated) VALUES ('image', 0, 'local-flux1-schnell', 'api', 'local', 1)`).run();
  // A proprietary cascade row we should NOT touch
  db.prepare(`INSERT INTO routing_cascade (task_type, priority, family_id, access_method, mode, is_auto_generated) VALUES ('conversation', 0, 'claude-sonnet', 'api', 'proprietary', 1)`).run();
  // A manual (is_auto_generated=0) local row that should be preserved
  db.prepare(`INSERT INTO routing_cascade (task_type, priority, family_id, access_method, mode, is_auto_generated) VALUES ('summary', 99, 'local-qwen3-6-35b-a3b', 'api', 'local', 0)`).run();

  db.prepare(`INSERT INTO ai_account_status (provider_id) VALUES ('local')`).run();
  db.prepare(`INSERT INTO ai_account_status (provider_id) VALUES ('anthropic')`).run();
  db.prepare(`INSERT INTO settings (key, value) VALUES ('routing_preference', 'balanced')`).run();
  db.prepare(`INSERT INTO settings (key, value) VALUES ('model_api_constraints', ?)`).run(JSON.stringify({
    local: { conversation: 'api', jobs: 'api', planning: 'api', coding: 'api', summary: 'api', image: 'api' },
    anthropic: { conversation: 'both', jobs: 'api', planning: 'both', coding: 'both', summary: 'api', image: 'api' }
  }));

  return db;
}

const silentLogger = () => ({ log: () => {}, warn: () => {}, error: () => {} });

describe('migration 0.3.13 — local triplet alignment', () => {
  let db;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  it('adds the local-flux1-kontext-dev family row', async () => {
    expect(db.prepare(`SELECT id FROM ai_model_families WHERE id = 'local-flux1-kontext-dev'`).get()).toBeUndefined();
    await MIGRATION.up({ db, logger: silentLogger() });
    const row = db.prepare(`SELECT * FROM ai_model_families WHERE id = 'local-flux1-kontext-dev'`).get();
    expect(row).toBeDefined();
    expect(row.launcher_model).toBe('flux1-kontext-dev');
    expect(row.launcher_backend).toBe('comfyui');
    expect(row.cap_image).toBe(4);
    expect(row.eligible_tasks).toBe('image');
  });

  it('widens qwen3-6-35b-a3b eligible_tasks to cover all text tasks', async () => {
    await MIGRATION.up({ db, logger: silentLogger() });
    const row = db.prepare(`SELECT * FROM ai_model_families WHERE id = 'local-qwen3-6-35b-a3b'`).get();
    expect(row.eligible_tasks).toBe('conversation,summary,planning,coding,jobs');
    expect(row.cap_chat).toBe(4);
    expect(row.cap_jobs).toBe(3);
    expect(row.cap_coding).toBe(3);
    expect(row.cap_summary).toBe(3);
    expect(row.cap_planning).toBe(3);
    expect(row.supports_vision).toBe(1);  // unchanged — still vision-capable
  });

  it('zeros caps on retired local families', async () => {
    await MIGRATION.up({ db, logger: silentLogger() });
    const retired = ['local-gemma-4-31b', 'local-gemma-4-e2b', 'local-qwen3-coder-30b', 'local-qwen3-coder-next', 'local-flux1-schnell'];
    for (const id of retired) {
      const row = db.prepare(`SELECT * FROM ai_model_families WHERE id = ?`).get(id);
      expect(row).toBeDefined();  // still exists (rollback safety)
      expect(row.cap_chat).toBe(0);
      expect(row.cap_jobs).toBe(0);
      expect(row.cap_planning).toBe(0);
      expect(row.cap_coding).toBe(0);
      expect(row.cap_summary).toBe(0);
      expect(row.cap_image).toBe(0);
      expect(row.eligible_tasks).toBe('');
    }
  });

  it('regenerates local cascade — qwen3.6 wins text tasks, kontext wins image', async () => {
    await MIGRATION.up({ db, logger: silentLogger() });
    // Conversation under mode=local should now be qwen3.6 at priority 0.
    const conv = db.prepare(`SELECT family_id FROM routing_cascade WHERE task_type = 'conversation' AND mode = 'local' AND is_auto_generated = 1 ORDER BY priority LIMIT 1`).get();
    expect(conv.family_id).toBe('local-qwen3-6-35b-a3b');
    // Coding — qwen3.6 wins now (qwen3-coder-30b has cap=0).
    const cod = db.prepare(`SELECT family_id FROM routing_cascade WHERE task_type = 'coding' AND mode = 'local' AND is_auto_generated = 1 ORDER BY priority LIMIT 1`).get();
    expect(cod.family_id).toBe('local-qwen3-6-35b-a3b');
    // Image — kontext wins now (schnell has cap_image=0).
    const img = db.prepare(`SELECT family_id FROM routing_cascade WHERE task_type = 'image' AND mode = 'local' AND is_auto_generated = 1 ORDER BY priority LIMIT 1`).get();
    expect(img.family_id).toBe('local-flux1-kontext-dev');
  });

  it('preserves manual local cascade rows (is_auto_generated=0)', async () => {
    await MIGRATION.up({ db, logger: silentLogger() });
    const manual = db.prepare(`SELECT * FROM routing_cascade WHERE mode = 'local' AND is_auto_generated = 0`).all();
    expect(manual).toHaveLength(1);
    expect(manual[0].task_type).toBe('summary');
    expect(manual[0].priority).toBe(99);
    expect(manual[0].family_id).toBe('local-qwen3-6-35b-a3b');
  });

  it('does not touch proprietary cascade rows', async () => {
    const before = db.prepare(`SELECT task_type, priority, family_id FROM routing_cascade WHERE mode = 'proprietary' ORDER BY task_type, priority`).all();
    await MIGRATION.up({ db, logger: silentLogger() });
    const after = db.prepare(`SELECT task_type, priority, family_id FROM routing_cascade WHERE mode = 'proprietary' ORDER BY task_type, priority`).all();
    expect(after).toEqual(before);
  });

  it('is idempotent — second run is a no-op', async () => {
    await MIGRATION.up({ db, logger: silentLogger() });
    const snapshot = db.prepare(`SELECT id, eligible_tasks, cap_chat, cap_image FROM ai_model_families ORDER BY id`).all();
    await MIGRATION.up({ db, logger: silentLogger() });
    const after = db.prepare(`SELECT id, eligible_tasks, cap_chat, cap_image FROM ai_model_families ORDER BY id`).all();
    expect(after).toEqual(snapshot);
  });

  it('declares version + description', () => {
    expect(MIGRATION.version).toBe('0.3.13');
    expect(MIGRATION.description).toMatch(/triplet|v2/i);
  });
});
