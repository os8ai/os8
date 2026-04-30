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
  secrets:
    - name: NEWS_API_KEY
      required: false
      prompt: news api key
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

describe('AppInstaller — full install pipeline (PR 1.16)', () => {
  let parent, prevHome, db, MIGRATION;
  let AppInstaller, AppCatalogService, InstallJobs, EnvService;
  let { AppService } = {};
  let upstream;
  let originalAdapter;

  beforeEach(async () => {
    parent = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-pipeline-'));
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

    // Stub the LLM-driven security review so it returns a low-risk report.
    AppInstaller._review = async () => ({
      riskLevel: 'low', findings: [], summary: 'mocked review' });

    // Stub the runtime adapter's install — we don't want a real `npm ci` here.
    const { getAdapter } = require('../src/services/runtime-adapters');
    originalAdapter = getAdapter('node');
    originalAdapter.install = vi.fn(async () => {
      // noop — staging dir already has fixture files, nothing to install
    });
    originalAdapter.ensureAvailable = vi.fn(async () => {});
  });

  afterEach(() => {
    db.close();
    AppInstaller._review = null;
    if (prevHome === undefined) delete process.env.OS8_HOME;
    else process.env.OS8_HOME = prevHome;
    fs.rmSync(parent, { recursive: true, force: true });
  });

  async function waitFor(predicate, { timeout = 10_000, step = 50, jobId } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise(r => setTimeout(r, step));
    }
    if (jobId) {
      const job = InstallJobs.get(db, jobId);
      throw new Error(`waitFor timed out — job state=${job?.status} error=${job?.error_message?.slice(0,500)}`);
    }
    throw new Error('waitFor timed out');
  }

  it('drives awaiting_approval → installing → installed and creates an apps row', async () => {
    const startJob = await AppInstaller.start(db, {
      slug: 'worldmonitor',
      commit: upstream.sha,
      channel: 'verified',
    });
    await waitFor(() => InstallJobs.get(db, startJob.id).status === 'awaiting_approval', { jobId: startJob.id });

    await AppInstaller.approve(db, startJob.id, { secrets: { NEWS_API_KEY: 'real-key' } });
    await waitFor(() => InstallJobs.get(db, startJob.id).status === 'installed',
      { timeout: 15_000, jobId: startJob.id });

    const finalJob = InstallJobs.get(db, startJob.id);
    expect(finalJob.status).toBe('installed');
    expect(finalJob.app_id).toBeTruthy();

    const app = AppService.getById(db, finalJob.app_id);
    expect(app).toMatchObject({
      external_slug: 'worldmonitor',
      app_type: 'external',
      channel: 'verified',
      status: 'active',
    });
    expect(app.upstream_resolved_commit).toBe(upstream.sha);

    const finalDir = path.join(parent, 'apps', app.id);
    expect(fs.existsSync(finalDir)).toBe(true);
    expect(fs.existsSync(path.join(finalDir, 'README.md'))).toBe(true);

    // Secret stored against the new app's id.
    expect(EnvService.getAllForApp(db, app.id)).toEqual({ NEWS_API_KEY: 'real-key' });

    // user/main branch present.
    const branches = spawnSync('git', ['-C', finalDir, 'branch'])
      .stdout.toString();
    expect(branches).toContain('user/main');
  }, 30_000);

  it('rejects approve when job is not in awaiting_approval', async () => {
    const job = InstallJobs.create(db, {
      externalSlug: 'worldmonitor',
      upstreamResolvedCommit: upstream.sha,
      channel: 'verified',
    });
    // Still in 'pending' — approve should refuse.
    await expect(AppInstaller.approve(db, job.id)).rejects.toThrow(/can only approve from awaiting_approval/);
  });

  it('rolls back on adapter failure: drops apps row, clears secrets, marks failed', async () => {
    originalAdapter.install = vi.fn(async () => {
      throw new Error('synthetic install failure');
    });

    const startJob = await AppInstaller.start(db, {
      slug: 'worldmonitor',
      commit: upstream.sha,
      channel: 'verified',
    });
    await waitFor(() => InstallJobs.get(db, startJob.id).status === 'awaiting_approval');

    await AppInstaller.approve(db, startJob.id, { secrets: { NEWS_API_KEY: 'leakable' } });
    await waitFor(() => InstallJobs.get(db, startJob.id).status === 'failed', { timeout: 15_000 });

    const finalJob = InstallJobs.get(db, startJob.id);
    expect(finalJob.status).toBe('failed');
    expect(finalJob.error_message).toMatch(/synthetic install failure/);

    // No active apps row left from the rollback.
    const ext = db.prepare(`SELECT * FROM apps WHERE app_type = 'external'`).all();
    expect(ext).toHaveLength(0);

    // Secrets cleared.
    if (finalJob.app_id) {
      expect(EnvService.getAllForApp(db, finalJob.app_id)).toEqual({});
    }
  }, 30_000);

  it('atomicMove falls back to copy-then-delete on EXDEV', async () => {
    // Build a real source tree
    const srcDir = fs.mkdtempSync(path.join(parent, 'src-'));
    fs.writeFileSync(path.join(srcDir, 'a.txt'), 'hello');
    const dstDir = path.join(parent, 'dst-target');

    // Force EXDEV by intercepting renameSync
    const origRename = fs.renameSync;
    fs.renameSync = vi.fn().mockImplementation(() => {
      const e = new Error('cross-device link not permitted');
      e.code = 'EXDEV';
      throw e;
    });

    try {
      await AppInstaller._helpers.atomicMove(srcDir, dstDir);
    } finally {
      fs.renameSync = origRename;
    }

    expect(fs.existsSync(dstDir)).toBe(true);
    expect(fs.readFileSync(path.join(dstDir, 'a.txt'), 'utf8')).toBe('hello');
    expect(fs.existsSync(srcDir)).toBe(false);
  });
});
