/**
 * Utility helper functions for OS8 renderer
 */

import { getCurrentApp, getEffectiveAgentId } from './state.js';

/**
 * Replace an element's event listener by cloning (prevents duplicate listeners)
 * @param {string} elementId - DOM element ID
 * @param {string} event - Event type (e.g., 'click')
 * @param {Function} handler - Event handler function
 * @returns {HTMLElement|null} The new element with listener attached
 */
export function replaceEventListener(elementId, event, handler) {
  const el = document.getElementById(elementId);
  if (!el) return null;
  const newEl = el.cloneNode(true);
  el.parentNode.replaceChild(newEl, el);
  newEl.addEventListener(event, handler);
  return newEl;
}

/**
 * Attach standard modal behaviors (overlay click, escape key, enter key)
 * @param {HTMLElement} overlay - Modal overlay element
 * @param {HTMLElement} inputField - Input field element
 * @param {HTMLElement} submitBtn - Submit button element
 * @param {Function} closeModal - Function to close the modal
 */
export function attachModalBehavior(overlay, inputField, submitBtn, closeModal) {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });
  inputField.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
    if (e.key === 'Enter') submitBtn.click();
  });
}

/**
 * Attach click handlers for file tree folder toggle and file viewing
 * @param {HTMLElement} container - File tree container element
 * @param {Function} viewFile - Function to call when file is clicked (path, name)
 */
export function attachFileTreeHandlers(container, viewFile) {
  // Folder toggle
  container.querySelectorAll('.file-tree-folder > .file-tree-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      item.parentElement.classList.toggle('collapsed');
    });
  });
  // File view
  container.querySelectorAll('.file-tree-item[data-name]').forEach(item => {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      await viewFile(item.dataset.path, item.dataset.name);
    });
  });
}

/**
 * Create a scoped tasksFile proxy that auto-injects appId and agentId
 */
export function scopedTasksFile() {
  const appId = getCurrentApp().id;
  const agentId = getEffectiveAgentId();
  const t = window.os8.tasksFile;
  return {
    read: () => t.read(appId, agentId),
    getTasks: (projectId) => t.getTasks(appId, agentId, projectId),
    getProjects: () => t.getProjects(appId, agentId),
    createProject: (name) => t.createProject(appId, agentId, name),
    updateProject: (id, updates) => t.updateProject(appId, agentId, id, updates),
    deleteProject: (id) => t.deleteProject(appId, agentId, id),
    createTask: (title, projectId) => t.createTask(appId, agentId, title, projectId),
    updateTask: (id, updates) => t.updateTask(appId, agentId, id, updates),
    deleteTask: (id) => t.deleteTask(appId, agentId, id),
    reorderTask: (id, targetId, targetProjectId, pos) => t.reorderTask(appId, agentId, id, targetId, targetProjectId, pos),
    reorderProject: (id, targetId, pos) => t.reorderProject(appId, agentId, id, targetId, pos),
    watch: () => t.watch(appId, agentId),
    unwatch: () => t.unwatch(),
    getStats: () => t.getStats(appId, agentId),
  };
}

/**
 * Create a scoped jobsFile proxy that auto-injects appId and agentId
 */
export function scopedJobsFile() {
  const appId = getCurrentApp().id;
  const agentId = getEffectiveAgentId();
  const j = window.os8.jobsFile;
  return {
    getJobs: () => j.getJobs(appId, agentId),
    getJob: (id) => j.getJob(appId, agentId, id),
    createJob: (data) => j.createJob(appId, agentId, data),
    updateJob: (id, updates) => j.updateJob(appId, agentId, id, updates),
    deleteJob: (id) => j.deleteJob(appId, agentId, id),
    toggleJob: (id) => j.toggleJob(appId, agentId, id),
    getRuns: (id, limit) => j.getRuns(appId, agentId, id, limit),
    getUpcomingJobs: () => j.getUpcomingJobs(appId, agentId),
    getDueJobs: () => j.getDueJobs(appId, agentId),
    getStats: () => j.getStats(appId, agentId),
    getSkills: () => j.getSkills(appId, agentId),
    watch: () => j.watch(appId, agentId),
    unwatch: () => j.unwatch(),
  };
}
