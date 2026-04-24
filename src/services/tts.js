/**
 * TTS Service — Facade
 *
 * Routes TTS operations to the active provider (ElevenLabs or OpenAI).
 * Manages provider-agnostic settings and text chunking.
 */

const ElevenLabsProvider = require('./tts-elevenlabs')
const OpenAIProvider = require('./tts-openai')
const KokoroProvider = require('./tts-kokoro')

const PROVIDERS = {
  elevenlabs: ElevenLabsProvider,
  openai: OpenAIProvider,
  kokoro: KokoroProvider
}

// Display labels keyed by provider id. Single source of truth — UI components
// import this so adding a fourth provider doesn't require touching ternaries
// or hardcoded button arrays. Keep keys in sync with PROVIDERS above; the
// tests/services/tts-providers-labels.test.js file enforces parity.
const PROVIDER_LABELS = {
  elevenlabs: 'ElevenLabs',
  openai:     'OpenAI',
  kokoro:     'Kokoro (local)'
}

// Tagline shown beneath each provider card. Helps the user understand the
// trade-off before picking. Optional — UI may render or skip.
const PROVIDER_HELP = {
  elevenlabs: 'Highest-quality voices; cloud API; requires an API key.',
  openai:     'Solid quality; cloud API; requires an OpenAI API key.',
  kokoro:     'Free, fully local; runs in os8-launcher (no API key); 54 prebuilt voices.'
}

// Derived from each provider module's IS_LOCAL export. Single source of truth:
// provider classification lives with the provider, not duplicated in UIs.
const PROVIDER_IS_LOCAL = Object.fromEntries(
  Object.entries(PROVIDERS).map(([id, mod]) => [id, !!mod.IS_LOCAL])
)

// Per-mode settings keys. Mirrors agent_models(agent_id, mode) — the user's
// pick in each mode is preserved when they flip ai_mode, and each mode only
// ever shows compatible providers.
const PROVIDER_KEY_BY_MODE = {
  local:       'tts_provider_local',
  proprietary: 'tts_provider_proprietary'
}

// Legacy single-slot key. Read as a fallback during the transition window so a
// fresh install that somehow lands before the migrator runs still resolves a
// provider; writes always go to the mode-scoped key.
const LEGACY_PROVIDER_KEY = 'tts_provider'

// Auto-pick preference order per mode. First configured provider wins. Mirrors
// the onboarding flow's priority (src/renderer/onboarding.js) so an upgrader
// who's been living in proprietary mode sees the same pick the onboarding
// would have made for them.
const PROVIDER_PREFERENCE_BY_MODE = {
  local:       ['kokoro'],
  proprietary: ['elevenlabs', 'openai']
}

/**
 * TextChunker - Buffers text and emits chunks at sentence boundaries
 * Used for streaming TTS to ensure natural speech breaks
 */
class TextChunker {
  constructor(options = {}) {
    this.minChunkChars = options.minChunkChars || 50
    this.flushTimeoutMs = options.flushTimeoutMs || 400
    this.buffer = ''
    this.timer = null
    this.onChunk = null // (chunk: string) => void
  }

  /**
   * Add text to buffer, returns any complete chunks
   * @param {string} text - Text to add
   * @returns {string[]} Array of complete chunks ready to send
   */
  addText(text) {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }

    this.buffer += text
    const chunks = []

    // Look for sentence boundaries: . ! ? followed by space/newline or end
    const sentencePattern = /[.!?](?:\s|$)/g
    let lastEnd = 0
    let match

    while ((match = sentencePattern.exec(this.buffer)) !== null) {
      const endIndex = match.index + 1 // Include the punctuation
      const chunk = this.buffer.slice(lastEnd, endIndex).trim()

      // Only emit if chunk is long enough
      if (chunk.length >= this.minChunkChars) {
        chunks.push(chunk)
        lastEnd = endIndex
      } else if (this.buffer.length - lastEnd >= this.minChunkChars * 2) {
        // If buffer is getting long, emit even short sentence
        chunks.push(chunk)
        lastEnd = endIndex
      }
    }

