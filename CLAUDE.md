# OS8 - Claude Guide

**Purpose:** Desktop app for building custom web apps with AI agents. Electron shell + Express server + React/Vite apps.

**Repository:** https://github.com/os8ai/os8

For architecture and philosophy, see [OS8 Project Context.md](OS8%20Project%20Context.md).

For code patterns and conventions, see [OS8-project-design-principles.md](OS8-project-design-principles.md).

## Quick Orientation

1. OS8 is an **Electron app** — main process (`main.js`) + renderer (`index.html`)
2. User data lives in `~/os8/` — apps, config, blob storage, Core
3. Apps are React/Tailwind, powered by shared Core (`~/os8/core/`)
4. Each app gets its own CLAUDE.md generated when opened (see `src/services/app.js`)
5. Agents use multiple AI backends (Claude, Gemini, Codex, Grok) via `src/services/backend-adapter.js`

## File Locations

| Content | Location |
|---------|----------|
| Electron main process | `main.js` (lifecycle only, ~150 lines) |
| IPC handlers | `src/ipc/*.js` (organized by domain) |
| Renderer (UI) | `index.html` + `src/renderer/main.js` (bootstrap) |
| Renderer styles | `styles.css` → `styles/` (variables, primitives, layout, components, panels, modals, animations, onboarding) |
| Renderer modules | `src/renderer/*.js` |
| Shared modules | `src/shared/*.js` (used by shell and apps; includes `tts-stream-core.js` — TTS playback with audio prefetch) |
| Agent services | `src/assistant/*.js` (memory, telegram, identity) |
| Database initialization | `src/db.js` |
| Services | `src/services/*.js` |
| Utility helpers | `src/utils/file-helpers.js` |
| App templates | `src/templates/` |
| CLAUDE.md generators | `src/claude-md.js` |
| Shared utilities | `src/utils.js` |
| Path constants | `src/config.js` |
| Express server | `src/server.js` |
| Telegram watcher lifecycle | `src/server-telegram.js` (DM processing + group chat handler) |
| IPC bridge | `preload.js` |
| Tests | `tests/*.test.js` |
| Documentation | `docs/` |

## User Data (`~/os8/`)

| Directory | Purpose |
|-----------|---------|
| `apps/` | App source code (React/JSX) |
| `config/` | SQLite database (`os8.db`) |
| `blob/` | Per-app file storage |
| `core/` | Shared React/Vite/Tailwind environment |
| `models/` | ML models (whisper.cpp for speech-to-text) |
| `skills/` | Internal APIs for apps (auto-discovered) |

## Services (`src/services/`)

