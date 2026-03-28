import { useMemo } from 'react'

function ThreadMessage({ message, agents, baseApiUrl }) {
  const isUser = message.sender_app_id === 'user'
  const isSystem = message.message_type === 'system'

  // Find agent details for color/emoji
  const agent = useMemo(() => {
    if (isUser || isSystem) return null
    return agents?.find(a => a.id === message.sender_app_id)
  }, [message.sender_app_id, agents, isUser, isSystem])

  const agentColor = agent?.color || '#6366f1'

  // Format timestamp
  const timeStr = useMemo(() => {
    if (!message.timestamp) return ''
    const d = new Date(message.timestamp)
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }, [message.timestamp])

  // Parse attachments from metadata
  const attachments = useMemo(() => {
    if (!message.metadata) return []
    try {
      const meta = typeof message.metadata === 'string' ? JSON.parse(message.metadata) : message.metadata
      return meta.attachments || []
    } catch { return [] }
  }, [message.metadata])

  const apiUrl = baseApiUrl || `http://localhost:${window.location.port || '8888'}`

  // Render attachment thumbnails
  const renderAttachments = () => {
    if (attachments.length === 0) return null
    return (
      <div className="flex flex-wrap gap-1.5 mt-1.5">
        {attachments.map((att, i) => (
          att.mimeType?.startsWith('image/') ? (
            <a key={i} href={`${apiUrl}${att.url}`} target="_blank" rel="noopener noreferrer">
              <img
                src={`${apiUrl}${att.url}`}
                alt={att.filename}
                className="max-w-[200px] max-h-[160px] rounded-lg object-cover"
              />
            </a>
          ) : (
            <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-600 rounded text-xs text-gray-200">
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
              </svg>
              {att.filename}
            </span>
          )
        ))}
      </div>
    )
  }

  // System messages (centered, gray)
  if (isSystem) {
    return (
      <div className="flex justify-center py-1">
        <span className="text-xs text-gray-500 italic">{message.content}</span>
      </div>
    )
  }

  // User messages (right-aligned, blue)
  if (isUser) {
    return (
      <div className="flex justify-end mb-3">
        <div className="max-w-[75%]">
          <div className="bg-blue-600 text-white rounded-2xl rounded-br-sm px-4 py-2 text-sm whitespace-pre-wrap">
            {message.content}
          </div>
          {renderAttachments()}
          <div className="text-[10px] text-gray-500 mt-0.5 text-right">{timeStr}</div>
        </div>
      </div>
    )
  }

  // Agent messages (left-aligned)
  return (
    <div className="flex items-start mb-3">
      <div className="max-w-[75%]">
        {/* Agent name */}
        <div className="text-xs font-medium mb-0.5 text-gray-300">
          {message.sender_name}
        </div>
        {/* Content */}
        <div className="bg-gray-700 text-gray-100 rounded-2xl rounded-tl-sm px-4 py-2 text-sm whitespace-pre-wrap">
          {message.content}
        </div>
        {renderAttachments()}
        <div className="text-[10px] text-gray-500 mt-0.5">{timeStr}</div>
      </div>
    </div>
  )
}

export default ThreadMessage
