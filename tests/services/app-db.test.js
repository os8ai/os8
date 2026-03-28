import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('fs');
const path = require('path');
const os = require('os');

const AppDbService = require('../../src/services/app-db');

// Use a temp directory to simulate ~/os8/apps/
const tmpDir = path.join(os.tmpdir(), `os8-app-db-test-${Date.now()}`);
const fakeAppId = 'test-app-001';
const fakeAppId2 = 'test-app-002';

// Override APPS_DIR in the service for testing
const config = require('../../src/config');
let originalAppsDir;

function createFakeAppDir(appId) {
  const appDir = path.join(tmpDir, appId);
  fs.mkdirSync(appDir, { recursive: true });
  return appDir;
}

beforeEach(() => {
  originalAppsDir = config.APPS_DIR;
  config.APPS_DIR = tmpDir;
  fs.mkdirSync(tmpDir, { recursive: true });
  createFakeAppDir(fakeAppId);
  createFakeAppDir(fakeAppId2);
});

afterEach(() => {
  AppDbService.closeAll();
  config.APPS_DIR = originalAppsDir;
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

describe('AppDbService', () => {
  describe('getConnection', () => {
    it('creates database file lazily on first access', () => {
      const dbPath = path.join(tmpDir, fakeAppId, 'data.db');
      expect(fs.existsSync(dbPath)).toBe(false);

      AppDbService.getConnection(fakeAppId);
      expect(fs.existsSync(dbPath)).toBe(true);
    });

    it('returns cached connection on subsequent calls', () => {
      const conn1 = AppDbService.getConnection(fakeAppId);
      const conn2 = AppDbService.getConnection(fakeAppId);
      expect(conn1).toBe(conn2);
    });

    it('throws for non-existent app directory', () => {
      expect(() => AppDbService.getConnection('nonexistent-app')).toThrow('App directory not found');
    });
  });

  describe('execute + query', () => {
    it('creates a table and inserts/queries data', () => {
      AppDbService.execute(fakeAppId,
        'CREATE TABLE todos (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, done INTEGER DEFAULT 0)',
        []
      );

      const insertResult = AppDbService.execute(fakeAppId,
        'INSERT INTO todos (title) VALUES (?)',
        ['Buy groceries']
      );
      expect(insertResult.changes).toBe(1);
      expect(insertResult.lastInsertRowid).toBe(1);

      const queryResult = AppDbService.query(fakeAppId, 'SELECT * FROM todos', []);
      expect(queryResult.rows).toHaveLength(1);
      expect(queryResult.rows[0].title).toBe('Buy groceries');
      expect(queryResult.columns).toContain('id');
      expect(queryResult.columns).toContain('title');
    });

    it('supports parameterized queries', () => {
      AppDbService.execute(fakeAppId, 'CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)', []);
      AppDbService.execute(fakeAppId, 'INSERT INTO items (name) VALUES (?)', ['alpha']);
      AppDbService.execute(fakeAppId, 'INSERT INTO items (name) VALUES (?)', ['beta']);

      const result = AppDbService.query(fakeAppId, 'SELECT * FROM items WHERE name = ?', ['beta']);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].name).toBe('beta');
    });

    it('supports UPDATE and DELETE', () => {
      AppDbService.execute(fakeAppId, 'CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)', []);
      AppDbService.execute(fakeAppId, 'INSERT INTO items (name) VALUES (?)', ['alpha']);

      const updateResult = AppDbService.execute(fakeAppId, 'UPDATE items SET name = ? WHERE name = ?', ['updated', 'alpha']);
      expect(updateResult.changes).toBe(1);

      const deleteResult = AppDbService.execute(fakeAppId, 'DELETE FROM items WHERE name = ?', ['updated']);
      expect(deleteResult.changes).toBe(1);

      const queryResult = AppDbService.query(fakeAppId, 'SELECT * FROM items', []);
      expect(queryResult.rows).toHaveLength(0);
    });
  });

  describe('SQL safety', () => {
    it('rejects SELECT on /execute', () => {
      expect(() => AppDbService.execute(fakeAppId, 'SELECT * FROM sqlite_master', []))
        .toThrow('Only write/DDL statements');
    });

    it('rejects INSERT on /query', () => {
      AppDbService.execute(fakeAppId, 'CREATE TABLE t (id INTEGER)', []);
      expect(() => AppDbService.query(fakeAppId, 'INSERT INTO t VALUES (1)', []))
        .toThrow('Only SELECT statements');
    });

    it('blocks ATTACH DATABASE', () => {
      expect(() => AppDbService.execute(fakeAppId, "ATTACH DATABASE '/tmp/evil.db' AS evil", []))
        .toThrow('not allowed');
    });

    it('blocks PRAGMA', () => {
      expect(() => AppDbService.query(fakeAppId, 'PRAGMA table_list', []))
        .toThrow('not allowed');
    });

    it('blocks LOAD_EXTENSION', () => {
      expect(() => AppDbService.execute(fakeAppId, "LOAD_EXTENSION('/tmp/evil.so')", []))
        .toThrow('not allowed');
    });
  });

  describe('batch', () => {
    it('executes multiple statements in a transaction', () => {
      AppDbService.execute(fakeAppId, 'CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)', []);

      const result = AppDbService.batch(fakeAppId, [
        { sql: 'INSERT INTO items (name) VALUES (?)', params: ['one'] },
        { sql: 'INSERT INTO items (name) VALUES (?)', params: ['two'] },
        { sql: 'SELECT * FROM items', params: [] }
      ]);

      expect(result.results).toHaveLength(3);
      expect(result.results[0].changes).toBe(1);
      expect(result.results[1].changes).toBe(1);
      expect(result.results[2].rows).toHaveLength(2);
    });

    it('rejects empty statements array', () => {
      expect(() => AppDbService.batch(fakeAppId, [])).toThrow('non-empty array');
    });

    it('rejects blocked statements in batch', () => {
      expect(() => AppDbService.batch(fakeAppId, [
        { sql: "ATTACH DATABASE '/tmp/evil.db' AS evil", params: [] }
      ])).toThrow('not allowed');
    });
  });

  describe('schema', () => {
    it('returns empty tables list for fresh database', () => {
      const schema = AppDbService.getSchema(fakeAppId);
      expect(schema.tables).toHaveLength(0);
    });

    it('lists tables and columns', () => {
      AppDbService.execute(fakeAppId, 'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT)', []);
      AppDbService.execute(fakeAppId, 'CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER, title TEXT)', []);

      const schema = AppDbService.getSchema(fakeAppId);
      expect(schema.tables).toHaveLength(2);

      const users = schema.tables.find(t => t.name === 'users');
      expect(users).toBeDefined();
      expect(users.columns).toHaveLength(3);
      expect(users.columns.find(c => c.name === 'name').notnull).toBe(1);
    });

    it('returns table schema with CREATE SQL', () => {
      AppDbService.execute(fakeAppId, 'CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)', []);

      const table = AppDbService.getTableSchema(fakeAppId, 'items');
      expect(table.name).toBe('items');
      expect(table.columns).toHaveLength(2);
      expect(table.sql).toContain('CREATE TABLE');
    });

    it('returns null for non-existent table', () => {
      const table = AppDbService.getTableSchema(fakeAppId, 'nonexistent');
      expect(table).toBeNull();
    });
  });

  describe('cross-app isolation', () => {
    it('apps have separate databases', () => {
      AppDbService.execute(fakeAppId, 'CREATE TABLE shared_name (val TEXT)', []);
      AppDbService.execute(fakeAppId, 'INSERT INTO shared_name (val) VALUES (?)', ['from-app-1']);

      AppDbService.execute(fakeAppId2, 'CREATE TABLE shared_name (val TEXT)', []);
      AppDbService.execute(fakeAppId2, 'INSERT INTO shared_name (val) VALUES (?)', ['from-app-2']);

      const result1 = AppDbService.query(fakeAppId, 'SELECT * FROM shared_name', []);
      const result2 = AppDbService.query(fakeAppId2, 'SELECT * FROM shared_name', []);

      expect(result1.rows[0].val).toBe('from-app-1');
      expect(result2.rows[0].val).toBe('from-app-2');
    });
  });

  describe('connection lifecycle', () => {
    it('closeConnection removes from cache', () => {
      AppDbService.getConnection(fakeAppId);
      expect(AppDbService._connections.has(fakeAppId)).toBe(true);

      AppDbService.closeConnection(fakeAppId);
      expect(AppDbService._connections.has(fakeAppId)).toBe(false);
    });

    it('closeAll clears all connections', () => {
      AppDbService.getConnection(fakeAppId);
      AppDbService.getConnection(fakeAppId2);
      expect(AppDbService._connections.size).toBe(2);

      AppDbService.closeAll();
      expect(AppDbService._connections.size).toBe(0);
    });

    it('hasDatabase returns false before first use', () => {
      expect(AppDbService.hasDatabase(fakeAppId)).toBe(false);
    });

    it('hasDatabase returns true after first use', () => {
      AppDbService.getConnection(fakeAppId);
      expect(AppDbService.hasDatabase(fakeAppId)).toBe(true);
    });
  });
});
