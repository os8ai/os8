/**
 * View mode management for OS8 (Developer/User mode and Focus/Split view)
 */

import {
  getCurrentMode, setCurrentMode as stateSetCurrentMode,
  getViewMode, setViewMode as stateSetViewMode,
  getTabsInitialized,
  getAppTabs, getTabById, getAppTabByAppId, getActiveTabId
} from './state.js';
import { replaceEventListener } from './helpers.js';
import { updatePreviewBounds, ensurePreviewForApp, loadPreviewForApp } from './preview.js';

// Callbacks for functions that create circular dependencies (tabs.js imports view-mode.js)
let callbacks = {
  switchToTab: async () => {},
  closeTab: async () => {}
};

/**
 * Register callbacks from tabs.js to avoid circular imports
 */
export function setViewModeCallbacks(cbs) {
  callbacks = { ...callbacks, ...cbs };
}

/**
 * Get the effective view mode based on current conditions
 */
export function getEffectiveViewMode() {
  // In developer mode, always single app view (effectively focus)
  if (getCurrentMode() !== 'user') return 'focus';

  // If only 1 app tab (or none), always focus mode
  const appTabs = getAppTabs();
  if (appTabs.length <= 1) return 'focus';

  // Otherwise use user's preference
  return getViewMode();
}

/**
 * Update body class based on effective view mode
 */
export function updateViewModeClass() {
  document.body.classList.remove('view-focus', 'view-split');
  document.body.classList.add(`view-${getEffectiveViewMode()}`);
}

/**
 * Set the developer/user mode
 */
export function setMode(mode) {
  stateSetCurrentMode(mode);  // Handles localStorage internally

  // Broadcast mode change to all BrowserViews (apps can respond to this)
  window.os8.preview.broadcastMode(mode);

  // Update body class
  if (mode === 'user') {
    document.body.classList.add('user-mode');
  } else {
    document.body.classList.remove('user-mode');
  }

  // Update toggle button states
  document.querySelectorAll('.mode-toggle-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });

  // Only update view mode after tabs are initialized
  if (getTabsInitialized()) {
    // Update view mode class based on effective mode
    document.body.classList.remove('view-focus', 'view-split');
    document.body.classList.add(`view-${getEffectiveViewMode()}`);

    // Render user mode view or update preview bounds
    if (mode === 'user') {
      renderUserModeView();
    } else {
      // Developer mode: hide all secondary previews, only show active app
      const appTabs = getAppTabs();
      for (const tab of appTabs) {
        if (tab.id !== getActiveTabId()) {
          window.os8.preview.hide(tab.app.id);
        }
      }
      // Update preview bounds after mode change (with slight delay for CSS to apply)
      setTimeout(() => {
        updatePreviewBounds();
        // Scroll agent chat panels to bottom (they may have loaded while hidden in user mode)
        document.querySelectorAll('.agent-chat-messages').forEach(el => {
          el.scrollTop = el.scrollHeight;
        });
      }, 50);
    }
  }
}

/**
 * Attach click handlers to mode toggle buttons
 */
export function attachModeToggleListeners() {
  document.querySelectorAll('.mode-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setMode(btn.dataset.mode);
    });
  });
}

/**
 * Set the view mode (focus/split)
 */
export function setViewMode(mode) {
  stateSetViewMode(mode);  // Handles localStorage internally

  // Update view mode classes on body
  document.body.classList.remove('view-focus', 'view-split');
  document.body.classList.add(`view-${getEffectiveViewMode()}`);

  // Re-render split view if in user mode with multiple apps
  if (getCurrentMode() === 'user') {
    renderUserModeView();
  }
}

/**
 * Render the user mode view (split panels, primary panel info, etc.)
 */
