import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const Database = require('better-sqlite3');

function freshContextLimits() {
  delete require.cache[require.resolve('../../src/services/context-limits')];
  delete require.cache[require.resolve('../../src/services/settings')];
  delete require.cache[require.resolve('../../src/services/ai-registry')];
  return require('../../src/services/context-limits');
}

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

describe('getEffectiveContextBudget', () => {
  let db, ContextLimits;
  beforeEach(() => {
    db = makeDb();
    ContextLimits = freshContextLimits();
  });
  afterEach(() => { db.close(); });

  it('subtracts opencode overhead when the resolved family is on a local launcher (backendId=local at early-resolve time)', () => {
    // The agent-spawn path's first resolve carries backendId='local' because
    // the classifier hasn't fired yet. The pessimistic branch detects the
    // local container and reserves opencode's overhead anyway.
    const r = { familyId: 'local-qwen3-6-35b-a3b', backendId: 'local' };
    const eff = ContextLimits.getEffectiveContextBudget(db, r);
    expect(eff).toBe(ContextLimits.FALLBACK_LOCAL - ContextLimits.CLI_OVERHEAD.opencode);
  });

  it('subtracts opencode overhead when the resolved family is on a local launcher (backendId=opencode after re-resolve)', () => {
    // After the agent-spawn re-resolve fires, backendId switches to 'opencode'.
    // Same outcome — the local-container detection wins regardless.
    const r = { familyId: 'local-qwen3-6-35b-a3b', backendId: 'opencode' };
    const eff = ContextLimits.getEffectiveContextBudget(db, r);
    expect(eff).toBe(ContextLimits.FALLBACK_LOCAL - ContextLimits.CLI_OVERHEAD.opencode);
  });

  it('subtracts the per-backend overhead for proprietary backends (claude)', () => {
    // Tool use can push proprietary requests over the wire too — Opus's 200K
    // window is large enough that 20K reserve doesn't pinch real workloads.
    const r = { familyId: 'claude-sonnet', backendId: 'claude' };
    const eff = ContextLimits.getEffectiveContextBudget(db, r);
    expect(eff).toBe(ContextLimits.FALLBACK_PROPRIETARY - ContextLimits.CLI_OVERHEAD.claude);
  });

  it('reads opencode overhead from settings when present (overrides hardcoded fallback)', () => {
    setSetting(db, 'cli_overhead_opencode_tokens', 10000);
    const r = { familyId: 'local-qwen3-6-35b-a3b', backendId: 'local' };
    expect(ContextLimits.getEffectiveContextBudget(db, r))
      .toBe(ContextLimits.FALLBACK_LOCAL - 10000);
  });

  it('reads claude overhead from settings when present (overrides hardcoded fallback)', () => {
    setSetting(db, 'cli_overhead_claude_tokens', 5000);
    const r = { familyId: 'claude-sonnet', backendId: 'claude' };
    expect(ContextLimits.getEffectiveContextBudget(db, r))
      .toBe(ContextLimits.FALLBACK_PROPRIETARY - 5000);
  });

  it('treats negative or non-numeric overhead settings as missing (fallback)', () => {
    setSetting(db, 'cli_overhead_opencode_tokens', 'abc');
    const r = { familyId: 'local-qwen3-6-35b-a3b', backendId: 'local' };
    expect(ContextLimits.getEffectiveContextBudget(db, r))
      .toBe(ContextLimits.FALLBACK_LOCAL - ContextLimits.CLI_OVERHEAD.opencode);
  });

  it('honors a 0 overhead setting (valid value, not treated as missing)', () => {
    setSetting(db, 'cli_overhead_opencode_tokens', 0);
    const r = { familyId: 'local-qwen3-6-35b-a3b', backendId: 'local' };
    // 0 overhead → full budget passes through.
    expect(ContextLimits.getEffectiveContextBudget(db, r))
      .toBe(ContextLimits.FALLBACK_LOCAL);
  });

  it('respects a user-customized local budget', () => {
    setSetting(db, 'context_limit_local_tokens', 70000);
    const r = { familyId: 'local-qwen3-6-35b-a3b', backendId: 'local' };
    expect(ContextLimits.getEffectiveContextBudget(db, r)).toBe(70000 - ContextLimits.CLI_OVERHEAD.opencode);
  });

  it('respects a user-customized proprietary budget', () => {
    setSetting(db, 'context_limit_proprietary_tokens', 250000);
    const r = { familyId: 'claude-sonnet', backendId: 'claude' };
    expect(ContextLimits.getEffectiveContextBudget(db, r)).toBe(250000 - ContextLimits.CLI_OVERHEAD.claude);
  });

  it('clamps to MIN_TOKENS when the configured budget is smaller than overhead', () => {
    // Hand-edited DB with a tiny but technically-valid local budget.
    setSetting(db, 'context_limit_local_tokens', 5000);
    const r = { familyId: 'local-qwen3-6-35b-a3b', backendId: 'local' };
    const eff = ContextLimits.getEffectiveContextBudget(db, r);
    // 5000 - 25000 < MIN_TOKENS → clamp.
    expect(eff).toBe(ContextLimits.MIN_TOKENS);
  });

  it('passes through full budget when resolved is null (test/headless paths)', () => {
    expect(ContextLimits.getEffectiveContextBudget(db, null)).toBe(ContextLimits.FALLBACK_PROPRIETARY);
  });

  it('passes through full budget when resolved is undefined', () => {
    expect(ContextLimits.getEffectiveContextBudget(db, undefined)).toBe(ContextLimits.FALLBACK_PROPRIETARY);
  });

  it('does not subtract for unknown proprietary backends (defensive: zero overhead beats wrong overhead)', () => {
    // A new backendId we haven't catalogued yet — better to overshoot the
    // budget by a few thousand tokens than to silently shrink an unrelated
    // backend's window. CLI_OVERHEAD lookup returns undefined → 0 overhead.
    const r = { familyId: 'claude-sonnet', backendId: 'mystery-cli' };
    expect(ContextLimits.getEffectiveContextBudget(db, r)).toBe(ContextLimits.FALLBACK_PROPRIETARY);
  });

  it('exposes CLI_OVERHEAD with all known backends populated', () => {
    expect(ContextLimits.CLI_OVERHEAD.opencode).toBeGreaterThan(0);
    expect(ContextLimits.CLI_OVERHEAD.claude).toBeGreaterThan(0);
    expect(ContextLimits.CLI_OVERHEAD.gemini).toBeGreaterThan(0);
    expect(ContextLimits.CLI_OVERHEAD.codex).toBeGreaterThan(0);
    expect(ContextLimits.CLI_OVERHEAD.grok).toBeGreaterThan(0);
  });
});
