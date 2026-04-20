#!/usr/bin/env node
/**
 * Rebuild better-sqlite3 against the installed Electron's Node ABI.
 *
 * Why not @electron/rebuild or electron-rebuild directly?
 * Those tools can silently fall through to prebuild-install, which downloads
 * a prebuilt binary targeting the *system* Node's ABI (e.g. Node 22 = ABI 127)
 * instead of Electron's (e.g. Electron 40 = ABI 143). The rebuild tool reports
 * "Rebuild Complete" even when the on-disk binary still has the wrong ABI.
 * Symptom: `npm start` crashes at Electron boot with a NODE_MODULE_VERSION
 * mismatch. electron-builder on CI avoids this because it invokes node-gyp
 * directly with the Electron target — so shipped binaries are fine, but
 * local source runs are broken.
 *
 * Fix: call node-gyp directly with --target=<electron-version> and
 * --dist-url=https://electronjs.org/headers, which is what electron-builder
 * does internally. Bypasses the prebuild path entirely.
 */

const { execSync } = require('child_process');
const path = require('path');

const electronVersion = require('electron/package.json').version;
const betterSqliteDir = path.join(__dirname, '..', 'node_modules', 'better-sqlite3');

console.log(`[postinstall] Rebuilding better-sqlite3 against Electron ${electronVersion} headers...`);

execSync(
  `npx node-gyp rebuild --target=${electronVersion} --dist-url=https://electronjs.org/headers --release`,
  { cwd: betterSqliteDir, stdio: 'inherit' }
);

console.log('[postinstall] better-sqlite3 rebuild complete');
