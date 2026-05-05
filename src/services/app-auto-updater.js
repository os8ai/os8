/**
 * AppAutoUpdater — Phase 4 PR 4.2; widened to Community in Phase 6 PR 6.1.
 *
 * Walks the apps table for Verified or Community external apps that have
 * `auto_update=1` and an `update_available=1` flag set by
 * AppCatalogService.sync (PR 1.25). For each candidate, dispatches to
 * AppCatalogService.update which fast-forwards user/main onto the
 * target commit when no user edits exist.
 *
 * Per-channel defaults (PR 6.1) are asymmetric: Verified apps stay
 * opt-in (default OFF) while new Community installs default to ON
 * (`migration 0.8.0`). The per-app flyout toggle is interactive for
 * both channels; PR 5.4's three-way merge UI handles the conflict path
 * identically. Developer-Import apps are excluded — they have no
 * upstream catalog to sync from.
 *
 * Spec §6.9 hard rule: never auto-merge against user-edited apps. The
 * `user_branch` column is set on first edit (per PR 1.23's
 * fork-on-first-edit watcher). When it's set, we skip — the user gets
 * the manual update path through the home-screen banner instead.
 *
 * The scheduler in src/server.js calls processAutoUpdates after every
 * catalog sync. Failures are surfaced via the onFailed callback so the
 * server can log them and the renderer can toast (PR 4.2's toast
 * subscriber).
 *
 * Restart policy (smart restart): the updater itself doesn't restart
 * processes. AppCatalogService.update bumps the apps row; if start-
 * relevant files (package.json / lockfile / start.argv binary) changed,
 * the existing app-process supervisor will detect-and-restart on next
 * launch. Pure source edits flow through Vite HMR with no restart
 * needed. If the smart-restart heuristic ever proves wrong we fall back
 * to "always restart with notification" — see plan §7 #4.
 */

let AppCatalogService = null; // lazy to avoid import cycles
function getCatalog() {
  if (!AppCatalogService) AppCatalogService = require('./app-catalog');
  return AppCatalogService;
}

let AppTelemetry = null;
function getTelemetry() {
  if (!AppTelemetry) AppTelemetry = require('./app-telemetry');
  return AppTelemetry;
}

/**
 * Find every Verified-channel external app eligible for auto-update.
 * "Eligible" = active app, opted-in, update flagged, no user edits.
 *
 * Exported for tests; production callers use processAutoUpdates.
 */
function listEligible(db) {
  return db.prepare(`
    SELECT id, external_slug, channel, upstream_resolved_commit,
           update_to_commit, user_branch, manifest_yaml
      FROM apps
     WHERE app_type = 'external'
       AND status = 'active'
       AND channel IN ('verified', 'community')
       AND auto_update = 1
       AND update_available = 1
       AND update_to_commit IS NOT NULL
       AND (user_branch IS NULL OR user_branch = '')
  `).all();
}

/**
 * Process any pending auto-updates.
 *
 * @param {object} db
 * @param {object} [callbacks]
 * @param {(app, sha) => void} [callbacks.onUpdated]
 * @param {(app, reason) => void} [callbacks.onSkipped]
 * @param {(app, err) => void} [callbacks.onFailed]
 * @returns {Promise<{ attempted, updated, skipped, failed }>}
 */
async function processAutoUpdates(db, callbacks = {}) {
  const { onUpdated, onSkipped, onFailed, onConflict } = callbacks;
  const eligible = listEligible(db);

  let attempted = 0, updated = 0, skipped = 0, failed = 0, conflicts = 0;

  for (const app of eligible) {
    attempted += 1;
    const targetCommit = app.update_to_commit;

    // Defensive: AppCatalogService.update validates the SHA shape, but a
    // malformed update_to_commit from a corrupted catalog row should be
    // skipped here (not failed) so the rest of the batch proceeds.
    if (!/^[0-9a-f]{40}$/.test(String(targetCommit || ''))) {
      skipped += 1;
      onSkipped?.(app, `invalid update_to_commit: ${targetCommit}`);
      continue;
    }

    try {
      const result = await getCatalog().update(db, app.id, targetCommit);
      if (result?.kind === 'updated') {
        updated += 1;
        onUpdated?.(app, targetCommit);
        // PR 4.4 telemetry — adapter/framework not on the apps row
        // directly; we read them from manifest_yaml when present.
        try {
          const yaml = require('js-yaml');
          const manifest = app.manifest_yaml ? yaml.load(app.manifest_yaml) : null;
          getTelemetry().enqueue(db, {
            kind: 'update_succeeded',
            adapter: manifest?.runtime?.kind || null,
            framework: manifest?.framework || null,
            channel: app.channel,
            slug: app.external_slug,
            commit: targetCommit,
          });
        } catch (_) { /* telemetry is best-effort */ }
      } else if (result?.kind === 'conflict') {
        // Phase 5 PR 5.4 — conflict gets its own callback so the server
        // can broadcast a renderer event + the merge-conflict banner
        // surfaces in the user's app. Still counts as 'skipped' for the
        // legacy summary.
        skipped += 1;
        conflicts += 1;
        const files = Array.isArray(result.files) ? result.files : [];
        onConflict?.(app, { files });
        onSkipped?.(app, `merge conflict requires manual resolution`);
        try {
          const yaml = require('js-yaml');
          const manifest = app.manifest_yaml ? yaml.load(app.manifest_yaml) : null;
          getTelemetry().enqueue(db, {
            kind: 'update_conflict',
            adapter: manifest?.runtime?.kind || null,
            framework: manifest?.framework || null,
            channel: app.channel,
            slug: app.external_slug,
            commit: targetCommit,
            failurePhase: 'merge',
            conflictFileCount: files.length,
          });
        } catch (_) { /* telemetry is best-effort */ }
      } else {
        skipped += 1;
        onSkipped?.(app, `unexpected update result kind: ${result?.kind}`);
      }
    } catch (err) {
      failed += 1;
      onFailed?.(app, err);
      try {
        getTelemetry().enqueue(db, {
          kind: 'update_failed',
          channel: app.channel,
          slug: app.external_slug,
          commit: targetCommit,
          failurePhase: 'update',
          failureFingerprint: getTelemetry().fingerprintFailure(err.message),
        });
      } catch (_) { /* telemetry is best-effort */ }
    }
  }

  return { attempted, updated, skipped, failed, conflicts };
}

module.exports = {
  processAutoUpdates,
  listEligible,
};
