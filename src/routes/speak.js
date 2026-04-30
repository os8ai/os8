/**
 * Speak API routes
 * Generate audio files from text using ElevenLabs
 */

const express = require('express');
const SpeakService = require('../services/speak');
const requireAppContext = require('../middleware/require-app-context');

function createSpeakRouter(db, { AgentService } = {}) {
  const router = express.Router();
  router.use(requireAppContext);   // PR 1.8 — set req.callerAppId for external apps

  /**
   * GET /api/speak/status
   * Check if speak service is ready
   */
  router.get('/status', (req, res) => {
    try {
      const status = SpeakService.getStatus(db);
      res.json(status);
    } catch (err) {
      console.error('Speak: Status check error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/speak
   * Generate audio from text
   *
   * Body: {
   *   text: string (required, max 5000 chars),
   *   voiceId?: string,
   *   model?: string,
   *   stability?: number (0-1),
   *   similarityBoost?: number (0-1),
   *   returnBase64?: boolean
   * }
   */
  router.post('/', express.json(), async (req, res) => {
    try {
      const { text, voiceId, agentId, model, stability, similarityBoost, returnBase64 } = req.body;

      if (!text) {
        return res.status(400).json({ error: 'text is required' });
      }

      // Resolve voice: explicit param → agent's voice → gendered default → TTS default
      let effectiveVoiceId = voiceId;
      if (!effectiveVoiceId && agentId && AgentService) {
        const agent = AgentService.getById(db, agentId);
        if (agent) {
          effectiveVoiceId = agent.voice_id;
          if (!effectiveVoiceId && agent.gender) {
            const TTSService = require('../services/tts');
            const ttsSettings = TTSService.getSettings(db);
            effectiveVoiceId = agent.gender === 'male' ? ttsSettings.defaultVoiceMale : ttsSettings.defaultVoiceFemale;
          }
        }
      }

      console.log('Speak: Generating audio for text length:', text.length);

      const result = await SpeakService.generateAudio(db, text, {
        voiceId: effectiveVoiceId,
        model,
        stability,
        similarityBoost,
        returnBase64
      });

      res.json(result);

    } catch (err) {
      console.error('Speak: Error:', err);

      if (err.message.includes('API key')) {
        return res.status(503).json({ error: err.message });
      }
      if (err.message.includes('maximum length')) {
        return res.status(400).json({ error: err.message });
      }
      if (err.message.includes('ElevenLabs API error')) {
        return res.status(502).json({ error: err.message });
      }

      res.status(500).json({ error: err.message || 'Audio generation failed' });
    }
  });

  /**
   * GET /api/speak/files
   * List generated audio files
   */
  router.get('/files', (req, res) => {
    try {
      const files = SpeakService.listFiles();
      res.json({ files });
    } catch (err) {
      console.error('Speak: List files error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * DELETE /api/speak/files/:filename
   * Delete a generated audio file
   */
  router.delete('/files/:filename', (req, res) => {
    try {
      const { filename } = req.params;
      const result = SpeakService.deleteFile(filename);
      res.json(result);
    } catch (err) {
      console.error('Speak: Delete file error:', err);

      if (err.message.includes('not found')) {
        return res.status(404).json({ error: err.message });
      }

      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/speak/cleanup
   * Clean up old audio files
   *
   * Body: { olderThanDays?: number (default 7) }
   */
  router.post('/cleanup', express.json(), (req, res) => {
    try {
      const { olderThanDays = 7 } = req.body || {};
      const result = SpeakService.cleanup(olderThanDays);
      res.json(result);
    } catch (err) {
      console.error('Speak: Cleanup error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createSpeakRouter;

module.exports.meta = {
  name: 'speak',
  description: 'Convert text to speech audio using active TTS provider',
  basePath: '/api/speak',
  endpoints: [
    { method: 'GET', path: '/status', description: 'Check if speak service is ready' },
    { method: 'POST', path: '/', description: 'Generate audio from text',
      params: { text: 'string, required', voiceId: 'string, optional', agentId: 'string, optional' },
      returns: { url: 'string', filename: 'string' } },
    { method: 'GET', path: '/files/:filename', description: 'Serve a generated audio file' },
    { method: 'DELETE', path: '/files/:filename', description: 'Delete an audio file' }
  ]
};
