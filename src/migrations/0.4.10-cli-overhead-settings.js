/**
 * Migration 0.4.10 — seed per-CLI overhead reservations.
 *
 * The CLI agent runtimes (opencode, claude, gemini, codex, grok) eat a chunk
 * of the model's input window for their own request envelope: system prompt,
 * tool schemas, and any auto-loaded instruction file (AGENTS.md / CLAUDE.md).
 * `getEffectiveContextBudget` in src/services/context-limits.js subtracts
 * this overhead from the user-configured Memory Context Limit so OS8 doesn't
 * pack so much identity+memory that the request overflows once the CLI's
 * envelope is added on top.
 *
 * Phase 1 (0.4.9) hardcoded the values in code. This migration promotes them
 * to user-editable settings — the Settings → AI Models panel surfaces a row
 * per CLI so power users can tune the reservation when telemetry shows their
 * environment differs from the defaults.
 *
 * Default values (in tokens):
 *   - opencode: 15000  (telemetry on AEON-7 + Gemma showed real overhead ≈12K
 *                       once `limit.context` is set; 15K leaves a small buffer)
 *   - claude:   20000
 *   - gemini:   15000
 *   - codex:    20000
 *   - grok:     15000
 *
 * INSERT OR IGNORE keeps the migration idempotent — a re-run never overwrites
 * a value the user (or a prior run) already wrote.
 */

module.exports = {
  version: '0.4.10',
  description: 'Seed per-CLI overhead reservations (opencode/claude/gemini/codex/grok)',

  async up({ db, logger }) {
    const seed = db.prepare(
      'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
    );
    const defaults = {
      cli_overhead_opencode_tokens: '15000',
      cli_overhead_claude_tokens:   '20000',
      cli_overhead_gemini_tokens:   '15000',
      cli_overhead_codex_tokens:    '20000',
      cli_overhead_grok_tokens:     '15000'
    };

    const seeded = [];
    for (const [key, value] of Object.entries(defaults)) {
      const result = seed.run(key, value);
      if (result.changes) seeded.push(`${key.replace(/^cli_overhead_|_tokens$/g, '')}=${value}`);
    }

    if (seeded.length > 0) {
      logger.log(`[0.4.10] Seeded CLI overhead defaults: ${seeded.join(', ')}`);
    } else {
      logger.log('[0.4.10] CLI overhead settings already present (idempotent re-run)');
    }
  }
};
