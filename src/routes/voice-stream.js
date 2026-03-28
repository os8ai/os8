/**
 * Voice Stream WebSocket Route
 *
 * Proxies WebSocket connections between browser and whisper-stream-server.
 * Browser sends 16-bit PCM audio chunks, receives partial/final transcription results.
 *
 * Protocol:
 *   Client → Server: Binary frames (16-bit signed PCM, 16kHz mono)
 *   Server → Client: JSON messages { type: 'ready'|'partial'|'final'|'error', text?, message? }
 */

const WebSocket = require('ws');
const CallService = require('../services/call');

// Track active voice client connections so we can terminate them when a call starts
const activeConnections = new Set();

/**
 * Creates WebSocket voice streaming handler
 * @param {object} deps - Dependencies
 * @param {object} deps.services - Service instances (WhisperStreamService)
 */
function createVoiceStreamHandler({ services }) {
  const { WhisperStreamService } = services;

  return function setupVoiceStream(server) {
    const wss = new WebSocket.Server({ noServer: true });

    // Handle WebSocket upgrade requests
    server.on('upgrade', (request, socket, head) => {
      // Only handle /api/voice/stream path
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (url.pathname !== '/api/voice/stream') {
        return; // Let other handlers deal with it
      }

      // Check if a phone call is active - desktop voice is disabled during calls
      if (CallService.hasActiveCall()) {
        console.log('VoiceStream: Rejected connection - phone call is active');
        socket.write('HTTP/1.1 503 Service Unavailable\r\n');
        socket.write('Content-Type: application/json\r\n');
        socket.write('\r\n');
        socket.write(JSON.stringify({ error: 'Desktop voice disabled during phone call', callActive: true }));
        socket.destroy();
        return;
      }

      // Check if streaming server is running
      if (!WhisperStreamService.isRunning()) {
        console.log('VoiceStream: Rejected connection - streaming server not running');
        socket.write('HTTP/1.1 503 Service Unavailable\r\n');
        socket.write('Content-Type: application/json\r\n');
        socket.write('\r\n');
        socket.write(JSON.stringify({ error: 'Streaming server not running' }));
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (clientWs) => {
        handleConnection(clientWs, WhisperStreamService);
      });
    });

    // When a phone call starts, terminate all active desktop voice connections
    CallService.on('call-active', () => {
      if (activeConnections.size > 0) {
        console.log(`VoiceStream: Phone call started - terminating ${activeConnections.size} active connection(s)`);
        for (const clientWs of activeConnections) {
          try {
            clientWs.send(JSON.stringify({ type: 'error', message: 'Phone call active', callActive: true }));
            clientWs.close();
          } catch (e) {
            // Ignore errors when closing
          }
        }
        activeConnections.clear();
      }
    });

    console.log('VoiceStream: WebSocket handler registered at /api/voice/stream');
  };
}

/**
 * Handle a single WebSocket connection
 */
function handleConnection(clientWs, WhisperStreamService) {
  console.log('VoiceStream: Client connected');

  // Track this connection so we can terminate it when a phone call starts
  activeConnections.add(clientWs);

  const whisperUrl = WhisperStreamService.getWebSocketUrl();
  console.log('VoiceStream: Connecting to whisper server at:', whisperUrl);

  let whisperWs = null;
  let connected = false;

  // Connect to whisper-stream-server
  try {
    whisperWs = new WebSocket(whisperUrl, {
      handshakeTimeout: 5000,
      perMessageDeflate: false
    });
  } catch (err) {
    console.error('VoiceStream: Failed to create WebSocket:', err.message);
    clientWs.send(JSON.stringify({ type: 'error', message: 'Failed to connect to transcription server' }));
    clientWs.close();
    return;
  }

  whisperWs.on('open', () => {
    connected = true;
    console.log('VoiceStream: Connected to whisper-stream-server at', whisperUrl);
    // The whisper server sends a 'ready' message, which we'll forward
  });

  whisperWs.on('unexpected-response', (request, response) => {
    console.error('VoiceStream: Unexpected HTTP response:', response.statusCode, response.statusMessage);
    let body = '';
    response.on('data', chunk => body += chunk);
    response.on('end', () => console.error('VoiceStream: Response body:', body));
  });

  whisperWs.on('message', (data) => {
    // Forward results from whisper to client
    if (clientWs.readyState === WebSocket.OPEN) {
      try {
        // Data from whisper-stream-server is already JSON
        const message = data.toString();
        clientWs.send(message);

        // Log partial/final for debugging (but not full content to reduce noise)
        try {
          const parsed = JSON.parse(message);
          if (parsed.type === 'partial') {
            console.log('VoiceStream: Partial -', parsed.text?.substring(0, 50) + '...');
          } else if (parsed.type === 'final') {
            console.log('VoiceStream: Final -', parsed.text?.substring(0, 50) + '...');
          } else if (parsed.type === 'ready') {
            console.log('VoiceStream: Server ready');
          }
        } catch (e) {
          // Not JSON, forward as-is
        }
      } catch (err) {
        console.error('VoiceStream: Error forwarding message:', err.message);
      }
    }
  });

  whisperWs.on('close', (code, reason) => {
    console.log('VoiceStream: Whisper connection closed:', code, reason?.toString());
    connected = false;
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ type: 'error', message: 'Transcription server disconnected' }));
      clientWs.close();
    }
  });

  whisperWs.on('error', (err) => {
    console.error('VoiceStream: Whisper WebSocket error:', err.message);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ type: 'error', message: err.message }));
    }
  });

  // Forward audio from client to whisper (with backpressure handling)
  clientWs.on('message', (data) => {
    if (connected && whisperWs.readyState === WebSocket.OPEN) {
      // Check for backpressure - if whisper server buffer is too full, drop frames
      if (whisperWs.bufferedAmount < 100000) { // ~100KB buffer limit
        whisperWs.send(data);
      } else {
        // Log occasional drops (don't spam logs)
        if (Math.random() < 0.1) {
          console.log('VoiceStream: Dropping audio frame (backpressure)');
        }
      }
    }
  });

  clientWs.on('close', () => {
    console.log('VoiceStream: Client disconnected');
    activeConnections.delete(clientWs);
    if (whisperWs && whisperWs.readyState === WebSocket.OPEN) {
      whisperWs.close();
    }
  });

  clientWs.on('error', (err) => {
    console.error('VoiceStream: Client WebSocket error:', err.message);
    activeConnections.delete(clientWs);
    if (whisperWs && whisperWs.readyState === WebSocket.OPEN) {
      whisperWs.close();
    }
  });
}

module.exports = createVoiceStreamHandler;
