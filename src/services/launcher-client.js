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

const LauncherClient = {
  DEFAULT_BASE,

  /** Fetch what's currently running. Shape: { backend: {...} | null, clients: {...} }. */
  async getStatus(baseUrl = DEFAULT_BASE) {
    return _fetchJson(`${baseUrl}/api/status`);
  },

  /**
   * Fetch per-task capability map. Shape: { taskType: { model, base_url, model_id } }.
   * Empty object when nothing is serving.
   */
  async getCapabilities(baseUrl = DEFAULT_BASE) {
    return _fetchJson(`${baseUrl}/api/status/capabilities`);
  },

  /** List models known to the launcher's config (downloaded or not). */
  async listAvailableModels(baseUrl = DEFAULT_BASE) {
    return _fetchJson(`${baseUrl}/api/models`);
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
