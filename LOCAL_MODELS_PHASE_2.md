# Local Models — Phase 2: Concurrent Serving (Resident Pool)

**Status:** Design doc, pre-implementation.
**Companion to:** [LOCAL_MODELS_PLAN.md](LOCAL_MODELS_PLAN.md) (v1.2 — Phase 1 shipped).
**Scope:** Make `os8-launcher` serve N backends simultaneously; teach OS8 to demand-request and reuse them.
**Non-goals:** TTS/image/vision/tool_calls (Phase 3); onboarding fork + per-agent mode UI (Phase 4); model-discovery sync + polish (Phase 5).

## 0. Acceptance

From the roadmap: *"chat + code + TTS + image all warm simultaneously; switching between tasks is instant."*

Concrete exit criteria for Phase 2:

1. Start Gemma-4-31B (vLLM, port 8000) **and** Qwen3-coder-30B (ollama, port 11434) simultaneously via `POST /api/serve/ensure`. `GET /api/status` lists both. `GET /api/status/capabilities` surfaces both.
2. Start a **second vLLM instance** (e.g. Qwen3-coder-next alongside Gemma) — port allocator assigns it port 8001, container name `os8-vllm-qwen3-coder-next`, and state.yaml records both under distinct `instance_id`s.
3. OS8 agent pinned to `local-qwen3-coder-30b` can send a message while an agent pinned to `local-gemma-4-31b` is mid-stream. No interference, no restart, no "backend busy" error.
4. Under VRAM pressure (sum of resident `size_gb` > `resources.memory_budget_gb`), requesting a new non-resident backend evicts the LRU non-resident instance and starts the requested one. Resident instances are never evicted.
5. `/api/serve/ensure` is idempotent — calling twice back-to-back for the same `(model, backend)` pair never starts two instances, regardless of whether the first is `ready` or still `loading`.

---

## 1. Inventory: Current Single-Backend Assumptions

Walking the code as of `os8-launcher` commit `59eca3d` and `os8` commit `9436fa6`. File:line refs verified against the working tree.

### 1.1 State schema — singular by design

`src/state.py:34-62` — `set_backend()` writes `data["backend"] = {...}` (a single dict under a singular key). `clear_backend()` pops that exact key. Only one backend can ever live in state.

`src/state.py:144-170` — `validate_state()` does a one-off liveness check on `data.get("backend")`; no loop.

**By contrast:** `state["clients"]` is already a dict keyed by name (`state.py:65-83`), with per-entry liveness in `validate_state()`. That structure is the template for the new backend schema — we generalize existing clients semantics to backends rather than inventing something new.

### 1.2 Lifecycle — explicit "only one" guard

`src/backends.py:538-544` — hard raise:

```python
state = validate_state()
if "backend" in state:
    b = state["backend"]
    raise BackendError(
        f"{b['name']} is already serving {b['model']} on port {b['port']}.\n"
        f"Run ./launcher stop first."
    )
```

This is *the* single-backend gatekeeper. Removing it is Phase 2's first domino.

`src/backends.py:587-591` — port collision check uses the live `BackendConfig.port` (post-override from `settings.yaml`) with `check_port()`. It only knows the declared default for the backend kind — not that there might be another instance of the same kind running on a neighbor port. For two vLLM instances, both would try 8000 and the second would unconditionally fail.

`src/backends.py:643-649` — Docker container name hardcoded to `os8-{backend_name}`. Same collision for two vllm instances. Same for the log streamer at line 649 and `container_log_path()` at line 306 (`{backend_name}.log`).

`src/backends.py:695-703` — `set_backend(name=backend_name, ...)` writes a single state entry keyed by backend kind. If called twice, the second overwrites the first — silent data loss.

`src/backends.py:750-798` — `stop_backend()` takes **no arguments**. It operates on whatever is in `state["backend"]`. There's no notion of "which instance."

`src/backends.py:866-895` — `get_status_data()` returns `{"backend": {...}|None, "clients": {...}}` — the wire shape of `GET /api/status`.

### 1.3 API shape — singular backend in the payload

`src/api.py:377-380` — `GET /api/status` serializes `get_status_data()` as-is, so the wire shape propagates the `backend: {...} | null` singularity.

`src/api.py:382-421` — `GET /api/status/capabilities`:
- Reads `data.get("backend")` (singular).
- Maps that single model name through a hardcoded 2-entry `eligibility` dict to pick task types.
- Returns `{task_type: {model, base_url, model_id}}` where every task points at the same port.

This is the shape OS8's `createHttpProcess` currently consumes; changing it is a breaking change on the wire unless we keep backward-compat for the Phase-1 reader.

`src/api.py:471-494` — `DELETE /api/serve` (stop-all) and `DELETE /api/backend` (stop-only-backend) don't take a target; they can't because there's only ever one to stop.

### 1.4 Port model — per-kind, not per-instance

