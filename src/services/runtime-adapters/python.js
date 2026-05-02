/**
 * PythonRuntimeAdapter — installs and runs Python external apps.
 *
 * Spec §6.2.2 + plan §3 PR 2.1.
 *
 * Implementation invariants (mirror NodeRuntimeAdapter):
 *   - All commands spawn with `shell: false` and argv arrays. No string
 *     interpolation into a shell.
 *   - Frozen install per channel:
 *       uv      → `uv sync --frozen` (uv.lock authoritative)
 *       poetry  → `poetry install --no-update --no-root --no-interaction`
 *       pip     → `uv venv` + `uv pip install -r requirements.txt`
 *                 (`--require-hashes` when the file ships hashes)
 *   - Lockfile precedence: uv.lock > poetry.lock > requirements.txt
 *     (pyproject.toml without a lockfile falls through to uv).
 *   - uv is the canonical Python installer. Auto-installed to ~/os8/bin/uv
 *     (with SHA-256 verification) if no host uv exists.
 *   - Cross-platform tree-kill via `tree-kill@1.2.2`.
 *   - Subdomain mode: framework binds at /, no path prefix.
 *   - Pipenv (`Pipfile.lock`) NOT supported in v1 — plan §5 decision 3.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('node:child_process');

const { OS8_BIN_DIR } = require('../../config');

// ── uv pin & checksums ─────────────────────────────────────────────────────────
//
// Pinned at PR 2.1 implementation time. Re-verify at PR-merge time and
// bump in a follow-up PR with fresh checksums. Each platform-arch tuple
// maps to a SHA-256 from the release page's `<asset>.sha256` file.
// uv 0.5.5 was the original pin; 0.5.30 fixes a venv-creation regression
// where `uv venv` could exit 0 without producing `.venv/bin/python` on
// aarch64-linux. Repro: streamlit-30days dev-import on Linux/aarch64
// 2026-05-01. Bumping the pin forces a re-download of the cached binary
// (see ensureUv()'s stale-version detection).
const UV_VERSION = '0.5.30';

const UV_ASSET_NAME = {
  'darwin-arm64': 'uv-aarch64-apple-darwin.tar.gz',
  'darwin-x64':   'uv-x86_64-apple-darwin.tar.gz',
  'linux-arm64':  'uv-aarch64-unknown-linux-gnu.tar.gz',
  'linux-x64':    'uv-x86_64-unknown-linux-gnu.tar.gz',
  'win32-x64':    'uv-x86_64-pc-windows-msvc.zip',
};

const UV_CHECKSUMS = {
  // Verified against https://github.com/astral-sh/uv/releases/download/0.5.30/<asset>.sha256
  'darwin-arm64': '654c3e010c9c53b024fa752d08b949e0f80f10ec4e3a1acea9437a1d127a1053',
  'darwin-x64':   '42c4a5d3611928613342958652ab16943d05980b1ab5057bb47e4283ef7e890d',
  'linux-arm64':  'd1ea4a2299768b2c8263db0abd8ea0de3b8052a34a51f5cf73094051456d4de2',
  'linux-x64':    '9d82816c14c44054f0c679f2bcaecfd910c75f207e08874085cb27b482f17776',
  'win32-x64':    '43d6b97d2e283f6509a9199fd32411d67a64d5b5dca3e6e63e45ec2faec68f73',
};

// Extracted directory name inside each tarball (asset name minus extension).
const UV_TARBALL_INNER = {
  'darwin-arm64': 'uv-aarch64-apple-darwin',
  'darwin-x64':   'uv-x86_64-apple-darwin',
  'linux-arm64':  'uv-aarch64-unknown-linux-gnu',
  'linux-x64':    'uv-x86_64-unknown-linux-gnu',
  'win32-x64':    'uv-x86_64-pc-windows-msvc',
};

// ── Framework defaults table (see PR 2.2) ───────────────────────────────────────
//
// `applyFrameworkDefaults(spec)` is called by start() before placeholder
// substitution. Same shape as Node adapter's FRAMEWORK_DEFAULTS so callers
// can treat both adapters uniformly.
const FRAMEWORK_DEFAULTS = {
  streamlit: {
    // Manifests usually ship just `["streamlit"]` or
    // `["streamlit", "run", "{{APP_DIR}}/app.py"]`. We append the network
    // + headless flags when the manifest hasn't already specified
    // `--server.port`. See plan §5 decision 5 for rationale on
    // enableCORS / enableXsrfProtection.
    appendStartFlags: [
      '--server.port={{PORT}}',
      '--server.address=127.0.0.1',
      '--server.enableCORS=false',
      '--server.enableXsrfProtection=false',
      '--server.headless=true',
      '--server.runOnSave=true',
      '--browser.gatherUsageStats=false',
    ],
    portFlagPattern: /--server\.port[=\s]/,
    readiness: {
      type: 'log-regex',
      regex: 'You can now view your Streamlit app',
      timeout_seconds: 60,
    },
  },
  gradio: {
    // Gradio is launched as a plain Python script; the script is expected
    // to read os.environ['PORT'] and call .launch(server_name='127.0.0.1',
    // server_port=int(os.environ['PORT'])). No flags to append.
    appendStartFlags: [],
    portFlagPattern: null,
    readiness: { type: 'http', path: '/', timeout_seconds: 60 },
  },
  none: { appendStartFlags: [], portFlagPattern: null, readiness: null },
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Format the "process exited before ready" error to include a tail of the
// process output. Without this, callers see an opaque `code=N` and have to
// reproduce the failure manually to learn what happened. The tail is the
// same content that streamed to onLog (the install-plan modal), so this
// adds no new leak surface — it just makes the error self-describing.
function exitedBeforeReady(code, collected) {
  const tail = (collected || '').slice(-1500).trim();
  const suffix = tail ? `\n--- last process output ---\n${tail}` : '';
  return new Error(`process exited before ready code=${code}${suffix}`);
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

const PythonRuntimeAdapter = {
  kind: 'python',

  // ── Availability ────────────────────────────────────────────────────────────
  async ensureAvailable(spec) {
    const declared = (spec?.runtime?.version || '3.12').toString();
    const uv = await ensureUv();
    // `uv python install <X.Y>` is idempotent — no-op if already present.
    // We let uv's own download timeout dominate; spawn timeout 5 min for
    // first-install on cold caches.
    await spawnPromise([uv, 'python', 'install', declared], { timeout: 300_000 });
    try { await spawnPromise(['git', '--version'], { timeout: 5000 }); }
    catch { throw new Error('git not found on PATH'); }
  },

  // ── Package manager detection ───────────────────────────────────────────────
  detectPackageManager(appDir, manifestHint = 'auto') {
    if (manifestHint && manifestHint !== 'auto') return manifestHint;
    const candidates = [
      ['uv.lock',          'uv'],
      ['poetry.lock',      'poetry'],
      ['requirements.txt', 'pip'],
    ];
    for (const [file, pm] of candidates) {
      if (fs.existsSync(path.join(appDir, file))) return pm;
    }
    if (fs.existsSync(path.join(appDir, 'pyproject.toml'))) return 'uv';
    throw new Error(
      'no recognized Python lockfile (uv.lock | poetry.lock | requirements.txt) ' +
      'and no pyproject.toml in app directory'
    );
  },

  // ── Install ─────────────────────────────────────────────────────────────────
  async install(spec, appDir, sanitizedEnv, onLog) {
    const pm = this.detectPackageManager(appDir, spec?.runtime?.package_manager);
    const uv = await ensureUv();  // absolute path or 'uv' (PATH lookup)
    const installCmds = await this._frozenInstallCmds(pm, appDir, spec);
    this._writeEnvFile(appDir, spec?.env || []);

    const runList = [
      ...installCmds,
      ...(Array.isArray(spec?.install) ? spec.install : []),
      ...(Array.isArray(spec?.postInstall) ? spec.postInstall : []),
    ];

    // Diagnostic: surface install activity to the terminal in addition to the
    // modal log stream. Without this, a developer-import that fails mid-install
    // shows only an opaque modal error (e.g. "uv pip install streamlit exited 2:
    // No virtual environment found") with no way to tell which prior command
    // succeeded vs. failed silently.
    console.log(`[python-adapter] install for ${spec.slug || '<no-slug>'} in ${appDir}`);
    console.log(`[python-adapter]   pm=${pm}, frozen-install-cmds=${installCmds.length}, spec.install=${(spec?.install || []).length}, spec.postInstall=${(spec?.postInstall || []).length}`);

    for (const cmd of runList) {
      if (!Array.isArray(cmd?.argv)) {
        throw new Error('install commands must be argv arrays');
      }
      // Rewrite bare `uv` invocations to the OS8-managed uv binary. Manifests
      // (and the dev-import drafter) emit the symbolic name `uv` so they
      // remain portable. At runtime we resolve to the same binary that
      // _frozenInstallCmds used — without this, the venv created by OS8's
      // bundled uv (0.5.5) wouldn't be recognised by the user's system uv
      // (could be 0.11+) and `uv pip install <pkg>` would fail with
      // "No virtual environment found".
      const argv = cmd.argv[0] === 'uv' ? [uv, ...cmd.argv.slice(1)] : cmd.argv;
      // Once the venv exists, prepend its bin directory to PATH for every
      // subsequent install/postInstall spawn. Without this, manifest commands
      // like `python scripts/download_model.py` (auto-injected by Tier 2A's
      // setup-script detection, or hand-written in catalog manifests) fail
      // with `spawn python ENOENT`: OS8's sanitized PATH may not include a
      // system `python3`, and even when it does, that python wouldn't have
      // the app's venv-installed packages. See _installEnv below.
      const env = this._installEnv(appDir, sanitizedEnv);
      onLog?.('stdout', `+ ${argv.join(' ')}\n`);
      console.log(`[python-adapter] + ${argv.join(' ')}`);
      try {
        await spawnPromise(argv, { cwd: appDir, env, onLog });
      } catch (err) {
        console.log(`[python-adapter] FAILED: ${argv.join(' ')}`);
        console.log(`[python-adapter] error: ${err.message}`);
        throw err;
      }
      // Post-command sanity: if this was a venv create, confirm it actually
      // produced a `.venv/bin/python` (or Scripts/python.exe). uv venv has
      // historically been able to exit 0 without creating the venv on
      // certain target Pythons — catch that here rather than letting the
      // next command fail with an opaque "No virtual environment" error.
      // We always create the venv at `<appDir>/.venv` (the _frozenInstallCmds
      // contract), so we can check that path directly without parsing argv.
      if (argv.length >= 3 && argv[1] === 'venv') {
        const pyBin = path.join(appDir, '.venv',
          process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
        const ok = fs.existsSync(pyBin);
        console.log(`[python-adapter]   venv check: ${pyBin} exists=${ok}`);
        if (!ok) {
          throw new Error(`uv venv exited 0 but ${pyBin} doesn't exist — venv creation silently failed`);
        }
      }
    }
  },

  async _frozenInstallCmds(pm, appDir, spec) {
    const uv = await ensureUv();
    const pyVer = (spec?.runtime?.version || '3.12').toString();

    // --relocatable makes uv generate a venv with portable shebang lines
    // in .venv/bin/<entrypoint> scripts. Without it, pip bakes the absolute
    // staging path into every console-script (e.g.
    // `#!/staging/.../bin/python`), and atomic move from staging to apps
    // breaks every entry point (`spawn streamlit ENOENT` even though
    // `.venv/bin/streamlit` exists). uv 0.4.11+ supports the flag.
    switch (pm) {
      case 'uv': {
        // uv sync --frozen creates .venv/ AND installs from uv.lock.
        // --python forces the lockfile-declared interpreter.
        return [{ argv: [uv, 'sync', '--frozen', '--python', pyVer, '--relocatable'] }];
      }
      case 'poetry': {
        // Poetry not auto-installed (plan §5 decision 4). Verified-channel
        // catalog manifests prefer uv; community-channel poetry manifests
        // require a host poetry on PATH.
        return [{
          argv: ['poetry', 'install', '--no-update', '--no-root', '--no-interaction'],
        }];
      }
      case 'pip': {
        // requirements.txt path. uv ALWAYS handles the venv (no system pip).
        // --require-hashes only if every line has a hash; otherwise it would
        // refuse plain `pkg==X.Y` lines.
        const reqPath = path.join(appDir, 'requirements.txt');
        let hasHashes = false;
        try {
          hasHashes = /^\s*--hash=/m.test(fs.readFileSync(reqPath, 'utf8'));
        } catch (_) { /* file may not exist; covered by detect */ }
        const venvCreate = [uv, 'venv', '--python', pyVer, '--relocatable', '.venv'];
        const installFlags = hasHashes
          ? [uv, 'pip', 'install', '--require-hashes', '-r', 'requirements.txt']
          : [uv, 'pip', 'install', '-r', 'requirements.txt'];
        return [
          { argv: venvCreate },
          { argv: installFlags },
        ];
      }
      default:
        throw new Error(`unsupported python package manager: ${pm}`);
    }
  },

  _writeEnvFile(appDir, envEntries) {
    if (!envEntries || envEntries.length === 0) return;
    const lines = envEntries.map(e => `${e.name}=${String(e.value).replace(/\n/g, '\\n')}`);
    fs.writeFileSync(path.join(appDir, '.env'), lines.join('\n') + '\n', 'utf8');
  },

  // ── Start ───────────────────────────────────────────────────────────────────
  async start(spec, appDir, sanitizedEnv, onLog) {
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

    // Activate the venv via PATH prepend — the spawned process picks up
    // the right `python`, `streamlit`, `gradio` binaries automatically.
    // The venv may not exist for adapter cases that bypass install (tests),
    // but PATH prepend is safe regardless.
    const venvBin = path.join(appDir, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
    const env = {
      ...sanitizedEnv,
      PATH: `${venvBin}${path.delimiter}${sanitizedEnv.PATH || ''}`,
    };

    // Gradio defensive port binding: Gradio reads GRADIO_SERVER_PORT and
    // GRADIO_SERVER_NAME from the environment iff the script calls
    // `demo.launch()` without an explicit `server_port=` kwarg. Apps that
    // pass the kwarg (e.g. HivisionIDPhotos: `demo.launch(server_port=args.port)`)
    // will ignore these, which is fine — the drafter detects --port argparse
    // flags from the source and threads them via start.argv. For all other
    // bare `demo.launch()` apps, these vars are what makes the allocated
    // OS8 port get respected. Setting them is idempotent and harmless even
    // when start.argv already has --port.
    const gradioInjected = effective?.framework === 'gradio';
    if (gradioInjected) {
      env.GRADIO_SERVER_PORT = String(sanitizedEnv.PORT);
      env.GRADIO_SERVER_NAME = '127.0.0.1';
    }

    // Surface the start command in the OS8 main-process terminal for parity
    // with install-time logging (`[python-adapter] + uv venv ...`). When a
    // start fails, `[python-adapter] start: ...` is the line that tells you
    // what was actually spawned.
    console.log(
      `[python-adapter] start: ${startArgv.join(' ')} (cwd=${appDir}, port=${env.PORT}` +
      (gradioInjected ? ', GRADIO_SERVER_PORT/_NAME injected' : '') + ')'
    );

    const child = spawn(startArgv[0], startArgv.slice(1), {
      cwd: appDir,
      env,
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

    const ready = this._waitReady(effective, child, () => collected, env);

    return {
      pid: child.pid,
      port: parseInt(env.PORT, 10),
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
    const probe = spec?.start?.readiness || { type: 'http', path: '/', timeout_seconds: 60 };
    const timeoutMs = (probe.timeout_seconds ?? 60) * 1000;
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
      throw new Error(`readiness http timeout: ${url}`);
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
      throw new Error(`readiness log-regex timeout: /${probe.regex}/`);
    }
    throw new Error(`unknown readiness type: ${probe.type}`);
  },

  // ── Stop ────────────────────────────────────────────────────────────────────
  async stop(processInfo) {
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
    const chokidar = require('chokidar');
    const declared = Array.isArray(spec?.dev?.watch) && spec.dev.watch.length > 0
      ? spec.dev.watch.map(p => path.join(appDir, p))
      : [appDir].filter(fs.existsSync);

    if (declared.length === 0) return () => {};

    const watcher = chokidar.watch(declared, {
      ignored: makeIgnoreFilter(),
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

  // Build the env passed to spawnPromise for an install/postInstall command.
  // Once `<appDir>/.venv/bin` exists, prepend it to PATH so manifest commands
  // like `python scripts/download_model.py` resolve to the venv's python with
  // the app's installed packages. Frozen-install commands themselves use the
  // absolute uv path so they don't need the prepend; we still apply it
  // because it's harmless when unused. Exposed for unit-testing without
  // patching the closure-captured spawnPromise.
  _installEnv(appDir, sanitizedEnv) {
    const venvBin = path.join(appDir, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
    if (!fs.existsSync(venvBin)) return sanitizedEnv;
    return {
      ...sanitizedEnv,
      PATH: `${venvBin}${path.delimiter}${sanitizedEnv.PATH || ''}`,
    };
  },

  // ── Test helpers ────────────────────────────────────────────────────────────
  _substitutePlaceholders(argv, vars) {
    return argv.map(a => String(a).replace(/\{\{([A-Z_]+)\}\}/g, (m, name) => vars[name] ?? m));
  },
  _internal: {
    spawnPromise,
    ensureUv,
    FRAMEWORK_DEFAULTS,
    UV_VERSION,
    UV_ASSET_NAME,
    UV_CHECKSUMS,
    UV_TARBALL_INNER,
    _setDownloader: (fn) => { _downloader = fn; },
    _resetDownloader: () => { _downloader = defaultDownloader; },
  },
};

function makeIgnoreFilter() {
  const HARD_IGNORES = [
    /(^|[\\/])\.venv([\\/]|$)/,
    /(^|[\\/])venv([\\/]|$)/,
    /(^|[\\/])__pycache__([\\/]|$)/,
    /\.pyc$/,
    /(^|[\\/])\.env(\..*)?$/,
    /(^|[\\/])\.git([\\/]|$)/,
    /(^|[\\/])dist([\\/]|$)/,
    /(^|[\\/])build([\\/]|$)/,
    /(^|[\\/])node_modules([\\/]|$)/,
  ];
  return (file) => HARD_IGNORES.some(re => re.test(file));
}

// ── uv auto-install ────────────────────────────────────────────────────────────
//
// `ensureUv()` returns an absolute path to a usable uv binary. Order:
//   1. Cached at OS8_BIN_DIR/uv (or uv.exe on Windows) — return it.
//   2. Host PATH `uv --version` succeeds — return 'uv' (relies on PATH).
//   3. Download from astral-sh/uv GitHub releases, verify SHA-256, extract.
//
// The downloader is injectable for tests via _setDownloader.

let _downloader = defaultDownloader;

async function defaultDownloader(url, destPath, expectedSha256) {
  await downloadFile(url, destPath);
  const got = await sha256File(destPath);
  if (got !== expectedSha256) {
    try { fs.unlinkSync(destPath); } catch (_) { /* ignore */ }
    throw new Error(`uv checksum mismatch: expected ${expectedSha256}, got ${got}`);
  }
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    let aborted = false;
    const timer = setTimeout(() => {
      aborted = true;
      file.close();
      try { fs.unlinkSync(destPath); } catch (_) { /* ignore */ }
      reject(new Error('uv unavailable: download timeout'));
    }, 30_000);
    timer.unref?.();

    const onErr = (err) => {
      if (aborted) return;
      clearTimeout(timer);
      file.close();
      try { fs.unlinkSync(destPath); } catch (_) { /* ignore */ }
      reject(new Error(`uv unavailable: cannot reach github.com (${err.message})`));
    };

    const handleResponse = (res) => {
      if (aborted) return;
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = https.get(res.headers.location, handleResponse);
        next.on('error', onErr);
        return;
      }
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        try { fs.unlinkSync(destPath); } catch (_) { /* ignore */ }
        reject(new Error(`uv unavailable: HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => {
        clearTimeout(timer);
        file.close((err) => err ? reject(err) : resolve());
      });
    };

    const req = https.get(url, handleResponse);
    req.on('error', onErr);
  });
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('error', reject);
    s.on('data', d => hash.update(d));
    s.on('end', () => resolve(hash.digest('hex')));
  });
}

async function ensureUv() {
  const exe = process.platform === 'win32' ? 'uv.exe' : 'uv';
  const target = path.join(OS8_BIN_DIR, exe);
  if (fs.existsSync(target)) {
    // Verify the cached binary matches our pinned UV_VERSION. If a previous
    // OS8 install dropped an older binary (e.g. 0.5.5 with the silent
    // venv-creation bug on aarch64), nuke it and re-download. Any failure
    // probing --version (corrupt download, ABI mismatch) also triggers a
    // re-download.
    try {
      const { stdout } = await spawnPromise([target, '--version'], { timeout: 5000 });
      const m = stdout.match(/^uv (\d+\.\d+\.\d+)/);
      if (m && m[1] === UV_VERSION) return target;
      console.log(`[python-adapter] cached uv ${m?.[1] || 'unknown'} != target ${UV_VERSION}; refreshing`);
    } catch (e) {
      console.log(`[python-adapter] cached uv at ${target} unusable (${e.message}); refreshing`);
    }
    try { fs.unlinkSync(target); } catch (_) { /* about to be overwritten anyway */ }
  }

  // Host uv first — fast path if the user has uv installed system-wide.
  try {
    const { stdout } = await spawnPromise(['uv', '--version'], { timeout: 5000 });
    if (/^uv \d/.test(stdout)) return 'uv';
  } catch (_) { /* not installed; download */ }

  const archKey = process.arch === 'arm64' ? 'arm64' : 'x64';
  const platKey = `${process.platform}-${archKey}`;
  const asset = UV_ASSET_NAME[platKey];
  const sha = UV_CHECKSUMS[platKey];
  const inner = UV_TARBALL_INNER[platKey];
  if (!asset || !sha) {
    throw new Error(`uv: no prebuilt for ${platKey}; install uv manually and retry`);
  }

  const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset}`;
  const tmp = path.join(os.tmpdir(), `uv-${UV_VERSION}-${platKey}-${Date.now()}-${process.pid}.bin`);

  await _downloader(url, tmp, sha);

  fs.mkdirSync(OS8_BIN_DIR, { recursive: true });

  if (asset.endsWith('.tar.gz')) {
    const tar = require('tar');
    // Asset layout: <inner>/uv (and <inner>/uvx). strip:1 drops the outer
    // dir; filter keeps only the uv binary (and uvx, harmlessly).
    await tar.x({
      file: tmp,
      cwd: OS8_BIN_DIR,
      strip: 1,
      filter: (p) => {
        const norm = p.replace(/\\/g, '/');
        return norm === `${inner}/uv` || norm === `${inner}/uvx`;
      },
    });
  } else {
    // .zip — Windows path. Use PowerShell Expand-Archive (no Node dep).
    const stage = path.join(os.tmpdir(), `uv-${UV_VERSION}-extract-${Date.now()}`);
    fs.mkdirSync(stage, { recursive: true });
    await spawnPromise([
      'powershell', '-NoProfile', '-Command',
      `Expand-Archive -Path '${tmp}' -DestinationPath '${stage}' -Force`,
    ], { timeout: 60_000 });
    const inside = path.join(stage, inner, exe);
    fs.copyFileSync(inside, target);
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }

  if (process.platform !== 'win32') {
    try { fs.chmodSync(target, 0o755); } catch (_) { /* may already be 0755 */ }
  }
  try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }

  if (!fs.existsSync(target)) {
    throw new Error(`uv extraction failed: ${target} missing`);
  }
  return target;
}

module.exports = PythonRuntimeAdapter;
