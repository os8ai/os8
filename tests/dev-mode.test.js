import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const Database = require('better-sqlite3');
const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

describe('AppService.setDevMode (PR 1.22)', () => {
  let db, tmpHome, prevHome, MIGRATION, AppService;

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-dev-mode-'));
    prevHome = process.env.OS8_HOME;
    process.env.OS8_HOME = tmpHome;
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/migrations/0.5.0-app-store')];
    delete require.cache[require.resolve('../src/services/app')];
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

  it('toggles dev_mode on an external app', () => {
    db.prepare(`
      INSERT INTO apps (id, name, slug, app_type) VALUES ('e1', 'Ext', 'ext', 'external')
    `).run();
    expect(AppService.setDevMode(db, 'e1', true).dev_mode).toBe(1);
    expect(AppService.setDevMode(db, 'e1', false).dev_mode).toBe(0);
  });

  it('refuses to set dev_mode on a regular app', () => {
    db.prepare(`
      INSERT INTO apps (id, name, slug, app_type) VALUES ('r1', 'Reg', 'reg', 'regular')
    `).run();
    expect(() => AppService.setDevMode(db, 'r1', true)).toThrow(/external/);
  });

  it('throws on unknown app', () => {
    expect(() => AppService.setDevMode(db, 'nope', true)).toThrow(/not found/);
  });

  it('updates updated_at when toggled', () => {
    db.prepare(`
      INSERT INTO apps (id, name, slug, app_type, updated_at)
      VALUES ('e1', 'Ext', 'ext', 'external', '2020-01-01')
    `).run();
    AppService.setDevMode(db, 'e1', true);
    const after = db.prepare(`SELECT updated_at FROM apps WHERE id='e1'`).get();
    expect(after.updated_at).not.toBe('2020-01-01');
  });
});

describe('AppProcessRegistry idle timeout from settings (PR 1.22)', () => {
  let db, tmpHome, prevHome, MIGRATION, mod;

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-idle-'));
    prevHome = process.env.OS8_HOME;
    process.env.OS8_HOME = tmpHome;
    [
      '../src/config',
      '../src/migrations/0.5.0-app-store',
      '../src/services/app-process-registry',
    ].forEach(p => { delete require.cache[require.resolve(p)]; });
    MIGRATION = require('../src/migrations/0.5.0-app-store');
    mod = require('../src/services/app-process-registry');

    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE apps (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
        status TEXT, app_type TEXT DEFAULT 'regular', manifest_yaml TEXT
      );
      CREATE TABLE app_env_variables (
        id TEXT PRIMARY KEY, app_id TEXT REFERENCES apps(id) ON DELETE CASCADE,
        key TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(app_id, key)
      );
    `);
    await MIGRATION.up({ db, logger: silentLogger });
  });

  afterEach(() => {
    mod.reset();
    db.close();
    if (prevHome === undefined) delete process.env.OS8_HOME;
    else process.env.OS8_HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('uses 30 min default when settings is empty', () => {
    const reg = mod.init({ db, getOS8Port: () => 8888 });
    expect(reg.idleMs).toBe(mod.DEFAULT_IDLE_MS);
  });

  it('reads external_app_idle_timeout_ms from settings', () => {
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`)
      .run('external_app_idle_timeout_ms', '900000');   // 15 min
    const reg = mod.init({ db, getOS8Port: () => 8888 });
    expect(reg.idleMs).toBe(900000);
  });

  it('treats 0 as "never reap" (Number.MAX_SAFE_INTEGER)', () => {
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`)
      .run('external_app_idle_timeout_ms', '0');
    const reg = mod.init({ db, getOS8Port: () => 8888 });
    expect(reg.idleMs).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('falls back to default on garbage', () => {
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`)
      .run('external_app_idle_timeout_ms', 'never');
    const reg = mod.init({ db, getOS8Port: () => 8888 });
    expect(reg.idleMs).toBe(mod.DEFAULT_IDLE_MS);
  });
});
