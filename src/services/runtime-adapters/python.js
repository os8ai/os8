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
const UV_VERSION = '0.5.5';

const UV_ASSET_NAME = {
  'darwin-arm64': 'uv-aarch64-apple-darwin.tar.gz',
  'darwin-x64':   'uv-x86_64-apple-darwin.tar.gz',
  'linux-arm64':  'uv-aarch64-unknown-linux-gnu.tar.gz',
  'linux-x64':    'uv-x86_64-unknown-linux-gnu.tar.gz',
  'win32-x64':    'uv-x86_64-pc-windows-msvc.zip',
};

const UV_CHECKSUMS = {
  // Verified against https://github.com/astral-sh/uv/releases/download/0.5.5/<asset>.sha256
  'darwin-arm64': '9368ad5eb6dfb414e88b1ab70ef03a15963569a2bba5b2ad79f8cd0cdde01646',
  'darwin-x64':   'da8f40c1effe0e5d6ac0438a72ecb7671d67dcf8e3d53ff3d4e1b17140a1b5bc',
  'linux-arm64':  'aa3e8c6e095798c92e0b1bc7599af6313c10c0f35cd301221d230abb083cf6b0',
  'linux-x64':    '3ef767034dec63a33d97424b0494be6afa7e61bcde36ab5aa38d690e89cac69c',
  'win32-x64':    '4a2d709b55a2267fcf4adf35f9c38e244c23b118d0992d52a897df8aa21961d2',
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
    const installCmds = await this._frozenInstallCmds(pm, appDir, spec);
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

  async _frozenInstallCmds(pm, appDir, spec) {
    const uv = await ensureUv();
    const pyVer = (spec?.runtime?.version || '3.12').toString();

    switch (pm) {
      case 'uv': {
        // uv sync --frozen creates .venv/ AND installs from uv.lock.
        // --python forces the lockfile-declared interpreter.
        return [{ argv: [uv, 'sync', '--frozen', '--python', pyVer] }];
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
        const venvCreate = [uv, 'venv', '--python', pyVer, '.venv'];
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
  if (fs.existsSync(target)) return target;

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
