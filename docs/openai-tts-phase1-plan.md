# Phase 1: Provider Abstraction — Detailed Sub-Plan

**Prerequisite:** Phase 0 complete (dead code removed, committed).

**Goal:** Extract ElevenLabs-specific logic into a provider module, create an OpenAI provider module, and refactor TTSService into a facade that delegates to the active provider. After this phase, all TTS callers go through TTSService which routes to the correct provider — but streaming (Phase 2) still only works for ElevenLabs.

---

## Step 1: Create `src/services/tts-elevenlabs.js`

Extract from current `tts.js` and `speak.js`. Pure functions, no db access — receives apiKey as parameter.

```javascript
// src/services/tts-elevenlabs.js

const PROVIDER_ID = 'elevenlabs'
const API_KEY_ENV = 'ELEVENLABS_API_KEY'

const DEFAULT_VOICES = {
  female: { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Rachel' },
  male: { id: 'CwhRBWXzGAHq8TQ4Fs17', name: 'Roger' }
}

const DEFAULTS = {
  model: 'eleven_turbo_v2_5',
  stability: 0.5,
  similarityBoost: 0.75,
  speed: 1.0
}

module.exports = {
  PROVIDER_ID,
  API_KEY_ENV,
  DEFAULT_VOICES,
  DEFAULTS,

  /**
   * Get available voices from ElevenLabs API
   * @param {string} apiKey
   * @returns {Promise<Array<{voiceId, name, category, labels, previewUrl}>>}
   */
  async getVoices(apiKey) { /* extract from TTSService.getVoices */ },

  /**
   * Generate audio file (MP3) via REST API
   * @param {string} apiKey
   * @param {string} text
   * @param {string} voiceId
   * @param {object} options - { model, stability, similarityBoost, speed }
   * @returns {Promise<Buffer>} MP3 audio buffer
   */
  async generateAudio(apiKey, text, voiceId, options = {}) { /* extract from SpeakService.generateAudio */ },

  /**
   * Build WebSocket URL for streaming TTS
   * @param {object} options - { voiceId, model }
   * @returns {string} wss:// URL
   */
  getWebSocketUrl(options = {}) { /* extract from TTSService.getWebSocketUrl */ },

  /**
   * Get default voices by gender
   * @returns {{ female: {id, name}, male: {id, name} }}
   */
  getDefaultVoices() { return DEFAULT_VOICES }
}
```

**Source of each function:**
- `getVoices` → move from `tts.js:161-185` (TTSService.getVoices)
- `generateAudio` → extract the fetch logic from `speak.js:87-122` (the ElevenLabs REST call). Returns raw Buffer, not file path. SpeakService keeps file-saving responsibility.
- `getWebSocketUrl` → move from `tts.js:192-198` (TTSService.getWebSocketUrl)
- `getDefaultVoices` → new, returns the hardcoded Rachel/Roger IDs currently in TTS_DEFAULTS

---

## Step 2: Create `src/services/tts-openai.js`

New provider module. Same interface as tts-elevenlabs.js.

