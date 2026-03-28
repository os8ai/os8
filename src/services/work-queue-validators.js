/**
 * Job/plan completion parsing and validation.
 * Pure functions — no queue state, no service imports beyond fs/path.
 */

const path = require('path');
const fs = require('fs');

/**
 * Parse job completion status and notes from agent response
 * @param {string} response - The agent's response text
 * @returns {{ status: string, notes: string|null, hasMarker: boolean }}
 */
function parseJobCompletion(response) {
  if (!response) {
    return { status: 'could_not_complete', notes: 'Empty agent response', hasMarker: false };
  }

  // Check for JOB_COMPLETE marker
  const completeMatch = response.match(/\[JOB_COMPLETE:\s*(.+?)\]/s);
  if (completeMatch) {
    return { status: 'completed', notes: completeMatch[1].trim(), hasMarker: true };
  }

  // Check for JOB_COULD_NOT_COMPLETE marker
  const couldNotMatch = response.match(/\[JOB_COULD_NOT_COMPLETE:\s*(.+?)\]/s);
  if (couldNotMatch) {
    return { status: 'could_not_complete', notes: couldNotMatch[1].trim(), hasMarker: true };
  }

  return { status: 'could_not_complete', notes: 'Missing completion marker', hasMarker: false };
}

/**
 * Parse plan step completion status from agent response
 * @param {string} response
 * @param {string} stepId
 * @returns {{ status: string, result: string }}
 */
function parsePlanStepCompletion(response, stepId) {
  if (!response) {
    return { status: 'failed', result: 'No response from agent' };
  }

  // Check for explicit markers
  const completeMatch = response.match(/\[STEP_COMPLETE:\s*([^\]]*)\]/s);
  if (completeMatch) {
    return { status: 'completed', result: completeMatch[1]?.trim() || 'Completed' };
  }

  const failedMatch = response.match(/\[STEP_FAILED:\s*([^\]]*)\]/s);
  if (failedMatch) {
    return { status: 'failed', result: failedMatch[1]?.trim() || 'Step reported failure' };
  }

  // No marker — heuristic: check for error signals
  const lastChunk = response.slice(-500);
  if (response.length < 20 ||
      /(?:error|Error|exception|ENOENT|permission denied|FATAL|Cannot find)/i.test(lastChunk)) {
    return { status: 'failed', result: 'No completion marker found and response indicates errors' };
  }

  // No marker but looks clean — treat as completed
  return { status: 'completed', result: 'Completed (no explicit marker)' };
}

/**
 * Validate job completion by checking file system artifacts
 * @param {string} appId
 * @param {object} job
 * @param {number} runStartedAtMs
 * @param {{ getDb: function }} ctx - Context with database getter
 * @returns {{ ok: boolean, failures: string[], summary: string }}
 */
function validateJobCompletion(appId, job, runStartedAtMs, ctx) {
  const AgentService = require('./agent');
  const checks = Array.isArray(job?.completionChecks) ? job.completionChecks : [];
  const db = ctx.getDb ? ctx.getDb() : null;
  const valAgent = db ? AgentService.getById(db, appId) : null;
  const paths = valAgent ? AgentService.getPaths(valAgent.app_id, appId) : AgentService.getPaths(appId);
  const skillId = (job?.skill || '').trim().toLowerCase();

  // Agent-life: portrait required
  if (skillId === 'agent-life') {
    return validateLifeOutput(paths.agentBlobDir, runStartedAtMs);
  }

  // Guardrail for image jobs: if no explicit checks are configured, still require
  // fresh portrait files so marker-only completions cannot pass.
  if (checks.length === 0 && (skillId === 'current-image' || skillId === 'snapshot')) {
    return validateCurrentImageOutput(paths.agentBlobDir, runStartedAtMs);
  }

  // Snapshot with legacy completionChecks — override with fresh-file validation
  if (skillId === 'snapshot') {
    return validateCurrentImageOutput(paths.agentBlobDir, runStartedAtMs);
  }

  if (checks.length === 0) {
    return { ok: true, failures: [], summary: '' };
  }

  const { agentDir } = paths;
  const failures = [];
  const passes = [];
  let actionableCount = 0;

  for (const rawCheck of checks) {
    const parsed = parseCompletionCheck(rawCheck);
    if (!parsed) {
      continue;
    }
    actionableCount += 1;

    if (parsed.type === 'exists') {
      const absPath = resolveCheckPath(paths, parsed.path);
      if (!fs.existsSync(absPath)) {
        failures.push(`Missing "${parsed.path}"`);
      } else {
        passes.push(`exists:${parsed.path}`);
      }
      continue;
    }

    if (parsed.type === 'recent') {
      const absPath = resolveCheckPath(paths, parsed.path);
      const mtimeMs = getLatestMtime(absPath);
      const toleranceMs = 2 * 60 * 1000;
      if (!mtimeMs) {
        failures.push(`No file found for recent check "${parsed.path}"`);
      } else if (mtimeMs < (runStartedAtMs - toleranceMs)) {
        failures.push(`"${parsed.path}" was not updated during this run`);
      } else {
        passes.push(`recent:${parsed.path}`);
      }
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    summary: actionableCount > 0 ? `${passes.length}/${actionableCount} checks passed` : ''
  };
}

/**
 * Validate current-image output has recent portrait files
 * @param {string} agentBlobDir
 * @param {number} runStartedAtMs
 * @returns {{ ok: boolean, failures: string[], summary: string }}
 */
function validateCurrentImageOutput(agentBlobDir, runStartedAtMs) {
  const failures = [];
  const toleranceMs = 2 * 60 * 1000;
  const cutoffMs = runStartedAtMs - toleranceMs;
  const currentImageDir = path.join(agentBlobDir, 'current-image');

  if (!fs.existsSync(currentImageDir)) {
    return {
      ok: false,
      failures: ['Missing "blob/current-image"'],
      summary: ''
    };
  }

  let entries = [];
  try {
    entries = fs.readdirSync(currentImageDir, { withFileTypes: true });
  } catch {
    return {
      ok: false,
      failures: ['Could not read "blob/current-image"'],
      summary: ''
    };
  }

  const imageExtPattern = /\.(png|jpe?g|webp)$/i;
  const recentImageFiles = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!imageExtPattern.test(entry.name)) continue;

    const filePath = path.join(currentImageDir, entry.name);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }

    if (stat.mtimeMs >= cutoffMs) {
      recentImageFiles.push(entry.name);
    }
  }

  if (recentImageFiles.length === 0) {
    failures.push('No recent image files (.png/.jpg/.jpeg/.webp) written to "blob/current-image" during this run');
  }

  const hasRecentPortrait = recentImageFiles.length > 0;

  if (!hasRecentPortrait) {
    failures.push('Missing recent portrait image (.png/.jpg/.jpeg/.webp) in "blob/current-image"');
  }

  return {
    ok: failures.length === 0,
    failures,
    summary: failures.length === 0 ? `current-image outputs verified (${recentImageFiles.length} recent image files)` : ''
  };
}

