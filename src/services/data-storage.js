/**
 * Data Storage Service
 * Auto-discovers all agent-scoped tables and provides browsing access.
 * Memory sources/chunks still work as before; other tables appear as flat sources.
 */

// Tables to exclude from discovery (metadata-only, FTS, system)
const EXCLUDE_TABLES = new Set([
  'memory_sources',       // metadata only — chunks are the useful data
  'memory_fts',           // FTS virtual table
  'capability_fts',       // FTS virtual table
  'skill_catalog_fts',    // FTS virtual table
  'embedding_cache',      // internal cache, not agent-scoped
  'apps',                 // system table
  'settings',             // system table
  'claude_instructions',  // system table
  'env_variables',        // system table
  'app_env_variables',    // not useful to browse
  'provider_credentials', // system table
  'connections',          // system table
  'connection_grants',    // system table
  'tasks',                // has its own UI
  'agents',               // has its own UI
  'ai_providers',         // system table
  'ai_containers',        // system table
  'ai_model_families',    // system table
  'ai_models',            // system table
  'ai_account_status',    // system table
  'api_key_catalog',      // system table
  'routing_cascade',      // system table
  'skill_catalog',        // system table
  'capabilities',         // system table
  'agent_threads',        // complex relational
  'agent_messages',       // complex relational
  'telegram_groups',      // system table
]);

// Columns to skip when displaying row data (BLOBs, hashes, large internal fields)
const SKIP_COLUMNS = new Set(['embedding', 'image_data', 'text_hash', 'source_hash']);

class DataStorageService {
  /**
   * Discover all tables that have an agent_id or app_id column
   * @param {object} db
   * @returns {Array<{name: string, scope_column: string, columns: Array}>}
   */
  static _discoverTables(db) {
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
    ).all();

