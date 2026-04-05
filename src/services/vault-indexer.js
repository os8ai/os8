/**
 * VaultIndexerService — Filesystem scanning, text extraction, change detection.
 * Handles the "read side" of Vault: indexing user files without copying them.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { generateId } = require('../utils');
const { chunkText, getEmbedder, embeddingToBuffer, cleanTextForEmbedding } = require('../assistant/memory-embeddings');

// ============================================================
// Constants
// ============================================================

const SUPPORTED_EXTENSIONS = {
  text: ['.md', '.txt', '.rtf'],
  code: ['.js', '.py', '.ts', '.go', '.rs', '.java', '.c', '.cpp', '.rb', '.sh', '.css', '.html', '.json', '.yaml', '.toml', '.jsx', '.tsx', '.vue', '.swift', '.kt'],
  document: ['.pdf'],
  image: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'],
};

const ALL_SUPPORTED = Object.values(SUPPORTED_EXTENSIONS).flat();

const DEFAULT_IGNORE_DIRS = new Set([
  'node_modules', '.git', '.svn', '__pycache__', 'build', 'dist',
  '.next', '.cache', '.vscode', '.idea', '.DS_Store', 'Thumbs.db',
  'vendor', '.nuxt', '.output', 'coverage', '.turbo',
]);

const DEFAULT_IGNORE_EXTENSIONS = new Set([
  '.min.js', '.min.css', '.map', '.lock', '.sqlite', '.db',
  '.wasm', '.dylib', '.so', '.o', '.pyc', '.class',
]);

const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 50;

// ============================================================
// File utilities
// ============================================================

/**
 * Recursively walk a directory, returning supported file entries.
 * Async to avoid blocking the event loop on large trees.
 */
async function walkDirectory(dirPath, { recursive = true, fileExtensions = null } = {}) {
  const results = [];
  const allowedExts = fileExtensions ? new Set(fileExtensions) : null;

  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // Permission denied or gone — skip
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (DEFAULT_IGNORE_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith('.')) continue;
        if (recursive) await walk(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (DEFAULT_IGNORE_EXTENSIONS.has(ext)) continue;
      if (!ALL_SUPPORTED.includes(ext)) continue;
      if (allowedExts && !allowedExts.has(ext)) continue;

      try {
        const stat = await fsp.stat(fullPath);
        results.push({
          filePath: fullPath,
          filename: entry.name,
          extension: ext,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
        });
      } catch {
        // stat failed — skip
      }

      // Yield periodically to keep the event loop responsive
      if (results.length % 100 === 0) {
        await new Promise(r => setImmediate(r));
      }
    }
  }

  await walk(dirPath);
  return results;
}

/**
 * SHA-256 hash of file content. For large files (>10MB), hash first 10MB only.
 * Stream-based to avoid blocking the event loop.
 */
async function computeFileHash(filePath) {
  const MAX_BYTES = 10 * 1024 * 1024;
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath, { start: 0, end: MAX_BYTES - 1 });
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

// ============================================================
// Text extraction
// ============================================================

function getFileCategory(extension) {
  for (const [cat, exts] of Object.entries(SUPPORTED_EXTENSIONS)) {
    if (exts.includes(extension)) return cat;
  }
  return null;
}

function getMimeType(ext) {
  const map = {
    '.md': 'text/markdown', '.txt': 'text/plain', '.rtf': 'application/rtf',
    '.pdf': 'application/pdf',
    '.js': 'text/javascript', '.ts': 'text/typescript', '.py': 'text/x-python',
    '.json': 'application/json', '.html': 'text/html', '.css': 'text/css',
    '.yaml': 'text/yaml', '.toml': 'text/toml',
    '.go': 'text/x-go', '.rs': 'text/x-rust', '.java': 'text/x-java',
    '.c': 'text/x-c', '.cpp': 'text/x-c++', '.rb': 'text/x-ruby',
    '.sh': 'text/x-shellscript', '.jsx': 'text/javascript', '.tsx': 'text/typescript',
    '.vue': 'text/x-vue', '.swift': 'text/x-swift', '.kt': 'text/x-kotlin',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  };
  return map[ext] || 'application/octet-stream';
}

/**
 * Extract text from a file based on its extension.
 * Returns { text, wordCount } or null if skipped/failed.
 */
