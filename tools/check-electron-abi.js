#!/usr/bin/env node
/**
 * prestart hook — guarantee better-sqlite3 is built for the current Electron
 * before `npm start` boots Electron.
 *
 * Why this exists: pretest/posttest hooks bounce the better-sqlite3 binary
 * between system-Node ABI and Electron-Node ABI on every `npm test` run.
 * In practice the posttest hook isn't always reliable (interrupted runs,
 * concurrent invocations, Ctrl+C), and `npm start` then crashes with
 * `NODE_MODULE_VERSION 127 vs 143`. This hook makes that mismatch
 * recoverable without manual intervention — it detects via a marker file
 * and rebuilds only when needed (so happy-path `npm start` adds <50ms).
 *
 * The marker is written by tools/rebuild-native.js after each successful
 * Electron-target rebuild. Missing or stale → rebuild. Present + matches
 * the current Electron version → skip.
 */

const fs = require('fs');
const path = require('path');

const electronVersion = require('electron/package.json').version;
const markerPath = path.join(__dirname, '..', 'node_modules', 'better-sqlite3', '.built-for');
const expected = `electron-${electronVersion}`;

let current = null;
try {
  current = fs.readFileSync(markerPath, 'utf8').trim();
} catch (_e) {
  // Marker missing — first run after a fresh install or a clobbering build.
}

if (current === expected) {
  // Already built for this Electron — nothing to do.
  process.exit(0);
}

console.log(`[prestart] better-sqlite3 marker says "${current || '(missing)'}", need "${expected}" — rebuilding`);
require('./rebuild-native');
