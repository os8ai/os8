/**
 * Scoped API surface — server-side capability enforcement for external apps.
 *
 * Spec §6.3.2 + plan §3 PR 1.7. External apps load at `<slug>.localhost:8888`
 * (their own browser origin) and call OS8 APIs via relative URLs at
 * `/_os8/api/...`. This middleware:
 *
 *   1. Resolves the slug from the Host header.
 *   2. Looks up the apps row (must be app_type='external').
 *   3. Maps the requested path + method to the required capability(s).
 *   4. Checks against the manifest's declared os8_capabilities — 403 if not.
 *   5. Injects X-OS8-App-Id / req.callerAppId so downstream routes know
 *      who's calling (PR 1.8's requireAppContext middleware reads this).
 *   6. Rewrites the URL to the internal /api/* path. Per-app routes
 *      (blob, db) get the appId in the path; shared routes do not.
 *
 * Cross-origin requests from `<slug>.localhost` to bare `localhost:8888/api/*`
 * are blocked by browser CORS without our cooperation. Same-origin requests
 * on the subdomain hit this middleware. Subdomain-but-non-API paths fall
 * through to ReverseProxyService.middleware() which proxies them to the
 * upstream dev server.
 *
 * Mounted in src/server.js by PR 1.7 — ahead of the reverse proxy so that
 * `/_os8/api/*` is intercepted before it would otherwise be forwarded to
 * the upstream Vite/Next/etc.
 */

const yaml = require('js-yaml');

const SUBDOMAIN_HOST_RE = /^([a-z][a-z0-9-]{1,39})\.localhost(?::\d+)?$/;
const SCOPED_PATH_RE    = /^\/_os8\/api(\/.*)?$/;

/**
 * Map a path under /_os8/api/... + HTTP method to the required capability(s).
 * Returns null for unknown paths (handled as 404). Returns an array of
 * acceptable capability names; the caller must declare AT LEAST ONE.
 */
function resolveCapability(apiPath, method) {
  const p = apiPath || '/';
  const m = (method || 'GET').toUpperCase();

  if (p === '/blob' || p.startsWith('/blob?') || p.startsWith('/blob/')) {
    return m === 'GET' ? ['blob.readonly', 'blob.readwrite'] : ['blob.readwrite'];
  }
  if (p === '/db/query'   || p.startsWith('/db/query?'))   return ['db.readonly', 'db.readwrite'];
  if (p === '/db/execute' || p.startsWith('/db/execute?')) return ['db.readwrite'];

  if (p.startsWith('/telegram/send')) return ['telegram.send'];
  if (p.startsWith('/imagegen'))      return ['imagegen'];
  if (p.startsWith('/speak'))         return ['speak'];
  if (p.startsWith('/youtube'))       return ['youtube'];
  if (p === '/x' || p.startsWith('/x/') || p.startsWith('/x?')) return ['x'];

  if (p.startsWith('/google/calendar')) {
    return m === 'GET'
      ? ['google.calendar.readonly', 'google.calendar.readwrite']
      : ['google.calendar.readwrite'];
  }
  if (p.startsWith('/google/drive'))   return ['google.drive.readonly'];
  if (p.startsWith('/google/gmail'))   return ['google.gmail.readonly'];

  // mcp.<server>.<tool> — also accepts a wildcard `mcp.<server>.*` declaration.
  const mcp = p.match(/^\/mcp\/([a-z0-9_-]+)\/([a-z0-9_-]+)/i);
  if (mcp) {
    const [, server, tool] = mcp;
    return [`mcp.${server.toLowerCase()}.${tool.toLowerCase()}`,
            `mcp.${server.toLowerCase()}.*`];
  }

  return null;
}

/**
 * Allow if the app's declared capabilities list contains at least one of the
 * required names (or, for MCP capabilities, a `mcp.<server>.*` wildcard
 * declaration scoped to the matching server).
 *
 * Wildcard semantics (PR 4.7): `mcp.<server>.*` grants ALL current and
 * future tools registered by `<server>`. The trust grant scopes to the
 * server itself — if the server registers a new tool tomorrow, the app
 * can call it without re-install. Catch-all forms `mcp.*.*`, `mcp.*`,
 * `mcp.<server>.*.<tool>` etc. are rejected at JSON-schema validation;
 * the runtime checker below is intentionally narrow to defend against
 * any that slip past validation.
 */
function isCapabilityAllowed(required, declared) {
  if (!Array.isArray(required) || required.length === 0) return false;
  if (!Array.isArray(declared)) return false;
  for (const r of required) {
    if (declared.includes(r)) return true;
    // MCP-only wildcard match: required `mcp.<server>.<tool>` against
    // declared `mcp.<server>.*`. Only one server per wildcard; no
    // cross-server fanout.
    const m = typeof r === 'string' ? r.match(/^mcp\.([^.]+)\.([^.]+)$/) : null;
    if (m) {
      const server = m[1];
      if (declared.includes(`mcp.${server}.*`)) return true;
    }
  }
  return false;
}

function scopedApiMiddleware(db) {
  return (req, res, next) => {
    // 1. Resolve slug from Host header. Bare localhost / IP / external host
    //    means this isn't a scoped-API request — let other middleware run.
    const host = (req.headers.host || '').toLowerCase();
    const hostMatch = host.match(SUBDOMAIN_HOST_RE);
    if (!hostMatch) return next();

    // 2. Only intercept paths under /_os8/api. Anything else on the subdomain
    //    is app traffic and will be proxied to the upstream by PR 1.13.
    const pathMatch = (req.path || req.url || '').match(SCOPED_PATH_RE);
    if (!pathMatch) return next();

    const localSlug = hostMatch[1];
    const apiPath   = pathMatch[1] || '/';

    const { AppService } = require('./app');
    const app = AppService.getBySlug(db, localSlug);
    if (!app) {
      return res.status(404).json({ error: 'app not found' });
    }
    if (app.app_type !== 'external') {
      return res.status(404).json({ error: 'not an external app' });
    }

    const required = resolveCapability(apiPath, req.method);
    if (!required) {
      return res.status(404).json({ error: 'unknown scoped api path', path: apiPath });
    }

    let manifest = {};
    try { manifest = yaml.load(app.manifest_yaml || '') || {}; }
    catch (_) { manifest = {}; }
    const declared = manifest.permissions?.os8_capabilities || [];

    if (!isCapabilityAllowed(required, declared)) {
      return res.status(403).json({
        error: 'capability not declared',
        required,
        declared,
      });
    }

    // Inject caller context. PR 1.8's requireAppContext reads
    // X-OS8-App-Id / req.callerAppId on the inner /api/* router.
    req.headers['x-os8-app-id'] = app.id;
    req.callerAppId = app.id;

    // Rewrite to the internal /api/* path. Per-app routes get the appId
    // baked into the path; shared routes do not.
    if (apiPath.startsWith('/blob') || apiPath.startsWith('/db')) {
      req.url = `/api/apps/${app.id}${apiPath}`;
    } else {
      req.url = `/api${apiPath}`;
    }
    return next();
  };
}

module.exports = {
  scopedApiMiddleware,
  resolveCapability,
  isCapabilityAllowed,
  SUBDOMAIN_HOST_RE,
  SCOPED_PATH_RE,
};
