/**
 * RoutingService
 * Intelligent model routing — selects the best available model family + access method
 * for each task type based on cascading priority, availability, and user preferences.
 *
 * Each cascade entry is a (family, access_method) pair — e.g. "claude-sonnet via login"
 * and "claude-sonnet via api" are separate entries. Login entries get discounted cost
 * because subscription is sunk cost.
 *
 * Task types: 'conversation', 'jobs', 'planning', 'coding'
 * Preferences: 'best_quality', 'balanced', 'minimize_cost'
 */

const AIRegistryService = require('./ai-registry');

// Billing/rate error patterns per provider (for reactive exhaustion)
const BILLING_PATTERNS = {
  anthropic: [/credit balance.*low/i, /rate_limit_error/i, /overloaded/i, /insufficient.*credits/i],
  google: [/quota exceeded/i, /RESOURCE_EXHAUSTED/i, /429/],
  openai: [/insufficient_quota/i, /rate_limit_exceeded/i, /billing_hard_limit/i],
  xai: [/rate_limit/i, /insufficient.*balance/i, /429/]
};

const TASK_TYPES = ['conversation', 'jobs', 'planning', 'coding', 'summary', 'image'];
const PROVIDER_IDS = ['anthropic', 'google', 'openai', 'xai'];
const DEFAULT_EXHAUSTION_TTL_MS = 60 * 60 * 1000; // 1 hour

