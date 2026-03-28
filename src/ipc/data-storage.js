/**
 * IPC Handlers for Data Storage domain
 * Handles: data:*
 */

const { ipcMain } = require('electron');

function registerDataStorageHandlers({ db, services }) {
  const { DataStorageService } = services;

  ipcMain.handle('data:getSources', (event, appId) => {
    return DataStorageService.getSources(db, appId);
  });

  ipcMain.handle('data:getChunks', (event, appId, source, limit, offset, sourceType) => {
    return DataStorageService.getChunks(db, appId, source, limit, offset, sourceType);
  });

  ipcMain.handle('data:getChunk', (event, chunkId, scopeId) => {
    return DataStorageService.getChunk(db, chunkId, scopeId);
  });

  ipcMain.handle('data:getStats', (event, appId) => {
    return DataStorageService.getStats(db, appId);
  });

  ipcMain.handle('data:deleteChunk', async (event, chunkId, scopeId) => {
    const result = await DataStorageService.deleteChunk(db, chunkId, scopeId);
    // Invalidate in-memory chunk caches so deleted data
    // no longer appears in semantic search results
    const { getAgentState } = require('../services/agent-state');

    // Deep delete returns an object with affectedAgentIds
    if (result && result.affectedAgentIds) {
      for (const agentId of result.affectedAgentIds) {
        const state = getAgentState(agentId);
        if (state && state.memory) {
          state.memory.invalidateChunkCache();
        }
      }
    } else if (result && scopeId) {
      // Simple delete (non-conversation-entries) — invalidate the requesting agent
      const state = getAgentState(scopeId);
      if (state && state.memory) {
        state.memory.invalidateChunkCache();
      }
    }
    return result;
  });
}

module.exports = registerDataStorageHandlers;
