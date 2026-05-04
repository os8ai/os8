/**
 * Phase 5 PR 5.8 — appspec-v2 runtime.volumes validation.
 *
 * Schema-level checks (regex on container_path, item shape) plus the
 * invariant check for duplicate container_path entries within a single
 * manifest's volumes array.
 */

import { describe, it, expect } from 'vitest';

const { validateManifest } = require('../src/services/manifest-validator');

const V2_DOCKER_BASE = {
  schemaVersion: 2,
  slug: 'linkding',
  name: 'linkding',
  publisher: 'sissbruecker',
  upstream: { git: 'https://github.com/sissbruecker/linkding.git', ref: 'v1.45.0' },
  runtime: {
    kind: 'docker',
    version: '1',
    image: 'sissbruecker/linkding:v1.45.0',
    image_digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    internal_port: 9090,
    arch: ['arm64', 'x86_64'],
  },
  start: {
    argv: [],
    port: 'detect',
    readiness: { type: 'http', path: '/health', timeout_seconds: 60 },
  },
  surface: { kind: 'web' },
  permissions: { network: { outbound: true, inbound: false }, filesystem: 'app-private' },
  legal: { license: 'MIT', commercial_use: 'unrestricted' },
  review: { channel: 'community' },
};

function clone(o) { return JSON.parse(JSON.stringify(o)); }

const COMMIT = 'a'.repeat(40);

describe('runtime.volumes (PR 5.8)', () => {
  it('accepts a single valid volume', () => {
    const m = clone(V2_DOCKER_BASE);
    m.runtime.volumes = [{ container_path: '/etc/linkding/data' }];
    const r = validateManifest(m, { upstreamResolvedCommit: COMMIT });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('accepts multiple volumes with distinct container_paths', () => {
    const m = clone(V2_DOCKER_BASE);
    m.runtime.volumes = [
      { container_path: '/etc/linkding/data' },
      { container_path: '/var/lib/foo' },
    ];
    const r = validateManifest(m, { upstreamResolvedCommit: COMMIT });
    expect(r.errors).toEqual([]);
  });

  it('accepts the optional persist field', () => {
    const m = clone(V2_DOCKER_BASE);
    m.runtime.volumes = [{ container_path: '/data', persist: true }];
    const r = validateManifest(m, { upstreamResolvedCommit: COMMIT });
    expect(r.errors).toEqual([]);
  });

  it('rejects missing container_path', () => {
    const m = clone(V2_DOCKER_BASE);
    m.runtime.volumes = [{ persist: true }];
    const r = validateManifest(m, { upstreamResolvedCommit: COMMIT });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => /container_path/.test(e.message))).toBe(true);
  });

  it('rejects container_path with .. (path traversal)', () => {
    const m = clone(V2_DOCKER_BASE);
    m.runtime.volumes = [{ container_path: '/../etc/passwd' }];
    const r = validateManifest(m, { upstreamResolvedCommit: COMMIT });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => /pattern/i.test(e.message) || /container_path/.test(e.path))).toBe(true);
  });

  it('rejects relative container_path (no leading slash)', () => {
    const m = clone(V2_DOCKER_BASE);
    m.runtime.volumes = [{ container_path: 'etc/linkding' }];
    const r = validateManifest(m, { upstreamResolvedCommit: COMMIT });
    expect(r.ok).toBe(false);
  });

  it('rejects unknown additional fields on a volume entry', () => {
    const m = clone(V2_DOCKER_BASE);
    m.runtime.volumes = [{ container_path: '/data', unknown: 'oops' }];
    const r = validateManifest(m, { upstreamResolvedCommit: COMMIT });
    expect(r.ok).toBe(false);
  });

  it('rejects more than 10 volumes (schema cap)', () => {
    const m = clone(V2_DOCKER_BASE);
    m.runtime.volumes = Array.from({ length: 11 }, (_, i) => ({ container_path: `/v${i}` }));
    const r = validateManifest(m, { upstreamResolvedCommit: COMMIT });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => /maxItems/i.test(e.message) || /10/.test(e.message))).toBe(true);
  });

  it('rejects duplicate container_path entries (invariant)', () => {
    const m = clone(V2_DOCKER_BASE);
    m.runtime.volumes = [
      { container_path: '/etc/linkding/data' },
      { container_path: '/etc/linkding/data', persist: false },  // dup
    ];
    const r = validateManifest(m, { upstreamResolvedCommit: COMMIT });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e =>
      e.kind === 'invariant' && /duplicate container_path/.test(e.message)
    )).toBe(true);
  });

  it('rejects volumes on a non-array value (schema)', () => {
    const m = clone(V2_DOCKER_BASE);
    m.runtime.volumes = 'oops';
    const r = validateManifest(m, { upstreamResolvedCommit: COMMIT });
    expect(r.ok).toBe(false);
  });

  it('volumes is optional — manifests without it still pass', () => {
    const m = clone(V2_DOCKER_BASE);
    delete m.runtime.volumes;
    const r = validateManifest(m, { upstreamResolvedCommit: COMMIT });
    expect(r.ok).toBe(true);
  });
});
