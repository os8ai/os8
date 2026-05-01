# OS8 App Store — V1 Execution Plan

**Companion to:** [`app-store-spec.md`](./app-store-spec.md) (Draft v2)
**Audience:** Engineers implementing the spec.
**This document:** PR-by-PR execution plan, grounded in the actual codebases at `/home/leo/Claude/os8/` and `/home/leo/Claude/os8dotai/`.

---

## 1. Spec confirmation

I read [`docs/app-store-spec.md`](./app-store-spec.md) end to end (1322 lines, §1–§12). The architecture is internally consistent: clone-into-`~/os8/apps/<id>` + run upstream's own dev server + reverse-proxy from `localhost:8888/<slug>/` is a clean fall-out of the user's three asks (window-in-OS8, unified URL, live edit), and the trust model (sanitized env + scoped capability surface + review-before-install + hardened BrowserView) is genuinely load-bearing rather than ceremonial. Two things surprised me, both noted as deviations later: (a) the spec writes `requestSingleInstanceLock({ key })`, but Electron 40's API does not take a `key` — scoping per `OS8_HOME` requires `app.setPath('userData', …)` before the lock call (PR 1.2). (b) The spec's "rename `SkillReviewService` → `SecurityReviewService`" is more churn than necessary given how skill-specific the existing prompt is — I propose a shared helper + a separate `AppReviewService` instead (PR 1.6). Both are flagged in the relevant PRs with reasoning.

---

## 2. Codebase audit (≤500 words)

Grounded against the actual files cited in §6 and §12 of the spec.

