/**
 * Apps management for OS8
 */

import { elements } from './elements.js';
import {
  getApps, setApps, addApp, getAppById,
  getAssistantApp, setAssistantApp,
  getDraggedAppIcon, setDraggedAppIcon,
  getDraggedAppIndex, setDraggedAppIndex,
  getServerPort
} from './state.js';
import { showContextMenu } from './tasks.js';

/**
 * Render an app icon as HTML (image or text with auto-shrink).
 * @param {object} app - App record from DB
 * @param {number} size - Icon size in px (64 for grid, 18 for tabs)
 */
export function renderIconHtml(app, size = 64) {
  const color = app.color || '#6366f1';
  const textColor = app.text_color || '#ffffff';
  const textIcon = app.icon || app.name.charAt(0).toUpperCase();

  if (app.icon_image) {
    const port = getServerPort();
    const imgUrl = `http://localhost:${port}/api/icons/${app.id}?v=${encodeURIComponent(app.updated_at || '')}`;
    // Image already resized to 128x128 by processIconImage — render full-size.
    // For transparent PNGs, the background color shows through naturally.
    const bgStyle = app.icon_mode === 'cover' ? '' : `background: ${color};`;
    return `<div class="app-icon-img has-image" style="${bgStyle}"><img src="${imgUrl}"></div>`;
  }

  // Text icon with auto-shrink based on character count
  let fontSize;
  if (size <= 20) {
    fontSize = textIcon.length <= 2 ? 12 : 8;
  } else {
    if (textIcon.length <= 2) fontSize = 28;
    else if (textIcon.length === 3) fontSize = 20;
    else if (textIcon.length === 4) fontSize = 16;
    else fontSize = 12;
  }

  return `<div class="app-icon-img" style="background: ${color}; color: ${textColor}; font-size: ${fontSize}px;">${textIcon}</div>`;
}

// Callbacks for functions in other modules or index.html
let callbacks = {
  createAppTab: async () => {},
  openEditAppModal: () => {}
};

/**
 * Register callbacks from index.html
 */
export function setAppsCallbacks(cbs) {
  callbacks = { ...callbacks, ...cbs };
}

/**
 * Render the apps grid
 */
