/**
 * Telegram Watcher
 *
 * Long-polling watcher for a single Telegram bot.
 * Each agent with a configured telegram_bot_token gets its own watcher instance.
 * Watches for incoming Telegram messages and forwards them to the agent.
 */

const path = require('path');
const TelegramService = require('../services/telegram');

class TelegramWatcher {
  constructor(options = {}) {
    this.token = options.token;
    this.agentId = options.agentId;
    this.agentName = options.agentName || 'Assistant';
    this.ownerChatId = options.ownerChatId || null; // Auto-set via /start
    this.attachmentsDir = options.attachmentsDir || null;

    // Callbacks
    this.onMessage = options.onMessage || (() => {});
    this.onGroupMessage = options.onGroupMessage || (() => {});
    this.onStart = options.onStart || (() => {}); // Called when /start registers owner
    this.onError = options.onError || ((err) => console.error('Telegram Watcher error:', err));
    this.onLog = options.onLog || ((msg) => console.log('Telegram Watcher:', msg));

    // Owner's Telegram user ID (for verifying sender in group chats)
    this.ownerUserId = options.ownerUserId || null;

    // State
    this.offset = 0;
    this.isRunning = false;
    this.abortController = null;
    this.botUsername = null;
    this.pollTimeoutHandle = null;
    this.consecutiveErrors = 0;

    // Dedup
    this.recentlyProcessed = new Map(); // messageId -> timestamp
  }

  /**
   * Clean up old dedup entries (older than 2 minutes)
   */
  cleanupDedup() {
    const now = Date.now();
    for (const [id, timestamp] of this.recentlyProcessed) {
      if (now - timestamp > 120000) {
        this.recentlyProcessed.delete(id);
      }
    }
  }

  /**
   * Process attachments from a Telegram message
   * Downloads photos and documents to blob storage
   * @param {object} msg - Telegram message object
   * @returns {Promise<Array>} Array of { path, mimeType, name }
   */
  async processAttachments(msg) {
    if (!this.attachmentsDir) return [];

    const attachments = [];

    // Handle photos (get the largest resolution)
    if (msg.photo && msg.photo.length > 0) {
      const photo = msg.photo[msg.photo.length - 1]; // Largest size
      try {
        const ext = '.jpg';
        const filename = `telegram-photo-${Date.now()}${ext}`;
        const destPath = path.join(this.attachmentsDir, filename);
        await TelegramService.downloadFile(this.token, photo.file_id, destPath);
        attachments.push({
          path: destPath,
          mimeType: 'image/jpeg',
          name: filename
        });
        this.onLog(`Downloaded photo: ${filename}`);
      } catch (err) {
        this.onError(new Error(`Failed to download photo: ${err.message}`));
      }
    }

    // Handle documents
    if (msg.document) {
      try {
        const doc = msg.document;
        const ext = path.extname(doc.file_name || '') || '';
        const filename = `telegram-doc-${Date.now()}${ext}`;
        const destPath = path.join(this.attachmentsDir, filename);
        await TelegramService.downloadFile(this.token, doc.file_id, destPath);
        attachments.push({
          path: destPath,
          mimeType: doc.mime_type || 'application/octet-stream',
          name: doc.file_name || filename
        });
        this.onLog(`Downloaded document: ${doc.file_name || filename}`);
      } catch (err) {
        this.onError(new Error(`Failed to download document: ${err.message}`));
      }
    }

    // Handle stickers as images
    if (msg.sticker && msg.sticker.thumbnail) {
      try {
        const filename = `telegram-sticker-${Date.now()}.jpg`;
        const destPath = path.join(this.attachmentsDir, filename);
        await TelegramService.downloadFile(this.token, msg.sticker.thumbnail.file_id, destPath);
        attachments.push({
          path: destPath,
          mimeType: 'image/jpeg',
          name: filename
        });
      } catch (err) {
        // Sticker download failure is non-critical
      }
    }

    return attachments;
  }

  /**
   * Handle a single update from Telegram
   * @param {object} update - Telegram update object
   */
  async handleUpdate(update) {
    const msg = update.message;
    if (!msg) return;

    // Dedup check
    if (this.recentlyProcessed.has(msg.message_id)) {
      return;
    }
    this.recentlyProcessed.set(msg.message_id, Date.now());
    this.cleanupDedup();

    const chatId = String(msg.chat.id);
    const isPrivateChat = msg.chat.type === 'private';

    // Handle /start command — auto-register owner's chat_id
    if (msg.text === '/start' && isPrivateChat) {
      this.onLog(`/start received from chat_id=${chatId}, user=${msg.from?.username || msg.from?.first_name}`);
      this.ownerChatId = chatId;
      this.ownerUserId = msg.from?.id ? String(msg.from.id) : null;
      this.onStart(chatId, msg.from);

      // Send welcome message
      try {
        await TelegramService.send(this.token, chatId,
          `Connected! I'm ${this.agentName}. You can now send me messages here.`
        );
      } catch (err) {
        this.onError(new Error(`Failed to send welcome: ${err.message}`));
      }
      return;
    }

    // Only process DMs from owner (verified by chat_id)
    if (isPrivateChat) {
      if (!this.ownerChatId) {
        // Auto-register first DM sender as owner (bot token is private, so this is safe)
        this.onLog(`Auto-registering owner from DM: chat_id=${chatId}, user=${msg.from?.username || msg.from?.first_name}`);
        this.ownerChatId = chatId;
        this.ownerUserId = msg.from?.id ? String(msg.from.id) : null;
        this.onStart(chatId, msg.from);
      }
      if (chatId !== this.ownerChatId) {
        this.onLog(`Ignoring DM from stranger chat_id=${chatId}`);
        return;
      }

      await this.handleDirectMessage(msg);
    }

    // Group/supergroup messages
    const isGroupChat = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    if (isGroupChat) {
      // Only process messages from the owner
      const senderUserId = msg.from?.id ? String(msg.from.id) : null;
      if (!senderUserId || (this.ownerUserId && senderUserId !== this.ownerUserId)) {
        return; // Ignore messages from non-owners and from bots
      }

      // Ignore messages from bots (other agents in the group)
      if (msg.from?.is_bot) return;

      const text = msg.text || msg.caption || '';
      const hasAttachments = !!(msg.photo || msg.document || msg.sticker);
      if (!text && !hasAttachments) return;

      const attachments = await this.processAttachments(msg);
      const senderName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || 'User';

      this.onGroupMessage({
        text,
        attachments,
        telegramChatId: chatId,
        chatTitle: msg.chat.title || 'Group',
        messageId: msg.message_id,
        timestamp: new Date(msg.date * 1000),
        senderName,
        senderUserId
      });
    }
  }

