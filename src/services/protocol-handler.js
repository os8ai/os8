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
 * PR 1.2 logs + focuses the window. PR 1.18 replaces this with a
 * `mainWindow.webContents.send('protocol:install-request', payload)` so the
 * renderer opens the install plan modal pre-populated.
 *
 * @param {string} url
 * @param {Electron.BrowserWindow|null} mainWindow
 */
function handleProtocolUrl(url, mainWindow) {
  const parsed = parseProtocolUrl(url);
  if (!parsed.ok) {
    console.warn('[protocol] rejected:', url, '—', parsed.error);
    return;
  }
  console.log('[protocol] install request:', parsed);

  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    try { mainWindow.focus(); } catch (_) { /* ignore */ }
    // PR 1.18 wires the renderer dispatch:
    try {
      mainWindow.webContents.send('protocol:install-request', {
        slug: parsed.slug,
        commit: parsed.commit,
        channel: parsed.channel,
        source: parsed.source,
      });
    } catch (_) { /* renderer may not be ready yet — payload is logged above */ }
  }
}

module.exports = { parseProtocolUrl, handleProtocolUrl };
