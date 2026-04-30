/**
 * Sanitized environment builder for external-app processes.
 *
 * Spec §6.3.1 + plan §3 PR 1.10. External app processes do NOT inherit
 * `process.env` wholesale and do NOT see global `env_variables`. The runtime
 * adapter (PR 1.11) calls `buildSanitizedEnv` and passes the result to
 * `child_process.spawn(..., { env })`.
 *
 * The merge order is load-bearing: OS8-injected wins the final spread, so
 * a malicious manifest cannot spoof OS8 identity by declaring an env entry
 * named `OS8_APP_ID` (or similar). Spec §6.3.1's described order has
 * OS8-injected before secrets — same intent, just spelled out at the
 * implementation layer.
 *
 *   1. Whitelisted host env (PATH, HOME, …).
 *   2. Manifest `env:` (non-secret defaults).
 *   3. Per-app declared secrets (manifest.permissions.secrets[].name → value).
 *   4. OS8-injected (always wins).
 *
 * Cross-platform whitelists keep unrelated host secrets out — API keys,
 * OAuth tokens, OS8_HOME, npm_config_*, etc. are never inherited.
 */

const path = require('path');
const { APPS_DIR, BLOB_DIR } = require('../config');
const EnvService = require('./env');

const POSIX_WHITELIST = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ', 'USER', 'LC_ALL', 'LC_CTYPE'];

const WINDOWS_WHITELIST = [
  'PATH', 'HOMEDRIVE', 'HOMEPATH', 'USERPROFILE',
  'TEMP', 'TMP', 'USERNAME', 'COMPUTERNAME',
  'SYSTEMROOT', 'WINDIR', 'PATHEXT',
];

function pickHostEnv() {
  const list = process.platform === 'win32' ? WINDOWS_WHITELIST : POSIX_WHITELIST;
  const out = {};
  for (const k of list) {
    if (process.env[k] !== undefined) out[k] = process.env[k];
  }
  return out;
}

/**
 * @param {object} db better-sqlite3 handle
 * @param {object} opts
 * @param {string} opts.appId — required; becomes OS8_APP_ID and looks up app_env_variables
 * @param {number} opts.allocatedPort — port assigned by AppProcessRegistry (PR 1.12)
 * @param {Array<{name:string, value:string}>} [opts.manifestEnv] — manifest.env array
 * @param {string} opts.localSlug — used to compose OS8_API_BASE
 * @param {number} opts.OS8_PORT — the OS8 main HTTP port
 * @returns {Object<string,string>}
 */
function buildSanitizedEnv(db, {
  appId, allocatedPort, manifestEnv = [], localSlug, OS8_PORT,
}) {
  if (!appId) throw new Error('buildSanitizedEnv: appId is required');
  if (!localSlug) throw new Error('buildSanitizedEnv: localSlug is required');
  if (!OS8_PORT) throw new Error('buildSanitizedEnv: OS8_PORT is required');
  if (typeof allocatedPort !== 'number') {
    throw new Error('buildSanitizedEnv: allocatedPort is required');
  }

  const hostEnv     = pickHostEnv();
  const manifestObj = Object.fromEntries((manifestEnv || []).map(e => [e.name, e.value]));
  const secretsObj  = EnvService.getAllForApp(db, appId);
  const os8Injected = {
    OS8_APP_ID:    appId,
    OS8_APP_DIR:   path.join(APPS_DIR, appId),
    OS8_BLOB_DIR:  path.join(BLOB_DIR, appId),
    OS8_BASE_URL:  `http://localhost:${OS8_PORT}`,
    OS8_API_BASE:  `http://${localSlug}.localhost:${OS8_PORT}/_os8/api`,
    PORT:          String(allocatedPort),
  };

  return {
    ...hostEnv,
    ...manifestObj,
    ...secretsObj,
    ...os8Injected,    // OS8-injected always wins; defends against name spoofing
  };
}

module.exports = {
  buildSanitizedEnv,
  pickHostEnv,
  POSIX_WHITELIST,
  WINDOWS_WHITELIST,
};
