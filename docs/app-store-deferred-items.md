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
- **Status:** Deferred
- **Source:** phase-1-plan.md §10 Q1; spec §6.3.2
- **Gap:** Middleware ships in permissive mode (header optional). Spec implies `401/403` on missing header.
- **Why:** Wanted baseline stability before tightening; flip is one constant change.
- **Trigger:** No new external apps for ~2 weeks of stable operation, then flip and watch for regressions.
- **Note:** This is an internal trust-boundary header, not a user-facing capability gate — flipping it strict does **not** conflict with advisory gating.

### 7. Keychain encryption for app secrets
- **Status:** Deferred *(low priority)*
- **Source:** spec §6.11
- **Gap:** App secrets stored plaintext in `app_env_variables`. No OS keychain integration.
- **Why:** Matches existing `EnvService` plaintext model for native apps; not worth special-casing apps unless OS8 itself moves to keychain.
- **Trigger:** OS8 adopts keychain for its own secrets, then App Store follows.

---

## Install / Update / Uninstall lifecycle

### 8. Streaming install logs in modal
- **Status:** Deferred
- **Source:** phase-3-plan.md §7.5
- **Gap:** Install modal shows "Installing…" with no detail through 30-min Streamlit/ML cold installs or multi-GB Docker pulls. User can't tell if the process is hung.
- **Why:** UX polish; core flow works without it.
- **Trigger:** Highest user-visible win in this list. Promote into Phase 4 unless something more pressing displaces it.

### 9. Playwright E2E install harness
- **Status:** Deferred
- **Source:** phase-3-plan.md §7.6
- **Gap:** Every adapter validated via manual smoke checklist (the Phase 3.5 pattern). No automated end-to-end regression catch.
- **Why:** Phase 3.5 validates all adapters manually first; automation comes after the pattern is proven.
- **Trigger:** After Phase 3.5 completes for all four adapters and the codified pattern is stable.

### 10. Three-way merge UI for updates with user edits
- **Status:** Deferred *(verify first — Phase 1 squash may have included partial work)*
- **Source:** spec §6.9; phase-1-plan.md §6.9 / PR 1.25
- **Gap:** Spec sketches `git status`-style merge surface in the source sidebar when user edits and upstream both change. Wiring into the dev-mode panel is incomplete.
- **Why:** Lower-priority lifecycle path; users rarely edit installed apps and rarely upgrade those they edit.
- **Trigger:** First user report of "I edited my app and now I can't update it."

