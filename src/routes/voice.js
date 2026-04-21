/**
 * Voice/Speech API routes
 * Core voice service for OS8 - handles speech-to-text for all apps
 *
 * Uses local whisper.cpp (setup happens at OS8 startup)
 * Falls back to OpenAI API if local whisper isn't ready
 */

const express = require('express');
const multer = require('multer');
const WhisperService = require('../services/whisper');
const TTSService = require('../services/tts');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

function createVoiceRouter(db, { EnvService, SettingsService }) {
  const router = express.Router();

  /**
   * GET /api/voice/settings
   * Get voice settings for client-side use
   */
  router.get('/settings', (req, res) => {
    try {
      const settings = SettingsService.getVoiceSettings(db);
      res.json(settings);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/voice/settings
   * Update voice settings
   */
  router.post('/settings', express.json(), (req, res) => {
    try {
      const settings = SettingsService.setVoiceSettings(db, req.body);
      res.json(settings);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/voice/status
   */
  router.get('/status', (req, res) => {
    try {
      res.json({
        ready: WhisperService.isReady(),
        ...WhisperService.getStatus()
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/voice/transcribe
   * Core transcription endpoint - used by all OS8 apps
   */
  router.post('/transcribe', upload.single('audio'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No audio file provided' });
      }

      const language = req.body.language || 'en';
      const suppressNonSpeech = req.body.suppressNonSpeech === 'true' || req.body.suppressNonSpeech === true;
      const prompt = req.body.prompt || null;

      // Use local whisper if ready
      if (WhisperService.isReady()) {
        console.log('Voice: Using local whisper', suppressNonSpeech ? '(suppress non-speech)' : '');

        const result = await WhisperService.transcribeBuffer(
          req.file.buffer,
          req.file.mimetype || 'audio/webm',
          { language, suppressNonSpeech, prompt }
        );

        return res.json({
          text: result.text,
          segments: result.segments,
          source: 'local'
        });
      }

      // Fallback to OpenAI API
      console.log('Voice: Using OpenAI API (whisper not ready yet)');

      const apiKeyRecord = EnvService.get(db, 'OPENAI_API_KEY');
      if (!apiKeyRecord?.value) {
        return res.status(503).json({
          error: 'Speech-to-text is still setting up. Please wait a moment and try again.'
        });
      }

      const formData = new FormData();
      const audioBlob = new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/webm' });
      formData.append('file', audioBlob, req.file.originalname || 'audio.webm');
      formData.append('model', 'whisper-1');
      if (language) formData.append('language', language);

      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKeyRecord.value}` },
        body: formData
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return res.status(response.status).json({
          error: errorData.error?.message || `API error: ${response.status}`
        });
      }

      const result = await response.json();
      res.json({ text: result.text, source: 'api' });

    } catch (err) {
      console.error('Voice: Transcription error:', err);
      res.status(500).json({ error: err.message || 'Transcription failed' });
    }
  });

  // ============ TTS Settings ============

  /**
   * GET /api/voice/tts-settings
   * Get TTS settings for client-side use
   */
  router.get('/tts-settings', (req, res) => {
    try {
      const settings = TTSService.getSettings(db);
      res.json(settings);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/voice/tts-settings
   * Update TTS settings
   */
  router.post('/tts-settings', express.json(), (req, res) => {
    try {
      const oldSettings = TTSService.getSettings(db);
      const settings = TTSService.setSettings(db, req.body);

      // When a default voice changes, update agents still using the old default
      const AgentService = require('../services/agent');
      const currentProvider = TTSService.getProviderName(db);
      if (req.body.defaultVoiceFemale && req.body.defaultVoiceFemale !== oldSettings.defaultVoiceFemale) {
        const agents = db.prepare(`SELECT id FROM agents WHERE voice_id = ? AND (gender IS NULL OR gender = '' OR gender = 'female')`).all(oldSettings.defaultVoiceFemale);
        for (const agent of agents) {
          AgentService.update(db, agent.id, { voice_id: req.body.defaultVoiceFemale, voice_name: req.body.defaultVoiceFemaleName || '' });
          if (currentProvider) TTSService.saveAgentVoice(db, agent.id, currentProvider, req.body.defaultVoiceFemale, req.body.defaultVoiceFemaleName || '');
        }
      }
      if (req.body.defaultVoiceMale && req.body.defaultVoiceMale !== oldSettings.defaultVoiceMale) {
        const agents = db.prepare(`SELECT id FROM agents WHERE voice_id = ? AND gender = 'male'`).all(oldSettings.defaultVoiceMale);
        for (const agent of agents) {
          AgentService.update(db, agent.id, { voice_id: req.body.defaultVoiceMale, voice_name: req.body.defaultVoiceMaleName || '' });
          if (currentProvider) TTSService.saveAgentVoice(db, agent.id, currentProvider, req.body.defaultVoiceMale, req.body.defaultVoiceMaleName || '');
        }
      }

      res.json(settings);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/voice/tts-voices
   * Get available TTS voices from active provider
   */
  router.get('/tts-voices', async (req, res) => {
    try {
      const voices = await TTSService.getVoices(db);
      res.json({ voices });
    } catch (err) {
      console.error('Voice: Failed to get TTS voices:', err);
      res.status(503).json({ error: err.message });
    }
  });

  /**
   * GET /api/voice/tts-status
   * Check TTS availability — async path probes the launcher for local
   * providers so the status banner can distinguish launcher_down vs
   * model_not_serving (Phase 3-5 follow-up).
   */
  router.get('/tts-status', async (req, res) => {
    try {
      const status = await TTSService.isAvailableAsync(db);
      res.json({
        available: status.available,
        provider: status.provider,
        reason: status.reason,
        settings: TTSService.getSettings(db)
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/voice/tts-provider
   * Switch TTS provider. Whitelist comes from TTSService.PROVIDERS so adding
   * a new provider module automatically widens the accepted set; empty string
   * deselects.
   */
  router.post('/tts-provider', express.json(), (req, res) => {
    try {
      const { provider } = req.body
      const validProviders = Object.keys(TTSService.PROVIDERS)
      if (provider && !validProviders.includes(provider)) {
        return res.status(400).json({ error: `Invalid provider: ${provider}. Expected one of: ${validProviders.join(', ')} (or empty)` })
      }
      const result = TTSService.switchProvider(db, provider || '')
      res.json({ success: true, ...result })
    } catch (err) {
      console.error('Voice: Failed to switch TTS provider:', err)
      res.status(500).json({ error: err.message })
    }
  })

  return router;
}

module.exports = createVoiceRouter;
