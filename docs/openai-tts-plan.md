# OpenAI TTS Integration Plan

## Goal
Add OpenAI TTS as an alternative to ElevenLabs. Users pick their TTS provider (OpenAI or ElevenLabs) during onboarding. They can switch providers at any time — each agent's voice selection is remembered per-provider and automatically restored on switch. Agents work without any TTS key (text-only mode).

## Design Decisions (Agreed)
1. Provider abstraction lives inside TTSService as a strategy pattern (tts-elevenlabs.js, tts-openai.js)
2. Server-side adapter: browser always connects via WebSocket to /api/tts/stream, server proxies to ElevenLabs WS or OpenAI chunked HTTP
3. No lip sync — removed as part of this work
4. OpenAI voice previews: generate and cache on demand
5. Global-only provider for v1 (no per-agent provider mixing)
6. Voice persistence: `agent_voices` table stores per-provider voice selections. `agents.voice_id`/`voice_name` is the active voice. Provider switch saves current → restores saved (or gender default). No remap confirmation needed.

---

## Phase 0: Dead Code Removal (Talking Head + Lip Sync) ✅ DONE

The entire talkinghead system is unused — no references from outside its directory. Lip sync alignment code exists in TTS streaming routes and is also unused.

### Delete entirely:
- `src/shared/talkinghead/` (entire directory — talkinghead.mjs, dynamicbones.mjs, retargeter.mjs, playback-worklet.js, lipsync/lipsync-en.mjs, lipsync/lipsync-fi.mjs)

### Remove alignment code from:

**`src/routes/tts-stream.js`:**
- Delete `convertCharToWordAlignment()` function
- Remove alignment request in BOS message
- Remove alignment forwarding in audio message handler
- Update file header comments referencing alignment

**`src/routes/call-stream.js`:**
- Remove any alignment data forwarding in the ElevenLabs message handler

**`src/shared/tts-stream-core.js`:**
- Remove `this.onAlignment = null` callback property
- Remove alignment forwarding block

**`src/templates/assistant/src/hooks/useTTSStream.js`:**
- Remove `onAlignment` parameter from hook signature and wiring

---

## Phase 1: Provider Abstraction (Backend) ✅ DONE

### New files:

**`src/services/tts-elevenlabs.js`** — Extracted from tts.js and speak.js:
- `getVoices(apiKey)` — calls ElevenLabs /v1/voices API
- `generateAudio(apiKey, text, voiceId, options)` — POST to /v1/text-to-speech/{voiceId}, returns mp3 Buffer
- `getWebSocketUrl(voiceId, model)` — builds wss://api.elevenlabs.io URL
- `getDefaultVoices()` — returns { female: { id, name }, male: { id, name } }

**`src/services/tts-openai.js`** — New provider:
- `getVoices()` — returns static list (9 voices: alloy, ash, coral, echo, fable, nova, onyx, sage, shimmer)
- `generateAudio(apiKey, text, voiceId, options)` — POST to /v1/audio/speech, returns mp3 Buffer
- `streamAudio(apiKey, text, voiceId, options)` — POST to /v1/audio/speech with response_format: 'pcm', returns ReadableStream
- `getDefaultVoices()` — returns { female: { id: 'nova', name: 'Nova' }, male: { id: 'echo', name: 'Echo' } }

### Modified:

**`src/services/tts.js`** — Refactored to facade:
- Keep: TextChunker, settings get/set
- Added: `getProvider(db)`, `getProviderName(db)`, `setProvider(db)`, `isAvailable(db)`, `getApiKey(db)`, `getProviderDefaults(providerName)`
- Modified: `getVoices(db)` delegates to active provider
- Modified: `getWebSocketUrl(db, options)` — provider-aware (returns null for OpenAI)

**`src/services/speak.js`:**
- Replaced direct ElevenLabs fetch with `TTSService.getProvider(db).generateAudio(...)`
- `getStatus(db)` checks correct API key based on active provider

**`src/db/seeds.js`:**
- Seeded `tts_provider` setting (empty default)
- Auto-detects ElevenLabs for existing users with ELEVENLABS_API_KEY

**Updated callers:** tts-stream.js, call-stream.js, voice.js, agents.js, speak.js meta, voicemessage.js meta, ipc/tts.js — all now use provider-aware TTSService methods.

---

## Phase 2: Streaming Adaptation

### Pre-work: Design spike
- Read OpenAI TTS API docs, verify PCM format (24kHz 16-bit signed LE expected)
- Design buffering model: one API call per sentence-chunk vs per-paragraph
- Read call-stream.js segment model in detail

### Modify:

**`src/routes/tts-stream.js`:**
- On init message: check provider setting
- **ElevenLabs path:** keep current WebSocket proxy
- **OpenAI path:** new function `connectToOpenAI(apiKey, voiceId, model)`:
  - On 'text' messages: buffer text server-side
  - On 'flush': POST to /v1/audio/speech with buffered text, response_format: 'pcm'
  - Stream response body, forward PCM chunks as base64 { type: 'audio', data } to client
  - Send { type: 'done' } when stream completes
- **No-key path:** reject with { error, setup: true } flag

**`src/routes/call-stream.js`:**
- Rename `connectToElevenLabs()` to `connectToTTS()` with provider branching
- ElevenLabs path: WebSocket (unchanged)
- OpenAI path: for each TTS segment, POST to OpenAI with accumulated text, stream PCM chunks back
- Segment queueing logic stays the same — only upstream connection changes

**Note on latency:** ElevenLabs streams incrementally (partial text → partial audio). OpenAI requires full text per request. With sentence-chunked text, each flush = one API call. This means slightly higher latency for OpenAI but acceptable for v1.

