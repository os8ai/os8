/**
 * Agent-scoped Timed Jobs API
 *
 * Gives agents the ability to create, list, update, and delete their own timed jobs.
 * Delegates to JobsFileService for persistence and JobSchedulerService for scheduling.
 *
 * Base path: /api/agent/:agentId/jobs
 */

const express = require('express');
const AgentService = require('../services/agent');

const VALID_RECURRING_FREQUENCIES = new Set([
  'every-x-minutes', 'every-x-hours', 'hourly', 'daily',
  'weekdays', 'weekly', 'monthly', 'annually'
]);

function createAgentJobsRouter(db, { JobsFileService, JobSchedulerService }) {

  const router = express.Router({ mergeParams: true });

  // ── Middleware: resolve agent and set appId ──

  router.use((req, res, next) => {
    const agentId = req.params.agentId || req.agentId;
    if (!agentId) {
      return res.status(400).json({
        error: { code: 'MISSING_AGENT_ID', message: 'agentId is required in the URL path.' }
      });
    }

    const agent = AgentService.getById(db, agentId);
    if (!agent) {
      return res.status(404).json({
        error: { code: 'AGENT_NOT_FOUND', message: `No agent found with ID "${agentId}".` }
      });
    }

    req.agent = agent;
    req.resolvedAppId = agent.app_id;
    req.resolvedAgentId = agentId;
    next();
  });

  const triggerSchedulerRearm = () => {
    if (JobSchedulerService && JobSchedulerService.isStarted) {
      JobSchedulerService.tickDebounced();
    }
  };

  // ── Validation helpers ──

  function validateSchedule(type, schedule) {
    if (!schedule) {
      return { code: 'MISSING_REQUIRED_FIELD', message: 'schedule is required.', field: 'schedule' };
    }

    if (type === 'one-time') {
      if (!schedule.datetime) {
        return { code: 'INVALID_SCHEDULE', message: 'schedule.datetime is required for one-time jobs. Use ISO 8601 format (e.g. "2026-04-01T09:00:00.000Z").', field: 'schedule.datetime' };
      }
      const d = new Date(schedule.datetime);
      if (isNaN(d.getTime())) {
        return { code: 'INVALID_SCHEDULE', message: `schedule.datetime "${schedule.datetime}" is not a valid date. Use ISO 8601 format.`, field: 'schedule.datetime' };
      }
      return null;
    }

    // Recurring
    if (!schedule.frequency) {
      return { code: 'MISSING_REQUIRED_FIELD', message: 'schedule.frequency is required for recurring jobs.', field: 'schedule.frequency' };
    }
    if (!VALID_RECURRING_FREQUENCIES.has(schedule.frequency)) {
      return {
        code: 'INVALID_SCHEDULE',
        message: `Unsupported frequency "${schedule.frequency}". Valid options: ${[...VALID_RECURRING_FREQUENCIES].join(', ')}.`,
        field: 'schedule.frequency'
      };
    }

    // Frequency-specific validation
    const freq = schedule.frequency;
    if (['daily', 'weekdays', 'weekly', 'monthly', 'annually'].includes(freq) && !schedule.time) {
      return { code: 'INVALID_SCHEDULE', message: `schedule.time is required for "${freq}" jobs. Use HH:MM 24-hour format (e.g. "09:00").`, field: 'schedule.time' };
    }
    if (schedule.time && !/^\d{2}:\d{2}$/.test(schedule.time)) {
      return { code: 'INVALID_SCHEDULE', message: `schedule.time "${schedule.time}" must be in HH:MM 24-hour format (e.g. "09:00", "14:30").`, field: 'schedule.time' };
    }
    if (freq === 'weekly' && schedule.dayOfWeek === undefined) {
      return { code: 'INVALID_SCHEDULE', message: 'schedule.dayOfWeek is required for weekly jobs. Use 0=Sunday, 1=Monday, ..., 6=Saturday.', field: 'schedule.dayOfWeek' };
    }
    if (freq === 'monthly' && schedule.dayOfMonth === undefined) {
      return { code: 'INVALID_SCHEDULE', message: 'schedule.dayOfMonth is required for monthly jobs. Use 1-31.', field: 'schedule.dayOfMonth' };
    }
    if (freq === 'annually') {
      if (schedule.month === undefined) {
        return { code: 'INVALID_SCHEDULE', message: 'schedule.month is required for annually jobs. Use 1-12.', field: 'schedule.month' };
      }
      if (schedule.dayOfMonth === undefined) {
        return { code: 'INVALID_SCHEDULE', message: 'schedule.dayOfMonth is required for annually jobs. Use 1-31.', field: 'schedule.dayOfMonth' };
      }
    }
    if (freq === 'every-x-minutes') {
      const interval = schedule.interval;
      if (!interval || interval < 15) {
        return { code: 'INVALID_SCHEDULE', message: 'schedule.interval is required for every-x-minutes jobs. Minimum: 15.', field: 'schedule.interval' };
      }
    }
    if (freq === 'every-x-hours' && (!schedule.interval || schedule.interval < 1)) {
      return { code: 'INVALID_SCHEDULE', message: 'schedule.interval is required for every-x-hours jobs. Minimum: 1.', field: 'schedule.interval' };
    }

    return null;
  }

  // ── Routes ──

  /**
   * GET /api/agent/:agentId/jobs
   * List all jobs for this agent.
   */
  router.get('/', (req, res) => {
    try {
      const jobs = JobsFileService.getJobs(req.resolvedAppId, req.resolvedAgentId);
      res.json(jobs.filter(j => !j.archived));
    } catch (err) {
      console.error('[agent-jobs] List error:', err);
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
    }
  });

  /**
   * POST /api/agent/:agentId/jobs
   * Create a new timed job for this agent.
   */
  router.post('/', (req, res) => {
    try {
      const { name, description, type, schedule, onMissed, completionChecks, skill, skillScope, skillPath } = req.body;

      // Required field validation
      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({
          error: { code: 'MISSING_REQUIRED_FIELD', message: 'name is required and must be a non-empty string.', field: 'name' }
        });
      }

      const jobType = type || 'recurring';
      if (!['one-time', 'recurring'].includes(jobType)) {
        return res.status(400).json({
          error: { code: 'INVALID_TYPE', message: 'type must be "one-time" or "recurring". Defaults to "recurring" if omitted.', field: 'type' }
        });
      }

      const scheduleError = validateSchedule(jobType, schedule);
      if (scheduleError) {
        return res.status(400).json({ error: scheduleError });
      }

      if (completionChecks !== undefined && !Array.isArray(completionChecks)) {
        return res.status(400).json({
          error: { code: 'INVALID_FIELD', message: 'completionChecks must be an array of strings.', field: 'completionChecks' }
        });
      }

      // Duplicate name check
      const existing = JobsFileService.getJobs(req.resolvedAppId, req.resolvedAgentId);
      const duplicate = existing.find(j => !j.archived && j.name.toLowerCase() === name.trim().toLowerCase());
      if (duplicate) {
        return res.status(409).json({
          error: {
            code: 'DUPLICATE_JOB_NAME',
            message: `A job named "${name.trim()}" already exists for this agent (ID: ${duplicate.id}). Use a unique name or update the existing job.`,
            field: 'name',
            existingJobId: duplicate.id
          }
        });
      }

      const job = JobsFileService.createJob(req.resolvedAppId, req.resolvedAgentId, {
        name: name.trim(),
        description: description || '',
        type: jobType,
        schedule,
        onMissed: onMissed || 'run',
        completionChecks: completionChecks || [],
        skill: skill || null,
        skillScope: skillScope || null,
        skillPath: skillPath || null
      });
      triggerSchedulerRearm();

      res.status(201).json(job);
    } catch (err) {
      console.error('[agent-jobs] Create error:', err);
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
    }
  });

  /**
   * GET /api/agent/:agentId/jobs/:jobId
   * Get a single job by ID.
   */
  router.get('/:jobId', (req, res) => {
    try {
      const job = JobsFileService.getJob(req.resolvedAppId, req.resolvedAgentId, req.params.jobId);
      if (!job) {
        return res.status(404).json({
          error: { code: 'JOB_NOT_FOUND', message: `No job found with ID "${req.params.jobId}".` }
        });
      }
      res.json(job);
    } catch (err) {
      console.error('[agent-jobs] Get error:', err);
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
    }
  });

  /**
   * PATCH /api/agent/:agentId/jobs/:jobId
   * Update a job's name, description, schedule, enabled state, etc.
   */
  router.patch('/:jobId', (req, res) => {
    try {
      const { jobId } = req.params;
      const updates = req.body;

      const existing = JobsFileService.getJob(req.resolvedAppId, req.resolvedAgentId, jobId);
      if (!existing) {
        return res.status(404).json({
          error: { code: 'JOB_NOT_FOUND', message: `No job found with ID "${jobId}".` }
        });
      }

      // Validate schedule if being updated
      if (updates.schedule || updates.type) {
        const effectiveType = updates.type || existing.type;
        const effectiveSchedule = updates.schedule || existing.schedule;
        const scheduleError = validateSchedule(effectiveType, effectiveSchedule);
        if (scheduleError) {
          return res.status(400).json({ error: scheduleError });
        }
      }

      if (updates.type && !['one-time', 'recurring'].includes(updates.type)) {
        return res.status(400).json({
          error: { code: 'INVALID_TYPE', message: 'type must be "one-time" or "recurring".', field: 'type' }
        });
      }

      if (Object.prototype.hasOwnProperty.call(updates, 'completionChecks') && !Array.isArray(updates.completionChecks)) {
        return res.status(400).json({
          error: { code: 'INVALID_FIELD', message: 'completionChecks must be an array of strings.', field: 'completionChecks' }
        });
      }

      // Duplicate name check on rename
      if (updates.name && updates.name.trim().toLowerCase() !== existing.name.toLowerCase()) {
        const allJobs = JobsFileService.getJobs(req.resolvedAppId, req.resolvedAgentId);
        const duplicate = allJobs.find(j => !j.archived && j.id !== jobId && j.name.toLowerCase() === updates.name.trim().toLowerCase());
        if (duplicate) {
          return res.status(409).json({
            error: {
              code: 'DUPLICATE_JOB_NAME',
              message: `A job named "${updates.name.trim()}" already exists (ID: ${duplicate.id}).`,
              field: 'name',
              existingJobId: duplicate.id
            }
          });
        }
      }

      const job = JobsFileService.updateJob(req.resolvedAppId, req.resolvedAgentId, jobId, updates);
      triggerSchedulerRearm();

      res.json(job);
    } catch (err) {
      console.error('[agent-jobs] Update error:', err);
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
    }
  });

  /**
   * DELETE /api/agent/:agentId/jobs/:jobId
   * Delete a job permanently.
   */
  router.delete('/:jobId', (req, res) => {
    try {
      const { jobId } = req.params;
      const job = JobsFileService.getJob(req.resolvedAppId, req.resolvedAgentId, jobId);
      if (!job) {
        return res.status(404).json({
          error: { code: 'JOB_NOT_FOUND', message: `No job found with ID "${jobId}".` }
        });
      }

      JobsFileService.deleteJob(req.resolvedAppId, req.resolvedAgentId, jobId);
      triggerSchedulerRearm();

      res.json({ success: true, deleted: jobId });
    } catch (err) {
      console.error('[agent-jobs] Delete error:', err);
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
    }
  });

  /**
   * POST /api/agent/:agentId/jobs/:jobId/toggle
   * Toggle a job's enabled/disabled state.
   */
  router.post('/:jobId/toggle', (req, res) => {
    try {
      const job = JobsFileService.toggleJob(req.resolvedAppId, req.resolvedAgentId, req.params.jobId);
      if (!job) {
        return res.status(404).json({
          error: { code: 'JOB_NOT_FOUND', message: `No job found with ID "${req.params.jobId}".` }
        });
      }
      triggerSchedulerRearm();
      res.json(job);
    } catch (err) {
      console.error('[agent-jobs] Toggle error:', err);
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
    }
  });

  return router;
}

