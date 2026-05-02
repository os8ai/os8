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
import { gateEvaluation, assembleSetupArgv } from '../src/renderer/install-plan-modal.js';

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

  // Hotfix regression — Leo reported the Install button stayed disabled
  // even after ticking the ack. Root cause: the modal opens before any
  // install job is started, so lastStatus is null and the
  // `lastStatus !== 'awaiting_approval'` gate blocked the first click.
  // The first click is meant to kick the pipeline (installFromManifest).
  it('passes for first-click when ack is checked but no job has started yet', () => {
    const state = baseState({
      lastStatus: null,
      review: null,
      jobId: null,
      devImportMode: true,
      devImportRisksAcknowledged: true,
    });
    const out = gateEvaluation(DEV_IMPORT_MANIFEST, state, 'arm64');
    expect(out.ok).toBe(true);
  });

  it('still rejects the first click when ack is unchecked', () => {
    const state = baseState({
      lastStatus: null,
      review: null,
      jobId: null,
      devImportMode: true,
      devImportRisksAcknowledged: false,
    });
    const out = gateEvaluation(DEV_IMPORT_MANIFEST, state, 'arm64');
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/I understand the risks/);
  });

  it('still rejects the first click when arch is incompatible', () => {
    const state = baseState({
      lastStatus: null,
      review: null,
      jobId: null,
      devImportMode: true,
      devImportRisksAcknowledged: true,
    });
    const out = gateEvaluation(DEV_IMPORT_MANIFEST, state, 'mips64');
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/arch incompatible/);
  });

  it('once a job is in flight, falls through to the review-status gate', () => {
    const state = baseState({
      // Job started, but review hasn't completed yet.
      lastStatus: 'reviewing',
      review: null,
      jobId: 'job-abc',
      devImportMode: true,
      devImportRisksAcknowledged: true,
    });
    const out = gateEvaluation(DEV_IMPORT_MANIFEST, state, 'arm64');
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/review not yet complete/);
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

  // PR 3.10 hotfix: scan results are advisory across all channels — the user
  // is always the final authority. Critical findings (and high-risk, and
  // medium-risk) become override paths instead of hard blocks.

  it('critical findings on dev-import → override (not hard block)', () => {
    const state = baseState({
      lastStatus: 'awaiting_approval',
      review: { riskLevel: 'medium', findings: [{ severity: 'critical', category: 'supply_chain', description: 'malicious dep' }] },
      devImportMode: true,
      devImportRisksAcknowledged: true,
      secondConfirmed: false,
    });
    const out = gateEvaluation(DEV_IMPORT_MANIFEST, state, 'arm64');
    expect(out.ok).toBe('override');
    expect(out.reason).toMatch(/critical finding.*confirm to override/);
  });

  it('critical findings on dev-import + secondConfirmed → ok', () => {
    const state = baseState({
      lastStatus: 'awaiting_approval',
      review: { riskLevel: 'medium', findings: [{ severity: 'critical', category: 'supply_chain', description: 'malicious dep' }] },
      devImportMode: true,
      devImportRisksAcknowledged: true,
      secondConfirmed: true,
    });
    const out = gateEvaluation(DEV_IMPORT_MANIFEST, state, 'arm64');
    expect(out.ok).toBe(true);
  });

  it('critical findings on VERIFIED channel → also override (user is the final authority)', () => {
    const verifiedManifest = { ...DEV_IMPORT_MANIFEST, review: { channel: 'verified' } };
    const state = baseState({
      lastStatus: 'awaiting_approval',
      review: { riskLevel: 'medium', findings: [{ severity: 'critical', category: 'supply_chain', description: 'sketchy' }] },
      devImportMode: false,
      secondConfirmed: false,
    });
    const out = gateEvaluation(verifiedManifest, state, 'arm64');
    expect(out.ok).toBe('override');
    expect(out.reason).toMatch(/critical finding.*confirm/);
  });

  it('MAL-* malware advisory adds the malware-warning hint to the gate reason', () => {
    const state = baseState({
      lastStatus: 'awaiting_approval',
      review: {
        riskLevel: 'high',
        findings: [{ severity: 'critical', category: 'supply_chain', description: 'requestes@PyPI: MAL-2024-1234 Typosquat of requests' }],
      },
      devImportMode: true,
      devImportRisksAcknowledged: true,
      secondConfirmed: false,
    });
    const out = gateEvaluation(DEV_IMPORT_MANIFEST, state, 'arm64');
    expect(out.ok).toBe('override');
    expect(out.reason).toMatch(/CRITICAL.*malware advisory.*confirm/);
  });

  it('high risk on dev-import → override on first click', () => {
    const state = baseState({
      lastStatus: 'awaiting_approval',
      review: { riskLevel: 'high', findings: [] },
      devImportMode: true,
      devImportRisksAcknowledged: true,
      secondConfirmed: false,
    });
    const out = gateEvaluation(DEV_IMPORT_MANIFEST, state, 'arm64');
    expect(out.ok).toBe('override');
    expect(out.reason).toMatch(/high risk.*confirm to override/);
  });

  it('high risk on VERIFIED channel → also override (no longer hard-blocked)', () => {
    const verifiedManifest = { ...DEV_IMPORT_MANIFEST, review: { channel: 'verified' } };
    const state = baseState({
      lastStatus: 'awaiting_approval',
      review: { riskLevel: 'high', findings: [] },
      devImportMode: false,
      secondConfirmed: false,
    });
    const out = gateEvaluation(verifiedManifest, state, 'arm64');
    expect(out.ok).toBe('override');
    expect(out.reason).toMatch(/high risk.*confirm/);
  });

  it('arch incompatibility remains a hard block (structural impossibility)', () => {
    const state = baseState({
      lastStatus: 'awaiting_approval',
      review: { riskLevel: 'low', findings: [] },
      devImportMode: true,
      devImportRisksAcknowledged: true,
      secondConfirmed: true,
    });
    const out = gateEvaluation(DEV_IMPORT_MANIFEST, state, 'mips64');
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/arch incompatible/);
  });

  it('dev-import ack flag still required even when scan is clean', () => {
    const state = baseState({
      lastStatus: 'awaiting_approval',
      review: { riskLevel: 'low', findings: [] },
      devImportMode: true,
      devImportRisksAcknowledged: false,
      secondConfirmed: true,
    });
    const out = gateEvaluation(DEV_IMPORT_MANIFEST, state, 'arm64');
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/I understand the risks/);
  });

  it('verified channel low-risk + clean review → ok:true (no override needed)', () => {
    const verifiedManifest = { ...DEV_IMPORT_MANIFEST, review: { channel: 'verified' } };
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

// ───────────────────────────────────────────────────────────────────
// Tier 2A follow-up — argparse choices dropdown
// ───────────────────────────────────────────────────────────────────
//
// `extractArgChoices` extends PR #36's "default-uncheck and warn" with
// a guided dropdown so the user can pick a value without leaving the
// modal. This test covers the pure helper (assembleSetupArgv) directly
// + asserts the modal source contains the wiring (no JSDOM in this
// project, same pattern as app-start-failure-modal-class.test.js).

describe('assembleSetupArgv — pure helper', () => {
  it('returns the candidate argv unchanged when argChoices is empty', () => {
    const candidate = { argv: ['python', 'scripts/setup.py'], argChoices: {} };
    expect(assembleSetupArgv(candidate, {})).toEqual(['python', 'scripts/setup.py']);
  });

  it('appends chosen flag/value pairs to the argv', () => {
    const candidate = {
      argv: ['python', 'scripts/download_model.py'],
      argChoices: { '--models': ['hivision_modnet', 'all'] },
    };
    expect(assembleSetupArgv(candidate, { '--models': 'hivision_modnet' }))
      .toEqual(['python', 'scripts/download_model.py', '--models', 'hivision_modnet']);
  });

  it('skips flags whose value is empty/missing (caller guarantees the row is disabled in that case)', () => {
    const candidate = {
      argv: ['python', 'x.py'],
      argChoices: { '--a': ['1', '2'], '--b': ['x', 'y'] },
    };
    expect(assembleSetupArgv(candidate, { '--a': '1' }))
      .toEqual(['python', 'x.py', '--a', '1']);
    expect(assembleSetupArgv(candidate, {}))
      .toEqual(['python', 'x.py']);
  });

  it('does not mutate the candidate.argv reference', () => {
    const argv = ['python', 'x.py'];
    const candidate = { argv, argChoices: { '--m': ['a'] } };
    assembleSetupArgv(candidate, { '--m': 'a' });
    expect(argv).toEqual(['python', 'x.py']);
  });

  it('treats a missing argChoices field as "no choices" (forward compat with older drafter output)', () => {
    const candidate = { argv: ['python', 'x.py'] };
    expect(assembleSetupArgv(candidate, { '--m': 'ignored' })).toEqual(['python', 'x.py']);
  });
});

describe('install-plan-modal — argparse choices wiring (source-level)', () => {
  // No JSDOM. Static source checks guard against the wiring being
  // silently dropped by a future refactor.
  const MODAL_PATH = path.join(__dirname, '..', 'src', 'renderer', 'install-plan-modal.js');

  it('renders a <select data-setup-script-choice ...> per flag', () => {
    const src = fs.readFileSync(MODAL_PATH, 'utf8');
    expect(src).toMatch(/data-setup-script-choice/);
    expect(src).toMatch(/<select\s[^>]*data-setup-script-choice/);
  });

  it("emits the empty '— pick a value —' option so the dropdown starts unselected", () => {
    const src = fs.readFileSync(MODAL_PATH, 'utf8');
    expect(src).toMatch(/pick a value/);
    expect(src).toMatch(/<option value="">/);
  });

  it("disables the candidate's checkbox while any flag is unpicked", () => {
    const src = fs.readFileSync(MODAL_PATH, 'utf8');
    // The disabled attribute is keyed off setupScriptHasUnpickedChoices().
    expect(src).toMatch(/setupScriptHasUnpickedChoices/);
    expect(src).toMatch(/hasUnpicked\s*\?\s*['"]disabled['"]/);
  });

  it('binds a change handler on every [data-setup-script-choice] select', () => {
    const src = fs.readFileSync(MODAL_PATH, 'utf8');
    expect(src).toMatch(/querySelectorAll\(['"]\[data-setup-script-choice\]['"]\)/);
  });

  it('Install click uses assembleSetupArgv (not raw s.argv) so chosen values reach postInstall', () => {
    const src = fs.readFileSync(MODAL_PATH, 'utf8');
    // The .map(s => ({ argv: ... })) site that builds postInstall additions
    // must thread through assembleSetupArgv.
    expect(src).toMatch(/assembleSetupArgv\(s,\s*state\.setupScriptArgChoices/);
  });

  it('startState seeds setupScriptArgChoices as an empty object (not undefined)', () => {
    const src = fs.readFileSync(MODAL_PATH, 'utf8');
    expect(src).toMatch(/setupScriptArgChoices:\s*\{\}/);
  });
});
