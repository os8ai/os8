/**
 * PR 2.5 — DockerRuntimeAdapter unit tests.
 *
 * The adapter shells out to `docker` for everything. These tests stub
 * the spawn call via the _internal._setSpawn hook to assert argv shape
 * without requiring a Docker daemon. Live pull/run/stop coverage comes
 * from PR 2.4's OpenWebUI manifest installing end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';

const BASE_MANIFEST = {
  schemaVersion: 2,
  slug: 'fixture',
  name: 'Fixture',
  publisher: 'tester',
  upstream: { git: 'https://example.test/x.git', ref: 'v1.0.0' },
  runtime: {
    kind: 'docker',
    version: '1',
    image: 'ghcr.io/foo/bar:v1.0.0',
    image_digest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    internal_port: 8080,
    arch: ['arm64', 'x86_64'],
  },
  start: { argv: [], port: 'detect',
           readiness: { type: 'http', path: '/health', timeout_seconds: 30 } },
  surface: { kind: 'web' },
  permissions: { network: { outbound: true, inbound: false }, filesystem: 'app-private', os8_capabilities: [] },
  legal: { license: 'MIT', commercial_use: 'unrestricted' },
  review: { channel: 'verified' },
};

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function loadAdapter() {
  delete require.cache[require.resolve('../src/services/runtime-adapters/docker')];
  return require('../src/services/runtime-adapters/docker');
}

describe('DockerRuntimeAdapter — imageRefFor', () => {
  let DockerAdapter;
  beforeEach(() => { DockerAdapter = loadAdapter(); });

  it('uses digest when image_digest is set', () => {
    const ref = DockerAdapter._internal.imageRefFor(BASE_MANIFEST);
    expect(ref).toBe('ghcr.io/foo/bar@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
  });

  it('falls back to tag ref when no digest', () => {
    const m = clone(BASE_MANIFEST);
    delete m.runtime.image_digest;
    const ref = DockerAdapter._internal.imageRefFor(m);
    expect(ref).toBe('ghcr.io/foo/bar:v1.0.0');
  });
});

describe('DockerRuntimeAdapter — install argv shape', () => {
  let DockerAdapter;
  let calls;
  beforeEach(() => {
    DockerAdapter = loadAdapter();
    calls = [];
    DockerAdapter._internal._setSpawn(async (argv) => {
      calls.push(argv);
      return { stdout: 'ok\n', stderr: '' };
    });
  });
  afterEach(() => { DockerAdapter._internal._resetSpawn(); });

  it('install runs `docker pull <image-by-digest>`', async () => {
    await DockerAdapter.install(BASE_MANIFEST, '/tmp/app', { OS8_APP_ID: 'a1' }, () => {});
    expect(calls).toEqual([
      ['docker', 'pull', 'ghcr.io/foo/bar@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'],
    ]);
  });

  it('install throws when image is missing', async () => {
    const m = clone(BASE_MANIFEST);
    delete m.runtime.image;
    delete m.runtime.image_digest;
    await expect(
      DockerAdapter.install(m, '/tmp/app', { OS8_APP_ID: 'a1' }, () => {})
    ).rejects.toThrow(/missing runtime\.image/);
  });
});

describe('DockerRuntimeAdapter — start argv shape', () => {
  let DockerAdapter;
  let calls;

  beforeEach(() => {
    DockerAdapter = loadAdapter();
    calls = [];
    DockerAdapter._internal._setSpawn(async (argv) => {
      calls.push(argv);
      if (argv[0] === 'docker' && argv[1] === 'run') {
        return { stdout: 'fake-container-id\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
  });
  afterEach(() => { DockerAdapter._internal._resetSpawn(); });

  it('emits docker rm -f then docker run -d with correct mounts/env/port', async () => {
    const env = {
      OS8_APP_ID: 'app-uuid-1',
      PORT: '40123',
      OS8_BASE_URL: 'http://localhost:8888',
      OS8_API_BASE: 'http://fixture.localhost:8888/_os8/api',
      WEBUI_AUTH: 'false',
    };
    // Don't await ready — we'd need a live HTTP server. Just collect args.
    const info = await Promise.race([
      DockerAdapter.start(BASE_MANIFEST, '/ignored', env, () => {}),
      new Promise((_r, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
    ]).catch(() => null);

    // We expect at least the rm + run calls regardless of readiness outcome.
    expect(calls[0]).toEqual(['docker', 'rm', '-f', 'os8-app-app-uuid-1']);
    const runCall = calls.find(c => c[0] === 'docker' && c[1] === 'run');
    expect(runCall).toBeDefined();
    expect(runCall.slice(1, 4)).toEqual(['run', '-d', '--name']);
    expect(runCall).toContain('os8-app-app-uuid-1');
    expect(runCall).toContain('-p');
    expect(runCall).toContain('127.0.0.1:40123:8080');
    expect(runCall).toContain('--mount');
    // Bind mounts: APPS_DIR + appId → /app, BLOB_DIR + appId → /data
    const { APPS_DIR, BLOB_DIR } = require('../src/config');
    expect(runCall).toContain(`type=bind,source=${path.join(APPS_DIR, 'app-uuid-1')},target=/app`);
    expect(runCall).toContain(`type=bind,source=${path.join(BLOB_DIR, 'app-uuid-1')},target=/data`);
    // GPU passthrough is OFF by default — no --gpus flag.
    expect(runCall).not.toContain('--gpus');
    // Env: PORT inside the container = internal_port (8080), and OS8_*_DIR
    // get rewritten.
    expect(runCall).toContain('-e');
    expect(runCall).toContain('PORT=8080');
    expect(runCall).toContain('OS8_APP_DIR=/app');
    expect(runCall).toContain('OS8_BLOB_DIR=/data');
    expect(runCall).toContain('WEBUI_AUTH=false');
    // Image ref last.
    expect(runCall[runCall.length - 1]).toBe(
      'ghcr.io/foo/bar@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    );

    // If start returned an info object, exercise stop() to confirm cleanup
    // commands are emitted.
    if (info && info._kind === 'docker') {
      calls.length = 0;
      await DockerAdapter.stop(info);
      const stopCall = calls.find(c => c[1] === 'stop');
      const rmCall = calls.find(c => c[1] === 'rm');
      expect(stopCall?.slice(0, 5)).toEqual(['docker', 'stop', '--time', '5', 'os8-app-app-uuid-1']);
      expect(rmCall?.slice(0, 3)).toEqual(['docker', 'rm', 'os8-app-app-uuid-1']);
    }
  });

  it('strips host-OS env keys (PATH/HOME/USER/...) before passing -e flags', async () => {
    // Regression: linkding 1.45.0 smoke (2026-05-03) — host PATH leaked into
    // the container via `-e PATH=...`, clobbering the image's PATH so
    // `supervisord` / `uwsgi` / `python` could not be found inside.
    const env = {
      OS8_APP_ID: 'a4',
      PORT: '40789',
      // Host-only keys that buildSanitizedEnv inherits for native adapters.
      PATH: '/host/bin:/usr/bin',
      HOME: '/home/leo',
      USER: 'leo',
      LANG: 'en_US.UTF-8',
      TZ:   'America/Los_Angeles',
      TMPDIR: '/tmp',
      LC_ALL: 'C',
      LC_CTYPE: 'UTF-8',
      // Manifest / OS8-injected keys MUST still pass through.
      OS8_BASE_URL: 'http://localhost:8888',
      OS8_API_BASE: 'http://fixture.localhost:8888/_os8/api',
      WEBUI_AUTH: 'false',
    };
    await Promise.race([
      DockerAdapter.start(BASE_MANIFEST, '/ignored', env, () => {}),
      new Promise((_r, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
    ]).catch(() => null);
    const runCall = calls.find(c => c[1] === 'run');
    const eFlags = [];
    for (let i = 0; i < runCall.length - 1; i++) {
      if (runCall[i] === '-e') eFlags.push(runCall[i + 1]);
    }
    const keys = new Set(eFlags.map(s => s.split('=', 1)[0]));
    // Host-only keys MUST NOT be passed to the container.
    expect(keys.has('PATH')).toBe(false);
    expect(keys.has('HOME')).toBe(false);
    expect(keys.has('USER')).toBe(false);
    expect(keys.has('LANG')).toBe(false);
    expect(keys.has('TZ')).toBe(false);
    expect(keys.has('TMPDIR')).toBe(false);
    expect(keys.has('LC_ALL')).toBe(false);
    expect(keys.has('LC_CTYPE')).toBe(false);
    // OS8 + manifest keys MUST still pass through.
    expect(keys.has('OS8_APP_ID')).toBe(true);
    expect(keys.has('OS8_APP_DIR')).toBe(true);
    expect(keys.has('OS8_BLOB_DIR')).toBe(true);
    expect(keys.has('OS8_BASE_URL')).toBe(true);
    expect(keys.has('OS8_API_BASE')).toBe(true);
    expect(keys.has('PORT')).toBe(true);
    expect(keys.has('WEBUI_AUTH')).toBe(true);
    // PORT inside the container = internal_port (not the host PORT).
    expect(eFlags).toContain('PORT=8080');
  });

  it('--gpus all is appended when manifest.runtime.gpu_passthrough', async () => {
    const m = clone(BASE_MANIFEST);
    m.runtime.gpu_passthrough = true;
    const env = { OS8_APP_ID: 'a2', PORT: '40456' };
    await Promise.race([
      DockerAdapter.start(m, '/ignored', env, () => {}),
      new Promise((_r, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
    ]).catch(() => null);
    const runCall = calls.find(c => c[1] === 'run');
    expect(runCall).toContain('--gpus');
    expect(runCall).toContain('all');
  });

  it('start throws when OS8_APP_ID is missing from env', async () => {
    await expect(
      DockerAdapter.start(BASE_MANIFEST, '/ignored', { PORT: '40000' }, () => {})
    ).rejects.toThrow(/OS8_APP_ID/);
  });

  it('start throws when internal_port is missing', async () => {
    const m = clone(BASE_MANIFEST);
    delete m.runtime.internal_port;
    await expect(
      DockerAdapter.start(m, '/ignored', { OS8_APP_ID: 'a3', PORT: '40000' }, () => {})
    ).rejects.toThrow(/internal_port/);
  });
});

describe('DockerRuntimeAdapter — ensureAvailable error handling', () => {
  let DockerAdapter;
  beforeEach(() => { DockerAdapter = loadAdapter(); });
  afterEach(() => { DockerAdapter._internal._resetSpawn(); });

  it('throws docker_unavailable when `docker info` fails', async () => {
    DockerAdapter._internal._setSpawn(async () => {
      throw new Error('docker: command not found');
    });
    let err;
    try { await DockerAdapter.ensureAvailable(BASE_MANIFEST); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.code).toBe('docker_unavailable');
    expect(err.message).toMatch(/Docker is not installed/);
  });

  it('GPU manifest without nvidia runtime → clear error', async () => {
    const m = clone(BASE_MANIFEST);
    m.runtime.gpu_passthrough = true;
    DockerAdapter._internal._setSpawn(async (argv) => {
      const flat = argv.join(' ');
      if (/Runtimes/.test(flat)) return { stdout: '{"runc":{}}', stderr: '' };
      return { stdout: '24.0.7', stderr: '' };
    });
    await expect(DockerAdapter.ensureAvailable(m)).rejects.toThrow(/nvidia-container-toolkit/);
  });
});

describe('DockerRuntimeAdapter — stop is a no-op for non-docker info', () => {
  let DockerAdapter;
  beforeEach(() => { DockerAdapter = loadAdapter(); });

  it('stop does nothing when processInfo._kind !== docker', async () => {
    await expect(DockerAdapter.stop({ _kind: 'static' })).resolves.toBeUndefined();
    await expect(DockerAdapter.stop(null)).resolves.toBeUndefined();
  });
});

describe('DockerRuntimeAdapter — runtime.volumes (PR 5.8)', () => {
  let DockerAdapter;
  let calls;
  let prevHome;
  let parent;

  beforeEach(async () => {
    const fs = require('fs');
    const os = require('os');
    parent = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-docker-vol-'));
    prevHome = process.env.OS8_HOME;
    process.env.OS8_HOME = parent;
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/services/runtime-adapters/docker')];
    DockerAdapter = require('../src/services/runtime-adapters/docker');
    calls = [];
    DockerAdapter._internal._setSpawn(async (argv) => {
      calls.push(argv);
      if (argv[0] === 'docker' && argv[1] === 'run') return { stdout: 'fake-id\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
  });
  afterEach(() => {
    DockerAdapter._internal._resetSpawn();
    if (prevHome === undefined) delete process.env.OS8_HOME;
    else process.env.OS8_HOME = prevHome;
    const fs = require('fs');
    try { fs.rmSync(parent, { recursive: true, force: true }); } catch (_) {}
  });

  it('argv unchanged when manifest declares no runtime.volumes', async () => {
    await Promise.race([
      DockerAdapter.start(BASE_MANIFEST, '/ignored', { OS8_APP_ID: 'a-novol', PORT: '40000' }, () => {}),
      new Promise((_r, rej) => setTimeout(() => rej(new Error('t')), 3000)),
    ]).catch(() => null);
    const runCall = calls.find(c => c[1] === 'run');
    // No volume mounts beyond the default /app + /data.
    const mountFlags = runCall.filter((s, i) => runCall[i - 1] === '--mount');
    expect(mountFlags).toHaveLength(2);
    expect(mountFlags.some(s => s.endsWith('target=/app'))).toBe(true);
    expect(mountFlags.some(s => s.endsWith('target=/data'))).toBe(true);
  });

  it('mounts each declared volume under BLOB_DIR/<id>/_volumes/<basename>', async () => {
    const fs = require('fs');
    const m = clone(BASE_MANIFEST);
    m.runtime.volumes = [
      { container_path: '/etc/linkding/data' },
      { container_path: '/var/lib/foo' },
    ];
    await Promise.race([
      DockerAdapter.start(m, '/ignored', { OS8_APP_ID: 'a-vol', PORT: '40001' }, () => {}),
      new Promise((_r, rej) => setTimeout(() => rej(new Error('t')), 3000)),
    ]).catch(() => null);

    const { BLOB_DIR } = require('../src/config');
    const expectedDataHost = path.join(BLOB_DIR, 'a-vol', '_volumes', 'data');
    const expectedFooHost = path.join(BLOB_DIR, 'a-vol', '_volumes', 'foo');

    // The host dirs are created at start so the bind mount lands on
    // a real path (otherwise docker creates a root-owned empty dir).
    expect(fs.existsSync(expectedDataHost)).toBe(true);
    expect(fs.existsSync(expectedFooHost)).toBe(true);

    const runCall = calls.find(c => c[1] === 'run');
    const mountFlags = runCall.filter((s, i) => runCall[i - 1] === '--mount');
    // Defaults still present.
    expect(mountFlags.some(s => s.endsWith('target=/app'))).toBe(true);
    expect(mountFlags.some(s => s.endsWith('target=/data'))).toBe(true);
    // Plus the two declared volumes.
    expect(mountFlags).toContain(`type=bind,source=${expectedDataHost},target=/etc/linkding/data`);
    expect(mountFlags).toContain(`type=bind,source=${expectedFooHost},target=/var/lib/foo`);
  });

  it('skips an empty container_path defensively', async () => {
    const m = clone(BASE_MANIFEST);
    // The schema regex would normally reject this; we test the adapter's
    // own defensive skip in case a malformed manifest reaches start().
    m.runtime.volumes = [{ container_path: '/' }];
    await Promise.race([
      DockerAdapter.start(m, '/ignored', { OS8_APP_ID: 'a-empty', PORT: '40002' }, () => {}),
      new Promise((_r, rej) => setTimeout(() => rej(new Error('t')), 3000)),
    ]).catch(() => null);

    const runCall = calls.find(c => c[1] === 'run');
    const mountFlags = runCall.filter((s, i) => runCall[i - 1] === '--mount');
    // Only the two default mounts; the basename-empty entry was dropped.
    expect(mountFlags).toHaveLength(2);
  });
});

// Live coverage of pull/run/stop is exercised via PR 2.4's OpenWebUI
// catalog manifest installing end-to-end against a real Docker daemon.
// No standalone live test here — running `docker pull` in Vitest CI
// would couple this suite to network + daemon availability without
// adding signal beyond what the PR 2.4 install path already provides.
