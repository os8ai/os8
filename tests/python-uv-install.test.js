/**
 * PR 2.1 — uv auto-install + checksum verification.
 *
 * Exercises ensureUv() with a mocked downloader so tests don't hit the
 * network. Real downloads are covered indirectly by the live tests gated
 * behind OS8_PYTHON_LIVE_TEST=1 in runtime-adapters-python.test.js.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

// Each test gets its own OS8_HOME so OS8_BIN_DIR points at a fresh location.
function freshOs8Home() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'os8-uv-test-'));
}

function loadModules(os8Home) {
  process.env.OS8_HOME = os8Home;
  // Reload config + adapter so OS8_BIN_DIR is recomputed.
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/services/runtime-adapters/python')];
  const config = require('../src/config');
  const PyAdapter = require('../src/services/runtime-adapters/python');
  return { config, PyAdapter };
}

// Build a tiny tar.gz containing `<inner>/uv` so tar.x extracts a usable file
// at OS8_BIN_DIR/uv after strip:1 + filter.
async function buildUvTarball(inner, contents = '#!/bin/sh\necho stub uv 0.5.5\n') {
  const tar = require('tar');
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-uv-stage-'));
  const innerDir = path.join(stage, inner);
  fs.mkdirSync(innerDir, { recursive: true });
  fs.writeFileSync(path.join(innerDir, 'uv'), contents);
  fs.chmodSync(path.join(innerDir, 'uv'), 0o755);
  const outFile = path.join(stage, 'uv.tar.gz');
  await tar.c({
    file: outFile,
    cwd: stage,
    gzip: true,
  }, [inner]);
  const buf = fs.readFileSync(outFile);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  fs.rmSync(stage, { recursive: true, force: true });
  return { buf, sha };
}

describe('ensureUv — caches at OS8_BIN_DIR', () => {
  let os8Home;
  let prevHome;
  beforeEach(() => {
    prevHome = process.env.OS8_HOME;
    os8Home = freshOs8Home();
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.OS8_HOME; else process.env.OS8_HOME = prevHome;
    fs.rmSync(os8Home, { recursive: true, force: true });
  });

  it('returns cached path if uv exists in OS8_BIN_DIR', async () => {
    const { config, PyAdapter } = loadModules(os8Home);
    fs.mkdirSync(config.OS8_BIN_DIR, { recursive: true });
    const target = path.join(config.OS8_BIN_DIR, 'uv');
    fs.writeFileSync(target, '#!/bin/sh\necho cached\n');
    fs.chmodSync(target, 0o755);
    const got = await PyAdapter._internal.ensureUv();
    expect(got).toBe(target);
  });
});

describe('ensureUv — download + checksum verification', () => {
  let os8Home;
  let prevHome;
  let prevPath;
  beforeEach(() => {
    prevHome = process.env.OS8_HOME;
    prevPath = process.env.PATH;
    // Ensure host uv is NOT discoverable for these tests so we exercise
    // the download path. Set PATH to a tempdir we know is empty.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-empty-path-'));
    process.env.PATH = empty;
    os8Home = freshOs8Home();
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.OS8_HOME; else process.env.OS8_HOME = prevHome;
    process.env.PATH = prevPath;
    fs.rmSync(os8Home, { recursive: true, force: true });
  });

  it('downloads, verifies checksum, extracts uv to OS8_BIN_DIR', async () => {
    const { config, PyAdapter } = loadModules(os8Home);
    if (process.platform === 'win32') return;     // POSIX-only test path

    const archKey = process.arch === 'arm64' ? 'arm64' : 'x64';
    const platKey = `${process.platform}-${archKey}`;
    const inner = PyAdapter._internal.UV_TARBALL_INNER[platKey];
    if (!inner) return;                            // unsupported plat — skip

    const { buf, sha } = await buildUvTarball(inner, '#!/bin/sh\necho fake uv\n');

    // Override the real checksum constant BEFORE ensureUv reads it.
    PyAdapter._internal.UV_CHECKSUMS[platKey] = sha;

    PyAdapter._internal._setDownloader(async (_url, dest, expected) => {
      fs.writeFileSync(dest, buf);
      const got = crypto.createHash('sha256').update(buf).digest('hex');
      if (got !== expected) {
        try { fs.unlinkSync(dest); } catch (_) { /* ignore */ }
        throw new Error(`checksum mismatch in test stub (expected ${expected} got ${got})`);
      }
    });

    try {
      const got = await PyAdapter._internal.ensureUv();
      expect(got).toBe(path.join(config.OS8_BIN_DIR, 'uv'));
      expect(fs.existsSync(got)).toBe(true);
      expect(fs.readFileSync(got, 'utf8')).toContain('fake uv');
    } finally {
      PyAdapter._internal._resetDownloader();
    }
  });

  it('rejects with checksum mismatch when downloader returns wrong bytes', async () => {
    const { PyAdapter } = loadModules(os8Home);
    if (process.platform === 'win32') return;

    const archKey = process.arch === 'arm64' ? 'arm64' : 'x64';
    const platKey = `${process.platform}-${archKey}`;
    const inner = PyAdapter._internal.UV_TARBALL_INNER[platKey];
    if (!inner) return;

    // Force a known-good checksum that the downloaded bytes can't match.
    PyAdapter._internal.UV_CHECKSUMS[platKey] = 'a'.repeat(64);

    PyAdapter._internal._setDownloader(async (_url, dest, expected) => {
      fs.writeFileSync(dest, Buffer.from('wrong bytes'));
      const got = crypto.createHash('sha256').update('wrong bytes').digest('hex');
      if (got !== expected) {
        try { fs.unlinkSync(dest); } catch (_) { /* ignore */ }
        throw new Error(`uv checksum mismatch: expected ${expected}, got ${got}`);
      }
    });

    try {
      await expect(PyAdapter._internal.ensureUv()).rejects.toThrow(/checksum mismatch/);
    } finally {
      PyAdapter._internal._resetDownloader();
    }
  });

  it('throws "uv unavailable" when the downloader fails', async () => {
    const { PyAdapter } = loadModules(os8Home);
    if (process.platform === 'win32') return;

    const archKey = process.arch === 'arm64' ? 'arm64' : 'x64';
    const platKey = `${process.platform}-${archKey}`;
    if (!PyAdapter._internal.UV_TARBALL_INNER[platKey]) return;

    PyAdapter._internal._setDownloader(async () => {
      throw new Error('uv unavailable: cannot reach github.com (ENOTFOUND)');
    });

    try {
      await expect(PyAdapter._internal.ensureUv()).rejects.toThrow(/uv unavailable/);
    } finally {
      PyAdapter._internal._resetDownloader();
    }
  });

  it('throws when the platform is unsupported', async () => {
    const { PyAdapter } = loadModules(os8Home);
    // Save and clobber the asset name to simulate "no prebuilt".
    const archKey = process.arch === 'arm64' ? 'arm64' : 'x64';
    const platKey = `${process.platform}-${archKey}`;
    const orig = PyAdapter._internal.UV_ASSET_NAME[platKey];
    delete PyAdapter._internal.UV_ASSET_NAME[platKey];
    try {
      await expect(PyAdapter._internal.ensureUv()).rejects.toThrow(/no prebuilt for/);
    } finally {
      PyAdapter._internal.UV_ASSET_NAME[platKey] = orig;
    }
  });
});
