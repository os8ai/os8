# OS8 Design Principles

Quick reference for architectural patterns and conventions. Read this at session start for consistency.

**Related docs:** [CLAUDE.md](CLAUDE.md) (file locations, commands) | [src/services/README.md](src/services/README.md) (service patterns)

---

## 1. File Organization

| Layer | Location | Purpose |
|-------|----------|---------|
| Services | `src/services/*.js` | Business logic, database operations |
| IPC Handlers | `src/ipc/*.js` | Bridge between renderer and main process |
| HTTP Routes | `src/routes/*.js` | Express API endpoints |
| Renderer | `src/renderer/*.js` | UI modules (ES6) |
| Shared | `src/shared/*.js` | Modules used by both shell and apps |
| Templates | `src/templates/` | App scaffolding (base + overlays) |

**Key principle:** Code lives in the project, user data lives in `~/os8/`.

**Shared modules:** The `src/shared/` directory contains code that must be used by both the OS8 shell (imported directly) and apps in BrowserViews (loaded via `/shared/` HTTP route). Apps use `fetch()` to load these modules since BrowserViews can't directly import from the shell.

```
Project (code)          User data (~/os8/)
├── src/services/       ├── apps/        # App source
├── src/ipc/            ├── config/      # SQLite database
├── src/routes/         ├── blob/        # File storage
└── src/templates/      └── core/        # Shared React/Vite
```

---

## 2. IPC Communication Pattern

### Channel Naming
Use `domain:action` format:
```
apps:create, apps:delete, apps:list
terminal:create, terminal:write, terminal:kill
settings:get, settings:set
```

### Handler Structure
Handlers receive a context object—no globals:
```javascript
// src/ipc/apps.js
module.exports = function registerAppsHandlers({ db, services, state, helpers }) {
  ipcMain.handle('apps:create', async (event, name, color) => {
    return services.AppService.create(db, name, color);
  });
};
```

### Preload Bridge
`window.os8.*` namespaces mirror handler domains:
```javascript
// Renderer calls
await window.os8.apps.create('My App', '#3b82f6');
await window.os8.terminal.create(appId);
await window.os8.settings.get('port');
```

---

## 3. Service Patterns

### Static Methods with `db` Parameter
```javascript
class AppService {
  static getById(db, id) {
    return db.prepare('SELECT * FROM apps WHERE id = ?').get(id);
  }

  static create(db, name, color) {
    // ...
  }
}
```

### Export Convention

Every service file uses **bare export** unless it genuinely exports multiple things:

```javascript
// Single-class file (the vast majority of services)
class AgentService { /* ... */ }
module.exports = AgentService;

// Caller
const AgentService = require('./agent');
```

```javascript
// Multi-export file (e.g. class + constants, or multiple functions)
class WorkQueue { /* ... */ }
const PRIORITY_THREAD = 10;
module.exports = { WorkQueue, PRIORITY_THREAD };

// Caller
const { WorkQueue, PRIORITY_THREAD } = require('./work-queue');
```

**Why this matters:** Destructuring a bare export (`const { X } = require(...)`) silently returns `undefined` — no error at require time, just a crash later when you call a method. Wrapping a single class in an object (`module.exports = { X }`) forces every caller to know the pattern. Bare exports eliminate the ambiguity.

**When to use which:**
| Scenario | Export | Import |
|----------|--------|--------|
| File exports one class | `module.exports = ClassName` | `const ClassName = require(...)` |
| File exports class + constants | `module.exports = { Class, CONST }` | `const { Class, CONST } = require(...)` |
| File exports multiple functions | `module.exports = { fn1, fn2 }` | `const { fn1, fn2 } = require(...)` |

**Do not** wrap a single class in an object just for naming consistency. If the file only exports one thing, export it bare.

### Key Rules
- **Throw errors** — let callers handle them
- **Sync for SQLite** — better-sqlite3 is synchronous
- **Async for I/O** — file operations, external processes

Exception: File utilities may return defaults for missing files.

### Dependency Injection Guidelines

**Always pass as parameters:**
- `db` — Database connection (testability, lifecycle management)
- External API clients with credentials
- Services with runtime state that varies

**Direct import is fine for:**
- Stateless utility services (TranscribeService, WhisperService)
- Tightly coupled internal services
- Configuration/constants

**Rule of thumb:** If there's no realistic scenario where you'd swap the implementation, direct import is cleaner.

---

## 4. Renderer State Management

