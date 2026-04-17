import { useState, useEffect, useCallback, useRef } from 'react'

const PAGE_SIZE = 20

function formatDate(ts) {
  const d = new Date(ts)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
    ', ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

export default function AgentLifeImages({ baseApiUrl, appId, agentId }) {
  const [allImages, setAllImages] = useState([])
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const prevAgentId = useRef(null)

  useEffect(() => {
    if (!agentId) return
    if (agentId === prevAgentId.current) return
    prevAgentId.current = agentId

    setLoading(true)
    setError(false)
    setAllImages([])
    setVisibleCount(PAGE_SIZE)

    fetch(`${baseApiUrl}/api/agent/${agentId}/images/recent?limit=2000`)
      .then(res => {
        if (!res.ok) throw new Error('Failed to fetch')
        return res.json()
      })
      .then(data => {
        const seen = new Set()
        const imgs = (data.images || [])
          .filter(img => img.filename && img.timestamp && !img.filename.startsWith('telegram-'))
          .reverse()
          .filter(img => {
            if (seen.has(img.filename)) return false
            seen.add(img.filename)
            return true
          })
          .map(img => ({
            url: `${baseApiUrl}/blob/${agentId}/current-image/${img.filename}`,
            timestamp: img.timestamp,
            filename: img.filename,
          }))
        setAllImages(imgs)
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }, [agentId, baseApiUrl])

  const visible = allImages.slice(0, visibleCount)
  const hasMore = visibleCount < allImages.length

  const loadMore = useCallback(() => {
    setVisibleCount(prev => prev + PAGE_SIZE)
  }, [])

  const handleDelete = useCallback(async (filename) => {
    if (!window.confirm('Delete this image?')) return
    try {
      // Delete the file from blob storage (ok if already gone)
      const blobRes = await fetch(
        `${baseApiUrl}/api/apps/${appId}/blob/file/${agentId}/current-image/${encodeURIComponent(filename)}`,
        { method: 'DELETE' }
      )
      // Delete the database entry so it doesn't reappear on reload
      await fetch(
        `${baseApiUrl}/api/agent/${agentId}/images/by-filename/${encodeURIComponent(filename)}`,
        { method: 'DELETE' }
      )
      if (blobRes.ok || blobRes.status === 404) {
        setAllImages(prev => prev.filter(img => img.filename !== filename))
      }
    } catch (err) {
      console.error('Failed to delete image:', err)
    }
  }, [baseApiUrl, appId, agentId])

  if (loading) {
    return (
      <div className="grid grid-cols-3 gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="aspect-square rounded-lg bg-gray-800 animate-pulse" />
        ))}
      </div>
    )
  }

  if (error || allImages.length === 0) {
    return (
      <p className="text-xs text-gray-500">No images for this agent.</p>
    )
  }

  return (
    <div>
      <p className="text-xs text-gray-500 mb-2">{allImages.length} photos</p>
      <div className="grid grid-cols-3 gap-2">
        {visible.map((img) => (
          <div
            key={img.filename}
            className="group relative overflow-hidden rounded-lg bg-gray-900"
          >
            <div className="aspect-square">
              <img
                src={img.url}
                alt={img.filename}
                className="w-full h-full object-cover"
                loading="lazy"
              />
            </div>
            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-1.5 pt-6">
              <p className="text-gray-200 text-[10px]">{formatDate(img.timestamp)}</p>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); handleDelete(img.filename) }}
              className="absolute top-1 right-1 w-5 h-5 flex items-center justify-center rounded-full bg-black/60 text-gray-300 hover:bg-red-600 hover:text-white opacity-0 group-hover:opacity-100 transition-all text-xs"
              title="Delete image"
            >
              &times;
            </button>
          </div>
        ))}
      </div>
      {hasMore && (
        <div className="flex justify-center mt-3">
          <button
            onClick={loadMore}
            className="px-4 py-1.5 rounded-full bg-gray-800 text-gray-300 hover:bg-gray-700 transition-colors text-xs"
          >
            Load more ({allImages.length - visibleCount} remaining)
          </button>
        </div>
      )}
    </div>
  )
}
