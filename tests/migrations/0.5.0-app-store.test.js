import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const Database = require('better-sqlite3');

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

// Build a 0.4.x-shaped DB so the migration ALTERs the actual `apps` shape.
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);

    CREATE TABLE apps (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'active',
      display_order INTEGER DEFAULT 0,
      color TEXT DEFAULT '#6366f1',
      icon TEXT,
      text_color TEXT DEFAULT '#ffffff',
      archived_at TEXT,
      app_type TEXT DEFAULT 'regular',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE app_env_variables (
      id TEXT PRIMARY KEY,
      app_id TEXT REFERENCES apps(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      UNIQUE(app_id, key)
    );
  `);
  return db;
}

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
}

function indexNames(db, table) {
  return db.prepare(
    `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?`
  ).all(table).map(r => r.name);
}

describe('migration 0.5.0 — App Store schema', () => {
  let db;
  let tmpHome;
  let prevHome;
  let MIGRATION;

  beforeEach(() => {
    // Stage OS8_HOME under a temp dir so the migration's mkdirSync doesn't
    // touch the developer's real ~/os8/ tree. Reset module cache so config.js
    // re-reads OS8_HOME — config.js consts capture the env at require time.
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-mig-0.5.0-'));
    prevHome = process.env.OS8_HOME;
    process.env.OS8_HOME = tmpHome;
    delete require.cache[require.resolve('../../src/config')];
    delete require.cache[require.resolve('../../src/migrations/0.5.0-app-store')];
    MIGRATION = require('../../src/migrations/0.5.0-app-store');

    db = makeDb();
  });

  afterEach(() => {
    db.close();
    if (prevHome === undefined) delete process.env.OS8_HOME;
    else process.env.OS8_HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('declares version 0.5.0 and a description', () => {
    expect(MIGRATION.version).toBe('0.5.0');
    expect(typeof MIGRATION.description).toBe('string');
    expect(MIGRATION.description.length).toBeGreaterThan(0);
  });

  it('extends the apps table with all 13 catalog/install columns', async () => {
    await MIGRATION.up({ db, logger: silentLogger });
    const cols = columnNames(db, 'apps');
    for (const expected of [
      'external_slug', 'channel', 'framework',
      'manifest_yaml', 'manifest_sha', 'catalog_commit_sha',
      'upstream_declared_ref', 'upstream_resolved_commit',
      'user_branch', 'dev_mode', 'auto_update',
      'update_available', 'update_to_commit'
    ]) {
      expect(cols).toContain(expected);
    }
  });

  it('adds description column to app_env_variables', async () => {
    await MIGRATION.up({ db, logger: silentLogger });
    expect(columnNames(db, 'app_env_variables')).toContain('description');
  });

  it('creates app_catalog with required columns and indexes', async () => {
    await MIGRATION.up({ db, logger: silentLogger });
    const cols = columnNames(db, 'app_catalog');
    for (const expected of [
      'id', 'slug', 'name', 'description', 'publisher', 'channel', 'category',
      'icon_url', 'screenshots', 'manifest_yaml', 'manifest_sha',
      'catalog_commit_sha', 'upstream_declared_ref', 'upstream_resolved_commit',
      'license', 'runtime_kind', 'framework', 'architectures', 'risk_level',
      'install_count', 'rating', 'synced_at', 'deleted_at'
    ]) {
      expect(cols).toContain(expected);
    }
    const idx = indexNames(db, 'app_catalog');
    expect(idx).toContain('idx_app_catalog_channel');
    expect(idx).toContain('idx_app_catalog_category');
    expect(idx).toContain('idx_app_catalog_deleted');
  });

  it('creates app_install_jobs with required columns and indexes', async () => {
    await MIGRATION.up({ db, logger: silentLogger });
    const cols = columnNames(db, 'app_install_jobs');
    for (const expected of [
      'id', 'app_id', 'external_slug', 'upstream_resolved_commit',
      'channel', 'status', 'staging_dir', 'review_report',
      'error_message', 'log_path', 'created_at', 'updated_at'
    ]) {
      expect(cols).toContain(expected);
    }
    const idx = indexNames(db, 'app_install_jobs');
    expect(idx).toContain('idx_install_jobs_status');
    expect(idx).toContain('idx_install_jobs_slug');
  });

  it('creates the apps idx_apps_external_slug + idx_apps_app_type indexes', async () => {
    await MIGRATION.up({ db, logger: silentLogger });
    const idx = indexNames(db, 'apps');
    expect(idx).toContain('idx_apps_external_slug');
    expect(idx).toContain('idx_apps_app_type');
  });

  it('creates the FTS5 virtual table and triggers', async () => {
    await MIGRATION.up({ db, logger: silentLogger });
    const objects = db.prepare(
      `SELECT name, type FROM sqlite_master WHERE name LIKE 'app_catalog%'`
    ).all();
    const names = objects.map(o => o.name);

    expect(names).toContain('app_catalog');
    expect(names).toContain('app_catalog_fts');
    expect(names).toContain('app_catalog_ai');
    expect(names).toContain('app_catalog_ad');
    expect(names).toContain('app_catalog_au');
  });

  it('FTS triggers index inserts and clean up deletes', async () => {
    await MIGRATION.up({ db, logger: silentLogger });

    db.prepare(`
      INSERT INTO app_catalog (
        id, slug, name, description, publisher, channel, category,
        manifest_sha, catalog_commit_sha, upstream_declared_ref,
        upstream_resolved_commit
      ) VALUES (
        'wm-1', 'worldmonitor', 'World Monitor',
        'Real-time global intelligence dashboard.',
        'koala73', 'verified', 'intelligence',
        'sha-1', 'cat-sha', 'v2.5.23',
        'e51058e1765ef2f0c83ccb1d08d984bc59d23f10'
      )
    `).run();

    const hits = db.prepare(
      `SELECT slug FROM app_catalog_fts WHERE app_catalog_fts MATCH 'worldmonitor'`
    ).all();
    expect(hits).toHaveLength(1);
    expect(hits[0].slug).toBe('worldmonitor');

    db.prepare(`DELETE FROM app_catalog WHERE slug = 'worldmonitor'`).run();
    const after = db.prepare(
      `SELECT slug FROM app_catalog_fts WHERE app_catalog_fts MATCH 'worldmonitor'`
    ).all();
    expect(after).toHaveLength(0);
  });

  it('FTS triggers handle UPDATE by reindexing the row', async () => {
    await MIGRATION.up({ db, logger: silentLogger });

    db.prepare(`
      INSERT INTO app_catalog (
        id, slug, name, description, publisher, channel, category,
        manifest_sha, catalog_commit_sha, upstream_declared_ref,
        upstream_resolved_commit
      ) VALUES (
        'wm-1', 'worldmonitor', 'World Monitor', 'first description',
        'koala73', 'verified', 'intelligence',
        'sha-1', 'cat-sha', 'v2.5.23', 'e51058e1765ef2f0c83ccb1d08d984bc59d23f10'
      )
    `).run();

    db.prepare(`UPDATE app_catalog SET description = 'updated copy' WHERE slug = 'worldmonitor'`).run();

    expect(
      db.prepare(`SELECT slug FROM app_catalog_fts WHERE app_catalog_fts MATCH 'updated'`).all()
    ).toHaveLength(1);
    expect(
      db.prepare(`SELECT slug FROM app_catalog_fts WHERE app_catalog_fts MATCH 'first'`).all()
    ).toHaveLength(0);
  });

  it('creates apps_staging directory under OS8_HOME', async () => {
    await MIGRATION.up({ db, logger: silentLogger });
    expect(fs.existsSync(path.join(tmpHome, 'apps_staging'))).toBe(true);
  });

  it('is idempotent — running twice produces the same state', async () => {
    await MIGRATION.up({ db, logger: silentLogger });
    await MIGRATION.up({ db, logger: silentLogger });

    const cols = columnNames(db, 'apps');
    expect(cols).toContain('external_slug');
    expect(cols.filter(c => c === 'external_slug')).toHaveLength(1);

    expect(columnNames(db, 'app_env_variables').filter(c => c === 'description')).toHaveLength(1);

    const tableRows = db.prepare(
      `SELECT COUNT(*) AS c FROM sqlite_master WHERE name='app_catalog' AND type='table'`
    ).get();
    expect(tableRows.c).toBe(1);
  });

  it('preserves existing apps rows', async () => {
    db.prepare(`
      INSERT INTO apps (id, name, slug, app_type) VALUES (?, ?, ?, ?)
    `).run('native-1', 'My App', 'my-app', 'regular');

    await MIGRATION.up({ db, logger: silentLogger });

    const row = db.prepare(`SELECT id, name, slug, app_type FROM apps WHERE id = 'native-1'`).get();
    expect(row).toEqual({ id: 'native-1', name: 'My App', slug: 'my-app', app_type: 'regular' });
  });
});