    // Keep remainder in buffer
    if (lastEnd > 0) {
      this.buffer = this.buffer.slice(lastEnd).trim()
    }

    // Set timeout fallback for incomplete sentences
    if (this.buffer.length > 0) {
      this.timer = setTimeout(() => {
        if (this.buffer.length >= this.minChunkChars) {
          const chunk = this.buffer.trim()
          this.buffer = ''
          this.onChunk?.(chunk)
        }
      }, this.flushTimeoutMs)
    }

    return chunks
  }

  /**
   * Force flush any remaining text
   * @returns {string} Remaining text in buffer
   */
  flush() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const remaining = this.buffer.trim()
    this.buffer = ''
    return remaining
  }

  /**
   * Reset chunker state
   */
  reset() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.buffer = ''
  }
}

/**
 * Provider-agnostic TTS defaults
 */
const TTS_DEFAULTS = {
  enabled: false,
  voiceId: ElevenLabsProvider.DEFAULTS.voiceId,
  voiceName: ElevenLabsProvider.DEFAULTS.voiceName,
  defaultVoiceFemale: ElevenLabsProvider.DEFAULTS.defaultVoiceFemale,
  defaultVoiceFemaleName: ElevenLabsProvider.DEFAULTS.defaultVoiceFemaleName,
  defaultVoiceMale: ElevenLabsProvider.DEFAULTS.defaultVoiceMale,
  defaultVoiceMaleName: ElevenLabsProvider.DEFAULTS.defaultVoiceMaleName,
  model: ElevenLabsProvider.DEFAULTS.model,
  stability: ElevenLabsProvider.DEFAULTS.stability,
  similarityBoost: ElevenLabsProvider.DEFAULTS.similarityBoost,
  speed: 1.0,
  autoSpeak: true,
  interruptOnInput: true,
}

/**
 * TTS Service - static methods with db as first parameter
 */
class TTSService {
  static TTS_DEFAULTS = TTS_DEFAULTS
  static TextChunker = TextChunker
  static PROVIDERS = PROVIDERS
  static PROVIDER_LABELS = PROVIDER_LABELS
  static PROVIDER_HELP = PROVIDER_HELP
  static PROVIDER_IS_LOCAL = PROVIDER_IS_LOCAL

  /** True if the named provider is a local (launcher-backed) provider. */
  static isLocalProvider(name) {
    return !!PROVIDER_IS_LOCAL[name]
  }

  /**
   * Current ai_mode, or 'proprietary' if unset. Matches RoutingService.getMode
   * semantics; duplicated here so tts doesn't take a hard service dep.
   */
  static getMode(db) {
    const SettingsService = require('./settings')
    return SettingsService.get(db, 'ai_mode') === 'local' ? 'local' : 'proprietary'
  }

  /**
   * List providers eligible for a given mode. Server-side filter, consumed by
   * the Personal Assistant settings UI and anywhere else that picks a
   * provider. Providers are filtered by their own IS_LOCAL, so adding a new
   * provider module drops into the right slot automatically. There is no
   * "None" entry — voice on/off is the separate `enabled` flag in TTS
   * settings; when no provider for the mode is configured, the UI falls back
   * to an informational "no provider configured" state instead of a picker.
   */
  static listProvidersForMode(db, mode) {
    const active = mode || TTSService.getMode(db)
    const wantLocal = active === 'local'
    return Object.keys(PROVIDERS)
      .filter(id => !!PROVIDER_IS_LOCAL[id] === wantLocal)
      .map(id => ({
        value: id,
        label: PROVIDER_LABELS[id],
        help: PROVIDER_HELP[id],
        isLocal: !!PROVIDER_IS_LOCAL[id]
      }))
  }

