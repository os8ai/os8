import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const Database = require('better-sqlite3');

const MIGRATION = require('../../src/migrations/0.4.5-context-limits');

// The migration only touches the settings table — minimal schema.
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);`);
  return db;
}

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

describe('migration 0.4.5 — seed per-mode context limits', () => {
  let db;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  function readSetting(key) {
    return db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key)?.value ?? null;
  }

  it('seeds both keys with default values when neither exists', async () => {
    await MIGRATION.up({ db, logger: silentLogger });
    expect(readSetting('context_limit_proprietary_tokens')).toBe('200000');
    expect(readSetting('context_limit_local_tokens')).toBe('60000');
  });

  it('preserves an existing local value (INSERT OR IGNORE)', async () => {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('context_limit_local_tokens', '40000')`).run();
    await MIGRATION.up({ db, logger: silentLogger });
    expect(readSetting('context_limit_local_tokens')).toBe('40000');
    expect(readSetting('context_limit_proprietary_tokens')).toBe('200000');
  });

  it('preserves an existing proprietary value', async () => {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('context_limit_proprietary_tokens', '100000')`).run();
    await MIGRATION.up({ db, logger: silentLogger });
    expect(readSetting('context_limit_proprietary_tokens')).toBe('100000');
    expect(readSetting('context_limit_local_tokens')).toBe('60000');
  });

  it('is idempotent — running twice produces the same state', async () => {
    await MIGRATION.up({ db, logger: silentLogger });
    await MIGRATION.up({ db, logger: silentLogger });
    expect(readSetting('context_limit_proprietary_tokens')).toBe('200000');
    expect(readSetting('context_limit_local_tokens')).toBe('60000');

    // Exactly two rows for our keys — no duplicates from the second run.
    const count = db.prepare(`
      SELECT COUNT(*) AS c FROM settings
      WHERE key IN ('context_limit_proprietary_tokens', 'context_limit_local_tokens')
    `).get().c;
    expect(count).toBe(2);
  });

  it('does not touch unrelated settings keys', async () => {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('ai_mode', 'local')`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('user_first_name', 'Leo')`).run();
    await MIGRATION.up({ db, logger: silentLogger });
    expect(readSetting('ai_mode')).toBe('local');
    expect(readSetting('user_first_name')).toBe('Leo');
  });

  it('declares version 0.4.5 and a description', () => {
    expect(MIGRATION.version).toBe('0.4.5');
    expect(typeof MIGRATION.description).toBe('string');
    expect(MIGRATION.description.length).toBeGreaterThan(0);
  });
});
