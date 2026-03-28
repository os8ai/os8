/**
 * Voice Message API route
 * Generates audio from text and sends via Telegram
 * Uses friendly timestamp filename like "Feb2-853pm.mp3"
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const SpeakService = require('../services/speak');
const TelegramService = require('../services/telegram');
const { MemoryService } = require('../assistant/memory');

function createVoiceMessageRouter(db, { AgentService }) {
  const router = express.Router();

  /**
   * Generate a friendly timestamp filename like "Feb2-853pm.mp3" in US Eastern time
   */
  function getFriendlyFilename() {
    // Use US Eastern timezone
    const now = new Date();
    const eastern = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));

    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = months[eastern.getMonth()];
    const day = eastern.getDate();
    let hours = eastern.getHours();
    const minutes = eastern.getMinutes().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'pm' : 'am';
    hours = hours % 12 || 12;

    return `${month}${day}-${hours}${minutes}${ampm}.mp3`;
  }

  /**
   * Look up Telegram bot token + chat ID for an agent
   */
  function getTelegramConfig(agentId) {
    const agent = AgentService.getById(db, agentId);
    if (!agent) return null;
    const config = AgentService.getConfig(db, agentId);
    return {
      token: config.telegramBotToken,
      chatId: config.telegramChatId,
      agent
    };
  }

  /**
   * GET /api/voicemessage/status?agentId=...
   * Check if voice message service is ready
   */
  router.get('/status', async (req, res) => {
    try {
      const { agentId } = req.query;
      const speakStatus = SpeakService.getStatus(db);

      let telegramReady = false;
      if (agentId) {
        const tg = getTelegramConfig(agentId);
        telegramReady = !!(tg && tg.token && tg.chatId);
      }

      res.json({
        ready: speakStatus.ready && telegramReady,
        speak: speakStatus.ready,
        telegram: telegramReady,
        details: {
          hasElevenLabsKey: speakStatus.hasApiKey,
          hasTelegramConfig: telegramReady
        }
      });
    } catch (err) {
      console.error('VoiceMessage: Status check error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/voicemessage
   * Generate voice message and send via Telegram
   *
   * Body: {
   *   agentId: string (required),
   *   message: string (required),
   *   voiceId?: string (optional, uses TTS settings default)
   * }
   */
  router.post('/', express.json(), async (req, res) => {
    let originalMp3Path = null;
    let friendlyMp3Path = null;

    try {
      const { agentId, message, voiceId } = req.body;

      if (!message) {
        return res.status(400).json({ error: 'message is required' });
      }
      if (!agentId) {
        return res.status(400).json({ error: 'agentId is required' });
      }

      const tg = getTelegramConfig(agentId);
      if (!tg || !tg.token) {
        return res.status(503).json({
          error: 'No Telegram bot token configured for this agent.'
        });
      }
      if (!tg.chatId) {
        return res.status(503).json({
          error: 'No Telegram chat ID configured for this agent.'
        });
      }

      // Resolve voice: explicit param → agent's voice → gendered default → TTS default
      let effectiveVoiceId = voiceId || tg.agent.voice_id;
      if (!effectiveVoiceId && tg.agent.gender) {
        const ttsSettings = require('../services/tts').getSettings(db);
        effectiveVoiceId = tg.agent.gender === 'male' ? ttsSettings.defaultVoiceMale : ttsSettings.defaultVoiceFemale;
      }

      console.log('VoiceMessage: Generating audio for message length:', message.length);

      // Step 1: Generate MP3 via ElevenLabs
      const speakResult = await SpeakService.generateAudio(db, message, { voiceId: effectiveVoiceId });

      if (!speakResult.success) {
        return res.status(500).json({ error: 'Failed to generate audio', details: speakResult });
      }

      originalMp3Path = speakResult.filePath;
      console.log('VoiceMessage: Generated MP3:', originalMp3Path);

      // Step 2: Rename to friendly filename (e.g., "Feb2-853pm.mp3")
      const friendlyFilename = getFriendlyFilename();
      friendlyMp3Path = path.join(path.dirname(originalMp3Path), friendlyFilename);
      fs.renameSync(originalMp3Path, friendlyMp3Path);
      console.log('VoiceMessage: Renamed to:', friendlyMp3Path);

      // Step 3: Send via Telegram
      console.log('VoiceMessage: Sending via Telegram...');
      await TelegramService.sendAudio(tg.token, tg.chatId, friendlyMp3Path);

      console.log('VoiceMessage: Sent successfully');

      // Log the voice message text to memory
      try {
        const { agentDir } = AgentService.getPaths(tg.agent.app_id || tg.agent.id, tg.agent.id);
        const memory = new MemoryService(agentDir, db, tg.agent.id);
        memory.appendToTodayNote('Conversations', `**Assistant:** [Voice Message sent via Telegram] ${message}`);
        console.log('VoiceMessage: Logged to memory');
      } catch (logErr) {
        console.warn('VoiceMessage: Failed to log to memory:', logErr.message);
      }

      // Clean up MP3
      try {
        if (friendlyMp3Path && fs.existsSync(friendlyMp3Path)) {
          fs.unlinkSync(friendlyMp3Path);
          console.log('VoiceMessage: Cleaned up MP3');
        }
      } catch (e) {
        console.error('VoiceMessage: Failed to clean up MP3:', e.message);
      }

      res.json({
        success: true,
        messageLength: message.length,
        duration: speakResult.duration,
        voiceId: speakResult.voiceId,
        filename: friendlyFilename
      });

    } catch (err) {
      console.error('VoiceMessage: Error:', err);

      // Clean up temp files on error
      try {
        if (originalMp3Path && fs.existsSync(originalMp3Path)) fs.unlinkSync(originalMp3Path);
        if (friendlyMp3Path && fs.existsSync(friendlyMp3Path)) fs.unlinkSync(friendlyMp3Path);
      } catch (e) {}

      if (err.message.includes('API key')) {
        return res.status(503).json({ error: err.message });
      }

      res.status(500).json({ error: err.message || 'Voice message failed' });
    }
  });

  return router;
}

module.exports = createVoiceMessageRouter;

module.exports.meta = {
  name: 'voicemessage',
  description: 'Generate voice messages and send via Telegram',
  basePath: '/api/voicemessage',
  endpoints: [
    { method: 'GET', path: '/status', description: 'Check if voice message service is ready',
      params: { agentId: 'query string, required' } },
    { method: 'POST', path: '/', description: 'Generate voice message and send via Telegram',
      params: { text: 'string, required', agentId: 'string, required' },
      returns: { success: 'boolean', audioUrl: 'string', telegramResult: 'object' } }
  ]
};
