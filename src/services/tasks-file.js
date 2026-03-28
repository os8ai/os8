const fs = require('fs');
const path = require('path');
const { APPS_DIR } = require('../config');
const { generateId } = require('../utils');
const AgentService = require('./agent');

// Tasks File Service - JSON-based task management per app
const TasksFileService = {
  // Get the tasks.json path for an app/agent
  getTasksPath(appId, agentId) {
    if (agentId) {
      const { agentDir } = AgentService.getPaths(appId, agentId);
      return path.join(agentDir, 'tasks.json');
    }
    // Standard app: tasks.json at app root
    return path.join(APPS_DIR, appId, 'tasks.json');
  },

  // Read tasks.json for an app
  read(appId, agentId) {
    const tasksPath = this.getTasksPath(appId, agentId);
    if (!fs.existsSync(tasksPath)) {
      // Create default tasks.json if it doesn't exist
      const defaultData = { projects: [], tasks: [] };
      fs.writeFileSync(tasksPath, JSON.stringify(defaultData, null, 2));
      return defaultData;
    }
    try {
      let content = fs.readFileSync(tasksPath, 'utf-8');
      // Remove trailing commas (common AI mistake) before parsing
      content = content.replace(/,(\s*[}\]])/g, '$1');
      return JSON.parse(content);
    } catch (err) {
      console.error('Error reading tasks.json:', err);
      return { projects: [], tasks: [] };
    }
  },

  // Write tasks.json for an app
  write(appId, agentId, data) {
    const tasksPath = this.getTasksPath(appId, agentId);
    fs.writeFileSync(tasksPath, JSON.stringify(data, null, 2));
  },

  // Get all tasks (optionally filtered by project)
  getTasks(appId, agentId, projectId = null) {
    const data = this.read(appId, agentId);
    if (projectId) {
      return data.tasks.filter(t => t.projectId === projectId);
    }
    return data.tasks;
  },

  // Get all projects
  getProjects(appId, agentId) {
    const data = this.read(appId, agentId);
    return data.projects;
  },

  // Create a new project
  createProject(appId, agentId, name) {
    const data = this.read(appId, agentId);
    const project = {
      id: generateId(),
      name,
      createdAt: new Date().toISOString()
    };
    data.projects.push(project);
    this.write(appId, agentId, data);
    return project;
  },

  // Update a project
  updateProject(appId, agentId, projectId, updates) {
    const data = this.read(appId, agentId);
    const idx = data.projects.findIndex(p => p.id === projectId);
    if (idx !== -1) {
      data.projects[idx] = { ...data.projects[idx], ...updates };
      this.write(appId, agentId, data);
      return data.projects[idx];
    }
    return null;
  },

  // Delete a project (and its tasks)
  deleteProject(appId, agentId, projectId) {
    const data = this.read(appId, agentId);
    data.projects = data.projects.filter(p => p.id !== projectId);
    data.tasks = data.tasks.filter(t => t.projectId !== projectId);
    this.write(appId, agentId, data);
  },

  // Create a new task
  createTask(appId, agentId, title, projectId = null) {
    const data = this.read(appId, agentId);
    const task = {
      id: generateId(),
      title,
      projectId,
      status: 'pending', // pending, in_progress, completed
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    data.tasks.push(task);
    this.write(appId, agentId, data);
    return task;
  },

  // Update a task
  updateTask(appId, agentId, taskId, updates) {
    const data = this.read(appId, agentId);
    const idx = data.tasks.findIndex(t => t.id === taskId);
    if (idx !== -1) {
      data.tasks[idx] = {
        ...data.tasks[idx],
        ...updates,
        updatedAt: new Date().toISOString()
      };
      this.write(appId, agentId, data);
      return data.tasks[idx];
    }
    return null;
  },

  // Delete a task
  deleteTask(appId, agentId, taskId) {
    const data = this.read(appId, agentId);
    data.tasks = data.tasks.filter(t => t.id !== taskId);
    this.write(appId, agentId, data);
  },

  // Get task stats for an app
  getStats(appId, agentId) {
    const data = this.read(appId, agentId);
    const total = data.tasks.length;
    const completed = data.tasks.filter(t => t.status === 'completed').length;
    const inProgress = data.tasks.filter(t => t.status === 'in_progress').length;
    const pending = data.tasks.filter(t => t.status === 'pending').length;
    return { total, completed, inProgress, pending };
  },

  // Reorder a task (move before/after target task, optionally change project)
  reorderTask(appId, agentId, taskId, targetTaskId, targetProjectId, position = 'before') {
    const data = this.read(appId, agentId);

    // Find and remove the dragged task
    const taskIdx = data.tasks.findIndex(t => t.id === taskId);
    if (taskIdx === -1) return;

    const task = data.tasks.splice(taskIdx, 1)[0];

    // Update project if changed
    task.projectId = targetProjectId;

    // Find target position and insert
    let targetIdx = data.tasks.findIndex(t => t.id === targetTaskId);
    if (targetIdx === -1) {
      data.tasks.push(task);
    } else {
      if (position === 'after') targetIdx++;
      data.tasks.splice(targetIdx, 0, task);
    }

    this.write(appId, agentId, data);
  },

  // Reorder a project (move before/after target project)
  reorderProject(appId, agentId, projectId, targetProjectId, position = 'before') {
    const data = this.read(appId, agentId);

    // Find and remove the dragged project
    const projectIdx = data.projects.findIndex(p => p.id === projectId);
    if (projectIdx === -1) return;

    const project = data.projects.splice(projectIdx, 1)[0];

    // Find target position and insert
    let targetIdx = data.projects.findIndex(p => p.id === targetProjectId);
    if (targetIdx === -1) {
      data.projects.push(project);
    } else {
      if (position === 'after') targetIdx++;
      data.projects.splice(targetIdx, 0, project);
    }

    this.write(appId, agentId, data);
  }
};

module.exports = TasksFileService;
