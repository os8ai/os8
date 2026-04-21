# Local Models — Phase 3: Task Coverage

**Status:** Design doc, pre-implementation.
**Companion to:** [LOCAL_MODELS_PLAN.md](LOCAL_MODELS_PLAN.md) (v1.2) · [LOCAL_MODELS_PHASE_2.md](LOCAL_MODELS_PHASE_2.md) (design).
**Scope:** Every OS8 task type (conversation, summary, planning, jobs, coding, image, TTS, vision) runs locally when local mode is active. A global `ai_mode` setting flips routing from proprietary cascades to local ones in one move.
**Non-goals:** Onboarding fork, per-agent mode override, mode-selection UI (Phase 4). Model-discovery auto-sync, "Running locally" badge, advanced-models panel (Phase 5).

Before reading this doc, skim Phase 2 §1 (inventory) and §2 (schema). Phase 3 assumes `ai_families.launcher_model`/`launcher_backend` exist and that `/api/serve/ensure` is the primary data-plane entry point.

---

## 0. Acceptance

From the plan's §4 Phase 3: *"every task type in OS8 runs locally."* Concrete exit criteria:

1. With `ai_mode = 'local'` set globally, an agent with `model = 'auto'` and nothing else configured routes every task to a local family: conversation→gemma-4-31B, coding/jobs→qwen3-coder-30b, summary→gemma-4-E2B, planning→gemma-4-31B, image→flux1-schnell, tts→kokoro-v1, vision→qwen3-6-35b-a3b. Flipping `ai_mode = 'proprietary'` restores the pre-Phase-3 behavior byte-for-byte.
2. `/api/imagegen/generate` with no arguments succeeds against ComfyUI when `ai_mode = 'local'`, returning a PNG path in `~/os8/blob/imagegen/`.
3. `/api/speak` with a local TTS provider selected produces an MP3 from Kokoro without hitting ElevenLabs or OpenAI.
4. A jobs run whose primary (`local-qwen3-coder-30b`) emits a malformed tool call escalates automatically to `local-qwen3-coder-next`; the next successful attempt uses the 85B.
5. An agent pinned to `local-qwen3-6-35b-a3b` (vision family) can send a message with an image attachment; the image is base64-embedded in the OpenAI `content` parts array and the model's response references it.
6. A qwen3-coder tool call is surfaced to OS8's existing tool-use UI as a Claude-shape `tool_use` block (not as raw text).
7. `GET /api/skills/registry` shows every local capability (LLM + TTS + image + vision) with availability tied to `/api/status/capabilities` from the launcher.
8. STT continues to work unchanged (whisper.cpp) — no Phase 3 work should regress it.

---

## 1. Inventory: Where Each Task Type Lives Today

Walking `os8@main` and `os8-launcher@main` as of 2026-04-20. Everything here is baseline for Phase 3 deltas.

### 1.1 Routing surface — proprietary-only and text-only

`src/services/routing.js:24` — `TASK_TYPES = ['conversation', 'jobs', 'planning', 'coding', 'summary', 'image']`. **No `tts`, no `vision`, no `image-edit`.** Every caller that touches `routing_cascade` assumes this set.

`src/services/routing.js:36-97` — `resolve()` returns `{familyId, backendId, modelArg, accessMethod, source}`. Shape unchanged since Phase 1. Agent override is honored for every task type (Phase-1 fix). The resolver does **not** know about the launcher — it only knows HTTP containers exist (`isAvailable` short-circuits them at line 117).

`src/db/schema.js:617-634` — `ai_model_families` has cap columns for the six proprietary task types (`cap_chat`/`cap_jobs`/`cap_planning`/`cap_coding`/`cap_summary`/`cap_image`) plus `eligible_tasks`. **No `cap_tts`, no `cap_vision`.**

`src/db/schema.js:694-703` — `routing_cascade(id, task_type, priority, family_id, access_method, enabled, is_auto_generated)`. **No `mode` column.** `UNIQUE(task_type, priority)` constraint — if Phase 3 adds `mode`, the unique constraint has to move to `(task_type, mode, priority)`.

### 1.2 Launcher capability surface — different vocabulary

`os8-launcher/src/backends.py:94-105` — `_MODEL_ELIGIBILITY` uses task names `conversation`, `summary`, `planning`, `coding`, `jobs`, `tts`, `image-gen`, `image-edit`, `vision`. **Mismatch:** launcher's `image-gen` ≠ OS8's `image`; launcher has `tts`/`vision`/`image-edit` that OS8 routing doesn't.

`os8-launcher/src/backends.py:1204-1233` — `get_capabilities_data()` returns `{task_type: [{instance_id, model, base_url, model_id, priority}]}` keyed by the launcher's vocabulary. Phase 1 OS8 reads this via `LauncherClient.getCapabilities()` in `createHttpProcess` (cli-runner.js:256) keyed by `taskType`. **Today that lookup uses whatever taskType the call-site passes in** — `createHttpProcess` already receives `taskType: 'conversation'` default, so routing-task-name → launcher-task-name mapping is currently a naked string match and silently falls back to `caps.conversation` when absent.

### 1.3 TTS — lives entirely outside routing

`src/services/tts.js:11-14` — `PROVIDERS = {elevenlabs, openai}`. Facade pattern: provider selection is a single setting (`tts_provider`), not a cascade. No `routing_cascade` row for TTS. Picker is `TTSService.getProvider(db)`.

`src/services/tts-openai.js:1-231` — provider-shape to copy for Kokoro. Exports `PROVIDER_ID`, `API_KEY_ENV`, `DEFAULT_VOICES`, `DEFAULTS`, `VOICES`, `getVoices`, `generateAudio`, `streamAudio`, `streamAudioChunked`, `getDefaultVoices`, `getWebSocketUrl`. `API_KEY_ENV` is what `TTSService.isAvailable()` reads to decide "ready." Streaming is SSE/PCM for OpenAI, WebSocket for ElevenLabs.

`src/services/tts.js:204-215` — `isAvailable(db)` checks `EnvService.get(db, provider.API_KEY_ENV)`. A local provider has no API key; the liveness check needs a launcher-reachability branch.

### 1.4 Image gen — routing-aware, ComfyUI-unaware

`src/services/imagegen.js:193-234` — `_familyToProvider` maps `gemini-imagen→gemini`, `openai-dalle→openai`, `grok-imagine→grok`. `resolveImageProviders(db)` walks `routing_cascade` for `task_type='image'`. **No ComfyUI branch.** Dispatch in `generate()` (line 342) is a three-way switch over `openai`/`grok`/`gemini`.

`src/services/imagegen.js:172-186` — `getAuthForProvider()` knows only API keys / OAuth. No notion of "no auth, it's local."

### 1.5 Vision / multimodal input — CLI-backend flags

`src/services/backend-adapter.js:554-555` — `local` backend has `supportsImageInput: false` and `supportsImageViaFile: false`. Both are **CLI-centric**: `supportsImageInput` means "stream-json stdin accepts base64 image blocks" (Claude-only); `supportsImageViaFile` means "CLI takes `--image filepath` flags" (Codex-only).

