/**
 * Migration 0.4.8 — resync assistant shell files after Chat Model UI fix.
 *
 * v0.4.8 makes the Personal Assistant's Chat Model section read-only when
 * OS8 is in local mode (replacing the per-agent dropdown with a "set in
 * launcher" display + Open-chooser link). The change lives in
 * src/templates/assistant/src/components/SettingsPanel.jsx, which is
 * shell-owned. Deployed assistant apps still hold the pre-0.4.8 copy.
 *
 * Mirrors 0.4.6 — walk every assistant-type app, resync shell-owned files,
 * keep user-owned top-level files intact. Per-app failures are logged but
 * do not abort the migration.
 */

const path = require('path');
const fs = require('fs');
const { APPS_DIR } = require('../config');
const { resyncAppShellFiles } = require('../services/template-resync');

module.exports = {
  version: '0.4.8',
  description: 'Resync assistant shell files after Chat Model local-mode read-only fix',

  async up({ db, logger }) {
    const apps = db.prepare(
      "SELECT id, name FROM apps WHERE app_type = 'system' AND status != 'deleted'"
    ).all();

    if (apps.length === 0) {
      logger.log('[0.4.8] No assistant apps to resync');
      return;
    }

    logger.log(`[0.4.8] Resyncing ${apps.length} assistant app(s)`);
    let totalUpdated = 0;
    let totalCreated = 0;

    for (const app of apps) {
      const appDir = path.join(APPS_DIR, app.id);
      if (!fs.existsSync(appDir)) {
        logger.warn(`[0.4.8] ${app.id}: app directory missing, skipping`);
        continue;
      }

      try {
        const result = resyncAppShellFiles({
          appDir,
          templateName: 'assistant',
          variables: {
            APP_NAME: app.name || 'Assistant',
            ID: app.id,
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
          logger.log(`[0.4.8] ${app.id}: ${parts.join(', ')}` +
            (result.backupRoot ? ` (backup: ${path.relative(appDir, result.backupRoot)})` : ''));
        } else {
          logger.log(`[0.4.8] ${app.id}: already in sync`);
        }
      } catch (err) {
        logger.warn(`[0.4.8] ${app.id}: resync failed — ${err.message}`);
      }
    }

    logger.log(`[0.4.8] Summary: ${totalUpdated} updated, ${totalCreated} created across ${apps.length} app(s)`);
  }
};
