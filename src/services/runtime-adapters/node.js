/**
 * NodeRuntimeAdapter — installs and runs Node.js external apps.
 *
 * Spec §6.2.2 + plan §3 PR 1.11.
 *
 * Implementation invariants:
 *   - All commands spawn with `shell: false` and argv arrays. No string
 *     interpolation into a shell.
 *   - Frozen install. npm ci / pnpm install --frozen-lockfile / etc.
 *   - Channel-tiered --ignore-scripts policy (plan §10 decision 8):
 *       verified         → allow                  (curator reviewed)
 *       community        → opt-in via manifest    (default block)
 *       developer-import → always block
 *   - Lockfile precedence: pnpm > yarn > bun > npm (plan §10 decision 10).
 *   - Yarn berry vs yarn1 detected via .yarnrc.yml (plan §10 decision 7).
 *   - Cross-platform tree-kill (`tree-kill@1.2.2` shells to taskkill on Windows,
 *     uses pgid signals on POSIX).
 *   - Subdomain mode: framework binds at /, no --base flag.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('node:child_process');

const hostNodeMajor = parseInt(process.versions.node.split('.')[0], 10);

// Lockfile precedence (plan §10 decision 10).
const LOCK_PRECEDENCE = [
  ['pnpm-lock.yaml',    'pnpm'],
  ['yarn.lock',         'yarn'],
  ['bun.lockb',         'bun'],
  ['bun.lock',          'bun'],
  ['package-lock.json', 'npm'],
];

// Framework defaults — applied only when manifest fields are empty.
// Manifest values always win.
const FRAMEWORK_DEFAULTS = {
  vite: {
    appendStartFlags: ['--', '--port', '{{PORT}}', '--host', '127.0.0.1'],
    readiness: { type: 'http', path: '/', timeout_seconds: 30 },
  },
  nextjs: {
    appendStartFlags: ['--port', '{{PORT}}', '--hostname', '127.0.0.1'],
    readiness: { type: 'http', path: '/', timeout_seconds: 60 },
  },
  sveltekit: {
    appendStartFlags: ['--', '--port', '{{PORT}}', '--host', '127.0.0.1'],
    readiness: { type: 'http', path: '/', timeout_seconds: 30 },
  },
  astro: {
    appendStartFlags: ['--', '--port', '{{PORT}}', '--host', '127.0.0.1'],
    readiness: { type: 'http', path: '/', timeout_seconds: 30 },
  },
  none: { appendStartFlags: [], readiness: null },
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Append a tail of the process output to a readiness error so callers see
// the actual root cause and the failure-modal hint matcher (Tier 3A) has
// something to scan. Used for both the "exited before ready" path and the
// readiness-timeout path (a process that bound but hung without responding).
function tailSuffix(collected) {
  const tail = (collected || '').slice(-1500).trim();
  return tail ? `\n--- last process output ---\n${tail}` : '';
}

function exitedBeforeReady(code, collected) {
  return new Error(`process exited before ready code=${code}${tailSuffix(collected)}`);
}

function readinessTimeout(detail, collected) {
  return new Error(`readiness ${detail}${tailSuffix(collected)}`);
}

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

const NodeRuntimeAdapter = {
  kind: 'node',

  // ── Availability ───────────────────────────────────────────────────────────
  async ensureAvailable(spec) {
    const declared = parseInt(spec?.runtime?.version, 10);
    if (!Number.isNaN(declared) && hostNodeMajor < declared) {
      throw new Error(`host node ${process.versions.node} < declared major ${declared}`);
    }
    try { await spawnPromise(['git', '--version'], { timeout: 5000 }); }
    catch { throw new Error('git not found on PATH'); }
  },

  // ── Package manager detection ──────────────────────────────────────────────
  detectPackageManager(appDir, manifestHint = 'auto') {
    if (manifestHint && manifestHint !== 'auto') return manifestHint;
    for (const [file, pm] of LOCK_PRECEDENCE) {
      if (fs.existsSync(path.join(appDir, file))) return pm;
    }
    return 'npm';
  },

  // ── Install ────────────────────────────────────────────────────────────────
  async install(spec, appDir, sanitizedEnv, onLog) {
    const pm = this.detectPackageManager(appDir, spec?.runtime?.package_manager);
    const installCmds = this._frozenInstallCmds(pm, appDir, spec);
    this._writeEnvFile(appDir, spec?.env || []);

    const runList = [
      ...installCmds,
      ...(Array.isArray(spec?.install) ? spec.install : []),
      ...(Array.isArray(spec?.postInstall) ? spec.postInstall : []),
    ];

    for (const cmd of runList) {
      if (!Array.isArray(cmd?.argv)) {
        throw new Error('install commands must be argv arrays');
      }
      onLog?.('stdout', `+ ${cmd.argv.join(' ')}\n`);
      await spawnPromise(cmd.argv, { cwd: appDir, env: sanitizedEnv, onLog });
    }
  },

  _frozenInstallCmds(pm, appDir, spec) {
    const channel = spec?.review?.channel || 'verified';
    const allowScripts =
      channel === 'verified' ||
      (channel === 'community' && spec.allow_package_scripts === true);
    // developer-import: scripts are unconditionally blocked.

    const ignoreFlag = allowScripts ? [] : ['--ignore-scripts'];

    switch (pm) {
      case 'npm':
        return [{ argv: ['npm', 'ci', ...ignoreFlag] }];
      case 'pnpm':
        return [{ argv: ['pnpm', 'install', '--frozen-lockfile', ...ignoreFlag] }];
      case 'yarn': {
        // Yarn berry (>=2) ships .yarnrc.yml — plan §10 decision 7.
        const isBerry = fs.existsSync(path.join(appDir, '.yarnrc.yml'));
        return [{
          argv: ['yarn', 'install',
            isBerry ? '--immutable' : '--frozen-lockfile',
            ...ignoreFlag],
        }];
      }
      case 'bun':
        return [{ argv: ['bun', 'install', '--frozen-lockfile', ...ignoreFlag] }];
      default:
        throw new Error(`unsupported package manager: ${pm}`);
    }
  },

  _writeEnvFile(appDir, envEntries) {
    if (!envEntries || envEntries.length === 0) return;
    const lines = envEntries.map(e => `${e.name}=${String(e.value).replace(/\n/g, '\\n')}`);
    fs.writeFileSync(path.join(appDir, '.env'), lines.join('\n') + '\n', 'utf8');
  },

  // ── Start ──────────────────────────────────────────────────────────────────
  async start(spec, appDir, sanitizedEnv, onLog) {
    // Apply framework defaults to a copy of the spec so manifest-supplied
    // fields take precedence.
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
    const startArgv = this._substitutePlaceholders(effective.start.argv, {
      APP_HOST:     localSlug ? `${localSlug}.localhost` : 'localhost',
      PORT:         String(sanitizedEnv.PORT),
      APP_DIR:      appDir,
      BLOB_DIR:     sanitizedEnv.OS8_BLOB_DIR,
      OS8_BASE_URL: sanitizedEnv.OS8_BASE_URL,
      OS8_API_BASE: sanitizedEnv.OS8_API_BASE,
    });

    // Surface the start command in the OS8 main-process terminal for parity
    // with install-time logging. When a start fails, this is the line that
    // tells you what was actually spawned.
    console.log(
      `[node-adapter] start: ${startArgv.join(' ')} (cwd=${appDir}, port=${sanitizedEnv.PORT})`
    );

    const child = spawn(startArgv[0], startArgv.slice(1), {
      cwd: appDir,
      env: sanitizedEnv,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      // POSIX: own pgid so tree-kill walks the whole tree on stop.
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
      _child: child,    // private — used by stop()
    };
  },

  _applyFrameworkDefaults(spec) {
    const framework = spec?.framework;
    const defaults = framework ? FRAMEWORK_DEFAULTS[framework] : null;
    if (!defaults) return spec;

    const start = { ...(spec.start || {}) };
    if (Array.isArray(start.argv) && defaults.appendStartFlags.length > 0) {
      // Only append if the manifest's argv doesn't already mention --port.
      const flat = start.argv.join(' ');
      if (!/--port\b/.test(flat)) {
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
          throw exitedBeforeReady(child.exitCode, getCollected());
        }
        try {
          const r = await fetch(url, { signal: AbortSignal.timeout(1000) });
          if (r.status >= 200 && r.status < 500) return;
        } catch (_) { /* retry */ }
        await sleep(250);
      }
      throw readinessTimeout(`http timeout: ${url}`, getCollected());
    }

    if (probe.type === 'log-regex') {
      const re = new RegExp(probe.regex);
      while (Date.now() < deadline) {
        if (child.exitCode !== null) {
          throw exitedBeforeReady(child.exitCode, getCollected());
        }
        if (re.test(getCollected())) return;
        await sleep(100);
      }
      throw readinessTimeout(`log-regex timeout: /${probe.regex}/`, getCollected());
    }
    throw new Error(`unknown readiness type: ${probe.type}`);
  },

  // ── Stop ───────────────────────────────────────────────────────────────────
  async stop(processInfo) {
    const pid = processInfo?._child?.pid || processInfo?.pid;
    if (!pid) return;
    const treeKill = require('tree-kill');
    return new Promise((resolve) => {
      // Five-second SIGTERM grace, then SIGKILL the tree.
      let killed = false;
      const finalize = () => { if (!killed) { killed = true; resolve(); } };
      treeKill(pid, 'SIGTERM', (err) => {
        if (err) {
          // Already dead, or pgid-lookup failed — escalate to SIGKILL immediately.
          treeKill(pid, 'SIGKILL', () => finalize());
        }
      });
      setTimeout(() => treeKill(pid, 'SIGKILL', () => finalize()), 5000).unref?.();
      // Give SIGTERM a chance to land cleanly.
      setTimeout(finalize, 5500).unref?.();
    });
  },

  // ── Watch ──────────────────────────────────────────────────────────────────
  watchFiles(spec, appDir, onChange) {
    const chokidar = require('chokidar');
    const declared = Array.isArray(spec?.dev?.watch) && spec.dev.watch.length > 0
      ? spec.dev.watch.map(p => path.join(appDir, p))
      : [path.join(appDir, 'src'), path.join(appDir, 'public')].filter(fs.existsSync);

    if (declared.length === 0) return () => {};

    const watcher = chokidar.watch(declared, {
      ignored: makeIgnoreFilter(appDir),
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

  // Test helpers — exposed so unit tests can exercise internals without
  // a real spawn.
  _substitutePlaceholders(argv, vars) {
    return argv.map(a => String(a).replace(/\{\{([A-Z_]+)\}\}/g, (m, name) => vars[name] ?? m));
  },
  _internal: { spawnPromise, FRAMEWORK_DEFAULTS, LOCK_PRECEDENCE },
};

function makeIgnoreFilter(appDir) {
  // Always ignore node_modules + .env*; chokidar's default `.gitignore`
  // plumbing is best-effort but we hard-block secrets.
  const HARD_IGNORES = [
    /(^|[\\/])node_modules([\\/]|$)/,
    /(^|[\\/])\.env(\..*)?$/,
    /(^|[\\/])\.git([\\/]|$)/,
    /(^|[\\/])dist([\\/]|$)/,
    /(^|[\\/])build([\\/]|$)/,
    /(^|[\\/])\.next([\\/]|$)/,
    /(^|[\\/])\.svelte-kit([\\/]|$)/,
    /(^|[\\/])\.vite([\\/]|$)/,
    /(^|[\\/])\.cache([\\/]|$)/,
  ];
  return (file) => HARD_IGNORES.some(re => re.test(file));
}

module.exports = NodeRuntimeAdapter;