  /**
   * True if the named provider is configured on this machine. Cloud providers
   * need a non-empty API key in env_variables; local providers report true
   * when the sync isAvailable branch returns available (it's optimistic about
   * launcher state — the async probe is for the status banner, not auto-pick,
   * since we don't want this call to block on the launcher's TCP socket).
   */
  static isConfigured(db, providerId) {
    const mod = PROVIDERS[providerId]
    if (!mod) return false
    if (mod.API_KEY_ENV === null) return true  // local — treat as configured
    const EnvService = require('./env')
    const record = EnvService.get(db, mod.API_KEY_ENV)
    return !!(record && record.value)
  }

  /**
   * Resolve the provider that should be active for the current ai_mode, with
   * auto-pick on first access of a never-set slot AND a remap pass whenever
   * the effective provider has changed since the last resolve (e.g. user
   * flipped ai_mode, which swaps the pinned value but doesn't itself remap
   * the global default voices or agents.voice_id). Return shape:
   *   { provider, source, mode }
   * where `source` is 'pinned' (slot held a valid provider), 'auto' (the
   * resolver picked one and persisted it), or 'none' (no eligible configured
   * provider — UI should render a "no provider configured" explanation).
   */
  static resolveActiveProvider(db) {
    const mode = TTSService.getMode(db)
    const pinned = TTSService.getProviderName(db)

    if (pinned) {
      // Pinned, but the currently-active provider (the one whose voices
      // populate tts.defaultVoice* and agents.voice_id) might be stale if
      // the user just flipped ai_mode. Reconcile before returning.
      TTSService._makeActive(db, pinned)
      return { provider: pinned, source: 'pinned', mode }
    }

    const preferences = PROVIDER_PREFERENCE_BY_MODE[mode] || []
    for (const candidate of preferences) {
      if (!PROVIDERS[candidate]) continue
      if (TTSService.isConfigured(db, candidate)) {
        TTSService.setProvider(db, candidate)
        TTSService._makeActive(db, candidate)
        return { provider: candidate, source: 'auto', mode }
      }
    }
    return { provider: null, source: 'none', mode }
  }

  /**
   * Make `toProvider` the active TTS provider — remap every agent's voice to
   * one valid for toProvider (prefer a previously-saved per-agent voice from
   * agent_voices, else the provider's gender default), snapshot the outgoing
   * provider's defaults into perProvider, restore the incoming provider's
   * defaults, and update tts.activeProvider to track which provider the
   * global voice fields currently reflect. Idempotent: no-op when
   * tts.activeProvider already equals toProvider.
   *
   * This is the reconciliation step between "the user's pick" (per-mode pin,
   * via setProvider) and "what the voices are actually rendered against"
   * (agent.voice_id + tts.defaultVoice*). Called by switchProvider (explicit
   * pick) and resolveActiveProvider (implicit transitions like mode flips).
   */
  static _makeActive(db, toProvider) {
    const AgentService = require('./agent')
    const current = TTSService.getSettings(db)
    const fromActive = current.activeProvider || null
    if (fromActive === toProvider) return { changed: false }

    const agents = db.prepare(`SELECT id, voice_id, voice_name, gender FROM agents`).all()

    const transaction = db.transaction(() => {
      for (const agent of agents) {
        // Remember the outgoing voice so round-tripping this provider later
        // restores the user's prior pick.
        if (fromActive && agent.voice_id) {
          TTSService.saveAgentVoice(db, agent.id, fromActive, agent.voice_id, agent.voice_name)
        }
        if (toProvider && PROVIDERS[toProvider]) {
          const saved = TTSService.getAgentVoice(db, agent.id, toProvider)
          if (saved) {
            AgentService.update(db, agent.id, {
              voice_id: saved.voiceId,
              voice_name: saved.voiceName
            })
          } else {
            const defaults = TTSService.getProviderDefaults(toProvider)
            if (defaults) {
              const gender = agent.gender || 'female'
              const defaultVoice = defaults[gender] || defaults.female
              AgentService.update(db, agent.id, {
                voice_id: defaultVoice.id,
                voice_name: defaultVoice.name
              })
            }
          }
        }
      }

      if (fromActive) TTSService._snapshotProviderDefaults(db, fromActive)
      if (toProvider && PROVIDERS[toProvider]) TTSService._restoreProviderDefaults(db, toProvider)

      // Record which provider the global voice fields now reflect. Used by
      // the next _makeActive call to decide whether to remap.
      TTSService.setSettings(db, { activeProvider: toProvider || null })
    })

    transaction()
    return { changed: true, fromActive, toActive: toProvider, agentCount: agents.length }
  }

