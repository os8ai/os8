/**
 * App icon routes.
 * Upload, generate (AI), serve, and delete app icon images.
 * Images are auto-compressed to 128x128 via sharp.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sharp = require('sharp');
const { ICONS_DIR, BLOB_DIR } = require('../config');

const IMAGEGEN_DIR = path.join(BLOB_DIR, 'imagegen');

const ACCEPTED_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'
];

/**
 * Resize and compress an image buffer to 128x128 for use as an app icon.
 * Preserves transparency (outputs PNG) when alpha is detected, otherwise JPEG at 85%.
 */
async function processIconImage(buffer) {
  const metadata = await sharp(buffer).metadata();
  const hasAlpha = metadata.hasAlpha || metadata.format === 'svg';

  if (hasAlpha) {
    return {
      data: await sharp(buffer, { density: 300 })
        .resize(128, 128, { fit: 'cover' })
        .png()
        .toBuffer(),
      ext: 'png',
      mime: 'image/png'
    };
  }

  return {
    data: await sharp(buffer)
      .resize(128, 128, { fit: 'cover' })
      .jpeg({ quality: 85 })
      .toBuffer(),
    ext: 'jpg',
    mime: 'image/jpeg'
  };
}

/**
 * Remove any existing icon file for an app (handles both .png and .jpg).
 */
function removeExistingIconFile(appId) {
  for (const ext of ['png', 'jpg']) {
    const filePath = path.join(ICONS_DIR, `${appId}.${ext}`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}

function createIconRouter(db, { AppService, ImageGenService }) {
  const router = express.Router();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (ACCEPTED_TYPES.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error(`Unsupported file type: ${file.mimetype}. Accepted: ${ACCEPTED_TYPES.join(', ')}`));
      }
    }
  });

  /**
   * POST /api/icons/:appId/upload
   * Upload an image as the app icon. Auto-compressed to 128x128.
   */
  router.post('/:appId/upload', upload.single('file'), async (req, res) => {
    try {
      const { appId } = req.params;
      const app = AppService.getById(db, appId);
      if (!app) return res.status(404).json({ error: 'App not found' });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      const { data, ext, mime } = await processIconImage(req.file.buffer);

      removeExistingIconFile(appId);
      const filename = `${appId}.${ext}`;
      fs.writeFileSync(path.join(ICONS_DIR, filename), data);

      const iconMode = ext === 'png' ? 'contain' : 'cover';
      AppService.update(db, appId, { iconImage: filename, iconMode });

      const updated = AppService.getById(db, appId);
      res.json({ success: true, app: updated });
    } catch (err) {
      console.error('Icon upload error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/icons/:appId/generate
   * Generate an app icon from a text prompt using AI image generation.
   */
  router.post('/:appId/generate', express.json(), async (req, res) => {
    try {
      const { appId } = req.params;
      const app = AppService.getById(db, appId);
      if (!app) return res.status(404).json({ error: 'App not found' });

      const { prompt } = req.body;
      if (!prompt) return res.status(400).json({ error: 'prompt is required' });

      const enhancedPrompt = `App icon, square, clean minimal design, no text: ${prompt}`;
      console.log(`Icon generate: appId=${appId}, prompt="${prompt.slice(0, 80)}"`);

      const result = await ImageGenService.generate(db, enhancedPrompt);

      if (!result.images || result.images.length === 0) {
        return res.status(502).json({ error: 'Image generation returned no images' });
      }

      // Read the generated image file
      const genFilename = result.images[0].filename;
      const genPath = path.join(IMAGEGEN_DIR, genFilename);
      const imageBuffer = fs.readFileSync(genPath);

      const { data, ext } = await processIconImage(imageBuffer);

      removeExistingIconFile(appId);
      const filename = `${appId}.${ext}`;
      fs.writeFileSync(path.join(ICONS_DIR, filename), data);

      AppService.update(db, appId, { iconImage: filename, iconMode: 'cover' });

      const updated = AppService.getById(db, appId);
      console.log(`Icon generate: saved ${filename} for app ${appId}`);
      res.json({ success: true, app: updated });
    } catch (err) {
      console.error('Icon generate error:', err.message);

      if (err.message.includes('not configured') || err.message.includes('No image generation providers')) {
        return res.status(503).json({ error: err.message });
      }
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/icons/:appId
   * Serve the app's icon image file.
   */
  router.get('/:appId', (req, res) => {
    try {
      const { appId } = req.params;
      const app = AppService.getById(db, appId);
      if (!app || !app.icon_image) return res.status(404).json({ error: 'No icon image' });

      const filePath = path.join(ICONS_DIR, app.icon_image);
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Icon file not found' });

      res.set('Cache-Control', 'public, max-age=3600');
      res.sendFile(filePath);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * DELETE /api/icons/:appId
   * Remove the app's icon image, reverting to text icon.
   */
  router.delete('/:appId', (req, res) => {
    try {
      const { appId } = req.params;
      const app = AppService.getById(db, appId);
      if (!app) return res.status(404).json({ error: 'App not found' });

      removeExistingIconFile(appId);
      AppService.update(db, appId, { iconImage: null, iconMode: null });

      const updated = AppService.getById(db, appId);
      res.json({ success: true, app: updated });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createIconRouter;

module.exports.meta = {
  name: 'icon-builder',
  description: 'Generate or upload app icons. AI-generated icons from text prompts, or upload custom images. Auto-compressed to 128x128.',
  basePath: '/api/icons',
  endpoints: [
    { method: 'POST', path: '/:appId/upload', description: 'Upload image as app icon (multipart form, field: "file")',
      params: { file: 'multipart file, required (jpg/png/gif/webp/svg)' },
      returns: { app: 'updated app object' } },
    { method: 'POST', path: '/:appId/generate', description: 'Generate icon from text prompt using AI image generation',
      params: { prompt: 'string, required — describe the icon visually' },
      returns: { app: 'updated app object' } },
    { method: 'GET', path: '/:appId', description: 'Serve the app icon image file' },
    { method: 'DELETE', path: '/:appId', description: 'Remove app icon image, revert to text icon' }
  ]
};
