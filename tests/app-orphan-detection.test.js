/**
 * Phase 5 PR 5.5 — orphan detection + revive + archive unit tests.
 *
 * Exercises AppService.getOrphan / reviveOrphan / archiveOrphan in
 * isolation. Full installer-orphan integration is in
 * tests/app-installer.orphan-restore.test.js.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const Database = require('better-sqlite3');

let prevHome, parent, db;
let AppService;

function freshAppsTable(db) {
  // Mirror the post-0.5.0 + post-0.7.0 apps schema columns the orphan
  // helpers read/write. Minimal — only fields the helpers touch.
  db.exec(`
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
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      external_slug TEXT,
      channel TEXT,
      framework TEXT,
      manifest_yaml TEXT,
      manifest_sha TEXT,
      catalog_commit_sha TEXT,
      upstream_declared_ref TEXT,
      upstream_resolved_commit TEXT,
      update_status TEXT
    );
    CREATE TABLE app_env_variables (
      id TEXT PRIMARY KEY,
      app_id TEXT,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      UNIQUE(app_id, key)
    );
  `);
}

function insertOrphan(db, { id, externalSlug = 'worldmonitor', channel = 'verified', updatedAt = null }) {
  const ts = updatedAt || new Date(Date.now() - 7 * 86400_000).toISOString();
  db.prepare(`
    INSERT INTO apps (
      id, name, slug, status, app_type, external_slug, channel, updated_at
    ) VALUES (?, 'World Monitor', ?, 'uninstalled', 'external', ?, ?, ?)
  `).run(id, `wm-${id}`, externalSlug, channel, ts);
}

beforeEach(() => {
  parent = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-orphan-'));
  prevHome = process.env.OS8_HOME;
  process.env.OS8_HOME = parent;

  // Drop the cached app service so it reads the new OS8_HOME.
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/services/app')];
  ({ AppService } = require('../src/services/app'));

  db = new Database(':memory:');
  freshAppsTable(db);
});

afterEach(() => {
  try { db.close(); } catch (_) {}
  if (prevHome === undefined) delete process.env.OS8_HOME;
  else process.env.OS8_HOME = prevHome;
  try { fs.rmSync(parent, { recursive: true, force: true }); } catch (_) {}
});

describe('AppService.getOrphan (PR 5.5)', () => {
  it('returns null when no uninstalled row exists', () => {
    expect(AppService.getOrphan(db, 'worldmonitor', 'verified')).toBeNull();
  });

  it('returns null when no slug or no channel is given', () => {
    expect(AppService.getOrphan(db, '', 'verified')).toBeNull();
    expect(AppService.getOrphan(db, 'worldmonitor', '')).toBeNull();
    expect(AppService.getOrphan(db, null, null)).toBeNull();
  });

  it('returns null when only an active row exists', () => {
    db.prepare(`
      INSERT INTO apps (id, name, slug, status, app_type, external_slug, channel)
      VALUES ('a1', 'World Monitor', 'wm-a1', 'active', 'external', 'worldmonitor', 'verified')
    `).run();
    expect(AppService.getOrphan(db, 'worldmonitor', 'verified')).toBeNull();
  });

  it('returns the row for a matching uninstalled app', () => {
    insertOrphan(db, { id: '1700000000000-abc' });
    const o = AppService.getOrphan(db, 'worldmonitor', 'verified');
    expect(o).not.toBeNull();
    expect(o.appId).toBe('1700000000000-abc');
    expect(typeof o.uninstalledAt).toBe('string');
  });

  it('returns the most recent uninstalled row when multiple match', () => {
    insertOrphan(db, { id: 'old-id', updatedAt: '2024-01-01T00:00:00Z' });
    insertOrphan(db, { id: 'new-id', updatedAt: '2026-01-01T00:00:00Z' });
    expect(AppService.getOrphan(db, 'worldmonitor', 'verified').appId).toBe('new-id');
  });

  it('is channel-scoped (verified orphan does NOT match community reinstall)', () => {
    insertOrphan(db, { id: '1', channel: 'verified' });
    expect(AppService.getOrphan(db, 'worldmonitor', 'community')).toBeNull();
    expect(AppService.getOrphan(db, 'worldmonitor', 'verified')).not.toBeNull();
  });

  it('counts saved secrets for the orphan row', () => {
    insertOrphan(db, { id: '1' });
    db.prepare(`INSERT INTO app_env_variables (id, app_id, key, value) VALUES (?, ?, ?, ?)`)
      .run('e1', '1', 'API_KEY', 'sk-abc');
    db.prepare(`INSERT INTO app_env_variables (id, app_id, key, value) VALUES (?, ?, ?, ?)`)
      .run('e2', '1', 'TOKEN', 'tok');
    expect(AppService.getOrphan(db, 'worldmonitor', 'verified').secretCount).toBe(2);
  });

  it('reports blob byte size when the BLOB_DIR/<id> directory has content', () => {
    const { BLOB_DIR } = require('../src/config');
    const id = '1700000000000-blob';
    insertOrphan(db, { id });
    const blobDir = path.join(BLOB_DIR, id);
    fs.mkdirSync(blobDir, { recursive: true });
    fs.mkdirSync(path.join(blobDir, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(blobDir, 'a.txt'), 'x'.repeat(1024));
    fs.writeFileSync(path.join(blobDir, 'nested', 'b.txt'), 'y'.repeat(512));
    const o = AppService.getOrphan(db, 'worldmonitor', 'verified');
    expect(o.blobSize).toBeGreaterThanOrEqual(1024 + 512);
  });

  it('reports 0 blob size when the BLOB_DIR/<id> directory is missing', () => {
    insertOrphan(db, { id: '1' });
    const o = AppService.getOrphan(db, 'worldmonitor', 'verified');
    expect(o.blobSize).toBe(0);
  });
});

describe('AppService.reviveOrphan (PR 5.5)', () => {
  beforeEach(() => {
    insertOrphan(db, { id: 'orphan-id' });
  });

  it('flips status to installing and refreshes manifest fields', () => {
    const result = AppService.reviveOrphan(db, 'orphan-id', {
      name: 'World Monitor (revived)',
      externalSlug: 'worldmonitor',
      channel: 'verified',
      framework: 'vite',
      manifestYaml: 'schemaVersion: 1\n',
      manifestSha: 'sha-NEW',
      catalogCommitSha: 'cat-NEW',
      upstreamDeclaredRef: 'v3.0.0',
      upstreamResolvedCommit: 'a'.repeat(40),
    });
    expect(result.id).toBe('orphan-id');           // same appId reused
    expect(result.slug).toBe('wm-orphan-id');       // slug preserved

    const row = db.prepare('SELECT * FROM apps WHERE id = ?').get('orphan-id');
    expect(row.status).toBe('installing');
    expect(row.name).toBe('World Monitor (revived)');
    expect(row.manifest_sha).toBe('sha-NEW');
    expect(row.upstream_resolved_commit).toBe('a'.repeat(40));
    expect(row.archived_at).toBeNull();
    expect(row.update_status).toBeNull();
  });

  it('throws on a missing appId', () => {
    expect(() => AppService.reviveOrphan(db, 'nope', {
      name: 'x', externalSlug: 'x', channel: 'verified',
    })).toThrow(/orphan app nope not found/);
  });

  it('throws on a non-uninstalled row', () => {
    db.prepare(`UPDATE apps SET status = 'active' WHERE id = ?`).run('orphan-id');
    expect(() => AppService.reviveOrphan(db, 'orphan-id', {
      name: 'x', externalSlug: 'worldmonitor', channel: 'verified',
    })).toThrow(/not uninstalled/);
  });

  it('preserves saved secrets across revival', () => {
    db.prepare(`INSERT INTO app_env_variables (id, app_id, key, value)
                VALUES ('e1', 'orphan-id', 'API_KEY', 'sk-preserved')`).run();
    AppService.reviveOrphan(db, 'orphan-id', {
      name: 'x', externalSlug: 'worldmonitor', channel: 'verified',
    });
    const sec = db.prepare(`SELECT value FROM app_env_variables WHERE app_id = 'orphan-id' AND key = 'API_KEY'`).get();
    expect(sec.value).toBe('sk-preserved');
  });
});

describe('AppService.archiveOrphan (PR 5.5)', () => {
  it('flips an uninstalled row to archived', () => {
    insertOrphan(db, { id: '1' });
    AppService.archiveOrphan(db, '1');
    const row = db.prepare(`SELECT status, archived_at FROM apps WHERE id = ?`).get('1');
    expect(row.status).toBe('archived');
    expect(row.archived_at).not.toBeNull();
  });

  it('does not touch a non-uninstalled row', () => {
    db.prepare(`
      INSERT INTO apps (id, name, slug, status, app_type, external_slug, channel)
      VALUES ('1', 'World Monitor', 'wm-1', 'active', 'external', 'worldmonitor', 'verified')
    `).run();
    AppService.archiveOrphan(db, '1');
    const row = db.prepare(`SELECT status FROM apps WHERE id = ?`).get('1');
    expect(row.status).toBe('active');
  });

  it('removes the row from getOrphan results after archiving', () => {
    insertOrphan(db, { id: '1' });
    expect(AppService.getOrphan(db, 'worldmonitor', 'verified')).not.toBeNull();
    AppService.archiveOrphan(db, '1');
    expect(AppService.getOrphan(db, 'worldmonitor', 'verified')).toBeNull();
  });
});
