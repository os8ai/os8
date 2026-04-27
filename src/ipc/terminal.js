/**
 * IPC Handlers for Terminal (PTY) domain
 * Handles: terminal:*
 * Thin dispatcher — business logic lives in PTYService.
 */

const { ipcMain } = require('electron');
const PTYService = require('../services/pty');

function registerTerminalHandlers({ mainWindow, db, services, state }) {
  const { AppService, EnvService, APPS_DIR } = services;
  const { ptySessions } = state;

  const ptyService = new PTYService({
    db,
    mainWindow,
    sessions: ptySessions,
    services: { AppService, EnvService, APPS_DIR }
  });

  ipcMain.handle('terminal:create', (event, appId, type, opts) => {
    return ptyService.create(appId, type || 'terminal', opts || {});
  });

  ipcMain.handle('terminal:write', (event, sessionId, data) => {
    return ptyService.write(sessionId, data);
  });

  ipcMain.handle('terminal:resize', (event, sessionId, cols, rows) => {
    return ptyService.resize(sessionId, cols, rows);
  });

  ipcMain.handle('terminal:kill', (event, sessionId) => {
    return ptyService.kill(sessionId);
  });

  ipcMain.handle('terminal:get-buffer', (event, sessionId) => {
    return ptyService.getBuffer(sessionId);
  });

  ipcMain.handle('terminal:list', () => {
    return ptyService.list();
  });

  // Expose helper functions for cleanup
  return {
    killAllPtySessions: () => ptyService.killAll()
  };
}

module.exports = registerTerminalHandlers;
