/**
 * Migration 0.3.1 — add `mode` column to routing_cascade for Phase 3 (LOCAL_MODELS_PHASE_3.md).
 *
 * SQLite can't alter a UNIQUE constraint in place, so we rebuild the
 * `routing_cascade` table with the new shape:
 *   - new column `mode TEXT NOT NULL DEFAULT 'proprietary'`
 *   - UNIQUE shifts from `(task_type, priority)` to `(task_type, mode, priority)`
 * All existing rows backfill with `mode = 'proprietary'` — the Phase-3 resolver
 * (lands in os8-3-2) reads `settings.ai_mode` and filters cascade rows by it.
 *
 * Also deletes the dormant `settings.local_models_enabled` row seeded by
 * Phase 1. Nothing reads it; `ai_mode` is the authoritative switch.
 *
 * The ai_model_families column additions (launcher_model, launcher_backend,
 * supports_vision) land via inline `try { ALTER } catch {}` in src/db/seeds.js
 * — idempotent across fresh installs and upgrades — so no ALTER here.
 */

module.exports = {
  version: '0.3.1',
  description: 'Add mode column to routing_cascade; drop dormant local_models_enabled flag',

  async up({ db, logger }) {
    // Detect whether the rebuild has already happened. If `mode` is already a
    // column, skip the rebuild — migrations are expected to be idempotent
    // under crash-resume, and a fresh install running `createSchema` in an
    // already-new shape then executing this migration could otherwise fail.
    const cols = db.prepare(`PRAGMA table_info(routing_cascade)`).all();
    const hasMode = cols.some(c => c.name === 'mode');

    if (!hasMode) {
      logger.log('[0.3.1] Rebuilding routing_cascade with mode column');
      const rebuild = db.transaction(() => {
        db.exec(`
          CREATE TABLE routing_cascade_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_type TEXT NOT NULL,
            priority INTEGER NOT NULL,
            family_id TEXT NOT NULL REFERENCES ai_model_families(id),
            access_method TEXT NOT NULL DEFAULT 'api',
            enabled INTEGER DEFAULT 1,
            is_auto_generated INTEGER DEFAULT 1,
            mode TEXT NOT NULL DEFAULT 'proprietary',
            UNIQUE(task_type, mode, priority)
          );
          INSERT INTO routing_cascade_new (id, task_type, priority, family_id, access_method, enabled, is_auto_generated, mode)
            SELECT id, task_type, priority, family_id, access_method, enabled, is_auto_generated, 'proprietary'
            FROM routing_cascade;
          DROP TABLE routing_cascade;
          ALTER TABLE routing_cascade_new RENAME TO routing_cascade;
        `);
      });
      rebuild();
      const rowCount = db.prepare(`SELECT COUNT(*) AS c FROM routing_cascade`).get().c;
      logger.log(`[0.3.1] routing_cascade rebuilt with ${rowCount} row(s), all under mode='proprietary'`);
    } else {
      logger.log('[0.3.1] routing_cascade already has mode column — skipping rebuild');
    }

    // Drop the dormant Phase-1 flag. Nothing reads it.
    const deleted = db.prepare(`DELETE FROM settings WHERE key = 'local_models_enabled'`).run();
    if (deleted.changes > 0) {
      logger.log('[0.3.1] Removed dormant settings.local_models_enabled');
    }
  }
};
