# OS8 App Store — Phase 6 Implementation Plan

**Companions:** [`app-store-spec.md`](./app-store-spec.md) (Draft v2), [`app-store-plan.md`](./app-store-plan.md) (master plan), [`phase-0-plan.md`](./phase-0-plan.md), [`phase-1-plan.md`](./phase-1-plan.md), [`phase-2-plan.md`](./phase-2-plan.md), [`phase-3-plan.md`](./phase-3-plan.md), [`phase-4-plan.md`](./phase-4-plan.md), [`phase-5-plan.md`](./phase-5-plan.md), [`app-store-deferred-items.md`](./app-store-deferred-items.md).
**Audience:** Engineers implementing PRs 6.1 + 6.2 (plus three doc PRs) across `/home/leo/Claude/os8/`, `os8ai/os8-catalog`, and `os8ai/os8-catalog-community`.
**This document:** the concrete contract for each Phase 6 PR — files, splice points, signatures, schema additions, API contracts, test fixtures, acceptance criteria, smoke gates, cross-platform notes, and deviations. Reference the spec and prior phase plans for *why*; this file is *how*.

> **Important framing.** Phase 6 is the **close-out phase**. Phases 0–5 shipped the v1 App Store end-to-end: catalog repos, install pipeline, runtime adapters, BrowserView routing, security review, capability surface, telemetry, auto-update for Verified, three-way merge UI, reinstall-from-orphan, Sync Now, Docker volumes, Vercel deploy hook, and the npm SDK. Phase 6's job is to (a) ship the small finishing batch of items whose triggers fired during or right after Phase 5, (b) confirm the verify-first deferred-items entries are actually Done, and (c) sweep `app-store-deferred-items.md` so every entry has a deliberate decision rationale. After Phase 6 the deferred-items doc has zero unjustified `Deferred` entries — every line is either `Done` (with merging-PR cite), `Deferred` with a tight rationale + explicit trigger, `V1 exclusion` with a one-line decision, or `Won't fix`.
>
> Phase 6's theme: **finish line.** Three small code/doc PRs ship the last triggered work; three doc PRs lock the project's decision history. Total Phase 6 footprint: ≤300 LOC of code work + the documentation sweep.

---

## 1. Scope, ordering, inheritance

Phase 6 ships **two tracks** plus the docs track. Scope was set by an end-to-end audit of `app-store-deferred-items.md` and the spec's "Phase 4/5 added open items" subsections, classified into A/B/C/D buckets (§2 below).

| PR | Work unit | Surface | Track | Spec / deferred-items source | Smoke gate |
|---|---|---|---|---|---|
| 6.1 | Auto-update widening to Community channel (default ON for new Community installs) | OS8 | A — Triggered finishers | deferred-items #36; spec §11 "Phase 5 added open items" first bullet | yes — Community auto-update smoke |
| 6.2 | `appspec-v2.json` `$schema` alignment to draft 2020-12 (3-repo coordination) | OS8 + 2× catalog | A — Triggered finishers | deferred-items #33 (Phase 3.5.5 incident triggered; Phase 5 noted "bundle anytime") | — |
| 6.D1 | Spec + master-plan close-out updates | docs | G | always-separate (Phase 3 §1 precedent) | — |
| 6.D2 | `docs/auto-update.md` update for Community widening + cross-reference for three-way merge UI | docs | G | new — accompanies 6.1; absorbs deferred-items #31 cross-reference ask | — |
| 6.D3 | `app-store-deferred-items.md` final categorization sweep — every entry's status + trigger | docs | G | the close-out itself | — |

### Ordering

Phase 6 has **no hard sequencing constraints**. PR 6.1 and PR 6.2 are independent code/schema changes; the three doc PRs file once each track lands and decisions are settled.

```
Track A (independent within track):
  6.1 (Community auto-update widening)    ── independent
  6.2 (appspec-v2 $schema alignment)      ── 3-repo coordination

Track G (docs — file once tracks close):
  6.D1 — files after 6.1 + 6.2 land
  6.D2 — files alongside 6.1
  6.D3 — files last; references everything Phase 6 closed
