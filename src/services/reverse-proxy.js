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

const _proxies = new Map();   // localSlug -> { appId, port }

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

const ReverseProxyService = {
  register(localSlug, appId, port) {
    _proxies.set(localSlug, { appId, port });
  },

  unregister(localSlug) {
    _proxies.delete(localSlug);
  },

  getPort(localSlug) {
    return _proxies.get(localSlug)?.port ?? null;
  },

  has(localSlug) {
    return _proxies.has(localSlug);
  },

  // Express middleware. Dispatches on Host header — bare localhost falls through
  // to the existing OS8 catch-all via next().
  middleware() {
    return (req, res, next) => {
      const entry = ReverseProxyService._resolveByHost(req);
      if (!entry) return next();
      _markHttpActive(entry.appId);
      proxy.web(req, res, { target: `http://127.0.0.1:${entry.port}` });
    };
  },

  // Wire `server.on('upgrade', ...)` for WebSocket pass-through. Without this,
  // Vite HMR / Next HMR / any WebSocket-based feature would fail at handshake.
  attachUpgradeHandler(server) {
    server.on('upgrade', (req, socket, head) => {
      const entry = ReverseProxyService._resolveByHost(req);
      if (!entry) {
        socket.destroy();
        return;
      }
      _markHttpActive(entry.appId);
      proxy.ws(req, socket, head, { target: `http://127.0.0.1:${entry.port}` });
    });
  },

  // Internal: look up a proxy entry from the request's Host header.
  // Exported as _resolveByHost so the test suite can exercise host parsing
  // without spinning up a real Express.
  _resolveByHost(req) {
    const host = (req.headers?.host || '').toLowerCase();
    const m = host.match(SUBDOMAIN_HOST_RE);
    if (!m) return null;
    return _proxies.get(m[1]) || null;
  },

  // Test-only: clear the registry. NOT exposed as part of the public API surface.
  _resetForTests() {
    _proxies.clear();
  },
};

module.exports = ReverseProxyService;
