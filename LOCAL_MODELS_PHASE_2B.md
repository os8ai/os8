# Local Models — Phase 2B: OS8-side ensureModel integration

**Status:** SHIPPED on `main` — see commit log. Doc kept as the executed-plan record.
**Companion to:** [LOCAL_MODELS_PHASE_2.md](LOCAL_MODELS_PHASE_2.md) (the full Phase-2 design — launcher half done) · [LOCAL_MODELS_PHASE_3.md](LOCAL_MODELS_PHASE_3.md) (Phase 3 shipped).
**Scope:** Wire OS8 to the launcher's `/api/serve/ensure` so the right model loads on demand. Closes the "launcher can only serve one thing" gap by using the now-multi-instance launcher correctly.
**Non-goals:** Onboarding fork (Phase 4), model-discovery polish (Phase 5).

This doc replaces the original `os8-2` and `os8-3` PR descriptions in `LOCAL_MODELS_PHASE_2.md` §8. Same intent, written against what actually shipped on the launcher (commits `8f23276..7246a06` on `os8-launcher@main`) rather than what was designed.

## 0. Acceptance

1. With `ai_mode='local'` and an agent pinned to `local-qwen3-coder-30b` (or `auto` resolving to it), sending a chat message **automatically loads qwen3-coder on the launcher if it isn't already serving**, then streams the response. No manual `./launcher serve` step required.
2. With multiple resident models active (e.g. Kokoro + Gemma), the launcher serves both concurrently and OS8 routes each task to the right backend port via `/api/serve/ensure`.
3. When ensure fails with `BUDGET_EXCEEDED` (VRAM full), the user sees a specific toast — not a generic "backend unavailable."
4. When the launcher is unreachable (`/api/health` 4xx/5xx/timeout), the user sees a specific "launcher offline" toast with a hint.
5. When a model takes 30+s to load, the UI shows a "Loading qwen3-coder, ~30s" inline banner while polling.
6. After every successful chat round, OS8 fires `POST /api/serve/touch {instance_id}` so the launcher's LRU eviction picks the right victims.

---

## 1. Already-done parts of original `os8-2` (don't re-do)

These bits landed earlier; verifying once before writing new code:

- ✅ `ai_model_families.launcher_model` + `launcher_backend` columns (Phase 3-1, schema.js + seeds.js).
- ✅ All seven local families have those columns populated (Phase 3-1 backfillLauncherMetadata).
- ✅ `local-status` endpoint reading capabilities from the launcher (Phase 3-7, routes/ai-registry.js).
- ✅ `createHttpProcess` synthesizes Claude-shape stream-json (Phase 1 + Phase 3-3 tool_calls).

What's left is the **routing-decision-to-launcher-call** wiring.

---

## 2. Inventory — what the launcher exposes today

Verified against `os8-launcher@main` (`7246a06`).

### 2.1 `POST /api/serve/ensure` — the key endpoint

Request:
```json
{ "model": "qwen3-coder-30b", "backend": "ollama", "wait": false }
```
- `model` (required) — the launcher's `models:` key in config.yaml. Maps to OS8's `ai_model_families.launcher_model`.
- `backend` (optional) — the launcher's `backends:` key. Maps to OS8's `ai_model_families.launcher_backend`. When omitted, launcher uses `model.default_backend`.
- `wait` (optional, default false) — when `true`, blocks up to the manifest's `health_timeout` and returns `ready`. When `false`, returns `loading` immediately for fresh starts; subsequent calls polled by re-calling ensure (idempotent).

Response (200):
```json
{
  "status": "ready" | "loading",
  "instance_id": "ollama-qwen3-coder-30b",
  "port": 11434,
  "base_url": "http://localhost:11434",
  "model": "qwen3-coder-30b",
  "backend": "ollama",
  "evicted": []
}
```
- `status: 'ready'` → already up + health endpoint responds 200; safe to POST `/v1/chat/completions` immediately.
- `status: 'loading'` → either fresh-start scheduled or another ensure is mid-start; caller should poll by re-calling ensure.
- `evicted` → instance_ids the launcher killed to make room (LRU). Useful for telemetry; harmless to ignore.

Errors:
| HTTP | `detail.code` | When |
|---|---|---|
| 400 | `(none — message only)` | Unknown model/backend (config validation) |
| 409 | `BUDGET_EXCEEDED` | VRAM full, no non-resident victims to evict |
| 500 | `START_FAILED` | Container/process failed to spawn |

