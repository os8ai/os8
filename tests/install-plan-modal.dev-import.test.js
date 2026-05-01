/**
 * Phase 3 PR 3.2 — install-plan-modal dev-import behavior.
 *
 * Tests the gate-evaluation extensions for developer-import (risk-ack
 * required) plus the channel-tiered network warning that the security
 * review pipeline emits when dev-import + outbound network is granted.
 *
 * The DOM-mutation parts of the modal are exercised manually post-merge;
 * we focus here on the pure logic (gate eval) and the security review
 * branch in app-review.js (the user-visible signal).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { gateEvaluation } from '../src/renderer/install-plan-modal.js';

const Database = require('better-sqlite3');

const DEV_IMPORT_MANIFEST = {
  slug: 'koala73-worldmonitor',
  runtime: { kind: 'node', arch: ['arm64', 'x86_64'] },
  permissions: {
    network: { outbound: false, inbound: false },
    filesystem: 'app-private',
    os8_capabilities: [],
    secrets: [],
  },
  review: { channel: 'developer-import', risk: 'high' },
};

const baseState = (overrides = {}) => ({
  secrets: {},
  review: null,
  lastStatus: null,
  secondConfirmed: false,
  devImportMode: false,
  devImportRisksAcknowledged: false,
  ...overrides,
});

describe('install plan gate — developer-import', () => {
  it('rejects without risk acknowledgment when devImportMode is true', () => {
    const state = baseState({
      lastStatus: 'awaiting_approval',
      review: { riskLevel: 'low', findings: [] },
      devImportMode: true,
      devImportRisksAcknowledged: false,
    });
    const out = gateEvaluation(DEV_IMPORT_MANIFEST, state, 'arm64');
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/I understand the risks/);
  });

  it('passes when ack is checked AND review is clean', () => {
    const state = baseState({
      lastStatus: 'awaiting_approval',
      review: { riskLevel: 'low', findings: [] },
      devImportMode: true,
      devImportRisksAcknowledged: true,
    });
    const out = gateEvaluation(DEV_IMPORT_MANIFEST, state, 'arm64');
    expect(out.ok).toBe(true);
  });

  it('still blocks for arch mismatch even with ack', () => {
    const state = baseState({
      lastStatus: 'awaiting_approval',
      review: { riskLevel: 'low', findings: [] },
      devImportMode: true,
      devImportRisksAcknowledged: true,
    });
    const out = gateEvaluation(DEV_IMPORT_MANIFEST, state, 'mips64');
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/arch incompatible/);
  });

  it('still blocks for critical findings even with ack', () => {
    const state = baseState({
      lastStatus: 'awaiting_approval',
      review: { riskLevel: 'medium', findings: [{ severity: 'critical', category: 'supply_chain', description: 'malicious dep' }] },
      devImportMode: true,
      devImportRisksAcknowledged: true,
    });
    const out = gateEvaluation(DEV_IMPORT_MANIFEST, state, 'arm64');
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/critical findings block/);
  });

  it('verified channel is unaffected by the dev-import ack flag', () => {
    const verifiedManifest = {
      ...DEV_IMPORT_MANIFEST,
      review: { channel: 'verified' },
    };
    const state = baseState({
      lastStatus: 'awaiting_approval',
      review: { riskLevel: 'low', findings: [] },
      devImportMode: false,
    });
    const out = gateEvaluation(verifiedManifest, state, 'arm64');
    expect(out.ok).toBe(true);
  });
});

describe('AppReviewService._runStaticChecks — dev-import network warning', () => {
  let parentDir;
  let AppReviewService;

  beforeEach(() => {
    parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-rev-devimp-'));
    delete require.cache[require.resolve('../src/services/app-review')];
    AppReviewService = require('../src/services/app-review');
  });

  afterEach(() => {
    fs.rmSync(parentDir, { recursive: true, force: true });
  });

  function makeStaging(files) {
    const dir = path.join(parentDir, 'staging');
    fs.mkdirSync(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, rel), content);
    }
    return dir;
  }

  function devImportManifest({ outbound = false } = {}) {
    return {
      slug: 'koala73-fix',
      runtime: { kind: 'node', arch: ['arm64', 'x86_64'], package_manager: 'npm', dependency_strategy: 'best-effort' },
      install: [{ argv: ['npm', 'install', '--ignore-scripts'] }],
      start: { argv: ['npm', 'run', 'dev'] },
      permissions: {
        network: { outbound, inbound: false },
        filesystem: 'app-private',
        os8_capabilities: [],
      },
      review: { channel: 'developer-import' },
    };
  }

  it('emits a warning when channel=developer-import + outbound=true', () => {
    const stagingDir = makeStaging({ 'package.json': '{}' });
    const findings = AppReviewService._runStaticChecks(stagingDir, devImportManifest({ outbound: true }), {
      channel: 'developer-import', resolvedCommit: 'a'.repeat(40), hostArch: 'arm64',
    });
    expect(findings.some(f => f.severity === 'warning' && f.category === 'network')).toBe(true);
  });

  it('does NOT emit when channel=developer-import + outbound=false', () => {
    const stagingDir = makeStaging({ 'package.json': '{}' });
    const findings = AppReviewService._runStaticChecks(stagingDir, devImportManifest({ outbound: false }), {
      channel: 'developer-import', resolvedCommit: 'a'.repeat(40), hostArch: 'arm64',
    });
    expect(findings.every(f => f.category !== 'network')).toBe(true);
  });

  it('does NOT emit when channel=verified + outbound=true (existing apps)', () => {
    const stagingDir = makeStaging({ 'package.json': '{}', 'package-lock.json': '{}' });
    const m = devImportManifest({ outbound: true });
    m.review.channel = 'verified';
    m.runtime.dependency_strategy = 'frozen';
    const findings = AppReviewService._runStaticChecks(stagingDir, m, {
      channel: 'verified', resolvedCommit: 'a'.repeat(40), hostArch: 'arm64',
    });
    expect(findings.every(f => f.category !== 'network')).toBe(true);
  });
});
