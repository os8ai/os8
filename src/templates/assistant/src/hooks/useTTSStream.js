import { useState, useCallback, useRef, useEffect } from 'react'

/**
 * React hook wrapper around TTSStreamCore.
 * Loads TTSStreamCore from /shared/ route via fetch.
 */

// Cache for loaded TTSStreamCore
let TTSStreamCoreClass = null
let loadPromise = null

async function loadTTSStreamCore() {
  if (TTSStreamCoreClass) return TTSStreamCoreClass
  if (loadPromise) return loadPromise

  loadPromise = new Promise(async (resolve, reject) => {
    try {
      const port = window.location.port || '8888'
      const response = await fetch(`http://localhost:${port}/shared/tts-stream-core.js`)
      if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`)

      const code = await response.text()

      // Create a module-like environment
      const exports = {}
      const moduleCode = code
        .replace(/export\s+class\s+TTSStreamCore/, 'const TTSStreamCore = class')
        .replace(/export\s+default\s+TTSStreamCore/, '')
        .replace(/export\s+\{[^}]*\}/, '')

      // Execute the code
      const fn = new Function('exports', moduleCode + '\nexports.TTSStreamCore = TTSStreamCore;')
      fn(exports)

      TTSStreamCoreClass = exports.TTSStreamCore
      resolve(TTSStreamCoreClass)
    } catch (err) {
      console.error('Failed to load TTSStreamCore:', err)
      loadPromise = null
      reject(err)
    }
  })

  return loadPromise
}

export function useTTSStream({ onStart, onEnd, onError } = {}) {
  const [state, setState] = useState({
    isPlaying: false,
    isConnecting: false,
    isCancelled: false
  })
  const [coreReady, setCoreReady] = useState(false)
  const [loadError, setLoadError] = useState(null)
  const [settings, setSettings] = useState(null)

  const coreRef = useRef(null)
  const callbacksRef = useRef({ onStart, onEnd, onError })

  useEffect(() => {
    callbacksRef.current = { onStart, onEnd, onError }
  }, [onStart, onEnd, onError])

  // Load TTS settings helper
  const loadTTSSettings = useCallback(async () => {
    try {
      const port = window.location.port || '8888'
      const response = await fetch(`http://localhost:${port}/api/voice/tts-settings`)
      if (response.ok) {
        const ttsSettings = await response.json()
        setSettings(ttsSettings)
      }
    } catch (err) {
      console.warn('Failed to load TTS settings:', err)
    }
  }, [])

  // Initialize TTSStreamCore
  useEffect(() => {
    let mounted = true

    const initCore = async () => {
      try {
        const TTSStreamCore = await loadTTSStreamCore()

        if (!mounted) return

        const core = new TTSStreamCore()
        coreRef.current = core

        // Load TTS settings
        try {
          const port = window.location.port || '8888'
          const response = await fetch(`http://localhost:${port}/api/voice/tts-settings`)
          if (response.ok) {
            const ttsSettings = await response.json()
            setSettings(ttsSettings)
          }
        } catch (err) {
          console.warn('Failed to load TTS settings:', err)
        }

        // Wire callbacks
        core.onStart = () => callbacksRef.current.onStart?.()
        core.onEnd = () => callbacksRef.current.onEnd?.()
        core.onError = (error, meta) => callbacksRef.current.onError?.(error, meta)
        core.onStateChange = (newState) => {
          if (mounted) setState(newState)
        }

        setCoreReady(true)
      } catch (err) {
        console.error('Failed to initialize TTSStreamCore:', err)
        setLoadError(err.message)
        callbacksRef.current.onError?.('Failed to load TTS module')
      }
    }

    initCore()

    return () => {
      mounted = false
      coreRef.current?.cancel()
    }
  }, [])

  // Re-fetch settings when tab becomes visible or provider changes
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        loadTTSSettings()
      }
    }
    const handleProviderChanged = () => {
      // Cancel any active playback since the provider changed
      coreRef.current?.cancel()
      loadTTSSettings()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('tts-provider-changed', handleProviderChanged)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('tts-provider-changed', handleProviderChanged)
    }
  }, [loadTTSSettings])

  const isSupported = typeof AudioContext !== 'undefined' && typeof WebSocket !== 'undefined'

  /**
   * Connect to TTS stream (call before streamText)
   */
  const connect = useCallback(async (options = {}) => {
    if (!coreRef.current) return false
    return coreRef.current.connect({
      voiceId: settings?.voiceId,
      model: settings?.model,
      ...options
    })
  }, [settings])

  /**
   * Stream text chunk to be spoken
   */
  const streamText = useCallback((text) => {
    coreRef.current?.streamText(text)
  }, [])

  /**
   * Signal end of text input
   */
  const flush = useCallback(() => {
    coreRef.current?.flush()
  }, [])

  /**
   * Cancel current speech with fade-out
   */
  const cancel = useCallback(() => {
    coreRef.current?.cancel()
  }, [])

  /**
   * One-shot: speak complete text
   */
  const speak = useCallback(async (text, options = {}) => {
    if (!coreRef.current) return false
    return coreRef.current.speak(text, {
      voiceId: settings?.voiceId,
      model: settings?.model,
      ...options
    })
  }, [settings])

  /**
   * Prefetch: generate audio for next message while current plays (near-zero gap)
   */
  const prefetch = useCallback(async (text, options = {}) => {
    if (!coreRef.current) return false
    return coreRef.current.prefetch(text, {
      model: settings?.model,
      ...options
    })
  }, [settings])

  /**
   * Preconnect: open TTS WebSocket and complete handshake without sending text.
   * Saves ~200-500ms cold-start when the first agent message arrives.
   */
  const preconnect = useCallback(async (options = {}) => {
    if (!coreRef.current) return false
    return coreRef.current.preconnect({
      model: settings?.model,
      ...options
    })
  }, [settings])

  /**
   * Promote a preconnect into a prefetch by sending text into the idle WebSocket.
   */
  const promoteToPrefetch = useCallback((text, options = {}) => {
    if (!coreRef.current) return false
    return coreRef.current.promoteToPrefetch(text, options)
  }, [])

  return {
    isPlaying: state.isPlaying,
    isConnecting: state.isConnecting,
    isCancelled: state.isCancelled,
    isSupported: isSupported && coreReady,
    settings,
    loadError,
    connect,
    streamText,
    flush,
    cancel,
    speak,
    prefetch,
    preconnect,
    promoteToPrefetch
  }
}

export default useTTSStream
