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
   * Update TTS settings in database
   * @param {Database} db - SQLite database
   * @param {object} settings - Settings to merge
   * @returns {object} Updated settings
   */
  static setSettings(db, settings) {
    const SettingsService = require('./settings')
    const current = TTSService.getSettings(db)
    const merged = { ...current, ...settings }
    SettingsService.set(db, 'tts', JSON.stringify(merged))
    return merged
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
   * Get active provider name from settings
   * @param {Database} db
   * @returns {'elevenlabs'|'openai'|null}
   */
  static getProviderName(db) {
    const SettingsService = require('./settings')
    const provider = SettingsService.get(db, 'tts_provider')
    if (provider && PROVIDERS[provider]) return provider
    return null
  }

  /**
   * Set TTS provider
   * @param {Database} db
   * @param {string|null} provider - 'elevenlabs', 'openai', or null
   */
  static setProvider(db, provider) {
    const SettingsService = require('./settings')
    SettingsService.set(db, 'tts_provider', provider || '')
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
    // Reachability is checked synchronously-best-effort: we can't await here
    // (this method is sync), so we report "available" optimistically and let
    // the actual TTS call surface "launcher down" if Kokoro isn't serving.
    // The Settings UI can call LauncherClient.isReachable() separately for
    // a more honest preflight indicator.
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
   * Switch global TTS provider, saving/restoring per-agent voices
   * @param {Database} db
   * @param {string} toProvider - 'elevenlabs', 'openai', or '' (none)
   * @returns {{ previousProvider, newProvider, agentCount }}
   */
  static switchProvider(db, toProvider) {
    const AgentService = require('./agent')
    const fromProvider = TTSService.getProviderName(db)
    const agents = db.prepare(`SELECT id, voice_id, voice_name, gender FROM agents`).all()

    const transaction = db.transaction(() => {
      for (const agent of agents) {
        // Save current voice for outgoing provider
        if (fromProvider && agent.voice_id) {
          TTSService.saveAgentVoice(db, agent.id, fromProvider, agent.voice_id, agent.voice_name)
        }

        // Restore saved voice for incoming provider, or use gender default
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

      TTSService.setProvider(db, toProvider)

      // Update shared TTS settings with new provider's defaults (model, voices)
      if (toProvider && PROVIDERS[toProvider]) {
        const providerDefaults = PROVIDERS[toProvider].DEFAULTS || {}
        const settingsUpdate = {}
        if (providerDefaults.model) settingsUpdate.model = providerDefaults.model
        if (providerDefaults.voiceId) settingsUpdate.voiceId = providerDefaults.voiceId
        if (providerDefaults.voiceName) settingsUpdate.voiceName = providerDefaults.voiceName
        if (providerDefaults.defaultVoiceFemale) settingsUpdate.defaultVoiceFemale = providerDefaults.defaultVoiceFemale
        if (providerDefaults.defaultVoiceFemaleName) settingsUpdate.defaultVoiceFemaleName = providerDefaults.defaultVoiceFemaleName
        if (providerDefaults.defaultVoiceMale) settingsUpdate.defaultVoiceMale = providerDefaults.defaultVoiceMale
        if (providerDefaults.defaultVoiceMaleName) settingsUpdate.defaultVoiceMaleName = providerDefaults.defaultVoiceMaleName
        if (Object.keys(settingsUpdate).length > 0) {
          TTSService.setSettings(db, settingsUpdate)
        }
      }
    })

    transaction()

    return {
      previousProvider: fromProvider,
      newProvider: toProvider,
      agentCount: agents.length
    }
  }
}

module.exports = TTSService
