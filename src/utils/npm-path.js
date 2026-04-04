/**
 * Shared npm discovery — finds the npm binary.
 * Checks OS8-managed Node (~/.os8/node/bin/) first, then system paths.
 * Used by CoreService (npm install in ~/os8/core/) and onboarding (CLI installs).
 */

const { execSync } = require('child_process');
const fs = require('fs');
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

// OS8-managed Node location
const OS8_DIR = process.env.OS8_HOME || path.join(os.homedir(), 'os8');
const OS8_NODE_BIN = path.join(OS8_DIR, 'node', 'bin');

/**
 * Find the npm binary. Returns the absolute path or null if not found.
 * Checks OS8-managed Node first (guaranteed Node 20+), then system paths.
 */
function findNpm() {
  // Check OS8-managed Node first
  const os8Npm = path.join(OS8_NODE_BIN, 'npm');
  if (fs.existsSync(os8Npm)) return os8Npm;

  // System paths
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