```javascript
// src/services/tts-openai.js

const PROVIDER_ID = 'openai'
const API_KEY_ENV = 'OPENAI_API_KEY'

// OpenAI built-in voices (static — no API call needed)
const VOICES = [
  { voiceId: 'alloy',   name: 'Alloy',   gender: 'neutral' },
  { voiceId: 'ash',     name: 'Ash',      gender: 'male' },
  { voiceId: 'coral',   name: 'Coral',    gender: 'female' },
  { voiceId: 'echo',    name: 'Echo',     gender: 'male' },
  { voiceId: 'fable',   name: 'Fable',    gender: 'female' },
  { voiceId: 'nova',    name: 'Nova',     gender: 'female' },
  { voiceId: 'onyx',    name: 'Onyx',     gender: 'male' },
  { voiceId: 'sage',    name: 'Sage',     gender: 'female' },
  { voiceId: 'shimmer', name: 'Shimmer',  gender: 'female' },
]

const DEFAULT_VOICES = {
  female: { id: 'nova', name: 'Nova' },
  male: { id: 'echo', name: 'Echo' }
}

const DEFAULTS = {
  model: 'tts-1',  // tts-1 (fast) or tts-1-hd (quality)
  speed: 1.0       // 0.25 to 4.0
}

module.exports = {
  PROVIDER_ID,
  API_KEY_ENV,
  DEFAULT_VOICES,
  DEFAULTS,
  VOICES,

  /**
   * Get available voices (static list, no API call)
   * @returns {Promise<Array>} - matches ElevenLabs format for consistency
   */
  async getVoices() {
    return VOICES.map(v => ({
      voiceId: v.voiceId,
      name: v.name,
      category: v.gender,
      labels: { gender: v.gender },
      previewUrl: null  // Phase 6 adds cached previews
    }))
  },

  /**
   * Generate audio file (MP3) via REST API
   * @param {string} apiKey
   * @param {string} text
   * @param {string} voiceId
   * @param {object} options - { model, speed }
   * @returns {Promise<Buffer>} MP3 audio buffer
   */
  async generateAudio(apiKey, text, voiceId, options = {}) {
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
  },

  /**
   * Stream audio as PCM via REST API (used by Phase 2 streaming)
   * @param {string} apiKey
   * @param {string} text
   * @param {string} voiceId
   * @param {object} options - { model, speed }
   * @returns {Promise<ReadableStream>} PCM 24kHz 16-bit stream
   */
  async streamAudio(apiKey, text, voiceId, options = {}) {
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
        response_format: 'pcm',  // raw PCM 24kHz 16-bit signed LE
        speed
      })
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`OpenAI TTS stream error (${response.status}): ${errorText}`)
    }

    return response.body  // ReadableStream of PCM chunks
  },

  getDefaultVoices() { return DEFAULT_VOICES },

  /**
   * No WebSocket URL — OpenAI uses HTTP streaming (Phase 2)
   * Returns null to signal that caller should use streamAudio() instead
   */
  getWebSocketUrl() { return null }
}
```

**Key difference from ElevenLabs:** OpenAI has no WebSocket API. `getWebSocketUrl()` returns null. The streaming adapter (Phase 2) will use `streamAudio()` instead. For Phase 1, only `generateAudio()` is exercised (via SpeakService).

---

## Step 3: Refactor `src/services/tts.js` to Facade

Keep TextChunker and settings get/set. Add provider routing.

### Changes:

**Remove from tts.js:**
- `getVoices(apiKey)` → moved to tts-elevenlabs.js
- `getWebSocketUrl(options)` → moved to tts-elevenlabs.js
- ElevenLabs-specific defaults from TTS_DEFAULTS (voiceId, voiceName, defaultVoice* fields, model, stability, similarityBoost)

**Keep in tts.js:**
- `TextChunker` class (unchanged)
- `getSettings(db)` / `setSettings(db, settings)` (unchanged)
- `TTS_DEFAULTS` — but make provider-agnostic:
  ```javascript
  const TTS_DEFAULTS = {
    enabled: false,
    autoSpeak: true,
    interruptOnInput: true,
    // Provider-specific defaults populated dynamically
    voiceId: null,
    voiceName: null,
    model: null,
    speed: 1.0
  }
  ```

**Add to tts.js:**

