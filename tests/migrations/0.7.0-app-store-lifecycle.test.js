import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const Database = require('better-sqlite3');

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

// 0.6.x-shaped DB: settings + apps + user_account tables, all minimal.
// The 0.7.0 migration only ALTERs apps + user_account; the schemas can be
// shells as long as PRAGMA table_info returns the expected columns.
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE apps (
      id TEXT PRIMARY KEY,
      app_type TEXT,
      status TEXT,
      external_slug TEXT,
      channel TEXT,
      manifest_yaml TEXT,
      update_status TEXT,
      updated_at TEXT
    );
    CREATE TABLE user_account (
      id TEXT PRIMARY KEY DEFAULT 'local',
      os8_user_id TEXT,
      username TEXT,
      display_name TEXT,
      avatar_url TEXT,
      email TEXT,
      updated_at TEXT
    );
  `);
  return db;
}

function colNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
}

function getSetting(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
}

describe('migration 0.7.0 — App Store v1.2 lifecycle completeness', () => {
  let db;
  let MIGRATION;

  beforeEach(() => {
    delete require.cache[require.resolve('../../src/migrations/0.7.0-app-store-lifecycle')];
    MIGRATION = require('../../src/migrations/0.7.0-app-store-lifecycle');
    db = makeDb();
  });

  afterEach(() => {
    db.close();
  });

  it('declares version 0.7.0 and a description', () => {
    expect(MIGRATION.version).toBe('0.7.0');
    expect(typeof MIGRATION.description).toBe('string');
    expect(MIGRATION.description.length).toBeGreaterThan(0);
  });

  it('adds apps.update_conflict_files (TEXT) for PR 5.4 conflict-state persistence', async () => {
    expect(colNames(db, 'apps')).not.toContain('update_conflict_files');
    await MIGRATION.up({ db, logger: silentLogger });
    expect(colNames(db, 'apps')).toContain('update_conflict_files');

    // TEXT column accepts JSON payloads round-trip.
    db.prepare("INSERT INTO apps (id, update_conflict_files) VALUES ('a1', ?)").run(
      JSON.stringify(['src/App.tsx', 'src/index.css'])
    );
    const row = db.prepare("SELECT update_conflict_files FROM apps WHERE id = 'a1'").get();
    expect(JSON.parse(row.update_conflict_files)).toEqual(['src/App.tsx', 'src/index.css']);
  });

  it('adds user_account.session_cookie (TEXT) for PR 5.1 heartbeat plumbing', async () => {
    expect(colNames(db, 'user_account')).not.toContain('session_cookie');
    await MIGRATION.up({ db, logger: silentLogger });
    expect(colNames(db, 'user_account')).toContain('session_cookie');
  });

  it('adds user_account.share_installed_apps (INTEGER, default 1) for PR 5.1 opt-out', async () => {
    expect(colNames(db, 'user_account')).not.toContain('share_installed_apps');
    await MIGRATION.up({ db, logger: silentLogger });
    expect(colNames(db, 'user_account')).toContain('share_installed_apps');

    // Default ON when a row is inserted without the column being set.
    db.prepare("INSERT INTO user_account (id, os8_user_id) VALUES ('local', 'u_test')").run();
    const row = db.prepare("SELECT share_installed_apps FROM user_account WHERE id = 'local'").get();
    expect(row.share_installed_apps).toBe(1);
  });

  it('seeds app_store.orphan_restore.prompt = true for PR 5.5 default-on prompt', async () => {
    await MIGRATION.up({ db, logger: silentLogger });
    expect(getSetting(db, 'app_store.orphan_restore.prompt')).toBe('true');
  });

  it('preserves a user-set orphan_restore.prompt = false across re-runs', async () => {
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('app_store.orphan_restore.prompt', 'false')"
    ).run();
    await MIGRATION.up({ db, logger: silentLogger });
    expect(getSetting(db, 'app_store.orphan_restore.prompt')).toBe('false');
  });

  it('defensively seeds _internal_call_token if absent (covers a botched 0.6.0)', async () => {
    expect(getSetting(db, '_internal_call_token')).toBeUndefined();
    await MIGRATION.up({ db, logger: silentLogger });
    const token = getSetting(db, '_internal_call_token');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does NOT rotate _internal_call_token if 0.6.0 already seeded it', async () => {
    const existing = 'a'.repeat(64);
    db.prepare("INSERT INTO settings (key, value) VALUES ('_internal_call_token', ?)").run(existing);
    await MIGRATION.up({ db, logger: silentLogger });
    expect(getSetting(db, '_internal_call_token')).toBe(existing);
  });

  it('is idempotent — re-running does not duplicate columns or seeds', async () => {
    await MIGRATION.up({ db, logger: silentLogger });
    await MIGRATION.up({ db, logger: silentLogger });

    // Each ALTER-target column appears exactly once.
    expect(colNames(db, 'apps').filter(c => c === 'update_conflict_files').length).toBe(1);
    expect(colNames(db, 'user_account').filter(c => c === 'session_cookie').length).toBe(1);
    expect(colNames(db, 'user_account').filter(c => c === 'share_installed_apps').length).toBe(1);

    // Each seeded settings key has exactly one row.
    for (const key of ['app_store.orphan_restore.prompt', '_internal_call_token']) {
      const rows = db.prepare('SELECT COUNT(*) AS c FROM settings WHERE key = ?').get(key).c;
      expect(rows).toBe(1);
    }
  });

  it('preserves prior data on re-run (existing apps row + cookie cache survive)', async () => {
    await MIGRATION.up({ db, logger: silentLogger });
    db.prepare(`
      INSERT INTO user_account (id, os8_user_id, session_cookie, share_installed_apps)
      VALUES ('local', 'u_test', 'next-auth.session-token=abc', 1)
    `).run();
    db.prepare(`
      INSERT INTO apps (id, app_type, status, update_conflict_files)
      VALUES ('a1', 'external', 'active', '["src/App.tsx"]')
    `).run();

    await MIGRATION.up({ db, logger: silentLogger });

    const account = db.prepare("SELECT session_cookie, share_installed_apps FROM user_account WHERE id = 'local'").get();
    expect(account.session_cookie).toBe('next-auth.session-token=abc');
    expect(account.share_installed_apps).toBe(1);

    const app = db.prepare("SELECT update_conflict_files FROM apps WHERE id = 'a1'").get();
    expect(JSON.parse(app.update_conflict_files)).toEqual(['src/App.tsx']);
  });

  it('works without a logger argument (no-throw on undefined logger)', async () => {
    await expect(MIGRATION.up({ db })).resolves.toBeUndefined();
    expect(colNames(db, 'apps')).toContain('update_conflict_files');
  });
});
