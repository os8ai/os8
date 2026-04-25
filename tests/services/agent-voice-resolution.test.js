import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Regression guard for the Penny silent-TTS bug (v0.4.6).
//
// The original bug: AgentService.getConfig() returned voiceId from the legacy
// `agents.voice_id` column, ignoring the per-provider `agent_voices` table.
// An agent with an ElevenLabs voice ID went silent under Kokoro because the
// chat client forwarded a foreign-format voice ID to the active provider.
//
// The fix: getConfig() now reads agent_voices[activeProvider] first, falls
// back to the legacy column only when no provider is active. This file pins
// down the four scenarios that distinguish the two behaviors so a future
// "cleanup" pass can't undo the fix without a test failure.

// --- Test harness -----------------------------------------------------------

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);

    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      color TEXT,
      backend TEXT,
      model TEXT,
      owner_name TEXT,
      pronouns TEXT DEFAULT 'they',
      voice_archetype TEXT,
      voice_id TEXT,
      voice_name TEXT,
      gender TEXT DEFAULT 'female',
      role TEXT DEFAULT '',
      appearance TEXT DEFAULT '',
      age INTEGER,
      birth_date TEXT,
      hair_color TEXT DEFAULT '',
      skin_tone TEXT DEFAULT '',
      height TEXT DEFAULT '',
      build TEXT DEFAULT '',
      other_features TEXT DEFAULT '',
      myself_preamble TEXT,
      myself_content TEXT,
      myself_custom TEXT,
      user_custom TEXT,
      life_intensity TEXT DEFAULT 'medium',
      chat_reset_at TEXT,
      visibility TEXT DEFAULT 'visible',
      subconscious_memory INTEGER DEFAULT 1,
      subconscious_direct INTEGER DEFAULT 0,
      subconscious_depth INTEGER DEFAULT 2,
      show_image INTEGER DEFAULT 1,
      telegram_bot_token TEXT,
      telegram_bot_username TEXT,
      telegram_chat_id TEXT,
      display_order INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT,
      status TEXT DEFAULT 'active',
      setup_complete INTEGER DEFAULT 1
    );

    CREATE TABLE agent_models (
      agent_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      family_id TEXT,
      PRIMARY KEY (agent_id, mode)
    );

    CREATE TABLE agent_voices (
      agent_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      voice_id TEXT,
      voice_name TEXT,
      PRIMARY KEY (agent_id, provider)
    );

    CREATE TABLE env_variables (
      id TEXT PRIMARY KEY,
      key TEXT UNIQUE NOT NULL,
      value TEXT NOT NULL,
      encrypted INTEGER DEFAULT 0
    );
  `);
  return db;
}

function seedAgent(db, id, opts = {}) {
  db.prepare(`
    INSERT INTO agents (id, app_id, name, slug, color, backend, model, owner_name, voice_id, voice_name)
    VALUES (?, 'app1', ?, ?, '#8b5cf6', 'claude', NULL, '', ?, ?)
  `).run(id, opts.name || id, opts.slug || id, opts.legacyVoiceId || null, opts.legacyVoiceName || null);
}

function seedAgentVoice(db, agentId, provider, voiceId, voiceName) {
  db.prepare(`
    INSERT INTO agent_voices (agent_id, provider, voice_id, voice_name)
    VALUES (?, ?, ?, ?)
  `).run(agentId, provider, voiceId, voiceName);
}

function setMode(db, mode) {
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_mode', ?)`).run(mode);
}

function setActiveProvider(db, mode, provider) {
  // Mirrors how TTSService.setProvider stores it: per-mode slot.
  const key = mode === 'local' ? 'tts_provider_local' : 'tts_provider_proprietary';
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key, provider);
}

// Cloud providers need an env var present for TTSService.getProviderName to
// classify them as available; without keys it would still resolve via the
// stored slot, but we seed keys to match production state and avoid relying
// on resolver edge cases.
function seedEnvKey(db, name, value = 'sk_test') {
  db.prepare(`
    INSERT INTO env_variables (id, key, value) VALUES (?, ?, ?)
  `).run(name.toLowerCase(), name, value);
}

