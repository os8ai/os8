const { app, BrowserWindow, ipcMain, session, systemPreferences, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const { initDatabase, AppService, AgentService, scaffoldAssistantApp, TaskService, TasksFileService, EnvService, SettingsService, ClaudeInstructionsService, CoreService, ConnectionsService, PROVIDERS, generateClaudeMd, generateAssistantClaudeMd, APPS_DIR, BLOB_DIR, CORE_DIR } = require('./src/db');
const { WhisperService, WhisperStreamService, TTSService, TunnelService, JobsFileService, JobSchedulerService, WorkQueue, DataStorageService, McpServerService, McpCatalogService, CapabilityService } = require('./src/services');
const { startServer, stopServer, restartServer, getAppUrl, getPort, setOAuthCompleteCallback, setAppCreatedCallback, setAppUpdatedCallback, setAgentChangedCallback, setBuildStartedCallback, setBuildCompletedCallback, DEFAULT_PORT } = require('./src/server');
const { registerAllHandlers, getCleanupFunctions } = require('./src/ipc');

// AppImage sandbox fix: SUID chrome-sandbox is impossible inside FUSE mount
if (process.env.APPIMAGE) {
  app.commandLine.appendSwitch('no-sandbox');
}

// Auto-reload in development
try {
  require('electron-reloader')(module, {
    ignore: ['src/db.js'] // Don't reload on db changes
  });
} catch {}

// Catch unhandled errors to prevent silent crashes
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.stack || err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason?.stack || reason);
});

let mainWindow;
let db;

// ============ Shared State ============
const ptySessions = new Map();
const previewViews = new Map(); // Map of appId -> BrowserView for multi-app preview

// ============ Tasks File Watcher ============
let watchedTasksPath = null;

function startTasksWatcher(appId, agentId) {
  stopTasksWatcher(); // Clean up any existing watcher

  let tasksPath;
  if (agentId) {
    const AgentService = require('./src/services/agent');
    const { agentDir } = AgentService.getPaths(appId, agentId);
    tasksPath = path.join(agentDir, 'tasks.json');
  } else {
    const { APPS_DIR } = require('./src/config');
    tasksPath = path.join(APPS_DIR, appId, 'tasks.json');
  }
  if (!fs.existsSync(tasksPath)) return;

  watchedTasksPath = tasksPath;

  // Use fs.watchFile with polling - reliable even with atomic writes
  fs.watchFile(tasksPath, { interval: 3000 }, (curr, prev) => {
    // Check if file was actually modified (mtime changed)
    if (curr.mtime !== prev.mtime) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('tasks:file-changed');
      }
    }
  });
}

function stopTasksWatcher() {
  if (watchedTasksPath) {
    fs.unwatchFile(watchedTasksPath);
    watchedTasksPath = null;
  }
}

// ============ Jobs File Watcher ============
let watchedJobsPath = null;

function startJobsWatcher(appId, agentId) {
  stopJobsWatcher(); // Clean up any existing watcher

  let jobsPath;
  if (agentId) {
    const AgentService = require('./src/services/agent');
    const { agentDir } = AgentService.getPaths(appId, agentId);
    jobsPath = path.join(agentDir, 'jobs.json');
  } else {
    const { APPS_DIR } = require('./src/config');
    jobsPath = path.join(APPS_DIR, appId, 'jobs.json');
  }
  if (!fs.existsSync(jobsPath)) return;

  watchedJobsPath = jobsPath;

  // Use fs.watchFile with polling - reliable even with atomic writes
  fs.watchFile(jobsPath, { interval: 3000 }, (curr, prev) => {
    // Check if file was actually modified (mtime changed)
    if (curr.mtime !== prev.mtime) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('jobs:file-changed');
      }
    }
  });
}

function stopJobsWatcher() {
  if (watchedJobsPath) {
    fs.unwatchFile(watchedJobsPath);
    watchedJobsPath = null;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    backgroundColor: '#0f172a',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadFile('index.html');

  // Forward renderer console to terminal (for debugging)
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    if (level >= 2) { // warnings and errors only
      const src = sourceId ? sourceId.split('/').pop() : '';
      console.log(`[Renderer] ${message}${src ? ` (${src}:${line})` : ''}`);
    }
  });

  // Register all IPC handlers
  registerAllHandlers({
    mainWindow,
    db,
    services: {
      AppService,
      AgentService,
      scaffoldAssistantApp,
      TaskService,
      TasksFileService,
      EnvService,
      SettingsService,
      ClaudeInstructionsService,
      CoreService,
      ConnectionsService,
      PROVIDERS,
      generateClaudeMd,
      generateAssistantClaudeMd,
      APPS_DIR,
      BLOB_DIR,
      CORE_DIR,
      WhisperService,
      WhisperStreamService,
      TTSService,
      TunnelService,
      JobsFileService,
      JobSchedulerService,
      DataStorageService,
      McpServerService,
      McpCatalogService,
      CapabilityService
    },
    state: {
      ptySessions,
      previewViews
    },
    helpers: {
      startTasksWatcher,
      stopTasksWatcher,
      startJobsWatcher,
      stopJobsWatcher,
      restartServer,
      getAppUrl,
      getPort,
      DEFAULT_PORT
    }
  });

  // ============ Zoom Handling ============

  ipcMain.handle('zoom:get-factor', () => {
    return mainWindow.webContents.getZoomFactor();
  });

  mainWindow.webContents.on('zoom-changed', (event, direction) => {
    // zoom-changed fires before the zoom applies, defer to read the new value
    setTimeout(() => {
      const factor = mainWindow.webContents.getZoomFactor();
      // Notify renderer to recalculate preview bounds
      mainWindow.webContents.send('zoom:changed', factor);
      // Sync zoom to all BrowserViews so app content scales in sync
      for (const view of previewViews.values()) {
        view.webContents.setZoomFactor(factor);
      }
    }, 50);
  });
}

