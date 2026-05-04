/**
 * AppMergeResolver — Phase 5 PR 5.4.
 *
 * State + actions for the three-way merge UI surfaced when an
 * auto-update hits a conflict. PR 1.25's AppCatalogService.update sets
 * `apps.update_status='conflict'` on merge failure; PR 5.4's renderer
 * consumes the methods here to drive resolution.
 *
 * Three operations:
 *   - getConflictState(db, appId) — returns { status, files, ... }
 *   - markAllResolved(db, appId)   — git add -u + commit, clear status
 *   - abortMerge(db, appId)        — git merge --abort, clear status
 *
 * `git status --porcelain` is the source of truth for currently-conflicted
 * files; the persisted apps.update_conflict_files JSON column (added in
 * migration 0.7.0) is a cache so the renderer can show the list across
 * restarts without spawning git on every load. getConflictState reconciles
 * the two when they diverge (e.g. user resolved manually in their editor
 * outside the UI).
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('node:child_process');
const { APPS_DIR } = require('../config');

// Conflict-status codes from `git status --porcelain` v1 (the format
// without `-z`). Per Documentation/git-status.txt:
//   DD = both deleted, AU = added by us, UD = deleted by them, UA = added by them,
//   DU = deleted by us, AA = both added, UU = both modified
const CONFLICT_STATUS_RE = /^(UU|AA|DD|UA|AU|DU|UD) /;

function _runGit(appDir, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', appDir, ...args], {
      shell: false, stdio: ['ignore', 'pipe', 'pipe'], ...opts,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const err = new Error(
          `git ${args.join(' ')} exited ${code}: ${stderr.trim().slice(-300)}`
        );
        err.code = code;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

function _appDir(appId) {
  return path.join(APPS_DIR, appId);
}

function _parseConflictedFiles(porcelain) {
  return porcelain.split('\n')
    .filter(line => CONFLICT_STATUS_RE.test(line))
    .map(line => ({
      status: line.slice(0, 2),
      path: line.slice(3),
    }));
}

/**
 * Read the live conflict state for an app.
 *
 * Returns:
 *   { status: 'clean' | 'conflict' | 'unknown',
 *     targetCommit: string | null,
 *     files: [{ path, status }] }
 *
 * `status: 'clean'` means git reports no conflicts (regardless of what
 * apps.update_status says — git's view is authoritative).
 *
 * When persisted state and live state disagree, the persisted columns
 * are reconciled to match git: a renderer that previously saw 'conflict'
 * but the user fixed everything in their editor sees 'clean' on next load.
 */