Error body shape: `{"detail": {"code": "BUDGET_EXCEEDED", "message": "..."}}`. Note the FastAPI `detail` wrapper.

### 2.2 `POST /api/serve/touch`

Request: `{ "instance_id": "ollama-qwen3-coder-30b" }` · Response: `{ "touched": true|false }`. Fire-and-forget — unknown ids are no-ops. `false` just means the launcher already lost the instance (eviction race); not actionable from the OS8 side.

### 2.3 What we already use

- `GET /api/status/capabilities` — Phase 1's `createHttpProcess` calls this every request. Phase 2B replaces the use with ensure (which gives a more-authoritative answer in the same round-trip), but the endpoint stays useful for the local-status surface.
- `GET /api/health` — `LauncherClient.isReachable` already uses this.

---

## 3. Inventory — OS8 dispatch path today

### 3.1 Routing resolver returns

`RoutingService.resolve(db, taskType, agentOverride)` returns:
```js
{ familyId, backendId, modelArg, accessMethod, source }
```
**Missing for local backends:** `launcher_model`, `launcher_backend`. The resolver doesn't currently look them up, so callers can't pass them to ensure. This is the first thing 2B fixes.

### 3.2 Dispatcher (`createHttpProcess` in cli-runner.js)

Today's flow (lines 250-295):
1. `LauncherClient.getCapabilities()` — finds whatever model is currently serving for `taskType`.
2. `caps?.[taskType] || caps?.conversation` — picks the entry. If launcher isn't serving the right model, we get the wrong one OR null.
3. POSTs `/v1/chat/completions` to `entry.base_url`.

**Failure modes today:** "Launcher has no capability for task '<taskType>'" — exactly what the user hit when Bob was pinned to local-gemma but Kokoro was serving. The fix: replace step 1 with `ensureModel({model: launcher_model, backend: launcher_backend})` so we get the *right* model loaded, not just whatever happens to be running.

### 3.3 LauncherClient surface

`src/services/launcher-client.js` exposes: `getStatus`, `getCapabilities`, `listAvailableModels`, `isReachable`. **Missing:** `ensureModel`, `touch`, `getInstanceStatus`.

### 3.4 Message-handler hand-off

`message-handler.js:798` calls `createProcess(backend, args, { ..., model: agentModel, taskType: 'conversation' })`. `agentModel` is `resolved.modelArg`. **`resolved.launcher_model` and `resolved.launcher_backend` are not threaded through** — they don't exist on `resolved` today (per §3.1).

---

## 4. Changes — file by file

### 4.1 `src/services/routing.js` — extend `resolve()` to carry launcher metadata

For local-container families, populate `launcher_model` and `launcher_backend` on the returned object. For non-local, leave them undefined (downstream code branches on their presence).

```js
// In resolve() — after picking the family:
const isLocal = family.container_id === 'local';
return {
  familyId, backendId, modelArg, accessMethod, source,
  ...(isLocal ? {
    launcher_model: family.launcher_model,
    launcher_backend: family.launcher_backend
  } : {})
};
```

Touch points: agent-override path (line 50-66), cascade path (line 78-86), local-no-fallback path (line ~100-108), proprietary fallback (line ~115-122 — leaves the new fields off). `maybeSwapForVision` already returns local families — extend its return shape too.

Tests: extend `tests/services/routing.test.js` to assert that a local family resolution carries the two new fields, and that proprietary resolutions don't.

### 4.2 `src/services/launcher-client.js` — add `ensureModel` + `touch`

```js
async ensureModel({ model, backend, wait = false, baseUrl = DEFAULT_BASE }) {
  const res = await fetch(`${baseUrl}/api/serve/ensure`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, backend, wait })
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const code = body?.detail?.code || (res.status === 400 ? 'BAD_REQUEST' : `HTTP_${res.status}`);
    const message = body?.detail?.message || body?.detail || `${res.status} ${res.statusText}`;
    const err = new Error(message);
    err.code = code;
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async touch(instanceId, baseUrl = DEFAULT_BASE) {
  // Fire-and-forget: failures are silenced (the launcher might be down,
  // the eviction race might already have happened — neither is actionable).
  try {
    await fetch(`${baseUrl}/api/serve/touch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instance_id: instanceId })
    });
  } catch (_e) { /* swallow */ }
}
```

`getInstanceStatus` is **not needed** — re-calling `ensureModel` is the cheaper polling primitive (idempotent, gives the same `{status, port}` shape).

Add a small `LAUNCHER_ERROR_CODES` enum-ish exports for downstream pattern-matching: `LAUNCHER_UNREACHABLE`, `MODEL_NOT_DOWNLOADED`, `BUDGET_EXCEEDED`, `START_FAILED`, `BAD_REQUEST`.

### 4.3 `src/services/cli-runner.js` — replace getCapabilities with ensure

In `createHttpProcess`'s `_runHttp`, replace lines 251-265 (the getCapabilities lookup) with:

```js
// Resolve which launcher model + backend to ensure. For families that
// pre-date the launcher_model column, fall back to the OS8-side modelArg
// (matches the Phase 1 behavior).
const launcherModel = backend.launcher_model_for?.(model) || model;
const launcherBackend = backend.launcher_backend_for?.(model) || null;

