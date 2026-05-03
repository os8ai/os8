/**
 * Phase 4 PR 4.8 — cross-platform sanity tests.
 *
 * Lightweight assertions that verify the codebase's platform-agnostic
 * primitives behave the same on macos-14 / ubuntu-22.04 / windows-2022.
 * If one of these starts failing on Windows, it's a signal the runner
 * image needs attention, not user code.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import fs from 'node:fs';

describe('cross-platform — Phase 4 PR 4.8 sanity', () => {
  it('process.platform is one of the supported triple', () => {
    expect(['darwin', 'linux', 'win32']).toContain(process.platform);
  });

  it('os.tmpdir() returns a writable absolute path', () => {
    const tmp = os.tmpdir();
    expect(path.isAbsolute(tmp)).toBe(true);
    const probe = path.join(tmp, `os8-cross-platform-${Date.now()}.tmp`);
    fs.writeFileSync(probe, 'x', 'utf8');
    expect(fs.readFileSync(probe, 'utf8')).toBe('x');
    fs.unlinkSync(probe);
  });

  it('path.join uses the correct separator for the OS', () => {
    const joined = path.join('a', 'b', 'c');
    if (process.platform === 'win32') {
      expect(joined.includes(path.sep)).toBe(true); // either \ or /
    } else {
      expect(joined).toBe('a/b/c');
    }
  });

  it('crypto.randomUUID produces a valid UUID', () => {
    const id = crypto.randomUUID();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('crypto.randomBytes hex is the expected length', () => {
    expect(crypto.randomBytes(16).toString('hex')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('os.homedir() returns an absolute path', () => {
    expect(path.isAbsolute(os.homedir())).toBe(true);
  });

  it('fs.mkdirSync recursive is idempotent', () => {
    const tmp = path.join(os.tmpdir(), `os8-mkdir-${Date.now()}`);
    fs.mkdirSync(tmp, { recursive: true });
    fs.mkdirSync(tmp, { recursive: true }); // re-run must not throw
    expect(fs.existsSync(tmp)).toBe(true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
