/**
 * Digest Engine
 * System-level service that automatically creates session and daily digests
 * for all agents. Runs on a wall-clock timer alongside the job scheduler.
 *
 * Session digests: 2h conversation blocks compressed by LLM
 * Daily digests: Day-level rollups of session digests
 */

const DigestService = require('./digest');
const AgentService = require('./agent');
const AnthropicSDK = require('./anthropic-sdk');
const RoutingService = require('./routing');
const { sendTextPrompt } = require('./cli-runner');

/**
 * Send a digest prompt through the summary cascade.
 * Uses SDK when cascade says API, CLI when cascade says login.
 * @param {object} db
 * @param {string} prompt - The full prompt (digest instructions + content)
 * @param {number} maxTokens
 * @returns {Promise<string>} LLM response text
 */
async function sendDigestPrompt(db, prompt, maxTokens) {
  const resolved = RoutingService.resolve(db, 'summary');
  return sendTextPrompt(db, resolved, prompt, { maxTokens, timeout: 120000, sdkFallback: 'haiku' });
}

// How often the engine ticks (2 hours)
const TICK_INTERVAL_MS = 2 * 60 * 60 * 1000;

// Minimum entries in a session block to justify digesting
const MIN_ENTRIES_PER_BLOCK = 3;

// Maximum agents to process per tick (rate limiting)
const MAX_AGENTS_PER_TICK = 10;

// Digest prompt for session blocks
const SESSION_DIGEST_PROMPT = `You are summarizing a conversation block for an AI agent's memory system.
Compress the conversation into a concise narrative summary.

Rules:
- Preserve key decisions, action items, and emotional tone
- Keep specific names, numbers, URLs, and technical terms
- Note topics discussed and outcomes reached
- Be concise but don't lose important specifics
- The summary should be independently understandable without the raw conversation
- Write in third person ("The user asked...", "They discussed...")
- Keep it under 300 words

Conversation block:
`;

// Digest prompt for daily rollups
const DAILY_DIGEST_PROMPT = `You are creating a daily summary from session summaries for an AI agent's memory system.
Synthesize the themes and outcomes across all sessions into a coherent day-level summary.

Rules:
- Identify overarching themes and connections across sessions
- Highlight the most important decisions and outcomes of the day
- Note any unresolved items or ongoing threads
- Be concise — this is a high-level view, not a concatenation
- Keep specific names and key technical terms
- Keep it under 200 words

Session summaries for the day:
`;

let timer = null;
let isRunning = false;
let lastTickTime = null;

