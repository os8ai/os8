/**
 * VoiceStreamCore - Unified voice streaming implementation
 *
 * Single source of truth for all voice streaming in OS8.
 * Used by both the OS8 shell (terminal) and apps (assistant).
 *
 * Features:
 * - Real-time transcription via WebSocket to whisper-stream-server
 * - One-shot mode: stops after sending one message
 * - Continuous mode: stays active, sends multiple messages
 * - Stability commit (prevents jarring text rewrites)
 * - RMS-based silence detection for auto-send
 * - Blank audio filtering ([BLANK_AUDIO], etc.)
 * - Deduplication to prevent double sends
 */

// Default configuration (can be overridden via settings)
const DEFAULT_CONFIG = {
  stabilityMarginChars: 15,
  minWordsNormal: 3,
  silenceDurationNormal: 1800,   // 1.8s - pause before auto-send
  silenceDurationShort: 2500,    // 2.5s - for short messages (<3 words)
  silenceThreshold: 0.01,        // RMS threshold for silence detection
  continuousTimeoutMs: 5 * 60 * 1000, // 5 minutes inactivity timeout
}

// Patterns to filter out (non-speech transcriptions from whisper)
const BLANK_PATTERNS = [
  /^\[.*\]$/,           // Anything in brackets like [BLANK_AUDIO], [MUSIC], [NOISE]
  /^\(.*\)$/,           // Anything in parentheses like (silence), (background noise)
  /^\.+$/,              // Just periods/dots
  /^\s*$/,              // Empty or whitespace only
]

function isBlankTranscription(text) {
  const trimmed = text.trim()
  if (!trimmed) return true
  return BLANK_PATTERNS.some(pattern => pattern.test(trimmed))
}

// AudioWorklet processor code (inlined as Blob to avoid separate file)
const workletCode = `
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(0)
    this.bufferSize = 4800 // ~100ms at 48kHz
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || !input[0]) return true

    const samples = input[0]

    // Accumulate samples
    const newBuffer = new Float32Array(this.buffer.length + samples.length)
    newBuffer.set(this.buffer)
    newBuffer.set(samples, this.buffer.length)
    this.buffer = newBuffer

    // Send when we have enough samples
    if (this.buffer.length >= this.bufferSize) {
      this.port.postMessage({
        type: 'audio',
        samples: this.buffer
      })
      this.buffer = new Float32Array(0)
    }

    return true
  }
}

registerProcessor('pcm-processor', PCMProcessor)
`

/**
 * Simple low-pass filter for anti-aliasing before downsampling
 */
function applyLowPassFilter(samples, windowSize = 3) {
  const filtered = new Float32Array(samples.length)
  const halfWindow = Math.floor(windowSize / 2)

  for (let i = 0; i < samples.length; i++) {
    let sum = 0
    let count = 0
    for (let j = -halfWindow; j <= halfWindow; j++) {
      const idx = i + j
      if (idx >= 0 && idx < samples.length) {
        sum += samples[idx]
        count++
      }
    }
    filtered[i] = sum / count
  }

  return filtered
}

/**
 * Downsample from 48kHz to 16kHz (factor of 3)
 */
function downsample48to16(samples48k) {
  const filtered = applyLowPassFilter(samples48k, 5)
  const samples16k = new Float32Array(Math.floor(filtered.length / 3))
  for (let i = 0; i < samples16k.length; i++) {
    samples16k[i] = filtered[i * 3]
  }
  return samples16k
}

/**
 * Convert Float32 (-1 to 1) to Int16 PCM (-32768 to 32767)
 */
function float32ToInt16(float32Array) {
  const int16Array = new Int16Array(float32Array.length)
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]))
    int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
  }
  return int16Array
}

/**
 * Calculate RMS (root mean square) energy of audio samples
 */
function calculateRMS(samples) {
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i]
  }
  return Math.sqrt(sum / samples.length)
}

/**
 * Find last word boundary at or before index
 */
function findLastWordBoundary(text, maxIndex) {
  for (let i = Math.min(maxIndex, text.length - 1); i >= 0; i--) {
    if (text[i] === ' ') {
      return i + 1
    }
  }
  return 0
}

/**
 * Normalize text for comparison
 */
function normalizeText(text) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/['']/g, "'")
    .replace(/[""]/g, '"')
    .trim()
}

/**
 * VoiceStreamCore class - the unified voice streaming implementation
 */