async function extractText(filePath, extension) {
  const category = getFileCategory(extension);

  if (category === 'image') {
    return null; // OCR deferred
  }

  if (category === 'text' || category === 'code') {
    try {
      const stat = await fsp.stat(filePath);
      if (stat.size > 5 * 1024 * 1024) return null; // Skip files > 5MB

      const text = await fsp.readFile(filePath, 'utf-8');
      const wordCount = text.split(/\s+/).filter(Boolean).length;
      return { text, wordCount };
    } catch (err) {
      console.error(`[VaultIndexer] Failed to read ${filePath}:`, err.message);
      return null;
    }
  }

  if (category === 'document' && extension === '.pdf') {
    return extractPdfText(filePath);
  }

  return null;
}

async function extractPdfText(filePath) {
  try {
    const pdfParse = require('pdf-parse');
    const buffer = await fsp.readFile(filePath);
    const data = await pdfParse(buffer);
    const text = data.text || '';
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    return { text, wordCount };
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      console.warn('[VaultIndexer] pdf-parse not installed — skipping PDF extraction');
      return null;
    }
    console.error(`[VaultIndexer] PDF extraction failed for ${filePath}:`, err.message);
    return null;
  }
}

// ============================================================
// Chunk + embed for sources
// ============================================================

/**
 * Chunk extracted text and generate embeddings for a source.
 * Same pipeline as VaultService._chunkAndEmbed() but uses source_id.
 */
