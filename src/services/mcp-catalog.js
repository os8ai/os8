const fs = require('fs');
const path = require('path');
const { generateId } = require('../utils');

/**
 * McpCatalogService — manages the MCP server catalog index.
 *
 * Follows the same pattern as SkillCatalogService:
 * - Snapshot seed for offline/first-boot
 * - Search with trust-weighted ranking
 * - Install from catalog into mcp_servers table
 */
class McpCatalogService {

  /**
   * Seed the catalog from the bundled JSON snapshot.
   * Only runs if the catalog is empty (first boot).
   */
  static seedFromSnapshot(db) {
    const count = db.prepare('SELECT COUNT(*) as cnt FROM mcp_catalog').get().cnt;
    if (count > 0) return 0;

    const snapshotPath = path.join(__dirname, '..', 'data', 'mcp-catalog-snapshot.json');
    if (!fs.existsSync(snapshotPath)) {
      console.warn('[McpCatalog] No snapshot file found at', snapshotPath);
      return 0;
    }

    let servers;
    try {
      servers = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
    } catch (e) {
      console.warn('[McpCatalog] Failed to parse snapshot:', e.message);
      return 0;
    }

    if (!Array.isArray(servers) || servers.length === 0) return 0;

    const insert = db.prepare(`
      INSERT OR IGNORE INTO mcp_catalog
        (id, name, description, source, transport, command, args, npm_package,
         download_count, verified, official, categories, author)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((items) => {
      let inserted = 0;
      for (const s of items) {
        try {
          insert.run(
            s.id || generateId(),
            s.name,
            s.description || '',
            s.source || 'snapshot',
            s.transport || 'stdio',
            s.command || null,
            s.args ? JSON.stringify(s.args) : null,
            s.npm_package || null,
            s.download_count || 0,
            s.verified ? 1 : 0,
            s.official ? 1 : 0,
            s.categories ? JSON.stringify(s.categories) : null,
            s.author || null
          );
          inserted++;
        } catch (e) {
          // Skip duplicates or bad entries
        }
      }
      return inserted;
    });

    const inserted = insertMany(servers);

    // Build FTS index
    try {
      db.exec("INSERT INTO mcp_catalog_fts(mcp_catalog_fts) VALUES('rebuild')");
    } catch (e) {
      console.warn('[McpCatalog] FTS rebuild warning:', e.message);
    }

    console.log(`[McpCatalog] Seeded ${inserted} MCP servers from snapshot`);
    return inserted;
  }

  /**
   * Search — queries the official MCP Registry API first, falls back to local FTS.
   * Registry results are upserted into local catalog so install() works seamlessly.
   */
  static async search(db, query, options = {}) {
    const { topK = 15 } = options;

    // Try the official MCP Registry first
    try {
      const registryResults = await this._searchRegistry(query, topK);
      if (registryResults.length > 0) {
        this._upsertRegistryResults(db, registryResults);
        return registryResults.slice(0, topK);
      }
    } catch (e) {
      // Registry unreachable — fall back to local
    }

    // Fallback: local FTS/LIKE search
    return this._searchLocal(db, query, topK);
  }

  /**
   * Query the official MCP Registry at registry.modelcontextprotocol.io
   * The registry uses narrow keyword matching, so we split the query into
   * individual words and search each one in parallel, then merge + deduplicate.
   */
  static async _searchRegistry(query, limit = 15) {
    const STOP_WORDS = new Set([
      'the','a','an','and','or','for','to','in','on','of','is','are','was','with',
      'your','you','its','can','has','be','as','at','by','from','that','this','my',
      'agent','who','manages','helps','does','will','also','like','about','them',
      'their','they','me','i','we','our','would','should','could'
    ]);

    // Extract meaningful keywords from the query
    const keywords = (query || '')
      .replace(/['"*(){}[\]^~\\:!@#$%&,./;]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w.toLowerCase()))
      .map(w => w.toLowerCase());

    // Deduplicate keywords, take up to 5
    const uniqueKeywords = [...new Set(keywords)].slice(0, 5);

    // Fire parallel searches: one per keyword + one with no query (popular/featured)
    const searches = uniqueKeywords.map(kw => this._fetchRegistryPage(kw, 10));
    if (uniqueKeywords.length > 0) {
      searches.push(this._fetchRegistryPage('', 10)); // popular fallback
    }

    const allResults = await Promise.allSettled(searches);

    // Merge and deduplicate by registry name
    const seen = new Map();
    for (const result of allResults) {
      if (result.status !== 'fulfilled') continue;
      for (const entry of result.value) {
        if (!seen.has(entry.registryName)) {
          seen.set(entry.registryName, entry);
        }
      }
    }

    const merged = [...seen.values()];

    // Score: entries matched by keywords rank higher than the popular fallback
    // (the popular batch entries that weren't also keyword-matched sort last)
    return merged.slice(0, limit);
  }

  /**
   * Fetch a single page from the registry API.
   */
  static async _fetchRegistryPage(searchTerm, limit) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (searchTerm) params.set('search', searchTerm);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(
        `https://registry.modelcontextprotocol.io/v0/servers?${params}`,
        { signal: controller.signal }
      );
      clearTimeout(timeout);
      if (!res.ok) return [];
      const data = await res.json();
      if (!data.servers || !Array.isArray(data.servers)) return [];
      return data.servers.map((entry, i) => this._mapRegistryEntry(entry, i));
    } catch (e) {
      clearTimeout(timeout);
      return [];
    }
  }

  /**
   * Map a registry API entry to our internal catalog format.
   */
  static _mapRegistryEntry(entry, index = 0) {
    const server = entry.server || {};
    const meta = entry._meta?.['io.modelcontextprotocol.registry/official'] || {};
    const pkg = (server.packages || [])[0] || {};

    // Derive a stable ID from the registry name
    const registryName = server.name || '';
    const id = `registry:${registryName}`;

    // Extract friendly display name from qualified name (e.g. "io.github.user/server-name" → "Server Name")
    const rawName = registryName.split('/').pop() || registryName;
    const displayName = rawName
      .replace(/^(mcp-|server-)/i, '')
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());

    const transport = pkg.transport?.type || 'stdio';
    const isNpm = pkg.registryType === 'npm';
    const npmPackage = isNpm ? pkg.identifier : null;

    // Build command/args for stdio npm packages
    let command = null;
    let args = [];
    if (isNpm && transport === 'stdio') {
      command = 'npx';
      args = ['-y', pkg.identifier];
      // Add required arguments as placeholders
      if (pkg.packageArguments) {
        for (const arg of pkg.packageArguments) {
          if (arg.isRequired && arg.default) {
            args.push(String(arg.default));
          }
        }
      }
    }

    return {
      id,
      name: displayName || rawName,
      registryName,
      description: server.description || '',
      source: 'registry',
      transport,
      command,
      args,
      npm_package: npmPackage,
      version: server.version || pkg.version || null,
      author: registryName.split('/')[0] || null,
      download_count: 0,
      verified: meta.status === 'active' ? 1 : 0,
      official: registryName.startsWith('io.github.modelcontextprotocol/') ? 1 : 0,
      categories: [],
      repository_url: server.repository?.url || null,
      score: 1 / (1 + index)  // preserve registry ordering
    };
  }

  /**
   * Upsert registry search results into local mcp_catalog for install().
   */
  static _upsertRegistryResults(db, results) {
    const upsert = db.prepare(`
      INSERT OR REPLACE INTO mcp_catalog
        (id, name, description, source, transport, command, args, npm_package,
         download_count, verified, official, categories, author, version, source_url, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    const upsertMany = db.transaction((items) => {
      for (const s of items) {
        try {
          upsert.run(
            s.id,
            s.name,
            s.description || '',
            'registry',
            s.transport || 'stdio',
            s.command || null,
            s.args ? JSON.stringify(s.args) : null,
            s.npm_package || null,
            s.download_count || 0,
            s.verified ? 1 : 0,
            s.official ? 1 : 0,
            s.categories ? JSON.stringify(s.categories) : null,
            s.author || null,
            s.version || null,
            s.repository_url || null
          );
        } catch (e) {
          // Skip bad entries
        }
      }
    });

    upsertMany(results);
  }

  /**
   * Local FTS/LIKE search fallback.
   */
  static _searchLocal(db, query, topK) {
    if (!query || !query.trim()) {
      return db.prepare('SELECT * FROM mcp_catalog ORDER BY download_count DESC LIMIT ?')
        .all(topK).map(r => this._parseRow(r));
    }

    const STOP_WORDS = new Set(['the','a','an','and','or','for','to','in','on','of','is','are','was','with','your','you','its','can','has','be','as','at','by','from']);
    const words = query
      .replace(/['"*(){}[\]^~\\:!@#$%&,./;]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w.toLowerCase()));

    let results = [];

    // Try FTS5 search
    if (words.length > 0) {
      const ftsQuery = words.join(' OR ');
      try {
        results = db.prepare(`
          SELECT mc.*, mcp_catalog_fts.rank as fts_rank
          FROM mcp_catalog mc
          JOIN mcp_catalog_fts ON mc.rowid = mcp_catalog_fts.rowid
          WHERE mcp_catalog_fts MATCH ?
          ORDER BY mcp_catalog_fts.rank
          LIMIT ?
        `).all(ftsQuery, topK * 3);
      } catch (e) {
        // FTS match failure — fall back to LIKE
      }
    }

    // Fallback: LIKE search
    if (results.length === 0 && words.length > 0) {
      const likeWords = words.slice(0, 3);
      const conditions = likeWords.map(() => '(name LIKE ? OR description LIKE ?)').join(' OR ');
      const params = likeWords.flatMap(w => [`%${w}%`, `%${w}%`]);
      results = db.prepare(`
        SELECT * FROM mcp_catalog
        WHERE ${conditions}
        ORDER BY download_count DESC
        LIMIT ?
      `).all(...params, topK * 3);
    }

    // Trust-weighted ranking
    if (results.length > 0) {
      const maxDownloads = Math.max(...results.map(r => r.download_count || 0), 1);

      results = results.map((r, i) => {
        const searchScore = 1 / (20 + i + 1);
        const downloadScore = Math.log(1 + (r.download_count || 0)) / Math.log(1 + maxDownloads);
        const trustScore = (r.verified ? 0.5 : 0) + (r.official ? 0.5 : 0);
        const ratingScore = r.rating ? r.rating / 5.0 : 0;

        const score =
          0.50 * searchScore +
          0.25 * downloadScore +
          0.15 * trustScore +
          0.10 * ratingScore;

        return { ...this._parseRow(r), score };
      });

      results.sort((a, b) => b.score - a.score);
    } else {
      results = results.map(r => this._parseRow(r));
    }

    return results.slice(0, topK);
  }

  /**
   * Get a single catalog entry by ID.
   */
  static getById(db, id) {
    const row = db.prepare('SELECT * FROM mcp_catalog WHERE id = ?').get(id);
    return row ? this._parseRow(row) : null;
  }

  /**
   * Get catalog stats.
   */
  static getStats(db) {
    return db.prepare(`
      SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN verified = 1 THEN 1 END) as verified,
        COUNT(CASE WHEN official = 1 THEN 1 END) as official,
        MAX(synced_at) as last_synced
      FROM mcp_catalog
    `).get();
  }

  /**
   * Install an MCP server from the catalog.
   * Creates an entry in mcp_servers from catalog metadata.
   * Does NOT auto-start (user can start manually or set auto_start).
   */
  static install(db, catalogId) {
    const McpServerService = require('./mcp-server');
    const entry = this.getById(db, catalogId);
    if (!entry) throw new Error('Catalog entry not found');

    // Check if already installed
    const existing = db.prepare(
      'SELECT id FROM mcp_servers WHERE catalog_id = ?'
    ).get(catalogId);
    if (existing) return { serverId: existing.id, alreadyInstalled: true };

    const result = McpServerService.add(db, {
      id: `mcp-${entry.name.toLowerCase().replace(/\s+/g, '-')}-${Date.now().toString(36)}`,
      name: entry.name,
      description: entry.description,
      transport: entry.transport || 'stdio',
      command: entry.command || 'npx',
      args: entry.args || (entry.npm_package ? ['-y', entry.npm_package] : []),
      source: 'catalog',
      catalogId
    });

    return { serverId: result.id, alreadyInstalled: false, npmPackage: entry.npm_package };
  }

  static _parseRow(row) {
    if (!row) return null;
    return {
      ...row,
      categories: row.categories ? JSON.parse(row.categories) : [],
      args: row.args ? JSON.parse(row.args) : [],
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      embedding: undefined
    };
  }
}

module.exports = McpCatalogService;
