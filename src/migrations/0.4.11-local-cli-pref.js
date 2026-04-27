/**
 * Migration 0.4.11 — add per-agent local-mode CLI pin.
 *
 * Under ai_mode='local', OS8 historically hardcoded OpenCode as the only CLI
 * runtime that paired with launcher-served chat models (qwen3.6-35b, AEON-Gemma).
 * This migration introduces a column on the agents table so each agent can
 * pin a different runtime — currently 'opencode' (default) or 'openhands'
 * (the new path that pairs with NVIDIA's Nemotron-Cascade 2 30B-A3B).
 *
 * The build proposal flow also reads this — when the user picks a CLI in
 * the build approval dropdown, that override threads through to
 * RoutingService.resolve(opts.localCli) for the duration of the build,
 * but the agent's stored value is the default for chat turns.
 *
 * Idempotent: the column is also added in seeds.js (additive ALTER inside
 * a try/catch) so fresh installs don't need this migration. This file
 * exists only to drive the version bump for upgraders.
 */

module.exports = {
  version: '0.4.11',
  description: 'Add agents.local_cli column + seed cli_overhead_openhands_tokens setting',

  async up({ db, logger }) {
    let added = false;
    try {
      db.exec("ALTER TABLE agents ADD COLUMN local_cli TEXT DEFAULT 'opencode'");
      added = true;
    } catch (e) {
      // Column already exists (e.g. seeds.js ran first on a fresh install)
      if (!/duplicate column/i.test(e.message)) throw e;
    }

    if (added) {
      logger.log('[0.4.11] Added agents.local_cli column (default opencode)');
    } else {
      logger.log('[0.4.11] agents.local_cli already present (idempotent re-run)');
    }

    // Seed openhands CLI-overhead reservation. Mirrors the 0.4.10 pattern.
    // 18000 is conservative — slightly higher than opencode (15000) because
    // OpenHands ships a security-analyzer system prompt by default and its
    // tool schemas are larger. Adjust in Settings → AI Models if telemetry
    // shows a different number for your workload.
    const seed = db.prepare(
      'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
    );
    const result = seed.run('cli_overhead_openhands_tokens', '18000');
    if (result.changes) {
      logger.log('[0.4.11] Seeded cli_overhead_openhands_tokens=18000');
    }
  }
};
