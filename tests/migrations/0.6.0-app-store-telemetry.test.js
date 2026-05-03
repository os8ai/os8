import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const Database = require('better-sqlite3');

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

// 0.5.x-shaped DB: settings table only. The migration creates its own
// app_telemetry_events table so it doesn't depend on the apps schema.
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);`);
  return db;
}

function tableExists(db, name) {
  return db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`
  ).get(name) != null;
}

function indexNames(db, table) {
  return db.prepare(
    `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?`
  ).all(table).map(r => r.name);
}

function getSetting(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
}

describe('migration 0.6.0 — App Store v1.1 telemetry queue + auto-update settings', () => {
  let db;
  let MIGRATION;

  beforeEach(() => {
    delete require.cache[require.resolve('../../src/migrations/0.6.0-app-store-telemetry')];
    MIGRATION = require('../../src/migrations/0.6.0-app-store-telemetry');
    db = makeDb();
  });

  afterEach(() => {
    db.close();
  });

  it('declares version 0.6.0 and a description', () => {
    expect(MIGRATION.version).toBe('0.6.0');
    expect(typeof MIGRATION.description).toBe('string');
    expect(MIGRATION.description.length).toBeGreaterThan(0);
  });

  it('creates app_telemetry_events table with expected columns', async () => {
    await MIGRATION.up({ db, logger: silentLogger });
    expect(tableExists(db, 'app_telemetry_events')).toBe(true);

    const cols = db.prepare(`PRAGMA table_info(app_telemetry_events)`).all().map(c => c.name);
    for (const expected of ['id', 'kind', 'payload', 'created_at', 'sent_at']) {
      expect(cols).toContain(expected);
    }
  });

  it('creates the pending-events partial index for cheap flush queries', async () => {
    await MIGRATION.up({ db, logger: silentLogger });
    expect(indexNames(db, 'app_telemetry_events')).toContain('idx_telemetry_events_pending');
  });

  it('seeds app_store.telemetry.opt_in defaulting to false (strict opt-in)', async () => {
    await MIGRATION.up({ db, logger: silentLogger });
    expect(getSetting(db, 'app_store.telemetry.opt_in')).toBe('false');
  });

  it('seeds app_store.telemetry.consent_shown to false so first-install modal triggers once', async () => {
    await MIGRATION.up({ db, logger: silentLogger });
    expect(getSetting(db, 'app_store.telemetry.consent_shown')).toBe('false');
  });

  it('seeds app_store.auto_update.notify_on_apply defaulting to true', async () => {
    await MIGRATION.up({ db, logger: silentLogger });
    expect(getSetting(db, 'app_store.auto_update.notify_on_apply')).toBe('true');
  });

  it('generates _internal_call_token as 64-char hex (32 bytes of entropy)', async () => {
    await MIGRATION.up({ db, logger: silentLogger });
    const token = getSetting(db, '_internal_call_token');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('preserves user-set opt_in=true across re-run (does not overwrite)', async () => {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('app_store.telemetry.opt_in', 'true')`).run();
    await MIGRATION.up({ db, logger: silentLogger });
    expect(getSetting(db, 'app_store.telemetry.opt_in')).toBe('true');
  });

  it('preserves _internal_call_token across re-runs (token never rotates by migration)', async () => {
    await MIGRATION.up({ db, logger: silentLogger });
    const first = getSetting(db, '_internal_call_token');
    await MIGRATION.up({ db, logger: silentLogger });
    expect(getSetting(db, '_internal_call_token')).toBe(first);
  });

  it('is idempotent — running twice produces the same state', async () => {
    await MIGRATION.up({ db, logger: silentLogger });
    await MIGRATION.up({ db, logger: silentLogger });

    // Single table, single row per setting key.
    const tableCount = db.prepare(
      `SELECT COUNT(*) AS c FROM sqlite_master WHERE name='app_telemetry_events' AND type='table'`
    ).get().c;
    expect(tableCount).toBe(1);

    for (const key of [
      'app_store.telemetry.opt_in',
      'app_store.telemetry.consent_shown',
      'app_store.auto_update.notify_on_apply',
      '_internal_call_token'
    ]) {
      const rows = db.prepare(`SELECT COUNT(*) AS c FROM settings WHERE key = ?`).get(key).c;
      expect(rows).toBe(1);
    }
  });

  it('preserves prior telemetry events on re-run (does not drop the queue)', async () => {
    await MIGRATION.up({ db, logger: silentLogger });
    db.prepare(`
      INSERT INTO app_telemetry_events (id, kind, payload, created_at, sent_at)
      VALUES ('e1', 'install_started', '{}', '2026-05-01T00:00:00Z', NULL)
    `).run();

    await MIGRATION.up({ db, logger: silentLogger });

    const row = db.prepare(`SELECT id, kind FROM app_telemetry_events WHERE id = 'e1'`).get();
    expect(row).toEqual({ id: 'e1', kind: 'install_started' });
  });

  it('works without a logger argument (no-throw on undefined logger)', async () => {
    await expect(MIGRATION.up({ db })).resolves.toBeUndefined();
    expect(tableExists(db, 'app_telemetry_events')).toBe(true);
  });
});
