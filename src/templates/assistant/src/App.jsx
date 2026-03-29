import { useState, useEffect, useRef, useCallback, Component } from 'react'
import { Routes, Route } from 'react-router-dom'
import Chat from './components/Chat'
import ImageView from './components/ImageView'
import SettingsPanel from './components/SettingsPanel'
import SetupScreen from './components/SetupScreen'
import ThreadSidebar from './components/ThreadSidebar'
import ThreadView from './components/ThreadView'
import ThreadImagePanel from './components/ThreadImagePanel'
import AgentLifePanel from './components/AgentLifePanel'

class ErrorBoundary extends Component {
  state = { hasError: false, error: null }
  static getDerivedStateFromError(error) { return { hasError: true, error } }
  componentDidCatch(error, info) { console.error('ErrorBoundary caught:', error, info) }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-gray-900">
          <div className="text-center p-6">
            <p className="text-sm text-gray-300 mb-2">Something went wrong</p>
            <p className="text-xs text-gray-500 mb-4">{this.state.error?.message}</p>
            <button
              onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload() }}
              className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700"
            >
              Reload
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

function Tooltip({ text, children }) {
  return (
    <div className="relative group">
      {children}
      <div className="absolute top-full mt-1 right-0 px-2 py-1 bg-gray-900 text-gray-200 text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity delay-300 z-50">
        {text}
      </div>
    </div>
  )
}

