import { useState, useRef, useEffect, useCallback } from 'react'
import AgentAvatar, { useAgentStatus } from './AgentAvatar'
import { useVoiceStream } from '../hooks/useVoiceStream'
import { useVoiceInput } from '../hooks/useVoiceInput'
import { useTTSStream } from '../hooks/useTTSStream'

// Note: useStreamingMode prefers real-time streaming when available,
// falls back to batch transcription if streaming server unavailable

// Voice click handling constants (shared with terminal)
const DOUBLE_CLICK_THRESHOLD = 300 // ms
const RECENTLY_STOPPED_GRACE_PERIOD = 500 // ms - grace period after stopping

const REACTIONS = [
  { key: 'heart', emoji: '❤️' },
  { key: 'thumbs-up', emoji: '👍' },
  { key: 'haha', emoji: '😂' },
]

/** Step progress line for tool execution */
function StepLine({ step }) {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (step.completed) return
    const start = step.startedAt
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [step.completed, step.startedAt])

  const durationStr = step.completed
    ? `${(step.durationMs / 1000).toFixed(1)}s`
    : elapsed > 0 ? `${elapsed}s` : ''

  return (
    <div className="flex items-center gap-1.5 text-[11px] text-gray-500">
      {step.completed ? (
        <span className="text-green-500">✓</span>
      ) : (
        <span className="text-blue-400 animate-pulse">●</span>
      )}
      <span className={step.completed ? 'text-gray-600' : 'text-gray-400'}>
        {step.label}
      </span>
      {durationStr && (
        <span className="text-gray-600 tabular-nums ml-auto">{durationStr}</span>
      )}
    </div>
  )
}

