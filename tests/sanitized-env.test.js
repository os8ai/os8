import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const Database = require('better-sqlite3');

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

function setupDb(MIGRATION) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE apps (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      app_type TEXT DEFAULT 'regular',
      status TEXT DEFAULT 'active'
    );
    CREATE TABLE env_variables (
      id TEXT PRIMARY KEY,
      key TEXT UNIQUE NOT NULL,
      value TEXT NOT NULL,
      description TEXT,
      encrypted INTEGER DEFAULT 0
    );
    CREATE TABLE app_env_variables (
      id TEXT PRIMARY KEY,
      app_id TEXT REFERENCES apps(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      UNIQUE(app_id, key)
    );
  `);
  return MIGRATION.up({ db, logger: silentLogger }).then(() => db);
}

describe('EnvService — per-app overload', () => {
  let db;
  let tmpHome;
  let prevHome;
  let MIGRATION;
  let EnvService;

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-env-'));
    prevHome = process.env.OS8_HOME;
    process.env.OS8_HOME = tmpHome;
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/migrations/0.5.0-app-store')];
    delete require.cache[require.resolve('../src/services/env')];
    MIGRATION = require('../src/migrations/0.5.0-app-store');
    EnvService = require('../src/services/env');
    db = await setupDb(MIGRATION);
    db.prepare('INSERT INTO apps (id, name, slug) VALUES (?, ?, ?)').run('a1', 'A1', 'a1');
  });

  afterEach(() => {
    db.close();
    if (prevHome === undefined) delete process.env.OS8_HOME;
    else process.env.OS8_HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('set with appId writes to app_env_variables, not env_variables', () => {
    EnvService.set(db, 'NEWS_API_KEY', 'secret-1', { appId: 'a1', description: 'newsapi.org' });
    expect(db.prepare('SELECT * FROM app_env_variables WHERE app_id = ?').all('a1')).toHaveLength(1);
    expect(db.prepare('SELECT * FROM env_variables WHERE key = ?').all('NEWS_API_KEY')).toHaveLength(0);
  });

  it('set without appId still writes to global env_variables', () => {
    EnvService.set(db, 'GLOBAL_KEY', 'global-value', 'a description');
    expect(db.prepare('SELECT key, value FROM env_variables WHERE key = ?').get('GLOBAL_KEY'))
      .toEqual({ key: 'GLOBAL_KEY', value: 'global-value' });
  });

  it('set with appId updates an existing per-app row in place', () => {
    EnvService.set(db, 'NEWS_API_KEY', 'v1', { appId: 'a1' });
    EnvService.set(db, 'NEWS_API_KEY', 'v2', { appId: 'a1' });
    const rows = db.prepare('SELECT key, value FROM app_env_variables WHERE app_id = ?').all('a1');
    expect(rows).toEqual([{ key: 'NEWS_API_KEY', value: 'v2' }]);
  });

  it('getAllForApp returns the per-app vars as an object', () => {
    EnvService.set(db, 'A', '1', { appId: 'a1' });
    EnvService.set(db, 'B', '2', { appId: 'a1' });
    expect(EnvService.getAllForApp(db, 'a1')).toEqual({ A: '1', B: '2' });
  });

  it('deleteForApp removes only the targeted row', () => {
    EnvService.set(db, 'A', '1', { appId: 'a1' });
    EnvService.set(db, 'B', '2', { appId: 'a1' });
    EnvService.deleteForApp(db, 'a1', 'A');
    expect(EnvService.getAllForApp(db, 'a1')).toEqual({ B: '2' });
  });
});

describe('buildSanitizedEnv', () => {
  let db;
  let tmpHome;
  let prevHome;
  let MIGRATION;
  let EnvService;
  let buildSanitizedEnv;

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-senv-'));
    prevHome = process.env.OS8_HOME;
    process.env.OS8_HOME = tmpHome;
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/migrations/0.5.0-app-store')];
    delete require.cache[require.resolve('../src/services/env')];
    delete require.cache[require.resolve('../src/services/sanitized-env')];
    MIGRATION = require('../src/migrations/0.5.0-app-store');
    EnvService = require('../src/services/env');
    ({ buildSanitizedEnv } = require('../src/services/sanitized-env'));
    db = await setupDb(MIGRATION);
    db.prepare('INSERT INTO apps (id, name, slug) VALUES (?, ?, ?)').run('a1', 'A1', 'worldmonitor');
  });

  afterEach(() => {
    db.close();
    if (prevHome === undefined) delete process.env.OS8_HOME;
    else process.env.OS8_HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('whitelists host vars and excludes API keys', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-fake-leak';
    process.env.OPENAI_API_KEY = 'sk-fake-leak';
    process.env.PATH = '/usr/local/bin:/usr/bin:/bin';
    process.env.HOME = '/home/test-user';

    try {
      const env = buildSanitizedEnv(db, {
        appId: 'a1', allocatedPort: 43217, manifestEnv: [],
        localSlug: 'worldmonitor', OS8_PORT: 8888,
      });
      expect(env.PATH).toBe('/usr/local/bin:/usr/bin:/bin');
      expect(env.HOME).toBe('/home/test-user');
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.OPENAI_API_KEY).toBeUndefined();
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('injects OS8_* vars and PORT', () => {
    const env = buildSanitizedEnv(db, {
      appId: 'a1', allocatedPort: 43217, manifestEnv: [],
      localSlug: 'worldmonitor', OS8_PORT: 8888,
    });
    expect(env.OS8_APP_ID).toBe('a1');
    expect(env.OS8_BASE_URL).toBe('http://localhost:8888');
    expect(env.OS8_API_BASE).toBe('http://worldmonitor.localhost:8888/_os8/api');
    expect(env.PORT).toBe('43217');
    expect(env.OS8_APP_DIR).toContain('apps');
    expect(env.OS8_APP_DIR).toContain('a1');
    expect(env.OS8_BLOB_DIR).toContain('blob');
  });

  it('merges manifest env entries', () => {
    const env = buildSanitizedEnv(db, {
      appId: 'a1', allocatedPort: 5173,
      manifestEnv: [{ name: 'VITE_DEV_PORT', value: '5173' }],
      localSlug: 'worldmonitor', OS8_PORT: 8888,
    });
    expect(env.VITE_DEV_PORT).toBe('5173');
  });

  it('merges per-app secrets', () => {
    EnvService.set(db, 'NEWS_API_KEY', 'real-key', { appId: 'a1' });
    const env = buildSanitizedEnv(db, {
      appId: 'a1', allocatedPort: 5173, manifestEnv: [],
      localSlug: 'worldmonitor', OS8_PORT: 8888,
    });
    expect(env.NEWS_API_KEY).toBe('real-key');
  });

  it('OS8-injected wins on collision: manifest cannot spoof OS8_APP_ID', () => {
    const env = buildSanitizedEnv(db, {
      appId: 'a1', allocatedPort: 5173,
      manifestEnv: [{ name: 'OS8_APP_ID', value: 'hacker-spoof' }],
      localSlug: 'worldmonitor', OS8_PORT: 8888,
    });
    expect(env.OS8_APP_ID).toBe('a1');
  });

  it('OS8-injected wins on collision: per-app secret cannot spoof OS8_APP_DIR', () => {
    EnvService.set(db, 'OS8_APP_DIR', '/tmp/hacker', { appId: 'a1' });
    const env = buildSanitizedEnv(db, {
      appId: 'a1', allocatedPort: 5173, manifestEnv: [],
      localSlug: 'worldmonitor', OS8_PORT: 8888,
    });
    expect(env.OS8_APP_DIR).not.toBe('/tmp/hacker');
    expect(env.OS8_APP_DIR).toContain('a1');
  });

  it('per-app secret overrides manifest env on non-OS8 collision (LOG_LEVEL)', () => {
    EnvService.set(db, 'LOG_LEVEL', 'debug', { appId: 'a1' });
    const env = buildSanitizedEnv(db, {
      appId: 'a1', allocatedPort: 5173,
      manifestEnv: [{ name: 'LOG_LEVEL', value: 'info' }],
      localSlug: 'worldmonitor', OS8_PORT: 8888,
    });
    expect(env.LOG_LEVEL).toBe('debug');
  });

  it('throws when required args are missing', () => {
    expect(() => buildSanitizedEnv(db, {
      allocatedPort: 5173, localSlug: 'foo', OS8_PORT: 8888,
    })).toThrow(/appId/);
    expect(() => buildSanitizedEnv(db, {
      appId: 'a1', allocatedPort: 5173, OS8_PORT: 8888,
    })).toThrow(/localSlug/);
  });

  it('does NOT inherit OS8_HOME, npm_config_*, or other host process env', () => {
    process.env.OS8_HOME = '/home/leo/os8';
    process.env.npm_config_registry = 'https://registry.npmjs.org/';
    process.env.NEW_RELIC_LICENSE = 'super-secret';

    try {
      const env = buildSanitizedEnv(db, {
        appId: 'a1', allocatedPort: 5173, manifestEnv: [],
        localSlug: 'worldmonitor', OS8_PORT: 8888,
      });
      expect(env.OS8_HOME).toBeUndefined();
      expect(env.npm_config_registry).toBeUndefined();
      expect(env.NEW_RELIC_LICENSE).toBeUndefined();
    } finally {
      delete process.env.npm_config_registry;
      delete process.env.NEW_RELIC_LICENSE;
    }
  });
});
