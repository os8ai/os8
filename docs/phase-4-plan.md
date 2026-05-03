# OS8 App Store — Phase 4 Implementation Plan

**Companions:** [`app-store-spec.md`](./app-store-spec.md) (Draft v2), [`app-store-plan.md`](./app-store-plan.md) (master plan), [`phase-0-plan.md`](./phase-0-plan.md), [`phase-1-plan.md`](./phase-1-plan.md), [`phase-2-plan.md`](./phase-2-plan.md), [`phase-3-plan.md`](./phase-3-plan.md), [`app-store-deferred-items.md`](./app-store-deferred-items.md).
**Audience:** Engineers implementing PRs 4.1 – 4.11 (plus three doc PRs) across `/home/leo/Claude/os8/`, `/home/leo/Claude/os8dotai/`, `os8ai/os8-catalog`, and `os8ai/os8-catalog-community`.
**This document:** the concrete contract for each Phase 4 PR — files, splice points, signatures, schema additions, API contracts, test fixtures, acceptance criteria, smoke gates, cross-platform notes, and deviations. Reference the spec and prior phase plans for *why*; this file is *how*.

> **Important framing.** The master plan ([`app-store-plan.md`](./app-store-plan.md)) ends at Phase 3. Phases 0–3 plus the in-flight Phase 3.5 cover the v1 surface area: catalog, install pipeline, three runtimes, three trust tiers, supply-chain analyzer, real-app smoke fixtures. **Phase 4 is the first post-v1 phase.** Its scope derives from (a) spec §11 "genuinely open" implementation details and (b) explicit "Phase 4 candidate" callouts in `phase-3-plan.md` §7.5–7.6. Theme: **maturation and observability** — take the App Store from "it works for the users we have" to "it tells us what's happening and gracefully handles updates, scale, and Windows."

---

## 1. Scope, ordering, inheritance

Phase 4 ships **six tracks** that together turn the App Store from a working v1 into an instrumented, self-updating, cross-platform v1.1. Three tracks are independent (B, C, E); two are sequential within themselves (A, D); one is doc-only (F).

| PR | Work unit | Surface | Track | Spec/plan source | Smoke gate |
|---|---|---|---|---|---|
| 4.1 | Streaming install logs in install plan modal | OS8 | A | phase-3-plan §7.5 (Phase 4 candidate) | yes — Streamlit fixture | _Merged in #45._ |
| 4.2 | Auto-update opt-in for Verified channel | OS8 | A | spec §6.9; schema fields exist | yes — worldmonitor bump |
| 4.3 | "Update available" surface on `/apps/[slug]` | os8.ai | A | spec §6.9 (mirrors desktop banner) | — |
| 4.4 | Per-adapter install telemetry emitter | OS8 | B | spec §8 "Future"; spec §11 monitoring | — |
| 4.5 | Telemetry ingest endpoint + minimal dashboard | os8.ai | B | spec §11 monitoring | — | _Merged in os8dotai #15._ |
| 4.6 | `requireAppContext` strict mode flip | OS8 | C | spec §11 open #1 | yes — E2E suite |
| 4.7 | `mcp.<server>.*` wildcard capability | OS8 | C | spec §11 open #4 | — | _Merged in #46._ |
| 4.8 | Windows-2022 promoted to gating CI | OS8 + 2× catalog | D | spec §11 open #11/#12 | yes — Windows install |
| 4.9 | `@os8/sdk-types` TypeScript npm package | OS8 + npm publish | E | spec §11 open #6 | — |
| 4.10 | Playwright-Electron E2E install harness | OS8 | E | phase-3-plan §7.6 (Phase 4 candidate) | yes — gates 4.6 | _Merged in #47._ |
| 4.11 | Migration `0.6.0-app-store-telemetry.js` | OS8 | B | foundation for 4.4 + auto-update prefs | — | _Merged in #44._ |
| 4.D1 | Spec + master-plan close-out updates | docs (`/home/leo/Claude/os8/docs/`) | F | always-separate (see phase-3 §1) | — |
| 4.D2 | `docs/auto-update.md` user reference | docs | F | new — accompanies 4.2 | — |
| 4.D3 | `app-store-deferred-items.md` decisions log update | docs | F | always-separate | — |

### Ordering

Phase 4 has **two hard sequencing constraints** and otherwise allows parallel work.

```
Foundation (must merge first):
  4.11 (migration 0.6.0) ─── no deps; foundation for 4.4 + 4.2

Track A (Lifecycle maturation — sequential within track):
  4.1 (streaming logs)  ── 4.11
  4.2 (auto-update)     ── 4.11, gated behind 4.1's smoke
  4.3 (os8.ai badge)    ── independent of desktop; can ship before, with, or after 4.2

Track B (Observability — sequential):
  4.5 (os8.ai ingest endpoint, accepts zero traffic) ── independent
  4.4 (desktop emitter)                              ── 4.5, 4.11

Track C (Trust-boundary tightening):
  4.7 (MCP wildcards)         ── independent
  4.6 (requireAppContext flip) ── GATED behind 4.10 (E2E harness must pass against
                                  every native React app + every Phase 3.5 fixture)

Track D (Windows expansion — sequential within track):
  4.8 (Windows CI) ── independent of Tracks A/B/C/E

Track E (DevX):
  4.9 (npm package) ── 4.7 (MCP wildcards change SDK surface)
  4.10 (Playwright harness) ── independent; must pass before 4.6 merges

Track F (docs — always separate from code, per phase-3 §1):
  4.D1, 4.D2, 4.D3 — file once each track lands and decisions are settled
```

**Critical path within Phase 4** (longest chain): `4.11 → 4.10 → 4.6`. Roughly 3 PR-merges deep on the gating axis. Tracks A, B, D can run in parallel with the critical path; Track E is the path itself.

### Test matrix

Per spec §11 decision 12: **macOS + Linux were blocking for Phases 1–3; Windows was best-effort.** Phase 4 changes that — PR 4.8 promotes `windows-2022` to gating across all four repos. Concretely:

- Phase 1–3 PRs test on `macos-14`, `ubuntu-22.04`. Phase 4 retains those and adds `windows-2022` after PR 4.8 merges.
- PR 4.10's harness runs on all three OSes (Playwright + Electron supports each).
- PR 4.5's tests run on the os8.ai Vercel preview pipeline (Linux containers, unchanged).
- PRs 4.D1–D3 are doc-only — no CI matrix.

### Inheritance — what Phase 4 does **not** re-spec

Phase 4 PRs are additive on top of Phases 0–3. **Do not re-spec these.** Cite by file path and section.

| Inherited primitive | Phase | File on disk |
|---|---|---|
| `RuntimeAdapter` interface | 1.11 | `src/services/runtime-adapters/{index,node,python,static,docker}.js` |
| `AppInstaller` orchestrator + state machine | 1.5 / 1.16 | `src/services/app-installer.js`, `src/services/app-install-jobs.js` |
| `AppReviewService` 3-phase pipeline | 1.6 | `src/services/app-review.js` |
| `AppCatalogService.sync` (channel-keyed, idempotent, soft-delete) | 1.3 | `src/services/app-catalog.js` |
| `AppCatalogService.update` (fast-forward + three-way merge) | 1.25 | `src/services/app-catalog.js` |
| Manifest validator + `appspec-v1.json` + `appspec-v2.json` | 1.4 / 2.5 | `src/services/manifest-validator.js`, `src/data/appspec-v{1,2}.json` |
| Install plan modal + gate evaluation | 1.17 | `src/renderer/install-plan-modal.js` |
| SSE log relay (`app-store:job-update`) | 1.17 | `src/ipc/app-store.js`, `src/services/app-installer.js` |
| Hardened BrowserView for external apps | 1.19 | `src/services/preview.js` |
| Scoped `_os8/api/*` middleware + capability resolver | 1.7 | `src/services/scoped-api-surface.js` |
| `window.os8` SDK preload | 1.9 | `src/preload-external-app.js` |
| `requireAppContext` middleware (currently permissive) | 1.8 | `src/middleware/require-app-context.js` |
| Channel-tiered `--ignore-scripts` policy | 1.11 | `src/services/runtime-adapters/node.js` |
| Per-channel Settings panel | 3.5 | `src/renderer/settings.js`, `index.html` |
| Catalog daily sync scheduler | 1.3 / 3.5 | `src/server.js` |
| os8.ai `App` / `PendingInstall` / `CatalogState` Prisma models | 0.7 | `prisma/schema.prisma` |
| os8.ai dual-channel sync (verified + community) | 3.4 | `src/lib/catalog-sync.ts` |
| `/apps` browse page + channel filter pill | 0.9 / 3.4 | `src/app/apps/page.tsx`, `AppGrid.tsx` |
| `/apps/[slug]` detail page | 0.10 | `src/app/apps/[slug]/page.tsx` |
| Reverse proxy primitive + WebSocket upgrade handler | 1.13 / 1.14 (Vite gate) / 2.2 (Streamlit gate) | `src/services/reverse-proxy.js` |
| Supply-chain scanner (osv-scanner + safety) | 3.6 | `src/services/supply-chain-scanner.js` |

When PR 4.x text says "extend `AppCatalogService.update`" it means **the same method PR 1.25 ships in `app-catalog.js`** — see phase-1-plan PR 1.25 for context.

---

## 2. Audit findings (Phase 4-relevant)

Verified against the working tree of `/home/leo/Claude/os8/` and `/home/leo/Claude/os8dotai/` at audit time. Phases 0, 1, 2, 3 are fully merged on `main`. Phase 3.5.1 (worldmonitor) and 3.5.2 (CyberChef) are merged in `os8ai/os8-catalog`; 3.5.3–3.5.5 are pending but **out of scope for this plan** per the user-supplied framing. Phase 4 assumes 3.5 will land before any PR depending on a real Streamlit/Gradio/Docker fixture (see PR 4.1 and PR 4.10 acceptance criteria).

