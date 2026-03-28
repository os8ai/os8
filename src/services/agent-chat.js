/**
 * AgentChatService - Agent-to-agent messaging
 *
 * Manages DM and group threads between agents, stores messages, tracks budgets,
 * and triggers responses. Circuit breaker prevents infinite conversation loops.
 */

const { generateId } = require('../utils');
const AgentService = require('./agent');

const AgentChatService = {
  /**
   * Resolve an agent name to its agent record (from agents table)
   */
  resolveAgentName(db, name) {
    const lower = name.toLowerCase();
    // Try exact slug match first
    const bySlug = AgentService.getBySlug(db, `agent-${lower}`)
      || AgentService.getBySlug(db, lower);
    if (bySlug) return bySlug;

    // Try name match (case-insensitive)
    const byName = db.prepare(
      "SELECT * FROM agents WHERE status = 'active' AND LOWER(name) = ?"
    ).get(lower);
    if (byName) return byName;

    // Try partial slug match
    const byPartialSlug = db.prepare(
      "SELECT * FROM agents WHERE status = 'active' AND slug LIKE ?"
    ).get(`%${lower}%`);
    return byPartialSlug || null;
  },

  /**
   * Find or create a DM thread between two agents
   */
  findOrCreateDM(db, appId1, appId2) {
    // Sort IDs for consistent lookup
    const participants = [appId1, appId2].sort();
    const participantsJson = JSON.stringify(participants);

    // Check for existing DM thread
    const existing = db.prepare(
      "SELECT * FROM agent_threads WHERE type = 'dm' AND participants = ? AND status = 'active'"
    ).get(participantsJson);

    if (existing) return existing;

    // Create new thread
    const id = generateId();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO agent_threads (id, type, participants, turn_count, status, created_at) VALUES (?, 'dm', ?, 0, 'active', ?)"
    ).run(id, participantsJson, now);

    return db.prepare("SELECT * FROM agent_threads WHERE id = ?").get(id);
  },

  /**
   * Create a group thread
   */
  createGroup(db, { name, participantIds, creatorId }) {
    const id = generateId();
    const now = new Date().toISOString();
    const participantsJson = JSON.stringify(participantIds);

    db.prepare(
      "INSERT INTO agent_threads (id, type, name, participants, turn_count, status, creator_id, moderator_model, created_at) VALUES (?, 'group', ?, ?, 0, 'active', ?, ?, ?)"
    ).run(id, name, participantsJson, creatorId || 'user', null, now);

    return db.prepare("SELECT * FROM agent_threads WHERE id = ?").get(id);
  },

  /**
   * Update a thread (name, participants, etc.)
   */
  updateThread(db, threadId, updates) {
    const allowed = ['name', 'participants', 'moderator_model', 'status'];
    const sets = [];
    const values = [];

    for (const [key, value] of Object.entries(updates)) {
      if (allowed.includes(key)) {
        sets.push(`${key} = ?`);
        values.push(key === 'participants' ? (typeof value === 'string' ? value : JSON.stringify(value)) : value);
      }
    }

    if (sets.length === 0) return null;

    values.push(threadId);
    db.prepare(`UPDATE agent_threads SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return db.prepare("SELECT * FROM agent_threads WHERE id = ?").get(threadId);
  },

  /**
   * Send a message to a thread
   */
  sendMessage(db, threadId, senderAppId, senderName, content, messageType = 'chat', triggeredBy = 'agent', metadata = null) {
    const now = new Date().toISOString();

    db.prepare(
      "INSERT INTO agent_messages (thread_id, sender_app_id, sender_name, content, message_type, triggered_by, metadata, timestamp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(threadId, senderAppId, senderName, content, messageType, triggeredBy, metadata, now, now);

    // Update thread
    db.prepare(
      "UPDATE agent_threads SET turn_count = turn_count + 1, last_message_at = ? WHERE id = ?"
    ).run(now, threadId);

    return db.prepare("SELECT * FROM agent_messages WHERE thread_id = ? ORDER BY id DESC LIMIT 1").get(threadId);
  },

  /**
   * Get messages for a thread
   */
  getMessages(db, threadId, limit = 50) {
    return db.prepare(
      "SELECT * FROM agent_messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?"
    ).all(threadId, limit).reverse();
  },

  /**
   * Get all threads, optionally filtered by participant
   */
  getThreads(db, agentId = null) {
    if (agentId) {
      return db.prepare(
        "SELECT * FROM agent_threads WHERE status = 'active' AND participants LIKE ? ORDER BY last_message_at DESC"
      ).all(`%${agentId}%`);
    }
    return db.prepare(
      "SELECT * FROM agent_threads WHERE status = 'active' ORDER BY last_message_at DESC"
    ).all();
  },

  /**
   * Get a specific thread
   */
  getThread(db, threadId) {
    return db.prepare("SELECT * FROM agent_threads WHERE id = ?").get(threadId);
  },

  /**
   * Check circuit breaker — returns true if the conversation should continue
   * @param {object} thread
   * @param {number} limit - 0 = unlimited
   */
  checkCircuitBreaker(thread, limit) {
    if (limit === 0) return true; // unlimited
    return (thread.turn_count || 0) < limit;
  },

  /**
   * Trip the circuit breaker — doubles cooldown with exponential backoff, records trip time.
   * Resets cooldown to 60s if last trip was >24h ago. Cap at 1 hour.
   */
  tripCircuitBreaker(db, threadId) {
    const thread = this.getThread(db, threadId);
    const currentCooldown = thread.breaker_cooldown || 60;
    const lastTripped = thread.breaker_last_tripped;
    const now = new Date();

    // Reset cooldown to 60s if last trip was >24h ago
    let newCooldown;
    if (lastTripped && (now - new Date(lastTripped)) > 24 * 60 * 60 * 1000) {
      newCooldown = 60;
    } else {
      newCooldown = Math.min(currentCooldown * 2, 3600); // cap at 1 hour
    }

    db.prepare(
      "UPDATE agent_threads SET breaker_cooldown = ?, breaker_last_tripped = ? WHERE id = ?"
    ).run(newCooldown, now.toISOString(), threadId);

    return newCooldown;
  },

  /**
   * Reset circuit breaker (user intervention or auto-reset)
   */
  resetCircuitBreaker(db, threadId) {
    db.prepare("UPDATE agent_threads SET turn_count = 0 WHERE id = ?").run(threadId);
  },

  /**
   * Send a system message to a thread (does NOT increment turn_count)
   */
  sendSystemMessage(db, threadId, content) {
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO agent_messages (thread_id, sender_app_id, sender_name, content, message_type, triggered_by, timestamp, created_at) VALUES (?, 'system', 'System', ?, 'system', 'system', ?, ?)"
    ).run(threadId, content, now, now);
    return db.prepare("SELECT * FROM agent_messages WHERE thread_id = ? ORDER BY id DESC LIMIT 1").get(threadId);
  },

  /**
   * Find threads with expired circuit breaker cooldowns that haven't been reset.
   * Used for orphan recovery on startup.
   */
  getExpiredBreakerThreads(db, limit) {
    const now = new Date().toISOString();
    return db.prepare(`
      SELECT * FROM agent_threads
      WHERE status = 'active'
        AND breaker_last_tripped IS NOT NULL
        AND turn_count >= ?
      ORDER BY breaker_last_tripped ASC
    `).all(limit);
  },

  /**
   * Clear all messages in a thread
   */
  clearThreadMessages(db, threadId) {
    db.prepare("DELETE FROM agent_messages WHERE thread_id = ?").run(threadId);
    db.prepare("UPDATE agent_threads SET turn_count = 0, breaker_cooldown = 60, last_message_at = NULL WHERE id = ?").run(threadId);
  },

  /**
   * Pause a thread
   */
  pauseThread(db, threadId) {
    db.prepare("UPDATE agent_threads SET status = 'paused' WHERE id = ?").run(threadId);
  },

  /**
   * Resume a thread
   */
  resumeThread(db, threadId) {
    db.prepare("UPDATE agent_threads SET status = 'active', turn_count = 0, breaker_cooldown = 60 WHERE id = ?").run(threadId);
  },

  /**
   * Archive a thread
   */
  archiveThread(db, threadId) {
    db.prepare("UPDATE agent_threads SET status = 'archived' WHERE id = ?").run(threadId);
  },

  /**
   * Build context string from thread messages for injection into agent prompt
   */
  getThreadContext(db, threadId, maxMessages = 20) {
    const messages = this.getMessages(db, threadId, maxMessages);
    if (messages.length === 0) return '';

    const thread = this.getThread(db, threadId);
    const lines = messages.map(m => `${m.sender_name}: ${m.content}`);

    const threadType = thread?.type === 'group' ? 'Group Thread' : 'Agent DM Thread';
    const threadLabel = thread?.name ? ` — ${thread.name}` : '';
    let context = `## ${threadType}${threadLabel}\n`;
    context += lines.join('\n');

    // Note: circuit breaker context is informational — callers should pass their own limit if needed
    if (thread && thread.breaker_last_tripped) {
      const cooldown = thread.breaker_cooldown || 60;
      const cooldownMins = Math.ceil(cooldown / 60);
      const lastTripped = new Date(thread.breaker_last_tripped);
      const cooldownEnd = new Date(lastTripped.getTime() + cooldown * 1000);
      if (new Date() < cooldownEnd) {
        context += `\n\n[Conversation paused — temporary cooldown. You can resume in ${cooldownMins} minute(s). This is a temporary cooldown, not a permanent block.]`;
      }
    }

    return context;
  },

  /**
   * Check daily budget for agent-initiated messages
   * @returns {boolean} true if under limit
   */
  checkDailyBudget(db, agentId, limit) {
    if (!limit || limit <= 0) return true; // 0 = unlimited
    const dateKey = new Date().toISOString().split('T')[0];
    const count = db.prepare(
      "SELECT COUNT(*) as cnt FROM agent_chat_budget WHERE date_key = ? AND agent_id = ? AND triggered_by = 'agent'"
    ).get(dateKey, agentId);
    return (count?.cnt || 0) < limit;
  },

  /**
   * Record budget usage
   */
  recordBudgetUsage(db, agentId, threadId, triggeredBy) {
    const dateKey = new Date().toISOString().split('T')[0];
    db.prepare(
      "INSERT INTO agent_chat_budget (date_key, agent_id, thread_id, triggered_by) VALUES (?, ?, ?, ?)"
    ).run(dateKey, agentId, threadId, triggeredBy);
  },

  /**
   * Get daily budget status for all agents
   */
  getDailyBudgetStatus(db) {
    const dateKey = new Date().toISOString().split('T')[0];
    return db.prepare(
      "SELECT agent_id, COUNT(*) as count FROM agent_chat_budget WHERE date_key = ? AND triggered_by = 'agent' GROUP BY agent_id"
    ).all(dateKey);
  },

  /**
   * List all agents (from agents table)
   */
  getActiveAgents(db) {
    return db.prepare(
      "SELECT id, name, slug, color FROM agents WHERE status = 'active' ORDER BY name"
    ).all();
  }
};

module.exports = AgentChatService;
