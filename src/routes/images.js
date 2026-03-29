/**
 * Images API Route
 * Handles POST /api/assistant/images for storing current images in the database
 * Images are automatically compressed to JPEG before storage
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const ConversationService = require('../services/conversation');
const { compressImageBuffer, shouldCompress } = require('../utils/image-compress');

/**
 * Detect actual image media type from file header bytes
 * @param {Buffer} buffer - First few bytes of the file
 * @returns {string} Media type (image/png or image/jpeg)
 */
function detectImageMediaType(buffer) {
  // PNG magic bytes: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return 'image/png';
  }
  // JPEG magic bytes: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return 'image/jpeg';
  }
  // Default to png if unknown
  return 'image/png';
}

/**
 * Parse timestamp from filename
 * Format: 2026-02-04-0337-agent.png or 2026-02-04-0337-agent-pov.png
 * @param {string} filename - Image filename
 * @returns {string} ISO 8601 timestamp in UTC
 */
function parseTimestampFromFilename(filename) {
  // Match pattern: YYYY-MM-DD-HHMM
  const match = filename.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})/);
  if (!match) {
    // Fallback to current time
    return new Date().toISOString();
  }

  const [, year, month, day, hour, minute] = match;

  // Filename timestamps are in local (Eastern) time.
  // new Date() without 'Z' suffix interprets as local timezone,
  // and .toISOString() converts to UTC automatically.
  const localDate = new Date(`${year}-${month}-${day}T${hour}:${minute}:00`);

  return localDate.toISOString();
}

/**
 * Determine image view type from filename
 * @param {string} filename - Image filename
 * @returns {string} 'third_person' or 'pov'
 */
function getImageViewFromFilename(filename) {
  if (filename.includes('-pov.')) {
    return 'pov';
  }
  return 'third_person';
}

/**
 * Resolve the agent whose images we're storing/querying.
 * If req.agentId is set (agent-scoped route), use that agent.
 * Otherwise fall back to the default agent (legacy route).
 */
function resolveAgent(db, req, AppService) {
  const AgentService = require('../services/agent');
  if (req.agentId) {
    const agent = AgentService.getById(db, req.agentId);
    if (agent) return agent;
  }
  return AgentService.getDefault(db) || AppService.getAssistant(db);
}

/**
 * Create images router
 * @param {object} db - Database instance
 * @param {object} deps - Dependencies
 * @returns {Router} Express router
 */
