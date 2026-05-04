# App Store — deferred items

Running list of items intentionally **deferred during App Store work** so we don't lose track of them. Captured during Phase 3 wrap-up after a sweep of the spec, master plan, and phase 0–3 plans.

This is **not** a Phase 4 plan. Phase scope is set by the master plan + spec. Before each new phase starts, review this list and decide which items (if any) should be promoted into that phase's scope.

## How to use this doc

- **Add** an item when a phase plan, PR, or design discussion explicitly defers it. Cite the source.
- **Update status** when an item is promoted into a phase, completed, or definitively dropped.
- **Don't delete** entries — change `Status` instead. The history of why something didn't ship is useful when the question recurs.
- **Periodic review:** before kicking off a new phase, scan this doc and decide.

## Statuses

- `Deferred` — known gap, not yet scheduled
- `In progress` — scheduled in a current/upcoming PR
- `Done` — completed (cite the merging PR)
- `V1 exclusion` — intentionally out of v1 scope per spec; revisit only if a concrete signal demands it
- `Won't fix` — explicitly dropped (cite the decision)

Each entry should be tight: title, status, source, what's missing, why deferred, and a `Trigger` line (the condition that should make us reconsider).

---

## Trust & Security

### 1. Resource limits stay advisory
- **Status:** Deferred
- **Source:** spec §11; phase-3-plan.md §2.2
- **Gap:** `resources.memory_limit_mb` and `resources.gpu` surface in install plan UI but the runtime does not kill processes that exceed them.
- **Why:** Requires per-app RSS monitoring + signal handling + graceful shutdown — a multi-day effort with its own UX surface (warning toast → kill → restart prompt).
- **Trigger:** First user report of a runaway-memory app, OR before any GPU-heavy app (ComfyUI, OpenWebUI) ships in Verified channel.

### 2. Malware advisories are clickable-through
- **Status:** Deferred *(philosophical — see note)*
- **Source:** spec §6.5
- **Gap:** MAL-* advisories from the supply-chain scanner show a "louder header" but the install button remains active. No hard block.
- **Why:** v1 honors the advisory-gating posture — user is final authority across all channels (spec §6.5/§6.2.5/§2.3, updated 2026-04-30).
- **Note:** Hard-blocking *known* malware would be a narrow exception to the advisory model and is worth a deliberate decision, not a quiet flip.
- **Trigger:** Telemetry showing users routinely click through MAL-* warnings, OR a real malware incident.

### 3. OAuth-gated capabilities (multi-tenant)
- **Status:** Deferred
- **Source:** phase-3-plan.md §2.2
- **Gap:** Apps inherit the user's existing OAuth grants wholesale. No per-app OAuth-identity capability gating (e.g. "imagegen only for signed-in user X").
- **Why:** Requires multi-tenant auth refactor; not needed while OS8 is single-user-per-machine.
- **Trigger:** Multi-user/shared-machine deployments, OR a capability that is fundamentally per-identity.

### 4. Per-origin browser permission grants — untested end-to-end
- **Status:** Deferred *(verify first)*
- **Source:** spec §6.4
- **Gap:** Each app gets its own BrowserView + origin, so camera/mic/geolocation grants should isolate per app via `setPermissionRequestHandler`. Hardened config denies by default but the user-facing grant flow is implicit, never smoke-tested.
- **Why:** Should mostly work for free; just lacks a real test.
- **Trigger:** First app that requests camera/mic/geo, OR a security review pass.

### 5. Per-capability audit logging
- **Status:** Deferred *(verify first — may already exist in some form)*
- **Source:** implicit from spec §6.3.2
- **Gap:** Server-side capability enforcement middleware exists, but no log of "app X called db.readwrite at T". No audit trail if an app misuses capabilities.
- **Why:** Not part of the v1 review surface.
- **Trigger:** First incident requiring forensic capability-call history, OR introduction of any capability with material data-access scope.

