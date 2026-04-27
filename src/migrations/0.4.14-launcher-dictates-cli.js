/**
 * Migration 0.4.14 — marker for the launcher-dictates-CLI architectural shift.
 *
 * No DB changes. Documents the move:
 *
 *   Before 0.4.14: agents.local_cli column (added in 0.4.11) determined which
 *   CLI runtime spawned for local-mode chat turns; the build-proposal card had
 *   a CLI dropdown for per-build override.
 *
 *   As of 0.4.14: the launcher's per-model `recommended_client` field
 *   (config.yaml::models[*].recommended_client, surfaced via
 *   /api/triplet/roles) is the single source of truth for the CLI pairing.
 *   Cascade-2 → OpenHands; Qwen/AEON → OpenCode. Mixing isn't supported
 *   because the tool-call protocols (qwen3_coder vs <tool_call>/<tool_response>)
 *   differ enough that the wrong pairing silently produces broken tool use.
 *
 * Why a no-op migration: the version bump is what matters — it pins
 * /api/ai/local-status's response shape (now includes recommended_chat_client)
 * and ensures the migration runner records this version. The agents.local_cli
 * column stays in place (any user-set values become inert) to avoid a
 * destructive ALTER on an upgrade path.
 */

module.exports = {
  version: '0.4.14',
  description: 'Launcher dictates local-mode CLI runtime; agents.local_cli column kept inert',

  async up({ db, logger }) {
    logger.log('[0.4.14] Architectural shift: launcher recommended_client now dictates local-mode CLI. agents.local_cli is inert.');
  },
};
