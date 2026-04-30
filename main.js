const { app, BrowserWindow, ipcMain, session, systemPreferences, powerMonitor, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ─── Per-OS8_HOME single-instance lock (PR 1.2) ─────────────────────────────
// Scope userData per OS8_HOME so two dev instances with different OS8_HOME
// values get independent single-instance locks. Electron 40's
// requestSingleInstanceLock() does NOT take a key argument — userData-dir
// scoping is the correct mechanism for per-instance isolation.
const _userDataDir = path.join(
  process.env.OS8_HOME || path.join(os.homedir(), 'os8'),
  '.os8-electron-userdata'
);
try { app.setPath('userData', _userDataDir); }
catch (e) { console.warn('[main] setPath userData failed:', e.message); }

if (!app.requestSingleInstanceLock()) {
  // Another instance with the same OS8_HOME already owns the lock; the
  // already-running instance's `second-instance` listener (wired below)
  // will receive any os8:// argv we were launched with.
  app.quit();
  return;
}
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

// ─── os8:// protocol handler (PR 1.2) ───────────────────────────────────────
// Routes os8://install?slug=…&commit=…&channel=…&source=… into the install
// pipeline. PR 1.18 wires this through the install plan modal; PR 1.2 ships
// the parsing + lifecycle hooks + Linux .desktop integration.
const { handleProtocolUrl, setProtocolDeps } = require('./src/services/protocol-handler');

// macOS: open-url fires when the running instance is asked to handle a deeplink.
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleProtocolUrl(url, mainWindow);
});

// Windows / Linux: second-instance fires in the FIRST instance when a SECOND
// is launched. argv contains the original launch args of the second instance,
// including the os8:// URL.
app.on('second-instance', (_event, argv) => {
  const url = (argv || []).find(a => typeof a === 'string' && a.startsWith('os8://'));
  if (url) handleProtocolUrl(url, mainWindow);
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

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

  // Register os8:// scheme. macOS honors this once per build; Windows writes
  // HKEY_CURRENT_USER registry keys; Linux honors via the .desktop file
  // (.deb postinst) or the AppImage first-run prompt (PR 1.2 follow-up).
  try { app.setAsDefaultProtocolClient('os8'); }
  catch (e) { console.warn('[main] setAsDefaultProtocolClient failed:', e.message); }

  // Initialize database
  db = initDatabase();
  console.log('OS8 database initialized');

  // PR 1.18: now that the catalog service has a db, wire the protocol-
  // handler so os8://install deeplinks can cross-check + dispatch into
  // the install plan modal.
  try {
    const AppCatalogService = require('./src/services/app-catalog');
    setProtocolDeps({ db, AppCatalogService });
  } catch (e) {
    console.warn('[main] setProtocolDeps failed:', e.message);
  }

  // Migrate any previously-encrypted keys back to plaintext (one-time)
  EnvService.migrateEncryptedToPlaintext(db);

  // Run pending version migrations (src/migrations/*.js). See CLAUDE.md §Upgrade System.
  // On MigrationError we write a failure log, show a dialog, and refuse to start —
  // a half-applied upgrade is worse than a loud failure.
  try {
    const { run: runMigrations, MigrationError } = require('./src/services/migrator');
    await runMigrations({ db, logger: console });
  } catch (err) {
    const { MigrationError } = require('./src/services/migrator');
    if (err instanceof MigrationError) {
      const { OS8_DIR } = require('./src/config');
      const logsDir = path.join(OS8_DIR, 'logs');
      try { fs.mkdirSync(logsDir, { recursive: true }); } catch {}
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const logPath = path.join(logsDir, `migration-failure-${ts}.log`);
      const body = [
        `OS8 migration failed.`,
        ``,
        `Migration file: ${err.migration.filename}`,
        `Target version: ${err.migration.version}`,
        `Description:    ${err.migration.description || '(none)'}`,
        ``,
        `Error: ${err.cause.message}`,
        ``,
        `Stack:`,
        err.cause.stack || '(no stack)',
        ``,
        `The stored os8_version has not advanced to this migration's version, so`,
        `restarting OS8 will retry. Fix the underlying issue (or roll back to the`,
        `prior OS8 release) before restarting.`,
        ``
      ].join('\n');
      try { fs.writeFileSync(logPath, body); } catch (writeErr) {
        console.error('[migrator] Failed to write failure log:', writeErr.message);
      }
      console.error(`[migrator] FAILED — ${err.message}. See ${logPath}`);
      dialog.showErrorBox(
        'OS8 upgrade failed',
        `Migration ${err.migration.version} couldn't run:\n\n${err.cause.message}\n\nDetails: ${logPath}\n\nOS8 cannot start until this is resolved.`
      );
      app.quit();
      return;
    }
    throw err;
  }

  // Reconcile TTS provider state with the current ai_mode. An ai_mode flip
  // during a prior session (or the 0.4.2 migration splitting tts_provider
  // into per-mode slots) can leave agents.voice_id and tts.defaultVoice*
  // pointing at the previous mode's voice IDs. Running the resolver at
  // startup is cheap (no-op when active already matches) and heals stuck
  // state without waiting for the user to open the settings panel.
  try {
    TTSService.resolveActiveProvider(db);
  } catch (err) {
    console.warn('[startup] TTS resolveActiveProvider failed:', err.message);
  }

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

  // External-app process lifecycle. Initialized after the server is up so
  // getPort() returns a real value when the registry composes OS8_API_BASE.
  try {
    const APR = require('./src/services/app-process-registry');
    APR.init({ db, getOS8Port: getPort });
  } catch (e) {
    console.warn('[main] AppProcessRegistry init failed:', e.message);
  }

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

  // Stop external app processes before the server shuts down so any
  // in-flight requests they made don't error out mid-handshake.
  try {
    const APR = require('./src/services/app-process-registry');
    await APR.get().stopAll();
  } catch (_) { /* registry not initialized — nothing to stop */ }

  // Stop the server
  await stopServer();

  if (db) {
    db.close();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
