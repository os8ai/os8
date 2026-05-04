/**
 * Phase 5 PR 5.4 — AppMergeResolver service tests.
 *
 * Spins up a real git repo per test (tmpdir) so the service's git
 * commands run against actual git state. The repo simulates the shape
 * AppCatalogService.update produces: a `user/main` branch with local
 * commits + a target commit reachable from `origin` that conflicts
 * when merged.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'node:child_process';

const Database = require('better-sqlite3');

let prevHome, parent, db;
let AppMergeResolver, AppService;

function git(cwd, args, opts = {}) {
  const r = spawnSync('git', args, { cwd, stdio: 'pipe', ...opts });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} → ${r.status}: ${r.stderr?.toString() || ''}`);
  }
  return r.stdout?.toString() || '';
}

/**
 * Build a tmp git repo at apps/<appId>/ with a forced merge conflict
 * left in-progress. State after this:
 *   - user/main branch: contains user's local edit on App.tsx
 *   - HEAD == user/main
 *   - MERGE_HEAD set, MERGE_MSG set, App.tsx has <<<<<<< markers
 */
function makeConflictedRepo(appId) {
  const { APPS_DIR } = require('../src/config');
  const appDir = path.join(APPS_DIR, appId);
  fs.mkdirSync(appDir, { recursive: true });
  git(appDir, ['init', '-q', '--initial-branch=main']);
  git(appDir, ['config', 'user.email', 'tester@example.com']);
  git(appDir, ['config', 'user.name', 'Tester']);
  fs.writeFileSync(path.join(appDir, 'App.tsx'), 'export const v = 1;\n');
  git(appDir, ['add', '.']);
  git(appDir, ['commit', '-q', '-m', 'initial']);
  // Branch off — user/main is the editable branch in OS8's model.
  git(appDir, ['checkout', '-b', 'user/main']);
  fs.writeFileSync(path.join(appDir, 'App.tsx'), 'export const v = 1; // user edit\n');
  git(appDir, ['commit', '-aq', '-m', '[user] edit App.tsx']);
  // Build a divergent main commit on a separate ref so user/main can
  // try to merge it and conflict.
  git(appDir, ['checkout', 'main']);
  fs.writeFileSync(path.join(appDir, 'App.tsx'), 'export const v = 2;\n');
  git(appDir, ['commit', '-aq', '-m', 'upstream change']);
  const targetSha = git(appDir, ['rev-parse', 'HEAD']).trim();
  // Now merge target into user/main; expect conflict on App.tsx.
  git(appDir, ['checkout', 'user/main']);
  const mergeResult = spawnSync('git', ['merge', '--no-edit', targetSha], {
    cwd: appDir, stdio: 'pipe',
  });
  // Expect non-zero status (the conflict).
  if (mergeResult.status === 0) {
    throw new Error('test setup expected a merge conflict but git merge succeeded');
  }
  return { appDir, targetSha };
}

