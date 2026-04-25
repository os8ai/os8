/**
 * Shared application state for OS8 renderer
 * All modules import from here to access/modify shared state
 */

export const state = {
  // Core App State
  apps: [],
  currentApp: null,
  showHiddenFiles: false,
  assistantApp: null,
  coreReady: false,
  serverPort: 8888, // default, updated at init

  // Multi-Agent State
  agents: [],           // All agents [{id, name, emoji, backend, model, isDefault}]
  activeAgentId: null,  // Currently chatting with this agent
  agentScope: null,     // Sidebar scoping: null=app level, 'system'=system level, agentId=agent level

  // Tab State
  tabs: [
    { id: 'home', type: 'home', title: 'Home', closable: false }
  ],
  activeTabId: 'home',
  tabsInitialized: false,
  draggedTab: null,
  tabDropPosition: 'after',

  // Mode State
  currentMode: localStorage.getItem('os8-mode') || 'developer',
  viewMode: localStorage.getItem('os8-view-mode') || 'split',

  // Terminal State
  terminalInstances: [],
  terminalIdCounter: 0,
  ptyHandlersInitialized: false,

  // Background State
  currentBackground: 'gradient-purple',
  currentScrim: 25,

  // Connection/OAuth State
  connections: [],
  providers: {},
  wizardState: {
    step: 0,
    provider: null,
    credentials: {},
    scopes: []
  },
  oauthPortInfo: { current: 8888, default: 8888, isCustom: false },

  // App Grid State
  draggedAppIcon: null,
  draggedAppIndex: -1,

  // Color Picker State
  selectedAppColor: '#991b1b',
  selectedFontColor: '#ffffff',
  editingAppId: null,
  editSelectedColor: '#6366f1',
  editSelectedFontColor: '#ffffff',

  // Task State
  draggedTask: null,
  draggedProject: null,
  dropPosition: 'before',
  activeContextMenu: null,

  // Jobs Panel State
  panelMode: 'jobs', // 'todos' or 'jobs'
  jobsView: 'list', // 'list', 'detail', or 'runs'
  jobsFilterView: 'active', // 'active' or 'archive'
  selectedJobId: null,

  // Preview State
  previewExpanded: false,

  // Right Panel State
  rightPanelCollapsed: localStorage.getItem('os8-right-collapsed') !== 'false',

  // Settings State
  currentSettingsSection: 'appearance',

  // Archive State
  archivedApps: [],

  // Panel Resizing State
  isDragging: false,
  currentDivider: null,
  startX: 0,
  startY: 0,
  startWidths: {},
  startHeights: {}
};

// Constants (not mutable, but shared)
export const HIDDEN_FILES = ['CLAUDE.md', 'GEMINI.md', 'tasks.json'];

export const WIZARD_STEPS = [
  'provider',
  'setup',
  'credentials',
  'test-user',
  'permissions',
  'complete'
];

// Color palette for app icons (new app modal)
export const APP_COLORS = [
  '#991b1b', '#ec4899', '#ef4444', '#f97316', '#eab308', '#84cc16', '#22c55e', '#14b8a6',
  '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#ffffff', '#94a3b8', '#64748b', '#18181b'
];

// ============================================
// GETTERS - Read state values
// ============================================

// Core App State
export function getApps() { return state.apps; }
export function getCurrentApp() { return state.currentApp; }
export function getShowHiddenFiles() { return state.showHiddenFiles; }
export function getAssistantApp() { return state.assistantApp; }
export function getCoreReady() { return state.coreReady; }
export function getServerPort() { return state.serverPort; }
export function getAgents() { return state.agents; }
export function getActiveAgentId() { return state.activeAgentId; }
export function getActiveAgent() { return state.agents.find(a => a.id === state.activeAgentId); }
export function getAgentScope() { return state.agentScope; }
export function getEffectiveAgentId() {
  const scope = state.agentScope;
  return (scope && scope !== 'system') ? scope : undefined;
}

// Tab State
export function getTabs() { return state.tabs; }
export function getActiveTabId() { return state.activeTabId; }
export function getTabsInitialized() { return state.tabsInitialized; }
export function getDraggedTab() { return state.draggedTab; }
export function getTabDropPosition() { return state.tabDropPosition; }

// Mode State
export function getCurrentMode() { return state.currentMode; }
export function getViewMode() { return state.viewMode; }

// Terminal State
export function getTerminalInstances() { return state.terminalInstances; }
export function getTerminalIdCounter() { return state.terminalIdCounter; }
export function getPtyHandlersInitialized() { return state.ptyHandlersInitialized; }

// Background State
export function getCurrentBackground() { return state.currentBackground; }
export function getCurrentScrim() { return state.currentScrim; }

// Connection/OAuth State
export function getConnections() { return state.connections; }
export function getProviders() { return state.providers; }
export function getWizardState() { return state.wizardState; }
export function getOauthPortInfo() { return state.oauthPortInfo; }

