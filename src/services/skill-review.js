/**
 * SkillReviewService — LLM-powered security review for community skills.
 *
 * Scans skill contents (SKILL.md, scripts, install steps) for security risks,
 * produces structured reports, and manages the quarantine lifecycle.
 *
 * Pattern: Static methods, db as first param. Uses AnthropicSDK for LLM calls
 * (same pattern as ModeratorService).
 */

const fs = require('fs');
const path = require('path');
const { execFile, exec } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

const AnthropicSDK = require('./anthropic-sdk');
const AIRegistryService = require('./ai-registry');
const RoutingService = require('./routing');

// File extensions included in security review (executable/instructional)
const REVIEW_EXTENSIONS = new Set([
  '.md', '.sh', '.js', '.ts', '.py', '.rb', '.pl', '.bash', '.zsh',
  '.jsx', '.tsx', '.mjs', '.cjs', '.json', '.yaml', '.yml', '.toml'
]);

// Extensions to skip in review (docs only, not executed)
const SKIP_REVIEW_EXTENSIONS = new Set(['.md']);

// Max file size to include in review (100KB)
const MAX_FILE_SIZE = 100 * 1024;

const REVIEW_SYSTEM_PROMPT = `You are a security reviewer for OS8, a desktop AI agent platform. You review community-created "skills" — instruction files that tell AI agents what to do.

Your job is to identify security risks in skill files. Skills can instruct agents to run shell commands, access files, make network calls, and install packages.

Review criteria:
1. **Exfiltration**: Commands that send local data to external servers (curl POST with file contents, piping to remote hosts)
2. **Privilege escalation**: sudo, chmod 777, writing to system paths (/usr/local, /etc)
3. **Credential access**: Reading ~/.ssh, ~/.aws, ~/.config, env vars not declared in requires.env
4. **Obfuscation**: Base64-encoded commands, eval chains, encoded URLs, minified code
5. **Supply chain**: Typosquatted package names, unpinned versions, exec install steps with arbitrary commands
6. **Excessive permissions**: Requesting more tool access than needed for the skill's purpose
7. **File system access**: Reading/writing outside the skill's own directory or blob storage without clear purpose

Trust signals to consider:
- High download count + verified = lower risk (community-vetted)
- New/unverified author = higher scrutiny
- exec install steps = always flag

Respond with ONLY valid JSON matching this schema:
{
  "riskLevel": "low" | "medium" | "high",
  "findings": [
    {
      "severity": "info" | "warning" | "critical",
      "category": "exfiltration" | "privilege_escalation" | "credential_access" | "obfuscation" | "supply_chain" | "excessive_permissions" | "other",
      "file": "filename",
      "line": null,
      "description": "What was found",
      "snippet": "relevant code or text"
    }
  ],
  "trustAssessment": {
    "catalogVerified": boolean,
    "downloadCount": number,
    "author": "string or null",
    "knownRegistryPackages": ["packages from brew/npm/pip"],
    "unknownPackages": ["packages not from known registries"],
    "execSteps": number
  },
  "summary": "One-paragraph human-readable summary"
}

Risk level rules:
- "low": No findings or only info findings. All packages from known registries. No exec install steps.
- "medium": One or more warning findings. Has exec install steps. Unverified author.
- "high": Any critical finding. Obfuscated code. Credential harvesting. Unknown outbound network targets.`;

class SkillReviewService {

  /**
   * Trigger a security review for a capability.
   * Reads all files from skill directory, builds review prompt, calls LLM, stores result.
   * @param {object} db - SQLite database
   * @param {string} capabilityId - Capability ID to review
   * @returns {{ riskLevel: string, findings: Array, summary: string }}
   */
  static async review(db, capabilityId) {
    const cap = db.prepare('SELECT * FROM capabilities WHERE id = ?').get(capabilityId);
    if (!cap) throw new Error('Capability not found');
    if (cap.type !== 'skill') throw new Error('Only skills can be reviewed');

    // Mark as pending
    db.prepare(`
      UPDATE capabilities SET review_status = 'pending' WHERE id = ?
    `).run(capabilityId);

    try {
      // Read all files in skill directory
      const files = cap.base_path ? this._readSkillDirectory(cap.base_path) : [];
      if (files.length === 0) throw new Error('No files found in skill directory');

      // Extract install steps from metadata
      const metadata = cap.metadata ? JSON.parse(cap.metadata) : {};
      const installSteps = this._extractInstallSteps(metadata);

      // Get trust signals from catalog
      const trustSignals = this._getTrustSignals(db, cap);

      // Build prompt and call LLM
      const reviewPrompt = this._buildReviewPrompt(files, installSteps, trustSignals);

      const client = AnthropicSDK.getClient(db);
      if (!client) throw new Error('Anthropic API key not configured');

      const claudeModels = AIRegistryService.getClaudeModelMap(db);
      const resolved = RoutingService.resolve(db, 'planning');
      const model = claudeModels[resolved.modelArg] || claudeModels['sonnet'] || 'claude-sonnet-4-5-20250929';

      const response = await client.messages.create({
        model,
        max_tokens: 4096,
        system: REVIEW_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: reviewPrompt }]
      });

