/**
 * VaultService — OS8 Knowledge Layer
 *
 * Notes, folders, tags, links, and version management.
 * All methods are static with `db` as first parameter.
 */

const fs = require('fs');
const pathModule = require('path');
const { generateId, generateSlug } = require('../utils');
const { chunkText, getEmbedder, embeddingToBuffer, bufferToEmbedding, cosineSimilarity, cleanTextForEmbedding } = require('../assistant/memory-embeddings');

// ============================================================
// Internal helpers
// ============================================================

/**
 * Strip Markdown formatting to produce plain text for FTS indexing.
 */
function stripMarkdown(content) {
  if (!content) return '';
  return content
    .replace(/```[\s\S]*?```/g, ' ')       // code blocks
    .replace(/`[^`]+`/g, ' ')              // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[[^\]]*\]\([^)]*\)/g, '$1') // links (keep text)
    .replace(/\[\[([^\]]+)\]\]/g, '$1')    // wikilinks (keep text)
    .replace(/^#{1,6}\s+/gm, '')           // headings
    .replace(/[*_~]{1,3}/g, '')            // bold/italic/strikethrough
    .replace(/^>\s+/gm, '')               // blockquotes
    .replace(/^[-*+]\s+/gm, '')           // unordered lists
    .replace(/^\d+\.\s+/gm, '')           // ordered lists
    .replace(/^---+$/gm, '')              // horizontal rules
    .replace(/\|/g, ' ')                  // table pipes
    .replace(/\n{2,}/g, '\n')             // collapse multiple newlines
    .trim();
}

/**
 * Extract [[wikilink]] targets from Markdown content.
 * Returns array of title strings.
 */
function parseWikilinks(content) {
  if (!content) return [];
  const matches = content.match(/\[\[([^\]]+)\]\]/g);
  if (!matches) return [];
  return [...new Set(matches.map(m => m.slice(2, -2).trim()))];
}

/**
 * Extract inline #tags from Markdown content.
 * Ignores tags inside code blocks and headings.
 */
function parseTags(content) {
  if (!content) return [];
  // Remove code blocks first
  const cleaned = content
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '')
    .replace(/^#{1,6}\s+/gm, '');
  const matches = cleaned.match(/(?:^|\s)#([a-zA-Z][a-zA-Z0-9_-]*)/g);
  if (!matches) return [];
  return [...new Set(matches.map(m => m.trim().slice(1)))];
}

/**
 * Parse YAML frontmatter from markdown content.
 * Returns { frontmatter: {}, body: string }.
 */
function parseFrontmatter(content) {
  if (!content || !content.startsWith('---')) return { frontmatter: {}, body: content || '' };
  const endIdx = content.indexOf('\n---', 3);
  if (endIdx === -1) return { frontmatter: {}, body: content };

  const yamlBlock = content.slice(4, endIdx);
  const body = content.slice(endIdx + 4).trimStart();

  const frontmatter = {};
  const lines = yamlBlock.split('\n');
  let currentKey = null;
  let currentArray = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    const arrayMatch = line.match(/^\s+-\s+(.+)$/);
    if (arrayMatch && currentKey) {
      if (!currentArray) { currentArray = []; frontmatter[currentKey] = currentArray; }
      currentArray.push(arrayMatch[1].replace(/^["']|["']$/g, '').trim());
      continue;
    }
    const kvMatch = line.match(/^(\w[\w\s-]*):\s*(.*)$/);
    if (kvMatch) {
      currentKey = kvMatch[1].trim();
      currentArray = null;
      const val = kvMatch[2].trim();
      if (val) {
        if (val.startsWith('[') && val.endsWith(']')) {
          frontmatter[currentKey] = val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
        } else {
          frontmatter[currentKey] = val.replace(/^["']|["']$/g, '');
        }
      }
    }
  }
  return { frontmatter, body };
}

/**
 * Ensure a slug is unique in vault_notes, appending a counter if needed.
 */
function ensureUniqueSlug(db, slug) {
  if (!db.prepare('SELECT id FROM vault_notes WHERE slug = ?').get(slug)) {
    return slug;
  }
  let counter = 1;
  while (db.prepare('SELECT id FROM vault_notes WHERE slug = ?').get(`${slug}-${counter}`)) {
    counter++;
  }
  return `${slug}-${counter}`;
}

// ============================================================
// FTS5 helpers
// ============================================================

function ftsInsert(db, rowid, title, contentPlain) {
  try {
    db.prepare(
      'INSERT INTO vault_notes_fts(rowid, title, content_plain) VALUES (?, ?, ?)'
    ).run(rowid, title || '', contentPlain || '');
  } catch (e) {
    console.warn('[Vault] FTS insert warning:', e.message);
  }
}

function ftsDelete(db, rowid, title, contentPlain) {
  try {
    db.prepare(
      "INSERT INTO vault_notes_fts(vault_notes_fts, rowid, title, content_plain) VALUES('delete', ?, ?, ?)"
    ).run(rowid, title || '', contentPlain || '');
  } catch (e) {
    console.warn('[Vault] FTS delete warning:', e.message);
  }
}

function ftsUpdate(db, rowid, oldTitle, oldPlain, newTitle, newPlain) {
  ftsDelete(db, rowid, oldTitle, oldPlain);
  ftsInsert(db, rowid, newTitle, newPlain);
}

// ============================================================
// VaultService
// ============================================================

const VaultService = {

  // ----------------------------------------------------------
  // Notes
  // ----------------------------------------------------------

  createNote(db, { title, content = '', folder_id = null, tags = [], is_daily = 0, daily_date = null }) {
    if (!title) throw new Error('Title is required');

    const id = generateId();
    const slug = ensureUniqueSlug(db, generateSlug(title) || 'untitled');
    const contentPlain = stripMarkdown(content);
    const wordCount = contentPlain ? contentPlain.split(/\s+/).filter(Boolean).length : 0;

    db.prepare(`
      INSERT INTO vault_notes (id, folder_id, title, slug, content, content_plain, is_daily, daily_date, word_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, folder_id, title, slug, content, contentPlain, is_daily ? 1 : 0, daily_date, wordCount);

    // FTS sync
    const row = db.prepare('SELECT rowid FROM vault_notes WHERE id = ?').get(id);
    if (row) ftsInsert(db, row.rowid, title, contentPlain);

    // Initial version
    const versionId = generateId();
    db.prepare(`
      INSERT INTO vault_versions (id, note_id, title, content, version_number)
      VALUES (?, ?, ?, ?, 1)
    `).run(versionId, id, title, content);

    // Process tags (inline #tags from content + explicit tag IDs)
    this._syncNoteTags(db, id, tags, content);

    // Process wikilinks
    this._syncWikilinks(db, id, content);

    // Async: chunk and embed (don't block response)
    this._chunkAndEmbed(db, id, contentPlain).catch(() => {});

    return this.getNote(db, id);
  },

  getNote(db, id) {
    const note = db.prepare('SELECT * FROM vault_notes WHERE id = ?').get(id);
    if (!note) return null;

    const tags = db.prepare(`
      SELECT t.* FROM vault_tags t
      JOIN vault_note_tags nt ON nt.tag_id = t.id
      WHERE nt.note_id = ?
    `).all(id);

    const links = db.prepare(`
      SELECT l.*, n.title AS target_title, n.slug AS target_slug
      FROM vault_links l
      JOIN vault_notes n ON n.id = l.target_note_id
      WHERE l.source_note_id = ?
    `).all(id);

    const backlinks = db.prepare(`
      SELECT l.*, n.title AS source_title, n.slug AS source_slug
      FROM vault_links l
      JOIN vault_notes n ON n.id = l.source_note_id
      WHERE l.target_note_id = ?
    `).all(id);

    return { ...note, tags, links, backlinks };
  },

  updateNote(db, id, updates) {
    const existing = db.prepare('SELECT rowid, * FROM vault_notes WHERE id = ?').get(id);
    if (!existing) throw new Error('Note not found');

    const fields = [];
    const values = [];

    if (updates.title !== undefined) {
      fields.push('title = ?');
      values.push(updates.title);
      // Update slug if title changed
      const newSlug = ensureUniqueSlug(db, generateSlug(updates.title) || 'untitled');
      fields.push('slug = ?');
      values.push(newSlug);
    }
    if (updates.content !== undefined) {
      fields.push('content = ?');
      values.push(updates.content);
      const contentPlain = stripMarkdown(updates.content);
      const wordCount = contentPlain ? contentPlain.split(/\s+/).filter(Boolean).length : 0;
      fields.push('content_plain = ?');
      values.push(contentPlain);
      fields.push('word_count = ?');
      values.push(wordCount);
    }
    if (updates.folder_id !== undefined) {
      fields.push('folder_id = ?');
      values.push(updates.folder_id);
    }
    if (updates.is_pinned !== undefined) {
      fields.push('is_pinned = ?');
      values.push(updates.is_pinned ? 1 : 0);
    }
    if (updates.is_archived !== undefined) {
      fields.push('is_archived = ?');
      values.push(updates.is_archived ? 1 : 0);
    }

    if (fields.length === 0) return this.getNote(db, id);

    fields.push("updated_at = datetime('now')");
    values.push(id);

    db.prepare(`UPDATE vault_notes SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    // FTS sync if title or content changed
    if (updates.title !== undefined || updates.content !== undefined) {
      const updated = db.prepare('SELECT rowid, * FROM vault_notes WHERE id = ?').get(id);
      ftsUpdate(db, existing.rowid, existing.title, existing.content_plain, updated.title, updated.content_plain);
    }

    // If content changed: create version, re-sync links and tags
    if (updates.content !== undefined && updates.content !== existing.content) {
      const lastVersion = db.prepare(
        'SELECT version_number FROM vault_versions WHERE note_id = ? ORDER BY version_number DESC LIMIT 1'
      ).get(id);
      const nextVersion = (lastVersion ? lastVersion.version_number : 0) + 1;

      // Prune old versions if over limit (keep 50)
      const versionCount = db.prepare('SELECT COUNT(*) as n FROM vault_versions WHERE note_id = ?').get(id);
      if (versionCount && versionCount.n >= 50) {
        db.prepare(`
          DELETE FROM vault_versions WHERE note_id = ? AND id IN (
            SELECT id FROM vault_versions WHERE note_id = ? ORDER BY version_number ASC LIMIT ?
          )
        `).run(id, id, versionCount.n - 49);
      }

      db.prepare(`
        INSERT INTO vault_versions (id, note_id, title, content, version_number)
        VALUES (?, ?, ?, ?, ?)
      `).run(generateId(), id, updates.title || existing.title, updates.content, nextVersion);

      this._syncWikilinks(db, id, updates.content);
      this._syncNoteTags(db, id, [], updates.content);

      // Async: re-chunk and re-embed
      const newPlain = stripMarkdown(updates.content);
      this._chunkAndEmbed(db, id, newPlain).then(() => {
        // After re-embedding, recompute semantic edges for this note
        try {
          const VaultGraphService = require('./vault-graph');
          VaultGraphService.computeSemanticEdgesForDocument(db, 'note', id, {}).catch(() => {});
        } catch (e) { /* non-critical */ }
      }).catch(() => {});
    }

    return this.getNote(db, id);
  },

  deleteNote(db, id, { hard = false } = {}) {
    if (hard) {
      // Get FTS data before delete
      const note = db.prepare('SELECT rowid, title, content_plain FROM vault_notes WHERE id = ?').get(id);
      if (note) {
        ftsDelete(db, note.rowid, note.title, note.content_plain);
      }
      db.prepare('DELETE FROM vault_notes WHERE id = ?').run(id);
    } else {
      db.prepare("UPDATE vault_notes SET is_archived = 1, updated_at = datetime('now') WHERE id = ?").run(id);
    }
  },

  listNotes(db, { folder_id, tag, search, is_daily, is_archived, is_pinned, sort = 'updated', order = 'desc', limit = 50, offset = 0 } = {}) {
    // FTS search path
    if (search) {
      return this._searchNotes(db, search, { folder_id, tag, is_daily, is_archived, is_pinned, sort, order, limit, offset });
    }

    const where = [];
    const params = [];

    if (folder_id !== undefined) { where.push('n.folder_id = ?'); params.push(folder_id); }
    if (is_daily !== undefined) { where.push('n.is_daily = ?'); params.push(is_daily ? 1 : 0); }
    if (is_archived !== undefined) { where.push('n.is_archived = ?'); params.push(is_archived ? 1 : 0); }
    else { where.push('n.is_archived = 0'); } // default: hide archived
    if (is_pinned !== undefined) { where.push('n.is_pinned = ?'); params.push(is_pinned ? 1 : 0); }
    if (tag) {
      where.push('EXISTS (SELECT 1 FROM vault_note_tags nt JOIN vault_tags t ON t.id = nt.tag_id WHERE nt.note_id = n.id AND t.name = ?)');
      params.push(tag);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const sortColumn = sort === 'created' ? 'n.created_at' : sort === 'title' ? 'n.title' : 'n.updated_at';
    const sortOrder = order === 'asc' ? 'ASC' : 'DESC';

    const total = db.prepare(`SELECT COUNT(*) as n FROM vault_notes n ${whereClause}`).get(...params).n;

    const notes = db.prepare(`
      SELECT n.* FROM vault_notes n
      ${whereClause}
      ORDER BY ${sortColumn} ${sortOrder}
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), parseInt(offset));

    return { notes, total };
  },

  _searchNotes(db, query, { folder_id, tag, is_daily, is_archived, is_pinned, sort, order, limit = 50, offset = 0 } = {}) {
    // FTS5 MATCH query — escape special characters
    const ftsQuery = query.replace(/['"]/g, '').trim();
    if (!ftsQuery) return { notes: [], total: 0 };

    const where = [];
    const params = [];

    if (folder_id !== undefined) { where.push('n.folder_id = ?'); params.push(folder_id); }
    if (is_daily !== undefined) { where.push('n.is_daily = ?'); params.push(is_daily ? 1 : 0); }
    if (is_archived !== undefined) { where.push('n.is_archived = ?'); params.push(is_archived ? 1 : 0); }
    else { where.push('n.is_archived = 0'); }
    if (is_pinned !== undefined) { where.push('n.is_pinned = ?'); params.push(is_pinned ? 1 : 0); }
    if (tag) {
      where.push('EXISTS (SELECT 1 FROM vault_note_tags nt JOIN vault_tags t ON t.id = nt.tag_id WHERE nt.note_id = n.id AND t.name = ?)');
      params.push(tag);
    }

    const extraWhere = where.length > 0 ? `AND ${where.join(' AND ')}` : '';

    const total = db.prepare(`
      SELECT COUNT(*) as n FROM vault_notes n
      JOIN vault_notes_fts fts ON n.rowid = fts.rowid
      WHERE vault_notes_fts MATCH ? ${extraWhere}
    `).get(ftsQuery, ...params).n;

    const notes = db.prepare(`
      SELECT n.*, fts.rank FROM vault_notes n
      JOIN vault_notes_fts fts ON n.rowid = fts.rowid
      WHERE vault_notes_fts MATCH ? ${extraWhere}
      ORDER BY fts.rank
      LIMIT ? OFFSET ?
    `).all(ftsQuery, ...params, parseInt(limit), parseInt(offset));

    return { notes, total };
  },

  // ----------------------------------------------------------
  // Search (Phase 4)
  // ----------------------------------------------------------

  /**
   * Build a safe FTS5 query with prefix matching on the last word.
   */
  _buildFtsQuery(query) {
    if (!query) return '';
    const cleaned = query.replace(/['"{}()*:^~]/g, '').trim();
    if (!cleaned) return '';
    const words = cleaned.split(/\s+/).filter(Boolean);
    if (!words.length) return '';
    const terms = words.map((w, i) => i === words.length - 1 ? `"${w}"*` : `"${w}"`);
    return terms.join(' ');
  },

  /**
   * FTS5 keyword search with snippet extraction and normalized ranking.
   */
  searchKeyword(db, query, { folder_id, tag, is_daily, is_archived, is_pinned, limit = 20, offset = 0 } = {}) {
    const ftsQuery = this._buildFtsQuery(query);
    if (!ftsQuery) return { results: [], total: 0 };

    const where = [];
    const params = [];

    if (folder_id !== undefined) { where.push('n.folder_id = ?'); params.push(folder_id); }
    if (is_daily !== undefined) { where.push('n.is_daily = ?'); params.push(is_daily ? 1 : 0); }
    if (is_archived !== undefined) { where.push('n.is_archived = ?'); params.push(is_archived ? 1 : 0); }
    else { where.push('n.is_archived = 0'); }
    if (is_pinned !== undefined) { where.push('n.is_pinned = ?'); params.push(is_pinned ? 1 : 0); }
    if (tag) {
      where.push('EXISTS (SELECT 1 FROM vault_note_tags nt JOIN vault_tags t ON t.id = nt.tag_id WHERE nt.note_id = n.id AND t.name = ?)');
      params.push(tag);
    }

    const extraWhere = where.length > 0 ? `AND ${where.join(' AND ')}` : '';

    const total = db.prepare(`
      SELECT COUNT(*) as n FROM vault_notes n
      JOIN vault_notes_fts fts ON n.rowid = fts.rowid
      WHERE vault_notes_fts MATCH ? ${extraWhere}
    `).get(ftsQuery, ...params).n;

    const results = db.prepare(`
      SELECT n.id as note_id, n.title, n.updated_at, n.is_pinned, n.is_daily,
             snippet(vault_notes_fts, 1, '<mark>', '</mark>', '...', 40) as snippet,
             rank
      FROM vault_notes n
      JOIN vault_notes_fts fts ON n.rowid = fts.rowid
      WHERE vault_notes_fts MATCH ? ${extraWhere}
      ORDER BY rank
      LIMIT ? OFFSET ?
    `).all(ftsQuery, ...params, parseInt(limit), parseInt(offset));

    // Normalize rank to 0-1 (FTS5 rank is negative, lower = better match)
    const maxRank = results.length ? Math.abs(results[results.length - 1].rank) : 1;
    for (const r of results) {
      r.score = maxRank > 0 ? 1 - (Math.abs(r.rank) / (maxRank * 1.2)) : 0;
      r.result_type = 'note';
    }

    // Also search sources via LIKE on extracted_text and filename
    const likeQuery = `%${query}%`;
    const sourceResults = db.prepare(`
      SELECT s.id as source_id, s.filename as title, s.file_path, s.file_extension,
             s.updated_at, substr(s.extracted_text, 1, 200) as snippet
      FROM vault_sources s
      WHERE s.is_stale = 0 AND s.extraction_status = 'extracted'
        AND (s.extracted_text LIKE ? OR s.filename LIKE ?)
      ORDER BY s.updated_at DESC
      LIMIT ?
    `).all(likeQuery, likeQuery, parseInt(limit));

    for (const sr of sourceResults) {
      results.push({
        source_id: sr.source_id,
        title: sr.title,
        file_path: sr.file_path,
        snippet: sr.snippet || '',
        score: 0.5,
        updated_at: sr.updated_at,
        result_type: 'source',
      });
    }

    return { results, total: total + sourceResults.length };
  },

  /**
   * Semantic search — embed query, cosine similarity against vault_chunks.
   * Groups results by note, keeping the best-matching chunk per note.
   */
  async searchSemantic(db, query, { folder_id, tag, is_daily, is_archived, limit = 20, offset = 0, min_relevance = 0.3 } = {}) {
    if (!query || query.trim().length < 3) return { results: [], total: 0 };

    const t0 = Date.now();
    try {
      const embedder = await getEmbedder();
      const cleaned = cleanTextForEmbedding(query);
      const output = await embedder(cleaned, { pooling: 'mean', normalize: true });
      const queryEmbedding = Array.from(output.data);

      const isArch = is_archived !== undefined ? (is_archived ? 1 : 0) : 0;

      // Optimization: pre-filter with FTS5 to reduce embedding comparison set.
      // If FTS returns enough candidates, only compare those chunks.
      let chunks;
      const ftsQuery = this._buildFtsQuery(query);
      let candidateNoteIds = null;
      if (ftsQuery) {
        const ftsMatches = db.prepare(`
          SELECT n.id FROM vault_notes n
          JOIN vault_notes_fts fts ON n.rowid = fts.rowid
          WHERE vault_notes_fts MATCH ? AND n.is_archived = ?
          LIMIT 200
        `).all(ftsQuery, isArch);
        if (ftsMatches.length >= 20) {
          candidateNoteIds = new Set(ftsMatches.map(m => m.id));
        }
      }

      if (candidateNoteIds) {
        // Load only chunks for FTS candidate notes
        const placeholders = [...candidateNoteIds].map(() => '?').join(',');
        chunks = db.prepare(`
          SELECT c.note_id, c.content, c.embedding,
                 n.title, n.updated_at, n.is_pinned, n.is_daily, n.folder_id
          FROM vault_chunks c
          JOIN vault_notes n ON n.id = c.note_id
          WHERE c.embedding IS NOT NULL AND c.note_id IS NOT NULL
            AND c.note_id IN (${placeholders})
        `).all(...candidateNoteIds);
      } else {
        // Full scan fallback
        chunks = db.prepare(`
          SELECT c.note_id, c.content, c.embedding,
                 n.title, n.updated_at, n.is_pinned, n.is_daily, n.folder_id
          FROM vault_chunks c
          JOIN vault_notes n ON n.id = c.note_id
          WHERE c.embedding IS NOT NULL AND c.note_id IS NOT NULL
            AND n.is_archived = ?
        `).all(isArch);
      }

      // Score each chunk
      const byNote = new Map();
      for (const chunk of chunks) {
        const chunkEmbedding = bufferToEmbedding(chunk.embedding);
        const score = cosineSimilarity(queryEmbedding, chunkEmbedding);
        if (score < min_relevance) continue;

        const existing = byNote.get(chunk.note_id);
        if (!existing || score > existing.score) {
          byNote.set(chunk.note_id, {
            note_id: chunk.note_id,
            title: chunk.title,
            snippet: chunk.content.slice(0, 200),
            score,
            updated_at: chunk.updated_at,
            is_pinned: chunk.is_pinned,
            is_daily: chunk.is_daily,
            folder_id: chunk.folder_id,
          });
        }
      }

      // Add result_type to note results
      for (const [, v] of byNote) v.result_type = 'note';

      // Also search source chunks (smaller set, no pre-filtering needed)
      const sourceChunks = db.prepare(`
        SELECT c.source_id, c.content, c.embedding,
               s.filename as title, s.file_path, s.updated_at, s.file_extension
        FROM vault_chunks c
        JOIN vault_sources s ON s.id = c.source_id
        WHERE c.embedding IS NOT NULL AND c.source_id IS NOT NULL
          AND s.is_stale = 0
      `).all();

      const bySource = new Map();
      for (const chunk of sourceChunks) {
        const chunkEmbedding = bufferToEmbedding(chunk.embedding);
        const score = cosineSimilarity(queryEmbedding, chunkEmbedding);
        if (score < min_relevance) continue;

        const existing = bySource.get(chunk.source_id);
        if (!existing || score > existing.score) {
          bySource.set(chunk.source_id, {
            source_id: chunk.source_id,
            title: chunk.title,
            file_path: chunk.file_path,
            snippet: chunk.content.slice(0, 200),
            score,
            updated_at: chunk.updated_at,
            result_type: 'source',
          });
        }
      }

      // Apply filters (note-specific filters only apply to notes)
      let results = [...byNote.values()];
      if (folder_id !== undefined) results = results.filter(r => r.folder_id === folder_id);
      if (is_daily !== undefined) results = results.filter(r => r.is_daily === (is_daily ? 1 : 0));
      if (tag) {
        const noteIdsWithTag = new Set(
          db.prepare(`
            SELECT nt.note_id FROM vault_note_tags nt
            JOIN vault_tags t ON t.id = nt.tag_id WHERE t.name = ?
          `).all(tag).map(r => r.note_id)
        );
        results = results.filter(r => noteIdsWithTag.has(r.note_id));
      }

      // Merge source results
      results.push(...bySource.values());

      results.sort((a, b) => b.score - a.score);
      const total = results.length;
      results = results.slice(parseInt(offset), parseInt(offset) + parseInt(limit));

      console.log(`[Vault:Perf] Semantic search: ${Date.now() - t0}ms (${chunks.length} note chunks, ${sourceChunks.length} source chunks${candidateNoteIds ? ', FTS pre-filtered' : ''})`);
      return { results, total };
    } catch (err) {
      console.error('[Vault] Semantic search error:', err.message);
      return { results: [], total: 0 };
    }
  },

  /**
   * Hybrid search — merges keyword (0.4) and semantic (0.6) results.
   * @param {string} mode - 'keyword' | 'semantic' | 'hybrid' (default)
   */
  async search(db, query, { mode = 'hybrid', ...filters } = {}) {
    if (mode === 'keyword') {
      return this.searchKeyword(db, query, filters);
    }
    if (mode === 'semantic') {
      return this.searchSemantic(db, query, filters);
    }

    // Hybrid: run both
    const [keyword, semantic] = await Promise.all([
      Promise.resolve(this.searchKeyword(db, query, filters)),
      this.searchSemantic(db, query, filters),
    ]);

    // Composite key: "note:{id}" or "source:{id}"
    function resultKey(r) {
      return r.note_id ? `note:${r.note_id}` : `source:${r.source_id}`;
    }

    const merged = new Map();

    for (const r of keyword.results) {
      const key = resultKey(r);
      merged.set(key, {
        note_id: r.note_id || undefined,
        source_id: r.source_id || undefined,
        file_path: r.file_path || undefined,
        title: r.title,
        snippet: r.snippet,
        score: 0.4 * (r.score || 0),
        updated_at: r.updated_at,
        is_pinned: r.is_pinned,
        is_daily: r.is_daily,
        result_type: r.result_type || 'note',
        match_type: 'keyword',
      });
    }

    for (const r of semantic.results) {
      const key = resultKey(r);
      const existing = merged.get(key);
      if (existing) {
        existing.score += 0.6 * r.score;
        existing.match_type = 'both';
        if (!existing.snippet && r.snippet) existing.snippet = r.snippet;
      } else {
        merged.set(key, {
          note_id: r.note_id || undefined,
          source_id: r.source_id || undefined,
          file_path: r.file_path || undefined,
          title: r.title,
          snippet: r.snippet,
          score: 0.6 * r.score,
          updated_at: r.updated_at,
          is_pinned: r.is_pinned,
          is_daily: r.is_daily,
          result_type: r.result_type || 'note',
          match_type: 'semantic',
        });
      }
    }

    const results = [...merged.values()].sort((a, b) => b.score - a.score);
    const limit = parseInt(filters.limit || 20);
    const offset = parseInt(filters.offset || 0);

    return {
      results: results.slice(offset, offset + limit),
      total: results.length,
    };
  },

  getOrCreateDailyNote(db, date = null) {
    if (!date) {
      date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    }
    const existing = db.prepare('SELECT * FROM vault_notes WHERE is_daily = 1 AND daily_date = ?').get(date);
    if (existing) return this.getNote(db, existing.id);

    return this.createNote(db, {
      title: date,
      content: `# ${date}\n\n`,
      is_daily: 1,
      daily_date: date
    });
  },

  getDailyNote(db, date) {
    const note = db.prepare('SELECT * FROM vault_notes WHERE is_daily = 1 AND daily_date = ?').get(date);
    if (!note) return null;
    return this.getNote(db, note.id);
  },

  getBacklinks(db, noteId) {
    return db.prepare(`
      SELECT l.*, n.title AS source_title, n.slug AS source_slug
      FROM vault_links l
      JOIN vault_notes n ON n.id = l.source_note_id
      WHERE l.target_note_id = ?
    `).all(noteId);
  },

  // ----------------------------------------------------------
  // Versions
  // ----------------------------------------------------------

  getVersions(db, noteId) {
    return db.prepare(
      'SELECT * FROM vault_versions WHERE note_id = ? ORDER BY version_number DESC'
    ).all(noteId);
  },

  restoreVersion(db, noteId, versionId) {
    const version = db.prepare('SELECT * FROM vault_versions WHERE id = ? AND note_id = ?').get(versionId, noteId);
    if (!version) throw new Error('Version not found');
    return this.updateNote(db, noteId, { title: version.title, content: version.content });
  },

  // ----------------------------------------------------------
  // Folders
  // ----------------------------------------------------------

  createFolder(db, { name, parent_id = null, icon = null }) {
    if (!name) throw new Error('Folder name is required');
    const id = generateId();
    db.prepare(`
      INSERT INTO vault_folders (id, parent_id, name, icon)
      VALUES (?, ?, ?, ?)
    `).run(id, parent_id, name, icon);
    return db.prepare('SELECT * FROM vault_folders WHERE id = ?').get(id);
  },

  updateFolder(db, id, updates) {
    const fields = [];
    const values = [];
    if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
    if (updates.parent_id !== undefined) { fields.push('parent_id = ?'); values.push(updates.parent_id); }
    if (updates.icon !== undefined) { fields.push('icon = ?'); values.push(updates.icon); }
    if (updates.sort_order !== undefined) { fields.push('sort_order = ?'); values.push(updates.sort_order); }
    if (fields.length === 0) return db.prepare('SELECT * FROM vault_folders WHERE id = ?').get(id);

    fields.push("updated_at = datetime('now')");
    values.push(id);
    db.prepare(`UPDATE vault_folders SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return db.prepare('SELECT * FROM vault_folders WHERE id = ?').get(id);
  },

  deleteFolder(db, id) {
    // Move contained notes to root before deleting
    db.prepare('UPDATE vault_notes SET folder_id = NULL WHERE folder_id = ?').run(id);
    db.prepare('DELETE FROM vault_folders WHERE id = ?').run(id);
  },

  listFolders(db) {
    const folders = db.prepare(`
      SELECT f.*, COUNT(n.id) as note_count
      FROM vault_folders f
      LEFT JOIN vault_notes n ON n.folder_id = f.id AND n.is_archived = 0
      GROUP BY f.id
      ORDER BY f.sort_order, f.name
    `).all();
    return this._buildFolderTree(folders);
  },

  _buildFolderTree(folders, parentId = null) {
    return folders
      .filter(f => f.parent_id === parentId)
      .map(f => ({
        ...f,
        children: this._buildFolderTree(folders, f.id)
      }));
  },

  // ----------------------------------------------------------
  // Tags
  // ----------------------------------------------------------

  createTag(db, { name, color = null }) {
    if (!name) throw new Error('Tag name is required');
    const existing = db.prepare('SELECT * FROM vault_tags WHERE name = ?').get(name);
    if (existing) return existing;
    const id = generateId();
    db.prepare('INSERT INTO vault_tags (id, name, color) VALUES (?, ?, ?)').run(id, name, color);
    return db.prepare('SELECT * FROM vault_tags WHERE id = ?').get(id);
  },

  updateTag(db, id, updates) {
    const fields = [];
    const values = [];
    if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
    if (updates.color !== undefined) { fields.push('color = ?'); values.push(updates.color); }
    if (fields.length === 0) return db.prepare('SELECT * FROM vault_tags WHERE id = ?').get(id);
    values.push(id);
    db.prepare(`UPDATE vault_tags SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return db.prepare('SELECT * FROM vault_tags WHERE id = ?').get(id);
  },

  deleteTag(db, id) {
    db.prepare('DELETE FROM vault_tags WHERE id = ?').run(id);
  },

  listTags(db) {
    return db.prepare(`
      SELECT t.*, COUNT(nt.note_id) as note_count
      FROM vault_tags t
      LEFT JOIN vault_note_tags nt ON nt.tag_id = t.id
      GROUP BY t.id
      ORDER BY t.name
    `).all();
  },

  addTagsToNote(db, noteId, tagIds) {
    if (!Array.isArray(tagIds) || tagIds.length === 0) return;
    const insert = db.prepare('INSERT OR IGNORE INTO vault_note_tags (note_id, tag_id) VALUES (?, ?)');
    for (const tagId of tagIds) {
      insert.run(noteId, tagId);
    }
  },

  removeTagFromNote(db, noteId, tagId) {
    db.prepare('DELETE FROM vault_note_tags WHERE note_id = ? AND tag_id = ?').run(noteId, tagId);
  },

  // ----------------------------------------------------------
  // Links
  // ----------------------------------------------------------

  createLink(db, { source_note_id, target_note_id, link_type = 'reference', context = null }) {
    if (!source_note_id || !target_note_id) throw new Error('Source and target note IDs are required');
    if (source_note_id === target_note_id) throw new Error('Cannot link a note to itself');
    const id = generateId();
    db.prepare(`
      INSERT OR IGNORE INTO vault_links (id, source_note_id, target_note_id, link_type, context)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, source_note_id, target_note_id, link_type, context);
    return db.prepare('SELECT * FROM vault_links WHERE id = ?').get(id);
  },

  deleteLink(db, id) {
    db.prepare('DELETE FROM vault_links WHERE id = ?').run(id);
  },

  getGraph(db) {
    const nodes = db.prepare(`
      SELECT id, title, slug, folder_id, is_daily, is_pinned
      FROM vault_notes WHERE is_archived = 0
    `).all();

    const edges = db.prepare(`
      SELECT id, source_note_id, target_note_id, link_type
      FROM vault_links
    `).all();

    return { nodes, edges };
  },

  getLocalGraph(db, noteId, depth = 1) {
    const visited = new Set();
    const nodes = [];
    const edges = [];

    const queue = [{ id: noteId, d: 0 }];
    while (queue.length > 0) {
      const { id, d } = queue.shift();
      if (visited.has(id)) continue;
      visited.add(id);

      const note = db.prepare('SELECT id, title, slug, folder_id, is_daily, is_pinned FROM vault_notes WHERE id = ?').get(id);
      if (!note) continue;
      nodes.push(note);

      if (d < depth) {
        const outLinks = db.prepare('SELECT * FROM vault_links WHERE source_note_id = ?').all(id);
        const inLinks = db.prepare('SELECT * FROM vault_links WHERE target_note_id = ?').all(id);
        for (const link of outLinks) {
          edges.push(link);
          queue.push({ id: link.target_note_id, d: d + 1 });
        }
        for (const link of inLinks) {
          edges.push(link);
          queue.push({ id: link.source_note_id, d: d + 1 });
        }
      }
    }

    // Deduplicate edges
    const edgeMap = new Map();
    for (const e of edges) edgeMap.set(e.id, e);

    return { nodes, edges: [...edgeMap.values()] };
  },

  // ----------------------------------------------------------
  // Templates
  // ----------------------------------------------------------

  listTemplates(db) {
    return db.prepare('SELECT * FROM vault_templates ORDER BY sort_order, name').all();
  },

  getTemplate(db, id) {
    return db.prepare('SELECT * FROM vault_templates WHERE id = ?').get(id);
  },

  createTemplate(db, { name, content = '' }) {
    if (!name) throw new Error('Template name is required');
    const id = generateId();
    const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM vault_templates').get();
    const sortOrder = (maxOrder?.m ?? -1) + 1;
    db.prepare(
      'INSERT INTO vault_templates (id, name, content, sort_order) VALUES (?, ?, ?, ?)'
    ).run(id, name, content, sortOrder);
    return db.prepare('SELECT * FROM vault_templates WHERE id = ?').get(id);
  },

  updateTemplate(db, id, updates) {
    const fields = [];
    const values = [];
    if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
    if (updates.content !== undefined) { fields.push('content = ?'); values.push(updates.content); }
    if (updates.sort_order !== undefined) { fields.push('sort_order = ?'); values.push(updates.sort_order); }
    if (fields.length === 0) return db.prepare('SELECT * FROM vault_templates WHERE id = ?').get(id);
    values.push(id);
    db.prepare(`UPDATE vault_templates SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return db.prepare('SELECT * FROM vault_templates WHERE id = ?').get(id);
  },

  deleteTemplate(db, id) {
    db.prepare('DELETE FROM vault_templates WHERE id = ?').run(id);
  },

  seedDefaultTemplates(db) {
    const count = db.prepare('SELECT COUNT(*) as n FROM vault_templates').get();
    if (count && count.n > 0) return;

    const defaults = [
      { name: 'Blank', content: '', sort_order: 0 },
      { name: 'Daily Note', content: '# {{date}}\n\n## Tasks\n- [ ] \n\n## Notes\n\n', sort_order: 1 },
      { name: 'Meeting Notes', content: '# Meeting: {{title}}\n\n**Date:** {{date}}\n**Attendees:**\n\n## Agenda\n\n## Notes\n\n## Action Items\n- [ ] \n', sort_order: 2 },
    ];

    const insert = db.prepare(
      'INSERT INTO vault_templates (id, name, content, sort_order) VALUES (?, ?, ?, ?)'
    );
    for (const t of defaults) {
      insert.run(generateId(), t.name, t.content, t.sort_order);
    }
  },

  // ----------------------------------------------------------
  // Internal: Tag and wikilink sync
  // ----------------------------------------------------------

  /**
   * Sync tags on a note — merges explicit tag IDs with inline #tags from content.
   * Creates tags that don't exist yet.
   */
  _syncNoteTags(db, noteId, explicitTagIds = [], content = '') {
    const inlineTags = parseTags(content);

    // Resolve/create inline tags
    const resolvedIds = [...explicitTagIds];
    for (const tagName of inlineTags) {
      const tag = this.createTag(db, { name: tagName });
      if (tag && !resolvedIds.includes(tag.id)) {
        resolvedIds.push(tag.id);
      }
    }

    if (resolvedIds.length > 0) {
      const insert = db.prepare('INSERT OR IGNORE INTO vault_note_tags (note_id, tag_id) VALUES (?, ?)');
      for (const tagId of resolvedIds) {
        insert.run(noteId, tagId);
      }
    }
  },

  /**
   * Chunk note content and generate embeddings.
   * Called async after save — does not block the response.
   * Replaces all existing chunks for this note.
   */
  async _chunkAndEmbed(db, noteId, contentPlain) {
    if (!contentPlain || contentPlain.trim().length < 20) {
      db.prepare('DELETE FROM vault_chunks WHERE note_id = ?').run(noteId);
      return;
    }

    try {
      const cleaned = cleanTextForEmbedding(contentPlain);
      const chunks = chunkText(cleaned, 1600, 200);

      db.prepare('DELETE FROM vault_chunks WHERE note_id = ?').run(noteId);

      const embedder = await getEmbedder();
      const insert = db.prepare(`
        INSERT INTO vault_chunks (id, note_id, chunk_index, content, token_count, embedding)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const tokenCount = Math.ceil(chunk.length / 4);
        const output = await embedder(chunk, { pooling: 'mean', normalize: true });
        const embedding = embeddingToBuffer(output.data);
        insert.run(generateId(), noteId, i, chunk, tokenCount, embedding);
      }
    } catch (err) {
      console.error('[Vault] Chunk/embed failed for note', noteId, err.message);
    }
  },

  /**
   * Sync wikilinks — parse [[wikilinks]] from content, resolve to note IDs,
   * and upsert vault_links entries. Removes stale links that no longer appear in content.
   */
  _syncWikilinks(db, noteId, content = '') {
    const titles = parseWikilinks(content);

    // Remove existing outgoing wikilinks from this note
    db.prepare("DELETE FROM vault_links WHERE source_note_id = ? AND link_type = 'reference'").run(noteId);

    // Resolve titles to note IDs and create links
    for (const title of titles) {
      const target = db.prepare('SELECT id FROM vault_notes WHERE title = ? COLLATE NOCASE AND id != ?').get(title, noteId);
      if (target) {
        db.prepare(`
          INSERT OR IGNORE INTO vault_links (id, source_note_id, target_note_id, link_type)
          VALUES (?, ?, ?, 'reference')
        `).run(generateId(), noteId, target.id);
      }
    }
  },

  // ----------------------------------------------------------
  // Scopes (filesystem indexing)
  // ----------------------------------------------------------

  createScope(db, { path: scopePath, label = null, recursive = true, file_extensions = null }) {
    if (!scopePath) throw new Error('Path is required');

    const resolved = pathModule.resolve(scopePath);

    if (!fs.existsSync(resolved)) throw new Error('Path does not exist');
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) throw new Error('Path is not a directory');

    const blocked = ['/', '/System', '/Library', '/usr', '/bin', '/sbin', '/private', '/var'];
    if (blocked.includes(resolved)) throw new Error('Cannot index system directories');

    const existing = db.prepare('SELECT id FROM vault_scopes WHERE path = ?').get(resolved);
    if (existing) throw new Error('This directory is already indexed');

    const id = generateId();
    const extJson = file_extensions ? JSON.stringify(file_extensions) : null;

    db.prepare(`
      INSERT INTO vault_scopes (id, path, label, recursive, enabled, file_extensions)
      VALUES (?, ?, ?, ?, 1, ?)
    `).run(id, resolved, label || pathModule.basename(resolved), recursive ? 1 : 0, extJson);

    return db.prepare('SELECT * FROM vault_scopes WHERE id = ?').get(id);
  },

  updateScope(db, id, updates) {
    const fields = [];
    const values = [];
    if (updates.label !== undefined) { fields.push('label = ?'); values.push(updates.label); }
    if (updates.recursive !== undefined) { fields.push('recursive = ?'); values.push(updates.recursive ? 1 : 0); }
    if (updates.enabled !== undefined) { fields.push('enabled = ?'); values.push(updates.enabled ? 1 : 0); }
    if (updates.file_extensions !== undefined) {
      fields.push('file_extensions = ?');
      values.push(updates.file_extensions ? JSON.stringify(updates.file_extensions) : null);
    }
    if (fields.length === 0) return db.prepare('SELECT * FROM vault_scopes WHERE id = ?').get(id);
    values.push(id);
    db.prepare(`UPDATE vault_scopes SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return db.prepare('SELECT * FROM vault_scopes WHERE id = ?').get(id);
  },

  listScopes(db) {
    return db.prepare(`
      SELECT s.*,
        COUNT(src.id) as file_count,
        COALESCE(SUM(src.size_bytes), 0) as total_size,
        SUM(CASE WHEN src.extraction_status = 'extracted' THEN 1 ELSE 0 END) as extracted_count,
        SUM(CASE WHEN src.extraction_status = 'pending' THEN 1 ELSE 0 END) as pending_count,
        SUM(CASE WHEN src.extraction_status = 'failed' THEN 1 ELSE 0 END) as failed_count,
        SUM(CASE WHEN src.is_stale = 1 THEN 1 ELSE 0 END) as stale_count
      FROM vault_scopes s
      LEFT JOIN vault_sources src ON src.scope_id = s.id
      GROUP BY s.id
      ORDER BY s.created_at
    `).all();
  },

  // ----------------------------------------------------------
  // Sources (indexed files)
  // ----------------------------------------------------------

  listSources(db, { scope_id, extension, status, is_stale, search, limit = 50, offset = 0 } = {}) {
    const where = [];
    const params = [];

    if (scope_id) { where.push('scope_id = ?'); params.push(scope_id); }
    if (extension) { where.push('file_extension = ?'); params.push(extension); }
    if (status) { where.push('extraction_status = ?'); params.push(status); }
    if (is_stale !== undefined) { where.push('is_stale = ?'); params.push(is_stale ? 1 : 0); }
    if (search) { where.push('(filename LIKE ? OR file_path LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const total = db.prepare(`SELECT COUNT(*) as n FROM vault_sources ${whereClause}`).get(...params).n;

    const sources = db.prepare(`
      SELECT * FROM vault_sources ${whereClause}
      ORDER BY indexed_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), parseInt(offset));

    return { sources, total };
  },

  getSource(db, id) {
    return db.prepare('SELECT * FROM vault_sources WHERE id = ?').get(id);
  },

  // ----------------------------------------------------------
  // Agent Integration (Phase 6)
  // ----------------------------------------------------------

  /**
   * Search vault for agent consumption. Used by both passive (Tier 4) and active (vault_search tool) paths.
   * Returns chunk-level results with source metadata.
   */
  async searchForAgent(db, query, {
    agent_id,
    conversation_id = null,
    folder_id,
    tag,
    limit = 5,
    min_relevance = 0.35,
    mode = 'passive',
    graphExpand = false,
    graphDepth = 1
  } = {}) {
    if (!query || query.trim().length < 3) return [];

    try {
      const embedder = await getEmbedder();
      const cleaned = cleanTextForEmbedding(query);
      const output = await embedder(cleaned, { pooling: 'mean', normalize: true });
      const queryEmbedding = Array.from(output.data);

      // Load note chunks with embeddings
      let noteChunks = db.prepare(`
        SELECT c.id as chunk_id, c.note_id, c.content, c.embedding,
               n.title, n.updated_at, n.folder_id
        FROM vault_chunks c
        JOIN vault_notes n ON n.id = c.note_id
        WHERE c.embedding IS NOT NULL AND c.note_id IS NOT NULL
          AND n.is_archived = 0
      `).all();

      // Apply note-level filters
      if (folder_id) {
        noteChunks = noteChunks.filter(c => c.folder_id === folder_id);
      }
      if (tag) {
        const noteIdsWithTag = new Set(
          db.prepare(`
            SELECT nt.note_id FROM vault_note_tags nt
            JOIN vault_tags t ON t.id = nt.tag_id WHERE t.name = ?
          `).all(tag).map(r => r.note_id)
        );
        noteChunks = noteChunks.filter(c => noteIdsWithTag.has(c.note_id));
      }

      // Load source chunks with embeddings
      const sourceChunks = db.prepare(`
        SELECT c.id as chunk_id, c.source_id, c.content, c.embedding,
               s.filename as title, s.file_path, s.updated_at
        FROM vault_chunks c
        JOIN vault_sources s ON s.id = c.source_id
        WHERE c.embedding IS NOT NULL AND c.source_id IS NOT NULL
          AND s.is_stale = 0
      `).all();

      // Score all chunks
      const scored = [];
      for (const chunk of [...noteChunks, ...sourceChunks]) {
        const chunkEmbedding = bufferToEmbedding(chunk.embedding);
        const score = cosineSimilarity(queryEmbedding, chunkEmbedding);
        if (score < min_relevance) continue;
        scored.push({
          chunk_id: chunk.chunk_id,
          note_id: chunk.note_id || null,
          source_id: chunk.source_id || null,
          title: chunk.title,
          content: chunk.content.slice(0, 500),
          score,
          updated_at: chunk.updated_at,
          result_type: chunk.note_id ? 'note' : 'source',
        });
      }

      scored.sort((a, b) => b.score - a.score);

      // Graph expansion: find related documents via semantic edges
      if (graphExpand && scored.length > 0) {
        try {
          const VaultGraphService = require('./vault-graph');
          const seedDocs = scored.slice(0, 5).map(r => ({
            type: r.note_id ? 'note' : 'source',
            id: r.note_id || r.source_id,
          }));
          const alreadyScoredIds = new Set(scored.map(r => r.note_id || r.source_id));

          const expanded = VaultGraphService.expandViaGraph(db, seedDocs, {
            maxDepth: graphDepth, limit: 20,
          });

          for (const doc of expanded) {
            if (alreadyScoredIds.has(doc.doc_id)) continue;
            alreadyScoredIds.add(doc.doc_id);
            const colName = doc.doc_type === 'note' ? 'note_id' : 'source_id';
            const expChunks = db.prepare(
              `SELECT id as chunk_id, ${colName}, content, embedding FROM vault_chunks WHERE ${colName} = ? AND embedding IS NOT NULL`
            ).all(doc.doc_id);

            for (const chunk of expChunks) {
              const sim = cosineSimilarity(queryEmbedding, bufferToEmbedding(chunk.embedding));
              const decay = doc.depth === 1 ? 0.85 : 0.70;
              const decayedScore = sim * decay;
              if (decayedScore >= min_relevance) {
                const title = doc.doc_type === 'note'
                  ? db.prepare('SELECT title FROM vault_notes WHERE id = ?').get(doc.doc_id)?.title
                  : db.prepare('SELECT filename FROM vault_sources WHERE id = ?').get(doc.doc_id)?.filename;
                scored.push({
                  chunk_id: chunk.chunk_id, note_id: doc.doc_type === 'note' ? doc.doc_id : null,
                  source_id: doc.doc_type === 'source' ? doc.doc_id : null,
                  title: title || 'Unknown', content: chunk.content.slice(0, 500),
                  score: decayedScore, updated_at: null,
                  result_type: doc.doc_type, via_graph: true,
                });
              }
            }
          }
          scored.sort((a, b) => b.score - a.score);
        } catch (e) {
          // Graph expansion is non-critical
        }
      }

      const results = scored.slice(0, limit);

      // Audit logging
      if (agent_id) {
        for (const r of results) {
          this.logAgentRead(db, {
            agent_id,
            note_id: r.note_id,
            source_id: r.source_id,
            chunk_id: r.chunk_id,
            conversation_id,
            relevance_score: r.score,
          });
        }
      }

      return results;
    } catch (err) {
      console.error('[Vault] searchForAgent error:', err.message);
      return [];
    }
  },

  /**
   * Log an agent read to the vault_agent_reads audit table.
   */
  logAgentRead(db, { agent_id, note_id = null, source_id = null, chunk_id = null, conversation_id = null, relevance_score = null }) {
    db.prepare(`
      INSERT INTO vault_agent_reads (id, agent_id, note_id, source_id, chunk_id, conversation_id, relevance_score)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(generateId(), agent_id, note_id, source_id, chunk_id, conversation_id, relevance_score);
  },

  /**
   * Create a note from an agent, auto-tagged with agent:{name}.
   */
  injectAgentNote(db, { agent_id, agent_name, title, content, folder_id = null }) {
    if (!title) throw new Error('Title is required');
    if (!agent_name) throw new Error('Agent name is required');

    const tagName = `agent:${agent_name}`;

    // Find or create the agent tag
    db.prepare('INSERT OR IGNORE INTO vault_tags (id, name) VALUES (?, ?)').run(generateId(), tagName);
    const tag = db.prepare('SELECT id FROM vault_tags WHERE name = ?').get(tagName);

    const note = this.createNote(db, { title, content, folder_id, tags: tag ? [tag.id] : [] });
    return note;
  },

  /**
   * Get audit trail of what an agent has accessed in the vault.
   */
  getAgentReads(db, agent_id, { limit = 50, offset = 0 } = {}) {
    const total = db.prepare(
      'SELECT COUNT(*) as n FROM vault_agent_reads WHERE agent_id = ?'
    ).get(agent_id).n;

    const reads = db.prepare(`
      SELECT r.*,
             n.title as note_title, n.slug as note_slug,
             s.filename as source_filename, s.file_path as source_path
      FROM vault_agent_reads r
      LEFT JOIN vault_notes n ON n.id = r.note_id
      LEFT JOIN vault_sources s ON s.id = r.source_id
      WHERE r.agent_id = ?
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?
    `).all(agent_id, parseInt(limit), parseInt(offset));

    return { reads, total };
  },
  // ----------------------------------------------------------
  // Import
  // ----------------------------------------------------------

  _importState: {
    isImporting: false,
    phase: null,
    total: 0,
    processed: 0,
    currentFile: null,
    errors: [],
    result: null,
  },

  getImportStatus() {
    return { ...this._importState };
  },

  _resetImportState() {
    this._importState.isImporting = false;
    this._importState.phase = null;
    this._importState.total = 0;
    this._importState.processed = 0;
    this._importState.currentFile = null;
    this._importState.errors = [];
    this._importState.result = null;
  },

  _updateImportState(updates) {
    Object.assign(this._importState, updates);
  },

  /**
   * Walk a directory recursively, returning .md file entries.
   * Skips hidden dirs and common non-content directories.
   */
  _walkMarkdownFiles(dirPath, { skipDirs = [] } = {}) {
    const results = [];
    const skipSet = new Set(['node_modules', '.git', '.svn', '__pycache__', '.DS_Store', ...skipDirs]);

    function walk(dir, relDir) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.') continue;
        const fullPath = pathModule.join(dir, entry.name);

        if (entry.isDirectory()) {
          if (skipSet.has(entry.name)) continue;
          const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
          walk(fullPath, childRel);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          results.push({
            fullPath,
            relDir: relDir || '',
            filename: entry.name,
          });
        }
      }
    }

    walk(dirPath, '');
    return results;
  },

  /**
   * Import a directory of .md files into the vault.
   * Two-pass: create notes first, then re-resolve wikilinks.
   */
  async importMarkdownDirectory(db, dirPath) {
    if (this._importState.isImporting) throw new Error('An import is already in progress');
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      throw new Error('Path does not exist or is not a directory');
    }

    this._resetImportState();
    this._updateImportState({ isImporting: true, phase: 'scanning' });

    try {
      // Scan for .md files
      const files = this._walkMarkdownFiles(dirPath);
      this._updateImportState({ total: files.length, phase: 'importing' });

      if (files.length === 0) {
        this._updateImportState({ isImporting: false, phase: 'done', result: { imported: 0, skipped: 0, errors: [] } });
        return;
      }

      // Build folder map: relative dir path → vault folder ID
      const folderMap = new Map(); // relDir → folderId
      const ensureFolder = (relDir) => {
        if (!relDir) return null;
        if (folderMap.has(relDir)) return folderMap.get(relDir);
        const parts = relDir.split('/');
        let parentId = null;
        let builtPath = '';
        for (const part of parts) {
          builtPath = builtPath ? `${builtPath}/${part}` : part;
          if (folderMap.has(builtPath)) {
            parentId = folderMap.get(builtPath);
          } else {
            const folder = this.createFolder(db, { name: part, parent_id: parentId });
            folderMap.set(builtPath, folder.id);
            parentId = folder.id;
          }
        }
        return parentId;
      };

      // Pass 1: Create notes in a transaction
      const importedIds = [];
      const importedContents = new Map(); // noteId → content for pass 2

      const insertBatch = db.transaction((batch) => {
        for (const file of batch) {
          try {
            const raw = fs.readFileSync(file.fullPath, 'utf-8');
            const { frontmatter, body } = parseFrontmatter(raw);

            // Extract title: frontmatter.title > first heading > filename
            let title = frontmatter.title;
            if (!title) {
              const headingMatch = body.match(/^#\s+(.+)$/m);
              title = headingMatch ? headingMatch[1].trim() : file.filename.replace(/\.md$/, '');
            }

            // Extract tags from frontmatter
            let fmTags = [];
            if (frontmatter.tags) {
              if (Array.isArray(frontmatter.tags)) {
                fmTags = frontmatter.tags;
              } else if (typeof frontmatter.tags === 'string') {
                fmTags = frontmatter.tags.split(/[,\s]+/).filter(Boolean);
              }
            }

            const folderId = ensureFolder(file.relDir);
            const note = this.createNote(db, { title, content: body, folder_id: folderId, tags: [] });

            // Sync frontmatter tags (create if needed, link to note)
            if (fmTags.length) {
              for (const tagName of fmTags) {
                if (!tagName) continue;
                db.prepare('INSERT OR IGNORE INTO vault_tags (id, name) VALUES (?, ?)').run(generateId(), tagName);
                const tag = db.prepare('SELECT id FROM vault_tags WHERE name = ?').get(tagName);
                if (tag) {
                  db.prepare('INSERT OR IGNORE INTO vault_note_tags (note_id, tag_id) VALUES (?, ?)').run(note.id, tag.id);
                }
              }
            }

            importedIds.push(note.id);
            importedContents.set(note.id, body);
            this._updateImportState({ processed: importedIds.length, currentFile: file.filename });
          } catch (e) {
            this._importState.errors.push(`${file.fullPath}: ${e.message}`);
          }
        }
      });

      // Process in batches of 50
      for (let i = 0; i < files.length; i += 50) {
        insertBatch(files.slice(i, i + 50));
        if (i + 50 < files.length) await new Promise(r => setTimeout(r, 10));
      }

      // Pass 2: Re-resolve wikilinks now that all notes exist
      this._updateImportState({ phase: 'linking', processed: 0, total: importedIds.length });
      for (let i = 0; i < importedIds.length; i++) {
        const noteId = importedIds[i];
        const content = importedContents.get(noteId);
        if (content) {
          try { this._syncWikilinks(db, noteId, content); } catch { /* non-critical */ }
        }
        if (i % 50 === 0) {
          this._updateImportState({ processed: i + 1 });
          await new Promise(r => setTimeout(r, 1));
        }
      }

      // Pass 3: Batch embedding (async, non-blocking)
      this._updateImportState({ phase: 'embedding', processed: 0, total: importedIds.length });
      for (let i = 0; i < importedIds.length; i++) {
        try {
          const note = db.prepare('SELECT content_plain FROM vault_notes WHERE id = ?').get(importedIds[i]);
          if (note?.content_plain) {
            await this._chunkAndEmbed(db, importedIds[i], note.content_plain);
          }
        } catch { /* non-critical */ }
        this._updateImportState({ processed: i + 1 });
        if (i % 20 === 0 && i > 0) await new Promise(r => setTimeout(r, 50));
      }

      const result = {
        imported: importedIds.length,
        skipped: files.length - importedIds.length - this._importState.errors.length,
        errors: [...this._importState.errors],
      };
      this._updateImportState({ isImporting: false, phase: 'done', result });
      console.log(`[Vault] Import complete: ${result.imported} notes imported, ${result.errors.length} errors`);
    } catch (e) {
      this._updateImportState({ isImporting: false, phase: 'error', result: { error: e.message } });
      console.error('[Vault] Import failed:', e.message);
    }
  },

  /**
   * Import an Obsidian vault. Extends markdown import with Obsidian-specific handling:
   * - YAML frontmatter variations (tags, aliases, dates)
   * - [[note|display text]] wikilinks
   * - ![[image.png]] embed conversion
   * - Skips .obsidian/ directory
   */
  async importObsidianVault(db, dirPath) {
    if (this._importState.isImporting) throw new Error('An import is already in progress');
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      throw new Error('Path does not exist or is not a directory');
    }

    this._resetImportState();
    this._updateImportState({ isImporting: true, phase: 'scanning' });

    try {
      const files = this._walkMarkdownFiles(dirPath, { skipDirs: ['.obsidian', '.trash'] });
      this._updateImportState({ total: files.length, phase: 'importing' });

      if (files.length === 0) {
        this._updateImportState({ isImporting: false, phase: 'done', result: { imported: 0, skipped: 0, errors: [], warnings: [] } });
        return;
      }

      const folderMap = new Map();
      const ensureFolder = (relDir) => {
        if (!relDir) return null;
        if (folderMap.has(relDir)) return folderMap.get(relDir);
        const parts = relDir.split('/');
        let parentId = null;
        let builtPath = '';
        for (const part of parts) {
          builtPath = builtPath ? `${builtPath}/${part}` : part;
          if (folderMap.has(builtPath)) {
            parentId = folderMap.get(builtPath);
          } else {
            const folder = this.createFolder(db, { name: part, parent_id: parentId });
            folderMap.set(builtPath, folder.id);
            parentId = folder.id;
          }
        }
        return parentId;
      };

      // Alias map for wikilink resolution: alias → noteId
      const aliasMap = new Map();
      const importedIds = [];
      const importedContents = new Map();
      const warnings = [];

      const insertBatch = db.transaction((batch) => {
        for (const file of batch) {
          try {
            const raw = fs.readFileSync(file.fullPath, 'utf-8');
            const { frontmatter, body: rawBody } = parseFrontmatter(raw);

            // Convert ![[image.png]] embeds to standard markdown
            const body = rawBody.replace(/!\[\[([^\]]+)\]\]/g, (match, ref) => {
              if (/\.(png|jpg|jpeg|gif|svg|webp|bmp|pdf)$/i.test(ref)) {
                warnings.push(`Attachment reference not imported: ${ref} (in ${file.filename})`);
                return `![${ref}](${ref})`;
              }
              return match; // Keep non-image embeds as-is (they'll be treated as wikilinks)
            });

            // Title: frontmatter > first heading > filename
            let title = frontmatter.title;
            if (!title) {
              const headingMatch = body.match(/^#\s+(.+)$/m);
              title = headingMatch ? headingMatch[1].trim() : file.filename.replace(/\.md$/, '');
            }

            // Normalize tags from various Obsidian formats
            let fmTags = [];
            if (frontmatter.tags) {
              if (Array.isArray(frontmatter.tags)) {
                fmTags = frontmatter.tags;
              } else if (typeof frontmatter.tags === 'string') {
                // Obsidian supports: "tag1, tag2" or "tag1 tag2" or "#tag1 #tag2"
                fmTags = frontmatter.tags.split(/[,\s]+/).map(t => t.replace(/^#/, '')).filter(Boolean);
              }
            }

            const folderId = ensureFolder(file.relDir);
            const note = this.createNote(db, { title, content: body, folder_id: folderId, tags: [] });

            // Sync frontmatter tags
            if (fmTags.length) {
              for (const tagName of fmTags) {
                if (!tagName) continue;
                db.prepare('INSERT OR IGNORE INTO vault_tags (id, name) VALUES (?, ?)').run(generateId(), tagName);
                const tag = db.prepare('SELECT id FROM vault_tags WHERE name = ?').get(tagName);
                if (tag) {
                  db.prepare('INSERT OR IGNORE INTO vault_note_tags (note_id, tag_id) VALUES (?, ?)').run(note.id, tag.id);
                }
              }
            }

            // Register aliases for wikilink resolution
            if (frontmatter.aliases) {
              const aliases = Array.isArray(frontmatter.aliases)
                ? frontmatter.aliases
                : String(frontmatter.aliases).split(/[,\s]+/).filter(Boolean);
              for (const alias of aliases) {
                aliasMap.set(alias.toLowerCase(), note.id);
              }
            }
            // Also register title for alias resolution
            aliasMap.set(title.toLowerCase(), note.id);

            importedIds.push(note.id);
            importedContents.set(note.id, body);
            this._updateImportState({ processed: importedIds.length, currentFile: file.filename });
          } catch (e) {
            this._importState.errors.push(`${file.fullPath}: ${e.message}`);
          }
        }
      });

      for (let i = 0; i < files.length; i += 50) {
        insertBatch(files.slice(i, i + 50));
        if (i + 50 < files.length) await new Promise(r => setTimeout(r, 10));
      }

      // Pass 2: Re-resolve wikilinks (including Obsidian [[note|display]] syntax)
      this._updateImportState({ phase: 'linking', processed: 0, total: importedIds.length });
      for (let i = 0; i < importedIds.length; i++) {
        const noteId = importedIds[i];
        const content = importedContents.get(noteId);
        if (content) {
          try {
            // Handle [[note|display text]] — extract note part for resolution
            const normalizedContent = content.replace(/\[\[([^|\]]+)\|[^\]]+\]\]/g, '[[$1]]');
            this._syncWikilinks(db, noteId, normalizedContent);

            // Also try alias-based resolution for unresolved links
            const targets = parseWikilinks(normalizedContent);
            for (const target of targets) {
              const existing = db.prepare('SELECT id FROM vault_notes WHERE title = ? COLLATE NOCASE').get(target);
              if (!existing) {
                const aliasId = aliasMap.get(target.toLowerCase());
                if (aliasId) {
                  db.prepare('INSERT OR IGNORE INTO vault_links (id, source_note_id, target_note_id, link_type) VALUES (?, ?, ?, ?)')
                    .run(generateId(), noteId, aliasId, 'reference');
                }
              }
            }
          } catch { /* non-critical */ }
        }
        if (i % 50 === 0) {
          this._updateImportState({ processed: i + 1 });
          await new Promise(r => setTimeout(r, 1));
        }
      }

      // Pass 3: Batch embedding
      this._updateImportState({ phase: 'embedding', processed: 0, total: importedIds.length });
      for (let i = 0; i < importedIds.length; i++) {
        try {
          const note = db.prepare('SELECT content_plain FROM vault_notes WHERE id = ?').get(importedIds[i]);
          if (note?.content_plain) {
            await this._chunkAndEmbed(db, importedIds[i], note.content_plain);
          }
        } catch { /* non-critical */ }
        this._updateImportState({ processed: i + 1 });
        if (i % 20 === 0 && i > 0) await new Promise(r => setTimeout(r, 50));
      }

      const result = {
        imported: importedIds.length,
        skipped: files.length - importedIds.length - this._importState.errors.length,
        errors: [...this._importState.errors],
        warnings,
      };
      this._updateImportState({ isImporting: false, phase: 'done', result });
      console.log(`[Vault] Obsidian import complete: ${result.imported} notes, ${warnings.length} warnings, ${result.errors.length} errors`);
    } catch (e) {
      this._updateImportState({ isImporting: false, phase: 'error', result: { error: e.message } });
      console.error('[Vault] Obsidian import failed:', e.message);
    }
  },

  // ----------------------------------------------------------
  // Export
  // ----------------------------------------------------------

  /**
   * Assemble vault data for export. Returns structured data — the route handles ZIP streaming.
   * If folderId is given, exports only that folder and its descendants.
   */
  exportVault(db, { folderId = null } = {}) {
    // Get all folders flat
    const allFolders = db.prepare('SELECT * FROM vault_folders ORDER BY sort_order, name').all();

    // Build folder path map: folderId → "Parent/Child/Grandchild"
    const folderPathMap = new Map();
    function buildPath(id) {
      if (!id) return '';
      if (folderPathMap.has(id)) return folderPathMap.get(id);
      const folder = allFolders.find(f => f.id === id);
      if (!folder) return '';
      const parentPath = buildPath(folder.parent_id);
      const path = parentPath ? `${parentPath}/${folder.name}` : folder.name;
      folderPathMap.set(id, path);
      return path;
    }
    for (const f of allFolders) buildPath(f.id);

    // If filtering by folder, collect descendant IDs
    let folderFilter = null;
    if (folderId) {
      folderFilter = new Set([folderId]);
      function collectDescendants(parentId) {
        for (const f of allFolders) {
          if (f.parent_id === parentId && !folderFilter.has(f.id)) {
            folderFilter.add(f.id);
            collectDescendants(f.id);
          }
        }
      }
      collectDescendants(folderId);
    }

    let notes;
    if (folderFilter) {
      notes = db.prepare(
        `SELECT * FROM vault_notes WHERE is_archived = 0 AND folder_id IN (${[...folderFilter].map(() => '?').join(',')})`
      ).all(...folderFilter);
    } else {
      notes = db.prepare('SELECT * FROM vault_notes WHERE is_archived = 0').all();
    }

    // Attach tags to each note
    const tagStmt = db.prepare(`
      SELECT t.name FROM vault_tags t
      JOIN vault_note_tags nt ON nt.tag_id = t.id
      WHERE nt.note_id = ?
    `);
    for (const note of notes) {
      note.tagNames = tagStmt.all(note.id).map(t => t.name);
      note.folderPath = folderPathMap.get(note.folder_id) || '';
    }

    const exportFolders = folderFilter
      ? allFolders.filter(f => folderFilter.has(f.id))
      : allFolders;

    return {
      notes,
      folders: exportFolders.map(f => ({ ...f, path: folderPathMap.get(f.id) || f.name })),
      manifest: {
        exported_at: new Date().toISOString(),
        version: '1.0',
        note_count: notes.length,
        folder_count: exportFolders.length,
      },
    };
  },
};

module.exports = VaultService;
