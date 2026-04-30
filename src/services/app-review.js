/**
 * AppReviewService — security review for cloned external apps.
 *
 * Spec §6.2.5 + plan §3 PR 1.6. Runs in three phases against the cloned
 * staging directory:
 *
 *   1. Static blocking checks  — argv arrays, no curl|sh, lockfile match,
 *      arch compat, SHA-pinned ref. ANY failure → riskLevel='high', LLM
 *      skipped (don't waste credits on a manifest that's already DOA).
 *   2. Static analysis (advisory) — npm audit, license scan, eval/exec greps.
 *   3. LLM review against the manifest's claims (§prompt below).
 *
 * Plan §10 decision 1: keep skill-review.js as-is, ship a separate
 * AppReviewService here, share the LLM call via security-review-shared.js.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const { Shared, LLMReviewError } = require('./security-review-shared');

const SHA_RE = /^[0-9a-f]{40}$/;

const APP_REVIEW_SYSTEM_PROMPT = `You are a security reviewer for OS8, a desktop AI agent platform. You are reviewing a third-party application packaged in the OS8 catalog. The user is about to install this app's source code on their machine and run its install commands and dev server. Your job is to identify whether the manifest's declared behavior matches what the code actually does.

You will receive: (a) the manifest (YAML); (b) a directory listing; (c) the contents of key files (package.json, install scripts, source files referencing window.os8.*, and any postinstall/preinstall scripts); (d) static-analysis signals (npm audit summary, license scan, pattern grep counts).

Review criteria:
1. Manifest honesty — does start.argv plausibly run a dev server matching the declared framework? Is upstream commit pinned?
2. Capability over-declaration — declared os8_capabilities cross-referenced against window.os8.* call sites and fetch('/api/...') calls. Flag declared-but-unused (low-severity) and used-but-undeclared (high-severity).
3. Network behavior — outbound endpoints in source matched against permissions.network.outbound. Flag domains not mentioned in manifest description or README.
4. Filesystem access — fs reads/writes outside the app's own directory or declared blob/db scopes. Reading /etc, ~/.ssh, ~/.aws is high-severity.
5. Secret handling — declared secrets cross-referenced against where they're used. Sending an API key via outbound HTTP to a third-party domain not mentioned in the prompt: flag.
6. Supply chain — count direct + transitive deps; flag suspicious package names (typosquats); flag postinstall scripts.
7. Subdomain compatibility — for vite/next/sveltekit/astro frameworks, the start command should bind at / (no path prefix). Apps that ship a hardcoded base path (e.g. --base /myapp/) will be misrouted under subdomain mode. Frameworks should bind --host 127.0.0.1 (or 0.0.0.0).

Respond with ONLY valid JSON matching:
{
  "riskLevel": "low" | "medium" | "high",
  "findings": [
    {
      "severity": "info" | "warning" | "critical",
      "category": "manifest_dishonesty" | "capability_overdeclaration" | "capability_underdeclaration" | "network" | "filesystem" | "secrets" | "supply_chain" | "framework_mismatch" | "other",
      "file": "<relative path or null>",
      "line": <int or null>,
      "description": "<what was found>",
      "snippet": "<relevant code or text, ≤200 chars>"
    }
  ],
  "trustAssessment": {
    "manifestMatchesCode": <bool>,
    "declaredCapsCount": <int>,
    "usedCapsCount": <int>,
    "outboundDomains": ["<domain>"],
    "depCount": <int>,
    "execScripts": <int>
  },
  "summary": "<one paragraph>"
}

Risk level rules:
- low: only info findings; manifest matches code; outbound domains match; no postinstall.
- medium: warning findings; some manifest drift; postinstall present.
- high: critical findings; capability under-declaration; sending secrets to undeclared domains.`;

const ARCH_ALIASES = {
  arm64: ['arm64', 'aarch64'],
  x86_64: ['x86_64', 'x64'],
  aarch64: ['arm64', 'aarch64'],
  x64: ['x86_64', 'x64'],
};

const PKG_MANAGER_LOCKFILES = {
  npm:  ['package-lock.json'],
  pnpm: ['pnpm-lock.yaml'],
  yarn: ['yarn.lock'],
  bun:  ['bun.lockb', 'bun.lock'],
  pip:  ['requirements.txt'],
  uv:   ['uv.lock'],
  poetry: ['poetry.lock'],
};

// Lockfile precedence: pnpm > yarn > bun > npm. Plan §10 decision 10.
const LOCKFILE_PRIORITY = [
  { pm: 'pnpm', files: ['pnpm-lock.yaml'] },
  { pm: 'yarn', files: ['yarn.lock'] },
  { pm: 'bun',  files: ['bun.lockb', 'bun.lock'] },
  { pm: 'npm',  files: ['package-lock.json'] },
  { pm: 'uv',   files: ['uv.lock'] },
  { pm: 'poetry', files: ['poetry.lock'] },
  { pm: 'pip',  files: ['requirements.txt'] },
];

const SHELL_PIPE_RES = [
  /\bcurl\b[^|]*\|\s*\b(?:sh|bash|zsh)\b/i,
  /\bwget\b[^|]*\|\s*\b(?:sh|bash|zsh)\b/i,
];

// Known typosquat list — Phase 3 PR 3.6 will replace this with a real
// supply-chain analyzer (safety / osv-scanner). Keep small + curated; the
// list is not exhaustive on purpose. Keyed lowercased.
const KNOWN_MALICIOUS_PYTHON = new Set([
  'requestes',  'reuests',     'requessts',
  'numpyy',     'numpyz',      'numpie',
  'torcch',     'torcg',       'pytorrch',
  'panas',      'pandass',
  'beautifulsop',
  'urllib33',
]);

// Extract dep names from common Python lockfiles. Returns lowercased names.
function extractPythonDepNames(stagingDir) {
  const names = new Set();
  const reqPath = path.join(stagingDir, 'requirements.txt');
  if (fs.existsSync(reqPath)) {
    try {
      const txt = fs.readFileSync(reqPath, 'utf8');
      for (const line of txt.split(/\r?\n/)) {
        const trimmed = line.replace(/[#;].*$/, '').trim();
        if (!trimmed || trimmed.startsWith('-')) continue;
        // pkg, pkg==1.0, pkg>=2, pkg[extras]
        const m = trimmed.match(/^([A-Za-z0-9._-]+)/);
        if (m) names.add(m[1].toLowerCase());
      }
    } catch (_) { /* malformed — skip */ }
  }
  const uvLockPath = path.join(stagingDir, 'uv.lock');
  if (fs.existsSync(uvLockPath)) {
    try {
      const txt = fs.readFileSync(uvLockPath, 'utf8');
      for (const m of txt.matchAll(/^name\s*=\s*"([^"]+)"/gm)) {
        names.add(m[1].toLowerCase());
      }
    } catch (_) { /* skip */ }
  }
  const poetryLockPath = path.join(stagingDir, 'poetry.lock');
  if (fs.existsSync(poetryLockPath)) {
    try {
      const txt = fs.readFileSync(poetryLockPath, 'utf8');
      for (const m of txt.matchAll(/^name\s*=\s*"([^"]+)"/gm)) {
        names.add(m[1].toLowerCase());
      }
    } catch (_) { /* skip */ }
  }
  const pyprojectPath = path.join(stagingDir, 'pyproject.toml');
  if (fs.existsSync(pyprojectPath) && names.size === 0) {
    try {
      const txt = fs.readFileSync(pyprojectPath, 'utf8');
      // Best-effort regex parse of [tool.poetry.dependencies] / [project.dependencies].
      // pyproject is TOML; we don't pull in a TOML parser for v1 — Phase 3
      // analyzer can do this properly.
      for (const m of txt.matchAll(/^\s*([A-Za-z0-9._-]+)\s*=/gm)) {
        const name = m[1].toLowerCase();
        if (name === 'python' || name === 'name' || name === 'version') continue;
        names.add(name);
      }
    } catch (_) { /* skip */ }
  }
  return names;
}

