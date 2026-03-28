# OpenAI TTS Phase 2: Streaming Adaptation

## Context

ElevenLabs uses a persistent WebSocket — text chunks stream in, audio chunks stream back, `isFinal` signals segment complete. OpenAI TTS is HTTP-only — you POST full text, get a PCM stream back. The server must bridge this difference so the client protocol stays identical.

**Client protocol (unchanged):**
```
Client → Server: { type: 'init' } → { type: 'text', text } → { type: 'flush' }
Server → Client: { type: 'ready' } → { type: 'audio', data } → { type: 'done' }
```

**Key insight:** OpenAI requires full text before it returns audio. With sentence-chunked text, each flush = one HTTP call. Slightly higher latency than ElevenLabs' incremental model, but acceptable for v1.

---

## Step 1: Add `streamAudioChunked` helper to `tts-openai.js`

The existing `streamAudio()` returns a raw `response.body` (web ReadableStream). For the server we need a Node-friendly helper that reads the stream and calls a callback with base64-encoded chunks.

**Add to `src/services/tts-openai.js`:**

```js
/**
 * Stream audio and emit base64 chunks via callback
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
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
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
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      onChunk(Buffer.from(value).toString('base64'))
    }
    onDone()
  })().catch(err => {
    if (err.name !== 'AbortError') onError(err)
  })

  return () => controller.abort()
}
```

Export it alongside existing functions.

**Why a new function instead of using `streamAudio()`:** The raw `response.body` from `fetch` is a web `ReadableStream`. In Node 18+ this works but the ergonomics differ from Node streams. A callback-based helper is simpler to integrate into both `tts-stream.js` and `call-stream.js` without stream piping complexity.

---

## Step 2: Add OpenAI path to `tts-stream.js` (desktop TTS)

Refactor `handleConnection()` to branch on provider at init time.

### 2a: Determine provider on init

After `case 'init'`, read provider name. If `elevenlabs`, keep existing ElevenLabs WebSocket path. If `openai`, use new OpenAI HTTP path.

### 2b: ElevenLabs path (no changes)

Existing code stays as-is inside an `if (providerName === 'elevenlabs')` branch.

### 2c: OpenAI path — new function `handleOpenAIConnection(clientWs, apiKey, settings, voiceId)`

State:
- `textBuffer = ''` — accumulates text from 'text' messages
- `abortFn = null` — abort handle from `streamAudioChunked`
- `streaming = false` — true while an HTTP stream is in flight

**On 'init':** Send `{ type: 'ready' }` immediately (no upstream connection to wait for).

**On 'text':** Append `message.text` to `textBuffer`. If `message.flush` is true, trigger a flush (same as receiving a 'flush' message).

**On 'flush':** If `textBuffer` is non-empty:
1. Set `streaming = true`
2. Call `streamAudioChunked(apiKey, textBuffer, voiceId, { model, speed }, onChunk, onDone, onError)`
3. `onChunk(base64)` → send `{ type: 'audio', data: base64 }` to client
4. `onDone()` → send `{ type: 'done' }` to client, set `streaming = false`
5. `onError(err)` → send `{ type: 'error', message }` to client
6. Clear `textBuffer`

**On 'cancel':** Call `abortFn()` if streaming, send `{ type: 'cancelled' }`.

**On disconnect/error:** Call `abortFn()` if active.

### 2d: Update file header comment

Remove "ElevenLabs" specificity — it's now a provider-neutral TTS proxy.

---

## Step 3: Add OpenAI path to `call-stream.js` (phone call TTS)

This is the complex one. The ElevenLabs path has segment tracking, reconnection, flush queuing, and barge-in support — all built around a persistent WebSocket. The OpenAI path replaces the WebSocket with per-segment HTTP calls.

### 3a: Rename and refactor `connectToElevenLabs()`

Rename to `connectToTTS()`. At the top, check provider:
- If ElevenLabs → existing WebSocket logic (unchanged)
- If OpenAI → new OpenAI segment logic

### 3b: OpenAI call-stream strategy

**Key difference:** No persistent WebSocket. Each text block (content_block_start → content_block_stop) accumulates text, then one HTTP call streams audio back. The `isFinal` equivalent is the HTTP stream completing.

