import { useState, useEffect, useRef } from 'react'
import { MAX_PINNED_CAPABILITIES } from '../constants'
import { buildHeadshotPrompt, buildBodyPrompt, buildAppearanceDesc, buildAssignments, generateParallel, fetchImageAsBase64 } from '../utils/imagegen'

function SetupScreen({ agentId, baseApiUrl, onSetupComplete }) {
  const [step, setStep] = useState(1)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  // Role step state
  const [roleTemplates, setRoleTemplates] = useState([])
  const [selectedRole, setSelectedRole] = useState('')
  const [useCustomRole, setUseCustomRole] = useState(false)
  const [customDescription, setCustomDescription] = useState('')

  // Design step state
  const [gender, setGender] = useState('')
  const [hairColor, setHairColor] = useState('')
  const [skinTone, setSkinTone] = useState('')
  const [height, setHeight] = useState('')
  const [build, setBuild] = useState('')
  const [age, setAge] = useState(30)
  const [otherFeatures, setOtherFeatures] = useState('')
  const [imagegenProviders, setImagegenProviders] = useState(null)
  const [imagegenReady, setImagegenReady] = useState(false)
  const [generatedImages, setGeneratedImages] = useState([])
  const [selectedAvatar, setSelectedAvatar] = useState(null)
  const [generating, setGenerating] = useState(false)
  // Body reference state
  const [bodyImages, setBodyImages] = useState([])
  const [selectedBody, setSelectedBody] = useState(null)
  const [generatingBody, setGeneratingBody] = useState(false)
  const [bodyCycles, setBodyCycles] = useState(0)
  const bodyAbortRef = useRef(null)
  const [generationCycles, setGenerationCycles] = useState(0)

  // Voice step state
  const [voices, setVoices] = useState([])
  const [selectedVoice, setSelectedVoice] = useState(null)
  const [voiceReady, setVoiceReady] = useState(false)
  const [voiceProvider, setVoiceProvider] = useState(null)
  const [loadingVoices, setLoadingVoices] = useState(false)
  const [playingVoiceId, setPlayingVoiceId] = useState(null)
  const audioRef = useRef(null)

  // Skills step state
  const [suggestedSkills, setSuggestedSkills] = useState([])
  const [selectedSkillIds, setSelectedSkillIds] = useState(new Set())
  const [selectedCatalogIds, setSelectedCatalogIds] = useState(new Set())
  const [installingCatalog, setInstallingCatalog] = useState(new Set())
  const catalogToSkillRef = useRef(new Map()) // catalogId → installed skillId
  const [loadingSkills, setLoadingSkills] = useState(false)
  const [showAllSkills, setShowAllSkills] = useState(false)
  const [showAllCatalog, setShowAllCatalog] = useState(false)
  const [showAllMcp, setShowAllMcp] = useState(false)
  const [rankedSkills, setRankedSkills] = useState([])
  const allSkillsRef = useRef([])
  const lastSearchQuery = useRef('')

  // MCP catalog state
  const [mcpCatalogResults, setMcpCatalogResults] = useState([])
  const [selectedMcpIds, setSelectedMcpIds] = useState(new Set())
  const [installingMcp, setInstallingMcp] = useState(new Set())

  // Review state
  const [reviewResults, setReviewResults] = useState({})  // capId → review report
  const [reviewsLoading, setReviewsLoading] = useState(new Set())
  const [reviewsPolling, setReviewsPolling] = useState(false)
  const reviewPollRef = useRef(null)

  // Agent name (fetched on mount)
  const [agentName, setAgentName] = useState('')

  // Agent Life step state
  const [lifeFrequency, setLifeFrequency] = useState('4')

  // Telegram step state
  const [telegramBotUsername, setTelegramBotUsername] = useState('')
  const [telegramBotToken, setTelegramBotToken] = useState('')
  const [telegramPhase, setTelegramPhase] = useState(1) // 1 = credentials, 2 = connect
  const [telegramVerified, setTelegramVerified] = useState(false)
  const [telegramChatId, setTelegramChatId] = useState(null)
  const [telegramUserName, setTelegramUserName] = useState(null)
  const [telegramChecking, setTelegramChecking] = useState(false)
  const [telegramBotDisplayName, setTelegramBotDisplayName] = useState('')
  const telegramPollRef = useRef(null)

  const TOTAL_STEPS = 8

  // Load agent name, role templates, installed skills, and imagegen status on mount
  useEffect(() => {
    fetch(`${baseApiUrl}/api/agents/${agentId}`)
      .then(r => r.json())
      .then(data => { if (data.name) setAgentName(data.name) })
      .catch(() => {})
    fetch(`${baseApiUrl}/api/skills/role-templates`)
      .then(r => r.json())
      .then(data => { if (Array.isArray(data)) setRoleTemplates(data) })
      .catch(() => {})

    fetch(`${baseApiUrl}/api/skills`)
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) {
          allSkillsRef.current = data
          setRankedSkills(data)
        }
      })
      .catch(() => {})

    fetch(`${baseApiUrl}/api/imagegen/status`)
      .then(r => r.json())
      .then(data => {
        setImagegenProviders(data.providers || {})
        setImagegenReady(data.ready || false)
      })
      .catch(() => {})
  }, [baseApiUrl])

  // When entering step 3 (voice), check voice readiness and load voices
  useEffect(() => {
    if (step !== 3) return

    const loadVoices = async () => {
      setLoadingVoices(true)
      try {
        const statusRes = await fetch(`${baseApiUrl}/api/agents/voices/status`)
        const statusData = await statusRes.json()
        setVoiceReady(statusData.ready)
        setVoiceProvider(statusData.provider || null)

        if (statusData.ready && voices.length === 0) {
          const voicesRes = await fetch(`${baseApiUrl}/api/agents/voices`)
          const voicesData = await voicesRes.json()
          if (voicesData.voices) setVoices(voicesData.voices)
        }
      } catch (e) {
        console.warn('Failed to load voices:', e)
      } finally {
        setLoadingVoices(false)
      }
    }
    loadVoices()
  }, [step, baseApiUrl])

  // When entering step 4 (skills), search skills based on role or custom description
  useEffect(() => {
    if (step !== 4) return

    const template = selectedRole ? roleTemplates.find(t => t.label === selectedRole) : null
    const searchQuery = useCustomRole ? customDescription : template?.description
    if (!searchQuery) {
      setRankedSkills(allSkillsRef.current)
      setSuggestedSkills([])
      setSelectedSkillIds(new Set())
      setSelectedCatalogIds(new Set())
      setShowAllSkills(false)
      setShowAllCatalog(false)
      return
    }

    // Skip if we already searched this query
    if (lastSearchQuery.current === searchQuery) return
    lastSearchQuery.current = searchQuery

    setLoadingSkills(true)
    setShowAllSkills(false)
    setShowAllCatalog(false)

    // Auto-select suggested skills from template (not applicable for custom descriptions)
    const suggestedNames = new Set(template?.suggestedSkills || [])
    const matchingInstalled = allSkillsRef.current.filter(s => suggestedNames.has(s.name))
    setSelectedSkillIds(new Set(matchingInstalled.map(s => s.id)))

    const searchInstalled = fetch(`${baseApiUrl}/api/skills/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: searchQuery, topK: 20 })
    })
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data) && data.length > 0) {
          const rankedIds = new Set(data.map(s => s.id))
          const unranked = allSkillsRef.current.filter(s => !rankedIds.has(s.id))
          setRankedSkills([...data, ...unranked])
        }
      })
      .catch(() => {})

    const installedNames = new Set(allSkillsRef.current.map(s => s.name.toLowerCase()))
    const searchCatalog = fetch(`${baseApiUrl}/api/skills/catalog/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: searchQuery, topK: 30 })
    })
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) {
          const filtered = data.filter(s => !installedNames.has(s.name.toLowerCase()))
          setSuggestedSkills(filtered)
        }
      })
      .catch(() => {})

    const searchMcp = fetch(`${baseApiUrl}/api/mcp/catalog/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: searchQuery, topK: 10 })
    })
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) {
          setMcpCatalogResults(data)
        }
      })
      .catch(() => {})

    Promise.all([searchInstalled, searchCatalog, searchMcp]).finally(() => setLoadingSkills(false))
  }, [step, selectedRole, customDescription, useCustomRole, roleTemplates, baseApiUrl])

  // Poll for Telegram /start when on the connection phase (step 6, phase 2)
  useEffect(() => {
    if (step !== 6 || telegramPhase !== 2 || !telegramBotToken.trim() || telegramVerified) {
      if (telegramPollRef.current) {
        clearInterval(telegramPollRef.current)
        telegramPollRef.current = null
      }
      return
    }

    const checkBot = async () => {
      try {
        setTelegramChecking(true)
        const res = await fetch(`${baseApiUrl}/api/telegram/verify-bot`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: telegramBotToken.trim(), agentName: agentName || '' })
        })
        const data = await res.json()
        if (data.valid && data.botUsername) {
          if (!telegramBotUsername.trim()) {
            setTelegramBotUsername(`@${data.botUsername}`)
          }
          setTelegramBotDisplayName(data.botName || data.botUsername)
          if (data.chatId) {
            setTelegramChatId(data.chatId)
            setTelegramUserName(data.userName)
            setTelegramVerified(true)
            if (telegramPollRef.current) {
              clearInterval(telegramPollRef.current)
              telegramPollRef.current = null
            }
          }
        }
      } catch (e) {
        // Ignore polling errors
      } finally {
        setTelegramChecking(false)
      }
    }

    // Check immediately, then poll every 3 seconds
    checkBot()
    telegramPollRef.current = setInterval(checkBot, 3000)

    return () => {
      if (telegramPollRef.current) {
        clearInterval(telegramPollRef.current)
        telegramPollRef.current = null
      }
    }
  }, [step, telegramPhase, telegramBotToken, telegramVerified, baseApiUrl])

  // When Telegram is verified, immediately save credentials so watcher starts
  useEffect(() => {
    if (telegramVerified && telegramChatId) {
      saveTelegramCredentials()
    }
  }, [telegramVerified, telegramChatId])

  const appearanceDesc = buildAppearanceDesc({ age, hairColor, skinTone, height, build, otherFeatures })
  const hasAppearance = !!(gender && (hairColor || skinTone || height || build || otherFeatures.trim()))

  // Track active image generation so we can abort on navigation
  const abortControllerRef = useRef(null)

  // Generate avatar images (appends to existing)
  const generateImages = async () => {
    // Abort any in-flight generation
    if (abortControllerRef.current) abortControllerRef.current.abort()
    const controller = new AbortController()
    abortControllerRef.current = controller

    setGenerating(true)
    const roleDesc = useCustomRole ? customDescription.trim() : (selectedRole || '')
    const prompt = buildHeadshotPrompt({ gender, age, hairColor, skinTone, height, build, otherFeatures, role: roleDesc })
    const assignments = buildAssignments(imagegenProviders, ['grok', 'gemini', 'openai'])
    if (assignments.length === 0) { setGenerating(false); return }

    const startIndex = generatedImages.length
    setGeneratedImages(prev => [...prev, ...assignments.map(() => ({ loading: true }))])

    await generateParallel({
      baseApiUrl, prompt, assignments, signal: controller.signal,
      onImageReady: (i, result) => setGeneratedImages(prev => {
        const next = [...prev]; next[startIndex + i] = result; return next
      })
    })

    if (!controller.signal.aborted) {
      setGenerationCycles(prev => prev + 1)
      setGenerating(false)
    }
  }

  // Generate body reference images using headshot as reference
  const generateBodyImages = async () => {
    if (bodyAbortRef.current) bodyAbortRef.current.abort()
    const controller = new AbortController()
    bodyAbortRef.current = controller

    setGeneratingBody(true)

    let referenceImages = null
    if (selectedAvatar) {
      try {
        const ref = await fetchImageAsBase64(`${baseApiUrl}/api/imagegen/files/${selectedAvatar}`)
        referenceImages = [ref]
      } catch (e) {
        console.warn('Failed to load headshot for body reference:', e)
      }
    }

    const prompt = buildBodyPrompt({ gender, height, build })
    const assignments = buildAssignments(imagegenProviders, ['gemini', 'openai', 'grok'])
    if (assignments.length === 0) { setGeneratingBody(false); return }

    const startIndex = bodyImages.length
    setBodyImages(prev => [...prev, ...assignments.map(() => ({ loading: true }))])

    await generateParallel({
      baseApiUrl, prompt, assignments, referenceImages, signal: controller.signal,
      onImageReady: (i, result) => setBodyImages(prev => {
        const next = [...prev]; next[startIndex + i] = result; return next
      })
    })

    if (!controller.signal.aborted) {
      setBodyCycles(prev => prev + 1)
      setGeneratingBody(false)
    }
  }

  // Toggle a skill selection
  const toggleSkill = (skillId) => {
    setSelectedSkillIds(prev => {
      const next = new Set(prev)
      if (next.has(skillId)) {
        next.delete(skillId)
      } else if (next.size < MAX_PINNED_CAPABILITIES) {
        next.add(skillId)
      }
      return next
    })
  }

  // Toggle a catalog skill — install it first, then track selection
  const toggleCatalogSkill = async (catalogSkill) => {
    const catalogId = catalogSkill.id

    if (selectedCatalogIds.has(catalogId)) {
      // Also remove the installed skill ID from selectedSkillIds
      const installedSkillId = catalogToSkillRef.current.get(catalogId)
      if (installedSkillId) {
        setSelectedSkillIds(prev => {
          const next = new Set(prev)
          next.delete(installedSkillId)
          return next
        })
      }
      setSelectedCatalogIds(prev => {
        const next = new Set(prev)
        next.delete(catalogId)
        return next
      })
      return
    }

    // Use selectedSkillIds.size as the limit check — it already includes installed catalog skills
    if (selectedSkillIds.size >= MAX_PINNED_CAPABILITIES) return

    setInstallingCatalog(prev => new Set(prev).add(catalogId))
    try {
      const res = await fetch(`${baseApiUrl}/api/skills/catalog/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ catalogId })
      })
      const data = await res.json()
      if (res.ok && data.skillId) {
        catalogToSkillRef.current.set(catalogId, data.skillId)
        setSelectedSkillIds(prev => {
          const next = new Set(prev)
          next.add(data.skillId)
          return next
        })
        // Track that a review is in progress for this skill
        if (data.reviewStatus === 'pending') {
          setReviewsLoading(prev => new Set([...prev, data.skillId]))
        }
        setSelectedCatalogIds(prev => {
          const next = new Set(prev)
          next.add(catalogId)
          return next
        })
      }
    } catch (e) {
      // Install failed — ignore silently
    } finally {
      setInstallingCatalog(prev => {
        const next = new Set(prev)
        next.delete(catalogId)
        return next
      })
    }
  }

  // Toggle an MCP server — install, start, register tools, then track as selected
  const toggleMcpServer = async (mcpEntry) => {
    const catalogId = mcpEntry.id

    if (selectedMcpIds.has(catalogId)) {
      setSelectedMcpIds(prev => {
        const next = new Set(prev)
        next.delete(catalogId)
        return next
      })
      return
    }

    setInstallingMcp(prev => new Set(prev).add(catalogId))
    try {
      const res = await fetch(`${baseApiUrl}/api/mcp/catalog/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ catalogId })
      })
      const data = await res.json()
      if (res.ok && data.serverId) {
        // Start the server so its tools get registered as capabilities
        await fetch(`${baseApiUrl}/api/mcp/servers/${data.serverId}/start`, { method: 'POST' })
        setSelectedMcpIds(prev => new Set(prev).add(catalogId))
      }
    } catch (e) {
      // Install/start failed — ignore silently
    } finally {
      setInstallingMcp(prev => {
        const next = new Set(prev)
        next.delete(catalogId)
        return next
      })
    }
  }

  // Check if any catalog skills need review (have reviewsLoading entries)
  const hasCatalogSkillsToReview = reviewsLoading.size > 0 || Object.keys(reviewResults).length > 0

  // Finalize agent — save config, mark setup complete (pinning happens after review)
  // Called when transitioning from step 4 to step 5 (review step)
  const finalizeAgent = async () => {
    setSaving(true)
    setError(null)
    try {
      // Pin non-catalog skills immediately (they don't need review)
      const catalogSkillIds = new Set([...catalogToSkillRef.current.values()])
      for (const skillId of selectedSkillIds) {
        if (catalogSkillIds.has(skillId)) continue // Catalog skills pinned after review
        try {
          await fetch(`${baseApiUrl}/api/skills/agent/${agentId}/pin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ skillId })
          })
        } catch (e) {}
      }

      const res = await fetch(`${baseApiUrl}/api/agents/${agentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          setupComplete: true,
          gender,
          pronouns: gender === 'male' ? 'he' : 'she',
          role: useCustomRole ? customDescription.trim() : (selectedRole || ''),
          appearance: appearanceDesc,
          age: age,
          hairColor: hairColor,
          skinTone: skinTone,
          height: height,
          build: build,
          otherFeatures: otherFeatures.trim(),
          ...(selectedAvatar ? { avatarUrl: `/api/imagegen/files/${selectedAvatar}`, showImage: true } : {}),
          ...(selectedBody ? { bodyUrl: `/api/imagegen/files/${selectedBody}` } : {}),
          ...(selectedVoice ? { voiceId: selectedVoice.voiceId, voiceName: selectedVoice.name } : {})
        })
      })
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        throw new Error(errData.error || `HTTP ${res.status}`)
      }

      // Skip review step if no catalog skills to review
      if (hasCatalogSkillsToReview) {
        setStep(5)
      } else {
        setStep(6)
      }
    } catch (err) {
      console.error('Setup finalize failed:', err)
      setError(err.message || 'Failed to save settings')
    } finally {
      setSaving(false)
    }
  }

  // Approve a skill from review step — unquarantine and pin
  const approveSkill = async (skillId) => {
    try {
      await fetch(`${baseApiUrl}/api/skills/${skillId}/approve`, { method: 'POST' })
      // Pin the approved skill
      await fetch(`${baseApiUrl}/api/skills/agent/${agentId}/pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillId })
      })
      setReviewResults(prev => ({
        ...prev,
        [skillId]: { ...prev[skillId], approved: true }
      }))
    } catch (e) {
      console.warn('Failed to approve skill:', e)
    }
  }

  // Reject a skill from review step
  const rejectSkill = async (skillId) => {
    try {
      await fetch(`${baseApiUrl}/api/skills/${skillId}/reject`, { method: 'POST' })
      setReviewResults(prev => ({
        ...prev,
        [skillId]: { ...prev[skillId], rejected: true }
      }))
      // Remove from selected
      setSelectedSkillIds(prev => {
        const next = new Set(prev)
        next.delete(skillId)
        return next
      })
    } catch (e) {
      console.warn('Failed to reject skill:', e)
    }
  }

  // Poll for review results when on review step
  useEffect(() => {
    if (step !== 5 || reviewsLoading.size === 0) return

    const poll = async () => {
      const stillLoading = new Set()
      for (const skillId of reviewsLoading) {
        if (reviewResults[skillId]?.report) continue
        try {
          const res = await fetch(`${baseApiUrl}/api/skills/${skillId}/review`)
          const data = await res.json()
          if (data.status === 'reviewed' || data.status === 'approved' || data.status === 'rejected') {
            setReviewResults(prev => ({ ...prev, [skillId]: data }))
          } else {
            stillLoading.add(skillId)
          }
        } catch {
          stillLoading.add(skillId)
        }
      }
      setReviewsLoading(stillLoading)
    }

    poll()
    const interval = setInterval(poll, 3000)
    return () => clearInterval(interval)
  }, [step, reviewsLoading.size])

  // Save Telegram credentials — called when connection is verified or on finish
  const saveTelegramCredentials = async () => {
    const body = {}
    if (telegramBotUsername.trim()) body.telegramBotUsername = telegramBotUsername.trim().replace(/^@/, '')
    if (telegramBotToken.trim()) body.telegramBotToken = telegramBotToken.trim()
    if (telegramChatId) body.telegramChatId = String(telegramChatId)
    if (Object.keys(body).length === 0) return
    try {
      await fetch(`${baseApiUrl}/api/agents/${agentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
    } catch (e) {
      console.warn('Failed to save Telegram credentials:', e)
    }
  }

  const hasRole = useCustomRole ? !!customDescription.trim() : !!selectedRole
  const template = selectedRole ? roleTemplates.find(t => t.label === selectedRole) : null
  const suggestedNames = new Set(template?.suggestedSkills || [])
  const totalPinned = selectedSkillIds.size

  const recommendedSkills = hasRole
    ? rankedSkills.filter(s => suggestedNames.has(s.name))
    : []
  const otherRelevantSkills = hasRole
    ? rankedSkills.filter(s => !suggestedNames.has(s.name))
    : rankedSkills
  const INSTALLED_PREVIEW = 5
  const visibleOtherSkills = showAllSkills ? otherRelevantSkills : otherRelevantSkills.slice(0, INSTALLED_PREVIEW)
  const hiddenCount = otherRelevantSkills.length - INSTALLED_PREVIEW

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-900 overflow-y-auto py-12">
      <div className="w-full max-w-md px-6">
        {/* Agent name (shown on steps after naming) + progress dots */}
        {agentName && step > 1 && (
          <p className="text-center text-sm font-medium text-gray-300 mb-3">{agentName}</p>
        )}
        {/* Progress dots */}
        <div className="flex justify-center gap-2 mb-8">
          {[1, 2, 3, 4, 5, 6, 7].map(s => (
            <div
              key={s}
              className={`w-2 h-2 rounded-full transition-colors ${
                s === step ? 'bg-blue-500' : s < step ? 'bg-blue-800' : 'bg-gray-700'
              }`}
            />
          ))}
        </div>

        {/* Step 1: Name & Role */}
        {step === 1 && (
          <div className="bg-gray-800 rounded-xl p-6 border border-gray-700">
            <h2 className="text-lg font-semibold text-white mb-1">Name & role</h2>
            <p className="text-sm text-gray-400 mb-4">
              Give your agent a name and choose what they do.
            </p>

            {/* Agent name */}
            <label className="block text-xs text-gray-400 mb-1 font-medium">Name</label>
            <input
              type="text"
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
              placeholder="Agent name..."
              autoFocus
              className="w-full bg-gray-700 text-white border border-gray-600 rounded-lg px-3 py-2.5 text-sm outline-none focus:border-blue-500 mb-4"
            />

            {!useCustomRole ? (
              <>
                <select
                  value={selectedRole}
                  onChange={(e) => {
                    if (e.target.value === '__custom__') {
                      setUseCustomRole(true); setSelectedRole(''); lastSearchQuery.current = ''
                    } else {
                      setSelectedRole(e.target.value); lastSearchQuery.current = ''
                    }
                  }}
                  className="w-full bg-gray-700 text-white border border-gray-600 rounded-lg px-3 py-2.5 text-sm outline-none focus:border-blue-500 mb-2"
                >
                  <option value="">Select a role...</option>
                  {roleTemplates.map(t => (
                    <option key={t.label} value={t.label}>{t.label}</option>
                  ))}
                  <option value="__custom__">Describe it yourself...</option>
                </select>

                {selectedRole && template && (
                  <p className="text-xs text-gray-500 mb-2">
                    {template.description}
                  </p>
                )}

                <button
                  onClick={() => { setUseCustomRole(true); setSelectedRole(''); lastSearchQuery.current = '' }}
                  className="text-xs text-blue-400 hover:text-blue-300 transition-colors mb-4"
                >
                  Or describe it yourself
                </button>
              </>
            ) : (
              <>
                <textarea
                  value={customDescription}
                  onChange={(e) => { setCustomDescription(e.target.value); lastSearchQuery.current = '' }}
                  placeholder="e.g. An agent that manages my calendar, sends reminders, and drafts emails..."
                  rows={3}
                  className="w-full bg-gray-700 text-white border border-gray-600 rounded-lg px-3 py-2.5 text-sm outline-none focus:border-blue-500 mb-2 resize-none"
                />
                <button
                  onClick={() => { setUseCustomRole(false); setCustomDescription(''); lastSearchQuery.current = '' }}
                  className="text-xs text-blue-400 hover:text-blue-300 transition-colors mb-4"
                >
                  Pick from presets instead
                </button>
              </>
            )}

            <div className="flex gap-3 mt-2">
              <button
                onClick={() => {
                  // Save name if changed
                  if (agentName.trim()) {
                    fetch(`${baseApiUrl}/api/agents/${agentId}`, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ name: agentName.trim() })
                    }).catch(() => {})
                  }
                  setStep(2)
                }}
                disabled={!hasRole || !agentName.trim()}
                className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Design */}
        {step === 2 && (
          <div className="bg-gray-800 rounded-xl p-6 border border-gray-700">
            <h2 className="text-lg font-semibold text-white mb-1">Design your agent</h2>
            <p className="text-sm text-gray-400 mb-4">
              Choose a gender and define their look.
            </p>

            {/* Gender dropdown */}
            <label className="block text-xs text-gray-400 mb-1 font-medium">Gender</label>
            <select
              value={gender}
              onChange={(e) => setGender(e.target.value)}
              className="w-full bg-gray-700 text-white border border-gray-600 rounded-lg px-3 py-2.5 text-sm outline-none focus:border-blue-500 mb-3"
            >
              <option value="">Select...</option>
              <option value="female">Female</option>
              <option value="male">Male</option>
            </select>

            {/* Age */}
            <label className="block text-xs text-gray-400 mb-1 font-medium">Age</label>
            <input
              type="range"
              min={18}
              max={90}
              value={age}
              onChange={(e) => setAge(Number(e.target.value))}
              className="w-full mb-1 accent-blue-500"
            />
            <p className="text-xs text-gray-500 mb-3 text-right">{age} years old</p>

            {/* Appearance selectors */}
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1 font-medium">Hair color</label>
                <select
                  value={hairColor}
                  onChange={(e) => setHairColor(e.target.value)}
                  className="w-full bg-gray-700 text-white border border-gray-600 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500"
                >
                  <option value="">Select...</option>
                  <option value="black">Black</option>
                  <option value="dark brown">Dark brown</option>
                  <option value="brown">Brown</option>
                  <option value="light brown">Light brown</option>
                  <option value="blonde">Blonde</option>
                  <option value="dirty blonde">Dirty blonde</option>
                  <option value="strawberry blonde">Strawberry blonde</option>
                  <option value="red">Red</option>
                  <option value="auburn">Auburn</option>
                  <option value="gray">Gray</option>
                  <option value="white">White</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1 font-medium">Skin tone</label>
                <select
                  value={skinTone}
                  onChange={(e) => setSkinTone(e.target.value)}
                  className="w-full bg-gray-700 text-white border border-gray-600 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500"
                >
                  <option value="">Select...</option>
                  <option value="fair">Fair</option>
                  <option value="light">Light</option>
                  <option value="medium">Medium</option>
                  <option value="olive">Olive</option>
                  <option value="tan">Tan</option>
                  <option value="brown">Brown</option>
                  <option value="dark brown">Dark brown</option>
                  <option value="deep">Deep</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1 font-medium">Height</label>
                <select
                  value={height}
                  onChange={(e) => setHeight(e.target.value)}
                  className="w-full bg-gray-700 text-white border border-gray-600 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500"
                >
                  <option value="">Select...</option>
                  <option value="short">Short</option>
                  <option value="below average">Below average</option>
                  <option value="average">Average</option>
                  <option value="above average">Above average</option>
                  <option value="tall">Tall</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1 font-medium">Build</label>
                <select
                  value={build}
                  onChange={(e) => setBuild(e.target.value)}
                  className="w-full bg-gray-700 text-white border border-gray-600 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500"
                >
                  <option value="">Select...</option>
                  <option value="slim">Slim</option>
                  <option value="athletic">Athletic</option>
                  <option value="average">Average</option>
                  <option value="muscular">Muscular</option>
                  <option value="curvy">Curvy</option>
                  <option value="heavy">Heavy</option>
                </select>
              </div>
            </div>

            <label className="block text-xs text-gray-400 mb-1 font-medium">Other characteristics</label>
            <input
              type="text"
              value={otherFeatures}
              onChange={(e) => setOtherFeatures(e.target.value)}
              placeholder="e.g. freckles, glasses, curly hair, tattoos..."
              className="w-full bg-gray-700 text-white border border-gray-600 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500 mb-4"
            />

            {/* Image generation section */}
            {imagegenReady ? (
              <>
                {/* Initial generate button (only before first generation) */}
                {generatedImages.length === 0 && (
                  <button
                    onClick={generateImages}
                    disabled={!hasAppearance || generating}
                    className="w-full py-2 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors mb-3"
                  >
                    {generating ? 'Generating...' : 'Generate portraits'}
                  </button>
                )}

                {/* Select an image instruction */}
                {generatedImages.length > 0 && !generating && (
                  <p className="text-xs text-gray-400 mb-2 font-medium">Select an image</p>
                )}

                {/* Image grid */}
                {generatedImages.length > 0 && (
                  <div className="grid grid-cols-2 gap-2 mb-3">
                    {generatedImages.map((img, i) => (
                      <button
                        key={i}
                        onClick={() => {
                          if (img.filename) {
                            setSelectedAvatar(prev => prev === img.filename ? null : img.filename)
                          }
                        }}
                        disabled={!img.filename}
                        className={`aspect-square rounded-lg overflow-hidden border-2 transition-all ${
                          selectedAvatar === img.filename
                            ? 'border-blue-500 ring-2 ring-blue-500/30'
                            : 'border-gray-600 hover:border-gray-500'
                        } ${!img.filename ? 'cursor-default' : 'cursor-pointer'}`}
                      >
                        {img.loading ? (
                          <div className="w-full h-full bg-gray-700 flex items-center justify-center">
                            <div className="w-6 h-6 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
                          </div>
                        ) : img.error ? (
                          <div className="w-full h-full bg-gray-700 flex items-center justify-center">
                            <span className="text-gray-500 text-xs">Failed</span>
                          </div>
                        ) : (
                          <img
                            src={`${baseApiUrl}${img.url}`}
                            alt={`Portrait option ${i + 1}`}
                            className="w-full h-full object-cover"
                          />
                        )}
                      </button>
                    ))}
                  </div>
                )}

                {/* More images button (after first cycle, up to 5 cycles) */}
                {generationCycles >= 1 && generationCycles < 5 && !generating && (
                  <button
                    onClick={generateImages}
                    disabled={!hasAppearance}
                    className="w-full py-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors mb-2"
                  >
                    More images
                  </button>
                )}

                {/* Generating indicator when appending */}
                {generating && generatedImages.length > 0 && (
                  <p className="text-xs text-gray-500 text-center mb-2">Generating...</p>
                )}

                {/* Body reference section — shown after headshot is selected */}
                {selectedAvatar && (
                  <div className="mt-4 pt-4 border-t border-gray-700">
                    <p className="text-xs text-gray-400 mb-2 font-medium">Body reference</p>
                    <p className="text-xs text-gray-500 mb-3">
                      Generate a full-body reference based on the headshot above.
                    </p>

                    {bodyImages.length === 0 && (
                      <button
                        onClick={generateBodyImages}
                        disabled={generatingBody}
                        className="w-full py-2 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors mb-3"
                      >
                        {generatingBody ? 'Generating...' : 'Generate body reference'}
                      </button>
                    )}

                    {bodyImages.length > 0 && !generatingBody && (
                      <p className="text-xs text-gray-400 mb-2">Select a body reference</p>
                    )}

                    {bodyImages.length > 0 && (
                      <div className="grid grid-cols-2 gap-2 mb-3">
                        {bodyImages.map((img, i) => (
                          <button
                            key={i}
                            onClick={() => {
                              if (img.filename) {
                                setSelectedBody(prev => prev === img.filename ? null : img.filename)
                              }
                            }}
                            disabled={!img.filename}
                            className={`aspect-[3/4] rounded-lg overflow-hidden border-2 transition-all ${
                              selectedBody === img.filename
                                ? 'border-blue-500 ring-2 ring-blue-500/30'
                                : 'border-gray-600 hover:border-gray-500'
                            } ${!img.filename ? 'cursor-default' : 'cursor-pointer'}`}
                          >
                            {img.loading ? (
                              <div className="w-full h-full bg-gray-700 flex items-center justify-center">
                                <div className="w-6 h-6 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
                              </div>
                            ) : img.error ? (
                              <div className="w-full h-full bg-gray-700 flex items-center justify-center">
                                <span className="text-gray-500 text-xs">Failed</span>
                              </div>
                            ) : (
                              <img
                                src={`${baseApiUrl}${img.url}`}
                                alt={`Body option ${i + 1}`}
                                className="w-full h-full object-cover"
                              />
                            )}
                          </button>
                        ))}
                      </div>
                    )}

                    {bodyCycles >= 1 && bodyCycles < 5 && !generatingBody && (
                      <button
                        onClick={generateBodyImages}
                        className="w-full py-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors mb-2"
                      >
                        More images
                      </button>
                    )}

                    {generatingBody && bodyImages.length > 0 && (
                      <p className="text-xs text-gray-500 text-center mb-2">Generating...</p>
                    )}
                  </div>
                )}
              </>
            ) : (
              /* No imagegen providers configured */
              <div className="bg-gray-700/50 rounded-lg p-3 mb-4 border border-gray-600">
                <p className="text-xs text-gray-400 mb-2">
                  To generate a profile image, add an API key for an image provider in Settings &gt; API Keys (OpenAI, xAI, or Google).
                </p>
                <button
                  onClick={() => {
                    if (abortControllerRef.current) { abortControllerRef.current.abort(); setGenerating(false) }
                    setStep(3)
                  }}
                  className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
                >
                  Continue without image
                </button>
              </div>
            )}

            <div className="flex gap-3 mt-2">
              <button
                onClick={() => setStep(1)}
                className="flex-1 py-2.5 text-sm text-gray-400 hover:text-gray-200 transition-colors"
              >
                Back
              </button>
              <button
                onClick={() => {
                  if (abortControllerRef.current) { abortControllerRef.current.abort(); setGenerating(false) }
                  if (bodyAbortRef.current) { bodyAbortRef.current.abort(); setGeneratingBody(false) }
                  setStep(3)
                }}
                disabled={!selectedAvatar}
                className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Voice */}
        {step === 3 && (
          <div className="bg-gray-800 rounded-xl p-6 border border-gray-700">
            <h2 className="text-lg font-semibold text-white mb-1">Choose a voice</h2>
            <p className="text-sm text-gray-400 mb-4">
              Pick a voice for text-to-speech.{voiceProvider && ` Showing ${voiceProvider === 'elevenlabs' ? 'ElevenLabs' : 'OpenAI'} voices.`}
            </p>

            {loadingVoices ? (
              <div className="text-center py-6">
                <div className="inline-block w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                <p className="text-xs text-gray-500 mt-2">Loading voices...</p>
              </div>
            ) : !voiceReady ? (
              <div className="bg-gray-700/50 rounded-lg p-3 mb-4 border border-gray-600">
                <p className="text-xs text-gray-400 mb-2">
                  To use text-to-speech, add an OpenAI or ElevenLabs API key in Settings &gt; API Keys, then select a provider in Settings &gt; Voice Output.
                </p>
              </div>
            ) : (
              <div className="max-h-80 overflow-y-auto space-y-1.5 mb-3 pr-1">
                {(() => {
                  const userCategories = new Set(['cloned', 'generated'])
                  const filtered = voices.filter(v => {
                    if (userCategories.has(v.category)) return true
                    const voiceGender = v.labels?.gender
                    if (!voiceGender || !gender) return true
                    return voiceGender === gender
                  })
                  const customVoices = filtered.filter(v => userCategories.has(v.category))
                  const libraryVoices = filtered.filter(v => !userCategories.has(v.category))
                  const sorted = [...customVoices, ...libraryVoices]
                  let shownLibraryHeader = false
                  return sorted.map((voice, i) => {
                    const isCustom = userCategories.has(voice.category)
                    const showCustomHeader = isCustom && i === 0
                    const showLibraryHeader = !isCustom && !shownLibraryHeader && customVoices.length > 0
                    if (showLibraryHeader) shownLibraryHeader = true
                    return (
                      <div key={voice.voiceId}>
                        {showCustomHeader && (
                          <p className="text-xs text-gray-400 font-medium mb-1.5">Your voices</p>
                        )}
                        {showLibraryHeader && (
                          <p className="text-xs text-gray-400 font-medium mb-1.5 mt-3">Library</p>
                        )}
                {/* voice card start */}
                  <button
                    key={voice.voiceId}
                    onClick={() => setSelectedVoice(prev => prev?.voiceId === voice.voiceId ? null : voice)}
                    className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-colors ${
                      selectedVoice?.voiceId === voice.voiceId
                        ? 'bg-blue-600/20 border border-blue-500/40 text-white'
                        : 'bg-gray-700 border border-gray-600 text-gray-300 hover:border-gray-500'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className={`w-4 h-4 rounded-full border flex items-center justify-center text-xs flex-shrink-0 ${
                        selectedVoice?.voiceId === voice.voiceId ? 'bg-blue-500 border-blue-500 text-white' : 'border-gray-500'
                      }`}>
                        {selectedVoice?.voiceId === voice.voiceId ? '\u2713' : ''}
                      </span>
                      <span className="font-medium">{voice.name}</span>
                      {voice.category && (
                        <span className="text-xs text-gray-500 ml-auto">{voice.category}</span>
                      )}
                      {voice.previewUrl && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            if (playingVoiceId === voice.voiceId) {
                              audioRef.current?.pause()
                              setPlayingVoiceId(null)
                            } else {
                              if (audioRef.current) audioRef.current.pause()
                              const audio = new Audio(voice.previewUrl)
                              audioRef.current = audio
                              setPlayingVoiceId(voice.voiceId)
                              audio.play()
                              audio.onended = () => setPlayingVoiceId(null)
                            }
                          }}
                          className="text-xs text-blue-400 hover:text-blue-300 transition-colors flex-shrink-0"
                        >
                          {playingVoiceId === voice.voiceId ? 'Stop' : 'Play'}
                        </button>
                      )}
                    </div>
                    {voice.labels && Object.keys(voice.labels).length > 0 && (
                      <div className="flex gap-1 mt-1 ml-6 flex-wrap">
                        {Object.entries(voice.labels).slice(0, 3).map(([key, val]) => (
                          <span key={key} className="text-[10px] text-gray-500 bg-gray-600/50 rounded px-1.5 py-0.5">
                            {val}
                          </span>
                        ))}
                      </div>
                    )}
                  </button>
                      </div>
                    )
                  })
                })()}
              </div>
            )}

            <div className="flex gap-3 mt-2">
              <button
                onClick={() => {
                  if (audioRef.current) audioRef.current.pause()
                  setPlayingVoiceId(null)
                  setStep(2)
                }}
                className="flex-1 py-2.5 text-sm text-gray-400 hover:text-gray-200 transition-colors"
              >
                Back
              </button>
              <button
                onClick={() => {
                  if (audioRef.current) audioRef.current.pause()
                  setPlayingVoiceId(null)
                  setStep(4)
                }}
                className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
              >
                {selectedVoice ? 'Continue' : 'Skip'}
              </button>
            </div>
          </div>
        )}

        {/* Step 4: Skills */}
        {step === 4 && (
          <div className="bg-gray-800 rounded-xl p-6 border border-gray-700">
            <h2 className="text-lg font-semibold text-white mb-1">Choose capabilities</h2>
            <p className="text-sm text-gray-400 mb-4">
              {useCustomRole
                ? 'Capabilities ranked by relevance to your description.'
                : selectedRole
                  ? `Capabilities for ${selectedRole}.`
                  : 'Select capabilities to pin for this agent.'}
            </p>

            {/* Loading spinner */}
            {loadingSkills && (
              <div className="text-center py-3">
                <div className="inline-block w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                <p className="text-xs text-gray-500 mt-2">Finding capabilities for this role...</p>
              </div>
            )}

            {/* Recommended skills (from role template) */}
            {!loadingSkills && !useCustomRole && recommendedSkills.length > 0 && (
              <div className="mb-3">
                <p className="text-xs text-gray-400 mb-2 font-medium">
                  Recommended ({totalPinned}/{MAX_PINNED_CAPABILITIES} pinned)
                </p>
                <div className="space-y-1">
                  {recommendedSkills.map(skill => (
                    <SkillRow
                      key={skill.id}
                      skill={skill}
                      isSelected={selectedSkillIds.has(skill.id)}
                      atLimit={totalPinned >= MAX_PINNED_CAPABILITIES && !selectedSkillIds.has(skill.id)}
                      onToggle={() => toggleSkill(skill.id)}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Other installed skills */}
            {!loadingSkills && visibleOtherSkills.length > 0 && (
              <div className="mb-3">
                <p className="text-xs text-gray-400 mb-2 font-medium">
                  {!useCustomRole && recommendedSkills.length > 0 ? 'Other installed skills' : `Installed skills (${totalPinned}/${MAX_PINNED_CAPABILITIES} pinned)`}
                </p>
                <div className="space-y-1">
                  {visibleOtherSkills.map(skill => (
                    <SkillRow
                      key={skill.id}
                      skill={skill}
                      isSelected={selectedSkillIds.has(skill.id)}
                      atLimit={totalPinned >= MAX_PINNED_CAPABILITIES && !selectedSkillIds.has(skill.id)}
                      onToggle={() => toggleSkill(skill.id)}
                    />
                  ))}
                </div>
                {hiddenCount > 0 && !showAllSkills && (
                  <button
                    onClick={() => setShowAllSkills(true)}
                    className="w-full mt-1 py-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors"
                  >
                    Show {hiddenCount} more...
                  </button>
                )}
              </div>
            )}

            {/* Community catalog skills */}
            {!loadingSkills && suggestedSkills.length > 0 && (
              <div className="mb-3">
                <div className="flex items-center gap-2 mb-2">
                  <p className="text-xs text-gray-400 font-medium">Community skills</p>
                  <span className="text-xs text-gray-600">from ClawHub</span>
                </div>
                <div className="space-y-1">
                  {(showAllCatalog ? suggestedSkills : suggestedSkills.slice(0, 5)).map(skill => {
                    const isInstalled = selectedCatalogIds.has(skill.id)
                    const isInstalling = installingCatalog.has(skill.id)
                    const atLimit = totalPinned >= MAX_PINNED_CAPABILITIES && !isInstalled
                    return (
                      <button
                        key={skill.id}
                        onClick={() => toggleCatalogSkill(skill)}
                        disabled={atLimit || isInstalling}
                        className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                          isInstalled
                            ? 'bg-blue-600/20 border border-blue-500/40 text-white'
                            : atLimit
                              ? 'bg-gray-700/30 border border-gray-700/50 text-gray-600 cursor-not-allowed'
                              : 'bg-gray-700/50 border border-gray-700 text-gray-300 hover:border-gray-500'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span className={`w-4 h-4 rounded border flex items-center justify-center text-xs flex-shrink-0 ${
                            isInstalled ? 'bg-blue-500 border-blue-500 text-white' :
                            isInstalling ? 'border-blue-400' : 'border-gray-600'
                          }`}>
                            {isInstalled ? '\u2713' : isInstalling ? <span className="block w-2.5 h-2.5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" /> : ''}
                          </span>
                          <span className="font-medium">{skill.name}</span>
                          {skill.verified ? (
                            <span className="text-xs text-blue-400" title="Verified">{'\u2713'}</span>
                          ) : null}
                          {skill.download_count > 0 && (
                            <span className="text-xs text-gray-600 ml-auto">
                              {skill.download_count >= 1000
                                ? `${(skill.download_count / 1000).toFixed(1)}k`
                                : skill.download_count}
                            </span>
                          )}
                        </div>
                        {skill.description && (
                          <p className="text-xs text-gray-500 mt-0.5 ml-6 line-clamp-1">{skill.description}</p>
                        )}
                      </button>
                    )
                  })}
                </div>
                {suggestedSkills.length > 5 && !showAllCatalog && (
                  <button
                    onClick={() => setShowAllCatalog(true)}
                    className="w-full mt-1 py-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors"
                  >
                    Show {suggestedSkills.length - 5} more...
                  </button>
                )}
              </div>
            )}

            {/* MCP Servers from catalog */}
            {!loadingSkills && mcpCatalogResults.length > 0 && (
              <div className="mb-3">
                <div className="flex items-center gap-2 mb-2">
                  <p className="text-xs text-gray-400 font-medium">MCP Servers</p>
                  <span className="text-xs text-gray-600">from MCP Registry</span>
                </div>
                <div className="space-y-1">
                  {(showAllMcp ? mcpCatalogResults : mcpCatalogResults.slice(0, 5)).map(entry => {
                    const isInstalled = selectedMcpIds.has(entry.id)
                    const isInstalling = installingMcp.has(entry.id)
                    return (
                      <button
                        key={entry.id}
                        onClick={() => toggleMcpServer(entry)}
                        disabled={isInstalling}
                        className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                          isInstalled
                            ? 'bg-blue-600/20 border border-blue-500/40 text-white'
                            : 'bg-gray-700/50 border border-gray-700 text-gray-300 hover:border-gray-500'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span className={`w-4 h-4 rounded border flex items-center justify-center text-xs flex-shrink-0 ${
                            isInstalled ? 'bg-blue-500 border-blue-500 text-white' :
                            isInstalling ? 'border-blue-400' : 'border-gray-600'
                          }`}>
                            {isInstalled ? '\u2713' : isInstalling ? <span className="block w-2.5 h-2.5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" /> : ''}
                          </span>
                          <span className="font-medium">{entry.name}</span>
                          <span className="text-[10px] text-purple-400 bg-purple-500/10 rounded px-1.5 py-0.5 font-medium">MCP</span>
                          {entry.verified ? (
                            <span className="text-xs text-blue-400" title="Verified">{'\u2713'}</span>
                          ) : null}
                          {entry.official ? (
                            <span className="text-xs text-green-400" title="Official">{'\u2713'}</span>
                          ) : null}
                        </div>
                        {entry.description && (
                          <p className="text-xs text-gray-500 mt-0.5 ml-6 line-clamp-1">{entry.description}</p>
                        )}
                      </button>
                    )
                  })}
                </div>
                {mcpCatalogResults.length > 5 && !showAllMcp && (
                  <button
                    onClick={() => setShowAllMcp(true)}
                    className="w-full mt-1 py-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors"
                  >
                    Show {mcpCatalogResults.length - 5} more...
                  </button>
                )}
              </div>
            )}

            <div className="flex gap-3 mt-4">
              <button
                onClick={() => setStep(3)}
                className="flex-1 py-2.5 text-sm text-gray-400 hover:text-gray-200 transition-colors"
              >
                Back
              </button>
              <button
                onClick={finalizeAgent}
                disabled={saving}
                className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
              >
                {saving ? 'Saving...' : totalPinned > 0 ? `Continue (${totalPinned} pinned)` : 'Skip'}
              </button>
            </div>
            {error && (
              <p className="text-xs text-red-400 mt-3">{error}</p>
            )}
          </div>
        )}

        {/* Step 5: Review & Approve Catalog Skills */}
        {step === 5 && (
          <div className="bg-gray-800 rounded-xl p-6 border border-gray-700">
            <h2 className="text-lg font-semibold text-white mb-1">Review & Approve Skills</h2>
            <p className="text-sm text-gray-400 mb-4">
              Community skills are reviewed for security before activation. Review the results below.
            </p>

            {/* Loading state */}
            {reviewsLoading.size > 0 && (
              <div className="text-center py-3 mb-4">
                <div className="inline-block w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                <p className="text-xs text-gray-500 mt-2">
                  Reviewing {reviewsLoading.size} skill{reviewsLoading.size !== 1 ? 's' : ''}...
                </p>
              </div>
            )}

            {/* Review results */}
            <div className="space-y-2 mb-4">
              {[...catalogToSkillRef.current.entries()].map(([catalogId, skillId]) => {
                const review = reviewResults[skillId]
                const isLoading = reviewsLoading.has(skillId)
                const report = review?.report
                const riskLevel = review?.riskLevel || report?.riskLevel
                const riskColors = {
                  low: 'text-green-400 bg-green-500/10',
                  medium: 'text-yellow-400 bg-yellow-500/10',
                  high: 'text-red-400 bg-red-500/10',
                  unknown: 'text-gray-400 bg-gray-500/10'
                }
                const riskColor = riskColors[riskLevel] || riskColors.unknown
                // Find skill name from catalog results
                const catalogSkill = suggestedSkills.find(s => s.id === catalogId)
                const skillName = catalogSkill?.name || skillId

                if (!selectedSkillIds.has(skillId) && !review) return null

                return (
                  <div key={skillId} className="bg-gray-700/50 border border-gray-600 rounded-lg p-3">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium text-sm text-white">{skillName}</span>
                      {isLoading && (
                        <span className="inline-block w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                      )}
                      {riskLevel && !isLoading && (
                        <span className={`text-xs rounded px-1.5 py-0.5 font-medium ${riskColor}`}>
                          {riskLevel.toUpperCase()} RISK
                        </span>
                      )}
                      {review?.approved && (
                        <span className="text-xs text-green-400 font-medium">Approved</span>
                      )}
                      {review?.rejected && (
                        <span className="text-xs text-red-400 font-medium">Rejected</span>
                      )}
                    </div>

                    {/* Summary */}
                    {report?.summary && (
                      <p className="text-xs text-gray-400 mb-2">{report.summary}</p>
                    )}

                    {/* Findings */}
                    {report?.findings?.length > 0 && (
                      <div className="space-y-1 mb-2">
                        {report.findings.map((f, i) => (
                          <div key={i} className="text-xs flex items-start gap-1.5">
                            <span className={
                              f.severity === 'critical' ? 'text-red-400' :
                              f.severity === 'warning' ? 'text-yellow-400' : 'text-blue-400'
                            }>
                              {f.severity === 'critical' ? '\u26A0' : f.severity === 'warning' ? '\u26A0' : '\u2139'}
                            </span>
                            <span className="text-gray-300">{f.description}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Actions */}
                    {review && !review.approved && !review.rejected && !isLoading && (
                      <div className="flex gap-2 mt-2">
                        <button
                          onClick={() => approveSkill(skillId)}
                          className="px-3 py-1 text-xs bg-green-600/20 text-green-400 border border-green-500/30 rounded hover:bg-green-600/30 transition-colors"
                        >
                          Approve
                        </button>
                        <button
                          onClick={() => rejectSkill(skillId)}
                          className="px-3 py-1 text-xs bg-red-600/20 text-red-400 border border-red-500/30 rounded hover:bg-red-600/30 transition-colors"
                        >
                          Reject
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setStep(4)}
                className="flex-1 py-2.5 text-sm text-gray-400 hover:text-gray-200 transition-colors"
              >
                Back
              </button>
              <button
                onClick={() => setStep(6)}
                className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {/* Step 6: Agent Life */}
        {step === 6 && (
          <div className="bg-gray-800 rounded-xl p-6 border border-gray-700">
            <h2 className="text-lg font-semibold text-white mb-1">Agent Life</h2>
            <p className="text-sm text-gray-400 mb-5">
              Your agent maintains a personal life: keeping a journal, reflecting on conversations, and generating self-portraits. Choose how often this happens.
            </p>

            <div className="space-y-2 mb-5">
              {[
                { value: 'off', label: 'Off', desc: 'No automatic life routine' },
                { value: '8', label: 'Every 8 hours', desc: '3 times per day' },
                { value: '4', label: 'Every 4 hours', desc: 'Recommended', recommended: true },
                { value: '2', label: 'Every 2 hours', desc: '12 times per day' },
                { value: '1', label: 'Every hour', desc: '24 times per day' },
              ].map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setLifeFrequency(opt.value)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-colors ${
                    lifeFrequency === opt.value
                      ? 'bg-blue-600/20 border border-blue-500/40 text-white'
                      : 'bg-gray-700 border border-gray-600 text-gray-300 hover:border-gray-500'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`w-4 h-4 rounded-full border flex items-center justify-center text-xs flex-shrink-0 ${
                      lifeFrequency === opt.value ? 'bg-blue-500 border-blue-500 text-white' : 'border-gray-500'
                    }`}>
                      {lifeFrequency === opt.value ? '\u2713' : ''}
                    </span>
                    <span className="font-medium">{opt.label}</span>
                    {opt.recommended && (
                      <span className="text-xs text-blue-400 ml-auto">Recommended</span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5 ml-6">{opt.desc}</p>
                </button>
              ))}
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => hasCatalogSkillsToReview ? setStep(5) : setStep(4)}
                className="flex-1 py-2.5 text-sm text-gray-400 hover:text-gray-200 transition-colors"
              >
                Back
              </button>
              <button
                onClick={async () => {
                  try {
                    await fetch(`${baseApiUrl}/api/agents/${agentId}`, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ lifeFrequency })
                    })
                  } catch (e) {
                    console.warn('Failed to save life frequency:', e)
                  }
                  setStep(7)
                }}
                className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {/* Step 7: Telegram — Phase 1: Credentials */}
        {step === 7 && telegramPhase === 1 && (
          <div className="bg-gray-800 rounded-xl p-6 border border-gray-700">
            <h2 className="text-lg font-semibold text-white mb-1 text-center">Mobile Communication</h2>
            <p className="text-sm text-gray-400 mb-5 text-center">
              Connect a Telegram bot so your agent can message you on the go.
            </p>

            <div className="space-y-3 text-xs text-gray-300 leading-relaxed mb-5">
              <div>
                <p className="font-medium text-white mb-1">1. Open BotFather</p>
                <p>Open Telegram and search for <span className="text-blue-400 font-mono">@BotFather</span>. It's Telegram's official bot for creating and managing bots.</p>
              </div>
              <div>
                <p className="font-medium text-white mb-1">2. Create a new bot</p>
                <p>Send <span className="text-blue-400 font-mono">/newbot</span> to BotFather. Choose a display name and a username ending in "bot" (e.g. "my_agent_bot").</p>
              </div>
              <div>
                <p className="font-medium text-white mb-1">3. Copy the token</p>
                <p>BotFather will reply with a token like <span className="text-blue-400 font-mono">123456:ABC-DEF1234...</span>. Paste it below.</p>
              </div>
            </div>

            <label className="block text-xs text-gray-400 mb-1">Bot Username</label>
            <input
              type="text"
              value={telegramBotUsername}
              onChange={(e) => setTelegramBotUsername(e.target.value)}
              placeholder="@my_agent_bot"
              className="w-full bg-gray-700 text-white border border-gray-600 rounded-lg px-3 py-2 text-sm outline-none focus:border-gray-500 mb-3"
            />

            <label className="block text-xs text-gray-400 mb-1">Bot Token</label>
            <input
              type="password"
              value={telegramBotToken}
              onChange={(e) => {
                setTelegramBotToken(e.target.value)
                setTelegramVerified(false)
                setTelegramChatId(null)
              }}
              placeholder="Paste bot token from @BotFather"
              className="w-full bg-gray-700 text-white border border-gray-600 rounded-lg px-3 py-2 text-sm outline-none focus:border-gray-500 mb-4"
            />

            <div className="flex gap-3">
              <button
                onClick={() => setStep(6)}
                className="flex-1 py-2.5 text-sm text-gray-400 hover:text-gray-200 transition-colors"
              >
                Back
              </button>
              <button
                onClick={() => {
                  if (telegramBotToken.trim()) {
                    setTelegramPhase(2)
                  } else {
                    setStep(8)
                  }
                }}
                className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
              >
                {telegramBotToken.trim() ? 'Continue' : 'Skip'}
              </button>
            </div>
          </div>
        )}

        {/* Step 7 Phase 2: Connect with bot */}
        {step === 7 && telegramPhase === 2 && (
          <div className="bg-gray-800 rounded-xl p-6 border border-gray-700">
            <h2 className="text-lg font-semibold text-white mb-1 text-center">Connect with your bot</h2>
            <p className="text-sm text-gray-400 mb-6 text-center">
              Link your Telegram account so {agentName || 'your agent'} can reach you.
            </p>

            <div className="space-y-4 mb-6">
              <div className="bg-gray-900/50 rounded-lg p-4 text-sm text-gray-300 space-y-3">
                <div className="flex items-start gap-3">
                  <span className="text-blue-400 font-bold mt-0.5">1</span>
                  <p>Open Telegram and search for <span className="text-blue-400 font-semibold">{telegramBotUsername.trim() ? telegramBotUsername.trim().replace(/^@?/, '@') : telegramBotDisplayName || 'your bot'}</span></p>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-blue-400 font-bold mt-0.5">2</span>
                  <p>Open the chat and send <span className="text-blue-400 font-mono font-semibold">/start</span></p>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-blue-400 font-bold mt-0.5">3</span>
                  <p>The bot will confirm the connection and you're all set!</p>
                </div>
              </div>

              {/* Connection status */}
              <div className="flex items-center justify-center py-3">
                {telegramVerified ? (
                  <div className="flex items-center gap-2 text-green-400 text-sm font-medium">
                    <span className="text-lg">&#10003;</span>
                    <span>Connected{telegramUserName ? ` as ${telegramUserName}` : ''}!</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-gray-500 text-sm">
                    <span className="inline-block w-3 h-3 border-2 border-gray-500 border-t-transparent rounded-full animate-spin"></span>
                    <span>Waiting for /start...</span>
                  </div>
                )}
              </div>

              {/* Group chat privacy instructions */}
              {telegramVerified && (
                <div className="bg-gray-900/50 rounded-lg p-4 text-xs text-gray-400 space-y-2">
                  <p className="text-white font-medium text-sm">Want group chats with multiple agents?</p>
                  <p>By default, Telegram bots can only see <span className="text-gray-300">/commands</span> in groups. To let {agentName || 'your agent'} participate in group conversations:</p>
                  <ol className="list-decimal list-inside space-y-1 text-gray-300">
                    <li>Open Telegram and message <span className="text-blue-400 font-mono">@BotFather</span></li>
                    <li>Send <span className="text-blue-400 font-mono">/setprivacy</span></li>
                    <li>Select your bot</li>
                    <li>Choose <span className="text-blue-400 font-mono">Disable</span></li>
                  </ol>
                  <p>If the bot is already in a group, remove and re-add it for the change to take effect. You can also do this later anytime via @BotFather.</p>
                </div>
              )}
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setTelegramPhase(1)}
                className="flex-1 py-2.5 text-sm text-gray-400 hover:text-gray-200 transition-colors"
              >
                Back
              </button>
              <button
                onClick={() => setStep(8)}
                className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
              >
                {telegramVerified ? 'Continue' : 'Skip for now'}
              </button>
            </div>
          </div>
        )}

        {/* Step 8: Done */}
        {step === 8 && (
          <div className="bg-gray-800 rounded-xl p-6 border border-gray-700 text-center">
            <div className="text-3xl mb-3">&#10003;</div>
            <h2 className="text-lg font-semibold text-white mb-1">You're all set</h2>
            {totalPinned > 0 && (
              <p className="text-sm text-gray-400 mb-1">
                {totalPinned} skill{totalPinned !== 1 ? 's' : ''} pinned.
              </p>
            )}
            <p className="text-xs text-gray-500 mb-5">
              You can change these anytime in Settings.
            </p>

            <div className="flex gap-3">
              <button
                onClick={() => setStep(7)}
                className="flex-1 py-2.5 text-sm text-gray-400 hover:text-gray-200 transition-colors"
              >
                Back
              </button>
              <button
                onClick={async () => {
                  await saveTelegramCredentials()
                  onSetupComplete()
                }}
                className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
              >
                Start chatting
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function SkillRow({ skill, isSelected, atLimit, onToggle }) {
  const badgeColors = {
    api: 'text-emerald-400 bg-emerald-500/10',
    skill: 'text-amber-400 bg-amber-500/10',
    mcp: 'text-purple-400 bg-purple-500/10',
  }
  const badgeColor = badgeColors[skill.type] || badgeColors.skill
  return (
    <button
      onClick={onToggle}
      disabled={atLimit}
      className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
        isSelected
          ? 'bg-blue-600/20 border border-blue-500/40 text-white'
          : atLimit
            ? 'bg-gray-700/50 border border-gray-700 text-gray-600 cursor-not-allowed'
            : 'bg-gray-700 border border-gray-600 text-gray-300 hover:border-gray-500'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={`w-4 h-4 rounded border flex items-center justify-center text-xs flex-shrink-0 ${
          isSelected ? 'bg-blue-500 border-blue-500 text-white' : 'border-gray-500'
        }`}>
          {isSelected ? '\u2713' : ''}
        </span>
        <span className="font-medium">{skill.name}</span>
        {skill.type && (
          <span className={`text-[10px] rounded px-1.5 py-0.5 font-medium ${badgeColor}`}>
            {skill.type.toUpperCase()}
          </span>
        )}
      </div>
      {skill.description && (
        <p className="text-xs text-gray-500 mt-0.5 ml-6 line-clamp-1">{skill.description}</p>
      )}
    </button>
  )
}

export default SetupScreen