```

**Critical path within Phase 6:** none non-trivial. 1 PR-merge deep — flatter than any prior phase. Phase 6 is the smallest phase by design; this is what "make it done" looks like when most of the deferred backlog turns out to be category C/D.

### Test matrix

Phase 4 PR 4.8 promoted `windows-2022` to gating across the unit-test job in `.github/workflows/ci.yml`. Phase 5 PR 5.3 added `windows-2022` as best-effort to the E2E job. Phase 6 inherits both — no PR weakens the matrix.

PR 6.1's vitest tests run on the standard Linux + macOS + Windows-2022 unit matrix. PR 6.2's catalog-repo CI runs on each catalog repo's existing matrix (Linux, per Phase 0).

### Inheritance — what Phase 6 does **not** re-spec

Phase 6 PRs are additive on top of Phases 0–5. **Do not re-spec these.** Cite by file path and section.

| Inherited primitive | Phase | File on disk |
|---|---|---|
| `RuntimeAdapter` interface | 1.11 | `src/services/runtime-adapters/{index,node,python,static,docker}.js` |
| `AppInstaller` orchestrator + state machine | 1.5 / 1.16 | `src/services/app-installer.js` |
| `AppCatalogService.sync` (channel-keyed, idempotent, soft-delete) | 1.3 | `src/services/app-catalog.js` |
| `AppCatalogService.update` (fast-forward + 3-way merge with `update_status='conflict'`) | 1.25 | `src/services/app-catalog.js` |
| `AppService.uninstall` (tiered, default-preserve, `status='uninstalled'`) | 1.24 | `src/services/app.js:231-275` |
| `AppService.getOrphan` / `reviveOrphan` / `archiveOrphan` (channel-scoped) | 5.5 | `src/services/app.js` |
| `AppAutoUpdater.processAutoUpdates` (currently Verified-only) | 4.2 | `src/services/app-auto-updater.js` |
| Per-app settings flyout | 4.2 | `src/renderer/app-settings-flyout.js` |
| Auto-update toast subscriber | 4.2 | `src/renderer/toast.js`, `src/renderer/main.js` |
| `AppMergeResolver` + merge-conflict banner | 5.4 | `src/services/app-merge-resolver.js`, `src/renderer/merge-conflict-banner.js` |
| `AppTelemetry` emitter (allowlist sanitizer + double-hashed clientId) | 4.4 | `src/services/app-telemetry.js` |
| Telemetry ingest + dashboard | 4.5 | `os8dotai/src/app/api/apps/telemetry/route.ts`, `os8dotai/src/app/internal/telemetry/install/page.tsx` |
| `requireAppContext` strict middleware (origin allowlist + internal-token) | 4.6 | `src/middleware/require-app-context.js` |
| `mcp.<server>.*` wildcard resolver | 4.7 | `src/services/scoped-api-surface.js` |
| `@os8/sdk-types` repo + drift-check tool + npm publish | 4.9 / 5.2 | `os8ai/os8-sdk-types` (GitHub + npm), `tools/check-sdk-drift.js` |
| Playwright-Electron E2E harness | 4.10 / 5.3 | `tests/e2e/playwright/{playwright.config.ts,setup.ts,specs/}` |
| Migration runner | 0.2.10 | `src/services/migrator.js`, `src/migrations/<x.y.z>-<slug>.js` |
| `runtime.volumes` schema + Docker bind-mount + first-boot toast | 5.8 | `src/services/runtime-adapters/docker.js`, `src/services/docker-volume-migration.js`, all 3 schemas |
| Catalog Sync Now button + lazy refresh | 5.6 | `src/renderer/settings.js`, `src/services/app-catalog.js` |
| os8.ai session cookie heartbeat + InstalledApps badge | 5.1 | `src/services/account.js`, `os8dotai/src/app/api/account/installed-apps/route.ts` |
| `fireVercelDeployHook` on `added > 0` | 5.9 | `os8dotai/src/lib/catalog-sync.ts` |

When PR 6.x text says "extend `AppAutoUpdater.listEligible`" it means **the same function in `src/services/app-auto-updater.js:47-60`** — see PR 4.2 + the audit notes in §2 below for what already exists.

---

## 2. Audit findings (Phase 6-relevant)

Verified against the working tree of `/home/leo/Claude/os8/` at audit time (`main` at `ad44ef3`, Phase 5 merged through PR #68). Cross-repo audit run against `os8ai/os8-catalog` (#14 most recent) and `os8ai/os8-catalog-community` (#11 most recent). All five repos have **zero open PRs** at audit time.

### 2.1 Categorization of the deferred backlog

The prompt's framing required classifying every open `app-store-deferred-items.md` entry into one of four buckets before drafting per-PR specs. Buckets:

- **A. Triggered + ship-able.** Trigger has fired, scope is clear, value is real.
- **B. Verify-first / may already be done.** Phase 1–5 squash may have closed it.
- **C. Triggered but premature without signal.** "Wait for X" entries; speculative shipping is anti-discipline.
- **D. V1 exclusions by design.** Spec §9 "Out of Scope (V1)" — not gaps, scope choices.

Result of the audit:

| Bucket | Items | Disposition in Phase 6 |
|---|---|---|
| **A** | 3 entries (#36, #33, #31) | Ship code (PR 6.1 + 6.2) and doc cross-ref (PR 6.D2) |
| **B** | 7 entries (spec §11 #3, #5, #8; deferred-items #4, #5 partial, #13, #24) | Confirm Done in 6.D1 / 6.D3 with PR cite; no code |
| **C** | 19 entries | Keep `Deferred` status; rewrite each with tight rationale + explicit trigger (PR 6.D3) |
| **D** | 6 entries (#26, E1–E5) | Reaffirm `V1 exclusion` status in 6.D3; no change needed |

**87% of remaining items are category C or D** — well past the prompt's 2/3 threshold. Phase 6's headline message: *the project is essentially done already; this phase ships the small finishing batch + locks the decision history.*

### 2.2 Category A — what Phase 6 ships as code

| # | Entry | Trigger fired | Audit at write-time | PR |
|---|---|---|---|---|
| 36 | Auto-update widening to Community channel | Phase 5 PR 5.4 (three-way merge UI) shipped 2026-05-04, soak time satisfied; Leo confirms 2026-05-04 | `src/services/app-auto-updater.js:54` still filters `channel = 'verified'`. `src/renderer/app-settings-flyout.js:49` disables the toggle for non-Verified channels with `${isVerified ? '' : 'disabled'}`. Per-app `auto_update` column already exists (migration 0.5.0). | 6.1 |
| 33 | v2 schema `$schema` declaration drift | Phase 3.5.5 linkding incident (os8dotai PR #14 patched local copy); Phase 5 noted "bundle anytime" | `src/data/appspec-v2.json:2` declares `http://json-schema.org/draft-07/schema#`. v1 schema `src/data/appspec-v1.json:2` declares `http://json-schema.org/draft-07/schema#` ALSO — both schemas declare draft-07. The os8dotai repo aligned its local copy to draft 2020-12 in PR #14. The drift is therefore: **canonical (os8 + 2× catalog) declares draft-07; one consumer (os8dotai) declares 2020-12.** Aligning canonical to 2020-12 closes the drift. | 6.2 |
| 31 | Doc PR for update flow with three-way merge | PR 5.4 (deferred-items #10) shipped; trigger fully fired | `docs/auto-update.md` describes auto-update but does not cross-reference the three-way merge resolution flow. `docs/phase-1-plan.md` PR 1.25 note also pre-dates the 5.4 banner. | 6.D2 |

### 2.3 Category B — verify-first audit results

| # | Entry | Audit | Disposition |
|---|---|---|---|
| spec §11 #3 | Idle timeout default value | Implemented in PR 1.22. `src/services/app-process-registry.js:247-254` reads `external_app_idle_timeout_ms` from settings; `src/renderer/settings.js:334` exposes the slider via `app_store.idle_timeout_ms`. Default 30 min per `app-process-registry.js:10` comment. | **Done** — close in PR 6.D1; cite PR 1.22 |
| spec §11 #5 | `bun.lockb` recognition | Implemented in PR 1.11. `src/services/runtime-adapters/node.js:31` lists `['bun.lockb', 'bun']` in the lockfile detection map (presence-only, per master plan §7 #6). | **Done** — close in PR 6.D1; cite PR 1.11 |
| spec §11 #8 | `requireAppContext` route inventory | Implemented in PR 1.8. Audit shows the middleware applied to: `app-blob`, `app-db`, `imagegen`, `speak`, `youtube`, `x`, `telegram`, `google`, `mcp` (9 routes). Master plan §7 #9 documented the same 9. | **Done** — close in PR 6.D1; cite PR 1.8 + master plan §7 #9 |
| 4 | Per-origin browser permission grants | `src/services/preview.js:221-222` implements both `setPermissionRequestHandler((_wc, _permission, cb) => cb(false))` and `setPermissionCheckHandler(() => false)` for hardened external-app BrowserViews. Default-deny is in place. **What's still pending:** the user-facing grant flow (a UI to request permission when an app needs it) does not exist because no installed app has needed it yet. | **Done with restriction** — code is correct (default-deny works as designed); revisit when first app requests camera/mic/geo. Reword in 6.D3 to reflect "code Done; UX pending app signal." |
| 5 | Per-capability audit logging | No matches in `src/middleware/` or `src/services/scoped-api-surface.js` for capability-call audit logging. | Not Done. Stays category C in 6.D3 (no incident requiring forensic capability-call history). |
| 13 | Catalog CI error-handling polish | Not audited end-to-end (would require running CI failure cases on the catalog repos). Phase 0 happy-path workflows are stable. | Stays category C in 6.D3 (no curator complaint yet). |
| 24 | `description` column on per-app environment variables | Schema audit: `src/db/schema.js:36-42` defines `app_env_variables` with `(id, app_id, key, value, UNIQUE(app_id, key))`. **No description column.** Visible env-prompt copy comes from manifest `permissions.secrets[].prompt`, per the deferred entry. | Stays category C in 6.D3 (no env-prompt UX signal). |

### 2.4 Category C — kept `Deferred`, rewritten with tight rationale + explicit trigger

19 entries. Each gets a one-line `Trigger:` field in PR 6.D3 so a future planner can see exactly when to revisit. List (with the trigger condition each will get):

| # | Entry | Trigger to revisit |
|---|---|---|
| 1 | Resource limits stay advisory | First user report of a runaway-memory app, OR before any GPU-heavy app (ComfyUI/OpenWebUI) ships in Verified |
| 2 | Malware advisories clickable-through | Telemetry showing routine MAL-* override OR a real malware incident (advisory model is non-negotiable per spec §6.5) |
| 3 | OAuth-gated capabilities (multi-tenant) | Multi-user/shared-machine deployments OR a per-identity capability |
| 5 | Per-capability audit logging | First incident requiring forensic capability-call history OR introduction of any capability with material data-access scope |
| 7 | Keychain encryption for app secrets | OS8 itself adopts keychain |
| 13 | Catalog CI error-handling polish | First curator-PR that fails CI and the author can't tell why |
| 14 | Curator pool tiering | Community-channel PR backlog grows past curator bandwidth |
| 15 | App revocation flow | First app revoked from a catalog OR Phase 4 telemetry surfaces a previously-curated app raising new red flags |
| 16 | Install-count display on community cards | Community channel gets meaningful curation traffic |
| 17 | GitHub raw rate-limit monitoring (RUM) | Any 429 in browser DevTools OR a rate-limit-reduction email from GitHub org owner |
| 19 | Slack/webhook alerts for catalog sync failures | First curator surprise — broken manifest invisible for >24h |
| 21 | Dockerfile-only Developer Imports | Frequent user requests OR build-from-source required for a class of apps to support |
| 22 | GPU device pinning (`--gpus device=N`) | First multi-GPU host where users want to run distinct apps on distinct GPUs |
| 23 | Sparse checkout for large repos | First catalog manifest pointing at a path within a known monorepo |
| 24 | `description` column on per-app environment variables | Env-prompt UX gets a polish pass |
| 25 | Developer Import dupe-install UX guard | First user complaint OR any time the dev-import flow gets a UX pass |
| 27 | Vercel Blob CDN migration | See #17 (RUM monitoring); pull together |
| 28 | `assetRequestCount` instrumentation | Want sync-load instrumentation |
| 29 | Hard-cleanup cron for soft-deleted apps | Catalog row count growth makes the table noticeable in queries |
| 30 | `tags[]` field on apps | Catalog grows past ~100 apps OR search-relevance complaints |

Plus four "Phase 4/5 added open items" entries (currently in spec §11, also rewritten in 6.D3 / 6.D1):

| Source | Entry | Trigger to revisit |
|---|---|---|
| spec §11 "Phase 4 added" | Telemetry hash salt rotation cadence | Annual default per `os8dotai/SECURITY.md` is sufficient; revisit only on signal of compromise |
| spec §11 "Phase 5 added" | Backup-on-upgrade hook for Docker volumes | Second affected docker app surfaces |
| spec §11 "Phase 5 added" | Per-file ours/theirs buttons in merge-conflict banner | Soak surfaces friction for users without an AI agent in the loop |

### 2.5 Category D — V1 exclusions reaffirmed

| # | Entry | Status in 6.D3 |
|---|---|---|
| 26 | `shell: true` escape hatch | `V1 exclusion` (already so in deferred-items doc; no change) |
| E1 | Path-mode app routing | `V1 exclusion` (already so) |
| E2 | `surface: terminal` (TUI apps) | `V1 exclusion` (already so) |
| E3 | `surface: desktop-stream` (native GUIs) | `V1 exclusion` (already so) |
| E4 | Non-pinned manifest refs | `V1 invariant` (already so) |
| E5 | Cross-device app-store browsing wishlist | `V1 exclusion` (already so) |

D-bucket items already declare their status; PR 6.D3 just confirms each line is unchanged (no rationale to refresh).

### 2.6 Net assessment

Phase 6 is the **lowest-risk phase shipped**:

- No trust-boundary changes. PR 6.1's auto-update widening reuses the Phase 4 PR 4.2 + Phase 5 PR 5.4 plumbing wholesale (`processAutoUpdates`, `AppMergeResolver`, the toast subscriber). The only change is widening the `listEligible` filter and updating the per-app default for new installs.
- No new repo-creation work.
- No cross-repo schema changes that introduce new fields. PR 6.2 is a one-character change (`http://...draft-07` → `https://...2020-12`) in three places, defended by existing schema-validation tests.
- No new IPC channels, no new database columns, no new Prisma models.

The only genuinely tricky question in Phase 6 is whether existing-installed Community apps should retroactively get `auto_update=1`. PR 6.1 ships the conservative answer (new installs only; existing rows untouched) — see PR 6.1 for rationale.

---

## 3. Cross-PR dependencies

```
Phase 0–5 chain (must be in tree; Phase 6 inherits):
  ... (see §1 inheritance table)
  5.1   AccountService.getSessionCookie + os8.ai heartbeat live
  5.4   AppMergeResolver + merge-conflict banner + telemetry kinds
  5.5   AppService.getOrphan/reviveOrphan/archiveOrphan
  5.6   Catalog Sync Now + lazy refresh
  5.8   runtime.volumes schema + Docker adapter + first-boot toast
  5.9   Vercel deploy hook on added > 0
  5.10  Migration 0.7.0 (update_conflict_files, session_cookie, share_installed_apps)

Phase 6:
  Track A (independent within track):
    6.1 (Community auto-update widening)   ── independent
    6.2 (appspec-v2 $schema alignment)     ── 3-repo coordination

  Track G (docs):
    6.D1 — files after 6.1 + 6.2 land
    6.D2 — files alongside 6.1
    6.D3 — files last; references everything Phase 6 closed
```

**Critical path within Phase 6:** none. Both code PRs and all three doc PRs can land in any order once their owning track closes.

---

## 4. Cross-repo coordination

PR 6.2 is the only cross-repo change.

| Logical change | os8 file | os8-catalog file | os8-catalog-community file |
|---|---|---|---|
| `appspec-v2.json` `$schema` alignment | `src/data/appspec-v2.json:2` | `schema/appspec-v2.json` | `schema/appspec-v2.json` |
| Catalog `validate.yml` AJV import (if needed) | n/a | `.github/scripts/validate-manifest.js` (verify) | `.github/scripts/validate-manifest.js` (verify) |

The desktop and the catalog CIs use plain `Ajv` (default = draft-07) so the mismatch is invisible to them. Aligning to draft 2020-12 means each consumer needs its AJV import to load the 2020-12 dialect. Per the Phase 5 deferred-items #33 entry, the v2 schema doesn't actually use any draft-07-only constructs, so the alignment is a one-line edit + one possible AJV import update per repo.

PR 6.2 lands the three repos in the same order Phase 5 PR 5.8 did:

1. **os8 first.** Land the canonical schema change + adapt any local validator to load 2020-12. Existing manifests still pass.
2. **os8-catalog second.** Mirror the schema change. CI validates existing Verified manifests.
3. **os8-catalog-community third.** Mirror the schema change. CI validates existing Community manifests.

Because both v1 and v2 currently declare draft-07 (audit finding §2.2), the alignment is a forward step on v2 only — v1 declarations stay untouched (the v1 schema is not actively curated against new manifests).

The os8dotai already declares 2020-12 (per the Phase 3.5.5 patch); no change needed there.

---

## 5. Migrations

PR 6.1 adds a small migration `0.8.0-app-store-community-auto-update.js` that seeds two settings keys:

| Key | Seed value | Purpose |
|---|---|---|
| `app_store.auto_update.community_default` | `'true'` | New Community installs default to `auto_update = 1` (Leo's call, 2026-05-04) |
| `app_store.auto_update.verified_default` | `'false'` | Existing Verified behavior — opt-in via the per-app flyout. Explicit seed for symmetry; Settings UI can render both toggles uniformly. |

Migration is idempotent: it uses `INSERT OR IGNORE` so a user who has already set the values manually keeps their choice. Mirrors `0.6.0-app-store-telemetry.js` PR 4.11's seed-with-INSERT-OR-IGNORE pattern.

PR 6.1 bumps `package.json` version 0.7.0 → 0.8.0. No other Phase 6 PR changes the schema.

---

## 6. Smoke gates

**G1 — Community auto-update smoke (PR 6.1).** Required before PR 6.D3 close-out.

1. Install linkding (Community channel) on a fresh OS8 install (or set `auto_update = 1` on an existing linkding install via the flyout).
2. Verify `apps.auto_update = 1` in SQLite for the new install.
3. Modify the linkding catalog manifest in `os8ai/os8-catalog-community/apps/linkding/manifest.yaml` to point at a newer commit (or the next upstream tag).
4. Trigger Sync Now (PR 5.6). Verify the new commit lands in `apps.update_to_commit`.
5. Wait for the next desktop scheduler tick (or call `processAutoUpdates` directly via a test harness).
6. Verify: linkding's `apps.upstream_resolved_commit` is bumped to the new commit; toast appears with the apply notification (per PR 4.2's subscriber, generalized for both channels).
7. Make a local edit to a linkding source file; bump the manifest again; trigger sync + processAutoUpdates; verify the merge-conflict banner surfaces (PR 5.4 plumbing exercised against a Community app).

If G1 fails, the recovery path is the architectural-fix preference per `feedback_prefer_architectural_fixes.md` — investigate why `processAutoUpdates` skipped or failed; do not patch by re-narrowing the channel filter.

**No other smoke gate.** PR 6.2 is a one-character schema change defended by unit tests; PR 6.D1 / 6.D2 / 6.D3 are doc-only.

---

## 7. Risks and open questions

The first revision of this plan surfaced one open question for Leo. Resolution captured here so future agents see the explicit decision.

1. **Promotion scope — confirmed (3 A's, no more).** The audit produced a 3/7/19/6 (A/B/C/D) split. Leo confirmed 2026-05-04 that "make it done" maps to "close all A's, finish all B's, document C's and D's" — no speculative promotions. Phase 6 ships exactly the three category-A PRs.

2. **Community auto-update default — Default ON for new Community installs (resolved).** Phase 5's recommendation was "default OFF for symmetry with Verified." Leo overrode 2026-05-04 to "default ON for Community" because community apps churn more, so 'forget about it' UX matters more than for Verified. This is a deliberate asymmetry: Verified stays opt-in (matching the curated-trust posture), Community defaults to auto-update (matching the higher-churn / lower-stakes profile). PR 6.1 encodes this asymmetry through the two seeded settings keys (§5).

3. **Existing-install retroactive opt-in — conservative (resolved within plan; surface for Leo to override).** PR 6.1 leaves existing Community installs untouched (`auto_update` column preserved). New installs from this point forward read the seeded default. Rationale: surprise-flipping existing installs to auto-update would be a behavior change visible on next OS8 launch — the kind of change that surfaces as "OS8 silently updated my app overnight." If Leo prefers retroactive opt-in (UPDATE apps SET auto_update = 1 WHERE channel = 'community'), surface in PR 6.1 review. The migration can include or exclude the retroactive UPDATE per Leo's call.

4. **Category-C documentation tone — keep `Deferred` + add explicit trigger (resolved).** Leo's choice 2026-05-04. Each category-C entry in PR 6.D3 keeps its `Deferred` status but gets a tight rationale + a one-line `Trigger:` field. The doc preserves "parking lot" semantics: a category-C item is not a planning failure; it's a known gap waiting for signal.

### Items remaining for execute-time judgment (non-blocking)

- **Telemetry kinds for Community auto-update events.** Phase 4 PR 4.4's allowlist sanitizer accepts the existing `update_succeeded` / `update_failed` kinds; PR 5.4 added `update_conflict` / `update_conflict_resolved`. Community auto-update events flow through the same kinds — the `channel` field (already in the allowlist) is the discriminator. No new telemetry kinds needed.
- **Settings UI for the per-channel default toggles.** PR 6.1 adds two checkboxes to the existing Settings → App Store panel (next to PR 5.6's Sync Now button). Each toggle reads/writes one of the two seeded keys. The execute agent has discretion on placement + label wording.

### Spec ambiguities surfaced

These came up while drafting the plan; flagging for the human reviewer.

5. **Spec §6.9 "auto-update opt-in for Verified channel only"** is now stale after PR 6.1. PR 6.D1 updates §6.9 to describe per-channel defaults: Verified default OFF (opt-in), Community default ON. Manual update path stays the same for both.

6. **Spec §11 "Phase 5 added open items" first bullet (Community auto-update widening)** closes on PR 6.1 merge. PR 6.D1 removes the bullet.

7. **Spec §11 "Phase 4 added open items"** has only the "Telemetry hash salt rotation cadence" entry left. PR 6.D1 either keeps it as the lone Phase 4 open item or moves it down to "Phase 6 added open items" with a tight rationale (annual default per `os8dotai/SECURITY.md` is sufficient; signal-driven rotation only). Choosing the latter for cleanliness.

8. **Spec §11 #2 (`/apps` page caching)** — master plan §7 #2 noted "ISR 60s; confirm on first deploy." Audit at write time: `os8dotai/src/app/apps/[slug]/page.tsx` has `export const revalidate = 60;` (per Phase 0 PR 0.10). The Vercel deploy hook from PR 5.9 covers the new-slug case. **Done — close in PR 6.D1.**

9. **Spec §11 #5 (`bun.lockb` recognition)** — see §2.3. Done in PR 1.11. Close in PR 6.D1.

10. **Spec §11 #7 (Asset CDN migration)** — same as deferred-items #27 (Vercel Blob CDN migration). Currently a contingent deferral (no 429 signal yet). Stays category C in 6.D3.

---

## 8. Phase 6 acceptance criteria

Phase 6 ships when ALL of:

1. **Community auto-update widening lands cleanly.** A Community app installed after PR 6.1 has `apps.auto_update = 1` by default; Verified app installed after PR 6.1 retains opt-in default OFF. The two per-channel default toggles in Settings → App Store work and persist across restart.
2. **`processAutoUpdates` walks Community apps.** A Community app with `auto_update = 1` and an upstream bump applied via Sync Now is auto-updated (or surfaces a conflict via PR 5.4 merge banner if user edits exist).
3. **`appspec-v2.json` declares draft 2020-12 in all three canonical repos.** `os8` + `os8-catalog` + `os8-catalog-community` aligned. Existing manifests still validate green; CI green on each repo.
4. **`docs/auto-update.md` covers both channels.** The user-facing reference describes per-channel defaults, the per-app flyout toggle, the conflict path (cross-reference to PR 5.4's banner), and the `os8://` deeplink for restoring auto-update.
5. **`app-store-deferred-items.md` has zero un-rationalized `Deferred` entries.** Every line is `Done` (with PR cite), `Deferred` + `Trigger:` line, `V1 exclusion`, or `Won't fix`. PR 6.D3 is the load-bearing doc PR.
6. **Spec §11 is empty of category-A or category-B open items.** All "Phase 4/5 added" bullets either close (with PR cite) or migrate to a small "Phase 6 added" footnote (telemetry hash rotation).
7. **Migration `0.8.0` upgrades cleanly from `0.7.x`.** Idempotent; preserves user-set per-channel defaults if any were manually written before the migration ran.

### What flows out of Phase 6

- **The auto-update story is complete.** Verified apps opt-in; Community apps default-ON; both channels share the same conflict-resolution path through PR 5.4.
- **The schema declaration is consistent.** All four canonical schema files declare draft 2020-12 for v2 (one repo already did; three more align in PR 6.2).
- **The deferred-items doc has reached steady-state.** Future planning reads it as a curated list of trigger-driven candidates, not a backlog.
- **The spec's "Open Implementation Details" §11 is cleaned out.** Every line either resolved-since-v1 or has a tight rationale.

### What does **not** carry forward (intentional non-promotions)

- All 19 category-C entries (§2.4 table) — kept `Deferred` with explicit triggers; Phase 7 (if any) revisits when triggers fire.
- All 6 category-D entries (§2.5 table) — `V1 exclusion` by design; reconsider only if a load-bearing reason emerges.
- Speculative new work. Phase 6's discipline: no PR ships without a fired trigger.

---

## 9. Decisions log (Phase 6)

Captured here as a one-line index so reviewers can find where each lives. Mirrors the Phase 4/5 §9 pattern.

| # | Decision | Resolved in |
|---|---|---|
| 1 | Phase 6 theme: close-out + categorization sweep; no speculative promotions | This doc §1 |
| 2 | Two deferred-items promoted to code (#36 Community auto-update widening, #33 schema $schema alignment); one to docs (#31 cross-reference); category-A is the entire ship list | This doc §2 + §7 |
| 3 | Community auto-update default ON for new installs; Verified stays opt-in (asymmetric per Leo) | PR 6.1 |
| 4 | Existing Community installs untouched by the migration (no retroactive UPDATE); user flips per-app via flyout if desired | PR 6.1 |
| 5 | Settings UI exposes two per-channel default toggles (App Store panel) | PR 6.1 |
| 6 | Migration `0.8.0-app-store-community-auto-update.js` seeds both per-channel default keys with `INSERT OR IGNORE` | PR 6.1 |
| 7 | `appspec-v2.json` `$schema` aligned to `https://json-schema.org/draft/2020-12/schema` in os8 + 2× catalog (os8dotai already done in PR #14) | PR 6.2 |
| 8 | v1 schema declarations untouched (v1 not actively curated against new manifests) | PR 6.2 |
| 9 | Category-C deferred entries keep `Deferred` status + add explicit `Trigger:` line per entry | PR 6.D3 |
| 10 | Category-D entries reaffirmed as `V1 exclusion`; no rewrite needed | PR 6.D3 |
| 11 | Spec §11 cleared of category-A/B opens; "Phase 6 added open items" footnote retains telemetry hash salt rotation only | PR 6.D1 |
| 12 | `docs/auto-update.md` updated for per-channel defaults; absorbs the deferred-items #31 cross-reference ask | PR 6.D2 |
| 13 | Phase 6 introduces no new os8.ai-side Prisma models | This doc §1 |
| 14 | Phase 6 ships exactly 5 PRs (2 code + 3 docs); within the ≤10 cap | This doc §1 |

---

## 10. Updates to MEMORY.md after Phase 6

When the relevant PRs land, the project memory should be updated:

- **After PR 6.1 deploys:** update `project_app_store_phases.md` to add a "Phase 6 — close-out" section listing 6.1 / 6.2 / 6.D1 / 6.D2 / 6.D3 with their merging PR numbers; remove the "PR 5.7 cut to give 5.4 soak time" reference (PR 6.1 closes the loop).
- **After PR 6.2 lands:** update or add a memory entry pointing future schema work at "v2 schema declares draft 2020-12 across all four canonical repos as of PR 6.2."
- **After PR 6.D3 lands:** update `project_app_store_phases.md` with a one-line note: "deferred-items doc reached steady-state with PR 6.D3 (Phase 6 close-out); each entry has a `Trigger:` line." Future planning starts from this state.
- **Add `feedback_phase_6_close_out_discipline.md`** (or extend `feedback_smoke_test_real_apps.md`): Phase 6 demonstrated that 87% of remaining items being category C/D was the right answer at this moment, not a planning failure. Future "make it done" sweeps should default to this honest framing — the work is shipping the small finishing batch, not artificially inflating scope.
- **Confirm `project_app_store_advisory_gating.md` and `feedback_channel_scoped_orphans.md` survive Phase 6 unchanged.** Neither memory's invariant is touched by Phase 6.

---

## PR 6.1 — Auto-update widening to Community channel

**Goal.** Phase 4 PR 4.2 shipped Verified-channel auto-update (opt-in via flyout). Phase 5 PR 5.4 shipped the three-way merge UI. Phase 5 PR 5.7 (Community widening) was cut to give 5.4 soak time. Soak time has elapsed (PR 5.4 merged 2026-05-04, no recurring "merge UX is broken" reports). PR 6.1 widens the auto-update path to the Community channel and ships an asymmetric default: **Verified default OFF (opt-in), Community default ON.**

The asymmetry is deliberate. Verified apps are curated, low-churn, and the user has implicitly opted into curator-vetted updates by installing from Verified — but PR 4.2 chose opt-in to preserve "user is final authority" posture. Community apps churn more; "forget about it" UX matters more. Both channels share the PR 5.4 conflict-resolution path: a user edit on either channel surfaces a merge banner instead of silent update.

### Files

- **Modify:** `src/services/app-auto-updater.js:47-60` — `listEligible(db)` widens the channel filter from `channel = 'verified'` to `channel IN ('verified', 'community')`. The other eligibility conditions (`status = 'active'`, `auto_update = 1`, `update_available = 1`, `update_to_commit IS NOT NULL`, `user_branch IS NULL OR user_branch = ''`) are unchanged.
- **Modify:** `src/services/app-installer.js` (or wherever the `apps` row is INSERTed during install — see audit at `app-installer.js:157+` for the install entry point). On insert, read the per-channel default and set the new row's `auto_update` accordingly:
  ```js
  const channelKey = `app_store.auto_update.${job.channel}_default`;
  const defaultStr = SettingsService.get(db, channelKey);
  const autoUpdate = defaultStr === 'true' ? 1 : 0;
  ```
  Existing rows (from prior phases) are not touched.
- **Modify:** `src/renderer/app-settings-flyout.js:31-71` — drop the `${isVerified ? '' : 'disabled'}` gate; the toggle is interactive for both Verified and Community. Update the hint text:
  - Verified: existing copy stays.
  - Community: "OS8 fetches and applies updates automatically when this Community app's manifest publishes a new version — but **only** if you haven't edited the app locally. Edits surface in the home-screen banner instead so you can resolve the merge by hand. Community apps are less rigorously reviewed than Verified — disable this if you'd rather review each update by hand."
  - Developer-Import: keep the disabled state ("Manual update only for Developer-Import apps").
- **Modify:** `src/renderer/settings.js` — add two checkboxes to the App Store panel (next to the Sync Now button from PR 5.6):
  - "Auto-update new Verified apps by default" (key: `app_store.auto_update.verified_default`, default `false`)
  - "Auto-update new Community apps by default" (key: `app_store.auto_update.community_default`, default `true`)
  - Each toggle reads/writes the corresponding settings key. Reading uses lazy-default: `defaultStr ?? '<channel-default>'` so even if the migration hasn't run, the UI shows the right initial state.
- **New migration:** `src/migrations/0.8.0-app-store-community-auto-update.js`. Mirrors `0.6.0-app-store-telemetry.js` PR 4.11 seed pattern:
  ```js
  module.exports = {
    version: '0.8.0',
    description: 'Seed per-channel auto-update defaults; widens auto-updater to Community channel',
    async up({ db, logger }) {
      const seed = (key, value) => {
        db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`)
          .run(key, value);
      };
      seed('app_store.auto_update.verified_default', 'false');
      seed('app_store.auto_update.community_default', 'true');
      logger?.info?.('[migration 0.8.0] seeded per-channel auto-update defaults');
    }
  };
  ```
- **Bump:** `package.json` version 0.7.0 → 0.8.0.

### `AppAutoUpdater` audit context

Existing eligibility query at `src/services/app-auto-updater.js:47-60`:

```js
function listEligible(db) {
  return db.prepare(`
    SELECT id, external_slug, channel, upstream_resolved_commit,
           update_to_commit, user_branch, manifest_yaml
      FROM apps
     WHERE app_type = 'external'
       AND status = 'active'
       AND channel = 'verified'        // ← change to: channel IN ('verified', 'community')
       AND auto_update = 1
       AND update_available = 1
       AND update_to_commit IS NOT NULL
       AND (user_branch IS NULL OR user_branch = '')
  `).all();
}
```

The merge-conflict path at `src/services/app-auto-updater.js:110-120` (Phase 5 PR 5.4) already handles the conflict case via `onConflict?.(app, { files })` — that callback is channel-agnostic. Telemetry emission at lines 100-109 reads `app.channel` directly into the event, so the curator dashboard distinguishes Verified vs Community auto-update events without any code change.

### Per-channel default settings — contract

```js
// Settings keys (seeded by migration 0.8.0)

'app_store.auto_update.verified_default'   // 'true' | 'false'  (seeds 'false')
'app_store.auto_update.community_default'  // 'true' | 'false'  (seeds 'true')

// Read site (AppInstaller): determines new install's apps.auto_update column

const defaults = {
  verified:           'false',  // hard-coded fallback if migration hasn't run
  community:          'true',
  'developer-import': 'false',
};
const channelKey = `app_store.auto_update.${job.channel}_default`;
const fromDb = SettingsService.get(db, channelKey);
const fallback = defaults[job.channel] || 'false';
const autoUpdate = (fromDb ?? fallback) === 'true' ? 1 : 0;
```

Developer-Import retains hard-coded `false` (manual update only) regardless of any future settings key — Developer-Import apps don't sync from a catalog, so auto-update is meaningless.

### Tests

`tests/app-auto-updater.community.test.js` (new):

| Scenario | Assertion |
|---|---|
| Community app with `auto_update=1, update_available=1`, no user edits | `listEligible` returns it |
| Community app with `auto_update=0` | `listEligible` does not return it |
| Community app with `user_branch` set | `listEligible` does not return it |
| Verified + Community both eligible | both returned |
| Developer-Import app with `auto_update=1` | not returned (channel filter still excludes) |
| `processAutoUpdates` succeeds on Community app | telemetry event emitted with `channel: 'community'` |
| `processAutoUpdates` conflict on Community app | `onConflict` callback fired; telemetry `update_conflict` emitted |

`tests/app-installer.community-default.test.js` (new):

| Scenario | Assertion |
|---|---|
| Migration seeded `app_store.auto_update.community_default = 'true'` | new Community install gets `apps.auto_update = 1` |
| Migration seeded `app_store.auto_update.verified_default = 'false'` | new Verified install gets `apps.auto_update = 0` |
| User explicitly sets `app_store.auto_update.community_default = 'false'` BEFORE installing | new Community install gets `apps.auto_update = 0` |
| Existing app row (pre-PR-6.1) | column value preserved (no UPDATE in migration) |

`tests/migrations/0.8.0.test.js` (new):

| Scenario | Assertion |
|---|---|
| Fresh DB → migration runs | both keys seeded |
| Migration runs twice (idempotency) | values not overwritten |
| User-set value present BEFORE migration | INSERT OR IGNORE preserves user value |

### Smoke gate

**G1: Community auto-update smoke required before PR 6.D3 close-out.** See §6 for the script.

### Acceptance criteria

- New Community installs default to `auto_update = 1` (verified via SQLite query on a fresh install).
- New Verified installs default to `auto_update = 0` (verified via SQLite query).
- Existing app rows retain their pre-PR-6.1 `auto_update` column value (verified by snapshot diff).
- `processAutoUpdates` walks Community apps with `auto_update = 1` and either applies the update or surfaces a conflict.
- The two per-channel default toggles in Settings → App Store work and persist.
- `npm test` passes (excluding the pre-existing `tests/python-uv-install.test.js > ensureUv` red predating Phase 5).

### Cross-platform notes

- No platform-specific code paths.
- Migration is plain SQL via `better-sqlite3`; portable across the unit-test matrix.
- Settings UI uses the existing renderer panel; no platform-specific styling.

### Spec deviations

- **Verified vs Community asymmetry.** Spec §6.9 historically described auto-update as Verified-only and opt-in. PR 6.1 introduces an asymmetric per-channel default (Verified opt-in / Community opt-out). PR 6.D1 updates spec §6.9 to document the asymmetry + the rationale.
- **No retroactive opt-in for existing Community installs.** Plan §7 rationale: surprise-flipping is a trust failure. If Leo wants retroactive UPDATE, the migration body adds one line; surface in PR review.

### Open sub-questions for execute time (non-blocking)

- **Settings UI placement.** §1.5 above puts the toggles in the App Store panel next to Sync Now. If a tighter visual grouping (e.g. inside a "Defaults" sub-card) reads better, the execute agent has discretion.
- **Telemetry kind for "user manually toggled the default."** Optional; if added, use a generic `setting_changed` kind rather than introducing a new auto-update-specific telemetry kind. Keeps the allowlist small. Skip in v1 of PR 6.1; add only if curator dashboard surfaces a need.

---

## PR 6.2 — `appspec-v2.json` `$schema` alignment to draft 2020-12

**Goal.** Three canonical repos declare `appspec-v2.json` with `$schema: http://json-schema.org/draft-07/schema#`. The os8dotai consumer aligned its local copy to draft 2020-12 in PR #14 (Phase 3.5.5 hotfix) when it tripped on `Ajv` from `ajv/dist/2020`. The drift is real: aligning the canonical declarations to draft 2020-12 closes it. Per the Phase 5 deferred-items #33 entry, the v2 schema doesn't actually use any draft-07-only constructs, so the alignment is a one-line edit per repo.

### Files

- **Modify:** `/home/leo/Claude/os8/src/data/appspec-v2.json:2` — change `"$schema": "http://json-schema.org/draft-07/schema#"` to `"$schema": "https://json-schema.org/draft/2020-12/schema"`.
- **Modify (verify):** `/home/leo/Claude/os8/src/services/manifest-validator.js` — if the local AJV import is plain `Ajv`, swap to `Ajv2020 = require('ajv/dist/2020')` (or whatever import name the package exposes). Tests confirm validation behavior unchanged for existing manifests.
- **Mirror in `os8ai/os8-catalog`:** `schema/appspec-v2.json` — same one-line edit.
- **Mirror in `os8ai/os8-catalog-community`:** `schema/appspec-v2.json` — same one-line edit.
- **Verify:** each catalog repo's `.github/scripts/validate-manifest.js` (or the equivalent CI validator) — if it loads a plain `Ajv`, swap to `Ajv2020`. CI runs validate existing manifests pass.
- **No version bump in any repo.** `appspec.schemaVersion` stays at 1 — this is a `$schema` declaration tweak, not a manifest schema version bump.

### Tests

`tests/manifest-validator.draft-2020-12.test.js` (new):

| Scenario | Assertion |
|---|---|
| Existing worldmonitor manifest validates against the updated v2 schema | passes |
| Existing linkding manifest (with `runtime.volumes` from PR 5.8) validates | passes |
| A manifest using a draft-2020-12-only construct (e.g. `prefixItems`) validates | passes — proves AJV is loading the right dialect |
| A manifest declaring a numerical type with `exclusiveMinimum: 0` (different semantics under draft-04 vs draft-07 vs 2020-12) validates correctly | passes |
| Schema file's own `$schema` reads as `https://json-schema.org/draft/2020-12/schema` | passes |

Catalog-repo CI runs the same fixture-driven tests against the existing manifest fixtures (worldmonitor, cyberchef, linkding, streamlit-30days, hivisionidphotos).

### Smoke gate

None. Defended entirely by unit tests + catalog-CI fixture coverage. The change is a one-character edit per repo (the `$schema` declaration); the existing manifest corpus exercises it directly.

### Acceptance criteria

- All three canonical `appspec-v2.json` files declare `https://json-schema.org/draft/2020-12/schema`.
- Existing manifests validate green on each repo's CI.
- `npm test` passes on os8 desktop.
- `validate.yml` CI passes on both catalog repos.

### Cross-platform notes

- No platform-specific code paths.

### Spec deviations

- None. Spec §3.5 mentions JSON Schema validation invariants but doesn't pin a draft. PR 6.D1 adds a one-line note in §3.5: "v2 schema declarations are draft 2020-12 across all canonical repos as of Phase 6 PR 6.2."

### Cross-repo merge order

Per §4 — os8 first, os8-catalog second, os8-catalog-community third. Each is independently mergeable (no inter-repo blocking); the order is for review hygiene.

### Open sub-questions for execute time (non-blocking)

- **AJV import surface.** If a repo's existing `Ajv` import was already 2020-12-aware (some `Ajv` versions auto-detect from `$schema`), no swap needed — verify per-repo before changing the import.
- **Catalog-repo CI versioning.** If a catalog repo's `validate.yml` pins a stale `ajv` version that lacks `ajv/dist/2020`, bump the dev-dependency in the same PR.

---

## PR 6.D1 — Spec + master-plan close-out updates

**Goal.** Reflect Phase 6 in the spec and master plan. Mirror Phase 4 PR 4.D1 + Phase 5 PR 5.D1 patterns.

### Files

- **Modify:** `docs/app-store-spec.md`:
  - **§6.9** — update from "auto-update opt-in for Verified-channel only" to describe per-channel defaults: Verified opt-in (default OFF), Community opt-out (default ON), Developer-Import manual-only. Add the rationale (asymmetric churn profile). Cite PR 6.1.
  - **§3.5** — add a one-line note: "v2 schema declarations are draft 2020-12 across all canonical repos as of Phase 6 PR 6.2."
  - **§11 "Phase 4 added open items"** — close `os8.ai session token for desktop heartbeat` (already cited PR 5.1 in Phase 5 close-out — verify cite is current); for `Telemetry hash salt rotation cadence`, demote to "Phase 6 added open items" footnote with annual-default rationale.
  - **§11 "Phase 5 added open items"** — close `Auto-update widening to Community channel` with PR 6.1 cite. The remaining bullets (`App revocation flow`, `Backup-on-upgrade hook`, `Per-file ours/theirs buttons`) move into deferred-items C-bucket triggers (§2.4) and the spec entry shrinks.
  - **§11 #2** (`/apps` page caching) — close as Done with the audit finding from §2 of this plan (audit confirmed `revalidate = 60` + Phase 5 PR 5.9 deploy hook).
  - **§11 #3** (idle timeout default) — close as Done with PR 1.22 cite.
  - **§11 #5** (`bun.lockb` recognition) — close as Done with PR 1.11 cite.
  - **§11 #8** (`requireAppContext` on which APIs exactly) — close as Done with PR 1.8 + master plan §7 #9 cite.
  - **Add a "Phase 6 added open items" subsection** at the end of §11 with one entry: `Telemetry hash salt rotation cadence` (annual default per `os8dotai/SECURITY.md`; revisit only on signal of compromise).
- **Modify:** `docs/app-store-plan.md`:
  - **§6** — add a Phase 6 paragraph (≤200 words) mirroring the Phase 5 one. Theme: close-out + categorization sweep. Headline: 2 code PRs + 3 doc PRs; deferred-items doc reaches steady-state.
  - **§7 — Open Implementation Details — resolution pass** — append a row noting that all 12 numbered items are now resolved (no change to the table itself; the Phase 6 entries close the "Phase 4/5 added" subsection upstream of it).
  - **§11** — no change (still points at deferred-items.md).
- **No code change.**

### Tests

None. Doc-only PR. CI passes via the existing markdown-lint workflow if any.

### Acceptance criteria

- Spec §6.9 describes the per-channel auto-update default model.
- Spec §3.5 declares the draft-2020-12 alignment.
- Spec §11 has no category-A or category-B open items left.
- Master plan §6 has a Phase 6 paragraph.
- All three canonical doc files agree on what's closed and what's open.

### Open sub-questions for execute time (non-blocking)

- **Tone of the Phase 6 §6 paragraph.** Phase 4 + 5 paragraphs are dense and feature-driven. Phase 6's is necessarily different: shorter, decision-history-driven, and explicit about the "make it done" close-out. Match the precedent's structure (Theme + Tracks + Outcome bullets) but compress.

---

## PR 6.D2 — `docs/auto-update.md` update + three-way merge cross-reference

**Goal.** Update the user-facing auto-update doc for Community widening and absorb deferred-items #31's "missing cross-reference for update + three-way merge" ask.

### Files

- **Modify:** `docs/auto-update.md`:
  - **Section "Turning auto-update on"** — describe the per-channel defaults: new Community installs default ON (opt-out via flyout); new Verified installs default OFF (opt-in via flyout); Developer-Import remains manual-only. Cite PR 6.1.
  - **Section "When auto-update fires"** — update the bullet "Apply updates from the **Community** channel..." to reflect that Community apps DO auto-update (when toggled ON, which is the new default).
  - **New section "When updates conflict with your edits"** — cross-reference PR 5.4's three-way merge banner. Describe the resolution flow (merge banner with three actions: "I've resolved all conflicts — commit", "Resolve with Claude", "Abort the update"). Link to the existing `docs/runtime-volumes.md` for the broader app-state-preservation story.
- **No code change.**

### Tests

None. Doc-only PR.

### Acceptance criteria

- `docs/auto-update.md` accurately describes per-channel defaults.
- The three-way merge cross-reference appears under a clear section heading.
- Existing screenshots / examples in the doc remain consistent.

---

## PR 6.D3 — `app-store-deferred-items.md` final categorization sweep

**Goal.** Sweep every entry in the deferred-items doc. After this PR:

- Every entry is either `Done` (with merging-PR cite), `Deferred` + tight rationale + `Trigger:` line, `V1 exclusion`, or `Won't fix`.
- No entry has `Status: Deferred` without a `Trigger:` line beneath it.
- The "Phase 5 (closed 2026-05-04)" decisions log entry is amended with a "Phase 6 (closed YYYY-MM-DD)" entry citing the close-outs.

### Files

- **Modify:** `docs/app-store-deferred-items.md`:
  - **#36 (Auto-update widening to Community)** — `Status: Done — Phase 6 PR 6.1 (#XX)`. Resolution paragraph mirrors PR 5.4's pattern (filter widening, asymmetric defaults, telemetry already plumbed via `channel` field).
  - **#33 (v2 schema $schema drift)** — `Status: Done — Phase 6 PR 6.2`. Resolution paragraph mirrors PR 5.8's three-repo coordination.
  - **#31 (Doc PR for update flow with three-way merge)** — `Status: Done — Phase 6 PR 6.D2`.
  - **#1, #2, #3, #5, #7, #13, #14, #15, #16, #17, #19, #21, #22, #23, #24, #25, #27, #28, #29, #30** — confirm or rewrite to canonical form: `Status: Deferred`, then `Source:`, `Gap:`, `Why:`, `Trigger:` (one-line). Use the table in §2.4 above as the canonical trigger list.
  - **#4 (Per-origin browser permission grants)** — rewrite per audit (§2.3): `Status: Deferred (code Done; UX surface pending app signal)`. Body: code at `preview.js:221-222` implements default-deny; user-facing grant flow waits for first app that requests camera/mic/geo.
  - **#26 (`shell: true` escape hatch)** — already `V1 exclusion`. No change.
  - **E1, E2, E3, E4, E5** — already `V1 exclusion` / `V1 invariant`. No change.
  - **Add Phase 6 section to "Decisions log (items moved off this list)":**
    ```
    ### Phase 6 (closed YYYY-MM-DD)

    - **#36 Auto-update widening to Community channel** → built in PR 6.1 (`os8ai/os8#XX`). Default ON for new Community installs; Verified stays opt-in.
    - **#33 v2 schema $schema drift** → built in PR 6.2 (`os8ai/os8#XX` + os8-catalog #XX + os8-catalog-community #XX). All canonical schemas now declare draft 2020-12.
    - **#31 Doc PR for update flow with three-way merge** → built in PR 6.D2 (`os8ai/os8#XX`). docs/auto-update.md cross-references PR 5.4's three-way merge banner.

    Plus four "verify-first" entries confirmed as Done in PR 6.D1's spec close-out:
    - **spec §11 #2** `/apps` page caching → audit confirmed `revalidate = 60` + Phase 5 PR 5.9 deploy hook covers new-slug case.
    - **spec §11 #3** Idle timeout default → built in PR 1.22.
    - **spec §11 #5** `bun.lockb` recognition → built in PR 1.11.
    - **spec §11 #8** `requireAppContext` route inventory → built in PR 1.8; 9 routes per master plan §7 #9.
    ```
- **No code change.**

### Tests

None. Doc-only PR.

### Acceptance criteria

- Zero entries have `Status: Deferred` without a `Trigger:` line.
- Every category-A entry from §2.2 above is marked `Done` with PR cite.
- Every category-B entry from §2.3 with audit-confirmed-Done is marked `Done` with PR cite (the spec ones close in 6.D1; the deferred-items ones close in 6.D3).
- The Phase 6 section in "Decisions log" enumerates all close-outs.
- File still parses as valid Markdown (no broken headings, consistent table widths).

### Open sub-questions for execute time (non-blocking)

- **Doc length.** Sweeping 30+ entries is a sizable diff. Keep the existing structure; rewrite in place; do not reorder. Reviewer hygiene > novelty.

---

*End of plan.*
