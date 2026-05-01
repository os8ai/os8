/**
 * Phase 3 PR 3.1 — AppInstaller.startFromManifest integration.
 *
 * Mirrors tests/app-installer.test.js's setup (in-memory DB, fake upstream
 * git repo, migration applied) and exercises the dev-import entry point:
 *   - startFromManifest inserts a synthetic app_catalog row (channel='developer-import')
 *     and kicks off `_run` which clones from the fake upstream
 *   - Validation rejects non-developer-import manifests + non-SHA commits
 *   - reapDeveloperImportOrphans only removes rows with no apps + no in-flight
 *     job referencing them (and respects the 24h cutoff in the no-slug form).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'node:child_process';

const Database = require('better-sqlite3');
const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

function makeDb() {
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

function makeFakeUpstream(rootDir) {
  const repoDir = path.join(rootDir, 'fake-upstream');
  fs.mkdirSync(repoDir, { recursive: true });
  spawnSync('git', ['init', '--initial-branch=main'], { cwd: repoDir });
  spawnSync('git', ['config', 'user.email', 'tester@example.com'], { cwd: repoDir });
  spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# fixture\n');
  fs.writeFileSync(path.join(repoDir, 'package.json'), '{"name":"fix","version":"0.0.0","scripts":{"dev":"vite"},"dependencies":{"vite":"^5.0.0"}}\n');
  spawnSync('git', ['add', '.'], { cwd: repoDir });
  spawnSync('git', ['commit', '-m', 'initial'], { cwd: repoDir });
  spawnSync('git', ['config', 'uploadpack.allowReachableSHA1InWant', 'true'], { cwd: repoDir });
  spawnSync('git', ['config', 'uploadpack.allowAnySHA1InWant', 'true'], { cwd: repoDir });
  spawnSync('git', ['config', 'receive.denyCurrentBranch', 'ignore'], { cwd: repoDir });
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).stdout.toString().trim();
  return { url: repoDir, sha: head };
}

function devImportManifest({ slug, gitUrl, ref }) {
  return {
    schemaVersion: 1,
    slug,
    name: slug,
    publisher: 'tester',
    description: `imported ${slug}`,
    upstream: { git: gitUrl, ref },
    framework: 'vite',
    runtime: { kind: 'node', arch: ['arm64', 'x86_64'], package_manager: 'npm', dependency_strategy: 'best-effort' },
    install: [{ argv: ['npm', 'install', '--ignore-scripts'] }],
    start: { argv: ['npm', 'run', 'dev'], port: 'detect', readiness: { type: 'http', path: '/' } },
    surface: { kind: 'web' },
    permissions: { network: { outbound: false, inbound: false }, filesystem: 'app-private', os8_capabilities: [], secrets: [] },
    legal: { license: 'MIT', commercial_use: 'restricted' },
    review: { channel: 'developer-import', risk: 'high' },
  };
}

describe('AppInstaller.startFromManifest', () => {
  let db, tmpHome, prevHome, MIGRATION, AppInstaller, AppCatalogService, InstallJobs;
  let upstream;

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-devimp-'));
    prevHome = process.env.OS8_HOME;
    process.env.OS8_HOME = tmpHome;
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/migrations/0.5.0-app-store')];
    delete require.cache[require.resolve('../src/services/app-installer')];
    delete require.cache[require.resolve('../src/services/app-catalog')];
    delete require.cache[require.resolve('../src/services/app-install-jobs')];
    MIGRATION = require('../src/migrations/0.5.0-app-store');
    AppInstaller = require('../src/services/app-installer');
    AppCatalogService = require('../src/services/app-catalog');
    InstallJobs = require('../src/services/app-install-jobs');
    db = makeDb();
    await MIGRATION.up({ db, logger: silentLogger });

    upstream = makeFakeUpstream(tmpHome);
  });

  afterEach(() => {
    db.close();
    if (prevHome === undefined) delete process.env.OS8_HOME;
    else process.env.OS8_HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    AppInstaller._review = null;
  });

  it('rejects non-developer-import channel', async () => {
    const m = devImportManifest({ slug: 'x', gitUrl: upstream.url, ref: upstream.sha });
    m.review.channel = 'verified';
    await expect(AppInstaller.startFromManifest(db, {
      manifest: m, upstreamResolvedCommit: upstream.sha,
    })).rejects.toThrow(/only valid for developer-import/);
  });

  it('rejects non-SHA upstreamResolvedCommit', async () => {
    const m = devImportManifest({ slug: 'x', gitUrl: upstream.url, ref: 'main' });
    await expect(AppInstaller.startFromManifest(db, {
      manifest: m, upstreamResolvedCommit: 'main',
    })).rejects.toThrow(/40-char SHA/);
  });

  it('inserts a synthetic catalog row and drives state machine to awaiting_approval', async () => {
    AppInstaller._review = async () => ({ riskLevel: 'medium', findings: [], summary: 'mocked' });

    const m = devImportManifest({ slug: 'fix-vite', gitUrl: upstream.url, ref: upstream.sha });
    const job = await AppInstaller.startFromManifest(db, {
      manifest: m, upstreamResolvedCommit: upstream.sha,
    });
    expect(job.status).toBe('pending');

    // Verify the synthetic row landed.
    const row = db.prepare(`SELECT * FROM app_catalog WHERE slug = ?`).get('fix-vite');
    expect(row).toBeDefined();
    expect(row.channel).toBe('developer-import');
    expect(row.upstream_resolved_commit).toBe(upstream.sha);

    for (let i = 0; i < 50; i++) {
      const cur = InstallJobs.get(db, job.id);
      if (cur.status === 'awaiting_approval' || cur.status === 'failed') break;
      await new Promise(r => setTimeout(r, 100));
    }
    const final = InstallJobs.get(db, job.id);
    expect(final.status).toBe('awaiting_approval');
    expect(final.channel).toBe('developer-import');
    expect(fs.existsSync(path.join(final.staging_dir, 'README.md'))).toBe(true);
  });

  it('re-importing the same slug ON CONFLICT updates the row in place', async () => {
    AppInstaller._review = async () => ({ riskLevel: 'low', findings: [], summary: 'ok' });

    const m1 = devImportManifest({ slug: 'reimport', gitUrl: upstream.url, ref: upstream.sha });
    const job1 = await AppInstaller.startFromManifest(db, { manifest: m1, upstreamResolvedCommit: upstream.sha });

    // Drain the first job's _run before kicking the second so the second's
    // catalog INSERT actually exercises ON CONFLICT.
    for (let i = 0; i < 50; i++) {
      const cur = InstallJobs.get(db, job1.id);
      if (cur.status === 'awaiting_approval' || cur.status === 'failed') break;
      await new Promise(r => setTimeout(r, 100));
    }

    const before = db.prepare(`SELECT manifest_sha, manifest_yaml FROM app_catalog WHERE slug = ?`).get('reimport');

    const m2 = { ...m1, description: 'updated description' };
    const job2 = await AppInstaller.startFromManifest(db, { manifest: m2, upstreamResolvedCommit: upstream.sha });

    for (let i = 0; i < 50; i++) {
      const cur = InstallJobs.get(db, job2.id);
      if (cur.status === 'awaiting_approval' || cur.status === 'failed') break;
      await new Promise(r => setTimeout(r, 100));
    }

    const after = db.prepare(`SELECT manifest_sha, manifest_yaml FROM app_catalog WHERE slug = ?`).get('reimport');
    expect(after.manifest_yaml).not.toBe(before.manifest_yaml);
    expect(after.manifest_yaml).toMatch(/updated description/);
    // Still exactly one row.
    const count = db.prepare(`SELECT COUNT(*) as n FROM app_catalog WHERE slug = ?`).get('reimport');
    expect(count.n).toBe(1);
  });
});

describe('AppCatalogService.reapDeveloperImportOrphans', () => {
  let db, tmpHome, prevHome, AppCatalogService, MIGRATION;

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-reaper-'));
    prevHome = process.env.OS8_HOME;
    process.env.OS8_HOME = tmpHome;
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/migrations/0.5.0-app-store')];
    delete require.cache[require.resolve('../src/services/app-catalog')];
    MIGRATION = require('../src/migrations/0.5.0-app-store');
    AppCatalogService = require('../src/services/app-catalog');
    db = makeDb();
    db.exec(`ALTER TABLE apps ADD COLUMN external_slug TEXT`);
    await MIGRATION.up({ db, logger: silentLogger });
  });

  afterEach(() => {
    db.close();
    if (prevHome === undefined) delete process.env.OS8_HOME;
    else process.env.OS8_HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function insertCatalogRow({ slug, channel, syncedAt }) {
    db.prepare(`
      INSERT INTO app_catalog (
        id, slug, name, channel, manifest_sha, catalog_commit_sha,
        upstream_declared_ref, upstream_resolved_commit, synced_at
      ) VALUES (?, ?, ?, ?, 'sha', 'cat', 'v0', 'commit', ?)
    `).run(`row-${slug}`, slug, slug, channel, syncedAt);
  }

  it('removes dev-import rows with no installed app + no active job + older than cutoff', () => {
    const old = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    insertCatalogRow({ slug: 'orphan', channel: 'developer-import', syncedAt: old });
    const r = AppCatalogService.reapDeveloperImportOrphans(db);
    expect(r.removed).toBe(1);
    expect(db.prepare(`SELECT COUNT(*) as n FROM app_catalog WHERE slug = ?`).get('orphan').n).toBe(0);
  });

  it('preserves rows newer than cutoff', () => {
    const fresh = new Date(Date.now() - 60 * 1000).toISOString();   // 1 min ago
    insertCatalogRow({ slug: 'fresh', channel: 'developer-import', syncedAt: fresh });
    const r = AppCatalogService.reapDeveloperImportOrphans(db);
    expect(r.removed).toBe(0);
  });

  it('preserves rows referenced by an active install job', () => {
    const old = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    insertCatalogRow({ slug: 'active', channel: 'developer-import', syncedAt: old });
    db.prepare(`
      INSERT INTO app_install_jobs (id, external_slug, upstream_resolved_commit, channel, status, created_at, updated_at)
      VALUES ('j1', 'active', ?, 'developer-import', 'awaiting_approval', datetime('now'), datetime('now'))
    `).run('a'.repeat(40));
    const r = AppCatalogService.reapDeveloperImportOrphans(db);
    expect(r.removed).toBe(0);
  });

  it('preserves rows referenced by an installed apps row (external_slug match)', () => {
    const old = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    insertCatalogRow({ slug: 'installed', channel: 'developer-import', syncedAt: old });
    db.prepare(`INSERT INTO apps (id, name, slug, external_slug) VALUES (?, ?, ?, ?)`)
      .run('app-1', 'Installed', 'local-installed', 'installed');
    const r = AppCatalogService.reapDeveloperImportOrphans(db);
    expect(r.removed).toBe(0);
  });

  it('does not touch verified-channel rows', () => {
    const old = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    insertCatalogRow({ slug: 'v', channel: 'verified', syncedAt: old });
    const r = AppCatalogService.reapDeveloperImportOrphans(db);
    expect(r.removed).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) as n FROM app_catalog WHERE slug = ?`).get('v').n).toBe(1);
  });

  it('eager same-session form (slug arg) bypasses time cutoff', () => {
    const fresh = new Date(Date.now() - 60 * 1000).toISOString();
    insertCatalogRow({ slug: 'cancelled-now', channel: 'developer-import', syncedAt: fresh });
    const r = AppCatalogService.reapDeveloperImportOrphans(db, { slug: 'cancelled-now' });
    expect(r.removed).toBe(1);
  });

  it('eager same-session form respects active-job guard', () => {
    const fresh = new Date(Date.now() - 60 * 1000).toISOString();
    insertCatalogRow({ slug: 'in-flight', channel: 'developer-import', syncedAt: fresh });
    db.prepare(`
      INSERT INTO app_install_jobs (id, external_slug, upstream_resolved_commit, channel, status, created_at, updated_at)
      VALUES ('j2', 'in-flight', ?, 'developer-import', 'reviewing', datetime('now'), datetime('now'))
    `).run('a'.repeat(40));
    const r = AppCatalogService.reapDeveloperImportOrphans(db, { slug: 'in-flight' });
    expect(r.removed).toBe(0);
  });
});
