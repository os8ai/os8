/**
 * AccountService — OS8 user account management
 * Handles local identity storage and os8.ai sign-in flow.
 * Single-row design (id = 'local') — no tokens stored, just cached profile data.
 */

const { shell } = require('electron');
const crypto = require('crypto');
const http = require('http');

const OS8_AI_BASE = 'https://os8.ai';

class AccountService {
  /**
   * Get the local user account, or null if not signed in
   */
  static getAccount(db) {
    return db.prepare('SELECT os8_user_id, username, display_name, avatar_url, email, updated_at FROM user_account WHERE id = ?').get('local') || null;
  }

  /**
   * Save/upsert account data from os8.ai
   */
  static saveAccount(db, { os8UserId, username, displayName, avatarUrl, email }) {
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

  /**
   * Sign out — delete the local account row
   */
  static signOut(db) {
    db.prepare('DELETE FROM user_account WHERE id = ?').run('local');
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
          AccountService.saveAccount(db, profile);
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
