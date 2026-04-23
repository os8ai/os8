/**
 * TTS Stream WebSocket Route
 *
 * Proxies WebSocket connections between browser and TTS provider.
 * Receives text chunks from client, sends audio PCM back for playback.
 *
 * Protocol:
 *   Client → Server: JSON messages { type: 'init'|'text'|'flush'|'cancel', ... }
 *   Server → Client: JSON messages { type: 'ready'|'audio'|'done'|'error'|'cancelled', ... }
 *
 * Providers:
 *   ElevenLabs: WebSocket proxy (text streams in, audio streams back)
 *   OpenAI: HTTP adapter (text buffered, POST on flush, PCM streamed back)
 */

const WebSocket = require('ws')
const CallService = require('../services/call')
const TTSService = require('../services/tts')

// Track active TTS client connections so we can terminate them when a call starts
const activeConnections = new Set()

/**
 * Creates WebSocket TTS streaming handler
 * @param {object} deps - Dependencies
 * @param {object} deps.db - Database instance
 */
function createTTSStreamHandler({ db, services }) {

  return function setupTTSStream(server) {
    const wss = new WebSocket.Server({ noServer: true })

    // Handle WebSocket upgrade requests
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url, `http://${request.headers.host}`)
      if (url.pathname !== '/api/tts/stream') {
        return // Let other handlers deal with it
      }

      // Check if a phone call is active - desktop TTS is disabled during calls
      if (CallService.hasActiveCall()) {
        console.log('TTSStream: Rejected connection - phone call is active')
        socket.write('HTTP/1.1 503 Service Unavailable\r\n')
        socket.write('Content-Type: application/json\r\n')
        socket.write('\r\n')
        socket.write(JSON.stringify({ error: 'Desktop TTS disabled during phone call', callActive: true }))
        socket.destroy()
        return
      }

      // Check if TTS provider and API key are available
      const ttsStatus = TTSService.isAvailable(db)
      if (!ttsStatus.available) {
        console.log('TTSStream: Rejected connection -', ttsStatus.reason)
        socket.write('HTTP/1.1 503 Service Unavailable\r\n')
        socket.write('Content-Type: application/json\r\n')
        socket.write('\r\n')
        socket.write(JSON.stringify({ error: ttsStatus.reason === 'no_provider' ? 'No TTS provider configured' : 'TTS API key not configured', setup: true }))
        socket.destroy()
        return
      }

      const apiKey = TTSService.getApiKey(db)
      const providerName = TTSService.getProviderName(db)
      wss.handleUpgrade(request, socket, head, (clientWs) => {
        if (providerName === 'openai') {
          handleHttpStreamingConnection(clientWs, apiKey, db, require('../services/tts-openai'), 'OpenAI')
        } else if (providerName === 'kokoro') {
          // Kokoro has no WebSocket endpoint (like OpenAI) — same streamAudioChunked
          // interface, reuse the HTTP-streaming handler. apiKey will be null
          // since Kokoro has no auth; provider.streamAudioChunked ignores it.
          handleHttpStreamingConnection(clientWs, apiKey, db, require('../services/tts-kokoro'), 'Kokoro')
        } else {
          handleElevenLabsConnection(clientWs, apiKey, db)
        }
      })
    })

    // When a phone call starts, terminate all active desktop TTS connections
    CallService.on('call-active', () => {
      if (activeConnections.size > 0) {
        console.log(`TTSStream: Phone call started - terminating ${activeConnections.size} active connection(s)`)
        for (const clientWs of activeConnections) {
          try {
            clientWs.send(JSON.stringify({ type: 'cancelled', reason: 'phone_call_active' }))
            clientWs.close()
          } catch (e) {
            // Ignore errors when closing
          }
        }
        activeConnections.clear()
      }
    })

    console.log('TTSStream: WebSocket handler registered at /api/tts/stream')
  }
}

// ============================================
// ElevenLabs WebSocket path (existing behavior)
// ============================================

