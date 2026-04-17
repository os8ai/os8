/**
 * Telegram watcher lifecycle for agents.
 * Extracted from server.js — handles incoming Telegram DMs, forwards to agent CLI backend,
 * streams responses to desktop SSE clients, and sends replies via Telegram API.
 * Also handles Telegram group chats via ThreadOrchestrator (same flow as OS8 group threads).
 */

const path = require('path');
const fs = require('fs');
const { getBackend } = require('./services/backend-adapter');
const { AgentService, SettingsService } = require('./db');
const ConversationService = require('./services/conversation');
const RoutingService = require('./services/routing');
const TelegramService = require('./services/telegram');
const { prepareSpawnEnv, createProcess, attachStreamParser } = require('./services/cli-runner');
const { TelegramWatcher } = require('./assistant/telegram-watcher');
const { MemoryService } = require('./assistant/memory');
const { buildMemoryContext, calculateContextBudgets, buildStreamJsonMessage, buildImageDescriptionsContext } = require('./assistant/identity-context');
const { compressForClaude, compressImageBuffer } = require('./utils/image-compress');
const { stripInternalNotes, stripToolCallXml, extractFileAttachments } = require('./utils/internal-notes');
const agentState = require('./services/agent-state');
const AgentChatService = require('./services/agent-chat');
const { ThreadOrchestrator } = require('./services/thread-orchestrator');
const AccountService = require('./services/account');
const {
  broadcast,
  RUN_FINISHED,
  TEXT_MESSAGE_CONTENT,
  newRunId,
  newMessageId
} = require('./shared/agui-events');

const DEFAULT_CLAUDE_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

// --- Telegram Group Chat ---

// Dedup: messageId → timestamp (prevents duplicate processing when multiple watchers report same message)
const _groupMessageDedup = new Map();
const GROUP_DEDUP_TTL_MS = 120000; // 2 minutes

function _cleanupGroupDedup() {
  const now = Date.now();
  for (const [id, ts] of _groupMessageDedup) {
    if (now - ts > GROUP_DEDUP_TTL_MS) _groupMessageDedup.delete(id);
  }
}

/**
 * Central handler for Telegram group messages.
 * Called by each watcher that receives a group message — deduplicates so only the first processes it.
 *
 * @param {object} db - SQLite database
 * @param {object} msg - { text, attachments, telegramChatId, chatTitle, messageId, timestamp, senderName, senderUserId }
 * @param {string} reportingAgentId - The agent whose watcher received this message
 */
