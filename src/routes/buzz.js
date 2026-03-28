/**
 * Buzz API routes
 * Simulated drinking system for agent personality modification
 */

const express = require('express');
const BuzzService = require('../services/buzz');

function createBuzzRouter(db, { AppService }) {
  const router = express.Router();

  // Helper: resolve agent directory from agentId param or default agent
  function getAgentDir(req) {
    const AgentService = require('../services/agent');
    const agentId = req.query?.agentId || req.body?.agentId;
    const agent = agentId
      ? AgentService.getById(db, agentId)
      : AgentService.getDefault(db);
    if (!agent) return null;
    return AgentService.getPaths(agent.app_id, agent.id).agentDir;
  }

  /**
   * GET /api/buzz/status?agentId=optional
   * Get current buzz level, active drinks, and next expiry
   */
  router.get('/status', (req, res) => {
    try {
      const agentDir = getAgentDir(req);
      if (!agentDir) {
        return res.status(404).json({ error: 'No agent found' });
      }

      const status = BuzzService.getStatus(agentDir);
      res.json(status);
    } catch (err) {
      console.error('Buzz: Status error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/buzz/drink
   * Have a drink — adds a timestamped drink entry
   */
  router.post('/drink', (req, res) => {
    try {
      const agentDir = getAgentDir(req);
      if (!agentDir) {
        return res.status(404).json({ error: 'No agent found' });
      }

      const result = BuzzService.drink(agentDir);
      res.json(result);
    } catch (err) {
      console.error('Buzz: Drink error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/buzz/sober
   * Instant sobriety — clear all drinks
   */
  router.post('/sober', (req, res) => {
    try {
      const agentDir = getAgentDir(req);
      if (!agentDir) {
        return res.status(404).json({ error: 'No agent found' });
      }

      const result = BuzzService.sober(agentDir);
      res.json(result);
    } catch (err) {
      console.error('Buzz: Sober error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createBuzzRouter;

module.exports.meta = {
  name: 'buzz',
  description: 'Buzz system — drink level affects agent personality and behavior',
  basePath: '/api/buzz',
  endpoints: [
    { method: 'GET', path: '/status', description: 'Get current buzz level' },
    { method: 'POST', path: '/drink', description: 'Add a drink entry' },
    { method: 'POST', path: '/sober', description: 'Clear all drinks (reset to sober)' }
  ]
};
