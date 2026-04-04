// ===== Main Application Bootstrap =====
// This module initializes the OS8 renderer and wires up all event handlers

// ===== Imports =====
import { elements, initElements } from './elements.js';
import { replaceEventListener, attachModalBehavior, attachFileTreeHandlers } from './helpers.js';
import { startClock } from './clock.js';
import {
  getCurrentBackground, getCurrentScrim, applyBackground, applyScrim,
  renderBackgroundPicker, loadBackgroundSetting, saveBackgroundSetting
} from './backgrounds.js';
import {
  activePreviewApps, ensurePreviewForApp, loadPreviewForApp,
  hidePreviewForApp, destroyPreviewForApp, hideAllPreviews,
  updatePreviewBounds, updateUserModePreviewBounds, loadPreview
} from './preview.js';
import {
  terminalTheme, fitTerminalInstance, fitAllTerminals, fitTerminal,
  initPtyHandlers, createTerminalInstance, reconnectTerminalInstance, closeTerminalInstance,
  createBuildStatusTab
} from './terminal.js';
import { createAgentInstance } from './agent-panel.js';
import { initVault, openVaultTab } from './vault.js';
import {
  getFileIcon, getFileIconClass, renderFileTreeItem, filterHiddenFiles,
  HIDDEN_FILES, loadFileTree, viewFile, switchStorageView, loadStorageView, loadBlobTree,
  refreshViewedFile, downloadViewedFile
} from './file-tree.js';
import {
  escapeHtml, renderTaskItem, showContextMenu, hideContextMenu,
  loadTasks, renderTasks, showRenameTaskModal, showRenameProjectModal, showTaskModal
} from './tasks.js';
import {
  loadJobs, initJobs, showCreateJobModal
} from './jobs.js';
import {
  setTabCallbacks, renderTabBar, setupTabDragDrop, reorderTab,
  switchToTab, createAppTab, closeTab, saveTabState, restoreTabState, cleanupTabResources
} from './tabs.js';
import {
  setViewModeCallbacks, initViewMode, setMode, attachModeToggleListeners,
  getEffectiveViewMode, setViewMode, updateViewModeClass, renderUserModeView,
  attachSplitPanelListeners, loadSecondaryPreviews, attachPrimaryPanelListeners
} from './view-mode.js';
import {
  setAppsCallbacks, renderApps, saveAppOrder, loadApps, updateAssistantButton,
  createApp, showHome, openWorkspace
} from './apps.js';
import {
  switchSettingsSection,
  loadOAuthPortSetting, updateOAuthPortWarning, saveOAuthPort,
  loadTunnelUrlSetting, copyTunnelUrl, initSettingsListeners,
  loadApiKeys, loadVoiceSettings
} from './settings.js';
import {
  loadProviders, loadConnections, renderConnectionsList,
  openConnectionWizard, closeConnectionWizard, renderWizardStep,
  updateWizardButtons, setupWizardNavigation
} from './connections.js';
import { initCoreServices } from './init.js';
import { checkOnboarding } from './onboarding.js';
import { loadAccountSection, initAccountListeners } from './account.js';
import {
  getCurrentMode, setCurrentMode as stateSetCurrentMode,
  getViewMode, setViewMode as stateSetViewMode,
  getPreviewExpanded, setPreviewExpanded,
  getCurrentSettingsSection, setCurrentSettingsSection,
  getArchivedApps, setArchivedApps,
  getDraggedAppIcon, setDraggedAppIcon,
  getDraggedAppIndex, setDraggedAppIndex,
  getSelectedAppColor, setSelectedAppColor,
  getSelectedFontColor, setSelectedFontColor,
  getEditingAppId, setEditingAppId,
  getEditSelectedColor, setEditSelectedColor,
  getEditSelectedFontColor, setEditSelectedFontColor,
  getDraggedTask, setDraggedTask,
  getDraggedProject, setDraggedProject,
  getDropPosition, setDropPosition,
  getApps, setApps, addApp, getAppById,
  getCurrentApp, setCurrentApp,
  getTabs, getTabById, getAppTabByAppId, getAppTabs,
  getActiveTabId, setActiveTabId,
  getTabsInitialized, setTabsInitialized,
  getTerminalInstances, setTerminalInstances, addTerminalInstance,
  removeTerminalInstance, getTerminalInstanceBySessionId,
  getTerminalIdCounter, setTerminalIdCounter, incrementTerminalIdCounter,
  getPtyHandlersInitialized, setPtyHandlersInitialized,
  getShowHiddenFiles, setShowHiddenFiles,
  getAssistantApp, setAssistantApp,
  getActiveAgent,
  getAgentScope, setAgentScope,
  getIsDragging, setIsDragging, getCurrentDivider, setCurrentDivider,
  getStartX, setStartX, getStartY, setStartY,
  getStartWidths, setStartWidths, getStartHeights, setStartHeights,
  getOauthPortInfo, setOauthPortInfo,
  getWizardState,
  getPanelMode, setPanelMode, setJobsView, setSelectedJobId,
  getJobsFilterView,
  getRightPanelCollapsed, setRightPanelCollapsed
} from './state.js';

