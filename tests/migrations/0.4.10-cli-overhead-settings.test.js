import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const Database = require('better-sqlite3');

const MIGRATION = require('../../src/migrations/0.4.10-cli-overhead-settings');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);`);
  return db;
}

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

const ALL_KEYS = [
  'cli_overhead_opencode_tokens',
  'cli_overhead_claude_tokens',
  'cli_overhead_gemini_tokens',
  'cli_overhead_codex_tokens',
  'cli_overhead_grok_tokens'
];

const DEFAULTS = {
  cli_overhead_opencode_tokens: '15000',
  cli_overhead_claude_tokens:   '20000',
  cli_overhead_gemini_tokens:   '15000',
  cli_overhead_codex_tokens:    '20000',
  cli_overhead_grok_tokens:     '15000'
};

describe('migration 0.4.10 — seed CLI overhead defaults', () => {
  let db;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  function readSetting(key) {
    return db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key)?.value ?? null;
  }

  it('seeds all five backends with their default values when none exist', async () => {
    await MIGRATION.up({ db, logger: silentLogger });
    for (const key of ALL_KEYS) {
      expect(readSetting(key)).toBe(DEFAULTS[key]);
    }
  });

  it('preserves user-customized values (INSERT OR IGNORE)', async () => {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('cli_overhead_opencode_tokens', '12345')`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('cli_overhead_claude_tokens', '99999')`).run();
    await MIGRATION.up({ db, logger: silentLogger });
    expect(readSetting('cli_overhead_opencode_tokens')).toBe('12345');
    expect(readSetting('cli_overhead_claude_tokens')).toBe('99999');
    // Untouched keys still get their defaults.
    expect(readSetting('cli_overhead_gemini_tokens')).toBe(DEFAULTS.cli_overhead_gemini_tokens);
    expect(readSetting('cli_overhead_codex_tokens')).toBe(DEFAULTS.cli_overhead_codex_tokens);
    expect(readSetting('cli_overhead_grok_tokens')).toBe(DEFAULTS.cli_overhead_grok_tokens);
  });

  it('is idempotent — running twice produces the same state with no duplicates', async () => {
    await MIGRATION.up({ db, logger: silentLogger });
    await MIGRATION.up({ db, logger: silentLogger });
    for (const key of ALL_KEYS) {
      expect(readSetting(key)).toBe(DEFAULTS[key]);
    }
    const count = db.prepare(`
      SELECT COUNT(*) AS c FROM settings WHERE key LIKE 'cli_overhead_%'
    `).get().c;
    expect(count).toBe(ALL_KEYS.length);
  });

  it('does not touch unrelated settings keys', async () => {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('context_limit_local_tokens', '60000')`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('ai_mode', 'local')`).run();
    await MIGRATION.up({ db, logger: silentLogger });
    expect(readSetting('context_limit_local_tokens')).toBe('60000');
    expect(readSetting('ai_mode')).toBe('local');
  });

  it('declares version 0.4.10 and a description', () => {
    expect(MIGRATION.version).toBe('0.4.10');
    expect(typeof MIGRATION.description).toBe('string');
    expect(MIGRATION.description.length).toBeGreaterThan(0);
  });
});
