/**
 * Per-app blob storage routes.
 * Provides REST API for apps to upload, read, list, and delete files
 * in their blob directory (~/os8/blob/{appId}/).
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { BLOB_DIR } = require('../config');

function createAppBlobRouter(db, { AppService }) {
  const router = express.Router({ mergeParams: true });

  // Middleware: validate appId exists in the apps table
  router.use((req, res, next) => {
    const { appId } = req.params;
    if (!appId) return res.status(400).json({ error: 'appId is required' });

    const app = AppService.getById(db, appId);
    if (!app) return res.status(404).json({ error: 'App not found' });

    req.appRecord = app;
    req.blobDir = path.join(BLOB_DIR, appId);
    next();
  });

  /**
   * Validate a path has no traversal segments and resolves within the blob dir.
   * Returns the resolved absolute path, or null if invalid.
   */
  function safePath(blobDir, relativePath) {
    if (!relativePath) return blobDir;

    const segments = relativePath.split('/').filter(Boolean);
    if (segments.some(s => s === '..' || s === '.')) return null;

    const resolved = path.resolve(blobDir, ...segments);
    if (!resolved.startsWith(blobDir)) return null;

    return resolved;
  }

  // GET / — list files in blob root or subdirectory
  router.get('/', (req, res) => {
    try {
      const subPath = req.query.path || '';
      const dir = safePath(req.blobDir, subPath);
      if (!dir) return res.status(400).json({ error: 'Invalid path' });

      if (!fs.existsSync(dir)) {
        return res.json({ files: [] });
      }

      const stat = fs.statSync(dir);
      if (!stat.isDirectory()) {
        return res.status(400).json({ error: 'Path is not a directory' });
      }

      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const files = entries.map(entry => {
        const fullPath = path.join(dir, entry.name);
        try {
          const s = fs.statSync(fullPath);
          return {
            name: entry.name,
            size: s.size,
            isDirectory: entry.isDirectory(),
            modified: s.mtime.toISOString(),
          };
        } catch {
          return { name: entry.name, size: 0, isDirectory: entry.isDirectory(), modified: null };
        }
      });

      res.json({ files });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /file/*path — serve a file
  router.get('/file/*path', (req, res) => {
    try {
      const segments = req.params.path;
      if (!segments || segments.length === 0) {
        return res.status(400).json({ error: 'File path is required' });
      }

      const filePath = safePath(req.blobDir, segments.join('/'));
      if (!filePath) return res.status(400).json({ error: 'Invalid path' });

      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
      }

      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        return res.status(400).json({ error: 'Path is a directory, not a file' });
      }

      res.sendFile(filePath);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /upload — upload a file via multipart form
  // Form fields: file (required), path (optional subdirectory)
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const subDir = req.body.path || '';
        const dir = safePath(req.blobDir, subDir);
        if (!dir) return cb(new Error('Invalid upload path'));

        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${file.originalname}`);
      }
    }),
    limits: { fileSize: 20 * 1024 * 1024 } // 20 MB
  });

  router.post('/upload', upload.single('file'), (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      const appId = req.params.appId;
      const subDir = req.body.path || '';
      const filePath = subDir ? `${subDir}/${req.file.filename}` : req.file.filename;

      res.json({
        filename: req.file.filename,
        url: `/api/apps/${appId}/blob/file/${filePath}`,
        mimeType: req.file.mimetype,
        size: req.file.size,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /file/*path — delete a file
  router.delete('/file/*path', (req, res) => {
    try {
      const segments = req.params.path;
      if (!segments || segments.length === 0) {
        return res.status(400).json({ error: 'File path is required' });
      }

      const filePath = safePath(req.blobDir, segments.join('/'));
      if (!filePath) return res.status(400).json({ error: 'Invalid path' });

      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
      }

      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        return res.status(400).json({ error: 'Cannot delete a directory via this endpoint' });
      }

      fs.unlinkSync(filePath);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createAppBlobRouter;

module.exports.meta = {
  name: 'app-blob',
  description: 'Per-app file storage for uploads, images, and generated assets. Each app has its own blob directory.',
  basePath: '/api/apps/:appId/blob',
  endpoints: [
    { method: 'GET', path: '/', description: 'List files in blob directory (optional ?path= for subdirectory)' },
    { method: 'GET', path: '/file/*path', description: 'Serve a file (binary response with Content-Type)' },
    { method: 'POST', path: '/upload', description: 'Upload a file (multipart form, field: "file", optional field: "path" for subdirectory)' },
    { method: 'DELETE', path: '/file/*path', description: 'Delete a file' }
  ]
};