### 6. Stricter `X-OS8-App-Context` header enforcement
- **Status:** Done — Phase 4 PR 4.6 (#53).
- **Resolution:** Strict mode flipped with origin-based allowlist
  (bare-localhost = trusted) + in-process token escape hatch +
  `OS8_REQUIRE_APP_CONTEXT_PERMISSIVE=1` rollback env var. The internal
  trust-boundary tightening did not touch the advisory-gating posture
  for scan findings (still per spec §6.5).

### 7. Keychain encryption for app secrets
- **Status:** Deferred *(low priority)*
- **Source:** spec §6.11
- **Gap:** App secrets stored plaintext in `app_env_variables`. No OS keychain integration.
- **Why:** Matches existing `EnvService` plaintext model for native apps; not worth special-casing apps unless OS8 itself moves to keychain.
- **Trigger:** OS8 adopts keychain for its own secrets, then App Store follows.

---

## Install / Update / Uninstall lifecycle

### 8. Streaming install logs in modal
- **Status:** Done — Phase 4 PR 4.1 (#45).
- **Resolution:** Buffered SSE relay (200ms cadence) with stream-classified
  rows, auto-scroll, Download Logs button. Docker pull progress
  compaction. Adapter `onLog` already plumbed in PR 1.11; PR 4.1 added
  the buffer + renderer + IPC for log file save.

### 9. Playwright E2E install harness
- **Status:** Done — Phase 4 PR 4.10 (#47).
- **Resolution:** Scaffold landed: bootOs8 helper + shell-boot spec +
  scoped-API origin-probe spec (with `@strict` env-gated assertions
  for the post-4.6 path). Linux + macOS in CI; Windows joins after
  PR 4.8's matrix promotion stabilizes. Install-end-to-end /
  dev-import / native-app specs are scaffolded with `.skip()` for
  follow-up flesh-out; documented in `tests/e2e/playwright/README.md`.

### 10. Three-way merge UI for updates with user edits
- **Status:** Done — Phase 5 PR 5.4 (#63).
- **Resolution:** Auto-update conflict surfaces as: bottom-right toast
  with "Resolve" action button, red dot overlay on the home-screen
  icon, and a merge-conflict banner inside the app listing each
  conflicted file with three actions — "I've resolved all conflicts —
  commit", "Resolve with Claude" (copies a structured prompt to the
  clipboard for Claude Code or any AI agent), and "Abort the update"
  (clean revert via `git merge --abort`). New service
  `AppMergeResolver` reconciles persisted DB state against live
  `git status --porcelain`; `markAllResolved` content-scans for raw
  `<<<<<<<` markers BEFORE `git add -u` to prevent committing a
  half-resolved file (silent footgun: `git add` of a conflicted file
  marks it resolved unconditionally). Conflict file list persists to
  the new `apps.update_conflict_files` JSON column (PR 5.10) so the
  banner survives restarts. New telemetry kinds `update_conflict` +
  `update_conflict_resolved` (with sanitizer field `conflictFileCount`)
  feed the curator dashboard.

### 11. Auto-update opt-in for Verified channel
- **Status:** Done — Phase 4 PR 4.2 (#48).
- **Resolution:** `AppAutoUpdater.processAutoUpdates` walks every
  Verified-channel external app with `auto_update=1`, `update_available=1`,
  and no `user_branch` (i.e. no local edits). Apply path is the
  fast-forward branch of `AppCatalogService.update` (PR 1.25). Per-app
  toggle in the app settings flyout. Toast subscriber on apply/fail.
  Mark missed in Phase 4 PR 4.D3 close-out — corrected here in PR 5.D3.

### 12. Tiered uninstall + data-preserve + reinstall restore
- **Status:** Done — Phase 5 PR 5.5 (#62).
- **Resolution:** Uninstall side shipped in Phase 1 PR 1.24 (default-
  preserve sets `apps.status='uninstalled'`; optional total-delete
  flag wipes blob/db/secrets). Reinstall side shipped in Phase 5 PR 5.5:
  `AppService.getOrphan(slug, channel)` finds the most-recent
  uninstalled row + reports byte sizes for the install-plan modal's
  "Previous data found" section. Default-on checkbox; on approve the
  installer reuses the orphan's `appId` (preserving slug, blob dir,
  per-app SQLite, and saved secrets) via new `AppService.reviveOrphan`.
  Skipped orphans are flipped to `status='archived'` so they stop
  proposing themselves on future installs. Channel-scoped: a Verified
  orphan does NOT match a Community reinstall (cross-channel restore
  would silently elevate trust grants). Rollback handles revival via
  a 5-min `created_at` buffer — a revive-then-fail rolls the row
  back to `'uninstalled'` instead of deleting it (preserves user's
  data + secrets so the next reinstall attempt can offer to restore
  again).

### 13. Catalog CI error-handling polish
- **Status:** Deferred *(verify first)*
- **Source:** spec §4.2; implicit in phase-0-plan.md
- **Gap:** Phase 0 CI workflows assume happy paths. Tag-resolution failures, image-validation failures, and lockfile-presence failures may not produce actionable error messages for manifest authors.
- **Why:** Happy path works; error UX is incremental.
- **Trigger:** First curator-PR that fails CI and the author can't tell why.

### 32. Catalog freshness — no user-driven "Sync Now"
- **Status:** Done — Phase 5 PR 5.6 (#60).
- **Resolution:** Two complementary fixes shipped:
  (a) **Sync Now button** in Settings → App Store, between the channel
  toggles and the idle-reaper section. Calls `appStore.syncChannelNow`
  for every enabled remote channel (Verified + Community); developer-
  import is skipped (no remote catalog). Per-channel result reported
  inline as `+added / updated / -removed`.
  (b) **Per-install lazy refresh** in `AppCatalogService.get` —
  new `{ refreshIfOlderThan: ms }` option, wired with a 5-minute
  threshold at two call sites: `app-store:render-plan` IPC (when the
  user opens the install plan modal) and `_runApprove` start (defense-
  in-depth before clone). Network failure / 404 falls back to the
  cached row so installs still proceed.
  **Plan deviation:** plan §1 sketched the Sync Now button living in a
  "catalog browser modal next to channel filter pills." Reality: there
  is no in-OS8 catalog browser modal — catalog browsing happens on
  os8.ai (web), users return to OS8 via `os8://install` deeplinks.
  The button instead lives in the App Store settings panel which
  already has the channel enable toggles (the conceptually-adjacent
  surface).

### 36. Auto-update widening to Community channel
- **Status:** Deferred *(considered for Phase 5 as PR 5.7, 2026-05-03; cut to give PR 5.4 soak time)*
- **Source:** Phase 5 plan §1 + PR 5.7 stub. Distinct from #11 (Verified-channel auto-update; Done — Phase 4 PR 4.2 #48).
- **Gap:** `AppAutoUpdater.processAutoUpdates` filters on `channel = 'verified'` (`src/services/app-auto-updater.js:55`). Community-channel apps with `auto_update=1` are silently ignored.
- **Why:** Phase 5 originally scoped this as PR 5.7 (filter widening + per-channel Settings toggle, default OFF). Cut at planning to give PR 5.4's manual-edit conflict UI soak time on the lower-churn Verified channel first. Community apps churn more; surprise-update + conflict failures would erode trust faster than on Verified.
- **Trigger:** PR 5.4 has now shipped (Phase 5, #63, 2026-05-04). Promote when ≥1 release of soak time has passed without recurring "merge conflict UX is broken" reports. Implementation cost estimated ~150 LOC (filter widening, per-channel settings toggle, flyout hint logic). Default OFF (symmetric with Verified, aligns with "scan surfaces, user decides" memory).

---

## Catalog & moderation

### 14. Curator pool tiering
- **Status:** Deferred
- **Source:** phase-3-plan.md §2.2
- **Gap:** Single CODEOWNERS team for `os8ai/os8-catalog-community`. No triage tier (e.g. tier-1 fast-path vs escalation).
- **Why:** Unknown PR volume; no triage data yet.
- **Trigger:** Community-channel PR backlog grows past curator bandwidth.

### 15. App revocation flow
- **Status:** Deferred *(considered for Phase 5, 2026-05-03; explicitly deferred per Leo)*
- **Source:** spec §4.3 (implicit)
- **Gap:** Soft-delete (`App.deletedAt`) works server-side, but no user-facing notification or force-uninstall when curator yanks an app. Malicious/compromised apps remain installed silently.
- **Why:** Preventive review is v1 priority; reactive revocation deferred until needed.
- **Trigger:** First app revoked from a catalog. Should be in place before that happens, ideally.
- **Phase 5 note (2026-05-03):** Considered for Phase 5 (Leo asked the question explicitly during planning) and deferred — no real revocation event has occurred + no curator has flagged a candidate. Promote when (a) curators identify a revocation candidate, OR (b) Phase 4 telemetry surfaces a previously-curated app raising new red flags. The cost of waiting is asymmetric: we can ship fast when needed, and designing reactively against a real incident produces better UX than designing speculatively.

### 33. v2 schema `$schema` declaration drift across consumers
- **Status:** Deferred *(small cleanup, ship anytime)*
- **Source:** Phase 3.5.5 — linkding sync to os8.ai's storefront DB failed with `schema_invalid: no schema with key or ref "http://json-schema.org/draft-07/schema#"`. Patched in os8dotai PR #14 by aligning the local copy's `$schema` to draft 2020-12. Canonical (`os8ai/os8-catalog/schema/appspec-v2.json`), community (`os8ai/os8-catalog-community/schema/appspec-v2.json`), and desktop (`os8ai/os8/src/data/appspec-v2.json`) still declare draft-07.
- **Gap:** v1 schema declares `https://json-schema.org/draft/2020-12/schema`; v2 declares `http://json-schema.org/draft-07/schema#`. The desktop and the catalog CIs use plain `Ajv` (default = draft-07) so the mismatch is invisible to them; os8dotai uses `Ajv` from `ajv/dist/2020` and tripped on it. The v2 schema doesn't actually use any draft-07-only constructs.
- **Why:** Three repos to update + schema-match CI to satisfy. Worked-around in os8dotai; no other consumer hits it today.
- **Trigger:** Any new consumer compiling v2 with a strict-draft AJV; or any time the v2 schema needs editing for an unrelated reason (bundle the alignment with that PR).

### 34. ISR fallback 500s for slugs not in `generateStaticParams`
- **Status:** Done — Phase 5 PR 5.9 (os8dotai #18).
- **Resolution:** `syncCatalog` calls `fireVercelDeployHook({ added,
  channel })` right before returning, **only when `added > 0`**.
  Updates and removes don't trigger it because `revalidatePath`
  (already in place) handles those — only NEW slugs need a build to
  regenerate `generateStaticParams()`. Helper is best-effort: 10s
  timeout via AbortSignal, no-op when `VERCEL_DEPLOY_HOOK_URL` env
  is unset, never throws on failure (5xx / network reject logs warn).
  The pre-render-everything fallback in `apps/[slug]/page.tsx`
  stays in tree as defense-in-depth — covers the brief ~1-3min
  window between sync and rebuild completing.
  **Operational follow-up (Leo):** create a Vercel deploy hook in
  project settings → Git → Deploy Hooks (target `main`), set the URL
  as `VERCEL_DEPLOY_HOOK_URL` in Production env vars. Until that's
  set the hook is a strict no-op (returns
  `{ ok: false, reason: "not set" }`).
  **Adjacent fix during the same merge wave:** os8dotai hotfix #19
  added `prisma generate` to the `vercel-build` script — six builds
  failed in a row before that landed because the cached client didn't
  have the InstalledApp model from PR 4.3.

### 16. Install-count display on community cards
- **Status:** Deferred
- **Source:** phase-3-plan.md §2.2
- **Gap:** `App.installCount` increments via `track-install` but the community channel browse UI doesn't surface it. Users can't tell which community apps are tested vs untested.
- **Why:** UX polish.
- **Trigger:** Promote whenever community channel gets meaningful curation traffic.

---

## Telemetry & observability

### 17. GitHub raw rate-limit monitoring (RUM)
- **Status:** Deferred
- **Source:** spec §8.4; app-store-plan.md
- **Gap:** Asset URLs are GitHub raw, pinned to commit SHA. Spec calls for monitoring 429s; no monitoring is wired.
- **Why:** Migration to Vercel Blob (#27) is one-line URL rewrite when needed; cheap to defer until signal arrives.
- **Trigger:** Any 429 in browser DevTools, or a rate-limit-reduction email from GitHub org owner.

### 18. Per-adapter install success/fail telemetry
- **Status:** Done — Phase 4 PR 4.5 (os8dotai #15) + PR 4.4 (#49).
- **Resolution:** Opt-in (default OFF; first-install consent moment),
  allowlist-sanitized, double-hashed clientId. Desktop emits
  install_started/succeeded/failed/cancelled/overridden +
  update_succeeded/update_failed. Server stores raw events 30d, daily
  rollup kept indefinitely. Curator dashboard at
  `/internal/telemetry/install` with per-adapter / fingerprint-cluster
  / per-app counter views.

### 19. Slack/webhook alerts for catalog sync failures
- **Status:** Deferred
- **Source:** spec §11
- **Gap:** Catalog sync errors → `console.error` only. No webhook to a curator channel.
- **Why:** Phase 0 keeps the alert pipeline local; v1 add it.
- **Trigger:** First curator surprise — "the manifest was broken for two days and we didn't notice."

---

## Capability surface

### 20. MCP wildcard capability syntax (`mcp.<server>.*`)
- **Status:** Done — Phase 4 PR 4.7 (#46).
- **Resolution:** JSON schema accepts `mcp.<server>.<tool>` and
  `mcp.<server>.*`; rejects `mcp.*.*` / `mcp.*` / `mcp.<server>.*.<tool>`.
  Runtime checker narrowed to MCP-only wildcards. Modal renders
  wildcard grants with explicit "all current and future tools" copy.
  LLM review prompt updated to flag wildcard scope vs manifest's
  stated purpose.

---

## Runtime adapters & framework support

### 21. Dockerfile-only Developer Imports
- **Status:** Deferred
- **Source:** phase-3-plan.md §3.1; phase-3-plan.md §7
- **Gap:** Developer Import detects `Dockerfile` and points user at Community channel. Building locally with `docker build` requires orchestration + manual `internal_port` discovery.
- **Why:** Adds substantial complexity; users can publish to Docker Hub and use Community channel.
- **Trigger:** Frequent user requests, or when build-from-source is required for a class of apps we want to support.

### 22. GPU device pinning (`--gpus device=N`)
- **Status:** Deferred
- **Source:** phase-2-plan.md §2.5
- **Gap:** Docker adapter passes `--gpus all`. No way to pin a specific device.
- **Why:** Rare use case for v1.
- **Trigger:** First multi-GPU host where users want to run distinct apps on distinct GPUs.

### 23. Sparse checkout for large repos
- **Status:** Deferred
- **Source:** spec §9
- **Gap:** Full clone only. Monorepo installs are slow.
- **Why:** Performance optimization; v1 catalog has no monorepos.
- **Trigger:** First catalog manifest pointing at a path within a known monorepo.

### 35. Docker adapter: container-internal volumes not bind-mounted
- **Status:** Done — Phase 5 PR 5.8 (#64 + os8-catalog #14 + os8-catalog-community #11).
- **Resolution:** Three-repo cross-coordination shipped together.
  **Schema** (`runtime.volumes`) added to `appspec-v2.json` in all
  three places (os8 + both catalog repos): array of
  `{ container_path: string, persist?: boolean }`, max 10, regex
  `^/[a-zA-Z0-9_/-]+$` rejects `..` + non-absolute paths,
  validator invariant rejects duplicate `container_path`.
  **Docker adapter** reads the field; for each entry it mkdir's
  `${BLOB_DIR}/<id>/_volumes/<basename>/` on the host and passes
  `--mount type=bind,source=...,target=<container_path>` to
  `docker run`. Persistent across container recreate, OS8 restart,
  and (with PR 5.5's restore flow) uninstall→reinstall.
  **First-boot migration toast** (new service
  `DockerVolumeMigration.scan/acknowledge`): scans installed docker
  apps with declared volumes whose host-side `_volumes/<basename>/`
  is missing or empty + not yet acknowledged, broadcasts to the
  renderer, toast surfaces with an "Acknowledge" action button.
  Suppression key per-app:
  `app_store.docker_volume_migration_acknowledged.<appId>`.
  **Helper script** `tools/migrate-docker-volume.sh <slug>` runs
  `docker exec tar | tar -xf` to copy the in-container data out into
  the host bind-mount path while the container is still running, then
  marks the migration acknowledged. Idempotent. Requires sqlite3 +
  docker on the host.
  **First fixture:** linkding's `/etc/linkding/data` declared in
  `os8ai/os8-catalog-community/apps/linkding/manifest.yaml` (G5
  smoke target — bookmarks persist across container recreate).
  User-facing reference: `docs/runtime-volumes.md` (PR 5.D2 #65).

---

## UX & polish

### 24. `description` column on per-app environment variables
- **Status:** Deferred *(verify first)*
- **Source:** phase-1-plan.md §6.3.1
- **Gap:** Schema field for per-var help text exists in spec but may not be in DB. Env prompts use `permissions.secrets[].prompt` from manifest as the visible copy.
- **Why:** Minor schema gap.
- **Trigger:** When env-prompt UX gets a polish pass.

### 25. Developer Import dupe-install UX guard
- **Status:** Deferred
- **Source:** phase-3-plan.md §3.1
- **Gap:** User can re-import the same repo many times. `ON CONFLICT` blocks DB dupes but UX doesn't tell user "you already have this; uninstall first?".
- **Why:** Rare abuse/footgun.
- **Trigger:** First user complaint, or any time the dev-import flow gets a UX pass.

### 26. `shell: true` escape hatch
- **Status:** V1 exclusion *(but documented as a potential future field)*
- **Source:** spec §3.3
- **Gap:** Schema rejects the field entirely; spec mentions it as a possible curator-only override for Verified channel.
- **Why:** Not needed for v1 catalogs; safer to keep rejected.
- **Trigger:** A real manifest that genuinely needs shell semantics and can pass curator review.

### 27. Vercel Blob CDN migration
- **Status:** Deferred *(contingent)*
- **Source:** spec §8.4
- **Gap:** Asset URLs are GitHub raw. Migration is a one-line URL rewrite in the sync core; no DB migration.
- **Why:** Wait-and-see; only swap when GitHub raw fails us.
- **Trigger:** See #17 (RUM monitoring). Pull together.

### 28. `assetRequestCount` instrumentation
- **Status:** Deferred *(low priority)*
- **Source:** spec §5.3
- **Gap:** Per-deployment catalog-sync request counter on `CatalogState`.
- **Why:** No urgent observability need.
- **Trigger:** Whenever we want sync-load instrumentation.

### 29. Hard-cleanup cron for soft-deleted apps
- **Status:** Deferred *(low priority)*
- **Source:** app-store-plan.md
- **Gap:** Soft-deleted catalog rows accumulate. Cron is a one-line addition.
- **Why:** Catalog table small; no urgency.
- **Trigger:** Catalog row count growth makes the table noticeable in queries.

### 30. `tags[]` field on apps
- **Status:** Deferred
- **Source:** spec §5
- **Gap:** Spec defers tag-based search until catalog grows past ~100 apps. Currently `category` + full-text on `description` (minisearch client-side).
- **Why:** Catalog is small; minisearch is enough.
- **Trigger:** Catalog grows past ~100 apps OR search-relevance complaints.

### 31. Doc PR for update flow with three-way merge
- **Status:** Deferred
- **Source:** phase-2-plan.md PR 2.5 note
- **Gap:** phase-1-plan.md missing a cross-reference section explaining how update + user edits interact.
- **Why:** Minor doc clarity.
- **Trigger:** Whenever #10 lands (update them together).

---

## V1 exclusions (intentionally out of scope — kept here so we don't forget the *why*)

### E1. Path-mode app routing
- **Status:** V1 exclusion
- **Source:** spec §1, §6.2.3, §7 Q3; app-store-plan.md decision log entry 11
- **Decision:** Subdomain mode (`<slug>.localhost:8888`) is the v1 default and only mode. Path mode rejected because (a) it shares one browser origin across all installed apps — architectural trust leak — and (b) it taxes manifest authors with per-framework base-path config.
- **Reconsider only if:** Hosts files / DNS / AV blocks subdomains for a meaningful population of users, AND we find a way to isolate trust without subdomain.

### E2. `surface: terminal` (TUI apps via xterm.js + node-pty)
- **Status:** V1 exclusion
- **Source:** spec §2.2, §9
- **Decision:** v1 implements `surface: web` only. Terminal surface is v2.
- **Reconsider only if:** Strong signal of TUI app demand and a clean way to wire pty isolation.

### E3. `surface: desktop-stream` (native GUI apps via noVNC)
- **Status:** V1 exclusion
- **Source:** spec §2.2, §9
- **Decision:** v1 web-only. Native GUI surface is v2.
- **Reconsider only if:** Significant native-GUI app interest and an acceptable encoding-overhead story.

### E4. Non-pinned manifest refs (branch names / `latest` tag)
- **Status:** V1 invariant *(not really a deferral)*
- **Source:** spec §9
- **Decision:** Every manifest pins a SHA via tag resolution. Floating refs rejected to preserve immutability and reproducibility.
- **Reconsider only if:** Some specific class of apps fundamentally cannot pin (none known).

### E5. Cross-device app-store browsing (wishlist / sync)
- **Status:** V1 exclusion *(implicit)*
- **Source:** never specced
- **Decision:** Browsing on os8.ai and installing on desktop are intentionally decoupled. No wishlist, no cross-device recommendations.
- **Reconsider only if:** Multi-device user accounts become a meaningful feature elsewhere in OS8.

---

## Decisions log (items moved off this list)

When something here gets either built or definitively dropped, move it down here with a one-line note + the PR or decision that closed it. Keeps the active list above clean while preserving history.

### Phase 4 (closed 2026-05-03)

- **#6 Stricter `X-OS8-App-Context`** → built in PR 4.6 (`os8ai/os8#53`).
  Strict origin allowlist + in-process token + permissive escape hatch.
- **#8 Streaming install logs** → built in PR 4.1 (`os8ai/os8#45`).
  Buffered SSE relay, color-coded rows, Download Logs.
- **#9 Playwright E2E install harness** → scaffolded in PR 4.10
  (`os8ai/os8#47`). Install-flow + dev-import specs scaffolded with
  `.skip()` for follow-up.
- **#18 Per-adapter install telemetry** → built in PR 4.5
  (`os8ai/os8dotai#15`) + PR 4.4 (`os8ai/os8#49`). Opt-in default OFF,
  allowlist-sanitized, double-hashed clientId, curator dashboard.
- **#20 MCP wildcard capability** → built in PR 4.7 (`os8ai/os8#46`).
  `mcp.<server>.*` accepted; `mcp.*.*` / `mcp.*` rejected.

The above items remain on the active list above with `Status: Done`
pointers; this section is the chronological close-out index.