| Module | Purpose |
|--------|---------|
| `account.js` | AccountService (os8.ai sign-in, PKCE auth flow, local profile cache) |
| `app.js` | AppService CRUD, scaffoldApp, generateClaudeMd |
| `app-db.js` | AppDbService (per-app SQLite databases, lazy creation, connection cache, SQL safety) |
| `agent.js` | AgentService (agent CRUD, config, paths, hard delete, visibility filtering) |
| `agent-chat.js` | AgentChatService (thread/message management) |
| `agent-state.js` | Agent runtime state management |
| `ai-registry.js` | AI provider/container/model management |
| `anthropic-sdk.js` | Direct Anthropic API calls (no tool use, supports utility mode with null appPath) |
| `app-builder.js` | AppBuilderService (headless app builds via CLI backends) |
| `app-inspector.js` | AppInspectorService (BrowserView screenshots + console errors) |
| `backend-adapter.js` | Backend adapter (maps backend ID → CLI command, flags, parsers) |
| `billing.js` | BillingService (login detection, API balance checks) |
| `cli-runner.js` | Unified CLI spawn, env prep, response parsing, `familyToSdkModel()`, `sendTextPrompt()` for lightweight LLM calls |
| `call.js` | CallService (voice call state, tokens, lifecycle) |
| `claude-instructions.js` | ClaudeInstructionsService |
| `claude-protocol.js` | Claude CLI argument building, response parsing |
| `connections.js` | ConnectionsService, PROVIDERS (OAuth) |
| `conversation.js` | ConversationService (conversation entries CRUD) |
| `core.js` | CoreService (React/Vite/Tailwind setup) |
| `data-storage.js` | DataStorageService (auto-discovers agent-scoped tables for UI) |
| `digest.js` | DigestService (hierarchical memory compression) |
| `digest-engine.js` | DigestEngine (automatic session + daily digest generation) |
| `env.js` | EnvService (environment variables) |
| `buzz.js` | BuzzService (simulated drinking system, level-based personality modification) |
| `imagegen.js` | ImageGenService (AI image generation) |
| `job-scheduler.js` | JobSchedulerService (timed job execution) |
| `jobs-file.js` | JobsFileService (timed jobs, scheduling, run log) |
| `model-discovery.js` | ModelDiscoveryService (auto-discover new models from provider APIs) |
| `moderator.js` | ModeratorService (group chat turn-taking via LLM, user-name-aware turn-yielding) |
| `plan.js` | PlanService (plan/step CRUD, dependency validation) |
| `plan-command.js` | PlanCommandService (plan command parsing, orchestration for /plan, /approve, /cancel, /reject, /modify) |
| `plan-executor.js` | PlanExecutorService (plan step orchestration, crash recovery) |
| `plan-generator.js` | Planning prompt builder + Opus LLM call (v2 swap point) |
| `principles.js` | PrinciplesService (cross-cutting principles + domain syntheses extraction from conversation corpus) |
| `process-runner.js` | Low-level spawn/PTY utilities |
| `routing.js` | RoutingService (model routing cascades, exhaustion, per-task optimization preference, per-provider API constraints, per-family eligible_tasks filtering) |
| `settings.js` | SettingsService (global settings, voice settings, model API constraints) |
| `sim.js` | SimService (agent life: reverie, journal, snapshot, portrait, life items) |
| `sim-helpers.js` | SimService helpers (identity building, myself/schedule loading, time formatting) |
| `sim-life-items.js` | Life items CRUD and life entry queries (outfits, settings, hairstyles) |
| `sim-portrait.js` | Portrait generation pipeline (prompt, reference images, generation, storage) |
| `embodiment.js` | EmbodiedService (humanoid body embodiment toggle, context injection) |
| `capability.js` | CapabilityService (runtime CRUD, search, pins, availability, context) |
| `capability-sync.js` | CapabilitySyncService (sync from filesystem, routes, MCP servers; SKILL.md parsing) |
| `mcp-server.js` | McpServerService (MCP server lifecycle, tool discovery, proxy) |
| `mcp-catalog.js` | McpCatalogService (MCP server catalog browse, search, install) |
| `skill-catalog.js` | SkillCatalogService (ClawHub sync, full directory download, install) |
| `skill-review.js` | SkillReviewService (LLM security review, approve/reject, quarantine lifecycle, dependency install) |
| `speak.js` | SpeakService (text to audio via ElevenLabs REST API) |
| `stream-tracker.js` | StreamStateTracker (Claude stream event parsing, step labeling, post-hoc extraction) |
| `subconscious.js` | SubconsciousService (goal-driven context curation between raw memory and agent, 12-section structured output, standalone lightweight classifier, depth slider, motivations-aware) |
| `tasks-file.js` | TasksFileService (JSON-based task management) |
| `telegram.js` | TelegramService (Telegram Bot API client) |
| `thread-orchestrator.js` | ThreadOrchestrator (group/DM response coordination, DM circuit breaker with auto-reset, Telegram group delivery) |
| `transcribe.js` | TranscribeService (video to text via ffmpeg + whisper) |
| `tts.js` | TTSService facade (routes to active provider: ElevenLabs or OpenAI) |
| `tts-elevenlabs.js` | ElevenLabs TTS provider (voice listing, audio generation, WebSocket streaming) |
| `tts-openai.js` | OpenAI TTS provider (voice listing, audio generation, PCM streaming) |
| `tunnel.js` | TunnelService (Cloudflare tunnel for public call URLs) |
| `videogen.js` | Video generation service |
| `whisper.js` | WhisperService (local speech-to-text via whisper.cpp) |
| `whisper-stream.js` | WhisperStreamService (real-time streaming server) |
| `work-queue.js` | Work queue for agent job execution |
| `work-queue-life.js` | Specialized executors for agent life simulation and motivations jobs |
| `work-queue-prompts.js` | Prompt builders and job message formatting (pure text generators) |
| `work-queue-validators.js` | Job/plan completion parsing and validation (pure functions) |
| `youtube.js` | YouTubeService (video info and transcript extraction) |
| `pty.js` | PTYService (PTY session lifecycle, env assembly, event forwarding) |
| `preview.js` | PreviewService (BrowserView lifecycle, console buffer, navigation) |
| `filesystem.js` | FileSystemService (file tree, binary detection, image handling) |
| `index.js` | Re-exports public services (internal helpers like work-queue-prompts, sim-helpers are intentionally excluded) |

