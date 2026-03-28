/**
 * IPC Handlers for Core Services domain
 * Handles: core:*, paths:*, server:*
 */

const { ipcMain } = require('electron');
const path = require('path');

function registerCoreHandlers({ mainWindow, services, helpers }) {
  const { CoreService, APPS_DIR, BLOB_DIR } = services;
  const { restartServer, getAppUrl, getPort } = helpers;

  // Core Services
  ipcMain.handle('core:status', () => CoreService.getStatus());
  ipcMain.handle('core:setup', async () => {
    try {
      const result = await CoreService.setup();

      // Restart server to enable Vite middleware
      console.log('Core ready, restarting server with Vite support...');
      await restartServer();

      // Notify renderer that core is ready
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('core:ready');
      }
      return result;
    } catch (err) {
      console.error('Core setup failed:', err);
      throw err;
    }
  });
  ipcMain.handle('core:path', () => CoreService.getPath());

  // Paths
  ipcMain.handle('paths:get', () => ({
    apps: APPS_DIR,
    blob: BLOB_DIR,
    install: path.resolve(__dirname, '..', '..'),
    userData: require('../config').OS8_DIR,
  }));

  // Server info
  ipcMain.handle('server:get-app-url', (event, slug) => getAppUrl(slug));
  ipcMain.handle('server:get-port', () => getPort());
}

module.exports = registerCoreHandlers;
