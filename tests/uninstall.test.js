import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const Database = require('better-sqlite3');
const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

describe('AppService.uninstall (PR 1.24)', () => {
  let db, tmpHome, prevHome, MIGRATION, AppService;

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-uninstall-'));
    prevHome = process.env.OS8_HOME;
    process.env.OS8_HOME = tmpHome;
    [
      '../src/config',
      '../src/migrations/0.5.0-app-store',
      '../src/services/app',
      '../src/services/app-process-registry',
      '../src/services/reverse-proxy',
    ].forEach(p => { delete require.cache[require.resolve(p)]; });
    MIGRATION = require('../src/migrations/0.5.0-app-store');
    ({ AppService } = require('../src/services/app'));

    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE apps (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
        status TEXT DEFAULT 'active', display_order INTEGER DEFAULT 0,
        color TEXT DEFAULT '#6366f1', icon TEXT, text_color TEXT DEFAULT '#ffffff',
        archived_at TEXT, app_type TEXT DEFAULT 'regular',
        created_at TEXT, updated_at TEXT
      );
      CREATE TABLE app_env_variables (
        id TEXT PRIMARY KEY,
        app_id TEXT REFERENCES apps(id) ON DELETE CASCADE,
        key TEXT NOT NULL, value TEXT NOT NULL,
        UNIQUE(app_id, key)
      );
    `);
    await MIGRATION.up({ db, logger: silentLogger });
  });

  afterEach(() => {
    db.close();
    if (prevHome === undefined) delete process.env.OS8_HOME;
    else process.env.OS8_HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function seedExternal(appId, slug = 'wm') {
    db.prepare(`
      INSERT INTO apps (id, name, slug, app_type, status) VALUES (?, ?, ?, 'external', 'active')
    `).run(appId, slug, slug);
    // Source tree
    const appDir = path.join(tmpHome, 'apps', appId);
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'package.json'), '{}\n');
    // Blob
    const blobDir = path.join(tmpHome, 'blob', appId);
    fs.mkdirSync(blobDir, { recursive: true });
    fs.writeFileSync(path.join(blobDir, 'data.bin'), 'data');
    // Per-app DB
    const dbDir = path.join(tmpHome, 'config', 'app_db');
    fs.mkdirSync(dbDir, { recursive: true });
    fs.writeFileSync(path.join(dbDir, `${appId}.db`), 'sqlite-pretend');
    // Secret
    db.prepare(`
      INSERT INTO app_env_variables (id, app_id, key, value) VALUES ('e1', ?, 'NEWS_API_KEY', 'real-key')
    `).run(appId);
  }

  it('default uninstall removes code, preserves data + status=uninstalled', async () => {
    seedExternal('e1');
    await AppService.uninstall(db, 'e1');

    const row = db.prepare(`SELECT status FROM apps WHERE id = 'e1'`).get();
    expect(row.status).toBe('uninstalled');

    expect(fs.existsSync(path.join(tmpHome, 'apps', 'e1'))).toBe(false);
    // Data preserved.
    expect(fs.existsSync(path.join(tmpHome, 'blob', 'e1'))).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, 'config', 'app_db', 'e1.db'))).toBe(true);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM app_env_variables WHERE app_id='e1'`).get().n).toBe(1);
  });

  it('with deleteData:true wipes blob, db, and per-app secrets', async () => {
    seedExternal('e2');
    await AppService.uninstall(db, 'e2', { deleteData: true });

    expect(fs.existsSync(path.join(tmpHome, 'apps', 'e2'))).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, 'blob', 'e2'))).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, 'config', 'app_db', 'e2.db'))).toBe(false);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM app_env_variables WHERE app_id='e2'`).get().n).toBe(0);
  });

  it('refuses to uninstall a regular app', async () => {
    db.prepare(`
      INSERT INTO apps (id, name, slug, app_type) VALUES ('reg-1', 'Reg', 'reg', 'regular')
    `).run();
    await expect(AppService.uninstall(db, 'reg-1')).rejects.toThrow(/external/);
  });

  it('throws on unknown app', async () => {
    await expect(AppService.uninstall(db, 'nope')).rejects.toThrow(/not found/);
  });

  it('survives a missing app dir (idempotent)', async () => {
    db.prepare(`
      INSERT INTO apps (id, name, slug, app_type) VALUES ('e3', 'NoDir', 'nodir', 'external')
    `).run();
    // No source tree — uninstall should still flip the status.
    await AppService.uninstall(db, 'e3');
    expect(db.prepare(`SELECT status FROM apps WHERE id='e3'`).get().status).toBe('uninstalled');
  });

  it('returns { ok, appId, dataDeleted }', async () => {
    seedExternal('e4');
    const r = await AppService.uninstall(db, 'e4', { deleteData: true });
    expect(r).toEqual({ ok: true, appId: 'e4', dataDeleted: true });
  });
});
