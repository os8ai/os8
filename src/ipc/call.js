/**
 * Call IPC Handlers
 * Notifies desktop UI about phone call state
 */

const { ipcMain } = require('electron');
const CallService = require('../services/call');

/**
 * Register call-related IPC handlers
 * @param {object} deps - Dependencies
 * @param {BrowserWindow} deps.mainWindow - Main window for sending events
 */
function registerCallHandlers({ mainWindow }) {
  // Check if a call is currently active
  ipcMain.handle('call:is-active', () => {
    return CallService.hasActiveCall();
  });

  // Subscribe to call events and forward to renderer
  CallService.on('call-active', (data) => {
    console.log('Call: Notifying desktop UI - call active');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('call:active', data);
    }
  });

  CallService.on('call-ended', (data) => {
    console.log('Call: Notifying desktop UI - call ended');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('call:ended', data);
    }
  });
}

module.exports = registerCallHandlers;
