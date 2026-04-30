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
const yaml = require('js-yaml');
const { parseManifest, validateManifest } = require('../services/manifest-validator');
const AppCatalogService = require('../services/app-catalog');
const AppInstaller = require('../services/app-installer');
const InstallJobs = require('../services/app-install-jobs');
const InstallEvents = require('../services/install-events');

function registerAppStoreHandlers({ db, mainWindow }) {
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

  ipcMain.handle('app-store:install', async (_e, { slug, commit, channel = 'verified', source = 'manual' } = {}) => {
    try {
      const job = await AppInstaller.start(db, { slug, commit, channel, source });
      return { ok: true, jobId: job.id, status: job.status };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('app-store:approve', async (_e, jobId, secrets = {}) => {
    try {
      const job = await AppInstaller.approve(db, jobId, { secrets });
      return { ok: true, jobId: job.id, status: job.status };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('app-store:cancel', async (_e, jobId) => {
    try {
      const job = AppInstaller.cancel(db, jobId);
      return { ok: true, jobId: job.id, status: job.status };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // PR 1.9 — preload-external-app.js calls this on init to read the manifest's
  // declared os8_capabilities and build the right SDK surface.
  ipcMain.handle('app-store:get-manifest-for-preload', (_e, appId) => {
    try {
      const { AppService } = require('../services/app');
      const app = AppService.getById(db, appId);
      if (!app || app.app_type !== 'external') return { ok: false };
      const manifest = yaml.load(app.manifest_yaml || '') || {};
      const capabilities = manifest.permissions?.os8_capabilities || [];
      return { ok: true, capabilities, slug: app.slug };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('app-store:get-job', (_e, jobId) => {
    const job = InstallJobs.get(db, jobId);
    if (!job) return { ok: false, error: 'job not found' };
    let reviewReport = null;
    if (job.review_report) {
      try { reviewReport = JSON.parse(job.review_report); }
      catch (_) { reviewReport = null; }
    }
    return {
      ok: true,
      job: {
        id: job.id,
        appId: job.app_id,
        externalSlug: job.external_slug,
        upstreamResolvedCommit: job.upstream_resolved_commit,
        channel: job.channel,
        status: job.status,
        stagingDir: job.staging_dir,
        reviewReport,
        errorMessage: job.error_message,
        createdAt: job.created_at,
        updatedAt: job.updated_at,
      },
    };
  });

  // Forward every job update to the renderer. The renderer toggles its
  // `appStore.onJobUpdate(callback)` subscription via preload.
  const relay = (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.send('app-store:job-update', payload); }
      catch (_) { /* renderer may be in transition — ignore */ }
    }
  };
  InstallEvents.on('job-update', relay);

  return {
    cleanupAppStoreEvents() {
      InstallEvents.off('job-update', relay);
    },
  };
}

module.exports = registerAppStoreHandlers;
