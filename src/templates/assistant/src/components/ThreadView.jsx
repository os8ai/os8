import { useState, useEffect, useRef, useCallback } from 'react'
import ThreadMessage from './ThreadMessage'
import AgentAvatar from './AgentAvatar'
import { useTTSStream } from '../hooks/useTTSStream'
import { useAgUiReducer } from '../hooks/useAgUiReducer'

function ThreadView({ thread, baseApiUrl, agents, onClose }) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [workingAgents, setWorkingAgents] = useState(new Set())
  const [pendingAttachments, setPendingAttachments] = useState([])
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef(null)
  const [mentionQuery, setMentionQuery] = useState(null)
  const [mentionIdx, setMentionIdx] = useState(0)
  const [ttsEnabled, setTtsEnabled] = useState(false)
  const [participantDetails, setParticipantDetails] = useState(thread.participantDetails || [])
  const messagesEndRef = useRef(null)
  const inputRef = useRef(null)
  const eventSourceRef = useRef(null)

  // ag-ui reducer: maintains structured state from RUN_STARTED, MESSAGES_SNAPSHOT, etc. in
  // parallel with legacy event handlers below. State is not yet rendered (Phase 4 plumbing
  // only); legacy handlers remain the source of truth.
  const { ingest: aguiIngest } = useAgUiReducer()

  // TTS speech queue
  const speechQueueRef = useRef([])
  const isSpeakingRef = useRef(false)

  // Process next item in queue
  const processQueue = useCallback(async () => {
    if (isSpeakingRef.current || speechQueueRef.current.length === 0) return
    const next = speechQueueRef.current.shift()
    isSpeakingRef.current = true
    const ok = await speak(next.text, { voiceId: next.voiceId })
    if (ok) {
      // Prefetch audio for next message while this one plays
      if (speechQueueRef.current.length > 0) {
        const upcoming = speechQueueRef.current[0]
        prefetchRef.current(upcoming.text, { voiceId: upcoming.voiceId })
      }
    } else {
      // speak failed (e.g. core not ready) — unblock queue for next item
      isSpeakingRef.current = false
      if (speechQueueRef.current.length > 0) processQueue()
    }
  }, [])

  const {
    isPlaying: isTTSPlaying,
    isSupported: ttsSupported,
    settings: ttsSettings,
    cancel: ttsCancel,
    speak,
    prefetch,
    preconnect,
    promoteToPrefetch
  } = useTTSStream({
    onEnd: () => {
      isSpeakingRef.current = false
      processQueue()
    },
    onError: () => {
      isSpeakingRef.current = false
      processQueue()
    }
  })

  // Keep processQueue ref stable for SSE handler
  const processQueueRef = useRef(processQueue)
  useEffect(() => { processQueueRef.current = processQueue }, [processQueue])

  // Keep prefetch ref stable for SSE handler and processQueue
  const prefetchRef = useRef(prefetch)
  useEffect(() => { prefetchRef.current = prefetch }, [prefetch])

  // Keep preconnect/promoteToPrefetch refs stable for SSE handler
  const preconnectRef = useRef(preconnect)
  useEffect(() => { preconnectRef.current = preconnect }, [preconnect])
  const promoteToPrefetchRef = useRef(promoteToPrefetch)
  useEffect(() => { promoteToPrefetchRef.current = promoteToPrefetch }, [promoteToPrefetch])

  // Load TTS settings on mount
  useEffect(() => {
    const loadTTSSettings = async () => {
      try {
        const port = window.location.port || '8888'
        const response = await fetch(`http://localhost:${port}/api/voice/tts-settings`)
        if (response.ok) {
          const settings = await response.json()
          setTtsEnabled(settings.enabled)
        }
      } catch (err) {
        console.warn('Failed to load TTS settings:', err)
      }
    }
    loadTTSSettings()

    const handleTtsChanged = (e) => {
      if (e.detail) setTtsEnabled(e.detail.enabled)
    }
    window.addEventListener('tts-settings-changed', handleTtsChanged)
    return () => window.removeEventListener('tts-settings-changed', handleTtsChanged)
  }, [])

  // Refs for SSE handler access
  const ttsEnabledRef = useRef(ttsEnabled)
  useEffect(() => { ttsEnabledRef.current = ttsEnabled }, [ttsEnabled])
  const ttsSettingsRef = useRef(ttsSettings)
  useEffect(() => { ttsSettingsRef.current = ttsSettings }, [ttsSettings])

  // Resolve voice ID for a sender (uses local participantDetails state, not prop)
  const resolveVoiceId = useCallback((senderAppId) => {
    const participant = participantDetails.find(p => p.id === senderAppId)
    if (!participant) return ttsSettings?.voiceId
    if (participant.voiceId) return participant.voiceId
    // Gendered default
    const settings = ttsSettingsRef.current
    if (participant.gender === 'male' && settings?.defaultVoiceMale) return settings.defaultVoiceMale
    if (participant.gender === 'female' && settings?.defaultVoiceFemale) return settings.defaultVoiceFemale
    return settings?.voiceId
  }, [participantDetails, ttsSettings])

  const resolveVoiceIdRef = useRef(resolveVoiceId)
  useEffect(() => { resolveVoiceIdRef.current = resolveVoiceId }, [resolveVoiceId])

  // Sync participantDetails from prop when thread changes
  useEffect(() => {
    if (thread.participantDetails?.length) setParticipantDetails(thread.participantDetails)
  }, [thread.id])

  // Load thread messages
  const loadMessages = useCallback(async () => {
    try {
      const res = await fetch(`${baseApiUrl}/api/agent-chat/threads/${thread.id}?limit=100`)
      const data = await res.json()
      setMessages(data.messages || [])
      if (data.participantDetails) setParticipantDetails(data.participantDetails)
    } catch (err) {
      console.error('Failed to load thread messages:', err)
    }
  }, [thread.id, baseApiUrl])

  // Connect SSE
  useEffect(() => {
    loadMessages()

    const es = new EventSource(`${baseApiUrl}/api/agent-chat/threads/${thread.id}/stream`)
    eventSourceRef.current = es

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data)

        // Ingest into ag-ui reducer in parallel with legacy handlers (state-only, no UI yet)
        aguiIngest(data)

        if (data.type === 'MESSAGES_SNAPSHOT' && Array.isArray(data.messages)) {
          // Each thread message arrives as a single-message snapshot
          for (const msg of data.messages) {
            if (!msg) continue
            setMessages(prev => {
              // Deduplicate by ID
              if (prev.some(m => m.id === msg.id)) return prev
              return [...prev, msg]
            })
            // Queue TTS for agent messages
            if (ttsEnabledRef.current && msg.sender_app_id !== 'user') {
              const voiceId = resolveVoiceIdRef.current(msg.sender_app_id)
              speechQueueRef.current.push({ text: msg.content, voiceId })
              if (isSpeakingRef.current && speechQueueRef.current.length === 1) {
                // Already playing — use existing prefetch path
                prefetchRef.current(msg.content, { voiceId })
              } else if (!isSpeakingRef.current && speechQueueRef.current.length === 1) {
                // Nothing playing yet — promote preconnect to prefetch (eager)
                promoteToPrefetchRef.current(msg.content, { voiceId })
              }
              processQueueRef.current()
            }
          }
        } else if (data.type === 'RUN_STARTED' && data.agentName) {
          setWorkingAgents(prev => new Set([...prev, data.agentName]))
          // Pre-connect TTS WebSocket for first agent (before text exists)
          if (ttsEnabledRef.current && !isSpeakingRef.current && speechQueueRef.current.length === 0) {
            const voiceId = resolveVoiceIdRef.current(data.agentId)
            if (voiceId) {
              preconnectRef.current({ voiceId })
            }
          }
        } else if ((data.type === 'RUN_FINISHED' || data.type === 'RUN_ERROR') && data.agentName) {
          setWorkingAgents(prev => {
            const next = new Set(prev)
            next.delete(data.agentName)
            return next
          })
        }
      } catch (err) {
        // ignore parse errors
      }
    }

    return () => {
      es.close()
      eventSourceRef.current = null
      // Cleanup TTS on thread change
      ttsCancel()
      speechQueueRef.current = []
      isSpeakingRef.current = false
    }
  }, [thread.id, baseApiUrl, loadMessages, ttsCancel])

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, workingAgents])

  // Upload a file attachment
  const uploadFile = async (file) => {
    const formData = new FormData()
    formData.append('file', file)
    try {
      const resp = await fetch(`${baseApiUrl}/api/agent-chat/threads/${thread.id}/upload`, {
        method: 'POST',
        body: formData
      })
      if (resp.ok) {
        const result = await resp.json()
        setPendingAttachments(prev => [...prev, result])
      }
    } catch (err) {
      console.error('Upload error:', err)
    }
  }

  const removePendingAttachment = (index) => {
    setPendingAttachments(prev => prev.filter((_, i) => i !== index))
  }

  // Send message
  const handleSend = async () => {
    const text = input.trim()
    if (!text && pendingAttachments.length === 0) return
    if (sending) return

    // Interrupt current speech on send
    ttsCancel()
    speechQueueRef.current = []
    isSpeakingRef.current = false

    const currentAttachments = [...pendingAttachments]
    setPendingAttachments([])
    setSending(true)
    setInput('')
    setMentionQuery(null)

    try {
      await fetch(`${baseApiUrl}/api/agent-chat/threads/${thread.id}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text || '[Attached files]',
          attachments: currentAttachments.length > 0 ? currentAttachments : undefined
        })
      })
    } catch (err) {
      console.error('Failed to send message:', err)
    } finally {
      setSending(false)
    }
  }

  // @mention autocomplete
  const handleInputChange = (e) => {
    const val = e.target.value
    setInput(val)

    // Check for @mention
    const cursorPos = e.target.selectionStart
    const textBeforeCursor = val.substring(0, cursorPos)
    const mentionMatch = textBeforeCursor.match(/@(\w*)$/)

    if (mentionMatch) {
      setMentionQuery(mentionMatch[1].toLowerCase())
      setMentionIdx(0)
    } else {
      setMentionQuery(null)
    }
  }

  // Filter agents for mention
  const mentionAgents = mentionQuery !== null
    ? (agents || []).filter(a =>
        a.id !== 'user' &&
        a.name.toLowerCase().includes(mentionQuery)
      )
    : []

  // Insert mention
  const insertMention = (agentName) => {
    const cursorPos = inputRef.current?.selectionStart || input.length
    const textBeforeCursor = input.substring(0, cursorPos)
    const textAfterCursor = input.substring(cursorPos)
    const beforeMention = textBeforeCursor.replace(/@\w*$/, '')
    setInput(`${beforeMention}@${agentName} ${textAfterCursor}`)
    setMentionQuery(null)
    inputRef.current?.focus()
  }

  const handleKeyDown = (e) => {
    if (mentionAgents.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionIdx(prev => Math.min(prev + 1, mentionAgents.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIdx(prev => Math.max(prev - 1, 0))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        insertMention(mentionAgents[mentionIdx].name)
        return
      }
      if (e.key === 'Escape') {
        setMentionQuery(null)
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // Participant details from local state
  const participantAgents = participantDetails.filter(p => p.id !== 'user')

  // Clear all messages in this thread
  const handleClear = async () => {
    try {
      await fetch(`${baseApiUrl}/api/agent-chat/threads/${thread.id}/messages`, { method: 'DELETE' })
      setMessages([])
    } catch (err) {
      console.error('Clear thread error:', err)
    }
  }

  return (
    <div className="flex flex-col h-full w-full bg-gray-900">
      {/* Thread header */}
      <div className="shrink-0 px-4 py-2 border-b border-gray-700 bg-gray-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7"/>
            </svg>
          </button>
          <AgentAvatar
            status={workingAgents.size > 0 ? 'working' : 'idle'}
            size={32}
            showLabel={false}
          />
          <div>
            <div className="text-sm font-medium text-white">
              {thread.name || participantAgents.map(a => a.name).join(', ')}
            </div>
            <div className="text-[10px] text-gray-500">
              {workingAgents.size > 0
                ? `${[...workingAgents].join(', ')} working...`
                : thread.type === 'group' ? `${participantDetails.length} participants` : 'DM'}
            </div>
          </div>
        </div>
        <button
          onClick={handleClear}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          Clear
        </button>
      </div>

      {/* Messages (with drag-and-drop) */}
      <div
        className={`flex-1 overflow-y-auto px-4 py-3 transition-colors ${dragOver ? 'bg-blue-900/20 ring-2 ring-inset ring-blue-500/40' : ''}`}
        onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setDragOver(true) }}
        onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setDragOver(false) }}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy' }}
        onDrop={(e) => {
          e.preventDefault(); e.stopPropagation(); setDragOver(false)
          Array.from(e.dataTransfer.files).forEach(f => uploadFile(f))
        }}
      >
        {messages.map(msg => (
          <ThreadMessage
            key={msg.id}
            message={msg}
            agents={participantDetails}
            baseApiUrl={baseApiUrl}
          />
        ))}

        {/* Working indicators */}
        {workingAgents.size > 0 && (
          <div className="flex items-center gap-2 py-2">
            <div className="flex gap-1">
              <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
            <span className="text-xs text-gray-500">
              {[...workingAgents].join(', ')} typing...
            </span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Pending attachments */}
      {pendingAttachments.length > 0 && (
        <div className="shrink-0 border-t border-gray-700 px-4 py-2 flex flex-wrap gap-2">
          {pendingAttachments.map((att, i) => (
            <div key={i} className="relative group">
              {att.mimeType?.startsWith('image/') ? (
                <img
                  src={`${baseApiUrl}${att.url}`}
                  alt={att.filename}
                  className="w-12 h-12 object-cover rounded-lg border border-gray-600"
                />
              ) : (
                <div className="px-2 py-1 bg-gray-700 rounded-lg text-xs text-gray-300 border border-gray-600 max-w-[120px] truncate">
                  {att.filename}
                </div>
              )}
              <button
                onClick={() => removePendingAttachment(i)}
                className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-red-600 text-white rounded-full text-[10px] leading-none flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              >
                &times;
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Input bar */}
      <div className="shrink-0 border-t border-gray-700 px-4 py-3 relative">
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            Array.from(e.target.files).forEach(f => uploadFile(f))
            e.target.value = ''
          }}
        />

        {/* @mention autocomplete */}
        {mentionAgents.length > 0 && (
          <div className="absolute bottom-full left-4 right-4 mb-1 bg-gray-800 border border-gray-600 rounded-lg shadow-xl overflow-hidden">
            {mentionAgents.map((agent, idx) => (
              <button
                key={agent.id}
                onClick={() => insertMention(agent.name)}
                className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 transition-colors ${
                  idx === mentionIdx ? 'bg-gray-700 text-white' : 'text-gray-300 hover:bg-gray-700'
                }`}
              >
                <span
                  className="w-4 h-4 rounded-full flex items-center justify-center text-[10px]"
                  style={{ backgroundColor: (agent.color || '#6366f1') + '33' }}
                >
                  {agent.name[0]}
                </span>
                <span>{agent.name}</span>
              </button>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2">
          {/* Paperclip button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="p-2.5 text-gray-400 hover:text-white transition-colors shrink-0"
            title="Attach file"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
            </svg>
          </button>
          <textarea
            ref={inputRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={`Message ${thread.name || 'thread'}... (@ to mention)`}
            rows={1}
            className="flex-1 bg-gray-800 text-white rounded-xl px-4 py-2.5 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-blue-500 border border-gray-600 max-h-32"
            style={{ minHeight: '40px' }}
          />
          <button
            onClick={handleSend}
            disabled={(!input.trim() && pendingAttachments.length === 0) || sending}
            className="p-2.5 bg-blue-600 text-white rounded-xl hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="22" y1="2" x2="11" y2="13"/>
              <polygon points="22 2 15 22 11 13 2 9 22 2"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}

export default ThreadView