// ============ App Lifecycle ============

app.whenReady().then(async () => {
  // Set dock icon for dev mode (packaged app uses the bundled .icns)
  const iconPath = path.join(__dirname, 'build', 'icon.png');
  if (process.platform === 'darwin' && fs.existsSync(iconPath)) {
    const { nativeImage } = require('electron');
    app.dock.setIcon(nativeImage.createFromPath(iconPath));
  }

  // Initialize database
  db = initDatabase();
  console.log('OS8 database initialized');

  // Migrate any previously-encrypted keys back to plaintext (one-time)
  EnvService.migrateEncryptedToPlaintext(db);

  // Request microphone permission on macOS (triggers system dialog if needed)
  if (process.platform === 'darwin') {
    const micStatus = systemPreferences.getMediaAccessStatus('microphone');
    console.log('Microphone access status:', micStatus);
    if (micStatus !== 'granted') {
      systemPreferences.askForMediaAccess('microphone').then(granted => {
        console.log('Microphone permission granted:', granted);
      });
    }
  }

  // Grant media permissions (microphone, camera) for voice input
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const url = details?.requestingUrl || webContents.getURL();
    console.log('Permission request:', { permission, requestingUrl: url });

    if (permission === 'media') {
      // Allow from file://, localhost, and our app server
      const allowed =
        url.startsWith('file://') ||
        url.startsWith('http://localhost') ||
        url.startsWith('http://127.0.0.1');
      console.log(`Media permission ${allowed ? 'GRANTED' : 'DENIED'} for ${url}`);
      return callback(allowed);
    }

    // Allow other permissions
    callback(true);
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    if (permission === 'media') {
      return true;
    }
    return true;
  });

  // Start the Express server with auto-assigned port (pass db for slug->id lookup)
  await startServer(null, db);

  // NOTE: Incomplete agent cleanup moved to POST /api/agents handler.
  // Running it on startup would delete agents the user is actively setting up
  // if OS8 restarts mid-setup.

  // Initialize the work queue with db getter (avoids storing db as global property)
  const { PlanExecutorService } = require('./src/services/plan-executor');
  WorkQueue.init({
    getDb: () => db,
    onPlanStepComplete: (planId, stepId, response) => {
      if (PlanExecutorService._stepResolvers?.[stepId]) {
        PlanExecutorService._stepResolvers[stepId](response);
        delete PlanExecutorService._stepResolvers[stepId];
      }
    }
  });
  PlanExecutorService.setWorkQueue(WorkQueue);
  PlanExecutorService.setDb(db);

  // Initialize and start the job scheduler with the work queue
  JobSchedulerService.init({ workQueue: WorkQueue, db });
  await JobSchedulerService.start();

  // Handle system resume (wake from sleep) - check for overdue jobs
  powerMonitor.on('resume', () => {
    console.log('System resumed from sleep, checking for overdue jobs...');
    if (JobSchedulerService.isStarted) {
      JobSchedulerService.tick('resume');
    }
  });

  // Set up OAuth complete callback to notify renderer
  setOAuthCompleteCallback((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('connections:oauth-complete', data);
    }
  });

  // Set up app created callback to notify renderer (for headless app creation via API)
  setAppCreatedCallback((appData) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('apps:created', appData);
    }
  });

  setAppUpdatedCallback((appData) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('apps:updated', appData);
    }
  });

  setAgentChangedCallback((agent) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agents:changed', agent);
    }
  });

  // Set up build event callbacks to notify renderer (for build status tabs)
  setBuildStartedCallback((data) => {
    console.log(`[Main] build:started IPC → renderer: status=${data.status}, buildId=${data.buildId}, windowAlive=${!!(mainWindow && !mainWindow.isDestroyed())}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('build:started', data);
    }
  });
  setBuildCompletedCallback((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('build:completed', data);
    }
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', async () => {
  // Get cleanup functions and run them
  const cleanup = getCleanupFunctions();
  if (cleanup.killAllPtySessions) {
    cleanup.killAllPtySessions();
  }
  if (cleanup.destroyAllPreviewViews) {
    cleanup.destroyAllPreviewViews();
  }
  if (cleanup.destroyAllInspectionViews) {
    cleanup.destroyAllInspectionViews();
  }

  // Stop the job scheduler
  JobSchedulerService.stop();

  // Stop the server
  await stopServer();

  if (db) {
    db.close();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
