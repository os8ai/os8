import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { JobsFileService } = require('../../src/services/jobs-file');
const AgentService = require('../../src/services/agent');

// We test JobSchedulerService logic by exercising the functions it calls:
// getAllClaimableJobs, getNextScheduledJob, recoverOrphanedClaims, tick flow.
// Direct import + mock dependencies to avoid timer/mutex complexity.

let originalGetOperational, originalGetAll, originalGetClaimableJobs, originalGetOrphanedClaims;
let originalResetOrphanedClaim, originalAttemptClaim, originalMarkCompleted, originalGetJobs;

const AGENTS = [
  { id: 'agent-1', app_id: 'app-1' },
  { id: 'agent-2', app_id: 'app-2' },
];

beforeEach(() => {
  // Save originals
  originalGetOperational = AgentService.getOperational;
  originalGetAll = AgentService.getAll;
  originalGetClaimableJobs = JobsFileService.getClaimableJobs;
  originalGetOrphanedClaims = JobsFileService.getOrphanedClaims;
  originalResetOrphanedClaim = JobsFileService.resetOrphanedClaim;
  originalAttemptClaim = JobsFileService.attemptClaim;
  originalMarkCompleted = JobsFileService.markCompleted;
  originalGetJobs = JobsFileService.getJobs;
});

afterEach(() => {
  AgentService.getOperational = originalGetOperational;
  AgentService.getAll = originalGetAll;
  JobsFileService.getClaimableJobs = originalGetClaimableJobs;
  JobsFileService.getOrphanedClaims = originalGetOrphanedClaims;
  JobsFileService.resetOrphanedClaim = originalResetOrphanedClaim;
  JobsFileService.attemptClaim = originalAttemptClaim;
  JobsFileService.markCompleted = originalMarkCompleted;
  JobsFileService.getJobs = originalGetJobs;
});

// Fresh scheduler per test (reset state)
function createScheduler() {
  // Re-require to get fresh module state
  delete require.cache[require.resolve('../../src/services/job-scheduler')];
  const JobSchedulerService = require('../../src/services/job-scheduler');

  // Bind a mock db and no-op workQueue
  JobSchedulerService.db = { fake: true };
  JobSchedulerService.workQueue = null;
  JobSchedulerService.isStarted = false;
  JobSchedulerService.wakeTimer = null;
  JobSchedulerService.crudDebounceTimer = null;
  JobSchedulerService.lastTickTime = null;
  JobSchedulerService.lastPulseCleanup = 0;

  return JobSchedulerService;
}

