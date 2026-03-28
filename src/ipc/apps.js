/**
 * IPC Handlers for Apps domain
 * Handles: apps:*, assistant:get, assistant:create
 */

const { ipcMain } = require('electron');

function registerAppsHandlers({ db, services }) {
  const { AppService } = services;

  // Apps CRUD
  ipcMain.handle('apps:list', () => AppService.getActive(db));
  ipcMain.handle('apps:list-archived', () => AppService.getArchived(db));
  ipcMain.handle('apps:get', (event, id) => AppService.getById(db, id));
  ipcMain.handle('apps:create', (event, name, color, icon, textColor) => AppService.create(db, name, color, icon, textColor));
  ipcMain.handle('apps:update', (event, id, updates) => AppService.update(db, id, updates));
  ipcMain.handle('apps:archive', (event, id) => AppService.archive(db, id));
  ipcMain.handle('apps:restore', (event, id) => AppService.restore(db, id));
  ipcMain.handle('apps:delete', (event, id) => AppService.delete(db, id));
  ipcMain.handle('apps:get-system', () => AppService.getSystemApps(db));

  // Personal Assistant (app creation)
  ipcMain.handle('assistant:get', () => {
    const AgentService = require('../services/agent');
    return AgentService.getDefault(db) || AppService.getAssistant(db);
  });
  ipcMain.handle('assistant:create', (event, assistantName, ownerName) => {
    try {
      return AppService.createAssistant(db, assistantName, ownerName);
    } catch (err) {
      console.error('Failed to create assistant:', err);
      throw err;
    }
  });
}

module.exports = registerAppsHandlers;