All state lives in `src/renderer/state.js`.

### Getter/Setter Pattern
```javascript
// Reading state
const apps = getApps();
const currentApp = getCurrentApp();

// Modifying state
setCurrentApp(app);
setViewMode('split');  // Some setters persist to localStorage
```

### Array Helpers
```javascript
addTab(tab);
removeTabById(id);
getAppById(id);
getTerminalInstanceBySessionId(sessionId);
```

> **CRITICAL:** Never mutate state directly. Always use setters.
> ```javascript
> // Wrong
> state.apps.push(newApp);
>
> // Right
> addApp(newApp);
> ```

---

## 5. Dynamic Rendering Pattern

UI content is generated from data, not hardcoded in HTML.

### The Pattern
```javascript
function renderAppGrid() {
  const apps = getApps();

  // 1. Generate HTML from data
  const html = apps.map(app => `
    <div class="app-icon" data-id="${app.id}">
      <div class="app-icon-circle" style="background: ${app.color}">
        ${app.name[0]}
      </div>
      <span>${app.name}</span>
    </div>
  `).join('');

  // 2. Insert into container
  elements.appGrid.innerHTML = html;

  // 3. Attach event handlers
  elements.appGrid.querySelectorAll('.app-icon').forEach(el => {
    el.addEventListener('click', () => openApp(el.dataset.id));
  });
}
```

### Key Points
- `index.html` contains containers, not content
- Re-render on state change
- Event listeners attached after `.innerHTML`

---

## 6. HTTP Routes

### Factory Functions
Routes receive dependencies, don't import globals:
```javascript
// src/routes/apps.js
module.exports = function createAppsRoutes({ db, services }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const apps = services.AppService.getAll(db);
    res.json(apps);
  });

  return router;
};
```

### Error Format
```javascript
// Consistent error responses
res.status(404).json({ error: 'App not found' });
res.status(400).json({ error: 'Name is required' });
```

---

## 7. Template System

Templates use `{{VARIABLE}}` substitution.

### Available Variables
| Variable | Example |
|----------|---------|
| `{{APP_NAME}}` | My App |
| `{{ID}}` | 1769654978010-iq0bsf19v |
| `{{SLUG}}` | my-app |
| `{{COLOR}}` | #3b82f6 |
| `{{TEXT_COLOR}}` | #ffffff |

### Template Layering
```
base/           → Applied to all apps
  ├── index.html
  ├── src/main.jsx
  └── src/index.css

standard/       → Overlaid for standard apps
  └── src/App.jsx

assistant/      → Overlaid for assistant app
  ├── src/App.jsx
  ├── src/components/
  └── MYSELF.md, USER.md, etc.
```

---

## 8. Naming Conventions

| Context | Convention | Example |
|---------|------------|---------|
| Files | kebab-case | `file-tree.js`, `tasks-file.js` |
| Services | PascalCase + Service | `AppService`, `TasksFileService` |
| IPC channels | domain:action | `apps:create`, `terminal:write` |
| State functions | get/set prefix | `getApps()`, `setCurrentApp()` |
| CSS classes | kebab-case, prefixed | `app-icon`, `terminal-container` |
| Constants | SCREAMING_SNAKE | `HIDDEN_FILES`, `WIZARD_STEPS` |

---

## 9. CSS Architecture

### Modular Structure
Shell styles live in `styles/`, imported via `styles.css`:

| File | Purpose |
|------|---------|
| `variables.css` | `:root` custom properties (colors, spacing, border-radius tiers, font-size scale, opacity tokens) |
| `primitives.css` | Reusable base classes (`.surface`, `.icon-btn`, `.panel-select`) |
| `layout.css` | Shell chrome, tab bar, workspace grid, terminal, preview |
| `components.css` | Buttons, inputs, badges, cards, app grid |
| `panels.css` | Tasks, jobs, file tree, data storage, agent chat |
| `modals.css` | Settings, connections, wizards, all modal overlays |
| `animations.css` | Keyframes and transitions |

### Key Principles
- All theming through `:root` variables — no hardcoded colors/sizes
- Border-radius: 4 tiers (`--radius-sm` through `--radius-xl`)
- Font sizes: 6-step scale (`--font-xs` through `--font-xxl`)
- Opacity tokens for consistent transparency (`--overlay-*`, `--border-*`)

> **Note:** OS8 shell uses vanilla CSS. Tailwind is only for user apps via Core.

---

## 10. Critical Anti-Patterns

