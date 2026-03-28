const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ConversationService = require('../services/conversation');
const DigestService = require('../services/digest');
const {
  getEmbedder, chunkText, cosineSimilarity, embeddingToBuffer, bufferToEmbedding,
  getTextHash, categorize, cleanTextForEmbedding, extractKeywords,
  STOPWORDS, MODEL_NAME, EMBEDDING_DIMS
} = require('./memory-embeddings');
const applyNotesMixin = require('./memory-notes');

class MemoryService {
  constructor(appPath, db, appId = null) {
    this.appPath = appPath;
    this.db = db;
    this.appId = appId || path.basename(appPath);
    this.memoryDir = path.join(appPath, 'memory');
    this.modelName = MODEL_NAME;

    // For legacy compatibility - path to old JSON index
    this.indexPath = path.join(appPath, 'memory-index.json');

    // Cache statistics
    this.cacheHits = 0;
    this.cacheMisses = 0;

    // Prepare statements for performance
    this._prepareStatements();

    // Clean up any corrupted daily notes with duplicate sections
    try {
      this.cleanupDailyNote();
    } catch (err) {
      // Non-fatal - just log and continue
      console.warn('Memory: Failed to cleanup daily note:', err.message);
    }
  }

  _prepareStatements() {
    // Chunk operations
    this.stmtInsertChunk = this.db.prepare(`
      INSERT OR REPLACE INTO memory_chunks
      (app_id, text, text_hash, source, chunk_index, category, embedding, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    this.stmtDeleteSourceChunks = this.db.prepare(`
      DELETE FROM memory_chunks WHERE app_id = ? AND source = ?
    `);

    this.stmtGetChunksBySource = this.db.prepare(`
      SELECT * FROM memory_chunks WHERE app_id = ? AND source = ?
    `);

    this.stmtGetAllChunks = this.db.prepare(`
      SELECT id, text, text_hash, source, chunk_index, category, embedding
      FROM memory_chunks WHERE app_id = ?
    `);

    this.stmtGetChunksByIds = this.db.prepare(`
      SELECT id, text, source, chunk_index, category, created_at
      FROM memory_chunks WHERE app_id = ? AND id IN (SELECT value FROM json_each(?))
    `);

    // Source operations
    this.stmtUpsertSource = this.db.prepare(`
      INSERT OR REPLACE INTO memory_sources
      (app_id, source, type, source_hash, last_indexed_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    this.stmtDeleteSource = this.db.prepare(`
      DELETE FROM memory_sources WHERE app_id = ? AND source = ?
    `);

    this.stmtGetSource = this.db.prepare(`
      SELECT * FROM memory_sources WHERE app_id = ? AND source = ?
    `);

    // Embedding cache operations
    this.stmtGetCachedEmbedding = this.db.prepare(`
      SELECT embedding FROM embedding_cache WHERE text_hash = ? AND model = ?
    `);

    this.stmtCacheEmbedding = this.db.prepare(`
      INSERT OR REPLACE INTO embedding_cache (text_hash, model, embedding)
      VALUES (?, ?, ?)
    `);

    // FTS operations
    this.stmtFtsSearch = this.db.prepare(`
      SELECT f.rowid, bm25(memory_fts) as score
      FROM memory_fts f
      JOIN memory_chunks c ON c.id = f.rowid
      WHERE memory_fts MATCH ? AND c.app_id = ?
      ORDER BY score
      LIMIT ?
    `);

    // Stats
    this.stmtCountChunks = this.db.prepare(`
      SELECT COUNT(*) as count FROM memory_chunks WHERE app_id = ?
    `);

    this.stmtCountSources = this.db.prepare(`
      SELECT COUNT(*) as count FROM memory_sources WHERE app_id = ?
    `);

    this.stmtLastIndexed = this.db.prepare(`
      SELECT MAX(last_indexed_at) as ts FROM memory_sources WHERE app_id = ?
    `);

    // In-memory chunk cache - loads all chunks and keeps them until memory is updated
    // This avoids repeated DB reads (the main bottleneck)
    this._chunkCache = null;
    this._chunkCacheValid = false;
    this._chunkCacheTime = 0;
    this._chunkCacheTTL = 24 * 60 * 60 * 1000; // 24 hour max TTL (refresh daily)
    this._lastChunkRefreshTime = Date.now(); // Track when chunks were last refreshed for history overlap

    // Pre-load chunks at initialization (async, non-blocking)
    this._preloadChunks();
  }

  // Pre-load chunks into memory cache (called at initialization)
  _preloadChunks() {
    try {
      this._chunkCache = this.stmtGetAllChunks.all(this.appId);
      this._chunkCacheValid = true;
      this._chunkCacheTime = Date.now();
      this._lastChunkRefreshTime = Date.now(); // Conversation history should go back to this point
      console.log(`[Memory] Pre-loaded ${this._chunkCache.length} chunks into memory cache`);
    } catch (err) {
      console.warn('[Memory] Failed to pre-load chunks:', err.message);
    }
  }

  // Get time since last chunk refresh (for conversation history overlap)
  getTimeSinceChunkRefresh() {
    return Date.now() - this._lastChunkRefreshTime;
  }

  // Get raw conversation entries from DB, anchored from lastActivity
  getRawConversationEntries(windowMs = null) {
    if (!this.db) return [];

    try {
      const window = windowMs || 4 * 60 * 60 * 1000;
      return ConversationService.getEntriesSince(this.db, this.appId, window);
    } catch (err) {
      console.warn('Memory: Failed to get raw entries from DB:', err.message);
      return [];
    }
  }

  /**
   * Get lastActivity — the timestamp of the most recent conversation entry for this agent.
   * All memory tier windows are computed relative to this anchor.
   * @returns {string|null} ISO timestamp or null
   */
  getLastActivity() {
    if (!this.db) return null;
    try {
      const row = this.db.prepare(
        'SELECT MAX(timestamp) as ts FROM conversation_entries WHERE app_id = ?'
      ).get(this.appId);
      return row?.ts || null;
    } catch (err) {
      return null;
    }
  }

  /**
   * Format digests into context text
   * @param {Array} digests - Array of digest objects
   * @returns {string} Formatted digest text
   */
  static formatDigests(digests) {
    if (!digests || digests.length === 0) return '';

    const lines = [];
    for (const digest of digests) {
      const startTime = new Date(digest.time_start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      const endTime = new Date(digest.time_end).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      const dateStr = new Date(digest.time_start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

      lines.push(`[${dateStr}, ${startTime} - ${endTime}]`);
      lines.push(digest.content);
      lines.push('');
    }

    return lines.join('\n');
  }

  // Format raw conversation entries into text for Claude context
  static formatConversationEntries(entries) {
    return entries.map(e => {
      const ts = new Date(e.timestamp);
      const time = ts.toLocaleString('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
      });

      let badge = '';
      if (e.type === 'journal') {
        badge = ' [journal]';
      } else if (e.channel !== 'desktop') {
        badge = ` via ${e.channel}`;
      }

      return `[${time}${badge}]\n${e.speaker}: ${e.content}`;
    }).join('\n\n');
  }

  // Get full conversation transcript since last chunk refresh (minimum 24 hours)
  // Uses raw entries from DB, falls back to MD file parsing
  getLast24HoursConversation() {
    const entries = this.getRawConversationEntries();
    if (entries.length > 0) {
      return MemoryService.formatConversationEntries(entries);
    }

    // Fallback to legacy MD file parsing (for backward compatibility during migration)
    return this._getLast24HoursConversationFromMd();
  }

  /**
   * Get last N conversation entries (for keyword extraction and composite search queries)
   * @param {number} n - Number of entries to retrieve
   * @returns {Array} Entries ordered by timestamp ASC (oldest first)
   */
  getLastNEntries(n = 10) {
    if (!this.db) return [];
    try {
      return this.db.prepare(`
        SELECT id, type, speaker, role, channel, content, timestamp
        FROM conversation_entries
        WHERE app_id = ? AND type != 'image'
        ORDER BY timestamp DESC
        LIMIT ?
      `).all(this.appId, n).reverse();
    } catch (err) {
      return [];
    }
  }

  /**
   * Get raw entries within a specific time range (for drill-down from semantic search)
   * @param {string} timeStart - ISO timestamp (inclusive)
   * @param {string} timeEnd - ISO timestamp (inclusive)
   * @param {number} [maxChars] - Optional character budget
   * @returns {Array} Entries ordered by timestamp ASC
   */
  getRawEntriesInRange(timeStart, timeEnd, maxChars = Infinity) {
    if (!this.db) return [];
    try {
      const entries = this.db.prepare(`
        SELECT id, type, speaker, role, channel, content, timestamp
        FROM conversation_entries
        WHERE app_id = ? AND type != 'image'
          AND timestamp >= ? AND timestamp <= ?
        ORDER BY timestamp ASC
      `).all(this.appId, timeStart, timeEnd);

      if (maxChars === Infinity) return entries;

      // Budget-gate: take entries until budget exhausted
      let chars = 0;
      const result = [];
      for (const e of entries) {
        chars += (e.content || '').length;
        if (chars > maxChars && result.length > 0) break;
        result.push(e);
      }
      return result;
    } catch (err) {
      return [];
    }
  }

  // Get embedding with cache support
  async getEmbedding(text) {
    const hash = getTextHash(text);

    // Check cache
    const cached = this.stmtGetCachedEmbedding.get(hash, this.modelName);
    if (cached) {
      this.cacheHits++;
      return bufferToEmbedding(cached.embedding);
    }

    this.cacheMisses++;

    // Generate new embedding
    const embed = await getEmbedder();
    const output = await embed(text, { pooling: 'mean', normalize: true });
    const embedding = new Float32Array(output.data);

    // Cache it
    this.stmtCacheEmbedding.run(hash, this.modelName, embeddingToBuffer(embedding));

    return embedding;
  }

  // Index a file (memory file, MYSELF.md, etc.)
  async indexFile(filePath) {
    if (!fs.existsSync(filePath)) return;

    const content = fs.readFileSync(filePath, 'utf-8');
    const fileHash = crypto.createHash('sha256').update(content).digest('hex');

    // Determine source name (relative to app path)
    const source = path.relative(this.appPath, filePath);
    const category = categorize(source);
    const type = category;

    // Check if file has changed
    const existingSource = this.stmtGetSource.get(this.appId, source);
    if (existingSource && existingSource.source_hash === fileHash) {
      // File unchanged, skip
      return;
    }

    const chunks = chunkText(content);

    // Use transaction for atomic update
    const indexChunks = this.db.transaction(async () => {
      // Remove old chunks from this source
      this.stmtDeleteSourceChunks.run(this.appId, source);

      // Add new chunks
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const textHash = getTextHash(chunk);
        const embedding = await this.getEmbedding(chunk);

        this.stmtInsertChunk.run(
          this.appId,
          chunk,
          textHash,
          source,
          i,
          category,
          embeddingToBuffer(embedding)
        );
      }

      // Update source record
      this.stmtUpsertSource.run(this.appId, source, type, fileHash);
    });

    // Note: transaction() returns a function, we need to call it
    // But since we have async operations inside, we need a different approach

    // Remove old chunks from this source
    this.stmtDeleteSourceChunks.run(this.appId, source);

    // Add new chunks
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const textHash = getTextHash(chunk);
      // Embed cleaned text for better semantic matching, but store raw text in DB
      const cleanedChunk = cleanTextForEmbedding(chunk);
      const embedding = await this.getEmbedding(cleanedChunk || chunk);

      this.stmtInsertChunk.run(
        this.appId,
        chunk,
        textHash,
        source,
        i,
        category,
        embeddingToBuffer(embedding)
      );
    }

    // Update source record
    this.stmtUpsertSource.run(this.appId, source, type, fileHash);

    // Invalidate cache since memory was updated
    this.invalidateChunkCache();

    return chunks.length;
  }

  // Remove a source (when file is deleted)
  removeSource(filePath) {
    const source = path.relative(this.appPath, filePath);

    this.stmtDeleteSourceChunks.run(this.appId, source);
    this.stmtDeleteSource.run(this.appId, source);

    // Invalidate cache since memory was updated
    this.invalidateChunkCache();
  }

  // Index all memory files
  async indexAllMemory() {
    let totalChunks = 0;

    // Index bootstrap files
    const bootstrapFiles = ['MYSELF.md', 'USER.md', 'MEMORY.md'];
    for (const file of bootstrapFiles) {
      const filePath = path.join(this.appPath, file);
      if (fs.existsSync(filePath)) {
        const count = await this.indexFile(filePath);
        if (count) totalChunks += count;
      }
    }

    // Index daily notes
    this.ensureMemoryDir();
    const dailyNotes = fs.readdirSync(this.memoryDir)
      .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.md$/));

