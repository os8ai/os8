/**
 * SupplyChainScanner — wraps osv-scanner + safety binaries.
 *
 * Phase 3 PR 3.6. Replaces the typosquat-list stub at app-review.js with real
 * supply-chain analysis. Both tools are detected on PATH at scan time:
 *
 *   - osv-scanner (Go binary, google/osv-scanner) — covers Node, Python,
 *     and many other ecosystems. Exits non-zero when vulns are found but
 *     writes a complete JSON report to stdout, which we parse from
 *     `e.stdout` on the error path.
 *
 *   - safety (Python pip package) — Python-specific. Needs a frozen
 *     requirements.txt; we skip when only pyproject.toml/uv.lock is present.
 *
 * When neither tool is on PATH, `scan()` returns
 * `{ findings: [], osvRan: false, safetyRan: false }` and the caller
 * (AppReviewService._runStaticAnalysis) falls back to scanPythonDeps's
 * typosquat list.
 *
 * Severity mapping (phase-3-plan.md decision 14):
 *   - osv-scanner advisory id MAL-* (or aliases starting MAL-*) → critical
 *   - osv-scanner severity HIGH/CRITICAL                         → warning
 *   - osv-scanner severity MODERATE/MEDIUM/LOW                   → info
 *   - safety vulns                                               → warning
 *     (safety doesn't expose CVSS scores via the free tier, so we
 *      uniformly treat them as warning rather than overstating.)
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

async function detectTool(name) {
  try {
    await execFileAsync(name, ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run `osv-scanner scan source --format=json <stagingDir>`. Returns the
 * parsed report, or null when the tool is absent. Aggressive 90s timeout —
 * we'd rather skip on a slow run than block install.
 */
async function runOsvScanner(stagingDir) {
  if (!await detectTool('osv-scanner')) return null;
  try {
    const { stdout } = await execFileAsync(
      'osv-scanner',
      ['scan', 'source', '--format=json', stagingDir],
      { timeout: 90_000, maxBuffer: 16 * 1024 * 1024 }
    );
    return JSON.parse(stdout);
  } catch (e) {
    // osv-scanner exits non-zero when it finds vulns. The complete report is
    // still on stdout via execFile's err.stdout property.
    if (e.stdout) {
      try { return JSON.parse(e.stdout); } catch { /* fall through */ }
    }
    return { error: e.message?.slice(0, 200) || 'unknown', tool: 'osv-scanner' };
  }
}

/**
 * Run `safety check -r requirements.txt --json`. Returns null when safety
 * isn't on PATH or the staging dir lacks a requirements.txt (safety needs
 * a frozen requirements list to operate against).
 */
async function runSafety(stagingDir) {
  if (!await detectTool('safety')) return null;
  const reqPath = path.join(stagingDir, 'requirements.txt');
  if (!fs.existsSync(reqPath)) return null;
  try {
    const { stdout } = await execFileAsync(
      'safety',
      ['check', '-r', reqPath, '--json', '--continue-on-error'],
      { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }
    );
    return JSON.parse(stdout);
  } catch (e) {
    if (e.stdout) {
      try { return JSON.parse(e.stdout); } catch { /* fall through */ }
    }
    return { error: e.message?.slice(0, 200) || 'unknown', tool: 'safety' };
  }
}

function osvSeverityFor(vuln) {
  const id = vuln?.id || '';
  const aliases = Array.isArray(vuln?.aliases) ? vuln.aliases : [];
  const isMalicious = id.startsWith('MAL-') || aliases.some(a => typeof a === 'string' && a.startsWith('MAL-'));
  if (isMalicious) return 'critical';

  // osv-scanner exposes severity in two shapes depending on advisory source:
  //   - database_specific.severity: "HIGH" | "MODERATE" | ...
  //   - severity: [{ type: "CVSS_V3", score: "..." }] — raw vector string
  const raw = (vuln?.database_specific?.severity ||
               (Array.isArray(vuln?.severity) ? vuln.severity[0]?.score : '') ||
               '').toString().toUpperCase();

  if (raw.includes('CRITICAL') || raw.includes('HIGH')) return 'warning';
  if (raw.includes('MODERATE') || raw.includes('MEDIUM') || raw.includes('LOW')) return 'info';
  return 'info';
}

