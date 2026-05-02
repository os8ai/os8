# Resume prompt — Phase 3.5.4 (Gradio) + 3.5.5 (Docker)

Copy everything below and paste it as your first message to a fresh Claude
Code session in `/home/leo/Claude/os8`. The agent has no memory of prior work.

---

You're picking up Phase 3.5 of the OS8 App Store project. Three of the five
adapter smoke fixtures are done; two remain. **Your job is to ship 3.5.4
(Gradio) and 3.5.5 (Docker), in that order, following the same 7-step
pattern the prior three used.**

## Read these first, in order

1. **`/home/leo/Claude/CLAUDE.md`** — workspace and machine context
   (NVIDIA DGX Spark, Ubuntu 24.04, aarch64).
2. **`/home/leo/Claude/os8/CLAUDE.md`** — OS8 architecture, file layout,
   service catalogue, IPC, runtime adapters.
3. **`/home/leo/Claude/os8/docs/phase-3-plan.md` §7** — Phase 3.5 plan. The
   7-step pattern in §7.2 is the contract. §7.3.3 covers Gradio specifics
   and §7.3.4 covers Docker specifics.
4. **`/home/leo/.claude/projects/-home-leo-Claude-os8/memory/MEMORY.md`** —
   index into running auto-memory. Especially read:
   - `feedback_smoke_test_real_apps.md` — why these smokes exist
   - `project_phase_3_hotfix_retrospective.md` — what each prior smoke surfaced
   - `project_app_store_phases.md` — what's done, what's pending

After reading, **`gh pr list --state merged --limit 8`** in
`/home/leo/Claude/os8` to confirm what's actually shipped (memory can lag
the repo by minutes-to-days; trust git over memory when they disagree).

## What's done

| # | Adapter | Fixture | PR(s) |
|---|---|---|---|
| 3.5.1 | Node / Vite | `koala73/worldmonitor@v2.5.23` | catalog #11 |
| 3.5.2 | Static | `gchq/CyberChef@v11.0.0` | catalog #12, os8 #26+#27 |
| 3.5.3 | Python / Streamlit | `streamlit/30days@2444b04` | community-catalog #2, os8 #29 |

