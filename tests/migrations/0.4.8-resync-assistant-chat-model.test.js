import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const Database = require('better-sqlite3');
const MIGRATION = require('../../src/migrations/0.4.8-resync-assistant-chat-model');

// Minimum schema the migration reads (apps table). The actual resync logic
// touches the filesystem via APPS_DIR/template-resync — we don't exercise
// that here (no template fixture in test env). The smoke test verifies the
// module shape and the no-apps short-circuit.
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE apps (
      id TEXT PRIMARY KEY,
      name TEXT,
      app_type TEXT,
      status TEXT DEFAULT 'active'
    );
  `);
  return db;
}

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

describe('migration 0.4.8 — resync assistant chat-model UI', () => {
  let db;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  it('declares version 0.4.8 and a description', () => {
    expect(MIGRATION.version).toBe('0.4.8');
    expect(typeof MIGRATION.description).toBe('string');
    expect(MIGRATION.description.length).toBeGreaterThan(0);
  });

  it('returns cleanly when no assistant apps exist', async () => {
    // No app_type='system' rows → the migration should log "no apps" and
    // return without throwing or touching the filesystem.
    await expect(MIGRATION.up({ db, logger: silentLogger })).resolves.toBeUndefined();
  });

  it('skips deleted apps and apps with non-system type', async () => {
    db.prepare(`INSERT INTO apps (id, name, app_type, status) VALUES (?, ?, ?, ?)`).run(
      'user-app-1', 'Some User App', 'user', 'active'
    );
    db.prepare(`INSERT INTO apps (id, name, app_type, status) VALUES (?, ?, ?, ?)`).run(
      'deleted-system', 'Deleted Assistant', 'system', 'deleted'
    );
    // Both rows fail the SELECT filter — migration sees zero apps and logs accordingly.
    let logs = [];
    const captureLogger = { log: (m) => logs.push(m), warn: () => {}, error: () => {} };
    await MIGRATION.up({ db, logger: captureLogger });
    expect(logs.some(l => l.includes('No assistant apps'))).toBe(true);
  });
});
