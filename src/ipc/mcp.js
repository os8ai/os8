/**
 * IPC handlers for MCP server management
 */

const { ipcMain } = require('electron');

function registerMcpHandlers({ db, services }) {
  const { McpServerService, McpCatalogService, CapabilitySyncService } = services;

  ipcMain.handle('mcp:servers:list', () => {
    return McpServerService.getAll(db);
  });

  ipcMain.handle('mcp:servers:get', (_, id) => {
    const server = McpServerService.getById(db, id);
    if (server) server.tools = McpServerService.getTools(id);
    return server;
  });

  ipcMain.handle('mcp:servers:add', (_, config) => {
    return McpServerService.add(db, config);
  });

  ipcMain.handle('mcp:servers:update', (_, id, updates) => {
    McpServerService.update(db, id, updates);
    return { ok: true };
  });

  ipcMain.handle('mcp:servers:remove', (_, id) => {
    McpServerService.remove(db, id);
    CapabilitySyncService.removeMcpTools(db, id);
    return { ok: true };
  });

  ipcMain.handle('mcp:servers:start', async (_, id) => {
    const result = await McpServerService.start(db, id);
    if (result.tools.length > 0) {
      const server = McpServerService.getById(db, id);
      CapabilitySyncService.syncMcpTools(db, id, server.name, result.tools);
    }
    return { ok: true, toolCount: result.tools.length };
  });

  ipcMain.handle('mcp:servers:stop', async (_, id) => {
    await McpServerService.stop(db, id);
    CapabilitySyncService.removeMcpTools(db, id);
    return { ok: true };
  });

  ipcMain.handle('mcp:servers:tools', (_, id) => {
    return McpServerService.getTools(id);
  });

  ipcMain.handle('mcp:servers:status', (_, id) => {
    return McpServerService.getStatus(id);
  });

  // Catalog
  ipcMain.handle('mcp:catalog:search', async (_, query, options) => {
    return McpCatalogService.search(db, query, options);
  });

  ipcMain.handle('mcp:catalog:get', (_, id) => {
    return McpCatalogService.getById(db, id);
  });

  ipcMain.handle('mcp:catalog:install', (_, catalogId) => {
    return McpCatalogService.install(db, catalogId);
  });

  ipcMain.handle('mcp:catalog:stats', () => {
    return McpCatalogService.getStats(db);
  });
}

module.exports = registerMcpHandlers;
