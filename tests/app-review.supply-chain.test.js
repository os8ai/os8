/**
 * Phase 3 PR 3.6 — supply-chain integration into AppReviewService.
 *
 * Verifies:
 *   - Scanner findings flow through _runStaticAnalysis into the review report
 *   - MAL-* (critical) findings roll riskLevel up to 'high'
 *   - When neither tool ran AND a Python manifest is present, the typosquat
 *     fallback fires AND the "no scanner available" info finding is emitted
 *   - Node-only repos don't get the Python fallback even when scanner ran empty
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const Database = require('better-sqlite3');

const VALID_MANIFEST = {
  schemaVersion: 1,
  slug: 'fixture',
  name: 'Fixture',
  publisher: 'tester',
  upstream: { git: 'https://github.com/example/fixture.git', ref: 'v1.0.0' },
  framework: 'vite',
  runtime: { kind: 'node', arch: ['arm64', 'x86_64'], package_manager: 'npm', dependency_strategy: 'frozen' },
  install: [{ argv: ['npm', 'ci'] }],
  start: { argv: ['npm', 'run', 'dev'], port: 'detect', readiness: { type: 'http', path: '/' } },
  surface: { kind: 'web' },
  permissions: {
    network: { outbound: true, inbound: false },
    filesystem: 'app-private',
    os8_capabilities: [],
  },
  legal: { license: 'MIT', commercial_use: 'unrestricted' },
  review: { channel: 'verified' },
};

function makeStagingDir(parentDir, files = {}) {
  const dir = path.join(parentDir, 'staging');
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

describe('AppReviewService — supply-chain scanner integration', () => {
  let parentDir;
  let db;
  let AppReviewService;
  let Scanner;
  let Shared;
  let runReviewSpy;
  let scanSpy;

  beforeEach(() => {
    parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-rev-sc-'));
    delete require.cache[require.resolve('../src/services/supply-chain-scanner')];
    delete require.cache[require.resolve('../src/services/app-review')];
    delete require.cache[require.resolve('../src/services/security-review-shared')];
    Scanner = require('../src/services/supply-chain-scanner');
    AppReviewService = require('../src/services/app-review');
    Shared = require('../src/services/security-review-shared').Shared;
    scanSpy = vi.spyOn(Scanner, 'scan');
    runReviewSpy = vi.spyOn(Shared, 'runReview');
    db = new Database(':memory:');
  });

  afterEach(() => {
    scanSpy.mockRestore();
    runReviewSpy.mockRestore();
    db.close();
    fs.rmSync(parentDir, { recursive: true, force: true });
  });

  it('scanner warning finding flows through _runStaticAnalysis', async () => {
    scanSpy.mockResolvedValue({
      osvRan: true,
      safetyRan: false,
      findings: [{
        severity: 'warning', category: 'supply_chain',
        file: 'package-lock.json', line: null,
        description: 'lodash@npm: GHSA-35jh-r3h4-6jhm Command Injection',
        snippet: '',
      }],
    });
    const stagingDir = makeStagingDir(parentDir, {
      'package.json': JSON.stringify({ name: 'fix', dependencies: { lodash: '4.17.20' } }),
      'package-lock.json': '{}',
    });
    const findings = await AppReviewService._runStaticAnalysis(stagingDir, VALID_MANIFEST);
    expect(findings.some(f => f.severity === 'warning' && /lodash/.test(f.description))).toBe(true);
    expect(scanSpy).toHaveBeenCalledOnce();
  });

  it('MAL-* critical finding rolls full review riskLevel to high', async () => {
    scanSpy.mockResolvedValue({
      osvRan: true,
      safetyRan: true,
      findings: [{
        severity: 'critical', category: 'supply_chain',
        file: 'requirements.txt', line: null,
        description: 'requestes@PyPI: MAL-2024-1234 Typosquat of requests',
        snippet: '',
      }],
    });
    runReviewSpy.mockResolvedValue({
      riskLevel: 'low',
      findings: [],
      trustAssessment: {},
      summary: 'looks fine',
    });
    const stagingDir = makeStagingDir(parentDir, {
      'package.json': JSON.stringify({ scripts: { dev: 'vite' } }),
      'package-lock.json': '{}',
      'requirements.txt': 'requestes==1.0.0\n',
    });
    const result = await AppReviewService.review(db, stagingDir, VALID_MANIFEST, {
      channel: 'verified', resolvedCommit: 'a'.repeat(40), hostArch: 'arm64',
    });
    expect(result.riskLevel).toBe('high');
    expect(result.findings.some(f => f.severity === 'critical' && /MAL-2024-1234/.test(f.description))).toBe(true);
  });

  it('when neither tool ran AND Python manifest present → typosquat fallback fires', async () => {
    scanSpy.mockResolvedValue({ osvRan: false, safetyRan: false, findings: [] });
    const stagingDir = makeStagingDir(parentDir, {
      'requirements.txt': 'requestes==1.0.0\nflask==2.0.0\n',
    });
    const findings = await AppReviewService._runStaticAnalysis(stagingDir, VALID_MANIFEST);
    expect(findings.some(f => /no supply-chain scanner found/.test(f.description))).toBe(true);
    expect(findings.some(f => /requestes/.test(f.description))).toBe(true);
  });

  it('when osv-scanner ran on a Python repo → fallback does NOT fire', async () => {
    scanSpy.mockResolvedValue({ osvRan: true, safetyRan: false, findings: [] });
    const stagingDir = makeStagingDir(parentDir, {
      'requirements.txt': 'requestes==1.0.0\n',  // would match typosquat list, but fallback shouldn't run
    });
    const findings = await AppReviewService._runStaticAnalysis(stagingDir, VALID_MANIFEST);
    expect(findings.every(f => !/no supply-chain scanner found/.test(f.description))).toBe(true);
    expect(findings.every(f => !/typosquat entry/.test(f.description))).toBe(true);
  });

  it('Node-only repo with scanner empty → no Python fallback even when scanner returned no findings', async () => {
    scanSpy.mockResolvedValue({ osvRan: false, safetyRan: false, findings: [] });
    const stagingDir = makeStagingDir(parentDir, {
      'package.json': JSON.stringify({ scripts: { dev: 'vite' } }),
      'package-lock.json': '{}',
    });
    const findings = await AppReviewService._runStaticAnalysis(stagingDir, VALID_MANIFEST);
    expect(findings.every(f => !/no supply-chain scanner found/.test(f.description))).toBe(true);
    expect(findings.every(f => !/python dep/.test(f.description))).toBe(true);
  });

  it('scanner throw becomes an info finding rather than crashing review', async () => {
    scanSpy.mockRejectedValue(new Error('scanner went up in flames'));
    const stagingDir = makeStagingDir(parentDir, {
      'package.json': JSON.stringify({ scripts: { dev: 'vite' } }),
      'package-lock.json': '{}',
    });
    const findings = await AppReviewService._runStaticAnalysis(stagingDir, VALID_MANIFEST);
    expect(findings.some(f => f.severity === 'info' && /supply-chain scan failed/.test(f.description))).toBe(true);
  });

  it('uses tests/fixtures/vulnerable-node fixture as a staging dir', async () => {
    scanSpy.mockResolvedValue({
      osvRan: true,
      safetyRan: false,
      findings: [{
        severity: 'warning', category: 'supply_chain',
        file: 'package-lock.json', line: null,
        description: 'lodash@npm: GHSA-35jh-r3h4-6jhm prototype pollution',
        snippet: '',
      }],
    });
    runReviewSpy.mockResolvedValue({ riskLevel: 'low', findings: [], summary: 'ok', trustAssessment: {} });
    const fixtureDir = path.resolve(__dirname, 'fixtures', 'vulnerable-node');
    const result = await AppReviewService.review(db, fixtureDir, VALID_MANIFEST, {
      channel: 'verified', resolvedCommit: 'a'.repeat(40), hostArch: 'arm64',
    });
    // Warning rolls 'low' → 'medium'.
    expect(result.riskLevel).toBe('medium');
    expect(result.findings.some(f => /lodash/.test(f.description))).toBe(true);
  });

  it('uses tests/fixtures/malicious-python fixture for the typosquat fallback', async () => {
    scanSpy.mockResolvedValue({ osvRan: false, safetyRan: false, findings: [] });
    const fixtureDir = path.resolve(__dirname, 'fixtures', 'malicious-python');
    const findings = await AppReviewService._runStaticAnalysis(fixtureDir, VALID_MANIFEST);
    expect(findings.some(f => /no supply-chain scanner found/.test(f.description))).toBe(true);
    expect(findings.some(f => /requestes/.test(f.description) && /typosquat/.test(f.description))).toBe(true);
  });
});
