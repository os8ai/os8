import { describe, it, expect } from 'vitest';

const { parseManifest, validateManifest } = require('../src/services/manifest-validator');

// Worldmonitor-shaped fixture (mirrors docs/phase-1-plan.md §"Phase 1A acceptance").
const WORLDMONITOR_YAML = `
schemaVersion: 1
slug: worldmonitor
name: World Monitor
publisher: koala73
icon: ./icon.png
category: intelligence
description: Real-time global intelligence dashboard.

upstream:
  git: https://github.com/koala73/worldmonitor.git
  ref: v2.5.23

framework: vite

runtime:
  kind: node
  version: "20"
  arch: [arm64, x86_64]
  package_manager: auto
  dependency_strategy: frozen

install:
  - argv: ["npm", "ci"]

start:
  argv: ["npm", "run", "dev", "--", "--port", "{{PORT}}", "--host", "127.0.0.1"]
  port: detect
  readiness:
    type: http
    path: /
    timeout_seconds: 30

surface:
  kind: web
  preview_name: World Monitor

permissions:
  network:
    outbound: true
    inbound: false
  filesystem: app-private
  os8_capabilities: []

legal:
  license: AGPL-3.0
  commercial_use: restricted

review:
  channel: verified
  risk: low
`.trim();

describe('parseManifest', () => {
  it('parses the worldmonitor manifest', () => {
    const m = parseManifest(WORLDMONITOR_YAML);
    expect(m.slug).toBe('worldmonitor');
    expect(m.runtime.kind).toBe('node');
    expect(m.start.argv).toEqual(['npm', 'run', 'dev', '--', '--port', '{{PORT}}', '--host', '127.0.0.1']);
  });

  it('throws on non-object input', () => {
    expect(() => parseManifest('a string')).toThrow();
    expect(() => parseManifest('')).toThrow();
  });
});

describe('validateManifest — happy path', () => {
  it('worldmonitor passes', () => {
    const m = parseManifest(WORLDMONITOR_YAML);
    const r = validateManifest(m, {
      upstreamResolvedCommit: 'e51058e1765ef2f0c83ccb1d08d984bc59d23f10',
    });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('manifest with an upstream tag (no resolved commit yet) passes', () => {
    const m = parseManifest(WORLDMONITOR_YAML);
    const r = validateManifest(m);
    expect(r.ok).toBe(true);
  });

  it('manifest with a SHA upstream ref passes', () => {
    const yaml = WORLDMONITOR_YAML.replace('ref: v2.5.23', 'ref: e51058e1765ef2f0c83ccb1d08d984bc59d23f10');
    const m = parseManifest(yaml);
    const r = validateManifest(m);
    expect(r.ok).toBe(true);
  });
});

describe('validateManifest — invariant errors', () => {
  it('rejects runtime.kind: docker', () => {
    const m = parseManifest(WORLDMONITOR_YAML);
    m.runtime.kind = 'docker';
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.path === '/runtime/kind' && e.kind === 'invariant')).toBe(true);
  });

  it('rejects surface.kind != web', () => {
    const m = parseManifest(WORLDMONITOR_YAML);
    m.surface.kind = 'terminal';
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.path === '/surface/kind' && e.kind === 'invariant')).toBe(true);
  });

  it('rejects filesystem != app-private', () => {
    const m = parseManifest(WORLDMONITOR_YAML);
    m.permissions.filesystem = 'host';
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.path === '/permissions/filesystem' && e.kind === 'invariant')).toBe(true);
  });

  it('rejects bad slug — uppercase', () => {
    const m = parseManifest(WORLDMONITOR_YAML);
    m.slug = 'Bad-Slug';
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.path === '/slug')).toBe(true);
  });

  it('rejects bad slug — starts with a digit', () => {
    const m = parseManifest(WORLDMONITOR_YAML);
    m.slug = '123abc';
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.path === '/slug')).toBe(true);
  });

  it('rejects shell:true on start', () => {
    const m = parseManifest(WORLDMONITOR_YAML);
    m.start.shell = true;
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.path === '/start/shell')).toBe(true);
  });

  it('rejects shell:true on install entry', () => {
    const m = parseManifest(WORLDMONITOR_YAML);
    m.install[0].shell = true;
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.path === '/install/0/shell')).toBe(true);
  });

  it('rejects upstreamResolvedCommit shorter than 40 chars', () => {
    const m = parseManifest(WORLDMONITOR_YAML);
    const r = validateManifest(m, { upstreamResolvedCommit: 'abc123' });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.path === '/upstream/ref' && e.kind === 'invariant')).toBe(true);
  });

  it('rejects verified channel without dependency_strategy: frozen', () => {
    const m = parseManifest(WORLDMONITOR_YAML);
    m.runtime.dependency_strategy = 'best-effort';
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e =>
      e.path === '/runtime/dependency_strategy' && e.kind === 'invariant'
    )).toBe(true);
  });
});

describe('validateManifest — schema errors', () => {
  it('rejects manifest missing permissions.network.inbound', () => {
    const m = parseManifest(WORLDMONITOR_YAML);
    delete m.permissions.network.inbound;
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.kind === 'schema')).toBe(true);
  });

  it('rejects manifest with unknown framework value', () => {
    const m = parseManifest(WORLDMONITOR_YAML);
    m.framework = 'snowflake';
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.kind === 'schema')).toBe(true);
  });

  it('rejects manifest with branch-form upstream.ref', () => {
    const m = parseManifest(WORLDMONITOR_YAML);
    m.upstream.ref = 'main';
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.kind === 'schema')).toBe(true);
  });
});

// PR 4.7 — os8_capabilities accepts a known enum, mcp.<server>.<tool>,
// and mcp.<server>.* — but rejects pathological wildcards that would
// grant cross-server or all-capabilities trust.
describe('validateManifest — os8_capabilities (PR 4.7 wildcards)', () => {
  function withCaps(caps) {
    const m = parseManifest(WORLDMONITOR_YAML);
    m.permissions.os8_capabilities = caps;
    return m;
  }

  it('accepts known enum capability', () => {
    const r = validateManifest(withCaps(['blob.readwrite', 'imagegen']));
    expect(r.errors.some(e => e.path?.includes('os8_capabilities'))).toBe(false);
  });

  it('accepts specific MCP tool: mcp.<server>.<tool>', () => {
    const r = validateManifest(withCaps(['mcp.tavily.search', 'mcp.gh.list_pulls']));
    expect(r.errors.some(e => e.path?.includes('os8_capabilities'))).toBe(false);
  });

  it('accepts MCP wildcard: mcp.<server>.*', () => {
    const r = validateManifest(withCaps(['mcp.gh.*']));
    expect(r.errors.some(e => e.path?.includes('os8_capabilities'))).toBe(false);
  });

  it('rejects mcp.*.* (would grant every server)', () => {
    const r = validateManifest(withCaps(['mcp.*.*']));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.path?.includes('os8_capabilities'))).toBe(true);
  });

  it('rejects bare mcp.* (would grant every server)', () => {
    const r = validateManifest(withCaps(['mcp.*']));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.path?.includes('os8_capabilities'))).toBe(true);
  });

  it('rejects mcp.<server>.*.<tool> (nested wildcard)', () => {
    const r = validateManifest(withCaps(['mcp.gh.*.review_pull']));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.path?.includes('os8_capabilities'))).toBe(true);
  });

  it('rejects unknown plain capability not in the enum', () => {
    const r = validateManifest(withCaps(['rm-rf-slash']));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.path?.includes('os8_capabilities'))).toBe(true);
  });
});