export function renderUserModeView() {
  // Update view mode class first (may have changed due to tab count)
  updateViewModeClass();

  const appTabs = getAppTabs();
  const effectiveMode = getEffectiveViewMode();

  // Update has-multiple-apps class for contract button visibility in focus mode
  if (appTabs.length > 1) {
    document.body.classList.add('has-multiple-apps');
  } else {
    document.body.classList.remove('has-multiple-apps');
  }

  // Update primary panel header with active app info
  const activeTab = getTabById(getActiveTabId());
  if (activeTab && activeTab.type === 'app') {
    const app = activeTab.app;
    const primaryIcon = document.getElementById('splitPrimaryIcon');
    const primaryName = document.getElementById('splitPrimaryName');
    const primaryUrlPrefix = document.getElementById('splitPrimaryUrlPrefix');

    if (primaryIcon && app) {
      primaryIcon.textContent = app.icon || app.name?.charAt(0)?.toUpperCase() || '?';
      primaryIcon.style.background = app.color || '#6366f1';
    }
    if (primaryName && app) {
      primaryName.textContent = app.name || 'App';
    }
    if (primaryUrlPrefix && app) {
      primaryUrlPrefix.textContent = app.slug + '/';
    }
  }

  // Update expand/collapse button visibility and icon
  const expandBtn = document.getElementById('splitPrimaryExpandBtn');
  if (expandBtn) {
    if (appTabs.length <= 1) {
      // Only one app - hide the button (nothing to split with)
      expandBtn.style.display = 'none';
    } else {
      expandBtn.style.display = 'flex';
      if (effectiveMode === 'focus') {
        // In focus mode - show collapse icon (arrows inward) to go to split
        expandBtn.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M4 14h6v6m10-10h-6V4m0 6l7-7M3 21l7-7"/>
          </svg>
        `;
        expandBtn.title = 'Split view';
      } else {
        // In split mode - show expand icon (arrows outward) to go to focus
        expandBtn.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>
          </svg>
        `;
        expandBtn.title = 'Focus this app';
      }
    }
  }

  // Attach event listeners to primary panel buttons and URL bar
  attachPrimaryPanelListeners();

  // Render split secondary panels
  const splitSecondary = document.getElementById('splitSecondary');
  if (splitSecondary && effectiveMode === 'split') {
    // Get non-active app tabs for secondary panel
    const secondaryTabs = appTabs.filter(t => t.id !== getActiveTabId());

    splitSecondary.innerHTML = secondaryTabs.map(tab => {
      const app = tab.app;
      const tabColor = app?.color || '#6366f1';
      const tabIcon = app?.icon || app?.name?.charAt(0)?.toUpperCase() || '?';

      return `
        <div class="split-panel" data-tab-id="${tab.id}" data-app-id="${app?.id}">
          <div class="split-panel-header">
            <div class="split-panel-title">
              <span class="panel-icon" style="background: ${tabColor};">${tabIcon}</span>
              <span>${app?.name || 'App'}</span>
            </div>
            <div class="split-panel-controls">
              <button class="icon-btn xs split-panel-btn" data-tab-id="${tab.id}" data-action="expand" title="Focus this app">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>
                </svg>
              </button>
              <button class="icon-btn xs split-panel-btn" data-tab-id="${tab.id}" data-action="close" title="Close app">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
              </button>
            </div>
          </div>
          <div class="split-url-bar" data-app-id="${app?.id}">
            <button class="icon-btn split-url-btn" data-app-id="${app?.id}" data-action="back" title="Back">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M19 12H5M12 19l-7-7 7-7"/>
              </svg>
            </button>
            <button class="icon-btn split-url-btn" data-app-id="${app?.id}" data-action="forward" title="Forward">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M5 12h14M12 5l7 7-7 7"/>
              </svg>
            </button>
            <button class="icon-btn split-url-btn" data-app-id="${app?.id}" data-action="refresh" title="Refresh">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
              </svg>
            </button>
            <div class="split-url-container">
              <span class="split-url-prefix">${app?.slug}/</span>
              <input type="text" class="split-url-input" data-app-id="${app?.id}" placeholder="page">
            </div>
          </div>
          <div class="split-panel-content" data-app-id="${app?.id}">
            <!-- Preview will be positioned here via BrowserView -->
          </div>
        </div>
      `;
    }).join('');

    // Attach event listeners to split panel buttons and URL controls
    attachSplitPanelListeners();

    // Create and load previews for secondary apps
    loadSecondaryPreviews(secondaryTabs);
  }

  // Update preview bounds after layout renders
  setTimeout(() => {
    updatePreviewBounds();
  }, 50);
}

