# Catalog freshness — Sync Now and lazy refresh

OS8's local catalog is a cache. The authoritative state lives upstream
at [os8.ai/apps](https://os8.ai/apps), driven by the
[os8ai/os8-catalog](https://github.com/os8ai/os8-catalog) and
[os8ai/os8-catalog-community](https://github.com/os8ai/os8-catalog-community)
GitHub repos. The desktop pulls a refresh once a day at 4am local
time. Most of the time that cadence is fine — apps don't change
hourly. The Phase 5 features described here close two gaps:

1. **You shouldn't have to wait until 4am tomorrow** to see a
   manifest change that just landed.
2. **An install attempt should pick up a manifest tweak** even if the
   daily sync hasn't run yet.

## Sync Now button

In **Settings → App Store**, between the channel toggles and the
external-app idle reaper, there's a **Sync Now** button.

Clicking it forces an immediate sync of every enabled remote channel
(Verified, Community). Developer-Import is skipped — that channel has
no remote catalog; imports happen on demand via the home-screen
"Import from GitHub" button.

A small status line below the button reports the result, e.g.
*Synced verified + community: +2 added, 5 updated, -0 removed.*

If a channel is disabled in Settings, it's left alone. If no remote
channel is enabled, the button surfaces *No remote channels enabled
— nothing to sync.*

## Per-install lazy refresh

The Sync Now button covers the "I know I want to refresh" case.
For the "I'm about to install this app and the manifest just
changed" case, OS8 also lazy-refreshes automatically.

When you open the install plan modal for any catalog app, OS8 checks
the cache age of that specific row. If it's older than **5 minutes**,
OS8 re-fetches the manifest from os8.ai before rendering the install
plan. The same check fires again right before the install pipeline
clones the repo, as a defense-in-depth catch for the brief window
between opening the modal and approving the install.

You won't see this in the UI — the refresh is silent unless something
actually changed upstream. Network failures fall back to the cached
row; the install proceeds rather than failing on a transient hiccup.

### Why 5 minutes?

Short enough to catch the active-development workflow ("I just
pushed a fix to the manifest; can I install with it?") but long
enough to avoid hammering os8.ai on a normal browse-then-install
flow. If you need a fresher state than that, click Sync Now — it
forces a full channel re-sync regardless of cache age.

## When does the daily sync still matter?

Sync Now and lazy refresh both target *individual rows you interact
with*. The daily 4am tick is what keeps the rest of the catalog
current — apps you haven't browsed today, the *Update available*
flag for installed apps, the catalog-wide `synced_at` watermark.

In particular, the "Update available" badge on installed external
apps depends on the daily tick noticing that an upstream commit moved
forward. Lazy refresh won't surface a new install update; it only
freshens the manifest used for *new installs* of the touched slug.

## What if Sync Now fails?

Causes you'll see in the inline status line:

- **Network failure** — the desktop can't reach os8.ai. Try again or
  check connectivity.
- **Channel-specific error** — one channel succeeded, another failed.
  The status line names which.
- **No remote channels enabled** — toggle Verified or Community on in
  the same panel, then click Sync Now.

The cached state is left intact on any failure; a partial sync that
completes for Verified but errors on Community still applies the
Verified updates and the next Sync Now retries Community.

## Privacy

Sync Now is a public-catalog read. It does not log who you are or
what you searched for; it pulls JSON manifests from os8.ai's CDN over
HTTPS. The optional **install telemetry** described in
Settings → App Store is a separate opt-in that fires when you install
or update an app, never on a sync.

## Related

- [App Store spec §6.4](app-store-spec.md) — channel sync invariants.
- Phase 5 PR 5.6 — the implementation (`src/services/app-catalog.js`
  + `src/renderer/settings.js`).
- Settings → App Store — channel toggles + idle reaper + telemetry.
