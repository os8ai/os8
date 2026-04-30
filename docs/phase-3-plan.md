# OS8 App Store — Phase 3 Implementation Plan

**Companions:** [`app-store-spec.md`](./app-store-spec.md) (Draft v2), [`app-store-plan.md`](./app-store-plan.md), [`phase-0-plan.md`](./phase-0-plan.md), [`phase-1-plan.md`](./phase-1-plan.md), [`phase-2-plan.md`](./phase-2-plan.md).
**Audience:** Engineers implementing PRs 3.1 – 3.6 in `/home/leo/Claude/os8/`, `/home/leo/Claude/os8dotai/`, and the new `os8ai/os8-catalog-community` repo.
**This document:** the concrete contract for each Phase 3 PR — files, splice points, signatures, schema additions, API contracts, test fixtures, acceptance criteria, cross-platform notes, and deviations. Reference the spec and prior phase plans for *why*; this file is *how*.

---

## 1. Scope, ordering, inheritance

Phase 3 ships **three independent tracks** that together "open the floodgates" on what users can install: anyone can publish (community catalog), anyone can import an arbitrary GitHub repo (developer-import), and the security review now leans on a real supply-chain analyzer (osv-scanner / safety) instead of a hand-curated typosquat list.

| PR | Work unit | Surface | Track | Gate? |
|---|---|---|---|---|
| 3.1 | Developer Import flow — paste GitHub URL → auto-generate draft AppSpec | OS8 | A | — |
| 3.2 | High-friction install plan UI for `developer-import` channel | OS8 | A | — |
| 3.3 | `os8ai/os8-catalog-community` repo + lightweight CI | Catalog (new) | B | — |
| 3.4 | Community channel on os8.ai (`/apps?channel=community`) + dual-channel sync | os8.ai | B | — |
| 3.5 | OS8 settings: per-channel enable/disable | OS8 | B | — |
| 3.6 | Supply-chain analyzer (`osv-scanner` + `safety`) wired into `AppReviewService` | OS8 | C | — |

### Ordering (resolves plan §6 Phase 3 outline)

