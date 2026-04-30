import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const Database = require('better-sqlite3');

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

function makeDbWithMigration() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE apps (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'active',
      app_type TEXT DEFAULT 'regular'
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

const WORLDMONITOR_YAML = `
schemaVersion: 1
slug: worldmonitor
name: World Monitor
publisher: koala73
description: Real-time global intelligence dashboard.
upstream:
  git: https://github.com/koala73/worldmonitor.git
  ref: v2.5.23
framework: vite
runtime:
  kind: node
  version: "20"
  arch: [arm64, x86_64]
  package_manager: auto
  dependency_strategy: frozen
install:
  - argv: ["npm", "ci"]
start:
  argv: ["npm", "run", "dev"]
  port: detect
  readiness:
    type: http
    path: /
surface:
  kind: web
permissions:
  network:
    outbound: true
    inbound: false
  filesystem: app-private
  os8_capabilities: []
legal:
  license: AGPL-3.0
  commercial_use: restricted
review:
  channel: verified
`.trim();

function makeListing(overrides = {}) {
  return {
    id: 'wm-1',
    slug: 'worldmonitor',
    name: 'World Monitor',
    description: 'Real-time global intelligence dashboard.',
    publisher: 'koala73',
    channel: 'verified',
    category: 'intelligence',
    iconUrl: 'https://raw.githubusercontent.com/koala73/worldmonitor/v2.5.23/new-world-monitor.png',
    screenshots: [],
    manifestSha: 'sha-1',
    catalogCommitSha: 'cat-sha-1',
    upstreamDeclaredRef: 'v2.5.23',
    upstreamResolvedCommit: 'e51058e1765ef2f0c83ccb1d08d984bc59d23f10',
    license: 'AGPL-3.0-only',
    runtimeKind: 'node',
    framework: 'vite',
    architectures: ['arm64', 'x86_64'],
    riskLevel: 'low',
    installCount: 0,
    rating: null,
    ...overrides,
  };
}

function mockFetchOnce(impl) {
  const original = global.fetch;
  global.fetch = impl;
  return () => { global.fetch = original; };
}

function makeBaseDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE apps (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'active', app_type TEXT DEFAULT 'regular'
    );
    CREATE TABLE app_env_variables (
      id TEXT PRIMARY KEY, app_id TEXT REFERENCES apps(id) ON DELETE CASCADE,
      key TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(app_id, key)
    );
  `);
  return db;
}

describe('AppCatalogService.sync', () => {
  let db, tmpHome, prevHome, MIGRATION, AppCatalogService, restoreFetch;

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-cat-sync-'));
    prevHome = process.env.OS8_HOME;
    process.env.OS8_HOME = tmpHome;
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/migrations/0.5.0-app-store')];
    delete require.cache[require.resolve('../src/services/app-catalog')];
    MIGRATION = require('../src/migrations/0.5.0-app-store');
    AppCatalogService = require('../src/services/app-catalog');
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE apps (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
        status TEXT DEFAULT 'active', app_type TEXT DEFAULT 'regular'
      );
      CREATE TABLE app_env_variables (
        id TEXT PRIMARY KEY, app_id TEXT REFERENCES apps(id) ON DELETE CASCADE,
        key TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(app_id, key)
      );
    `);
    await MIGRATION.up({ db, logger: silentLogger });
  });

  afterEach(() => {
    if (restoreFetch) { restoreFetch(); restoreFetch = null; }
    db.close();
    if (prevHome === undefined) delete process.env.OS8_HOME;
    else process.env.OS8_HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('empty response yields zero counts', async () => {
    restoreFetch = mockFetchOnce(async () => new Response(JSON.stringify({ apps: [] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const r = await AppCatalogService.sync(db);
    expect(r).toMatchObject({ synced: 0, added: 0, updated: 0, removed: 0 });
  });

  it('adds new entries on first sync', async () => {
    restoreFetch = mockFetchOnce(async () => new Response(
      JSON.stringify({ apps: [makeListing()] }), { status: 200 }));
    const r = await AppCatalogService.sync(db);
    expect(r.added).toBe(1);
    expect(r.updated).toBe(0);
    const row = db.prepare(`SELECT slug, manifest_sha FROM app_catalog WHERE slug='worldmonitor'`).get();
    expect(row).toEqual({ slug: 'worldmonitor', manifest_sha: 'sha-1' });
  });

  it('FTS triggers index rows added by sync', async () => {
    restoreFetch = mockFetchOnce(async () => new Response(
      JSON.stringify({ apps: [makeListing()] }), { status: 200 }));
    await AppCatalogService.sync(db);
    const hits = db.prepare(
      `SELECT slug FROM app_catalog_fts WHERE app_catalog_fts MATCH 'worldmonitor'`
    ).all();
    expect(hits).toHaveLength(1);
  });

  it('skips unchanged rows on re-sync (manifestSha + catalogCommitSha match)', async () => {
    restoreFetch = mockFetchOnce(async () => new Response(
      JSON.stringify({ apps: [makeListing()] }), { status: 200 }));
    await AppCatalogService.sync(db);

    restoreFetch && restoreFetch();
    restoreFetch = mockFetchOnce(async () => new Response(
      JSON.stringify({ apps: [makeListing()] }), { status: 200 }));
    const r = await AppCatalogService.sync(db);
    expect(r.added).toBe(0);
    expect(r.updated).toBe(0);
    expect(r.unchanged).toBe(1);
  });

  it('updates existing rows when manifest_sha changes', async () => {
    restoreFetch = mockFetchOnce(async () => new Response(
      JSON.stringify({ apps: [makeListing()] }), { status: 200 }));
    await AppCatalogService.sync(db);

    restoreFetch && restoreFetch();
    restoreFetch = mockFetchOnce(async () => new Response(
      JSON.stringify({ apps: [makeListing({ manifestSha: 'sha-2', name: 'World Monitor v2' })] }),
      { status: 200 }));
    const r = await AppCatalogService.sync(db);
    expect(r.added).toBe(0);
    expect(r.updated).toBe(1);
    const row = db.prepare(`SELECT name, manifest_sha FROM app_catalog WHERE slug='worldmonitor'`).get();
    expect(row).toEqual({ name: 'World Monitor v2', manifest_sha: 'sha-2' });
  });

  it('soft-deletes rows missing from a later sync', async () => {
    restoreFetch = mockFetchOnce(async () => new Response(
      JSON.stringify({ apps: [makeListing()] }), { status: 200 }));
    await AppCatalogService.sync(db);

    restoreFetch && restoreFetch();
    restoreFetch = mockFetchOnce(async () => new Response(
      JSON.stringify({ apps: [] }), { status: 200 }));
    const r = await AppCatalogService.sync(db);
    expect(r.removed).toBe(1);
    const row = db.prepare(`SELECT deleted_at FROM app_catalog WHERE slug='worldmonitor'`).get();
    expect(row.deleted_at).not.toBeNull();
  });

  it('reports alarms when fetch fails', async () => {
    restoreFetch = mockFetchOnce(async () => { throw new Error('boom'); });
    const r = await AppCatalogService.sync(db);
    expect(r.alarms.length).toBeGreaterThan(0);
    expect(r.alarms[0]).toMatch(/fetch failed/);
  });

  it('reports alarm on non-2xx', async () => {
    restoreFetch = mockFetchOnce(async () => new Response('', { status: 500 }));
    const r = await AppCatalogService.sync(db);
    expect(r.alarms[0]).toMatch(/500/);
  });
});

describe('AppCatalogService.search', () => {
  let db, tmpHome, prevHome, MIGRATION, AppCatalogService;

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-cat-search-'));
    prevHome = process.env.OS8_HOME;
    process.env.OS8_HOME = tmpHome;
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/migrations/0.5.0-app-store')];
    delete require.cache[require.resolve('../src/services/app-catalog')];
    MIGRATION = require('../src/migrations/0.5.0-app-store');
    AppCatalogService = require('../src/services/app-catalog');
    db = makeBaseDb();
    await MIGRATION.up({ db, logger: silentLogger });

    db.prepare(`
      INSERT INTO app_catalog (id, slug, name, description, publisher, channel, category,
        manifest_sha, catalog_commit_sha, upstream_declared_ref, upstream_resolved_commit,
        framework, install_count
      ) VALUES
        ('a','worldmonitor','World Monitor','Global dashboard','koala73','verified','intelligence','sha1','c1','v1','aaaa','vite',5),
        ('b','newscube','News Cube','News aggregator','foo','verified','media','sha2','c2','v1','bbbb','nextjs',1),
        ('c','codecanvas','Code Canvas','Drawing for devs','bar','community','dev-tools','sha3','c3','v1','cccc','vite',9)
    `).run();
  });

  afterEach(() => {
    db.close();
    if (prevHome === undefined) delete process.env.OS8_HOME;
    else process.env.OS8_HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('finds rows by FTS prefix match', () => {
    const out = AppCatalogService.search(db, 'world');
    expect(out.map(e => e.slug)).toContain('worldmonitor');
  });

  it('filters on channel', () => {
    const out = AppCatalogService.search(db, 'canvas', { channel: 'verified' });
    expect(out).toHaveLength(0);
    const ok = AppCatalogService.search(db, 'canvas', { channel: 'community' });
    expect(ok.map(e => e.slug)).toContain('codecanvas');
  });

  it('filters on framework', () => {
    const out = AppCatalogService.search(db, 'world', { framework: 'vite' });
    expect(out.map(e => e.slug)).toContain('worldmonitor');
    const empty = AppCatalogService.search(db, 'world', { framework: 'nextjs' });
    expect(empty).toHaveLength(0);
  });

  it('falls back to LIKE when query empty', () => {
    const out = AppCatalogService.search(db, '', { limit: 10 });
    // Includes all non-deleted entries; ordered by install_count DESC.
    expect(out[0].slug).toBe('codecanvas');
  });

  it('omits soft-deleted rows', () => {
    db.prepare(`UPDATE app_catalog SET deleted_at = datetime('now') WHERE slug = 'worldmonitor'`).run();
    const out = AppCatalogService.search(db, 'world');
    expect(out.map(e => e.slug)).not.toContain('worldmonitor');
  });
});

describe('AppCatalogService.get with lazy hydration', () => {
  let db, tmpHome, prevHome, MIGRATION, AppCatalogService, restoreFetch;

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-cat-get-'));
    prevHome = process.env.OS8_HOME;
    process.env.OS8_HOME = tmpHome;
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/migrations/0.5.0-app-store')];
    delete require.cache[require.resolve('../src/services/app-catalog')];
    MIGRATION = require('../src/migrations/0.5.0-app-store');
    AppCatalogService = require('../src/services/app-catalog');
    db = makeBaseDb();
    await MIGRATION.up({ db, logger: silentLogger });
  });

  afterEach(() => {
    if (restoreFetch) { restoreFetch(); restoreFetch = null; }
    db.close();
    if (prevHome === undefined) delete process.env.OS8_HOME;
    else process.env.OS8_HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('lazy-fetches manifest_yaml when row exists with NULL yaml', async () => {
    db.prepare(`
      INSERT INTO app_catalog (id, slug, name, channel, manifest_sha,
        catalog_commit_sha, upstream_declared_ref, upstream_resolved_commit
      ) VALUES ('id1', 'lazyapp', 'Lazy', 'verified', 's1', 'c1', 'v1.0.0',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    `).run();

    const yaml = `slug: lazyapp\nname: Lazy\n`;
    restoreFetch = mockFetchOnce(async () => new Response(
      JSON.stringify({ app: { manifestYaml: yaml } }), { status: 200 }));

    const entry = await AppCatalogService.get(db, 'lazyapp');
    expect(entry.manifestYaml).toBe(yaml);
    // Cached back into the row.
    const stored = db.prepare(`SELECT manifest_yaml FROM app_catalog WHERE slug='lazyapp'`).get();
    expect(stored.manifest_yaml).toBe(yaml);
  });

  it('returns the entry without manifest when fetch fails', async () => {
    db.prepare(`
      INSERT INTO app_catalog (id, slug, name, channel, manifest_sha,
        catalog_commit_sha, upstream_declared_ref, upstream_resolved_commit
      ) VALUES ('id2', 'offline', 'Off', 'verified', 's', 'c', 'v', ?)
    `).run('a'.repeat(40));
    restoreFetch = mockFetchOnce(async () => { throw new Error('offline'); });
    const entry = await AppCatalogService.get(db, 'offline');
    expect(entry).not.toBeNull();
    expect(entry.manifest).toBeNull();
  });
});

describe('AppCatalogService.fetchManifest', () => {
  let restoreFetch;
  let AppCatalogService;
  beforeEach(() => {
    delete require.cache[require.resolve('../src/services/app-catalog')];
    AppCatalogService = require('../src/services/app-catalog');
  });
  afterEach(() => { if (restoreFetch) restoreFetch(); });

  it('throws on 404', async () => {
    restoreFetch = mockFetchOnce(async () => new Response('', { status: 404 }));
    await expect(AppCatalogService.fetchManifest('nope')).rejects.toThrow(/not found/);
  });

  it('throws on 5xx', async () => {
    restoreFetch = mockFetchOnce(async () => new Response('', { status: 503 }));
    await expect(AppCatalogService.fetchManifest('x')).rejects.toThrow(/503/);
  });

  it('returns the parsed app on success', async () => {
    restoreFetch = mockFetchOnce(async () => new Response(
      JSON.stringify({ app: { slug: 'x', manifestYaml: 'slug: x\n' } }),
      { status: 200 }));
    const r = await AppCatalogService.fetchManifest('x');
    expect(r).toEqual({ slug: 'x', manifestYaml: 'slug: x\n' });
  });
});

describe('AppCatalogService.seedFromSnapshot', () => {
  let db, tmpHome, prevHome, MIGRATION, AppCatalogService;
  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-cat-seed-'));
    prevHome = process.env.OS8_HOME;
    process.env.OS8_HOME = tmpHome;
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/migrations/0.5.0-app-store')];
    delete require.cache[require.resolve('../src/services/app-catalog')];
    MIGRATION = require('../src/migrations/0.5.0-app-store');
    AppCatalogService = require('../src/services/app-catalog');
    db = makeBaseDb();
    await MIGRATION.up({ db, logger: silentLogger });
  });
  afterEach(() => {
    db.close();
    if (prevHome === undefined) delete process.env.OS8_HOME;
    else process.env.OS8_HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns 0 against empty bundled snapshot (default)', () => {
    expect(AppCatalogService.seedFromSnapshot(db)).toBe(0);
  });

  it('is a no-op when the table already has rows', () => {
    db.prepare(`
      INSERT INTO app_catalog (id, slug, name, channel, manifest_sha,
        catalog_commit_sha, upstream_declared_ref, upstream_resolved_commit
      ) VALUES ('x', 'x', 'X', 'verified', 's', 'c', 'v', ?)
    `).run('a'.repeat(40));
    expect(AppCatalogService.seedFromSnapshot(db)).toBe(0);
  });
});

describe('AppCatalogService.get', () => {
  let db;
  let tmpHome;
  let prevHome;
  let MIGRATION;
  let AppCatalogService;

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-catalog-'));
    prevHome = process.env.OS8_HOME;
    process.env.OS8_HOME = tmpHome;
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/migrations/0.5.0-app-store')];
    delete require.cache[require.resolve('../src/services/app-catalog')];
    MIGRATION = require('../src/migrations/0.5.0-app-store');
    AppCatalogService = require('../src/services/app-catalog');
    db = makeDbWithMigration();
    await MIGRATION.up({ db, logger: silentLogger });
  });

  afterEach(() => {
    db.close();
    if (prevHome === undefined) delete process.env.OS8_HOME;
    else process.env.OS8_HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function insertWorldmonitor() {
    db.prepare(`
      INSERT INTO app_catalog (
        id, slug, name, description, publisher, channel, category,
        manifest_yaml, manifest_sha, catalog_commit_sha,
        upstream_declared_ref, upstream_resolved_commit,
        license, runtime_kind, framework, architectures, risk_level,
        install_count, synced_at
      ) VALUES (
        'wm-1', 'worldmonitor', 'World Monitor', 'Real-time dashboard.',
        'koala73', 'verified', 'intelligence',
        ?, 'sha-1', 'cat-sha-1', 'v2.5.23',
        'e51058e1765ef2f0c83ccb1d08d984bc59d23f10',
        'AGPL-3.0', 'node', 'vite', '["arm64","x86_64"]',
        'low', 0, datetime('now')
      )
    `).run(WORLDMONITOR_YAML);
  }

  it('returns null for a missing slug', async () => {
    const e = await AppCatalogService.get(db, 'nonexistent');
    expect(e).toBeNull();
  });

  it('returns the entry with parsed manifest for a found slug', async () => {
    insertWorldmonitor();
    const e = await AppCatalogService.get(db, 'worldmonitor');
    expect(e).not.toBeNull();
    expect(e.slug).toBe('worldmonitor');
    expect(e.publisher).toBe('koala73');
    expect(e.upstreamResolvedCommit).toBe('e51058e1765ef2f0c83ccb1d08d984bc59d23f10');
    expect(e.architectures).toEqual(['arm64', 'x86_64']);
    expect(e.manifest).not.toBeNull();
    expect(e.manifest.slug).toBe('worldmonitor');
    expect(e.manifest.runtime.kind).toBe('node');
  });

  it('respects channel filter — same slug under a different channel is invisible', async () => {
    insertWorldmonitor();
    const e = await AppCatalogService.get(db, 'worldmonitor', { channel: 'community' });
    expect(e).toBeNull();
  });

  it('skips soft-deleted rows', async () => {
    insertWorldmonitor();
    db.prepare(`UPDATE app_catalog SET deleted_at = datetime('now') WHERE slug = 'worldmonitor'`).run();
    const e = await AppCatalogService.get(db, 'worldmonitor');
    expect(e).toBeNull();
  });

  it('rowToEntry handles null manifest_yaml gracefully', async () => {
    db.prepare(`
      INSERT INTO app_catalog (
        id, slug, name, channel,
        manifest_sha, catalog_commit_sha,
        upstream_declared_ref, upstream_resolved_commit
      ) VALUES (
        'no-yaml-1', 'noyaml', 'No YAML', 'verified',
        'sha', 'cat', 'v0.1.0',
        '0000000000000000000000000000000000000000'
      )
    `).run();
    const e = await AppCatalogService.get(db, 'noyaml');
    expect(e).not.toBeNull();
    expect(e.manifest).toBeNull();
  });
});
