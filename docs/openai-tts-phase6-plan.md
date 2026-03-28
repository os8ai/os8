# OpenAI TTS Phase 6: Voice Previews for OpenAI

## Context

ElevenLabs voices come with `preview_url` from their API. OpenAI voices are a static list with no previews — `tts-openai.js` returns `previewUrl: null` for all 9 voices. The UI already handles this gracefully (play buttons are hidden when `previewUrl` is null), but users can't audition OpenAI voices before selecting one.

**Current state:**
- `tts-openai.js` `getVoices()` returns `previewUrl: null` for all voices (line 49)
- SetupScreen hides play button when `voice.previewUrl` is falsy (line 1202)
- SettingsPanel hides play button when `previewUrl` is falsy (line 415) and `playPreview()` returns early if `!voice?.previewUrl` (line 724)
- No `~/os8/blob/voice-previews/` directory exists

**Goal:** Generate short audio previews for OpenAI voices on demand, cache them as MP3 files, and serve them via a route so the existing preview UI works without modification.

---

## Design: Lazy Generation

Generate previews lazily on first request rather than eagerly on provider switch. This avoids 9 API calls upfront and works even if the user never listens to previews.

**Flow:**
1. `getVoices()` returns `previewUrl: '/api/voice/tts-preview/openai/{voiceId}'` for all OpenAI voices (instead of `null`)
2. When the UI plays the preview, it hits `GET /api/voice/tts-preview/openai/{voiceId}`
3. The route checks the cache directory for `openai-{voiceId}.mp3`
4. If cached → serve the file
5. If not cached → generate via OpenAI TTS API, cache, then serve

**Preview text:** `"Hi there! I'm {VoiceName}, nice to meet you."` — short, natural, lets the user hear the voice character.

---

## Step 1: Add preview cache directory constant

**File: `src/services/tts-openai.js`**

Add near the top:

```js
const path = require('path')
const fs = require('fs')
const { BLOB_DIR } = require('../config')

const PREVIEW_DIR = path.join(BLOB_DIR, 'voice-previews')
```

Add a `generatePreview(apiKey, voiceId)` function:

```js
async function generatePreview(apiKey, voiceId) {
  const voice = VOICES.find(v => v.voiceId === voiceId)
  if (!voice) throw new Error(`Unknown voice: ${voiceId}`)

  const filePath = path.join(PREVIEW_DIR, `openai-${voiceId}.mp3`)

  // Return cached if exists
  if (fs.existsSync(filePath)) return filePath

  // Generate
  fs.mkdirSync(PREVIEW_DIR, { recursive: true })
  const text = `Hi there! I'm ${voice.name}, nice to meet you.`
  const buffer = await generateAudio(apiKey, text, voiceId, {})
  fs.writeFileSync(filePath, buffer)
  return filePath
}
```

Add `getPreviewPath(voiceId)` — sync check for cache existence:

```js
function getPreviewPath(voiceId) {
  const filePath = path.join(PREVIEW_DIR, `openai-${voiceId}.mp3`)
  return fs.existsSync(filePath) ? filePath : null
}
```

Export both new functions. Also export `PREVIEW_DIR` for the route.

---

## Step 2: Update `getVoices()` to return preview URLs

**File: `src/services/tts-openai.js`**

Change `previewUrl: null` to a route-based URL. Since `getVoices()` doesn't know the server port/base URL, use a relative path that the caller can resolve.

```js
async function getVoices() {
  return VOICES.map(v => ({
    voiceId: v.voiceId,
    name: v.name,
    category: v.gender,
    labels: { gender: v.gender },
    previewUrl: `/api/voice/tts-preview/openai/${v.voiceId}`
  }))
}
```

The UI in SetupScreen and SettingsPanel creates `new Audio(voice.previewUrl)`. Since the assistant app is served from the same Express server, a relative URL like `/api/voice/tts-preview/openai/nova` resolves correctly against `baseApiUrl`.

**Important:** The UI constructs Audio URLs differently in SetupScreen vs SettingsPanel:
- SetupScreen: `new Audio(voice.previewUrl)` — voice.previewUrl is used directly
- SettingsPanel: `new Audio(voice.previewUrl)` and `new Audio(previewUrl)` — same

Both use the previewUrl as-is. For ElevenLabs, these are full `https://` URLs. For OpenAI, we need to ensure the relative URL resolves correctly. The assistant app is served at `http://localhost:{port}/{appId}/`, so a relative `/api/...` path will resolve against the origin correctly.