function App() {
  const [showSettings, setShowSettings] = useState(false)
  const [config, setConfig] = useState(null)
  const [imageCollapsed, setImageCollapsed] = useState(false)
  const [imageWidth, setImageWidth] = useState(30)

  // Agent management
  const [agents, setAgents] = useState([])
  const [selectedAgentId, setSelectedAgentId] = useState(null)
  const [showAgentDropdown, setShowAgentDropdown] = useState(false)
  const [showNewAgent, setShowNewAgent] = useState(false)
  const [newAgentName, setNewAgentName] = useState('')
  const [creatingAgent, setCreatingAgent] = useState(false)
  const [aiReady, setAiReady] = useState(null) // null = loading, true/false
  const [agentsLoaded, setAgentsLoaded] = useState(false)
  const agentDropdownRef = useRef(null)

  // Thread state
  const [showThreads, setShowThreads] = useState(false)
  const [activeThread, setActiveThread] = useState(null) // null = 1:1 chat, object = thread view
  const [threadImageCollapsed, setThreadImageCollapsed] = useState(false)

  // Agent Life panel
  const [contextData, setContextData] = useState(null)
  const [contextTab, setContextTab] = useState('conscious') // 'conscious' or 'raw'
  const [agentLifeOpen, setAgentLifeOpen] = useState(false)
  const [agentLifeHeight, setAgentLifeHeight] = useState(35) // percent of main area
  const [agentLifeActiveTab, setAgentLifeActiveTab] = useState('memory')
  const [contextLoading, setContextLoading] = useState(false)

  // UI state persistence
  const [uiStateLoaded, setUiStateLoaded] = useState(false)
  const savedUiStateRef = useRef(null)

  const currentPort = window.location.port || '8888'
  const baseApiUrl = `http://localhost:${currentPort}`

  // Get the app's base path (/{appId}) and appId
  const appId = window.location.pathname.split('/').filter(Boolean)[0]
  const basePath = '/' + appId

  // Derive initial agent display slug from URL path (/{appId}/{displaySlug})
  const getInitialDisplaySlug = () => {
    const pathParts = window.location.pathname.split('/').filter(Boolean)
    // pathParts[0] = appId, pathParts[1] = display slug (e.g., 'lisa')
    const slug = pathParts[1] || null
    // 'new' is the create-agent route, not an agent slug
    return slug === 'new' ? null : slug
  }

  // Get display slug for an agent (strips 'agent-' prefix from DB slug)
  const getDisplaySlug = (id, agentsList) => {
    const agent = (agentsList || agents).find(a => a.id === id)
    return agent?.slug?.replace(/^agent-/, '') || id
  }

  // Update URL path to reflect selected agent (triggers shell onUrlChanged)
  const setAgentUrl = (displaySlug) => {
    history.replaceState(null, '', `${basePath}/${displaySlug}`)
  }

  // Load persisted UI state on mount, then load agents (sequential to avoid race)
  useEffect(() => {
    fetch(`${baseApiUrl}/api/assistant/ui-state`)
      .then(r => r.json())
      .then(saved => {
        if (saved.imageCollapsed != null) setImageCollapsed(saved.imageCollapsed)
        if (saved.imageWidth != null) setImageWidth(saved.imageWidth)
        if (saved.agentLifeOpen != null) setAgentLifeOpen(saved.agentLifeOpen)
        if (saved.agentLifeActiveTab) setAgentLifeActiveTab(saved.agentLifeActiveTab)
        if (saved.agentLifeHeight != null) setAgentLifeHeight(saved.agentLifeHeight)
        if (saved.showThreads != null) setShowThreads(saved.showThreads)
        if (saved.threadImageCollapsed != null) setThreadImageCollapsed(saved.threadImageCollapsed)
        if (saved.contextTab) setContextTab(saved.contextTab)
        savedUiStateRef.current = saved
      })
      .catch(() => {})
      .finally(() => {
        setUiStateLoaded(true)
        loadAgents()
      })
    fetch(`${baseApiUrl}/api/ai/ready`)
      .then(r => r.json())
      .then(data => setAiReady(!!data.ready))
      .catch(() => setAiReady(false))
  }, [])

  // Close dropdown on outside click
  useEffect(() => {
    const handleClick = (e) => {
      if (agentDropdownRef.current && !agentDropdownRef.current.contains(e.target)) {
        setShowAgentDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  // Get agent API base for a given agent ID
  const getAgentApiBase = useCallback((agentId) => {
    const id = agentId || selectedAgentId
    if (id) return `${baseApiUrl}/api/agent/${id}`
    return `${baseApiUrl}/api/assistant`
  }, [selectedAgentId, baseApiUrl])

  // Load agents list
  const loadAgents = useCallback(async ({ forceReselect = false } = {}) => {
    try {
      const res = await fetch(`${baseApiUrl}/api/agents?filter=visible`)
      const data = await res.json()
      const agentsList = data.agents || []
      setAgents(agentsList)
      setAgentsLoaded(true)

      // If currently selected agent is no longer in the visible list, force reselect
      const currentGone = selectedAgentId && !agentsList.some(a => a.id === selectedAgentId)

      // Set initial selected agent from URL path display slug
      if (!selectedAgentId || forceReselect || currentGone) {
        const displaySlug = getInitialDisplaySlug()
        let initialId = null
        if (!forceReselect && !currentGone && displaySlug) {
          // Match display slug (e.g., 'lisa') to DB slug (e.g., 'agent-lisa')
          const bySlug = agentsList.find(a => a.slug === `agent-${displaySlug}`)
          // Fallback: try as raw ID or full slug for backward compat
          const byId = agentsList.find(a => a.id === displaySlug || a.slug === displaySlug)
          if (bySlug) initialId = bySlug.id
          else if (byId) initialId = byId.id
        }
        // Try saved UI state agent (persisted from last session)
        if (!initialId && savedUiStateRef.current?.selectedAgentId) {
          const savedId = savedUiStateRef.current.selectedAgentId
          if (agentsList.some(a => a.id === savedId)) initialId = savedId
        }
        if (!initialId && agentsList.length > 0) {
          initialId = agentsList[0].id
        }
        if (initialId) {
          setSelectedAgentId(initialId)
          setAgentUrl(getDisplaySlug(initialId, agentsList))
        } else {
          // No agents exist — clear selection and navigate to /new so zero-agents UI shows
          setSelectedAgentId(null)
          history.replaceState(null, '', `${basePath}/new`)
        }
      }
    } catch (err) {
      console.error('Failed to load agents:', err)
    }
  }, [baseApiUrl, selectedAgentId])

  // Load config for selected agent
  const loadConfig = useCallback(() => {
    if (!selectedAgentId) return
    fetch(getAgentApiBase(selectedAgentId) + '/config')
      .then(res => res.json())
      .then(data => setConfig(data))
      .catch(err => {
        console.error('Failed to load config:', err)
        setConfig({ assistantName: 'Assistant', ownerName: '' })
      })
  }, [selectedAgentId, getAgentApiBase])

  // Optimistically apply config changes from settings panel
  // Maps PATCH field names to config field names where they differ
  const handleConfigChange = useCallback((updates) => {
    const mapped = {}
    const keyMap = { name: 'assistantName', backend: 'agentBackend', model: 'agentModel' }
    for (const [k, v] of Object.entries(updates)) {
      mapped[keyMap[k] || k] = v
    }
    setConfig(prev => prev ? { ...prev, ...mapped } : prev)
  }, [])

  // Handle backend errors by resetting setup so user can re-authenticate
  const handleBackendError = useCallback((errorMsg) => {
    // Reset setupComplete locally to show setup screen
    setConfig(prev => prev ? { ...prev, setupComplete: false } : prev)
    // Also reset in DB so it persists across reloads
    fetch(`${baseApiUrl}/api/agents/${selectedAgentId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setupComplete: false })
    }).catch(() => {})
  }, [baseApiUrl, selectedAgentId])

  // Fetch agent context for the Agent Life panel
  const fetchContext = useCallback(async () => {
    if (!selectedAgentId) return
    setContextLoading(true)
    try {
      const resp = await fetch(`${baseApiUrl}/api/agent/${selectedAgentId}/context`)
      if (!resp.ok) { setContextData(null); return }
      setContextData(await resp.json())
    } catch { setContextData(null) }
    finally { setContextLoading(false) }
  }, [selectedAgentId, baseApiUrl])

  // Stable callback for Chat onMessageComplete (ref pattern avoids EventSource recreation)
  const handleMessageComplete = useCallback(() => {
    if (agentLifeOpen) fetchContext()
  }, [agentLifeOpen, fetchContext])

  const handleMessageCompleteRef = useRef(handleMessageComplete)
  useEffect(() => { handleMessageCompleteRef.current = handleMessageComplete }, [handleMessageComplete])

  const stableMessageComplete = useCallback(() => {
    handleMessageCompleteRef.current?.()
  }, [])

  // Note: loadAgents() is called from the UI state load effect (sequential)
  // AI readiness check also runs there in parallel

  // Load config when selected agent changes
  useEffect(() => {
    if (selectedAgentId) loadConfig()
  }, [selectedAgentId])

  // Mask URL to /new while agent setup is incomplete
  useEffect(() => {
    if (config && !config.setupComplete && selectedAgentId) {
      history.replaceState(null, '', `${basePath}/new`)
    }
  }, [config, selectedAgentId])

  // Reload config when tab becomes visible (skip agent list reload during setup)
  const setupInProgressRef = useRef(false)
  useEffect(() => {
    setupInProgressRef.current = !!(config && !config.setupComplete && selectedAgentId)
  }, [config, selectedAgentId])
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        loadConfig()
        if (!setupInProgressRef.current) {
          loadAgents()
        }
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    const handleTtsChanged = () => loadConfig()
    window.addEventListener('tts-settings-changed', handleTtsChanged)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('tts-settings-changed', handleTtsChanged)
    }
  }, [loadConfig, loadAgents])

  // Auto-fetch context when panel opens or agent changes
  useEffect(() => {
    if (agentLifeOpen && selectedAgentId) fetchContext()
  }, [selectedAgentId, agentLifeOpen])

  // Restore active thread from saved UI state
  useEffect(() => {
    const savedThreadId = savedUiStateRef.current?.activeThreadId
    if (uiStateLoaded && showThreads && savedThreadId && selectedAgentId && !activeThread) {
      fetch(`${baseApiUrl}/api/agent-chat/threads/${savedThreadId}`)
        .then(r => r.ok ? r.json() : null)
        .then(thread => { if (thread) setActiveThread(thread) })
        .catch(() => {})
    }
  }, [uiStateLoaded, showThreads, selectedAgentId])

  // Switch agent — also update URL path for shell sidebar scoping
  const handleSelectAgent = (agentId) => {
    setSelectedAgentId(agentId)
    setShowAgentDropdown(false)
    setActiveThread(null) // Return to 1:1 chat
    setConfig(null) // Reset config to show loading
    setContextData(null) // Clear stale context
    // Communicate scope to OS8 shell via URL path
    setAgentUrl(getDisplaySlug(agentId))
  }

  // Thread sidebar: select a thread
  const handleSelectThread = (thread) => {
    setActiveThread(thread)
    setThreadImageCollapsed(false)
    // For group threads, scope shell right panel to the first participant
    if (thread?.type === 'group') {
      const parts = JSON.parse(thread.participants || '[]')
      const firstAgent = parts.find(p => p !== 'user')
      if (firstAgent) {
        setSelectedAgentId(firstAgent)
        setAgentUrl(getDisplaySlug(firstAgent))
      }
    }
  }

  // Thread sidebar: select an agent DM (virtual entry → back to 1:1 chat)
  const handleSidebarSelectAgent = (agentId) => {
    setActiveThread(null)
    if (agentId !== selectedAgentId) {
      handleSelectAgent(agentId)
    }
  }

  // Create new agent
  const handleCreateAgent = async () => {
    if (!newAgentName.trim()) return
    setCreatingAgent(true)
    try {
      const res = await fetch(`${baseApiUrl}/api/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newAgentName.trim()
        })
      })
      const data = await res.json()
      if (data.success && data.agent) {
        await loadAgents()
        setSelectedAgentId(data.agent.id)
        // Keep URL as /new during setup — swaps to agent slug on setup complete
        setAgentUrl('new')
        setConfig(null)
        setShowNewAgent(false)
        setNewAgentName('')
      }
    } catch (err) {
      console.error('Failed to create agent:', err)
    } finally {
      setCreatingAgent(false)
    }
  }

  // Save UI state to database (immediate — no debounce, fires are infrequent)
  const saveUiState = useCallback(() => {
    const uiState = {
      selectedAgentId,
      imageCollapsed,
      imageWidth,
      agentLifeOpen,
      agentLifeActiveTab,
      agentLifeHeight,
      showThreads,
      threadImageCollapsed,
      activeThreadId: activeThread?.id || null,
      contextTab,
    }
    fetch(`${baseApiUrl}/api/assistant/ui-state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(uiState),
    }).catch(() => {})
  }, [selectedAgentId, imageCollapsed, imageWidth, agentLifeOpen,
      agentLifeActiveTab, agentLifeHeight, showThreads, threadImageCollapsed, activeThread, contextTab, baseApiUrl])

  // Save UI state whenever any persisted value changes
  useEffect(() => {
    if (uiStateLoaded && selectedAgentId) saveUiState()
  }, [uiStateLoaded, saveUiState, selectedAgentId, imageCollapsed, imageWidth, agentLifeOpen,
      agentLifeActiveTab, agentLifeHeight, showThreads, threadImageCollapsed, activeThread?.id, contextTab])

  if (!config || !selectedAgentId) {
    // While loading, also check if AI is definitively not ready
    if (aiReady === false) {
      return (
        <div className="h-screen flex items-center justify-center bg-gray-900">
          <div className="text-center max-w-sm px-6">
            <p className="text-sm text-gray-300 mb-4">
              No AI models are available. Set up a login or API key to get started.
            </p>
            <button
              onClick={() => window.os8?.settings?.open?.()}
              className="px-4 py-2 text-sm text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
            >
              Open Settings
            </button>
          </div>
        </div>
      )
    }
    // No agents exist — show create agent UI
    if (agentsLoaded && agents.length === 0) {
      return (
        <div className="h-screen flex items-center justify-center bg-gray-900">
          <div className="text-center max-w-sm px-6">
            <p className="text-lg text-gray-200 mb-2 font-medium">Create Your Agent</p>
            <p className="text-sm text-gray-400 mb-6">Give your agent a name to get started.</p>
            <div className="flex gap-2">
              <input
                type="text"
                value={newAgentName}
                onChange={(e) => setNewAgentName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreateAgent()}
                placeholder="Agent name..."
                autoFocus
                className="flex-1 px-3 py-2 text-sm text-white bg-gray-800 border border-gray-600 rounded-lg focus:outline-none focus:border-blue-500"
              />
              <button
                onClick={handleCreateAgent}
                disabled={creatingAgent || !newAgentName.trim()}
                className="px-4 py-2 text-sm text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
              >
                {creatingAgent ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )
    }
    return (
      <div className="h-screen flex items-center justify-center bg-gray-900">
        <div className="text-gray-400">Loading...</div>
      </div>
    )
  }

  // Show setup screen for agents that haven't completed initial setup
  if (!config.setupComplete) {
    return (
      <ErrorBoundary>
        <SetupScreen
          agentId={selectedAgentId}
          baseApiUrl={baseApiUrl}
          onSetupComplete={() => {
            loadConfig()
            // Swap URL from /new to the agent's real slug
            setAgentUrl(getDisplaySlug(selectedAgentId))
          }}
        />
      </ErrorBoundary>
    )
  }

  const assistantName = config.assistantName || 'Assistant'
  const ownerName = config.ownerName || ''
  const showImageEnabled = config.showImage !== false

  return (
    <div className="h-screen flex flex-col bg-gray-900">
      {/* Header */}
      <header className="shrink-0 bg-gray-800 border-b border-gray-700">
        <div className="px-4 py-2 flex justify-between items-center">
          <div className="flex items-center gap-3">
            {/* Image toggle when collapsed */}
            {showImageEnabled && imageCollapsed && !showThreads && (
              <button
                onClick={() => setImageCollapsed(false)}
                className="p-1.5 rounded-full bg-gray-700 hover:bg-gray-600 text-gray-400 hover:text-white transition-colors"
                title="Show image"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2H4zm12 12H4l4-8 3 6 2-4 3 6z" clipRule="evenodd" />
                </svg>
              </button>
            )}
            {showImageEnabled && showThreads && threadImageCollapsed && (
              <button
                onClick={() => setThreadImageCollapsed(false)}
                className="p-1.5 rounded-full bg-gray-700 hover:bg-gray-600 text-gray-400 hover:text-white transition-colors"
                title="Show agent images"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2H4zm12 12H4l4-8 3 6 2-4 3 6z" clipRule="evenodd" />
                </svg>
              </button>
            )}

            {/* Agent dropdown */}
            <div className="relative" ref={agentDropdownRef}>
              <button
                onClick={() => setShowAgentDropdown(!showAgentDropdown)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-700 border border-gray-600 hover:bg-gray-600 transition-colors"
              >
                <span className="text-sm font-semibold text-white">{assistantName}</span>
                <svg className="w-3 h-3 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <path d="M6 9l6 6 6-6"/>
                </svg>
              </button>

              {showAgentDropdown && (
                <div className="absolute top-full left-0 mt-1 bg-gray-800 border border-gray-600 rounded-lg py-1 min-w-[180px] shadow-xl z-50">
                  {agents.map(agent => (
                    <button
                      key={agent.id}
                      onClick={() => handleSelectAgent(agent.id)}
                      className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-gray-700 transition-colors ${
                        agent.id === selectedAgentId ? 'text-blue-400' : 'text-gray-300'
                      }`}
                    >
                      <span>{agent.name}</span>
                      {agent.isDefault && (
                        <span className="text-[10px] text-gray-500 bg-gray-700 px-1.5 rounded">default</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>

          </div>

          <div className="flex items-center gap-3">
            {/* New Agent button */}
            <Tooltip text="Create new agent">
              <button
                onClick={() => setShowNewAgent(true)}
                className="new-agent-btn p-1.5 rounded-md transition-colors bg-blue-600 text-white hover:bg-blue-700"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M12 5v14M5 12h14"/>
                </svg>
              </button>
            </Tooltip>

            {/* Thread toggle button */}
            <Tooltip text="Chat threads">
              <button
                onClick={() => {
                  setShowThreads(!showThreads)
                  if (showThreads) setActiveThread(null) // Close thread view when hiding sidebar
                }}
                className={`p-1.5 rounded transition-colors ${showThreads ? 'bg-gray-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-700'}`}
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
              </button>
            </Tooltip>

            {/* Settings gear */}
            <Tooltip text="Settings">
              <button
                onClick={() => setShowSettings(!showSettings)}
                className={`p-1.5 rounded transition-colors ${showSettings ? 'bg-gray-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-700'}`}
              >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              </button>
            </Tooltip>

            {/* Agent Life panel toggle */}
            <Tooltip text="Agent manager">
              <button
                onClick={() => {
                  const opening = !agentLifeOpen
                  setAgentLifeOpen(opening)
                  if (opening && !contextData) fetchContext()
                }}
                className={`p-1.5 rounded transition-colors ${agentLifeOpen ? 'bg-gray-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-700'}`}
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
                  <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
                </svg>
              </button>
            </Tooltip>

          </div>
        </div>
      </header>

      {/* New Agent Modal */}
      {showNewAgent && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={(e) => { if (e.target === e.currentTarget) setShowNewAgent(false) }}>
          <div className="bg-gray-800 border border-gray-600 rounded-xl p-6 w-80 shadow-2xl">
            <h2 className="text-lg font-semibold text-white mb-4">New Agent</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Name</label>
                <input
                  type="text"
                  value={newAgentName}
                  onChange={(e) => setNewAgentName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newAgentName.trim()) handleCreateAgent()
                    if (e.key === 'Escape') setShowNewAgent(false)
                  }}
                  placeholder="Bob"
                  className="w-full bg-gray-700 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 border border-gray-600"
                  autoFocus
                />
              </div>
            </div>
            <div className="flex gap-2 mt-5">
              <button
                onClick={() => setShowNewAgent(false)}
                className="flex-1 px-3 py-2 text-sm text-gray-400 bg-gray-700 rounded-lg hover:bg-gray-600 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateAgent}
                disabled={!newAgentName.trim() || creatingAgent}
                className="flex-1 px-3 py-2 text-sm text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {creatingAgent ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main content - image, threads sidebar, and chat side by side */}
      <div className="flex-1 flex overflow-hidden">
        {/* Image section - left side (hidden when thread sidebar is open) */}
        {showImageEnabled && !showThreads && (
          <ImageView
            folderPath="current-image"
            agentId={selectedAgentId}
            isCollapsed={imageCollapsed}
            onToggle={() => setImageCollapsed(!imageCollapsed)}
            refreshInterval={30000}
            widthPercent={imageWidth}
          />
        )}

        {/* Draggable divider between image and chat */}
        {showImageEnabled && !showThreads && !imageCollapsed && (
          <div
            style={{ width: 4, cursor: 'col-resize', background: 'rgba(255,255,255,0.08)', flexShrink: 0, transition: 'background 0.15s' }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(59,130,246,0.5)'}
            onMouseLeave={e => { if (!e.currentTarget.dataset.dragging) e.currentTarget.style.background = 'rgba(255,255,255,0.08)' }}
            onMouseDown={e => {
              e.preventDefault()
              const startX = e.clientX
              const startW = imageWidth
              const container = e.currentTarget.parentElement
              const containerW = container.getBoundingClientRect().width
              const divider = e.currentTarget
              divider.dataset.dragging = '1'
              divider.style.background = 'rgba(59,130,246,0.5)'
              const onMove = (ev) => {
                const dx = ev.clientX - startX
                const newPct = Math.min(50, Math.max(15, startW + (dx / containerW) * 100))
                setImageWidth(newPct)
              }
              const onUp = () => {
                delete divider.dataset.dragging
                divider.style.background = 'rgba(255,255,255,0.08)'
                document.removeEventListener('mousemove', onMove)
                document.removeEventListener('mouseup', onUp)
              }
              document.addEventListener('mousemove', onMove)
              document.addEventListener('mouseup', onUp)
            }}
          />
        )}

        {/* Thread Sidebar */}
        {showThreads && (
          <ThreadSidebar
            baseApiUrl={baseApiUrl}
            agents={agents}
            selectedAgentId={selectedAgentId}
            onSelectThread={handleSelectThread}
            onSelectAgent={handleSidebarSelectAgent}
            activeThreadId={activeThread?.id || null}
          />
        )}

        {/* Thread Image Panel - agent portraits (group thread or single agent DM) */}
        {showThreads && showImageEnabled && !threadImageCollapsed && (
          <ThreadImagePanel
            thread={activeThread}
            selectedAgentId={selectedAgentId}
            agents={agents}
            onCollapse={() => setThreadImageCollapsed(true)}
          />
        )}

        {/* Main content area */}
        <main className="flex-1 flex flex-col overflow-hidden min-w-0">
          {/* Chat/Thread area */}
          <div className="overflow-hidden" style={agentLifeOpen && !activeThread ? { flex: `0 0 ${100 - agentLifeHeight}%` } : { flex: '1 1 auto' }}>
            {activeThread ? (
              <ThreadView
                thread={activeThread}
                baseApiUrl={baseApiUrl}
                agents={agents}
                onClose={() => setActiveThread(null)}
              />
            ) : (
              <Chat
                assistantName={assistantName}
                ownerName={ownerName}
                agentApiBase={getAgentApiBase(selectedAgentId)}
                baseApiUrl={baseApiUrl}
                selectedAgentId={selectedAgentId}
                config={config}
                onBackendError={handleBackendError}
                onConfigChanged={loadConfig}
                onMessageComplete={stableMessageComplete}
              />
            )}
          </div>

          {/* Drag divider — only when panel is open and not in thread view */}
          {agentLifeOpen && !activeThread && (
            <div
              style={{ height: 4, cursor: 'row-resize', background: 'rgba(255,255,255,0.08)', flexShrink: 0 }}
              onMouseEnter={e => e.currentTarget.style.background = 'rgba(59,130,246,0.5)'}
              onMouseLeave={e => { if (!e.currentTarget.dataset.dragging) e.currentTarget.style.background = 'rgba(255,255,255,0.08)' }}
              onMouseDown={e => {
                e.preventDefault()
                const startY = e.clientY
                const startH = agentLifeHeight
                const container = e.currentTarget.parentElement
                const containerH = container.getBoundingClientRect().height
                const div = e.currentTarget
                div.dataset.dragging = '1'
                div.style.background = 'rgba(59,130,246,0.5)'
                const onMove = (ev) => {
                  const dy = startY - ev.clientY
                  setAgentLifeHeight(Math.min(70, Math.max(15, startH + (dy / containerH) * 100)))
                }
                const onUp = () => {
                  delete div.dataset.dragging
                  div.style.background = 'rgba(255,255,255,0.08)'
                  document.removeEventListener('mousemove', onMove)
                  document.removeEventListener('mouseup', onUp)
                }
                document.addEventListener('mousemove', onMove)
                document.addEventListener('mouseup', onUp)
              }}
            />
          )}

          {/* Agent Life Panel */}
          {agentLifeOpen && !activeThread && (
            <div style={{ flex: `0 0 ${agentLifeHeight}%` }} className="overflow-hidden">
              <AgentLifePanel
                contextData={contextData}
                contextTab={contextTab}
                onTabChange={setContextTab}
                isLoading={contextLoading}
                activeTab={agentLifeActiveTab}
                onActiveTabChange={setAgentLifeActiveTab}
                baseApiUrl={baseApiUrl}
                appId={appId}
                agentId={selectedAgentId}
              />
            </div>
          )}
        </main>
      </div>

      {/* Settings Panel */}
      <SettingsPanel
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        agentId={selectedAgentId}
        baseApiUrl={baseApiUrl}
        config={config}
        onConfigChange={handleConfigChange}
        onConfigUpdated={loadConfig}
        onAgentsChanged={() => loadAgents()}
        onAgentDeleted={() => {
          // Synchronously clear ALL state so the very next render
          // sees agents=[] and selectedAgentId=null → shows create UI
          setConfig(null)
          setAgents(prev => prev.filter(a => a.id !== selectedAgentId))
          setSelectedAgentId(null)
          setShowSettings(false)
          history.replaceState(null, '', `${basePath}/new`)
          loadAgents({ forceReselect: true })
        }}
      />

    </div>
  )
}

export default App