`src/config.py:53-63` — `BackendConfig` has `port` (live) and `default_port` (value declared in config.yaml). These are attributes of *the backend kind* (`vllm`, `ollama`, …), not of a running instance.

`src/settings.py:30-48` — `port_overrides` is a flat `{backend_kind_name: port}` dict. The Ports tab (`/api/ports`, shipped in `59eca3d`) writes to it keyed by backend kind. User override here means "when I start vllm, use port 8001 instead of 8000" — it does **not** mean "the second vllm instance I start uses 8002."

`src/runtime.py:35-41` — `check_port()` is a one-shot busy probe; no allocator, no range scan.

**Latent collision in `config.yaml` today:** `llamacpp` and `fish-speech` both declare port 8080. Running them simultaneously already doesn't work. Phase 2's allocator incidentally fixes that.

### 1.5 OS8 client wiring

`src/services/launcher-client.js:27-59` — `LauncherClient` exposes `getStatus`, `getCapabilities`, `listAvailableModels`, `isReachable`. No `ensureModel`, no `touch`. `baseUrl` points at launcher control plane (`localhost:9000`); individual backend data-plane URLs come from `/api/status/capabilities` dynamically. Good separation — Phase 2 keeps it.

`src/services/cli-runner.js:223-388` — `createHttpProcess` calls `LauncherClient.getCapabilities()` on **every** request, picks `caps?.[taskType] || caps?.conversation`, and POSTs to `entry.base_url/v1/chat/completions`. The crucial assumption: *the right model is already serving.* If it isn't — or if it's serving but not the model the agent's family resolved to — OS8 silently talks to the wrong model or 404s.

`src/services/cli-runner.js:570-596` — `sendTextPromptHttp` duplicates the same capability lookup for non-streaming paths. Same issue.

`src/services/backend-adapter.js:548-621` — `local` backend entry, OpenAI-shaped parsers. No changes needed for Phase 2 — the data plane contract is unchanged.

`src/services/routing.js` — per Phase-1 shipped notes, `isAvailable` short-circuits `type === 'http'` past provider/API-key gating. That's fine. Cascade behavior on a runtime ensure-failure needs a verification pass (see §6.3 open questions).

---

## 2. Data-Structure Changes (before/after)

### 2.1 `state.yaml` on disk

**Before:**

```yaml
backend:
  name: vllm
  model: gemma-4-31B-it-nvfp4
  port: 8000
  pid: null
  container_id: 4a7f…
  install_type: container
  health_path: /v1/models
  start_time: 2026-04-18T22:14:03
clients:
  os8:
    port: 8000
    ready: true
    …
```

**After:**

```yaml
backends:
  vllm-gemma-4-31B-it-nvfp4:          # instance_id (key)
    backend: vllm                     # backend kind
    model: gemma-4-31B-it-nvfp4
    port: 8000
    container_id: 4a7f…
    install_type: container
    health_path: /v1/models
    container_name: os8-vllm-gemma-4-31B-it-nvfp4
    log_path: var/backends/vllm-gemma-4-31B-it-nvfp4.log
    start_time: 2026-04-18T22:14:03
    last_used: 2026-04-19T09:02:11    # updated by /api/serve/touch; defaults to start_time
    resident: true                    # pinned by the resident: config; never evicted
  ollama-qwen3-coder-30b:
    backend: ollama
    model: qwen3-coder-30b
    port: 11434
    …
clients:
  …                                   # unchanged
```

Rationale for the schema: the existing `clients` dict-keyed-by-name pattern extends cleanly. `instance_id` is `{backend_kind}-{model_slug}` — deterministic, so idempotent ensure is a simple dict lookup. `container_name` is stored explicitly (rather than reconstructed) so rename schemes (see §4) don't break stop/eviction.

**Legacy-read compatibility:** on first load after upgrade, if `state["backend"]` exists (old schema), migrate it to `state["backends"][instance_id]` and drop the singular key. One-liner in `load_state()`; no persistent compat burden.

### 2.2 `/api/status` wire shape

**Before:**

```json
{
  "backend": { "name": "vllm", "model": "…", "port": 8000, "health": "healthy", … } | null,
  "clients": { "os8": {…} }
}
```

**After:**

```json
{
  "backends": [
    {
      "instance_id": "vllm-gemma-4-31B-it-nvfp4",
      "backend": "vllm",
      "model": "gemma-4-31B-it-nvfp4",
      "port": 8000,
      "base_url": "http://localhost:8000",
      "health": "healthy",
      "uptime": "12m 4s",
      "resident": true,
      "last_used": "2026-04-19T09:02:11"
    },
    { "instance_id": "ollama-qwen3-coder-30b", … }
  ],
  "clients": { … },
  "budget": { "memory_gb": 100, "reserved_gb": 49, "instances": 2 }
}
```

