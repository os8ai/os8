/**
 * TTSStreamCore - Text-to-Speech streaming playback
 *
 * Single source of truth for TTS audio streaming in OS8.
 * Used by the assistant app for real-time speech output.
 *
 * Features:
 * - WebSocket connection to ElevenLabs via /api/tts/stream
 * - PCM 24kHz to AudioBuffer conversion
 * - Gapless playback scheduling via AudioContext
 * - Fade-out on interruption (150ms)
 * - Progressive chunk queue for streaming
 */

// Default configuration
const DEFAULT_CONFIG = {
  fadeOutDuration: 0.15, // 150ms fade out on cancel
  sampleRate: 24000,     // ElevenLabs PCM format
}

/**
 * Convert base64-encoded 16-bit signed PCM to Float32 AudioBuffer
 * @param {AudioContext} audioContext - The audio context
 * @param {string} base64Data - Base64 encoded PCM data
 * @param {number} sampleRate - Sample rate (24000 for ElevenLabs)
 * @returns {AudioBuffer} The audio buffer
 */
function pcmToAudioBuffer(audioContext, base64Data, sampleRate = 24000) {
  // Decode base64 to binary
  const binaryString = atob(base64Data)
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }

  // Convert 16-bit signed PCM to Float32
  const int16View = new Int16Array(bytes.buffer)
  const float32Array = new Float32Array(int16View.length)

  for (let i = 0; i < int16View.length; i++) {
    // Convert from [-32768, 32767] to [-1.0, 1.0]
    float32Array[i] = int16View[i] / 32768
  }

  // Create AudioBuffer
  const audioBuffer = audioContext.createBuffer(1, float32Array.length, sampleRate)
  audioBuffer.copyToChannel(float32Array, 0)

  return audioBuffer
}

/**
 * TTSStreamCore class - unified TTS playback implementation
 */
