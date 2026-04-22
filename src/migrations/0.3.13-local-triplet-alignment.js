/**
 * Migration 0.3.13 — align local family seeds to the v2 triplet.
 *
 * LOCAL_MODELS_PLAN.md v2 (2026-04-21) collapses the Phase-3 many-local-
 * families approach into three opinionated slots: qwen3-6-35b-a3b for
 * chat (all text tasks + vision), flux1-kontext-dev for image
 * (reference-conditioned), kokoro-v1 for voice.
 *
 * This migration:
 *   1. Adds the `local-flux1-kontext-dev` family row (not seeded before
 *      Phase 3 only had flux1-schnell).
 *   2. Widens `local-qwen3-6-35b-a3b`'s eligible_tasks to cover every
 *      text task + its existing vision support, so it wins cascades
 *      for conversation, summary, planning, coding, and jobs under
 *      ai_mode='local'.
 *   3. Zeros out caps on the local families we're no longer using
 *      (gemma-4-31b, gemma-4-e2b, qwen3-coder-30b, qwen3-coder-next,
 *      flux1-schnell). Rows stay in place for rollback safety; they
 *      just never win a cascade pick because cap=0 short-circuits
 *      generateCascade.
 *   4. Regenerates the local cascade so the new winners take effect.
 *
 * Idempotent: INSERT OR IGNORE on the new family, UPDATEs use WHERE
 * guards against the old values so re-running the migration is safe.
 */

module.exports = {
  version: '0.3.13',
  description: 'Align local family seeds to v2 triplet (qwen3.6 / kontext / kokoro)',

  async up({ db, logger }) {
    const steps = [];

    // --- 1. Add flux1-kontext-dev family row.
    const existingKontext = db.prepare(`SELECT id FROM ai_model_families WHERE id = 'local-flux1-kontext-dev'`).get();
    if (!existingKontext) {
      db.prepare(`
        INSERT INTO ai_model_families (
          id, container_id, name, display_name, cli_model_arg,
          cost_tier, cap_chat, cap_jobs, cap_planning, cap_coding, cap_summary, cap_image,
          eligible_tasks, display_order, launcher_model, launcher_backend, supports_vision
        ) VALUES (
          'local-flux1-kontext-dev', 'local', 'Flux.1-Kontext', 'Flux.1 Kontext (local, reference-conditioned)',
          'flux1-kontext-dev',
          1, 0, 0, 0, 0, 0, 4,
          'image', 9, 'flux1-kontext-dev', 'comfyui', 0
        )
      `).run();
      steps.push('added local-flux1-kontext-dev family');
    }

    // --- 2. Widen qwen3-6-35b-a3b's eligible_tasks + bump caps for text tasks.
    // The chat slot in the v2 triplet carries all text workloads.
    const widenedQwen = db.prepare(`
      UPDATE ai_model_families
      SET eligible_tasks = 'conversation,summary,planning,coding,jobs',
          cap_chat = 4,
          cap_jobs = 3,
          cap_planning = 3,
          cap_coding = 3,
          cap_summary = 3
      WHERE id = 'local-qwen3-6-35b-a3b'
    `).run();
    if (widenedQwen.changes > 0) {
      steps.push('widened local-qwen3-6-35b-a3b eligible_tasks + bumped caps');
    }

    // --- 3. Zero out caps on the local families not in the v2 triplet.
    // Rows stay in place for rollback safety; zero caps mean generateCascade
    // short-circuits them out of the cascade automatically.
    const retired = [
      'local-gemma-4-31b',
      'local-gemma-4-e2b',
      'local-qwen3-coder-30b',
      'local-qwen3-coder-next',
      'local-flux1-schnell'
    ];
    const zeroOut = db.prepare(`
      UPDATE ai_model_families
      SET cap_chat = 0, cap_jobs = 0, cap_planning = 0, cap_coding = 0, cap_summary = 0, cap_image = 0,
          eligible_tasks = ''
      WHERE id = ?
    `);
    let retiredCount = 0;
    for (const id of retired) {
      const result = zeroOut.run(id);
      if (result.changes > 0) retiredCount++;
    }
    if (retiredCount > 0) steps.push(`zeroed caps on ${retiredCount} retired local families`);

    // --- 4. Regenerate local cascade so the new winners take effect.
    // Delete only the auto-generated local rows; preserve any manual
    // reorderings under mode='local' (is_auto_generated=0).
    db.prepare(`DELETE FROM routing_cascade WHERE mode = 'local' AND is_auto_generated = 1`).run();

    // Use RoutingService to regenerate — matches the fresh-install behavior.
    const RoutingService = require('../services/routing');
    const regen = db.transaction(() => {
      const insert = db.prepare(
        `INSERT INTO routing_cascade (task_type, priority, family_id, access_method, enabled, is_auto_generated, mode)
         VALUES (?, ?, ?, ?, 1, 1, 'local')`
      );
      for (const taskType of RoutingService.TASK_TYPES) {
        const cascade = RoutingService.generateCascade(db, taskType, 'local');
        cascade.forEach((entry, idx) => {
          insert.run(taskType, idx, entry.family_id, entry.access_method);
        });
      }
    });
    regen();
    const localCount = db.prepare(`SELECT COUNT(*) AS c FROM routing_cascade WHERE mode = 'local' AND is_auto_generated = 1`).get().c;
    steps.push(`regenerated ${localCount} local cascade row(s)`);

    logger.log(`[0.3.13] ${steps.join('; ')}`);
  }
};
