const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { generateId } = require('../utils');
const { ConnectionsService } = require('./connections');
const SettingsService = require('./settings');
/**
 * CapabilityService — Runtime CRUD, search, pins, and availability for capabilities.
 *
 * Single `capabilities` table holds API endpoints (type='api'),
 * multi-step skills (type='skill'), and MCP tools (type='mcp').
 *
 * Sync/registration logic lives in capability-sync.js (CapabilitySyncService).
 *
 * Follows OS8 service conventions: static methods, db as first param.
 */
const AgentService = require('./agent');

class CapabilityService {

  /**
   * Read a skill's display name from its SKILL.md frontmatter or first heading.
   * @param {string} skillMdPath - Path to SKILL.md
   * @param {string} fallbackName - Name to use if parsing fails
   * @returns {string}
   */
  static _readSkillName(skillMdPath, fallbackName) {
    try {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      const lines = content.split('\n');
      if (lines[0]?.trim() === '---') {
        const fmEnd = lines.findIndex((line, idx) => idx > 0 && line.trim() === '---');
        if (fmEnd > 0) {
          const fmLines = lines.slice(1, fmEnd);
          const nameLine = fmLines.find(line => line.trim().toLowerCase().startsWith('name:'));
          if (nameLine) {
            const name = nameLine.split(':').slice(1).join(':').trim();
            if (name) return name;
          }
        }
      }
      const headingLine = lines.find(line => line.trim().startsWith('# '));
      if (headingLine) {
        return headingLine.replace(/^#\s*/, '').trim() || fallbackName;
      }
    } catch (err) {
      // Fall through to fallback
    }
    return fallbackName;
  }

  /**
   * Discover skills in a directory by scanning for SKILL.md files.
   * @param {string} skillsDir - Directory to scan
   * @param {string} scope - Scope label (e.g. 'system', 'agent')
   * @param {function} pathFormatter - (skillId, skillMdPath) => display path
   * @returns {Array<{id, name, scope, path}>}
   */
  static _discoverLocalSkills(skillsDir, scope, pathFormatter) {
    if (!fs.existsSync(skillsDir)) return [];

    const skills = [];
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillMdPath = path.join(skillsDir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillMdPath)) continue;

      skills.push({
        id: entry.name,
        name: this._readSkillName(skillMdPath, entry.name),
        scope,
        path: pathFormatter(entry.name, skillMdPath)
      });
    }

