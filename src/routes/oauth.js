const express = require('express');

function createOAuthRouter(db, { ConnectionsService, PROVIDERS, pages, getPort, getOAuthCompleteCallback }) {
  const router = express.Router();

  router.get('/callback', async (req, res) => {
    const { code, error, state } = req.query;

    // Error from provider
    if (error) {
      return res.send(pages.oauthResult('error', 'Authorization Failed', error));
    }

    if (!code) {
      return res.send(pages.oauthResult('error', 'No Authorization Code', 'No code was received from the provider.'));
    }

    // Parse state (contains provider and scopes)
    let provider, scopes;
    try {
      const stateData = JSON.parse(Buffer.from(state, 'base64').toString('utf-8'));
      provider = stateData.provider;
      scopes = stateData.scopes;
    } catch (e) {
      return res.send(pages.oauthResult('error', 'Invalid State', 'Could not parse OAuth state parameter.'));
    }

    const providerConfig = PROVIDERS[provider];
    if (!providerConfig) {
      return res.send(pages.oauthResult('error', 'Unknown Provider', `Provider "${provider}" is not supported.`));
    }

    const credentials = ConnectionsService.getProviderCredentials(db, provider);
    if (!credentials) {
      return res.send(pages.oauthResult('error', 'No Credentials', 'No OAuth credentials found for this provider.'));
    }

    const currentPort = getPort();
    const redirectUri = `http://localhost:${currentPort}/oauth/callback`;

    try {
      // Exchange code for tokens
      const tokenResponse = await fetch(providerConfig.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: credentials.client_id,
          client_secret: credentials.client_secret,
          code: code,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri
        }).toString()
      });

      const tokenData = await tokenResponse.json();

      if (tokenData.error) {
        throw new Error(tokenData.error_description || tokenData.error);
      }

      // Get user info (email)
      let accountId = null;
      if (providerConfig.userInfoUrl) {
        const userInfoResponse = await fetch(providerConfig.userInfoUrl, {
          headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
        });
        const userInfo = await userInfoResponse.json();
        accountId = userInfo.email || userInfo.id;
      }

      // Calculate expiration time
      let expiresAt = null;
      if (tokenData.expires_in) {
        expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();
      }

      // Save connection
      const connectionId = ConnectionsService.createConnection(
        db,
        provider,
        accountId,
        tokenData.access_token,
        tokenData.refresh_token,
        expiresAt,
        scopes
      );

      // Emit event for main process to notify renderer
      const oauthCompleteCallback = getOAuthCompleteCallback();
      if (oauthCompleteCallback) {
        oauthCompleteCallback({ connectionId, provider, accountId });
      }

      res.send(pages.oauthResult('success', 'Connected Successfully!', accountId || 'Account connected'));
    } catch (err) {
      console.error('OAuth token exchange error:', err);
      res.send(pages.oauthResult('error', 'Connection Failed', err.message));
    }
  });

  return router;
}

module.exports = createOAuthRouter;
