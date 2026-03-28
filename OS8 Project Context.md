# OS8 Project Context

**Repository:** https://github.com/os8ai/os8

## Purpose & Scope

**OS8** is a personal operating system for building custom web applications with AI assistance. It's a desktop application where anyone can create, develop, and use web apps — all in one place, with AI agents that can be customized, scheduled, and communicate across multiple backends.

The core experience: click "New App," give it a name, and immediately have a working React application with an AI terminal ready to help you build it.

Everything is **local-first** and **self-contained**. Your apps, agents, data, and environment — all on your machine in `~/os8/`.

## Core Philosophy

### 1. One-Click Creation

Creating an app should be instant. No terminal commands, no project setup, no dependency installation. Click a button, name your app, and start building.

When you create an app:
- React project scaffolded with professional template
- Blob storage allocated
- Task list initialized
- AI terminal ready (Claude, Gemini, Codex, or Grok)
- Live preview working

### 2. Local-First Ownership

You own everything:
- **Code** lives in `~/os8/apps/`
- **Data** lives in `~/os8/config/os8.db`
- **Files** live in `~/os8/blob/`
- **No cloud dependency** — works offline

### 3. AI-Native Development

OS8 is built for AI-assisted development from the ground up:
- Multiple AI backends (Claude Code, Gemini CLI, Codex CLI, Grok CLI)
- Each app has auto-generated instruction files for the active backend
- Preview updates in real-time as AI writes code
- Agents with memory, scheduled jobs, and messaging

### 4. Shared Infrastructure

Apps share common infrastructure through **Core Services** (`~/os8/core/`):
- React 18, Tailwind CSS 3, Vite 5 installed once
- All apps use the same dependencies — no per-app `node_modules`
- Consistent environment for AI to understand

## Architecture

### System Overview

```
┌──────────────────────────────────────────────────────────────┐
│                        OS8 (Electron)                         │
├──────────────────────────────────────────────────────────────┤
│  main.js          │  index.html + modules │  preload.js      │
│  - Window mgmt    │  - Tab bar            │  - IPC bridge    │
│  - App lifecycle  │  - Home view          │  - API exposure  │
│                   │  - Workspace view     │                  │
│  src/ipc/         │  - User/Dev modes     │                  │
│  - IPC handlers   │  - Agent chat panel   │                  │
├──────────────────────────────────────────────────────────────┤
│                  src/renderer/ (UI Modules)                    │
│  main │ terminal │ preview │ tasks │ file-tree │ settings    │
│  apps │ tabs │ jobs │ api-keys │ voice │ connections │ ...   │
├──────────────────────────────────────────────────────────────┤
│                    src/ (Backend Modules)                      │
│  ipc/ │ assistant/ │ services/ │ routes/ │ shared/ │ utils/  │
├──────────────────────────────────────────────────────────────┤
│                   src/server.js (Express)                      │
│  - Vite middleware (JSX/CSS transformation)                    │
│  - Route modules (30+): agents, apps, plans, ai-registry, etc.  │
│  - Memory watchers, Telegram watchers, job scheduler          │
│  - App ID routing, static file serving                        │
├──────────────────────────────────────────────────────────────┤
│               Backend Adapter (multi-backend)                  │
│  Claude Code │ Gemini CLI │ Codex CLI │ Grok CLI              │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│                      ~/os8/ (User Data)                       │
├──────────┬───────────┬───────────┬────────────┬──────────────┤
│  apps/   │  config/  │   blob/   │   core/    │   skills/    │
│ App src  │  os8.db   │ File store│ React/Vite │ Skill APIs   │
│ (React)  │ (SQLite)  │ (per-app) │ (shared)   │ (discovered) │
└──────────┴───────────┴───────────┴────────────┴──────────────┘
```

### Startup & Shutdown Lifecycle

**Startup** (in `src/server.js` → `createServer()`):
1. **Express server** starts on port 8888 (configurable)
2. **Vite middleware** enables JSX/CSS transformation
3. **Memory pre-loading** — pre-loads memory cache for all agents
4. **Memory watchers** — file watchers on MYSELF.md/USER.md for auto-reindexing
5. **Digest engine** — automatic session + daily digest generation (2h interval)
6. **Telegram watchers** — polls Telegram DMs and group messages for incoming messages (operational agents only)
7. **Job scheduler** — manages timed job execution via `JobSchedulerService`
8. **Skill security reviews** — queues background LLM reviews for pending catalog skills
9. **Whisper Streaming Server** auto-starts if installed (port 9090)