See `src/services/README.md` for patterns and conventions.

## API Routes (`src/routes/`)

| Module | Routes | Purpose |
|--------|--------|---------|
| `settings-api.js` | `/api/settings/*`, `/api/env/*`, `/api/backend/*`, `/api/open-external` | User settings, env vars, backend auth/login |
| `system.js` | `/api/system/*` | System time endpoint |
| `skills.js` | `/api/skills/*`, `/api/capabilities/*` | Capabilities registry, search, pins, catalog, security review/approve/reject |
| `oauth.js` | `/oauth/*` | OAuth callback handling |
| `connections.js` | `/api/connections/*` | OAuth token management |
| `google.js` | `/api/google/*` | Google Calendar, Gmail, Drive APIs |
| `assistant.js` | `/api/assistant/*` | Assistant chat, config, digest |
| `assistant-state.js` | (internal) | Shared state for assistant routes |
| `voice.js` | `/api/voice/*` | Speech-to-text, voice settings |
| `voice-stream.js` | `/api/voice/stream` | WebSocket proxy for streaming transcription |
| `tts-stream.js` | `/api/tts/stream` | WebSocket proxy for TTS streaming (ElevenLabs + OpenAI) |
| `transcribe.js` | `/api/transcribe/*` | Video to text transcription |
| `speak.js` | `/api/speak/*` | Text to audio file generation |
| `imagegen.js` | `/api/imagegen/*` | AI image generation |
| `voicemessage.js` | `/api/voicemessage/*` | Voice message via Telegram |
| `call.js` | `/api/call/*`, `/call/*` | Voice call creation, status, join page |
| `call-stream.js` | `/api/call/:id/stream` | WebSocket for voice calls (STT + LLM + TTS) |
| `jobs.js` | `/api/jobs/*` | Timed jobs CRUD, run log, scheduling |
| `agent-jobs.js` | `/api/agent/:agentId/jobs/*` | Agent-scoped timed job self-management |
| `apps.js` | `/api/apps/*` | App CRUD, build dispatch, build status |
| `app-db.js` | `/api/apps/:appId/db/*` | Per-app SQLite database (query, execute, batch, schema) |
| `app-blob.js` | `/api/apps/:appId/blob/*` | Per-app file storage (upload, read, list, delete) |
| `inspect.js` | `/api/apps/:id/inspect` | App screenshot + console error capture |
| `agents.js` | `/api/agents/*` | Agent CRUD, config, voice selection, visibility |
| `agent-chat.js` | `/api/agent/*` | Agent chat threads, messages, SSE streaming |
| `ai-registry.js` | `/api/ai/*` | AI provider/model management, routing cascades, account status |
| `sim.js` | `/api/agent/:id/sim/*` | Agent life and simulation (reverie, journal, snapshot, portrait, life items CRUD) |
| `embodiment.js` | `/api/embodiment/*` | Humanoid body embodiment toggle |
| `youtube.js` | `/api/youtube/*` | YouTube video info and transcript extraction |
| `telegram.js` | `/api/telegram/*` | Telegram send text/photo/document |
| `buzz.js` | `/api/buzz/*` | Simulated drinking system (drink, status, sober) |
| `mcp.js` | `/api/mcp/*` | MCP server management, tool proxy, catalog |
| `plans.js` | `/api/plans/*` | Plan CRUD, approve/reject/cancel, step editing, SSE progress |
| `images.js` | `/api/images/*` | Image serving |
| `journal.js` | `/api/journal/*` | Journal entries |

