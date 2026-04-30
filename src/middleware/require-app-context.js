/**
 * requireAppContext — read X-OS8-App-Id and surface it on req.callerAppId
 * for downstream route handlers.
 *
 * Spec §6.3 + plan §10 Q1 / Q9. PR 1.7's scopedApiMiddleware sets
 * X-OS8-App-Id when an external app's request authorizes against its
 * declared os8_capabilities. This middleware just propagates the header
 * onto a typed `req.callerAppId` field — handler code uses it to scope
 * outputs (per-app blob storage, per-app SQLite, per-app Telegram etc.).
 *
 * **Permissive in v1** (plan §10 decision matches §11.1): native shell + native
 * React apps remain trusted code and call /api/* without the header. The
 * day a native app needs per-app scoping, flip the constant below to
 * require the header.
 *
 * Intended mount points (11 routers per plan §10 Q9):
 *   app-blob, app-db, imagegen, speak, youtube, x, telegram, google, mcp
 *   (voicemessage and transcribe defer to a follow-up — they don't surface
 *    via window.os8 in v1)
 *
 * NOT mounted on shell APIs (27 routes): system, apps (CRUD), agents,
 * assistant, voice, plans, vault, tasks, jobs, etc. — those are trusted.
 */

// v1: header is optional. Set this to `true` when a native app surface
// needs per-app scoping; the rollout is plan §10 decision 1.
const REQUIRE_HEADER_STRICT = false;

function requireAppContext(req, res, next) {
  const headerAppId = req.headers['x-os8-app-id'];
  if (headerAppId) {
    req.callerAppId = headerAppId;
  } else if (REQUIRE_HEADER_STRICT) {
    return res.status(401).json({ error: 'X-OS8-App-Id required' });
  }
  next();
}

module.exports = requireAppContext;
