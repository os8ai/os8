/**
 * Phase 5 PR 5.6 — AppCatalogService.get with refreshIfOlderThan opt.
 *
 * Per-install lazy refresh: when a caller passes `refreshIfOlderThan`
 * (the install pipeline does, with 5 min), get() re-fetches the manifest
 * from os8.ai when the cached row's synced_at is older than the
 * threshold. Catches the Phase 3.5.5 incident scenario where a manifest
 * was updated in the catalog minutes before an install attempt.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const Database = require('better-sqlite3');
const AppCatalogService = require('../src/services/app-catalog');

function makeDbWithCatalog() {
  const db = new Database(':memory:');
  // Minimal app_catalog shape — mirrors the columns used by get().
  db.exec(`
    CREATE TABLE app_catalog (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT,
      description TEXT,
      publisher TEXT,
      channel TEXT NOT NULL,
      category TEXT,
      icon_url TEXT,
      screenshots TEXT,
      manifest_yaml TEXT,
      manifest_sha TEXT,
      catalog_commit_sha TEXT,
      upstream_declared_ref TEXT,
      upstream_resolved_commit TEXT,
      license TEXT,
      runtime_kind TEXT,
      framework TEXT,
      architectures TEXT,
      risk_level TEXT,
      install_count INTEGER DEFAULT 0,
      rating INTEGER,
      synced_at TEXT,
      deleted_at TEXT
    );
  `);
  return db;
}

function seedRow(db, overrides = {}) {
  const row = {
    id: 'wm-1',
    slug: 'worldmonitor',
    name: 'World Monitor',
    description: 'Real-time global intelligence dashboard.',
    publisher: 'koala73',
    channel: 'verified',
    category: 'intelligence',
    icon_url: null,
    screenshots: '[]',
    manifest_yaml: 'schemaVersion: 1\nslug: worldmonitor\n',
    manifest_sha: 'sha-1',
    catalog_commit_sha: 'cat-sha-1',
    upstream_declared_ref: 'v2.5.23',
    upstream_resolved_commit: 'e51058e1765ef2f0c83ccb1d08d984bc59d23f10',
    license: 'AGPL-3.0',
    runtime_kind: 'node',
    framework: 'vite',
    architectures: '["arm64","x86_64"]',
    risk_level: 'low',
    install_count: 0,
    rating: null,
    synced_at: new Date().toISOString(),
    deleted_at: null,
    ...overrides,
  };
  db.prepare(`
    INSERT INTO app_catalog (
      id, slug, name, description, publisher, channel, category, icon_url,
      screenshots, manifest_yaml, manifest_sha, catalog_commit_sha,
      upstream_declared_ref, upstream_resolved_commit, license, runtime_kind,
      framework, architectures, risk_level, install_count, rating,
      synced_at, deleted_at
    ) VALUES (
      @id, @slug, @name, @description, @publisher, @channel, @category, @icon_url,
      @screenshots, @manifest_yaml, @manifest_sha, @catalog_commit_sha,
      @upstream_declared_ref, @upstream_resolved_commit, @license, @runtime_kind,
      @framework, @architectures, @risk_level, @install_count, @rating,
      @synced_at, @deleted_at
    )
  `).run(row);
  return row;
}

function ageSyncedAt(db, slug, ageMs) {
  const past = new Date(Date.now() - ageMs).toISOString();
  db.prepare(`UPDATE app_catalog SET synced_at = ? WHERE slug = ?`).run(past, slug);
}

describe('AppCatalogService.get — refreshIfOlderThan (PR 5.6)', () => {
  let db;
  let fetchSpy;

  beforeEach(() => {
    db = makeDbWithCatalog();
    // Default fetch mock — should NOT be called unless a test overrides.
    fetchSpy = vi.fn(async () => {
      throw new Error('fetch should not be called in this test');
    });
    global.fetch = fetchSpy;
  });

  afterEach(() => {
    db.close();
    delete global.fetch;
  });

  it('returns cached row without fetching when refreshIfOlderThan is omitted', async () => {
    seedRow(db);
    const entry = await AppCatalogService.get(db, 'worldmonitor', { channel: 'verified' });
    expect(entry).not.toBeNull();
    expect(entry.slug).toBe('worldmonitor');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns cached row when refreshIfOlderThan set but row is younger than threshold', async () => {
    seedRow(db);
    // synced_at is "now" — well within any reasonable threshold.
    const entry = await AppCatalogService.get(db, 'worldmonitor', {
      channel: 'verified',
      refreshIfOlderThan: 60_000,
    });
    expect(entry).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches and upserts when row is older than threshold AND upstream changed', async () => {
    seedRow(db, { manifest_sha: 'sha-old' });
    ageSyncedAt(db, 'worldmonitor', 10 * 60_000); // 10 min ago

    fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        app: {
          id: 'wm-1',
          slug: 'worldmonitor',
          name: 'World Monitor',
          description: 'Real-time global intelligence dashboard.',
          publisher: 'koala73',
          channel: 'verified',
          category: 'intelligence',
          iconUrl: null,
          screenshots: [],
          manifestYaml: 'schemaVersion: 1\nslug: worldmonitor\n# updated\n',
          manifestSha: 'sha-NEW',
          catalogCommitSha: 'cat-sha-2',
          upstreamDeclaredRef: 'v2.5.24',
          upstreamResolvedCommit: 'a'.repeat(40),
          license: 'AGPL-3.0',
          runtimeKind: 'node',
          framework: 'vite',
          architectures: ['arm64', 'x86_64'],
          riskLevel: 'low',
          installCount: 0,
          rating: null,
        },
      }),
    }));
    global.fetch = fetchSpy;

    const entry = await AppCatalogService.get(db, 'worldmonitor', {
      channel: 'verified',
      refreshIfOlderThan: 5 * 60_000,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(entry).not.toBeNull();
    // Upserted — new manifest_sha + new commit reflected.
    expect(entry.manifestSha).toBe('sha-NEW');
    expect(entry.upstreamResolvedCommit).toBe('a'.repeat(40));
    // synced_at refreshed.
    const row = db.prepare(`SELECT synced_at FROM app_catalog WHERE slug = 'worldmonitor'`).get();
    const ageMs = Date.now() - new Date(row.synced_at).getTime();
    expect(ageMs).toBeLessThan(5_000); // refreshed in the last few seconds
  });

  it('returns the cached row on fetch network failure (best-effort)', async () => {
    seedRow(db, { manifest_sha: 'sha-stable' });
    ageSyncedAt(db, 'worldmonitor', 10 * 60_000);

    fetchSpy = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    global.fetch = fetchSpy;

    const entry = await AppCatalogService.get(db, 'worldmonitor', {
      channel: 'verified',
      refreshIfOlderThan: 5 * 60_000,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(entry).not.toBeNull();
    // Still returns the cached row.
    expect(entry.manifestSha).toBe('sha-stable');
  });

  it('returns the cached row on fetch 404 (slug removed upstream — keep local)', async () => {
    seedRow(db, { manifest_sha: 'sha-stable' });
    ageSyncedAt(db, 'worldmonitor', 10 * 60_000);

    fetchSpy = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: 'not found' }),
    }));
    global.fetch = fetchSpy;

    const entry = await AppCatalogService.get(db, 'worldmonitor', {
      channel: 'verified',
      refreshIfOlderThan: 5 * 60_000,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(entry).not.toBeNull();
    expect(entry.manifestSha).toBe('sha-stable');
  });

  it('does not fetch when synced_at is exactly at the threshold (boundary)', async () => {
    seedRow(db);
    // synced_at is "now" — refreshIfOlderThan check uses `> threshold`, so
    // a 0-ms threshold would still skip. Test the more meaningful boundary:
    // age slightly LESS than threshold.
    ageSyncedAt(db, 'worldmonitor', 4 * 60_000); // 4 min < 5 min threshold
    const entry = await AppCatalogService.get(db, 'worldmonitor', {
      channel: 'verified',
      refreshIfOlderThan: 5 * 60_000,
    });
    expect(entry).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('handles missing synced_at gracefully (treats as not-aged-out)', async () => {
    seedRow(db, { synced_at: null });
    const entry = await AppCatalogService.get(db, 'worldmonitor', {
      channel: 'verified',
      refreshIfOlderThan: 5 * 60_000,
    });
    expect(entry).not.toBeNull();
    // No synced_at to compare against — skip the refresh path.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
