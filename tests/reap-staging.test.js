import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const Database = require('better-sqlite3');
const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

describe('AppCatalogService.reapStaging (PR 1.29)', () => {
  let db, tmpHome, prevHome, MIGRATION, AppCatalogService;
  let stagingDir, appsDir;

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-reap-'));
    prevHome = process.env.OS8_HOME;
    process.env.OS8_HOME = tmpHome;
    [
      '../src/config',
      '../src/migrations/0.5.0-app-store',
      '../src/services/app-catalog',
    ].forEach(p => { delete require.cache[require.resolve(p)]; });
    MIGRATION = require('../src/migrations/0.5.0-app-store');
    AppCatalogService = require('../src/services/app-catalog');

    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE apps (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
        status TEXT DEFAULT 'active', app_type TEXT DEFAULT 'regular',
        updated_at TEXT
      );
      CREATE TABLE app_env_variables (
        id TEXT PRIMARY KEY, app_id TEXT REFERENCES apps(id) ON DELETE CASCADE,
        key TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(app_id, key)
      );
    `);
    await MIGRATION.up({ db, logger: silentLogger });

    stagingDir = path.join(tmpHome, 'apps_staging');
    appsDir = path.join(tmpHome, 'apps');
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.mkdirSync(appsDir, { recursive: true });
  });

  afterEach(() => {
    db.close();
    if (prevHome === undefined) delete process.env.OS8_HOME;
    else process.env.OS8_HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function seedJob(id, status, createdAtIso) {
    fs.mkdirSync(path.join(stagingDir, id), { recursive: true });
    fs.writeFileSync(path.join(stagingDir, id, 'README.md'), 'leftover\n');
    db.prepare(`
      INSERT INTO app_install_jobs
        (id, external_slug, upstream_resolved_commit, channel, status,
         staging_dir, created_at, updated_at)
      VALUES (?, 'wm', ?, 'verified', ?, ?, ?, ?)
    `).run(id, 'a'.repeat(40), status,
           path.join(stagingDir, id), createdAtIso, createdAtIso);
  }

  it('removes failed-job dirs', () => {
    seedJob('job-failed', 'failed', new Date().toISOString());
    const r = AppCatalogService.reapStaging(db);
    expect(r.removed).toBe(1);
    expect(fs.existsSync(path.join(stagingDir, 'job-failed'))).toBe(false);
  });

  it('removes cancelled-job dirs', () => {
    seedJob('job-cancel', 'cancelled', new Date().toISOString());
    const r = AppCatalogService.reapStaging(db);
    expect(r.removed).toBe(1);
  });

  it('removes installed-job dirs (atomic move already happened)', () => {
    seedJob('job-installed', 'installed', new Date().toISOString());
    const r = AppCatalogService.reapStaging(db);
    expect(r.removed).toBe(1);
  });

  it('removes orphan dirs with no matching job row', () => {
    fs.mkdirSync(path.join(stagingDir, 'orphan-x'), { recursive: true });
    const r = AppCatalogService.reapStaging(db);
    expect(r.removed).toBe(1);
    expect(fs.existsSync(path.join(stagingDir, 'orphan-x'))).toBe(false);
  });

  it('keeps a recent mid-flight dir (< 24h)', () => {
    seedJob('job-running', 'cloning', new Date(Date.now() - 60_000).toISOString());
    const r = AppCatalogService.reapStaging(db);
    expect(r.removed).toBe(0);
    expect(fs.existsSync(path.join(stagingDir, 'job-running'))).toBe(true);
  });

  it('reaps a stale mid-flight dir (> 24h) and marks the job failed', () => {
    const oldTs = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    seedJob('job-stale', 'reviewing', oldTs);
    const r = AppCatalogService.reapStaging(db);
    expect(r.removed).toBe(1);
    expect(r.markedFailed).toBe(1);
    const row = db.prepare(`SELECT status, error_message FROM app_install_jobs WHERE id='job-stale'`).get();
    expect(row.status).toBe('failed');
    expect(row.error_message).toMatch(/reaped on startup/);
  });

  it('removes .<id>.installing markers + their partial dirs', () => {
    fs.mkdirSync(path.join(appsDir, 'partial-1'), { recursive: true });
    fs.writeFileSync(path.join(appsDir, '.partial-1.installing'), '{}');
    const r = AppCatalogService.reapStaging(db);
    expect(r.markersRemoved).toBe(1);
    expect(fs.existsSync(path.join(appsDir, '.partial-1.installing'))).toBe(false);
    expect(fs.existsSync(path.join(appsDir, 'partial-1'))).toBe(false);
  });

  it('returns zeros when staging dir is empty', () => {
    const r = AppCatalogService.reapStaging(db);
    expect(r).toEqual({ removed: 0, markedFailed: 0, markersRemoved: 0 });
  });

  it('survives a missing apps_staging dir', () => {
    fs.rmSync(stagingDir, { recursive: true });
    const r = AppCatalogService.reapStaging(db);
    expect(r.removed).toBe(0);
  });
});
