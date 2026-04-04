/**
 * IPC Handlers for Files domain
 * Handles: files:*
 * Thin dispatcher — business logic lives in FileSystemService.
 */

const { ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const AgentService = require('../services/agent');
const FileSystemService = require('../services/filesystem');

function registerFilesHandlers({ db, services }) {
  const { AppService, APPS_DIR, BLOB_DIR } = services;

  ipcMain.handle('files:list', (event, appId, agentId) => {
    const app = AppService.getById(db, appId);
    if (!app) return null;

    const appPath = agentId
      ? AgentService.getPaths(appId, agentId).agentDir
      : path.join(APPS_DIR, appId);
    if (!fs.existsSync(appPath)) return null;

    return {
      name: app.name,
      path: appPath,
      type: 'directory',
      children: FileSystemService.getTree(appPath),
    };
  });

  ipcMain.handle('files:list-blob', (event, appId, agentId) => {
    const blobPath = agentId
      ? AgentService.getPaths(appId, agentId).agentBlobDir
      : path.join(BLOB_DIR, appId);
    if (!fs.existsSync(blobPath)) {
      fs.mkdirSync(blobPath, { recursive: true });
    }

    return {
      name: 'blob',
      path: blobPath,
      type: 'directory',
      children: FileSystemService.getTree(blobPath),
    };
  });

  ipcMain.handle('files:get-paths', (event, appId, agentId) => {
    if (agentId) {
      const paths = AgentService.getPaths(appId, agentId);
      return { app: paths.agentDir, blob: paths.agentBlobDir };
    }
    return {
      app: path.join(APPS_DIR, appId),
      blob: path.join(BLOB_DIR, appId),
    };
  });

  ipcMain.handle('files:read', (event, filePath) => {
    return FileSystemService.readFile(filePath, [APPS_DIR, BLOB_DIR]);
  });

  ipcMain.handle('files:download', async (event, filePath) => {
    // Security: ensure file is within allowed directories
    const resolved = path.resolve(filePath);
    const allowed = [APPS_DIR, BLOB_DIR].some(dir => resolved.startsWith(path.resolve(dir)));
    if (!allowed) return { error: 'Access denied' };

    const { canceled, filePath: savePath } = await dialog.showSaveDialog({
      defaultPath: path.basename(resolved),
    });
    if (canceled || !savePath) return { canceled: true };

    try {
      await fs.promises.copyFile(resolved, savePath);
      return { success: true };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('files:pick-directory', async (event, defaultPath) => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      defaultPath: defaultPath || require('os').homedir(),
    });
    if (canceled || !filePaths.length) return { canceled: true };
    return { path: filePaths[0] };
  });
}

module.exports = registerFilesHandlers;
