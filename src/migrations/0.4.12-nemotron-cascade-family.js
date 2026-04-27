/**
 * Migration 0.4.12 — register the Nemotron-Cascade 2 30B-A3B family.
 *
 * Adds a third local-chat family backed by os8-launcher's
 * `nemotron-cascade-2` model (community NVFP4 quant). Mirrors the AEON-7
 * registration in 0.4.7-aeon7-family.js.
 *
 * Without this row, RoutingService._resolveLocalChatFamily falls back to
 * the first chat-capable local family by display_order (qwen3-6-35b-a3b)
 * whenever the launcher's chat-role chooser points at Cascade-2 — which
 * causes the launcher to try loading Qwen3.6 on top of an already-resident
 * triplet and trip BUDGET_EXCEEDED on every digest tick.
 *
 * Idempotent: INSERT OR IGNORE + always-overwrite UPDATE for caps and
 * launcher metadata, mirroring the seed-time setup in src/db/seeds.js.
 */

module.exports = {
  version: '0.4.12',
  description: 'Add local-nemotron-cascade-2 family for launcher chat-role chooser',

  async up({ db, logger }) {
    const id = 'local-nemotron-cascade-2';

    const insertResult = db.prepare(
      `INSERT OR IGNORE INTO ai_model_families
       (id, container_id, name, display_name, cli_model_arg, is_default, display_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, 'local',
      'Nemotron-Cascade 2',
      'NVIDIA Nemotron-Cascade 2 30B-A3B (local, math/coding)',
      'nemotron-cascade-2', 0, 7,
    );

    db.prepare(
      `UPDATE ai_model_families
       SET cost_tier = ?, cap_chat = ?, cap_jobs = ?, cap_planning = ?,
           cap_coding = ?, cap_summary = ?, cap_image = ?,
           eligible_tasks = ?, launcher_model = ?, launcher_backend = ?,
           supports_vision = ?
       WHERE id = ?`
    ).run(
      1, 4, 4, 4, 5, 3, 0,
      'conversation,summary,planning,coding,jobs',
      'nemotron-cascade-2', 'vllm', 0,
      id,
    );

    if (insertResult.changes) {
      logger.log(`[0.4.12] Registered family ${id}`);
    } else {
      logger.log(`[0.4.12] Family ${id} already present; refreshed metadata`);
    }
  },
};
