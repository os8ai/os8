/**
 * Migration 0.4.13 — register OpenHands as a terminal container + surface
 * the local CLIs (and Grok) in their respective mode dropdowns.
 *
 * Three coordinated changes for the terminal dropdown UX:
 *   1. INSERT the `openhands` row into ai_containers (parallel to opencode).
 *   2. Flip show_in_terminal = 1 for opencode + openhands so they appear in
 *      the terminal dropdown when ai_mode='local'. Pre-0.4.13 they were
 *      hidden behind the launcher dashboard.
 *   3. Flip show_in_terminal = 1 for grok so it appears in the terminal
 *      dropdown when ai_mode='proprietary' (was hidden by historical oversight).
 *
 * Idempotent: INSERT OR IGNORE + always-overwrite UPDATE. Mirrors the
 * seed-time setup in src/db/seeds.js.
 */

module.exports = {
  version: '0.4.13',
  description: 'Register OpenHands container + surface opencode/openhands/grok in terminal dropdown',

  async up({ db, logger }) {
    const insertResult = db.prepare(
      `INSERT OR IGNORE INTO ai_containers
       (id, provider_id, type, name, command, instruction_file,
        has_login, login_command, api_key_aliases, auth_status_command,
        auth_file_path, login_trigger_args, display_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'openhands', 'local', 'cli', 'OpenHands', 'openhands', 'AGENTS.md',
      0, null, '[]', null, null, null, 6,
    );

    // Always-overwrite metadata refresh for the openhands row, in case a
    // hand-rolled INSERT (e.g. a power user's earlier manual SQL) seeded it
    // with stale values.
    db.prepare(
      `UPDATE ai_containers
       SET provider_id = 'local', type = 'cli', name = 'OpenHands',
           command = 'openhands', instruction_file = 'AGENTS.md',
           display_order = 6
       WHERE id = 'openhands'`
    ).run();

    // Surface the local CLIs (used in ai_mode='local') and grok (proprietary mode).
    db.prepare(
      `UPDATE ai_containers SET show_in_terminal = 1
       WHERE id IN ('opencode', 'openhands', 'grok')`
    ).run();

    if (insertResult.changes) {
      logger.log('[0.4.13] Inserted ai_containers row for openhands; show_in_terminal=1 for opencode/openhands/grok');
    } else {
      logger.log('[0.4.13] openhands row already present; refreshed metadata + show_in_terminal=1 for opencode/openhands/grok');
    }
  },
};
