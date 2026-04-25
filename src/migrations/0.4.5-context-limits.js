/**
 * Migration 0.4.5 — per-mode agent memory context limits.
 *
 * Seeds two `settings` rows that gate how many tokens of identity + memory +
 * conversation history get packed into each agent prompt. One value for local
 * models (must stay below the launcher's max-model-len), one for proprietary
 * models (Claude/Gemini/GPT/Grok have generous windows so 200K is safe).
 *
 * Why a setting and not a per-family table: every local family today shares
 * the same launcher pool, and the user-facing UI surfaces a single number per
 * mode. If a future install grows multiple local families with different
 * windows we can layer a per-family override on top without breaking this.
 */

module.exports = {
  version: '0.4.5',
  description: 'Seed per-mode agent memory context limits (local=60000, proprietary=200000)',

  async up({ db, logger }) {
    const seed = db.prepare(
      'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
    );
    const propResult = seed.run('context_limit_proprietary_tokens', '200000');
    const localResult = seed.run('context_limit_local_tokens', '60000');

    const seeded = [];
    if (propResult.changes) seeded.push('proprietary=200000');
    if (localResult.changes) seeded.push('local=60000');

    if (seeded.length > 0) {
      logger.log(`[0.4.5] Seeded context limits: ${seeded.join(', ')}`);
    } else {
      logger.log('[0.4.5] Context limit settings already present');
    }
  }
};