function withTempHome(fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-vrtest-'));
  const origHome = process.env.OS8_HOME;
  process.env.OS8_HOME = tempDir;
  try { return fn(tempDir); }
  finally {
    if (origHome) process.env.OS8_HOME = origHome;
    else delete process.env.OS8_HOME;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function freshAgentService() {
  delete require.cache[require.resolve('../../src/services/agent')];
  delete require.cache[require.resolve('../../src/services/tts')];
  delete require.cache[require.resolve('../../src/services/settings')];
  delete require.cache[require.resolve('../../src/config')];
  return require('../../src/services/agent');
}

// --- Tests ------------------------------------------------------------------

describe('AgentService.getConfig — voice resolution (per-active-provider with legacy fallback)', () => {
  it('PENNY case: provider active, NO agent_voices row for that provider → voiceId/voiceName undefined', () => {
    withTempHome(() => {
      const db = makeDb();
      // Penny shape: legacy column carries an ElevenLabs voice (mismatched format),
      // agent_voices has elevenlabs + openai but no kokoro entry.
      seedAgent(db, 'penny', { legacyVoiceId: 'WCASLR-elevenlabs', legacyVoiceName: 'Penny EL' });
      seedAgentVoice(db, 'penny', 'elevenlabs', 'WCASLR-elevenlabs', 'Penny EL');
      seedAgentVoice(db, 'penny', 'openai', '', '');
      setMode(db, 'local');
      setActiveProvider(db, 'local', 'kokoro');

      const AgentService = freshAgentService();
      const cfg = AgentService.getConfig(db, 'penny');

      // The fix: per-provider miss returns undefined, NOT the legacy column.
      // Client falls through to global default voice (Bella for kokoro).
      expect(cfg.voiceId).toBeUndefined();
      expect(cfg.voiceName).toBeUndefined();
      db.close();
    });
  });

  it('BOB case: provider active, agent_voices row matches → returns that voice', () => {
    withTempHome(() => {
      const db = makeDb();
      seedAgent(db, 'bob', { legacyVoiceId: 'am_eric', legacyVoiceName: 'Eric' });
      seedAgentVoice(db, 'bob', 'kokoro', 'am_eric', 'Eric (American)');
      setMode(db, 'local');
      setActiveProvider(db, 'local', 'kokoro');

      const AgentService = freshAgentService();
      const cfg = AgentService.getConfig(db, 'bob');

      expect(cfg.voiceId).toBe('am_eric');
      expect(cfg.voiceName).toBe('Eric (American)');
      db.close();
    });
  });

  it('CROSS-PROVIDER ISOLATION: agent has elevenlabs row but kokoro is active → does NOT return elevenlabs voice', () => {
    // The exact regression guard for the Penny bug. If a future change
    // re-introduces "fall back to legacy column when per-provider row missing,
    // even when a provider is active", this test fails.
    withTempHome(() => {
      const db = makeDb();
      seedAgent(db, 'crossagent', { legacyVoiceId: 'WCASLR-elevenlabs', legacyVoiceName: 'EL voice' });
      seedAgentVoice(db, 'crossagent', 'elevenlabs', 'WCASLR-elevenlabs', 'EL voice');
      // No kokoro row.
      setMode(db, 'local');
      setActiveProvider(db, 'local', 'kokoro');

      const AgentService = freshAgentService();
      const cfg = AgentService.getConfig(db, 'crossagent');

      expect(cfg.voiceId).not.toBe('WCASLR-elevenlabs');
      expect(cfg.voiceId).toBeUndefined();
      db.close();
    });
  });

  it('SWITCH PROVIDER: same agent returns different voice depending on which provider is active', () => {
    withTempHome(() => {
      const db = makeDb();
      seedAgent(db, 'multi', { legacyVoiceId: null });
      seedAgentVoice(db, 'multi', 'kokoro',     'af_bella',     'Bella');
      seedAgentVoice(db, 'multi', 'elevenlabs', 'EXAVITQu',     'Rachel');
      seedAgentVoice(db, 'multi', 'openai',     'nova',         'Nova');
      seedEnvKey(db, 'ELEVENLABS_API_KEY');
      seedEnvKey(db, 'OPENAI_API_KEY');

      const AgentService = freshAgentService();

      setMode(db, 'local');
      setActiveProvider(db, 'local', 'kokoro');
      expect(AgentService.getConfig(db, 'multi').voiceId).toBe('af_bella');

      setMode(db, 'proprietary');
      setActiveProvider(db, 'proprietary', 'elevenlabs');
      expect(AgentService.getConfig(db, 'multi').voiceId).toBe('EXAVITQu');

      setActiveProvider(db, 'proprietary', 'openai');
      expect(AgentService.getConfig(db, 'multi').voiceId).toBe('nova');

      db.close();
    });
  });

  it('LEGACY FALLBACK: no provider configured at all → returns legacy agents.voice_id', () => {
    // Pre-migration agents or a clean install with no TTS provider yet — the
    // legacy column is the only voice info available, so use it.
    withTempHome(() => {
      const db = makeDb();
      seedAgent(db, 'legacy', { legacyVoiceId: 'old_voice_id', legacyVoiceName: 'Old Voice' });
      // No agent_voices rows. No tts_provider_* keys set. ai_mode missing.
      // TTSService.getProviderName returns null → fall back to legacy.

      const AgentService = freshAgentService();
      const cfg = AgentService.getConfig(db, 'legacy');

      expect(cfg.voiceId).toBe('old_voice_id');
      expect(cfg.voiceName).toBe('Old Voice');
      db.close();
    });
  });

  it('EMPTY ROW: agent_voices row exists but voice_id is empty string → undefined (treated as "not set")', () => {
    // Penny has an empty openai row in production data. An empty string is
    // semantically "no voice picked", same as "no row". Should not stomp the
    // global-default fallback path with ''.
    withTempHome(() => {
      const db = makeDb();
      seedAgent(db, 'p', {});
      seedAgentVoice(db, 'p', 'kokoro', '', '');
      setMode(db, 'local');
      setActiveProvider(db, 'local', 'kokoro');

      const AgentService = freshAgentService();
      const cfg = AgentService.getConfig(db, 'p');

      expect(cfg.voiceId).toBeUndefined();
      db.close();
    });
  });
});
