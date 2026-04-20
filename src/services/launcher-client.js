/**
 * LauncherClient — thin HTTP wrapper for the os8-launcher control plane
 * (http://localhost:9000/api/*). No business logic.
 *
 * Phase 1 uses this to discover what model is currently being served and on
 * which port, so the local backend can POST to the right /v1/chat/completions
 * endpoint. The data plane (chat completions) is hit directly via fetch in
 * backend-adapter.js — this client is control-plane only.
 */

const DEFAULT_BASE = 'http://localhost:9000';

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

/**
 * Structured error thrown by ensureModel / touch / getInstanceStatus on
 * HTTP-level failures. `code` carries the launcher's machine-readable
 * error code when available (BUDGET_EXCEEDED, START_FAILED,
 * MODEL_NOT_DOWNLOADED, ...) — callers branch on it to render the right
 * UX. Falls back to LAUNCHER_UNREACHABLE when the launcher itself is
 * unreachable (fetch throws) or returns something shaped like an error.
 */
class LauncherError extends Error {
  constructor(message, { code = 'LAUNCHER_ERROR', status = 0, cause = null } = {}) {
    super(message);
    this.name = 'LauncherError';
    this.code = code;
    this.status = status;
    if (cause) this.cause = cause;
  }
}

async function _postJson(url, body, { timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });
  } catch (err) {
    throw new LauncherError(
      `${url} unreachable: ${err.message}`,
      { code: 'LAUNCHER_UNREACHABLE', cause: err }
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* plain text */ }
  if (!res.ok) {
    // FastAPI HTTPException serializes as {"detail": ...}. When the handler
    // passed a dict for detail (as ensure does for coded errors), it's an
    // object — pull code + message out. Otherwise fall back to status-derived
    // defaults.
    const detail = json?.detail;
    const code =
      (detail && typeof detail === 'object' && detail.code) ||
      (res.status === 409 ? 'BUDGET_EXCEEDED' : 'START_FAILED');
    const message =
      (detail && typeof detail === 'object' && detail.message) ||
      (typeof detail === 'string' ? detail : `${url} returned ${res.status}`);
    throw new LauncherError(message, { code, status: res.status });
  }
  return json;
}

const LauncherClient = {
  DEFAULT_BASE,
  LauncherError,

  /** Fetch what's currently running. Shape includes backends:[...] (Phase 2)
   * and a backend:{} back-compat shim. */
  async getStatus(baseUrl = DEFAULT_BASE) {
    return _fetchJson(`${baseUrl}/api/status`);
  },

  /**
   * Fetch per-task capability map. Phase-2 shape:
   *   { taskType: [ { instance_id, model, base_url, model_id, priority }, ... ] }
   * Phase-1 shipped objects (not arrays) — os8-2 consumers read this as
   * an array; upgrading the launcher first keeps compatibility.
   */
  async getCapabilities(baseUrl = DEFAULT_BASE) {
    return _fetchJson(`${baseUrl}/api/status/capabilities`);
  },

  /** List models known to the launcher's config (downloaded or not). */
  async listAvailableModels(baseUrl = DEFAULT_BASE) {
    return _fetchJson(`${baseUrl}/api/models`);
  },

  /**
   * Idempotent "make sure this model is up". Returns
   *   { status: 'ready'|'loading', instance_id, port, base_url, model,
   *     backend, evicted: [...] }
   * On HTTP error, throws LauncherError with .code set to
   * BUDGET_EXCEEDED / START_FAILED / LAUNCHER_UNREACHABLE.
   *
   * `model` and `backend` match launcher config.yaml names — pass the
   * family's cli_model_arg and launcher_backend columns respectively.
   * `wait: true` blocks the launcher side up to the manifest's
   * health_timeout; default false returns immediately after scheduling.
   */
  async ensureModel({ model, backend = null, wait = false, baseUrl = DEFAULT_BASE } = {}) {
    if (!model) {
      throw new LauncherError('ensureModel requires model', { code: 'BAD_REQUEST' });
    }
    const body = { model, wait };
    if (backend) body.backend = backend;
    // Generous timeout when wait=true — the launcher can legitimately
    // hold the request open until the model is healthy (minutes, not
    // seconds). Without, a short timeout is fine; ensure kicks off the
    // start as a background task and returns in ~10ms.
    const timeoutMs = wait ? 15 * 60 * 1000 : 5000;
    return _postJson(`${baseUrl}/api/serve/ensure`, body, { timeoutMs });
  },

  /**
   * Fire-and-forget LRU signal — records that `instance_id` just served
   * a request. Returns { touched: bool } but callers shouldn't block
   * on it: a failing touch is a hint loss, not an error worth
   * surfacing. Launcher-4 uses this for eviction ordering.
   */
  async touch(instanceId, baseUrl = DEFAULT_BASE) {
    if (!instanceId) return { touched: false };
    try {
      return await _postJson(`${baseUrl}/api/serve/touch`, { instance_id: instanceId }, { timeoutMs: 1500 });
    } catch (_err) {
      return { touched: false };
    }
  },

  /**
   * Poll for a single instance's current status. Thin helper over
   * /api/status that filters out the list to the requested id. Returns
   * null if not found (e.g. mid-load before set_backend runs, or mid-
   * eviction).
   */
  async getInstanceStatus(instanceId, baseUrl = DEFAULT_BASE) {
    const data = await _fetchJson(`${baseUrl}/api/status`);
    const backends = Array.isArray(data?.backends) ? data.backends : [];
    return backends.find(b => b.instance_id === instanceId) || null;
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
  }
};

module.exports = LauncherClient;
