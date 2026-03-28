/**
 * HTTP API Routes for Timed Jobs
 * Base path: /api/jobs
 *
 * Schedule schemas:
 *   One-time: { datetime: "ISO string" }
 *   Recurring: { frequency, time?, minute?, dayOfWeek?, dayOfMonth?, month? }
 *     - hourly: { minute: 0-59 }
 *     - daily: { time: "HH:MM" }
 *     - weekdays: { time: "HH:MM" } (Mon-Fri only)
 *     - weekly: { time: "HH:MM", dayOfWeek: 0-6 } (0=Sunday)
 *     - monthly: { time: "HH:MM", dayOfMonth: 1-31 }
 *     - annually: { time: "HH:MM", dayOfMonth: 1-31, month: 1-12 }
 */

const express = require('express');
const AgentService = require('../services/agent');

function createJobsRouter(JobsFileService, JobSchedulerService = null, db = null) {
  // Resolve the parent app ID for an agent (appId param is actually agentId)
  const resolveAppId = (agentId) => {
    if (!db) return agentId; // fallback
    const agent = AgentService.getById(db, agentId);
    return agent ? agent.app_id : agentId;
  };
  const router = express.Router();
  const validRecurringFrequencies = new Set(['every-x-minutes', 'hourly', 'daily', 'weekdays', 'weekly', 'monthly', 'annually']);
  const normalizeCompletionChecks = (checks) => {
    if (!Array.isArray(checks)) return [];
    return checks
      .map(check => String(check || '').trim())
      .filter(Boolean)
      .slice(0, 20);
  };

  const triggerSchedulerRearm = () => {
    if (JobSchedulerService && JobSchedulerService.isStarted) {
      JobSchedulerService.tickDebounced();
    }
  };

  // ============================================
  // SCHEDULING HELPERS (must come before /:appId/:jobId)
  // ============================================

  // Get upcoming jobs (sorted by nextRun)
  // GET /api/jobs/:appId/upcoming
  router.get('/:appId/upcoming', (req, res) => {
    try {
      const { appId } = req.params;
      const jobs = JobsFileService.getUpcomingJobs(resolveAppId(appId), appId);
      res.json(jobs);
    } catch (err) {
      console.error('Upcoming jobs error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Get due jobs (nextRun <= now)
  // GET /api/jobs/:appId/due
  router.get('/:appId/due', (req, res) => {
    try {
      const { appId } = req.params;
      const jobs = JobsFileService.getDueJobs(resolveAppId(appId), appId);
      res.json(jobs);
    } catch (err) {
      console.error('Due jobs error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Get job stats
  // GET /api/jobs/:appId/stats
  router.get('/:appId/stats', (req, res) => {
    try {
      const { appId } = req.params;
      const stats = JobsFileService.getStats(resolveAppId(appId), appId);
      res.json(stats);
    } catch (err) {
      console.error('Job stats error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ============================================
  // JOBS CRUD
  // ============================================

  // List all jobs for an app
  // GET /api/jobs/:appId
  router.get('/:appId', (req, res) => {
    try {
      const { appId } = req.params;
      const jobs = JobsFileService.getJobs(resolveAppId(appId), appId);
      res.json(jobs);
    } catch (err) {
      console.error('Jobs list error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Create a new job
  // POST /api/jobs/:appId
  // Body: { name, description?, type, schedule, onMissed?, completionChecks? }
  //   type: "one-time" or "recurring"
  //   schedule: see schema in file header
  //   onMissed: "run" or "skip" (default: "run")
  //   completionChecks: string[] (optional, human-readable validator rules)
  router.post('/:appId', (req, res) => {
    try {
      const { appId } = req.params;
      const { name, description, type, schedule, onMissed, completionChecks } = req.body;

      if (!name) {
        return res.status(400).json({ error: 'Name is required' });
      }
      if (!type || !['one-time', 'recurring'].includes(type)) {
        return res.status(400).json({ error: 'Type must be "one-time" or "recurring"' });
      }
      if (!schedule) {
        return res.status(400).json({ error: 'Schedule is required' });
      }
      if (type === 'recurring' && !validRecurringFrequencies.has(schedule.frequency)) {
        return res.status(400).json({ error: `Unsupported recurring frequency: ${schedule.frequency}` });
      }

      if (completionChecks !== undefined && !Array.isArray(completionChecks)) {
        return res.status(400).json({ error: 'completionChecks must be an array of strings' });
      }

      const job = JobsFileService.createJob(resolveAppId(appId), appId, {
        name,
        description: description || '',
        type,
        schedule,
        onMissed: onMissed || 'run',
        completionChecks: normalizeCompletionChecks(completionChecks)
      });
      triggerSchedulerRearm();

      res.status(201).json(job);
    } catch (err) {
      console.error('Job create error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ============================================
  // RUN LOG (must come before /:appId/:jobId)
  // ============================================

  // Get runs for a job
  // GET /api/jobs/:appId/:jobId/runs?limit=50
  router.get('/:appId/:jobId/runs', (req, res) => {
    try {
      const { appId, jobId } = req.params;
      const limit = parseInt(req.query.limit) || 50;

      const runs = JobsFileService.getRuns(resolveAppId(appId), appId, jobId, limit);
      res.json(runs);
    } catch (err) {
      console.error('Job runs error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Add a run entry (for when agent executes a job)
  // POST /api/jobs/:appId/:jobId/runs
  // Body: { scheduledFor, ranAt?, status, notes? }
  // status: 'completed', 'skipped', 'failed', 'could_not_complete'
  // notes: Agent-provided description of work done or why it couldn't complete
  router.post('/:appId/:jobId/runs', (req, res) => {
    try {
      const { appId, jobId } = req.params;
      const { scheduledFor, ranAt, status, notes } = req.body;

      if (!scheduledFor) {
        return res.status(400).json({ error: 'scheduledFor is required' });
      }
      const validStatuses = ['completed', 'skipped', 'failed', 'could_not_complete'];
      if (!status || !validStatuses.includes(status)) {
        return res.status(400).json({ error: `Status must be one of: ${validStatuses.join(', ')}` });
      }

      const run = JobsFileService.addRun(resolveAppId(appId), appId, jobId, {
        scheduledFor,
        ranAt: ranAt || new Date().toISOString(),
        status,
        notes: notes || null
      });

      res.status(201).json(run);
    } catch (err) {
      console.error('Job run add error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Toggle job enabled/disabled
  // POST /api/jobs/:appId/:jobId/toggle
  router.post('/:appId/:jobId/toggle', (req, res) => {
    try {
      const { appId, jobId } = req.params;

      const job = JobsFileService.toggleJob(resolveAppId(appId), appId, jobId);
      if (!job) {
        return res.status(404).json({ error: 'Job not found' });
      }
      triggerSchedulerRearm();

      res.json(job);
    } catch (err) {
      console.error('Job toggle error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ============================================
  // SINGLE JOB OPERATIONS (must come last)
  // ============================================

  // Get a single job
  // GET /api/jobs/:appId/:jobId
  router.get('/:appId/:jobId', (req, res) => {
    try {
      const { appId, jobId } = req.params;
      const job = JobsFileService.getJob(resolveAppId(appId), appId, jobId);
      if (!job) {
        return res.status(404).json({ error: 'Job not found' });
      }
      res.json(job);
    } catch (err) {
      console.error('Job get error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Update a job
  // PATCH /api/jobs/:appId/:jobId
  // Body: { name?, description?, type?, schedule?, onMissed?, enabled?, completionChecks? }
  router.patch('/:appId/:jobId', (req, res) => {
    try {
      const { appId, jobId } = req.params;
      const updates = req.body;
      if (updates.type === 'recurring' && updates.schedule && !validRecurringFrequencies.has(updates.schedule.frequency)) {
        return res.status(400).json({ error: `Unsupported recurring frequency: ${updates.schedule.frequency}` });
      }
      if (Object.prototype.hasOwnProperty.call(updates, 'completionChecks') && !Array.isArray(updates.completionChecks)) {
        return res.status(400).json({ error: 'completionChecks must be an array of strings' });
      }
      if (Object.prototype.hasOwnProperty.call(updates, 'completionChecks')) {
        updates.completionChecks = normalizeCompletionChecks(updates.completionChecks);
      }

      const job = JobsFileService.updateJob(resolveAppId(appId), appId, jobId, updates);
      if (!job) {
        return res.status(404).json({ error: 'Job not found' });
      }
      triggerSchedulerRearm();

      res.json(job);
    } catch (err) {
      console.error('Job update error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Delete a job
  // DELETE /api/jobs/:appId/:jobId
  router.delete('/:appId/:jobId', (req, res) => {
    try {
      const { appId, jobId } = req.params;

      // Check if job exists first
      const job = JobsFileService.getJob(resolveAppId(appId), appId, jobId);
      if (!job) {
        return res.status(404).json({ error: 'Job not found' });
      }

      JobsFileService.deleteJob(resolveAppId(appId), appId, jobId);
      triggerSchedulerRearm();
      res.json({ success: true });
    } catch (err) {
      console.error('Job delete error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createJobsRouter;

module.exports.meta = {
  name: 'jobs',
  description: 'Timed job management — create, update, and track scheduled agent tasks',
  basePath: '/api/jobs',
  endpoints: [
    { method: 'GET', path: '/:appId', description: 'List all jobs' },
    { method: 'POST', path: '/:appId', description: 'Create a new job' },
    { method: 'GET', path: '/:appId/upcoming', description: 'Jobs sorted by next run time' },
    { method: 'GET', path: '/:appId/due', description: 'Jobs due for execution now' },
    { method: 'GET', path: '/:appId/stats', description: 'Job statistics' },
    { method: 'GET', path: '/:appId/:jobId', description: 'Get a single job' },
    { method: 'PATCH', path: '/:appId/:jobId', description: 'Update a job' },
    { method: 'DELETE', path: '/:appId/:jobId', description: 'Delete a job' },
    { method: 'POST', path: '/:appId/:jobId/toggle', description: 'Toggle job enabled/disabled' },
    { method: 'GET', path: '/:appId/:jobId/runs', description: 'Get run history' },
    { method: 'POST', path: '/:appId/:jobId/runs', description: 'Add a run entry (completed/failed/skipped)' }
  ]
};
