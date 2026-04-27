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
const VALID_MODES = ['proprietary', 'local'];
// CLIs that pair with a launcher-served chat model under local mode. Both
// connect to the same OpenAI-compatible endpoint but use different request
// envelopes and tool-call protocols. Default is 'opencode'; agents/builds
// can override via opts.localCli to RoutingService.resolve().
const VALID_LOCAL_CLIS = new Set(['opencode', 'openhands']);
const DEFAULT_EXHAUSTION_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Phase 2B: attach launcher_model + launcher_backend to a resolved entry
 * when the family is local-container. Lets dispatchers call
 * LauncherClient.ensureModel without a second AIRegistryService lookup.
 * No-op for non-local families (the fields stay undefined).
 */
function _withLauncher(family, base) {
  if (!family || family.container_id !== 'local') return base;
  return { ...base, launcher_model: family.launcher_model, launcher_backend: family.launcher_backend };
}

// Local-mode chat dispatch follows the launcher's chooser. The chooser lives
// in os8-launcher (config.yaml::roles.chat + ~/.config/os8-launcher/settings.yaml::role_selections),
// surfaced via /api/triplet/roles. We cache the active chat model + the
// recommended client (per-model field declared in launcher config.yaml) in
// the same payload — single fetch, single TTL, single inflight flag.
const CHAT_TASKS = new Set(['conversation', 'summary', 'planning', 'coding', 'jobs']);
const LAUNCHER_CHAT_CACHE_TTL_MS = 30_000;
let _launcherChatCache = { model: null, recommendedClient: null, ts: 0, inflight: false };

function _refreshLauncherChat() {
  if (_launcherChatCache.inflight) return;
  _launcherChatCache.inflight = true;
  const LauncherClient = require('./launcher-client');
  LauncherClient.getRoles().then(roles => {
    const chat = roles && roles.chat;
    if (chat && chat.selected) {
      const rec = (chat.recommended_client === 'opencode' || chat.recommended_client === 'openhands')
        ? chat.recommended_client
        : null;
      _launcherChatCache = { model: chat.selected, recommendedClient: rec, ts: Date.now(), inflight: false };
    } else {
      _launcherChatCache.inflight = false;
    }
  }).catch(() => {
    // Leave cached value alone; the static fallback below will fill in until
    // the launcher comes back or a successful poll updates the cache.
    _launcherChatCache.inflight = false;
  });
}

/**
 * Hard-coupling read: which CLI runtime should OS8 spawn for local-mode
 * chat? Sourced from the launcher's per-model `recommended_client` field
 * (config.yaml). Caller-side overrides are NOT honored — the launcher is
 * authoritative because the model+CLI pairing is dictated by tool-call
 * protocol compatibility (e.g. Cascade-2 needs OpenHands; Qwen/AEON need
 * OpenCode). Falls back to 'opencode' when launcher is unreachable or the
 * field isn't declared, since OpenCode is the historical default and is
 * the most universally installable.
 */
function _getRecommendedLocalCli() {
  const age = Date.now() - _launcherChatCache.ts;
  if (age > LAUNCHER_CHAT_CACHE_TTL_MS) _refreshLauncherChat();
  return _launcherChatCache.recommendedClient || 'opencode';
}

/**
 * Return the local family that should serve chat tasks under ai_mode='local'
 * — whichever one the launcher's chooser currently points at. Falls back to
 * the lowest display_order chat-capable local family on first call (before
 * the async refresh has populated the cache) or when the launcher is down.
 */
function _resolveLocalChatFamily(db) {
  const age = Date.now() - _launcherChatCache.ts;
  if (age > LAUNCHER_CHAT_CACHE_TTL_MS) _refreshLauncherChat();
  const targetModel = _launcherChatCache.model;
  if (targetModel) {
    const family = db.prepare(
      `SELECT * FROM ai_model_families WHERE container_id = 'local' AND launcher_model = ?`
    ).get(targetModel);
    if (family) return family;
  }
  // First-call / launcher-down fallback: pick the first chat-capable local
  // family by display_order. Matches pre-chooser behavior.
  return db.prepare(`
    SELECT * FROM ai_model_families
    WHERE container_id = 'local' AND cap_chat > 0
      AND (eligible_tasks IS NULL OR eligible_tasks LIKE '%conversation%')
    ORDER BY display_order ASC LIMIT 1
  `).get() || null;
}