### 11. Auto-update opt-in for Verified channel
- **Status:** Deferred *(verify first; depends on #10)*
- **Source:** spec §6.9; phase-1-plan.md §6.9
- **Gap:** Auto-update toggle (default OFF) for Verified-channel apps when no user edits exist. Currently every update is manual.
- **Why:** Depends on update flow with merge handling (#10) being solid.
- **Trigger:** Once #10 lands.

### 12. Tiered uninstall + data-preserve + reinstall restore
- **Status:** Deferred *(verify first — Phase 1 squash may have included this)*
- **Source:** spec §6.10; phase-1-plan.md PR 1.24
- **Gap:** Spec describes default-preserve uninstall, optional total-delete, and a reinstall path that detects orphan data and offers restore. Not all wired.
- **Why:** Lower-priority; users uninstall rarely.
- **Trigger:** First user data-loss complaint. Worth verifying before Phase 4 since support cost of "I uninstalled and lost my work" is high.

### 13. Catalog CI error-handling polish
- **Status:** Deferred *(verify first)*
- **Source:** spec §4.2; implicit in phase-0-plan.md
- **Gap:** Phase 0 CI workflows assume happy paths. Tag-resolution failures, image-validation failures, and lockfile-presence failures may not produce actionable error messages for manifest authors.
- **Why:** Happy path works; error UX is incremental.
- **Trigger:** First curator-PR that fails CI and the author can't tell why.

### 32. Catalog freshness — no user-driven "Sync Now"
- **Status:** Deferred
- **Source:** Phase 3.5.5 — linkding manifest update (`os8ai/os8-catalog-community#9` adding `LD_SUPERUSER_*` secrets) was invisible to a freshly-restarted desktop because the local `app_catalog` table only refreshes daily at 4am local OR on community-channel toggle in Settings. Restarting OS8 doesn't trigger a sync; `AppCatalogService.get()` returns the cached `manifest_yaml` without re-checking `manifest_sha` upstream.
- **Gap:** Newly-updated catalog manifests can be invisible to a desktop user for up to 24h with no obvious recovery path. The cache-invalidation logic from PR #41 only fires from a sync, not from a per-install fetch. There's no UI button to force a sync.
- **Why:** Daily cadence was sufficient before realistic-fixture iteration. Surfaced sharply only when authoring + iterating manifests in real time.
- **Trigger:** Recurring user reports of "I just installed and the install plan looks stale", OR before opening the catalog to a wider author pool. Cheap fix candidates: (a) add a "Sync now" button to the catalog browser that calls the existing `app-store:sync-channel-now` IPC, (b) sync the relevant channel when the user clicks an install button, (c) compare `manifest_sha` against upstream in `get()` when the local row is older than N minutes.

---

## Catalog & moderation

### 14. Curator pool tiering
- **Status:** Deferred
- **Source:** phase-3-plan.md §2.2
- **Gap:** Single CODEOWNERS team for `os8ai/os8-catalog-community`. No triage tier (e.g. tier-1 fast-path vs escalation).
- **Why:** Unknown PR volume; no triage data yet.
- **Trigger:** Community-channel PR backlog grows past curator bandwidth.

### 15. App revocation flow
- **Status:** Deferred
- **Source:** spec §4.3 (implicit)
- **Gap:** Soft-delete (`App.deletedAt`) works server-side, but no user-facing notification or force-uninstall when curator yanks an app. Malicious/compromised apps remain installed silently.
- **Why:** Preventive review is v1 priority; reactive revocation deferred until needed.
- **Trigger:** First app revoked from a catalog. Should be in place before that happens, ideally.

### 33. v2 schema `$schema` declaration drift across consumers
- **Status:** Deferred *(small cleanup, ship anytime)*
- **Source:** Phase 3.5.5 — linkding sync to os8.ai's storefront DB failed with `schema_invalid: no schema with key or ref "http://json-schema.org/draft-07/schema#"`. Patched in os8dotai PR #14 by aligning the local copy's `$schema` to draft 2020-12. Canonical (`os8ai/os8-catalog/schema/appspec-v2.json`), community (`os8ai/os8-catalog-community/schema/appspec-v2.json`), and desktop (`os8ai/os8/src/data/appspec-v2.json`) still declare draft-07.
- **Gap:** v1 schema declares `https://json-schema.org/draft/2020-12/schema`; v2 declares `http://json-schema.org/draft-07/schema#`. The desktop and the catalog CIs use plain `Ajv` (default = draft-07) so the mismatch is invisible to them; os8dotai uses `Ajv` from `ajv/dist/2020` and tripped on it. The v2 schema doesn't actually use any draft-07-only constructs.
- **Why:** Three repos to update + schema-match CI to satisfy. Worked-around in os8dotai; no other consumer hits it today.
- **Trigger:** Any new consumer compiling v2 with a strict-draft AJV; or any time the v2 schema needs editing for an unrelated reason (bundle the alignment with that PR).

### 34. ISR fallback 500s for slugs not in `generateStaticParams`
- **Status:** Deferred *(documented upstream limitation)*
- **Source:** Phase 3.5.5 — linkding's `/apps/linkding` returned 500 for ~30 minutes after sync completed, until an empty commit forced a Vercel rebuild. Existing comment in `os8dotai/src/app/apps/[slug]/page.tsx:13-22` describes the bug: Next.js's ISR fallback for slugs absent from `generateStaticParams`'s build-time output crashes upstream of user code on Vercel. The current mitigation pre-renders every known slug at build time.
- **Gap:** Newly-synced apps remain 500 on `os8.ai/apps/<slug>` until a Vercel redeploy regenerates the static-params list. No automatic redeploy is wired; we pushed an empty commit by hand.
- **Why:** Root cause is upstream (Next.js or Vercel runtime). Workaround is in place; the pain point is the manual nudge.
- **Trigger:** Catalog churn that makes the manual nudge annoying, OR Vercel ships a fix and we can drop the pre-render-everything workaround. Cheap candidates: (a) trigger a Vercel deploy hook from the catalog-sync route after a successful add, (b) catch the not-found case in the page handler and render a "syncing, refresh in a moment" placeholder + ISR-revalidate.

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
- **Status:** Deferred
- **Source:** spec §9
- **Gap:** No event emission to know which runtime is breaking installs in the wild. Bug fixes prioritized by anecdote.
- **Why:** Core flow works without it.
- **Trigger:** Any time we want data-driven adapter prioritization. Cheap to add.

### 19. Slack/webhook alerts for catalog sync failures
- **Status:** Deferred
- **Source:** spec §11
- **Gap:** Catalog sync errors → `console.error` only. No webhook to a curator channel.
- **Why:** Phase 0 keeps the alert pipeline local; v1 add it.
- **Trigger:** First curator surprise — "the manifest was broken for two days and we didn't notice."

---

## Capability surface

### 20. MCP wildcard capability syntax (`mcp.<server>.*`)
- **Status:** Deferred
- **Source:** phase-3-plan.md §3.2; spec §7 Q4
- **Gap:** v1 requires `mcp.<server>.<tool>` per individual tool. Wildcard form needs its own UI.
- **Why:** Fixed-list works for current MCP scope.
- **Trigger:** Curator request, or a manifest with >5 MCP tools from one server.

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
- **Status:** Deferred
- **Source:** Phase 3.5.5 — `runtime-adapters/docker.js` bind-mounts `~/os8/apps/<id>` → `/app` and `~/os8/blob/<id>` → `/data` only. Linkding writes its SQLite DB + bookmark archives to `/etc/linkding/data` inside the container; that path is ephemeral. After `docker rm` (uninstall, or any container recreation) the user's bookmarks are gone.
- **Gap:** Manifests have no way to declare additional bind mounts for container-internal paths the app actually persists to. Every docker app silently has this footgun unless its image happens to write only to `/app` or `/data` (rare).
- **Why:** Adds a new manifest field (`runtime.volumes` or similar), schema change across catalogs, adapter wiring. Out of scope for the Phase 3.5.5 adapter validation.
- **Trigger:** First user data-loss complaint, OR before any docker app graduates from community to verified. Likely shape: `runtime.volumes: [{ container_path: "/etc/linkding/data", persist: true }]` → adapter mounts under `~/os8/blob/<id>/<container_path_basename>`.

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

*(empty — populated as items close)*