async function getConflictState(db, appId) {
  const { AppService } = require('./app');
  const app = AppService.getById(db, appId);
  if (!app) throw new Error(`app ${appId} not found`);
  if (app.app_type !== 'external') {
    throw new Error('merge state only meaningful for external apps');
  }

  let porcelain = '';
  try {
    const r = await _runGit(_appDir(appId), ['status', '--porcelain']);
    porcelain = r.stdout;
  } catch (e) {
    return {
      status: 'unknown',
      targetCommit: app.update_to_commit || null,
      files: [],
      error: e.message,
    };
  }

  const liveFiles = _parseConflictedFiles(porcelain);
  const liveStatus = liveFiles.length > 0 ? 'conflict' : 'clean';

  // Reconcile DB state with git state. If git is clean but DB still says
  // conflict, the user resolved manually outside the UI — clear the DB.
  if (liveStatus === 'clean' && app.update_status === 'conflict') {
    db.prepare(`
      UPDATE apps SET update_status = NULL,
                       update_conflict_files = NULL,
                       updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(appId);
  }

  // Refresh the persisted file list so a subsequent restart sees the
  // current set without re-running git status.
  if (liveStatus === 'conflict') {
    try {
      db.prepare(`UPDATE apps SET update_conflict_files = ? WHERE id = ?`)
        .run(JSON.stringify(liveFiles.map(f => f.path)), appId);
    } catch (_) { /* column may be absent on a pre-0.7.0 schema; soft-fail */ }
  }

  return {
    status: liveStatus,
    targetCommit: app.update_to_commit || null,
    files: liveFiles,
  };
}

/**
 * Stage every currently-conflicted file (`git add -u`) and commit with
 * a generated message. Throws if any file is still conflicted (per
 * `git status --porcelain`) — the user must finish editing first.
 *
 * On success: clears apps.update_status + update_conflict_files, bumps
 * upstream_resolved_commit if the resolution merge included a target.
 *
 * @param {{ resolvedBy?: 'user' | 'ai' }} opts metadata for the commit
 */
async function markAllResolved(db, appId, opts = {}) {
  const { AppService } = require('./app');
  const app = AppService.getById(db, appId);
  if (!app) throw new Error(`app ${appId} not found`);

  // Get the live conflict list from git first. Files in this list are
  // still in the unmerged-index state — `git add` would mark them
  // resolved unconditionally, so we must verify the user has actually
  // removed the conflict markers from the file content BEFORE staging.
  // Otherwise a half-resolved file gets committed with `<<<<<<<`
  // markers still in it (silent footgun).
  const appDir = _appDir(appId);
  const status = await _runGit(appDir, ['status', '--porcelain']);
  const conflicted = _parseConflictedFiles(status.stdout);
  const stillMarked = [];
  for (const f of conflicted) {
    const fp = path.join(appDir, f.path);
    let content = '';
    try { content = fs.readFileSync(fp, 'utf8'); }
    catch (_) { continue; /* deleted-by-them etc — git add -u handles */ }
    if (/^<{7}|^>{7}|^={7}/m.test(content)) {
      stillMarked.push({ path: f.path, status: f.status });
    }
  }
  if (stillMarked.length > 0) {
    const list = stillMarked.map(f => f.path).join(', ');
    const err = new Error(`files still have conflict markers: ${list}`);
    err.code = 'STILL_CONFLICTED';
    err.files = stillMarked;
    throw err;
  }

  // Stage every modified-and-tracked file (covers files the user
  // edited to resolve conflicts).
  await _runGit(appDir, ['add', '-u']);

  // Commit. The merge-in-progress means git already has MERGE_HEAD,
  // and a regular commit creates the merge commit with the standard
  // two parents. Author is OS8 (so blame attributes the merge commit
  // separately from the user's edits) but the resolution metadata
  // notes who drove it.
  const targetCommit = app.update_to_commit || '(unknown target)';
  const tag = opts.resolvedBy === 'ai' ? '[ai-resolved]' : '[user-resolved]';
  const message = `${tag} merge from ${String(targetCommit).slice(0, 8)}`;
  await _runGit(appDir, [
    '-c', 'user.email=os8@os8.local',
    '-c', 'user.name=OS8',
    'commit', '-m', message,
  ]);

  // Bump the apps row to the resolved commit. The merge-target SHA is
  // what's now reachable from HEAD via the merge commit's second parent;
  // we keep upstream_resolved_commit pointing at it.
  if (app.update_to_commit) {
    db.prepare(`
      UPDATE apps SET upstream_resolved_commit = ?,
                       update_available = 0,
                       update_to_commit = NULL,
                       update_status = NULL,
                       update_conflict_files = NULL,
                       updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(app.update_to_commit, appId);
  } else {
    db.prepare(`
      UPDATE apps SET update_status = NULL,
                       update_conflict_files = NULL,
                       updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(appId);
  }

  return { ok: true, commit: app.update_to_commit || null };
}

/**
 * Abort the in-progress merge (`git merge --abort`), reverting user/main
 * to its pre-merge state. Clears apps.update_status + update_conflict_files
 * so the conflict UI dismisses; the update_available flag stays so the
 * user can retry from the home-screen banner.
 */
async function abortMerge(db, appId) {
  const { AppService } = require('./app');
  const app = AppService.getById(db, appId);
  if (!app) throw new Error(`app ${appId} not found`);

  // `git merge --abort` errors if there's no in-progress merge; treat
  // that as success (idempotent abort).
  try {
    await _runGit(_appDir(appId), ['merge', '--abort']);
  } catch (e) {
    if (!/No MERGE_HEAD|There is no merge to abort/i.test(e.message)) {
      throw e;
    }
  }

  db.prepare(`
    UPDATE apps SET update_status = NULL,
                     update_conflict_files = NULL,
                     updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).run(appId);

  return { ok: true };
}

module.exports = {
  getConflictState,
  markAllResolved,
  abortMerge,
  // Exported for tests + future AppCatalogService.update integration:
  _parseConflictedFiles,
  _runGit,
};
