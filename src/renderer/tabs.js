/**
 * Tab management for OS8
 */

import { elements } from './elements.js';
import {
  getTabs, setTabs, addTab, removeTabById, getTabById, getAppTabByAppId,
  getActiveTabId, setActiveTabId,
  getCurrentApp, setCurrentApp,
  getCurrentMode,
  getAgentScope, setAgentScope,
  getActiveAgent,
  getDraggedTab, setDraggedTab,
  getTabDropPosition, setTabDropPosition,
  getTerminalInstances, setTerminalInstances,
  getTerminalInstancesForTab,
  getShowHiddenFiles, setShowHiddenFiles,
  getPanelMode, setPanelMode, setJobsView, setSelectedJobId,
  getJobsFilterView, setJobsFilterView,
  getVaultTab,
  getServerPort
} from './state.js';
import { hideAllPreviews, hidePreviewForApp, loadPreview, updatePreviewBounds, destroyPreviewForApp } from './preview.js';
import { switchStorageView, loadStorageView } from './file-tree.js';
import { loadTasks } from './tasks.js';
import { loadJobs } from './jobs.js';
import { createTerminalInstance, createBuildStatusTab, fitAllTerminals, fitTerminalInstance } from './terminal.js';
import { createAgentInstance } from './agent-panel.js';
import { attachModeToggleListeners, renderUserModeView } from './view-mode.js';

// --- Per-tab parking lot -----------------------------------------------------
//
// On tab switch, instead of disposing xterm/agent-panel/build-status DOM and
// rebuilding from saved metadata (which corrupts alt-screen TUIs like
// OpenCode — the rolling 50KB PTY buffer can't be safely replayed), we move
// each tab's instance DOM nodes into a per-tab park element on document.body.
// xterm objects, SSE EventSources, and build polling all stay alive. Switching
// back is a DOM move + fit + refresh — no replay, no recreate.
//
// Park elements are created lazily in createAppTab and removed in
// cleanupTabResources. Lookup by tabId via data-tab-id attribute.

function getOrCreateParkForTab(tabId) {
  let park = document.querySelector(`.terminal-park[data-tab-id="${CSS.escape(tabId)}"]`);
  if (!park) {
    park = document.createElement('div');
    park.className = 'terminal-park';
    park.dataset.tabId = tabId;
    park.hidden = true;
    park.style.display = 'none';
    document.body.appendChild(park);
  }
  return park;
}

function removeParkForTab(tabId) {
  const park = document.querySelector(`.terminal-park[data-tab-id="${CSS.escape(tabId)}"]`);
  if (park) park.remove();
}

function parkTabInstances(tab) {
  if (!tab || tab.type !== 'app') return;
  const park = getOrCreateParkForTab(tab.id);
  const instances = getTerminalInstancesForTab(tab.id);
  // Preserve current DOM order (the order in terminalsContainer) by appending
  // each element to the park in that visible order.
  for (const inst of instances) {
    if (inst.element && inst.element.parentNode) {
      park.appendChild(inst.element);
    }
  }
}

function unparkTabInstances(tab) {
  if (!tab || tab.type !== 'app') return false;
  const park = document.querySelector(`.terminal-park[data-tab-id="${CSS.escape(tab.id)}"]`);
  if (!park || park.children.length === 0) return false;
  // Move children in their existing order from the park back into terminalsContainer.
  while (park.firstChild) {
    elements.terminalsContainer.appendChild(park.firstChild);
  }
  // Reflow xterm to the (possibly new) container size and force a full
  // repaint of the visible buffer — covers the rare case where xterm's DOM
  // renderer dropped pixels during the detached interval.
  const instances = getTerminalInstancesForTab(tab.id);
  fitAllTerminals(instances);
  for (const inst of instances) {
    if (inst.terminal) {
      try { inst.terminal.refresh(0, inst.terminal.rows - 1); } catch (e) {}
    }
    if (typeof inst._onUnpark === 'function') {
      try { inst._onUnpark(); } catch (e) {}
    }
  }
  return true;
}

// Callbacks for functions still in index.html
let callbacks = {
  loadApps: async () => {},
  ensurePreviewForApp: async () => {}
};

/**
 * Register callbacks from index.html for functions not yet extracted to modules
 */
export function setTabCallbacks(cbs) {
  callbacks = { ...callbacks, ...cbs };
}