export class VoiceStreamCore {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }

    // State
    this.isStreaming = false
    this.isConnecting = false
    this.mode = 'idle' // 'idle' | 'oneshot' | 'continuous'
    this.recordingTime = 0
    this.committedText = ''
    this.unstableText = ''

    // Internal refs
    this.ws = null
    this.audioContext = null
    this.workletNode = null
    this.mediaStream = null
    this.recordingTimer = null
    this.silenceStart = null
    this.previousTranscript = ''
    this.continuousTimeout = null
    this.hasSentForUtterance = false

    // Callbacks
    this.onTranscript = null    // (text) => void - called with live transcript
    this.onAutoSend = null      // (text) => void - called when message should be sent
    this.onError = null         // (error) => void - called on errors
    this.onStateChange = null   // (state) => void - called when state changes
  }

  /**
   * Check if streaming is supported in this browser
   */
  static isSupported() {
    return typeof AudioContext !== 'undefined' &&
      typeof AudioWorkletNode !== 'undefined' &&
      navigator?.mediaDevices?.getUserMedia
  }

  /**
   * Update configuration
   */
  configure(config) {
    this.config = { ...this.config, ...config }
  }

  /**
   * Get current state
   */
  getState() {
    return {
      isStreaming: this.isStreaming,
      isConnecting: this.isConnecting,
      mode: this.mode,
      recordingTime: this.recordingTime,
      committedText: this.committedText,
      unstableText: this.unstableText,
      fullText: (this.committedText + this.unstableText).trim()
    }
  }

  /**
   * Start in one-shot mode (stops after sending one message)
   */
  async startOneShot() {
    this.mode = 'oneshot'
    return this._startStreaming()
  }

  /**
   * Start in continuous mode (stays active, sends multiple messages)
   */
  async startContinuous() {
    this.mode = 'continuous'
    this._resetContinuousTimeout()
    return this._startStreaming()
  }

  /**
   * Stop streaming (sends any pending text first)
   */
  stop() {
    const fullText = (this.committedText + this.unstableText).trim()
    if (fullText && !isBlankTranscription(fullText)) {
      this.onAutoSend?.(fullText)
    }
    this._cleanup()
  }

  /**
   * Cancel streaming (doesn't send pending text)
   */
  cancel() {
    this._cleanup()
  }

  // ============================================
  // INTERNAL METHODS
  // ============================================

  _emitStateChange() {
    this.onStateChange?.(this.getState())
  }

  _resetContinuousTimeout() {
    if (this.continuousTimeout) {
      clearTimeout(this.continuousTimeout)
    }
    this.continuousTimeout = setTimeout(() => {
      console.log('VoiceStreamCore: Continuous mode timeout - stopping')
      this._cleanup()
    }, this.config.continuousTimeoutMs)
  }

  _resetTranscriptState() {
    this.committedText = ''
    this.unstableText = ''
    this.previousTranscript = ''
    this.silenceStart = null
    // Note: hasSentForUtterance is reset when new speech is detected, not here

    // Reset recording time for new utterance
    this.recordingTime = 0
    if (this.recordingTimer) {
      clearInterval(this.recordingTimer)
    }
    this.recordingTimer = setInterval(() => {
      this.recordingTime++
      this._emitStateChange()
    }, 1000)

    this._emitStateChange()
  }

  _processPartial(newText) {
    const normalizedNew = normalizeText(newText)
    const normalizedPrev = normalizeText(this.previousTranscript)

    // Find stable prefix
    let stableLength = 0
    const minLength = Math.min(normalizedPrev.length, normalizedNew.length)
    for (let i = 0; i < minLength; i++) {
      if (normalizedPrev[i] === normalizedNew[i]) {
        stableLength = i + 1
      } else {
        break
      }
    }

    // Safety margin, then find word boundary
    const safeIndex = Math.max(0, stableLength - this.config.stabilityMarginChars)
    const commitIndex = findLastWordBoundary(newText, safeIndex)
    const newCommitted = newText.slice(0, commitIndex)

    // Only grow committed text
    if (newCommitted.length > this.committedText.length) {
      this.committedText = newCommitted
    }

    this.unstableText = newText.slice(this.committedText.length)
    this.previousTranscript = newText

    // Notify of current transcript
    this.onTranscript?.(this.committedText + this.unstableText)
    this._emitStateChange()
  }

  _checkSilenceAndSend(rms) {
    const fullText = (this.committedText + this.unstableText).trim()
    const wordCount = fullText.split(/\s+/).filter(w => w).length

    if (rms < this.config.silenceThreshold) {
      if (!this.silenceStart) {
        this.silenceStart = Date.now()
      }

      const silenceDuration = Date.now() - this.silenceStart
      const requiredSilence = wordCount < this.config.minWordsNormal
        ? this.config.silenceDurationShort
        : this.config.silenceDurationNormal

      if (silenceDuration >= requiredSilence && fullText.length > 0) {
        // Filter out blank/noise transcriptions
        if (isBlankTranscription(fullText)) {
          if (this.mode === 'continuous') {
            this._resetTranscriptState()
            this._resetContinuousTimeout()
          }
          return false
        }

        // Prevent duplicate sends
        if (this.hasSentForUtterance) {
          return false
        }
        this.hasSentForUtterance = true

        // Auto-send
        this.onAutoSend?.(fullText)

        if (this.mode === 'continuous') {
          this._resetTranscriptState()
          this._resetContinuousTimeout()
          return true
        } else {
          this._cleanup()
          return true
        }
      }
    } else {
      this.silenceStart = null
      // New speech detected - reset the sent flag
      this.hasSentForUtterance = false
      // Reset continuous timeout on speech activity
      if (this.mode === 'continuous') {
        this._resetContinuousTimeout()
      }
    }

    return false
  }

  _handleFinalMessage(finalText) {
    if (!finalText) return

    // Filter out blank/noise transcriptions
    if (isBlankTranscription(finalText)) {
      if (this.mode === 'continuous') {
        this._resetTranscriptState()
        this._resetContinuousTimeout()
      }
      return
    }

    // Prevent duplicate sends
    if (this.hasSentForUtterance) {
      if (this.mode === 'continuous') {
        this._resetTranscriptState()
        this._resetContinuousTimeout()
      }
      return
    }
    this.hasSentForUtterance = true

    this.onAutoSend?.(finalText)

    if (this.mode === 'continuous') {
      this._resetTranscriptState()
      this._resetContinuousTimeout()
    } else {
      this._cleanup()
    }
  }

  async _startStreaming() {
    if (!VoiceStreamCore.isSupported() || this.isStreaming || this.isConnecting) {
      return false
    }

    this.isConnecting = true
    this._emitStateChange()

    try {
      // Get WebSocket URL
      const port = window.location.port || '8888'
      const wsUrl = `ws://localhost:${port}/api/voice/stream`

      // Connect to WebSocket
      this.ws = new WebSocket(wsUrl)

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('WebSocket connection timeout'))
        }, 5000)

        this.ws.onopen = () => {
          clearTimeout(timeout)
          console.log('VoiceStreamCore: WebSocket connected')
        }

        this.ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data)
            if (msg.type === 'ready') {
              console.log('VoiceStreamCore: Server ready')
              resolve()
            } else if (msg.type === 'partial') {
              this._processPartial(msg.text || '')
            } else if (msg.type === 'final') {
              this._handleFinalMessage((msg.text || '').trim())
            } else if (msg.type === 'error') {
              console.error('VoiceStreamCore: Server error:', msg.message)
              this.onError?.(msg.message)
            }
          } catch (e) {
            console.error('VoiceStreamCore: Failed to parse message:', e)
          }
        }

        this.ws.onerror = () => {
          clearTimeout(timeout)
          reject(new Error('WebSocket error'))
        }

        this.ws.onclose = () => {
          if (this.isStreaming) {
            console.log('VoiceStreamCore: Connection closed')
            this._cleanup()
          }
        }
      })

      // Get microphone access
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 48000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      })

      // Create AudioContext
      this.audioContext = new AudioContext({ sampleRate: 48000 })

      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume()
      }

      // Create AudioWorklet from inline code
      const blob = new Blob([workletCode], { type: 'application/javascript' })
      const workletUrl = URL.createObjectURL(blob)
      await this.audioContext.audioWorklet.addModule(workletUrl)
      URL.revokeObjectURL(workletUrl)

      // Create worklet node
      this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-processor')

      // Handle audio from worklet
      this.workletNode.port.onmessage = (event) => {
        if (event.data.type === 'audio' && this.ws?.readyState === WebSocket.OPEN) {
          const samples48k = event.data.samples

          // Calculate RMS for silence detection
          const rms = calculateRMS(samples48k)

          // Check for auto-send on silence
          if (this._checkSilenceAndSend(rms)) {
            return
          }

          // Downsample 48kHz -> 16kHz
          const samples16k = downsample48to16(samples48k)

          // Convert to Int16 PCM
          const pcm16 = float32ToInt16(samples16k)

          // Send as binary
          this.ws.send(pcm16.buffer)
        }
      }

      // Connect audio graph
      const source = this.audioContext.createMediaStreamSource(this.mediaStream)
      source.connect(this.workletNode)

      // Start recording timer
      this.recordingTime = 0
      this.recordingTimer = setInterval(() => {
        this.recordingTime++
        this._emitStateChange()
      }, 1000)

      this.isStreaming = true
      this.isConnecting = false
      this._emitStateChange()

      return true

    } catch (err) {
      console.error('VoiceStreamCore: Failed to start:', err)
      this._cleanup()

      if (err.name === 'NotAllowedError') {
        this.onError?.('Microphone permission denied')
      } else {
        this.onError?.(err.message || 'Failed to start voice streaming')
      }

      return false
    }
  }

  _cleanup() {
    if (this.recordingTimer) {
      clearInterval(this.recordingTimer)
      this.recordingTimer = null
    }

    if (this.continuousTimeout) {
      clearTimeout(this.continuousTimeout)
      this.continuousTimeout = null
    }

    if (this.workletNode) {
      this.workletNode.disconnect()
      this.workletNode = null
    }

    if (this.audioContext) {
      this.audioContext.close()
      this.audioContext = null
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop())
      this.mediaStream = null
    }

    if (this.ws) {
      this.ws.close()
      this.ws = null
    }

    this.isStreaming = false
    this.isConnecting = false
    this.mode = 'idle'
    this.recordingTime = 0
    this.committedText = ''
    this.unstableText = ''
    this.silenceStart = null
    this.previousTranscript = ''
    this.hasSentForUtterance = false

    this._emitStateChange()
  }
}

export default VoiceStreamCore