**First-Run Onboarding** (in `src/renderer/onboarding.js`):
On first launch (`onboarding_complete` not set), a full-screen overlay guides the user through setup:
1. **Setup splash** — installs Core services (React/Vite/Tailwind) and all 4 CLI backends in parallel
2. **Identity** — user's first name (stored as `user_first_name`)
3. **AI Backend** — configure at least one provider (login or API key). Anthropic primary
4. **Image AI** — at least one image-capable provider (Gemini/OpenAI/Grok). Auto-detected from step 3
5. **Voice** — ElevenLabs or OpenAI TTS key (recommended, skippable)
6. **OS8 Account** — Google OAuth sign-in (optional)
7. **Handoff** — opens assistant app, which triggers the 8-step agent creation wizard

Supports resume on relaunch (`onboarding_step` tracks progress). Existing users skip onboarding automatically (migration detects existing agents).

**On-demand Whisper install:** When user clicks mic button and whisper is not installed, a dialog offers local setup (compile whisper.cpp) or cloud fallback (OpenAI API). Not part of onboarding — triggered at point of use (`src/renderer/whisper-setup-dialog.js`).

**Shutdown** (in `main.js` → `window-all-closed`):
1. Kills all PTY terminal sessions
2. Destroys all BrowserView preview panels
3. Stops DigestEngine, memory watchers, Telegram watchers
4. Stops Whisper streaming server
5. Closes Vite and Express servers
6. Closes SQLite database

**Note:** On macOS, closing all windows doesn't quit the app. Use Cmd+Q or Ctrl+C for full shutdown. If force-killed, background services may need manual cleanup: `pkill -f whisper-stream-server`

## Agent System

Agents are first-class entities in OS8. Each agent is an AI personality with its own backend, memory, skills, and scheduled jobs. Agents have a **visibility** setting (`visible`/`hidden`/`off`) that controls their presence in UI selectors and whether background services (jobs, Telegram, memory watchers, digests) run for them.

### Agent Architecture

Agents live under a shared parent app (`~/os8/apps/{parentAppId}/agents/{agentId}/`). Each agent has:

| Component | Location |
|-----------|----------|
| Identity files | `MYSELF.md`, `USER.md`, `PRINCIPLES.md`, `MOTIVATIONS.md` |
| Skills | `skills/` (agent-specific skill overrides) |
| Docs | `docs/` (identity documents, reference material) |
| Instruction files | `CLAUDE.md`, `GEMINI.md`, `AGENTS.md`, `.grok/GROK.md` |
| Jobs | `jobs.json` |
| Tasks | `tasks.json` |
| Blob storage | `~/os8/blob/{parentAppId}/{agentId}/` |

### Agent Configuration

| Field | Purpose |
|-------|---------|
| `name` | Display name |
| `slug` | URL-safe identifier |
| `backend` | AI backend ID (`claude`, `gemini`, `codex`, `grok`) |
| `model` | Specific model override, or `auto` (default — uses routing cascades) |
| `owner_name` | Name of the agent's owner |
| `pronouns` | How to refer to the agent |
| `gender` | Agent gender (`male`/`female`) — sets pronouns automatically |
| `role` | Agent role description (from setup wizard or custom) |
| `appearance` | Physical appearance description |
| `voice_id` | ElevenLabs voice ID for TTS (per-agent) |
| `voice_name` | Display name of selected voice |
| `voice_archetype` | Personality/tone description |
| `show_image` | Toggle agent image view (default off, enabled when avatar selected) |
| `visibility` | Agent visibility: `visible` (default), `hidden` (runs but not in UI), `off` (fully inactive) |
| `birth_date` | Agent birth date (dynamic aging, replaces static `age`) |
| `subconscious_memory` | Enable subconscious memory processor (default ON) |
| `subconscious_depth` | Memory depth level 1-3: Instant/Standard/Deep (default 2) |
| `telegram_bot_token` | Telegram bot for messaging |
| `telegram_chat_id` | DM chat for direct messages (auto-registered from first DM) |
| `telegram_owner_user_id` | Owner's Telegram user ID (for verifying sender in group chats) |

### Multi-Backend Architecture

The backend adapter (`src/services/backend-adapter.js`) abstracts CLI differences:

| Backend | CLI | Headless Flag | Output Format | Instruction File |
|---------|-----|---------------|---------------|------------------|
| Claude | `claude` | `-p` (bare flag) | `{"type":"result"}` | `CLAUDE.md` |
| Gemini | `gemini` | `-p "prompt"` | `{"type":"result"}` | `GEMINI.md` |
| Codex | `codex` | `-p "prompt"` | Legacy | `AGENTS.md` |
| Grok | `grok` | `-p "prompt"` | `{"role":"assistant"}` JSONL | `.grok/GROK.md` |