export function renderTabBar() {
  const {
    tabBar, homeView, workspaceView
  } = elements;

  tabBar.innerHTML = getTabs().map(tab => {
    const isActive = tab.id === getActiveTabId();
    const isHome = tab.type === 'home';
    const isDraggable = !isHome; // Home tab is not draggable

    const isVault = tab.type === 'vault';
    const isAssistant = tab.app?.is_system === 1;
    const tabColor = isVault ? '#3b82f6' : (tab.app?.color || '#6366f1');
    const tabTitle = isAssistant ? 'Agents' : tab.title;
    const tabIcon = isVault ? 'V' : isAssistant ? 'A' : (tab.app?.icon || tab.title.charAt(0).toUpperCase());
    const hasIconImage = !isVault && !isAssistant && tab.app?.icon_image;
    const tabIconHtml = hasIconImage
      ? `<img src="http://localhost:${getServerPort()}/api/icons/${tab.app.id}?v=${encodeURIComponent(tab.app.updated_at || '')}" style="width: 18px; height: 18px; border-radius: 4px; object-fit: cover; display: block;">`
      : `<span style="font-size: ${tabIcon.length > 2 ? 8 : 14}px; font-weight: 600; color: #fff; background: ${tabColor}; width: 18px; height: 18px; border-radius: 4px; display: flex; align-items: center; justify-content: center;">${tabIcon}</span>`;
    return `
      <div class="tab ${isActive ? 'active' : ''}" data-tab-id="${tab.id}" ${isDraggable ? 'draggable="true"' : ''}>
        ${!isHome ? `
          <span class="tab-icon">
            ${tabIconHtml}
          </span>
        ` : ''}
        <span class="tab-title">${tabTitle}</span>
        ${tab.closable ? `
          <span class="tab-close" data-tab-id="${tab.id}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
          </span>
        ` : ''}
      </div>
    `;
  }).join('') + `
    <div class="mode-toggle" id="modeToggle">
      <button class="mode-toggle-btn ${getCurrentMode() === 'user' ? 'active' : ''}" data-mode="user">User</button>
      <button class="mode-toggle-btn ${getCurrentMode() === 'developer' ? 'active' : ''}" data-mode="developer">Dev</button>
    </div>
  `;

  // Re-attach mode toggle listeners
  attachModeToggleListeners();

  // Add click handlers for tabs
  tabBar.querySelectorAll('.tab').forEach(tabEl => {
    tabEl.addEventListener('click', (e) => {
      if (e.target.closest('.tab-close')) return;
      const tabId = tabEl.dataset.tabId;
      switchToTab(tabId);
    });
  });

  // Add click handlers for close buttons
  tabBar.querySelectorAll('.tab-close').forEach(closeBtn => {
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const tabId = closeBtn.dataset.tabId;
      closeTab(tabId);
    });
  });

  // Add drag handlers for reorderable tabs
  setupTabDragDrop();
}

