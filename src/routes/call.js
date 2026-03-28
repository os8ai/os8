/**
 * Call REST API routes
 * Manages call lifecycle: initiation, status, and termination
 */

const express = require('express');
const CallService = require('../services/call');

function createCallRouter(db, { getCallUrl }) {
  const router = express.Router();

  /**
   * POST /api/call/initiate
   * Create a new call
   *
   * Returns: { success, callId, url }
   */
  router.post('/initiate', express.json(), async (req, res) => {
    try {
      // Create the call
      const { callId, token } = CallService.create();

      // Generate call URL
      const url = getCallUrl(callId, token);

      res.json({
        success: true,
        callId,
        url
      });

    } catch (err) {
      console.error('Call initiate error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/call/:id/status
   * Check call status
   *
   * Returns: { exists, state?, createdAt?, joinExpiresAt?, activeSince? }
   */
  router.get('/:id/status', (req, res) => {
    const { id } = req.params;
    const status = CallService.getStatus(id);
    res.json(status);
  });

  /**
   * POST /api/call/:id/end
   * End a call
   *
   * Body: { reason?: string }
   *
   * Returns: { success: true }
   */
  router.post('/:id/end', express.json(), (req, res) => {
    const { id } = req.params;
    const { reason = 'api_request' } = req.body;

    const call = CallService.get(id);
    if (!call) {
      return res.status(404).json({ error: 'Call not found' });
    }

    CallService.end(id, reason);
    res.json({ success: true });
  });

  /**
   * GET /api/call/list
   * List all active calls (for debugging)
   *
   * Returns: { calls: [...] }
   */
  router.get('/list', (req, res) => {
    const calls = CallService.list();
    res.json({ calls });
  });

  return router;
}

module.exports = createCallRouter;
