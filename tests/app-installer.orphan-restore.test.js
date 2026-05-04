/**
 * Phase 5 PR 5.5 — installer orphan-restore integration test.
 *
 * Mirrors tests/app-installer-pipeline.test.js's setup (in-memory DB,
 * fake upstream git server, stubbed runtime adapter + review service)
 * but seeds an "uninstalled" apps row + saved secrets first, then
 * exercises both the restoreOrphan=true (revival) and restoreOrphan=
 * false (fresh install + archive) paths.
 *
 * Rollback-on-revive isn't covered here — it's verified via unit-level
 * scrutiny of the time-buffer detection in app-installer.js's
 * _rollbackInstall. A live integration test for the rollback path
 * would require simulating mid-install adapter failure in the same
 * tick as createExternal vs reviveOrphan, which is fiddly to set up
 * deterministically; the fresh-install-rollback test in
 * app-installer-pipeline.test.js already covers the core rollback
 * mechanism.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'node:child_process';

const Database = require('better-sqlite3');
const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

const WORLDMONITOR_YAML = (commit) => `
schemaVersion: 1
slug: worldmonitor
name: World Monitor
publisher: koala73
upstream:
  git: file:///__placeholder__
  ref: ${commit}
framework: vite
runtime:
  kind: node
  arch: [arm64, x86_64]
  package_manager: auto
  dependency_strategy: frozen
install:
  - argv: ["true"]
start:
  argv: ["node", "-e", "process.exit(0)"]
  port: detect
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

function makeFakeUpstream(rootDir) {
  const repoDir = path.join(rootDir, 'fake-upstream');
  fs.mkdirSync(repoDir, { recursive: true });
  spawnSync('git', ['init', '-q', '--initial-branch=main'], { cwd: repoDir });
  spawnSync('git', ['config', 'user.email', 'tester@example.com'], { cwd: repoDir });
  spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# fixture\n');
  fs.writeFileSync(path.join(repoDir, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '0.0.0' }) + '\n');
  fs.writeFileSync(path.join(repoDir, 'package-lock.json'), '{"lockfileVersion":3}\n');
  spawnSync('git', ['add', '.'], { cwd: repoDir });
  spawnSync('git', ['commit', '-q', '-m', 'initial'], { cwd: repoDir });
  spawnSync('git', ['config', 'uploadpack.allowReachableSHA1InWant', 'true'], { cwd: repoDir });
  spawnSync('git', ['config', 'uploadpack.allowAnySHA1InWant', 'true'], { cwd: repoDir });
  spawnSync('git', ['config', 'receive.denyCurrentBranch', 'ignore'], { cwd: repoDir });
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).stdout.toString().trim();
  return { url: repoDir, sha };
}

describe('AppInstaller — orphan restore (PR 5.5)', () => {
  let parent, prevHome, db, MIGRATION;
  let AppInstaller, AppCatalogService, InstallJobs, EnvService;
  let { AppService } = {};
  let upstream;
  let originalAdapter;

  beforeEach(async () => {
    parent = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-orphan-restore-'));
    prevHome = process.env.OS8_HOME;
    process.env.OS8_HOME = parent;

    [
      '../src/config',
      '../src/migrations/0.5.0-app-store',
      '../src/services/app-installer',
      '../src/services/app-install-jobs',
      '../src/services/app-catalog',
      '../src/services/app',
      '../src/services/env',
      '../src/services/sanitized-env',
      '../src/services/runtime-adapters',
      '../src/services/runtime-adapters/node',
    ].forEach(p => { delete require.cache[require.resolve(p)]; });

    MIGRATION = require('../src/migrations/0.5.0-app-store');
    AppInstaller = require('../src/services/app-installer');
    AppCatalogService = require('../src/services/app-catalog');
    InstallJobs = require('../src/services/app-install-jobs');
    EnvService = require('../src/services/env');
    ({ AppService } = require('../src/services/app'));

    db = new Database(':memory:');
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
    await MIGRATION.up({ db, logger: silentLogger });

    upstream = makeFakeUpstream(parent);

    db.prepare(`
      INSERT INTO app_catalog (
        id, slug, name, channel, manifest_yaml, manifest_sha,
        catalog_commit_sha, upstream_declared_ref, upstream_resolved_commit,
        synced_at
      ) VALUES (
        'wm-1', 'worldmonitor', 'World Monitor', 'verified', ?,
        'sha-1', 'cat-sha-1', 'v2.5.23', ?, datetime('now')
      )
    `).run(WORLDMONITOR_YAML(upstream.sha).replace('file:///__placeholder__', upstream.url),
           upstream.sha);

    AppInstaller._review = async () => ({
      riskLevel: 'low', findings: [], summary: 'mocked review' });
    const { getAdapter } = require('../src/services/runtime-adapters');
    originalAdapter = getAdapter('node');
    originalAdapter.install = vi.fn(async () => {});
    originalAdapter.ensureAvailable = vi.fn(async () => {});
  });

  afterEach(() => {
    db.close();
    AppInstaller._review = null;
    if (prevHome === undefined) delete process.env.OS8_HOME;
    else process.env.OS8_HOME = prevHome;
    fs.rmSync(parent, { recursive: true, force: true });
  });

  async function waitFor(predicate, { timeout = 15_000, step = 50, jobId } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise(r => setTimeout(r, step));
    }
    if (jobId) {
      const job = InstallJobs.get(db, jobId);
      throw new Error(`waitFor timed out — job state=${job?.status} error=${job?.error_message?.slice(0, 500)}`);
    }
    throw new Error('waitFor timed out');
  }

  /**
   * Seed an "uninstalled" external app for worldmonitor with a saved
   * secret + a non-empty blob dir, so getOrphan reports realistic data.
   * Returns the orphan appId.
   */
  function seedOrphan() {
    const { BLOB_DIR } = require('../src/config');
    const orphanId = '1700000000000-orphan';
    db.prepare(`
      INSERT INTO apps (
        id, name, slug, status, app_type, external_slug, channel,
        upstream_resolved_commit, manifest_sha, created_at, updated_at
      ) VALUES (
        ?, 'World Monitor', 'wm-orphan', 'uninstalled', 'external',
        'worldmonitor', 'verified', ?, ?, ?, ?
      )
    `).run(orphanId, 'old-commit', 'sha-OLD',
      // ~30 days ago — comfortably past the 5-min revival buffer
      new Date(Date.now() - 30 * 86400_000).toISOString(),
      new Date(Date.now() - 1 * 86400_000).toISOString());
    db.prepare(`INSERT INTO app_env_variables (id, app_id, key, value)
                VALUES ('e1', ?, 'NEWS_API_KEY', 'sk-preserved')`).run(orphanId);
    const blobDir = path.join(BLOB_DIR, orphanId);
    fs.mkdirSync(blobDir, { recursive: true });
    fs.writeFileSync(path.join(blobDir, 'preserved.txt'), 'data the user cared about');
    return orphanId;
  }

  it('restoreOrphan=true reuses the orphan appId, preserves secrets + blob dir', async () => {
    const orphanId = seedOrphan();

    // Sanity check: getOrphan reports non-zero blob + 1 secret
    const orphan = AppService.getOrphan(db, 'worldmonitor', 'verified');
    expect(orphan.appId).toBe(orphanId);
    expect(orphan.secretCount).toBe(1);
    expect(orphan.blobSize).toBeGreaterThan(0);

    const startJob = await AppInstaller.start(db, {
      slug: 'worldmonitor', commit: upstream.sha, channel: 'verified',
    });
    await waitFor(() => InstallJobs.get(db, startJob.id).status === 'awaiting_approval', { jobId: startJob.id });

    await AppInstaller.approve(db, startJob.id, {
      secrets: {},                 // no new secrets — preserved set is what we want
      restoreOrphan: true,
    });
    await waitFor(() => InstallJobs.get(db, startJob.id).status === 'installed', { jobId: startJob.id });

    const finalJob = InstallJobs.get(db, startJob.id);
    expect(finalJob.app_id).toBe(orphanId);     // SAME appId — orphan revived

    const app = AppService.getById(db, orphanId);
    expect(app.status).toBe('active');
    expect(app.upstream_resolved_commit).toBe(upstream.sha);  // refreshed
    expect(app.manifest_sha).toBe('sha-1');                    // refreshed

    // Saved secret survives revival.
    const sec = db.prepare(`SELECT value FROM app_env_variables WHERE app_id = ? AND key = 'NEWS_API_KEY'`).get(orphanId);
    expect(sec?.value).toBe('sk-preserved');

    // Blob file survives. (The blob dir was never touched by the
    // installer because the orphan path skips the BLOB_DIR/<id>/ init.)
    const { BLOB_DIR } = require('../src/config');
    const preservedFile = path.join(BLOB_DIR, orphanId, 'preserved.txt');
    expect(fs.existsSync(preservedFile)).toBe(true);
    expect(fs.readFileSync(preservedFile, 'utf8')).toBe('data the user cared about');
  });

  it('restoreOrphan=false creates a fresh app row + archives the orphan', async () => {
    const orphanId = seedOrphan();

    const startJob = await AppInstaller.start(db, {
      slug: 'worldmonitor', commit: upstream.sha, channel: 'verified',
    });
    await waitFor(() => InstallJobs.get(db, startJob.id).status === 'awaiting_approval', { jobId: startJob.id });

    await AppInstaller.approve(db, startJob.id, {
      secrets: {},
      restoreOrphan: false,
    });
    await waitFor(() => InstallJobs.get(db, startJob.id).status === 'installed', { jobId: startJob.id });

    const finalJob = InstallJobs.get(db, startJob.id);
    expect(finalJob.app_id).not.toBe(orphanId);    // NEW appId

    const fresh = AppService.getById(db, finalJob.app_id);
    expect(fresh.status).toBe('active');
    // Slug is suffixed because the orphan still holds 'wm-orphan' under
    // status='archived', and uniqueSlug doesn't filter by status — it
    // appends -2 to keep the constraint happy.
    expect(fresh.slug).toMatch(/^worldmonitor(-\d+)?$/);

    // Orphan row marked archived.
    const orphan = db.prepare(`SELECT status FROM apps WHERE id = ?`).get(orphanId);
    expect(orphan.status).toBe('archived');

    // getOrphan no longer proposes the archived row.
    expect(AppService.getOrphan(db, 'worldmonitor', 'verified')).toBeNull();

    // Orphan's preserved blob is left on disk (user's call; matches the
    // "we never delete user data without explicit consent" invariant).
    const { BLOB_DIR } = require('../src/config');
    expect(fs.existsSync(path.join(BLOB_DIR, orphanId, 'preserved.txt'))).toBe(true);
  });

  it('restoreOrphan=true with no orphan present falls back to fresh install', async () => {
    // No seedOrphan() call — there's nothing to restore from.
    const startJob = await AppInstaller.start(db, {
      slug: 'worldmonitor', commit: upstream.sha, channel: 'verified',
    });
    await waitFor(() => InstallJobs.get(db, startJob.id).status === 'awaiting_approval', { jobId: startJob.id });

    // Caller asked to restore but there's no orphan; install proceeds fresh.
    await AppInstaller.approve(db, startJob.id, {
      secrets: {},
      restoreOrphan: true,
    });
    await waitFor(() => InstallJobs.get(db, startJob.id).status === 'installed', { jobId: startJob.id });

    const finalJob = InstallJobs.get(db, startJob.id);
    expect(finalJob.status).toBe('installed');
    const app = AppService.getById(db, finalJob.app_id);
    expect(app.status).toBe('active');
  });
});
