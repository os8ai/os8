import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const Database = require('better-sqlite3');

function makeDbWithUser(userId) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE user_account (
      id TEXT PRIMARY KEY,
      os8_user_id TEXT,
      username TEXT,
      display_name TEXT,
      avatar_url TEXT,
      email TEXT,
      updated_at TEXT
    );
  `);
  if (userId) {
    db.prepare(`
      INSERT INTO user_account (id, os8_user_id, email) VALUES ('local', ?, 'leo@os8.ai')
    `).run(userId);
  }
  return db;
}

function fakeMainWindow() {
  const send = vi.fn();
  return {
    isDestroyed: () => false,
    webContents: { send },
    _send: send,
  };
}

function mockFetchOnce(impl) {
  const original = global.fetch;
  global.fetch = impl;
  return () => { global.fetch = original; };
}

describe('PendingInstallsPoller (PR 1.26)', () => {
  let restoreFetch, mod;

  beforeEach(() => {
    delete require.cache[require.resolve('../src/services/pending-installs-poller')];
    delete require.cache[require.resolve('../src/services/account')];
    mod = require('../src/services/pending-installs-poller');
  });

  afterEach(() => {
    if (restoreFetch) { restoreFetch(); restoreFetch = null; }
    mod.stop();
  });

  it('skips when no signed-in user', async () => {
    const db = makeDbWithUser(null);
    const win = fakeMainWindow();
    restoreFetch = mockFetchOnce(async () => { throw new Error('fetch should not run'); });
    const r = await mod._tick(db, win);
    expect(r.skipped).toBe(true);
    expect(win._send).not.toHaveBeenCalled();
    db.close();
  });

  it('skips when mainWindow is destroyed', async () => {
    const db = makeDbWithUser('user-1');
    const win = { isDestroyed: () => true, webContents: { send: vi.fn() } };
    const r = await mod._tick(db, win);
    expect(r.skipped).toBe(true);
    db.close();
  });

  it('skips silently on 401/404 (endpoint not deployed yet)', async () => {
    const db = makeDbWithUser('user-1');
    const win = fakeMainWindow();
    restoreFetch = mockFetchOnce(async () => new Response('', { status: 404 }));
    const r = await mod._tick(db, win);
    expect(r.skipped).toBe(true);
    expect(r.status).toBe(404);
    db.close();
  });

  it('dispatches each pending install + fires consume', async () => {
    const db = makeDbWithUser('user-1');
    const win = fakeMainWindow();
    const calls = [];
    restoreFetch = mockFetchOnce(async (url, init) => {
      calls.push({ url, method: init?.method || 'GET' });
      if (url.includes('/pending-installs?')) {
        return new Response(JSON.stringify({
          pendingInstalls: [
            {
              id: 'p1', appSlug: 'worldmonitor',
              upstreamResolvedCommit: 'a'.repeat(40),
              channel: 'verified',
            },
            {
              id: 'p2', appSlug: 'newscube',
              upstreamResolvedCommit: 'b'.repeat(40),
              channel: 'verified',
            },
          ],
        }), { status: 200 });
      }
      return new Response('{"ok":true}', { status: 200 });
    });

    const r = await mod._tick(db, win);
    expect(r.dispatched).toBe(2);
    expect(win._send).toHaveBeenCalledTimes(2);
    expect(win._send).toHaveBeenCalledWith('app-store:open-install-plan', expect.objectContaining({
      slug: 'worldmonitor', source: 'os8.ai-cross-device', pendingInstallId: 'p1',
    }));

    // Two consume calls (fire-and-forget) — don't await; just check that fetch
    // was invoked the right number of times.
    await new Promise(r => setTimeout(r, 50));
    const consumes = calls.filter(c => c.method === 'POST' && c.url.includes('/consume'));
    expect(consumes.length).toBe(2);
    db.close();
  });

  it('skips malformed pending install rows', async () => {
    const db = makeDbWithUser('user-1');
    const win = fakeMainWindow();
    restoreFetch = mockFetchOnce(async () => new Response(
      JSON.stringify({
        pendingInstalls: [
          { id: 'p1', appSlug: '', upstreamResolvedCommit: 'a'.repeat(40) },   // empty slug
          { id: 'p2', appSlug: 'good', upstreamResolvedCommit: '' },           // empty commit
          { id: 'p3', appSlug: 'good', upstreamResolvedCommit: 'a'.repeat(40), channel: 'verified' },
        ],
      }),
      { status: 200 }
    ));
    const r = await mod._tick(db, win);
    expect(r.dispatched).toBe(1);
    expect(win._send).toHaveBeenCalledWith('app-store:open-install-plan', expect.objectContaining({
      slug: 'good',
    }));
    db.close();
  });

  it('survives fetch network failure', async () => {
    const db = makeDbWithUser('user-1');
    const win = fakeMainWindow();
    restoreFetch = mockFetchOnce(async () => { throw new Error('offline'); });
    const r = await mod._tick(db, win);
    expect(r.skipped).toBe(true);
    expect(r.error).toMatch(/offline/);
    db.close();
  });

  it('start/stop are idempotent', () => {
    const db = makeDbWithUser('user-1');
    const win = fakeMainWindow();
    mod.start(db, win, { intervalMs: 999_999 });
    mod.start(db, win, { intervalMs: 999_999 });   // replaces previous timer
    mod.stop();
    mod.stop();   // safe to double-stop
    db.close();
  });
});
