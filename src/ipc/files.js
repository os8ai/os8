/**
 * IPC Handlers for Files domain
 * Handles: files:*
 * Thin dispatcher — business logic lives in FileSystemService.
 */

const { ipcMain } = require('electron');
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
}

module.exports = registerFilesHandlers;