export function setupTabDragDrop() {
  const { tabBar } = elements;

  tabBar.querySelectorAll('.tab[draggable="true"]').forEach(tabEl => {
    tabEl.addEventListener('dragstart', (e) => {
      setDraggedTab(tabEl);
      tabEl.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    tabEl.addEventListener('dragend', () => {
      tabEl.classList.remove('dragging');
      tabBar.querySelectorAll('.drag-over-left, .drag-over-right').forEach(el => {
        el.classList.remove('drag-over-left', 'drag-over-right');
      });
      setDraggedTab(null);
    });
  });

  // All tabs (including home) can be drop targets
  tabBar.querySelectorAll('.tab').forEach(tabEl => {
    tabEl.addEventListener('dragover', (e) => {
      if (!getDraggedTab() || getDraggedTab() === tabEl) return;
      e.preventDefault();

      // Don't allow dropping before home tab
      const targetTabId = tabEl.dataset.tabId;
      if (targetTabId === 'home') {
        // Only allow dropping after home
        tabEl.classList.remove('drag-over-left');
        tabEl.classList.add('drag-over-right');
        setTabDropPosition('after');
        return;
      }

      // Detect left or right half
      const rect = tabEl.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      tabEl.classList.remove('drag-over-left', 'drag-over-right');
      if (e.clientX < midX) {
        tabEl.classList.add('drag-over-left');
        setTabDropPosition('before');
      } else {
        tabEl.classList.add('drag-over-right');
        setTabDropPosition('after');
      }
    });

    tabEl.addEventListener('dragleave', () => {
      tabEl.classList.remove('drag-over-left', 'drag-over-right');
    });

    tabEl.addEventListener('drop', (e) => {
      e.preventDefault();
      tabEl.classList.remove('drag-over-left', 'drag-over-right');

      if (!getDraggedTab() || getDraggedTab() === tabEl) return;

      const draggedTabId = getDraggedTab().dataset.tabId;
      const targetTabId = tabEl.dataset.tabId;

      reorderTab(draggedTabId, targetTabId, getTabDropPosition());
    });
  });
}

export function reorderTab(draggedTabId, targetTabId, position) {
  const currentTabs = [...getTabs()];
  const draggedIndex = currentTabs.findIndex(t => t.id === draggedTabId);
  const targetIndex = currentTabs.findIndex(t => t.id === targetTabId);

  if (draggedIndex === -1 || targetIndex === -1) return;

  // Remove dragged tab
  const [draggedTabObj] = currentTabs.splice(draggedIndex, 1);

  // Calculate new index
  let newIndex = currentTabs.findIndex(t => t.id === targetTabId);
  if (newIndex === -1) {
    // Target was removed (shouldn't happen), append to end
    newIndex = currentTabs.length;
  } else if (position === 'after') {
    newIndex += 1;
  }

  // Ensure we don't insert before home (index 0)
  if (newIndex < 1) newIndex = 1;

  // Insert at new position
  currentTabs.splice(newIndex, 0, draggedTabObj);
  setTabs(currentTabs);

  // Re-render
  renderTabBar();
}

export async function switchToTab(tabId) {
  if (tabId === getActiveTabId()) return;

  const { homeView, workspaceView } = elements;

  const targetTab = getTabById(tabId);
  if (!targetTab) return;

  // Save current tab state before switching, then park its live instance DOM.
  // Parking detaches xterm/agent-panel/build-status elements from the visible
  // container and stows them on document.body — JS objects, PTY data flow,
  // SSE connections, and polling all keep running while parked.
  const currentTab = getTabById(getActiveTabId());
  if (currentTab && currentTab.type === 'app') {
    await saveTabState(currentTab);
    parkTabInstances(currentTab);
    // Hide the current app's preview before switching
    await hidePreviewForApp(currentTab.app.id);
  }

  // Stop watching old tab's tasks file
  await window.os8.tasksFile.unwatch();

  // Update active tab
  setActiveTabId(tabId);
  renderTabBar();

  // Hide all views
  homeView.classList.remove('active');
  workspaceView.classList.remove('active');
  const vaultView = document.getElementById('vaultView');
  if (vaultView) vaultView.classList.remove('active');

  if (targetTab.type === 'home') {
    // Show home view
    homeView.classList.add('active');
    setCurrentApp(null);
    await hideAllPreviews();
    await callbacks.loadApps();
  } else if (targetTab.type === 'vault') {
    // Show vault view
    if (vaultView) vaultView.classList.add('active');
    setCurrentApp(null);
    await hideAllPreviews();
    const { showVaultPanel } = await import('./vault.js');
    showVaultPanel();
  } else if (targetTab.type === 'app') {
    // Restore app workspace
    await restoreTabState(targetTab);
  }
}

export async function createAppTab(app, options = {}) {
  // Check if already open
  const existing = getAppTabByAppId(app.id);
  if (existing) {
    await switchToTab(existing.id);
    return existing;
  }

  // External-app branch (PR 1.19): start the dev server FIRST, register the
  // proxy, then build the tab so its state knows the external URL upfront.
  // Native apps fall through to the regular path.
  let externalUrl = null;
  if (app.app_type === 'external') {
    try {
      // PR 3.13 hotfix: Electron loads index.html via `loadFile()` from a
      // `file://` origin, so a relative `/api/...` fetch resolves to
      // `file:///api/...` and fails with "Failed to fetch". Use the absolute
      // localhost URL like the rest of the renderer (e.g., agent-panel.js).
      const port = getServerPort();
      const res = await fetch(
        `http://localhost:${port}/api/apps/${encodeURIComponent(app.id)}/processes/start`,
        { method: 'POST' }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'unknown' }));
        alert(`Failed to start ${app.name}: ${err.error || res.statusText}`);
        return null;
      }
      const body = await res.json();
      externalUrl = body.url;
    } catch (e) {
      alert(`Failed to start ${app.name}: ${e.message}`);
      return null;
    }
  }

  // Create tab object with fresh state
  const tab = {
    id: `app-${app.id}`,
    type: 'app',
    app: app,
    title: app.name,
    closable: true,
    state: {
      terminalInstances: [],
      terminalIdCounter: 0,
      previewUrl: '',
      externalUrl,
      tasksView: 'open',
      storageView: 'system',
      showHiddenFiles: false,
      skipDefaultTerminal: !!options.skipDefaultTerminal
    }
  };

  addTab(tab);
  renderTabBar();

  // Switch to the new tab (this will call restoreTabState which handles renderUserModeView)
  await switchToTab(tab.id);

  return tab;
}

