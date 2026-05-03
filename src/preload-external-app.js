/**
 * Preload script for external-app BrowserViews.
 *
 * Spec §6.3.3 + plan §3 PR 1.9. Loaded by PreviewService.createExternal
 * (PR 1.19). Reads the manifest's `permissions.os8_capabilities` via a
 * one-shot IPC handshake, then exposes `window.os8` with only the methods
 * the app declared a capability for. Calling a missing method throws
 * locally; calling a declared method that's misused (e.g. blob.write with
 * only blob.readonly) gets a structured 403 from PR 1.7's
 * scopedApiMiddleware.
 *
 * The page's origin is `<slug>.localhost:8888` (subdomain), so all SDK
 * fetches are relative URLs that the browser sends same-origin to the
 * scoped API surface at `/_os8/api/...`.
 */

const { contextBridge, ipcRenderer } = require('electron');

(async () => {
  try {
    const params = new URLSearchParams(window.location.search);
    const appId = params.get('__os8_app_id');
    if (!appId) {
      contextBridge.exposeInMainWorld('os8', Object.freeze({}));
      return;
    }

    // Strip the app-id param so user code doesn't see it via window.location.
    params.delete('__os8_app_id');
    const newSearch = params.toString();
    try {
      history.replaceState(
        null, '',
        window.location.pathname +
          (newSearch ? '?' + newSearch : '') +
          window.location.hash
      );
    } catch (_) { /* sandboxed BrowserViews allow this; defensive */ }

    let resp;
    try {
      resp = await ipcRenderer.invoke('app-store:get-manifest-for-preload', appId);
    } catch (e) {
      console.warn('[os8-preload] manifest fetch failed:', e?.message);
      contextBridge.exposeInMainWorld('os8', Object.freeze({}));
      return;
    }
    if (!resp?.ok) {
      contextBridge.exposeInMainWorld('os8', Object.freeze({}));
      return;
    }

    const capabilities = Array.isArray(resp.capabilities) ? resp.capabilities : [];
    const sdk = buildSdk(capabilities);
    contextBridge.exposeInMainWorld('os8', Object.freeze(sdk));
  } catch (e) {
    console.warn('[os8-preload] init crashed:', e?.message);
    try { contextBridge.exposeInMainWorld('os8', Object.freeze({})); } catch (_) {}
  }
})();

/**
 * Build the SDK surface from a manifest's declared capabilities.
 *
 * Capability check supports MCP wildcards (PR 4.7): a declared
 * `mcp.<server>.*` permits any `mcp.<server>.<tool>` request — and any
 * tool the server registers in the future. Mirrors scopedApiMiddleware's
 * `isCapabilityAllowed` so the SDK and the server agree on what's
 * granted.
 *
 * Exported for unit tests via `module.exports.buildSdk` — Electron's
 * preload module wrapper still resolves require/exports.
 */
function buildSdk(capabilities) {
  const apiBase = '/_os8/api';
  const has = (cap) => {
    if (capabilities.includes(cap)) return true;
    const m = typeof cap === 'string' ? cap.match(/^mcp\.([^.]+)\.([^.]+)$/) : null;
    if (m) {
      const server = m[1];
      if (capabilities.includes(`mcp.${server}.*`)) return true;
    }
    return false;
  };

  async function rejectIfNotOk(res) {
    if (!res.ok) {
      let body = null;
      try { body = await res.json(); } catch (_) { /* leave null */ }
      const err = new Error(body?.error || `os8 SDK call failed: ${res.status}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return res;
  }

  function fetchJson(url, init = {}) {
    return fetch(url, init).then(rejectIfNotOk).then(r => r.json());
  }
  function fetchVoid(url, init = {}) {
    return fetch(url, init).then(rejectIfNotOk).then(() => undefined);
  }
  function postJson(url, body) {
    return fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  function makeRestWrapper(base) {
    return {
      get:  (subpath = '', query) => fetchJson(
        `${base}${subpath}${query ? '?' + new URLSearchParams(query) : ''}`),
      post: (subpath, body) => postJson(`${base}${subpath || ''}`, body),
    };
  }

  const sdk = {};

  // Blob storage.
  if (has('blob.readonly') || has('blob.readwrite')) {
    sdk.blob = {
      read: (key) =>
        fetch(`${apiBase}/blob/${encodeURIComponent(key)}`)
          .then(rejectIfNotOk)
          .then(r => r.blob()),
      list: (prefix = '') =>
        fetchJson(`${apiBase}/blob?prefix=${encodeURIComponent(prefix)}`),
    };
    if (has('blob.readwrite')) {
      sdk.blob.write = (key, data) =>
        fetchVoid(`${apiBase}/blob/${encodeURIComponent(key)}`, { method: 'PUT', body: data });
      sdk.blob.delete = (key) =>
        fetchVoid(`${apiBase}/blob/${encodeURIComponent(key)}`, { method: 'DELETE' });
    }
  }

  // Per-app DB.
  if (has('db.readonly') || has('db.readwrite')) {
    sdk.db = {
      query: (sql, params = []) =>
        postJson(`${apiBase}/db/query`, { sql, params }),
    };
    if (has('db.readwrite')) {
      sdk.db.execute = (sql, params = []) =>
        postJson(`${apiBase}/db/execute`, { sql, params });
    }
  }

  // Shared services.
  if (has('imagegen')) sdk.imagegen = makeRestWrapper(`${apiBase}/imagegen`);
  if (has('speak'))    sdk.speak    = makeRestWrapper(`${apiBase}/speak`);
  if (has('youtube'))  sdk.youtube  = makeRestWrapper(`${apiBase}/youtube`);
  if (has('x'))        sdk.x        = makeRestWrapper(`${apiBase}/x`);

  if (has('telegram.send')) {
    sdk.telegram = {
      send: (body) => postJson(`${apiBase}/telegram/send`, body),
    };
  }

  if (has('google.calendar.readonly') || has('google.calendar.readwrite')) {
    sdk.googleCalendar = makeRestWrapper(`${apiBase}/google/calendar`);
  }
  if (has('google.drive.readonly')) sdk.googleDrive = makeRestWrapper(`${apiBase}/google/drive`);
  if (has('google.gmail.readonly')) sdk.googleGmail = makeRestWrapper(`${apiBase}/google/gmail`);

  // MCP — present whenever any mcp.* capability is declared. Server-side
  // scopedApiMiddleware enforces the per-server.tool gate.
  if (capabilities.some(c => c.startsWith('mcp.'))) {
    sdk.mcp = (server, tool, body) =>
      postJson(`${apiBase}/mcp/${encodeURIComponent(server)}/${encodeURIComponent(tool)}`, body);
  }

  return sdk;
}

// Expose `buildSdk` for unit tests. The preload script runs only inside an
// Electron renderer; tests import the module from Node and invoke buildSdk
// directly with a synthetic capabilities list.
module.exports = { buildSdk };
