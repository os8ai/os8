/**
 * Phase 6 PR 6.1 — `AppService.createExternal` honors per-channel
 * auto-update defaults seeded by migration 0.8.0.
 *
 * Asymmetric defaults:
 *   - Verified  → `auto_update = 0` (opt-in; PR 4.2 posture preserved)
 *   - Community → `auto_update = 1` (opt-out; per Leo 2026-05-04)
 *   - User-set settings keys override the migration's seeds.
 *   - When the migration hasn't run, hard-coded fallbacks kick in
 *     (same as the seeded values).
 *   - Existing app rows are NOT touched by this migration; this test
 *     covers the new-install path only.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const Database = require('better-sqlite3');
const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

function makeDb() {
  const db = new Database(':memory:');
  // Mirror the production seeds.js shell so migration 0.5.0 can ALTER cleanly.
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
      key TEXT NOT NULL, value TEXT NOT NULL
    );
  `);
  return db;
}

describe('AppService.createExternal — per-channel auto-update default (PR 6.1)', () => {
  let db, tmpHome, prevHome, AppService, MIGRATION_05, MIGRATION_08;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-pr6.1-'));
    prevHome = process.env.OS8_HOME;
    process.env.OS8_HOME = tmpHome;
    [
      '../src/config',
      '../src/migrations/0.5.0-app-store',
      '../src/migrations/0.8.0-app-store-community-auto-update',
      '../src/services/app',
    ].forEach(p => { delete require.cache[require.resolve(p)]; });

    MIGRATION_05 = require('../src/migrations/0.5.0-app-store');
    MIGRATION_08 = require('../src/migrations/0.8.0-app-store-community-auto-update');
    ({ AppService } = require('../src/services/app'));

    db = makeDb();
    return MIGRATION_05.up({ db, logger: silentLogger });
  });

  afterEach(() => {
    db.close();
    if (prevHome === undefined) delete process.env.OS8_HOME;
    else process.env.OS8_HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function createOf(channel) {
    return AppService.createExternal(db, {
      name: `app-${channel}`,
      slug: `app-${channel}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      externalSlug: `external-${channel}`,
      channel,
      framework: 'vite',
      manifestYaml: 'schemaVersion: 1\n',
      manifestSha: 'a'.repeat(64),
      catalogCommitSha: 'b'.repeat(40),
      upstreamDeclaredRef: 'v1.0.0',
      upstreamResolvedCommit: 'c'.repeat(40),
    });
  }

  function autoUpdateOf(appId) {
    return db.prepare('SELECT auto_update FROM apps WHERE id = ?').get(appId).auto_update;
  }

  it('Verified: auto_update = 0 after migration 0.8.0 seeds verified_default = false', async () => {
    await MIGRATION_08.up({ db, logger: silentLogger });
    const app = createOf('verified');
    expect(autoUpdateOf(app.id)).toBe(0);
  });

  it('Community: auto_update = 1 after migration 0.8.0 seeds community_default = true', async () => {
    await MIGRATION_08.up({ db, logger: silentLogger });
    const app = createOf('community');
    expect(autoUpdateOf(app.id)).toBe(1);
  });

  it('Developer-Import: auto_update = 0 (no upstream catalog; channel falls back to false)', async () => {
    await MIGRATION_08.up({ db, logger: silentLogger });
    const app = createOf('developer-import');
    expect(autoUpdateOf(app.id)).toBe(0);
  });

  it('user override: setting verified_default = true makes new Verified installs default ON', async () => {
    await MIGRATION_08.up({ db, logger: silentLogger });
    db.prepare("UPDATE settings SET value = 'true' WHERE key = 'app_store.auto_update.verified_default'").run();
    const app = createOf('verified');
    expect(autoUpdateOf(app.id)).toBe(1);
  });

  it('user override: setting community_default = false makes new Community installs default OFF', async () => {
    await MIGRATION_08.up({ db, logger: silentLogger });
    db.prepare("UPDATE settings SET value = 'false' WHERE key = 'app_store.auto_update.community_default'").run();
    const app = createOf('community');
    expect(autoUpdateOf(app.id)).toBe(0);
  });

  it('migration 0.8.0 not run: hard-coded fallback honors verified=false / community=true', () => {
    // Skip MIGRATION_08; createExternal should still produce sane defaults
    // via the resolveAutoUpdateDefault hard-coded fallback table.
    const verified  = createOf('verified');
    const community = createOf('community');
    expect(autoUpdateOf(verified.id)).toBe(0);
    expect(autoUpdateOf(community.id)).toBe(1);
  });

  it('does NOT touch existing app rows (migration is seed-only)', async () => {
    // Pre-seed an existing Community app with auto_update = 0 (the legacy
    // pre-PR-6.1 default).
    db.prepare(`
      INSERT INTO apps (id, name, slug, status, app_type, channel, auto_update)
      VALUES ('legacy', 'legacy', 'legacy', 'active', 'external', 'community', 0)
    `).run();

    await MIGRATION_08.up({ db, logger: silentLogger });

    // Existing row's auto_update is preserved (0); new installs read the seed.
    expect(autoUpdateOf('legacy')).toBe(0);
    const fresh = createOf('community');
    expect(autoUpdateOf(fresh.id)).toBe(1);
  });
});
