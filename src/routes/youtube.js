/**
 * YouTube API routes
 * Fetch video info and transcripts from YouTube via yt-dlp
 */

const express = require('express');
const YouTubeService = require('../services/youtube');
const requireAppContext = require('../middleware/require-app-context');

function createYouTubeRouter(db, services) {
  const router = express.Router();
  router.use(requireAppContext);   // PR 1.8

  /**
   * GET /api/youtube/status
   * Check if yt-dlp is available
   */
  router.get('/status', async (req, res) => {
    try {
      const status = await YouTubeService.getStatus();
      res.json(status);
    } catch (err) {
      console.error('YouTube: Status check error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/youtube/info?url=...
   * Get video metadata (title, description, channel, duration, etc.)
   */
  router.get('/info', async (req, res) => {
    try {
      const { url } = req.query;
      if (!url) {
        return res.status(400).json({ error: 'url query parameter is required' });
      }
      if (!YouTubeService.validateUrl(url)) {
        return res.status(400).json({ error: 'Invalid YouTube URL' });
      }

      console.log('YouTube: Fetching info for:', url);
      const info = await YouTubeService.getInfo(url);
      res.json(info);

    } catch (err) {
      console.error('YouTube: Info error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/youtube/transcript?url=...&lang=en
   * Get video transcript/captions
   */
  router.get('/transcript', async (req, res) => {
    try {
      const { url, lang = 'en' } = req.query;
      if (!url) {
        return res.status(400).json({ error: 'url query parameter is required' });
      }
      if (!YouTubeService.validateUrl(url)) {
        return res.status(400).json({ error: 'Invalid YouTube URL' });
      }

      console.log('YouTube: Fetching transcript for:', url, 'lang:', lang);
      const transcript = await YouTubeService.getTranscript(url, { lang });
      res.json(transcript);

    } catch (err) {
      console.error('YouTube: Transcript error:', err);
      if (err.message.includes('No captions available')) {
        return res.status(404).json({ error: err.message });
      }
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createYouTubeRouter;

module.exports.meta = {
  name: 'youtube',
  description: 'YouTube video info and transcript extraction',
  basePath: '/api/youtube',
  endpoints: [
    { method: 'GET', path: '/status', description: 'Check if yt-dlp is available' },
    { method: 'GET', path: '/info', description: 'Get video metadata',
      params: { url: 'string, required' },
      returns: { title: 'string', duration: 'number', description: 'string' } },
    { method: 'GET', path: '/transcript', description: 'Get video transcript/captions',
      params: { url: 'string, required', lang: 'string, optional (default: en)' },
      returns: { transcript: 'string', language: 'string' } }
  ]
};
