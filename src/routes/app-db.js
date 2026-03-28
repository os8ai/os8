/**
 * Per-app database routes.
 * Provides REST API for apps to interact with their own SQLite database.
 */

const express = require('express');

function createAppDbRouter(db, { AppService, AppDbService }) {
  const router = express.Router({ mergeParams: true });

  // Middleware: validate appId exists in the apps table
  router.use((req, res, next) => {
    const { appId } = req.params;
    if (!appId) return res.status(400).json({ error: 'appId is required' });

    const app = AppService.getById(db, appId);
    if (!app) return res.status(404).json({ error: 'App not found' });

    req.appRecord = app;
    next();
  });

  // POST /query — SELECT queries only
  router.post('/query', express.json(), (req, res) => {
    try {
      const { sql, params = [] } = req.body;
      if (!sql) return res.status(400).json({ error: 'sql is required' });

      const result = AppDbService.query(req.params.appId, sql, params);
      res.json(result);
    } catch (err) {
      const status = err.message.includes('not allowed') || err.message.includes('Only SELECT') ? 400 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  // POST /execute — write/DDL statements
  router.post('/execute', express.json(), (req, res) => {
    try {
      const { sql, params = [] } = req.body;
      if (!sql) return res.status(400).json({ error: 'sql is required' });

      const result = AppDbService.execute(req.params.appId, sql, params);
      res.json(result);
    } catch (err) {
      const status = err.message.includes('not allowed') || err.message.includes('Only write') ? 400 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  // POST /batch — multiple statements in a transaction
  router.post('/batch', express.json(), (req, res) => {
    try {
      const { statements } = req.body;
      if (!statements) return res.status(400).json({ error: 'statements array is required' });

      const result = AppDbService.batch(req.params.appId, statements);
      res.json(result);
    } catch (err) {
      const status = err.message.includes('not allowed') ? 400 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  // GET /schema — list all tables with columns
  router.get('/schema', (req, res) => {
    try {
      const result = AppDbService.getSchema(req.params.appId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /schema/:table — describe a single table
  router.get('/schema/:table', (req, res) => {
    try {
      const result = AppDbService.getTableSchema(req.params.appId, req.params.table);
      if (!result) return res.status(404).json({ error: 'Table not found' });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createAppDbRouter;

module.exports.meta = {
  name: 'app-db',
  description: 'Per-app SQLite database for structured data persistence. Each app gets its own database file, created on first use.',
  basePath: '/api/apps/:appId/db',
  endpoints: [
    { method: 'POST', path: '/query', description: 'Execute SELECT query (parameterized)' },
    { method: 'POST', path: '/execute', description: 'Execute write/DDL statement (INSERT, UPDATE, DELETE, CREATE TABLE, etc.)' },
    { method: 'POST', path: '/batch', description: 'Execute multiple statements in a transaction' },
    { method: 'GET', path: '/schema', description: 'List all tables with column info' },
    { method: 'GET', path: '/schema/:table', description: 'Describe a single table' }
  ]
};
