/**
 * Call Stream WebSocket Route
 *
 * Handles bidirectional voice call between browser and AI assistant.
 * Bridges: Browser audio ↔ Whisper STT ↔ Claude ↔ TTS (ElevenLabs WS or OpenAI HTTP) ↔ Browser audio
 *
 * Protocol:
 *   Client → Server: Binary (16kHz PCM audio) or JSON control messages
 *   Server → Client: JSON messages (transcripts, audio, status)
 *
 * Features:
 *   - Heartbeat ping/pong for connection health
 *   - Barge-in support (user interrupts agent)
 *   - First-connection-wins security
 */

const WebSocket = require('ws');
const path = require('path');
const { spawn, execSync } = require('child_process');
const pty = require('node-pty');
const crypto = require('crypto');
const CallService = require('../services/call');
const { calculateContextBudgets, buildMemoryContext, enrichMessageWithContext, buildStreamJsonMessage } = require('../assistant/identity-context');
const { MemoryService } = require('../assistant/memory');
const ConversationService = require('../services/conversation');
const { getBackend } = require('../services/backend-adapter');
const RoutingService = require('../services/routing');
const { prepareSpawnEnv, createProcess } = require('../services/cli-runner');
const { loadJSON } = require('../utils/file-helpers');
const AnthropicSDK = require('../services/anthropic-sdk');
const OpenAIProvider = require('../services/tts-openai');

/**
 * Kill any existing Claude processes for this app directory
 * This is a safety net to prevent multiple Claude instances responding
 */
function killExistingClaudeProcesses(appPath, callId) {
  try {
    // Find Claude processes with this app path in their cwd
    const result = execSync(`ps aux | grep -E "claude.*${path.basename(appPath)}" | grep -v grep || true`, { encoding: 'utf8' });
    if (result.trim()) {
      console.log(`CallStream [${callId}]: FOUND EXISTING CLAUDE PROCESSES:\n${result}`);
      // Kill them
      execSync(`pkill -f "claude.*${path.basename(appPath)}" || true`);
      console.log(`CallStream [${callId}]: KILLED existing Claude processes`);
    }
  } catch (e) {
    // Ignore errors - pkill returns non-zero if no processes found
  }
}

// Generate short UUID for request tracing
function shortUuid() {
  return crypto.randomBytes(4).toString('hex');
}

/**
 * Creates WebSocket call streaming handler
 * @param {object} deps - Dependencies
 * @param {object} deps.db - Database instance
 * @param {object} deps.services - Service instances
 * @param {string} deps.APPS_DIR - Apps directory path
 */
function createCallStreamHandler({ db, services, APPS_DIR, AppService, state }) {
  const { WhisperStreamService, TTSService, EnvService } = services;

  return function setupCallStream(server) {
    const wss = new WebSocket.Server({ noServer: true });

    // Handle WebSocket upgrade requests
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url, `http://${request.headers.host}`);

      // Match /api/call/:id/stream
      const match = url.pathname.match(/^\/api\/call\/([^/]+)\/stream$/);
      if (!match) {
        return; // Let other handlers deal with it
      }

      const callId = match[1];
      const token = url.searchParams.get('token');
      const upgradeId = shortUuid();
      console.log(`CallStream: === UPGRADE REQUEST === callId=${callId}, upgradeId=${upgradeId}`);

      // Validate call
      const validation = CallService.validate(callId, token);
      console.log(`CallStream: Validation result for ${callId}: valid=${validation.valid}, reason=${validation.reason || 'ok'} (upgradeId=${upgradeId})`);
      if (!validation.valid) {
        console.log(`CallStream: Rejected connection for ${callId}: ${validation.reason}`);
        socket.write('HTTP/1.1 401 Unauthorized\r\n');
        socket.write('Content-Type: application/json\r\n');
        socket.write('\r\n');
        socket.write(JSON.stringify({ error: validation.reason }));
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (clientWs) => {
        handleCallConnection(clientWs, callId, {
          db,
          services,
          APPS_DIR,
          AppService,
          state,
          WhisperStreamService,
          TTSService,
          EnvService
        });
      });
    });

    console.log('CallStream: WebSocket handler registered at /api/call/:id/stream');
  };
}

/**
 * Handle a single call WebSocket connection
 */
