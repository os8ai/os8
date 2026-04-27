/**
 * LauncherClient — thin HTTP wrapper for the os8-launcher control plane
 * (http://localhost:9000/api/*). No business logic.
 *
 * Phase 1 used this to discover what model was currently serving (single
 * model at a time). Phase 2B adds `ensureModel` + `touch`, which let the
 * dispatcher request a specific (model, backend) be loaded on demand;
 * the launcher's resident pool / LRU eviction / concurrent serving handle
 * the rest. Data-plane calls (chat, audio, image-gen) still go directly
 * to the per-backend ports returned by ensure.
 */

const DEFAULT_BASE = 'http://localhost:9000';

// Error codes returned by the launcher on ensure failures, plus the
// transport-level codes we synthesize when fetch itself fails. Exported so
// dispatchers can pattern-match without string-matching error messages.
const LAUNCHER_ERROR_CODES = Object.freeze({
  LAUNCHER_UNREACHABLE: 'LAUNCHER_UNREACHABLE',  // network error / launcher down
  BAD_REQUEST:          'BAD_REQUEST',           // 400 — unknown model/backend
  MODEL_NOT_DOWNLOADED: 'MODEL_NOT_DOWNLOADED',  // launcher reports weights missing
  BUDGET_EXCEEDED:      'BUDGET_EXCEEDED',       // 409 — VRAM full, no LRU victims
  START_FAILED:         'START_FAILED',          // 500 — container/process failed to spawn
  MODEL_LOAD_TIMEOUT:   'MODEL_LOAD_TIMEOUT'     // synthesized by the polling caller
});

