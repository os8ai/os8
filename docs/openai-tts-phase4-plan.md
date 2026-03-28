# OpenAI TTS Phase 4: UI — Provider Selection & Voice Pickers

## Context

The backend supports multi-provider TTS (Phase 1-3), but the UI is hardcoded to assume ElevenLabs. Users have no way to select a TTS provider, switch between them, or see provider-specific settings. Phase 5's `POST /api/voice/tts-provider` route is pulled into this phase since the UI needs it.

**Current state:**
- SetupScreen step 3: loads voices from active provider, shows "Add ElevenLabs API key" when no provider configured
- SettingsPanel: voice dropdowns work, but stability/similarityBoost sliders are ElevenLabs-specific (OpenAI doesn't support them)
- Shell settings (`index.html` + `renderer/settings.js`): only has STT (Whisper) settings, no TTS provider picker
- No `POST /api/voice/tts-provider` endpoint exists yet

**Goal:** Users can select and switch TTS providers from shell settings. Voice pickers and settings adapt to the active provider. ElevenLabs-only controls are hidden for OpenAI.

---

## Step 1: Add `POST /api/voice/tts-provider` route

**File: `src/routes/voice.js`**

Add after the existing `GET /api/voice/tts-status` endpoint:

```js
// POST /api/voice/tts-provider — Switch TTS provider
router.post('/tts-provider', (req, res) => {
  const { provider } = req.body
  if (provider && !['elevenlabs', 'openai'].includes(provider)) {
    return res.status(400).json({ error: 'Invalid provider' })
  }
  const result = TTSService.switchProvider(db, provider || '')
  res.json({ success: true, ...result })
})
```

This calls `TTSService.switchProvider()` from Phase 3, which saves/restores per-agent voices in a transaction.

---

## Step 2: Add TTS Provider section to shell settings

### 2a: HTML structure

**File: `index.html`**

Add a new settings section for TTS Provider. Place it near the existing voice section (section-voice is STT). The section needs:

- Section header "Text-to-Speech"
- Provider selector: three buttons (OpenAI / ElevenLabs / None)
- Status indicator showing which API key is configured
- Brief help text

Find the voice settings section (`id="section-voice"`) and add a new `section-tts` section after it.

```html
<div class="settings-section" id="section-tts">
  <h3>Text-to-Speech</h3>
  <p class="settings-description">Choose which provider to use for agent voices.</p>
  <div class="setting-row">
    <label>Provider</label>
    <div id="tts-provider-buttons" class="toggle-group">
      <button data-value="" class="toggle-btn">None</button>
      <button data-value="elevenlabs" class="toggle-btn">ElevenLabs</button>
      <button data-value="openai" class="toggle-btn">OpenAI</button>
    </div>
  </div>
  <div id="tts-provider-status" class="setting-row" style="display:none;">
    <label>Status</label>
    <span id="tts-provider-status-text"></span>
  </div>
</div>
```

### 2b: JavaScript

**File: `src/renderer/settings.js`**

Add `loadTTSProviderSettings()` function:

1. `GET /api/voice/tts-status` → get `{ available, provider, reason }`
2. Highlight the active provider button
3. Show status text: "Ready" / "API key not configured" / etc.

Add click handlers on the toggle buttons:
1. `POST /api/voice/tts-provider` with `{ provider: value }`
2. Reload status after switch
3. Dispatch `tts-provider-changed` event so open SettingsPanel can refresh voices

Wire `loadTTSProviderSettings()` into the existing settings load flow.

### 2c: Styling

Use existing `.toggle-group` / `.toggle-btn` pattern if it exists, otherwise add minimal CSS. Check for existing toggle button patterns in `styles/` first.

---

## Step 3: Make SetupScreen voice step provider-aware

**Files: `src/templates/assistant/src/components/SetupScreen.jsx` + deployed copy**

The voice step (step 3) already calls `GET /api/agents/voices` which returns `{ ready, voices, provider }`. Changes needed:

### 3a: Update "no provider" message

Currently says "Add ElevenLabs API key". Change to be provider-agnostic:

```
Before: "Add an ElevenLabs API key in Settings to enable voice"
After:  "Add an OpenAI or ElevenLabs API key in Settings to enable voice"
```

### 3b: Show provider name in voice step

When voices are loaded, show which provider they're from:

```
"Showing {provider} voices" — small subtitle under the step heading
```

### 3c: Hide ElevenLabs-specific voice metadata for OpenAI

ElevenLabs voices have rich metadata (accent, age, use_case labels). OpenAI voices only have name + gender. The voice card rendering should handle missing labels gracefully — it likely already does, but verify.

### 3d: Handle OpenAI voices with no previewUrl

OpenAI voices return `previewUrl: null`. Hide the preview/play button when no preview is available. (Phase 6 adds preview generation.)

---

## Step 4: Make SettingsPanel provider-aware

**Files: `src/templates/assistant/src/components/SettingsPanel.jsx` + deployed copy**

### 4a: Hide ElevenLabs-specific sliders for OpenAI

The system tab has three ElevenLabs-specific controls:
- **Stability** slider (0-100%)
- **Similarity Boost** slider (0-100%)
- **Voice model** (if present)

These have no equivalent in OpenAI. Conditionally render them:

```jsx
{provider === 'elevenlabs' && (
  <>
    {/* stability slider */}
    {/* similarity boost slider */}
  </>
)}
```

Need to fetch the current provider. Add to the settings load effect:

```js
const statusRes = await fetch(`${baseApiUrl}/api/agents/voices/status`)
const statusData = await statusRes.json()
setTtsProvider(statusData.provider) // new state variable
```

### 4b: Show provider label in voice dropdown

In both agent and system tabs, show the provider name near the voice dropdown so users know which provider's voices they're seeing.

### 4c: Handle OpenAI voices with no previewUrl

Same as SetupScreen — hide play button when `previewUrl` is null.

### 4d: Listen for provider changes from shell

When the user changes provider in shell settings, the SettingsPanel should refresh:

```js
useEffect(() => {
  const handler = () => { loadVoices(); loadSettings(); }
  window.addEventListener('tts-provider-changed', handler)
  return () => window.removeEventListener('tts-provider-changed', handler)
}, [])
```

Note: The SettingsPanel is inside the assistant app's BrowserView, which is a separate renderer process from the shell. `window.dispatchEvent` from the shell won't reach it. Instead, the SettingsPanel should re-fetch on open (it already does), which is sufficient — users won't have both open simultaneously.

---

## Step 5: Update deployed assistant app

**Important:** Template edits do NOT propagate to deployed apps. Must update both:
- `src/templates/assistant/src/components/SetupScreen.jsx`
- `src/templates/assistant/src/components/SettingsPanel.jsx`
- `~/os8/apps/{appId}/src/components/SetupScreen.jsx`
- `~/os8/apps/{appId}/src/components/SettingsPanel.jsx`

Find the deployed app ID and apply the same changes.

---

## Step 6: Verification

### 6a: Shell settings
- Open Settings → verify "Text-to-Speech" section appears
- With ElevenLabs key set: select ElevenLabs → shows "Ready"
- With OpenAI key set: select OpenAI → shows "Ready"
- Select None → status hidden
- Switch between providers → instant, no error

### 6b: SetupScreen
- Create new agent with ElevenLabs active → voice step shows ElevenLabs voices
- Create new agent with OpenAI active → voice step shows OpenAI voices (no previews)
- Create new agent with no provider → shows "Add API key" message, Skip works

### 6c: SettingsPanel
- Open with ElevenLabs → stability/similarity sliders visible
- Open with OpenAI → stability/similarity sliders hidden
- Voice dropdown shows correct provider's voices
- Selecting a voice saves to both active + agent_voices

### 6d: Provider switch round-trip
- Set ElevenLabs, pick voice for agent
- Switch to OpenAI in shell settings
- Open agent settings → voice should be OpenAI default
- Pick an OpenAI voice
- Switch back to ElevenLabs → original ElevenLabs voice restored

### 6e: Tests
```bash
npm test   # All existing tests pass
```

---

## Files Summary

| Action | File | Scope |
|--------|------|-------|
| Modify | `src/routes/voice.js` | Add `POST /api/voice/tts-provider` |
| Modify | `index.html` | Add TTS Provider settings section |
| Modify | `src/renderer/settings.js` | Provider picker load/save/status |
| Modify | `src/templates/assistant/src/components/SetupScreen.jsx` | Provider-aware messages, hide preview when null |
| Modify | `src/templates/assistant/src/components/SettingsPanel.jsx` | Conditional EL sliders, provider label, no-preview handling |
| Modify | `~/os8/apps/{appId}/src/components/SetupScreen.jsx` | Same as template |
| Modify | `~/os8/apps/{appId}/src/components/SettingsPanel.jsx` | Same as template |

---

## Execution Order

```
Step 1 (route) → Step 2 (shell settings UI) → Step 3 (SetupScreen) → Step 4 (SettingsPanel) → Step 5 (deployed copy) → Step 6 (verify)
```

Step 1 must come first (UI depends on it). Steps 2-4 are independent of each other but doing them sequentially is cleaner. Step 5 is a copy operation after 3-4 are done.
