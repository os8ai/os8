/**
 * Per-agent state manager
 * Replaces the singleton assistant-state.js with a Map of agent states.
 * Each agent gets its own isolated state (memory, SSE clients, etc.)
 */

const agents = new Map();

// Default agent ID (set at startup from settings)
let _defaultAgentId = null;
let _db = null;

/**
 * Create a fresh state object for an agent
 */
function createAgentState() {
  return {
    sessionId: null,
    memory: null,
    memoryWatcher: null,
    process: null,
    telegramWatcher: null,

    // Reflection scheduling
    lastConversationTime: null,
    reflectionTimeout: null,

    // SSE clients
    responseClients: [],

    // Last assembled context (for debug viewer)
    lastContext: null,
  };
}

/**
 * Get or create state for an agent
 * @param {string} agentId
 * @returns {object} Agent state object
 */
function getAgentState(agentId) {
  if (!agents.has(agentId)) {
    agents.set(agentId, createAgentState());
  }
  return agents.get(agentId);
}

/**
 * Remove state for an agent (cleanup on deletion)
 * @param {string} agentId
 */
function removeAgentState(agentId) {
  const state = agents.get(agentId);
  if (state) {
    // Cleanup resources
    if (state.memoryWatcher) state.memoryWatcher.stop();
    if (state.telegramWatcher) state.telegramWatcher.stop();
    if (state.process && state.process.isRunning()) state.process.stop();
    if (state.reflectionTimeout) clearTimeout(state.reflectionTimeout);
    agents.delete(agentId);
  }
}

/**
 * List all active agent IDs with state
 * @returns {string[]}
 */
function getAllAgentIds() {
  return Array.from(agents.keys());
}

/**
 * Get the default agent ID
 */
function getDefaultAgentId() {
  if (_defaultAgentId) return _defaultAgentId;
  // Try to load from DB
  if (_db) {
    const SettingsService = require('./settings');
    const id = SettingsService.get(_db, 'defaultAgentId');
    if (id) {
      _defaultAgentId = id;
      return id;
    }
    // Fall back to first active agent
    try {
      const AgentService = require('./agent');
      const defaultAgent = AgentService.getDefault(_db);
      if (defaultAgent) {
        _defaultAgentId = defaultAgent.id;
        return _defaultAgentId;
      }
    } catch (e) {
      // AgentService not yet available (first run before migration)
      // AgentService not available — no agents yet
      return null;
    }
  }
  return null;
}

/**
 * Set the default agent ID
 */
function setDefaultAgentId(id) {
  _defaultAgentId = id;
  if (_db) {
    const SettingsService = require('./settings');
    SettingsService.set(_db, 'defaultAgentId', id);
  }
}

/**
 * Set database reference (called once at startup)
 */
function setDb(db) {
  _db = db;
}

module.exports = {
  getAgentState,
  removeAgentState,
  getAllAgentIds,
  getDefaultAgentId,
  setDefaultAgentId,
  setDb,
};
