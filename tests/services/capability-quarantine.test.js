import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const Database = require('better-sqlite3');

const { CapabilityService } = require('../../src/services/capability');

// In-memory SQLite DB with just the tables CapabilityService needs.
let db;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE capabilities (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'api',
      name TEXT NOT NULL,
      description TEXT,
      scope TEXT DEFAULT 'global',
      agent_id TEXT,
      env_required TEXT,
      bins_required TEXT,
      connection TEXT,
      connection_scopes TEXT,
      available INTEGER DEFAULT 1,
      base_path TEXT,
      endpoints TEXT,
      search_description TEXT,
      version TEXT,
      license TEXT,
      metadata TEXT,
      source TEXT DEFAULT 'bundled',
      source_url TEXT,
      catalog_id TEXT,
      homepage TEXT,
      quarantine INTEGER DEFAULT 0,
      usage_count INTEGER DEFAULT 0,
      last_used_at TEXT,
      embedding BLOB,
      review_status TEXT,
      review_risk_level TEXT,
      review_report TEXT,
      reviewed_at TEXT,
      approved_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE env_variables (
      id TEXT PRIMARY KEY,
      key TEXT UNIQUE NOT NULL,
      value TEXT,
      description TEXT
    );

    CREATE TABLE connections (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      scopes TEXT DEFAULT '[]',
      access_token TEXT,
      refresh_token TEXT,
      expires_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE agent_pinned_capabilities (
      agent_id TEXT NOT NULL,
      capability_id TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      pinned_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (agent_id, capability_id)
    );
  `);
});

afterEach(() => {
  db.close();
});

function insertCap(overrides = {}) {
  const cap = {
    id: overrides.id || 'test-cap',
    type: overrides.type || 'api',
    name: overrides.name || 'Test Capability',
    description: overrides.description || 'A test capability',
    available: overrides.available ?? 1,
    quarantine: overrides.quarantine ?? 0,
    env_required: overrides.env_required || null,
    bins_required: overrides.bins_required || null,
    connection: overrides.connection || null,
    connection_scopes: overrides.connection_scopes || null,
    source: overrides.source || 'bundled',
  };

  db.prepare(`
    INSERT INTO capabilities (id, type, name, description, available, quarantine, env_required, bins_required, connection, connection_scopes, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(cap.id, cap.type, cap.name, cap.description, cap.available, cap.quarantine, cap.env_required, cap.bins_required, cap.connection, cap.connection_scopes, cap.source);

  return cap;
}

describe('CapabilityService — quarantine and availability', () => {

  describe('getAvailable', () => {
    it('excludes quarantined capabilities', () => {
      insertCap({ id: 'ok', available: 1, quarantine: 0 });
      insertCap({ id: 'quarantined', available: 1, quarantine: 1 });

      const results = CapabilityService.getAvailable(db);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('ok');
    });

    it('excludes unavailable capabilities', () => {
      insertCap({ id: 'available', available: 1, quarantine: 0 });
      insertCap({ id: 'unavailable', available: 0, quarantine: 0 });

      const results = CapabilityService.getAvailable(db);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('available');
    });

    it('returns empty when all are quarantined', () => {
      insertCap({ id: 'q1', available: 1, quarantine: 1 });
      insertCap({ id: 'q2', available: 1, quarantine: 1 });

      const results = CapabilityService.getAvailable(db);
      expect(results).toHaveLength(0);
    });
  });

  describe('refreshAvailability', () => {
    it('sets available=1 when all env_required vars are present', () => {
      insertCap({ id: 'cap1', env_required: 'ANTHROPIC_API_KEY', available: 0 });
      db.prepare("INSERT INTO env_variables (id, key, value) VALUES ('1', 'ANTHROPIC_API_KEY', 'sk-test')").run();

      CapabilityService.refreshAvailability(db);

      const cap = db.prepare('SELECT available FROM capabilities WHERE id = ?').get('cap1');
      expect(cap.available).toBe(1);
    });

    it('sets available=0 when an env_required var is missing', () => {
      insertCap({ id: 'cap1', env_required: 'ANTHROPIC_API_KEY,OPENAI_API_KEY', available: 1 });
      db.prepare("INSERT INTO env_variables (id, key, value) VALUES ('1', 'ANTHROPIC_API_KEY', 'sk-test')").run();

      CapabilityService.refreshAvailability(db);

      const cap = db.prepare('SELECT available FROM capabilities WHERE id = ?').get('cap1');
      expect(cap.available).toBe(0);
    });

    it('sets available=0 when env var exists but is empty', () => {
      insertCap({ id: 'cap1', env_required: 'SOME_KEY', available: 1 });
      db.prepare("INSERT INTO env_variables (id, key, value) VALUES ('1', 'SOME_KEY', '  ')").run();

      CapabilityService.refreshAvailability(db);

      const cap = db.prepare('SELECT available FROM capabilities WHERE id = ?').get('cap1');
      expect(cap.available).toBe(0);
    });

    it('sets available=1 when capability has no requirements', () => {
      insertCap({ id: 'cap1', env_required: null, bins_required: null, available: 0 });

      CapabilityService.refreshAvailability(db);

      const cap = db.prepare('SELECT available FROM capabilities WHERE id = ?').get('cap1');
      expect(cap.available).toBe(1);
    });

    it('sets available=1 when OAuth connection is present with matching scope', () => {
      insertCap({ id: 'cap1', connection: 'google', connection_scopes: 'calendar', available: 0 });
      db.prepare("INSERT INTO connections (id, provider, scopes, access_token) VALUES ('1', 'google', '[\"calendar.events\"]', 'tok')").run();

      CapabilityService.refreshAvailability(db);

      const cap = db.prepare('SELECT available FROM capabilities WHERE id = ?').get('cap1');
      expect(cap.available).toBe(1);
    });

    it('sets available=0 when OAuth connection is missing', () => {
      insertCap({ id: 'cap1', connection: 'google', available: 1 });

      CapabilityService.refreshAvailability(db);

      const cap = db.prepare('SELECT available FROM capabilities WHERE id = ?').get('cap1');
      expect(cap.available).toBe(0);
    });
  });

  describe('pin', () => {
    it('pins a capability', () => {
      insertCap({ id: 'cap1' });
      CapabilityService.pin(db, 'agent-1', 'cap1');

      const pinned = CapabilityService.getPinned(db, 'agent-1');
      expect(pinned).toHaveLength(1);
      expect(pinned[0].id).toBe('cap1');
    });

    it('enforces max 5 pin limit', () => {
      for (let i = 1; i <= 5; i++) {
        insertCap({ id: `cap${i}`, name: `Cap ${i}` });
        CapabilityService.pin(db, 'agent-1', `cap${i}`);
      }

      insertCap({ id: 'cap6', name: 'Cap 6' });
      expect(() => CapabilityService.pin(db, 'agent-1', 'cap6')).toThrow('Maximum 5 pinned');
    });

    it('pin limit is per-agent', () => {
      for (let i = 1; i <= 5; i++) {
        insertCap({ id: `cap${i}`, name: `Cap ${i}` });
        CapabilityService.pin(db, 'agent-1', `cap${i}`);
      }

      // Different agent can still pin
      expect(() => CapabilityService.pin(db, 'agent-2', 'cap1')).not.toThrow();
    });
  });

  describe('getAll vs getAvailable filtering', () => {
    it('getAll returns quarantined capabilities, getAvailable does not', () => {
      insertCap({ id: 'normal', quarantine: 0, available: 1 });
      insertCap({ id: 'quarantined', quarantine: 1, available: 1, name: 'Quarantined' });

      const all = CapabilityService.getAll(db);
      const available = CapabilityService.getAvailable(db);

      expect(all).toHaveLength(2);
      expect(available).toHaveLength(1);
    });
  });
});