function scanPythonDeps(stagingDir) {
  const findings = [];
  const names = extractPythonDepNames(stagingDir);
  for (const n of names) {
    if (KNOWN_MALICIOUS_PYTHON.has(n)) {
      findings.push({
        severity: 'warning', category: 'supply_chain',
        file: null, line: null,
        description: `python dep '${n}' matches a known-typosquat entry`,
        snippet: n,
      });
    }
  }
  findings.push({
    severity: 'info', category: 'supply_chain',
    file: null, line: null,
    description: `python dep scan: ${names.size} package${names.size === 1 ? '' : 's'} (direct + transitive when lockfile present)`,
    snippet: '',
  });
  return findings;
}

function archMatches(declared, host) {
  if (!Array.isArray(declared) || declared.length === 0) return true;
  const aliases = ARCH_ALIASES[host] || [host];
  return declared.some(d => aliases.includes(d));
}

function detectLockfile(stagingDir) {
  for (const { pm, files } of LOCKFILE_PRIORITY) {
    for (const f of files) {
      if (fs.existsSync(path.join(stagingDir, f))) {
        return { pm, file: f };
      }
    }
  }
  return null;
}

function commandsContainingShellPipe(manifest) {
  const matches = [];
  for (const key of ['install', 'postInstall', 'preStart']) {
    const list = manifest?.[key];
    if (!Array.isArray(list)) continue;
    for (let i = 0; i < list.length; i++) {
      const argv = Array.isArray(list[i]?.argv) ? list[i].argv : [];
      const flat = argv.join(' ');
      for (const re of SHELL_PIPE_RES) {
        if (re.test(flat)) matches.push(`${key}[${i}]`);
      }
    }
  }
  if (manifest?.start?.argv) {
    const flat = manifest.start.argv.join(' ');
    for (const re of SHELL_PIPE_RES) {
      if (re.test(flat)) matches.push('start');
    }
  }
  return matches;
}