      const text = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');

      const report = this._parseReviewResponse(text);

      // Store result
      db.prepare(`
        UPDATE capabilities SET
          review_status = 'reviewed',
          review_risk_level = ?,
          review_report = ?,
          reviewed_at = datetime('now')
        WHERE id = ?
      `).run(report.riskLevel, JSON.stringify(report), capabilityId);

      console.log(`[SkillReview] Reviewed ${cap.name}: ${report.riskLevel} risk (${report.findings.length} findings)`);
      return report;
    } catch (err) {
      // Store error state but keep as pending so it can be retried
      const errorReport = {
        riskLevel: 'unknown',
        findings: [],
        trustAssessment: {},
        summary: `Review failed: ${err.message}`,
        error: err.message
      };
      db.prepare(`
        UPDATE capabilities SET
          review_status = 'reviewed',
          review_risk_level = 'unknown',
          review_report = ?,
          reviewed_at = datetime('now')
        WHERE id = ?
      `).run(JSON.stringify(errorReport), capabilityId);

      console.error(`[SkillReview] Review failed for ${cap.name}:`, err.message);
      return errorReport;
    }
  }

  /**
   * Get review status and report for a capability.
   */
  static getReport(db, capabilityId) {
    const row = db.prepare(`
      SELECT review_status, review_risk_level, review_report, reviewed_at, approved_at
      FROM capabilities WHERE id = ?
    `).get(capabilityId);
    if (!row) return null;

    return {
      status: row.review_status,
      riskLevel: row.review_risk_level,
      report: row.review_report ? JSON.parse(row.review_report) : null,
      reviewedAt: row.reviewed_at,
      approvedAt: row.approved_at
    };
  }

  /**
   * User approves a reviewed skill: unquarantine + mark approved.
   */
  static approve(db, capabilityId) {
    const result = db.prepare(`
      UPDATE capabilities SET
        quarantine = 0,
        review_status = 'approved',
        approved_at = datetime('now')
      WHERE id = ? AND review_status IN ('reviewed', 'pending')
    `).run(capabilityId);
    if (result.changes === 0) throw new Error('Cannot approve: skill not in reviewable state');
    console.log(`[SkillReview] Approved capability ${capabilityId}`);
  }

  /**
   * User rejects a reviewed skill: keep quarantined + mark rejected.
   */
  static reject(db, capabilityId) {
    const result = db.prepare(`
      UPDATE capabilities SET
        review_status = 'rejected'
      WHERE id = ? AND review_status IN ('reviewed', 'pending')
    `).run(capabilityId);
    if (result.changes === 0) throw new Error('Cannot reject: skill not in reviewable state');
    console.log(`[SkillReview] Rejected capability ${capabilityId}`);
  }

  /**
   * Check dependency status: which bins/env are present vs missing.
   */
  static getDepsStatus(db, capabilityId) {
    const cap = db.prepare('SELECT * FROM capabilities WHERE id = ?').get(capabilityId);
    if (!cap) throw new Error('Capability not found');

    const metadata = cap.metadata ? JSON.parse(cap.metadata) : {};
    const installSteps = this._extractInstallSteps(metadata);

    // Check binaries
    const binsRequired = cap.bins_required ? cap.bins_required.split(',').map(b => b.trim()).filter(Boolean) : [];
    const binStatus = {};
    for (const bin of binsRequired) {
      try {
        require('child_process').execFileSync('which', [bin], { stdio: 'pipe' });
        binStatus[bin] = true;
      } catch {
        binStatus[bin] = false;
      }
    }

    // Check env vars
    const envRequired = cap.env_required ? cap.env_required.split(',').map(k => k.trim()).filter(Boolean) : [];
    const EnvService = require('./env');
    const envVars = EnvService.asObject(db);
    const envStatus = {};
    for (const key of envRequired) {
      envStatus[key] = !!(envVars[key] || process.env[key]);
    }

    return {
      bins: binStatus,
      env: envStatus,
      installSteps,
      homepage: cap.homepage || null,
      allBinsPresent: Object.values(binStatus).every(v => v),
      allEnvPresent: Object.values(envStatus).every(v => v),
      allPresent: Object.values(binStatus).every(v => v) && Object.values(envStatus).every(v => v)
    };
  }

  /**
   * Execute approved install steps with verification.
   * @param {object} db - SQLite database
   * @param {string} capabilityId - Capability ID
   * @param {string[]} approvedStepIds - IDs of steps to execute
   * @returns {Array<{ id: string, success: boolean, output: string, error: string|null }>}
   */
  static async installDeps(db, capabilityId, approvedStepIds) {
    const cap = db.prepare('SELECT * FROM capabilities WHERE id = ?').get(capabilityId);
    if (!cap) throw new Error('Capability not found');

    const metadata = cap.metadata ? JSON.parse(cap.metadata) : {};
    const allSteps = this._extractInstallSteps(metadata);
    const stepsToRun = allSteps.filter(s => approvedStepIds.includes(s.id));

    const results = [];

    for (const step of stepsToRun) {
      const result = { id: step.id, label: step.label, success: false, output: '', error: null };
      try {
        switch (step.kind) {
          case 'brew': {
            const { stdout } = await execFileAsync('brew', ['install', step.package], { timeout: 120000 });
            result.output = stdout;
            break;
          }
          case 'node': {
            const { stdout } = await execFileAsync('npm', ['install', '-g', step.package], { timeout: 120000 });
            result.output = stdout;
            break;
          }
          case 'pip': {
            const { stdout } = await execFileAsync('pip', ['install', step.package], { timeout: 120000 });
            result.output = stdout;
            break;
          }
          case 'exec': {
            const { stdout } = await execAsync(step.command, { timeout: 60000 });
            result.output = stdout;
            break;
          }
          default:
            throw new Error(`Unknown install step kind: ${step.kind}`);
        }

        // Verify: check if expected binaries exist
        if (step.bins && step.bins.length > 0) {
          for (const bin of step.bins) {
            try {
              await execFileAsync('which', [bin]);
            } catch {
              result.error = `Binary '${bin}' not found after install`;
            }
          }
        }

        if (!result.error) result.success = true;
      } catch (err) {
        result.error = err.message;
      }
      results.push(result);
    }

    // Refresh availability after installing deps
    const { CapabilityService } = require('./capability');
    CapabilityService.refreshAvailability(db);

    console.log(`[SkillReview] Installed deps for ${cap.name}: ${results.filter(r => r.success).length}/${results.length} succeeded`);
    return results;
  }

  // ──────────────────────────────────────────────
  // Internal helpers
  // ──────────────────────────────────────────────

  /**
   * Read all files in a skill directory for review context.
   * Returns array of { path, name, content, size }.
   */
  static _readSkillDirectory(basePath) {
    const files = [];
    if (!fs.existsSync(basePath)) return files;

    try {
      const entries = fs.readdirSync(basePath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue;

        const ext = path.extname(entry.name).toLowerCase();
        if (!REVIEW_EXTENSIONS.has(ext)) continue;

        const filePath = path.join(basePath, entry.name);
        const stat = fs.statSync(filePath);
        if (stat.size > MAX_FILE_SIZE) continue;

        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          files.push({
            path: filePath,
            name: entry.name,
            content,
            size: stat.size,
            isExecutable: !SKIP_REVIEW_EXTENSIONS.has(ext)
          });
        } catch {
          // Skip unreadable files
        }
      }
    } catch (e) {
      console.warn('[SkillReview] Failed to read skill directory:', e.message);
    }

    return files;
  }

  /**
   * Extract install steps from parsed metadata.
   * Checks both openclaw.install and clawdbot.install paths.
   */
  static _extractInstallSteps(metadata) {
    const steps = [];
    const sources = [
      metadata?.openclaw?.install,
      metadata?.clawdbot?.install
    ];

    for (const installArray of sources) {
      if (!Array.isArray(installArray)) continue;
      for (const step of installArray) {
        if (!step || !step.kind) continue;
        steps.push({
          id: step.id || `${step.kind}-${step.package || 'exec'}-${steps.length}`,
          kind: step.kind,
          package: step.package || null,
          command: step.command || null,
          bins: step.bins || [],
          label: step.label || `${step.kind}: ${step.package || step.command || 'unknown'}`
        });
      }
    }

    return steps;
  }

  /**
   * Get trust signals from catalog entry for a capability.
   */
  static _getTrustSignals(db, cap) {
    const signals = {
      downloadCount: 0,
      verified: false,
      official: false,
      author: null,
      rating: null
    };

    if (cap.catalog_id) {
      try {
        const catalogRow = db.prepare('SELECT * FROM skill_catalog WHERE id = ?').get(cap.catalog_id);
        if (catalogRow) {
          signals.downloadCount = catalogRow.download_count || 0;
          signals.verified = !!catalogRow.verified;
          signals.official = !!catalogRow.official;
          signals.author = catalogRow.author;
          signals.rating = catalogRow.rating;
        }
      } catch {
        // Catalog lookup failed, use defaults
      }
    }

    return signals;
  }

  /**
   * Build the security review prompt from files, install steps, and trust signals.
   */
  static _buildReviewPrompt(files, installSteps, trustSignals) {
    let prompt = '## Skill Files\n\n';

    for (const file of files) {
      prompt += `### ${file.name} (${file.size} bytes${file.isExecutable ? ', executable' : ', documentation'})\n`;
      prompt += '```\n' + file.content.substring(0, 50000) + '\n```\n\n';
    }

    if (installSteps.length > 0) {
      prompt += '## Install Steps\n\n';
      for (const step of installSteps) {
        prompt += `- **${step.label}** (kind: ${step.kind})`;
        if (step.package) prompt += ` — package: ${step.package}`;
        if (step.command) prompt += ` — command: \`${step.command}\``;
        if (step.bins.length > 0) prompt += ` — expected bins: ${step.bins.join(', ')}`;
        prompt += '\n';
      }
      prompt += '\n';
    }

    prompt += '## Trust Signals\n\n';
    prompt += `- Download count: ${trustSignals.downloadCount}\n`;
    prompt += `- Verified: ${trustSignals.verified}\n`;
    prompt += `- Official: ${trustSignals.official}\n`;
    prompt += `- Author: ${trustSignals.author || 'unknown'}\n`;
    if (trustSignals.rating) prompt += `- Rating: ${trustSignals.rating}/5\n`;

    prompt += '\nPlease review this skill for security risks and respond with the JSON report.';

    return prompt;
  }

  /**
   * Parse LLM response into structured report.
   */
  static _parseReviewResponse(text) {
    try {
      // Extract JSON from potential markdown code blocks
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found in response');

      const parsed = JSON.parse(jsonMatch[0]);

      // Validate and normalize
      const validRiskLevels = ['low', 'medium', 'high'];
      const riskLevel = validRiskLevels.includes(parsed.riskLevel) ? parsed.riskLevel : 'medium';

      const findings = Array.isArray(parsed.findings)
        ? parsed.findings.map(f => ({
            severity: ['info', 'warning', 'critical'].includes(f.severity) ? f.severity : 'info',
            category: f.category || 'other',
            file: f.file || null,
            line: f.line || null,
            description: f.description || '',
            snippet: f.snippet || null
          }))
        : [];

      return {
        riskLevel,
        findings,
        trustAssessment: parsed.trustAssessment || {},
        summary: parsed.summary || 'Review completed.'
      };
    } catch (err) {
      console.warn('[SkillReview] Failed to parse review response:', err.message);
      return {
        riskLevel: 'medium',
        findings: [{
          severity: 'warning',
          category: 'other',
          file: null,
          line: null,
          description: 'Review response could not be parsed. Manual review recommended.',
          snippet: null
        }],
        trustAssessment: {},
        summary: 'Review response could not be parsed. Manual review recommended.'
      };
    }
  }
}

module.exports = SkillReviewService;