**Back-compat shim for Phase-1 consumers:** also emit `backend:` set to the most-recently-started entry (or `null` if empty). Remove in Phase 3 once OS8 fully consumes the array. This costs us one line in `get_status_data()` and buys us a smaller blast radius.

### 2.3 `/api/status/capabilities` wire shape

Today's Phase-1 shape maps each task → a single `{model, base_url, model_id}`. With N backends, a given task can have multiple candidates.

**Before:**

```json
{
  "conversation": { "model": "gemma-…", "base_url": "http://localhost:8000", "model_id": "gemma-…" },
  "summary":      { "model": "gemma-…", "base_url": "http://localhost:8000", "model_id": "gemma-…" },
  "planning":     { "model": "gemma-…", "base_url": "http://localhost:8000", "model_id": "gemma-…" }
}
```

**After:**

```json
{
  "conversation": [
    { "instance_id": "vllm-gemma-4-31B-it-nvfp4", "model": "gemma-…", "base_url": "http://localhost:8000", "model_id": "gemma-…", "priority": 0 }
  ],
  "coding": [
    { "instance_id": "ollama-qwen3-coder-30b", "model": "qwen3-coder-30b", "base_url": "http://localhost:11434", "model_id": "qwen3-coder:30b", "priority": 0 }
  ],
  "tts": [ … ],
  "image-gen": [ … ]
}
```

Array, because (a) multiple resident instances can serve the same task (e.g. Gemma-4-31B *and* Nemotron-120b both for conversation), (b) OS8 can use priority to pick, and (c) Phase 2's `/api/serve/ensure` bypasses this lookup entirely — capability is a discovery aid, not a decision surface.

**Back-compat consideration:** Phase-1 OS8 consumes `caps?.[taskType]` as an object. If Phase 2 launcher ships before OS8 migrates, Phase-1 OS8 would see an array and `entry.base_url` would be `undefined`. Two options:
- (a) ship OS8 first so the consumer is array-tolerant before the launcher flips.
- (b) the launcher emits the object shape when exactly one backend is running for a given task and the array shape otherwise.

Prefer (a) — cleaner contract, PR ordering is flexible anyway (see §7).

### 2.4 `config.yaml` — new top-level keys

```yaml
resources:
  memory_budget_gb: 100        # soft cap for sum of running model.size_gb + KV margin
  kv_margin_gb: 10             # flat reservation per instance for KV cache + overhead
  auto_start_resident: true    # on launcher boot, start the resident set

resident:
  - chat                       # role names; resolved per §4.3
  - coder
  - tts
  - image-gen
```

`resident` is a list of **roles**, not model names, so a user swapping their preferred chat model doesn't have to touch both `models:` and `resident:`. Role → model mapping lives in a small table in `config.yaml` too (see §4.3).

### 2.5 OS8 `ai_families` schema

Two new nullable columns:

```sql
ALTER TABLE ai_families ADD COLUMN launcher_model TEXT;   -- matches config.yaml models.<key>
ALTER TABLE ai_families ADD COLUMN launcher_backend TEXT; -- matches config.yaml backends.<key>, optional
```

Backfill: set `launcher_model = 'gemma-4-31B-it-nvfp4'`, `launcher_backend = 'vllm'` on the existing `local-gemma-4-31b` row. New seed rows for `local-qwen3-coder-30b`, `local-qwen3-coder-next`, etc. (families only — routing them into cascades is Phase 3).

---

## 3. `POST /api/serve/ensure` Contract

Idempotent "make sure this model is up" endpoint.

### 3.1 Request

```json
{
  "model": "gemma-4-31B-it-nvfp4",
  "backend": "vllm",            // optional; defaults to model.default_backend
  "wait": false                 // optional; if true, block until healthy up to health_timeout
}
```

### 3.2 Response — instance already up

```json
{
  "status": "ready",
  "instance_id": "vllm-gemma-4-31B-it-nvfp4",
  "port": 8000,
  "base_url": "http://localhost:8000",
  "model": "gemma-4-31B-it-nvfp4",
  "backend": "vllm"
}
```

### 3.3 Response — load kicked off (`wait=false`, default)

```json
{
  "status": "loading",
  "instance_id": "vllm-gemma-4-31B-it-nvfp4",
  "port": 8000,                 // pre-assigned; not yet bound
  "base_url": "http://localhost:8000",
  "model": "gemma-4-31B-it-nvfp4",
  "backend": "vllm",
  "eta_seconds": 45,            // derived from last successful load; null if first-ever
  "eviction": {                 // present only if an eviction was triggered
    "evicted_instance_id": "vllm-some-other-model",
    "reason": "budget"
  }
}
```

The caller polls `GET /api/status` (or `GET /api/serve/{instance_id}/status`, see §3.6) every 1–2 s until `health: healthy`, then proceeds.

### 3.4 Response — load kicked off (`wait=true`)

