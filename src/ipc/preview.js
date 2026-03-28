/**
 * IPC Handlers for Preview (BrowserView) domain
 * Handles: preview:*
 * Thin dispatcher — business logic lives in PreviewService.
 */

const { ipcMain } = require('electron');
const PreviewService = require('../services/preview');

function registerPreviewHandlers({ mainWindow, state }) {
  const { previewViews } = state;

  const previewService = new PreviewService({ mainWindow, views: previewViews });

  // Create/destroy preview views
  ipcMain.handle('preview:create', (event, appId) => {
    return previewService.create(appId) ? true : false;
  });

  ipcMain.handle('preview:destroy', (event, appId) => {
    return previewService.destroy(appId);
  });

  ipcMain.handle('preview:destroy-all', () => {
    previewService.destroyAll();
    return true;
  });

  ipcMain.handle('preview:set-url', (event, appId, url) => {
    return previewService.setUrl(appId, url);
  });

  ipcMain.handle('preview:get-url', (event, appId) => {
    return previewService.getUrl(appId);
  });

  ipcMain.handle('preview:refresh', (event, appId) => {
    return previewService.refresh(appId);
  });

  ipcMain.handle('preview:go-back', (event, appId) => {
    return previewService.goBack(appId);
  });

  ipcMain.handle('preview:go-forward', (event, appId) => {
    return previewService.goForward(appId);
  });

  // Consolidated navigation state (reduces 3 calls to 1)
  ipcMain.handle('preview:get-nav-state', (event, appId) => {
    return previewService.getNavState(appId);
  });

  // Individual handlers kept for backwards compatibility
  ipcMain.handle('preview:can-go-back', (event, appId) => {
    return previewService.canGoBack(appId);
  });

  ipcMain.handle('preview:can-go-forward', (event, appId) => {
    return previewService.canGoForward(appId);
  });

  ipcMain.handle('preview:set-bounds', (event, appId, bounds) => {
    return previewService.setBounds(appId, bounds);
  });

  ipcMain.handle('preview:hide', (event, appId) => {
    return previewService.hide(appId);
  });

  ipcMain.handle('preview:hide-all', () => {
    return previewService.hideAll();
  });

  ipcMain.handle('preview:set-mode', async (event, appId, mode) => {
    return previewService.setMode(appId, mode);
  });

  ipcMain.handle('preview:broadcast-mode', async (event, mode) => {
    return previewService.broadcastMode(mode);
  });

  // Expose cleanup + service instance for cross-handler access
  return {
    destroyAllPreviewViews: () => previewService.destroyAll(),
    previewService
  };
}

module.exports = registerPreviewHandlers;