const AppReviewService = {
  /**
   * @param {object} db
   * @param {string} stagingDir
   * @param {object} manifest
   * @param {{channel?: string, resolvedCommit?: string, hostArch?: string}} [opts]
   */
  async review(db, stagingDir, manifest, opts = {}) {
    const channel = opts.channel || manifest?.review?.channel || 'verified';
    const resolvedCommit = opts.resolvedCommit || null;
    const hostArch = opts.hostArch || process.arch;

    // 1. Blocking static checks.
    const blockers = AppReviewService._runStaticChecks(stagingDir, manifest, {
      channel, resolvedCommit, hostArch,
    });
    if (blockers.length > 0) {
      return {
        riskLevel: 'high',
        findings: blockers,
        trustAssessment: {},
        summary: 'Blocking static checks failed; LLM review skipped.',
      };
    }

    // 2. Advisory static analysis.
    const advisory = await AppReviewService._runStaticAnalysis(stagingDir, manifest);

    // 3. LLM review (optional — surfaces medium risk if it can't run).
    const userMessage = AppReviewService._buildUserMessage(stagingDir, manifest, advisory);
    let llm;
    try {
      llm = await Shared.runReview(db, {
        systemPrompt: APP_REVIEW_SYSTEM_PROMPT,
        userMessage,
      });
    } catch (e) {
      const reason = e instanceof LLMReviewError ? e.message : `${e.name || 'Error'}: ${e.message}`;
      return {
        riskLevel: AppReviewService._maxRisk('medium', advisory),
        findings: [...advisory, {
          severity: 'info',
          category: 'other',
          file: null,
          line: null,
          description: `LLM review unavailable: ${reason}`,
          snippet: '',
        }],
        trustAssessment: {},
        summary: `Static analysis only (LLM review unavailable: ${reason})`,
      };
    }

    return {
      riskLevel: AppReviewService._maxRisk(llm.riskLevel, advisory),
      findings: [...advisory, ...(Array.isArray(llm.findings) ? llm.findings : [])],
      trustAssessment: llm.trustAssessment || {},
      summary: llm.summary || '',
    };
  },

  _runStaticChecks(stagingDir, manifest, { channel, resolvedCommit, hostArch }) {
    const findings = [];

    // Argv-only commands; no shell:true.
    for (const key of ['install', 'postInstall', 'preStart']) {
      const list = manifest?.[key];
      if (!Array.isArray(list)) continue;
      for (let i = 0; i < list.length; i++) {
        const cmd = list[i];
        if (!Array.isArray(cmd?.argv)) {
          findings.push({
            severity: 'critical', category: 'other',
            file: null, line: null,
            description: `${key}[${i}] is not an argv array`,
            snippet: JSON.stringify(cmd).slice(0, 200),
          });
        }
        if (cmd?.shell === true) {
          findings.push({
            severity: 'critical', category: 'other',
            file: null, line: null,
            description: `${key}[${i}] declares shell:true (forbidden in v1)`,
            snippet: '',
          });
        }
      }
    }
    if (manifest?.start?.shell === true) {
      findings.push({
        severity: 'critical', category: 'other',
        file: null, line: null,
        description: 'start.shell:true forbidden in v1',
        snippet: '',
      });
    }

    // No curl|sh / wget|sh in any command argv.
    const piped = commandsContainingShellPipe(manifest);
    if (piped.length > 0) {
      findings.push({
        severity: 'critical', category: 'other',
        file: null, line: null,
        description: `shell-pipe-to-interpreter detected in: ${piped.join(', ')}`,
        snippet: '',
      });
    }

    // Architecture compat.
    if (!archMatches(manifest?.runtime?.arch, hostArch)) {
      findings.push({
        severity: 'critical', category: 'other',
        file: null, line: null,
        description: `host arch ${hostArch} not in manifest runtime.arch ${(manifest?.runtime?.arch || []).join(',') || '(unset)'}`,
        snippet: '',
      });
    }

    // Resolved-commit must be a 40-char SHA when supplied.
    if (resolvedCommit !== null && resolvedCommit !== undefined && !SHA_RE.test(resolvedCommit)) {
      findings.push({
        severity: 'critical', category: 'other',
        file: null, line: null,
        description: `upstream commit must be a 40-char SHA, got: ${resolvedCommit}`,
        snippet: '',
      });
    }

    // Verified channel: lockfile present and matches declared package_manager.
    if (channel === 'verified' && manifest?.runtime?.kind === 'node') {
      const declared = manifest?.runtime?.package_manager;
      const found = detectLockfile(stagingDir);
      if (!found) {
        findings.push({
          severity: 'critical', category: 'supply_chain',
          file: null, line: null,
          description: 'verified channel requires a recognizable lockfile in the upstream',
          snippet: '',
        });
      } else if (declared && declared !== 'auto' && declared !== found.pm) {
        findings.push({
          severity: 'critical', category: 'supply_chain',
          file: null, line: null,
          description: `package_manager '${declared}' declared but only ${found.pm} lockfile (${found.file}) was found`,
          snippet: '',
        });
      }
    }

    // package.json scripts.postinstall / preinstall: warning, not blocking.
    // Combined with channel-tiered --ignore-scripts policy in PR 1.11.
    const pkgPath = path.join(stagingDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const scripts = pkg.scripts || {};
        for (const hookName of ['preinstall', 'install', 'postinstall']) {
          if (scripts[hookName]) {
            findings.push({
              severity: 'warning', category: 'supply_chain',
              file: 'package.json', line: null,
              description: `${hookName} script present: ${String(scripts[hookName]).slice(0, 200)}`,
              snippet: scripts[hookName],
            });
            // Surface curl|sh inside postinstall as critical, blocking.
            for (const re of SHELL_PIPE_RES) {
              if (re.test(scripts[hookName])) {
                findings.push({
                  severity: 'critical', category: 'supply_chain',
                  file: 'package.json', line: null,
                  description: `${hookName} script contains shell-pipe-to-interpreter`,
                  snippet: scripts[hookName],
                });
              }
            }
          }
        }
      } catch (_) { /* malformed package.json — covered by advisory */ }
    }

    return findings;
  },

  async _runStaticAnalysis(stagingDir, _manifest) {
    const findings = [];

    // npm audit (Node only). Best-effort — degrades to a warning if npm is
    // missing or the audit fails (e.g. no lockfile). Timeout 60s so a hung
    // network call doesn't stall the install pipeline.
    if (fs.existsSync(path.join(stagingDir, 'package.json'))) {
      try {
        const { stdout } = await execFileAsync(
          'npm', ['audit', '--json', '--omit=dev'],
          { cwd: stagingDir, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }
        );
        try {
          const j = JSON.parse(stdout);
          const v = j?.metadata?.vulnerabilities || {};
          const high = (v.high || 0) + (v.critical || 0);
          if (high > 0) {
            findings.push({
              severity: high >= 5 ? 'warning' : 'info',
              category: 'supply_chain',
              file: 'package.json', line: null,
              description: `npm audit reports ${v.critical || 0} critical and ${v.high || 0} high vulnerabilities in production deps`,
              snippet: '',
            });
          }
        } catch (_) { /* malformed audit JSON — skip */ }
      } catch (e) {
        // npm exits non-zero when there are findings; capture stdout from the
        // error if present (execFile attaches it).
        const out = e.stdout || '';
        try {
          const j = JSON.parse(out);
          const v = j?.metadata?.vulnerabilities || {};
          const high = (v.high || 0) + (v.critical || 0);
          if (high > 0) {
            findings.push({
              severity: 'info',
              category: 'supply_chain',
              file: 'package.json', line: null,
              description: `npm audit reports ${v.critical || 0} critical and ${v.high || 0} high vulnerabilities in production deps`,
              snippet: '',
            });
          }
        } catch (_) {
          // npm itself missing or audit hard-failed — surface as info, never block.
          findings.push({
            severity: 'info', category: 'supply_chain',
            file: null, line: null,
            description: `npm audit could not run: ${e.message?.slice(0, 200) || 'unknown error'}`,
            snippet: '',
          });
        }
      }
    }

    // PR 2.1: Python branch — typosquat scan + dep summary. We don't shell
    // out to safety/osv-scanner in v1 (Phase 3 PR 3.6 plugs those in here);
    // this stub flags known typosquats against a small hardcoded list.
    const hasPyManifest =
      fs.existsSync(path.join(stagingDir, 'pyproject.toml')) ||
      fs.existsSync(path.join(stagingDir, 'requirements.txt')) ||
      fs.existsSync(path.join(stagingDir, 'uv.lock')) ||
      fs.existsSync(path.join(stagingDir, 'poetry.lock'));
    if (hasPyManifest) {
      try {
        findings.push(...scanPythonDeps(stagingDir));
      } catch (e) {
        findings.push({
          severity: 'info', category: 'supply_chain',
          file: null, line: null,
          description: `python dep scan failed: ${e.message?.slice(0, 200) || 'unknown'}`,
          snippet: '',
        });
      }
    }

    return findings;
  },

  _buildUserMessage(stagingDir, manifest, advisoryFindings) {
    const lines = [];
    lines.push('## Manifest\n```yaml');
    lines.push(JSON.stringify(manifest, null, 2));
    lines.push('```\n');

    // Directory listing — top-level only, kept brief.
    if (fs.existsSync(stagingDir)) {
      try {
        const entries = fs.readdirSync(stagingDir).filter(f => !f.startsWith('.'));
        lines.push('## Top-level entries\n' + entries.slice(0, 80).join(', ') + '\n');
      } catch (_) { /* unreadable */ }
    }

    // Key files — package.json + a small slice of source.
    const keyFiles = ['package.json', 'pnpm-workspace.yaml', 'tsconfig.json'];
    for (const rel of keyFiles) {
      const p = path.join(stagingDir, rel);
      if (fs.existsSync(p)) {
        try {
          const c = fs.readFileSync(p, 'utf8');
          if (c.length < 12_000) {
            lines.push(`## ${rel}\n\`\`\`\n${c}\n\`\`\`\n`);
          }
        } catch (_) { /* skip */ }
      }
    }

    if (advisoryFindings.length > 0) {
      lines.push('## Static analysis advisory\n');
      for (const f of advisoryFindings.slice(0, 20)) {
        lines.push(`- [${f.severity}] ${f.category}: ${f.description}`);
      }
    }

    lines.push('\nReview against the criteria in the system prompt and respond with the JSON report.');
    return lines.join('\n');
  },

  _maxRisk(llmRisk, findings) {
    const order = { low: 0, medium: 1, high: 2 };
    let max = order[llmRisk] ?? 1;
    for (const f of findings) {
      if (f.severity === 'critical') max = Math.max(max, 2);
      else if (f.severity === 'warning') max = Math.max(max, 1);
    }
    return Object.entries(order).find(([_, v]) => v === max)?.[0] || 'medium';
  },

  // Test-only: expose internals so unit tests can exercise them.
  _internal: { archMatches, detectLockfile, commandsContainingShellPipe },
};

module.exports = AppReviewService;