### Memory System

Agents use an **automatic 4-tier hierarchical memory system** with an optional **subconscious memory processor** layer. All recording is DB-only (no MD file writes or JSON backups). The `DigestEngine` (`src/services/digest-engine.js`) runs on a 2-hour timer, automatically creating session and daily digests for all agents using Anthropic SDK (Haiku).

#### Subconscious Memory Processor

When enabled (`subconscious_memory = 1`), the `SubconsciousService` (`src/services/subconscious.js`) sits between raw memory assembly and the agent's context window. It reads all raw context (identity, memory tiers, semantic search, principles) and produces a structured 12-section output:

1. **Action classification** — CONVERSATIONAL or TOOL_USE (first, with stop-sequence early exit)
2. **Present moment** — time, surroundings, current state
3. **Conversation objectives** — what the agent is trying to accomplish
4. **Response objectives** — what this specific reply should do + register
5. **Who I am** — identity compressed to current objectives
6. **Who I'm talking to** — owner portrait for current objectives
7. **How we relate** — active relationship principles
8. **Relevant context** — facts, decisions, emotional threads
9. **Aware but unsurfaced** — threads to hold lightly (optional)
10. **What to avoid** — documented failure patterns
11. **Conversation flow + Recent exchange** — narrative + verbatim last turns
12. **Recommended response** — complete draft response as the agent

Each section references specific XML-tagged sources from raw context (`<myself>`, `<user>`, `<principles>`, `<motivations>`, `<present_moment>`, `<recent_history>`, `<session_summaries>`, `<daily_summaries>`, `<relevant_memory>`).

**Action classification** is section 1 — TOOL_USE outputs a `---END---` stop sequence that halts generation after ~20 tokens (instead of generating 4-16K tokens of unused sections). This works across all 4 providers (Anthropic, OpenAI, Gemini, xAI). CONVERSATIONAL continues naturally into sections 2-12 in the same LLM call.

**Depth slider** (per-agent, 1-3): Controls word budgets per section across three levels. Instant (1) skips sections 2-11 entirely and responds directly from raw context. Standard (2) produces ~1,200 words of context. Deep (3) produces ~2,050 words. Also scales `maxTokens` on the API call (4096→6144). Default: 2 (Standard).

**On TOOL_USE**: The CLI agent receives full raw context (identity + memory + skills) directly — no summarized context needed. On **CONVERSATIONAL**: The recommended response (section 12) is sent directly to the user (single LLM call).

#### PRINCIPLES.md

`PrinciplesService` (`src/services/principles.js`) extracts cross-cutting behavioral principles and domain syntheses from the full conversation corpus. Two-section output: principles (behavioral patterns) + domain syntheses (topic-based knowledge with Story/Anchors/Open Questions). Injected into identity context via `<principles>` XML tag. Currently triggered manually via `POST /api/agents/:id/principles/generate`.

#### MOTIVATIONS.md

Optional per-agent file defining enduring missions, stakes, and an appraisal framework for emotional responses. Injected into identity context via `<motivations>` XML tag by `buildMotivationsContext()` in `identity-context.js`. Referenced by the subconscious processor in sections 2 (conversation objectives), 3 (response objectives), 4 (who I am), 7 (relevant context), and 9 (what to avoid). Also injected into the Agent Life prompt for per-cycle `missionCheck` reflections, and drives the `motivations-update` skill for periodic goal-setting and accountability reporting.

#### Context Assembly

**Context assembly** (`getContextForMessage` in `src/assistant/memory.js`):

1. **Tier 1: Raw entries** (full fidelity, budget-gated ~40%) — `conversation_entries` table
   - Most recent conversation entries, anchored from `lastActivity` (not wall clock)
   - Channels: `desktop`, `telegram`, `telegram-group`, `phone`, `job`
   - Tagged entries: `is_spark` for important moments, `internal_tag` for classification

2. **Tier 2: Session digests** (24h window, ~35%) — `conversation_digests` table (`level='session'`)
   - 2-hour conversation blocks compressed by LLM
   - Auto-generated by DigestEngine every 2 hours
   - Provides summarized view alongside raw entries

3. **Tier 3: Daily digests** (7-day window, ~25%) — `conversation_digests` table (`level='daily'`)
   - Day-level rollups of session digests
   - Auto-generated by DigestEngine (catch-up on first tick after midnight)