Page templates in `src/templates/pages/`:
- `home.html`, `404.html`, `oauth-result.html`, `call.html`

## Capabilities System

Unified system for APIs, skills, and MCP tools. `CapabilityService` manages the `capabilities` table with a `type` discriminator ('api', 'skill', or 'mcp').

**APIs** are auto-registered from route `.meta` exports (e.g., `src/routes/speak.js` exports `.meta`). **Skills** are multi-step workflows discovered from `~/os8/skills/` SKILL.md files. **MCP** tools are discovered from running MCP servers and proxied as REST endpoints.

| Type | Name | Endpoints |
|------|------|-----------|
| api | speak | `/api/speak/*` |
| api | voicemessage | `/api/voicemessage/*` |
| api | imagegen | `/api/imagegen/*` |
| api | youtube | `/api/youtube/*` |
| api | transcribe | `/api/transcribe/*` |
| api | google | `/api/google/*` (Calendar, Drive, Gmail) |
| api | telegram | `/api/telegram/*` |
| api | agent-jobs | `/api/agent/:agentId/jobs/*` (agent self-service job creation) |
| api | app-db | `/api/apps/:appId/db/*` (per-app SQLite database) |
| api | app-blob | `/api/apps/:appId/blob/*` (per-app file storage) |
| skill | app-builder | `/api/apps`, `/api/apps/:id/build` |
| skill | app-enhancer | `/api/apps/:id/inspect`, `/api/apps/:id/build` |
| skill | plan | `/api/plans/*` (create, approve, execute, cancel) |
| skill | motivations-update | Server-orchestrated timed job (no API endpoints) |
| skill | action-planner | Skill-linked timed job (`~/os8/skills/action-planner/SKILL.md`) |
| skill | skill-builder | Create new skills as reusable workflows (`~/os8/skills/skill-builder/SKILL.md`) |
| mcp | (dynamic) | `POST /api/mcp/{serverId}/{toolName}` |

**Discovery:** `GET /api/skills/registry` returns all capabilities (APIs + skills + MCP) with availability status.

**Search:** `POST /api/skills/search` with semantic + keyword matching, API/MCP boost (2x), reserved type slots.

**Pins:** Agents can pin capabilities for always-on context. `GET/POST/DELETE /api/skills/agent/:agentId/pin`.

**Skill Catalog:** ClawHub catalog syncs to `skill_catalog` table for browsing/installing new skills (`src/services/skill-catalog.js`). Full skill directories are downloaded from GitHub (not just SKILL.md).

**Security Review:** Catalog skills are quarantined on install (`quarantine = 1`) and undergo LLM-powered security review via `SkillReviewService`. Users must approve each skill individually before agents can use it. Re-quarantines on content change. Review endpoints: `POST/GET /api/skills/:id/review`, `POST /api/skills/:id/approve`, `POST /api/skills/:id/reject`, `GET /api/skills/:id/deps-status`, `POST /api/skills/:id/install-deps`.

**MCP Catalog:** Curated MCP server catalog at `mcp_catalog` table (`src/services/mcp-catalog.js`). Browse/install via `/api/mcp/catalog/*`.

**App integration:** Every app's CLAUDE.md auto-includes an "Available Capabilities" section.

**Adding skills:** Create `~/os8/skills/{name}/SKILL.md` with YAML frontmatter + markdown docs.

## Renderer Modules (`src/renderer/`)

