const express = require('express');
const SkillCatalogService = require('../services/skill-catalog');
const SkillReviewService = require('../services/skill-review');

function createSkillsRouter(db, CapabilityService) {
  const router = express.Router();

  // List all installed skills (with availability status)
  router.get('/', (req, res) => {
    try {
      const skills = CapabilityService.getAvailable(db);
      res.json(skills);
    } catch (err) {
      console.error('Skills list error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Search installed skills (semantic + keyword)
  router.post('/search', async (req, res) => {
    try {
      const { query, topK, agentId } = req.body;
      if (!query) return res.status(400).json({ error: 'query is required' });

      const results = await CapabilityService.search(db, query, {
        topK: topK || 5,
        agentId: agentId || null
      });
      res.json(results);
    } catch (err) {
      console.error('Skills search error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Get role templates for agent creation
  router.get('/role-templates', (req, res) => {
    try {
      const templates = require('../data/role-templates.json');
      res.json(templates);
    } catch (err) {
      console.error('Role templates error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ──────────────────────────────────────────────
  // Agent skill routes (pinned, context)
  // ──────────────────────────────────────────────

  // Get pinned skills for an agent
  router.get('/agent/:agentId', (req, res) => {
    try {
      const pinned = CapabilityService.getPinned(db, req.params.agentId);
      res.json(pinned);
    } catch (err) {
      console.error('Skills agent get error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Get context-ready skills for an agent (pinned + suggested)
  router.post('/agent/:agentId/context', async (req, res) => {
    try {
      const { message } = req.body || {};
      const result = await CapabilityService.getForContext(db, req.params.agentId, message || '');
      const formatted = CapabilityService.formatForContext(db, result.pinned, result.suggested);
      res.json({ ...result, formatted });
    } catch (err) {
      console.error('Skills context error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Pin a skill for an agent
  router.post('/agent/:agentId/pin', (req, res) => {
    try {
      const { skillId } = req.body;
      if (!skillId) return res.status(400).json({ error: 'skillId is required' });

      CapabilityService.pin(db, req.params.agentId, skillId);
      res.json({ success: true });
    } catch (err) {
      if (err.message.includes('Maximum')) {
        return res.status(400).json({ error: err.message });
      }
      console.error('Skills pin error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Unpin a skill from an agent
  router.delete('/agent/:agentId/pin/:skillId', (req, res) => {
    try {
      CapabilityService.unpin(db, req.params.agentId, req.params.skillId);
      res.json({ success: true });
    } catch (err) {
      console.error('Skills unpin error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ──────────────────────────────────────────────
  // Catalog endpoints
  // ──────────────────────────────────────────────

  // Get catalog stats
  router.get('/catalog/stats', (req, res) => {
    try {
      const stats = SkillCatalogService.getStats(db);
      res.json(stats);
    } catch (err) {
      console.error('Catalog stats error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Search the skill catalog
  router.post('/catalog/search', async (req, res) => {
    try {
      const { query, topK } = req.body;
      if (!query) return res.status(400).json({ error: 'query is required' });

      const results = await SkillCatalogService.search(db, query, {
        topK: topK || 15,
        trustWeight: true
      });
      res.json(results);
    } catch (err) {
      console.error('Catalog search error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Install a skill from the catalog (downloads real SKILL.md from ClawHub)
  router.post('/catalog/install', async (req, res) => {
    try {
      const { catalogId } = req.body;
      if (!catalogId) return res.status(400).json({ error: 'catalogId is required' });

      const result = await SkillCatalogService.install(db, catalogId);
      res.json(result);

      // Auto-trigger security review (fire-and-forget)
      if (result.skillId && !result.alreadyInstalled) {
        SkillReviewService.review(db, result.skillId).catch(err => {
          console.warn('Auto-review failed:', err.message);
        });
      }
    } catch (err) {
      console.error('Catalog install error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Get catalog entry by ID
  router.get('/catalog/:id', (req, res) => {
    try {
      const entry = SkillCatalogService.getById(db, req.params.id);
      if (!entry) return res.status(404).json({ error: 'Catalog entry not found' });
      res.json(entry);
    } catch (err) {
      console.error('Catalog get error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/skills/registry — unified capabilities inventory (APIs + skills)
  // Optional: ?agentId=X to annotate each capability with pinned status
  router.get('/registry', (req, res) => {
    try {
      let caps = CapabilityService.getAll(db);
      const { type, available, agentId } = req.query;
      if (type) caps = caps.filter(c => c.type === type);
      if (available !== undefined) caps = caps.filter(c => c.available === (available === '1' ? 1 : 0));

      // Annotate with pin status if agentId provided
      if (agentId) {
        const pinned = CapabilityService.getPinned(db, agentId);
        const pinnedIds = new Set(pinned.map(p => p.id));
        caps = caps.map(c => ({ ...c, pinned: pinnedIds.has(c.id) }));
      }

      res.json(caps);
    } catch (err) {
      console.error('Registry list error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ──────────────────────────────────────────────
  // Review & approval routes
  // ──────────────────────────────────────────────

  // Trigger security review for a skill
  router.post('/:id/review', async (req, res) => {
    try {
      const report = await SkillReviewService.review(db, req.params.id);
      res.json(report);
    } catch (err) {
      console.error('Skill review error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Get review status and report
  router.get('/:id/review', (req, res) => {
    try {
      const result = SkillReviewService.getReport(db, req.params.id);
      if (!result) return res.status(404).json({ error: 'Capability not found' });
      res.json(result);
    } catch (err) {
      console.error('Skill review get error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Approve a reviewed skill (unquarantine)
  router.post('/:id/approve', (req, res) => {
    try {
      SkillReviewService.approve(db, req.params.id);
      res.json({ success: true });
    } catch (err) {
      console.error('Skill approve error:', err);
      res.status(400).json({ error: err.message });
    }
  });

  // Reject a reviewed skill
  router.post('/:id/reject', (req, res) => {
    try {
      SkillReviewService.reject(db, req.params.id);
      res.json({ success: true });
    } catch (err) {
      console.error('Skill reject error:', err);
      res.status(400).json({ error: err.message });
    }
  });

  // Check dependency status
  router.get('/:id/deps-status', (req, res) => {
    try {
      const status = SkillReviewService.getDepsStatus(db, req.params.id);
      res.json(status);
    } catch (err) {
      console.error('Deps status error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Install approved dependencies
  router.post('/:id/install-deps', async (req, res) => {
    try {
      const { stepIds } = req.body;
      if (!Array.isArray(stepIds)) return res.status(400).json({ error: 'stepIds array is required' });
      const results = await SkillReviewService.installDeps(db, req.params.id, stepIds);
      res.json(results);
    } catch (err) {
      console.error('Deps install error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ──────────────────────────────────────────────
  // Parameterized routes (must be last — /:id is a catch-all)
  // ──────────────────────────────────────────────

  // Track skill usage
  router.post('/:id/used', (req, res) => {
    try {
      const { agentId, context } = req.body || {};
      CapabilityService.trackUsage(db, req.params.id, agentId, context);
      res.json({ success: true });
    } catch (err) {
      console.error('Skills usage tracking error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Get skill details (with full documentation from SKILL.md)
  router.get('/:id', (req, res) => {
    try {
      console.log(`[Skills API] GET /api/skills/${req.params.id} — agent fetching skill docs`);
      const skill = CapabilityService.getById(db, req.params.id);
      if (!skill) return res.status(404).json({ error: 'Skill not found' });

      // Add availability info
      const availableSkills = CapabilityService.getAvailable(db);
      const availableInfo = availableSkills.find(s => s.id === skill.id);

      // Add full documentation
      const documentation = CapabilityService.getDocumentation(db, skill.id);

      res.json({
        ...skill,
        available: availableInfo?.available ?? false,
        missingScopes: availableInfo?.missingScopes,
        documentation
      });
    } catch (err) {
      console.error('Skill get error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createSkillsRouter;
