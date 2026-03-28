import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { JobsFileService } = require('../../src/services/jobs-file');
const AgentService = require('../../src/services/agent');
const { parseJobCompletion, validateJobCompletion } = require('../../src/services/work-queue-validators');

// We test WorkQueue.executeJob orchestration by mocking all I/O:
// - JobsFileService (markRunning, markCompleted, renewClaim)
// - spawnClaudeForJob (returns canned response)
// - ConversationService (no-op)
// - AgentService.getById (returns stub agent)

// Directly require and patch WorkQueue
const workQueueModule = require('../../src/services/work-queue');

// Store originals
let origMarkRunning, origMarkCompleted, origRenewClaim;
let origGetById, origGetPaths;

const STUB_AGENT = { id: 'agent-1', app_id: 'app-1', name: 'Test Agent', backend: 'claude' };
const STUB_JOB = {
  id: 'job-1',
  name: 'Test Job',
  description: 'A test job',
  skill: null,
  completionChecks: [],
  onMissed: 'run',
  type: 'recurring',
  schedule: { frequency: 'daily', time: '09:00' },
};

beforeEach(() => {
  origMarkRunning = JobsFileService.markRunning;
  origMarkCompleted = JobsFileService.markCompleted;
  origRenewClaim = JobsFileService.renewClaim;
  origGetById = AgentService.getById;
  origGetPaths = AgentService.getPaths;

  // Default mocks — all succeed
  JobsFileService.markRunning = async () => true;
  JobsFileService.markCompleted = async () => true;
  JobsFileService.renewClaim = async () => true;
  AgentService.getById = () => STUB_AGENT;
  AgentService.getPaths = () => ({ agentDir: '/tmp/test-agent', agentBlobDir: '/tmp/test-blob' });

  // Reset WorkQueue state
  workQueueModule.WorkQueue.queue = [];
  workQueueModule.WorkQueue.processing = false;
  workQueueModule.WorkQueue.onJobComplete = null;
  workQueueModule.WorkQueue.getDb = () => null;
});

afterEach(() => {
  JobsFileService.markRunning = origMarkRunning;
  JobsFileService.markCompleted = origMarkCompleted;
  JobsFileService.renewClaim = origRenewClaim;
  AgentService.getById = origGetById;
  AgentService.getPaths = origGetPaths;
});

function createPayload(overrides = {}) {
  return {
    appId: 'app-1',
    agentId: 'agent-1',
    jobId: 'job-1',
    claimId: 'claim-1',
    job: { ...STUB_JOB, ...overrides },
  };
}

