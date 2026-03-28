/**
 * PreviewService — BrowserView lifecycle, console buffer, navigation.
 *
 * Instance-based: holds views Map, console buffers, mainWindow ref.
 */

const { BrowserView } = require('electron');

const CONSOLE_BUFFER_MAX = 100;

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