```javascript
const ElevenLabsProvider = require('./tts-elevenlabs')
const OpenAIProvider = require('./tts-openai')

const PROVIDERS = {
  elevenlabs: ElevenLabsProvider,
  openai: OpenAIProvider
}

class TTSService {
  // ... existing TextChunker, getSettings, setSettings ...

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
   * Check if TTS is available (provider set + API key present)
   * @param {Database} db
   * @returns {{ available: boolean, provider: string|null, reason?: string }}
   */
  static isAvailable(db) {
    const EnvService = require('./env')
    const provider = TTSService.getProvider(db)
    if (!provider) {
      return { available: false, provider: null, reason: 'no_provider' }
    }
    const apiKeyRecord = EnvService.get(db, provider.API_KEY_ENV)
    if (!apiKeyRecord || !apiKeyRecord.value) {
      return { available: false, provider: provider.PROVIDER_ID, reason: 'no_api_key' }
    }
    return { available: true, provider: provider.PROVIDER_ID }
  }

  /**
   * Get API key for active provider
   * @param {Database} db
   * @returns {string|null}
   */
  static getApiKey(db) {
    const EnvService = require('./env')
    const provider = TTSService.getProvider(db)
    if (!provider) return null
    const record = EnvService.get(db, provider.API_KEY_ENV)
    return record?.value || null
  }

  /**
   * Get voices from active provider (delegates to provider module)
   * @param {Database} db
   * @returns {Promise<Array>}
   */
  static async getVoices(db) {
    const provider = TTSService.getProvider(db)
    if (!provider) throw new Error('No TTS provider configured')
    const apiKey = TTSService.getApiKey(db)
    if (!apiKey) throw new Error(`${provider.PROVIDER_ID} API key not configured`)
    return provider.getVoices(apiKey)
  }

  /**
   * Get WebSocket URL (ElevenLabs) or null (OpenAI)
   * @param {Database} db
   * @param {object} options
   * @returns {string|null}
   */
  static getWebSocketUrl(db, options = {}) {
    const provider = TTSService.getProvider(db)
    return provider?.getWebSocketUrl(options) || null
  }

  /**
   * Get provider-specific default voices
   * @param {string} providerName - 'elevenlabs' or 'openai'
   * @returns {{ female: {id, name}, male: {id, name} }}
   */
  static getProviderDefaults(providerName) {
    const provider = PROVIDERS[providerName]
    return provider ? provider.getDefaultVoices() : null
  }
}
```

### Signature change: `getWebSocketUrl`

**Before:** `TTSService.getWebSocketUrl({ voiceId, model })` — no db, uses hardcoded ElevenLabs URL.

**After:** `TTSService.getWebSocketUrl(db, { voiceId, model })` — needs db to resolve provider.

**Callers that must update:**
1. `src/routes/tts-stream.js:116` — already has db in scope
2. `src/routes/call-stream.js:367` — already has db in scope

For backward compatibility during Phase 1, `getWebSocketUrl` still only works for ElevenLabs (returns null for OpenAI). Phase 2 handles the OpenAI streaming path.

### Signature change: `getVoices`

**Before:** `TTSService.getVoices(apiKey)` — takes raw API key.

**After:** `TTSService.getVoices(db)` — resolves provider + key internally.

**Callers that must update:**
1. `src/routes/voice.js:170` — currently does `TTSService.getVoices(apiKeyRecord.value)`, change to `TTSService.getVoices(db)`
2. `src/routes/agents.js:148` — currently does `TTSService.getVoices(apiKey)`, change to `TTSService.getVoices(db)`
3. `src/ipc/tts.js:36` — currently does `TTSService.getVoices(apiKeyRecord.value)`, change to `TTSService.getVoices(db)`

---

## Step 4: Update `src/services/speak.js`

Replace direct ElevenLabs API calls with provider delegation.

### Changes:

**`getStatus(db)`** — currently checks `ELEVENLABS_API_KEY`. Change to:
```javascript
static getStatus(db) {
  const status = TTSService.isAvailable(db)
  return {
    ready: status.available,
    provider: status.provider,
    reason: status.reason
  }
}
```

