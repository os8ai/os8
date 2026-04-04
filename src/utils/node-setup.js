/**
 * Auto-download Node.js to ~/.os8/node/ if the system Node is missing or too old.
 * Downloads a prebuilt tarball from nodejs.org — one-time ~40MB fetch.
 * Used by onboarding splash to guarantee Node 20+ for all CLI installs.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { SEARCH_PATH } = require('./npm-path');

// Target Node version — LTS 22.x
const NODE_VERSION = '22.16.0';
const MIN_NODE_MAJOR = 20;

const OS8_DIR = process.env.OS8_HOME || path.join(os.homedir(), 'os8');
const NODE_DIR = path.join(OS8_DIR, 'node');
const NODE_BIN = path.join(NODE_DIR, 'bin');

/**
 * Get the best available Node major version (OS8-managed first, then system).
 * Returns { version: number|null, path: string|null }
 */
function getNodeInfo() {
  // Check OS8-managed Node first
  const os8Node = path.join(NODE_BIN, 'node');
  if (fs.existsSync(os8Node)) {
    try {
      const ver = execSync(`${os8Node} --version`, { encoding: 'utf-8', timeout: 5000 }).trim();
      const match = ver.match(/^v(\d+)/);
      if (match) return { version: parseInt(match[1], 10), path: os8Node };
    } catch {}
  }

  // Check system Node
  const searchPath = `${NODE_BIN}:${SEARCH_PATH}`;
  try {
    const ver = execSync('node --version', {
      encoding: 'utf-8',
      timeout: 5000,
      env: { PATH: searchPath }
    }).trim();
    const match = ver.match(/^v(\d+)/);
    if (match) {
      const nodePath = execSync('which node', {
        encoding: 'utf-8',
        timeout: 5000,
        env: { PATH: searchPath }
      }).trim();
      return { version: parseInt(match[1], 10), path: nodePath };
    }
  } catch {}

  // Try user's PATH as last resort
  try {
    const ver = execSync('node --version', {
      encoding: 'utf-8',
      timeout: 5000,
      env: { PATH: process.env.PATH }
    }).trim();
    const match = ver.match(/^v(\d+)/);
    if (match) return { version: parseInt(match[1], 10), path: 'node' };
  } catch {}

  return { version: null, path: null };
}

/**
 * Check if Node 20+ is available. Returns { ok, version, needsDownload }.
 */
function checkNode() {
  const info = getNodeInfo();
  if (info.version && info.version >= MIN_NODE_MAJOR) {
    return { ok: true, version: info.version, needsDownload: false };
  }
  return { ok: false, version: info.version, needsDownload: true };
}

/**
 * Download and extract Node.js to ~/.os8/node/.
 * Returns { success, error }.
 * onProgress callback receives { percent, message }.
 */
async function downloadNode(onProgress = () => {}) {
  const platform = os.platform(); // 'linux' or 'darwin'
  const arch = os.arch() === 'arm64' ? 'arm64' : 'x64';

  if (platform !== 'linux' && platform !== 'darwin') {
    return { success: false, error: `Unsupported platform: ${platform}` };
  }

  const filename = `node-v${NODE_VERSION}-${platform}-${arch}`;
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${filename}.tar.gz`;
  const tmpDir = path.join(OS8_DIR, 'tmp');
  const tarPath = path.join(tmpDir, `${filename}.tar.gz`);

  fs.mkdirSync(tmpDir, { recursive: true });

  // Download
  onProgress({ percent: 0, message: `Downloading Node.js ${NODE_VERSION}...` });

  try {
    await new Promise((resolve, reject) => {
      const download = (downloadUrl) => {
        https.get(downloadUrl, (res) => {
          // Handle redirects
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            download(res.headers.location);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`Download failed: HTTP ${res.statusCode}`));
            return;
          }

          const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
          let receivedBytes = 0;
          const file = fs.createWriteStream(tarPath);

          res.on('data', (chunk) => {
            receivedBytes += chunk.length;
            if (totalBytes > 0) {
              const percent = Math.round((receivedBytes / totalBytes) * 100);
              onProgress({ percent, message: `Downloading Node.js... ${percent}%` });
            }
          });

          res.pipe(file);
          file.on('finish', () => { file.close(); resolve(); });
          file.on('error', reject);
        }).on('error', reject);
      };
      download(url);
    });

    // Extract
    onProgress({ percent: 100, message: 'Extracting Node.js...' });

    // Remove old installation if present
    if (fs.existsSync(NODE_DIR)) {
      fs.rmSync(NODE_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(NODE_DIR, { recursive: true });

    execSync(`tar -xzf ${tarPath} -C ${NODE_DIR} --strip-components=1`, {
      timeout: 60000
    });

    // Cleanup tarball
    fs.unlinkSync(tarPath);
    try { fs.rmdirSync(tmpDir); } catch {}

    // Verify
    const nodeExe = path.join(NODE_BIN, 'node');
    if (!fs.existsSync(nodeExe)) {
      return { success: false, error: 'Extraction succeeded but node binary not found' };
    }

    const ver = execSync(`${nodeExe} --version`, { encoding: 'utf-8', timeout: 5000 }).trim();
    onProgress({ percent: 100, message: `Node.js ${ver} installed` });

    return { success: true };
  } catch (e) {
    // Cleanup on failure
    try { fs.unlinkSync(tarPath); } catch {}
    return { success: false, error: e.message };
  }
}

module.exports = { checkNode, downloadNode, getNodeInfo, NODE_DIR, NODE_BIN, MIN_NODE_MAJOR };