const RoutingService = {
  /**
   * Resolve the best available model family + access method for a task type.
   * @param {object} db - SQLite database
   * @param {string} taskType - 'conversation' | 'jobs' | 'planning' | 'coding'
   * @param {string|null} agentOverride - Family ID from agent config (null or 'auto' = use cascade)
   * @returns {{ familyId: string, backendId: string, modelArg: string|null, accessMethod: string, source: string }}
   */
  resolve(db, taskType, agentOverride = null) {
    // 1. Agent override — try login first, then API. Honored for every task
    // type, not just conversation: if a user pins their agent to a specific
    // family (especially local), they want it for planning/summary too.
    // Families that aren't eligible for this task (per ai_model_families.eligible_tasks)
    // are skipped so we don't e.g. route an image task to a text-only family.
    if (agentOverride && agentOverride !== 'auto') {
      const family = AIRegistryService.getFamily(db, agentOverride);
      const eligibleList = family?.eligible_tasks
        ? family.eligible_tasks.split(',').map(s => s.trim())
        : null;
      const isEligible = !eligibleList || eligibleList.includes(taskType);
      if (family && isEligible) {
        if (this.isAvailable(db, agentOverride, 'login')) {
          return {
            familyId: agentOverride,
            backendId: family.container_id,
            modelArg: AIRegistryService.resolveModelArg(db, agentOverride),
            launcherBackend: family.launcher_backend || null,
            accessMethod: 'login',
            source: 'agent_override'
          };
        }
        if (this.isAvailable(db, agentOverride, 'api')) {
          return {
            familyId: agentOverride,
            backendId: family.container_id,
            modelArg: AIRegistryService.resolveModelArg(db, agentOverride),
            launcherBackend: family.launcher_backend || null,
            accessMethod: 'api',
            source: 'agent_override'
          };
        }
      }
      // Override unavailable or not eligible — fall through to cascade.
    }

    // 2. Walk cascade — each entry specifies family + access_method
    const cascade = this.getCascade(db, taskType);
    for (const entry of cascade) {
      if (!entry.enabled) continue;
      if (this.isAvailable(db, entry.family_id, entry.access_method)) {
        const family = AIRegistryService.getFamily(db, entry.family_id);
        if (family) {
          return {
            familyId: entry.family_id,
            backendId: family.container_id,
            modelArg: AIRegistryService.resolveModelArg(db, entry.family_id),
            launcherBackend: family.launcher_backend || null,
            accessMethod: entry.access_method,
            source: 'cascade'
          };
        }
      }
    }

    // 3. Hard fallback: claude-sonnet via API
    return {
      familyId: 'claude-sonnet',
      backendId: 'claude',
      modelArg: AIRegistryService.resolveModelArg(db, 'claude-sonnet') || 'sonnet',
      launcherBackend: null,
      accessMethod: 'api',
      source: 'fallback'
    };
  },

  /**
   * Check if a model family is available via a specific access method.
   * @param {object} db
   * @param {string} familyId
   * @param {string} accessMethod - 'login' or 'api'
   * @returns {boolean}
   */
  isAvailable(db, familyId, accessMethod) {
    const family = AIRegistryService.getFamily(db, familyId);
    if (!family) return false;

    const container = AIRegistryService.getContainer(db, family.container_id);
    if (!container) return false;

    // HTTP containers (os8-launcher) are available whenever the launcher has a
    // matching capability. We don't probe here — the actual POST in
    // cli-runner.js will fail cleanly if nothing is serving — but we short-
    // circuit the provider/api-key gating because local has neither.
    if (container.type === 'http') {
      return accessMethod === 'api'; // local families live on a single pseudo access method
    }

    const status = db.prepare('SELECT * FROM ai_account_status WHERE provider_id = ?').get(container.provider_id);
    const now = new Date().toISOString();

    if (accessMethod === 'login') {
      if (!container.has_login) return false;
      const exhausted = status?.login_exhausted_until && status.login_exhausted_until > now;
      return !exhausted && status?.login_status !== 'inactive' && status?.login_status !== 'not_configured' && status?.login_status !== 'not_applicable';
    }

    // API
    const exhausted = status?.api_exhausted_until && status.api_exhausted_until > now;
    if (exhausted) return false;
    // Check live key presence — ai_account_status may be stale if key was added after last billing check
    if (status?.api_status === 'no_key') {
      const provider = db.prepare('SELECT api_key_env FROM ai_providers WHERE id = ?').get(container.provider_id);
      if (provider?.api_key_env) {
        const EnvService = require('./env');
        const hasKey = !!(EnvService.get(db, provider.api_key_env)?.value || process.env[provider.api_key_env]);
        return hasKey;
      }
      return false;
    }
    return status?.api_status !== 'invalid';
  },

  /**
   * Get the cascade for a task type.
   * @param {object} db
   * @param {string} taskType
   * @returns {Array}
   */
  getCascade(db, taskType) {
    return db.prepare(
      'SELECT * FROM routing_cascade WHERE task_type = ? ORDER BY priority ASC'
    ).all(taskType);
  },

  /**
   * Update the cascade for a task type (user reordering).
   * @param {object} db
   * @param {string} taskType
   * @param {Array<{ family_id: string, access_method: string, enabled: boolean }>} entries
   */
  updateCascade(db, taskType, entries) {
    const update = db.transaction(() => {
      db.prepare('DELETE FROM routing_cascade WHERE task_type = ?').run(taskType);
      const insert = db.prepare(
        'INSERT INTO routing_cascade (task_type, priority, family_id, access_method, enabled, is_auto_generated) VALUES (?, ?, ?, ?, ?, 0)'
      );
      entries.forEach((entry, idx) => {
        insert.run(taskType, idx, entry.family_id, entry.access_method || 'api', entry.enabled ? 1 : 0);
      });
    });
    update();
  },

  /**
   * Generate cascade for a single task type based on preference.
   * Creates login + API entries per family (login gets discounted cost).
   * @param {object} db
   * @param {string} taskType
   * @returns {Array<{ family_id: string, access_method: string, score: number, cost_display: number }>}
   */
  generateCascade(db, taskType) {
    const preference = this.getPreference(db, taskType);
    const families = AIRegistryService.getFamilies(db);
    const capCol = `cap_${taskType === 'conversation' ? 'chat' : taskType}`;
    const constraints = this.getConstraints(db);

    const entries = [];

    for (const f of families) {
      // Skip families not eligible for this task type
      if (f.eligible_tasks) {
        const eligible = f.eligible_tasks.split(',').map(s => s.trim());
        if (!eligible.includes(taskType)) continue;
      }
      const cap = f[capCol] || 0;
      if (cap <= 0) continue; // Skip families with no capability for this task
      const cost = f.cost_tier || 3;
      const container = AIRegistryService.getContainer(db, f.container_id);
      const provider = container ? AIRegistryService.getProvider(db, container.provider_id) : null;
      const constraint = constraints[provider?.id]?.[taskType] || 'both';

      // Login entry (if container supports login AND constraint allows login)
      if (container?.has_login && (constraint === 'both' || constraint === 'login')) {
        const loginCost = Math.ceil(cost / 2); // Sunk cost discount
        const score = this._score(cap, loginCost, preference);
        entries.push({
          family_id: f.id, access_method: 'login', score,
          cost_display: loginCost, container_id: f.container_id
        });
      }

      // API entry (if constraint allows API) — skip if no API key env,
      // except for HTTP containers (local launcher) which don't use keys.
      if (constraint === 'both' || constraint === 'api') {
        if (!provider?.api_key_env && container?.type !== 'http') continue;
        const apiScore = this._score(cap, cost, preference);
        entries.push({
          family_id: f.id, access_method: 'api', score: apiScore,
          cost_display: cost, container_id: f.container_id
        });
      }
    }

    // Sort by score DESC
    entries.sort((a, b) => b.score - a.score);
    return entries;
  },

  /** Score a (capability, cost) pair under a preference. */
  _score(cap, cost, preference) {
    switch (preference) {
      case 'best_quality': return cap * 9 + (6 - cost);
      case 'minimize_cost': return cap + (6 - cost) * 9;
      case 'balanced':
      default: return cap * 1.2 + (6 - cost);
    }
  },

  /**
   * Regenerate all cascades based on current preference.
   * @param {object} db
   */
  regenerateAll(db) {
    const regen = db.transaction(() => {
      db.prepare('DELETE FROM routing_cascade WHERE is_auto_generated = 1').run();
      const hasCustom = db.prepare('SELECT COUNT(*) as cnt FROM routing_cascade').get().cnt > 0;
      if (hasCustom) return;

      for (const taskType of TASK_TYPES) {
        const cascade = this.generateCascade(db, taskType);
        const insert = db.prepare(
          'INSERT INTO routing_cascade (task_type, priority, family_id, access_method, enabled, is_auto_generated) VALUES (?, ?, ?, ?, 1, 1)'
        );
        cascade.forEach((entry, idx) => {
          insert.run(taskType, idx, entry.family_id, entry.access_method);
        });
      }
    });
    regen();
  },

  /**
   * Mark a provider+access method as exhausted.
   */
  markExhausted(db, providerId, accessMethod, ttlMs = DEFAULT_EXHAUSTION_TTL_MS) {
    const until = new Date(Date.now() + ttlMs).toISOString();
    const col = accessMethod === 'login' ? 'login_exhausted_until' : 'api_exhausted_until';
    db.prepare(`UPDATE ai_account_status SET ${col} = ?, updated_at = CURRENT_TIMESTAMP WHERE provider_id = ?`).run(until, providerId);
    console.log(`[Routing] Marked ${providerId} ${accessMethod} exhausted until ${until}`);
  },

  /**
   * Clear exhaustion for a provider+access method.
   */
  clearExhaustion(db, providerId, accessMethod) {
    const col = accessMethod === 'login' ? 'login_exhausted_until' : 'api_exhausted_until';
    db.prepare(`UPDATE ai_account_status SET ${col} = NULL, updated_at = CURRENT_TIMESTAMP WHERE provider_id = ?`).run(providerId);
  },

  getPreference(db, taskType) {
    if (taskType) {
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(`routing_preference_${taskType}`);
      if (row) return row.value;
    }
    const row = db.prepare("SELECT value FROM settings WHERE key = 'routing_preference'").get();
    return row?.value || 'balanced';
  },

  setPreference(db, preference, taskType) {
    if (!['best_quality', 'balanced', 'minimize_cost'].includes(preference)) {
      throw new Error(`Invalid routing preference: ${preference}`);
    }
    if (taskType) {
      if (!TASK_TYPES.includes(taskType)) throw new Error(`Invalid task type: ${taskType}`);
      db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)").run(`routing_preference_${taskType}`, preference);
      // Regenerate only this task type's cascade
      this._regenerateTaskType(db, taskType);
    } else {
      // Set all task types (backward compat)
      db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('routing_preference', ?, CURRENT_TIMESTAMP)").run(preference);
      for (const tt of TASK_TYPES) {
        db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)").run(`routing_preference_${tt}`, preference);
      }
      this.regenerateAll(db);
    }
  },

  /** Regenerate cascade for a single task type */
  _regenerateTaskType(db, taskType) {
    const regen = db.transaction(() => {
      db.prepare('DELETE FROM routing_cascade WHERE task_type = ?').run(taskType);
      const cascade = this.generateCascade(db, taskType);
      const insert = db.prepare(
        'INSERT INTO routing_cascade (task_type, priority, family_id, access_method, enabled, is_auto_generated) VALUES (?, ?, ?, ?, 1, 1)'
      );
      cascade.forEach((entry, idx) => {
        insert.run(taskType, idx, entry.family_id, entry.access_method);
      });
    });
    regen();
  },

  getAccountStatuses(db) {
    return db.prepare(`
      SELECT s.*, p.name AS provider_name,
        c.id AS container_id, c.has_login
      FROM ai_account_status s
      JOIN ai_providers p ON p.id = s.provider_id
      LEFT JOIN ai_containers c ON c.provider_id = s.provider_id
      ORDER BY p.display_order
    `).all();
  },

  updateAccountStatus(db, providerId, fields) {
    const allowed = ['login_status', 'plan_tier', 'plan_source', 'api_status', 'api_balance', 'api_balance_updated_at', 'last_checked_at'];
    const sets = [];
    const values = [];
    for (const [key, val] of Object.entries(fields)) {
      if (allowed.includes(key)) {
        sets.push(`${key} = ?`);
        values.push(val);
      }
    }
    if (sets.length === 0) return;
    sets.push('updated_at = CURRENT_TIMESTAMP');
    values.push(providerId);
    db.prepare(`UPDATE ai_account_status SET ${sets.join(', ')} WHERE provider_id = ?`).run(...values);
  },

  /**
   * Get per-provider per-task access method constraints.
   * @returns {object} { providerId: { taskType: 'api'|'login'|'both' } }
   */
  getConstraints(db) {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'model_api_constraints'").get();
    if (row) {
      try { return JSON.parse(row.value); } catch (e) { /* fall through */ }
    }
    return this._defaultConstraints();
  },

  setConstraints(db, constraints) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('model_api_constraints', ?, CURRENT_TIMESTAMP)")
      .run(JSON.stringify(constraints));
  },

  _defaultConstraints() {
    const defaults = {};
    for (const pid of PROVIDER_IDS) {
      defaults[pid] = {};
      for (const tt of TASK_TYPES) {
        if (tt === 'jobs' || tt === 'summary') {
          defaults[pid][tt] = 'api';
        } else if (tt === 'image') {
          // Only Google supports login for images (OAuth token covers Imagen API)
          defaults[pid][tt] = pid === 'google' ? 'both' : 'api';
        } else {
          defaults[pid][tt] = 'both';
        }
      }
    }
    return defaults;
  },

  isBillingError(output, providerId) {
    const patterns = BILLING_PATTERNS[providerId];
    if (!patterns) return false;
    return patterns.some(p => p.test(output));
  },

  BILLING_PATTERNS,
  TASK_TYPES,
  PROVIDER_IDS
};

module.exports = RoutingService;
