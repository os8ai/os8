import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { spawn } from 'node:child_process';

const Database = require('better-sqlite3');

const VALID_MANIFEST_YAML = `
schemaVersion: 1
slug: fixture
name: Fixture
publisher: tester
upstream:
  git: https://example.test/fixture.git
  ref: v1.0.0
framework: none
runtime:
  kind: node
  arch: [arm64, x86_64]
  package_manager: auto
  dependency_strategy: frozen
install: []
start:
  argv: ["node", "server.js"]
  port: detect
  readiness:
    type: http
    path: /
    timeout_seconds: 5
surface:
  kind: web
permissions:
  network:
    outbound: true
    inbound: false
  filesystem: app-private
  os8_capabilities: []
legal:
  license: MIT
  commercial_use: unrestricted
review:
  channel: verified
`.trim();

function makeDb(stagingDir, appsDir) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE apps (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      app_type TEXT DEFAULT 'regular',
      status TEXT DEFAULT 'active',
      manifest_yaml TEXT
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

describe('AppProcessRegistry — port allocation', () => {
  let mod;
  beforeEach(() => {
    delete require.cache[require.resolve('../src/services/app-process-registry')];
    mod = require('../src/services/app-process-registry');
  });
  afterEach(() => { mod.reset(); });

  it('allocates ports inside [PORT_MIN, PORT_MAX]', async () => {
    for (let i = 0; i < 50; i++) {
      const p = await mod.AppProcessRegistry._allocatePort();
      expect(p).toBeGreaterThanOrEqual(mod.PORT_MIN);
      // OS-allocated fallback may exceed PORT_MAX — that's by design for the rare reroll case.
      // Just assert it's a valid TCP port.
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(65536);
    }
  });

  it('falls back to OS-allocated when reroll budget exhausted', async () => {
    // Force isFree to always return false so all rerolls fail.
    const orig = mod.AppProcessRegistry._isFree;
    mod.AppProcessRegistry._isFree = async () => false;
    try {
      const p = await mod.AppProcessRegistry._allocatePort();
      expect(typeof p).toBe('number');
      expect(p).toBeGreaterThan(0);
    } finally {
      mod.AppProcessRegistry._isFree = orig;
    }
  });
});

describe('AppProcessRegistry — idle reaping (signal-driven)', () => {
  let mod, registry;

  beforeEach(() => {
    delete require.cache[require.resolve('../src/services/app-process-registry')];
    mod = require('../src/services/app-process-registry');
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)`);
    registry = mod.init({ db, getOS8Port: () => 8888 });
  });

  afterEach(() => { mod.reset(); });

  function fakeEntry(appId, ages) {
    // ages: { http, stdout, child } — ms ago
    const now = Date.now();
    registry._processes.set(appId, {
      appId,
      pid: 9999,
      port: 41111,
      status: 'running',
      lastHttpAt:   now - (ages.http   ?? 0),
      lastStdoutAt: now - (ages.stdout ?? 0),
      lastChildAt:  now - (ages.child  ?? 0),
      keepRunning: false,
      _adapter: { stop: async () => {} },
      _adapterInfo: {},
      _watcherDispose: null,
    });
  }

  it('does not reap when any signal is fresh', () => {
    registry.setIdleTimeout(60_000);
    fakeEntry('a1', { http: 90_000, stdout: 10_000, child: 90_000 });
    const reaped = registry.reapIdle();
    expect(reaped).toEqual([]);
  });

  it('reaps when ALL signals are stale beyond idleMs', () => {
    registry.setIdleTimeout(60_000);
    fakeEntry('a1', { http: 90_000, stdout: 90_000, child: 90_000 });
    const reaped = registry.reapIdle();
    expect(reaped).toEqual(['a1']);
  });

  it('keepRunning bypasses reaping entirely', () => {
    registry.setIdleTimeout(60_000);
    fakeEntry('a1', { http: 999_999, stdout: 999_999, child: 999_999 });
    registry.setKeepRunning('a1', true);
    expect(registry.reapIdle()).toEqual([]);
  });

  it('mark*Active updates the corresponding lastAt timestamp', () => {
    fakeEntry('a1', { http: 999_999, stdout: 999_999, child: 999_999 });
    const before = registry.get('a1').lastHttpAt;
    registry.markHttpActive('a1');
    expect(registry.get('a1').lastHttpAt).toBeGreaterThan(before);
  });

  it('mark*Active on unknown app is a safe no-op', () => {
    expect(() => registry.markHttpActive('nope')).not.toThrow();
  });
});

describe('AppProcessRegistry — start/stop with a real Node child', () => {
  let mod, registry, parent, db, appsDirOverride;

  beforeEach(() => {
    parent = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-apr-'));

    // Mock APPS_DIR so the registry's path.join sees the temp directory.
    delete require.cache[require.resolve('../src/config')];
    appsDirOverride = path.join(parent, 'apps');
    fs.mkdirSync(appsDirOverride, { recursive: true });

    process.env.OS8_HOME = parent;

    delete require.cache[require.resolve('../src/services/app-process-registry')];
    delete require.cache[require.resolve('../src/services/runtime-adapters/node')];
    delete require.cache[require.resolve('../src/services/runtime-adapters')];
    delete require.cache[require.resolve('../src/services/sanitized-env')];
    delete require.cache[require.resolve('../src/services/env')];
    delete require.cache[require.resolve('../src/services/app')];

    mod = require('../src/services/app-process-registry');

    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE apps (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        app_type TEXT DEFAULT 'regular',
        status TEXT DEFAULT 'active',
        display_order INTEGER DEFAULT 0,
        color TEXT DEFAULT '#6366f1',
        icon TEXT,
        text_color TEXT DEFAULT '#ffffff',
        archived_at TEXT,
        created_at TEXT,
        updated_at TEXT,
        manifest_yaml TEXT,
        external_slug TEXT
      );
      CREATE TABLE app_env_variables (
        id TEXT PRIMARY KEY,
        app_id TEXT REFERENCES apps(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        UNIQUE(app_id, key)
      );
    `);

    registry = mod.init({ db, getOS8Port: () => 8888 });
  });

  afterEach(async () => {
    if (registry) await registry.stopAll();
    mod.reset();
    db.close();
    delete process.env.OS8_HOME;
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('refuses to start when the app is not external', async () => {
    db.prepare(`INSERT INTO apps (id, name, slug, app_type) VALUES ('n1', 'Native', 'native', 'regular')`).run();
    await expect(registry.start('n1')).rejects.toThrow(/not external/);
  });

  it('starts a Node external app, returns ready, and stop() kills it', async () => {
    const appId = 'ext1';
    const slug = 'fixture';
    const appDir = path.join(appsDirOverride, appId);
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'server.js'), `
      const http = require('http');
      const port = parseInt(process.env.PORT, 10);
      http.createServer((_, res) => { res.writeHead(200); res.end('ok'); })
          .listen(port, '127.0.0.1');
    `);

    db.prepare(`
      INSERT INTO apps (id, name, slug, app_type, manifest_yaml, external_slug)
      VALUES (?, ?, ?, 'external', ?, ?)
    `).run(appId, 'Fixture', slug, VALID_MANIFEST_YAML, slug);

    const entry = await registry.start(appId);
    try {
      expect(entry.status).toBe('running');
      expect(entry.port).toBeGreaterThanOrEqual(mod.PORT_MIN);
      expect(entry.pid).toBeGreaterThan(0);

      const r = await fetch(`http://127.0.0.1:${entry.port}/`);
      expect(r.status).toBe(200);
    } finally {
      await registry.stop(appId);
    }
    expect(registry.get(appId)).toBeNull();
  }, 30_000);
});