Each smoke surfaced 4–11 hotfixes in the os8 repo before the install worked
end-to-end. Budget for that. The hotfixes from tonight (PR #29) include
several that benefit Gradio too: uv version bump (0.5.5→0.5.30 with
stale-cache detection), `--relocatable` venv, bare-`uv` rewrite to OS8's
managed binary, post-venv-create sanity check, BV-navigate-to-blank on
tab close. Read PR #29's body before starting Gradio — those notes tell
you what's already handled.

## What you're shipping

### Phase 3.5.4 — Python / Gradio

- **Adapter under test**: `src/services/runtime-adapters/python.js` (same
  module as Streamlit, but Gradio takes a different start path).
- **Key difference vs Streamlit**: Gradio binds its port via the app's
  Python code (`demo.launch(server_name="127.0.0.1", server_port=...)`)
  rather than a CLI flag. Most upstreams don't read the port from env or
  argv, so you'll likely need to set `GRADIO_SERVER_PORT` via manifest
  `env`, or override the start argv with a `python -c` shim.
- **Drafter expectation**: streamlit detection now also matches by
  filename (`streamlit_app.py`); Gradio's equivalent might be needed if
  upstream `requirements.txt` doesn't list `gradio`. The drafter already
  has Gradio dep-detection — verify it covers real-world apps.
- **Candidate criteria** (from §7.3.3):
  - Real Gradio demo, ≥1k stars
  - CPU-runnable (no GPU dependency)
  - ≤2 GB total disk after model download
  - Permissive license (MIT/Apache-2.0/BSD-3-Clause)
  - No API keys for basic page render
- **Where to find candidates**: HF Spaces gallery; `gradio-app`
  organization on GitHub; popular ML demos. Skip the official
  `gradio-hello` fixture — it's the minimal one we already smoked.

### Phase 3.5.5 — Docker

- **Adapter under test**: `src/services/runtime-adapters/docker.js`.
- **Schema**: AppSpec **v2** (`schemaVersion: 2`), requires
  `runtime.kind: docker`, `runtime.image`, `runtime.image_digest`,
  `runtime.internal_port`. Verified channel mandates digest pinning.
- **Three apps already in the verified catalog use docker** (`documenso`,
  `excalidraw`, `openwebui`) but predate the realistic-smoke pattern —
  Phase 2's docker fixture was minimal. You're validating against a real
  install on Linux/aarch64. One of those three may already work; if so,
  document it as the smoke and skip to memory updates. If not, pick a
  fresh candidate.
- **Candidate criteria** (from §7.3.4):
  - Real public Docker image with documented HTTP port and pinned digest
  - ≤2 GB image
  - Permissive license
  - Avoid n8n (typosquat blocklist; verified can list it but be deliberate)
- **Tooling needed on host**: Docker daemon. Verify with `docker info`
  before you start. If not running, that's a host-setup question for the
  user, not something to fix in code.

## The 7-step pattern (from `phase-3-plan.md §7.2`)

1. **Candidate selection** — propose 2–3, user picks. (Don't pick yourself.)
2. **First smoke install via Developer Import** — paste URL, install,
   observe.
3. **Hotfix cascade** — diagnose root cause for each surfaced bug, open a
   PR with a regression test, merge, retry. Steps 2 ↔ 3 loop until clean.
4. **Generalise / extract lessons** — was each fix a one-off, or
   architectural? Spec/memory updates as needed.
5. **Promote to verified catalog** — write `apps/<slug>/` with
   `manifest.yaml`, `icon.png`, `screenshots/`, `README.md`. CI must go
   green: schema, schema-match, slug-blocklist, upstream-domain,
   upstream-age, resolve-refs, lockfile-gate (where applicable).
   - **Verified channel** requires `dependency_strategy: frozen` (full
     lockfile). If the upstream lacks one, ship to community
     (`os8ai/os8-catalog-community`) with `strict` instead — that's what
     streamlit-30days did. Don't fight the schema.
6. **Update memory** — append to `feedback_smoke_test_real_apps.md`'s
   "go-to smoke targets" list and update `project_app_store_phases.md`.
7. **Commit + move on**.

## Critical lessons from prior smokes (don't relearn these)

- **Don't trust "install successful"**. After install, check the disk
  (`/home/leo/os8/apps/<id>/`) for the artefacts you'd expect (`.venv/`,
  `node_modules/`, build output). Tonight's smoke caught a uv silent-
  failure only because we added a post-venv-create sanity check.
- **Don't edit OS8 source while an install is running**. `main.js` has
  `electron-reloader` enabled in dev — saving a watched file restarts
  the Electron main process and kills the install pipeline mid-flight.
  Wait for the install to finish (or fail) before editing.
- **Add `console.log` diagnostics aggressively**. The install pipeline
  emits log events to the modal SSE stream, NOT the OS8 terminal. The
  Python adapter (PR #29) added `[python-adapter] +` lines for every
  command — replicate that pattern in the Docker adapter if it doesn't
  already have it.
- **CI's macOS `smoke.localhost` test fails on `main` itself** — this is
  a pre-existing flake (DNS resolution behaviour on GitHub's macOS
  runners). Don't chase it. Annotate the PR explaining and ship via
  `--squash --admin` like PRs #26, #27, #29.
- **Use `Leo <leo@os8.ai>` git identity** for commits in this repo (per
  `user_git_identity.md`). Set via:
  ```
  GIT_AUTHOR_NAME=Leo GIT_AUTHOR_EMAIL=leo@os8.ai \
  GIT_COMMITTER_NAME=Leo GIT_COMMITTER_EMAIL=leo@os8.ai \
  git commit -m ...
  ```
- **The user is final authority** for risk overrides during install. Scan
  surfaces; user decides. (See `project_app_store_advisory_gating.md`.)

## Verify state before acting

Run these in `/home/leo/Claude/os8` before writing any code:

```bash
git status                      # confirm clean working tree
git log --oneline -10           # see what just merged
gh pr list --state merged --limit 8
gh pr list --state open
docker info | head -5           # for Phase 3.5.5
ls /home/leo/os8/apps/          # what's currently installed locally
```

If anything is unexpected (uncommitted changes, open PRs you didn't
expect, branches not on `main`), **ask the user before proceeding**.
Don't reset, force-push, or delete branches without confirmation.

## Suggested order

1. **Verify state** (above).
2. **Read the four anchor docs** (CLAUDE.md ×2, phase-3-plan.md §7,
   MEMORY.md).
3. **Phase 3.5.4 (Gradio)** — propose 2–3 candidates, await user pick,
   run the 7-step pattern.
4. **Phase 3.5.5 (Docker)** — same pattern. Check whether one of the
   existing verified docker apps works as the smoke before picking a
   new candidate.
5. **Final close-out** — append to retrospective memory, mark Phase 3.5
   complete in `project_app_store_phases.md`, note any Phase 4 candidates
   that emerged.

## When to ask vs proceed

- **Ask**: anything destructive (force-push, branch deletion, repo
  history rewrite); credential exposure; any time you're surprised by
  state; selecting a smoke candidate (user picks from your shortlist).
- **Proceed**: routine commits/pushes within a feature branch, opening
  PRs, merging your own PR with `--squash --admin` after CI is green
  (or annotated as macOS-flake-only-failure), reading files, running
  tests, syncing local with origin/main.

The user has been steering this work all evening; default to brevity in
your updates and include concrete file paths + line numbers when you
reference code. End each response with what changed and what's next.
