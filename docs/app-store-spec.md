# OS8 App Store — V1 Spec & Execution Plan

**Status:** Draft v2 — open for review before execution planning. (v2 incorporates security-review and ergonomics feedback from external code review.)
**Audience:** The agent that will build the PR-by-PR execution plan, and the engineers who will implement it.
**Codebases:** `/home/leo/Claude/os8/` (Electron desktop) and `/home/leo/Claude/os8dotai/` (Next.js website).

---

## 1. Overview

### What we are building

A one-click install pipeline for open-source GitHub-hosted programs, packaged as OS8 apps. Each installed app:

1. Appears as an icon on the OS8 home screen alongside the user's native React apps.
2. Opens inside an OS8 window (Electron `BrowserView`) with the app's name in the window chrome.
3. Runs locally on the user's machine.
4. Is **editable** — source lives at `~/os8/apps/<id>/` and can be crawled and modified by Claude Code (or any AI coding tool). When code changes, the live preview updates.

The catalog of installable apps lives on `os8.ai`. Click "Install" → desktop OS8 receives the request → app installs → icon appears on home screen.

### The two-line strategic story

1. **Distribution flywheel.** A curated catalog of well-known open-source AI tools (ComfyUI, OpenWebUI, n8n, Stable Diffusion WebUI, etc.) packaged for one-click install gives users an immediate reason to use OS8 as their AI workstation.
2. **The differentiator nobody else has: editable apps.** Other app stores install apps as black boxes. OS8 installs them as editable local software objects that the user's AI agents can read, modify, and extend.

### The architectural insight

The user's three asks (window-in-OS8 + unified front door + live edit) collapse the architecture to one specific pattern:

> Clone the upstream repo into `~/os8/apps/<id>/`, run the upstream's own dev server natively on the host, and have OS8's Express server reverse-proxy `<slug>.localhost:8888/` (a per-app subdomain on the same port) → that dev server's port — passing WebSocket upgrades through so the framework's own HMR works unchanged. Each external app gets its own browser origin, so localStorage / IndexedDB / cookies / service-worker / permission grants are isolated by the browser's same-origin policy without any further work.

Everything else falls out of this:

- Front door stays unified: OS8's Express on port 8888 is the only listening port. `*.localhost:8888` resolves to `127.0.0.1` natively per RFC 6761 on macOS, Linux, and Windows 11 (modern builds).
- Live edit works: the upstream framework (Vite, Next, Streamlit, …) does its native job. The proxy is transparent. Frameworks bind at `/`; no `--base` flag and no per-framework config patch needed.
- Trust isolation is architectural: each app is its own origin. Two installed apps can't read each other's localStorage, IndexedDB, cookies, or service-worker registrations — the browser enforces it.
- Claude Code can crawl the source: it's at `~/os8/apps/<id>/`, same as native apps.
- Per-app DB and blob still work: keyed off `app.id`.
- Icon, tabs, window chrome work unchanged: keyed off the `apps` table row.

The structural changes to today's OS8:

1. A new middleware ahead of the catch-all route at `src/server.js:682-740` — if the request's `Host` matches `<slug>.localhost:8888` and `<slug>` resolves to an `app_type='external'` row, reverse-proxy to its dev port; the existing catch-all continues to handle native apps on the bare `localhost:8888` host.
2. A scoped capability surface (`<slug>.localhost:8888/_os8/api/*`) so external apps can call OS8 APIs only with declared permissions. Because each app is its own origin, the SDK calls relative URLs (`fetch('/_os8/api/blob/x')`) and a path-prefix middleware on the OS8 server matches and authorizes them — no CORS preflight, no slug-in-path bookkeeping.

Docker is **not** the primary runtime. Native install (`npm install`, `uv sync`) gives a dramatically better dev loop. Docker is the v2 fallback for apps that need system packages.

#### Why subdomain mode (not path mode)

Path mode (`localhost:8888/<slug>/`) was considered and rejected during execution planning because:

- **Trust isolation is architectural under subdomains, runtime-only under paths.** Path mode shares a single browser origin (`localhost:8888`) across every installed app — same cookies, localStorage, IndexedDB, service-worker scope, permission grants. Hardened BrowserView mitigates at runtime, but the browser security model says same-origin code trusts each other; with N apps editable by AI agents, that's an inevitable leak. Subdomain mode makes each app its own origin and lets the browser do isolation for free.
- **No per-framework base-path tax.** Half the v1+v2 frameworks (Next.js `basePath`, SvelteKit `paths.base`, Astro `base`, Jekyll `baseurl`) require a config-file change, not a flag, to honor a path prefix. Subdomain mode lets every framework bind at `/` without modification — manifest authoring is dramatically simpler and the catalog opens up faster.
- **Apps that hardcode `fetch('/api/...')` just work.** Common pattern in open-source apps. Under subdomain mode the call hits the upstream's own API at the right origin.
- **Future origin-gated browser features compose correctly.** Camera, mic, geolocation, persistent storage, WebRTC — all browser-gated per origin. Each app having its own origin means each app gets its own permission grant; path mode would give one grant to all apps.

The user-visible URL difference (`worldmonitor.localhost:8888` vs `localhost:8888/worldmonitor`) is invisible in practice — the OS8 window chrome shows the cosmetic `os8://apps/<slug>` label (§6 below) and users interact with apps via icons, not URLs.

### Trust model — load-bearing

External apps are not trusted code. The architecture treats them like third-party browser extensions: explicit declared permissions, server-side enforcement of those permissions, sanitized runtime environment, review before any install command runs, hardened BrowserView. The "feels like a normal app" UX is the user's experience — under the hood, every external-app surface is hardened by default.

---

## 2. Architecture

### 2.1 Three layers

```
┌──────────────────────────────────────────────────────────────┐
│  os8ai/os8-catalog (GitHub repo) — AppSpec YAML files              │
│  PR-driven curation (Homebrew model)                         │
│  CI: schema, tag→SHA resolution, lockfile gate, image checks │
└──────────────┬───────────────────────────────────────────────┘
               │ webhook on merge (+ 30 min cron safety net)
               ▼
┌──────────────────────────────────────────────────────────────┐
│  os8.ai (Next.js + Neon Postgres)                            │
│  Mirrors catalog into Postgres for browse/search             │
│  Sync resolves upstream tags → immutable commit SHAs         │
│  /apps page — listings, screenshots, install button          │
│  Install button → emits os8://install + queues PendingInstall│
│  Reuses existing PKCE auth (AccountService)                  │
└──────────────┬───────────────────────────────────────────────┘
               │ os8://install?slug=…   (primary, anonymous-OK)
               │ + polling fallback via account auth (signed-in)
               ▼
┌──────────────────────────────────────────────────────────────┐
│  OS8 desktop                                                 │
│  · AppCatalogService (mirrors SkillCatalogService)           │
│  · AppInstallJob state machine (review-before-install)       │
│  · Runtime adapters: node | python (uv) | static [| docker]  │
│  · ReverseProxyService — HTTP + WebSocket upgrade pass-thru  │
│  · ScopedApiSurface — <slug>.localhost:8888/_os8/api/* enf.  │
│  · window.os8 SDK injected via BrowserView preload           │
│  · Sanitized env builder (whitelist + per-app secrets)       │
│  · AppProcessRegistry (lifecycle, port allocation)           │
│  · Dev mode toggle + fork-on-first-edit                      │
│  · SecurityReviewService (static + LLM review, gates install)│
│  · os8:// protocol handler (deeplink install)                │
│  · Hardened BrowserView config for external apps             │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 Surface vs Runtime

The AppSpec separates two concepts so the schema is forward-compatible:

- **Runtime** — what process is actually running underneath: `node | python | static | docker`.
- **Surface** — how the app is presented inside the OS8 window: `web` (v1 only).

Future v2+ surfaces (`terminal` for TUIs via xterm.js + node-pty, `desktop-stream` for native GUIs via noVNC) plug into the same window chrome without schema migration. **V1 implements `surface: web` only**, but the schema includes the field.

### 2.3 Trust tiers

| Channel | Source | Defaults |
|---|---|---|
| **Verified** | Manually reviewed manifests in `os8ai/os8-catalog`. Lockfile required, frozen install, pinned commit. | One-click install, minimal prompts, opt-in auto-update |
| **Community** | Lighter-review manifests in `os8ai/os8-catalog-community`. Lockfile recommended. | Warnings shown, explicit permission grants required, no auto-update |
| **Developer Import** | User pastes a GitHub URL in OS8. Auto-generated draft AppSpec. | High-friction install plan UI, all permissions opt-in, "developer mode" badge |

Security review (static analysis + LLM) **surfaces** risks across all three channels; review depth and confirm-friction increase from Verified → Developer Import. The runtime gate is **advisory** — see §6.5 for the model. The user is the final authority over what installs on their machine; the security review's job is to inform that decision, not gate it. Curators still gate manifest *entry* to the Verified and Community catalogs at submission time (CI in `os8ai/os8-catalog` and `os8ai/os8-catalog-community`).

---

## 3. AppSpec Schema (v1)

### 3.1 Full canonical example

```yaml
schemaVersion: 1
slug: worldmonitor
name: "World Monitor"
publisher: koala73
icon: ./icon.png                      # relative to manifest folder
screenshots:                          # relative to manifest folder
  - ./screenshots/01-dashboard.png
  - ./screenshots/02-detail.png
category: intelligence
description: "Real-time global intelligence dashboard."

upstream:
  git: https://github.com/koala73/worldmonitor.git
  ref: v1.4.2                         # tag or SHA; sync job resolves to immutable SHA

framework: vite                       # vite | nextjs | sveltekit | astro | streamlit | gradio | hugo | jekyll | none
                                      # When set, adapter applies known-good defaults for HMR,
                                      # base-path flag, readiness probe, lockfile choice.

runtime:
  kind: node                          # node | python | static | docker (docker = v2)
  version: "20"                       # major version
  arch: [arm64, x86_64]               # default if omitted
  package_manager: auto               # auto | npm | pnpm | yarn | bun | pip | uv | poetry
                                      # auto = detect from lockfile
  dependency_strategy: frozen         # frozen | strict | best-effort
                                      # Verified channel REQUIRES frozen; Community recommends.

env:                                  # Non-secret defaults; written to .env on install.
  - name: VITE_DEFAULT_PORT
    value: "5173"
    description: "Internal dev port"

install:                              # argv arrays; no shell strings.
  - argv: ["npm", "ci"]               # Frozen install when lockfile present.

postInstall:                          # Run once after `install` succeeds. Optional.
  - argv: ["npm", "run", "build:assets"]

preStart:                             # Run before each `start`. Optional.
  - argv: ["npm", "run", "migrate"]

start:
  argv: ["npm", "run", "dev", "--", "--port", "{{PORT}}", "--host", "127.0.0.1"]
  port: detect                        # detect | fixed:5173
  readiness:
    type: http                        # http | log-regex
    path: /
    timeout_seconds: 30

surface:
  kind: web                           # v1: web only
  preview_name: "World Monitor"
                                      # v1 routes every external app at <slug>.localhost:8888
                                      # — frameworks bind at / and don't need a base-path flag.

dev:
  hmr: vite                           # vite | next | streamlit | gradio | watcher | none
                                      # Inferred from `framework` if omitted.
  watch:                              # Only used when hmr: watcher.
    - src/
    - public/
  editable: true
  restart_on:                         # Files that require process restart, not HMR.
    - vite.config.*
    - package.json

