# Local Models for OS8 — Plan v2

**Status:** v2.0 (2026-04-21) — rewrite on top of the shipped Phase 1–3 + 2B work.

Supersedes v1.x. The historical phase docs (`LOCAL_MODELS_PHASE_2.md`, `LOCAL_MODELS_PHASE_2B.md`, `LOCAL_MODELS_PHASE_3.md`) remain as audit records of what shipped; this doc is the current canonical roadmap.

---

## What this is now

Three opinionated local-model slots. Each powers one capability. One global toggle ("Local mode") in OS8 Settings flips them all on or off together. The os8-launcher's resident pool (shipped Phase 2) auto-loads and pins all three when local mode is active; they stay memory-resident for instant-response use.

| Slot | Model | Size | What it powers in OS8 |
|------|-------|------|-----------------------|
| **Chat** | `qwen3-6-35b-a3b` | 36 GB | conversation, jobs, planning, coding, summary, vision (multimodal input) |
| **Image** | `flux1-kontext-dev` | 18 GB | reference-image conditioned image generation + editing |
| **Voice** | `kokoro-v1` | 0.3 GB | text-to-speech |

Resident footprint: ~54 GB + KV margin ≈ 70 GB on the 128 GB Spark. Plenty of headroom.

**Why just these three, one choice each:**
- Real-world testing on the Spark has confirmed these are the three that actually work well for OS8's use cases from the launcher's current inventory.
- Running many models simultaneously on a home machine means more swap thrash than value. Opinionated defaults beat infinite flexibility for the default user.
- Dropdown menus with additional options are a later enhancement; for now, each slot has exactly one model.

---

## Architecture

**OS8** = UI + orchestrator. Picks one model per slot (currently hardcoded to the table above), calls the launcher's `/api/serve/ensure` with `resident=true` for each slot on mode-flip or startup, then treats them as always-available.

**os8-launcher** = serving plane. Runs the three containers/processes, pins them as resident so LRU eviction never touches them, exposes OpenAI-shape endpoints on per-backend ports, reports status via `/api/status/capabilities` and `/api/ai/local-status` (OS8-side).

**Flow when local mode is on:**
1. User is in Settings → Local mode = on.
2. OS8 knows the three slot assignments.
3. OS8 calls ensureModel for each (resident=true). Launcher starts them if not already running, or no-ops if they are.
4. Launcher's Phase-2 concurrent-serving holds all three in memory simultaneously.
5. OS8 routing:
   - Every text task (chat, jobs, planning, coding, summary) → chat slot model.
   - Any task with image input → chat slot (Qwen 3.6 is multimodal).
   - Image generation → image slot model (requires reference image; see UX note below).
   - TTS → voice slot model via the `tts.js` facade.
6. A call to any of the three is a pure data-plane POST to its launcher port. No cold-load latency, no "launcher has no capability" errors.

**When user flips local mode OFF:**
- OS8 stops calling local endpoints. Routing switches back to the proprietary cascade (Claude/Gemini/OpenAI/Grok via CLIs).
- Launcher keeps the residents running — user can manually stop them via the launcher dashboard if they want the VRAM back. OS8 doesn't force-stop the launcher because other tools (Open WebUI, aider, etc.) might be using it.

---

## Current state (as of 2026-04-21)

**Shipped and working:**
- Launcher concurrent serving, port allocation, `/api/serve/ensure`, `/api/serve/touch`, LRU eviction, resident-pool auto-start (commits `8f23276..7246a06` on `os8-launcher@main`).
- OS8 routing mode (`ai_mode = 'local' | 'proprietary'`), family seeds, cascade-by-mode, vision-swap on attachments, tool-call synthesis, local-status endpoint.
- OS8 `ensureModel` wiring — every chat call goes through ensure → poll-if-loading → POST → touch.
- Kokoro TTS provider — full parity with ElevenLabs/OpenAI (three-way picker, default voices, per-agent voices, sample playback via on-demand generation).
- ComfyUI image-gen — workflow templates + client. **Currently wired to `flux1-schnell` (no reference needed).** Needs swap to `flux1-kontext-dev`.
- Qwen3-6-35b-a3b family seeded for vision + conversation — **needs eligible_tasks widened to cover coding, jobs, planning, summary too.**
- 471 passing tests. Pre-start hook prevents the better-sqlite3 ABI mismatch bite.