const RoutingService = {
  /**
   * Pre-populate the launcher chat cache before consumers call resolve().
   *
   * Without this, the first call to `_resolveLocalChatFamily` after OS8 starts
   * fires the async refresh fire-and-forget but immediately falls back to the
   * lowest display_order chat family — which silently misroutes the request
   * to e.g. Qwen3.6-35B even when Cascade-2 is the running chat model.
   * That fallback then trips the launcher's BUDGET_EXCEEDED admission check
   * because it tries to load a second 36GB model on top of the resident triplet.
   *
   * server.js awaits this once at startup (with the timeout) before any
   * routing-driven engine (DigestEngine, JobScheduler, etc.) begins to tick.
   * Idempotent: subsequent calls return immediately when the cache is warm.
   *
   * @param {number} [timeoutMs=2000] - Hard cap so a slow/unreachable launcher
   *   doesn't block startup. On timeout the cache stays empty; resolve()
   *   degrades to the existing "lowest display_order" fallback.
   * @returns {Promise<void>}
   */
  prewarm(timeoutMs = 2000) {
    return new Promise(resolve => {
      if (_launcherChatCache.model) return resolve();   // already warm
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      const LauncherClient = require('./launcher-client');
      LauncherClient.getRoles().then(roles => {
        const chat = roles && roles.chat;
        if (chat && chat.selected) {
          const rec = (chat.recommended_client === 'opencode' || chat.recommended_client === 'openhands')
            ? chat.recommended_client
            : null;
          _launcherChatCache = {
            model: chat.selected,
            recommendedClient: rec,
            ts: Date.now(),
            inflight: false,
          };
        }
        finish();
      }).catch(finish);
      setTimeout(finish, timeoutMs);
    });
  },

  /**
   * Resolve the best available model family + access method for a task type.
   * @param {object} db - SQLite database
   * @param {string} taskType - 'conversation' | 'jobs' | 'planning' | 'coding'
   * @param {string|null} agentOverride - Family ID from agent config (null or 'auto' = use cascade)
   * @param {object} [opts]
   * @param {'utility'|'agentSpawn'} [opts.purpose='utility'] - Why the caller wants
   *   this resolve. Default 'utility' (subconscious classifier, plan generator,
   *   utility text calls) routes local-mode chat tasks through HTTP `local`
   *   (cheap, single-shot). 'agentSpawn' (only message-handler's CLI-spawn site
   *   passes this) routes local-mode chat tasks through a CLI runtime so
   *   the agent can do real tool use. The split keeps cheap chitchat cheap
   *   while making the heavy path actually capable.
   * @param {'opencode'|'openhands'} [opts.localCli] - DEPRECATED. Pre-0.4.14
   *   callers passed this to override the local-mode CLI runtime per agent or
   *   per build. Ignored as of 0.4.14 — the launcher is the single source of
   *   truth for the model↔CLI pairing (config.yaml::models[*].recommended_client,
   *   surfaced via /api/triplet/roles). Argument retained so legacy callers
   *   don't break, but no path reads it. Remove the parameter once all callers
   *   are cleaned up.
   * @returns {{ familyId: string, backendId: string, modelArg: string|null, accessMethod: string, source: string, launcher_model?: string, launcher_backend?: string }}
   *   For local-container families, the result also carries `launcher_model`
   *   and `launcher_backend` from `ai_model_families` so dispatchers can
   *   call `LauncherClient.ensureModel` without a second DB lookup.
   */
  resolve(db, taskType, agentOverride = null, opts = {}) {
    const { purpose = 'utility' } = opts;

    // 1. Local-mode chat short-circuit takes precedence over per-agent
    // overrides. The launcher's chooser is the single source of truth for
    // "which local chat model is active" — a stale agentModel pin (e.g.
    // local-qwen3-6-35b-a3b saved before the multi-option chooser shipped)
    // must not silently override the user's current launcher selection.
    // Per-agent overrides still apply in proprietary mode and for non-chat
    // tasks under local mode (e.g. image-gen, which has its own family).
    //
    // Backend selection inside the short-circuit:
    //   - purpose='utility' → family.container_id (i.e. 'local', the HTTP
    //     backend). Subconscious classifier, plan generator, utility text
    //     calls all stay cheap and single-shot.
    //   - purpose='agentSpawn' → CLI runtime hard-pinned by the launcher's
    //     `recommended_client` field on the running chat model. Cascade-2 →
    //     'openhands'; Qwen/AEON → 'opencode'. Sourced via _getRecommendedLocalCli
    //     (cached for 30s alongside the chat model). Falls back to 'opencode'
    //     when launcher unreachable. Per-call overrides (opts.localCli) are
    //     deprecated and ignored as of 0.4.14 — the launcher is authoritative
    //     because tool-call protocol compatibility forces the pairing.
    if (this.getMode(db) === 'local' && CHAT_TASKS.has(taskType)) {
      const family = _resolveLocalChatFamily(db);
      if (family) {
        const isAgentSpawn = purpose === 'agentSpawn';
        const localCli = isAgentSpawn ? _getRecommendedLocalCli() : null;
        return _withLauncher(family, {
          familyId: family.id,
          backendId: isAgentSpawn ? localCli : family.container_id,
          modelArg: AIRegistryService.resolveModelArg(db, family.id),
          accessMethod: 'api',
          source: isAgentSpawn
            ? `local_launcher_recommended_${localCli}`
            : 'local_launcher_selection'
        });
      }
      // No chat-capable local family at all — fall through so the hard
      // fallback below can still produce *some* answer (under local mode,
      // that's the local hard fallback, not a cloud family).
    }

    // 2. Agent override — try login first, then API. Honored for every task
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
          return _withLauncher(family, {
            familyId: agentOverride,
            backendId: family.container_id,
            modelArg: AIRegistryService.resolveModelArg(db, agentOverride),
            accessMethod: 'login',
            source: 'agent_override'
          });
        }
        if (this.isAvailable(db, agentOverride, 'api')) {
          return _withLauncher(family, {
            familyId: agentOverride,
            backendId: family.container_id,
            modelArg: AIRegistryService.resolveModelArg(db, agentOverride),
            accessMethod: 'api',
            source: 'agent_override'
          });
        }
      }
      // Override unavailable or not eligible — fall through to cascade.
    }

    // 3. Walk cascade — each entry specifies family + access_method
    const cascade = this.getCascade(db, taskType);
    for (const entry of cascade) {
      if (!entry.enabled) continue;
      if (this.isAvailable(db, entry.family_id, entry.access_method)) {
        const family = AIRegistryService.getFamily(db, entry.family_id);
        if (family) {
          return _withLauncher(family, {
            familyId: entry.family_id,
            backendId: family.container_id,
            modelArg: AIRegistryService.resolveModelArg(db, entry.family_id),
            accessMethod: entry.access_method,
            source: 'cascade'
          });
        }
      }
    }

    // 3. Hard fallback.
    // Under ai_mode='local' we MUST NOT silently route to a cloud family —
    // that's the privacy promise of local mode. Return a local chat family
    // with source='local_no_fallback'; the HTTP dispatcher will surface
    // "launcher unreachable" naturally if it can't serve the request.
    // Note: this is a deviation from Phase 3 §4.2's "throw LOCAL_MODE_NO_FALLBACK"
    // sketch — ~20 resolve() call-sites would need try/catch blocks, so keeping
    // resolve() total (never throws) preserves the existing contract while still
    // honoring the privacy promise.
    const mode = this.getMode(db);
    if (mode === 'local') {
      const fallbackFamily = AIRegistryService.getFamily(db, 'local-gemma-4-31b');
      return _withLauncher(fallbackFamily, {
        familyId: 'local-gemma-4-31b',
        backendId: 'local',
        modelArg: AIRegistryService.resolveModelArg(db, 'local-gemma-4-31b') || 'gemma-4-31B-it-nvfp4',
        accessMethod: 'api',
        source: 'local_no_fallback'
      });
    }
    return {
      familyId: 'claude-sonnet',
      backendId: 'claude',
      modelArg: AIRegistryService.resolveModelArg(db, 'claude-sonnet') || 'sonnet',
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
   * Read the global ai_mode setting. Defaults to 'proprietary' when unset or
   * when the value is not a valid mode — fail-safe so a garbled settings row
   * can never silently enable local mode.
   * @param {object} db
   * @returns {'proprietary' | 'local'}
   */
  getMode(db) {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get('ai_mode');
    return row?.value === 'local' ? 'local' : 'proprietary';
  },

  /**
   * Set the global ai_mode. After writing, the caller typically wants to
   * trigger regenerateAll to refresh auto-generated cascades — but this
   * function only writes the setting; the API route orchestrates.
   * @param {object} db
   * @param {'proprietary' | 'local'} mode
   */
  setMode(db, mode) {
    if (!VALID_MODES.includes(mode)) {
      throw new Error(`Invalid ai_mode: ${mode}. Expected one of: ${VALID_MODES.join(', ')}`);
    }
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)").run('ai_mode', mode);
  },

  /**
   * Get the cascade for a task type under a specific mode.
   * @param {object} db
   * @param {string} taskType
   * @param {'proprietary' | 'local'} [mode] - defaults to current ai_mode
   * @returns {Array}
   */
  getCascade(db, taskType, mode) {
    const m = mode || this.getMode(db);
    return db.prepare(
      'SELECT * FROM routing_cascade WHERE task_type = ? AND mode = ? ORDER BY priority ASC'
    ).all(taskType, m);
  },

  /**
   * Cascade rows the user should SEE for this task — same as what resolve()
   * will actually dispatch to. Differs from getCascade() only when ai_mode
   * is 'local' and the task is a chat task: there it collapses to a single
   * row pointing at the launcher's currently-selected chat family,
   * mirroring resolve()'s short-circuit. The resulting row carries
   * `local_launcher_selection: true` so the cascade UI can lock its
   * toggle/drag controls and surface a "set in launcher" caption.
   *
   * For image tasks and for proprietary mode this returns the full
   * cascade unchanged.
   */
  getDisplayCascade(db, taskType) {
    if (this.getMode(db) === 'local' && CHAT_TASKS.has(taskType)) {
      const family = _resolveLocalChatFamily(db);
      if (family) {
        return [{
          task_type: taskType,
          priority: 0,
          family_id: family.id,
          access_method: 'api',
          enabled: 1,
          is_auto_generated: 1,
          mode: 'local',
          local_launcher_selection: true
        }];
      }
    }
    return this.getCascade(db, taskType);
  },

  /**
   * Phase 3 §4.6 — vision dispatch override. Under ai_mode='local' with
   * image attachments present, swap the resolved family to a vision-capable
   * local family (one with supports_vision=1). Today that's
   * local-qwen3-6-35b-a3b. Returns the resolved object unchanged when:
   *   - no attachments
   *   - ai_mode is 'proprietary' (cloud CLIs handle images via their own flags)
   *   - the resolved family is already vision-capable
   *   - no vision-capable local family exists (don't silently swap to a worse model)
   *
   * @param {object} db
   * @param {object} resolved - the output of resolve()
   * @param {boolean} hasAttachments - whether the current message carries image data
   * @returns {object} resolved object — either the original or a vision-swapped one
   */
  maybeSwapForVision(db, resolved, hasAttachments) {
    if (!hasAttachments) return resolved;
    if (this.getMode(db) !== 'local') return resolved;
    const current = AIRegistryService.getFamily(db, resolved.familyId);
    if (current?.supports_vision === 1) return resolved;
    const visionFamily = db.prepare(`
      SELECT id, container_id, launcher_model, launcher_backend FROM ai_model_families
      WHERE container_id = 'local' AND supports_vision = 1
      ORDER BY display_order ASC LIMIT 1
    `).get();
    if (!visionFamily) return resolved;
    // Phase 2B: include launcher metadata so the HTTP dispatcher can ensure
    // the vision model is loaded before the chat call.
    return {
      familyId: visionFamily.id,
      backendId: visionFamily.container_id,
      modelArg: AIRegistryService.resolveModelArg(db, visionFamily.id),
      accessMethod: 'api',
      source: 'vision_override',
      launcher_model: visionFamily.launcher_model,
      launcher_backend: visionFamily.launcher_backend
    };
  },

  /**
   * Find the cascade entry that follows a given (familyId, accessMethod) under
   * the current ai_mode. Phase 3 §4.3: jobs escalation uses this to bounce
   * one step down the cascade after a tool_call parse failure on the primary.
   *
   * Returns the next entry whose `enabled` flag is set, or null if the
   * current entry is the last one (or absent).
   *
   * @param {object} db
   * @param {string} taskType
   * @param {string} currentFamilyId
   * @param {string} [accessMethod='api']
   * @param {'proprietary' | 'local'} [mode] - defaults to current ai_mode
   * @returns {object|null} The next routing_cascade row, or null if none
   */
  nextInCascade(db, taskType, currentFamilyId, accessMethod = 'api', mode) {
    const cascade = this.getCascade(db, taskType, mode);
    const currentIdx = cascade.findIndex(
      e => e.family_id === currentFamilyId && e.access_method === accessMethod
    );
    if (currentIdx === -1) return null;
    for (let i = currentIdx + 1; i < cascade.length; i++) {
      if (cascade[i].enabled) return cascade[i];
    }
    return null;
  },

  /**
   * Update the cascade for a task type + mode (user reordering).
   * @param {object} db
   * @param {string} taskType
   * @param {Array<{ family_id: string, access_method: string, enabled: boolean }>} entries
   * @param {'proprietary' | 'local'} [mode] - defaults to current ai_mode
   */
  updateCascade(db, taskType, entries, mode) {
    const m = mode || this.getMode(db);
    const update = db.transaction(() => {
      db.prepare('DELETE FROM routing_cascade WHERE task_type = ? AND mode = ?').run(taskType, m);
      const insert = db.prepare(
        'INSERT INTO routing_cascade (task_type, priority, family_id, access_method, enabled, is_auto_generated, mode) VALUES (?, ?, ?, ?, ?, 0, ?)'
      );
      entries.forEach((entry, idx) => {
        insert.run(taskType, idx, entry.family_id, entry.access_method || 'api', entry.enabled ? 1 : 0, m);
      });
    });
    update();
  },

  /**
   * Generate cascade for a single task type + mode based on preference.
   * Creates login + API entries per family (login gets discounted cost).
   * Mode filter is symmetric:
   *   'proprietary' → non-HTTP containers only (cloud CLIs)
   *   'local'       → HTTP containers only (os8-launcher)
   * @param {object} db
   * @param {string} taskType
   * @param {'proprietary' | 'local'} [mode='proprietary']
   * @returns {Array<{ family_id: string, access_method: string, score: number, cost_display: number }>}
   */
  generateCascade(db, taskType, mode = 'proprietary') {
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
      // Mode filter — proprietary excludes local, local excludes proprietary.
      // Replaces the os8-3-1 one-liner that unconditionally skipped HTTP
      // families (correct for proprietary, but meant local cascades couldn't
      // be generated at all). os8-3-2 turns it into symmetric filtering.
      const isHttp = container?.type === 'http';
      if (mode === 'proprietary' && isHttp) continue;
      if (mode === 'local' && !isHttp) continue;
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
   * Regenerate all cascades based on current preference — once per mode.
   * Per-mode behavior:
   *   1. Delete auto-generated rows for that mode.
   *   2. If any manual rows remain under that mode, skip regeneration for it
   *      (preserves the user's customizations). The other mode still runs.
   * This diverges from pre-Phase-3 behavior (single global skip) so a user
   * who customized their proprietary cascade still gets auto-local seeds.
   * @param {object} db
   */
  regenerateAll(db) {
    const regen = db.transaction(() => {
      for (const mode of VALID_MODES) {
        db.prepare('DELETE FROM routing_cascade WHERE is_auto_generated = 1 AND mode = ?').run(mode);
        const hasCustom = db.prepare('SELECT COUNT(*) as cnt FROM routing_cascade WHERE mode = ?').get(mode).cnt > 0;
        if (hasCustom) continue;

        const insert = db.prepare(
          'INSERT INTO routing_cascade (task_type, priority, family_id, access_method, enabled, is_auto_generated, mode) VALUES (?, ?, ?, ?, 1, 1, ?)'
        );
        for (const taskType of TASK_TYPES) {
          const cascade = this.generateCascade(db, taskType, mode);
          cascade.forEach((entry, idx) => {
            insert.run(taskType, idx, entry.family_id, entry.access_method, mode);
          });
        }
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

  /** Regenerate cascade for a single task type — both modes. */
  _regenerateTaskType(db, taskType) {
    const regen = db.transaction(() => {
      for (const mode of VALID_MODES) {
        db.prepare('DELETE FROM routing_cascade WHERE task_type = ? AND mode = ?').run(taskType, mode);
        const cascade = this.generateCascade(db, taskType, mode);
        const insert = db.prepare(
          'INSERT INTO routing_cascade (task_type, priority, family_id, access_method, enabled, is_auto_generated, mode) VALUES (?, ?, ?, ?, 1, 1, ?)'
        );
        cascade.forEach((entry, idx) => {
          insert.run(taskType, idx, entry.family_id, entry.access_method, mode);
        });
      }
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
    // 'local' is an HTTP pseudo-provider — no login, no API keys. Every task
    // is accessed via 'api' (the access_method convention for HTTP families).
    defaults.local = {};
    for (const tt of TASK_TYPES) {
      defaults.local[tt] = 'api';
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
  PROVIDER_IDS,
  VALID_MODES
};

module.exports = RoutingService;
