/**
 * Migration 0.4.7 — register the AEON-7 Gemma 4 26B family.
 *
 * Adds a second local-chat family backed by os8-launcher's
 * `aeon-7-gemma-4-26b` model so users can swap chat backends from the
 * launcher's triplet chooser without OS8 needing a code change.
 *
 * Idempotent: INSERT OR IGNORE + always-overwrite UPDATE for caps and
 * launcher metadata, mirroring the seed-time setup in src/db/seeds.js.
 */

module.exports = {
  version: '0.4.7',
  description: 'Add local-aeon-7-gemma-4-26b family for launcher chat-role chooser',

  async up({ db, logger }) {
    const id = 'local-aeon-7-gemma-4-26b';

    const insertResult = db.prepare(
      `INSERT OR IGNORE INTO ai_model_families
       (id, container_id, name, display_name, cli_model_arg, is_default, display_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, 'local',
      'AEON-7 Gemma-4-26B',
      'AEON-7 Gemma 4 26B (local, uncensored)',
      'aeon-7-gemma-4-26b', 0, 7,
    );

    db.prepare(
      `UPDATE ai_model_families
       SET cost_tier = ?, cap_chat = ?, cap_jobs = ?, cap_planning = ?,
           cap_coding = ?, cap_summary = ?, cap_image = ?,
           eligible_tasks = ?, launcher_model = ?, launcher_backend = ?,
           supports_vision = ?
       WHERE id = ?`
    ).run(
      1, 4, 3, 3, 3, 3, 0,
      'conversation,summary,planning,coding,jobs',
      'aeon-7-gemma-4-26b', 'vllm', 0,
      id,
    );

    if (insertResult.changes) {
      logger.log(`[0.4.7] Registered family ${id}`);
    } else {
      logger.log(`[0.4.7] Family ${id} already present; refreshed metadata`);
    }
  },
};
