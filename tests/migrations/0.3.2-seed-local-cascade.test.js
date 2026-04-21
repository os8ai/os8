import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const Database = require('better-sqlite3');

const MIGRATION = require('../../src/migrations/0.3.2-seed-local-cascade');

// Minimal post-0.3.1 schema — the migration needs routing_cascade with mode
// column, ai_model_families with launcher_* and supports_vision, and
// ai_containers so the resolver can distinguish HTTP from CLI containers.
// Everything else in the full schema is irrelevant to this migration.
function makePostPhase31Db() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);

    CREATE TABLE ai_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      api_key_env TEXT
    );

    CREATE TABLE ai_containers (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'cli',
      name TEXT NOT NULL DEFAULT '',
      has_login INTEGER DEFAULT 0,
      display_order INTEGER DEFAULT 0
    );

    CREATE TABLE ai_model_families (
      id TEXT PRIMARY KEY,
      container_id TEXT NOT NULL,
      name TEXT NOT NULL,
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

    CREATE TABLE ai_models (
      id TEXT PRIMARY KEY,
      family_id TEXT,
      api_model_id TEXT,
      is_latest INTEGER DEFAULT 0
    );

    CREATE TABLE ai_account_status (
      provider_id TEXT PRIMARY KEY,
      login_exhausted_until TEXT,
      api_exhausted_until TEXT
    );

    CREATE TABLE env_variables (
      id TEXT PRIMARY KEY,
      key TEXT UNIQUE NOT NULL,
      value TEXT NOT NULL
    );

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

  // Cloud families (proprietary). cap_coding=5 so they'd score high on coding.
  db.prepare(`INSERT INTO ai_providers (id, name, api_key_env) VALUES ('anthropic', 'Anthropic', 'ANTHROPIC_API_KEY')`).run();
  db.prepare(`INSERT INTO ai_providers (id, name, api_key_env) VALUES ('local', 'Local', NULL)`).run();
  db.prepare(`INSERT INTO ai_containers (id, provider_id, type, name, has_login) VALUES ('claude', 'anthropic', 'cli', 'Claude', 1)`).run();
  db.prepare(`INSERT INTO ai_containers (id, provider_id, type, name, has_login) VALUES ('local', 'local', 'http', 'Local', 0)`).run();

  const insertFamily = db.prepare(`
    INSERT INTO ai_model_families (id, container_id, name, cli_model_arg, cost_tier, cap_chat, cap_jobs, cap_planning, cap_coding, cap_summary, cap_image, eligible_tasks, launcher_model, launcher_backend, supports_vision)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertFamily.run('claude-opus', 'claude', 'Opus', 'opus', 5, 4, 5, 5, 5, 5, 0, null, null, null, 0);
  insertFamily.run('local-gemma-4-31b', 'local', 'Gemma 4 31B', 'gemma-4-31B-it-nvfp4', 1, 3, 2, 3, 2, 3, 0, 'conversation,summary,planning', 'gemma-4-31B-it-nvfp4', 'vllm', 0);
  insertFamily.run('local-qwen3-coder-30b', 'local', 'Qwen3 Coder 30B', 'qwen3-coder-30b', 1, 2, 4, 3, 4, 2, 0, 'coding,jobs', 'qwen3-coder-30b', 'ollama', 0);
  insertFamily.run('local-qwen3-coder-next', 'local', 'Qwen3 Coder Next', 'qwen3-coder-next', 1, 2, 5, 4, 5, 2, 0, 'coding,jobs', 'qwen3-coder-next', 'vllm', 0);
  insertFamily.run('local-flux1-schnell', 'local', 'Flux Schnell', 'flux1-schnell', 1, 0, 0, 0, 0, 0, 4, 'image', 'flux1-schnell', 'comfyui', 0);
  insertFamily.run('local-kokoro-v1', 'local', 'Kokoro', 'kokoro-v1', 1, 0, 0, 0, 0, 0, 0, null, 'kokoro-v1', 'kokoro', 0);

  // Simulate os8-3-1 output: proprietary rows only.
  const insertCascade = db.prepare(`
    INSERT INTO routing_cascade (task_type, priority, family_id, access_method, enabled, is_auto_generated, mode)
    VALUES (?, ?, ?, ?, ?, ?, 'proprietary')
  `);
  insertCascade.run('coding', 0, 'claude-opus', 'login', 1, 1);
  insertCascade.run('conversation', 0, 'claude-opus', 'login', 1, 1);

  // Default preference + seed ai_account_status so isAvailable doesn't crash
  // if anyone calls it. (generateCascade doesn't call isAvailable, but safety.)
  db.prepare(`INSERT INTO settings (key, value) VALUES ('routing_preference', 'balanced')`).run();
  db.prepare(`INSERT INTO ai_account_status (provider_id) VALUES ('anthropic')`).run();
  db.prepare(`INSERT INTO ai_account_status (provider_id) VALUES ('local')`).run();

  return db;
}

const silentLogger = () => ({ log: () => {}, warn: () => {}, error: () => {} });

describe('migration 0.3.2 — seed local cascade', () => {
  let db;

  beforeEach(() => {
    db = makePostPhase31Db();
  });

  afterEach(() => {
    db.close();
  });

  it('seeds local rows for coding, jobs, conversation, summary, planning, image', async () => {
    await MIGRATION.up({ db, logger: silentLogger() });
    const taskTypes = db.prepare(`SELECT DISTINCT task_type FROM routing_cascade WHERE mode = 'local' ORDER BY task_type`).all().map(r => r.task_type);
    // qwen3-coder families cover coding + jobs; gemma covers conversation/summary/planning;
    // flux covers image. Not every task type will have a family — just ensure the
    // expected coverage.
    expect(taskTypes).toContain('coding');
    expect(taskTypes).toContain('jobs');
    expect(taskTypes).toContain('conversation');
    expect(taskTypes).toContain('summary');
    expect(taskTypes).toContain('planning');
    expect(taskTypes).toContain('image');
  });

  it('ranks qwen3-coder-next ahead of qwen3-coder-30b on coding (cap=5 vs 4)', async () => {
    await MIGRATION.up({ db, logger: silentLogger() });
    const codingLocal = db.prepare(`SELECT family_id, priority FROM routing_cascade WHERE mode = 'local' AND task_type = 'coding' ORDER BY priority ASC`).all();
    expect(codingLocal[0].family_id).toBe('local-qwen3-coder-next');
    expect(codingLocal[1].family_id).toBe('local-qwen3-coder-30b');
  });

  it('does not touch proprietary rows', async () => {
    const beforeProp = db.prepare(`SELECT task_type, priority, family_id FROM routing_cascade WHERE mode = 'proprietary' ORDER BY task_type, priority`).all();
    await MIGRATION.up({ db, logger: silentLogger() });
    const afterProp = db.prepare(`SELECT task_type, priority, family_id FROM routing_cascade WHERE mode = 'proprietary' ORDER BY task_type, priority`).all();
    expect(afterProp).toEqual(beforeProp);
  });

  it('only inserts local rows (never proprietary)', async () => {
    await MIGRATION.up({ db, logger: silentLogger() });
    const modes = db.prepare(`SELECT DISTINCT mode FROM routing_cascade`).all().map(r => r.mode).sort();
    expect(modes).toEqual(['local', 'proprietary']);
    // Flux is local-only and has cap_image=4; it should NOT appear in proprietary image cascade.
    const propImage = db.prepare(`SELECT family_id FROM routing_cascade WHERE mode = 'proprietary' AND task_type = 'image'`).all();
    expect(propImage.every(r => !r.family_id.startsWith('local-'))).toBe(true);
  });

  it('is idempotent — second run is a no-op', async () => {
    await MIGRATION.up({ db, logger: silentLogger() });
    const snapshot = db.prepare(`SELECT task_type, priority, family_id, mode FROM routing_cascade ORDER BY mode, task_type, priority`).all();
    await MIGRATION.up({ db, logger: silentLogger() });
    const after = db.prepare(`SELECT task_type, priority, family_id, mode FROM routing_cascade ORDER BY mode, task_type, priority`).all();
    expect(after).toEqual(snapshot);
  });

  it('declares version and description', () => {
    expect(MIGRATION.version).toBe('0.3.2');
    expect(MIGRATION.description).toMatch(/local|cascade/i);
  });
});