// App Grid State
export function getDraggedAppIcon() { return state.draggedAppIcon; }
export function getDraggedAppIndex() { return state.draggedAppIndex; }

// Color Picker State
export function getSelectedAppColor() { return state.selectedAppColor; }
export function getSelectedFontColor() { return state.selectedFontColor; }
export function getEditingAppId() { return state.editingAppId; }
export function getEditSelectedColor() { return state.editSelectedColor; }
export function getEditSelectedFontColor() { return state.editSelectedFontColor; }

// Task State
export function getDraggedTask() { return state.draggedTask; }
export function getDraggedProject() { return state.draggedProject; }
export function getDropPosition() { return state.dropPosition; }
export function getActiveContextMenu() { return state.activeContextMenu; }

// Jobs Panel State
export function getPanelMode() { return state.panelMode; }
export function getJobsView() { return state.jobsView; }
export function getJobsFilterView() { return state.jobsFilterView; }
export function getSelectedJobId() { return state.selectedJobId; }

// Preview State
export function getPreviewExpanded() { return state.previewExpanded; }

// Right Panel State
export function getRightPanelCollapsed() { return state.rightPanelCollapsed; }

// Settings State
export function getCurrentSettingsSection() { return state.currentSettingsSection; }

// Archive State
export function getArchivedApps() { return state.archivedApps; }

// Panel Resizing State
export function getIsDragging() { return state.isDragging; }
export function getCurrentDivider() { return state.currentDivider; }
export function getStartX() { return state.startX; }
export function getStartY() { return state.startY; }
export function getStartWidths() { return state.startWidths; }
export function getStartHeights() { return state.startHeights; }

// ============================================
// SETTERS - Modify state values
// ============================================

// Core App State
export function setApps(apps) { state.apps = apps; }
export function setCurrentApp(app) { state.currentApp = app; }
export function setShowHiddenFiles(value) { state.showHiddenFiles = value; }
export function setAssistantApp(app) { state.assistantApp = app; }
export function setCoreReady(value) { state.coreReady = value; }
export function setServerPort(port) { state.serverPort = port; }
export function setAgents(agents) { state.agents = agents; }
export function setActiveAgentId(id) {
  state.activeAgentId = id;
  localStorage.setItem('os8-active-agent-id', id);
  // Default: scope sidebar to the active agent
  state.agentScope = id;
}
export function setAgentScope(scope) { state.agentScope = scope; }

// Tab State
export function setTabs(tabs) { state.tabs = tabs; }
export function setActiveTabId(id) { state.activeTabId = id; }
export function setTabsInitialized(value) { state.tabsInitialized = value; }
export function setDraggedTab(tab) { state.draggedTab = tab; }
export function setTabDropPosition(position) { state.tabDropPosition = position; }

// Mode State
export function setCurrentMode(mode) {
  state.currentMode = mode;
  localStorage.setItem('os8-mode', mode);
}
export function setViewMode(mode) {
  state.viewMode = mode;
  localStorage.setItem('os8-view-mode', mode);
}

// Terminal State
export function setTerminalInstances(instances) { state.terminalInstances = instances; }
export function setTerminalIdCounter(count) { state.terminalIdCounter = count; }
export function setPtyHandlersInitialized(value) { state.ptyHandlersInitialized = value; }

// Background State
export function setCurrentBackground(bg) { state.currentBackground = bg; }
export function setCurrentScrim(scrim) { state.currentScrim = scrim; }

// Connection/OAuth State
export function setConnections(connections) { state.connections = connections; }
export function setProviders(providers) { state.providers = providers; }
export function setWizardState(wizardState) { state.wizardState = wizardState; }
export function setOauthPortInfo(info) { state.oauthPortInfo = info; }

// App Grid State
export function setDraggedAppIcon(icon) { state.draggedAppIcon = icon; }
export function setDraggedAppIndex(index) { state.draggedAppIndex = index; }

// Color Picker State
export function setSelectedAppColor(color) { state.selectedAppColor = color; }
export function setSelectedFontColor(color) { state.selectedFontColor = color; }
export function setEditingAppId(id) { state.editingAppId = id; }
export function setEditSelectedColor(color) { state.editSelectedColor = color; }
export function setEditSelectedFontColor(color) { state.editSelectedFontColor = color; }

// Task State
export function setDraggedTask(task) { state.draggedTask = task; }
export function setDraggedProject(project) { state.draggedProject = project; }
export function setDropPosition(position) { state.dropPosition = position; }
export function setActiveContextMenu(menu) { state.activeContextMenu = menu; }

// Jobs Panel State
export function setPanelMode(mode) { state.panelMode = mode; }
export function setJobsView(view) { state.jobsView = view; }
export function setJobsFilterView(view) { state.jobsFilterView = view; }
export function setSelectedJobId(id) { state.selectedJobId = id; }

// Preview State
export function setPreviewExpanded(value) { state.previewExpanded = value; }

