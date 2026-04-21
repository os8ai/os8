/**
 * Kokoro TTS Provider (Phase 3 §4.4)
 *
 * Local TTS via os8-launcher. Kokoro-FastAPI exposes an OpenAI-compatible
 * /v1/audio/speech endpoint on port 8880 (per the launcher's serving manifest).
 * Models auto-download on first request — no launcher-side weight management.
 *
 * Provider-shape mirrors tts-openai.js exactly so TTSService.PROVIDERS sees
 * a uniform interface. API_KEY_ENV is null because there's no auth — the
 * facade's isAvailable check has a null-key branch that probes launcher
 * reachability instead.
 *
 * The 54 prebuilt voices are documented at
 * https://huggingface.co/hexgrad/Kokoro-82M. We hard-code a representative
 * subset by gender as defaults; the full voice list is fetched live from
 * GET /v1/audio/voices on the running backend.
 */

const LauncherClient = require('./launcher-client');

const PROVIDER_ID = 'kokoro';
const API_KEY_ENV = null;     // local — no auth

// Default voices by gender. Picked from Kokoro's prebuilt set:
//   af_bella — American Female, warm, neutral pace
//   am_adam  — American Male, conversational
const DEFAULT_VOICES = {
  female: { id: 'af_bella', name: 'Bella' },
  male:   { id: 'am_adam',  name: 'Adam' }
};

const DEFAULTS = {
  voiceId: DEFAULT_VOICES.female.id,
  voiceName: DEFAULT_VOICES.female.name,
  defaultVoiceFemale: DEFAULT_VOICES.female.id,
  defaultVoiceFemaleName: DEFAULT_VOICES.female.name,
  defaultVoiceMale: DEFAULT_VOICES.male.id,
  defaultVoiceMaleName: DEFAULT_VOICES.male.name,
  model: 'kokoro',
  speed: 1.0,
  format: 'mp3'
};

/**
 * Resolve the Kokoro data-plane base URL from the launcher's capabilities map.
 * Falls back to the well-known default port (8880) when the launcher hasn't
 * surfaced a tts capability yet — this lets a freshly-started Kokoro respond
 * before the launcher state catches up.
 *
 * Returns null when the launcher is unreachable AND no fallback is desired
 * (caller can decide whether to throw or surface "launcher down" UX).
 */
async function resolveBaseUrl() {
  try {
    const caps = await LauncherClient.getCapabilities();
    // Launcher uses 'tts' as the task name (vs OS8's image-gen/etc mapping).
    const entry = (Array.isArray(caps?.tts) ? caps.tts[0] : caps?.tts) || null;
    if (entry?.base_url) return entry.base_url;
  } catch (_e) {
    // Launcher unreachable — fall through to default port. The actual call
    // will fail with a clear error if Kokoro isn't serving.
  }
  return 'http://localhost:8880';
}

/**
 * Build the full list of available voices. Calls Kokoro's GET /v1/audio/voices
 * and normalizes to the shape TTSService expects:
 *   { voiceId, name, category, labels, previewUrl }
 *
 * The launcher's manifest health-checks /v1/audio/voices, so the endpoint is
 * always live whenever Kokoro is up.
 *
 * @param {string} _apiKey - ignored (Kokoro has no auth); kept for facade parity
 * @returns {Promise<Array>}
 */