**`generateAudio(db, text, options)`** — currently calls ElevenLabs REST directly. Change to:
```javascript
// Replace lines 72-122 with:
const provider = TTSService.getProvider(db)
if (!provider) throw new Error('No TTS provider configured. Set one in Settings.')

const apiKey = TTSService.getApiKey(db)
if (!apiKey) throw new Error(`${provider.PROVIDER_ID} API key not configured. Add it in Settings > API Keys.`)

const ttsSettings = TTSService.getSettings(db)
const voiceId = options.voiceId || ttsSettings.voiceId
const audioData = await provider.generateAudio(apiKey, text, voiceId, {
  model: options.model || ttsSettings.model,
  stability: options.stability ?? ttsSettings.stability,        // ElevenLabs only
  similarityBoost: options.similarityBoost ?? ttsSettings.similarityBoost, // ElevenLabs only
  speed: options.speed ?? ttsSettings.speed
})
```

The rest of SpeakService (file saving, listing, cleanup) stays unchanged — it just receives a Buffer from the provider instead of fetching directly.

---

## Step 5: Update callers

### `src/routes/tts-stream.js`

**Line 54:** API key check on upgrade — change from:
```javascript
const apiKeyRecord = EnvService.get(db, 'ELEVENLABS_API_KEY')
```
to:
```javascript
const status = TTSService.isAvailable(db)
if (!status.available) {
  // reject with reason
}
```
Also pass the resolved provider info into `handleConnection`.

**Line 116:** `getWebSocketUrl` — add db parameter:
```javascript
const wsUrl = TTSService.getWebSocketUrl(db, { voiceId, model })
```

### `src/routes/call-stream.js`

**Line 359:** API key check — change from `ELEVENLABS_API_KEY` to provider-aware:
```javascript
const provider = TTSService.getProvider(db)
const apiKey = TTSService.getApiKey(db)
```

**Line 367:** `getWebSocketUrl` — add db parameter:
```javascript
const wsUrl = TTSService.getWebSocketUrl(db, { voiceId: settings.voiceId, model: settings.model })
```

**Note:** In Phase 1, call-stream.js still only works with ElevenLabs (WebSocket path). If provider is OpenAI and getWebSocketUrl returns null, log a warning and skip TTS for the call. Phase 2 adds the OpenAI streaming path.

### `src/routes/voice.js`

**Line 165-176 (tts-voices):** Change from manual API key lookup to:
```javascript
router.get('/tts-voices', async (req, res) => {
  try {
    const voices = await TTSService.getVoices(db)
    res.json({ voices })
  } catch (err) {
    res.status(503).json({ error: err.message })
  }
})
```

**Line 182-192 (tts-status):** Change from `ELEVENLABS_API_KEY` check to:
```javascript
router.get('/tts-status', (req, res) => {
  try {
    const status = TTSService.isAvailable(db)
    res.json({
      available: status.available,
      provider: status.provider,
      reason: status.reason,
      settings: TTSService.getSettings(db)
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
```

### `src/routes/agents.js`

**Lines 131-153 (voices/status and voices):** Change from `ELEVENLABS_API_KEY` to:
```javascript
router.get('/voices/status', (req, res) => {
  const status = TTSService.isAvailable(db)
  res.json({ ready: status.available, provider: status.provider })
})

router.get('/voices', async (req, res) => {
  try {
    const status = TTSService.isAvailable(db)
    if (!status.available) {
      return res.json({ ready: false, voices: [], provider: status.provider })
    }
    const voices = await TTSService.getVoices(db)
    res.json({ ready: true, voices, provider: status.provider })
  } catch (err) {
    res.json({ ready: false, voices: [], error: err.message })
  }
})
```

### `src/ipc/tts.js`

**Line 29-42 (tts:getVoices):** Change from manual API key lookup to:
```javascript
ipcMain.handle('tts:getVoices', async () => {
  try {
    const voices = await TTSService.getVoices(db)
    return { voices }
  } catch (err) {
    return { error: err.message }
  }
})
```

