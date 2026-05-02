/**
 * Migration 0.5.1 — add `.venv/__pycache__/.git/...` to Vite's watch.ignored
 * in `~/os8/core/vite.config.js`.
 *
 * Phase 3.5.4 surfaced this when a Gradio dev-import (HivisionIDPhotos)
 * caused Vite to crawl the external app's `.venv/lib/.../gradio/templates/`
 * directory and emit a storm of `[vite] page reload` events on first
 * launch. The shipped vite.config.js (v0.5.0 and earlier) didn't ignore
 * Python venvs.
 *
 * Fresh installs pick up the new template via core.js's
 * rewriteViteConfig(); this migration backfills the file for upgraders.
 * Idempotent (skips if the file already contains '**\/.venv/**'). Backs
 * up any divergent file to vite.config.js.<timestamp>.bak so users who
 * hand-edited their config don't silently lose changes.
 */

const fs = require('fs');
const path = require('path');
const { CORE_DIR } = require('../config');
const { rewriteViteConfig, viteConfigTemplate } = require('../services/core');

module.exports = {
  version: '0.5.1',
  description: 'Add .venv/__pycache__/.git/... to Vite watch.ignored in ~/os8/core/vite.config.js',

  async up({ logger }) {
    const target = path.join(CORE_DIR, 'vite.config.js');
    if (!fs.existsSync(target)) {
      logger.log('[0.5.1] No core vite.config.js — fresh install will pick up the new template on next core init');
      return;
    }

    const current = fs.readFileSync(target, 'utf8');
    if (current.includes("'**/.venv/**'")) {
      logger.log('[0.5.1] vite.config.js already has watch.ignored — skipping');
      return;
    }

    const next = viteConfigTemplate();
    if (current === next) {
      logger.log('[0.5.1] vite.config.js already matches template — skipping');
      return;
    }

    const result = rewriteViteConfig();
    if (result.backup) {
      logger.log(`[0.5.1] Updated vite.config.js (backup: ${path.basename(result.backup)})`);
    } else if (result.changed) {
      logger.log('[0.5.1] Wrote vite.config.js');
    } else {
      logger.log('[0.5.1] vite.config.js unchanged');
    }
  }
};