async function getVoices(_apiKey) {
  const baseUrl = await resolveBaseUrl();
  const res = await fetch(`${baseUrl}/v1/audio/voices`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Kokoro /v1/audio/voices returned ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  // Kokoro-FastAPI returns { voices: [<voice_id>, ...] } — flat string list,
  // unlike ElevenLabs which returns rich voice metadata. Normalize.
  const list = Array.isArray(data?.voices) ? data.voices : (Array.isArray(data) ? data : []);
  return list.map(voiceId => ({
    voiceId,
    name: humanizeVoiceId(voiceId),
    category: kokoroCategoryOf(voiceId),
    labels: kokoroLabelsOf(voiceId),
    previewUrl: null
  }));
}

/**
 * Generate audio from text. Returns a Buffer of the audio in the requested
 * format (default mp3). Used for one-shot TTS via /api/speak.
 *
 * @param {string} _apiKey - ignored
 * @param {string} text
 * @param {string} voiceId
 * @param {object} options - { model, speed, format }
 * @returns {Promise<Buffer>}
 */
async function generateAudio(_apiKey, text, voiceId, options = {}) {
  const baseUrl = await resolveBaseUrl();
  const body = {
    model: options.model || DEFAULTS.model,
    input: text,
    voice: voiceId || DEFAULTS.voiceId,
    speed: options.speed ?? DEFAULTS.speed,
    response_format: options.format || DEFAULTS.format
  };

  const res = await fetch(`${baseUrl}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message;
    try {
      const parsed = JSON.parse(text);
      message = parsed.error?.message || parsed.detail || text;
    } catch {
      message = text;
    }
    throw new Error(`Kokoro TTS error (${res.status}): ${message.slice(0, 300)}`);
  }

  const buf = await res.arrayBuffer();
  return Buffer.from(buf);
}

/**
 * Streaming variant — Kokoro returns the full audio in a single streaming
 * response (no chunked TTS protocol). We buffer it and emit at the end.
 * Matches tts-openai's streamAudio interface so the facade routes work.
 *
 * @param {string} _apiKey
 * @param {string} text
 * @param {string} voiceId
 * @param {object} options
 * @returns {Promise<ReadableStream>}
 */
async function streamAudio(_apiKey, text, voiceId, options = {}) {
  const baseUrl = await resolveBaseUrl();
  const body = {
    model: options.model || DEFAULTS.model,
    input: text,
    voice: voiceId || DEFAULTS.voiceId,
    speed: options.speed ?? DEFAULTS.speed,
    response_format: 'pcm'
  };

  const res = await fetch(`${baseUrl}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Kokoro TTS stream error (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.body;
}

/**
 * Chunked streaming with a callback per audio chunk. Matches the
 * streamAudioChunked signature in tts-openai.js so call-stream / tts-stream
 * routes can use Kokoro identically. Kokoro emits PCM 16-bit; we keep the
 * same alignment-aware chunking logic.
 */
function streamAudioChunked(apiKey, text, voiceId, options = {}, onChunk, onDone, onError) {
  const controller = new AbortController();

  ;(async () => {
    const baseUrl = await resolveBaseUrl();
    const res = await fetch(`${baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options.model || DEFAULTS.model,
        input: text,
        voice: voiceId || DEFAULTS.voiceId,
        speed: options.speed ?? DEFAULTS.speed,
        response_format: 'pcm'
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Kokoro TTS stream error (${res.status}): ${text.slice(0, 200)}`);
    }

    const reader = res.body.getReader();
    let carry = null;  // align 16-bit PCM samples across chunks
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      let chunk = Buffer.from(value);
      if (carry) {
        chunk = Buffer.concat([carry, chunk]);
        carry = null;
      }
      if (chunk.length % 2 !== 0) {
        carry = chunk.slice(chunk.length - 1);
        chunk = chunk.slice(0, chunk.length - 1);
      }
      if (chunk.length > 0) onChunk(chunk.toString('base64'));
    }
    if (carry && carry.length > 0) {
      const padded = Buffer.concat([carry, Buffer.alloc(1)]);
      onChunk(padded.toString('base64'));
    }
    onDone();
  })().catch(err => {
    if (err.name === 'AbortError') return;
    onError(err);
    onDone();
  });

  return () => controller.abort();
}

/** Standard helper — return the gendered defaults for the agent voice picker. */
function getDefaultVoices() {
  return DEFAULT_VOICES;
}

/**
 * No WebSocket TTS — Kokoro-FastAPI uses HTTP streaming. Returning null
 * tells TTSService.getWebSocketUrl that callers should use streamAudio /
 * streamAudioChunked instead.
 */
function getWebSocketUrl() {
  return null;
}

// --- voice-id helpers ---

// Kokoro voice ids encode language + gender:
//   af_*  American Female,  am_*  American Male
//   bf_*  British Female,   bm_*  British Male
//   jf_*  Japanese Female,  etc.
// We extract these for friendlier labels in the picker.
function humanizeVoiceId(voiceId) {
  if (!voiceId) return '';
  const parts = voiceId.split('_');
  if (parts.length < 2) return voiceId;
  const stem = parts.slice(1).join('_');
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}

function kokoroCategoryOf(voiceId) {
  const lang = voiceId?.[0];
  switch (lang) {
    case 'a': return 'American';
    case 'b': return 'British';
    case 'j': return 'Japanese';
    case 'z': return 'Mandarin';
    case 'e': return 'Spanish';
    case 'f': return 'French';
    case 'h': return 'Hindi';
    case 'i': return 'Italian';
    case 'p': return 'Portuguese';
    default:  return 'Other';
  }
}

function kokoroLabelsOf(voiceId) {
  const sex = voiceId?.[1];
  return { gender: sex === 'f' ? 'female' : sex === 'm' ? 'male' : 'unknown' };
}

module.exports = {
  PROVIDER_ID,
  API_KEY_ENV,
  DEFAULT_VOICES,
  DEFAULTS,
  getVoices,
  generateAudio,
  streamAudio,
  streamAudioChunked,
  getDefaultVoices,
  getWebSocketUrl,
  // exported for tests
  humanizeVoiceId,
  kokoroCategoryOf,
  kokoroLabelsOf,
  resolveBaseUrl
};