Blocks for up to `manifest.health_timeout` seconds (already 900 s default, 30–60 min for NIM). On success, returns the `ready` payload above. On timeout, returns `502` with the same body structure plus `"status": "timeout"`.

### 3.5 Error responses

| HTTP | `status` | `code`                   | Trigger |
|------|----------|--------------------------|---------|
| 400  | `error`  | `UNKNOWN_MODEL`          | Model not in config.yaml |
| 400  | `error`  | `MODEL_NOT_COMPATIBLE`   | Model lists backend but can't run on it |
| 404  | `error`  | `MODEL_NOT_DOWNLOADED`   | Weights missing on disk (and backend not daemon-pull) |
| 409  | `error`  | `BUDGET_EXCEEDED`        | Can't fit; no non-resident instance evictable |
| 500  | `error`  | `START_FAILED`           | Container/process failed to spawn; includes last log tail |
| 503  | `error`  | `LAUNCHER_BUSY`          | Another ensure for same instance is mid-start (race) — caller should retry |

All error responses include `{"status":"error","code":"…","message":"…"}`.

### 3.6 Idempotency semantics

- `instance_id = f"{backend}-{model}"` is deterministic. Ensure always resolves to the same key for the same request.
- Concurrent ensures for the same `instance_id`: first one kicks off load, later ones observe state (`loading`) and return `{status:"loading", …}` without starting a second process. Implemented via a per-instance asyncio lock in `backends.py`.
- Ensure for a *different* model on the same backend kind: allocator assigns a new port, creates a second instance. No serialization needed (two vLLM processes on two ports coexist fine).
- Ensure for a model already at `ready`: pure state lookup, ~1 ms response.
- Ensure for a model whose last load **failed** and is now absent from state: retries the start (same as a fresh ensure).

### 3.7 Conflict: port in use but state.yaml thinks it's free

Example: user manually ran `vllm` outside the launcher on port 8000. Launcher wants to start its own vllm instance on 8000.

- `check_port(8000)` returns True (busy).
- Allocator treats it as an external squatter — skips to 8001, 8002, … until free.
- **We do not kill the squatter.** Aggressive reclamation would clobber a user's manual `vllm serve`.
- The squatter is invisible in `GET /api/status` (launcher only reports what it started). The Ports tab's existing "in use by something else" hint already surfaces this to the user.

### 3.8 Conflict: long load in progress, second request for a *different* model via same backend

vLLM instances are one-model-per-process. Two different models → two separate vLLM processes on two ports. The allocator handles it; no need to queue. Both loads can proceed in parallel (constrained only by `memory_budget_gb`).

---

## 4. Port Allocator

### 4.1 Resolution order (highest wins)

1. **Instance-specific user override** — `settings.yaml::port_overrides.<instance_id>` (e.g. `vllm-gemma-4-31B-it-nvfp4: 9100`). This slot is new in Phase 2; today's Ports tab only writes per-kind keys.
2. **Per-kind user override** — `settings.yaml::port_overrides.<backend_kind>` (e.g. `vllm: 8001`). The existing Ports-tab-managed key, wins for the *first* instance of that kind.
3. **Declared default** — `BackendConfig.default_port` from `config.yaml`.
4. **Next-free scan** — `range(default_port + 10, default_port + 100)` scanned with `check_port()`. If all 90 probes are busy, raise `NoFreePortError`.

The +10 offset is to leave a visible gap between the declared default and allocator-assigned siblings, so a user looking at `lsof -i` can tell which port was "the one they configured" vs which was "the allocator's pick."

### 4.2 Composition with the Ports tab

The Ports tab (`/api/ports`) already reads/writes per-kind overrides. Phase 2 leaves those semantics intact — they remain "the preferred first port for instances of this kind." The tab's UI strings should be tightened from *"vLLM will use port 8001"* to *"vLLM's first instance will use port 8001"* but that copy change is optional Phase 2 polish (and doesn't require an API change).

Per-instance overrides (priority 1 above) are exposed by Phase 2 *only via settings.yaml*; adding a UI for it is a Phase-3/4 concern once there's a routine use case.

### 4.3 Resident role → model resolution

`resident: [chat, coder, tts, image-gen]` gets resolved via a new `roles:` section in `config.yaml`:

```yaml
roles:
  chat:       { model: gemma-4-31B-it-nvfp4, backend: vllm }
  coder:      { model: qwen3-coder-30b, backend: ollama }
  tts:        { model: kokoro-v1, backend: kokoro }
  image-gen:  { model: flux1-schnell, backend: comfyui }
  vision:     { model: qwen3-6-35b-a3b, backend: vllm }
```

Each role maps to exactly one model. On launcher boot, if `auto_start_resident: true`, each role listed in `resident:` gets an `ensure(model, backend)` call dispatched in parallel. Each resident instance is marked `resident: true` in state.yaml — permanently ineligible for LRU eviction until removed from the list and launcher restarted.

