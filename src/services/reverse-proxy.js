/**
 * ReverseProxyService — subdomain-only HTTP + WebSocket reverse proxy.
 *
 * Spec §1, §6.2.3, §6.4. Plan §10 decision 11 (subdomain mode is the v1
 * default and only routing mode).
 *
 * Each external app is served at <slug>.localhost:8888 — its own browser
 * origin, so cookies / localStorage / IndexedDB / service-workers /
 * permission grants are isolated by the browser's same-origin policy.
 *
 * `middleware()` mounts ahead of OS8's catch-all. Native traffic on bare
 * `localhost:8888` falls through unchanged via next(); only requests whose
 * Host matches `<slug>.localhost(:port)` are diverted to the upstream
 * dev server. Path stays unchanged because the framework binds at /.
 *
 * `attachUpgradeHandler(server)` wires WebSocket upgrades — load-bearing
 * for HMR (Vite, Next, etc.). PR 1.14 is the gating smoke test that
 * proves this end-to-end.
 *
 * No mounting happens here — PR 1.15 wires this into src/server.js.
 */

const httpProxy = require('http-proxy');
const express = require('express');

// changeOrigin: false preserves Host so the upstream sees `<slug>.localhost:8888`.
// Most modern frameworks accept this without further config; the runtime adapter
// (PR 1.11) injects --allowedHosts=.localhost when a framework needs an explicit list.
//
// xfwd: true sets X-Forwarded-* headers so the upstream knows it's behind a proxy.
const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true, changeOrigin: false });

// Surface upstream errors as 502 — the OS8 main process must not crash because
// an external app's dev server is down.
proxy.on('error', (err, req, res) => {
  console.warn('[ReverseProxy] upstream error:', err.message);
  if (res && !res.headersSent && typeof res.writeHead === 'function') {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'upstream unavailable', detail: err.message }));
  } else if (res && typeof res.destroy === 'function') {
    // Upgrade socket in error path — destroy quietly.
    res.destroy();
  }
});

const _proxies = new Map();         // localSlug -> { appId, port }
const _staticServers = new Map();   // localSlug -> { appId, appDir, handler }

// Match `<slug>.localhost` or `<slug>.localhost:<port>`. The slug regex matches
// the manifest's slug rule (spec §3.4) — first char a-z, then a-z0-9-, 2-40 long.
const SUBDOMAIN_HOST_RE = /^([a-z][a-z0-9-]{1,39})\.localhost(?::\d+)?$/;

function _markHttpActive(appId) {
  // PR 1.12 (app-process-registry) wires lifecycle. The registry may not exist
  // yet (we are gated behind the PR-1.13-first build order) or may be uninitialized
  // — treat both as no-op so the proxy keeps working in isolation.
  try {
    const APR = require('./app-process-registry');
    const inst = typeof APR.get === 'function' ? APR.get() : null;
    inst?.markHttpActive(appId);
  } catch (_) { /* registry not available — acceptable in isolation */ }
}

// Diagnostic logging hook. Off by default to keep logs quiet in normal use.
// Flip to `true` to trace register/unregister + per-request middleware
// dispatch when debugging external-app routing issues. Originally added
// during the Phase 3 smoke (PRs #14/19) — diagnosed PRs #18 (middleware
// order) and #20 (externalUrl in restoreTabState) by isolating that the
// proxy was correctly registered but receiving no subdomain requests.
const DEBUG = false;
function dbg(...args) { if (DEBUG) console.log('[ReverseProxy]', ...args); }

