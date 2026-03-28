/**
 * Call Service
 * Manages voice call state, tokens, and lifecycle
 *
 * Call lifecycle:
 *   Created (pending) → Active → Ended
 *
 * Security:
 *   - Cryptographic token required to join (64-char hex)
 *   - 15-minute window to join after creation
 *   - First connection wins (token binds to first WebSocket)
 *   - Active calls don't expire (only connection loss ends them)
 */

const crypto = require('crypto');
const EventEmitter = require('events');

// In-memory call state
const activeCalls = new Map();

// Event emitter for call state changes (used to notify desktop UI)
const callEvents = new EventEmitter();

// Constants
const JOIN_EXPIRATION_MS = 15 * 60 * 1000;  // 15 minutes to join
const HEARTBEAT_INTERVAL_MS = 5000;          // Ping every 5 seconds
const HEARTBEAT_TIMEOUT_MS = 10000;          // Pong must arrive within 10 seconds

/**
 * Generate a cryptographic token for call authentication
 */
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Generate a short, readable call ID
 */
function generateCallId() {
  return crypto.randomBytes(4).toString('hex');
}

const CallService = {
  /**
   * Create a new call
   * Returns { callId, token } for generating the call link
   */
  create() {
    const callId = generateCallId();
    const token = generateToken();
    const now = Date.now();

    const call = {
      id: callId,
      token,
      createdAt: now,
      joinExpiresAt: now + JOIN_EXPIRATION_MS,
      state: 'pending',  // pending | active | ended
      clientWs: null,
      whisperWs: null,
      elevenWs: null,
      lastPingAt: null,
      missedPings: 0
    };

    activeCalls.set(callId, call);

    // Schedule cleanup if not joined in time
    setTimeout(() => {
      const c = activeCalls.get(callId);
      if (c && c.state === 'pending') {
        console.log(`Call ${callId}: Join timeout, cleaning up`);
        this.end(callId, 'join_timeout');
      }
    }, JOIN_EXPIRATION_MS);

    console.log(`Call ${callId}: Created, expires at ${new Date(call.joinExpiresAt).toISOString()}`);

    return { callId, token };
  },

  /**
   * Validate a call token for joining
   * Returns { valid: true, call } or { valid: false, reason }
   */
  validate(callId, token) {
    const call = activeCalls.get(callId);

    if (!call) {
      return { valid: false, reason: 'not_found' };
    }

    if (call.token !== token) {
      return { valid: false, reason: 'invalid_token' };
    }

    if (call.state === 'ended') {
      return { valid: false, reason: 'call_ended' };
    }

    // First connection wins
    if (call.state === 'active' && call.clientWs) {
      return { valid: false, reason: 'already_joined' };
    }

    // Check join expiration (only for pending calls)
    if (call.state === 'pending' && Date.now() > call.joinExpiresAt) {
      this.end(callId, 'expired');
      return { valid: false, reason: 'expired' };
    }

    return { valid: true, call };
  },

  /**
   * Mark a call as active (first WebSocket connected)
   * Note: Does NOT emit call-active yet - that happens on first Claude request
   */
  activate(callId, clientWs) {
    const call = activeCalls.get(callId);
    if (!call) return false;

    // First connection wins - reject if already active (closes race between validate and activate)
    if (call.state === 'active') {
      console.log(`Call ${callId}: Rejected duplicate activate (already active)`);
      return false;
    }

    call.state = 'active';
    call.clientWs = clientWs;
    call.lastPingAt = Date.now();
    call.missedPings = 0;
    call.desktopNotified = false;  // Track if we've notified desktop

    console.log(`Call ${callId}: Activated (desktop not notified yet)`);

    return true;
  },

  /**
   * Notify desktop that call is active (called on first Claude request)
   * This delays the desktop notification until the assistant actually starts responding
   */
  notifyDesktopActive(callId) {
    const call = activeCalls.get(callId);
    if (!call || call.desktopNotified) return;

    call.desktopNotified = true;
    console.log(`Call ${callId}: Notifying desktop - call active (first request)`);
    callEvents.emit('call-active', { callId });
  },

  /**
   * Check if there's an active phone call
   * Used to disable desktop voice when phone call is in progress
   */
  hasActiveCall() {
    for (const call of activeCalls.values()) {
      if (call.state === 'active') {
        return true;
      }
    }
    return false;
  },

  /**
   * Subscribe to call state changes
   * Events: 'call-active', 'call-ended'
   */
  on(event, callback) {
    callEvents.on(event, callback);
  },

  /**
   * Unsubscribe from call state changes
   */
  off(event, callback) {
    callEvents.off(event, callback);
  },

  /**
   * Get a call by ID
   */
  get(callId) {
    return activeCalls.get(callId);
  },

  /**
   * Update call's Whisper WebSocket reference
   */
  setWhisperWs(callId, ws) {
    const call = activeCalls.get(callId);
    if (call) {
      call.whisperWs = ws;
    }
  },

  /**
   * Update call's ElevenLabs WebSocket reference
   */
  setElevenWs(callId, ws) {
    const call = activeCalls.get(callId);
    if (call) {
      call.elevenWs = ws;
    }
  },

  /**
   * Record a successful pong response
   */
  recordPong(callId) {
    const call = activeCalls.get(callId);
    if (call) {
      call.lastPingAt = Date.now();
      call.missedPings = 0;
    }
  },

  /**
   * Record a missed ping (no pong received)
   * Returns true if call should be terminated
   */
  recordMissedPing(callId) {
    const call = activeCalls.get(callId);
    if (!call) return true;

    call.missedPings++;
    console.log(`Call ${callId}: Missed ping (${call.missedPings})`);

    // End call after 2 missed pings
    if (call.missedPings >= 2) {
      console.log(`Call ${callId}: Too many missed pings, ending call`);
      return true;
    }

    return false;
  },

  /**
   * End a call and cleanup resources
   */
  end(callId, reason = 'ended') {
    const call = activeCalls.get(callId);
    if (!call) return;

    const wasActive = call.state === 'active';

    console.log(`Call ${callId}: Ending (reason: ${reason})`);

    call.state = 'ended';

    // Notify listeners that call has ended
    if (wasActive) {
      callEvents.emit('call-ended', { callId, reason });
    }

    // Close WebSocket connections
    if (call.clientWs) {
      try {
        call.clientWs.send(JSON.stringify({ type: 'call_ended', reason }));
        call.clientWs.close();
      } catch (e) {
        // Ignore errors when closing
      }
      call.clientWs = null;
    }

    if (call.whisperWs) {
      try {
        call.whisperWs.close();
      } catch (e) {
        console.warn(`[call] Whisper WebSocket close failed: ${e.message}`);
      }
      call.whisperWs = null;
    }

    if (call.elevenWs) {
      try {
        call.elevenWs.close();
      } catch (e) {
        console.warn(`[call] ElevenLabs WebSocket close failed: ${e.message}`);
      }
      call.elevenWs = null;
    }

    // Remove from active calls after a short delay (allows status checks)
    setTimeout(() => {
      activeCalls.delete(callId);
    }, 60000);  // Keep for 1 minute for status queries
  },

  /**
   * Get call status (for REST API)
   */
  getStatus(callId) {
    const call = activeCalls.get(callId);
    if (!call) {
      return { exists: false };
    }

    return {
      exists: true,
      state: call.state,
      createdAt: call.createdAt,
      joinExpiresAt: call.state === 'pending' ? call.joinExpiresAt : null,
      activeSince: call.state === 'active' ? call.createdAt : null
    };
  },

  /**
   * List all active calls (for debugging)
   */
  list() {
    const calls = [];
    for (const [id, call] of activeCalls) {
      calls.push({
        id,
        state: call.state,
        createdAt: call.createdAt,
        hasClient: !!call.clientWs
      });
    }
    return calls;
  },

  // Export constants for use in other modules
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS
};

module.exports = CallService;
