/**
 * Migration runner — executes pending migration files based on the stored
 * os8_version in the settings table.
 *
 * On startup:
 *   1. Read settings.os8_version (default '0.0.0').
 *   2. Read current version from package.json.
 *   3. If current === stored, no-op.
 *   4. If current < stored (downgrade), warn and no-op (don't rewind).
 *   5. Otherwise load src/migrations/<version>-*.js, sort by version, filter
 *      to (stored, current], run each in order.
 *   6. After each successful migration, write os8_version = that migration's
 *      version so a mid-flight failure halts cleanly and resumes next start.
 *   7. After the loop, write os8_version = current in case no migrations
 *      matched (e.g. patch-bump-only release) but the version moved forward.
 *
 * Migration file shape:
 *   module.exports = {
 *     version: '0.2.10',
 *     description: 'Short one-liner',
 *     async up({ db, logger }) { ... }
 *   }
 */

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const VERSION_KEY = 'os8_version';

class MigrationError extends Error {
  constructor(migration, cause) {
    super(`Migration ${migration.version} (${migration.filename}) failed: ${cause.message}`);
    this.name = 'MigrationError';
    this.migration = migration;
    this.cause = cause;
  }
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const ai = pa[i] || 0;
    const bi = pb[i] || 0;
    if (ai !== bi) return ai - bi;
  }
  return 0;
}

function readStoredVersion(db) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(VERSION_KEY);
  return row?.value || '0.0.0';
}

function writeStoredVersion(db, version) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(VERSION_KEY, version);
}

function getCurrentVersion() {
  // Fresh require each time so tests can mutate the file and re-invoke.
  delete require.cache[require.resolve('../../package.json')];
  return require('../../package.json').version;
}

function loadMigrations(dir = MIGRATIONS_DIR) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
  const migrations = [];
  for (const filename of files) {
    const mod = require(path.join(dir, filename));
    if (!mod.version || typeof mod.up !== 'function') {
      throw new Error(`Migration ${filename} is missing required fields (version, up)`);
    }
    migrations.push({ ...mod, filename });
  }
  migrations.sort((a, b) => compareVersions(a.version, b.version));
  return migrations;
}

/**
 * Run all pending migrations.
 *
 * @param {object} ctx
 * @param {object} ctx.db - better-sqlite3 database
 * @param {object} [ctx.logger] - logger (defaults to console)
 * @param {string} [ctx.migrationsDir] - override migrations directory (tests)
 * @param {string} [ctx.currentVersion] - override current version (tests)
 * @returns {Promise<{ ran: string[], stored: string, current: string }>}
 * @throws {MigrationError} when a migration throws
 */
async function run(ctx = {}) {
  const { db, logger = console, migrationsDir, currentVersion } = ctx;
  if (!db) throw new Error('migrator.run: db is required');

  const stored = readStoredVersion(db);
  const current = currentVersion || getCurrentVersion();
  const cmp = compareVersions(current, stored);

  if (cmp === 0) {
    logger.log(`[migrator] os8_version ${current} — no migrations to run`);
    return { ran: [], stored, current };
  }

  if (cmp < 0) {
    logger.warn(`[migrator] current version ${current} is older than stored ${stored} (downgrade) — skipping migrations, stored version unchanged`);
    return { ran: [], stored, current };
  }

  const all = loadMigrations(migrationsDir);
  const pending = all.filter(m =>
    compareVersions(m.version, stored) > 0 &&
    compareVersions(m.version, current) <= 0
  );

  if (pending.length === 0) {
    // No migrations match but version moved forward (e.g. patch bump without a migration).
    // Advance the stored version so we don't re-check on every startup.
    writeStoredVersion(db, current);
    logger.log(`[migrator] os8_version ${stored} → ${current} (no migrations needed)`);
    return { ran: [], stored, current };
  }

  logger.log(`[migrator] Running ${pending.length} migration(s): ${stored} → ${current}`);

  const ran = [];
  for (const m of pending) {
    logger.log(`[migrator] → ${m.version}: ${m.description || m.filename}`);
    try {
      await m.up({ db, logger });
    } catch (err) {
      throw new MigrationError(m, err);
    }
    writeStoredVersion(db, m.version);
    ran.push(m.version);
  }

  // Final bump — covers the case where last migration's version < current.
  if (compareVersions(ran[ran.length - 1], current) < 0) {
    writeStoredVersion(db, current);
  }

  logger.log(`[migrator] Complete. os8_version now ${getCurrentVersion()}`);
  return { ran, stored, current };
}

module.exports = {
  run,
  MigrationError,
  compareVersions,
  loadMigrations,
  readStoredVersion,
  writeStoredVersion,
  getCurrentVersion,
  VERSION_KEY,
};
