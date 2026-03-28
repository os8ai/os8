/**
 * IPC Handlers for Connections (OAuth) domain
 * Handles: connections:*
 */

const { ipcMain, shell } = require('electron');

function registerConnectionsHandlers({ db, services, helpers }) {
  const { ConnectionsService, PROVIDERS } = services;
  const { getPort } = helpers;

  // Get providers config
  ipcMain.handle('connections:get-providers', () => PROVIDERS);

  // Provider credentials
  ipcMain.handle('connections:get-provider-credentials', (event, provider) => {
    return ConnectionsService.getProviderCredentials(db, provider);
  });

  ipcMain.handle('connections:set-provider-credentials', (event, provider, clientId, clientSecret) => {
    return ConnectionsService.setProviderCredentials(db, provider, clientId, clientSecret);
  });

  ipcMain.handle('connections:delete-provider-credentials', (event, provider) => {
    return ConnectionsService.deleteProviderCredentials(db, provider);
  });

  // Connections
  ipcMain.handle('connections:list', () => {
    const connections = ConnectionsService.getAllConnections(db);
    // Don't send tokens to renderer
    return connections.map(c => ({
      id: c.id,
      provider: c.provider,
      account_id: c.account_id,
      scopes: JSON.parse(c.scopes || '[]'),
      created_at: c.created_at,
      hasRefreshToken: !!c.refresh_token
    }));
  });

  ipcMain.handle('connections:get', (event, id) => {
    const conn = ConnectionsService.getConnection(db, id);
    if (conn) {
      return {
        id: conn.id,
        provider: conn.provider,
        account_id: conn.account_id,
        scopes: JSON.parse(conn.scopes || '[]'),
        created_at: conn.created_at,
        hasRefreshToken: !!conn.refresh_token
      };
    }
    return null;
  });

  ipcMain.handle('connections:delete', (event, id) => {
    return ConnectionsService.deleteConnection(db, id);
  });

  // OAuth flow - opens browser, callback handled by main Express server (src/server.js)
  ipcMain.handle('connections:start-oauth', async (event, provider, scopes) => {
    const providerConfig = PROVIDERS[provider];
    if (!providerConfig) {
      return { error: 'Unknown provider' };
    }

    const credentials = ConnectionsService.getProviderCredentials(db, provider);
    if (!credentials) {
      return { error: 'No credentials configured for this provider' };
    }

    // Use OS8 server port (OAuth callback is handled by the same server)
    const os8Port = getPort();
    const redirectUri = `http://localhost:${os8Port}/oauth/callback`;

    // Convert friendly scope names to actual scope URLs
    const scopeUrls = scopes.map(s => providerConfig.scopes[s]?.url || s);
    // Always include email scope for Google to get account ID
    if (provider === 'google' && !scopeUrls.includes('email')) {
      scopeUrls.push('email');
    }

    // Build state parameter with provider and scopes (for callback to use)
    const state = Buffer.from(JSON.stringify({ provider, scopes })).toString('base64');

    // Build authorization URL
    const authParams = new URLSearchParams({
      client_id: credentials.client_id,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scopeUrls.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state: state
    });

    const authUrl = `${providerConfig.authUrl}?${authParams.toString()}`;

    // Open browser - callback will be handled by Express server
    shell.openExternal(authUrl);

    return { success: true, message: 'Authorization started - complete in browser' };
  });

  // Refresh token
  ipcMain.handle('connections:refresh-token', async (event, connectionId) => {
    return ConnectionsService.refreshToken(db, connectionId);
  });

  // App grants
  ipcMain.handle('connections:get-app-grants', (event, appId) => {
    return ConnectionsService.getAppGrants(db, appId);
  });

  ipcMain.handle('connections:grant-app', (event, connectionId, appId, scopes) => {
    return ConnectionsService.grantAppAccess(db, connectionId, appId, scopes);
  });

  ipcMain.handle('connections:revoke-app', (event, connectionId, appId) => {
    return ConnectionsService.revokeAppAccess(db, connectionId, appId);
  });

  // Get token for an app (auto-refresh if needed)
  ipcMain.handle('connections:get-token', async (event, connectionId, appId) => {
    const result = ConnectionsService.getTokenForApp(db, connectionId, appId);

    if (result.error) {
      return result;
    }

    if (result.needsRefresh) {
      // Try to refresh the token
      const refreshResult = await ConnectionsService.refreshToken(db, connectionId);
      if (refreshResult.error) {
        return { error: `Token refresh failed: ${refreshResult.error}` };
      }
      // Get the updated token
      return ConnectionsService.getTokenForApp(db, connectionId, appId);
    }

    return result;
  });
}

module.exports = registerConnectionsHandlers;
