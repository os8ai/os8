/**
 * Phase 5 PR 5.8 — DockerVolumeMigration scanner unit tests.
 *
 * Verifies the first-boot scan picks up installed docker apps with
 * declared `runtime.volumes` whose host-side `_volumes/<basename>/`
 * dirs are missing or empty. Suppression via the per-app
 * acknowledgment setting key.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const Database = require('better-sqlite3');

let prevHome, parent, db;
let DockerVolumeMigration;
let SettingsService;

const LINKDING_YAML = `
schemaVersion: 2
slug: linkding
name: linkding
runtime:
  kind: docker
  image: sissbruecker/linkding:v1.45.0
  internal_port: 9090
  volumes:
    - container_path: /etc/linkding/data
`.trim();

const NO_VOLUMES_YAML = `
schemaVersion: 2
slug: openwebui
name: Open WebUI
runtime:
  kind: docker
  image: ghcr.io/open-webui/open-webui:v0.9.2
  internal_port: 8080
`.trim();

const NODE_APP_YAML = `
schemaVersion: 1
slug: worldmonitor
name: World Monitor
runtime:
  kind: node
`.trim();

beforeEach(() => {
  parent = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-docker-vol-'));
  prevHome = process.env.OS8_HOME;
  process.env.OS8_HOME = parent;

  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/services/docker-volume-migration')];
  delete require.cache[require.resolve('../src/services/settings')];
  DockerVolumeMigration = require('../src/services/docker-volume-migration');
  SettingsService = require('../src/services/settings');

  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE apps (
      id TEXT PRIMARY KEY,
      name TEXT, slug TEXT UNIQUE,
      status TEXT DEFAULT 'active',
      app_type TEXT DEFAULT 'regular',
      manifest_yaml TEXT
    );
  `);
});

afterEach(() => {
  try { db.close(); } catch (_) {}
  if (prevHome === undefined) delete process.env.OS8_HOME;
  else process.env.OS8_HOME = prevHome;
  try { fs.rmSync(parent, { recursive: true, force: true }); } catch (_) {}
});

function insertApp(db, opts) {
  db.prepare(`
    INSERT INTO apps (id, name, slug, status, app_type, manifest_yaml)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    opts.id, opts.name || opts.slug, opts.slug,
    opts.status || 'active', opts.app_type || 'external',
    opts.manifest_yaml,
  );
}

describe('DockerVolumeMigration.scan (PR 5.8)', () => {
  it('returns empty when no docker apps with volumes are installed', () => {
    insertApp(db, { id: 'a-node', slug: 'worldmonitor', manifest_yaml: NODE_APP_YAML });
    insertApp(db, { id: 'a-noop', slug: 'openwebui', manifest_yaml: NO_VOLUMES_YAML });
    expect(DockerVolumeMigration.scan(db)).toEqual([]);
  });

  it('flags an installed docker app with declared volumes whose host dir is missing', () => {
    insertApp(db, { id: 'a-linkding', slug: 'linkding', manifest_yaml: LINKDING_YAML });
    const r = DockerVolumeMigration.scan(db);
    expect(r).toHaveLength(1);
    expect(r[0].appId).toBe('a-linkding');
    expect(r[0].slug).toBe('linkding');
    expect(r[0].volumes).toHaveLength(1);
    expect(r[0].volumes[0].container_path).toBe('/etc/linkding/data');
  });

  it('flags an app whose host dir exists but is empty', () => {
    const { BLOB_DIR } = require('../src/config');
    insertApp(db, { id: 'a-linkding', slug: 'linkding', manifest_yaml: LINKDING_YAML });
    fs.mkdirSync(path.join(BLOB_DIR, 'a-linkding', '_volumes', 'data'), { recursive: true });
    const r = DockerVolumeMigration.scan(db);
    expect(r).toHaveLength(1);
  });

  it('skips an app whose host dir already has content (migrated)', () => {
    const { BLOB_DIR } = require('../src/config');
    insertApp(db, { id: 'a-linkding', slug: 'linkding', manifest_yaml: LINKDING_YAML });
    const hostDir = path.join(BLOB_DIR, 'a-linkding', '_volumes', 'data');
    fs.mkdirSync(hostDir, { recursive: true });
    fs.writeFileSync(path.join(hostDir, 'bookmarks.db'), 'preserved');
    expect(DockerVolumeMigration.scan(db)).toEqual([]);
  });

  it('skips an app whose acknowledgment has been set', () => {
    insertApp(db, { id: 'a-linkding', slug: 'linkding', manifest_yaml: LINKDING_YAML });
    SettingsService.set(db, 'app_store.docker_volume_migration_acknowledged.a-linkding', 'true');
    expect(DockerVolumeMigration.scan(db)).toEqual([]);
  });

  it('skips uninstalled apps', () => {
    insertApp(db, { id: 'a-uninst', slug: 'linkding', status: 'uninstalled', manifest_yaml: LINKDING_YAML });
    expect(DockerVolumeMigration.scan(db)).toEqual([]);
  });

  it('skips non-external apps', () => {
    insertApp(db, { id: 'a-system', slug: 'linkding', app_type: 'system', manifest_yaml: LINKDING_YAML });
    expect(DockerVolumeMigration.scan(db)).toEqual([]);
  });

  it('survives malformed manifest_yaml without throwing', () => {
    insertApp(db, { id: 'a-bad', slug: 'broken', manifest_yaml: 'volumes:\n  not yaml: [{ ' });
    expect(() => DockerVolumeMigration.scan(db)).not.toThrow();
    expect(DockerVolumeMigration.scan(db)).toEqual([]);
  });

  it('handles multiple declared volumes — flags only when at least one is empty', () => {
    const { BLOB_DIR } = require('../src/config');
    const yaml = `
schemaVersion: 2
slug: multi
name: Multi
runtime:
  kind: docker
  image: foo:bar
  internal_port: 8080
  volumes:
    - container_path: /var/lib/foo
    - container_path: /etc/bar
`.trim();
    insertApp(db, { id: 'a-multi', slug: 'multi', manifest_yaml: yaml });
    // Populate one host dir; the other is still empty.
    const fooHost = path.join(BLOB_DIR, 'a-multi', '_volumes', 'foo');
    fs.mkdirSync(fooHost, { recursive: true });
    fs.writeFileSync(path.join(fooHost, 'data'), 'x');
    const r = DockerVolumeMigration.scan(db);
    expect(r).toHaveLength(1);
    // Only the empty volume is reported.
    expect(r[0].volumes.map(v => v.container_path)).toEqual(['/etc/bar']);
  });
});

describe('DockerVolumeMigration.acknowledge (PR 5.8)', () => {
  it('sets the per-app suppression key', () => {
    insertApp(db, { id: 'a1', slug: 'linkding', manifest_yaml: LINKDING_YAML });
    DockerVolumeMigration.acknowledge(db, 'a1');
    const v = SettingsService.get(db, 'app_store.docker_volume_migration_acknowledged.a1');
    expect(v).toBe('true');
  });

  it('subsequent scan() skips the acknowledged app', () => {
    insertApp(db, { id: 'a1', slug: 'linkding', manifest_yaml: LINKDING_YAML });
    expect(DockerVolumeMigration.scan(db)).toHaveLength(1);
    DockerVolumeMigration.acknowledge(db, 'a1');
    expect(DockerVolumeMigration.scan(db)).toEqual([]);
  });
});