export function renderApps() {
  const { appsGrid } = elements;

  if (getApps().length === 0) {
    appsGrid.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1;">
        <h3>No apps yet</h3>
        <p>Click "+ New App" to create your first app</p>
      </div>
    `;
    return;
  }

  appsGrid.innerHTML = getApps().map((app, index) => {
    const isSystem = app.app_type === 'system';
    const systemClass = isSystem ? ' system-app' : '';
    const draggable = isSystem ? 'false' : 'true'; // System apps can't be reordered
    return `
      <div class="app-icon${systemClass}" data-id="${app.id}" data-index="${index}" data-system="${isSystem}" draggable="${draggable}">
        ${renderIconHtml(app, 64)}
        <div class="app-icon-name">${app.name}</div>
      </div>
    `;
  }).join('');

  // Add event handlers to icons
  appsGrid.querySelectorAll('.app-icon').forEach(icon => {
    // Double-click to open
    icon.addEventListener('dblclick', () => {
      const appId = icon.dataset.id;
      const app = getAppById(appId);
      if (app) callbacks.createAppTab(app);
    });

    // Right-click context menu
    icon.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const appId = icon.dataset.id;
      const app = getAppById(appId);
      if (!app) return;

      const isSystem = app.app_type === 'system';
      const menuItems = [
        {
          label: 'Open',
          icon: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
          action: () => callbacks.createAppTab(app)
        }
      ];

      // Only show Edit and Archive for non-system apps
      if (!isSystem) {
        menuItems.push({
          label: 'Edit',
          icon: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
          action: () => callbacks.openEditAppModal(app)
        });
        menuItems.push({ divider: true });
        menuItems.push({
          label: 'Archive',
          icon: '<path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/>',
          danger: true,
          action: async () => {
            await window.os8.apps.archive(app.id);
            setApps(getApps().filter(a => a.id !== app.id));
            renderApps();
          }
        });
      }

      showContextMenu(e.clientX, e.clientY, menuItems);
    });

    // Drag start
    icon.addEventListener('dragstart', (e) => {
      setDraggedAppIcon(icon);
      setDraggedAppIndex(parseInt(icon.dataset.index));
      icon.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    // Drag end
    icon.addEventListener('dragend', () => {
      icon.classList.remove('dragging');
      appsGrid.querySelectorAll('.app-icon').forEach(i => i.classList.remove('drag-over'));
      setDraggedAppIcon(null);
      setDraggedAppIndex(-1);
    });

    // Drag over another icon
    icon.addEventListener('dragover', (e) => {
      if (!getDraggedAppIcon() || getDraggedAppIcon() === icon) return;
      e.preventDefault();

      // Highlight this icon as drop target
      appsGrid.querySelectorAll('.app-icon').forEach(i => i.classList.remove('drag-over'));
      icon.classList.add('drag-over');
    });

    // Drag leave
    icon.addEventListener('dragleave', () => {
      icon.classList.remove('drag-over');
    });

    // Drop on another icon
    icon.addEventListener('drop', async (e) => {
      e.preventDefault();
      icon.classList.remove('drag-over');

      if (!getDraggedAppIcon() || getDraggedAppIcon() === icon) return;

      const targetIndex = parseInt(icon.dataset.index);

      // Reorder: remove from old position, insert at new position
      const reorderedApps = [...getApps()];
      const [movedApp] = reorderedApps.splice(getDraggedAppIndex(), 1);
      reorderedApps.splice(targetIndex, 0, movedApp);
      setApps(reorderedApps);

      // Save and re-render
      await saveAppOrder();
      renderApps();
    });
  });
}

/**
 * Save the app order to the database
 */
export async function saveAppOrder() {
  const currentApps = getApps();
  for (let i = 0; i < currentApps.length; i++) {
    const app = currentApps[i];
    if (app.displayOrder !== i) {
      app.displayOrder = i;
      await window.os8.apps.update(app.id, { displayOrder: i });
    }
  }
}

/**
 * Load apps from the database
 */
export async function loadApps() {
  const regularApps = await window.os8.apps.list();
  let systemApps = await window.os8.apps.getSystem();

  // Auto-create assistant on first run if no system apps exist
  if (systemApps.length === 0) {
    try {
      await window.os8.assistant.create('Assistant', '');
      systemApps = await window.os8.apps.getSystem();
    } catch (e) {
      console.error('Failed to auto-create assistant:', e);
    }
  }

  // Load agents list for multi-agent support
  let agents = [];
  try {
    agents = await window.os8.agents.list();
  } catch (e) {
    // Fallback: treat system apps as agents
    agents = systemApps.map(a => ({ id: a.id, name: a.name, emoji: a.icon || '🤖', isDefault: false }));
  }

  // Store agents in state
  const { setAgents, setActiveAgentId, getActiveAgentId } = await import('./state.js');
  setAgents(agents);

  // Set active agent from localStorage or default
  if (!getActiveAgentId()) {
    const savedId = localStorage.getItem('os8-active-agent-id');
    const defaultAgent = agents.find(a => a.isDefault) || agents[0];
    setActiveAgentId(savedId && agents.find(a => a.id === savedId) ? savedId : (defaultAgent?.id || null));
  }

  // After consolidation: single system app is the parent container for all agents
  setAssistantApp(systemApps[0] || null);

  // Exclude all system apps from grid
  setApps(regularApps.filter(a => a.app_type !== 'system'));
  renderApps();
  updateAssistantButton();
}

/**
 * Update the assistant button visibility and icon
 */
export function updateAssistantButton() {
  const btn = document.getElementById('assistantBtn');
  if (getAssistantApp() && btn) {
    btn.style.display = 'flex';
  } else if (btn) {
    btn.style.display = 'none';
  }
}

/**
 * Create a new app
 */
export async function createApp(name, color, icon, textColor) {
  const app = await window.os8.apps.create(name, color, icon, textColor);
  // Generate CLAUDE.md for the new app
  await window.os8.claude.generateMd(app.id);
  addApp(app);
  renderApps();
  return app;
}

/**
 * Show home view (uses tab switching)
 */
export async function showHome() {
  const { switchToTab } = await import('./tabs.js');
  await switchToTab('home');
}

/**
 * Open app workspace (uses tab-based opening)
 */
export async function openWorkspace(app) {
  await callbacks.createAppTab(app);
}