`src/assistant/message-handler.js:135, 638-639, 1283, 1550-1551` + `src/services/work-queue.js:468-469` — every image-attachment code path branches on `backend.supportsImageInput || backend.supportsImageViaFile`. HTTP backends currently fall off both cliffs and attachments silently drop.

`src/services/cli-runner.js:269-273` — `createHttpProcess` builds `messages: [{role: 'user', content: prompt}]` — `content` is always a plain string. No array-content path, no image-url parts, no video-url parts.

### 1.6 Tool calls — deferred since Phase 1

`src/services/cli-runner.js:306-373` — the SSE loop parses `choices[0].delta.content` only. `choices[0].delta.tool_calls` (OpenAI's delta shape for tool calls, emitted by vLLM with `--enable-auto-tool-choice --tool-call-parser qwen3_coder`) is unread. No synthesis path to Claude's `content_block_start{type:'tool_use'}` / `input_json_delta` / `content_block_stop` sequence, which is what `src/services/backend-events.js`' Claude translator consumes for `TOOL_CALL_*` ag-ui events.

`config.yaml:37, 213` (launcher) — `qwen3-coder-30b`, `qwen3-coder-next`, and `qwen3-6-35b-a3b` are all started with `--enable-auto-tool-choice --tool-call-parser qwen3_coder`. Tool calls are already being emitted; OS8 just isn't reading them.

### 1.7 STT — already local

`src/services/whisper.js` + `src/services/whisper-stream.js` — whisper.cpp runs in-process. Independent of launcher. No work in Phase 3. The only thing to verify is that nothing in the Phase-3 routing changes accidentally re-routes STT through the launcher.

### 1.8 Current local family seeding gap (Phase-2 dependency)

Phase 2 (`os8-1` commit) seeds `launcher_model`/`launcher_backend` columns and rows for `local-qwen3-coder-30b`, `local-kokoro-v1`, `local-flux1-schnell` as **families only** — no cascade wiring, no cap scores, no eligible_tasks. Phase 3 fills in the blanks. Missing today:

| Family | Gap to fill |
|---|---|
| `local-qwen3-coder-30b` | `cap_coding`, `cap_jobs` scores; `eligible_tasks='coding,jobs'` |
| `local-qwen3-coder-next` | Row doesn't exist yet; add with same caps higher, used as jobs escalation target |
| `local-gemma-4-e2b` | Row doesn't exist yet; seed for summary fallback |
| `local-kokoro-v1` | Family row exists from Phase 2; TTS is out-of-cascade (facade, §4.4) so no cap scoring needed |
| `local-flux1-schnell` | Needs `cap_image` score; `eligible_tasks='image'` |
| `local-flux2-klein-4b` | Not in launcher config.yaml yet — cross-project work; out of scope |
| `local-flux1-kontext-dev` | Image-edit task; see §7 out-of-scope |
| `local-qwen3-6-35b-a3b` | Vision family; needs `supports_vision=1`, `eligible_tasks='conversation'` |

Fish Speech is deferred: Phase 3 ships Kokoro as the sole local TTS provider. Fish can slot in later when voice cloning is actually needed.

---

## 2. Schema Changes

### 2.1 `routing_cascade` — add `mode` column

```sql
ALTER TABLE routing_cascade ADD COLUMN mode TEXT NOT NULL DEFAULT 'proprietary';
-- old unique: UNIQUE(task_type, priority)
-- new unique: UNIQUE(task_type, mode, priority)
```

`mode` values: `'proprietary'` | `'local'`. The resolver reads `settings.ai_mode` (new key, see §2.4) to pick which set of rows is live; it walks only rows whose `mode` matches.

**Why a column rather than a separate table:** cascade rows share the same (family, access_method, enabled, is_auto_generated) shape across modes; splitting into two tables doubles the regeneration code and breaks the "user reorders cascade in UI" path. A column keeps `updateCascade(db, taskType, entries)` in routing.js:164 correct with one WHERE-clause change.

**Migration concern.** SQLite's `UNIQUE(a, b)` constraint can't be altered in place; rebuilding the table is the standard workaround. The migration (`0.3.1-routing-mode.js`) does the rebuild:

```js
// 1. CREATE routing_cascade_new with (task_type, mode, priority) unique.
// 2. INSERT ... SELECT from old table with mode='proprietary'.
// 3. DROP old, ALTER RENAME new → routing_cascade. Wrap in txn.
// 4. DELETE FROM settings WHERE key = 'local_models_enabled' (drop the
//    dormant Phase-1 flag — ai_mode is authoritative now).
// Skip rebuild if `mode` column already exists (idempotent under crash-resume).
```

**Phase-2 dependency absorbed.** Phase 2 OS8-side (`os8-1`) was a separate migration adding `launcher_model` / `launcher_backend` columns to `ai_model_families`. Phase 2 is still design-only in git, so `os8-3-1` folds those two ALTERs into its own path (inline `try { db.exec('ALTER...') } catch {}` in `seeds.js` alongside the other additive column ALTERs). This keeps `os8-3-1` self-sufficient — it no longer blocks on a Phase-2 implementation PR. If Phase 2 is ever implemented as a standalone milestone, its `os8-1` step is now a no-op.

**Local-half cascade seeding (shipped in `os8-3-2`).** After the os8-3-1 migration runs, `routing_cascade` contains proprietary-only rows. `os8-3-2` parameterizes `generateCascade` on mode and adds a `0.3.2-seed-local-cascade.js` migration that backfills the local half. Fresh installs populate both halves via the updated `regenerateAll(db)`. See §6's `os8-3-2` notes.

### 2.2 `ai_model_families` — add `supports_vision` boolean

TTS does **not** join the cap-column family — it stays the `tts.js` facade (see §4.4). Vision does **not** get a `cap_vision` score; it's modeled as "conversation with multimodal input capability" via a single boolean:

```sql
ALTER TABLE ai_model_families ADD COLUMN supports_vision INTEGER DEFAULT 0;
```

`qwen3-6-35b-a3b` gets `supports_vision=1`; everything else stays `0`. The resolver uses this at dispatch time when the current message has image attachments (see §4.6). No changes to `cap_*` columns.

### 2.3 `ai_families.routes_to_comfyui` / vendor flags

For image-gen we need to know that a family routes through ComfyUI rather than an OpenAI-compat chat endpoint. The `launcher_backend` column (Phase 2) already disambiguates: `backend='comfyui'` is the signal. No new flag needed if `imagegen.js` checks `launcher_backend === 'comfyui'` to pick the ComfyUI client path. That's the approach taken in §4.5.

### 2.4 Settings

```
-- global mode. 'proprietary' (default) | 'local'.
INSERT INTO settings (key, value) VALUES ('ai_mode', 'proprietary');

-- local TTS provider — separate from tts_provider above so switching global
-- mode doesn't overwrite a user's non-local voice pick. Populated to 'kokoro'
-- when ai_mode flips to local for the first time.
INSERT INTO settings (key, value) VALUES ('tts_provider_local', 'kokoro');
```

Phase 1 seeded `local_models_enabled='0'` dormant (never read by any code). Phase 3 **deletes that row** in the `0.3.1` migration — `ai_mode` is the sole switch. One switch avoids the "both on but still broken" confusion a layered gate would create, and Phase 4's onboarding fork sets `ai_mode` directly.

---

## 3. Contracts

### 3.1 Task-name reconciliation — mapping layer in `LauncherClient`

Launcher vocab (`src/backends.py:94-105`): `conversation, summary, planning, coding, jobs, tts, image-gen, image-edit, vision`.
OS8 routing vocab: `conversation, jobs, planning, coding, summary, image`.

Divergences resolved by a thin mapping layer in `src/services/launcher-client.js`:

```js
// OS8 task-type → launcher task-type. Missing entries pass through unchanged.
const OS8_TO_LAUNCHER_TASK = {
  image: 'image-gen',
};

async function getCapabilitiesForTask(taskType) {
  const caps = await getCapabilities();
  const launcherKey = OS8_TO_LAUNCHER_TASK[taskType] || taskType;
  return caps?.[launcherKey] || caps?.conversation;
}
```

Call-sites (`cli-runner.js::createHttpProcess`, `sendTextPromptHttp`, `imagegen.js`'s ComfyUI branch) use `getCapabilitiesForTask(taskType)` instead of the current manual `caps?.[taskType] || caps?.conversation` lookup. One-line touch per call-site; OS8's internal vocabulary stays stable.

Remaining vocab mismatches:
- **`tts` missing in OS8.** TTS stays the facade it is today (§4.4); no routing_cascade row, no task-type. The mapping layer doesn't need a `tts` entry because OS8 never asks routing for `tts`.
- **`vision` missing in OS8.** Vision is modeled as "conversation with attachments + family `supports_vision` flag" — picked at dispatch time in message-handler.js. See §4.6. No `vision` task-type; no mapping entry needed.
- **`image-edit`.** Not in the 8 Phase-3 items. Out of scope; the Kontext family stays unseeded for now. Flag for a follow-up.

### 3.2 Launcher data-plane request shapes OS8 must speak

| Feature | Endpoint | Request shape | Response |
|---|---|---|---|
| Chat (all text tasks) | `POST :<port>/v1/chat/completions` | OpenAI schema; `content: string` for text, `content: [parts]` for multimodal | SSE deltas |
| Tool calls (qwen3-coder) | same | same + `tools: [{type:'function',function:{...}}]` | SSE with `choices[0].delta.tool_calls[]` |
| Vision (qwen3-6-35b-a3b) | same on port 9006 | `content: [{type:'image_url'|'video_url', ...}, {type:'text',...}]` + optional `extra_body.chat_template_kwargs.enable_thinking` | SSE deltas |
| TTS (Kokoro) | `POST :8880/v1/audio/speech` | `{model:'kokoro', input, voice, speed, response_format}` | binary audio |
| Image gen (ComfyUI) | `POST :8188/prompt` | `{prompt: <workflow JSON graph>, client_id}` | `{prompt_id}` (async) |
| Image gen progress | `WS :8188/ws?clientId=<id>` | — | `{type:'progress'|'executing'|'execution_error', data:{prompt_id,...}}` |
| Image gen result | `GET :8188/history/{prompt_id}` | — | `{<prompt_id>:{outputs:{<node>:{images:[{filename,type,subfolder}]}}}}` |
| Image gen file | `GET :8188/view?filename=&type=&subfolder=` | — | binary PNG |
| Image gen reference upload (Kontext) | `POST :8188/upload/image` (multipart) | `image=file, overwrite=true` | `{name, subfolder, type}` |

Voice listing for Kokoro: `GET :8880/v1/audio/voices`.

All shapes verified against `os8-launcher/clients/{tts,image-gen,vision}/static/index.html` — those clients are the canonical references.

### 3.3 Port discovery

OS8 does not hardcode `8880`/`8188`/`9006`. Every data-plane call resolves through `LauncherClient.ensureModel({model, backend})` (Phase 2, `src/services/launcher-client.js`). The returned `base_url` is used as-is. This means the user's Ports-tab per-kind overrides (and Phase 2's per-instance overrides) flow transparently to all Phase 3 paths without Phase 3 code changes.

For TTS/image/vision where dispatch isn't going through `createHttpProcess`, the same `ensureModel` call happens before the first data-plane POST. §4.4-4.6 show where in each module.

---

## 4. Per-Feature Design

### 4.1 Family seeds and eligibility (item 1)

Extend `src/db/seeds.js`'s `backfillFamilyCaps` and `backfillEligibleTasks` to cover every local family. Additions (new families marked `*`):

| Family ID | container | launcher_model | launcher_backend | cost | cap_chat | cap_jobs | cap_plan | cap_code | cap_sum | cap_img | eligible_tasks | supports_vision |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| local-gemma-4-31b | local | gemma-4-31B-it-nvfp4 | vllm | 1 | 3 | 2 | 3 | 2 | 3 | 0 | conversation,summary,planning | 0 |
| local-gemma-4-e2b * | local | gemma-4-E2B-it | vllm | 1 | 2 | 1 | 1 | 1 | 3 | 0 | conversation,summary | 0 |
| local-qwen3-coder-30b | local | qwen3-coder-30b | ollama | 1 | 2 | 4 | 3 | 4 | 2 | 0 | coding,jobs | 0 |
| local-qwen3-coder-next * | local | qwen3-coder-next | vllm | 1 | 2 | 5 | 4 | 5 | 2 | 0 | coding,jobs | 0 |
| local-qwen3-6-35b-a3b * | local | qwen3-6-35b-a3b | vllm | 1 | 3 | 3 | 3 | 2 | 3 | 0 | conversation | 1 |
| local-kokoro-v1 | local | kokoro-v1 | kokoro | 1 | 0 | 0 | 0 | 0 | 0 | 0 | *(out of cascade — facade)* | 0 |
| local-flux1-schnell | local | flux1-schnell | comfyui | 1 | 0 | 0 | 0 | 0 | 0 | 4 | image | 0 |

Capability scores are conservative starting points — `cap_coding=4` for qwen3-coder-30b and `cap_coding=5` for qwen3-coder-next reflect the models' tool-trained provenance. Tune after real eval (Phase 5). `local-kokoro-v1` stays out of `routing_cascade` — TTS is selected via `TTSService.getProvider(db)`, not the resolver.

Seeding is idempotent: seeds use `INSERT OR IGNORE` for rows and unconditional `UPDATE` for cap scores (matches the existing `backfillFamilyCaps` pattern). The new rows take effect only when `mode='local'` cascades are regenerated.

### 4.2 Mode column + resolver (item 2)

**Global mode switch.** A single setting, `ai_mode`, drives every cascade lookup. No per-agent override in Phase 3 (that's Phase 4).

**Resolver change** (`src/services/routing.js`):

1. `getCascade(db, taskType)` gets a second arg `mode` (default: read `settings.ai_mode`), filters with `WHERE task_type = ? AND mode = ?`.
2. `resolve(db, taskType, agentOverride)` picks `mode = settings.ai_mode`, threads it into `getCascade`.
3. `generateCascade(db, taskType)` gets a `mode` arg. For `mode='local'` it filters `families` by `container.type === 'http'` before scoring. For `mode='proprietary'` it filters the opposite.
4. `regenerateAll(db)` loops over both modes (`['proprietary', 'local']`) instead of once.
5. Hard fallback at `routing.js:89-97` — if no local cascade entry is available (launcher down), fall back to `claude-sonnet` only if `ai_mode='proprietary'`. Under `ai_mode='local'`, throw `LOCAL_MODE_NO_FALLBACK` and let the HTTP path's error handling surface a toast. This preserves the privacy promise of local mode: a user on local mode should never silently hit a cloud model.

**Constraints.** `model_api_constraints` (routing.js:357) is per-provider. Local has no API/login distinction — constraints need a `local` provider entry with `{task_type: 'api'}` for every task, treating HTTP as a pseudo-API. `_defaultConstraints()` already seeds providers from `PROVIDER_IDS = ['anthropic', 'google', 'openai', 'xai']`; extend to include `'local'`.

**Cascade regeneration trigger.** When `ai_mode` is set via the Settings API, trigger `RoutingService.regenerateAll(db)` and emit a `CUSTOM` ag-ui event with `name='mode-switch'` so open chat UIs can re-render their model badges. (UI wiring is Phase-4 work; the emit is Phase-3-cheap.)

### 4.3 Jobs escalation (item 3)

**Goal:** `local-qwen3-coder-30b` handles routine tool calls; a parse failure auto-escalates the retry to `local-qwen3-coder-next`.

**Detection signal.** vLLM with `--tool-call-parser qwen3_coder` emits either a well-formed `tool_calls[]` delta or — when the model hallucinates — content text that looks like JSON but is syntactically malformed. The two failure modes OS8 needs to detect:

- `choices[0].delta.tool_calls[i].function.arguments` contains invalid JSON. OS8's synthesized `input_json_delta` path (see §4.7) attempts `JSON.parse` and fails.
- The assistant emits a tool-call-like string in plain content (e.g. `<tool_call>...</tool_call>`) that the parser didn't catch — detectable by a regex match in the accumulated text.

Both failures land in `parseStreamJsonOutput` (backend-adapter.js:600-620) or are surfaced via message-handler's stream loop. The escalation hook lives in `message-handler.js` (where the stream terminates and the retry loop already sits); `routing.js` exposes the `nextInCascade` helper below and message-handler calls it on a catch.

**Cascade order.** For `task_type='jobs'` under `mode='local'`:

```
priority 0: local-qwen3-coder-30b  (17 GB, ollama, resident)
priority 1: local-qwen3-coder-next (85 GB, vllm, on-demand via ensure)
```

`generateCascade` under local mode emits this naturally (cap_jobs 4 vs 5). For `task_type='coding'`, same order.

**Escalation wire.** The existing `routing.js::markExhausted()` TTL-based pattern doesn't fit — this isn't quota exhaustion, it's a one-off parse failure. Add a narrow path:

```js
// New in routing.js:
nextInCascade(db, taskType, currentFamilyId, accessMethod = 'api') { … }
```

Returns the next cascade entry after `currentFamilyId`, honoring current mode. Callers in message-handler (jobs path) catch `TOOL_CALL_PARSE_FAILED`, call `nextInCascade`, `ensureModel` the next family, and retry **once**. No recursive escalation — one bounce only; further failures bubble as errors. Prevents escalation storms when the 85B is also failing (symptom of a bad prompt or hung launcher, not a model-capability issue).

### 4.4 TTS: Kokoro (item 4)

Phase 3 ships Kokoro as the sole local TTS provider. Fish Speech is deferred — no voice-cloning requirement yet, and one less surface to get right.

**Provider file.** `src/services/tts-kokoro.js`, matching `tts-openai.js`'s exports exactly:

- `PROVIDER_ID` — `'kokoro'`
- `API_KEY_ENV` — `null` (local; no auth)
- `DEFAULT_VOICES` — `{female: {id:'af_bella', name:'Bella'}, male: {id:'am_adam', name:'Adam'}}`
- `DEFAULTS` — `{model:'kokoro', voiceId:'af_bella', speed:1.0, format:'mp3'}`
- `VOICES` — hard-coded list of the 54 prebuilt voices, or lazy-fetched from `GET :8880/v1/audio/voices` and cached.
- `getVoices(apiKey)` — ignores `apiKey`; fetches via `LauncherClient.ensureModel({model:'kokoro-v1', backend:'kokoro'})` → `GET <base_url>/v1/audio/voices`.
- `generateAudio(apiKey, text, voiceId, options)` — resolves `base_url` via `ensureModel`, POSTs the shape in §3.2. Returns `Buffer`.
- `streamAudio` / `streamAudioChunked` — Kokoro returns PCM/MP3 in a single streaming response; trivial pass-through.
- `getDefaultVoices()`, `getWebSocketUrl()` — standard pattern (Kokoro has no WS).

**Facade wiring.** `src/services/tts.js:11-14`:

```js
const PROVIDERS = {
  elevenlabs: ElevenLabsProvider,
  openai: OpenAIProvider,
  kokoro: KokoroProvider,
}
```

`TTSService.isAvailable(db)` gets a new branch: if `provider.API_KEY_ENV === null` (local provider), check launcher reachability via `LauncherClient.isReachable()` instead of the env key. If unreachable, report `{available: false, reason: 'launcher_down'}`.

**Mode-driven selection.** When `ai_mode` flips to `'local'`:
- If `tts_provider_local` is set, use it.
- Else default to `'kokoro'`.
- ElevenLabs/OpenAI providers stay registered but deprioritized.

When `ai_mode` flips back to `'proprietary'`, restore the user's previous `tts_provider` value. Implement via `TTSService.switchProvider` (already handles agent-voice migration).

**Out of `routing_cascade`.** TTS is a single-provider choice; the `ai_mode` switch + `tts_provider` / `tts_provider_local` settings drive it. No cascade row, no `cap_tts` column. Matches the existing facade — no new selection mechanism to reason about.

### 4.5 Image gen via ComfyUI (item 5)

**Workflow templates ship in OS8.** The `os8-launcher/clients/image-gen/static/index.html:305-410` already contains the two workflows we need (`buildWorkflow` for schnell/dev, `buildKontextWorkflow` for Kontext). Copy them into OS8 as JSON templates under `src/services/comfyui-workflows/` with `{{PROMPT}}`/`{{WIDTH}}`/`{{HEIGHT}}`/`{{STEPS}}`/`{{SEED}}` placeholders.

Keeping workflows in OS8 means OS8 decides the graph shape per-family — matching the plan's philosophy that OS8 owns decision-making and the launcher owns orchestration. An OpenAI-compat shim in the launcher would replicate the schnell/dev/kontext switch-case on the wrong side of the wire and has to grow for every future Flux variant.

**ImageGenService changes** (`src/services/imagegen.js`):

1. `_familyToProvider` gains `'local-flux1-schnell': 'comfyui'`, `'local-flux1-dev': 'comfyui'` (and `'local-flux1-kontext-dev'` later for image-edit).
2. `_familyToProviderId` gains the same keys → `'local'` (the routing provider ID).
3. `resolveImageProviders(db)` filters by current `ai_mode` — on local mode, only ComfyUI entries surface; proprietary, only OpenAI/Gemini/Grok. Implicitly driven by the cascade filter in §4.2.
4. `generate()`'s dispatch switch gains a `comfyui` branch: `generateWithComfyUI(auth, prompt, referenceImages, options)`.

**`generateWithComfyUI` shape:**

```
1. ensureModel({model: 'flux1-schnell', backend: 'comfyui'}) → {base_url}
2. If referenceImages.length > 0 (Kontext path):
     POST {base_url}/upload/image with the reference → {name}
     Build Kontext workflow with that filename
   Else:
     Build schnell/dev workflow
3. Open WS {base_url_ws}/ws?clientId=<uuid>
4. POST {base_url}/prompt {prompt: workflow, client_id} → {prompt_id}
5. Wait on WS for {type:'executing', data:{node:null}} (completion) or
   {type:'execution_error'} (reject).
6. GET {base_url}/history/{prompt_id} → extract outputs[*].images[0]
7. GET {base_url}/view?filename=&type=&subfolder= → PNG buffer
8. Save via this.saveImages([{b64_json: buffer.toString('base64'), mimeType}], ...)
```

Step 7 returns binary, not base64 — `saveImages` expects base64. Either base64-encode or add a buffer-path in `saveImages`. Prefer the buffer path; it's in a hot path.

**ComfyUI auth.** `getAuthForProvider(db, 'local', 'api')` returns `{type: 'none', token: null}` — the existing dispatch path is `{type,token}` but `generateWithComfyUI` can accept a null auth. Add the branch in `getAuthForProvider` (imagegen.js:172).

**Polling vs WebSocket.** WS is cheaper on latency; HTTP polling of `/history/{id}` is simpler. Match the launcher client: WS. If Node's `ws` or native `WebSocket` isn't already in OS8's deps, polling is an acceptable fallback. Check `package.json` for `ws` before deciding.

### 4.6 Vision (item 6)

**No `vision` task type.** Vision is modeled as "conversation + attachments + family `supports_vision=1`." No row in `routing_cascade`, no entry in `TASK_TYPES`, no mapping-layer entry. The decision is made at dispatch time.

**Dispatch-time family override.** In `message-handler.js` (call-sites around `:135`, `:638-639`, `:1283`, `:1550-1551`), when the current message has at least one image attachment **and** `ai_mode='local'`:

1. Call `AIRegistryService.getFamilies(db)` filtered to `container_id='local'`, `supports_vision=1`. Today that's one row: `local-qwen3-6-35b-a3b`.
2. Override the resolver's returned family with that row, keeping `taskType='conversation'` and `access_method='api'`.
3. If no vision-capable local family exists (launcher misconfigured), fall back to the hard-fail path — don't silently drop images or route to cloud.

Under `ai_mode='proprietary'`, the existing Claude/Codex paths handle images via their CLI flags — no change.

**HTTP multimodal support flag — minimal refactor.** The CLI-centric pair `supportsImageInput`/`supportsImageViaFile` is preserved. We flip `supportsImageInput: true` on the `local` backend entry and add one helper:

```js
// src/services/backend-adapter.js, local entry:
supportsImageInput: true,   // flip from false
supportsImageViaFile: false,
// New helper consulted by message-handler:
supportsVisionForFamily(familyId, db) {
  const family = AIRegistryService.getFamily(db, familyId);
  return family?.supports_vision === 1;
}
```

Callers at `message-handler.js:135`, `:638`, `:1283`, `:1550` switch from `backend.supportsImageInput || backend.supportsImageViaFile` to `(backend.supportsImageInput && backend.supportsVisionForFamily?.(familyId, db)) || backend.supportsImageViaFile`. `supportsVisionForFamily` is undefined on non-local backends → short-circuits to the existing flag; proprietary paths unchanged. When a second HTTP backend with per-model vision quirks lands, the helper becomes the natural rename target for a broader `familySupportsImages(familyId, db)`.

**createHttpProcess changes.** When the caller passes images, build content as an array:

```js
body.messages = [{
  role: 'user',
  content: hasImages
    ? [
        ...images.map(img => ({type: 'image_url', image_url: {url: `data:${img.mimeType};base64,${img.data}`}})),
        {type: 'text', text: prompt},
      ]
    : prompt,
}];
```

Images arrive via a new `createHttpProcess` opt: `opts.attachments: [{mimeType, data (base64)}]`. Message-handler populates it.

**extra_body for thinking/video.** The vision client uses `extra_body.chat_template_kwargs.enable_thinking` and `extra_body.mm_processor_kwargs.fps` (for video). OS8 can ignore thinking for now (agent config doesn't expose it); leave the default (on). Video support is outside the 8 items.

### 4.7 OpenAI tool_calls synthesis (item 7)

**Why in Phase 3:** qwen3-coder is tool-trained (launcher config.yaml:37 runs it with `--enable-auto-tool-choice --tool-call-parser qwen3_coder`). Phase 1 deferred this because Gemma-4-31B isn't tool-trained. Now it's unblocked, and §4.3's jobs-escalation feature depends on detecting tool-call parse failures — which requires first parsing them.

**Input from vLLM (OpenAI delta shape).** SSE frames carry:

```json
{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"Read","arguments":"{\"path\":\"/tmp/"}}]}}]}
{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"f.txt\"}"}}]}}]}
{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}
```

Note: `id`/`name` arrive only in the first delta; subsequent deltas stream `arguments` fragments. `index` is how OpenAI disambiguates parallel tool calls within a turn.

**Output to Claude translator (stream-json shape).** What `backend-events.js` ClaudeTranslator expects (per CLAUDE.md's ag-ui section):

```json
{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_abc","name":"Read","input":{}}}}
{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"/tmp/"}}}
{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"f.txt\"}"}}}
{"type":"stream_event","event":{"type":"content_block_stop","index":1}}
```

**Synthesis in `createHttpProcess`.** Extend the SSE loop at cli-runner.js:333+:

1. Track a `toolCallState: Map<index, {id, name, emittedStart: bool, lastArgFragment: string}>`.
2. On each delta, for each `tool_calls[i]`:
   - If this index is new in the Map: emit `content_block_start` with `content_block.type='tool_use'`, record `id` and `name`. Assign a synthesized `index` in the Claude-side stream (track `nextBlockIndex` separately from OpenAI's per-call `index`).
   - Emit `content_block_delta` with `input_json_delta.partial_json = function.arguments` (the fragment).
3. On `finish_reason='tool_calls'` (or stream end with pending open blocks): emit `content_block_stop` for each open tool-use block, then the final `result`.
4. Accumulate each tool call's full `arguments` string per index. On `content_block_stop`, `JSON.parse` the accumulated string — if it throws, emit a `system_error` with `code='tool_call_parse_failed'` and `family_id` in the payload. This is the signal §4.3's escalation path listens for.

**Tools declaration.** qwen3-coder needs `tools: [...]` in the request body to emit tool calls. OS8's current HTTP path doesn't send `tools`. Wire it:

- `createHttpProcess` new opt: `opts.tools: OpenAIToolSpec[]`. Message-handler populates from the current agent's skill set, converting Claude's `tool_use` catalog into OpenAI's `{type:'function', function:{name, description, parameters}}` shape. This converter lives alongside other skill → tool-spec code (scan `src/assistant/` for existing patterns).
- Text-only paths (sendTextPromptHttp) don't pass tools — unchanged.

**Test harness.** Record a real qwen3-coder SSE stream to a fixture; unit-test the translator against it. Keep the fixture short enough to commit (200 lines).

### 4.8 STT (item 8)

No work. Confirm nothing in `src/services/whisper.js` / `whisper-stream.js` / voice routes calls `LauncherClient`. One-line check.

---

## 5. Known Risks

- **Mode-switch mid-conversation.** A user flips `ai_mode` while an agent has an in-flight stream. Current stream continues (it's already resolved); the next message uses the new mode. Acceptable. Worth a test: mode-switch UI should not abort open streams.
- **ComfyUI-only image path assumes ComfyUI is the only non-OpenAI-shape image backend.** If Phase 5 adds SDXL or another launcher backend with a different API, `imagegen.js`'s dispatch branch needs a more structured switch than a single `comfyui` case. Accept for Phase 3; revisit at Phase 5.
- **Kokoro voice list drift.** Kokoro-FastAPI auto-downloads voice files on first request. `getVoices()` may return an empty array before any generation happens. Mitigation: TTS provider settings UI should show a "voices will appear after first generation" hint, or call `generateAudio` with a tiny warmup string on provider-switch. Low priority.
- **ComfyUI WS reliability.** If the WS drops mid-generation, OS8's `generateWithComfyUI` hangs until the WS's close handler fires. Add a 5-minute timeout and a fallback to `GET /history/{prompt_id}` polling after WS close.
- **Tool-call synthesis race across indices.** OpenAI streams `tool_calls[i]` where `i` can interleave across a single assistant turn (parallel tool use). Claude's `block_index` is a different axis. The translator must allocate Claude `block_index` at first-sighting-of-openai-index, not on each delta. Accounted for in §4.7 step 2 but worth a test.
- **Cascade regeneration under mode flip wipes user reorderings.** If a user manually reordered their local cascade, flipping `ai_mode` back and forth and regenerating will lose the customization. Mitigation: only regenerate auto-generated rows (`is_auto_generated=1`) on mode flip; preserve manual ones. Matches existing `regenerateAll` behavior at `routing.js:248`.
- **Phase-2 oversight (flag only, not expanding scope):** `/api/serve/ensure` isn't called ahead of TTS/image calls today — Phase 1's `createHttpProcess` calls `getCapabilities()` but TTS/image paths bypass cli-runner entirely. Phase 3 TTS/image must each call `ensureModel` directly before their first data-plane POST. Documented in §3.3 and §4.4-4.6.
- **Pre-existing Phase-1 UI bugs** (`state.working` divergence, stale "Working…" on subconscious-direct path) — present, not touched. Flagged per the task's scope discipline.

---

## 6. Commit Sequence

Sized for single-reviewer PRs. No commit leaves the tree broken. OS8-only — Phase 3 has no launcher changes (the launcher already emits everything we need).

**`os8-3-1`: Schema + family seeds + mode column. (SHIPPED — commit WIP on main)**
- `package.json`: version bump 0.2.10 → 0.3.1.
- `schema.js`: `ai_model_families` gains `launcher_model TEXT`, `launcher_backend TEXT`, `supports_vision INTEGER DEFAULT 0`. `routing_cascade` gains `mode TEXT NOT NULL DEFAULT 'proprietary'` with `UNIQUE(task_type, mode, priority)`.
- `seeds.js`: inline `try { ALTER } catch {}` for the three new `ai_model_families` columns (idempotent on upgrade). New `INSERT OR IGNORE` family rows for `local-gemma-4-e2b`, `local-qwen3-coder-30b`, `local-qwen3-coder-next`, `local-qwen3-6-35b-a3b`, `local-kokoro-v1`, `local-flux1-schnell`. Cap scores + `eligible_tasks` extended per §4.1. New `backfillLauncherMetadata` transaction sets `launcher_model` / `launcher_backend` / `supports_vision` on every local family. Replaced `local_models_enabled='0'` seed with `ai_mode='proprietary'` + `tts_provider_local='kokoro'`.
- `src/migrations/0.3.1-routing-mode.js` (new): rebuilds `routing_cascade` for the UNIQUE-constraint swap (detects existing `mode` column and no-ops under crash-resume); deletes the dormant `local_models_enabled` settings row.
- `routing.js::generateCascade`: one-line filter `if (container?.type === 'http') continue;` — keeps HTTP families out of auto-generated proprietary cascades. `os8-3-2` replaces this with proper `mode`-parameterized filtering.
- `tests/db/schema.test.js`: `EXPECTED_COLUMNS` extended with the three new `ai_model_families` columns and `routing_cascade.mode`.
- `tests/migrations/0.3.1-routing-mode.test.js` (new): 7 tests covering mode column default, backfill, row preservation, UNIQUE swap behavior, dormant-flag deletion, and idempotency.
- **Status:** 341 tests pass (+7 from the new migration file). One pre-existing failure (`routing.test.js:194` — test is stale from before Phase 1's agent-override-for-all-tasks fix) is unchanged by this PR.

**`os8-3-2`: Resolver mode plumbing. (SHIPPED)**
- `package.json`: version bump 0.3.1 → 0.3.2.
- `routing.js`:
  - New `VALID_MODES = ['proprietary', 'local']` constant, exported.
  - New `getMode(db)` / `setMode(db, mode)`. `getMode` fails safe to `'proprietary'` when the setting is unset or holds a non-`local` value — a garbled row can never silently enable local mode.
  - `getCascade(db, taskType, mode?)` — mode defaults to current `ai_mode` via `getMode`.
  - `updateCascade(db, taskType, entries, mode?)` — manual-reorder UI path, scoped per mode.
  - `generateCascade(db, taskType, mode='proprietary')` — symmetric mode filter replaces the os8-3-1 one-liner. `'proprietary'` excludes HTTP containers; `'local'` includes only them.
  - `regenerateAll(db)` — iterates both modes. Skips regeneration of a mode that still has manual rows (per-mode scope instead of global).
  - `_regenerateTaskType(db, taskType)` — refreshes both modes.
  - Hard-fallback at the end of `resolve()`: under `ai_mode='local'`, returns a local chat family (`local-gemma-4-31b`) with `source='local_no_fallback'` instead of `claude-sonnet`. **Privacy promise held — never cloud-fall-back when local mode is active.** (Deviation from §4.2's "throw LOCAL_MODE_NO_FALLBACK" — `resolve()` stays total to avoid try/catch churn across ~20 call-sites; the HTTP dispatcher's launcher-unreachable toast surfaces naturally.)
  - `_defaultConstraints()` now seeds a `'local'` pseudo-provider with `'api'` for every task (HTTP has no login concept).
- `seeds.js`: backfill existing `model_api_constraints` settings rows to include the `'local'` provider.
- `src/migrations/0.3.2-seed-local-cascade.js` (new): populates local cascade rows for every task type by calling `generateCascade(db, taskType, 'local')`. Idempotent via early-return when local rows already exist. Non-destructive to proprietary rows.
- `src/routes/ai-registry.js`: new `GET /api/ai/routing/mode` and `PUT /api/ai/routing/mode` endpoints. The PUT validates against `VALID_MODES` and calls `setMode`. Broadcast of a `CUSTOM` `mode-switch` ag-ui event is deferred to Phase 4 (requires a global broadcaster — the current per-agent `state.responseClients` pattern doesn't cover the case of a setting change outside an active stream).
- `tests/migrations/0.3.2-seed-local-cascade.test.js` (new): 6 tests covering local-cascade seed coverage, cap-based ordering (qwen3-coder-next > qwen3-coder-30b on coding), proprietary-row preservation, mode isolation, idempotency.
- `tests/services/routing.test.js`: 9 new tests covering `getMode` defaults + fail-safe, `setMode` validation, mode-gated hard fallback (privacy assertion), mode-aware `generateCascade`, `_defaultConstraints` local-provider inclusion, `VALID_MODES` export.
- **Acceptance proven end-to-end** via fresh-install verification: ai_mode=proprietary routes conversation→claude-sonnet, coding→gpt-codex; flipping ai_mode=local routes conversation→local-gemma-4-31b, coding→local-qwen3-coder-next; flipping back restores cloud; emptying the local cascade under ai_mode=local returns `source='local_no_fallback'` with `backendId='local'` (never a cloud backend).
- **Status:** 350 tests pass (+15 from this PR). The one pre-existing `ignores agent override for jobs` failure from os8-3-1 is unchanged.

**`os8-3-3`: Tool-call synthesis + jobs escalation. (SHIPPED, partial)**
- `src/services/http-stream-synth.js` (new): pure-function module that translates OpenAI chat-completion SSE chunks into Claude-shape stream-json. State machine handles parallel tool calls (distinct `claudeBlockIndex` per OpenAI `tool_calls[i].index`), late-arriving `id`/`name`, fragmented `arguments` accumulation, and JSON-validation on close. Accumulator survives interleaved fragments across indices. Extracted from `createHttpProcess` for unit-testability.
- `cli-runner.js::createHttpProcess`:
  - New `opts.tools` — when non-empty, included in the request body alongside `tool_choice: 'auto'`.
  - SSE loop replaced with `HttpStreamSynth.processSSEChunk` per frame + `HttpStreamSynth.finalizeStream` at close.
  - Synthesized `message_start` (carrying `msg_local_*` id) emitted before the stream loop and `message_stop` after — gives `ClaudeTranslator` the lifecycle events its block-tracking expects.
  - On `state.parseFailure`, exits with `exitCode=1` and `stderr` prefixed `tool_call_parse_failed:` (escalation signal for the future jobs-escalation hook).
- `backend-events.js::createTranslator`: `case 'local'` routes to `ClaudeTranslator`. Now that the local backend emits Claude-shape stream-json, the existing translator emits `TOOL_CALL_START/ARGS/END/RESULT` ag-ui events for qwen3-coder turns just as it does for Claude Code's.
- `routing.js::nextInCascade(db, taskType, currentFamilyId, accessMethod, mode)`: returns the next enabled cascade entry under the current ai_mode, or `null` if the current entry is last/absent. Skips disabled rows; matches on (family_id, access_method) so login + API entries for the same family are distinguished.
- **Tests:**
  - `tests/services/http-stream-synth.test.js` — 13 tests covering text-only streams, single tool_call lifecycle, parallel tool_calls (interleaved fragments), text+tool_call mix, JSON-validation parse failures (malformed args, missing id/name), empty streams, idempotent finalize.
  - `tests/services/routing.test.js` — 5 new `nextInCascade` tests (next entry, end-of-cascade, unknown family, disabled-skip, access_method matching).

**Deferred (called out so we don't pretend it shipped):**
- **Skill catalog → OpenAI tool-spec converter.** The plan's `message-handler` populates `opts.tools` from the agent's pinned capabilities. Today no caller passes tools to `createHttpProcess`, so the synthesizer is exercised only in tests. Wiring the converter requires deciding which capability types (skill / api / mcp) become OpenAI function tools and how their input schemas map — bigger than os8-3-3's scope.
- **Message-handler escalation hook.** With no tools being passed yet, `tool_call_parse_failed` won't fire in practice. The signal (`stderr` prefix + `state.parseFailure`) and the routing primitive (`nextInCascade`) are both in place; wiring the catch + retry loop in `message-handler.js` is a one-screen follow-up once tools start flowing.
- **Tool execution loop.** Even when the model emits `tool_use` blocks, OS8's HTTP path doesn't currently execute the calls and feed results back into the conversation. CLI backends (Claude Code) do this internally; for HTTP, OS8 would need to route tool_calls back through its capability system. Out of os8-3-3's scope; tracked as a separate Phase-3.x or Phase-4 concern.

**Status:** 368 tests pass (+18 from this PR). Pre-existing `routing.test.js:194` failure (stale Phase-1 expectation) unchanged.

**`os8-3-4`: Vision. (SHIPPED, partial)**
- `package.json`: 0.3.2 → 0.3.3.
- `backend-adapter.js::local`: flipped `supportsImageInput: true`; added `supportsVisionForFamily(familyId, db)` that reads `ai_model_families.supports_vision` via AIRegistryService. Non-local backends don't define the helper (optional-chain returns `undefined`; existing flag-based checks unchanged).
- `cli-runner.js`:
  - New `buildUserContent(prompt, attachments)` helper (exported). Returns plain string when no attachments; otherwise an OpenAI multimodal content array with `image_url` parts followed by a `text` part. Skips malformed attachment entries defensively.
  - `createHttpProcess` accepts `opts.attachments` and uses `buildUserContent` for `messages[0].content`.
  - `createProcess` plumbs `attachments` (and `tools`) through to the HTTP path.
- `routing.js::maybeSwapForVision(db, resolved, hasAttachments)`: returns the resolved object unchanged unless (`ai_mode='local'`, attachments present, current family lacks vision, AND a vision-capable local family exists). Source becomes `'vision_override'`.
- `message-handler.js`:
  - `/send` (PTY-based) handler: pre-computes `_hasUserImageAtts` from incoming attachments; calls `maybeSwapForVision` before any attachment processing so the downstream support-flag check sees the swapped family. Updates the boolean check at line 135 (attachment read) and line 638 (dispatch) to use `(backend.supportsImageInput && (backend.supportsVisionForFamily?.(resolved.familyId, db) ?? true)) || backend.supportsImageViaFile`. Plumbs `attachments` into the `createProcess` call when the active backend is HTTP.
  - `/chat` (spawn-based) handler: same boolean-check + family-swap updates for the proprietary path. Note that the `/chat` path uses raw `spawn()` (not `createProcess`) and doesn't currently dispatch to local HTTP at all (`spawn(null,...)` would crash); that's a pre-existing limitation, unchanged here. Local conversations route through `/send`.
- **Tests:**
  - `tests/services/vision-dispatch.test.js` (new) — 10 tests: `buildUserContent` shape (text-only, single image, multiple images, defensive skip of malformed entries); `local.supportsVisionForFamily` (true/false/unknown family/missing args); flag invariants (local=true after flip; Claude/Codex/Gemini/Grok unchanged; no `supportsVisionForFamily` on non-local backends).
  - `tests/services/routing.test.js` — 5 new `maybeSwapForVision` tests: returns unchanged for no-attachments, proprietary mode, already-vision family, no-vision-family-exists; swaps under (local + attachments + non-vision current family).

**Honest deferrals:**
- **`/chat` HTTP support.** The pre-existing raw-spawn dispatch in the `/chat` path doesn't handle local backends. Out of os8-3-4 scope; local conversations work via `/send`.
- **End-to-end smoke test (PNG → model description).** Requires a running launcher with qwen3-6-35b-a3b serving. The unit tests cover the routing + body-shape correctness; live model verification is a manual acceptance step.

**Status:** 383 tests pass (+15 from this PR). Pre-existing `routing.test.js:194` failure unchanged.

**`os8-3-5`: TTS (Kokoro). (SHIPPED)**
- `package.json`: 0.3.3 → 0.3.4.
- `src/services/tts-kokoro.js` (new): matches `tts-openai.js`'s export surface (`PROVIDER_ID`, `API_KEY_ENV`, `DEFAULT_VOICES`, `DEFAULTS`, `getVoices`, `generateAudio`, `streamAudio`, `streamAudioChunked`, `getDefaultVoices`, `getWebSocketUrl`). `API_KEY_ENV=null` (no auth). Resolves the data-plane base URL from `LauncherClient.getCapabilities().tts` with a fallback to `localhost:8880` so freshly-started Kokoro responds before launcher state catches up. Voice-id helpers handle Kokoro's `<lang><gender>_<name>` convention (af_bella, am_adam, bf_emma...) into friendlier labels.
- `src/services/tts.js`:
  - `PROVIDERS` map extended with `kokoro`.
  - `isAvailable`: new null-`API_KEY_ENV` branch — local providers report `available: true` optimistically; the actual TTS call surfaces "launcher down" if Kokoro isn't serving. Settings UI can call `LauncherClient.isReachable()` separately for an honest preflight.
  - `getApiKey`: returns `null` for local providers (signals "no auth needed", not "missing key"). `getVoices` skips the API-key-missing throw when the provider declares no auth.
- **Tests (`tests/services/tts-kokoro.test.js`):** 17 tests covering module shape (export parity with tts-openai), voice-id helpers (humanize, category, labels, defensive paths), `getVoices` against mocked Kokoro-FastAPI responses (normalization, error handling, fallback to localhost:8880 when launcher unreachable), `generateAudio` (request body shape, default voice fallback, error surfacing), facade integration (`PROVIDERS.kokoro` present, `isAvailable` returns true without API key, `getApiKey` returns null for local).

**Honest deferrals:**
- **Auto-switch on `ai_mode` flip.** §4.4 sketches an auto-switch (when `ai_mode='local'`, switch to Kokoro; when flipping back, restore prior `tts_provider`). Not wired in this PR — the user picks Kokoro manually from settings. One-screen follow-up in os8-3-7 if the wire-up is desired.
- **Fish Speech.** Out of Phase-3 scope per the doc decision.

**Status:** 400 tests pass (+17 from this PR). Pre-existing `routing.test.js:194` unchanged.

**`os8-3-6`: Image gen via ComfyUI.**
- `imagegen.js`: `generateWithComfyUI`, family → comfyui provider mapping, `resolveImageProviders` respects mode.
- Workflow JSON templates in `src/services/comfyui-workflows/`.
- WS client or polling fallback for progress.
- **Test:** `POST /api/imagegen/generate {prompt: "red apple"}` under `ai_mode='local'` → PNG from ComfyUI on :8188.

**`os8-3-7`: Wire-up + registry.**
- `/api/skills/registry`: surface local capabilities with availability tied to `LauncherClient.getCapabilities()`.
- Verify `app.js::generateClaudeMd` auto-includes local capabilities (should already — capability system is source-agnostic).
- Manual STT regression check (item 8).
- **Test:** the seven acceptance criteria in §0.

Total: 7 PRs, independently reviewable, each leaves the tree green.

---

## 7. Out of Scope

Flagged for follow-up phases or sibling tracks:

- **Phase 4:** Onboarding fork ("Proprietary" vs "Local" with preflight check), per-agent `mode` override column, Settings UI for `ai_mode`, Settings panel for `tts_provider_local`.
- **Phase 5:** Model-discovery auto-sync from launcher config.yaml; "Running locally" badge; advanced-models panel; `docs/local-models.md`; capability-score re-tuning from eval data.
- **Fish Speech TTS.** Deferred until a voice-cloning use case lands. `tts-fish.js` can be added as a sibling to `tts-kokoro.js` with the same facade pattern.
- **Image-edit (Kontext) family.** Not in the 8 Phase-3 items. Seed row and workflow template deferred.
- **Video gen (Wan/FastWan).** Not in Phase 3 roadmap; out of scope.
- **Phase-1 leftover UI bugs** (`state.working` divergence, stale "Working…" on subconscious-direct path) — present; not introduced here; separate track.
- **Phase-2 oversight:** TTS/image paths don't call `ensureModel` today because those code paths predate Phase 2. Phase 3 fixes this inline (§4.4-4.6) rather than filing a Phase-2 follow-up — the inline fix is smaller than the cross-PR coordination.

---

## 8. Implementation Order at a Glance

```
┌─────────────────────────────────────────────────────────────────┐
│ os8-3-1  schema + family seeds + mode column   (invisible)      │
│ os8-3-2  resolver mode plumbing                 (mode flip works)│
│ os8-3-3  tool_calls synthesis + jobs escalation (qwen3-coder on) │
│ os8-3-4  vision                                 (multimodal on)  │
│ os8-3-5  TTS provider (kokoro)                  (tts on)         │
│ os8-3-6  image gen via ComfyUI                  (image on)       │
│ os8-3-7  registry wire-up + STT regression check (acceptance)    │
└─────────────────────────────────────────────────────────────────┘
```

Acceptance (§0) passes after `os8-3-7`. 3-3 through 3-6 are independent and can be parallelized if reviewers are available.
