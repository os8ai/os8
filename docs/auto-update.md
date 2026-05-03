# Auto-update for Verified-channel apps

OS8 can apply updates to Verified-channel apps automatically — but
only when you haven't edited them locally. This page describes how to
turn it on, what triggers an update, and what to do if something goes
wrong.

## Turning auto-update on

1. **Right-click** an app icon on the home grid.
2. Choose **Settings…** from the context menu.
3. Toggle **Auto-update from catalog** to ON.

The toggle is interactive only for **Verified-channel** apps (those
listed at [os8.ai/apps](https://os8.ai/apps) under the Verified pill).
Community-channel and Developer-Import apps show the toggle as
disabled with a one-line explanation — those channels stay on the
manual-update path.

You can flip the toggle off any time. Disabling does not roll back
already-applied updates.

## When auto-update fires

OS8 checks the Verified catalog twice an hour (server-side) and once
a day on the desktop scheduler. When an update lands in the catalog
for an app you have installed:

1. The next desktop sync notices the new pinned commit and flips an
   internal **update-available** flag on the app.
2. The auto-updater walks every Verified app where:
   - `auto_update = ON`
   - `update_available = true`
   - **You haven't made local edits** (the `user_branch` column is
     `NULL`, set by OS8's fork-on-first-edit watcher).
3. If all three conditions hold, OS8 fast-forwards the app's
   `user/main` branch onto the new commit.
4. A bottom-right toast announces the change so you're not surprised.

## When auto-update does NOT fire

Auto-update is intentionally conservative. It will **never**:

- Apply an update to an app you've edited locally (any change on
  `user/main` past the original install commit). These updates wait
  for you to resolve via the home-screen banner so you can three-way
  merge in the source sidebar.
- Apply updates from the **Community** channel or **Developer-Import**
  channel.
- Restart a long-running process unless start-relevant files
  (`package.json`, lockfile, the binary referenced by `start.argv`)
  changed in the upstream commit. Pure source edits flow through
  Vite HMR with no restart.

## Restart policy

Verified apps generally don't need a restart for source-only updates —
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
  a file OS8 wrote that wasn't `git add`'d) can block the merge. Open
  the app folder in a terminal and `git status` to see what's
  outstanding.
- **Network failure** — the `git fetch` for the new commit didn't
  reach GitHub. The next scheduler tick retries.
- **Disk full** — git can't checkout. Free space and try again.

The app's previous version stays installed; failures are non-
destructive.

## Reverting an auto-update

OS8 doesn't have a one-click undo (yet — tracked in the deferred-items
doc). To roll back manually:

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
- Settings → App Store — channel toggles, idle reaper, telemetry
  opt-in.
- Right-click → Settings… on any app icon — per-app overrides
  (including the auto-update toggle described above).
