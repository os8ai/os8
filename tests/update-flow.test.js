import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'node:child_process';

const Database = require('better-sqlite3');
const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

function makeRepoWithCommits(parent) {
  const dir = path.join(parent, 'wm');
  fs.mkdirSync(dir, { recursive: true });
  spawnSync('git', ['init', '-q', '--initial-branch=main'], { cwd: dir });
  spawnSync('git', ['-C', dir, 'config', 'user.email', 'tester@example.com']);
  spawnSync('git', ['-C', dir, 'config', 'user.name', 'Tester']);

  fs.writeFileSync(path.join(dir, 'README.md'), '# v1\n');
  spawnSync('git', ['-C', dir, 'add', '.']);
  spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'v1']);
  const v1 = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD']).stdout.toString().trim();
  // Branch user/main from v1.
  spawnSync('git', ['-C', dir, 'checkout', '-q', '-b', 'user/main']);

  // Switch back and add a v2 commit upstream.
  spawnSync('git', ['-C', dir, 'checkout', '-q', 'main']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# v2\n');
  spawnSync('git', ['-C', dir, 'add', '.']);
  spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'v2']);
  const v2 = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD']).stdout.toString().trim();

  // Reset HEAD to user/main (the "installed" state).
  spawnSync('git', ['-C', dir, 'checkout', '-q', 'user/main']);
  return { dir, v1, v2 };
}

