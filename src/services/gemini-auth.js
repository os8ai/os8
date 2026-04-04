/**
 * Gemini OAuth — implements the same OAuth flow as the Gemini CLI.
 * Opens browser for Google OAuth, receives callback on localhost, saves credentials
 * to ~/.gemini/oauth_creds.json (compatible with Gemini CLI's file-based storage).
 *
 * Uses the same public client ID/secret as the Gemini CLI (embedded in source per
 * Google's installed app guidelines — not a secret).
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const url = require('url');
const { shell } = require('electron');

const CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];
const CREDS_DIR = path.join(os.homedir(), '.gemini');
const CREDS_FILE = path.join(CREDS_DIR, 'oauth_creds.json');

const SUCCESS_URL = 'https://developers.google.com/gemini-code-assist/auth_success_gemini';
const FAILURE_URL = 'https://developers.google.com/gemini-code-assist/auth_failure_gemini';

/**
 * Run the Gemini OAuth flow. Opens browser, waits for callback.
 * Returns { success: true } or { success: false, error: string }.
 * Timeout: 5 minutes.
 */
async function loginWithGoogle() {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve({ success: false, error: 'Authentication timed out after 5 minutes.' });
    }, 5 * 60 * 1000);

    let server;
    const state = crypto.randomBytes(32).toString('hex');

    const cleanup = () => {
      clearTimeout(timeout);
      try { server?.close(); } catch {}
    };

    // Start localhost server for OAuth callback
    server = http.createServer(async (req, res) => {
      try {
        const parsed = new url.URL(req.url, 'http://127.0.0.1');
        if (!parsed.pathname.includes('/oauth2callback')) {
          res.writeHead(301, { Location: FAILURE_URL });
          res.end();
          return;
        }

        const error = parsed.searchParams.get('error');
        if (error) {
          res.writeHead(301, { Location: FAILURE_URL });
          res.end();
          cleanup();
          resolve({ success: false, error: `Google OAuth error: ${error}` });
          return;
        }

        const returnedState = parsed.searchParams.get('state');
        if (returnedState !== state) {
          res.writeHead(301, { Location: FAILURE_URL });
          res.end();
          cleanup();
          resolve({ success: false, error: 'OAuth state mismatch — possible CSRF.' });
          return;
        }

        const code = parsed.searchParams.get('code');
        if (!code) {
          res.writeHead(301, { Location: FAILURE_URL });
          res.end();
          cleanup();
          resolve({ success: false, error: 'No authorization code received.' });
          return;
        }

        // Exchange code for tokens
        const port = server.address().port;
        const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
        const tokenResult = await exchangeCodeForTokens(code, redirectUri);

        if (tokenResult.success) {
          res.writeHead(301, { Location: SUCCESS_URL });
          res.end();
          cleanup();
          resolve({ success: true });
        } else {
          res.writeHead(301, { Location: FAILURE_URL });
          res.end();
          cleanup();
          resolve(tokenResult);
        }
      } catch (e) {
        cleanup();
        resolve({ success: false, error: e.message });
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;

      const params = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES.join(' '),
        access_type: 'offline',
        state,
        prompt: 'consent',
      });

      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

      // Open browser for OAuth
      shell.openExternal(authUrl).catch((e) => {
        cleanup();
        resolve({ success: false, error: `Failed to open browser: ${e.message}` });
      });
    });

    server.on('error', (e) => {
      cleanup();
      resolve({ success: false, error: `Server error: ${e.message}` });
    });
  });
}

/**
 * Exchange authorization code for tokens and save to disk.
 */
async function exchangeCodeForTokens(code, redirectUri) {
  return new Promise((resolve) => {
    const body = new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }).toString();

    const req = https.request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const tokens = JSON.parse(data);
          if (tokens.error) {
            resolve({ success: false, error: `Token exchange failed: ${tokens.error_description || tokens.error}` });
            return;
          }

          // Save in the same format as Gemini CLI's file-based storage
          const creds = {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            token_type: tokens.token_type || 'Bearer',
            scope: tokens.scope,
            expiry_date: tokens.expires_in ? Date.now() + (tokens.expires_in * 1000) : undefined,
          };

          fs.mkdirSync(CREDS_DIR, { recursive: true });
          fs.writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
          resolve({ success: true });
        } catch (e) {
          resolve({ success: false, error: `Failed to parse token response: ${e.message}` });
        }
      });
    });

    req.on('error', (e) => {
      resolve({ success: false, error: `Token request failed: ${e.message}` });
    });

    req.write(body);
    req.end();
  });
}

/**
 * Check if Gemini OAuth credentials exist.
 */
function isAuthenticated() {
  return fs.existsSync(CREDS_FILE);
}

module.exports = { loginWithGoogle, isAuthenticated };
