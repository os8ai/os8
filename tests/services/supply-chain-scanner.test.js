/**
 * Phase 3 PR 3.6 — supply-chain-scanner unit tests.
 *
 * The scanner shells out to two optional CLIs (osv-scanner, safety). Tests
 * monkey-patch child_process.execFile so we can drive every scenario
 * (tool-absent, valid JSON, non-zero exit with stdout, parse failure).
 *
 * The pattern mirrors tests/services/cli-runner-opencode.test.js:
 * patch the real child_process module reference and restore in afterEach.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import util from 'util';

const realChildProcess = require('child_process');

function loadScanner() {
  delete require.cache[require.resolve('../../src/services/supply-chain-scanner')];
  return require('../../src/services/supply-chain-scanner');
}

// Build a fake execFile that routes the (cmd, args, opts, callback) signature
// to a per-cmd handler. Node's real execFile defines a util.promisify.custom
// that resolves to { stdout, stderr } (instead of plain stdout); we mirror
// that here so promisify(fakeExecFile) preserves the same surface as the
// real one — otherwise the supply-chain-scanner code, which destructures
// `{ stdout } = await execFileAsync(...)`, sees `undefined`.
function makeFakeExecFile(handlers) {
  function fake(cmd, args, opts, callback) {
    if (typeof opts === 'function') { callback = opts; opts = {}; }
    const handler = handlers[cmd];
    if (!handler) {
      const err = new Error(`spawn ${cmd} ENOENT`);
      err.code = 'ENOENT';
      setImmediate(() => callback(err));
      return { kill: () => {} };
    }
    setImmediate(() => handler(args, opts, callback));
    return { kill: () => {} };
  }
  fake[util.promisify.custom] = (cmd, args, opts) => new Promise((resolve, reject) => {
    fake(cmd, args, opts, (err, stdout, stderr) => {
      if (err) {
        // Mirror real execFile rejection shape: stdout/stderr attached to err.
        if (stdout !== undefined) err.stdout = stdout;
        if (stderr !== undefined) err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
  return fake;
}

describe('SupplyChainScanner — unit', () => {
  let parentDir;
  let originalExecFile;
  let Scanner;

  beforeEach(() => {
    parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-scan-'));
    originalExecFile = realChildProcess.execFile;
    Scanner = loadScanner();
  });

  afterEach(() => {
    realChildProcess.execFile = originalExecFile;
    fs.rmSync(parentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('detectTool returns false when ENOENT', async () => {
    realChildProcess.execFile = makeFakeExecFile({});
    Scanner = loadScanner();
    expect(await Scanner.detectTool('does-not-exist')).toBe(false);
  });

  it('detectTool returns true when binary exits 0', async () => {
    realChildProcess.execFile = makeFakeExecFile({
      'osv-scanner': (_args, _opts, cb) => cb(null, 'osv-scanner 1.0.0\n', ''),
    });
    Scanner = loadScanner();
    expect(await Scanner.detectTool('osv-scanner')).toBe(true);
  });

  it('runOsvScanner returns null when tool absent', async () => {
    realChildProcess.execFile = makeFakeExecFile({});
    Scanner = loadScanner();
    expect(await Scanner.runOsvScanner(parentDir)).toBeNull();
  });

  it('runOsvScanner parses valid JSON when tool present', async () => {
    const report = { results: [{ packages: [] }] };
    realChildProcess.execFile = makeFakeExecFile({
      'osv-scanner': (args, _opts, cb) => {
        if (args.includes('--version')) return cb(null, '1.0.0\n', '');
        cb(null, JSON.stringify(report), '');
      },
    });
    Scanner = loadScanner();
    expect(await Scanner.runOsvScanner(parentDir)).toEqual(report);
  });

  it('runOsvScanner reads stdout from non-zero exit (vulns found path)', async () => {
    const report = { results: [{ source: { path: 'package-lock.json' }, packages: [] }] };
    realChildProcess.execFile = makeFakeExecFile({
      'osv-scanner': (args, _opts, cb) => {
        if (args.includes('--version')) return cb(null, '1.0.0\n', '');
        // Mimic execFile's shape on non-zero exit: error has stdout attached.
        const err = new Error('Command failed: osv-scanner ...');
        err.code = 1;
        err.stdout = JSON.stringify(report);
        err.stderr = '';
        cb(err, err.stdout, err.stderr);
      },
    });
    Scanner = loadScanner();
    expect(await Scanner.runOsvScanner(parentDir)).toEqual(report);
  });

  it('runOsvScanner returns error envelope on hard failure', async () => {
    realChildProcess.execFile = makeFakeExecFile({
      'osv-scanner': (args, _opts, cb) => {
        if (args.includes('--version')) return cb(null, '1.0.0\n', '');
        cb(new Error('out of memory'));
      },
    });
    Scanner = loadScanner();
    const r = await Scanner.runOsvScanner(parentDir);
    expect(r.tool).toBe('osv-scanner');
    expect(r.error).toMatch(/out of memory/);
  });

  it('runSafety returns null when tool absent', async () => {
    fs.writeFileSync(path.join(parentDir, 'requirements.txt'), 'flask\n');
    realChildProcess.execFile = makeFakeExecFile({});
    Scanner = loadScanner();
    expect(await Scanner.runSafety(parentDir)).toBeNull();
  });

  it('runSafety returns null when requirements.txt missing', async () => {
    realChildProcess.execFile = makeFakeExecFile({
      'safety': (args, _opts, cb) => {
        if (args.includes('--version')) return cb(null, '3.0.0\n', '');
        cb(null, '[]', '');
      },
    });
    Scanner = loadScanner();
    expect(await Scanner.runSafety(parentDir)).toBeNull();
  });

  it('osvSeverityFor: MAL-* id → critical', () => {
    expect(Scanner.osvSeverityFor({ id: 'MAL-2024-1234' })).toBe('critical');
  });

  it('osvSeverityFor: MAL-* alias → critical even when id is GHSA', () => {
    expect(Scanner.osvSeverityFor({
      id: 'GHSA-aaaa-bbbb-cccc',
      aliases: ['MAL-2024-9999'],
    })).toBe('critical');
  });

  it('osvSeverityFor: HIGH severity → warning', () => {
    expect(Scanner.osvSeverityFor({
      id: 'GHSA-x',
      database_specific: { severity: 'HIGH' },
    })).toBe('warning');
  });

  it('osvSeverityFor: MODERATE severity → info', () => {
    expect(Scanner.osvSeverityFor({
      id: 'GHSA-x',
      database_specific: { severity: 'MODERATE' },
    })).toBe('info');
  });

  it('osvSeverityFor: unknown shape → info (safe default)', () => {
    expect(Scanner.osvSeverityFor({ id: 'GHSA-x' })).toBe('info');
  });

  it('osvToFindings emits warning for HIGH-severity vuln with package + advisory', () => {
    const report = {
      results: [{
        source: { path: '/staging/package-lock.json' },
        packages: [{
          package: { name: 'lodash', ecosystem: 'npm' },
          vulnerabilities: [{
            id: 'GHSA-35jh-r3h4-6jhm',
            summary: 'Command Injection in lodash',
            database_specific: { severity: 'HIGH' },
          }],
        }],
      }],
    };
    const findings = Scanner.osvToFindings(report);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].category).toBe('supply_chain');
    expect(findings[0].file).toBe('package-lock.json');
    expect(findings[0].description).toContain('lodash@npm');
    expect(findings[0].description).toContain('GHSA-35jh-r3h4-6jhm');
  });

  it('osvToFindings emits critical for MAL-prefixed advisory', () => {
    const report = {
      results: [{
        source: { path: 'requirements.txt' },
        packages: [{
          package: { name: 'requestes', ecosystem: 'PyPI' },
          vulnerabilities: [{ id: 'MAL-2024-1234', summary: 'Typosquat of requests' }],
        }],
      }],
    };
    const findings = Scanner.osvToFindings(report);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].description).toContain('requestes');
    expect(findings[0].description).toContain('MAL-2024-1234');
  });

  it('osvToFindings handles missing/empty fields without throwing', () => {
    expect(Scanner.osvToFindings(null)).toEqual([]);
    expect(Scanner.osvToFindings({})).toEqual([]);
    expect(Scanner.osvToFindings({ results: [] })).toEqual([]);
    expect(Scanner.osvToFindings({ results: [{ packages: [] }] })).toEqual([]);
  });

  it('safetyToFindings handles new {vulnerabilities: []} shape', () => {
    const report = {
      vulnerabilities: [
        { package_name: 'flask', installed_version: '2.0.0', advisory: 'CVE-2023-30861' },
      ],
    };
    const findings = Scanner.safetyToFindings(report);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].category).toBe('supply_chain');
    expect(findings[0].file).toBe('requirements.txt');
    expect(findings[0].description).toContain('flask@2.0.0');
    expect(findings[0].description).toContain('CVE-2023-30861');
  });

  it('safetyToFindings handles legacy bare-array shape', () => {
    const report = [
      { package: 'flask', version: '2.0.0', description: 'CVE-2023-30861' },
    ];
    const findings = Scanner.safetyToFindings(report);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain('flask@2.0.0');
  });

  it('safetyToFindings returns [] for empty/missing report', () => {
    expect(Scanner.safetyToFindings(null)).toEqual([]);
    expect(Scanner.safetyToFindings({})).toEqual([]);
    expect(Scanner.safetyToFindings([])).toEqual([]);
  });

  it('scan() with neither tool present returns empty + both flags false', async () => {
    fs.writeFileSync(path.join(parentDir, 'package.json'), '{}');
    realChildProcess.execFile = makeFakeExecFile({});
    Scanner = loadScanner();
    const r = await Scanner.scan(parentDir);
    expect(r).toEqual({ findings: [], osvRan: false, safetyRan: false });
  });

  it('scan() with osv-scanner present, no python lockfile, runs osv only', async () => {
    fs.writeFileSync(path.join(parentDir, 'package.json'), '{}');
    const report = {
      results: [{
        source: { path: 'package-lock.json' },
        packages: [{
          package: { name: 'lodash', ecosystem: 'npm' },
          vulnerabilities: [{
            id: 'GHSA-35jh-r3h4-6jhm',
            database_specific: { severity: 'HIGH' },
          }],
        }],
      }],
    };
    realChildProcess.execFile = makeFakeExecFile({
      'osv-scanner': (args, _opts, cb) => {
        if (args.includes('--version')) return cb(null, '1.0.0\n', '');
        cb(null, JSON.stringify(report), '');
      },
    });
    Scanner = loadScanner();
    const r = await Scanner.scan(parentDir);
    expect(r.osvRan).toBe(true);
    expect(r.safetyRan).toBe(false);
    expect(r.findings.some(f => f.severity === 'warning' && f.description.includes('lodash'))).toBe(true);
  });

  it('scan() with both tools present and a Python project runs both', async () => {
    fs.writeFileSync(path.join(parentDir, 'requirements.txt'), 'flask==2.0.0\n');
    realChildProcess.execFile = makeFakeExecFile({
      'osv-scanner': (args, _opts, cb) => {
        if (args.includes('--version')) return cb(null, '1.0.0\n', '');
        cb(null, JSON.stringify({ results: [] }), '');
      },
      'safety': (args, _opts, cb) => {
        if (args.includes('--version')) return cb(null, '3.0.0\n', '');
        cb(null, JSON.stringify({
          vulnerabilities: [
            { package_name: 'flask', installed_version: '2.0.0', advisory: 'CVE-2023-30861' },
          ],
        }), '');
      },
    });
    Scanner = loadScanner();
    const r = await Scanner.scan(parentDir);
    expect(r.osvRan).toBe(true);
    expect(r.safetyRan).toBe(true);
    expect(r.findings.some(f => f.description.includes('flask'))).toBe(true);
  });

  it('scan() surfaces osv error envelope as info finding rather than throwing', async () => {
    realChildProcess.execFile = makeFakeExecFile({
      'osv-scanner': (args, _opts, cb) => {
        if (args.includes('--version')) return cb(null, '1.0.0\n', '');
        cb(new Error('disk full'));
      },
    });
    Scanner = loadScanner();
    const r = await Scanner.scan(parentDir);
    expect(r.osvRan).toBe(true);
    expect(r.findings.some(f => f.severity === 'info' && /osv-scanner failed/.test(f.description))).toBe(true);
  });
});
