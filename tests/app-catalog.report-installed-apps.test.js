import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const Database = require('better-sqlite3');
const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
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

describe('AppCatalogService.reportInstalledApps — Phase 4 PR 4.3', () => {
  let db, tmpHome, prevHome, AppCatalogService, MIGRATION;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-heartbeat-'));
    prevHome = process.env.OS8_HOME;
    process.env.OS8_HOME = tmpHome;
    [
      '../src/config',
      '../src/migrations/0.5.0-app-store',
      '../src/services/app-catalog',
    ].forEach(p => { delete require.cache[require.resolve(p)]; });

    MIGRATION = require('../src/migrations/0.5.0-app-store');
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

  function insertApp({ id, slug, channel = 'verified', status = 'active', commit = 'b'.repeat(40) }) {
    db.prepare(`
      INSERT INTO apps (id, name, slug, status, app_type, channel, external_slug, upstream_resolved_commit)
      VALUES (?, ?, ?, ?, 'external', ?, ?, ?)
    `).run(id, slug, slug, status, channel, slug, commit);
  }

  it('skips when no session cookie is provided', async () => {
    insertApp({ id: 'a1', slug: 'verified-app' });
    const fetchImpl = vi.fn();
    const r = await AppCatalogService.reportInstalledApps(db, {
      fetchImpl,
      getSessionCookie: () => null,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no os8.ai session/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('POSTs the apps array when session cookie present', async () => {
    insertApp({ id: 'a1', slug: 'a-yes',     channel: 'verified',  commit: 'a'.repeat(40) });
    insertApp({ id: 'a2', slug: 'b-comm',    channel: 'community', commit: 'b'.repeat(40) });

    const fetchImpl = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ ok: true, count: 2, removed: 0 }), { status: 200 }
    ));

    const r = await AppCatalogService.reportInstalledApps(db, {
      fetchImpl,
      getSessionCookie: () => 'session=abc123',
    });

    expect(r.ok).toBe(true);
    expect(r.count).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://os8.ai/api/account/installed-apps');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Cookie).toBe('session=abc123');
    const body = JSON.parse(opts.body);
    expect(body.apps).toEqual([
      { slug: 'a-yes',  commit: 'a'.repeat(40), channel: 'verified' },
      { slug: 'b-comm', commit: 'b'.repeat(40), channel: 'community' },
    ]);
  });

  it('omits inactive / non-external / orphan-commit rows', async () => {
    insertApp({ id: 'a1', slug: 'active',   status: 'active' });
    insertApp({ id: 'a2', slug: 'archived', status: 'archived' });
    insertApp({ id: 'a3', slug: 'uninstalled', status: 'uninstalled' });
    db.prepare(`
      INSERT INTO apps (id, name, slug, status, app_type)
      VALUES ('a4', 'native', 'native-app', 'active', 'regular')
    `).run();
    db.prepare(`
      INSERT INTO apps (id, name, slug, status, app_type, channel, external_slug, upstream_resolved_commit)
      VALUES ('a5', 'no commit', 'no-commit', 'active', 'external', 'verified', 'no-commit', NULL)
    `).run();

    const fetchImpl = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ ok: true, count: 1 }), { status: 200 }
    ));

    await AppCatalogService.reportInstalledApps(db, {
      fetchImpl,
      getSessionCookie: () => 'session=x',
    });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.apps.map(a => a.slug)).toEqual(['active']);
  });

  it('returns ok:false on HTTP error without throwing', async () => {
    insertApp({ id: 'a1', slug: 'a' });
    const fetchImpl = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    const r = await AppCatalogService.reportInstalledApps(db, {
      fetchImpl,
      getSessionCookie: () => 'session=x',
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(500);
  });

  it('returns ok:false on network error without throwing', async () => {
    insertApp({ id: 'a1', slug: 'a' });
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await AppCatalogService.reportInstalledApps(db, {
      fetchImpl,
      getSessionCookie: () => 'session=x',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/ECONNREFUSED/);
  });

  it('honors OS8_API_BASE_URL env override (test-friendly)', async () => {
    insertApp({ id: 'a1', slug: 'a' });
    process.env.OS8_API_BASE_URL = 'http://localhost:9999';
    const fetchImpl = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ ok: true }), { status: 200 }
    ));
    await AppCatalogService.reportInstalledApps(db, {
      fetchImpl,
      getSessionCookie: () => 'session=x',
    });
    expect(fetchImpl.mock.calls[0][0]).toBe('http://localhost:9999/api/account/installed-apps');
    delete process.env.OS8_API_BASE_URL;
  });
});
