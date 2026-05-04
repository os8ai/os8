# OS8 App Store — Phase 5 Implementation Plan

**Companions:** [`app-store-spec.md`](./app-store-spec.md) (Draft v2), [`app-store-plan.md`](./app-store-plan.md) (master plan), [`phase-0-plan.md`](./phase-0-plan.md), [`phase-1-plan.md`](./phase-1-plan.md), [`phase-2-plan.md`](./phase-2-plan.md), [`phase-3-plan.md`](./phase-3-plan.md), [`phase-4-plan.md`](./phase-4-plan.md), [`app-store-deferred-items.md`](./app-store-deferred-items.md).
**Audience:** Engineers implementing PRs 5.1 – 5.10 (plus three doc PRs) across `/home/leo/Claude/os8/`, `/home/leo/Claude/os8dotai/`, `os8ai/os8-catalog`, `os8ai/os8-catalog-community`, and `os8ai/os8-sdk-types` (for the npm publish).
**This document:** the concrete contract for each Phase 5 PR — files, splice points, signatures, schema additions, API contracts, test fixtures, acceptance criteria, smoke gates, cross-platform notes, and deviations. Reference the spec and prior phase plans for *why*; this file is *how*.

> **Important framing.** Phase 4 (`docs/phase-4-plan.md`) was the first post-v1 phase — *maturation + observability*. It shipped 14 PRs across five repos (telemetry, auto-update, MCP wildcards, strict middleware, Windows CI, the npm SDK, the Playwright harness). Phase 4 deliberately deferred three follow-ups so the parent PRs could merge without growing further: (1) the os8.ai session cookie that lights up the desktop heartbeat, (2) the actual NPM publish of `@os8/sdk-types`, (3) flipping `OS8_4_6_STRICT=1` in the E2E workflow + fleshing out the harness specs. Those follow-ups are part of the Phase 5 first wave — Phase 4's instrumentation is on but dim until they land.
>
> Phase 5's theme: **lifecycle completeness + telemetry-driven sharpening**. Phase 4 wired the dashboard but no soak time has elapsed (telemetry shipped 2026-05-03; this plan is written 2026-05-03), so Phase 5 scope is derived from (a) the three Phase 4 follow-ups above, (b) deferred-items entries with fired triggers (#34, #35), and (c) deferred-items entries that close visible lifecycle gaps the spec already promised but never wired (#10 three-way merge UI, #11 community auto-update, #12 reinstall-from-orphan, #32 sync-now). Each promotion is justified in §1 against a spec section, deferred-items entry, or Phase 4 follow-up.

---

## 1. Scope, ordering, inheritance

Phase 5 ships **six tracks** that together turn Phase 4's instrumented v1.1 into a complete-lifecycle v1.2. The first track ("Phase 4 close-out") finishes work Phase 4 left dark. The remaining tracks promote five deferred-items entries with fired or about-to-fire triggers.

| PR | Work unit | Surface | Track | Spec / deferred-items source | Smoke gate |
|---|---|---|---|---|---|
| 5.1 | Desktop session cookie → installed-apps heartbeat goes live | OS8 + os8.ai (light) | A — Phase 4 close-out | spec §11 "Phase 4 added open items" #1; phase-4-plan §7 #14 (gated follow-up) | yes — heartbeat smoke |
| 5.2 | `@os8/sdk-types@1.0.0` published to npm + drift CI tightened | os8 + os8-sdk-types repo | A — Phase 4 close-out | spec §11 #6 (Phase 4 close-out: "needs `NPM_TOKEN` + `git tag v1.0.0 && git push --tags`") | — |
| 5.3 | `OS8_4_6_STRICT=1` env flip in E2E workflow + flesh out install / dev-import / native-app specs | OS8 | A — Phase 4 close-out | phase-4-plan §10 (Phase 4 deferred to follow-ups: "set `OS8_4_6_STRICT=1`") | yes — E2E suite green w/ strict env |
| 5.4 | Three-way merge UI for updates with user edits | OS8 | B — Lifecycle completeness | deferred-items.md #10; spec §6.9 sketches the UI but no surface exists | yes — manual merge smoke |
| 5.5 | Reinstall-from-orphan restore UI | OS8 | B — Lifecycle completeness | deferred-items.md #12; spec §6.10 promises it ("Reinstall detects orphan data … and prompts to restore") but the install path doesn't check | yes — uninstall→reinstall smoke |
| 5.6 | Catalog "Sync Now" button + per-install lazy refresh | OS8 | B — Lifecycle completeness | deferred-items.md #32 (Phase 3.5.5 incident triggered); IPC `app-store:sync-channel-now` already exists | — |
| 5.7 | Community-channel auto-update opt-in | OS8 | C — Auto-update extension | deferred-items.md #11; spec §6.9 explicitly limits auto-update to Verified — Phase 5 widens once #5.4's merge UI lands so conflicts have a recovery path | — |
| 5.8 | Docker adapter `runtime.volumes` (catalogs + adapter wiring) | OS8 + 2× catalog | D — Docker hardening | deferred-items.md #35 (linkding incident triggered); phase-3.5.5 retro identified the gap | yes — linkding persistence smoke |
| 5.9 | os8.ai catalog-sync triggers Vercel deploy hook | os8.ai | E — Web-side polish | deferred-items.md #34 (Phase 3.5.5 manual-nudge pain triggered) | — |
| 5.10 | Migration `0.7.0-app-store-lifecycle.js` | OS8 | F — Foundation | foundation for 5.4 (`update_status` already exists per PR 1.25 but `update_conflict_files` JSON column is new) + 5.5 (orphan-restore preference) + 5.8 (manifest schema validator update) | — |
| 5.D1 | Spec + master-plan close-out updates | docs | G | always-separate (see phase-3-plan §1) | — |
| 5.D2 | `docs/runtime-volumes.md` + `docs/sync-now.md` user references | docs | G | new — accompany 5.8 + 5.6 | — |
| 5.D3 | `app-store-deferred-items.md` decisions log update | docs | G | always-separate | — |

### Ordering

Phase 5 has **three hard sequencing constraints** and otherwise allows parallel work.

```
Foundation (must merge first):
  5.10 (migration 0.7.0) ─── no deps; foundation for 5.4 (update_conflict_files), 5.5 (settings key), 5.8 (schema bump)

Track A (Phase 4 close-out — independent within track):
  5.1 (session cookie + heartbeat live)  ── requires AccountService change + os8dotai cookie path
  5.2 (npm publish for @os8/sdk-types)   ── repo + workflow already exist; needs NPM_TOKEN + tag
  5.3 (E2E strict-env flip + spec flesh-out) ── one-line workflow change + ~3 fleshed-out specs

Track B (Lifecycle completeness — partially sequential):
  5.4 (three-way merge UI)        ── 5.10 (update_conflict_files column)
  5.5 (reinstall-from-orphan UI)   ── 5.10 (orphan-restore preference key); independent of 5.4
  5.6 (Sync Now + lazy refresh)    ── independent

Track C (Auto-update extension):
  5.7 (community auto-update)     ── 5.4 (conflict UI is the recovery path; gating on no-user-edits is symmetric to verified)

Track D (Docker hardening):
  5.8 (runtime.volumes)           ── 5.10 (schema bump); also touches both catalog repos

Track E (Web-side polish):
  5.9 (Vercel deploy hook)        ── independent

Track G (docs — always separate from code):
  5.D1, 5.D2, 5.D3 — file once each track lands and decisions are settled
```

**Critical path within Phase 5** (longest chain): `5.10 → 5.4 → 5.7`. Roughly 3 PR-merges deep on the gating axis. Tracks A, D, E can run in parallel with the critical path.

### Test matrix

Phase 4 PR 4.8 promoted `windows-2022` to gating across the unit-test job in `.github/workflows/ci.yml`. Phase 5 inherits that — no PR weakens the matrix.

**E2E matrix (PR 5.3):** the Playwright workflow at `.github/workflows/e2e.yml` currently runs `[ubuntu-22.04, macos-14]` only. Phase 4's PR 4.8 promised Windows joins "once 4.8 stabilizes." PR 5.3 keeps Linux + macOS in the gating matrix and adds `windows-2022` as **best-effort** (continue-on-error) for the E2E job — Windows joins gating once one full run is green; the audit (§2 below) flags this as a risk because Playwright-Electron on Windows occasionally needs `--no-sandbox` flags.

PR 5.9's tests run on the os8.ai Vercel preview pipeline (Linux containers, unchanged).

### Inheritance — what Phase 5 does **not** re-spec

Phase 5 PRs are additive on top of Phases 0–4. **Do not re-spec these.** Cite by file path and section.

| Inherited primitive | Phase | File on disk |
|---|---|---|
| `RuntimeAdapter` interface | 1.11 | `src/services/runtime-adapters/{index,node,python,static,docker}.js` |
| `AppInstaller` orchestrator + state machine | 1.5 / 1.16 | `src/services/app-installer.js` |
| `AppCatalogService.sync` (channel-keyed, idempotent, soft-delete) | 1.3 | `src/services/app-catalog.js` |
| `AppCatalogService.update` (fast-forward + 3-way merge with `update_status='conflict'`) | 1.25 | `src/services/app-catalog.js:497-570` |
| `AppService.uninstall` (tiered, default-preserve, `status='uninstalled'`) | 1.24 | `src/services/app.js:231-275` |
| `AppAutoUpdater.processAutoUpdates` (Verified-only, no-user-edits) | 4.2 | `src/services/app-auto-updater.js` |
| Per-app settings flyout | 4.2 | `src/renderer/app-settings-flyout.js` |
| Auto-update toast subscriber | 4.2 | `src/renderer/toast.js`, `src/renderer/main.js:314-330` |
| `AppTelemetry` emitter (allowlist sanitizer + double-hashed clientId) | 4.4 | `src/services/app-telemetry.js` |
| Telemetry ingest + dashboard | 4.5 | `os8dotai/src/app/api/apps/telemetry/route.ts`, `os8dotai/src/app/internal/telemetry/install/page.tsx` |
| `requireAppContext` strict middleware (origin allowlist + internal-token) | 4.6 | `src/middleware/require-app-context.js` |
| `mcp.<server>.*` wildcard resolver | 4.7 | `src/services/scoped-api-surface.js` |
| `@os8/sdk-types` repo + drift-check tool | 4.9 | `os8ai/os8-sdk-types` (GitHub), `tools/check-sdk-drift.js` |
| Playwright-Electron E2E harness | 4.10 | `tests/e2e/playwright/{playwright.config.ts,setup.ts,specs/}` |
| Migration runner | 0.2.10 | `src/services/migrator.js`, `src/migrations/<x.y.z>-<slug>.js` |
| Channel-tiered `--ignore-scripts` policy | 1.11 | `src/services/runtime-adapters/node.js` |
| Hardened BrowserView for external apps | 1.19 | `src/services/preview.js` |
| os8.ai `App` / `PendingInstall` / `CatalogState` / `InstalledApp` / `InstallEvent` Prisma models | 0.7 / 4.3 / 4.5 | `os8dotai/prisma/schema.prisma` |
| Reverse proxy primitive + WebSocket upgrade handler | 1.13 / 1.14 / 2.2 | `src/services/reverse-proxy.js` |
| Supply-chain scanner (osv-scanner + safety) | 3.6 | `src/services/supply-chain-scanner.js` |
| Install-plan modal | 1.17 + 4.1 (streaming) + 4.4 (consent) | `src/renderer/install-plan-modal.js` |

When PR 5.x text says "extend `AppCatalogService.update`" it means **the same method in `app-catalog.js:497`** — see PR 1.25 + the audit notes in §2 below for what already exists.

---

## 2. Audit findings (Phase 5-relevant)

