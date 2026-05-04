/**
 * Migration 0.7.0 — App Store v1.2: lifecycle completeness foundation.
 *
 * Foundation for Phase 5:
 *   - PR 5.4 (three-way merge UI) reads/writes `apps.update_conflict_files`
 *     (JSON-encoded list of currently-conflicted file paths). Lets the renderer
 *     surface the file list across restarts without re-running git status.
 *   - PR 5.5 (reinstall-from-orphan UI) reads
 *     `app_store.orphan_restore.prompt` to decide whether to render the
 *     "Previous data found" section in the install plan modal.
 *   - PR 5.1 (installed-apps heartbeat) reads/writes
 *     `user_account.session_cookie` and `user_account.share_installed_apps`.
 *     The session cookie lets `AppCatalogService.reportInstalledApps` reach
 *     os8.ai's authenticated endpoint; the share toggle is the user's
 *     opt-out switch (defaults ON when signed in).
 *
 * Spec note. The Phase 5 plan refers to the table colloquially as
 * `account`, but the on-disk schema (src/db/schema.js:790) names it
 * `user_account`. This migration uses the real name; PR 5.1 follows.
 *
 * Defensive re-seed of `_internal_call_token`. PR 4.11 (migration 0.6.0)
 * seeds it; this migration re-seeds only if absent so a botched 0.6.0 run
 * cannot leave the strict middleware (PR 4.6) without an in-process token.
 *
 * Idempotent: every ALTER guards on PRAGMA table_info; every settings seed
 * checks for an existing row before inserting, so user choices and the
 * existing token survive re-runs.
 */

const crypto = require('crypto');

module.exports = {
  version: '0.7.0',
  description: 'App Store v1.2: lifecycle completeness — merge conflict storage, orphan-restore preference, session cookie cache',

  async up({ db, logger }) {
    // 1. apps.update_conflict_files — JSON list of currently-conflicted file
    //    paths from the last failed merge. Lets the renderer surface the list
    //    across restarts without re-running `git status --porcelain`.
    const appsCols = db.prepare('PRAGMA table_info(apps)').all().map(c => c.name);
    if (!appsCols.includes('update_conflict_files')) {
      db.exec('ALTER TABLE apps ADD COLUMN update_conflict_files TEXT');
    }

    // 2. user_account.session_cookie + user_account.share_installed_apps.
    //    Cookie cache for the installed-apps heartbeat (PR 5.1); share toggle
    //    is the per-user opt-out (defaults ON when signed in, cleared on
    //    sign-out + on toggle-off).
    const accountCols = db.prepare('PRAGMA table_info(user_account)').all().map(c => c.name);
    if (!accountCols.includes('session_cookie')) {
      db.exec('ALTER TABLE user_account ADD COLUMN session_cookie TEXT');
    }
    if (!accountCols.includes('share_installed_apps')) {
      db.exec('ALTER TABLE user_account ADD COLUMN share_installed_apps INTEGER DEFAULT 1');
    }

    // 3. Settings — only seed if not already set (preserve user choices).
    const seed = (key, value) => {
      const existing = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      if (!existing) {
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
      }
    };
    seed('app_store.orphan_restore.prompt', 'true');           // PR 5.5: ON by default

    // 4. Defensive — re-seed _internal_call_token if absent. PR 4.11 should
    //    have done this; defensive in case of a botched 0.6.0 run that left
    //    PR 4.6's strict middleware without an in-process trust token.
    const tokenRow = db.prepare("SELECT value FROM settings WHERE key = '_internal_call_token'").get();
    if (!tokenRow || !tokenRow.value) {
      const fresh = crypto.randomBytes(32).toString('hex');
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('_internal_call_token', ?)").run(fresh);
    }

    logger?.log?.('[0.7.0] lifecycle columns + orphan-restore default + cookie cache applied');
  }
};
