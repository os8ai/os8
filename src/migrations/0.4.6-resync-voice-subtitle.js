/**
 * Migration 0.4.6 — resync assistant shell files after the Voice subtitle fix.
 *
 * v0.4.6 fixes the Personal Assistant's agent-tab Voice section subtitle so it
 * reflects the active TTS provider correctly (was hardcoded to "ElevenLabs"/
 * "OpenAI" — Kokoro showed up as "OpenAI"). The change lives in
 * src/templates/assistant/src/components/SettingsPanel.jsx, which is
 * shell-owned. Deployed assistant apps still hold the pre-0.4.6 copy.
 *
 * Mirrors 0.4.3 — walk every assistant-type app, resync shell-owned files,
 * keep user-owned top-level files intact. Per-app failures are logged but do
 * not abort the migration.
 */

const path = require('path');
const fs = require('fs');
const { APPS_DIR } = require('../config');
const { resyncAppShellFiles } = require('../services/template-resync');

module.exports = {
  version: '0.4.6',
  description: 'Resync assistant shell files after Voice subtitle fix',

  async up({ db, logger }) {
    const apps = db.prepare(
      "SELECT id, name FROM apps WHERE app_type = 'system' AND status != 'deleted'"
    ).all();

    if (apps.length === 0) {
      logger.log('[0.4.6] No assistant apps to resync');
      return;
    }

    logger.log(`[0.4.6] Resyncing ${apps.length} assistant app(s)`);
    let totalUpdated = 0;
    let totalCreated = 0;

    for (const app of apps) {
      const appDir = path.join(APPS_DIR, app.id);
      if (!fs.existsSync(appDir)) {
        logger.warn(`[0.4.6] ${app.id}: app directory missing, skipping`);
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
          logger.log(`[0.4.6] ${app.id}: ${parts.join(', ')}` +
            (result.backupRoot ? ` (backup: ${path.relative(appDir, result.backupRoot)})` : ''));
        } else {
          logger.log(`[0.4.6] ${app.id}: already in sync`);
        }
      } catch (err) {
        logger.warn(`[0.4.6] ${app.id}: resync failed — ${err.message}`);
      }
    }

    logger.log(`[0.4.6] Summary: ${totalUpdated} updated, ${totalCreated} created across ${apps.length} app(s)`);
  }
};
