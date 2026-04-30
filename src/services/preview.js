/**
 * PreviewService — BrowserView lifecycle, console buffer, navigation.
 *
 * Instance-based: holds views Map, console buffers, mainWindow ref.
 */

const path = require('path');
const { BrowserView, shell } = require('electron');

const CONSOLE_BUFFER_MAX = 100;

/**
 * Hardened webPreferences for external apps (PR 1.19). Pure function so
 * unit tests can compare object shape without spinning up Electron.
 *
 * Spec §6.6: sandbox, contextIsolation, no node integration, web security
 * on, no insecure content. The external preload (PR 1.9) is pointed at by
 * absolute path — file existence is checked at create-time so a missing
 * preload doesn't break native apps.
 */
function externalWebPreferences(preloadPath = null) {
  const prefs = {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    enableBlinkFeatures: '',
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    backgroundThrottling: false,    // parity with native preview
  };
  if (preloadPath) prefs.preload = preloadPath;
  return prefs;
}

/**
 * Decide whether a navigation attempt from inside an external-app BrowserView
 * should be allowed (true) or redirected to the system browser (false).
 *
 * Subdomain mode makes this gate cleanly host-based — the app's own
 * `<slug>.localhost(:port)` is the only legit destination. Different external
 * apps live on different subdomains (different origins per browser SOP), and
 * the OS8 main shell at bare localhost is also off-limits to external apps.
 *
 * @param {string} urlStr   the URL the navigation is targeting
 * @param {string} expectedHost  e.g. "worldmonitor.localhost"
 * @param {string|number} expectedPort  e.g. 8888
 * @returns {boolean} true to allow, false to deny + open externally
 */
function isAllowedExternalNavigation(urlStr, expectedHost, expectedPort) {
  let u;
  try { u = new URL(urlStr); }
  catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const portOk = !u.port || u.port === String(expectedPort);
  return u.hostname === expectedHost && portOk;
}

class PreviewService {
  /**
   * @param {object} opts
   * @param {object} opts.mainWindow - Electron BrowserWindow
   * @param {Map} opts.views - Shared views Map (appId → BrowserView)
   */
  constructor({ mainWindow, views }) {
    this._mainWindow = mainWindow;
    this._views = views;
    this._consoleBuffers = new Map();
  }

  // ── Console Buffer ──────────────────────────────

  pushConsoleMessage(appId, level, message, line, sourceId) {
    if (!this._consoleBuffers.has(appId)) {
      this._consoleBuffers.set(appId, []);
    }
    const buf = this._consoleBuffers.get(appId);
    buf.push({
      level: ['log', 'warning', 'error'][level] || 'log',
      message,
      line,
      sourceId,
      timestamp: new Date().toISOString()
    });
    if (buf.length > CONSOLE_BUFFER_MAX) {
      buf.splice(0, buf.length - CONSOLE_BUFFER_MAX);
    }
  }

  getConsoleBuffer(appId) {
    return this._consoleBuffers.get(appId) || [];
  }

  clearConsoleBuffer(appId) {
    this._consoleBuffers.delete(appId);
  }

  // ── View Lifecycle ──────────────────────────────

