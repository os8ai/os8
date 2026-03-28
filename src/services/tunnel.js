/**
 * TunnelService - Cloudflare quick tunnel for remote access
 *
 * Binary stored in ~/os8/models/tunnel/
 * Automatically downloads cloudflared if not present
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { execSync } = require('child_process');
const { MODELS_DIR } = require('../config');

const TUNNEL_DIR = path.join(MODELS_DIR, 'tunnel');
const CLOUDFLARED_BINARY = path.join(TUNNEL_DIR, 'cloudflared');

// Download URL for macOS ARM64 (Apple Silicon)
const CLOUDFLARED_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz';

let tunnelProcess = null;
let currentUrl = null;
let onUrlCallback = null;

/**
 * Ensure tunnel directory exists
 */
function ensureDir() {
  if (!fs.existsSync(TUNNEL_DIR)) {
    fs.mkdirSync(TUNNEL_DIR, { recursive: true });
  }
}

/**
 * Check if cloudflared binary exists in our directory
 */
function isInstalled() {
  return fs.existsSync(CLOUDFLARED_BINARY);
}

/**
 * Get setup status
 */
function getStatus() {
  return {
    ready: isInstalled(),
    binaryPath: CLOUDFLARED_BINARY,
    isRunning: tunnelProcess !== null,
    currentUrl
  };
}

/**
 * Download a file with progress callback, following redirects
 */
function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);

    const request = (url) => {
      const protocol = url.startsWith('https') ? https : require('http');

      protocol.get(url, (response) => {
        // Handle redirects
        if (response.statusCode === 301 || response.statusCode === 302) {
          file.close();
          fs.unlinkSync(destPath);
          const newFile = fs.createWriteStream(destPath);
          downloadFileToStream(response.headers.location, newFile, onProgress)
            .then(resolve)
            .catch(reject);
          return;
        }

        if (response.statusCode !== 200) {
          reject(new Error(`Download failed: ${response.statusCode}`));
          return;
        }

        const totalSize = parseInt(response.headers['content-length'], 10);
        let downloadedSize = 0;

        response.on('data', (chunk) => {
          downloadedSize += chunk.length;
          if (onProgress && totalSize) {
            onProgress(downloadedSize / totalSize);
          }
        });

        response.pipe(file);

        file.on('finish', () => {
          file.close();
          resolve();
        });
      }).on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    };

    request(url);
  });
}

function downloadFileToStream(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : require('http');

    protocol.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        const newFile = fs.createWriteStream(file.path);
        downloadFileToStream(response.headers.location, newFile, onProgress)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Download failed: ${response.statusCode}`));
        return;
      }

      const totalSize = parseInt(response.headers['content-length'], 10);
      let downloadedSize = 0;

      response.on('data', (chunk) => {
        downloadedSize += chunk.length;
        if (onProgress && totalSize) {
          onProgress(downloadedSize / totalSize);
        }
      });

      response.pipe(file);

      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Download and setup cloudflared binary
 */
async function setup(onProgress) {
  ensureDir();

  if (isInstalled()) {
    console.log('Tunnel: cloudflared already installed');
    onProgress?.(1);
    return getStatus();
  }

  console.log('Tunnel: Downloading cloudflared...');

  const tgzPath = path.join(TUNNEL_DIR, 'cloudflared.tgz');

  try {
    // Download the tarball
    await downloadFile(CLOUDFLARED_URL, tgzPath, (p) => {
      onProgress?.(p * 0.8); // 80% for download
    });

    console.log('Tunnel: Extracting...');

    // Extract the tarball
    execSync(`tar -xzf cloudflared.tgz`, { cwd: TUNNEL_DIR });

    // Make executable
    fs.chmodSync(CLOUDFLARED_BINARY, 0o755);

    // Clean up tarball
    fs.unlinkSync(tgzPath);

    console.log('Tunnel: cloudflared installed successfully');
    onProgress?.(1);

    return getStatus();
  } catch (err) {
    // Clean up on failure
    try { fs.unlinkSync(tgzPath); } catch (e) {}
    try { fs.unlinkSync(CLOUDFLARED_BINARY); } catch (e) {}
    throw err;
  }
}

/**
 * Start a quick tunnel to the given port
 * @param {number} port - Local port to tunnel
 * @param {function} onUrl - Callback when URL is obtained
 * @returns {Promise<string>} - The tunnel URL
 */
function start(port, onUrl) {
  return new Promise((resolve, reject) => {
    if (tunnelProcess) {
      // Already running
      if (currentUrl) {
        resolve(currentUrl);
      }
      return;
    }

    if (!isInstalled()) {
      reject(new Error('cloudflared not installed. Call setup() first.'));
      return;
    }

    onUrlCallback = onUrl;

    console.log('Tunnel: Starting Cloudflare quick tunnel...');

    tunnelProcess = spawn(CLOUDFLARED_BINARY, ['tunnel', '--url', `http://localhost:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let resolved = false;

    // Parse output for the tunnel URL
    const parseOutput = (data) => {
      try {
        const text = data.toString();

        // Look for the trycloudflare.com URL
        const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (match && !resolved) {
          resolved = true;
          currentUrl = match[0];
          console.log(`Tunnel: Ready at ${currentUrl}`);

          if (onUrlCallback) {
            onUrlCallback(currentUrl);
          }

          resolve(currentUrl);
        }
      } catch (err) {
        // Ignore EPIPE errors when process closes
        if (err.code !== 'EPIPE') {
          console.error('Tunnel: parseOutput error:', err.message);
        }
      }
    };

    tunnelProcess.stdout.on('data', parseOutput);
    tunnelProcess.stderr.on('data', parseOutput);

    tunnelProcess.on('error', (err) => {
      console.error('Tunnel: Failed to start:', err.message);
      tunnelProcess = null;
      if (!resolved) {
        reject(err);
      }
    });

    tunnelProcess.on('exit', (code) => {
      console.log(`Tunnel: Process exited with code ${code}`);
      tunnelProcess = null;
      currentUrl = null;
    });

    // Timeout if URL not found within 30 seconds
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error('Tunnel: Timeout waiting for URL'));
      }
    }, 30000);
  });
}

/**
 * Stop the tunnel
 */
function stop() {
  if (tunnelProcess) {
    console.log('Tunnel: Stopping...');
    tunnelProcess.kill();
    tunnelProcess = null;
    currentUrl = null;
  }
}

/**
 * Get the current tunnel URL
 */
function getUrl() {
  return currentUrl;
}

/**
 * Check if tunnel is running
 */
function isRunning() {
  return tunnelProcess !== null;
}

module.exports = {
  isInstalled,
  getStatus,
  setup,
  start,
  stop,
  getUrl,
  isRunning
};
