import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'node:child_process';

const AppGit = require('../src/services/app-git');

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-git-'));
  spawnSync('git', ['init', '-q', '--initial-branch=main'], { cwd: dir });
  spawnSync('git', ['-C', dir, 'config', 'user.email', 'tester@example.com']);
  spawnSync('git', ['-C', dir, 'config', 'user.name', 'Tester']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  spawnSync('git', ['-C', dir, 'add', '.']);
  spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'initial']);
  spawnSync('git', ['-C', dir, 'checkout', '-q', '-b', 'user/main']);
  return dir;
}

function gitHead(dir) {
  return spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD']).stdout.toString().trim();
}
function gitLog(dir) {
  return spawnSync('git', ['-C', dir, 'log', '--format=%s']).stdout.toString().trim().split('\n');
}

describe('AppGit.checkOnActivation', () => {
  let dir;
  beforeEach(() => { dir = makeRepo(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('returns clean on a fresh repo', async () => {
    const r = await AppGit.checkOnActivation(dir);
    expect(r.kind).toBe('clean');
    expect(r.branch).toBe('user/main');
  });

  it('returns dirty when the tree is modified', async () => {
    fs.writeFileSync(path.join(dir, 'README.md'), '# fixture (changed)\n');
    const r = await AppGit.checkOnActivation(dir);
    expect(r.kind).toBe('dirty');
    expect(r.untracked).toBe(false);
  });

  it('detects untracked files', async () => {
    fs.writeFileSync(path.join(dir, 'new.txt'), 'hi\n');
    const r = await AppGit.checkOnActivation(dir);
    expect(r.kind).toBe('dirty');
    expect(r.untracked).toBe(true);
  });
});

describe('AppGit.startDebouncedCommitter', () => {
  let dir;
  beforeEach(() => { dir = makeRepo(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('commits a single touched file after debounce window', async () => {
    const committer = AppGit.startDebouncedCommitter(dir, { debounceMs: 50 });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'first\n');
    committer.onChange(path.join(dir, 'a.txt'));
    await new Promise(r => setTimeout(r, 200));
    const log = gitLog(dir);
    expect(log[0]).toMatch(/^\[user\] /);
    expect(log[0]).toContain('a.txt');
  });

  it('batches multiple changes into one commit', async () => {
    const committer = AppGit.startDebouncedCommitter(dir, { debounceMs: 50 });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    committer.onChange(path.join(dir, 'a.txt'));
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
    committer.onChange(path.join(dir, 'b.txt'));
    fs.writeFileSync(path.join(dir, 'c.txt'), 'c\n');
    committer.onChange(path.join(dir, 'c.txt'));
    await new Promise(r => setTimeout(r, 200));
    const log = gitLog(dir);
    // One new commit on top of 'initial'.
    expect(log).toHaveLength(2);
    expect(log[0]).toMatch(/a\.txt|b\.txt|c\.txt/);
  });

  it('flush() commits immediately', async () => {
    const committer = AppGit.startDebouncedCommitter(dir, { debounceMs: 60_000 });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'first\n');
    committer.onChange(path.join(dir, 'a.txt'));
    expect(committer._inspect().pending).toBe(true);
    await committer.flush();
    expect(committer._inspect().pending).toBe(false);
    expect(gitLog(dir)).toHaveLength(2);
  });

  it('pause() cancels a pending commit', async () => {
    const committer = AppGit.startDebouncedCommitter(dir, { debounceMs: 50 });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'first\n');
    committer.onChange(path.join(dir, 'a.txt'));
    committer.pause();
    await new Promise(r => setTimeout(r, 150));
    expect(gitLog(dir)).toHaveLength(1);   // only 'initial'
  });

  it('does not commit when nothing is touched', async () => {
    const committer = AppGit.startDebouncedCommitter(dir, { debounceMs: 50 });
    await committer.flush();
    expect(gitLog(dir)).toHaveLength(1);
  });
});

describe('AppGit recovery actions', () => {
  let dir, baseSha;
  beforeEach(() => {
    dir = makeRepo();
    baseSha = gitHead(dir);
    // Make the tree dirty.
    fs.writeFileSync(path.join(dir, 'README.md'), '# changed\n');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'fresh\n');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('continueOnDirty leaves files in place + ensures user/main', async () => {
    spawnSync('git', ['-C', dir, 'checkout', '-q', 'main']);
    await AppGit.continueOnDirty(dir);
    const branch = spawnSync('git', ['-C', dir, 'branch', '--show-current']).stdout.toString().trim();
    expect(branch).toBe('user/main');
    // Files still dirty.
    expect(fs.readFileSync(path.join(dir, 'README.md'), 'utf8')).toBe('# changed\n');
  });

  it('resetToManifest restores files to the resolved commit', async () => {
    await AppGit.resetToManifest(dir, baseSha);
    expect(fs.readFileSync(path.join(dir, 'README.md'), 'utf8')).toBe('# fixture\n');
    expect(fs.existsSync(path.join(dir, 'new.txt'))).toBe(false);
  });

  it('resetToManifest throws when commit is missing', async () => {
    await expect(AppGit.resetToManifest(dir, null)).rejects.toThrow();
  });

  it('stashAndContinue tucks dirty changes away', async () => {
    await AppGit.stashAndContinue(dir);
    // Tree should be clean (or only show README's checked-out state).
    const r = await AppGit.checkOnActivation(dir);
    expect(r.kind).toBe('clean');
    // Stash list non-empty.
    const stashes = spawnSync('git', ['-C', dir, 'stash', 'list']).stdout.toString();
    expect(stashes).toContain('os8 auto-stash');
  });
});