**Line 47-50 (tts:isAvailable):** Change from `ELEVENLABS_API_KEY` check to:
```javascript
ipcMain.handle('tts:isAvailable', () => {
  return TTSService.isAvailable(db)
})
```

### `src/routes/speak.js`

**Line ~150 (meta):** `envRequired: 'ELEVENLABS_API_KEY'` — remove this. The speak route now works with either provider. SpeakService.getStatus() handles availability internally.

### `src/routes/voicemessage.js`

**Line ~201 (meta):** Same — remove `envRequired: 'ELEVENLABS_API_KEY'`. The route delegates to SpeakService which checks the active provider.

---

## Step 6: Seed `tts_provider` setting

**`src/db/seeds.js`:** Add after the routing preference seeds:
```javascript
// Seed TTS provider (null = not configured yet)
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('tts_provider', '')").run();
```

**Auto-detection for existing users:** For users who already have `ELEVENLABS_API_KEY` set, we should auto-set `tts_provider` to `'elevenlabs'` so they don't lose voice on upgrade. Add to seeds.js:
```javascript
// Auto-detect provider for existing users with ElevenLabs key
try {
  const providerSetting = db.prepare("SELECT value FROM settings WHERE key = 'tts_provider'").get();
  if (!providerSetting || !providerSetting.value) {
    const elKey = db.prepare("SELECT value FROM env_variables WHERE key = 'ELEVENLABS_API_KEY'").get();
    if (elKey && elKey.value) {
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('tts_provider', 'elevenlabs')").run();
    }
  }
} catch (e) {
  console.warn('[DB] TTS provider auto-detect:', e.message);
}
```

---

## Step 7: Update `src/services/index.js`

Provider modules stay internal to TTSService (not exported from index.js). No changes needed — TTSService is already exported and it `require`s the provider modules internally.

---

## Verification

After Phase 1, run:
1. `npm test` — all 169 tests pass
2. Manual: Start OS8 with existing ElevenLabs key → voice still works (auto-detected provider)
3. Manual: Remove ElevenLabs key → `tts-status` returns `{ available: false, reason: 'no_api_key' }`
4. Manual: Speak route (`/api/speak`) generates audio via provider abstraction

---

## Files Changed Summary

| Action | File | Description |
|--------|------|-------------|
| **Create** | `src/services/tts-elevenlabs.js` | ElevenLabs provider module |
| **Create** | `src/services/tts-openai.js` | OpenAI provider module |
| **Heavy modify** | `src/services/tts.js` | Facade with provider routing |
| **Medium modify** | `src/services/speak.js` | Delegate to active provider |
| **Light modify** | `src/routes/tts-stream.js` | Provider-aware API key check, getWebSocketUrl(db, ...) |
| **Light modify** | `src/routes/call-stream.js` | Provider-aware API key check, getWebSocketUrl(db, ...) |
| **Light modify** | `src/routes/voice.js` | Use TTSService.getVoices(db), isAvailable(db) |
| **Light modify** | `src/routes/agents.js` | Use TTSService.isAvailable(db), getVoices(db) |
| **Light modify** | `src/routes/speak.js` | Remove envRequired |
| **Light modify** | `src/routes/voicemessage.js` | Remove envRequired |
| **Light modify** | `src/ipc/tts.js` | Use TTSService.getVoices(db), isAvailable(db) |
| **Light modify** | `src/db/seeds.js` | Seed tts_provider, auto-detect existing ElevenLabs |

---

## What Phase 1 Does NOT Do

- **No streaming for OpenAI** — tts-stream.js and call-stream.js still only stream via ElevenLabs WebSocket. Phase 2 adds OpenAI HTTP streaming.
- **No UI changes** — No provider picker UI, no setup screen changes. Phase 4.
- **No voice remapping** — remapVoices/applyVoiceRemap deferred to Phase 5.
- **No schema changes** — No voice_provider column on agents. Phase 3.
- **No previews** — OpenAI voice previews deferred to Phase 6.
