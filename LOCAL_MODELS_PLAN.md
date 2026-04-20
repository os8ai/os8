# Local Models for OS8 — End-to-End Implementation Plan

**Status:** v1.2 (2026-04-19) — Phase 1 shipped (end-to-end verified against Gemma-4-31B on vLLM).
**Scope:** Add a "Local Models" mode to OS8 that routes all AI tasks (chat, tools, coding, summary, image-gen, TTS, vision) through the open-source `os8-launcher` instead of proprietary cloud APIs.

---

## Phase 1 as-shipped (2026-04-19)

Acceptance met: user pins an agent's family to `local-gemma-4-31b`, sends a message, and the stream renders in the UI with Gemma-4-31B responding from the user's local GPU.

**Landed in launcher (`os8-launcher/src/api.py`):**
- `GET /api/status/capabilities` — returns `{task_type: {model, base_url, model_id}}` derived from the currently-running backend + a small eligibility table. Composes cleanly with the Ports tab (`/api/ports`, committed concurrently in `59eca3d`) — if the user overrides vLLM's port, the `base_url` in the capabilities payload reflects it automatically.

**Landed in OS8:**
- `src/services/backend-adapter.js` — 5th `BACKENDS` entry `local` with `type: 'http'`, no-op `buildArgs`/`prepareEnv`, OpenAI-shape `parseResponse`/`parseStreamJsonOutput`.
- `src/services/launcher-client.js` (new) — thin HTTP wrapper: `getStatus`, `getCapabilities`, `listAvailableModels`, `isReachable`.
- `src/services/cli-runner.js` — `createProcess` dispatches HTTP backends to a new `createHttpProcess` that POSTs to `<base_url>/v1/chat/completions` and synthesizes Claude-shape stream-json (`stream_event`/`content_block_delta` → `result`) so `message-handler.js`'s existing stream loop consumes it unchanged. `sendTextPromptHttp()` parallel to `sendTextPrompt()`.
- `src/assistant/message-handler.js` — one call-site addition to pass `model`/`taskType` through to `createProcess`; HTTP backend failures now use "backend unavailable" phrasing so the Chat.jsx regex doesn't reset `setupComplete` on launcher-down.
- `src/services/routing.js` — (a) `isAvailable` short-circuits `container.type === 'http'` past provider/API-key gating; (b) `generateCascade` stops skipping HTTP containers for missing `api_key_env`; (c) **agent override is now honored for every task type, not just conversation** (families that aren't listed in their `eligible_tasks` are still skipped). Without this, pinning an agent to `local-gemma-4-31b` silently re-routed to Claude Opus whenever the flow classified as `planning`.
- `src/routes/settings-api.js` — `/api/backend/auth-status/:backend` returns `ready: true` for HTTP containers (no API key, no login).
- `src/db/seeds.js` — provider `local`, container `local` (type `http`, id matches the BACKENDS key), family `local-gemma-4-31b` with conservative caps and `eligible_tasks='conversation,summary,planning'`. Feature flag `local_models_enabled` seeded at `'0'` but dormant — no code reads it yet; Phase 4 will wire the onboarding fork + UI toggle.

**Known out-of-scope (deferred):**
- OpenAI `tool_calls` passthrough — was a Phase-1 stretch goal; deferred to Phase 3 when qwen3-coder (a tool-trained model) lands. Gemma-4-31B isn't tool-trained, so there's nothing to prove.
- Pre-existing UI bugs surfaced during testing (`state.working` wrapper divergence; "Working…" stale indicator on the subconscious-direct path) — not introduced by this work; filed for separate follow-up.

**Composition with concurrent work:**
- Ports tab feature (`os8-launcher` `59eca3d`) shipped at the same time as the `/api/status/capabilities` endpoint. The two compose without any coordination: the capabilities payload reads whatever port the running backend was started with, so port overrides are transparent to OS8.

---

## Background

- OS8 today runs on four cloud-backed CLI backends: Claude, Gemini, Codex, Grok. Every AI task (conversation, jobs, planning, coding, summary, image) flows through `src/services/routing.js` → `backend-adapter.js` → a spawned CLI.
- `os8-launcher` is a separate open-source project (same owner) at `~/Claude/os8-launcher`. It runs local open-source models on NVIDIA hardware via Docker + vLLM / llama.cpp / ollama / ComfyUI / Kokoro / fish-speech. It exposes OpenAI-compatible HTTP endpoints on per-backend ports, plus a FastAPI control plane on `:9000`.
- There is **no** pre-existing local-backend code inside the OS8 repo. A stub placeholder exists in os8-launcher at `clients/os8/manifest.yaml`, but it's just a manifest shell. We start the OS8-side integration from scratch.
- Launcher's own roadmap already names "OS8 Bridge" as Milestone 2 (see `os8-launcher/VISION.md`).

## 1. Integration Shape

Two processes, two planes:

- **Control plane** → `http://localhost:9000/api/*` (launcher FastAPI). Used to start/stop models, discover what's running, download weights, check health.
- **Data plane** → OpenAI-compatible endpoints on per-backend ports. All chat/TTS/image backends already expose `POST /v1/chat/completions` (or `/v1/audio/speech`, or ComfyUI's `/prompt`).
  - vLLM: 8000
  - llama.cpp: 8080
  - ollama: 11434
  - ComfyUI: 8188
  - Kokoro TTS: 8880
  - fish-speech TTS: 8080
  - Vision (Qwen3.6): 9006

OS8 becomes a client of both planes: it talks to the control plane to orchestrate availability, and to the data plane for actual inference. **No CLI spawning** — pure HTTP. This is a simpler path than the existing CLI backends.

## 2. Model → Task Mapping

Default cascades when Local mode is active:

| Task | Primary | Fallback | Notes |
|------|---------|----------|-------|
| **conversation** | `gemma-4-31B-it-nvfp4` (32 GB, vLLM) | `gemma-4-E2B-it` (10 GB) | Good quality, fits alongside others |
| **coding** | `qwen3-coder-30b` (17 GB, ollama) | `qwen3-coder-next` (85 GB) | 30B default keeps VRAM free |
| **jobs / tools** | `qwen3-coder-30b` | `qwen3-coder-next` | 30B resident by default; auto-escalate to 85B on malformed tool calls |
| **planning** | `gemma-4-31B-it-nvfp4` | — | Instant; already resident. Nemotron-120b available as optional advanced download |
| **summary** | `gemma-4-E2B-it` | `gemma-4-31B-it-nvfp4` | Small model is fine and fast |
| **image-gen** | `flux1-schnell` (34 GB, ComfyUI) | `flux2-klein-4b` | Schnell fast, Klein lighter |
| **image-edit** | `flux1-kontext-dev` | — | Unique to Kontext |
| **vision** | `qwen3-6-35b-a3b` | — | Multimodal input |
| **TTS** | `kokoro-v1` (0.3 GB) | `fish-s2-pro` | Kokoro tiny/54 voices; Fish for cloning |
| **STT** | whisper.cpp (already in OS8) | — | No launcher work needed |

Cascades use OS8's standard escalation pattern: cheap-and-resident first, heavy-and-accurate on failure. For jobs, the 30B handles routine cases; malformed tool calls auto-escalate to the 85B. Nemotron-120b stays in `config.yaml` but is excluded from the default download and resident set because its 30–60 min NIM cold start is a first-run UX killer — users opt in via Settings → Advanced Models.

## 3. Concurrent Serving (Resident Pool)

Launcher today = one backend at a time (single `backend:` entry in `~/.config/os8-launcher/state.yaml`). OS8 switches models constantly, so the launcher gains a **resident pool** mode: multiple backends run simultaneously on distinct ports, with OS8 selecting the right port per task.

Default resident set for DGX Spark (128 GB unified memory):

- Gemma-4-31B chat (32 GB) — always resident
- Qwen3-coder-30b (17 GB) — always resident (serves both `coding` and `jobs`)
- Kokoro TTS (0.3 GB) — always resident
- Flux1-schnell (34 GB) — resident; evicted only when a 120B+ model is explicitly requested

Total ~83 GB baseline, ~45 GB headroom for swaps.

**Configurable resident set.** Users with less VRAM set `resident: [chat]` (or any subset) in `config.yaml`. Anything outside the resident set hot-swaps on demand; LRU eviction kicks in under VRAM pressure. DGX Spark users get the zero-latency experience; commodity-GPU users get a working-but-swappier experience.

## 4. Phased Plan

### Phase 1 — End-to-end skeleton (one model, prove the pipe)

Goal: a user selects "Local Models", chats with Gemma-4-31B, and it works.

**Launcher side:**
- Keep single-model serving as-is for now.
- Add `GET /api/status/capabilities` returning `{task_type: {model, base_url, model_id}}` so OS8 can discover what's usable per task.

**OS8 side:**
- `src/services/backend-adapter.js`: add `local` backend (5th entry). No CLI spawn — `buildArgs`/`prepareEnv` are no-ops; a new HTTP path does `POST http://localhost:<port>/v1/chat/completions` with OpenAI schema. Reuse `parseResponseLine()` (NDJSON is already handled for Codex/Grok).
- `src/services/cli-runner.js`: add `sendTextPromptHttp()` parallel to `sendTextPrompt()`; dispatch when `container.type === 'http'`.
- `src/services/launcher-client.js` (new): thin client for `http://localhost:9000/api/*` — `getStatus()`, `ensureModel(task)`, `listAvailableModels()`.
- DB seed: new provider `local`, container `launcher` (type `http`), initial family `local-gemma-4-31b` with `eligible_tasks='conversation,summary,planning'`.
- Settings: "Local Models" toggle behind a feature flag.

**Acceptance:** manually set an agent's family to `local-gemma-4-31b`, send a message, stream renders correctly.

### Phase 2 — Launcher concurrent serving (resident pool)

Goal: chat + code + TTS + image all warm simultaneously; switching between tasks is instant.

- Launcher `state.py`: schema becomes `backends: [{name, model, port, ...}]` (list).
- Launcher `backends.py`: `start()` accepts `--alongside` flag; port allocator assigns distinct ports if default is taken.
- Launcher `/api/status`: returns list of running backends.
- New endpoint `POST /api/serve/ensure` — idempotent "make sure this model is running"; returns port; no-op if already up.
- Launcher `config.yaml`: new `resident: [chat, coder, tts, image-gen]` key controls the default resident set. Eviction is LRU by task, bounded by a configurable VRAM budget.
- OS8 `launcher-client.js`: `ensureModel(familyId)` calls `/api/serve/ensure` before each request when needed.

**Acceptance:** start chat model, start coding model without stopping chat; both reachable simultaneously; LRU eviction works under VRAM pressure.

### Phase 3 — Task coverage

Goal: every task type in OS8 runs locally.

- Seed remaining families per §2 table with correct `cap_*` scores and `eligible_tasks`.
- Routing cascades: add a `mode` column to the cascade table (`proprietary` | `local`). Resolver reads the global mode setting unless the agent has a per-agent override (see Phase 4).
- **Jobs escalation:** cascade order `local-qwen3-coder-30b` → `local-qwen3-coder-next`; routing auto-escalates when tool-call parsing fails.
- **TTS:** new `tts-kokoro.js` and `tts-fish.js` modules matching the existing `tts-openai.js` interface (exports `DEFAULTS`, `getVoices`, `PROVIDER_ID`). Plug into `PROVIDERS` map in `src/services/tts.js`. Both hit launcher ports directly.
- **Image gen:** extend `resolveImageProviders()` in `src/services/imagegen.js` to recognize local families → POST to ComfyUI (`/prompt` with workflow JSON, not OpenAI-compat — needs a small ComfyUI client).
- **Vision:** route multimodal agents to `qwen3-6-35b-a3b` via the vision backend port (9006).
- **STT:** no work — `src/services/whisper.js` already runs locally.

### Phase 4 — Onboarding fork + mode controls

Goal: a new user picks "Proprietary" or "Local" and everything Just Works. Power users can override per agent.

**Onboarding (detect + guide):**
- `src/renderer/onboarding.js`: insert **Step 2.0: Mode Selection** before backend detection. Two cards: *Proprietary Models* (current flow) / *Local Models*.
- If Local selected, run a **preflight check**:
  - Is `~/Claude/os8-launcher/` present?
  - Is Docker installed and running?
  - Is the NVIDIA Container Toolkit present? Is a GPU visible?
  - Is launcher API responsive on `:9000`?
- For each failing check, surface an actionable panel: the exact command to run (copy-paste-ready) and a link to the launcher's install docs. Once all checks pass, OS8 takes over — verifies launcher version, polls `/api/status/capabilities`, offers to download any missing resident-set models via `/api/models/{name}/download`.
- Skip Steps 2–5 of the proprietary flow (no API keys, no voice provider auth).

**Mode controls (global default + per-agent override):**
- Settings: persistent **Mode** switch (Proprietary / Local). Drives the global default.
- Agent config: **Mode** field with three values — "Use global default" (default), "Force Proprietary", "Force Local". Routing resolver reads the agent override first, falls back to global.
- Use case: a private journal agent can be pinned to Local regardless of global mode; a heavy-reasoning agent can be pinned to Proprietary even when the global is Local.

### Phase 5 — Polish

- Model discovery auto-sync: when launcher's `config.yaml` changes, OS8 re-seeds families via control-plane poll.
- Error UX: distinguish "launcher not running", "model not downloaded", "model loading (wait)", "VRAM full" as separate toasts.
- Offline indicator: "Running locally" badge in the UI.
- Advanced Models panel in Settings: opt-in download for Nemotron-120b (with explicit warning about 30–60 min cold start) and other heavy models excluded from the default set.
- Docs: user-facing `docs/local-models.md`, launcher README cross-link.
- Future work trigger: if onboarding telemetry shows high abandonment at the preflight step, promote install to a bundled auto-installer for Linux.

## 5. Key Integration Points (file:line)

**OS8 side (where changes land):**
- `src/services/backend-adapter.js:74–691` — add 5th `BACKENDS` entry
- `src/services/cli-runner.js:281+` — add HTTP dispatch path
- `src/services/routing.js:36–92` — resolver reads global mode + per-agent override; local cascade generator
- `src/services/ai-registry.js:6–201` — query path; schema unchanged
- `src/db/schema.js:597–659` — add `mode` column to cascade table; add `mode_override` column to agents table
- `src/db/seeds.js:9–83` — add local provider/container/families
- `src/services/tts.js:11–14` — add Kokoro/fish to `PROVIDERS` map
- `src/services/imagegen.js:211–234` — extend `resolveImageProviders()` for ComfyUI
- `src/renderer/onboarding.js:14–21` — insert mode-select + preflight steps
- `src/renderer/settings.js` — global Mode switch + per-agent override UI

**Launcher side (where changes land):**
- `src/state.py:34–55` — backend entry becomes list
- `src/backends.py:515–750` — lifecycle supports concurrent backends; LRU eviction
- `src/api.py:267` — `/api/status` returns list; new `/api/status/capabilities`, `/api/serve/ensure`
- `config.yaml` — new `resident:` key for default resident set

## 6. Immediate Next Steps

Start with **Phase 1**: single-model HTTP backend working end-to-end. That's the riskiest part (proving OpenAI-compat path + streaming + tool-use parity) and everything else builds on it. Concrete task list with file-level changes on green light.
