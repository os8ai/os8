/**
 * Voice Input Module for OS8 Shell
 *
 * Thin wrapper around VoiceStreamCore for the OS8 shell (terminal, etc.)
 * Provides backwards-compatible API and batch mode fallback.
 */

import { VoiceStreamCore } from '../shared/voice-stream-core.js'

// Singleton instance for the shell
let voiceCore = null
let callbacks = {}

// Batch mode state (fallback when streaming unavailable)
let mediaRecorder = null
let audioChunks = []
let batchStream = null
let isListening = false
let isTranscribing = false
let batchRecordingTime = 0
let batchRecordingTimer = null

// Settings loaded from IPC
let settingsLoaded = false

/**
 * Load voice settings from main process
 */
async function loadSettings() {
  if (settingsLoaded) return
  try {
    const settings = await window.os8.voice.getSettings()
    if (voiceCore && settings) {
      voiceCore.configure(settings)
    }
    settingsLoaded = true
  } catch (err) {
    console.warn('Failed to load voice settings:', err)
  }
}

/**
 * Get or create the voice core instance
 */
function getVoiceCore() {
  if (!voiceCore) {
    voiceCore = new VoiceStreamCore()

    // Load settings asynchronously
    loadSettings()

    // Wire up callbacks
    voiceCore.onTranscript = (text) => {
      callbacks.onTranscript?.(text)
    }

    voiceCore.onAutoSend = (text) => {
      callbacks.onResult?.(text, true)
    }

    voiceCore.onError = (error) => {
      callbacks.onError?.(error)
    }

    voiceCore.onStateChange = (state) => {
      callbacks.onStateChange?.({
        isListening: state.isStreaming,
        isStreaming: state.isStreaming,
        isConnecting: state.isConnecting,
        isTranscribing: false,
        recordingTime: state.recordingTime,
        mode: state.mode,
        committedText: state.committedText,
        unstableText: state.unstableText
      })
    }
  }
  return voiceCore
}

/**
 * Update voice core configuration (called when settings change)
 */
export function configure(config) {
  getVoiceCore().configure(config)
}

/**
 * Check if voice input is supported
 */
export function isSupported() {
  return typeof MediaRecorder !== 'undefined' &&
    navigator?.mediaDevices?.getUserMedia
}

/**
 * Check if streaming is supported
 */
export function isStreamingSupported() {
  return VoiceStreamCore.isSupported()
}

/**
 * Get current state
 */
export function getState() {
  const core = getVoiceCore()
  const state = core.getState()
  return {
    isListening: isListening || state.isStreaming,
    isTranscribing,
    isStreaming: state.isStreaming,
    isConnecting: state.isConnecting,
    recordingTime: state.isStreaming ? state.recordingTime : batchRecordingTime,
    mode: state.mode,
    committedText: state.committedText,
    unstableText: state.unstableText
  }
}

/**
 * Get streaming state
 */
export function getStreamingState() {
  const state = getVoiceCore().getState()
  return {
    isStreaming: state.isStreaming,
    isConnecting: state.isConnecting,
    committedText: state.committedText,
    unstableText: state.unstableText,
    recordingTime: state.recordingTime
  }
}

/**
 * Check if currently listening (either mode)
 */
export function getIsListening() {
  return isListening || getVoiceCore().getState().isStreaming
}

/**
 * Check if currently transcribing
 */
export function getIsTranscribing() {
  return isTranscribing || getVoiceCore().getState().isConnecting
}

// ============================================
// STREAMING MODE
// ============================================

/**
 * Start streaming in one-shot mode
 */
export async function startOneShot(options = {}) {
  callbacks = options
  return getVoiceCore().startOneShot()
}

/**
 * Start streaming in continuous mode
 */
export async function startContinuous(options = {}) {
  callbacks = options
  return getVoiceCore().startContinuous()
}

/**
 * Start streaming (one-shot mode, backwards compatible)
 */
export async function startStreaming(options = {}) {
  callbacks = options
  return getVoiceCore().startOneShot()
}

/**
 * Stop streaming
 */
