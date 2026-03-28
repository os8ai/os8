/**
 * IPC Handlers for App Inspection
 * Handles: inspect:*
 */

const { ipcMain } = require('electron');

function registerInspectHandlers({ mainWindow, state }) {
  const AppInspectorService = require('../services/app-inspector');
  // previewService is set on state by registerPreviewHandlers (runs before this)
  const { previewService } = state;
  AppInspectorService.init(mainWindow, previewService);

  ipcMain.handle('inspect:capture', async (event, appId, appUrl) => {
    return AppInspectorService.inspect(appId, appUrl);
  });

  ipcMain.handle('inspect:console', async (event, appId) => {
    return previewService.getConsoleBuffer(appId);
  });

  return {
    destroyAllInspectionViews: () => AppInspectorService.destroyAll()
  };
}

module.exports = registerInspectHandlers;
