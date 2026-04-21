/**
 * Migration 0.3.2 — seed the local half of routing_cascade (Phase 3 §4.2).
 *
 * os8-3-1 rebuilt `routing_cascade` with the `mode` column and backfilled
 * every pre-existing row as `mode='proprietary'`. The local half was left
 * empty because the os8-3-1 resolver only knew how to generate proprietary
 * cascades. os8-3-2 makes `generateCascade` mode-aware; this migration
 * calls it with `mode='local'` to populate the missing rows for every task
 * type, so a user flipping `ai_mode` to 'local' has a working cascade from
 * first request onward.
 *
 * Idempotent: short-circuits if any local rows already exist. A downstream
 * `regenerateAll` or a manual `DELETE FROM routing_cascade WHERE mode='local'`
 * + re-run of this migration will rebuild the local half correctly.
 */

module.exports = {
  version: '0.3.2',
  description: 'Seed local half of routing_cascade (mode=local rows)',

  async up({ db, logger }) {
    const hasLocal = db.prepare(`SELECT COUNT(*) AS c FROM routing_cascade WHERE mode = 'local'`).get().c;
    if (hasLocal > 0) {
      logger.log(`[0.3.2] routing_cascade already has ${hasLocal} local row(s) — skipping seed`);
      return;
    }

    const RoutingService = require('../services/routing');
    const insert = db.prepare(
      `INSERT INTO routing_cascade (task_type, priority, family_id, access_method, enabled, is_auto_generated, mode)
       VALUES (?, ?, ?, ?, 1, 1, 'local')`
    );

    const seedLocal = db.transaction(() => {
      for (const taskType of RoutingService.TASK_TYPES) {
        const cascade = RoutingService.generateCascade(db, taskType, 'local');
        cascade.forEach((entry, idx) => {
          insert.run(taskType, idx, entry.family_id, entry.access_method);
        });
      }
    });
    seedLocal();

    const count = db.prepare(`SELECT COUNT(*) AS c FROM routing_cascade WHERE mode = 'local'`).get().c;
    logger.log(`[0.3.2] Seeded ${count} local cascade row(s) across ${RoutingService.TASK_TYPES.length} task type(s)`);
  }
};
