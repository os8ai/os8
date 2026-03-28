/**
 * Tasks management for OS8
 */

import { elements } from './elements.js';
import { attachModalBehavior, scopedTasksFile } from './helpers.js';
import { hideAllPreviews, updatePreviewBounds } from './preview.js';
import {
  getCurrentApp,
  getAgentScope,
  getEffectiveAgentId,
  getDraggedTask, setDraggedTask,
  getDraggedProject, setDraggedProject,
  getDropPosition, setDropPosition
} from './state.js';


// Store full task data for detail view
let tasksDataCache = { projects: [], tasks: [] };

export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export function renderTaskItem(task, projectId) {
  const statusClass = task.status || 'pending';

  return `
    <div class="task-item ${statusClass}" data-task-id="${task.id}" data-project-id="${projectId || ''}" draggable="true">
      <div class="task-checkbox"></div>
      <div class="task-content">
        <div class="task-title">${escapeHtml(task.title)}</div>
      </div>
    </div>
  `;
}

// Context menu state
let activeContextMenu = null;

export function showContextMenu(x, y, items, minX = 0) {
  hideContextMenu();

  const menu = document.createElement('div');
  menu.className = 'context-menu';

  items.forEach(item => {
    if (item.divider) {
      const divider = document.createElement('div');
      divider.className = 'context-menu-divider';
      menu.appendChild(divider);
    } else {
      const menuItem = document.createElement('div');
      menuItem.className = 'context-menu-item' + (item.danger ? ' danger' : '');
      menuItem.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          ${item.icon}
        </svg>
        ${item.label}
      `;
      menuItem.addEventListener('click', () => {
        hideContextMenu();
        item.action();
      });
      menu.appendChild(menuItem);
    }
  });

  // Position menu
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  document.body.appendChild(menu);

  // Adjust if menu goes off screen
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    menu.style.left = (x - rect.width) + 'px';
  }
  if (rect.bottom > window.innerHeight) {
    menu.style.top = (y - rect.height) + 'px';
  }

  // Ensure menu doesn't go past minX (e.g., into preview area)
  const adjustedRect = menu.getBoundingClientRect();
  if (adjustedRect.left < minX) {
    menu.style.left = minX + 'px';
  }

  activeContextMenu = menu;

  // Close on click outside
  setTimeout(() => {
    document.addEventListener('click', hideContextMenu, { once: true });
  }, 0);
}

export function hideContextMenu() {
  if (activeContextMenu) {
    activeContextMenu.remove();
    activeContextMenu = null;
  }
}

export async function loadTasks() {
  if (!getCurrentApp()) return;

  // System Level has no tasks — show empty state
  if (getAgentScope() === 'system') {
    renderTasks({ projects: [], tasks: [] });
    return;
  }

  const data = await scopedTasksFile().read();
  renderTasks(data);
}

export function renderTasks(data) {
  const { projects, tasks } = data;
  const view = elements.tasksViewSelect.value; // 'open', 'all', 'archive'

  // Cache full data for detail views
  tasksDataCache = data;

  // Filter projects based on view
  let filteredProjects = projects.filter(project => {
    if (view === 'open') {
      return !project.archived && project.status !== 'completed';
    } else if (view === 'all') {
      return !project.archived;
    } else if (view === 'archive') {
      return project.archived;
    }
    return true;
  });

  // Filter tasks based on view (for 'open' view, hide completed tasks)
  const filteredTasks = view === 'open'
    ? tasks.filter(task => task.status !== 'completed')
    : tasks;

  // Group tasks by project
  const tasksByProject = {};
  const unassignedTasks = [];

  filteredTasks.forEach(task => {
    if (task.projectId) {
      if (!tasksByProject[task.projectId]) {
        tasksByProject[task.projectId] = [];
      }
      tasksByProject[task.projectId].push(task);
    } else {
      unassignedTasks.push(task);
    }
  });

  // Check if there's anything to show
  const hasProjects = filteredProjects.length > 0;
  const hasUnassigned = view !== 'archive' && unassignedTasks.length > 0;

  if (!hasProjects && !hasUnassigned) {
    const emptyMsg = view === 'archive' ? 'No archived items' : 'No tasks yet';
    elements.tasksList.innerHTML = `<div class="placeholder-text">${emptyMsg}</div>`;
    return;
  }

  let html = '';

  // Render projects with their tasks
  filteredProjects.forEach(project => {
    const projectTasks = tasksByProject[project.id] || [];
    const pendingCount = projectTasks.filter(t => t.status !== 'completed').length;
    const projectStatus = project.status === 'completed' ? 'completed' : '';

    html += `
      <div class="task-project ${projectStatus}" data-project-id="${project.id}" data-archived="${project.archived || false}">
        <div class="task-project-header" draggable="true">
          <div class="project-checkbox"></div>
          <svg class="expand-icon" width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
            <path d="M7 10l5 5 5-5z"/>
          </svg>
          <span class="task-project-name">${escapeHtml(project.name)}</span>
          <span class="task-project-count">${pendingCount}</span>
        </div>
        <div class="task-project-items">
          ${projectTasks.map(task => renderTaskItem(task, project.id)).join('')}
        </div>
      </div>
    `;
  });

  // Render unassigned tasks (only in open/all views)
  if (hasUnassigned) {
    if (hasProjects) {
      html += '<div class="tasks-section-header">Unassigned</div>';
    }
    html += `<div class="unassigned-tasks">${unassignedTasks.map(task => renderTaskItem(task, null)).join('')}</div>`;
  }

  elements.tasksList.innerHTML = html;

  // Add event listeners
  elements.tasksList.querySelectorAll('.task-project-header').forEach(header => {
    header.addEventListener('click', () => {
      header.classList.toggle('collapsed');
    });
  });

  elements.tasksList.querySelectorAll('.task-checkbox').forEach(checkbox => {
    checkbox.addEventListener('click', async (e) => {
      e.stopPropagation();
      const taskItem = checkbox.closest('.task-item');
      const taskId = taskItem.dataset.taskId;
      const currentStatus = taskItem.classList.contains('completed') ? 'completed' :
                           taskItem.classList.contains('in_progress') ? 'in_progress' : 'pending';

      // Cycle: pending -> in_progress -> completed -> pending
      let newStatus;
      if (currentStatus === 'pending') {
        newStatus = 'in_progress';
      } else if (currentStatus === 'in_progress') {
        newStatus = 'completed';
      } else {
        newStatus = 'pending';
      }

      await scopedTasksFile().updateTask(taskId, { status: newStatus });
      await loadTasks();
    });
  });

  // Project checkbox click handler
  elements.tasksList.querySelectorAll('.project-checkbox').forEach(checkbox => {
    checkbox.addEventListener('click', async (e) => {
      e.stopPropagation();
      const project = checkbox.closest('.task-project');
      const projectId = project.dataset.projectId;
      const isCompleted = project.classList.contains('completed');

      const newStatus = isCompleted ? 'pending' : 'completed';
      await scopedTasksFile().updateProject(projectId, { status: newStatus });
      await loadTasks();
    });
  });

  // Drag and drop for tasks
  setupTaskDragDrop();
  setupProjectDragDrop();

  // Context menus
  setupContextMenus();

  // Task detail click handlers
  setupTaskDetailHandlers();

  // Set up bottom drop zone (only once)
  setupBottomDropZone();
}

// Track if bottom drop zone is already set up
let bottomDropZoneInitialized = false;

function setupBottomDropZone() {
  if (bottomDropZoneInitialized) return;
  bottomDropZoneInitialized = true;

  elements.tasksList.addEventListener('dragover', (e) => {
    const draggedTask = getDraggedTask();
    const draggedProject = getDraggedProject();
    if (!draggedTask && !draggedProject) return;

    // Find the appropriate last item
    let lastItem;
    if (draggedTask) {
      const items = elements.tasksList.querySelectorAll('.task-item');
      lastItem = items[items.length - 1];
    } else {
      const projects = elements.tasksList.querySelectorAll('.task-project');
      lastItem = projects[projects.length - 1];
    }

    if (!lastItem) return;
    const lastRect = lastItem.getBoundingClientRect();

    if (e.clientY > lastRect.bottom) {
      e.preventDefault();
      elements.tasksList.classList.add('drag-over-bottom');
      setDropPosition('after');
    } else {
      elements.tasksList.classList.remove('drag-over-bottom');
    }
  });

  elements.tasksList.addEventListener('dragleave', (e) => {
    if (!elements.tasksList.contains(e.relatedTarget)) {
      elements.tasksList.classList.remove('drag-over-bottom');
    }
  });

  elements.tasksList.addEventListener('drop', async (e) => {
    const draggedTask = getDraggedTask();
    const draggedProject = getDraggedProject();
    if (!draggedTask && !draggedProject) return;

    let lastItem;
    if (draggedTask) {
      const items = elements.tasksList.querySelectorAll('.task-item');
      lastItem = items[items.length - 1];
    } else {
      const projects = elements.tasksList.querySelectorAll('.task-project');
      lastItem = projects[projects.length - 1];
    }

    if (!lastItem) return;
    const lastRect = lastItem.getBoundingClientRect();

    if (e.clientY > lastRect.bottom) {
      e.preventDefault();
      elements.tasksList.classList.remove('drag-over-bottom');

      if (draggedTask) {
        const draggedId = draggedTask.dataset.taskId;
        const targetId = lastItem.dataset.taskId;
        const targetProjectId = lastItem.dataset.projectId || null;
        await scopedTasksFile().reorderTask(draggedId, targetId, targetProjectId, 'after');
      } else {
        const draggedId = draggedProject.dataset.projectId;
        const targetId = lastItem.dataset.projectId;
        await scopedTasksFile().reorderProject(draggedId, targetId, 'after');
      }
      await loadTasks();
    }
  });
}

function setupTaskDragDrop() {
  elements.tasksList.querySelectorAll('.task-item').forEach(item => {
    item.addEventListener('dragstart', (e) => {
      setDraggedTask(item);
      setDraggedProject(null);
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.stopPropagation();
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      elements.tasksList.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(el => {
        el.classList.remove('drag-over-top', 'drag-over-bottom');
      });
      setDraggedTask(null);
    });

    item.addEventListener('dragover', (e) => {
      // Only handle if we're dragging a task (let project drags bubble up)
      if (!getDraggedTask() || getDraggedTask() === item) return;

      e.preventDefault();
      e.stopPropagation();

      // Detect top or bottom half
      const rect = item.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      item.classList.remove('drag-over-top', 'drag-over-bottom');
      if (e.clientY < midY) {
        item.classList.add('drag-over-top');
        setDropPosition('before');
      } else {
        item.classList.add('drag-over-bottom');
        setDropPosition('after');
      }
    });

    item.addEventListener('dragleave', () => {
      item.classList.remove('drag-over-top', 'drag-over-bottom');
    });

    item.addEventListener('drop', async (e) => {
      // Only handle if we're dragging a task (not a project)
      if (!getDraggedTask() || getDraggedTask() === item) return;

      e.preventDefault();
      e.stopPropagation();
      item.classList.remove('drag-over-top', 'drag-over-bottom');

      const draggedId = getDraggedTask().dataset.taskId;
      const targetId = item.dataset.taskId;
      const targetProjectId = item.dataset.projectId || null;

      await scopedTasksFile().reorderTask(draggedId, targetId, targetProjectId, getDropPosition());
      await loadTasks();
    });
  });
}

function setupProjectDragDrop() {
  elements.tasksList.querySelectorAll('.task-project').forEach(project => {
    const header = project.querySelector('.task-project-header');

    // Drag starts from the header
    header.addEventListener('dragstart', (e) => {
      setDraggedProject(project);
      setDraggedTask(null);
      project.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    header.addEventListener('dragend', () => {
      project.classList.remove('dragging');
      elements.tasksList.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(el => {
        el.classList.remove('drag-over-top', 'drag-over-bottom');
      });
      setDraggedProject(null);
    });

    // Dragover on the ENTIRE project (header + tasks), not just header
    project.addEventListener('dragover', (e) => {
      if (!getDraggedProject() || getDraggedProject() === project) return;
      e.preventDefault();
      e.stopPropagation();

      // If over the header area → before, if over tasks area → after
      const headerRect = header.getBoundingClientRect();
      project.classList.remove('drag-over-top', 'drag-over-bottom');
      if (e.clientY <= headerRect.bottom) {
        project.classList.add('drag-over-top');
        setDropPosition('before');
      } else {
        project.classList.add('drag-over-bottom');
        setDropPosition('after');
      }
    });

    project.addEventListener('dragleave', (e) => {
      if (!project.contains(e.relatedTarget)) {
        project.classList.remove('drag-over-top', 'drag-over-bottom');
      }
    });

    project.addEventListener('drop', async (e) => {
      if (!getDraggedProject() || getDraggedProject() === project) return;
      e.preventDefault();
      e.stopPropagation();
      project.classList.remove('drag-over-top', 'drag-over-bottom');

      const draggedId = getDraggedProject().dataset.projectId;
      const targetId = project.dataset.projectId;

      await scopedTasksFile().reorderProject(draggedId, targetId, getDropPosition());
      await loadTasks();
    });
  });
}

function setupTaskDetailHandlers() {
  elements.tasksList.querySelectorAll('.task-item').forEach(item => {
    const content = item.querySelector('.task-content');
    content.addEventListener('click', (e) => {
      e.stopPropagation();
      const taskId = item.dataset.taskId;
      showTaskDetails(taskId);
    });
  });
}

/**
 * Show task details in the file viewer modal
 * Displays all JSON fields associated with the task
 */
function showTaskDetails(taskId) {
  const task = tasksDataCache.tasks.find(t => t.id === taskId);
  if (!task) return;

  // Hide preview (BrowserView sits on top)
  hideAllPreviews();

  // Format task as readable key-value pairs
  const lines = [];
  const standardFields = ['id', 'title', 'description', 'status', 'created', 'projectId'];

  // Show standard fields first (in order)
  for (const field of standardFields) {
    if (task[field] !== undefined) {
      lines.push(formatField(field, task[field]));
    }
  }

  // Show any extra fields the agent added
  const extraFields = Object.keys(task).filter(k => !standardFields.includes(k));
  if (extraFields.length > 0) {
    lines.push('');
    lines.push('--- Additional Fields ---');
    for (const field of extraFields) {
      lines.push(formatField(field, task[field]));
    }
  }

  const content = lines.join('\n');

  elements.fileViewerName.textContent = task.title || `Task ${taskId}`;
  elements.fileViewerModal.classList.add('active');

  // Reset content area
  elements.fileViewerContent.className = 'file-viewer-content';
  elements.fileViewerContent.innerHTML = '<pre><code></code></pre>';
  elements.fileViewerContent.classList.add('text-view');
  elements.fileViewerContent.querySelector('code').textContent = content;
}

/**
 * Format a field value for display
 */
function formatField(key, value) {
  if (Array.isArray(value)) {
    return `${key}: [${value.join(', ')}]`;
  } else if (typeof value === 'object' && value !== null) {
    return `${key}: ${JSON.stringify(value, null, 2)}`;
  }
  return `${key}: ${value}`;
}

function setupContextMenus() {
  // Task context menu
  elements.tasksList.querySelectorAll('.task-item').forEach(item => {
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const taskId = item.dataset.taskId;
      const taskTitle = item.querySelector('.task-title').textContent;
      const minX = elements.previewArea.getBoundingClientRect().right;

      showContextMenu(e.clientX, e.clientY, [
        {
          label: 'Rename',
          icon: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
          action: () => showRenameTaskModal(taskId, taskTitle)
        },
        { divider: true },
        {
          label: 'Delete',
          icon: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14"/>',
          danger: true,
          action: async () => {
            await scopedTasksFile().deleteTask(taskId);
            await loadTasks();
          }
        }
      ], minX);
    });
  });

  // Project context menu
  elements.tasksList.querySelectorAll('.task-project-header').forEach(header => {
    header.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const project = header.closest('.task-project');
      const projectId = project.dataset.projectId;
      const isArchived = project.dataset.archived === 'true';
      const minX = elements.previewArea.getBoundingClientRect().right;

      const menuItems = [
        {
          label: 'Rename',
          icon: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
          action: () => showRenameProjectModal(projectId, header.querySelector('.task-project-name').textContent)
        },
        { divider: true },
        {
          label: isArchived ? 'Unarchive' : 'Archive',
          icon: '<path d="M21 8v13H3V8M1 3h22v5H1zM10 12h4"/>',
          action: async () => {
            await scopedTasksFile().updateProject(projectId, { archived: !isArchived });
            await loadTasks();
          }
        },
        { divider: true },
        {
          label: 'Delete',
          icon: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14"/>',
          danger: true,
          action: async () => {
            if (confirm('Delete this project and all its tasks?')) {
              await scopedTasksFile().deleteProject(projectId);
              await loadTasks();
            }
          }
        }
      ];

      showContextMenu(e.clientX, e.clientY, menuItems, minX);
    });
  });
}

export function showRenameTaskModal(taskId, currentTitle) {
  hideAllPreviews();

  const overlay = document.createElement('div');
  overlay.className = 'task-input-overlay';
  overlay.innerHTML = `
    <div class="task-input-modal">
      <div class="task-input-title">Rename Task</div>
      <input type="text" class="task-input-field" id="renameInputField" value="${escapeHtml(currentTitle)}">
      <div class="task-input-buttons">
        <button class="task-input-btn cancel" id="renameCancelBtn">Cancel</button>
        <button class="task-input-btn submit" id="renameSubmitBtn">Rename</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const inputField = document.getElementById('renameInputField');
  const cancelBtn = document.getElementById('renameCancelBtn');
  const submitBtn = document.getElementById('renameSubmitBtn');

  inputField.select();

  const closeModal = () => {
    overlay.remove();
    updatePreviewBounds();
  };

  cancelBtn.addEventListener('click', closeModal);
  attachModalBehavior(overlay, inputField, submitBtn, closeModal);

  submitBtn.addEventListener('click', async () => {
    const value = inputField.value.trim();
    if (!value) return;

    await scopedTasksFile().updateTask(taskId, { title: value });
    closeModal();
    await loadTasks();
  });
}

export function showRenameProjectModal(projectId, currentName) {
  hideAllPreviews();

  const overlay = document.createElement('div');
  overlay.className = 'task-input-overlay';
  overlay.innerHTML = `
    <div class="task-input-modal">
      <div class="task-input-title">Rename Project</div>
      <input type="text" class="task-input-field" id="renameInputField" value="${escapeHtml(currentName)}">
      <div class="task-input-buttons">
        <button class="task-input-btn cancel" id="renameCancelBtn">Cancel</button>
        <button class="task-input-btn submit" id="renameSubmitBtn">Rename</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const inputField = document.getElementById('renameInputField');
  const cancelBtn = document.getElementById('renameCancelBtn');
  const submitBtn = document.getElementById('renameSubmitBtn');

  inputField.select();

  const closeModal = () => {
    overlay.remove();
    updatePreviewBounds();
  };

  cancelBtn.addEventListener('click', closeModal);
  attachModalBehavior(overlay, inputField, submitBtn, closeModal);

  submitBtn.addEventListener('click', async () => {
    const value = inputField.value.trim();
    if (!value) return;

    await scopedTasksFile().updateProject(projectId, { name: value });
    closeModal();
    await loadTasks();
  });
}

export function showTaskModal(type = 'task') {
  const isTask = type === 'task';
  const title = isTask ? 'Add Task' : 'Add Project';

  // Hide preview (BrowserView sits on top of everything)
  hideAllPreviews();

  const overlay = document.createElement('div');
  overlay.className = 'task-input-overlay';
  overlay.innerHTML = `
    <div class="task-input-modal">
      <div class="task-input-title">${title}</div>
      <input type="text" class="task-input-field" id="taskInputField" placeholder="${isTask ? 'Task description...' : 'Project name...'}" autofocus>
      ${isTask ? `
        <select class="task-input-select" id="taskProjectSelect" style="margin-bottom: 12px;">
          <option value="">No project</option>
        </select>
      ` : ''}
      <div class="task-input-buttons">
        <button class="task-input-btn cancel" id="taskCancelBtn">Cancel</button>
        <button class="task-input-btn submit" id="taskSubmitBtn">Add</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const inputField = document.getElementById('taskInputField');
  const cancelBtn = document.getElementById('taskCancelBtn');
  const submitBtn = document.getElementById('taskSubmitBtn');

  // Populate projects dropdown if adding task
  if (isTask) {
    const projectSelect = document.getElementById('taskProjectSelect');
    scopedTasksFile().getProjects().then(projects => {
      projects.forEach(project => {
        const option = document.createElement('option');
        option.value = project.id;
        option.textContent = project.name;
        projectSelect.appendChild(option);
      });
    });
  }

  const closeModal = () => {
    overlay.remove();
    updatePreviewBounds();
  };

  cancelBtn.addEventListener('click', closeModal);
  attachModalBehavior(overlay, inputField, submitBtn, closeModal);

  submitBtn.addEventListener('click', async () => {
    const value = inputField.value.trim();
    if (!value) return;

    if (isTask) {
      const projectId = document.getElementById('taskProjectSelect').value || null;
      await scopedTasksFile().createTask(value, projectId);
    } else {
      await scopedTasksFile().createProject(value);
    }

    closeModal();
    await loadTasks();
  });

  inputField.focus();
}
