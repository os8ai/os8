/**
 * PlanExecutorService — Orchestrate plan step execution
 *
 * Walks the plan's dependency graph and dispatches each step to the
 * appropriate agent via the WorkQueue. Supports live execution (resolver
 * pattern) and crash recovery (poll-based fallback).
 */

const PlanService = require('./plan');
const AgentService = require('./agent');
const agentState = require('./agent-state');
const { getAppEnvironmentContext } = require('./plan-generator');

const PLAN_STEP_PRIORITY = 60;
const POLL_INTERVAL_MS = 5000;

const PlanExecutorService = {
  // In-memory resolvers for live execution (lost on crash)
  _stepResolvers: {},

  // Per-plan notification callbacks: Map<planId, { onStepProgress, onComplete }>
  _planCallbacks: {},

  // WorkQueue reference (set during server wiring)
  _workQueue: null,

  // DB reference (set during server wiring)
  _db: null,

  /**
   * Set WorkQueue reference for enqueuing steps.
   * @param {object} workQueue
   */
  setWorkQueue(workQueue) {
    this._workQueue = workQueue;
  },

  /**
   * Set DB reference for conversation recording.
   * @param {object} db
   */
  setDb(db) {
    this._db = db;
  },

  /**
   * Send SSE event to an agent's chat clients.
   * @param {string} agentId
   * @param {object} event - SSE event data
   */
  _sendToAgent(agentId, event) {
    const state = agentState.getAgentState(agentId);
    const data = JSON.stringify(event);
    state.responseClients.forEach(client => {
      try { client.write(`data: ${data}\n\n`); } catch {}
    });
  },

  /**
   * Begin executing an approved plan.
   * @param {object} db
   * @param {string} planId
   * @param {object} [callbacks] - Optional notification callbacks
   * @param {function} [callbacks.onStepProgress] - (planId, stepSeq, totalSteps, description, status) => void
   * @param {function} [callbacks.onComplete] - (planId, summary) => void
   */
  async execute(db, planId, callbacks) {
    const plan = PlanService.getById(db, planId);
    if (!plan) throw new Error(`Plan ${planId} not found`);
    if (plan.status !== 'approved') {
      throw new Error(`Cannot execute plan with status "${plan.status}"`);
    }

    if (callbacks) this._planCallbacks[planId] = callbacks;

    PlanService.updateStatus(db, planId, 'executing');
    console.log(`[PlanExecutor] Starting execution of plan ${planId}: ${plan.summary}`);

    const executionOrder = this._topologicalSort(plan.steps);
    await this._executeSteps(db, plan, executionOrder, 'live');
  },

  /**
   * Cancel a running plan. Marks remaining steps as cancelled.
   * @param {object} db
   * @param {string} planId
   */
  cancel(db, planId) {
    const plan = PlanService.getById(db, planId);
    if (!plan) return;

    // Cancel all pending/running steps
    for (const step of plan.steps) {
      if (step.status === 'pending' || step.status === 'running') {
        PlanService.updateStep(db, step.id, {
          status: 'cancelled',
          completed_at: new Date().toISOString()
        });
      }
    }

    // Resolve any pending step resolvers to unblock the executor
    for (const step of plan.steps) {
      if (this._stepResolvers[step.id]) {
        this._stepResolvers[step.id](null);
        delete this._stepResolvers[step.id];
      }
    }

    PlanService.updateStatus(db, planId, 'cancelled');

    this._sendToAgent(plan.agent_id, {
      type: 'done',
      text: 'Plan cancelled.'
    });

    console.log(`[PlanExecutor] Plan ${planId} cancelled`);
  },

  /**
   * Resume a plan interrupted by crash/restart.
   * Uses poll-based dispatch (no resolvers).
   * @param {object} db
   * @param {string} planId
   */
  async resume(db, planId) {
    const plan = PlanService.getById(db, planId);
    if (!plan || plan.status !== 'executing') return;

    console.log(`[PlanExecutor] Resuming plan ${planId}`);

    // Mark any running steps as failed (they were interrupted)
    for (const step of plan.steps) {
      if (step.status === 'running') {
        PlanService.updateStep(db, step.id, {
          status: 'failed',
          result: 'Interrupted by restart',
          completed_at: new Date().toISOString()
        });
      }
    }

    // Re-load plan with updated step statuses
    const refreshed = PlanService.getById(db, planId);
    const remaining = refreshed.steps.filter(s => s.status === 'pending');

    if (remaining.length === 0) {
      // All steps done (completed or failed)
      this._finalizePlan(db, planId);
      return;
    }

    const executionOrder = this._topologicalSort(refreshed.steps);
    // Filter to only pending steps
    const pendingOrder = executionOrder.filter(s => s.status === 'pending');
    await this._executeSteps(db, refreshed, pendingOrder, 'poll');
  },

  /**
   * Get execution status summary.
   * @param {object} db
   * @param {string} planId
   * @returns {object|null}
   */
  getStatus(db, planId) {
    const plan = PlanService.getById(db, planId);
    if (!plan) return null;

    const elapsed = plan.completed_at
      ? new Date(plan.completed_at) - new Date(plan.created_at)
      : Date.now() - new Date(plan.created_at);

    return {
      planId: plan.id,
      status: plan.status,
      steps: plan.steps.map(s => ({
        id: s.id,
        status: s.status,
        result: s.result,
        durationMs: s.started_at && s.completed_at
          ? new Date(s.completed_at) - new Date(s.started_at)
          : null
      })),
      elapsed
    };
  },

  /**
   * Execute steps in dependency order.
   * @param {object} db
   * @param {object} plan
   * @param {Array} steps - Steps in execution order
   * @param {'live'|'poll'} mode
   */
  async _executeSteps(db, plan, steps, mode) {
    const startTime = Date.now();
    const totalSteps = plan.steps.length;
    let accumulatedText = ''; // Track all text for the final done event

    // Helper: send stream event and accumulate text
    const streamText = (text) => {
      accumulatedText += text;
      this._sendToAgent(plan.agent_id, { type: 'stream', text });
    };

    for (const step of steps) {
      // Re-read step status (may have been cancelled externally)
      const currentPlan = PlanService.getById(db, plan.id);
      if (!currentPlan || currentPlan.status === 'cancelled') {
        console.log(`[PlanExecutor] Plan ${plan.id} was cancelled, stopping`);
        return;
      }

      const currentStep = currentPlan.steps.find(s => s.id === step.id);
      if (!currentStep || currentStep.status !== 'pending') continue;

      // Check dependencies
      const deps = currentStep.depends_on || [];
      let skipStep = false;
      for (const depId of deps) {
        const depStep = currentPlan.steps.find(s => s.id === depId);
        if (!depStep || depStep.status === 'failed' || depStep.status === 'cancelled') {
          skipStep = true;
          break;
        }
        if (depStep.status !== 'completed') {
          skipStep = true;
          break;
        }
      }

      if (skipStep) {
        PlanService.updateStep(db, step.id, {
          status: 'skipped',
          result: 'Skipped due to failed dependency',
          completed_at: new Date().toISOString()
        });
        streamText(`\n- Step ${step.seq}: Skipped (dependency failed)\n`);
        continue;
      }

      // Mark step as running
      PlanService.updateStep(db, step.id, {
        status: 'running',
        started_at: new Date().toISOString()
      });

      streamText(`\nStep ${step.seq}/${totalSteps}: ${step.description}...\n`);
      this._notifyStepProgress(plan.id, step.seq, totalSteps, step.description, 'running');

      // Resolve the target agent
      const targetAgentId = step.agent_id === plan.agent_id || step.agent_id === 'self'
        ? plan.agent_id
        : step.agent_id;

      const targetAgent = AgentService.getById(db, targetAgentId);
      if (!targetAgent || targetAgent.visibility === 'off') {
        PlanService.updateStep(db, step.id, {
          status: 'failed',
          result: 'Agent unavailable',
          completed_at: new Date().toISOString()
        });
        streamText(`- Failed: Agent unavailable\n`);
        continue;
      }

      // Build step prompt with plan context
      const prompt = this._buildStepPrompt(db, currentPlan, currentStep);

      // Dispatch step
      let response;
      try {
        if (mode === 'live') {
          response = await this._dispatchLive(db, plan.id, step.id, targetAgentId, prompt);
        } else {
          response = await this._dispatchPoll(db, plan.id, step.id, targetAgentId, prompt);
        }
      } catch (err) {
        console.error(`[PlanExecutor] Step ${step.id} dispatch error:`, err);
        PlanService.updateStep(db, step.id, {
          status: 'failed',
          result: err.message,
          completed_at: new Date().toISOString()
        });
        streamText(`- Failed: ${err.message}\n`);
        continue;
      }

      // Step status was already updated by WorkQueue callback (live) or poll loop
      const finishedStep = db.prepare('SELECT * FROM plan_steps WHERE id = ?').get(step.id);
      const stepStatus = finishedStep?.status || 'completed';
      const durationMs = finishedStep?.started_at && finishedStep?.completed_at
        ? new Date(finishedStep.completed_at) - new Date(finishedStep.started_at)
        : null;
      const durationStr = durationMs ? ` (${Math.round(durationMs / 1000)}s)` : '';
      const statusLabel = stepStatus === 'completed' ? 'Done' : 'Failed';

      streamText(`- ${statusLabel}${durationStr}\n`);
      this._notifyStepProgress(plan.id, step.seq, totalSteps, step.description, stepStatus);
    }

    this._finalizePlan(db, plan.id);
    const totalDuration = Math.round((Date.now() - startTime) / 1000);
    console.log(`[PlanExecutor] Execution complete for plan ${plan.id} in ${totalDuration}s`);

    // Build and send contextual completion summary
    const finalPlan = PlanService.getById(db, plan.id);
    const summary = this.buildCompletionSummary(finalPlan, totalDuration);
    this._sendToAgent(plan.agent_id, { type: 'done', text: summary });
    this._notifyComplete(plan.id, summary);
  },

  /**
   * Dispatch a step via WorkQueue with resolver-based completion (live path).
   */
  _dispatchLive(db, planId, stepId, agentId, prompt) {
    return new Promise((resolve, reject) => {
      this._stepResolvers[stepId] = (response) => {
        delete this._stepResolvers[stepId];
        resolve(response);
      };

      if (!this._workQueue) {
        delete this._stepResolvers[stepId];
        return reject(new Error('WorkQueue not available'));
      }

      this._workQueue.enqueue({
        type: 'plan-step',
        priority: PLAN_STEP_PRIORITY,
        payload: { planId, stepId, agentId, prompt },
        createdAt: Date.now()
      });
    });
  },

  /**
   * Dispatch a step via WorkQueue with poll-based completion (crash recovery path).
   */
  _dispatchPoll(db, planId, stepId, agentId, prompt) {
    if (!this._workQueue) {
      throw new Error('WorkQueue not available');
    }

    this._workQueue.enqueue({
      type: 'plan-step',
      priority: PLAN_STEP_PRIORITY,
      payload: { planId, stepId, agentId, prompt },
      createdAt: Date.now()
    });

    // Poll until step leaves 'running' status
    return new Promise((resolve) => {
      const poll = setInterval(() => {
        const step = db.prepare('SELECT status, result FROM plan_steps WHERE id = ?').get(stepId);
        if (!step || step.status !== 'running') {
          clearInterval(poll);
          resolve(step?.result || null);
        }
      }, POLL_INTERVAL_MS);
    });
  },

  /**
   * Build the Phase 2 prompt with plan context for a step.
   */
  _buildStepPrompt(db, plan, step) {
    const totalSteps = plan.steps.length;
    const stepNum = step.seq;

    let prompt = `## Active Plan\n**Original request:** ${plan.request}\n\nYou are executing step ${stepNum} of ${totalSteps}: "${step.description}"\n\n**Plan execution context:** planId="${plan.id}", stepId="${step.id}". When calling POST /api/apps to create an app, you MUST include "planId" and "stepId" in the request body.\n\n`;

    // App environment context — so the executing agent knows what's available
    prompt += getAppEnvironmentContext(db) + '\n\n';

    // Previous step results
    const previousSteps = plan.steps.filter(s => s.seq < step.seq && s.status === 'completed');
    if (previousSteps.length > 0) {
      prompt += 'Previous steps completed:\n';
      for (const prev of previousSteps) {
        const resultSummary = prev.result ? prev.result.substring(0, 800) : 'done';
        prompt += `- Step ${prev.seq}: ${prev.description} — ${resultSummary}\n`;
      }
      prompt += '\n';
    }

    // Completion criteria
    if (step.completion_criteria) {
      prompt += `Completion criteria for this step: ${step.completion_criteria}\n\n`;
    }

    prompt += `When done, end your response with:\n[STEP_COMPLETE: ${step.id}]\nor if you cannot complete:\n[STEP_FAILED: ${step.id}: reason]`;

    return prompt;
  },

  /**
   * Finalize plan status based on step outcomes.
   */
  _finalizePlan(db, planId) {
    const plan = PlanService.getById(db, planId);
    if (!plan || plan.status !== 'executing') return;

    const hasFailures = plan.steps.some(s => s.status === 'failed');
    const allDone = plan.steps.every(s =>
      ['completed', 'failed', 'skipped', 'cancelled'].includes(s.status)
    );

    if (allDone) {
      const finalStatus = hasFailures ? 'failed' : 'completed';
      PlanService.updateStatus(db, planId, finalStatus);
      console.log(`[PlanExecutor] Plan ${planId} finalized as ${finalStatus}`);
    }
  },

  /**
   * Notify step progress callback if registered.
   */
  _notifyStepProgress(planId, stepSeq, totalSteps, description, status) {
    const cb = this._planCallbacks[planId];
    if (cb?.onStepProgress) {
      try { cb.onStepProgress(planId, stepSeq, totalSteps, description, status); } catch {}
    }
  },

  /**
   * Notify completion callback if registered, then clean up.
   */
  _notifyComplete(planId, summary) {
    const cb = this._planCallbacks[planId];
    if (cb?.onComplete) {
      try { cb.onComplete(planId, summary); } catch {}
    }
    delete this._planCallbacks[planId];
  },

  /**
   * Build a contextual completion summary from plan data and step results.
   * Extracts notable outputs (app IDs, URLs, file paths) from step results.
   * @param {object} plan - Plan with hydrated steps
   * @param {number} [durationSec] - Total execution time in seconds
   * @returns {string} Contextual summary text
   */
  buildCompletionSummary(plan, durationSec) {
    if (!plan) return 'Plan execution finished.';

    const steps = plan.steps || [];
    const completed = steps.filter(s => s.status === 'completed');
    const failed = steps.filter(s => s.status === 'failed');
    const skipped = steps.filter(s => s.status === 'skipped');
    const total = steps.length;

    const lines = [];

    // Header with plan summary
    if (plan.status === 'completed') {
      lines.push(`**Plan complete: ${plan.summary}**`);
    } else if (plan.status === 'failed') {
      lines.push(`**Plan finished with errors: ${plan.summary}**`);
    } else {
      lines.push(`**Plan finished: ${plan.summary}**`);
    }

    lines.push('');

    // Step-by-step results
    for (const step of steps) {
      const dur = step.started_at && step.completed_at
        ? ` (${Math.round((new Date(step.completed_at) - new Date(step.started_at)) / 1000)}s)`
        : '';
      const icon = step.status === 'completed' ? '+' : step.status === 'failed' ? 'x' : '-';
      lines.push(`${icon} Step ${step.seq}: ${step.description} — ${step.status}${dur}`);
    }

    lines.push('');

    // Extract notable outputs from completed step results
    const outputs = [];
    for (const step of completed) {
      if (!step.result) continue;
      // Look for app IDs (common pattern in POST /api/apps responses)
      const appIdMatch = step.result.match(/"id"\s*:\s*"([^"]+)"/);
      if (appIdMatch) outputs.push(`App ID: ${appIdMatch[1]}`);
      // Look for app URLs
      const urlMatch = step.result.match(/https?:\/\/localhost:\d+\/[^\s"']+/);
      if (urlMatch) outputs.push(`URL: ${urlMatch[0]}`);
      // Look for file paths in results
      const pathMatch = step.result.match(/\/(?:Users|home)\/[^\s"']+/);
      if (pathMatch) outputs.push(`Path: ${pathMatch[0]}`);
    }

    if (outputs.length > 0) {
      lines.push('**Output:**');
      for (const out of outputs) lines.push(`- ${out}`);
      lines.push('');
    }

    // Footer stats
    const parts = [];
    parts.push(`${completed.length}/${total} steps completed`);
    if (failed.length > 0) parts.push(`${failed.length} failed`);
    if (skipped.length > 0) parts.push(`${skipped.length} skipped`);
    if (durationSec) parts.push(`${durationSec}s total`);
    lines.push(parts.join(' · '));

    return lines.join('\n');
  },

  /**
   * Topological sort of steps based on depends_on (Kahn's algorithm).
   * @param {Array} steps
   * @returns {Array} Steps in execution order
   */
  _topologicalSort(steps) {
    const inDegree = new Map();
    const adjacency = new Map();
    const stepMap = new Map();

    for (const step of steps) {
      stepMap.set(step.id, step);
      inDegree.set(step.id, 0);
      adjacency.set(step.id, []);
    }

    for (const step of steps) {
      const deps = step.depends_on || [];
      // Only count deps that reference steps in this plan
      const validDeps = deps.filter(d => stepMap.has(d));
      inDegree.set(step.id, validDeps.length);
      for (const dep of validDeps) {
        adjacency.get(dep).push(step.id);
      }
    }

    const queue = [];
    for (const [id, degree] of inDegree) {
      if (degree === 0) queue.push(id);
    }

    const result = [];
    while (queue.length > 0) {
      // Pick by seq order among candidates for deterministic ordering
      queue.sort((a, b) => (stepMap.get(a).seq || 0) - (stepMap.get(b).seq || 0));
      const current = queue.shift();
      result.push(stepMap.get(current));

      for (const neighbor of adjacency.get(current)) {
        inDegree.set(neighbor, inDegree.get(neighbor) - 1);
        if (inDegree.get(neighbor) === 0) queue.push(neighbor);
      }
    }

    // If some steps weren't reached (cycle), append them at the end
    if (result.length < steps.length) {
      const included = new Set(result.map(s => s.id));
      for (const step of steps) {
        if (!included.has(step.id)) result.push(step);
      }
    }

    return result;
  }
};

module.exports = { PlanExecutorService, PLAN_STEP_PRIORITY };
