/**
 * ImageGen API routes
 * Generate images using OpenAI or Google Gemini
 */

const express = require('express');
const path = require('path');
const ImageGenService = require('../services/imagegen');
const requireAppContext = require('../middleware/require-app-context');

function createImageGenRouter(db, services) {
  const router = express.Router();
  // PR 1.8: surface req.callerAppId for external-app callers (set by
  // PR 1.7's scopedApiMiddleware via X-OS8-App-Id). Native shell calls
  // pass through without the header.
  router.use(requireAppContext);

  /**
   * GET /api/imagegen/status
   * Check if image generation service is ready
   */
  router.get('/status', (req, res) => {
    try {
      const status = ImageGenService.getStatus(db);
      res.json(status);
    } catch (err) {
      console.error('ImageGen: Status check error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/imagegen
   * Generate image from prompt
   *
   * Body: {
   *   prompt: string (required),
   *   provider?: 'openai' | 'grok' | 'gemini' | 'auto' (default: 'openai'),
   *   model?: string,
   *   referenceImages?: Array<{ data: string (base64), mimeType: string }>,
   *   referenceImagePaths?: string[] (local file paths - preferred for large images),
   *   mask?: { data: string (base64), mimeType: string },
   *   options?: {
   *     size?: string (default: '1024x1024'),
   *     quality?: 'low' | 'medium' | 'high' (default: 'medium'),
   *     n?: number (1-4, default: 1)
   *   }
   * }
   */
  router.post('/', express.json({ limit: '100mb' }), async (req, res) => {
    try {
      const { prompt, provider, model, referenceImages, referenceImagePaths, mask, options } = req.body;

      if (!prompt) {
        return res.status(400).json({ error: 'prompt is required' });
      }

      const refCount = (referenceImages?.length || 0) + (referenceImagePaths?.length || 0);
      console.log(`ImageGen: Request — provider: ${provider || 'auto'}, refs: ${refCount}, prompt: "${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}"`);
      if (referenceImagePaths?.length > 0) {
        console.log(`ImageGen: Ref paths: ${referenceImagePaths.map(p => path.basename(p)).join(', ')}`);
      }

      const result = await ImageGenService.generate(db, prompt, {
        provider,
        referenceImages,
        referenceImagePaths,
        mask,
        options: {
          model,
          ...options
        }
      });

      console.log(`ImageGen: Success — provider: ${result.provider}, file: ${result.images?.[0]?.filename || '?'}${result.fallbackFrom ? ` (fallback from ${result.fallbackFrom.join(', ')})` : ''}`);
      res.json(result);

    } catch (err) {
      console.error(`ImageGen: FAILED — ${err.message}`);

      if (err.message.includes('prompt is required')) {
        return res.status(400).json({ error: err.message });
      }
      if (err.message.includes('Invalid provider')) {
        return res.status(400).json({ error: err.message });
      }
      if (err.message.includes('not configured') || err.message.includes('No image generation providers')) {
        return res.status(503).json({ error: err.message });
      }
      if (err.message.includes('Rate limited')) {
        return res.status(429).json({ error: err.message });
      }
      if (err.message.includes('API error') || err.message.includes('All providers rejected')) {
        return res.status(502).json({ error: err.message });
      }

      res.status(500).json({ error: err.message || 'Image generation failed' });
    }
  });

  /**
   * GET /api/imagegen/files
   * List generated images
   */
  router.get('/files', (req, res) => {
    try {
      const files = ImageGenService.listFiles();
      res.json({ files });
    } catch (err) {
      console.error('ImageGen: List files error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/imagegen/files/:filename
   * Get a generated image file
   */
  router.get('/files/:filename', (req, res) => {
    try {
      const { filename } = req.params;
      const filePath = ImageGenService.getFilePath(filename);

      if (!filePath) {
        return res.status(404).json({ error: `Image not found: ${filename}` });
      }

      // Determine content type
      const ext = path.extname(filename).toLowerCase();
      const contentTypes = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp'
      };
      const contentType = contentTypes[ext] || 'application/octet-stream';

      res.setHeader('Content-Type', contentType);
      res.sendFile(filePath);
    } catch (err) {
      console.error('ImageGen: Get file error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * DELETE /api/imagegen/files/:filename
   * Delete a generated image
   */
  router.delete('/files/:filename', (req, res) => {
    try {
      const { filename } = req.params;
      const result = ImageGenService.deleteFile(filename);
      res.json(result);
    } catch (err) {
      console.error('ImageGen: Delete file error:', err);

      if (err.message.includes('not found')) {
        return res.status(404).json({ error: err.message });
      }

      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createImageGenRouter;

module.exports.meta = {
  name: 'imagegen',
  description: 'AI image generation (supports OpenAI, Grok, Gemini providers)',
  basePath: '/api/imagegen',
  endpoints: [
    { method: 'GET', path: '/status', description: 'Check if image generation is ready' },
    { method: 'POST', path: '/', description: 'Generate image from prompt',
      params: { prompt: 'string, required', provider: 'string, optional (openai|grok|gemini)', referenceImages: 'array of paths, optional', output: 'string, optional — save path' },
      returns: { url: 'string', filename: 'string' } },
    { method: 'GET', path: '/files/:filename', description: 'Serve a generated image file' },
    { method: 'DELETE', path: '/files/:filename', description: 'Delete a generated image file' }
  ]
};
