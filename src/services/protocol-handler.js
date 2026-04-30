/**
 * os8:// protocol handler.
 *
 * Spec §6.2.6 + plan §3 PR 1.2. Routes os8://install?slug=…&commit=…&channel=…
 * deeplinks from `app.on('open-url')` (macOS) and `app.on('second-instance')`
 * (Windows / Linux).
 *
 * The parser is pure (no Electron deps in `parseProtocolUrl`) so unit tests
 * can exercise validation without spinning up a window. PR 1.18 replaces the
 * stub log + window-focus dispatch with a real send-to-renderer call that
 * opens the install plan modal pre-populated with the slug + commit.
 */

const SLUG_RE    = /^[a-z][a-z0-9-]{1,39}$/;
const SHA_RE     = /^[0-9a-f]{40}$/;
const CHANNEL_RE = /^(verified|community|developer-import)$/;

/**
 * Parse + validate an os8:// URL.
 * @param {string} url
 * @returns {{ ok: true, action: 'install', slug, commit, channel, source }
 *          | { ok: false, error: string }}
 */
function parseProtocolUrl(url) {
  if (typeof url !== 'string' || url.length === 0) {
    return { ok: false, error: 'invalid url' };
  }
  let parsed;
  try { parsed = new URL(url); }
  catch { return { ok: false, error: 'invalid url' }; }

  if (parsed.protocol !== 'os8:') {
    return { ok: false, error: 'wrong protocol' };
  }

  // os8://install?…  Node URL's host parsing of custom schemes is quirky —
  // some platforms produce parsed.host='install', others produce
  // parsed.pathname='/install'. Accept either; reject anything else.
  const isInstall =
    parsed.host === 'install' ||
    parsed.pathname === '/install' ||
    parsed.pathname === '//install' ||
    (parsed.host === '' && parsed.pathname.includes('install'));
  if (!isInstall) {
    return { ok: false, error: 'unsupported action' };
  }

  const slug    = parsed.searchParams.get('slug');
  const commit  = parsed.searchParams.get('commit');
  const channel = parsed.searchParams.get('channel') || 'verified';
  const source  = parsed.searchParams.get('source')  || null;

  if (!slug || !SLUG_RE.test(slug))    return { ok: false, error: 'bad slug' };
  if (!commit || !SHA_RE.test(commit)) return { ok: false, error: 'bad commit' };
  if (!CHANNEL_RE.test(channel))       return { ok: false, error: 'bad channel' };

  return { ok: true, action: 'install', slug, commit, channel, source };
}

/**
 * Dispatch a parsed os8:// URL.
 *
 * PR 1.18: cross-checks the requested slug against the local catalog (lazily
 * falls through to AppCatalogService.fetchManifest when not present), refuses
 * to dispatch on a commit mismatch, and emits one of two IPC events to the
 * renderer:
 *
 *   app-store:open-install-plan  — opens the modal pre-populated
 *   app-store:protocol-error     — surfaces a user-visible dialog
 *
 * Both events go through preload.js's appStore.onProtocolEvent handler.
 *
 * Lazy require: `db` and `AppCatalogService` are passed from main.js once db
 * is initialized — `handleProtocolUrl` may fire BEFORE app.whenReady() resolves
 * (Electron buffers `open-url` events on macOS until ready). When deps aren't
 * available, fall back to the original log+focus behavior so the deeplink
 * isn't lost; main.js re-runs the dispatch after init via setProtocolDeps.
 */

let _deps = null;     // { db, AppCatalogService } — set by main.js post-init
let _pendingUrls = []; // os8:// urls that arrived before deps were ready

function setProtocolDeps(deps) {
  _deps = deps;
  // Drain anything queued before the renderer was up.
  if (_pendingUrls.length > 0) {
    const drained = _pendingUrls.slice();
    _pendingUrls = [];
    for (const { url, mainWindow } of drained) {
      handleProtocolUrl(url, mainWindow).catch(e =>
        console.warn('[protocol] drain dispatch failed:', e?.message));
    }
  }
}

async function handleProtocolUrl(url, mainWindow) {
  const parsed = parseProtocolUrl(url);
  if (!parsed.ok) {
    console.warn('[protocol] rejected:', url, '—', parsed.error);
    return;
  }
  console.log('[protocol] install request:', parsed);

  // Defensive focus — covers the case where the deeplink launched OS8 from
  // cold and the window already exists but is hidden / minimized.
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    try { mainWindow.focus(); } catch (_) { /* ignore */ }
  }

  // If main.js hasn't called setProtocolDeps yet (or window doesn't exist),
  // queue the URL for re-dispatch and return.
  if (!_deps || !mainWindow || mainWindow.isDestroyed()) {
    _pendingUrls.push({ url, mainWindow });
    return;
  }

  const { db, AppCatalogService } = _deps;
  let entry = null;
  try {
    entry = await AppCatalogService.get(db, parsed.slug, { channel: parsed.channel });
  } catch (_) { /* fall through to fetchManifest */ }

  if (!entry) {
    try {
      const fetched = await AppCatalogService.fetchManifest(parsed.slug, parsed.channel);
      // fetchManifest returns the listing shape; promote to entry-ish.
      entry = {
        slug: fetched.slug,
        upstreamResolvedCommit: fetched.upstreamResolvedCommit,
        manifest: fetched.manifestYaml,
      };
    } catch (e) {
      sendProtocolError(mainWindow, {
        slug: parsed.slug,
        error: `Couldn't load ${parsed.slug} from os8.ai: ${e.message}`,
      });
      return;
    }
  }

  // Defense against stale deeplink: refuse if the catalog has moved on.
  if (entry.upstreamResolvedCommit && entry.upstreamResolvedCommit !== parsed.commit) {
    sendProtocolError(mainWindow, {
      slug: parsed.slug,
      error:
        `Commit mismatch — deeplink wants ${parsed.commit.slice(0, 8)} ` +
        `but catalog has ${entry.upstreamResolvedCommit.slice(0, 8)}. ` +
        `The app may have been updated since the link was generated. ` +
        `Click Install on os8.ai again.`,
    });
    return;
  }

  try {
    mainWindow.webContents.send('app-store:open-install-plan', {
      slug: parsed.slug,
      commit: parsed.commit,
      channel: parsed.channel,
      source: parsed.source || 'os8.ai',
    });
  } catch (_) { /* renderer not ready — already focused, user sees the deeplink */ }
}

function sendProtocolError(mainWindow, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send('app-store:protocol-error', payload);
  } catch (_) { /* renderer may be in transition */ }
}

module.exports = { parseProtocolUrl, handleProtocolUrl, setProtocolDeps };
