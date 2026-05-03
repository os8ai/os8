/**
 * requireAppContext — read X-OS8-App-Id and surface it on req.callerAppId.
 *
 * Spec §6.3 + plan §10 Q1 / Q9. PR 1.7's scopedApiMiddleware sets
 * X-OS8-App-Id when an external app's request authorizes against its
 * declared os8_capabilities. This middleware propagates the header onto
 * a typed `req.callerAppId` field — handler code uses it to scope outputs
 * (per-app blob storage, per-app SQLite, per-app Telegram, etc.).
 *
 * Phase 4 PR 4.6 — STRICT MODE flip:
 *   - Header path: X-OS8-App-Id present → req.callerAppId set; pass.
 *   - Origin path: bare-localhost (host = 'localhost' or '127.0.0.1' on
 *     the OS8 port) → trusted (this is the OS8 shell + native React apps).
 *   - In-process path: X-OS8-Internal-Token matches the server's
 *     `_internal_call_token` (set in settings at startup; mirrored to
 *     process.env.OS8_INTERNAL_CALL_TOKEN by main.js for the middleware
 *     to read) → trusted (this is the catalog scheduler + periodic
 *     health-check call sites).
 *   - Otherwise → 403.
 *
 * Rollback escape hatch: set OS8_REQUIRE_APP_CONTEXT_PERMISSIVE=1 in
 * the environment to revert to v1 behavior (header optional). The user
 * can use this if a yet-unidentified consumer breaks; the CHANGELOG
 * documents how.
 *
 * Diagnostic: set OS8_DEBUG=1 in the environment to see every rejected
 * request logged with origin + path. Useful for spotting consumers that
 * need migration after the flip.
 */

function isPermissiveMode() {
  return process.env.OS8_REQUIRE_APP_CONTEXT_PERMISSIVE === '1';
}

function isDebugMode() {
  return process.env.OS8_DEBUG === '1';
}

function getOs8Port() {
  const raw = Number(process.env.OS8_PORT || 8888);
  return Number.isFinite(raw) && raw > 0 ? raw : 8888;
}

function getInternalCallToken() {
  return process.env.OS8_INTERNAL_CALL_TOKEN || '';
}

/**
 * Origin allowlist: bare-localhost / 127.0.0.1 on the OS8 port.
 *
 *   localhost:8888                → trusted (shell + native React apps)
 *   127.0.0.1:8888                → trusted (same as above)
 *   <slug>.localhost:8888         → NOT trusted (external app subdomain)
 *   attacker.example              → NOT trusted
 *
 * `Origin` is set by the browser on cross-origin and POST/PUT/DELETE
 * requests. `Referer` is set on most navigations + fetches. We accept
 * either as the trust signal — same-origin GETs may have neither, but
 * those are caught by the no-origin path which falls through to the
 * internal-token check.
 */
function originIsTrusted(originRaw) {
  if (!originRaw) return false;
  let url;
  try { url = new URL(originRaw); }
  catch { return false; }
  const trustedHosts = new Set(['localhost', '127.0.0.1']);
  if (!trustedHosts.has(url.hostname)) return false;
  if (Number(url.port) !== getOs8Port()) return false;
  return true;
}

function requireAppContext(req, res, next) {
  // Header path — explicit caller identity always wins.
  const headerAppId = req.headers['x-os8-app-id'];
  if (headerAppId) {
    req.callerAppId = headerAppId;
    return next();
  }

  // Permissive escape hatch (v1 behavior).
  if (isPermissiveMode()) {
    return next();
  }

  // Origin-based allowlist — shell + native React apps.
  const origin = req.headers.origin || req.headers.referer || '';
  if (originIsTrusted(origin)) {
    return next();
  }

  // In-process internal-token path — for server→server fetches that
  // can't (or shouldn't) go through the scoped API surface.
  const internalToken = getInternalCallToken();
  if (internalToken && req.headers['x-os8-internal-token'] === internalToken) {
    return next();
  }

  if (isDebugMode()) {
    console.warn(
      `[require-app-context] reject ${req.method} ${req.path} ` +
      `origin=${origin || '(none)'} ua=${(req.headers['user-agent'] || '').slice(0, 40)}`
    );
  }
  return res.status(403).json({
    error: 'this API requires app context — call via window.os8.* SDK or set X-OS8-App-Id',
  });
}

module.exports = requireAppContext;
// Test seam — exposed for unit tests so they can poke the predicates.
module.exports.originIsTrusted = originIsTrusted;
module.exports.isPermissiveMode = isPermissiveMode;
