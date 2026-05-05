import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const Database = require('better-sqlite3');

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

// Minimal 0.7.x-shaped DB: settings table only. Migration 0.8.0 doesn't
// touch any other table — it just seeds two settings keys.
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);`);
  return db;
}

function getSetting(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
}

describe('migration 0.8.0 — App Store v1.3 per-channel auto-update defaults', () => {
  let db;
  let MIGRATION;

  beforeEach(() => {
    delete require.cache[require.resolve('../../src/migrations/0.8.0-app-store-community-auto-update')];
    MIGRATION = require('../../src/migrations/0.8.0-app-store-community-auto-update');
    db = makeDb();
  });

  afterEach(() => {
    db.close();
  });

  it('declares version 0.8.0 and a description', () => {
    expect(MIGRATION.version).toBe('0.8.0');
    expect(typeof MIGRATION.description).toBe('string');
    expect(MIGRATION.description.length).toBeGreaterThan(0);
  });

  it('seeds verified_default = false (Verified stays opt-in per PR 4.2 posture)', async () => {
    await MIGRATION.up({ db, logger: silentLogger });
    expect(getSetting(db, 'app_store.auto_update.verified_default')).toBe('false');
  });

  it('seeds community_default = true (Community defaults ON per Leo 2026-05-04)', async () => {
    await MIGRATION.up({ db, logger: silentLogger });
    expect(getSetting(db, 'app_store.auto_update.community_default')).toBe('true');
  });

  it('preserves a user-set verified_default = true across re-runs', async () => {
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('app_store.auto_update.verified_default', 'true')"
    ).run();
    await MIGRATION.up({ db, logger: silentLogger });
    expect(getSetting(db, 'app_store.auto_update.verified_default')).toBe('true');
  });

  it('preserves a user-set community_default = false across re-runs', async () => {
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('app_store.auto_update.community_default', 'false')"
    ).run();
    await MIGRATION.up({ db, logger: silentLogger });
    expect(getSetting(db, 'app_store.auto_update.community_default')).toBe('false');
  });

  it('is idempotent — re-running does not duplicate seeded rows', async () => {
    await MIGRATION.up({ db, logger: silentLogger });
    await MIGRATION.up({ db, logger: silentLogger });
    for (const key of [
      'app_store.auto_update.verified_default',
      'app_store.auto_update.community_default',
    ]) {
      const rows = db.prepare('SELECT COUNT(*) AS c FROM settings WHERE key = ?').get(key).c;
      expect(rows).toBe(1);
    }
  });

  it('works without a logger argument', async () => {
    await expect(MIGRATION.up({ db })).resolves.toBeUndefined();
    expect(getSetting(db, 'app_store.auto_update.community_default')).toBe('true');
  });
});