const DigestEngine = {
  /**
   * Start the digest engine
   * @param {object} db - SQLite database
   */
  start(db) {
    if (isRunning) return;
    isRunning = true;

    console.log('[DigestEngine] Starting (interval: 2h)');

    // Run first tick after a short delay (let other services initialize)
    setTimeout(() => {
      this.tick(db).catch(err => {
        console.error('[DigestEngine] Initial tick error:', err.message);
      });
    }, 30000); // 30 seconds after startup

    // Schedule periodic ticks
    timer = setInterval(() => {
      this.tick(db).catch(err => {
        console.error('[DigestEngine] Tick error:', err.message);
      });
    }, TICK_INTERVAL_MS);
  },

  /**
   * Stop the digest engine
   */
  stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    isRunning = false;
    console.log('[DigestEngine] Stopped');
  },

  /**
   * Check if engine is running
   */
  isRunning() {
    return isRunning;
  },

  /**
   * Run one tick: process session digests for all agents, then daily digests
   * @param {object} db - SQLite database
   */
  async tick(db) {
    if (!db) return;

    const startTime = Date.now();
    console.log('[DigestEngine] Tick started');

    // Check if summary cascade has any available model (SDK or CLI)
    try {
      RoutingService.resolve(db, 'summary');
    } catch (e) {
      console.log('[DigestEngine] No summary model available, skipping tick');
      return;
    }

    const agents = AgentService.getOperational(db);
    let processedCount = 0;
    let sessionDigestsCreated = 0;
    let dailyDigestsCreated = 0;

    // Phase 1: Session digests
    for (const agent of agents) {
      if (processedCount >= MAX_AGENTS_PER_TICK) break;

      try {
        const count = await this._processSessionDigests(db, agent);
        if (count > 0) {
          sessionDigestsCreated += count;
          processedCount++;
        }
      } catch (err) {
        console.error(`[DigestEngine] Session digest error for agent ${agent.name} (${agent.id}):`, err.message);
      }
    }

    // Phase 2: Daily digests
    for (const agent of agents) {
      try {
        const count = await this._processDailyDigests(db, agent);
        if (count > 0) {
          dailyDigestsCreated += count;
        }
      } catch (err) {
        console.error(`[DigestEngine] Daily digest error for agent ${agent.name} (${agent.id}):`, err.message);
      }
    }

    lastTickTime = new Date().toISOString();
    const elapsed = Date.now() - startTime;
    console.log(`[DigestEngine] Tick complete in ${elapsed}ms: ${sessionDigestsCreated} session + ${dailyDigestsCreated} daily digests`);
  },

  /**
   * Process session digests for one agent
   * @returns {number} Number of session digests created
   */
  async _processSessionDigests(db, agent) {
    const blocks = DigestService.getPendingSessionBlocks(db, agent.id);
    if (blocks.length === 0) return 0;

    // Filter out the most recent block if it might still be active
    // (last entry less than 30 minutes ago = conversation might be ongoing)
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const readyBlocks = blocks.filter(b => b.timeEnd < thirtyMinAgo);

    if (readyBlocks.length === 0) return 0;

    let created = 0;

    for (const block of readyBlocks) {
      if (block.entries.length < MIN_ENTRIES_PER_BLOCK) continue;

      try {
        const formatted = DigestService.formatBlockForDigest(block);
        const prompt = SESSION_DIGEST_PROMPT + formatted;

        // Call LLM via summary cascade (SDK or CLI depending on auth)
        const resultText = await sendDigestPrompt(db, prompt, 1024);

        if (!resultText || resultText.trim().length < 20) {
          console.warn(`[DigestEngine] Empty or too-short digest for agent ${agent.name}, skipping block`);
          continue;
        }

        // Save the session digest
        const digest = DigestService.saveDigest(db, agent.id, {
          timeStart: block.timeStart,
          timeEnd: block.timeEnd,
          content: resultText.trim(),
          entryCount: block.entries.length,
          level: 'session',
          dateKey: block.timeStart.split('T')[0]
        });

        // Embed the digest into memory_chunks for semantic search
        await this._embedDigest(db, agent.id, digest, 'session');

        created++;
        console.log(`[DigestEngine] Session digest for ${agent.name}: ${block.entries.length} entries → ${resultText.trim().length} chars`);
      } catch (err) {
        console.error(`[DigestEngine] Failed to digest block for ${agent.name}:`, err.message);
        // Continue to next block
      }
    }

    return created;
  },

  /**
   * Process daily digests for one agent
   * @returns {number} Number of daily digests created
   */
  async _processDailyDigests(db, agent) {
    // Only process dates before today (don't roll up today — it's still in progress)
    const today = new Date().toISOString().split('T')[0];
    const uncoveredDates = DigestService.getUncoveredDatesForDaily(db, agent.id)
      .filter(d => d < today);

    if (uncoveredDates.length === 0) return 0;

    let created = 0;

    for (const dateKey of uncoveredDates) {
      try {
        const sessionDigests = DigestService.getSessionDigestsForDate(db, agent.id, dateKey);
        if (sessionDigests.length === 0) continue;

        // Format session digests for the daily rollup prompt
        const sessionsText = sessionDigests.map((d, i) => {
          const start = new Date(d.time_start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
          const end = new Date(d.time_end).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
          return `Session ${i + 1} (${start} - ${end}):\n${d.content}`;
        }).join('\n\n');

        const prompt = DAILY_DIGEST_PROMPT + sessionsText;

        const resultText = await sendDigestPrompt(db, prompt, 800);

        if (!resultText || resultText.trim().length < 20) {
          console.warn(`[DigestEngine] Empty daily digest for ${agent.name} on ${dateKey}, skipping`);
          continue;
        }

        // Compute time range from the session digests
        const timeStart = sessionDigests[0].time_start;
        const timeEnd = sessionDigests[sessionDigests.length - 1].time_end;
        const totalEntries = sessionDigests.reduce((sum, d) => sum + (d.entry_count || 0), 0);

        const digest = DigestService.saveDigest(db, agent.id, {
          timeStart,
          timeEnd,
          content: resultText.trim(),
          entryCount: totalEntries,
          level: 'daily',
          dateKey
        });

        // Embed the daily digest into memory_chunks
        await this._embedDigest(db, agent.id, digest, 'daily');

        created++;
        console.log(`[DigestEngine] Daily digest for ${agent.name} on ${dateKey}: ${sessionDigests.length} sessions → ${resultText.trim().length} chars`);
      } catch (err) {
        console.error(`[DigestEngine] Failed daily digest for ${agent.name} on ${dateKey}:`, err.message);
      }
    }

    return created;
  },

  /**
   * Embed a digest into memory_chunks for semantic search
   * @param {object} db
   * @param {string} agentId
   * @param {object} digest - The saved digest object
   * @param {string} level - 'session' or 'daily'
   */
  async _embedDigest(db, agentId, digest, level) {
    try {
      // Lazy-load MemoryService to avoid circular dependency
      const { MemoryService, embeddingToBuffer, getTextHash } = require('../assistant/memory');

      // Get or create a temporary MemoryService for embedding
      const AS = require('./agent');
      const agent = AS.getById(db, agentId);
      const { agentDir } = agent ? AS.getPaths(agent.app_id, agentId) : AS.getPaths(agentId);

      const memory = new MemoryService(agentDir, db, agentId);
      const embedding = await memory.getEmbedding(digest.content);

      const source = `digest:${level}`;
      const category = `${level}_digest`;
      const textHash = getTextHash(digest.content);

      // Insert into memory_chunks (use digest ID as chunk_index for uniqueness within source)
      db.prepare(`
        INSERT OR REPLACE INTO memory_chunks
        (app_id, text, text_hash, source, chunk_index, category, embedding, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(agentId, digest.content, textHash, source, digest.id, category, embeddingToBuffer(embedding));

      // Update memory_sources (one entry per level, not per digest)
      db.prepare(`
        INSERT OR REPLACE INTO memory_sources
        (app_id, source, type, source_hash, last_indexed_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(agentId, source, category, textHash);

      // Invalidate memory cache so the new chunk is picked up
      memory.invalidateChunkCache();
    } catch (err) {
      console.warn(`[DigestEngine] Failed to embed ${level} digest ${digest.id}:`, err.message);
    }
  },

  /**
   * Re-generate a session digest for a specific time window.
   * Used by deep delete to re-digest after entry removal.
   * @param {object} db
   * @param {string} agentId
   * @param {string} timeStart - ISO 8601
   * @param {string} timeEnd - ISO 8601
   * @returns {Promise<object|null>} New digest, or null if not enough entries remain
   */
  async regenerateSessionDigest(db, agentId, timeStart, timeEnd) {
    const entries = DigestService.getEntriesInRange(db, agentId, timeStart, timeEnd);
    if (entries.length < MIN_ENTRIES_PER_BLOCK) {
      console.log(`[DigestEngine] Skipping session re-digest for ${agentId}: only ${entries.length} entries remain in window`);
      return null;
    }

    const block = { timeStart, timeEnd, entries };
    const formatted = DigestService.formatBlockForDigest(block);
    const prompt = SESSION_DIGEST_PROMPT + formatted;

    const resultText = await sendDigestPrompt(db, prompt, 1024);
    if (!resultText || resultText.trim().length < 20) {
      console.warn(`[DigestEngine] Empty re-digest for ${agentId}, skipping`);
      return null;
    }

    const digest = DigestService.saveDigest(db, agentId, {
      timeStart,
      timeEnd,
      content: resultText.trim(),
      entryCount: entries.length,
      level: 'session',
      dateKey: timeStart.split('T')[0]
    });

    await this._embedDigest(db, agentId, digest, 'session');
    console.log(`[DigestEngine] Re-generated session digest for ${agentId}: ${entries.length} entries → ${resultText.trim().length} chars`);
    return digest;
  },

  /**
   * Re-generate a daily digest for a specific date.
   * Used by deep delete to re-digest after session digest changes.
   * @param {object} db
   * @param {string} agentId
   * @param {string} dateKey - YYYY-MM-DD
   * @returns {Promise<object|null>} New digest, or null if no session digests remain
   */
  async regenerateDailyDigest(db, agentId, dateKey) {
    const sessionDigests = DigestService.getSessionDigestsForDate(db, agentId, dateKey);
    if (sessionDigests.length === 0) {
      console.log(`[DigestEngine] Skipping daily re-digest for ${agentId} on ${dateKey}: no session digests remain`);
      return null;
    }

    const sessionsText = sessionDigests.map((d, i) => {
      const start = new Date(d.time_start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      const end = new Date(d.time_end).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      return `Session ${i + 1} (${start} - ${end}):\n${d.content}`;
    }).join('\n\n');

    const prompt = DAILY_DIGEST_PROMPT + sessionsText;
    const resultText = await sendDigestPrompt(db, prompt, 800);

    if (!resultText || resultText.trim().length < 20) {
      console.warn(`[DigestEngine] Empty daily re-digest for ${agentId} on ${dateKey}, skipping`);
      return null;
    }

    const timeStart = sessionDigests[0].time_start;
    const timeEnd = sessionDigests[sessionDigests.length - 1].time_end;
    const totalEntries = sessionDigests.reduce((sum, d) => sum + (d.entry_count || 0), 0);

    const digest = DigestService.saveDigest(db, agentId, {
      timeStart,
      timeEnd,
      content: resultText.trim(),
      entryCount: totalEntries,
      level: 'daily',
      dateKey
    });

    await this._embedDigest(db, agentId, digest, 'daily');
    console.log(`[DigestEngine] Re-generated daily digest for ${agentId} on ${dateKey}: ${sessionDigests.length} sessions → ${resultText.trim().length} chars`);
    return digest;
  },

  /**
   * Backfill all historical digests for all agents (or a specific agent).
   * Processes ALL pending session blocks (no recency filter), then daily digests.
   * Returns progress info. Intended as a one-time migration call.
   *
   * @param {object} db - SQLite database
   * @param {string} [agentId] - Optional: only backfill this agent
   * @param {function} [onProgress] - Optional callback: (msg) => void
   * @returns {object} { sessionDigests, dailyDigests, errors }
   */
  async backfill(db, agentId = null, onProgress = null) {
    const log = onProgress || console.log;

    if (!AnthropicSDK.isAvailable(db)) {
      throw new Error('Anthropic SDK not available — need ANTHROPIC_API_KEY to generate digests');
    }

    const agents = agentId
      ? [AgentService.getById(db, agentId)].filter(Boolean)
      : AgentService.getAll(db);

    if (agents.length === 0) {
      throw new Error(agentId ? `Agent ${agentId} not found` : 'No active agents');
    }

    let totalSessions = 0;
    let totalDailies = 0;
    const errors = [];

    // Phase 1: Session digests for all agents
    for (const agent of agents) {
      log(`[Backfill] Processing session digests for ${agent.name}...`);

      const blocks = DigestService.getPendingSessionBlocks(db, agent.id);
      // No recency filter — process everything including the most recent block
      const eligibleBlocks = blocks.filter(b => b.entries.length >= MIN_ENTRIES_PER_BLOCK);

      log(`[Backfill] ${agent.name}: ${eligibleBlocks.length} session blocks to digest (${blocks.length} total, ${blocks.length - eligibleBlocks.length} too small)`);

      for (let i = 0; i < eligibleBlocks.length; i++) {
        const block = eligibleBlocks[i];
        try {
          const formatted = DigestService.formatBlockForDigest(block);
          const prompt = SESSION_DIGEST_PROMPT + formatted;

          const resultText = await sendDigestPrompt(db, prompt, 1024);

          if (!resultText || resultText.trim().length < 20) {
            log(`[Backfill] ${agent.name}: block ${i + 1} produced empty digest, skipping`);
            continue;
          }

          const digest = DigestService.saveDigest(db, agent.id, {
            timeStart: block.timeStart,
            timeEnd: block.timeEnd,
            content: resultText.trim(),
            entryCount: block.entries.length,
            level: 'session',
            dateKey: block.timeStart.split('T')[0]
          });

          await this._embedDigest(db, agent.id, digest, 'session');
          totalSessions++;
          log(`[Backfill] ${agent.name}: session ${i + 1}/${eligibleBlocks.length} — ${block.entries.length} entries → ${resultText.trim().length} chars`);
        } catch (err) {
          const msg = `${agent.name} session block ${i + 1}: ${err.message}`;
          errors.push(msg);
          log(`[Backfill] ERROR: ${msg}`);
        }
      }
    }

    // Phase 2: Daily digests for all agents (all uncovered dates, including today if sessions exist)
    for (const agent of agents) {
      log(`[Backfill] Processing daily digests for ${agent.name}...`);

      const uncoveredDates = DigestService.getUncoveredDatesForDaily(db, agent.id);
      log(`[Backfill] ${agent.name}: ${uncoveredDates.length} dates need daily digests`);

      for (const dateKey of uncoveredDates) {
        try {
          const sessionDigests = DigestService.getSessionDigestsForDate(db, agent.id, dateKey);
          if (sessionDigests.length === 0) continue;

          const sessionsText = sessionDigests.map((d, i) => {
            const start = new Date(d.time_start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
            const end = new Date(d.time_end).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
            return `Session ${i + 1} (${start} - ${end}):\n${d.content}`;
          }).join('\n\n');

          const prompt = DAILY_DIGEST_PROMPT + sessionsText;

          const resultText = await sendDigestPrompt(db, prompt, 800);

          if (!resultText || resultText.trim().length < 20) {
            log(`[Backfill] ${agent.name}: empty daily for ${dateKey}, skipping`);
            continue;
          }

          const timeStart = sessionDigests[0].time_start;
          const timeEnd = sessionDigests[sessionDigests.length - 1].time_end;
          const totalEntries = sessionDigests.reduce((sum, d) => sum + (d.entry_count || 0), 0);

          const digest = DigestService.saveDigest(db, agent.id, {
            timeStart,
            timeEnd,
            content: resultText.trim(),
            entryCount: totalEntries,
            level: 'daily',
            dateKey
          });

          await this._embedDigest(db, agent.id, digest, 'daily');
          totalDailies++;
          log(`[Backfill] ${agent.name}: daily for ${dateKey} — ${sessionDigests.length} sessions → ${resultText.trim().length} chars`);
        } catch (err) {
          const msg = `${agent.name} daily ${dateKey}: ${err.message}`;
          errors.push(msg);
          log(`[Backfill] ERROR: ${msg}`);
        }
      }
    }

    const summary = `Backfill complete: ${totalSessions} session + ${totalDailies} daily digests created (${errors.length} errors)`;
    log(`[Backfill] ${summary}`);

    return { sessionDigests: totalSessions, dailyDigests: totalDailies, errors };
  },

  /**
   * Get engine status
   */
  getStatus() {
    return {
      running: isRunning,
      lastTickTime,
      tickIntervalMs: TICK_INTERVAL_MS
    };
  }
};

module.exports = DigestEngine;