  /**
   * Handle a direct message from the owner
   * @param {object} msg - Telegram message object
   */
  async handleDirectMessage(msg) {
    const text = msg.text || msg.caption || '';
    const hasAttachments = !!(msg.photo || msg.document || msg.sticker);

    // Skip empty messages
    if (!text && !hasAttachments) return;

    this.onLog(`DM from owner: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}" attachments=${hasAttachments}`);

    // Process attachments
    const attachments = await this.processAttachments(msg);

    // Forward to message handler
    this.onMessage({
      text,
      attachments,
      chatId: String(msg.chat.id),
      messageId: msg.message_id,
      timestamp: new Date(msg.date * 1000)
    });
  }

  /**
   * Main polling loop
   */
  async pollLoop() {
    if (!this.isRunning) return;

    try {
      const updates = await TelegramService.getUpdates(
        this.token,
        this.offset,
        30, // 30s long-poll timeout
        this.abortController?.signal
      );

      if (!this.isRunning) return;

      for (const update of updates) {
        this.offset = update.update_id + 1;
        try {
          await this.handleUpdate(update);
        } catch (err) {
          this.onError(new Error(`Error handling update ${update.update_id}: ${err.message}`));
        }
      }
      this.consecutiveErrors = 0;
    } catch (err) {
      if (!this.isRunning) return;

      this.consecutiveErrors++;

      // Conflict means another bot instance is polling — back off aggressively
      const isConflict = err.message && err.message.includes('Conflict');
      // Network errors are transient — log quietly, don't treat as real errors
      const isNetworkError = err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET' ||
        err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'EPIPE' ||
        (err.message && (err.message.includes('ETIMEDOUT') || err.message.includes('ECONNRESET')));

      if (isConflict) {
        const backoff = Math.min(60000, 15000 * this.consecutiveErrors);
        this.onLog(`Conflict detected (another instance polling), backing off ${backoff / 1000}s`);
        await new Promise(r => {
          this.pollTimeoutHandle = setTimeout(r, backoff);
        });
      } else if (isNetworkError) {
        this.onLog(`Network error (${err.code || err.message}), retrying...`);
        const backoff = Math.min(60000, 5000 * Math.pow(2, this.consecutiveErrors - 1));
        await new Promise(r => {
          this.pollTimeoutHandle = setTimeout(r, backoff);
        });
      } else {
        this.onError(err);
        // Exponential backoff: 5s, 10s, 20s, 40s... capped at 60s
        const backoff = Math.min(60000, 5000 * Math.pow(2, this.consecutiveErrors - 1));
        await new Promise(r => {
          this.pollTimeoutHandle = setTimeout(r, backoff);
        });
      }
    }

    // Continue polling
    if (this.isRunning) {
      // Use setImmediate to avoid stack overflow on rapid iterations
      setImmediate(() => this.pollLoop());
    }
  }

  /**
   * Start watching
   */
  async start() {
    if (this.isRunning) {
      this.onLog('Already running');
      return;
    }

    if (!this.token) {
      throw new Error('Bot token not configured');
    }

    // Verify token and get bot info
    try {
      const me = await TelegramService.getMe(this.token);
      this.botUsername = me.username;
      this.onLog(`Bot verified: @${me.username} (${me.first_name})`);
    } catch (err) {
      throw new Error(`Invalid bot token: ${err.message}`);
    }

    this.isRunning = true;
    this.abortController = new AbortController();

    this.onLog(`Started watching for messages${this.ownerChatId ? ` from chat_id=${this.ownerChatId}` : ' (awaiting /start)'}`);

    // Start poll loop (don't await — runs indefinitely)
    this.pollLoop();
  }

  /**
   * Stop watching
   */
  stop() {
    this.isRunning = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.pollTimeoutHandle) {
      clearTimeout(this.pollTimeoutHandle);
      this.pollTimeoutHandle = null;
    }
    this.onLog('Stopped');
  }

  /**
   * Get status info
   */
  getStatus() {
    return {
      running: this.isRunning,
      botUsername: this.botUsername,
      ownerChatId: this.ownerChatId,
      agentId: this.agentId,
      offset: this.offset
    };
  }
}

module.exports = { TelegramWatcher };
