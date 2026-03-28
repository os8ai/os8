import { useState, useEffect, useCallback } from 'react'

function ThreadSidebar({ baseApiUrl, agents, selectedAgentId, onSelectThread, onSelectAgent, activeThreadId }) {
  const [threads, setThreads] = useState([])
  const [showCreateGroup, setShowCreateGroup] = useState(false)
  const [groupName, setGroupName] = useState('')
  const [selectedParticipants, setSelectedParticipants] = useState([])
  const [creating, setCreating] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(null)

  // Load threads
  const loadThreads = useCallback(async () => {
    try {
      const res = await fetch(`${baseApiUrl}/api/agent-chat/threads`)
      const data = await res.json()
      setThreads(Array.isArray(data) ? data : [])
    } catch (err) {
      console.error('Failed to load threads:', err)
    }
  }, [baseApiUrl])

  useEffect(() => {
    loadThreads()
    // Refresh periodically
    const interval = setInterval(loadThreads, 15000)
    return () => clearInterval(interval)
  }, [loadThreads])

  // Create group
  const handleCreateGroup = async () => {
    if (!groupName.trim() || selectedParticipants.length < 2) return
    setCreating(true)
    try {
      const res = await fetch(`${baseApiUrl}/api/agent-chat/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: groupName.trim(),
          participantIds: selectedParticipants
        })
      })
      const data = await res.json()
      if (data.success) {
        setShowCreateGroup(false)
        setGroupName('')
        setSelectedParticipants([])
        await loadThreads()
        if (data.thread) onSelectThread(data.thread)
      }
    } catch (err) {
      console.error('Failed to create group:', err)
    } finally {
      setCreating(false)
    }
  }

  // Categorize threads
  const agentOnly = agents.filter(a => a.id !== 'user')
  const groupThreads = threads.filter(t => t.type === 'group')
  const agentDMThreads = threads.filter(t => {
    if (t.type !== 'dm') return false
    const parts = JSON.parse(t.participants || '[]')
    return !parts.includes('user')
  })

  // Format last message preview
  const preview = (thread) => {
    if (!thread.lastMessage) return 'No messages yet'
    const content = thread.lastMessage.content || ''
    const name = thread.lastMessage.sender_app_id === 'user' ? 'You' : thread.lastMessage.sender_name
    const text = content.length > 40 ? content.substring(0, 40) + '...' : content
    return `${name}: ${text}`
  }

  // Delete a thread (two-click confirm)
  const handleDeleteThread = async (e, threadId) => {
    e.stopPropagation()
    if (deleteConfirm === threadId) {
      try {
        await fetch(`${baseApiUrl}/api/agent-chat/threads/${threadId}`, { method: 'DELETE' })
        setThreads(prev => prev.filter(t => t.id !== threadId))
        if (activeThreadId === threadId) onSelectThread(null)
      } catch (err) {
        console.error('Failed to delete thread:', err)
      }
      setDeleteConfirm(null)
    } else {
      setDeleteConfirm(threadId)
    }
  }

  const toggleParticipant = (id) => {
    setSelectedParticipants(prev =>
      prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]
    )
  }

  return (
    <div className="w-64 shrink-0 bg-gray-850 border-r border-gray-700 flex flex-col h-full" style={{ backgroundColor: '#1a1d23' }}>
      {/* Header */}
      <div className="px-3 py-2 border-b border-gray-700">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Threads</h3>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* DMs section — virtual entries per agent */}
        <div className="px-2 pt-2">
          <div className="text-[10px] text-gray-500 uppercase tracking-wider px-2 mb-1">DMs</div>
          {agentOnly.map(agent => (
            <button
              key={agent.id}
              onClick={() => onSelectAgent(agent.id)}
              className={`w-full text-left px-2 py-1.5 rounded-lg flex items-center gap-2 transition-colors text-sm ${
                !activeThreadId && selectedAgentId === agent.id
                  ? 'bg-gray-700 text-white'
                  : 'text-gray-300 hover:bg-gray-800'
              }`}
            >
              <span
                className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] shrink-0"
                style={{ backgroundColor: (agent.color || '#6366f1') + '33', border: `1.5px solid ${agent.color || '#6366f1'}` }}
              >
                {agent.name?.[0]}
              </span>
              <span className="truncate">{agent.name}</span>
            </button>
          ))}
        </div>

        {/* Group threads */}
        {groupThreads.length > 0 && (
          <div className="px-2 pt-3">
            <div className="text-[10px] text-gray-500 uppercase tracking-wider px-2 mb-1">Groups</div>
            {groupThreads.map(thread => (
              <button
                key={thread.id}
                onClick={() => { setDeleteConfirm(null); onSelectThread(thread) }}
                className={`w-full text-left px-2 py-1.5 rounded-lg transition-colors ${
                  activeThreadId === thread.id
                    ? 'bg-gray-700 text-white'
                    : 'text-gray-300 hover:bg-gray-800'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className={`text-sm truncate ${deleteConfirm === thread.id ? 'text-red-400' : ''}`}>{thread.name || 'Untitled Group'}</span>
                  <span
                    onClick={(e) => handleDeleteThread(e, thread.id)}
                    className="text-gray-600 hover:text-red-400 shrink-0 ml-1 px-0.5 text-xs transition-colors"
                  >
                    ×
                  </span>
                </div>
                <div className="text-[11px] text-gray-500 truncate mt-0.5">{preview(thread)}</div>
              </button>
            ))}
          </div>
        )}

        {/* Agent-only chats (no user participant) */}
        {agentDMThreads.length > 0 && (
          <div className="px-2 pt-3">
            <div className="text-[10px] text-gray-500 uppercase tracking-wider px-2 mb-1">Agent Chats</div>
            {agentDMThreads.map(thread => {
              const parts = (thread.participantDetails || []).filter(p => p.id !== 'user')
              const label = parts.map(p => p.name).join(' & ')
              return (
                <button
                  key={thread.id}
                  onClick={() => { setDeleteConfirm(null); onSelectThread(thread) }}
                  className={`w-full text-left px-2 py-1.5 rounded-lg transition-colors ${
                    activeThreadId === thread.id
                      ? 'bg-gray-700 text-white'
                      : 'text-gray-300 hover:bg-gray-800'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className={`text-sm truncate ${deleteConfirm === thread.id ? 'text-red-400' : ''}`}>{label}</span>
                    <span
                      onClick={(e) => handleDeleteThread(e, thread.id)}
                      className="text-gray-600 hover:text-red-400 shrink-0 ml-1 px-0.5 text-xs transition-colors"
                    >
                      ×
                    </span>
                  </div>
                  <div className="text-[11px] text-gray-500 truncate mt-0.5">{preview(thread)}</div>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* New Group button */}
      <div className="px-2 py-2 border-t border-gray-700">
        <button
          onClick={() => setShowCreateGroup(true)}
          className="w-full text-left px-2 py-1.5 rounded-lg text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors flex items-center gap-2"
        >
          <span>+</span>
          <span>New Group</span>
        </button>
      </div>

      {/* Create Group Modal */}
      {showCreateGroup && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={(e) => { if (e.target === e.currentTarget) setShowCreateGroup(false) }}>
          <div className="bg-gray-800 border border-gray-600 rounded-xl p-5 w-80 shadow-2xl">
            <h2 className="text-base font-semibold text-white mb-3">New Group</h2>

            <div className="mb-3">
              <label className="block text-xs text-gray-400 mb-1">Group Name</label>
              <input
                type="text"
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && groupName.trim() && selectedParticipants.length >= 2) handleCreateGroup()
                  if (e.key === 'Escape') setShowCreateGroup(false)
                }}
                placeholder="Planning Session"
                className="w-full bg-gray-700 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 border border-gray-600"
                autoFocus
              />
            </div>

            <div className="mb-3">
              <label className="block text-xs text-gray-400 mb-1">Participants (select 2+)</label>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {agentOnly.map(agent => (
                  <label
                    key={agent.id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-700 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={selectedParticipants.includes(agent.id)}
                      onChange={() => toggleParticipant(agent.id)}
                      className="accent-blue-500"
                    />
                    <span
                      className="w-4 h-4 rounded-full flex items-center justify-center text-[10px]"
                      style={{ backgroundColor: (agent.color || '#6366f1') + '33' }}
                    >
                      {agent.name[0]}
                    </span>
                    <span className="text-sm text-gray-200">{agent.name}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => setShowCreateGroup(false)}
                className="flex-1 px-3 py-2 text-sm text-gray-400 bg-gray-700 rounded-lg hover:bg-gray-600 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateGroup}
                disabled={!groupName.trim() || selectedParticipants.length < 2 || creating}
                className="flex-1 px-3 py-2 text-sm text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {creating ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default ThreadSidebar
