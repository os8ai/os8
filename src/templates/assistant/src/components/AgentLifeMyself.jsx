import { useState, useEffect, useRef, useCallback } from 'react'
import ImageRegenModal from './ImageRegenModal'

function computeAge(birthDate) {
  if (!birthDate) return null
  return Math.floor((Date.now() - new Date(birthDate).getTime()) / (365.25 * 24 * 60 * 60 * 1000))
}

function AgentLifeMyself({ baseApiUrl, appId, agentId, config, onConfigUpdated }) {
  // Local state initialized from config
  const [name, setName] = useState('')
  const [gender, setGender] = useState('female')
  const [role, setRole] = useState('')
  const [birthDate, setBirthDate] = useState('')
  const [hairColor, setHairColor] = useState('')
  const [skinTone, setSkinTone] = useState('')
  const [height, setHeight] = useState('')
  const [build, setBuild] = useState('')
  const [otherFeatures, setOtherFeatures] = useState('')
  const [preamble, setPreamble] = useState('')
  const [narrative, setNarrative] = useState('')
  const [custom, setCustom] = useState('')
  const [saved, setSaved] = useState(false)
  const [refImages, setRefImages] = useState({ headshot: null, body: null })
  const [lightboxUrl, setLightboxUrl] = useState(null)
  const [regenType, setRegenType] = useState(null) // 'headshot' | 'body' | null
  const debounceRef = useRef(null)
  const longDebounceRef = useRef(null)

  // Sync local state when config changes (agent switch)
  useEffect(() => {
    if (!config) return
    setName(config.assistantName || '')
    setGender(config.gender || 'female')
    setRole(config.role || '')
    setBirthDate(config.birthDate || '')
    setHairColor(config.hairColor || '')
    setSkinTone(config.skinTone || '')
    setHeight(config.agentHeight || '')
    setBuild(config.agentBuild || '')
    setOtherFeatures(config.otherFeatures || '')
    setPreamble(config.myselfPreamble || '')
    setNarrative(config.myselfContent || '')
    setCustom(config.myselfCustom || '')
  }, [config?.assistantName, agentId])

  // Load reference images (extracted so regen can trigger refresh)
  const loadRefImages = useCallback(() => {
    if (!appId || !agentId) return
    fetch(`${baseApiUrl}/api/apps/${appId}/blob/?path=${agentId}/reference-images`)
      .then(r => r.ok ? r.json() : { files: [] })
      .then(data => {
        const files = data.files || []
        const headshot = files.find(f => /headshot/i.test(f.name) && !f.isDirectory)
        const body = files.find(f => /body/i.test(f.name) && !f.isDirectory)
        setRefImages({
          headshot: headshot ? `${baseApiUrl}/blob/${agentId}/reference-images/${headshot.name}?t=${Date.now()}` : null,
          body: body ? `${baseApiUrl}/blob/${agentId}/reference-images/${body.name}?t=${Date.now()}` : null,
        })
      })
      .catch(() => setRefImages({ headshot: null, body: null }))
  }, [baseApiUrl, appId, agentId])

  useEffect(() => { loadRefImages() }, [loadRefImages])

  const showSaved = useCallback(() => {
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }, [])

  const saveField = useCallback((updates) => {
    fetch(`${baseApiUrl}/api/agents/${agentId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    })
      .then(() => { showSaved(); onConfigUpdated?.() })
      .catch(err => console.error('Failed to save:', err))
  }, [baseApiUrl, agentId, showSaved, onConfigUpdated])

  const debouncedSave = useCallback((updates) => {
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => saveField(updates), 500)
  }, [saveField])

  const longDebouncedSave = useCallback((updates) => {
    clearTimeout(longDebounceRef.current)
    longDebounceRef.current = setTimeout(() => saveField(updates), 1000)
  }, [saveField])

  if (!config) return null

  const displayAge = computeAge(birthDate)
  const inputClass = "w-full bg-gray-800 text-gray-200 text-xs rounded px-2 py-1.5 border border-gray-700 focus:outline-none focus:border-blue-500"

  return (
    <div className="space-y-4">
      {/* Saved indicator */}
      {saved && (
        <div className="text-xs text-green-400 flex items-center gap-1">
          <span>&#10003;</span> Saved
        </div>
      )}

      {/* Reference Images */}
      <details open>
        <summary className="text-xs font-semibold text-gray-400 uppercase tracking-wide cursor-pointer hover:text-gray-200 mb-2">Reference Images</summary>
        <div className="flex gap-4">
          <div className="flex flex-col items-center gap-1">
            {refImages.headshot ? (
              <img src={refImages.headshot} alt="Headshot"
                onClick={() => setLightboxUrl(refImages.headshot)}
                className="rounded-lg border border-gray-700 object-cover cursor-pointer hover:border-gray-500 transition-colors"
                style={{ width: 80, height: 80 }} />
            ) : (
              <div className="w-20 h-20 rounded-lg border border-gray-700 border-dashed flex items-center justify-center text-gray-600 text-[10px]">None</div>
            )}
            <span className="text-[10px] text-gray-500">Headshot</span>
            <button onClick={() => setRegenType('headshot')} className="text-[10px] text-blue-400 hover:text-blue-300 transition-colors">
              {refImages.headshot ? 'Regenerate' : 'Generate'}
            </button>
          </div>
          <div className="flex flex-col items-center gap-1">
            {refImages.body ? (
              <img src={refImages.body} alt="Body reference"
                onClick={() => setLightboxUrl(refImages.body)}
                className="rounded-lg border border-gray-700 object-cover cursor-pointer hover:border-gray-500 transition-colors"
                style={{ width: 80, height: 80 }} />
            ) : (
              <div className="w-20 h-20 rounded-lg border border-gray-700 border-dashed flex items-center justify-center text-gray-600 text-[10px]">None</div>
            )}
            <span className="text-[10px] text-gray-500">Body</span>
            <button onClick={() => setRegenType('body')} className="text-[10px] text-blue-400 hover:text-blue-300 transition-colors">
              {refImages.body ? 'Regenerate' : 'Generate'}
            </button>
          </div>
        </div>
      </details>

      {/* Preamble */}
      <details open>
        <summary className="text-xs font-semibold text-gray-400 uppercase tracking-wide cursor-pointer hover:text-gray-200">
          Preamble
        </summary>
        <p className="text-[10px] text-gray-600 mt-1 mb-1.5">Philosophical foundation — defines the agent's consciousness and purpose</p>
        <textarea
          value={preamble}
          onChange={(e) => { setPreamble(e.target.value); longDebouncedSave({ myselfPreamble: e.target.value }) }}
          className={`${inputClass} resize-y`}
          style={{ minHeight: 80 }}
        />
      </details>

      {/* Identity */}
      <details open>
        <summary className="text-xs font-semibold text-gray-400 uppercase tracking-wide cursor-pointer hover:text-gray-200 mb-2">Identity</summary>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          <label className="block">
            <span className="text-[11px] text-gray-500">Name</span>
            <input type="text" value={name}
              onChange={(e) => { setName(e.target.value); debouncedSave({ name: e.target.value.trim() }) }}
              className={inputClass} />
          </label>
          <label className="block">
            <span className="text-[11px] text-gray-500">Gender</span>
            <select value={gender}
              onChange={(e) => { setGender(e.target.value); saveField({ gender: e.target.value }) }}
              className={inputClass}>
              <option value="female">Female</option>
              <option value="male">Male</option>
            </select>
          </label>
          <label className="block col-span-2">
            <span className="text-[11px] text-gray-500">Role</span>
            <input type="text" value={role}
              onChange={(e) => { setRole(e.target.value); debouncedSave({ role: e.target.value }) }}
              className={inputClass} />
          </label>
        </div>
      </details>

      {/* Appearance */}
      <details open>
        <summary className="text-xs font-semibold text-gray-400 uppercase tracking-wide cursor-pointer hover:text-gray-200 mb-2">Appearance</summary>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          <label className="block">
            <span className="text-[11px] text-gray-500">
              Birth date {displayAge != null && <span className="text-gray-600">(age {displayAge})</span>}
            </span>
            <input type="date" value={birthDate}
              onChange={(e) => { setBirthDate(e.target.value); saveField({ birthDate: e.target.value || null }) }}
              className={inputClass} />
          </label>
          <label className="block">
            <span className="text-[11px] text-gray-500">Hair</span>
            <input type="text" value={hairColor}
              onChange={(e) => { setHairColor(e.target.value); debouncedSave({ hairColor: e.target.value }) }}
              className={inputClass} />
          </label>
          <label className="block">
            <span className="text-[11px] text-gray-500">Skin tone</span>
            <input type="text" value={skinTone}
              onChange={(e) => { setSkinTone(e.target.value); debouncedSave({ skinTone: e.target.value }) }}
              className={inputClass} />
          </label>
          <label className="block">
            <span className="text-[11px] text-gray-500">Height</span>
            <input type="text" value={height}
              onChange={(e) => { setHeight(e.target.value); debouncedSave({ height: e.target.value }) }}
              className={inputClass} />
          </label>
          <label className="block">
            <span className="text-[11px] text-gray-500">Build</span>
            <input type="text" value={build}
              onChange={(e) => { setBuild(e.target.value); debouncedSave({ build: e.target.value }) }}
              className={inputClass} />
          </label>
          <label className="block">
            <span className="text-[11px] text-gray-500">Other features</span>
            <input type="text" value={otherFeatures}
              onChange={(e) => { setOtherFeatures(e.target.value); debouncedSave({ otherFeatures: e.target.value }) }}
              className={inputClass} />
          </label>
        </div>
      </details>

      {/* Narrative */}
      <details open>
        <summary className="text-xs font-semibold text-gray-400 uppercase tracking-wide cursor-pointer hover:text-gray-200 mb-1">Narrative</summary>
        <p className="text-[10px] text-gray-600 mb-1.5">First-person identity story — who the agent is, their voice, values, and history</p>
        <textarea
          value={narrative}
          onChange={(e) => { setNarrative(e.target.value); longDebouncedSave({ myselfContent: e.target.value }) }}
          className={`${inputClass} resize-y`}
          style={{ minHeight: 200 }}
          placeholder="The agent's first-person narrative..."
        />
      </details>

      {/* Custom additions */}
      <details open>
        <summary className="text-xs font-semibold text-gray-400 uppercase tracking-wide cursor-pointer hover:text-gray-200 mb-1">Custom Additions</summary>
        <p className="text-[10px] text-gray-600 mb-1.5">Additional content appended to MYSELF.md</p>
        <textarea
          value={custom}
          onChange={(e) => { setCustom(e.target.value); longDebouncedSave({ myselfCustom: e.target.value }) }}
          className={`${inputClass} resize-y`}
          style={{ minHeight: 80 }}
          placeholder="Additional identity content..."
        />
      </details>

      {/* Lightbox */}
      {lightboxUrl && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 cursor-pointer"
          onClick={() => setLightboxUrl(null)}>
          <img src={lightboxUrl} className="max-w-[90vw] max-h-[90vh] rounded-lg" alt="Full size" />
        </div>
      )}

      {/* Image regeneration modal */}
      {regenType && (
        <ImageRegenModal
          isOpen={true}
          onClose={() => setRegenType(null)}
          type={regenType}
          baseApiUrl={baseApiUrl}
          agentId={agentId}
          config={config}
          currentHeadshot={refImages.headshot}
          onSaved={() => { setRegenType(null); setTimeout(loadRefImages, 200); onConfigUpdated?.() }}
        />
      )}
    </div>
  )
}

export default AgentLifeMyself
