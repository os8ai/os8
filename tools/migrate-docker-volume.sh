#!/usr/bin/env bash
# Phase 5 PR 5.8 — copy a running docker app's container-internal data
# out of the container and into OS8's host-side `_volumes/<basename>/`
# bind-mount path, so the next OS8 restart preserves it.
#
# Usage:
#   tools/migrate-docker-volume.sh <slug>
#
# Reads the app's manifest from os8.db, for each declared
# `runtime.volumes[i].container_path`:
#   1. Verifies the container `os8-app-<appId>` is running.
#   2. tars the in-container path and untars into the host
#      `${OS8_HOME}/blob/<appId>/_volumes/${basename}/` directory.
#   3. Marks the migration acknowledged via the SQLite settings table
#      so OS8's first-boot toast stops surfacing it.
#
# Idempotent — re-running with an already-populated host dir is safe;
# tar overwrites only what's in the source side. Run BEFORE the next
# OS8 restart so the empty host bind doesn't mask the in-container data.
#
# Exits non-zero on any error so it's safe to chain into other scripts.

set -euo pipefail

SLUG="${1:-}"
if [[ -z "$SLUG" ]]; then
  echo "Usage: $0 <slug>" >&2
  echo "  e.g. $0 linkding" >&2
  exit 64
fi

OS8_HOME="${OS8_HOME:-$HOME/os8}"
DB_PATH="$OS8_HOME/config/os8.db"
BLOB_DIR="$OS8_HOME/blob"

if [[ ! -f "$DB_PATH" ]]; then
  echo "ERROR: os8.db not found at $DB_PATH" >&2
  echo "  set OS8_HOME if your OS8 data lives elsewhere" >&2
  exit 1
fi
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "ERROR: sqlite3 CLI required (apt install sqlite3 / brew install sqlite)" >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker CLI required" >&2
  exit 1
fi

# Resolve the apps row.
APP_ID=$(sqlite3 "$DB_PATH" "SELECT id FROM apps WHERE slug = '$SLUG' AND app_type = 'external' AND status = 'active' LIMIT 1;")
if [[ -z "$APP_ID" ]]; then
  echo "ERROR: no active external app with slug='$SLUG' in $DB_PATH" >&2
  exit 1
fi

# Pull the manifest_yaml. We only need runtime.volumes paths; grep them
# out of the YAML rather than pulling in a yaml CLI dep.
MANIFEST_YAML=$(sqlite3 "$DB_PATH" "SELECT manifest_yaml FROM apps WHERE id = '$APP_ID';")
if [[ -z "$MANIFEST_YAML" ]]; then
  echo "ERROR: apps row for $SLUG has no manifest_yaml" >&2
  exit 1
fi

# Extract container_path values. The manifest format is:
#   runtime:
#     volumes:
#       - container_path: /etc/linkding/data
#       - container_path: /var/lib/foo
# A simple grep is robust enough — schema regex disallows quoting weirdness.
CONTAINER_PATHS=$(printf '%s\n' "$MANIFEST_YAML" | awk '
  /^[[:space:]]*runtime:/ { in_runtime=1; next }
  /^[a-zA-Z]/ { in_runtime=0; in_vol=0 }
  in_runtime && /^[[:space:]]*volumes:/ { in_vol=1; next }
  in_runtime && in_vol && /^[[:space:]]*-[[:space:]]*container_path:[[:space:]]*/ {
    sub(/^[^:]*:[[:space:]]*/, ""); print
  }
')

if [[ -z "$CONTAINER_PATHS" ]]; then
  echo "$SLUG declares no runtime.volumes — nothing to migrate."
  exit 0
fi

CONTAINER="os8-app-$APP_ID"
if ! docker ps --format '{{.Names}}' | grep -q "^$CONTAINER$"; then
  echo "ERROR: container $CONTAINER is not running."
  echo "  Start the app in OS8 first, then re-run this script."
  echo "  (running container is required so we can read the data out)"
  exit 1
fi

echo "Migrating $SLUG (appId=$APP_ID, container=$CONTAINER)..."

while IFS= read -r CPATH; do
  [[ -z "$CPATH" ]] && continue
  BASENAME=$(basename "$CPATH")
  HOST_DIR="$BLOB_DIR/$APP_ID/_volumes/$BASENAME"
  mkdir -p "$HOST_DIR"

  # Probe the in-container path. If empty, log + skip — nothing to copy.
  if ! docker exec "$CONTAINER" sh -c "[ -d '$CPATH' ] && [ \$(ls -A '$CPATH' 2>/dev/null | wc -l) -gt 0 ]"; then
    echo "  $CPATH: empty or missing in-container; skipping"
    continue
  fi

  echo "  $CPATH → $HOST_DIR"
  # tar the source dir's CONTENT (cd into it first) so the untar lands at
  # the dest root. Stream piped — no tmpfile.
  docker exec "$CONTAINER" tar -C "$CPATH" -cf - . | tar -xf - -C "$HOST_DIR"

  # Verify file count matches as a sanity check.
  IN=$(docker exec "$CONTAINER" sh -c "find '$CPATH' -mindepth 1 | wc -l" | tr -d '[:space:]')
  OUT=$(find "$HOST_DIR" -mindepth 1 | wc -l | tr -d '[:space:]')
  if [[ "$IN" != "$OUT" ]]; then
    echo "  WARN: file count mismatch (container=$IN host=$OUT) — review manually" >&2
  fi
done <<< "$CONTAINER_PATHS"

# Acknowledge so OS8's first-boot scanner stops proposing this app.
sqlite3 "$DB_PATH" \
  "INSERT OR REPLACE INTO settings (key, value) VALUES ('app_store.docker_volume_migration_acknowledged.$APP_ID', 'true');"

echo
echo "Done. Restart $SLUG in OS8 — bind-mounted host dirs now shadow"
echo "the in-container paths with the migrated data."