function osvToFindings(report) {
  if (!report || !Array.isArray(report.results)) return [];
  const findings = [];
  for (const result of report.results) {
    const sourceFile = result?.source?.path
      ? String(result.source.path).split(/[\\/]/).pop()
      : null;
    for (const pkg of (result.packages || [])) {
      const pkgName = pkg?.package?.name || 'unknown';
      const ecosystem = pkg?.package?.ecosystem || '';
      for (const vuln of (pkg.vulnerabilities || [])) {
        const severity = osvSeverityFor(vuln);
        const summary = vuln?.summary || '';
        const description = `${pkgName}@${ecosystem}: ${vuln.id || '(no id)'} ${summary}`.trim().slice(0, 240);
        findings.push({
          severity,
          category: 'supply_chain',
          file: sourceFile,
          line: null,
          description,
          snippet: '',
        });
      }
    }
  }
  return findings;
}

/**
 * Parse safety's JSON output. v3 changed the schema: older versions emit a
 * bare array; newer versions wrap it in { vulnerabilities: [...] }. Support
 * both. Each vuln becomes a `warning` finding (safety free tier doesn't
 * carry CVSS).
 */
function safetyToFindings(report) {
  if (!report) return [];
  const list = Array.isArray(report.vulnerabilities)
    ? report.vulnerabilities
    : Array.isArray(report)
      ? report
      : [];
  return list.map(v => {
    const pkg = v.package_name || v.package || 'unknown';
    const version = v.installed_version || v.version || '';
    const advisory = v.advisory || v.description || v.vulnerability_id || '';
    const description = `${pkg}@${version}: ${advisory}`.trim().slice(0, 240);
    return {
      severity: 'warning',
      category: 'supply_chain',
      file: 'requirements.txt',
      line: null,
      description,
      snippet: '',
    };
  });
}

/**
 * Run all available scanners against `stagingDir`. Returns:
 *   { findings, osvRan, safetyRan }
 *
 * `osvRan` / `safetyRan` flag whether each tool actually executed (vs. being
 * absent). The caller uses these to decide whether to fall back to the
 * legacy typosquat list.
 */
async function scan(stagingDir) {
  const findings = [];
  let osvRan = false;
  let safetyRan = false;

  const osv = await runOsvScanner(stagingDir);
  if (osv) {
    osvRan = true;
    if (osv.error) {
      findings.push({
        severity: 'info', category: 'supply_chain',
        file: null, line: null,
        description: `osv-scanner failed: ${osv.error}`,
        snippet: '',
      });
    } else {
      findings.push(...osvToFindings(osv));
    }
  }

  // safety only runs against Python projects.
  const isPython =
    fs.existsSync(path.join(stagingDir, 'pyproject.toml')) ||
    fs.existsSync(path.join(stagingDir, 'requirements.txt')) ||
    fs.existsSync(path.join(stagingDir, 'uv.lock')) ||
    fs.existsSync(path.join(stagingDir, 'poetry.lock'));
  if (isPython) {
    const sf = await runSafety(stagingDir);
    if (sf) {
      safetyRan = true;
      if (sf.error) {
        findings.push({
          severity: 'info', category: 'supply_chain',
          file: null, line: null,
          description: `safety failed: ${sf.error}`,
          snippet: '',
        });
      } else {
        findings.push(...safetyToFindings(sf));
      }
    }
  }

  return { findings, osvRan, safetyRan };
}

module.exports = {
  scan,
  detectTool,
  runOsvScanner,
  runSafety,
  osvToFindings,
  safetyToFindings,
  osvSeverityFor,
};