export class TTSStreamCore {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }

    // State
    this.isPlaying = false
    this.isConnecting = false
    this.isCancelled = false

    // Audio
    this.audioContext = null
    this.gainNode = null
    this.scheduledSources = []
    this.nextStartTime = 0

    // WebSocket
    this.ws = null

    // Text chunking
    this.textBuffer = ''
    this.chunkTimer = null
    this.minChunkChars = 50
    this.flushTimeoutMs = 400

    // Pending operations queue (captures calls during isConnecting phase)
    this.pendingOps = []

    // Duplicate detection (prevent echo from duplicate chunks)
    this.lastAudioHash = null

    // Stream end timer (must be cleared on cancel/reconnect to prevent stale cleanup)
    this.streamEndTimer = null

    // Timing diagnostics
    this.lastChunkTime = null
    this.chunkCount = 0

    // Prefetch: pre-generated audio for next message
    this._prefetch = null  // { ws, chunks: [base64], done: bool, voiceId, model }

    // Preconnect: open+ready WebSocket held idle (no text sent yet)
    this._preconnect = null  // { ws, voiceId, model }

    // Callbacks
    this.onStateChange = null  // (state) => void
    this.onError = null        // (error) => void
    this.onStart = null        // () => void
    this.onEnd = null          // () => void
  }

  /**
   * Check if TTS streaming is supported
   */
  static isSupported() {
    return typeof AudioContext !== 'undefined' && typeof WebSocket !== 'undefined'
  }

  /**
   * Get current state
   */
  getState() {
    return {
      isPlaying: this.isPlaying,
      isConnecting: this.isConnecting,
      isCancelled: this.isCancelled
    }
  }

  /**
   * Initialize audio context and connect to TTS stream
   * @param {object} options - Options (voiceId, model)
   */
  async connect(options = {}) {
    if (this.isConnecting || this.isPlaying) {
      return false
    }

    // Clear any pending stream-end timer from a previous session
    if (this.streamEndTimer) {
      clearTimeout(this.streamEndTimer)
      this.streamEndTimer = null
    }

    this.isConnecting = true
    this.isCancelled = false
    this._usedPrefetch = false
    this._emitStateChange()

    try {
      // Pre-flight: check TTS availability before opening WebSocket
      const port = window.location.port || '8888'
      try {
        const statusRes = await fetch(`http://localhost:${port}/api/voice/tts-status`)
        const statusData = await statusRes.json()
        if (!statusData.available) {
          this._cleanup()
          const errorMsg = statusData.reason === 'no_provider'
            ? 'No TTS provider configured'
            : 'TTS API key not configured'
          this.onError?.(errorMsg, { setup: true, reason: statusData.reason })
          return false
        }
      } catch (prefErr) {
        console.warn('TTSStreamCore: Pre-flight check failed, proceeding with WebSocket:', prefErr.message)
      }

      // Create AudioContext
      this.audioContext = new AudioContext({ sampleRate: this.config.sampleRate })

      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume()
      }

      // Create gain node for volume control and fade-out
      this.gainNode = this.audioContext.createGain()
      this.gainNode.connect(this.audioContext.destination)

      // Check for prefetched audio (fully or partially generated)
      const hasPrefetch = this._prefetch
        && this._prefetch.ws?.readyState === WebSocket.OPEN
        && this._prefetch.voiceId === options.voiceId
        && (this._prefetch.chunks.length > 0 || !this._prefetch.done)

      // Discard prefetch that received 'done' with 0 chunks (upstream died before generating audio)
      if (this._prefetch && this._prefetch.done && this._prefetch.chunks.length === 0) {
        console.warn('TTSStreamCore: Discarding empty prefetch (0 chunks, done=true — upstream likely timed out)')
        try { this._prefetch.ws?.close() } catch (e) { /* ignore */ }
        this._prefetch = null
      }

      if (hasPrefetch) {
        const pf = this._prefetch
        this._prefetch = null
        console.log(`TTSStreamCore: Using prefetched audio (${pf.chunks.length} chunks buffered, done=${pf.done})`)
        this.ws = pf.ws

        // Re-wire message handler for live playback of any remaining chunks
        this.ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data)
            if (msg.type === 'audio') {
              this._handleAudioChunk(msg.data)
            } else if (msg.type === 'done') {
              console.log('TTSStreamCore: Stream complete')
              this._handleStreamEnd()
            } else if (msg.type === 'cancelled') {
              console.log('TTSStreamCore: Stream cancelled')
            } else if (msg.type === 'error') {
              console.error('TTSStreamCore: Server error:', msg.message)
              this.onError?.(msg.message)
            }
          } catch (e) {
            console.error('TTSStreamCore: Failed to parse message:', e)
          }
        }
        this.ws.onerror = () => {
          console.error('TTSStreamCore: WebSocket error')
        }
        this.ws.onclose = () => {
          if (this.isPlaying) {
            console.log('TTSStreamCore: Connection closed')
            this._handleStreamEnd()
          }
        }

        // Transition to playing state so _handleAudioChunk works
        this.isConnecting = false
        this.isPlaying = true
        this.nextStartTime = this.audioContext.currentTime
        this.lastAudioHash = null
        this.lastChunkTime = performance.now()
        this.chunkCount = 0
        this._emitStateChange()
        this.onStart?.()

        // Replay buffered chunks immediately
        for (const chunk of pf.chunks) {
          this._handleAudioChunk(chunk)
        }
        // If prefetch already received 'done', trigger stream end now
        if (pf.done) {
          console.log('TTSStreamCore: Prefetch was fully buffered, triggering stream end')
          this._handleStreamEnd()
        }

        this._usedPrefetch = true
        return true
      }

      // Close stale prefetch if voiceId didn't match
      if (this._prefetch) {
        try { this._prefetch.ws?.close() } catch (e) { /* ignore */ }
        this._prefetch = null
      }

      // Check for pre-connected WebSocket (open+ready, no text sent yet)
      const hasPreconnect = this._preconnect
        && this._preconnect.ws?.readyState === WebSocket.OPEN
        && this._preconnect.voiceId === options.voiceId

      if (hasPreconnect) {
        const pc = this._preconnect
        this._preconnect = null
        console.log('TTSStreamCore: Using pre-connected WebSocket')
        this.ws = pc.ws

        // Re-wire message handler for live playback
        this.ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data)
            if (msg.type === 'audio') {
              this._handleAudioChunk(msg.data)
            } else if (msg.type === 'done') {
              console.log('TTSStreamCore: Stream complete')
              this._handleStreamEnd()
            } else if (msg.type === 'cancelled') {
              console.log('TTSStreamCore: Stream cancelled')
            } else if (msg.type === 'error') {
              console.error('TTSStreamCore: Server error:', msg.message)
              this.onError?.(msg.message)
            }
          } catch (e) {
            console.error('TTSStreamCore: Failed to parse message:', e)
          }
        }
        this.ws.onerror = () => {
          console.error('TTSStreamCore: WebSocket error')
        }
        this.ws.onclose = () => {
          if (this.isPlaying) {
            console.log('TTSStreamCore: Connection closed')
            this._handleStreamEnd()
          }
        }

        this.isConnecting = false
        this.isPlaying = true
        this.nextStartTime = this.audioContext.currentTime
        this.lastAudioHash = null
        this.lastChunkTime = performance.now()
        this.chunkCount = 0
        console.log('TTSStreamCore: Stream started (pre-connected), ready for audio')
        this._replayPendingOps()
        this._emitStateChange()
        this.onStart?.()
        return true
      }

      // Close stale preconnect if voiceId didn't match
      if (this._preconnect) {
        try { this._preconnect.ws?.close() } catch (e) { /* ignore */ }
        this._preconnect = null
      }

      // Get WebSocket URL
      const wsUrl = `ws://localhost:${port}/api/tts/stream`

      // Connect to WebSocket
      this.ws = new WebSocket(wsUrl)

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('TTS connection timeout'))
        }, 5000)

        this.ws.onopen = () => {
          // Send init message
          this.ws.send(JSON.stringify({
            type: 'init',
            voiceId: options.voiceId,
            model: options.model
          }))
        }

        this.ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data)

            if (msg.type === 'ready') {
              clearTimeout(timeout)
              console.log('TTSStreamCore: Connected and ready')
              resolve()
            } else if (msg.type === 'audio') {
              this._handleAudioChunk(msg.data)
            } else if (msg.type === 'done') {
              console.log('TTSStreamCore: Stream complete')
              this._handleStreamEnd()
            } else if (msg.type === 'cancelled') {
              console.log('TTSStreamCore: Stream cancelled')
            } else if (msg.type === 'error') {
              console.error('TTSStreamCore: Server error:', msg.message)
              this.onError?.(msg.message)
            }
          } catch (e) {
            console.error('TTSStreamCore: Failed to parse message:', e)
          }
        }

        this.ws.onerror = () => {
          clearTimeout(timeout)
          reject(new Error('WebSocket error'))
        }

        this.ws.onclose = () => {
          if (this.isPlaying) {
            console.log('TTSStreamCore: Connection closed')
            this._handleStreamEnd()
          }
        }
      })

      this.isConnecting = false
      this.isPlaying = true
      this.nextStartTime = this.audioContext.currentTime
      this.lastAudioHash = null  // Reset duplicate detection for new stream
      this.lastChunkTime = performance.now()
      this.chunkCount = 0
      console.log('TTSStreamCore: Stream started, ready for audio')
      this._replayPendingOps()
      this._emitStateChange()
      this.onStart?.()

      return true

    } catch (err) {
      console.error('TTSStreamCore: Failed to connect:', err)
      this._cleanup()
      this.onError?.(err.message || 'Failed to connect to TTS service')
      return false
    }
  }

  /**
   * Send text chunk to be spoken
   * @param {string} text - Text to speak
   */
  streamText(text) {
    if (!this.isPlaying || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Queue if we're still connecting
      if (this.isConnecting) {
        this.pendingOps.push({ type: 'text', text })
        console.log(`TTSStreamCore: Queued text during connect (${text.length} chars)`)
      }
      return
    }

    // Clear any pending flush timer
    if (this.chunkTimer) {
      clearTimeout(this.chunkTimer)
      this.chunkTimer = null
    }

    // Add to buffer
    this.textBuffer += text

    // Check for sentence boundaries
    const chunks = this._extractChunks()
    for (const chunk of chunks) {
      console.log(`TTSStreamCore: Sending sentence chunk (${chunk.length} chars): "${chunk.slice(0, 50)}${chunk.length > 50 ? '...' : ''}"`)
      this.ws.send(JSON.stringify({ type: 'text', text: chunk }))
    }

    // Set timeout to flush remaining text
    if (this.textBuffer.length > 0) {
      this.chunkTimer = setTimeout(() => {
        if (this.textBuffer.length >= this.minChunkChars) {
          this._flushBuffer()
        }
      }, this.flushTimeoutMs)
    }
  }

  /**
   * Signal end of text input
   */
  flush() {
    if (!this.isPlaying || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Queue if we're still connecting
      if (this.isConnecting) {
        this.pendingOps.push({ type: 'flush' })
        console.log('TTSStreamCore: Queued flush during connect')
      } else {
        console.log('TTSStreamCore: flush() called but not ready - isPlaying:', this.isPlaying, 'ws:', !!this.ws)
      }
      return
    }

    if (this.chunkTimer) {
      clearTimeout(this.chunkTimer)
      this.chunkTimer = null
    }

    console.log('TTSStreamCore: Flushing - remaining buffer:', this.textBuffer.length, 'chars')

    // Flush any remaining text
    this._flushBuffer()

    // Signal end to server
    this.ws.send(JSON.stringify({ type: 'flush' }))
    console.log('TTSStreamCore: Flush signal sent to server')
  }

  /**
   * Cancel current speech with fade-out
   */
  cancel() {
    if (!this.isPlaying && !this.isConnecting) {
      return
    }

    console.log('TTSStreamCore: Cancelling playback')
    this.isCancelled = true
    this.pendingOps = []

    // Close prefetch connection
    if (this._prefetch) {
      try { this._prefetch.ws?.close() } catch (e) { /* ignore */ }
      this._prefetch = null
    }

    // Close preconnect connection
    if (this._preconnect) {
      try { this._preconnect.ws?.close() } catch (e) { /* ignore */ }
      this._preconnect = null
    }

    // Clear pending stream-end timer to prevent stale cleanup
    if (this.streamEndTimer) {
      clearTimeout(this.streamEndTimer)
      this.streamEndTimer = null
    }

    // Fade out
    if (this.gainNode && this.audioContext) {
      const now = this.audioContext.currentTime
      this.gainNode.gain.setValueAtTime(1, now)
      this.gainNode.gain.linearRampToValueAtTime(0, now + this.config.fadeOutDuration)

      // Stop all sources after fade
      setTimeout(() => {
        for (const source of this.scheduledSources) {
          try {
            source.stop()
          } catch (e) {
            // Already stopped
          }
        }
        this.scheduledSources = []
      }, this.config.fadeOutDuration * 1000)
    }

    // Tell server to cancel
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'cancel' }))
    }

    this._cleanup()
  }

  /**
   * One-shot: speak complete text
   * @param {string} text - Full text to speak
   * @param {object} options - Options (voiceId, model)
   */
  async speak(text, options = {}) {
    const connected = await this.connect(options)
    if (!connected) {
      return false
    }

    // If connect() used prefetch, text was already sent — don't send again
    if (!this._usedPrefetch) {
      this.ws.send(JSON.stringify({ type: 'text', text, flush: true }))
    }
    this._usedPrefetch = false
    return true
  }

  /**
   * Prefetch: connect, send text, and buffer audio for next message while current plays.
   * When connect() is called next, it replays buffered chunks instantly — near-zero gap.
   * @param {string} text - Full text to speak
   * @param {object} options - Options (voiceId, model)
   * @returns {Promise<boolean>} true if prefetch started
   */
  async prefetch(text, options = {}) {
    // Only prefetch while something is actively playing
    if (this._prefetch || this.isConnecting || !this.isPlaying) {
      return false
    }

    const port = window.location.port || '8888'
    const ws = new WebSocket(`ws://localhost:${port}/api/tts/stream`)
    const pf = { ws, chunks: [], done: false, voiceId: options.voiceId, model: options.model }

    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Prefetch timeout')), 5000)

        ws.onopen = () => {
          ws.send(JSON.stringify({
            type: 'init',
            voiceId: options.voiceId,
            model: options.model
          }))
        }

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data)
            if (msg.type === 'ready') {
              clearTimeout(timeout)
              resolve()
            } else if (msg.type === 'audio') {
              // Buffer audio chunks while we wait
              pf.chunks.push(msg.data)
            } else if (msg.type === 'done') {
              pf.done = true
            } else if (msg.type === 'error') {
              clearTimeout(timeout)
              reject(new Error(msg.message))
            }
          } catch (e) {
            // ignore parse errors
          }
        }

        ws.onerror = () => {
          clearTimeout(timeout)
          reject(new Error('Prefetch WebSocket error'))
        }

        ws.onclose = () => {
          clearTimeout(timeout)
          reject(new Error('Prefetch WebSocket closed'))
        }
      })

      // Connected — send the text immediately so audio generation starts
      ws.send(JSON.stringify({ type: 'text', text, flush: true }))

      this._prefetch = pf
      console.log(`TTSStreamCore: Prefetch started for voiceId: ${options.voiceId} (${text.length} chars)`)
      return true
    } catch (err) {
      console.warn('TTSStreamCore: Prefetch failed:', err.message)
      try { ws.close() } catch (e) { /* ignore */ }
      return false
    }
  }

  /**
   * Preconnect: open a TTS WebSocket and complete the init/ready handshake,
   * but send no text. The connection sits idle until promoteToPrefetch() or
   * connect() consumes it. Saves ~200-500ms of cold-start latency.
   * @param {object} options - Options (voiceId, model)
   * @returns {Promise<boolean>} true if preconnect succeeded
   */
  async preconnect(options = {}) {
    if (this._preconnect || this._prefetch || this.isPlaying || this.isConnecting) {
      return false
    }

    const port = window.location.port || '8888'
    const ws = new WebSocket(`ws://localhost:${port}/api/tts/stream`)

    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Preconnect timeout')), 5000)

        ws.onopen = () => {
          ws.send(JSON.stringify({
            type: 'init',
            voiceId: options.voiceId,
            model: options.model
          }))
        }

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data)
            if (msg.type === 'ready') {
              clearTimeout(timeout)
              resolve()
            } else if (msg.type === 'error') {
              clearTimeout(timeout)
              reject(new Error(msg.message))
            }
          } catch (e) { /* ignore */ }
        }

        ws.onerror = () => { clearTimeout(timeout); reject(new Error('Preconnect error')) }
        ws.onclose = () => { clearTimeout(timeout); reject(new Error('Preconnect closed')) }
      })

      this._preconnect = { ws, voiceId: options.voiceId, model: options.model }

      // Watch for server-side close (e.g., ElevenLabs 20s idle timeout)
      // so _preconnect gets cleaned up before promoteToPrefetch tries to use it
      ws.onclose = () => {
        if (this._preconnect && this._preconnect.ws === ws) {
          console.warn('TTSStreamCore: Preconnect WebSocket closed by server (idle timeout?)')
          this._preconnect = null
        }
      }

      console.log(`TTSStreamCore: Pre-connected TTS WebSocket (voiceId: ${options.voiceId})`)
      return true
    } catch (err) {
      console.warn('TTSStreamCore: Preconnect failed:', err.message)
      try { ws.close() } catch (e) { /* ignore */ }
      return false
    }
  }

  /**
   * Promote a preconnect into a prefetch by sending text into the already-open
   * WebSocket. Audio generation starts immediately; buffered chunks are stored
   * in this._prefetch so the next connect() picks them up instantly.
   * @param {string} text - Full text to speak
   * @param {object} options - Options (voiceId)
   * @returns {boolean} true if promotion succeeded
   */
  promoteToPrefetch(text, options = {}) {
    if (!this._preconnect) return false

    // Dead WebSocket — discard and bail
    if (this._preconnect.ws?.readyState !== WebSocket.OPEN) {
      console.warn('TTSStreamCore: Preconnect WebSocket dead (readyState:', this._preconnect.ws?.readyState, '), discarding')
      try { this._preconnect.ws?.close() } catch (e) { /* ignore */ }
      this._preconnect = null
      return false
    }

    // Voice mismatch — close and bail
    if (options.voiceId && options.voiceId !== this._preconnect.voiceId) {
      try { this._preconnect.ws?.close() } catch (e) { /* ignore */ }
      this._preconnect = null
      return false
    }

    const pc = this._preconnect
    this._preconnect = null

    // Convert to prefetch structure (same shape as prefetch() creates)
    const pf = { ws: pc.ws, chunks: [], done: false, voiceId: pc.voiceId, model: pc.model }

    // Wire audio buffering handler
    pc.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        if (msg.type === 'audio') {
          pf.chunks.push(msg.data)
        } else if (msg.type === 'done') {
          pf.done = true
        }
      } catch (e) { /* ignore */ }
    }
    pc.ws.onerror = () => {}
    pc.ws.onclose = () => {}

    // Send text — audio generation starts immediately
    pc.ws.send(JSON.stringify({ type: 'text', text, flush: true }))

    this._prefetch = pf
    console.log(`TTSStreamCore: Promoted preconnect to prefetch (${text.length} chars)`)
    return true
  }

  // ============================================
  // INTERNAL METHODS
  // ============================================

  _replayPendingOps() {
    if (this.pendingOps.length === 0) return
    console.log(`TTSStreamCore: Replaying ${this.pendingOps.length} queued operations`)
    const ops = this.pendingOps
    this.pendingOps = []
    for (const op of ops) {
      if (op.type === 'text') {
        this.streamText(op.text)
      } else if (op.type === 'flush') {
        this.flush()
      }
    }
  }

  _emitStateChange() {
    this.onStateChange?.(this.getState())
  }

  _extractChunks() {
    const chunks = []

    // Look for sentence boundaries: . ! ? followed by space/newline or end
    const sentencePattern = /[.!?](?:\s|$)/g
    let lastEnd = 0
    let match

    while ((match = sentencePattern.exec(this.textBuffer)) !== null) {
      const endIndex = match.index + 1
      const chunk = this.textBuffer.slice(lastEnd, endIndex).trim()

      if (chunk.length >= this.minChunkChars) {
        chunks.push(chunk)
        lastEnd = endIndex
      } else if (this.textBuffer.length - lastEnd >= this.minChunkChars * 2) {
        chunks.push(chunk)
        lastEnd = endIndex
      }
    }

    if (lastEnd > 0) {
      this.textBuffer = this.textBuffer.slice(lastEnd).trim()
    }

    return chunks
  }

  _flushBuffer() {
    const text = this.textBuffer.trim()
    if (text.length > 0 && this.ws && this.ws.readyState === WebSocket.OPEN) {
      console.log(`TTSStreamCore: Sending text chunk (${text.length} chars): "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"`)
      this.ws.send(JSON.stringify({ type: 'text', text }))
      this.textBuffer = ''
    }
  }

  _handleAudioChunk(base64Data) {
    // Guard against processing audio during cancel/cleanup transitions
    if (this.isCancelled || !this.audioContext || !this.isPlaying || !this.gainNode) {
      return null
    }

    // Simple duplicate detection - skip if exact same audio chunk received
    const audioHash = base64Data.slice(0, 100) + base64Data.length
    if (audioHash === this.lastAudioHash) {
      console.warn('TTSStreamCore: Skipping duplicate audio chunk')
      return null
    }
    this.lastAudioHash = audioHash

    // Timing diagnostics
    const now = performance.now()
    const timeSinceLastChunk = this.lastChunkTime ? now - this.lastChunkTime : 0
    this.lastChunkTime = now
    this.chunkCount++

    try {
      // Convert PCM to AudioBuffer
      const audioBuffer = pcmToAudioBuffer(
        this.audioContext,
        base64Data,
        this.config.sampleRate
      )

      // Create source and schedule playback
      const source = this.audioContext.createBufferSource()
      source.buffer = audioBuffer
      source.connect(this.gainNode)

      // Schedule gapless playback
      const startTime = Math.max(this.audioContext.currentTime, this.nextStartTime)
      source.start(startTime)

      // Calculate scheduling gap (negative means we're behind)
      const currentTime = this.audioContext.currentTime
      const scheduleGap = startTime - currentTime

      // Log timing diagnostics (warn if gaps detected)
      if (timeSinceLastChunk > 1000) {
        console.warn(`TTSStreamCore: LONG GAP - Chunk #${this.chunkCount} arrived after ${(timeSinceLastChunk/1000).toFixed(1)}s gap`)
      }
      if (scheduleGap < 0.05 && this.chunkCount > 1) {
        console.warn(`TTSStreamCore: AUDIO BEHIND - Chunk #${this.chunkCount} scheduled ${(scheduleGap*1000).toFixed(0)}ms from now (catching up)`)
      }

      // Periodic status log every 10 chunks
      if (this.chunkCount % 10 === 0) {
        console.log(`TTSStreamCore: Chunk #${this.chunkCount} - duration: ${(audioBuffer.duration*1000).toFixed(0)}ms, gap since last: ${timeSinceLastChunk.toFixed(0)}ms, schedule ahead: ${(scheduleGap*1000).toFixed(0)}ms`)
      }

      // Update next start time for seamless audio
      this.nextStartTime = startTime + audioBuffer.duration

      // Track source for cleanup
      this.scheduledSources.push(source)

      // Remove from list when done
      source.onended = () => {
        const idx = this.scheduledSources.indexOf(source)
        if (idx >= 0) {
          this.scheduledSources.splice(idx, 1)
        }
      }

      return startTime
    } catch (err) {
      console.error('TTSStreamCore: Failed to process audio chunk:', err)
      return null
    }
  }

  _handleStreamEnd() {
    // Wait for all scheduled audio to finish before cleanup
    const remainingDuration = Math.max(0, this.nextStartTime - this.audioContext?.currentTime || 0)

    console.log(`TTSStreamCore: Stream ending - ${this.chunkCount} chunks received, ${(remainingDuration).toFixed(1)}s of audio remaining to play`)

    this.streamEndTimer = setTimeout(() => {
      this.streamEndTimer = null
      const wasCancelled = this.isCancelled
      // Preserve prefetch/preconnect across cleanup — they're for the next message, not this one
      const savedPrefetch = this._prefetch
      const savedPreconnect = this._preconnect
      this._prefetch = null
      this._preconnect = null
      // Cleanup BEFORE onEnd so isPlaying=false when the next speak() tries to connect
      this._cleanup()
      this._prefetch = savedPrefetch
      this._preconnect = savedPreconnect
      if (!wasCancelled) {
        console.log('TTSStreamCore: Playback complete')
        this.onEnd?.()
      }
    }, remainingDuration * 1000 + 50) // Add small buffer
  }

  _cleanup() {
    if (this.chunkTimer) {
      clearTimeout(this.chunkTimer)
      this.chunkTimer = null
    }
    if (this.streamEndTimer) {
      clearTimeout(this.streamEndTimer)
      this.streamEndTimer = null
    }

    this.textBuffer = ''
    this.pendingOps = []

    // Close prefetch connection
    if (this._prefetch) {
      try { this._prefetch.ws?.close() } catch (e) { /* ignore */ }
      this._prefetch = null
    }

    // Close preconnect connection
    if (this._preconnect) {
      try { this._preconnect.ws?.close() } catch (e) { /* ignore */ }
      this._preconnect = null
    }

    // Stop all sources
    for (const source of this.scheduledSources) {
      try {
        source.stop()
      } catch (e) {
        // Already stopped
      }
    }
    this.scheduledSources = []

    // Close WebSocket
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }

    // Close AudioContext
    if (this.audioContext) {
      this.audioContext.close()
      this.audioContext = null
    }

    this.gainNode = null
    this.isPlaying = false
    this.isConnecting = false
    this.nextStartTime = 0
    this.lastAudioHash = null

    this._emitStateChange()
  }
}

export default TTSStreamCore
