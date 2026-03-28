/**
 * AppDbService — Per-app SQLite database management.
 *
 * Each app gets its own SQLite file at ~/os8/apps/{appId}/data.db,
 * lazily created on first API call. Connections are cached in a Map
 * and cleaned up on app delete or server shutdown.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const config = require('../config');

// Statements allowed on the /query endpoint (read-only)
const READ_PREFIXES = ['SELECT', 'WITH'];

// Statements allowed on the /execute endpoint (write + DDL)
const WRITE_PREFIXES = [
  'INSERT', 'UPDATE', 'DELETE', 'REPLACE',
  'CREATE', 'ALTER', 'DROP'
];

// Statements that are always blocked (security)
const BLOCKED_PATTERNS = [
  /^\s*ATTACH\b/i,
  /^\s*DETACH\b/i,
  /^\s*PRAGMA\b/i,
  /^\s*LOAD_EXTENSION\b/i,
  /^\s*REINDEX\b/i,
  /^\s*VACUUM\b/i,
];

function getFirstKeyword(sql) {
  const trimmed = sql.trim();
  const match = trimmed.match(/^(\w+)/);
  return match ? match[1].toUpperCase() : '';
}

function isBlocked(sql) {
  return BLOCKED_PATTERNS.some(pattern => pattern.test(sql));
}

function isReadStatement(sql) {
  const keyword = getFirstKeyword(sql);
  return READ_PREFIXES.includes(keyword);
}

function isWriteStatement(sql) {
  const keyword = getFirstKeyword(sql);
  return WRITE_PREFIXES.includes(keyword);
}

const AppDbService = {
  /** @type {Map<string, import('better-sqlite3').Database>} */
  _connections: new Map(),

  /**
   * Get the database file path for an app.
   */
  getDbPath(appId) {
    return path.join(config.APPS_DIR, appId, 'data.db');
  },

  /**
   * Get or lazily create a database connection for an app.
   * Validates the app directory exists to prevent path traversal.
   * @returns {import('better-sqlite3').Database}
   */
  getConnection(appId) {
    if (this._connections.has(appId)) {
      return this._connections.get(appId);
    }

    const appDir = path.join(config.APPS_DIR, appId);
    if (!fs.existsSync(appDir)) {
      throw new Error(`App directory not found: ${appId}`);
    }

    const dbPath = this.getDbPath(appId);
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    this._connections.set(appId, db);
    return db;
  },

  /**
   * Close a specific app's database connection.
   */
  closeConnection(appId) {
    const db = this._connections.get(appId);
    if (db) {
      try { db.close(); } catch (e) { /* already closed */ }
      this._connections.delete(appId);
    }
  },

  /**
   * Close all open app database connections (shutdown cleanup).
   */
  closeAll() {
    for (const [appId, db] of this._connections) {
      try { db.close(); } catch (e) { /* ignore */ }
    }
    this._connections.clear();
  },

  /**
   * Execute a read-only query (SELECT/WITH).
   * @returns {{ rows: object[], columns: string[] }}
   */
  query(appId, sql, params = []) {
    if (isBlocked(sql)) {
      throw new Error('Statement not allowed');
    }
    if (!isReadStatement(sql)) {
      throw new Error('Only SELECT statements are allowed on /query. Use /execute for writes.');
    }

    const db = this.getConnection(appId);
    const stmt = db.prepare(sql);
    const rows = stmt.all(...params);
    const columns = stmt.columns().map(c => c.name);
    return { rows, columns };
  },

  /**
   * Execute a write statement (INSERT/UPDATE/DELETE/CREATE/ALTER/DROP).
   * @returns {{ changes: number, lastInsertRowid: number|bigint }}
   */
  execute(appId, sql, params = []) {
    if (isBlocked(sql)) {
      throw new Error('Statement not allowed');
    }
    if (!isWriteStatement(sql)) {
      throw new Error('Only write/DDL statements are allowed on /execute. Use /query for SELECT.');
    }

    const db = this.getConnection(appId);
    const result = db.prepare(sql).run(...params);
    return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
  },

  /**
   * Execute multiple statements in a single transaction.
   * @returns {{ results: Array<{ changes: number, lastInsertRowid: number|bigint }> }}
   */
  batch(appId, statements) {
    if (!Array.isArray(statements) || statements.length === 0) {
      throw new Error('statements must be a non-empty array');
    }

    // Validate all statements before executing any
    for (const stmt of statements) {
      if (!stmt.sql) throw new Error('Each statement must have a sql field');
      if (isBlocked(stmt.sql)) throw new Error('Statement not allowed');

      const keyword = getFirstKeyword(stmt.sql);
      if (!READ_PREFIXES.includes(keyword) && !WRITE_PREFIXES.includes(keyword)) {
        throw new Error(`Statement not allowed: ${keyword}`);
      }
    }

    const db = this.getConnection(appId);
    const results = [];

    const runBatch = db.transaction(() => {
      for (const { sql, params = [] } of statements) {
        if (isReadStatement(sql)) {
          const stmt = db.prepare(sql);
          const rows = stmt.all(...params);
          const columns = stmt.columns().map(c => c.name);
          results.push({ rows, columns });
        } else {
          const result = db.prepare(sql).run(...params);
          results.push({ changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) });
        }
      }
    });

    runBatch();
    return { results };
  },

  /**
   * Get schema for all tables in the app's database.
   * @returns {{ tables: Array<{ name: string, columns: object[] }> }}
   */
  getSchema(appId) {
    const db = this.getConnection(appId);

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all();

    return {
      tables: tables.map(t => ({
        name: t.name,
        columns: db.pragma(`table_info(${t.name})`)
      }))
    };
  },

  /**
   * Get schema for a specific table.
   * @returns {{ name: string, columns: object[], sql: string }}
   */
  getTableSchema(appId, tableName) {
    const db = this.getConnection(appId);

    // Validate table exists (prevent injection via table name)
    const tableInfo = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(tableName);

    if (!tableInfo) {
      return null;
    }

    return {
      name: tableName,
      columns: db.pragma(`table_info(${tableName})`),
      sql: tableInfo.sql
    };
  },

  /**
   * Check if an app has a database file (without creating one).
   */
  hasDatabase(appId) {
    return fs.existsSync(this.getDbPath(appId));
  }
};

module.exports = AppDbService;
