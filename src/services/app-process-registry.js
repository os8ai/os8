/**
 * AppProcessRegistry — lifecycle for external app processes.
 *
 * Spec §6.2.4 + plan §3 PR 1.12.
 *
 * Responsibilities:
 *   - Start/stop external app processes via the runtime adapter (PR 1.11).
 *   - Allocate a unique port in [40000, 49999], reroll on EADDRINUSE.
 *   - Multi-signal idle reaping (HTTP + stdout + child) with per-app
 *     `keepRunning` override. Default idle timeout is 30 minutes; the
 *     reaper runs every 5 minutes and stops processes idle on ALL signals.
 *   - `stopAll()` on app quit to avoid orphaned dev servers.
 *
 * The HTTP activity signal is wired by ReverseProxyService (PR 1.13) — its
 * middleware calls `markHttpActive(appId)` per request. The stdout signal
 * is wired here via the adapter's onLog callback. The child-process signal
 * is heuristic: regex over onLog chunks for "child … spawned" / "fork …
 * spawned" patterns.
 */

const net = require('node:net');
const path = require('node:path');
const yaml = require('js-yaml');

const { APPS_DIR } = require('../config');

const PORT_MIN = 40000;
const PORT_MAX = 49999;
const PORT_REROLL_MAX = 5;
const DEFAULT_IDLE_MS = 30 * 60 * 1000;     // 30 min default — surface as Settings slider in PR 1.22
const REAPER_INTERVAL_MS = 5 * 60 * 1000;
const CHILD_ACTIVITY_RE = /\b(child|fork)\s+\S+\s+spawned\b/i;

class AppProcessRegistry {
  constructor({ db, getOS8Port }) {
    if (!db) throw new Error('AppProcessRegistry: db required');
    if (typeof getOS8Port !== 'function') {
      throw new Error('AppProcessRegistry: getOS8Port (function) required');
    }
    this.db = db;
    this.getOS8Port = getOS8Port;
    this._processes = new Map();   // appId -> entry
    this._reaperTimer = null;
    // PR 1.22: idle timeout is settings-driven. Settings.get returns null
    // when missing — fall back to the 30 min default.
    this.idleMs = readIdleSetting(db) ?? DEFAULT_IDLE_MS;
  }

  setIdleTimeout(ms) {
    if (typeof ms === 'number' && ms > 0) this.idleMs = ms;
  }

  /**
   * Start an external app's dev server.
   *
   * @param {string} appId
   * @param {object} [opts]
   * @param {boolean} [opts.devMode=false]
   * @param {Function} [opts.onProgress]
   * @returns {Promise<object>} the registry entry { appId, pid, port, status, ... }
   */
  async start(appId, { devMode = false, onProgress } = {}) {
    if (this._processes.has(appId)) return this._processes.get(appId);

    const { AppService } = require('./app');
    const app = AppService.getById(this.db, appId);
    if (!app) throw new Error(`app ${appId} not found`);
    if (app.app_type !== 'external') {
      throw new Error(`app ${appId} is not external (app_type=${app.app_type})`);
    }
    if (!app.manifest_yaml) {
      throw new Error(`app ${appId} has no manifest_yaml`);
    }

    const manifest = yaml.load(app.manifest_yaml);
    if (!manifest?.runtime?.kind) {
      throw new Error(`app ${appId} manifest missing runtime.kind`);
    }
    manifest._localSlug = app.slug;

    const { getAdapter } = require('./runtime-adapters');
    const adapter = getAdapter(manifest.runtime.kind);

    const port = await AppProcessRegistry._allocatePort();
    const { buildSanitizedEnv } = require('./sanitized-env');
    const env = buildSanitizedEnv(this.db, {
      appId,
      allocatedPort: port,
      manifestEnv: manifest.env || [],
      localSlug: app.slug,
      OS8_PORT: this.getOS8Port(),
    });
    const appDir = path.join(APPS_DIR, appId);

    // The onLog callback feeds three activity signals at once: stdout
    // freshness, child-process freshness (regex), and a copy to the
    // optional progress callback.
    const onLog = (stream, chunk) => {
      this.markStdoutActive(appId);
      const s = String(chunk || '');
      if (CHILD_ACTIVITY_RE.test(s)) this.markChildActive(appId);
      onProgress?.({ kind: 'log', stream, chunk: s });
    };

    const info = await adapter.start(manifest, appDir, env, onLog);

    const entry = {
      appId,
      pid: info.pid,
      port,
      status: 'starting',
      startedAt: Date.now(),
      lastHttpAt: Date.now(),
      lastStdoutAt: Date.now(),
      lastChildAt: Date.now(),
      devMode,
      keepRunning: false,
      _adapter: adapter,
      _adapterInfo: info,
      _watcherDispose: null,
    };
    this._processes.set(appId, entry);

    try {
      await info.ready;
      entry.status = 'running';
      onProgress?.({ kind: 'ready' });
    } catch (err) {
      entry.status = 'failed';
      this._processes.delete(appId);
      try { await adapter.stop(info); } catch (_) { /* already dead */ }
      throw err;
    }

    if (devMode) {
      entry._watcherDispose = adapter.watchFiles(manifest, appDir,
        (event) => onProgress?.({ kind: 'change', ...event }));
    }

    if (!this._reaperTimer) this._startReaper();
    return entry;
  }

