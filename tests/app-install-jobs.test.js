import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

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

describe('InstallJobs CRUD', () => {
  let db, tmpHome, prevHome, MIGRATION, InstallJobs;

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-jobs-'));
    prevHome = process.env.OS8_HOME;
    process.env.OS8_HOME = tmpHome;
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/migrations/0.5.0-app-store')];
    delete require.cache[require.resolve('../src/services/app-install-jobs')];
    MIGRATION = require('../src/migrations/0.5.0-app-store');
    InstallJobs = require('../src/services/app-install-jobs');
    db = makeDb();
    await MIGRATION.up({ db, logger: silentLogger });
  });

  afterEach(() => {
    db.close();
    if (prevHome === undefined) delete process.env.OS8_HOME;
    else process.env.OS8_HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('create yields a pending row with the right slug + commit + channel', () => {
    const job = InstallJobs.create(db, {
      externalSlug: 'worldmonitor',
      upstreamResolvedCommit: 'e51058e1765ef2f0c83ccb1d08d984bc59d23f10',
      channel: 'verified',
    });
    expect(job).toMatchObject({
      external_slug: 'worldmonitor',
      upstream_resolved_commit: 'e51058e1765ef2f0c83ccb1d08d984bc59d23f10',
      channel: 'verified',
      status: 'pending',
    });
    expect(job.id).toMatch(/^\d+-[a-z0-9]+$/);
  });

  it('transition advances pending → cloning when expected status matches', () => {
    const job = InstallJobs.create(db, {
      externalSlug: 'wm', upstreamResolvedCommit: 'a'.repeat(40), channel: 'verified',
    });
    const transitioned = InstallJobs.transition(db, job.id, { from: 'pending', to: 'cloning' });
    expect(transitioned.status).toBe('cloning');
  });

  it('transition throws when current status does not match `from`', () => {
    const job = InstallJobs.create(db, {
      externalSlug: 'wm', upstreamResolvedCommit: 'a'.repeat(40), channel: 'verified',
    });
    InstallJobs.transition(db, job.id, { from: 'pending', to: 'cloning' });
    expect(() => InstallJobs.transition(db, job.id, { from: 'pending', to: 'cloning' }))
      .toThrow(/transition rejected/);
  });

  it('transition writes patches in the same UPDATE', () => {
    const job = InstallJobs.create(db, {
      externalSlug: 'wm', upstreamResolvedCommit: 'a'.repeat(40), channel: 'verified',
    });
    const out = InstallJobs.transition(db, job.id, {
      from: 'pending', to: 'cloning',
      patches: { staging_dir: '/tmp/staging-x' },
    });
    expect(out.staging_dir).toBe('/tmp/staging-x');
  });

  it('cancel only works from awaiting_approval', () => {
    const job = InstallJobs.create(db, {
      externalSlug: 'wm', upstreamResolvedCommit: 'a'.repeat(40), channel: 'verified',
    });
    expect(() => InstallJobs.cancel(db, job.id)).toThrow();

    InstallJobs.transition(db, job.id, { from: 'pending', to: 'cloning' });
    InstallJobs.transition(db, job.id, { from: 'cloning', to: 'reviewing' });
    InstallJobs.transition(db, job.id, { from: 'reviewing', to: 'awaiting_approval' });
    const cancelled = InstallJobs.cancel(db, job.id);
    expect(cancelled.status).toBe('cancelled');
  });

  it('fail force-marks failed unless terminal', () => {
    const job = InstallJobs.create(db, {
      externalSlug: 'wm', upstreamResolvedCommit: 'a'.repeat(40), channel: 'verified',
    });
    InstallJobs.transition(db, job.id, { from: 'pending', to: 'cloning' });
    const failed = InstallJobs.fail(db, job.id, 'something exploded');
    expect(failed.status).toBe('failed');
    expect(failed.error_message).toBe('something exploded');

    // Idempotent — terminal states are not overwritten.
    const j2 = InstallJobs.create(db, {
      externalSlug: 'wm2', upstreamResolvedCommit: 'b'.repeat(40), channel: 'verified',
    });
    InstallJobs.transition(db, j2.id, { from: 'pending', to: 'cloning' });
    InstallJobs.transition(db, j2.id, { from: 'cloning', to: 'reviewing' });
    InstallJobs.transition(db, j2.id, { from: 'reviewing', to: 'awaiting_approval' });
    InstallJobs.cancel(db, j2.id);
    const stillCancelled = InstallJobs.fail(db, j2.id, 'late failure');
    expect(stillCancelled.status).toBe('cancelled');
  });

  it('list filters by status and orders newest first', () => {
    const a = InstallJobs.create(db, { externalSlug: 'a', upstreamResolvedCommit: 'a'.repeat(40), channel: 'verified' });
    const b = InstallJobs.create(db, { externalSlug: 'b', upstreamResolvedCommit: 'b'.repeat(40), channel: 'verified' });
    InstallJobs.transition(db, a.id, { from: 'pending', to: 'cloning' });
    expect(InstallJobs.list(db, { status: 'cloning' }).map(r => r.id)).toEqual([a.id]);
    expect(InstallJobs.list(db).length).toBe(2);
  });
});
