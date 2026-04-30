import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'node:child_process';

const Database = require('better-sqlite3');
const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

const WORLDMONITOR_YAML = `
schemaVersion: 1
slug: worldmonitor
name: World Monitor
publisher: koala73
upstream:
  git: __PLACEHOLDER__
  ref: __PLACEHOLDER__
framework: vite
runtime:
  kind: node
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
  license: MIT
  commercial_use: unrestricted
review:
  channel: verified
`.trim();

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

// Build a self-contained fake "upstream" git repo on the local filesystem so
// the test never needs network. The installer's `git clone --branch <commit>`
// fast path works against `file://` URLs because they support arbitrary-SHA
// fetching natively.
function makeFakeUpstream(rootDir) {
  const repoDir = path.join(rootDir, 'fake-upstream');
  fs.mkdirSync(repoDir, { recursive: true });
  spawnSync('git', ['init', '--initial-branch=main'], { cwd: repoDir });
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=Tester',
    'config', 'user.email', 'tester@example.com'], { cwd: repoDir });
  spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# fixture\n');
  fs.writeFileSync(path.join(repoDir, 'package.json'), '{"name":"fixture","version":"0.0.0"}\n');
  spawnSync('git', ['add', '.'], { cwd: repoDir });
  spawnSync('git', ['commit', '-m', 'initial'], { cwd: repoDir });
  // Allow uploadpack of arbitrary SHAs over file://
  spawnSync('git', ['config', 'uploadpack.allowReachableSHA1InWant', 'true'], { cwd: repoDir });
  spawnSync('git', ['config', 'uploadpack.allowAnySHA1InWant', 'true'], { cwd: repoDir });
  // Important — without this, clone --depth 1 from a local working tree fails
  // because git refuses to serve from a non-bare repo without explicit allow.
  spawnSync('git', ['config', 'receive.denyCurrentBranch', 'ignore'], { cwd: repoDir });
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).stdout.toString().trim();
  return { url: repoDir, sha: head };
}

describe('AppInstaller — clone + state machine', () => {
  let db, tmpHome, prevHome, MIGRATION, AppInstaller, AppCatalogService, InstallJobs;
  let upstream;

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-installer-'));
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

  function seedCatalog(slug, sha, gitUrl) {
    const yaml = WORLDMONITOR_YAML
      .replace('__PLACEHOLDER__', gitUrl)
      .replace('__PLACEHOLDER__', sha)
      .replace('worldmonitor', slug)
      .replace('worldmonitor', slug);
    db.prepare(`
      INSERT INTO app_catalog (
        id, slug, name, channel, manifest_yaml, manifest_sha,
        catalog_commit_sha, upstream_declared_ref, upstream_resolved_commit,
        synced_at
      ) VALUES (
        ?, ?, ?, 'verified', ?, 'sha-1', 'cat-1', 'v0.0.0', ?, datetime('now')
      )
    `).run(`row-${slug}`, slug, slug, yaml, sha);
  }

  it('drives pending → cloning → reviewing → awaiting_approval', async () => {
    seedCatalog('fixture', upstream.sha, upstream.url);

    const job = await AppInstaller.start(db, {
      slug: 'fixture',
      commit: upstream.sha,
      channel: 'verified',
    });
    expect(job.status).toBe('pending');

    // Wait synchronously for the async _run to complete.
    for (let i = 0; i < 50; i++) {
      const cur = InstallJobs.get(db, job.id);
      if (cur.status === 'awaiting_approval' || cur.status === 'failed') break;
      await new Promise(r => setTimeout(r, 100));
    }

    const final = InstallJobs.get(db, job.id);
    expect(final.status).toBe('awaiting_approval');
    expect(final.staging_dir).toMatch(/apps_staging[\\/]/);
    expect(fs.existsSync(final.staging_dir)).toBe(true);
    expect(fs.existsSync(path.join(final.staging_dir, 'README.md'))).toBe(true);

    const report = JSON.parse(final.review_report);
    expect(report).toHaveProperty('riskLevel');
  });

  it('marks failed when the catalog row is missing', async () => {
    const job = await AppInstaller.start(db, {
      slug: 'missing',
      commit: 'e'.repeat(40),
      channel: 'verified',
    });

    for (let i = 0; i < 30; i++) {
      const cur = InstallJobs.get(db, job.id);
      if (cur.status === 'failed') break;
      await new Promise(r => setTimeout(r, 50));
    }
    const final = InstallJobs.get(db, job.id);
    expect(final.status).toBe('failed');
    expect(final.error_message).toMatch(/not in local catalog/);
  });

  it('marks failed when the requested commit does not match catalog', async () => {
    seedCatalog('fixture', upstream.sha, upstream.url);

    const job = await AppInstaller.start(db, {
      slug: 'fixture',
      commit: 'd'.repeat(40),
      channel: 'verified',
    });

    for (let i = 0; i < 30; i++) {
      const cur = InstallJobs.get(db, job.id);
      if (cur.status === 'failed') break;
      await new Promise(r => setTimeout(r, 50));
    }
    const final = InstallJobs.get(db, job.id);
    expect(final.status).toBe('failed');
    expect(final.error_message).toMatch(/commit mismatch/);
  });

  it('uses the _review hook when set (PR 1.6 plug-in point)', async () => {
    seedCatalog('fixture', upstream.sha, upstream.url);

    let reviewedDir = null;
    AppInstaller._review = async (_db, stagingDir, _manifest) => {
      reviewedDir = stagingDir;
      return { riskLevel: 'low', findings: [], summary: 'plugged in' };
    };

    const job = await AppInstaller.start(db, {
      slug: 'fixture',
      commit: upstream.sha,
      channel: 'verified',
    });

    for (let i = 0; i < 50; i++) {
      const cur = InstallJobs.get(db, job.id);
      if (cur.status === 'awaiting_approval' || cur.status === 'failed') break;
      await new Promise(r => setTimeout(r, 100));
    }
    const final = InstallJobs.get(db, job.id);
    expect(final.status).toBe('awaiting_approval');
    expect(reviewedDir).toBe(final.staging_dir);
    expect(JSON.parse(final.review_report).summary).toBe('plugged in');
  });

  it('subscribers see status events as transitions land', async () => {
    seedCatalog('fixture', upstream.sha, upstream.url);

    const events = [];
    const job = await AppInstaller.start(db, {
      slug: 'fixture',
      commit: upstream.sha,
      channel: 'verified',
    });
    AppInstaller.subscribe(job.id, e => events.push(e));

    for (let i = 0; i < 50; i++) {
      const cur = InstallJobs.get(db, job.id);
      if (cur.status === 'awaiting_approval' || cur.status === 'failed') break;
      await new Promise(r => setTimeout(r, 100));
    }

    const statuses = events.filter(e => e.kind === 'status').map(e => e.status);
    // status events fire on cloning and after each subsequent transition;
    // we may miss the very first 'cloning' if subscribe lands after it,
    // so we accept any subset that includes the terminal awaiting_approval.
    expect(statuses).toContain('awaiting_approval');
  });
});