beforeEach(() => {
  parent = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-merge-'));
  prevHome = process.env.OS8_HOME;
  process.env.OS8_HOME = parent;

  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/services/app')];
  delete require.cache[require.resolve('../src/services/app-merge-resolver')];

  AppMergeResolver = require('../src/services/app-merge-resolver');
  ({ AppService } = require('../src/services/app'));

  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE apps (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'active',
      app_type TEXT DEFAULT 'regular',
      external_slug TEXT,
      channel TEXT,
      manifest_yaml TEXT,
      update_to_commit TEXT,
      update_status TEXT,
      update_conflict_files TEXT,
      update_available INTEGER DEFAULT 0,
      upstream_resolved_commit TEXT,
      updated_at TEXT
    );
  `);
});

afterEach(() => {
  try { db.close(); } catch (_) {}
  if (prevHome === undefined) delete process.env.OS8_HOME;
  else process.env.OS8_HOME = prevHome;
  try { fs.rmSync(parent, { recursive: true, force: true }); } catch (_) {}
});

describe('AppMergeResolver._parseConflictedFiles (PR 5.4)', () => {
  it('extracts UU/AA/etc. lines + drops other status codes', () => {
    const porcelain = [
      'UU src/App.tsx',
      ' M src/clean.tsx',
      'AA new-both-added.txt',
      '?? untracked.txt',
      'UD deleted-by-them.txt',
    ].join('\n');
    const files = AppMergeResolver._parseConflictedFiles(porcelain);
    expect(files).toEqual([
      { status: 'UU', path: 'src/App.tsx' },
      { status: 'AA', path: 'new-both-added.txt' },
      { status: 'UD', path: 'deleted-by-them.txt' },
    ]);
  });

  it('returns empty array for a clean tree', () => {
    expect(AppMergeResolver._parseConflictedFiles('')).toEqual([]);
    expect(AppMergeResolver._parseConflictedFiles(' M file.txt\n?? other.txt')).toEqual([]);
  });
});

describe('AppMergeResolver.getConflictState (PR 5.4)', () => {
  it('reports clean for a non-existent merge', () => {
    const { APPS_DIR } = require('../src/config');
    const appId = 'app-clean';
    const appDir = path.join(APPS_DIR, appId);
    fs.mkdirSync(appDir, { recursive: true });
    git(appDir, ['init', '-q', '--initial-branch=main']);
    git(appDir, ['config', 'user.email', 'tester@example.com']);
    git(appDir, ['config', 'user.name', 'Tester']);
    fs.writeFileSync(path.join(appDir, 'README.md'), '# clean\n');
    git(appDir, ['add', '.']);
    git(appDir, ['commit', '-q', '-m', 'initial']);

    db.prepare(`INSERT INTO apps (id, name, slug, app_type) VALUES (?, ?, ?, 'external')`)
      .run(appId, 'App', 'app-clean');

    return AppMergeResolver.getConflictState(db, appId).then(state => {
      expect(state.status).toBe('clean');
      expect(state.files).toEqual([]);
    });
  });

  it('reports conflict + file list during an in-progress merge', async () => {
    const appId = 'app-conflict';
    const { targetSha } = makeConflictedRepo(appId);

    db.prepare(`
      INSERT INTO apps (id, name, slug, app_type, update_status, update_to_commit)
      VALUES (?, ?, ?, 'external', 'conflict', ?)
    `).run(appId, 'App', 'app-conflict', targetSha);

    const state = await AppMergeResolver.getConflictState(db, appId);
    expect(state.status).toBe('conflict');
    expect(state.targetCommit).toBe(targetSha);
    expect(state.files).toEqual([{ status: 'UU', path: 'App.tsx' }]);
  });

  it('reconciles persisted conflict to clean when git reports no conflict', async () => {
    const { APPS_DIR } = require('../src/config');
    const appId = 'app-stale-conflict';
    const appDir = path.join(APPS_DIR, appId);
    fs.mkdirSync(appDir, { recursive: true });
    git(appDir, ['init', '-q', '--initial-branch=main']);
    git(appDir, ['config', 'user.email', 'tester@example.com']);
    git(appDir, ['config', 'user.name', 'Tester']);
    fs.writeFileSync(path.join(appDir, 'README.md'), '# clean\n');
    git(appDir, ['add', '.']);
    git(appDir, ['commit', '-q', '-m', 'initial']);

    // DB still says conflict (user resolved manually outside the UI).
    db.prepare(`
      INSERT INTO apps (id, name, slug, app_type, update_status, update_conflict_files)
      VALUES (?, ?, ?, 'external', 'conflict', '["src/App.tsx"]')
    `).run(appId, 'App', 'app-stale-conflict');

    const state = await AppMergeResolver.getConflictState(db, appId);
    expect(state.status).toBe('clean');

    const row = db.prepare(`SELECT update_status, update_conflict_files FROM apps WHERE id = ?`).get(appId);
    expect(row.update_status).toBeNull();
    expect(row.update_conflict_files).toBeNull();
  });

  it('throws on missing app', async () => {
    await expect(AppMergeResolver.getConflictState(db, 'nope')).rejects.toThrow(/not found/);
  });
});

describe('AppMergeResolver.markAllResolved (PR 5.4)', () => {
  it('throws STILL_CONFLICTED when files still have <<<<<<< markers', async () => {
    const appId = 'app-still-conflict';
    makeConflictedRepo(appId);
    // Don't touch App.tsx — the post-merge state already has the
    // <<<<<<< / ======= / >>>>>>> markers from git's failed merge.
    db.prepare(`INSERT INTO apps (id, name, slug, app_type, update_status)
                VALUES (?, ?, ?, 'external', 'conflict')`)
      .run(appId, 'App', 'app-still-conflict');

    let err;
    try { await AppMergeResolver.markAllResolved(db, appId); }
    catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.code).toBe('STILL_CONFLICTED');
    expect(err.files.map(f => f.path)).toContain('App.tsx');
  });

  it('commits + clears state when files are resolved', async () => {
    const appId = 'app-resolve';
    const { appDir, targetSha } = makeConflictedRepo(appId);
    db.prepare(`
      INSERT INTO apps (id, name, slug, app_type, update_status, update_to_commit, update_conflict_files)
      VALUES (?, ?, ?, 'external', 'conflict', ?, '["App.tsx"]')
    `).run(appId, 'App', 'app-resolve', targetSha);

    // Manually resolve App.tsx (pretend the user / AI did).
    fs.writeFileSync(path.join(appDir, 'App.tsx'), 'export const v = 99; // resolved\n');

    const r = await AppMergeResolver.markAllResolved(db, appId, { resolvedBy: 'user' });
    expect(r.ok).toBe(true);
    expect(r.commit).toBe(targetSha);

    // apps row state cleared + commit bumped.
    const row = db.prepare(`SELECT * FROM apps WHERE id = ?`).get(appId);
    expect(row.update_status).toBeNull();
    expect(row.update_conflict_files).toBeNull();
    expect(row.upstream_resolved_commit).toBe(targetSha);

    // git log shows the merge commit landed.
    const log = git(appDir, ['log', '--oneline', '-3']);
    expect(log).toMatch(/\[user-resolved\] merge from/);
  });

  it('uses the [ai-resolved] tag for resolvedBy=ai', async () => {
    const appId = 'app-ai-resolve';
    const { appDir, targetSha } = makeConflictedRepo(appId);
    db.prepare(`INSERT INTO apps (id, name, slug, app_type, update_status, update_to_commit)
                VALUES (?, ?, ?, 'external', 'conflict', ?)`)
      .run(appId, 'App', 'app-ai-resolve', targetSha);
    fs.writeFileSync(path.join(appDir, 'App.tsx'), 'resolved\n');
    await AppMergeResolver.markAllResolved(db, appId, { resolvedBy: 'ai' });
    const log = git(appDir, ['log', '--oneline', '-3']);
    expect(log).toMatch(/\[ai-resolved\] merge from/);
  });
});

describe('AppMergeResolver.abortMerge (PR 5.4)', () => {
  it('aborts an in-progress merge and clears state', async () => {
    const appId = 'app-abort';
    const { appDir, targetSha } = makeConflictedRepo(appId);
    db.prepare(`INSERT INTO apps (id, name, slug, app_type, update_status, update_to_commit, update_conflict_files)
                VALUES (?, ?, ?, 'external', 'conflict', ?, '["App.tsx"]')`)
      .run(appId, 'App', 'app-abort', targetSha);

    const r = await AppMergeResolver.abortMerge(db, appId);
    expect(r.ok).toBe(true);

    // No more conflicts in git status.
    const status = git(appDir, ['status', '--porcelain']);
    expect(AppMergeResolver._parseConflictedFiles(status)).toEqual([]);

    // apps row cleared.
    const row = db.prepare(`SELECT update_status, update_conflict_files FROM apps WHERE id = ?`).get(appId);
    expect(row.update_status).toBeNull();
    expect(row.update_conflict_files).toBeNull();
  });

  it('is idempotent — abort with no in-progress merge succeeds', async () => {
    const { APPS_DIR } = require('../src/config');
    const appId = 'app-no-merge';
    const appDir = path.join(APPS_DIR, appId);
    fs.mkdirSync(appDir, { recursive: true });
    git(appDir, ['init', '-q', '--initial-branch=main']);
    git(appDir, ['config', 'user.email', 'tester@example.com']);
    git(appDir, ['config', 'user.name', 'Tester']);
    fs.writeFileSync(path.join(appDir, 'README.md'), '# clean\n');
    git(appDir, ['add', '.']);
    git(appDir, ['commit', '-q', '-m', 'initial']);
    db.prepare(`INSERT INTO apps (id, name, slug, app_type) VALUES (?, ?, ?, 'external')`)
      .run(appId, 'App', 'app-no-merge');

    const r = await AppMergeResolver.abortMerge(db, appId);
    expect(r.ok).toBe(true);
  });
});
