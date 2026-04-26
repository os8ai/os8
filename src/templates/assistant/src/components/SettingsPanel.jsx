import { useState, useEffect, useRef, useCallback } from 'react'

const TIMEOUT_OPTIONS = [
  { value: 0, label: 'No timeout' },
  { value: 120000, label: '2 min' },
  { value: 180000, label: '3 min' },
  { value: 300000, label: '5 min' },
  { value: 900000, label: '15 min' },
  { value: 1800000, label: '30 min' },
  { value: 3600000, label: '1 hour' },
]

const POLL_OPTIONS = [
  { value: 3000, label: '3s' },
  { value: 5000, label: '5s' },
  { value: 10000, label: '10s' },
  { value: 30000, label: '30s' },
]

const AWAY_OPTIONS = [
  { value: 300000, label: '5 min' },
  { value: 600000, label: '10 min' },
  { value: 900000, label: '15 min' },
]

// TTS provider list is fetched from the server at /api/voice/tts-providers —
// the shell filters by ai_mode and enforces the local/proprietary taxonomy,
// so the template stays dumb about provider classification. `aiMode` is
// returned alongside for the subtitle/explanation text.

// Human-readable status banner text per backend `reason` code. Cloud
// providers use 'no_api_key'; local providers use 'launcher_down' or
// 'model_not_serving' (added in Phase 3-5 follow-up).
const TTS_STATUS_MESSAGES = {
  no_api_key:        'API key not configured',
  no_provider:       'No provider selected',
  launcher_down:     "os8-launcher isn't running on :9000",
  model_not_serving: 'Launcher up, but the model is not loaded'
}

const RATE_LIMIT_OPTIONS = [
  { value: 2000, label: '2s' },
  { value: 5000, label: '5s' },
  { value: 10000, label: '10s' },
  { value: 30000, label: '30s' },
  { value: 60000, label: '1 min' },
  { value: 120000, label: '2 min' },
]

