/**
 * Agent-to-agent messaging routes
 *
 * POST   /api/agent-chat/dm                   — Send DM between agents
 * POST   /api/agent-chat/groups               — Create group thread
 * GET    /api/agent-chat/threads               — List threads
 * GET    /api/agent-chat/threads/:id           — Get thread + messages
 * PATCH  /api/agent-chat/threads/:id           — Update thread (name, participants)
 * DELETE /api/agent-chat/threads/:id           — Archive thread
 * POST   /api/agent-chat/threads/:id/send      — Send to thread (from user)
 * POST   /api/agent-chat/threads/:id/upload    — Upload file attachment
 * DELETE /api/agent-chat/threads/:id/messages  — Clear all messages in thread
 * POST   /api/agent-chat/threads/:id/reset     — Reset circuit breaker
 * GET    /api/agent-chat/threads/:id/stream    — SSE for real-time messages
 * GET    /api/agent-chat/budget                — Daily budget status
 * GET    /api/agent-chat/agents                — List active agents
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const PlanCommandService = require('../services/plan-command');
const ConversationService = require('../services/conversation');
const AccountService = require('../services/account');
const {
  broadcast,
  emit,
  MESSAGES_SNAPSHOT,
  STATE_SNAPSHOT,
  CUSTOM
} = require('../shared/agui-events');

// Module-level SSE client tracking: Map<threadId, Set<res>>
const threadSSEClients = new Map();

function getThreadSSEClients(threadId) {
  return threadSSEClients.get(threadId);
}

function createAgentChatRouter(db, deps) {
  const { AgentChatService, AgentService, ThreadOrchestrator, SettingsService } = deps;
  const router = express.Router();

  /**
   * POST /dm — Agent sends a DM to another agent
   * Body: { from: "agentA" | appId, to: "agentB" | appId, message: "..." }
   */
  router.post('/dm', async (req, res) => {
    try {
      const { from, to, message } = req.body;
      if (!from || !to || !message) {
        return res.status(400).json({ error: 'Missing required fields: from, to, message' });
      }

      // Resolve sender
      const sender = AgentChatService.resolveAgentName(db, from)
        || AgentService.getById(db, from);
      if (!sender) {
        return res.status(404).json({ error: `Agent not found: ${from}` });
      }

      // Resolve recipient
      const recipient = AgentChatService.resolveAgentName(db, to)
        || AgentService.getById(db, to);
      if (!recipient) {
        return res.status(404).json({ error: `Agent not found: ${to}` });
      }

      // Find or create DM thread
      const thread = AgentChatService.findOrCreateDM(db, sender.id, recipient.id);

      // Check circuit breaker
      const cbLimit = parseInt(SettingsService.get(db, 'agentChatCircuitBreakerLimit') || '50', 10);
      if (!AgentChatService.checkCircuitBreaker(thread, cbLimit)) {
        const cooldown = thread.breaker_cooldown || 60;
        return res.status(429).json({
          error: `Conversation temporarily paused after ${cbLimit} turns. Will auto-resume in ${Math.ceil(cooldown / 60)} minute(s).`,
          threadId: thread.id,
          turnCount: thread.turn_count
        });
      }

      // Store message
      const msg = AgentChatService.sendMessage(db, thread.id, sender.id, sender.name, message);

      // Broadcast SSE
      const dmMsg = { ...msg, sender_name: sender.name };
      broadcastToThread(
        thread.id,
        MESSAGES_SNAPSHOT,
        { threadId: thread.id, messages: [dmMsg] }
      );

      // Trigger response from recipient via orchestrator
      if (ThreadOrchestrator) {
        ThreadOrchestrator.triggerResponses(thread.id, sender.id, sender.name, false, 'desktop', { directMessage: true })
          .catch(err => console.error('[AgentChat] triggerResponses error:', err));
      }

      // Also broadcast to agent SSE clients
      try {
        const { getAgentState } = deps;
        const state = getAgentState ? getAgentState(recipient.id) : null;
        if (state && state.sseClients) {
          state.sseClients.forEach(client => {
            emit(
              client,
              CUSTOM,
              { name: 'agent-dm', value: { threadId: thread.id, from: sender.name, message } }
            );
          });
        }
      } catch (e) {
        // SSE broadcast is best-effort
      }

      res.json({
        success: true,
        threadId: thread.id,
        messageId: msg.id,
        turnCount: thread.turn_count + 1
      });
    } catch (err) {
      console.error('Agent DM error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /groups — Create a group thread
   * Body: { name: "Planning Session", participantIds: ["id1", "id2", "id3"], moderatorModel?: "haiku" }
   */
  router.post('/groups', (req, res) => {
    try {
      const { name, participantIds } = req.body;
      if (!name || !participantIds || participantIds.length < 2) {
        return res.status(400).json({ error: 'Name and at least 2 participants required' });
      }

      // Validate all participant IDs exist
      for (const id of participantIds) {
        if (id !== 'user' && !AgentService.getById(db, id)) {
          return res.status(404).json({ error: `Agent not found: ${id}` });
        }
      }

      // Always include 'user' as a participant
      const allParticipants = participantIds.includes('user')
        ? participantIds
        : ['user', ...participantIds];

      const thread = AgentChatService.createGroup(db, {
        name,
        participantIds: allParticipants,
        creatorId: 'user'
      });

      // Enrich with participantDetails (voice IDs, gender) so client has them immediately
      const participantDetails = allParticipants.map(id => {
        if (id === 'user') {
          const acct = AccountService.getAccount(db);
          return { id: 'user', name: acct?.display_name || acct?.username || 'User' };
        }
        const agent = AgentService.getById(db, id);
        return agent ? { id: agent.id, name: agent.name, color: agent.color, voiceId: agent.voice_id, gender: agent.gender } : { id, name: 'Unknown' };
      });

      // Add system message
      AgentChatService.sendMessage(db, thread.id, 'user', 'System',
        `Group "${name}" created.`, 'system', 'user');

      res.json({ success: true, thread: { ...thread, participantDetails } });
    } catch (err) {
      console.error('Group creation error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /threads — List all threads
   * Query: ?agent=agentId — filter by participant
   */
  router.get('/threads', (req, res) => {
    try {
      const threads = AgentChatService.getThreads(db, req.query.agent);
      // Enrich with participant names
      const enriched = threads.map(t => {
        let participants = JSON.parse(t.participants);
        if (typeof participants === 'string') participants = JSON.parse(participants);
        const names = participants.map(id => {
          if (id === 'user') {
            const acct = AccountService.getAccount(db);
            return { id: 'user', name: acct?.display_name || acct?.username || 'User' };
          }
          const agent = AgentService.getById(db, id);
          return agent ? { id: agent.id, name: agent.name, color: agent.color, voiceId: agent.voice_id, gender: agent.gender } : { id, name: 'Unknown' };
        });
        console.log(`[VOICE DEBUG] Thread ${t.id} participants:`, names.map(n => `${n.name}(voiceId=${n.voiceId || 'null'})`).join(', '));
        // Get last message preview
        const lastMsg = AgentChatService.getMessages(db, t.id, 1);
        return {
          ...t,
          participantDetails: names,
          lastMessage: lastMsg[0] || null
        };
      });
      res.json(enriched);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /threads/:id — Get thread with messages
   * Query: ?limit=50
   */
  router.get('/threads/:id', (req, res) => {
    try {
      const thread = AgentChatService.getThread(db, req.params.id);
      if (!thread) return res.status(404).json({ error: 'Thread not found' });

      const limit = parseInt(req.query.limit) || 50;
      const messages = AgentChatService.getMessages(db, thread.id, limit);
      let parsedParticipants = JSON.parse(thread.participants);
      if (typeof parsedParticipants === 'string') parsedParticipants = JSON.parse(parsedParticipants);
      const participants = parsedParticipants.map(id => {
        if (id === 'user') {
            const acct = AccountService.getAccount(db);
            return { id: 'user', name: acct?.display_name || acct?.username || 'User' };
          }
        const agent = AgentService.getById(db, id);
        return agent ? { id: agent.id, name: agent.name, color: agent.color, voiceId: agent.voice_id, gender: agent.gender } : { id, name: 'Unknown' };
      });

      res.json({ ...thread, participantDetails: participants, messages });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * PATCH /threads/:id — Update thread
   * Body: { name?, participants?, moderator_model? }
   */
  router.patch('/threads/:id', (req, res) => {
    try {
      const thread = AgentChatService.getThread(db, req.params.id);
      if (!thread) return res.status(404).json({ error: 'Thread not found' });

      const updated = AgentChatService.updateThread(db, req.params.id, req.body);
      res.json({ success: true, thread: updated });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * DELETE /threads/:id — Archive thread
   */
  router.delete('/threads/:id', (req, res) => {
    try {
      const thread = AgentChatService.getThread(db, req.params.id);
      if (!thread) return res.status(404).json({ error: 'Thread not found' });

      AgentChatService.archiveThread(db, req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /threads/:id/upload — Upload file attachment for thread
   */
  const threadUploadStorage = multer.diskStorage({
    destination: (req, file, cb) => {
      const defaultAgent = AgentService.getDefault(db);
      if (!defaultAgent) return cb(new Error('No default agent'));
      const { agentBlobDir } = AgentService.getPaths(defaultAgent.app_id, defaultAgent.id);
      const dir = path.join(agentBlobDir, 'chat-attachments');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      cb(null, `${Date.now()}-${file.originalname}`);
    }
  });
  const threadUpload = multer({ storage: threadUploadStorage, limits: { fileSize: 20 * 1024 * 1024 } });

  router.post('/threads/:id/upload', threadUpload.single('file'), (req, res) => {
    try {
      const thread = AgentChatService.getThread(db, req.params.id);
      if (!thread) return res.status(404).json({ error: 'Thread not found' });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      const filename = req.file.filename;
      const mimeType = req.file.mimetype;
      res.json({
        filename,
        url: `/blob/chat-attachments/${filename}`,
        mimeType,
        size: req.file.size
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /threads/:id/send — Send message to thread (from user/UI)
   * Body: { message: "...", senderName?: "User", attachments?: [...] }
   */
  router.post('/threads/:id/send', async (req, res) => {
    try {
      const thread = AgentChatService.getThread(db, req.params.id);
      if (!thread) return res.status(404).json({ error: 'Thread not found' });

      const { message, senderName = 'User', attachments } = req.body;
      if (!message && (!attachments || attachments.length === 0)) {
        return res.status(400).json({ error: 'Missing message or attachments' });
      }

      const displayMessage = message || '[Attached files]';
      const metadata = attachments?.length > 0 ? JSON.stringify({ attachments }) : null;
      const msg = AgentChatService.sendMessage(db, thread.id, 'user', senderName, displayMessage, 'chat', 'user', metadata);

      // Store user message in conversation_entries for each agent's memory
      const participants = JSON.parse(thread.participants || '[]');
      const account = AccountService.getAccount(db);
      const userName = account?.display_name || account?.username || 'User';
      const speakerLabel = `${userName.toLowerCase()} (user)`;

      // Build memory content with attachment references
      let memoryContent = displayMessage;
      if (attachments?.length > 0) {
        for (const att of attachments) {
          if (att.mimeType?.startsWith('image/')) {
            memoryContent += `\n[Attached image: ${att.filename}]`;
          } else {
            memoryContent += `\n[Attached file: ${att.filename} (${att.mimeType})]`;
          }
        }
      }

      for (const pid of participants) {
        if (pid === 'user') continue;
        try {
          ConversationService.addEntry(db, pid, {
            type: 'conversation',
            speaker: speakerLabel,
            role: 'user',
            channel: 'thread',
            content: memoryContent,
            metadata: { threadId: thread.id, threadName: thread.name || null }
          });
        } catch (convErr) {
          console.warn(`[agent-chat] Failed to record user thread msg for ${pid}:`, convErr.message);
        }
      }

      // Reset circuit breaker on user intervention
      AgentChatService.resetCircuitBreaker(db, thread.id);

      // Broadcast user message SSE
      const userThreadMsg = { ...msg, sender_name: senderName };
      broadcastToThread(
        thread.id,
        MESSAGES_SNAPSHOT,
        { threadId: thread.id, messages: [userThreadMsg] }
      );

      // --- Plan commands: /plan, /approve, /cancel, /reject, /modify ---
      const trimmedMsg = message.trim();
      const planCmd = PlanCommandService.parseCommand(trimmedMsg);

      if (planCmd.command) {
        // Resolve the responding agent from thread participants
        const agentParticipants = JSON.parse(thread.participants || '[]');
        const aid = agentParticipants.find(id => id !== 'user');
        const agent = aid ? AgentService.getById(db, aid) : null;

        if (agent) {
          // Helper: send an agent reply in the thread
          const sendAgentReply = (text) => {
            const replyMsg = AgentChatService.sendMessage(
              db, thread.id, agent.id, agent.name, text, 'chat', 'assistant'
            );
            const replyWithName = { ...replyMsg, sender_name: agent.name };
            broadcastToThread(
              thread.id,
              MESSAGES_SNAPSHOT,
              { threadId: thread.id, messages: [replyWithName] }
            );
          };

          try {
            let result;
            switch (planCmd.command) {
              case 'plan':
                result = await PlanCommandService.handlePlan(db, { agentId: agent.id, request: planCmd.argument });
                sendAgentReply(result.displayText);
                broadcastToThread(
                  thread.id,
                  STATE_SNAPSHOT,
                  { threadId: thread.id, snapshot: { plan: result.planSSEData } }
                );
                break;

              case 'approve':
                result = await PlanCommandService.handleApprove(db, {
                  agentId: agent.id,
                  onStepProgress: (_planId, stepSeq, totalSteps, description, status) => {
                    if (status === 'running') {
                      sendAgentReply(`Running step ${stepSeq}/${totalSteps}: ${description}...`);
                    }
                  },
                  onComplete: (_planId, summary) => {
                    sendAgentReply(summary);
                  }
                });
                sendAgentReply(result.text);
                if (result.executionPromise) {
                  result.executionPromise.catch(err => {
                    console.error(`[Plans] Execution error for ${result.planId}:`, err);
                    sendAgentReply(`Plan execution failed: ${err.message}`);
                  });
                }
                break;

              case 'cancel':
                result = PlanCommandService.handleCancel(db, { agentId: agent.id });
                sendAgentReply(result.text);
                break;

              case 'reject':
                result = PlanCommandService.handleReject(db, { agentId: agent.id });
                sendAgentReply(result.text);
                break;

              case 'modify':
                result = await PlanCommandService.handleModify(db, { agentId: agent.id, modification: planCmd.argument });
                sendAgentReply(result.displayText);
                break;
            }
          } catch (err) {
            const replyMsg = AgentChatService.sendMessage(
              db, thread.id, agent.id, agent.name, `Plan error: ${err.message}`, 'chat', 'assistant'
            );
            const errorReply = { ...replyMsg, sender_name: agent.name };
            broadcastToThread(
              thread.id,
              MESSAGES_SNAPSHOT,
              { threadId: thread.id, messages: [errorReply] }
            );
          }
          return res.json({ success: true, messageId: msg.id });
        }
      }

      // Trigger agent responses via orchestrator (normal flow)
      if (ThreadOrchestrator) {
        ThreadOrchestrator.triggerResponses(thread.id, 'user', senderName, true)
          .catch(err => console.error('[AgentChat] triggerResponses error:', err));
      }

      res.json({ success: true, messageId: msg.id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /threads/:id/reset — Reset circuit breaker
   */
  router.post('/threads/:id/reset', (req, res) => {
    try {
      const thread = AgentChatService.getThread(db, req.params.id);
      if (!thread) return res.status(404).json({ error: 'Thread not found' });

      AgentChatService.resetCircuitBreaker(db, thread.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * DELETE /threads/:id/messages — Clear all messages in a thread
   */
  router.delete('/threads/:id/messages', (req, res) => {
    try {
      const thread = AgentChatService.getThread(db, req.params.id);
      if (!thread) return res.status(404).json({ error: 'Thread not found' });

      AgentChatService.clearThreadMessages(db, thread.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /threads/:id/stream — SSE for real-time thread messages
   */
  router.get('/threads/:id/stream', (req, res) => {
    const threadId = req.params.id;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    // Send connected event
    res.write(`data: ${JSON.stringify({ type: 'connected', threadId })}\n\n`);

    // Register client
    if (!threadSSEClients.has(threadId)) {
      threadSSEClients.set(threadId, new Set());
    }
    threadSSEClients.get(threadId).add(res);

    // Cleanup on disconnect
    req.on('close', () => {
      const clients = threadSSEClients.get(threadId);
      if (clients) {
        clients.delete(res);
        if (clients.size === 0) {
          threadSSEClients.delete(threadId);
        }
      }
    });
  });

  /**
   * GET /budget — Daily budget status
   */
  router.get('/budget', (req, res) => {
    try {
      const status = AgentChatService.getDailyBudgetStatus(db);
      const limit = parseInt(SettingsService.get(db, 'agentChatDailyLimit') || '20', 10);
      res.json({ dailyLimit: limit, agents: status });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /agents — List active agents
   */
  router.get('/agents', (req, res) => {
    try {
      const agents = AgentChatService.getActiveAgents(db);
      res.json(agents);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

/**
 * Broadcast an ag-ui SSE event to all clients of a thread.
 */
function broadcastToThread(threadId, aguiType, aguiPayload) {
  const clients = threadSSEClients.get(threadId);
  if (!clients || clients.size === 0) return;
  broadcast(clients, aguiType, aguiPayload);
}

module.exports = { createAgentChatRouter, getThreadSSEClients, threadSSEClients };

module.exports.meta = {
  name: 'agent-chat',
  description: 'Agent-to-agent direct messaging and group chat threads',
  basePath: '/api/agent-chat',
  endpoints: [
    { method: 'POST', path: '/dm', description: 'Send a direct message to another agent',
      params: { fromAgentId: 'string, required', toAgentId: 'string, required', content: 'string, required' } },
    { method: 'POST', path: '/groups', description: 'Create a group chat thread' },
    { method: 'GET', path: '/threads', description: 'List chat threads' },
    { method: 'GET', path: '/threads/:id', description: 'Get thread with messages' },
    { method: 'PATCH', path: '/threads/:id', description: 'Update thread settings' },
    { method: 'DELETE', path: '/threads/:id', description: 'Archive a thread' },
    { method: 'POST', path: '/threads/:id/send', description: 'Send message to a thread' },
    { method: 'GET', path: '/budget', description: 'Daily chat budget status' }
  ]
};