export async function createVaultTab() {
  const existing = getVaultTab();
  if (existing) {
    await switchToTab(existing.id);
    return existing;
  }

  const tab = {
    id: 'vault',
    type: 'vault',
    title: 'Vault',
    closable: true
  };

  addTab(tab);
  renderTabBar();
  await switchToTab(tab.id);
  return tab;
}

export async function closeTab(tabId) {
  if (tabId === 'home') return;

  const tab = getTabById(tabId);
  if (!tab) return;

  // Persist terminal layout to DB before cleanup destroys it
  if (tab.type === 'app') {
    await saveTabState(tab);
  }

  // Clean up resources
  await cleanupTabResources(tab);

  // Find index before removal (for calculating new active tab)
  const index = getTabs().findIndex(t => t.id === tabId);

  // Remove from array
  removeTabById(tabId);

  // Switch to adjacent tab or home if this was active
  if (getActiveTabId() === tabId) {
    const currentTabs = getTabs();

    // Prefer another app tab over home
    // First try the tab at the same index (which is now the next tab after removal)
    // Then try the previous tab, but skip home if there's another app tab
    let newActiveTab = null;

    // Check if there's a tab at the same index (the "next" tab)
    if (index < currentTabs.length && currentTabs[index].type === 'app') {
      newActiveTab = currentTabs[index];
    }
    // Check if there's a previous app tab
    else if (index > 1 && currentTabs[index - 1].type === 'app') {
      newActiveTab = currentTabs[index - 1];
    }
    // Check if there's ANY other app or vault tab
    else {
      newActiveTab = currentTabs.find(t => t.type === 'app' || t.type === 'vault');
    }
    // Fall back to home
    if (!newActiveTab) {
      newActiveTab = currentTabs[0];
    }

    await switchToTab(newActiveTab.id);
  } else {
    renderTabBar();
  }

  // Update view mode (may switch from split to focus if down to 1 app)
  if (getCurrentMode() === 'user') {
    renderUserModeView();
  }
}

export async function saveTabState(tab) {
  if (!tab || tab.type !== 'app') return;

  const { tasksViewSelect, storageSelect } = elements;

  // Save terminal instances (just metadata, PTY sessions continue running)
  // Live instance objects ARE the source of truth across tab switches now
  // (they get parked in document.body, not destroyed). We no longer snapshot
  // metadata into tab.state.terminalInstances or terminalIdCounter — the
  // global registry survives.
  //
  // The DB layout below remains — it covers cold-start across full app
  // restart, where PTY processes have died and we need a recipe to recreate.

  // Save view states
  tab.state.tasksView = tasksViewSelect.value;
  tab.state.storageView = storageSelect.value;
  tab.state.showHiddenFiles = getShowHiddenFiles();

  // Save panel mode state (for assistant app)
  tab.state.panelMode = getPanelMode();
  tab.state.jobsFilterView = getJobsFilterView();

  // Persist terminal layout + UI settings to database (all apps).
  // Read directly from live instances since we no longer snapshot metadata.
  const terminalLayout = getTerminalInstancesForTab(tab.id)
    .filter(inst => !inst.isBuildStatus)
    .map(inst => {
      if (inst.isAgentPanel) {
        return { type: 'agent', agentId: inst.agentId };
      }
      return { type: 'terminal', activeType: inst.activeType };
    });

  const uiSettings = {
    terminalLayout,
    ...(tab.app.app_type === 'system' ? {
      panelMode: tab.state.panelMode,
      storageView: tab.state.storageView,
      jobsFilterView: tab.state.jobsFilterView,
    } : {})
  };
  window.os8.settings.setAppUi(tab.app.id, uiSettings).catch(err => {
    console.warn('Failed to save app UI settings:', err);
  });

  // Save preview URL
  const currentUrl = await window.os8.preview.getUrl(tab.app.id);
  tab.state.previewUrl = currentUrl || '';
}

