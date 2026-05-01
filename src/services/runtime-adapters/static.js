/**
 * StaticRuntimeAdapter — installs and runs static-site external apps.
 *
 * Spec §6.2.2 + plan §3 PR 2.3.
 *
 * Two sub-paths:
 *   1. Has a dev server (Hugo: `hugo serve`, Jekyll:
 *      `bundle exec jekyll serve --livereload`). Same shape as Node:
 *      adapter spawns; framework defaults inject --port/--host;
 *      readiness probes; tree-kill on stop.
 *   2. No dev server (plain HTML, pre-built `dist/`, Markdown). The
 *      adapter returns `{ _kind: 'static', _staticDir }`; OS8's
 *      `ReverseProxyService.registerStatic` mounts an `express.static`
 *      handler bound to the app's subdomain.
 *
 * Trust-boundary parity: every external app gets its own subdomain
 * (its own browser origin), including static apps. The "bypass" is
 * that OS8 serves the files itself rather than proxying to an external
 * dev server. Plan §5 decision 8 (Option A).
 *
 * `os8:static` is a sentinel argv[0] that triggers the OS8-served
 * path. Plan §5 decision 9.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('node:child_process');

const FRAMEWORK_DEFAULTS = {
  hugo: {
    appendStartFlags: [
      'serve',
      '--port', '{{PORT}}',
      '--bind', '127.0.0.1',
      '--baseURL', 'http://{{APP_HOST}}/',
    ],
    portFlagPattern: /(?:^|\s|=)--port\b/,
    readiness: { type: 'http', path: '/', timeout_seconds: 30 },
  },
  jekyll: {
    appendStartFlags: [
      'exec', 'jekyll', 'serve',
      '--port', '{{PORT}}',
      '--host', '127.0.0.1',
      '--livereload',
    ],
    portFlagPattern: /(?:^|\s|=)--port\b/,
    readiness: { type: 'http', path: '/', timeout_seconds: 30 },
  },
  none: { appendStartFlags: [], portFlagPattern: null, readiness: null },
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function spawnPromise(argv, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', d => {
      stdout += d.toString();
      opts.onLog?.('stdout', d.toString());
    });
    child.stderr?.on('data', d => {
      stderr += d.toString();
      opts.onLog?.('stderr', d.toString());
    });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${argv.join(' ')} exited ${code}: ${stderr.trim().slice(-500)}`));
    });
  });
}

function isStaticSentinel(argv) {
  return Array.isArray(argv) && argv.length > 0 && argv[0] === 'os8:static';
}

function parseStaticDir(argv) {
  // `["os8:static", "--dir", "<rel>"]` or just `["os8:static"]` (= ".").
  const i = argv.indexOf('--dir');
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  return '.';
}

const StaticRuntimeAdapter = {
  kind: 'static',

  // ── Availability ────────────────────────────────────────────────────────────
  async ensureAvailable(spec) {
    if (spec?.framework === 'hugo') {
      try { await spawnPromise(['hugo', 'version'], { timeout: 5000 }); }
      catch { throw new Error('hugo not found on PATH; install hugo to run static-hugo apps'); }
    }
    if (spec?.framework === 'jekyll') {
      try { await spawnPromise(['bundle', '--version'], { timeout: 5000 }); }
      catch { throw new Error('bundler not found on PATH; install ruby+bundler for jekyll apps'); }
    }
    // 'none' framework / OS8-served path: nothing to ensure.
  },

  detectPackageManager(_appDir, _hint) { return 'static'; },

  // ── Install ─────────────────────────────────────────────────────────────────
  async install(spec, appDir, sanitizedEnv, onLog) {
    if (spec?.framework === 'hugo' && fs.existsSync(path.join(appDir, 'go.mod'))) {
      await spawnPromise(['hugo', 'mod', 'download'],
        { cwd: appDir, env: sanitizedEnv, onLog });
    }
    if (spec?.framework === 'jekyll' && fs.existsSync(path.join(appDir, 'Gemfile'))) {
      await spawnPromise(['bundle', 'install', '--path', '.bundle'],
        { cwd: appDir, env: sanitizedEnv, onLog });
    }

    // Honor the manifest's install:/postInstall: arrays the same way Node and
    // Python adapters do. Static apps with build steps (e.g. CyberChef's
    // `npm ci && npm run build` → build/prod) need this; without it, the
    // adapter only runs framework-specific dep commands and the build output
    // never gets produced, so OS8-served `os8:static --dir build/prod`
    // fails at start with "static directory not found".
    const runList = [
      ...(Array.isArray(spec?.install) ? spec.install : []),
      ...(Array.isArray(spec?.postInstall) ? spec.postInstall : []),
    ];
    for (const cmd of runList) {
      if (!Array.isArray(cmd?.argv)) {
        throw new Error('install/postInstall commands must be argv arrays');
      }
      onLog?.('stdout', `+ ${cmd.argv.join(' ')}\n`);
      await spawnPromise(cmd.argv, { cwd: appDir, env: sanitizedEnv, onLog });
    }
    this._writeEnvFile(appDir, spec?.env || []);
  },

  _writeEnvFile(appDir, envEntries) {
    if (!envEntries || envEntries.length === 0) return;
    const lines = envEntries.map(e => `${e.name}=${String(e.value).replace(/\n/g, '\\n')}`);
    fs.writeFileSync(path.join(appDir, '.env'), lines.join('\n') + '\n', 'utf8');
  },

  // ── Start ───────────────────────────────────────────────────────────────────
  async start(spec, appDir, sanitizedEnv, onLog) {
    if (this._isOS8Served(spec)) {
      return this._startOS8Served(spec, appDir);
    }
    return this._startDevServer(spec, appDir, sanitizedEnv, onLog);
  },

  _isOS8Served(spec) {
    return isStaticSentinel(spec?.start?.argv);
  },

  async _startOS8Served(spec, appDir) {
    const rel = parseStaticDir(spec?.start?.argv || []);
    const dir = path.resolve(appDir, rel);
    if (!fs.existsSync(dir)) {
      throw new Error(`static directory not found: ${dir}`);
    }
    return {
      pid:  null,
      port: null,
      ready: Promise.resolve(),
      _kind: 'static',
      _staticDir: dir,
    };
  },

  async _startDevServer(spec, appDir, sanitizedEnv, onLog) {
    const effective = this._applyFrameworkDefaults(spec);

    for (const cmd of (Array.isArray(spec?.preStart) ? spec.preStart : [])) {
      if (!Array.isArray(cmd?.argv)) throw new Error('preStart commands must be argv arrays');
      onLog?.('stdout', `+ ${cmd.argv.join(' ')}\n`);
      await spawnPromise(cmd.argv, { cwd: appDir, env: sanitizedEnv, onLog });
    }

    if (!Array.isArray(effective.start?.argv)) {
      throw new Error('start.argv must be an argv array');
    }

    const localSlug = spec?._localSlug || sanitizedEnv.OS8_APP_ID;
    const os8Port = sanitizedEnv.OS8_BASE_URL?.match(/:(\d+)$/)?.[1] || '8888';
    const startArgv = this._substitutePlaceholders(effective.start.argv, {
      APP_HOST:     localSlug ? `${localSlug}.localhost:${os8Port}` : `localhost:${os8Port}`,
      PORT:         String(sanitizedEnv.PORT),
      APP_DIR:      appDir,
      BLOB_DIR:     sanitizedEnv.OS8_BLOB_DIR,
      OS8_BASE_URL: sanitizedEnv.OS8_BASE_URL,
      OS8_API_BASE: sanitizedEnv.OS8_API_BASE,
      OS8_PORT:     os8Port,
    });

    const child = spawn(startArgv[0], startArgv.slice(1), {
      cwd: appDir,
      env: sanitizedEnv,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    let collected = '';
    child.stdout.on('data', d => {
      const s = d.toString();
      collected += s;
      onLog?.('stdout', s);
    });
    child.stderr.on('data', d => {
      const s = d.toString();
      collected += s;
      onLog?.('stderr', s);
    });
    child.on('exit', code => onLog?.('exit', `process exited code=${code}`));

    const ready = this._waitReady(effective, child, () => collected, sanitizedEnv);

    return {
      pid: child.pid,
      port: parseInt(sanitizedEnv.PORT, 10),
      ready,
      _child: child,
    };
  },

  _applyFrameworkDefaults(spec) {
    const framework = spec?.framework;
    const defaults = framework ? FRAMEWORK_DEFAULTS[framework] : null;
    if (!defaults) return spec;

    const start = { ...(spec.start || {}) };
    if (Array.isArray(start.argv) && defaults.appendStartFlags.length > 0) {
      const flat = start.argv.join(' ');
      const portRe = defaults.portFlagPattern;
      const alreadyHasPort = portRe ? portRe.test(flat) : /--port\b/.test(flat);
      if (!alreadyHasPort) {
        start.argv = [...start.argv, ...defaults.appendStartFlags];
      }
    }
    if (!start.readiness && defaults.readiness) {
      start.readiness = defaults.readiness;
    }
    return { ...spec, start };
  },

  async _waitReady(spec, child, getCollected, env) {
    const probe = spec?.start?.readiness || { type: 'http', path: '/', timeout_seconds: 30 };
    const timeoutMs = (probe.timeout_seconds ?? 30) * 1000;
    const deadline = Date.now() + timeoutMs;

    if (probe.type === 'http') {
      const url = `http://127.0.0.1:${env.PORT}${probe.path || '/'}`;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) {
          throw new Error(`process exited before ready code=${child.exitCode}`);
        }
        try {
          const r = await fetch(url, { signal: AbortSignal.timeout(1000) });
          if (r.status >= 200 && r.status < 500) return;
        } catch (_) { /* retry */ }
        await sleep(250);
      }
      throw new Error(`readiness http timeout: ${url}`);
    }

    if (probe.type === 'log-regex') {
      const re = new RegExp(probe.regex);
      while (Date.now() < deadline) {
        if (child.exitCode !== null) {
          throw new Error('process exited before ready');
        }
        if (re.test(getCollected())) return;
        await sleep(100);
      }
      throw new Error(`readiness log-regex timeout: /${probe.regex}/`);
    }
    throw new Error(`unknown readiness type: ${probe.type}`);
  },

  // ── Stop ────────────────────────────────────────────────────────────────────
  async stop(processInfo) {
    if (processInfo?._kind === 'static') return;       // OS8-served — no process
    const pid = processInfo?._child?.pid || processInfo?.pid;
    if (!pid) return;
    const treeKill = require('tree-kill');
    return new Promise((resolve) => {
      let killed = false;
      const finalize = () => { if (!killed) { killed = true; resolve(); } };
      treeKill(pid, 'SIGTERM', (err) => {
        if (err) treeKill(pid, 'SIGKILL', () => finalize());
      });
      setTimeout(() => treeKill(pid, 'SIGKILL', () => finalize()), 5000).unref?.();
      setTimeout(finalize, 5500).unref?.();
    });
  },

  // ── Watch ───────────────────────────────────────────────────────────────────
  watchFiles(spec, appDir, onChange) {
    // Hugo + Jekyll do their own watching. For OS8-served plain-HTML apps,
    // hot-reload would require an injected client; v1 keeps it simple and
    // returns a no-op disposer. PR 2.3 documents this in the manifest README.
    if (spec?.framework === 'hugo' || spec?.framework === 'jekyll') return () => {};
    if (this._isOS8Served(spec)) return () => {};

    const chokidar = require('chokidar');
    const watcher = chokidar.watch(appDir, {
      ignored: (file) =>
        /(^|[\\/])\.git([\\/]|$)/.test(file) ||
        /(^|[\\/])\.bundle([\\/]|$)/.test(file) ||
        /(^|[\\/])node_modules([\\/]|$)/.test(file),
      ignoreInitial: true,
      persistent: true,
    });
    watcher.on('all', (event, file) => onChange({ event, file }));
    return () => { watcher.close(); };
  },

  async detectVersion(_spec, appDir) {
    const { stdout } = await spawnPromise(
      ['git', '-C', appDir, 'rev-parse', 'HEAD'],
      { timeout: 5000 }
    );
    return stdout.trim();
  },

  // Test helpers.
  _substitutePlaceholders(argv, vars) {
    return argv.map(a => String(a).replace(/\{\{([A-Z_]+)\}\}/g, (m, name) => vars[name] ?? m));
  },
  _internal: { spawnPromise, FRAMEWORK_DEFAULTS, isStaticSentinel, parseStaticDir },
};

module.exports = StaticRuntimeAdapter;