describe('JobSchedulerService', () => {

  describe('getAllClaimableJobs', () => {
    it('returns due jobs from all operational agents', () => {
      const scheduler = createScheduler();
      AgentService.getOperational = () => AGENTS;

      const now = new Date().toISOString();
      JobsFileService.getClaimableJobs = (appId, agentId) => {
        if (agentId === 'agent-1') return [{ id: 'job-1', name: 'Test Job', nextRun: now }];
        return [];
      };

      const jobs = scheduler.getAllClaimableJobs(0);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].appId).toBe('app-1');
      expect(jobs[0].agentId).toBe('agent-1');
      expect(jobs[0].job.id).toBe('job-1');
    });

    it('returns empty when db is null', () => {
      const scheduler = createScheduler();
      scheduler.db = null;
      const jobs = scheduler.getAllClaimableJobs(0);
      expect(jobs).toHaveLength(0);
    });

    it('aggregates jobs from multiple agents', () => {
      const scheduler = createScheduler();
      AgentService.getOperational = () => AGENTS;

      const now = new Date().toISOString();
      JobsFileService.getClaimableJobs = (appId, agentId) => {
        return [{ id: `job-${agentId}`, name: 'Job', nextRun: now }];
      };

      const jobs = scheduler.getAllClaimableJobs(0);
      expect(jobs).toHaveLength(2);
    });
  });

  describe('getNextScheduledJob', () => {
    it('returns the earliest scheduled job', () => {
      const scheduler = createScheduler();
      AgentService.getOperational = () => AGENTS;

      const earlier = new Date(Date.now() + 60000).toISOString();
      const later = new Date(Date.now() + 120000).toISOString();

      JobsFileService.getJobs = (appId, agentId) => {
        if (agentId === 'agent-1') return [{ id: 'j1', enabled: true, nextRun: later, status: 'scheduled' }];
        if (agentId === 'agent-2') return [{ id: 'j2', enabled: true, nextRun: earlier, status: 'scheduled' }];
        return [];
      };

      const next = scheduler.getNextScheduledJob();
      expect(next.job.id).toBe('j2');
      expect(next.agentId).toBe('agent-2');
    });

    it('skips disabled jobs', () => {
      const scheduler = createScheduler();
      AgentService.getOperational = () => [AGENTS[0]];

      JobsFileService.getJobs = () => [
        { id: 'j1', enabled: false, nextRun: new Date(Date.now() + 60000).toISOString(), status: 'scheduled' },
      ];

      expect(scheduler.getNextScheduledJob()).toBeNull();
    });

    it('skips jobs in claimed/running status', () => {
      const scheduler = createScheduler();
      AgentService.getOperational = () => [AGENTS[0]];

      JobsFileService.getJobs = () => [
        { id: 'j1', enabled: true, nextRun: new Date(Date.now() + 60000).toISOString(), status: 'claimed' },
        { id: 'j2', enabled: true, nextRun: new Date(Date.now() + 60000).toISOString(), status: 'running' },
      ];

      expect(scheduler.getNextScheduledJob()).toBeNull();
    });

    it('treats missing status as scheduled (backwards compat)', () => {
      const scheduler = createScheduler();
      AgentService.getOperational = () => [AGENTS[0]];

      const nextRun = new Date(Date.now() + 60000).toISOString();
      JobsFileService.getJobs = () => [
        { id: 'j1', enabled: true, nextRun },
      ];

      const next = scheduler.getNextScheduledJob();
      expect(next.job.id).toBe('j1');
    });

    it('returns null when db is null', () => {
      const scheduler = createScheduler();
      scheduler.db = null;
      expect(scheduler.getNextScheduledJob()).toBeNull();
    });
  });

  describe('recoverOrphanedClaims', () => {
    it('recovers claimed jobs with expired lease', async () => {
      const scheduler = createScheduler();
      AgentService.getAll = () => [AGENTS[0]];

      const resetCalls = [];
      JobsFileService.getOrphanedClaims = () => [
        { id: 'j1', name: 'Stuck claimed', status: 'claimed' },
      ];
      JobsFileService.resetOrphanedClaim = async (appId, agentId, jobId) => {
        resetCalls.push({ appId, agentId, jobId });
      };

      await scheduler.recoverOrphanedClaims();
      expect(resetCalls).toHaveLength(1);
      expect(resetCalls[0]).toEqual({ appId: 'app-1', agentId: 'agent-1', jobId: 'j1' });
    });

    it('recovers running jobs with expired lease (the fixed bug)', async () => {
      const scheduler = createScheduler();
      AgentService.getAll = () => [AGENTS[0]];

      const resetCalls = [];
      JobsFileService.getOrphanedClaims = () => [
        { id: 'j1', name: 'Stuck running', status: 'running' },
      ];
      JobsFileService.resetOrphanedClaim = async (appId, agentId, jobId) => {
        resetCalls.push(jobId);
      };

      await scheduler.recoverOrphanedClaims();
      expect(resetCalls).toEqual(['j1']);
    });

    it('recovers orphans across multiple agents', async () => {
      const scheduler = createScheduler();
      AgentService.getAll = () => AGENTS;

      const resetCalls = [];
      JobsFileService.getOrphanedClaims = (appId, agentId) => {
        if (agentId === 'agent-1') return [{ id: 'j1', name: 'Orphan 1', status: 'claimed' }];
        if (agentId === 'agent-2') return [{ id: 'j2', name: 'Orphan 2', status: 'running' }];
        return [];
      };
      JobsFileService.resetOrphanedClaim = async (appId, agentId, jobId) => {
        resetCalls.push(jobId);
      };

      await scheduler.recoverOrphanedClaims();
      expect(resetCalls).toEqual(['j1', 'j2']);
    });

    it('does nothing when no orphans exist', async () => {
      const scheduler = createScheduler();
      AgentService.getAll = () => AGENTS;

      const resetCalls = [];
      JobsFileService.getOrphanedClaims = () => [];
      JobsFileService.resetOrphanedClaim = async () => { resetCalls.push(true); };

      await scheduler.recoverOrphanedClaims();
      expect(resetCalls).toHaveLength(0);
    });

    it('does nothing when db is null', async () => {
      const scheduler = createScheduler();
      scheduler.db = null;

      const resetCalls = [];
      JobsFileService.getOrphanedClaims = () => [{ id: 'j1', name: 'X', status: 'claimed' }];
      JobsFileService.resetOrphanedClaim = async () => { resetCalls.push(true); };

      await scheduler.recoverOrphanedClaims();
      expect(resetCalls).toHaveLength(0);
    });
  });

  describe('tick — claim and enqueue flow', () => {
    it('claims due job and enqueues to WorkQueue', async () => {
      const scheduler = createScheduler();
      AgentService.getOperational = () => [AGENTS[0]];
      AgentService.getAll = () => [AGENTS[0]];

      const now = new Date().toISOString();
      JobsFileService.getClaimableJobs = () => [
        { id: 'j1', name: 'Due Job', nextRun: now, onMissed: 'run', createdAt: now },
      ];
      JobsFileService.getOrphanedClaims = () => [];
      JobsFileService.attemptClaim = async () => ({ success: true, claimId: 'claim-1' });
      JobsFileService.getJobs = () => [];

      const enqueued = [];
      scheduler.workQueue = {
        enqueue: (item) => enqueued.push(item),
      };

      await scheduler.tick('test');

      expect(enqueued).toHaveLength(1);
      expect(enqueued[0].type).toBe('job');
      expect(enqueued[0].payload.jobId).toBe('j1');
      expect(enqueued[0].payload.claimId).toBe('claim-1');
    });

    it('skips missed job when onMissed=skip', async () => {
      const scheduler = createScheduler();
      AgentService.getOperational = () => [AGENTS[0]];
      AgentService.getAll = () => [AGENTS[0]];

      // Job due 5 minutes ago (past grace period of 2 min)
      const pastDue = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      JobsFileService.getClaimableJobs = () => [
        { id: 'j1', name: 'Old Job', nextRun: pastDue, onMissed: 'skip', createdAt: pastDue },
      ];
      JobsFileService.getOrphanedClaims = () => [];
      JobsFileService.attemptClaim = async () => ({ success: true, claimId: 'claim-1' });
      JobsFileService.getJobs = () => [];

      const completedCalls = [];
      JobsFileService.markCompleted = async (appId, agentId, jobId, claimId, status, notes) => {
        completedCalls.push({ status, notes });
        return true;
      };

      const enqueued = [];
      scheduler.workQueue = {
        enqueue: (item) => enqueued.push(item),
      };

      await scheduler.tick('test');

      expect(enqueued).toHaveLength(0);
      expect(completedCalls).toHaveLength(1);
      expect(completedCalls[0].status).toBe('skipped');
    });

    it('marks job failed when WorkQueue not initialized', async () => {
      const scheduler = createScheduler();
      scheduler.workQueue = null;
      AgentService.getOperational = () => [AGENTS[0]];
      AgentService.getAll = () => [AGENTS[0]];

      const now = new Date().toISOString();
      JobsFileService.getClaimableJobs = () => [
        { id: 'j1', name: 'Job', nextRun: now, onMissed: 'run', createdAt: now },
      ];
      JobsFileService.getOrphanedClaims = () => [];
      JobsFileService.attemptClaim = async () => ({ success: true, claimId: 'claim-1' });
      JobsFileService.getJobs = () => [];

      const completedCalls = [];
      JobsFileService.markCompleted = async (appId, agentId, jobId, claimId, status, notes) => {
        completedCalls.push({ status, notes });
        return true;
      };

      await scheduler.tick('test');

      expect(completedCalls).toHaveLength(1);
      expect(completedCalls[0].status).toBe('failed');
      expect(completedCalls[0].notes).toContain('WorkQueue not initialized');
    });

    it('skips job when claim fails (already claimed by another tick)', async () => {
      const scheduler = createScheduler();
      AgentService.getOperational = () => [AGENTS[0]];
      AgentService.getAll = () => [AGENTS[0]];

      const now = new Date().toISOString();
      JobsFileService.getClaimableJobs = () => [
        { id: 'j1', name: 'Job', nextRun: now, onMissed: 'run', createdAt: now },
      ];
      JobsFileService.getOrphanedClaims = () => [];
      JobsFileService.attemptClaim = async () => ({ success: false });
      JobsFileService.getJobs = () => [];

      const enqueued = [];
      scheduler.workQueue = {
        enqueue: (item) => enqueued.push(item),
      };

      await scheduler.tick('test');

      expect(enqueued).toHaveLength(0);
    });
  });
});