export async function restoreTabState(tab) {
  if (!tab || tab.type !== 'app') return;

  const {
    homeView, workspaceView, workspaceTitle,
    previewUrlPrefix, previewUrlInput,
    tasksViewSelect, storageSelect, toggleHiddenFilesBtn,
    terminalsContainer
  } = elements;

  setCurrentApp(tab.app);
  workspaceTitle.textContent = tab.app.name;

  // Check if this is an agent app (no terminal needed)
  const isAssistant = tab.app.app_type === 'system';

  // Reset agent scope: standard apps use null (app-level),
  // system apps restore to the active agent
  if (isAssistant) {
    const activeAgent = getActiveAgent();
    if (activeAgent) {
      setAgentScope(activeAgent.id);
    }
  } else {
    setAgentScope(null);
  }
  const terminalPanel = document.getElementById('terminalPanel');
  const divider1 = document.querySelector('[data-divider="1"]');
  const workspacePanels = document.querySelector('.workspace-panels');

  if (isAssistant) {
    terminalPanel.style.display = 'none';
    divider1.style.display = 'none';
    workspacePanels.classList.add('assistant-layout');
  } else {
    terminalPanel.style.display = '';
    divider1.style.display = '';
    workspacePanels.classList.remove('assistant-layout');
  }

  // Show/hide panel mode selector (only for assistant app)
  const panelModeSelect = document.getElementById('panelModeSelect');
  const todosContent = document.getElementById('todosContent');
  const jobsContentWrapper = document.getElementById('jobsContentWrapper');

  if (isAssistant) {
    panelModeSelect.style.display = '';

    // Load persisted UI settings from database (if not already in tab state)
    if (!tab.state._uiLoaded) {
      try {
        const savedUi = await window.os8.settings.getAppUi(tab.app.id);
        if (savedUi) {
          if (savedUi.panelMode) tab.state.panelMode = savedUi.panelMode;
          if (savedUi.storageView) tab.state.storageView = savedUi.storageView;
          if (savedUi.jobsFilterView) tab.state.jobsFilterView = savedUi.jobsFilterView;
        }
        tab.state._uiLoaded = true;
      } catch (err) {
        console.warn('Failed to load assistant UI settings:', err);
      }
    }

    // Restore panel mode state for this tab
    const panelMode = tab.state.panelMode || 'jobs';
    setPanelMode(panelMode);
    panelModeSelect.value = panelMode;
    setJobsView('list');
    setSelectedJobId(null);

    // Restore jobs filter view
    const jobsFilterView = tab.state.jobsFilterView || 'active';
    setJobsFilterView(jobsFilterView);
    const jobsFilterSelect = elements.jobsFilterSelect;
    if (jobsFilterSelect) {
      jobsFilterSelect.value = jobsFilterView;
    }

    if (panelMode === 'todos') {
      todosContent.style.display = '';
      jobsContentWrapper.style.display = 'none';
    } else {
      todosContent.style.display = 'none';
      jobsContentWrapper.style.display = '';
    }
  } else {
    panelModeSelect.style.display = 'none';
    setPanelMode('todos');
    todosContent.style.display = '';
    jobsContentWrapper.style.display = 'none';
  }

  // Regenerate CLAUDE.md (ensures latest global instructions)
  await window.os8.claude.generateMd(tab.app.id);

  // Set URL prefix
  previewUrlPrefix.textContent = tab.app.slug + '/';
  previewUrlInput.value = '';

  // Show workspace view
  homeView.classList.remove('active');
  workspaceView.classList.add('active');

  // Render user mode view if in user mode
  if (getCurrentMode() === 'user') {
    renderUserModeView();
  }

  // Restore view states
  tasksViewSelect.value = tab.state.tasksView || 'open';
  storageSelect.value = tab.state.storageView || 'system';
  setShowHiddenFiles(tab.state.showHiddenFiles || false);
  toggleHiddenFilesBtn.classList.toggle('active', getShowHiddenFiles());

  // Switch storage view
  switchStorageView(storageSelect.value);

  // Terminal handling - skip for assistant app
  if (!isAssistant) {
    // Hot path: this tab has live instances parked from an earlier visit.
    // Move them back into terminalsContainer; xterm/SSE/polling never died.
    const unparked = unparkTabInstances(tab);
    if (!unparked && !tab.state.skipDefaultTerminal) {
      // Cold path: first time the tab is being opened in this session.
      // Try to rehydrate from the DB-persisted terminal layout, otherwise
      // fall back to a single default Claude terminal.
      let restored = false;
      try {
        const savedUi = await window.os8.settings.getAppUi(tab.app.id);
        if (savedUi?.terminalLayout?.length > 0) {
          for (const entry of savedUi.terminalLayout) {
            if (entry.type === 'agent') {
              await createAgentInstance(tab.app.id, { agentId: entry.agentId });
            } else {
              await createTerminalInstance(entry.activeType || 'claude');
            }
          }
          restored = true;
        }
      } catch (err) {
        console.warn('Failed to load terminal layout:', err);
      }
      if (!restored) {
        await createTerminalInstance('claude');
      }
    }
    // skipDefaultTerminal=true means the caller (e.g. createAppTab during a
    // build flow) will create the agent panel itself — nothing to do here.
  }

  // Ensure preview exists and position it
  setTimeout(async () => {
    await callbacks.ensurePreviewForApp(tab.app);
    if (tab.state.previewUrl) {
      await window.os8.preview.setUrl(tab.app.id, tab.state.previewUrl);
    } else {
      await loadPreview();
    }
    await updatePreviewBounds();
  }, 50);

  // Load storage views
  await loadStorageView();

  // Load tasks or jobs based on panel mode, and start watching for changes
  const scope = getAgentScope();
  const effectiveAgentId = (scope && scope !== 'system') ? scope : undefined;
  if (isAssistant && getPanelMode() === 'jobs') {
    await loadJobs();
    await window.os8.jobsFile.watch(tab.app.id, effectiveAgentId);
  } else {
    await loadTasks();
    await window.os8.tasksFile.watch(tab.app.id, effectiveAgentId);
  }
}

