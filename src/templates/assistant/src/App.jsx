import { useState, useEffect, useRef, useCallback, Component } from 'react'
import { Routes, Route } from 'react-router-dom'
import Chat from './components/Chat'
import ImageView from './components/ImageView'
import SettingsPanel from './components/SettingsPanel'
import SetupScreen from './components/SetupScreen'
import ThreadSidebar from './components/ThreadSidebar'
import ThreadView from './components/ThreadView'
import ThreadImagePanel from './components/ThreadImagePanel'

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

  // Context debug viewer
  const [contextData, setContextData] = useState(null)
  const [contextTab, setContextTab] = useState('conscious') // 'conscious' or 'raw'

  const currentPort = window.location.port || '8888'
  const baseApiUrl = `http://localhost:${currentPort}`

  // Get the app's base path (/{appId})
  const basePath = '/' + window.location.pathname.split('/').filter(Boolean)[0]

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
        if (!initialId) {
          // Only use defaultAgentId if it exists in the active agents list
          if (data.defaultAgentId && agentsList.some(a => a.id === data.defaultAgentId)) {
            initialId = data.defaultAgentId
          } else if (agentsList.length > 0) {
            initialId = agentsList[0].id
          }
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

  // Load agents and check AI readiness on mount
  useEffect(() => {
    loadAgents()
    fetch(`${baseApiUrl}/api/ai/ready`)
      .then(r => r.json())
      .then(data => setAiReady(!!data.ready))
      .catch(() => setAiReady(false))
  }, [])

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

  // Switch agent — also update URL path for shell sidebar scoping
  const handleSelectAgent = (agentId) => {
    setSelectedAgentId(agentId)
    setShowAgentDropdown(false)
    setActiveThread(null) // Return to 1:1 chat
    setConfig(null) // Reset config to show loading
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
            <button
              onClick={() => setShowNewAgent(true)}
              className="new-agent-btn p-1.5 rounded-md transition-colors bg-blue-600 text-white hover:bg-blue-700"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M12 5v14M5 12h14"/>
              </svg>
            </button>

            {/* Thread toggle button */}
            <button
              onClick={() => {
                setShowThreads(!showThreads)
                if (showThreads) setActiveThread(null) // Close thread view when hiding sidebar
              }}
              className={`p-1.5 rounded transition-colors ${showThreads ? 'bg-gray-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-700'}`}
              title="Threads"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
            </button>

            {/* Settings gear */}
            <button
              onClick={() => setShowSettings(!showSettings)}
              className={`p-1.5 rounded transition-colors ${showSettings ? 'bg-gray-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-700'}`}
              title="Settings"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>

            {/* Context debug viewer */}
            <button
              onClick={async () => {
                if (!selectedAgentId) return
                try {
                  const resp = await fetch(`${baseApiUrl}/api/agent/${selectedAgentId}/context`)
                  if (!resp.ok) {
                    const err = await resp.json()
                    alert(err.error || 'No context available')
                    return
                  }
                  setContextData(await resp.json())
                } catch (err) {
                  alert('Failed to fetch context: ' + err.message)
                }
              }}
              className="p-1.5 rounded transition-colors text-gray-400 hover:text-white hover:bg-gray-700"
              title="View memory context"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
                <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
              </svg>
            </button>

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

      {/* Context Debug Modal */}
      {contextData && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={(e) => { if (e.target === e.currentTarget) setContextData(null) }}>
          <div className="bg-gray-800 border border-gray-600 rounded-xl p-6 shadow-2xl" style={{ width: '90%', maxWidth: 800, maxHeight: '85vh', overflowY: 'auto' }}>
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-lg font-semibold text-white">Memory Context</h2>
              <button onClick={() => setContextData(null)} className="text-gray-400 hover:text-white text-lg">&times;</button>
            </div>
            <p className="text-xs text-gray-500 mb-2">
              Assembled at {contextData.timestamp || '?'} &middot; Full context: {contextData.fullContext ? (contextData.fullContext.length / 1024).toFixed(1) : '0'}K chars
              {contextData.images?.length > 0 && ` \u00b7 ${contextData.images.length} image${contextData.images.length > 1 ? 's' : ''}`}
              {contextData.subconsciousEnabled && contextData.subconsciousDuration != null && ` \u00b7 Subconscious: ${contextData.subconsciousDuration}ms`}
              {contextData.subconsciousUsage && ` (${contextData.subconsciousUsage.input_tokens} in / ${contextData.subconsciousUsage.output_tokens} out)`}
            </p>
            {contextData.subconsciousEnabled && (
              <div className="flex gap-2 mb-3">
                <button
                  className={`text-xs px-2.5 py-1 rounded transition-colors ${contextTab === 'conscious' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200 bg-gray-700/40'}`}
                  onClick={() => setContextTab('conscious')}
                >Conscious memory</button>
                <button
                  className={`text-xs px-2.5 py-1 rounded transition-colors ${contextTab === 'raw' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200 bg-gray-700/40'}`}
                  onClick={() => setContextTab('raw')}
                >Raw subconscious</button>
              </div>
            )}
            {contextData.subconsciousEnabled && contextTab === 'conscious' && contextData.subconsciousClassification && (
              <div className={`text-xs font-semibold py-1.5 px-2 rounded mb-1 ${contextData.subconsciousClassification === 'CONVERSATIONAL' ? 'text-blue-400 bg-blue-900/20' : 'text-orange-400 bg-orange-900/20'}`}>
                Action Classification: {contextData.subconsciousClassification} {contextData.subconsciousClassification === 'TOOL_USE' ? '→ CLI spawn (planning cascade)' : '→ direct response (conversation cascade)'}
                {contextData.classifierDurationMs && (
                  <span className="ml-2 font-normal text-gray-500">
                    ({contextData.classifierDurationMs}ms{contextData.classifierUsage ? `, ${contextData.classifierUsage.input_tokens}→${contextData.classifierUsage.output_tokens} tok` : ''})
                  </span>
                )}
              </div>
            )}
            {contextData.subconsciousEnabled && contextTab === 'conscious' && contextData.subconsciousError && (
              <p className="text-xs text-red-400 bg-red-900/20 rounded-lg px-3 py-2 mb-2">
                Subconscious processing failed: {contextData.subconsciousError} (fell back to raw context)
              </p>
            )}
            {contextData.subconsciousEnabled && contextTab === 'conscious' && (contextData.subconsciousContext || contextData.subconsciousOutput) && (
              <details className="mb-1" open>
                <summary className="text-xs font-semibold text-gray-400 cursor-pointer hover:text-gray-200 py-1.5 px-2 rounded bg-gray-700/30 hover:bg-gray-700/60 transition-colors">
                  Curated Context{contextData.subconsciousDepthLabel ? ` — ${contextData.subconsciousDepthLabel}` : ''} ({((contextData.subconsciousContext || contextData.subconsciousOutput || '').length / 1024).toFixed(1)}K chars)
                </summary>
                <pre className="text-xs text-gray-300 bg-black/30 rounded-lg p-3 mt-1 mb-2 overflow-auto whitespace-pre-wrap break-words" style={{ maxHeight: 600 }}>
                  {contextData.subconsciousContext || contextData.subconsciousOutput}
                </pre>
              </details>
            )}
            {contextData.subconsciousEnabled && contextTab === 'conscious' && contextData.subconsciousRecommendedResponse && (
              <details className="mb-1" open>
                <summary className={`text-xs font-semibold cursor-pointer hover:text-gray-200 py-1.5 px-2 rounded transition-colors ${!contextData.subconsciousRequiresToolUse ? 'text-green-400 bg-green-900/20 hover:bg-green-900/40' : 'text-orange-400 bg-orange-900/20 hover:bg-orange-900/40'}`}>
                  Recommended Response {!contextData.subconsciousRequiresToolUse ? '(DIRECT — sent as final)' : '(discarded — TOOL_USE classified, CLI spawned)'}
                </summary>
                <pre className="text-xs text-gray-300 bg-black/30 rounded-lg p-3 mt-1 mb-2 overflow-auto whitespace-pre-wrap break-words" style={{ maxHeight: 400 }}>
                  {contextData.subconsciousRecommendedResponse}
                </pre>
              </details>
            )}
            {contextData.imageDataUrls?.length > 0 && (
              <details className="mb-1" open>
                <summary className="text-xs font-semibold text-gray-400 cursor-pointer hover:text-gray-200 py-1.5 px-2 rounded bg-gray-700/30 hover:bg-gray-700/60 transition-colors">
                  Images ({contextData.imageDataUrls.length})
                  {contextData.images && ` \u2014 ${contextData.images.map(i => `${i.label}: ${i.sizeKB}KB`).join(', ')}`}
                </summary>
                <div className="flex gap-3 mt-2 mb-3 flex-wrap">
                  {contextData.imageDataUrls.map((img, i) => (
                    <div key={i} className="flex flex-col items-center">
                      <img src={img.dataUrl} alt={img.label} className="rounded-lg border border-gray-600" style={{ maxHeight: 200, maxWidth: 250, objectFit: 'contain' }} />
                      <span className="text-xs text-gray-500 mt-1">{img.label}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}
            {(() => {
              const isConscious = contextData.subconsciousEnabled && contextTab === 'conscious';
              // Extract structural identity (preamble + Identity + Current Model + Appearance)
              const structuralIdentity = (() => {
                if (!contextData.identityContext) return null;
                const lines = contextData.identityContext.split('\n');
                const result = [];
                let inAppearance = false;
                for (const line of lines) {
                  if (inAppearance) {
                    if (line.startsWith('-') || !line.trim()) { result.push(line); continue; }
                    break;
                  }
                  result.push(line);
                  if (/^## Appearance/.test(line)) inAppearance = true;
                }
                return result.join('\n').trim() || null;
              })();
              // Extract principles from identity context (<principles>...</principles> tags)
              const principlesContent = (() => {
                if (!contextData.identityContext) return null;
                const match = contextData.identityContext.match(/<principles[^>]*>([\s\S]*?)<\/principles>/);
                return match ? match[1].trim() : null;
              })();
              // Extract motivations from identity context (<motivations>...</motivations> tags)
              const motivationsContent = (() => {
                if (!contextData.identityContext) return null;
                const match = contextData.identityContext.match(/<motivations[^>]*>([\s\S]*?)<\/motivations>/);
                return match ? match[1].trim() : null;
              })();
              // Extract system instructions from identity context (<system_instructions>...</system_instructions> tags)
              const systemInstructionsContent = (() => {
                if (!contextData.identityContext) return null;
                const match = contextData.identityContext.match(/<system_instructions[^>]*>([\s\S]*?)<\/system_instructions>/);
                return match ? match[0].trim() : null;
              })();
              // Strip system instructions from identity context to avoid duplication
              const identityWithoutInstructions = (() => {
                if (!contextData.identityContext || !systemInstructionsContent) return contextData.identityContext;
                return contextData.identityContext.replace(/<system_instructions[^>]*>[\s\S]*?<\/system_instructions>\s*/, '').trim();
              })();
              const allSections = [
                { title: 'Budget Profile', content: contextData.profile ? JSON.stringify(contextData.profile, null, 2) : null, raw: true },
                { title: 'System Instructions', content: systemInstructionsContent, raw: true },
                { title: 'Identity Context', content: identityWithoutInstructions, raw: true },
                { title: 'Identity (passthrough)', content: structuralIdentity, conscious: true },
                { title: 'Principles & Domain Syntheses', content: principlesContent },
                { title: 'Motivations', content: motivationsContent },
                { title: 'Memory - Raw Entries', content: contextData.memoryContext?.rawEntries
                  ? `${contextData.memoryContext.rawEntries.length} entries\n\n` + contextData.memoryContext.rawEntries.map(e => `[${e.timestamp || ''}] ${e.speaker || e.role || ''}: ${e.content || ''}`).join('\n---\n')
                  : null, raw: true },
                { title: 'Memory - Session Digests', content: contextData.memoryContext?.sessionDigests || contextData.memoryContext?.digestText, raw: true },
                { title: 'Memory - Daily Digests', content: contextData.memoryContext?.dailyDigests, raw: true },
                { title: 'Memory - Semantic Search', content: contextData.semanticMemoryText
                  || (contextData.memoryContext?.relevantMemory?.length
                    ? contextData.memoryContext.relevantMemory.map(c => `[${c.source || ''}] (score: ${c.score?.toFixed(3) || '?'})\n${c.text}`).join('\n---\n')
                    : '(no semantic results for this message)'), raw: true },
                { title: 'Agent DMs', content: contextData.agentDMContext, raw: true },
                { title: 'Skills / Capabilities', content: contextData.skillContext },
              ];
              return (isConscious ? allSections.filter(s => !s.raw || s.conscious) : allSections.filter(s => !s.conscious));
            })().map((section, i) => {
              const text = section.content || ''
              const chars = text.length
              if (!text) return null
              return (
                <details key={i} className="mb-1">
                  <summary className="text-xs font-semibold text-gray-400 cursor-pointer hover:text-gray-200 py-1.5 px-2 rounded bg-gray-700/30 hover:bg-gray-700/60 transition-colors">
                    {section.title} ({(chars / 1024).toFixed(1)}K chars)
                  </summary>
                  <pre className="text-xs text-gray-300 bg-black/30 rounded-lg p-3 mt-1 mb-2 overflow-auto whitespace-pre-wrap break-words" style={{ maxHeight: 400 }}>
                    {text}
                  </pre>
                </details>
              )
            })}
            <button
              onClick={() => setContextData(null)}
              className="w-full mt-3 px-3 py-2 text-sm text-gray-400 bg-gray-700 rounded-lg hover:bg-gray-600 transition-colors"
            >
              Close
            </button>
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
        <main className="flex-1 flex overflow-hidden min-w-0">
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
            />
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
