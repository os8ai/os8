import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const Database = require('better-sqlite3');
const migrator = require('../../src/services/migrator');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)`);
  return db;
}

function makeMigrationsDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-migtest-'));
  return dir;
}

function writeMigration(dir, filename, { version, description = '', up = 'async () => {}' }) {
  const content = `module.exports = {
  version: '${version}',
  description: ${JSON.stringify(description)},
  up: ${up}
};
`;
  fs.writeFileSync(path.join(dir, filename), content);
}

describe('compareVersions', () => {
  it('handles semver ordering', () => {
    expect(migrator.compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(migrator.compareVersions('1.0.1', '1.0.0')).toBeGreaterThan(0);
    expect(migrator.compareVersions('1.0.0', '1.0.1')).toBeLessThan(0);
    expect(migrator.compareVersions('1.1.0', '1.0.9')).toBeGreaterThan(0);
    expect(migrator.compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
    expect(migrator.compareVersions('0.2.10', '0.2.9')).toBeGreaterThan(0);
  });

  it('treats missing segments as zero', () => {
    expect(migrator.compareVersions('1.0', '1.0.0')).toBe(0);
    expect(migrator.compareVersions('1', '1.0.0')).toBe(0);
  });
});

describe('migrator.run', () => {
  let db;
  let migrationsDir;

  beforeEach(() => {
    db = makeDb();
    migrationsDir = makeMigrationsDir();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(migrationsDir, { recursive: true, force: true });
    // Clear require cache for any migration files we wrote
    for (const key of Object.keys(require.cache)) {
      if (key.includes('os8-migtest-')) delete require.cache[key];
    }
  });

  it('no-ops when current === stored', async () => {
    migrator.writeStoredVersion(db, '0.2.10');
    const result = await migrator.run({ db, migrationsDir, currentVersion: '0.2.10', logger: silentLogger() });
    expect(result.ran).toEqual([]);
    expect(migrator.readStoredVersion(db)).toBe('0.2.10');
  });

  it('warns and no-ops on downgrade, stored unchanged', async () => {
    migrator.writeStoredVersion(db, '0.3.0');
    const result = await migrator.run({ db, migrationsDir, currentVersion: '0.2.10', logger: silentLogger() });
    expect(result.ran).toEqual([]);
    expect(migrator.readStoredVersion(db)).toBe('0.3.0');
  });

  it('defaults stored to 0.0.0 when setting missing', async () => {
    writeMigration(migrationsDir, '0.2.10-a.js', {
      version: '0.2.10',
      up: 'async () => {}'
    });
    const result = await migrator.run({ db, migrationsDir, currentVersion: '0.2.10', logger: silentLogger() });
    expect(result.stored).toBe('0.0.0');
    expect(result.ran).toEqual(['0.2.10']);
    expect(migrator.readStoredVersion(db)).toBe('0.2.10');
  });

  it('runs multiple migrations in version order', async () => {
    const log = [];
    writeMigration(migrationsDir, '0.3.0-second.js', {
      version: '0.3.0',
      up: `async () => { global.__MIG_LOG.push('0.3.0'); }`
    });
    writeMigration(migrationsDir, '0.2.10-first.js', {
      version: '0.2.10',
      up: `async () => { global.__MIG_LOG.push('0.2.10'); }`
    });
    global.__MIG_LOG = log;
    migrator.writeStoredVersion(db, '0.2.9');
    const result = await migrator.run({ db, migrationsDir, currentVersion: '0.3.0', logger: silentLogger() });
    delete global.__MIG_LOG;
    expect(log).toEqual(['0.2.10', '0.3.0']);
    expect(result.ran).toEqual(['0.2.10', '0.3.0']);
    expect(migrator.readStoredVersion(db)).toBe('0.3.0');
  });

  it('advances stored version after each successful migration', async () => {
    // After the first migration succeeds and second fails, stored = first's version.
    writeMigration(migrationsDir, '0.2.10-ok.js', {
      version: '0.2.10',
      up: `async () => {}`
    });
    writeMigration(migrationsDir, '0.3.0-bad.js', {
      version: '0.3.0',
      up: `async () => { throw new Error('boom'); }`
    });
    migrator.writeStoredVersion(db, '0.2.9');

    await expect(
      migrator.run({ db, migrationsDir, currentVersion: '0.3.0', logger: silentLogger() })
    ).rejects.toThrow(/Migration 0\.3\.0.*boom/);

    expect(migrator.readStoredVersion(db)).toBe('0.2.10');
  });

  it('wraps migration errors in MigrationError', async () => {
    writeMigration(migrationsDir, '0.2.10-bad.js', {
      version: '0.2.10',
      up: `async () => { throw new Error('nope'); }`
    });
    migrator.writeStoredVersion(db, '0.2.9');

    try {
      await migrator.run({ db, migrationsDir, currentVersion: '0.2.10', logger: silentLogger() });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(migrator.MigrationError);
      expect(err.migration.version).toBe('0.2.10');
      expect(err.cause.message).toBe('nope');
    }
  });

  it('skips migrations outside (stored, current] window', async () => {
    writeMigration(migrationsDir, '0.2.0-old.js', {
      version: '0.2.0',
      up: `async () => { global.__MIG_LOG.push('0.2.0'); }`
    });
    writeMigration(migrationsDir, '0.2.10-now.js', {
      version: '0.2.10',
      up: `async () => { global.__MIG_LOG.push('0.2.10'); }`
    });
    writeMigration(migrationsDir, '0.5.0-future.js', {
      version: '0.5.0',
      up: `async () => { global.__MIG_LOG.push('0.5.0'); }`
    });
    global.__MIG_LOG = [];
    migrator.writeStoredVersion(db, '0.2.9');

    const result = await migrator.run({ db, migrationsDir, currentVersion: '0.2.10', logger: silentLogger() });
    const log = [...global.__MIG_LOG];
    delete global.__MIG_LOG;

    expect(log).toEqual(['0.2.10']);
    expect(result.ran).toEqual(['0.2.10']);
  });

  it('advances stored to current when no migrations match (patch-only bump)', async () => {
    migrator.writeStoredVersion(db, '0.2.10');
    const result = await migrator.run({ db, migrationsDir, currentVersion: '0.2.11', logger: silentLogger() });
    expect(result.ran).toEqual([]);
    expect(migrator.readStoredVersion(db)).toBe('0.2.11');
  });

  it('rejects a migration file missing version or up()', async () => {
    fs.writeFileSync(
      path.join(migrationsDir, 'broken.js'),
      `module.exports = { description: 'oops' };`
    );
    migrator.writeStoredVersion(db, '0.2.9');
    await expect(
      migrator.run({ db, migrationsDir, currentVersion: '0.2.10', logger: silentLogger() })
    ).rejects.toThrow(/missing required fields/);
  });
});

function silentLogger() {
  return { log: () => {}, warn: () => {}, error: () => {} };
}
