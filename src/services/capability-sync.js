/**
 * CapabilitySyncService — Sync capabilities from filesystem, routes, and MCP servers.
 *
 * Handles all registration/sync logic:
 * - Skills: SKILL.md files on disk (~/os8/skills/)
 * - APIs: .meta exports on route modules
 * - MCP: tools from running MCP servers
 * - Bundled skills: copy from repo to ~/os8/skills/
 *
 * Extracted from capability.js — runtime CRUD/search stays there.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SKILLS_DIR } = require('../config');
const { generateId } = require('../utils');

class CapabilitySyncService {

  // ──────────────────────────────────────────────
  // Parsing & Hashing
  // ──────────────────────────────────────────────

  /**
   * Parse a SKILL.md file into { frontmatter, body }.
   * Handles YAML frontmatter with nested objects, arrays, quoted strings, inline arrays.
   */
  static parseSkillMd(content) {
    const lines = content.split('\n');
    let inFrontmatter = false;
    let frontmatterLines = [];
    let bodyLines = [];
    let frontmatterEnded = false;

    for (const line of lines) {
      if (line.trim() === '---') {
        if (!inFrontmatter && !frontmatterEnded) {
          inFrontmatter = true;
          continue;
        } else if (inFrontmatter) {
          inFrontmatter = false;
          frontmatterEnded = true;
          continue;
        }
      }

      if (inFrontmatter) {
        frontmatterLines.push(line);
      } else if (frontmatterEnded) {
        bodyLines.push(line);
      }
    }

    // Parse YAML frontmatter (simple recursive parser)
    const frontmatter = {};
    let context = [{ indent: -2, value: frontmatter }];

    function getCurrentParent(indent) {
      while (context.length > 1 && context[context.length - 1].indent >= indent) {
        context.pop();
      }
      return context[context.length - 1].value;
    }

    for (let i = 0; i < frontmatterLines.length; i++) {
      const line = frontmatterLines[i];
      if (!line.trim()) continue;

      const indent = line.search(/\S/);

      // Array item: "  - value" or "  - key: value"
      const arrayMatch = line.match(/^(\s*)-\s+(.*)$/);
      if (arrayMatch) {
        const [, spaces, rest] = arrayMatch;
        const itemIndent = spaces.length;
        const parent = getCurrentParent(itemIndent);

        if (Array.isArray(parent)) {
          const kvMatch = rest.match(/^([\w.-]+):\s*(.*)$/);
          if (kvMatch) {
            const [, key, value] = kvMatch;
            const newObj = { [key]: value };
            parent.push(newObj);
            context.push({ indent: itemIndent + 2, value: newObj });
          } else {
            parent.push(rest);
          }
        }
        continue;
      }

      // Key-value: "key: value" or "key:" (start of nested)
      const kvMatch = line.match(/^(\s*)([\w.-]+):\s*(.*)$/);
      if (kvMatch) {
        const [, spaces, key, value] = kvMatch;
        const keyIndent = spaces.length;
        let parent = getCurrentParent(keyIndent);

        if (Array.isArray(parent)) {
          if (parent.length > 0 && typeof parent[parent.length - 1] === 'object') {
            parent = parent[parent.length - 1];
          } else {
            const newObj = {};
            parent.push(newObj);
            parent = newObj;
          }
        }

        if (value) {
          // Handle quoted strings
          if ((value.startsWith('"') && value.endsWith('"')) ||
              (value.startsWith("'") && value.endsWith("'"))) {
            parent[key] = value.slice(1, -1);
          } else if (value.startsWith('{')) {
            // Inline JSON object
            try { parent[key] = JSON.parse(value); } catch (e) { parent[key] = value; }
          } else if (value.startsWith('[') && value.endsWith(']')) {
            // Inline array — try JSON parse first (handles nested objects), fall back to CSV
            try { parent[key] = JSON.parse(value); } catch (e) {
              parent[key] = value.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
            }
          } else {
            parent[key] = value;
          }
        } else {
          // No value — nested structure. Peek at next line to detect array vs object
          const nextLine = frontmatterLines[i + 1] || '';
          const isArray = nextLine.trim().startsWith('-');

          if (isArray) {
            parent[key] = [];
            context.push({ indent: keyIndent, value: parent[key] });
          } else {
            parent[key] = {};
            context.push({ indent: keyIndent, value: parent[key] });
          }
        }
      }
    }

    return {
      frontmatter,
      body: bodyLines.join('\n').trim()
    };
  }

  static hash(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  // ──────────────────────────────────────────────
  // Bundled Skills Installation
  // ──────────────────────────────────────────────

  /**
   * Copy bundled skill directories from repo to ~/os8/skills/.
   * Only copies if destination is missing or SKILL.md has changed.
   */
  static installBundledSkills(bundledDir) {
    if (!fs.existsSync(bundledDir)) return 0;

    let installed = 0;
    const entries = fs.readdirSync(bundledDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const srcDir = path.join(bundledDir, entry.name);
      const destDir = path.join(SKILLS_DIR, entry.name);
      const srcSkillMd = path.join(srcDir, 'SKILL.md');

      if (!fs.existsSync(srcSkillMd)) continue;

      // Only copy if destination doesn't exist or has changed
      const destSkillMd = path.join(destDir, 'SKILL.md');
      if (fs.existsSync(destSkillMd)) {
        const srcHash = this.hash(fs.readFileSync(srcSkillMd, 'utf-8'));
        const destHash = this.hash(fs.readFileSync(destSkillMd, 'utf-8'));
        if (srcHash === destHash) continue;
      }

      // Copy entire skill directory
      fs.mkdirSync(destDir, { recursive: true });
      this._copyDirSync(srcDir, destDir);
      installed++;
      console.log(`[Capabilities] Installed bundled skill: ${entry.name}`);
    }

    return installed;
  }

  static _copyDirSync(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        this._copyDirSync(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  // ──────────────────────────────────────────────
  // Filesystem Sync (Skills)
  // ──────────────────────────────────────────────

  /**
   * Sync ~/os8/skills/ filesystem to the capabilities table (type='skill').
   * Scan ~/os8/skills/ filesystem and upsert into capabilities table (type='skill').
   */
  static syncSkills(db) {
    // Lazy-load to avoid circular dependency
    const { _insertFts, _updateFts } = require('./capability');

    if (!fs.existsSync(SKILLS_DIR)) return { added: 0, updated: 0, removed: 0 };

    const existing = db.prepare(
      "SELECT rowid, id, name, base_path, body_hash FROM capabilities WHERE type = 'skill' AND scope = 'system'"
    ).all();
    const existingByPath = new Map(existing.map(s => [s.base_path, s]));
    const seenPaths = new Set();

    let added = 0, updated = 0, removed = 0;

    let entries;
    try {
      entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
    } catch (e) {
      console.warn('[Capabilities] Failed to read skills directory:', e.message);
      return { added: 0, updated: 0, removed: 0 };
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.tmp-')) continue;

      const skillDir = path.join(SKILLS_DIR, entry.name);
      const skillMdPath = path.join(skillDir, 'SKILL.md');

      if (!fs.existsSync(skillMdPath)) continue;

      seenPaths.add(skillDir);

      try {
        const content = fs.readFileSync(skillMdPath, 'utf-8');
        const bodyHash = this.hash(content);
        const existingCap = existingByPath.get(skillDir);

        if (existingCap) {
          if (existingCap.body_hash !== bodyHash) {
            const parsed = this.parseSkillMd(content);
            const fm = parsed.frontmatter;
            const meta = fm.metadata || {};
            const connection = meta['os8.connection'] || null;
            const connectionScopes = meta['os8.scopes'] || null;
            const { envRequired, binsRequired, homepage, platformOk } = this._extractOpenClawFields(fm, meta);

            // Merge user-invocable and command-dispatch into metadata for storage
            const metaObj = fm.metadata ? { ...fm.metadata } : {};
            if (fm['user-invocable'] !== undefined) metaObj.userInvocable = fm['user-invocable'];
            if (fm['command-dispatch']) metaObj.commandDispatch = fm['command-dispatch'];

            // Re-quarantine catalog skills that were previously approved (content changed)
            const reQuarantine = existingCap.source === 'catalog' && existingCap.review_status === 'approved';

            db.prepare(`
              UPDATE capabilities SET
                name = ?, description = ?, version = ?, license = ?,
                metadata = ?, env_required = ?, bins_required = ?,
                connection = ?, connection_scopes = ?, homepage = ?,
                available = CASE WHEN ? = 0 THEN 0 ELSE available END,
                body_hash = ?, updated_at = CURRENT_TIMESTAMP
                ${reQuarantine ? ", quarantine = 1, review_status = 'pending', review_report = NULL, reviewed_at = NULL, approved_at = NULL" : ''}
              WHERE id = ?
            `).run(
              fm.name || entry.name,
              fm.description || '',
              fm.version || null,
              fm.license || null,
              Object.keys(metaObj).length > 0 ? JSON.stringify(metaObj) : null,
              envRequired,
              binsRequired,
              connection,
              connectionScopes,
              homepage,
              platformOk ? 1 : 0,
              bodyHash,
              existingCap.id
            );
            if (reQuarantine) {
              console.log(`[Capabilities] Re-quarantined skill: ${fm.name || entry.name} (content changed)`);
            }
            _updateFts(db, existingCap.rowid, fm.name || entry.name, fm.description || '', null);
            // Clear embedding so it regenerates
            db.prepare('UPDATE capabilities SET embedding = NULL WHERE id = ?').run(existingCap.id);
            updated++;
            console.log(`[Capabilities] Updated skill: ${fm.name || entry.name}`);
          }
        } else {
          const parsed = this.parseSkillMd(content);
          const fm = parsed.frontmatter;
          const id = generateId();
          const source = this._detectSource(skillDir);
          const meta = fm.metadata || {};
          const connection = meta['os8.connection'] || null;
          const connectionScopes = meta['os8.scopes'] || null;
          const { envRequired, binsRequired, homepage, platformOk } = this._extractOpenClawFields(fm, meta);

          // Merge user-invocable and command-dispatch into metadata for storage
          const metaObj = fm.metadata ? { ...fm.metadata } : {};
          if (fm['user-invocable'] !== undefined) metaObj.userInvocable = fm['user-invocable'];
          if (fm['command-dispatch']) metaObj.commandDispatch = fm['command-dispatch'];

          const { lastInsertRowid } = db.prepare(`
            INSERT INTO capabilities (id, type, name, description, scope,
              env_required, bins_required, connection, connection_scopes,
              homepage, available,
              version, license, metadata, source, base_path, body_hash, quarantine)
            VALUES (?, 'skill', ?, ?, 'system', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            id,
            fm.name || entry.name,
            fm.description || '',
            envRequired,
            binsRequired,
            connection,
            connectionScopes,
            homepage,
            platformOk ? 1 : 0,
            fm.version || null,
            fm.license || null,
            Object.keys(metaObj).length > 0 ? JSON.stringify(metaObj) : null,
            source,
            skillDir,
            bodyHash,
            0 // local skills are trusted — quarantine only for catalog installs
          );
          _insertFts(db, lastInsertRowid, fm.name || entry.name, fm.description || '', null);
          added++;
          console.log(`[Capabilities] Added skill: ${fm.name || entry.name} (${source})`);
        }
      } catch (err) {
        console.warn(`[Capabilities] Error parsing ${entry.name}:`, err.message);
      }
    }

    // Remove skills whose directories no longer exist
    for (const [capPath, cap] of existingByPath) {
      if (!seenPaths.has(capPath)) {
        db.prepare('DELETE FROM capabilities WHERE id = ?').run(cap.id);
        removed++;
        console.log(`[Capabilities] Removed skill: ${cap.name} (directory deleted)`);
      }
    }

    if (added || updated || removed) {
      console.log(`[Capabilities] Skill sync: ${added} added, ${updated} updated, ${removed} removed`);
    }

    return { added, updated, removed };
  }

  // ──────────────────────────────────────────────
  // API Registry (collect .meta from route modules)
  // ──────────────────────────────────────────────

  /**
   * Walk src/routes/ and collect .meta exports from each route module.
   * Route modules export factory functions with an optional .meta property.
   * Only modules that opt in (export .meta) are registered as API capabilities.
   */
  static collectRouteMetas() {
    const routesDir = path.join(__dirname, '..', 'routes');
    const metas = [];

    let files;
    try {
      files = fs.readdirSync(routesDir).filter(f => f.endsWith('.js'));
    } catch (e) {
      console.warn('[Capabilities] Failed to read routes directory:', e.message);
      return metas;
    }

    for (const file of files) {
      try {
        const mod = require(path.join(routesDir, file));
        if (mod && mod.meta) {
          metas.push(mod.meta);
        }
      } catch (e) {
        // Some route modules may fail to require outside full server context — skip
      }
    }

    return metas;
  }

  /**
   * Sync API entries from route .meta exports into capabilities table.
   */
  static syncApis(db, routeMetas = []) {
    const { _insertFts, _updateFts } = require('./capability');

    if (routeMetas.length === 0) return { added: 0, updated: 0, removed: 0 };

    let added = 0, updated = 0;

    for (const meta of routeMetas) {
      const existing = db.prepare(
        "SELECT rowid, id, body_hash FROM capabilities WHERE type = 'api' AND name = ?"
      ).get(meta.name);

      const bodyHash = this.hash(JSON.stringify(meta));
      const searchDesc = this._buildApiSearchDescription(meta);

      if (existing) {
        if (existing.body_hash !== bodyHash) {
          db.prepare(`
            UPDATE capabilities SET
              description = ?, search_description = ?, base_path = ?, endpoints = ?,
              env_required = ?, connection = ?, connection_scopes = ?,
              body_hash = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(
            meta.description || '',
            searchDesc,
            meta.basePath || '',
            JSON.stringify(meta.endpoints || []),
            meta.envRequired || null,
            meta.connection || null,
            meta.connectionScopes || null,
            bodyHash,
            existing.id
          );
          // Clear embedding so it regenerates
          db.prepare('UPDATE capabilities SET embedding = NULL WHERE id = ?').run(existing.id);
          _updateFts(db, existing.rowid, meta.name, meta.description || '', searchDesc);
          updated++;
        }
      } else {
        const id = generateId();
        const { lastInsertRowid } = db.prepare(`
          INSERT INTO capabilities (id, type, name, description, scope,
            base_path, endpoints, search_description, env_required, connection, connection_scopes,
            source, body_hash, quarantine)
          VALUES (?, 'api', ?, ?, 'system', ?, ?, ?, ?, ?, ?, 'bundled', ?, 0)
        `).run(
          id,
          meta.name,
          meta.description || '',
          meta.basePath || '',
          JSON.stringify(meta.endpoints || []),
          searchDesc,
          meta.envRequired || null,
          meta.connection || null,
          meta.connectionScopes || null,
          bodyHash
        );
        _insertFts(db, lastInsertRowid, meta.name, meta.description || '', searchDesc);
        added++;
      }
    }

    // Remove stale API records that no longer have a matching route meta
    const metaNames = new Set(routeMetas.map(m => m.name));
    const allApis = db.prepare("SELECT id, name, description, search_description FROM capabilities WHERE type = 'api' AND source = 'bundled'").all();
    let removed = 0;
    for (const api of allApis) {
      if (!metaNames.has(api.name)) {
        db.prepare("INSERT INTO capability_fts(capability_fts, name, description, search_description) VALUES('delete', ?, ?, ?)")
          .run(api.name, api.description || '', api.search_description || '');
        db.prepare('DELETE FROM capabilities WHERE id = ?').run(api.id);
        removed++;
      }
    }

    if (added || updated || removed) {
      console.log(`[Capabilities] API sync: ${added} added, ${updated} updated, ${removed} removed`);
    }

    return { added, updated, removed };
  }

  // ──────────────────────────────────────────────
  // MCP Tool Registration
  // ──────────────────────────────────────────────

  /**
   * Register MCP tools as capabilities from a running server.
   * Called by McpServerService.start() after tool discovery.
   */
  static syncMcpTools(db, serverId, serverName, tools) {
    const { _insertFts, _updateFts } = require('./capability');

    let added = 0, updated = 0;

    for (const tool of tools) {
      const capId = `mcp:${serverId}:${tool.name}`;
      const displayName = `${serverName}: ${tool.name}`;
      const description = tool.description || '';
      const endpoint = {
        method: 'POST',
        path: `/api/mcp/${serverId}/${tool.name}`,
        description
      };
      if (tool.inputSchema && tool.inputSchema.properties) {
        endpoint.params = {};
        for (const [key, val] of Object.entries(tool.inputSchema.properties)) {
          endpoint.params[key] = val.type ? `${val.type}${val.description ? ' — ' + val.description : ''}` : (val.description || 'any');
        }
      }
      const endpointsJson = JSON.stringify([endpoint]);

      // Build search description from tool metadata
      const searchParts = [`${displayName}. ${description}`];
      searchParts.push(`MCP tool. POST /api/mcp/${serverId}/${tool.name}`);
      if (tool.inputSchema && tool.inputSchema.properties) {
        const paramNames = Object.keys(tool.inputSchema.properties);
        searchParts.push(`Parameters: ${paramNames.join(', ')}`);
        for (const [key, val] of Object.entries(tool.inputSchema.properties)) {
          if (val.description) searchParts.push(`${key}: ${val.description}`);
        }
      }
      const searchDesc = searchParts.join('. ');
      const bodyHash = this.hash(JSON.stringify(tool));

      const existing = db.prepare('SELECT rowid, id, body_hash FROM capabilities WHERE id = ?').get(capId);

      if (existing) {
        if (existing.body_hash !== bodyHash) {
          db.prepare(`
            UPDATE capabilities SET
              name = ?, description = ?, search_description = ?,
              base_path = ?, endpoints = ?, body_hash = ?,
              available = 1, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(displayName, description, searchDesc, `/api/mcp/${serverId}`, endpointsJson, bodyHash, capId);
          db.prepare('UPDATE capabilities SET embedding = NULL WHERE id = ?').run(capId);
          _updateFts(db, existing.rowid, displayName, description, searchDesc);
          updated++;
        } else {
          // Just ensure availability is set
          db.prepare('UPDATE capabilities SET available = 1 WHERE id = ?').run(capId);
        }
      } else {
        const { lastInsertRowid } = db.prepare(`
          INSERT INTO capabilities (id, type, name, description, scope,
            base_path, endpoints, search_description, source, body_hash, quarantine, available)
          VALUES (?, 'mcp', ?, ?, 'system', ?, ?, ?, 'mcp', ?, 0, 1)
        `).run(capId, displayName, description, `/api/mcp/${serverId}`, endpointsJson, searchDesc, bodyHash);
        _insertFts(db, lastInsertRowid, displayName, description, searchDesc);
        added++;
      }
    }

    if (added || updated) {
      console.log(`[Capabilities] MCP sync for "${serverName}": ${added} added, ${updated} updated`);
    }

    return { added, updated };
  }

  /**
   * Remove all capabilities for an MCP server (when stopped or removed).
   */
  static removeMcpTools(db, serverId) {
    const prefix = `mcp:${serverId}:`;
    const caps = db.prepare("SELECT id, name, description, search_description FROM capabilities WHERE id LIKE ?").all(prefix + '%');
    for (const cap of caps) {
      // Remove from FTS
      try {
        db.prepare("INSERT INTO capability_fts(capability_fts, name, description, search_description) VALUES('delete', ?, ?, ?)")
          .run(cap.name || '', cap.description || '', cap.search_description || '');
      } catch (e) {
        // FTS cleanup best-effort
      }
      db.prepare('DELETE FROM capabilities WHERE id = ?').run(cap.id);
    }
    if (caps.length > 0) {
      console.log(`[Capabilities] Removed ${caps.length} MCP tools for server ${serverId}`);
    }
  }

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /**
   * Build a rich search description from route .meta for embedding/FTS.
   * Combines name, description, base path, and all endpoint details.
   */
  static _buildApiSearchDescription(meta) {
    const parts = [`${meta.name} API. ${meta.description || ''}`];
    if (meta.basePath) parts.push(`Base URL: ${meta.basePath}`);
    for (const ep of (meta.endpoints || [])) {
      let line = `${ep.method} ${ep.path}: ${ep.description || ''}`;
      if (ep.params) {
        const paramList = Object.entries(ep.params).map(([k, v]) => `${k} (${v})`).join(', ');
        line += ` Parameters: ${paramList}`;
      }
      parts.push(line);
    }
    return parts.join('. ');
  }

  /**
   * Detect the source of a skill based on its path.
   */
  static _detectSource(skillDir) {
    if (fs.existsSync(path.join(skillDir, '.bundled'))) return 'bundled';
    return 'local';
  }

  /**
   * Merge env requirements from OS8-native and OpenClaw/ClawdBot metadata.
   * Returns comma-separated string or null.
   */
  static _mergeEnvRequired(os8Env, openclawEnv, clawdbotEnv) {
    const keys = new Set();
    for (const src of [os8Env, openclawEnv, clawdbotEnv]) {
      if (!src) continue;
      const items = Array.isArray(src) ? src : String(src).split(',');
      for (const k of items) {
        const trimmed = k.trim();
        if (trimmed) keys.add(trimmed);
      }
    }
    return keys.size > 0 ? Array.from(keys).join(',') : null;
  }

  /**
   * Extract bins_required from OpenClaw/ClawdBot metadata.
   * Returns comma-separated string or null.
   */
  static _extractBinsRequired(openclawBins, clawdbotBins) {
    const bins = new Set();
    for (const src of [openclawBins, clawdbotBins]) {
      if (!src) continue;
      const items = Array.isArray(src) ? src : String(src).split(',');
      for (const b of items) {
        const trimmed = b.trim();
        if (trimmed) bins.add(trimmed);
      }
    }
    return bins.size > 0 ? Array.from(bins).join(',') : null;
  }

  /**
   * Extract OpenClaw fields from parsed frontmatter.
   * Returns { envRequired, binsRequired, homepage, platformOk }.
   */
  static _extractOpenClawFields(fm, meta) {
    const oc = fm.metadata?.openclaw?.requires || {};
    const cb = fm.metadata?.clawdbot?.requires || {};

    const envRequired = this._mergeEnvRequired(meta['os8.env'], oc.env, cb.env);
    const binsRequired = this._extractBinsRequired(oc.bins, cb.bins);
    const homepage = fm.homepage || fm.metadata?.openclaw?.homepage || null;

    // Platform check — if os array is declared and current platform isn't in it, skill is unavailable
    // os can be at openclaw.os or openclaw.requires.os (both seen in the wild)
    const osArray = fm.metadata?.openclaw?.os || oc.os || fm.metadata?.clawdbot?.os || cb.os;
    const platformOk = !Array.isArray(osArray) || osArray.includes(process.platform);

    return { envRequired, binsRequired, homepage, platformOk };
  }
}

module.exports = CapabilitySyncService;