    const result = [];
    for (const { name } of tables) {
      if (EXCLUDE_TABLES.has(name)) continue;

      const columns = db.prepare(`PRAGMA table_info("${name}")`).all();
      const colNames = columns.map(c => c.name);

      // Check for agent_id or app_id scope column
      let scopeCol = null;
      if (colNames.includes('agent_id')) scopeCol = 'agent_id';
      else if (colNames.includes('app_id')) scopeCol = 'app_id';

      if (scopeCol) {
        // Find the primary key column(s)
        const pkCols = columns.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk);
        result.push({
          name,
          scope_column: scopeCol,
          columns: columns.map(c => ({ name: c.name, type: c.type })),
          pk: pkCols.length === 1 ? pkCols[0].name : null, // single PK or null for composite
        });
      }
    }
    return result;
  }

  /**
   * Get all sources for an agent/app with row counts.
   * Memory chunks are grouped by memory_sources (legacy). Other tables are flat sources.
   */
  static getSources(db, scopeId) {
    const sources = [];

    // 1. Memory sources (grouped by source name, legacy behavior)
    try {
      const memSources = db.prepare(`
        SELECT
          ms.source,
          ms.type,
          COUNT(mc.id) as chunk_count
        FROM memory_sources ms
        LEFT JOIN memory_chunks mc ON ms.app_id = mc.app_id AND ms.source = mc.source
        WHERE ms.app_id = ?
        GROUP BY ms.source
        ORDER BY ms.source
      `).all(scopeId);

      for (const ms of memSources) {
        sources.push({
          source: ms.source,
          chunk_count: ms.chunk_count,
          type: 'memory',
        });
      }
    } catch (e) {
      // memory_sources table may not exist yet
    }

    // 2. Auto-discovered agent-scoped tables
    const tables = DataStorageService._discoverTables(db);
    for (const table of tables) {
      if (table.name === 'memory_chunks') continue; // handled above via memory_sources

      try {
        const count = db.prepare(
          `SELECT COUNT(*) as cnt FROM "${table.name}" WHERE "${table.scope_column}" = ?`
        ).get(scopeId);

        if (count && count.cnt > 0) {
          sources.push({
            source: table.name,
            chunk_count: count.cnt,
            type: 'table',
          });
        }
      } catch (e) {
        // Skip tables that error
      }
    }

    // 3. Per-app database tables (~/os8/apps/{appId}/data.db)
    try {
      const AppDbService = require('./app-db');
      if (AppDbService.hasDatabase(scopeId)) {
        const schema = AppDbService.getSchema(scopeId);
        for (const table of schema.tables) {
          const appDb = AppDbService.getConnection(scopeId);
          const count = appDb.prepare(`SELECT COUNT(*) as cnt FROM "${table.name}"`).get();
          sources.push({
            source: table.name,
            chunk_count: count?.cnt || 0,
            type: 'appdb',
          });
        }
      }
    } catch (e) {
      // App DB may not exist or may have errors — skip
    }

    return sources;
  }

  /**
   * Get rows for a source.
   * If source matches a memory_sources entry, use legacy memory_chunks query.
   * Otherwise, query the table directly.
   */
  static getChunks(db, scopeId, source, limit = 100, offset = 0, sourceType = null) {
    // Per-app database tables
    if (sourceType === 'appdb') {
      const tableName = source;
      const AppDbService = require('./app-db');
      const appDb = AppDbService.getConnection(scopeId);

      const columns = appDb.pragma(`table_info("${tableName}")`);
      const colNames = columns.map(c => c.name);
      const pkCols = columns.filter(c => c.pk > 0);
      const pk = pkCols.length === 1 ? pkCols[0].name : null;

      const selectCols = columns
        .filter(c => !SKIP_COLUMNS.has(c.name) && c.type !== 'BLOB')
        .map(c => `"${c.name}"`);
      if (selectCols.length === 0) return [];

      const orderCol = colNames.includes('created_at') ? 'created_at'
        : colNames.includes('updated_at') ? 'updated_at' : pk;
      const orderClause = orderCol ? `ORDER BY "${orderCol}" DESC` : '';

      const rows = appDb.prepare(
        `SELECT ${selectCols.join(', ')} FROM "${tableName}" ${orderClause} LIMIT ? OFFSET ?`
      ).all(limit, offset);

      const table = { name: tableName, columns, pk };
      return rows.map((row, idx) => {
        const preview = DataStorageService._buildPreview(row, table);
        const pkValue = pk ? row[pk] : null;
        return {
          id: `appdb:${tableName}:${pkValue || (offset + idx)}`,
          chunk_index: offset + idx + 1,
          text: preview,
          category: tableName,
          _raw: row,
          _table: tableName,
        };
      });
    }

    // Check if this is a memory source (exists in memory_sources table)
    const isMemorySource = (() => {
      try {
        const row = db.prepare(
          `SELECT 1 FROM memory_sources WHERE app_id = ? AND source = ? LIMIT 1`
        ).get(scopeId, source);
        return !!row;
      } catch (e) {
        return false;
      }
    })();

    if (isMemorySource) {
      // Legacy memory_chunks query
      return db.prepare(`
        SELECT id, app_id, text, source, chunk_index, category, created_at, updated_at
        FROM memory_chunks
        WHERE app_id = ? AND source = ?
        ORDER BY chunk_index
        LIMIT ? OFFSET ?
      `).all(scopeId, source, limit, offset);
    }

    // Generic table query
    const tables = DataStorageService._discoverTables(db);
    const table = tables.find(t => t.name === source);
    if (!table) return [];

    // Select all columns except BLOBs
    const selectCols = table.columns
      .filter(c => !SKIP_COLUMNS.has(c.name) && c.type !== 'BLOB')
      .map(c => `"${c.name}"`);

    if (selectCols.length === 0) return [];

    // Sort newest-first: prefer created_at, then updated_at, then PK descending
    const colNames = table.columns.map(c => c.name);
    const orderCol = colNames.includes('created_at') ? 'created_at'
      : colNames.includes('updated_at') ? 'updated_at'
      : table.pk;
    const orderClause = orderCol ? `ORDER BY "${orderCol}" DESC` : '';

    const rows = db.prepare(
      `SELECT ${selectCols.join(', ')} FROM "${table.name}" WHERE "${table.scope_column}" = ? ${orderClause} LIMIT ? OFFSET ?`
    ).all(scopeId, limit, offset);

    // Map to chunk-like objects for the renderer
    return rows.map((row, idx) => {
      const preview = DataStorageService._buildPreview(row, table);
      const pkValue = table.pk ? row[table.pk] : null;

      return {
        id: `${table.name}:${pkValue || (offset + idx)}`,
        chunk_index: offset + idx + 1,
        text: preview,
        category: table.name,
        _raw: row,
        _table: table.name,
      };
    });
  }

  /**
   * Get a single row by encoded ID.
   * For memory chunks: integer ID. For generic tables: "tableName:pk".
   */
  static getChunk(db, chunkId, scopeId = null) {
    // Per-app database row
    if (typeof chunkId === 'string' && chunkId.startsWith('appdb:')) {
      const rest = chunkId.substring(6);
      const colonIdx = rest.indexOf(':');
      const tableName = rest.substring(0, colonIdx);
      const pkValue = rest.substring(colonIdx + 1);

      if (!scopeId) return null;
      const AppDbService = require('./app-db');
      const appDb = AppDbService.getConnection(scopeId);

      const columns = appDb.pragma(`table_info("${tableName}")`);
      const pkCols = columns.filter(c => c.pk > 0);
      const pk = pkCols.length === 1 ? pkCols[0].name : null;
      if (!pk) return null;

      const selectCols = columns
        .filter(c => !SKIP_COLUMNS.has(c.name) && c.type !== 'BLOB')
        .map(c => `"${c.name}"`);

      const row = appDb.prepare(
        `SELECT ${selectCols.join(', ')} FROM "${tableName}" WHERE "${pk}" = ?`
      ).get(pkValue);

      if (!row) return null;
      return { id: chunkId, _table: tableName, _fields: row };
    }

    // Try to parse as generic table reference
    if (typeof chunkId === 'string' && chunkId.includes(':')) {
      const colonIdx = chunkId.indexOf(':');
      const tableName = chunkId.substring(0, colonIdx);
      const pkValue = chunkId.substring(colonIdx + 1);

      const tables = DataStorageService._discoverTables(db);
      const table = tables.find(t => t.name === tableName);
      if (!table || !table.pk) return null;

      const selectCols = table.columns
        .filter(c => !SKIP_COLUMNS.has(c.name) && c.type !== 'BLOB')
        .map(c => `"${c.name}"`);

      const row = db.prepare(
        `SELECT ${selectCols.join(', ')} FROM "${table.name}" WHERE "${table.pk}" = ?`
      ).get(pkValue);

      if (!row) return null;

      return {
        id: chunkId,
        _table: table.name,
        _fields: row,
      };
    }

    // Legacy: memory_chunks by integer ID
    const numId = typeof chunkId === 'string' ? parseInt(chunkId, 10) : chunkId;
    const chunk = db.prepare(`
      SELECT id, app_id, text, source, chunk_index, category, created_at, updated_at
      FROM memory_chunks WHERE id = ?
    `).get(numId);

    return chunk || null;
  }

  /**
   * Delete a single row by encoded ID.
   * For memory chunks: integer ID. For generic tables: "tableName:pk".
   * Returns true if deleted, false if not found.
   */
  static async deleteChunk(db, chunkId, scopeId = null) {
    // Per-app database row
    if (typeof chunkId === 'string' && chunkId.startsWith('appdb:')) {
      const rest = chunkId.substring(6);
      const colonIdx = rest.indexOf(':');
      const tableName = rest.substring(0, colonIdx);
      const pkValue = rest.substring(colonIdx + 1);

      if (!scopeId) return false;
      const AppDbService = require('./app-db');
      const appDb = AppDbService.getConnection(scopeId);

      const columns = appDb.pragma(`table_info("${tableName}")`);
      const pkCols = columns.filter(c => c.pk > 0);
      const pk = pkCols.length === 1 ? pkCols[0].name : null;
      if (!pk) return false;

      const result = appDb.prepare(
        `DELETE FROM "${tableName}" WHERE "${pk}" = ?`
      ).run(pkValue);
      return result.changes > 0;
    }

    // Try to parse as generic table reference
    if (typeof chunkId === 'string' && chunkId.includes(':')) {
      const colonIdx = chunkId.indexOf(':');
      const tableName = chunkId.substring(0, colonIdx);
      const pkValue = chunkId.substring(colonIdx + 1);

      // Deep delete for conversation entries — cascades to digests, chunks, threads, backups
      if (tableName === 'conversation_entries') {
        const ConversationService = require('./conversation');
        return ConversationService.deepDeleteEntry(db, parseInt(pkValue, 10));
      }

      const tables = DataStorageService._discoverTables(db);
      const table = tables.find(t => t.name === tableName);
      if (!table || !table.pk) return false;

      const result = db.prepare(
        `DELETE FROM "${table.name}" WHERE "${table.pk}" = ?`
      ).run(pkValue);

      return result.changes > 0;
    }

    // Legacy: memory_chunks by integer ID
    const numId = typeof chunkId === 'string' ? parseInt(chunkId, 10) : chunkId;
    const result = db.prepare(`DELETE FROM memory_chunks WHERE id = ?`).run(numId);
    return result.changes > 0;
  }

  /**
   * Get summary statistics across all agent-scoped tables
   */
  static getStats(db, scopeId) {
    const tables = DataStorageService._discoverTables(db);
    let totalRows = 0;
    const tableCounts = [];

    for (const table of tables) {
      try {
        const count = db.prepare(
          `SELECT COUNT(*) as cnt FROM "${table.name}" WHERE "${table.scope_column}" = ?`
        ).get(scopeId);
        const cnt = count?.cnt || 0;
        if (cnt > 0) {
          tableCounts.push({ table: table.name, count: cnt });
          totalRows += cnt;
        }
      } catch (e) {
        // skip
      }
    }

    return {
      sourceCount: tableCounts.length,
      chunkCount: totalRows,
      categories: tableCounts.map(t => ({ category: t.table, count: t.count })),
    };
  }

  /**
   * Build a human-readable preview string from a row
   */
  static _buildPreview(row, table) {
    // Priority columns for preview text
    const previewCols = ['content', 'text', 'description', 'name', 'title', 'speaker'];
    for (const col of previewCols) {
      if (row[col] && typeof row[col] === 'string' && row[col].trim()) {
        // For conversation_entries, prefix with speaker
        if (table.name === 'conversation_entries' && col === 'content' && row.speaker) {
          return `[${row.speaker}] ${row.content}`;
        }
        return row[col];
      }
    }
    // Fallback: first non-ID string column
    for (const [key, val] of Object.entries(row)) {
      if (key === 'id' || key.endsWith('_id') || key === 'date_key') continue;
      if (typeof val === 'string' && val.trim()) return val;
    }
    return JSON.stringify(row);
  }
}

module.exports = DataStorageService;