| Spec assumption | Code reality | Resolution |
|---|---|---|
| `apps.app_type` extends to `'external'`; `apps.status` extends to `'uninstalled'` | [`src/db/schema.js:10-23`](../src/db/schema.js#L10) — `app_type TEXT DEFAULT 'regular'`, `status TEXT DEFAULT 'active'`. **No CHECK constraints.** Existing values seen in code: `'regular'`, `'system'` (apps); `'active'`, `'archived'`, `'deleted'` (status). | Pure additive — `ALTER TABLE` + new column adds suffice. No constraint relaxation needed. |
| `app_env_variables` is the per-app secrets surface | [`schema.js:36-42`](../src/db/schema.js#L36) — `(app_id, key)` UNIQUE; plaintext value. | Reuse as-is. Spec's "defer keychain" matches current model. |
| Catch-all at `src/server.js:682` is the splice point | [`src/server.js:682-740`](../src/server.js#L682) — `app.use('/:identifier', …)` matches `appId` first then falls back to slug, returns `next()` if neither hits (line 694). Mount order: route modules (357–555) → `/avatars` static (627) → Vite middleware (669) → catch-all (682) → home (743) → 404 (748). | Insert `scopedApiMiddleware` and `ReverseProxyService.middleware()` between line 679 (Vite mount) and line 680 (catch-all). The catch-all's `return next()` already flows to the 404, so a non-matching external slug falls through cleanly. |
| Reverse proxy with WebSocket upgrade pass-through | **No proxy library installed.** [`package.json:62-79`](../package.json) lists `express`, `ws`, `chokidar`, `multer` — no `http-proxy` or `http-proxy-middleware`. WebSocket hookup pattern exists at [`server.js:776-798`](../src/server.js#L776) (`setupVoiceStream(server)` etc.) — that's the exact site for `ReverseProxyService.attachUpgradeHandler(server)`. | PR 1.13 adds `http-proxy@1.18` (low-level, supports `ws: true`). |
| `PreviewService` extended with `external` flag | [`src/services/preview.js:52-115`](../src/services/preview.js#L52) — current `BrowserView` has only `nodeIntegration: false, contextIsolation: true, backgroundThrottling: false`. No sandbox, no preload, no nav restriction, no popup mediation, no permission handler. | PR 1.19 adds `create(appId, { external = false } = {})` overload that returns hardened webPreferences when `external: true`. `will-navigate` check uses `pathname.startsWith('/<localSlug>/')` (same-host check is meaningless because native and external apps share `localhost:8888`). |
| `EnvService` gains optional `appId` parameter | [`src/services/env.js`](../src/services/env.js) — 66 lines, all global (`env_variables` table). No per-app methods. | PR 1.10 extends with `set(db, key, value, { appId, description })` and adds `getAllForApp(db, appId)`. |
| `SkillReviewService` is renamed to `SecurityReviewService` | [`src/services/skill-review.js`](../src/services/skill-review.js) — 521 lines, hardcoded skill-specific system prompt (lines 34-79), called from [`routes/skills.js:3,146`](../src/routes/skills.js#L146). | **Deviation:** add new `src/services/app-review.js` (or `security-review.js`) with shared LLM-call helper + app-specific prompt. Leave `skill-review.js` alone. Less churn, separate prompts. PR 1.6 ships the shared helper. |
| `SkillCatalogService` shape to mirror | [`src/services/skill-catalog.js:88-204`](../src/services/skill-catalog.js#L88) — `seedFromSnapshot` + `sync` + `search` + `install` static methods, db first param, paginated fetch, FTS5 rebuild after upsert. | Direct template for `AppCatalogService` (PR 1.3 + 1.16). |
| Routes `apps.js` and `skills.js` shape | [`routes/apps.js`](../src/routes/apps.js) — 387 lines, propose/approve pattern (lines 109-185); [`routes/skills.js:195-262`](../src/routes/skills.js#L195) — `:id/review`, `:id/approve`, `:id/reject`, `:id/deps-status`, `:id/install-deps` — clean template for app-install routes. | PR 1.5 + 1.16 add catalog/install routes following this exact shape. |
| `main.js` has single-instance lock + protocol handler hooks | [`main.js:205-393`](../main.js#L205) — `app.whenReady()` does dock icon, `initDatabase`, `migrator`, TTS, mic perms, server, scheduler, callbacks, window. **No `requestSingleInstanceLock`, no `setAsDefaultProtocolClient`, no `open-url`/`second-instance` handlers.** | PR 1.2 is purely additive at the top of `whenReady` (before `initDatabase`). |
| os8.ai has `App` / `PendingInstall` / `CatalogState` Prisma models | [`prisma/schema.prisma`](../../os8dotai/prisma/schema.prisma) — only `User`, `DesktopAuthCode`. No catalog models, no webhook routes (`grep -rn "webhook\|Cron" src` returns nothing relevant), no `/api/internal/*` namespace. | PR 0.7 adds the three models, PR 0.8 adds the sync endpoint + Vercel Cron. `minisearch` is already in `dependencies` — useful for `/apps` page (PR 0.9). `next-auth` v5 PKCE pattern is already proven on the desktop side. |
| Migration version `0.5.0-app-store.js` | Current at [`package.json`](../package.json) is `0.4.15`. Migrations live at [`src/migrations/`](../src/migrations/) using `version` + `description` + `up({db, logger})` ([0.2.10 reference](../src/migrations/0.2.10-template-resync.js)). | `0.5.0-app-store.js` works. Use `IF NOT EXISTS` and column-existence guards for idempotency. |

**Net assessment:** the spec is faithful to the code's grain. Most PRs are pure addition. The biggest non-trivial integrations are (1) reverse proxy + WS upgrade (no existing primitive), (2) the BrowserView hardening overload (current `PreviewService` has zero security posture), and (3) the install state machine (no analogue exists; the closest is `AppBuilderService` but that orchestrates different work).

---

## 3. Phase 0 plan — Catalog repo + os8.ai (compact, complete)

Phase 0 ships browse-only on the website. No desktop work yet.

### 0.1 — Bootstrap `os8ai/os8-catalog` repo
- **Goal:** New GitHub repo with skeleton.
- **Files:** `README.md`, `CONTRIBUTING.md`, `schema/appspec-v1.json` (full JSON Schema for §3 spec, including argv-array enforcement, `runtime.kind != docker`, `surface.kind == web`, `permissions.filesystem == app-private`, slug regex, ref regex), `apps/.gitkeep`, `.github/CODEOWNERS`.
- **Acceptance:** Repo exists at `os8ai/os8-catalog`, README shows the schema, CODEOWNERS routes per-app PRs to designated curators.
- **Tests:** None (skeleton only).
- **LOC:** ~200 (mostly the JSON Schema).
- **Independent merge?** Yes.

### 0.2 — `validate.yml` CI
- **Goal:** ajv schema validation, slug uniqueness across `apps/`, image dimensions (icon 256×256 ≤100KB; screenshots ≤500KB, max 5), reject `runtime.kind: docker`, reject non-argv command fields.
- **Files:** `.github/workflows/validate.yml`, `.github/scripts/validate-manifests.js`.
- **Acceptance:** PR adding a manifest with `runtime.kind: docker` fails CI; PR with schema-valid manifest passes.
- **LOC:** ~250.

### 0.3 — `resolve-refs.yml` CI
- **Goal:** For each `upstream.ref` in changed manifests, if it's a tag, call `GET /repos/{owner}/{repo}/git/refs/tags/{tag}` and post the resolved 40-char SHA as a PR comment for curator review. Required so the catalog merge is reviewed against an immutable target.
- **Files:** `.github/workflows/resolve-refs.yml`, `.github/scripts/resolve-refs.js`.
- **Acceptance:** PR with `ref: v1.4.2` gets a comment "→ resolved to `abc123…`"; PR with a branch name in `ref` fails the regex check (already enforced by 0.2's schema).
- **LOC:** ~150.

### 0.4 — `lockfile-gate.yml` CI
- **Goal:** For `review.channel: verified`, check out the upstream repo at the resolved SHA and assert at least one recognized lockfile exists (`package-lock.json | pnpm-lock.yaml | yarn.lock | bun.lockb | uv.lock | poetry.lock | requirements.txt`).
- **Files:** `.github/workflows/lockfile-gate.yml`, `.github/scripts/check-lockfile.js`.
- **Acceptance:** Verified-channel PR with no lockfile in upstream fails CI; one with `package-lock.json` passes.
- **LOC:** ~100.
- **Open detail:** `bun.lockb` is binary — verification is presence-only, not content-validation. Acceptable for v1 (closes spec §11.6 to "presence check only").

### 0.5 — Hand-author `worldmonitor` manifest
- **Goal:** First real manifest, demonstrates the schema works end-to-end.
- **Files:** `apps/worldmonitor/manifest.yaml`, `apps/worldmonitor/icon.png`, `apps/worldmonitor/screenshots/01-dashboard.png`, `apps/worldmonitor/README.md`.
- **Acceptance:** PR is green on all four CI workflows.
- **LOC:** ~80 YAML + assets.

### 0.6 — 4–6 more seed manifests
- **Goal:** Coverage of Vite, Next, Astro, SvelteKit. All Verified channel, all `dependency_strategy: frozen`.
- **Acceptance:** All green; catalog has ≥5 apps.
- **LOC:** ~400 YAML across all manifests.

### 0.7 — os8.ai Prisma migration
- **Goal:** Add `App`, `PendingInstall`, `CatalogState` per spec §5.1 (with the four manifest-version fields, `deletedAt`, `installCount`, `framework` array).
- **Files:** `prisma/schema.prisma` (extend), `prisma/migrations/<ts>_app_store/migration.sql` (Prisma generates).
- **Acceptance:** `npx prisma migrate deploy` succeeds against Neon; `prisma studio` shows the three new tables.
- **LOC:** ~80 schema diff.

### 0.8 — Sync endpoint + tag-to-SHA + asset URL pinning
- **Goal:** `POST /api/internal/catalog/sync` (HMAC-verified webhook, also Vercel Cron daily 30-min). For each changed manifest in `os8ai/os8-catalog`: fetch tree, parse YAML, validate against ajv, resolve tags via GitHub API, rewrite asset URLs to `https://raw.githubusercontent.com/os8ai/os8-catalog/<catalogCommitSha>/apps/<slug>/...`, upsert `App` row by slug. Soft-delete removed manifests.
- **Files:** `src/app/api/internal/catalog/sync/route.ts`, `src/lib/catalog-sync.ts`, `vercel.json` (cron config), `.env.local.example` (add `CATALOG_WEBHOOK_SECRET`, `GITHUB_TOKEN`).
- **DB writes:** `App.upsert` (keyed by slug), `App.update({deletedAt})`, `CatalogState.upsert` per channel.
- **API contract:**
  ```
  POST /api/internal/catalog/sync
  Headers: X-Hub-Signature-256: sha256=<hmac>
  Body: GitHub push payload OR { channel: 'verified' } from cron (with internal token)
  Response: { synced: N, added: M, updated: K, removed: R }
  ```
- **Acceptance:** Manual webhook fire updates rows; cron run triggers idempotent sync (manifest-sha unchanged → no write).
- **LOC:** ~350. Flag if larger; consider splitting webhook receiver from sync core.

### 0.9 — `/apps` browse page
- **Goal:** Server-rendered Next.js page with category/channel/framework filter and minisearch-powered text search.
- **Files:** `src/app/apps/page.tsx`, `src/app/apps/AppGrid.tsx`, `src/app/apps/SearchFilter.tsx`, `src/lib/apps-query.ts`.
- **Acceptance:** ISR with 60s revalidation; cards click into detail page.
- **LOC:** ~400. May exceed; consider splitting filter UI from grid.

### 0.10 — `/apps/[slug]` detail page
- **Goal:** Screenshots carousel, README rendering (markdown), license, manifest commit SHA, source repo link, install count, install button.
- **Files:** `src/app/apps/[slug]/page.tsx`, `src/app/apps/[slug]/InstallButton.tsx`, `src/app/apps/[slug]/Screenshots.tsx`.
- **Acceptance:** Page renders worldmonitor with screenshots.
- **LOC:** ~350.

### 0.11 — Install button wiring + protocol fallback
- **Goal:** Always emit `os8://install?slug=…&commit=…&channel=…&source=os8.ai`. For signed-in users, also `POST /api/apps/[slug]/install` to create `PendingInstall` row. `POST /api/apps/[slug]/track-install` increments anonymous install count (rate-limited per IP/day via simple in-memory or Vercel KV map).
- **Protocol-not-registered fallback:** below the Install button, render a secondary "OS8 not opening?" disclosure. Expanded content shows the upstream commit SHA with a copy-to-clipboard button and instructions: *"Open OS8, go to App Store, paste this commit, click Install."* No JS detection of registration success/failure (unreliable cross-browser); the disclosure is always present, low-visibility unless the user clicks it. This makes the install path resilient to AppImage installs without registration (see PR 1.2 Linux notes).
- **Files:** `src/app/api/apps/[slug]/install/route.ts`, `src/app/api/apps/[slug]/track-install/route.ts`, `src/app/api/account/pending-installs/route.ts`, `src/app/api/account/pending-installs/[id]/consume/route.ts`. Add fallback widget to `src/app/apps/[slug]/InstallButton.tsx` (PR 0.10).
- **Acceptance:** Anonymous click triggers `os8://` deeplink (no DB write); signed-in click also creates `PendingInstall` row; "OS8 not opening?" toggle reveals copyable commit + install instructions.
- **LOC:** ~280.

**Phase 0 outcome:** Browseable App Store on os8.ai. Manifest format proven against real apps. Tag-to-SHA pipeline working. No desktop work merged yet.

---

## 4. Phase 1 plan — install + run for Node apps (PR by PR)

Execution order roughly top-to-bottom but several can parallelize. See §8 dependency graph.

---

### 1.13 — `ReverseProxyService` primitive (HTTP + WebSocket upgrade)
**Pulled to the front because PR 1.14 depends on it and PR 1.14 gates everything downstream.**

- **Goal:** Stand up the primitive needed for the gating smoke test. Actual mount-into-server.js is PR 1.15.
- **Files:** create `src/services/reverse-proxy.js`. Add `http-proxy@1.18` to `package.json` dependencies.
- **API:**
  ```js
  ReverseProxyService.register(localSlug, appId, port, { mode = 'path' })
  ReverseProxyService.unregister(localSlug)
  ReverseProxyService.getPort(localSlug)
  ReverseProxyService.middleware()              // Express middleware factory
  ReverseProxyService.attachUpgradeHandler(server)  // wires server.on('upgrade', …)
  ```
- **Renderer vs main:** server-only (main process Express).
- **Dependencies:** none (foundation PR).
- **Acceptance:** unit-test only — proxy `register/getPort/unregister` round-trips; middleware factory returns a function. End-to-end is PR 1.14.
- **Tests:** `tests/reverse-proxy.test.js` — register/getPort/unregister, Host-header matching for `<slug>.localhost`.
- **Estimated LOC:** ~220.
- **Independent merge?** Yes (no consumer until 1.14).
- **Deviations from spec:** none.

### 1.14 — **GATING** Vite HMR smoke test through reverse proxy
- **Goal:** End-to-end E2E: spin up a real Vite project on a random port, mount `ReverseProxyService` on a test Express, navigate a headless browser to `localhost:<test_port>/<slug>/`, edit a `.tsx` file, assert HMR updates the page without reload. **Block PRs 1.15, 1.16, 1.19 from merge until this passes.**
- **Files:** `tests/e2e/vite-hmr-smoke.test.js`, `tests/fixtures/vite-app/` (5-line Vite + React project).
- **Acceptance:** `npm test -- vite-hmr-smoke` passes locally on macOS + Linux. CI runs the test.
- **Why gating:** if Vite + `http-proxy.ws()` can't carry HMR through the `<slug>.localhost:8888` proxy, the entire architecture is wrong and needs rethinking before 1.15/1.16/1.19 lock in. Subdomain proxying is well-trodden in production tools (StackBlitz, Coder, GitPod) so the risk is low, but the test still gates downstream work.
- **Estimated LOC:** ~300 (test infra + fixture).
- **Independent merge?** Yes — but blocks downstream.
- **Deviations from spec:** none.

### 1.1 — Migration `0.5.0-app-store.js`
- **Goal:** Apply schema changes from spec §6.1 in one migration.
- **Files:** create `src/migrations/0.5.0-app-store.js`. Update `package.json` version to `0.5.0`.
- **Migration shape:** mirror [`0.2.10-template-resync.js`](../src/migrations/0.2.10-template-resync.js):
  ```js
  module.exports = {
    version: '0.5.0',
    description: 'App Store schema: extend apps; add app_catalog + app_install_jobs',
    async up({ db, logger }) {
      // Idempotent ALTER TABLE for apps (each column-add wrapped in try/catch on "duplicate column")
      // CREATE TABLE IF NOT EXISTS app_catalog
      // CREATE TABLE IF NOT EXISTS app_install_jobs
      // CREATE INDEX IF NOT EXISTS …
      // CREATE VIRTUAL TABLE IF NOT EXISTS app_catalog_fts USING fts5(...)
      // INSERT triggers to keep FTS in sync (mirror skill_catalog FTS pattern)
    }
  };
  ```
- **DB columns (apps):** `external_slug TEXT`, `channel TEXT`, `framework TEXT`, `manifest_yaml TEXT`, `manifest_sha TEXT`, `catalog_commit_sha TEXT`, `upstream_declared_ref TEXT`, `upstream_resolved_commit TEXT`, `user_branch TEXT`, `dev_mode INTEGER DEFAULT 0`, `auto_update INTEGER DEFAULT 0`, `update_available INTEGER DEFAULT 0`, `update_to_commit TEXT`.
- **DB columns (`app_install_jobs`):** `id`, `app_id`, `external_slug`, `upstream_resolved_commit`, `channel`, `status`, `staging_dir`, `review_report TEXT` (inline JSON, deviates from spec's `review_id` FK), `error_message`, `log_path`, `created_at`, `updated_at`.
- **DB indexes:** `idx_apps_external_slug`, `idx_apps_app_type`, `idx_app_catalog_channel`, `idx_app_catalog_category`, `idx_app_catalog_deleted`, `idx_install_jobs_status`, `idx_install_jobs_slug`.
- **Idempotency pattern (per-column):**
  ```js
  try { db.exec('ALTER TABLE apps ADD COLUMN external_slug TEXT'); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  ```
- **Acceptance:** `npm start` against an existing user DB upgrades cleanly; re-run is a no-op (logged "already at 0.5.0"); `apps_staging/` directory created under `OS8_HOME` if absent.
- **Tests:** `tests/migrations/0.5.0.test.js` — run on a freshly-seeded 0.4.x DB; assert columns, tables, indexes exist; re-run is idempotent.
- **Estimated LOC:** ~250.
- **Independent merge?** Yes.
- **Deviations from spec:** none.

### 1.2 — `os8://` protocol handler + per-OS8_HOME single-instance lock
- **Goal:** Register `os8://` protocol; route `os8://install?…` to a stub handler. Single-instance lock scoped per `OS8_HOME` so dev instances coexist.
- **Files:** modify `main.js` (new section near top of `app.whenReady()` and lifecycle hooks). Create `src/services/protocol-handler.js`.
- **Single-instance approach (DEVIATION from spec pseudocode):** Electron 40's `app.requestSingleInstanceLock()` does not accept a `key` argument — the spec's `requestSingleInstanceLock({ key })` doesn't exist in the API. Instead:
  ```js
  // main.js, BEFORE app.whenReady()
  const userDataDir = path.join(process.env.OS8_HOME || os.homedir(), '.os8-electron-userdata');
  app.setPath('userData', userDataDir);     // scopes the lock per OS8_HOME implicitly
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  ```
  Two parallel OS8 dev instances with different `OS8_HOME` get different `userData` dirs and therefore independent locks.
- **Cross-platform handlers:**
  - macOS: `app.on('open-url', (e, url) => …)`
  - Windows/Linux: `app.on('second-instance', (e, argv) => find first arg starting with 'os8://')`
- **Stub:** `handleProtocolUrl(url)` parses `os8://install?slug=…&commit=…&channel=…&source=…`, validates slug regex + 40-char SHA + channel allowlist, then logs and TODOs. Real install dispatch arrives in PR 1.18.
- **Acceptance:** From terminal: `open 'os8://install?slug=worldmonitor&commit=abc...&channel=verified'` (macOS) routes to the running instance and logs the parsed payload; second OS8 launch with same `OS8_HOME` quits cleanly; with a different `OS8_HOME`, both run.
- **Tests:** unit test for the URL parser; manual cross-platform smoke.
- **Cross-platform integration:**
  - **macOS:** `app.setAsDefaultProtocolClient('os8')` + `app.on('open-url', …)`. No installer hook needed.
  - **Windows:** `app.setAsDefaultProtocolClient('os8')` + extend `package.json` `build` config with `protocols: [{ name: 'OS8', schemes: ['os8'] }]` so `electron-builder` writes registry entries during NSIS install. `second-instance` handler reads `argv` for the `os8://` URL.
  - **Linux:** dual-track — `.deb` and AppImage have different lifecycle.
    - **`.deb`:** add `postinst` script (via `electron-builder`'s `deb.afterInstall`) that copies `build/linux/os8.desktop` to `/usr/share/applications/` and runs `update-desktop-database`. Desktop file declares `MimeType=x-scheme-handler/os8;`.
    - **AppImage:** no system integration on extract. Add a first-run dialog "Register OS8 to handle os8:// links?" → on accept, write `~/.local/share/applications/os8.desktop` + run `xdg-mime default os8.desktop x-scheme-handler/os8`. On decline, remember the choice in settings; user can re-trigger from Settings → Integrations later.
  - **Fallback for unregistered installs:** os8.ai's install button (PR 0.11) shows secondary text — *"OS8 not opening? Copy commit hash and install via OS8's catalog browser instead."* — with a copy-to-clipboard widget. This means `os8://` failure isn't fatal; the install path stays usable.
- **Estimated LOC:** ~250 (incl. desktop file + builder config + AppImage first-run dialog).
- **Independent merge?** Yes.
- **Deviations from spec:** (1) the `requestSingleInstanceLock({ key })` pseudocode replaced with `setPath('userData', …)` + the no-arg lock call (Electron's API doesn't take a key). (2) Linux integration explicitly tiered between .deb (automatic) and AppImage (first-run prompt) rather than a single mechanism — required because the formats have different install lifecycles.

### 1.3 — `AppCatalogService.sync` + `search` + `get`
- **Goal:** Mirror `SkillCatalogService` shape; pull from `https://os8.ai/api/apps?channel=...` into local `app_catalog` table; serve search via FTS5 + LIKE fallback.
- **Files:** create `src/services/app-catalog.js`. Wire scheduled sync at server.js (mirror the `scheduleCatalogSync` pattern at [`server.js:197-232`](../src/server.js#L197) — daily 4am, parallel to skill catalog sync).
- **Service shape:**
  ```js
  AppCatalogService.sync(db, { channel = 'verified', force = false } = {}) → { synced, added, updated, removed }
  AppCatalogService.search(db, query, { channel?, category?, framework?, limit }) → AppCatalogEntry[]
  AppCatalogService.get(db, slug) → AppCatalogEntry  // with manifestYaml parsed
  AppCatalogService.fetchManifest(slug, channel)     // re-fetches from os8.ai if local mirror stale
  ```
- **Acceptance:** Sync against a stub os8.ai response writes rows; FTS rebuild runs; second sync is idempotent (manifest-sha unchanged → no row write).
- **Tests:** `tests/app-catalog.test.js` — fetch, upsert, FTS search, parsed manifest.
- **Renderer vs main:** server-only.
- **Dependencies:** PR 1.1 (schema), os8.ai PR 0.8 (sync endpoint).
- **Estimated LOC:** ~350.
- **Independent merge?** Yes (no consumer until 1.4).

### 1.4 — Manifest validation + install-plan UI shell (no clone yet)
- **Goal:** Validate manifest against schema mechanically; render the install plan modal from manifest fields only. **No clone, no install commands.**
- **Files:** create `src/services/manifest-validator.js`, `src/templates/install-plan-modal.html` (or component if React-based; renderer-only). Wire IPC `app-store:render-plan` channel in `src/ipc/`.
- **Validation rules** (mirror catalog CI from §3.5):
  - argv arrays only (no shell strings)
  - `runtime.kind` not `docker` (v1)
  - `surface.kind === 'web'` (v1)
  - `permissions.filesystem === 'app-private'` (v1)
  - `slug` regex: `^[a-z][a-z0-9-]{1,39}$`
  - `upstream_resolved_commit` is 40-char hex
- **UI fields:** name, icon, publisher, channel badge, source repo URL, license, commercial-use note, permissions list, required secrets (input fields with `pattern` validation), resource expectations, architecture compatibility (vs `process.arch`), install commands (collapsible, code blocks). Findings list + Install button **disabled** at this stage; review pipeline arrives in 1.6.
- **YAML parser:** `js-yaml` (~50KB, 50M weekly downloads). Use `yaml.load()` (safe variant); never `loadAll`. Add to `package.json` dependencies.
- **Acceptance:** Modal renders for a valid manifest with all fields visible; rejected manifest shows error.
- **Tests:** unit on validator; visual smoke for modal.
- **Renderer vs main:** mostly renderer; validator runs in main.
- **Dependencies:** PR 1.1.
- **Estimated LOC:** ~400 (validator + modal). **Flag:** likely splits into `manifest-validator.js` (~150) + UI (~250) if needed.
- **Independent merge?** Yes.

### 1.5 — Static fetch + `app_install_jobs` state machine
- **Goal:** Implement `git clone --branch <commit> --depth 1` into `~/os8/apps_staging/<jobId>/`. Track the install job state machine in `app_install_jobs`. **No install commands run yet.**
- **Files:** create `src/services/app-install-jobs.js` (CRUD wrapping the table), extend `src/services/app-catalog.js` with `install()` method that creates the job and clones. Add `~/os8/apps_staging/` to `src/config.js`. Create `src/routes/app-store.js` for `/api/app-store/jobs/*` endpoints.
- **State machine:**
  ```
  pending → cloning → reviewing → awaiting_approval → installing → installed
                  ↘ failed                       ↘ cancelled
  ```
- **API contract:**
  ```
  POST /api/app-store/install
    Body: { slug, commit, channel, secrets?: {...}, source: 'os8.ai'|'manual' }
    Response: { jobId, status: 'cloning' }
  GET  /api/app-store/jobs/:jobId
    Response: { id, status, externalSlug, error_message?, log_path?, createdAt, updatedAt }
  GET  /api/app-store/jobs/:jobId/log         (SSE stream)
  POST /api/app-store/jobs/:jobId/approve
  POST /api/app-store/jobs/:jobId/cancel
  ```
- **Clone safety:** use `child_process.spawn('git', ['clone', '--depth', '1', '--branch', commit, upstream, stagingDir], { shell: false })`. Verify post-clone HEAD SHA equals declared commit.
- **Acceptance:** Manual `POST /api/app-store/install` for worldmonitor clones into `apps_staging/<jobId>/`, transitions to `awaiting_approval` (review skipped pending PR 1.6), no install commands have run.
- **Tests:** integration test against a small public repo.
- **Renderer vs main:** server-only.
- **Dependencies:** PR 1.1, PR 1.3.
- **Estimated LOC:** ~350.
- **Independent merge?** Yes.

### 1.6 — `AppReviewService` (security review for apps)
- **Goal:** Static checks (deterministic, blocking) + static analysis (advisory) + LLM review of cloned files against manifest claims. Hooks into `app_install_jobs` state machine: `cloning` → `reviewing` → `awaiting_approval`.
- **Files:** create `src/services/app-review.js`. Extract LLM-call helper (client setup, model resolution via routing, retry, response parsing) into `src/services/security-review-shared.js` and have both `skill-review.js` and `app-review.js` import it. Add app-specific routes in `src/routes/app-store.js`.
- **Decision (deviates from spec §6.2.5):** the spec proposed renaming `SkillReviewService → SecurityReviewService`. We instead extract a thin shared helper and keep two separate services. Reason: (a) `skill-review.js` is 521 lines with a skill-specific system prompt and risk taxonomy; (b) renaming churns every existing import (`routes/skills.js:3,146`); (c) the app review prompt cross-references `permissions.os8_capabilities` against `window.os8.*` calls, audits `start.argv` honesty for the declared framework, and looks for outbound endpoints not justified by the README — meaningfully different from the skill prompt. If a future curator wants a single facade, that's a v1.5 cleanup made cheap by the helper extraction.
- **Static checks (blocking):**
  - argv arrays only in install/postInstall/preStart/start
  - No `curl … | sh` / `wget … | sh` patterns
  - `package.json` `scripts.postinstall`/`preinstall` flagged for LLM scrutiny
  - Lockfile present and matches declared `package_manager` (Verified channel)
  - `process.arch` is in `runtime.arch`
  - `upstream_resolved_commit` is 40-char hex
- **Static analysis (advisory):**
  - Node: `npm audit --json` parsed for high/critical
  - Python: `pip check` (`safety`/`osv-scanner` deferred to Phase 3)
  - License scan vs `legal.license`
  - Pattern greps: `child_process.exec`, `eval`, `Function()`, dynamic `require()`
- **LLM prompt covers:** what process actually runs (`start.argv`), permissions vs observed code, outbound endpoints, fs access outside `app-private`, secret handling, supply-chain dep counts.
- **Output:** structured report with `riskLevel` + `findings[]` + `summary`. Stored **inline** as JSON on `app_install_jobs.review_report` (no separate `reviews` table for v1; mirrors the existing `capabilities.review_report` pattern at [`schema.js:533`](../src/db/schema.js#L533)). PR 1.1 adds the column. If review history becomes load-bearing in PR 1.25 (update flow surfaces multi-review), promote to a dedicated `reviews` table then — it's a mechanical migration.
- **Acceptance:** Cloned worldmonitor passes static checks, generates a low-risk report, transitions job to `awaiting_approval`.
- **Tests:** unit on each static check; LLM call mocked.
- **Renderer vs main:** server-only.
- **Dependencies:** PR 1.5 (cloned files to review).
- **Estimated LOC:** ~450. **Flag:** likely splits — static checks (~200) + LLM call (~150) + integration (~100).
- **Independent merge?** Yes.

### 1.7 — `scopedApiMiddleware` (server-side capability enforcement)
- **Goal:** Match `/<localSlug>/_os8/api/*`, resolve app, parse capability from path + method, check against `app.manifest_yaml.permissions.os8_capabilities`, inject `X-OS8-App-Id` header, rewrite path to `/api/*`, forward via `next()`.
- **Files:** create `src/services/scoped-api-surface.js` exporting `scopedApiMiddleware(db)` factory. Capability-resolution helpers in same file.
- **Capability resolution table** (path → required cap):
  ```
  /blob/*                → blob.readwrite (PUT/DELETE) or blob.readonly (GET)
  /db/query              → db.readonly
  /db/execute            → db.readwrite
  /telegram/send         → telegram.send
  /imagegen/*            → imagegen
  /speak/*               → speak
  /youtube/*             → youtube
  /x/*                   → x
  /google/calendar/*     → google.calendar.readonly | google.calendar.readwrite (by method)
  /google/drive/*        → google.drive.readonly
  /google/gmail/*        → google.gmail.readonly
  /mcp/<server>/<tool>   → mcp.<server>.<tool>
  ```
- **Failure modes:**
  - App not found → 404 `{ error: 'not an external app' }`
  - Capability not declared → 403 `{ error: 'capability not declared', requested, declared }`
- **Acceptance:** unit test — request to `/foo/_os8/api/blob/x` for an external app declaring `blob.readonly` succeeds for GET, 403s for PUT.
- **Tests:** `tests/scoped-api-surface.test.js`.
- **Renderer vs main:** server-only.
- **Dependencies:** PR 1.1.
- **Estimated LOC:** ~280.
- **Independent merge?** Yes (mounted in 1.15).

### 1.8 — `requireAppContext` enforcement on external-eligible APIs
- **Goal:** API routes reachable by external apps reject requests without `X-OS8-App-Id` header. Native shell + native React apps remain trusted (no header set, allowed).
- **Files:** create `src/middleware/require-app-context.js`. Apply to specific routers: `routes/app-blob.js`, `routes/app-db.js`, `routes/imagegen.js`, `routes/speak.js`, `routes/youtube.js`, `routes/x.js`, `routes/telegram.js`, `routes/google.js`, `routes/mcp.js`.
- **The check (relaxed for v1):**
  ```js
  function requireAppContext(req, res, next) {
    const appId = req.headers['x-os8-app-id'];
    if (appId) { req.callerAppId = appId; }
    // v1: native shell calls without the header are allowed (trusted code).
    // The scopedApiMiddleware sets the header for external apps.
    next();
  }
  ```
- **Why permissive in v1:** §11.1 of the spec resolves this — native React apps and the OS8 shell are trusted code. Tighten when a native app needs per-app scoping. Keep the middleware in place so it's a single switch to flip later.
- **Acceptance:** External app gated through 1.7 reaches `/api/apps/<id>/blob/*` with `req.callerAppId` set; native shell still works without the header.
- **Tests:** unit on middleware; integration with 1.7.
- **Renderer vs main:** server-only.
- **Dependencies:** PR 1.7.
- **Estimated LOC:** ~150 (mostly mounting in many routers).
- **Independent merge?** Yes.
- **Deviations from spec:** the spec implies a stricter form; I propose the relaxed v1 form (matching §11.1's stated tradeoff) so we don't break native apps. Flagged as resolvable when `requireAppContext` rolls out per-API.

### 1.9 — `window.os8` SDK (BrowserView preload)
- **Goal:** A separate preload script for external-app `BrowserView` instances injects a typed `window.os8` SDK. Methods only exist when the manifest declares the capability.
- **Files:** create `src/preload-external-app.js`. Wire from `PreviewService.create(appId, { external: true })` in PR 1.19.
- **SDK surface:** `window.os8.blob.{read,write,list,delete}`, `db.{query,execute}`, `imagegen.*`, `speak.*`, `telegram.*`, `youtube.*`, `x.*`, `google.calendar.*`, `mcp.<server>.*`. Each method is added to the exposed object only if `permissions.os8_capabilities` lists it (the preload reads the manifest from a query string param or via a one-time IPC handshake).
- **Type definitions:** ship `src/templates/os8-sdk.d.ts` for IDE autocomplete; copy into the auto-generated CLAUDE.md (see PR 1.21). Resolves spec §11.7 — pick "ship .d.ts in CLAUDE.md", defer npm package to v2.
- **Acceptance:** Loaded inside an external BrowserView, `window.os8.blob` exists when manifest declares `blob.readwrite`; missing when not declared. Calling `window.os8.blob.write('key', data)` round-trips through `/foo/_os8/api/blob/key`.
- **Tests:** smoke through the BrowserView (deferred until 1.19 wires it).
- **Renderer vs main:** preload runs in renderer; reads manifest via IPC.
- **Dependencies:** PR 1.7, PR 1.19 (consumer).
- **Estimated LOC:** ~250.
- **Independent merge?** Yes.

### 1.10 — `EnvService` per-app overload + sanitized env builder
- **Goal:** Extend `EnvService` with optional `appId` parameter. Build the sanitized env per spec §6.3.1.
- **Files:** modify `src/services/env.js`. Create `src/services/sanitized-env.js`.
- **EnvService extensions:**
  ```js
  EnvService.set(db, key, value, { appId, description })       // per-app when appId set
  EnvService.getAllForApp(db, appId) → { [key]: value }
  EnvService.deleteForApp(db, appId, key)
  ```
  Reads from `app_env_variables` (existing table at [`schema.js:36-42`](../src/db/schema.js#L36)).
- **`buildSanitizedEnv({ appId, allocatedPort, manifestEnv, localSlug, OS8_PORT })`** returns the spec §6.3.1 env object. Whitelisted host vars: `PATH, HOME, TMPDIR, LANG, TZ, USER` plus optional `LC_ALL/LC_CTYPE`. OS8-injected: `OS8_APP_ID, OS8_APP_DIR, OS8_BLOB_DIR, OS8_BASE_URL, OS8_API_BASE, PORT`. Manifest `env:` array merged. Per-app secrets merged. **Critical:** never `...process.env`.
- **Cross-platform:** Windows uses `TEMP`/`TMP` not `TMPDIR`; `USERNAME` not `USER`. Build helper handles both.
- **Acceptance:** Built env contains exactly the whitelisted/declared keys; no Anthropic/OpenAI/Google API keys leak; spec §6.3.1 reference passes.
- **Tests:** `tests/sanitized-env.test.js` — assert keys present/absent under various manifests.
- **Renderer vs main:** server-only.
- **Dependencies:** PR 1.1.
- **Estimated LOC:** ~200.
- **Independent merge?** Yes.

### 1.11 — Node runtime adapter
- **Goal:** Implement `RuntimeAdapter` interface for `runtime.kind: node`. argv-array spawn with `shell: false`. Package-manager auto-detection. Frozen install. `.env` file generation. Framework defaults. Cross-platform tree-kill.
- **Files:** create `src/services/runtime-adapters/node.js`, `src/services/runtime-adapters/index.js` (interface + registry). Add `tree-kill` to `package.json` (~5KB lib).
- **Adapter shape (per spec §6.2.2):**
  ```js
  {
    kind: 'node',
    async ensureAvailable(spec),
    detectPackageManager(appDir) → 'npm'|'pnpm'|'yarn'|'bun',
    async install(spec, appDir, sanitizedEnv, onLog),
    async start(spec, appDir, sanitizedEnv, onLog) → { pid, port, ready: Promise<void> },
    async stop(processInfo),
    watchFiles(spec, appDir, onChange) → () => void,
    async detectVersion(spec, appDir)
  }
  ```
- **Lockfile precedence (resolves spec §11.10):** `pnpm-lock.yaml > yarn.lock > bun.lockb > package-lock.json`. Document in adapter source.
- **Yarn version disambiguation:** `package_manager: yarn` in the manifest is a single value — the adapter detects yarn1 vs berry/yarn4 by `.yarnrc.yml` presence in `appDir`. Present → berry → `yarn install --immutable`. Absent → yarn1 → `yarn install --frozen-lockfile`. Manifest authors don't need to know their yarn version.
- **Frozen-install commands:**
  - npm → `npm ci`
  - pnpm → `pnpm install --frozen-lockfile`
  - yarn → `yarn install --immutable` (berry, .yarnrc.yml present) / `yarn install --frozen-lockfile` (yarn1)
  - bun → `bun install --frozen-lockfile`
- **Package-script policy (resolves spec §11.8 — channel-tiered):** controls whether installs run `package.json` `postinstall`/`preinstall` lifecycle scripts (a real supply-chain vector via transitive deps).
  ```js
  const RUN_PACKAGE_SCRIPTS = {
    'verified':         true,   // curator reviewed; postinstall flagged in review report
    'community':        false,  // --ignore-scripts default; manifest opts in via allow_package_scripts: true
    'developer-import': false,  // --ignore-scripts always; no opt-in mechanism
  };
  ```
  `--ignore-scripts` is passed to npm/pnpm/yarn/bun when `RUN_PACKAGE_SCRIPTS[channel] && !manifest.allow_package_scripts` is false. App authors needing native modules (sharp, esbuild, prisma) get them out of the box on Verified; Community apps must explicitly opt in (which the security review treats as a yellow flag); Developer-Imported apps stay locked down. Add `allow_package_scripts: boolean` (default false) to the AppSpec — extend PR 0.1's JSON Schema.
- **Framework defaults (when manifest fields absent):** all v1 frameworks bind at `/` (no base-path needed thanks to subdomain mode). `vite` → readiness http GET `/`, hmr `vite`, default flags `--port {{PORT}} --host 127.0.0.1`. `nextjs` → readiness http GET `/`, hmr `next`, `--port {{PORT}}`. `sveltekit` / `astro` → equivalent flags; no config-file patches needed. `none` → no-op.
- **Tree-kill:** spawn with `detached: false` on Windows; use `tree-kill` lib for SIGTERM-then-SIGKILL with 5s grace.
- **Readiness probe:** http (poll port until 2xx) or log-regex (scan stdout). Configurable timeout from `start.readiness.timeout_seconds`.
- **Acceptance:** Adapter installs worldmonitor (frozen), starts it, returns ready Promise that resolves when port responds 200.
- **Tests:** `tests/runtime-adapters/node.test.js` — install, start, stop against a tiny fixture Vite project.
- **Renderer vs main:** server-only.
- **Dependencies:** PR 1.10.
- **Estimated LOC:** ~500. **EXCEEDS 400.** Recommended split: 1.11a (adapter shell + ensureAvailable + detectPackageManager + install) ~250 LOC, 1.11b (start + stop + readiness + watchFiles) ~250 LOC.
- **Independent merge?** 1.11a yes; 1.11b depends on 1.11a.

### 1.12 — `AppProcessRegistry` (multi-signal idle reaping)
- **Goal:** Lifecycle registry per spec §6.2.4. Random port allocation in `[40000, 49999]` with EADDRINUSE reroll. Multi-signal idle detection (HTTP + stdout + child). Per-app `keepRunning` override. `stopAll()` on app quit.
- **Files:** create `src/services/app-process-registry.js`. Wire `stopAll()` into the existing cleanup at `main.js:395-420` ([window-all-closed handler](../main.js#L395)).
- **API:** per spec §6.2.4 — `start`, `stop`, `get`, `getAll`, `markHttpActive`, `markStdoutActive`, `markChildActive`, `setKeepRunning`, `reapIdle`, `stopAll`.
- **Idle reaping default:** 30 minutes (resolves spec §11.3 — surface as Settings slider in PR 1.22). Bypass when `keepRunning === true`.
- **Activity wires:**
  - HTTP: `ReverseProxyService.middleware()` calls `markHttpActive(appId)` on every proxied request.
  - stdout/stderr: runtime adapter's `onLog` callback also pings `markStdoutActive`.
  - child: adapter spawn watcher checks `ps` for child pids, pings `markChildActive`. (Linux/macOS: `ps -o pgid -p <pid>`; Windows: `wmic process where parentprocessid=<pid>`.)
- **Acceptance:** Process starts, idles 31 min on all signals → reaped; with one signal active → not reaped; `keepRunning=true` → never reaped.
- **Tests:** `tests/app-process-registry.test.js` — port allocation, idle reaping, signal tracking.
- **Renderer vs main:** server-only.
- **Dependencies:** PR 1.11.
- **Estimated LOC:** ~350.
- **Independent merge?** Yes.

### 1.15 — Mount middleware in `src/server.js`
- **Goal:** Splice `scopedApiMiddleware` and `ReverseProxyService.middleware()` into the Express stack ahead of the catch-all. Wire `attachUpgradeHandler` at server startup.
- **Files:** modify `src/server.js`. Insertion points:
  ```
  Line 679 (after Vite middleware mount):
    const ReverseProxyService = require('./services/reverse-proxy');
    const { scopedApiMiddleware } = require('./services/scoped-api-surface');
    app.use(scopedApiMiddleware(db));
    app.use(ReverseProxyService.middleware());

  Line 798 (in startServer, after setupVoiceStream/TTSStream/CallStream):
    ReverseProxyService.attachUpgradeHandler(server);
  ```
- **Acceptance:** Native apps continue to work (catch-all at line 682 still reached); a fake external-app slug routed through the proxy returns 502 (no upstream registered yet).
- **Tests:** smoke — start server, hit `/<unknown>/foo` → falls through to 404; mounted with a fake `register('foo', ...)` returns 502 (proxy can't connect).
- **Dependencies:** PR 1.7, PR 1.13. **GATED behind PR 1.14.**
- **Estimated LOC:** ~50.
- **Independent merge?** Yes.

### 1.16 — `AppCatalogService.install` full pipeline
- **Goal:** Glue clone (1.5) → review (1.6) → user approves → install via runtime adapter (1.11) using sanitized env (1.10) → atomic `staging_dir → ~/os8/apps/<id>/` move → `apps` row insert (`app_type='external'`, `status='active'`) → save secrets to `app_env_variables` → `git checkout -b user/main` → `status='installed'` → fire-and-forget `track-install` POST to os8.ai.
- **Files:** modify `src/services/app-catalog.js` (extend `install` method); add `src/services/app-installer.js` (the orchestrator). Update `src/routes/app-store.js`.
- **State transitions:** uses `app_install_jobs` from PR 1.5; adds `installing → installed` transition with rollback on failure (`failed`, staging dir cleaned by `reapStaging`).
- **Atomic move:** `fs.renameSync(stagingDir, finalDir)`. On Linux/macOS, `rename` across the same filesystem is atomic. If `apps_staging` and `apps` are on different mounts, fall back to copy-then-delete with a transient `<id>.installing` marker.
- **Apps row insert** uses `AppService.create()` analogue but with extended fields (`app_type='external'`, `external_slug`, `channel`, `framework`, `manifest_yaml`, `manifest_sha`, `catalog_commit_sha`, `upstream_declared_ref`, `upstream_resolved_commit`).
- **Acceptance:** End-to-end: `POST /api/app-store/install` for worldmonitor → review → approve → install → `apps` row with `app_type='external'` exists, files in `~/os8/apps/<id>/`, `git status` clean on `user/main`, secret saved to `app_env_variables`.
- **Tests:** integration test through the whole pipeline against a tiny fixture catalog entry.
- **Renderer vs main:** server-only.
- **Dependencies:** PR 1.5, 1.6, 1.10, 1.11, 1.12, 1.15. **GATED behind 1.14.**
- **Estimated LOC:** ~450. **EXCEEDS 400.** Recommend split: 1.16a (orchestrator + state transitions) ~250, 1.16b (atomic move + apps row + git init + track-install POST) ~200.
- **Independent merge?** 1.16a no (depends on full upstream chain); 1.16b depends on 1.16a.

### 1.17 — Install plan review UI (renderer modal)
- **Goal:** Full review UI: permissions, secrets (with `pattern` validation), review findings (collapsible by severity), install commands (collapsible code blocks), disk/time estimates. Approval gate enforces all required secrets entered + no critical-severity findings (with explicit override for medium-severity).
- **Files:** new `src/renderer/install-plan-modal.js`, new component CSS in `styles/components/`. Wire into `src/renderer/main.js` event flow. IPC handlers in `src/ipc/app-store.js` for `app-store:install-job-update` events.
- **SSE subscription:** on `app-store:install-job-update` events, modal updates progress bar / log panel.
- **Acceptance:** Click Install on a manifest with secrets required → modal blocks Install button until all secrets entered; click Install → progress UI streams adapter logs; on completion, modal closes and app icon appears with brief animation.
- **Tests:** visual smoke; unit on validation logic.
- **Renderer vs main:** all renderer-side except IPC.
- **Dependencies:** PR 1.4, 1.6, 1.16.
- **Estimated LOC:** ~550. **EXCEEDS 400.** Recommend split: 1.17a (modal scaffold + permissions + secrets) ~250, 1.17b (review findings + install commands + progress streaming) ~300.
- **Independent merge?** 1.17a yes (renders without backend); 1.17b depends on 1.16.

### 1.18 — Wire `os8://install` → install-plan UI
- **Goal:** `handleProtocolUrl` from PR 1.2 dispatches to PR 1.17. Cross-checks against local `app_catalog`; fetches manifest from os8.ai if missing.
- **Files:** modify `src/services/protocol-handler.js`, IPC channel `protocol:install-request` → renderer.
- **Acceptance:** `open 'os8://install?slug=worldmonitor&commit=...'` opens install plan modal with the manifest pre-loaded.
- **Tests:** manual.
- **Dependencies:** PR 1.2, 1.3, 1.17.
- **Estimated LOC:** ~150.
- **Independent merge?** No (depends on 1.17).

### 1.19 — App icon launch path + hardened BrowserView
- **Goal:** Detect `app_type === 'external'` on icon double-click; start process; register proxy; load BrowserView with hardened webPreferences.
- **Files:** modify `src/renderer/apps.js`, `src/renderer/tabs.js` (the click-to-launch flow at [`tabs.js:327-360`](../src/renderer/tabs.js#L327)). Modify `src/services/preview.js` to add `external` flag. Add `src/preload-external-app.js` (created in PR 1.9). New API endpoint `POST /api/apps/:id/processes/start`.
- **Hardened webPreferences (per spec §6.6):**
  ```js
  {
    preload: path.join(__dirname, 'src', 'preload-external-app.js'),
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    enableBlinkFeatures: '',
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    backgroundThrottling: false  // keep for parity with native preview
  }
  ```
- **Navigation restriction (DEVIATION from spec snippet):** the spec checks `u.host !== 'localhost:OS8_PORT' || !u.pathname.startsWith('/<localSlug>/')`. The host check is wrong — both native and external apps share `localhost:8888`. Use pathname-only:
  ```js
  view.webContents.on('will-navigate', (e, url) => {
    const u = new URL(url);
    if (u.host !== `localhost:${OS8_PORT}` || !u.pathname.startsWith(`/${localSlug}/`)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  ```
  (Equivalent code, but the **reason** matters: deny is the same logical condition; the spec's wording was just unclear about which check kicks in first.)
- **`setWindowOpenHandler`:** deny + `shell.openExternal(url)` for popups.
- **`setPermissionRequestHandler`:** deny camera/mic/geolocation by default (spec resolution: external apps cannot escalate permissions in v1).
- **Run flow:** `tabs.js:createAppTab(app)` → if `external`, POST `/api/apps/:id/processes/start` → `AppProcessRegistry.start()` → `ReverseProxyService.register(slug, appId, port)` → `PreviewService.setUrl(appId, 'http://localhost:8888/<slug>/', { external: true })`.
- **Acceptance:** worldmonitor launches in hardened BrowserView; clicking external link opens system browser; popup attempt routes to system browser; mic permission prompt is denied silently.
- **Tests:** smoke + unit on nav restriction logic.
- **Renderer vs main:** crosses IPC; main owns the BrowserView, renderer owns icon click.
- **Dependencies:** PR 1.9, 1.12, 1.13, 1.15. **GATED behind 1.14.**
- **Estimated LOC:** ~350.
- **Independent merge?** No.
- **Deviations from spec:** the host check in the spec snippet is logically fine but the reasoning needs the pathname-prefix as the actual gate. Flagged.

### 1.20 — Window-chrome `os8://apps/<localSlug>` label (cosmetic)
- **Goal:** Window chrome shows the cosmetic URL while the BrowserView loads the real `localhost:8888/<slug>/`.
- **Files:** modify `src/renderer/main.js` URL display logic; minor CSS.
- **Acceptance:** Visible label says `os8://apps/worldmonitor` when worldmonitor tab is active.
- **LOC:** ~50.
- **Dependencies:** 1.19.

### 1.21 — Auto-generated CLAUDE.md for external apps
- **Goal:** On install (PR 1.16), generate a minimal `CLAUDE.md` at `~/os8/apps/<id>/CLAUDE.md` that documents the manifest, declared capabilities, `window.os8` SDK, data dirs (`OS8_APP_DIR`, `OS8_BLOB_DIR`), per-app SQLite db.
- **Files:** modify `src/claude-md.js` (or create `src/claude-md-external.js`), wire into installer (1.16).
- **Includes:** copy of `os8-sdk.d.ts` (for IDE autocomplete inside the app folder).
- **Acceptance:** worldmonitor install yields `CLAUDE.md` with capability list matching its manifest.
- **LOC:** ~200.
- **Dependencies:** 1.9 (SDK types), 1.16.

### 1.22 — Dev mode toggle + chokidar watcher + log panel
- **Goal:** Per-app `apps.dev_mode` flag. When ON: file tree shows `~/os8/apps/<id>/`, chokidar watches per `dev.watch` (respects `.gitignore`), log panel surfaces stdout/stderr. When OFF: hidden.
- **Files:** modify `src/renderer/file-tree.js`, `src/renderer/terminal.js` (log panel reuse), new `src/renderer/dev-mode-toggle.js`, IPC `dev-mode:toggle`. Wire `chokidar` (already a dep at [`package.json:75`](../package.json)) with `ignored: gitignored`.
- **Settings slider:** add idle-timeout slider (5min–4h + Never) per spec §11.3.
- **Acceptance:** Toggle flips watcher on/off; edits to `.tsx` files trigger HMR (passes through proxy).
- **LOC:** ~400. **AT LIMIT.** Possible split: 1.22a (toggle + file tree) ~200, 1.22b (watcher + log panel) ~200.
- **Dependencies:** 1.19.

### 1.23 — Fork-on-first-edit + dirty-tree recovery
- **Goal:** On install, `git init` (or use existing repo), `git checkout -b user/main`, `git branch upstream/manifest <commit>`. Generate `.gitignore` per spec §6.8. Watcher debounce 5s + auto-commit `[user] <ts> <files>`. Dirty-tree recovery on dev-mode activation: prompt {Continue / Reset / Stash}.
- **Files:** new `src/services/app-git.js`, integrate into installer (1.16) and watcher (1.22).
- **Acceptance:** First edit creates a commit on `user/main`; restarting OS8 with dirty changes prompts the recovery dialog.
- **LOC:** ~250.
- **Dependencies:** 1.16, 1.22.

### 1.24 — Uninstall flow (tiered)
- **Goal:** Right-click → Uninstall confirm (default removes code, preserves data; checkbox to also delete data). Stops process, unregisters proxy, `rm -rf ~/os8/apps/<id>/`, sets `status='uninstalled'`.
- **Files:** `src/renderer/apps.js` (right-click menu), `src/services/app.js` (`uninstall()` method), `src/routes/apps.js` (`POST /:id/uninstall`).
- **Acceptance:** Uninstall removes code; reinstall offers data restore (matches spec §6.10).
- **LOC:** ~200.
- **Dependencies:** 1.16.

### 1.25 — Update detection + manual update flow
- **Goal:** `AppCatalogService.sync` compares `app_catalog.upstream_resolved_commit` vs `apps.upstream_resolved_commit`. Mismatches set `apps.update_available = 1, update_to_commit = <newSha>`. UI shows dot on icon. Click update → `AppCatalogService.update()`: fast-forward if no `user_branch`; three-way merge into `user/main` otherwise. Conflicts surface in app's source sidebar with `git status` summary; user resolves manually.
- **Files:** modify `src/services/app-catalog.js`, `src/renderer/apps.js`, new `src/renderer/update-banner.js`.
- **UI for non-trivial conflicts (resolves spec §11.11):** dock-style sidebar listing conflicting files; click each to open in app's editor (Claude Code or system); "Mark resolved" button per file; "Abort merge" reverts.
- **Acceptance:** Updating worldmonitor with no edits fast-forwards cleanly; with edits creating conflict, conflict UI lists files.
- **LOC:** ~400. **AT LIMIT.** Possible split.
- **Dependencies:** 1.16, 1.23.

### 1.26 — Cross-device install (pending_installs polling)
- **Goal:** Signed-in users: poll `os8.ai /api/account/pending-installs` on a 60s timer; for each pending, route through install-plan UI; on success, `POST /pending-installs/:id/consume` + `track-install`.
- **Files:** new `src/services/pending-installs-poller.js`, wire into `main.js`'s post-startup.
- **Acceptance:** Sign in to os8.ai on web, click Install, see desktop install plan within 60s.
- **LOC:** ~200.
- **Dependencies:** 1.18, os8.ai 0.11.

### 1.27 — (Removed) Subdomain mode is now the v1 default
**Subdomain mode (`<slug>.localhost:8888`) is the v1 default and only routing mode**, decided after weighing path vs subdomain on long-term product fit. Path mode shares one browser origin across every installed app — a real architectural leak that hardened-BrowserView only mitigates at runtime. Subdomain mode makes each app its own origin and gets isolation for free from the browser's same-origin policy. It also eliminates the per-framework base-path tax (Next.js / SvelteKit / Astro / Jekyll all ship config-file-based base paths, not flags).

What that means for the plan:

- **PR 1.13** (`ReverseProxyService`) is now host-based by default — match `Host: <slug>.localhost:8888`, proxy to upstream port. No `mode` parameter.
- **PR 1.14** (gating smoke test) tests subdomain HMR — Vite + http-proxy + WebSocket through `<slug>.localhost:8888`. Subdomain WS proxying is a well-trodden production configuration; this de-risks the architectural commitment but the risk is much lower than the path-mode equivalent would have been.
- **PR 1.7** (`scopedApiMiddleware`) matches on Host header (extract slug from `<slug>.localhost`) instead of path prefix; capability path is `/_os8/api/...` on the subdomain.
- **PR 1.9** (`window.os8` SDK) uses `apiBase = '/_os8/api'` (relative to the page's own origin).
- **PR 1.11** (Node adapter) drops `--base /{{APP_PATH}}/` flag injection. Frameworks bind at `/` with `--host 127.0.0.1`.
- **PR 1.19** (BrowserView launch) loads `http://<slug>.localhost:8888/?__os8_app_id=...`; `will-navigate` gate is host-based (`u.hostname === '<slug>.localhost'`).

The Windows hosts-entry concern from spec §11 Q4 is folded into PR 1.16's pre-flight DNS check: at install time, OS8 verifies `<slug>.localhost` resolves to `127.0.0.1`; on failure (rare on macOS/Linux/Win11; possible on legacy Windows or AV-restricted setups), prompt for a hosts entry with UAC elevation. This is a recoverable install-time error, not a permanent block.

See phase-1-plan.md for the implementation contract.

- **Files:** none — folded into 1.13 / 1.16.
- **Dependencies:** none.

### 1.28 — E2E acceptance test
- **Goal:** Install worldmonitor end-to-end through the entire pipeline; edit `App.tsx` with Claude Code; verify HMR updates the live preview.
- **Files:** `tests/e2e/app-store-worldmonitor.test.js`.
- **Acceptance:** Test passes on macOS + Linux.
- **LOC:** ~200.
- **Dependencies:** every prior PR.

### 1.29 — `reapStaging` on startup
- **Goal:** On main.js startup, `AppCatalogService.reapStaging(db)` removes `apps_staging/<jobId>/` directories whose `app_install_jobs` row is `failed | cancelled` or older than 24h with status not in `installed`.
- **Files:** modify `src/services/app-catalog.js`, hook in `main.js:215` (after migrator runs).
- **Acceptance:** Crash mid-install leaves a staging dir; restart cleans it.
- **LOC:** ~80.
- **Dependencies:** 1.5.

---

## 5. Phase 1A — vertical slice

**Cut:** the smallest set of PRs that proves the architecture end-to-end with a hand-authored manifest, no os8.ai dependency, no scoped capability calls.

**The 13 PRs in the slice:**

| PR | Why in the slice |
|---|---|
| 1.1 | Schema must exist before anything else writes to `apps_staging` or `app_install_jobs`. |
| 1.13 | Reverse proxy primitive. Foundation for the smoke test and runtime. |
| **1.14** | **Gates the architecture.** If Vite HMR can't traverse the proxy, the slice and v1 are wrong. Must merge before 1.15+. |
| 1.4 | Manifest validation + plan UI shell — needed to render the install plan from a hand-authored manifest. |
| 1.5 | Static fetch + state machine — clones the manifest's upstream into staging without running install. |
| 1.6 | Security review — gates approval. Slice uses a low-risk manifest so review is mostly static checks. |
| 1.10 | Sanitized env builder — no slice install should leak host secrets. |
| 1.11 | Node runtime adapter — actually runs the dev server. |
| 1.12 | Process registry — keeps the running process tracked. |
| 1.15 | Mounts middleware. After 1.14 passes. |
| 1.16 | Install pipeline glue. The keystone. |
| 1.17 | Install plan UI. The user must approve. |
| 1.19 | Hardened BrowserView + launch path. The `localhost:8888/<slug>/` URL must load in a sandboxed view. |

**Excluded from the slice (and why):**
- 1.2 (protocol handler), 1.3 (catalog sync), 1.18 (deeplink), 1.26 (cross-device): the slice uses a hand-authored manifest fed through a manual `POST /api/app-store/install` call; no os8.ai involvement.
- 1.7 (scoped API surface), 1.8 (`requireAppContext`), 1.9 (`window.os8` SDK): the slice's worldmonitor declares `os8_capabilities: []`. The scoped surface isn't exercised, so we can defer it. **Caveat:** these MUST merge before any app declaring a capability is approved.
- 1.20 (cosmetic chrome label), 1.21 (CLAUDE.md), 1.22 (dev mode), 1.23 (fork), 1.24 (uninstall), 1.25 (update), 1.28 (E2E test), 1.29 (reapStaging): all polish or delivery for full Phase 1; slice doesn't need them. (PR 1.27 was removed — subdomain mode is now the v1 default in PR 1.13.)

**The slice's user demo:** "Run `POST /api/app-store/install` with a hand-authored worldmonitor manifest body → install plan modal opens → user clicks Approve → installer clones, runs review (low-risk findings), runs `npm ci` then `npm run dev`, registers proxy → BrowserView loads `localhost:8888/worldmonitor/` → user sees the running app."

**Why this is the right cut:** it exercises every load-bearing architectural claim — reverse proxy + WebSocket HMR (1.13/1.14/1.15), review-before-install (1.5/1.6), sanitized env (1.10), runtime adapter (1.11), atomic staging-to-apps move (1.16), hardened BrowserView (1.19) — without spending effort on catalog distribution, deeplinks, or polish. If the slice works on macOS + Linux against a real Vite app, the rest of Phase 1 is glue and UX.

---

## 6. Phase 2 / Phase 3 outlines

### Phase 2 — Python and Docker runtimes (≤200 words)

`PythonRuntimeAdapter` (PR 2.1) parallels the Node adapter: argv spawn with `shell: false`; auto-installs `uv` if missing (download from astral.sh release tarball into `~/os8/bin/`); `package_manager` detection by lockfile (`uv.lock | poetry.lock | requirements.txt`); frozen install via `uv sync --frozen` / `poetry install --no-update` / `pip install -r requirements.txt --require-hashes` (fallback). Streamlit/Gradio adapters (PR 2.2) extend with framework-specific HMR (Streamlit re-runs on file change natively; Gradio's `block_demo.queue().launch(reload=True)`). Static adapter (PR 2.3) serves Hugo/Jekyll/plain HTML directly via Express — no dev server, no proxy needed (static-mode bypass). Catalog seed expands (PR 2.4) with ComfyUI + OpenWebUI manifests. Docker adapter (PR 2.5) detects Docker availability; surfaces install hint if missing; spawns container with `-p <port>:<container_port>`, `--mount` for `OS8_APP_DIR` and `OS8_BLOB_DIR`. Docker fallback (PR 2.6) for apps needing CUDA/ffmpeg/native libs that fail to install via `uv` directly. Outcome: all major v2 categories work.

### Phase 3 — Open the floodgates (≤200 words)

**Ordering:** PRs 3.1 + 3.2 (Developer Import) ship independently of 3.3 + 3.4 (catalog-community). Developer-Imported manifests stay desktop-local — no os8.ai mirror — so they don't need a community catalog to be useful. Sharing happens via git URL passing initially; catalog-community is a follow-on once curation patterns settle. PR 3.6 (supply-chain analyzer) is independent of both tracks.

Developer Import (PR 3.1): paste a GitHub URL in OS8 → fetch repo metadata → auto-generate draft AppSpec from `package.json` (Node), `pyproject.toml` (Python), or `Dockerfile` (Docker fallback). Heuristics: detect framework from `dependencies` + script names (`vite` → Vite; `next` → Next; `streamlit` → Streamlit). Prompt user to fill in declared `permissions.os8_capabilities` and required secrets. High-friction install plan UI (PR 3.2): Developer Import gets a "developer mode" badge, all permissions force-opt-in (must individually toggle each), extra warnings ("This app has not been reviewed by OS8 curators"); per the channel-tiered policy in PR 1.11, Developer Import always passes `--ignore-scripts` with no opt-in. `os8ai/os8-catalog-community` repo (PR 3.3): same schema, lighter CI (no curator approval; spam/malware filter only); apps land with `channel='community'`. os8.ai community tab (PR 3.4): `/apps?channel=community` filter; clearly marked. Per-channel enable/disable in OS8 settings (PR 3.5). Supply-chain analyzer (PR 3.6): `osv-scanner` for Node + Python; `safety` for Python; flags known-malicious packages by name; integrates into `AppReviewService` static analysis as a high-severity finding. Outcome: anyone can publish; trust tiers visibly differentiated.

---

## 7. Open Implementation Details — resolution pass

| # | Spec question | Resolution |
|---|---|---|
| 1 | Native-app/`requireAppContext` rollout cadence | **Resolved.** Ship `requireAppContext` middleware permissive in v1 (allow no-header for trusted code), tighten when first native app needs per-app scoping. PR 1.8 builds the switch; flipping it later is a one-line constant change. |
| 2 | `/apps` page caching | **Resolved.** ISR 60s. Confirm by watching cache HIT ratio on Vercel logs after first deploy; if sync cadence drifts (e.g. webhooks fire and ISR is stale for >2 min), drop to 30s revalidation. Not a v1 blocker. |
| 3 | Idle timeout default value | **Resolved.** 30 min default. Settings slider in PR 1.22 with values: 5min, 15min, 30min, 1h, 2h, 4h, Never. |
| 4 | Subdomain mode on Windows | **Resolved.** Subdomain mode is the v1 default and only routing mode (path mode rejected). Win11 modern builds resolve `*.localhost` natively per RFC 6761; legacy/AV-restricted setups get a UAC-elevated hosts-entry prompt at install time (PR 1.16 pre-flight DNS check). DNS-failure is a recoverable install-time error, not a permanent block. Hosts-entry friction was reconsidered against the architectural cost of path mode — origin isolation wins decisively. |
| 5 | `mcp.*` capability granularity | **Resolved.** Fine-grained `mcp.<server>.<tool>` for v1. Wildcards (`mcp.<server>.*`) are a non-breaking addition to evaluate after first deploy; the resolver in PR 1.7 can support both forms with a small lookup change. |
| 6 | Lockfile recognition for `bun.lockb` | **Resolved.** Presence-only check in catalog CI (PR 0.4) and runtime adapter (PR 1.11). Binary content validation deferred — bun's lockfile format is unstable enough that strict validation would fail on minor bun upgrades. |
| 7 | TS types for `window.os8` SDK | **Resolved.** Ship `os8-sdk.d.ts` in the auto-generated CLAUDE.md alongside the app source (PR 1.21). Defer npm package (`@os8/sdk-types`) to v2 — the .d.ts works for IDE autocomplete inside the app folder without a registry round-trip. |
| 8 | Asset CDN migration | **Resolved (deferred).** Use raw GitHub URLs in v1 (PR 0.8 pins them to catalog commit SHA). Watch GitHub raw rate-limit headers in os8.ai logs after launch; if 429s start showing, migrate to Vercel Blob in v2 (one-line URL rewrite during sync). |
| 9 | `requireAppContext` on which APIs exactly | **Resolved.** Apply to: `app-blob`, `app-db`, `imagegen`, `speak`, `youtube`, `x`, `telegram`, `google` (calendar/drive/gmail), `mcp` (proxy). **Do not apply to:** `system`, `apps` (CRUD), `agents`, `assistant`, `voice`, `tts-stream`, `transcribe`, `connections` (OAuth flow), `oauth`, `journal`, `images`, `inspect`, `plans`, `vault`, `tasks`, `jobs` — these are shell/native-app APIs. (Inventory: 38 routes; 11 require app context for external callers; 27 stay shell-only. PR 1.8 implements.) |
| 10 | Multiple lockfiles in same repo | **Resolved.** Precedence: `pnpm-lock.yaml > yarn.lock > bun.lockb > package-lock.json`. Documented in PR 1.11. Manifest can override via `runtime.package_manager: <explicit>`. |
| 11 | Auto-update merge UX for non-trivial conflicts | **Resolved.** Sidebar listing conflicting files with `git status` summary; click to open in app's editor; per-file "Mark resolved" button; "Abort merge" reverts. Detail in PR 1.25. |
| 12 | Cross-platform smoke matrix | **Resolved.** macOS + Linux are blocking for v1 release. Windows is best-effort: subdomain mode must work on Win11 (it does, natively); legacy Windows surfaces the hosts-entry prompt. Set CI matrix to `[macos-14, ubuntu-22.04]`; add `windows-2022` as informational-only initially. |

**12 of 12 closed.** All have a concrete v1 answer.

---

## 8. Dependency graph

```
                 ┌── 0.1 (catalog repo)
       Phase 0 ─┼── 0.2 (validate CI)         (parallel within Phase 0; all
                ├── 0.3 (resolve-refs CI)      independent of desktop work)
                ├── 0.4 (lockfile gate CI)
                ├── 0.5 (worldmonitor manifest) ── needs 0.1–0.4
                ├── 0.6 (more seed manifests) ──── needs 0.1–0.4
                ├── 0.7 (Prisma migration on os8.ai)
                ├── 0.8 (sync endpoint) ────── needs 0.7
                ├── 0.9 (/apps browse) ─────── needs 0.7, 0.8
                ├── 0.10 (/apps/[slug] detail) ─ needs 0.9
                └── 0.11 (install button + endpoints) ── needs 0.7

       Foundation (mergeable in any order):
       ┌── 1.1 (schema migration)     no deps
       ├── 1.2 (protocol handler)     no deps
       ├── 1.13 (reverse proxy)       no deps
       └── 1.10 (sanitized env)       1.1

       GATE:
       1.14 (Vite HMR smoke test) ── 1.13   ◄── BLOCKS 1.15, 1.16, 1.19

       Catalog ingest:
       1.3 (catalog sync) ─── 1.1, os8.ai 0.7+0.8
       1.4 (manifest validation + UI shell) ── 1.1
       1.5 (clone + state machine) ─── 1.1
       1.29 (reapStaging) ─── 1.5

       Review:
       1.6 (security review) ─── 1.5

       Trust boundary:
       1.7 (scoped API middleware) ─── 1.1
       1.8 (requireAppContext) ─── 1.7
       1.9 (window.os8 SDK) ─── 1.7

       Runtime:
       1.11 (Node adapter) ─── 1.10
       1.12 (process registry) ─── 1.11

       Mount:
       1.15 (mount middleware) ─── 1.7, 1.13, 1.14 (gate)

       Install pipeline:
       1.16 (install glue) ─── 1.5, 1.6, 1.10, 1.11, 1.12, 1.15, 1.14 (gate)
       1.21 (CLAUDE.md gen) ─── 1.16
       1.23 (fork-on-first-edit) ─── 1.16
       1.24 (uninstall) ─── 1.16
       1.25 (update flow) ─── 1.16, 1.23
       1.28 (E2E test) ─── all of 1.x

       UI integration:
       1.17 (install plan UI) ─── 1.4, 1.6, 1.16
       1.18 (deeplink → UI) ─── 1.2, 1.3, 1.17
       1.19 (BrowserView + launch) ─── 1.9, 1.12, 1.13, 1.15, 1.14 (gate)
       1.20 (chrome label) ─── 1.19
       1.22 (dev mode + watcher) ─── 1.19
       1.26 (cross-device polling) ─── 1.18, os8.ai 0.11

       (Subdomain mode is the v1 default in 1.13 — no separate PR.)
```

**Critical path** (longest chain to acceptance): `1.13 → 1.14 → 1.15 + 1.10 → 1.11 → 1.12 → 1.16 → 1.17 → 1.19 → 1.28`. Roughly 10 PR-merges deep. Phase 0 can run entirely in parallel with the desktop critical path.

---

## 9. Recommended first 5 PRs

Ordered by **de-risking value × independent merge × unblocks downstream**.

1. **PR 1.13 — `ReverseProxyService` primitive.** First because PR 1.14 depends on it, and PR 1.14 is the architecture-validating gate. Cheap (~220 LOC), no consumer until 1.14, fully testable in isolation.

2. **PR 1.14 — Vite HMR smoke test through reverse proxy.** Highest-leverage de-risking step. Subdomain WS proxying is well-trodden in production tooling so the risk is low, but the test still gates 1.15/1.16/1.19 — catching any subtle Vite-config issue (e.g. `server.hmr.clientPort`) early.

3. **PR 1.1 — Migration `0.5.0-app-store.js`.** Unblocks most of the Phase 1 desktop chain (1.3, 1.4, 1.5, 1.7, 1.10, etc.). Pure additive schema. Idempotent. Mergeable independently.

4. **PR 0.1 — Bootstrap `os8ai/os8-catalog` repo.** Fully independent of desktop work — runs in parallel with the above three. Shapes the contract that PR 0.7 (Prisma) and PR 1.3 (catalog sync) ingest. Fast (~200 LOC, mostly the JSON Schema).

5. **PR 0.7 — os8.ai Prisma migration (App / PendingInstall / CatalogState).** Unblocks PR 0.8 (sync endpoint), PR 0.9 (/apps page), PR 0.11 (install button). Independent of desktop. Small (~80 LOC schema diff). Best to land before PR 0.8 starts because 0.8 is a 350-LOC PR and it's nicer to review against settled models.

**These five together** establish: (a) the foundational primitive, (b) proof the architecture works, (c) the desktop schema, (d) the catalog format, (e) the website data model. After these merge, every other PR has a clear runway.

---

## 10. Decisions log (resolved)

All planning-level open questions have been resolved and folded into the relevant PRs above. Captured here as a one-line index so reviewers can find where each lives.

| # | Decision | Resolved in |
|---|---|---|
| 1 | `SkillReviewService` rename → keep skill/app services separate; extract shared LLM helper | PR 1.6 (Decision note) |
| 2 | Reverse-proxy library → `http-proxy@1.18` | PR 1.13 |
| 3 | Review report storage → inline JSON on `app_install_jobs.review_report` | PR 1.1 + PR 1.6 |
| 4 | Linux `os8://` integration → `.deb` postinst auto + AppImage first-run prompt + os8.ai copyable-commit fallback | PR 1.2 + PR 0.11 |
| 5 | Single-instance lock → per-`OS8_HOME` everywhere via `app.setPath('userData', …)` | PR 1.2 |
| 6 | Phase 3 ordering → Developer Import (3.1) ships independently of catalog-community (3.3) | Phase 3 outline |
| 7 | Yarn berry vs yarn1 → single `package_manager: yarn`; adapter detects via `.yarnrc.yml` | PR 1.11 |
| 8 | `--ignore-scripts` policy → channel-tiered (Verified runs, Community opt-in, Developer Import always blocked) | PR 1.11 |
| 9 | Vite middleware HMR port collision → not a real conflict; external Vites bind their own HMR port | (closed; PR 1.14 smoke test validates) |
| 10 | Manifest YAML parser → `js-yaml` with `yaml.load()` | PR 1.4 |
| 11 | App routing → **subdomain mode (`<slug>.localhost:8888`) is the v1 default and only mode.** Path mode rejected for sharing one browser origin across all installed apps (architectural trust leak) and for taxing manifest authors with per-framework base-path config. Subdomain gives free SOP isolation, frameworks bind at `/`, no `--base` flag, no `next.config.js` patches. Reframes spec §11 Q3/Q4. | PR 1.13, PR 1.14, PR 1.16 (DNS pre-flight); spec §1, §6.2.3, §6.3.2, §6.4, §6.6, §7 Q3, §10 |
| 12 | **Two paths to per-app blob storage** — clarified, not changed: (a) OS-process filesystem I/O via `{{BLOB_DIR}}` / `OS8_BLOB_DIR` (granted by `permissions.filesystem: app-private`; the right path for backends like ComfyUI redirected via `--output-directory`), and (b) browser HTTP API surface via `window.os8.blob.*` → `<slug>.localhost:8888/_os8/api/blob/*` (granted by `permissions.os8_capabilities: blob.*`; the right path for *frontend* JS). A manifest may use one, the other, both, or neither. Catalog reviewers cross-check (a) against backend fs APIs and (b) against frontend `window.os8.*` calls — they are different review axes. | spec §3.2 ("Two paths to per-app data"), §3.4 (`permissions.filesystem` + `permissions.os8_capabilities`), §6.2.5 (LLM review criteria); phase-2-plan PR 2.4 (ComfyUI manifest demonstrates path (a) only) |

If new genuinely-open questions surface during implementation, append them below as `### N+1 — short title` with options + recommendation. Don't recycle this section as a TODO list; it's a record of settled decisions.

---

## 11. Deferred items

A separate running list tracks items explicitly deferred during App Store work — small gaps, contingent migrations, optional polish, and intentional v1 exclusions kept on the radar.

See **[app-store-deferred-items.md](./app-store-deferred-items.md)**.

**Process:** before kicking off each new phase, scan the deferred-items doc and decide whether any items belong in that phase's scope. The list is not Phase 4 scope by default — phase scope is set by this master plan + the spec. The deferred list is a parking lot, not a backlog.

*End of plan.*