4. **Tier 4: Semantic search with drill-down** (35% of total budget) — `memory_chunks` + `memory_sources` tables
   - Identity files (MYSELF.md, USER.md) + digest embeddings for cosine similarity search
   - Composite search query built from keywords + recent messages
   - Drill-down: when a digest hit is found, pulls supporting session digests and raw entries from that time range
   - Hybrid search: vector (embeddings) + BM25 (FTS5 full-text) with RRF fusion
   - Auto-reindexed when identity files change (via memory watchers on MYSELF.md/USER.md)

**Backfill**: `POST /api/assistant/digest/backfill` processes all historical entries into session + daily digests (one-time migration for existing agents).

### Agent-to-Agent Messaging (Group Chat)

Agents communicate via threads (`agent_threads` + `agent_messages` tables):
- Group threads with multi-agent conversations, per-agent TTS voice output, and participant images
- **Moderator service** — LLM-powered turn-taking for group threads (3+ participants), user-name-aware for natural turn-yielding, auto-continue re-evaluation after agents finish
- **Thread orchestrator** — coordinates group/DM response flow via WorkQueue; DM circuit breaker with configurable limit and auto-reset with exponential backoff; auto-delivers responses to linked Telegram groups
- **TTS audio prefetch** — while one agent speaks, the next agent's audio is pre-generated and buffered via a second WebSocket; replayed instantly on transition for near-zero inter-agent gap (`src/shared/tts-stream-core.js`)
- **Telegram group chats** — Telegram groups with multiple agent bots are mapped to OS8 threads via `telegram_groups` table; messages routed through ThreadOrchestrator with moderator turn-taking, participant images, and per-agent memory recording (same experience as in-app group chats)
- Thread management UI: delete, clear messages, status indicators

### Simulation & Life System

Agents run life routines and simulations (`src/services/sim.js`):
- **Reverie** — reflective thinking exercises
- **Journal** — periodic journaling with context, includes `missionCheck` field (per-mission emotional check-in) when agent has MOTIVATIONS.md
- **Snapshot** — image generation based on current state
- **Portrait** — standalone selfie/current-image generation from `currentState`
- **Life Items** — CRUD for outfits, settings (locations), and hairstyles that define agent appearance
- **Motivations Update** — periodic mission assessment, concrete goal-setting, and formatted Telegram delivery (`motivations-update` skill, auto-provisioned for agents with MOTIVATIONS.md)

### Embodiment System

The `EmbodiedService` (`src/services/embodiment.js`) provides simulated physical presence for agents:
- Boolean toggle — when active, injects a humanoid body context block
- Persistent state stored per-agent in `{agentDir}/embodiment.json`
- API: `GET /api/embodiment/status`, `POST /api/embodiment/enter`, `POST /api/embodiment/exit`

### Account System

`AccountService` (`src/services/account.js`) handles OS8.ai sign-in:
- Google OAuth + PKCE authentication flow
- Local profile caching
- IPC handlers in `src/ipc/account.js`, renderer UI in `src/renderer/account.js`

## Capabilities System

OS8 uses a unified capabilities system. `CapabilityService` (`src/services/capability.js`) handles runtime CRUD, search, and pins; `CapabilitySyncService` (`src/services/capability-sync.js`) handles discovery from filesystem, routes, and MCP servers. Capabilities come in three types:

- **APIs** — Auto-registered from route `.meta` exports (e.g., `src/routes/speak.js` exports `.meta`). These are the primary interface for most services.
- **Skills** — Multi-step workflow SKILL.md files in `~/os8/skills/`. Used for complex orchestration (app-builder, app-enhancer, plan).
- **MCP** — Tools discovered from running MCP servers (`McpServerService`), proxied as REST endpoints at `POST /api/mcp/{serverId}/{toolName}`.

### How Capabilities Work

```
Route modules (src/routes/*.js)
  └── Export .meta (name, description, endpoints)
        ↓
    CapabilitySyncService.syncApis() registers as type='api'
        ↓
~/os8/skills/
  ├── app-builder/SKILL.md
  └── app-enhancer/SKILL.md
        ↓
    CapabilitySyncService.syncSkills() registers as type='skill'
        ↓
    GET /api/skills/registry returns all capabilities
        ↓
    App CLAUDE.md files auto-include "Available Capabilities" section
```

### Search & Context

- Semantic search with embeddings + FTS5 keyword search
- API capabilities get a 2x score boost (compensates for thinner descriptions)
- `getForContext()` reserves slots per type (top 3 APIs + top 3 skills → merge → top 5)
- Agents can pin up to 5 capabilities for always-in-context access

