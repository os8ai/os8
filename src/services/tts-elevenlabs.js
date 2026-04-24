/**
 * ElevenLabs TTS Provider
 *
 * Handles voice listing, audio generation, and WebSocket URL building
 * for ElevenLabs text-to-speech API.
 */

const PROVIDER_ID = 'elevenlabs'
const API_KEY_ENV = 'ELEVENLABS_API_KEY'
const IS_LOCAL = false

const DEFAULT_VOICES = {
  female: { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Rachel' },
  male: { id: 'CwhRBWXzGAHq8TQ4Fs17', name: 'Roger' }
}

const DEFAULTS = {
  voiceId: DEFAULT_VOICES.female.id,
  voiceName: DEFAULT_VOICES.female.name,
  defaultVoiceFemale: DEFAULT_VOICES.female.id,
  defaultVoiceFemaleName: DEFAULT_VOICES.female.name,
  defaultVoiceMale: DEFAULT_VOICES.male.id,
  defaultVoiceMaleName: DEFAULT_VOICES.male.name,
  model: 'eleven_turbo_v2_5',
  stability: 0.5,
  similarityBoost: 0.75,
  speed: 1.0
}

/**
 * Get available voices from ElevenLabs API
 * @param {string} apiKey
 * @returns {Promise<Array<{voiceId, name, category, labels, previewUrl}>>}
 */
async function getVoices(apiKey) {
  if (!apiKey) {
    throw new Error('ElevenLabs API key required')
  }

  const response = await fetch('https://api.elevenlabs.io/v1/voices', {
    headers: {
      'xi-api-key': apiKey
    }
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(error.detail?.message || `API error: ${response.status}`)
  }

  const data = await response.json()
  return data.voices.map(voice => ({
    voiceId: voice.voice_id,
    name: voice.name,
    category: voice.category,
    labels: voice.labels,
    previewUrl: voice.preview_url
  }))
}

/**
 * Generate audio (MP3) via ElevenLabs REST API
 * @param {string} apiKey
 * @param {string} text
 * @param {string} voiceId
 * @param {object} options - { model, stability, similarityBoost, speed }
 * @returns {Promise<Buffer>} MP3 audio buffer
 */
async function generateAudio(apiKey, text, voiceId, options = {}) {
  const model = options.model || DEFAULTS.model
  const stability = options.stability ?? DEFAULTS.stability
  const similarityBoost = options.similarityBoost ?? DEFAULTS.similarityBoost
  const speed = options.speed ?? DEFAULTS.speed

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg'
    },
    body: JSON.stringify({
      text,
      model_id: model,
      voice_settings: {
        stability,
        similarity_boost: similarityBoost,
        speed
      }
    })
  })

  if (!response.ok) {
    const errorText = await response.text()
    let errorMessage
    try {
      const errorJson = JSON.parse(errorText)
      errorMessage = errorJson.detail?.message || errorJson.detail || errorJson.error || errorText
    } catch {
      errorMessage = errorText
    }
    throw new Error(`ElevenLabs API error (${response.status}): ${errorMessage}`)
  }

  const audioBuffer = await response.arrayBuffer()
  return Buffer.from(audioBuffer)
}

/**
 * Build WebSocket URL for streaming TTS
 * @param {object} options - { voiceId, model }
 * @returns {string} wss:// URL
 */
function getWebSocketUrl(options = {}) {
  const voiceId = options.voiceId || DEFAULTS.voiceId
  const model = options.model || DEFAULTS.model
  const outputFormat = 'pcm_24000'

  return `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=${model}&output_format=${outputFormat}`
}

/**
 * Get default voices by gender
 * @returns {{ female: {id, name}, male: {id, name} }}
 */
function getDefaultVoices() {
  return DEFAULT_VOICES
}

module.exports = {
  PROVIDER_ID,
  API_KEY_ENV,
  IS_LOCAL,
  DEFAULT_VOICES,
  DEFAULTS,
  getVoices,
  generateAudio,
  getWebSocketUrl,
  getDefaultVoices
}