- **Track A (Developer Import) ships independently of Track B.** A draft manifest produced by 3.1 stays desktop-local and never round-trips through os8.ai. Sharing happens via git URL passing initially.
- **Track B (Community channel) unblocks itself in dependency order:** 3.3 (repo + CI) → 3.4 (os8.ai sync + UI) → 3.5 (desktop opt-in toggle).
- **Track C (3.6) is independent of A and B** and can land first, last, or in parallel. PR 2.1 left `KNOWN_MALICIOUS_PYTHON` and `scanPythonDeps` (in [`src/services/app-review.js:105-185`](../src/services/app-review.js#L105)) as a deliberate stub awaiting this PR.

There is **no Phase 3 gate**. Phase 1 gated on Vite HMR through the proxy (PR 1.14); Phase 2 gated on Streamlit WS through the proxy (PR 2.2). Phase 3 reuses both primitives unchanged — no new architectural claim demands a smoke test.

### Test matrix

Per master plan §10 decision 12: **macOS + Linux are blocking for Phase 3 release; Windows is best-effort.** Concretely:

- PR 3.1 / 3.2 / 3.5 / 3.6 unit + integration tests run on the existing CI matrix (`macos-14`, `ubuntu-22.04`).
- PR 3.3's CI lives in the new catalog repo on `ubuntu-22.04` only (CI tooling, not a runtime concern).
- PR 3.4's tests run on the os8.ai Vercel preview pipeline (Linux containers).
- PR 3.6's `osv-scanner` integration test gates on the binary being available; CI installs it on macos + ubuntu but skips on windows-2022 (informational).

### Inheritance — what Phase 3 does **not** re-spec

Phase 3 PRs are additive on top of Phases 0–2. **Do not re-spec these.** Phase 3 PR descriptions cite the prior contract by file path and section.

| Inherited primitive | Phase | File on disk |
|---|---|---|
| `RuntimeAdapter` interface (`ensureAvailable`, `detectPackageManager`, `install`, `start`, `stop`, `watchFiles`, `detectVersion`) | 1.11 | `src/services/runtime-adapters/{index,node,python,static}.js` |
| `AppInstaller` orchestrator + state machine (`pending → cloning → reviewing → awaiting_approval → installing → installed`) and `_installPostApproval` seam | 1.5 / 1.16 | `src/services/app-installer.js`, `src/services/app-install-jobs.js` |
| `AppReviewService.review` 3-phase pipeline (blocking static checks → advisory static analysis → LLM review) | 1.6 | `src/services/app-review.js` |
| `AppCatalogService.sync` (channel-keyed, idempotent, soft-delete) | 1.3 | `src/services/app-catalog.js` |
| Manifest validator + `appspec-v1.json` JSON Schema (`review.channel: developer-import` already in the enum) | 1.4 | `src/services/manifest-validator.js`, `src/data/appspec-v1.json:197` |
| `appspec-v2.json` schema (docker runtime; `allOf` extends v1) | 2.5 | `src/data/appspec-v2.json` |
| Channel-tiered `--ignore-scripts` policy: verified runs scripts, community opts in via `allow_package_scripts`, developer-import always blocked | 1.11 | `src/services/runtime-adapters/node.js:129-135` |
| Install plan modal + gate (`gateEvaluation`) and SSE log relay | 1.17 | `src/renderer/install-plan-modal.js` |
| Hardened BrowserView for external apps + scoped `_os8/api/*` middleware + `window.os8` SDK preload | 1.7 / 1.9 / 1.19 | `src/services/{scoped-api-surface,preview}.js`, `src/preload-external-app.js` |
| Catalog daily sync scheduler (4am local) | 1.3 | `src/server.js:236-264` |
| os8.ai `App` / `PendingInstall` / `CatalogState` Prisma models with per-channel `CatalogState` keyed by `channel` | 0.7 | `prisma/schema.prisma` |
| os8.ai catalog sync (HMAC webhook + Vercel Cron, GitHub Trees API → Prisma upsert with tag-to-SHA resolution and asset-URL pinning) | 0.8 | `src/lib/catalog-sync.ts`, `src/app/api/internal/catalog/sync/route.ts` |
| `/apps` browse page (ISR 60s, AppGrid + minisearch client filter) | 0.9 | `src/app/apps/page.tsx`, `AppGrid.tsx` |

When PR 3.x text says "extend `AppReviewService._runStaticAnalysis`" it means **the same method PR 1.6 ships in `app-review.js:409-486`** — see phase-1-plan PR 1.6 for context.

---

## 2. Audit findings (Phase 3-relevant)

Verified against the working tree of `/home/leo/Claude/os8/` and `/home/leo/Claude/os8dotai/` at audit time. Phases 0, 1, and Phase 2 PRs 2.1 + 2.2 are merged; Phase 2 PRs 2.3 / 2.4 / 2.5 are not yet merged at audit time but their interfaces do not block Phase 3 (see "Inheritance" above; the runtime-adapters directory and `appspec-v2.json` schema dispatch are touched only by PR 3.1's dev-import adapter and PR 3.6's analyzer extension, both of which work with whatever set is present).

| Phase 3 dependency | Code reality at audit | Implication |
|---|---|---|
| `review.channel: 'developer-import'` already in JSON Schema enum | ✓ — [`src/data/appspec-v1.json:197`](../src/data/appspec-v1.json#L197) lists `["verified", "community", "developer-import"]`. | **PR 3.1 emits manifests with `channel: developer-import` directly** — no schema change needed for the enum value itself. |
| Channel-tiered scripts policy is already wired | ✓ — [`src/services/runtime-adapters/node.js:129-135`](../src/services/runtime-adapters/node.js#L129): `verified` runs scripts; `community` runs scripts only when `allow_package_scripts: true`; everything else (including `developer-import`) gets `--ignore-scripts`. | **PR 3.1 inherits the policy for free** — Developer-Imported apps automatically pass `--ignore-scripts` because they're not in the verified branch. No code change. |
| `AppCatalogService.sync` accepts an arbitrary `channel` argument | ✓ — [`src/services/app-catalog.js:153`](../src/services/app-catalog.js#L153) — `sync(db, { channel = 'verified', ... })` takes channel as a string and writes it into `app_catalog.channel`. | **PR 3.4 + 3.5 add a community-channel sync invocation** alongside the existing verified one; no service-level work needed. |
| os8.ai `CatalogState` is keyed by channel | ✓ — `prisma/schema.prisma:99-103` declares `channel String @unique` and `id String @id`; existing code uses `id = "verified-singleton"` as the singleton id (`catalog-sync.ts:127`). | **PR 3.4 introduces a second singleton row** keyed by `id = "community-singleton"` and `channel = "community"`. |
| os8.ai catalog-sync hardcodes `CATALOG_REPO` and `CATALOG_CHANNEL` to verified | ✓ — [`os8dotai/src/lib/catalog-sync.ts:43`](../../os8dotai/src/lib/catalog-sync.ts#L43) — `const CATALOG_REPO = process.env.CATALOG_REPO ?? "os8ai/os8-catalog";` and `CATALOG_CHANNEL` is implicit (used at lines 392, 408, 414). | **PR 3.4 parameterizes both** by accepting `channel` in the sync invocation, and dispatches to one of two repos based on channel. |
| `/apps` page hard-pins `channel: "verified"` | ✓ — [`os8dotai/src/app/apps/page.tsx:34`](../../os8dotai/src/app/apps/page.tsx#L34) — `channel: "verified"` hardcoded in the `prisma.app.findMany` filter. | **PR 3.4 reads `?channel=` from search params** and defaults to `verified`; AppGrid gains a channel filter pill. |
| `AppGrid.tsx` has framework + category filters but no channel filter | At audit, `AppGrid.tsx` accepts `categories` and `frameworks` props derived from the apps list (page.tsx:54-57). | PR 3.4 adds `channels` and a third filter pill that respects `?channel=` deep-linking. |
| `AppReviewService._runStaticAnalysis` runs `npm audit` for Node and `scanPythonDeps` (typosquat-list stub) for Python | ✓ — [`src/services/app-review.js:409-486`](../src/services/app-review.js#L409). The Python branch is a hand-curated 12-entry typosquat list; the comment at line 102 explicitly cites Phase 3 PR 3.6 as the replacement. | **PR 3.6 replaces `scanPythonDeps`** with calls to `osv-scanner` (when binary is on PATH) and `safety` (when present), keeping the typosquat list as a fallback when neither tool is available. |
| `app-install-jobs` row schema accepts arbitrary channel string | ✓ — [`src/services/app-install-jobs.js:20-29`](../src/services/app-install-jobs.js#L20) — `channel TEXT NOT NULL` from migration `0.5.0-app-store.js`, no enum CHECK. | **PR 3.1 writes `channel: 'developer-import'` rows** without a schema change. |
| `AppInstaller.start` requires the slug to be in `app_catalog` first | ✓ — [`app-installer.js:160-164`](../src/services/app-installer.js#L160) — `_run` calls `AppCatalogService.get(db, slug)` and throws if missing. | **PR 3.1 does NOT route Developer Import through `AppInstaller.start`.** It uses a sibling entry point (`AppInstaller.startFromManifest`) that takes the manifest object directly and skips the catalog lookup. Detail in PR 3.1 below. |
| Existing IPC channel namespace `app-store:*` | ✓ — `src/ipc/app-store.js` registers `app-store:validate-manifest`, `app-store:render-plan`, `app-store:install`, `app-store:approve`, `app-store:cancel`, `app-store:get-job`, `app-store:get-manifest-for-preload`, plus the `app-store:job-update` event relay. | **PR 3.1 adds two new channels** under the same namespace: `app-store:dev-import-draft` (auto-generate AppSpec from a URL) and `app-store:install-from-manifest` (launch install with an inline manifest, no catalog row). |
| Settings UI structure | [`src/renderer/settings.js`](../src/renderer/settings.js) — 1240 lines, sectional (`switchSettingsSection(sectionId)` at line 18). Existing sections include `user`, `time`, `ai-models`, `voice`, `privacy`. No `app-store` section. | **PR 3.5 adds an `app-store` section** with channel toggles + idle-timeout slider (latter is already wired in PR 1.22; PR 3.5 just colocates). |
| `os8.skills` settings precedent for per-source toggles | The skills/MCP catalogs already have a "skill catalog enable/disable" pattern; `SettingsService.get/set(db, key)` is the durable storage. | PR 3.5 stores per-channel enables under keys `app_store.channel.verified.enabled` (default true), `app_store.channel.community.enabled` (default false). |
| GitHub API access from desktop | The desktop already calls `https://api.github.com/repos/{owner}/{repo}/...` from os8.ai's catalog-sync; no analogue exists in the desktop. | **PR 3.1 introduces a small GitHub helper** at `src/services/github-importer.js` that calls the public GitHub API with optional `GITHUB_TOKEN` env var (rate-limit headroom for power users). All calls are best-effort and degrade gracefully. |
| `osv-scanner` + `safety` binaries | Neither is bundled with OS8. `osv-scanner` is a single Go binary distributed by Google; `safety` is a Python pip package (≥3.0.0 dropped Pipfile-only support). | **PR 3.6 detects both as optional**, surfaces an `info` finding when neither is available, and uses the typosquat-list stub as a permanent fallback (the stub is no worse than what we ship today). |

**Net assessment.** Phase 3 is the lowest-risk phase of the four. Every load-bearing primitive (state machine, review pipeline, catalog sync, channel tiering, hardened launch path) already exists and is parameterized correctly. The work is wiring + UX surfaces:

- **Track A (Developer Import)** introduces one new entry point on `AppInstaller` (manifest-direct, bypassing catalog) and one renderer-driven flow (paste-URL → preview manifest → existing install plan modal). Trust posture is enforced by the existing `developer-import` branch in the scripts policy + a stricter modal gate.
- **Track B (Community)** is a near-clone of the verified-channel pipeline, parameterized by `channel`. The catalog repo, the os8.ai sync invocation, and the desktop sync timer all gain a second invocation path. UI gets one filter pill and one settings toggle.
- **Track C (Supply-chain analyzer)** swaps a 12-entry static list for a process-spawn-and-parse against two well-documented tools. The interface stays identical from `_run`'s perspective: `findings[]` shape unchanged.

---

## 3. Cross-PR dependencies

```
Phase 1 + Phase 2 chain (must complete first; Phase 3 inherits):
  1.4   manifest-validator + appspec-v1.json
  1.6   AppReviewService 3-phase pipeline
  1.16  install pipeline glue with _installPostApproval seam
  1.17  install plan modal with gate evaluation
  2.1   PythonRuntimeAdapter (extends app-review's _runStaticAnalysis)
  (2.5  appspec-v2 schema dispatch — only matters for PR 3.6 if v2 manifests need analyzer)

Phase 3:
  Track A (Developer Import — desktop-local, can ship first):
    3.1 (paste-URL → draft AppSpec + AppInstaller.startFromManifest) ──> 3.2
    3.2 (high-friction modal styling for developer-import channel)

  Track B (Community catalog — three-step rollout):
    3.3 (catalog repo + lightweight CI) ──> 3.4
    3.4 (os8.ai dual-channel sync + /apps?channel filter) ──> 3.5
    3.5 (desktop per-channel enable + community sync timer wiring)

  Track C (Supply-chain analyzer — independent):
    3.6 (osv-scanner + safety integration in app-review.js)
```

**Critical path within Phase 3** (longest chain): 3.3 → 3.4 → 3.5. Tracks A and C run in parallel.

---

## PR 3.1 — Developer Import flow

**Goal.** Let a user paste a GitHub URL into OS8 and end up at the install plan modal for that repo, with a draft AppSpec auto-generated by static-analyzing the upstream files. The user reviews + edits permissions/secrets in the modal, then approves like any other channel — but the run is `channel: developer-import`, which makes the modal stricter (PR 3.2) and forces `--ignore-scripts` (already wired in PR 1.11). The manifest is **not** uploaded anywhere; it lives only on this user's machine. Sharing happens via passing the GitHub URL.

### Files

- **Create:** `/home/leo/Claude/os8/src/services/github-importer.js` — GitHub repo-metadata fetcher; framework + runtime detection from `package.json` / `pyproject.toml` / `Dockerfile`
- **Create:** `/home/leo/Claude/os8/src/services/dev-import-drafter.js` — produces a draft AppSpec object from importer output
- **Modify:** `/home/leo/Claude/os8/src/services/app-installer.js` — add `AppInstaller.startFromManifest(db, { manifest, secrets, source })` entry point that bypasses the `AppCatalogService.get` lookup (currently at [`app-installer.js:161-172`](../src/services/app-installer.js#L161))
- **Modify:** `/home/leo/Claude/os8/src/ipc/app-store.js` — register `app-store:dev-import-draft` and `app-store:install-from-manifest` handlers
- **Modify:** `/home/leo/Claude/os8/preload.js` — expose `window.os8.appStore.devImportDraft(url)` and `window.os8.appStore.installFromManifest(manifest, source)`
- **Create:** `/home/leo/Claude/os8/src/renderer/dev-import-dialog.js` — paste-URL dialog → spinner → opens existing install plan modal in `from-manifest` mode
- **Modify:** `/home/leo/Claude/os8/src/renderer/install-plan-modal.js` — extend `openInstallPlanModalFromYaml` to also accept a `manifest` object directly (avoid YAML round-trip when the manifest came from `dev-import-drafter`)
- **Modify:** `/home/leo/Claude/os8/src/renderer/apps.js` — add a "+ Import from GitHub…" affordance (right-click on app grid background, or a button under the existing "+ New App" tile)

### `github-importer.js` — fetching repo metadata

```js
// /home/leo/Claude/os8/src/services/github-importer.js
const fetch = global.fetch;

const GITHUB_API_BASE = 'https://api.github.com';
const ACCEPT_RAW = 'application/vnd.github.raw+json';
const ACCEPT_JSON = 'application/vnd.github+json';

function ghHeaders() {
  const h = { 'Accept': ACCEPT_JSON, 'X-GitHub-Api-Version': '2022-11-28' };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

function parseGithubUrl(url) {
  // Accept: https://github.com/<owner>/<repo>(.git)?(/tree/<ref>)?
  // Reject: anything else (gist, gitlab, ssh URLs, raw paths).
  const m = String(url || '').match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+))?\/?$/
  );
  if (!m) throw new Error(`unsupported URL: ${url} (only https://github.com/<owner>/<repo> works)`);
  return { owner: m[1], repo: m[2], ref: m[3] || null };
}

async function getRepoMeta({ owner, repo }) {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}`;
  const r = await fetch(url, { headers: ghHeaders(), signal: AbortSignal.timeout(15_000) });
  if (r.status === 404) throw new Error(`repo not found: ${owner}/${repo}`);
  if (!r.ok) throw new Error(`github returned ${r.status} for ${owner}/${repo}`);
  return r.json();
}

async function resolveRef({ owner, repo, ref }) {
  // Prefer the latest release tag → SHA. Fall back to default branch HEAD.
  if (ref && /^[0-9a-f]{40}$/.test(ref)) return { ref, sha: ref, kind: 'sha' };

  if (!ref) {
    // Try latest release.
    try {
      const rel = await fetch(
        `${GITHUB_API_BASE}/repos/${owner}/${repo}/releases/latest`,
        { headers: ghHeaders(), signal: AbortSignal.timeout(10_000) }
      );
      if (rel.ok) {
        const j = await rel.json();
        if (j.tag_name) ref = j.tag_name;
      }
    } catch (_) { /* fall through */ }
  }

  if (!ref) {
    // Use default branch HEAD.
    const meta = await getRepoMeta({ owner, repo });
    ref = meta.default_branch;
  }

  // Resolve to immutable SHA via /git/refs/{tags|heads}/<ref>.
  for (const refType of ['tags', 'heads']) {
    const r = await fetch(
      `${GITHUB_API_BASE}/repos/${owner}/${repo}/git/refs/${refType}/${encodeURIComponent(ref)}`,
      { headers: ghHeaders(), signal: AbortSignal.timeout(10_000) }
    );
    if (r.ok) {
      const j = await r.json();
      const sha = j?.object?.sha;
      if (sha && /^[0-9a-f]{40}$/.test(sha)) {
        return { ref, sha, kind: refType === 'tags' ? 'tag' : 'branch' };
      }
    }
  }
  throw new Error(`could not resolve ref '${ref}' to a 40-char SHA`);
}

async function fetchRawFile({ owner, repo, sha, path }) {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${sha}`;
  const r = await fetch(url, { headers: { ...ghHeaders(), 'Accept': ACCEPT_RAW }, signal: AbortSignal.timeout(10_000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`github raw fetch ${path}: ${r.status}`);
  return r.text();
}

async function listTopLevel({ owner, repo, sha }) {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/git/trees/${sha}`;
  const r = await fetch(url, { headers: ghHeaders(), signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`github tree ${sha}: ${r.status}`);
  const j = await r.json();
  return Array.isArray(j.tree) ? j.tree.map(t => t.path) : [];
}

module.exports = { parseGithubUrl, getRepoMeta, resolveRef, fetchRawFile, listTopLevel };
```

**Rate-limit posture.** Anonymous calls to the GitHub API get 60/hour per IP. A single Developer Import touches 5 endpoints (`/repos`, `/releases/latest`, `/git/refs`, `/contents/<key>` × N where N ≤ 4). For users without `GITHUB_TOKEN`, that's ~12 imports per hour — comfortably more than anyone will do. The error path on 403 surfaces a clear "GitHub rate-limited; set `GITHUB_TOKEN` for headroom" message.

### `dev-import-drafter.js` — manifest synthesis

```js
// /home/leo/Claude/os8/src/services/dev-import-drafter.js
const Importer = require('./github-importer');

const FRAMEWORK_HINTS = {
  vite:       { deps: ['vite'],          scripts: ['dev', 'preview'] },
  nextjs:     { deps: ['next'],          scripts: ['dev', 'next dev'] },
  sveltekit:  { deps: ['@sveltejs/kit'], scripts: ['dev'] },
  astro:      { deps: ['astro'],         scripts: ['dev'] },
  streamlit:  { pyDeps: ['streamlit'] },
  gradio:     { pyDeps: ['gradio'] },
  hugo:       { files: ['hugo.toml', 'hugo.yaml', 'config.toml'] },
  jekyll:     { files: ['_config.yml', 'Gemfile'] },
};

function detectFramework({ pkg, pyproject, requirementsTxt, topLevel }) {
  const npmDeps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  for (const [fw, hint] of Object.entries(FRAMEWORK_HINTS)) {
    if (hint.deps?.some(d => d in npmDeps)) return fw;
    if (hint.pyDeps?.some(d => {
      const t = requirementsTxt || '';
      const ppt = pyproject || '';
      return t.toLowerCase().includes(d) || ppt.toLowerCase().includes(d);
    })) return fw;
    if (hint.files?.some(f => topLevel.includes(f))) return fw;
  }
  return 'none';
}

function detectRuntime({ pkg, pyproject, requirementsTxt, topLevel }) {
  // Dockerfile-only repos: NOT supported in v1 Developer Import. The v2 schema
  // (PR 2.5) requires image + image_digest + internal_port — fields a Dockerfile
  // alone doesn't provide. Building locally is also out of scope (would require
  // `docker build` orchestration, not just `docker pull`). Reject with a clear
  // pointer to alternative paths.
  if (topLevel.includes('Dockerfile') && !pkg && !pyproject && !requirementsTxt) {
    throw new Error(
      'Dockerfile-only repos are not supported in v1 Developer Import. ' +
      'Either: (1) install via the Community channel after a manifest is contributed, ' +
      'or (2) request the upstream publish a pinned image to ghcr.io / Docker Hub.'
    );
  }
  if (pkg) {
    const node = pkg.engines?.node?.match(/(\d+)/)?.[1] || '20';
    return { kind: 'node', version: node, schemaVersion: 1 };
  }
  if (pyproject || requirementsTxt) {
    return { kind: 'python', version: '3.12', schemaVersion: 1 };
  }
  if (topLevel.some(f => /\.(html?|md)$/i.test(f))) {
    return { kind: 'static', version: '0', schemaVersion: 1 };
  }
  throw new Error('could not detect runtime — repo has no package.json, pyproject.toml, requirements.txt, or HTML files');
}

function detectPackageManager({ topLevel, runtimeKind }) {
  // Match the runtime adapter's lockfile precedence (PR 1.11 + 2.1).
  if (runtimeKind === 'node') {
    if (topLevel.includes('pnpm-lock.yaml')) return 'pnpm';
    if (topLevel.includes('yarn.lock'))      return 'yarn';
    if (topLevel.includes('bun.lockb') || topLevel.includes('bun.lock')) return 'bun';
    return 'npm';
  }
  if (runtimeKind === 'python') {
    if (topLevel.includes('uv.lock'))     return 'uv';
    if (topLevel.includes('poetry.lock')) return 'poetry';
    return 'pip';
  }
  return 'auto';
}

function defaultStartArgv(framework, runtimeKind, pkg) {
  // Lift framework defaults from PR 1.11 / 2.2 / 2.3. The runtime adapter
  // re-applies them at start time; surfacing them in the draft manifest
  // makes the install-plan modal show what will run.
  switch (framework) {
    case 'vite':      return ['npm', 'run', 'dev', '--', '--port', '{{PORT}}', '--host', '127.0.0.1'];
    case 'nextjs':    return ['npm', 'run', 'dev', '--', '--port', '{{PORT}}', '--hostname', '127.0.0.1'];
    case 'sveltekit': return ['npm', 'run', 'dev', '--', '--port', '{{PORT}}', '--host', '127.0.0.1'];
    case 'astro':     return ['npm', 'run', 'dev', '--', '--port', '{{PORT}}', '--host', '127.0.0.1'];
    case 'streamlit': return ['streamlit', 'run', 'app.py',
                              '--server.port={{PORT}}', '--server.address=127.0.0.1',
                              '--server.enableCORS=false', '--server.enableXsrfProtection=false',
                              '--server.headless=true', '--browser.gatherUsageStats=false'];
    case 'gradio':    return ['python', 'app.py'];
    case 'hugo':      return ['hugo', 'serve', '--port', '{{PORT}}', '--bind', '127.0.0.1'];
    case 'jekyll':    return ['bundle', 'exec', 'jekyll', 'serve', '--port', '{{PORT}}', '--host', '127.0.0.1'];
    default:
      if (runtimeKind === 'static') return ['os8:static', '--dir', '.'];
      // node + no recognized framework: prefer a real script the repo declares
      // over a guess. The user's review surfaces the actual argv before install.
      if (runtimeKind === 'node' && pkg?.scripts) {
        for (const candidate of ['dev', 'start', 'serve']) {
          if (pkg.scripts[candidate]) return ['npm', 'run', candidate];
        }
      }
      return ['npm', 'run', 'dev'];   // best-effort generic; review pipeline will flag if missing
  }
}

async function draft(url) {
  const parsed = Importer.parseGithubUrl(url);
  const meta = await Importer.getRepoMeta(parsed);
  const refResolution = await Importer.resolveRef({ ...parsed, ref: parsed.ref });
  const topLevel = await Importer.listTopLevel({ ...parsed, sha: refResolution.sha });

  const [pkgRaw, pyprojectRaw, requirementsRaw, _readme] = await Promise.all([
    Importer.fetchRawFile({ ...parsed, sha: refResolution.sha, path: 'package.json' }),
    Importer.fetchRawFile({ ...parsed, sha: refResolution.sha, path: 'pyproject.toml' }),
    Importer.fetchRawFile({ ...parsed, sha: refResolution.sha, path: 'requirements.txt' }),
    Importer.fetchRawFile({ ...parsed, sha: refResolution.sha, path: 'README.md' }),
  ]);
  let pkg = null;
  try { pkg = pkgRaw ? JSON.parse(pkgRaw) : null; } catch (_) { /* malformed */ }

  const runtime = detectRuntime({ pkg, pyproject: pyprojectRaw, requirementsTxt: requirementsRaw, topLevel });
  const framework = detectFramework({ pkg, pyproject: pyprojectRaw, requirementsTxt: requirementsRaw, topLevel });
  const pm = detectPackageManager({ topLevel, runtimeKind: runtime.kind });

  const slug = `${parsed.owner.toLowerCase()}-${parsed.repo.toLowerCase()}`
    .replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

  const manifest = {
    schemaVersion: runtime.schemaVersion,
    slug,
    name: pkg?.name || parsed.repo,
    publisher: parsed.owner,
    description: pkg?.description || meta.description || `Imported from ${parsed.owner}/${parsed.repo}`,
    upstream: { git: meta.clone_url, ref: refResolution.ref },
    framework,
    runtime: {
      kind: runtime.kind,
      version: runtime.version,
      arch: ['arm64', 'x86_64'],
      package_manager: pm,
      dependency_strategy: 'best-effort',
    },
    install: runtime.kind === 'node' ? [{ argv: ['npm', 'install', '--ignore-scripts'] }] : [],
    start: {
      argv: defaultStartArgv(framework, runtime.kind, pkg),
      port: 'detect',
      readiness: { type: 'http', path: '/', timeout_seconds: 60 },
    },
    surface: { kind: 'web', preview_name: pkg?.name || parsed.repo },
    permissions: {
      network: { outbound: false, inbound: false },   // user opts in per-permission in PR 3.2
      filesystem: 'app-private',
      os8_capabilities: [],
      secrets: [],
    },
    legal: {
      license: meta.license?.spdx_id || 'UNKNOWN',
      commercial_use: 'restricted',
      notes: 'Auto-generated from upstream LICENSE; review before commercial use.',
    },
    review: {
      channel: 'developer-import',
      reviewed_at: new Date().toISOString().slice(0, 10),
      reviewer: 'self',
      risk: 'high',     // default high; review pipeline can downgrade
    },
  };

  return {
    manifest,
    upstreamResolvedCommit: refResolution.sha,
    importMeta: {
      owner: parsed.owner,
      repo: parsed.repo,
      refKind: refResolution.kind,
      refLabel: refResolution.ref,
      stars: meta.stargazers_count,
      defaultBranch: meta.default_branch,
      hasDockerfile: topLevel.includes('Dockerfile'),
    },
  };
}

module.exports = { draft, detectFramework, detectRuntime, detectPackageManager };
```

**Heuristics intentionally conservative.** The drafter sets:
- `permissions.network.outbound: false` (the LLM review will surface outbound URLs in source, and the user opts in per-call in PR 3.2's modal).
- `permissions.os8_capabilities: []` (user adds capabilities only if they want the app to call `window.os8.*`; defaults to none).
- `dependency_strategy: best-effort` (Verified-channel manifests require `frozen` + lockfile; Developer Import doesn't gate on lockfile presence — see manifest-validator change below).
- `review.risk: 'high'` (defaults to most cautious; the actual review pipeline computes the real risk and may downgrade).

### `AppInstaller.startFromManifest` — bypass catalog lookup

```js
// /home/leo/Claude/os8/src/services/app-installer.js — addition
AppInstaller.startFromManifest = async function(db, { manifest, upstreamResolvedCommit, secrets = {}, source = 'dev-import' }) {
  if (manifest?.review?.channel !== 'developer-import') {
    throw new Error('startFromManifest is only valid for developer-import channel');
  }
  if (!/^[0-9a-f]{40}$/.test(upstreamResolvedCommit || '')) {
    throw new Error('upstreamResolvedCommit must be a 40-char SHA');
  }

  // Persist a synthetic app_catalog row for the duration of the install. We
  // need this because _run() looks the manifest up in app_catalog at line 161.
  // The row is keyed by slug + channel='developer-import' so it doesn't
  // collide with any real catalog row, and is soft-deleted on completion.
  const yaml = require('js-yaml');
  const crypto = require('crypto');
  const manifestYaml = yaml.dump(manifest);
  const manifestSha = crypto.createHash('sha256').update(manifestYaml).digest('hex');

  db.prepare(`
    INSERT INTO app_catalog (
      id, slug, name, description, publisher, channel, category, icon_url,
      screenshots, manifest_yaml, manifest_sha, catalog_commit_sha,
      upstream_declared_ref, upstream_resolved_commit, license, runtime_kind,
      framework, architectures, risk_level, install_count, rating,
      synced_at, deleted_at
    ) VALUES (
      ?, ?, ?, ?, ?, 'developer-import', ?, NULL,
      '[]', ?, ?, 'dev-import',
      ?, ?, ?, ?,
      ?, '["arm64","x86_64"]', 'high', 0, NULL,
      datetime('now'), NULL
    )
    ON CONFLICT(slug) DO UPDATE SET
      manifest_yaml = excluded.manifest_yaml,
      manifest_sha = excluded.manifest_sha,
      upstream_resolved_commit = excluded.upstream_resolved_commit,
      synced_at = excluded.synced_at,
      deleted_at = NULL
  `).run(
    `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    manifest.slug, manifest.name, manifest.description, manifest.publisher,
    manifest.category || 'utilities',
    manifestYaml, manifestSha,
    manifest.upstream.ref, upstreamResolvedCommit,
    manifest.legal?.license || 'UNKNOWN',
    manifest.runtime.kind,
    manifest.framework
  );

  return AppInstaller.start(db, {
    slug: manifest.slug,
    commit: upstreamResolvedCommit,
    channel: 'developer-import',
    secrets,
    source,
  });
};
```

**Why a synthetic catalog row, not a parallel `installFromManifest` orchestrator.** The state machine in `_run` already does everything we need (clone → review → atomic move → apps row insert). The only thing it does not handle is "no catalog row." Inserting a `developer-import` row keeps the diff minimal and means the install plan modal's progress UI works unchanged. The row is real metadata about the install — it should exist; it's just not synced from os8.ai.

**Orphan synthetic-row cleanup.** If a user starts a Developer Import and abandons before approving (closes modal, OS8 quits mid-flow, network fails), the synthetic `app_catalog` row stays. Over time these accumulate and clutter `app_catalog`. PR 3.1 extends `AppCatalogService.reapStaging` (PR 1.29) with a sibling pass that removes orphaned `channel='developer-import'` rows:

```js
// /home/leo/Claude/os8/src/services/app-catalog.js — additive helper called from reapStaging
function reapDeveloperImportOrphans(db) {
  // A dev-import catalog row is an orphan when:
  //   - no apps row references its slug as external_slug, AND
  //   - no app_install_jobs row in non-terminal status references its slug,
  //   - AND its synced_at is older than 24h (don't race in-flight imports).
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const stmt = db.prepare(`
    DELETE FROM app_catalog
    WHERE channel = 'developer-import'
      AND synced_at < ?
      AND slug NOT IN (SELECT external_slug FROM apps WHERE external_slug IS NOT NULL)
      AND slug NOT IN (
        SELECT external_slug FROM app_install_jobs
        WHERE status IN ('pending','cloning','reviewing','awaiting_approval','installing')
      )
  `);
  return stmt.run(cutoff).changes;
}
// reapStaging() return shape gains: { devImportOrphansRemoved: <int> }
```

Also: `AppInstaller._rollbackInstall` and `cancel` should call this helper for the failed/cancelled job's slug specifically, so the same-session UX feels clean (no waiting for the 24h cutoff).

### `_runApprove` change — skip `track-install` for developer-import

`app-installer.js:357` fires `https://os8.ai/api/apps/<slug>/track-install` after every install. Developer Import slugs (`koala73-worldmonitor`) don't exist in os8.ai's `App` table, so the call always 404s. Skip it:

```js
// In _runApprove, replace the existing track-install fetch:
if (entry.channel !== 'developer-import') {
  fetch(`https://os8.ai/api/apps/${encodeURIComponent(manifest.slug)}/track-install`, {
    method: 'POST',
    signal: AbortSignal.timeout(5000),
  }).catch(() => { /* best-effort */ });
}
```

This is a one-line guard. Saves 404 noise in os8.ai logs and stops a useless network call on every dev-import install.

### Manifest validator change

`manifest-validator.js:115-123` currently rejects any verified manifest without `dependency_strategy: frozen`. Developer-import manifests legitimately can't pin a lockfile (they're auto-generated from arbitrary repos), so the frozen check needs to be channel-tiered:

```js
// In validateManifest, replace the existing block:
if (manifest?.review?.channel === 'verified') {
  if (manifest?.runtime?.dependency_strategy !== 'frozen') {
    errors.push({
      kind: 'invariant',
      path: '/runtime/dependency_strategy',
      message: 'verified channel requires dependency_strategy: frozen',
    });
  }
}
// Community: warn but don't block (added in PR 3.4 — see there).
// developer-import: any value is acceptable; no check.
```

### IPC handlers

```js
// /home/leo/Claude/os8/src/ipc/app-store.js — additions
ipcMain.handle('app-store:dev-import-draft', async (_e, url) => {
  try {
    const Drafter = require('../services/dev-import-drafter');
    const result = await Drafter.draft(url);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('app-store:install-from-manifest', async (_e, { manifest, upstreamResolvedCommit, source = 'dev-import' } = {}) => {
  try {
    const job = await AppInstaller.startFromManifest(db, { manifest, upstreamResolvedCommit, source });
    return { ok: true, jobId: job.id, status: job.status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
```

### Preload bridge

```js
// /home/leo/Claude/os8/preload.js — additions in the appStore namespace
appStore: {
  // ...existing methods...
  devImportDraft: (url) => ipcRenderer.invoke('app-store:dev-import-draft', url),
  installFromManifest: (manifest, upstreamResolvedCommit, source) =>
    ipcRenderer.invoke('app-store:install-from-manifest', { manifest, upstreamResolvedCommit, source }),
}
```

### Renderer dialog

```js
// /home/leo/Claude/os8/src/renderer/dev-import-dialog.js
import { openInstallPlanModalFromManifest } from './install-plan-modal.js';

export async function openDevImportDialog() {
  const url = window.prompt(
    'Paste a public GitHub repo URL (e.g. https://github.com/owner/repo):'
  );
  if (!url) return;

  // Quick sanity-check before round-tripping.
  if (!/^https?:\/\/github\.com\/[^/]+\/[^/]+/.test(url)) {
    alert('Only public GitHub repos are supported. Paste a https://github.com/<owner>/<repo> URL.');
    return;
  }

  // Show a modal-blocking spinner. Reuses .modal-overlay primitive.
  const spinner = renderSpinner('Fetching repo metadata…');
  try {
    const r = await window.os8.appStore.devImportDraft(url);
    if (!r?.ok) throw new Error(r?.error || 'unknown error');
    spinner.close();
    await openInstallPlanModalFromManifest(r.manifest, {
      upstreamResolvedCommit: r.upstreamResolvedCommit,
      importMeta: r.importMeta,
    });
  } catch (e) {
    spinner.close();
    alert(`Could not import: ${e.message}`);
  }
}
```

### Install plan modal extension

PR 1.4's `openInstallPlanModalFromYaml` exists; PR 3.1 adds a sibling that takes the manifest object directly so the dev-import flow doesn't need to YAML-serialize and re-parse:

```js
// /home/leo/Claude/os8/src/renderer/install-plan-modal.js — addition
export async function openInstallPlanModalFromManifest(manifest, opts = {}) {
  const validation = await window.os8.appStore.validateManifest(
    /* yaml */ require('js-yaml').dump(manifest),     // re-validate via the IPC path
    { upstreamResolvedCommit: opts.upstreamResolvedCommit }
  );
  // (validation comes back with .manifest parsed; we use it directly)

  const entry = {
    slug: manifest.slug,
    name: manifest.name,
    publisher: manifest.publisher,
    channel: 'developer-import',
    iconUrl: null,
    description: manifest.description,
    license: manifest.legal?.license,
    runtimeKind: manifest.runtime?.kind,
    framework: manifest.framework,
    architectures: manifest.runtime?.arch || [],
    upstreamResolvedCommit: opts.upstreamResolvedCommit || null,
    manifest,
    devImportMeta: opts.importMeta || null,
  };
  const state = startState(entry, validation.validation);
  state.devImportMode = true;       // toggles the strict gate in PR 3.2
  showModal(state);
}
```

### IPC + routes

Two new IPC channels (above). No new HTTP routes — Developer Import is desktop-local.

### Test fixtures

`tests/dev-import-drafter.test.js`:

| Fixture (mocked GitHub responses) | Assertion |
|---|---|
| `https://github.com/owner/vite-app` returning a `package.json` with `vite` in dependencies | `framework: 'vite'`; `runtime.kind: 'node'`; `start.argv` includes `--port {{PORT}}` |
| Repo with `pyproject.toml` containing `streamlit` | `framework: 'streamlit'`; `runtime.kind: 'python'`; `package_manager: 'uv'` (when `uv.lock` present) |
| Repo with only `Dockerfile` | `runtime.kind: 'docker'`; `schemaVersion: 2` |
| Repo with no recognized files (empty repo) | `Drafter.draft` throws "could not detect runtime" |
| `parseGithubUrl` with a gist URL | throws "unsupported URL" |
| `parseGithubUrl` with `https://github.com/owner/repo/tree/v1.2.3` | `ref: 'v1.2.3'` |
| `resolveRef` with a tag → SHA | resolves via `/git/refs/tags/<tag>` |
| `resolveRef` with no `ref` and a release | uses `releases/latest` then `/git/refs/tags/<tag>` |
| Anonymous GitHub call returning 403 | throws with "rate-limited; set GITHUB_TOKEN" |

`tests/app-installer.dev-import.test.js`:

| Scenario | Assertion |
|---|---|
| `startFromManifest` with a valid `developer-import` manifest | inserts into `app_catalog` with `channel='developer-import'`; returns a job in status `pending` |
| `startFromManifest` with `channel: 'verified'` | throws "only valid for developer-import channel" |
| `startFromManifest` with a non-SHA `upstreamResolvedCommit` | throws "must be a 40-char SHA" |
| Calling `_run` against a dev-import manifest | clones the repo and reaches `awaiting_approval` (review may flag high; that's the point) |

### API/IPC contracts

```
window.os8.appStore.devImportDraft(url) → {
  ok: true,
  manifest: <AppSpec>,
  upstreamResolvedCommit: <40-char SHA>,
  importMeta: { owner, repo, refKind: 'tag'|'branch'|'sha', refLabel, stars, defaultBranch, hasDockerfile }
} | { ok: false, error }

window.os8.appStore.installFromManifest(manifest, upstreamResolvedCommit, source?) → {
  ok: true, jobId, status: 'pending'
} | { ok: false, error }
```

### Acceptance criteria

- Right-click on app grid background → "Import from GitHub…" → paste `https://github.com/koala73/worldmonitor` → spinner ~2s → install plan modal opens with the auto-generated manifest filled in.
- Worldmonitor's auto-generated manifest detects `framework: vite`, `runtime.kind: node`, `package_manager: pnpm` (or whatever its lockfile is); the start argv is the Vite default with `{{PORT}}` substitution.
- Pasting an unreachable / private / 404 GitHub URL surfaces a clean "repo not found" error in the spinner.
- Approving a dev-import install causes `npm install --ignore-scripts` to run (already wired by PR 1.11; PR 3.1's role is just to ensure the channel routes through that branch).
- `apps.channel = 'developer-import'` after install; the home-screen icon shows the developer-import badge (PR 3.2 adds the badge styling).

### Cross-platform notes

- Public GitHub API is the same on every OS; no platform branching in `github-importer.js`.
- The renderer's `window.prompt(...)` is platform-styled by Chromium — adequate for v1; can be replaced with a styled modal in a follow-up if UX feedback demands.

### Spec deviations

- **`AppInstaller.startFromManifest` is a new entry point not in the spec.** Spec §6.2.1 documents `AppCatalogService.install(slug, ...)`; Developer Import is by-definition not in the catalog. Adding a sibling entry point keeps the orchestrator generic; the cost is a synthetic `app_catalog` row, justified above.
- **Manifest validator's `dependency_strategy: frozen` check is now channel-tiered** (was: applied to every manifest). Verified-channel behavior is unchanged.
- **Drafter sets `dependency_strategy: 'best-effort'`** which is currently rejected for Verified channel by `manifest-validator.js:115-123`. The change above makes it pass for `developer-import`. The existing `appspec-v1.json` enum already includes `best-effort` (line 64).

### Depends on

PR 1.4 (manifest validator), PR 1.6 (review service), PR 1.16 (install pipeline glue), PR 1.17 (install plan modal). Independent of Phase 2.

### Open sub-questions

1. **Should Developer Import rate-limit per slug?** A user could re-import the same repo many times to spam `app_catalog`. The synthetic-row insert uses `ON CONFLICT(slug) DO UPDATE` so it's idempotent, but state machine churn is real. **Recommendation:** if `app_catalog` row exists with `channel='developer-import'` for the same slug AND `apps.status='active'` AND `apps.upstream_resolved_commit` matches, skip the install with a clear "already installed (re-importing same commit)". Defer to a v3.1.1 if needed.
2. **Should we cache `getRepoMeta` responses?** A second draft of the same repo within a few minutes re-fetches everything. Disk cache at `~/os8/cache/github/<owner>-<repo>-<sha>.json` is a 30-line addition. **Recommendation:** ship without; revisit if power users complain.

---

## PR 3.2 — High-friction install plan UI for `developer-import`

**Goal.** When the install plan modal opens with a `developer-import` channel manifest, surface the additional friction the spec calls for: a "developer mode" badge, all permissions force-opt-in (each capability/network setting toggles individually), an extra "This app has not been reviewed by OS8 curators" warning, an explicit "I understand the risks" checkbox to enable the Install button. The strict gate stacks on top of PR 1.17's existing gate (arch + secrets + critical findings).

### Files

- **Modify:** `/home/leo/Claude/os8/src/renderer/install-plan-modal.js` — extend `gateEvaluation`, `renderPermissions`, `renderEntry`; add `renderDevImportWarnings(state)`
- **Modify:** `/home/leo/Claude/os8/styles/components.css` (or `styles/modals.css`) — add `.install-plan-modal__channel-badge--developer-import` styling (already referenced at [`install-plan-modal.js:233`](../src/renderer/install-plan-modal.js#L233) but the CSS class likely doesn't yet exist for full polish)
- **Modify:** `/home/leo/Claude/os8/src/services/app-review.js` — add a hook in `_runStaticChecks` that bumps any unfounded `permissions.network.outbound: true` declaration to `severity: 'warning'` for `developer-import` (catches the case where a user toggles outbound in the modal but the LLM review hasn't seen evidence of it)

### Per-capability opt-in UI

PR 1.17's `renderPermissions` emits a static `<ul>` listing declared capabilities. PR 3.2 replaces that with **interactive toggles when `state.devImportMode === true`**:

```js
// install-plan-modal.js — replace renderPermissions when devImportMode is true
function renderPermissions(manifest, state) {
  if (state.devImportMode) return renderPermissionsDevImport(manifest, state);
  // ...existing static rendering...
}

function renderPermissionsDevImport(manifest, state) {
  const perms = manifest?.permissions || {};
  const caps = perms.os8_capabilities || [];
  // Capability groups for scannability. Spec §6.3.2 lists 13 v1 caps; rendered
  // as a flat list they're hard to review. Group by trust axis.
  const CAP_GROUPS = [
    { label: 'Per-app storage',  caps: ['blob.readwrite', 'blob.readonly', 'db.readwrite', 'db.readonly'] },
    { label: 'Comms',            caps: ['telegram.send'] },
    { label: 'AI services',      caps: ['imagegen', 'speak', 'youtube', 'x'] },
    { label: 'Google (read-only by default)',
      caps: ['google.calendar.readonly', 'google.calendar.readwrite',
             'google.drive.readonly',    'google.gmail.readonly'] },
    // mcp.<server>.<tool> deferred — wildcard form needs its own UI; user can
    // still hand-edit the manifest's permissions.os8_capabilities if needed.
  ];

  const renderGroup = (g) => `
    <div class="install-plan-modal__perm-toggle-group">
      <strong>${escapeHtml(g.label)}</strong>
      ${g.caps.map(c => `
        <label>
          <input type="checkbox"
            data-cap-toggle="${escapeHtml(c)}"
            ${caps.includes(c) ? 'checked' : ''} />
          <code>${escapeHtml(c)}</code>
        </label>
      `).join('')}
    </div>
  `;

  return `
    <div class="install-plan-modal__perm-toggle-group">
      <label>
        <input type="checkbox"
          data-perm-toggle="network.outbound"
          ${perms.network?.outbound ? 'checked' : ''} />
        <strong>Network: outbound</strong>
        <span class="hint">Allow this app to make HTTP requests to the internet</span>
      </label>
      <label>
        <input type="checkbox"
          data-perm-toggle="network.inbound"
          ${perms.network?.inbound ? 'checked' : ''} />
        <strong style="color: var(--color-danger-text);">Network: inbound (rare)</strong>
        <span class="hint">Allow this app's dev server to be reachable beyond localhost</span>
      </label>
    </div>
    ${CAP_GROUPS.map(renderGroup).join('')}
  `;
}
```

Toggle wiring (pure renderer logic):

```js
// In wireEvents:
for (const cb of root.querySelectorAll('[data-perm-toggle]')) {
  cb.addEventListener('change', () => {
    const path = cb.dataset.permToggle.split('.');
    let target = state.entry.manifest.permissions;
    for (let i = 0; i < path.length - 1; i++) {
      target[path[i]] = target[path[i]] || {};
      target = target[path[i]];
    }
    target[path[path.length - 1]] = cb.checked;
    patchModal(state);     // re-evaluate gate, re-render
  });
}
for (const cb of root.querySelectorAll('[data-cap-toggle]')) {
  cb.addEventListener('change', () => {
    const cap = cb.dataset.capToggle;
    const list = state.entry.manifest.permissions.os8_capabilities;
    if (cb.checked && !list.includes(cap)) list.push(cap);
    if (!cb.checked) {
      const idx = list.indexOf(cap);
      if (idx >= 0) list.splice(idx, 1);
    }
    patchModal(state);
  });
}
```

When the user clicks Install, the toggled-in-place manifest is sent to `installFromManifest` — the user's choices flow through to the `app_catalog` row written by `startFromManifest`, the security review, and the running app's capability surface.

### Additional gate logic

```js
// gateEvaluation extension for devImportMode:
if (state.devImportMode) {
  if (!state.devImportRisksAcknowledged) {
    return { ok: false, reason: 'check "I understand the risks" to enable install' };
  }
}
```

The acknowledgment checkbox renders below the security review section:

```html
<label class="install-plan-modal__dev-import-ack">
  <input type="checkbox" data-action="ack-dev-import-risks" />
  I understand this app has <strong>not</strong> been reviewed by OS8 curators.
  I trust this source and accept the risks of installing it.
</label>
```

Wiring updates `state.devImportRisksAcknowledged` and re-renders.

### Modal section ordering (developer-import only)

PR 1.17's order is: Header → About → Architecture → License → Permissions → Secrets → Install commands → Security review → Logs. PR 3.2's developer-import order moves **Security review** above Permissions and adds an explicit warning block at top:

1. Header (with developer-import badge)
2. **Warning block:** "This is a Developer Import. The manifest was auto-generated from upstream files; no human curator has reviewed it. Capabilities are opt-in below."
3. About (includes git URL + commit SHA + import meta)
4. **Security review** (promoted — the user reads findings before granting permissions)
5. Permissions (per-capability toggles; off by default)
6. Secrets
7. Install commands
8. Architecture, License (collapsed by default)
9. Logs (during install)
10. Footer with Cancel + Install + acknowledgment checkbox

### Network-outbound consistency check

In `app-review.js:_runStaticChecks`, add a developer-import-only rule:

```js
// After the existing argv/lockfile/arch checks, when channel === 'developer-import':
if (channel === 'developer-import' && manifest?.permissions?.network?.outbound === true) {
  // Warn — not blocking. The LLM review (phase 3 of the pipeline) actually
  // grep-confirms outbound URLs in source; this is just the channel-level
  // posture check.
  findings.push({
    severity: 'warning', category: 'network', file: null, line: null,
    description: 'developer-import: outbound network granted; LLM review will list discovered domains',
    snippet: '',
  });
}
```

### Tests

`tests/install-plan-modal.dev-import.test.js`:

| Scenario | Assertion |
|---|---|
| Open modal with `developer-import` channel | Permissions section renders as toggles, not a static list |
| Toggle `blob.readwrite` capability | `state.entry.manifest.permissions.os8_capabilities` updates; gate re-evaluates |
| Try to install without checking ack | Install button stays disabled with reason "check I understand the risks…" |
| Toggle every capability on, ack risks | Install button enables (modulo other gates) |
| Toggle network.inbound on | Renders with the danger badge styling |

### Acceptance criteria

- A Developer-Import flow from PR 3.1 → modal opens with no capabilities pre-checked, no network access pre-checked, and the Install button reads "Check 'I understand the risks' to install" in the gate-reason area.
- After ticking each toggle the user wants and the ack checkbox, Install enables.
- Approving the install runs the same pipeline as a verified install but with `--ignore-scripts` (already wired) and the user-toggled `permissions.os8_capabilities` written to `app_catalog.manifest_yaml` and `apps.manifest_yaml`.
- The home-screen icon for a successfully installed developer-import app shows a small "DEV" badge in the corner (CSS class `app-icon__channel-badge--developer-import`; cosmetic, defined in `styles/components.css`).

### Cross-platform notes

None — all renderer-side.

### Spec deviations

- **Capability toggle UI** is more granular than spec §6.5's bullet list. The spec implies a list-of-permissions rendering; PR 3.2's interactive toggles realize the spec's intent ("Developer Import gets all permissions opt-in"). Documented as an enhancement.
- **Section reorder for developer-import** is a UI judgment call not in the spec. Brings security findings forward where they're load-bearing for the user's decision.

### Depends on

PR 3.1 (the `devImportMode` flag on state, the `installFromManifest` entry point). Independent of Tracks B and C.

### Open sub-questions

None. (MCP capability granularity — `mcp.<server>.<tool>` vs `mcp.<server>.*` — defers to plan §10 decision 5; PR 3.2 displays only the v1 fixed list.)

---

## PR 3.3 — `os8ai/os8-catalog-community` repo + lightweight CI

**Goal.** Stand up a sister repo to `os8ai/os8-catalog` for community-channel manifests. Same JSON Schema (canonical reference: catalog repo's `schema/appspec-v1.json` + `schema/appspec-v2.json`), lighter CI (no curator approval; spam/malware filter only). Manifests in this repo land in os8.ai with `channel='community'` and require explicit per-capability grant on install (the `developer-import` UI flow from PR 3.2 is reused).

### Files (in the **new catalog repo**, `os8ai/os8-catalog-community/`)

- `README.md` — what community manifests are, what gets accepted, what doesn't
- `CONTRIBUTING.md` — how to submit a manifest, what reviewers check, expected turnaround
- `apps/.gitkeep`
- `schema/appspec-v1.json` — **byte-identical copy of `os8ai/os8-catalog/schema/appspec-v1.json`** (CI verifies)
- `schema/appspec-v2.json` — same
- `.github/CODEOWNERS` — single curator pool (no per-app owners)
- `.github/workflows/validate.yml` — schema + image checks + slug uniqueness + schema-byte-match against the canonical repo
- `.github/workflows/resolve-refs.yml` — same as canonical (tag → SHA resolution; comments PR with resolved SHA)
- `.github/workflows/spam-filter.yml` — lightweight automated checks (see below)
- `.github/workflows/notify-os8ai.yml` — webhook to os8.ai community sync endpoint
- `.github/scripts/check-schema-match.js` — CI helper that fetches the canonical schema from `os8ai/os8-catalog` raw and diffs

### Schema policy

The community catalog **does not get its own schema**. It pulls the canonical `appspec-v1.json` + `appspec-v2.json` from `os8ai/os8-catalog` at every CI run and verifies the bytes match. This avoids two-track schema drift. The check-schema-match action:

```js
// .github/scripts/check-schema-match.js
const fs = require('fs');
const fetch = global.fetch;

async function fetchCanonical(file) {
  const url = `https://raw.githubusercontent.com/os8ai/os8-catalog/main/schema/${file}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
  return r.text();
}

(async () => {
  for (const file of ['appspec-v1.json', 'appspec-v2.json']) {
    const local = fs.readFileSync(`schema/${file}`, 'utf8');
    const canonical = await fetchCanonical(file);
    if (local.trim() !== canonical.trim()) {
      console.error(`schema/${file} drift from canonical os8ai/os8-catalog`);
      process.exit(1);
    }
  }
  console.log('schemas match canonical');
})();
```

### `validate.yml` — schema + image + uniqueness

Mirrors `os8ai/os8-catalog/.github/workflows/validate.yml` (PR 0.2) but with two additions:

```yaml
# .github/workflows/validate.yml — community-specific
name: validate
on:
  pull_request:
    paths:
      - 'apps/**'
      - 'schema/**'
      - '.github/scripts/**'

jobs:
  schema-match:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: node .github/scripts/check-schema-match.js

  validate-manifests:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm install --no-save ajv ajv-formats yaml js-yaml
      - run: node .github/scripts/validate-manifests.js
        env:
          # Force community-channel review on every manifest in this repo
          REQUIRE_REVIEW_CHANNEL: community

  enforce-channel:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
      - run: |
          # Every apps/<slug>/manifest.yaml must declare review.channel: community.
          # Verified manifests belong in os8ai/os8-catalog.
          for f in apps/*/manifest.yaml; do
            grep -q 'channel: community' "$f" || { echo "$f: must declare review.channel: community"; exit 1; }
          done
```

### `spam-filter.yml` — lightweight checks (no human curator gate)

```yaml
# .github/workflows/spam-filter.yml
name: spam-filter
on:
  pull_request:
    paths:
      - 'apps/**'

jobs:
  upstream-sanity:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - name: Reject blocklisted upstream domains
        run: node .github/scripts/check-upstream-domain.js
      - name: Reject suspicious slugs
        run: node .github/scripts/check-slug-blocklist.js
      - name: Repo must have ≥1 commit, ≥7 days of history
        run: node .github/scripts/check-upstream-age.js
```

The three checks (each a small script, ~30 LOC):

1. **`check-upstream-domain.js`** — refuses `upstream.git` URLs not on github.com (no GitLab / Bitbucket / arbitrary git in v1; relax later). Refuses upstream URLs that match a small blocklist of known-malicious orgs. The list is in `.github/data/blocked-orgs.txt`, empty at PR 3.3 merge; curators add entries via PR.
2. **`check-slug-blocklist.js`** — rejects slugs containing `os8`, `anthropic`, `claude`, `openai`, `google`, plus common confusables (`comfy-ui`, `comfyu1`). Prevents typosquats on first-party + popular names.
3. **`check-upstream-age.js`** — calls GitHub API for `created_at` and `pushed_at`; rejects repos created less than 7 days ago OR with zero commits. Cheap heuristic against same-day spam-PR pairs.

None of these checks block legitimate community submissions; they raise the friction for spam.

### `resolve-refs.yml` and `notify-os8ai.yml`

Identical to `os8ai/os8-catalog`'s versions (PR 0.3 + 0.8). The webhook posts to `POST https://os8.ai/api/internal/catalog/sync?channel=community` with the same HMAC-signed body. Endpoint dispatches on `channel` (PR 3.4 wires).

### CONTRIBUTING.md outline

```markdown
# Contributing to os8-catalog-community

This is the **community** catalog. Apps land in OS8 with the
"community" channel badge — users must opt into community-channel
discovery and explicitly grant each capability on install.

## What gets accepted
- Public GitHub repos with ≥7 days of history.
- Manifest follows the v1 (or v2 for docker) schema (verified by CI).
- All commands are argv arrays; no shell strings.
- Slug doesn't squat on first-party or popular names.

## What does NOT get accepted
- `runtime.kind: docker` without `image_digest` (CI rejects).
- Manifests that fail schema validation.
- Repos with `--allow-package-scripts` set unless the README explains why
  (curators flag for human review; without justification the PR is closed).
- Anything resembling a typosquat on widely-used apps (n8n, ComfyUI, Open WebUI, …).

## Review timeline
- Mechanical CI: minutes.
- Curator review: best-effort. No SLO. We don't approve every PR; rejected
  manifests can re-apply to `os8ai/os8-catalog` (verified) with the additional
  invariants that channel requires.
```

### Repo bootstrap PR sequence

The actual repo creation isn't merged via PR — it's a one-time setup. The "PR" 3.3 in this plan represents the work item, executed as:

1. Create `os8ai/os8-catalog-community` empty repo.
2. Push initial commit with files above.
3. Configure repo settings: protected `main` branch; required CI checks (validate, spam-filter, schema-match); Discussions enabled.
4. Configure CODEOWNERS pool.
5. Configure GitHub webhook → `https://os8.ai/api/internal/catalog/sync` with the **same** `CATALOG_WEBHOOK_SECRET` as the verified repo (the os8.ai endpoint dispatches on the `channel` query string param it accepts via PR 3.4 — both webhooks land in the same handler).
6. Hand-author one seed manifest in a PR to prove the pipeline works end-to-end. Suggested seed: a tiny pure-frontend Vite app the curators control, e.g. `apps/community-hello/`. (Verified-channel `worldmonitor` is not appropriate as a community seed — it stays Verified.)

### Test fixtures

- `apps/community-hello/manifest.yaml` — minimal Vite frontend, `runtime.kind: node`, `channel: community`, `dependency_strategy: strict` (community-channel default; see PR 3.4 for the validator change), `permissions: { os8_capabilities: [] }`.
- The fixture passes all four CI workflows (`validate`, `spam-filter`, `schema-match`, `resolve-refs`).

### Acceptance criteria

- The repo exists and is reachable at `https://github.com/os8ai/os8-catalog-community`.
- A PR adding `apps/community-hello/manifest.yaml` lands green on all CI workflows.
- A PR attempting to add a manifest with `review.channel: verified` fails the `enforce-channel` job.
- A PR attempting to drift `schema/appspec-v1.json` fails `schema-match`.
- A PR adding a manifest with `upstream.git` pointed at an SSH URL or a non-github.com domain fails `spam-filter`.
- Merging a manifest fires the webhook to os8.ai. (Sync side: PR 3.4.)

### Cross-platform notes

CI runs on `ubuntu-22.04` only. No platform branching needed — schema validation and spam filtering are platform-independent.

### Spec deviations

- **Schema is fetched from canonical repo, not duplicated.** Spec §4.1 implies a self-contained schema dir; we instead enforce byte-equivalence to avoid drift. Decision documented above.
- **Spam filter heuristics (7-day age, blocked domains, slug blocklist) are not in the spec.** Spec §4.3 says "lighter human review (no curator approval; spam/malware filter only)" — these three checks operationalize "spam/malware filter" without inventing new schema constraints.

### Depends on

`os8ai/os8-catalog` (Phase 0 PR 0.1) for the canonical schema. Independent of every desktop PR. Ships before PR 3.4 (which consumes the webhook).

### Open sub-questions

1. **Should community manifests require `dependency_strategy: strict`?** Verified requires `frozen` + lockfile. Strict allows lockfile drift but pins the manifest's commit. **Recommendation:** require `strict OR frozen` in CI for community channel; reject `best-effort` (which is reserved for developer-import). Encoded in PR 3.4's manifest validator change.
2. **Should community CI ban `allow_package_scripts: true`?** PR 1.11 already routes community apps with `allow_package_scripts: true` through scripts-runs; without explicit justification this is a real supply-chain vector. **Recommendation:** flag as a yellow PR comment but don't block — gives the curator the option to merge with the warning visible.

---

## PR 3.4 — Community channel on os8.ai

**Goal.** os8.ai serves both verified and community catalogs. The sync endpoint dispatches on `channel` and pulls from the right GitHub repo. The `/apps` page accepts `?channel=community` and adds a channel filter pill. Both channels are independently keyed in `CatalogState`. Existing verified-channel behavior is unchanged; verified is still the default.

### Files (in `os8dotai/`)

- **Modify:** `/home/leo/Claude/os8dotai/src/lib/catalog-sync.ts` — accept `channel` argument, dispatch `CATALOG_REPO` and `CATALOG_CHANNEL` per channel
- **Modify:** `/home/leo/Claude/os8dotai/src/app/api/internal/catalog/sync/route.ts` — read `?channel=` query string param (webhook + cron), thread through to `syncCatalog`
- **Modify:** `/home/leo/Claude/os8dotai/src/app/apps/page.tsx` — read `?channel=` from search params; query both channels when omitted (so the page shows verified + community side-by-side); pass channel options to AppGrid
- **Modify:** `/home/leo/Claude/os8dotai/src/app/apps/AppGrid.tsx` — add channel filter pill, `?channel=` deep-linking, channel badge on cards
- **Modify:** `/home/leo/Claude/os8dotai/src/app/api/apps/route.ts` — `?channel=` already works, but defaulting to `verified` should change to "all enabled channels by default" (existing behavior preserved when `?channel=` is set explicitly)
- **Modify:** `/home/leo/Claude/os8/src/services/manifest-validator.js` — community-channel `dependency_strategy` invariant (added per PR 3.3 sub-question)
- **Modify:** `/home/leo/Claude/os8dotai/vercel.json` — second cron entry for community channel (different schedule offset to spread load)

### `catalog-sync.ts` parameterization

Replace the hardcoded constants with channel-keyed lookup:

```ts
// /home/leo/Claude/os8dotai/src/lib/catalog-sync.ts — replacement for line 43
const CATALOG_REPOS: Record<string, string> = {
  verified: process.env.CATALOG_REPO_VERIFIED ?? 'os8ai/os8-catalog',
  community: process.env.CATALOG_REPO_COMMUNITY ?? 'os8ai/os8-catalog-community',
};

function repoForChannel(channel: string): string {
  const r = CATALOG_REPOS[channel];
  if (!r) throw new Error(`unknown catalog channel: ${channel}`);
  return r;
}

function catalogStateIdForChannel(channel: string): string {
  return `${channel}-singleton`;       // 'verified-singleton' | 'community-singleton'
}

export async function syncCatalog(opts: {
  trigger: SyncTrigger;
  catalogHeadSha?: string;
  channel?: string;
}): Promise<SyncResult> {
  const channel = opts.channel ?? 'verified';   // back-compat default
  const catalogRepo = repoForChannel(channel);
  const stateId = catalogStateIdForChannel(channel);

  const catalogHeadSha =
    opts.catalogHeadSha ?? (await getCatalogHead(catalogRepo));
  // ...rest of the function uses catalogRepo and stateId in place of the
  // module-level constants. Replace every CATALOG_REPO with catalogRepo
  // and every CATALOG_CHANNEL with channel and CATALOG_STATE_ID with stateId.
}
```

The diff touches lines 41-43 (constants), 119-127 (resolution), 136-149 (tree fetch), 173 (full-scan tree), 201 (file fetch), 243 (asset URL), 290-295 (tag-mutation issue body), 295 (issue creation), 335 (manifest channel field — must equal the function `channel` arg, defense in depth: if a community manifest declares `channel: verified`, throw), 361, 392, 408, 414 (CatalogState lookups). Roughly 30 line touches.

**Defense-in-depth check at line 335:**
```ts
if (manifest.review.channel !== channel) {
  alarms.push({
    kind: 'channel_mismatch',
    slug,
    declared: manifest.review.channel,
    expected: channel,
    catalogRepo,
  });
  continue;     // skip — don't ingest a verified manifest into community or vice versa
}
```

**Tag-mutation issue filing.** The existing `catalog-sync.ts:290-313` block opens a GitHub issue when a manifest's tag-resolved SHA changes between syncs (i.e. someone moved the tag — supply-chain alarm). After parameterization, the issue is filed against `catalogRepo` — meaning community-channel mismatches file issues against `os8ai/os8-catalog-community`, not the verified repo. Each curator pool watches their own repo; no cross-channel noise. Verified by inspection of `catalog-sync.ts:295` substituting `catalogRepo` for the previously-hardcoded `CATALOG_REPO`.

### Sync route parameterization

```ts
// /home/leo/Claude/os8dotai/src/app/api/internal/catalog/sync/route.ts
// Webhook POST: read ?channel=community from URL (e.g.
//   https://os8.ai/api/internal/catalog/sync?channel=community).
// The webhook URL configured in each catalog repo's notify-os8ai.yml
// includes the right ?channel= for that repo.

export async function POST(req: NextRequest) {
  const channel = req.nextUrl.searchParams.get('channel') ?? 'verified';
  if (!['verified', 'community'].includes(channel)) {
    return NextResponse.json({ error: 'invalid channel' }, { status: 400 });
  }
  // ...HMAC verification (unchanged)...
  const result = await syncCatalog({
    trigger: SyncTrigger.Webhook,
    catalogHeadSha: payload.after,
    channel,
  });
  return NextResponse.json(result);
}

// Cron GET: same parameterization. Vercel cron config sends each entry
// with a different ?channel= (see vercel.json below).
export async function GET(req: NextRequest) {
  const channel = req.nextUrl.searchParams.get('channel') ?? 'verified';
  if (!['verified', 'community'].includes(channel)) {
    return NextResponse.json({ error: 'invalid channel' }, { status: 400 });
  }
  // ...auth (unchanged)...
  const result = await syncCatalog({ trigger: SyncTrigger.Cron, channel });
  return NextResponse.json(result);
}
```

### `vercel.json` cron entries

Replace single cron with two staggered entries:

```json
{
  "crons": [
    { "path": "/api/internal/catalog/sync?channel=verified",  "schedule": "0,30 * * * *" },
    { "path": "/api/internal/catalog/sync?channel=community", "schedule": "15,45 * * * *" }
  ]
}
```

Different minute offsets so the two channels don't share a peak. Each runs every 30 minutes (existing cadence; spec §5.2 line "30 min cron safety net").

### `/apps` page channel filter

```tsx
// /home/leo/Claude/os8dotai/src/app/apps/page.tsx — replacement
export default async function AppsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const channelFilter = sp.channel === 'community' ? 'community' : sp.channel === 'verified' ? 'verified' : null;

  const apps = await prisma.app.findMany({
    where: {
      deletedAt: null,
      ...(channelFilter ? { channel: channelFilter } : {}),  // both channels when unset
    },
    orderBy: [
      { channel: 'asc' },                  // verified before community
      { publishedAt: 'desc' },
    ],
    select: { /* unchanged */ channel: true /* explicit */ },
  });

  const categories = Array.from(new Set(apps.map(a => a.category))).sort();
  const frameworks = Array.from(new Set(apps.map(a => a.framework).filter((f): f is string => !!f))).sort();
  const channels = Array.from(new Set(apps.map(a => a.channel))).sort();

  return (
    <main>
      <header>
        <h1>Apps</h1>
        <p>{apps.length === 0
            ? "Catalog is being populated."
            : `${apps.length} app${apps.length === 1 ? '' : 's'} from ${channels.length} channel${channels.length === 1 ? '' : 's'}.`}</p>
      </header>
      <AppGrid
        apps={apps.map(a => ({ ...a, publishedAt: a.publishedAt.toISOString() }))}
        categories={categories}
        frameworks={frameworks}
        channels={channels}
        initial={sp}
      />
    </main>
  );
}
```

### `AppGrid.tsx` channel filter pill

Add a third row of pills above the existing category/framework pills, with three options: All / Verified only / Community only. Default = All. URL-syncs to `?channel=`. Existing cards display the `channel` field but no channel-distinct badge yet — PR 3.4 adds amber "C" for community vs green check for verified (CSS class `.app-card__channel-badge--<channel>` defined alongside the filter pill).

**Concrete diff to `AppGrid.tsx`:**

1. Extend `Props` with `channels: string[]` and add `channel` to the `initial` shape.
2. Add `const [channel, setChannel] = useState(initial.channel ?? "")` next to the existing useState calls.
3. Extend the URL-sync `useEffect` (currently lines 40-51 omit `channel`) to track channel state and write `?channel=` when set:
   ```ts
   useEffect(() => {
     const next = new URLSearchParams(params.toString());
     if (query)     next.set("q", query);          else next.delete("q");
     if (category)  next.set("category", category);  else next.delete("category");
     if (framework) next.set("framework", framework); else next.delete("framework");
     if (channel)   next.set("channel", channel);    else next.delete("channel");
     const qs = next.toString();
     router.replace(qs ? `?${qs}` : "?", { scroll: false });
     // eslint-disable-next-line react-hooks/exhaustive-deps
   }, [query, category, framework, channel]);
   ```
4. Apply the channel filter to the displayed `apps` list before `minisearch` searches it.
5. Add a third pill row rendering "All / Verified / Community" with active-state styling.

Note: changing the URL via `router.replace` triggers Next.js to refetch the server component (`page.tsx`) which already reads `?channel=`. The data updates automatically.

### Manifest-validator change for community channel

```js
// /home/leo/Claude/os8/src/services/manifest-validator.js — extension to validateManifest
if (manifest?.review?.channel === 'community') {
  const ds = manifest?.runtime?.dependency_strategy;
  if (ds && ds === 'best-effort') {
    errors.push({
      kind: 'invariant',
      path: '/runtime/dependency_strategy',
      message: 'community channel requires dependency_strategy: frozen or strict',
    });
  }
}
```

### Tests

`os8dotai/src/lib/__tests__/catalog-sync.community.test.ts`:

| Scenario | Assertion |
|---|---|
| `syncCatalog({ channel: 'community' })` | calls `getCatalogHead('os8ai/os8-catalog-community')`; writes `CatalogState` row keyed `community-singleton` |
| Manifest in community repo with `review.channel: verified` | adds `channel_mismatch` alarm; skips ingest |
| Sync verified then community against the same Postgres | both have rows; `App.findMany` returns the union |
| Webhook POST with `?channel=community` | passes channel through to `syncCatalog` |
| Cron GET with `?channel=community` and valid auth | runs the community sync |

`os8dotai/src/app/apps/__tests__/page.test.tsx`:

| Scenario | Assertion |
|---|---|
| `/apps` (no query string) | renders apps from both channels |
| `/apps?channel=community` | renders only community apps |
| `/apps?channel=verified` | renders only verified (back-compat with PR 0.9) |

### Acceptance criteria

- Two cron entries in Vercel. Both visible in the dashboard; both run on schedule.
- `https://os8.ai/apps` shows verified + community apps interleaved.
- `https://os8.ai/apps?channel=community` shows only community apps.
- Channel filter pill state syncs to URL.
- Manifest in `os8ai/os8-catalog-community` lands in Postgres with `App.channel='community'` after a sync run.
- Cross-channel `channel_mismatch` is logged as an alarm but doesn't fail the entire sync.

### Cross-platform notes

None — server-side and Next.js page work.

### Spec deviations

- **`/apps` defaults to all channels** rather than `verified` only. Spec §5.4 implies a single listing; the dual-channel future is anticipated. Per-channel filtering remains available.
- **Cron schedule offsets** are an implementation detail not in the spec.

### Depends on

PR 3.3 (community repo + webhook). Independent of Track A and Track C. Ships before PR 3.5 (which consumes the desktop sync of community channel).

### Open sub-questions

1. **Should the `/apps` page sort prefer verified apps?** Currently `orderBy: [{ channel: 'asc' }, { publishedAt: 'desc' }]` puts verified first ('community' < 'verified' is false in ascii — wait, 'c' < 'v' is true, so community comes first. Need explicit sort logic). **Resolution:** swap to `Prisma.sql` raw with `CASE WHEN channel = 'verified' THEN 0 ELSE 1 END, publishedAt DESC` for explicit ordering.
2. **Asset URL pinning for community-channel manifests.** PR 0.8 pins assets to `raw.githubusercontent.com/os8ai/os8-catalog/<sha>/...`. Community pins to `os8ai/os8-catalog-community/<sha>/...` — same mechanism, different repo. Verified by inspection of `catalogRepo` substitution in `assetBase` (catalog-sync.ts:243).

---

## PR 3.5 — OS8 settings: per-channel enable/disable

**Goal.** A new "App Store" section in OS8 Settings with a toggle per channel: Verified (default ON, can't be disabled — Verified is the canonical channel), Community (default OFF, opt-in), Developer Import (default ON — disabling means the "+ Import from GitHub…" button is hidden). The desktop's daily catalog sync respects the toggles: it only syncs enabled channels. The home-screen catalog browser (if/when built — currently the App Store is browsed via os8.ai) similarly honors the toggle.

### Files

- **Modify:** `/home/leo/Claude/os8/src/renderer/settings.js` — add `loadAppStoreSettings()` + `saveAppStoreSettings()`; register section in `switchSettingsSection`
- **Modify:** `/home/leo/Claude/os8/index.html` — add the settings panel HTML (mirror existing `data-section="ai-models"` block)
- **Modify:** `/home/leo/Claude/os8/src/server.js` — `scheduleAppCatalogSync` reads enable flags and skips disabled channels (extends existing implementation at lines 234-264)
- **Modify:** `/home/leo/Claude/os8/src/services/app-catalog.js` — `seedFromSnapshot` and `sync` continue to take a channel arg unchanged; the scheduler decides which to call
- **Modify:** `/home/leo/Claude/os8/src/renderer/apps.js` — hide the "+ Import from GitHub…" entry point when `app_store.channel.developer-import.enabled === false`
- **Modify:** `/home/leo/Claude/os8/src/services/app-installer.js` — `startFromManifest` rejects with `developer-import disabled` when the toggle is off (defense-in-depth; UI hides the entry but DevTools could still call IPC)

### Settings keys

Stored via existing `SettingsService` (the `settings` table; key/value pair, plaintext):

| Key | Default | Purpose |
|---|---|---|
| `app_store.channel.verified.enabled` | `true` | Toggle is enabled but defaults ON; turning OFF surfaces a warning ("Catalog browser will be empty"). Useful for QA / community-only testing. |
| `app_store.channel.community.enabled` | `false` | Toggle visible; default off — community is opt-in |
| `app_store.channel.developer-import.enabled` | `true` | Toggle visible; default on |
| `app_store.idle_timeout_ms` | `1800000` (30 min) | Already shipped in PR 1.22 — colocate the slider in the new section |

### Settings UI

```html
<!-- index.html — addition inside settings modal, after the existing AI Models section -->
<div class="settings-section" data-section="app-store" hidden>
  <h2>App Store</h2>
  <p class="settings-section__description">
    Choose which app channels OS8 syncs and discovers from. Apps already installed
    are unaffected; this controls what new apps you can browse and install.
  </p>

  <div class="settings-row">
    <label>
      <input type="checkbox" id="appStoreChannelVerified" checked />
      <strong>Verified</strong>
      <span class="settings-hint">Curated, manually reviewed apps from os8ai/os8-catalog.
        Disabling hides verified apps from the catalog browser (community/dev-import
        still work if enabled).</span>
    </label>
  </div>

  <div class="settings-row">
    <label>
      <input type="checkbox" id="appStoreChannelCommunity" />
      <strong>Community</strong>
      <span class="settings-hint">Lightly-reviewed apps from os8ai/os8-catalog-community.
        Each install requires per-capability permission grants.</span>
    </label>
  </div>

  <div class="settings-row">
    <label>
      <input type="checkbox" id="appStoreChannelDevImport" checked />
      <strong>Developer Import</strong>
      <span class="settings-hint">Lets you paste a GitHub URL to install an
        arbitrary repo. No upstream review.</span>
    </label>
  </div>

  <hr />

  <div class="settings-row">
    <label for="appStoreIdleTimeout"><strong>Idle reaper timeout</strong></label>
    <select id="appStoreIdleTimeout">
      <option value="300000">5 minutes</option>
      <option value="900000">15 minutes</option>
      <option value="1800000" selected>30 minutes</option>
      <option value="3600000">1 hour</option>
      <option value="7200000">2 hours</option>
      <option value="14400000">4 hours</option>
      <option value="0">Never (manual stop only)</option>
    </select>
  </div>

  <button id="appStoreSave" class="primary">Save</button>
  <span id="appStoreSaveStatus" class="settings-status" hidden></span>
</div>
```

### Settings.js wiring

```js
// /home/leo/Claude/os8/src/renderer/settings.js — additions
async function loadAppStoreSettings() {
  const community = await window.os8.settings.get('app_store.channel.community.enabled');
  const devImport = await window.os8.settings.get('app_store.channel.developer-import.enabled');
  const idleMs = await window.os8.settings.get('app_store.idle_timeout_ms');
  document.getElementById('appStoreChannelCommunity').checked = community === 'true' || community === true;
  document.getElementById('appStoreChannelDevImport').checked = devImport !== 'false' && devImport !== false;
  if (idleMs) document.getElementById('appStoreIdleTimeout').value = String(idleMs);
}

async function saveAppStoreSettings() {
  const community = document.getElementById('appStoreChannelCommunity').checked;
  const devImport = document.getElementById('appStoreChannelDevImport').checked;
  const idleMs = document.getElementById('appStoreIdleTimeout').value;
  await window.os8.settings.set('app_store.channel.community.enabled', String(community));
  await window.os8.settings.set('app_store.channel.developer-import.enabled', String(devImport));
  await window.os8.settings.set('app_store.idle_timeout_ms', String(idleMs));
  // Notify main process to re-evaluate scheduler.
  await window.os8.appStore.refreshSchedules?.();
  flashStatus('appStoreSaveStatus', 'Saved.');
}
```

### Scheduler change in `server.js`

```js
// /home/leo/Claude/os8/src/server.js — modify scheduleAppCatalogSync (line 237)
function scheduleAppCatalogSync() {
  if (appCatalogSyncTimer) clearTimeout(appCatalogSyncTimer);

  const now = new Date();
  const target = new Date(now);
  target.setHours(CATALOG_SYNC_HOUR, 0, 0, 0);
  if (now >= target) target.setDate(target.getDate() + 1);
  const msUntilSync = target.getTime() - now.getTime();

  appCatalogSyncTimer = setTimeout(async () => {
    try {
      const AppCatalogService = require('./services/app-catalog');

      // Verified always syncs.
      const v = await AppCatalogService.sync(db, { channel: 'verified' });
      console.log(`[AppCatalog/verified] +${v.added} updated:${v.updated} -${v.removed}`);

      // Community syncs only when enabled.
      const communityEnabled = SettingsService.get(db, 'app_store.channel.community.enabled');
      if (communityEnabled === 'true' || communityEnabled === true) {
        const c = await AppCatalogService.sync(db, { channel: 'community' });
        console.log(`[AppCatalog/community] +${c.added} updated:${c.updated} -${c.removed}`);
      }
    } catch (e) {
      console.warn('[AppCatalog] Scheduled sync failed:', e.message);
    }
    scheduleAppCatalogSync();
  }, msUntilSync);
  appCatalogSyncTimer.unref?.();
}
```

### IPC channels for live sync + re-schedule

Saving settings should (a) immediately sync any newly-enabled channel so the catalog mirror populates without waiting for 4am, and (b) re-evaluate the daily schedule. Two distinct actions, two IPC channels:

```js
// /home/leo/Claude/os8/src/ipc/app-store.js — additions
ipcMain.handle('app-store:reschedule-syncs', () => {
  // Resets the next-fire time without syncing now. Call after every settings save.
  require('../server').rescheduleAppCatalogSync?.();
  return { ok: true };
});

ipcMain.handle('app-store:sync-channel-now', async (_e, channel) => {
  // Kick an immediate sync of one channel. Used when the user just toggled a
  // channel ON and wants to populate the catalog mirror without waiting for
  // the daily timer.
  if (!['verified', 'community'].includes(channel)) {
    return { ok: false, error: 'invalid channel' };
  }
  try {
    const AppCatalogService = require('../services/app-catalog');
    const r = await AppCatalogService.sync(db, { channel });
    return { ok: true, ...r };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
```

`server.js` exports `rescheduleAppCatalogSync` (just calls `scheduleAppCatalogSync()` after canceling the existing timer). The settings save handler in the renderer chooses which IPC to call:

```js
// In saveAppStoreSettings (renderer):
const wasCommunityEnabled = previousCommunity;          // captured pre-save
const isCommunityEnabled  = nowCommunity;
await window.os8.appStore.rescheduleSyncs();
if (!wasCommunityEnabled && isCommunityEnabled) {
  // First-enable: kick an immediate sync so the user sees community apps
  // in the catalog without waiting until 4am.
  await window.os8.appStore.syncChannelNow('community');
}
```

Surface the immediate-sync result inline in the settings panel ("Synced 12 community apps") so the user gets feedback.

### Defense-in-depth on `startFromManifest`

```js
// /home/leo/Claude/os8/src/services/app-installer.js — addition near start of startFromManifest
const SettingsService = require('./settings');
const enabled = SettingsService.get(db, 'app_store.channel.developer-import.enabled');
if (enabled === 'false' || enabled === false) {
  throw new Error('Developer Import is disabled in Settings → App Store');
}
```

Mirror in install pipeline for `startFromCatalog` when `channel === 'community'`:

```js
// In AppInstaller._run, near the start, after channel is known:
if (job.channel === 'community') {
  const enabled = SettingsService.get(db, 'app_store.channel.community.enabled');
  if (enabled !== 'true' && enabled !== true) {
    throw new Error('Community channel is disabled in Settings → App Store');
  }
}
```

(Verified is always enabled; no check needed.)

### `/apps` page UX hint (server-side)

When OS8 desktop receives an `os8://install?channel=community` deeplink and the user has community disabled, the install plan modal opens with a warning banner: "This app is from the Community channel, which you have disabled in Settings. Enable Community to continue, or cancel." The Install button is gated until the user enables the channel (a one-click "Enable Community" link in the banner).

### Tests

`tests/settings.app-store.test.js` (renderer-side; probably best as a manual smoke test given the existing settings.js layout):

| Scenario | Assertion |
|---|---|
| Open Settings → App Store | toggles render with correct defaults |
| Toggle Community on, save | `app_store.channel.community.enabled` written; subsequent sync includes community |
| Toggle Developer Import off | "+ Import from GitHub…" button hidden in `apps.js` re-render |

`tests/app-installer.disabled-channels.test.js`:

| Scenario | Assertion |
|---|---|
| `startFromManifest` with developer-import disabled | throws clear error |
| `_run` job with channel=community when community disabled | throws clear error; install fails fast |

### Acceptance criteria

- Settings → App Store section renders with three toggles + idle slider.
- Verified toggle is disabled (UI; tooltip explains).
- Toggling Community on triggers a sync within ~1s; new community apps appear in the catalog mirror.
- Toggling Developer Import off hides the import button on the home grid.
- Setting idle to "Never" makes external apps run indefinitely (already wired by PR 1.22).

### Cross-platform notes

None — settings UI and SQLite storage are platform-agnostic.

### Spec deviations

- **Idle timeout slider colocated** rather than left in PR 1.22's section. PR 1.22 created a "Privacy" or "Apps" section depending on what shipped; PR 3.5 consolidates these App Store-specific knobs in one place. Document in changelog so users find the moved control.

### Depends on

PR 3.4 (community channel must exist on the server side before the toggle does anything useful). Independent of Tracks A and C.

### Open sub-questions

None.

---

## PR 3.6 — Supply-chain analyzer (`osv-scanner` + `safety`)

**Goal.** Replace the typosquat-list stub at `app-review.js:105-185` with calls to real supply-chain scanners. `osv-scanner` covers Node + Python (and more); `safety` is Python-specific. Both are detected on PATH at review time. When neither is available, fall back to the existing typosquat list. The scanners surface known-malicious or vulnerable dependencies as `severity: 'warning'` (high CVE) or `severity: 'critical'` (known-malicious / typosquat) findings, slotting into the existing review report shape unchanged.

### Files

- **Create:** `/home/leo/Claude/os8/src/services/supply-chain-scanner.js` — wraps osv-scanner and safety
- **Modify:** `/home/leo/Claude/os8/src/services/app-review.js` — `_runStaticAnalysis` calls the scanner; the typosquat-list stub becomes the fallback
- **No new package.json deps** — both tools are external binaries (CLI invocations); we never bundle them
- **Optional:** `/home/leo/Claude/os8/docs/supply-chain-tools.md` — short user-facing doc on installing osv-scanner / safety; linked from review-report findings (already a markdown doc per existing convention)

### Why CLI binaries, not npm libraries

- **`osv-scanner`** is a Go binary (`google/osv-scanner`). The npm `osv-scanner` package wraps the binary. We call the binary directly to avoid a transitive Go-runtime dep in OS8.
- **`safety`** is a Python tool installed via `pip install safety`. There is no Node port. We call it as a subprocess.

Both tools are **optional**. If neither is installed, OS8 surfaces an `info` finding ("supply-chain analyzer not available; install osv-scanner for deeper checks") and falls back to the typosquat-list stub. This means PR 3.6 can ship without users having to install anything; the value is opt-in.

### `supply-chain-scanner.js`

```js
// /home/leo/Claude/os8/src/services/supply-chain-scanner.js
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

async function detectTool(name) {
  try {
    await execFileAsync(name, ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run osv-scanner against a directory. Returns the parsed `--format=json`
 * output, or null if the tool is missing. Timeouts are aggressive (90s);
 * the scanner is fast on shallow lockfiles and slow on giant ones — we'd
 * rather skip on a slow run than block install.
 */
async function runOsvScanner(stagingDir) {
  if (!await detectTool('osv-scanner')) return null;
  try {
    // `osv-scanner scan source <dir>` is the documented invocation for a
    // directory; it auto-discovers recognized lockfiles. `--format=json`
    // writes results to stdout. Exit code is non-zero when vulns are found
    // — caught below; stdout still has a complete report.
    const { stdout } = await execFileAsync(
      'osv-scanner',
      ['scan', 'source', '--format=json', stagingDir],
      { timeout: 90_000, maxBuffer: 16 * 1024 * 1024 }
    );
    return JSON.parse(stdout);
  } catch (e) {
    if (e.stdout) {
      try { return JSON.parse(e.stdout); } catch { /* fall through */ }
    }
    return { error: e.message?.slice(0, 200) || 'unknown', tool: 'osv-scanner' };
  }
}

/**
 * Run `safety check` against a Python staging dir's lockfile.
 * Output contract documented at https://docs.pyup.io/docs/safety-2-cli-tool.
 */
async function runSafety(stagingDir) {
  if (!await detectTool('safety')) return null;
  const reqPath = path.join(stagingDir, 'requirements.txt');
  if (!fs.existsSync(reqPath)) return null;     // safety needs a frozen requirements list
  try {
    const { stdout } = await execFileAsync(
      'safety',
      ['check', '-r', reqPath, '--json', '--continue-on-error'],
      { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }
    );
    return JSON.parse(stdout);
  } catch (e) {
    if (e.stdout) {
      try { return JSON.parse(e.stdout); } catch { /* fall through */ }
    }
    return { error: e.message?.slice(0, 200) || 'unknown', tool: 'safety' };
  }
}

/**
 * Translate scanner outputs into AppReviewService finding shape.
 *   - osv-scanner: `results[].packages[].vulnerabilities[]`
 *   - safety:      array of [pkg, affected_versions, installed_version, advisory, vuln_id]
 * Severity mapping:
 *   - osv affected_severity HIGH/CRITICAL → 'critical'
 *   - osv affected_severity MODERATE     → 'warning'
 *   - osv affected_severity LOW          → 'info'
 *   - safety: any reported vuln          → 'warning' (safety doesn't expose CVSS scores via free tier)
 *   - osv-scanner reports a "malicious" advisory ID (MAL-* prefix) → 'critical', category 'supply_chain'
 */
function osvToFindings(report) {
  if (!report || !Array.isArray(report.results)) return [];
  const findings = [];
  for (const result of report.results) {
    for (const pkg of (result.packages || [])) {
      const pkgName = pkg.package?.name || 'unknown';
      const ecosystem = pkg.package?.ecosystem || '';
      for (const vuln of (pkg.vulnerabilities || [])) {
        const isMalicious = (vuln.id || '').startsWith('MAL-') ||
                            (vuln.aliases || []).some(a => a.startsWith('MAL-'));
        const sevString = (vuln.database_specific?.severity ||
                           vuln.severity?.[0]?.score ||
                           '').toUpperCase();
        let severity;
        if (isMalicious) severity = 'critical';
        else if (sevString.includes('CRITICAL') || sevString.includes('HIGH')) severity = 'warning';
        else if (sevString.includes('MODERATE') || sevString.includes('MEDIUM')) severity = 'info';
        else severity = 'info';
        findings.push({
          severity,
          category: isMalicious ? 'supply_chain' : 'supply_chain',
          file: result.source?.path?.split('/').pop() || null,
          line: null,
          description: `${pkgName}@${ecosystem}: ${vuln.id} ${vuln.summary || ''}`.trim().slice(0, 240),
          snippet: '',
        });
      }
    }
  }
  return findings;
}

function safetyToFindings(report) {
  if (!report || !Array.isArray(report.vulnerabilities) && !Array.isArray(report)) return [];
  const list = Array.isArray(report.vulnerabilities) ? report.vulnerabilities
              : Array.isArray(report) ? report
              : [];
  return list.map(v => ({
    severity: 'warning',
    category: 'supply_chain',
    file: 'requirements.txt',
    line: null,
    description: `${v.package_name || v.package}@${v.installed_version || v.version}: ${v.advisory || v.description || ''}`.trim().slice(0, 240),
    snippet: '',
  }));
}

async function scan(stagingDir) {
  const findings = [];
  let osvRan = false;
  let safetyRan = false;

  const osv = await runOsvScanner(stagingDir);
  if (osv) {
    osvRan = true;
    if (osv.error) {
      findings.push({
        severity: 'info', category: 'supply_chain', file: null, line: null,
        description: `osv-scanner failed: ${osv.error}`, snippet: '',
      });
    } else {
      findings.push(...osvToFindings(osv));
    }
  }

  // safety only runs on Python projects.
  const isPython = fs.existsSync(path.join(stagingDir, 'pyproject.toml')) ||
                   fs.existsSync(path.join(stagingDir, 'requirements.txt')) ||
                   fs.existsSync(path.join(stagingDir, 'uv.lock')) ||
                   fs.existsSync(path.join(stagingDir, 'poetry.lock'));
  if (isPython) {
    const sf = await runSafety(stagingDir);
    if (sf) {
      safetyRan = true;
      if (sf.error) {
        findings.push({
          severity: 'info', category: 'supply_chain', file: null, line: null,
          description: `safety failed: ${sf.error}`, snippet: '',
        });
      } else {
        findings.push(...safetyToFindings(sf));
      }
    }
  }

  return { findings, osvRan, safetyRan };
}

module.exports = { scan, runOsvScanner, runSafety, osvToFindings, safetyToFindings };
```

### `app-review.js` integration

The fallback to the typosquat list is preserved (zero-config user experience):

```js
// /home/leo/Claude/os8/src/services/app-review.js — replacement for the Python branch in _runStaticAnalysis (line 467-484)
async _runStaticAnalysis(stagingDir, _manifest) {
  const findings = [];

  // 1. Node: npm audit (unchanged from PR 1.6).
  if (fs.existsSync(path.join(stagingDir, 'package.json'))) {
    // ...existing npm audit block...
  }

  // 2. Real supply-chain scanner — covers Node + Python lockfiles.
  let osvRan = false, safetyRan = false;
  try {
    const Scanner = require('./supply-chain-scanner');
    const r = await Scanner.scan(stagingDir);
    osvRan = r.osvRan;
    safetyRan = r.safetyRan;
    findings.push(...r.findings);
  } catch (e) {
    findings.push({
      severity: 'info', category: 'supply_chain', file: null, line: null,
      description: `supply-chain scan failed: ${e.message?.slice(0, 200)}`, snippet: '',
    });
  }

  // 3. Python typosquat list — fallback when osv-scanner is missing AND no
  // python-aware scanner ran. The list is the same one PR 2.1 ships; we keep
  // it as a permanent fallback so the review surface degrades gracefully.
  const hasPyManifest =
    fs.existsSync(path.join(stagingDir, 'pyproject.toml')) ||
    fs.existsSync(path.join(stagingDir, 'requirements.txt')) ||
    fs.existsSync(path.join(stagingDir, 'uv.lock')) ||
    fs.existsSync(path.join(stagingDir, 'poetry.lock'));
  if (hasPyManifest && !osvRan && !safetyRan) {
    findings.push({
      severity: 'info', category: 'supply_chain', file: null, line: null,
      description: 'no supply-chain scanner found on PATH; using typosquat-list fallback. Install osv-scanner (https://google.github.io/osv-scanner/) for deeper checks.',
      snippet: '',
    });
    try {
      findings.push(...scanPythonDeps(stagingDir));
    } catch (e) {
      findings.push({
        severity: 'info', category: 'supply_chain', file: null, line: null,
        description: `python typosquat scan failed: ${e.message?.slice(0, 200)}`,
        snippet: '',
      });
    }
  }

  return findings;
}
```

The `scanPythonDeps` helper and `KNOWN_MALICIOUS_PYTHON` set stay in place. PR 3.6 doesn't delete the stub — it relegates it to a fallback path that fires only when the real tools are missing. This means a user who installs `osv-scanner` gets the deeper analysis without changing anything else; a user who doesn't gets the v1 behavior unchanged.

### Severity mapping rationale

The spec's risk-level rules at `app-review.js:64-67` say: "low: only info findings; medium: warning findings; high: critical findings." The supply-chain scanner respects this:

- A repo with **MAL-prefixed osv finding** → at least one `critical` finding → review's `riskLevel` rolls up to `high` → install plan modal blocks Install behind the override gate. This is the right outcome for known-malicious packages.
- A repo with **HIGH/CRITICAL CVSS finding** → `warning` finding → review's `riskLevel` rolls up to `medium` → modal allows install with a second-confirm. Reasonable for "your transitive lodash has a CVE" — these are usually the user's call.
- A repo with **MODERATE/LOW finding** → `info` finding → no risk-level impact; surfaces in the modal's info panel.

This mapping is documented in the new `docs/supply-chain-tools.md` so users (and curators) understand why a given finding is gating or not.

### Test fixtures

`tests/supply-chain-scanner.test.js`:

| Scenario | Assertion |
|---|---|
| `osv-scanner` not on PATH (mocked `execFile` throws ENOENT) | `runOsvScanner` returns `null`; no exception |
| `osv-scanner` returns valid JSON with one HIGH vuln | `osvToFindings` produces a `warning` finding with the package name + advisory id |
| `osv-scanner` returns valid JSON with a `MAL-*` advisory id | `osvToFindings` produces a `critical` finding |
| `osv-scanner` exits non-zero with stdout (typical for "found vulns") | parses stdout from `e.stdout` |
| `safety` not on PATH | `runSafety` returns `null` |
| `safety` returns the documented JSON shape | `safetyToFindings` produces `warning` findings |
| Stage with `package.json` + `requirements.txt`, both tools mocked-present | both scanners run; findings interleave |
| Stage with no lockfiles | `scan` returns `{ findings: [], osvRan: false, safetyRan: false }` |

`tests/app-review.supply-chain.test.js`:

| Scenario | Assertion |
|---|---|
| Stage with osv-scanner present and a MAL-* finding | review report's `riskLevel` is `high` |
| Stage with neither tool present, Python lockfile | typosquat-list fallback runs; info finding cites the missing tools |
| Stage with osv-scanner present, only Node | safety doesn't run; osv runs; findings carry through |

`tests/fixtures/`:
- `vulnerable-node/` — `package.json` + `package-lock.json` referencing an old `lodash` (known CVE-2021-23337). Used for the "warning finding" test path.
- `malicious-python/` — `requirements.txt: requestes==1.0.0` (typosquat on `requests`). Used for the typosquat-list fallback test.

### `docs/supply-chain-tools.md`

Short user-facing reference (~100 lines) that explains:
- What osv-scanner is, how to install it (`brew install osv-scanner` / `apt install osv-scanner` / direct binary download).
- What safety is, how to install (`pip install safety`).
- What findings to expect.
- That the App Store still works without these tools but with reduced coverage.

Linked from review-report findings via the `description` field's URL.

### IPC + routes

None new. The scanner runs within the existing review pipeline triggered by `AppInstaller._run`.

### Acceptance criteria

- A clean install of OS8 (no osv-scanner, no safety) reviews a repo and produces an `info` finding pointing at install instructions; risk level computation is unchanged from PR 1.6 + 2.1.
- A user who installs `osv-scanner` (`brew install osv-scanner`) and re-installs the same repo gets findings for any vulnerable Node deps.
- A repo with a known-malicious dep (test fixture: `requestes==1.0.0` on PyPI) produces a `critical` finding; install plan modal blocks Install behind the override gate.
- The typosquat-list fallback continues to work unchanged when neither scanner is present.
- `safety` failures (network down, malformed requirements) surface as an `info` finding and don't block the install.

### Cross-platform notes

- **macOS:** osv-scanner via `brew install osv-scanner`; safety via `pip install safety` (system Python or pyenv).
- **Linux:** osv-scanner via Debian/Ubuntu apt or direct binary; safety via pip.
- **Windows:** osv-scanner is shipped as a `.exe`; safety installs the same way. Both work on Windows 11; tested informally only.
- **arm64:** osv-scanner releases include `darwin-arm64` and `linux-arm64`; safety is pure Python.

### Spec deviations

- **Tools are optional, not required.** Spec §6.2.5 lists "static analysis (advisory in v1): Node `npm audit`; Python `pip check` + (Phase 3) `safety` / `osv-scanner`." This PR makes them optional; a user without the tools still gets the v1 behavior. Documented as a UX choice (zero-config bar stays low).
- **Typosquat-list stub remains as a fallback.** Spec implies replacement; we keep the list as a defense-in-depth path when scanners are missing. PR 3.6 doesn't *replace* the stub, it *adds* the real tools.
- **Severity mapping for OSV is a judgment call.** The spec doesn't dictate "HIGH/CRITICAL → warning" or "MAL-* → critical." Documented above and in `docs/supply-chain-tools.md`.

### Depends on

PR 1.6 (review service interface). Independent of every other Phase 3 PR. Independent of Phase 2 (osv-scanner runs against `package.json` / `requirements.txt` lockfiles regardless of which adapter installed them).

### Open sub-questions

1. **Should `osv-scanner --recursive` be enabled?** Current invocation passes `--lockfile-paths <stagingDir>` which scans recognized lockfiles in the dir but not subdirectories. For monorepos this might miss things. **Recommendation:** ship with `--lockfile-paths` only; revisit if reviewers report a real monorepo manifest where transitive lockfiles in `packages/*/` matter.
2. **Should safety v3's API key gate apply?** Recent safety versions tier their database (free/paid). The free tier still works without an API key but the database is older. **Recommendation:** documented in `supply-chain-tools.md`; users with paid keys can `export SAFETY_API_KEY=...` and it flows through the env. No code change.

---

## 4. Phase 3 acceptance criteria

The following observable outcomes prove Phase 3 ships:

1. **Developer Import works end-to-end.** Right-click on app grid → "Import from GitHub…" → paste worldmonitor URL → spinner → install plan modal opens with the auto-detected manifest (vite framework, node runtime, pnpm package manager, etc.). Approving installs successfully, with `--ignore-scripts` and `apps.channel='developer-import'`.
2. **Developer Import gate is strict.** The modal cannot install without per-capability opt-in toggles AND the explicit risk acknowledgment checkbox. Revealing this without ticking the ack leaves the Install button disabled with a clear reason.
3. **Community catalog repo is live.** `https://github.com/os8ai/os8-catalog-community` exists with the four CI workflows green; one seed manifest (`community-hello`) merged.
4. **os8.ai serves both channels.** `https://os8.ai/apps` shows verified + community apps interleaved; `?channel=community` filter works; cron entries for both channels run on schedule; Postgres `CatalogState` has rows for both channels.
5. **OS8 Settings → App Store works.** Three toggles (Verified read-only, Community default off, Developer Import default on) plus idle-timeout slider. Toggling Community on triggers an immediate sync; new community apps appear within ~1 minute.
6. **Supply-chain analyzer surfaces findings.** A user who installs `osv-scanner` and reviews a known-vulnerable repo (e.g. an old version of an npm app pulling lodash 4.17.20) sees `warning` findings in the install plan modal's review panel; risk level rolls up to `medium`; install gates accordingly. A user without osv-scanner gets the typosquat-list fallback unchanged from v1.
7. **Channel mismatch is logged.** A community-channel manifest with `review.channel: verified` (or vice versa) gets soft-skipped during sync with an `alarm` line; doesn't fail the rest of the run.

### What flows out of Phase 3

- **Catalog distribution scales.** Anyone can submit to `os8ai/os8-catalog-community`; spam-filter CI is the gate. Verified-curator review remains the bar for `os8ai/os8-catalog`.
- **User-imported apps are first-class.** A user can install any GitHub repo without round-tripping through curators. Trust posture is enforced by `--ignore-scripts` + per-capability opt-in + LLM review against manifest claims.
- **Real CVE data flows into review reports** for users who install `osv-scanner` / `safety`. The fallback path keeps OS8 working without those tools.
- **The MEMORY.md project memory's "App Store repos & live URLs" entry now needs updating** to reference `os8ai/os8-catalog-community` alongside `os8ai/os8-catalog`. Update at PR 3.3 merge time.

### What does **not** carry forward

- **Resource enforcement** (`resources.memory_limit_mb` as a hard limit) stays advisory in v1; spec §11 defers. Phase 4+ candidate.
- **OAuth-gated capabilities** (e.g. signed-in-only access to imagegen) stay tied to user's existing connections; channel doesn't gate them. Phase 4+ candidate if multi-tenant capability gating matters.
- **Per-app reputation / install count** displayed on community manifests — currently `App.installCount` increments anonymously via `track-install`; surfacing it on the community filter helps users prioritize, but the CI doesn't gate on it. Defer to a Phase 4 polish PR.
- **`os8ai/os8-catalog-community` curator pool governance** — single-pool CODEOWNERS in v1; revisit if PR volume demands a triage tier.

---

## 5. Decisions log (Phase 3)

| # | Decision | Resolved in |
|---|---|---|
| 1 | Developer Import is desktop-local; no os8.ai round-trip | Phase 3 outline + PR 3.1 |
| 2 | `AppInstaller.startFromManifest` is the new entry point for catalog-less installs (writes a synthetic `app_catalog` row keyed by `channel='developer-import'`) | PR 3.1 |
| 3 | Manifest validator's `dependency_strategy: frozen` requirement is now channel-tiered (verified only); `developer-import` accepts any value; `community` requires `frozen` or `strict` | PR 3.1 + PR 3.4 |
| 4 | Community catalog schema is byte-equivalent to verified, fetched at CI time (no schema drift) | PR 3.3 |
| 5 | Spam filter CI: github.com-only upstream, slug blocklist, ≥7-day repo age | PR 3.3 |
| 6 | Both webhooks (verified + community) hit the same `/api/internal/catalog/sync` endpoint, dispatched on `?channel=` query string | PR 3.4 |
| 7 | `CatalogState` rows keyed `<channel>-singleton` (one per channel) | PR 3.4 |
| 8 | Vercel Cron uses two staggered entries (verified at :00/:30, community at :15/:45) | PR 3.4 |
| 9 | `/apps` defaults to all enabled channels; `?channel=` filter still available | PR 3.4 |
| 10 | Settings toggles default: Verified ON (locked), Community OFF, Developer Import ON | PR 3.5 |
| 11 | Settings save triggers immediate re-schedule of catalog sync via IPC `app-store:refresh-schedules` | PR 3.5 |
| 12 | Defense-in-depth: `AppInstaller` checks channel-enabled flag at install start (not just UI hide) | PR 3.5 |
| 13 | Supply-chain scanners (osv-scanner + safety) are optional; typosquat-list stub remains as fallback | PR 3.6 |
| 14 | OSV severity mapping: `MAL-*` → critical; HIGH/CRITICAL CVSS → warning; MODERATE/LOW → info | PR 3.6 |
| 15 | safety only runs against `requirements.txt` (skips repos with only pyproject.toml or uv.lock until safety supports them natively) | PR 3.6 |
| 16 | No new package.json deps in PR 3.6 — both tools are external CLIs | PR 3.6 |
| 17 | Phase 3 has no architectural gate — both Vite (PR 1.14) and Streamlit (PR 2.2) WS proofs cover the proxy primitives Phase 3 reuses | this doc §1 |
| 18 | Dockerfile-only Developer Imports rejected with a clear pointer to Community channel; supporting them would require `docker build` orchestration + manual `internal_port` discovery, both out of scope for v1 dev-import UX | PR 3.1 (`detectRuntime`) |
| 19 | `framework: none` + `runtime.kind: node` reads `pkg.scripts.{dev,start,serve}` in priority order rather than blindly emitting `npm run dev`; review pipeline still flags if no script matches | PR 3.1 (`defaultStartArgv`) |
| 20 | `_runApprove` skips `track-install` POST when `entry.channel === 'developer-import'` — synthesized slugs don't map to os8.ai App rows | PR 3.1 (`_runApprove` change) |
| 21 | Synthetic `app_catalog` rows for abandoned dev-imports get reaped by `AppCatalogService.reapStaging` after 24h; `_rollbackInstall` and `cancel` reap their own slug immediately | PR 3.1 (`reapDeveloperImportOrphans`) |
| 22 | Settings save uses two IPC channels: `app-store:reschedule-syncs` (always) + `app-store:sync-channel-now` (only on first-enable of a channel) — clearer separation than a single "refresh" call | PR 3.5 |
| 23 | Verified channel toggle is enabled-but-default-ON (not read-only) — supports verified-off QA mode; surfaces a warning when disabled | PR 3.5 |
| 24 | `osv-scanner` invocation: `osv-scanner scan source --format=json <dir>` (directory mode), not `--lockfile-paths` (which takes individual files) | PR 3.6 |
| 25 | Per-capability toggles in dev-import modal grouped by trust axis (storage / comms / AI / Google) for scannability | PR 3.2 |

---

## 6. Update to MEMORY.md after PR 3.3

The user's project memory at `reference_app_store_repos.md` currently lists `os8ai/os8-catalog` (public) and `os8ai/os8dotai`. After PR 3.3 merges, append `os8ai/os8-catalog-community` (public) so future conversations remember the second repo. One-line update.

---

*End of plan.*
