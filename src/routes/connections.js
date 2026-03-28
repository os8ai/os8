const express = require('express');

function createConnectionsRouter(db, { ConnectionsService }) {
  const router = express.Router();

  // List all connections (safe data only)
  router.get('/', (req, res) => {
    try {
      const connections = ConnectionsService.getAllConnections(db);
      res.json(connections.map(c => ({
        id: c.id,
        provider: c.provider,
        account_id: c.account_id,
        scopes: JSON.parse(c.scopes || '[]'),
        created_at: c.created_at,
        expires_at: c.expires_at,
        hasRefreshToken: !!c.refresh_token
      })));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get a valid access token (auto-refreshes if expired)
  router.get('/:id/token', async (req, res) => {
    const { id } = req.params;

    const connection = ConnectionsService.getConnection(db, id);
    if (!connection) {
      return res.status(404).json({ error: 'Connection not found' });
    }

    // Check if token is expired
    let needsRefresh = false;
    if (connection.expires_at) {
      const expiresAt = new Date(connection.expires_at);
      const now = new Date();
      // Refresh if expired or within 5 minutes of expiring
      if (expiresAt <= new Date(now.getTime() + 5 * 60 * 1000)) {
        needsRefresh = true;
      }
    }

    if (needsRefresh) {
      const refreshResult = await ConnectionsService.refreshToken(db, id);
      if (refreshResult.error) {
        return res.status(500).json({ error: `Token refresh failed: ${refreshResult.error}` });
      }

      // Re-read connection after refresh
      const updated = ConnectionsService.getConnection(db, id);
      return res.json({
        access_token: updated.access_token,
        provider: updated.provider,
        account_id: updated.account_id,
        scopes: JSON.parse(updated.scopes || '[]'),
        expires_at: updated.expires_at
      });
    }

    // Token is still valid
    res.json({
      access_token: connection.access_token,
      provider: connection.provider,
      account_id: connection.account_id,
      scopes: JSON.parse(connection.scopes || '[]'),
      expires_at: connection.expires_at
    });
  });

  return router;
}

module.exports = createConnectionsRouter;