function handleElevenLabsConnection(clientWs, apiKey, db) {
  console.log('TTSStream: Client connected (ElevenLabs)')
  activeConnections.add(clientWs)

  let elevenWs = null
  let connected = false
  let settings = null

  clientWs.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString())

      switch (message.type) {
        case 'init':
          settings = TTSService.getSettings(db)
          const voiceId = message.voiceId || settings.voiceId
          const model = message.model || settings.model

          console.log(`TTSStream: [VOICE DEBUG] client sent voiceId=${message.voiceId || '(none)'}, resolved=${voiceId}, default=${settings.voiceId}`)
          const wsUrl = TTSService.getWebSocketUrl(db, { voiceId, model })
          console.log('TTSStream: Connecting to ElevenLabs:', wsUrl)

          try {
            elevenWs = new WebSocket(wsUrl, {
              headers: {
                'xi-api-key': apiKey
              },
              handshakeTimeout: 5000
            })
          } catch (err) {
            console.error('TTSStream: Failed to create WebSocket:', err.message)
            clientWs.send(JSON.stringify({ type: 'error', message: 'Failed to connect to ElevenLabs' }))
            return
          }

          elevenWs.on('open', () => {
            connected = true
            console.log('TTSStream: Connected to ElevenLabs')

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
            }))

            clientWs.send(JSON.stringify({ type: 'ready' }))
          })

          elevenWs.on('message', (chunk) => {
            if (clientWs.readyState !== WebSocket.OPEN) return

            try {
              const response = JSON.parse(chunk.toString())

              if (response.audio) {
                clientWs.send(JSON.stringify({
                  type: 'audio',
                  data: response.audio
                }))
              }

              if (response.isFinal) {
                clientWs.send(JSON.stringify({ type: 'done' }))
              }
            } catch (e) {
              if (Buffer.isBuffer(chunk)) {
                clientWs.send(JSON.stringify({
                  type: 'audio',
                  data: chunk.toString('base64')
                }))
              }
            }
          })

          elevenWs.on('close', (code, reason) => {
            console.log('TTSStream: ElevenLabs connection closed:', code, reason?.toString())
            connected = false
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({ type: 'done' }))
              // Close client WebSocket so preconnect/prefetch detects dead connection
              clientWs.close()
            }
          })

          elevenWs.on('error', (err) => {
            console.error('TTSStream: ElevenLabs WebSocket error:', err.message)
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({ type: 'error', message: err.message }))
            }
          })
          break

        case 'text':
          if (connected && elevenWs?.readyState === WebSocket.OPEN) {
            const textMessage = {
              text: message.text
            }

            if (message.flush) {
              textMessage.flush = true
            }

            elevenWs.send(JSON.stringify(textMessage))
            console.log('TTSStream: Sent text:', message.text?.substring(0, 50) + (message.text?.length > 50 ? '...' : ''))
            console.log('TTSStream: Text length:', message.text?.length, 'flush:', message.flush)
          }
          break

        case 'flush':
          console.log('TTSStream: Received flush command from client')
          if (connected && elevenWs?.readyState === WebSocket.OPEN) {
            elevenWs.send(JSON.stringify({ text: '' }))
            console.log('TTSStream: Sent flush to ElevenLabs')
          } else {
            console.log('TTSStream: Cannot flush - connected:', connected, 'readyState:', elevenWs?.readyState)
          }
          break

        case 'cancel':
          console.log('TTSStream: Cancel requested')
          if (elevenWs) {
            elevenWs.close()
            elevenWs = null
            connected = false
          }
          clientWs.send(JSON.stringify({ type: 'cancelled' }))
          break

        default:
          console.log('TTSStream: Unknown message type:', message.type)
      }
    } catch (err) {
      console.error('TTSStream: Failed to parse message:', err)
    }
  })

  clientWs.on('close', () => {
    console.log('TTSStream: Client disconnected')
    activeConnections.delete(clientWs)
    if (elevenWs) {
      elevenWs.close()
      elevenWs = null
    }
  })

  clientWs.on('error', (err) => {
    console.error('TTSStream: Client WebSocket error:', err.message)
    if (elevenWs) {
      elevenWs.close()
      elevenWs = null
    }
  })
}

// ============================================
// OpenAI HTTP streaming path
// ============================================

