/**
 * AppGit — fork-on-first-edit operations for external apps.
 *
 * Spec §6.7 + plan §3 PR 1.23. PR 1.16's installer already runs `git init`
 * + creates the `user/main` branch + the `upstream/manifest` tracking ref.
 * This module adds the runtime layer:
 *
 *   - startDebouncedCommitter(appDir) — chokidar-driven 5s-window
 *     auto-committer. The registry's onProgress hook (PR 1.12) feeds
 *     `onChange(file)` per touched path; commits batch into a single
 *     `[user] <ISO ts> <touched files>` message on the user/main branch.
 *
 *   - checkOnActivation(appDir) — inspect git state when the user opens
 *     dev mode. Returns 'clean' or 'dirty' with the working-tree status.
 *
 *   - continueOnDirty / resetToManifest / stashAndContinue — the three
 *     recovery paths the dev-mode UI offers when a dirty tree is found.
 *
 * All git operations spawn with `shell: false` and argv arrays.
 */

const path = require('path');
const { spawn } = require('node:child_process');

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${stderr.trim().slice(-300)}`));
    });
  });
}

/**
 * Build a debounced auto-committer.
 *
 * Returns:
 *   onChange(file)  — call per chokidar event; batches into a 5s commit window.
 *   pause()         — cancel any pending commit (use during adapter ops).
 *   flush()         — commit immediately (used on app close / process stop).
 */
function startDebouncedCommitter(appDir, { debounceMs = 5000, onCommit, runner = runCmd } = {}) {
  let pending = null;
  let touched = new Set();

  async function commitNow() {
    if (touched.size === 0) return;
    const files = [...touched];
    touched.clear();
    pending = null;
    try {
      await runner('git', ['-C', appDir, 'add', '-A']);
      const status = await runner('git', ['-C', appDir, 'status', '--porcelain']);
      if (!status.trim()) return;
      // Make sure we're on user/main; if a prior reset put us on detached HEAD,
      // re-create the branch in place. -B is "create or move".
      await runner('git', ['-C', appDir, 'checkout', '-B', 'user/main']).catch(() => {});
      const summary = files.slice(0, 5).join(' ') + (files.length > 5 ? ' …' : '');
      const msg = `[user] ${new Date().toISOString()} ${summary}`.slice(0, 1000);
      await runner('git', ['-C', appDir, '-c', 'user.email=os8@os8.local',
        '-c', 'user.name=OS8', 'commit', '-q', '-m', msg]);
      onCommit?.({ files, message: msg });
    } catch (e) {
      console.warn('[app-git] commit:', e?.message);
    }
  }

  return {
    onChange(file) {
      touched.add(path.relative(appDir, file));
      if (pending) clearTimeout(pending);
      pending = setTimeout(commitNow, debounceMs);
      pending.unref?.();
    },
    pause() {
      if (pending) clearTimeout(pending);
      pending = null;
    },
    async flush() {
      if (pending) clearTimeout(pending);
      pending = null;
      await commitNow();
    },
    // Test-only inspection.
    _inspect: () => ({ touched: [...touched], pending: !!pending }),
  };
}

/**
 * Inspect the working tree on dev-mode activation. The renderer surfaces a
 * recovery dialog when `kind === 'dirty'`.
 */
async function checkOnActivation(appDir, { runner = runCmd } = {}) {
  const branch = (await runner('git', ['-C', appDir, 'branch', '--show-current'])).trim();
  const status = await runner('git', ['-C', appDir, 'status', '--porcelain']);
  if (!status.trim()) return { kind: 'clean', branch };
  return {
    kind: 'dirty',
    branch,
    status,
    untracked: /(^|\n)\?\? /.test(status),
  };
}

/** Continue: switch to user/main if not already; leave files as-is. */
async function continueOnDirty(appDir, { runner = runCmd } = {}) {
  const cur = (await runner('git', ['-C', appDir, 'branch', '--show-current'])).trim();
  if (cur !== 'user/main') {
    await runner('git', ['-C', appDir, 'checkout', '-B', 'user/main']);
  }
}

/** Reset: blow away local changes, restore the upstream commit. */
async function resetToManifest(appDir, resolvedCommit, { runner = runCmd } = {}) {
  if (!resolvedCommit) throw new Error('resetToManifest: resolvedCommit required');
  await runner('git', ['-C', appDir, 'checkout', resolvedCommit, '--', '.']);
  await runner('git', ['-C', appDir, 'clean', '-fd']);
}

/** Stash: tuck the dirty changes away under an OS8-prefixed stash entry. */
async function stashAndContinue(appDir, { runner = runCmd } = {}) {
  await runner('git', ['-C', appDir, 'stash', 'push', '-u',
    '-m', `os8 auto-stash ${new Date().toISOString()}`]);
  await runner('git', ['-C', appDir, 'checkout', '-B', 'user/main']);
}

module.exports = {
  startDebouncedCommitter,
  checkOnActivation,
  continueOnDirty,
  resetToManifest,
  stashAndContinue,
  // Internal — exposed for tests.
  _runCmd: runCmd,
};
