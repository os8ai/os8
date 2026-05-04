/**
 * AccountService — OS8 user account management
 * Handles local identity storage and os8.ai sign-in flow.
 * Single-row design (id = 'local') — no tokens stored, just cached profile data.
 *
 * Phase 5 PR 5.1: also caches the os8.ai NextAuth session cookie so the
 * installed-apps heartbeat (PR 4.3) can authenticate against
 * /api/account/installed-apps. The cookie is opt-out per-user via
 * share_installed_apps; clearing the toggle wipes the cached value.
 */

const { shell } = require('electron');
const crypto = require('crypto');
const http = require('http');

const OS8_AI_BASE = 'https://os8.ai';

class AccountService {
  /**
   * Get the local user account, or null if not signed in.
   *
   * Phase 5 PR 5.1: also returns share_installed_apps so the renderer can
   * render the toggle. Defensive fallback for pre-0.7.0 databases (the
   * 0.7.0 migration adds the column) and for test fixtures that mirror
   * the older schema.
   */
  static getAccount(db) {
    try {
      return db.prepare(
        `SELECT os8_user_id, username, display_name, avatar_url, email,
                share_installed_apps, updated_at
           FROM user_account WHERE id = ?`
      ).get('local') || null;
    } catch (e) {
      if (/no such column: share_installed_apps/i.test(e.message)) {
        return db.prepare(
          `SELECT os8_user_id, username, display_name, avatar_url, email, updated_at
             FROM user_account WHERE id = ?`
        ).get('local') || null;
      }
      throw e;
    }
  }

  /**
   * Save/upsert account data from os8.ai.
   *
   * @param {object} db
   * @param {object} profile { os8UserId, username, displayName, avatarUrl, email }
   * @param {object} [opts]
   * @param {string|null} [opts.sessionCookie] — Cookie-header string from
   *   /api/auth/desktop/finalize (Phase 5 PR 5.1). When omitted the existing
   *   value is preserved (so re-saves of profile-only data don't clobber the
   *   cookie).
   */
  static saveAccount(db, { os8UserId, username, displayName, avatarUrl, email }, opts = {}) {
    const { sessionCookie } = opts;
    const hasCookie = sessionCookie !== undefined;

    if (hasCookie) {
      db.prepare(`
        INSERT INTO user_account (id, os8_user_id, username, display_name, avatar_url, email, session_cookie, updated_at)
        VALUES ('local', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          os8_user_id = excluded.os8_user_id,
          username = excluded.username,
          display_name = excluded.display_name,
          avatar_url = excluded.avatar_url,
          email = excluded.email,
          session_cookie = excluded.session_cookie,
          updated_at = CURRENT_TIMESTAMP
      `).run(os8UserId, username || null, displayName || null, avatarUrl || null, email, sessionCookie || null);
    } else {
      db.prepare(`
        INSERT INTO user_account (id, os8_user_id, username, display_name, avatar_url, email, updated_at)
        VALUES ('local', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          os8_user_id = excluded.os8_user_id,
          username = excluded.username,
          display_name = excluded.display_name,
          avatar_url = excluded.avatar_url,
          email = excluded.email,
          updated_at = CURRENT_TIMESTAMP
      `).run(os8UserId, username || null, displayName || null, avatarUrl || null, email);
    }
  }

  /**
   * Sign out — delete the local account row (also drops the cached cookie).
   */
  static signOut(db) {
    db.prepare('DELETE FROM user_account WHERE id = ?').run('local');
  }

  /**
   * Phase 5 PR 5.1 — read the cached os8.ai Cookie-header string for the
   * installed-apps heartbeat. Returns null when (a) no row exists,
   * (b) the cookie hasn't been seeded, or (c) the user has opted out via
   * share_installed_apps = 0. Heartbeat short-circuits on null.
   */
  static getSessionCookie(db) {
    try {
      const row = db.prepare(
        `SELECT session_cookie FROM user_account
          WHERE id = 'local' AND share_installed_apps = 1`
      ).get();
      return row?.session_cookie || null;
    } catch (e) {
      // user_account may be missing the new columns on a freshly-installed
      // 0.6.x DB before the 0.7.0 migration runs. Treat as opt-out.
      return null;
    }
  }