async function chunkAndEmbedSource(db, sourceId, text) {
  if (!text || text.trim().length < 20) {
    db.prepare('DELETE FROM vault_chunks WHERE source_id = ?').run(sourceId);
    return;
  }

  try {
    const cleaned = cleanTextForEmbedding(text);
    const chunks = chunkText(cleaned, 1600, 200);

    db.prepare('DELETE FROM vault_chunks WHERE source_id = ?').run(sourceId);

    const embedder = await getEmbedder();
    const insert = db.prepare(`
      INSERT INTO vault_chunks (id, source_id, chunk_index, content, token_count, embedding)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const tokenCount = Math.ceil(chunk.length / 4);
      const output = await embedder(chunk, { pooling: 'mean', normalize: true });
      const embedding = embeddingToBuffer(output.data);
      insert.run(generateId(), sourceId, i, chunk, tokenCount, embedding);
    }
  } catch (err) {
    console.error('[VaultIndexer] Chunk/embed failed for source', sourceId, err.message);
  }
}

// ============================================================
// VaultIndexerService
// ============================================================

const VaultIndexerService = {

  // In-memory indexing state for progress UI
  _state: {
    isIndexing: false,
    scopeId: null,
    total: 0,
    processed: 0,
    failed: 0,
    currentFile: null,
  },

  getStatus() {
    return { ...this._state };
  },

  /**
   * Scan a scope: walk directory, record/update sources, extract + embed.
   * Runs asynchronously. Updates _state for progress tracking.
   */
  async scanScope(db, scopeId) {
    const scope = db.prepare('SELECT * FROM vault_scopes WHERE id = ?').get(scopeId);
    if (!scope || !scope.enabled) return;

    try {
      await fsp.access(scope.path);
    } catch {
      throw new Error(`Scope path does not exist: ${scope.path}`);
    }

    const fileExtensions = scope.file_extensions ? JSON.parse(scope.file_extensions) : null;

    this._state = {
      isIndexing: true,
      scopeId,
      total: 0,
      processed: 0,
      failed: 0,
      currentFile: null,
    };

    try {
      // Walk directory (async — yields to event loop periodically)
      const files = await walkDirectory(scope.path, {
        recursive: scope.recursive === 1,
        fileExtensions,
      });

      this._state.total = files.length;

      // Get existing sources for change detection
      const existingSources = db.prepare(
        'SELECT id, file_path, content_hash, file_modified_at FROM vault_sources WHERE scope_id = ?'
      ).all(scopeId);
      const existingByPath = new Map(existingSources.map(s => [s.file_path, s]));

      // Track seen paths for stale detection
      const seenPaths = new Set();

      // Process in batches
      for (let i = 0; i < files.length; i += BATCH_SIZE) {
        const batch = files.slice(i, i + BATCH_SIZE);

        for (const file of batch) {
          seenPaths.add(file.filePath);
          this._state.currentFile = file.filename;

          try {
            const existing = existingByPath.get(file.filePath);

            if (existing) {
              // Unchanged? (fast mtime check)
              if (existing.file_modified_at === file.mtime) {
                this._state.processed++;
                continue;
              }

              // Mtime differs — check content hash
              const hash = await computeFileHash(file.filePath);
              if (hash === existing.content_hash) {
                db.prepare(
                  "UPDATE vault_sources SET file_modified_at = ?, updated_at = datetime('now') WHERE id = ?"
                ).run(file.mtime, existing.id);
                this._state.processed++;
                continue;
              }

              // Content changed — re-extract
              await this._extractAndStore(db, existing.id, file);
            } else {
              // New file
              const sourceId = generateId();
              const hash = await computeFileHash(file.filePath);

              db.prepare(`
                INSERT INTO vault_sources (id, scope_id, file_path, filename, file_extension, mime_type, size_bytes, content_hash, file_modified_at, extraction_status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
              `).run(sourceId, scopeId, file.filePath, file.filename, file.extension, getMimeType(file.extension), file.size, hash, file.mtime);

              await this._extractAndStore(db, sourceId, file);
            }
          } catch (err) {
            console.error(`[VaultIndexer] Error processing ${file.filePath}:`, err.message);
            this._state.failed++;
          }

          this._state.processed++;
        }

        // Yield between batches
        if (i + BATCH_SIZE < files.length) {
          await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
        }
      }

      // Mark missing files as stale
      for (const existing of existingSources) {
        if (!seenPaths.has(existing.file_path)) {
          db.prepare(
            "UPDATE vault_sources SET is_stale = 1, updated_at = datetime('now') WHERE id = ?"
          ).run(existing.id);
        }
      }

      // Un-stale files that reappeared
      for (const file of files) {
        const existing = existingByPath.get(file.filePath);
        if (existing) {
          db.prepare(
            "UPDATE vault_sources SET is_stale = 0 WHERE id = ? AND is_stale = 1"
          ).run(existing.id);
        }
      }
    } finally {
      this._state.isIndexing = false;
      this._state.currentFile = null;

      // Compute semantic edges for indexed sources (background, non-blocking)
      try {
        const VaultGraphService = require('./vault-graph');
        VaultGraphService.rebuildAllSemanticEdges(db, {
          threshold: 0.60,
          maxEdges: 10,
        }).catch(err => console.warn('[VaultIndexer] Semantic edge computation error:', err.message));
      } catch (e) {
        // Non-critical — graph service may not be available
      }
    }
  },

  /**
   * Extract text from a file and store it, then chunk + embed.
   */
  async _extractAndStore(db, sourceId, file) {
    try {
      const result = await extractText(file.filePath, file.extension);
      const hash = await computeFileHash(file.filePath);

      if (result) {
        db.prepare(`
          UPDATE vault_sources
          SET extracted_text = ?, extracted_word_count = ?, extraction_status = 'extracted',
              content_hash = ?, file_modified_at = ?, size_bytes = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(result.text, result.wordCount, hash, file.mtime, file.size, sourceId);

        await chunkAndEmbedSource(db, sourceId, result.text);
      } else {
        const status = getFileCategory(file.extension) === 'image' ? 'skipped' : 'failed';
        db.prepare(`
          UPDATE vault_sources
          SET extraction_status = ?, content_hash = ?, file_modified_at = ?,
              size_bytes = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(status, hash, file.mtime, file.size, sourceId);
      }
    } catch (err) {
      db.prepare(
        "UPDATE vault_sources SET extraction_status = 'failed', updated_at = datetime('now') WHERE id = ?"
      ).run(sourceId);
      throw err;
    }
  },

  /**
   * Remove a single source from the index. Chunks cascade-deleted by FK.
   */
  removeSource(db, sourceId) {
    db.prepare('DELETE FROM vault_sources WHERE id = ?').run(sourceId);
  },

  /**
   * Remove a scope and all its sources (cascade deletes chunks too).
   */
  removeScope(db, scopeId) {
    db.prepare('DELETE FROM vault_sources WHERE scope_id = ?').run(scopeId);
    db.prepare('DELETE FROM vault_scopes WHERE id = ?').run(scopeId);
  },
};

module.exports = VaultIndexerService;
