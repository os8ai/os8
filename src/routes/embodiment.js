/**
 * Embodiment API routes
 * Toggle agent humanoid body embodiment
 */

const express = require('express');
const EmbodiedService = require('../services/embodiment');

function createEmbodimentRouter(db, { AppService }) {
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
   * GET /api/embodiment/status?agentId=optional
   * Get current embodiment state
   */
  router.get('/status', (req, res) => {
    try {
      const agentDir = getAgentDir(req);
      if (!agentDir) {
        return res.status(404).json({ error: 'No agent found' });
      }

      const active = EmbodiedService.isActive(agentDir);
      res.json({ active });
    } catch (err) {
      console.error('Embodiment: Status error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/embodiment/enter
   * Activate embodiment
   */
  router.post('/enter', (req, res) => {
    try {
      const agentDir = getAgentDir(req);
      if (!agentDir) {
        return res.status(404).json({ error: 'No agent found' });
      }

      const result = EmbodiedService.enter(agentDir);
      res.json(result);
    } catch (err) {
      console.error('Embodiment: Enter error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/embodiment/exit
   * Deactivate embodiment
   */
  router.post('/exit', (req, res) => {
    try {
      const agentDir = getAgentDir(req);
      if (!agentDir) {
        return res.status(404).json({ error: 'No agent found' });
      }

      const result = EmbodiedService.exit(agentDir);
      res.json(result);
    } catch (err) {
      console.error('Embodiment: Exit error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createEmbodimentRouter;

module.exports.meta = {
  name: 'embodiment',
  description: 'Humanoid body embodiment — activate a physical form with full sensory experience (touch, temperature, proprioception). When active, injects body-awareness context into your conversation.',
  basePath: '/api/embodiment',
  endpoints: [
    { method: 'GET', path: '/status', description: 'Check if embodiment is active', params: { agentId: 'string — your agent ID (optional, defaults to primary agent)' } },
    { method: 'POST', path: '/enter', description: 'Activate humanoid body embodiment', params: { agentId: 'string — your agent ID' } },
    { method: 'POST', path: '/exit', description: 'Deactivate humanoid body embodiment', params: { agentId: 'string — your agent ID' } }
  ]
};
