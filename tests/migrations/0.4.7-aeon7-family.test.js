import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const Database = require('better-sqlite3');

const MIGRATION = require('../../src/migrations/0.4.7-aeon7-family');

// Minimum schema needed by the migration. Mirrors the columns the seeds.js
// path adds via ALTER TABLE before backfilling — the migration only writes
// to ai_model_families.
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ai_model_families (
      id TEXT PRIMARY KEY,
      container_id TEXT,
      name TEXT,
      display_name TEXT,
      cli_model_arg TEXT,
      is_default INTEGER DEFAULT 0,
      display_order INTEGER DEFAULT 0,
      cost_tier INTEGER DEFAULT 3,
      cap_chat INTEGER DEFAULT 3,
      cap_jobs INTEGER DEFAULT 3,
      cap_planning INTEGER DEFAULT 3,
      cap_coding INTEGER DEFAULT 3,
      cap_summary INTEGER DEFAULT 3,
      cap_image INTEGER DEFAULT 0,
      eligible_tasks TEXT,
      launcher_model TEXT,
      launcher_backend TEXT,
      supports_vision INTEGER DEFAULT 0
    );
  `);
  return db;
}

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };
const FAMILY_ID = 'local-aeon-7-gemma-4-26b';

describe('migration 0.4.7 — register AEON-7 Gemma 4 26B family', () => {
  let db;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  function readFamily() {
    return db.prepare(`SELECT * FROM ai_model_families WHERE id = ?`).get(FAMILY_ID);
  }

  it('inserts the family with launcher metadata + caps + eligibility', async () => {
    await MIGRATION.up({ db, logger: silentLogger });
    const f = readFamily();
    expect(f).toBeTruthy();
    expect(f.container_id).toBe('local');
    expect(f.cli_model_arg).toBe('aeon-7-gemma-4-26b');
    expect(f.launcher_model).toBe('aeon-7-gemma-4-26b');
    expect(f.launcher_backend).toBe('vllm');
    expect(f.supports_vision).toBe(0);
    expect(f.cap_chat).toBe(4);
    expect(f.cost_tier).toBe(1);
    expect(f.eligible_tasks).toBe('conversation,summary,planning,coding,jobs');
  });

  it('is idempotent — running twice keeps exactly one row and preserves metadata', async () => {
    await MIGRATION.up({ db, logger: silentLogger });
    await MIGRATION.up({ db, logger: silentLogger });
    const count = db.prepare(`SELECT COUNT(*) AS c FROM ai_model_families WHERE id = ?`).get(FAMILY_ID).c;
    expect(count).toBe(1);
    const f = readFamily();
    expect(f.launcher_model).toBe('aeon-7-gemma-4-26b');
    expect(f.eligible_tasks).toBe('conversation,summary,planning,coding,jobs');
  });

  it('refreshes metadata even when the family row was hand-inserted with stale values', async () => {
    db.prepare(`
      INSERT INTO ai_model_families (id, container_id, name, display_name, cli_model_arg)
      VALUES (?, 'local', 'AEON-7 Gemma-4-26B', 'old display name', 'wrong-id')
    `).run(FAMILY_ID);
    await MIGRATION.up({ db, logger: silentLogger });
    const f = readFamily();
    // INSERT OR IGNORE leaves cli_model_arg/display_name alone (the user might
    // have customized them) but the UPDATE refreshes the launcher metadata
    // and capabilities so dispatch routes correctly.
    expect(f.launcher_model).toBe('aeon-7-gemma-4-26b');
    expect(f.launcher_backend).toBe('vllm');
    expect(f.eligible_tasks).toBe('conversation,summary,planning,coding,jobs');
  });

  it('does not touch unrelated families', async () => {
    db.prepare(`
      INSERT INTO ai_model_families (id, container_id, name, display_name, cli_model_arg, launcher_model, launcher_backend, supports_vision, cap_chat)
      VALUES ('local-qwen3-6-35b-a3b', 'local', 'Qwen3.6-35B', 'Qwen3.6 35B', 'qwen3-6-35b-a3b', 'qwen3-6-35b-a3b', 'vllm', 1, 4)
    `).run();
    await MIGRATION.up({ db, logger: silentLogger });
    const qwen = db.prepare(`SELECT supports_vision, cap_chat FROM ai_model_families WHERE id = ?`).get('local-qwen3-6-35b-a3b');
    expect(qwen.supports_vision).toBe(1);
    expect(qwen.cap_chat).toBe(4);
  });

  it('declares version 0.4.7 and a description', () => {
    expect(MIGRATION.version).toBe('0.4.7');
    expect(typeof MIGRATION.description).toBe('string');
    expect(MIGRATION.description.length).toBeGreaterThan(0);
  });
});