// Helper to save assistant app UI settings
async function saveAssistantUiSettings() {
  const app = getCurrentApp();
  if (!app || app.app_type !== 'system') return;

  const storageSelect = document.getElementById('storageSelect');
  const panelModeSelect = document.getElementById('panelModeSelect');

  const uiSettings = {
    panelMode: getPanelMode(),
    storageView: storageSelect?.value || 'system',
    jobsFilterView: getJobsFilterView()
  };

  try {
    await window.os8.settings.setAppUi(app.id, uiSettings);
  } catch (err) {
    console.warn('Failed to save assistant UI settings:', err);
  }
}

// ===== Color & Icon Picker Constants =====
const appColors = [
  '#991b1b', '#ec4899', '#ef4444', '#f97316', '#eab308', '#84cc16', '#22c55e', '#14b8a6',
  '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#ffffff', '#94a3b8', '#64748b', '#18181b'
];

// ===== Helper Functions =====
function getDefaultColor() {
  return appColors[Math.floor(Math.random() * appColors.length)];
}

function getDefaultFontColor(bgColor) {
  return bgColor === '#ffffff' ? '#18181b' : '#ffffff';
}

function selectFontColor(color, newAppIcon) {
  setSelectedFontColor(color);
  const fontColorPicker = document.getElementById('fontColorPicker');
  fontColorPicker.querySelectorAll('.font-color-option').forEach(opt => {
    opt.classList.toggle('selected', opt.dataset.color === color);
  });
  newAppIcon.style.color = color;
}

function selectColor(color, newAppIcon) {
  setSelectedAppColor(color);
  const colorPicker = document.getElementById('newAppColorPicker');
  colorPicker.querySelectorAll('.color-option').forEach(opt => {
    opt.classList.toggle('selected', opt.dataset.color === color);
  });
  newAppIcon.style.background = color;
  selectFontColor(getDefaultFontColor(color), newAppIcon);
}

function openEditAppModal(app) {
  const editAppModal = document.getElementById('editAppModal');
  const editAppName = document.getElementById('editAppName');
  const editAppIcon = document.getElementById('editAppIcon');

  setEditingAppId(app.id);
  editAppName.value = app.name;
  editAppIcon.value = app.icon || app.name.charAt(0).toUpperCase();
  setEditSelectedColor(app.color || '#6366f1');
  setEditSelectedFontColor(app.text_color || '#ffffff');

  const colorPicker = document.getElementById('editAppColorPicker');
  colorPicker.querySelectorAll('.color-option').forEach(opt => {
    opt.classList.toggle('selected', opt.dataset.color === getEditSelectedColor());
  });

  const fontColorPicker = document.getElementById('editFontColorPicker');
  fontColorPicker.querySelectorAll('.font-color-option').forEach(opt => {
    opt.classList.toggle('selected', opt.dataset.color === getEditSelectedFontColor());
  });

  editAppIcon.style.background = getEditSelectedColor();
  editAppIcon.style.color = getEditSelectedFontColor();

  editAppModal.classList.add('active');
  editAppName.focus();
  editAppName.select();
}

async function loadArchivedApps() {
  setArchivedApps(await window.os8.apps.listArchived());
  return getArchivedApps();
}

function renderArchivedApps() {
  const archivedAppsList = document.getElementById('archivedAppsList');

  if (getArchivedApps().length === 0) {
    archivedAppsList.innerHTML = '<div class="archived-empty">No archived apps</div>';
    return;
  }

  archivedAppsList.innerHTML = getArchivedApps().map(app => {
    const color = app.color || '#6366f1';
    const textColor = app.text_color || '#ffffff';
    const icon = app.icon || app.name.charAt(0).toUpperCase();
    const archivedDate = app.archived_at ? new Date(app.archived_at).toLocaleDateString() : '';
    return `
      <div class="archived-app-item" data-id="${app.id}">
        <div class="archived-app-icon" style="background: ${color}; color: ${textColor};">${icon}</div>
        <div class="archived-app-info">
          <div class="archived-app-name">${app.name}</div>
          <div class="archived-app-date">Archived ${archivedDate}</div>
        </div>
      </div>
    `;
  }).join('');

  // Add right-click context menu to archived apps
  archivedAppsList.querySelectorAll('.archived-app-item').forEach(item => {
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const appId = item.dataset.id;
      const app = getArchivedApps().find(a => a.id === appId);
      if (!app) return;

      showContextMenu(e.clientX, e.clientY, [
        {
          label: 'Restore',
          icon: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
          action: async () => {
            await window.os8.apps.restore(app.id);
            await loadArchivedApps();
            renderArchivedApps();
            await loadApps();
          }
        },
        { divider: true },
        {
          label: 'Delete Permanently',
          icon: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/>',
          danger: true,
          action: async () => {
            if (confirm(`Permanently delete "${app.name}"? This cannot be undone.`)) {
              await window.os8.apps.delete(app.id);
              await loadArchivedApps();
              renderArchivedApps();
            }
          }
        }
      ]);
    });
  });
}

