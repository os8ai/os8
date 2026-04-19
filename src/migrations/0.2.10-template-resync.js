/**
 * Migration 0.2.10 — resync shell-owned assistant app files.
 *
 * v0.2.9 renamed SSE event types (commit 6f1ec2f, "Adopt ag-ui protocol
 * vocabulary") on both the server and in the assistant template. Existing
 * users who scaffolded assistant apps on ≤ v0.2.8 and then upgraded still
 * have the stale template copy in `~/os8/apps/{appId}/src/`, which listens
 * for the old event names (`done`, `stream`, `step-start`, `activity`, etc.)
 * that the server no longer emits. Visible symptom: agent responds but the
 * "Working…" indicator hangs until it flips to "Timed out".
 *
 * This migration walks every assistant-type app (`app_type = 'system'`)
 * and re-copies shell-owned files (`src/` + `index.html`) from the current
 * template, re-rendering `{{APP_NAME}}` and `{{ID}}` from the DB. Any
 * replaced file is backed up to `~/os8/apps/{appId}/.os8-backup/<ts>/`.
 *
 * Per-app failures are logged but do not abort the migration — an edge-case
 * broken app shouldn't block the fleet. If template-resync itself throws
 * (e.g. templates dir missing), the migration fails and the migrator halts.
 */

const path = require('path');
const fs = require('fs');
const { APPS_DIR } = require('../config');
const { resyncAppShellFiles } = require('../services/template-resync');

module.exports = {
  version: '0.2.10',
  description: 'Resync shell-owned assistant app files after ag-ui SSE vocabulary change',

  async up({ db, logger }) {
    const apps = db.prepare(
      "SELECT id, name FROM apps WHERE app_type = 'system' AND status != 'deleted'"
    ).all();

    if (apps.length === 0) {
      logger.log('[0.2.10] No assistant apps to resync');
      return;
    }

    logger.log(`[0.2.10] Resyncing ${apps.length} assistant app(s)`);
    let totalUpdated = 0;
    let totalCreated = 0;

    for (const app of apps) {
      const appDir = path.join(APPS_DIR, app.id);
      if (!fs.existsSync(appDir)) {
        logger.warn(`[0.2.10] ${app.id}: app directory missing, skipping`);
        continue;
      }

      try {
        const result = resyncAppShellFiles({
          appDir,
          templateName: 'assistant',
          variables: {
            APP_NAME: app.name || 'Assistant',
            ID: app.id,
            // Shell-owned files don't currently use these two, but pass them
            // anyway so a future template change picks them up without needing
            // another migration file just to widen the variable set.
            ASSISTANT_NAME: app.name || 'Assistant',
            OWNER_NAME: ''
          }
        });

        totalUpdated += result.updated.length;
        totalCreated += result.created.length;

        if (result.updated.length > 0 || result.created.length > 0) {
          const parts = [];
          if (result.updated.length > 0) parts.push(`${result.updated.length} updated`);
          if (result.created.length > 0) parts.push(`${result.created.length} created`);
          logger.log(`[0.2.10] ${app.id}: ${parts.join(', ')}` +
            (result.backupRoot ? ` (backup: ${path.relative(appDir, result.backupRoot)})` : ''));
        } else {
          logger.log(`[0.2.10] ${app.id}: already in sync`);
        }
      } catch (err) {
        logger.warn(`[0.2.10] ${app.id}: resync failed — ${err.message}`);
        // Continue with other apps. A single bad app shouldn't brick startup.
      }
    }

    logger.log(`[0.2.10] Summary: ${totalUpdated} updated, ${totalCreated} created across ${apps.length} app(s)`);
  }
};