| Module | Purpose |
|--------|---------|
| `main.js` | **Application bootstrap, event handler wiring** |
| `state.js` | Centralized state with getters/setters |
| `elements.js` | DOM element references |
| `helpers.js` | Event listener, modal, file tree utilities |
| `clock.js` | System clock display |
| `backgrounds.js` | Wallpaper management and picker |
| `preview.js` | BrowserView create/load/hide/destroy/bounds |
| `terminal.js` | Terminal creation, PTY handlers, fit functions, build status tabs |
| `agent-panel.js` | Agent chat panel (messages, SSE streaming, file attachments, history) |
| `file-tree.js` | File icons, tree rendering, storage views |
| `tasks.js` | Task CRUD, drag-drop, context menus |
| `jobs.js` | Timed jobs CRUD, scheduling modal, run history |
| `tabs.js` | Tab creation, switching, state persistence |
| `view-mode.js` | Developer/User mode, Focus/Split view |
| `apps.js` | App grid rendering, create, drag-drop reorder |
| `settings.js` | Settings modal, agent config, voice settings, OAuth port |
| `api-keys.js` | API key management UI |
| `capabilities.js` | Capabilities settings panel (filter, render, review badges, approve/reject UI) |
| `connections.js` | OAuth wizard, connection management |
| `init.js` | Core services initialization |
| `voice.js` | Voice input wrapper (one-shot/continuous modes, batch fallback) |
| `data-storage.js` | Data storage view (memory sources, chunks display) |
| `onboarding.js` | First-run onboarding wizard (splash screen, 6-step setup, provider detection, resume) |
| `whisper-setup-dialog.js` | On-demand whisper install dialog (mic button trigger, cloud/local choice) |
| `account.js` | Account/profile UI, os8.ai sign-in state |

## IPC Handlers (`src/ipc/` ↔ `preload.js`)

| Module | Channels | Purpose |
|--------|----------|---------|
| `account.js` | `account:*` | OS8.ai sign-in, sign-out, profile |
| `apps.js` | `apps:*`, `assistant:get/create` | App CRUD, archive, restore |
| `agents.js` | `agents:*` | Agent CRUD, list, config |
| `assistant.js` | `assistant:chat` | Assistant features |
| `connections.js` | `connections:*` | OAuth flow, tokens, grants |
| `core.js` | `core:*`, `paths:*`, `server:*` | Core services, paths |
| `files.js` | `files:*` | File tree, read operations |
| `preview.js` | `preview:*` | BrowserView control |
| `settings.js` | `settings:*`, `env:*`, `claude:*` | Settings, env vars |
| `tasks.js` | `tasks:*`, `tasksFile:*` | Task management |
| `jobs.js` | `jobsFile:*` | Timed jobs management |
| `terminal.js` | `terminal:*` | PTY create, write, kill, auth conflict stripping |
| `voice.js` | `voice:*` | Speech-to-text transcription, voice settings |
| `whisper.js` | `whisper:*`, `whisper:stream-*` | Whisper setup, status, streaming |
| `tts.js` | `tts:*` | TTS settings, voice list, availability |
| `transcribe.js` | `transcribe:*` | Video to text transcription |
| `speak.js` | `speak:*` | Text to audio file generation |
| `call.js` | `call:*` | Voice call management |
| `tunnel.js` | `tunnel:*` | Cloudflare tunnel management |
| `data-storage.js` | `data:*` | Memory tables for UI display |
| `inspect.js` | `inspect:*` | App inspection (screenshot, console buffer) |
| `mcp.js` | `mcp:*` | MCP server management, catalog |
| `onboarding.js` | `onboarding:*` | First-run status, step tracking, CLI install, provider detection |

## Agent Services (`src/assistant/`)

| Module | Purpose |
|--------|---------|
| `memory.js` | 4-tier memory context assembly + semantic search |
| `memory-embeddings.js` | Embedding primitives, text chunking, hashing, keyword extraction |
| `memory-notes.js` | Daily notes, file I/O, reflection methods (prototype mixin) |
| `memory-watcher.js` | File watcher for MYSELF.md/USER.md reindexing |
| `telegram-watcher.js` | Telegram DM + group message polling with auto-registration |
| `identity-context.js` | Agent identity/personality context building (text context, budgets, message assembly) |
| `identity-images.js` | Image loading, compression, caching, and image context formatting |
| `config-handler.js` | Agent configuration management |
| `message-handler.js` | Message processing pipeline (orchestrates classify → subconscious → CLI spawn) |
| `message-handler-parse.js` | Stream parsing utilities (findPartialMatch, parseStreamJsonOutput) |
| `message-handler-helpers.js` | Env preparation, image storage helpers |
| `message-handler-plan.js` | Plan command interception (/plan, /approve, /cancel, /reject, /modify) |
| `process.js` | Agent process lifecycle |

