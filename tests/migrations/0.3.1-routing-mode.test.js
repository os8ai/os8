import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const Database = require('better-sqlite3');
const path = require('path');

const MIGRATION = require('../../src/migrations/0.3.1-routing-mode');

// Minimal pre-0.3.1 schema — just enough to exercise the migration. We only
// need the settings table (for the local_models_enabled delete) plus the
// pre-migration routing_cascade (the thing being rebuilt) and the
// ai_model_families it FKs to. Everything else in the real schema is irrelevant.
function makePreMigrationDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);

    CREATE TABLE ai_model_families (
      id TEXT PRIMARY KEY,
      container_id TEXT NOT NULL,
      name TEXT NOT NULL
    );

    CREATE TABLE routing_cascade (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_type TEXT NOT NULL,
      priority INTEGER NOT NULL,
      family_id TEXT NOT NULL REFERENCES ai_model_families(id),
      access_method TEXT NOT NULL DEFAULT 'api',
      enabled INTEGER DEFAULT 1,
      is_auto_generated INTEGER DEFAULT 1,
      UNIQUE(task_type, priority)
    );
  `);

  // Seed a couple of families and cascade rows — mirrors real-world state on
  // an upgrading 0.2.x install.
  db.prepare(`INSERT INTO ai_model_families (id, container_id, name) VALUES (?, ?, ?)`).run('claude-opus', 'claude', 'Opus');
  db.prepare(`INSERT INTO ai_model_families (id, container_id, name) VALUES (?, ?, ?)`).run('claude-sonnet', 'claude', 'Sonnet');

  const insertCascade = db.prepare(`
    INSERT INTO routing_cascade (task_type, priority, family_id, access_method, enabled, is_auto_generated)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertCascade.run('conversation', 0, 'claude-opus', 'login', 1, 1);
  insertCascade.run('conversation', 1, 'claude-sonnet', 'api', 1, 1);
  insertCascade.run('coding', 0, 'claude-sonnet', 'api', 1, 1);

  // Dormant Phase-1 flag the migration deletes.
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run('local_models_enabled', '0');

  return db;
}

const silentLogger = () => ({ log: () => {}, warn: () => {}, error: () => {} });

describe('migration 0.3.1 — routing-mode', () => {
  let db;

  beforeEach(() => {
    db = makePreMigrationDb();
  });

  afterEach(() => {
    db.close();
  });

  it('adds mode column with proprietary default', async () => {
    await MIGRATION.up({ db, logger: silentLogger() });
    const cols = db.prepare(`PRAGMA table_info(routing_cascade)`).all();
    const modeCol = cols.find(c => c.name === 'mode');
    expect(modeCol, 'mode column should exist').toBeDefined();
    expect(modeCol.notnull).toBe(1);
    expect(modeCol.dflt_value).toBe(`'proprietary'`);
  });

  it('backfills all existing rows with mode=proprietary', async () => {
    await MIGRATION.up({ db, logger: silentLogger() });
    const rows = db.prepare(`SELECT task_type, priority, mode FROM routing_cascade ORDER BY task_type, priority`).all();
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.mode).toBe('proprietary');
    }
  });

  it('preserves row ids and column values', async () => {
    const before = db.prepare(`SELECT id, task_type, priority, family_id, access_method, enabled, is_auto_generated FROM routing_cascade ORDER BY id`).all();
    await MIGRATION.up({ db, logger: silentLogger() });
    const after = db.prepare(`SELECT id, task_type, priority, family_id, access_method, enabled, is_auto_generated FROM routing_cascade ORDER BY id`).all();
    expect(after).toEqual(before);
  });

  it('changes UNIQUE from (task_type, priority) to (task_type, mode, priority)', async () => {
    await MIGRATION.up({ db, logger: silentLogger() });
    // Same task_type + priority under a different mode should now succeed.
    const insert = db.prepare(`
      INSERT INTO routing_cascade (task_type, priority, family_id, access_method, enabled, is_auto_generated, mode)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    expect(() => insert.run('conversation', 0, 'claude-opus', 'api', 1, 1, 'local')).not.toThrow();
    // But duplicate within same (task_type, mode, priority) still fails.
    expect(() => insert.run('conversation', 0, 'claude-sonnet', 'api', 1, 1, 'local')).toThrow(/UNIQUE/);
  });

  it('deletes dormant local_models_enabled settings row', async () => {
    await MIGRATION.up({ db, logger: silentLogger() });
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'local_models_enabled'`).get();
    expect(row).toBeUndefined();
  });

  it('is idempotent — second run is a no-op', async () => {
    await MIGRATION.up({ db, logger: silentLogger() });
    const snapshot = db.prepare(`SELECT id, task_type, priority, family_id, mode FROM routing_cascade ORDER BY id`).all();
    await MIGRATION.up({ db, logger: silentLogger() });
    const after = db.prepare(`SELECT id, task_type, priority, family_id, mode FROM routing_cascade ORDER BY id`).all();
    expect(after).toEqual(snapshot);
  });

  it('declares version and description', () => {
    expect(MIGRATION.version).toBe('0.3.1');
    expect(MIGRATION.description).toMatch(/routing_cascade|mode/i);
  });
});
