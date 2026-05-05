# Auto-update for catalog apps

OS8 can apply updates to catalog apps (Verified + Community)
automatically — but only when you haven't edited them locally. This
page describes how to turn it on, what triggers an update, what
happens when an update conflicts with your local edits, and what to
do if something goes wrong.

## Per-channel defaults

The two catalog channels start from different defaults, reflecting
their different review postures:

| Channel | New-install default | Why |
|---|---|---|
| **Verified** | OFF (opt-in) | Curated, manually reviewed apps that change rarely. Default OFF preserves "user is final authority over what runs on their machine." |
| **Community** | ON (opt-out) | Lighter-review apps that churn faster. Default ON makes "forget about it" the dominant UX; conflicts with local edits still surface for manual resolution. |
| **Developer-Import** | n/a | No upstream catalog to sync from. Manual update only. |

You can change either channel's default in **Settings → App Store →
Auto-update defaults**. New defaults apply only to *new* installs;
existing apps keep whatever per-app setting they already have.

## Turning auto-update on (or off) for one app

1. **Right-click** an app icon on the home grid.
2. Choose **Settings…** from the context menu.
3. Toggle **Auto-update from catalog** to ON or OFF.

The toggle is interactive for **Verified** and **Community** apps.
Developer-Import apps show the toggle disabled with a one-line
explanation — those stay on the manual-update path.

Disabling does not roll back already-applied updates.

## When auto-update fires

OS8 checks the catalog twice an hour (server-side) and once a day on
the desktop scheduler. When an update lands in the catalog for an
app you have installed:

1. The next desktop sync notices the new pinned commit and flips an
   internal **update-available** flag on the app.
2. The auto-updater walks every Verified or Community app where:
   - `auto_update = ON`
   - `update_available = true`
   - **You haven't made local edits** (the `user_branch` column is
     `NULL`, set by OS8's fork-on-first-edit watcher).
3. If all three conditions hold, OS8 fast-forwards the app's
   `user/main` branch onto the new commit.
4. A bottom-right toast announces the change so you're not surprised.

You can also force an immediate catalog check via **Settings → App
Store → Sync Now**. Per-install lazy refresh covers the same case
automatically when the cached row is older than 5 minutes.

## When auto-update does NOT fire

Auto-update is intentionally conservative. It will **never**:

- Apply an update to an app you've edited locally (any change on
  `user/main` past the original install commit). These updates wait
  for you to resolve manually — see "When updates conflict with your
  edits" below.
- Apply updates from the **Developer-Import** channel (no upstream
  catalog).
- Restart a long-running process unless start-relevant files
  (`package.json`, lockfile, the binary referenced by `start.argv`)
  changed in the upstream commit. Pure source edits flow through
  Vite HMR with no restart.

## When updates conflict with your edits

If you've edited an app locally and an upstream update would touch
the same lines, the auto-updater stops short of merging. Instead:

1. A bottom-right **toast** surfaces with a "Resolve" action button.
2. A red dot overlay appears on the app's home-screen icon.
3. Inside the app, a **merge-conflict banner** lists every file with
   unresolved conflicts and offers three actions:

   | Action | What it does |
   |---|---|
   | **I've resolved all conflicts — commit** | Stages + commits the resolved files. Refuses if any file still contains raw `<<<<<<<` markers (silent footgun guard). |
   | **Resolve with Claude** | Copies a structured resolution prompt to your clipboard. Paste into Claude Code or any AI coding agent — the prompt enumerates the conflicted files + asks the agent to resolve while preserving your edits' intent. |
   | **Abort the update** | Runs `git merge --abort` cleanly. Your edits stay; the update is deferred until next sync. |

The banner persists across OS8 restarts (the conflict-file list is
stored on `apps.update_conflict_files`), so closing the app or
restarting OS8 doesn't lose the resolution state.

Conflicts are equally applicable to Verified and Community apps —
both channels share the same banner + clipboard prompt.

## Restart policy

Catalog apps generally don't need a restart for source-only updates —
Vite HMR picks them up live. When an update changes start-relevant
files, OS8's existing process supervisor detects-and-restarts on next
launch. If you're actively using the app, the restart happens the
next time you open the app's tab.

If the smart-restart heuristic ever proves wrong (e.g. an update
changes a config file that the running process reads only at startup),
the fallback is "always restart with notification" — which would
change at the supervisor layer, not the auto-updater. Open an issue
if you hit this.

## What if an auto-update fails?

The toast says "auto-update failed" with the error message. Look at
the OS8 console (View → Developer → Toggle DevTools) for full detail.
Common causes:

- **Conflict** — even with no local edits, a dirty working tree (e.g.
  a file OS8 wrote that wasn't `git add`'d) can block the merge. The
  merge-conflict banner surfaces in this case too — same three
  actions apply.
- **Network failure** — the `git fetch` for the new commit didn't
  reach GitHub. The next scheduler tick retries.
- **Disk full** — git can't checkout. Free space and try again.

The app's previous version stays installed; failures are non-
destructive.

## Reverting an auto-update

OS8 doesn't have a one-click undo (yet — tracked in the deferred-
items doc). To roll back manually:

```bash
cd ~/os8/apps/<app-id>
git log --oneline -10        # find the previous commit you want
git checkout -B user/main <previous-commit-sha>
```

OS8 picks up the change on the next dev-server start.

## Privacy

Auto-update reads from the public catalog repos and writes locally.
It does not send anything to any third party. (The optional
**install telemetry** described in Settings → App Store is a separate
opt-in.)

## Related

- [App Store spec §6.9](app-store-spec.md) — update flow + three-way
  merge semantics.
- [Sync Now reference](sync-now.md) — catalog-freshness controls.
- [Runtime volumes reference](runtime-volumes.md) — Docker app data
  preservation across updates.
- Settings → App Store — channel toggles, per-channel auto-update
  defaults, Sync Now button, idle reaper, telemetry opt-in.
- Right-click → Settings… on any app icon — per-app overrides
  (including the auto-update toggle described above).
