/**
 * Environment Variables Service
 * Manages centralized environment variables stored in the local database.
 * All data stays on-device in ~/os8/config/os8.db.
 */

const { generateId } = require('../utils');

const EnvService = {
  getAll(db) {
    return db.prepare('SELECT * FROM env_variables ORDER BY key').all();
  },

  get(db, key) {
    return db.prepare('SELECT * FROM env_variables WHERE key = ?').get(key);
  },

  set(db, key, value, description = null) {
    const existing = db.prepare('SELECT id FROM env_variables WHERE key = ?').get(key);
    if (existing) {
      db.prepare('UPDATE env_variables SET value = ?, description = ? WHERE key = ?')
        .run(value, description, key);
    } else {
      const id = generateId();
      db.prepare('INSERT INTO env_variables (id, key, value, encrypted, description) VALUES (?, ?, ?, 0, ?)')
        .run(id, key, value, description);
    }
  },

  delete(db, key) {
    db.prepare('DELETE FROM env_variables WHERE key = ?').run(key);
  },

  // Get all env vars as object (for injecting into process)
  asObject(db) {
    const vars = this.getAll(db);
    const obj = {};
    vars.forEach(v => { obj[v.key] = v.value; });
    return obj;
  },

  // Decrypt any previously-encrypted rows back to plaintext (one-time migration)
  migrateEncryptedToPlaintext(db) {
    let rows;
    try {
      rows = db.prepare('SELECT * FROM env_variables WHERE encrypted = 1 AND value IS NOT NULL AND value != ?').all('');
    } catch { return; }
    if (rows.length === 0) return;

    try {
      const { safeStorage } = require('electron');
      const update = db.prepare('UPDATE env_variables SET value = ?, encrypted = 0 WHERE id = ?');
      const migrate = db.transaction(() => {
        for (const row of rows) {
          const decrypted = safeStorage.decryptString(Buffer.from(row.value, 'base64'));
          update.run(decrypted, row.id);
        }
      });
      migrate();
      console.log(`[EnvService] Decrypted ${rows.length} key(s) from keychain to plaintext`);
    } catch (e) {
      console.warn('[EnvService] Could not migrate encrypted keys:', e.message);
    }
  }
};

module.exports = EnvService;
