#!/usr/bin/env node
/**
 * Quiet electron launcher — spawns electron and filters out stderr noise
 * from Chromium's Linux internals that has nothing to do with OS8.
 *
 * The three patterns filtered here are all documented benign warnings:
 *   1. `GLib-GObject: g_object_unref: assertion 'G_IS_OBJECT...` — GTK/GLib
 *      lifecycle warning during Chromium shutdown or extension init.
 *   2. `Failed to call method: org.freedesktop.systemd1.Manager.StartTransientUnit`
 *      — DBus systemd scope creation fails when the user doesn't have a
 *      graphical-session.target running (common on bare/headless boxes).
 *   3. `GPU process exited unexpectedly: exit_code=139` — SIGSEGV during
 *      Chromium GPU process init; it silently retries and works anyway.
 *
 * Anything not matching a known pattern passes through unchanged, so real
 * stderr output (uncaught exceptions, our own console.error, etc.) still
 * shows up.
 *
 * Escape hatch: set `OS8_NO_FILTER=1` in the environment to see everything.
 * Use it if you're diagnosing a boot issue and want the unfiltered log.
 */

const { spawn } = require('child_process');

// Narrow patterns — each captures a specific Chromium/Linux warning class.
// Resist the urge to add broad matchers: filtering real errors is worse
// than leaving the noise in.
const NOISE_PATTERNS = [
  /GLib-GObject: g_object_unref: assertion 'G_IS_OBJECT/,
  /Failed to call method: org\.freedesktop\.systemd1\.Manager\.StartTransientUnit/,
  /content\/browser\/gpu\/gpu_process_host\.cc.*GPU process exited unexpectedly: exit_code=139/,
];

function isNoise(line) {
  return NOISE_PATTERNS.some(p => p.test(line));
}

const electronBin = require('electron');
const passthrough = process.env.OS8_NO_FILTER === '1';

const child = spawn(electronBin, ['.', ...process.argv.slice(2)], {
  stdio: ['inherit', 'inherit', passthrough ? 'inherit' : 'pipe']
});

if (!passthrough && child.stderr) {
  // Split incoming bytes on newlines and re-emit only non-noise lines.
  // A tiny buffer handles chunks that don't end on a line boundary.
  let buffer = '';
  child.stderr.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!isNoise(line)) process.stderr.write(line + '\n');
    }
  });
  child.stderr.on('end', () => {
    if (buffer && !isNoise(buffer)) process.stderr.write(buffer);
  });
}

child.on('close', code => { process.exit(code ?? 0); });
child.on('error', err => {
  console.error('[start-electron-quiet] spawn failed:', err.message);
  process.exit(1);
});

// Forward signals so Ctrl+C in the terminal cleanly stops electron.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try { child.kill(sig); } catch { /* already gone */ }
  });
}