/**
 * Generic HTTP-streaming TTS handler — works for any provider whose module
 * exports `streamAudioChunked(apiKey, text, voiceId, options, onChunk, onDone, onError)`
 * and a `DEFAULTS.model` default. OpenAI and Kokoro both fit.
 *
 * The handler buffers text between flush events, POSTs the buffered text to
 * the provider on flush, and streams PCM audio back to the browser over the
 * already-open WebSocket. No upstream WebSocket — the provider's HTTP-streamed
 * response is adapted to chunks on our side.
 */
function handleHttpStreamingConnection(clientWs, apiKey, db, provider, label) {
  console.log(`TTSStream: Client connected (${label})`)
  activeConnections.add(clientWs)

  let textBuffer = ''
  let abortFn = null
  let streaming = false
  let voiceId = null
  let settings = null

  clientWs.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString())

      switch (message.type) {
        case 'init':
          settings = TTSService.getSettings(db)
          voiceId = message.voiceId || settings.voiceId
          console.log(`TTSStream: [VOICE DEBUG] client sent voiceId=${message.voiceId || '(none)'}, resolved=${voiceId}, default=${settings.voiceId}`)
          // Ready immediately — no upstream connection to establish
          clientWs.send(JSON.stringify({ type: 'ready' }))
          console.log('TTSStream: OpenAI ready (voiceId:', voiceId, ')')
          break

        case 'text':
          textBuffer += message.text || ''
          console.log('TTSStream: Buffered text:', (message.text || '').substring(0, 50) + ((message.text?.length || 0) > 50 ? '...' : ''))
          console.log('TTSStream: Buffer length:', textBuffer.length, 'flush:', message.flush)

          // If flush flag on text message, trigger immediate flush
          if (message.flush) {
            flushProvider()
          }
          break

        case 'flush':
          console.log('TTSStream: Received flush command from client')
          flushProvider()
          break

        case 'cancel':
          console.log('TTSStream: Cancel requested')
          if (abortFn) {
            abortFn()
            abortFn = null
          }
          streaming = false
          textBuffer = ''
          clientWs.send(JSON.stringify({ type: 'cancelled' }))
          break

        default:
          console.log('TTSStream: Unknown message type:', message.type)
      }
    } catch (err) {
      console.error('TTSStream: Failed to parse message:', err)
    }
  })

  function flushProvider() {
    const text = textBuffer.trim()
    textBuffer = ''

    if (!text) {
      if (streaming) {
        // Stream in-flight will send done when it completes — ignore empty flush
        console.log('TTSStream: Flush with empty buffer, stream in-flight — ignoring')
      } else {
        console.log('TTSStream: Flush with empty buffer, sending done')
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({ type: 'done' }))
        }
      }
      return
    }

    if (streaming) {
      console.log('TTSStream: Already streaming, queueing flush')
      // Re-buffer — will be picked up when current stream completes
      textBuffer = text
      return
    }

    streaming = true
    console.log(`TTSStream: Starting ${label} stream for ${text.length} chars`)

    abortFn = provider.streamAudioChunked(
      apiKey,
      text,
      voiceId,
      { model: settings?.model || provider.DEFAULTS.model, speed: settings?.speed ?? 1.0 },
      // onChunk
      (base64Data) => {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({ type: 'audio', data: base64Data }))
        }
      },
      // onDone
      () => {
        streaming = false
        abortFn = null
        console.log(`TTSStream: ${label} stream complete`)

        // If more text was buffered during streaming, flush it
        if (textBuffer.trim()) {
          console.log('TTSStream: Processing queued text after stream complete')
          flushProvider()
        } else if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({ type: 'done' }))
        }
      },
      // onError
      (err) => {
        console.error(`TTSStream: ${label} stream error:`, err.message)
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({ type: 'error', message: err.message }))
        }
        // Note: onDone is called after onError by streamAudioChunked,
        // so client will still get 'done' and won't hang
      }
    )
  }

  clientWs.on('close', () => {
    console.log('TTSStream: Client disconnected')
    activeConnections.delete(clientWs)
    if (abortFn) {
      abortFn()
      abortFn = null
    }
  })

  clientWs.on('error', (err) => {
    console.error('TTSStream: Client WebSocket error:', err.message)
    if (abortFn) {
      abortFn()
      abortFn = null
    }
  })
}

module.exports = createTTSStreamHandler
