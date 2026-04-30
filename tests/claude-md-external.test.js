import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('claude-md-external — generateForExternal', () => {
  let tmpHome, prevHome, generateForExternal;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-claude-md-'));
    prevHome = process.env.OS8_HOME;
    process.env.OS8_HOME = tmpHome;
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/claude-md-external')];
    ({ generateForExternal } = require('../src/claude-md-external'));
    fs.mkdirSync(path.join(tmpHome, 'apps', 'app-1'), { recursive: true });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.OS8_HOME;
    else process.env.OS8_HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function appWithCaps(caps) {
    const yaml = `
schemaVersion: 1
slug: worldmonitor
name: World Monitor
publisher: koala73
upstream:
  git: https://github.com/koala73/worldmonitor.git
  ref: v2.5.23
permissions:
  network:
    outbound: true
    inbound: false
  filesystem: app-private
  os8_capabilities: ${JSON.stringify(caps)}
legal:
  license: AGPL-3.0-only
  commercial_use: restricted
review:
  channel: verified
`.trim();
    return {
      id: 'app-1',
      name: 'World Monitor',
      slug: 'worldmonitor',
      channel: 'verified',
      manifest_yaml: yaml,
      upstream_resolved_commit: 'e51058e1765ef2f0c83ccb1d08d984bc59d23f10',
    };
  }

  it('writes CLAUDE.md, os8-sdk.d.ts, and .os8/manifest.yaml', () => {
    generateForExternal(null, appWithCaps(['blob.readwrite']));
    const appDir = path.join(tmpHome, 'apps', 'app-1');
    expect(fs.existsSync(path.join(appDir, 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(appDir, 'os8-sdk.d.ts'))).toBe(true);
    expect(fs.existsSync(path.join(appDir, '.os8', 'manifest.yaml'))).toBe(true);
  });

  it('CLAUDE.md mentions every declared capability', () => {
    generateForExternal(null, appWithCaps([
      'blob.readwrite', 'db.readonly', 'imagegen', 'mcp.tavily.*',
    ]));
    const md = fs.readFileSync(
      path.join(tmpHome, 'apps', 'app-1', 'CLAUDE.md'), 'utf8'
    );
    expect(md).toContain('`blob.readwrite`');
    expect(md).toContain('`db.readonly`');
    expect(md).toContain('`imagegen`');
    expect(md).toContain('`mcp.tavily.*`');
    expect(md).toContain('window.os8');
    expect(md).toContain('e51058e1765ef2f0c83ccb1d08d984bc59d23f10');
  });

  it('no-cap manifest yields a clear "no capabilities declared" note', () => {
    generateForExternal(null, appWithCaps([]));
    const md = fs.readFileSync(
      path.join(tmpHome, 'apps', 'app-1', 'CLAUDE.md'), 'utf8'
    );
    expect(md).toMatch(/No capabilities declared|None — the app cannot/);
  });

  it('snapshots the manifest_yaml as-is into .os8/', () => {
    const app = appWithCaps(['blob.readonly']);
    generateForExternal(null, app);
    const stored = fs.readFileSync(
      path.join(tmpHome, 'apps', 'app-1', '.os8', 'manifest.yaml'), 'utf8'
    );
    expect(stored).toBe(app.manifest_yaml);
  });

  it('survives missing app.id (no throw, just warn)', () => {
    expect(() => generateForExternal(null, {})).not.toThrow();
  });

  it('survives missing appDir (no throw, just warn)', () => {
    expect(() => generateForExternal(null, { ...appWithCaps([]), id: 'unknown' }))
      .not.toThrow();
  });
});