export function stopStreaming() {
  getVoiceCore().stop()
}

/**
 * Cancel streaming (no send)
 */
export function cancelStreaming() {
  getVoiceCore().cancel()
}

// ============================================
// BATCH MODE (fallback)
// ============================================

/**
 * Start batch recording
 */
export async function startListening(options = {}) {
  if (!isSupported()) {
    options.onError?.('Voice input not supported')
    return false
  }

  if (isListening || isTranscribing) {
    stopListening()
    return false
  }

  callbacks = options

  try {
    batchStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, sampleRate: 16000 }
    })

    const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4'
    mediaRecorder = new MediaRecorder(batchStream, { mimeType })
    audioChunks = []

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data)
    }

    mediaRecorder.onstop = async () => {
      clearInterval(batchRecordingTimer)
      isListening = false
      batchRecordingTime = 0

      if (batchStream) {
        batchStream.getTracks().forEach(t => t.stop())
        batchStream = null
      }

      const blob = new Blob(audioChunks, { type: mimeType })
      audioChunks = []

      if (blob.size < 1000) {
        callbacks.onStateChange?.({ isListening: false, isTranscribing: false })
        return
      }

      isTranscribing = true
      callbacks.onStateChange?.({ isListening: false, isTranscribing: true })

      try {
        const buffer = await blob.arrayBuffer()
        const result = await window.os8.voice.transcribe(buffer, mimeType, 'en')

        if (result.error) throw new Error(result.error)

        if (result.text?.trim()) {
          callbacks.onResult?.(result.text.trim())
        }
      } catch (err) {
        callbacks.onError?.(err.message)
      } finally {
        isTranscribing = false
        callbacks.onStateChange?.({ isListening: false, isTranscribing: false })
      }
    }

    mediaRecorder.onerror = (e) => {
      isListening = false
      callbacks.onError?.(e.error?.name || 'Recording error')
    }

    mediaRecorder.start(1000)
    isListening = true
    batchRecordingTime = 0
    batchRecordingTimer = setInterval(() => {
      batchRecordingTime++
      callbacks.onStateChange?.({ isListening: true, isTranscribing: false, recordingTime: batchRecordingTime })
    }, 1000)

    callbacks.onStateChange?.({ isListening: true, isTranscribing: false, recordingTime: 0 })
    return true

  } catch (err) {
    if (err.name === 'NotAllowedError') {
      callbacks.onError?.('Microphone permission denied')
    } else {
      callbacks.onError?.(err.message)
    }
    return false
  }
}

/**
 * Stop batch recording
 */
export function stopListening() {
  if (mediaRecorder?.state !== 'inactive') {
    mediaRecorder?.stop()
  }
}

/**
 * Toggle batch listening
 */
export function toggleListening(options = {}) {
  if (isListening) {
    stopListening()
    return false
  }
  if (!isTranscribing) {
    startListening(options)
    return true
  }
  return false
}

// ============================================
// UNIFIED TOGGLE
// ============================================

/**
 * Toggle voice input (prefers streaming, falls back to batch)
 */
export function toggle(options = {}) {
  const core = getVoiceCore()
  const state = core.getState()

  // If currently active, stop
  if (state.isStreaming) {
    stopStreaming()
    return false
  }
  if (isListening) {
    stopListening()
    return false
  }

  // If transcribing/connecting, do nothing
  if (isTranscribing || state.isConnecting) return false

  // Try streaming first, fall back to batch
  if (isStreamingSupported()) {
    callbacks = options
    core.startOneShot().catch((err) => {
      console.log('Streaming failed, falling back to batch mode:', err)
      startListening(options)
    })
    return true
  }

  // Batch mode fallback
  startListening(options)
  return true
}

export default {
  isSupported,
  isStreamingSupported,
  configure,
  getState,
  getStreamingState,
  getIsListening,
  getIsTranscribing,
  startListening,
  stopListening,
  toggleListening,
  startStreaming,
  startOneShot,
  startContinuous,
  stopStreaming,
  cancelStreaming,
  toggle
}
