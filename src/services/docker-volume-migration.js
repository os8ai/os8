/**
 * DockerVolumeMigration — Phase 5 PR 5.8 helper.
 *
 * Scans installed docker apps that declare `runtime.volumes` and
 * surfaces a one-time first-boot toast for any whose host-side
 * `${BLOB_DIR}/<appId>/_volumes/<basename>/` directory is missing or
 * empty. The toast directs the user to `tools/migrate-docker-volume.sh
 * <slug>` to copy the container's existing data out before the next
 * restart re-mounts an empty dir over it.
 *
 * Suppression: per-app setting `app_store.docker_volume_migration_acknowledged.<appId>`.
 * Once the user acknowledges (or the host dir gains content), the
 * scanner stops reporting that app.
 *
 * Triggered after `migration 0.7.0` lands and the catalog sync
 * scheduler kicks off; non-blocking — runs once on startup.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const { BLOB_DIR } = require('../config');

function _ackKey(appId) {
  return `app_store.docker_volume_migration_acknowledged.${appId}`;
}

/**
 * Scan installed docker apps for ones with declared `runtime.volumes`
 * that need migration. Returns an array of:
 *   { appId, slug, name, volumes: [{ container_path, hostDir }] }
 * for each app that needs the toast.
 *
 * Cheap: reads the apps table (one query) + parses manifest YAML
 * (already cached in apps.manifest_yaml) + a few fs.statSync calls
 * per declared volume. No docker CLI calls — those happen in the
 * migrate script the user runs explicitly.
 */
function scan(db) {
  const SettingsService = require('./settings');

  // Filter at the SQL level on manifest_yaml LIKE — drops the obvious
  // non-volume rows without YAML-parsing every external app's manifest.
  const rows = db.prepare(`
    SELECT id, slug, name, manifest_yaml
      FROM apps
     WHERE app_type = 'external'
       AND status = 'active'
       AND manifest_yaml LIKE '%volumes%'
  `).all();

  const needsMigration = [];
  for (const row of rows) {
    let manifest;
    try { manifest = yaml.load(row.manifest_yaml); }
    catch (_) { continue; }
    if (manifest?.runtime?.kind !== 'docker') continue;

    const volumes = Array.isArray(manifest?.runtime?.volumes) ? manifest.runtime.volumes : [];
    if (volumes.length === 0) continue;

    // Per-app suppression — user already acknowledged.
    let ack;
    try { ack = SettingsService.get(db, _ackKey(row.id)); }
    catch (_) { /* settings unavailable — fall through, scan stays best-effort */ }
    if (ack === 'true' || ack === true) continue;

    const empty = [];
    for (const vol of volumes) {
      const cp = vol?.container_path;
      if (typeof cp !== 'string' || !cp.startsWith('/')) continue;
      const basename = path.posix.basename(cp);
      if (!basename) continue;
      const hostDir = path.join(BLOB_DIR, row.id, '_volumes', basename);
      let isEmpty = true;
      try {
        if (fs.existsSync(hostDir)) {
          const entries = fs.readdirSync(hostDir);
          isEmpty = entries.length === 0;
        }
      } catch (_) { /* permission glitch — be safe and treat as empty */ }
      if (isEmpty) {
        empty.push({ container_path: cp, hostDir });
      }
    }
    if (empty.length > 0) {
      needsMigration.push({
        appId: row.id, slug: row.slug, name: row.name, volumes: empty,
      });
    }
  }

  return needsMigration;
}

/**
 * Mark the migration as acknowledged for an app. The next scan() will
 * skip this app, the toast (re-rendered on next OS8 restart) won't fire.
 */
function acknowledge(db, appId) {
  const SettingsService = require('./settings');
  SettingsService.set(db, _ackKey(appId), 'true');
}

module.exports = {
  scan,
  acknowledge,
  _ackKey,
};
