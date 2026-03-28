/**
 * Environment Variables Service
 * Manages centralized environment variables stored in the database
 * Values are encrypted at rest using Electron safeStorage (OS keychain)
 */

const { generateId } = require('../utils');

// --- Encryption helpers (Electron safeStorage) ---

function canEncrypt() {
  try {
    const { safeStorage } = require('electron');
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function encryptValue(plaintext) {
  if (!canEncrypt()) return { value: plaintext, encrypted: 0 };
  try {
    const { safeStorage } = require('electron');
    const encrypted = safeStorage.encryptString(plaintext);
    return { value: encrypted.toString('base64'), encrypted: 1 };
  } catch (e) {
    console.warn('[EnvService] Encryption failed, storing plaintext:', e.message);
    return { value: plaintext, encrypted: 0 };
  }
}

function decryptValue(row) {
  if (!row) return row;
  if (!row.encrypted) return row;
  try {
    const { safeStorage } = require('electron');
    const decrypted = safeStorage.decryptString(Buffer.from(row.value, 'base64'));
    return { ...row, value: decrypted };
  } catch (e) {
    console.warn(`[EnvService] Decryption failed for key "${row.key}":`, e.message);
    return row; // Return as-is — value will be invalid, user re-enters
  }
}

// --- Service ---

const EnvService = {
  getAll(db) {
    const rows = db.prepare('SELECT * FROM env_variables ORDER BY key').all();
    return rows.map(decryptValue);
  },

  get(db, key) {
    const row = db.prepare('SELECT * FROM env_variables WHERE key = ?').get(key);
    return decryptValue(row);
  },

  set(db, key, value, description = null) {
    const { value: storedValue, encrypted } = encryptValue(value);
    const existing = db.prepare('SELECT id FROM env_variables WHERE key = ?').get(key);
    if (existing) {
      db.prepare('UPDATE env_variables SET value = ?, encrypted = ?, description = ? WHERE key = ?')
        .run(storedValue, encrypted, description, key);
    } else {
      const id = generateId();
      db.prepare('INSERT INTO env_variables (id, key, value, encrypted, description) VALUES (?, ?, ?, ?, ?)')
        .run(id, key, storedValue, encrypted, description);
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

  // Encrypt all plaintext rows (idempotent — skips already-encrypted)
  migrateUnencrypted(db) {
    if (!canEncrypt()) return;
    const rows = db.prepare('SELECT * FROM env_variables WHERE encrypted = 0 AND value IS NOT NULL AND value != ?').all('');
    if (rows.length === 0) return;

    const update = db.prepare('UPDATE env_variables SET value = ?, encrypted = 1 WHERE id = ?');
    const migrate = db.transaction(() => {
      const { safeStorage } = require('electron');
      for (const row of rows) {
        const encrypted = safeStorage.encryptString(row.value);
        update.run(encrypted.toString('base64'), row.id);
      }
    });
    migrate();
    console.log(`[EnvService] Encrypted ${rows.length} API key(s) at rest`);
  }
};

module.exports = EnvService;
