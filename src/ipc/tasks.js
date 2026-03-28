/**
 * IPC Handlers for Tasks domain
 * Handles: tasksFile:* (JSON-based task management)
 */

const { ipcMain } = require('electron');

function registerTasksHandlers({ services, helpers }) {
  const { TasksFileService } = services;
  const { startTasksWatcher, stopTasksWatcher } = helpers;

  // Tasks File (JSON-based) — agentId is optional for backward compat
  ipcMain.handle('tasksFile:read', (event, appId, agentId) => TasksFileService.read(appId, agentId));
  ipcMain.handle('tasksFile:getTasks', (event, appId, agentId, projectId) => TasksFileService.getTasks(appId, agentId, projectId));
  ipcMain.handle('tasksFile:getProjects', (event, appId, agentId) => TasksFileService.getProjects(appId, agentId));
  ipcMain.handle('tasksFile:createProject', (event, appId, agentId, name) => TasksFileService.createProject(appId, agentId, name));
  ipcMain.handle('tasksFile:updateProject', (event, appId, agentId, projectId, updates) => TasksFileService.updateProject(appId, agentId, projectId, updates));
  ipcMain.handle('tasksFile:deleteProject', (event, appId, agentId, projectId) => TasksFileService.deleteProject(appId, agentId, projectId));
  ipcMain.handle('tasksFile:createTask', (event, appId, agentId, title, projectId) => TasksFileService.createTask(appId, agentId, title, projectId));
  ipcMain.handle('tasksFile:updateTask', (event, appId, agentId, taskId, updates) => TasksFileService.updateTask(appId, agentId, taskId, updates));
  ipcMain.handle('tasksFile:deleteTask', (event, appId, agentId, taskId) => TasksFileService.deleteTask(appId, agentId, taskId));
  ipcMain.handle('tasksFile:getStats', (event, appId, agentId) => TasksFileService.getStats(appId, agentId));
  ipcMain.handle('tasksFile:reorderTask', (event, appId, agentId, taskId, targetTaskId, targetProjectId, position) =>
    TasksFileService.reorderTask(appId, agentId, taskId, targetTaskId, targetProjectId, position));
  ipcMain.handle('tasksFile:reorderProject', (event, appId, agentId, projectId, targetProjectId, position) =>
    TasksFileService.reorderProject(appId, agentId, projectId, targetProjectId, position));
  ipcMain.handle('tasksFile:watch', (event, appId, agentId) => startTasksWatcher(appId, agentId));
  ipcMain.handle('tasksFile:unwatch', () => stopTasksWatcher());
}

module.exports = registerTasksHandlers;
