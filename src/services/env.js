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

  set(db, key, value, optsOrDescription = null) {
    // Backwards-compat: third arg may be a string (legacy) or an opts object
    // `{ appId, description }`. When `appId` is set, write to `app_env_variables`
    // instead of the global `env_variables` table.
    let description = null;
    let appId = null;
    if (typeof optsOrDescription === 'string') {
      description = optsOrDescription;
    } else if (optsOrDescription && typeof optsOrDescription === 'object') {
      appId = optsOrDescription.appId || null;
      description = optsOrDescription.description ?? null;
    }
    if (appId) return EnvService._setForApp(db, appId, key, value, description);

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

  _setForApp(db, appId, key, value, description) {
    const existing = db.prepare(
      'SELECT id FROM app_env_variables WHERE app_id = ? AND key = ?'
    ).get(appId, key);
    if (existing) {
      db.prepare(
        'UPDATE app_env_variables SET value = ?, description = ? WHERE id = ?'
      ).run(value, description, existing.id);
    } else {
      const id = generateId();
      db.prepare(
        'INSERT INTO app_env_variables (id, app_id, key, value, description) VALUES (?, ?, ?, ?, ?)'
      ).run(id, appId, key, value, description);
    }
  },

  getAllForApp(db, appId) {
    const rows = db.prepare(
      'SELECT key, value FROM app_env_variables WHERE app_id = ?'
    ).all(appId);
    const obj = {};
    rows.forEach(r => { obj[r.key] = r.value; });
    return obj;
  },

  deleteForApp(db, appId, key) {
    db.prepare(
      'DELETE FROM app_env_variables WHERE app_id = ? AND key = ?'
    ).run(appId, key);
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
