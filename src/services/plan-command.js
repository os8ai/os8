/**
 * PlanCommandService — Plan command parsing and orchestration
 *
 * Owns the parse-and-dispatch logic for plan commands (/plan, /approve,
 * /cancel, /reject, /modify) regardless of channel (group thread, DM,
 * Telegram). Channel-agnostic: returns structured data, callers handle
 * SSE/thread/conversation concerns.
 *
 * Single _activePlanByAgent Map shared across all channels.
 */

const PlanService = require('./plan');
const { buildPlanningPrompt, planWithModel, extractJson } = require('./plan-generator');
const AgentService = require('./agent');
const { CapabilityService } = require('./capability');

// Single source of truth for active draft plan per agent (in-memory, lost on restart)
const _activePlanByAgent = new Map();

/**
 * Parse a message for plan commands.
 * @param {string} content - Trimmed message content
 * @returns {{ command: string|null, argument: string|null }}
 */
function parseCommand(content) {
  if (content.startsWith('/plan ')) {
    return { command: 'plan', argument: content.substring(6).trim() };
  }
  if (content === '/approve') {
    return { command: 'approve', argument: null };
  }
  if (content === '/cancel') {
    return { command: 'cancel', argument: null };
  }
  if (content === '/reject') {
    return { command: 'reject', argument: null };
  }
  if (content.startsWith('/modify ')) {
    return { command: 'modify', argument: content.substring(8).trim() };
  }
  return { command: null, argument: null };
}

/**
 * Generate a new plan via LLM.
 * @param {object} db
 * @param {{ agentId: string, request: string }} opts
 * @returns {Promise<{ plan: object, displayText: string, planSSEData: object }>}
 */
async function handlePlan(db, { agentId, request }) {
  console.log('[Plan] Request:', request);

  const agents = AgentService.getOperational ? AgentService.getOperational(db) : [];
  let capabilities = [];
  try {
    capabilities = CapabilityService.getForContext
      ? await CapabilityService.getForContext(db, agentId, request)
      : [];
  } catch (capErr) {
    console.warn('[Plan] Capabilities fetch error (non-fatal):', capErr.message);
  }

  const prompt = buildPlanningPrompt(request, agents, capabilities, {}, db);
  console.log('[Plan] Calling LLM for plan generation...');
  const result = await planWithModel(db, prompt);
  console.log('[Plan] LLM response received, extracting JSON...');

  const planData = extractJson(result.text);
  const plan = PlanService.create(db, {
    agentId,
    request,
    summary: planData.summary,
    steps: planData.steps || []
  });
  console.log('[Plan] Plan created:', plan.id, '-', plan.summary);

  _activePlanByAgent.set(agentId, plan.id);

  const displayText = `**Plan: ${plan.summary}**\n\n${plan.steps.map((s, i) =>
    `${i + 1}. ${s.description}`
  ).join('\n')}\n\n**Approve:** /approve\n**Modify:** /modify [your changes]\n**Cancel:** /cancel`;

  const planSSEData = {
    planId: plan.id,
    summary: plan.summary,
    steps: plan.steps.map(s => ({
      id: s.id,
      description: s.description,
      agent: s.agent_id === agentId ? 'self' : s.agent_id,
      depends_on: s.depends_on
    })),
    actions: ['approve', 'edit', 'reject']
  };

  return { plan, displayText, planSSEData };
}

/**
 * Approve the active draft plan and start execution.
 * @param {object} db
 * @param {{ agentId: string, onStepProgress?: Function, onComplete?: Function }} opts
 *   - onStepProgress(planId, stepSeq, totalSteps, description, status)
 *   - onComplete(planId, summary)
 * @returns {Promise<{ planId: string, text: string, executionPromise: Promise }>}
 */
async function handleApprove(db, { agentId, onStepProgress, onComplete }) {
  const planId = _activePlanByAgent.get(agentId);
  const plan = planId ? PlanService.getById(db, planId) : null;

  if (!plan || plan.status !== 'draft') {
    return { planId: null, text: 'No active plan to approve. Create one with `/plan [request]`.' };
  }

  console.log('[Plan] Approving plan:', planId);
  const { PlanExecutorService } = require('./plan-executor');
  PlanService.updateStatus(db, planId, 'approved');
  _activePlanByAgent.delete(agentId);

  const executionPromise = PlanExecutorService.execute(db, planId, {
    onStepProgress,
    onComplete
  });

  return { planId, text: 'Plan approved. Starting execution...', executionPromise };
}

/**
 * Cancel or reject the active plan.
 * @param {object} db
 * @param {{ agentId: string }} opts
 * @returns {{ cancelled: boolean, text: string }}
 */
function handleCancel(db, { agentId }) {
  const planId = _activePlanByAgent.get(agentId);
  const plan = planId ? PlanService.getById(db, planId) : null;

  if (!plan) {
    return { cancelled: false, text: 'No active plan to cancel.' };
  }

  console.log('[Plan] Cancelling plan:', planId);
  if (plan.status === 'draft') {
    PlanService.updateStatus(db, planId, 'rejected');
  } else if (plan.status === 'executing') {
    const { PlanExecutorService } = require('./plan-executor');
    PlanExecutorService.cancel(db, planId);
  }
  _activePlanByAgent.delete(agentId);

  return { cancelled: true, text: 'Plan cancelled.' };
}

/**
 * Reject the active draft plan.
 * @param {object} db
 * @param {{ agentId: string }} opts
 * @returns {{ rejected: boolean, text: string }}
 */
function handleReject(db, { agentId }) {
  const planId = _activePlanByAgent.get(agentId);
  const plan = planId ? PlanService.getById(db, planId) : null;

  if (!plan || plan.status !== 'draft') {
    return { rejected: false, text: 'No active plan to reject.' };
  }

  console.log('[Plan] Rejecting plan:', planId);
  PlanService.updateStatus(db, planId, 'rejected');
  _activePlanByAgent.delete(agentId);

  return { rejected: true, text: 'Plan rejected.' };
}

/**
 * Modify the active draft plan by re-generating with appended modifications.
 * @param {object} db
 * @param {{ agentId: string, modification: string }} opts
 * @returns {Promise<{ plan: object, displayText: string, planSSEData: object }>}
 */
async function handleModify(db, { agentId, modification }) {
  const planId = _activePlanByAgent.get(agentId);
  const plan = planId ? PlanService.getById(db, planId) : null;

  if (!plan || plan.status !== 'draft') {
    return { plan: null, displayText: 'No active plan to modify. Create one with `/plan [request]`.' };
  }

  console.log('[Plan] Modifying plan:', planId);
  const originalRequest = plan.request;
  PlanService.delete(db, planId);
  _activePlanByAgent.delete(agentId);

  const modifiedRequest = `${originalRequest}\n\nModification: ${modification}`;
  return handlePlan(db, { agentId, request: modifiedRequest });
}

/**
 * Check if an agent has an active draft plan tracked in memory.
 * @param {string} agentId
 * @returns {boolean}
 */
function hasActivePlan(agentId) {
  return _activePlanByAgent.has(agentId);
}

/**
 * Get the active plan ID for an agent, or null.
 * @param {string} agentId
 * @returns {string|null}
 */
function getActivePlanId(agentId) {
  return _activePlanByAgent.get(agentId) || null;
}

const PlanCommandService = {
  parseCommand,
  handlePlan,
  handleApprove,
  handleCancel,
  handleReject,
  handleModify,
  hasActivePlan,
  getActivePlanId,
  _activePlanByAgent
};

module.exports = PlanCommandService;