module.exports = createAgentJobsRouter;

// ── Capability registration ──
// Rich embedded documentation so agents can use this API without external references.

module.exports.meta = {
  name: 'agent-jobs',
  description: `Agent timed jobs — create, manage, and delete your own scheduled tasks.

Use this API to schedule tasks that run automatically on a recurring basis — daily check-ins, weekly reviews, periodic builds, interval-based monitoring. Jobs are executed by the OS8 job scheduler; when your job fires, you receive the job description as a prompt and must complete the task.

**Creating a job:** POST to /api/agent/{your-agent-id}/jobs with a name, description (what to do when the job runs), and schedule. The description is the prompt you'll receive when the job executes — write it as a clear instruction to yourself.

**Tying a job to a skill:** If the job should follow a specific skill workflow, include the "skill" field with the skill name (e.g. "app-builder", "motivations-update"). The skill's SKILL.md instructions will be loaded into your context when the job runs. You can also set "skillScope" and "skillPath" for skills that need scoped file access. If no skill is specified, the job runs with your standard tools and the description as your only instruction.

**Schedule formats:**
- daily: { "frequency": "daily", "time": "09:00" } — runs every day at 9 AM
- weekdays: { "frequency": "weekdays", "time": "09:00" } — Mon-Fri only
- weekly: { "frequency": "weekly", "time": "19:00", "dayOfWeek": 2 } — every Tuesday at 7 PM (0=Sun, 1=Mon, ..., 6=Sat)
- hourly: { "frequency": "hourly", "minute": 30 } — every hour at :30
- monthly: { "frequency": "monthly", "time": "09:00", "dayOfMonth": 1 } — 1st of each month
- annually: { "frequency": "annually", "time": "09:00", "dayOfMonth": 15, "month": 3 } — March 15 each year
- every-x-minutes: { "frequency": "every-x-minutes", "interval": 30 } — every 30 minutes (minimum 15)
- every-x-hours: { "frequency": "every-x-hours", "interval": 4 } — every 4 hours
- one-time: set type to "one-time" with schedule { "datetime": "2026-04-01T09:00:00Z" }

**Example — create a daily review job:**
curl -X POST http://localhost:8888/api/agent/{agentId}/jobs -H "Content-Type: application/json" -d '{"name": "Daily Review", "description": "Review yesterday'\''s conversations, extract key decisions, and update USER.md with any new preferences or corrections.", "type": "recurring", "schedule": {"frequency": "daily", "time": "08:00"}}'

**Example — create a skill-backed job:**
curl -X POST http://localhost:8888/api/agent/{agentId}/jobs -H "Content-Type: application/json" -d '{"name": "Weekly App Enhancement", "description": "Inspect and improve the main app UI", "skill": "app-enhancer", "type": "recurring", "schedule": {"frequency": "weekly", "time": "10:00", "dayOfWeek": 1}}'

**Missed job behavior ("onMissed"):** If OS8 was offline when a job was due, what should happen when it comes back? Set "onMissed" to "run" (default) to execute the late job immediately, or "skip" to skip it and wait for the next scheduled occurrence. Use "skip" for time-sensitive jobs where running late would be pointless (e.g. a "good morning" message at 3 PM).

**Completion checks ("completionChecks"):** An array of validation rules that the scheduler verifies after your job runs. If any check fails, the job is marked failed even if you reported JOB_COMPLETE. Two check types:
- "Exists: path/to/file" — verifies the file or folder exists after the job runs
- "Recent File: path/to/file" — verifies the file was modified during or after the job run
Paths are relative to your agent directory. Prefix with "blob/" for blob storage paths (e.g. "blob/reports/daily.md"). Use these to define machine-verifiable success criteria. Example: ["Exists: blob/weekly-report.md", "Recent File: USER.md"]

**Job names must be unique** per agent. Duplicate names return 409 with the existing job's ID.

**When your job runs:** You receive the description as a prompt. You must end your response with one of:
- [JOB_COMPLETE: 2-3 sentences describing what you accomplished]
- [JOB_COULD_NOT_COMPLETE: brief explanation of what went wrong]

**Error codes:** MISSING_REQUIRED_FIELD, INVALID_SCHEDULE, INVALID_TYPE, DUPLICATE_JOB_NAME, JOB_NOT_FOUND, AGENT_NOT_FOUND.`,
  basePath: '/api/agent/:agentId/jobs',
  endpoints: [
    { method: 'GET', path: '/', description: 'List all active jobs for this agent' },
    { method: 'POST', path: '/', description: 'Create a new timed job' },
    { method: 'GET', path: '/:jobId', description: 'Get a single job by ID' },
    { method: 'PATCH', path: '/:jobId', description: 'Update a job (name, description, schedule, enabled)' },
    { method: 'DELETE', path: '/:jobId', description: 'Delete a job permanently' },
    { method: 'POST', path: '/:jobId/toggle', description: 'Toggle job enabled/disabled' }
  ]
};