let ensureResult;
try {
  ensureResult = await LauncherClient.ensureModel({ model: launcherModel, backend: launcherBackend });
} catch (err) {
  if (err.code === 'BUDGET_EXCEEDED' || err.code === 'START_FAILED') {
    // Surface the launcher's specific code so message-handler can route
    // to the right toast — see §4.5 for the stream_event shape.
    finish({ exitCode: 1, stderr: `launcher_error:${err.code}: ${err.message}` });
    return;
  }
  // Default: launcher unreachable or other transport error.
  finish({ exitCode: 1, stderr: `launcher_error:LAUNCHER_UNREACHABLE: ${err.message}` });
  return;
}

// Poll if loading. Re-calling ensure is idempotent and returns the same
// shape; polls every 1s up to a 60s ceiling (model-loading covers most
// real launches; truly long ones like NIM should use wait=true).
let baseUrl = ensureResult.base_url;
const instanceId = ensureResult.instance_id;
if (ensureResult.status === 'loading') {
  emitLine({ type: 'stream_event', event: { type: 'system_status', code: 'model_loading', model: launcherModel } });
  const start = Date.now();
  while (Date.now() - start < 60_000) {
    if (aborted) return;
    await new Promise(r => setTimeout(r, 1000));
    try {
      const poll = await LauncherClient.ensureModel({ model: launcherModel, backend: launcherBackend });
      if (poll.status === 'ready') { baseUrl = poll.base_url; break; }
    } catch (_e) { /* keep polling — transient */ }
  }
  if (!baseUrl) {
    finish({ exitCode: 1, stderr: 'launcher_error:MODEL_LOAD_TIMEOUT: model did not become ready in 60s' });
    return;
  }
}
const modelId = model || ensureResult.model;
```

Threading `launcher_model` / `launcher_backend` from message-handler: extend `createProcess`'s opts:
```js
function createProcess(backend, args, { ..., launcherModel, launcherBackend }) { ... }
```
Pass through to `createHttpProcess({ ..., launcherModel, launcherBackend })`.

After the chat completion finishes successfully, fire touch:
```js
LauncherClient.touch(instanceId).catch(() => {});
```
(in the result-emission path, not awaited — fire and forget)

### 4.4 `src/services/cli-runner.js` — same treatment for `sendTextPromptHttp`

The non-streaming path at line 617+. Same ensure-then-fetch pattern, no polling banner (it's used for short utility calls — if the model isn't ready, just throw).

### 4.5 `src/assistant/message-handler.js` — thread launcher fields

At the `createProcess` call site (line 821), add:
```js
launcherModel: resolved.launcher_model,
launcherBackend: resolved.launcher_backend,
```

For the `/chat` path (raw spawn at line 1696), no changes — local families don't go through that path today (pre-existing limitation flagged in Phase 3-4).

Error code surfacing: at the cli-runner exit handler, when `stderr` starts with `launcher_error:`, parse the code and pass it forward via the existing SSE error path with a structured `{code, message}` payload instead of raw text. The Chat.jsx side then matches on the code (see §4.6).

### 4.6 `src/templates/assistant/src/Chat.jsx` — error toasts (originally `os8-3`)

Map launcher error codes to readable toasts. The current "backend unavailable" generic toast becomes:

| `code` | Toast copy |
|---|---|
| `LAUNCHER_UNREACHABLE` | "os8-launcher isn't running. Start it from the launcher dashboard." |
| `MODEL_NOT_DOWNLOADED` | "Model weights aren't downloaded. Run `./launcher download <model>` or use the dashboard's Models tab." |
| `BUDGET_EXCEEDED` | "VRAM full. Stop an idle model or shrink the resident set in launcher config." |
| `START_FAILED` | "Backend crashed during start — see launcher logs." |
| `MODEL_LOAD_TIMEOUT` | "Model didn't become ready in 60s. Check the launcher dashboard's running tab." |
| `(other)` | Existing generic copy. |

Plus inline "Loading <model>, this may take a moment" banner when a `system_status` `code: 'model_loading'` event arrives, auto-dismissed when streaming starts or the load times out.

---

## 5. Tests

- `tests/services/launcher-client.test.js` (new): mock fetch, assert `ensureModel` parses success payload (200), throws Error with `.code` on 409/500, throws `LAUNCHER_UNREACHABLE`-coded error on network error. `touch` swallows failures.
- `tests/services/routing.test.js` (extend): resolver returns `launcher_model`/`launcher_backend` on local families, omits on proprietary.
- `tests/services/cli-runner-http-ensure.test.js` (new): mock LauncherClient + fetch, exercise:
  - ready-on-first-call: ensure returns ready → fetch → result emitted → touch fired.
  - loading→ready: ensure returns loading, second poll returns ready → result emitted.
  - load timeout: 60 polls all return loading → finish with MODEL_LOAD_TIMEOUT.
  - BUDGET_EXCEEDED: ensure throws → finish with stderr `launcher_error:BUDGET_EXCEEDED:...`.
  - LAUNCHER_UNREACHABLE: ensure throws fetch error → finish with that code.

No live launcher needed for any of these — pure mocked-fetch tests, same pattern as `tts-kokoro.test.js`.

---

## 6. Open questions

1. **Polling cadence + ceiling.** §4.3 picks 1s polls × 60s ceiling. For NIM models (30-60 min cold start) that's wildly insufficient. Two options: (a) keep 60s and tell users to use `./launcher serve` for NIMs, (b) escalate to `wait=true` after the first poll fails so the launcher does the long wait server-side. **Reco: (a) for now.** NIM is the only model that needs >60s; out of common path. If we add NIM use we revisit.

2. **Touch on every successful round, or sample?** Every round = correct LRU signal but adds an HTTP per turn. Sampling = fewer round-trips but coarser LRU. **Reco: every round.** It's already fire-and-forget; ~1ms localhost.

3. **Rolled-into-2B vs split os8-3 (toasts).** Original plan: separate PRs. Today: the wire-up needs the error codes to even land in stderr, so they're actually coupled. **Reco: one PR ("os8-2b") with both pieces.** The diff is moderate but coherent.

4. **Should we surface `evicted` in the UI?** When an ensure call evicts another model, the user might want to know "we stopped X to start Y." **Reco: log it but no UI surface** for now. Add an info-level toast in Phase 5 polish if it turns out to matter.

---

## 7. Commit sequence

Single commit, since the pieces are tightly coupled and one PR is easier to review than three small ones that don't compose.

**`os8-2b`: ensureModel integration + error UX**
- `package.json` 0.3.10 → 0.3.11.
- `src/services/launcher-client.js`: add `ensureModel`, `touch`, `LAUNCHER_ERROR_CODES`.
- `src/services/routing.js`: resolver returns `launcher_model`/`launcher_backend` on local families.
- `src/services/cli-runner.js`: `createHttpProcess` + `sendTextPromptHttp` use ensure → poll → fetch → touch. Threads `launcherModel`/`launcherBackend` through `createProcess`.
- `src/assistant/message-handler.js`: pass `resolved.launcher_model`/`launcher_backend` into `createProcess`.
- `src/templates/assistant/src/Chat.jsx`: map error codes to readable toasts, add "loading model" inline banner.
- `tests/services/launcher-client.test.js` (new), `tests/services/cli-runner-http-ensure.test.js` (new), routing test extension.
- LOCAL_MODELS_PHASE_3.md §10 updated to mark os8-2 as DONE.

**Estimated scope:** ~300-400 lines added (most of it in cli-runner.js and Chat.jsx), ~40 lines deleted (the old getCapabilities lookup). One commit, one push.

---

## 8. What this unlocks

After 2B lands, the day-to-day local-mode story works:

- User flips `ai_mode='local'` (still via SQL until Phase 4 adds the toggle).
- Sends a chat message to an agent on auto-routing.
- OS8 picks the local family from the cascade.
- `ensureModel` loads the right model on the launcher (with LRU eviction if needed).
- Chat streams back through the local backend.
- Per-app Kokoro TTS keeps working concurrently because the launcher serves both.
- Same agent in the same session can produce an image — `imagegen.js` calls ensure → ComfyUI loads → image generated.

**This is the moment local mode becomes usable.** Phase 4 is then about making it discoverable (UI mode toggle, onboarding fork); Phase 5 is polish on top.
