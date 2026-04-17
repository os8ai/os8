/**
 * Plan command interception for message handler endpoints.
 * Delegates plan orchestration to PlanCommandService; handles only
 * channel-specific concerns (SSE emission, conversation entry recording).
 */

const ConversationService = require('../services/conversation');
const PlanCommandService = require('../services/plan-command');
const PlanService = require('../services/plan');
const {
  broadcast,
  RUN_FINISHED,
  TEXT_MESSAGE_CONTENT,
  STATE_SNAPSHOT,
  CUSTOM,
  newRunId,
  newMessageId
} = require('../shared/agui-events');

/**
 * Handle plan commands for the streaming /send endpoint.
 * @param {string} trimmedMsg - Trimmed user message
 * @param {object} opts - { db, assistant, agentName, state, message }
 * @returns {{ handled: boolean, response?: object }}
 */
async function handleSendPlanCommand(trimmedMsg, { db, assistant, agentName, state, message, runId, messageId }) {
  if (!db) return { handled: false };

  const planCmd = PlanCommandService.parseCommand(trimmedMsg);
  if (!planCmd.command) return { handled: false };

  // Fall back to fresh IDs if caller didn't supply them (keeps this function self-contained).
  const effRunId = runId || newRunId();
  const effMessageId = messageId || newMessageId();

  // Map a legacy-shaped payload to its ag-ui equivalent and emit ag-ui only.
  // Callers still construct `{type:'plan'|'done'|'stream', ...}` objects for code clarity;
  // this helper translates them to ag-ui types at the wire boundary.
  const sendSSE = (data) => {
    let aguiType;
    let aguiPayload;
    switch (data.type) {
      case 'plan':
        aguiType = STATE_SNAPSHOT;
        aguiPayload = { snapshot: { plan: data } };
        break;
      case 'done':
        aguiType = RUN_FINISHED;
        aguiPayload = { runId: effRunId, messageId: effMessageId, result: data.text };
        break;
      case 'stream':
        aguiType = TEXT_MESSAGE_CONTENT;
        aguiPayload = { runId: effRunId, messageId: effMessageId, delta: data.text };
        break;
      default:
        aguiType = CUSTOM;
        aguiPayload = { name: data.type, runId: effRunId, value: data };
    }
    broadcast(state.getResponseClients(), aguiType, aguiPayload);
  };

  const recordUserMessage = () => {
    try {
      ConversationService.addEntry(db, assistant.id, {
        type: 'conversation', speaker: 'user', role: 'user',
        channel: 'desktop', content: message
      });
    } catch {}
  };

  const recordAssistantMessage = (text) => {
    try {
      ConversationService.addEntry(db, assistant.id, {
        type: 'conversation', speaker: agentName, role: 'assistant',
        channel: 'desktop', content: text
      });
    } catch {}
  };

  switch (planCmd.command) {
    case 'plan': {
      console.log('[Plan] Intercepted /plan command');
      recordUserMessage();

      try {
        const result = await PlanCommandService.handlePlan(db, { agentId: assistant.id, request: planCmd.argument });

        sendSSE({ type: 'plan', ...result.planSSEData });
        sendSSE({ type: 'done', text: result.displayText });
        recordAssistantMessage(result.displayText);

        return { handled: true, response: { success: true, text: result.displayText } };
      } catch (planErr) {
        console.error('[Plan] Generation error:', planErr);
        const errText = `Plan generation failed: ${planErr.message}`;
        sendSSE({ type: 'done', text: errText });
        return { handled: true, response: { success: true, text: errText } };
      }
    }

    case 'approve': {
      recordUserMessage();
      sendSSE({ type: 'stream', text: 'Plan approved. Starting execution...\n' });

      try {
        const result = await PlanCommandService.handleApprove(db, { agentId: assistant.id });

        if (!result.executionPromise) {
          // No active plan
          sendSSE({ type: 'done', text: result.text });
          return { handled: true, response: { success: true, text: result.text } };
        }

        await result.executionPromise;

        const finalPlan = PlanService.getById(db, result.planId);
        const { PlanExecutorService } = require('../services/plan-executor');
        const summary = PlanExecutorService.buildCompletionSummary(finalPlan);
        recordAssistantMessage(summary);

        return { handled: true, response: { success: true, text: summary } };
      } catch (err) {
        console.error(`[Plan] Execution error:`, err);
        const errText = `Plan execution failed: ${err.message}`;
        sendSSE({ type: 'done', text: errText });
        return { handled: true, response: { success: true, text: errText } };
      }
    }

    case 'cancel': {
      const result = PlanCommandService.handleCancel(db, { agentId: assistant.id });
      sendSSE({ type: 'done', text: result.text });
      return { handled: true, response: { success: true, text: result.text } };
    }

    case 'reject': {
      const result = PlanCommandService.handleReject(db, { agentId: assistant.id });
      sendSSE({ type: 'done', text: result.text });
      return { handled: true, response: { success: true, text: result.text } };
    }

    case 'modify': {
      try {
        const result = await PlanCommandService.handleModify(db, { agentId: assistant.id, modification: planCmd.argument });

        if (!result.plan) {
          // No active plan to modify
          sendSSE({ type: 'done', text: result.displayText });
          return { handled: true, response: { success: true, text: result.displayText } };
        }

        sendSSE({ type: 'plan', ...result.planSSEData });
        sendSSE({ type: 'done', text: result.displayText });

        return { handled: true, response: { success: true, text: result.displayText } };
      } catch (modErr) {
        console.error('[Plan] Modification error:', modErr);
        const errText = `Plan modification failed: ${modErr.message}`;
        sendSSE({ type: 'done', text: errText });
        return { handled: true, response: { success: true, text: errText } };
      }
    }

    default:
      return { handled: false };
  }
}

/**
 * Handle plan commands for the /chat endpoint (simpler — only /plan, returns JSON directly).
 * @param {string} message - Raw user message
 * @param {object} opts - { db, assistant }
 * @returns {{ handled: boolean, response?: object }}
 */
async function handleChatPlanCommand(message, { db, assistant }) {
  if (!db) return { handled: false };

  const planCmd = PlanCommandService.parseCommand(message.trim());
  if (planCmd.command !== 'plan') return { handled: false };

  try {
    const result = await PlanCommandService.handlePlan(db, { agentId: assistant.id, request: planCmd.argument });
    return {
      handled: true,
      response: { type: 'plan', ...result.planSSEData }
    };
  } catch (planErr) {
    console.error('[Plan] Generation error:', planErr);
    return {
      handled: true,
      error: true,
      response: { error: `Plan generation failed: ${planErr.message}` }
    };
  }
}

/**
 * Check if an agent has an active plan (for classification bypass).
 * Delegates to PlanCommandService's shared Map.
 * @param {string} agentId
 * @returns {boolean}
 */
function hasActivePlan(agentId) {
  return PlanCommandService.hasActivePlan(agentId);
}

module.exports = {
  handleSendPlanCommand,
  handleChatPlanCommand,
  hasActivePlan,
  // Expose for backward compatibility (message-handler.js imports this)
  _activePlanByAgent: PlanCommandService._activePlanByAgent
};