// ===== Main Initialization =====
async function init() {
  // Start system clock
  startClock();

  // Initialize view mode (applies saved mode and attaches listeners)
  initViewMode();

  // Register view-mode callbacks for tab functions (avoids circular imports)
  setViewModeCallbacks({
    switchToTab,
    closeTab
  });

  // Register tab callbacks for functions not yet extracted to modules
  setTabCallbacks({
    loadApps,
    ensurePreviewForApp: async (app) => { await ensurePreviewForApp(app); }
  });

  // Register apps callbacks
  setAppsCallbacks({
    createAppTab,
    openEditAppModal
  });

  // Mark tabs as initialized
  setTabsInitialized(true);

  // Apply initial view mode class
  document.body.classList.add(`view-${getEffectiveViewMode()}`);

  // Initialize DOM element references
  initElements();
  const {
    tabBar, homeView, workspaceView, appsGrid,
    newAppBtn, newAppModal, newAppName, cancelNewApp, createNewApp,
    closeAppBtn, workspaceTitle,
    previewArea, previewUrlInput, previewUrlPrefix, previewGoBtn,
    previewBackBtn, previewForwardBtn, previewRefreshBtn,
    settingsBtn, settingsModal,
    fileTree, blobTree, storageSelect, refreshStorageBtn, toggleHiddenFilesBtn,
    systemFilesView, dataStorageView, blobStorageView,
    fileViewerModal, fileViewerName, fileViewerCode, closeFileViewer, refreshFileViewer, downloadFileViewer,
    terminalsContainer, tasksList, tasksViewSelect, addTaskBtn, addProjectBtn, refreshTasksBtn
  } = elements;

  // Initialize settings event listeners
  initSettingsListeners();

  // Initialize account listeners (sign-in event from os8.ai)
  initAccountListeners();

  // Initialize capability filter tabs
  import('./capabilities.js').then(m => m.initCapabilityFilters());

  // ===== Call State Listener (phone call active banner) =====
  const callActiveBanner = document.getElementById('callActiveBanner');

  // Check initial state
  window.os8.call.isActive().then((isActive) => {
    if (isActive) {
      callActiveBanner.style.display = 'flex';
    }
  });

  // Listen for call state changes
  window.os8.call.onActive(() => {
    console.log('Phone call started - disabling desktop voice');
    callActiveBanner.style.display = 'flex';
  });

  window.os8.call.onEnded(() => {
    console.log('Phone call ended - re-enabling desktop voice');
    callActiveBanner.style.display = 'none';
  });

  // ===== Task Button Event Listeners =====
  refreshTasksBtn.addEventListener('click', () => loadTasks());
  addTaskBtn.addEventListener('click', () => showTaskModal('task'));
  addProjectBtn.addEventListener('click', () => showTaskModal('project'));
  tasksViewSelect.addEventListener('change', () => loadTasks());

  // ===== Jobs/Panel Mode Initialization =====
  initJobs();

  // Panel mode switcher (only for agent app)
  const panelModeSelect = document.getElementById('panelModeSelect');
  const todosContent = document.getElementById('todosContent');
  const jobsContentWrapper = document.getElementById('jobsContentWrapper');

  panelModeSelect.addEventListener('change', () => {
    const mode = panelModeSelect.value;
    setPanelMode(mode);
    setJobsView('list');
    setSelectedJobId(null);

    if (mode === 'todos') {
      todosContent.style.display = '';
      jobsContentWrapper.style.display = 'none';
      loadTasks();
    } else {
      todosContent.style.display = 'none';
      jobsContentWrapper.style.display = '';
      loadJobs();
    }

    // Persist setting for assistant app
    saveAssistantUiSettings();
  });

  // ===== Color & Icon Picker =====
  const newAppIcon = document.getElementById('newAppIcon');
  const newAppStep1 = document.getElementById('newAppStep1');
  const newAppStep2 = document.getElementById('newAppStep2');
  const nextNewApp = document.getElementById('nextNewApp');
  const backNewApp = document.getElementById('backNewApp');

  // ===== New App Modal =====
  newAppBtn.addEventListener('click', () => {
    newAppModal.classList.add('active');
    newAppName.value = '';
    newAppIcon.value = '';
    newAppStep1.style.display = 'block';
    newAppStep2.style.display = 'none';
    newAppName.focus();
    nextNewApp.disabled = true;
  });

  // Vault button
  document.getElementById('vaultBtn')?.addEventListener('click', () => openVaultTab());

  // Vault init
  initVault();

  // Agent button - opens the default agent
  document.getElementById('assistantBtn').addEventListener('click', () => {
    const activeAgent = getActiveAgent();
    if (activeAgent) {
      window.os8.apps.getSystem().then(systemApps => {
        const app = systemApps.find(sa => sa.id === activeAgent.id);
        if (app) createAppTab(app);
        else if (getAssistantApp()) createAppTab(getAssistantApp());
      });
    } else if (getAssistantApp()) {
      createAppTab(getAssistantApp());
    }
  });

  newAppName.addEventListener('input', () => {
    nextNewApp.disabled = !newAppName.value.trim();
  });

  newAppName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && newAppName.value.trim()) {
      nextNewApp.click();
    }
    if (e.key === 'Escape') {
      cancelNewApp.click();
    }
  });

  nextNewApp.addEventListener('click', () => {
    if (!newAppName.value.trim()) return;
    newAppIcon.value = newAppName.value.trim().charAt(0).toUpperCase();
    selectColor(getDefaultColor(), newAppIcon);
    newAppStep1.style.display = 'none';
    newAppStep2.style.display = 'block';
  });

  backNewApp.addEventListener('click', () => {
    newAppStep1.style.display = 'block';
    newAppStep2.style.display = 'none';
    newAppName.focus();
  });

  // Color picker click handler
  document.getElementById('newAppColorPicker').addEventListener('click', (e) => {
    const colorOption = e.target.closest('.color-option');
    if (colorOption) {
      selectColor(colorOption.dataset.color, newAppIcon);
    }
  });

  // Font color picker click handler
  document.getElementById('fontColorPicker').addEventListener('click', (e) => {
    const fontColorOption = e.target.closest('.font-color-option');
    if (fontColorOption) {
      selectFontColor(fontColorOption.dataset.color, newAppIcon);
    }
  });

  cancelNewApp.addEventListener('click', () => {
    newAppModal.classList.remove('active');
  });

  // Keyboard support for step 2
  newAppIcon.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      createNewApp.click();
    }
    if (e.key === 'Escape') {
      backNewApp.click();
    }
  });

  createNewApp.addEventListener('click', async () => {
    const name = newAppName.value.trim();
    if (name) {
      newAppModal.classList.remove('active');
      const icon = newAppIcon.value.trim() || null;
      try {
        const app = await createApp(name, getSelectedAppColor(), icon, getSelectedFontColor());
        console.log('App created:', app);
        await createAppTab(app);
      } catch (err) {
        console.error('Failed to create app:', err);
        alert('Failed to create app: ' + err.message);
      }
    }
  });

  // ===== Edit App Modal =====
  const editAppModal = document.getElementById('editAppModal');
  const editAppName = document.getElementById('editAppName');
  const editAppIcon = document.getElementById('editAppIcon');
  const cancelEditApp = document.getElementById('cancelEditApp');
  const saveEditApp = document.getElementById('saveEditApp');

  // Edit color picker click handler
  document.getElementById('editAppColorPicker').addEventListener('click', (e) => {
    const colorOption = e.target.closest('.color-option');
    if (colorOption) {
      setEditSelectedColor(colorOption.dataset.color);
      const colorPicker = document.getElementById('editAppColorPicker');
      colorPicker.querySelectorAll('.color-option').forEach(opt => {
        opt.classList.toggle('selected', opt.dataset.color === getEditSelectedColor());
      });
      editAppIcon.style.background = getEditSelectedColor();
      if (getEditSelectedColor() === '#ffffff') {
        setEditSelectedFontColor('#18181b');
      } else {
        setEditSelectedFontColor('#ffffff');
      }
      const fontColorPicker = document.getElementById('editFontColorPicker');
      fontColorPicker.querySelectorAll('.font-color-option').forEach(opt => {
        opt.classList.toggle('selected', opt.dataset.color === getEditSelectedFontColor());
      });
      editAppIcon.style.color = getEditSelectedFontColor();
    }
  });

  // Edit font color picker click handler
  document.getElementById('editFontColorPicker').addEventListener('click', (e) => {
    const fontColorOption = e.target.closest('.font-color-option');
    if (fontColorOption) {
      setEditSelectedFontColor(fontColorOption.dataset.color);
      const fontColorPicker = document.getElementById('editFontColorPicker');
      fontColorPicker.querySelectorAll('.font-color-option').forEach(opt => {
        opt.classList.toggle('selected', opt.dataset.color === getEditSelectedFontColor());
      });
      editAppIcon.style.color = getEditSelectedFontColor();
    }
  });

  cancelEditApp.addEventListener('click', () => {
    editAppModal.classList.remove('active');
    setEditingAppId(null);
  });

  editAppName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && editAppName.value.trim()) {
      saveEditApp.click();
    }
    if (e.key === 'Escape') {
      cancelEditApp.click();
    }
  });

  saveEditApp.addEventListener('click', async () => {
    const name = editAppName.value.trim();
    if (name && getEditingAppId()) {
      const icon = editAppIcon.value.trim() || null;
      const updatedApp = await window.os8.apps.update(getEditingAppId(), {
        name,
        icon,
        color: getEditSelectedColor(),
        textColor: getEditSelectedFontColor()
      });
      const currentApps = [...getApps()];
      const appIndex = currentApps.findIndex(a => a.id === getEditingAppId());
      if (appIndex !== -1) {
        currentApps[appIndex] = updatedApp;
        setApps(currentApps);
      }
      const openTab = getAppTabByAppId(getEditingAppId());
      if (openTab) {
        openTab.app = updatedApp;
        openTab.title = updatedApp.name;
        renderTabBar();
      }
      renderApps();
      editAppModal.classList.remove('active');
      setEditingAppId(null);
    }
  });

  // ===== Close Button =====

  closeAppBtn.addEventListener('click', () => {
    if (getActiveTabId() !== 'home') {
      closeTab(getActiveTabId());
    }
  });

  // ===== Preview Controls =====
  previewGoBtn.addEventListener('click', loadPreview);
  previewUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadPreview();
  });

  previewBackBtn.addEventListener('click', () => {
    if (getCurrentApp()) window.os8.preview.goBack(getCurrentApp().id);
  });
  previewForwardBtn.addEventListener('click', () => {
    if (getCurrentApp()) window.os8.preview.goForward(getCurrentApp().id);
  });
  previewRefreshBtn.addEventListener('click', () => {
    if (getCurrentApp()) window.os8.preview.refresh(getCurrentApp().id);
  });

  // Preview expand/collapse
  const expandPreviewBtn = document.getElementById('expandPreviewBtn');

  expandPreviewBtn.addEventListener('click', () => {
    setPreviewExpanded(!getPreviewExpanded());
    const workspacePanels = document.querySelector('.workspace-panels');
    const previewPanel = document.getElementById('previewPanel');

    if (getPreviewExpanded()) {
      workspacePanels.classList.add('preview-expanded');
      previewPanel.classList.add('expanded');
      expandPreviewBtn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M4 14h6v6m10-10h-6V4m0 6l7-7M3 21l7-7"/>
        </svg>
      `;
      expandPreviewBtn.title = 'Collapse preview';
    } else {
      workspacePanels.classList.remove('preview-expanded');
      previewPanel.classList.remove('expanded');
      expandPreviewBtn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>
        </svg>
      `;
      expandPreviewBtn.title = 'Expand preview';
    }

    setTimeout(() => {
      updatePreviewBounds();
    }, 50);
  });

  // ===== Right Panel Toggle =====
  const rightPanelToggle = document.getElementById('rightPanelToggle');
  const workspacePanelsEl = document.querySelector('.workspace-panels');

  function applyRightPanelCollapsed(collapsed) {
    // Clear inline styles set by drag-resize so CSS class rules take effect
    const preview = document.getElementById('previewPanel');
    const right = document.getElementById('rightPanel');
    if (preview) { preview.style.flex = ''; preview.style.width = ''; }
    if (right) { right.style.flex = ''; right.style.width = ''; }

    if (collapsed) {
      workspacePanelsEl.classList.add('right-collapsed');
      rightPanelToggle.innerHTML = `
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M15 18l-6-6 6-6"/>
        </svg>
      `;
      rightPanelToggle.title = 'Show panel';
    } else {
      workspacePanelsEl.classList.remove('right-collapsed');
      rightPanelToggle.innerHTML = `
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M9 18l6-6-6-6"/>
        </svg>
      `;
      rightPanelToggle.title = 'Hide panel';
    }
    setTimeout(() => {
      updatePreviewBounds();
      fitTerminal();
    }, 50);
  }

  // Apply initial state
  applyRightPanelCollapsed(getRightPanelCollapsed());

  rightPanelToggle.addEventListener('click', () => {
    setRightPanelCollapsed(false);
    applyRightPanelCollapsed(false);
  });

  document.getElementById('collapseRightPanelBtn').addEventListener('click', () => {
    setRightPanelCollapsed(true);
    applyRightPanelCollapsed(true);
  });

  // ===== File Viewer =====
  closeFileViewer.addEventListener('click', () => {
    fileViewerModal.classList.remove('active');
    updatePreviewBounds();
  });

  refreshFileViewer.addEventListener('click', () => {
    refreshViewedFile();
  });

  downloadFileViewer.addEventListener('click', () => {
    downloadViewedFile();
  });

  fileViewerModal.addEventListener('click', (e) => {
    if (e.target === fileViewerModal) {
      fileViewerModal.classList.remove('active');
      updatePreviewBounds();
    }
  });

  // ===== Storage Controls =====
  storageSelect.addEventListener('change', () => {
    switchStorageView(storageSelect.value);
    loadStorageView();

    // Persist setting for assistant app
    saveAssistantUiSettings();
  });

  refreshStorageBtn.addEventListener('click', loadStorageView);

  toggleHiddenFilesBtn.addEventListener('click', () => {
    setShowHiddenFiles(!getShowHiddenFiles());
    toggleHiddenFilesBtn.classList.toggle('active', getShowHiddenFiles());
    toggleHiddenFilesBtn.title = getShowHiddenFiles() ? 'Hide hidden files' : 'Show hidden files';
    loadStorageView();
  });

  // ===== Preview URL Changed Handler =====
  window.os8.preview.onUrlChanged(async (appId, url) => {
    if (getCurrentApp() && getCurrentApp().id === appId && url) {
      // URLs use appId internally (e.g., /1769977353030-t78455kh2/photo-to-avatar)
      const appIdPath = '/' + getCurrentApp().id + '/';
      const idx = url.indexOf(appIdPath);
      if (idx !== -1) {
        previewUrlInput.value = url.substring(idx + appIdPath.length);
      }

      // Parse agent scope from URL path (/{appId}/{displaySlug} or /{appId}/agents/{displaySlug})
      try {
        const urlObj = new URL(url);
        const pathParts = urlObj.pathname.split('/').filter(Boolean);
        // pathParts[0] = appId, pathParts[1] = agent display slug (e.g., 'lisa')
        // Handle optional 'agents/' prefix: /{appId}/agents/{slug} → use pathParts[2]
        const displaySlug = (pathParts[1] === 'agents' && pathParts[2]) ? pathParts[2] : pathParts[1];
        if (displaySlug) {
          try {
            const agentsList = await window.os8.agents.list();
            // Match display slug to DB slug (agent-{displaySlug})
            const agent = agentsList.find(a => a.slug === `agent-${displaySlug}`)
              || agentsList.find(a => a.id === displaySlug || a.slug === displaySlug);
            if (agent) {
              const { setActiveAgentId, setAgents } = await import('./state.js');
              // Refresh shell's agent list to include newly created agents
              setAgents(agentsList);
              // Update both activeAgentId (which also sets agentScope) and reload storage
              if (agent.id !== getAgentScope()) {
                setActiveAgentId(agent.id);
                loadTasks();
                loadJobs();
                loadStorageView();
              }
            }
          } catch (e) {
            // agents list fetch failed, skip
          }
        }
      } catch (e) {
        // URL parsing failed, skip
      }
    }
    const panelUrlInput = document.querySelector(`.split-panel[data-app-id="${appId}"] .split-url-input`);
    if (panelUrlInput && url) {
      const tab = getAppTabByAppId(appId);
      if (tab) {
        // URLs use appId internally
        const appIdPath = '/' + tab.app.id + '/';
        const idx = url.indexOf(appIdPath);
        if (idx !== -1) {
          panelUrlInput.value = url.substring(idx + appIdPath.length);
        }
      }
    }
  });

  // ===== Window Resize Handler =====
  let resizeTimeout;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      updatePreviewBounds();
      if (getCurrentApp()) {
        fitTerminal();
      }
    }, 50);
  });

  // Re-apply preview bounds when zoom level changes
  window.os8.zoom.onChanged(() => {
    updatePreviewBounds();
    if (getCurrentApp()) {
      fitTerminal();
    }
  });

  // Close modal on overlay click
  newAppModal.addEventListener('click', (e) => {
    if (e.target === newAppModal) {
      newAppModal.classList.remove('active');
    }
  });

  // ===== Settings =====
  const scrimSlider = document.getElementById('scrimSlider');
  const scrimValue = document.getElementById('scrimValue');
  const closeSettings = document.getElementById('closeSettings');

  settingsBtn.addEventListener('click', async () => {
    renderBackgroundPicker(getCurrentBackground());
    scrimSlider.value = getCurrentScrim();
    scrimValue.textContent = getCurrentScrim() + '%';
    await loadConnections();
    await loadOAuthPortSetting();
    await loadTunnelUrlSetting();
    await loadVoiceSettings();
    await loadApiKeys();
    await switchSettingsSection('account');
    settingsModal.classList.add('active');
  });

  scrimSlider.addEventListener('input', () => {
    const value = parseInt(scrimSlider.value, 10);
    scrimValue.textContent = value + '%';
    applyScrim(value);
    saveBackgroundSetting();
  });

  closeSettings.addEventListener('click', async () => {
    await saveBackgroundSetting();
    settingsModal.classList.remove('active');
  });

  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) {
      saveBackgroundSetting();
      settingsModal.classList.remove('active');
    }
  });

  // ===== Connection Wizard =====
  const addConnectionBtn = document.getElementById('addConnectionBtn');
  const connectionWizardModal = document.getElementById('connectionWizardModal');
  const wizardClose = document.getElementById('wizardClose');

  addConnectionBtn.addEventListener('click', () => {
    openConnectionWizard();
  });

  wizardClose.addEventListener('click', () => {
    closeConnectionWizard();
  });

  connectionWizardModal.addEventListener('click', (e) => {
    if (e.target === connectionWizardModal) {
      closeConnectionWizard();
    }
  });

  // Listen for OAuth completion
  window.os8.connections.onOAuthComplete((data) => {
    if (getWizardState().step === 3) {
      getWizardState().connectionResult = data;
      getWizardState().step++;
      renderWizardStep();
    }
  });

  // ===== Trash (Junk) Popover =====
  const trashBtn = document.getElementById('trashBtn');
  const archivedPopover = document.getElementById('archivedPopover');
  const closeArchivedPopover = document.getElementById('closeArchivedPopover');

  trashBtn.addEventListener('click', async () => {
    if (archivedPopover.classList.contains('active')) {
      archivedPopover.classList.remove('active');
    } else {
      await loadArchivedApps();
      renderArchivedApps();
      archivedPopover.classList.add('active');
    }
  });

  closeArchivedPopover.addEventListener('click', () => {
    archivedPopover.classList.remove('active');
  });

  // Close popover when clicking outside
  document.addEventListener('click', (e) => {
    if (!archivedPopover.contains(e.target) && e.target !== trashBtn && !trashBtn.contains(e.target)) {
      archivedPopover.classList.remove('active');
    }
  });

  // Drag over trash to archive
  trashBtn.addEventListener('dragover', (e) => {
    if (!getDraggedAppIcon()) return;
    e.preventDefault();
    trashBtn.classList.add('drag-over');
  });

  trashBtn.addEventListener('dragleave', () => {
    trashBtn.classList.remove('drag-over');
  });

  trashBtn.addEventListener('drop', async (e) => {
    e.preventDefault();
    trashBtn.classList.remove('drag-over');

    if (!getDraggedAppIcon()) return;

    const appId = getDraggedAppIcon().dataset.id;
    const app = getAppById(appId);
    if (!app) return;

    await window.os8.apps.archive(app.id);
    setApps(getApps().filter(a => a.id !== appId));
    renderApps();
    await loadArchivedApps();
  });

  // Load archived apps on startup to show indicator
  loadArchivedApps();

  // ===== Terminal =====
  const newTerminalBtn = document.getElementById('newTerminalBtn');

  newTerminalBtn.addEventListener('click', () => {
    createTerminalInstance('claude');
  });

  // ===== Panel Resizing =====
  const terminalPanel = document.getElementById('terminalPanel');
  const previewPanel = document.getElementById('previewPanel');
  const rightPanel = document.getElementById('rightPanel');
  const tasksPanel = document.getElementById('tasksPanel');
  const storagePanel = document.getElementById('storagePanel');
  const workspacePanels = document.querySelector('.workspace-panels');

  // Drag overlay to capture mouse events above BrowserView during resize
  const dragOverlay = document.createElement('div');
  dragOverlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999;display:none;';
  document.body.appendChild(dragOverlay);

  // Vertical divider drag handlers
  document.querySelectorAll('.panel-divider').forEach(divider => {
    divider.addEventListener('mousedown', (e) => {
      // Skip divider 2 when right panel is collapsed
      if (divider.dataset.divider === '2' && getRightPanelCollapsed()) return;
      e.preventDefault();
      setIsDragging(true);
      setCurrentDivider(divider);
      setStartX(e.clientX);
      divider.classList.add('dragging');
      document.body.classList.add('resizing');
      dragOverlay.style.display = 'block';
      dragOverlay.style.cursor = 'col-resize';

      const totalWidth = workspacePanels.clientWidth;
      setStartWidths({
        terminal: terminalPanel.offsetWidth,
        preview: previewPanel.offsetWidth,
        right: rightPanel.offsetWidth,
        total: totalWidth
      });
    });
  });

  // Horizontal divider drag handlers
  document.querySelectorAll('.panel-divider-h').forEach(divider => {
    divider.addEventListener('mousedown', (e) => {
      e.preventDefault();
      setIsDragging(true);
      setCurrentDivider(divider);
      setStartY(e.clientY);
      divider.classList.add('dragging');
      document.body.classList.add('resizing-v');
      dragOverlay.style.display = 'block';
      dragOverlay.style.cursor = 'row-resize';

      const rightPanelHeight = rightPanel.clientHeight;
      setStartHeights({
        tasks: tasksPanel.offsetHeight,
        storage: storagePanel.offsetHeight,
        total: rightPanelHeight
      });
    });
  });

  document.addEventListener('mousemove', (e) => {
    if (!getIsDragging() || !getCurrentDivider()) return;

    if (getCurrentDivider().classList.contains('panel-divider-h')) {
      // Horizontal resize
      const deltaY = e.clientY - getStartY();
      const dividerHeight = 4;
      const minHeight = 50;
      const availableHeight = getStartHeights().total - dividerHeight;

      const newTasksHeight = Math.max(minHeight, Math.min(getStartHeights().tasks + deltaY, availableHeight - minHeight));
      const newStorageHeight = availableHeight - newTasksHeight;

      tasksPanel.style.flex = 'none';
      tasksPanel.style.height = newTasksHeight + 'px';
      storagePanel.style.flex = 'none';
      storagePanel.style.height = newStorageHeight + 'px';
    } else {
      // Vertical resize
      const deltaX = e.clientX - getStartX();
      const dividerNum = getCurrentDivider().dataset.divider;

      if (dividerNum === '1') {
        const newTerminalWidth = Math.max(100, Math.min(getStartWidths().terminal + deltaX, getStartWidths().total - 200));
        const terminalPercent = (newTerminalWidth / getStartWidths().total) * 100;
        const previewPercent = ((getStartWidths().preview - deltaX) / getStartWidths().total) * 100;

        terminalPanel.style.width = terminalPercent + '%';
        previewPanel.style.width = Math.max(10, previewPercent) + '%';
      } else if (dividerNum === '2') {
        const newPreviewWidth = Math.max(100, Math.min(getStartWidths().preview + deltaX, getStartWidths().total - 200));
        const previewPercent = (newPreviewWidth / getStartWidths().total) * 100;
        const rightPercent = ((getStartWidths().right - deltaX) / getStartWidths().total) * 100;

        previewPanel.style.flex = 'none';
        rightPanel.style.flex = 'none';
        previewPanel.style.width = previewPercent + '%';
        rightPanel.style.width = Math.max(10, rightPercent) + '%';
      }

      if (getCurrentApp()) {
        updatePreviewBounds();
        fitTerminal();
      }
    }
  });

  document.addEventListener('mouseup', () => {
    if (getIsDragging() && getCurrentDivider()) {
      getCurrentDivider().classList.remove('dragging');
      document.body.classList.remove('resizing', 'resizing-v');
      dragOverlay.style.display = 'none';
      setIsDragging(false);
      setCurrentDivider(null);

      if (getCurrentApp()) {
        updatePreviewBounds();
        fitTerminal();
      }
    }
  });

  // ===== Final Init =====

  // Onboarding (first-run experience) — must complete before rendering home page
  // to prevent race condition where home page flashes before overlay appears
  await checkOnboarding();

  // Activate home view only after onboarding completes (not hardcoded in HTML)
  document.getElementById('homeView').classList.add('active');

  renderTabBar();
  loadApps();
  loadBackgroundSetting();
  loadProviders();

  // Core Services setup (no-ops if already done by onboarding splash)
  initCoreServices(newAppBtn);

  // Listen for tasks.json file changes (auto-refresh)
  window.os8.tasksFile.onFileChanged(() => {
    if (getCurrentApp()) {
      loadTasks();
    }
  });

  // Listen for jobs.json file changes (auto-refresh)
  window.os8.jobsFile.onFileChanged(() => {
    if (getCurrentApp() && getPanelMode() === 'jobs') {
      loadJobs();
    }
  });

  // Listen for apps created via API (headless app creation by agent)
  // If the assistant chat is active, auto-switch to the new app's dev workspace
  // with the current agent pre-selected in the terminal panel
  window.os8.apps.onCreated(async (appData) => {
    // Check if user is currently on the assistant tab
    const activeTab = getTabById(getActiveTabId());
    const wasOnAssistant = activeTab?.app?.app_type === 'system';

    // Refresh app list so the new app appears
    await loadApps();

    // If we were chatting with an agent, open the new app tab
    // (agent panel + build tab will be created by build:started handler)
    if (wasOnAssistant && appData?.id) {
      const app = getAppById(appData.id);
      if (app) {
        await createAppTab(app, { skipDefaultTerminal: true });
      }
    }
  });

  // Listen for app property updates (icon, name, color changed via API)
  window.os8.apps.onUpdated(async () => {
    await loadApps();
  });

  // Listen for build started events (add build status tab if build is dispatched)
  window.os8.build.onStarted(async ({ buildId, appId, appName, appColor, appIcon, backend, model, agentId, status, spec }) => {
    console.warn(`[Renderer] build:started received: status=${status}, buildId=${buildId}, appName=${appName}`);
    if (status === 'pending_approval') {
      // Show build proposal card in the current agent panel — don't switch tabs
      // No appId yet — app will be created on approval
      console.warn(`[Renderer] Dispatching build-proposal CustomEvent for ${buildId}`);
      document.dispatchEvent(new CustomEvent('build-proposal', {
        detail: { proposalId: buildId, appName, appColor, appIcon, backend, model, spec }
      }));
      return;
    }

    // status === 'running' — normal flow: open app tab + coder panel
    let app = getAppById(appId);
    if (!app) {
      await loadApps();
      app = getAppById(appId);
    }
    if (app) {
      await createAppTab(app);
    }

    // Ensure agent panel exists with the building agent selected
    const instances = getTerminalInstances();
    const agentPanel = instances.find(i => i.isAgentPanel);
    if (!agentPanel) {
      await createAgentInstance(appId, { agentId });
    } else if (agentId && agentPanel.agentId !== agentId && agentPanel._agentSelect) {
      agentPanel._agentSelect.value = agentId;
      agentPanel._agentSelect.dispatchEvent(new Event('change'));
    }

    // Create build status tab in the workspace
    createBuildStatusTab(buildId, appId, appName, backend, model);

    // Remove unused terminal instances (no user input yet) to reduce clutter
    const toRemove = getTerminalInstances().filter(i =>
      !i.isAgentPanel && !i.isBuildStatus && !i.hasInput
    );
    for (const inst of toRemove) {
      await closeTerminalInstance(inst.id);
    }
  });

  // Auto-refresh storage view when tab becomes visible
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && getCurrentApp()) {
      loadStorageView();
    }
  });

  // Refresh agent scope and storage when an agent is created or updated
  window.os8.agents.onChanged(async (agent) => {
    if (!agent) return;
    const { setActiveAgentId, setAgents } = await import('./state.js');
    // Refresh the shell's cached agent list
    try {
      const agentsList = await window.os8.agents.list();
      setAgents(agentsList);
    } catch (e) {}
    // Update scope to the changed agent and reload storage
    setActiveAgentId(agent.id);
    loadTasks();
    loadJobs();
    loadStorageView();
  });

  // ResizeObserver for terminals container
  let terminalResizeTimeout;
  const terminalResizeObserver = new ResizeObserver(() => {
    clearTimeout(terminalResizeTimeout);
    terminalResizeTimeout = setTimeout(() => {
      fitAllTerminals(getTerminalInstances());
    }, 50);
  });
  terminalResizeObserver.observe(terminalsContainer);
}

// ===== Run on DOM Ready =====
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