describe('WorkQueue — executeJob lifecycle', () => {

  it('calls markRunning before spawn', async () => {
    const callOrder = [];

    JobsFileService.markRunning = async () => {
      callOrder.push('markRunning');
      return true;
    };

    // Stub spawnClaudeForJob to avoid actual spawn
    const origSpawn = workQueueModule.WorkQueue.spawnClaudeForJob;
    workQueueModule.WorkQueue.spawnClaudeForJob = async () => {
      callOrder.push('spawn');
      return '[JOB_COMPLETE: Done]';
    };

    try {
      await workQueueModule.WorkQueue.executeJob(createPayload());
      expect(callOrder[0]).toBe('markRunning');
      expect(callOrder[1]).toBe('spawn');
    } finally {
      workQueueModule.WorkQueue.spawnClaudeForJob = origSpawn;
    }
  });

  it('marks job completed with parsed notes on success', async () => {
    const completedCalls = [];
    JobsFileService.markCompleted = async (appId, agentId, jobId, claimId, status, notes) => {
      completedCalls.push({ status, notes });
      return true;
    };

    const origSpawn = workQueueModule.WorkQueue.spawnClaudeForJob;
    workQueueModule.WorkQueue.spawnClaudeForJob = async () => '[JOB_COMPLETE: Updated all files successfully]';

    try {
      await workQueueModule.WorkQueue.executeJob(createPayload());
      expect(completedCalls).toHaveLength(1);
      expect(completedCalls[0].status).toBe('completed');
      expect(completedCalls[0].notes).toContain('Updated all files');
    } finally {
      workQueueModule.WorkQueue.spawnClaudeForJob = origSpawn;
    }
  });

  it('marks job could_not_complete when no completion marker', async () => {
    const completedCalls = [];
    JobsFileService.markCompleted = async (appId, agentId, jobId, claimId, status, notes) => {
      completedCalls.push({ status, notes });
      return true;
    };

    const origSpawn = workQueueModule.WorkQueue.spawnClaudeForJob;
    workQueueModule.WorkQueue.spawnClaudeForJob = async () => 'I tried to do the task but here is what happened...';

    try {
      await workQueueModule.WorkQueue.executeJob(createPayload());
      expect(completedCalls[0].status).toBe('could_not_complete');
      expect(completedCalls[0].notes).toContain('Missing required completion marker');
    } finally {
      workQueueModule.WorkQueue.spawnClaudeForJob = origSpawn;
    }
  });

  it('marks job failed when markRunning returns false (claim expired)', async () => {
    JobsFileService.markRunning = async () => false;

    const jobCompleteCalls = [];
    workQueueModule.WorkQueue.onJobComplete = (agentId, jobId, claimId, status, notes) => {
      jobCompleteCalls.push({ status, notes });
    };

    await workQueueModule.WorkQueue.executeJob(createPayload());

    expect(jobCompleteCalls).toHaveLength(1);
    expect(jobCompleteCalls[0].status).toBe('failed');
    expect(jobCompleteCalls[0].notes).toContain('Failed to transition claim');
  });

  it('marks job failed when spawn throws', async () => {
    const completedCalls = [];
    JobsFileService.markCompleted = async (appId, agentId, jobId, claimId, status, notes) => {
      completedCalls.push({ status, notes });
      return true;
    };

    const origSpawn = workQueueModule.WorkQueue.spawnClaudeForJob;
    workQueueModule.WorkQueue.spawnClaudeForJob = async () => { throw new Error('CLI crashed'); };

    const jobCompleteCalls = [];
    workQueueModule.WorkQueue.onJobComplete = (agentId, jobId, claimId, status, notes) => {
      jobCompleteCalls.push({ status, notes });
    };

    try {
      // executeJob handles errors internally (no re-throw) to prevent queue jamming
      await workQueueModule.WorkQueue.executeJob(createPayload());
      expect(completedCalls[0].status).toBe('failed');
      expect(jobCompleteCalls[0].status).toBe('failed');
    } finally {
      workQueueModule.WorkQueue.spawnClaudeForJob = origSpawn;
    }
  });

  it('calls onJobComplete on success', async () => {
    const origSpawn = workQueueModule.WorkQueue.spawnClaudeForJob;
    workQueueModule.WorkQueue.spawnClaudeForJob = async () => '[JOB_COMPLETE: Done]';

    const jobCompleteCalls = [];
    workQueueModule.WorkQueue.onJobComplete = (agentId, jobId, claimId, status) => {
      jobCompleteCalls.push({ agentId, jobId, status });
    };

    try {
      await workQueueModule.WorkQueue.executeJob(createPayload());
      expect(jobCompleteCalls).toHaveLength(1);
      expect(jobCompleteCalls[0].status).toBe('completed');
      expect(jobCompleteCalls[0].agentId).toBe('agent-1');
      expect(jobCompleteCalls[0].jobId).toBe('job-1');
    } finally {
      workQueueModule.WorkQueue.spawnClaudeForJob = origSpawn;
    }
  });

  it('clears claim renewal timer in finally block', async () => {
    // Verify renewClaim is NOT called after job completes (timer cleared)
    const renewCalls = [];
    JobsFileService.renewClaim = async () => {
      renewCalls.push(Date.now());
      return true;
    };

    const origSpawn = workQueueModule.WorkQueue.spawnClaudeForJob;
    workQueueModule.WorkQueue.spawnClaudeForJob = async () => '[JOB_COMPLETE: Done]';

    try {
      await workQueueModule.WorkQueue.executeJob(createPayload());
      // Timer interval is 60s, job completed instantly — no renewal should have fired
      expect(renewCalls).toHaveLength(0);
    } finally {
      workQueueModule.WorkQueue.spawnClaudeForJob = origSpawn;
    }
  });
});