  /**
   * Get TTS settings from database
   * @param {Database} db - SQLite database
   * @returns {object} TTS settings merged with defaults
   */
  static getSettings(db) {
    const SettingsService = require('./settings')
    const stored = SettingsService.get(db, 'tts')
    if (stored) {
      try {
        return { ...TTS_DEFAULTS, ...JSON.parse(stored) }
      } catch (e) {
        return TTS_DEFAULTS
      }
    }
    return TTS_DEFAULTS
  }

  /**
   * Update TTS settings in database. When the caller edits default voices
   * (defaultVoiceFemale/Male), the change is also written through to the
   * perProvider[currentProvider] sub-object so switching providers and back
   * restores the user's pick instead of clobbering it with the provider
   * module's generic DEFAULTS.
   */
  static setSettings(db, settings) {
    const SettingsService = require('./settings')
    const current = TTSService.getSettings(db)
    const merged = { ...current, ...settings }

    // Write-through: if the user changed a default voice and we have a
    // currently-active provider, stash the pick under perProvider[provider].
    const providerName = TTSService.getProviderName(db)
    const touchedVoiceFields = (
      'defaultVoiceFemale' in settings ||
      'defaultVoiceMale' in settings ||
      'defaultVoiceFemaleName' in settings ||
      'defaultVoiceMaleName' in settings
    )
    if (providerName && touchedVoiceFields) {
      const perProvider = { ...(merged.perProvider || {}) }
      perProvider[providerName] = {
        ...(perProvider[providerName] || {}),
        defaultVoiceFemale: merged.defaultVoiceFemale,
        defaultVoiceFemaleName: merged.defaultVoiceFemaleName,
        defaultVoiceMale: merged.defaultVoiceMale,
        defaultVoiceMaleName: merged.defaultVoiceMaleName
      }
      merged.perProvider = perProvider
    }

    SettingsService.set(db, 'tts', JSON.stringify(merged))
    return merged
  }

  /**
   * Snapshot the current active default voices into perProvider[providerName].
   * Called before a provider switch so the user's pick under the outgoing
   * provider survives the round-trip.
   */
  static _snapshotProviderDefaults(db, providerName) {
    if (!providerName) return
    const current = TTSService.getSettings(db)
    const perProvider = { ...(current.perProvider || {}) }
    perProvider[providerName] = {
      defaultVoiceFemale: current.defaultVoiceFemale,
      defaultVoiceFemaleName: current.defaultVoiceFemaleName,
      defaultVoiceMale: current.defaultVoiceMale,
      defaultVoiceMaleName: current.defaultVoiceMaleName
    }
    const SettingsService = require('./settings')
    SettingsService.set(db, 'tts', JSON.stringify({ ...current, perProvider }))
  }