### 4.4 How OS8 learns the port

**Primary path:** `/api/serve/ensure` response carries `port` and `base_url`. OS8's `ensureModel()` wraps ensure and returns `{base_url, instance_id}` directly — no follow-up `/api/status` round-trip needed. Minimum latency for the happy path (already ready): 1 request, ~1–2 ms.

**Fallback path:** `/api/status/capabilities` continues to work for discovery (e.g. "what models are available right now for task X?"). OS8 uses it only for the home-screen "local models" indicator; per-request flows go through ensure.

**No push model.** SSE/websocket push from launcher to OS8 is overkill for Phase 2 — OS8 queries on demand, and the ensure response is authoritative. Keep the wire surface small.

---

## 5. LRU Eviction

### 5.1 What "VRAM budget" means on unified memory

DGX Spark shares 128 GB between CPU and GPU (one physical pool). "VRAM budget" is not a hardware concept here — it's a **soft policy** the launcher self-enforces so a well-intentioned sequence of ensures doesn't OOM the host.

Two measurement options:

- **(a) Sum of `model.size_gb`** from config.yaml for every running instance + flat `kv_margin_gb` per instance.
  - Pros: deterministic, predictable, testable without hardware.
  - Cons: ignores real memory-use drift (KV grows with context; model file size ≠ loaded tensor size for some formats).

- **(b) Poll `nvidia-smi --query-gpu=memory.used`** (or NVML) on Spark.
  - Pros: ground truth.
  - Cons: flaps under steady-state load; multiple decision makers racing on a fluctuating reading causes eviction thrash.

**Decision:** use (a) as the authoritative admission model. Report (b) as informational (`/api/status.budget.observed_gb`) but don't let it drive decisions in Phase 2. If Phase 3 surfaces need for reality-checks, we swap in a hysteresis-filtered (b).

Concretely, for a proposed new instance with `size_gb = S`:

```
reserved = sum(i.model.size_gb + kv_margin_gb for i in running_instances)
would_reserve = reserved + S + kv_margin_gb
if would_reserve <= memory_budget_gb: admit
else: try LRU eviction
```

### 5.2 LRU mechanics

