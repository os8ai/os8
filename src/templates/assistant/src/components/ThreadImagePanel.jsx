import { useState, useEffect } from 'react'

function AgentCard({ agentId, name, port }) {
  const [image, setImage] = useState(null)
  const [buzzLevel, setBuzzLevel] = useState(0)
  const [embodied, setEmbodied] = useState(false)

  const fetchAll = async () => {
    // Image
    try {
      const res = await fetch(`http://localhost:${port}/api/agent/${agentId}/latest-image?folder=current-image&type=third-person`)
      if (res.ok) {
        const data = await res.json()
        if (data.filename) {
          const folder = data.folder || 'current-image'
          setImage(`http://localhost:${port}/blob/${agentId}/${folder}/${data.filename}`)
        }
      }
    } catch {}
    // Buzz
    try {
      const res = await fetch(`http://localhost:${port}/api/buzz/status?agentId=${agentId}`)
      if (res.ok) {
        const data = await res.json()
        setBuzzLevel(data.level || 0)
      }
    } catch {}
    // Embodiment
    try {
      const res = await fetch(`http://localhost:${port}/api/embodiment/status?agentId=${agentId}`)
      if (res.ok) {
        const data = await res.json()
        setEmbodied(!!data.active)
      }
    } catch {}
  }

  useEffect(() => {
    fetchAll()
    const interval = setInterval(fetchAll, 30000)
    return () => clearInterval(interval)
  }, [agentId])

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') fetchAll()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [agentId])

  return (
    <div className="flex flex-col items-center">
      <span className="text-xs font-medium text-gray-400 mb-1 truncate max-w-full">{name}</span>
      {image ? (
        <img
          src={image}
          alt={name}
          className="w-full rounded-lg shadow-lg object-contain"
          onError={() => setImage(null)}
        />
      ) : (
        <div className="w-full aspect-square rounded-lg bg-gray-800 flex items-center justify-center">
          <span className="text-2xl text-gray-600">{name?.[0]}</span>
        </div>
      )}
      {(buzzLevel > 0 || embodied) && (
        <div className="flex flex-col items-center gap-0.5 mt-1">
          {buzzLevel > 0 && (
            <span className={`text-[10px] font-medium ${buzzLevel <= 2 ? 'text-amber-400' : buzzLevel <= 4 ? 'text-rose-400' : 'text-red-400 animate-pulse'}`}>
              buzz {buzzLevel}
            </span>
          )}
          {embodied && (
            <span className="text-[10px] font-medium text-cyan-400">humanoid body</span>
          )}
        </div>
      )}
    </div>
  )
}

function ThreadImagePanel({ thread, selectedAgentId, agents, onCollapse }) {
  const port = window.location.port || '8888'

  // Group/DM thread: use participant details; individual agent DM: use selected agent
  const agentParticipants = thread
    ? (thread.participantDetails || []).filter(p => p.id !== 'user')
    : selectedAgentId
      ? (agents || []).filter(a => a.id === selectedAgentId)
      : []

  if (agentParticipants.length === 0) return null

  return (
    <div
      className="shrink-0 bg-gray-900 border-r border-gray-700 flex flex-col overflow-hidden"
      style={{ width: '18%', minWidth: 140, maxWidth: 260 }}
    >
      {/* Collapse button */}
      <div className="flex justify-end p-1">
        <button
          onClick={onCollapse}
          className="p-1 rounded-full bg-gray-800/80 hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
          title="Hide images"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
        </button>
      </div>

      {/* Agent cards */}
      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-3">
        {agentParticipants.map(agent => (
          <AgentCard key={agent.id} agentId={agent.id} name={agent.name} port={port} />
        ))}
      </div>
    </div>
  )
}

export default ThreadImagePanel
