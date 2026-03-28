/**
 * Job Scheduler Service
 *
 * Event-driven scheduler for timed jobs. Wake timer handles precise timing,
 * with orphan recovery catching any missed jobs. All triggers coordinate through tick().
 *
 * The Four Invariants:
 * 1. Claim before execute - Jobs are claimed atomically before execution
 * 2. Single entry point - All triggers call tick(), never execute directly
 * 3. One executor - All work flows through unified WorkQueue
 * 4. Persist before enqueue - Claims are persisted before in-memory queue
 */

const fs = require('fs');
const path = require('path');
const { Mutex } = require('async-mutex');
const { APPS_DIR } = require('../config');
const { JobsFileService } = require('./jobs-file');
const ConversationService = require('./conversation');
const { AppService } = require('./app');
const AgentService = require('./agent');
const { getSystemTime } = require('../routes/system');

// Maximum setTimeout value (~24.8 days) - JavaScript limit
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

// Grace period for late execution (2 minutes) - avoids accidental skips from short wake/event-loop jitter.
const GRACE_MS = 2 * 60 * 1000;

// Debounce delay for CRUD-triggered ticks
const CRUD_DEBOUNCE_MS = 100;

// Pulse cleanup runs at most once every 10 minutes
const PULSE_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

const JobSchedulerService = {
  mutex: new Mutex(),
  wakeTimer: null,
  crudDebounceTimer: null,
  workQueue: null,  // Set by init()
  lastTickTime: null,
  lastPulseCleanup: 0,
  isStarted: false,

  /**
   * Initialize the scheduler with dependencies
   * @param {{ workQueue: object }} deps
   */
  init(deps) {
    this.workQueue = deps.workQueue;
    this.db = deps.db || null;

    // Set up callback for when jobs complete - rearm timer
    if (this.workQueue) {
      this.workQueue.onJobComplete = (agentId, jobId, claimId, status, notes) => {
        console.log(`[JobScheduler] Job ${jobId} completed with status: ${status}`);
        // Rearm timer for next job
        this.tickDebounced();
      };
    }
  },

  /**
   * Start the scheduler
   * Called when OS8 starts
   */
  async start() {
    if (this.isStarted) return;
    this.isStarted = true;

    console.log('[JobScheduler] Starting...');

    // Initial tick catches due jobs and recovers any orphans from previous crash
    await this.tick('start');

    console.log('[JobScheduler] Started');
  },

  /**
   * Stop the scheduler
   * Called when OS8 quits
   */
  stop() {
    if (!this.isStarted) return;
    this.isStarted = false;

    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
    if (this.crudDebounceTimer) {
      clearTimeout(this.crudDebounceTimer);
      this.crudDebounceTimer = null;
    }

    console.log('[JobScheduler] Stopped');
  },

  /**
   * Central coordination function - all triggers call this
   * @param {'wake' | 'start' | 'resume' | 'crud'} source
   */
  async tick(source) {
    const release = await this.mutex.acquire();
    try {
      const systemTime = getSystemTime();
      const now = systemTime.unix * 1000; // Convert to ms
      this.lastTickTime = now;

      console.log(`[JobScheduler] tick(${source}) at ${systemTime.now.toLocaleTimeString()}`);

      // Recover any orphaned claims (stuck in claimed/running with expired lease)
      await this.recoverOrphanedClaims();

      // Schedule transient cleanup outside the mutex (non-blocking)
      this.scheduleTransientCleanup();

      // Find all due jobs across all apps
      const dueJobs = this.getAllClaimableJobs(0);

      // Sort by dueAt then createdAt for deterministic ordering
      dueJobs.sort((a, b) => {
        const aTime = new Date(a.job.nextRun).getTime();
        const bTime = new Date(b.job.nextRun).getTime();
        if (aTime !== bTime) return aTime - bTime;
        return new Date(a.job.createdAt).getTime() - new Date(b.job.createdAt).getTime();
      });

      // Attempt to claim each due job
      for (const { appId, agentId, job } of dueJobs) {
        const claim = await JobsFileService.attemptClaim(appId, agentId, job.id);

        if (claim.success) {
          console.log(`[JobScheduler] Claimed job ${job.id} (${job.name})`);

          // Handle onMissed policy for past-due jobs
          const jobDueTime = new Date(job.nextRun).getTime();
          const isPastDue = jobDueTime < now - GRACE_MS;

          if (isPastDue && job.onMissed === 'skip') {
            // Skip this execution, just advance the schedule
            console.log(`[JobScheduler] Skipping missed job ${job.id} (onMissed=skip)`);
            const marked = await JobsFileService.markCompleted(appId, agentId, job.id, claim.claimId, 'skipped', 'Missed while app was closed');
            if (!marked) {
              console.error(`[JobScheduler] Failed to mark skipped job ${job.id}; claim ownership likely lost`);
            }
          } else {
            // Enqueue for execution (claim is persisted, safe to enqueue)
            if (this.workQueue) {
              this.workQueue.enqueue({
                type: 'job',
                priority: 50,
                payload: { appId, agentId, jobId: job.id, claimId: claim.claimId, job },
                createdAt: now
              });
            } else {
              console.warn('[JobScheduler] WorkQueue not initialized, cannot enqueue job');
              // Release the claim since we can't execute
              const marked = await JobsFileService.markCompleted(appId, agentId, job.id, claim.claimId, 'failed', 'WorkQueue not initialized');
              if (!marked) {
                console.error(`[JobScheduler] Failed to mark unqueued job ${job.id} as failed; claim ownership likely lost`);
              }
            }
          }
        }
        // If claim fails, another tick already got it - skip
      }

      // Rearm wake timer to next due job
      this.rearmTimer();

    } finally {
      release();
    }
  },

  /**
   * Rearm the wake timer for the next due job
   */
  rearmTimer() {
    // Clear existing timer
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }

    // Find next scheduled job across all apps
    const next = this.getNextScheduledJob();
    if (!next) {
      console.log('[JobScheduler] No upcoming jobs, timer not armed');
      return;
    }

    const systemTime = getSystemTime();
    const now = systemTime.unix * 1000;
    const nextTime = new Date(next.job.nextRun).getTime();
    let delay = Math.max(0, nextTime - now);

    // Cap at MAX_TIMEOUT_MS to avoid overflow
    if (delay > MAX_TIMEOUT_MS) {
      delay = MAX_TIMEOUT_MS;
      console.log(`[JobScheduler] Timer capped at ~24.8 days, will recompute on fire`);
    }

    console.log(`[JobScheduler] Timer armed for ${next.job.name} in ${Math.round(delay / 1000)}s`);

    this.wakeTimer = setTimeout(() => {
      this.tick('wake');
    }, delay);
  },

  /**
   * Trigger tick with debouncing (for CRUD operations)
   */
  tickDebounced() {
    if (this.crudDebounceTimer) {
      clearTimeout(this.crudDebounceTimer);
    }
    this.crudDebounceTimer = setTimeout(() => {
      this.crudDebounceTimer = null;
      this.tick('crud');
    }, CRUD_DEBOUNCE_MS);
  },

  /**
   * Get all claimable jobs across all apps
   * @param {number} gracePeriodMs
   * @returns {Array<{appId: string, job: object}>}
   */
  getAllClaimableJobs(gracePeriodMs = 0) {
    const results = [];

    // Scan operational agents from DB (excludes visibility='off')
    const agents = this.db ? AgentService.getOperational(this.db) : [];
    for (const agent of agents) {
      const jobs = JobsFileService.getClaimableJobs(agent.app_id, agent.id, gracePeriodMs);
      for (const job of jobs) {
        results.push({ appId: agent.app_id, agentId: agent.id, job });
      }
    }

    return results;
  },

  /**
   * Get the next scheduled job across all apps (for timer arming)
   * @returns {{appId: string, job: object} | null}
   */
  getNextScheduledJob() {
    let earliest = null;
    let earliestTime = Infinity;

    // Scan operational agents from DB (excludes visibility='off')
    const agents = this.db ? AgentService.getOperational(this.db) : [];
    for (const agent of agents) {
      const jobs = JobsFileService.getJobs(agent.app_id, agent.id);
      for (const job of jobs) {
        if (!job.enabled || !job.nextRun) continue;
        // Must be in 'scheduled' status (treat missing status as scheduled for backwards compat)
        const status = job.status || 'scheduled';
        if (status !== 'scheduled') continue;

        const time = new Date(job.nextRun).getTime();
        if (time < earliestTime) {
          earliestTime = time;
          earliest = { appId: agent.app_id, agentId: agent.id, job };
        }
      }
    }

    return earliest;
  },

  /**
   * Recover orphaned claims from previous crash
   * Called on startup
   */
  async recoverOrphanedClaims() {
    // Scan agents from DB instead of filesystem
    const agents = this.db ? AgentService.getAll(this.db) : [];

    let recovered = 0;
    for (const agent of agents) {
      const orphans = JobsFileService.getOrphanedClaims(agent.app_id, agent.id);
      for (const job of orphans) {
        console.log(`[JobScheduler] Recovering orphaned ${job.status} job: ${job.id} (${job.name})`);
        await JobsFileService.resetOrphanedClaim(agent.app_id, agent.id, job.id);
        recovered++;
      }
    }

    if (recovered > 0) {
      console.log(`[JobScheduler] Recovered ${recovered} orphaned job(s)`);
    }
  },

  /**
   * Schedule transient cleanup to run outside the tick mutex
   * Throttled to run at most once every 10 minutes
   */
  scheduleTransientCleanup() {
    const now = Date.now();
    if (now - this.lastPulseCleanup < PULSE_CLEANUP_INTERVAL_MS) return;
    this.lastPulseCleanup = now;

    // Run outside tick() via setTimeout so it doesn't block job scheduling
    setTimeout(() => {
      const db = this.workQueue?.db;
      if (!db) return;

      try {
        const assistant = AgentService.getDefault(db) || AppService.getAssistant(db);
        if (!assistant) return;

        const TRANSIENT_JOBS = [
          { tag: 'pulse', jobName: 'Pulse', maxAgeMs: 60 * 60 * 1000 },          // 1 hour
          { tag: 'reverie', jobName: 'Reverie', maxAgeMs: 24 * 60 * 60 * 1000 },  // 24 hours
          { tag: 'transient', jobName: null, maxAgeMs: 2 * 60 * 60 * 1000 },      // 2 hours (generic transient)
        ];

        for (const { tag, jobName, maxAgeMs } of TRANSIENT_JOBS) {
          const deleted = ConversationService.deleteExpiredTransientEntries(db, assistant.id, tag, jobName, maxAgeMs);
          if (deleted > 0) {
            console.log(`[JobScheduler] Cleaned up ${deleted} expired ${tag} entries`);
          }
        }
      } catch (err) {
        console.error('[JobScheduler] Transient entry cleanup failed:', err.message);
      }
    }, 0);
  },

  /**
   * Get scheduler status (for debugging)
   */
  getStatus() {
    return {
      isStarted: this.isStarted,
      hasTimer: !!this.wakeTimer,
      lastTickTime: this.lastTickTime,
      nextJob: this.getNextScheduledJob()
    };
  }
};

module.exports = JobSchedulerService;