## Tech Stack

| Component | Technology |
|-----------|------------|
| Desktop shell | Electron |
| Database | SQLite (better-sqlite3) |
| Terminal | node-pty + xterm.js |
| Preview | Electron BrowserView |
| App framework | React 18 + Tailwind CSS 3 |
| Build tool | Vite 5 (middleware mode) |
| AI backends | Claude Code, Gemini CLI, Codex CLI, Grok CLI |

## Jobs API (`/api/jobs`)

Timed jobs for scheduled agent tasks.

**Endpoints:**
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/:appId` | List all jobs |
| POST | `/:appId` | Create job |
| GET | `/:appId/upcoming` | Jobs sorted by nextRun |
| GET | `/:appId/due` | Jobs due now (nextRun <= now) |
| GET | `/:appId/stats` | Job statistics |
| GET | `/:appId/:jobId` | Get single job |
| PATCH | `/:appId/:jobId` | Update job |
| DELETE | `/:appId/:jobId` | Delete job |
| POST | `/:appId/:jobId/toggle` | Toggle enabled |
| GET | `/:appId/:jobId/runs` | Get run history (limit=50) |
| POST | `/:appId/:jobId/runs` | Add run entry |

**Job Types:** `one-time` (runs once) | `recurring` (repeats based on frequency)

**Schedule Schema:**
```javascript
// One-time
{ datetime: "2024-03-15T14:30:00.000Z" }

// Recurring
{ frequency: "every-x-minutes", interval: 15, startDate: "2024-03-15", startTime: "09:00" }
{ frequency: "hourly", minute: 30 }
{ frequency: "daily", time: "09:00" }
{ frequency: "weekdays", time: "09:00" }
{ frequency: "weekly", time: "09:00", dayOfWeek: 1 }  // 0=Sun
{ frequency: "monthly", time: "09:00", dayOfMonth: 15 }
{ frequency: "annually", time: "09:00", dayOfMonth: 15, month: 3 }
```

**Run Entry Status:** `completed`, `skipped`, `failed`, or `could_not_complete`

## App Template System

Templates in `src/templates/` with `{{VARIABLE}}` substitution. Layered: base → standard (or assistant).

New apps scaffold with: `index.html`, `src/main.jsx`, `src/App.jsx`, `src/index.css`, `tasks.json`, `claude-user.md`.

## Development

```bash
npm install                                      # Install dependencies
npx electron-rebuild -f -w better-sqlite3        # Rebuild native modules for Electron
npm start                                        # Run OS8
npm test                                         # Run tests
# OS8 runs on port 8888 (configurable in Settings)
# Apps served at http://localhost:8888/{app-id}/
```

**Native module rebuild:** `better-sqlite3` is a native Node module that must be compiled against Electron's Node.js version, not the system Node.js. After any `npm install` (including when dependencies change), run `npx electron-rebuild -f -w better-sqlite3`. Failure to do so causes `NODE_MODULE_VERSION` mismatch errors at startup.

**Separate data environments:** User data defaults to `~/os8/`. Override with `OS8_HOME` env var to run isolated instances (e.g., for testing a clean user experience without affecting personal data):

```bash
OS8_HOME=~/os8-dev npm start   # Fresh/disposable test environment
npm start                       # Personal environment (~/os8/, untouched)
```

**Auto-start services:** Whisper Streaming Server (port 9090, if installed). Stopped on clean shutdown (Cmd+Q). If force-killed: `pkill -f whisper-stream-server`.

## Important Notes

- **Don't add package.json to apps** — They use Core's dependencies
- **App URLs use IDs** — e.g., `http://localhost:8888/1769643733356-8at4mvz1f/`
- **CLAUDE.md in apps is auto-generated** — User customizations go in `claude-user.md`
- **Vite runs in middleware mode** — Express serves HTML, Vite transforms JSX/CSS
- **DB env vars must be merged at spawn sites** — See design principles section 11
