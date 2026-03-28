/**
 * Video Transcription API routes
 * Converts video files to text transcripts using local whisper.cpp
 */

const express = require('express');
const TranscribeService = require('../services/transcribe');

function createTranscribeRouter(db, services) {
  const router = express.Router();

  /**
   * GET /api/transcribe/status
   * Check if transcription service is ready
   */
  router.get('/status', async (req, res) => {
    try {
      const status = await TranscribeService.getStatus();
      res.json(status);
    } catch (err) {
      console.error('Transcribe: Status check error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/transcribe
   * Transcribe a video file to text
   *
   * Body: { videoPath: "/path/to/video.mp4", language?: "en" }
   * Returns: { text, segments, duration, source }
   */
  router.post('/', express.json(), async (req, res) => {
    try {
      const { videoPath, language = 'en', wordTimestamps = false, suppressNonSpeech = false, prompt } = req.body;

      if (!videoPath) {
        return res.status(400).json({ error: 'videoPath is required' });
      }

      console.log('Transcribe: Starting transcription for:', videoPath);

      const result = await TranscribeService.transcribe(
        videoPath,
        { language, wordTimestamps, suppressNonSpeech, prompt },
        (progress) => {
          // Could use SSE for progress in future
          console.log('Transcribe progress:', progress.phase, Math.round(progress.progress * 100) + '%');
        }
      );

      console.log('Transcribe: Complete, text length:', result.text.length);

      res.json(result);

    } catch (err) {
      console.error('Transcribe: Error:', err);

      // Provide helpful error messages
      if (err.message.includes('not found')) {
        return res.status(404).json({ error: err.message });
      }
      if (err.message.includes('FFmpeg')) {
        return res.status(503).json({ error: err.message });
      }
      if (err.message.includes('Whisper')) {
        return res.status(503).json({ error: err.message });
      }

      res.status(500).json({ error: err.message || 'Transcription failed' });
    }
  });

  return router;
}

module.exports = createTranscribeRouter;

module.exports.meta = {
  name: 'transcribe',
  description: 'Video and audio file transcription to text',
  basePath: '/api/transcribe',
  endpoints: [
    { method: 'GET', path: '/status', description: 'Check if transcription service is ready' },
    { method: 'POST', path: '/', description: 'Transcribe video/audio file to text',
      params: { filePath: 'string, required' },
      returns: { text: 'string', duration: 'number' } }
  ]
};
