import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const Database = require('better-sqlite3');

// Module-under-test loaded after vitest is up so we can fresh-require
// to avoid stale require.cache entries between describe blocks.
function freshContextLimits() {
  delete require.cache[require.resolve('../../src/services/context-limits')];
  delete require.cache[require.resolve('../../src/services/settings')];
  delete require.cache[require.resolve('../../src/services/ai-registry')];
  return require('../../src/services/context-limits');
}

// --- Test harness -----------------------------------------------------------

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);

    CREATE TABLE ai_containers (
      id TEXT PRIMARY KEY,
      provider_id TEXT,
      name TEXT,
      type TEXT,
      has_login INTEGER DEFAULT 0,
      display_order INTEGER DEFAULT 0
    );
    INSERT INTO ai_containers (id, provider_id, name, type, has_login, display_order) VALUES
      ('claude', 'anthropic', 'Claude', 'cli',  1, 0),
      ('local',  'local',     'Local',  'http', 0, 1);

    CREATE TABLE ai_providers (id TEXT PRIMARY KEY, name TEXT, api_key_env TEXT);
    INSERT INTO ai_providers VALUES
      ('anthropic', 'Anthropic', 'ANTHROPIC_API_KEY'),
      ('local',     'Local',     NULL);

    CREATE TABLE ai_model_families (
      id TEXT PRIMARY KEY,
      container_id TEXT NOT NULL,
      display_name TEXT,
      name TEXT,
      eligible_tasks TEXT,
      cap_chat INTEGER DEFAULT 0,
      display_order INTEGER DEFAULT 0
    );
    INSERT INTO ai_model_families (id, container_id, display_name, name, eligible_tasks, cap_chat, display_order) VALUES
      ('claude-sonnet',         'claude', 'Claude Sonnet', 'Claude Sonnet', 'conversation', 3, 1),
      ('local-qwen3-6-35b-a3b', 'local',  'Qwen 3.6 35B',  'Qwen',          'conversation', 4, 2);
  `);
  return db;
}

function setSetting(db, key, value) {
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key, String(value));
}

// --- getContextLimitTokens --------------------------------------------------

describe('getContextLimitTokens', () => {
  let db, ContextLimits;
  beforeEach(() => {
    db = makeDb();
    ContextLimits = freshContextLimits();
  });
  afterEach(() => { db.close(); });

  it('returns the local setting when the resolved family is a local launcher (http) container', () => {
    setSetting(db, 'context_limit_local_tokens', 50000);
    const result = ContextLimits.getContextLimitTokens(db, { familyId: 'local-qwen3-6-35b-a3b' });
    expect(result).toBe(50000);
  });

  it('returns the proprietary setting when the resolved family is a CLI (cloud) container', () => {
    setSetting(db, 'context_limit_proprietary_tokens', 175000);
    const result = ContextLimits.getContextLimitTokens(db, { familyId: 'claude-sonnet' });
    expect(result).toBe(175000);
  });

  it('falls back to FALLBACK_LOCAL when local setting is missing', () => {
    // No local setting written.
    const result = ContextLimits.getContextLimitTokens(db, { familyId: 'local-qwen3-6-35b-a3b' });
    expect(result).toBe(ContextLimits.FALLBACK_LOCAL);
  });

  it('falls back to FALLBACK_PROPRIETARY when proprietary setting is missing', () => {
    const result = ContextLimits.getContextLimitTokens(db, { familyId: 'claude-sonnet' });
    expect(result).toBe(ContextLimits.FALLBACK_PROPRIETARY);
  });

  it('treats below-MIN stored values as missing and uses fallback (defensive)', () => {
    // Someone hand-edits the DB to a too-small value — don't honor it.
    setSetting(db, 'context_limit_local_tokens', 100);
    const result = ContextLimits.getContextLimitTokens(db, { familyId: 'local-qwen3-6-35b-a3b' });
    expect(result).toBe(ContextLimits.FALLBACK_LOCAL);
  });

  it('returns FALLBACK_PROPRIETARY when db is null (headless / test paths)', () => {
    expect(ContextLimits.getContextLimitTokens(null, { familyId: 'claude-sonnet' }))
      .toBe(ContextLimits.FALLBACK_PROPRIETARY);
  });

  it('returns FALLBACK_PROPRIETARY when resolved is null', () => {
    expect(ContextLimits.getContextLimitTokens(db, null)).toBe(ContextLimits.FALLBACK_PROPRIETARY);
  });

  it('returns FALLBACK_PROPRIETARY when resolved.familyId points at an unknown family', () => {
    // No matching row in ai_model_families → can't classify → default to proprietary
    // (the historical default and the safer choice).
    expect(ContextLimits.getContextLimitTokens(db, { familyId: 'mystery-model' }))
      .toBe(ContextLimits.FALLBACK_PROPRIETARY);
  });
});

// --- getAllLimits -----------------------------------------------------------

describe('getAllLimits', () => {
  let db, ContextLimits;
  beforeEach(() => {
    db = makeDb();
    ContextLimits = freshContextLimits();
  });
  afterEach(() => { db.close(); });

  it('returns both stored values', () => {
    setSetting(db, 'context_limit_local_tokens', 50000);
    setSetting(db, 'context_limit_proprietary_tokens', 175000);
    expect(ContextLimits.getAllLimits(db)).toEqual({
      localTokens: 50000,
      proprietaryTokens: 175000
    });
  });

  it('returns fallbacks for missing keys', () => {
    // Empty settings table.
    expect(ContextLimits.getAllLimits(db)).toEqual({
      localTokens: ContextLimits.FALLBACK_LOCAL,
      proprietaryTokens: ContextLimits.FALLBACK_PROPRIETARY
    });
  });

  it('treats below-MIN stored values as missing', () => {
    setSetting(db, 'context_limit_local_tokens', 100);
    setSetting(db, 'context_limit_proprietary_tokens', 100);
    expect(ContextLimits.getAllLimits(db)).toEqual({
      localTokens: ContextLimits.FALLBACK_LOCAL,
      proprietaryTokens: ContextLimits.FALLBACK_PROPRIETARY
    });
  });
});

// --- setLimits validation ---------------------------------------------------

describe('setLimits', () => {
  let db, ContextLimits;
  beforeEach(() => {
    db = makeDb();
    ContextLimits = freshContextLimits();
  });
  afterEach(() => { db.close(); });

  it('accepts a partial update of localTokens only', () => {
    const after = ContextLimits.setLimits(db, { localTokens: 50000 });
    expect(after.localTokens).toBe(50000);
    expect(after.proprietaryTokens).toBe(ContextLimits.FALLBACK_PROPRIETARY); // unset → default
    // Persisted in settings
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'context_limit_local_tokens'`).get();
    expect(row.value).toBe('50000');
  });

  it('accepts a partial update of proprietaryTokens only', () => {
    const after = ContextLimits.setLimits(db, { proprietaryTokens: 150000 });
    expect(after.proprietaryTokens).toBe(150000);
    expect(after.localTokens).toBe(ContextLimits.FALLBACK_LOCAL);
  });

  it('accepts both fields in one call', () => {
    const after = ContextLimits.setLimits(db, { localTokens: 50000, proprietaryTokens: 150000 });
    expect(after).toEqual({ localTokens: 50000, proprietaryTokens: 150000 });
  });

  it('rejects values below MIN_TOKENS', () => {
    expect(() => ContextLimits.setLimits(db, { localTokens: 100 })).toThrow(/between/);
  });

  it('rejects values above MAX_TOKENS', () => {
    expect(() => ContextLimits.setLimits(db, { proprietaryTokens: 99999999 })).toThrow(/between/);
  });

  it('rejects non-integer / NaN input', () => {
    expect(() => ContextLimits.setLimits(db, { localTokens: 'abc' })).toThrow(/integer/);
    expect(() => ContextLimits.setLimits(db, { localTokens: NaN })).toThrow(/integer/);
  });

  it('a no-op call returns current state without writing anything', () => {
    setSetting(db, 'context_limit_local_tokens', 50000);
    const before = ContextLimits.getAllLimits(db);
    const after = ContextLimits.setLimits(db, {});
    expect(after).toEqual(before);
  });

  it('rejects the whole call when one field is invalid (no partial write)', () => {
    setSetting(db, 'context_limit_local_tokens', 50000);
    expect(() => ContextLimits.setLimits(db, {
      localTokens: 60000,           // valid
      proprietaryTokens: 100         // invalid
    })).toThrow();
    // localTokens NOT written — validation runs before any persistence.
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'context_limit_local_tokens'`).get();
    expect(row.value).toBe('50000');
  });
});