These patterns cause bugs or architectural issues. Avoid them.

### Never Add package.json to User Apps
Apps use `~/os8/core/` dependencies. Adding package.json breaks the shared environment.

### Never Import db Globally
The database connection must always be passed as a parameter for testability and lifecycle management:
```javascript
// Wrong
const db = require('../db');

// Right - receive as parameter
function handler({ db, services }) { ... }
```
Note: Stateless utility services (like TranscribeService, WhisperService) can be imported directly when there's no realistic swap scenario. See "Dependency Injection Guidelines" in section 3.

### Never Mutate State Directly
```javascript
// Wrong
state.tabs.push(newTab);

// Right
addTab(newTab);
```

### Never Destroy DOM That Owns Live State
xterm cell grids, open SSE connections, and timer-driven panels can't be reconstructed from a server snapshot or replayed buffer. On tab switch / view swap, **park** them (detach + hide) — see §13. Destroy-and-recreate silently corrupts the UI (e.g. an alt-screen TUI repainted from a truncated PTY buffer).

### Never Put Repetitive HTML in index.html
Generate dynamic content with JavaScript. The HTML file should contain:
- Structural containers
- Static chrome (title bar, etc.)
- Modal skeletons

### Never Use Tailwind in OS8 Shell
The shell uses CSS variables and primitives. Tailwind is reserved for user apps built with Core.

### Never Skip the Preload Bridge
Renderer must use `window.os8.*` to communicate with main process—never direct IPC.

---

## 11. Backend Adapter Pattern

The backend adapter (`src/services/backend-adapter.js`) maps backend IDs to CLI commands, flags, and parsers. All agent interactions go through this abstraction.

### Supported Backends
| Backend | CLI Command | Output Format |
|---------|-------------|---------------|
| `claude` | `claude` | `{"type":"result"}` stream JSON |
| `gemini` | `gemini` | `{"type":"result"}` stream JSON |
| `codex` | `codex` | Legacy |
| `grok` | `grok` | `{"role":"assistant"}` JSONL |

### Env Merging at Spawn Sites
Every CLI spawn site must merge database API keys into the environment. `prepareEnv()` only provides `process.env` + PATH fixes — database-stored keys (from `EnvService`) are invisible to child processes unless explicitly merged.

```javascript
// Wrong — DB keys missing
const env = prepareEnv(process.env);

// Right — merge DB keys at every spawn site
const dbEnv = EnvService.asObject(db);
const env = prepareEnv({ ...process.env, ...dbEnv });
```

**Key mapping:** Some CLIs expect different env var names than what OS8 stores (e.g., OS8 stores `XAI_API_KEY`, Grok CLI expects `GROK_API_KEY`). The adapter handles this remapping in `prepareEnv`.

### Instruction Files
Each backend reads its own instruction file from the app's CWD:
| Backend | File |
|---------|------|
| Claude | `CLAUDE.md` |
| Gemini | `GEMINI.md` |
| Codex | `AGENTS.md` |
| Grok | `.grok/GROK.md` |

### PTY vs Spawn
- **Claude**: Uses PTY (`pty.spawn`) — works with ANSI codes
- **All others**: Must use `spawn` with piped stdio — PTY ANSI codes corrupt JSON output
- **Critical**: `spawn` stdout may not end with `\n`. Line-split buffers keep the last line unprocessed. Always flush the buffer in `onExit`.

---

## 12. Lightweight LLM Calls

Services that need a quick, text-only LLM call (no tool use, no streaming) — e.g., digest compression, classification, moderation — use a centralized dispatch pattern in `src/services/cli-runner.js`.

### The Pattern

```javascript
const RoutingService = require('./routing');
const { sendTextPrompt } = require('./cli-runner');

const resolved = RoutingService.resolve(db, 'summary'); // or 'conversation', 'planning', etc.
const text = await sendTextPrompt(db, resolved, prompt, {
  systemPrompt: 'You are a classifier...',
  maxTokens: 300,
  timeout: 15000,       // CLI timeout in ms
  sdkFallback: 'haiku'  // SDK model alias for non-Anthropic families
});
```

`sendTextPrompt` handles the SDK-vs-CLI decision internally:
- **API access** + Anthropic key available → `AnthropicSDK.sendMessage()` (fast, clean system prompt)
- **Login access** or non-Anthropic provider → spawns CLI in `os.tmpdir()` (no instruction file auto-loading)

### Model Alias Mapping

