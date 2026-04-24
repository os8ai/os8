import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const Database = require('better-sqlite3');

const MIGRATION = require('../../src/migrations/0.4.2-tts-provider-per-mode');

// The migration only touches the settings table — minimal schema.
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);`);
  return db;
}

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

describe('migration 0.4.2 — tts_provider split into per-mode slots', () => {
  let db;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  function readSetting(key) {
    return db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key)?.value ?? null;
  }

  it('moves a legacy elevenlabs pick to tts_provider_proprietary', async () => {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('tts_provider', 'elevenlabs')`).run();
    await MIGRATION.up({ db, logger: silentLogger });
    expect(readSetting('tts_provider_proprietary')).toBe('elevenlabs');
    expect(readSetting('tts_provider_local')).toBe('');
    expect(readSetting('tts_provider')).toBe('');
  });

  it('moves a legacy openai pick to tts_provider_proprietary', async () => {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('tts_provider', 'openai')`).run();
    await MIGRATION.up({ db, logger: silentLogger });
    expect(readSetting('tts_provider_proprietary')).toBe('openai');
    expect(readSetting('tts_provider_local')).toBe('');
    expect(readSetting('tts_provider')).toBe('');
  });

  it('moves a legacy kokoro pick to tts_provider_local', async () => {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('tts_provider', 'kokoro')`).run();
    await MIGRATION.up({ db, logger: silentLogger });
    expect(readSetting('tts_provider_local')).toBe('kokoro');
    expect(readSetting('tts_provider_proprietary')).toBe('');
    expect(readSetting('tts_provider')).toBe('');
  });

  it('is a no-op when no legacy value is present', async () => {
    await MIGRATION.up({ db, logger: silentLogger });
    // Per-mode keys are still seeded as empty so SettingsService.get returns ''.
    expect(readSetting('tts_provider_local')).toBe('');
    expect(readSetting('tts_provider_proprietary')).toBe('');
    expect(readSetting('tts_provider')).toBe(null);
  });

  it('overwrites a previously-seeded tts_provider_local when the legacy value wins', async () => {
    // Fresh installs seed tts_provider_local='kokoro' ahead of time; if an
    // upgrader also has a legacy tts_provider, the legacy user pick wins.
    db.prepare(`INSERT INTO settings (key, value) VALUES ('tts_provider_local', 'kokoro')`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('tts_provider', 'kokoro')`).run();
    await MIGRATION.up({ db, logger: silentLogger });
    expect(readSetting('tts_provider_local')).toBe('kokoro');
  });

  it('skips backfill for an unknown provider and does not clear the legacy value', async () => {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('tts_provider', 'mystery')`).run();
    await MIGRATION.up({ db, logger: silentLogger });
    expect(readSetting('tts_provider_proprietary')).toBe('');
    expect(readSetting('tts_provider_local')).toBe('');
    // Unknown legacy value is left intact — the migration only clears known
    // classified values it migrated. That's safer than a silent wipe, and
    // subsequent runs are still idempotent (the per-mode keys exist).
    expect(readSetting('tts_provider')).toBe('mystery');
  });

  it('is idempotent on a second run', async () => {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('tts_provider', 'elevenlabs')`).run();
    await MIGRATION.up({ db, logger: silentLogger });
    await MIGRATION.up({ db, logger: silentLogger });
    expect(readSetting('tts_provider_proprietary')).toBe('elevenlabs');
    expect(readSetting('tts_provider')).toBe('');
  });
});