**Gap against the v2 triplet:**

| # | Issue | Fix |
|---|-------|-----|
| 1 | `local-flux1-schnell` is the wired image family; v2 wants `flux1-kontext-dev`. | Add family seed for `local-flux1-kontext-dev`, update `imagegen.js` family→provider map, swap the workflow template from schnell to kontext (Kontext workflow already exists in the launcher client — port it). |
| 2 | `local-qwen3-6-35b-a3b` has `eligible_tasks='conversation'`. Under v2 it's the text workhorse. | Expand to `conversation,summary,planning,coding,jobs`. Bump cap scores so it wins cascades for those tasks. |
| 3 | Unused seeded families (`local-gemma-4-31b`, `local-gemma-4-e2b`, `local-qwen3-coder-30b`, `local-qwen3-coder-next`, `local-flux1-schnell`, `local-kokoro-v1`). Keep kokoro, drop the rest. | Leave rows in place for rollback safety, but set their `eligible_tasks` to empty or their caps to zero so they never win. Clean removal is a later migration. |
| 4 | Launcher `config.yaml`: `resident: []` today. Needs the chosen triplet. | Set `resident: [chat, image, tts]` with `roles:` updated so `chat: qwen3-6-35b-a3b`, `image: flux1-kontext-dev`, `tts: kokoro-v1`. One file change. |
| 5 | No OS8 Settings UI for local mode on/off. Currently set via SQL. | Add a toggle in Settings → AI, plus a three-slot status panel showing which models are serving (read from `/api/ai/local-status`). |
| 6 | `imagegen.js::generateWithComfyUI` doesn't handle reference images. | Extend `generateWithComfyUI` to pass reference through the Kontext workflow (LoadImage node upload via `POST /upload/image`, then graph with VAEEncode + ReferenceLatent). |
| 7 | When flipping to local mode, the three models take 30-90s to become resident. No UX indication of progress. | Add a startup banner: "Starting local services: chat ✓, image (loading 42s), voice ✓" reading from `/api/ai/local-status`. |

**Bugs to fix along the way (flagged in flight):**
- **MODEL_LOAD_TIMEOUT at 60s** in `createHttpProcess` is too tight for cold vLLM starts. Either bump to 120s or rely on resident auto-start making this rare enough not to matter. If residents are always pre-loaded, the 60s timeout only bites when someone force-stopped a model mid-session.
- **Loading banner SSE plumbing** deferred from Phase 2B — still needs wiring if we want per-call "loading…" banners. With resident auto-start, this becomes less critical.

---

## Plan — phased, small

### Phase A: Align the defaults (quick — half a day)

Goal: with zero UI changes, the three chosen models are what you get when ai_mode=local.

1. Launcher `config.yaml`:
   - Update `roles.chat` to `{ model: qwen3-6-35b-a3b, backend: vllm }`.
   - Update `roles.image-gen` to `{ model: flux1-kontext-dev, backend: comfyui }` (new role or repurpose).
   - Set `resident: [chat, image-gen, tts]`.
2. OS8 seeds migration:
   - Add `local-flux1-kontext-dev` family (eligible_tasks='image', supports_vision=0, launcher_model='flux1-kontext-dev', launcher_backend='comfyui').
   - Update `local-qwen3-6-35b-a3b`: eligible_tasks='conversation,summary,planning,coding,jobs', cap scores bumped (cap_chat=4, cap_coding=3, cap_jobs=3, cap_planning=3, cap_summary=3).
   - Zero out caps / clear eligible_tasks on the other local families so they never win cascades (keeps rows for rollback).
