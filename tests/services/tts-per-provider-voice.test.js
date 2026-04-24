import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const Database = require('better-sqlite3');
const TTSService = require('../../src/services/tts');

// Per-provider default voice memory: when the user customizes
// defaultVoiceFemale/Male under one provider and switches providers, the
// pick should survive the round trip. Without this, switchProvider would
// stomp the custom pick with the incoming provider's module DEFAULTS.

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE env_variables (id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, value TEXT NOT NULL, encrypted INTEGER DEFAULT 0);
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      voice_id TEXT,
      voice_name TEXT,
      gender TEXT,
      status TEXT DEFAULT 'active',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE agent_voices (
      agent_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      voice_id TEXT,
      voice_name TEXT,
      PRIMARY KEY (agent_id, provider)
    );
  `);
  // Both cloud providers configured so switchProvider treats them as valid.
  db.prepare(`INSERT INTO env_variables (id, key, value) VALUES ('1', 'ELEVENLABS_API_KEY', 'sk_e')`).run();
  db.prepare(`INSERT INTO env_variables (id, key, value) VALUES ('2', 'OPENAI_API_KEY', 'sk_o')`).run();
  return db;
}

describe('TTSService — per-provider default voice memory', () => {
  let db;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  it('remembers a custom default voice across a switch-away-and-back', () => {
    // Start on elevenlabs; pick custom default voices.
    TTSService.switchProvider(db, 'elevenlabs');
    TTSService.setSettings(db, {
      defaultVoiceFemale: 'EXA_CUSTOM',
      defaultVoiceFemaleName: 'Custom Female',
      defaultVoiceMale: 'ELB_CUSTOM',
      defaultVoiceMaleName: 'Custom Male'
    });

    // Switch to openai → settings update to openai DEFAULTS.
    TTSService.switchProvider(db, 'openai');
    let s = TTSService.getSettings(db);
    expect(s.defaultVoiceFemale).toBe('nova');
    expect(s.defaultVoiceMale).toBe('echo');

    // Switch back to elevenlabs → custom pick is restored, not module DEFAULTS.
    TTSService.switchProvider(db, 'elevenlabs');
    s = TTSService.getSettings(db);
    expect(s.defaultVoiceFemale).toBe('EXA_CUSTOM');
    expect(s.defaultVoiceFemaleName).toBe('Custom Female');
    expect(s.defaultVoiceMale).toBe('ELB_CUSTOM');
    expect(s.defaultVoiceMaleName).toBe('Custom Male');
  });

  it('seeds perProvider with module DEFAULTS on first visit to a never-used provider', () => {
    // No prior provider; switch directly to openai.
    TTSService.switchProvider(db, 'openai');
    const s = TTSService.getSettings(db);
    // Module DEFAULTS applied because perProvider.openai had no snapshot.
    expect(s.defaultVoiceFemale).toBe('nova');
    expect(s.defaultVoiceMale).toBe('echo');
  });

  it('writes through setSettings into perProvider[currentProvider]', () => {
    TTSService.switchProvider(db, 'openai');
    TTSService.setSettings(db, { defaultVoiceFemale: 'shimmer', defaultVoiceFemaleName: 'Shimmer' });
    const s = TTSService.getSettings(db);
    expect(s.perProvider?.openai?.defaultVoiceFemale).toBe('shimmer');
    expect(s.perProvider?.openai?.defaultVoiceFemaleName).toBe('Shimmer');
  });

  it('resolveActiveProvider remaps stale agent voices after an ai_mode flip (regression)', () => {
    // Repro: user was in local mode with Kokoro, agents got Kokoro voice IDs
    // ('am_eric' etc.). User flips ai_mode to proprietary. The pinned
    // elevenlabs slot was already set (from onboarding or migration), so
    // resolveActiveProvider returns { source: 'pinned' } without remapping —
    // but the agent still holds 'am_eric' and ElevenLabs 404s it.
    // After this fix: resolve calls _makeActive, which spots that
    // activeProvider=kokoro != elevenlabs and remaps every agent.
    db.prepare(`INSERT INTO agents (id, voice_id, voice_name, gender) VALUES ('a1', 'am_eric', 'Eric', 'male')`).run();
    db.prepare(`INSERT INTO agents (id, voice_id, voice_name, gender) VALUES ('a2', 'af_bella', 'Bella', 'female')`).run();
    TTSService.switchProvider(db, 'kokoro');  // makes kokoro active
    // Simulate an ai_mode flip: proprietary is now the mode, elevenlabs is pinned.
    db.prepare(`INSERT INTO settings (key, value) VALUES ('ai_mode', 'proprietary')`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('tts_provider_proprietary', 'elevenlabs')`).run();

    const resolved = TTSService.resolveActiveProvider(db);
    expect(resolved.provider).toBe('elevenlabs');
    expect(resolved.source).toBe('pinned');

    // Agents should now hold ElevenLabs voice IDs (the provider's gender defaults).
    const a1 = db.prepare(`SELECT voice_id FROM agents WHERE id = 'a1'`).get();
    const a2 = db.prepare(`SELECT voice_id FROM agents WHERE id = 'a2'`).get();
    expect(a1.voice_id).toBe('CwhRBWXzGAHq8TQ4Fs17');  // ElevenLabs Roger (male default)
    expect(a2.voice_id).toBe('EXAVITQu4vr4xnSDxMaL');  // ElevenLabs Rachel (female default)

    // tts.defaultVoice* should reflect ElevenLabs defaults, not Kokoro.
    const s = TTSService.getSettings(db);
    expect(s.defaultVoiceFemale).toBe('EXAVITQu4vr4xnSDxMaL');
    expect(s.defaultVoiceMale).toBe('CwhRBWXzGAHq8TQ4Fs17');
    // Tracker records the post-remap state.
    expect(s.activeProvider).toBe('elevenlabs');
  });

  it('resolveActiveProvider is idempotent — no remap when active already matches pinned', () => {
    TTSService.switchProvider(db, 'elevenlabs');
    const beforeSettings = db.prepare(`SELECT value FROM settings WHERE key = 'tts'`).get().value;
    TTSService.resolveActiveProvider(db);
    const afterSettings = db.prepare(`SELECT value FROM settings WHERE key = 'tts'`).get().value;
    expect(afterSettings).toBe(beforeSettings);
  });

  it('resolveActiveProvider auto-pick restores perProvider snapshot when returning to a mode', () => {
    // User was on elevenlabs with custom voices, then the slot gets cleared
    // somehow (e.g. manual settings edit). A subsequent resolve should
    // auto-pick elevenlabs and restore the snapshot.
    TTSService.switchProvider(db, 'elevenlabs');
    TTSService.setSettings(db, {
      defaultVoiceFemale: 'EXA_CUSTOM',
      defaultVoiceFemaleName: 'Custom'
    });
    // Clear the proprietary slot to simulate a never-set state.
    db.prepare(`UPDATE settings SET value = '' WHERE key = 'tts_provider_proprietary'`).run();

    const resolved = TTSService.resolveActiveProvider(db);
    expect(resolved.provider).toBe('elevenlabs');
    expect(resolved.source).toBe('auto');
    const s = TTSService.getSettings(db);
    expect(s.defaultVoiceFemale).toBe('EXA_CUSTOM');
  });
});