`familyToSdkModel(familyId, fallback)` maps routing family IDs (`'claude-opus'`, `'claude-sonnet'`, `'claude-haiku'`) to Anthropic SDK aliases (`'opus'`, `'sonnet'`, `'haiku'`). Non-Anthropic families return the fallback. Used for logging and display — `sendTextPrompt` calls it internally.

### Key Rules

- **Always resolve first**: Call `RoutingService.resolve(db, taskType)` to get a `resolved` object, then pass it to `sendTextPrompt`. Don't hardcode backends or models.
- **Don't duplicate the SDK/CLI branch**: If you need a text-only LLM call, use `sendTextPrompt`. Don't inline `AnthropicSDK.sendMessage()` + spawn logic.
- **Choose the right task type**: `'summary'` for cheap utility work (classification, digests, moderation), `'conversation'` for quality-sensitive work, `'planning'` for architecture.
- **Retry-on-failure**: If you need to retry with the next cascade entry on LLM failure (not just unavailability), walk the cascade manually like `ModeratorService.decideNextSpeakers` does. This is the exception, not the norm.

### Current Consumers

| Service | Task Type | Purpose |
|---------|-----------|---------|
| `digest-engine.js` | summary | Session/daily digest compression |
| `subconscious.js` | summary, conversation | Action classification, context curation |
| `moderator.js` | summary | Group chat turn-taking decisions |
| `principles.js` | summary, conversation | Principle extraction (SDK-only, uses `familyToSdkModel` directly) |
| `plan-generator.js` | planning | Plan generation (SDK-only, uses `familyToSdkModel` directly) |

---

## 13. DOM Lifecycle: Park vs Reload

When a panel goes off-screen (tab switch, modal close, view swap), decide whether to **park** its DOM (keep alive, hidden) or **reload** it on next show. Picking wrong in either direction causes a real bug class.

### The Test
Ask: *"If I delete this DOM right now, where do I get it back from?"*

| Component                  | Source of truth              | Strategy |
|----------------------------|------------------------------|----------|
| File tree, tasks, jobs     | SQLite / filesystem          | Reload   |
| Preview (BrowserView)      | Main process                 | Persist there, not in renderer |
| xterm scrollback           | The xterm cell grid itself   | **Park** |
| Agent SSE stream           | The live EventSource         | **Park** |
| Build status timer/output  | `setInterval` + DOM accumulator | **Park** |

### When to Park
The DOM owns state that exists nowhere else AND can't be reconstructed from a server snapshot:
- A live byte stream rendered into a stateful surface (xterm).
- An open network connection accumulating events (SSE, WebSocket).
- Wall-clock state captured at instantiation (timers, recordings).

Park by **detaching the DOM into a hidden container** (e.g. per-tab park element on `document.body`) — not by destroying it. JS objects, listeners, internal buffers, and network connections all stay alive. On unpark, reattach + reflow + force-refresh.

Reference implementation: `parkTabInstances` / `unparkTabInstances` in `src/renderer/tabs.js`.

### When to Reload
The DOM is a rendering of authoritative data held elsewhere:
- Server-backed lists (tasks, jobs, files, agents).
- Anything that other tabs / processes / agents could mutate while parked.

Reload on show. Staleness is the bug; reloading is the cheapest fix.

### The Anti-Pattern
Treating a "park" component like a "reload" component (destroy it, then try to reconstruct from a server snapshot or cached buffer) silently corrupts state — alt-screen TUIs repainted from a truncated PTY buffer are the canonical example. The reverse mistake (parking what should reload) produces silent staleness and stale-action bugs.

> **Rule of thumb:** If a server-side change wouldn't show up after a tab switch, you're parking something that should be reloaded. If reattaching shows a corrupted/blank view, you're reloading something that should be parked.

---

## Quick Reference

```
┌─────────────────────────────────────────────────────────────┐
│  Renderer (index.html + src/renderer/*.js)                  │
│  └─ Uses: state.js getters/setters, window.os8.* bridge    │
└──────────────────────────┬──────────────────────────────────┘
                           │ IPC (domain:action)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Main Process (main.js → src/ipc/*.js)                      │
│  └─ Receives: { db, services, state, helpers }              │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Services (src/services/*.js)                               │
│  └─ Static methods, db as first param, throw errors         │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Data (~/os8/)                                              │
│  └─ apps/, config/os8.db, blob/, core/                      │
└─────────────────────────────────────────────────────────────┘
```
