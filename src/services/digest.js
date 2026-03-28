/**
 * Digest Service
 * Manages conversation digests — compressed summaries of older conversation windows.
 * Supports hierarchical levels: session (2h blocks) and daily (day rollups).
 * Digests replace raw conversation entries in the context window to save tokens.
 */

const DigestService = {
  /**
   * Save a completed digest
   * @param {Database} db
   * @param {string} appId
   * @param {object} digest
   * @param {string} digest.timeStart - ISO 8601
   * @param {string} digest.timeEnd - ISO 8601
   * @param {string} digest.content - Narrative digest text
   * @param {number} [digest.entryCount] - Number of entries digested
   * @param {string} [digest.level] - 'session' or 'daily' (default: 'session')
   * @param {string} [digest.dateKey] - YYYY-MM-DD date key
   * @param {object} [digest.metadata] - Additional metadata
   * @returns {object} The inserted digest with id
   */
  saveDigest(db, appId, { timeStart, timeEnd, content, entryCount, level, dateKey, metadata }) {
    const finalLevel = level || 'session';
    const finalDateKey = dateKey || timeStart.split('T')[0];

    const stmt = db.prepare(`
      INSERT INTO conversation_digests
      (app_id, time_start, time_end, content, entry_count, level, date_key, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      appId,
      timeStart,
      timeEnd,
      content,
      entryCount || 0,
      finalLevel,
      finalDateKey,
      metadata ? JSON.stringify(metadata) : null
    );

    return {
      id: result.lastInsertRowid,
      app_id: appId,
      time_start: timeStart,
      time_end: timeEnd,
      content,
      entry_count: entryCount || 0,
      level: finalLevel,
      date_key: finalDateKey,
      metadata: metadata || null
    };
  },

  /**
   * Get digests since a given time
   * @param {Database} db
   * @param {string} appId
   * @param {number} sinceMs - Time window in milliseconds from now
   * @param {string} [level] - Optional level filter ('session' or 'daily')
   * @returns {Array} Digests ordered by time_start ASC
   */
  getDigestsSince(db, appId, sinceMs, level = null) {
    const cutoff = new Date(Date.now() - sinceMs).toISOString();

    let sql = `
      SELECT id, app_id, time_start, time_end, content, entry_count, level, date_key, metadata, created_at
      FROM conversation_digests
      WHERE app_id = ? AND time_end >= ?
    `;
    const params = [appId, cutoff];

    if (level) {
      sql += ' AND level = ?';
      params.push(level);
    }

    sql += ' ORDER BY time_start ASC';

    const rows = db.prepare(sql).all(...params);

    return rows.map(row => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : null
    }));
  },

  /**
   * Get the latest digest end time for an app
   * @param {Database} db
   * @param {string} appId
   * @returns {string|null} ISO timestamp of the latest digest end, or null
   */
  getLastDigestTime(db, appId) {
    const row = db.prepare(`
      SELECT MAX(time_end) as last_time
      FROM conversation_digests
      WHERE app_id = ?
    `).get(appId);

    return row?.last_time || null;
  },

  /**
   * Get the latest session digest end time for an app
   * @param {Database} db
   * @param {string} appId
   * @returns {string|null} ISO timestamp of the latest session digest end, or null
   */
  getLastSessionDigestTime(db, appId) {
    const row = db.prepare(`
      SELECT MAX(time_end) as last_time
      FROM conversation_digests
      WHERE app_id = ? AND level = 'session'
    `).get(appId);

    return row?.last_time || null;
  },

  /**
   * Get session digests for a specific date
   * @param {Database} db
   * @param {string} appId
   * @param {string} dateKey - YYYY-MM-DD
   * @returns {Array} Session digests for that date, ordered by time_start ASC
   */
  getSessionDigestsForDate(db, appId, dateKey) {
    const rows = db.prepare(`
      SELECT id, app_id, time_start, time_end, content, entry_count, level, date_key, metadata, created_at
      FROM conversation_digests
      WHERE app_id = ? AND level = 'session' AND date_key = ?
      ORDER BY time_start ASC
    `).all(appId, dateKey);

    return rows.map(row => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : null
    }));
  },

  /**
   * Get the daily digest for a specific date
   * @param {Database} db
   * @param {string} appId
   * @param {string} dateKey - YYYY-MM-DD
   * @returns {object|null} Daily digest or null
   */
  getDailyDigest(db, appId, dateKey) {
    const row = db.prepare(`
      SELECT id, app_id, time_start, time_end, content, entry_count, level, date_key, metadata, created_at
      FROM conversation_digests
      WHERE app_id = ? AND level = 'daily' AND date_key = ?
      LIMIT 1
    `).get(appId, dateKey);

    if (!row) return null;
    return {
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : null
    };
  },

  /**
   * Get session digests within a time range (for context assembly)
   * @param {Database} db
   * @param {string} appId
   * @param {string} afterTimestamp - ISO timestamp (exclusive lower bound)
   * @param {string} beforeTimestamp - ISO timestamp (exclusive upper bound on time_end)
   * @returns {Array} Session digests ordered by time_start ASC
   */
  getSessionDigestsInRange(db, appId, afterTimestamp, beforeTimestamp) {
    const rows = db.prepare(`
      SELECT id, app_id, time_start, time_end, content, entry_count, level, date_key, metadata, created_at
      FROM conversation_digests
      WHERE app_id = ? AND level = 'session'
        AND time_end <= ?
        AND time_start >= ?
      ORDER BY time_start ASC
    `).all(appId, beforeTimestamp, afterTimestamp);

    return rows.map(row => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : null
    }));
  },

  /**
   * Get daily digests within a date range (for context assembly)
   * @param {Database} db
   * @param {string} appId
   * @param {string} startDateKey - YYYY-MM-DD (inclusive)
   * @param {string} endDateKey - YYYY-MM-DD (exclusive)
   * @returns {Array} Daily digests ordered by date_key ASC
   */
  getDailyDigestsInRange(db, appId, startDateKey, endDateKey) {
    const rows = db.prepare(`
      SELECT id, app_id, time_start, time_end, content, entry_count, level, date_key, metadata, created_at
      FROM conversation_digests
      WHERE app_id = ? AND level = 'daily'
        AND date_key >= ?
        AND date_key < ?
      ORDER BY date_key ASC
    `).all(appId, startDateKey, endDateKey);

    return rows.map(row => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : null
    }));
  },

  /**
   * Find dates that have session digests but no daily digest
   * @param {Database} db
   * @param {string} appId
   * @returns {Array<string>} Array of YYYY-MM-DD date keys
   */
  getUncoveredDatesForDaily(db, appId) {
    const rows = db.prepare(`
      SELECT DISTINCT s.date_key
      FROM conversation_digests s
      LEFT JOIN conversation_digests d
        ON d.app_id = s.app_id AND d.level = 'daily' AND d.date_key = s.date_key
      WHERE s.app_id = ? AND s.level = 'session' AND d.id IS NULL
      ORDER BY s.date_key ASC
    `).all(appId);

    return rows.map(r => r.date_key);
  },

  /**
   * Get undigested conversation entries grouped into session blocks.
   * Sessions are defined by gaps > gapMs between consecutive entries.
   * @param {Database} db
   * @param {string} appId
   * @param {number} [gapMs=1800000] - Gap threshold in ms (default 30 minutes)
   * @returns {Array<{timeStart: string, timeEnd: string, entries: Array}>}
   */
  getPendingSessionBlocks(db, appId, gapMs = 30 * 60 * 1000) {
    const lastSessionTime = this.getLastSessionDigestTime(db, appId);

    let sql = `
      SELECT id, type, speaker, role, channel, content, timestamp, date_key, metadata, internal_tag
      FROM conversation_entries
      WHERE app_id = ? AND type != 'image'
    `;
    const params = [appId];

    if (lastSessionTime) {
      sql += ' AND timestamp > ?';
      params.push(lastSessionTime);
    }

    sql += ' ORDER BY timestamp ASC';

    const entries = db.prepare(sql).all(...params).map(row => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : null
    }));

    if (entries.length === 0) return [];

    // Group into session blocks by gap detection
    const blocks = [];
    let currentBlock = null;

    for (const entry of entries) {
      const entryTime = new Date(entry.timestamp).getTime();

      if (!currentBlock) {
        currentBlock = { timeStart: entry.timestamp, timeEnd: entry.timestamp, entries: [entry] };
        continue;
      }

      const lastEntryTime = new Date(currentBlock.timeEnd).getTime();
      if (entryTime - lastEntryTime > gapMs) {
        // Gap detected — start a new block
        blocks.push(currentBlock);
        currentBlock = { timeStart: entry.timestamp, timeEnd: entry.timestamp, entries: [entry] };
      } else {
        currentBlock.timeEnd = entry.timestamp;
        currentBlock.entries.push(entry);
      }
    }

    if (currentBlock && currentBlock.entries.length > 0) {
      blocks.push(currentBlock);
    }

    return blocks;
  },

  /**
   * Get undigested conversation entries grouped into time blocks (legacy).
   * Finds entries older than `olderThanMs` that haven't been covered by any digest.
   * @param {Database} db
   * @param {string} appId
   * @param {number} olderThanMs - Only entries older than this (ms from now) are eligible
   * @param {number} [blockSizeMs=7200000] - Block size in ms (default 2 hours)
   * @returns {Array<{timeStart: string, timeEnd: string, entries: Array}>}
   */
  getPendingDigestBlocks(db, appId, olderThanMs, blockSizeMs = 2 * 60 * 60 * 1000) {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const lastDigestTime = this.getLastDigestTime(db, appId);

    // Get entries older than cutoff that are after the last digest
    let sql = `
      SELECT id, type, speaker, role, channel, content, timestamp, date_key, metadata, internal_tag
      FROM conversation_entries
      WHERE app_id = ? AND timestamp < ? AND type != 'image'
    `;
    const params = [appId, cutoff];

    if (lastDigestTime) {
      sql += ' AND timestamp > ?';
      params.push(lastDigestTime);
    }

    sql += ' ORDER BY timestamp ASC';

    const entries = db.prepare(sql).all(...params).map(row => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : null
    }));

    if (entries.length === 0) return [];

    // Group into blocks by time
    const blocks = [];
    let currentBlock = null;

    for (const entry of entries) {
      const entryTime = new Date(entry.timestamp).getTime();

      if (!currentBlock || entryTime - new Date(currentBlock.timeStart).getTime() >= blockSizeMs) {
        // Start a new block
        if (currentBlock) blocks.push(currentBlock);
        currentBlock = {
          timeStart: entry.timestamp,
          timeEnd: entry.timestamp,
          entries: []
        };
      }

      currentBlock.timeEnd = entry.timestamp;
      currentBlock.entries.push(entry);
    }

    if (currentBlock && currentBlock.entries.length > 0) {
      blocks.push(currentBlock);
    }

    return blocks;
  },

  /**
   * Format a pending block's entries as readable text for the digest agent
   * @param {object} block - A block from getPendingDigestBlocks or getPendingSessionBlocks
   * @returns {string} Formatted text
   */
  formatBlockForDigest(block) {
    const lines = [];
    const startTime = new Date(block.timeStart).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const endTime = new Date(block.timeEnd).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

    lines.push(`[${startTime} - ${endTime}] (${block.entries.length} entries)`);
    lines.push('');

    for (const entry of block.entries) {
      const ts = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      let badge = '';
      if (entry.type === 'journal') badge = ' [journal]';
      else if (entry.channel !== 'desktop') badge = ` via ${entry.channel}`;

      // Mark tagged entries
      let prefix = '';
      if (entry.internal_tag === 'transient') prefix = '[transient] ';
      else if (entry.internal_tag === 'structural') prefix = '[structural] ';

      lines.push(`[${ts}${badge}] ${prefix}${entry.speaker}: ${entry.content}`);
      lines.push('');
    }

    return lines.join('\n');
  },

  /**
   * Get digest coverage status
   * @param {Database} db
   * @param {string} appId
   * @returns {object} Coverage info
   */
  getDigestStatus(db, appId) {
    const lastDigestTime = this.getLastDigestTime(db, appId);
    const digestCount = db.prepare(
      'SELECT COUNT(*) as count FROM conversation_digests WHERE app_id = ?'
    ).get(appId).count;

    const sessionCount = db.prepare(
      "SELECT COUNT(*) as count FROM conversation_digests WHERE app_id = ? AND level = 'session'"
    ).get(appId).count;

    const dailyCount = db.prepare(
      "SELECT COUNT(*) as count FROM conversation_digests WHERE app_id = ? AND level = 'daily'"
    ).get(appId).count;

    const totalEntries = db.prepare(
      'SELECT COUNT(*) as count FROM conversation_entries WHERE app_id = ? AND type != ?'
    ).get(appId, 'image').count;

    const digestedEntries = db.prepare(
      'SELECT SUM(entry_count) as total FROM conversation_digests WHERE app_id = ?'
    ).get(appId).total || 0;

    // Check for gaps: entries between digests that haven't been covered
    const oldestUndigested = lastDigestTime
      ? db.prepare(`
          SELECT MIN(timestamp) as ts FROM conversation_entries
          WHERE app_id = ? AND timestamp > ? AND type != 'image'
        `).get(appId, lastDigestTime)?.ts
      : db.prepare(`
          SELECT MIN(timestamp) as ts FROM conversation_entries
          WHERE app_id = ? AND type != 'image'
        `).get(appId)?.ts;

    return {
      digestCount,
      sessionCount,
      dailyCount,
      lastDigestTime,
      totalEntries,
      digestedEntries,
      oldestUndigested,
      coveragePercent: totalEntries > 0 ? Math.round((digestedEntries / totalEntries) * 100) : 0
    };
  },

  /**
   * Get session digests whose time window covers a specific timestamp
   * @param {Database} db
   * @param {string} appId
   * @param {string} timestamp - ISO 8601
   * @returns {Array} Session digests covering that timestamp
   */
  getSessionDigestsCoveringTimestamp(db, appId, timestamp) {
    return db.prepare(`
      SELECT id, app_id, time_start, time_end, content, entry_count, level, date_key, metadata, created_at
      FROM conversation_digests
      WHERE app_id = ? AND level = 'session' AND time_start <= ? AND time_end >= ?
    `).all(appId, timestamp, timestamp).map(row => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : null
    }));
  },

  /**
   * Delete a specific digest by ID
   * @param {Database} db
   * @param {number} digestId
   * @returns {boolean} True if deleted
   */
  deleteDigest(db, digestId) {
    return db.prepare('DELETE FROM conversation_digests WHERE id = ?').run(digestId).changes > 0;
  },

  /**
   * Get conversation entries within a time range (for re-digesting after deletion)
   * @param {Database} db
   * @param {string} appId
   * @param {string} timeStart - ISO 8601
   * @param {string} timeEnd - ISO 8601
   * @returns {Array} Entries in range, ordered by timestamp ASC
   */
  getEntriesInRange(db, appId, timeStart, timeEnd) {
    return db.prepare(`
      SELECT id, type, speaker, role, channel, content, timestamp, date_key, metadata, internal_tag
      FROM conversation_entries
      WHERE app_id = ? AND timestamp >= ? AND timestamp <= ? AND type != 'image'
      ORDER BY timestamp ASC
    `).all(appId, timeStart, timeEnd).map(row => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : null
    }));
  },

  /**
   * Delete all digests for an app (for testing/reset)
   * @param {Database} db
   * @param {string} appId
   */
  deleteAllDigests(db, appId) {
    db.prepare('DELETE FROM conversation_digests WHERE app_id = ?').run(appId);
  }
};

module.exports = DigestService;
