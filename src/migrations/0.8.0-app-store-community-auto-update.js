/**
 * Migration 0.8.0 — App Store v1.3: per-channel auto-update defaults.
 *
 * Foundation for Phase 6 PR 6.1:
 *   - `AppService.createExternal` reads `app_store.auto_update.<channel>_default`
 *     to set the new app's `auto_update` column on install.
 *   - `AppAutoUpdater.listEligible` widens to include Community channel apps
 *     whose `auto_update = 1`.
 *
 * Asymmetric defaults:
 *   - `app_store.auto_update.verified_default` defaults to 'false'. Verified
 *     apps are curated and low-churn; the per-app flyout toggle stays opt-in
 *     to preserve the "user is final authority" posture from PR 4.2.
 *   - `app_store.auto_update.community_default` defaults to 'true'. Community
 *     apps churn more, so 'forget about it' UX matters more there. PR 5.4's
 *     three-way merge UI catches the conflict case if the user has edited the
 *     app locally — same path as Verified.
 *
 * Phase 5 plan §7 §20 originally recommended Community default OFF for
 * symmetry; Leo overrode 2026-05-04 in favor of the asymmetric model.
 *
 * Existing app rows are NOT touched. Users who already installed Community
 * apps before this migration keep their current `auto_update` column value;
 * the per-app flyout toggle (now interactive for Community) lets them flip
 * it whenever they want.
 *
 * Idempotent: settings seeds use SELECT-then-INSERT (mirror PR 4.11 / 5.10)
 * so user choices made before the migration ran (or made between re-runs)
 * survive.
 */

module.exports = {
  version: '0.8.0',
  description: 'App Store v1.3: per-channel auto-update defaults (Verified opt-in / Community opt-out)',

  async up({ db, logger }) {
    const seed = (key, value) => {
      const existing = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      if (!existing) {
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
      }
    };

    seed('app_store.auto_update.verified_default',  'false');
    seed('app_store.auto_update.community_default', 'true');

    logger?.log?.('[0.8.0] per-channel auto-update defaults seeded (verified=false, community=true)');
  }
};