const ReverseProxyService = {
  register(localSlug, appId, port) {
    _proxies.set(localSlug, { appId, port });
    dbg(`register slug="${localSlug}" → appId=${appId} port=${port} | _proxies.size=${_proxies.size}`);
  },

  // PR 2.3 — static-mode bypass. Mounts `express.static(appDir)` for the
  // app's subdomain. The trust boundary stays the browser origin; the
  // "bypass" is that OS8 serves the bytes itself rather than proxying to
  // a separate dev server.
  registerStatic(localSlug, appId, appDir) {
    const handler = express.static(appDir, {
      fallthrough: false,                 // 404 from THIS app, not from OS8
      index: ['index.html', 'index.htm'],
      dotfiles: 'deny',                   // never serve .env, .git, etc.
      setHeaders: (res) => {
        // Treat as own-origin; don't cache aggressively at dev time.
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      },
    });
    _staticServers.set(localSlug, { appId, appDir, handler });
    dbg(`registerStatic slug="${localSlug}" → appId=${appId} dir=${appDir} | _staticServers.size=${_staticServers.size}`);
  },

  unregister(localSlug) {
    const had = _proxies.has(localSlug) || _staticServers.has(localSlug);
    _proxies.delete(localSlug);
    _staticServers.delete(localSlug);
    dbg(`unregister slug="${localSlug}" hadEntry=${had}`);
  },

  unregisterStatic(localSlug) {
    _staticServers.delete(localSlug);
  },

  getPort(localSlug) {
    return _proxies.get(localSlug)?.port ?? null;
  },

  getStaticDir(localSlug) {
    return _staticServers.get(localSlug)?.appDir ?? null;
  },

  has(localSlug) {
    return _proxies.has(localSlug) || _staticServers.has(localSlug);
  },

  // Express middleware. Dispatches on Host header — bare localhost falls through
  // to the existing OS8 catch-all via next(). Static-served apps win over
  // proxied entries (registration races shouldn't happen in practice — the
  // install pipeline writes one or the other — but the order is documented).
  middleware() {
    return (req, res, next) => {
      const host = req.headers?.host || '(no host)';
      const slug = ReverseProxyService._slugFromHost(req);

      // PR 3.14/3.16 — log EVERY request reaching the proxy middleware so
      // we can see exactly what Host header (if any) Chromium is sending
      // for external-app traffic. Skip our own /api and /shared/avatars
      // noise so the log is readable.
      const url = req.url || '';
      const isOs8Internal =
        url.startsWith('/api/') ||
        url.startsWith('/shared/') ||
        url.startsWith('/avatars/') ||
        url.startsWith('/oauth/');
      if (!isOs8Internal) {
        const staticHit = slug ? _staticServers.has(slug) : false;
        const proxyHit  = slug ? _proxies.has(slug) : false;
        dbg(
          `middleware host="${host}" url="${url}"`,
          `extractedSlug="${slug || '(none)'}"`,
          `staticHit=${staticHit} proxyHit=${proxyHit}`,
          `_proxies=[${[..._proxies.keys()].join(',') || '(empty)'}]`
        );
      }

      if (!slug) return next();

      const staticEntry = _staticServers.get(slug);
      if (staticEntry) {
        _markHttpActive(staticEntry.appId);
        return staticEntry.handler(req, res, next);
      }

      const proxyEntry = _proxies.get(slug);
      if (!proxyEntry) {
        dbg(`fallthrough — no entry for slug="${slug}", known=[${[..._proxies.keys()].join(',')}]`);
        return next();
      }
      dbg(`proxying slug="${slug}" → 127.0.0.1:${proxyEntry.port} appId=${proxyEntry.appId}`);
      _markHttpActive(proxyEntry.appId);
      proxy.web(req, res, { target: `http://127.0.0.1:${proxyEntry.port}` });
    };
  },

  // Wire `server.on('upgrade', ...)` for WebSocket pass-through. Without this,
  // Vite HMR / Next HMR / any WebSocket-based feature would fail at handshake.
  // Returns early when the Host doesn't match a registered slug so other
  // upgrade handlers (voice-stream, tts-stream, call-stream) can claim the
  // connection. Same convention voice-stream.js:30-35 follows.
  //
  // Static-served apps don't ship WebSockets (no dev server). If a static
  // app's page tries to open a WS, we destroy the socket cleanly — manifest
  // LLM review (PR 2.1's extension) flags `framework_mismatch` for that case.
  attachUpgradeHandler(server) {
    server.on('upgrade', (req, socket, head) => {
      const slug = ReverseProxyService._slugFromHost(req);
      if (!slug) return;       // not ours — let another listener handle it

      if (_staticServers.has(slug)) {
        try { socket.destroy(); } catch (_) { /* already closed */ }
        return;
      }

      const entry = _proxies.get(slug);
      if (!entry) return;
      _markHttpActive(entry.appId);
      proxy.ws(req, socket, head, { target: `http://127.0.0.1:${entry.port}` });
    });
  },

  // Internal: look up a slug from the request's Host header.
  _slugFromHost(req) {
    const host = (req.headers?.host || '').toLowerCase();
    const m = host.match(SUBDOMAIN_HOST_RE);
    if (!m) return null;
    return m[1];
  },

  // Back-compat: pre-PR-2.3 callers used _resolveByHost to fetch the proxy
  // entry directly. Keep returning the proxy entry only (static entries
  // expose a different shape and would break callers).
  _resolveByHost(req) {
    const slug = ReverseProxyService._slugFromHost(req);
    if (!slug) return null;
    return _proxies.get(slug) || null;
  },

  // Test-only: clear the registry. NOT exposed as part of the public API surface.
  _resetForTests() {
    _proxies.clear();
    _staticServers.clear();
  },
};

module.exports = ReverseProxyService;
