/**
 * Telegram API routes
 * Send text messages, photos, and documents via Telegram bots
 */

const express = require('express');
const path = require('path');
const TelegramService = require('../services/telegram');
const { MemoryService } = require('../assistant/memory');
const { stripInternalNotes } = require('../utils/internal-notes');
const requireAppContext = require('../middleware/require-app-context');

function createTelegramRouter(db, { AgentService, SettingsService, getTelegramWatcher }) {
  const router = express.Router();
  router.use(requireAppContext);   // PR 1.8

  // Helper: get agent's bot token and owner chat ID
  function getAgentTelegram(agentId) {
    if (!agentId) return null;
    const agent = AgentService.getById(db, agentId);
    if (!agent) return null;
    const config = AgentService.getConfig(db, agentId);
    if (!config) return null;
    // Read global Telegram enabled setting (default: true)
    const globalEnabled = SettingsService ? SettingsService.get(db, 'telegramEnabled') !== 'false' : true;
    return {
      token: agent.telegram_bot_token,
      chatId: agent.telegram_chat_id,
      enabled: globalEnabled,
      agent,
      config
    };
  }

  /**
   * POST /api/telegram/verify-bot
   * Verify a bot token and check for /start messages to capture chat_id.
   * Used during setup wizard before the agent is fully configured.
   * Body: { token }
   */
  router.post('/verify-bot', async (req, res) => {
    const { token, agentName } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'token is required' });
    }

    try {
      // Verify token with getMe
      const me = await TelegramService.getMe(token);

      // Check for /start messages (offset 0 = get all pending updates, timeout 0 = don't long-poll)
      let chatId = null;
      let userName = null;
      try {
        const updates = await TelegramService.getUpdates(token, 0, 0);
        for (const update of updates) {
          const msg = update.message;
          if (msg && msg.text === '/start' && msg.chat?.type === 'private') {
            chatId = msg.chat.id;
            userName = msg.from?.first_name || msg.from?.username || null;
            break;
          }
        }
      } catch (e) {
        // getUpdates might fail if another process is polling — that's OK
      }

      res.json({
        valid: true,
        botUsername: me.username,
        botName: me.first_name,
        chatId,
        userName
      });
    } catch (err) {
      res.json({ valid: false, error: err.message });
    }
  });

  /**
   * GET /api/telegram/status
   * Get Telegram status for an agent
   * Query: ?agentId=xxx
   */
  router.get('/status', (req, res) => {
    const agentId = req.query.agentId;
    if (!agentId) {
      return res.status(400).json({ error: 'agentId is required' });
    }

    const tg = getAgentTelegram(agentId);
    if (!tg) {
      return res.json({ ready: false, reason: 'Agent not found' });
    }

    const watcher = getTelegramWatcher ? getTelegramWatcher(agentId) : null;

    res.json({
      ready: tg.enabled && !!tg.token && !!tg.chatId,
      enabled: tg.enabled,
      hasToken: !!tg.token,
      hasChatId: !!tg.chatId,
      watcherRunning: watcher ? watcher.isRunning : false,
      botUsername: watcher?.botUsername || null
    });
  });

  /**
   * POST /api/telegram/send
   * Send a text message via Telegram
   *
   * Body: { agentId: string, message: string, chatId?: string }
   */
  router.post('/send', express.json(), async (req, res) => {
    try {
      const { agentId, message, chatId } = req.body;

      if (!agentId || !message) {
        return res.status(400).json({ error: 'agentId and message are required' });
      }

      const tg = getAgentTelegram(agentId);
      if (!tg || !tg.token) {
        return res.status(503).json({ error: 'Telegram not configured for this agent' });
      }

      const targetChatId = chatId || tg.chatId;
      if (!targetChatId) {
        return res.status(400).json({ error: 'No chat ID available. Send /start to the bot first.' });
      }

      const result = await TelegramService.send(tg.token, targetChatId, message);

      // Log outbound message to memory
      try {
        const { agentDir } = AgentService.getPaths(tg.agent.app_id, tg.agent.id);
        const memory = new MemoryService(agentDir, db, tg.agent.id);
        memory.appendToTodayNote('Conversations', `**${tg.config.assistantName}:** [Telegram sent] ${message}`);
      } catch (logErr) {
        console.warn('Telegram API: Failed to log to memory:', logErr.message);
      }

      res.json({ success: true, messageId: result.message_id });
    } catch (err) {
      console.error('Telegram API: Error sending message:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/telegram/send-photo
   * Send a photo via Telegram
   *
   * Body: { agentId: string, photoUrl: string, caption?: string, chatId?: string }
   */
  router.post('/send-photo', express.json(), async (req, res) => {
    try {
      const { agentId, photoUrl, caption, chatId } = req.body;

      if (!agentId || !photoUrl) {
        return res.status(400).json({ error: 'agentId and photoUrl are required' });
      }

      const tg = getAgentTelegram(agentId);
      if (!tg || !tg.token) {
        return res.status(503).json({ error: 'Telegram not configured for this agent' });
      }

      const targetChatId = chatId || tg.chatId;
      if (!targetChatId) {
        return res.status(400).json({ error: 'No chat ID available' });
      }

      const result = await TelegramService.sendPhoto(tg.token, targetChatId, photoUrl, caption);

      // Log to memory
      try {
        const { agentDir } = AgentService.getPaths(tg.agent.app_id, tg.agent.id);
        const memory = new MemoryService(agentDir, db, tg.agent.id);
        const cleanCaption = caption ? stripInternalNotes(caption) : null;
        const logEntry = cleanCaption
          ? `**${tg.config.assistantName}:** [Photo sent via Telegram] "${cleanCaption}"`
          : `**${tg.config.assistantName}:** [Photo sent via Telegram]`;
        memory.appendToTodayNote('Conversations', logEntry);
      } catch (logErr) {
        console.warn('Telegram API: Failed to log photo to memory:', logErr.message);
      }

      res.json({ success: true, messageId: result.message_id });
    } catch (err) {
      console.error('Telegram API: Error sending photo:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/telegram/send-document
   * Send a document via Telegram
   *
   * Body: { agentId: string, documentUrl: string, caption?: string, chatId?: string }
   */
  router.post('/send-document', express.json(), async (req, res) => {
    try {
      const { agentId, documentUrl, caption, chatId } = req.body;

      if (!agentId || !documentUrl) {
        return res.status(400).json({ error: 'agentId and documentUrl are required' });
      }

      const tg = getAgentTelegram(agentId);
      if (!tg || !tg.token) {
        return res.status(503).json({ error: 'Telegram not configured for this agent' });
      }

      const targetChatId = chatId || tg.chatId;
      if (!targetChatId) {
        return res.status(400).json({ error: 'No chat ID available' });
      }

      const result = await TelegramService.sendDocument(tg.token, targetChatId, documentUrl, caption);

      res.json({ success: true, messageId: result.message_id });
    } catch (err) {
      console.error('Telegram API: Error sending document:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createTelegramRouter;

module.exports.meta = {
  name: 'telegram',
  description: 'Send messages, photos, and documents via Telegram bot',
  basePath: '/api/telegram',
  endpoints: [
    { method: 'GET', path: '/status', description: 'Check if Telegram bot is configured',
      params: { agentId: 'query string, required' } },
    { method: 'POST', path: '/send', description: 'Send text message via Telegram',
      params: { text: 'string, required', agentId: 'string, required' } },
    { method: 'POST', path: '/send-photo', description: 'Send photo via Telegram',
      params: { photoPath: 'string, required', caption: 'string, optional', agentId: 'string, required' } },
    { method: 'POST', path: '/send-document', description: 'Send document via Telegram',
      params: { documentPath: 'string, required', caption: 'string, optional', agentId: 'string, required' } }
  ]
};
