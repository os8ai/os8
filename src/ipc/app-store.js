/**
 * IPC handlers for the App Store.
 *
 * PR 1.4 — shell-only render of the install plan modal:
 *   - app-store:validate-manifest  — validate raw YAML against AppSpec v1
 *   - app-store:render-plan        — fetch a catalog entry by slug+channel
 *
 * PR 1.16+ adds: install, approve, cancel, jobUpdate (event).
 */

const { ipcMain } = require('electron');
const { parseManifest, validateManifest } = require('../services/manifest-validator');
const AppCatalogService = require('../services/app-catalog');

function registerAppStoreHandlers({ db }) {
  ipcMain.handle('app-store:validate-manifest', (_e, yamlText, opts) => {
    try {
      const manifest = parseManifest(yamlText);
      const validation = validateManifest(manifest, opts || {});
      return { ok: true, manifest, validation };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('app-store:render-plan', async (_e, slug, channel = 'verified') => {
    try {
      const entry = await AppCatalogService.get(db, slug, { channel });
      if (!entry) return { ok: false, error: 'not in local catalog' };
      // Validate at render time — refuse to render a plan whose manifest doesn't pass v1.
      const validation = entry.manifest
        ? validateManifest(entry.manifest, { upstreamResolvedCommit: entry.upstreamResolvedCommit })
        : { ok: false, errors: [{ kind: 'invariant', path: '/', message: 'manifest YAML missing' }] };
      return { ok: true, entry, validation };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

module.exports = registerAppStoreHandlers;
