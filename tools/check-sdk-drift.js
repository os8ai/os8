#!/usr/bin/env node
/**
 * Phase 4 PR 4.9 — drift check between the preload SDK and the .d.ts.
 *
 * Compares the keys assigned onto `sdk` in src/preload-external-app.js
 * against the interface members in src/templates/os8-sdk.d.ts. Diverges
 * when:
 *   - preload exposes a key the .d.ts doesn't declare (under-typed
 *     surface; consumers won't get autocomplete).
 *   - .d.ts declares a key the preload doesn't expose (false promise;
 *     consumers will see TypeError at runtime).
 *
 * Exits non-zero on drift so the CI job fails the PR.
 *
 * Usage: node tools/check-sdk-drift.js
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const PRELOAD_PATH = path.join(REPO_ROOT, 'src', 'preload-external-app.js');
const DTS_PATH = path.join(REPO_ROOT, 'src', 'templates', 'os8-sdk.d.ts');

function readFile(p) {
  if (!fs.existsSync(p)) {
    console.error(`drift-check: missing ${p}`);
    process.exit(2);
  }
  return fs.readFileSync(p, 'utf8');
}

function extractPreloadKeys(src) {
  // Two assignment shapes appear in preload:
  //   sdk.<key> = ...               // simple property
  //   sdk.<key>.<sub> = ...         // augments existing
  // We collect the top-level keys only (Os8Sdk-level interface members).
  const top = new Set();
  const re = /\bsdk\.([a-zA-Z][a-zA-Z0-9]*)\b/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    top.add(m[1]);
  }
  // The mcp branch uses a function assignment too; the regex above catches it.
  return top;
}

function extractDtsKeys(src) {
  // Pull `Os8Sdk` interface body and parse its property names.
  const startMarker = /export\s+interface\s+Os8Sdk\s*\{/;
  const start = src.search(startMarker);
  if (start < 0) return new Set();
  let depth = 0;
  let i = src.indexOf('{', start);
  const open = i;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const body = src.slice(open + 1, i);
  const keys = new Set();
  // Match `<name>?: ...;` or `<name>: ...;` at the start of a line.
  const propRe = /^\s*([a-zA-Z][a-zA-Z0-9]*)\s*\??\s*:/gm;
  let m;
  while ((m = propRe.exec(body)) !== null) {
    keys.add(m[1]);
  }
  return keys;
}

function difference(a, b) {
  const out = [];
  for (const k of a) if (!b.has(k)) out.push(k);
  return out;
}

const preload = readFile(PRELOAD_PATH);
const dts = readFile(DTS_PATH);

const preloadKeys = extractPreloadKeys(preload);
const dtsKeys = extractDtsKeys(dts);

const inPreloadNotDts = difference(preloadKeys, dtsKeys);
const inDtsNotPreload = difference(dtsKeys, preloadKeys);

if (inPreloadNotDts.length === 0 && inDtsNotPreload.length === 0) {
  console.log(`SDK types in sync with preload (${preloadKeys.size} keys)`);
  process.exit(0);
}

if (inPreloadNotDts.length > 0) {
  console.error('DRIFT: preload exposes keys not in .d.ts:');
  for (const k of inPreloadNotDts) console.error(`  - ${k}`);
}
if (inDtsNotPreload.length > 0) {
  console.error('DRIFT: .d.ts declares keys not in preload:');
  for (const k of inDtsNotPreload) console.error(`  - ${k}`);
}
console.error('');
console.error('Fix: update src/templates/os8-sdk.d.ts to match the preload shape, then');
console.error('mirror the change in os8ai/os8-sdk-types and cut a release.');
process.exit(1);
