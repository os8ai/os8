const { generateId } = require('../utils');

// OAuth Providers Configuration
const PROVIDERS = {
  google: {
    name: 'Google',
    icon: `<svg viewBox="0 0 24 24" width="20" height="20"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>`,
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
    scopes: {
      'gmail.readonly': {
        url: 'https://www.googleapis.com/auth/gmail.readonly',
        name: 'Gmail (Read)',
        description: 'Read your email messages'
      },
      'gmail.send': {
        url: 'https://www.googleapis.com/auth/gmail.send',
        name: 'Gmail (Send)',
        description: 'Send email on your behalf'
      },
      'gmail.modify': {
        url: 'https://www.googleapis.com/auth/gmail.modify',
        name: 'Gmail (Modify)',
        description: 'Move emails to trash, mark as read, add labels'
      },
      'calendar.readonly': {
        url: 'https://www.googleapis.com/auth/calendar.readonly',
        name: 'Calendar (Read)',
        description: 'View your calendar events'
      },
      'calendar.events': {
        url: 'https://www.googleapis.com/auth/calendar.events',
        name: 'Calendar (Full)',
        description: 'Create, edit, and delete calendar events'
      },
      'drive.readonly': {
        url: 'https://www.googleapis.com/auth/drive.readonly',
        name: 'Drive (Read)',
        description: 'View files in your Google Drive'
      },
      'drive.file': {
        url: 'https://www.googleapis.com/auth/drive.file',
        name: 'Drive (App Files)',
        description: 'Create folders and upload files (app-created only)'
      },
      'drive': {
        url: 'https://www.googleapis.com/auth/drive',
        name: 'Drive (Full)',
        description: 'Full access: create, edit, delete any file or folder'
      }
    },
    setupGuide: {
      title: 'Set up Google OAuth',
      steps: [
        {
          text: 'Go to Google Cloud Console: https://console.cloud.google.com/'
        },
        {
          text: 'Create a new project (or select an existing one)'
        },
        {
          text: 'Go to "APIs & Services" → "OAuth consent screen"'
        },
        {
          text: 'Configure the consent screen (External user type for personal use)'
        },
        {
          text: 'Go to "APIs & Services" → "Credentials"'
        },
        {
          text: 'Click "Create Credentials" → "OAuth client ID"'
        },
        {
          text: 'Select "Web application" as application type'
        },
        {
          text: 'Under "Authorized redirect URIs", add: http://localhost:PORT/oauth/callback (replace PORT with your OS8 port from Settings, default 8888)'
        },
        {
          text: 'Click Next below to copy the client id and client secret into OS8'
        }
      ]
    }
  }
};