function handleCallConnection(clientWs, callId, deps) {
  const { db, APPS_DIR, AppService, state, WhisperStreamService, TTSService, EnvService } = deps;

  // Track active connections for this call - use UUID for unique identification
  const connectionId = shortUuid();
  console.log(`CallStream [${callId}]: === CLIENT CONNECTED === (connId=${connectionId})`);

  // Duplicate transcript prevention
  // Tracks transcripts we've already sent to Claude to prevent double responses
  const processedTranscripts = new Set();

  // Request ID for tracking current assistant request (prevents stale responses)
  let currentRequestId = 0;

  // Mutex for sendToAssistant - prevents concurrent execution during async gap
  let sendInProgress = false;

  // Superset dedup for Whisper finals - catches "Hello" → "Hello world" splits
  let lastFinalText = '';
  let lastFinalTime = 0;
  const SUPERSET_DEDUP_WINDOW_MS = 3000;

  // Activate the call (first connection wins)
  if (!CallService.activate(callId, clientWs)) {
    console.log(`CallStream [${callId}]: === REJECTED DUPLICATE === (connId=${connectionId})`);
    clientWs.send(JSON.stringify({ type: 'error', message: 'Failed to activate call' }));
    clientWs.close();
    return;
  }
  console.log(`CallStream [${callId}]: Activated successfully (connId=${connectionId})`);

  // Get assistant info
  const AgentService = require('../services/agent');
  const assistant = db ? (AgentService.getDefault(db) || AppService.getAssistant(db)) : null;
  if (!assistant) {
    clientWs.send(JSON.stringify({ type: 'error', message: 'Assistant not configured' }));
    CallService.end(callId, 'no_assistant');
    return;
  }

  const { agentDir: appPath, agentBlobDir } = AgentService.getPaths(assistant.app_id || assistant.id, assistant.id);

  // Initialize memory service for full context
  const memory = new MemoryService(appPath, db, assistant.id);

  // Call state
  let whisperWs = null;
  let ttsProviderName = TTSService.getProviderName(db);  // 'elevenlabs' or 'openai'
  let elevenWs = null;
  let elevenWsId = 0;  // Track current ElevenLabs connection to ignore stale handlers
  let openaiAbortFn = null;  // Abort handle for OpenAI HTTP stream
  let openaiTextBuffer = '';  // Text accumulated for current OpenAI segment
  let isAgentSpeaking = false;
  let agentStoppedSpeakingAt = 0;  // Timestamp when agent stopped speaking
  let currentTranscript = '';
  let claudeProcess = null;
  let pendingTranscript = null;  // Accumulates until silence/final
  let lastRequestTime = 0;       // Debounce rapid-fire requests
  const REQUEST_DEBOUNCE_MS = 500;
  const ECHO_SUPPRESSION_MS = 5000;  // Ignore transcripts for 5s after TTS ends (audio queued on phone)

  // FIX: TTS segment tracking - ensures audio from different text blocks plays sequentially
  // When Claude uses tools, it outputs multiple text blocks. Each block's audio must
  // play AFTER the previous block's audio completes, not interleaved.
  let ttsSegmentId = 0;  // Increments for each text content block
  let currentAudioSegmentId = 0;  // The segment ID for audio currently being received from ElevenLabs
  let ttsPendingQueue = [];  // Queue of text chunks waiting to be sent to ElevenLabs
  let ttsWaitingForFlush = false;  // True when we're waiting for isFinal before sending more text
  let claudeResponseDone = false;  // True when we've received 'result' from Claude
  let ttsNeedsFlushAfterConnect = false;  // True if content_block_stop arrived before reconnect completed

  // Heartbeat state
  let heartbeatInterval = null;
  let awaitingPong = false;

  // Start heartbeat
  heartbeatInterval = setInterval(() => {
    if (clientWs.readyState !== WebSocket.OPEN) {
      clearInterval(heartbeatInterval);
      return;
    }

    if (awaitingPong) {
      // No pong received for previous ping
      if (CallService.recordMissedPing(callId)) {
        console.log(`CallStream [${callId}]: Heartbeat timeout, ending call`);
        cleanup('heartbeat_timeout');
        return;
      }
    }

    awaitingPong = true;
    try {
      clientWs.send(JSON.stringify({ type: 'ping' }));
    } catch (e) {
      console.error(`CallStream [${callId}]: Failed to send ping:`, e.message);
    }
  }, CallService.HEARTBEAT_INTERVAL_MS);

  // Connect to Whisper for STT
  function connectToWhisper() {
    if (!WhisperStreamService.isRunning()) {
      console.log(`CallStream [${callId}]: Whisper not running`);
      clientWs.send(JSON.stringify({ type: 'error', message: 'Speech recognition not available' }));
      return false;
    }

    const whisperUrl = WhisperStreamService.getWebSocketUrl();
    console.log(`CallStream [${callId}]: Connecting to Whisper at ${whisperUrl}`);

    try {
      whisperWs = new WebSocket(whisperUrl, {
        handshakeTimeout: 5000,
        perMessageDeflate: false
      });
    } catch (err) {
      console.error(`CallStream [${callId}]: Failed to create Whisper WebSocket:`, err.message);
      return false;
    }

    whisperWs.on('open', () => {
      console.log(`CallStream [${callId}]: Connected to Whisper`);
      CallService.setWhisperWs(callId, whisperWs);
    });

    whisperWs.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());

        if (message.type === 'ready') {
          console.log(`CallStream [${callId}]: Whisper ready`);
          clientWs.send(JSON.stringify({ type: 'ready' }));
        } else if (message.type === 'partial') {
          currentTranscript = message.text || '';

          // Barge-in: If agent is speaking and user starts talking, interrupt
          if (isAgentSpeaking && currentTranscript.trim().length > 0) {
            console.log(`CallStream [${callId}]: Barge-in detected, interrupting agent`);
            cancelAgentSpeech();
          }

          // Forward partial transcript to client (throttled on client side)
          clientWs.send(JSON.stringify({
            type: 'transcript',
            text: currentTranscript,
            final: false
          }));
        } else if (message.type === 'final') {
          // Generate UUID at the EARLIEST point to trace this request through entire flow
          const requestUuid = shortUuid();
          const finalText = message.text || currentTranscript;
          console.log(`CallStream [${callId}] [${requestUuid}]: WHISPER FINAL RECEIVED - "${finalText.substring(0, 50)}..." (connId=${connectionId})`);

          clientWs.send(JSON.stringify({
            type: 'transcript',
            text: finalText,
            final: true
          }));

          // Echo suppression: Skip if agent is speaking or recently stopped
          // (microphone picks up TTS output from phone speaker)
          const timeSinceAgentStopped = Date.now() - agentStoppedSpeakingAt;
          console.log(`CallStream [${callId}] [${requestUuid}]: Echo check - isAgentSpeaking=${isAgentSpeaking}, agentStoppedAt=${agentStoppedSpeakingAt}, timeSince=${timeSinceAgentStopped}ms, sendInProgress=${sendInProgress}, elevenWsId=${elevenWsId}`);
          if (isAgentSpeaking) {
            console.log(`CallStream [${callId}] [${requestUuid}]: BLOCKED (agent speaking)`);
            currentTranscript = '';
            return;
          }
          if (agentStoppedSpeakingAt > 0 && timeSinceAgentStopped < ECHO_SUPPRESSION_MS) {
            console.log(`CallStream [${callId}] [${requestUuid}]: BLOCKED (echo suppression, ${timeSinceAgentStopped}ms < ${ECHO_SUPPRESSION_MS}ms)`);
            currentTranscript = '';
            return;
          }
          console.log(`CallStream [${callId}] [${requestUuid}]: PASSED echo check`);

          // Filter out noise/blank transcripts
          const cleanText = finalText.trim().replace(/\[BLANK_AUDIO\]/gi, '').trim();
          if (cleanText.length === 0) {
            console.log(`CallStream [${callId}] [${requestUuid}]: BLOCKED (empty/blank)`);
            currentTranscript = '';
            return;
          }

          // Duplicate transcript prevention
          // Prevents sending the same transcript to Claude twice if Whisper sends multiple finals
          if (processedTranscripts.has(cleanText)) {
            console.log(`CallStream [${callId}] [${requestUuid}]: BLOCKED (already processed): "${cleanText.substring(0, 30)}..."`);
            currentTranscript = '';
            return;
          }

          // Track this transcript as processed
          processedTranscripts.add(cleanText);
          // Clean up after 10 seconds (voice allows intentional repetition)
          // This catches rapid duplicate finals without blocking legitimate repeated phrases
          setTimeout(() => {
            processedTranscripts.delete(cleanText);
          }, 10000);

          // Superset dedup: Whisper can send "Hello" then "Hello world" as separate finals
          // If the new transcript is a prefix/superset of the previous within 3s, handle it
          const now = Date.now();
          if (now - lastFinalTime < SUPERSET_DEDUP_WINDOW_MS && lastFinalText.length > 0) {
            const isSuperset = cleanText.startsWith(lastFinalText) || lastFinalText.startsWith(cleanText);
            if (isSuperset) {
              if (cleanText.length <= lastFinalText.length) {
                // Subset of previous - skip entirely (we already sent the longer version)
                console.log(`CallStream [${callId}] [${requestUuid}]: BLOCKED (superset dedup - subset)`);
                currentTranscript = '';
                return;
              }
              // Superset (longer) - allow through, the mutex will invalidate the previous request
              console.log(`CallStream [${callId}] [${requestUuid}]: Superset dedup - allowing longer, will invalidate previous`);
            }
          }
          lastFinalText = cleanText;
          lastFinalTime = now;

          // Send to Claude - pass UUID for tracing
          console.log(`CallStream [${callId}] [${requestUuid}]: CALLING sendToAssistant`);
          sendToAssistant(cleanText, requestUuid);

          currentTranscript = '';
        }
      } catch (e) {
        console.error(`CallStream [${callId}]: Failed to parse Whisper message:`, e);
      }
    });

    whisperWs.on('close', () => {
      console.log(`CallStream [${callId}]: Whisper disconnected`);
      whisperWs = null;
    });

    whisperWs.on('error', (err) => {
      console.error(`CallStream [${callId}]: Whisper error:`, err.message);
    });

    return true;
  }

  // Shared segment completion logic — called by ElevenLabs (on isFinal) and OpenAI (on stream end)
  function handleSegmentComplete() {
    if (ttsWaitingForFlush) {
      const hadQueuedText = ttsPendingQueue.length > 0;
      console.log(`CallStream [${callId}]: Segment complete, processing ${ttsPendingQueue.length} queued text chunks`);

      if (ttsProviderName === 'openai') {
        // OpenAI: queued text is full text for next segment — stream it
        if (hadQueuedText) {
          const nextText = ttsPendingQueue.join('');
          ttsPendingQueue = [];
          console.log(`CallStream [${callId}]: Streaming queued OpenAI segment (${nextText.length} chars)`);
          streamOpenAISegment(nextText);
          // ttsWaitingForFlush stays true — waiting for this stream to complete
        } else {
          ttsWaitingForFlush = false;
          if (claudeResponseDone) {
            console.log(`CallStream [${callId}]: Claude done + segment complete, marking agent done`);
            isAgentSpeaking = false;
            agentStoppedSpeakingAt = Date.now();
            clientWs.send(JSON.stringify({ type: 'agent_done', requestId: currentRequestId }));
          } else {
            console.log(`CallStream [${callId}]: Segment complete but Claude still responding`);
          }
        }
      } else {
        // ElevenLabs: queued text chunks sent individually to WebSocket
        while (ttsPendingQueue.length > 0 && elevenWs?.readyState === WebSocket.OPEN) {
          const queuedText = ttsPendingQueue.shift();
          elevenWs.send(JSON.stringify({ text: queuedText }));
          console.log(`CallStream [${callId}]: Sent queued text: "${queuedText.substring(0, 30)}..."`);
        }

        if (hadQueuedText && elevenWs?.readyState === WebSocket.OPEN) {
          console.log(`CallStream [${callId}]: Flushing after processing queued text`);
          elevenWs.send(JSON.stringify({ text: '' }));
          // ttsWaitingForFlush stays true - waiting for next isFinal
        } else {
          ttsWaitingForFlush = false;
          if (claudeResponseDone) {
            console.log(`CallStream [${callId}]: Claude done + isFinal received, marking agent done`);
            isAgentSpeaking = false;
            agentStoppedSpeakingAt = Date.now();
            clientWs.send(JSON.stringify({ type: 'agent_done', requestId: currentRequestId }));
          } else {
            console.log(`CallStream [${callId}]: isFinal received but Claude still responding, keeping connection open`);
          }
        }
      }
    } else {
      // Not waiting for flush
      if (claudeResponseDone) {
        isAgentSpeaking = false;
        agentStoppedSpeakingAt = Date.now();
        clientWs.send(JSON.stringify({ type: 'agent_done', requestId: currentRequestId }));
      }
    }
  }

  // Stream a single OpenAI TTS segment and call handleSegmentComplete when done
  function streamOpenAISegment(text) {
    const apiKey = TTSService.getApiKey(db);
    if (!apiKey) {
      console.error(`CallStream [${callId}]: No OpenAI API key for TTS`);
      handleSegmentComplete();
      return;
    }

    const settings = TTSService.getSettings(db);
    const voiceId = settings.voiceId;

    openaiAbortFn = OpenAIProvider.streamAudioChunked(
      apiKey,
      text,
      voiceId,
      { model: settings.model || 'tts-1', speed: settings.speed ?? 1.0 },
      // onChunk
      (base64Data) => {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({
            type: 'audio',
            data: base64Data,
            requestId: currentRequestId,
            segmentId: currentAudioSegmentId
          }));
        }
      },
      // onDone
      () => {
        openaiAbortFn = null;
        console.log(`CallStream [${callId}]: OpenAI segment stream complete`);
        handleSegmentComplete();
      },
      // onError
      (err) => {
        console.error(`CallStream [${callId}]: OpenAI TTS stream error:`, err.message);
        // onDone called after onError by streamAudioChunked, so segment will complete
      }
    );
  }

  // Connect to TTS provider for streaming
  function connectToTTS() {
    if (ttsProviderName === 'openai') {
      // OpenAI: no persistent connection needed, resolve immediately
      console.log(`CallStream [${callId}]: OpenAI TTS ready (no connection needed)`);
      return Promise.resolve();
    }
    return connectToElevenLabs();
  }

  // Connect to ElevenLabs for TTS
  function connectToElevenLabs() {
    return new Promise((resolve, reject) => {
      const apiKey = TTSService.getApiKey(db);
      if (!apiKey) {
        console.log(`CallStream [${callId}]: No TTS API key`);
        reject(new Error('TTS not configured'));
        return;
      }

      const settings = TTSService.getSettings(db);
      const wsUrl = TTSService.getWebSocketUrl(db, {
        voiceId: settings.voiceId,
        model: settings.model
      });

      if (!wsUrl) {
        console.log(`CallStream [${callId}]: TTS provider does not support WebSocket streaming`);
        reject(new Error('TTS provider does not support voice calls yet'));
        return;
      }

      // Use current connection ID (already incremented in sendToAssistant)
      const thisWsId = elevenWsId;
      let audioChunkCount = 0;  // Track chunks for debugging
      let lastAudioHash = null;  // Detect duplicate audio from ElevenLabs
      console.log(`CallStream [${callId}]: Connecting to ElevenLabs (connection ${thisWsId})`);

      try {
        elevenWs = new WebSocket(wsUrl, {
          headers: { 'xi-api-key': apiKey },
          handshakeTimeout: 5000
        });
      } catch (err) {
        console.error(`CallStream [${callId}]: Failed to create ElevenLabs WebSocket:`, err.message);
        reject(err);
        return;
      }

      // DIAGNOSTIC: Track connection open time
      const connectionStartTime = Date.now();

      elevenWs.on('open', () => {
        console.log(`CallStream [${callId}]: DIAG ElevenLabs OPEN (conn ${thisWsId}) at ${Date.now() - connectionStartTime}ms`);
        CallService.setElevenWs(callId, elevenWs);

        // Send BOS message
        elevenWs.send(JSON.stringify({
          text: ' ',
          voice_settings: {
            stability: settings.stability,
            similarity_boost: settings.similarityBoost,
            speed: settings.speed
          },
          generation_config: {
            chunk_length_schedule: [120, 160, 250, 290]
          }
        }));

        resolve();
      });

      elevenWs.on('message', (data, isBinary) => {
        // Ignore messages from stale connections (race condition prevention)
        if (thisWsId !== elevenWsId) {
          console.log(`CallStream [${callId}]: Ignoring audio from stale connection ${thisWsId} (current: ${elevenWsId})`);
          return;
        }

        if (clientWs.readyState !== WebSocket.OPEN) return;

        // ElevenLabs sends audio in BOTH JSON and binary formats
        // Only handle JSON to prevent double-send (the root cause of "double speak")
        if (isBinary) {
          // Ignore binary frames - we'll get the same audio in JSON format
          return;
        }

        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          // Not valid JSON, ignore
          return;
        }

        if (msg.audio) {
          // Detect duplicate audio from ElevenLabs (same content sent twice)
          const audioHash = msg.audio.slice(0, 32) + ':' + msg.audio.length;
          if (audioHash === lastAudioHash) {
            console.log(`CallStream [${callId}]: DUPLICATE audio from ElevenLabs detected! Skipping chunk.`);
            return;
          }
          lastAudioHash = audioHash;

          audioChunkCount++;
          // Log audio chunk signature for debugging double-speak
          const audioSig = msg.audio.slice(0, 20) + '...' + msg.audio.slice(-10);
          console.log(`CallStream [${callId}]: Audio chunk ${audioChunkCount} (len=${msg.audio.length}, sig=${audioSig}, segment=${currentAudioSegmentId})`);
          clientWs.send(JSON.stringify({
            type: 'audio',
            data: msg.audio,
            requestId: currentRequestId,
            segmentId: currentAudioSegmentId  // FIX: Use the segment ID that was active when text was sent
          }));
        }

        if (msg.isFinal) {
          const connDuration = Date.now() - connectionStartTime;
          console.log(`CallStream [${callId}]: DIAG ElevenLabs isFinal (conn ${thisWsId}) - ${audioChunkCount} chunks, conn open ${connDuration}ms, claudeResponseDone=${claudeResponseDone}`);
          handleSegmentComplete();
        }
      });

      elevenWs.on('close', (code, reason) => {
        const connDuration = Date.now() - connectionStartTime;
        console.log(`CallStream [${callId}]: DIAG ElevenLabs CLOSE (conn ${thisWsId}) code=${code}, reason=${reason?.toString() || 'none'}, after ${connDuration}ms, isCurrentConn=${thisWsId === elevenWsId}`);
        // Only update state if this is still the current connection
        if (thisWsId === elevenWsId) {
          isAgentSpeaking = false;
          agentStoppedSpeakingAt = Date.now();
          elevenWs = null;
        }
      });

      elevenWs.on('error', (err) => {
        const connDuration = Date.now() - connectionStartTime;
        console.error(`CallStream [${callId}]: DIAG ElevenLabs ERROR (conn ${thisWsId}) after ${connDuration}ms:`, err.message);
        // Only update state if this is still the current connection
        if (thisWsId === elevenWsId) {
          isAgentSpeaking = false;
          agentStoppedSpeakingAt = Date.now();
        }
        reject(err);
      });
    });
  }

  // Cancel agent speech (barge-in)
  function cancelAgentSpeech() {
    isAgentSpeaking = false;
    agentStoppedSpeakingAt = Date.now();

    // Close TTS connection to stop audio
    if (elevenWs) {
      try {
        elevenWs.close();
      } catch (e) {}
      elevenWs = null;
    }
    if (openaiAbortFn) {
      openaiAbortFn();
      openaiAbortFn = null;
    }
    openaiTextBuffer = '';
    ttsPendingQueue = [];

    // Tell client to cancel audio with fast fade-out
    clientWs.send(JSON.stringify({
      type: 'cancel_audio',
      fadeMs: 50  // Fast 50ms fade for barge-in
    }));
  }

  // Send user message to Claude assistant
  async function sendToAssistant(text, requestUuid = 'no-uuid') {
    // Log state at entry with UUID for tracing
    const entryTime = Date.now();
    const timeSinceLastRequest = entryTime - lastRequestTime;
    console.log(`CallStream [${callId}] [${requestUuid}]: sendToAssistant ENTRY - sendInProgress=${sendInProgress}, elevenWsId=${elevenWsId}, timeSince=${timeSinceLastRequest}ms`);

    // Debounce rapid-fire requests (e.g., multiple final transcripts)
    const now = Date.now();
    if (now - lastRequestTime < REQUEST_DEBOUNCE_MS) {
      console.log(`CallStream [${callId}] [${requestUuid}]: BLOCKED (debounce ${now - lastRequestTime}ms)`);
      return;
    }
    lastRequestTime = now;

    // Increment request ID - all subsequent processing for this request will check this ID
    // If a new request comes in, the old request's callbacks will see a stale ID and abort
    const thisRequestId = ++currentRequestId;
    console.log(`CallStream [${callId}] [${requestUuid}]: Assigned requestId=${thisRequestId}, elevenWsId=${elevenWsId}`);

    // FIX 1A: Mutex check - if another request is in the async gap, drop this one
    // but still invalidate the in-progress request by incrementing currentRequestId
    if (sendInProgress) {
      console.log(`CallStream [${callId}] [${requestUuid}]: BLOCKED (mutex) - will invalidate previous`);
      // Kill any existing Claude process since we're superseding it
      if (claudeProcess) {
        console.log(`CallStream [${callId}] [${requestUuid}]: Killing Claude from mutex-blocked request`);
        try { claudeProcess.kill(); } catch (e) {}
        claudeProcess = null;
      }
      return;
    }
    sendInProgress = true;
    console.log(`CallStream [${callId}] [${requestUuid}]: Acquired mutex`);

    // Record user message to conversation DB
    if (db) {
      try {
        ConversationService.addEntry(db, assistant.id, {
          type: 'conversation',
          speaker: 'user',
          role: 'user',
          channel: 'phone',
          content: text
        });
      } catch (convErr) {
        console.warn(`CallStream [${callId}]: Failed to record phone user message:`, convErr.message);
      }
    }

    try {
      // FIX: Increment elevenWsId FIRST, before closing old connection
      // This immediately invalidates any in-flight audio from the old connection
      // (old message handlers check thisWsId !== elevenWsId and bail)
      elevenWsId++;
      console.log(`CallStream [${callId}] [${requestUuid}]: Incremented elevenWsId to ${elevenWsId}`);

      // FIX: Reset segment counter and queuing state for new request
      // Client resets on agent_thinking, so server must reset too
      ttsSegmentId = 0;
      currentAudioSegmentId = 0;
      ttsPendingQueue = [];
      ttsWaitingForFlush = false;
      claudeResponseDone = false;
      ttsNeedsFlushAfterConnect = false;

      // Guard against concurrent calls - kill any existing process first
      if (claudeProcess) {
        console.log(`CallStream [${callId}] [${requestUuid}]: Killing previous Claude process`);
        try { claudeProcess.kill(); } catch (e) {}
        claudeProcess = null;
      }

      // Close existing TTS connection to prevent overlapping audio
      if (elevenWs) {
        console.log(`CallStream [${callId}] [${requestUuid}]: Closing previous ElevenLabs connection`);
        try { elevenWs.close(); } catch (e) {}
        elevenWs = null;
      }
      if (openaiAbortFn) {
        openaiAbortFn();
        openaiAbortFn = null;
      }
      openaiTextBuffer = '';

      console.log(`CallStream [${callId}] [${requestUuid}]: Sending to Claude: "${text.substring(0, 50)}..."`);

      // Notify desktop that call is active NOW (on first request, not on join)
      // This delays the desktop shutdown until assistant actually starts responding
      CallService.notifyDesktopActive(callId);

      clientWs.send(JSON.stringify({ type: 'agent_thinking', requestId: thisRequestId }));

      // Calculate unified budget: 50K tokens total, MYSELF+USER+images first, remaining 50/50
      // Note: Phone calls don't include images to keep streaming simple
      const {
        identityContext,
        conversationBudgetChars,
        semanticBudgetChars
      } = await calculateContextBudgets(appPath, undefined, undefined, { includeImages: false });

      // Build memory context with allocated budgets
      let memoryContext = '';
      try {
        const context = await memory.getContextForMessage(text, {
          conversationBudgetChars,
          semanticBudgetChars,
          priorityOrder: ['identity', 'curated', 'daily']
        });
        memoryContext = buildMemoryContext(context);
      } catch (memErr) {
        console.warn(`CallStream [${callId}]: Memory context error:`, memErr.message);
      }

      // Combine identity and memory context
      const fullContext = identityContext + memoryContext;
      const enrichedMessage = enrichMessageWithContext(text, fullContext);

      // Resolve backend + model via routing cascade
      const callAssistantConfig = loadJSON(path.join(appPath, 'assistant-config.json'), {});
      const callAgentOverride = callAssistantConfig.agentModel || null;
      const callResolved = db ? RoutingService.resolve(db, 'conversation', callAgentOverride) : {
        familyId: null, backendId: callAssistantConfig.agentBackend || 'claude',
        modelArg: callAgentOverride, source: 'fallback'
      };
      const callBackendId = callResolved.backendId;
      const callModel = callResolved.modelArg;
      const callBackend = getBackend(callBackendId);
      console.log(`[Routing] conversation/call: ${callResolved.familyId} via ${callResolved.source}`);

      // Prepare arguments via backend adapter
      const args = callBackend.buildArgs({
        print: true,
        verbose: true,
        streamJson: true,
        includePartialMessages: callBackend.supportsStreamJson,
        skipPermissions: true,
        appPath,
        blobDir: agentBlobDir,
        model: callModel,
      });

      // NOTE: We intentionally do NOT use --resume for phone calls
      // Phone calls get their own fresh context each time.

      args.push(...callBackend.buildPromptArgs(enrichedMessage));

      // Prepare environment (merge database env vars for API keys)
      const env = prepareSpawnEnv(db, callBackendId, callResolved.accessMethod);

      // Connect to TTS for response
      console.log(`CallStream [${callId}] [${requestUuid}]: Connecting to TTS (${ttsProviderName})...`);
      try {
        await connectToTTS();
        console.log(`CallStream [${callId}] [${requestUuid}]: TTS connected (${ttsProviderName})`);
      } catch (err) {
        console.error(`CallStream [${callId}] [${requestUuid}]: TTS FAILED:`, err.message);
        clientWs.send(JSON.stringify({ type: 'error', message: 'Voice synthesis unavailable' }));
        return;
      }

      // FIX 1B: Post-await stale check - if a newer request started during the await, abort
      if (thisRequestId !== currentRequestId) {
        console.log(`CallStream [${callId}] [${requestUuid}]: STALE after await (${thisRequestId} != ${currentRequestId})`);
        // Close the TTS connection we just opened
        if (elevenWs) {
          try { elevenWs.close(); } catch (e) {}
          elevenWs = null;
        }
        if (openaiAbortFn) {
          openaiAbortFn();
          openaiAbortFn = null;
        }
        return;
      }

      // --- SDK path for voice calls ---
      const useCallSDK = callBackendId === 'claude' && AnthropicSDK.isAvailable(db);
      if (useCallSDK) {
        console.log(`CallStream [${callId}] [${requestUuid}]: Using Anthropic SDK (prompt caching)`);

        try {
          // For voice calls, pass the already-combined context as a single text block
          // since calls don't include images and use simplified context
          const userContent = [
            { type: 'text', text: `[Context]\n${identityContext}${memoryContext}` },
            { type: 'text', text: `[Message]\n${text}` }
          ];

          let fullResponse = '';
          let firstChunkSent = false;

          for await (const event of AnthropicSDK.streamMessage(db, appPath, userContent, {
            agentModel: callModel,
            onCacheStats: (stats) => {
              console.log(`CallStream [${callId}]: Cache: ${stats.cacheReadInputTokens} read, ${stats.cacheCreationInputTokens} write`);
            }
          })) {
            // Stale check
            if (thisRequestId !== currentRequestId) {
              console.log(`CallStream [${callId}] [${requestUuid}]: STALE during SDK stream`);
              break;
            }

            if (event.type === 'text_delta') {
              fullResponse += event.text;

              // Start speaking on first chunk
              if (!firstChunkSent) {
                firstChunkSent = true;
                isAgentSpeaking = true;
                clientWs.send(JSON.stringify({ type: 'agent_speaking', requestId: thisRequestId }));
              }

              // Send text to TTS
              if (ttsProviderName === 'openai') {
                openaiTextBuffer += event.text;
              } else if (elevenWs?.readyState === WebSocket.OPEN) {
                elevenWs.send(JSON.stringify({ text: event.text }));
              }
            }
          }

          // Mark Claude response as complete
          claudeResponseDone = true;

          // Flush TTS
          if (ttsProviderName === 'openai') {
            if (openaiTextBuffer.trim()) {
              ttsWaitingForFlush = true;
              const text = openaiTextBuffer;
              openaiTextBuffer = '';
              streamOpenAISegment(text);
            }
          } else if (elevenWs?.readyState === WebSocket.OPEN) {
            ttsWaitingForFlush = true;
            elevenWs.send(JSON.stringify({ text: '' }));
          }

          // Record to conversation DB
          if (fullResponse && db) {
            try {
              const agentName = ConversationService.getAgentName(assistant.id);
              ConversationService.addEntry(db, assistant.id, {
                type: 'conversation',
                speaker: agentName,
                role: 'assistant',
                channel: 'phone',
                content: fullResponse
              });
            } catch (convErr) {
              console.warn(`CallStream [${callId}]: Failed to record phone response:`, convErr.message);
            }
          }

          return; // SDK path complete
        } catch (sdkErr) {
          console.error(`CallStream [${callId}] [${requestUuid}]: SDK error:`, sdkErr.message);
          // Fall through to CLI path
        }
      }

      // --- CLI path (unchanged) ---
      // SAFETY NET: Kill any existing Claude processes for this app before spawning
      // This catches orphaned processes from crashes, races, or other edge cases
      killExistingClaudeProcesses(appPath, callId);

      // Spawn agent process
      console.log(`CallStream [${callId}] [${requestUuid}]: SPAWNING ${callBackend.command.toUpperCase()}`);
      claudeProcess = createProcess(callBackend, args, { cwd: appPath, env });

      let buffer = '';
      let fullResponse = '';
      let firstChunkSent = false;

      // DIAGNOSTIC: Track Claude stream events for tool use debugging
      let contentBlockCount = 0;
      let toolUseCount = 0;
      let textChunkCount = 0;

      // FIX: Track pending text to send to TTS
      // When tool_use starts, we flush pending text and wait for audio before continuing
      let pendingTtsText = '';
      let inTextBlock = false;  // Track if we're currently inside a text content block

      claudeProcess.onData((data) => {
        // Check if this request is stale (a newer request superseded it)
        if (thisRequestId !== currentRequestId) {
          console.log(`CallStream [${callId}] [${requestUuid}]: IGNORING stale Claude data (${thisRequestId} != ${currentRequestId})`);
          return;
        }

        buffer += data;

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const json = JSON.parse(line);

            // DIAGNOSTIC: Log all stream event types to understand tool use flow
            if (json.type === 'stream_event') {
              const eventType = json.event?.type;

              // Track content block lifecycle
              if (eventType === 'content_block_start') {
                contentBlockCount++;
                const blockType = json.event?.content_block?.type || 'unknown';
                console.log(`CallStream [${callId}]: DIAG content_block_start #${contentBlockCount} (type=${blockType})`);

                // FIX: Track when we enter a text block and increment segment ID
                if (blockType === 'text') {
                  inTextBlock = true;
                  ttsSegmentId++;
                  currentAudioSegmentId = ttsSegmentId;
                  console.log(`CallStream [${callId}]: NEW TTS SEGMENT ${ttsSegmentId} (content block #${contentBlockCount})`);

                  if (ttsProviderName === 'openai') {
                    // OpenAI: just reset the text buffer for this segment
                    openaiTextBuffer = '';
                  } else {
                    // ElevenLabs: If connection was closed (after previous segment's isFinal),
                    // we need to reconnect for this new text block
                    if (!elevenWs || elevenWs.readyState !== WebSocket.OPEN) {
                      elevenWsId++;
                      console.log(`CallStream [${callId}]: ElevenLabs not connected, reconnecting for segment ${ttsSegmentId} (new wsId=${elevenWsId})`);
                      ttsWaitingForFlush = true;
                      ttsNeedsFlushAfterConnect = false;
                      connectToElevenLabs().then(() => {
                        console.log(`CallStream [${callId}]: ElevenLabs reconnected for segment ${ttsSegmentId}, queueLen=${ttsPendingQueue.length}, needsFlush=${ttsNeedsFlushAfterConnect}`);
                        while (ttsPendingQueue.length > 0 && elevenWs?.readyState === WebSocket.OPEN) {
                          const queuedText = ttsPendingQueue.shift();
                          elevenWs.send(JSON.stringify({ text: queuedText }));
                          console.log(`CallStream [${callId}]: Sent queued text after reconnect: "${queuedText.substring(0, 30)}..."`);
                        }
                        if (ttsNeedsFlushAfterConnect && elevenWs?.readyState === WebSocket.OPEN) {
                          console.log(`CallStream [${callId}]: Flushing after reconnect (deferred from content_block_stop)`);
                          elevenWs.send(JSON.stringify({ text: '' }));
                        } else {
                          ttsWaitingForFlush = false;
                        }
                      }).catch(err => {
                        console.error(`CallStream [${callId}]: Failed to reconnect to ElevenLabs:`, err.message);
                        ttsWaitingForFlush = false;
                      });
                    }
                  }

                  // Notify client of new segment so it can queue audio properly
                  clientWs.send(JSON.stringify({
                    type: 'tts_segment_start',
                    segmentId: ttsSegmentId,
                    requestId: thisRequestId
                  }));
                }
              } else if (eventType === 'content_block_stop') {
                console.log(`CallStream [${callId}]: DIAG content_block_stop #${contentBlockCount}`);

                // FIX: When a text block ends, notify client and flush TTS
                if (inTextBlock) {
                  // Notify client that this segment is complete (all text sent/queued)
                  clientWs.send(JSON.stringify({
                    type: 'tts_segment_end',
                    segmentId: ttsSegmentId,
                    requestId: thisRequestId
                  }));

                  if (ttsProviderName === 'openai') {
                    // OpenAI: trigger HTTP stream with accumulated text
                    if (openaiTextBuffer.trim() && !ttsWaitingForFlush) {
                      ttsWaitingForFlush = true;
                      const segmentText = openaiTextBuffer;
                      openaiTextBuffer = '';
                      console.log(`CallStream [${callId}]: Streaming OpenAI segment ${ttsSegmentId} (${segmentText.length} chars)`);
                      streamOpenAISegment(segmentText);
                    } else if (ttsWaitingForFlush && openaiTextBuffer.trim()) {
                      // Previous segment still streaming — queue this text
                      ttsPendingQueue.push(openaiTextBuffer);
                      openaiTextBuffer = '';
                      console.log(`CallStream [${callId}]: Segment ${ttsSegmentId} queued (previous segment still streaming)`);
                    }
                  } else if (elevenWs?.readyState === WebSocket.OPEN && !ttsWaitingForFlush) {
                    // ElevenLabs: flush immediately
                    ttsWaitingForFlush = true;
                    console.log(`CallStream [${callId}]: FLUSHING TTS at content_block_stop for segment ${ttsSegmentId}, waiting for isFinal`);
                    elevenWs.send(JSON.stringify({ text: '' }));
                  } else if (ttsWaitingForFlush) {
                    ttsNeedsFlushAfterConnect = true;
                    console.log(`CallStream [${callId}]: Segment ${ttsSegmentId} - will flush after reconnect/queue processing`);
                  } else {
                    console.log(`CallStream [${callId}]: WARNING - content_block_stop but no connection and not waiting`);
                  }
                }
                inTextBlock = false;
              }

              // Track tool use
              if (eventType === 'tool_use' || json.event?.content_block?.type === 'tool_use') {
                toolUseCount++;
                const toolName = json.event?.name || json.event?.content_block?.name || 'unknown';
                console.log(`CallStream [${callId}]: DIAG tool_use #${toolUseCount} (tool=${toolName})`);
              }
            }

            // Extract streaming text — Claude uses stream_event, Gemini uses message+delta
            let textChunk = null;
            if (json.type === 'stream_event' && json.event?.type === 'content_block_delta') {
              textChunk = json.event?.delta?.text;
            } else if (json.type === 'message' && json.delta && json.role === 'assistant') {
              textChunk = json.content;
              // Gemini doesn't have content_block_start — start TTS segment on first text
              if (textChunk && !inTextBlock) {
                inTextBlock = true;
                ttsSegmentId++;
                currentAudioSegmentId = ttsSegmentId;
              }
            }
            if (textChunk) {
                textChunkCount++;
                fullResponse += textChunk;

                // DIAGNOSTIC: Log each text chunk being sent to TTS
                console.log(`CallStream [${callId}]: DIAG TEXT CHUNK #${textChunkCount}: "${textChunk}"`);

                // Start speaking on first chunk
                if (!firstChunkSent) {
                  firstChunkSent = true;
                  isAgentSpeaking = true;
                  console.log(`CallStream [${callId}] [${requestUuid}]: FIRST TEXT CHUNK - isAgentSpeaking=true`);
                  clientWs.send(JSON.stringify({ type: 'agent_speaking', requestId: thisRequestId }));
                }

                // Send text to TTS
                if (ttsProviderName === 'openai') {
                  // OpenAI: buffer text — will be sent as one HTTP call on content_block_stop
                  openaiTextBuffer += textChunk;
                } else if (ttsWaitingForFlush || !elevenWs || elevenWs.readyState !== WebSocket.OPEN) {
                  // ElevenLabs: queue if waiting for flush or not connected
                  console.log(`CallStream [${callId}]: QUEUING text (waitingForFlush=${ttsWaitingForFlush}, wsOpen=${elevenWs?.readyState === WebSocket.OPEN}): "${textChunk.substring(0, 30)}..."`);
                  ttsPendingQueue.push(textChunk);
                } else {
                  elevenWs.send(JSON.stringify({ text: textChunk }));
                }
            } else if (json.type === 'result') {
              // Log full response with UUID
              console.log(`CallStream [${callId}] [${requestUuid}]: CLAUDE RESULT - "${fullResponse.substring(0, 100)}..."`);
              console.log(`CallStream [${callId}] [${requestUuid}]: Stats: contentBlocks=${contentBlockCount}, toolUses=${toolUseCount}, textChunks=${textChunkCount}`);

              // Store session ID
              if (json.session_id && state?.setSessionId) {
                state.setSessionId(json.session_id);
              }

              // FIX: Mark Claude response as complete
              claudeResponseDone = true;
              console.log(`CallStream [${callId}]: DIAG result received, ttsWaitingForFlush=${ttsWaitingForFlush}, queueLen=${ttsPendingQueue.length}`);

              // If we're not waiting for a flush (all audio already received), send agent_done now
              if (!ttsWaitingForFlush && ttsPendingQueue.length === 0) {
                console.log(`CallStream [${callId}]: Claude done and no pending TTS, marking agent done`);
                isAgentSpeaking = false;
                agentStoppedSpeakingAt = Date.now();
                clientWs.send(JSON.stringify({ type: 'agent_done', requestId: thisRequestId }));
              }
              // Otherwise, agent_done will be sent when isFinal arrives
            }
          } catch (e) {
            // Not valid JSON, ignore
          }
        }
      });

      claudeProcess.onExit(({ exitCode }) => {
        console.log(`CallStream [${callId}] [${requestUuid}]: CLAUDE EXITED code=${exitCode}, releasing mutex`);
        claudeProcess = null;
        sendInProgress = false;  // Release mutex when Claude exits

        // Record assistant response to conversation DB
        if (exitCode === 0 && fullResponse && db) {
          try {
            const agentName = ConversationService.getAgentName(assistant.id);
            ConversationService.addEntry(db, assistant.id, {
              type: 'conversation',
              speaker: agentName,
              role: 'assistant',
              channel: 'phone',
              content: fullResponse
            });
          } catch (convErr) {
            console.warn(`CallStream [${callId}]: Failed to record phone assistant response:`, convErr.message);
          }
        }

        // Only report errors for the current request
        if (thisRequestId === currentRequestId && exitCode !== 0) {
          clientWs.send(JSON.stringify({
            type: 'error',
            message: 'Assistant encountered an error'
          }));
        }
      });
    } finally {
      // Note: We release the mutex in onExit, not here, because the Claude process
      // runs asynchronously. The mutex prevents NEW requests from entering while
      // we're in the async gap (between start and ElevenLabs connect).
      // For early returns (errors, stale checks), we need to release here:
      if (!claudeProcess) {
        sendInProgress = false;
      }
    }
  }

  // Handle messages from client
  clientWs.on('message', (data, isBinary) => {
    if (isBinary) {
      // Audio data - forward to Whisper
      if (whisperWs?.readyState === WebSocket.OPEN) {
        // Check backpressure
        if (whisperWs.bufferedAmount < 100000) {
          whisperWs.send(data);
        }
      }
    } else {
      // JSON control message
      try {
        const message = JSON.parse(data.toString());

        switch (message.type) {
          case 'pong':
            awaitingPong = false;
            CallService.recordPong(callId);
            break;

          case 'end_call':
            console.log(`CallStream [${callId}]: Client requested end`);
            cleanup('client_request');
            break;

          case 'mute':
            console.log(`CallStream [${callId}]: Mute state: ${message.muted}`);
            // Client handles mute locally, just log
            break;

          case 'playback_done':
            // Client finished playing all audio - update echo suppression timestamp
            // This is more accurate than server-side isFinal which fires before audio plays
            console.log(`CallStream [${callId}]: Client playback complete (request ${message.requestId})`);
            agentStoppedSpeakingAt = Date.now();
            break;

          case 'client_debug':
            // Debug info from client about audio scheduling
            console.log(`CallStream [${callId}]: CLIENT: ${message.msg}`);
            break;

          default:
            console.log(`CallStream [${callId}]: Unknown message type: ${message.type}`);
        }
      } catch (e) {
        console.error(`CallStream [${callId}]: Failed to parse message:`, e);
      }
    }
  });

  // Cleanup function
  function cleanup(reason) {
    console.log(`CallStream [${callId}]: Cleanup (${reason})`);

    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }

    if (whisperWs) {
      try { whisperWs.close(); } catch (e) {}
      whisperWs = null;
    }

    if (elevenWs) {
      try { elevenWs.close(); } catch (e) {}
      elevenWs = null;
    }

    if (openaiAbortFn) {
      openaiAbortFn();
      openaiAbortFn = null;
    }

    if (claudeProcess) {
      try { claudeProcess.kill(); } catch (e) {}
      claudeProcess = null;
    }

    CallService.end(callId, reason);
  }

  // Handle client disconnect
  clientWs.on('close', () => {
    console.log(`CallStream [${callId}]: Client disconnected`);
    cleanup('client_disconnect');
  });

  clientWs.on('error', (err) => {
    console.error(`CallStream [${callId}]: Client error:`, err.message);
    cleanup('client_error');
  });

  // Initialize Whisper connection
  if (!connectToWhisper()) {
    clientWs.send(JSON.stringify({
      type: 'error',
      message: 'Speech recognition not available. Is Whisper running?'
    }));
    // Don't end call - client can still receive and might have alternative input
  }
}

module.exports = createCallStreamHandler;
