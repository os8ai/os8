/**
 * Linux os8:// protocol-handler registration.
 *
 * Spec §6.2.6 + plan §3 PR 1.2 (deferred Linux integration). Writes
 * ~/.local/share/applications/os8.desktop on first launch if missing
 * or stale so xdg-open knows how to dispatch os8://install deeplinks
 * to the running OS8 instance (which then forwards to the
 * single-instance lock holder via the second-instance event).
 *
 * Why a user-level .desktop file: it overrides /usr/share/applications/
 * (where the AppImage may have left a stale entry without the MimeType
 * line), and it works for both packaged AppImage installs and dev
 * users running `npm start` from source.
 *
 * No-op on macOS (open-url + setAsDefaultProtocolClient is enough) and
 * Windows (HKEY_CURRENT_USER registry written by setAsDefaultProtocolClient).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('node:child_process');

const DESKTOP_FILENAME = 'os8.desktop';

/**
 * Quote a path for an Exec= line if it contains shell metacharacters.
 * .desktop spec §Exec key reserves whitespace; quote when present.
 */
function quoteForExec(s) {
  if (!/[\s"\\$`]/.test(s)) return s;
  return `"${s.replace(/([\\"$`])/g, '\\$1')}"`;
}

/**
 * Build the Exec= command line for the running OS8 instance.
 *
 * Packaged: `${execPath} %u` — the bundled binary knows which app to load.
 * Dev:      `${execPath} ${appPath} %u` — Electron CLI receives the source
 *           root as its first arg and loads main.js from there.
 *
 * Both paths use the absolute electron binary so the .desktop file is
 * stable across PATH changes and Node version managers.
 */
function getExecCommand({ execPath, appPath, isPackaged }) {
  const exec = quoteForExec(execPath);
  if (isPackaged) return exec;
  return `${exec} ${quoteForExec(appPath)}`;
}

/**
 * Build the full .desktop file content. Idempotent — same input
 * produces byte-identical output, so re-running registerOnLinux on
 * an up-to-date file is a no-op.
 */
function buildDesktopContent({ execCommand }) {
  return [
    '[Desktop Entry]',
    'Name=OS8',
    'GenericName=OS8 Workspace',
    'Comment=Desktop workspace for AI-assisted development',
    `Exec=${execCommand} %u`,
    'Type=Application',
    'Icon=os8',
    'Terminal=false',
    'Categories=Development;',
    'MimeType=x-scheme-handler/os8;',
    'StartupWMClass=OS8',
    '',
  ].join('\n');
}

/**
 * Decide whether to rewrite the existing .desktop file.
 *
 * Rewrites when: file is missing, MimeType doesn't claim
 * x-scheme-handler/os8, or the Exec= command points at a different
 * binary than the running OS8 process. The Exec comparison strips a
 * trailing %u/%U so we don't churn on whitespace/case.
 */
function needsRewrite({ existing, expectedExec }) {
  if (!existing) return true;
  if (!/^\s*MimeType=.*x-scheme-handler\/os8/m.test(existing)) return true;
  const m = existing.match(/^\s*Exec=(.*)$/m);
  if (!m) return true;
  const actual = m[1].replace(/\s*%[uU]\s*$/, '').trim();
  return actual !== expectedExec;
}

/**
 * Register OS8 as the os8:// scheme handler on Linux. No-op on other
 * platforms. Soft-fails on filesystem or update-desktop-database errors —
 * the only consequence of failure is that os8:// deeplinks won't dispatch,
 * which is the same state the user was already in.
 *
 * @param {object} [opts]
 * @param {string} [opts.platform=process.platform]
 * @param {string} [opts.execPath=process.execPath] - Electron binary
 * @param {string} opts.appPath - app source root (from app.getAppPath())
 * @param {boolean} opts.isPackaged - app.isPackaged
 * @param {string} [opts.homeDir=os.homedir()]
 * @param {{warn?: Function, log?: Function}} [opts.logger=console]
 * @returns {Promise<{wrote?: string, skipped?: string, error?: string}>}
 */
async function registerOnLinux(opts = {}) {
  const {
    platform = process.platform,
    execPath = process.execPath,
    appPath,
    isPackaged,
    homeDir = os.homedir(),
    logger = console,
  } = opts;

  if (platform !== 'linux') return { skipped: 'not-linux' };
  if (!appPath) return { skipped: 'no-app-path' };

  const dir = path.join(homeDir, '.local', 'share', 'applications');
  const file = path.join(dir, DESKTOP_FILENAME);
  const expectedExec = getExecCommand({ execPath, appPath, isPackaged });

  let existing = null;
  try { existing = fs.readFileSync(file, 'utf8'); }
  catch (_) { /* missing — needsRewrite returns true */ }

  if (!needsRewrite({ existing, expectedExec })) {
    return { skipped: 'up-to-date' };
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, buildDesktopContent({ execCommand: expectedExec }), 'utf8');
  } catch (e) {
    logger.warn?.(`[linux-protocol] failed to write ${file}: ${e.message}`);
    return { error: e.message };
  }

  // Refresh the user-level desktop database so xdg-mime picks up the new
  // MimeType claim immediately. Missing on minimal containers; soft-fail.
  try {
    const r = spawnSync('update-desktop-database', [dir], { encoding: 'utf8', timeout: 10000 });
    if (r.error) throw r.error;
  } catch (e) {
    logger.warn?.(`[linux-protocol] update-desktop-database failed: ${e.message} (handler still registered via mimeapps.list on most setups)`);
  }

  logger.log?.(`[linux-protocol] registered os8:// handler at ${file}`);
  return { wrote: file };
}

module.exports = {
  registerOnLinux,
  buildDesktopContent,
  needsRewrite,
  getExecCommand,
  quoteForExec,
};