describe('AppCatalogService.detectUpdates (PR 1.25)', () => {
  let db, tmpHome, prevHome, MIGRATION, AppCatalogService;

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-update-detect-'));
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
        status TEXT DEFAULT 'active', display_order INTEGER DEFAULT 0,
        color TEXT DEFAULT '#6366f1', icon TEXT, text_color TEXT DEFAULT '#ffffff',
        archived_at TEXT, app_type TEXT DEFAULT 'regular',
        created_at TEXT, updated_at TEXT
      );
      CREATE TABLE app_env_variables (
        id TEXT PRIMARY KEY, app_id TEXT REFERENCES apps(id) ON DELETE CASCADE,
        key TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(app_id, key)
      );
    `);
    await MIGRATION.up({ db, logger: silentLogger });
  });

  afterEach(() => {
    db.close();
    if (prevHome === undefined) delete process.env.OS8_HOME;
    else process.env.OS8_HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function seedAppAndCatalog(appCommit, catalogCommit) {
    db.prepare(`
      INSERT INTO apps (id, name, slug, app_type, status, external_slug, channel,
                        upstream_resolved_commit)
      VALUES ('a1', 'WM', 'wm', 'external', 'active', 'wm', 'verified', ?)
    `).run(appCommit);
    db.prepare(`
      INSERT INTO app_catalog (id, slug, name, channel, manifest_sha,
        catalog_commit_sha, upstream_declared_ref, upstream_resolved_commit)
      VALUES ('c1', 'wm', 'WM', 'verified', 'sha', 'cat', 'v1', ?)
    `).run(catalogCommit);
  }

  it('flags an app whose catalog has moved to a newer commit', () => {
    seedAppAndCatalog('a'.repeat(40), 'b'.repeat(40));
    const flagged = AppCatalogService.detectUpdates(db);
    expect(flagged).toBe(1);
    const row = db.prepare(`SELECT update_available, update_to_commit FROM apps WHERE id='a1'`).get();
    expect(row.update_available).toBe(1);
    expect(row.update_to_commit).toBe('b'.repeat(40));
  });

  it('does not flag when commits match', () => {
    seedAppAndCatalog('a'.repeat(40), 'a'.repeat(40));
    expect(AppCatalogService.detectUpdates(db)).toBe(0);
  });

  it('does not re-flag an already-flagged app for the same target', () => {
    seedAppAndCatalog('a'.repeat(40), 'b'.repeat(40));
    AppCatalogService.detectUpdates(db);
    const before = db.prepare(`SELECT updated_at FROM apps WHERE id='a1'`).get().updated_at;
    expect(AppCatalogService.detectUpdates(db)).toBe(0);
    const after = db.prepare(`SELECT updated_at FROM apps WHERE id='a1'`).get().updated_at;
    expect(after).toBe(before);
  });

  it('skips deleted catalog rows', () => {
    seedAppAndCatalog('a'.repeat(40), 'b'.repeat(40));
    db.prepare(`UPDATE app_catalog SET deleted_at = datetime('now') WHERE id='c1'`).run();
    expect(AppCatalogService.detectUpdates(db)).toBe(0);
  });

  it('skips non-active apps', () => {
    seedAppAndCatalog('a'.repeat(40), 'b'.repeat(40));
    db.prepare(`UPDATE apps SET status = 'uninstalled' WHERE id='a1'`).run();
    expect(AppCatalogService.detectUpdates(db)).toBe(0);
  });
});

describe('AppCatalogService.update (PR 1.25)', () => {
  let db, tmpHome, prevHome, MIGRATION, AppCatalogService;
  let repo;

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-update-apply-'));
    prevHome = process.env.OS8_HOME;
    process.env.OS8_HOME = tmpHome;
    [
      '../src/config',
      '../src/migrations/0.5.0-app-store',
      '../src/services/app-catalog',
      '../src/services/app',
    ].forEach(p => { delete require.cache[require.resolve(p)]; });
    MIGRATION = require('../src/migrations/0.5.0-app-store');
    AppCatalogService = require('../src/services/app-catalog');

    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE apps (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
        status TEXT DEFAULT 'active', display_order INTEGER DEFAULT 0,
        color TEXT DEFAULT '#6366f1', icon TEXT, text_color TEXT DEFAULT '#ffffff',
        archived_at TEXT, app_type TEXT DEFAULT 'regular',
        created_at TEXT, updated_at TEXT
      );
      CREATE TABLE app_env_variables (
        id TEXT PRIMARY KEY, app_id TEXT REFERENCES apps(id) ON DELETE CASCADE,
        key TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(app_id, key)
      );
    `);
    await MIGRATION.up({ db, logger: silentLogger });

    // Create a real git fixture inside OS8_HOME's apps/ so AppCatalogService.update
    // can git-fetch + checkout without network. The repo has v1 and v2 commits;
    // user/main is at v1.
    fs.mkdirSync(path.join(tmpHome, 'apps'), { recursive: true });
    repo = makeRepoWithCommits(path.join(tmpHome, 'apps'));
    // Rename to a deterministic appId so the test asserts cleanly.
    fs.renameSync(repo.dir, path.join(tmpHome, 'apps', 'app-1'));
    repo.dir = path.join(tmpHome, 'apps', 'app-1');

    db.prepare(`
      INSERT INTO apps (id, name, slug, app_type, status, external_slug, channel,
                        upstream_resolved_commit, update_available, update_to_commit)
      VALUES ('app-1', 'WM', 'wm', 'external', 'active', 'wm', 'verified', ?, 1, ?)
    `).run(repo.v1, repo.v2);
  });

  afterEach(() => {
    db.close();
    if (prevHome === undefined) delete process.env.OS8_HOME;
    else process.env.OS8_HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('rejects a non-SHA targetCommit', async () => {
    await expect(AppCatalogService.update(db, 'app-1', 'v2.5.0')).rejects.toThrow(/40-char SHA/);
  });

  it('fast-forwards user/main when no user_branch is set', async () => {
    const r = await AppCatalogService.update(db, 'app-1', repo.v2);
    expect(r.kind).toBe('updated');
    expect(r.hadUserEdits).toBe(false);
    // README content reflects v2.
    expect(fs.readFileSync(path.join(repo.dir, 'README.md'), 'utf8')).toBe('# v2\n');
    // Apps row updated.
    const row = db.prepare(`SELECT upstream_resolved_commit, update_available FROM apps WHERE id='app-1'`).get();
    expect(row.upstream_resolved_commit).toBe(repo.v2);
    expect(row.update_available).toBe(0);
  });

  it('three-way-merges into user/main when user_branch is set + no conflict', async () => {
    // User commits a non-conflicting file.
    fs.writeFileSync(path.join(repo.dir, 'OTHER.md'), '# my notes\n');
    spawnSync('git', ['-C', repo.dir, 'add', 'OTHER.md']);
    spawnSync('git', ['-C', repo.dir, '-c', 'user.email=u@u', '-c', 'user.name=User',
      'commit', '-q', '-m', 'user notes']);
    db.prepare(`UPDATE apps SET user_branch = 'user/main' WHERE id='app-1'`).run();

    const r = await AppCatalogService.update(db, 'app-1', repo.v2);
    expect(r.kind).toBe('updated');
    expect(r.hadUserEdits).toBe(true);
    expect(fs.readFileSync(path.join(repo.dir, 'OTHER.md'), 'utf8')).toBe('# my notes\n');
    expect(fs.readFileSync(path.join(repo.dir, 'README.md'), 'utf8')).toBe('# v2\n');
  });

  it('returns { kind: "conflict", files } on a real merge conflict', async () => {
    // User commits a CONFLICTING change to README.md (the same file v2 modified).
    fs.writeFileSync(path.join(repo.dir, 'README.md'), '# user-changed\n');
    spawnSync('git', ['-C', repo.dir, 'add', 'README.md']);
    spawnSync('git', ['-C', repo.dir, '-c', 'user.email=u@u', '-c', 'user.name=User',
      'commit', '-q', '-m', 'user version']);
    db.prepare(`UPDATE apps SET user_branch = 'user/main' WHERE id='app-1'`).run();

    const r = await AppCatalogService.update(db, 'app-1', repo.v2);
    expect(r.kind).toBe('conflict');
    expect(r.files).toContain('README.md');
    const row = db.prepare(`SELECT update_status FROM apps WHERE id='app-1'`).get();
    expect(row.update_status).toBe('conflict');
  });
});