  create(appId) {
    if (this._views.has(appId)) {
      return this._views.get(appId);
    }

    const view = new BrowserView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
      },
    });

    this._mainWindow.addBrowserView(view);
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });

    // Sync zoom level with main window (handles case where user is already zoomed)
    const zoomFactor = this._mainWindow.webContents.getZoomFactor();
    if (zoomFactor !== 1) {
      view.webContents.setZoomFactor(zoomFactor);
    }

    // Pipe console logs from BrowserView to terminal for debugging + ring buffer
    view.webContents.on('console-message', (event, level, message, line, sourceId) => {
      const levelStr = ['LOG', 'WARN', 'ERROR'][level] || 'LOG';
      if (!sourceId.includes('node_modules')) {
        console.log(`[BrowserView:${appId}] ${levelStr}: ${message}`);
      }
      this.pushConsoleMessage(appId, level, message, line, sourceId);
    });

    // Track navigation
    let lastKnownUrl = '';

    const sendUrlChanged = (url) => {
      if (url && url !== lastKnownUrl) {
        lastKnownUrl = url;
        this._mainWindow.webContents.send('preview-url-changed', { appId, url });
      }
    };

    view.webContents.on('did-navigate', (event, url) => sendUrlChanged(url));
    view.webContents.on('did-navigate-in-page', (event, url) => sendUrlChanged(url));
    view.webContents.on('did-frame-navigate', (event, url, httpResponseCode, httpStatusText, isMainFrame) => {
      if (isMainFrame) sendUrlChanged(url);
    });

    view.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'mouseUp') {
        setTimeout(() => {
          try {
            const url = view.webContents.getURL();
            if (url !== lastKnownUrl) {
              lastKnownUrl = url;
              sendUrlChanged(url);
            }
          } catch (e) {}
        }, 100);
      }
    });

    this._views.set(appId, view);
    return view;
  }

  /**
   * Hardened BrowserView for an external app. Different from the native
   * `create()` — sandbox + contextIsolation + nav restriction + popup denial
   * + permission denial.
   *
   * @param {string} appId
   * @param {string} localSlug   the app's slug; used to compose the expected host
   * @param {{ os8Port: number, preloadPath?: string }} opts
   *   os8Port — the port OS8's HTTP server is on (used to validate Host)
   *   preloadPath — absolute path to preload-external-app.js (PR 1.9)
   */
  createExternal(appId, localSlug, { os8Port, preloadPath } = {}) {
    if (this._views.has(appId)) return this._views.get(appId);
    if (!localSlug) throw new Error('createExternal: localSlug required');
    if (!os8Port)   throw new Error('createExternal: os8Port required');

    const fs = require('fs');
    const resolvedPreload = preloadPath && fs.existsSync(preloadPath) ? preloadPath : null;

    const view = new BrowserView({
      webPreferences: externalWebPreferences(resolvedPreload),
    });

    this._mainWindow.addBrowserView(view);
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });

    // Sync zoom (parity with native preview).
    const zoomFactor = this._mainWindow.webContents.getZoomFactor();
    if (zoomFactor !== 1) view.webContents.setZoomFactor(zoomFactor);

    // Console pipe — same buffer/relay as native.
    view.webContents.on('console-message', (event, level, message, line, sourceId) => {
      const levelStr = ['LOG', 'WARN', 'ERROR'][level] || 'LOG';
      console.log(`[ExternalView:${appId}] ${levelStr}: ${message}`);
      this.pushConsoleMessage(appId, level, message, line, sourceId);
    });

    // ── Hardening ──────────────────────────────────────────────────────
    const expectedHost = `${localSlug}.localhost`;

    view.webContents.on('will-navigate', (event, urlStr) => {
      if (!isAllowedExternalNavigation(urlStr, expectedHost, os8Port)) {
        event.preventDefault();
        try { shell.openExternal(urlStr); } catch (_) { /* ignore */ }
      }
    });

    view.webContents.setWindowOpenHandler(({ url }) => {
      try { shell.openExternal(url); } catch (_) { /* ignore */ }
      return { action: 'deny' };
    });

    // Camera / mic / geolocation / notifications: deny by default. External
    // apps can request runtime escalation in v2 if a flow appears for it.
    try {
      view.webContents.session.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
      view.webContents.session.setPermissionCheckHandler(() => false);
    } catch (e) {
      console.warn('[Preview] failed to wire permission handlers:', e?.message);
    }

    this._views.set(appId, view);
    return view;
  }

  destroy(appId) {
    const view = this._views.get(appId);
    if (view) {
      this._mainWindow.removeBrowserView(view);
      view.webContents.destroy();
      this._views.delete(appId);
      return true;
    }
    return false;
  }

  destroyAll() {
    for (const [appId, view] of this._views) {
      try {
        if (view && !view.webContents.isDestroyed()) {
          this._mainWindow.removeBrowserView(view);
          view.webContents.destroy();
        }
      } catch (e) {
        console.log(`Preview cleanup: View ${appId} already destroyed`);
      }
    }
    this._views.clear();
  }

  // ── Navigation ──────────────────────────────────

  setUrl(appId, url) {
    const view = this._views.get(appId);
    if (view && url) {
      // Skip reload if already at this URL (preserves React state & SSE connections on tab switch)
      if (view.webContents.getURL() === url) return true;
      view.webContents.loadURL(url);
      return true;
    }
    return false;
  }

  getUrl(appId) {
    const view = this._views.get(appId);
    return view ? view.webContents.getURL() : null;
  }

  refresh(appId) {
    const view = this._views.get(appId);
    if (view) {
      view.webContents.reload();
      return true;
    }
    return false;
  }

  goBack(appId) {
    const view = this._views.get(appId);
    if (view && view.webContents.canGoBack()) {
      view.webContents.goBack();
      setTimeout(() => {
        try {
          const url = view.webContents.getURL();
          this._mainWindow.webContents.send('preview-url-changed', { appId, url });
        } catch (e) {}
      }, 100);
      return true;
    }
    return false;
  }

  goForward(appId) {
    const view = this._views.get(appId);
    if (view && view.webContents.canGoForward()) {
      view.webContents.goForward();
      setTimeout(() => {
        try {
          const url = view.webContents.getURL();
          this._mainWindow.webContents.send('preview-url-changed', { appId, url });
        } catch (e) {}
      }, 100);
      return true;
    }
    return false;
  }

  getNavState(appId) {
    const view = this._views.get(appId);
    if (!view) return { url: null, canGoBack: false, canGoForward: false };
    return {
      url: view.webContents.getURL(),
      canGoBack: view.webContents.canGoBack(),
      canGoForward: view.webContents.canGoForward()
    };
  }

  canGoBack(appId) {
    const view = this._views.get(appId);
    return view ? view.webContents.canGoBack() : false;
  }

  canGoForward(appId) {
    const view = this._views.get(appId);
    return view ? view.webContents.canGoForward() : false;
  }

  // ── Layout ──────────────────────────────────────

  setBounds(appId, bounds) {
    const view = this._views.get(appId);
    if (view && bounds) {
      view.setBounds({
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      });
      return true;
    }
    return false;
  }

  hide(appId) {
    const view = this._views.get(appId);
    if (view) {
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      return true;
    }
    return false;
  }

  hideAll() {
    for (const [appId, view] of this._views) {
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    }
    return true;
  }

  // ── Mode ────────────────────────────────────────

  async setMode(appId, mode) {
    const view = this._views.get(appId);
    if (view) {
      try {
        await view.webContents.executeJavaScript(`
          window.__OS8_MODE__ = '${mode}';
          window.dispatchEvent(new CustomEvent('os8-mode-change', { detail: { mode: '${mode}' } }));
        `);
        return true;
      } catch (e) {
        return false;
      }
    }
    return false;
  }

  async broadcastMode(mode) {
    const results = [];
    for (const [appId, view] of this._views) {
      try {
        await view.webContents.executeJavaScript(`
          window.__OS8_MODE__ = '${mode}';
          window.dispatchEvent(new CustomEvent('os8-mode-change', { detail: { mode: '${mode}' } }));
        `);
        results.push({ appId, success: true });
      } catch (e) {
        results.push({ appId, success: false });
      }
    }
    return results;
  }
}

module.exports = PreviewService;
module.exports.externalWebPreferences = externalWebPreferences;
module.exports.isAllowedExternalNavigation = isAllowedExternalNavigation;
