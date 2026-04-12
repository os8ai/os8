/**
 * App Verification Routes
 * POST /api/apps/:id/inspect — Load the app in a headless browser, return
 *   screenshot + runtime console errors/warnings. Slower (~3s), catches runtime
 *   and rendering problems.
 * POST /api/apps/:id/check — Walk the app's import graph via the running Vite
 *   middleware, return compile/parse/resolve errors. Fast (~50ms), catches
 *   syntax, JSX, and missing-import problems without running any code.
 */

const path = require('path');
const express = require('express');
const { APPS_DIR } = require('../config');

function createInspectRouter(db, deps) {
  const { AppService, AppInspectorService, AppCheckerService, getPort, getViteServer } = deps;

  const router = express.Router();

  // POST /api/apps/:id/inspect — Inspect an app (screenshot + console)
  router.post('/:id/inspect', async (req, res) => {
    try {
      const { id } = req.params;

      // Validate app exists
      const app = AppService.getById(db, id);
      if (!app) {
        return res.status(404).json({ error: 'App not found' });
      }

      const port = getPort();
      const appUrl = `http://localhost:${port}/${id}/`;

      const result = await AppInspectorService.inspect(id, appUrl);

      res.json({
        appId: id,
        appName: app.name,
        ...result
      });
    } catch (err) {
      console.error('[Inspect API] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/apps/:id/check — Compile-check the app via Vite transformRequest.
  // In-process, per-app scoped (appId comes from URL, appPath computed server-side).
  router.post('/:id/check', async (req, res) => {
    try {
      const { id } = req.params;

      const app = AppService.getById(db, id);
      if (!app) {
        return res.status(404).json({ error: 'App not found' });
      }

      const viteServer = getViteServer ? getViteServer() : null;
      if (!viteServer) {
        return res.status(503).json({
          error: 'Vite middleware not ready — Core may still be installing or failed to start.'
        });
      }

      const appPath = path.join(APPS_DIR, id);
      const result = await AppCheckerService.check({ viteServer, appId: id, appPath });

      res.json({
        appId: id,
        appName: app.name,
        ...result
      });
    } catch (err) {
      console.error('[Check API] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createInspectRouter;
