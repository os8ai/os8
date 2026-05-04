# Docker app data persistence (`runtime.volumes`)

OS8 runs Docker-based external apps with two bind-mounts by default:
`~/os8/apps/<id>` → `/app` and `~/os8/blob/<id>` → `/data`. Most apps
that follow conventional Docker patterns work out of the box. But some
apps store state at a third path inside the container — and without an
explicit mount, that state lives in the container's writable layer and
disappears on every `docker rm`.

The `runtime.volumes` field, added in Phase 5, lets a manifest declare
those extra paths so OS8 bind-mounts each one under
`~/os8/blob/<id>/_volumes/<basename>/` and the data survives container
recreate, OS8 restart, and (with PR 5.5's restore-from-orphan flow)
uninstall → reinstall.

## How it works

The Docker adapter reads `runtime.volumes` from the manifest at
`docker run` time. For each declared volume:

1. `mkdir -p ~/os8/blob/<appId>/_volumes/<basename>/` on the host.
2. Pass `--mount type=bind,source=<hostPath>,target=<container_path>`
   to `docker run`.

After that the in-container app sees its expected path with normal
read/write semantics, and OS8 sees a host directory it can preserve,
back up, or carry across reinstalls.

## Manifest example

linkding writes its bookmarks DB and archives to `/etc/linkding/data`:

```yaml
schemaVersion: 2
slug: linkding
runtime:
  kind: docker
  image: docker.io/sissbruecker/linkding:1.45.0
  image_digest: sha256:...
  internal_port: 9090
  volumes:
    - container_path: /etc/linkding/data
```

The corresponding host path on the user's machine becomes
`~/os8/blob/<linkdingAppId>/_volumes/data/`.

### Schema rules

- **`container_path`** (required, string) — must be absolute and match
  `^/[a-zA-Z0-9_/-]+$`. The regex rejects `..` (no path traversal),
  rejects relative paths, rejects characters that confuse Docker's
  argument parsing.
- **`persist`** (optional, boolean, default `true`) — reserved.
  v1 always persists; the field is here for forward-compat if a
  tmpfs-style "scratch" mount surfaces a real use case.
- **Maximum 10 volumes** per manifest (schema cap).
- **No duplicate `container_path` entries** (validator invariant).
- The `_volumes/<basename>/` host path is derived from the
  container_path's basename — pick descriptive last-segment names so
  collisions don't surprise you.

## Migrating an existing install

If you were running a Docker app *before* its manifest gained
`runtime.volumes`, the in-container path lives in the writable layer
and the new bind-mount would silently shadow it on next restart with
an empty host directory. To preserve your data:

1. Wait for the next OS8 startup. A toast will appear:
   *`<slug>: docker volume migration available — run
   `tools/migrate-docker-volume.sh <slug>` to preserve your data.`*
2. **While the container is still running**, run the helper:
   ```bash
   cd /path/to/os8/repo
   tools/migrate-docker-volume.sh <slug>
   ```
   The script reads the manifest from `~/os8/config/os8.db`, finds
   each declared `container_path`, and copies the in-container data
   out to the host bind-mount path via `docker exec tar | tar`.
3. After the script completes, restart the app in OS8. The bind-mount
   now lands on a populated host directory; the in-container app sees
   its data unchanged.
4. The toast won't reappear — the script marks the migration
   acknowledged in OS8's settings table.

The script is idempotent. Running it on an already-migrated app is
safe; it'll log the in-container counts and skip empty paths.

### Requirements

- `docker` on `$PATH` (you already have this if OS8 ran the app).
- `sqlite3` on `$PATH` (`apt install sqlite3` / `brew install sqlite`).
- The container must be running so `docker exec` can read the data
  out. Start the app in OS8 first, then run the script.

If you don't run the script and just restart OS8, the data in the
container's writable layer stays inaccessible until you `docker rm`
(then it's gone). The in-app path will appear empty.

## Authoring a manifest with volumes

If you're publishing a Docker app to the catalog and the image stores
state outside `/app` and `/data`, declare each path:

```yaml
runtime:
  kind: docker
  ...
  volumes:
    - container_path: /etc/myapp/data
    - container_path: /var/lib/myapp/uploads
```

Things to check:

- Does the image's `Dockerfile` declare any `VOLUME` directives? Each
  is a candidate.
- Does the upstream README mention "mount this path for persistence"?
- Does running the image without your declarations and then `docker
  rm`-ing it lose state? If yes, that path needs declaring.

The catalog's CI runs the same JSON Schema OS8 ships with, so a
malformed `runtime.volumes` array fails validation before it ever
reaches an installed user.

## Privacy

Volume contents are local-only. OS8 doesn't sync them anywhere —
they're under your home directory, governed by your filesystem
permissions, just like your blob storage.

## Related

- [App Store spec §6.2.2](app-store-spec.md) — Docker runtime adapter
  invariants.
- Phase 5 PR 5.8 — the implementation (`src/services/runtime-adapters/
  docker.js` + `src/services/manifest-validator.js`).
- `tools/migrate-docker-volume.sh` — the in-tree helper.
