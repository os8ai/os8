/**
 * OpenAI TTS Provider
 *
 * Handles voice listing, audio generation, and PCM streaming
 * for OpenAI text-to-speech API.
 */

const PROVIDER_ID = 'openai'
const API_KEY_ENV = 'OPENAI_API_KEY'
const IS_LOCAL = false

const VOICES = [
  { voiceId: 'alloy',   name: 'Alloy',   gender: 'neutral' },
  { voiceId: 'ash',     name: 'Ash',     gender: 'male' },
  { voiceId: 'coral',   name: 'Coral',   gender: 'female' },
  { voiceId: 'echo',    name: 'Echo',    gender: 'male' },
  { voiceId: 'fable',   name: 'Fable',   gender: 'female' },
  { voiceId: 'nova',    name: 'Nova',    gender: 'female' },
  { voiceId: 'onyx',    name: 'Onyx',    gender: 'male' },
  { voiceId: 'sage',    name: 'Sage',    gender: 'female' },
  { voiceId: 'shimmer', name: 'Shimmer', gender: 'female' },
]

const DEFAULT_VOICES = {
  female: { id: 'nova', name: 'Nova' },
  male: { id: 'echo', name: 'Echo' }
}

const DEFAULTS = {
  voiceId: DEFAULT_VOICES.female.id,
  voiceName: DEFAULT_VOICES.female.name,
  defaultVoiceFemale: DEFAULT_VOICES.female.id,
  defaultVoiceFemaleName: DEFAULT_VOICES.female.name,
  defaultVoiceMale: DEFAULT_VOICES.male.id,
  defaultVoiceMaleName: DEFAULT_VOICES.male.name,
  model: 'tts-1',
  speed: 1.0
}

/**
 * Get available voices (static list — no API call needed)
 * @returns {Promise<Array>}
 */
async function getVoices() {
  return VOICES.map(v => ({
    voiceId: v.voiceId,
    name: v.name,
    category: null,
    labels: { gender: v.gender },
    previewUrl: null
  }))
}

/**
 * Generate audio (MP3) via OpenAI REST API
 * @param {string} apiKey
 * @param {string} text
 * @param {string} voiceId
 * @param {object} options - { model, speed }
 * @returns {Promise<Buffer>} MP3 audio buffer
 */
async function generateAudio(apiKey, text, voiceId, options = {}) {
  const model = options.model || DEFAULTS.model
  const speed = options.speed ?? DEFAULTS.speed

  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      input: text,
      voice: voiceId || DEFAULT_VOICES.female.id,
      response_format: 'mp3',
      speed
    })
  })

  if (!response.ok) {
    const errorText = await response.text()
    let errorMessage
    try {
      const errorJson = JSON.parse(errorText)
      errorMessage = errorJson.error?.message || errorText
    } catch {
      errorMessage = errorText
    }
    throw new Error(`OpenAI TTS API error (${response.status}): ${errorMessage}`)
  }

  const audioBuffer = await response.arrayBuffer()
  return Buffer.from(audioBuffer)
}

/**
 * Stream audio as PCM via REST API (used by streaming adapter in Phase 2)
 * @param {string} apiKey
 * @param {string} text
 * @param {string} voiceId
 * @param {object} options - { model, speed }
 * @returns {Promise<ReadableStream>} PCM 24kHz 16-bit signed LE stream
 */
async function streamAudio(apiKey, text, voiceId, options = {}) {
  const model = options.model || DEFAULTS.model
  const speed = options.speed ?? DEFAULTS.speed

  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      input: text,
      voice: voiceId || DEFAULT_VOICES.female.id,
      response_format: 'pcm',
      speed
    })
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`OpenAI TTS stream error (${response.status}): ${errorText}`)
  }

  return response.body
}

/**
 * Get default voices by gender
 * @returns {{ female: {id, name}, male: {id, name} }}
 */
function getDefaultVoices() {
  return DEFAULT_VOICES
}

/**
 * Stream audio and emit base64 chunks via callback.
 * Used by tts-stream.js and call-stream.js for real-time playback.
 * @param {string} apiKey
 * @param {string} text
 * @param {string} voiceId
 * @param {object} options - { model, speed }
 * @param {function} onChunk - (base64Data: string) => void
 * @param {function} onDone - () => void
 * @param {function} onError - (err: Error) => void
 * @returns {function} abort - call to cancel the stream
 */
function streamAudioChunked(apiKey, text, voiceId, options = {}, onChunk, onDone, onError) {
  const controller = new AbortController()

  ;(async () => {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: options.model || DEFAULTS.model,
        input: text,
        voice: voiceId || DEFAULT_VOICES.female.id,
        response_format: 'pcm',
        speed: options.speed ?? DEFAULTS.speed
      }),
      signal: controller.signal
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`OpenAI TTS stream error (${response.status}): ${errorText}`)
    }

    const reader = response.body.getReader()
    let carry = null // Hold trailing odd byte between chunks for 16-bit alignment
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      let chunk = Buffer.from(value)
      if (carry) {
        chunk = Buffer.concat([carry, chunk])
        carry = null
      }
      // 16-bit PCM: each sample is 2 bytes — keep chunks aligned
      if (chunk.length % 2 !== 0) {
        carry = chunk.slice(chunk.length - 1)
        chunk = chunk.slice(0, chunk.length - 1)
      }
      if (chunk.length > 0) {
        onChunk(chunk.toString('base64'))
      }
    }
    // Flush any remaining byte (shouldn't happen with valid PCM, but be safe)
    if (carry && carry.length > 0) {
      const padded = Buffer.concat([carry, Buffer.alloc(1)])
      onChunk(padded.toString('base64'))
    }
    onDone()
  })().catch(err => {
    if (err.name === 'AbortError') return
    // Always send done after error so client doesn't hang
    onError(err)
    onDone()
  })

  return () => controller.abort()
}

/**
 * No WebSocket URL — OpenAI uses HTTP streaming
 * Returns null to signal caller should use streamAudio() instead
 */
function getWebSocketUrl() {
  return null
}

module.exports = {
  PROVIDER_ID,
  API_KEY_ENV,
  IS_LOCAL,
  DEFAULT_VOICES,
  DEFAULTS,
  VOICES,
  getVoices,
  generateAudio,
  streamAudio,
  streamAudioChunked,
  getDefaultVoices,
  getWebSocketUrl
}
