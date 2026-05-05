import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
      status TEXT DEFAULT 'active',
      display_order INTEGER DEFAULT 0,
      color TEXT DEFAULT '#6366f1',
      icon TEXT,
      text_color TEXT DEFAULT '#ffffff',
      archived_at TEXT,
      app_type TEXT DEFAULT 'regular',
      created_at TEXT, updated_at TEXT
    );
    CREATE TABLE app_env_variables (
      id TEXT PRIMARY KEY,
      app_id TEXT REFERENCES apps(id) ON DELETE CASCADE,
      key TEXT NOT NULL, value TEXT NOT NULL
    );
  `);
  return db;
}

function insertExternalApp(db, opts) {
  const {
    id, slug, externalSlug, channel, autoUpdate = 0, updateAvailable = 0,
    updateToCommit = null, userBranch = null,
  } = opts;
  // Migration 0.5.0 adds the columns; we run it here to keep the test fixture
  // honest about the actual production shape.
  return { id, slug, externalSlug, channel, autoUpdate, updateAvailable, updateToCommit, userBranch };
}

describe('app-auto-updater — Phase 4 PR 4.2', () => {
  let db;
  let tmpHome, prevHome;
  let MIGRATION;
  let AppAutoUpdater;
  let AppCatalogService;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-auto-update-'));
    prevHome = process.env.OS8_HOME;
    process.env.OS8_HOME = tmpHome;
    [
      '../src/config',
      '../src/migrations/0.5.0-app-store',
      '../src/services/app-catalog',
      '../src/services/app-auto-updater',
      '../src/services/app',
    ].forEach(p => { delete require.cache[require.resolve(p)]; });

    MIGRATION = require('../src/migrations/0.5.0-app-store');
    AppAutoUpdater = require('../src/services/app-auto-updater');
    AppCatalogService = require('../src/services/app-catalog');

    db = makeDb();
    return MIGRATION.up({ db, logger: silentLogger });
  });

  afterEach(() => {
    db.close();
    if (prevHome === undefined) delete process.env.OS8_HOME;
    else process.env.OS8_HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function row({ id = 'a1', slug, channel, autoUpdate = 0, updateAvailable = 0, updateToCommit = null, userBranch = null }) {
    db.prepare(`
      INSERT INTO apps (
        id, name, slug, status, app_type, channel, external_slug,
        auto_update, update_available, update_to_commit, user_branch,
        upstream_resolved_commit
      ) VALUES (?, ?, ?, 'active', 'external', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      slug.replace(/-/g, ' '),
      slug,
      channel,
      slug,
      autoUpdate,
      updateAvailable,
      updateToCommit,
      userBranch,
      'a'.repeat(40),
    );
  }

  it('listEligible returns verified + community opted-in update-flagged no-edits rows (PR 6.1 widened)', () => {
    row({ id: 'a-yes',    slug: 'a-yes',    channel: 'verified',          autoUpdate: 1, updateAvailable: 1, updateToCommit: 'b'.repeat(40) });
    row({ id: 'a-off',    slug: 'a-off',    channel: 'verified',          autoUpdate: 0, updateAvailable: 1, updateToCommit: 'b'.repeat(40) });
    row({ id: 'a-noupd',  slug: 'a-noupd',  channel: 'verified',          autoUpdate: 1, updateAvailable: 0 });
    row({ id: 'a-comm',   slug: 'a-comm',   channel: 'community',         autoUpdate: 1, updateAvailable: 1, updateToCommit: 'b'.repeat(40) });
    row({ id: 'a-edit',   slug: 'a-edit',   channel: 'verified',          autoUpdate: 1, updateAvailable: 1, updateToCommit: 'b'.repeat(40), userBranch: 'user/main' });
    row({ id: 'a-devimp', slug: 'a-devimp', channel: 'developer-import',  autoUpdate: 1, updateAvailable: 1, updateToCommit: 'b'.repeat(40) });

    const eligible = AppAutoUpdater.listEligible(db);
    // Verified + Community both qualify; developer-import excluded by channel filter.
    expect(eligible.map(r => r.id).sort()).toEqual(['a-comm', 'a-yes']);
  });

  it('processAutoUpdates calls AppCatalogService.update for each eligible row', async () => {
    row({ id: 'a-yes', slug: 'a-yes', channel: 'verified', autoUpdate: 1, updateAvailable: 1, updateToCommit: 'b'.repeat(40) });

    const updateSpy = vi.spyOn(AppCatalogService, 'update').mockResolvedValue({ kind: 'updated', commit: 'b'.repeat(40) });

    const onUpdated = vi.fn();
    const result = await AppAutoUpdater.processAutoUpdates(db, { onUpdated });

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledWith(db, 'a-yes', 'b'.repeat(40));
    expect(result).toEqual({ attempted: 1, updated: 1, skipped: 0, failed: 0, conflicts: 0 });
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ id: 'a-yes' }), 'b'.repeat(40));
  });

  it('counts conflicts as skipped (not failed)', async () => {
    row({ id: 'a-yes', slug: 'a-yes', channel: 'verified', autoUpdate: 1, updateAvailable: 1, updateToCommit: 'b'.repeat(40) });

    vi.spyOn(AppCatalogService, 'update').mockResolvedValue({ kind: 'conflict', files: ['a.js'] });

    const onSkipped = vi.fn();
    const result = await AppAutoUpdater.processAutoUpdates(db, { onSkipped });

    // PR 5.4 — conflicts now also count in the dedicated `conflicts` field;
    // skipped still increments for back-compat with the existing summary.
    expect(result).toEqual({ attempted: 1, updated: 0, skipped: 1, failed: 0, conflicts: 1 });
    expect(onSkipped).toHaveBeenCalledWith(expect.objectContaining({ id: 'a-yes' }), expect.stringContaining('conflict'));
  });

  it('catches throws into the failed bucket', async () => {
    row({ id: 'a-yes', slug: 'a-yes', channel: 'verified', autoUpdate: 1, updateAvailable: 1, updateToCommit: 'b'.repeat(40) });

    vi.spyOn(AppCatalogService, 'update').mockRejectedValue(new Error('boom'));

    const onFailed = vi.fn();
    const result = await AppAutoUpdater.processAutoUpdates(db, { onFailed });

    expect(result).toEqual({ attempted: 1, updated: 0, skipped: 0, failed: 1, conflicts: 0 });
    expect(onFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a-yes' }),
      expect.objectContaining({ message: 'boom' })
    );
  });

  it('skips rows with malformed update_to_commit (defensive)', async () => {
    row({ id: 'a-bad', slug: 'a-bad', channel: 'verified', autoUpdate: 1, updateAvailable: 1, updateToCommit: 'not-a-sha' });

    const updateSpy = vi.spyOn(AppCatalogService, 'update');
    const onSkipped = vi.fn();
    const result = await AppAutoUpdater.processAutoUpdates(db, { onSkipped });

    expect(updateSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ attempted: 1, updated: 0, skipped: 1, failed: 0, conflicts: 0 });
    expect(onSkipped).toHaveBeenCalledWith(expect.objectContaining({ id: 'a-bad' }), expect.stringContaining('invalid update_to_commit'));
  });

  it('processes a mixed batch and reports per-app outcomes', async () => {
    row({ id: 'good',   slug: 'a-good',   channel: 'verified', autoUpdate: 1, updateAvailable: 1, updateToCommit: 'b'.repeat(40) });
    row({ id: 'badsha', slug: 'a-badsha', channel: 'verified', autoUpdate: 1, updateAvailable: 1, updateToCommit: 'not-sha' });
    row({ id: 'fail',   slug: 'a-fail',   channel: 'verified', autoUpdate: 1, updateAvailable: 1, updateToCommit: 'c'.repeat(40) });

    const updateSpy = vi.spyOn(AppCatalogService, 'update').mockImplementation(async (_db, appId) => {
      if (appId === 'fail') throw new Error('git error');
      return { kind: 'updated', commit: 'b'.repeat(40) };
    });

    const result = await AppAutoUpdater.processAutoUpdates(db);
    expect(result).toEqual({ attempted: 3, updated: 1, skipped: 1, failed: 1, conflicts: 0 });
    // updateSpy never sees 'badsha' (skipped before dispatch).
    expect(updateSpy.mock.calls.map(c => c[1])).toEqual(['good', 'fail']);
  });

  it('returns zero counters when nothing is eligible', async () => {
    row({ id: 'a-off', slug: 'a-off', channel: 'verified', autoUpdate: 0, updateAvailable: 1, updateToCommit: 'b'.repeat(40) });
    const updateSpy = vi.spyOn(AppCatalogService, 'update');
    const result = await AppAutoUpdater.processAutoUpdates(db);
    expect(result).toEqual({ attempted: 0, updated: 0, skipped: 0, failed: 0, conflicts: 0 });
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

describe('AppService.setAutoUpdate — channel restrictions', () => {
  let db, tmpHome, prevHome, AppService;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-set-auto-'));
    prevHome = process.env.OS8_HOME;
    process.env.OS8_HOME = tmpHome;
    [
      '../src/config',
      '../src/migrations/0.5.0-app-store',
      '../src/services/app',
    ].forEach(p => { delete require.cache[require.resolve(p)]; });

    const MIGRATION = require('../src/migrations/0.5.0-app-store');
    ({ AppService } = require('../src/services/app'));

    db = makeDb();
    return MIGRATION.up({ db, logger: silentLogger });
  });

  afterEach(() => {
    db.close();
    if (prevHome === undefined) delete process.env.OS8_HOME;
    else process.env.OS8_HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function insert({ id, slug, channel, type = 'external' }) {
    db.prepare(`
      INSERT INTO apps (id, name, slug, status, app_type, channel)
      VALUES (?, ?, ?, 'active', ?, ?)
    `).run(id, slug, slug, type, channel);
  }

  it('enables auto_update for a verified external app', () => {
    insert({ id: 'a1', slug: 'verified-app', channel: 'verified' });
    const r = AppService.setAutoUpdate(db, 'a1', true);
    expect(r.auto_update).toBe(1);
    expect(AppService.getAutoUpdate(db, 'a1')).toBe(true);
  });

  it('disables auto_update', () => {
    insert({ id: 'a1', slug: 'verified-app', channel: 'verified' });
    AppService.setAutoUpdate(db, 'a1', true);
    const r = AppService.setAutoUpdate(db, 'a1', false);
    expect(r.auto_update).toBe(0);
    expect(AppService.getAutoUpdate(db, 'a1')).toBe(false);
  });

  it('enables auto_update for a community external app (PR 6.1 widened)', () => {
    insert({ id: 'a2', slug: 'community-app', channel: 'community' });
    const r = AppService.setAutoUpdate(db, 'a2', true);
    expect(r.auto_update).toBe(1);
    expect(AppService.getAutoUpdate(db, 'a2')).toBe(true);
  });

  it('refuses to enable auto_update for developer-import apps (no upstream catalog)', () => {
    insert({ id: 'a3', slug: 'devimp-app', channel: 'developer-import' });
    expect(() => AppService.setAutoUpdate(db, 'a3', true)).toThrow(/catalog channel/);
  });

  it('refuses to operate on native (non-external) apps', () => {
    insert({ id: 'a4', slug: 'native-app', channel: null, type: 'regular' });
    expect(() => AppService.setAutoUpdate(db, 'a4', true)).toThrow(/external apps/);
  });

  it('throws on unknown app id', () => {
    expect(() => AppService.setAutoUpdate(db, 'nope', true)).toThrow(/not found/);
  });
});
