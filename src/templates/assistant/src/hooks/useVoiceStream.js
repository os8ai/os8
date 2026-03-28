import { useState, useCallback, useRef, useEffect } from 'react'

/**
 * React hook wrapper around VoiceStreamCore.
 * Loads VoiceStreamCore from /shared/ route via script injection.
 */

// Shared constants (must match src/shared/voice-click-handler.js)
export const DOUBLE_CLICK_THRESHOLD = 300
export const RECENTLY_STOPPED_GRACE_PERIOD = 500

// Cache for loaded VoiceStreamCore
let VoiceStreamCoreClass = null
let loadPromise = null

async function loadVoiceStreamCore() {
  if (VoiceStreamCoreClass) return VoiceStreamCoreClass
  if (loadPromise) return loadPromise

  loadPromise = new Promise(async (resolve, reject) => {
    try {
      const port = window.location.port || '8888'
      const response = await fetch(`http://localhost:${port}/shared/voice-stream-core.js`)
      if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`)

      const code = await response.text()

      // Create a module-like environment
      const exports = {}
      const moduleCode = code
        .replace(/export\s+class\s+VoiceStreamCore/, 'const VoiceStreamCore = class')
        .replace(/export\s+default\s+VoiceStreamCore/, '')
        .replace(/export\s+\{[^}]*\}/, '')

      // Execute the code
      const fn = new Function('exports', moduleCode + '\nexports.VoiceStreamCore = VoiceStreamCore;')
      fn(exports)

      VoiceStreamCoreClass = exports.VoiceStreamCore
      resolve(VoiceStreamCoreClass)
    } catch (err) {
      console.error('Failed to load VoiceStreamCore:', err)
      loadPromise = null
      reject(err)
    }
  })

  return loadPromise
}

export function useVoiceStream({ onTranscript, onAutoSend, onError } = {}) {
  const [state, setState] = useState({
    isStreaming: false,
    isConnecting: false,
    mode: 'idle',
    recordingTime: 0,
    committedText: '',
    unstableText: ''
  })
  const [coreReady, setCoreReady] = useState(false)
  const [loadError, setLoadError] = useState(null)

  const coreRef = useRef(null)
  const callbacksRef = useRef({ onTranscript, onAutoSend, onError })

  useEffect(() => {
    callbacksRef.current = { onTranscript, onAutoSend, onError }
  }, [onTranscript, onAutoSend, onError])

  // Load voice settings helper
  const loadVoiceSettings = useCallback(async () => {
    if (!coreRef.current) return
    try {
      const port = window.location.port || '8888'
      const response = await fetch(`http://localhost:${port}/api/voice/settings`)
      if (response.ok) {
        const settings = await response.json()
        coreRef.current.configure(settings)
      }
    } catch (err) {
      console.warn('Failed to load voice settings:', err)
    }
  }, [])

  // Initialize VoiceStreamCore
  useEffect(() => {
    let mounted = true

    const initCore = async () => {
      try {
        const VoiceStreamCore = await loadVoiceStreamCore()

        if (!mounted) return

        const core = new VoiceStreamCore()
        coreRef.current = core

        // Load settings
        try {
          const port = window.location.port || '8888'
          const response = await fetch(`http://localhost:${port}/api/voice/settings`)
          if (response.ok) {
            const settings = await response.json()
            core.configure(settings)
          }
        } catch (err) {
          console.warn('Failed to load voice settings:', err)
        }

        // Wire callbacks
        core.onTranscript = (text) => callbacksRef.current.onTranscript?.(text)
        core.onAutoSend = (text) => callbacksRef.current.onAutoSend?.(text)
        core.onError = (error) => callbacksRef.current.onError?.(error)
        core.onStateChange = (newState) => {
          if (mounted) setState(newState)
        }

        setCoreReady(true)
      } catch (err) {
        console.error('Failed to initialize VoiceStreamCore:', err)
        setLoadError(err.message)
        callbacksRef.current.onError?.('Failed to load voice module')
      }
    }

    initCore()

    return () => {
      mounted = false
      coreRef.current?.cancel()
    }
  }, [])

  // Re-fetch settings when tab becomes visible (picks up settings changes)
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        loadVoiceSettings()
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [loadVoiceSettings])

  const isSupported = typeof AudioContext !== 'undefined' &&
    typeof AudioWorkletNode !== 'undefined' &&
    navigator?.mediaDevices?.getUserMedia

  const startOneShot = useCallback(async () => {
    if (!coreRef.current) return false
    return coreRef.current.startOneShot()
  }, [])

  const startContinuous = useCallback(async () => {
    if (!coreRef.current) return false
    return coreRef.current.startContinuous()
  }, [])

  const stopStreaming = useCallback(() => {
    coreRef.current?.stop()
  }, [])

  const toggleStreaming = useCallback(() => {
    if (state.isStreaming) {
      stopStreaming()
      return false
    }
    if (!state.isConnecting && coreRef.current) {
      startOneShot()
      return true
    }
    return false
  }, [state.isStreaming, state.isConnecting, startOneShot, stopStreaming])

  return {
    isStreaming: state.isStreaming,
    isConnecting: state.isConnecting,
    committedText: state.committedText,
    unstableText: state.unstableText,
    recordingTime: state.recordingTime,
    isSupported: isSupported && coreReady,
    mode: state.mode,
    loadError,
    startStreaming: startOneShot,
    stopStreaming,
    startOneShot,
    startContinuous,
    toggleStreaming
  }
}

export default useVoiceStream
