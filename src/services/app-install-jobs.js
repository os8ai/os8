/**
 * Pure CRUD over the `app_install_jobs` table.
 *
 * Spec §6.1 + plan §3 PR 1.5. The state machine sits one layer up in
 * AppInstaller; this module just persists the rows and enforces atomic
 * status transitions.
 *
 * Statuses (spec §6.1):
 *   pending → cloning → reviewing → awaiting_approval → installing → installed
 *                  ↘ failed (terminal)        ↘ cancelled (terminal)
 *
 * `transition(...)` is the gate — it requires the current status to match
 * `from` and atomically writes `to` plus any column patches. A mismatch
 * throws so callers don't silently skip steps.
 */

const { generateId } = require('../utils');

const InstallJobs = {
  create(db, { externalSlug, upstreamResolvedCommit, channel }) {
    const id = generateId();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO app_install_jobs
        (id, app_id, external_slug, upstream_resolved_commit, channel, status,
         staging_dir, review_report, error_message, log_path, created_at, updated_at)
      VALUES
        (?, NULL, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, ?, ?)
    `).run(id, externalSlug, upstreamResolvedCommit, channel, now, now);
    return InstallJobs.get(db, id);
  },

  get(db, id) {
    return db.prepare('SELECT * FROM app_install_jobs WHERE id = ?').get(id);
  },

  list(db, { status, limit = 100 } = {}) {
    if (status) {
      return db.prepare(
        'SELECT * FROM app_install_jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?'
      ).all(status, limit);
    }
    return db.prepare(
      'SELECT * FROM app_install_jobs ORDER BY created_at DESC LIMIT ?'
    ).all(limit);
  },

  /**
   * Atomic transition. Throws if the row's current status is not `from`.
   * Patches additional columns (staging_dir, review_report, error_message,
   * log_path, app_id) in the same UPDATE.
   */
  transition(db, id, { from, to, patches = {} }) {
    const now = new Date().toISOString();
    const setClause = ['status = ?', 'updated_at = ?'];
    const args = [to, now];
    for (const [k, v] of Object.entries(patches)) {
      setClause.push(`${k} = ?`);
      args.push(v);
    }
    args.push(id, from);
    const r = db.prepare(
      `UPDATE app_install_jobs SET ${setClause.join(', ')} WHERE id = ? AND status = ?`
    ).run(...args);
    if (r.changes !== 1) {
      const cur = InstallJobs.get(db, id);
      throw new Error(
        `transition rejected for job ${id}: expected status='${from}', actual='${cur?.status || 'missing'}'`
      );
    }
    return InstallJobs.get(db, id);
  },

  /** Force-fail. Unconditional — used by the installer's outer catch. */
  fail(db, id, errorMessage) {
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE app_install_jobs SET status = 'failed', error_message = ?, updated_at = ?
      WHERE id = ? AND status NOT IN ('installed', 'cancelled', 'failed')
    `).run(String(errorMessage || 'unknown error').slice(0, 4000), now, id);
    return InstallJobs.get(db, id);
  },

  /** Cancel only from awaiting_approval (matches the state machine). */
  cancel(db, id) {
    return InstallJobs.transition(db, id, {
      from: 'awaiting_approval',
      to: 'cancelled',
    });
  },
};

module.exports = InstallJobs;