    for (const note of dailyNotes) {
      const filePath = path.join(this.memoryDir, note);
      const count = await this.indexFile(filePath);
      if (count) totalChunks += count;
    }

    const stats = this.getStats();
    console.log(`Indexed ${stats.totalChunks} chunks from ${stats.totalSources} sources`);

    return stats;
  }

  // Force re-index all memory (clears existing chunks/sources and rebuilds from scratch)
  // Use after changing chunking strategy, preprocessing, or embedding approach
  async forceReindexAll() {
    console.log('[Memory] Force re-indexing: clearing all chunks and sources...');

    // Delete all chunks and sources for this app
    this.db.prepare('DELETE FROM memory_chunks WHERE app_id = ?').run(this.appId);
    this.db.prepare('DELETE FROM memory_sources WHERE app_id = ?').run(this.appId);

    // Rebuild FTS index
    try {
      this.db.prepare("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')").run();
    } catch (err) {
      console.warn('[Memory] FTS rebuild warning:', err.message);
    }

    // Invalidate cache
    this.invalidateChunkCache();

    console.log('[Memory] Cleared. Re-indexing all memory files...');

    // Re-index everything (indexFile will see no existing source_hash, so it processes all files)
    const stats = await this.indexAllMemory();

    console.log(`[Memory] Force re-index complete: ${stats.totalChunks} chunks from ${stats.totalSources} sources`);
    return stats;
  }

  // Escape query for FTS5 — use OR so partial keyword matches still return results
  // BM25 naturally ranks chunks with more matching terms higher
  ftsEscape(query) {
    const tokens = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(t => t.length > 1);  // Skip single-char tokens (noise)

    return tokens.join(' OR ');
  }

  // Search memory by semantic similarity (vector search)
  // Optimized: uses permanent in-memory cache, reloads when invalidated or after 24 hours
  async searchVector(query, topK = 10) {
    // Clean query for better semantic matching (strip any formatting noise)
    const cleanedQuery = cleanTextForEmbedding(query) || query;
    const queryEmbedding = await this.getEmbedding(cleanedQuery);

    // Reload cache if invalidated or older than 24 hours
    const cacheAge = Date.now() - this._chunkCacheTime;
    const cacheExpired = cacheAge > this._chunkCacheTTL;

    if (!this._chunkCacheValid || !this._chunkCache || cacheExpired) {
      const reason = cacheExpired ? '24h refresh' : 'invalidated/empty';
      this._chunkCache = this.stmtGetAllChunks.all(this.appId);
      this._chunkCacheValid = true;
      this._chunkCacheTime = Date.now();
      this._lastChunkRefreshTime = Date.now(); // Reset - conversation history can now be shorter
      console.log(`[Memory] Reloaded ${this._chunkCache.length} chunks into cache (${reason})`);
    }

    const chunks = this._chunkCache;
    if (!chunks.length) {
      return [];
    }

    // Score all chunks by cosine similarity
    const scored = chunks.map(chunk => {
      const embedding = bufferToEmbedding(chunk.embedding);
      return {
        id: chunk.id,
        text: chunk.text,
        source: chunk.source,
        category: chunk.category,
        score: cosineSimilarity(queryEmbedding, embedding)
      };
    });

    // Sort by score and return top K
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  // Invalidate chunk cache (call when memory is updated)
  invalidateChunkCache() {
    this._chunkCacheValid = false;
    this._chunkCacheTime = 0; // Reset time so next load happens immediately
    console.log('[Memory] Chunk cache invalidated');
  }

  // Get chunks by IDs
  getChunksByIds(ids) {
    if (!ids.length) return new Map();

    const rows = this.stmtGetChunksByIds.all(this.appId, JSON.stringify(ids));
    const map = new Map();
    for (const row of rows) {
      map.set(row.id, row);
    }
    return map;
  }

  // Hybrid search (vector + BM25 with RRF)
  async searchHybrid(query, topK = 5, options = {}) {
    const {
      vectorWeight = 0.6,       // Embeddings are more accurate after preprocessing
      textWeight = 0.4,
      k = 20,                   // Lower k = wider score spread, top results more distinct
      recencyBoostDays = 14,
      recencyBoostMultiplier = 1.15,  // Meaningful but not dominant
      excludeLast24Hours = false  // Exclude today's daily note (already in conversation context)
    } = options;

    // Calculate date patterns to exclude if excludeLast24Hours is true
    // Only exclude today's note — yesterday's note is searchable for entries older than 24h
    // (conversation history already covers the last 24h, so today's note would be redundant)
    let excludeSources = new Set();
    excludeSources.add('MYSELF.md');
    excludeSources.add('USER.md');
    if (excludeLast24Hours) {
      const now = new Date();
      excludeSources.add(`memory/${this.getDateString(now)}.md`);
    }

    // Vector search
    let vectorResults = await this.searchVector(query, topK * 3);

    // Filter out excluded sources
    if (excludeSources.size > 0) {
      vectorResults = vectorResults.filter(r => !excludeSources.has(r.source));
    }

    // BM25 search via FTS5
    const escapedQuery = this.ftsEscape(query);
    if (!escapedQuery) {
      // No valid tokens, return vector-only results
      return vectorResults.slice(0, topK);
    }

    let ftsResults = [];
    try {
      ftsResults = this.stmtFtsSearch.all(escapedQuery, this.appId, topK * 3);
    } catch (err) {
      // FTS query syntax error, fall back to vector-only
      console.warn('FTS search error:', err.message);
      return vectorResults.slice(0, topK);
    }

    // Build rank maps (1-indexed)
    const vectorRanks = new Map();
    vectorResults.forEach((r, i) => vectorRanks.set(r.id, i + 1));

    const ftsRanks = new Map();
    ftsResults.forEach((r, i) => ftsRanks.set(r.rowid, i + 1));

    // Collect all candidate IDs
    const allIds = new Set([...vectorRanks.keys(), ...ftsRanks.keys()]);

    // Calculate RRF scores
    const scored = [];
    for (const id of allIds) {
      const vectorRank = vectorRanks.get(id) || Infinity;
      const ftsRank = ftsRanks.get(id) || Infinity;

      const vectorRRF = vectorRank === Infinity ? 0 : 1 / (k + vectorRank);
      const ftsRRF = ftsRank === Infinity ? 0 : 1 / (k + ftsRank);

      const score = (vectorWeight * vectorRRF) + (textWeight * ftsRRF);
      scored.push({ id, score, vectorRank, ftsRank });
    }

    // Sort by RRF score
    scored.sort((a, b) => b.score - a.score);

    // Fetch chunk details for top candidates
    const topCandidates = scored.slice(0, topK * 2);
    const chunks = this.getChunksByIds(topCandidates.map(s => s.id));

    // Post-rerank with category boost and recency boost
    const categoryBoost = { 'identity': 1.2, 'session_digest': 1.1, 'daily_digest': 1.05, 'curated': 1.15, 'daily': 1.0 };
    const now = Date.now();
    const recencyCutoff = now - (recencyBoostDays * 24 * 60 * 60 * 1000);

    const finalScored = topCandidates.map(s => {
      const chunk = chunks.get(s.id);
      if (!chunk) return { ...s, finalScore: 0 };

      // Filter out excluded sources (last 24h daily notes)
      if (excludeSources.size > 0 && excludeSources.has(chunk.source)) {
        return { ...s, finalScore: 0, excluded: true };
      }

      let boost = categoryBoost[chunk.category] || 1.0;

      // Apply recency boost for recent chunks
      const chunkDate = new Date(chunk.created_at).getTime();
      if (chunkDate > recencyCutoff) {
        boost *= recencyBoostMultiplier;
      }

      return {
        ...s,
        ...chunk,
        finalScore: s.score * boost
      };
    });

    // Final sort and return top K (filter out excluded)
    finalScored.sort((a, b) => b.finalScore - a.finalScore);
    const filtered = finalScored.filter(r => !r.excluded);

    return filtered.slice(0, topK).map(r => ({
      id: r.id,
      text: r.text,
      source: r.source,
      category: r.category,
      score: r.finalScore,
      vectorRank: r.vectorRank,
      ftsRank: r.ftsRank
    }));
  }

  // Legacy search method (now uses hybrid search)
  async search(query, topK = 5) {
    return this.searchHybrid(query, topK);
  }

  // Check if message is simple enough to skip semantic search
  // Saves ~100-200ms on simple greetings, acknowledgments, etc.
  _isSimpleMessage(message) {
    const simple = message.trim().toLowerCase();
    // Skip semantic search for very short messages or common patterns
    if (simple.length < 15) return true;
    const simplePatterns = [
      /^(hi|hey|hello|yo|sup)\b/,
      /^(thanks|thank you|thx|ty)\b/,
      /^(ok|okay|sure|yes|no|yep|nope|yeah|nah)\b/,
      /^(good|great|nice|cool|awesome)\b/,
      /^(bye|goodbye|later|night|morning)\b/,
      /^(how are you|what's up|wassup)/
    ];
    return simplePatterns.some(p => p.test(simple));
  }

  /**
   * Get context for a message — 4-tier hierarchical memory assembly
   *
   * Tier 1: Raw conversation entries (most recent, full fidelity) — ~40% of conversation budget
   * Tier 2: Session digests (24h before lastActivity, compressed) — ~35% of conversation budget
   * Tier 3: Daily digests (7 days before Tier 2 window) — ~25% of conversation budget
   * Tier 4: Semantic search with drill-down — uses semantic budget (separate from conversation)
   *
   * All windows anchor from lastActivity (most recent conversation entry), not wall clock.
   */
  async getContextForMessage(message, options = {}) {
    const {
      conversationBudgetChars = 50000,
      semanticBudgetChars = 50000,
      skipSemanticSearch = false,
      forceSemanticSearch = false
    } = options;

    const context = {
      rawEntries: [],           // Tier 1: raw DB entries for interleaving with timeline images
      sessionDigests: '',       // Tier 2: formatted session digest text
      dailyDigests: '',         // Tier 3: formatted daily digest text
      semanticResults: '',      // Tier 4: formatted semantic search + drill-down
      // Legacy compat fields (consumed by buildMemoryContext/buildStreamJsonMessage)
      digestText: '',           // Tier 2 + Tier 3 combined (for legacy consumers)
      conversationHistory: '',  // Tier 1 formatted (for legacy text-path consumers)
      relevantMemory: [],       // Tier 4 raw chunks (for legacy consumers)
      lastActivity: null,
      truncated: false
    };

    // === Compute lastActivity anchor ===
    const lastActivity = this.getLastActivity();
    context.lastActivity = lastActivity;

    if (!lastActivity) {
      console.log('[Memory] No conversation entries — empty context');
      return context;
    }

    const lastActivityMs = new Date(lastActivity).getTime();

    // === Tier 1: Raw entries (budget-gated, most recent) ===
    const tier1Budget = Math.floor(conversationBudgetChars * 0.4);
    let rawEntries = [];
    try {
      // Get entries backwards from lastActivity, budget-gated
      const allRecent = this.db.prepare(`
        SELECT id, type, speaker, role, channel, content, timestamp
        FROM conversation_entries
        WHERE app_id = ? AND type != 'image'
        ORDER BY timestamp DESC
      `).all(this.appId);

      let chars = 0;
      for (const entry of allRecent) {
        const entryChars = (entry.content || '').length + 50; // +50 for formatting overhead
        if (chars + entryChars > tier1Budget && rawEntries.length > 0) {
          context.truncated = true;
          break;
        }
        chars += entryChars;
        rawEntries.push(entry);
      }
      // Reverse to chronological order
      rawEntries.reverse();
    } catch (err) {
      console.warn('[Memory] Failed to get raw entries:', err.message);
    }

    context.rawEntries = rawEntries;
    const oldestRawTimestamp = rawEntries.length > 0 ? rawEntries[0].timestamp : lastActivity;

    // Format raw entries for legacy text-path consumers
    if (rawEntries.length > 0) {
      context.conversationHistory = MemoryService.formatConversationEntries(rawEntries);
    }

    // === Tier 2: Session digests (24h window from lastActivity) ===
    // Always include session digests — they provide a summarized view even when
    // raw entries cover the same period (the summary helps the agent see patterns)
    const tier2Budget = Math.floor(conversationBudgetChars * 0.35);
    const sessionWindowStart = new Date(lastActivityMs - 24 * 60 * 60 * 1000).toISOString();
    let sessionDigests = [];
    try {
      sessionDigests = DigestService.getSessionDigestsInRange(
        this.db, this.appId, sessionWindowStart, lastActivity
      );
    } catch (err) {
      console.warn('[Memory] Failed to get session digests:', err.message);
    }

    if (sessionDigests.length > 0) {
      const formatted = MemoryService.formatDigests(sessionDigests);
      if (formatted.length > tier2Budget) {
        context.sessionDigests = formatted.slice(-tier2Budget);
        context.truncated = true;
      } else {
        context.sessionDigests = formatted;
      }
    }

    // === Tier 3: Daily digests (7 days up to and including today) ===
    const tier3Budget = Math.floor(conversationBudgetChars * 0.25);
    const dailyWindowStart = new Date(lastActivityMs - 8 * 24 * 60 * 60 * 1000);
    const dailyStartKey = dailyWindowStart.toISOString().split('T')[0];
    // Use tomorrow as exclusive end so today's daily digest is included
    const dailyEndDate = new Date(lastActivityMs + 24 * 60 * 60 * 1000);
    const dailyEndKey = dailyEndDate.toISOString().split('T')[0];
    let dailyDigests = [];
    try {
      dailyDigests = DigestService.getDailyDigestsInRange(
        this.db, this.appId, dailyStartKey, dailyEndKey
      );
    } catch (err) {
      console.warn('[Memory] Failed to get daily digests:', err.message);
    }

    if (dailyDigests.length > 0) {
      const formatted = MemoryService.formatDigests(dailyDigests);
      if (formatted.length > tier3Budget) {
        context.dailyDigests = formatted.slice(-tier3Budget);
        context.truncated = true;
      } else {
        context.dailyDigests = formatted;
      }
    }

    // Populate legacy digestText field (Tier 2 + Tier 3 combined)
    const digestParts = [];
    if (context.dailyDigests) digestParts.push(context.dailyDigests);
    if (context.sessionDigests) digestParts.push(context.sessionDigests);
    context.digestText = digestParts.join('\n');

    const conversationChars = context.conversationHistory.length + context.sessionDigests.length + context.dailyDigests.length;
    console.log(`[Memory] 3-tier: ${rawEntries.length} raw (${context.conversationHistory.length} chars) + ${sessionDigests.length} sessions (${context.sessionDigests.length} chars) + ${dailyDigests.length} daily (${context.dailyDigests.length} chars)`);

    // === Tier 4: Semantic search with drill-down ===
    const isSimple = this._isSimpleMessage(message);
    if (skipSemanticSearch || (isSimple && !forceSemanticSearch)) {
      if (isSimple) console.log('[Memory] Skipping semantic search for simple message');
      console.log(`Memory context: ${conversationChars} chars (semantic: skipped)`);
      return context;
    }

    if (semanticBudgetChars > 500) {
      try {
        // Build composite search query (Section 5 of spec)
        const recentEntries = this.getLastNEntries(10);
        const keywords = extractKeywords(recentEntries, { topK: 15 });
        const recentMessages = this.getLastNEntries(5)
          .map(e => `${e.speaker}: ${e.content}`)
          .join('\n');

        // Skip if too few meaningful terms
        if (keywords.length >= 3 || !isSimple) {
          const searchQuery = keywords.length > 0
            ? `${keywords.join(' ')}\n\n${recentMessages}`
            : recentMessages || message;

          const searchResults = await this.searchHybrid(searchQuery, 10, { excludeLast24Hours: true });

          // Build drill-down context from search results
          let semanticChars = 0;
          const semanticParts = [];

          for (const hit of searchResults) {
            if (semanticChars >= semanticBudgetChars) break;

            // Identity file hits: include as-is
            if (hit.source === 'MYSELF.md' || hit.source === 'USER.md') {
              if (semanticChars + hit.text.length <= semanticBudgetChars) {
                context.relevantMemory.push(hit);
                semanticChars += hit.text.length;
              }
              continue;
            }

            // Daily digest hit: drill down to sessions + raw entries
            if (hit.category === 'daily_digest') {
              const digestId = hit.chunk_index;
              if (semanticChars + hit.text.length > semanticBudgetChars) break;

              // Include the daily digest text
              context.relevantMemory.push(hit);
              semanticChars += hit.text.length;

              // Drill down: get session digests for that date
              try {
                const dailyDigest = this.db.prepare(
                  'SELECT date_key FROM conversation_digests WHERE id = ?'
                ).get(digestId);
                if (dailyDigest?.date_key) {
                  const sessions = DigestService.getSessionDigestsForDate(
                    this.db, this.appId, dailyDigest.date_key
                  );
                  for (const sess of sessions) {
                    const sessText = `  Session (${new Date(sess.time_start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} - ${new Date(sess.time_end).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}): ${sess.content}`;
                    if (semanticChars + sessText.length > semanticBudgetChars) break;
                    context.relevantMemory.push({ ...hit, text: sessText, source: 'digest:session', chunk_index: sess.id, _drilldown: true });
                    semanticChars += sessText.length;
                  }
                }
              } catch (err) {
                // Drill-down failed, continue with what we have
              }
              continue;
            }

            // Session digest hit: drill down to raw entries
            if (hit.category === 'session_digest') {
              if (semanticChars + hit.text.length > semanticBudgetChars) break;

              context.relevantMemory.push(hit);
              semanticChars += hit.text.length;

              // Drill down: get raw entries for this session's time range
              const digestId = hit.chunk_index;
              try {
                const sess = this.db.prepare(
                  'SELECT time_start, time_end FROM conversation_digests WHERE id = ?'
                ).get(digestId);
                if (sess) {
                  const drilldownBudget = Math.min(
                    semanticBudgetChars - semanticChars,
                    3000 // Cap drill-down raw entries at 3K chars
                  );
                  if (drilldownBudget > 500) {
                    const drillEntries = this.getRawEntriesInRange(sess.time_start, sess.time_end, drilldownBudget);
                    if (drillEntries.length > 0) {
                      const drillText = MemoryService.formatConversationEntries(drillEntries);
                      context.relevantMemory.push({ ...hit, text: drillText, source: `drilldown:${hit.source}`, _drilldown: true });
                      semanticChars += drillText.length;
                    }
                  }
                }
              } catch (err) {
                // Drill-down failed, continue
              }
              continue;
            }

            // Other chunks: include as-is
            if (semanticChars + hit.text.length <= semanticBudgetChars) {
              context.relevantMemory.push(hit);
              semanticChars += hit.text.length;
            }
          }
        }
      } catch (err) {
        console.error('Memory search error:', err);
      }
    }

    // Build formatted semantic results text
    if (context.relevantMemory.length > 0) {
      const parts = [];
      for (const chunk of context.relevantMemory) {
        if (chunk._drilldown) {
          parts.push(chunk.text); // Drill-down content is already formatted
        } else {
          parts.push(`[${chunk.source}] ${chunk.text}`);
        }
      }
      context.semanticResults = parts.join('\n\n');
    }

    const totalChars = conversationChars + context.relevantMemory.reduce((sum, c) => sum + c.text.length, 0);
    console.log(`Memory context: ${totalChars} chars (raw: ${context.conversationHistory.length}, sessions: ${context.sessionDigests.length}, daily: ${context.dailyDigests.length}, semantic: ${context.relevantMemory.length} chunks)`);

    return context;
  }

  // Get statistics for health check
  getStats() {
    const totalChunks = this.stmtCountChunks.get(this.appId).count;
    const totalSources = this.stmtCountSources.get(this.appId).count;
    const lastIndexed = this.stmtLastIndexed.get(this.appId);
    const total = this.cacheHits + this.cacheMisses;

    return {
      totalChunks,
      totalSources,
      lastIndexedAt: lastIndexed?.ts || null,
      cacheHitRate: total > 0 ? (this.cacheHits / total * 100).toFixed(1) + '%' : 'N/A',
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses
    };
  }

  // Migrate from JSON index to SQLite
  async migrateFromJson(options = { dryRun: false }) {
    if (!fs.existsSync(this.indexPath)) {
      console.log('No JSON index to migrate');
      return null;
    }

    // Backup before migration
    const backupPath = this.indexPath + '.bak';
    fs.copyFileSync(this.indexPath, backupPath);
    console.log(`Backed up to ${backupPath}`);

    const index = JSON.parse(fs.readFileSync(this.indexPath, 'utf-8'));

    if (!index.chunks || !index.chunks.length) {
      console.log('JSON index is empty');
      return null;
    }

    // Track chunk indices per source
    const chunksBySource = new Map();

    if (options.dryRun) {
      console.log(`[DRY RUN] Would migrate ${index.chunks.length} chunks`);
      const sources = [...new Set(index.chunks.map(c => c.source))];
      console.log(`Sources: ${sources.join(', ')}`);
      return { chunks: index.chunks.length, sources: sources.length };
    }

    // Migrate chunks
    let migrated = 0;
    for (const chunk of index.chunks) {
      const source = chunk.source;

      // Assign sequential chunk_index per source
      if (!chunksBySource.has(source)) chunksBySource.set(source, 0);
      const chunkIndex = chunksBySource.get(source);
      chunksBySource.set(source, chunkIndex + 1);

      const textHash = getTextHash(chunk.text);
      const embedding = embeddingToBuffer(new Float32Array(chunk.embedding));
      const category = categorize(source);

      this.stmtInsertChunk.run(
        this.appId,
        chunk.text,
        textHash,
        source,
        chunkIndex,
        category,
        embedding
      );

      migrated++;
    }

    // Verify round-trip
    const sample = this.db.prepare('SELECT embedding FROM memory_chunks WHERE app_id = ? LIMIT 1').get(this.appId);
    if (sample) {
      const buf = sample.embedding;
      const restored = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
      if (restored.length !== EMBEDDING_DIMS) {
        throw new Error(`Round-trip failed: expected ${EMBEDDING_DIMS} dims, got ${restored.length}`);
      }
      console.log(`Round-trip verified: ${restored.length} dimensions`);
    }

    // Delete JSON only after successful migration
    fs.unlinkSync(this.indexPath);
    console.log(`Migration complete: ${migrated} chunks migrated, JSON file removed`);

    return { chunks: migrated, sources: chunksBySource.size };
  }

}

// Apply daily-notes and reflection methods from memory-notes.js
applyNotesMixin(MemoryService);

module.exports = { MemoryService, chunkText, cleanTextForEmbedding, embeddingToBuffer, bufferToEmbedding, getTextHash, cosineSimilarity, getEmbedder, extractKeywords, STOPWORDS, MODEL_NAME, EMBEDDING_DIMS };
