/**
 * Sim API Routes
 * Server-side heavy lifting for agent simulation (reverie, journal, snapshot)
 *
 * Mounted at: /api/agent/:agentId/sim
 *
 * Endpoints:
 *   GET  /reverie/context   — Pre-fetch context for reverie generation
 *   POST /reverie            — Store 3 reflections as internal entries
 *   GET  /journal/context   — Pre-fetch context for journal generation
 *   POST /journal            — Write journal entry (file + DB)
 *   GET  /snapshot/context  — Full context: journal + image refs + prompts
 *   POST /snapshot           — Execute full pipeline: journal + portrait + POV
 */

const express = require('express');

function createSimRouter(db, deps) {
  const { SimService, SettingsService } = deps;
  const router = express.Router();

  /**
   * Helper: resolve agentId from route params
   */
  function getAgentId(req) {
    return req.agentId || req.params.agentId;
  }

  /**
   * Helper: get server port
   */
  function getPort() {
    if (deps.getPort) return deps.getPort();
    const saved = SettingsService?.get(db, 'os8Port');
    return saved ? parseInt(saved, 10) : 8888;
  }

  // ═══════════════════════════════════════════════
  // REVERIE
  // ═══════════════════════════════════════════════

  /**
   * GET /reverie/context
   * Returns schedule slot, recent conversations, recent journal, recent reveries
   */
  router.get('/reverie/context', (req, res) => {
    try {
      const agentId = getAgentId(req);
      if (!agentId) return res.status(400).json({ error: 'agentId required' });

      const context = SimService.getReverieContext(db, agentId);
      res.json(context);
    } catch (err) {
      console.error('SimService: reverie/context error:', err.message);
      res.status(err.message === 'Agent not found' ? 404 : 500).json({ error: err.message });
    }
  });

  /**
   * POST /reverie
   * Body: { "reflections": ["...", "...", "..."] }
   * Stores reflections as [internal: (reverie) ...] entries
   */
  router.post('/reverie', (req, res) => {
    try {
      const agentId = getAgentId(req);
      if (!agentId) return res.status(400).json({ error: 'agentId required' });

      const { reflections } = req.body;
      if (!reflections || !Array.isArray(reflections) || reflections.length === 0) {
        return res.status(400).json({ error: 'reflections must be a non-empty array of strings' });
      }

      const result = SimService.executeReverie(db, agentId, reflections);
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('SimService: reverie error:', err.message);
      res.status(err.message === 'Agent not found' ? 404 : 500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════
  // JOURNAL
  // ═══════════════════════════════════════════════

  /**
   * GET /journal/context
   * Returns last journal entry, gap info, schedule slot, recent conversations, calendar
   */
  router.get('/journal/context', (req, res) => {
    try {
      const agentId = getAgentId(req);
      if (!agentId) return res.status(400).json({ error: 'agentId required' });

      const context = SimService.getJournalContext(db, agentId);
      res.json(context);
    } catch (err) {
      console.error('SimService: journal/context error:', err.message);
      res.status(err.message === 'Agent not found' ? 404 : 500).json({ error: err.message });
    }
  });

  /**
   * POST /journal
   * Body: { reconstructedHistory, currentState, narrative, isSpark }
   * Writes journal markdown file + stores in conversation DB
   */
  router.post('/journal', (req, res) => {
    try {
      const agentId = getAgentId(req);
      if (!agentId) return res.status(400).json({ error: 'agentId required' });

      const result = SimService.executeJournal(db, agentId, req.body);
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('SimService: journal error:', err.message);
      const status = err.message === 'Agent not found' ? 404
        : err.message.includes('required') ? 400
        : 500;
      res.status(status).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════
  // SNAPSHOT
  // ═══════════════════════════════════════════════

  /**
   * GET /snapshot/context
   * Returns journal context + image context (identity, refs, available settings)
   */
  router.get('/snapshot/context', (req, res) => {
    try {
      const agentId = getAgentId(req);
      if (!agentId) return res.status(400).json({ error: 'agentId required' });

      const port = getPort();
      const context = SimService.getSnapshotContext(db, agentId, port);
      res.json(context);
    } catch (err) {
      console.error('SimService: snapshot/context error:', err.message);
      res.status(err.message === 'Agent not found' ? 404 : 500).json({ error: err.message });
    }
  });

  /**
   * POST /snapshot
   * Body: { journal: { reconstructedHistory, currentState, narrative, isSpark }, imageOverrides: { provider, expressionOverride } }
   * Chains: journal write → portrait generation → POV generation → DB storage
   * Takes ~30-60s for full image pipeline
   */
  router.post('/snapshot', async (req, res) => {
    try {
      const agentId = getAgentId(req);
      if (!agentId) return res.status(400).json({ error: 'agentId required' });

      const port = getPort();
      const result = await SimService.executeSnapshot(db, agentId, req.body, port);
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('SimService: snapshot error:', err.message);
      const status = err.message === 'Agent not found' ? 404
        : err.message.includes('not found') ? 400
        : err.message.includes('required') ? 400
        : 500;
      res.status(status).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════
  // AGENT LIFE — Combined routine
  // ═══════════════════════════════════════════════

  /**
   * GET /life/context
   * Returns combined context for the agent-life routine
   */
  router.get('/life/context', (req, res) => {
    try {
      const agentId = getAgentId(req);
      if (!agentId) return res.status(400).json({ error: 'agentId required' });

      const port = getPort();
      const context = SimService.getLifeContext(db, agentId, port);
      res.json(context);
    } catch (err) {
      console.error('SimService: life/context error:', err.message);
      res.status(err.message === 'Agent not found' ? 404 : 500).json({ error: err.message });
    }
  });

  /**
   * POST /life
   * Body: { reflections, reconstructedHistory, currentState, narrative }
   * Executes combined life routine: reverie + journal + portrait
   */
  router.post('/life', async (req, res) => {
    try {
      const agentId = getAgentId(req);
      if (!agentId) return res.status(400).json({ error: 'agentId required' });

      const port = getPort();
      const result = await SimService.executeLife(db, agentId, req.body, port);
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('SimService: life error:', err.message);
      const status = err.message === 'Agent not found' ? 404
        : err.message.includes('required') ? 400
        : 500;
      res.status(status).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════
  // PORTRAIT (standalone image generation)
  // ═══════════════════════════════════════════════

  /**
   * POST /portrait
   * Generate a standalone portrait/selfie without running the full life routine.
   * Body: { currentState: { activity, location, appearance, body_position, mood, outfit_id, setting_id, hairstyle_id, ... }, provider?: "gemini"|"grok" }
   *   — outfit_id, setting_id, hairstyle_id are required when life items exist (use GET /life-items to list)
   *   — provider defaults to gemini, falls back to the other on failure
   */
  router.post('/portrait', async (req, res) => {
    try {
      const agentId = getAgentId(req);
      if (!agentId) return res.status(400).json({ error: 'agentId required' });

      const { currentState, provider } = req.body;
      if (!currentState) return res.status(400).json({ error: 'currentState is required' });

      const result = await SimService.executeLife(db, agentId, { currentState, provider }, getPort());
      res.json({ success: true, portrait: result.portrait });
    } catch (err) {
      console.error('SimService: portrait error:', err.message);
      const status = err.message === 'Agent not found' ? 404
        : err.message.includes('required') ? 400
        : 500;
      res.status(status).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════
  // LIFE ITEMS CRUD
  // ═══════════════════════════════════════════════

  /**
   * GET /life-items
   * Query: ?type=outfit|setting|hairstyle
   */
  router.get('/life-items', (req, res) => {
    try {
      const agentId = getAgentId(req);
      if (!agentId) return res.status(400).json({ error: 'agentId required' });

      const items = SimService.getLifeItems(db, agentId, req.query.type || null);
      res.json(items);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /life-items
   * Body: { type, name, description, panoramic?, tags?, isDefault? }
   */
  router.post('/life-items', (req, res) => {
    try {
      const agentId = getAgentId(req);
      if (!agentId) return res.status(400).json({ error: 'agentId required' });

      const { type, name, description } = req.body;
      if (!type || !name || !description) {
        return res.status(400).json({ error: 'type, name, and description are required' });
      }

      const item = SimService.createLifeItem(db, agentId, req.body);
      res.json({ success: true, item });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * PATCH /life-items/:itemId
   */
  router.patch('/life-items/:itemId', (req, res) => {
    try {
      const item = SimService.updateLifeItem(db, req.params.itemId, req.body);
      if (!item) return res.status(404).json({ error: 'Item not found' });
      res.json({ success: true, item });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * DELETE /life-items/:itemId
   */
  router.delete('/life-items/:itemId', (req, res) => {
    try {
      SimService.deleteLifeItem(db, req.params.itemId);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createSimRouter;

module.exports.meta = {
  name: 'sim',
  description: 'Agent life and simulation — portrait/selfie generation, life items (outfits, settings, hairstyles), reverie, journaling, snapshot',
  basePath: '/api/agent/:agentId/sim',
  endpoints: [
    { method: 'GET', path: '/reverie/context', description: 'Get context for a reverie (reflection)' },
    { method: 'POST', path: '/reverie', description: 'Store reverie reflections' },
    { method: 'GET', path: '/journal/context', description: 'Get context for journaling' },
    { method: 'POST', path: '/journal', description: 'Execute journal pipeline' },
    { method: 'GET', path: '/snapshot/context', description: 'Get full context for snapshot' },
    { method: 'POST', path: '/snapshot', description: 'Execute full snapshot (journal + portraits + POV)' },
    { method: 'GET', path: '/life/context', description: 'Get combined context for agent-life routine' },
    { method: 'POST', path: '/life', description: 'Execute combined life routine (reverie + journal + portrait)' },
    { method: 'POST', path: '/portrait', description: 'Generate a standalone portrait, selfie, or current image. Body: { currentState: { activity, location, mood, outfit_id, setting_id, hairstyle_id, ... }, provider?: "gemini"|"grok" }. IDs required when life items exist (use GET /life-items). Provider defaults to gemini, falls back to the other on failure' },
    { method: 'GET', path: '/life-items', description: 'List life items — outfits, settings (locations), hairstyles, wardrobe, appearance' },
    { method: 'POST', path: '/life-items', description: 'Create a life item (outfit, setting, hairstyle) with name, description, tags' },
    { method: 'PATCH', path: '/life-items/:itemId', description: 'Update a life item (outfit, setting, hairstyle)' },
    { method: 'DELETE', path: '/life-items/:itemId', description: 'Delete a life item (outfit, setting, hairstyle)' }
  ]
};
