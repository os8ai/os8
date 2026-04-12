/**
 * AppCheckerService
 *
 * Fast, in-process compile check for an OS8 app. Uses the already-running Vite
 * middleware (shared across all apps) to walk the module graph starting from
 * the app's entry file, collecting any parse/resolve errors along the way.
 *
 * No subprocess spawns, no fs writes, no symlinks. Strictly per-app scoped:
 * the caller passes appPath and the service only requests URLs prefixed with
 * /{appId}/. Dependencies inside node_modules are skipped (they're shared and
 * already validated at Vite startup via optimizeDeps).
 *
 * Targets Vite 5.x error shape (err.message, err.loc, err.frame, err.plugin,
 * err.id). May need tweaking if Vite is upgraded.
 */

const fs = require('fs');
const path = require('path');

const MAX_MODULES = 500;
const MAX_WALL_MS = 30000;

/**
 * Normalize a Vite transform error into a flat, serializable object.
 */
function normalizeViteError(err, requestedUrl) {
  const loc = err && err.loc;
  return {
    file: (loc && loc.file) || err?.id || requestedUrl,
    line: loc?.line ?? null,
    column: loc?.column ?? null,
    message: err?.message || String(err),
    frame: err?.frame || null,
    plugin: err?.plugin || null,
    id: err?.id || null,
    requestedUrl
  };
}

/**
 * Decide whether to enqueue a dep URL. Skip:
 *  - already-seen URLs
 *  - URLs resolved inside node_modules (shared deps, pre-validated)
 *  - Vite virtual modules (start with \0 or contain ?v= query hash)
 */
function shouldWalk(url, seen) {
  if (!url) return false;
  if (seen.has(url)) return false;
  if (url.startsWith('\0')) return false;
  if (url.includes('/node_modules/')) return false;
  return true;
}

const AppCheckerService = {
  /**
   * Run a compile check over an app's module graph.
   *
   * @param {object} opts
   * @param {object} opts.viteServer - Running Vite dev server instance
   * @param {string} opts.appId - The app ID (used as URL prefix)
   * @param {string} opts.appPath - Absolute path to the app directory
   * @returns {Promise<{ok, errors, checkedCount, elapsedMs}>}
   */
  async check({ viteServer, appId, appPath }) {
    const startedAt = Date.now();

    if (!viteServer) {
      return {
        ok: false,
        errors: [{
          file: null, line: null, column: null,
          message: 'Vite middleware is not available (Core may still be installing or failed to start).',
          frame: null, plugin: null, id: null, requestedUrl: null
        }],
        checkedCount: 0,
        elapsedMs: Date.now() - startedAt
      };
    }

    // Resolve entry file. OS8 apps scaffold with src/main.jsx; fall back to
    // src/main.js if the project uses .js extensions.
    const entryCandidates = ['src/main.jsx', 'src/main.js', 'src/main.tsx', 'src/main.ts'];
    const entryRelative = entryCandidates.find(rel => fs.existsSync(path.join(appPath, rel)));

    if (!entryRelative) {
      return {
        ok: false,
        errors: [{
          file: null, line: null, column: null,
          message: `Entry file not found. Looked for: ${entryCandidates.join(', ')}`,
          frame: null, plugin: null, id: null, requestedUrl: null
        }],
        checkedCount: 0,
        elapsedMs: Date.now() - startedAt
      };
    }

    const entryUrl = `/${appId}/${entryRelative}`;
    const seen = new Set();
    const queue = [entryUrl];
    const errors = [];
    let checkedCount = 0;

    while (queue.length > 0) {
      if (Date.now() - startedAt > MAX_WALL_MS) {
        errors.push({
          file: null, line: null, column: null,
          message: `Check exceeded wall-clock budget (${MAX_WALL_MS}ms). Partial results returned.`,
          frame: null, plugin: null, id: null, requestedUrl: null
        });
        break;
      }
      if (checkedCount >= MAX_MODULES) {
        errors.push({
          file: null, line: null, column: null,
          message: `Check exceeded module budget (${MAX_MODULES}). Partial results returned.`,
          frame: null, plugin: null, id: null, requestedUrl: null
        });
        break;
      }

      const url = queue.shift();
      if (seen.has(url)) continue;
      seen.add(url);

      let result;
      try {
        result = await viteServer.transformRequest(url);
      } catch (err) {
        errors.push(normalizeViteError(err, url));
        continue;
      }
      checkedCount++;

      if (!result) continue;

      const deps = [
        ...(result.deps || []),
        ...(result.dynamicDeps || [])
      ];
      for (const dep of deps) {
        if (shouldWalk(dep, seen)) {
          queue.push(dep);
        }
      }
    }

    return {
      ok: errors.length === 0,
      errors,
      checkedCount,
      elapsedMs: Date.now() - startedAt
    };
  }
};

module.exports = AppCheckerService;