permissions:
  network:
    outbound: true
    inbound: false                    # true = dev server reachable beyond localhost (rare).
  filesystem: app-private             # v1: only allowed value.
  os8_capabilities:                   # OS8 APIs the app may call via window.os8 / scoped surface.
    - blob.readwrite                  # Server-side enforcement; declared = allowed.
    - db.readwrite
  secrets:
    - name: NEWS_API_KEY
      required: true
      prompt: "Get a key at https://newsapi.org/register"
      pattern: "^[A-Za-z0-9]{32}$"

resources:                            # v1: advisory only.
  memory_limit_mb: 1024
  gpu: optional                       # required | optional | none
  disk_mb: 500

legal:
  license: AGPL-3.0
  commercial_use: restricted          # unrestricted | restricted | prohibited
  notes: "Personal use OK; commercial use requires upstream license."

review:
  channel: verified                   # verified | community | developer-import
  reviewed_at: 2026-04-15
  reviewer: os8-curators              # GitHub team handle
  risk: low                           # low | medium | high
```

### 3.2 Template variables

The runtime adapter substitutes these in `install`, `postInstall`, `preStart`, and `start.argv` items:

| Variable | Value |
|---|---|
| `{{APP_HOST}}` | The hostname the app is served at: `<slug>.localhost` (v1) |
| `{{PORT}}` | The port allocated by `AppProcessRegistry` |
| `{{APP_DIR}}` | Absolute path to `~/os8/apps/<id>/` |
| `{{BLOB_DIR}}` | Absolute path to `~/os8/blob/<id>/` |
| `{{OS8_BASE_URL}}` | `http://localhost:8888` |
| `{{OS8_API_BASE}}` | `http://<slug>.localhost:8888/_os8/api` (the scoped surface — same-origin from the app's perspective) |

`{{APP_HOST}}` is rarely needed in practice — most frameworks accept `--host 127.0.0.1` and infer everything else from request headers. It's exposed for the few cases where a framework needs an explicit `allowedHosts` configuration.

#### Two paths to per-app data — load-bearing distinction

There are two separate ways an installed app interacts with its per-app storage, and they grant access along different axes. Catalog manifest authors and reviewers should keep them distinct:

1. **OS-process filesystem I/O** — the app's spawned process (Python, Node, container PID 1) reads and writes its own files. Granted by `permissions.filesystem: app-private` (the v1 default and only value). Directed at the right paths via either argv substitution (`{{APP_DIR}}`, `{{BLOB_DIR}}`) or the env vars the runtime adapter injects (`OS8_APP_DIR`, `OS8_BLOB_DIR` — see §6.3.1). **No `os8_capabilities` declaration is required for this**: the OS process owns those directories; trust is enforced by file-system permissions and the sanitized env, not by the HTTP capability surface. This is the canonical mechanism for apps like ComfyUI / Stable Diffusion WebUI / InvokeAI that write generated artifacts to disk via their own filesystem APIs (`--output-directory`, `--data-dir` flags, etc.).

2. **Browser HTTP API surface** — the app's web frontend (the JS running in the BrowserView at `<slug>.localhost:8888`) calls OS8 APIs via `window.os8.blob.*` / `window.os8.db.*` / `window.os8.imagegen.*` etc. — which under the hood hit `<slug>.localhost:8888/_os8/api/...`. Granted by `permissions.os8_capabilities` (server-side enforced; see §6.3.2 / §6.3.3). This is the right path when the *frontend JS* needs to read/write blob storage (an upload widget, a saved-state UI), not when the OS process does its own filesystem I/O.

A manifest may use one path, the other, both, or neither. ComfyUI uses (1) only — its server writes outputs to `BLOB_DIR` via its `--output-directory` flag, and its frontend doesn't call `window.os8.*`. A pure-frontend app embedding `window.os8.blob.write(...)` uses (2) only. An app whose frontend uploads files (via `window.os8.blob.write`) and whose backend then processes those files at `BLOB_DIR/...` uses both — and declares `blob.readwrite`.

This distinction is implicit in §3.4's `permissions.filesystem` vs `permissions.os8_capabilities` definitions; calling it out here so reviewers don't ask "does ComfyUI need `blob.readwrite`?" (the answer is no — its server is the one writing, not its frontend).

### 3.3 Argv arrays, not shell strings

All command fields (`install`, `postInstall`, `preStart`, `start`) take **argv arrays** — never shell strings — to eliminate a class of injection bugs. Adapter spawns with `child_process.spawn(argv[0], argv.slice(1), { shell: false })`.

Exception: a manifest may declare `shell: true` on a single command if absolutely required, but this is a high-friction review flag and Verified channel should reject it.

### 3.4 Field reference

- `slug` — globally unique within the catalog channel. Lowercase, hyphenated, `[a-z0-9-]+`, max 40 chars. Reserved namespace: any slug starting with `os8-` is reserved for first-party apps.
- `category` — one of: `productivity | intelligence | media | dev-tools | data | ai-experiments | utilities`.
- `framework` — drives adapter defaults. When set, the adapter chooses HMR strategy, base-path flag pattern, readiness probe, and `package_manager: auto` resolution. Manifest can override.
- `runtime.kind` — drives which adapter handles the app. v1: `node | python | static`. v2: `docker`.
- `runtime.version` — major version. Adapter ensures availability (auto-installs uv for python; checks node version).
- `runtime.arch` — supported host architectures. Default `[arm64, x86_64]`. UI marks unsupported on user's host.
- `runtime.package_manager` — `auto` detects from lockfile presence (`package-lock.json` → npm, `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `bun.lockb` → bun, `uv.lock` → uv, `poetry.lock` → poetry, `requirements.txt` → pip).
- `runtime.dependency_strategy` — `frozen` requires lockfile and uses `npm ci` / `uv sync --frozen` / `pnpm install --frozen-lockfile`. `strict` allows lockfile drift but pins the manifest's commit. `best-effort` for Developer Import only. **Verified channel CI rejects manifests without `frozen` + lockfile.**
- `env` — non-secret env defaults. Written to `~/os8/apps/<id>/.env` on install (after staging). Available at `start` time.
- `install` / `postInstall` / `preStart` — argv arrays. `postInstall` runs once after first successful install; `preStart` runs before every `start`.
- `start.argv` — argv array. Substitutes `{{PORT}}` etc. The framework MUST bind at `/` (no base-path needed since v1 serves every external app at its own subdomain). Bind to `127.0.0.1` so the dev server isn't reachable beyond localhost.
- `start.port: detect` — adapter parses listening port. `start.port: fixed:N` — pinned port; **blocks concurrent instances** of this app.
- `start.readiness.type: http` — proxy waits for 2xx on the path. `log-regex` — proxy waits for a regex match in stdout.
- `surface.preview_name` — display name in the OS8 window chrome (defaults to `name` if unset).
- `dev.hmr` — inferred from `framework` if omitted; explicit value overrides.
- `permissions.network.inbound` — when true, dev server binds `0.0.0.0`. Major review red flag.
- `permissions.filesystem` — `app-private` only in v1. Grants the OS process read/write inside its own `OS8_APP_DIR` and `OS8_BLOB_DIR` (the directories named by the env vars the adapter injects — see §6.3.1). This is the right grant for apps that direct their server-side filesystem I/O at OS8 paths via argv flags like ComfyUI's `--output-directory {{BLOB_DIR}}` (§3.2 "Two paths to per-app data").
- `permissions.os8_capabilities` — the OS8 **HTTP API surfaces** the app's *web frontend* may call via the scoped surface (`<slug>.localhost:8888/_os8/api/...` and the `window.os8.*` SDK that wraps it). **Server-side enforced.** Distinct from `permissions.filesystem`: this gates JS-from-the-browser API calls, not OS-process filesystem I/O. v1 capabilities: `blob.readwrite | blob.readonly | db.readwrite | db.readonly | telegram.send | imagegen | speak | youtube | x | google.calendar.readonly | google.calendar.readwrite | google.drive.readonly | google.gmail.readonly | mcp.<server>.<tool>`.
- `permissions.secrets` — declared secrets prompted on install, stored per-app, injected at process spawn.
- `resources.*` — advisory in v1.
- `legal.commercial_use: unrestricted | restricted | prohibited` — surfaced in install plan UI.
- `review.risk` — set by curator after review; displayed in install plan UI.

### 3.5 JSON Schema validation (CI invariants)

- `upstream.ref` MUST match a 40-char SHA OR a tag `v\d+\.\d+\.\d+(-.+)?`. Branch names rejected.
- `slug` regex: `^[a-z][a-z0-9-]{1,39}$`.
- `runtime.kind: docker` rejected in v1.
- `surface.kind` MUST equal `web` in v1.
- `surface.base_path_strategy` is NOT a v1 field. v1 serves every external app at `<slug>.localhost:8888`. The schema does not accept the field; manifests that include it are rejected. (Reserved for a future schema version if a path-mode use case ever surfaces.)
- `permissions.filesystem` MUST equal `app-private` in v1.
- All command fields MUST be argv arrays; `shell: true` flagged for curator review.
- `review.channel: verified` REQUIRES `runtime.dependency_strategy: frozen` AND a lockfile present in the upstream repo at `upstream.ref`.

---

## 4. Catalog Repository (`os8ai/os8-catalog`)

### 4.1 Layout

```
os8ai/os8-catalog/
├── README.md
├── schema/
│   └── appspec-v1.json                  # JSON Schema
├── apps/
│   ├── worldmonitor/
│   │   ├── manifest.yaml
│   │   ├── icon.png                     # 256×256, ≤100KB
│   │   ├── screenshots/                 # ≤500KB each, max 5
│   │   └── README.md                    # editorial copy (rendered on detail page)
│   └── …
├── .github/
│   ├── workflows/
│   │   ├── validate.yml                 # ajv schema, image checks, slug uniqueness
│   │   ├── resolve-refs.yml             # tag → SHA resolution on PR
│   │   ├── lockfile-gate.yml            # Verified channel: reject if no lockfile
│   │   └── notify-os8ai.yml             # webhook to os8.ai on merge
│   └── CODEOWNERS                       # per-app ownership
└── CONTRIBUTING.md
```

### 4.2 PR workflow

1. Contributor opens a PR adding `apps/<slug>/manifest.yaml` + assets.
2. CI validates: schema, image dimensions/sizes, slug uniqueness, no `runtime.kind: docker` in v1, all argv arrays.
3. CI's `resolve-refs` job: for each `upstream.ref` that's a tag, resolves to the immutable commit SHA via the GitHub API and posts the resolved SHA as a PR comment for curator review.
4. CI's `lockfile-gate` job: for `review.channel: verified`, checks out the upstream at the resolved SHA and asserts a recognized lockfile exists.
5. Curator reviews: source repo legitimacy, license, `start.argv` sanity, permissions match observed code.
6. On merge: GitHub webhook fires `POST https://os8.ai/api/internal/catalog/sync` (HMAC-signed).
7. os8.ai sync job pulls the changed tree, re-resolves tags to SHAs (in case the catalog merge happened later), and upserts `App` rows.

### 4.3 The Community channel (Phase 3)

Separate repo `os8ai/os8-catalog-community` with the same schema and CI. Lighter human review (no curator approval; spam/malware filter only). Apps land in OS8 with `channel='community'`, requiring explicit permission grants.

### 4.4 Asset hosting

Icons and screenshots are served via GitHub raw URLs **pinned to the catalog commit SHA at sync time**, not `main`:

```
https://raw.githubusercontent.com/os8ai/os8-catalog/<catalog_commit_sha>/apps/<slug>/icon.png
```

This prevents asset drift independent of manifest version. `os8.ai` rewrites raw URLs at sync time and stores them in the `App` row.

---

## 5. os8.ai Website Side

### 5.1 Prisma schema additions

```prisma
// Existing models: User, DesktopAuthCode (unchanged)

model App {
  id                       String   @id @default(cuid())
  slug                     String   @unique
  name                     String
  description              String   @db.Text
  publisher                String
  channel                  String   // verified | community
  category                 String
  iconUrl                  String   // pinned to catalog commit SHA
  screenshots              String[] @default([])

  // Manifest version tracking — four distinct fields:
  manifestSha              String   // SHA of manifest.yaml content
  catalogCommitSha         String   // catalog repo SHA at sync time
  upstreamDeclaredRef      String   // what the manifest says (e.g. "v1.4.2")
  upstreamResolvedCommit   String   // 40-char SHA the tag pointed to at resolve time

  manifestYaml             String   @db.Text
  license                  String
  runtimeKind              String
  framework                String?
  architectures            String[] @default(["arm64", "x86_64"])
  riskLevel                String   // low | medium | high
  installCount             Int      @default(0)
  syncedAt                 DateTime
  publishedAt              DateTime
  updatedAt                DateTime @updatedAt
  deletedAt                DateTime?
  pendingInstalls          PendingInstall[]

  @@index([channel, category])
  @@index([publishedAt])
  @@index([deletedAt])
}

model PendingInstall {
  id                       String   @id @default(cuid())
  userId                   String
  user                     User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  appSlug                  String
  upstreamResolvedCommit   String   // pin to specific install version
  channel                  String
  status                   String   @default("pending") // pending | consumed | expired
  createdAt                DateTime @default(now())
  consumedAt               DateTime?
  expiresAt                DateTime // createdAt + 7 days

  app App @relation(fields: [appSlug], references: [slug], onDelete: Cascade)

  @@index([userId, status])
}

model CatalogState {
  id                       String   @id  // 'verified-singleton' | 'community-singleton'
  channel                  String   @unique
  lastSyncedSha            String
  lastSyncedAt             DateTime
  appCount                 Int
}

model User {
  // …existing fields
  pendingInstalls PendingInstall[]
  installedApps   InstalledApp[]   // PR 4.3
}

// PR 4.3 — desktop heartbeat reports installed apps so the public
// detail page can show "Update available" badges to the signed-in user.
model InstalledApp {
  id                     String   @id @default(cuid())
  userId                 String
  user                   User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  appSlug                String
  upstreamResolvedCommit String   // 40-char SHA
  channel                String   // verified | community | developer-import
  installedAt            DateTime @default(now())
  lastReportedAt         DateTime @updatedAt

  @@unique([userId, appSlug])
  @@index([userId])
}

// PR 4.5 — anonymous install telemetry. Raw events with 30-day retention;
// daily rollup kept indefinitely. clientId is double-hashed (random UUID
// on desktop + HMAC-SHA256 with TELEMETRY_HASH_SALT server-side).
model InstallEvent {
  id                 String   @id @default(cuid())
  clientId           String   // server-rehashed; never plaintext
  kind               String   // install_started | install_succeeded | install_failed | install_cancelled | install_overridden | update_succeeded | update_failed
  adapter            String?  // node | python | static | docker
  framework          String?  // vite | nextjs | streamlit | gradio | hugo | jekyll | none
  channel            String?  // verified | community | developer-import
  slug               String?
  commit             String?  // 40-char SHA
  failurePhase       String?  // install | postInstall | preStart | start
  failureFingerprint String?  // 8-32 hex prefix
  durationMs         Int?
  os                 String?  // darwin | linux | win32
  arch               String?
  overrideReason     String?
  ts                 DateTime @default(now())

  @@index([ts])
  @@index([adapter, framework, channel, kind, ts])
  @@index([slug, ts])
  @@index([failureFingerprint])
}

// Daily rollup populated by /api/internal/telemetry/rollup at 01:05 UTC.
// `framework` is non-nullable (with "none" placeholder) because Postgres
// treats NULL as distinct in unique indexes — would let the rollup
// write duplicates for (day, adapter, channel, kind) when framework
// is missing.
model InstallEventDaily {
  id        String   @id @default(cuid())
  day       DateTime @db.Date
  adapter   String
  framework String   // "none" placeholder when source event had no framework
  channel   String
  kind      String
  count     Int

  @@unique([day, adapter, framework, channel, kind])
  @@index([day])
}

model App {
  // …existing fields, plus per-app counters added by PR 4.5:
  // installSuccessCount Int @default(0)
  // installFailCount Int @default(0)
  // installOverriddenCount Int @default(0)
  // lastInstallEventAt DateTime?
}
```

### 5.2 Routes

| Route | Method | Purpose |
|---|---|---|
| `/apps` | GET (page) | Browse listing. Filter by category, channel, framework. Search by name. |
| `/apps/[slug]` | GET (page) | Detail: screenshots, README rendered, license, install button. |
| `/api/apps` | GET | JSON listing. `?channel=&category=&framework=&q=`. |
| `/api/apps/[slug]` | GET | JSON detail; includes `manifestYaml` and resolved commit. |
| `/api/apps/[slug]/install` | POST | Signed-in: create `PendingInstall`. Anonymous: 200 OK no-op (deeplink does the work). |
| `/api/apps/[slug]/track-install` | POST | Increment `installCount` (anonymous OK; rate-limited per IP/day). |
| `/api/account/pending-installs` | GET | List pending for current user. Polled by desktop. |
| `/api/account/pending-installs/[id]/consume` | POST | Mark consumed. Called by desktop. |
| `/api/internal/catalog/sync` | POST | Webhook receiver (HMAC). Resolves tags → SHAs. |
| `/api/internal/catalog/sync` | POST (cron) | Vercel Cron every 30 min as safety net. |

### 5.3 Sync job (with tag-to-SHA resolution)

Endpoint: `POST /api/internal/catalog/sync`

1. Verify HMAC signature (`X-Hub-Signature-256` against `CATALOG_WEBHOOK_SECRET`); cron uses internal token.
2. Read `CatalogState.lastSyncedSha` for the channel.
3. Fetch GitHub Trees API for `os8ai/os8-catalog` at `main`, diffed against `lastSyncedSha`.
4. For each changed `apps/<slug>/manifest.yaml`:
   - Fetch the file via GitHub Contents API.
   - Parse YAML; validate against JSON Schema (server-side ajv).
   - **Resolve `upstream.ref`**: if it's a tag, call `GET /repos/{owner}/{repo}/git/refs/tags/{tag}` to get the immutable SHA. Store both `upstreamDeclaredRef` and `upstreamResolvedCommit`. If it's already a 40-char SHA, copy to both fields.
   - **Pin asset URLs**: rewrite `icon` and `screenshots[]` paths to `https://raw.githubusercontent.com/os8ai/os8-catalog/<currentCatalogSha>/apps/<slug>/...`.
   - Compute `manifestSha` (SHA-256 of manifest content).
   - Upsert `App` row keyed by `slug`. Update only if `manifestSha` or `catalogCommitSha` changed.
5. For each removed manifest: set `App.deletedAt = now()` (soft delete). Existing `PendingInstall` rows for soft-deleted apps remain valid for their TTL but new installs are blocked.
6. Update `CatalogState.lastSyncedSha` and `lastSyncedAt`.
7. Emit telemetry/log event with diff summary.

### 5.4 `/apps` page contract

Server-rendered Next.js page (ISR with 60s revalidation):

- Top: search input (minisearch over name + description), category filter pills, channel filter, framework filter.
- Grid: card per app (icon, name, publisher, one-line description, category badge, channel badge if Community, framework badge).
- Card click → `/apps/[slug]`.

Detail page:

- Header: icon, name, publisher, channel badge.
- Screenshots carousel.
- Description (markdown) + rendered `README.md` from the catalog folder.
- Sidebar: license, supported architectures, framework, manifest commit SHA, source repo link, install count, Install button.
- Install button:
  - Always emits `<a href="os8://install?slug={slug}&commit={upstreamResolvedCommit}&channel={channel}&source=os8.ai">`.
  - If signed in, also `POST /api/apps/[slug]/install` to queue `PendingInstall`.
  - "OS8 not installed?" link → desktop download page.

---

## 6. OS8 Desktop Side

### 6.1 Database schema additions

Migration file: `src/migrations/0.5.0-app-store.js` (target version TBD; pick the next minor at implementation time).

```sql
-- Extend apps table.
ALTER TABLE apps ADD COLUMN external_slug TEXT;             -- catalog identity, immutable
ALTER TABLE apps ADD COLUMN channel TEXT;                   -- verified | community | developer-import
ALTER TABLE apps ADD COLUMN framework TEXT;
ALTER TABLE apps ADD COLUMN manifest_yaml TEXT;             -- raw manifest at install time
ALTER TABLE apps ADD COLUMN manifest_sha TEXT;              -- SHA-256 of manifest content
ALTER TABLE apps ADD COLUMN catalog_commit_sha TEXT;
ALTER TABLE apps ADD COLUMN upstream_declared_ref TEXT;
ALTER TABLE apps ADD COLUMN upstream_resolved_commit TEXT;  -- 40-char SHA actually installed
ALTER TABLE apps ADD COLUMN user_branch TEXT;               -- local user branch when fork-on-first-edit triggers
ALTER TABLE apps ADD COLUMN dev_mode INTEGER DEFAULT 0;
ALTER TABLE apps ADD COLUMN auto_update INTEGER DEFAULT 0;
ALTER TABLE apps ADD COLUMN update_available INTEGER DEFAULT 0;
ALTER TABLE apps ADD COLUMN update_to_commit TEXT;          -- the commit SHA available
-- apps.app_type: extend to include 'external'.
-- apps.status: extend to include 'uninstalled'.

CREATE INDEX idx_apps_external_slug ON apps(external_slug);
CREATE INDEX idx_apps_app_type ON apps(app_type);

-- App catalog (mirror of skill_catalog pattern).
CREATE TABLE app_catalog (
  id                       TEXT PRIMARY KEY,
  slug                     TEXT NOT NULL UNIQUE,
  name                     TEXT NOT NULL,
  description              TEXT,
  publisher                TEXT,
  channel                  TEXT NOT NULL,
  category                 TEXT,
  icon_url                 TEXT,
  screenshots              TEXT,                            -- JSON array
  manifest_yaml            TEXT NOT NULL,
  manifest_sha             TEXT NOT NULL,
  catalog_commit_sha       TEXT NOT NULL,
  upstream_declared_ref    TEXT NOT NULL,
  upstream_resolved_commit TEXT NOT NULL,
  license                  TEXT,
  runtime_kind             TEXT,
  framework                TEXT,
  architectures            TEXT,                            -- JSON array
  risk_level               TEXT,
  install_count            INTEGER DEFAULT 0,
  rating                   REAL,
  synced_at                TEXT,
  deleted_at               TEXT
);

CREATE INDEX idx_app_catalog_channel ON app_catalog(channel);
CREATE INDEX idx_app_catalog_category ON app_catalog(category);
CREATE INDEX idx_app_catalog_deleted ON app_catalog(deleted_at);

CREATE VIRTUAL TABLE app_catalog_fts USING fts5(
  slug, name, description, publisher, category, framework,
  content='app_catalog', content_rowid='rowid'
);
-- Triggers to keep FTS in sync (mirror skill_catalog_fts pattern).

-- Install job state machine.
CREATE TABLE app_install_jobs (
  id                       TEXT PRIMARY KEY,
  app_id                   TEXT,                            -- nullable until 'apps' row created
  external_slug            TEXT NOT NULL,
  upstream_resolved_commit TEXT NOT NULL,
  channel                  TEXT NOT NULL,
  status                   TEXT NOT NULL,
  -- pending | cloning | reviewing | awaiting_approval | installing
  -- | installed | failed | cancelled
  staging_dir              TEXT,                            -- ~/os8/apps_staging/<job_id>/
  review_id                TEXT,                            -- FK to capabilities review
  error_message            TEXT,
  log_path                 TEXT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);

CREATE INDEX idx_install_jobs_status ON app_install_jobs(status);
CREATE INDEX idx_install_jobs_slug ON app_install_jobs(external_slug);
```

### 6.2 Services

#### 6.2.1 `AppCatalogService` (`src/services/app-catalog.js`)

Mirrors `SkillCatalogService` shape. The `install` method runs the **review-before-install** pipeline:

```js
const AppCatalogService = {
  // Sync from os8.ai catalog endpoint into local app_catalog table.
  async sync(db, { channel = 'verified', force = false } = {}) { /* … */ },

  // Search local mirror.
  search(db, query, { channel, category, framework, limit = 50 } = {}) { /* … */ },

  // Get a single catalog entry (with manifestYaml parsed).
  get(db, slug) { /* … */ },

  // Install — review-before-install pipeline.
  // Returns { jobId, status }; UI subscribes to job state for progress.
  async install(db, { slug, commit, channel, secrets, onProgress } = {}) {
    // 1. Resolve manifest from app_catalog (fetch from os8.ai if missing).
    // 2. Validate manifest mechanically (JSON Schema, channel rules, lockfile gate
    //    for Verified — verified by re-fetching upstream tree at upstream_resolved_commit).
    // 3. Create app_install_jobs row, status='cloning'.
    // 4. git clone --branch <upstream_resolved_commit> --depth 1 into staging_dir.
    //    NO install commands run yet.
    // 5. status='reviewing'. Run SecurityReviewService.reviewApp(...) which performs:
    //    - Static analysis (npm audit, eval/exec greps, dependency license scan)
    //    - Pattern checks (curl|sh, postinstall hooks, undeclared network/listeners)
    //    - LLM review against manifest claims
    // 6. status='awaiting_approval'. UI surfaces install plan with review results.
    // 7. User approves AND enters required secrets.
    //    On reject: status='cancelled', cleanup staging_dir.
    // 8. status='installing'. Now run runtime adapter install (sandboxed env).
    // 9. On success: atomic move staging_dir → ~/os8/apps/<id>/.
    //    Insert apps row with app_type='external', status='active'.
    //    Save secrets via app_env_variables.
    //    Initialize git: checkout -b user/main, generate .gitignore.
    //    status='installed'.
    // 10. POST track-install to os8.ai (anonymous, fire-and-forget).
  },

  // Uninstall: stop process, delete code, optionally delete data.
  async uninstall(db, appId, { deleteData = false } = {}) { /* … */ },

  // Update to a new resolved commit. Triggers fork-on-first-edit merge if needed.
  async update(db, appId, targetCommit) { /* … */ },

  // Internal: re-resolve manifest from os8.ai when local mirror is stale.
  async fetchManifest(slug, channel) { /* … */ },

  // Cleanup orphaned staging dirs from failed installs (called on startup).
  async reapStaging(db) { /* … */ }
};
```

#### 6.2.2 `RuntimeAdapter` interface (`src/services/runtime-adapters/`)

```js
const NodeRuntimeAdapter = {
  kind: 'node',

  // Returns true if this host can run this runtime version. Auto-installs uv etc.
  async ensureAvailable(spec) { /* throws on hard failure */ },

  // Detect package manager from lockfile presence.
  detectPackageManager(appDir) { /* npm | pnpm | yarn | bun */ },

  // Run install + postInstall commands as argv arrays. Streams stdout to onLog.
  // Receives sanitized env (see §6.3.1) — never raw process.env.
  async install(spec, appDir, sanitizedEnv, onLog) { /* … */ },

  // Run preStart commands, then spawn the dev server.
  // Returns { pid, port, ready: Promise<void> }.
  // ready resolves when readiness check passes.
  async start(spec, appDir, sanitizedEnv, onLog) { /* … */ },

  // SIGTERM, then SIGKILL after 5s. Uses cross-platform tree-kill.
  async stop(processInfo) { /* … */ },

  // Wire HMR or watcher. Returns disposer.
  watchFiles(spec, appDir, onChange) { /* returns () => void */ },

  // Get currently-installed version (for update conflict detection).
  async detectVersion(spec, appDir) { /* … */ }
};
```

Adapter applies `framework` defaults when manifest fields are absent. E.g. `framework: vite` implies:
- `dev.hmr: vite`
- `start.readiness.type: http, path: /`
- Default flags: `--port {{PORT}} --host 127.0.0.1` (no base-path; v1 routes per subdomain)
- Lockfile preference: `package-lock.json | pnpm-lock.yaml | yarn.lock | bun.lockb`

#### 6.2.3 `ReverseProxyService` (`src/services/reverse-proxy.js`)

Keyed by **local `slug`** (not `external_slug`). Resolves the target by `Host` header.

```js
const ReverseProxyService = {
  _proxies: new Map(),  // localSlug -> { appId, port, status }

  register(localSlug, appId, port) { /* … */ },
  unregister(localSlug) { /* … */ },
  getPort(localSlug) { /* … */ },

  // Express middleware: matches Host: <slug>.localhost:8888 against the registry,
  // proxies to 127.0.0.1:<port>. Native apps on bare `localhost:8888` fall through
  // to the existing catch-all unchanged.
  middleware() { /* (req, res, next) => {…} */ },

  // CRITICAL — wires server.on('upgrade', …) for WebSocket HMR.
  attachUpgradeHandler(server) { /* … */ }
};
```

`*.localhost` resolves to `127.0.0.1` natively per RFC 6761 on macOS, Linux, and modern Windows (Win10 1709+ / Win11). On legacy or AV-restricted Windows setups where resolution fails, OS8 surfaces a clear "your network can't resolve `<slug>.localhost`" message at install time with a "Write hosts entry?" prompt (UAC-elevated). Host-resolution failure is a recoverable install-time error, not a permanent block — see §6.6.

#### 6.2.4 `AppProcessRegistry` (`src/services/app-process-registry.js`)

```js
const AppProcessRegistry = {
  _processes: new Map(),  // appId -> { pid, port, status, startedAt, lastActiveAt,
                          //            lastStdoutAt, lastChildActivityAt, devMode,
                          //            watcherDispose, keepRunning }

  async start(db, appId, { devMode = false } = {}) { /* … */ },
  async stop(appId, { reason } = {}) { /* … */ },
  get(appId) { /* … */ },
  getAll() { /* … */ },

  // Mark HTTP activity (called by proxy middleware on every request).
  markHttpActive(appId) { /* … */ },

  // Mark stdout/stderr activity (called by adapter on output).
  markStdoutActive(appId) { /* … */ },

  // Mark child-process activity (called by adapter when it observes spawned children).
  markChildActive(appId) { /* … */ },

  // Per-app override: disable idle-reap for long-running jobs.
  setKeepRunning(appId, enabled) { /* … */ },

  // Stop apps idle on ALL signals (HTTP + stdout + child) for > IDLE_TIMEOUT_MS.
  // Default 30 min, configurable in Settings. keepRunning=true bypasses entirely.
  reapIdle() { /* … */ },

  async stopAll() { /* … */ }
};
```

Port allocation: random `[40000, 49999]`, reroll on EADDRINUSE up to 5 attempts, fall to OS-allocated as last resort.

#### 6.2.5 `SecurityReviewService` (renamed from `SkillReviewService`)

`src/services/skill-review.js` → `src/services/security-review.js`. Adds `reviewApp(...)` alongside the existing `reviewSkill(...)`. Shared base for the LLM call pattern.

App review pipeline (runs after clone, before install):

1. **Static checks (deterministic, fast):** these emit findings into the review report; they short-circuit the LLM phase when any blocker is present, but **do not by themselves block install** — see §6.5 for the gate model. The user can override on confirm. Checks:
   - Argv arrays only (no shell strings).
   - No `curl … | sh` or `wget … | sh` patterns in `install`/`postInstall`/`preStart`.
   - No remote-script execution in source (`eval(fetch(...))`-style patterns).
   - `package.json` `scripts.postinstall` / `preinstall` — present scripts get LLM scrutiny; absent is preferred for Verified.
   - Lockfile present and matches declared `package_manager` (Verified channel).
   - Architecture compatibility (`runtime.arch` includes `process.arch`). **This is the one structural impossibility that DOES hard-block** at the gate — the runtime adapter would refuse to launch anyway.
   - Manifest pin: `upstream_resolved_commit` is a 40-char SHA.
2. **Static analysis (advisory in v1):**
   - Node: `npm audit --json` parsed for high/critical CVEs.
   - Python: `pip check` + (Phase 3) `safety` / `osv-scanner`.
   - License scan of declared deps cross-referenced with `legal.license`.
   - Pattern greps: `child_process.exec` / `eval` / `Function()` / dynamic `require()` calls.
3. **LLM review (against manifest claims):**
   - `start.argv` — what process actually runs. Cross-check filesystem-targeting flags (`--output-directory`, `--data-dir`, `--cache-dir`, `--user-directory`, etc.) against `OS8_APP_DIR` / `OS8_BLOB_DIR`; flag any that target paths outside the app's scope (e.g. `~/Documents`, `/tmp/global`).
   - Permissions match observed code? **Two checks, not one:** (a) cross-check `permissions.os8_capabilities` against `window.os8.*` SDK calls and `fetch('/_os8/api/...')` calls in the *frontend* JS (over- and under-declaration); (b) cross-check `permissions.filesystem: app-private` against *backend* filesystem APIs (`open()`, `fs.writeFile`, `pathlib.Path.write_*`, etc.) — flag writes outside `OS8_APP_DIR` / `OS8_BLOB_DIR`.
   - Network behavior: outbound endpoints listed in source.
   - Filesystem access outside `app-private` scope (covered above; reiterated for emphasis on backend-side checks).
   - Secrets handling: are declared secrets sent to upstream servers?
   - Supply chain: count and flag suspicious deps.

LLM produces a structured report (mirrors existing skill review format). UI surfaces: risk level, findings list, install commands that will run, dep counts, audit summary. **The report is advisory; final approval lives at the install-plan gate (§6.5)** where the user reads what was flagged and decides whether to install.

**Phase 3 product principle (recorded 2026-05-01):** *"Scan surfaces, user decides."* The first realistic Developer Import (worldmonitor) was classified high-risk by the LLM with five critical findings — all judgment calls about manifest-vs-code drift, none of them malware. The original PR 1.17 hard-block model left users no path forward; the override-with-confirm model preserves the visibility of findings without making them load-bearing.

#### 6.2.6 `os8://` protocol handler

In `main.js`, near the top of `app.whenReady()`:

```js
// Single-instance lock SCOPED BY OS8_HOME so dev instances coexist.
const lockKey = `os8-${(process.env.OS8_HOME || os.homedir()).replace(/[^\w]/g, '_')}`;
const gotLock = app.requestSingleInstanceLock({ key: lockKey });
if (!gotLock) {
  app.quit();
  return;
}

app.setAsDefaultProtocolClient('os8');

app.on('open-url', (event, url) => {                  // macOS
  event.preventDefault();
  handleProtocolUrl(url);
});

app.on('second-instance', (event, argv) => {          // Windows/Linux
  const url = argv.find(arg => arg.startsWith('os8://'));
  if (url) handleProtocolUrl(url);
  if (mainWindow) mainWindow.focus();
});

function handleProtocolUrl(url) {
  // Parse: os8://install?slug=worldmonitor&commit=<sha>&channel=verified&source=os8.ai
  // Validate slug, commit (40-char SHA), channel.
  // Cross-check against local app_catalog or fetch from os8.ai.
  // Route to install plan UI.
}
```

Error states: see §6.6.

### 6.3 Trust Boundary (NEW — load-bearing for v1)

External apps are not same-origin-trusted. Three mechanisms enforce this:

#### 6.3.1 Sanitized environment

External app processes do **not** inherit `process.env` wholesale and do **not** receive global `env_variables`. The runtime adapter builds env from explicit pieces:

```js
const sanitizedEnv = {
  // Whitelisted host vars (cross-platform).
  PATH:     process.env.PATH,
  HOME:     os.homedir(),
  TMPDIR:   os.tmpdir(),         // (TEMP/TMP on Windows)
  LANG:     process.env.LANG,
  TZ:       process.env.TZ,
  USER:     process.env.USER     || process.env.USERNAME,
  ...(process.env.LC_ALL  ? { LC_ALL:  process.env.LC_ALL  } : {}),
  ...(process.env.LC_CTYPE ? { LC_CTYPE: process.env.LC_CTYPE } : {}),

  // Runtime-specific (only when relevant; e.g. Node):
  // (NodePath added if app declares it via runtime config — not by default.)

  // OS8-injected (always for external apps):
  OS8_APP_ID:    appId,
  OS8_APP_DIR:   path.join(APPS_DIR, appId),
  OS8_BLOB_DIR:  path.join(BLOB_DIR, appId),
  OS8_BASE_URL:  `http://localhost:${OS8_PORT}`,
  OS8_API_BASE:  `http://${localSlug}.localhost:${OS8_PORT}/_os8/api`,
  PORT:          allocatedPort,

  // Per-app declared env (manifest `env:` array).
  ...manifestEnv,

  // Per-app declared secrets (manifest `permissions.secrets`).
  ...appEnvVariables,
};
```

Explicitly NOT inherited:

- API keys, OAuth tokens, credentials from `process.env` or `env_variables`.
- Host env vars that aren't in the whitelist.
- Other apps' secrets.

The whitelist is conservative; manifests can declare additional needed env via the `env:` array (non-secret) or `permissions.secrets` (secret). Adding a host variable to the whitelist requires a Verified-channel curator review.

#### 6.3.2 Server-side capability enforcement

External apps load at `<slug>.localhost:8888/`, which is a **different browser origin** from OS8's main UI at `localhost:8888/`. Same-origin policy gives free isolation between apps and between apps and the OS8 shell. Within an app's own origin, the SDK calls relative URLs at `/_os8/api/*`, and a path-prefix middleware on the OS8 server matches and authorizes them — derived from the request's `Host` header, not the URL path.

The fix: external apps may **only** access OS8 APIs via the scoped surface on their own subdomain:

```
http://<localSlug>.localhost:8888/_os8/api/<capability>/<path>
```

A new middleware mounted before the proxy and the catch-all:

```js
// src/services/scoped-api-surface.js
function scopedApiMiddleware(req, res, next) {
  // 1. Resolve slug from Host header.
  const host = (req.headers.host || '').toLowerCase();
  const hostMatch = host.match(/^([a-z][a-z0-9-]{1,39})\.localhost(?::\d+)?$/);
  if (!hostMatch) return next();             // not a subdomain request

  // 2. Check this is the scoped API path on the subdomain.
  const apiMatch = req.path.match(/^\/_os8\/api\/(.+)$/);
  if (!apiMatch) return next();              // it's an app traffic request — proxy handles it

  const [, localSlug] = hostMatch;
  const [, apiPath]   = apiMatch;
  const app = AppService.getBySlug(db, localSlug);
  if (!app || app.app_type !== 'external') {
    return res.status(404).json({ error: 'not an external app' });
  }

  // 3. Parse capability from apiPath, e.g. "blob/foo" → "blob.readwrite" | "blob.readonly".
  const requestedCap = resolveCapability(apiPath, req.method);
  const allowed = parseManifest(app.manifest_yaml).permissions.os8_capabilities;
  if (!isAllowed(requestedCap, allowed)) {
    return res.status(403).json({
      error: 'capability not declared',
      requested: requestedCap,
      declared: allowed
    });
  }

  // 4. Inject app context, rewrite URL to internal route, forward via next().
  req.headers['x-os8-app-id'] = app.id;
  req.url = (apiPath.startsWith('blob') || apiPath.startsWith('db'))
    ? `/api/apps/${app.id}/${apiPath}`        // per-app routers
    : `/api/${apiPath}`;                       // shared routers
  return next();
}
```

Mount order in `src/server.js`:

```js
app.use(scopedApiMiddleware);              // <slug>.localhost:8888/_os8/api/* → /api/...
app.use(ReverseProxyService.middleware()); // <slug>.localhost:8888/* (other paths) → proxied
// then existing /:identifier catch-all (native apps on bare localhost:8888)
```

External apps' direct calls to `/api/*` on the OS8 main origin (`localhost:8888/api/...`) are blocked by browser CORS — different origin, no CORS headers on those routes. Same-origin attempts on the subdomain are caught by the scoped middleware above.

**Phase 4 PR 4.6 (`os8ai/os8#53`).** The "trust the bare-origin caller" gap was tightened. Native apps and the OS8 shell still call `/api/*` on the bare `localhost:8888` origin without the header, but the `requireAppContext` middleware now enforces an explicit **origin allowlist** (only `localhost` / `127.0.0.1` on the OS8 port) instead of the v1 "no header → trust" rule. Server-internal callers (catalog scheduler, periodic health-checks) authenticate via `X-OS8-Internal-Token` matching the per-instance `_internal_call_token` (seeded by migration 0.6.0; mirrored to `process.env.OS8_INTERNAL_CALL_TOKEN` at startup). Rollback escape hatch: set `OS8_REQUIRE_APP_CONTEXT_PERMISSIVE=1` in the launch env to revert to v1 behavior.

The scoped surface adds zero friction for app authors **when they use the SDK** (§6.3.3) — the SDK calls relative URLs and the browser sends them to the same origin.

Capabilities to surface (v1):
- `blob.readwrite` / `blob.readonly` → `<slug>.localhost:8888/_os8/api/blob/*`
- `db.readwrite` / `db.readonly` → `<slug>.localhost:8888/_os8/api/db/*`
- `telegram.send` → `<slug>.localhost:8888/_os8/api/telegram/send`
- `imagegen` → `<slug>.localhost:8888/_os8/api/imagegen/*`
- `speak` → `<slug>.localhost:8888/_os8/api/speak/*`
- `youtube` → `<slug>.localhost:8888/_os8/api/youtube/*`
- `x` → `<slug>.localhost:8888/_os8/api/x/*`
- `google.calendar.readonly` / `google.drive.readonly` / `google.gmail.readonly` → scoped Google routes
- `mcp.<server>.<tool>` → `<slug>.localhost:8888/_os8/api/mcp/<server>/<tool>`
- `mcp.<server>.*` (PR 4.7) → grants ALL current AND future tools registered by `<server>`. The trust grant scopes to the server itself; if the MCP server registers a new tool tomorrow, the app can call it without re-install. JSON-schema validation rejects `mcp.*.*`, bare `mcp.*`, and `mcp.<server>.*.<tool>` (catch-all forms that would broaden trust beyond a single named server). The runtime checker is intentionally narrow to MCP-only wildcards as defense-in-depth.

#### 6.3.3 `window.os8` SDK (BrowserView preload)

Apps don't need to hardcode the scoped path. A separate preload script for external-app BrowserViews injects a typed SDK:

```js
// src/preload-external-app.js (loaded only in external-app BrowserViews)
const { contextBridge } = require('electron');

// The page's origin IS the app's subdomain — relative URLs are exactly right.
const apiBase = '/_os8/api';

contextBridge.exposeInMainWorld('os8', {
  blob: {
    read:   (key) => fetch(`${apiBase}/blob/${encodeURIComponent(key)}`).then(r => r.blob()),
    write:  (key, data) => fetch(`${apiBase}/blob/${encodeURIComponent(key)}`, { method: 'PUT', body: data }),
    list:   (prefix = '') => fetch(`${apiBase}/blob?prefix=${encodeURIComponent(prefix)}`).then(r => r.json()),
    delete: (key) => fetch(`${apiBase}/blob/${encodeURIComponent(key)}`, { method: 'DELETE' })
  },
  db: {
    query:   (sql, params) => fetch(`${apiBase}/db/query`,   { method: 'POST', body: JSON.stringify({ sql, params }) }).then(r => r.json()),
    execute: (sql, params) => fetch(`${apiBase}/db/execute`, { method: 'POST', body: JSON.stringify({ sql, params }) }).then(r => r.json())
  },
  // imagegen, speak, telegram, youtube, x, google, mcp: thin wrappers over fetch.
  // Methods only exist on the exposed object when declared in permissions.os8_capabilities;
  // calling an undeclared method returns a structured "capability not granted" error
  // (the server returns 403; the SDK surfaces a clear exception).
});
```

The auto-generated CLAUDE.md for external apps documents `window.os8` and points at the manifest's declared capabilities — so Claude Code editing the app knows what's available.

### 6.4 The catch-all route change

In `src/server.js`, mount in this order before line 682. Both new middlewares dispatch on `Host` header — `<slug>.localhost:8888` matches an external app, anything else (`localhost:8888`, `127.0.0.1:8888`, the LAN IP) falls through unchanged.

```js
app.use(scopedApiMiddleware);                  // <slug>.localhost:8888/_os8/api/* → enforced API
app.use(ReverseProxyService.middleware());     // <slug>.localhost:8888/* (other) → proxied dev server
// then existing app.use('/:identifier', ...)  // native apps on bare localhost:8888
```

WebSocket upgrades wired separately at server startup:

```js
ReverseProxyService.attachUpgradeHandler(server);
```

Native apps on `localhost:8888/<appId>/` are untouched — neither middleware matches their host. The trust boundary is the browser origin, enforced for free by same-origin policy.

### 6.5 Install plan review UI

Renderer modal, surfaced when `os8://install` arrives or the user clicks Install in an in-OS8 catalog browser.

Required visible fields:

- App name, icon, publisher, channel badge.
- Source repo URL (clickable, opens external browser).
- License + commercial-use note.
- **Permissions requested** (with one-line explanation per item):
  - Network: outbound (always shown), inbound (rare, scary red badge).
  - Filesystem: scope.
  - OS8 capabilities — list each, with a "Why?" link to the relevant API doc.
- **Required secrets** (input fields inline, with `prompt` hint and `pattern` validation).
- **Resource expectations** (advisory).
- **Architecture compatibility** — host arch shown if mismatch.
- **Security review status** — Done (with risk badge) / In progress (spinner) / Failed.
  - Findings list (collapsible), with severity tags.
- **Install commands that will run** — collapsible, argv arrays rendered as code blocks.
- **Dependency summary** — count, license summary, audit summary.
- **Disk and time estimate** — rough estimate from prior installs of this manifest's framework.

Buttons: `Cancel` (always enabled), `Install`.

#### Gate model (advisory across all channels)

The install-plan gate is **advisory**. The security review surfaces risks; the user is the final authority over what installs on their machine. Findings are presented; nothing is silently blocked.

**Hard blocks** — the only conditions that prevent install regardless of user intent. These are structural impossibilities, not findings:

- **Architecture incompatibility.** The runtime adapter would refuse to launch.
- **Missing required secrets.** The install / start command can't execute without them.
- **Developer-Import provenance ack** — *"I understand this app has not been reviewed by OS8 curators."* This is a separate consent layer about *where the manifest came from*, not what the scan found. Required only for Developer Import.

**Override paths** — every other gate condition resolves to either `ok:true` (clean) or `ok:'override'` (findings present; one explicit confirm). The confirm dialog enumerates each flagged finding with category + description so the user reads exactly what they're overriding before clicking OK:

- Critical-severity findings → override with confirm.
- High `riskLevel` → override with confirm.
- Medium `riskLevel` → override with confirm (existing behavior).
- Low / clean review → no confirm needed; install runs immediately.

**MAL-* malware advisories** — when osv-scanner emits a critical finding whose advisory ID starts with `MAL-`, the confirm dialog gets a louder header (`⚠ KNOWN MALWARE WARNING`) listing the offending package + advisory ID. Still overridable in v1 (treats users as the trust authority over their own machine), but the dialog text is unmissable. Future versions may consider hard-blocking this category if telemetry shows users clicking through.

**Verified channel implication.** Verified apps still benefit from curator vetting at *submission time* — `os8ai/os8-catalog`'s CI gates manifest entry. The runtime override matters only when a previously-curated manifest gets re-flagged by a newer LLM/scanner version. The runtime is not the place to enforce trust posture; the catalog CI is.

**Why this model.** The first realistic Developer Import during Phase 3 Stage 6 (`koala73/worldmonitor`) was classified high-risk with five critical findings — all LLM judgment calls about manifest-vs-code drift, none of them malware. The original PR 1.17 hard-block left users no path forward. Treating the scan as advisory + a loud confirm-with-summary preserves the visibility of findings without making them load-bearing. Recorded as the "scan surfaces, user decides" principle in `MEMORY.md`.

After click: progress UI streams runtime adapter logs from `app_install_jobs.log_path`. On completion, app icon appears with a brief animation.

### 6.6 Run flow (BrowserView with hardened webPreferences)

External apps MUST load in a hardened BrowserView. The current `PreviewService` ([src/services/preview.js](file:///home/leo/Claude/os8/src/services/preview.js)) is extended to accept an `external` flag:

```js
// External app BrowserView config (DIFFERENT from native React app config).
const externalAppView = new BrowserView({
  webPreferences: {
    preload: path.join(__dirname, 'src', 'preload-external-app.js'),
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    enableBlinkFeatures: '',
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false
  }
});

// Restrict navigation to the app's own subdomain.
externalAppView.webContents.on('will-navigate', (e, url) => {
  const u = new URL(url);
  // Allow only same-origin navigation. The browser origin already enforces
  // most of this; the will-navigate gate covers the protocol-handler edge cases.
  const expectedHost = `${localSlug}.localhost`;
  const portOk = !u.port || u.port === String(OS8_PORT);
  if (u.hostname !== expectedHost || !portOk) {
    e.preventDefault();
    shell.openExternal(url);   // open external links in system browser
  }
});

// Mediate window.open / target=_blank.
externalAppView.webContents.setWindowOpenHandler(({ url }) => {
  shell.openExternal(url);
  return { action: 'deny' };
});

// Permission gating (camera, mic, geolocation, etc.) — deny by default for external apps.
externalAppView.webContents.session.setPermissionRequestHandler((wc, permission, cb) => {
  cb(false);
});
```

Run flow:

1. User double-clicks app icon → `src/renderer/apps.js` calls `createAppTab(app)`.
2. For `app.app_type === 'external'`: `POST /api/apps/:id/processes/start` → `AppProcessRegistry.start(db, appId)`.
3. Registry:
   - Allocates a port.
   - Calls `RuntimeAdapter.start(spec, appDir, sanitizedEnv, onLog)`.
   - Awaits `ready` promise.
   - Calls `ReverseProxyService.register(localSlug, appId, port)`.
4. Returns `{ url: 'http://<localSlug>.localhost:8888/' }` to renderer.
5. `PreviewService.setUrl(appId, url, { external: true })` loads URL in hardened BrowserView.
6. Window chrome shows `os8://apps/<localSlug>` as a label (cosmetic only).

**Pre-flight host resolution.** Before step 3, OS8 verifies that `<slug>.localhost` resolves to `127.0.0.1` on this host (a quick `dns.lookup`). If it doesn't, OS8 prompts: "Your system can't resolve `<slug>.localhost`. Add a hosts entry?" — on accept, write `/etc/hosts` (or Windows equivalent) via UAC/sudo. This is rare on macOS/Linux/Win11; common only on legacy Windows or AV-restricted setups.

### 6.7 Dev mode toggle

Per-app `apps.dev_mode`. Exposed in app menu.

**Off (default — Install Mode):**
- File watcher inactive.
- Source folder not surfaced in OS8 file tree.
- Logs panel hidden.

**On (Dev Mode):**
- File tree panel shows `~/os8/apps/<id>/`.
- Chokidar watches per `dev.watch` paths (or framework defaults).
- On change: framework HMR if `dev.hmr` is real; else `RuntimeAdapter.stop()` + `start()` + `BrowserView.reload()`.
- Logs panel surfaces dev server stdout/stderr.
- Restart and Stop buttons.
- First user/AI edit triggers fork-on-first-edit (§6.8).
- **Dirty-tree recovery on activation:** `git status --porcelain` + branch check; if dirty (including untracked or modified lockfiles), prompt:
  - "Continue on existing changes" → switch to / create `user/main` if not already there, leave files as-is.
  - "Reset to manifest version" → confirm twice; `git checkout <upstream_resolved_commit> -- .` and clean.
  - "Stash and switch" → `git stash`, then continue.

### 6.8 Fork-on-first-edit

On install (just before `apps_staging` → `~/os8/apps/<id>/`):

```bash
git -C <appDir> init                # if upstream isn't already a git repo
git -C <appDir> checkout -b user/main
```

If upstream IS a git repo (clone case):

```bash
# Already at the resolved commit. Create user branch and a tracking ref.
git -C <appDir> checkout -b user/main
git -C <appDir> branch upstream/manifest <upstream_resolved_commit>
```

Generate `.gitignore` (or append to existing). Default ignore set:

```
# OS8 auto-generated
node_modules/
.venv/
__pycache__/
dist/
build/
.next/
.cache/
.parcel-cache/
.svelte-kit/
.turbo/
*.log

# Local config — contains secrets
.env
.env.local
.env.*.local

# OS8 metadata (do not commit)
.os8/
```

Watcher logic in dev mode:

- Pause watcher during adapter operations (install, update).
- Other writes → ensure on `user/main`; debounce 5s; commit batched changes with message `[user] <ISO timestamp> <touched files>`.
- Set `apps.user_branch = 'user/main'` on first commit.
- Watcher MUST respect `.gitignore` (chokidar `ignored: gitignored paths`) so we never auto-commit `node_modules` or local secrets.

### 6.9 Update flow

When os8.ai publishes a new resolved commit:

1. Local `AppCatalogService.sync` (every 6h or manual) compares `app_catalog.upstream_resolved_commit` against installed `apps.upstream_resolved_commit`.
2. For mismatches: set `apps.update_available = 1, apps.update_to_commit = <newSha>`.
3. Renderer shows a dot on home-screen icon and a list in Settings → "Updates available".
4. User opens app or clicks update notification → in-app banner.
5. On click → `AppCatalogService.update(db, appId, targetCommit)`:
   - `git fetch` upstream.
   - If `apps.user_branch` is null (no user edits): fast-forward, run install via runtime adapter, restart.
   - If `user_branch` exists: three-way merge `user/main` onto `<targetCommit>`. Clean → prompt accept. Conflict → surface in app's source sidebar with `git status` summary; user resolves manually.
6. Verified-channel apps with `auto_update = 1` (default OFF): only auto-applies if `user_branch` is null. With user edits, never auto-updates.

**Phase 4 close-out (PR 4.2 = `os8ai/os8#48`).** The auto-update path
ships with two operational decisions:

- **Smart restart policy.** The auto-updater itself doesn't restart
  processes. After `AppCatalogService.update` bumps the apps row, the
  existing app-process supervisor detect-and-restarts on next launch
  *only when start-relevant files changed* (`package.json`, lockfile,
  the binary referenced by `start.argv`). Pure source edits flow
  through Vite HMR without a restart. Fallback if the heuristic
  misfires: "always restart with notification" — supervisor-layer
  change, not auto-updater.
- **User-facing toast.** On apply, OS8 shows a bottom-right toast
  ("`<slug>` updated · now on `<sha7>`") so the change isn't silent.
  Failures show a warning toast with the error message.
  `app_store.auto_update.notify_on_apply` setting (seeded by migration
  0.6.0) controls the toast; default ON.

**Web-side complement (PR 4.3 = `os8ai/os8dotai#16` + desktop
`os8ai/os8#51`).** Signed-in users browsing `/apps/<slug>` see an
"Update available" badge when their installed SHA lags the catalog SHA.
Driven by a daily desktop heartbeat to `POST /api/account/installed-apps`
that reports the user's installed external apps. Heartbeat is best-
effort; opt-out via the same path as telemetry. Schema:
`InstalledApp` model with `(user_id, app_slug)` unique; omit-implies-
uninstall semantics so a desktop uninstall reflects on the next
heartbeat.

### 6.10 Uninstall flow

Right-click on icon → "Uninstall…".

Confirm modal:
- "This will remove `<App Name>` from your home screen and delete its source code." (default action)
- Checkbox: "Also delete this app's data (databases, files, settings) — irreversible."

On confirm:
1. `AppProcessRegistry.stop(appId)`.
2. `ReverseProxyService.unregister(localSlug)`.
3. `rm -rf ~/os8/apps/<id>/`.
4. Set `apps.status = 'uninstalled'`.
5. If "Also delete data" checked: drop `~/os8/blob/<id>/`, `~/os8/config/app_db/<id>.db`, delete `app_env_variables` rows for this app.

Reinstall detects orphan data (rows with `status='uninstalled'` and matching `external_slug`) and prompts to restore.

### 6.11 Secrets management

Reuses the existing `app_env_variables` table ([schema.js:36-41](file:///home/leo/Claude/os8/src/db/schema.js#L36)). Install plan UI prompts for each `permissions.secrets[]`; on submit, written via an extended `EnvService` with optional `appId` parameter:

```js
EnvService.set(db, key, value, { appId, description });   // per-app when appId set
EnvService.getAllForApp(db, appId);                       // returns app-scoped vars
```

At process spawn, the runtime adapter receives only the per-app env (plus the whitelisted host vars and OS8-injected). Global `env_variables` is **not** propagated to external apps.

Per-app Settings → Secrets pane allows post-install editing. Defer keychain encryption — matches current `EnvService` plaintext model.

---

## 7. Resolved Design Decisions (Q1–Q12)

| # | Question | Decision |
|---|---|---|
| Q1 | Slug uniqueness | `external_slug` (immutable catalog identity) + `slug` (user-renameable local hostname component). Suffix on collision. **Proxy keys by local `slug`; each app served at `<slug>.localhost:8888`.** |
| Q2 | Port allocation | Random in `[40000, 49999]`, reroll on EADDRINUSE, OS-allocated as last resort. In-memory registry. |
| Q3 | App routing | **Subdomain mode (`<slug>.localhost:8888`) is the v1 default and only mode.** Each app gets its own browser origin → architectural trust isolation (cookies/localStorage/IndexedDB/service-workers/permissions all per-origin). Frameworks bind at `/`; no per-framework base-path tax. Path mode was rejected during execution planning (see §1 "Why subdomain mode"). Windows hosts entry prompt at install for the rare DNS-failure case. |
| Q4 | Version updates | Home-screen icon dot + Settings panel. Banner on app open. Auto-update opt-in for Verified channel only (default OFF). |
| Q5 | Secrets | Per-app `app_env_variables`. Inline prompts on install. **External apps do NOT inherit `process.env` or global `env_variables` — sanitized whitelist + per-app only.** |
| Q6 | Resource limits | Advisory in v1. Surfaced in install plan. Track RSS for future soft-kill. |
| Q7 | Catalog repo layout | Per-app folders. Schema validation + tag→SHA resolution + lockfile gate in CI. **Asset URLs pinned to catalog commit SHA.** |
| Q8 | Sync mechanics | Webhook primary + 30-min Vercel Cron safety net. Idempotent upserts. |
| Q9 | Uninstall | Tiered: default removes code, preserves data. Reinstall offers data restore. |
| Q10 | Account requirement | Anonymous deeplink install always works. Sign-in unlocks cross-device install. |
| Q11 | URL display | BrowserView shows real `<slug>.localhost:8888/`. Window chrome label `os8://apps/<slug>` cosmetically. |
| Q12 | Multi-arch | `runtime.arch` field; UI marks unsupported; install runner verifies. |

---

## 8. Phased Rollout

### Phase 0 — Catalog & browse (no install yet)

| PR | Work unit | Surface |
|---|---|---|
| 0.1 | Create `os8ai/os8-catalog` repo. README, CONTRIBUTING, schema/appspec-v1.json (with argv array enforcement, framework field, dependency_strategy, manifest version invariants), workflows skeleton. | Catalog |
| 0.2 | `validate.yml` CI: ajv schema, slug uniqueness, image checks, no `runtime.kind: docker`. | Catalog |
| 0.3 | `resolve-refs.yml` CI: tag → SHA resolution job; posts resolved SHA as PR comment. | Catalog |
| 0.4 | `lockfile-gate.yml` CI: Verified channel rejects manifests without recognized lockfile at upstream commit. | Catalog |
| 0.5 | Hand-author manifest for `worldmonitor`. CI green. | Catalog |
| 0.6 | Add 4–6 more seed manifests (Vite/Next examples) targeting Verified channel with `dependency_strategy: frozen`. | Catalog |
| 0.7 | os8.ai Prisma migration: `App` (with all four manifest version fields, `deletedAt`, `installCount`, `framework`), `PendingInstall`, `CatalogState`. | os8.ai |
| 0.8 | Sync endpoint with **tag-to-SHA resolution** + asset-URL pinning to catalog commit SHA. Vercel Cron + GitHub webhook config. | os8.ai |
| 0.9 | `/apps` browse page (server-rendered, filter by category/channel/framework, search). | os8.ai |
| 0.10 | `/apps/[slug]` detail page with screenshots, README rendering, framework badges, install count. | os8.ai |
| 0.11 | Install button emits `os8://install?slug=…&commit=<sha>&channel=…&source=os8.ai`. `PendingInstall` insertion for signed-in users. `track-install` endpoint stub. | os8.ai |

**Outcome:** browseable App Store on the public website. Manifest format proven against real apps; tag-to-SHA pipeline working.

### Phase 1 — Install + run for Node apps (the critical path, security-first)

| PR | Work unit | Surface |
|---|---|---|
| 1.1 | Migration `0.5.0-app-store.js`: extend `apps` (with all manifest version fields + `update_available`/`update_to_commit`), create `app_catalog` and `app_install_jobs`, FTS, indexes. | OS8 |
| 1.2 | `os8://` protocol registration + `requestSingleInstanceLock` **scoped by OS8_HOME** + `handleProtocolUrl` skeleton. | OS8 |
| 1.3 | `AppCatalogService.sync` + `search` + `get`. Pulls from os8.ai `/api/apps`. Stores `manifest_yaml` + `upstream_resolved_commit`. | OS8 |
| 1.4 | Manifest validation (mechanical, fast). Install-plan UI **rendered from manifest only — no clone yet.** | OS8 |
| 1.5 | **Static fetch** (`git clone --branch <commit> --depth 1` into `apps_staging/<jobId>/`). NO install commands. `app_install_jobs` state machine. | OS8 |
| 1.6 | `SecurityReviewService` (rename + extend): static checks (argv, curl-pipe, postinstall, lockfile, arch) + static analysis (`npm audit` parsing) + LLM review against manifest. | OS8 |
| 1.7 | **Server-side capability enforcement** middleware: `/<localSlug>/_os8/api/*` → resolve app, check `permissions.os8_capabilities`, inject `X-OS8-App-Id`, forward to internal `/api/*`. | OS8 |
| 1.8 | Add `requireAppContext` to APIs reachable by external apps; native shell remains permissive (trusted code). | OS8 |
| 1.9 | `window.os8` SDK + `preload-external-app.js`. Method exposure gated by manifest's declared capabilities. | OS8 |
| 1.10 | `EnvService` extension with optional `appId` param. **Sanitized env builder** (whitelist + per-app secrets + OS8-injected). | OS8 |
| 1.11 | Node runtime adapter: argv-array spawn (no shell), `package_manager` auto-detection, frozen install (`npm ci`/`pnpm install --frozen-lockfile`/`yarn install --frozen-lockfile`/`bun install --frozen-lockfile`), `.env` generation, `framework` defaults, cross-platform process tree-kill. | OS8 |
| 1.12 | `AppProcessRegistry` with multi-signal idle reaping (HTTP + stdout + child activity), per-app `keepRunning` override. | OS8 |
| 1.13 | `ReverseProxyService.middleware()` (HTTP, **keyed by local `slug`**) + `attachUpgradeHandler()` for WebSockets. | OS8 |
| 1.14 | **GATING SMOKE TEST: Vite HMR survives the proxy.** End-to-end Vite project with HMR proven through reverse proxy. Block subsequent PRs until passes. | OS8 |
| 1.15 | Mount `scopedApiMiddleware`, `ReverseProxyService.middleware()` in `src/server.js` ahead of catch-all. | OS8 |
| 1.16 | `AppCatalogService.install` — full review-before-install pipeline: clone → review → user approves → install (sandboxed env) → atomic move staging → apps. Hookup `app_install_jobs` state machine. | OS8 |
| 1.17 | Install plan review UI (renderer modal): permissions, secrets, review findings, install commands, disk/time estimates. Approval gate. | OS8 |
| 1.18 | Wire `os8://install` handler → install plan UI. Cross-check against local `app_catalog`; fetch from os8.ai if missing. | OS8 |
| 1.19 | App icon launch path: detect `app_type='external'` → start process → register proxy → load BrowserView with **hardened webPreferences** (sandbox, contextIsolation, navigation restriction, popup mediation, deny default permissions). | OS8 |
| 1.20 | Window-chrome `os8://apps/<localSlug>` label (cosmetic). | OS8 |
| 1.21 | Auto-generate minimal CLAUDE.md for external apps on install — points at manifest, declared capabilities, `window.os8` SDK, data dirs. | OS8 |
| 1.22 | Dev mode toggle UI + chokidar watcher (respects .gitignore) + log panel. | OS8 |
| 1.23 | Fork-on-first-edit: `user/main` branch, `.gitignore` generation, debounced auto-commit, **dirty-tree recovery on dev-mode activation**. | OS8 |
| 1.24 | Uninstall flow (tiered, data-preserve default). | OS8 |
| 1.25 | Update detection + manual update flow with three-way merge. | OS8 |
| 1.26 | Cross-device install: `pending_installs` polling for signed-in users. `track-install` POST after successful install. | OS8 |
| 1.27 | (Removed — subdomain is the v1 default in PR 1.13. The Windows hosts-entry prompt for legacy/AV-restricted setups lives inside PR 1.16's pre-flight DNS check.) | — |
| 1.28 | E2E: install `worldmonitor` from os8.ai click → review → approve → icon on home screen → open → edit `App.tsx` with Claude Code → live preview updates. | Both |
| 1.29 | Startup: `AppCatalogService.reapStaging` cleans up orphaned staging dirs from interrupted installs. | OS8 |

**Outcome:** worldmonitor and similar Vite/Next apps work end-to-end with a hardened trust boundary.

### Phase 2 — Python and Docker runtimes

| PR | Work unit | Surface |
|---|---|---|
| 2.1 | `python` runtime adapter (uv-based). Auto-installs uv if missing. `package_manager: uv | poetry | pip` detection. Frozen install for Verified. | OS8 |
| 2.2 | Streamlit/Gradio HMR strategies; framework defaults. | OS8 |
| 2.3 | `static` runtime adapter (Hugo/Jekyll/plain HTML — served via Express, no dev server). | OS8 |
| 2.4 | Add Streamlit/Gradio AppSpecs to catalog (ComfyUI, OpenWebUI). | Catalog |
| 2.5 | `docker` runtime adapter. Docker availability detection; surfaces install hint if missing. | OS8 |
| 2.6 | Docker fallback for apps needing system packages (CUDA, ffmpeg). | OS8 |

**Outcome:** Streamlit, Gradio, ComfyUI, OpenWebUI all work.

### Phase 3 — Open the floodgates

| PR | Work unit | Surface |
|---|---|---|
| 3.1 | Developer Import flow: paste GitHub URL → auto-generate draft AppSpec from `package.json` / `pyproject.toml` / `Dockerfile` heuristics + `framework` detection. | OS8 |
| 3.2 | Higher-friction install plan UI for Developer Import (extra warnings, all permissions opt-in). | OS8 |
| 3.3 | `os8ai/os8-catalog-community` repo. Lighter CI review. | Catalog (new) |
| 3.4 | Community channel on os8.ai (tab/filter on `/apps`). | os8.ai |
| 3.5 | OS8 settings: per-channel enable/disable. | OS8 |
| 3.6 | Supply-chain analyzer: count deps, flag known-malicious (osv-scanner, safety). | OS8 |

### Future (not v1)

- `surface: terminal` for TUIs.
- `surface: desktop-stream` for native GUIs via noVNC.
- Soft kill on resource limit excess.
- Sparse-checkout for large repos.
- ~~Telemetry on install success/fail.~~ **Done in Phase 4 PR 4.4 +
  4.5.** Opt-in (default OFF; first-install consent moment). Sends
  `kind / adapter / framework / channel / slug / commit /
  failurePhase / failureFingerprint / durationMs / os / arch /
  overrideReason`. Allowlist-sanitized (every other key dropped).
  Failure fingerprint = SHA-256 of stripped error line, never the raw
  line. Anonymous client ID is a random UUID; user can rotate via
  Settings. Server re-hashes with HMAC + secret salt before storage.
  Curator dashboard at `/internal/telemetry/install` (auth-gated to
  `OS8_CURATORS` allowlist).

---

## 9. Out of Scope (V1)

- **TUIs / CLI tools** — `surface: terminal` v2.
- **Native desktop GUIs** — `surface: desktop-stream` v2.
- **Games** — same as native GUIs.
- **Background services without UIs.**
- **Path mode (`localhost:8888/<slug>/`)** — rejected during execution planning; subdomain mode is the v1 default and only mode. See §1 "Why subdomain mode" and §7 Q3.
- **Resource enforcement** — advisory only.
- **Keychain-encrypted secrets** — matches current `EnvService` plaintext.
- **Non-pinned manifest refs** — every manifest pins a SHA via tag resolution.
- **Floating asset URLs** — pinned to catalog commit SHA.
- **Inheriting `process.env` or global env_variables to external apps** — explicitly rejected.

---

## 10. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Vite/framework HMR WebSocket fails through subdomain proxy | Low | Critical | PR 1.14 smoke test gates downstream work. Subdomain proxying is well-trodden in production tooling (StackBlitz, Coder, etc.) — risk significantly lower than the path-mode alternative would have been. |
| Two installed apps cross-contaminate via shared origin | (path mode) High | (path mode) Critical | **Eliminated by subdomain mode.** Each app is its own browser origin → SOP isolates cookies/localStorage/IndexedDB/service-workers/permissions architecturally. No runtime mitigation required. |
| Postinstall hook executes malicious code | High (without mitigation) | Critical | **Review-before-install pipeline (PRs 1.5–1.16): clone, no install commands, full review, user approval, then install. Argv arrays only.** |
| Same-origin app reaches `/api/*` directly | (path mode) High; (subdomain) Low | Critical | **Different origin under subdomain mode** → cross-origin requests to `localhost:8888/api/*` blocked by browser CORS without our permission. The scoped middleware (`<slug>.localhost:8888/_os8/api/*`) is the only path. (PR 1.7–1.8.) |
| External app reads OS8's env vars | High (without mitigation) | Critical | **Sanitized env (PR 1.10): whitelist host vars + per-app secrets; never inherit `process.env` wholesale.** |
| Tag mutation between catalog merge and desktop install | Medium | High (supply chain) | **Tag → SHA resolution at sync time; desktop installs the resolved SHA, not the tag (PR 0.8 + 1.16).** |
| Lockfile drift on `npm install` | Medium (Verified) | Medium | **Lockfile gate in CI (PR 0.4) + frozen install in adapter (PR 1.11).** |
| Catalog grows faster than curators can review | Low (early), High (later) | Medium | Community channel from Phase 3. CI does mechanical checks. |
| User uninstalls app, loses data they wanted | Medium | High | Tiered uninstall + reinstall data-restore prompt. |
| Malicious app slips through review | Low (Verified) | Critical | Multi-layer: catalog curator + static analysis + LLM review + capability enforcement + sanitized env + hardened BrowserView. |
| Idle reaper kills long-running AI jobs | Medium | Medium | Multi-signal idle detection (HTTP + stdout + child) + per-app `keepRunning` override. |
| User's host arch incompatible | Medium | Low | Declared `runtime.arch` filters in UI; install runner verifies. |
| `os8://` protocol not registered | Medium | Low | "OS8 not installed?" link on website. |
| Update merge conflict frustrates user | Medium | Medium | Standard `git status` surface + discard option (with warning). |
| Partial install leaves orphan staging dir | Medium | Low | `app_install_jobs` state machine + `reapStaging` on startup. |
| Single-instance lock blocks dev instances | Low | Medium (DX) | Lock key scoped by `OS8_HOME`. |
| Windows lacks `*.localhost` resolution | Low (Win11+); Medium (legacy Windows or AV-restricted setups) | Medium (per-app) | Pre-flight DNS lookup at install time; on failure, prompt for a hosts entry with UAC elevation. macOS / Linux / Win11 modern builds resolve natively per RFC 6761. |

---

## 11. Open Implementation Details (for execution planner)

Resolved-since-v1:
- ~~Migration version~~ — picked `0.5.0` placeholder; confirm against current at impl time.
- ~~`AppEnvService` vs extending `EnvService`~~ — **extend `EnvService`** with optional `appId`.
- ~~Single review service vs split~~ — **rename to `SecurityReviewService`** with `reviewSkill` + `reviewApp`.
- ~~Catalog-side download counts~~ — **`App.installCount` + `track-install` endpoint** anonymous, rate-limited.
- ~~CLAUDE.md generation for external apps~~ — **auto-generate minimal one** documenting manifest, capabilities, `window.os8`, data dirs.
- ~~Single-instance lock vs dev workflow~~ — **scope by `OS8_HOME`**.
- ~~Failure mode if runtime adapter crashes mid-install~~ — **`app_install_jobs` state machine + atomic staging→apps move + reapStaging**.
- ~~Idle reap heuristic~~ — **multi-signal (HTTP + stdout + child) + keepRunning override**.
- ~~Path mode vs subdomain mode~~ — **subdomain mode is the v1 default and only mode** (architectural trust isolation; no per-framework base-path tax). See §1 "Why subdomain mode."
- ~~Subdomain mode on Windows~~ — **install-time DNS lookup; on failure, hosts-entry-with-UAC prompt.** Modern Win11 resolves `*.localhost` natively. Legacy/AV-restricted Windows is a recoverable install-time error, not a permanent block.

Genuinely open:

1. ~~**Native-app/`requireAppContext` rollout cadence.**~~ **Done in
   Phase 4 PR 4.6 (`os8ai/os8#53`).** Strict origin allowlist + in-process
   token escape hatch + permissive rollback env. v1 trust-by-default
   gap closed.
2. **`/apps` page caching.** Spec says ISR (60s); confirm on first deploy that this matches sync cadence acceptably.
3. **Idle timeout default value.** 30 min suggested; surface as Settings slider (5 min – 4h, plus "never").
4. ~~**Capability granularity for `mcp.*`.**~~ **Done in Phase 4 PR 4.7
   (`os8ai/os8#46`).** `mcp.<server>.*` accepted; `mcp.*.*` / `mcp.*` /
   nested wildcards rejected at JSON schema. Wildcard semantics:
   "all current AND future tools registered by the server".
5. **Lockfile recognition for `bun.lockb`.** Bun's binary lockfile needs a different verification path from text lockfiles. Confirm CI behavior in PR 0.4.
6. ~~**`window.os8` SDK in TypeScript.**~~ **Done in Phase 4 PR 4.9
   (`os8ai/os8#50`).** Both surfaces ship: in-folder `os8-sdk.d.ts`
   per PR 1.21 + `@os8/sdk-types` npm package at `os8ai/os8-sdk-types`.
   Drift-check CI guards alignment between preload + .d.ts.
7. **Asset CDN migration.** Catalog assets via raw GitHub URLs may bump rate limits; if so, migrate to Vercel Blob in v2.
8. **`requireAppContext` on which APIs exactly.** Inventory all `/api/*` routes and decide which require app context for external-app callers. Some are obvious (`/api/connections/*` for OAuth tokens); others (`/api/system/*`) need a call.
9. **`runtime.package_manager: auto` resolution conflicts.** Multiple lockfiles in the same repo (rare but real). Define precedence: `pnpm-lock.yaml > yarn.lock > bun.lockb > package-lock.json`.
10. **Auto-update merge UX for non-trivial conflicts.** Spec says surface in app sidebar; spec out the actual UI in PR 1.25.
11. ~~**Cross-platform smoke matrix.**~~ **Done in Phase 4 PR 4.8
    (`os8ai/os8#52` + catalog repos).** `windows-2022` promoted to gating
    across all four repos (os8 desktop + 2× catalog + os8dotai). Manual
    Windows install smoke (G4) pending Leo's pass.
12. ~~**(Combined with #11)**~~ Cross-platform: closed in PR 4.8.

**Phase 4 added open items (Phase 5 candidates):**

- **os8.ai session token for desktop heartbeat.** PR 4.3 ships the
  installed-apps heartbeat method (`AppCatalogService.reportInstalledApps`)
  and the os8.ai endpoint (`POST /api/account/installed-apps`), but the
  middle is gated on `getSessionCookie()` returning a real cookie.
  AccountService caches profile data only — no token storage. A future
  PR plumbs the session cookie from sign-in into AccountService so the
  heartbeat goes live. Until then: badges only show for users who
  manually self-report (no path).
- **Telemetry hash salt rotation cadence.** Annual default per
  `os8dotai/SECURITY.md` (added in PR 4.5). Revisit if signal of
  compromise.

---

## 12. Reference — Codebase Pointers

OS8 desktop (`/home/leo/Claude/os8/`):

- Architecture overview: `CLAUDE.md`
- App service: `src/services/app.js`
- Catalog patterns to mirror: `src/services/skill-catalog.js`, `src/services/mcp-catalog.js`
- Security review pattern (to extend/rename): `src/services/skill-review.js`
- Catch-all route to extend: `src/server.js:682-740`
- BrowserView control (to extend with hardened config): `src/services/preview.js:144-150`
- Home screen rendering: `src/renderer/apps.js:20-46`
- Click-to-launch flow: `src/renderer/tabs.js:327-360`
- Account/PKCE auth: `src/services/account.js`
- Process lifecycle pattern: `src/services/pty.js`
- DB schema: `src/db/schema.js` (apps at line 10, app_env_variables at line 36)
- Migration runner: `src/services/migrator.js`, migrations in `src/migrations/`
- App routes: `src/routes/apps.js`
- Skills routes (review/approve/reject pattern): `src/routes/skills.js`
- EnvService (to extend with appId): `src/services/env.js`
- main.js (where protocol handler lives): `main.js`

os8.ai website (`/home/leo/Claude/os8dotai/`):

- Auth flow (desktop side): `src/app/api/auth/desktop/exchange/route.ts`, `finalize/route.ts`, `cookie/route.ts`
- Prisma client: `src/db/index.ts`
- Schema: `prisma/schema.prisma`
- Listing pattern reference: `src/app/elon-graph/entities/page.tsx`
- Nav component: `src/components/Nav.tsx`
- Theme: `src/app/globals.css`

Example seed apps:

- https://github.com/koala73/worldmonitor — Vite/TS, ideal Phase 1 candidate
