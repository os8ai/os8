/**
 * Shared npm discovery — finds the system npm binary across macOS and Linux.
 * Used by CoreService (npm install in ~/os8/core/) and onboarding (CLI installs).
 */

const { execSync } = require('child_process');
const path = require('path');
const os = require('os');

const SEARCH_PATH = [
  '/opt/homebrew/bin',          // macOS Homebrew (Apple Silicon)
  '/usr/local/bin',             // macOS Homebrew (Intel), manual installs
  '/usr/bin',                   // Linux system packages (apt, dnf)
  '/bin',
  '/usr/sbin',
  '/sbin',
  path.join(os.homedir(), '.nvm/versions/node', 'current', 'bin'),  // nvm
  path.join(os.homedir(), '.local/bin'),                            // pip/user installs
].join(':');

/**
 * Find the npm binary. Returns the absolute path or null if not found.
 */
function findNpm() {
  try {
    return execSync('which npm', { encoding: 'utf-8', env: { PATH: SEARCH_PATH } }).trim();
  } catch {
    try {
      // Fall back to the user's actual PATH (may include nvm, volta, etc.)
      return execSync('which npm', { encoding: 'utf-8', env: { PATH: process.env.PATH } }).trim();
    } catch {
      return null;
    }
  }
}

module.exports = { findNpm, SEARCH_PATH };