export async function cleanupTabResources(tab) {
  if (!tab) return;

  if (tab.type === 'vault') {
    const { cleanupVault } = await import('./vault.js');
    cleanupVault();
    return;
  }

  if (tab.type !== 'app') return;

  // External-app branch (PR 1.19): stop the dev server and unregister the
  // proxy when the user closes the tab. Native apps don't need this — they
  // run inside OS8's server, not as a separate process.
  if (tab.app?.id && tab.app?.app_type === 'external') {
    try {
      // PR 3.13 hotfix: same absolute-URL fix as the start path above.
      const port = getServerPort();
      await fetch(
        `http://localhost:${port}/api/apps/${encodeURIComponent(tab.app.id)}/processes/stop`,
        { method: 'POST' }
      );
    } catch (_) { /* best-effort — APR.stopAll() will catch leaks on quit */ }
  }

  // Destroy the BrowserView for this app
  if (tab.app?.id) {
    await destroyPreviewForApp(tab.app.id);
  }

  // Dispose every live instance owned by this tab. Single per-tab pass —
  // works whether the instance's DOM is currently in terminalsContainer
  // (active tab) or parked on document.body (inactive tab).
  const owned = getTerminalInstancesForTab(tab.id);
  for (const instance of owned) {
    if (instance.sessionId) {
      await window.os8.terminal.kill(instance.sessionId);
    }
    if (instance.isBuildStatus) {
      clearInterval(instance._pollInterval);
      clearInterval(instance._timerInterval);
    }
    if (instance.isAgentPanel && instance._cleanup) {
      instance._cleanup();
    }
    if (instance.terminal) {
      instance.terminal.dispose();
    }
    if (instance.element) {
      instance.element.remove();
    }
  }
  // Drop them from the global registry.
  const remaining = getTerminalInstances().filter(i => i.tabId !== tab.id);
  setTerminalInstances(remaining);

  // Remove the tab's parking element from document.body.
  removeParkForTab(tab.id);
}