    return skills;
  }

  /**
   * Get all skills available to an agent: APIs + DB skills + agent-local filesystem skills.
   * @param {object} db
   * @param {string} appId
   * @param {string} agentId
   * @returns {Array<{id, name, scope, path, skill_id?, type, description?}>}
   */
  static getSkillsForAgent(db, appId, agentId) {
    const allCaps = db ? this.getAll(db) : [];

    // APIs — only available ones
    const apis = allCaps.filter(c => c.type === 'api' && c.available).map(c => ({
      id: c.name,
      name: c.name,
      scope: 'api',
      path: c.base_path,
      skill_id: c.id,
      type: 'api',
      description: c.description || ''
    }));

    // DB-backed skills
    const dbSkills = allCaps.filter(c => c.type === 'skill').map(s => ({
      id: s.id,
      name: s.name,
      scope: s.source === 'bundled' ? 'system' : 'installed',
      path: path.join(s.base_path, 'SKILL.md'),
      skill_id: s.id,
      type: 'skill'
    }));

    // Agent-local skills (not in DB, legacy filesystem-based)
    let agentSkills = [];
    if (appId && agentId) {
      const { agentDir } = AgentService.getPaths(appId, agentId);
      const agentSkillsDir = path.join(agentDir, 'skills');
      agentSkills = this._discoverLocalSkills(
        agentSkillsDir,
        'agent',
        (skillId) => `skills/${skillId}/SKILL.md`
      ).map(s => ({ ...s, type: 'skill' }));
    }

    const scopeOrder = { api: 0, system: 1, installed: 2, agent: 3 };
    return [...apis, ...dbSkills, ...agentSkills].sort((a, b) => {
      if (a.scope !== b.scope) return (scopeOrder[a.scope] ?? 4) - (scopeOrder[b.scope] ?? 4);
      return a.name.localeCompare(b.name);
    });
  }

  // ──────────────────────────────────────────────
  // Availability
  // ──────────────────────────────────────────────

  /**
   * Recompute `available` column for all capabilities.
   * Checks env_required against env_variables table,
   * and connection against OAuth connections table.
   * For MCP capabilities, checks if parent server is running.
   */
  static refreshAvailability(db) {
    const caps = db.prepare(
      'SELECT id, type, env_required, bins_required, connection, connection_scopes FROM capabilities'
    ).all();

    if (caps.length === 0) return;

    // Build env set
    const envVars = db.prepare('SELECT key, value FROM env_variables').all();
    const envSet = new Set();
    for (const ev of envVars) {
      if (ev.value && ev.value.trim()) envSet.add(ev.key);
    }

    // Build OAuth provider → scopes map
    const connections = ConnectionsService.getAllConnections(db);
    const providerScopes = {};
    for (const conn of connections) {
      const provider = conn.provider;
      const scopes = JSON.parse(conn.scopes || '[]');
      if (!providerScopes[provider]) providerScopes[provider] = new Set();
      for (const scope of scopes) providerScopes[provider].add(scope);
    }

    // Cache for binary PATH lookups (avoid re-checking same binary across skills)
    const binCache = new Map();

    // Lazy-load McpServerService to avoid circular deps
    let McpServerService;
    // Lazy-load to break circular dependency; McpServerService stays undefined if not yet available
    try { McpServerService = require('./mcp-server').McpServerService; } catch (e) {}

    const updateStmt = db.prepare('UPDATE capabilities SET available = ? WHERE id = ?');

    for (const cap of caps) {
      let available = 1;

      // MCP capabilities: check if parent server is running
      if (cap.type === 'mcp' && McpServerService) {
        const serverId = cap.id.split(':')[1];
        const status = McpServerService.getStatus(serverId);
        available = status.running ? 1 : 0;
        updateStmt.run(available, cap.id);
        continue;
      }

      // Check env_required
      if (cap.env_required) {
        const keys = cap.env_required.split(',').map(k => k.trim()).filter(Boolean);
        for (const key of keys) {
          if (!envSet.has(key)) {
            available = 0;
            break;
          }
        }
      }

      // Check bins_required (binaries on PATH)
      if (available && cap.bins_required) {
        const bins = cap.bins_required.split(',').map(b => b.trim()).filter(Boolean);
        for (const bin of bins) {
          if (!binCache.has(bin)) {
            try {
              execFileSync('which', [bin], { stdio: 'pipe' });
              binCache.set(bin, true);
            } catch (e) {
              binCache.set(bin, false);
            }
          }
          if (!binCache.get(bin)) {
            available = 0;
            break;
          }
        }
      }

      // Check OAuth connection
      if (available && cap.connection) {
        const requiredProvider = cap.connection;
        if (!providerScopes[requiredProvider]) {
          available = 0;
        } else if (cap.connection_scopes) {
          const requiredScopes = cap.connection_scopes.split(',').map(s => s.trim()).filter(Boolean);
          const connectedScopes = providerScopes[requiredProvider];
          for (const scope of requiredScopes) {
            const hasScope = Array.from(connectedScopes).some(s =>
              s === scope || s.includes(scope) || scope.includes(s)
            );
            if (!hasScope) {
              available = 0;
              break;
            }
          }
        }
      }

      updateStmt.run(available, cap.id);
    }
  }

  // ──────────────────────────────────────────────
  // CRUD Operations
  // ──────────────────────────────────────────────

  /**
   * Get all capabilities.
   */
  static getAll(db) {
    return db.prepare(`
      SELECT id, type, name, description, scope, agent_id, env_required,
        bins_required, connection, connection_scopes, available, base_path,
        endpoints, search_description, version, license, metadata, source,
        source_url, catalog_id, homepage, quarantine, usage_count,
        last_used_at, created_at, updated_at,
        review_status, review_risk_level, reviewed_at, approved_at
      FROM capabilities
      ORDER BY name
    `).all().map(this._parseRow);
  }

  /**
   * Get a single capability by ID with full details.
   */
  static getById(db, id) {
    const row = db.prepare('SELECT * FROM capabilities WHERE id = ?').get(id);
    if (!row) return null;
    return this._parseRow(row);
  }

  /**
   * Get capabilities by type ('api' or 'skill').
   */
  static getByType(db, type) {
    return db.prepare('SELECT * FROM capabilities WHERE type = ? ORDER BY name')
      .all(type).map(this._parseRow);
  }

  /**
   * Get a capability by its base path.
   */
  static getByPath(db, basePath) {
    const row = db.prepare('SELECT * FROM capabilities WHERE base_path = ?').get(basePath);
    if (!row) return null;
    return this._parseRow(row);
  }

  /**
   * Get all available capabilities (available = 1).
   */
  static getAvailable(db) {
    return db.prepare(`
      SELECT * FROM capabilities WHERE available = 1 AND quarantine = 0 ORDER BY name
    `).all().map(this._parseRow);
  }

  /**
   * Get the full documentation for a capability.
   * For skills: reads SKILL.md from disk. For APIs: returns structured endpoint info.
   * For MCP: auto-generates docs from tool inputSchema.
   */
  static getDocumentation(db, id) {
    const cap = this.getById(db, id);
    if (!cap) return null;

    if (cap.type === 'api') {
      return cap.endpoints ? JSON.stringify(cap.endpoints, null, 2) : null;
    }

    if (cap.type === 'mcp') {
      return this._generateMcpDocs(db, cap);
    }

    // Skill — read SKILL.md from disk
    const skillMdPath = path.join(cap.base_path, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) return null;

    try {
      return fs.readFileSync(skillMdPath, 'utf-8');
    } catch (e) {
      return null;
    }
  }

  /**
   * Track a capability usage event.
   */
  static trackUsage(db, capabilityId, agentId, context) {
    const id = generateId();
    db.prepare(`
      INSERT INTO capability_usage (id, capability_id, agent_id, context)
      VALUES (?, ?, ?, ?)
    `).run(id, capabilityId, agentId || null, context || null);

    db.prepare(`
      UPDATE capabilities SET usage_count = usage_count + 1, last_used_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(capabilityId);
  }

  /**
   * Get usage count for a capability by a specific agent.
   */
  static getAgentUsageCount(db, capabilityId, agentId) {
    const row = db.prepare(
      'SELECT COUNT(*) as cnt FROM capability_usage WHERE capability_id = ? AND agent_id = ?'
    ).get(capabilityId, agentId);
    return row ? row.cnt : 0;
  }

  // ──────────────────────────────────────────────
  // Pinned Capabilities
  // ──────────────────────────────────────────────

  /**
   * Get an agent's pinned capabilities.
   */
  static getPinned(db, agentId) {
    return db.prepare(`
      SELECT c.*, apc.sort_order, apc.pinned_at
      FROM agent_pinned_capabilities apc
      JOIN capabilities c ON c.id = apc.capability_id
      WHERE apc.agent_id = ?
      ORDER BY apc.sort_order
    `).all(agentId).map(this._parseRow);
  }

  /**
   * Pin a capability for an agent. Enforces max 5 pins.
   */
  static pin(db, agentId, capabilityId) {
    const count = db.prepare(
      'SELECT COUNT(*) as cnt FROM agent_pinned_capabilities WHERE agent_id = ?'
    ).get(agentId).cnt;

    if (count >= 5) {
      throw new Error('Maximum 5 pinned capabilities per agent');
    }

    db.prepare(`
      INSERT OR IGNORE INTO agent_pinned_capabilities (agent_id, capability_id, sort_order)
      VALUES (?, ?, ?)
    `).run(agentId, capabilityId, count);
  }

  /**
   * Unpin a capability from an agent.
   */
  static unpin(db, agentId, capabilityId) {
    db.prepare(
      'DELETE FROM agent_pinned_capabilities WHERE agent_id = ? AND capability_id = ?'
    ).run(agentId, capabilityId);
  }

  // ──────────────────────────────────────────────
  // Semantic Search
  // ──────────────────────────────────────────────

  /**
   * Generate an embedding for text, using the shared embedding cache.
   */
  static async _getEmbedding(db, text) {
    const { getEmbedder, getTextHash, embeddingToBuffer, bufferToEmbedding, MODEL_NAME } = require('../assistant/memory');
    const hash = getTextHash(text);

    const cached = db.prepare(
      'SELECT embedding FROM embedding_cache WHERE text_hash = ? AND model = ?'
    ).get(hash, MODEL_NAME);

    if (cached) return bufferToEmbedding(cached.embedding);

    const embed = await getEmbedder();
    const output = await embed(text, { pooling: 'mean', normalize: true });
    const embedding = new Float32Array(output.data);

    db.prepare(
      'INSERT OR REPLACE INTO embedding_cache (text_hash, model, embedding) VALUES (?, ?, ?)'
    ).run(hash, MODEL_NAME, embeddingToBuffer(embedding));

    return embedding;
  }

  /**
   * Generate embeddings for all capabilities that don't have them yet.
   */
  static async generateEmbeddings(db) {
    const { embeddingToBuffer } = require('../assistant/memory');
    const caps = db.prepare(
      'SELECT id, name, description, search_description FROM capabilities WHERE embedding IS NULL'
    ).all();

    if (caps.length === 0) return 0;

    let count = 0;
    for (const cap of caps) {
      try {
        const text = cap.search_description || cap.description || cap.name;
        const embedding = await this._getEmbedding(db, text);
        db.prepare('UPDATE capabilities SET embedding = ? WHERE id = ?').run(embeddingToBuffer(embedding), cap.id);
        count++;
      } catch (e) {
        console.warn(`[Capabilities] Embedding failed for ${cap.name}:`, e.message);
      }
    }

    if (count) console.log(`[Capabilities] Generated embeddings for ${count} capabilities`);
    return count;
  }

  /**
   * Search capabilities using hybrid vector + FTS5 ranking.
   * Hybrid ranking: vector similarity + FTS5 keyword (RRF fusion) + usage + recency.
   */
  static async search(db, query, options = {}) {
    const { cosineSimilarity, bufferToEmbedding } = require('../assistant/memory');
    const {
      topK = 5,
      agentId = null,
      includeQuarantined = false,
      type = null  // Optional: filter by 'api' or 'skill'
    } = options;

    const SEMANTIC_WEIGHT = 0.70;
    const AGENT_USAGE_WEIGHT = 0.12;
    const GLOBAL_USAGE_WEIGHT = 0.10;
    const RECENCY_WEIGHT = 0.08;
    const API_BOOST = 2.0;  // APIs rank higher — they have actionable endpoints
    const RRF_K = 20;

    let queryEmbedding;
    try {
      queryEmbedding = await this._getEmbedding(db, query);
    } catch (e) {
      console.warn('[Capabilities] Embedding generation failed, falling back to FTS-only:', e.message);
      queryEmbedding = null;
    }

    let whereClause = includeQuarantined ? '1=1' : 'quarantine = 0';
    const params = [];
    if (type) {
      whereClause += ' AND type = ?';
      params.push(type);
    }
    const allCaps = db.prepare(`SELECT rowid, * FROM capabilities WHERE ${whereClause}`).all(...params);

    if (allCaps.length === 0) return [];

    // Vector search
    const vectorRanks = new Map();
    if (queryEmbedding) {
      const scored = [];
      for (const cap of allCaps) {
        if (!cap.embedding) continue;
        const embedding = bufferToEmbedding(cap.embedding);
        const sim = cosineSimilarity(queryEmbedding, embedding);
        scored.push({ id: cap.id, score: sim });
      }
      scored.sort((a, b) => b.score - a.score);
      scored.forEach((s, i) => vectorRanks.set(s.id, i + 1));
    }

    // FTS5 keyword search (OR logic so partial matches work)
    const ftsRanks = new Map();
    try {
      const terms = query.replace(/['"*(){}[\]^~\\:!@#$%&]/g, ' ').trim().split(/\s+/).filter(Boolean);
      const ftsQuery = terms.join(' OR ');
      if (ftsQuery) {
        const ftsResults = db.prepare(
          'SELECT rowid, rank FROM capability_fts WHERE capability_fts MATCH ? ORDER BY rank LIMIT ?'
        ).all(ftsQuery, topK * 3);
        ftsResults.forEach((r, i) => ftsRanks.set(r.rowid, i + 1));
      }
    } catch (e) {
      // FTS match can fail on odd queries
    }

    // RRF fusion — compute raw search scores first, then normalize to 0-1
    const candidates = [];
    for (const cap of allCaps) {
      const vectorRank = vectorRanks.get(cap.id) || Infinity;
      const ftsRank = ftsRanks.get(cap.rowid) || Infinity;

      if (vectorRank === Infinity && ftsRank === Infinity) continue;

      const vectorRRF = vectorRank === Infinity ? 0 : 1 / (RRF_K + vectorRank);
      const ftsRRF = ftsRank === Infinity ? 0 : 1 / (RRF_K + ftsRank);
      const rawSearchScore = (vectorRRF + ftsRRF) / 2;

      candidates.push({ cap, rawSearchScore });
    }

    // Normalize search scores to 0-1 so weights work against usage (also 0-1)
    const maxSearchScore = Math.max(...candidates.map(c => c.rawSearchScore), 0.001);
    const maxGlobalUsage = Math.max(...allCaps.map(s => s.usage_count || 0), 1);
    const now = Date.now();
    const scored = [];

    for (const { cap, rawSearchScore } of candidates) {
      const searchScore = rawSearchScore / maxSearchScore;

      const globalUsage = cap.usage_count || 0;
      const normalizedGlobalUsage = Math.log(1 + globalUsage) / Math.log(1 + maxGlobalUsage);

      let normalizedAgentUsage = 0;
      if (agentId) {
        const agentUsage = this.getAgentUsageCount(db, cap.id, agentId);
        const maxAgentUsage = Math.max(agentUsage, 1);
        normalizedAgentUsage = Math.log(1 + agentUsage) / Math.log(1 + maxAgentUsage + 10);
      }

      let recencyScore = 0;
      if (cap.last_used_at) {
        const daysSince = (now - new Date(cap.last_used_at).getTime()) / (1000 * 60 * 60 * 24);
        recencyScore = Math.pow(0.95, daysSince);
      }

      const baseScore =
        SEMANTIC_WEIGHT * searchScore +
        AGENT_USAGE_WEIGHT * normalizedAgentUsage +
        GLOBAL_USAGE_WEIGHT * normalizedGlobalUsage +
        RECENCY_WEIGHT * recencyScore;
      const finalScore = (cap.type === 'api' || cap.type === 'mcp') ? baseScore * API_BOOST : baseScore;

      scored.push({
        ...this._parseRow(cap),
        score: finalScore,
        searchScore,
        usageScore: normalizedGlobalUsage
      });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /**
   * Get capabilities for agent context injection.
   * Returns pinned (always) + top semantic matches (excluding pinned).
   */
  static async getForContext(db, agentId, messageText) {
    const pinned = this.getPinned(db, agentId);
    const pinnedIds = new Set(pinned.map(c => c.id));

    const MAX_SUGGESTED = 5;
    const PER_TYPE_SLOTS = 3;

    let suggested = [];
    if (messageText) {
      const searchResults = await this.search(db, messageText, {
        topK: 15,
        agentId
      });
      const unpinned = searchResults.filter(c => !pinnedIds.has(c.id));

      // Reserve slots for each type so no single type crowds out others
      const topApis = unpinned.filter(c => c.type === 'api').slice(0, PER_TYPE_SLOTS);
      const topSkills = unpinned.filter(c => c.type === 'skill').slice(0, PER_TYPE_SLOTS);
      const topMcp = unpinned.filter(c => c.type === 'mcp').slice(0, PER_TYPE_SLOTS);

      // Merge and sort by score, take top N
      suggested = [...topApis, ...topSkills, ...topMcp]
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_SUGGESTED);
    }

    return { pinned, suggested };
  }

  /**
   * Format capabilities for agent context injection.
   * Labels entries by type so agents know whether to call an API or read a SKILL.md.
   */
  static formatForContext(db, pinned, suggested) {
    if (pinned.length === 0 && suggested.length === 0) return '';

    const lines = ['## Available Capabilities\n'];

    const formatEntry = (cap) => {
      if (cap.type === 'api') {
        return `- **${cap.name}** (API): ${cap.description} — \`${cap.base_path}\``;
      }
      if (cap.type === 'mcp') {
        const ep = (cap.endpoints || [])[0];
        return `- **${cap.name}** (MCP): ${cap.description} — \`POST ${ep ? ep.path : cap.base_path}\``;
      }
      return `- **${cap.name}** (Skill): ${cap.description}`;
    };

    if (pinned.length > 0) {
      lines.push('**Your capabilities:**');
      for (const c of pinned) {
        lines.push(formatEntry(c));
      }
      lines.push('');
    }

    if (suggested.length > 0) {
      lines.push('**Also relevant:**');
      for (const c of suggested) {
        lines.push(formatEntry(c));
      }
      lines.push('');
    }

    const port = SettingsService.get(db, 'os8Port') || '8888';
    lines.push('To use a skill, read its full documentation first:');
    lines.push('```bash');
    lines.push(`curl http://localhost:${port}/api/skills/CAPABILITY_ID`);
    lines.push('```');
    lines.push('After using a capability, report it: `POST /api/skills/CAPABILITY_ID/used`');

    return lines.join('\n');
  }

  // ──────────────────────────────────────────────
  // Utilities
  // ──────────────────────────────────────────────

  /**
   * Generate markdown documentation for an MCP capability from its endpoint data.
   */
  static _generateMcpDocs(db, cap) {
    const port = SettingsService.get(db, 'os8Port') || '8888';
    const lines = [`# ${cap.name}\n`];
    if (cap.description) lines.push(`${cap.description}\n`);

    const endpoints = cap.endpoints || [];
    if (endpoints.length > 0) {
      const ep = endpoints[0];
      lines.push('## Usage\n');
      lines.push('```bash');
      const curlParams = ep.params ? JSON.stringify(
        Object.fromEntries(Object.entries(ep.params).map(([k, v]) => {
          const type = (v || '').split(' — ')[0] || 'string';
          if (type === 'number' || type === 'integer') return [k, 0];
          if (type === 'boolean') return [k, true];
          if (type === 'array') return [k, []];
          if (type === 'object') return [k, {}];
          return [k, `<${k}>`];
        })),
        null, 2
      ) : '{}';
      lines.push(`curl -X POST http://localhost:${port}${ep.path} \\`);
      lines.push(`  -H "Content-Type: application/json" \\`);
      lines.push(`  -d '${curlParams}'`);
      lines.push('```\n');

      if (ep.params && Object.keys(ep.params).length > 0) {
        lines.push('## Parameters\n');
        for (const [key, desc] of Object.entries(ep.params)) {
          lines.push(`- **${key}**: ${desc}`);
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * Parse a DB row — deserialize JSON metadata and endpoints.
   */
  static _parseRow(row) {
    if (!row) return null;
    return {
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      endpoints: row.endpoints ? JSON.parse(row.endpoints) : null,
      embedding: undefined
    };
  }

  /**
   * Insert into FTS index. rowid must match the capabilities table rowid.
   */
  static _insertFts(db, rowid, name, description, searchDescription) {
    try {
      db.prepare(
        'INSERT INTO capability_fts(rowid, name, description, search_description) VALUES (?, ?, ?, ?)'
      ).run(rowid, name, description || '', searchDescription || '');
    } catch (e) {
      console.warn('[Capabilities] FTS insert warning:', e.message);
    }
  }

  /**
   * Update FTS index entry by rowid.
   */
  static _updateFts(db, rowid, name, description, searchDescription) {
    try {
      db.prepare("INSERT INTO capability_fts(capability_fts, rowid, name, description, search_description) VALUES('delete', ?, ?, ?, ?)")
        .run(rowid, name, description || '', searchDescription || '');
      db.prepare('INSERT INTO capability_fts(rowid, name, description, search_description) VALUES (?, ?, ?, ?)')
        .run(rowid, name, description || '', searchDescription || '');
    } catch (e) {
      console.warn('[Capabilities] FTS update warning:', e.message);
    }
  }

  /**
   * Rebuild FTS index from capabilities table. Fixes any rowid drift.
   */
  static rebuildFts(db) {
    try {
      db.prepare("INSERT INTO capability_fts(capability_fts) VALUES('rebuild')").run();
    } catch (e) {
      console.warn('[Capabilities] FTS rebuild warning:', e.message);
    }
  }
}

module.exports = {
  CapabilityService,
  // Exported for CapabilitySyncService (capability-sync.js)
  _insertFts: CapabilityService._insertFts.bind(CapabilityService),
  _updateFts: CapabilityService._updateFts.bind(CapabilityService),
  rebuildFts: CapabilityService.rebuildFts.bind(CapabilityService),
};
