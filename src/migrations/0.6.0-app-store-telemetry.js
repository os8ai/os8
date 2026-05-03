/**
 * Migration 0.6.0 — App Store v1.1: telemetry events queue + auto-update settings.
 *
 * Foundation for Phase 4:
 *   - PR 4.4 (per-adapter install telemetry emitter) writes to
 *     `app_telemetry_events` (offline-first queue, flushed in batches).
 *   - PR 4.2 (auto-update opt-in) reads/writes
 *     `app_store.auto_update.notify_on_apply`.
 *   - PR 4.6 (requireAppContext strict flip) reads `_internal_call_token`
 *     to authenticate in-process server→server calls (catalog scheduler etc.).
 *
 * Defaults respect spec §10 privacy posture:
 *   - `app_store.telemetry.opt_in` defaults to 'false'. The first-install
 *     consent moment in PR 4.4 surfaces it to the user before any event ships.
 *   - `app_store.telemetry.consent_shown` starts 'false' so the modal triggers
 *     once and only once.
 *   - `app_store.auto_update.notify_on_apply` defaults to 'true' (toast on
 *     auto-update apply per PR 4.2).
 *   - `_internal_call_token` is generated once with crypto-grade randomness
 *     and never overwritten; idempotent re-runs preserve the existing token.
 *
 * Idempotent: every CREATE uses IF NOT EXISTS; every settings seed checks
 * for an existing row before inserting, so user choices survive re-runs.
 */

const crypto = require('crypto');

module.exports = {
  version: '0.6.0',
  description: 'App Store v1.1: telemetry events queue + auto-update settings defaults',

  async up({ db, logger }) {
    // 1. Telemetry events queue — offline-first; AppTelemetry.flush drains
    //    in batches of 25 every ~60s, marks sent_at, and GCs sent>7d.
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_telemetry_events (
        id          TEXT PRIMARY KEY,
        kind        TEXT NOT NULL,
        payload     TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        sent_at     TEXT
      );
    `);

    // Partial index over pending rows keeps flush cheap even with a backlog.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_telemetry_events_pending
        ON app_telemetry_events(sent_at) WHERE sent_at IS NULL;
    `);

    // 2. Settings defaults — only seed if not already set, so user choices
    //    persist across migration re-runs and across upgrades.
    const seed = (key, value) => {
      const existing = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      if (!existing) {
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
      }
    };

    seed('app_store.telemetry.opt_in', 'false');
    seed('app_store.telemetry.consent_shown', 'false');
    seed('app_store.auto_update.notify_on_apply', 'true');

    // 3. Internal call token — supports PR 4.6's in-process trust mechanism
    //    (catalog scheduler, periodic health checks). Generated once;
    //    rotation is a deliberate operator action, not a migration concern.
    seed('_internal_call_token', crypto.randomBytes(32).toString('hex'));

    logger?.log?.('[0.6.0] telemetry queue + auto-update defaults applied');
  }
};