// Right Panel State
export function setRightPanelCollapsed(value) {
  state.rightPanelCollapsed = value;
  localStorage.setItem('os8-right-collapsed', value);
}

// Settings State
export function setCurrentSettingsSection(section) { state.currentSettingsSection = section; }

// Archive State
export function setArchivedApps(apps) { state.archivedApps = apps; }

// Panel Resizing State
export function setIsDragging(value) { state.isDragging = value; }
export function setCurrentDivider(divider) { state.currentDivider = divider; }
export function setStartX(x) { state.startX = x; }
export function setStartY(y) { state.startY = y; }
export function setStartWidths(widths) { state.startWidths = widths; }
export function setStartHeights(heights) { state.startHeights = heights; }

// ============================================
// ARRAY HELPERS - Common operations on arrays
// ============================================

// Apps
export function addApp(app) { state.apps.push(app); }
export function removeAppById(id) {
  const idx = state.apps.findIndex(a => a.id === id);
  if (idx !== -1) state.apps.splice(idx, 1);
}
export function getAppById(id) { return state.apps.find(a => a.id === id); }
export function getAppBySlug(slug) { return state.apps.find(a => a.slug === slug); }

// Tabs
export function addTab(tab) { state.tabs.push(tab); }
export function removeTabById(id) {
  const idx = state.tabs.findIndex(t => t.id === id);
  if (idx !== -1) state.tabs.splice(idx, 1);
}
export function getTabById(id) { return state.tabs.find(t => t.id === id); }
export function getAppTabByAppId(appId) {
  return state.tabs.find(t => t.type === 'app' && t.app?.id === appId);
}
export function getAppTabs() {
  return state.tabs.filter(t => t.type === 'app');
}
export function updateTabById(id, updates) {
  const tab = state.tabs.find(t => t.id === id);
  if (tab) Object.assign(tab, updates);
  return tab;
}

// Terminal Instances
//
// `terminalInstances` is a flat global array of all live instances across
// every tab — xterm sessions, agent panels, and build-status panels. Each
// instance is stamped with `tabId` at creation, so per-tab views are derived
// at call sites rather than maintained as separate state.
//
// Why a flat global rather than per-tab arrays: PTY output events arrive via
// `terminal:output` IPC and are dispatched by `getTerminalInstanceBySessionId`,
// which has to find the right xterm regardless of which tab is currently
// active (parked-but-alive instances still receive PTY data).
export function addTerminalInstance(instance) { state.terminalInstances.push(instance); }
export function removeTerminalInstance(id) {
  const idx = state.terminalInstances.findIndex(t => t.id === id);
  if (idx !== -1) state.terminalInstances.splice(idx, 1);
}
export function getTerminalInstanceById(id) {
  return state.terminalInstances.find(t => t.id === id);
}
export function getTerminalInstanceBySessionId(sessionId) {
  return state.terminalInstances.find(t => t.sessionId === sessionId);
}
export function getTerminalInstancesForTab(tabId) {
  return state.terminalInstances.filter(t => t.tabId === tabId);
}
export function getTerminalInstancesForActiveTab() {
  return state.terminalInstances.filter(t => t.tabId === state.activeTabId);
}
export function incrementTerminalIdCounter() {
  return ++state.terminalIdCounter;
}

// Connections
export function addConnection(conn) { state.connections.push(conn); }
export function removeConnectionById(id) {
  const idx = state.connections.findIndex(c => c.id === id);
  if (idx !== -1) state.connections.splice(idx, 1);
}
export function getConnectionById(id) {
  return state.connections.find(c => c.id === id);
}

// ============================================
// WIZARD STATE HELPERS
// ============================================

export function updateWizardState(updates) {
  Object.assign(state.wizardState, updates);
}

export function resetWizardState() {
  state.wizardState = {
    step: 0,
    provider: null,
    credentials: {},
    scopes: []
  };
}

export function getWizardStep() { return state.wizardState.step; }
export function setWizardStep(step) { state.wizardState.step = step; }
export function getWizardProvider() { return state.wizardState.provider; }
export function setWizardProvider(provider) { state.wizardState.provider = provider; }
export function getWizardCredentials() { return state.wizardState.credentials; }
export function setWizardCredentials(credentials) { state.wizardState.credentials = credentials; }
export function getWizardScopes() { return state.wizardState.scopes; }
export function setWizardScopes(scopes) { state.wizardState.scopes = scopes; }

// ============================================
// COMPUTED STATE / DERIVED VALUES
// ============================================

export function getActiveTab() {
  return state.tabs.find(t => t.id === state.activeTabId);
}

export function hasMultipleAppTabs() {
  return state.tabs.filter(t => t.type === 'app').length > 1;
}

export function getVaultTab() {
  return state.tabs.find(t => t.type === 'vault');
}

export function getEffectiveViewMode() {
  // In developer mode, view mode doesn't apply
  if (state.currentMode === 'developer') return 'focus';
  // Only one app tab = force focus
  if (!hasMultipleAppTabs()) return 'focus';
  return state.viewMode;
}