- **Touch signal.** OS8 calls `POST /api/serve/touch {instance_id}` after a successful stream. Launcher updates `state.backends[id].last_used = now()`. Cheap fire-and-forget, no-op if launcher is down. If the touch endpoint is never called (e.g. a direct `/v1/chat/completions` consumer bypassing OS8), `last_used` stays at `start_time` — still a coherent LRU ordering, just coarser.
- **Eviction candidate set** = `running_instances - resident_instances - {requested_instance}`. Never evict a resident, never evict the target of the current ensure.
- **Pick** the candidate with the oldest `last_used`. Ties broken by oldest `start_time`.
- **Stop** it synchronously (reusing today's `_stop_backend_inner`). Container stop's 45s timeout applies.
- **Loop** until `would_reserve <= memory_budget_gb` or the candidate set is empty.
- If the candidate set empties out and the new instance still doesn't fit, **fail with `BUDGET_EXCEEDED`**. No "wait for free space" — Phase 2 fails fast; queuing is a later concern.

### 5.3 Blocking vs pre-start

- **On-demand only in Phase 2.** Ensure starts an instance if it isn't already up. No speculative pre-starts based on "we think you'll ask for this."
- **Resident set auto-starts on launcher boot** (if `auto_start_resident: true`). This is the only pre-start. Not done serially — run each ensure in a background task and let them race for VRAM; the usual admission logic sorts it out. Defensive: sort the resident ensures by `size_gb` descending so the big models get first claim on budget.
- **Ensure itself is non-blocking by default** (`wait=false`). OS8 decides whether to poll or show a "loading…" toast and give up early. The launcher's admission decision is synchronous, but the load + health check happen in a background task — the request returns in ≤100 ms barring a pathologically slow stop-all during eviction.

### 5.4 Race: ensure-A in budget-check while ensure-B has just admitted

The budget calculation and the `set_backend` write need to be atomic. Implementation: a single `_ensure_lock` (module-level `threading.Lock` around the admit-and-reserve critical section in `backends.py`). Per-instance locks (§3.6) compose inside it. Doesn't serialize actual load time (which happens in a background task *after* the reservation is made), so throughput is fine.

---

## 6. OS8-Side Changes

### 6.1 `LauncherClient` additions

```js
// src/services/launcher-client.js
async ensureModel({ model, backend, wait = false, baseUrl = DEFAULT_BASE }) { … }
async touch(instanceId, baseUrl = DEFAULT_BASE) { … }         // fire-and-forget
async getInstanceStatus(instanceId, baseUrl = DEFAULT_BASE) { … }  // polling helper
```

`ensureModel` maps to `POST /api/serve/ensure`. `touch` maps to `POST /api/serve/touch`. Both are thin HTTP wrappers — business logic stays in cli-runner.

### 6.2 `createHttpProcess` flow (cli-runner.js)

Currently (Phase 1) the flow is:
1. `getCapabilities()` → pick `caps[taskType]`.
2. `fetch(base_url/v1/chat/completions)`.

Phase 2 becomes:

```
0. Resolve family → {launcher_model, launcher_backend} via a new helper
   (looks up the ai_families row, passed in via resolved.familyId).
1. LauncherClient.ensureModel({ model: launcher_model, backend: launcher_backend })
   2a. status === 'ready'  → use returned base_url (FAST PATH).
   2b. status === 'loading'→ emit a one-shot stream_event surface ("Loading <model>…")
                              then poll getInstanceStatus until 'healthy' or timeout.
   2c. status === 'error'  → finish({ exitCode: 1, stderr: `${code}: ${message}` }).
2. fetch(base_url/v1/chat/completions) — unchanged from Phase 1.
3. On success, LauncherClient.touch(instanceId).catch(() => {}) — fire-and-forget.
```

Where the call-site is today: `cli-runner.js:152-158`:

```js
if (backend.type === 'http') {
  return createHttpProcess(backend, {
    prompt: promptViaStdin || stdinData || '',
    model,
    taskType: taskType || 'conversation'
  });
}
```

Phase 2 needs `resolved` (the routing resolver's output) plumbed down to `createHttpProcess` — today only `model` (the bare family string) arrives. The resolver already holds `familyId`, `backendId`, `modelArg`; we extend it to carry `launcher_model` and `launcher_backend` read from the ai_families row. `message-handler.js` passes the whole `resolved` object down instead of cherry-picking `model`.

`sendTextPromptHttp` gets the same ensureModel preamble. Share the logic via a small `async function resolveLocalInstance(resolved): Promise<{base_url, instance_id, model_id}>` helper that both code paths call.

### 6.3 Failure surfacing

The plan's §6 asks for UX differentiation between error classes. Today, HTTP backend failures all dump to stderr and Chat.jsx shows a generic "backend unavailable" toast (Phase-1 wording chosen so it doesn't reset `setupComplete`). Phase 2 extends this:

| Launcher response `code`  | OS8 stream_event `subtype`    | Chat.jsx surface                                                     |
|---------------------------|-------------------------------|----------------------------------------------------------------------|
| `LAUNCHER_UNREACHABLE`    | `error` w/ `code=launcher_down` | Toast: "os8-launcher isn't running. Start it with `./start`."        |
| `MODEL_NOT_DOWNLOADED`    | `error` w/ `code=not_downloaded` | Toast + deep-link to launcher dashboard's Models tab.                |
| `loading` (not an error)  | `status` w/ `code=model_loading` | Inline "Loading qwen3-coder, ~30s" banner; auto-dismisses when done. |
| `BUDGET_EXCEEDED`         | `error` w/ `code=budget`      | Toast: "VRAM full. Stop an idle model or reduce the resident set."    |
| `START_FAILED`            | `error` w/ `code=start_failed` | Toast: "Backend crashed — see launcher logs." + log tail.            |

The synthesized stream shape already has room for this — emit a `stream_event` with `{type: "system_error", code, message}` before `finish()`. Chat.jsx's existing ag-ui event consumer can pattern-match on `code`.

**Routing-cascade interaction.** Today (Phase 1), HTTP-backend failures surface as "backend unavailable" and routing doesn't re-cascade. For Phase 2, we want `BUDGET_EXCEEDED` and `START_FAILED` to trigger cascade fallback (routing picks the next family — e.g. escalate to Claude Opus — if the local backend can't serve). `MODEL_LOADING` should *not* cascade (just wait). `LAUNCHER_UNREACHABLE` is ambiguous — configurable behavior. Flag for implementation: verify that routing.js's cascade loop considers HTTP-backend exit codes as "try next family" and add one-line code-based filtering if needed.

---

## 7. Risks and Open Questions

### 7.1 Known risks

- **Concurrent health-check races.** Two ensure-loads firing simultaneously both poll `http://localhost:<port>/v1/models` with an `initial_delay=5s`. If vLLM instance A's `_wait_for_healthy` starts scraping B's port during a port-allocator glitch, we'd report A healthy when it isn't. Mitigation: allocator commits the port into state.yaml *before* health-checking; health-check reads that record, not a stale local variable. Add assertion: port-in-state matches port-being-probed.

