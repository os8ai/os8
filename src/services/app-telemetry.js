/**
 * AppTelemetry — Phase 4 PR 4.4.
 *
 * Anonymous, opt-in install telemetry. Events queue in
 * `app_telemetry_events` (migration 0.6.0); flush ships them to
 * `https://os8.ai/api/apps/telemetry` (PR 4.5) in batches of 25 every
 * ~60s while pending events exist.
 *
 * Privacy contract — non-negotiable:
 *   - Opt-in via `app_store.telemetry.opt_in` setting; default 'false'.
 *     The first-install consent moment in install-plan-modal flips it
 *     once to whatever the user accepts.
 *   - Random UUID client id at `~/os8/.telemetry/client-id`; can be
 *     rotated by the user via Settings → Reset Client ID. The server
 *     re-hashes it with HMAC + secret salt (PR 4.5).
 *   - Sanitizer is allowlist-based: only known keys make it onto the
 *     wire. A future contributor adding `userEmail` to the event object
 *     can't leak it through.
 *   - Failure fingerprints are SHA-256 prefixes of the last error line
 *     after stripping numerics + path separators. Never raw lines.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { OS8_DIR } = require('../config');
const SettingsService = require('./settings');

const TELEMETRY_DIR = path.join(OS8_DIR, '.telemetry');
const CLIENT_ID_PATH = path.join(TELEMETRY_DIR, 'client-id');
const TELEMETRY_ENDPOINT = process.env.OS8_TELEMETRY_ENDPOINT || 'https://os8.ai/api/apps/telemetry';
const TELEMETRY_BATCH_SIZE = 25;
const TELEMETRY_FLUSH_INTERVAL_MS = 60_000;
const TELEMETRY_SENT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d
const TELEMETRY_OPT_IN_KEY = 'app_store.telemetry.opt_in';

// Hard allowlist for sanitization. Any key not in this set is dropped
// at write time so an over-zealous future contributor can't leak.
//
// Phase 5 PR 5.4 added `conflictFileCount` for the new
// `update_conflict` and `update_conflict_resolved` kinds — a small
// numeric so the curator dashboard can surface "what % of auto-updates
// conflict" without exposing per-file paths.
const ALLOWED_FIELDS = new Set([
  'kind', 'adapter', 'framework', 'channel', 'slug', 'commit',
  'failurePhase', 'failureFingerprint', 'durationMs',
  'os', 'arch', 'overrideReason',
  'conflictFileCount',
]);

let _flushTimer = null;
let _flushInFlight = false;

function ensureTelemetryDir() {
  try { fs.mkdirSync(TELEMETRY_DIR, { recursive: true }); }
  catch (_) { /* may not exist; readers handle absent file */ }
}

function getClientId() {
  ensureTelemetryDir();
  if (fs.existsSync(CLIENT_ID_PATH)) {
    try {
      const cur = fs.readFileSync(CLIENT_ID_PATH, 'utf8').trim();
      if (cur) return cur;
    } catch (_) { /* fall through to regenerate */ }
  }
  const id = crypto.randomUUID();
  try { fs.writeFileSync(CLIENT_ID_PATH, id, { mode: 0o600 }); }
  catch (_) { /* writes are best-effort; flush still works */ }
  return id;
}

function rotateClientId() {
  ensureTelemetryDir();
  const id = crypto.randomUUID();
  try { fs.writeFileSync(CLIENT_ID_PATH, id, { mode: 0o600 }); }
  catch (_) { /* best-effort */ }
  return id;
}

function isEnabled(db) {
  try {
    const v = SettingsService.get(db, TELEMETRY_OPT_IN_KEY);
    return v === 'true' || v === true;
  } catch (_) {
    return false;
  }
}

/**
 * Strip numerics + path separators from an error line and SHA-256 the
 * first 256 chars; return the first 16 hex chars. Identical errors
 * across users hash to the same value (clusters in the dashboard);
 * raw line is never persisted or sent.
 */
