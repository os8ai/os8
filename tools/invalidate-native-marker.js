#!/usr/bin/env node
/**
 * pretest hook — invalidate the better-sqlite3 ABI marker before tests run.
 *
 * `npm test`'s pretest rebuilds better-sqlite3 against system Node so vitest
 * (a Node process) can `require('better-sqlite3')`. The actual rebuild is
 * `npm rebuild better-sqlite3`, which does NOT touch
 * `node_modules/better-sqlite3/.built-for` — the marker is a contract owned
 * by `tools/rebuild-native.js`. Result: after pretest, the binary is
 * Node-ABI but the marker still says `electron-X.Y` (left over from the
 * last Electron rebuild).
 *
 * `tools/check-electron-abi.js` (the prestart hook) reads the marker, sees
 * it matches the current Electron version, and skips the rebuild — even
 * though the binary is wrong for Electron. `npm start` then crashes with
 * NODE_MODULE_VERSION mismatch.
 *
 * This script removes the marker so the next `npm start`'s prestart check
 * sees `(missing)` and triggers a real rebuild. Cross-platform via Node fs.
 */

const fs = require('fs');
const path = require('path');

const markerPath = path.join(__dirname, '..', 'node_modules', 'better-sqlite3', '.built-for');
try {
  fs.unlinkSync(markerPath);
  console.log('[pretest] invalidated electron-abi marker (npm start will rebuild before launching)');
} catch (e) {
  if (e.code === 'ENOENT') {
    // Marker already absent — nothing to do. Common after a fresh `npm install`
    // before the postinstall rebuild has run, or after a previous pretest.
  } else {
    console.warn(`[pretest] could not invalidate marker: ${e.message}`);
  }
}