**However:** Need to verify this. ElevenLabs returns absolute URLs (`https://storage.googleapis.com/...`). If the app constructs `new Audio('/api/voice/...')`, the browser resolves it against the page origin (`http://localhost:8888`), which is the Express server. This should work.

---

## Step 3: Add preview serving route

**File: `src/routes/voice.js`**

Add a new route that serves cached previews or generates on-the-fly:

```js
// GET /api/voice/tts-preview/:provider/:voiceId — Serve voice preview audio
router.get('/tts-preview/:provider/:voiceId', async (req, res) => {
  const { provider, voiceId } = req.params

  if (provider !== 'openai') {
    return res.status(400).json({ error: 'Preview generation only supported for OpenAI' })
  }

  try {
    const OpenAIProvider = require('../services/tts-openai')

    // Check cache first
    let filePath = OpenAIProvider.getPreviewPath(voiceId)

    if (!filePath) {
      // Generate on-the-fly
      const apiKey = TTSService.getApiKey(db)
      if (!apiKey) {
        return res.status(503).json({ error: 'OpenAI API key not configured' })
      }
      filePath = await OpenAIProvider.generatePreview(apiKey, voiceId)
    }

    res.set('Content-Type', 'audio/mpeg')
    res.set('Cache-Control', 'public, max-age=86400')
    res.sendFile(filePath)
  } catch (err) {
    console.error('Voice: Failed to serve preview:', err)
    res.status(500).json({ error: err.message })
  }
})
```

**Note on `TTSService.getApiKey(db)`:** This gets the API key for the *active* provider. If active provider is OpenAI, this returns the OpenAI key. If active provider is ElevenLabs, it returns the ElevenLabs key. We need the OpenAI key specifically. Use `EnvService.get(db, 'OPENAI_API_KEY')` directly instead.

Corrected:
```js
const apiKeyRecord = EnvService.get(db, 'OPENAI_API_KEY')
if (!apiKeyRecord?.value) {
  return res.status(503).json({ error: 'OpenAI API key not configured' })
}
filePath = await OpenAIProvider.generatePreview(apiKeyRecord.value, voiceId)
```

---

## Step 4: Resolve preview URLs in voice list responses

**Problem:** `getVoices()` returns relative URLs like `/api/voice/tts-preview/openai/nova`. The UI constructs `new Audio(previewUrl)`. In SetupScreen/SettingsPanel, these are rendered inside a BrowserView served at `http://localhost:{port}/{appId}/`. A relative URL `/api/...` resolves against the page origin, which is `http://localhost:{port}` — this works correctly.

**No changes needed** — the relative URL pattern works because the assistant app and the API share the same Express server and origin.

---

## Step 5: Verification

### 5a: Preview generation
- Switch to OpenAI provider in Settings > Voice Output
- Open agent settings → voice dropdown shows OpenAI voices
- Click "Play sample" on a voice → first time: brief delay while generating, then plays
- Click "Play sample" again → instant playback from cache
- Check `~/os8/blob/voice-previews/` contains `openai-{voiceId}.mp3` files

### 5b: SetupScreen
- Create new agent with OpenAI active
- Voice step shows Play buttons next to each voice
- Playing a preview works

### 5c: Cache persistence
- Restart OS8 → previews still play instantly (cached on disk)
- Switch to ElevenLabs and back to OpenAI → previews still cached

### 5d: No API key
- Remove OpenAI API key → voice list still loads (static), but Play fails gracefully (503)

### 5e: Tests
```bash
npm test   # All existing tests pass
```

---

## Files Summary

| Action | File | Scope |
|--------|------|-------|
| Modify | `src/services/tts-openai.js` | Add `generatePreview()`, `getPreviewPath()`, update `getVoices()` previewUrl |
| Modify | `src/routes/voice.js` | Add `GET /api/voice/tts-preview/:provider/:voiceId` |
| None | SetupScreen.jsx | No changes needed — preview buttons already conditional on previewUrl |
| None | SettingsPanel.jsx | No changes needed — preview buttons already conditional on previewUrl |

---

## Execution Order

```
Step 1-2 (tts-openai.js) → Step 3 (route) → Step 4 (verify URL resolution) → Step 5 (test)
```

Steps 1-2 are in the same file. Step 3 is the route. No UI changes needed.
