/**
 * Migration 0.4.2 — per-mode TTS provider slots.
 *
 * Mirrors the agent_models(agent_id, mode) pattern: the TTS provider pick is
 * now scoped by ai_mode, so flipping the master Local-mode toggle doesn't
 * surface ElevenLabs under local mode (or Kokoro under cloud mode), and each
 * mode's pick is remembered when the user flips back.
 *
 * Backfill: read the legacy `tts_provider` setting, classify it via the
 * provider module's IS_LOCAL, and write it into tts_provider_local or
 * tts_provider_proprietary. The legacy row is cleared afterward so the
 * service layer stops falling through to it.
 *
 * Fresh installs already seed `tts_provider_local = 'kokoro'` (see
 * src/db/seeds.js) — this migration is strictly for upgraders.
 */

const TTSService = require('../services/tts');

module.exports = {
  version: '0.4.2',
  description: 'Split tts_provider into per-mode slots (tts_provider_local / tts_provider_proprietary)',

  async up({ db, logger }) {
    const legacyRow = db.prepare(`SELECT value FROM settings WHERE key = 'tts_provider'`).get();
    const legacy = legacyRow?.value || '';
    let migrated = false;

    if (!legacy) {
      logger.log('[0.4.2] No legacy tts_provider value — nothing to backfill');
    } else if (!TTSService.PROVIDERS[legacy]) {
      logger.log(`[0.4.2] Legacy tts_provider='${legacy}' is not a known provider — leaving it intact`);
    } else {
      const isLocal = TTSService.isLocalProvider(legacy);
      const targetKey = isLocal ? 'tts_provider_local' : 'tts_provider_proprietary';
      // INSERT OR REPLACE so we overwrite any seed value that was placed ahead
      // of an explicit user pick. The user's legacy choice wins.
      db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`)
        .run(targetKey, legacy);
      logger.log(`[0.4.2] Migrated tts_provider='${legacy}' → ${targetKey}`);
      migrated = true;
    }

    // Ensure both per-mode keys exist so SettingsService.get always returns a
    // sensible default ('' = None). INSERT OR IGNORE preserves any value that
    // the backfill just wrote.
    db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('tts_provider_local', '')`).run();
    db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('tts_provider_proprietary', '')`).run();

    // Clear the legacy key only when we successfully migrated it — avoids
    // wiping an unclassifiable user value that a later provider module might
    // support.
    if (migrated) {
      db.prepare(`UPDATE settings SET value = '' WHERE key = 'tts_provider'`).run();
      logger.log('[0.4.2] Cleared legacy tts_provider key');
    }
  }
};
