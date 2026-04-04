/**
 * Shared CLI resolution — finds CLI binaries and npm global bin directory.
 * Installs to ~/.os8/cli/ (user-writable) instead of system global prefix
 * to avoid EACCES on systems where /usr/local is root-owned.
 * Used by: backend-adapter.js (prepareEnv), settings-api.js (login route), onboarding IPC.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SEARCH_PATH, findNpm } = require('./npm-path');

// CLI command -> npm package mapping + minimum Node version
const CLI_PACKAGES = {
  claude: { pkg: '@anthropic-ai/claude-code', minNode: 18 },
  gemini: { pkg: '@google/gemini-cli', minNode: 20 },
  codex:  { pkg: '@openai/codex', minNode: 18 },
  grok:   { pkg: '@vibe-kit/grok-cli', minNode: 18 },
};

// OS8-managed directories — user-writable, no sudo needed
const OS8_DIR = process.env.OS8_HOME || path.join(os.homedir(), 'os8');
const CLI_PREFIX = path.join(OS8_DIR, 'cli');
const CLI_BIN = path.join(CLI_PREFIX, 'bin');
const NODE_BIN = path.join(OS8_DIR, 'node', 'bin');

/**
 * Get the npm global bin directory. Cached after first successful call.
 * Returns absolute path (e.g. '/usr/local/bin') or null.
 */
let _npmGlobalBin = undefined; // undefined = not yet checked
function getNpmGlobalBin() {
  if (_npmGlobalBin !== undefined) return _npmGlobalBin;
  try {
    const npmRoot = execSync('npm root -g', {
      encoding: 'utf-8',
      timeout: 5000,
      env: { PATH: SEARCH_PATH }
    }).trim();
    if (npmRoot && !npmRoot.includes('not found')) {
      const candidate = path.join(npmRoot, '..', 'bin');
      // Verify the directory exists — on apt-installed Node, npm root -g returns
      // /usr/lib/node_modules and ../bin resolves to /usr/lib/bin which doesn't exist
      _npmGlobalBin = fs.existsSync(candidate) ? candidate : null;
    } else {
      _npmGlobalBin = null;
    }
  } catch {
    _npmGlobalBin = null;
  }
  return _npmGlobalBin;
}

/**
 * Build a PATH string that includes OS8 Node + CLI bin + npm global bin + SEARCH_PATH.
 * Used for spawn env and `which` checks.
 */
function getExpandedPath() {
  const parts = [];
  // OS8-managed Node bin (highest priority — guarantees Node 20+)
  if (fs.existsSync(NODE_BIN)) parts.push(NODE_BIN);
  // OS8-managed CLI bin
  if (fs.existsSync(CLI_BIN)) parts.push(CLI_BIN);
  // npm global bin (may be null on some systems)
  const npmBin = getNpmGlobalBin();
  if (npmBin) parts.push(npmBin);
  // Standard system paths
  parts.push(SEARCH_PATH);
  return parts.join(':');
}

/**
 * Find a CLI binary. Returns absolute path or null.
 */
function findCli(command) {
  const expandedPath = getExpandedPath();
  try {
    return execSync(`which ${command}`, {
      encoding: 'utf-8',
      timeout: 5000,
      env: { PATH: expandedPath }
    }).trim();
  } catch {
    // Last resort: user's actual PATH (may include nvm, volta, etc.)
    try {
      return execSync(`which ${command}`, {
        encoding: 'utf-8',
        timeout: 5000,
        env: { PATH: process.env.PATH }
      }).trim();
    } catch {
      return null;
    }
  }
}

/**
 * Get the best available Node.js major version.
 * Checks OS8-managed Node first, then system.
 */
function getNodeMajorVersion() {
  const { getNodeInfo } = require('./node-setup');
  const info = getNodeInfo();
  return info.version;
}

/**
 * Attempt to install a CLI package to OS8-managed prefix.
 * Returns { success, error, reason }.
 * reason: 'node_too_old' | 'npm_not_found' | 'install_failed' | 'unknown_cli'
 */
async function installCli(command) {
  const entry = CLI_PACKAGES[command];
  if (!entry) return { success: false, error: `Unknown CLI: ${command}`, reason: 'unknown_cli' };

  // Check Node version requirement
  const nodeVersion = getNodeMajorVersion();
  if (nodeVersion && nodeVersion < entry.minNode) {
    return {
      success: false,
      error: `${command} requires Node ${entry.minNode}+, system has ${nodeVersion}`,
      reason: 'node_too_old'
    };
  }

  const npmPath = findNpm();
  if (!npmPath) return { success: false, error: 'npm not found', reason: 'npm_not_found' };

  // Ensure prefix directory exists
  fs.mkdirSync(CLI_PREFIX, { recursive: true });

  try {
    execSync(`${npmPath} install --prefix ${CLI_PREFIX} -g ${entry.pkg}`, {
      encoding: 'utf-8',
      timeout: 120000,
      env: { ...process.env, PATH: getExpandedPath() }
    });
    // Clear cache so findCli picks up new binary
    _npmGlobalBin = undefined;
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message, reason: 'install_failed' };
  }
}

module.exports = { findCli, installCli, getExpandedPath, getNpmGlobalBin, getNodeMajorVersion, CLI_PACKAGES, CLI_PREFIX, CLI_BIN };