| Phase 4 dependency | Code reality at audit | Implication |
|---|---|---|
| `apps.auto_update` and `apps.update_available` and `apps.update_to_commit` columns exist | ✓ — migration `0.5.0-app-store.js` adds all three (`auto_update INTEGER DEFAULT 0`, `update_available INTEGER DEFAULT 0`, `update_to_commit TEXT`). Spec §6.1 lines 498–500. | **PR 4.2 needs no schema migration for the auto-update flag itself** — only for new telemetry tables (PR 4.11) and new settings keys. |
| `AppCatalogService.update` exists with fast-forward + three-way merge | ✓ — PR 1.25 ships the method; conflict UI surfaces in app's source sidebar. | **PR 4.2's job is ONLY to wire the auto-trigger** when `auto_update = 1` AND no user edits. The merge logic itself is untouched. |
| Install plan modal has a `logs` panel scaffold but receives no streamed adapter output | ✓ — `src/renderer/install-plan-modal.js` renders a `<pre>` for logs (PR 1.17); the SSE stream from `app-installer.js` only emits state-machine transitions, not adapter stdout/stderr. The `logs` field of the SSE payload is currently a one-line "Installing..." placeholder. | **PR 4.1 wires adapter `onLog` callbacks into the SSE stream** with a buffered relay (avoid per-line IPC chatter on slow installs). |
| `requireAppContext` middleware is permissive (allows missing header) | ✓ — `src/middleware/require-app-context.js` from PR 1.8 sets `req.callerAppId = appId` if header present, calls `next()` regardless. Comment explicitly cites "v1: native shell calls without the header are allowed." | **PR 4.6 flips the constant to strict** AND adds a runtime allowlist for the OS8 shell + native React apps (origin-based, not header-based). |
| `permissions.os8_capabilities` accepts `mcp.<server>.<tool>` strings | ✓ — `src/services/scoped-api-surface.js`'s `isAllowed(requestedCap, allowed)` does exact-match. JSON Schema in `appspec-v1.json` accepts arbitrary strings under that array. | **PR 4.7 extends `isAllowed` to support `mcp.<server>.*` wildcard**. The JSON Schema gets a `pattern` constraint to reject `mcp.*.*` (which would grant everything) but allow `mcp.<server>.*` (one server). |
| `vercel.json` cron config exists with two channel-staggered entries | ✓ — `os8dotai/vercel.json` from PR 3.4 lists `verified` at `:00,:30` and `community` at `:15,:45`. | **PR 4.5 adds a third path** for telemetry rollups (cheap aggregation; daily). |
| os8.ai `App` model has `installCount` (anonymous) but no `updatedCount` / `failedInstalls` | At audit, `App.installCount Int @default(0)` is the only counter. | **PR 4.5 adds `App.updatedCount`, `App.failedInstallCount`, `App.lastInstallTelemetryAt`** plus a new `InstallEvent` model for queryable per-event records. |
| Existing `track-install` endpoint accepts anonymous POSTs and is rate-limited per IP/day | ✓ — `os8dotai/src/app/api/apps/[slug]/track-install/route.ts` from PR 0.11. | **PR 4.5 mirrors the rate-limiting pattern** for the new `/api/apps/telemetry` endpoint (per IP, per day, batched). |
| Existing `electron-builder` config in `package.json` has `mac` + `linux` targets only | ✓ — no `win` config block at audit. PR 1.2 documented Windows protocol-handler integration as future work. | **PR 4.8 adds the `win` target** with NSIS installer + protocol handler entries; CI matrix gains `windows-2022`. |
| Existing `tests/` are vitest-based; no Playwright/Spectron in deps | ✓ — `package.json` lacks any browser-driver dep. The closest precedent is `tests/e2e/vite-hmr-smoke.test.js` from PR 1.14 which uses a headless Chromium via `puppeteer` for a non-Electron test. | **PR 4.10 introduces `@playwright/test` + `electron-playwright-helpers`** as devDependencies; harness lives at `tests/e2e/` next to the existing smoke test. |
| `preload-external-app.js` exposes the `window.os8` SDK as a single object created from a fixed shape | ✓ — `src/preload-external-app.js` from PR 1.9. The shape is JS literals at preload time; no TS. The auto-generated CLAUDE.md per PR 1.21 includes a `os8-sdk.d.ts` file generated from the shape. | **PR 4.9 promotes the `.d.ts` to a published npm package** so external app authors get IDE autocomplete via `npm install -D @os8/sdk-types` instead of having to copy the file from CLAUDE.md. |
| GitHub raw asset rate-limit monitoring | Not wired (deferred item #17). Catalog assets are still served from raw.githubusercontent.com. | **Not in Phase 4** — but PR 4.4 (telemetry) gives us the first telemetry stream. If Phase 4 ships and we observe 429s, deferred item #17 promotes to Phase 5. |

**Net assessment.** Phase 4 is the highest-coordination phase of the four because half the work is cross-repo. Most of the desktop work is wiring (logs through SSE, auto-trigger via existing update method, telemetry emit + ingest), with two exceptions:

- **PR 4.6 (`requireAppContext` strict)** is genuinely risky — flipping a middleware default in a system with multiple consumers is exactly the class of change that surfaces hidden coupling. The E2E harness (PR 4.10) is the primary mitigation; the rollback plan is a single-line constant flip.
- **PR 4.10 (Playwright harness)** is the most lines of new test infrastructure since PR 1.14, and it must work on three OSes. Playwright-Electron is well-supported but the surface area is real.

The remaining PRs (4.1, 4.2, 4.3, 4.4, 4.5, 4.7, 4.8, 4.9, 4.11) are each ≤300 LOC of focused work against well-defined seams.

---

## 3. Cross-PR dependencies

```
Phase 0–3 chain (must complete first; Phase 4 inherits):
  0.7   App / PendingInstall / CatalogState Prisma models
  0.11  track-install endpoint + rate-limit pattern
  1.3   AppCatalogService.sync
  1.8   requireAppContext middleware (permissive)
  1.9   window.os8 SDK preload
  1.11  Node runtime adapter onLog callback
  1.16  AppInstaller install pipeline
  1.17  Install plan modal SSE log relay
  1.21  CLAUDE.md generator + os8-sdk.d.ts
  1.25  AppCatalogService.update (fast-forward + 3-way merge)
  3.4   dual-channel sync (verified + community)
  3.5   per-channel Settings panel
  3.6   supply-chain scanner

Phase 4:
  Foundation (must merge first; no deps):
    4.11 (migration 0.6.0-app-store-telemetry.js)

  Track A (Lifecycle maturation):
    4.1 (streaming logs)  ── 4.11
    4.2 (auto-update)     ── 4.1's smoke gate; 4.11 (settings keys)
    4.3 (os8.ai badge)    ── independent

  Track B (Observability):
    4.5 (os8.ai ingest)   ── 0.7 Prisma; independent of desktop
    4.4 (desktop emitter) ── 4.5, 4.11

  Track C (Trust boundary):
    4.7 (MCP wildcards)   ── 1.7 capability resolver
    4.6 (strict flip)     ── 4.10 (gated)

  Track D (Windows):
    4.8 (Windows CI)      ── independent

  Track E (DevX):
    4.9 (npm package)     ── 4.7 (SDK shape changes)
    4.10 (Playwright)     ── 1.14, 2.2 (test infra precedents); GATES 4.6

  Track F (docs):
    4.D1 — files after Tracks A, B, C, E close
    4.D2 — files alongside 4.2
    4.D3 — files when each track's items close
```

**Critical path within Phase 4** (longest chain): `4.11 → 4.10 → 4.6`. Tracks A, B, D, E run in parallel with the critical path.

---

## PR 4.1 — Streaming install logs in modal

**Goal.** During a long install (Streamlit ML deps, Gradio model downloads, Docker layer pulls — minutes to tens of minutes), the install plan modal currently shows "Installing…" with no detail. Users can't tell if the process is hung or making progress. Phase 3.5 surfaced this concretely: the worldmonitor smoke (PR 3.5.1) was 5–10 seconds; the upcoming Streamlit smoke (PR 3.5.3) is 5–30 minutes on first install. Stream the runtime adapter's stdout + stderr line-by-line to the modal's existing log panel.

This PR is the spec's "Future" candidate for "telemetry on install success/fail" (§8) inverted: we don't telemeter the user yet (that's PR 4.4), we **show the user what's happening**.

### Files

- **Modify:** `/home/leo/Claude/os8/src/services/app-installer.js` — extend `_run` to pass an `onLog` callback to runtime adapters' `install` and `start` methods; relay logged lines via SSE
- **Modify:** `/home/leo/Claude/os8/src/services/runtime-adapters/{node,python,static,docker}.js` — accept and invoke `onLog(streamName, line)` from the spawn `stdout` + `stderr` event listeners (the adapter callbacks already exist per PR 1.11; this PR ensures every adapter wires them consistently)
- **Modify:** `/home/leo/Claude/os8/src/ipc/app-store.js` — extend the `app-store:job-update` event payload with a `logs` field (array of `{ stream, line, ts }`) and a `logsAppend` boolean (so the renderer knows to append vs replace)
- **Modify:** `/home/leo/Claude/os8/src/renderer/install-plan-modal.js` — extend `renderLogs(state)` to render scrollable, color-coded log lines (stderr in muted red); auto-scroll to bottom unless user has scrolled up
- **Modify:** `/home/leo/Claude/os8/styles/components.css` — add `.install-plan-modal__log-line--stdout` and `.install-plan-modal__log-line--stderr` styles

### Adapter `onLog` contract

Every runtime adapter's `install(spec, appDir, sanitizedEnv, onLog)` and `start(spec, appDir, sanitizedEnv, onLog)` already accept `onLog` per PR 1.11's `RuntimeAdapter` interface. Audit at write time:

- `node.js` — calls `onLog(line)` on every stdout/stderr line. **Rename to `onLog('stdout', line)` / `onLog('stderr', line)`** for the modal's color coding.
- `python.js` — same (PR 2.1).
- `static.js` — never calls `onLog` because there's no install or start phase that produces output. Emit `onLog('info', 'static adapter: copying build output to <dir>')` once per phase so the modal isn't empty.
- `docker.js` — `docker pull` produces newline-delimited JSON when called with `--quiet=false`; parse to `{ status: "Downloading", progressDetail: { current, total } }` lines and emit human-readable progress (see "Docker pull progress" below).

### Buffered SSE relay

A naive per-line relay floods the IPC channel during `npm install` (which can produce thousands of lines per second on a fast disk). Buffer at the installer:

```js
// /home/leo/Claude/os8/src/services/app-installer.js — addition near _run
const LOG_BUFFER_INTERVAL_MS = 200;   // human-perceptible cadence; lossless

function makeLogBuffer(emit) {
  let pending = [];
  let timer = null;
  const flush = () => {
    if (pending.length === 0) return;
    emit({ logs: pending, logsAppend: true });
    pending = [];
  };
  return {
    push(stream, line) {
      pending.push({ stream, line: line.slice(0, 2000), ts: Date.now() });
      if (!timer) timer = setTimeout(() => { flush(); timer = null; }, LOG_BUFFER_INTERVAL_MS);
    },
    flushNow() { if (timer) { clearTimeout(timer); timer = null; } flush(); },
  };
}

// In _run:
const logBuffer = makeLogBuffer((payload) => emitProgress(jobId, payload));
const onLog = (stream, line) => logBuffer.push(stream, line);
try {
  await adapter.install(spec, stagingDir, sanitizedEnv, onLog);
  // ... start phase ...
} finally {
  logBuffer.flushNow();
}
```

The line limit (2KB) prevents a single multi-MB output line (e.g. `npm install`'s tarball-scan summary) from bloating the SSE frame.

### Renderer rendering

```js
// /home/leo/Claude/os8/src/renderer/install-plan-modal.js — renderLogs replacement
function renderLogs(state) {
  const lines = state.logs || [];   // append-only buffer in modal state
  if (lines.length === 0) {
    return `<div class="install-plan-modal__logs install-plan-modal__logs--empty">
      <em>No output yet — runtime adapter starting up.</em>
    </div>`;
  }
  return `
    <div class="install-plan-modal__logs" data-auto-scroll="${state.logsAutoScroll ? 'true' : 'false'}">
      ${lines.slice(-LOG_LINES_RENDERED_MAX).map(l => `
        <div class="install-plan-modal__log-line install-plan-modal__log-line--${escapeAttr(l.stream)}">
          <span class="install-plan-modal__log-ts">${formatLogTs(l.ts)}</span>
          <span class="install-plan-modal__log-text">${escapeHtml(l.line)}</span>
        </div>
      `).join('')}
    </div>
  `;
}

const LOG_LINES_RENDERED_MAX = 500;   // older lines remain in state.logs for download
```

### Auto-scroll behavior

```js
// In wireEvents:
const logsEl = root.querySelector('.install-plan-modal__logs');
if (logsEl) {
  logsEl.addEventListener('scroll', () => {
    const atBottom = (logsEl.scrollHeight - logsEl.scrollTop - logsEl.clientHeight) < 16;
    state.logsAutoScroll = atBottom;
  });
}
// After every render, if state.logsAutoScroll is true, scroll to bottom:
function maybeAutoScrollLogs(root, state) {
  if (!state.logsAutoScroll) return;
  const el = root.querySelector('.install-plan-modal__logs');
  if (el) el.scrollTop = el.scrollHeight;
}
```

### Download-logs button

After install (success or failure), the modal's Done/Close button gets a sibling "Download logs" button that writes the full `state.logs` buffer to a `.txt` file at `~/Downloads/os8-install-<slug>-<ts>.log`. Implementation: an IPC channel `app-store:save-install-log` on the main side that uses `dialog.showSaveDialog` then `fs.writeFile`.

### Docker pull progress

Docker's `docker pull <image>` with default flags emits a hand-built progress UI (carriage-return overwrite per layer). Parsed format from `--quiet=false` plus the API works but isn't argv-friendly. Pragmatic: invoke `docker pull` with `2>&1 | tee` semantics by wrapping the spawn output, parse lines like `<sha>: Downloading [=====>] 12.34MB/45.67MB`, emit one consolidated "Downloading layer <short-sha>: 27%" line per layer per second. Keep raw output as fallback when parsing fails.

A `compactDockerPullLine(line)` helper in `docker.js` matches `/^([0-9a-f]{12,}): (Downloading|Extracting|...) ?\s*(?:\[[^\]]*\])?\s*(?:([\d.]+)\s*([KMGT]B)\/([\d.]+)\s*([KMGT]B))?/`, computes percentage from current/total, emits e.g. `abc123def456: Downloading 27% (12.3MB / 45.6MB)`. Falls back to passing the line through unchanged when the regex doesn't match.

### Tests

`tests/install-plan-modal.streaming-logs.test.js`:

| Scenario | Assertion |
|---|---|
| `logBuffer.push` 100 lines synchronously | exactly one `emit` call after `LOG_BUFFER_INTERVAL_MS`; payload contains all 100 lines |
| `logBuffer.flushNow()` mid-buffer | flushes pending + cancels timer |
| Render 600 lines into modal | only last 500 rendered; full 600 retained in `state.logs` |
| Render with `state.logsAutoScroll=false` | no `scrollTop` mutation |
| Adapter emits 2.5KB single-line | buffered as a 2KB-truncated entry |

`tests/runtime-adapters/docker.pull-parse.test.js`:

| Input | Expected compact line |
|---|---|
| `abc123def456: Downloading [===>] 12.3MB/45.6MB` | `abc123def456: Downloading 26% (12.3MB / 45.6MB)` |
| `abc123def456: Pull complete` | `abc123def456: Pull complete` |
| `Status: Downloaded newer image for nginx:latest` | passes through unchanged |

### Smoke gate

**Real-app smoke required before PR 4.2 merges.** PR 4.1's value depends on its behavior during a multi-minute install. Smoke:

1. Local clean state (no Streamlit deps cached). Phase 3.5.3's chosen Streamlit fixture (e.g. `whitphx/streamlit-webrtc-example` or whatever lands).
2. Click Install in the modal.
3. Verify: log lines stream in within ~1s of `pip install` starting. ML model downloads show GB progress. Total install completes.
4. After install completes, click Download Logs. Open the `.log` file. Verify: full output present, ordered, with both stdout and stderr lines visible and tagged.

**Why gating.** Streaming logs is the kind of feature that "works in unit tests" but feels broken in production if the buffer cadence is wrong. Smoke against a real install before declaring shipped. Mirror of phase-3-plan §7.5's reasoning.

### Acceptance criteria

- During `npm install` for worldmonitor, the modal shows tarball-scan output streaming live.
- During `pip install` for a Streamlit fixture, deps appear line-by-line; ML model downloads show MB progress.
- During `docker pull` for a Phase 3.5.5 fixture, layer-by-layer compact progress appears (one update per layer per second, not raw escape sequences).
- Buffered relay introduces ≤200ms perceived latency (per `LOG_BUFFER_INTERVAL_MS`).
- Log panel auto-scrolls when user is at bottom; pauses auto-scroll when user scrolls up; resumes when user scrolls back to bottom.
- Download Logs writes a `.log` file with the full session.
- Stderr lines render with muted-red styling (CSS class `--stderr`).

### Cross-platform notes

- Node `child_process.spawn` line buffering differs slightly between platforms (Windows uses CRLF; macOS/Linux LF). Adapters' line splitter should split on `\r?\n` and discard empty trailing lines.
- macOS/Linux: `pip install` writes tqdm progress bars that overwrite the same line via `\r`. Render strategy: collapse `\r`-separated tokens into the latest token before splitting on `\n` (so progress bars show as one updating line instead of 100 stale lines).

### Spec deviations

- **Buffered relay** isn't in the spec. Spec §6.5 says "progress UI streams runtime adapter logs from `app_install_jobs.log_path`." This PR ships the streaming part; the file persistence already exists at `app_install_jobs.log_path` per PR 1.5.
- **2KB per-line truncation** is a pragmatic limit, documented above.

### Depends on

PR 1.11 (adapter `onLog` interface), PR 1.17 (install plan modal), PR 1.5 (`app_install_jobs.log_path`). Independent of every other Phase 4 PR.

### Open sub-questions

1. **Should we persist logs across modal close?** Currently `state.logs` is in renderer memory; closing the modal mid-install loses the in-modal display (the file at `app_install_jobs.log_path` retains everything for "Download logs"). **Recommendation:** ship without re-hydrate; add if users complain. The Download button covers the failure-recovery case.
2. **Does PR 4.4 (telemetry) re-use this buffer?** Yes — the telemetry emitter at PR 4.4 reads the same `app_install_jobs.log_path` for the failure-classification finger-print. No new code path needed.

---

## PR 4.2 — Auto-update opt-in for Verified channel

**Goal.** Per spec §6.9 line 6: *"Verified-channel apps with `auto_update = 1` (default OFF): only auto-applies if `user_branch` is null. With user edits, never auto-updates."* The schema column already exists (`apps.auto_update INTEGER DEFAULT 0`, migration 0.5.0). What's missing is (a) a per-app toggle UI to flip it ON, (b) a scheduler that detects updates + applies them when safe, (c) a notification when an auto-update lands so the user isn't surprised by a restart.

### Files

- **Modify:** `/home/leo/Claude/os8/src/renderer/apps.js` — add a "Settings…" right-click action on each app icon that opens a per-app settings flyout
- **Create:** `/home/leo/Claude/os8/src/renderer/app-settings-flyout.js` — flyout with Auto-Update toggle, Idle-Reap override, Uninstall
- **Modify:** `/home/leo/Claude/os8/src/services/app.js` — add `setAutoUpdate(db, appId, enabled)` and `getAutoUpdate(db, appId)`
- **Modify:** `/home/leo/Claude/os8/src/routes/apps.js` — `PATCH /api/apps/:id/auto-update` endpoint
- **Modify:** `/home/leo/Claude/os8/src/server.js` — extend `scheduleAppCatalogSync` (existing per PR 3.5) to also call `_processAutoUpdates(db)` after each sync run
- **Create:** `/home/leo/Claude/os8/src/services/app-auto-updater.js` — the auto-update logic (detect candidates, gate on `user_branch === null`, dispatch to `AppCatalogService.update`)
- **Modify:** `/home/leo/Claude/os8/src/renderer/notifications.js` (or create if absent) — toast notification when an auto-update lands
- **Modify:** `/home/leo/Claude/os8/index.html` — flyout DOM structure
- **Modify:** `/home/leo/Claude/os8/styles/components.css` — flyout + toast styles

### `app-auto-updater.js` — contract

```js
class AppAutoUpdater {
  static async processAutoUpdates(db, { onUpdated, onSkipped, onFailed } = {})
    // → { attempted, updated, skipped, failed }
}
```

Selects rows where `app_type='external' AND status='active' AND auto_update=1 AND update_available=1 AND channel='verified'`. For each: if `user_branch` is set → skip (spec §6.9 hard gate). Else call `AppCatalogService.update(db, app.id, app.update_to_commit)`; if it returns `merged: 'fast-forward'` → succeeded; if it returns `merged: 'three-way'` → skipped (upstream conflict cannot auto-resolve even when no user edits exist). Throws are caught and reported via `onFailed`.

### Scheduler integration

```js
// /home/leo/Claude/os8/src/server.js — extend the existing scheduleAppCatalogSync timer body
appCatalogSyncTimer = setTimeout(async () => {
  try {
    const AppCatalogService = require('./services/app-catalog');
    const AppAutoUpdater = require('./services/app-auto-updater');

    // 1. Sync catalogs (existing per PR 3.5).
    const v = await AppCatalogService.sync(db, { channel: 'verified' });
    console.log(`[AppCatalog/verified] +${v.added} updated:${v.updated} -${v.removed}`);
    const communityEnabled = SettingsService.get(db, 'app_store.channel.community.enabled');
    if (communityEnabled === 'true' || communityEnabled === true) {
      const c = await AppCatalogService.sync(db, { channel: 'community' });
      console.log(`[AppCatalog/community] +${c.added} updated:${c.updated} -${c.removed}`);
    }

    // 2. NEW: process auto-updates (Verified only, no user edits).
    const updates = await AppAutoUpdater.processAutoUpdates(db, {
      onUpdated: (app, sha) => {
        console.log(`[AutoUpdate] ${app.external_slug} → ${sha.slice(0, 7)}`);
        notifyRenderer({
          kind: 'auto-update-applied',
          appId: app.id,
          appName: app.name,
          newCommit: sha,
        });
      },
      onSkipped: (app, reason) => {
        console.log(`[AutoUpdate] ${app.external_slug} skipped: ${reason}`);
      },
      onFailed: (app, err) => {
        console.warn(`[AutoUpdate] ${app.external_slug} failed: ${err.message}`);
        notifyRenderer({
          kind: 'auto-update-failed',
          appId: app.id,
          appName: app.name,
          error: err.message,
        });
      },
    });
    console.log(`[AutoUpdate] attempted:${updates.attempted} updated:${updates.updated} skipped:${updates.skipped} failed:${updates.failed}`);
  } catch (e) {
    console.warn('[AppCatalog] Scheduled sync failed:', e.message);
  }
  scheduleAppCatalogSync();
}, msUntilSync);
```

`notifyRenderer` is a small helper that broadcasts an IPC event to all open windows; renderers subscribe and render a toast.

### Per-app settings flyout

Right-click on app icon → flyout with three sections:

```html
<!-- index.html — flyout template -->
<div id="appSettingsFlyout" class="app-settings-flyout" hidden>
  <header>
    <strong id="appSettingsFlyoutName">App Name</strong>
    <button class="close" data-action="close">×</button>
  </header>

  <section class="app-settings-flyout__section">
    <h3>Updates</h3>
    <label class="toggle">
      <input type="checkbox" id="appSettingsAutoUpdate" />
      <span>Auto-update from catalog</span>
    </label>
    <p class="hint">
      When the catalog publishes a new version, OS8 will fetch and apply
      it automatically — but <strong>only</strong> for Verified-channel
      apps that you haven't edited locally. If you've made any edits,
      OS8 will surface the update in the home-screen banner instead and
      you'll resolve the merge manually.
    </p>
    <p id="appSettingsAutoUpdateState" class="hint hint--state"></p>
  </section>

  <section class="app-settings-flyout__section">
    <h3>Idle reaping</h3>
    <label class="toggle">
      <input type="checkbox" id="appSettingsKeepRunning" />
      <span>Keep running (override idle reaper)</span>
    </label>
    <p class="hint">By default the app stops after the idle timeout in
       Settings → App Store. Toggle ON for long-running jobs.</p>
  </section>

  <section class="app-settings-flyout__section app-settings-flyout__section--danger">
    <h3>Lifecycle</h3>
    <button class="action-button action-button--danger" data-action="uninstall">Uninstall…</button>
  </section>
</div>
```

`openAppSettingsFlyout(app, anchorEl)` reads `apps.getAutoUpdate(app.id)`, mirrors into the checkbox, sets explanatory text per channel (Verified: enabled with caveat re: user edits; Community/Dev-Import: disabled with "Verified only" hint), wires `change` → `apps.setAutoUpdate`, positions next to the anchor.

### Notification toast

Bottom-right toast when an auto-update applies (Open action, 6s auto-dismiss) or fails (warning severity, 8s, Dismiss action). Subscribes to `app-auto-update-applied` and `app-auto-update-failed` events from the IPC broadcaster.

### Restart-on-update behavior

Spec §6.9 doesn't dictate whether an auto-update restarts the running process. Phase 4 decision: **restart only if the upstream changed start-relevant files** (`package.json`, lockfile, `start.argv`-referenced binary). For pure source edits, HMR (already wired per PR 1.22) handles it. The auto-updater calls `AppCatalogService.update` which already does the right thing per PR 1.25; this PR doesn't add new restart logic.

### Tests

`tests/app-auto-updater.test.js`:

| Scenario | Assertion |
|---|---|
| Verified app with `auto_update=1`, no user_branch, update_available=1 | `processAutoUpdates` calls `AppCatalogService.update`; result `updated:1` |
| Verified app with `auto_update=1` but user_branch='user/main' | skipped with reason "user_branch present" |
| Verified app with `auto_update=0` | not in candidate list |
| Community app with `auto_update=1` (somehow set) | not in candidate list (channel filter) |
| `AppCatalogService.update` returns `merged: 'three-way'` | counted as skipped (manual merge required) |
| `AppCatalogService.update` throws | counted as failed; error message preserved |

`tests/app-settings-flyout.test.js` (manual smoke given renderer DOM coupling):
- Open flyout for verified app: toggle is interactive
- Open flyout for community app: toggle is disabled with explanatory text
- Toggle ON → DB row updates; toggle OFF → DB row updates back

### Smoke gate

**Real Verified-channel update smoke required.** Use worldmonitor as the test app:
1. Install worldmonitor v2.5.23 (current Verified-channel pin) on a clean OS8 instance.
2. Right-click → Settings → toggle Auto-Update ON.
3. In `os8ai/os8-catalog`, open a PR bumping worldmonitor to a newer SHA (or use a test branch). Merge.
4. Wait for the next OS8 catalog sync (or trigger via Settings → App Store → Sync now).
5. Verify: console logs `[AutoUpdate] worldmonitor → <new-sha>`. Toast appears bottom-right. Open the app — page is the new version. `git log` in `~/os8/apps/<id>/` shows the upstream commit at `user/main`'s HEAD.

After smoke passes, **revert the catalog test bump** to keep the catalog clean.

### Acceptance criteria

- Right-click on any external-app icon opens the per-app settings flyout.
- For Verified-channel apps, Auto-Update toggle is interactive; for Community/Developer-Import, disabled with explanation.
- Toggling ON persists to `apps.auto_update`.
- Catalog sync detects an update + applies it when no user edits exist; skips with logging when edits exist.
- Toast notifies user when an auto-update lands (and when one fails).
- An auto-update with no user edits does not interrupt the user's session — the app continues running, the toast describes the change, and the next page navigation reflects the update.

### Cross-platform notes

- Toast positioning uses `position: fixed; bottom: 20px; right: 20px;` — works identically on macOS/Linux/Windows.
- The right-click context menu is inherited from the existing app icon context menu (already cross-platform per PR 1.24).

### Spec deviations

- **Restart policy is "smart" rather than "always restart" or "never restart."** Spec §6.9 doesn't specify; this PR documents the rule (restart only when start-relevant files change). Documented above.
- **Toast notification mechanism** is new — spec §6.9 mentions banner-on-app-open for manual updates but not auto-update notification. Toast is the natural extension.

### Depends on

PR 1.25 (`AppCatalogService.update`), PR 1.5 (`apps.user_branch` set on first commit). Independent of Tracks B/C/D/E.

### Open sub-questions

1. **What about Community-channel auto-update?** Spec §6.9 explicitly limits auto-update to Verified. **Recommendation:** stay with spec; promote to Phase 5 if community curators reach the same trust bar (no current signal of demand).
2. **Should the toast offer "Undo" (rollback)?** Conceptually possible — `AppCatalogService.update` could checkpoint the previous SHA. **Recommendation:** ship without; deferred-items.md tracks "rollback" as a future capability.

---

## PR 4.3 — "Update available" surface on `/apps/[slug]`

**Goal.** When an installed Verified app has an update pending in the catalog, surface it on os8.ai's detail page for that app — so users browsing the catalog from the web see "you have v1.4.2 installed; v1.5.0 is now available." Today the detail page shows only the latest catalog version with no per-user state. Phase 4 introduces a tiny optional UX: when the detail page knows (from the user's signed-in session) which version they have installed, show a comparison badge.

This is the os8.ai-side complement to PR 4.2's desktop banner. Independent of PR 4.2 (each can ship without the other) — but they're better together.

### Files (in `os8dotai/`)

- **Modify:** `/home/leo/Claude/os8dotai/prisma/schema.prisma` — add `installedVersions Json?` to `User` model OR (cleaner) introduce an `InstalledApp` model: `{ userId, appSlug, upstreamResolvedCommit, installedAt, channel }` with `(userId, appSlug)` unique index
- **Modify:** `/home/leo/Claude/os8dotai/prisma/schema.prisma` — corresponding `migrations/<ts>_installed_apps/migration.sql`
- **Create:** `/home/leo/Claude/os8dotai/src/app/api/account/installed-apps/route.ts` — `GET` (list user's installed apps), `POST` (upsert from desktop heartbeat)
- **Modify:** `/home/leo/Claude/os8dotai/src/app/apps/[slug]/page.tsx` — server-side, when authed user has this slug installed, fetch their commit SHA + render an `<UpdateBadge currentSha installedSha />` component
- **Create:** `/home/leo/Claude/os8dotai/src/app/apps/[slug]/UpdateBadge.tsx` — pure UI: "Update available — v1.5.0 (you have v1.4.2)"
- **Modify:** `/home/leo/Claude/os8/src/services/app-catalog.js` — new method `reportInstalledApps(db)` that POSTs the user's `apps[]` (slug + commit + channel) to `https://os8.ai/api/account/installed-apps` once per day

### Schema addition

```prisma
// os8dotai/prisma/schema.prisma — addition
model InstalledApp {
  id                       String   @id @default(cuid())
  userId                   String
  user                     User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  appSlug                  String
  upstreamResolvedCommit   String   // 40-char SHA
  channel                  String   // verified | community | developer-import
  installedAt              DateTime @default(now())
  lastReportedAt           DateTime @updatedAt

  @@unique([userId, appSlug])
  @@index([userId])
}

model User {
  // ...existing
  installedApps InstalledApp[]
}
```

### `installed-apps` route — contract

```
POST /api/account/installed-apps
  Auth: session required (401 if anonymous)
  Body: { apps: [{ slug, commit, channel }] }
  Effect:
    - Rate limit: max 24 reports per user per 24h → 429
    - Upsert each entry by (userId, appSlug); update upstreamResolvedCommit + channel
    - Delete entries where slug is absent from this report (reflects uninstall)
  Response: { ok: true, count: N }

GET /api/account/installed-apps
  Auth: session required
  Response: { apps: [{ appSlug, upstreamResolvedCommit, channel, installedAt }] }
```

The delete-on-omit semantics keep the server in sync with desktop state. A user who uninstalls worldmonitor will see the badge disappear from the detail page after the next heartbeat (≤24h).

### `UpdateBadge.tsx` and detail page integration

Pure UI component with two states: when `catalogSha === installedSha` → "✓ You have `<sha7>` installed (current)"; otherwise → "Update available. You have `<sha7>`; latest is `<tag>`. Open OS8 to apply." Rendered alongside the existing Install button on `/apps/[slug]` only when `getServerSession()` returns a user AND `prisma.installedApp.findUnique({ where: { userId_appSlug: { userId, appSlug } } })` returns a row.

### Desktop heartbeat — contract

`AppCatalogService.reportInstalledApps(db)` in the existing service file. Only POSTs when `AccountService.getSession(db).token` exists. Builds payload from `apps` table where `app_type='external' AND status='active'` mapping `(external_slug, upstream_resolved_commit, channel)` → `{ slug, commit, channel }`. POSTs to `https://os8.ai/api/account/installed-apps` with bearer token. Heartbeat is best-effort: 10s timeout; never throws to the scheduler. Called once per daily scheduler tick from `server.js` (cheap; opportunistic).

### Tests

`os8dotai/src/app/api/account/installed-apps/__tests__/route.test.ts`:

| Scenario | Assertion |
|---|---|
| Anonymous POST | 401 |
| Authed POST with apps array | upserts; updates `lastReportedAt` |
| POST omitting a previously-reported slug | row deleted (uninstall reflected) |
| POST > 24/day | 429 |
| GET as authed user | returns installed apps |

### Privacy notes

- The heartbeat is **opt-in via sign-in**. Anonymous users send nothing.
- Settings → App Store gets a checkbox: "Share installed-app list with os8.ai for update notifications" (default ON when signed in; can be turned off independently of sign-in). PR 4.5's privacy banner (telemetry) wraps this same checkbox.
- The data is per-user, not aggregated cross-user; no third-party share.

### Acceptance criteria

- Signed-in user with worldmonitor installed visits `https://os8.ai/apps/worldmonitor`: detail page shows "✓ You have v2.5.23 installed (current)."
- After a catalog bump (worldmonitor v2.6.0), same user sees "Update available. You have abc1234; latest is v2.6.0."
- Anonymous user (or signed-in user who hasn't installed) sees the install button only — no badge.
- Uninstalling worldmonitor on desktop, then re-visiting the page after the next heartbeat (≤24h), removes the badge.

### Cross-platform notes

None — server-side and Next.js page work.

### Spec deviations

- **`InstalledApp` model is new** — spec §5.1 doesn't include it (spec lists only `App`, `PendingInstall`, `CatalogState`). Added because the spec's "auto-update opt-in" (§6.9) only specifies the desktop side; the os8.ai-side surface for "user has X installed" is a natural complement.
- **Heartbeat cadence** is implementation detail; the spec is silent on it.

### Depends on

PR 1.26 (cross-device install — AccountService session). Independent of PR 4.2 (each ships independently; they're better together).

### Open sub-questions

1. **Should the heartbeat send on every install/uninstall, not just daily?** Cleaner UX (catalog page reflects state in seconds). **Recommendation:** ship daily-only first; add per-event POST if users complain about staleness.

---

## PR 4.4 — Per-adapter install telemetry emitter

**Goal.** Spec §8 ("Future") and §11 (open #11 monitoring) call for "telemetry on install success/fail." Phase 3 surfaced the value concretely: the worldmonitor smoke produced 11 hotfixes, **and we have no idea how many failures users hit silently in the wild for the same root causes.** Phase 4 wires the desktop side: emit a structured event when an install succeeds, fails, or is cancelled, including adapter-level fingerprints (which runtime, which framework, exit codes, log fingerprints) — **without sending raw logs or PII.**

The os8.ai-side ingest endpoint and dashboard ship as PR 4.5.

### Privacy contract — non-negotiable

Telemetry is **opt-in via Settings → App Store**. The first time a user installs an external app, the install plan modal includes a one-time "Help OS8 by sending anonymous install events" checkbox (defaults to ON, can be turned off forever). Settings has a permanent toggle.

What we send:
- Event kind: `install_started` / `install_succeeded` / `install_failed` / `install_cancelled` / `install_overridden` (user clicked through findings).
- Adapter kind: `node` / `python` / `static` / `docker`.
- Framework: `vite` / `nextjs` / `streamlit` / `gradio` / `hugo` / `jekyll` / `none` / `null`.
- Channel: `verified` / `community` / `developer-import`.
- Manifest slug (the external_slug — public; same string is in the catalog).
- Manifest version: `upstream_resolved_commit` (40-char SHA — public; tied to the catalog entry).
- Failure fingerprint (when applicable): a hash of the last error line + the failing phase (`install`/`postInstall`/`preStart`/`start`). Never the line itself.
- Duration ms.
- Os family + arch: `darwin/arm64` / `linux/x86_64` / `win32/x86_64`.
- Anonymous client id: a random UUID stored at `~/os8/.telemetry/client-id`. Rotates on user request.

What we **never** send:
- Hostname, username, file paths, env vars, API keys, raw log lines, IP (Vercel does see the IP at the network layer; os8.ai discards it server-side per spec §10).
- Anything from per-app secrets or the user's manifest customizations (e.g. dev-import modal toggles).
- Anything from non-App-Store activity.

### Files

- **Create:** `/home/leo/Claude/os8/src/services/app-telemetry.js`
- **Modify:** `/home/leo/Claude/os8/src/services/app-installer.js` — emit telemetry events at each state transition
- **Modify:** `/home/leo/Claude/os8/src/services/app-auto-updater.js` (from PR 4.2) — emit `update_succeeded` / `update_failed` events
- **Modify:** `/home/leo/Claude/os8/src/renderer/install-plan-modal.js` — add the one-time consent checkbox; on first-install consent, write `app_store.telemetry.opt_in = 'true'` setting
- **Modify:** `/home/leo/Claude/os8/src/renderer/settings.js` — add a permanent "Send anonymous install telemetry" toggle in the App Store section, plus a "Reset client ID" button
- **Modify:** `/home/leo/Claude/os8/index.html` — settings UI rows
- **Migration:** `0.6.0-app-store-telemetry.js` (PR 4.11) — adds `app_telemetry_events` table for offline queue + `app_store.telemetry.opt_in` settings key

### `app-telemetry.js` — public API

```js
class AppTelemetry {
  static getClientId();                // reads/creates ~/os8/.telemetry/client-id
  static rotateClientId();             // generates fresh UUID; severs link to past events
  static isEnabled(db);                // reads app_store.telemetry.opt_in
  static enqueue(db, event);           // writes to app_telemetry_events queue (no-op if opted out)
  static async flush(db);              // POSTs up to 25 pending events; marks sent_at; GCs sent>7d
  static fingerprintFailure(line);     // SHA-256(strip /[\d\/\\]/, slice 256) → 16-char hex
}
```

Constants: `TELEMETRY_ENDPOINT = OS8_TELEMETRY_ENDPOINT || 'https://os8.ai/api/apps/telemetry'`; `TELEMETRY_BATCH_SIZE = 25`; `TELEMETRY_FLUSH_INTERVAL_MS = 60_000`.

`enqueue` schedules a deferred flush (`setTimeout(flush, 60s).unref()`); a single timer ever pending. `flush` honors opt-out at write time **and** at flush time (toggled-mid-batch deletes pending). HTTP failures leave rows unsent — retried next cycle.

`_sanitize` uses a hard allowlist:

```js
const ALLOWED = new Set([
  'kind', 'adapter', 'framework', 'channel', 'slug', 'commit',
  'failurePhase', 'failureFingerprint', 'durationMs',
  'os', 'arch', 'overridden', 'overrideReason',
]);
// Drop any other keys; os/arch always reset to process.platform/arch.
```

The allowlist is a **hard guarantee**: even if a future contributor adds `userEmail` to the event object, the sanitizer drops it.

### Installer integration

```js
// /home/leo/Claude/os8/src/services/app-installer.js — additions
const AppTelemetry = require('./app-telemetry');

class AppInstaller {
  // ...existing
  static async _run(db, jobId) {
    const startTs = Date.now();
    let job = AppInstallJobs.get(db, jobId);
    AppTelemetry.enqueue(db, {
      kind: 'install_started',
      adapter: this._resolveAdapterKind(job),
      framework: this._resolveFramework(job),
      channel: job.channel,
      slug: job.external_slug,
      commit: job.upstream_resolved_commit,
    });
    try {
      // ...existing state machine...
      const result = await this._installPostApproval(db, job);
      AppTelemetry.enqueue(db, {
        kind: 'install_succeeded',
        adapter: this._resolveAdapterKind(job),
        framework: this._resolveFramework(job),
        channel: job.channel,
        slug: job.external_slug,
        commit: job.upstream_resolved_commit,
        durationMs: Date.now() - startTs,
      });
      return result;
    } catch (e) {
      const lastErrLine = await this._readLastLogLine(job);
      AppTelemetry.enqueue(db, {
        kind: 'install_failed',
        adapter: this._resolveAdapterKind(job),
        framework: this._resolveFramework(job),
        channel: job.channel,
        slug: job.external_slug,
        commit: job.upstream_resolved_commit,
        failurePhase: e.failurePhase || 'unknown',
        failureFingerprint: AppTelemetry.fingerprintFailure(lastErrLine || e.message),
        durationMs: Date.now() - startTs,
      });
      throw e;
    }
  }

  static async _readLastLogLine(job) {
    if (!job.log_path) return null;
    try {
      const content = await require('fs').promises.readFile(job.log_path, 'utf8');
      const lines = content.trim().split('\n').filter(l => l.startsWith('[stderr] '));
      return lines.length ? lines[lines.length - 1].slice(9) : null;
    } catch {
      return null;
    }
  }
}
```

`_resolveAdapterKind` and `_resolveFramework` parse the job's manifest_yaml.

### Settings UI

```html
<!-- index.html — additions inside the App Store settings section -->
<hr />

<div class="settings-row">
  <label>
    <input type="checkbox" id="appStoreTelemetryOptIn" />
    <strong>Send anonymous install telemetry</strong>
    <span class="settings-hint">Helps us see which adapters fail and why. We send
      adapter kind, framework, success/fail, and an error-line fingerprint —
      <strong>never</strong> raw logs, paths, secrets, or your username.
      <a href="#" data-action="open-telemetry-doc">What we send</a>.</span>
  </label>
</div>

<div class="settings-row">
  <button id="appStoreTelemetryReset" class="action-button">Reset anonymous client ID</button>
  <span class="settings-hint">Generate a fresh ID; severs the link between past
    and future events.</span>
</div>
```

### First-install consent

```js
// /home/leo/Claude/os8/src/renderer/install-plan-modal.js — additions
async function maybeShowFirstInstallConsent(state) {
  const seenConsent = await window.os8.settings.get('app_store.telemetry.consent_shown');
  if (seenConsent === 'true') return;

  state.firstInstallConsent = true;
  state.firstInstallConsentAccepted = true;     // default ON
}

// In renderModal, when state.firstInstallConsent is true, add a section above the
// install button:
function renderFirstInstallConsent(state) {
  if (!state.firstInstallConsent) return '';
  return `
    <div class="install-plan-modal__consent">
      <label>
        <input type="checkbox" data-action="consent-toggle"
          ${state.firstInstallConsentAccepted ? 'checked' : ''} />
        <strong>Help OS8 by sending anonymous install telemetry</strong>
        <span>You can change this any time in Settings → App Store.
          We never send raw logs or your data — see <a href="#" data-action="open-telemetry-doc">what we send</a>.</span>
      </label>
    </div>
  `;
}

// On Install click, write the consent + flag the consent-shown setting:
async function onInstallApprove(state) {
  if (state.firstInstallConsent) {
    await window.os8.settings.set('app_store.telemetry.opt_in',
      state.firstInstallConsentAccepted ? 'true' : 'false');
    await window.os8.settings.set('app_store.telemetry.consent_shown', 'true');
  }
  // ...existing install dispatch...
}
```

### Tests

`tests/app-telemetry.test.js`:

| Scenario | Assertion |
|---|---|
| `enqueue` when opt-in is false | no row written |
| `enqueue` when opt-in is true | row written with sanitized payload |
| `_sanitize` strips disallowed keys | output keys are subset of allowlist |
| `flush` with 25 pending | one POST; rows marked sent |
| `flush` with HTTP 503 | rows stay unsent; retried next cycle |
| `flush` with opt-in flipped to false | pending rows deleted |
| `getClientId` first call | creates `~/os8/.telemetry/client-id` |
| `rotateClientId` | new UUID; file rewritten |
| `fingerprintFailure('npm ERR! 404 Not Found - …')` | 16-char hex; deterministic |

`tests/install-plan-modal.consent.test.js`:

| Scenario | Assertion |
|---|---|
| First install: consent block renders, default ON | settings written on Install |
| Subsequent install: consent block does not render | no settings write |
| User unchecks consent then installs | opt-in stored false; pending events GC'd |

### Acceptance criteria

- First install ever (clean OS8 state) shows the consent checkbox in the install plan modal.
- Approving with default ON writes `app_store.telemetry.opt_in = true` and `app_store.telemetry.consent_shown = true`.
- Subsequent installs do not show the checkbox; respect the saved opt-in.
- Settings → App Store has a permanent toggle + Reset Client ID button.
- An install that succeeds enqueues `install_started` + `install_succeeded` events; flush within 60s; rows marked sent.
- An install that fails enqueues `install_started` + `install_failed` with a fingerprint (not the raw line).
- Toggling opt-out drops pending unsent events.
- Reset Client ID rotates the UUID; subsequent events use the new ID.

### Cross-platform notes

- `crypto.randomUUID()` is Node 14+ stable on every platform.
- `fs.mkdirSync(dir, { recursive: true })` is cross-platform.
- The telemetry directory at `~/os8/.telemetry/` is platform-agnostic given `OS8_HOME` resolution.

### Spec deviations

- **`overridden` event kind** is new — captures the "scan surfaces, user decides" pattern. When a user clicks through critical findings (advisory gate per spec §6.5), we emit `install_overridden { overrideReason: 'critical_finding' }` so we can measure how often the override path is exercised. Helps calibrate whether MAL-* findings should ever be hard-blocked (deferred-items.md #2).
- **Failure fingerprint instead of raw line** is a privacy decision; spec §8 doesn't specify. The 16-char SHA prefix is enough to cluster identical failures in the dashboard without leaking PII.

### Depends on

PR 4.5 (ingest endpoint must accept POSTs first; emitter sends nothing useful without it). PR 4.11 (migration adds the events table). Independent of PRs 4.1, 4.2, 4.6, 4.7, 4.8, 4.9, 4.10.

### Open sub-questions

1. **Should we also emit on uninstall + auto-update?** Yes for `update_succeeded` / `update_failed` (already wired in PR 4.2's auto-updater). Uninstall events are optional — they're useful for understanding churn but cheap to defer. **Recommendation:** ship without uninstall events; add if PR 4.5's dashboard would benefit.
2. **Should the consent checkbox be opt-out instead of opt-in?** Industry split. **Recommendation:** opt-in default-ON (consent moment surfaces it; user can un-check before approving). The deferred-items doc tracks the alternative if we change our mind.

---

## PR 4.5 — Telemetry ingest endpoint + minimal dashboard

**Goal.** Receive the events PR 4.4 emits, store them in Postgres with sensible aggregation, and render a small internal dashboard at `/internal/telemetry/install` (auth-gated to a curator allowlist) showing per-adapter / per-framework / per-channel success rates and the top failure fingerprints. Public dashboards and per-app drilldowns are out of scope; the v1 dashboard's job is to **surface the silent-failure patterns Phase 3 surfaced manually**.

### Files (in `os8dotai/`)

- **Modify:** `/home/leo/Claude/os8dotai/prisma/schema.prisma` — add `InstallEvent` model + per-app counters on `App`
- **Modify:** `/home/leo/Claude/os8dotai/prisma/migrations/<ts>_install_telemetry/migration.sql` — schema deltas
- **Create:** `/home/leo/Claude/os8dotai/src/app/api/apps/telemetry/route.ts` — POST endpoint (anonymous, rate-limited per client ID per day)
- **Create:** `/home/leo/Claude/os8dotai/src/app/internal/telemetry/install/page.tsx` — internal dashboard (server-rendered, auth-gated)
- **Create:** `/home/leo/Claude/os8dotai/src/app/internal/telemetry/install/Charts.tsx` — Recharts wrapper for adoption + failure breakdowns
- **Modify:** `/home/leo/Claude/os8dotai/vercel.json` — third cron entry: telemetry rollup at `:05` daily
- **Create:** `/home/leo/Claude/os8dotai/src/app/api/internal/telemetry/rollup/route.ts` — daily aggregate to per-day per-(adapter,framework,channel,kind) counters; trims old raw events

### Schema

```prisma
model InstallEvent {
  id                       String   @id @default(cuid())
  clientId                 String   // hash of clientId from desktop, never plaintext IP
  kind                     String   // install_started | install_succeeded | install_failed | install_cancelled | install_overridden | update_succeeded | update_failed
  adapter                  String?  // node | python | static | docker
  framework                String?  // vite | nextjs | streamlit | gradio | hugo | jekyll | none
  channel                  String?  // verified | community | developer-import
  slug                     String?
  commit                   String?  // 40-char SHA
  failurePhase             String?  // install | postInstall | preStart | start
  failureFingerprint       String?  // 16-char SHA prefix
  durationMs               Int?
  os                       String?  // darwin | linux | win32
  arch                     String?  // arm64 | x64
  overrideReason           String?
  ts                       DateTime @default(now())

  @@index([ts])
  @@index([adapter, framework, channel, kind, ts])
  @@index([slug, ts])
  @@index([failureFingerprint])
}

model InstallEventDaily {
  id                       String   @id @default(cuid())
  day                      DateTime @db.Date
  adapter                  String
  framework                String?
  channel                  String
  kind                     String
  count                    Int

  @@unique([day, adapter, framework, channel, kind])
  @@index([day])
}

model App {
  // existing fields...
  installSuccessCount      Int      @default(0)
  installFailCount         Int      @default(0)
  installOverriddenCount   Int      @default(0)
  lastInstallEventAt       DateTime?
}
```

`clientId` arrives from the desktop pre-hashed, but we hash it again server-side with a server-only salt — so even a database leak doesn't expose user identifiers across services.

### Ingest route — contract

`POST /api/apps/telemetry`:

```
Headers: Content-Type: application/json
Body: { clientId: string, events: Event[], ts: number }

Validation:
  - clientId required (string)
  - events: max 100; unknown kinds dropped
  - per-field validation: commit must match /^[0-9a-f]{40}$/i; failureFingerprint /^[0-9a-f]{8,32}$/i;
    durationMs in [0, 86_400_000]; string fields capped at 16-64 chars
  - Rate limit: 200 events per hashed client ID per 24h → 429

Server-side:
  - Re-hash clientId: HMAC-SHA256(TELEMETRY_HASH_SALT, raw)[0:32]
  - createMany on InstallEvent
  - Increment App.{installSuccessCount, installFailCount, installOverriddenCount} when slug present
    + bump App.lastInstallEventAt

Response: { ok: true, count: number }
```

`TELEMETRY_HASH_SALT` is an env var; rotation cadence documented in `os8dotai/SECURITY.md`. No raw IP stored. Vercel sees the IP at the network layer; the route does not read or persist it.

### Daily rollup — contract

`GET /api/internal/telemetry/rollup` (cron-only; `Authorization: Bearer ${CRON_TOKEN}`):

1. Compute yesterday's UTC date range.
2. `prisma.installEvent.groupBy({ by: ['adapter','framework','channel','kind'], where: { ts: range, adapter not null, channel not null }, _count: true })`.
3. Upsert each group into `InstallEventDaily` keyed `(day, adapter, framework, channel, kind)`.
4. `deleteMany` raw events older than 30 days (rollup aggregates preserved indefinitely).

Response: `{ ok: true, rolled: number }`.

### Dashboard contents

`/internal/telemetry/install` (server-rendered, redirects non-curator emails to `/`):

- **Charts (last 30 days):** `<Charts daily={InstallEventDaily[]} />` — Recharts wrapper showing per-day stacked bars by `(adapter, kind)`. Two views (toggle): success vs fail rates per adapter; per-channel installs over time.
- **Top failure fingerprints (last 7 days):** table of `(adapter, framework, phase, fingerprint, count)` from `prisma.installEvent.groupBy({ by: ['failureFingerprint', 'adapter', 'framework', 'failurePhase'], where: { kind: 'install_failed', ts: gte:7d }, take: 20 })`. Reviewers cluster identical failures from the fingerprints.
- **Per-app counters:** `prisma.app.findMany({ where: { ... installSuccessCount + installFailCount > 0 ... }, take: 50 })` — slug, channel, ✓ count, ✗ count, override count, lastSeen.

`isCurator(email)` checks against env allowlist `OS8_CURATORS=leo@os8.ai,...`. Same pattern as existing internal-page gates.

### `vercel.json`

```json
{
  "crons": [
    { "path": "/api/internal/catalog/sync?channel=verified",  "schedule": "0,30 * * * *" },
    { "path": "/api/internal/catalog/sync?channel=community", "schedule": "15,45 * * * *" },
    { "path": "/api/internal/telemetry/rollup",               "schedule": "5 1 * * *" }
  ]
}
```

Daily at 01:05 UTC — comfortably outside the catalog-sync windows; minimal load.

### Tests

`os8dotai/src/app/api/apps/telemetry/__tests__/route.test.ts`:

| Scenario | Assertion |
|---|---|
| POST without clientId | 400 |
| POST with 0 events | 200 ok count:0 |
| POST with 100 events | all stored; per-app counters incremented for slug-bearing kinds |
| POST with 101 events | 400 |
| POST with malformed `commit` (not 40-char hex) | event accepted; commit set to null |
| POST exceeding rate limit | 429 |
| Unknown event `kind` | dropped silently (not stored) |

### Acceptance criteria

- POST `/api/apps/telemetry` with a valid batch returns 200 and stores rows.
- After ~24h of telemetry from a real OS8 instance, `/internal/telemetry/install` shows non-zero charts.
- Curator can read the dashboard; non-curator email gets redirected to `/`.
- Daily rollup runs on schedule; raw events older than 30 days are GC'd.
- Per-app counters increment correctly.

### Privacy notes

- IPs are not persisted. Vercel sees the IP at the network layer but our route doesn't read or store it.
- Client ID is hashed twice (once on desktop with random UUID generation, once on server with HMAC-SHA256 + secret salt) — server can't reverse-link to a specific OS8 instance.
- The dashboard is auth-gated to curators — never public.
- A future `/internal/telemetry/install/clientId/<id>` drill-down is intentionally not built in v1; if curators need per-instance debugging, that's a Phase 5 conversation with explicit user-consent surface.

### Cross-platform notes

None — server-side.

### Spec deviations

- **`InstallEvent` + `InstallEventDaily` schemas are new** — spec §5.1 doesn't include them. Spec §8 lists "telemetry on install success/fail" as a "Future" item; this PR builds the table.
- **Daily rollup with 30-day raw retention** is an implementation choice; spec is silent. Tradeoff: raw retention long enough to investigate fingerprints, aggregated retention forever.
- **Failure fingerprint not raw line** mirrors the desktop privacy contract.

### Depends on

PR 4.4 (desktop emitter is the only caller; otherwise endpoint sits idle). Independent of every other Phase 4 PR.

### Open sub-questions

1. **Should we expose any of this telemetry publicly on `/apps`?** Aggregated success rates would help users discriminate between apps. **Recommendation:** wait for one curator-side review of the dashboard's data quality first; promote to public surface in Phase 5 if the patterns are real.
2. **What's the right TELEMETRY_HASH_SALT rotation cadence?** Spec is silent. **Recommendation:** rotate on any suspected DB compromise; document in `os8dotai/SECURITY.md`. Annual rotation as default.

---

## PR 4.6 — `requireAppContext` strict mode flip

**Goal.** Spec §11 open #1: *"v1 leaves native React apps and the OS8 shell trusted (no `X-OS8-App-Id` requirement on `/api/*` for them). When a native app starts wanting per-app scoping (e.g. for multi-tenant features), tighten enforcement."* Phase 4 flips the constant. Native React apps and the OS8 shell continue to work via an **origin-based allowlist** (the OS8 shell origin, the native-app preview origin) instead of the implicit "no header → trust" rule. External apps continue to flow through the scoped surface and get the header injected by the proxy.

This is a real trust-boundary change. **It must not ship before PR 4.10's E2E harness validates that every native React app and every Phase 3.5 fixture still works.**

### Files

- **Modify:** `/home/leo/Claude/os8/src/middleware/require-app-context.js` — flip from permissive to strict; add origin allowlist
- **Modify:** `/home/leo/Claude/os8/src/services/scoped-api-surface.js` — confirm `X-OS8-App-Id` injection still works (it does); add comment cross-referencing strict mode
- **Modify:** `/home/leo/Claude/os8/src/server.js` — log every rejection in dev (`OS8_DEBUG=1`) so the smoke catches misconfigured native consumers
- **Modify:** `/home/leo/Claude/os8/CHANGELOG.md` — note the flip, with rollback instructions

### Origin allowlist

Native React apps load at `localhost:8888/<native-app-id>/` — the shell's catch-all serves them via Vite middleware. They share the bare `localhost:8888` origin with the shell. The OS8 main UI (renderer) loads from `index.html` at the same origin. Both should be allowed without a header.

External apps load at `<slug>.localhost:8888/` — distinct origin per app. They reach `/api/*` (a) through the scoped surface on `<slug>.localhost:8888/_os8/api/*` which injects the header, OR (b) by trying `localhost:8888/api/*` directly which is a different origin → CORS preflight, blocked since we send no `Access-Control-Allow-Origin`. So external apps MUST go through the scoped surface.

The check:

```js
// /home/leo/Claude/os8/src/middleware/require-app-context.js — replacement
const STRICT_MODE = process.env.OS8_REQUIRE_APP_CONTEXT_PERMISSIVE !== '1';

function requireAppContext(req, res, next) {
  const headerAppId = req.headers['x-os8-app-id'];
  if (headerAppId) {
    req.callerAppId = headerAppId;
    return next();
  }
  if (!STRICT_MODE) {
    // Legacy permissive path (env-toggled rollback escape hatch).
    return next();
  }

  // Strict mode: allow only requests from the bare-localhost origin (shell + native apps).
  // The host is what matters; not the proxy's X-Forwarded-* (we don't run behind a proxy).
  const origin = req.headers.origin || req.headers.referer;
  if (origin) {
    try {
      const u = new URL(origin);
      // Bare host means shell or native React app — trusted.
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
        if (Number(u.port) === Number(process.env.OS8_PORT || 8888)) {
          return next();
        }
      }
    } catch (_) { /* fall through */ }
  }
  // No origin (e.g. server-side fetch) — when the request comes from the same machine
  // and process.env says we're internal, allow. The internal scheduler is the main
  // example: scheduleAppCatalogSync runs in-process and does fetch('https://os8.ai/...')
  // outbound — those don't hit our middleware. But other in-process fetch('http://localhost:8888/api/...')
  // calls (e.g. periodic health-check from a service) need a way through.
  // Solution: in-process callers set a per-request internal token via a separate header.
  if (req.headers['x-os8-internal-token'] === SettingsService.get(db, '_internal_call_token')) {
    return next();
  }

  if (process.env.OS8_DEBUG === '1') {
    console.warn(`[require-app-context] rejecting ${req.method} ${req.path} — origin=${origin || '(none)'}`);
  }
  return res.status(403).json({
    error: 'this API requires app context — call via window.os8.* SDK or set X-OS8-App-Id',
  });
}
```

The internal token is generated once at server startup and stored in the `settings` table; in-process callers (like the catalog scheduler) read it and include it in their headers. This avoids leaking trust through `--no-cors` quirks.

### Rollback escape hatch

If a user reports an issue, they can set `OS8_REQUIRE_APP_CONTEXT_PERMISSIVE=1` in their environment to revert to v1 behavior temporarily. CHANGELOG documents this. Not visible in the Settings UI — escape hatch only.

### Smoke

The PR cannot merge until PR 4.10's harness asserts:

- All Phase 3.5 fixtures (worldmonitor, cyberchef, [streamlit], [gradio], [docker]) install + render + can call their declared capabilities through the scoped surface.
- The OS8 home grid renders (shell origin → allowed).
- Each native React app from `~/os8/apps/` loads its own page (bare-localhost origin → allowed).
- A direct request to `localhost:8888/api/apps/<id>/blob/test` from outside the trust boundary (e.g. a curl from another machine) gets 403.

The harness is the gate. PR 4.10 must merge first; PR 4.6 merges only after the harness suite passes against the strict middleware.

### Tests

`tests/require-app-context.strict.test.js`:

| Request | Header / origin | Expect |
|---|---|---|
| `GET /api/apps` with `X-OS8-App-Id: abc` | header set | 200; `req.callerAppId = 'abc'` |
| `GET /api/apps` with `Origin: http://localhost:8888` | no header, shell origin | 200 |
| `GET /api/apps` with `Origin: http://worldmonitor.localhost:8888` | no header, subdomain origin | 403 |
| `GET /api/apps` with no `Origin`, no header | bare in-process call without internal token | 403 |
| `GET /api/apps` with `X-OS8-Internal-Token: <good>` | internal token | 200 |
| `OS8_REQUIRE_APP_CONTEXT_PERMISSIVE=1` env, no header | rollback mode | 200 |

### Acceptance criteria

- After flip: every external-app capability call still works through the scoped surface (no regression in smoke).
- After flip: every native React app continues to work (passes E2E harness).
- A curl from an arbitrary external client (e.g. `curl -H 'Origin: http://attacker.example' http://localhost:8888/api/apps/abc/blob/x`) returns 403.
- `OS8_REQUIRE_APP_CONTEXT_PERMISSIVE=1` env var restores v1 behavior (escape hatch verified).

### Cross-platform notes

- `req.headers.origin` is identical across platforms.
- The internal token mechanism uses `crypto.randomBytes(32).toString('hex')` — cross-platform.

### Spec deviations

- **Origin-based allowlist** is a refinement of spec §6.3.2 ("native apps and the OS8 shell are trusted code"). Spec doesn't say *how* trust is decided post-flip; this PR codifies the host check.
- **Internal token mechanism** is new. Spec is silent on in-process server→server calls.
- **Rollback env var** is operational, not specced.

### Depends on

PR 1.7 (`scopedApiMiddleware`), PR 1.8 (the existing permissive middleware). **GATED behind PR 4.10.**

### Open sub-questions

1. **Should the rollback env var also surface a Settings warning when active?** "OS8 is running in legacy permissive mode" banner. **Recommendation:** yes for a v1.2 follow-up; ship without to keep this PR focused.
2. **Is there a path for native apps to declare per-app scoping voluntarily?** Some native apps may want app-id-scoped storage even though they don't need to. **Recommendation:** that's a future feature; native apps can manually set `X-OS8-App-Id` from their preload if they want it (no SDK plumbing needed).

---

## PR 4.7 — `mcp.<server>.*` wildcard capability

**Goal.** Spec §11 open #4: *"`mcp.<server>.<tool>` is fine-grained but verbose. Consider supporting wildcards: `mcp.<server>.*` after first deploy if curators want it."* Phase 3 confirmed the verbosity cost (PR 3.2's modal had to defer wildcards because the toggle UI for >5 tools per server is unwieldy). Phase 4 adds the wildcard with explicit semantics: **`mcp.<server>.*` grants all currently-registered tools on `<server>` AND any tools that server registers in the future** (the MCP server itself is the trust boundary; the user's grant is to the server, not to the tool list snapshot).

### Files

- **Modify:** `/home/leo/Claude/os8/src/services/scoped-api-surface.js` — `isAllowed(requestedCap, allowed)` accepts wildcards
- **Modify:** `/home/leo/Claude/os8/src/data/appspec-v1.json` — `permissions.os8_capabilities` items accept `mcp.<server>.*` pattern
- **Modify:** `/home/leo/Claude/os8/src/data/appspec-v2.json` — same
- **Modify:** `/home/leo/Claude/os8/src/preload-external-app.js` — `window.os8.mcp.<server>` proxy that accepts `*` declarations
- **Modify:** `/home/leo/Claude/os8/src/services/app-review.js` — LLM review prompt mentions wildcard semantics so reviewers know what's been granted
- **Modify:** `/home/leo/Claude/os8/src/renderer/install-plan-modal.js` — render `mcp.<server>.*` as a single visible row labeled "all tools on <server>"
- **Doc:** Update `docs/app-store-spec.md` §6.3.2 capability list

### Capability resolver

```js
// /home/leo/Claude/os8/src/services/scoped-api-surface.js — isAllowed extension
function isAllowed(requested, declared) {
  // Exact match — fast path.
  if (declared.includes(requested)) return true;

  // Wildcard match: `mcp.<server>.<tool>` against `mcp.<server>.*` declarations.
  const m = requested.match(/^mcp\.([^.]+)\.([^.]+)$/);
  if (m) {
    const [, server, _tool] = m;
    if (declared.includes(`mcp.${server}.*`)) return true;
  }

  // No catch-all: `mcp.*.*` is intentionally NOT supported (would grant all servers).
  return false;
}
```

`mcp.*.*` is rejected at validation time (see schema below). Granting "all MCP tools across all servers" is too coarse; users should declare per-server intent.

### JSON Schema

```json
{
  "permissions": {
    "properties": {
      "os8_capabilities": {
        "type": "array",
        "items": {
          "type": "string",
          "anyOf": [
            { "enum": [
              "blob.readwrite", "blob.readonly", "db.readwrite", "db.readonly",
              "telegram.send", "imagegen", "speak", "youtube", "x",
              "google.calendar.readonly", "google.calendar.readwrite",
              "google.drive.readonly", "google.gmail.readonly"
            ]},
            { "pattern": "^mcp\\.[a-z][a-z0-9-]*\\.[a-z][a-z0-9-]+$",
              "description": "Specific MCP tool: mcp.<server>.<tool>" },
            { "pattern": "^mcp\\.[a-z][a-z0-9-]*\\.\\*$",
              "description": "All current and future tools on a single MCP server: mcp.<server>.*" }
          ]
        }
      }
    }
  }
}
```

`mcp.*.*` and `mcp.*.<tool>` and bare `mcp.*` all fail validation.

### Modal rendering

When the install plan modal renders the permissions list, group `mcp.<server>.<tool>` and `mcp.<server>.*` entries:

```js
function renderMcpCapabilities(capList) {
  // Group by server.
  const byServer = new Map();
  for (const cap of capList.filter(c => c.startsWith('mcp.'))) {
    const [, server, tool] = cap.split('.');
    if (!byServer.has(server)) byServer.set(server, []);
    byServer.get(server).push(tool);
  }
  return [...byServer.entries()].map(([server, tools]) => {
    if (tools.includes('*')) {
      return `<li><code>mcp.${escapeHtml(server)}.*</code> — <strong>all current and future tools</strong> on the <code>${escapeHtml(server)}</code> MCP server.</li>`;
    }
    return `<li><code>mcp.${escapeHtml(server)}</code>: ${tools.map(t => `<code>${escapeHtml(t)}</code>`).join(', ')}</li>`;
  }).join('');
}
```

The "current and future" wording is intentional — sets the user's expectation that the trust grant scopes to the server, not a snapshot.

### LLM review prompt

```js
// /home/leo/Claude/os8/src/services/app-review.js — addition to LLM prompt
const MCP_WILDCARD_NOTE = `
NOTE: capabilities of the form "mcp.<server>.*" grant the app access to ALL
current and future tools registered by that MCP server. Treat them as an
implicit trust grant to the server itself. If the manifest declares a
wildcard, your review must comment on whether the server is well-known
and whether the app's stated purpose justifies broad MCP access.
`;
```

### Tests

`tests/scoped-api-surface.mcp-wildcards.test.js`:

| Requested | Declared | Expect |
|---|---|---|
| `mcp.gh.list_pulls` | `['mcp.gh.list_pulls']` | true |
| `mcp.gh.list_pulls` | `['mcp.gh.*']` | true |
| `mcp.gh.list_pulls` | `['mcp.other.*']` | false |
| `mcp.gh.list_pulls` | `[]` | false |
| `blob.readonly` | `['blob.readonly']` | true (exact unchanged) |

`tests/manifest-validator.mcp-wildcards.test.js`:

| Capability string | Validates? |
|---|---|
| `mcp.gh.*` | yes |
| `mcp.gh.list_pulls` | yes |
| `mcp.*.*` | no (rejected pattern) |
| `mcp.*` | no (rejected pattern) |
| `mcp.gh.*.*` | no (rejected pattern) |

### Acceptance criteria

- Manifest declaring `mcp.gh.*` validates and installs.
- Installed app's call to `mcp.gh.list_pulls` succeeds; call to `mcp.other.list_pulls` returns 403.
- A future MCP server registers a new tool `mcp.gh.review_pull` while the app is running; the app can call it without re-install (because the wildcard grant scopes to the server, not the snapshot).
- Modal shows "all current and future tools on `gh`" wording for wildcard grants.
- Manifests with `mcp.*.*` are rejected by `validate.yml` in both catalog repos.

### Cross-platform notes

None — all logic is platform-agnostic.

### Spec deviations

- **`mcp.*.*` explicitly rejected** — spec §11 open #4 doesn't specify but the wildcard escalation risk is real. Documented above.
- **"Current and future" wording** is a UX commitment that crystallizes the trust model.

### Depends on

PR 1.7 (capability resolver). PR 4.9 must follow this PR (the npm-published `.d.ts` reflects the wildcard syntax).

### Open sub-questions

1. **Should we surface "this app's wildcard grant gives it access to N current tools" in the modal?** Helpful but adds runtime work (query MCP registry at modal-render time). **Recommendation:** ship without; add as a small modal enhancement if curators ask.
2. **What happens if the MCP server is uninstalled and reinstalled with a different toolset?** Wildcard grant continues to work for the new toolset (server name is the trust key). **Recommendation:** document in spec §6.3.2 update.

---

## PR 4.8 — Windows-2022 promoted to gating CI

**Goal.** Spec §11 open #11/#12: *"Cross-platform smoke matrix: macOS + Linux are blocking; Windows is best-effort."* Phase 4 flips Windows to gating across all four repos. The motivation: every Phase 0–3 PR has been "best-effort" Windows, which means **untested**. Without gating CI, a Windows regression slips in, no one notices until a Windows user files an issue, and we then have to bisect across many merged PRs.

### Files

- **Modify:** `/home/leo/Claude/os8/.github/workflows/test.yml` (or `ci.yml`) — add `windows-2022` to the matrix
- **Modify:** `/home/leo/Claude/os8/package.json` — `electron-builder` `build` config gains a `win` block
- **Create:** `/home/leo/Claude/os8/build/windows/installer.nsh` — NSIS installer script (registers `os8://` protocol; sets app data dir; etc.)
- **Modify:** `/home/leo/Claude/os8/tools/rebuild-native.js` — Windows path branching for `node-gyp` (paths use `\\` on Windows)
- **Modify:** `os8ai/os8-catalog/.github/workflows/validate.yml` — `runs-on` matrix becomes `[ubuntu-22.04, windows-2022]`
- **Modify:** `os8ai/os8-catalog-community/.github/workflows/validate.yml` — same
- **Modify:** `os8dotai/.github/workflows/test.yml` (if exists) — Vercel preview pipeline already runs on Linux; no change needed
- **Modify:** `/home/leo/Claude/os8/CLAUDE.md` — update "Cross-platform" notes to reflect Windows as supported

### CI matrix change

```yaml
# .github/workflows/test.yml — addition
strategy:
  fail-fast: false
  matrix:
    os: [macos-14, ubuntu-22.04, windows-2022]   # NEW: windows-2022 added
    node: ['22']
runs-on: ${{ matrix.os }}
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with: { node-version: ${{ matrix.node }} }
  - name: Install dependencies
    run: npm ci
  - name: Rebuild native modules
    run: node tools/rebuild-native.js
  - name: Lint
    run: npm run lint
  - name: Tests
    run: npm test
    env:
      OS8_TEST_TIMEOUT: 60000   # Windows can be slower
```

### `electron-builder` Windows config

```json
{
  "build": {
    "appId": "ai.os8.desktop",
    "productName": "OS8",
    "mac": { /* existing */ },
    "linux": { /* existing */ },
    "win": {
      "target": "nsis",
      "publisherName": "OS8",
      "artifactName": "OS8-Setup-${version}-${arch}.${ext}",
      "icon": "build/icon.ico"
    },
    "nsis": {
      "oneClick": false,
      "perMachine": false,
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true,
      "include": "build/windows/installer.nsh"
    },
    "protocols": [
      { "name": "OS8", "schemes": ["os8"] }
    ]
  }
}
```

The `protocols` block tells `electron-builder` to register `os8://` during NSIS install — covers spec §6.2.6's Windows handler integration.

### NSIS installer script

```nsi
; build/windows/installer.nsh
!macro customInstall
  ; Register protocol handler beyond what electron-builder does automatically;
  ; covers the per-user Software\Classes path even when the user installs without admin.
  WriteRegStr SHCTX "Software\Classes\os8" "" "URL:OS8 Protocol"
  WriteRegStr SHCTX "Software\Classes\os8" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\os8\DefaultIcon" "" "$INSTDIR\${PRODUCT_FILENAME}.exe,1"
  WriteRegStr SHCTX "Software\Classes\os8\shell\open\command" "" '"$INSTDIR\${PRODUCT_FILENAME}.exe" "%1"'
!macroend

!macro customUninstall
  DeleteRegKey SHCTX "Software\Classes\os8"
!macroend
```

### Windows-specific test patches

Some existing tests assume POSIX paths. PR 4.8 audits and fixes:

- Path joins use `path.join` (already correct in the codebase).
- Tests that hardcode `/tmp` use `os.tmpdir()`.
- Tests that spawn child processes with `shell: true` (rare) get `shell: false` + explicit shells where needed.
- Newline handling in adapter log tests handles both `\r\n` and `\n`.

### `rebuild-native.js` Windows path

```js
// /home/leo/Claude/os8/tools/rebuild-native.js — addition
const isWindows = process.platform === 'win32';
const nodeGypPath = isWindows
  ? path.join('node_modules', '.bin', 'node-gyp.cmd')
  : path.join('node_modules', '.bin', 'node-gyp');
```

### `*.localhost` resolution on Windows

Per spec §6.6, modern Windows 11 resolves `*.localhost` natively. Win10 1709+ also works in most builds; older Win10 may not. PR 1.16 already includes the install-time DNS check + UAC-elevated hosts entry prompt. Phase 4 verifies this code path in the harness:

```js
// tests/e2e/windows-localhost-resolution.test.js (added in PR 4.10)
import dns from 'node:dns/promises';

test('subdomain.localhost resolves to 127.0.0.1 on the host', async () => {
  const result = await dns.lookup('test-subdomain.localhost', { family: 4 });
  expect(result.address).toBe('127.0.0.1');
});
```

If this test fails on `windows-2022`, the runner is one of those legacy/AV-restricted setups; we either patch the runner image or document the user-side workaround (PR 1.16's hosts-entry prompt).

### Catalog repo CI — schema validation on Windows

```yaml
# os8ai/os8-catalog/.github/workflows/validate.yml — modify the runs-on
strategy:
  matrix:
    os: [ubuntu-22.04, windows-2022]
runs-on: ${{ matrix.os }}
```

The validation scripts (`validate-manifests.js`, `check-lockfile.js`, etc.) are pure Node — should work cross-platform without changes. Possible Windows snag: line-ending normalization on YAML files. The schema validator should be configured to accept either CRLF or LF.

### Tests

`tests/cross-platform.test.js` (new):

| Test | Assertion |
|---|---|
| `path.join` produces correct separator on each OS | trivially true; sanity check for the matrix |
| `OS8_HOME` resolves under `process.env.LOCALAPPDATA` (Windows) or `~` (POSIX) | matches the existing config.js logic |
| `os.tmpdir()` returns a writable path | smoke |
| `crypto.randomUUID()` works | smoke |

### Acceptance criteria

- `windows-2022` job appears in CI for every PR; failures block merge (becomes a required check on `main`).
- `npm test` passes on `windows-2022` for the existing test suite (any failures get fixed in this PR).
- `electron-builder --win` produces an NSIS installer that runs on Win11 + Win10.
- Installed Windows OS8 registers `os8://`; `start os8://install?slug=worldmonitor&...` opens the install plan modal in a running OS8.
- Phase 3.5.1 (worldmonitor) installs and renders on Windows in a manual smoke.

### Cross-platform notes

This entire PR is cross-platform notes.

### Spec deviations

- **None** — this PR brings the implementation up to spec §11 #11/#12 by promoting Windows to gating.

### Depends on

PR 1.16 (DNS pre-flight; already in tree). Independent of every other Phase 4 PR.

### Open sub-questions

1. **Do we ship Windows installers on the os8.ai download page?** Spec doesn't say. **Recommendation:** yes — a Windows download is the obvious end state of gating CI. Wire as a Phase 5 task once 4.8 has been stable for a few weeks.
2. **Code-signing for the Windows installer?** Required for SmartScreen acceptance. **Recommendation:** out of scope for 4.8; track as a post-4.8 task. Without code-signing, users get a SmartScreen warning on first run, but the install works.

---

## PR 4.9 — `@os8/sdk-types` TypeScript npm package

**Goal.** Spec §11 open #6: *"Ship type definitions (`@types/os8` or similar) in the auto-generated CLAUDE.md or as an installable npm package; pick one for v1."* PR 1.21 picked CLAUDE.md (ships `os8-sdk.d.ts` inside each external app folder). Phase 4 picks **both**: keep the in-folder copy for offline / local use, AND publish `@os8/sdk-types` to npm so external app authors editing in their own IDE can `npm install -D @os8/sdk-types` without their project being scaffolded inside `~/os8/apps/`.

### Files (new package + os8 modifications)

- **Create:** new public npm package `@os8/sdk-types` at `os8ai/os8-sdk-types` GitHub repo, containing:
  - `package.json` — `"name": "@os8/sdk-types", "types": "./index.d.ts"`
  - `index.d.ts` — the type definitions
  - `README.md` — quickstart, capability reference
  - `CHANGELOG.md`
  - `.github/workflows/release.yml` — automated release on git tag
- **Modify:** `/home/leo/Claude/os8/src/claude-md.js` (or wherever PR 1.21's generator lives) — auto-generated CLAUDE.md mentions both the in-folder `.d.ts` AND the npm package
- **Modify:** `/home/leo/Claude/os8/scripts/generate-sdk-types.js` (new) — script that walks `src/preload-external-app.js`, the capability list, and PR 4.7's wildcard syntax, and emits the canonical `index.d.ts`
- **Modify:** `/home/leo/Claude/os8/.github/workflows/sdk-types.yml` (new) — CI job that runs the generator on every PR touching the SDK; if the generator output differs from the published `os8ai/os8-sdk-types` repo's `index.d.ts`, fail with a clear message ("regenerate via `npm run generate-sdk-types` and PR to os8ai/os8-sdk-types")

### `index.d.ts` skeleton

```ts
// @os8/sdk-types/index.d.ts
declare global {
  interface Window {
    os8?: Os8Sdk;
  }
}

export interface Os8Sdk {
  blob?: BlobApi;
  db?: DbApi;
  imagegen?: ImagegenApi;
  speak?: SpeakApi;
  telegram?: TelegramApi;
  youtube?: YoutubeApi;
  x?: XApi;
  google?: GoogleApi;
  mcp?: McpApi;
}

// Each method is optional at the type level — declared capabilities determine
// what's actually exposed at runtime. The IDE shows everything; runtime presence
// follows the manifest's permissions.os8_capabilities.

export interface BlobApi {
  read(key: string): Promise<Blob>;
  write(key: string, data: Blob | ArrayBuffer | string): Promise<void>;
  list(prefix?: string): Promise<{ key: string; size: number; modified: string }[]>;
  delete(key: string): Promise<void>;
}

export interface DbApi {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[]; columns: string[] }>;
  execute(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowid: number }>;
}

export interface ImagegenApi {
  generate(opts: {
    prompt: string;
    model?: 'gpt-image-1' | 'imagen-3';
    aspectRatio?: '1:1' | '4:3' | '16:9' | '9:16';
    quality?: 'low' | 'medium' | 'high';
  }): Promise<{ imageUrl: string; revisedPrompt?: string }>;
}

export interface SpeakApi {
  generate(opts: { text: string; voice?: string; model?: string }): Promise<{ audioUrl: string }>;
}

export interface TelegramApi {
  send(opts: { text: string; chatId?: string }): Promise<{ ok: boolean; messageId?: number }>;
}

export interface YoutubeApi {
  videoInfo(url: string): Promise<{ title: string; channel: string; duration: number; description: string }>;
  transcript(url: string): Promise<{ segments: { start: number; text: string }[] }>;
}

export interface XApi {
  search(opts: { query: string; limit?: number }): Promise<{ posts: { id: string; text: string; author: string; ts: string }[] }>;
  userPosts(opts: { handle: string; limit?: number }): Promise<{ posts: { id: string; text: string; ts: string }[] }>;
  summarizeTopic(opts: { topic: string }): Promise<{ summary: string; sources: { id: string; text: string }[] }>;
}

export interface GoogleApi {
  calendar?: GoogleCalendarApi;
  drive?: GoogleDriveApi;
  gmail?: GoogleGmailApi;
}

export interface GoogleCalendarApi {
  listEvents(opts: { calendarId?: string; from?: string; to?: string }): Promise<{ events: GoogleCalendarEvent[] }>;
  createEvent?(opts: { calendarId?: string; event: GoogleCalendarEventInput }): Promise<GoogleCalendarEvent>;
}

// ...other Google APIs, fully typed...

// MCP API — the wildcard syntax from PR 4.7 means the type signature has to be
// open-ended: tools are dynamic. We expose a `call<TArgs, TResult>` shape.
export interface McpApi {
  [server: string]: McpServer;
}

export interface McpServer {
  call<TArgs = unknown, TResult = unknown>(tool: string, args: TArgs): Promise<TResult>;
  // For known tools, augmentation modules can declare strong types:
  //   declare module '@os8/sdk-types' {
  //     interface McpServer {
  //       gh: { list_pulls(args: { repo: string }): Promise<...> };
  //     }
  //   }
}

export {};
```

### Generator script

```js
// /home/leo/Claude/os8/scripts/generate-sdk-types.js
const fs = require('fs');
const path = require('path');

// Read the canonical capability list from preload-external-app.js
// (or from a shared source-of-truth like src/data/capabilities.js).
const PRELOAD_PATH = path.join(__dirname, '..', 'src', 'preload-external-app.js');
const preload = fs.readFileSync(PRELOAD_PATH, 'utf8');

// Static template — the .d.ts is mostly hand-written; the generator's job is to
// validate that every API in preload appears in the .d.ts and vice versa, and
// to bump the version + write CHANGELOG entries.

const CANONICAL_DTS = path.join(__dirname, '..', 'src', 'templates', 'os8-sdk.d.ts');

// Cross-check.
const missingInDts = [];
const missingInPreload = [];
// ...AST walk + comparison...

if (missingInDts.length || missingInPreload.length) {
  console.error('SDK type drift:', { missingInDts, missingInPreload });
  process.exit(1);
}

console.log('SDK types in sync with preload.');
```

The generator's primary job is **drift detection** — make sure the published types match what the runtime actually exposes. Manual edits to the .d.ts are fine; CI catches divergence.

### Publishing pipeline

```yaml
# os8ai/os8-sdk-types/.github/workflows/release.yml
name: release
on:
  push:
    tags: ['v*']
jobs:
  publish:
    runs-on: ubuntu-22.04
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          registry-url: 'https://registry.npmjs.org'
      - run: npm ci
      - run: npm publish --access public --provenance
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

`--provenance` ties npm publishes to the GitHub Actions run for supply-chain transparency.

### CLAUDE.md generator update

```js
// /home/leo/Claude/os8/src/claude-md.js — addition to the external-app generator
const SDK_USAGE_NOTE = `
## OS8 SDK types

This folder includes \`os8-sdk.d.ts\` for offline IDE autocomplete. If you
prefer to use the published package (e.g. for an external editor on a
different machine), install:

\`\`\`bash
npm install -D @os8/sdk-types
\`\`\`

Then add to your tsconfig.json:

\`\`\`json
{ "compilerOptions": { "types": ["@os8/sdk-types"] } }
\`\`\`
`;
```

### Tests

`tests/sdk-types.drift.test.js`:

| Scenario | Assertion |
|---|---|
| Every method on `window.os8` shape (parsed from preload) appears in `index.d.ts` | passes |
| Every interface in `index.d.ts` corresponds to a runtime API | passes |
| Generator script exits 0 on the canonical commit | passes |

### Versioning

`@os8/sdk-types` follows independent semver. The OS8 desktop's package.json includes a `peerDependencies` constraint:

```json
"peerDependencies": {
  "@os8/sdk-types": ">=1.0.0 <2.0.0"
}
```

When the SDK adds a method, that's a minor bump. When the SDK changes a signature, that's a major bump. The desktop's preload code stays compatible across minors.

### Acceptance criteria

- `@os8/sdk-types` is published to npm at version `1.0.0`.
- Installing `npm install -D @os8/sdk-types` in a TypeScript project gives `window.os8.*` autocomplete.
- The OS8 desktop's drift-check CI passes against the published version.
- A new method added to `window.os8` triggers a CI failure until the .d.ts is updated AND the package is re-released.

### Cross-platform notes

None — npm package is platform-agnostic.

### Spec deviations

- **"Both" instead of "either"** — spec §11 open #6 said pick one. We pick both because the in-folder .d.ts and the npm package serve different audiences (Claude Code editing inside `~/os8/apps/` vs external-IDE workflows). Cost is one extra repo.

### Depends on

PR 4.7 (wildcard syntax must be in the .d.ts). PR 1.9 (preload SDK shape). Independent of Tracks A, B, D.

### Open sub-questions

1. **Should the desktop bundle the latest `@os8/sdk-types` and copy it into each app folder on install?** Decouples the in-folder copy from the desktop's release. **Recommendation:** ship without; desktop generates the .d.ts from its own preload at install time (PR 1.21 already does this). The npm package is for external workflows.
2. **Does the `mcp` interface need TypeScript module augmentation examples in the README?** Yes — README documents the augmentation pattern so users with known MCP servers get strong types.

---

## PR 4.10 — Playwright-Electron E2E install harness

**Goal.** Spec phase-3-plan §7.6 explicitly nominates a Playwright-Electron E2E install harness as a Phase 4 candidate: *"opens OS8, navigates to 'Import from GitHub' or the verified-catalog browser, performs an install end-to-end against a known-good fixture, asserts the app icon appears and the BrowserView renders."* Phase 3.5's manual smoke pattern surfaces every-adapter regressions but doesn't catch them on PR-merge — only after manual smoke. The E2E harness is the automation that catches regressions before merge.

This PR is **the gate for PR 4.6** (`requireAppContext` strict flip).

### Files

- **Create:** `/home/leo/Claude/os8/tests/e2e/playwright/setup.ts` — Playwright-Electron launcher (boots OS8 with a clean `OS8_HOME`)
- **Create:** `/home/leo/Claude/os8/tests/e2e/playwright/install.spec.ts` — install flow against worldmonitor + cyberchef
- **Create:** `/home/leo/Claude/os8/tests/e2e/playwright/dev-import.spec.ts` — dev-import flow against a small public repo (e.g. a hand-controlled "test fixture" repo at `os8ai/playwright-fixtures`)
- **Create:** `/home/leo/Claude/os8/tests/e2e/playwright/native-app.spec.ts` — verifies a native React app still works end-to-end
- **Create:** `/home/leo/Claude/os8/tests/e2e/playwright/scoped-api.spec.ts` — verifies external apps' calls through `_os8/api/*` work (exercises PR 4.6 strict middleware)
- **Modify:** `/home/leo/Claude/os8/package.json` — add `@playwright/test` + `playwright-electron` (or `electron-playwright-helpers`) devDependencies
- **Modify:** `/home/leo/Claude/os8/.github/workflows/test.yml` — add `e2e` job that runs Playwright suite (gated to a separate matrix entry to keep unit tests fast)
- **Create:** `/home/leo/Claude/os8/tests/e2e/playwright.config.ts` — config: timeout 120s; one project per OS

### Setup pattern

```ts
// tests/e2e/playwright/setup.ts
import { _electron as electron, Browser, Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export async function bootOs8(opts: { os8Home?: string } = {}) {
  const home = opts.os8Home || await fs.mkdtemp(path.join(os.tmpdir(), 'os8-e2e-'));
  await fs.mkdir(home, { recursive: true });

  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..', '..')],
    env: {
      ...process.env,
      OS8_HOME: home,
      OS8_TELEMETRY_OPT_IN: 'false',           // never send test telemetry
      OS8_LOG_LEVEL: 'warn',
    },
    timeout: 30_000,
  });

  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await window.waitForSelector('#appGrid');     // shell-ready signal
  return { app, window, home };
}

export async function closeOs8(app: Browser, home: string) {
  await app.close();
  await fs.rm(home, { recursive: true, force: true });
}
```

### Install spec — pattern

```ts
// tests/e2e/playwright/install.spec.ts (skeleton — full file ~150 LOC)
test('Verified install: worldmonitor renders end-to-end', async () => {
  const { app, window, home } = await bootOs8();
  try {
    await window.click('[data-action="open-catalog-browser"]');
    await window.fill('[data-search]', 'worldmonitor');
    await window.click('[data-app-card="worldmonitor"]');
    await window.click('[data-action="install"]');
    await expect(window.locator('.install-plan-modal__name')).toHaveText(/World Monitor/);
    await window.click('[data-action="approve-install"]');
    // 5-min timeout for cold npm install
    await window.waitForFunction(() =>
      document.querySelector('.install-plan-modal__state')?.textContent?.includes('installed'),
      { timeout: 5 * 60 * 1000 });
    await expect(window.locator('[data-app-slug="worldmonitor"]')).toBeVisible();
    await window.locator('[data-app-slug="worldmonitor"]').dblclick();
    const url = await window.locator('.tab.active').getAttribute('data-url');
    expect(url).toMatch(/^http:\/\/worldmonitor\.localhost:8888/);
  } finally { await closeOs8(app, home); }
});
```

### Scoped-API spec (PR 4.6 gate) — patterns

The scoped-api suite uses `app.evaluate(({ BrowserWindow }) => …)` to reach into the external app's BrowserView and run code there:

| Test | Setup | Assertion |
|---|---|---|
| `window.os8.blob.write` round-trip | install fixture declaring `blob.readwrite`; in BrowserView: `await window.os8.blob.write('k', new Blob(['hi'])); return (await (await window.os8.blob.read('k')).text())` | result is `'hi'` |
| Undeclared capability returns 403 | fixture declaring only `blob.readonly`; call `.write(...)` | rejects with 403; SDK throws clear "capability not granted" error |
| Strict mode: native React app `fetch('/api/apps/<id>/blob/x')` | flip middleware strict; native app calls without header | 200 (origin-based allowlist) |
| Strict mode: external Origin header to `/api/apps` | spawn out-of-harness curl with `Origin: http://attacker.example` | 403 |
| Strict mode: in-process call without internal token | server-side `fetch('http://localhost:8888/api/apps')` | 403 |
| Strict mode: in-process call WITH internal token | same call with `X-OS8-Internal-Token: ${secret}` | 200 |

### CI integration

```yaml
# .github/workflows/test.yml — addition
e2e:
  needs: [test]               # only run if unit tests pass
  strategy:
    fail-fast: false
    matrix:
      os: [macos-14, ubuntu-22.04, windows-2022]
  runs-on: ${{ matrix.os }}
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with: { node-version: '22' }
    - run: npm ci
    - run: node tools/rebuild-native.js
    - run: npx playwright install chromium       # not strictly needed (Electron uses bundled Chromium)
    - run: npm run test:e2e
      env:
        OS8_E2E_TIMEOUT: 600000
        OS8_E2E_FIXTURES_REPO: os8ai/playwright-fixtures
```

### Fixtures repo

Create a small public repo `os8ai/playwright-fixtures` containing minimal apps used by the E2E suite (one Vite, one Streamlit, one static, one Docker). Pin to an SHA in the test config so an upstream change doesn't break CI. This is the "test catalog" — separate from the user-facing catalog because we want maximum control + minimum surface.

### Smoke gate (recursive!)

The harness itself needs a smoke before it's trusted. Before declaring 4.10 shipped:

1. Run the harness against the current `main` (no PR 4.6, no other Phase 4 changes). Suite passes.
2. Run the harness against a branch with PR 4.6's strict-mode flip applied. Suite passes (this is the actual gate for 4.6).
3. Run the harness against all three OSes in CI. Pass on macOS + Linux required; pass on Windows preferred. (Windows can be flaky in early Playwright-Electron versions — accept some flake initially with a documented retry.)

### Tests

The PR's tests **are** Playwright tests. Meta-tests for the harness setup itself:

`tests/e2e/playwright/__tests__/setup.test.ts` — verifies `bootOs8` produces a usable window in <30s.

### Acceptance criteria

- `npm run test:e2e` runs locally on macOS + Linux + Windows.
- CI matrix includes E2E job; gates `main` merge after PR 4.10 lands.
- Suite covers: Verified install (worldmonitor + cyberchef), Dev-Import install, native React app load, scoped capability call (success + 403), strict-mode origin allowlist (PR 4.6 gate).
- Suite runtime: <15 min total per OS (acceptable for a "needs:" gate that runs after fast unit tests).
- Failures are diagnostic — Playwright's screenshot-on-failure + HTML reporter wired.

### Cross-platform notes

- Playwright-Electron supports all three OSes but Windows occasionally requires extra `--no-sandbox` style flags. The harness handles this in `bootOs8`.
- File-system paths in test fixtures use `path.join` everywhere.
- BrowserView introspection via `app.evaluate` uses Electron's main-process API — identical across OSes.

### Spec deviations

- **None** — this PR builds the spec/§11/phase-3-plan §7.6 candidate verbatim.

### Depends on

PR 1.16 (install pipeline), PR 1.19 (BrowserView launch), PR 3.1 (dev-import flow), PR 4.7 (MCP wildcards — not strictly required but the suite covers wildcard grants if 4.7 is in tree). Independent of PR 4.4/4.5/4.8/4.9. **Gates PR 4.6.**

### Open sub-questions

1. **Should the harness also drive the install plan modal's per-capability toggles (PR 3.2)?** Yes — toggle every capability, ack, install, verify the resulting `apps.manifest_yaml` reflects the toggles. Adds ~50 lines; ship as part of this PR.
2. **Should we run the harness on every PR or only on PRs touching install-relevant paths?** All PRs initially (catches unexpected coupling); add path filters later if CI cost is a concern.

---

## PR 4.11 — Migration `0.6.0-app-store-telemetry.js`

**Goal.** Foundation for PR 4.4 (telemetry queue) and PR 4.2 (auto-update settings keys). Adds the `app_telemetry_events` table and seeds the new settings keys with safe defaults. Bumps `package.json` version to `0.6.0`.

### Files

- **Create:** `/home/leo/Claude/os8/src/migrations/0.6.0-app-store-telemetry.js`
- **Modify:** `/home/leo/Claude/os8/package.json` — version `0.5.x` → `0.6.0`
- **Create:** `/home/leo/Claude/os8/tests/migrations/0.6.0.test.js`

### Migration

```js
// /home/leo/Claude/os8/src/migrations/0.6.0-app-store-telemetry.js
module.exports = {
  version: '0.6.0',
  description: 'App Store v1.1: telemetry events queue + auto-update settings defaults',
  async up({ db, logger }) {
    // 1. Telemetry events queue (offline-first; flushed by AppTelemetry).
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_telemetry_events (
        id          TEXT PRIMARY KEY,
        kind        TEXT NOT NULL,
        payload     TEXT NOT NULL,           -- JSON; sanitized at write time
        created_at  TEXT NOT NULL,
        sent_at     TEXT
      );
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_telemetry_events_pending ON app_telemetry_events(sent_at) WHERE sent_at IS NULL;`);

    // 2. Settings defaults — only seed if not already set, so user choices persist.
    const seed = (key, value) => {
      const existing = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      if (!existing) {
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
      }
    };
    seed('app_store.telemetry.opt_in', 'false');         // strict opt-in; consent moment in PR 4.4 flips
    seed('app_store.telemetry.consent_shown', 'false');  // first-install modal triggers if 'false'
    seed('app_store.auto_update.notify_on_apply', 'true'); // toast when auto-update lands
    seed('_internal_call_token',                          // PR 4.6 in-process trust token
      require('crypto').randomBytes(32).toString('hex'));

    logger?.info('Migration 0.6.0: telemetry queue + auto-update defaults applied');
  }
};
```

### Test

```js
// tests/migrations/0.6.0.test.js
const Database = require('better-sqlite3');
const migration = require('../../src/migrations/0.6.0-app-store-telemetry');

test('0.6.0 migration is idempotent', async () => {
  const db = new Database(':memory:');
  // Seed prior schema (mimic 0.5.x state).
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);`);

  await migration.up({ db, logger: console });

  // Verify table + indexes + seeds.
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='app_telemetry_events'`).all();
  expect(tables.length).toBe(1);

  const opt = db.prepare(`SELECT value FROM settings WHERE key = 'app_store.telemetry.opt_in'`).get();
  expect(opt.value).toBe('false');

  // Re-run.
  await migration.up({ db, logger: console });
  // Still one table, still one row per setting key.
  expect(tables.length).toBe(1);
});

test('0.6.0 migration preserves existing telemetry opt-in if set', async () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);`);
  db.prepare(`INSERT INTO settings (key, value) VALUES ('app_store.telemetry.opt_in', 'true')`).run();

  await migration.up({ db, logger: console });

  const opt = db.prepare(`SELECT value FROM settings WHERE key = 'app_store.telemetry.opt_in'`).get();
  expect(opt.value).toBe('true');     // user choice respected
});
```

### Acceptance criteria

- `npm start` against an existing 0.5.x DB upgrades cleanly; re-run is a no-op.
- Fresh installs see `app_telemetry_events` table created.
- `app_store.telemetry.opt_in` defaults to `false` (strict opt-in).
- `_internal_call_token` is generated once and never overwritten.

### Cross-platform notes

None — pure SQLite migration.

### Spec deviations

- **`_internal_call_token`** is new — supports PR 4.6's in-process call mechanism. Stored as a settings row (existing pattern). Documented above.

### Depends on

None — foundation PR.

### Open sub-questions

None.

---

## 4. Cross-repo coordination

Phase 4 touches all four repos. Dependencies and sequencing:

```
                                ┌──────────────────────────────────────┐
                                │  os8ai/os8-sdk-types (NEW)           │
                                │  PR 4.9: published 1.0.0             │
                                │  Depends on: 4.7 (SDK shape stable)  │
                                └──────────────────────────────────────┘
                                          ↑
┌──────────────────────────────────┐    │    ┌──────────────────────────────────┐
│  os8ai/os8 (desktop)             │ generates│  os8ai/os8dotai (website)        │
│                                  │ types from │                                  │
│  4.11 (migration 0.6.0)          │    │    │  4.5 (telemetry ingest)          │
│  4.1 (streaming logs)            │    │    │  4.3 ("update available" badge)  │
│  4.2 (auto-update)               │ ───┼────│  ↑                               │
│  4.4 (telemetry emitter) ←──────┼────┴────│  POSTs to /api/apps/telemetry    │
│  4.6 (requireAppContext strict)  │         │  POSTs to /installed-apps        │
│  4.7 (MCP wildcards)             │         │                                  │
│  4.8 (Windows CI)                │         └──────────────────────────────────┘
│  4.10 (Playwright harness)       │
└──────────────────────────────────┘
                                          ↓ schema-match drift checks
┌──────────────────────────────────┐    ┌──────────────────────────────────────┐
│  os8ai/os8-catalog               │    │  os8ai/os8-catalog-community         │
│                                  │    │                                      │
│  4.7 (schema MCP wildcard)       │ ←──│  4.7 (schema MCP wildcard)           │
│  4.8 (Windows CI added)          │    │  4.8 (Windows CI added)              │
└──────────────────────────────────┘    └──────────────────────────────────────┘
```

### Sequencing constraints

| Constraint | Reason | Order |
|---|---|---|
| 4.11 (migration) before 4.4 (telemetry) | telemetry needs the events table | 4.11 → 4.4 |
| 4.11 (migration) before 4.2 (auto-update notify default) | seeds the notify setting | 4.11 → 4.2 |
| 4.5 (os8.ai ingest) before 4.4 (desktop emitter) | endpoint must exist or emitter retries forever; safer to deploy ingest with zero traffic first | 4.5 → 4.4 |
| 4.7 (MCP wildcards) before 4.9 (npm package) | .d.ts must include wildcard syntax | 4.7 → 4.9 |
| 4.10 (E2E harness) before 4.6 (strict flip) | strict flip is the harness's primary gate | 4.10 → 4.6 |
| 4.7 schema change in `os8` desktop before catalog repos | desktop's `appspec-v1.json` is canonical; community fetches via schema-match | 4.7 (os8) → 4.7 schema sync (catalog repos) |
| 4.8 (Windows CI) catalog repos can land any time | independent | parallel |
| 4.3 (os8.ai badge) needs no desktop change | independent | parallel |
| 4.1 (streaming logs) before 4.2 (auto-update) | smoke gate for log streaming validates against an install before auto-update reuses the path | 4.1 → 4.2 |

### Suggested merge order (least-risky first)

```
Week 1:
  4.11 (migration foundation)                — desktop, no dependencies
  4.5 (os8.ai ingest endpoint)              — website, no traffic yet
  4.1 (streaming install logs)              — desktop, smoke gates 4.2
  4.7 (MCP wildcards)                       — desktop + 2× catalog
  4.10 (Playwright harness scaffold + tests) — desktop, must include strict-mode tests

Week 2:
  4.2 (auto-update opt-in)                  — desktop, after 4.1's smoke
  4.4 (telemetry emitter)                   — desktop, depends on 4.5 + 4.11
  4.9 (npm package)                         — new repo + publish, after 4.7

Week 3:
  4.3 (os8.ai update badge)                 — website
  4.8 (Windows CI promotion)                — desktop + 2× catalog
  4.10 (Playwright harness — full suite)     — desktop, gates 4.6
  4.6 (requireAppContext strict flip)        — desktop, after 4.10 passes

Doc PRs throughout:
  4.D2 (auto-update.md)                     — files alongside 4.2
  4.D3 (deferred-items.md decisions log)    — files as items close
  4.D1 (spec + master-plan close-out)       — files at end of phase
```

This order minimizes stalls (each week has independent work for parallel reviewers) and keeps risky changes (4.6) last.

---

## 5. Migrations

| Migration | Version | What it adds | Why |
|---|---|---|---|
| `0.6.0-app-store-telemetry.js` (PR 4.11) | 0.6.0 | `app_telemetry_events` table; `app_store.telemetry.opt_in` (default false); `app_store.telemetry.consent_shown` (default false); `app_store.auto_update.notify_on_apply` (default true); `_internal_call_token` (random hex) | Foundation for PRs 4.4 and 4.2; opt-in defaults respect spec §10 privacy posture |

Schema migrations on the os8.ai side:

| Migration | Repo | What it adds | Why |
|---|---|---|---|
| `<ts>_install_telemetry/migration.sql` (PR 4.5) | os8ai/os8dotai | `InstallEvent` model; `InstallEventDaily` model; `App.installSuccessCount/installFailCount/installOverriddenCount/lastInstallEventAt` columns | Stores telemetry; per-app counters surface in the dashboard |
| `<ts>_installed_apps/migration.sql` (PR 4.3) | os8ai/os8dotai | `InstalledApp` model with `(userId, appSlug)` unique index | Enables "update available" badge on detail page |

Both Prisma migrations apply via `npx prisma migrate deploy` at deploy time on Vercel; existing Phase 0 migration pattern unchanged.

No template migrations (no shell-owned template file changes in Phase 4). No data migrations (no field renames, no value rewrites).

---

## 6. Smoke gates

Phase 3 introduced the principle (recorded in `MEMORY.md` as `feedback_smoke_test_real_apps.md`): **before declaring an adapter or trust-boundary change shipped, smoke against a real third-party app — not just the minimum-viable fixture under `tests/fixtures/`.** Phase 4 carries this forward.

### Smoke gates this phase

| Gate | What's smoked | Real app(s) | Gates merge of |
|---|---|---|---|
| **G1** Streaming install logs render correctly during a multi-minute install | PR 4.1 — log buffer + auto-scroll + stderr coloring | Phase 3.5.3 Streamlit fixture (whichever lands; e.g. `whitphx/streamlit-webrtc-example`) | PR 4.2 |
| **G2** Verified-channel auto-update applies cleanly with no user edits | PR 4.2 — `processAutoUpdates` end-to-end, including toast notification | worldmonitor v2.5.23 → next minor (test bump in `os8ai/os8-catalog`) | PR 4.D1 close-out |
| **G3** Strict requireAppContext does not break native React apps or Phase 3.5 fixtures | PR 4.6 — middleware flip end-to-end | All Phase 3.5 fixtures + every native React app in `~/os8/apps/`; OS8 home grid | PR 4.6 itself (gated by PR 4.10) |
| **G4** Windows install flow works end-to-end | PR 4.8 — NSIS installer + protocol handler + DNS resolution | worldmonitor on `windows-2022` | Doc PR 4.D1 |

### Gate ordering

```
4.1 ──→ G1 (Streamlit smoke) ──→ 4.2
                                   ↓
                                  G2 (worldmonitor bump smoke) ──→ 4.D1

4.10 ──→ G3 (strict mode smoke against full app inventory) ──→ 4.6 ──→ 4.D1

4.8 ──→ G4 (Windows installer smoke) ──→ 4.D1
```

Each gate corresponds to a manual checklist (mirroring phase-3-plan §7.2's 7-step pattern). Mechanical CI catches the easy regressions; the manual smoke catches the architectural ones.

### Why these gates and not others

- **No gate for 4.3 (os8.ai update badge).** Pure UI; existing Vercel preview is enough.
- **No gate for 4.4/4.5 (telemetry).** No way to "smoke" telemetry beyond unit tests + 24h of soak time on a real instance. PR 4.5's dashboard surfaces the data once it flows; if it doesn't flow as expected, it's a fix-forward situation.
- **No gate for 4.7 (MCP wildcards).** Unit-test-able; depends on a manifest that uses the syntax (a future catalog manifest will exercise it).
- **No gate for 4.9 (npm package).** Drift-check CI is the gate; user-facing test is "install it, autocomplete works."
- **No gate for 4.11 (migration).** Standard migration test pattern (PR 4.11's own tests verify idempotency).

---

## 7. Risks and open questions

### Items needing user decision before / during execution

1. **Should we promote any items from `app-store-deferred-items.md` into Phase 4?**

   The user's framing was explicit: *"Do not pull items from it into Phase 4 unless the master plan or spec already treats them as Phase 4 work, or you have a strong reason to promote one."* I am promoting **five** items, all justified by spec §11 or by phase-3-plan callouts:

   | Deferred item | Promoted as | Justification |
   |---|---|---|
   | #6 Stricter `X-OS8-App-Context` header enforcement | PR 4.6 | Spec §11 open #1 trigger condition met (Phase 3 has been stable for ≥1 sprint); flip is one-line + an origin allowlist |
   | #8 Streaming install logs in modal | PR 4.1 | Phase-3-plan §7.5 explicitly calls this a "Phase 4 candidate" |
   | #9 Playwright E2E install harness | PR 4.10 | Phase-3-plan §7.6 explicitly calls this a "Phase 4 candidate" |
   | #18 Per-adapter install success/fail telemetry | PR 4.4 + 4.5 | Spec §8 "Future" calls this out; trigger is "any time we want data-driven adapter prioritization" — Phase 3.5's hotfix cascade demonstrated the need |
   | #20 MCP wildcard capability syntax (`mcp.<server>.*`) | PR 4.7 | Spec §11 open #4; Phase 3.2's modal already deferred wildcards because the per-tool toggle UI didn't scale |

   Items I am **not** promoting (kept on the deferred list):
   - #1, #2, #4, #5, #7 (Trust & Security): all need their trigger conditions to actually fire before promotion is justified
   - #10, #11, #12, #13 (Lifecycle): #10 depends on user reports we don't have yet; #11 depends on #10; #12 needs verification first (may already be in tree); #13 is incremental polish
   - #14, #15, #16 (Catalog & moderation): #14 awaits PR backlog data; #15 should ideally land before a real revocation; #16 is polish
   - #17, #19 (Telemetry & observability): #17 promotes if 4.4 surfaces 429s in the wild; #19 promotes when curators are surprised
   - #21, #22, #23 (Runtime adapters): all V1 design decisions; no new signal demands a flip
   - #24, #25, #26, #27, #28, #29, #30, #31 (UX & polish): polish; promotes opportunistically, not by phase
   - E1–E5 (V1 exclusions): these are intentional v1 invariants, not deferrals

   The five items I'm promoting all have an explicit spec or phase-plan signal pointing at Phase 4. **If the human reviewer prefers a tighter Phase 4 scope, the natural cut points are:**
   - Drop 4.4 + 4.5 (telemetry) — Phase 4 ships without observability
   - Drop 4.6 (strict flip) + 4.10 (E2E harness) — defer the trust-boundary tightening to Phase 5
   - Drop 4.8 (Windows CI) — defer cross-platform expansion to Phase 5

   Or any combination. The most-load-bearing PRs are 4.1 (streaming logs), 4.2 (auto-update), 4.7 (MCP wildcards) — these three plus 4.11 (migration) are arguably the "Phase 4 minimum viable scope."

2. **Telemetry event schema — is the privacy contract acceptable?**

   PR 4.4 sends adapter / framework / channel / slug / commit / failure-fingerprint / duration / OS / arch / anonymous client ID. We never send hostname, username, paths, env vars, or raw log lines. The failure fingerprint is a 16-char SHA prefix of the last stderr line (with paths/numerics stripped). Client IDs are random UUIDs that the user can rotate.

   **The decision is whether this is the right opt-in default.** PR 4.4 ships with default ON (consent moment surfaces it; user can un-check before approving). The deferred-items doc tracks the alternative (default OFF) if we change our mind. Decision lives with the user.

3. **TypeScript SDK package strategy: in-folder + npm, or one-or-the-other?**

   PR 4.9 picks **both** (in-folder `.d.ts` per PR 1.21 stays; `@os8/sdk-types` npm package is added). Cost is one extra public repo + a release pipeline. Benefit is external-IDE workflows work without scaffolding inside `~/os8/apps/`. **Decision is whether we want the npm package's surface area** (a public `os8ai/os8-sdk-types` repo plus npm publish access plus a release cadence). If we want to keep external surface area minimal in v1.1, drop 4.9.

4. **Auto-update restart policy — restart, never restart, or smart restart?**

   PR 4.2 picks **smart restart** (restart only if `package.json` / lockfile / `start.argv`-referenced binary changed). The alternative "always restart" is more conservative but interrupts users mid-task. The alternative "never restart" risks a stale running process hiding the updated code. **Smart restart is a judgment call** that needs validation in the worldmonitor smoke (G2). If it goes wrong, fallback to "always restart" with a notification.

5. **Playwright harness scope — fixtures-only or real catalog apps?**

   PR 4.10 uses fixtures from `os8ai/playwright-fixtures` (a controlled repo) plus the actual Verified-channel apps (worldmonitor, cyberchef). Real-app smoke is more realistic but slower and depends on upstream stability. **Decision is the balance** — initial proposal: fixtures cover scoped-API and dev-import; real apps cover install end-to-end. Tighten or loosen based on CI runtime.

6. **Windows CI strictness during transition.**

   PR 4.8 promotes Windows-2022 to gating. **Some existing tests may not pass on first run.** Spec deviation #11/#12 doesn't specify how to handle a Windows-only test failure during migration. **Decision: which tests can be `test.skip` on Windows initially without violating the gate's intent.** Suggested rule: only the Playwright harness (PR 4.10) is allowed `test.skip(({ os }) => os === 'windows', ...)` for first-merge; everything else must pass on Windows or get a fix in PR 4.8 itself.

### Spec ambiguities surfaced

These came up while drafting the plan; flagging for the human reviewer.

7. **Spec §6.9 says "auto-update opt-in for Verified channel only." Implicit but unstated: what about Community-channel apps that the user explicitly trusts?** Currently no path. Phase 4 stays with spec; Phase 5 conversation if a community manifest's curator pool reaches Verified-equivalent trust.

8. **Spec §6.3.2 lists capabilities but doesn't define the wildcard semantics.** PR 4.7 picks "wildcard grants all current AND future tools on the server." The alternative ("snapshot at install time") is more conservative but means re-install on every server tool addition. Picked the more user-friendly interpretation; documented in PR 4.7 + the spec update doc PR (4.D1).

9. **Spec §8 lists "telemetry on install success/fail" as Future without specifying what "telemetry" includes.** PR 4.4 + 4.5 define an event schema; the schema is the spec proposal. PR 4.D1 (doc) updates spec §8 to reference the implemented schema.

10. **Spec §11.6 (lockfile recognition for `bun.lockb`) is "presence-only check."** Phase 4 doesn't change this. Surfacing for the human reviewer that it's still a known limitation.

11. **Spec §6.6 mentions Windows hosts-entry prompt with UAC elevation but doesn't detail the implementation.** PR 1.16 wired the prompt; PR 4.8 verifies it on `windows-2022`. PR 4.D1 should update spec §6.6 with the implemented mechanism (NSIS post-install + first-run dialog).

12. **Spec §11 open #2 (`/apps` page caching) hasn't surfaced a problem in production.** Not promoted to Phase 4. Document as "watching" in PR 4.D1.

13. **Spec §10 risk "External app reads OS8's env vars" is mitigated by sanitized env (PR 1.10).** Phase 4 doesn't touch this. The strict requireAppContext flip (PR 4.6) tightens an adjacent boundary but doesn't help the env-var case.

14. **Auto-update merge UX for non-trivial conflicts (spec §11 open #11) was supposedly resolved in PR 1.25.** Phase 4 assumes it works; PR 4.10's harness should add a test that triggers a conflict and verifies the merge UI surfaces. If the assumption is wrong, that's a Phase 5 cleanup.

### Decisions captured during planning (record in 4.D1)

| # | Decision | Resolved in |
|---|---|---|
| 1 | Phase 4 scope is "maturation + observability" — derived from spec §11 open items + phase-3-plan §7.5/7.6 callouts; not arbitrary | This document §1 |
| 2 | Five deferred-items.md items promoted with explicit justification | This document §7 |
| 3 | Telemetry default is opt-in with consent moment at first install | PR 4.4 |
| 4 | Telemetry sends fingerprints, never raw lines | PR 4.4 |
| 5 | Telemetry client ID is hashed twice (random UUID + server-side HMAC salt) | PR 4.4 + PR 4.5 |
| 6 | Auto-update notification is a toast, not a modal | PR 4.2 |
| 7 | Auto-update restart policy: smart (restart only on start-relevant file changes) | PR 4.2 |
| 8 | `requireAppContext` strict mode uses origin-based allowlist + in-process token | PR 4.6 |
| 9 | `mcp.<server>.*` grants current and future tools (server is the trust boundary) | PR 4.7 |
| 10 | `mcp.*.*` and `mcp.*` are explicitly rejected at validation | PR 4.7 |
| 11 | TS SDK ships as both in-folder `.d.ts` and `@os8/sdk-types` npm package | PR 4.9 |
| 12 | Windows-2022 promoted to gating CI; existing tests fixed in PR 4.8; harness allowed `test.skip` initially | PR 4.8 + PR 4.10 |
| 13 | E2E harness gates `requireAppContext` strict flip; harness must pass on macOS + Linux before 4.6 merges | PR 4.10 → PR 4.6 |
| 14 | New Prisma models on os8.ai: `InstallEvent`, `InstallEventDaily`, `InstalledApp` | PRs 4.3 + 4.5 |
| 15 | Migration `0.6.0-app-store-telemetry.js` is the only desktop schema change in Phase 4 | PR 4.11 |

---

## 8. Phase 4 acceptance criteria

Phase 4 ships when ALL of:

1. **Streaming install logs work end-to-end.** A real Streamlit install (Phase 3.5.3 fixture) shows live log output in the modal; download-logs writes a complete `.log` file.
2. **Auto-update opt-in works for Verified-channel apps with no user edits.** worldmonitor bump smoke (G2) passes; toast notifies; app continues running with new content.
3. **os8.ai detail page shows update-available badges for signed-in users.** Real flow: user installs worldmonitor; PR for newer version merges; within 24h heartbeat the badge appears on the detail page.
4. **Telemetry flows from desktop → os8.ai dashboard.** A test install from a real OS8 instance produces events visible at `/internal/telemetry/install` within minutes.
5. **`requireAppContext` strict mode does not regress.** All Phase 3.5 fixtures + native React apps work; arbitrary external requests get 403; rollback env var works.
6. **`mcp.<server>.*` wildcard works.** A manifest declaring `mcp.gh.*` can call any `gh.*` tool (current and future); manifest with `mcp.*.*` is rejected by the validator.
7. **Windows-2022 is gating across all four repos.** CI fails on Windows-only regressions; Windows installer registers `os8://`; manual Windows smoke against worldmonitor passes.
8. **`@os8/sdk-types@1.0.0` is published.** External app authors can `npm install -D @os8/sdk-types` and get autocomplete.
9. **Playwright E2E harness covers install + scoped-API + native-app flows on macOS, Linux, and Windows.** Suite runs in CI; gates `main` merges.
10. **Migration `0.6.0` upgrades cleanly from `0.5.x`.** Idempotent; preserves prior settings.

### What flows out of Phase 4

- **OS8 has data on what's failing in the wild.** PR 4.5's dashboard converts the Phase 3 hotfix-by-anecdote workflow into a hotfix-by-fingerprint-cluster workflow.
- **Updates flow without user friction (when safe).** Verified-channel apps that the user hasn't edited get patches automatically; opt-in by user, gated by absence of user edits.
- **Trust boundary is genuinely tight.** Strict `requireAppContext` removes the "no header → trust" gap; origin allowlist is the explicit policy.
- **Cross-platform footing.** Windows is no longer "best-effort" — it's gated and tested.
- **External workflow is friendly.** TypeScript developers building external apps get a published types package.
- **Regression catch-rate goes up.** Playwright harness catches install/scope/native-app regressions on PR-merge instead of post-deploy.

### What does **not** carry forward (Phase 5+ candidates)

- **`surface: terminal` and `surface: desktop-stream`** — V1 exclusions per spec §9; deferred.
- **Hard-block on MAL-* malware findings** — deferred-items #2; advisory model per spec §6.5 stays unless telemetry from PR 4.5 shows users routinely overriding MAL-* warnings.
- **Per-app reputation surfacing on community cards** — deferred-items #16; depends on community channel volume.
- **App revocation flow** — deferred-items #15; should land before any real revocation event.
- **Three-way merge UI for updates with user edits** — deferred-items #10; depends on user feedback.
- **OAuth-gated capabilities (multi-tenant)** — deferred-items #3; only matters for multi-user deployments.
- **GitHub raw asset rate-limit monitoring (RUM)** — deferred-items #17; promotes if PR 4.5 telemetry shows 429s.

---

## 9. Decisions log (Phase 4)

Captured here as a one-line index so reviewers can find where each lives. Mirrors the Phase 3 §5 pattern.

| # | Decision | Resolved in |
|---|---|---|
| 1 | Phase 4 theme: maturation + observability | This doc §1 |
| 2 | Five deferred-items promoted with justification (#6, #8, #9, #18, #20) | This doc §7.1 |
| 3 | Streaming install logs use buffered SSE relay (200ms cadence) | PR 4.1 |
| 4 | Adapter `onLog` callbacks emit `(stream, line)` for stderr coloring | PR 4.1 |
| 5 | Docker pull progress parsed into compact "layer: progress%" lines | PR 4.1 |
| 6 | Auto-update restart policy: smart (start-relevant files only) | PR 4.2 |
| 7 | Auto-update notification: toast with Open action; auto-dismiss 6s | PR 4.2 |
| 8 | Per-app settings flyout: right-click menu → toggle Auto-Update + Keep Running + Uninstall | PR 4.2 |
| 9 | os8.ai `InstalledApp` model: `(userId, appSlug)` unique; daily heartbeat | PR 4.3 |
| 10 | "Update available" badge renders only when signed-in user has the app installed | PR 4.3 |
| 11 | Telemetry opt-in defaults ON at first-install consent moment; permanent toggle in Settings | PR 4.4 |
| 12 | Telemetry never sends raw log lines or paths — only fingerprints | PR 4.4 |
| 13 | Telemetry sanitizer is allowlist-based (defense against future field additions) | PR 4.4 |
| 14 | Failure fingerprint: SHA-256 of `errorLine.replace(/[\d/\\]/g, '').slice(0, 256)` | PR 4.4 |
| 15 | Telemetry batch size 25; flush interval 60s; offline queue at `app_telemetry_events` | PR 4.4 |
| 16 | os8.ai server-side: re-hash incoming clientId with HMAC + secret salt | PR 4.5 |
| 17 | Per-app counters (`installSuccessCount` etc.) increment on event ingest | PR 4.5 |
| 18 | Daily rollup runs at 01:05 UTC; retains raw events 30 days | PR 4.5 |
| 19 | Internal dashboard at `/internal/telemetry/install`, curator-allowlist gated | PR 4.5 |
| 20 | `requireAppContext` strict: origin-based allowlist (bare-localhost = trusted) + in-process token escape hatch | PR 4.6 |
| 21 | Rollback env var `OS8_REQUIRE_APP_CONTEXT_PERMISSIVE=1` restores v1 behavior | PR 4.6 |
| 22 | E2E harness (PR 4.10) is the gate for the strict-mode flip | PR 4.6 + PR 4.10 |
| 23 | `mcp.<server>.*` grants current and future tools on `<server>` | PR 4.7 |
| 24 | `mcp.*.*` and `mcp.*` rejected at JSON Schema validation | PR 4.7 |
| 25 | Modal renders wildcard grants as "all current and future tools on `<server>`" | PR 4.7 |
| 26 | Windows-2022 promoted to gating CI matrix on all four repos | PR 4.8 |
| 27 | `electron-builder` Windows config + NSIS installer + protocol handler entries | PR 4.8 |
| 28 | TS SDK strategy: ship both in-folder `.d.ts` and `@os8/sdk-types` npm package | PR 4.9 |
| 29 | `@os8/sdk-types` follows independent semver; desktop has `peerDependencies` constraint | PR 4.9 |
| 30 | SDK drift-check CI fails when preload + .d.ts diverge | PR 4.9 |
| 31 | Playwright-Electron harness lives at `tests/e2e/playwright/`; runs on all 3 OSes | PR 4.10 |
| 32 | Test fixtures repo: `os8ai/playwright-fixtures` (separate from user-facing catalog) | PR 4.10 |
| 33 | Migration `0.6.0` adds `app_telemetry_events` + 4 settings keys + `_internal_call_token` | PR 4.11 |
| 34 | Migration preserves user-set `app_store.telemetry.opt_in` (won't overwrite to false) | PR 4.11 |

---

## 10. Updates to MEMORY.md after Phase 4

When the relevant PRs land, the project memory should be updated:

- After PR 4.5 deploys: add a `reference_telemetry_dashboard.md` entry pointing at `/internal/telemetry/install` and noting the curator-allowlist gating.
- After PR 4.6 lands: update `project_app_store_advisory_gating.md` to note that the trust-boundary tightening is now in place; advisory gating posture for **scan findings** is unchanged but the trust boundary itself is no longer permissive.
- After PR 4.8 lands: update `feedback_smoke_test_real_apps.md` "go-to smoke targets" section to add a Windows row (worldmonitor on `windows-2022`).
- After PR 4.10 lands: add a `reference_e2e_harness.md` entry pointing at `tests/e2e/playwright/` so future agents know the harness exists before writing redundant smoke logic.

---

*End of plan.*
