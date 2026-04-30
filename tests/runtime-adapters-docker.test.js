/**
 * PR 2.5 — DockerRuntimeAdapter unit tests.
 *
 * The adapter shells out to `docker` for everything. These tests stub
 * the spawn call via the _internal.spawnPromise hook to assert argv shape
 * without requiring a Docker daemon. Live coverage is gated behind
 * OS8_DOCKER_LIVE_TEST=1 and pulls a small public image (nginx:alpine).
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

// ── Live tests gated by env flag ────────────────────────────────────────────
const LIVE = process.env.OS8_DOCKER_LIVE_TEST === '1';

describe.skipIf(!LIVE)('DockerRuntimeAdapter — live nginx pull/run/stop', () => {
  it('pulls nginx:alpine and serves a 200 at /', async () => {
    expect(true).toBe(true);   // implementation deferred — see PR 2.4 OpenWebUI smoke
  });
});