  /**
   * Restore the active default voices from perProvider[providerName] if a
   * snapshot exists; otherwise seed from the provider module's DEFAULTS. This
   * is what switchProvider and resolveActiveProvider call after landing on a
   * new provider, so the "default voices for agents without a voice assigned"
   * row always reflects the user's last pick for that provider.
   */
  static _restoreProviderDefaults(db, providerName) {
    const mod = PROVIDERS[providerName]
    if (!mod) return
    const current = TTSService.getSettings(db)
    const saved = current.perProvider?.[providerName]
    const providerDefaults = mod.DEFAULTS || {}
    const next = {
      ...current,
      model: providerDefaults.model || current.model,
      voiceId: providerDefaults.voiceId || current.voiceId,
      voiceName: providerDefaults.voiceName || current.voiceName,
      defaultVoiceFemale: saved?.defaultVoiceFemale || providerDefaults.defaultVoiceFemale || current.defaultVoiceFemale,
      defaultVoiceFemaleName: saved?.defaultVoiceFemaleName || providerDefaults.defaultVoiceFemaleName || current.defaultVoiceFemaleName,
      defaultVoiceMale: saved?.defaultVoiceMale || providerDefaults.defaultVoiceMale || current.defaultVoiceMale,
      defaultVoiceMaleName: saved?.defaultVoiceMaleName || providerDefaults.defaultVoiceMaleName || current.defaultVoiceMaleName
    }
    const SettingsService = require('./settings')
    SettingsService.set(db, 'tts', JSON.stringify(next))
  }

  /**
   * Get active TTS provider module
   * @param {Database} db
   * @returns {object|null} Provider module (tts-elevenlabs or tts-openai), or null
   */
  static getProvider(db) {
    const name = TTSService.getProviderName(db)
    return name ? PROVIDERS[name] : null
  }

  /**
   * Get the active provider name for the current ai_mode. Reads the
   * mode-scoped key (tts_provider_local / tts_provider_proprietary), with a
   * one-shot fallback to the legacy single-slot key for pre-migration safety.
   * @param {Database} db
   * @returns {string|null}
   */
  static getProviderName(db) {
    const SettingsService = require('./settings')
    const mode = TTSService.getMode(db)
    const key = PROVIDER_KEY_BY_MODE[mode]
    let provider = SettingsService.get(db, key)
    if (!provider) {
      // Pre-migration / fresh-install fallback: use the legacy key only if its
      // value's classification matches the current mode. Avoids routing an
      // elevenlabs pick through local mode just because the migrator hasn't
      // run yet.
      const legacy = SettingsService.get(db, LEGACY_PROVIDER_KEY)
      if (legacy && PROVIDERS[legacy] && PROVIDER_IS_LOCAL[legacy] === (mode === 'local')) {
        provider = legacy
      }
    }
    if (provider && PROVIDERS[provider]) return provider
    return null
  }

  /**
   * Set the active TTS provider. Writes to the slot that matches the
   * provider's own IS_LOCAL classification — not the current ai_mode — so
   * configuring each mode's pick is independent of the live mode. Empty
   * string clears the *current* mode's slot.
   * @param {Database} db
   * @param {string|null} provider - 'elevenlabs', 'openai', 'kokoro', or ''
   */
  static setProvider(db, provider) {
    const SettingsService = require('./settings')
    if (!provider) {
      // Clear only the active mode's slot — the other mode's pick is preserved.
      const currentMode = TTSService.getMode(db)
      SettingsService.set(db, PROVIDER_KEY_BY_MODE[currentMode], '')
      return
    }
    if (!PROVIDERS[provider]) {
      throw new Error(`Unknown TTS provider: ${provider}`)
    }
    const targetMode = PROVIDER_IS_LOCAL[provider] ? 'local' : 'proprietary'
    SettingsService.set(db, PROVIDER_KEY_BY_MODE[targetMode], provider)
  }

