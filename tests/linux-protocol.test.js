/**
 * Unit tests for src/services/linux-protocol.js.
 *
 * Pure functions are tested directly. registerOnLinux is tested with
 * a temp HOME so the user's real ~/.local/share/applications stays
 * untouched. update-desktop-database is exercised opportunistically —
 * if the binary isn't on PATH, the soft-fail path covers it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  registerOnLinux,
  buildDesktopContent,
  needsRewrite,
  getExecCommand,
  quoteForExec,
} from '../src/services/linux-protocol.js';

describe('linux-protocol — quoteForExec', () => {
  it('passes plain paths through unchanged', () => {
    expect(quoteForExec('/opt/OS8/os8')).toBe('/opt/OS8/os8');
    expect(quoteForExec('/home/leo/Claude/os8/node_modules/.bin/electron')).toBe(
      '/home/leo/Claude/os8/node_modules/.bin/electron'
    );
  });

  it('quotes paths with spaces', () => {
    expect(quoteForExec('/Applications/My App.app/Contents/MacOS/electron'))
      .toBe('"/Applications/My App.app/Contents/MacOS/electron"');
  });

  it('escapes embedded quotes and backslashes', () => {
    expect(quoteForExec('/tmp/weird"path')).toBe('"/tmp/weird\\"path"');
  });
});

describe('linux-protocol — getExecCommand', () => {
  it('packaged: just the binary', () => {
    expect(getExecCommand({
      execPath: '/opt/OS8/os8',
      appPath: '/opt/OS8/resources/app.asar',
      isPackaged: true,
    })).toBe('/opt/OS8/os8');
  });

  it('dev: binary + app source root', () => {
    expect(getExecCommand({
      execPath: '/home/leo/Claude/os8/node_modules/.bin/electron',
      appPath: '/home/leo/Claude/os8',
      isPackaged: false,
    })).toBe('/home/leo/Claude/os8/node_modules/.bin/electron /home/leo/Claude/os8');
  });

  it('dev with spaces in path: quotes both', () => {
    expect(getExecCommand({
      execPath: '/Users/me/My Code/os8/node_modules/.bin/electron',
      appPath: '/Users/me/My Code/os8',
      isPackaged: false,
    })).toBe('"/Users/me/My Code/os8/node_modules/.bin/electron" "/Users/me/My Code/os8"');
  });
});

describe('linux-protocol — buildDesktopContent', () => {
  it('produces a valid .desktop file', () => {
    const out = buildDesktopContent({ execCommand: '/opt/OS8/os8' });
    expect(out).toContain('[Desktop Entry]');
    expect(out).toContain('Name=OS8');
    expect(out).toContain('Exec=/opt/OS8/os8 %u');
    expect(out).toContain('MimeType=x-scheme-handler/os8;');
    expect(out).toContain('Type=Application');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('is byte-identical for identical input (idempotency)', () => {
    const a = buildDesktopContent({ execCommand: '/opt/OS8/os8' });
    const b = buildDesktopContent({ execCommand: '/opt/OS8/os8' });
    expect(a).toBe(b);
  });
});

describe('linux-protocol — needsRewrite', () => {
  const expectedExec = '/opt/OS8/os8';

  it('rewrites when file is missing', () => {
    expect(needsRewrite({ existing: null, expectedExec })).toBe(true);
  });

  it('rewrites when MimeType is missing', () => {
    const existing = `[Desktop Entry]
Name=OS8
Exec=/opt/OS8/os8 %U
Type=Application
Categories=Development;
`;
    expect(needsRewrite({ existing, expectedExec })).toBe(true);
  });

  it('rewrites when MimeType claims something else but not os8', () => {
    const existing = `[Desktop Entry]
Name=OS8
Exec=/opt/OS8/os8 %u
MimeType=text/html;
`;
    expect(needsRewrite({ existing, expectedExec })).toBe(true);
  });

  it('rewrites when Exec line is absent', () => {
    const existing = `[Desktop Entry]
Name=OS8
MimeType=x-scheme-handler/os8;
`;
    expect(needsRewrite({ existing, expectedExec })).toBe(true);
  });

  it('rewrites when Exec target differs', () => {
    const existing = `[Desktop Entry]
Name=OS8
Exec=/some/other/electron /home/me/old-os8 %u
MimeType=x-scheme-handler/os8;
`;
    expect(needsRewrite({ existing, expectedExec })).toBe(true);
  });

  it('skips when Exec matches and MimeType claims os8 (with %u)', () => {
    const existing = `[Desktop Entry]
Name=OS8
Exec=/opt/OS8/os8 %u
MimeType=x-scheme-handler/os8;
`;
    expect(needsRewrite({ existing, expectedExec })).toBe(false);
  });

  it('skips when Exec matches and MimeType claims os8 (with %U)', () => {
    const existing = `[Desktop Entry]
Name=OS8
Exec=/opt/OS8/os8 %U
MimeType=x-scheme-handler/os8;
`;
    expect(needsRewrite({ existing, expectedExec })).toBe(false);
  });

  it('tolerates extra MimeType claims (text/html;x-scheme-handler/os8;)', () => {
    const existing = `[Desktop Entry]
Name=OS8
Exec=/opt/OS8/os8 %u
MimeType=text/html;x-scheme-handler/os8;
`;
    expect(needsRewrite({ existing, expectedExec })).toBe(false);
  });
});

describe('linux-protocol — registerOnLinux', () => {
  let tmpHome;
  const captured = { warn: [], log: [] };
  const logger = {
    warn: (m) => captured.warn.push(m),
    log: (m) => captured.log.push(m),
  };

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-linux-protocol-'));
    captured.warn = [];
    captured.log = [];
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('skips on darwin', async () => {
    const result = await registerOnLinux({
      platform: 'darwin',
      execPath: '/Applications/OS8.app/Contents/MacOS/OS8',
      appPath: '/Applications/OS8.app',
      isPackaged: true,
      homeDir: tmpHome,
      logger,
    });
    expect(result).toEqual({ skipped: 'not-linux' });
    expect(fs.existsSync(path.join(tmpHome, '.local'))).toBe(false);
  });

  it('skips on win32', async () => {
    const result = await registerOnLinux({
      platform: 'win32',
      appPath: 'C:\\Program Files\\OS8\\resources\\app.asar',
      isPackaged: true,
      homeDir: tmpHome,
      logger,
    });
    expect(result).toEqual({ skipped: 'not-linux' });
  });

  it('skips when appPath is missing', async () => {
    const result = await registerOnLinux({
      platform: 'linux',
      execPath: '/opt/OS8/os8',
      isPackaged: true,
      homeDir: tmpHome,
      logger,
    });
    expect(result).toEqual({ skipped: 'no-app-path' });
  });

  it('writes a fresh .desktop file when missing', async () => {
    const result = await registerOnLinux({
      platform: 'linux',
      execPath: '/opt/OS8/os8',
      appPath: '/opt/OS8/resources/app.asar',
      isPackaged: true,
      homeDir: tmpHome,
      logger,
    });
    const expectedFile = path.join(tmpHome, '.local', 'share', 'applications', 'os8.desktop');
    expect(result.wrote).toBe(expectedFile);
    expect(fs.existsSync(expectedFile)).toBe(true);
    const content = fs.readFileSync(expectedFile, 'utf8');
    expect(content).toContain('Exec=/opt/OS8/os8 %u');
    expect(content).toContain('MimeType=x-scheme-handler/os8;');
  });

  it('skips when file exists and is up-to-date', async () => {
    const dir = path.join(tmpHome, '.local', 'share', 'applications');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'os8.desktop');
    fs.writeFileSync(file, buildDesktopContent({ execCommand: '/opt/OS8/os8' }), 'utf8');
    const before = fs.statSync(file).mtimeMs;

    // Sleep at least 1ms so mtime would differ if a write occurred.
    await new Promise(r => setTimeout(r, 5));

    const result = await registerOnLinux({
      platform: 'linux',
      execPath: '/opt/OS8/os8',
      appPath: '/opt/OS8/resources/app.asar',
      isPackaged: true,
      homeDir: tmpHome,
      logger,
    });
    expect(result).toEqual({ skipped: 'up-to-date' });
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });

  it('rewrites when existing file lacks MimeType (the system AppImage bug)', async () => {
    const dir = path.join(tmpHome, '.local', 'share', 'applications');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'os8.desktop');
    // Mimic the broken /usr/share/applications/os8.desktop we saw in the wild.
    fs.writeFileSync(file, `[Desktop Entry]
Name=OS8
Exec=/opt/OS8/os8 %U
Type=Application
`, 'utf8');

    const result = await registerOnLinux({
      platform: 'linux',
      execPath: '/opt/OS8/os8',
      appPath: '/opt/OS8/resources/app.asar',
      isPackaged: true,
      homeDir: tmpHome,
      logger,
    });
    expect(result.wrote).toBe(file);
    const content = fs.readFileSync(file, 'utf8');
    expect(content).toContain('MimeType=x-scheme-handler/os8;');
  });

  it('rewrites with dev-mode Exec (electron + appPath)', async () => {
    const result = await registerOnLinux({
      platform: 'linux',
      execPath: '/home/me/proj/node_modules/.bin/electron',
      appPath: '/home/me/proj',
      isPackaged: false,
      homeDir: tmpHome,
      logger,
    });
    const file = path.join(tmpHome, '.local', 'share', 'applications', 'os8.desktop');
    const content = fs.readFileSync(file, 'utf8');
    expect(content).toContain('Exec=/home/me/proj/node_modules/.bin/electron /home/me/proj %u');
  });
});