**New state variables for OpenAI path:**
- `openaiTextBuffer = ''` — text accumulated for current segment
- `openaiAbortFn = null` — abort handle for current stream
- `openaiStreaming = false` — true while HTTP stream is in flight

**`connectToTTS()` for OpenAI:** Resolves immediately (no upstream connection needed). Sets a flag `ttsProvider = 'openai'` so text-sending code knows to buffer instead of WebSocket-send.

**Text sending (content_block_delta):** Instead of `elevenWs.send({ text })`:
- If `ttsProvider === 'openai'`: append to `openaiTextBuffer`
- If `ttsProvider === 'elevenlabs'`: existing WebSocket send

**Segment flush (content_block_stop):** Instead of `elevenWs.send({ text: '' })`:
- If OpenAI: call `streamAudioChunked()` with `openaiTextBuffer`
  - `onChunk` → send `{ type: 'audio', data, requestId, segmentId }` to client
  - `onDone` → same logic as current `isFinal` handler (process queued segments, check `claudeResponseDone`)
  - Clear `openaiTextBuffer`

**Barge-in (`cancelAgentSpeech`):** Call `openaiAbortFn()` instead of `elevenWs.close()`.

**Queuing:** The existing `ttsPendingQueue` / `ttsWaitingForFlush` logic still applies — OpenAI segments can't overlap either. When one segment's stream completes (≈ isFinal), process the queue.

### 3c: Specific code locations to modify

1. **Line ~166**: Add `let ttsProvider = null` alongside existing state vars
2. **Line ~357-533** (`connectToElevenLabs` → `connectToTTS`): Add provider branch
3. **Line ~536-553** (`cancelAgentSpeech`): Add OpenAI abort path
4. **Lines ~628-633**: Update "Close existing ElevenLabs connection" to be provider-aware
5. **Lines ~700-708**: Update "Connecting to ElevenLabs" log messages
6. **Line ~850-885** (content_block_start): OpenAI doesn't need WS reconnect — just reset buffer
7. **Line ~906-919** (content_block_stop): OpenAI triggers HTTP call instead of WS flush
8. **Line ~960-967** (text sending): OpenAI buffers instead of WS send
9. **Line ~473-477** (isFinal queue processing): Reused by OpenAI's onDone callback

### 3d: Extract shared segment-complete logic

The `isFinal` handler (lines 463-508) has the segment completion logic (process queue, check claudeResponseDone, send agent_done). Extract this into a `handleSegmentComplete()` function called by both:
- ElevenLabs: from `isFinal` handler
- OpenAI: from `streamAudioChunked` `onDone` callback

---

## Step 4: Verification

### 4a: Startup test
```bash
npm start   # Verify OS8 starts without errors
```

### 4b: ElevenLabs regression
- Set provider to `elevenlabs` in settings
- Open assistant, send a message with TTS enabled
- Verify audio plays (desktop TTS via tts-stream.js)
- Verify phone calls work (call-stream.js)

### 4c: OpenAI TTS test
- Set provider to `openai` in settings (manual DB update for now — UI comes in Phase 4)
- Open assistant, send a message with TTS enabled
- Verify audio plays through desktop TTS
- Phone calls with OpenAI TTS (if OpenAI API key available)

### 4d: Edge cases
- Cancel mid-stream (barge-in) with OpenAI provider
- Multiple segments (tool use → text → tool use → text) with OpenAI
- No API key set → graceful error message
- Switch provider mid-session → next TTS request uses new provider

---

## Files Summary

| Action | File | Scope |
|--------|------|-------|
| Modify | `src/services/tts-openai.js` | Add `streamAudioChunked()` helper |
| Heavy modify | `src/routes/tts-stream.js` | Provider branch in `handleConnection()`, new OpenAI path |
| Heavy modify | `src/routes/call-stream.js` | Rename `connectToElevenLabs` → `connectToTTS`, add OpenAI segment streaming, extract `handleSegmentComplete()` |

No client-side changes needed — the WebSocket protocol between browser and server is identical for both providers.

---

## Execution Order

```
Step 1 (tts-openai.js helper)  →  Step 2 (tts-stream.js)  →  Step 3 (call-stream.js)  →  Step 4 (verify)
```

Steps 2 and 3 are independent of each other but both depend on Step 1.
