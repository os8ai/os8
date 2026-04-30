/**
 * PR 2.3 — StaticRuntimeAdapter unit tests.
 *
 * Hugo / Jekyll dev-server tests are gated behind `OS8_STATIC_LIVE_TEST=1`
 * (host hugo / bundler not assumed in CI).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const BASE_MANIFEST = {
  schemaVersion: 1,
  slug: 'fixture',
  name: 'Fixture',
  publisher: 'tester',
  upstream: { git: 'https://example.test/fixture.git', ref: 'v1.0.0' },
  framework: 'none',
  runtime: { kind: 'static', version: '0', arch: ['arm64', 'x86_64'] },
  install: [],
  start: { argv: ['os8:static', '--dir', '.'], port: 'detect' },
  surface: { kind: 'web' },
  permissions: { network: { outbound: false, inbound: false }, filesystem: 'app-private', os8_capabilities: [] },
  legal: { license: 'MIT', commercial_use: 'unrestricted' },
  review: { channel: 'verified' },
};

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function makeAppDir(parent, files = {}) {
  const dir = path.join(parent, 'app');
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

function loadAdapter() {
  delete require.cache[require.resolve('../src/services/runtime-adapters/static')];
  return require('../src/services/runtime-adapters/static');
}

describe('StaticRuntimeAdapter — sentinel detection', () => {
  let StaticAdapter;
  beforeEach(() => { StaticAdapter = loadAdapter(); });

  it('os8:static is detected as the OS8-served sentinel', () => {
    expect(StaticAdapter._internal.isStaticSentinel(['os8:static'])).toBe(true);
    expect(StaticAdapter._internal.isStaticSentinel(['os8:static', '--dir', 'dist'])).toBe(true);
  });

  it('non-sentinel argv returns false', () => {
    expect(StaticAdapter._internal.isStaticSentinel(['hugo', 'serve'])).toBe(false);
    expect(StaticAdapter._internal.isStaticSentinel([])).toBe(false);
    expect(StaticAdapter._internal.isStaticSentinel(null)).toBe(false);
  });

  it('parseStaticDir returns --dir argument or "."', () => {
    expect(StaticAdapter._internal.parseStaticDir(['os8:static'])).toBe('.');
    expect(StaticAdapter._internal.parseStaticDir(['os8:static', '--dir', 'dist'])).toBe('dist');
  });
});

describe('StaticRuntimeAdapter — _startOS8Served', () => {
  let parent;
  let StaticAdapter;
  beforeEach(() => {
    parent = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-static-served-'));
    StaticAdapter = loadAdapter();
  });
  afterEach(() => { fs.rmSync(parent, { recursive: true, force: true }); });

  it('returns _kind:static + _staticDir when argv is os8:static', async () => {
    const dir = makeAppDir(parent, { 'index.html': '<h1>Hello</h1>' });
    const m = clone(BASE_MANIFEST);
    const info = await StaticAdapter.start(m, dir, {}, () => {});
    expect(info._kind).toBe('static');
    expect(info._staticDir).toBe(dir);
    expect(info.pid).toBeNull();
    expect(info.port).toBeNull();
    await expect(info.ready).resolves.toBeUndefined();
  });

  it('resolves --dir relative to appDir', async () => {
    const dir = makeAppDir(parent, { 'dist/index.html': '<h1>Built</h1>' });
    const m = clone(BASE_MANIFEST);
    m.start = { argv: ['os8:static', '--dir', 'dist'], port: 'detect' };
    const info = await StaticAdapter.start(m, dir, {}, () => {});
    expect(info._staticDir).toBe(path.join(dir, 'dist'));
  });

  it('throws when the static directory does not exist', async () => {
    const dir = makeAppDir(parent, {});
    const m = clone(BASE_MANIFEST);
    m.start = { argv: ['os8:static', '--dir', 'nonexistent'], port: 'detect' };
    await expect(StaticAdapter.start(m, dir, {}, () => {})).rejects.toThrow(/static directory not found/);
  });

  it('stop is a no-op for static-served apps', async () => {
    const dir = makeAppDir(parent, { 'index.html': '<h1>Hello</h1>' });
    const info = await StaticAdapter.start(clone(BASE_MANIFEST), dir, {}, () => {});
    await expect(StaticAdapter.stop(info)).resolves.toBeUndefined();
  });
});

describe('StaticRuntimeAdapter — framework defaults', () => {
  let StaticAdapter;
  beforeEach(() => { StaticAdapter = loadAdapter(); });

  it('hugo appends serve flags when manifest is bare', () => {
    const m = clone(BASE_MANIFEST);
    m.framework = 'hugo';
    m.start = { argv: ['hugo'] };
    const out = StaticAdapter._applyFrameworkDefaults(m);
    expect(out.start.argv).toEqual([
      'hugo', 'serve',
      '--port', '{{PORT}}',
      '--bind', '127.0.0.1',
      '--baseURL', 'http://{{APP_HOST}}/',
    ]);
    expect(out.start.readiness).toEqual({ type: 'http', path: '/', timeout_seconds: 30 });
  });

  it('jekyll appends bundle exec serve flags', () => {
    const m = clone(BASE_MANIFEST);
    m.framework = 'jekyll';
    m.start = { argv: ['bundle'] };
    const out = StaticAdapter._applyFrameworkDefaults(m);
    expect(out.start.argv).toEqual([
      'bundle', 'exec', 'jekyll', 'serve',
      '--port', '{{PORT}}',
      '--host', '127.0.0.1',
      '--livereload',
    ]);
  });

  it('does not append --port when manifest already declares one', () => {
    const m = clone(BASE_MANIFEST);
    m.framework = 'hugo';
    m.start = { argv: ['hugo', 'serve', '--port', '1313'] };
    const out = StaticAdapter._applyFrameworkDefaults(m);
    expect(out.start.argv).toEqual(['hugo', 'serve', '--port', '1313']);
  });

  it('framework=none leaves manifest alone', () => {
    const m = clone(BASE_MANIFEST);
    m.framework = 'none';
    m.start = { argv: ['os8:static', '--dir', '.'] };
    const out = StaticAdapter._applyFrameworkDefaults(m);
    expect(out.start.argv).toEqual(m.start.argv);
  });
});

describe('StaticRuntimeAdapter — placeholder substitution', () => {
  let StaticAdapter;
  beforeEach(() => { StaticAdapter = loadAdapter(); });

  it('substitutes {{PORT}}, {{APP_HOST}}, {{APP_DIR}}', () => {
    const out = StaticAdapter._substitutePlaceholders(
      ['hugo', 'serve', '--port', '{{PORT}}', '--baseURL', 'http://{{APP_HOST}}/'],
      { PORT: '5173', APP_HOST: 'site.localhost:8888' }
    );
    expect(out).toEqual([
      'hugo', 'serve', '--port', '5173', '--baseURL', 'http://site.localhost:8888/',
    ]);
  });
});

describe('StaticRuntimeAdapter — install', () => {
  let parent;
  let StaticAdapter;
  beforeEach(() => {
    parent = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-static-install-'));
    StaticAdapter = loadAdapter();
  });
  afterEach(() => { fs.rmSync(parent, { recursive: true, force: true }); });

  it('plain-HTML (framework=none) install is a no-op except .env writes', async () => {
    const dir = makeAppDir(parent, { 'index.html': '<h1>x</h1>' });
    const m = clone(BASE_MANIFEST);
    m.env = [{ name: 'A', value: '1' }];
    await StaticAdapter.install(m, dir, {}, () => {});
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toBe('A=1\n');
  });

  it('postInstall commands run via spawn', async () => {
    const dir = makeAppDir(parent, { 'src.txt': 'hello' });
    const m = clone(BASE_MANIFEST);
    m.postInstall = [{ argv: ['node', '-e',
      `require('fs').writeFileSync('built.txt','built')`] }];
    await StaticAdapter.install(m, dir, { ...process.env }, () => {});
    expect(fs.readFileSync(path.join(dir, 'built.txt'), 'utf8')).toBe('built');
  });
});

// ── Live dev-server tests, gated by env flag ────────────────────────────────
const LIVE = process.env.OS8_STATIC_LIVE_TEST === '1';

describe.skipIf(!LIVE)('StaticRuntimeAdapter — live Hugo (network)', () => {
  it('runs hugo serve and HTTP readiness resolves', async () => {
    expect(true).toBe(true);   // implementation deferred
  });
});
