/**
 * MCP (Model Context Protocol) routes
 * Proxy MCP tools as REST endpoints + server management
 */

const express = require('express');

function createMcpRouter(db, { McpServerService, CapabilitySyncService, McpCatalogService }) {
  const router = express.Router();

  // ──────────────────────────────────────────────
  // Server Management
  // ──────────────────────────────────────────────

  /**
   * GET /api/mcp/servers
   * List all configured MCP servers with status.
   */
  router.get('/servers', (req, res) => {
    try {
      const servers = McpServerService.getAll(db);
      res.json(servers);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/mcp/servers
   * Add a new MCP server configuration.
   */
  router.post('/servers', express.json(), (req, res) => {
    try {
      const { name, description, transport, command, args, env, url, autoStart } = req.body;
      if (!name) return res.status(400).json({ error: 'name is required' });
      if (transport === 'stdio' && !command) return res.status(400).json({ error: 'command is required for stdio transport' });
      if (transport === 'sse' && !url) return res.status(400).json({ error: 'url is required for sse transport' });

      const result = McpServerService.add(db, { name, description, transport, command, args, env, url, autoStart });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/mcp/servers/:id
   * Get server details + discovered tools.
   */
  router.get('/servers/:id', (req, res) => {
    try {
      const server = McpServerService.getById(db, req.params.id);
      if (!server) return res.status(404).json({ error: 'Server not found' });
      server.tools = McpServerService.getTools(req.params.id);
      res.json(server);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * PATCH /api/mcp/servers/:id
   * Update server configuration.
   */
  router.patch('/servers/:id', express.json(), (req, res) => {
    try {
      McpServerService.update(db, req.params.id, req.body);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * DELETE /api/mcp/servers/:id
   * Remove server and its capabilities.
   */
  router.delete('/servers/:id', async (req, res) => {
    try {
      McpServerService.remove(db, req.params.id);
      if (CapabilitySyncService) {
        CapabilitySyncService.removeMcpTools(db, req.params.id);
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/mcp/servers/:id/start
   * Start an MCP server, discover tools, register capabilities.
   */
  router.post('/servers/:id/start', async (req, res) => {
    try {
      const result = await McpServerService.start(db, req.params.id);
      // Register tools as capabilities
      if (CapabilitySyncService && result.tools.length > 0) {
        const server = McpServerService.getById(db, req.params.id);
        CapabilitySyncService.syncMcpTools(db, req.params.id, server.name, result.tools);
      }
      res.json({ ok: true, toolCount: result.tools.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/mcp/servers/:id/stop
   * Stop an MCP server and remove its capabilities.
   */
  router.post('/servers/:id/stop', async (req, res) => {
    try {
      await McpServerService.stop(db, req.params.id);
      if (CapabilitySyncService) {
        CapabilitySyncService.removeMcpTools(db, req.params.id);
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/mcp/servers/:id/tools
   * List discovered tools for a running server.
   */
  router.get('/servers/:id/tools', (req, res) => {
    try {
      const tools = McpServerService.getTools(req.params.id);
      res.json(tools);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ──────────────────────────────────────────────
  // Catalog (browse & install MCP servers)
  // ──────────────────────────────────────────────

  /**
   * GET /api/mcp/catalog/stats
   * Catalog sync statistics.
   */
  router.get('/catalog/stats', (req, res) => {
    try {
      if (!McpCatalogService) return res.json({ total: 0 });
      res.json(McpCatalogService.getStats(db));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/mcp/catalog/search
   * Search the MCP catalog.
   */
  router.post('/catalog/search', express.json(), async (req, res) => {
    try {
      if (!McpCatalogService) return res.json([]);
      const { query, topK } = req.body;
      const results = await McpCatalogService.search(db, query || '', { topK: topK || 15 });
      res.json(results);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/mcp/catalog/:id
   * Get a single catalog entry.
   */
  router.get('/catalog/:id', (req, res) => {
    try {
      if (!McpCatalogService) return res.status(404).json({ error: 'Catalog not available' });
      const entry = McpCatalogService.getById(db, req.params.id);
      if (!entry) return res.status(404).json({ error: 'Not found' });
      res.json(entry);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/mcp/catalog/install
   * Install an MCP server from the catalog.
   */
  router.post('/catalog/install', express.json(), (req, res) => {
    try {
      if (!McpCatalogService) return res.status(500).json({ error: 'Catalog not available' });
      const { catalogId } = req.body;
      if (!catalogId) return res.status(400).json({ error: 'catalogId is required' });
      const result = McpCatalogService.install(db, catalogId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ──────────────────────────────────────────────
  // Tool Proxy — must be LAST (wildcard catch-all)
  // ──────────────────────────────────────────────

  /**
   * POST /api/mcp/:serverId/:toolName
   * Proxy a tool call to a running MCP server.
   */
  router.post('/:serverId/:toolName', express.json(), async (req, res) => {
    try {
      const result = await McpServerService.callTool(
        req.params.serverId,
        req.params.toolName,
        req.body || {}
      );
      res.json(result);
    } catch (err) {
      console.error(`[MCP] Tool call error (${req.params.serverId}/${req.params.toolName}):`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createMcpRouter;
