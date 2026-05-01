/**
 * Phase 3 PR 3.5 — defense-in-depth checks for disabled channels.
 *
 * Settings → App Store hides the Developer Import button when disabled and
 * skips disabled channels in the daily catalog scheduler. AppInstaller
 * mirrors these checks server-side so a malicious renderer (or DevTools
 * console) can't bypass the gate by calling the IPC directly.
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
  fs.writeFileSync(path.join(repoDir, 'package.json'), '{"name":"fix","version":"0.0.0"}\n');
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
    schemaVersion: 1, slug, name: slug, publisher: 'tester', description: '',
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

describe('AppInstaller — disabled-channel guards', () => {
  let db, tmpHome, prevHome, MIGRATION, AppInstaller, InstallJobs;
  let upstream;

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-disabled-'));
    prevHome = process.env.OS8_HOME;
    process.env.OS8_HOME = tmpHome;
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/migrations/0.5.0-app-store')];
    delete require.cache[require.resolve('../src/services/app-installer')];
    delete require.cache[require.resolve('../src/services/app-catalog')];
    delete require.cache[require.resolve('../src/services/app-install-jobs')];
    delete require.cache[require.resolve('../src/services/settings')];
    MIGRATION = require('../src/migrations/0.5.0-app-store');
    AppInstaller = require('../src/services/app-installer');
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

  it('startFromManifest rejects when developer-import is disabled', async () => {
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`)
      .run('app_store.channel.developer-import.enabled', 'false');

    const m = devImportManifest({ slug: 'devimp-off', gitUrl: upstream.url, ref: upstream.sha });
    await expect(
      AppInstaller.startFromManifest(db, { manifest: m, upstreamResolvedCommit: upstream.sha })
    ).rejects.toThrow(/Developer Import is disabled/);
  });

  it('startFromManifest succeeds when developer-import is enabled (default)', async () => {
    AppInstaller._review = async () => ({ riskLevel: 'low', findings: [], summary: 'ok' });
    const m = devImportManifest({ slug: 'devimp-on', gitUrl: upstream.url, ref: upstream.sha });
    const job = await AppInstaller.startFromManifest(db, {
      manifest: m, upstreamResolvedCommit: upstream.sha,
    });
    expect(job.status).toBe('pending');
    // Drain so afterEach doesn't race on db.close.
    for (let i = 0; i < 50; i++) {
      const cur = InstallJobs.get(db, job.id);
      if (cur.status === 'awaiting_approval' || cur.status === 'failed') break;
      await new Promise(r => setTimeout(r, 100));
    }
  });

  it('_run fails community job when community is disabled', async () => {
    // Insert a synthetic community catalog row + queue a job for it.
    db.prepare(`
      INSERT INTO app_catalog (
        id, slug, name, channel, manifest_yaml, manifest_sha, catalog_commit_sha,
        upstream_declared_ref, upstream_resolved_commit, synced_at
      ) VALUES (?, ?, ?, 'community', ?, 'sha', 'cat', 'v0', ?, datetime('now'))
    `).run('row-c', 'comm-app', 'Comm', 'slug: comm-app\n', upstream.sha);

    const job = await AppInstaller.start(db, {
      slug: 'comm-app',
      commit: upstream.sha,
      channel: 'community',
    });

    for (let i = 0; i < 30; i++) {
      const cur = InstallJobs.get(db, job.id);
      if (cur.status === 'failed') break;
      await new Promise(r => setTimeout(r, 50));
    }
    const final = InstallJobs.get(db, job.id);
    expect(final.status).toBe('failed');
    expect(final.error_message).toMatch(/Community channel is disabled/);
  });

  it('_run runs community job when community is enabled', async () => {
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`)
      .run('app_store.channel.community.enabled', 'true');

    AppInstaller._review = async () => ({ riskLevel: 'low', findings: [], summary: 'ok' });

    // Use a verified-style manifest with community channel for the catalog row.
    const yaml = require('js-yaml');
    const manifest = {
      schemaVersion: 1,
      slug: 'comm-on',
      name: 'Comm',
      publisher: 'tester',
      upstream: { git: upstream.url, ref: 'v0' },
      framework: 'vite',
      runtime: { kind: 'node', arch: ['arm64', 'x86_64'], package_manager: 'npm', dependency_strategy: 'frozen' },
      install: [{ argv: ['npm', 'ci'] }],
      start: { argv: ['npm', 'run', 'dev'], port: 'detect', readiness: { type: 'http', path: '/' } },
      surface: { kind: 'web' },
      permissions: { network: { outbound: false, inbound: false }, filesystem: 'app-private', os8_capabilities: [] },
      legal: { license: 'MIT', commercial_use: 'unrestricted' },
      review: { channel: 'community' },
    };
    db.prepare(`
      INSERT INTO app_catalog (
        id, slug, name, channel, manifest_yaml, manifest_sha, catalog_commit_sha,
        upstream_declared_ref, upstream_resolved_commit, synced_at
      ) VALUES (?, ?, ?, 'community', ?, 'sha', 'cat', 'v0', ?, datetime('now'))
    `).run('row-c2', 'comm-on', 'Comm', yaml.dump(manifest), upstream.sha);

    const job = await AppInstaller.start(db, {
      slug: 'comm-on',
      commit: upstream.sha,
      channel: 'community',
    });

    for (let i = 0; i < 50; i++) {
      const cur = InstallJobs.get(db, job.id);
      if (cur.status === 'awaiting_approval' || cur.status === 'failed') break;
      await new Promise(r => setTimeout(r, 100));
    }
    const final = InstallJobs.get(db, job.id);
    expect(final.status).toBe('awaiting_approval');
  });
});