function createImagesRouter(db, deps) {
  const { AppService } = deps;
  const router = express.Router();

  /**
   * POST /api/assistant/images
   * Store one or more images in the database
   * Images are automatically compressed to JPEG before storage
   *
   * Body (single image):
   * { "filename": "2026-02-04-0337-agent.png", "path": "/path/to/image.png" }
   *
   * Body (batch):
   * { "images": [{ "filename": "...", "path": "..." }, ...] }
   */
  router.post('/', async (req, res) => {
    const assistant = db ? resolveAgent(db, req, AppService) : null;
    if (!assistant) {
      return res.status(404).json({ error: 'Assistant not found' });
    }

    // Handle both single and batch formats
    let images = [];
    if (req.body.images && Array.isArray(req.body.images)) {
      images = req.body.images;
    } else if (req.body.filename && req.body.path) {
      images = [{ filename: req.body.filename, path: req.body.path }];
    } else {
      return res.status(400).json({ error: 'Missing filename and path, or images array' });
    }

    const results = [];
    const errors = [];

    for (const img of images) {
      try {
        const { filename, path: filePath } = img;

        // Check if file exists
        if (!fs.existsSync(filePath)) {
          errors.push({ filename, error: 'File not found' });
          continue;
        }

        // Check if already imported
        if (ConversationService.imageExists(db, assistant.id, filename)) {
          errors.push({ filename, error: 'Image already exists' });
          continue;
        }

        // Read image
        const buffer = fs.readFileSync(filePath);
        const originalSizeKB = Math.round(buffer.length / 1024);

        // Compress if image is large enough
        let imageData, mediaType, compressedSizeKB;
        if (shouldCompress(buffer.length)) {
          try {
            const compressed = await compressImageBuffer(buffer);
            imageData = compressed.data;
            mediaType = compressed.mediaType;
            compressedSizeKB = Math.round(compressed.compressedSize / 1024);
            console.log(`[Images] ${filename}: ${originalSizeKB} KB → ${compressedSizeKB} KB compressed`);
          } catch (compErr) {
            console.warn(`[Images] ${filename}: Compression failed, using original - ${compErr.message}`);
            mediaType = detectImageMediaType(buffer);
            imageData = buffer.toString('base64');
          }
        } else {
          mediaType = detectImageMediaType(buffer);
          imageData = buffer.toString('base64');
          console.log(`[Images] ${filename}: ${originalSizeKB} KB (no compression needed)`);
        }

        // Parse metadata from filename
        const timestamp = parseTimestampFromFilename(filename);
        const imageView = getImageViewFromFilename(filename);

        // Store in database
        const entry = ConversationService.addImageEntry(db, assistant.id, {
          imageData,
          mediaType,
          imageView,
          timestamp,
          originalFilename: filename
        });

        results.push({
          id: entry.id,
          filename,
          timestamp: entry.timestamp,
          imageView,
          mediaType,
          originalSizeKB,
          compressedSizeKB: compressedSizeKB || originalSizeKB
        });

      } catch (err) {
        errors.push({ filename: img.filename, error: err.message });
      }
    }

    res.json({
      success: true,
      imported: results.length,
      skipped: errors.length,
      entries: results,
      errors: errors.length > 0 ? errors : undefined
    });
  });

  /**
   * GET /api/assistant/images/recent
   * Get the N most recent images
   */
  router.get('/recent', (req, res) => {
    const assistant = db ? resolveAgent(db, req, AppService) : null;
    if (!assistant) {
      return res.status(404).json({ error: 'Assistant not found' });
    }

    const limit = parseInt(req.query.limit) || 10;
    const images = ConversationService.getRecentImages(db, assistant.id, limit);

    // Don't send full image_data in list view (too large)
    const summary = images.map(img => ({
      id: img.id,
      timestamp: img.timestamp,
      imageView: img.metadata?.image_view,
      mediaType: img.metadata?.media_type,
      filename: img.metadata?.original_filename
    }));

    res.json({ images: summary });
  });

  /**
   * GET /api/assistant/images/current
   * Get the current (most recent) images for each view type
   */
  router.get('/current', (req, res) => {
    const assistant = db ? resolveAgent(db, req, AppService) : null;
    if (!assistant) {
      return res.status(404).json({ error: 'Assistant not found' });
    }

    const current = ConversationService.getCurrentImages(db, assistant.id);

    // Include full image_data for current images (needed for context)
    res.json({
      thirdPerson: current.thirdPerson ? {
        id: current.thirdPerson.id,
        timestamp: current.thirdPerson.timestamp,
        imageView: current.thirdPerson.metadata?.image_view,
        mediaType: current.thirdPerson.metadata?.media_type,
        imageData: current.thirdPerson.image_data
      } : null,
      pov: current.pov ? {
        id: current.pov.id,
        timestamp: current.pov.timestamp,
        imageView: current.pov.metadata?.image_view,
        mediaType: current.pov.metadata?.media_type,
        imageData: current.pov.image_data
      } : null
    });
  });

  /**
   * GET /api/assistant/images/stats
   * Get image statistics
   */
  router.get('/stats', (req, res) => {
    const assistant = db ? resolveAgent(db, req, AppService) : null;
    if (!assistant) {
      return res.status(404).json({ error: 'Assistant not found' });
    }

    const countStmt = db.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN json_extract(metadata, '$.image_view') = 'third_person' THEN 1 ELSE 0 END) as third_person,
             SUM(CASE WHEN json_extract(metadata, '$.image_view') = 'pov' THEN 1 ELSE 0 END) as pov
      FROM conversation_entries
      WHERE app_id = ? AND type = 'image'
    `);

    const stats = countStmt.get(assistant.id);

    // Get date range
    const rangeStmt = db.prepare(`
      SELECT MIN(timestamp) as oldest, MAX(timestamp) as newest
      FROM conversation_entries
      WHERE app_id = ? AND type = 'image'
    `);

    const range = rangeStmt.get(assistant.id);

    res.json({
      total: stats.total || 0,
      thirdPerson: stats.third_person || 0,
      pov: stats.pov || 0,
      oldestImage: range.oldest,
      newestImage: range.newest
    });
  });

  /**
   * DELETE /api/agent/:agentId/images/by-filename/:filename
   * Delete an image entry from the database by its original filename
   */
  router.delete('/by-filename/:filename', (req, res) => {
    const assistant = db ? resolveAgent(db, req, AppService) : null;
    if (!assistant) {
      return res.status(404).json({ error: 'Assistant not found' });
    }

    const { filename } = req.params;
    if (!filename) return res.status(400).json({ error: 'filename is required' });

    const result = db.prepare(`
      DELETE FROM conversation_entries
      WHERE app_id = ? AND type = 'image'
        AND json_extract(metadata, '$.original_filename') = ?
    `).run(assistant.id, filename);

    res.json({ success: true, deleted: result.changes });
  });

  return router;
}

module.exports = createImagesRouter;

module.exports.meta = {
  name: 'images',
  description: 'Agent image storage — store and retrieve POV/third-person snapshots',
  basePath: '/api/images',
  endpoints: [
    { method: 'POST', path: '/', description: 'Store images in database',
      params: { imageData: 'base64 string or array, required', viewType: 'string, optional' } },
    { method: 'GET', path: '/recent', description: 'Get recent images',
      params: { limit: 'number, optional' } },
    { method: 'GET', path: '/current', description: 'Get current images by view type' },
    { method: 'GET', path: '/stats', description: 'Image statistics' }
  ]
};
