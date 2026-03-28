# OpenAI TTS Phase 7: No-TTS-Key Graceful Mode

## Context

When TTS is enabled in the SettingsPanel but no provider/API key is configured, the experience is silently broken — the agent response arrives as text but no audio plays, and the user gets no feedback about why.

**Current behavior:**
1. User enables "Voice Output" toggle in SettingsPanel system tab
2. Agent responds → Chat.jsx calls `connectTTS()` → TTSStreamCore opens WebSocket to `/api/tts/stream`
3. Server checks `TTSService.isAvailable(db)` → returns 503 with `{ error: '...', setup: true }`
4. TTSStreamCore `ws.onerror` fires → rejects with generic `new Error('WebSocket error')` (line 183 of tts-stream-core.js)
5. Chat.jsx `onError` logs to console and sets `ttsReady = false` — no user-visible notification
6. TTS silently stops working for the session

**The `setup: true` flag is already sent by the server** (tts-stream.js line 58) but never reaches the client — it's lost because the 503 HTTP response is not parsed by the WebSocket error handler.

**Goal:** Surface a non-blocking nudge in the chat UI when TTS fails due to missing provider/key, guiding the user to configure it. No modal — just a brief, dismissible message.

---

## Step 1: Parse 503 rejection in TTSStreamCore

**File: `src/shared/tts-stream-core.js`**

The WebSocket 503 rejection can't be parsed from `ws.onerror` (the WebSocket API doesn't expose HTTP response bodies). Instead, detect the failure pattern:

### Approach: Pre-flight HTTP check

Before opening the WebSocket, make a lightweight HTTP call to check TTS status. This is the cleanest way since WebSocket `onerror` can't distinguish 503 from network errors.

Add a pre-flight check inside `connect()`, before the WebSocket creation:

```js
// Pre-flight: check TTS availability before opening WebSocket
const port = window.location.port || '8888'
const statusRes = await fetch(`http://localhost:${port}/api/voice/tts-status`)
const statusData = await statusRes.json()
if (!statusData.available) {
  this._cleanup()
  const errorMsg = statusData.reason === 'no_provider'
    ? 'No TTS provider configured'
    : 'TTS API key not configured'
  this.onError?.(errorMsg, { setup: true, reason: statusData.reason })
  return false
}
```

**Key change:** `onError` callback now receives a second argument `{ setup: true, reason }` so the consumer can distinguish setup errors from transient failures.

---

## Step 2: Update useTTSStream hook to pass through setup flag

**File: `src/templates/assistant/src/hooks/useTTSStream.js`**

The `onError` callback wiring (line 106) already passes errors through. Since `onError` now receives a second argument, no changes needed — the second arg flows through to the Chat.jsx callback:

```js
core.onError = (error, meta) => callbacksRef.current.onError?.(error, meta)
```

Wait — currently it's:
```js
core.onError = (error) => callbacksRef.current.onError?.(error)
```

Update to pass through the second argument:
```js
core.onError = (error, meta) => callbacksRef.current.onError?.(error, meta)
```

---

## Step 3: Show nudge in Chat component

**File: `src/templates/assistant/src/components/Chat.jsx`**

### 3a: Add nudge state

```js
const [ttsNudge, setTtsNudge] = useState(null) // { message, reason }
```

### 3b: Update onError handler

Currently (lines 248-251):
```js
onError: (error) => {
  console.error('TTS error:', error)
  setTtsReady(false)
}
```

Change to:
```js
onError: (error, meta) => {
  console.error('TTS error:', error)
  setTtsReady(false)
  if (meta?.setup) {
    setTtsNudge({
      message: meta.reason === 'no_provider'
        ? 'Voice output needs a TTS provider — configure one in Settings > Voice Output'
        : 'Voice output needs an API key — add one in Settings > API Keys',
      reason: meta.reason
    })
  }
}
```

### 3c: Render nudge banner

Add a small, dismissible banner near the TTS indicator area (near line 1093 where the TTS playing indicator is rendered). The nudge should:
- Appear below the chat messages or above the input area
- Be dismissible (click X or auto-dismiss after 10 seconds)
- Use a muted warning style (not alarming)

```jsx
{ttsNudge && (
  <div className="flex items-center gap-2 px-3 py-2 bg-yellow-900/30 border border-yellow-700/40 rounded-lg text-xs text-yellow-300 mx-4 mb-2">
    <span className="flex-1">{ttsNudge.message}</span>
    <button
      onClick={() => setTtsNudge(null)}
      className="text-yellow-500 hover:text-yellow-300 flex-shrink-0"
    >
      ×
    </button>
  </div>
)}
```

### 3d: Auto-dismiss timer

Clear the nudge after 10 seconds:
```js
useEffect(() => {
  if (!ttsNudge) return
  const timer = setTimeout(() => setTtsNudge(null), 10000)
  return () => clearTimeout(timer)
}, [ttsNudge])
```

### 3e: Clear nudge on successful TTS

In the `onStart` callback, clear any lingering nudge:
```js
onStart: () => {
  console.log('TTS started')
  setTtsNudge(null) // Clear any previous setup nudge
  // ... rest of existing onStart logic
}
```

---

## Step 4: Update deployed assistant app

Copy updated files to deployed app:
- `src/shared/tts-stream-core.js` (shared, served via Express static)
- `src/templates/assistant/src/hooks/useTTSStream.js` → `~/os8/apps/{appId}/src/hooks/useTTSStream.js`
- `src/templates/assistant/src/components/Chat.jsx` → `~/os8/apps/{appId}/src/components/Chat.jsx`

Note: `tts-stream-core.js` is served from `src/shared/` by Express, not from the app directory, so it only needs updating in the repo.

---

## Step 5: Verification

### 5a: No provider configured
- Ensure TTS provider is set to "None" in Settings > Voice Output
- Enable "Voice Output" toggle in SettingsPanel system tab
- Send a message to agent
- Expected: Response appears as text. Yellow nudge banner appears: "Voice output needs a TTS provider — configure one in Settings > Voice Output"
- Nudge auto-dismisses after 10 seconds
- Clicking × dismisses immediately

### 5b: Provider set but no API key
- Set TTS provider to "OpenAI" but remove OPENAI_API_KEY
- Send a message to agent
- Expected: Nudge says "Voice output needs an API key — add one in Settings > API Keys"

### 5c: Properly configured
- Set provider and API key correctly
- Send a message to agent
- Expected: TTS works normally, no nudge shown

### 5d: Recovery
- Start with no provider (nudge appears)
- Configure provider and API key in Settings
- Send another message
- Expected: TTS works, nudge cleared on start

### 5e: Tests
```bash
npm test   # All existing tests pass
```

---

## Files Summary

| Action | File | Scope |
|--------|------|-------|
| Modify | `src/shared/tts-stream-core.js` | Add pre-flight HTTP status check in `connect()`, pass `{ setup, reason }` to onError |
| Modify | `src/templates/assistant/src/hooks/useTTSStream.js` | Pass second arg through onError callback |
| Modify | `src/templates/assistant/src/components/Chat.jsx` | Add ttsNudge state, show/dismiss nudge banner |
| Copy | `~/os8/apps/{appId}/src/hooks/useTTSStream.js` | Same as template |
| Copy | `~/os8/apps/{appId}/src/components/Chat.jsx` | Same as template |

---

## Execution Order

```
Step 1 (tts-stream-core.js) → Step 2 (useTTSStream.js) → Step 3 (Chat.jsx) → Step 4 (deployed copy) → Step 5 (verify)
```

Steps 1-3 are sequential (each builds on the previous). Step 4 is a copy operation.