---

## Phase 3: Voice Persistence & Agent Schema

### New table: `agent_voices`

```sql
CREATE TABLE IF NOT EXISTS agent_voices (
  agent_id TEXT NOT NULL,
  provider TEXT NOT NULL,  -- 'elevenlabs', 'openai', future providers
  voice_id TEXT,
  voice_name TEXT,
  PRIMARY KEY (agent_id, provider),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);
```

No new columns on the `agents` table. `agents.voice_id` / `voice_name` remain the active voice — all existing callers work unchanged.

### Migration for existing users:
- Create `agent_voices` table
- For every agent with a non-null `voice_id`: insert row with `provider = 'elevenlabs'`, copying current `voice_id` / `voice_name`

### Provider switch logic:

Add `switchProvider(db, toProvider)` — single function, called when global provider changes:

```
For each agent:
  1. Upsert current voice_id/voice_name → agent_voices for outgoing provider
  2. Look up agent_voices for incoming provider
  3. If found → set agents.voice_id/voice_name to saved values
  4. If not found → set to gender default for incoming provider
Update tts_provider setting
```

### Voice selection (within current provider):

When user picks a voice for an agent:
1. Write to `agents.voice_id` / `voice_name` (active)
2. Upsert into `agent_voices` for current provider (remembered)

### Files:

**`src/db/schema.js`:**
- Add `agent_voices` table creation

**`src/db/seeds.js`:**
- Migration: create table + backfill from existing agent voice data

**`src/services/tts.js`:**
- Add `switchProvider(db, toProvider)` with save/restore logic
- Add `saveAgentVoice(db, agentId, provider, voiceId, voiceName)` helper
- Add `getAgentVoice(db, agentId, provider)` helper

**`src/routes/agents.js`:**
- Voice selection endpoint: also upserts `agent_voices` for current provider

---

## Phase 4: UI — Provider Selection & Voice Pickers

**`src/templates/assistant/src/components/SetupScreen.jsx`:**
- Voice step: provider-aware voice list from active provider
- No-key state: "Add an OpenAI or ElevenLabs API key in Settings to enable voice" + "Skip" always visible
- Agent creation works fully without voice

**`src/templates/assistant/src/components/SettingsPanel.jsx`:**
- Voice dropdown shows voices from active provider
- Voice selection writes to both active and `agent_voices`

**`src/renderer/settings.js` + `index.html`:**
- New TTS Provider section in settings
- Provider picker (OpenAI / ElevenLabs / None)
- API key status indicator
- Switching provider is instant — calls `switchProvider()`, no confirmation needed

---

## Phase 5: Routes & IPC Updates

**`src/routes/voice.js`:**
- `GET /api/voice/tts-status` — return provider + key status (already done in Phase 1)
- `POST /api/voice/tts-provider` — set provider, calls `switchProvider()`, returns updated agent voices

**`src/routes/speak.js`:**
- Status check delegates to provider-aware check (already done in Phase 1)

**`src/ipc/tts.js`:**
- `tts:isAvailable` — check correct API key for active provider (already done in Phase 1)
- `tts:getVoices` — delegate to provider-aware TTSService (already done in Phase 1)

---

## Phase 6: Voice Previews for OpenAI

**`src/services/tts-openai.js`:**
- `generatePreview(apiKey, voiceId)` — "Hello, I'm [name]" → cache as ~/os8/blob/voice-previews/openai-{voiceId}.mp3

**`src/routes/agents.js`:**
- For OpenAI voices: include previewUrl if cached, null otherwise

**`src/templates/assistant/src/components/SetupScreen.jsx`:**
- "Generate preview" button for OpenAI voices without cached preview

---

## Phase 7: No-TTS-Key Graceful Mode

**`src/services/tts.js`:**
- `isAvailable(db)` returns { available: false, provider: null, reason: 'no_provider' } when unconfigured (already done in Phase 1)

**`src/routes/tts-stream.js`:**
- Reject with { error, setup: true } — client shows nudge not error

**`src/templates/assistant/src/hooks/useTTSStream.js`:**
- On setup: true rejection, surface non-blocking nudge ("Voice not configured — add a TTS provider in Settings")

---

## Execution Order

```
Phase 0  →  Phase 1  →  Phase 2  →  Phase 3  →  Phase 4/5  →  Phase 6  →  Phase 7
(done)      (done)      (streaming)  (schema)    (UI+routes)   (previews)   (polish)
```

Each phase: sub-plan → execute → commit → context reset.
Phases 4 and 5 can run together (UI + supporting routes).

## Files Summary

| Action | Files |
|--------|-------|
| **Delete** | `src/shared/talkinghead/` (entire directory) — ✅ done |
| **Create** | `src/services/tts-elevenlabs.js`, `src/services/tts-openai.js` — ✅ done |
| **Create** | `agent_voices` table in schema |
| **Heavy modify** | `src/services/tts.js` (✅ facade done, add switchProvider), `src/routes/tts-stream.js`, `src/routes/call-stream.js` |
| **Medium modify** | `src/services/speak.js` (✅ done), `src/routes/agents.js` (✅ provider-aware, add voice upsert), `src/routes/voice.js` (✅ done, add provider switch route), `src/db/schema.js`, `src/db/seeds.js` |
| **Light modify** | `src/shared/tts-stream-core.js` (✅ done), `src/templates/assistant/src/hooks/useTTSStream.js` (✅ done), `src/templates/assistant/src/components/SetupScreen.jsx`, `src/templates/assistant/src/components/SettingsPanel.jsx`, `src/renderer/settings.js`, `index.html`, `src/ipc/tts.js` (✅ done) |
