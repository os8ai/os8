/**
 * Migration 0.3.0 — Phase 2 local-model schema + family seed.
 *
 * Adds the `launcher_backend` column on ai_model_families so
 * LauncherClient.ensureModel knows which backend kind (vllm, ollama,
 * comfyui, kokoro) to pass to `POST /api/serve/ensure`. Cloud families
 * keep the column NULL.
 *
 * Seeds three new local families — qwen3-coder-30b, kokoro-v1,
 * flux1-schnell — alongside the existing local-gemma-4-31b. These are
 * Phase-2 scaffolding only; Phase 3 wires them into routing cascades.
 * Narrow eligible_tasks prevents an agent-override pin from routing a
 * chat request to Kokoro, etc.
 *
 * Safe on DBs that already have the column (ALTER is caught) and on
 * fresh installs where schema.js creates the column directly — the
 * seed block then runs the UPDATEs idempotently.
 */

module.exports = {
  version: '0.3.0',
  description: 'Add launcher_backend column and seed Phase-2 local families',

  async up({ db, logger }) {
    // 1. Column (idempotent).
    try {
      db.exec('ALTER TABLE ai_model_families ADD COLUMN launcher_backend TEXT');
      logger.log('[0.3.0] Added launcher_backend column to ai_model_families');
    } catch (e) {
      if (/duplicate column/i.test(e.message)) {
        logger.log('[0.3.0] launcher_backend column already present');
      } else {
        throw e;
      }
    }

    // 2. New family rows. INSERT OR IGNORE — if seeds.js already ran on
    // a fresh install it will have added them; re-running is a no-op.
    const insertFamily = db.prepare(
      `INSERT OR IGNORE INTO ai_model_families
        (id, container_id, name, display_name, cli_model_arg, is_default, display_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const newRows = [
      ['local-qwen3-coder-30b', 'local', 'Qwen3-Coder-30B', 'Qwen3 Coder 30B (local)',  'qwen3-coder:30b', 0, 1],
      ['local-kokoro-v1',       'local', 'Kokoro v1',       'Kokoro v1 TTS (local)',    'kokoro-v1',       0, 2],
      ['local-flux1-schnell',   'local', 'Flux.1 Schnell',  'Flux.1 Schnell (local)',   'flux1-schnell',   0, 3],
    ];
    for (const row of newRows) insertFamily.run(...row);
    logger.log(`[0.3.0] Seeded ${newRows.length} Phase-2 local families`);

    // 3. Capability scores (UPDATE — unconditional so re-runs refresh).
    const caps = {
      'local-qwen3-coder-30b': { cost_tier: 1, cap_chat: 2, cap_jobs: 3, cap_planning: 2, cap_coding: 4, cap_summary: 2, cap_image: 0 },
      'local-kokoro-v1':       { cost_tier: 1, cap_chat: 0, cap_jobs: 0, cap_planning: 0, cap_coding: 0, cap_summary: 0, cap_image: 0 },
      'local-flux1-schnell':   { cost_tier: 1, cap_chat: 0, cap_jobs: 0, cap_planning: 0, cap_coding: 0, cap_summary: 0, cap_image: 4 },
    };
    const capStmt = db.prepare(
      `UPDATE ai_model_families
       SET cost_tier = ?, cap_chat = ?, cap_jobs = ?, cap_planning = ?,
           cap_coding = ?, cap_summary = ?, cap_image = ?
       WHERE id = ?`
    );
    for (const [id, c] of Object.entries(caps)) {
      capStmt.run(c.cost_tier, c.cap_chat, c.cap_jobs, c.cap_planning, c.cap_coding, c.cap_summary, c.cap_image, id);
    }

    // 4. Eligible-task restriction — stops a stray agent-override from
    // routing chat to Kokoro or image to Qwen.
    const eligibility = {
      'local-qwen3-coder-30b': 'coding,jobs',
      'local-kokoro-v1':       'tts',
      'local-flux1-schnell':   'image',
    };
    const eligStmt = db.prepare(`UPDATE ai_model_families SET eligible_tasks = ? WHERE id = ?`);
    for (const [id, tasks] of Object.entries(eligibility)) eligStmt.run(tasks, id);

    // 5. launcher_backend backfill — including the pre-existing
    // local-gemma-4-31b row whose column was created just now.
    const backends = {
      'local-gemma-4-31b':     'vllm',
      'local-qwen3-coder-30b': 'ollama',
      'local-kokoro-v1':       'kokoro',
      'local-flux1-schnell':   'comfyui',
    };
    const bkStmt = db.prepare(`UPDATE ai_model_families SET launcher_backend = ? WHERE id = ?`);
    for (const [id, kind] of Object.entries(backends)) bkStmt.run(kind, id);
    logger.log(`[0.3.0] launcher_backend backfilled on ${Object.keys(backends).length} local families`);
  },
};