### Skill Catalog (ClawHub)

Beyond local capabilities, OS8 has a skill catalog synced from external registries:
- `skill_catalog` table stores browsable/installable skills
- `SkillCatalogService` (`src/services/skill-catalog.js`) handles sync and full directory download
- Usage tracking (`capability_usage` table) feeds ranking

### Security Review & Quarantine

Community skills installed from ClawHub undergo LLM-powered security review before agents can use them:

1. **Install** — Skill downloaded (full directory from GitHub), quarantined (`quarantine = 1, review_status = 'pending'`)
2. **Review** — `SkillReviewService` (`src/services/skill-review.js`) scans all files via Anthropic SDK, produces structured report with risk level (low/medium/high) and findings
3. **Approve/Reject** — User reviews report and approves (unquarantines) or rejects each skill individually in Settings > Capabilities
4. **Re-quarantine** — If skill content changes on disk (body_hash mismatch), previously approved skills are re-quarantined for re-review

What gets reviewed: file system access, outbound network calls, credential harvesting, obfuscated code, typosquatted packages, exec install steps, excessive permissions. Bundled and local skills skip review.

### Current Capabilities

| Type | Name | Provider | Purpose |
|------|------|----------|---------|
| api | google | Google OAuth | Calendar, Gmail, Drive APIs |
| api | transcribe | Local (ffmpeg + whisper) | Video to text transcription |
| api | speak | ElevenLabs API | Text to audio file generation |
| api | imagegen | OpenAI + Grok + Gemini | AI image generation with references |
| api | voicemessage | ElevenLabs + Telegram | Send voice messages via Telegram |
| api | youtube | Local (yt-dlp) | Video info and transcript extraction |
| api | telegram | Telegram Bot API | Send messages/photos/documents |
| api | app-db | Local (SQLite) | Per-app database (query, execute, batch, schema) |
| api | app-blob | Local (filesystem) | Per-app file storage (upload, read, list, delete) |
| skill | app-builder | Local (CLI backends) | Create and build new apps headlessly |
| skill | app-enhancer | Local (CLI backends) | Inspect, plan, build, verify existing apps |
| skill | plan | Local (Opus + WorkQueue) | Multi-step planning with dependency tracking |
| skill | motivations-update | Local (WorkQueue) | Periodic mission assessment, goal-setting, Telegram delivery |
| skill | action-planner | Local (WorkQueue) | Reviews missions, schedules one concrete job per mission per period |
| skill | skill-builder | Local (filesystem) | Create new skills as reusable workflows, optionally with timed jobs |

### SKILL.md Format

```yaml
---
name: video-transcribe
description: Convert video files to text transcripts using local Whisper
provider: os8
requires:
  dependencies:
    - ffmpeg
    - whisper
endpoints:
  - method: GET
    path: /api/transcribe/status
  - method: POST
    path: /api/transcribe
---

# Video Transcription

Full markdown documentation with examples, parameters, responses...
```

## AI Registry

The AI registry manages providers, containers (CLI tools), and models:

| Table | Purpose |
|-------|---------|
| `ai_providers` | Provider definitions (Anthropic, Google, OpenAI, xAI) |
| `ai_containers` | CLI tool configs (command, instruction file, login) |
| `ai_models` | Model variants per container (Opus, Sonnet, Haiku, etc.) |
| `api_key_catalog` | API key metadata (env var, URL, placeholder) |

Seeded providers: Anthropic, Google, OpenAI, xAI.