  async stop(appId, { reason = 'manual' } = {}) {
    const entry = this._processes.get(appId);
    if (!entry) return;
    entry.status = 'stopping';
    try { entry._watcherDispose?.(); } catch (_) { /* ignore */ }
    try { await entry._adapter.stop(entry._adapterInfo); }
    catch (e) { console.warn(`[AppProcessRegistry] stop ${appId} (${reason}):`, e.message); }
    entry.status = 'stopped';
    this._processes.delete(appId);
  }

  get(appId)  { return this._processes.get(appId) || null; }
  getAll()    { return Array.from(this._processes.values()); }

  markHttpActive(appId)   { const r = this._processes.get(appId); if (r) r.lastHttpAt   = Date.now(); }
  markStdoutActive(appId) { const r = this._processes.get(appId); if (r) r.lastStdoutAt = Date.now(); }
  markChildActive(appId)  { const r = this._processes.get(appId); if (r) r.lastChildAt  = Date.now(); }

  setKeepRunning(appId, v) {
    const r = this._processes.get(appId);
    if (r) r.keepRunning = !!v;
  }

  reapIdle({ now = Date.now() } = {}) {
    const reaped = [];
    for (const r of this._processes.values()) {
      if (r.keepRunning) continue;
      const idleAll =
        (now - r.lastHttpAt   > this.idleMs) &&
        (now - r.lastStdoutAt > this.idleMs) &&
        (now - r.lastChildAt  > this.idleMs);
      if (idleAll) {
        reaped.push(r.appId);
        // Don't await — reaping a slow process shouldn't block the timer.
        this.stop(r.appId, { reason: 'idle' }).catch(() => {});
      }
    }
    return reaped;
  }

  async stopAll() {
    const ids = Array.from(this._processes.keys());
    await Promise.allSettled(ids.map(id => this.stop(id, { reason: 'shutdown' })));
    if (this._reaperTimer) {
      clearInterval(this._reaperTimer);
      this._reaperTimer = null;
    }
  }

  _startReaper() {
    this._reaperTimer = setInterval(() => this.reapIdle(), REAPER_INTERVAL_MS);
    // Don't keep the process alive on the reaper alone (Linux/macOS).
    this._reaperTimer.unref?.();
  }

  // ── Static helpers ────────────────────────────────────────────────────────

  static async _allocatePort() {
    for (let i = 0; i < PORT_REROLL_MAX; i++) {
      const p = PORT_MIN + Math.floor(Math.random() * (PORT_MAX - PORT_MIN + 1));
      if (await AppProcessRegistry._isFree(p)) return p;
    }
    return await AppProcessRegistry._osAllocate();
  }

  static _isFree(port) {
    return new Promise(resolve => {
      const s = net.createServer();
      s.unref?.();
      s.once('error', () => resolve(false));
      s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
    });
  }

  static _osAllocate() {
    return new Promise(resolve => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => {
        const p = s.address().port;
        s.close(() => resolve(p));
      });
    });
  }
}

// Read the idle-timeout from the settings table. `null` means "not set;
// use the default". `0` (or negative) means "never reap" — the reaper
// loop's keepRunning bypass logic doesn't help here because it's per-app,
// so we shape the value as-if the user set Infinity.
function readIdleSetting(db) {
  try {
    const row = db.prepare(
      `SELECT value FROM settings WHERE key = 'external_app_idle_timeout_ms'`
    ).get();
    if (!row?.value) return null;
    const n = Number(row.value);
    if (!Number.isFinite(n) || n < 0) return null;
    return n === 0 ? Number.MAX_SAFE_INTEGER : n;
  } catch (_) {
    return null;
  }
}

// Singleton wiring — the API surface PR 1.13 calls into.
let _instance = null;

function init({ db, getOS8Port }) {
  _instance = new AppProcessRegistry({ db, getOS8Port });
  return _instance;
}

function get() {
  if (!_instance) {
    throw new Error('AppProcessRegistry not initialized — call init({db,getOS8Port}) first');
  }
  return _instance;
}

function reset() {
  _instance = null;
}

module.exports = {
  init,
  get,
  reset,
  AppProcessRegistry,
  // Constants exposed for tests + future Settings slider (PR 1.22).
  DEFAULT_IDLE_MS,
  PORT_MIN,
  PORT_MAX,
};