3. OS8 imagegen.js:
   - Add `local-flux1-kontext-dev` to `_familyToProvider` and `_familyToProviderId`.
   - New workflow template `comfyui-workflows/flux-kontext-edit.js` (adapt from the launcher's image-gen client).
   - Extend `generateWithComfyUI` to upload a reference via `POST /upload/image` and build the Kontext graph when the family is kontext-dev.
   - Reject calls without a reference with a clear error (`Kontext requires a reference image`).
4. Tests: migration test for the new family row; extend imagegen-image.test.js with a Kontext-workflow shape test.

**Done when:** user flips `ai_mode=local`, launcher auto-starts all three, chat/image/voice all work. No UI yet.

### Phase B: Settings UI — three-slot status + local-mode toggle (half a day)

Goal: user never has to touch SQL again.

1. Add `ai_mode` toggle to Settings → AI panel.
2. New "Local services" section with three rows (Chat / Image / Voice), each showing:
   - Current model (read-only for now).
   - Live status: Serving ✓ / Loading (polling /api/ai/local-status) / Offline.
3. On toggle-flip to local mode: call ensureModel for each slot with resident=true via a new `/api/ai/local-mode/start` endpoint, show a progress banner.
4. On toggle-flip off: no force-stop (power users may keep launcher running for other tools); just switch OS8 routing back.

### Phase C: Reference-image UX in agents (variable)

Most agent image-gen calls already carry context (agent portrait, scene setup). Audit the call-sites to make sure they attach a reference. The ones that don't either get a reasonable default (agent's own portrait) or surface the "Kontext needs a reference" error.

Specific call-sites to review: sim-portrait.js, agent-life (scene snapshots), any imagegen calls in skills.

### Phase D: Dropdowns per slot (later, when we have more than one model per slot)

Deferred until there's a second viable option for any slot. If you later validate (say) Fish Speech for voice, we add it to the voice slot's dropdown. Until then, one-choice-each is fine.

### Phase E: Launcher "OS8 support mode" (later, optional)

If the launcher dashboard's multi-persona UX starts feeling confusing in practice, split it into two modes at the top-level: "OS8 support mode" (shows only the three OS8 slots + status) and "Power user" (current dashboard). Not urgent; revisit after Phase B ships and we see how it feels.

---

## Design decisions / trade-offs (recorded)

- **Qwen3-6-35b-a3b for coding**: seeded `cap_coding=2` in Phase 3 because qwen3-coder-30b (cap=4) was the coding specialist. We accept the drop in coding quality in exchange for fewer concurrent models and unified chat/code/vision. If it proves painful we can swap qwen3-coder-30b into the chat slot or add a fourth "coder" slot.
- **Kontext requires references**: callers without a reference image get a clear error. Matches the actual capability of the model; any workaround (blank canvas) would produce garbage.
- **Launcher keeps residents running after OS8 flips off local mode**: conservative — other tools may be using the launcher (Open WebUI, aider) and we shouldn't unilaterally stop their models.
- **OS8 is source of truth for the three choices, not the launcher**: avoids bidirectional sync complexity. Launcher's `resident:` config is where the assignment physically lives, but OS8 owns the picker and just writes through.

---

## Out of scope (explicit non-goals for v2)

- **Multi-choice dropdowns per slot.** One model per slot for now.
- **Per-agent override of the local triplet.** All agents in local mode use the same three. Per-agent model routing stays available via agent.model pinning but requires SQL.
- **Auto-sync of launcher config.yaml changes.** Launcher is the source of truth for what models *can* be served; OS8 knows which subset is active via its own seeds. If a new model lands in config.yaml, it appears after a manual OS8 seed update.
- **Image-edit as a distinct task.** Kontext does both generation and editing with the same workflow; no separate code path.
- **Fish Speech, gemma, qwen3-coder-*, flux1-schnell, flux1-dev, fastwan, wan.** All remain in the launcher's config for power users who want them via the dashboard; OS8 ignores them.
- **Phase 4 onboarding fork and Phase 5 polish from the old plan.** Replaced by Phase B (toggle in existing Settings) and ongoing iteration.

---

## Historical phase docs (preserved for audit)

- `LOCAL_MODELS_PHASE_2.md` — concurrent serving design (launcher).
- `LOCAL_MODELS_PHASE_2B.md` — OS8 ensureModel integration.
- `LOCAL_MODELS_PHASE_3.md` — task coverage (families, TTS, image, vision, tool calls).

These describe what shipped. This doc describes where we're going next.