  /**
   * Check if TTS is available (provider set + API key present, or for local
   * providers, launcher reachable).
   * @param {Database} db
   * @returns {{ available: boolean, provider: string|null, reason?: string }}
   */
  static isAvailable(db) {
    const EnvService = require('./env')
    const provider = TTSService.getProvider(db)
    if (!provider) {
      return { available: false, provider: null, reason: 'no_provider' }
    }
    // Phase 3 (os8-3-5): local providers (Kokoro) have API_KEY_ENV=null.
    // The sync path reports "available" optimistically; the async variant
    // (isAvailableAsync below) probes the launcher for an honest answer.
    // UI components that can await should prefer the async variant — it
    // distinguishes "launcher down" from "model not serving" so the status
    // banner can be specific.
    if (provider.API_KEY_ENV === null) {
      return { available: true, provider: provider.PROVIDER_ID }
    }
    const apiKeyRecord = EnvService.get(db, provider.API_KEY_ENV)
    if (!apiKeyRecord || !apiKeyRecord.value) {
      return { available: false, provider: provider.PROVIDER_ID, reason: 'no_api_key' }
    }
    return { available: true, provider: provider.PROVIDER_ID }
  }

  /**
   * Async availability check — for local providers (API_KEY_ENV=null) probes
   * the launcher to know whether the model is actually serving. Cloud
   * providers behave the same as the sync isAvailable.
   *
   * Reasons for null-key providers:
   *   - 'launcher_down'      → /api/health unreachable
   *   - 'model_not_serving'  → launcher reachable but the provider's family
   *                            isn't in the running models list
   *   - undefined            → available
   *
   * @param {Database} db
   * @returns {Promise<{ available: boolean, provider: string|null, reason?: string }>}
   */
  static async isAvailableAsync(db) {
    const sync = TTSService.isAvailable(db)
    const provider = TTSService.getProvider(db)
    // Cloud providers (or no provider) — sync answer is authoritative.
    if (!provider || provider.API_KEY_ENV !== null) return sync
    // Local provider — probe the launcher.
    const LauncherClient = require('./launcher-client')
    const reachable = await LauncherClient.isReachable()
    if (!reachable) {
      return { available: false, provider: provider.PROVIDER_ID, reason: 'launcher_down' }
    }
    let caps = null
    try { caps = await LauncherClient.getCapabilities() } catch (_e) { /* leave caps null */ }
    // Look up the launcher_model for this provider's family by convention:
    // 'kokoro' → 'local-kokoro-v1' etc. via id LIKE 'local-<provider>%'.
    const familyRow = db.prepare(
      `SELECT launcher_model FROM ai_model_families WHERE container_id = 'local' AND id LIKE ? LIMIT 1`
    ).get(`local-${provider.PROVIDER_ID}%`)
    const launcherModel = familyRow?.launcher_model
    if (!launcherModel) {
      // No matching family seeded — can't prove unavailable, report optimistic.
      return { available: true, provider: provider.PROVIDER_ID }
    }
    let serving = false
    if (caps) {
      for (const entries of Object.values(caps)) {
        const list = Array.isArray(entries) ? entries : [entries]
        for (const entry of list) {
          if ((entry?.model || entry?.model_id) === launcherModel) { serving = true; break }
        }
        if (serving) break
      }
    }
    if (!serving) {
      return { available: false, provider: provider.PROVIDER_ID, reason: 'model_not_serving' }
    }
    return { available: true, provider: provider.PROVIDER_ID }
  }

  /**
   * Get API key for active provider. Returns null for local providers
   * (Kokoro) which have no auth — callers should treat null as "skip the
   * API-key check" rather than "missing key".
   * @param {Database} db
   * @returns {string|null}
   */
  static getApiKey(db) {
    const EnvService = require('./env')
    const provider = TTSService.getProvider(db)
    if (!provider) return null
    if (provider.API_KEY_ENV === null) return null  // local provider — no auth
    const record = EnvService.get(db, provider.API_KEY_ENV)
    return record?.value || null
  }

