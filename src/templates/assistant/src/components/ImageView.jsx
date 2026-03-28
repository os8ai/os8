import { useState, useEffect, useRef } from 'react'

/**
 * ImageView - Displays the latest third-person image from a folder
 *
 * Props:
 *   - folderPath: path relative to app's blob storage (e.g., 'current-image')
 *   - isCollapsed: whether the view is collapsed
 *   - onToggle: callback to toggle collapsed state
 *   - refreshInterval: how often to check for new images (ms), default 30000
 */
function ImageView({ folderPath = 'current-image', agentId, isCollapsed, onToggle, refreshInterval = 30000, widthPercent }) {
  const [image, setImage] = useState({ src: null, filename: null })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [buzzLevel, setBuzzLevel] = useState(0)
  const [embodied, setEmbodied] = useState(false)
  const containerRef = useRef(null)

  const port = window.location.port || '8888'

  // Fetch buzz status
  const fetchBuzzStatus = async () => {
    try {
      const response = await fetch(`http://localhost:${port}/api/buzz/status${agentId ? `?agentId=${agentId}` : ''}`)
      if (response.ok) {
        const data = await response.json()
        setBuzzLevel(data.level || 0)
      }
    } catch {}
  }

  // Fetch embodiment status
  const fetchEmbodiedStatus = async () => {
    try {
      const response = await fetch(`http://localhost:${port}/api/embodiment/status${agentId ? `?agentId=${agentId}` : ''}`)
      if (response.ok) {
        const data = await response.json()
        setEmbodied(!!data.active)
      }
    } catch {}
  }

  // Fetch the latest third-person image
  const fetchImage = async () => {
    const effectiveId = agentId || (() => {
      const pathParts = window.location.pathname.split('/').filter(Boolean)
      return pathParts[0]
    })()
    const base = effectiveId ? `/api/agent/${effectiveId}` : '/api/assistant'
    const response = await fetch(
      `http://localhost:${port}${base}/latest-image?folder=${encodeURIComponent(folderPath)}&type=third-person`
    )
    if (!response.ok) {
      if (response.status === 404) return null
      throw new Error('Failed to fetch image')
    }
    const data = await response.json()
    if (!data.filename) return null
    const effectiveFolder = data.folder || folderPath
    const blobBase = agentId
      ? `http://localhost:${port}/blob/${agentId}/${effectiveFolder}`
      : `http://localhost:${port}/blob/${effectiveFolder}`
    return {
      src: `${blobBase}/${data.filename}`,
      filename: data.filename,
    }
  }

  // Main fetch logic
  const fetchLatest = async () => {
    try {
      const result = await fetchImage()
      setImage(result || { src: null, filename: null })
      setError(result ? null : 'No images found')
    } catch (err) {
      console.error('Failed to fetch latest image:', err)
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  // Fetch on mount and at interval
  useEffect(() => {
    setLoading(true)
    fetchLatest()
    fetchBuzzStatus()
    fetchEmbodiedStatus()

    const interval = setInterval(() => {
      fetchLatest()
      fetchBuzzStatus()
      fetchEmbodiedStatus()
    }, refreshInterval)
    return () => clearInterval(interval)
  }, [folderPath, agentId, refreshInterval])

  // Re-fetch on tab visibility
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') fetchLatest()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [folderPath, agentId])

  if (isCollapsed) return null

  return (
    <div
      ref={containerRef}
      className="relative flex-shrink-0 bg-gray-900 border-r border-gray-700 flex flex-col"
      style={widthPercent != null ? { width: widthPercent + '%' } : { width: '30%', minWidth: '200px', maxWidth: '400px' }}
    >
      {/* Header buttons (top-right) */}
      <div className="absolute top-2 right-2 z-10 flex gap-1">
        <button
          onClick={() => { setLoading(true); fetchLatest() }}
          className="p-1.5 rounded-full bg-gray-800/80 hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
          title="Refresh image"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clipRule="evenodd" />
          </svg>
        </button>
        <button
          onClick={onToggle}
          className="p-1.5 rounded-full bg-gray-800/80 hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
          title="Collapse image"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
        </button>
      </div>

      {/* Image container */}
      <div className="flex-1 flex flex-col items-center justify-center p-4 overflow-auto">
        {loading && !image.src ? (
          <div className="text-gray-500 text-sm">Loading...</div>
        ) : error && !image.src ? (
          <div className="text-gray-500 text-sm text-center px-4">{error}</div>
        ) : image.src ? (
          <div className="flex flex-col items-center w-full">
            <img
              src={image.src}
              alt="Current"
              className="max-w-full max-h-full object-contain rounded-lg shadow-lg"
              onError={() => setError('Failed to load image')}
            />
            {image.filename && (
              <div className="text-xs text-gray-500 mt-1">{formatTimestamp(image.filename)}</div>
            )}
          </div>
        ) : (
          <div className="text-gray-500 text-sm">No image available</div>
        )}
      </div>

      {/* Status indicators */}
      {(buzzLevel > 0 || embodied) && (
        <div className="text-center pb-1 flex flex-col items-center gap-0.5">
          {buzzLevel > 0 && (
            <span className={`text-xs font-medium ${getBuzzStyle(buzzLevel)}`}>
              buzz {buzzLevel}
            </span>
          )}
          {embodied && (
            <span className="text-xs font-medium text-cyan-400">
              humanoid body
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Get Tailwind classes for buzz level indicator
 */
function getBuzzStyle(level) {
  if (level <= 2) return 'text-amber-400'
  if (level <= 4) return 'text-rose-400'
  return 'text-red-400 animate-pulse'
}
/**
 * Parse timestamp from filename like "2026-02-03-2116-agent.png"
 */
function formatTimestamp(filename) {
  const match = filename.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})/)
  if (!match) return filename

  const [, year, month, day, hour, minute] = match
  const date = new Date(year, month - 1, day, hour, minute)

  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  })
}

export default ImageView
