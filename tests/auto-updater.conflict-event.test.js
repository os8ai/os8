/**
 * Phase 5 PR 5.4 — auto-updater fires onConflict callback when
 * AppCatalogService.update returns { kind: 'conflict' }.
 *
 * Stubs AppCatalogService.update directly so we don't need a real
 * git repo or in-progress merge — that's covered by
 * tests/app-merge-resolver.test.js.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const Database = require('better-sqlite3');

let db;
let AppAutoUpdater;
let AppCatalogService;
let originalUpdate;

beforeEach(() => {
  delete require.cache[require.resolve('../src/services/app-auto-updater')];
  delete require.cache[require.resolve('../src/services/app-catalog')];
  AppAutoUpdater = require('../src/services/app-auto-updater');
  AppCatalogService = require('../src/services/app-catalog');
  originalUpdate = AppCatalogService.update;

  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE app_telemetry_events (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL,
      created_at TEXT NOT NULL, sent_at TEXT
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE apps (
      id TEXT PRIMARY KEY,
      name TEXT, slug TEXT UNIQUE,
      status TEXT DEFAULT 'active',
      app_type TEXT DEFAULT 'regular',
      external_slug TEXT,
      channel TEXT,
      manifest_yaml TEXT,
      auto_update INTEGER DEFAULT 0,
      update_available INTEGER DEFAULT 0,
      update_to_commit TEXT,
      user_branch TEXT,
      upstream_resolved_commit TEXT
    );
  `);
});

afterEach(() => {
  AppCatalogService.update = originalUpdate;
  try { db.close(); } catch (_) {}
});

function seedEligible() {
  const targetSha = 'a'.repeat(40);
  db.prepare(`
    INSERT INTO apps (
      id, name, slug, app_type, external_slug, channel,
      auto_update, update_available, update_to_commit,
      upstream_resolved_commit, manifest_yaml
    ) VALUES (
      'wm-1', 'World Monitor', 'worldmonitor', 'external', 'worldmonitor',
      'verified', 1, 1, ?, 'b1234567890', 'runtime: { kind: node }'
    )
  `).run(targetSha);
  return targetSha;
}

describe('AppAutoUpdater — conflict event (PR 5.4)', () => {
  it('fires onConflict (and onSkipped) when update returns { kind: conflict }', async () => {
    const targetSha = seedEligible();
    AppCatalogService.update = vi.fn(async () => ({
      kind: 'conflict',
      files: ['src/App.tsx', 'src/index.css'],
    }));

    const conflictCalls = [];
    const skippedCalls = [];
    const r = await AppAutoUpdater.processAutoUpdates(db, {
      onConflict: (app, info) => conflictCalls.push({ slug: app.external_slug, info }),
      onSkipped: (app, reason) => skippedCalls.push({ slug: app.external_slug, reason }),
    });

    expect(r.attempted).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.conflicts).toBe(1);
    expect(r.updated).toBe(0);
    expect(r.failed).toBe(0);

    expect(conflictCalls).toHaveLength(1);
    expect(conflictCalls[0].slug).toBe('worldmonitor');
    expect(conflictCalls[0].info.files).toEqual(['src/App.tsx', 'src/index.css']);

    // onSkipped still fires for back-compat with the existing summary
    // logging in server.js.
    expect(skippedCalls).toHaveLength(1);
    expect(skippedCalls[0].reason).toMatch(/merge conflict/);

    expect(AppCatalogService.update).toHaveBeenCalledOnce();
    expect(AppCatalogService.update).toHaveBeenCalledWith(db, 'wm-1', targetSha);
  });

  it('does NOT fire onConflict for clean updates', async () => {
    const targetSha = seedEligible();
    AppCatalogService.update = vi.fn(async () => ({
      kind: 'updated', commit: targetSha, hadUserEdits: false,
    }));

    const conflictCalls = [];
    const r = await AppAutoUpdater.processAutoUpdates(db, {
      onConflict: () => conflictCalls.push(1),
    });
    expect(r.updated).toBe(1);
    expect(r.conflicts).toBe(0);
    expect(conflictCalls).toHaveLength(0);
  });

  it('does NOT fire onConflict for skipped invalid commit', async () => {
    db.prepare(`
      INSERT INTO apps (
        id, name, slug, app_type, external_slug, channel,
        auto_update, update_available, update_to_commit
      ) VALUES (
        'bad-1', 'Bad', 'bad-app', 'external', 'bad-app',
        'verified', 1, 1, 'not-a-sha'
      )
    `).run();

    const conflictCalls = [];
    const skippedCalls = [];
    const r = await AppAutoUpdater.processAutoUpdates(db, {
      onConflict: () => conflictCalls.push(1),
      onSkipped: (app, reason) => skippedCalls.push(reason),
    });
    expect(r.skipped).toBe(1);
    expect(r.conflicts).toBe(0);
    expect(conflictCalls).toHaveLength(0);
    expect(skippedCalls[0]).toMatch(/invalid update_to_commit/);
  });

  it('emits update_conflict telemetry when opt-in is on', async () => {
    seedEligible();
    AppCatalogService.update = vi.fn(async () => ({
      kind: 'conflict', files: ['src/App.tsx'],
    }));

    // Telemetry opt-in.
    db.prepare(`INSERT INTO settings (key, value) VALUES ('app_store.telemetry.opt_in', 'true')`).run();

    await AppAutoUpdater.processAutoUpdates(db, {});

    const events = db.prepare(`SELECT kind, payload FROM app_telemetry_events`).all();
    const conflictEvent = events.find(e => e.kind === 'update_conflict');
    expect(conflictEvent).toBeDefined();
    const payload = JSON.parse(conflictEvent.payload);
    expect(payload.kind).toBe('update_conflict');
    expect(payload.slug).toBe('worldmonitor');
    expect(payload.failurePhase).toBe('merge');
    expect(payload.conflictFileCount).toBe(1);
  });
});
