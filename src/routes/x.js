/**
 * X (Twitter) search API routes
 * Search X posts via the xAI Grok API using the existing XAI_API_KEY.
 */

const express = require('express');
const XService = require('../services/x');
const {
  XAIKeyMissingError,
  MAX_LIMIT,
  DEFAULT_LIMIT,
  DEFAULT_MAX_TOOL_CALLS,
  MAX_TOOL_CALLS_CEILING,
} = XService;

function createXRouter(db, _services = {}) {
  const router = express.Router();
  const svc = new XService(db);

  const send = (res, err) => {
    if (err instanceof XAIKeyMissingError) {
      return res.status(503).json({ error: err.message, code: err.code });
    }
    const status = /required|invalid/i.test(err.message) ? 400 : 500;
    console.error('X API error:', err);
    return res.status(status).json({ error: err.message });
  };

  /**
   * GET /api/x/status
   * Is the X search capability available (XAI_API_KEY present)?
   */
  router.get('/status', (req, res) => {
    try {
      res.json({
        ready: XService.isAvailable(db),
        maxLimit: MAX_LIMIT,
        defaultLimit: DEFAULT_LIMIT,
        defaultMaxToolCalls: DEFAULT_MAX_TOOL_CALLS,
        maxToolCallsCeiling: MAX_TOOL_CALLS_CEILING,
      });
    } catch (err) {
      send(res, err);
    }
  });

  /**
   * POST /api/x/search
   * Body: { query, allowedHandles?, excludedHandles?, fromDate?, toDate?, limit?, analyzeImages?, analyzeVideos? }
   */
  router.post('/search', async (req, res) => {
    try {
      const result = await svc.search(req.body || {});
      res.json(result);
    } catch (err) {
      send(res, err);
    }
  });

  /**
   * POST /api/x/user-posts
   * Body: { handles: string[], topic?, fromDate?, toDate?, limit? }
   */
  router.post('/user-posts', async (req, res) => {
    try {
      const result = await svc.userPosts(req.body || {});
      res.json(result);
    } catch (err) {
      send(res, err);
    }
  });

  /**
   * POST /api/x/summarize-topic
   * Body: { topic, window?, stance?, limit? }
   */
  router.post('/summarize-topic', async (req, res) => {
    try {
      const result = await svc.summarizeTopic(req.body || {});
      res.json(result);
    } catch (err) {
      send(res, err);
    }
  });

  return router;
}

module.exports = createXRouter;

module.exports.meta = {
  name: 'x',
  description: 'Search X (Twitter) posts using the Grok API (same XAI_API_KEY as Grok chat).',
  basePath: '/api/x',
  endpoints: [
    {
      method: 'GET',
      path: '/status',
      description: 'Check if X search is available (XAI_API_KEY present).',
      returns: { ready: 'boolean', maxLimit: 'number', defaultLimit: 'number' },
    },
    {
      method: 'POST',
      path: '/search',
      description: 'Search X posts by keyword or natural-language query.',
      params: {
        query: 'string, required — what to search for',
        allowedHandles: 'string[], optional — only consider these handles (max 10)',
        excludedHandles: 'string[], optional — exclude these handles (max 10)',
        fromDate: 'string, optional — ISO date "YYYY-MM-DD"',
        toDate: 'string, optional — ISO date "YYYY-MM-DD"',
        limit: `number, optional — max posts (default ${DEFAULT_LIMIT}, hard cap ${MAX_LIMIT})`,
        maxToolCalls: `number, optional — hint for how many billable searches Grok may issue (default ${DEFAULT_MAX_TOOL_CALLS}, ceiling ${MAX_TOOL_CALLS_CEILING}). Not a hard cap for server-side tools; check usage.xSearchCalls in the response for actual cost.`,
        analyzeImages: 'boolean, optional — enable image understanding',
        analyzeVideos: 'boolean, optional — enable video understanding',
      },
      returns: {
        answer: 'string — synthesized answer from Grok (authoritative)',
        posts: 'array of { handle, url, text, postedAt } — clamped to limit',
        toolCalls: 'array — which x_search sub-tools Grok invoked',
        usage: '{ inputTokens, outputTokens, xSearchCalls, costUsd, ... }',
      },
    },
    {
      method: 'POST',
      path: '/user-posts',
      description: 'Fetch recent posts from specific X handles.',
      params: {
        handles: 'string[], required — list of handles (with or without @)',
        topic: 'string, optional — filter to this topic',
        fromDate: 'string, optional',
        toDate: 'string, optional',
        limit: `number, optional (default ${DEFAULT_LIMIT}, cap ${MAX_LIMIT})`,
      },
      returns: { answer: 'string', posts: 'array' },
    },
    {
      method: 'POST',
      path: '/summarize-topic',
      description: 'Summarize what X is saying about a topic right now.',
      params: {
        topic: 'string, required',
        window: 'string, optional — one of "24h", "3d", "7d" (default), "30d"',
        stance: 'string, optional — "neutral" (default), "pro", or "critical"',
        limit: `number, optional (default ${DEFAULT_LIMIT}, cap ${MAX_LIMIT})`,
      },
      returns: { answer: 'string', posts: 'array' },
    },
  ],
};
