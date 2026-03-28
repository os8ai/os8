/**
 * Agent Service
 *
 * Manages agent entities (sub-entities within the single agent system app).
 * Agents live in the `agents` SQLite table. Per-agent data lives on disk
 * under `~/os8/apps/{appId}/agents/{agentId}/` (after migration) or directly
 * under `~/os8/apps/{agentId}/` (backward-compat before file migration).
 *
 * Config is split:
 *   - Frequently queried fields (name, backend, model, color, etc.) → SQLite `agents` table
 *   - Nested/rare config (agentApiKeys, timeouts) → config.json on disk
 */

const fs = require('fs');
const path = require('path');
const { APPS_DIR, BLOB_DIR } = require('../config');
const { generateId, generateSlug } = require('../utils');
const { loadJSON, saveJSON } = require('../utils/file-helpers');
const SettingsService = require('./settings');

const AgentService = {
  /**
   * Get all active agents
   * @param {object} db
   * @returns {Array<object>}
   */
  getAll(db) {
    return db.prepare('SELECT * FROM agents WHERE status = ? AND setup_complete = 1 ORDER BY display_order, name').all('active');
  },

  /**
   * Get visible agents (shown in UI selectors)
   * @param {object} db
   * @returns {Array<object>}
   */
  getVisible(db) {
    return db.prepare("SELECT * FROM agents WHERE status = 'active' AND setup_complete = 1 AND (visibility = 'visible' OR visibility IS NULL) ORDER BY display_order, name").all();
  },

  /**
   * Get operational agents (visible + hidden, excludes off)
   * @param {object} db
   * @returns {Array<object>}
   */
  getOperational(db) {
    return db.prepare("SELECT * FROM agents WHERE status = 'active' AND setup_complete = 1 AND (visibility != 'off' OR visibility IS NULL) ORDER BY display_order, name").all();
  },

  /**
   * Get agent by ID
   * @param {object} db
   * @param {string} id
   * @returns {object|undefined}
   */
  getById(db, id) {
    return db.prepare("SELECT * FROM agents WHERE id = ? AND status != 'deleted'").get(id);
  },

  /**
   * Get agent by slug
   * @param {object} db
   * @param {string} slug
   * @returns {object|undefined}
   */
  getBySlug(db, slug) {
    return db.prepare("SELECT * FROM agents WHERE slug = ? AND status != 'deleted'").get(slug);
  },

  /**
   * Get the default agent
   * @param {object} db
   * @returns {object|undefined}
   */
  getDefault(db) {
    // First try is_default flag
    const defaultAgent = db.prepare('SELECT * FROM agents WHERE is_default = 1 AND status = ? LIMIT 1').get('active');
    if (defaultAgent) return defaultAgent;
    // Fall back to first active agent
    return db.prepare('SELECT * FROM agents WHERE status = ? ORDER BY display_order LIMIT 1').get('active');
  },

  /**
   * Create a new agent
   * @param {object} db
   * @param {object} opts - { appId, name, ownerName, backend, model, color }
   * @returns {object} The created agent row
   */
  create(db, { appId, name, ownerName = '', backend = 'claude', model = null, color = '#8b5cf6' }) {
    const id = generateId();
    let slug = `agent-${generateSlug(name)}`;

    // Ensure slug uniqueness
    let counter = 2;
    while (db.prepare('SELECT id FROM agents WHERE slug = ?').get(slug)) {
      slug = `agent-${generateSlug(name)}-${counter}`;
      counter++;
    }

    db.prepare(`
      INSERT INTO agents (id, app_id, name, slug, color, backend, model, owner_name, display_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(display_order), -1) + 1 FROM agents), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(id, appId, name, slug, color, backend, model, ownerName);

    return this.getById(db, id);
  },

  /**
   * Update agent fields in DB
   * @param {object} db
   * @param {string} id
   * @param {object} updates - Any subset of agent columns
   * @returns {object} Updated agent row
   */
  update(db, id, updates) {
    const allowedFields = [
      'name', 'slug', 'color', 'backend', 'model',
      'owner_name', 'pronouns', 'voice_archetype',
      'show_image', 'is_default', 'display_order', 'status',
      'telegram_bot_token', 'telegram_bot_username', 'telegram_chat_id', 'telegram_owner_user_id',
      'setup_complete', 'gender', 'role', 'appearance',
      'age', 'birth_date', 'hair_color', 'skin_tone', 'height', 'build', 'other_features',
      'voice_id', 'voice_name', 'myself_content', 'myself_custom', 'user_custom', 'chat_reset_at',
      'visibility', 'subconscious_memory', 'subconscious_direct', 'subconscious_depth'
    ];

    const fields = [];
    const values = [];

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key) && value !== undefined) {
        fields.push(`${key} = ?`);
        // Coerce booleans to integers for SQLite
        values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
      }
    }

    if (fields.length > 0) {
      fields.push('updated_at = CURRENT_TIMESTAMP');
      values.push(id);
      db.prepare(`UPDATE agents SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    }

    // If setting as default, clear others
    if (updates.is_default === 1) {
      db.prepare('UPDATE agents SET is_default = 0 WHERE id != ?').run(id);
    }

    return this.getById(db, id);
  },

  /**
   * Hard-delete an agent and ALL associated data from the database.
   * Filesystem cleanup (agentDir, agentBlobDir) is the caller's responsibility.
   *
   * @param {object} db
   * @param {string} id - The agent ID
   */
  hardDelete(db, id) {
    const deleteAll = db.transaction(() => {
      // 1. Agent messages (must come before thread cleanup due to FK)
      db.prepare('DELETE FROM agent_messages WHERE sender_app_id = ?').run(id);

      // 2. Agent threads — delete threads where this agent is a participant
      //    For DM threads, delete entirely. For group threads, remove the agent.
      const threads = db.prepare("SELECT id, type, participants FROM agent_threads WHERE participants LIKE ?").all(`%${id}%`);
      for (const thread of threads) {
        try {
          const participants = JSON.parse(thread.participants);
          const remaining = participants.filter(p => p !== id);
          if (remaining.length <= 1 || thread.type === 'dm') {
            // Delete thread and its messages
            db.prepare('DELETE FROM agent_messages WHERE thread_id = ?').run(thread.id);
            db.prepare('DELETE FROM agent_chat_budget WHERE thread_id = ?').run(thread.id);
            db.prepare('DELETE FROM telegram_groups WHERE thread_id = ?').run(thread.id);
            db.prepare('DELETE FROM agent_threads WHERE id = ?').run(thread.id);
          } else {
            // Remove agent from participants
            db.prepare('UPDATE agent_threads SET participants = ? WHERE id = ?')
              .run(JSON.stringify(remaining), thread.id);
          }
        } catch {
          // If participants isn't valid JSON, delete the thread
          db.prepare('DELETE FROM agent_messages WHERE thread_id = ?').run(thread.id);
          db.prepare('DELETE FROM agent_threads WHERE id = ?').run(thread.id);
        }
      }

      // 3. Telegram groups — remove agent from agent_ids
      const groups = db.prepare("SELECT id, agent_ids FROM telegram_groups WHERE agent_ids LIKE ?").all(`%${id}%`);
      for (const group of groups) {
        try {
          const agentIds = JSON.parse(group.agent_ids);
          const remaining = agentIds.filter(a => a !== id);
          if (remaining.length === 0) {
            db.prepare('DELETE FROM telegram_groups WHERE id = ?').run(group.id);
          } else {
            db.prepare('UPDATE telegram_groups SET agent_ids = ? WHERE id = ?')
              .run(JSON.stringify(remaining), group.id);
          }
        } catch {
          // Non-JSON agent_ids — leave it alone
        }
      }

      // 4. Simple table cleanups (agent_id or app_id = agent ID)
      db.prepare('DELETE FROM agent_chat_budget WHERE agent_id = ?').run(id);
      db.prepare('DELETE FROM agent_pinned_capabilities WHERE agent_id = ?').run(id);
      db.prepare('DELETE FROM capability_usage WHERE agent_id = ?').run(id);
      db.prepare('DELETE FROM agent_life_items WHERE agent_id = ?').run(id);
      db.prepare('DELETE FROM agent_life_entries WHERE agent_id = ?').run(id);

      // 5. Conversation & memory data (these use app_id = agent ID)
      db.prepare('DELETE FROM conversation_entries WHERE app_id = ?').run(id);
      db.prepare('DELETE FROM conversation_digests WHERE app_id = ?').run(id);
      db.prepare('DELETE FROM memory_chunks WHERE app_id = ?').run(id);
      db.prepare('DELETE FROM memory_sources WHERE app_id = ?').run(id);

      // 6. Rebuild FTS index after chunk deletion
      db.prepare("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')").run();

      // 7. Delete the agent row itself
      db.prepare('DELETE FROM agents WHERE id = ?').run(id);
    });

    deleteAll();
  },

  /**
   * Scaffold a new agent's filesystem: create dirs, scaffold app files,
   * remove dead UI files, create blob subdirs, identity doc folders, and
   * generate instruction files.
   *
   * @param {object} db
   * @param {object} agent - Agent row (must have id, slug, app_id)
   * @param {object} opts
   * @param {string} opts.name - Display name
   * @param {string} opts.ownerName - Owner name
   * @param {function} opts.scaffoldFn - (dir, id, name, slug, name, ownerName) => void
   * @param {function} opts.generateInstructionsFn - (db, appLike, config) => void
   */
  scaffold(db, agent, { name, ownerName, scaffoldFn, generateInstructionsFn }) {
    const paths = this.getPaths(agent.app_id, agent.id);

    // Create agent directory and scaffold app files
    fs.mkdirSync(paths.agentDir, { recursive: true });
    scaffoldFn(paths.agentDir, agent.id, name, agent.slug, name, ownerName || '');

    // Remove app UI files that only belong at the parent level (not per-agent)
    for (const dead of ['src', 'index.html']) {
      const p = path.join(paths.agentDir, dead);
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    }

    // Create blob directory and subdirectories
    fs.mkdirSync(paths.agentBlobDir, { recursive: true });
    const blobSubdirs = [
      'current-image', 'reference-images',
      'chat-attachments', 'telegram-attachments',
      'journal', 'calendar'
    ];
    for (const sub of blobSubdirs) {
      fs.mkdirSync(path.join(paths.agentBlobDir, sub), { recursive: true });
    }

    // Create identity doc folders
    const agentSlug = agent.slug.replace('agent-', '');
    fs.mkdirSync(path.join(paths.agentDir, 'docs', `${agentSlug}-identity`), { recursive: true });
    if (ownerName) {
      const ownerSlugStr = ownerName.toLowerCase().replace(/\s+/g, '-');
      fs.mkdirSync(path.join(paths.agentDir, 'docs', `${ownerSlugStr}-identity`), { recursive: true });
    }

    // Generate instruction file
    const config = this.getConfig(db, agent.id);
    const appLike = { id: agent.id, name, slug: agent.slug };
    generateInstructionsFn(db, appLike, config);
  },

  /**
   * Hard-delete an agent's DB data and filesystem (agentDir + agentBlobDir).
   *
   * @param {object} db
   * @param {string} id - Agent ID
   * @param {string} appId - Parent app ID (for path resolution)
   */
  deleteWithCleanup(db, id, appId) {
    const paths = this.getPaths(appId, id);
    this.hardDelete(db, id);
    try {
      if (fs.existsSync(paths.agentDir)) fs.rmSync(paths.agentDir, { recursive: true, force: true });
      if (fs.existsSync(paths.agentBlobDir)) fs.rmSync(paths.agentBlobDir, { recursive: true, force: true });
    } catch (e) {
      console.warn('Agent file cleanup failed:', e.message);
    }
  },

  /**
   * Clean up agents that never completed setup (abandoned creation).
   * Soft-deletes them so they don't show in the agent list.
   * @param {object} db
   * @returns {number} Number of agents cleaned up
   */
  cleanupIncomplete(db) {
    // Only clean up agents that were created more than 1 hour ago and never completed setup.
    // This avoids deleting agents the user is actively setting up (e.g., if OS8 restarts mid-setup).
    const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const stale = db.prepare(
      "SELECT id, app_id FROM agents WHERE setup_complete = 0 AND status = 'active' AND created_at < ?"
    ).all(cutoff);

    for (const agent of stale) {
      this.deleteWithCleanup(db, agent.id, agent.app_id);
    }

    if (stale.length > 0) {
      console.log(`[Agent] Cleaned up ${stale.length} incomplete agent(s) older than 1 hour`);
    }
    return stale.length;
  },

  /**
   * Set the default agent
   * @param {object} db
   * @param {string} id
   */
  setDefault(db, id) {
    db.prepare('UPDATE agents SET is_default = 0').run();
    db.prepare('UPDATE agents SET is_default = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  },

  /**
   * Get the parent app ID that all agents share.
   * @param {object} db
   * @returns {string|null}
   */
  getParentAppId(db) {
    const agents = this.getAll(db);
    if (agents.length > 0) return agents[0].app_id;
    const systemApp = db.prepare(
      "SELECT id FROM apps WHERE app_type = 'system' AND status = 'active' LIMIT 1"
    ).get();
    return systemApp?.id || null;
  },

  /**
   * Get paths for an agent.
   *
   * Phase 1-2 (backward compat): returns OLD paths where agent data lives
   * directly in the app directory (~/os8/apps/{agentId}/).
   *
   * Phase 3 will flip this to nested paths:
   *   agentDir = ~/os8/apps/{appId}/agents/{agentId}/
   *   agentBlobDir = ~/os8/blob/{appId}/{agentId}/
   *
   * Can be called with one arg (agentId only, assumes appId===agentId for backward compat)
   * or two args (appId, agentId) for future-proofing.
   *
   * @param {string} appIdOrAgentId - The parent app ID, or just the agent ID
   * @param {string} [agentId] - The agent's own ID (optional if same as appId)
   * @returns {object} { agentDir, agentBlobDir, appDir, appBlobDir }
   */
  getPaths(appIdOrAgentId, agentId) {
    const effectiveAgentId = agentId || appIdOrAgentId;
    const effectiveAppId = appIdOrAgentId;

    // Phase 3: nested paths — agent data lives in subfolder
    //   agentDir = ~/os8/apps/{appId}/agents/{agentId}/
    //   agentBlobDir = ~/os8/blob/{appId}/{agentId}/
    return {
      agentDir: path.join(APPS_DIR, effectiveAppId, 'agents', effectiveAgentId),
      agentBlobDir: path.join(BLOB_DIR, effectiveAppId, effectiveAgentId),
      appDir: path.join(APPS_DIR, effectiveAppId),
      appBlobDir: path.join(BLOB_DIR, effectiveAppId),
    };
  },

  /**
   * Get merged config: DB fields + on-disk config.json
   * Returns a unified config object compatible with the old assistant-config.json format.
   *
   * @param {object} db
   * @param {string} agentId
   * @returns {object} Merged config
   */
  getConfig(db, agentId) {
    const agent = this.getById(db, agentId);
    if (!agent) return null;

    const paths = this.getPaths(agent.app_id, agentId);
    const configPath = path.join(paths.agentDir, 'assistant-config.json');
    const diskConfig = loadJSON(configPath, {});

    // DB fields take precedence; disk config provides nested objects
    return {
      // Identity (DB is source of truth)
      assistantName: agent.name,
      ownerName: SettingsService.get(db, 'user_first_name') || agent.owner_name || diskConfig.ownerName || '',
      pronouns: agent.pronouns || diskConfig.pronouns || 'they',
      voiceArchetype: agent.voice_archetype || diskConfig.voiceArchetype || '',
      showImage: agent.show_image !== undefined ? !!agent.show_image : (diskConfig.showImage !== undefined ? diskConfig.showImage : true),
      gender: agent.gender || 'female',
      role: agent.role || '',
      myselfContent: agent.myself_content || '',

      // Telegram (DB is source of truth)
      telegramBotToken: agent.telegram_bot_token || '',
      telegramBotUsername: agent.telegram_bot_username || '',
      telegramChatId: agent.telegram_chat_id || '',

      // Setup state
      setupComplete: !!agent.setup_complete,

      // Voice (DB is source of truth)
      voiceId: agent.voice_id || undefined,
      voiceName: agent.voice_name || undefined,

      // Backend (DB is source of truth)
      agentBackend: agent.backend || diskConfig.agentBackend || 'claude',
      agentModel: agent.model || diskConfig.agentModel || undefined,

      // Memory
      subconsciousMemory: !!agent.subconscious_memory,
      subconsciousDirect: !!agent.subconscious_direct,
      subconsciousDepth: agent.subconscious_depth || 2,

      // Nested objects (disk only — not in DB)
      agentApiKeys: diskConfig.agentApiKeys || {},
      awayTimeoutMs: diskConfig.awayTimeoutMs,
    };
  },

  /**
   * Regenerate instruction files (CLAUDE.md, GEMINI.md, etc.) for all active agents.
   * Call on startup to pick up template changes from claude-md.js.
   *
   * @param {object} db
   * @param {function} generateAssistantClaudeMd - (db, appLike, config) => void
   */
  regenerateAllInstructions(db, generateAssistantClaudeMd) {
    const fs = require('fs');
    const { generateMyselfMd, generateUserMd } = require('../assistant/config-handler');
    const agents = this.getAll(db);

    // Rename SOUL.md → MYSELF.md for existing agents
    for (const agent of agents) {
      const paths = this.getPaths(agent.app_id, agent.id);
      const oldPath = path.join(paths.agentDir, 'SOUL.md');
      const newPath = path.join(paths.agentDir, 'MYSELF.md');
      if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
        fs.renameSync(oldPath, newPath);
      }
      // Clean up stale SOUL.md if MYSELF.md now exists
      if (fs.existsSync(oldPath) && fs.existsSync(newPath)) {
        fs.unlinkSync(oldPath);
      }
    }

    for (const agent of agents) {
      const config = this.getConfig(db, agent.id);
      const appLike = { id: agent.id, name: agent.name, slug: agent.slug };
      generateAssistantClaudeMd(db, appLike, config);
      generateMyselfMd(db, agent.id);
      generateUserMd(db, agent.id);
    }
    if (agents.length > 0) {
      console.log(`[Agents] Regenerated instruction files for ${agents.length} agent(s)`);
    }
  },

  /**
   * Update config: splits DB fields vs disk config.json
   *
   * @param {object} db
   * @param {string} agentId
   * @param {object} updates - Config key/value pairs
   * @returns {object} Updated merged config
   */
  updateConfig(db, agentId, updates) {
    const agent = this.getById(db, agentId);
    if (!agent) return null;

    // Map config keys → DB column names
    const dbFieldMap = {
      assistantName: 'name',
      pronouns: 'pronouns',
      voiceArchetype: 'voice_archetype',
      showImage: 'show_image',
      agentBackend: 'backend',
      agentModel: 'model',
      ownerName: 'owner_name',
      telegramBotToken: 'telegram_bot_token',
      telegramBotUsername: 'telegram_bot_username',
      telegramChatId: 'telegram_chat_id',
      setupComplete: 'setup_complete',
      gender: 'gender',
      role: 'role',
      appearance: 'appearance',
      age: 'age',
      birthDate: 'birth_date',
      hairColor: 'hair_color',
      skinTone: 'skin_tone',
      height: 'height',
      build: 'build',
      otherFeatures: 'other_features',
      voiceId: 'voice_id',
      voiceName: 'voice_name',
      myselfContent: 'myself_content',
      myselfCustom: 'myself_custom',
      userCustom: 'user_custom',
      subconsciousMemory: 'subconscious_memory',
      subconsciousDirect: 'subconscious_direct',
      subconsciousDepth: 'subconscious_depth',
    };

    // Disk-only keys (nested objects, rarely queried)
    const diskOnlyKeys = new Set([
      'agentApiKeys', 'awayTimeoutMs'
    ]);

    // Split updates
    const dbUpdates = {};
    const diskUpdates = {};

    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) continue;
      if (dbFieldMap[key]) {
        dbUpdates[dbFieldMap[key]] = value;
      }
      if (diskOnlyKeys.has(key)) {
        diskUpdates[key] = value;
      }
    }

    // Apply DB updates
    if (Object.keys(dbUpdates).length > 0) {
      this.update(db, agentId, dbUpdates);
    }

    // Apply disk updates (merge into existing config.json)
    if (Object.keys(diskUpdates).length > 0) {
      const paths = this.getPaths(agent.app_id, agentId);
      const configPath = path.join(paths.agentDir, 'assistant-config.json');
      const existing = loadJSON(configPath, {});
      Object.assign(existing, diskUpdates);
      saveJSON(configPath, existing);
    }

    return this.getConfig(db, agentId);
  },
};

module.exports = AgentService;
