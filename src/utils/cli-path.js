/**
 * Shared CLI resolution — finds CLI binaries and npm global bin directory.
 * Replaces ad-hoc `npm root -g` logic scattered across backend-adapter.js and settings-api.js.
 * Used by: backend-adapter.js (prepareEnv), settings-api.js (login route), onboarding IPC.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { SEARCH_PATH, findNpm } = require('./npm-path');

// CLI command -> npm package mapping
const CLI_PACKAGES = {
  claude: '@anthropic-ai/claude-code',
  gemini: '@google-ai/gemini-cli',
  codex: '@vibe-kit/codex-cli',
  grok: '@vibe-kit/grok-cli',
};

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
 * Build a PATH string that includes the npm global bin dir + SEARCH_PATH.
 * Used for spawn env and `which` checks.
 */
function getExpandedPath() {
  const npmBin = getNpmGlobalBin();
  return npmBin ? `${npmBin}:${SEARCH_PATH}` : SEARCH_PATH;
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
 * Attempt to install a CLI package globally. Returns { success, error }.
 */
async function installCli(command) {
  const pkg = CLI_PACKAGES[command];
  if (!pkg) return { success: false, error: `Unknown CLI: ${command}` };

  const npmPath = findNpm();
  if (!npmPath) return { success: false, error: 'npm not found' };

  try {
    execSync(`${npmPath} install -g ${pkg}`, {
      encoding: 'utf-8',
      timeout: 120000,
      env: { ...process.env, PATH: getExpandedPath() }
    });
    // Clear cache so findCli picks up new binary
    _npmGlobalBin = undefined;
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = { findCli, installCli, getExpandedPath, getNpmGlobalBin, CLI_PACKAGES };