async function _fetchJson(url, { timeoutMs = 3000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`${url} returned ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const LauncherClient = {
  DEFAULT_BASE,
  LAUNCHER_ERROR_CODES,

  /** Fetch what's currently running. Shape: { backends: [...], backend: {...} | null, clients: {...} }. */
  async getStatus(baseUrl = DEFAULT_BASE) {
    return _fetchJson(`${baseUrl}/api/status`);
  },

  /**
   * Fetch per-task capability map. Shape (Phase 2 onward):
   *   { taskType: [{ instance_id, model, base_url, model_id, priority }, ...] }
   * Pre-Phase-2 launchers returned a single object per task; both shapes
   * coexist in code that walks caps.
   */
  async getCapabilities(baseUrl = DEFAULT_BASE) {
    return _fetchJson(`${baseUrl}/api/status/capabilities`);
  },

  /** List models known to the launcher's config (downloaded or not). */
  async listAvailableModels(baseUrl = DEFAULT_BASE) {
    return _fetchJson(`${baseUrl}/api/models`);
  },

  /**
   * Fetch the per-role triplet chooser state from the launcher.
   * Shape (one entry per role declared in the launcher's config.yaml):
   *   { <role>: {
   *       options: [{model, backend, label}, ...],
   *       default: <model>,             // config.yaml default
   *       selected: <model>,            // user-persisted selection or default
   *       running_model: <model>|null,  // whichever option is currently up
   *       needs_apply: boolean
   *   } }
   * Throws when the launcher is unreachable or running an older version
   * without /api/triplet/roles — callers should fall back to a static
   * triplet definition.
   */
  async getRoles(baseUrl = DEFAULT_BASE) {
    return _fetchJson(`${baseUrl}/api/triplet/roles`);
  },

  /**
   * Convenience: pull the launcher's recommended client for the chat slot.
   * Used by RoutingService + the terminal-tab/build-proposal UI to hard-pin
   * which CLI runtime OS8 spawns under ai_mode='local'. Returns null when
   * the launcher is unreachable or doesn't expose the field — callers
   * should fall back to their own default ('opencode' is the historical pick).
   *
   * Cached results piggyback on getRoles() — no additional caching layer here;
   * RoutingService maintains its own 30s cache for the resolved family.
   */
  async getRecommendedChatClient(baseUrl = DEFAULT_BASE) {
    try {
      const roles = await this.getRoles(baseUrl);
      const cli = roles?.chat?.recommended_client;
      return (cli === 'opencode' || cli === 'openhands') ? cli : null;
    } catch {
      return null;
    }
  },

  /**
   * Quick liveness check — does the launcher respond on :9000?
   * Used by the feature-flag gate and future preflight UI.
   */
  async isReachable(baseUrl = DEFAULT_BASE) {
    try {
      await _fetchJson(`${baseUrl}/api/health`, { timeoutMs: 1500 });
      return true;
    } catch {
      return false;
    }
  },

  /**
   * Idempotent "make sure this (model, backend) is loaded" — Phase 2B.
   *
   * Returns the launcher's response on success:
   *   { status: 'ready' | 'loading',
   *     instance_id, port, base_url, model, backend, evicted: [...] }
   *
   * Throws an Error with `.code` set to one of LAUNCHER_ERROR_CODES on
   * failure. Callers branch on `.code` to render specific UX
   * (BUDGET_EXCEEDED → "VRAM full", LAUNCHER_UNREACHABLE → "launcher down",
   * etc.) — see Phase 2B §4.6 for the toast mapping.
   *
   * `wait: true` blocks the launcher up to the manifest's health_timeout
   * (30-60 min for NIM, 60-120s for vLLM/ollama). The default wait=false
   * returns immediately with status='loading' for fresh starts, and the
   * caller polls by re-calling ensureModel (idempotent).
   *
   * @param {{ model: string, backend?: string|null, wait?: boolean, baseUrl?: string }} opts
   * @returns {Promise<object>}
   */
  async ensureModel({ model, backend = null, wait = false, baseUrl = DEFAULT_BASE }) {
    if (!model) {
      const err = new Error('ensureModel: model is required');
      err.code = LAUNCHER_ERROR_CODES.BAD_REQUEST;
      throw err;
    }
    let res;
    try {
      res = await fetch(`${baseUrl}/api/serve/ensure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, backend, wait })
      });
    } catch (e) {
      // fetch threw — DNS, connection refused, etc. Launcher is down.
      const err = new Error(`Launcher unreachable: ${e.message}`);
      err.code = LAUNCHER_ERROR_CODES.LAUNCHER_UNREACHABLE;
      err.cause = e;
      throw err;
    }
    if (res.ok) {
      return res.json();
    }
    // Error path — try to extract the launcher's structured detail. FastAPI
    // wraps HTTPException(detail={...}) as { detail: { code, message } }.
    let body = {};
    try { body = await res.json(); } catch (_e) { /* leave body empty */ }
    const detail = body?.detail;
    let code, message;
    if (detail && typeof detail === 'object') {
      code = detail.code;
      message = detail.message;
    } else {
      message = (typeof detail === 'string' ? detail : null) || `${res.status} ${res.statusText}`;
    }
    if (!code) {
      // Map common HTTP codes when the launcher didn't supply a structured one.
      if (res.status === 400) code = LAUNCHER_ERROR_CODES.BAD_REQUEST;
      else if (res.status === 404) code = LAUNCHER_ERROR_CODES.MODEL_NOT_DOWNLOADED;
      else if (res.status === 409) code = LAUNCHER_ERROR_CODES.BUDGET_EXCEEDED;
      else code = LAUNCHER_ERROR_CODES.START_FAILED;
    }
    const err = new Error(message || `Launcher /api/serve/ensure returned ${res.status}`);
    err.code = code;
    err.status = res.status;
    throw err;
  },

  /**
   * Mark an instance as recently used — LRU signal for the launcher's
   * eviction policy. Fire-and-forget by design: failures are silenced
   * because nothing the caller can do is useful (launcher down → next
   * ensure handles it; eviction race → already too late).
   *
   * @param {string} instanceId
   * @param {string} [baseUrl]
   * @returns {Promise<void>}
   */
  async touch(instanceId, baseUrl = DEFAULT_BASE) {
    if (!instanceId) return;
    try {
      await fetch(`${baseUrl}/api/serve/touch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instance_id: instanceId })
      });
    } catch (_e) {
      // Swallow — see docstring.
    }
  }
};

module.exports = LauncherClient;