Verified against the working tree of `/home/leo/Claude/os8/` at audit time (`main` at `06fba5b`, Phase 4 merged through PR #56). Cross-repo audits run against `os8ai/os8dotai` (last merged: #16), `os8ai/os8-catalog` (#13), `os8ai/os8-catalog-community` (#10), and `os8ai/os8-sdk-types` (no releases). Telemetry dashboard: `https://os8.ai/internal/telemetry/install` returns 404 to anonymous probes (curator-gated; expected) — **no soak data is yet available to inform Phase 5 scope.** Phase 5 derives scope from Phase 4 follow-ups + deferred-items triggers, not from telemetry signal.

| Phase 5 dependency | Code reality at audit | Implication |
|---|---|---|
| `apps.update_status` column exists for conflict tracking | ✓ — PR 1.25 / merged in `0.5.0-app-store.js`. `AppCatalogService.update` (`src/services/app-catalog.js:545-553`) writes `update_status='conflict'` on merge failure. | **PR 5.4** has the storage column already; what's missing is the renderer surface. **PR 5.10** adds a sibling `update_conflict_files` JSON column for the conflict-file list (currently `app-catalog.js:540-542` returns the file list to the caller but never persists it; on app re-open the renderer would have to re-run `git status --porcelain` to recover it). |
| `AppService.uninstall` preserves `apps.status='uninstalled'` for orphan detection | ✓ — `src/services/app.js:268-272` sets `status='uninstalled'` and the comment at line 229 explicitly cites PR 1.16's reinstall-orphan-detection plan. Reality: `app-installer.js` and `app-catalog.js` never check for `status='uninstalled'` rows; the install path is orphan-blind. | **PR 5.5** ships the orphan-detection + restore-prompt UI. The data side is correct; the install plan modal needs (a) a check for `(external_slug, status='uninstalled')` rows and (b) a "Restore data?" checkbox in the modal. |
| os8.ai session cookie reaches `AppCatalogService.reportInstalledApps` | ✗ — `src/server.js:325-326` hardcodes `getSessionCookie: () => null`. AccountService caches profile only (no token storage). The endpoint at `os8dotai/src/app/api/account/installed-apps/route.ts` is in place and works; only the desktop side of the heartbeat is dark. | **PR 5.1** plumbs the cookie. AccountService gains a `getSessionCookie(db)` method; the OAuth finalize callback persists the cookie into a new `account` row column (or a settings key — see PR 5.1 for the choice). |
| `@os8/sdk-types@1.0.0` is published to npm | ✗ — npm registry returns 404 for `@os8/sdk-types`. Repo + workflow exist; needs `NPM_TOKEN` secret and `git tag v1.0.0 && git push --tags`. | **PR 5.2** is largely an ops task: add the secret, mirror the canonical `.d.ts`, push the tag. PR 5.2's drift-CI side adds a stricter check (current `tools/check-sdk-drift.js` checks preload vs in-folder `.d.ts`; PR 5.2 extends the check to also verify the published-package source matches). |
| `OS8_4_6_STRICT=1` is set in the E2E workflow env | ✗ — `.github/workflows/e2e.yml` has no env block; the strict-mode E2E specs (`tests/e2e/playwright/specs/scoped-api.spec.ts:71` checks `process.env.OS8_4_6_STRICT === '1'`) skip in CI. | **PR 5.3** sets `OS8_4_6_STRICT: '1'` in the workflow env. Also fleshes out the install + dev-import + native-app specs (currently `.skip()`'d at `native-app-load.spec.ts:18` etc.). |
| Catalog "Sync Now" IPC channel exists | ✓ — `src/ipc/app-store.js:181-191` implements `app-store:sync-channel-now`. Reality: no UI button calls it; only the post-channel-toggle scheduler in `src/renderer/settings.js` invokes it. | **PR 5.6** adds a Sync-Now button to the catalog browser + an opportunistic per-install lazy refresh in `AppCatalogService.get` (refresh manifest_yaml against upstream when local row is older than N minutes). |
| Docker adapter bind-mounts only `OS8_APP_DIR` and `OS8_BLOB_DIR` | ✓ — verified at `src/services/runtime-adapters/docker.js`. Manifests have no way to declare additional persistent paths (linkding incident: `/etc/linkding/data` was ephemeral). | **PR 5.8** adds `runtime.volumes: [{ container_path, persist?: boolean }]` to appspec-v2, validated by both catalog repos and the local validator. Adapter mounts each entry under `${BLOB_DIR}/_volumes/${basename}`. |
| Vercel ISR fallback regenerates on demand | ✗ — newly-synced catalog slugs return 500 until a deploy regenerates the static-params list. `os8dotai/src/app/apps/[slug]/page.tsx:13-22` documents the workaround (pre-render every known slug at build time). | **PR 5.9** wires the catalog-sync route to call `process.env.VERCEL_DEPLOY_HOOK_URL` after a successful add (skipped on cron-only ticks where no manifest changed). The pre-render-everything workaround stays in tree as defense-in-depth. |
| Auto-update path supports community channel | ✗ — `app-auto-updater.js:listEligible` filters `channel = 'verified'` (`src/services/app-auto-updater.js:55`). | **PR 5.7** widens the filter to `channel IN ('verified', 'community')` — gated on a per-channel settings key seeded by PR 5.10. Spec §6.9 ("Verified channel only") gets updated in PR 5.D1. |
| Per-app settings flyout supports a per-channel auto-update toggle | ✓ — flyout at `src/renderer/app-settings-flyout.js` reads `app.auto_update`. The PATCH endpoint `/api/apps/:id/auto-update` accepts the value regardless of channel. The flyout's hint text is currently Verified-specific. | **PR 5.7** updates the hint text + (optionally) gates the toggle on `app_store.auto_update.community_enabled` setting being true. |
| Migration runner accepts `0.7.0-…js` | ✓ — `src/services/migrator.js` runs any `<x.y.z>-<slug>.js` whose version > stored value. `package.json` is `0.6.0` (post-PR 4.11). | **PR 5.10** ships `0.7.0-app-store-lifecycle.js`: adds `apps.update_conflict_files TEXT` (JSON), seeds `app_store.orphan_restore.prompt = 'true'` and `app_store.auto_update.community_enabled = 'false'`, optionally seeds an empty `_internal_call_token` if the 0.6.0 migration's seed was skipped (defensive — verified at `src/migrations/0.6.0-app-store-telemetry.js`). |

**Net assessment.** Phase 5 is lower-risk than Phase 4 in three ways: (a) no trust-boundary changes (the strict middleware flip is already live); (b) no new repo-creation work; (c) the lifecycle gaps are visible and well-bounded — each promotion has a narrow file-set + a clear acceptance check.

The two genuinely tricky PRs are:

- **PR 5.4 (three-way merge UI)** — git-style conflict resolution UI is one of the harder UI surfaces to get right. Fortunately we don't need to re-implement diff rendering: VS Code's `<<<<<<<` markers in conflicted files are perfectly readable, and the user's existing dev-mode setup (chokidar + AI agent) handles editing. The UI's job is *surface* (which files conflict, how to mark resolved, when to commit) — the resolution is the user's.
- **PR 5.8 (Docker `runtime.volumes`)** — schema change touching three repos in lockstep. Phase 4 PR 4.7's MCP wildcard precedent is the template (also a three-repo schema change). Audit at write time: the catalog repos' `validate.yml` workflows pull `appspec-v2.json` from the local copy, so the validator update needs to land in all three places before any manifest can declare the new field.

The remaining PRs (5.1, 5.2, 5.3, 5.5, 5.6, 5.7, 5.9, 5.10) are each ≤300 LOC of focused work against well-defined seams.

---

## 3. Cross-PR dependencies

```
Phase 0–4 chain (must be in tree; Phase 5 inherits):
  0.7   App / PendingInstall / CatalogState Prisma models
  1.3   AppCatalogService.sync
  1.5   app_install_jobs state machine
  1.16  AppInstaller install pipeline
  1.17  Install plan modal
  1.24  AppService.uninstall (tiered)
  1.25  AppCatalogService.update (3-way merge — backend only)
  3.4   dual-channel sync
  4.2   AppAutoUpdater + per-app settings flyout + toast subscriber
  4.3   InstalledApp Prisma model + os8.ai endpoint (heartbeat dark on desktop side)
  4.4   AppTelemetry
  4.5   InstallEvent Prisma + dashboard
  4.6   requireAppContext strict middleware (live; E2E gate dim)
  4.7   mcp.<server>.* resolver
  4.9   @os8/sdk-types repo + drift-check tool (unpublished)
  4.10  Playwright harness scaffold
  4.11  Migration 0.6.0 (telemetry queue + auto-update settings + _internal_call_token)

Phase 5:
  Foundation (must merge first; no deps):
    5.10 (migration 0.7.0-app-store-lifecycle.js)

  Track A (Phase 4 close-out — parallel within track):
    5.1 (session cookie + heartbeat live)  ── independent
    5.2 (npm publish + drift CI tighten)   ── independent
    5.3 (E2E strict env + spec flesh-out)  ── independent

  Track B (Lifecycle completeness):
    5.4 (three-way merge UI)        ── 5.10 (update_conflict_files column)
    5.5 (reinstall-from-orphan UI)   ── 5.10 (orphan-restore setting); independent of 5.4
    5.6 (Sync Now + lazy refresh)    ── independent

  Track C (Auto-update extension):
    5.7 (community auto-update)     ── 5.4 (conflict path needs a recovery surface);
                                       5.10 (community_enabled setting)

  Track D (Docker hardening):
    5.8 (runtime.volumes)           ── 5.10 (schema bump); 2× catalog repos in lockstep

  Track E (Web-side polish):
    5.9 (Vercel deploy hook)        ── independent

  Track G (docs):
    5.D1 — files after Tracks A–E close
    5.D2 — files alongside 5.6 + 5.8
    5.D3 — files when each track's items close
```

**Critical path within Phase 5** (longest chain): `5.10 → 5.4 → 5.7`. Tracks A, D, E run in parallel with the critical path.

---

## PR 5.1 — Desktop session cookie → installed-apps heartbeat goes live

**Goal.** Phase 4 PR 4.3 split into two pieces: the os8.ai-side endpoint (`os8dotai#16`, deployed and verified) and the desktop-side heartbeat (`os8ai/os8#51`). The latter shipped the `AppCatalogService.reportInstalledApps(db, { getSessionCookie })` method and a server-side scheduler hook (`src/server.js:325`), but `getSessionCookie` is hard-wired to `() => null` because `AccountService` only caches profile data — never tokens. Until a session-cookie path exists, the InstalledApps badge feature ships dark: signed-in users browsing `https://os8.ai/apps/<slug>` see no "you have v1.4.2 installed" badge, no matter how many times the desktop ticks.

PR 5.1 plumbs the cookie. The OAuth finalize callback (existing per PR 1.26) gets a tiny extension that persists the os8.ai-issued session cookie locally; AccountService gains a `getSessionCookie(db)` reader; the scheduler stops passing `() => null`.

### Files

- **Modify:** `/home/leo/Claude/os8dotai/src/app/api/auth/desktop/finalize/route.ts` — alongside the existing JSON response (profile + auth code), set the os8.ai session cookie on the response with `SameSite=Lax; HttpOnly; Secure`. The desktop's listening localhost port doesn't *receive* this cookie automatically (different origin); we explicitly include it in the JSON response body as `{ ..., sessionCookie: <serialized cookie name=value> }`.
- **Modify:** `/home/leo/Claude/os8/src/services/account.js` — `_exchangeCode` accepts the new field; `saveAccount(db, profile, { sessionCookie })` writes the cookie value into a new `account.session_cookie` column.
- **Modify:** `/home/leo/Claude/os8/src/services/account.js` — add `getSessionCookie(db)` that reads from the column.
- **Modify:** `/home/leo/Claude/os8/src/server.js:325-326` — replace `getSessionCookie: () => null` with `getSessionCookie: () => AccountService.getSessionCookie(db)`.
- **Migration:** included in PR 5.10 (0.7.0). Adds `account.session_cookie TEXT NULL`.
- **Modify:** `/home/leo/Claude/os8/src/renderer/account.js` — surface a "Sharing your installed apps with os8.ai" toggle next to the existing sign-in state. Default ON when signed in; toggling OFF clears the column + suppresses the heartbeat.

### `AccountService` extensions — contract

```js
// src/services/account.js — additions

class AccountService {
  // ...existing

  /**
   * Reads the os8.ai session cookie value (e.g. "next-auth.session-token=abc...").
   * Returns null if the user isn't signed in OR has opted out of installed-app sharing.
   */
  static getSessionCookie(db) {
    const row = db.prepare(
      `SELECT session_cookie FROM account WHERE id = 'local' AND share_installed_apps = 1`
    ).get();
    return row?.session_cookie || null;
  }

  /**
   * Toggle the share-installed-apps preference. When set to false, also clears
   * the cached cookie so the next heartbeat short-circuits and the os8.ai-side
   * delete-on-omit semantics will purge the InstalledApp rows on the next tick
   * for any other still-signed-in client.
   */
  static setShareInstalledApps(db, enabled) {
    if (enabled) {
      db.prepare(`UPDATE account SET share_installed_apps = 1 WHERE id = 'local'`).run();
    } else {
      db.prepare(`UPDATE account SET share_installed_apps = 0, session_cookie = NULL WHERE id = 'local'`).run();
    }
  }
}
```

### os8.ai finalize-route extension

```ts
// os8dotai/src/app/api/auth/desktop/finalize/route.ts — addition

// Existing: read auth code, exchange for session, build profile
// Existing: return JSON { profile, code }

// NEW: include the session cookie value in the response so the desktop can
// store it (the desktop's localhost listener is a different origin and won't
// receive Set-Cookie automatically).
const sessionToken = await getSessionToken(req);  // existing helper
return NextResponse.json({
  profile,
  code,
  sessionCookie: sessionToken
    ? `next-auth.session-token=${sessionToken}`
    : null,
});
```

The `sessionCookie` is the literal string the desktop will pass back as a `Cookie:` header on subsequent requests. We pass the full `name=value` rather than the bare token so the desktop side stays decoupled from cookie-name churn (NextAuth v5 → v6 renamed it once already).

### Privacy note

The cookie is only used for outbound `POST /api/account/installed-apps` heartbeats. It is **not** used for any other os8.ai API call from the desktop. The user can revoke it any time by signing out (`AccountService.signOut` clears the column) or by toggling "Share installed apps" off in the account panel.

### Tests

`tests/account.session-cookie.test.js`:

| Scenario | Assertion |
|---|---|
| `saveAccount` with `{ sessionCookie }` | column is set; subsequent `getSessionCookie` returns it |
| `setShareInstalledApps(false)` | column is cleared; `getSessionCookie` returns null |
| `signOut` | column is cleared; `getSessionCookie` returns null |
| `getSessionCookie` when no row in `account` table | returns null without throwing |

`tests/installed-apps-heartbeat.live.test.js` (manual smoke):
- Sign in to os8.ai from desktop.
- Install worldmonitor.
- Wait for next daily catalog-sync tick (or trigger via Sync Now button from PR 5.6).
- Open `https://os8.ai/apps/worldmonitor` in a signed-in browser.
- Verify: "You have abc1234 installed (current)" badge appears.
- Uninstall worldmonitor on desktop.
- Wait for next tick.
- Re-open the page; badge is gone.

### Smoke gate

**G1: Heartbeat smoke required before PR 5.D1 close-out.** PR 5.1's whole value is whether the badge actually lights up end-to-end. Smoke per the manual test above. Mirror of phase-4-plan §6 G2 reasoning.

### Acceptance criteria

- After signing in, `account.session_cookie` is non-null in the local DB.
- `AccountService.getSessionCookie(db)` returns the cookie value.
- `AppCatalogService.reportInstalledApps(db, { getSessionCookie })` succeeds with status 200 (vs the current 401).
- The os8.ai detail page badge appears for signed-in users with at least one installed external app.
- Toggling "Share installed apps" OFF clears the column; the next heartbeat short-circuits with `{ ok: false, reason: 'no os8.ai session — heartbeat skipped' }`.

### Cross-platform notes

- Cookie storage is plain SQLite TEXT — no platform differences.
- The `Cookie:` header is identical across platforms.

### Spec deviations

- **`account.share_installed_apps` column is new.** Spec §11 "Phase 4 added open items" mentions the heartbeat follow-up but doesn't specify the opt-out surface. PR 5.1 codifies "default ON when signed in; user can toggle OFF independently."
- **JSON-body cookie passing** (vs Set-Cookie) is an implementation detail — spec §6.9 doesn't dictate the wire format.

### Depends on

PR 1.26 (AccountService PKCE flow), PR 4.3 (heartbeat method + os8.ai endpoint). Independent of every other Phase 5 PR.

### Open sub-questions

1. **Cookie expiry handling.** os8.ai sessions are typically 30 days. When the cookie expires, the heartbeat returns 401; PR 5.1 silently fails. **Recommendation:** on first 401 after a successful heartbeat, clear the column + set a `account.session_expired = 1` flag; the renderer surfaces a "Sign in again to keep your installed-apps badge" notice. Deferred to a follow-up if 5.1 ships clean; current behavior (silent skip) is acceptable for v1.2 since the worst case is a stale badge.
2. **Should we also persist a refresh token?** os8.ai uses NextAuth v5 with no refresh-token rotation by default. **Recommendation:** ship without; revisit if 30-day expiry causes friction.

---

## PR 5.2 — `@os8/sdk-types@1.0.0` published to npm + drift CI tightened

**Goal.** Phase 4 PR 4.9 created the `os8ai/os8-sdk-types` repo, ships a `release.yml` workflow that publishes on `git tag v*`, and added `tools/check-sdk-drift.js` to the desktop's CI. The package is **not yet published** — the registry returns 404 for `@os8/sdk-types`. Phase 5 closes that gap: add the `NPM_TOKEN` secret to the repo, mirror the canonical `.d.ts` from `os8/src/templates/os8-sdk.d.ts` into the package, and push `v1.0.0`. Also tighten drift-check CI so it cross-references all three sources (preload + in-folder `.d.ts` + published package).

### Files (in `os8/`)

- **Modify:** `/home/leo/Claude/os8/tools/check-sdk-drift.js` — add a `--include-published` mode that fetches `@os8/sdk-types@latest` from the npm registry and compares against the local `src/templates/os8-sdk.d.ts`. Errors with a clear "publish a new tag to os8ai/os8-sdk-types" message on divergence.
- **Modify:** `/home/leo/Claude/os8/.github/workflows/ci.yml` — the existing `check:sdk-drift` step (added in PR 4.9) gets a follow-up step that runs `npm run check:sdk-drift -- --include-published`. The follow-up step is `continue-on-error: true` initially (so a desktop PR doesn't have to wait for an npm publish to land) but logs a warning that gets noisier as drift accumulates.

### Files (in `os8ai/os8-sdk-types`)

- **Modify:** `package.json` — bump `version` to `1.0.0`. Set `"files": ["index.d.ts", "README.md", "CHANGELOG.md"]` to keep the package small.
- **Modify:** `index.d.ts` — must match `os8ai/os8/src/templates/os8-sdk.d.ts` byte-for-byte. PR 5.2's commit copies the canonical file in via `tools/sync-from-os8.sh` (a small bash helper added in this PR).
- **Modify:** `README.md` — quickstart, capability reference, MCP module-augmentation example.
- **Modify:** `CHANGELOG.md` — `1.0.0` entry summarizing the v1 SDK shape.
- **Add:** `tools/sync-from-os8.sh` — single-purpose helper: clones os8 at the latest tag (defaults to current HEAD), copies the canonical `.d.ts`, prints a diff. Run on a release branch; the actual publish workflow trips on the `git tag v*` push.

### Repo settings (one-time, ops)

- Add `NPM_TOKEN` secret to `os8ai/os8-sdk-types` Actions secrets. The token must have `automation` scope (or equivalent) on `@os8` org.
- Verify the workflow's `permissions: { id-token: write }` block (already in `release.yml` per PR 4.9) — `npm publish --provenance` requires this.

### Drift-check `--include-published` mode

```js
// tools/check-sdk-drift.js — addition
const argv = process.argv.slice(2);
const INCLUDE_PUBLISHED = argv.includes('--include-published');

if (INCLUDE_PUBLISHED) {
  const fetch = require('node:https').get;  // or use fetch directly on Node 22
  const tarballUrl = await fetchLatestTarballUrl('@os8/sdk-types');
  if (!tarballUrl) {
    console.warn('drift-check: @os8/sdk-types not yet published — skipping published comparison');
    process.exit(0);  // soft fail so PRs aren't blocked pre-publish
  }
  const publishedDts = await downloadAndExtract(tarballUrl, 'package/index.d.ts');
  const localDts = fs.readFileSync(DTS_PATH, 'utf8');
  if (publishedDts !== localDts) {
    console.error('drift-check: src/templates/os8-sdk.d.ts diverges from @os8/sdk-types@latest');
    console.error('Fix: cut a new release of os8ai/os8-sdk-types matching the local file.');
    process.exit(1);
  }
}
```

### Release sequence

1. PR 5.2 lands in `os8/main` first (drift-check tightening).
2. Open a PR on `os8ai/os8-sdk-types` syncing the canonical `.d.ts` (run `tools/sync-from-os8.sh`).
3. Land that PR.
4. `git tag v1.0.0 && git push --tags` from the os8-sdk-types repo.
5. The release workflow fires; npm publish completes with provenance.
6. Re-run the os8 CI; `check:sdk-drift --include-published` now passes (no drift between local + published).

### Tests

`tools/__tests__/check-sdk-drift.test.js`:

| Scenario | Assertion |
|---|---|
| Local `.d.ts` matches published | exits 0 |
| Local diverges by one method | exits 1 with the divergent symbol named |
| Package not yet published (404) | exits 0 with a soft warning |

### Acceptance criteria

- `https://www.npmjs.com/package/@os8/sdk-types` returns the v1.0.0 page (instead of 404).
- `npm install -D @os8/sdk-types` in a TypeScript project gives `window.os8.*` autocomplete.
- The desktop CI's `check:sdk-drift --include-published` passes after the v1.0.0 publish.
- A subsequent PR that adds a new method to the preload SDK (without bumping the package) trips the drift check with a "publish a new tag" hint.

### Cross-platform notes

None — npm publish is platform-agnostic. CI runs on `ubuntu-latest` for the drift check.

### Spec deviations

- **None** — PR 5.2 is the operational close-out of PR 4.9's ship.

### Depends on

PR 4.9 (`os8ai/os8-sdk-types` repo, drift-check tool, release workflow). Independent of every other Phase 5 PR.

### Open sub-questions

1. **Should the desktop pin a specific `@os8/sdk-types` version in `peerDependencies`?** Currently nothing pins it. **Recommendation:** add `"peerDependencies": { "@os8/sdk-types": ">=1.0.0 <2.0.0" }` to `os8/package.json` as part of this PR — declares the compatibility envelope without bundling.
2. **Should drift-check fail loud (exit 1) immediately, or stay soft (continue-on-error) for one release?** **Recommendation:** stay soft for the first 30 days post-publish; flip to hard after the npm publish has been stable.

---

## PR 5.3 — `OS8_4_6_STRICT=1` env flip in E2E workflow + spec flesh-out

**Goal.** Phase 4 PR 4.10 scaffolded the Playwright-Electron harness with `@strict`-tagged specs gated on `process.env.OS8_4_6_STRICT === '1'` so the harness could land before PR 4.6 flipped the strict middleware. PR 4.6 has now landed (`requireAppContext` is strict on `main`), but the E2E workflow at `.github/workflows/e2e.yml` does not set `OS8_4_6_STRICT=1`, so the strict-mode assertions are still silently skipped in CI. PR 5.3 sets the env, fleshes out the install + dev-import + native-app specs that currently `.skip()`, and (best-effort) adds `windows-2022` to the E2E matrix.

### Files

- **Modify:** `/home/leo/Claude/os8/.github/workflows/e2e.yml` — add `env: { OS8_4_6_STRICT: '1' }` at the job level. Add `windows-2022` to `strategy.matrix.os` with `continue-on-error: true` initially.
- **Modify:** `/home/leo/Claude/os8/tests/e2e/playwright/specs/native-app-load.spec.ts` — remove the `.skip()`; flesh out per the spec sketch already in the file (scaffold a native React app via `/api/apps`, navigate to `/<id>/`, assert `#root` is rendered).
- **Create:** `/home/leo/Claude/os8/tests/e2e/playwright/specs/install-verified.spec.ts` — install worldmonitor end-to-end against the catalog + assert the app icon appears + open it + verify proxy URL + verify scoped API call works.
- **Create:** `/home/leo/Claude/os8/tests/e2e/playwright/specs/dev-import.spec.ts` — paste a small public-repo URL into the dev-import modal, walk through the high-friction install plan, install, verify icon.
- **Modify:** `/home/leo/Claude/os8/tests/e2e/playwright/specs/scoped-api.spec.ts` — remove the `@strict` tag from the assertions that should now always pass (since strict middleware is the production behavior); keep the env-gated path only for cases where we need to assert against the legacy permissive behavior (testing the rollback escape hatch).

### Workflow change

```yaml
# .github/workflows/e2e.yml — addition
jobs:
  e2e:
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-22.04, macos-14]
        # PR 5.3 — Windows joins as best-effort; promote to gating once a
        # full run is green. Playwright-Electron on Windows occasionally
        # needs --no-sandbox flags; bootOs8 already conditional-passes.
        include:
          - os: windows-2022
            continue-on-error: true
    timeout-minutes: 25
    env:
      # PR 5.3 — strict-mode flip is now the production behavior; specs
      # that test the post-PR 4.6 origin allowlist run unconditionally.
      OS8_4_6_STRICT: '1'
```

### Install-verified spec — sketch

```ts
// tests/e2e/playwright/specs/install-verified.spec.ts (full ~120 LOC)
import { test, expect } from '@playwright/test';
import { bootOs8, closeOs8, getOs8Port, type BootedOs8 } from '../setup';

test.describe('Verified install: worldmonitor end-to-end', () => {
  let booted: BootedOs8 | null = null;

  test.afterEach(async () => {
    await closeOs8(booted);
    booted = null;
  });

  test('catalog browse → install → run → scoped api call', async () => {
    booted = await bootOs8();
    const { window } = booted;

    // Trigger catalog sync to populate worldmonitor row.
    await window.evaluate(() => window.electronAPI.appStore.syncChannelNow('verified'));
    await window.waitForFunction(() =>
      document.querySelector('[data-app-card="worldmonitor"]')
    );

    await window.click('[data-app-card="worldmonitor"]');
    await window.click('[data-action="install"]');
    await expect(window.locator('.install-plan-modal__name')).toContainText(/worldmonitor/i);
    await window.click('[data-action="approve-install"]');

    // 5-min timeout for cold npm install. CI runners are often slower.
    await window.waitForFunction(
      () => document.querySelector('.install-plan-modal__state')?.textContent?.match(/installed|active/i),
      { timeout: 5 * 60 * 1000 }
    );

    await expect(window.locator('[data-app-slug="worldmonitor"]')).toBeVisible();
  });
});
```

### Spec flesh-out — what each spec proves

| Spec | What it asserts | Why it matters |
|---|---|---|
| `install-verified.spec.ts` | Catalog → install → icon → open → scoped API works | Regression guard for the install pipeline; catches scoped-API or proxy regressions |
| `dev-import.spec.ts` | Paste GitHub URL → high-friction modal → install | Regression guard for the dev-import flow; catches drafter or gate-evaluation regressions |
| `native-app-load.spec.ts` | Native React app loads at bare-localhost origin | Regression guard for PR 4.6 strict middleware — catches "we accidentally broke the shell origin allowlist" |
| `scoped-api.spec.ts` (existing) | Origin allowlist accept/reject behavior | Already in tree; PR 5.3 removes the env guard so it always asserts |

### Tests

The PR's tests **are** Playwright tests. No vitest changes.

### Smoke gate

**G2: Strict-env E2E suite passes on every OS in the gating matrix (Linux + macOS).** Runs as the gate of this PR — must be green before merge. Windows is `continue-on-error: true` initially; if it goes red, file a follow-up issue and proceed.

### Acceptance criteria

- `.github/workflows/e2e.yml` has `OS8_4_6_STRICT: '1'` at the job env level.
- `windows-2022` is in the matrix as `continue-on-error: true`.
- `install-verified.spec.ts`, `dev-import.spec.ts`, `native-app-load.spec.ts` all assert real behavior (no `.skip()`).
- The full `npm run test:e2e` suite passes on Linux + macOS.
- A subsequent PR that breaks the bare-localhost origin allowlist (e.g. accidentally removing the `localhost` entry from `originIsTrusted`) fails the suite within ~3 minutes.

### Cross-platform notes

- `bootOs8` already handles cross-platform Electron launch flags.
- Windows: Playwright-Electron may need `--no-sandbox` flag. If `windows-2022` job fails on harness boot, add the conditional flag in `setup.ts` (cross-OS branching).
- `xvfb-run -a` continues to wrap the Linux job; macOS uses native window server; Windows uses native too.

### Spec deviations

- **`continue-on-error: true` for Windows initially** is a deliberate scope cut to ship Linux + macOS gating without blocking on Windows-Playwright instability. Phase 4 PR 4.8 promised Windows would join "once 4.8 stabilizes." PR 5.3 takes the next step (in matrix, best-effort); a follow-up flips to gating after one stable green run.

### Depends on

PR 4.10 (harness scaffold), PR 4.6 (strict middleware live), PR 4.8 (Windows ABI baseline). Independent of every other Phase 5 PR.

### Open sub-questions

1. **Should the install-verified spec run against catalog or fixture?** Catalog (worldmonitor) is realistic but depends on the os8.ai sync being healthy; fixture (`os8ai/playwright-fixtures`) is faster and offline. **Recommendation:** ship with catalog because that's what regressions actually look like; fixture as a follow-up if catalog dependency causes flake.
2. **Should we add an explicit Windows-gating timeline?** **Recommendation:** "after one full green Windows run on `main`" — encode in the workflow comment. Phase 6 picks up the gating flip if Phase 5 closes without it happening organically.

---

## PR 5.4 — Three-way merge UI for updates with user edits

**Goal.** Spec §6.9 says: *"If `user_branch` exists: three-way merge `user/main` onto `<targetCommit>`. Clean → prompt accept. Conflict → surface in app's source sidebar with `git status` summary; user resolves manually."* PR 1.25 wired the backend half (`AppCatalogService.update` performs the merge, stores `update_status='conflict'` on failure, returns the conflicted file list to the caller). The renderer-side surface — "your update conflicts; here are the files; mark resolved when done" — was deferred. With Phase 4 PR 4.2 shipping auto-update, conflicts now happen *automatically* during the daily catalog tick, with no UI to resolve them. PR 5.4 closes the loop.

This is the deferred-items #10 promotion.

### Files

- **Modify:** `/home/leo/Claude/os8/src/services/app-catalog.js:497-570` — `update()` now persists the conflicted file list to the new `apps.update_conflict_files` JSON column (added in PR 5.10). On success path, clears the column.
- **Create:** `/home/leo/Claude/os8/src/services/app-merge-resolver.js` — small helper service: `getConflictState(db, appId)` reads the apps row + runs `git status --porcelain` to enumerate currently-conflicted files; `markAllResolved(db, appId)` runs `git add -u && git commit -m '[user] resolved merge from <targetCommit>'`; `abortMerge(db, appId)` runs `git merge --abort` and clears `update_status`.
- **Create:** `/home/leo/Claude/os8/src/routes/apps.js` (modify) — `GET /api/apps/:id/merge-state`, `POST /api/apps/:id/merge-state/mark-resolved`, `POST /api/apps/:id/merge-state/abort`.
- **Create:** `/home/leo/Claude/os8/src/renderer/merge-conflict-banner.js` — banner that renders at the top of the app's source sidebar when `apps.update_status === 'conflict'`. Lists each conflicted file with an "Open in editor" link (which opens the file in dev-mode's existing source view, where the user can resolve manually using normal `<<<<<<<` markers).
- **Modify:** `/home/leo/Claude/os8/src/renderer/apps.js` — when an app's `update_status === 'conflict'`, render a small red dot on the home-screen icon (overlay similar to `update_available` dot from PR 1.25).
- **Modify:** `/home/leo/Claude/os8/src/renderer/toast.js` — extend the auto-update toast subscriber to also handle `'auto-update-conflict'` events (toast: "<slug> needs your help resolving an update conflict — open the app to review").
- **Modify:** `/home/leo/Claude/os8/src/services/app-auto-updater.js` — when `processAutoUpdates` skips an app because the update returns `{ kind: 'conflict' }`, also broadcast a `auto-update-conflict` IPC event so the toast fires.
- **Modify:** `/home/leo/Claude/os8/styles/components.css` — banner + dot styles.
- **Doc:** new section in `docs/auto-update.md` (PR 5.D2) describing the conflict resolution flow.

### Conflict-state contract

```js
// src/services/app-merge-resolver.js — sketch
class AppMergeResolver {
  /**
   * Return the current merge state for an app.
   *   - status: 'clean' | 'conflict' | 'unknown'
   *   - targetCommit: the SHA the auto-updater tried to merge in
   *   - files: [{ path, status: 'UU' | 'AA' | 'DD' | 'UA' | 'AU' | 'DU' | 'UD' }]
   *
   * Reads the persisted state from the apps row first (cheap) and verifies
   * against `git status --porcelain` (authoritative). If they disagree
   * (e.g. user resolved manually outside the UI), prefers git's view and
   * updates the apps row.
   */
  static async getConflictState(db, appId) { /* ... */ }

  /**
   * Mark all currently-conflicted files as resolved (`git add -u`),
   * commit with a generated message, and clear the apps row's
   * update_status. Throws if any file is still conflicted (per `git status`).
   */
  static async markAllResolved(db, appId, { resolvedBy = 'user' } = {}) { /* ... */ }

  /**
   * Abort the in-progress merge (`git merge --abort`), reverting `user/main`
   * to its pre-merge state. Clears apps.update_status + update_conflict_files.
   */
  static async abortMerge(db, appId) { /* ... */ }
}
```

The implementation reuses the same `spawn('git', ...)` helper pattern from `AppCatalogService.update`. Each invocation is a single git command — no transactions, no atomicity concerns; the user can re-run any operation.

### Banner rendering

```js
// src/renderer/merge-conflict-banner.js — sketch
async function renderMergeConflictBanner(app) {
  const state = await fetch(`/api/apps/${app.id}/merge-state`).then(r => r.json());
  if (state.status !== 'conflict') return '';

  return `
    <div class="merge-conflict-banner">
      <div class="merge-conflict-banner__header">
        <strong>Update conflict</strong>
        <span class="merge-conflict-banner__sub">
          OS8 tried to update this app to <code>${shortSha(state.targetCommit)}</code> but
          ${state.files.length} file(s) need your attention.
        </span>
      </div>
      <ul class="merge-conflict-banner__files">
        ${state.files.map(f => `
          <li>
            <code>${escapeHtml(f.path)}</code>
            <span class="merge-conflict-banner__status">${conflictStatusLabel(f.status)}</span>
            <button data-action="open-file" data-path="${escapeAttr(f.path)}">Open</button>
          </li>
        `).join('')}
      </ul>
      <div class="merge-conflict-banner__actions">
        <button class="action-button action-button--primary" data-action="mark-resolved">
          I've resolved all conflicts — commit
        </button>
        <button class="action-button" data-action="abort-merge">
          Abort the update
        </button>
      </div>
      <p class="merge-conflict-banner__hint">
        Open each conflicted file (or ask Claude Code to). Look for <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code>
        markers; remove them, keep the version you want, and save. Then click
        "I've resolved all conflicts."
      </p>
    </div>
  `;
}
```

### Telemetry hook

PR 5.4 enqueues two new telemetry kinds (per PR 4.4's allowlist sanitizer):

- `update_conflict` — emitted when `AppAutoUpdater` hits a conflict. Fields: `slug`, `commit`, `failurePhase: 'merge'`, `conflictFileCount` (added to PR 4.4's allowlist as a small numeric).
- `update_conflict_resolved` — emitted when `markAllResolved` succeeds. Same fields plus `resolvedBy`.

This lets the curator dashboard surface "what % of auto-updates conflict" — feeds future decisions about merge strategy.

### Tests

`tests/app-merge-resolver.test.js`:

| Scenario | Assertion |
|---|---|
| `getConflictState` on a clean repo | `status: 'clean'` |
| `getConflictState` after a forced conflict | `status: 'conflict'`, files match `git status --porcelain` UU/AA entries |
| `markAllResolved` after `git add` of all conflicted files | clears `update_status`; commit appears in log |
| `markAllResolved` with files still conflicted | throws "files still conflicted" error |
| `abortMerge` from conflict state | restores `user/main` to pre-merge HEAD |
| `getConflictState` reconciles persisted-vs-git divergence | persisted state updated to match git |

`tests/auto-updater.conflict-event.test.js`:

| Scenario | Assertion |
|---|---|
| `processAutoUpdates` hits conflict | broadcasts `auto-update-conflict` IPC event |
| Non-conflict skip (e.g. `user_branch` set, no edit) | does not broadcast conflict event |

### Smoke gate

**G3: Manual conflict resolution smoke required before PR 5.7 merges.** Use worldmonitor as the test app:

1. Install worldmonitor, enable Auto-Update.
2. Edit a file in `~/os8/apps/<id>/` (e.g. add a comment to `src/App.tsx`); commit auto-fires via the chokidar watcher.
3. Bump the worldmonitor manifest in `os8ai/os8-catalog` to a SHA whose `App.tsx` also changed (any real upstream commit will do).
4. Wait for next catalog tick (or trigger Sync Now from PR 5.6).
5. Verify: toast "worldmonitor needs your help resolving an update conflict" appears; home-screen icon shows the red dot.
6. Open worldmonitor; see the merge-conflict banner listing `src/App.tsx`.
7. Click Open; resolve manually; click "I've resolved all conflicts."
8. Verify: banner clears; `git log` shows the merge commit; the app reloads at the new content.

### Acceptance criteria

- Conflict state persists across OS8 restarts (`update_conflict_files` JSON in DB).
- Banner renders at the top of the app's source sidebar in dev mode AND in the install-plan-modal-style overlay when the app is opened from the home screen.
- "Mark resolved" runs `git add -u && git commit` and clears the conflict state.
- "Abort the update" runs `git merge --abort` and clears the conflict state without committing.
- Auto-update conflicts emit a toast (when notification setting is on) and a home-screen dot (always).
- Telemetry events fire (when telemetry is opted in).

### Cross-platform notes

- All git operations work identically across platforms.
- The "Open file" link uses the existing dev-mode source viewer (cross-platform per PR 1.22).
- Toast notification + dot rendering inherit from PR 4.2 cross-platform CSS.

### Spec deviations

- **`update_conflict_files` JSON column is new.** Spec §6.9 sketches the merge UI but doesn't specify how state persists across restarts. PR 5.10 adds the column.
- **Telemetry kinds `update_conflict` / `update_conflict_resolved`** are new — PR 4.4's allowlist gets two additions. Documented in PR 5.D1's spec update.

### Depends on

PR 1.25 (`AppCatalogService.update` 3-way merge backend), PR 4.2 (auto-updater + toast subscriber), PR 5.10 (`update_conflict_files` column). **Required by PR 5.7 (community auto-update needs the conflict UI as the recovery path).**

### Open sub-questions

1. **Should the banner offer "Use upstream version" / "Use my version" per file?** Most users won't be deep enough in git to know what those mean. **Recommendation:** ship the manual-edit flow first; add per-file "ours/theirs" buttons in a polish PR if smoke surfaces friction.
2. **Should we wire Claude Code into the resolution flow?** A "Have Claude resolve this" button could trigger a code-action with the agent in the user's existing dev-mode session. **Recommendation:** ship without; promote if the manual-resolve workflow proves painful in real use. The conflict markers are perfectly readable to LLMs already.

---

## PR 5.5 — Reinstall-from-orphan restore UI

**Goal.** Spec §6.10: *"Reinstall detects orphan data (rows with `status='uninstalled'` and matching `external_slug`) and prompts to restore."* PR 1.24 shipped the uninstall side (tiered, default-preserve, `apps.status='uninstalled'`); the reinstall side was deferred (deferred-items #12). Today, when a user uninstalls then reinstalls the same app, they get a fresh install — their preserved blob storage, per-app SQLite, and per-app secrets are stranded on disk with no path to recover them. PR 5.5 closes the loop.

### Files

- **Modify:** `/home/leo/Claude/os8/src/services/app-catalog.js:install` — before creating the install job, check for `(external_slug, channel, status='uninstalled')` rows. If one exists, surface its `appId` + the existence of preserved data dirs + the `app_env_variables` rows in the install job's metadata (a new `orphan` field on the install job state).
- **Modify:** `/home/leo/Claude/os8/src/services/app-installer.js` — the install job, when it detects an orphan, pauses at `awaiting_approval` with the orphan info attached to the job state. After approval, if the user opted to restore, the job: (a) reuses the orphan's appId, (b) skips the data-dir initialization step, (c) marks the orphan row `status='active'` (in-place revival) instead of creating a new row.
- **Modify:** `/home/leo/Claude/os8/src/renderer/install-plan-modal.js` — when the job state includes an orphan, render a "Previous data found" section with: "You previously installed `<App>`. Your data is preserved at `<blobDir>` (`<size>` MB) plus `<N>` saved secrets and a `<size>` MB database. Restore on install?" — checkbox defaults ON.
- **Modify:** `/home/leo/Claude/os8/src/services/app.js` — add `getOrphan(db, externalSlug, channel)` that returns `{ appId, blobDir, dbPath, secretCount, totals }` or null.

### Orphan detection contract

```js
// src/services/app.js — addition
class AppService {
  // ...existing

  /**
   * Find the most recent uninstalled-but-preserved app matching slug + channel.
   * Returns null if none exists.
   *
   * Includes byte sizes for the install plan modal — small extra cost that
   * makes the "restore?" prompt informative.
   */
  static getOrphan(db, externalSlug, channel) {
    const row = db.prepare(`
      SELECT id, external_slug, channel, updated_at
        FROM apps
       WHERE app_type = 'external'
         AND status = 'uninstalled'
         AND external_slug = ?
         AND channel = ?
       ORDER BY updated_at DESC
       LIMIT 1
    `).get(externalSlug, channel);
    if (!row) return null;

    const appId = row.id;
    const blobDir = path.join(BLOB_DIR, appId);
    const dbPath = path.join(CONFIG_DIR, 'app_db', `${appId}.db`);
    const blobSize = dirSize(blobDir);
    const dbSize = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
    const secretCount = db.prepare(
      `SELECT COUNT(*) AS n FROM app_env_variables WHERE app_id = ?`
    ).get(appId)?.n ?? 0;

    return {
      appId,
      blobDir, blobSize,
      dbPath, dbSize,
      secretCount,
      uninstalledAt: row.updated_at,
    };
  }
}
```

### Install-plan-modal section

```html
<!-- install-plan-modal.js renderOrphanSection — sketch -->
<section class="install-plan-modal__orphan">
  <h3>Previous data found</h3>
  <p>
    You previously installed <strong>${app.name}</strong> on
    <time>${formatDate(orphan.uninstalledAt)}</time>. Your data was preserved
    when you uninstalled.
  </p>
  <ul>
    <li><strong>${formatBytes(orphan.blobSize)}</strong> in blob storage</li>
    <li><strong>${formatBytes(orphan.dbSize)}</strong> in the per-app database</li>
    <li><strong>${orphan.secretCount}</strong> saved secret(s) — values preserved; will not re-prompt</li>
  </ul>
  <label class="install-plan-modal__orphan-toggle">
    <input type="checkbox" data-action="restore-data" ${state.restoreOrphan ? 'checked' : ''} />
    <span>Restore my previous data</span>
  </label>
  <p class="install-plan-modal__orphan-hint">
    If you uncheck this box, OS8 will install fresh and your previous data
    will remain on disk under <code>${orphan.blobDir}</code> until you
    manually delete it.
  </p>
</section>
```

### Installer integration

When the user approves the install with `restoreOrphan: true`, the installer:

1. Skips the `apps` row insert; updates the orphan row in place (`status='uninstalled'` → `status='active'`, refresh `manifest_yaml`, `upstream_resolved_commit`, `manifest_sha`).
2. Skips the `BLOB_DIR/<id>/` initialization (it already exists with the user's data).
3. Skips re-prompting for declared secrets; uses the existing `app_env_variables` rows.
4. Otherwise runs the normal install pipeline (clone into `apps_staging`, security review, runtime adapter install, atomic move into `~/os8/apps/<orphanAppId>/`).

When `restoreOrphan: false`, the installer:

1. Creates a fresh `apps` row (new appId, blob/db dirs initialized empty).
2. Marks the orphan row `status='archived'` (or leaves at `uninstalled` — see open question).
3. Does NOT delete the orphan's data dirs (user's call).

### Tests

`tests/app-orphan-detection.test.js`:

| Scenario | Assertion |
|---|---|
| `getOrphan` with no uninstalled row | returns null |
| `getOrphan` with multiple uninstalled rows | returns most recent |
| `getOrphan` with mismatched channel | returns null |
| `getOrphan` includes byte sizes for blob + db | sizes are accurate |

`tests/installer.orphan-restore.test.js`:

| Scenario | Assertion |
|---|---|
| Install with orphan + restoreOrphan=true | apps row revived (same id); blob/db preserved |
| Install with orphan + restoreOrphan=false | new apps row; orphan stays uninstalled |
| Install when orphan has different upstream commit | restored row has new commit; data preserved |

`tests/install-plan-modal.orphan-section.test.js` (manual smoke):
- Modal renders orphan section when orphan exists; checkbox defaults ON.
- Modal does not render orphan section when no orphan.
- Toggling checkbox updates state.

### Smoke gate

**G4: Uninstall→reinstall data restore smoke required.**

1. Install worldmonitor.
2. Open it; let it create some data (visit the app, fetch news; it persists state in localStorage / the browser's IndexedDB scoped to the subdomain).
3. Right-click → Settings → Uninstall (default; preserves data).
4. Confirm app is gone from home screen.
5. Re-install worldmonitor from the catalog.
6. Verify: install plan modal shows "Previous data found" with non-zero blob bytes.
7. Approve with checkbox ON.
8. Open worldmonitor; verify the previous browser-side state is intact (if applicable for this app); verify per-app DB rows from before are queryable.

### Acceptance criteria

- Uninstall → reinstall the same slug shows "Previous data found" in the install plan modal with accurate byte counts.
- Approve with restore-on: app revives at the same appId; blob + db + secrets preserved.
- Approve with restore-off: fresh install at a new appId; orphan data left on disk.
- Multiple uninstalled rows for the same slug → restore only the most recent.
- Orphan from a different channel is NOT proposed (Verified uninstall, Community reinstall = fresh).

### Cross-platform notes

- Byte-size calculation uses `fs.statSync` + recursive walk; identical across platforms.
- Path joins use `path.join` (cross-platform).

### Spec deviations

- **`status='archived'` for skipped orphans** is new — spec §6.10 doesn't specify what happens to an orphan row when the user reinstalls without restoring. PR 5.5 marks it `archived` so a future "manage uninstalled apps" UI can prune.
- **Channel-scoped orphan matching** (Verified orphan ≠ Community reinstall) is new — spec is silent. Decision: trust grants differ across channels, so cross-channel restoration would silently elevate trust. Safer to fresh-install.

### Depends on

PR 1.24 (uninstall preserves data + sets `status='uninstalled'`), PR 1.16 (install pipeline + plan modal), PR 5.10 (`app_store.orphan_restore.prompt` setting). Independent of PR 5.4.

### Open sub-questions

1. **Should there be a "manage uninstalled apps" surface in Settings?** Lets users see what data is preserved + manually delete. **Recommendation:** ship without; deferred-items #12 already covers this. Promote if users complain about disk pressure from preserved data.
2. **What if the orphan's preserved data is huge (multi-GB)?** Current modal just prints the byte count. **Recommendation:** add a "consider deleting" hint when total > 1 GB; ship without if scope tight.

---

## PR 5.6 — Catalog "Sync Now" button + per-install lazy refresh

**Goal.** Deferred-items #32. The Phase 3.5.5 incident: Leo updated `linkding`'s manifest in the community catalog to add `LD_SUPERUSER_*` secrets, but a freshly-restarted desktop showed the old manifest because `app_catalog` only refreshes once daily (4am local) or on community-channel toggle. There's no in-UI button to force a sync; `AppCatalogService.get()` returns the cached `manifest_yaml` without re-checking upstream. The IPC handler `app-store:sync-channel-now` already exists at `src/ipc/app-store.js:181` from PR 3.5 — no UI calls it from the catalog browser.

### Files

- **Modify:** `/home/leo/Claude/os8/src/renderer/apps.js` (catalog browser modal) — add a "Sync Now" button next to the channel filter pills. Calls `app-store:sync-channel-now` for the currently-active channel; spinner during sync; toast on completion (`+5 -1` count from sync result).
- **Modify:** `/home/leo/Claude/os8/src/services/app-catalog.js:get` — extend with `{ refreshIfOlderThan }` option. When the local row's `synced_at` is older than the threshold (default 5 min), re-fetch the manifest from os8.ai before returning. Cache miss falls back to current behavior (return cached or 404).
- **Modify:** `/home/leo/Claude/os8/src/services/app-installer.js` — when an install is requested via the install-plan modal, call `AppCatalogService.get(db, slug, { refreshIfOlderThan: 5 * 60_000 })` before reading the manifest. Catches the "manifest just changed" gap.
- **Modify:** `/home/leo/Claude/os8/styles/components.css` — Sync Now button styles (positioned next to channel pills).

### Lazy refresh contract

```js
// src/services/app-catalog.js — extension to get()
async get(db, slug, { refreshIfOlderThan = null } = {}) {
  const row = db.prepare(`SELECT * FROM app_catalog WHERE slug = ?`).get(slug);

  if (refreshIfOlderThan != null && row) {
    const age = Date.now() - new Date(row.synced_at).getTime();
    if (age > refreshIfOlderThan) {
      try {
        // Re-fetch this single manifest from os8.ai. Cheap (one HTTP call).
        const fresh = await this.fetchManifest(slug, row.channel);
        if (fresh && fresh.manifest_sha !== row.manifest_sha) {
          // Upstream changed since our last sync. Upsert + refresh row.
          this._upsertOne(db, fresh);
          return this._parseRow(this._loadRow(db, slug));
        }
      } catch (err) {
        // Network failure — fall back to cached row. Best-effort refresh.
        console.warn(`[AppCatalog] lazy refresh failed for ${slug}: ${err.message}`);
      }
    }
  }

  return row ? this._parseRow(row) : null;
}
```

The 5-minute window is short enough to catch active-development cycles (manifest tweaked → install attempted within a few minutes) but long enough to avoid hammering os8.ai during normal browse-then-install flow.

### Sync Now button — UI

```html
<!-- catalog-browser.html — addition near channel pills -->
<div class="catalog-browser__sync">
  <button class="action-button action-button--small" data-action="sync-now"
          title="Re-sync this channel from os8.ai">
    <span class="icon">⟳</span> Sync Now
  </button>
  <span class="catalog-browser__sync-status" hidden></span>
</div>
```

```js
// src/renderer/apps.js — handler
async function onSyncNowClick() {
  const channel = getCurrentChannel();
  setSyncStatus('Syncing…');
  try {
    const r = await window.electronAPI.appStore.syncChannelNow(channel);
    if (r.ok) {
      setSyncStatus(`+${r.added} updated:${r.updated} -${r.removed}`, { autoHide: 4000 });
      await refreshCatalogGrid();
    } else {
      setSyncStatus(`Sync failed: ${r.error}`, { error: true });
    }
  } catch (err) {
    setSyncStatus(`Sync failed: ${err.message}`, { error: true });
  }
}
```

### Tests

`tests/app-catalog.lazy-refresh.test.js`:

| Scenario | Assertion |
|---|---|
| `get(slug)` without `refreshIfOlderThan` | returns cached row, no fetch |
| `get(slug, { refreshIfOlderThan: 60_000 })` row younger than 60s | returns cached, no fetch |
| Same call with row older than 60s, upstream unchanged | returns cached row, fetch made + ignored |
| Same call, upstream changed | row upserted, fresh manifest returned |
| Same call, fetch fails (timeout) | returns cached row, warn logged |

### Acceptance criteria

- Catalog browser shows a Sync Now button.
- Clicking Sync Now triggers a sync of the active channel + refreshes the grid.
- An install kicked off within 5 minutes of a manifest change picks up the new manifest without manual sync.
- Sync failures (network) toast a clear message; cached state remains usable.

### Cross-platform notes

None — UI + IPC are platform-agnostic.

### Spec deviations

- **5-minute lazy-refresh window** is implementation choice; spec is silent.
- **Per-install lazy refresh** isn't specced — added because it covers the Phase 3.5.5 incident's scenario without requiring the user to know to click Sync Now first.

### Depends on

PR 3.5 (sync-channel-now IPC handler exists). Independent of every other Phase 5 PR.

### Open sub-questions

1. **Should the lazy refresh fire on home-screen "Update available" check too?** Currently the daily catalog sync sets `update_available`; lazy refresh in `get()` doesn't update that flag. **Recommendation:** ship without; PR 5.D1 documents this as a known interaction gap if it surfaces in practice.
2. **Should Sync Now also force an os8.ai-side cron tick?** **Recommendation:** no; the catalog repo's webhook already triggers os8.ai sync; clients pull from os8.ai's mirror. Forcing the website would just hide local-cache misses.

---

## PR 5.7 — Community-channel auto-update opt-in

**Goal.** Spec §6.9: *"Verified-channel apps with `auto_update = 1` (default OFF) … only auto-applies if `user_branch` is null."* Phase 4 PR 4.2 implemented this for Verified only. Deferred-items #11 asks whether Community-channel apps should also support auto-update — the answer was deferred until #10 (three-way merge UI) shipped, because conflicts are more likely on community apps (lighter curation = more upstream churn). With PR 5.4 landing, conflicts have a recovery path. PR 5.7 widens the auto-updater's filter to `verified` + `community`, gated by a new opt-in setting.

### Files

- **Modify:** `/home/leo/Claude/os8/src/services/app-auto-updater.js:listEligible` — change the WHERE clause from `channel = 'verified'` to `channel IN ('verified', 'community')`, AND only when the per-channel setting is enabled.
- **Modify:** `/home/leo/Claude/os8/src/renderer/app-settings-flyout.js` — extend the auto-update toggle's hint text + interactivity. For Verified: same as today. For Community: enabled when `app_store.auto_update.community_enabled = true`, disabled with explanatory hint otherwise. For Developer Import: still disabled.
- **Modify:** `/home/leo/Claude/os8/src/renderer/settings.js` — add a new toggle in the App Store settings section: "Allow auto-update for Community-channel apps." Defaults OFF (seeded by PR 5.10). Hint: "Community apps update less predictably than Verified. We recommend keeping this off unless you actively trust a community app's curator."
- **Modify:** `/home/leo/Claude/os8/index.html` — settings + flyout DOM additions.

### Setting + filter contract

```js
// src/services/app-auto-updater.js — modified listEligible
function listEligible(db) {
  const SettingsService = require('./settings');
  const communityEnabled = SettingsService.get(db, 'app_store.auto_update.community_enabled') === 'true';

  return db.prepare(`
    SELECT id, external_slug, channel, upstream_resolved_commit,
           update_to_commit, user_branch, manifest_yaml
      FROM apps
     WHERE app_type = 'external'
       AND status = 'active'
       AND auto_update = 1
       AND update_available = 1
       AND update_to_commit IS NOT NULL
       AND (user_branch IS NULL OR user_branch = '')
       AND channel IN ('verified', ${communityEnabled ? "'community'" : "'__never__'"})
  `).all();
}
```

(The `__never__` placeholder is a small parameterized-SQL quirk: SQLite doesn't have `IF` in WHERE clauses, so we conditionally include `'community'` in the IN list. The comment explains.)

### Flyout hint logic

```js
// src/renderer/app-settings-flyout.js — modified hint section
function getAutoUpdateHint(channel, communityEnabled) {
  if (channel === 'verified') {
    return {
      enabled: true,
      hint: 'OS8 will auto-apply Verified-channel updates when no local edits exist.',
    };
  }
  if (channel === 'community' && communityEnabled) {
    return {
      enabled: true,
      hint: 'OS8 will auto-apply Community-channel updates when no local edits exist. Community apps update less predictably than Verified — review the source if you\'re unsure.',
    };
  }
  if (channel === 'community' && !communityEnabled) {
    return {
      enabled: false,
      hint: 'Community auto-update is disabled. Enable it in Settings → App Store.',
    };
  }
  return {
    enabled: false,
    hint: 'Auto-update is only available for Verified and Community-channel apps.',
  };
}
```

### Telemetry

PR 5.7 doesn't add new telemetry kinds — auto-update events from PR 4.2 / 4.4 already include the `channel` field, so the dashboard cleanly distinguishes Verified vs Community success rates.

### Tests

`tests/app-auto-updater.community.test.js`:

| Scenario | Assertion |
|---|---|
| Community app with `auto_update=1`, community_enabled=false | not eligible |
| Same, community_enabled=true | eligible |
| Same, but user_branch set | not eligible (gate inherited from PR 4.2) |
| Mixed Verified + Community batch, community_enabled=true | both processed |
| Developer-Import app with `auto_update=1` somehow | not eligible (channel filter) |

`tests/app-settings-flyout.community-hint.test.js` (manual smoke):
- Open flyout for Verified app: hint = "Verified… auto-apply".
- Open flyout for Community app, setting OFF: hint = "Community auto-update is disabled. Enable…".
- Open flyout for Community app, setting ON: hint = "Community… less predictably".
- Toggle setting ON in Settings → reopen flyout → toggle is now interactive.

### Smoke gate

No new gate. PR 5.4's G3 (manual conflict resolution) already validates the conflict-recovery path that gates this PR.

### Acceptance criteria

- New "Allow auto-update for Community-channel apps" toggle in Settings → App Store, default OFF.
- Per-app flyout enables the auto-update toggle for Community apps when the setting is ON.
- `processAutoUpdates` includes Community apps when the setting is ON.
- Auto-update conflicts on Community apps fire the merge-conflict banner from PR 5.4.

### Cross-platform notes

None — settings + filter logic are platform-agnostic.

### Spec deviations

- **Community auto-update is new.** Spec §6.9 explicitly limits to Verified ("Verified-channel apps with `auto_update = 1`"). PR 5.D1 updates §6.9 to reflect the wider scope + the new setting.

### Depends on

PR 4.2 (auto-updater + flyout), PR 5.4 (conflict UI as the recovery path), PR 5.10 (`community_enabled` setting). Independent of PRs 5.1, 5.2, 5.3, 5.5, 5.6, 5.8, 5.9.

### Open sub-questions

1. **Should the setting default ON for users who already have a Community app installed?** Current default OFF means Community auto-update is opt-in, which is the safer posture. **Recommendation:** keep default OFF; surface the setting in PR 5.D1's user-facing docs.
2. **Should we also auto-update Developer-Import apps?** **Recommendation:** no — Dev-Import is by definition unreviewed; auto-applying changes there is unsafe. Document in PR 5.D1.

---

## PR 5.8 — Docker adapter `runtime.volumes` (catalogs + adapter wiring)

**Goal.** Deferred-items #35. The Phase 3.5.5 linkding incident: linkding writes its SQLite DB + bookmark archives to `/etc/linkding/data` inside the container, but the docker adapter only bind-mounts `~/os8/apps/<id>` → `/app` and `~/os8/blob/<id>` → `/data`. After `docker rm`, the user's bookmarks are gone. PR 5.8 adds a `runtime.volumes` field to appspec-v2 letting manifests declare additional persistent paths; the adapter mounts each entry under `${BLOB_DIR}/_volumes/${basename}`.

### Files (in `os8/`)

- **Modify:** `/home/leo/Claude/os8/src/data/appspec-v2.json` — add `runtime.volumes` array schema.
- **Modify:** `/home/leo/Claude/os8/src/services/runtime-adapters/docker.js` — read `runtime.volumes` from the manifest; for each entry, ensure `${BLOB_DIR}/_volumes/${basename}/` exists; pass `-v ${BLOB_DIR}/_volumes/${basename}:${container_path}` to `docker run`.
- **Modify:** `/home/leo/Claude/os8/src/services/manifest-validator.js` — validate the new field at install time. Reject paths that escape `/` (e.g. `..`); reject duplicate `container_path` entries.

### Files (in catalog repos)

- **Modify:** `/home/leo/Claude/os8-catalog/schema/appspec-v2.json` — same schema addition.
- **Modify:** `/home/leo/Claude/os8-catalog/.github/workflows/validate.yml` — pulls latest schema; existing CI catches regressions.
- **Modify:** `/home/leo/Claude/os8-catalog-community/schema/appspec-v2.json` — same.
- **Modify:** `/home/leo/Claude/os8-catalog-community/apps/linkding/manifest.yaml` — add `runtime.volumes: [{ container_path: "/etc/linkding/data" }]`. This is the smoke fixture for PR 5.8.

### Schema addition

```json
{
  "runtime": {
    "properties": {
      "volumes": {
        "type": "array",
        "description": "Additional container-internal paths to bind-mount into per-app blob storage. Used for apps whose data lives outside /app or /data.",
        "maxItems": 10,
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["container_path"],
          "properties": {
            "container_path": {
              "type": "string",
              "pattern": "^/[a-zA-Z0-9_/-]+$",
              "description": "Absolute path inside the container, e.g. /etc/linkding/data"
            },
            "persist": {
              "type": "boolean",
              "default": true,
              "description": "Reserved — volumes always persist in v1"
            }
          }
        }
      }
    }
  }
}
```

The `persist` field is a forward-compat flag; v1 always persists. Future versions could add `persist: false` for tmpfs-style volumes if a use case emerges.

### Adapter wiring

```js
// src/services/runtime-adapters/docker.js — addition near the docker run argv builder
function buildVolumeArgs(spec, blobDir) {
  const args = [];

  // Default mounts (existing).
  args.push('-v', `${appDir}:/app`);
  args.push('-v', `${blobDir}:/data`);

  // PR 5.8 — additional declared volumes.
  for (const vol of spec.runtime?.volumes || []) {
    const basename = path.basename(vol.container_path);
    if (!basename) continue;  // schema disallows but be defensive
    const hostDir = path.join(blobDir, '_volumes', basename);
    fs.mkdirSync(hostDir, { recursive: true });
    args.push('-v', `${hostDir}:${vol.container_path}`);
  }

  return args;
}
```

### Migration consideration

For apps installed BEFORE PR 5.8 lands, the new volumes won't have hostside dirs; first-restart after upgrade creates them empty. For linkding specifically (only known affected app at audit time), users will lose their existing `/etc/linkding/data` content unless they manually copy from the still-running container before the upgrade. **PR 5.D2's user-facing docs must call this out clearly.** Future schema-bump migrations could add a "first-restart-after-upgrade" hook to back up the container's existing volume content; out of scope for v1.

### Tests

`tests/docker-adapter.volumes.test.js`:

| Scenario | Assertion |
|---|---|
| Manifest with no `runtime.volumes` | argv unchanged from current (only `/app` + `/data`) |
| Manifest with one volume | argv includes `-v ${blobDir}/_volumes/<basename>:${path}` |
| Volume host dir doesn't exist | created at adapter start |
| Manifest with `runtime.volumes.length > 10` | rejected by validator (schema cap) |
| Volume with `..` in path | rejected by validator (regex) |

`tests/manifest-validator.volumes.test.js`:

| Volume | Validates? |
|---|---|
| `[{ container_path: "/etc/linkding/data" }]` | yes |
| `[{ container_path: "../escape" }]` | no |
| `[{ container_path: "etc/linkding" }]` | no (must start with `/`) |
| `[{ container_path: "/a" }, { container_path: "/a" }]` | no (duplicate; validator catches) |

### Smoke gate

**G5: Docker volume persistence smoke required.**

1. Install linkding from the community catalog (post-5.8 manifest with `runtime.volumes`).
2. Open it; create a few bookmarks via the linkding UI.
3. Stop the linkding container (settings → Stop).
4. Restart it; verify bookmarks persist.
5. Uninstall linkding (default = preserve data).
6. Reinstall linkding (PR 5.5's restore flow OR fresh).
7. If restore: bookmarks present. If fresh: bookmarks absent (expected — different appId, different `_volumes` dir).

### Acceptance criteria

- linkding's bookmarks persist across container restarts.
- Schema validator rejects malformed volume paths in all three repos (os8 + 2× catalog).
- linkding's manifest in `os8-catalog-community` declares the volume.
- Existing docker apps (no `runtime.volumes`) install + run unchanged.

### Cross-platform notes

- Docker on Linux/macOS: bind mounts work as-is.
- Docker on Windows: file-system passthrough has known quirks (line endings, perm models). Test linkding on `windows-2022` with Docker Desktop in WSL2 mode; document any workarounds in PR 5.D2.

### Spec deviations

- **`runtime.volumes` is a new schema field.** Spec §3.4 doesn't list it. PR 5.D1 updates the spec.
- **Host path under `${BLOB_DIR}/_volumes/${basename}`** is implementation choice. Alternative: a flat layout with full container path encoded. Chose basename for readability; collisions across volumes are caught by the schema's duplicate-detection.

### Depends on

PR 2.5 (docker adapter), PR 5.10 (schema validator update for `runtime.volumes`). Independent of every other Phase 5 PR. **Cross-repo coordination critical** — schema update lands in os8 first, then both catalog repos as separate PRs.

### Open sub-questions

1. **Should we auto-detect common framework patterns?** linkding's `/etc/linkding/data` isn't discoverable from the image alone. Some images use VOLUME instructions in their Dockerfile that we could parse. **Recommendation:** ship explicit-only; auto-detect is a polish PR if the manifest-author UX gets painful.
2. **Backup-on-upgrade hook for existing apps?** When PR 5.8 ships, existing linkding installs lose their data on container recreate (unless manually backed up). **Recommendation:** document loudly in PR 5.D2 + provide a one-shot script `tools/migrate-docker-volume.sh` that copies a still-running container's volume content to the new host path. Out of automation scope for v1.

---

## PR 5.9 — os8.ai catalog-sync triggers Vercel deploy hook

**Goal.** Deferred-items #34. The Phase 3.5.5 incident: linkding's `/apps/linkding` returned 500 for ~30 minutes after sync because Next.js's ISR fallback for slugs absent from `generateStaticParams`'s build-time output crashes upstream of user code on Vercel. The pre-render-everything workaround is in place (`os8dotai/src/app/apps/[slug]/page.tsx:13-22`); the manual nudge (push an empty commit) was needed to force a redeploy. PR 5.9 wires the catalog-sync route to call a Vercel deploy hook automatically when a sync adds a new slug.

### Files (in `os8dotai/`)

- **Modify:** `/home/leo/Claude/os8dotai/src/lib/catalog-sync.ts` — after a successful sync that added one or more new slugs, call `process.env.VERCEL_DEPLOY_HOOK_URL` with `POST` (no body required by Vercel's deploy-hook protocol).
- **Modify:** `/home/leo/Claude/os8dotai/src/app/api/internal/catalog/sync/route.ts` — same wiring at the route level (depending on whether the lib or route is the natural integration point).
- **Doc:** `/home/leo/Claude/os8dotai/SECURITY.md` — note the deploy-hook URL as a deploy-time secret; rotation cadence (annual default, mirrors `TELEMETRY_HASH_SALT` posture from PR 4.5).

### Vercel deploy-hook setup (one-time, ops)

1. In Vercel project settings → Git → Deploy Hooks, create a hook named "catalog-sync-add" pointed at `main` branch.
2. Copy the URL.
3. Add `VERCEL_DEPLOY_HOOK_URL` to the project's Production env vars.
4. Test by hitting the URL from Postman; verify a new deployment fires.

### Wiring contract

```ts
// os8dotai/src/lib/catalog-sync.ts — addition

export async function syncChannel(channel: string): Promise<{ added: number; updated: number; removed: number }> {
  // ...existing sync logic
  const result = await performSync(channel);

  // PR 5.9 — fire deploy hook if any new slugs landed. Updates + removes
  // don't need rebuilds (existing static-params already cover them).
  if (result.added > 0 && process.env.VERCEL_DEPLOY_HOOK_URL) {
    try {
      const r = await fetch(process.env.VERCEL_DEPLOY_HOOK_URL, {
        method: 'POST',
        // Vercel deploy hooks take an empty body or { ref, repo } — empty
        // is fine for our case (defaults to the configured branch).
      });
      console.log(`[CatalogSync] deploy hook fired for ${channel}; status ${r.status}`);
    } catch (err) {
      // Best-effort; sync is the source of truth, deploy hook is the ETA polish.
      console.warn(`[CatalogSync] deploy hook failed for ${channel}: ${err.message}`);
    }
  }

  return result;
}
```

### Tests

`os8dotai/src/lib/__tests__/catalog-sync.test.ts`:

| Scenario | Assertion |
|---|---|
| Sync that adds 1 slug | deploy hook called once |
| Sync that adds 0 slugs (only updates/removes) | deploy hook not called |
| Sync that adds N slugs in one tick | deploy hook called once (not per slug) |
| Deploy hook returns 5xx | sync result still returned (best-effort) |
| `VERCEL_DEPLOY_HOOK_URL` not set | sync proceeds; no hook call attempt |

### Acceptance criteria

- A catalog sync that adds at least one new slug triggers a Vercel deployment within ~1 minute.
- A sync that only updates existing slugs does NOT trigger a deployment.
- The pre-render-everything workaround stays in tree (defense-in-depth — still needed for the window between sync and rebuild).
- New slug becomes 200-resolvable on the storefront within ~3 minutes of catalog merge (vs ~30 minutes today).

### Cross-platform notes

None — server-side Next.js.

### Spec deviations

- **None.** PR 5.9 is a pure operational fix.

### Depends on

PR 0.8 (catalog-sync route exists), PR 3.4 (multi-channel sync). Independent of every other Phase 5 PR.

### Open sub-questions

1. **Should the deploy hook also fire on `removed > 0`?** Slug removal doesn't 500 (the slug is gone from `generateStaticParams` on next build, which triggers naturally). **Recommendation:** ship only on `added > 0`; revisit if removed slugs cause UX issues.
2. **Should we expose a manual "rebuild storefront" endpoint for curators?** **Recommendation:** ship without; the deploy-hook URL is itself a manual trigger if needed.

---

## PR 5.10 — Migration `0.7.0-app-store-lifecycle.js`

**Goal.** Foundation for PRs 5.4 (`update_conflict_files` column), 5.5 (`orphan_restore.prompt` setting), 5.7 (`auto_update.community_enabled` setting), and 5.1 (`account.session_cookie` + `share_installed_apps` columns). Bumps `package.json` version to `0.7.0`.

### Files

- **Create:** `/home/leo/Claude/os8/src/migrations/0.7.0-app-store-lifecycle.js`
- **Modify:** `/home/leo/Claude/os8/package.json` — version `0.6.0` → `0.7.0`
- **Create:** `/home/leo/Claude/os8/tests/migrations/0.7.0.test.js`

### Migration

```js
// src/migrations/0.7.0-app-store-lifecycle.js
module.exports = {
  version: '0.7.0',
  description: 'App Store v1.2: lifecycle completeness — merge conflict storage, orphan-restore preference, community auto-update opt-in, session cookie cache',
  async up({ db, logger }) {
    // 1. apps.update_conflict_files — JSON list of currently-conflicted file
    //    paths from the last failed merge. Lets the renderer surface the
    //    list across restarts without re-running git status.
    const appsCols = db.prepare(`PRAGMA table_info(apps)`).all().map(c => c.name);
    if (!appsCols.includes('update_conflict_files')) {
      db.exec(`ALTER TABLE apps ADD COLUMN update_conflict_files TEXT`);
    }

    // 2. account.session_cookie — os8.ai session cookie cache for the
    //    installed-apps heartbeat. account.share_installed_apps — opt-out
    //    toggle (default ON when present).
    const accountCols = db.prepare(`PRAGMA table_info(account)`).all().map(c => c.name);
    if (!accountCols.includes('session_cookie')) {
      db.exec(`ALTER TABLE account ADD COLUMN session_cookie TEXT`);
    }
    if (!accountCols.includes('share_installed_apps')) {
      db.exec(`ALTER TABLE account ADD COLUMN share_installed_apps INTEGER DEFAULT 1`);
    }

    // 3. Settings — only seed if not already set (preserve user choices).
    const seed = (key, value) => {
      const existing = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
      if (!existing) {
        db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run(key, value);
      }
    };
    seed('app_store.orphan_restore.prompt', 'true');           // PR 5.5: ON by default
    seed('app_store.auto_update.community_enabled', 'false');  // PR 5.7: OFF by default

    // 4. Defensive — re-seed _internal_call_token if absent. PR 4.11 should
    //    have done this; defensive in case of a botched 0.6.0 run.
    const tokenRow = db.prepare(`SELECT value FROM settings WHERE key = '_internal_call_token'`).get();
    if (!tokenRow || !tokenRow.value) {
      const fresh = require('crypto').randomBytes(32).toString('hex');
      db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('_internal_call_token', ?)`).run(fresh);
    }

    logger?.info('Migration 0.7.0: lifecycle columns + settings + cookie cache applied');
  }
};
```

### Test

```js
// tests/migrations/0.7.0.test.js
const Database = require('better-sqlite3');
const migration = require('../../src/migrations/0.7.0-app-store-lifecycle');

test('0.7.0 migration is idempotent', async () => {
  const db = new Database(':memory:');
  // Mimic a 0.6.x state (apps + account + settings tables exist).
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);`);
  db.exec(`CREATE TABLE account (id TEXT PRIMARY KEY);`);
  db.exec(`CREATE TABLE apps (id TEXT PRIMARY KEY);`);
  db.prepare(`INSERT INTO account (id) VALUES ('local')`).run();

  await migration.up({ db, logger: console });

  // Verify columns + seeds.
  const appsCols = db.prepare(`PRAGMA table_info(apps)`).all().map(c => c.name);
  expect(appsCols).toContain('update_conflict_files');

  const accountCols = db.prepare(`PRAGMA table_info(account)`).all().map(c => c.name);
  expect(accountCols).toContain('session_cookie');
  expect(accountCols).toContain('share_installed_apps');

  const orphan = db.prepare(`SELECT value FROM settings WHERE key = 'app_store.orphan_restore.prompt'`).get();
  expect(orphan.value).toBe('true');
  const community = db.prepare(`SELECT value FROM settings WHERE key = 'app_store.auto_update.community_enabled'`).get();
  expect(community.value).toBe('false');

  // Re-run.
  await migration.up({ db, logger: console });
  const appsColsRerun = db.prepare(`PRAGMA table_info(apps)`).all().map(c => c.name);
  expect(appsColsRerun.filter(c => c === 'update_conflict_files').length).toBe(1);
});

test('0.7.0 migration preserves existing settings', async () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);`);
  db.exec(`CREATE TABLE account (id TEXT PRIMARY KEY);`);
  db.exec(`CREATE TABLE apps (id TEXT PRIMARY KEY);`);
  db.prepare(`INSERT INTO settings (key, value) VALUES ('app_store.auto_update.community_enabled', 'true')`).run();

  await migration.up({ db, logger: console });

  const community = db.prepare(`SELECT value FROM settings WHERE key = 'app_store.auto_update.community_enabled'`).get();
  expect(community.value).toBe('true');     // user choice respected
});
```

### Acceptance criteria

- `npm start` against an existing 0.6.x DB upgrades cleanly; re-run is a no-op.
- Fresh installs see the new columns + seeds.
- `_internal_call_token` is preserved across upgrades; only re-seeded if absent.
- User-set settings (e.g. user manually flipped `app_store.auto_update.community_enabled` between releases) are not overwritten.

### Cross-platform notes

None — pure SQLite migration.

### Spec deviations

- **None** — migration is foundation work for spec-aligned PRs.

### Depends on

None — foundation PR.

### Open sub-questions

None.

---

## 4. Cross-repo coordination

Phase 5 touches all five repos. Dependencies and sequencing:

```
                          ┌──────────────────────────────────────┐
                          │  os8ai/os8-sdk-types                  │
                          │  PR 5.2: cut v1.0.0 tag → npm publish │
                          │  Depends on: NPM_TOKEN secret + sync  │
                          └──────────────────────────────────────┘
                                     ↑
┌──────────────────────────────────┐  │   ┌──────────────────────────────────┐
│  os8ai/os8 (desktop)             │  │   │  os8ai/os8dotai (website)        │
│                                  │  │   │                                  │
│  5.10 (migration 0.7.0)          │  │   │  5.1 (auth/desktop/finalize     │
│  5.1 (session cookie plumbing)   │ ─┼── │       cookie in JSON response)  │
│  5.2 (drift CI tighten)          │  │   │  5.9 (catalog-sync deploy hook) │
│  5.3 (E2E strict env + specs)    │  │   │                                  │
│  5.4 (merge conflict UI)         │  │   └──────────────────────────────────┘
│  5.5 (orphan restore)            │  │
│  5.6 (Sync Now button)           │  │
│  5.7 (community auto-update)     │  │
│  5.8 (docker volumes adapter)    │  │
└──────────────────────────────────┘  │
                                       ↓ schema bump
┌──────────────────────────────────┐    ┌──────────────────────────────────────┐
│  os8ai/os8-catalog               │    │  os8ai/os8-catalog-community         │
│                                  │    │                                      │
│  5.8 (schema runtime.volumes)    │ ←──│  5.8 (schema runtime.volumes +       │
│                                  │    │       linkding manifest update)      │
└──────────────────────────────────┘    └──────────────────────────────────────┘
```

### Sequencing constraints

| Constraint | Reason | Order |
|---|---|---|
| 5.10 (migration) before 5.4, 5.5, 5.7 | columns + settings need to exist | 5.10 → {5.4, 5.5, 5.7} |
| 5.4 (merge conflict UI) before 5.7 (community auto-update) | conflict path is the recovery surface; community apps churn more | 5.4 → 5.7 |
| 5.1 desktop side after os8.ai-side cookie change deploys | os8.ai's finalize route must include `sessionCookie` before desktop reads it | os8.ai 5.1 → desktop 5.1 |
| 5.2 drift-CI tighten before npm publish workflow fires | CI must accept "package not yet published" gracefully | 5.2 desktop → push v1.0.0 tag |
| 5.8 schema land in os8 before catalog repos | desktop's appspec-v2.json is canonical; catalogs fetch | 5.8 (os8) → 5.8 (catalogs) |
| 5.8 catalog repos can land in either order, but linkding manifest update must follow community-catalog schema bump | manifest validation against new schema | 5.8 community schema → linkding manifest update |
| 5.6 (Sync Now) independent | no deps | parallel |
| 5.3 (E2E strict env) independent | no deps | parallel |
| 5.9 (Vercel deploy hook) independent | no deps | parallel |

### Suggested merge order (least-risky first)

```
Week 1:
  5.10 (migration foundation)                — desktop, no dependencies
  5.1 (session cookie + heartbeat live)      — os8.ai-side first, then desktop
  5.2 (npm drift CI tighten)                 — desktop; tag v1.0.0 from sdk-types after merge
  5.6 (Sync Now button)                      — desktop, IPC already exists
  5.9 (Vercel deploy hook)                   — os8.ai
  5.3 (E2E strict env + spec flesh-out)      — desktop, gates nothing else but flips dim CI surface

Week 2:
  5.4 (merge conflict UI)                    — desktop, gates 5.7
  5.5 (reinstall-from-orphan)                — desktop, independent of 5.4
  5.8 (docker volumes)                       — desktop schema first, then both catalog repos

Week 3:
  5.7 (community auto-update)                — desktop, after 5.4

Doc PRs throughout:
  5.D2 (runtime-volumes.md + sync-now.md)    — files alongside 5.6 + 5.8
  5.D3 (deferred-items decisions log)        — files as items close
  5.D1 (spec + master-plan close-out)        — files at end of phase
```

This order minimizes stalls (each week has independent work for parallel reviewers) and keeps the longest dependency chain (5.10 → 5.4 → 5.7) front-loaded.

---

## 5. Migrations

| Migration | Version | What it adds | Why |
|---|---|---|---|
| `0.7.0-app-store-lifecycle.js` (PR 5.10) | 0.7.0 | `apps.update_conflict_files` (TEXT, JSON); `account.session_cookie` (TEXT); `account.share_installed_apps` (INT, default 1); `app_store.orphan_restore.prompt` (default 'true'); `app_store.auto_update.community_enabled` (default 'false'); defensive re-seed of `_internal_call_token` | Foundation for PRs 5.4, 5.5, 5.7, 5.1 |

Schema migrations on the os8.ai side:

| Migration | Repo | What it adds | Why |
|---|---|---|---|
| (none) | os8ai/os8dotai | — | Phase 5 introduces no new os8.ai-side Prisma models. PR 5.1 reuses the existing `User` and `InstalledApp` models from PR 4.3. PR 5.9 adds an env var only. |

No template migrations (no shell-owned template file changes in Phase 5). No data migrations (no field renames, no value rewrites).

---

## 6. Smoke gates

Phase 4 inherited the principle (recorded in `MEMORY.md` as `feedback_smoke_test_real_apps.md`): **before declaring an adapter or trust-boundary change shipped, smoke against a real third-party app — not just the minimum-viable fixture under `tests/fixtures/`.** Phase 5 carries this forward.

### Smoke gates this phase

| Gate | What's smoked | Real app(s) | Gates merge of |
|---|---|---|---|
| **G1** Heartbeat lights up the os8.ai detail-page badge | PR 5.1 — session cookie → InstalledApp upsert → badge visible | worldmonitor (any installed Verified app) | PR 5.D1 close-out |
| **G2** Strict-env E2E suite passes on Linux + macOS (Windows best-effort) | PR 5.3 — fully-specced strict middleware + flesh-out specs | Suite covers worldmonitor install, dev-import, native React app, scoped-API origin matrix | PR 5.3 itself |
| **G3** Manual three-way merge resolution works end-to-end | PR 5.4 — auto-updater hits conflict → banner surfaces → mark resolved → app updates | worldmonitor with a hand-edited file vs upstream catalog bump | PR 5.7 |
| **G4** Uninstall → reinstall preserves data | PR 5.5 — orphan detection + restore checkbox + apps row revival | worldmonitor (or any external app with localStorage state) | PR 5.D1 close-out |
| **G5** Docker volume persistence across container recreate | PR 5.8 — `runtime.volumes` honored end-to-end | linkding (post-manifest update) | PR 5.D1 close-out |

### Gate ordering

```
5.1 ──→ G1 (heartbeat smoke) ──────────────────→ 5.D1
5.3 ──→ G2 (strict E2E green) ──→ 5.3 itself
5.4 ──→ G3 (merge resolution smoke) ──→ 5.7 ──→ 5.D1
5.5 ──→ G4 (orphan restore smoke) ─────────────→ 5.D1
5.8 ──→ G5 (docker volume persistence smoke) ──→ 5.D1
```

Each gate corresponds to a manual checklist (mirroring phase-3-plan §7.2's 7-step pattern). Mechanical CI catches the easy regressions; the manual smoke catches the architectural ones.

### Why these gates and not others

- **No gate for 5.2 (npm publish).** Drift-check CI is the gate; user-facing test is "install it, autocomplete works."
- **No gate for 5.6 (Sync Now).** UI button + existing IPC handler — unit-tested + visually verified is sufficient.
- **No gate for 5.7 (community auto-update).** Inherits G3 from 5.4 (conflict path). The filter-widening itself is unit-test territory.
- **No gate for 5.9 (Vercel deploy hook).** Best-effort fix; verified by watching the deploy fire after a real catalog merge in soak time.
- **No gate for 5.10 (migration).** Standard migration test pattern.

---

## 7. Risks and open questions

### Items needing user decision before / during execution

1. **Are 6 deferred-items.md promotions the right scope?**

   The user's framing capped promotions at "5–7" with the note "If your draft has more, surface the over-scope and ask which to cut before finishing." Phase 5 promotes **six** items, all justified by spec gaps, fired triggers, or Phase 4 architectural extensions:

   | Deferred item | Promoted as | Justification |
   |---|---|---|
   | #10 Three-way merge UI for updates with user edits | PR 5.4 | Phase 4 PR 4.2 (auto-update) created the call site. Conflicts are now silent failures — no UI exists. Spec §6.9 sketches the UI but never wired. |
   | #11 Auto-update for Community channel | PR 5.7 | Trigger condition was "once #10 lands"; this plan ships #10 + #11 together as the natural extension of PR 4.2. |
   | #12 Tiered uninstall + data-preserve + reinstall restore | PR 5.5 | Spec §6.10 explicitly promises orphan-restore; uninstall side shipped in PR 1.24, reinstall side never wired. Audit confirms `apps.status='uninstalled'` rows are stranded. |
   | #32 Catalog freshness — no user-driven "Sync Now" | PR 5.6 | Trigger fired during Phase 3.5.5 (linkding manifest update was invisible to fresh restarts). IPC handler already exists; UI button is cheap. |
   | #34 ISR fallback 500s for slugs not in `generateStaticParams` | PR 5.9 | Trigger fired during Phase 3.5.5 (Leo had to push empty commits to force redeploys). Vercel deploy-hook is a one-line fix. |
   | #35 Docker adapter container-internal volumes | PR 5.8 | Trigger fired during Phase 3.5.5 (linkding's `/etc/linkding/data` was at risk of data loss on container recreate). |

   Items I am **not** promoting (kept on the deferred list):
   - #1 Resource limits — no user report yet; runtime kill is a multi-day lift.
   - #2 Hard-block on MAL-* malware — explicit "deliberate decision" required (deferred-items.md note); advisory model is non-negotiable per memory and spec §6.5.
   - #3 OAuth multi-tenant — not needed while OS8 is single-user-per-machine.
   - #4, #5 (per-origin perms, audit logging) — verify-first deferrals, no signal yet.
   - #7 Keychain encryption — depends on OS8 itself moving to keychain.
   - #13 Catalog CI error-handling polish — happy path works; no curator complaint yet.
   - #14 Curator pool tiering — community PR backlog data missing.
   - #15 App revocation flow — pre-emptive value; no real revocation event yet. **Borderline; could be promoted if user wants it ahead of any incident.**
   - #16 Install-count display on community cards — UX polish; community channel still small.
   - #17 GitHub raw RUM — Phase 4 telemetry will surface 429s when they happen; no signal yet.
   - #19 Slack/webhook alerts for sync failures — no surprise yet.
   - #21 Dockerfile-only Developer Imports — substantial complexity; Community channel covers the use case for now.
   - #22, #23 (GPU device pinning, sparse checkout) — rare use cases; no signal.
   - #24-#31 UX polish — opportunistic, not phase-scoped.
   - #33 v2 schema `$schema` declaration drift — bundle with the next unrelated v2 schema edit (PR 5.8 is a candidate; tentatively bundled there but flagged here in case scope tight).
   - E1–E5 V1 exclusions — intentional invariants.

   The six promotions all have a fired trigger or strong architectural rationale. **If the human reviewer prefers a tighter Phase 5 scope, the natural cut points are:**
   - Drop 5.7 (community auto-update) — defer to Phase 6 once #10 has been in soak time.
   - Drop 5.9 (Vercel deploy hook) — the manual-empty-commit workaround works; it's just annoying.
   - Drop 5.6 (Sync Now button) — annoyance polish, not load-bearing.

   Or any combination. The most-load-bearing PRs are 5.1 (heartbeat live), 5.4 (merge UI), 5.5 (orphan restore), 5.8 (docker volumes) — these four close real lifecycle gaps. PRs 5.2 + 5.3 + 5.10 are operational/foundation work that doesn't compete for slot.

2. **Should we promote #15 (app revocation flow) preemptively?**

   No real revocation event has occurred. The deferred-items entry says "Should be in place before [a real revocation] happens, ideally." Phase 5 has scope room for one more PR — promoting #15 would shift the slot allocation. **Recommendation: ask Leo.** If yes, add as PR 5.11; if no, leave for Phase 6 once curators flag a revocation candidate (or post-Phase-5 telemetry surfaces something concerning).

3. **Session-cookie persistence — settings table or new column?**

   PR 5.1 currently proposes a new `account.session_cookie` column. Alternative: store in the `settings` table as `account.session_cookie` key. **Recommendation:** column. The `account` table already exists for per-user state; using settings would mix concerns.

4. **Three-way merge UI scope — manual-edit only, or "use ours / use theirs" buttons too?**

   PR 5.4 proposes manual-edit only (user opens conflicted files, removes markers, marks resolved). The richer UI ("use ours" / "use theirs" per file) would let non-git-fluent users self-serve. **Recommendation:** ship manual-edit only; promote per-file actions to a polish PR if real-world friction emerges. Reasoning: the user's existing dev-mode setup includes a Claude Code agent that handles conflicts cleanly; the "use ours/theirs" buttons are mostly useful for users without an AI agent in the loop.

5. **Docker volumes — schema design for backups?**

   PR 5.8 doesn't preserve existing container-internal data when the schema lands. Users with linkding installed today will lose `/etc/linkding/data` on the post-5.8 recreate (unless they manually back up). **Recommendation:** ship as proposed + provide a one-shot migration script `tools/migrate-docker-volume.sh`; document loudly in PR 5.D2. Auto-migration is out of v1 scope but can be added later via a "first-restart-after-upgrade" hook.

6. **Community auto-update default — OFF (proposed) or ON?**

   PR 5.7 proposes default OFF. Verified is also default OFF (per PR 4.2). Symmetry argues for the same default. **Recommendation:** default OFF; users who explicitly enable Verified auto-update can also enable Community in the same Settings panel.

### Spec ambiguities surfaced

These came up while drafting the plan; flagging for the human reviewer.

7. **Spec §6.9 "auto-update opt-in for Verified channel only" needs widening.** PR 5.7 widens to Community. PR 5.D1 updates the spec to reflect the new posture + the new setting. The principle (no auto-merge against user-edited apps) stays.

8. **Spec §6.10 "Reinstall detects orphan data" doesn't specify channel-scoping.** PR 5.5 makes orphan detection channel-scoped (Verified orphan ≠ Community reinstall). Documented as a deviation; PR 5.D1 should add the rationale to spec §6.10.

9. **Spec §3.4 has no `runtime.volumes` field.** PR 5.8 adds it. PR 5.D1 updates §3.4 + §3.5 (JSON Schema validation invariants).

10. **Spec §11 "Phase 4 added open items" lists `os8.ai session token for desktop heartbeat` and `Telemetry hash salt rotation cadence`.** PR 5.1 closes the first; the second remains a Phase 6+ item (annual default per `os8dotai/SECURITY.md` is sufficient until rotation is signal-driven).

11. **Spec §11 #5 (`bun.lockb` recognition) and #8 (`requireAppContext` route inventory) are still open.** Phase 5 doesn't touch them. Surfacing here in case they're load-bearing for any of the promoted PRs (they're not — both are independent surfaces).

12. **Telemetry kinds `update_conflict` and `update_conflict_resolved`** are added by PR 5.4 (allowlist sanitizer needs the new keys). PR 5.D1 updates spec §8 + the published "what we send" doc.

13. **Phase 4 manual smokes G2 (worldmonitor bump), G3 (post-flip strict), G4 (Windows installer) status.** Per `project_app_store_phases.md` memory, these are still pending Leo's pass. **Phase 5 PRs that would benefit from G3 already running:** PR 5.3 (E2E strict env flip — assumes strict middleware works against real apps). If G3 hasn't run by the time PR 5.3 is ready to merge, recommend Leo run G3 first OR gate PR 5.3 on the E2E suite passing in CI (which it will, since the harness IS the gate).

14. **Phase 4 deferred follow-ups still open at audit time:**
    - Session-cookie plumbing — PR 5.1 closes.
    - NPM publish — PR 5.2 closes.
    - Strict-mode E2E env flip — PR 5.3 closes.
    - Docker adapter persistence — PR 5.8 closes.
    - Playwright specs flesh-out — PR 5.3 closes.
    - **Manual smokes G2/G3/G4** — out of Phase 5 scope; orthogonal to the code work. Leo's call.

### Decisions captured during planning (record in 5.D1)

| # | Decision | Resolved in |
|---|---|---|
| 1 | Phase 5 scope is "lifecycle completeness + telemetry-driven sharpening"; derived from Phase 4 follow-ups + deferred-items triggers (no telemetry signal yet) | This document §1 |
| 2 | Six deferred-items.md items promoted (#10, #11, #12, #32, #34, #35) | This document §7 |
| 3 | Session cookie stored in `account.session_cookie` (column, not settings) | PR 5.1 |
| 4 | Share-installed-apps toggle defaults ON when signed in; OFF clears the cookie | PR 5.1 |
| 5 | NPM drift-check uses soft-fail when package is unpublished; hard-fail after 30 days post-publish | PR 5.2 |
| 6 | E2E `OS8_4_6_STRICT=1` is the production env in the workflow; legacy permissive only via env override | PR 5.3 |
| 7 | Three-way merge UI ships manual-edit only; per-file ours/theirs deferred | PR 5.4 |
| 8 | `update_conflict_files` JSON column persists conflict state across restarts | PR 5.4 + PR 5.10 |
| 9 | Orphan-restore is channel-scoped (Verified orphan ≠ Community reinstall) | PR 5.5 |
| 10 | Per-install lazy refresh window: 5 minutes | PR 5.6 |
| 11 | Sync Now button lives in the catalog browser modal (not Settings) | PR 5.6 |
| 12 | Community auto-update is opt-in via a separate Settings toggle, default OFF | PR 5.7 |
| 13 | Community auto-update inherits Verified's "no-user-edits" rule and the same conflict UI | PR 5.7 |
| 14 | Docker volumes mounted under `${BLOB_DIR}/_volumes/${basename}` | PR 5.8 |
| 15 | Docker volume schema field is `runtime.volumes`, with `container_path` and reserved `persist` | PR 5.8 |
| 16 | Vercel deploy hook fires only on `added > 0` (not updates/removes) | PR 5.9 |
| 17 | Migration `0.7.0-app-store-lifecycle.js` is the only desktop schema change in Phase 5 | PR 5.10 |
| 18 | Migration preserves user-set `app_store.auto_update.community_enabled` (won't overwrite to false) | PR 5.10 |

---

## 8. Phase 5 acceptance criteria

Phase 5 ships when ALL of:

1. **Heartbeat lights up the InstalledApps badge.** Signed-in user with worldmonitor installed visits `https://os8.ai/apps/worldmonitor`: detail page shows "✓ You have abc1234 installed (current)" or "Update available" badge.
2. **`@os8/sdk-types@1.0.0` is published to npm.** External app authors can `npm install -D @os8/sdk-types` and get autocomplete.
3. **E2E strict-mode env is set in CI.** `.github/workflows/e2e.yml` runs with `OS8_4_6_STRICT=1`; install + dev-import + native-app specs flesh out + assert real behavior. Linux + macOS gating; Windows best-effort.
4. **Auto-update conflicts surface a usable resolution UI.** worldmonitor with hand-edited `App.tsx` + upstream `App.tsx` change → toast + home-screen dot + merge-conflict banner → user resolves → app updates.
5. **Uninstall → reinstall preserves data.** worldmonitor uninstalled with default tier → reinstalled → install plan modal shows "Previous data found" with non-zero blob bytes → restore checkbox ON → app revives at same appId with data intact.
6. **Catalog Sync Now button works.** Catalog browser surfaces a Sync button; clicking triggers an immediate sync + grid refresh. Per-install lazy refresh picks up manifests changed within last 5 minutes.
7. **Community-channel apps support auto-update opt-in.** Settings has new "Allow auto-update for Community-channel apps" toggle; per-app flyout enables when ON; auto-updater processes Community apps in the eligible list.
8. **Docker apps with `runtime.volumes` persist data across container recreate.** linkding's bookmarks survive uninstall → reinstall (with restore on) and stop → start cycles.
9. **New catalog slugs become 200-resolvable on os8.ai within ~3 minutes** (vs ~30 minutes today). Vercel deploy hook fires on `added > 0` from catalog sync.
10. **Migration `0.7.0` upgrades cleanly from `0.6.x`.** Idempotent; preserves prior settings.

### What flows out of Phase 5

- **The auto-update story is complete.** Verified + Community both supported, conflicts have a recovery path, the os8.ai-side badge tells signed-in users what they have installed and whether it's current.
- **Lifecycle gaps closed.** Uninstall → reinstall preserves work; docker apps stop losing data; catalog freshness is no longer a 24h black hole.
- **Phase 4 instrumentation is fully live.** Telemetry was opt-in at Phase 4; Phase 5 doesn't change that, but the heartbeat-and-badge feature now actually does its job (Phase 4 shipped it dim).
- **External-IDE workflow is friendlier.** `@os8/sdk-types` on npm closes the loop on PR 4.9.
- **E2E suite is no longer decorative.** PR 5.3's strict-env flip + spec flesh-out turns the Phase 4 harness from a scaffold into a real regression-class gate.

### What does **not** carry forward (Phase 6+ candidates)

- **Hard-block on MAL-* malware findings** — deferred-items #2; advisory model per spec §6.5 stays unless telemetry shows users routinely overriding MAL-* warnings.
- **App revocation flow** — deferred-items #15; should land before any real revocation event, but no event has occurred. Promote when curators flag it.
- **Resource limits with runtime kill** — deferred-items #1; promote on first user report.
- **OAuth-gated capabilities (multi-tenant)** — deferred-items #3; only matters for multi-user deployments.
- **GitHub raw asset rate-limit monitoring (RUM)** — deferred-items #17; promotes if Phase 4 telemetry shows 429s.
- **Curator pool tiering** — deferred-items #14; awaits PR backlog data.
- **Per-channel reputation surfacing on community cards** — deferred-items #16; depends on community channel volume.
- **Dockerfile-only Developer Imports** — deferred-items #21; substantial complexity; Community channel covers the use case for now.
- **Per-file ours/theirs buttons in merge UI** — Phase 5 ships manual-edit only; promote if real-world friction emerges.
- **Backup-on-upgrade hook for docker volumes** — PR 5.8 ships explicit-only; auto-backup is polish.
- **Public dashboard surface for telemetry** — Phase 4's `/internal/telemetry/install` is curator-only; public surface awaits one curator-side review of data quality (per phase-4-plan §1 follow-ups).

---

## 9. Decisions log (Phase 5)

Captured here as a one-line index so reviewers can find where each lives. Mirrors the Phase 4 §9 pattern.

| # | Decision | Resolved in |
|---|---|---|
| 1 | Phase 5 theme: lifecycle completeness + telemetry-driven sharpening | This doc §1 |
| 2 | Six deferred-items promoted (#10, #11, #12, #32, #34, #35) with justification | This doc §7.1 |
| 3 | Phase 4 follow-ups close in Track A (PRs 5.1, 5.2, 5.3) | This doc §1 |
| 4 | Session cookie stored on `account` row (column, not settings) | PR 5.1 |
| 5 | Cookie passed via JSON response body from os8.ai finalize route, not Set-Cookie | PR 5.1 |
| 6 | Share-installed-apps default ON when signed in; OFF clears cookie | PR 5.1 |
| 7 | NPM drift CI is soft-fail until package published; hard-fail after 30 days | PR 5.2 |
| 8 | `@os8/sdk-types` desktop pin: `peerDependencies` >= 1.0.0 < 2.0.0 | PR 5.2 |
| 9 | E2E workflow env: `OS8_4_6_STRICT=1` (production behavior); legacy via `OS8_REQUIRE_APP_CONTEXT_PERMISSIVE=1` env override | PR 5.3 |
| 10 | Windows joins E2E matrix as `continue-on-error: true`; gating after one stable green run | PR 5.3 |
| 11 | Three-way merge UI: banner in app source sidebar + home-screen dot + toast | PR 5.4 |
| 12 | Merge resolution: manual-edit only; per-file ours/theirs deferred | PR 5.4 |
| 13 | `apps.update_conflict_files` JSON column persists conflict state across restarts | PR 5.4 + PR 5.10 |
| 14 | New telemetry kinds `update_conflict` and `update_conflict_resolved` (allowlist additions) | PR 5.4 + PR 4.4 follow-up |
| 15 | Orphan detection: most recent `(external_slug, channel, status='uninstalled')` row | PR 5.5 |
| 16 | Orphan restore is channel-scoped (cross-channel restore would silently elevate trust) | PR 5.5 |
| 17 | Skipped orphans marked `status='archived'` for future cleanup UI | PR 5.5 |
| 18 | Per-install lazy refresh window: 5 minutes | PR 5.6 |
| 19 | Sync Now button placement: catalog browser modal, next to channel pills | PR 5.6 |
| 20 | Community auto-update: opt-in via Settings toggle, default OFF | PR 5.7 |
| 21 | Community auto-update inherits Verified's no-user-edits rule | PR 5.7 |
| 22 | Docker `runtime.volumes` schema: `container_path` (required) + `persist` (reserved) | PR 5.8 |
| 23 | Docker volume host path: `${BLOB_DIR}/_volumes/${basename}` (basename, not full path) | PR 5.8 |
| 24 | Schema validator caps `runtime.volumes` at 10 entries; rejects `..` paths and duplicates | PR 5.8 |
| 25 | Vercel deploy hook fires only on `added > 0` (not updates/removes) | PR 5.9 |
| 26 | Pre-render-everything Vercel workaround stays in tree as defense-in-depth | PR 5.9 |
| 27 | Migration `0.7.0` adds `update_conflict_files` + cookie cache + 2 settings keys | PR 5.10 |
| 28 | Migration preserves user-set settings (won't overwrite community_enabled to false) | PR 5.10 |
| 29 | Migration defensively re-seeds `_internal_call_token` if absent | PR 5.10 |
| 30 | Phase 5 introduces no new os8.ai-side Prisma models | This doc §5 |

---

## 10. Updates to MEMORY.md after Phase 5

When the relevant PRs land, the project memory should be updated:

- **After PR 5.1 deploys:** update `project_app_store_phases.md` to remove the "Phase 4 deferred to follow-ups: os8.ai session token for desktop heartbeat" entry; add a `reference_installed_apps_badge.md` entry pointing at `https://os8.ai/apps/<slug>` describing the badge UX.
- **After PR 5.2 publishes:** update `project_app_store_phases.md` to remove the "NPM publish for @os8/sdk-types" follow-up; add a one-liner pointing at `https://www.npmjs.com/package/@os8/sdk-types`.
- **After PR 5.3 lands:** update `reference_e2e_harness.md` to note that `OS8_4_6_STRICT=1` is now the production CI env + that install + dev-import + native-app specs are no longer skipped.
- **After PR 5.4 lands:** add a `project_merge_conflict_ux.md` entry describing the merge-conflict banner location + the "manual-edit + mark resolved" workflow so future agents don't re-spec the resolution flow.
- **After PR 5.5 lands:** update `project_app_store_phases.md` to remove the "deferred-items #12 reinstall side" gap; add a `feedback_channel_scoped_orphans.md` entry with the rationale for not cross-channel-restoring.
- **After PR 5.7 lands:** add a `project_community_auto_update.md` entry describing the per-channel toggle + the symmetry with Verified.
- **After PR 5.8 lands:** update `feedback_smoke_test_real_apps.md` "go-to smoke targets" entry for linkding to note the post-volumes manifest + the persistence-smoke checklist.
- **After PR 5.9 lands:** add a `reference_vercel_deploy_hook.md` entry pointing at `os8dotai/src/lib/catalog-sync.ts` so future PRs editing catalog-sync know about the side-effect.

---

*End of plan.*
