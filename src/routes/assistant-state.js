/**
 * Backward-compatible shim for assistant state
 *
 * Delegates all calls to the per-agent state manager (agent-state.js)
 * using the default agent ID. All 22+ existing importers keep working unchanged.
 */

const { getAgentState, getDefaultAgentId } = require('../services/agent-state');

// Helper: get state for the default agent
function s() {
  const id = getDefaultAgentId();
  if (!id) {
    // No default agent yet — return a temporary in-memory state
    // This happens during startup before the assistant is created
    if (!module.exports._fallback) {
      module.exports._fallback = {
        sessionId: null, memory: null, memoryWatcher: null,
        process: null,
        lastConversationTime: null,
        reflectionTimeout: null, responseClients: []
      };
    }
    return module.exports._fallback;
  }
  return getAgentState(id);
}

module.exports = {
  _fallback: null,

  // Session
  getSessionId: () => s().sessionId,
  setSessionId: (id) => { s().sessionId = id; },

  // Memory
  getMemory: () => s().memory,
  setMemory: (mem) => { s().memory = mem; },

  // Memory watcher
  getMemoryWatcher: () => s().memoryWatcher,
  setMemoryWatcher: (w) => { s().memoryWatcher = w; },

  // Process
  getProcess: () => s().process,
  setProcess: (proc) => { s().process = proc; },

  // Reflection
  getLastConversationTime: () => s().lastConversationTime,
  setLastConversationTime: (t) => { s().lastConversationTime = t; },
  getReflectionTimeout: () => s().reflectionTimeout,
  setReflectionTimeout: (t) => { s().reflectionTimeout = t; },

  // SSE clients
  getResponseClients: () => s().responseClients,
  addResponseClient: (client) => { s().responseClients.push(client); },
  removeResponseClient: (client) => {
    const state = s();
    state.responseClients = state.responseClients.filter(c => c !== client);
  },

};
