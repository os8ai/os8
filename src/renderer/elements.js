/**
 * DOM element references for OS8 renderer
 * Call initElements() after DOM is ready
 */

export const elements = {};

export function initElements() {
  // Tab bar and views
  elements.tabBar = document.getElementById('tabBar');
  elements.homeView = document.getElementById('homeView');
  elements.workspaceView = document.getElementById('workspaceView');

  // App grid
  elements.appsGrid = document.getElementById('appsGrid');
  elements.newAppBtn = document.getElementById('newAppBtn');
  elements.newAppModal = document.getElementById('newAppModal');
  elements.newAppName = document.getElementById('newAppName');
  elements.cancelNewApp = document.getElementById('cancelNewApp');
  elements.createNewApp = document.getElementById('createNewApp');

  // Workspace header
  elements.closeAppBtn = document.getElementById('closeAppBtn');
  elements.workspaceTitle = document.getElementById('workspaceTitle');

  // Preview area
  elements.previewArea = document.getElementById('previewArea');
  elements.previewUrlInput = document.getElementById('previewUrlInput');
  elements.previewUrlPrefix = document.getElementById('previewUrlPrefix');
  elements.previewGoBtn = document.getElementById('previewGoBtn');
  elements.previewBackBtn = document.getElementById('previewBackBtn');
  elements.previewForwardBtn = document.getElementById('previewForwardBtn');
  elements.previewRefreshBtn = document.getElementById('previewRefreshBtn');

  // Settings
  elements.settingsBtn = document.getElementById('settingsBtn');
  elements.settingsModal = document.getElementById('settingsModal');

  // File browser
  elements.fileTree = document.getElementById('fileTree');
  elements.blobTree = document.getElementById('blobTree');
  elements.storageSelect = document.getElementById('storageSelect');
  elements.refreshStorageBtn = document.getElementById('refreshStorageBtn');
  elements.toggleHiddenFilesBtn = document.getElementById('toggleHiddenFilesBtn');
  elements.systemFilesView = document.getElementById('systemFilesView');
  elements.dataStorageView = document.getElementById('dataStorageView');
  elements.blobStorageView = document.getElementById('blobStorageView');
  elements.dataStorageTree = document.getElementById('dataStorageTree');

  // File viewer modal
  elements.fileViewerModal = document.getElementById('fileViewerModal');
  elements.fileViewerName = document.getElementById('fileViewerName');
  elements.fileViewerContent = document.getElementById('fileViewerContent');
  elements.fileViewerCode = document.getElementById('fileViewerCode');
  elements.closeFileViewer = document.getElementById('closeFileViewer');
  elements.refreshFileViewer = document.getElementById('refreshFileViewer');

  // Terminal
  elements.terminalsContainer = document.getElementById('terminalsContainer');

  // Tasks
  elements.tasksList = document.getElementById('tasksList');
  elements.tasksViewSelect = document.getElementById('tasksViewSelect');
  elements.addTaskBtn = document.getElementById('addTaskBtn');
  elements.addProjectBtn = document.getElementById('addProjectBtn');
  elements.refreshTasksBtn = document.getElementById('refreshTasksBtn');

  // Jobs (panel mode switcher and jobs list)
  elements.panelModeSelect = document.getElementById('panelModeSelect');
  elements.jobsFilterSelect = document.getElementById('jobsFilterSelect');
  elements.jobsList = document.getElementById('jobsList');
  elements.addJobBtn = document.getElementById('addJobBtn');
  elements.todosContent = document.getElementById('todosContent');
  elements.jobsContentWrapper = document.getElementById('jobsContentWrapper');
}