Seeded API keys: `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, `ELEVENLABS_API_KEY`, `FAL_API_KEY`.

## Intelligent Model Routing

The `RoutingService` (`src/services/routing.js`) automatically selects the best available model for each task type based on cascading priorities, provider availability, and user preference.

### Task Types

| Task Type | Used By | Description |
|-----------|---------|-------------|
| `conversation` | Agent chat, Telegram | Interactive chat — allows agent model override |
| `jobs` | Job scheduler, work queue | Scheduled tasks — access method per provider via Model API Constraints |
| `planning` | App enhancer, plan executor | Architecture/planning tasks |
| `coding` | App builder | Code generation tasks |
| `summary` | Digest engine | Memory compression — access method per provider via Model API Constraints, defaults to minimize_cost |

### How Routing Works

1. **Agent override** (conversation only): If agent has a specific model set, try it first
2. **Cascade walk**: Iterate through ordered entries for the task type, each a `(family_id, access_method)` pair
3. **Availability check**: Skip entries where the provider is exhausted or missing credentials
4. **Hard fallback**: `claude-sonnet` via API if nothing else available

### Optimization Preference

Users set a per-task-type preference in OS8 Settings that controls cascade ordering:
- **Best quality** — highest-ability models first, cost secondary
- **Balanced** — weighted blend of ability and cost
- **Minimize cost** — cheapest available models first, login (sunk-cost) entries discounted

Each task type (conversation, jobs, planning, coding, summary) can have its own preference, allowing e.g. best quality for coding but minimize cost for jobs.

### Model API Constraints

Per-provider per-task access method controls are configurable in OS8 Settings > AI Models > Model API Constraints. Each provider × task type cell can be set to:
- **Login & API** (both) — cascade includes both login and API entries
- **API only** — cascade restricted to API key access only
- **Login only** — cascade restricted to subscription login access only

Defaults: Jobs and Summary default to API-only for all providers; other task types default to both. Changing constraints regenerates all affected cascades.

### Consumer-Side: Lightweight LLM Calls

Services that need a text-only LLM call (no tool use, no streaming) use `sendTextPrompt()` from `cli-runner.js`. It takes a `resolved` object from `RoutingService.resolve()` and handles the SDK-vs-CLI decision internally. `familyToSdkModel()` maps routing family IDs to Anthropic SDK aliases. See Design Principles section 12 for the full pattern.

### Reactive Exhaustion

When a provider returns billing/rate-limit errors, `RoutingService.markExhausted()` temporarily removes it from routing (1-hour TTL). This prevents repeated failures.

### Billing & Account Status

`BillingService` (`src/services/billing.js`) checks provider status:
- API key validation via provider endpoints
- Login/plan detection via CLI status commands or auth files
- Account status displayed in OS8 Settings (green/yellow/red indicators)

### Model Discovery

`ModelDiscoveryService` (`src/services/model-discovery.js`) auto-discovers new model versions from provider APIs and updates the `ai_models` table.

## Key Workflows

### Creating an App

1. User clicks New App
2. `AppService.create()` generates ID, creates directories
3. `scaffoldApp()` creates React template files
4. `generateClaudeMd()` creates environment documentation
5. Tab opens, terminal starts with selected AI backend

### Agent Chat

1. User sends message in agent chat panel
2. Message stored in `conversation_entries`
3. Memory context assembled (4-tier: raw entries + session digests + daily digests + semantic search)
4. If subconscious enabled: `SubconsciousService.process()` classifies as CONVERSATIONAL or TOOL_USE (section 1, with stop-sequence early exit on TOOL_USE)
5. If CONVERSATIONAL: curated context (sections 2-11) + recommended response (section 12) sent directly to user (single LLM call)
6. If TOOL_USE (or subconscious disabled): `RoutingService.resolve()` selects best model, backend adapter spawns CLI with full raw context
7. Response streamed via SSE to UI
8. Response stored in `conversation_entries`

### Job Scheduling

1. Jobs defined in `jobs.json` per agent (or via `/api/jobs` API)
2. `JobSchedulerService` checks for due jobs on each tick, auto-provisions mandatory jobs (e.g., `motivations-update` for agents with MOTIVATIONS.md)
3. Due job claimed with lease to prevent double-execution
4. `WorkQueue` spawns CLI backend with job prompt (server-orchestrated jobs like `agent-life` and `motivations-update` use text-only mode)
5. Completion notes stored in run history
6. Orphan recovery handles stuck `claimed`/`running` jobs

### Planning

1. User sends `/plan [request]` in agent chat
2. `PlanGeneratorService` builds prompt with agent roster, capabilities, and OS8 platform context
3. Opus generates structured plan (JSON with steps, dependencies, completion criteria)
4. `PlanService.create()` stores plan + steps in DB, translates seq-number dependencies to step IDs
5. User reviews, then `/approve`, `/modify`, or `/cancel`
6. `PlanExecutorService` walks dependency graph, dispatches each step to target agent via WorkQueue
7. Step agents receive original user request + step description + previous results
8. Progress streamed via SSE, completion summary with extracted outputs (app IDs, URLs, paths)
9. Crash recovery: `resume()` marks interrupted steps as failed, continues with poll-based fallback

### Voice Calls

1. `CallService` creates call with Cloudflare tunnel for public URL
2. Browser joins via `/call/{id}` page
3. WebSocket (`/api/call/:id/stream`) handles bidirectional audio
4. STT (Whisper) → LLM (Anthropic SDK, no tools) → TTS (ElevenLabs or OpenAI)
5. Audio streamed back in real-time

## Data Model

SQLite database at `~/os8/config/os8.db`:

### Per-App Databases

Each app can also have its own SQLite database at `~/os8/apps/{appId}/data.db`, created lazily on first API call via `/api/apps/:appId/db/*`. Apps use `fetch()` to query/execute SQL through the shared Express server — no additional servers needed. Managed by `AppDbService` (`src/services/app-db.js`).

### Per-App Blob Storage

Each app has a blob directory at `~/os8/blob/{appId}/` for file uploads, images, and generated assets. Apps access it at runtime via `/api/apps/:appId/blob/*` (upload, read, list, delete). 20 MB upload limit, files timestamped to avoid collisions.

### Core Tables

| Table | Purpose |
|-------|---------|
| `apps` | App registry (id, name, slug, color, icon, app_type, status) |
| `agents` | Agent config (backend, model, owner, pronouns, voice, telegram, etc.) |
| `settings` | Global settings (port, chat limits, moderator model) |
| `claude_instructions` | Global Claude instructions |
| `env_variables` | Shared API keys |
| `app_env_variables` | Per-app key overrides |

### Memory & Conversation

| Table | Purpose |
|-------|---------|
| `conversation_entries` | Real-time chat memory (speaker, channel, content, is_spark, internal_tag) |
| `conversation_digests` | Hierarchical digests (level: session/daily, with date_key) |
| `memory_sources` | Source tracking for reindex (identity files + digest embeddings) |
| `memory_chunks` | Text chunks with embeddings (identity files + digest search index) |
| `embedding_cache` | Shared embedding cache (composite key: text_hash + model) |
| `memory_fts` | FTS5 virtual table for full-text search |

### Agent Messaging

| Table | Purpose |
|-------|---------|
| `agent_threads` | Conversation threads (type, participants, moderator_model) |
| `agent_messages` | Messages in threads (sender, content, triggered_by) |
| `telegram_groups` | Telegram group → agent_thread mapping |
| `agent_chat_budget` | Daily chat budget tracking per agent |
| `agent_life_items` | Outfits, settings, hairstyles per agent (type, name, description, tags) |
| `agent_life_entries` | Per-tick state: outfit/setting/hairstyle IDs, activity, mood, narrative, reflections, mission_check, portrait |
| `agent_motivation_updates` | Periodic mission assessments, goals, blockers, formatted message (from motivations-update skill) |

### Planning

| Table | Purpose |
|-------|---------|
| `plans` | Plan registry (agent_id, request, summary, status: draft→approved→executing→completed/failed) |
| `plan_steps` | Steps with seq, description, agent_id, depends_on (step IDs), status, result |

### Capabilities

| Table | Purpose |
|-------|---------|
| `capabilities` | Unified registry (type='api', 'skill', or 'mcp'; includes review_status, review_risk_level, quarantine for security gating) |
| `skill_catalog` | Synced from ClawHub (browsable, installable) |
| `agent_pinned_capabilities` | Max 5 pinned capabilities per agent |
| `capability_usage` | Usage tracking for ranking |
| `capability_fts` / `skill_catalog_fts` | FTS5 indexes for keyword search |

### AI Models & Keys

| Table | Purpose |
|-------|---------|
| `ai_providers` | Provider definitions (Anthropic, Google, OpenAI, xAI) |
| `ai_containers` | CLI tool configurations |
| `ai_models` | Model variants per container |
| `api_key_catalog` | API key metadata (env_key, label, URL, placeholder) |

### OAuth

| Table | Purpose |
|-------|---------|
| `provider_credentials` | User's OAuth app credentials |
| `connections` | OAuth access tokens |
| `connection_grants` | App-level connection permissions |

## User Interface

### Home View

- **App grid** — Icons with color and letter/emoji
- **Settings button** — Background, font color, AI models, API keys
- **Trash button** — View/restore archived apps
- **New App button** — Create app flow

### Workspace View (Developer Mode)

```
┌────────────────────────────────────────────────────┐
│ [Tab Bar]  Home | App1 | App2 ×        [User|Dev] │
├────────────────────────────────────────────────────┤
│           │                    │ Tasks [To-dos|Jobs]│
│  Terminal │    Preview         ├───────────────────┤
│  (AI CLI) │    (BrowserView)   │ Storage [Sys|Data]│
│           │                    │ [File/Data tree]  │
└───────────┴────────────────────┴───────────────────┘
```

- **Terminal**: AI CLI (Claude, Gemini, Codex, or Grok) + agent chat panel
- **Tasks Panel**: Toggle between To-dos and Timed Jobs
- **Storage Panel**: Toggle between System Files, Data Storage (memory), and File Storage (blob)

### User Mode

- **Focus mode**: Single app fullscreen
- **Split mode**: Two apps side-by-side
- Toggle between modes with expand/contract button

### Agent Chat Panel

Built into the terminal area, provides:
- Chat interface with the active agent
- SSE streaming for real-time responses
- Thread management for agent-to-agent conversations
- Setup wizard for new agents (role, avatar, voice, skills)

## App Structure

Each app in `~/os8/apps/` follows this structure:

```
{app-id}/
├── index.html          # Entry point
├── src/
│   ├── main.jsx        # React entry with BrowserRouter
│   ├── App.jsx         # Main component
│   ├── index.css       # Tailwind imports
│   └── components/     # User-created components
├── agents/             # Agent subdirectories (system apps only)
│   └── {agent-id}/
│       ├── MYSELF.md, USER.md, PRINCIPLES.md, MOTIVATIONS.md
│       ├── CLAUDE.md, GEMINI.md, etc.
│       ├── skills/, docs/
│       ├── jobs.json, tasks.json
│       └── ...
├── data.db             # Per-app SQLite database (created on first use)
├── tasks.json          # Backlog
├── CLAUDE.md           # Auto-generated environment docs
└── claude-user.md      # User's custom instructions
```

## Core Services

The `~/os8/core/` directory contains shared dependencies:

```
core/
├── node_modules/      # React, Vite, Tailwind, etc.
├── package.json       # Dependency manifest
├── vite.config.js     # Vite configuration (middleware mode)
├── tailwind.config.js # Tailwind content paths
└── postcss.config.js  # PostCSS with Tailwind plugin
```

**How it works:**
1. Vite runs as Express middleware (not standalone dev server)
2. When a request comes in for `/{app-id}/`, server maps to app directory
3. Vite transforms JSX and processes Tailwind CSS on-the-fly
4. Hot Module Replacement works via WebSocket

## Tech Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| Desktop | Electron | Window management, native integration |
| UI | ES6 modules + modular CSS (`styles/`) | Renderer (index.html + src/renderer/*.js) |
| Database | SQLite (better-sqlite3) | App registry, agents, settings, memory |
| Terminal | node-pty + xterm.js | AI CLI integration |
| Preview | Electron BrowserView | Isolated app rendering |
| Server | Express | Static files + Vite middleware + API routes |
| Build | Vite 5 | JSX transformation, HMR, Tailwind |
| App Framework | React 18 | Component-based UI for apps |
| Styling | Tailwind CSS 3 | Utility-first CSS for apps |
| Routing | React Router 6 | Client-side routing for apps |
| AI Backends | Claude Code, Gemini CLI, Codex CLI, Grok CLI | Multi-backend agent support |
| Voice | whisper.cpp + ElevenLabs + OpenAI | Speech-to-text + text-to-speech (multi-provider) |
| Messaging | Telegram Bot API | Agent messaging channel |

## External APIs

| Service | Purpose | Config |
|---------|---------|--------|
| Anthropic | Claude Code CLI + direct SDK for voice calls | `ANTHROPIC_API_KEY` |
| Google | Gemini CLI + OAuth (Calendar, Gmail, Drive) | `GOOGLE_API_KEY` + OAuth credentials |
| OpenAI | Codex CLI + Whisper STT (batch) + TTS provider | `OPENAI_API_KEY` |
| xAI | Grok CLI | `XAI_API_KEY` |
| ElevenLabs | Text-to-speech provider (streaming + REST) | `ELEVENLABS_API_KEY` |
| fal.ai | Video generation | `FAL_API_KEY` |
| Telegram | Agent messaging (send/receive) | Per-agent bot tokens |
| Cloudflare | Quick tunnels for public voice call URLs | No key needed |
| ClawHub | Skill catalog sync | No key needed |

## Core Documentation

| Document | Purpose | Audience |
|----------|---------|----------|
| `CLAUDE.md` | Routing hub — file locations, service tables, skill index | Claude Code (AI) |
| `OS8 Project Context.md` | This document — philosophy, architecture, data model | Humans + Claude |
| `OS8-project-design-principles.md` | Code patterns, naming, anti-patterns | Claude Code (AI) |
| `SESSION_LOG.md` | Running history of development sessions | Humans + Claude |
| `skills/session-start.md` | Protocol for starting a dev session | Claude Code |
| `skills/session-close.md` | Protocol for ending a dev session | Claude Code |
