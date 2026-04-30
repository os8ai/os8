/**
 * /api/app-store/* — install pipeline HTTP API.
 *
 * Spec §6.5 + plan §3 PR 1.5. Route shape:
 *
 *   POST /api/app-store/install               Body: { slug, commit, channel, secrets?, source? }
 *                                             Returns 202 { jobId, status }
 *   GET  /api/app-store/jobs/:id              Returns the job row (review_report parsed)
 *   POST /api/app-store/jobs/:id/cancel       Returns 200 { success: true }
 *   POST /api/app-store/jobs/:id/approve      PR 1.16 wires; PR 1.5 returns 501
 *   GET  /api/app-store/jobs/:id/log          SSE stream of {kind, ...} events
 */

const express = require('express');
const AppInstaller = require('../services/app-installer');
const InstallJobs = require('../services/app-install-jobs');

function jobToJson(job) {
  if (!job) return null;
  let reviewReport = null;
  if (job.review_report) {
    try { reviewReport = JSON.parse(job.review_report); }
    catch (_) { reviewReport = { parseError: true, raw: job.review_report }; }
  }
  return {
    id: job.id,
    appId: job.app_id,
    externalSlug: job.external_slug,
    upstreamResolvedCommit: job.upstream_resolved_commit,
    channel: job.channel,
    status: job.status,
    stagingDir: job.staging_dir,
    reviewReport,
    errorMessage: job.error_message,
    logPath: job.log_path,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  };
}

function createAppStoreRouter(db) {
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));

  router.post('/install', async (req, res) => {
    try {
      const { slug, commit, channel = 'verified', secrets = {}, source = 'manual' } = req.body || {};
      if (!slug || typeof slug !== 'string') {
        return res.status(400).json({ error: 'slug required' });
      }
      if (!commit || !/^[0-9a-f]{40}$/.test(commit)) {
        return res.status(400).json({ error: 'commit must be a 40-char hex SHA' });
      }
      const job = await AppInstaller.start(db, { slug, commit, channel, secrets, source });
      res.status(202).json({ jobId: job.id, status: job.status });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/jobs/:id', (req, res) => {
    const job = InstallJobs.get(db, req.params.id);
    if (!job) return res.status(404).json({ error: 'job not found' });
    res.json(jobToJson(job));
  });

  router.post('/jobs/:id/cancel', (req, res) => {
    try {
      const job = AppInstaller.cancel(db, req.params.id);
      res.json(jobToJson(job));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // PR 1.16 wires the post-approval install pipeline. PR 1.5 ships a 501 so
  // the route exists at the right path without faking success.
  router.post('/jobs/:id/approve', (_req, res) => {
    res.status(501).json({ error: 'approve hook arrives in PR 1.16' });
  });

  // SSE log stream. Subscribes to AppInstaller events for this jobId and
  // forwards them to the client. Closing the connection unsubscribes.
  router.get('/jobs/:id/log', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const jobId = req.params.id;
    const initial = InstallJobs.get(db, jobId);
    res.write(`data: ${JSON.stringify({ kind: 'hello', jobId, job: jobToJson(initial) })}\n\n`);

    const unsubscribe = AppInstaller.subscribe(jobId, (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    // Keep-alive so proxies don't drop the connection (matches the existing
    // SSE pattern in src/routes/agent-chat.js).
    const heartbeat = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch (_) { /* socket closed */ }
    }, 30_000);
    heartbeat.unref?.();

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  return router;
}

module.exports = createAppStoreRouter;