async function handleTelegramGroupMessage(db, msg, reportingAgentId) {
  const { text, attachments, telegramChatId, chatTitle, senderName, timestamp } = msg;

  // --- Always register the reporting agent in the group (even if message is deduped) ---
  let tgGroup = db.prepare('SELECT * FROM telegram_groups WHERE telegram_chat_id = ?').get(telegramChatId);

  if (tgGroup) {
    // Existing group — ensure reporting agent is in agent_ids + thread participants
    const agentIds = JSON.parse(tgGroup.agent_ids || '[]');
    if (!agentIds.includes(reportingAgentId)) {
      agentIds.push(reportingAgentId);
      db.prepare('UPDATE telegram_groups SET agent_ids = ? WHERE id = ?')
        .run(JSON.stringify(agentIds), tgGroup.id);
      tgGroup.agent_ids = JSON.stringify(agentIds);

      // Also update thread participants (pass raw array — updateThread stringifies internally)
      const thread = AgentChatService.getThread(db, tgGroup.thread_id);
      if (thread) {
        const participants = JSON.parse(thread.participants || '[]');
        if (!participants.includes(reportingAgentId)) {
          participants.push(reportingAgentId);
          AgentChatService.updateThread(db, tgGroup.thread_id, { participants });
        }
      }
      console.log(`[Telegram Group] Added agent ${reportingAgentId} to group "${chatTitle}"`);
    }
  }

  // --- Dedup: only the first watcher to report this message processes the rest ---
  if (_groupMessageDedup.has(msg.messageId)) return;
  _groupMessageDedup.set(msg.messageId, Date.now());
  _cleanupGroupDedup();

  console.log(`[Telegram Group] Message from ${senderName} in "${chatTitle}": "${(text || '').substring(0, 50)}..."`);

  try {
    // --- Create telegram_groups entry + agent_thread if first message ---
    if (!tgGroup) {
      const agentIds = [reportingAgentId];
      const thread = AgentChatService.createGroup(db, {
        name: chatTitle,
        participantIds: ['user', ...agentIds],
        creatorId: 'user'
      });

      db.prepare(
        'INSERT INTO telegram_groups (telegram_chat_id, thread_id, chat_title, agent_ids) VALUES (?, ?, ?, ?)'
      ).run(telegramChatId, thread.id, chatTitle, JSON.stringify(agentIds));

      tgGroup = db.prepare('SELECT * FROM telegram_groups WHERE telegram_chat_id = ?').get(telegramChatId);
      console.log(`[Telegram Group] Created thread ${thread.id} for Telegram group "${chatTitle}"`);
    }

    const threadId = tgGroup.thread_id;

    // --- Build message content (same format as DM) ---
    let messageContent = text || '';
    if (attachments && attachments.length > 0) {
      const attNames = attachments.map(a => path.basename(a.path)).join(', ');
      messageContent = `[${attachments.length} attachment(s): ${attNames}] ${messageContent}`;
    }

    // --- Store user message in agent_messages (canonical thread store) ---
    AgentChatService.sendMessage(db, threadId, 'user', senderName, messageContent, 'chat', 'user');

    // --- Record in each agent's conversation_entries (long-term memory) ---
    const agentIds = JSON.parse(tgGroup.agent_ids || '[]');
    const account = AccountService.getAccount(db);
    const userName = account?.display_name || account?.username || senderName;
    const speakerLabel = `${userName.toLowerCase()} (user)`;

    for (const agentId of agentIds) {
      try {
        ConversationService.addEntry(db, agentId, {
          type: 'conversation',
          speaker: speakerLabel,
          role: 'user',
          channel: 'telegram-group',
          content: messageContent,
          metadata: { threadId, threadName: chatTitle }
        });
      } catch (convErr) {
        console.warn(`[Telegram Group] Failed to record user msg for agent ${agentId}:`, convErr.message);
      }
    }

    // --- Reset circuit breaker (user sent the message) ---
    AgentChatService.resetCircuitBreaker(db, threadId);

    // --- Trigger responses via ThreadOrchestrator (moderator, turn-taking, memory, images — all included) ---
    ThreadOrchestrator.triggerResponses(threadId, 'user', senderName, true, 'telegram');

  } catch (err) {
    console.error(`[Telegram Group] Error handling group message:`, err.message);
  }
}

/**
 * Auto-start Telegram watchers for all agents with bot tokens (if global setting enabled)
 * @param {object} db - SQLite database
 */
function ensureTelegramWatchers(db) {
  if (!db) return;

  // Check global Telegram setting (default: enabled)
  const globalEnabled = SettingsService.get(db, 'telegramEnabled');
  if (globalEnabled === 'false') {
    console.log('Telegram: Global setting disabled, skipping all watchers');
    return;
  }

  const allAgents = AgentService.getOperational(db);
  const telegramAgents = allAgents.filter(a => a.telegram_bot_token);

  if (telegramAgents.length === 0) {
    console.log('Telegram: No agents have bot tokens configured, skipping');
    return;
  }

  for (const agent of telegramAgents) {
    startTelegramWatcherForAgent(db, agent);
  }
}

/**
 * Start (or restart) a Telegram watcher for a specific agent
 * @param {object} db - SQLite database
 * @param {object} agent - Agent DB row
 * @returns {boolean} Whether watcher started successfully
 */
