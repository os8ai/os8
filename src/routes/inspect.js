/**
 * App Inspection Routes
 * POST /api/apps/:id/inspect — Capture screenshot + console errors for an app
 */

const express = require('express');

function createInspectRouter(db, deps) {
  const { AppService, AppInspectorService, getPort } = deps;

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

  return router;
}

module.exports = createInspectRouter;