  /**
   * Get voices from active provider
   * @param {Database} db
   * @returns {Promise<Array>}
   */
  static async getVoices(db) {
    const provider = TTSService.getProvider(db)
    if (!provider) throw new Error('No TTS provider configured')
    const apiKey = TTSService.getApiKey(db)
    // Local providers have API_KEY_ENV=null; pass through and let the provider
    // ignore the apiKey arg (it does — see tts-kokoro.js).
    if (apiKey === null && provider.API_KEY_ENV !== null) {
      throw new Error(`${provider.PROVIDER_ID} API key not configured`)
    }
    return provider.getVoices(apiKey)
  }

  /**
   * Get WebSocket URL for streaming (ElevenLabs only, returns null for OpenAI)
   * @param {Database} db
   * @param {object} options - { voiceId, model }
   * @returns {string|null}
   */
  static getWebSocketUrl(db, options = {}) {
    const provider = TTSService.getProvider(db)
    return provider?.getWebSocketUrl(options) || null
  }

  /**
   * Get provider-specific default voices
   * @param {string} providerName - 'elevenlabs' or 'openai'
   * @returns {{ female: {id, name}, male: {id, name} }|null}
   */
  static getProviderDefaults(providerName) {
    const provider = PROVIDERS[providerName]
    return provider ? provider.getDefaultVoices() : null
  }

  /**
   * Save an agent's voice selection for a specific provider
   * @param {Database} db
   * @param {string} agentId
   * @param {string} provider - 'elevenlabs' or 'openai'
   * @param {string} voiceId
   * @param {string} voiceName
   */
  static saveAgentVoice(db, agentId, provider, voiceId, voiceName) {
    db.prepare(`
      INSERT INTO agent_voices (agent_id, provider, voice_id, voice_name)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(agent_id, provider) DO UPDATE SET voice_id = ?, voice_name = ?
    `).run(agentId, provider, voiceId, voiceName, voiceId, voiceName)
  }

  /**
   * Get an agent's saved voice for a specific provider
   * @param {Database} db
   * @param {string} agentId
   * @param {string} provider - 'elevenlabs' or 'openai'
   * @returns {{ voiceId: string, voiceName: string }|null}
   */
  static getAgentVoice(db, agentId, provider) {
    const row = db.prepare(
      `SELECT voice_id, voice_name FROM agent_voices WHERE agent_id = ? AND provider = ?`
    ).get(agentId, provider)
    if (!row) return null
    return { voiceId: row.voice_id, voiceName: row.voice_name }
  }

  /**
   * Switch the active TTS provider for the current ai_mode, saving/restoring
   * per-agent voices as appropriate. If `toProvider` is for the *other* mode
   * (e.g. user is in local mode but passes 'elevenlabs'), this writes that
   * mode's slot without touching agents — the pick is remembered for when the
   * user next flips mode, but no active voice transition is happening now.
   * @param {Database} db
   * @param {string} toProvider - provider id or '' (none, clears active slot)
   * @returns {{ previousProvider, newProvider, agentCount, crossMode }}
   */
  static switchProvider(db, toProvider) {
    const currentMode = TTSService.getMode(db)
    const classMatchesMode = !toProvider
      || PROVIDER_IS_LOCAL[toProvider] === (currentMode === 'local')

    // Cross-mode write: just update the other mode's slot; no agent remap.
    if (!classMatchesMode) {
      const fromProvider = TTSService.getProviderName(db)
      TTSService.setProvider(db, toProvider)
      return {
        previousProvider: fromProvider,
        newProvider: toProvider,
        agentCount: 0,
        crossMode: true
      }
    }

    const fromProvider = TTSService.getProviderName(db)
    const agentCount = db.prepare(`SELECT COUNT(*) AS c FROM agents`).get().c

    db.transaction(() => {
      TTSService.setProvider(db, toProvider)
      TTSService._makeActive(db, toProvider)
    })()

    return {
      previousProvider: fromProvider,
      newProvider: toProvider,
      agentCount,
      crossMode: false
    }
  }
}

module.exports = TTSService
