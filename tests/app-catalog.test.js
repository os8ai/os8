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