function Chat({ assistantName, ownerName, agentApiBase, baseApiUrl, selectedAgentId, config, onBackendError, onConfigChanged, onMessageComplete }) {
  // Agent API base - use prop if provided, otherwise derive from URL or fallback to legacy
  const apiBase = agentApiBase || (() => {
    const currentPort = window.location.port || '8888'
    const pathParts = window.location.pathname.split('/').filter(Boolean)
    const appId = pathParts[0]
    if (appId) return `http://localhost:${currentPort}/api/agent/${appId}`
    return `http://localhost:${currentPort}/api/assistant`
  })()

  // Messages loaded from server history API
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [activeSteps, setActiveSteps] = useState([])  // Tool execution steps (Claude)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const loadingStartRef = useRef(null)
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const prevAgentIdRef = useRef(selectedAgentId)
  const [activeReactionPicker, setActiveReactionPicker] = useState(null)
  const [buildProposal, setBuildProposal] = useState(null)
  const [proposalChangesText, setProposalChangesText] = useState('')
  const [proposalStatus, setProposalStatus] = useState(null) // 'approved' | 'changes' | 'rejected'
  const skipNextDoneRef = useRef(false)

  // File attachments
  const [pendingAttachments, setPendingAttachments] = useState([])
  const fileInputRef = useRef(null)

  // Activity tracking for smart timeout
  const [lastActivityTime, setLastActivityTime] = useState(Date.now())
  const lastActivityRef = useRef(Date.now()) // Ref for EventSource access

  // TTS state
  const [ttsEnabled, setTtsEnabled] = useState(false)
  const [ttsSettings, setTtsSettings] = useState(null)
  const [ttsReady, setTtsReady] = useState(false)
  const [ttsNudge, setTtsNudge] = useState(null)
  const [ttsSettingsLoaded, setTtsSettingsLoaded] = useState(false) // Track if settings have loaded
  const ttsTextBufferRef = useRef('') // Buffer text until TTS is ready
  const ttsNeedsConnectionRef = useRef(false) // Flag to connect on first text
  const ttsStreamDoneRef = useRef(false) // Track if text stream is complete (for delayed flush)

  const messagesEndRef = useRef(null)
  const inputRef = useRef(null)

  // Voice input with auto-send after transcription
  const sendMessageRef = useRef(null) // Will be set after sendMessage is defined
  const [useStreamingMode, setUseStreamingMode] = useState(true) // Prefer streaming

  // Double-click detection for continuous mode
  const lastClickTimeRef = useRef(0)
  const lastStopTimeRef = useRef(0) // Track when we last stopped (to prevent accidental restart)
  const isStreamingRef = useRef(false) // Ref to avoid stale closure in click handler
  const isConnectingRef = useRef(false) // Also track connecting state for race condition

  // Real-time streaming voice (preferred)
  const {
    isStreaming,
    isConnecting,
    committedText,
    unstableText,
    recordingTime: streamRecordingTime,
    isSupported: streamSupported,
    mode: voiceMode,
    startOneShot,
    startContinuous,
    stopStreaming: stopVoiceStreaming
  } = useVoiceStream({
    onTranscript: (text) => {
      // Update input field with current transcript
      setInput(text)
    },
    onAutoSend: (text) => {
      setInput('')
      if (text && sendMessageRef.current) {
        sendMessageRef.current(text)
      }
    },
    onError: (error) => {
      console.error('Voice stream error:', error)
      // Fall back to batch mode on error
      setUseStreamingMode(false)
    }
  })

  // Batch voice input (fallback)
  const {
    isListening,
    isTranscribing,
    recordingTime: batchRecordingTime,
    isSupported: batchSupported,
    toggleListening
  } = useVoiceInput({
    onInterimTranscript: (text) => {
      // Show transcription status in input
      setInput(text)
    },
    onAutoSend: (text) => {
      // Auto-send after transcription completes
      setInput('') // Clear the "Transcribing..." text
      if (text && sendMessageRef.current) {
        sendMessageRef.current(text)
      }
    },
    onError: (error) => {
      console.error('Voice input error:', error)
      setInput('')
    }
  })

  // Determine which mode to use
  const voiceSupported = streamSupported || batchSupported
  const isVoiceActive = isStreaming || isConnecting || isListening || isTranscribing
  const recordingTime = isStreaming ? streamRecordingTime : batchRecordingTime

  // Keep refs in sync with state to avoid stale closures
  useEffect(() => {
    isStreamingRef.current = isStreaming
    isConnectingRef.current = isConnecting
  }, [isStreaming, isConnecting])

  // Load TTS settings
  useEffect(() => {
    const loadTTSSettings = async () => {
      try {
        const port = window.location.port || '8888'
        const response = await fetch(`http://localhost:${port}/api/voice/tts-settings`)
        if (response.ok) {
          const settings = await response.json()
          setTtsEnabled(settings.enabled)
          setTtsSettings(settings)
        }
      } catch (err) {
        console.warn('Failed to load TTS settings:', err)
      } finally {
        // Always mark settings as loaded, even on error (enabled will be false)
        setTtsSettingsLoaded(true)
      }
    }
    loadTTSSettings()

    // Re-fetch when tab becomes visible (picks up settings changes)
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        loadTTSSettings()
      }
    }
    // Listen for in-app settings changes from SettingsPanel
    const handleTtsChanged = (e) => {
      const settings = e.detail
      if (settings) {
        setTtsEnabled(settings.enabled)
        setTtsSettings(settings)
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('tts-settings-changed', handleTtsChanged)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('tts-settings-changed', handleTtsChanged)
    }
  }, [])

  // Auto-dismiss TTS nudge after 10 seconds
  useEffect(() => {
    if (!ttsNudge) return
    const timer = setTimeout(() => setTtsNudge(null), 10000)
    return () => clearTimeout(timer)
  }, [ttsNudge])

  // TTS streaming hook
  const {
    isPlaying: isTTSPlaying,
    isConnecting: isTTSConnecting,
    isSupported: ttsSupported,
    connect: connectTTS,
    streamText: ttsStreamText,
    flush: ttsFlush,
    cancel: ttsCancel
  } = useTTSStream({
    onStart: async () => {
      console.log('TTS started')
      setTtsReady(true)
      setTtsNudge(null)
      // Flush any buffered text
      if (ttsTextBufferRef.current) {
        console.log('TTS: Flushing buffered text:', ttsTextBufferRef.current.substring(0, 50))
        ttsStreamText(ttsTextBufferRef.current)
        ttsTextBufferRef.current = ''
      }
      // If stream already finished while we were connecting, flush now
      if (ttsStreamDoneRef.current) {
        console.log('TTS: Stream was done, flushing now')
        ttsFlush()
        ttsStreamDoneRef.current = false
      }
    },
    onEnd: () => {
      console.log('TTS finished')
      setTtsReady(false)
    },
    onError: (error, meta) => {
      console.error('TTS error:', error)
      setTtsReady(false)
      if (meta?.setup) {
        setTtsNudge({
          message: meta.reason === 'no_provider'
            ? 'Voice output needs a TTS provider \u2014 configure one in Settings \u203A System \u203A Voice'
            : 'Voice output needs an API key \u2014 add one in Settings \u203A API Keys'
        })
      }
    }
  })

  // Handle incoming stream text for TTS
  const handleTTSText = useCallback((text) => {
    if (!ttsEnabled) return

    // Connect on first text chunk (deferred connection for better reliability)
    if (ttsNeedsConnectionRef.current && ttsSupported) {
      ttsNeedsConnectionRef.current = false
      // Use agent's voice, or fall back to gendered default from TTS settings
      const voiceId = config?.voiceId
        || (config?.gender === 'male' ? ttsSettings?.defaultVoiceMale : ttsSettings?.defaultVoiceFemale)
      // Only pass voiceId if we have one, so the hook's default isn't overridden with undefined
      connectTTS(voiceId ? { voiceId } : {})
    }

    if (ttsReady) {
      // TTS is ready, send directly
      ttsStreamText(text)
    } else {
      // TTS not ready yet, buffer the text
      ttsTextBufferRef.current += text
    }
  }, [ttsEnabled, ttsReady, ttsSupported, ttsStreamText, connectTTS, config?.voiceId, config?.gender, ttsSettings])

  // Ref for config change callback to avoid EventSource recreation
  const onConfigChangedRef = useRef(onConfigChanged)
  useEffect(() => { onConfigChangedRef.current = onConfigChanged }, [onConfigChanged])

  // Ref for message complete callback to avoid EventSource recreation
  const onMessageCompleteRef = useRef(onMessageComplete)
  useEffect(() => { onMessageCompleteRef.current = onMessageComplete }, [onMessageComplete])

  // Refs for TTS functions to avoid EventSource recreation
  const handleTTSTextRef = useRef(handleTTSText)
  const ttsFlushRef = useRef(ttsFlush)
  const ttsStreamTextRef = useRef(ttsStreamText)
  const ttsEnabledRef = useRef(ttsEnabled)
  const ttsReadyRef = useRef(ttsReady)

  // Keep refs in sync
  useEffect(() => {
    handleTTSTextRef.current = handleTTSText
    ttsFlushRef.current = ttsFlush
    ttsStreamTextRef.current = ttsStreamText
    ttsEnabledRef.current = ttsEnabled
    ttsReadyRef.current = ttsReady
  }, [handleTTSText, ttsFlush, ttsStreamText, ttsEnabled, ttsReady])

  const handleVoiceToggle = useCallback(() => {
    // Interrupt TTS when starting voice input (if interruptOnInput enabled)
    if (isTTSPlaying && ttsSettings?.interruptOnInput !== false) {
      ttsCancel()
    }

    const now = Date.now()
    const timeSinceLastClick = now - lastClickTimeRef.current
    const timeSinceStop = now - lastStopTimeRef.current
    lastClickTimeRef.current = now

    // Use ref to get current streaming state (avoids stale closure)
    const currentlyStreaming = isStreamingRef.current

    // If streaming mode is active with WebSocket support
    if (useStreamingMode && streamSupported) {
      // If already streaming, stop immediately
      if (currentlyStreaming) {
        stopVoiceStreaming()
        lastStopTimeRef.current = now
        return
      }

      // Check for double-click, but NOT if we recently stopped
      // This prevents: click to stop -> click again to confirm -> accidentally starts continuous
      if (timeSinceLastClick < DOUBLE_CLICK_THRESHOLD && timeSinceStop > RECENTLY_STOPPED_GRACE_PERIOD) {
        // Double click - start continuous mode
        startContinuous()
      } else {
        // Single click - wait to see if it's a double click
        setTimeout(() => {
          // Only start one-shot if no second click happened AND not already streaming/connecting
          if (Date.now() - lastClickTimeRef.current >= DOUBLE_CLICK_THRESHOLD &&
              !isStreamingRef.current && !isConnectingRef.current) {
            startOneShot()
          }
        }, DOUBLE_CLICK_THRESHOLD)
      }
    } else if (batchSupported) {
      // Fallback to batch mode (no continuous support)
      toggleListening()
    }
  }, [useStreamingMode, streamSupported, batchSupported, startOneShot, startContinuous, stopVoiceStreaming, toggleListening, isTTSPlaying, ttsCancel, ttsSettings])

  // Format recording time as M:SS
  const formatTime = (seconds) => {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  const currentPort = window.location.port || '8888'
  const baseUrl = `http://localhost:${currentPort}`


  // Compute agent status based on loading state and activity
  const agentStatus = useAgentStatus(isLoading, lastActivityTime, {
    staleThresholdMs: 60000,   // Show "stale" after 60s of no activity
    errorThresholdMs: 180000  // Show error after 3 min of no activity
  })

  // Update activity timestamp
  const recordActivity = () => {
    const now = Date.now()
    setLastActivityTime(now)
    lastActivityRef.current = now
  }

  // Load chat history from server on mount and agent switch
  useEffect(() => {
    const loadHistory = async () => {
      setHistoryLoaded(false)
      setMessages([])
      setStreamingText('')
      setInput('')

      try {
        const response = await fetch(`${apiBase}/history?limit=50`)
        if (response.ok) {
          const data = await response.json()
          const loaded = data.entries.map(entry => ({
            id: entry.id.toString(),
            role: entry.role,
            content: entry.content,
            attachments: entry.attachments,
            timestamp: entry.timestamp,
            source: 'history'
          }))
          setMessages(loaded)
        }
      } catch (err) {
        console.error('Failed to load chat history:', err)
      } finally {
        setHistoryLoaded(true)
      }
    }

    loadHistory()
    prevAgentIdRef.current = selectedAgentId
  }, [selectedAgentId, apiBase])

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages.length, streamingText, activeSteps])

  // Elapsed timer — counts seconds while loading
  useEffect(() => {
    if (!isLoading) {
      setElapsedSeconds(0)
      loadingStartRef.current = null
      return
    }
    if (!loadingStartRef.current) loadingStartRef.current = Date.now()
    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - loadingStartRef.current) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [isLoading])

  // Connect to response stream for live updates
  // Uses refs for TTS to avoid recreating EventSource on TTS state changes
  useEffect(() => {
    const eventSource = new EventSource(`${apiBase}/stream`)

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)

        // Record activity on ANY message from the stream
        lastActivityRef.current = Date.now()
        setLastActivityTime(Date.now())

        if (data.type === 'stream') {
          // Feed text to TTS (use ref to avoid dependency) - even during greeting
          handleTTSTextRef.current(data.text)

          // Don't show streaming text - just show "Thinking..." until final response
          // This avoids showing partial text with [internal: ...] notes mid-stream
        } else if (data.type === 'step-start') {
          // Claude tool execution step started
          setActiveSteps(prev => {
            const existing = prev.findIndex(s => s.blockIndex === data.blockIndex)
            const step = {
              blockIndex: data.blockIndex,
              stepIndex: data.stepIndex,
              label: data.label,
              toolName: data.toolName,
              startedAt: Date.now(),
              completed: false
            }
            if (existing >= 0) {
              // Refined label update — replace in place
              const updated = [...prev]
              updated[existing] = { ...updated[existing], label: data.label }
              return updated
            }
            return [...prev, step]
          })
        } else if (data.type === 'step-complete') {
          // Claude tool execution step finished
          setActiveSteps(prev =>
            prev.map(s => s.blockIndex === data.blockIndex
              ? { ...s, completed: true, durationMs: data.durationMs }
              : s
            )
          )
        } else if (data.type === 'activity') {
          // Liveness pulse from any backend — activity already recorded above
        } else if (data.type === 'config-changed') {
          // Agent changed its own config (e.g. model) — refresh settings
          if (onConfigChangedRef.current) onConfigChangedRef.current()
        } else if (data.type === 'build-proposal' && data.proposalId) {
          // Build proposal — show approval card in chat
          setBuildProposal({
            proposalId: data.proposalId,
            appName: data.appName,
            appColor: data.appColor,
            appIcon: data.appIcon,
            spec: data.spec
          })
          setProposalStatus(null)
          setProposalChangesText('')
          skipNextDoneRef.current = true
        } else if (data.type === 'done') {
          // Response complete
          setStreamingText('')
          setIsLoading(false)
          setActiveSteps([])

          // Skip redundant done text after build proposal card
          if (skipNextDoneRef.current) {
            skipNextDoneRef.current = false
            return
          }

          // Mark stream as done - if TTS isn't ready yet, onStart will flush
          ttsStreamDoneRef.current = true
          if (ttsEnabledRef.current && ttsReadyRef.current) {
            // TTS is connected — drain any stragglers and flush
            if (ttsTextBufferRef.current) {
              ttsStreamTextRef.current(ttsTextBufferRef.current)
              ttsTextBufferRef.current = ''
            }
            console.log('Stream done, flushing TTS')
            ttsFlushRef.current()
            ttsStreamDoneRef.current = false  // Already flushed, don't let onStart flush again
          }
          // If TTS is NOT ready, onStart callback will detect ttsStreamDoneRef
          // and handle the drain+flush when the WebSocket connects

          // Notify parent that message processing is complete (for auto-refresh of agent life panel)
          onMessageCompleteRef.current?.()
        }
      } catch (e) {
        console.error('Stream parse error:', e)
      }
    }

    return () => eventSource.close()
  }, [baseUrl]) // Only recreate if baseUrl changes

  // Send message function - used by form submit, voice auto-send, and reaction notifications
  // silent: true sends to agent without adding a user message bubble (used for reactions)
  const sendMessage = useCallback(async (text, { silent = false } = {}) => {
    if (!text?.trim()) return

    // Cancel any playing TTS on new user input
    if (isTTSPlaying) {
      ttsCancel()
    }

    // Capture attachments before clearing
    const currentAttachments = silent ? [] : [...pendingAttachments]

    if (!silent) {
      const userMessage = {
        id: Date.now().toString(),
        role: 'user',
        content: text.trim(),
        timestamp: new Date().toISOString(),
        source: 'app',
        attachments: currentAttachments.length > 0 ? currentAttachments : undefined
      }
      setMessages(prev => [...prev, userMessage])
      setPendingAttachments([])
    }

    setInput('')
    setIsLoading(true)
    setStreamingText('')
    setActiveSteps([])
    loadingStartRef.current = Date.now()
    ttsTextBufferRef.current = '' // Clear any old buffer
    ttsReadyRef.current = false // Sync reset — prevents stale ref from triggering premature flush
    recordActivity() // Reset activity timer when starting

    // Set flag to connect TTS when first text arrives (deferred for reliability)
    if (ttsEnabled && ttsSupported) {
      console.log('TTS: Will connect on first text chunk')
      ttsNeedsConnectionRef.current = true
      ttsStreamDoneRef.current = false // Reset for new stream
    }

    try {
      // Pre-send auth check: verify the current backend has valid auth before sending
      if (baseApiUrl && config?.agentBackend && onBackendError) {
        try {
          const authRes = await fetch(`${baseApiUrl}/api/backend/auth-status/${config.agentBackend}`)
          const authData = await authRes.json()
          if (!authData.ready) {
            onBackendError('Backend not authenticated')
            setIsLoading(false)
            setActiveSteps([])
            return
          }
        } catch (e) {
          // Auth check failed — proceed anyway, let the send call handle errors
        }
      }

      const response = await fetch(`${apiBase}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text.trim(),
          attachments: currentAttachments.length > 0 ? currentAttachments : undefined
        })
      })

      const data = await response.json()

      if (!response.ok) {
        // Detect backend auth/setup failures and redirect to setup screen
        const errMsg = data.error || 'Failed to get response'
        if (errMsg.match(/exited with code [1-9]/) && onBackendError) {
          onBackendError(errMsg)
          setIsLoading(false)
          setActiveSteps([])
          return
        }
        throw new Error(errMsg)
      }

      // Add final response to messages
      if (data.text) {
        const assistantMessage = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: data.text,
          timestamp: new Date().toISOString(),
          source: 'app',
          attachments: data.attachments?.length > 0 ? data.attachments : undefined
        }
        if (!silent && data.reaction) {
          // Apply agent reaction to last user message
          setMessages(prev => {
            const updated = [...prev]
            for (let i = updated.length - 1; i >= 0; i--) {
              if (updated[i].role === 'user') {
                updated[i] = { ...updated[i], reaction: data.reaction }
                break
              }
            }
            return [...updated, assistantMessage]
          })
        } else {
          setMessages(prev => [...prev, assistantMessage])
        }
      }

    } catch (err) {
      console.error('Chat error:', err)
      setIsLoading(false)
      setActiveSteps([])

      if (!silent) {
        const errorMessage = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: `Sorry, I encountered an error: ${err.message}`,
          timestamp: new Date().toISOString(),
          source: 'app',
          isError: true
        }
        setMessages(prev => [...prev, errorMessage])
      }
    }
  }, [baseUrl, baseApiUrl, config?.agentBackend, onBackendError, ttsEnabled, ttsSupported, isTTSPlaying, ttsCancel, pendingAttachments])

  // Update ref so voice hook can call sendMessage
  useEffect(() => {
    sendMessageRef.current = sendMessage
  }, [sendMessage])

  // Interrupt TTS when user starts typing (if interruptOnInput enabled)
  const handleInputChange = useCallback((e) => {
    const newValue = e.target.value
    setInput(newValue)

    if (isTTSPlaying && newValue.length > 0 && ttsSettings?.interruptOnInput !== false) {
      ttsCancel()
    }
  }, [isTTSPlaying, ttsCancel, ttsSettings])

  const handleFileSelect = useCallback(async (e) => {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return

    for (const file of files) {
      try {
        const formData = new FormData()
        formData.append('file', file)
        const response = await fetch(`${apiBase}/upload`, {
          method: 'POST',
          body: formData
        })
        if (response.ok) {
          const result = await response.json()
          setPendingAttachments(prev => [...prev, result])
        }
      } catch (err) {
        console.error('Upload failed:', err)
      }
    }
    // Reset input so the same file can be re-selected
    e.target.value = ''
  }, [baseUrl])

  const removePendingAttachment = useCallback((index) => {
    setPendingAttachments(prev => prev.filter((_, i) => i !== index))
  }, [])

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!input.trim() && pendingAttachments.length > 0) {
      // Attachments only, no text — send a placeholder
      sendMessage('[Attached files]')
    } else {
      sendMessage(input)
    }
  }

  const handleReset = async () => {
    try {
      await fetch(`${apiBase}/reset`, { method: 'POST' })
      setMessages([])
      setStreamingText('')
      setPendingAttachments([])
    } catch (err) {
      console.error('Reset error:', err)
    }
  }

  const toggleReaction = useCallback((messageId, reactionKey) => {
    // Read message state BEFORE setMessages to avoid React batching race condition
    const msg = messages.find(m => m.id === messageId)
    const isAdding = msg && msg.reaction !== reactionKey

    // Build notification before the state update
    let notifyAgent = null
    if (isAdding && msg.role === 'assistant') {
      const emoji = REACTIONS.find(r => r.key === reactionKey)?.emoji
      if (emoji) {
        const truncated = msg.content.length > 100 ? msg.content.substring(0, 100) + '...' : msg.content
        const name = ownerName || 'User'
        notifyAgent = `[${name} reacted ${emoji} to your message: "${truncated}"]`
      }
    }

    setMessages(prev => prev.map(m => {
      if (m.id !== messageId) return m
      return { ...m, reaction: isAdding ? reactionKey : null }
    }))
    setActiveReactionPicker(null)

    // Send reaction to agent immediately (silent — no user message bubble)
    if (notifyAgent && sendMessageRef.current) {
      sendMessageRef.current(notifyAgent, { silent: true })
    }
  }, [ownerName, messages])

  useEffect(() => {
    if (!activeReactionPicker) return
    const handleClickOutside = (e) => {
      if (!e.target.closest('[data-reaction-picker]')) {
        setActiveReactionPicker(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [activeReactionPicker])

  // Get status label for display
  const getStatusLabel = () => {
    switch (agentStatus) {
      case 'working': return 'Working...'
      case 'thinking': return 'Thinking...'
      case 'stale': return 'Still working...'
      case 'error': return 'Timed out'
      default: return null
    }
  }

  return (
    <div className="flex flex-col h-full w-full">
      {/* Header with Avatar */}
      <div className="shrink-0 px-4 py-2 border-b border-gray-700 flex justify-between items-center">
        <div className="flex items-center gap-3">
          <AgentAvatar
            status={agentStatus}
            size={32}
            showLabel={false}
          />
          <div className="flex flex-col">
            <span className="text-sm text-gray-200 font-medium">{assistantName || 'Assistant'}</span>
            {isLoading && (
              <span className="text-[10px] text-gray-400">{getStatusLabel()}</span>
            )}
          </div>
        </div>
        <button
          onClick={handleReset}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          Clear
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && historyLoaded && !isLoading && (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-gray-500">Start a conversation...</p>
          </div>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div className="relative group max-w-[80%]" data-reaction-picker>
              <div
                className={`rounded-lg px-4 py-2 ${
                  msg.role === 'user'
                    ? 'bg-blue-600 text-white'
                    : msg.isError
                    ? 'bg-red-900/50 text-red-200 border border-red-700'
                    : 'bg-gray-700 text-gray-100'
                }`}
              >
                <p className="text-sm whitespace-pre-wrap break-words">{msg.content}</p>
                {msg.attachments?.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {msg.attachments.map((att, i) => (
                      att.mimeType?.startsWith('image/') ? (
                        <img key={i} src={`${baseUrl}${att.url}`}
                             className="max-w-[240px] rounded cursor-pointer hover:opacity-90 transition-opacity"
                             onClick={() => window.open(`${baseUrl}${att.url}`, '_blank')}
                             alt={att.filename} />
                      ) : (
                        <a key={i} href={`${baseUrl}${att.url}`} target="_blank" rel="noopener noreferrer"
                           className="inline-flex items-center gap-1 px-2 py-1 bg-black/20 rounded text-xs hover:bg-black/30 transition-colors">
                          <span>📎</span> {att.filename}
                        </a>
                      )
                    ))}
                  </div>
                )}
                <p className="text-xs opacity-50 mt-1">
                  {new Date(msg.timestamp).toLocaleTimeString()}
                </p>
              </div>

              {/* Reaction badge */}
              {msg.reaction && (
                <button
                  onClick={() => setActiveReactionPicker(activeReactionPicker === msg.id ? null : msg.id)}
                  className={`absolute -bottom-3 ${msg.role === 'user' ? 'left-2' : 'right-2'} bg-gray-800 border border-gray-600 rounded-full px-1.5 py-0.5 text-sm leading-none shadow-md hover:bg-gray-700 transition-colors cursor-pointer`}
                >
                  {REACTIONS.find(r => r.key === msg.reaction)?.emoji}
                </button>
              )}

              {/* Hover trigger */}
              {!msg.reaction && activeReactionPicker !== msg.id && (
                <button
                  onClick={() => setActiveReactionPicker(msg.id)}
                  className={`absolute -bottom-2 ${msg.role === 'user' ? 'left-2' : 'right-2'} w-6 h-6 rounded-full bg-gray-800 border border-gray-600 text-gray-400 text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-gray-700 hover:text-gray-200 transition-all cursor-pointer shadow-md`}
                >
                  +
                </button>
              )}

              {/* Reaction picker */}
              {activeReactionPicker === msg.id && (
                <div className={`absolute -bottom-10 ${msg.role === 'user' ? 'left-0' : 'right-0'} bg-gray-800 border border-gray-600 rounded-full px-2 py-1 flex gap-1 shadow-lg z-10`}>
                  {REACTIONS.map(r => (
                    <button
                      key={r.key}
                      onClick={() => toggleReaction(msg.id, r.key)}
                      className={`w-7 h-7 rounded-full flex items-center justify-center text-sm hover:bg-gray-700 transition-colors ${msg.reaction === r.key ? 'bg-gray-600 ring-1 ring-blue-400' : ''}`}
                    >
                      {r.emoji}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}

        {/* Streaming response / progress indicator */}
        {(isLoading || streamingText) && (
          <div className="flex justify-start">
            <div className="flex items-start gap-2">
              {/* Mini avatar next to response */}
              {!streamingText && (
                <div className="mt-1">
                  <AgentAvatar
                    status={agentStatus}
                    size={16}
                    showLabel={false}
                  />
                </div>
              )}
              <div className="max-w-[80%] rounded-lg px-4 py-2 bg-gray-700 text-gray-100">
                {streamingText ? (
                  <p className="text-sm whitespace-pre-wrap break-words">{streamingText}<span className="animate-pulse">▊</span></p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {/* Status line with elapsed timer */}
                    <div className="flex items-center gap-2">
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                      <span className="text-xs text-gray-400">
                        {getStatusLabel() || 'Thinking...'}
                      </span>
                      {elapsedSeconds > 0 && (
                        <span className="text-xs text-gray-500 tabular-nums">
                          {elapsedSeconds < 60
                            ? `${elapsedSeconds}s`
                            : `${Math.floor(elapsedSeconds / 60)}m ${(elapsedSeconds % 60).toString().padStart(2, '0')}s`
                          }
                        </span>
                      )}
                    </div>
                    {/* Tool execution steps (Claude backends) */}
                    {activeSteps.length > 0 && (
                      <div className="flex flex-col gap-0.5 mt-0.5">
                        {activeSteps.slice(-4).map((step) => (
                          <StepLine key={step.blockIndex} step={step} />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Build proposal card */}
        {buildProposal && (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-lg border border-gray-600 bg-gray-800 overflow-hidden">
              {/* Header */}
              <div className="px-4 py-3 border-b border-gray-700 flex items-center gap-2">
                {(buildProposal.appColor || buildProposal.appIcon) && (
                  <span className="w-7 h-7 rounded-md flex items-center justify-center text-sm flex-shrink-0"
                        style={{ background: buildProposal.appColor || '#334155' }}>
                    {buildProposal.appIcon || '?'}
                  </span>
                )}
                <span className="text-sm font-medium text-gray-200">
                  {buildProposal.appName || 'New App'}
                </span>
                <span className="text-xs text-gray-500 ml-auto">Build Proposal</span>
              </div>
              {/* Spec */}
              <div className="px-4 py-3">
                <p className="text-sm text-gray-300 whitespace-pre-wrap break-words">{buildProposal.spec}</p>
              </div>
              {/* Actions */}
              <div className="px-4 py-3 border-t border-gray-700">
                {proposalStatus === 'approved' ? (
                  <span className="text-sm text-green-400">Approved — building...</span>
                ) : proposalStatus === 'changes' ? (
                  <span className="text-sm text-yellow-400">Changes requested — waiting for revision...</span>
                ) : proposalStatus === 'rejected' ? (
                  <span className="text-sm text-red-400">Rejected</span>
                ) : proposalStatus === 'editing' ? (
                  <div className="flex flex-col gap-2">
                    <textarea
                      value={proposalChangesText}
                      onChange={(e) => setProposalChangesText(e.target.value)}
                      placeholder="Describe what you'd like changed..."
                      className="w-full bg-gray-700 text-gray-200 text-sm rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
                      rows={3}
                      autoFocus
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={async () => {
                          if (!proposalChangesText.trim()) return
                          setProposalStatus('changes')
                          try {
                            await fetch(`${baseUrl}/api/apps/propose/${buildProposal.proposalId}/changes`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ comments: proposalChangesText.trim() })
                            })
                          } catch (err) {
                            setProposalStatus(null)
                          }
                        }}
                        className="text-sm px-3 py-1.5 rounded bg-yellow-600 text-white hover:bg-yellow-700 transition-colors"
                      >
                        Submit Changes
                      </button>
                      <button
                        onClick={() => { setProposalStatus(null); setProposalChangesText('') }}
                        className="text-sm px-3 py-1.5 rounded bg-gray-600 text-gray-300 hover:bg-gray-500 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <button
                      onClick={async () => {
                        setProposalStatus('approved')
                        try {
                          await fetch(`${baseUrl}/api/apps/propose/${buildProposal.proposalId}/approve`, { method: 'POST' })
                        } catch (err) {
                          setProposalStatus(null)
                        }
                      }}
                      className="text-sm px-3 py-1.5 rounded bg-green-600 text-white hover:bg-green-700 transition-colors"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => setProposalStatus('editing')}
                      className="text-sm px-3 py-1.5 rounded bg-yellow-600 text-white hover:bg-yellow-700 transition-colors"
                    >
                      Propose Changes
                    </button>
                    <button
                      onClick={async () => {
                        setProposalStatus('rejected')
                        try {
                          await fetch(`${baseUrl}/api/apps/propose/${buildProposal.proposalId}/reject`, { method: 'POST' })
                        } catch {}
                      }}
                      className="text-sm px-3 py-1.5 rounded bg-gray-600 text-gray-300 hover:bg-gray-500 transition-colors"
                    >
                      Reject
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="shrink-0 p-4 border-t border-gray-700">
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileSelect}
          accept="image/*,.pdf,.txt,.md,.json,.csv"
          multiple
          className="hidden"
        />
        {/* Attachment preview strip */}
        {pendingAttachments.length > 0 && (
          <div className="flex gap-2 mb-2 flex-wrap">
            {pendingAttachments.map((att, i) => (
              <div key={i} className="relative group">
                {att.mimeType?.startsWith('image/') ? (
                  <img src={`${baseUrl}${att.url}`} className="h-16 w-16 object-cover rounded border border-gray-600" alt={att.filename} />
                ) : (
                  <div className="h-16 px-3 flex items-center bg-gray-700 rounded border border-gray-600 text-xs text-gray-300">
                    📎 {att.filename}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => removePendingAttachment(i)}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-600 rounded-full text-white text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {ttsNudge && (
          <div className="flex items-center gap-2 px-3 py-2 bg-yellow-900/30 border border-yellow-700/40 rounded-lg text-xs text-yellow-300 mb-2">
            <span className="flex-1">{ttsNudge.message}</span>
            <button
              onClick={() => setTtsNudge(null)}
              className="text-yellow-500 hover:text-yellow-300 flex-shrink-0 text-sm leading-none"
            >
              ×
            </button>
          </div>
        )}
        <div className="flex gap-2">
          {/* Show streaming transcription or regular input */}
          {isStreaming ? (
            <div className="flex-1 bg-gray-700 text-white rounded-lg px-4 py-2 min-h-[42px] flex items-center ring-2 ring-green-500">
              <span className="text-white">{committedText}</span>
              <span className="text-gray-400 italic">{unstableText}</span>
              <span className="animate-pulse ml-0.5">|</span>
              <span className="ml-auto text-xs text-green-400">{formatTime(recordingTime)}</span>
            </div>
          ) : (
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={handleInputChange}
              placeholder={
                isConnecting
                  ? 'Connecting...'
                  : isListening
                  ? `Recording ${formatTime(recordingTime)}... (click stop when done)`
                  : isTranscribing
                  ? 'Transcribing...'
                  : 'Type a message...'
              }
              className={`flex-1 bg-gray-700 text-white rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                isConnecting ? 'ring-2 ring-blue-500' : ''
              } ${isListening ? 'ring-2 ring-red-500' : ''
              } ${isTranscribing ? 'ring-2 ring-yellow-500' : ''}`}
              disabled={isTranscribing || isConnecting}
              readOnly={isListening || isTranscribing}
            />
          )}
          {/* Attach file */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="px-3 py-2 rounded-lg bg-gray-600 text-gray-400 hover:bg-gray-500 hover:text-gray-200 transition-colors min-w-[44px] flex items-center justify-center"
            title="Attach file"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M8 4a3 3 0 00-3 3v4a5 5 0 0010 0V7a1 1 0 112 0v4a7 7 0 11-14 0V7a5 5 0 0110 0v4a3 3 0 11-6 0V7a1 1 0 012 0v4a1 1 0 102 0V7a3 3 0 00-3-3z" clipRule="evenodd" />
            </svg>
          </button>
          {/* TTS indicator */}
          {isTTSPlaying && (
            <button
              type="button"
              onClick={ttsCancel}
              className="px-3 py-2 rounded-lg bg-purple-600 text-white hover:bg-purple-700 animate-pulse min-w-[44px] flex items-center justify-center"
              title="Speaking... Click to stop"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M11.999 3c-4.869 0-9 3.988-9 9s4.131 9 9 9 9-4.012 9-9-4.131-9-9-9zm4.5 11.25l-6 3.75v-9l6 3.75v1.5z"/>
              </svg>
            </button>
          )}
          {voiceSupported && (() => {
            // Determine continuous mode sub-states
            const isContinuousWaiting = isStreaming && voiceMode === 'continuous' && !committedText && !unstableText
            const isContinuousSpeaking = isStreaming && voiceMode === 'continuous' && (committedText || unstableText)
            const isOneShotActive = isStreaming && voiceMode !== 'continuous'

            return (
              <button
                type="button"
                onClick={handleVoiceToggle}
                disabled={isTranscribing}
                className={`px-3 py-2 rounded-lg transition-colors min-w-[44px] flex items-center justify-center relative ${
                  isContinuousWaiting
                    ? 'bg-green-600/60 text-white hover:bg-green-600 ring-2 ring-green-300 ring-offset-2 ring-offset-gray-800'
                    : isContinuousSpeaking
                    ? 'bg-green-600 text-white hover:bg-green-700 animate-pulse ring-2 ring-green-300 ring-offset-2 ring-offset-gray-800'
                    : isOneShotActive
                    ? 'bg-green-600 text-white hover:bg-green-700 animate-pulse'
                    : isConnecting
                    ? 'bg-blue-600 text-white'
                    : isListening
                    ? 'bg-red-600 text-white hover:bg-red-700 animate-pulse'
                    : isTranscribing
                    ? 'bg-yellow-600 text-white'
                    : 'bg-gray-600 text-gray-400 hover:bg-gray-500 hover:text-gray-200'
                } disabled:opacity-50 disabled:cursor-not-allowed`}
                title={
                  isContinuousWaiting ? 'Listening... Click to stop'
                  : isContinuousSpeaking ? 'Speaking... Click to stop'
                  : isOneShotActive ? 'Stop (sends message)'
                  : isConnecting ? 'Connecting...'
                  : isListening ? 'Stop recording'
                  : isTranscribing ? 'Transcribing...'
                  : 'Click for one-shot, double-click for continuous'
                }
              >
                {/* Continuous mode badge */}
                {isStreaming && voiceMode === 'continuous' && (
                  <span className="absolute -top-1 -right-1 w-4 h-4 bg-green-400 rounded-full text-[9px] text-gray-900 font-bold flex items-center justify-center">
                    ∞
                  </span>
                )}
                {isTranscribing || isConnecting ? (
                  // Spinner for connecting/transcribing
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                    <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
                  </svg>
                ) : isStreaming || isListening ? (
                  // Stop icon when active
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8 7a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1V8a1 1 0 00-1-1H8z" clipRule="evenodd" />
                  </svg>
                ) : (
                  // Muted mic icon (mic with slash) when inactive
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 1a4 4 0 00-4 4v6a4 4 0 008 0V5a4 4 0 00-4-4z"/>
                    <path d="M6 11a1 1 0 00-2 0 8 8 0 0014.93 4.03l-1.5-1.5A6 6 0 016 11z"/>
                    <path d="M12 17a5.98 5.98 0 01-3.58-1.18l-1.43 1.43A7.97 7.97 0 0011 18.93V21H8a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07a7.97 7.97 0 001.76-.35l-1.44-1.44A5.97 5.97 0 0112 17z"/>
                    <path d="M3.71 2.29a1 1 0 00-1.42 1.42l18 18a1 1 0 001.42-1.42l-18-18z"/>
                  </svg>
                )}
              </button>
            )
          })()}
          <button
            type="submit"
            disabled={(!input.trim() && pendingAttachments.length === 0) || isVoiceActive}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  )
}

export default Chat