function startTelegramWatcherForAgent(db, agent) {
  const agentStateObj = agentState.getAgentState(agent.id);

  // Stop existing watcher
  if (agentStateObj.telegramWatcher) {
    agentStateObj.telegramWatcher.stop();
    agentStateObj.telegramWatcher = null;
  }

  if (!agent.telegram_bot_token) {
    console.log(`Telegram [${agent.name}]: No bot token configured, skipping`);
    return false;
  }

  const config = AgentService.getConfig(db, agent.id);
  const { agentDir: appPath, agentBlobDir } = AgentService.getPaths(agent.app_id, agent.id);

  // Setup attachments directory
  const attachmentsDir = path.join(agentBlobDir, 'telegram-attachments');
  if (!fs.existsSync(attachmentsDir)) {
    fs.mkdirSync(attachmentsDir, { recursive: true });
  }

  const watcher = new TelegramWatcher({
    token: agent.telegram_bot_token,
    agentId: agent.id,
    agentName: config.assistantName || agent.name,
    ownerChatId: agent.telegram_chat_id || null,
    attachmentsDir,
    onLog: (msg) => {
      console.log(`[Telegram ${agent.name}] ${msg}`);
    },
    onError: (err) => {
      console.error(`[Telegram ${agent.name}] ${err.message}`);
    },
    ownerUserId: agent.telegram_owner_user_id || null,
    onStart: (chatId, user) => {
      // Auto-register owner's chat_id and user_id via /start
      console.log(`Telegram [${agent.name}]: Owner registered via /start: chat_id=${chatId}, user=${user?.username || user?.first_name}`);
      const ownerUserId = user?.id ? String(user.id) : null;
      AgentService.update(db, agent.id, { telegram_chat_id: chatId, telegram_owner_user_id: ownerUserId });
      watcher.ownerChatId = chatId;
      watcher.ownerUserId = ownerUserId;
      console.log(`Telegram [${agent.name}]: Owner registered: ${user?.first_name} (chat_id=${chatId}, user_id=${ownerUserId})`);
    },
    onMessage: async (msg) => {
      const textPreview = msg.text ? msg.text.substring(0, 50) : '(no text)';
      console.log(`[Telegram ${agent.name}] Incoming DM: "${textPreview}..." with ${msg.attachments?.length || 0} attachment(s)`);

      // Record user message to conversation DB
      if (db) {
        try {
          let userContent = msg.text || '(no text)';
          if (msg.attachments && msg.attachments.length > 0) {
            const attNames = msg.attachments.map(a => path.basename(a.path)).join(', ');
            userContent = `[${msg.attachments.length} attachment(s): ${attNames}] ${userContent}`;
          }
          ConversationService.addEntry(db, agent.id, {
            type: 'conversation',
            speaker: 'user',
            role: 'user',
            channel: 'telegram',
            content: userContent
          });
        } catch (convErr) {
          console.warn('Failed to record Telegram user message:', convErr.message);
        }
      }

      // Forward to agent
      try {
        const tgAgentOverride = config.agentModel || null;
        const tgResolved = RoutingService.resolve(db, 'conversation', tgAgentOverride);
        const tgBackendId = tgResolved.backendId;
        const tgModel = tgResolved.modelArg;
        const tgBackend = getBackend(tgBackendId);
        console.log(`[Routing] conversation/telegram: ${tgResolved.familyId} via ${tgResolved.source}`);

        // Calculate context budgets
        const {
          identityContext,
          conversationBudgetChars,
          semanticBudgetChars,
          presentMomentImageData: imageData,
          timelineImages,
          ownerImage,
          presentMomentContext: tgPresentMomentContext,
          imageDescriptions: tgImageDescriptions
        } = await calculateContextBudgets(appPath, db, undefined, { backend: tgBackend });

        // Build memory context
        let memoryContext = '';
        let tgMemoryContextObj = null;
        try {
          let memory = agentStateObj.memory;
          if (!memory) {
            memory = new MemoryService(appPath, db, agent.id);
            agentStateObj.memory = memory;
          }
          const context = await memory.getContextForMessage(msg.text || '', {
            conversationBudgetChars,
            semanticBudgetChars,
            priorityOrder: ['identity', 'curated', 'daily']
          });
          tgMemoryContextObj = context;
          memoryContext = buildMemoryContext(context);
        } catch (memErr) {
          console.warn('Telegram memory context error:', memErr.message);
        }

        // Build message content
        let messageContent = `[Telegram from ${config.ownerName || 'Owner'}]`;

        // Process image attachments
        const userImageAttachments = [];
        if (msg.attachments && msg.attachments.length > 0) {
          const nonImageAtts = [];
          for (const att of msg.attachments) {
            const mimeType = att.mimeType || 'unknown type';
            if (mimeType.startsWith('image/')) {
              try {
                const imgBuffer = fs.readFileSync(att.path);
                const claudeResult = await compressForClaude(imgBuffer);
                userImageAttachments.push({
                  data: claudeResult.data,
                  mediaType: claudeResult.mediaType,
                  filename: path.basename(att.path)
                });
                if (db) {
                  const dbResult = await compressImageBuffer(imgBuffer);
                  ConversationService.addImageEntry(db, agent.id, {
                    imageData: dbResult.data,
                    mediaType: dbResult.mediaType,
                    imageView: 'telegram_user',
                    timestamp: new Date().toISOString(),
                    originalFilename: path.basename(att.path),
                    speaker: 'user',
                    role: 'user',
                    channel: 'telegram'
                  });
                }
              } catch (imgErr) {
                console.warn(`Failed to process Telegram image ${att.path}:`, imgErr.message);
                nonImageAtts.push(att);
              }
            } else {
              nonImageAtts.push(att);
            }
          }
          if (nonImageAtts.length > 0) {
            messageContent += '\n\n[Attachments:';
            for (const att of nonImageAtts) {
              messageContent += `\n- ${att.path} (${att.mimeType || 'unknown type'})`;
            }
            messageContent += ']';
          }
          if (userImageAttachments.length > 0) {
            messageContent += `\n\n[${userImageAttachments.length} image(s) attached inline]`;
          }
        }

        if (msg.text) {
          messageContent += `\n\n${msg.text}`;
        } else if (msg.attachments && msg.attachments.length > 0) {
          messageContent += '\n\n(attachment only, no text)';
        }

        // Image descriptions for backends that can't see images
        let tgImageDescContext = '';
        if (tgBackend.supportsImageDescriptions && tgImageDescriptions) {
          tgImageDescContext = buildImageDescriptionsContext(tgImageDescriptions, { ownerName: config.ownerName, assistantName: config.assistantName });
        }

        const fullContext = identityContext + tgImageDescContext + memoryContext;
        const jarvisMessage = fullContext
          ? `[Context]\n${fullContext}[Message]\n${messageContent}`
          : messageContent;

        // --- CLI path ---
        const env = prepareSpawnEnv(db, tgBackendId, tgResolved.accessMethod);

        const hasImages = tgBackend.supportsImageInput && (imageData?.thirdPerson || imageData?.pov || ownerImage || userImageAttachments.length > 0);

        const args = tgBackend.buildArgs({
          print: true,
          verbose: true,
          streamJson: true,
          includePartialMessages: tgBackend.supportsStreamJson,
          skipPermissions: true,
          inputFormatStreamJson: hasImages,
          appPath,
          blobDir: agentBlobDir,
          model: tgModel,
        });

        if (!hasImages) {
          args.push(...tgBackend.buildPromptArgs(jarvisMessage));
        }

        console.log(`[Telegram ${agent.name}] ${tgBackend.command} [backend: ${tgBackendId}]`);

        // Spawn process
        let stdinData = null;
        if (hasImages) {
          stdinData = buildStreamJsonMessage({
            identityText: jarvisMessage,
            presentMomentImages: imageData,
            ownerImage, timelineImages,
            userAttachments: userImageAttachments,
            userMessage: '', conversationBudgetChars: 0
          }) + '\n';
        }

        const ptyProcess = createProcess(tgBackend, args, {
          cwd: appPath, env, useImages: hasImages,
          stdinData
        });

        const rawTimeout = SettingsService.get(db, 'responseTimeoutMs');
        const tgClaudeTimeout = rawTimeout !== null ? parseInt(rawTimeout) : DEFAULT_CLAUDE_TIMEOUT_MS;
        const timeout = tgClaudeTimeout > 0 ? setTimeout(() => {
          ptyProcess.kill();
          console.error(`[Telegram ${agent.name}] Response timed out after ${tgClaudeTimeout / 60000} minutes`);
        }, tgClaudeTimeout) : null;

        const tgRunId = newRunId();
        const tgMessageId = newMessageId();

        const streamToSSE = (text) => {
          const displayText = stripToolCallXml(stripInternalNotes(text));
          if (displayText) {
            const aState = agentState.getAgentState(agent.id);
            broadcast(
              aState.responseClients,
              TEXT_MESSAGE_CONTENT,
              { runId: tgRunId, messageId: tgMessageId, delta: displayText, source: 'telegram', agentId: agent.id }
            );
          }
        };

        attachStreamParser(ptyProcess, {
          onDelta: (text) => streamToSSE(text),
          onReplace: (text) => streamToSSE(text),
          onExit: async ({ exitCode, fullResponse }) => {
            if (timeout) clearTimeout(timeout);

            if (exitCode !== 0) {
              console.error(`[Telegram ${agent.name}] ${tgBackend.label} exited with code ${exitCode}`);
            }

            if ((exitCode === 0 || fullResponse) && fullResponse) {
              const displayResponse = stripToolCallXml(stripInternalNotes(fullResponse));

              // Send response to Telegram
              try {
                await TelegramService.send(agent.telegram_bot_token, msg.chatId, displayResponse);
                console.log(`[Telegram ${agent.name}] Sent reply: "${displayResponse.substring(0, 50)}..."`);
              } catch (sendErr) {
                console.error(`[Telegram ${agent.name}] Failed to send Telegram reply: ${sendErr.message}`);
              }

              // Record assistant response to conversation DB
              if (db) {
                try {
                  const agentName = ConversationService.getAgentName(agent.id);
                  ConversationService.addEntry(db, agent.id, {
                    type: 'conversation',
                    speaker: agentName,
                    role: 'assistant',
                    channel: 'telegram',
                    content: fullResponse
                  });
                } catch (convErr) {
                  console.warn('Failed to record Telegram assistant response:', convErr.message);
                }

                // Store agent response images
                try {
                  const agentName = ConversationService.getAgentName(agent.id);
                  const agentAttachments = extractFileAttachments(stripInternalNotes(fullResponse));
                  const agentImages = agentAttachments.filter(a => a.mimeType && a.mimeType.startsWith('image/'));
                  for (const img of agentImages) {
                    const relPath = img.url.replace(/^\/blob\//, '');
                    const imgPath = path.join(agentBlobDir, relPath);
                    if (fs.existsSync(imgPath)) {
                      const imgBuffer = fs.readFileSync(imgPath);
                      const dbResult = await compressImageBuffer(imgBuffer);
                      ConversationService.addImageEntry(db, agent.id, {
                        imageData: dbResult.data,
                        mediaType: dbResult.mediaType,
                        imageView: 'chat_agent',
                        timestamp: new Date().toISOString(),
                        originalFilename: img.filename,
                        speaker: agentName,
                        role: 'assistant',
                        channel: 'telegram'
                      });
                    }
                  }
                } catch (imgErr) {
                  console.warn('Failed to store Telegram agent response images:', imgErr.message);
                }
              }

              // Log to memory
              try {
                let memory = agentStateObj.memory;
                if (!memory) {
                  memory = new MemoryService(appPath, db, agent.id);
                  agentStateObj.memory = memory;
                }
              } catch (memErr) {
                // Memory service initialization only — no longer logs to MD files
              }

              // Notify desktop SSE clients
              const aState = agentState.getAgentState(agent.id);
              broadcast(
                aState.responseClients,
                RUN_FINISHED,
                { runId: tgRunId, messageId: tgMessageId, result: displayResponse, source: 'telegram', agentId: agent.id }
              );
            }
          }
        });
      } catch (err) {
        console.error(`[Telegram ${agent.name}] Failed to process message: ${err.message}`);
      }
    },
    onGroupMessage: async (msg) => {
      handleTelegramGroupMessage(db, msg, agent.id);
    }
  });

  // Start the watcher
  watcher.start().then(() => {
    agentStateObj.telegramWatcher = watcher;
    console.log(`Telegram watcher started for ${agent.name} (@${watcher.botUsername})`);
  }).catch((err) => {
    console.error(`Failed to start Telegram watcher for ${agent.name}:`, err.message);
  });

  return true;
}

module.exports = {
  ensureTelegramWatchers,
  startTelegramWatcherForAgent,
  handleTelegramGroupMessage
};