function fingerprintFailure(line) {
  if (!line) return '';
  const normalized = String(line).replace(/[\d/\\]/g, '').slice(0, 256);
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Apply the allowlist to an event payload. Drops unknown keys; pins
 * os/arch to the runtime values regardless of caller input.
 */
function sanitize(event) {
  const out = {};
  for (const k of Object.keys(event || {})) {
    if (ALLOWED_FIELDS.has(k) && event[k] !== undefined && event[k] !== null) {
      out[k] = event[k];
    }
  }
  // Always derive os/arch from the runtime so a caller can't spoof.
  out.os = process.platform;
  out.arch = process.arch;
  return out;
}

/**
 * Enqueue an event. No-op when opt-in is off. Schedules the first
 * pending flush via setTimeout (unref'd).
 */
function enqueue(db, event) {
  if (!isEnabled(db)) return;

  const sanitized = sanitize(event);
  if (!sanitized.kind) return;

  const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    db.prepare(`
      INSERT INTO app_telemetry_events (id, kind, payload, created_at, sent_at)
      VALUES (?, ?, ?, ?, NULL)
    `).run(id, sanitized.kind, JSON.stringify(sanitized), new Date().toISOString());
  } catch (e) {
    // Migration 0.6.0 creates the table; tests / pre-migrate state may
    // be missing it. Drop silently rather than disrupting the install.
    return;
  }

  scheduleFlush(db);
}

function scheduleFlush(db) {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    flush(db).catch(() => { /* errors handled inside flush */ });
  }, TELEMETRY_FLUSH_INTERVAL_MS);
  if (typeof _flushTimer.unref === 'function') _flushTimer.unref();
}

/**
 * Drain up to TELEMETRY_BATCH_SIZE pending events to the ingest
 * endpoint. Marks sent_at on success; leaves rows unsent on HTTP /
 * network failure for the next cycle. Honors opt-out at flush time
 * (toggling off mid-batch deletes pending so nothing re-attempts).
 */
async function flush(db) {
  if (_flushInFlight) return { sent: 0, dropped: 0 };
  _flushInFlight = true;
  try {
    if (!isEnabled(db)) {
      // Opt-out flips drop pending events so a re-enable doesn't ship
      // pre-consent activity.
      const r = db.prepare(`DELETE FROM app_telemetry_events WHERE sent_at IS NULL`).run();
      return { sent: 0, dropped: r.changes };
    }

    const rows = db.prepare(`
      SELECT id, payload FROM app_telemetry_events
       WHERE sent_at IS NULL
       ORDER BY created_at ASC
       LIMIT ?
    `).all(TELEMETRY_BATCH_SIZE);
    if (rows.length === 0) return { sent: 0, dropped: 0 };

    let events;
    try {
      events = rows.map(r => JSON.parse(r.payload));
    } catch (_) {
      // Corrupted row(s); best response is to mark sent so we don't
      // retry forever.
      const ids = rows.map(r => r.id);
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(
        `UPDATE app_telemetry_events SET sent_at = ? WHERE id IN (${placeholders})`
      ).run(new Date().toISOString(), ...ids);
      return { sent: 0, dropped: rows.length };
    }

    const clientId = getClientId();
    let response;
    try {
      response = await fetch(TELEMETRY_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, events, ts: Date.now() }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (_) {
      // Network error — leave rows unsent; next cycle retries.
      return { sent: 0, dropped: 0, network: 'failed' };
    }

    if (!response.ok) {
      // 4xx/5xx — leave unsent; the rate limiter will quiet retries
      // since the same hashed clientId hits the limit.
      return { sent: 0, dropped: 0, status: response.status };
    }

    const ids = rows.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(
      `UPDATE app_telemetry_events SET sent_at = ? WHERE id IN (${placeholders})`
    ).run(new Date().toISOString(), ...ids);

    // Garbage-collect rows older than the retention window. Cheap and
    // keeps the table from growing unboundedly between user uninstalls.
    const cutoff = new Date(Date.now() - TELEMETRY_SENT_TTL_MS).toISOString();
    db.prepare(
      `DELETE FROM app_telemetry_events WHERE sent_at IS NOT NULL AND sent_at < ?`
    ).run(cutoff);

    // If more pending exist, re-schedule.
    const remaining = db.prepare(
      `SELECT COUNT(*) AS c FROM app_telemetry_events WHERE sent_at IS NULL`
    ).get();
    if (remaining.c > 0) scheduleFlush(db);

    return { sent: rows.length, dropped: 0 };
  } finally {
    _flushInFlight = false;
  }
}

module.exports = {
  // Public API
  isEnabled,
  enqueue,
  flush,
  getClientId,
  rotateClientId,
  fingerprintFailure,
  sanitize,
  // Constants exposed for tests / callers needing canonical values.
  TELEMETRY_ENDPOINT,
  TELEMETRY_BATCH_SIZE,
  TELEMETRY_FLUSH_INTERVAL_MS,
  TELEMETRY_OPT_IN_KEY,
  ALLOWED_FIELDS,
  // Test seam — flush timer state.
  _resetFlushTimer() {
    if (_flushTimer) clearTimeout(_flushTimer);
    _flushTimer = null;
    _flushInFlight = false;
  },
};
