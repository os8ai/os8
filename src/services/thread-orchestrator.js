/**
 * ThreadOrchestrator - Core response engine for group/DM threads
 *
 * Coordinates "message sent → decide who responds → wake agents sequentially" flow.
 * Uses WorkQueue for serialized execution, ModeratorService for group turn-taking.
 */

const path = require('path');
const AgentChatService = require('./agent-chat');
const ModeratorService = require('./moderator');
const AgentService = require('./agent');
const ConversationService = require('./conversation');
const SettingsService = require('./settings');
const { WorkQueue } = require('./work-queue');
const { stripInternalNotes, stripToolCallXml, stripReaction } = require('../utils/internal-notes');
const TelegramService = require('./telegram');
const { readImageAsBase64Compressed } = require('../assistant/identity-images');
const {
  broadcast,
  RUN_STARTED,
  RUN_FINISHED,
  RUN_ERROR,
  MESSAGES_SNAPSHOT,
  CUSTOM,
  newRunId
} = require('../shared/agui-events');

const PRIORITY_THREAD = 75;

// Auto-reset timers for circuit breaker cooldowns: threadId → timeoutId
const _resetTimers = new Map();

const ThreadOrchestrator = {
  db: null,
  getThreadSSEClients: null,

  /**
   * Initialize orchestrator with dependencies
   */
  init({ db, getThreadSSEClients }) {
    this.db = db;
    this.getThreadSSEClients = getThreadSSEClients;
  },

  /**
   * Trigger responses after a message is sent to a thread
   *
   * @param {string} threadId
   * @param {string} senderId - 'user' or agent ID
   * @param {string} senderName
   * @param {boolean} userTriggered - Whether the user sent the message
   */
  async triggerResponses(threadId, senderId, senderName, userTriggered, origin = 'desktop', opts = {}) {
    console.log(`[ThreadOrchestrator] triggerResponses called: thread=${threadId}, sender=${senderId}, userTriggered=${userTriggered}, directMessage=${!!opts.directMessage}`);
    const db = this.db;
    if (!db) { console.log('[ThreadOrchestrator] No db — skipping'); return; }

    const thread = AgentChatService.getThread(db, threadId);
    if (!thread || thread.status !== 'active') {
      console.log(`[ThreadOrchestrator] Thread ${threadId} not active (status=${thread?.status})`);
      return;
    }

    // Check circuit breaker
    const cbLimit = parseInt(SettingsService.get(db, 'agentChatCircuitBreakerLimit') || '50', 10);
    if (!AgentChatService.checkCircuitBreaker(thread, cbLimit)) {
      // If no reset timer is pending, trip the breaker and schedule auto-reset
      if (!_resetTimers.has(threadId)) {
        const cooldownSecs = AgentChatService.tripCircuitBreaker(db, threadId);
        console.log(`[ThreadOrchestrator] Circuit breaker tripped for thread ${threadId}, auto-reset in ${cooldownSecs}s`);

        // Broadcast trip event so UI can show "paused" state
        this._broadcastSSE(
          threadId,
          CUSTOM,
          { name: 'circuit-breaker-tripped', value: { threadId, cooldownSecs } }
        );

        // Notify agents in thread
        const cooldownMins = Math.ceil(cooldownSecs / 60);
        const tripMsg = AgentChatService.sendSystemMessage(db, threadId,
          `Conversation paused — circuit breaker tripped after ${cbLimit} turns. Auto-resuming in ${cooldownMins} minute(s).`
        );
        const tripSystemMsg = { ...tripMsg, sender_app_id: 'system', sender_name: 'System' };
        this._broadcastSSE(
          threadId,
          MESSAGES_SNAPSHOT,
          { threadId, messages: [tripSystemMsg] }
        );

        const timerId = setTimeout(() => {
          _resetTimers.delete(threadId);
          AgentChatService.resetCircuitBreaker(db, threadId);
          this._broadcastSSE(
            threadId,
            CUSTOM,
            { name: 'circuit-breaker-reset', value: { threadId } }
          );
          console.log(`[ThreadOrchestrator] Circuit breaker auto-reset for thread ${threadId}`);

          // Notify and auto-resume
          const resumeMsg = AgentChatService.sendSystemMessage(db, threadId,
            'Conversation resumed after cooldown.'
          );
          const resumeSystemMsg = { ...resumeMsg, sender_app_id: 'system', sender_name: 'System' };
          this._broadcastSSE(
            threadId,
            MESSAGES_SNAPSHOT,
            { threadId, messages: [resumeSystemMsg] }
          );

          // Kick off the next exchange
          const freshThread = AgentChatService.getThread(db, threadId);
          if (freshThread && freshThread.status === 'active') {
            const participants = JSON.parse(freshThread.participants || '[]').filter(id => id !== 'user');
            const lastSpeaker = participants[0]; // pick first participant to seed the exchange
            if (lastSpeaker) {
              this.triggerResponses(threadId, lastSpeaker, '', false);
            }
          }
        }, cooldownSecs * 1000);

        _resetTimers.set(threadId, timerId);
      }
      console.log(`[ThreadOrchestrator] Circuit breaker active for thread ${threadId} (turn_count=${thread.turn_count}, limit=${cbLimit})`);
      return;
    }

    const participants = JSON.parse(thread.participants || '[]');

    // Resolve participant agents (exclude agents with visibility='off')
    const agents = participants
      .filter(id => id !== 'user')
      .map(id => AgentService.getById(db, id))
      .filter(a => a && (a.visibility || 'visible') !== 'off');

    let speakerList = [];

    if (thread.type === 'dm' && !userTriggered) {
      // DM thread, agent-initiated turn
      const hasUser = participants.includes('user');

      if (hasUser) {
        // User-involved DM: no auto-continue (user drives the conversation)
        // speakerList stays empty — wait for user
      } else if (opts.directMessage) {
        // Agent explicitly sent a DM — recipient always responds (no moderator)
        const otherAgent = agents.find(a => a.id !== senderId);
        if (otherAgent) {
          speakerList = [{ agentId: otherAgent.id, agentName: otherAgent.name, focusHint: '' }];
        }
      } else {
        // Auto-continue after agent responded — moderator decides whether to continue
        const recentMessages = AgentChatService.getMessages(db, threadId, 15);
        speakerList = await ModeratorService.decideNextSpeakers(
          db, thread, recentMessages, agents, { isFollowUp: true, agentOnly: true }
        );
      }
    } else if (thread.type === 'dm' && userTriggered) {
      // DM thread, user sent a message — all agents should respond (shuffled order)
      speakerList = agents
        .filter(a => a.id !== senderId)
        .map(a => ({ agentId: a.id, agentName: a.name, focusHint: '' }));
      for (let i = speakerList.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [speakerList[i], speakerList[j]] = [speakerList[j], speakerList[i]];
      }
    } else {
      // Group (3+): use moderator to decide speakers
      const recentMessages = AgentChatService.getMessages(db, threadId, 15);

      const userName = SettingsService.get(db, 'user_first_name') || '';
      speakerList = await ModeratorService.decideNextSpeakers(
        db, thread, recentMessages, agents, { isFollowUp: !userTriggered, userName }
      );
    }

    // Safety net: if user sent a message and moderator returned empty,
    // fall back to all agents in shuffled order — the user clearly expects a response
    if (speakerList.length === 0 && userTriggered) {
      console.log(`[ThreadOrchestrator] Moderator returned empty speakers for user message — falling back to all agents`);
      speakerList = agents
        .filter(a => a.id !== senderId)
        .map(a => ({ agentId: a.id, agentName: a.name, focusHint: '' }));
      // Fisher-Yates shuffle so fallback order varies
      for (let i = speakerList.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [speakerList[i], speakerList[j]] = [speakerList[j], speakerList[i]];
      }
    }

    if (speakerList.length === 0) {
      console.log(`[ThreadOrchestrator] No speakers selected for thread ${threadId}`);
      return;
    }

    console.log(`[ThreadOrchestrator] Selected speakers for thread ${threadId}: ${speakerList.map(s => s.agentName).join(', ')}`);


    // Get daily limit
    const dailyLimit = parseInt(SettingsService.get(db, 'agentChatDailyLimit') || '20', 10);

    // Enqueue each speaker sequentially
    for (const speaker of speakerList) {
      // Check budget for agent-initiated messages
      if (!userTriggered && !AgentChatService.checkDailyBudget(db, speaker.agentId, dailyLimit)) {
        console.log(`[ThreadOrchestrator] Agent ${speaker.agentName} hit daily budget limit`);
        continue;
      }

      this.enqueueAgentResponse(thread, speaker.agentId, speaker.focusHint, userTriggered, origin);
    }
  },

  /**
   * Enqueue an agent response into the work queue
   */
  enqueueAgentResponse(thread, agentId, focusHint, userTriggered, origin = 'desktop') {
    WorkQueue.enqueue({
      type: 'thread',
      priority: PRIORITY_THREAD,
      payload: {
        threadId: thread.id,
        agentId,
        focusHint,
        userTriggered,
        origin
      },
      createdAt: Date.now()
    });
  },

  /**
   * Execute a thread response — called by WorkQueue
   *
   * Spawns the agent backend, stores the response, triggers follow-up responses.
   */
  async executeThreadResponse(payload) {
    const { threadId, agentId, focusHint, userTriggered, origin } = payload;
    const db = this.db;
    if (!db) throw new Error('ThreadOrchestrator not initialized');

    const thread = AgentChatService.getThread(db, threadId);
    if (!thread || thread.status !== 'active') return;

    const agent = AgentService.getById(db, agentId);
    if (!agent) {
      console.error(`[ThreadOrchestrator] Agent ${agentId} not found`);
      return;
    }

    // Run lifecycle: one runId per agent-turn, reused across working/done/error events below
    const runId = newRunId();

    // Broadcast "working" event (desktop only — Telegram responses stay in Telegram)
    if (origin !== 'telegram') {
      this._broadcastSSE(
        threadId,
        RUN_STARTED,
        { runId, threadId, agentId, agentName: agent.name }
      );
    }

    try {
      // Build thread context for the agent
      const recentMessages = AgentChatService.getMessages(db, threadId, 20);
      const userName = SettingsService.get(db, 'user_first_name') || '';
      const threadContext = this._buildThreadPrompt(thread, recentMessages, agent, focusHint, userName);

      // Collect image attachments from recent messages for vision-capable agents
      const threadAttachments = await this._collectThreadAttachments(db, recentMessages);

      // Spawn agent directly via WorkQueue's spawnClaudeForJob (reuses full identity/memory pipeline).
      // Thread-specific options:
      // - skipSemanticSearch: avoid O(N) embedding search over thousands of chunks blocking the event loop
      //   (agents with large histories can have thousands of chunks — synchronous cosine similarity freezes the Electron process)
      // - taskType: 'conversation' (threads are conversational, not jobs — uses correct cascade + agent overrides)
      const participants = JSON.parse(thread.participants || '[]');
      const result = await WorkQueue.spawnClaudeForJob(agentId, threadContext, {
        skipSemanticSearch: true,
        taskType: 'conversation',
        threadParticipantIds: participants,
        threadAttachments
      });

      let responseText = result?.text || result || '';

      // Strip internal notes, tool call XML, and reaction tags
      responseText = stripInternalNotes(responseText);
      responseText = stripToolCallXml(responseText);
      responseText = stripReaction(responseText);

      if (!responseText.trim()) {
        console.warn(`[ThreadOrchestrator] Empty response from ${agent.name}`);
        if (origin !== 'telegram') {
          this._broadcastSSE(
            threadId,
            RUN_FINISHED,
            { runId, threadId, agentId, agentName: agent.name, result: '' }
          );
        }
        return;
      }

      // Store message in agent_messages (canonical store)
      const triggeredBy = userTriggered ? 'user' : 'agent';
      const msg = AgentChatService.sendMessage(db, threadId, agentId, agent.name, responseText, 'chat', triggeredBy);

      // Also store in conversation_entries for agent's long-term memory
      try {
        ConversationService.addEntry(db, agentId, {
          type: 'conversation',
          speaker: agent.name.toLowerCase(),
          role: 'assistant',
          channel: 'thread',
          content: responseText,
          metadata: { threadId, threadName: thread.name || null }
        });
      } catch (convErr) {
        console.warn(`[ThreadOrchestrator] Failed to record to conversation_entries:`, convErr.message);
      }

      // Record budget usage
      AgentChatService.recordBudgetUsage(db, agentId, threadId, triggeredBy);

      // Broadcast the message to desktop (skip for Telegram-origin responses)
      if (origin !== 'telegram') {
        const threadMsg = {
          id: msg.id,
          thread_id: threadId,
          sender_app_id: agentId,
          sender_name: agent.name,
          content: responseText,
          message_type: 'chat',
          triggered_by: triggeredBy,
          timestamp: msg.timestamp
        };
        this._broadcastSSE(
          threadId,
          MESSAGES_SNAPSHOT,
          { threadId, messages: [threadMsg] }
        );

        this._broadcastSSE(
          threadId,
          RUN_FINISHED,
          { runId, threadId, agentId, agentName: agent.name, result: responseText }
        );
      }

      // If this thread is linked to a Telegram group, send the response there
      // Only mirror to Telegram when the conversation originated from Telegram
      if (origin === 'telegram') {
        try {
          const tgGroup = db.prepare(
            'SELECT telegram_chat_id FROM telegram_groups WHERE thread_id = ?'
          ).get(threadId);
          if (tgGroup) {
            const agentRecord = AgentService.getById(db, agentId);
            if (agentRecord?.telegram_bot_token) {
              await TelegramService.send(agentRecord.telegram_bot_token, tgGroup.telegram_chat_id, responseText);
            }
          }
        } catch (tgErr) {
          console.warn(`[ThreadOrchestrator] Failed to send to Telegram group:`, tgErr.message);
        }
      }

      // Read circuit breaker limit for auto-continue checks
      const cbLimit = parseInt(SettingsService.get(db, 'agentChatCircuitBreakerLimit') || '50', 10);

      // Auto-continue group threads: re-evaluate after the last queued agent finishes
      if (thread.type === 'group' && !WorkQueue.hasPendingForThread(threadId)) {
        const freshThread = AgentChatService.getThread(db, threadId);
        if (freshThread && AgentChatService.checkCircuitBreaker(freshThread, cbLimit)) {
          console.log(`[ThreadOrchestrator] Group thread ${threadId}: last agent done, scheduling moderator re-evaluation`);
          setTimeout(() => {
            this.triggerResponses(threadId, agentId, agent.name, false, origin);
          }, 2000);
        } else if (freshThread) {
          // Breaker limit reached — call triggerResponses to trip it properly
          setTimeout(() => {
            this.triggerResponses(threadId, agentId, agent.name, false, origin);
          }, 100);
        }
      }

      // Auto-continue DM conversations.
      // Uses setTimeout so the current queue task finishes first (avoids deadlock).
      if (thread.type === 'dm') {
        const freshDmThread = AgentChatService.getThread(db, threadId);
        const dmParticipants = JSON.parse(freshDmThread?.participants || '[]');
        const dmHasUser = dmParticipants.includes('user');

        if (dmHasUser) {
          // User-involved DM: no auto-continue (user drives the conversation)
        } else {
          // Agent-to-agent DM: re-evaluate via moderator (same pattern as group threads)
          if (freshDmThread && AgentChatService.checkCircuitBreaker(freshDmThread, cbLimit)) {
            console.log(`[ThreadOrchestrator] Agent-to-agent DM ${threadId}: scheduling moderator re-evaluation`);
            setTimeout(() => {
              this.triggerResponses(threadId, agentId, agent.name, false, origin);
            }, 2000);
          } else if (freshDmThread) {
            // Breaker limit reached — call triggerResponses to trip it properly
            setTimeout(() => {
              this.triggerResponses(threadId, agentId, agent.name, false, origin);
            }, 100);
          }
        }
      }

    } catch (err) {
      console.error(`[ThreadOrchestrator] Error executing response for ${agent.name}:`, err.message);
      if (origin !== 'telegram') {
        this._broadcastSSE(
          threadId,
          RUN_ERROR,
          { runId, threadId, agentId, agentName: agent.name, message: err.message }
        );
        // Always clear spinner on error
        this._broadcastSSE(
          threadId,
          RUN_FINISHED,
          { runId, threadId, agentId, agentName: agent.name, status: 'error' }
        );
      }
    }
  },

  /**
   * Build the thread prompt for an agent
   */
  _buildThreadPrompt(thread, messages, agent, focusHint, userName) {
    const threadType = thread.type === 'group' ? 'Group Thread' : 'DM Thread';
    const threadLabel = thread.name ? ` "${thread.name}"` : '';
    const userLabel = userName || 'User';

    let prompt = `[Thread Response Required]\n\n`;
    prompt += `You are responding in a ${threadType}${threadLabel}.\n`;

    if (focusHint) {
      prompt += `Focus on: ${focusHint}\n`;
    }

    prompt += `\nRecent conversation:\n`;
    for (const msg of messages) {
      const label = msg.sender_app_id === 'user' ? userLabel : msg.sender_name;
      prompt += `${label}: ${msg.content}\n`;
      // Include attachment references in the text prompt
      if (msg.metadata) {
        try {
          const meta = typeof msg.metadata === 'string' ? JSON.parse(msg.metadata) : msg.metadata;
          if (meta.attachments?.length > 0) {
            for (const att of meta.attachments) {
              if (att.mimeType?.startsWith('image/')) {
                prompt += `  [Image attached: ${att.filename}]\n`;
              } else {
                prompt += `  [File attached: ${att.filename} (${att.mimeType})]\n`;
              }
            }
          }
        } catch { /* ignore parse errors */ }
      }
    }

    prompt += `\nRespond naturally as ${agent.name}. Keep your response conversational and relevant.`;
    prompt += ` Do not prefix your response with your name.`;

    return prompt;
  },

  /**
   * Collect image attachments from recent thread messages for agent vision.
   * Returns array in the format expected by buildStreamJsonMessage: { data, mediaType, filename }
   * Limits to last 5 messages with images to keep context reasonable.
   */
  async _collectThreadAttachments(db, recentMessages) {
    const attachments = [];
    const defaultAgent = AgentService.getDefault(db);
    if (!defaultAgent) return attachments;

    const { agentBlobDir } = AgentService.getPaths(defaultAgent.app_id, defaultAgent.id);
    const MAX_IMAGE_MESSAGES = 5;
    let imageCount = 0;

    // Walk messages newest-first to get the most recent images
    for (let i = recentMessages.length - 1; i >= 0 && imageCount < MAX_IMAGE_MESSAGES; i--) {
      const msg = recentMessages[i];
      if (!msg.metadata) continue;
      try {
        const meta = typeof msg.metadata === 'string' ? JSON.parse(msg.metadata) : msg.metadata;
        if (!meta.attachments?.length) continue;

        for (const att of meta.attachments) {
          if (!att.mimeType?.startsWith('image/') || imageCount >= MAX_IMAGE_MESSAGES) continue;
          const fullPath = path.join(agentBlobDir, 'chat-attachments', att.filename);
          const imageResult = await readImageAsBase64Compressed(fullPath);
          if (imageResult) {
            attachments.push({ ...imageResult, filename: att.filename });
            imageCount++;
          }
        }
      } catch { /* ignore parse errors */ }
    }

    if (attachments.length > 0) {
      console.log(`[ThreadOrchestrator] Collected ${attachments.length} image attachment(s) for agent vision`);
    }
    return attachments;
  },

  /**
   * Recover threads with expired circuit breaker cooldowns (e.g., after crash/restart).
   * Resets turn_count, notifies, and resumes conversation.
   */
  recoverExpiredBreakers() {
    const db = this.db;
    if (!db) return;

    const cbLimit = parseInt(SettingsService.get(db, 'agentChatCircuitBreakerLimit') || '50', 10);
    if (cbLimit === 0) return;

    const threads = AgentChatService.getExpiredBreakerThreads(db, cbLimit);
    const now = Date.now();

    for (const thread of threads) {
      if (!thread.breaker_last_tripped) continue;
      if (_resetTimers.has(thread.id)) continue;

      const cooldown = thread.breaker_cooldown || 60;
      const trippedAt = new Date(thread.breaker_last_tripped).getTime();
      const expiresAt = trippedAt + cooldown * 1000;

      if (now >= expiresAt) {
        // Already expired — reset immediately
        console.log(`[ThreadOrchestrator] Recovering expired breaker for thread ${thread.id} (tripped ${thread.breaker_last_tripped})`);
        AgentChatService.resetCircuitBreaker(db, thread.id);

        const resumeMsg = AgentChatService.sendSystemMessage(db, thread.id,
          'Conversation resumed after cooldown (recovered on restart).'
        );
        const resumeSystemMsg = { ...resumeMsg, sender_app_id: 'system', sender_name: 'System' };
        this._broadcastSSE(
          thread.id,
          CUSTOM,
          { name: 'circuit-breaker-reset', value: { threadId: thread.id } }
        );
        this._broadcastSSE(
          thread.id,
          MESSAGES_SNAPSHOT,
          { threadId: thread.id, messages: [resumeSystemMsg] }
        );

        // Resume conversation
        const participants = JSON.parse(thread.participants || '[]').filter(id => id !== 'user');
        const lastSpeaker = participants[0];
        if (lastSpeaker) {
          this.triggerResponses(thread.id, lastSpeaker, '', false);
        }
      } else {
        // Not yet expired — schedule a timer for remaining time
        const remainingMs = expiresAt - now;
        const remainingSecs = Math.ceil(remainingMs / 1000);
        console.log(`[ThreadOrchestrator] Scheduling breaker reset for thread ${thread.id} in ${remainingSecs}s`);

        const timerId = setTimeout(() => {
          _resetTimers.delete(thread.id);
          AgentChatService.resetCircuitBreaker(db, thread.id);
          this._broadcastSSE(
            thread.id,
            CUSTOM,
            { name: 'circuit-breaker-reset', value: { threadId: thread.id } }
          );
          console.log(`[ThreadOrchestrator] Circuit breaker auto-reset for thread ${thread.id} (recovered)`);

          const resumeMsg = AgentChatService.sendSystemMessage(db, thread.id,
            'Conversation resumed after cooldown.'
          );
          const recoveredResumeSystemMsg = { ...resumeMsg, sender_app_id: 'system', sender_name: 'System' };
          this._broadcastSSE(
            thread.id,
            MESSAGES_SNAPSHOT,
            { threadId: thread.id, messages: [recoveredResumeSystemMsg] }
          );

          // Resume conversation
          const freshThread = AgentChatService.getThread(db, thread.id);
          if (freshThread && freshThread.status === 'active') {
            const participants = JSON.parse(freshThread.participants || '[]').filter(id => id !== 'user');
            const lastSpeaker = participants[0];
            if (lastSpeaker) {
              this.triggerResponses(thread.id, lastSpeaker, '', false);
            }
          }
        }, remainingMs);

        _resetTimers.set(thread.id, timerId);
      }
    }
  },

  /**
   * Broadcast an ag-ui SSE event to thread clients.
   */
  _broadcastSSE(threadId, aguiType, aguiPayload) {
    if (!this.getThreadSSEClients) return;
    const clients = this.getThreadSSEClients(threadId);
    if (!clients || clients.size === 0) return;
    broadcast(clients, aguiType, aguiPayload);
  }
};

module.exports = { ThreadOrchestrator, PRIORITY_THREAD };
