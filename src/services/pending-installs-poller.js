/**
 * Cross-device install polling.
 *
 * Spec §6 + plan §3 PR 1.26. When a signed-in user clicks Install on os8.ai
 * from a different device, that website call (PR 0.11) creates a row in
 * `PendingInstall`. The desktop polls every 60s; for each pending row it
 * receives, it sends `app-store:open-install-plan` to the renderer and
 * marks the row consumed so it doesn't re-fire.
 *
 * **Inert in two cases**:
 *   - No signed-in account → no userId to query.
 *   - os8.ai endpoint returns 401/404 → stays quiet (Phase 0 PR 0.11 hasn't
 *     shipped yet; the poller is forward-compatible).
 *
 * Auth model: AccountService doesn't persist long-lived tokens — it caches
 * the profile after a one-shot PKCE exchange (src/services/account.js:4).
 * For Phase 1, the poller passes the local user's os8_user_id as a query
 * param. PR 0.11's auth model decides how to gate that — bearer token,
 * one-time-use HMAC, or just trust-the-user-id (low-stakes data).
 */

const DEFAULT_INTERVAL_MS = 60_000;
const FIRST_TICK_DELAY_MS = 5_000;
const REQUEST_TIMEOUT_MS  = 10_000;
const DEFAULT_API_BASE = process.env.OS8_API_BASE || 'https://os8.ai';

const PendingInstallsPoller = {
  _timer: null,
  _firstTimer: null,

  /**
   * Begin polling. Idempotent — calling start() twice replaces the previous
   * timer. Stop() clears it cleanly.
   *
   * @param {object} db
   * @param {Electron.BrowserWindow|null} mainWindow
   * @param {{ intervalMs?: number, apiBase?: string }} [opts]
   */
  start(db, mainWindow, { intervalMs = DEFAULT_INTERVAL_MS, apiBase = DEFAULT_API_BASE } = {}) {
    PendingInstallsPoller.stop();
    const tick = () => PendingInstallsPoller._tick(db, mainWindow, { apiBase })
      .catch(e => console.warn('[PendingInstalls] tick error:', e?.message));
    PendingInstallsPoller._timer = setInterval(tick, intervalMs);
    PendingInstallsPoller._timer.unref?.();
    // First tick after a short delay so we don't compete with startup work.
    PendingInstallsPoller._firstTimer = setTimeout(tick, FIRST_TICK_DELAY_MS);
    PendingInstallsPoller._firstTimer.unref?.();
  },

  stop() {
    if (PendingInstallsPoller._timer) {
      clearInterval(PendingInstallsPoller._timer);
      PendingInstallsPoller._timer = null;
    }
    if (PendingInstallsPoller._firstTimer) {
      clearTimeout(PendingInstallsPoller._firstTimer);
      PendingInstallsPoller._firstTimer = null;
    }
  },

  /**
   * One poll cycle. Exposed for tests; production calls go through start().
   */
  async _tick(db, mainWindow, { apiBase = DEFAULT_API_BASE } = {}) {
    if (!db || !mainWindow || mainWindow.isDestroyed?.()) return { skipped: true };

    const AccountService = require('./account');
    const account = AccountService.getAccount(db);
    if (!account?.os8_user_id) return { skipped: true, reason: 'no signed-in user' };

    let resp;
    try {
      resp = await fetch(
        `${apiBase}/api/account/pending-installs?userId=${encodeURIComponent(account.os8_user_id)}`,
        {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }
      );
    } catch (e) {
      return { skipped: true, error: e.message };
    }
    // 401/404 means the endpoint isn't ready yet (Phase 0 PR 0.11 not deployed).
    // 5xx is transient — retry next tick.
    if (resp.status === 401 || resp.status === 404) {
      return { skipped: true, status: resp.status };
    }
    if (!resp.ok) return { skipped: true, status: resp.status };

    let body;
    try { body = await resp.json(); }
    catch (_) { return { skipped: true, error: 'json parse failed' }; }

    const pendingInstalls = Array.isArray(body?.pendingInstalls) ? body.pendingInstalls : [];
    if (pendingInstalls.length === 0) return { dispatched: 0 };

    let dispatched = 0;
    for (const p of pendingInstalls) {
      if (!p?.appSlug || !p?.upstreamResolvedCommit) continue;
      try {
        mainWindow.webContents.send('app-store:open-install-plan', {
          slug: p.appSlug,
          commit: p.upstreamResolvedCommit,
          channel: p.channel || 'verified',
          source: 'os8.ai-cross-device',
          pendingInstallId: p.id,
        });
      } catch (_) { /* renderer may be reloading — try next tick */ continue; }

      // Fire-and-forget consume so it doesn't re-fire on next tick.
      if (p.id) {
        fetch(`${apiBase}/api/account/pending-installs/${encodeURIComponent(p.id)}/consume`, {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ userId: account.os8_user_id }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }).catch(() => { /* best-effort */ });
      }
      dispatched++;
    }
    return { dispatched, total: pendingInstalls.length };
  },
};

module.exports = PendingInstallsPoller;