/**
 * Validate agent-life output: portrait required
 * @param {string} agentBlobDir
 * @param {number} runStartedAtMs
 * @returns {{ ok: boolean, failures: string[], summary: string }}
 */
function validateLifeOutput(agentBlobDir, runStartedAtMs) {
  const failures = [];
  const toleranceMs = 2 * 60 * 1000;
  const cutoffMs = runStartedAtMs - toleranceMs;
  const currentImageDir = path.join(agentBlobDir, 'current-image');

  if (!fs.existsSync(currentImageDir)) {
    return { ok: false, failures: ['Missing "blob/current-image"'], summary: '' };
  }

  let entries = [];
  try {
    entries = fs.readdirSync(currentImageDir, { withFileTypes: true });
  } catch {
    return { ok: false, failures: ['Could not read "blob/current-image"'], summary: '' };
  }

  const imageExtPattern = /\.(png|jpe?g|webp)$/i;
  const recentImages = entries
    .filter(e => e.isFile() && imageExtPattern.test(e.name))
    .filter(e => {
      try {
        return fs.statSync(path.join(currentImageDir, e.name)).mtimeMs >= cutoffMs;
      } catch { return false; }
    })
    .map(e => e.name);

  if (recentImages.length === 0) {
    failures.push('Missing recent portrait image in "blob/current-image"');
  }

  return {
    ok: failures.length === 0,
    failures,
    summary: failures.length === 0 ? `Portrait verified (${recentImages.length} recent files)` : ''
  };
}

/**
 * Parse a completion check string into type + path
 * @param {string} rawCheck
 * @returns {{ type: string, path: string } | null}
 */
function parseCompletionCheck(rawCheck) {
  if (!rawCheck || typeof rawCheck !== 'string') return null;
  const check = rawCheck.trim();
  if (!check) return null;

  const existsMatch = check.match(/^(?:exists|file exists)\s*:\s*(.+)$/i);
  if (existsMatch) {
    return { type: 'exists', path: existsMatch[1].trim() };
  }

  const recentMatch = check.match(/^(?:recent|recent file)\s*:\s*(.+)$/i);
  if (recentMatch) {
    return { type: 'recent', path: recentMatch[1].trim() };
  }

  return null;
}

/**
 * Resolve a completion check path to an absolute path
 * @param {object} agentPaths
 * @param {string} checkPath
 * @returns {string}
 */
function resolveCheckPath(agentPaths, checkPath) {
  const { agentDir, agentBlobDir } = agentPaths || {};
  if (!checkPath) return agentDir;
  const trimmed = checkPath.trim().replace(/^["']|["']$/g, '');
  if (path.isAbsolute(trimmed)) return trimmed;
  if (trimmed === 'blob' || trimmed.startsWith('blob/')) {
    const relativeBlobPath = trimmed === 'blob' ? '' : trimmed.slice('blob/'.length);
    return path.join(agentBlobDir || agentDir, relativeBlobPath);
  }
  return path.join(agentDir, trimmed);
}

/**
 * Get the latest mtime of a file or any file in a directory (recursive)
 * @param {string} targetPath
 * @returns {number} mtime in ms, or 0 if not found
 */
function getLatestMtime(targetPath) {
  if (!fs.existsSync(targetPath)) return 0;

  let stat;
  try {
    stat = fs.statSync(targetPath);
  } catch {
    return 0;
  }

  if (stat.isFile()) return stat.mtimeMs;
  if (!stat.isDirectory()) return 0;

  let newest = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(targetPath, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const entryPath = path.join(targetPath, entry.name);
    const mtime = getLatestMtime(entryPath);
    if (mtime > newest) newest = mtime;
  }

  return newest;
}

module.exports = {
  parseJobCompletion,
  parsePlanStepCompletion,
  validateJobCompletion,
  validateCurrentImageOutput,
  validateLifeOutput,
  parseCompletionCheck,
  resolveCheckPath,
  getLatestMtime
};
