import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'node:child_process';

const BASE_MANIFEST = {
  schemaVersion: 1,
  slug: 'fixture',
  name: 'Fixture',
  publisher: 'tester',
  upstream: { git: 'https://example.test/fixture.git', ref: 'v1.0.0' },
  framework: 'vite',
  runtime: { kind: 'node', arch: ['arm64', 'x86_64'], package_manager: 'auto', dependency_strategy: 'frozen' },
  install: [],
  start: { argv: ['node', '-e', 'console.log("noop")'], port: 'detect' },
  surface: { kind: 'web' },
  permissions: { network: { outbound: true, inbound: false }, filesystem: 'app-private', os8_capabilities: [] },
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

describe('NodeRuntimeAdapter — package manager detection', () => {
  let parent;
  let NodeAdapter;
  beforeEach(() => {
    parent = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-node-pm-'));
    delete require.cache[require.resolve('../src/services/runtime-adapters/node')];
    NodeAdapter = require('../src/services/runtime-adapters/node');
  });
  afterEach(() => { fs.rmSync(parent, { recursive: true, force: true }); });

  it('manifest hint wins when not "auto"', () => {
    const dir = makeAppDir(parent, { 'package-lock.json': '{}' });
    expect(NodeAdapter.detectPackageManager(dir, 'pnpm')).toBe('pnpm');
  });

  it('detects npm from package-lock.json', () => {
    const dir = makeAppDir(parent, { 'package-lock.json': '{}' });
    expect(NodeAdapter.detectPackageManager(dir, 'auto')).toBe('npm');
  });

  it('detects pnpm from pnpm-lock.yaml', () => {
    const dir = makeAppDir(parent, { 'pnpm-lock.yaml': 'lockfileVersion: 9' });
    expect(NodeAdapter.detectPackageManager(dir, 'auto')).toBe('pnpm');
  });

  it('detects yarn from yarn.lock', () => {
    const dir = makeAppDir(parent, { 'yarn.lock': '' });
    expect(NodeAdapter.detectPackageManager(dir, 'auto')).toBe('yarn');
  });

  it('detects bun from bun.lockb (or bun.lock)', () => {
    const dir = makeAppDir(parent, { 'bun.lockb': '' });
    expect(NodeAdapter.detectPackageManager(dir, 'auto')).toBe('bun');
  });

  it('precedence: pnpm > yarn > bun > npm', () => {
    const dir = makeAppDir(parent, {
      'pnpm-lock.yaml': '',
      'yarn.lock': '',
      'package-lock.json': '{}',
    });
    expect(NodeAdapter.detectPackageManager(dir, 'auto')).toBe('pnpm');
  });

  it('falls back to npm when no lockfile present', () => {
    const dir = makeAppDir(parent, {});
    expect(NodeAdapter.detectPackageManager(dir, 'auto')).toBe('npm');
  });
});

describe('NodeRuntimeAdapter — channel-tiered --ignore-scripts', () => {
  let parent;
  let NodeAdapter;
  beforeEach(() => {
    parent = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-node-pol-'));
    delete require.cache[require.resolve('../src/services/runtime-adapters/node')];
    NodeAdapter = require('../src/services/runtime-adapters/node');
  });
  afterEach(() => { fs.rmSync(parent, { recursive: true, force: true }); });

  it('verified channel allows scripts (npm ci)', () => {
    const dir = makeAppDir(parent);
    const m = clone(BASE_MANIFEST);
    m.review.channel = 'verified';
    const cmds = NodeAdapter._frozenInstallCmds('npm', dir, m);
    expect(cmds[0].argv).toEqual(['npm', 'ci']);
  });

  it('community channel default blocks scripts', () => {
    const dir = makeAppDir(parent);
    const m = clone(BASE_MANIFEST);
    m.review.channel = 'community';
    const cmds = NodeAdapter._frozenInstallCmds('npm', dir, m);
    expect(cmds[0].argv).toEqual(['npm', 'ci', '--ignore-scripts']);
  });

  it('community channel with allow_package_scripts:true allows', () => {
    const dir = makeAppDir(parent);
    const m = clone(BASE_MANIFEST);
    m.review.channel = 'community';
    m.allow_package_scripts = true;
    const cmds = NodeAdapter._frozenInstallCmds('npm', dir, m);
    expect(cmds[0].argv).toEqual(['npm', 'ci']);
  });

  it('developer-import channel blocks scripts even with manifest opt-in', () => {
    const dir = makeAppDir(parent);
    const m = clone(BASE_MANIFEST);
    m.review.channel = 'developer-import';
    m.allow_package_scripts = true;
    const cmds = NodeAdapter._frozenInstallCmds('npm', dir, m);
    expect(cmds[0].argv).toEqual(['npm', 'ci', '--ignore-scripts']);
  });

  it('pnpm uses --frozen-lockfile + --ignore-scripts when blocked', () => {
    const dir = makeAppDir(parent);
    const m = clone(BASE_MANIFEST);
    m.review.channel = 'community';
    const cmds = NodeAdapter._frozenInstallCmds('pnpm', dir, m);
    expect(cmds[0].argv).toEqual(['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts']);
  });

  it('yarn berry (.yarnrc.yml present) uses --immutable', () => {
    const dir = makeAppDir(parent, { '.yarnrc.yml': 'nodeLinker: pnp' });
    const cmds = NodeAdapter._frozenInstallCmds('yarn', dir, BASE_MANIFEST);
    expect(cmds[0].argv).toEqual(['yarn', 'install', '--immutable']);
  });

  it('yarn1 (no .yarnrc.yml) uses --frozen-lockfile', () => {
    const dir = makeAppDir(parent);
    const cmds = NodeAdapter._frozenInstallCmds('yarn', dir, BASE_MANIFEST);
    expect(cmds[0].argv).toEqual(['yarn', 'install', '--frozen-lockfile']);
  });

  it('bun uses --frozen-lockfile', () => {
    const dir = makeAppDir(parent);
    const cmds = NodeAdapter._frozenInstallCmds('bun', dir, BASE_MANIFEST);
    expect(cmds[0].argv).toEqual(['bun', 'install', '--frozen-lockfile']);
  });

  it('unsupported package manager throws', () => {
    expect(() => NodeAdapter._frozenInstallCmds('weird', '/tmp', BASE_MANIFEST))
      .toThrow(/unsupported package manager/);
  });
});

describe('NodeRuntimeAdapter — placeholder substitution', () => {
  let NodeAdapter;
  beforeEach(() => {
    delete require.cache[require.resolve('../src/services/runtime-adapters/node')];
    NodeAdapter = require('../src/services/runtime-adapters/node');
  });

  it('substitutes {{PORT}} and {{APP_HOST}}', () => {
    const out = NodeAdapter._substitutePlaceholders(
      ['npm', 'run', 'dev', '--', '--port', '{{PORT}}', '--host', '{{APP_HOST}}'],
      { PORT: '5173', APP_HOST: 'worldmonitor.localhost' }
    );
    expect(out).toEqual(['npm', 'run', 'dev', '--', '--port', '5173', '--host', 'worldmonitor.localhost']);
  });

  it('leaves unrecognized placeholders intact', () => {
    const out = NodeAdapter._substitutePlaceholders(['echo', '{{UNKNOWN}}'], { PORT: '5173' });
    expect(out).toEqual(['echo', '{{UNKNOWN}}']);
  });
});

describe('NodeRuntimeAdapter — framework defaults', () => {
  let NodeAdapter;
  beforeEach(() => {
    delete require.cache[require.resolve('../src/services/runtime-adapters/node')];
    NodeAdapter = require('../src/services/runtime-adapters/node');
  });

  it('vite framework appends --port/--host when manifest is bare', () => {
    const m = clone(BASE_MANIFEST);
    m.start = { argv: ['npm', 'run', 'dev'] };
    const out = NodeAdapter._applyFrameworkDefaults(m);
    expect(out.start.argv).toEqual(['npm', 'run', 'dev', '--', '--port', '{{PORT}}', '--host', '127.0.0.1']);
    expect(out.start.readiness).toEqual({ type: 'http', path: '/', timeout_seconds: 30 });
  });

  it('does not append when manifest already specifies --port', () => {
    const m = clone(BASE_MANIFEST);
    m.start = { argv: ['npm', 'run', 'dev', '--', '--port', '5174', '--host', '127.0.0.1'] };
    const out = NodeAdapter._applyFrameworkDefaults(m);
    expect(out.start.argv).toEqual(m.start.argv);
  });

  it('framework=none leaves manifest alone', () => {
    const m = clone(BASE_MANIFEST);
    m.framework = 'none';
    m.start = { argv: ['my-server', '--port', '{{PORT}}'] };
    const out = NodeAdapter._applyFrameworkDefaults(m);
    expect(out.start.argv).toEqual(m.start.argv);
  });
});

describe('NodeRuntimeAdapter — _writeEnvFile', () => {
  let parent;
  let NodeAdapter;
  beforeEach(() => {
    parent = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-env-'));
    delete require.cache[require.resolve('../src/services/runtime-adapters/node')];
    NodeAdapter = require('../src/services/runtime-adapters/node');
  });
  afterEach(() => { fs.rmSync(parent, { recursive: true, force: true }); });

  it('writes .env with key=value lines', () => {
    const dir = makeAppDir(parent);
    NodeAdapter._writeEnvFile(dir, [
      { name: 'A', value: '1' },
      { name: 'B', value: 'two' },
    ]);
    const text = fs.readFileSync(path.join(dir, '.env'), 'utf8');
    expect(text).toBe('A=1\nB=two\n');
  });

  it('escapes newlines in values', () => {
    const dir = makeAppDir(parent);
    NodeAdapter._writeEnvFile(dir, [{ name: 'KEY', value: 'a\nb' }]);
    const text = fs.readFileSync(path.join(dir, '.env'), 'utf8');
    expect(text).toBe('KEY=a\\nb\n');
  });

  it('skips when env array is empty', () => {
    const dir = makeAppDir(parent);
    NodeAdapter._writeEnvFile(dir, []);
    expect(fs.existsSync(path.join(dir, '.env'))).toBe(false);
  });
});

describe('NodeRuntimeAdapter — start/stop integration', () => {
  let parent;
  let NodeAdapter;
  beforeEach(() => {
    parent = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-node-start-'));
    delete require.cache[require.resolve('../src/services/runtime-adapters/node')];
    NodeAdapter = require('../src/services/runtime-adapters/node');
  });
  afterEach(() => { fs.rmSync(parent, { recursive: true, force: true }); });

  it('start launches a tiny HTTP server, ready resolves, stop kills it', async () => {
    const dir = makeAppDir(parent, {
      'server.js': `
        const http = require('http');
        const port = parseInt(process.env.PORT, 10);
        http.createServer((_, res) => { res.writeHead(200); res.end('ok'); })
            .listen(port, '127.0.0.1');
      `,
    });
    const m = clone(BASE_MANIFEST);
    m.framework = 'none';
    m.start = {
      argv: ['node', 'server.js'],
      port: 'detect',
      readiness: { type: 'http', path: '/', timeout_seconds: 5 },
    };

    const port = 39999;
    const env = {
      ...process.env,
      PORT: String(port),
      OS8_APP_ID: 'a1',
      OS8_APP_DIR: dir,
      OS8_BLOB_DIR: dir,
      OS8_BASE_URL: 'http://localhost:8888',
      OS8_API_BASE: 'http://fixture.localhost:8888/_os8/api',
    };

    const info = await NodeAdapter.start(m, dir, env, () => {});
    try {
      await info.ready;
      const r = await fetch(`http://127.0.0.1:${port}/`);
      expect(r.status).toBe(200);
    } finally {
      await NodeAdapter.stop(info);
    }
  }, 15_000);

  it('start rejects ready when the process exits before readiness', async () => {
    const dir = makeAppDir(parent, {
      'crash.js': `process.exit(1);`,
    });
    const m = clone(BASE_MANIFEST);
    m.framework = 'none';
    m.start = {
      argv: ['node', 'crash.js'],
      port: 'detect',
      readiness: { type: 'http', path: '/', timeout_seconds: 3 },
    };

    const env = { ...process.env, PORT: '40001' };
    const info = await NodeAdapter.start(m, dir, env, () => {});
    await expect(info.ready).rejects.toThrow(/exited before ready/);
    await NodeAdapter.stop(info);
  }, 15_000);

  // Tier 1A regression: stderr tail must be visible in the error so
  // callers can debug without reproducing manually.
  it('exited-before-ready error includes the tail of stderr/stdout', async () => {
    const dir = makeAppDir(parent, {
      'crash.js': `
        console.error('NODE_SENTINEL_ERR_42 — custom Node-side traceback');
        process.exit(9);
      `,
    });
    const m = clone(BASE_MANIFEST);
    m.framework = 'none';
    m.start = {
      argv: ['node', 'crash.js'],
      port: 'detect',
      readiness: { type: 'http', path: '/', timeout_seconds: 3 },
    };
    const env = { ...process.env, PORT: '40009' };
    const info = await NodeAdapter.start(m, dir, env, () => {});
    await expect(info.ready).rejects.toThrow(/code=9[\s\S]*NODE_SENTINEL_ERR_42[\s\S]*Node-side traceback/);
    await NodeAdapter.stop(info);
  }, 15_000);

  it('log-regex readiness resolves when the regex appears in stdout', async () => {
    const dir = makeAppDir(parent, {
      'log.js': `
        setTimeout(() => console.log('server ready in 42 ms'), 100);
        // keep the process alive
        setInterval(() => {}, 60_000);
      `,
    });
    const m = clone(BASE_MANIFEST);
    m.framework = 'none';
    m.start = {
      argv: ['node', 'log.js'],
      port: 'detect',
      readiness: { type: 'log-regex', regex: 'ready in [0-9]+ ms', timeout_seconds: 5 },
    };

    const env = { ...process.env, PORT: '40002' };
    const info = await NodeAdapter.start(m, dir, env, () => {});
    try {
      await info.ready;
    } finally {
      await NodeAdapter.stop(info);
    }
  }, 15_000);
});