/**
 * Attach event listeners to split panel buttons and URL controls
 */
export function attachSplitPanelListeners() {
  // Expand buttons - switch to that app and enter focus mode
  document.querySelectorAll('.split-panel-btn[data-action="expand"]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const tabId = btn.dataset.tabId;
      setViewMode('focus');
      await callbacks.switchToTab(tabId);
    });
  });

  // Close buttons - close the app tab
  document.querySelectorAll('.split-panel .split-panel-btn[data-action="close"]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const tabId = btn.dataset.tabId;
      await callbacks.closeTab(tabId);
    });
  });

  // URL bar navigation buttons (using data-action attribute)
  document.querySelectorAll('.split-url-btn[data-action]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const appId = btn.dataset.appId;
      const action = btn.dataset.action;
      if (!appId) return;

      if (action === 'back') await window.os8.preview.goBack(appId);
      else if (action === 'forward') await window.os8.preview.goForward(appId);
      else if (action === 'refresh') await window.os8.preview.refresh(appId);
    });
  });

  // URL input - navigate on enter
  document.querySelectorAll('.split-url-input').forEach(input => {
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        e.stopPropagation();
        const appId = input.dataset.appId;
        const tab = getAppTabByAppId(appId);
        if (tab && tab.app) {
          await loadPreviewForApp(tab.app, input.value.trim());
        }
      }
    });
    // Prevent click from bubbling to panel
    input.addEventListener('click', (e) => e.stopPropagation());
  });
}

/**
 * Load previews for secondary app tabs in split view
 */
export async function loadSecondaryPreviews(secondaryTabs) {
  const port = await window.os8.server.getPort();

  for (const tab of secondaryTabs) {
    const app = tab.app;
    if (!app) continue;

    // Create preview if needed
    await ensurePreviewForApp(app);

    // Load the app URL (use saved URL if available, otherwise root)
    const savedUrl = tab.state?.previewUrl;
    if (savedUrl) {
      await window.os8.preview.setUrl(app.id, savedUrl);
    } else {
      const fullUrl = `http://localhost:${port}/${app.slug}/`;
      await window.os8.preview.setUrl(app.id, fullUrl);
    }
  }
}

/**
 * Attach event listeners to primary panel buttons and URL bar
 */
export function attachPrimaryPanelListeners() {
  // Expand button - toggle between focus and split mode
  replaceEventListener('splitPrimaryExpandBtn', 'click', () => {
    const currentEffective = getEffectiveViewMode();
    setViewMode(currentEffective === 'focus' ? 'split' : 'focus');
  });

  // Close button on primary panel - close the active app
  replaceEventListener('splitPrimaryCloseBtn', 'click', async () => {
    const activeTab = getTabById(getActiveTabId());
    if (activeTab && activeTab.type === 'app') {
      await callbacks.closeTab(activeTab.id);
    }
  });

  // Primary URL bar buttons
  replaceEventListener('splitPrimaryBackBtn', 'click', async () => {
    const activeTab = getTabById(getActiveTabId());
    if (activeTab && activeTab.app) {
      await window.os8.preview.goBack(activeTab.app.id);
    }
  });

  replaceEventListener('splitPrimaryForwardBtn', 'click', async () => {
    const activeTab = getTabById(getActiveTabId());
    if (activeTab && activeTab.app) {
      await window.os8.preview.goForward(activeTab.app.id);
    }
  });

  replaceEventListener('splitPrimaryRefreshBtn', 'click', async () => {
    const activeTab = getTabById(getActiveTabId());
    if (activeTab && activeTab.app) {
      await window.os8.preview.refresh(activeTab.app.id);
    }
  });

  replaceEventListener('splitPrimaryUrlInput', 'keydown', async (e) => {
    if (e.key === 'Enter') {
      const activeTab = getTabById(getActiveTabId());
      if (activeTab && activeTab.app) {
        const urlInput = document.getElementById('splitPrimaryUrlInput');
        await loadPreviewForApp(activeTab.app, urlInput.value.trim());
      }
    }
  });
}

/**
 * Initialize view mode on app load
 */
export function initViewMode() {
  // Apply saved mode on load
  setMode(getCurrentMode());
  attachModeToggleListeners();
}