function SettingsPanel({ isOpen, onClose, agentId, baseApiUrl, config, onConfigChange, onConfigUpdated, onAgentsChanged, onAgentDeleted }) {
  const [activeTab, setActiveTab] = useState('agent')
  const [telegramEnabled, setTelegramEnabled] = useState(true)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleteInput, setDeleteInput] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [responseTimeout, setResponseTimeout] = useState(180000)
  const [agents, setAgents] = useState([])
  const [allAgents, setAllAgents] = useState([])
  const [defaultAgentId, setDefaultAgentId] = useState(null)
  const [dailyLimit, setDailyLimit] = useState(20)
  const [circuitBreakerLimit, setCircuitBreakerLimit] = useState(50)
  const [backendOptions, setBackendOptions] = useState([])
  const [voices, setVoices] = useState([])
  const [voiceReady, setVoiceReady] = useState(false)
  const [loadingVoices, setLoadingVoices] = useState(false)
  const [playingPreview, setPlayingPreview] = useState(null)
  const voiceAudioRef = useRef(null)
  const [defaultVoiceFemale, setDefaultVoiceFemale] = useState('')
  const [defaultVoiceMale, setDefaultVoiceMale] = useState('')
  const [ttsEnabled, setTtsEnabled] = useState(false)
  const [ttsInterruptOnInput, setTtsInterruptOnInput] = useState(true)
  const [ttsStability, setTtsStability] = useState(50)
  const [ttsSimilarityBoost, setTtsSimilarityBoost] = useState(75)
  const [ttsSpeed, setTtsSpeed] = useState(100)
  const [ttsProvider, setTtsProvider] = useState(null)
  const [ttsStatus, setTtsStatus] = useState(null)
  const [providerOptions, setProviderOptions] = useState([])
  const [aiMode, setAiMode] = useState(null)
  // Active local chat slot from /api/ai/local-status. Used to render a
  // read-only "set in launcher" display in local mode (no per-agent
  // dropdown — OS8 is a taker; the chooser lives in os8-launcher).
  const [localChatSlot, setLocalChatSlot] = useState(null)
  const [providerSource, setProviderSource] = useState(null)
  const [playingDefaultPreview, setPlayingDefaultPreview] = useState(null)
  const defaultAudioRef = useRef(null)
  const [localOverrides, setLocalOverrides] = useState({})
  const [saveStatus, setSaveStatus] = useState(null)
  const [showTelegramHelp, setShowTelegramHelp] = useState(false)
  const [showTelegramDelete, setShowTelegramDelete] = useState(false)
  const [capabilities, setCapabilities] = useState([])
  const [capFilter, setCapFilter] = useState('pinned')
  const saveTimerRef = useRef(null)
  const debounceTimerRef = useRef(null)
  const panelRef = useRef(null)

  // Merge config with local overrides for immediate UI feedback
  const effectiveConfig = config ? { ...config, ...localOverrides } : config

  // Reset local overrides and delete state when agent changes
  useEffect(() => {
    setLocalOverrides({})
    setShowDeleteConfirm(false)
    setDeleteInput('')
  }, [agentId])

  // Load system-level settings
  useEffect(() => {
    if (!isOpen) return
    fetch(`${baseApiUrl}/api/settings/telegram`)
      .then(r => r.json())
      .then(data => setTelegramEnabled(data.enabled))
      .catch(err => console.error('Failed to load telegram setting:', err))
    fetch(`${baseApiUrl}/api/settings/response-timeout`)
      .then(r => r.json())
      .then(data => setResponseTimeout(data.timeoutMs))
      .catch(err => console.error('Failed to load response timeout:', err))
    fetch(`${baseApiUrl}/api/agents`)
      .then(r => r.json())
      .then(data => {
        setAgents(data.agents || [])
        setAllAgents(data.agents || [])
        setDefaultAgentId(data.defaultAgentId || null)
      })
      .catch(err => console.error('Failed to load agents:', err))
    fetch(`${baseApiUrl}/api/settings/agent-chat`)
      .then(r => r.json())
      .then(data => {
        setDailyLimit(data.dailyLimit)
        setCircuitBreakerLimit(data.circuitBreakerLimit)
      })
      .catch(err => console.error('Failed to load agent chat settings:', err))
    fetch(`${baseApiUrl}/api/ai/models/options`)
      .then(r => r.json())
      .then(data => { if (Array.isArray(data)) setBackendOptions(data) })
      .catch(err => console.error('Failed to load model options:', err))
    // Active local chat slot — drives the read-only Chat Model display
    // in local mode. Mirrors os8-launcher's triplet chooser; the user
    // changes the selection in the launcher, not here.
    fetch(`${baseApiUrl}/api/ai/local-status`)
      .then(r => r.json())
      .then(data => {
        const chat = Array.isArray(data?.slots) ? data.slots.find(s => s.slot === 'chat') : null
        setLocalChatSlot(chat || null)
      })
      .catch(() => {})
    // Load voices for voice section
    setLoadingVoices(true)
    fetch(`${baseApiUrl}/api/agents/voices`)
      .then(r => r.json())
      .then(data => {
        setVoiceReady(data.ready || false)
        setTtsProvider(data.provider || null)
        if (data.voices) setVoices(data.voices)
      })
      .catch(() => {})
      .finally(() => setLoadingVoices(false))
    // Load TTS status
    fetch(`${baseApiUrl}/api/voice/tts-status`)
      .then(r => r.json())
      .then(data => setTtsStatus(data))
      .catch(() => {})
    // Load mode-filtered provider list. Server auto-picks a configured
    // provider on first access so this call may persist a slot for us; we
    // just reflect whatever `current` it returns.
    fetch(`${baseApiUrl}/api/voice/tts-providers`)
      .then(r => r.json())
      .then(data => {
        setProviderOptions(Array.isArray(data?.providers) ? data.providers : [])
        setAiMode(data?.mode || null)
        setProviderSource(data?.source || null)
        if (data?.current !== undefined) setTtsProvider(data.current || null)
      })
      .catch(() => {})
    // Load TTS settings
    fetch(`${baseApiUrl}/api/voice/tts-settings`)
      .then(r => r.json())
      .then(data => {
        setDefaultVoiceFemale(data.defaultVoiceFemale || '')
        setDefaultVoiceMale(data.defaultVoiceMale || '')
        setTtsEnabled(data.enabled || false)
        setTtsInterruptOnInput(data.interruptOnInput !== false)
        setTtsStability(Math.round((data.stability || 0.5) * 100))
        setTtsSimilarityBoost(Math.round((data.similarityBoost || 0.75) * 100))
        setTtsSpeed(Math.round((data.speed || 1.0) * 100))
      })
      .catch(() => {})
    // Load capabilities with pin status
    if (agentId) {
      fetch(`${baseApiUrl}/api/skills/registry?agentId=${agentId}`)
        .then(r => r.json())
        .then(data => setCapabilities(Array.isArray(data) ? data : []))
        .catch(() => {})
    }
  }, [isOpen, baseApiUrl, agentId])

  const showSaved = useCallback(() => {
    setSaveStatus('Saved')
    clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => setSaveStatus(null), 1500)
  }, [])

  const saveTtsSetting = useCallback((updates) => {
    fetch(`${baseApiUrl}/api/voice/tts-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    })
      .then(r => r.json())
      .then(saved => {
        showSaved()
        window.dispatchEvent(new CustomEvent('tts-settings-changed', { detail: saved }))
      })
      .catch(err => console.error('Failed to save TTS setting:', err))
  }, [baseApiUrl, showSaved])

  const switchProvider = useCallback(async (provider) => {
    setTtsProvider(provider || null)
    try {
      await fetch(`${baseApiUrl}/api/voice/tts-provider`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider })
      })
      // Re-fetch voices, TTS settings, status, and the providers list (for
      // source transitions pinned↔auto↔none).
      const [voicesRes, settingsRes, statusRes, providersRes] = await Promise.all([
        fetch(`${baseApiUrl}/api/agents/voices`),
        fetch(`${baseApiUrl}/api/voice/tts-settings`),
        fetch(`${baseApiUrl}/api/voice/tts-status`),
        fetch(`${baseApiUrl}/api/voice/tts-providers`)
      ])
      const voicesData = await voicesRes.json()
      setVoiceReady(voicesData.ready || false)
      setTtsProvider(voicesData.provider || null)
      if (voicesData.voices) setVoices(voicesData.voices)
      const settingsData = await settingsRes.json()
      setDefaultVoiceFemale(settingsData.defaultVoiceFemale || '')
      setDefaultVoiceMale(settingsData.defaultVoiceMale || '')
      setTtsEnabled(settingsData.enabled || false)
      setTtsInterruptOnInput(settingsData.interruptOnInput !== false)
      setTtsStability(Math.round((settingsData.stability || 0.5) * 100))
      setTtsSimilarityBoost(Math.round((settingsData.similarityBoost || 0.75) * 100))
      setTtsSpeed(Math.round((settingsData.speed || 1.0) * 100))
      const statusData = await statusRes.json()
      setTtsStatus(statusData)
      const providersData = await providersRes.json().catch(() => null)
      if (providersData) {
        setProviderOptions(Array.isArray(providersData.providers) ? providersData.providers : [])
        setAiMode(providersData.mode || null)
        setProviderSource(providersData.source || null)
      }
      window.dispatchEvent(new CustomEvent('tts-provider-changed'))
      onConfigUpdated?.()
    } catch (err) {
      console.error('Failed to switch TTS provider:', err)
    }
  }, [baseApiUrl, onConfigUpdated])

  // Save agent config field immediately (selects/toggles) or debounced (text)
  const saveAgentField = useCallback((updates, debounce = false) => {
    // Apply optimistic update immediately (panel-local + parent App.jsx)
    setLocalOverrides(prev => ({ ...prev, ...updates }))
    onConfigChange?.(updates)

    const doSave = () => {
      fetch(`${baseApiUrl}/api/agents/${agentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      })
        .then(() => {
          showSaved()
          onConfigUpdated?.()
        })
        .catch(err => console.error('Failed to save:', err))
    }

    if (debounce) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = setTimeout(doSave, 500)
    } else {
      doSave()
    }
  }, [baseApiUrl, agentId, showSaved, onConfigChange, onConfigUpdated])

  if (!isOpen || !config) return null

  const backendValue = effectiveConfig.agentModel || 'auto'

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/30 z-40"
        onClick={onClose}
      />

      {/* Panel */}
      <div
        ref={panelRef}
        className="fixed top-0 right-0 h-full w-80 bg-gray-800 border-l border-gray-700 z-50 flex flex-col shadow-2xl overflow-hidden"
        style={{ animation: 'slideIn 0.2s ease-out' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <h2 className="text-sm font-semibold text-white">Settings</h2>
          <div className="flex items-center gap-2">
            {saveStatus && (
              <span className="text-[10px] text-green-400 animate-pulse">{saveStatus}</span>
            )}
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-white transition-colors p-1"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-700">
          {['agent', 'system', 'visibility'].map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 py-2 text-xs font-medium capitalize transition-colors ${
                activeTab === tab
                  ? 'text-white border-b-2 border-blue-500'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-5">
          {activeTab === 'agent' && (
            <>
              {/* Identity */}
              <Section title="Identity">
                <Field label="Name">
                  <input
                    type="text"
                    defaultValue={config.assistantName || ''}
                    onChange={(e) => saveAgentField({ name: e.target.value.trim() }, true)}
                    className="settings-input"
                    placeholder="Agent name"
                  />
                </Field>
                <Field label="Gender">
                  <select
                    value={effectiveConfig.gender || config?.gender || 'female'}
                    onChange={(e) => saveAgentField({ gender: e.target.value })}
                    className="settings-select"
                  >
                    <option value="female">Female</option>
                    <option value="male">Male</option>
                  </select>
                </Field>
                <Field label="Role">
                  <input
                    type="text"
                    value={effectiveConfig.role || config?.role || ''}
                    onChange={(e) => saveAgentField({ role: e.target.value })}
                    placeholder="e.g. Personal assistant, Creative companion..."
                    className="settings-input"
                  />
                </Field>
                <Field label="Show Image Panel">
                  <Toggle
                    checked={effectiveConfig.showImage !== false}
                    onChange={(v) => saveAgentField({ showImage: v })}
                  />
                </Field>
              </Section>

              {/* Memory */}
              <Section title="Memory" subtitle="How the agent processes context before responding">
                <Field label="Subconscious Memory">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-gray-500 mr-3">
                      Curates goal-driven context via summarizer (uses summary model)
                    </span>
                    <Toggle
                      checked={!!effectiveConfig.subconsciousMemory}
                      onChange={(v) => saveAgentField({ subconsciousMemory: v })}
                    />
                  </div>
                </Field>
                {!!effectiveConfig.subconsciousMemory && (
                  <Field label="Memory Depth">
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min={1}
                        max={3}
                        step={1}
                        value={effectiveConfig.subconsciousDepth || 2}
                        onChange={(e) => saveAgentField({ subconsciousDepth: parseInt(e.target.value) })}
                        className="flex-1 accent-blue-500 h-1.5 cursor-pointer"
                      />
                      <span className="text-[11px] text-gray-400 w-16 text-right font-medium">
                        {['Instant', 'Standard', 'Deep'][(effectiveConfig.subconsciousDepth || 2) - 1]}
                      </span>
                    </div>
                    <div className="flex justify-between text-[9px] text-gray-600 mt-0.5 px-0.5">
                      <span>Speed</span>
                      <span>Depth</span>
                    </div>
                  </Field>
                )}
              </Section>

              {/* Chat Model */}
              <Section title="Chat Model">
                {aiMode === 'local' ? (
                  // Read-only in local mode — the launcher's triplet chooser
                  // is the single source of truth. Per-agent pinning would
                  // silently override the user's launcher selection (and
                  // RoutingService.resolve already ignores it for chat
                  // tasks under local mode), so we hide it entirely.
                  <Field label="Active model">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[12px] text-gray-700">
                        {(() => {
                          const opt = localChatSlot?.options?.find(o => o.model === localChatSlot?.selected)
                          return opt?.label || localChatSlot?.model || 'No local chat model active'
                        })()}
                      </span>
                      <a
                        href="#"
                        className="text-[11px] text-blue-600 hover:underline whitespace-nowrap"
                        onClick={async (e) => {
                          e.preventDefault()
                          try {
                            await fetch(`${baseApiUrl}/api/open-external`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ url: 'http://localhost:9000/triplet.html' })
                            })
                          } catch (err) {
                            console.warn('Failed to open launcher chooser:', err.message)
                          }
                        }}
                      >Change in launcher ↗</a>
                    </div>
                    <p className="text-[10px] text-gray-500 mt-1">Set in os8-launcher's triplet chooser.</p>
                  </Field>
                ) : (
                  <>
                    <Field label="Use Default">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-gray-500">Use AI Chat Model cascade from OS8 Settings</span>
                        <Toggle
                          checked={backendValue === 'auto'}
                          onChange={(v) => {
                            if (v) {
                              saveAgentField({ backend: 'claude', model: 'auto' })
                            } else {
                              const first = backendOptions[0]
                              saveAgentField({ backend: first?.backend || 'claude', model: first?.value || 'claude-sonnet' })
                            }
                          }}
                        />
                      </div>
                    </Field>
                    {backendValue !== 'auto' && (
                      <Field label="Model">
                        <select
                          value={backendValue}
                          onChange={(e) => {
                            const familyId = e.target.value
                            const family = backendOptions.find(o => o.value === familyId)
                            saveAgentField({ backend: family?.backend || 'claude', model: familyId })
                          }}
                          className="settings-select"
                        >
                          {backendOptions.map(o => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      </Field>
                    )}
                  </>
                )}
              </Section>

              {/* Voice */}
              <Section title="Voice" subtitle={(() => {
                const label = providerOptions.find(p => p.value === (ttsProvider || ''))?.label
                return label ? `${label} voices` : undefined
              })()}>
                {loadingVoices ? (
                  <p className="text-[11px] text-gray-500">Loading voices...</p>
                ) : !voiceReady ? (
                  <p className="text-[11px] text-gray-500">Configure a TTS provider in Settings &gt; Voice Output to enable voice.</p>
                ) : (() => {
                  const agentGender = effectiveConfig.gender || config?.gender
                  const userCategories = new Set(['cloned', 'generated'])
                  const filtered = voices.filter(v => {
                    if (userCategories.has(v.category)) return true
                    const voiceGender = v.labels?.gender
                    if (!voiceGender || !agentGender) return true
                    return voiceGender === agentGender
                  })
                  const customVoices = filtered.filter(v => userCategories.has(v.category))
                  const libraryVoices = filtered.filter(v => !userCategories.has(v.category))
                  const sortedVoices = [...customVoices, ...libraryVoices]

                  const currentVoiceId = effectiveConfig.voiceId
                  const currentVoiceName = effectiveConfig.voiceName
                  const selectedVoice = sortedVoices.find(v => v.voiceId === currentVoiceId)
                  const previewUrl = selectedVoice?.previewUrl

                  return (
                    <>
                      <Field label="Voice">
                        <select
                          value={currentVoiceId || ''}
                          onChange={(e) => {
                            const voice = sortedVoices.find(v => v.voiceId === e.target.value)
                            if (voiceAudioRef.current) { voiceAudioRef.current.pause(); setPlayingPreview(null) }
                            if (voice) {
                              saveAgentField({ voiceId: voice.voiceId, voiceName: voice.name })
                            } else {
                              saveAgentField({ voiceId: '', voiceName: '' })
                            }
                          }}
                          className="settings-select"
                        >
                          <option value="">None (use global default)</option>
                          {customVoices.length > 0 && (
                            <optgroup label="Your voices">
                              {customVoices.map(v => (
                                <option key={v.voiceId} value={v.voiceId}>{v.name}</option>
                              ))}
                            </optgroup>
                          )}
                          <optgroup label={customVoices.length > 0 ? 'Library' : 'Voices'}>
                            {libraryVoices.map(v => (
                              <option key={v.voiceId} value={v.voiceId}>{v.name}</option>
                            ))}
                          </optgroup>
                        </select>
                      </Field>
                      {currentVoiceId && (
                        <button
                          type="button"
                          onClick={async () => {
                            if (playingPreview === currentVoiceId) {
                              voiceAudioRef.current?.pause()
                              setPlayingPreview(null)
                              return
                            }
                            if (voiceAudioRef.current) voiceAudioRef.current.pause()
                            setPlayingPreview(currentVoiceId)
                            // Hosted preview (ElevenLabs) — fast path.
                            if (previewUrl) {
                              const audio = new Audio(previewUrl)
                              voiceAudioRef.current = audio
                              audio.play()
                              audio.onended = () => setPlayingPreview(null)
                              audio.onerror = () => setPlayingPreview(null)
                              return
                            }
                            // No hosted preview (Kokoro, OpenAI) — generate via /api/speak.
                            try {
                              const res = await fetch(`${baseApiUrl}/api/speak`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                  text: `Hi, I'm ${selectedVoice?.name || currentVoiceName || 'a voice sample'}.`,
                                  voiceId: currentVoiceId,
                                  returnBase64: true
                                })
                              })
                              if (!res.ok) throw new Error(`speak returned ${res.status}`)
                              const data = await res.json()
                              if (!data.base64) throw new Error('no audio in response')
                              const audio = new Audio(`data:${data.mimeType || 'audio/mpeg'};base64,${data.base64}`)
                              voiceAudioRef.current = audio
                              audio.play()
                              audio.onended = () => setPlayingPreview(null)
                              audio.onerror = () => setPlayingPreview(null)
                            } catch (err) {
                              console.warn('Voice preview failed:', err)
                              setPlayingPreview(null)
                            }
                          }}
                          className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                        >
                          {playingPreview === currentVoiceId ? 'Stop sample' : 'Play sample'}
                        </button>
                      )}
                      {currentVoiceId && !selectedVoice && currentVoiceName && (
                        <p className="text-[10px] text-gray-500">Current: {currentVoiceName} (not in filtered list)</p>
                      )}
                    </>
                  )
                })()}
              </Section>

              {/* Pinned Capabilities */}
              <Section title="Capabilities" subtitle="Pinned capabilities appear in every message">
                <div className="flex gap-1 mb-2">
                  {['pinned', 'all'].map(f => (
                    <button
                      key={f}
                      onClick={() => setCapFilter(f)}
                      className={`px-2 py-0.5 text-[10px] rounded-md transition-colors ${
                        capFilter === f ? 'bg-gray-600 text-white' : 'text-gray-500 hover:text-gray-300'
                      }`}
                    >
                      {f === 'pinned' ? 'Pinned' : 'All'}
                    </button>
                  ))}
                </div>
                {(() => {
                  const filtered = capFilter === 'pinned'
                    ? capabilities.filter(c => c.pinned)
                    : capabilities.filter(c => c.available)
                  if (filtered.length === 0) {
                    return <p className="text-[11px] text-gray-500">
                      {capFilter === 'pinned' ? 'No pinned capabilities. Switch to "All" to pin some.' : 'No capabilities available.'}
                    </p>
                  }

                  const togglePin = async (cap) => {
                    try {
                      if (cap.pinned) {
                        await fetch(`${baseApiUrl}/api/skills/agent/${agentId}/pin/${cap.id}`, { method: 'DELETE' })
                      } else {
                        await fetch(`${baseApiUrl}/api/skills/agent/${agentId}/pin`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ skillId: cap.id })
                        })
                      }
                      // Refresh capabilities
                      const res = await fetch(`${baseApiUrl}/api/skills/registry?agentId=${agentId}`)
                      const data = await res.json()
                      setCapabilities(Array.isArray(data) ? data : [])
                      showSaved()
                    } catch (err) {
                      console.error('Failed to toggle pin:', err)
                    }
                  }

                  return filtered.map(cap => (
                    <div key={cap.id} className="flex items-center justify-between py-1.5 px-2 rounded-md hover:bg-gray-700/50 transition-colors">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded ${
                          cap.type === 'api' ? 'bg-blue-500/20 text-blue-400' : 'bg-purple-500/20 text-purple-400'
                        }`}>
                          {cap.type === 'api' ? 'API' : 'SKILL'}
                        </span>
                        <span className="text-xs text-gray-300 truncate">{cap.name}</span>
                      </div>
                      <button
                        onClick={() => togglePin(cap)}
                        className={`text-[10px] px-2 py-0.5 rounded transition-colors ${
                          cap.pinned
                            ? 'text-yellow-400 hover:text-yellow-300'
                            : 'text-gray-500 hover:text-gray-300'
                        }`}
                        title={cap.pinned ? 'Unpin' : 'Pin'}
                      >
                        {cap.pinned ? '★' : '☆'}
                      </button>
                    </div>
                  ))
                })()}
              </Section>

              {/* Telegram */}
              <Section title="Mobile Communication (Telegram)">
                <Field label="Bot Username">
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={effectiveConfig.telegramBotUsername || ''}
                      onChange={(e) => saveAgentField({ telegramBotUsername: e.target.value }, true)}
                      placeholder="@my_agent_bot"
                      className="settings-input flex-1"
                    />
                  </div>
                </Field>
                <Field label="Bot Token">
                  <div className="flex items-center gap-1.5">
                    <input
                      type="password"
                      value={effectiveConfig.telegramBotToken || ''}
                      onChange={(e) => saveAgentField({ telegramBotToken: e.target.value }, true)}
                      placeholder="Paste bot token from @BotFather"
                      className="settings-input flex-1"
                    />
                  </div>
                  {effectiveConfig.telegramBotUsername && effectiveConfig.telegramBotToken ? (
                    <button
                      onClick={() => setShowTelegramDelete(true)}
                      className="text-[11px] text-red-400 hover:text-red-300 mt-1.5 cursor-pointer bg-transparent border-none p-0"
                    >
                      Delete Telegram Bot
                    </button>
                  ) : (
                    <button
                      onClick={() => setShowTelegramHelp(true)}
                      className="text-[11px] text-blue-400 hover:text-blue-300 mt-1.5 cursor-pointer bg-transparent border-none p-0"
                    >
                      Create Telegram Bot
                    </button>
                  )}
                </Field>
              </Section>

              {/* Delete Agent */}
              <Section title="Danger Zone">
                {!showDeleteConfirm ? (
                  <button
                    onClick={() => { setShowDeleteConfirm(true); setDeleteInput('') }}
                    className="w-full py-2 text-sm text-red-400 border border-red-400/30 rounded-lg hover:bg-red-400/10 transition-colors"
                  >
                    Delete Agent
                  </button>
                ) : (
                  <div className="space-y-3">
                    <p className="text-xs text-red-400">
                      This will permanently delete <strong>{config?.assistantName || 'this agent'}</strong> and all their data. This cannot be undone.
                    </p>
                    <Field label={<span className="text-red-400">Type DELETE to confirm</span>}>
                      <input
                        type="text"
                        value={deleteInput}
                        onChange={(e) => setDeleteInput(e.target.value)}
                        placeholder="DELETE"
                        className="settings-input"
                        style={{ borderColor: 'rgba(248, 113, 113, 0.3)' }}
                        autoFocus
                      />
                    </Field>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setShowDeleteConfirm(false)}
                        className="flex-1 py-2 text-xs text-gray-400 bg-gray-700 rounded-lg hover:bg-gray-600 transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={async () => {
                          setDeleting(true)
                          try {
                            await fetch(`${baseApiUrl}/api/agents/${agentId}`, { method: 'DELETE' })
                            setShowDeleteConfirm(false)
                            onClose()
                            onAgentDeleted?.()
                          } catch (err) {
                            console.error('Failed to delete agent:', err)
                          } finally {
                            setDeleting(false)
                          }
                        }}
                        disabled={deleteInput !== 'DELETE' || deleting}
                        className="flex-1 py-2 text-xs text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      >
                        {deleting ? 'Deleting...' : 'Delete Forever'}
                      </button>
                    </div>
                  </div>
                )}
              </Section>
            </>
          )}

          {activeTab === 'visibility' && (
            <>
              <Section title="Agent Visibility" subtitle="Control which agents are active and visible">
                <p className="text-[10px] text-gray-500 mb-3">
                  <span className="text-blue-400">Visible</span> — normal, appears everywhere.{' '}
                  <span className="text-yellow-400">Hidden</span> — runs jobs and monitors, but not in chat selectors.{' '}
                  <span className="text-red-400">Off</span> — fully inactive, no jobs or monitoring.
                </p>
                <div className="space-y-2">
                  {allAgents.map(agent => {
                    const vis = agent.visibility || 'visible'
                    return (
                      <div key={agent.id} className="flex items-center justify-between py-2 px-2 rounded-lg bg-gray-700/30">
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                            style={{ backgroundColor: vis === 'visible' ? '#3b82f6' : vis === 'hidden' ? '#eab308' : '#ef4444' }}
                          />
                          <span className="text-xs text-gray-200 truncate">{agent.name}</span>
                        </div>
                        <div className="flex bg-gray-700 rounded-md overflow-hidden flex-shrink-0">
                          {[
                            { value: 'visible', label: 'Visible', color: 'blue' },
                            { value: 'hidden', label: 'Hidden', color: 'yellow' },
                            { value: 'off', label: 'Off', color: 'red' }
                          ].map(opt => (
                            <button
                              key={opt.value}
                              onClick={async () => {
                                if (vis === opt.value) return
                                // Optimistic update
                                setAllAgents(prev => prev.map(a =>
                                  a.id === agent.id ? { ...a, visibility: opt.value } : a
                                ))
                                try {
                                  const res = await fetch(`${baseApiUrl}/api/agents/${agent.id}`, {
                                    method: 'PATCH',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ visibility: opt.value })
                                  })
                                  if (!res.ok) {
                                    const err = await res.json()
                                    // Revert on error
                                    setAllAgents(prev => prev.map(a =>
                                      a.id === agent.id ? { ...a, visibility: vis } : a
                                    ))
                                    alert(err.error || 'Failed to update')
                                  } else {
                                    showSaved()
                                    onAgentsChanged?.()
                                  }
                                } catch {
                                  setAllAgents(prev => prev.map(a =>
                                    a.id === agent.id ? { ...a, visibility: vis } : a
                                  ))
                                }
                              }}
                              className={`px-2 py-1 text-[10px] font-medium transition-colors ${
                                vis === opt.value
                                  ? opt.color === 'blue' ? 'bg-blue-600 text-white'
                                    : opt.color === 'yellow' ? 'bg-yellow-600 text-white'
                                    : 'bg-red-600 text-white'
                                  : 'text-gray-400 hover:text-gray-200'
                              }`}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </Section>
            </>
          )}

          {activeTab === 'system' && (
            <>
              {/* Default Voices */}
              <Section title="Voice" subtitle={(() => {
                const currentLabel = providerOptions.find(p => p.value === (ttsProvider || ''))?.label
                if (voiceReady && ttsProvider && currentLabel) {
                  return `${currentLabel} — default voices for agents without a voice assigned`
                }
                return 'Default voices for agents without a voice assigned'
              })()}>
                {/* TTS Provider Toggle */}
                <Field label="Provider">
                  <div className="flex gap-1">
                    {providerOptions.map(opt => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => switchProvider(opt.value)}
                        className={`px-3 py-1 text-[11px] rounded transition-colors ${
                          (ttsProvider || '') === opt.value
                            ? 'bg-blue-600 text-white'
                            : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                        }`}
                        title={opt.help || undefined}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  {aiMode && (
                    <p className="text-[10px] text-gray-500 mt-1">
                      {aiMode === 'local'
                        ? 'os8 is in local mode — only local providers are shown.'
                        : 'os8 is in cloud mode — only cloud providers are shown.'}
                    </p>
                  )}
                  {providerSource === 'none' && (
                    <p className="text-[11px] text-amber-400 mt-1">
                      {aiMode === 'local'
                        ? 'No local TTS provider is available — start os8-launcher and ensure the Kokoro model is serving.'
                        : 'No cloud TTS provider is configured — add an ElevenLabs or OpenAI API key in os8 Settings → API Keys.'}
                    </p>
                  )}
                  {ttsStatus && ttsProvider && (
                    <p className={`text-[10px] mt-1 ${ttsStatus.available ? 'text-green-400' : 'text-red-400'}`}>
                      {ttsStatus.available ? 'Ready' : (TTS_STATUS_MESSAGES[ttsStatus.reason] || ttsStatus.reason || 'Unknown')}
                    </p>
                  )}
                </Field>

                {!voiceReady ? (
                  <p className="text-[11px] text-gray-500">{ttsProvider ? 'Configuring provider...' : 'Voice output will be available once a provider is configured.'}</p>
                ) : (() => {
                  const femaleVoices = voices.filter(v => {
                    const g = v.labels?.gender
                    return !g || g === 'female'
                  })
                  const maleVoices = voices.filter(v => {
                    const g = v.labels?.gender
                    return !g || g === 'male'
                  })

                  const saveDefaultVoice = (gender, voiceId) => {
                    const voice = voices.find(v => v.voiceId === voiceId)
                    const updates = gender === 'male'
                      ? { defaultVoiceMale: voiceId, defaultVoiceMaleName: voice?.name || '' }
                      : { defaultVoiceFemale: voiceId, defaultVoiceFemaleName: voice?.name || '' }
                    saveTtsSetting(updates)
                  }

                  const playPreview = async (voiceId) => {
                    const voice = voices.find(v => v.voiceId === voiceId)
                    if (!voice) return
                    // Toggle: clicking the currently-playing voice stops it.
                    if (playingDefaultPreview === voiceId) {
                      defaultAudioRef.current?.pause()
                      setPlayingDefaultPreview(null)
                      return
                    }
                    if (defaultAudioRef.current) defaultAudioRef.current.pause()
                    setPlayingDefaultPreview(voiceId)

                    // Provider-supplied previewUrl (ElevenLabs) — fast path.
                    if (voice.previewUrl) {
                      const audio = new Audio(voice.previewUrl)
                      defaultAudioRef.current = audio
                      audio.play()
                      audio.onended = () => setPlayingDefaultPreview(null)
                      audio.onerror = () => setPlayingDefaultPreview(null)
                      return
                    }
                    // No hosted preview (Kokoro, OpenAI) — generate one on-demand
                    // via /api/speak with a short canned phrase. Slower (one
                    // round-trip + audio decode) but works for any provider.
                    try {
                      const res = await fetch(`${baseApiUrl}/api/speak`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          text: `Hi, I'm ${voice.name || 'a voice sample'}.`,
                          voiceId,
                          returnBase64: true
                        })
                      })
                      if (!res.ok) throw new Error(`speak returned ${res.status}`)
                      const data = await res.json()
                      if (!data.base64) throw new Error('no audio in response')
                      const audio = new Audio(`data:${data.mimeType || 'audio/mpeg'};base64,${data.base64}`)
                      defaultAudioRef.current = audio
                      audio.play()
                      audio.onended = () => setPlayingDefaultPreview(null)
                      audio.onerror = () => setPlayingDefaultPreview(null)
                    } catch (err) {
                      console.warn('Voice preview failed:', err)
                      setPlayingDefaultPreview(null)
                    }
                  }

                  return (
                    <>
                      <Field label="Female default">
                        <select
                          value={defaultVoiceFemale}
                          onChange={(e) => {
                            setDefaultVoiceFemale(e.target.value)
                            saveDefaultVoice('female', e.target.value)
                          }}
                          className="settings-select"
                        >
                          {femaleVoices.map(v => (
                            <option key={v.voiceId} value={v.voiceId}>{v.name}</option>
                          ))}
                        </select>
                        {defaultVoiceFemale && (
                          <button
                            type="button"
                            onClick={() => playPreview(defaultVoiceFemale)}
                            className="text-xs text-blue-400 hover:text-blue-300 transition-colors mt-1"
                          >
                            {playingDefaultPreview === defaultVoiceFemale ? 'Stop sample' : 'Play sample'}
                          </button>
                        )}
                      </Field>
                      <Field label="Male default">
                        <select
                          value={defaultVoiceMale}
                          onChange={(e) => {
                            setDefaultVoiceMale(e.target.value)
                            saveDefaultVoice('male', e.target.value)
                          }}
                          className="settings-select"
                        >
                          {maleVoices.map(v => (
                            <option key={v.voiceId} value={v.voiceId}>{v.name}</option>
                          ))}
                        </select>
                        {defaultVoiceMale && (
                          <button
                            type="button"
                            onClick={() => playPreview(defaultVoiceMale)}
                            className="text-xs text-blue-400 hover:text-blue-300 transition-colors mt-1"
                          >
                            {playingDefaultPreview === defaultVoiceMale ? 'Stop sample' : 'Play sample'}
                          </button>
                        )}
                      </Field>
                    </>
                  )
                })()}

                {/* Voice Output Settings */}
                <div className="border-t border-gray-700/50 mt-3 pt-3">
                  <p className="text-[10px] text-gray-500 mb-2">Voice Output</p>
                </div>
                <Field label="Enable Voice Output">
                  <Toggle
                    checked={ttsEnabled}
                    onChange={(v) => {
                      setTtsEnabled(v)
                      saveTtsSetting({ enabled: v })
                    }}
                  />
                </Field>
                <Field label="Interrupt on Input">
                  <Toggle
                    checked={ttsInterruptOnInput}
                    onChange={(v) => {
                      setTtsInterruptOnInput(v)
                      saveTtsSetting({ interruptOnInput: v })
                    }}
                  />
                </Field>
                {ttsProvider === 'elevenlabs' && (
                  <>
                    <Field label={`Stability: ${ttsStability}%`}>
                      <input
                        type="range"
                        min="0" max="100" step="5"
                        value={ttsStability}
                        onChange={(e) => {
                          const val = parseInt(e.target.value, 10)
                          setTtsStability(val)
                          saveTtsSetting({ stability: val / 100 })
                        }}
                        className="w-full accent-blue-500"
                      />
                    </Field>
                    <Field label={`Similarity Boost: ${ttsSimilarityBoost}%`}>
                      <input
                        type="range"
                        min="0" max="100" step="5"
                        value={ttsSimilarityBoost}
                        onChange={(e) => {
                          const val = parseInt(e.target.value, 10)
                          setTtsSimilarityBoost(val)
                          saveTtsSetting({ similarityBoost: val / 100 })
                        }}
                        className="w-full accent-blue-500"
                      />
                    </Field>
                  </>
                )}
                <Field label={`Speed: ${(ttsSpeed / 100).toFixed(2)}x`}>
                  <input
                    type="range"
                    min="70" max="120" step="5"
                    value={ttsSpeed}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10)
                      setTtsSpeed(val)
                      saveTtsSetting({ speed: val / 100 })
                    }}
                    className="w-full accent-blue-500"
                  />
                </Field>
              </Section>

              <Section title="Telegram" >
                <Field label="Enable Monitoring">
                  <Toggle
                    checked={telegramEnabled}
                    onChange={(v) => {
                      setTelegramEnabled(v)
                      fetch(`${baseApiUrl}/api/settings/telegram`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ enabled: v })
                      })
                        .then(() => showSaved())
                        .catch(err => console.error('Failed to save telegram setting:', err))
                    }}
                  />
                </Field>
              </Section>

              <Section title="Response Timeout" >
                <Field label="Max response time">
                  <select
                    value={responseTimeout}
                    onChange={(e) => {
                      const val = parseInt(e.target.value)
                      setResponseTimeout(val)
                      fetch(`${baseApiUrl}/api/settings/response-timeout`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ timeoutMs: val })
                      })
                        .then(() => showSaved())
                        .catch(err => console.error('Failed to save response timeout:', err))
                    }}
                    className="settings-select"
                  >
                    {TIMEOUT_OPTIONS.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </Field>
              </Section>

              <Section title="Default Agent" >
                <Field label="Agent for new conversations">
                  <select
                    value={defaultAgentId || ''}
                    onChange={(e) => {
                      const id = e.target.value
                      setDefaultAgentId(id)
                      fetch(`${baseApiUrl}/api/agents/${id}/default`, { method: 'POST' })
                        .then(() => showSaved())
                        .catch(err => console.error('Failed to set default agent:', err))
                    }}
                    className="settings-select"
                  >
                    {agents.map(a => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </Field>
              </Section>

              <Section title="Agent Chat" >
                <Field label="Daily message limit">
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min="0"
                      max="100"
                      step="5"
                      value={dailyLimit}
                      onChange={(e) => {
                        const val = parseInt(e.target.value)
                        setDailyLimit(val)
                        fetch(`${baseApiUrl}/api/settings/agent-chat`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ dailyLimit: val })
                        })
                          .then(() => showSaved())
                          .catch(err => console.error('Failed to save daily limit:', err))
                      }}
                      className="flex-1"
                      style={{ accentColor: '#6366f1' }}
                    />
                    <span className="text-xs text-gray-300 min-w-[32px] text-right">
                      {dailyLimit === 0 ? '∞' : dailyLimit}
                    </span>
                  </div>
                </Field>
                <Field label="Conversation turn limit">
                  <div className="flex items-center gap-2">
                    <select
                      value={circuitBreakerLimit}
                      onChange={(e) => {
                        const val = parseInt(e.target.value)
                        setCircuitBreakerLimit(val)
                        fetch(`${baseApiUrl}/api/settings/agent-chat`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ circuitBreakerLimit: val })
                        })
                          .then(() => showSaved())
                          .catch(err => console.error('Failed to save circuit breaker limit:', err))
                      }}
                      className="settings-select"
                    >
                      <option value="10">10 turns</option>
                      <option value="20">20 turns</option>
                      <option value="30">30 turns</option>
                      <option value="40">40 turns</option>
                      <option value="50">50 turns</option>
                      <option value="0">Unlimited</option>
                    </select>
                  </div>
                </Field>
              </Section>
            </>
          )}
        </div>
      </div>

      <style>{`
        @keyframes slideIn {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
        .settings-input {
          width: 100%;
          background: #374151;
          color: white;
          border: 1px solid #4b5563;
          border-radius: 6px;
          padding: 5px 8px;
          font-size: 12px;
          outline: none;
        }
        .settings-input:focus {
          border-color: #6b7280;
        }
        .settings-select {
          width: 100%;
          background: #374151;
          color: white;
          border: 1px solid #4b5563;
          border-radius: 6px;
          padding: 5px 8px;
          font-size: 12px;
          outline: none;
          cursor: pointer;
        }
        .settings-select:focus {
          border-color: #6b7280;
        }
      `}</style>

      {showTelegramHelp && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowTelegramHelp(false)}>
          <div className="bg-gray-800 rounded-xl p-5 max-w-md w-full mx-4 shadow-2xl border border-gray-700" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-white">Create a Telegram Bot</h3>
              <button onClick={() => setShowTelegramHelp(false)} className="text-gray-400 hover:text-white text-lg leading-none">&times;</button>
            </div>
            <div className="space-y-3 text-xs text-gray-300 leading-relaxed">
              <div>
                <p className="font-medium text-white mb-1">1. Open BotFather</p>
                <p>Open Telegram and search for <span className="text-blue-400 font-mono">@BotFather</span>, or tap the link in your Telegram app. BotFather is Telegram's official bot for creating and managing bots.</p>
              </div>
              <div>
                <p className="font-medium text-white mb-1">2. Create a new bot</p>
                <p>Send the command <span className="text-blue-400 font-mono">/newbot</span> to BotFather. It will ask you for a display name (e.g. "My Agent") and then a username that must end in "bot" (e.g. "my_agent_bot").</p>
              </div>
              <div>
                <p className="font-medium text-white mb-1">3. Copy the token</p>
                <p>BotFather will reply with an API token that looks like <span className="text-blue-400 font-mono">123456:ABC-DEF1234...</span>. Copy this token and paste it into the Bot Token field above.</p>
              </div>
              <div>
                <p className="font-medium text-white mb-1">4. Connect with your bot</p>
                <p>Search for your bot by its username in Telegram, open the chat, and send <span className="text-blue-400 font-mono">/start</span>. This registers your account so the agent knows who to message. Once connected, you can chat with your agent directly through Telegram.</p>
              </div>
            </div>
            <button
              onClick={() => setShowTelegramHelp(false)}
              className="mt-4 w-full py-2 text-xs text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors"
            >
              Got it
            </button>
          </div>
        </div>
      )}

      {showTelegramDelete && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowTelegramDelete(false)}>
          <div className="bg-gray-800 rounded-xl p-5 max-w-md w-full mx-4 shadow-2xl border border-gray-700" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-white">Delete Telegram Bot</h3>
              <button onClick={() => setShowTelegramDelete(false)} className="text-gray-400 hover:text-white text-lg leading-none">&times;</button>
            </div>
            <div className="space-y-3 text-xs text-gray-300 leading-relaxed">
              <div>
                <p className="font-medium text-white mb-1">1. Open BotFather</p>
                <p>Open Telegram and search for <span className="text-blue-400 font-mono">@BotFather</span> (the same bot you used to create it).</p>
              </div>
              <div>
                <p className="font-medium text-white mb-1">2. Delete the bot</p>
                <p>Send the command <span className="text-blue-400 font-mono">/deletebot</span> to BotFather. It will show you a list of your bots — select the one you want to remove.</p>
              </div>
              <div>
                <p className="font-medium text-white mb-1">3. Confirm deletion</p>
                <p>BotFather will ask you to confirm. Once confirmed, the bot is permanently deleted from Telegram and can no longer send or receive messages.</p>
              </div>
            </div>
            <p className="text-xs text-gray-500 mt-4 mb-3">
              After deleting the bot on Telegram, click below to clear the saved credentials from this agent.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowTelegramDelete(false)}
                className="flex-1 py-2 text-xs text-gray-400 hover:text-gray-200 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  saveAgentField({ telegramBotUsername: '', telegramBotToken: '' })
                  setShowTelegramDelete(false)
                }}
                className="flex-1 py-2 text-xs text-white bg-red-600 hover:bg-red-500 rounded-lg transition-colors"
              >
                Clear Bot Credentials
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function Section({ title, subtitle, children }) {
  return (
    <div>
      <h3 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2">{title}</h3>
      {subtitle && <p className="text-[10px] text-gray-500 -mt-1 mb-2">{subtitle}</p>}
      <div className="space-y-3">{children}</div>
    </div>
  )
}

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-xs text-gray-400 mb-1">{label}</label>
      {children}
    </div>
  )
}

function Toggle({ checked, onChange }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative w-9 h-5 rounded-full transition-colors ${checked ? 'bg-blue-600' : 'bg-gray-600'}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${checked ? 'translate-x-4' : ''}`}
      />
    </button>
  )
}

export default SettingsPanel