- **Mid-eviction crash.** Launcher evicts A, crashes before starting B. On restart, `validate_state` finds A dead (its container was already stopped), prunes it. B is absent (ensure-loading wasn't persisted yet). Outcome: clean slate, next ensure re-starts B. **Correct behavior** — no recovery logic needed. Worth a test.

- **state.yaml write-skew under crash.** `set_backend` writes then yaml-dumps the whole file. A crash mid-write corrupts state.yaml. Mitigation: write via `atomic_write_yaml(path)` (write to `path.tmp` then `rename`). Cheap, defensible. Not in place today; worth adding as part of `launcher-1`.

- **Container name collision on crash recovery.** If docker's `--rm` didn't fire (host crash during container run), `os8-vllm-qwen3-coder-next` can linger as a stopped container. Next start fails with "name in use." Add a pre-start `docker rm -f os8-<instance>` (ignore "not found") for instance-scoped names, parallel to the pattern already used for `os8-{backend}`.

- **Resident auto-start stampede on slow disks.** Four resident models starting at once each read weights from NVMe. On a cold cache, that's heavy I/O contention — might tip `health_timeout` over. Mitigation: serialize resident auto-start by default, parallelize only when `auto_start_parallel: true`. Ship default-serial.

- **Ports-tab UI drift.** Ports tab keys overrides by backend *kind* but Phase 2 introduces per-instance ports. Tab UI needs a "this is the first instance's port" hint; two instances of the same kind get differentiated in state but the tab still only shows the kind-level knob. Acceptable for Phase 2; revisit in Phase 3 if instance-specific overrides become common.

- **`os8` bridge client (`config.yaml:292-294`)** has hardcoded port 8000 and model inherited from "the" running backend. With N backends, what does the `os8` bridge point at? Out of Phase 2 scope (OS8 doesn't use the bridge — it hits backend ports directly), but flag for Phase 3: either deprecate the bridge or make it role-aware.

### 7.2 Open questions (decide before implementation)

1. **Should `/api/serve/ensure` block or return immediately by default?** Recommendation: **non-blocking** (`wait=false`). OS8 polls. Rationale: non-blocking is a superset — callers that want blocking can set `wait=true`; callers that want UX feedback during loads can poll and render progress. A blocking default forces the long-poll connection to stay open for 30-60 min on NIM loads, which is fragile over proxies.

2. **Should LRU respect in-flight requests?** If instance A is mid-stream to a user and ensure for B picks A as the eviction victim, do we wait for A's stream to finish? Recommendation: **no**. Hard-evict; A's stream fails with connection-reset; OS8 surfaces a mid-stream error. Simpler; matches docker's `stop` semantics. If this proves too aggressive in practice, add per-instance busy-tracking (ref count of open POSTs) in Phase 3.

3. **`resident:` list diffs between config reloads.** Launcher hot-reloads `config.yaml` (api.py:120-148). If a user edits `resident:` at runtime, do we start/stop to match? Recommendation: **no auto-reconcile in Phase 2**. Next auto-start (launcher restart) picks up the change. Avoids the complexity of "is this a user's edit or a stale reload?"

4. **`memory_budget_gb` default.** DGX Spark has 128 GB shared. OS and other processes need room. Recommendation: default **100 GB** (~78%). Too aggressive and we OOM; too conservative and we leave capacity unused.

5. **Does `/api/serve/touch` need a body?** Recommendation: **yes, minimal** — `{instance_id: "..."}`. Lets us add more signal (tokens served? latency?) later without a new endpoint.

6. **Where does the family → launcher-model mapping live — DB or config?** Recommendation: **OS8 DB** (`ai_families.launcher_model/launcher_backend` columns). Launcher stays ignorant of OS8's family abstraction; OS8 stays authoritative over its own model-picking. Matches Phase-1 philosophy where task→model mapping lived on OS8 and the launcher just enumerated capabilities.

7. **Should we verify routing.js cascades on ensure-failure?** Recommendation: **read during `os8-2` implementation and patch if needed**. It's a 15-minute check against `routing.js:generateCascade` / the ensure-failure signal path. Not worth pre-landing.

---

## 8. Proposed Commit Sequence

Sized for single-reviewer PRs. Launcher first (its API is the contract), OS8 second (consumer). No PR leaves the tree in a non-working state.

### Launcher

**`launcher-1`: State schema migration (refactor, no behavior change).**
- `state.py`: `backends` dict replaces singular `backend`. Legacy-read migrator in `load_state`.
- `backends.py`: `set_backend`/`clear_backend`/`stop_backend` take `instance_id`. `get_status_data` emits `backends: []` + legacy `backend:` shim.
- `api.py`: `/api/status` surfaces the new list; docstring notes the shim.
- Atomic state-file write added.
- **Still single-backend at runtime** — the "already running" guard stays. Enables the rest without behavioral risk.
- **Test:** existing single-backend flow still works byte-for-byte via the legacy shim.

**`launcher-2`: Enable concurrent starts.**
- Remove the `"backend" in state` guard in `_start_backend_inner`.
- Port allocator (§4.1) + `instance_id`-suffixed container/log names + `docker rm -f` pre-start.
- `stop_backend(instance_id)` signature.
- Still no LRU / no `resident:` / no ensure endpoint — manual `/api/serve` calls can now multi-start.
- **Test:** two vLLM instances on 8000 and 8010 serving different models simultaneously. `./launcher stop <instance>` targets individually.

**`launcher-3`: `/api/serve/ensure` + capabilities array + `/api/serve/touch`.**
- New endpoints. Idempotency lock. `/api/status/capabilities` returns per-task arrays.
- No LRU yet — ensure fails with `BUDGET_EXCEEDED` naïvely if sum > budget using whatever `memory_budget_gb` defaults to (document the gap).
- **Test:** double-ensure idempotency; ensure under budget succeeds; ensure over budget returns 409 with clear message.

**`launcher-4`: LRU eviction + `resident:` + auto-start.**
- Eviction algorithm (§5.2), touch-driven LRU, admission loop.
- `resources:`, `resident:`, `roles:` sections in `config.yaml`. `auto_start_resident` on boot (serial by default).
- **Test:** fill budget, ensure new → LRU evicts oldest non-resident; ensure resident → never evicts resident; cold-boot auto-starts all declared residents.

**(Optional) `launcher-5`: Polish** — per-instance overrides in settings.yaml read path; Ports-tab copy update; eta_seconds from load history; `GET /api/serve/{instance_id}/status` polling endpoint (nice-to-have for OS8, can lean on `/api/status`).

### OS8

Open these after `launcher-3` lands (ensure endpoint is the minimum external dependency).

**`os8-1`: DB schema + family seeds.**
- Migration `0.3.0-local-family-mapping.js`: add `launcher_model`, `launcher_backend` columns to `ai_families`.
- Backfill Phase-1 `local-gemma-4-31b` row.
- Seed new family rows for `local-qwen3-coder-30b` (eligible_tasks: `coding,jobs`), `local-kokoro-v1` (eligible: `tts`), `local-flux1-schnell` (eligible: `image-gen`) — **families only, not wired into cascades** (Phase 3).
- **Test:** migration up on a Phase-1 DB; rows present; existing agent pinned to `local-gemma-4-31b` still works.

**`os8-2`: LauncherClient.ensureModel + createHttpProcess rewiring.**
- Add `ensureModel`, `touch`, `getInstanceStatus` to `launcher-client.js`.
- `createHttpProcess` + `sendTextPromptHttp` call ensure → poll-if-loading → fetch → touch.
- Thread `resolved` (with `launcher_model`/`launcher_backend`) into the HTTP path via `message-handler.js`.
- Error code plumbing — stream `system_error` event with `code` field.
- Verify routing cascade on ensure-failure (tiny patch if needed, see §7.2 q7).
- **Test:** launcher down → clean error; launcher up, model not yet loaded → "loading" banner, completes; launcher up, model loaded → fast path; two agents pinned to two local families, send messages in parallel, both stream independently.

**`os8-3`: UX polish for error codes.**
- Chat.jsx toast mapping for each `code`.
- Deep-link from `MODEL_NOT_DOWNLOADED` toast to launcher dashboard.
- **Test:** each error class rendered with the right copy. Manual.

Total: 5 launcher PRs (1 optional) + 3 OS8 PRs. Each independently reviewable; each leaves the tree green.

---

## 9. Out of Scope (for reference)

Flagged as Phase-1 leftovers or later-phase work — not rolled into Phase 2:

- **Phase-1 leftover:** `state.working` wrapper divergence + stale "Working…" indicator on subconscious-direct path (filed; not introduced by Phase 2).
- **Phase 3:** TTS/image/vision/tool_calls routing — families seeded by Phase 2 but cascades wired by Phase 3.
- **Phase 4:** Onboarding fork ("Proprietary" vs "Local" mode), per-agent mode override, preflight-check UI.
- **Phase 5:** Model-discovery auto-sync from launcher config, offline/Running-locally badge, advanced-models panel, `docs/local-models.md`.

---

## 10. Implementation Order at a Glance

```
┌─────────────────────────────────────────────────────────────────┐
│ launcher-1  state schema                (invisible to OS8)      │
│ launcher-2  concurrent starts           (CLI-only visible)      │
│ launcher-3  ensure + array capabilities (OS8 can now integrate) │
│ launcher-4  LRU + resident auto-start   (full Phase 2 feature)  │
└─────────────────────────────────────────────────────────────────┘
               ↓ (ensure endpoint available)
┌─────────────────────────────────────────────────────────────────┐
│ os8-1       family schema + seeds                                │
│ os8-2       ensureModel wiring  ← Phase 2 acceptance tests pass │
│ os8-3       error-code toasts                                    │
└─────────────────────────────────────────────────────────────────┘
```

Acceptance (§0) passes after `launcher-4` + `os8-2`. `os8-3` is UX polish that doesn't affect the acceptance checklist.