  /**
   * Phase 5 PR 5.1 — read the share-installed-apps preference for the
   * renderer toggle. Defaults to true (ON) when no row exists.
   */
  static getShareInstalledApps(db) {
    try {
      const row = db.prepare(
        `SELECT share_installed_apps FROM user_account WHERE id = 'local'`
      ).get();
      if (!row) return true;
      return row.share_installed_apps !== 0;
    } catch (e) {
      return true;
    }
  }

  /**
   * Phase 5 PR 5.1 — toggle the share-installed-apps preference. When set
   * to false also clears the cached cookie so the next heartbeat
   * short-circuits and the user has to re-sign-in to re-enable.
   */
  static setShareInstalledApps(db, enabled) {
    const value = enabled ? 1 : 0;
    if (enabled) {
      db.prepare(`UPDATE user_account SET share_installed_apps = 1 WHERE id = 'local'`).run();
    } else {
      db.prepare(
        `UPDATE user_account SET share_installed_apps = 0, session_cookie = NULL WHERE id = 'local'`
      ).run();
    }
    return value;
  }

  /**
   * Start the sign-in flow with PKCE.
   * 1. Generate code_verifier + code_challenge
   * 2. Spin up a temporary local HTTP server on a random port
   * 3. Open browser to os8.ai/auth/desktop?port=X&code_challenge=Y
   * 4. Wait for the callback with the auth code
   * 5. Exchange the code for user data
   * Returns a promise that resolves with the user profile or rejects on error/timeout.
   */
  static startSignIn(db) {
    return new Promise((resolve, reject) => {
      // Generate PKCE pair
      const codeVerifier = crypto.randomBytes(32).toString('base64url');
      const codeChallenge = crypto
        .createHash('sha256')
        .update(codeVerifier)
        .digest('base64url');

      // Create temporary server on random port
      const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://localhost`);
        if (url.pathname !== '/auth/callback') {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        // Phase 5 PR 5.1 — os8.ai callback page forwards the NextAuth
        // session cookie via this query param so the desktop can persist it
        // and authenticate the installed-apps heartbeat. Absent in old
        // os8.ai deployments; treat as null and the heartbeat stays dim.
        const sessionCookie = url.searchParams.get('os8_session');

        // Always close the server after handling
        server.close();
        clearTimeout(timeout);

        if (error || !code) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(AccountService._resultPage(false, error || 'No auth code received'));
          reject(new Error(error || 'No auth code received'));
          return;
        }

        try {
          const profile = await AccountService._exchangeCode(code, codeVerifier);
          AccountService.saveAccount(db, profile, { sessionCookie: sessionCookie || null });
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(AccountService._resultPage(true));
          resolve(profile);
        } catch (err) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(AccountService._resultPage(false, err.message));
          reject(err);
        }
      });

      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        const signInUrl = `${OS8_AI_BASE}/auth/desktop?port=${port}&code_challenge=${codeChallenge}`;
        console.log(`[Account] Sign-in server listening on port ${port}`);
        shell.openExternal(signInUrl);
      });

      // Timeout after 5 minutes
      const timeout = setTimeout(() => {
        server.close();
        reject(new Error('Sign-in timed out'));
      }, 5 * 60 * 1000);

      server.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /**
   * Exchange an auth code for user profile via os8.ai API
   */
  static async _exchangeCode(code, codeVerifier) {
    const res = await fetch(`${OS8_AI_BASE}/api/auth/desktop/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: codeVerifier }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Exchange failed (${res.status})`);
    }

    return res.json();
  }

  /**
   * Generate a simple result HTML page shown in the user's browser after auth
   */
  static _resultPage(success, error) {
    const title = success ? 'Signed In' : 'Sign-In Failed';
    const message = success
      ? 'You can close this tab and return to OS8.'
      : `Something went wrong: ${error || 'Unknown error'}. Please try again.`;
    const color = success ? '#22c55e' : '#ef4444';

    return `<!DOCTYPE html>
<html>
<head><title>OS8 - ${title}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0f172a; color: #e2e8f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { text-align: center; padding: 48px; }
  h1 { color: ${color}; font-size: 24px; margin-bottom: 12px; }
  p { color: #94a3b8; font-size: 16px; }
</style>
</head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body>
</html>`;
  }
}

module.exports = AccountService;
