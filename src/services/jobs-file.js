const fs = require('fs');
const path = require('path');
const { Mutex } = require('async-mutex');
const { generateId } = require('../utils');
const { getSystemTime } = require('../routes/system');
const AgentService = require('./agent');
const { APPS_DIR } = require('../config');

// Mutex for atomic file operations (claim, markRunning, etc.)
const fileMutex = new Mutex();

// Lease window for claims (15 minutes)
// Must be longer than the longest expected execution timeout.
const LEASE_WINDOW_MS = 15 * 60 * 1000;

// Jobs File Service - JSON-based timed job management per app
const JobsFileService = {
  // Get the jobs.json path for an app/agent
  getJobsPath(appId, agentId) {
    if (agentId) {
      const { agentDir } = AgentService.getPaths(appId, agentId);
      return path.join(agentDir, 'jobs.json');
    }
    // Standard app: jobs.json at app root
    return path.join(APPS_DIR, appId, 'jobs.json');
  },

  // Read jobs.json for an app
  read(appId, agentId) {
    const jobsPath = this.getJobsPath(appId, agentId);
    if (!fs.existsSync(jobsPath)) {
      const defaultData = { jobs: [], runs: [] };
      fs.writeFileSync(jobsPath, JSON.stringify(defaultData, null, 2));
      return defaultData;
    }
    try {
      let content = fs.readFileSync(jobsPath, 'utf-8');
      // Remove trailing commas (common AI mistake) before parsing
      content = content.replace(/,(\s*[}\]])/g, '$1');
      const data = JSON.parse(content);
      // Ensure runs array exists (imported jobs.json may lack it)
      if (!Array.isArray(data.runs)) data.runs = [];
      return data;
    } catch (err) {
      console.error('Error reading jobs.json:', err);
      return { jobs: [], runs: [] };
    }
  },

  // Write jobs.json for an app
  write(appId, agentId, data) {
    const jobsPath = this.getJobsPath(appId, agentId);
    fs.writeFileSync(jobsPath, JSON.stringify(data, null, 2));
  },

  // Get all jobs
  getJobs(appId, agentId) {
    const data = this.read(appId, agentId);
    return data.jobs;
  },

  // Get a single job by ID
  getJob(appId, agentId, jobId) {
    const data = this.read(appId, agentId);
    return data.jobs.find(j => j.id === jobId) || null;
  },

  // Create a new job
  createJob(appId, agentId, {
    name,
    description = '',
    type,
    schedule,
    onMissed = 'run',
    completionChecks = [],
    skill = null,
    skillScope = null,
    skillPath = null
  }) {
    const data = this.read(appId, agentId);
    const now = getSystemTime().iso;
    const normalizedChecks = this.normalizeCompletionChecks(completionChecks);

    const job = {
      id: generateId(),
      name,
      description,
      type, // 'one-time' or 'recurring'
      schedule, // { datetime } or { frequency, time, minute, dayOfWeek, dayOfMonth, month }
      onMissed, // 'run' or 'skip'
      completionChecks: normalizedChecks, // human-friendly validator checks
      skill,
      skillScope,
      skillPath,
      enabled: true,
      status: 'scheduled', // 'scheduled' | 'claimed' | 'running' | 'completed' | 'skipped'
      claimId: null,
      claimUntil: null,
      createdAt: now,
      lastRun: null,
      nextRun: this.calculateNextRun({ type, schedule, enabled: true })
    };

    data.jobs.push(job);
    this.write(appId, agentId, data);
    return job;
  },

  // Update a job
  updateJob(appId, agentId, jobId, updates) {
    const data = this.read(appId, agentId);
    const idx = data.jobs.findIndex(j => j.id === jobId);
    if (idx !== -1) {
      const job = { ...data.jobs[idx], ...updates };

      if (Object.prototype.hasOwnProperty.call(updates, 'completionChecks')) {
        job.completionChecks = this.normalizeCompletionChecks(updates.completionChecks);
      }

      // Recalculate nextRun if schedule, type, enabled, or archived changed
      if (updates.schedule || updates.type || updates.enabled !== undefined || updates.archived !== undefined) {
        job.nextRun = this.calculateNextRun(job);
      }

      data.jobs[idx] = job;
      this.write(appId, agentId, data);
      return job;
    }
    return null;
  },

  // Normalize completion checks to a trimmed string array
  normalizeCompletionChecks(checks) {
    if (!Array.isArray(checks)) return [];
    return checks
      .map(check => String(check || '').trim())
      .filter(Boolean)
      .slice(0, 20);
  },

  // Toggle job enabled/disabled
  toggleJob(appId, agentId, jobId) {
    const data = this.read(appId, agentId);
    const idx = data.jobs.findIndex(j => j.id === jobId);
    if (idx !== -1) {
      const job = data.jobs[idx];
      job.enabled = !job.enabled;
      job.nextRun = this.calculateNextRun(job);
      this.write(appId, agentId, data);
      return job;
    }
    return null;
  },

  // Delete a job (and its runs)
  deleteJob(appId, agentId, jobId) {
    const data = this.read(appId, agentId);
    data.jobs = data.jobs.filter(j => j.id !== jobId);
    data.runs = data.runs.filter(r => r.jobId !== jobId);
    this.write(appId, agentId, data);
  },

  // Get runs for a job (most recent first, with limit)
  getRuns(appId, agentId, jobId, limit = 50) {
    const data = this.read(appId, agentId);
    return data.runs
      .filter(r => r.jobId === jobId)
      .sort((a, b) => new Date(b.ranAt || b.scheduledFor) - new Date(a.ranAt || a.scheduledFor))
      .slice(0, limit);
  },

  // Add a run entry for a job
  // status: 'completed', 'skipped', 'failed', 'could_not_complete'
  // notes: Agent-provided description of work done or why it couldn't complete
  addRun(appId, agentId, jobId, { scheduledFor, ranAt, status, notes = null }) {
    const data = this.read(appId, agentId);

    const run = {
      id: generateId(),
      jobId,
      scheduledFor,
      ranAt: ranAt || getSystemTime().iso,
      status,
      notes
    };

    data.runs.push(run);

    // Update job's lastRun
    const jobIdx = data.jobs.findIndex(j => j.id === jobId);
    if (jobIdx !== -1) {
      data.jobs[jobIdx].lastRun = run.ranAt;
      // Recalculate next run for recurring jobs
      if (data.jobs[jobIdx].type === 'recurring') {
        data.jobs[jobIdx].nextRun = this.calculateNextRun(data.jobs[jobIdx]);
      } else {
        // One-time job completed - no next run
        data.jobs[jobIdx].nextRun = null;
      }
    }

    // Prune old runs (keep last 50 per job)
    this.pruneRuns(appId, agentId, jobId, 50, data);

    this.write(appId, agentId, data);
    return run;
  },

  // Prune runs to keep only the last N (operates on data object to avoid extra read/write)
  pruneRuns(appId, agentId, jobId, keep = 50, data = null) {
    const shouldWrite = !data;
    if (!data) {
      data = this.read(appId, agentId);
    }

    const jobRuns = data.runs
      .filter(r => r.jobId === jobId)
      .sort((a, b) => new Date(b.ranAt || b.scheduledFor) - new Date(a.ranAt || a.scheduledFor));

    if (jobRuns.length > keep) {
      const idsToKeep = new Set(jobRuns.slice(0, keep).map(r => r.id));
      data.runs = data.runs.filter(r => r.jobId !== jobId || idsToKeep.has(r.id));

      if (shouldWrite) {
        this.write(appId, agentId, data);
      }
    }
  },

  // Calculate the next run time for a job
  calculateNextRun(job) {
    if (!job.enabled) return null;
    if (job.archived) return null;  // Archived jobs don't run

    const now = getSystemTime().now;

    if (job.type === 'one-time') {
      const scheduled = new Date(job.schedule.datetime);
      // If scheduled time is in the future, that's the next run
      // (allows re-running by updating datetime, even if job ran before)
      if (scheduled > now) {
        return scheduled.toISOString();
      }
      // Scheduled time has passed - no next run
      return null;
    }

    // Recurring job
    const { frequency } = job.schedule;
    const validRecurringFrequencies = new Set([
      'every-x-minutes',
      'every-x-hours',
      'hourly',
      'daily',
      'weekdays',
      'weekly',
      'monthly',
      'annually'
    ]);
    if (!validRecurringFrequencies.has(frequency)) {
      console.warn(`[JobsFileService] Unsupported recurring frequency "${frequency}" for job ${job.id || '(new)'}; disabling nextRun`);
      return null;
    }

    // Parse time from schedule (HH:MM format)
    const parseTime = (timeStr) => {
      if (!timeStr) return { hours: 0, minutes: 0 };
      const [hours, minutes] = timeStr.split(':').map(Number);
      return { hours, minutes };
    };

    let next = new Date(now);

    switch (frequency) {
      case 'every-x-minutes': {
        const interval = job.schedule.interval || 15;
        const startDate = job.schedule.startDate;
        const startTime = job.schedule.startTime || '09:00';

        // Parse start datetime
        let startDateTime;
        if (startDate && startTime) {
          startDateTime = new Date(`${startDate}T${startTime}:00`);
        } else if (startTime) {
          // Use today with the start time
          const [hours, minutes] = startTime.split(':').map(Number);
          startDateTime = new Date(now);
          startDateTime.setHours(hours, minutes, 0, 0);
        } else {
          startDateTime = new Date(now);
        }

        // If we haven't reached the start time yet, that's the next run
        if (startDateTime > now) {
          next = startDateTime;
        } else {
          // Calculate next occurrence based on interval from start time
          const intervalMs = interval * 60 * 1000;
          const elapsed = now.getTime() - startDateTime.getTime();
          const periodsPassed = Math.floor(elapsed / intervalMs);
          next = new Date(startDateTime.getTime() + (periodsPassed + 1) * intervalMs);
        }
        break;
      }

      case 'every-x-hours': {
        const interval = job.schedule.interval || 4;
        const startDate = job.schedule.startDate;
        const startTime = job.schedule.startTime || '08:00';

        // Parse start datetime
        let startDateTime;
        if (startDate && startTime) {
          startDateTime = new Date(`${startDate}T${startTime}:00`);
        } else if (startTime) {
          const [hours, minutes] = startTime.split(':').map(Number);
          startDateTime = new Date(now);
          startDateTime.setHours(hours, minutes, 0, 0);
        } else {
          startDateTime = new Date(now);
        }

        // If we haven't reached the start time yet, that's the next run
        if (startDateTime > now) {
          next = startDateTime;
        } else {
          // Calculate next occurrence based on interval from start time
          const intervalMs = interval * 60 * 60 * 1000;
          const elapsed = now.getTime() - startDateTime.getTime();
          const periodsPassed = Math.floor(elapsed / intervalMs);
          next = new Date(startDateTime.getTime() + (periodsPassed + 1) * intervalMs);
        }
        break;
      }

      case 'hourly': {
        const minute = job.schedule.minute || 0;
        next.setMinutes(minute, 0, 0);
        if (next <= now) {
          next.setHours(next.getHours() + 1);
        }
        break;
      }

      case 'daily': {
        const { hours, minutes } = parseTime(job.schedule.time);
        next.setHours(hours, minutes, 0, 0);
        if (next <= now) {
          next.setDate(next.getDate() + 1);
        }
        break;
      }

      case 'weekdays': {
        const { hours, minutes } = parseTime(job.schedule.time);
        next.setHours(hours, minutes, 0, 0);
        if (next <= now) {
          next.setDate(next.getDate() + 1);
        }
        // Skip to next weekday (Mon=1, Tue=2, ..., Fri=5)
        while (next.getDay() === 0 || next.getDay() === 6) {
          next.setDate(next.getDate() + 1);
        }
        break;
      }

      case 'weekly': {
        const { hours, minutes } = parseTime(job.schedule.time);
        const targetDay = job.schedule.dayOfWeek || 0; // 0 = Sunday
        next.setHours(hours, minutes, 0, 0);

        const currentDay = next.getDay();
        let daysToAdd = targetDay - currentDay;
        if (daysToAdd < 0 || (daysToAdd === 0 && next <= now)) {
          daysToAdd += 7;
        }
        next.setDate(next.getDate() + daysToAdd);
        break;
      }

      case 'monthly': {
        const { hours, minutes } = parseTime(job.schedule.time);
        const targetDay = job.schedule.dayOfMonth || 1;
        next.setHours(hours, minutes, 0, 0);
        next.setDate(targetDay);

        if (next <= now) {
          next.setMonth(next.getMonth() + 1);
          next.setDate(targetDay); // Reset date in case month change affected it
        }
        break;
      }

      case 'annually': {
        const { hours, minutes } = parseTime(job.schedule.time);
        const targetMonth = (job.schedule.month || 1) - 1; // JS months are 0-indexed
        const targetDay = job.schedule.dayOfMonth || 1;
        next.setMonth(targetMonth, targetDay);
        next.setHours(hours, minutes, 0, 0);

        if (next <= now) {
          next.setFullYear(next.getFullYear() + 1);
        }
        break;
      }
    }

    return next.toISOString();
  },

  // Get jobs sorted by next run time (for agent scheduling)
  getUpcomingJobs(appId, agentId) {
    const jobs = this.getJobs(appId, agentId);
    return jobs
      .filter(j => j.enabled && j.nextRun)
      .sort((a, b) => new Date(a.nextRun) - new Date(b.nextRun));
  },

  // Get jobs that are due to run (nextRun <= now, status = scheduled)
  getDueJobs(appId, agentId) {
    const now = getSystemTime().now;
    const jobs = this.getJobs(appId, agentId);
    return jobs.filter(j => {
      if (!j.enabled || !j.nextRun) return false;
      // Only return jobs in 'scheduled' status (treat missing status as scheduled for backwards compat)
      const status = j.status || 'scheduled';
      if (status !== 'scheduled') return false;
      return new Date(j.nextRun) <= now;
    });
  },

  // Get stats for an app's jobs
  getStats(appId, agentId) {
    const data = this.read(appId, agentId);
    const total = data.jobs.length;
    const enabled = data.jobs.filter(j => j.enabled).length;
    const disabled = total - enabled;
    const oneTime = data.jobs.filter(j => j.type === 'one-time').length;
    const recurring = data.jobs.filter(j => j.type === 'recurring').length;
    return { total, enabled, disabled, oneTime, recurring };
  },

  // ============================================
  // CLAIM-BASED STATE MACHINE (Phase 2)
  // All methods take (appId, agentId, ...) for correct path resolution.
  // ============================================

  /**
   * Attempt to claim a job for execution.
   * Atomic operation: only succeeds if job is scheduled, due, and unclaimed (or lease expired).
   * @returns {{ success: true, claimId: string } | { success: false }}
   */
  async attemptClaim(appId, agentId, jobId) {
    const release = await fileMutex.acquire();
    try {
      const data = this.read(appId, agentId);
      const idx = data.jobs.findIndex(j => j.id === jobId);
      if (idx === -1) return { success: false };

      const job = data.jobs[idx];
      const now = getSystemTime().unix * 1000; // ms

      // Check claim conditions:
      // 1. Job must be in 'scheduled' status (treat missing status as scheduled for backwards compat)
      // 2. Job must be due (nextRun <= now)
      // 3. No active claim (claimUntil is null or expired)
      const isDue = job.nextRun && new Date(job.nextRun).getTime() <= now;
      const status = job.status || 'scheduled';
      const isScheduled = status === 'scheduled';
      const claimExpired = !job.claimUntil || job.claimUntil < now;

      if (!isScheduled || !isDue || !claimExpired) {
        return { success: false };
      }

      // Claim the job
      const claimId = generateId();
      job.status = 'claimed';
      job.claimId = claimId;
      job.claimUntil = now + LEASE_WINDOW_MS;

      data.jobs[idx] = job;
      this.write(appId, agentId, data);

      return { success: true, claimId };
    } finally {
      release();
    }
  },

  /**
   * Transition a claimed job to running.
   * Only succeeds if claimId matches.
   * @returns {boolean}
   */
  async markRunning(appId, agentId, jobId, claimId) {
    const release = await fileMutex.acquire();
    try {
      const data = this.read(appId, agentId);
      const idx = data.jobs.findIndex(j => j.id === jobId);
      if (idx === -1) return false;

      const job = data.jobs[idx];

      // Verify claim ownership
      if (job.status !== 'claimed' || job.claimId !== claimId) {
        return false;
      }

      job.status = 'running';
      // Refresh lease at transition to running so queue delay doesn't consume lease time.
      job.claimUntil = (getSystemTime().unix * 1000) + LEASE_WINDOW_MS;
      data.jobs[idx] = job;
      this.write(appId, agentId, data);

      return true;
    } finally {
      release();
    }
  },

  /**
   * Renew the lease for an in-flight claimed/running job.
   * Returns false if claim ownership was lost.
   * @returns {boolean}
   */
  async renewClaim(appId, agentId, jobId, claimId) {
    const release = await fileMutex.acquire();
    try {
      const data = this.read(appId, agentId);
      const idx = data.jobs.findIndex(j => j.id === jobId);
      if (idx === -1) return false;

      const job = data.jobs[idx];
      const validStatus = job.status === 'claimed' || job.status === 'running';
      if (!validStatus || job.claimId !== claimId) {
        return false;
      }

      job.claimUntil = (getSystemTime().unix * 1000) + LEASE_WINDOW_MS;
      data.jobs[idx] = job;
      this.write(appId, agentId, data);
      return true;
    } finally {
      release();
    }
  },

  /**
   * Mark a job as completed (or skipped/failed/could_not_complete).
   * Logs the run, advances nextRun, and resets claim fields.
   * @param {string} appId
   * @param {string} agentId
   * @param {string} jobId
   * @param {string} claimId
   * @param {'completed' | 'skipped' | 'failed' | 'could_not_complete'} status
   * @param {string|null} notes - Agent-provided description of what was done or why it couldn't complete
   * @returns {boolean}
   */
  async markCompleted(appId, agentId, jobId, claimId, status, notes = null) {
    const release = await fileMutex.acquire();
    try {
      const data = this.read(appId, agentId);
      const idx = data.jobs.findIndex(j => j.id === jobId);
      if (idx === -1) return false;

      const job = data.jobs[idx];

      // Verify claim ownership (allow from 'claimed' or 'running' status)
      if ((job.status !== 'claimed' && job.status !== 'running') || job.claimId !== claimId) {
        return false;
      }

      const now = getSystemTime().iso;
      const scheduledFor = job.nextRun;

      // Log the run
      const run = {
        id: generateId(),
        jobId,
        scheduledFor,
        ranAt: now,
        status,
        notes
      };
      data.runs.push(run);

      // Update job state
      job.lastRun = now;
      job.status = 'scheduled'; // Reset to scheduled for next occurrence
      job.claimId = null;
      job.claimUntil = null;

      // Advance nextRun (critical: skip must also advance to prevent infinite skip loop)
      if (job.type === 'recurring') {
        job.nextRun = this.calculateNextRun(job);
      } else {
        // One-time job - no next run
        job.nextRun = null;
      }

      data.jobs[idx] = job;

      // Prune old runs
      this.pruneRuns(appId, agentId, jobId, 50, data);

      this.write(appId, agentId, data);
      return true;
    } finally {
      release();
    }
  },

  /**
   * Find orphaned claims (jobs stuck in 'claimed' or 'running' with expired lease).
   * Called on every tick to recover stuck jobs.
   * @returns {Array<object>}
   */
  getOrphanedClaims(appId, agentId) {
    const now = getSystemTime().unix * 1000; // ms
    const jobs = this.getJobs(appId, agentId);
    return jobs.filter(j =>
      (j.status === 'claimed' || j.status === 'running') &&
      j.claimUntil &&
      j.claimUntil < now
    );
  },

  /**
   * Reset an orphaned claim back to scheduled status.
   * Called during crash recovery.
   * @returns {boolean}
   */
  async resetOrphanedClaim(appId, agentId, jobId) {
    const release = await fileMutex.acquire();
    try {
      const data = this.read(appId, agentId);
      const idx = data.jobs.findIndex(j => j.id === jobId);
      if (idx === -1) return false;

      const job = data.jobs[idx];
      const now = getSystemTime().unix * 1000; // ms

      // Only reset if truly orphaned (claimed or running with expired lease)
      if ((job.status !== 'claimed' && job.status !== 'running') || !job.claimUntil || job.claimUntil >= now) {
        return false;
      }

      job.status = 'scheduled';
      job.claimId = null;
      job.claimUntil = null;

      data.jobs[idx] = job;
      this.write(appId, agentId, data);

      return true;
    } finally {
      release();
    }
  },

  /**
   * Get jobs that are due and claimable (scheduled status, due time passed).
   * Used by tick() to find jobs to claim.
   * @param {string} appId
   * @param {string} agentId
   * @param {number} gracePeriodMs - Only return jobs due before (now - gracePeriod)
   * @returns {Array<object>}
   */
  getClaimableJobs(appId, agentId, gracePeriodMs = 0) {
    const now = getSystemTime().unix * 1000; // ms
    const threshold = now - gracePeriodMs;
    const jobs = this.getJobs(appId, agentId);

    return jobs.filter(j => {
      if (!j.enabled || !j.nextRun) return false;
      if (j.archived) return false;  // Skip archived jobs
      // Must be in 'scheduled' status (treat missing status as scheduled for backwards compat)
      const status = j.status || 'scheduled';
      if (status !== 'scheduled') return false;
      return new Date(j.nextRun).getTime() <= threshold;
    });
  }
};

module.exports = {
  JobsFileService,
  LEASE_WINDOW_MS
};
