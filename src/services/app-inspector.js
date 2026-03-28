/**
 * AppInspectorService
 * Manages hidden BrowserViews for headless app inspection.
 * Captures screenshots and console errors for build-inspect-fix loop.
 */

const { BrowserView } = require('electron');
const { compressForClaude } = require('../utils/image-compress');

const SETTLE_MS = 3000;        // Wait for app to settle after load
const CACHE_TTL_MS = 60000;    // Auto-destroy hidden view after 60s
const VIEW_WIDTH = 1280;
const VIEW_HEIGHT = 720;

let _mainWindow = null;
let _previewService = null;
const hiddenViews = new Map();   // appId → { view, timer }

const AppInspectorService = {
  /**
   * @param {object} mainWindow - Electron BrowserWindow
   * @param {object} [previewService] - PreviewService instance (for console buffer access)
   */
  init(mainWindow, previewService) {
    _mainWindow = mainWindow;
    _previewService = previewService;
  },

  /**
   * Inspect an app: load it in a hidden BrowserView, screenshot, collect console errors.
   * @param {string} appId
   * @param {string} appUrl - Full URL to load (e.g. http://localhost:8888/{appId}/)
   * @returns {Promise<{screenshot: {data, mediaType}, consoleErrors: [], consoleWarnings: [], loadTimeMs: number}>}
   */
  async inspect(appId, appUrl) {
    if (!_mainWindow) {
      throw new Error('AppInspectorService not initialized (call init(mainWindow) first)');
    }

    // Clear any previous console messages for this app
    _previewService.clearConsoleBuffer(appId);

    const startTime = Date.now();

    // Create or reuse hidden BrowserView
    let entry = hiddenViews.get(appId);
    let view;

    if (entry) {
      clearTimeout(entry.timer);
      view = entry.view;
      // Check if view is still usable
      try {
        view.webContents.getURL();
      } catch (e) {
        // View was destroyed, create new one
        hiddenViews.delete(appId);
        entry = null;
      }
    }

    if (!entry) {
      view = new BrowserView({
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
        },
      });

      _mainWindow.addBrowserView(view);
      // Position offscreen
      view.setBounds({ x: -10000, y: -10000, width: VIEW_WIDTH, height: VIEW_HEIGHT });

      // Wire console-message listener to shared buffer
      view.webContents.on('console-message', (event, level, message, line, sourceId) => {
        _previewService.pushConsoleMessage(appId, level, message, line, sourceId);
      });

      entry = { view, timer: null };
      hiddenViews.set(appId, entry);
    }

    // Load app and wait for completion
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Page load timeout (30s)')), 30000);

      view.webContents.once('did-finish-load', () => {
        clearTimeout(timeout);
        resolve();
      });

      view.webContents.once('did-fail-load', (event, errorCode, errorDescription) => {
        clearTimeout(timeout);
        reject(new Error(`Page load failed: ${errorDescription} (${errorCode})`));
      });

      view.webContents.loadURL(appUrl);
    });

    // Wait for app to settle (React rendering, API calls, etc.)
    await new Promise(resolve => setTimeout(resolve, SETTLE_MS));

    const loadTimeMs = Date.now() - startTime;

    // Move view on-screen briefly for capture — offscreen views may produce empty captures
    view.setBounds({ x: 0, y: 0, width: VIEW_WIDTH, height: VIEW_HEIGHT });
    await new Promise(resolve => setTimeout(resolve, 200));

    // Capture screenshot
    const nativeImage = await view.webContents.capturePage();
    const pngBuffer = nativeImage.toPNG();

    // Move back offscreen
    view.setBounds({ x: -10000, y: -10000, width: VIEW_WIDTH, height: VIEW_HEIGHT });

    if (!pngBuffer || pngBuffer.length === 0) {
      throw new Error('Screenshot capture returned empty image — app may not have rendered');
    }

    const compressed = await compressForClaude(pngBuffer);

    // Collect console errors and warnings
    const allMessages = _previewService.getConsoleBuffer(appId);
    const consoleErrors = allMessages.filter(m => m.level === 'error');
    const consoleWarnings = allMessages.filter(m => m.level === 'warning');

    // Schedule auto-cleanup
    entry.timer = setTimeout(() => {
      this.destroyHiddenView(appId);
    }, CACHE_TTL_MS);

    return {
      screenshot: {
        data: compressed.data,
        mediaType: compressed.mediaType
      },
      consoleErrors,
      consoleWarnings,
      loadTimeMs
    };
  },

  destroyHiddenView(appId) {
    const entry = hiddenViews.get(appId);
    if (entry) {
      clearTimeout(entry.timer);
      try {
        if (_mainWindow && !entry.view.webContents.isDestroyed()) {
          _mainWindow.removeBrowserView(entry.view);
          entry.view.webContents.destroy();
        }
      } catch (e) {
        console.log(`[AppInspector] Cleanup: view ${appId} already destroyed`);
      }
      hiddenViews.delete(appId);
    }
  },

  destroyAll() {
    for (const appId of hiddenViews.keys()) {
      this.destroyHiddenView(appId);
    }
  }
};

module.exports = AppInspectorService;
