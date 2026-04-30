/**
 * PR 2.5 — appspec-v2.json schema dispatch tests.
 *
 * v1 invariants stay intact (covered by tests/manifest-validator.test.js).
 * v2 adds runtime.kind=docker, runtime.image*, internal_port, gpu_passthrough.
 */

import { describe, it, expect } from 'vitest';

const { validateManifest } = require('../src/services/manifest-validator');

const V2_DOCKER = {
  schemaVersion: 2,
  slug: 'openwebui',
  name: 'Open WebUI',
  publisher: 'open-webui',
  upstream: { git: 'https://github.com/open-webui/open-webui.git', ref: 'v0.9.2' },
  runtime: {
    kind: 'docker',
    version: '1',
    image: 'ghcr.io/open-webui/open-webui:v0.9.2',
    image_digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    internal_port: 8080,
    arch: ['arm64', 'x86_64'],
  },
  start: {
    argv: [],
    port: 'detect',
    readiness: { type: 'http', path: '/health', timeout_seconds: 60 },
  },
  surface: { kind: 'web' },
  permissions: { network: { outbound: true, inbound: false }, filesystem: 'app-private' },
  legal: { license: 'BSD-3-Clause-Clear', commercial_use: 'unrestricted' },
  review: { channel: 'verified' },
};

function clone(o) { return JSON.parse(JSON.stringify(o)); }

describe('validateManifest — v2 docker happy path', () => {
  it('valid v2 docker manifest passes', () => {
    const r = validateManifest(V2_DOCKER, {
      upstreamResolvedCommit: 'a'.repeat(40),
    });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe('validateManifest — v2 docker required-fields enforcement', () => {
  it('rejects v2 docker manifest missing runtime.image', () => {
    const m = clone(V2_DOCKER);
    delete m.runtime.image;
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => /image/i.test(e.message) || /image/.test(e.path))).toBe(true);
  });

  it('rejects v2 docker manifest missing runtime.internal_port', () => {
    const m = clone(V2_DOCKER);
    delete m.runtime.internal_port;
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => /internal_port/.test(e.message) || /internal_port/.test(e.path))).toBe(true);
  });

  it('rejects v2 docker manifest missing runtime.version', () => {
    const m = clone(V2_DOCKER);
    delete m.runtime.version;
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
  });
});

describe('validateManifest — v1/v2 docker dispatch', () => {
  it('v1 manifest with runtime.kind=docker is rejected by invariant', () => {
    const m = clone(V2_DOCKER);
    m.schemaVersion = 1;
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e =>
      e.path === '/runtime/kind' && /schemaVersion: 2/.test(e.message)
    )).toBe(true);
  });

  it('v2 manifest with runtime.kind=docker passes the v1-rejection invariant', () => {
    const r = validateManifest(V2_DOCKER, {
      upstreamResolvedCommit: 'a'.repeat(40),
    });
    expect(r.errors.find(e => /docker runtime requires/.test(e.message))).toBeUndefined();
  });

  it('Verified-channel docker without image_digest fails', () => {
    const m = clone(V2_DOCKER);
    delete m.runtime.image_digest;
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e =>
      /must pin image by digest/.test(e.message)
    )).toBe(true);
  });

  it('Verified-channel docker bypasses the dependency_strategy requirement', () => {
    // Docker manifests don't have dependency_strategy.
    const r = validateManifest(V2_DOCKER, { upstreamResolvedCommit: 'a'.repeat(40) });
    expect(r.errors.find(e => /dependency_strategy/.test(e.message))).toBeUndefined();
  });

  it('community-channel docker without image_digest passes (non-blocking)', () => {
    const m = clone(V2_DOCKER);
    delete m.runtime.image_digest;
    m.review.channel = 'community';
    const r = validateManifest(m);
    expect(r.errors.find(e => /must pin image by digest/.test(e.message))).toBeUndefined();
  });
});

describe('validateManifest — v2 image_digest format', () => {
  it('rejects malformed digest', () => {
    const m = clone(V2_DOCKER);
    m.runtime.image_digest = 'not-a-digest';
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
  });

  it('accepts well-formed digest', () => {
    const m = clone(V2_DOCKER);
    m.runtime.image_digest = 'sha256:' + 'd'.repeat(64);
    const r = validateManifest(m, { upstreamResolvedCommit: 'a'.repeat(40) });
    expect(r.ok).toBe(true);
  });
});