// Connections Service - manages OAuth credentials, connections, and grants
const ConnectionsService = {
  // Provider Credentials
  getProviderCredentials(db, provider) {
    return db.prepare('SELECT * FROM provider_credentials WHERE provider = ?').get(provider);
  },

  getAllProviderCredentials(db) {
    return db.prepare('SELECT * FROM provider_credentials').all();
  },

  setProviderCredentials(db, provider, clientId, clientSecret) {
    const existing = this.getProviderCredentials(db, provider);
    if (existing) {
      db.prepare('UPDATE provider_credentials SET client_id = ?, client_secret = ? WHERE provider = ?')
        .run(clientId, clientSecret, provider);
      return existing.id;
    } else {
      const id = generateId();
      db.prepare('INSERT INTO provider_credentials (id, provider, client_id, client_secret) VALUES (?, ?, ?, ?)')
        .run(id, provider, clientId, clientSecret);
      return id;
    }
  },

  deleteProviderCredentials(db, provider) {
    // Also delete all connections for this provider
    const connections = db.prepare('SELECT id FROM connections WHERE provider = ?').all(provider);
    for (const conn of connections) {
      this.deleteConnection(db, conn.id);
    }
    db.prepare('DELETE FROM provider_credentials WHERE provider = ?').run(provider);
  },

  // Connections
  getAllConnections(db) {
    return db.prepare('SELECT * FROM connections ORDER BY created_at DESC').all();
  },

  getConnection(db, id) {
    return db.prepare('SELECT * FROM connections WHERE id = ?').get(id);
  },

  getConnectionsByProvider(db, provider) {
    return db.prepare('SELECT * FROM connections WHERE provider = ?').all(provider);
  },

  createConnection(db, provider, accountId, accessToken, refreshToken, expiresAt, scopes) {
    const id = generateId();
    const scopesJson = JSON.stringify(scopes || []);
    db.prepare(`
      INSERT INTO connections (id, provider, account_id, access_token, refresh_token, expires_at, scopes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, provider, accountId, accessToken, refreshToken, expiresAt, scopesJson);
    return id;
  },

  updateConnectionTokens(db, id, accessToken, refreshToken, expiresAt) {
    const updates = ['access_token = ?'];
    const values = [accessToken];

    if (refreshToken !== undefined) {
      updates.push('refresh_token = ?');
      values.push(refreshToken);
    }
    if (expiresAt !== undefined) {
      updates.push('expires_at = ?');
      values.push(expiresAt);
    }

    values.push(id);
    db.prepare(`UPDATE connections SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  },

  deleteConnection(db, id) {
    // Delete all grants for this connection first
    db.prepare('DELETE FROM connection_grants WHERE connection_id = ?').run(id);
    db.prepare('DELETE FROM connections WHERE id = ?').run(id);
  },

  // Connection Grants
  getAppGrants(db, appId) {
    return db.prepare(`
      SELECT g.*, c.provider, c.account_id
      FROM connection_grants g
      JOIN connections c ON g.connection_id = c.id
      WHERE g.app_id = ?
    `).all(appId);
  },

  getConnectionGrants(db, connectionId) {
    return db.prepare('SELECT * FROM connection_grants WHERE connection_id = ?').all(connectionId);
  },

  grantAppAccess(db, connectionId, appId, scopes) {
    const existing = db.prepare('SELECT * FROM connection_grants WHERE connection_id = ? AND app_id = ?')
      .get(connectionId, appId);

    const scopesJson = JSON.stringify(scopes || []);

    if (existing) {
      db.prepare('UPDATE connection_grants SET scopes = ? WHERE id = ?')
        .run(scopesJson, existing.id);
      return existing.id;
    } else {
      const id = generateId();
      db.prepare('INSERT INTO connection_grants (id, connection_id, app_id, scopes) VALUES (?, ?, ?, ?)')
        .run(id, connectionId, appId, scopesJson);
      return id;
    }
  },

  revokeAppAccess(db, connectionId, appId) {
    db.prepare('DELETE FROM connection_grants WHERE connection_id = ? AND app_id = ?')
      .run(connectionId, appId);
  },

  /**
   * Refresh an OAuth token using the provider's token endpoint.
   * @param {object} db
   * @param {string} connectionId
   * @returns {Promise<{success: true}|{error: string}>}
   */
  async refreshToken(db, connectionId) {
    const connection = this.getConnection(db, connectionId);
    if (!connection) return { error: 'Connection not found' };
    if (!connection.refresh_token) return { error: 'No refresh token available' };

    const providerConfig = PROVIDERS[connection.provider];
    if (!providerConfig) return { error: 'Unknown provider' };

    const credentials = this.getProviderCredentials(db, connection.provider);
    if (!credentials) return { error: 'No credentials configured for this provider' };

    try {
      const tokenResponse = await fetch(providerConfig.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: credentials.client_id,
          client_secret: credentials.client_secret,
          refresh_token: connection.refresh_token,
          grant_type: 'refresh_token'
        }).toString()
      });

      const tokenData = await tokenResponse.json();
      if (tokenData.error) {
        throw new Error(tokenData.error_description || tokenData.error);
      }

      let expiresAt = null;
      if (tokenData.expires_in) {
        expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();
      }

      this.updateConnectionTokens(
        db, connectionId,
        tokenData.access_token,
        tokenData.refresh_token, // May be undefined if provider doesn't rotate refresh tokens
        expiresAt
      );

      return { success: true };
    } catch (err) {
      console.error('Token refresh error:', err);
      return { error: err.message };
    }
  },

  // Get token for an app (checks grant and refreshes if needed)
  getTokenForApp(db, connectionId, appId) {
    const grant = db.prepare('SELECT * FROM connection_grants WHERE connection_id = ? AND app_id = ?')
      .get(connectionId, appId);

    if (!grant) {
      return { error: 'No grant found for this app' };
    }

    const connection = this.getConnection(db, connectionId);
    if (!connection) {
      return { error: 'Connection not found' };
    }

    // Check if token is expired
    if (connection.expires_at) {
      const expiresAt = new Date(connection.expires_at);
      const now = new Date();
      if (expiresAt <= now) {
        // Token is expired, will need to refresh
        return {
          needsRefresh: true,
          connection,
          grantedScopes: JSON.parse(grant.scopes || '[]')
        };
      }
    }

    return {
      accessToken: connection.access_token,
      provider: connection.provider,
      accountId: connection.account_id,
      grantedScopes: JSON.parse(grant.scopes || '[]')
    };
  }
};

module.exports = {
  PROVIDERS,
  ConnectionsService
};
