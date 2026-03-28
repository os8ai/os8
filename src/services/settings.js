/**
 * Settings Service
 * Manages application settings stored in the database
 */

const SettingsService = {
  get(db, key) {
    const result = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return result ? result.value : null;
  },

  set(db, key, value) {
    const existing = db.prepare('SELECT * FROM settings WHERE key = ?').get(key);
    if (existing) {
      db.prepare('UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?')
        .run(value, key);
    } else {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
    }
  },

  getAll(db) {
    const rows = db.prepare('SELECT * FROM settings').all();
    const settings = {};
    rows.forEach(row => { settings[row.key] = row.value; });
    return settings;
  },

  getPort(db) {
    return parseInt(this.get(db, 'port') || '8888', 10);
  },

  setPort(db, port) {
    this.set(db, 'port', String(port));
  },

  // Voice settings defaults
  VOICE_DEFAULTS: {
    silenceDurationNormal: 1800,    // ms - pause before auto-send
    silenceDurationShort: 2500,     // ms - for short messages (<3 words)
    contextWindowLength: 10000,     // ms - whisper context window
    vadSilence: 1800,               // ms - server VAD silence threshold
    silenceThreshold: 0.01,         // RMS threshold for silence detection
  },

  getVoiceSettings(db) {
    const stored = this.get(db, 'voice');
    const defaults = this.VOICE_DEFAULTS;
    if (stored) {
      try {
        return { ...defaults, ...JSON.parse(stored) };
      } catch (e) {
        return defaults;
      }
    }
    return defaults;
  },

  setVoiceSettings(db, settings) {
    const current = this.getVoiceSettings(db);
    const merged = { ...current, ...settings };
    this.set(db, 'voice', JSON.stringify(merged));
    return merged;
  }
};

module.exports = SettingsService;
