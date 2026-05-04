#!/usr/bin/env node
/**
 * Phase 4 PR 4.9 — drift check between the preload SDK and the .d.ts.
 * Phase 5 PR 5.2 — extended with --include-published mode that also
 * cross-references the published `@os8/sdk-types` package on npm.
 *
 * Compares the keys assigned onto `sdk` in src/preload-external-app.js
 * against the interface members in src/templates/os8-sdk.d.ts. Diverges
 * when:
 *   - preload exposes a key the .d.ts doesn't declare (under-typed
 *     surface; consumers won't get autocomplete).
 *   - .d.ts declares a key the preload doesn't expose (false promise;
 *     consumers will see TypeError at runtime).
 *
 * With --include-published, additionally fetches @os8/sdk-types@latest
 * from the npm registry and verifies its index.d.ts matches our local
 * canonical byte-for-byte. Soft-fails (exit 0 with a warning) when the
 * package is not yet published; hard-fails (exit 1) on actual drift.
 *
 * Exits non-zero on drift so the CI job fails the PR.
 *
 * Usage:
 *   node tools/check-sdk-drift.js                      # preload vs .d.ts only
 *   node tools/check-sdk-drift.js --include-published  # also vs npm
 */

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const os = require('node:os');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const PRELOAD_PATH = path.join(REPO_ROOT, 'src', 'preload-external-app.js');
const DTS_PATH = path.join(REPO_ROOT, 'src', 'templates', 'os8-sdk.d.ts');
const NPM_PACKAGE_NAME = '@os8/sdk-types';

const argv = process.argv.slice(2);
const INCLUDE_PUBLISHED = argv.includes('--include-published');

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

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5 PR 5.2 — npm registry cross-check.
// ─────────────────────────────────────────────────────────────────────────────

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'os8-drift-check' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks) });
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Resolve the latest tarball URL for an npm package. Returns null on
 * 404 (package not yet published — soft-fail signal).
 */
async function fetchLatestTarballUrl(pkgName) {
  const escaped = pkgName.replace('/', '%2F');
  const url = `https://registry.npmjs.org/${escaped}/latest`;
  const r = await fetchUrl(url);
  if (r.status === 404) return null;
  if (r.status !== 200) {
    throw new Error(`npm registry returned ${r.status} for ${pkgName}`);
  }
  const meta = JSON.parse(r.body.toString('utf8'));
  return { tarball: meta?.dist?.tarball, version: meta?.version };
}

/**
 * Download the tarball and extract a single file path. npm tarballs
 * are gzipped tar; we shell out to `tar` to keep the script tiny.
 * Returns the file's UTF-8 content, or null if the file is absent.
 */
async function downloadAndExtract(tarballUrl, fileInTarball) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-drift-'));
  const tgzPath = path.join(tmpDir, 'pkg.tgz');
  try {
    const r = await fetchUrl(tarballUrl);
    if (r.status !== 200) {
      throw new Error(`tarball download returned ${r.status}`);
    }
    fs.writeFileSync(tgzPath, r.body);
    // tar -xzf <tgz> -C <tmp> <file> — npm tarballs prefix every entry
    // with `package/`, so the canonical extract path is `package/index.d.ts`.
    const tar = spawnSync('tar', ['-xzf', tgzPath, '-C', tmpDir, fileInTarball], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (tar.status !== 0) {
      // File not in tarball — return null rather than throw.
      return null;
    }
    const extracted = path.join(tmpDir, fileInTarball);
    if (!fs.existsSync(extracted)) return null;
    return fs.readFileSync(extracted, 'utf8');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

async function checkPublishedDtsMatchesLocal() {
  const localDts = readFile(DTS_PATH);

  let resolved;
  try {
    resolved = await fetchLatestTarballUrl(NPM_PACKAGE_NAME);
  } catch (err) {
    console.warn(`drift-check: npm registry lookup failed (${err.message}) — skipping --include-published`);
    return 'soft-skip';
  }
  if (!resolved) {
    console.warn(`drift-check: ${NPM_PACKAGE_NAME} not yet published — skipping --include-published`);
    console.warn('  (this warning becomes a hard error 30 days post-publish)');
    return 'soft-skip';
  }

  let publishedDts;
  try {
    publishedDts = await downloadAndExtract(resolved.tarball, 'package/index.d.ts');
  } catch (err) {
    console.warn(`drift-check: tarball extract failed (${err.message}) — skipping`);
    return 'soft-skip';
  }
  if (publishedDts == null) {
    console.warn(`drift-check: published ${NPM_PACKAGE_NAME}@${resolved.version} has no index.d.ts — skipping`);
    return 'soft-skip';
  }

  if (publishedDts === localDts) {
    console.log(`Published ${NPM_PACKAGE_NAME}@${resolved.version} matches local canonical .d.ts`);
    return 'ok';
  }

  console.error(`DRIFT: ${NPM_PACKAGE_NAME}@${resolved.version} on npm diverges from local src/templates/os8-sdk.d.ts`);
  console.error('  local: ' + DTS_PATH);
  console.error(`  published: https://www.npmjs.com/package/${NPM_PACKAGE_NAME}/v/${resolved.version}`);
  console.error('');
  console.error('Fix: cut a new release of os8ai/os8-sdk-types matching the local file.');
  console.error('  cd /path/to/os8-sdk-types');
  console.error('  bash tools/sync-from-os8.sh /path/to/os8     # if you have it locally');
  console.error('  # bump version in package.json + add CHANGELOG entry');
  console.error('  git commit -am "release vX.Y.Z" && git tag vX.Y.Z && git push --tags');
  return 'drift';
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const preload = readFile(PRELOAD_PATH);
  const dts = readFile(DTS_PATH);

  const preloadKeys = extractPreloadKeys(preload);
  const dtsKeys = extractDtsKeys(dts);

  const inPreloadNotDts = difference(preloadKeys, dtsKeys);
  const inDtsNotPreload = difference(dtsKeys, preloadKeys);

  let exit = 0;

  if (inPreloadNotDts.length === 0 && inDtsNotPreload.length === 0) {
    console.log(`SDK types in sync with preload (${preloadKeys.size} keys)`);
  } else {
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
    exit = 1;
  }

  if (INCLUDE_PUBLISHED) {
    const publishedResult = await checkPublishedDtsMatchesLocal();
    if (publishedResult === 'drift') exit = 1;
    // 'soft-skip' and 'ok' don't change exit code
  }

  process.exit(exit);
}

main().catch((err) => {
  console.error('drift-check: unexpected error:', err.stack || err.message);
  process.exit(2);
});
