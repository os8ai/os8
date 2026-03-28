/**
 * Conversation Service
 * Real-time conversation entry management with JSON backups
 */

const fs = require('fs');
const path = require('path');
const { APPS_DIR } = require('../config');
const { extractInternalTag } = require('../utils/internal-notes');

const ConversationService = {
  /**
   * Add a conversation entry to the database
   * @param {Database} db - SQLite database instance
   * @param {string} appId - Application ID
   * @param {object} entry - Entry data
   * @param {string} entry.type - 'conversation', 'journal', 'event'
   * @param {string} entry.speaker - Agent name or 'user'
   * @param {string} entry.role - 'user' or 'assistant'
   * @param {string} entry.channel - 'desktop', 'telegram', 'phone', 'job'
   * @param {string} entry.content - Message content
   * @param {string} [entry.timestamp] - ISO 8601 timestamp (defaults to now)
   * @param {object} [entry.metadata] - Additional metadata
   * @returns {object} The inserted entry with id
   */
  addEntry(db, appId, { type, speaker, role, channel, content, timestamp, metadata }) {
    const ts = timestamp || new Date().toISOString();
    const dateKey = ts.split('T')[0]; // YYYY-MM-DD
    const metadataJson = metadata ? JSON.stringify(metadata) : null;

    // Auto-classify internal note tags
    const internalTag = extractInternalTag(content);

    const stmt = db.prepare(`
      INSERT INTO conversation_entries
      (app_id, type, speaker, role, channel, content, timestamp, date_key, metadata, is_spark, internal_tag)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `);

    const result = stmt.run(appId, type, speaker, role, channel, content, ts, dateKey, metadataJson, internalTag);

    const entry = {
      id: result.lastInsertRowid,
      app_id: appId,
      type,
      speaker,
      role,
      channel,
      content,
      timestamp: ts,
      date_key: dateKey,
      metadata: metadata || null,
      internal_tag: internalTag
    };

    return entry;
  },

  /**
   * Get conversation entries for a custom time window
   * @param {Database} db - SQLite database instance
   * @param {string} appId - Application ID
   * @param {number} timeMs - Time window in milliseconds (default 24 hours)
   * @param {string} [typeFilter] - Optional type filter ('conversation', 'journal', etc.)
   * @returns {Array} Array of entries sorted by timestamp
   */
  getEntriesSince(db, appId, timeMs = 24 * 60 * 60 * 1000, typeFilter = null) {
    const cutoff = new Date(Date.now() - timeMs).toISOString();

    let sql = `
      SELECT id, app_id, type, speaker, role, channel, content, timestamp, date_key, metadata
      FROM conversation_entries
      WHERE app_id = ? AND timestamp >= ?
    `;
    const params = [appId, cutoff];

    if (typeFilter) {
      sql += ' AND type = ?';
      params.push(typeFilter);
    }

    sql += ' ORDER BY timestamp ASC';

    const stmt = db.prepare(sql);
    const rows = stmt.all(...params);

    // Parse metadata JSON
    return rows.map(row => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : null
    }));
  },

  /**
   * Get conversation entries for the last 24 hours
   * @param {Database} db - SQLite database instance
   * @param {string} appId - Application ID
   * @param {string} [typeFilter] - Optional type filter ('conversation', 'journal', etc.)
   * @returns {Array} Array of entries sorted by timestamp
   */
  getLast24Hours(db, appId, typeFilter = null) {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    let sql = `
      SELECT id, app_id, type, speaker, role, channel, content, timestamp, date_key, metadata
      FROM conversation_entries
      WHERE app_id = ? AND timestamp >= ?
    `;
    const params = [appId, cutoff];

    if (typeFilter) {
      sql += ' AND type = ?';
      params.push(typeFilter);
    }

    sql += ' ORDER BY timestamp ASC';

    const stmt = db.prepare(sql);
    const rows = stmt.all(...params);

    // Parse metadata JSON
    return rows.map(row => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : null
    }));
  },

  /**
   * Get entries for a specific date (for backup purposes)
   * @param {Database} db - SQLite database instance
   * @param {string} appId - Application ID
   * @param {string} dateKey - Date in YYYY-MM-DD format
   * @returns {Array} Array of entries for that date
   */
  getEntriesForDate(db, appId, dateKey) {
    const stmt = db.prepare(`
      SELECT id, app_id, type, speaker, role, channel, content, timestamp, date_key, metadata
      FROM conversation_entries
      WHERE app_id = ? AND date_key = ?
      ORDER BY timestamp ASC
    `);

    const rows = stmt.all(appId, dateKey);

    return rows.map(row => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : null
    }));
  },

  /**
   * Get agent name from assistant config
   * @param {string} appId - Application ID
   * @returns {string} Agent name or 'assistant' as fallback
   */
  getAgentName(appId) {
    const configPath = path.join(APPS_DIR, appId, 'assistant-config.json');

    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        return config.name || 'assistant';
      } catch (e) {
        console.warn('Failed to read assistant config:', e.message);
      }
    }

    return 'assistant';
  },

  /**
   * Append an entry to the daily JSON backup file
   * @param {string} appId - Application ID
   * @param {string} dateKey - Date in YYYY-MM-DD format
   * @param {object} entry - Entry to append
   */
  appendToJsonBackup(appId, dateKey, entry) {
    const memoryDir = path.join(APPS_DIR, appId, 'memory');
    const backupPath = path.join(memoryDir, `${dateKey}.json`);

    // Ensure memory directory exists
    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true });
    }

    let backup;
    if (fs.existsSync(backupPath)) {
      try {
        backup = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));
      } catch (e) {
        console.warn('Failed to parse existing backup, creating new:', e.message);
        backup = null;
      }
    }

    if (!backup) {
      backup = {
        version: 1,
        date: dateKey,
        app_id: appId,
        agent_name: this.getAgentName(appId),
        entries: []
      };
    }

    // Add entry (without app_id since it's at root level)
    backup.entries.push({
      id: entry.id,
      type: entry.type,
      speaker: entry.speaker,
      role: entry.role,
      channel: entry.channel,
      content: entry.content,
      timestamp: entry.timestamp,
      metadata: entry.metadata
    });

    fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  },

  /**
   * Write full JSON backup for a date (rebuilds entire file)
   * @param {Database} db - SQLite database instance
   * @param {string} appId - Application ID
   * @param {string} dateKey - Date in YYYY-MM-DD format
   */
  writeJsonBackup(db, appId, dateKey) {
    const entries = this.getEntriesForDate(db, appId, dateKey);
    const memoryDir = path.join(APPS_DIR, appId, 'memory');
    const backupPath = path.join(memoryDir, `${dateKey}.json`);

    // Ensure memory directory exists
    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true });
    }

    const backup = {
      version: 1,
      date: dateKey,
      app_id: appId,
      agent_name: this.getAgentName(appId),
      entries: entries.map(e => ({
        id: e.id,
        type: e.type,
        speaker: e.speaker,
        role: e.role,
        channel: e.channel,
        content: e.content,
        timestamp: e.timestamp,
        metadata: e.metadata
      }))
    };

    fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  },

  /**
   * Get count of entries for an app
   * @param {Database} db - SQLite database instance
   * @param {string} appId - Application ID
   * @returns {number} Total entry count
   */
  getEntryCount(db, appId) {
    const stmt = db.prepare('SELECT COUNT(*) as count FROM conversation_entries WHERE app_id = ?');
    return stmt.get(appId).count;
  },

  /**
   * Delete all entries for an app (for testing/cleanup)
   * @param {Database} db - SQLite database instance
   * @param {string} appId - Application ID
   */
  deleteAllEntries(db, appId) {
    const stmt = db.prepare('DELETE FROM conversation_entries WHERE app_id = ?');
    stmt.run(appId);
  },

  /**
   * Add an image entry to the database
   * @param {Database} db - SQLite database instance
   * @param {string} appId - Application ID
   * @param {object} entry - Image entry data
   * @param {string} entry.imageData - Base64-encoded image data
   * @param {string} entry.mediaType - 'image/png' or 'image/jpeg'
   * @param {string} entry.imageView - 'third_person', 'pov', 'chat_user', 'chat_agent', 'telegram_user'
   * @param {string} entry.timestamp - ISO 8601 timestamp
   * @param {string} [entry.originalFilename] - Original filename
   * @param {string} [entry.speaker] - Speaker name (defaults to agent name)
   * @param {string} [entry.role] - Role: 'user' or 'assistant' (defaults to 'assistant')
   * @param {string} [entry.channel] - Channel: 'image', 'desktop', 'telegram' (defaults to 'image')
   * @param {string} [entry.content] - Content description (defaults based on imageView)
   * @returns {object} The inserted entry with id
   */
  addImageEntry(db, appId, { imageData, mediaType, imageView, timestamp, originalFilename, speaker, role, channel, content }) {
    const agentName = this.getAgentName(appId);
    const dateKey = timestamp.split('T')[0];

    // Default content based on imageView if not provided
    const defaultContent = {
      'pov': 'What you see (your POV)',
      'third_person': 'Image of you (third person)',
      'chat_user': 'Image from user',
      'chat_agent': 'Image you sent',
      'telegram_user': 'Image from user (Telegram)'
    };
    const finalContent = content || defaultContent[imageView] || 'Image';
    const finalSpeaker = speaker || agentName;
    const finalRole = role || 'assistant';
    const finalChannel = channel || 'image';

    const metadata = JSON.stringify({
      media_type: mediaType,
      image_view: imageView,
      original_filename: originalFilename || null
    });

    const stmt = db.prepare(`
      INSERT INTO conversation_entries
      (app_id, type, speaker, role, channel, content, timestamp, date_key, metadata, image_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      appId, 'image', finalSpeaker, finalRole, finalChannel,
      finalContent, timestamp, dateKey, metadata, imageData
    );

    return {
      id: result.lastInsertRowid,
      app_id: appId,
      type: 'image',
      speaker: finalSpeaker,
      role: finalRole,
      channel: finalChannel,
      content: finalContent,
      timestamp,
      date_key: dateKey,
      metadata: { media_type: mediaType, image_view: imageView, original_filename: originalFilename },
      image_data: imageData
    };
  },

  /**
   * Get the N most recent images
   * @param {Database} db - SQLite database instance
   * @param {string} appId - Application ID
   * @param {number} limit - Maximum number of images to return
   * @returns {Array} Array of image entries sorted by timestamp DESC
   */
  getRecentImages(db, appId, limit = 10) {
    const stmt = db.prepare(`
      SELECT id, app_id, type, speaker, role, channel, content, timestamp, date_key, metadata, image_data
      FROM conversation_entries
      WHERE app_id = ? AND type = 'image'
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    const rows = stmt.all(appId, limit);

    return rows.map(row => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : null
    }));
  },

  /**
   * Get the most recent images by view type (current images)
   * @param {Database} db - SQLite database instance
   * @param {string} appId - Application ID
   * @returns {object} { thirdPerson: entry|null, pov: entry|null }
   */
  getCurrentImages(db, appId) {
    // Get most recent third_person image
    const thirdPersonStmt = db.prepare(`
      SELECT id, app_id, type, speaker, role, channel, content, timestamp, date_key, metadata, image_data
      FROM conversation_entries
      WHERE app_id = ? AND type = 'image' AND json_extract(metadata, '$.image_view') = 'third_person'
      ORDER BY timestamp DESC
      LIMIT 1
    `);

    // Get most recent POV image
    const povStmt = db.prepare(`
      SELECT id, app_id, type, speaker, role, channel, content, timestamp, date_key, metadata, image_data
      FROM conversation_entries
      WHERE app_id = ? AND type = 'image' AND json_extract(metadata, '$.image_view') = 'pov'
      ORDER BY timestamp DESC
      LIMIT 1
    `);

    const thirdPersonRow = thirdPersonStmt.get(appId);
    const povRow = povStmt.get(appId);

    const parseRow = (row) => row ? {
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : null
    } : null;

    return {
      thirdPerson: parseRow(thirdPersonRow),
      pov: parseRow(povRow)
    };
  },

  /**
   * Get recent chat images (user uploads + agent-sent images)
   * Returns the last N images from chat_user and chat_agent views
   * @param {Database} db - SQLite database instance
   * @param {string} appId - Application ID
   * @param {number} limit - Maximum number of images (default 6)
   * @returns {Array} Array of image entries sorted by timestamp ASC (chronological)
   */
  getRecentChatImages(db, appId, limit = 6) {
    const stmt = db.prepare(`
      SELECT id, app_id, type, speaker, role, channel, content, timestamp, date_key, metadata, image_data
      FROM conversation_entries
      WHERE app_id = ? AND type = 'image'
        AND json_extract(metadata, '$.image_view') IN ('chat_user', 'chat_agent')
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    const rows = stmt.all(appId, limit);

    return rows.reverse().map(row => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : null
    }));
  },

  /**
   * Get images from a recent time window (limited to N most recent)
   * @param {Database} db - SQLite database instance
   * @param {string} appId - Application ID
   * @param {number} limit - Maximum number of images
   * @param {number} timeMs - Time window in milliseconds (default 24 hours)
   * @returns {Array} Array of image entries sorted by timestamp ASC (chronological)
   */
  getLast24HoursImages(db, appId, limit = 10, timeMs = 24 * 60 * 60 * 1000) {
    const cutoff = new Date(Date.now() - timeMs).toISOString();

    // Get most recent N images from last 24 hours, then reverse for chronological order
    const stmt = db.prepare(`
      SELECT id, app_id, type, speaker, role, channel, content, timestamp, date_key, metadata, image_data
      FROM conversation_entries
      WHERE app_id = ? AND type = 'image' AND timestamp >= ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    const rows = stmt.all(appId, cutoff, limit);

    // Reverse to get chronological order (oldest first)
    return rows.reverse().map(row => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : null
    }));
  },

  /**
   * Get the N most recent images (no time limit)
   * Used for visual memory timeline
   * @param {Database} db - SQLite database instance
   * @param {string} appId - Application ID
   * @param {number} limit - Maximum number of images
   * @returns {Array} Array of image entries sorted by timestamp ASC (chronological)
   */
  getRecentImages(db, appId, limit = 10) {
    // Get most recent N images, then reverse for chronological order
    const stmt = db.prepare(`
      SELECT id, app_id, type, speaker, role, channel, content, timestamp, date_key, metadata, image_data
      FROM conversation_entries
      WHERE app_id = ? AND type = 'image'
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    const rows = stmt.all(appId, limit);

    // Reverse to get chronological order (oldest first)
    return rows.reverse().map(row => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : null
    }));
  },

  /**
   * Delete expired transient job entries (older than maxAgeMs)
   * Matches entries by internal tag (e.g. "(pulse)") and job trigger name (e.g. "Pulse").
   * Also rebuilds affected JSON backup files to stay in sync.
   * @param {Database} db - SQLite database instance
   * @param {string} appId - Application ID
   * @param {string} tag - Internal note tag, e.g. "pulse" or "reverie"
   * @param {string} jobName - Job trigger name, e.g. "Pulse" or "Reverie"
   * @param {number} maxAgeMs - Max age in milliseconds
   * @returns {number} Number of entries deleted
   */
  deleteExpiredTransientEntries(db, appId, tag, jobName, maxAgeMs) {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();

    const internalPattern = `%[internal: (${tag})%`;
    const triggerPattern = jobName ? `%[Timed Job: ${jobName}]%` : null;

    // Build query — use internal_tag column when available, fall back to content LIKE
    let findSql = `
      SELECT DISTINCT date_key FROM conversation_entries
      WHERE app_id = ? AND timestamp < ?
        AND (internal_tag = ? OR content LIKE ?`;
    const findParams = [appId, cutoff, tag, internalPattern];

    if (triggerPattern) {
      findSql += ' OR content LIKE ?';
      findParams.push(triggerPattern);
    }
    findSql += ')';

    // Find affected date_keys before deleting (for JSON backup rebuild)
    const affectedDates = db.prepare(findSql).all(...findParams).map(r => r.date_key);

    if (affectedDates.length === 0) return 0;

    // Delete matching entries
    let deleteSql = `
      DELETE FROM conversation_entries
      WHERE app_id = ? AND timestamp < ?
        AND (internal_tag = ? OR content LIKE ?`;
    const deleteParams = [appId, cutoff, tag, internalPattern];

    if (triggerPattern) {
      deleteSql += ' OR content LIKE ?';
      deleteParams.push(triggerPattern);
    }
    deleteSql += ')';

    const result = db.prepare(deleteSql).run(...deleteParams);

    // Rebuild JSON backups for affected dates
    for (const dateKey of affectedDates) {
      this.writeJsonBackup(db, appId, dateKey);
    }

    return result.changes;
  },

  /**
   * Deep delete a conversation entry and all derived data.
   * Removes the entry from: conversation_entries, conversation_digests,
   * memory_chunks, agent_messages, and JSON backup files.
   * Then re-generates affected digests in the background.
   *
   * @param {Database} db
   * @param {number} entryId - conversation_entries.id
   * @returns {Promise<object>} Summary of what was deleted/regenerated
   */
  async deepDeleteEntry(db, entryId) {
    const DigestService = require('./digest');
    const DigestEngine = require('./digest-engine');

    const result = {
      deleted: false,
      affectedAgentIds: [],
      deletedEntries: 0,
      deletedDigests: 0,
      deletedChunks: 0,
      errors: []
    };

    // Step 1: Fetch the entry
    const entry = db.prepare('SELECT * FROM conversation_entries WHERE id = ?').get(entryId);
    if (!entry) return result;

    const metadata = entry.metadata ? JSON.parse(entry.metadata) : null;
    const threadId = metadata?.threadId || null;
    const isThreadEntry = entry.channel === 'thread' && threadId;

    // Collect all entry IDs and agent IDs to process
    const entriesToDelete = [{ id: entry.id, appId: entry.app_id, dateKey: entry.date_key }];
    const affectedAgentIds = new Set([entry.app_id]);

    // Step 2: Find sibling entries in group threads (user messages duplicated across agents)
    if (isThreadEntry && entry.role === 'user') {
      const siblings = db.prepare(`
        SELECT id, app_id, date_key FROM conversation_entries
        WHERE channel = 'thread'
          AND json_extract(metadata, '$.threadId') = ?
          AND content = ?
          AND timestamp = ?
          AND id != ?
      `).all(threadId, entry.content, entry.timestamp, entry.id);

      for (const sib of siblings) {
        entriesToDelete.push({ id: sib.id, appId: sib.app_id, dateKey: sib.date_key });
        affectedAgentIds.add(sib.app_id);
      }
    }

    result.affectedAgentIds = [...affectedAgentIds];

    // Track digest windows to re-generate after deletion
    const digestWindowsToRegenerate = []; // { agentId, timeStart, timeEnd }
    const dailyDatesToRegenerate = []; // { agentId, dateKey }

    // Step 3-6: Transaction for all synchronous DB deletions
    const runDelete = db.transaction(() => {
      // Step 3: Delete matching agent_messages (if thread entry)
      // Use subquery for LIMIT 1 since SQLite DELETE doesn't support LIMIT directly
      if (isThreadEntry) {
        db.prepare(`
          DELETE FROM agent_messages WHERE id = (
            SELECT id FROM agent_messages
            WHERE thread_id = ? AND content = ? AND sender_app_id = ?
            LIMIT 1
          )
        `).run(threadId, entry.content, entry.app_id);

        // For user messages, also delete the user's agent_messages entry
        if (entry.role === 'user') {
          db.prepare(`
            DELETE FROM agent_messages WHERE id = (
              SELECT id FROM agent_messages
              WHERE thread_id = ? AND content = ? AND sender_app_id = 'user'
              LIMIT 1
            )
          `).run(threadId, entry.content);
        }
      }

      // Step 4-5: For each affected agent, find and delete covering digests + their chunks
      for (const agentId of affectedAgentIds) {
        // Find session digests covering the entry's timestamp
        const sessionDigests = DigestService.getSessionDigestsCoveringTimestamp(db, agentId, entry.timestamp);

        for (const digest of sessionDigests) {
          // Record window for re-generation
          digestWindowsToRegenerate.push({
            agentId,
            timeStart: digest.time_start,
            timeEnd: digest.time_end
          });
          if (!dailyDatesToRegenerate.some(d => d.agentId === agentId && d.dateKey === digest.date_key)) {
            dailyDatesToRegenerate.push({ agentId, dateKey: digest.date_key });
          }

          // Delete memory_chunks for this digest
          const chunkResult = db.prepare(`
            DELETE FROM memory_chunks
            WHERE app_id = ? AND source = 'digest:session' AND chunk_index = ?
          `).run(agentId, digest.id);
          result.deletedChunks += chunkResult.changes;

          // Delete the digest itself
          DigestService.deleteDigest(db, digest.id);
          result.deletedDigests++;
        }

        // Find and delete daily digests for affected dates
        const affectedDates = new Set(sessionDigests.map(d => d.date_key));
        for (const dateKey of affectedDates) {
          const dailyDigest = DigestService.getDailyDigest(db, agentId, dateKey);
          if (dailyDigest) {
            const chunkResult = db.prepare(`
              DELETE FROM memory_chunks
              WHERE app_id = ? AND source = 'digest:daily' AND chunk_index = ?
            `).run(agentId, dailyDigest.id);
            result.deletedChunks += chunkResult.changes;

            DigestService.deleteDigest(db, dailyDigest.id);
            result.deletedDigests++;
          }
        }
      }

      // Step 5: Delete all conversation_entries rows
      for (const e of entriesToDelete) {
        db.prepare('DELETE FROM conversation_entries WHERE id = ?').run(e.id);
        result.deletedEntries++;
      }
    });

    runDelete();
    result.deleted = true;

    // Step 6: Rewrite JSON backups for all affected (appId, dateKey) pairs
    const jsonPairs = new Map(); // dateKey → Set of appIds
    for (const e of entriesToDelete) {
      if (!jsonPairs.has(e.dateKey)) jsonPairs.set(e.dateKey, new Set());
      jsonPairs.get(e.dateKey).add(e.appId);
    }
    for (const [dateKey, appIds] of jsonPairs) {
      for (const appId of appIds) {
        try {
          this.writeJsonBackup(db, appId, dateKey);
        } catch (err) {
          result.errors.push(`JSON backup rewrite failed for ${appId}/${dateKey}: ${err.message}`);
        }
      }
    }

    // Step 7: Fire-and-forget digest re-generation (async, don't block UI)
    (async () => {
      try {
        // Re-generate session digests for affected windows
        for (const win of digestWindowsToRegenerate) {
          try {
            await DigestEngine.regenerateSessionDigest(db, win.agentId, win.timeStart, win.timeEnd);
          } catch (err) {
            console.warn(`[DeepDelete] Session re-digest failed for ${win.agentId}: ${err.message}`);
          }
        }

        // Re-generate daily digests for affected dates
        for (const { agentId, dateKey } of dailyDatesToRegenerate) {
          try {
            await DigestEngine.regenerateDailyDigest(db, agentId, dateKey);
          } catch (err) {
            console.warn(`[DeepDelete] Daily re-digest failed for ${agentId}/${dateKey}: ${err.message}`);
          }
        }
      } catch (err) {
        console.error('[DeepDelete] Digest re-generation error:', err.message);
      }
    })();

    return result;
  },

  /**
   * Check if an image already exists by filename
   * @param {Database} db - SQLite database instance
   * @param {string} appId - Application ID
   * @param {string} filename - Original filename
   * @returns {boolean} True if image exists
   */
  imageExists(db, appId, filename) {
    const stmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM conversation_entries
      WHERE app_id = ? AND type = 'image' AND json_extract(metadata, '$.original_filename') = ?
    `);

    const result = stmt.get(appId, filename);
    return result.count > 0;
  }
};

module.exports = ConversationService;
