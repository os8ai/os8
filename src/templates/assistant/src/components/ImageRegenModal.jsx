import { useState, useEffect, useRef } from 'react'
import { buildHeadshotPrompt, buildBodyPrompt, buildAssignments, generateParallel, fetchImageAsBase64 } from '../utils/imagegen'

function computeAge(birthDate) {
  if (!birthDate) return null
  return Math.floor((Date.now() - new Date(birthDate).getTime()) / (365.25 * 24 * 60 * 60 * 1000))
}

export default function ImageRegenModal({ isOpen, onClose, type, baseApiUrl, agentId, config, currentHeadshot, onSaved }) {
  const [images, setImages] = useState([])
  const [selectedFilename, setSelectedFilename] = useState(null)
  const [generating, setGenerating] = useState(false)
  const [cycles, setCycles] = useState(0)
  const [providers, setProviders] = useState(null)
  const [saving, setSaving] = useState(false)
  const abortRef = useRef(null)

  // Fetch available providers on mount
  useEffect(() => {
    if (!isOpen) return
    setImages([])
    setSelectedFilename(null)
    setCycles(0)
    fetch(`${baseApiUrl}/api/imagegen/status`)
      .then(r => r.json())
      .then(data => setProviders(data.providers || {}))
      .catch(() => setProviders({}))
  }, [isOpen, baseApiUrl])

  // Auto-generate first batch when providers load
  useEffect(() => {
    if (providers && Object.keys(providers).length > 0 && cycles === 0) {
      generate()
    }
  }, [providers])

  const generate = async () => {
    if (abortRef.current) abortRef.current.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setGenerating(true)

    let prompt, referenceImages = null
    const priorityOrder = type === 'body' ? ['gemini', 'openai', 'grok'] : ['grok', 'gemini', 'openai']

    if (type === 'headshot') {
      prompt = buildHeadshotPrompt({
        gender: config.gender,
        age: computeAge(config.birthDate) || config.age,
        hairColor: config.hairColor,
        skinTone: config.skinTone,
        height: config.agentHeight,
        build: config.agentBuild,
        otherFeatures: config.otherFeatures,
        role: config.role
      })
    } else {
      prompt = buildBodyPrompt({
        gender: config.gender,
        height: config.agentHeight,
        build: config.agentBuild
      })
      if (currentHeadshot) {
        try {
          const ref = await fetchImageAsBase64(currentHeadshot)
          referenceImages = [ref]
        } catch (e) {
          console.warn('Failed to load headshot reference:', e)
        }
      }
    }

    const assignments = buildAssignments(providers, priorityOrder)
    if (assignments.length === 0) { setGenerating(false); return }

    const startIndex = images.length
    setImages(prev => [...prev, ...assignments.map(() => ({ loading: true }))])

    await generateParallel({
      baseApiUrl, prompt, assignments, referenceImages, signal: controller.signal,
      onImageReady: (i, result) => setImages(prev => {
        const next = [...prev]; next[startIndex + i] = result; return next
      })
    })

    if (!controller.signal.aborted) {
      setCycles(prev => prev + 1)
      setGenerating(false)
    }
  }

  const handleSave = async () => {
    if (!selectedFilename) return
    setSaving(true)
    try {
      const field = type === 'headshot'
        ? { avatarUrl: `/api/imagegen/files/${selectedFilename}` }
        : { bodyUrl: `/api/imagegen/files/${selectedFilename}` }
      const res = await fetch(`${baseApiUrl}/api/agents/${agentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(field)
      })
      if (res.ok) onSaved?.()
    } catch (err) {
      console.error('Failed to save reference image:', err)
    } finally {
      setSaving(false)
    }
  }

  const handleClose = () => {
    if (abortRef.current) abortRef.current.abort()
    onClose()
  }

  if (!isOpen) return null

  const title = type === 'headshot' ? 'Regenerate Headshot' : 'Regenerate Body Reference'

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={(e) => { if (e.target === e.currentTarget) handleClose() }}>
      <div className="bg-gray-800 border border-gray-600 rounded-xl shadow-2xl w-[480px] max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700">
          <h2 className="text-sm font-semibold text-white">{title}</h2>
          <button onClick={handleClose} className="text-gray-400 hover:text-white text-lg">&times;</button>
        </div>

        {/* Image grid */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {images.length === 0 && !generating && (
            <p className="text-xs text-gray-500 text-center py-8">Preparing generation...</p>
          )}
          <div className="grid grid-cols-2 gap-3">
            {images.map((img, i) => (
              <div key={i} className="relative">
                {img.loading ? (
                  <div className={`${type === 'body' ? 'aspect-[3/4]' : 'aspect-square'} rounded-lg bg-gray-700 flex items-center justify-center`}>
                    <div className="w-6 h-6 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
                  </div>
                ) : img.error ? (
                  <div className={`${type === 'body' ? 'aspect-[3/4]' : 'aspect-square'} rounded-lg bg-gray-700 flex items-center justify-center`}>
                    <span className="text-xs text-gray-500">Failed</span>
                  </div>
                ) : (
                  <button
                    onClick={() => setSelectedFilename(img.filename === selectedFilename ? null : img.filename)}
                    className={`w-full rounded-lg overflow-hidden border-2 transition-all ${
                      img.filename === selectedFilename
                        ? 'border-blue-500 ring-2 ring-blue-500/30'
                        : 'border-transparent hover:border-gray-500'
                    }`}
                  >
                    <div className={type === 'body' ? 'aspect-[3/4]' : 'aspect-square'}>
                      <img
                        src={`${baseApiUrl}${img.url}`}
                        alt={`Option ${i + 1}`}
                        className="w-full h-full object-cover"
                      />
                    </div>
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* Generate more */}
          {cycles > 0 && cycles < 5 && !generating && (
            <div className="flex justify-center mt-4">
              <button
                onClick={generate}
                className="px-4 py-1.5 text-xs text-gray-300 bg-gray-700 rounded-lg hover:bg-gray-600 transition-colors"
              >
                Generate more
              </button>
            </div>
          )}
          {generating && images.length > 0 && (
            <p className="text-xs text-gray-500 text-center mt-3">Generating...</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-gray-700">
          <button
            onClick={handleClose}
            className="px-4 py-2 text-xs text-gray-400 bg-gray-700 rounded-lg hover:bg-gray-600 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!selectedFilename || saving}
            className="px-4 py-2 text-xs text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? 'Saving...' : 'Use this image'}
          </button>
        </div>
      </div>
    </div>
  )
}
