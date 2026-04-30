# OS8 App Store — Phase 2 Implementation Plan

**Companions:** [`app-store-spec.md`](./app-store-spec.md) (Draft v2), [`app-store-plan.md`](./app-store-plan.md), [`phase-0-plan.md`](./phase-0-plan.md), [`phase-1-plan.md`](./phase-1-plan.md).
**Audience:** Engineers implementing PRs 2.1 – 2.6 in `/home/leo/Claude/os8/`.
**This document:** the concrete contract for each Phase 2 PR — files, splice points, signatures, framework defaults, manifest fixtures, Docker spawn args, schema bump strategy. Reference the spec/plan/phase-1-plan for *why*; this file is *how*.

---

## 1. Scope, Phase 2 gate, inheritance

Phase 2 ships **three new runtimes** (`python`, `static`, `docker`), the **framework defaults** for Streamlit + Gradio + Hugo + Jekyll, and a **catalog seed** that proves them: ComfyUI (`python`), an OpenWebUI bundle (`docker`), plus small Streamlit/Gradio demos in PR 2.4. Six PRs:

| PR | Work unit | Surface | Gate? |
|---|---|---|---|
| 2.1 | `python` runtime adapter (uv-based, auto-installs uv) | OS8 | — |
| 2.2 | Streamlit + Gradio framework defaults + **Streamlit-through-proxy smoke test** | OS8 | **Phase 2 GATE** |
| 2.3 | `static` runtime adapter (Hugo / Jekyll / plain HTML at `<slug>.localhost:8888` via OS8 static middleware) | OS8 | — |
| 2.4 | Catalog seed: small Streamlit + Gradio demos, ComfyUI (`python`), OpenWebUI manifest (declared `docker` — gated behind 2.5) | Catalog | — |
| 2.5 | `docker` runtime adapter + `appspec-v2.json` (schema bump that un-rejects `runtime.kind: docker`) | OS8 + Catalog | — |
| 2.6 | **Folded into 2.5.** "Docker fallback for native-package apps" is not a separate runtime — it is just the natural use of `runtime.kind: docker` for apps that need ffmpeg / CUDA toolkit / system fonts. PR 2.5 ships the runtime; the catalog work is one extra OpenWebUI-style manifest. Listed here so the index matches plan §4. | (none) | — |

### The Phase 2 gate — PR 2.2 Streamlit smoke test

Plan §4 lists Streamlit/Gradio HMR as PR 2.2; spec §1's "Why subdomain mode" specifically calls out "Streamlit/Gradio rely on Tornado WS for live updates" as a case the subdomain proxy must carry. Phase 1's PR 1.14 proved Vite HMR survives the proxy (`src/services/reverse-proxy.js:120` already has `ws: true, xfwd: true, changeOrigin: false`); Streamlit's behavior is different enough that re-proving it for one Phase-2 framework is the right gate:

- Streamlit re-runs the script on file change and pushes a **`/_stcore/stream` WebSocket** to the browser to trigger re-render. Different message shape from Vite's `/__vite_hmr`.
- Streamlit defaults bind `0.0.0.0` and write `--server.address` / `--server.port` flags via CLI.
- Streamlit version ≥ 1.30 enforces an `enableCORS`/`enableXsrfProtection` interaction that blocks framed access from a different origin even when same-server. We need a manifest field to opt out (we settle this in PR 2.2 — the answer is the framework-default `--server.enableCORS=false --server.enableXsrfProtection=false` flag pair, since `<slug>.localhost:8888` *is* the dev origin under subdomain mode).

**Until PR 2.2's smoke test passes locally on macOS + Linux, PR 2.4's Streamlit/Gradio manifests do not merge** (no point seeding a catalog with apps that may not work). PR 2.5 (`docker`) is independent and may merge without 2.2. Catalog manifests for ComfyUI (`python`) merge once 2.1 + 2.4 are green.

### Inheritance from Phase 1 — what Phase 2 does **not** re-spec

Phase 2 PRs implement runtime adapters and ride the install state machine and registry built in Phase 1. **Do not re-spec these.** Phase 2 PR descriptions cite the Phase 1 contract by file path and section.

| Inherited primitive | Phase 1 PR | File on disk (post-merge) |
|---|---|---|
| `RuntimeAdapter` interface (`ensureAvailable`, `detectPackageManager`, `install`, `start`, `stop`, `watchFiles`, `detectVersion`) and per-kind registry | 1.11a | `src/services/runtime-adapters/index.js`, `src/services/runtime-adapters/node.js` |
| Adapter spawn pattern: argv arrays, `shell: false`, framework-default flag injection, readiness probe (http or log-regex), POSIX `detached: true` for tree-kill | 1.11b | same |
| `AppProcessRegistry` (port allocation in `[40000, 49999]`, multi-signal idle reaping, `keepRunning` override, `markHttpActive`/`markStdoutActive`/`markChildActive`, `stopAll`) | 1.12 | `src/services/app-process-registry.js` |
| `ReverseProxyService.middleware()` + `attachUpgradeHandler(server)` (subdomain-only, `<slug>.localhost:8888`, host-based dispatch) | 1.13 | `src/services/reverse-proxy.js` (**already shipped**, audit-confirmed) |
| Install state machine `pending → cloning → reviewing → awaiting_approval → installing → installed`, atomic staging→apps move, `apps` row insert with `app_type='external'`, fork-on-first-edit | 1.5 / 1.16 | `src/services/app-installer.js`, `src/services/app-install-jobs.js` (**1.5 shipped**; 1.16 builds on 1.5's pub/sub seam) |
| `AppReviewService` (static checks + advisory analysis + LLM review) | 1.6 | `src/services/app-review.js` (**shipped**, audit-confirmed) |
| Sanitized env builder (whitelist + per-app secrets + OS8-injected) | 1.10 | `src/services/sanitized-env.js` (**shipped**) |
| Hardened BrowserView (sandbox, `webSecurity: true`, `setWindowOpenHandler`, `setPermissionRequestHandler`) and external-app launch path (`POST /api/apps/:id/processes/start` → register proxy → load `<slug>.localhost:8888/`) | 1.19 | `src/services/preview.js` overload + renderer launch flow |
| Install plan UI (review findings, secrets inputs, install commands, gate logic) | 1.17 | `src/renderer/install-plan-modal.js` |
| Dev-mode toggle + chokidar watcher | 1.22 | `src/renderer/dev-mode-toggle.js` (Phase 2 PRs hook into this for Streamlit/Gradio reload — see PR 2.2) |

When PR 2.x text says "the adapter implements the spec §6.2.2 interface" it means **the same interface PR 1.11 ships in `src/services/runtime-adapters/index.js`** — see phase-1-plan.md PR 1.11.

---

## 2. Audit findings (Phase 2-relevant)

Verified against the working tree of `/home/leo/Claude/os8/` at audit time. The branch under review (`pr-1.6-app-review`) has Phase 1 PRs 1.1, 1.4, 1.5, 1.6, 1.10, 1.13, 1.14 merged; PR 1.6's app-review service (`src/services/app-review.js`, `src/services/security-review-shared.js`) is in flight on this branch.

| Phase 2 dependency | Code reality at audit | Implication |
|---|---|---|
| `src/services/runtime-adapters/` exists (PR 1.11a) | ✗ — directory does not exist yet. `tree-kill@^1.2.2` IS installed in `package.json:80` (PR 1.11 dep landed early). | **PR 2.1 must not merge before PR 1.11a.** Order in dependency graph: 1.11a → 2.1. |
| `src/services/app-process-registry.js` (PR 1.12) | ✗ — does not exist. | **PR 2.1's adapter has no consumer until 1.12.** Same dependency: 1.11 + 1.12 → 2.1's e2e test. |
| `src/services/reverse-proxy.js` carries WebSockets | ✓ — `httpProxy.createProxyServer({ ws: true, xfwd: true, changeOrigin: false })` at line 30, `attachUpgradeHandler(server)` at line 99. PR 1.14 smoke test for Vite HMR is in `tests/reverse-proxy-vite-hmr.test.js` (commit `77b4d66`). | Streamlit/Gradio's Tornado WS rides the same primitive. PR 2.2's smoke test is a near-clone of PR 1.14's structure. |
| `src/services/app-installer.js` plug-points | ✓ — `_installPostApproval: null` at line 117 is the seam PR 1.16 fills. The state machine at lines 145-207 currently halts at `awaiting_approval`. | Phase 2 has **zero** new state-machine work — runtime adapter selection is dispatched in `_installPostApproval` (1.16) via `getAdapter(manifest.runtime.kind)`. |
| `src/services/app-review.js` runs `npm audit` for Node | ✓ — `_runStaticAnalysis` at line 324 dispatches on `package.json` presence. **No Python branch.** | PR 2.1 extends `_runStaticAnalysis` with a Python branch: `pip check` on `requirements.txt` / `pyproject.toml` presence. |
| `src/data/appspec-v1.json` `runtime.kind` enum | ✓ — line 52: `"enum": ["node", "python", "static"]`. **`docker` is rejected** (matches spec §3.5). | **Schema bump strategy:** PR 2.5 ships `src/data/appspec-v2.json` (extends v1 with `docker` + `runtime.image`). Manifest validator dispatches on `schemaVersion`. v1 manifests stay rejected for docker; v2 manifests accept it. Rationale below in PR 2.5. |
| `manifest-validator.js` schema selection | `src/services/manifest-validator.js:28` reads `appspec-v1.json` directly. No version-dispatch. | PR 2.5 wraps the loader: dispatch on `manifest.schemaVersion ∈ {1, 2}`. |
| `package.json` deps: `dockerode`, `tar`, `node-stream-zip` | ✗ — none installed. `archiver@^7.0.1` IS installed (line 67) but only writes archives. | PR 2.1 adds **`tar@^7`** for uv tarball extraction (uv-installed PR 2.1 fallback path; `tar.x` extracts the macOS/Linux `.tar.gz` releases). PR 2.5 adds **NO docker SDK** — we shell out to the `docker` CLI via `child_process.spawn`, same pattern as the Node adapter's `git`/`npm`/`pnpm` calls. Reasoning in PR 2.5. |
| `src/services/app.js` has `createExternal` | ✗ — PR 1.16's `AppService.createExternal(db, ...)` not yet present (audit confirms 1.16 not merged). | PR 2.1's adapter writes nothing to `apps`; the install pipeline (1.16) calls `AppService.createExternal` regardless of runtime kind. No new `app.js` work in Phase 2. |
| `comfyui-client.js` exists | ✓ — `src/services/comfyui-client.js` (Phase 3 §4.5 image gen). Talks to a **launcher-managed** ComfyUI on `localhost:8188`. | **Distinct concern.** Phase 2 PR 2.4 ships ComfyUI as an *installable catalog app* at `comfyui.localhost:8888`. The two ComfyUIs do not collide — different ports (`8188` for launcher-managed; whatever the registry allocates in `[40000, 49999]` for the catalog app), different lifecycles. Document the distinction in PR 2.4's manifest README. |
| Catalog repo (`os8ai/os8-catalog`) — Phase 0 PR 0.1 | At time of writing, may or may not have shipped. Phase 2 PR 2.4 + PR 2.5 add manifests + bump the schema in **both** the catalog repo and the desktop's bundled `src/data/appspec-v*.json` copy. | When PR 2.5 ships, the catalog repo's `schema/appspec-v2.json` and the desktop's bundled copy MUST be identical (verified via a CI byte-compare in catalog-side `validate.yml`, mirroring PR 0.2's pattern). |

**Net assessment.** Phase 1's primitives extend cleanly to Phase 2: the `RuntimeAdapter` interface is generic over runtime kinds, the install state machine is runtime-agnostic, the reverse proxy is host-based and runtime-blind, and the review service has a per-runtime `_runStaticAnalysis` extension point. Phase 2's load-bearing additions are: **(1)** uv auto-install with checksum verification (no existing analogue — PR 2.1), **(2)** the `<slug>.localhost:8888` static-files middleware that gives subdomain trust isolation to apps with no dev server (PR 2.3), **(3)** the schema-version dispatch + Docker CLI orchestration (PR 2.5).

---

## 3. Cross-PR dependencies (Phase 1 + Phase 2)

```
Phase 1 chain (must complete first):
  1.11a (Node adapter shell + RuntimeAdapter interface)  ───┐
  1.11b (Node adapter start/stop/readiness/watchFiles)      │
  1.12  (AppProcessRegistry)                                ├──> 2.1, 2.3, 2.5
  1.16a + 1.16b (install pipeline glue)                     │
  1.19  (hardened BrowserView + launch path)                ┘

Phase 2:
  2.1 (Python adapter)            ──> 2.2 (Streamlit/Gradio defaults + GATE)
  2.1                             ──> 2.4-Streamlit/Gradio + ComfyUI manifests (gated by 2.2)
  2.3 (static adapter)            ──> 2.4-static demo manifest (independent of 2.2 gate)
  2.5 (docker adapter + v2 schema)──> 2.4-OpenWebUI manifest (independent of 2.2 gate)
  2.4 catalog seed                ──> none (catalog repo)
```

PR 2.1 is the keystone for `python`-kind apps. PR 2.5 is independent of 2.1 (different runtime entirely). PR 2.3 is independent. PR 2.4's manifests gate on whichever adapter their `runtime.kind` references.

---

## PR 2.1 — Python runtime adapter (uv-based)

**Goal.** Implement the spec §6.2.2 `RuntimeAdapter` interface for `runtime.kind: python`. Auto-install `uv` to `~/os8/bin/uv` when missing. Detect package manager from lockfile precedence: `uv.lock > poetry.lock > requirements.txt`. Frozen install per channel. Cross-platform tree-kill of the Python process tree.

### Files

- **Create:** `/home/leo/Claude/os8/src/services/runtime-adapters/python.js`
- **Modify:** `/home/leo/Claude/os8/src/services/runtime-adapters/index.js` — `register(require('./python'))` after the Node adapter line
- **Modify:** `/home/leo/Claude/os8/src/config.js` — add `OS8_BIN_DIR = path.join(OS8_DIR, 'bin')`; include in `ensureDirectories`
- **Modify:** `/home/leo/Claude/os8/package.json` — add `tar@^7.4` to `dependencies` (uv tarball extraction on POSIX; PowerShell `Expand-Archive` handles Windows .zip natively, no Node dep needed)
- **Modify:** `/home/leo/Claude/os8/src/services/app-review.js` — extend `_runStaticAnalysis` (line 324) with a Python branch (`pip check` against the staging dir's resolved venv when present; `safety` / `osv-scanner` deferred to Phase 3 per spec §6.2.5)

### Adapter shape (mirror PR 1.11's Node adapter)

```js
// /home/leo/Claude/os8/src/services/runtime-adapters/python.js
const fs = require('fs');
const path = require('path');
const os  = require('os');
const { spawn } = require('node:child_process');
const treeKill = require('tree-kill');
const { OS8_DIR, OS8_BIN_DIR } = require('../../config');

const PythonRuntimeAdapter = {
  kind: 'python',

  // ── Availability check ─────────────────────────────────────────
  async ensureAvailable(spec) {
    const declared = spec.runtime.version || '3.12';
    // Resolve uv first; uv handles Python install/select itself.
    const uv = await ensureUv();           // returns absolute path
    // `uv python install <X.Y>` is idempotent — no-op if already present.
    await runCmd(uv, ['python', 'install', declared], { timeout: 120_000 });
    try { await runCmd('git', ['--version'], { timeout: 5000 }); }
    catch { throw new Error('git not found on PATH'); }
  },

  // ── Package-manager detection ──────────────────────────────────
  // Lockfile precedence (resolves a Phase 2 design question):
  //   uv.lock > poetry.lock > requirements.txt
  // Pipfile.lock is NOT supported in v1 — pipenv usage is rare in the
  // open-source AI catalog and uv covers the same workflow. Manifests
  // shipping pipenv apps must override package_manager: pip and ship a
  // requirements.txt alongside.
  detectPackageManager(appDir, manifestHint = 'auto') {
    if (manifestHint && manifestHint !== 'auto') return manifestHint;
    for (const [file, pm] of [
      ['uv.lock',          'uv'],
      ['poetry.lock',      'poetry'],
      ['requirements.txt', 'pip'],
    ]) {
      if (fs.existsSync(path.join(appDir, file))) return pm;
    }
    // pyproject.toml without a lockfile is best-effort uv (uv pip install -e .)
    if (fs.existsSync(path.join(appDir, 'pyproject.toml'))) return 'uv';
    throw new Error(
      'no recognized Python lockfile (uv.lock | poetry.lock | requirements.txt) ' +
      'and no pyproject.toml in app directory'
    );
  },

  // ── Install ────────────────────────────────────────────────────
  async install(spec, appDir, sanitizedEnv, onLog) {
    const pm = this.detectPackageManager(appDir, spec.runtime.package_manager);
    const cmds = await this._frozenInstallCmds(pm, appDir, spec);
    this._writeEnvFile(appDir, spec.env || []);
    const runList = [...cmds, ...(spec.install || []), ...(spec.postInstall || [])];
    for (const cmd of runList) await this._spawn(cmd.argv, { cwd: appDir, env: sanitizedEnv, onLog });
  },

  async _frozenInstallCmds(pm, appDir, spec) {
    const channel = spec.review?.channel || 'verified';
    const uv = await ensureUv();
    const pyVer = spec.runtime.version || '3.12';

    switch (pm) {
      case 'uv': {
        // uv sync --frozen creates .venv/ AND installs from uv.lock.
        // --python forces the lockfile's interpreter. NO --no-dev for v1
        // since dev deps are sometimes required at runtime.
        return [
          { argv: [uv, 'sync', '--frozen', '--python', pyVer] },
        ];
      }
      case 'poetry': {
        // We don't auto-install Poetry — the user must have it on PATH.
        // The catalog rejects poetry-only manifests in Verified channel
        // (PR 2.4 manifests use uv); fallback path stays for community
        // channel + developer-import.
        const flags = channel === 'verified'
          ? ['install', '--no-update', '--no-root', '--no-interaction']
          : ['install', '--no-update', '--no-root', '--no-interaction'];
        return [{ argv: ['poetry', ...flags] }];
      }
      case 'pip': {
        // requirements.txt path. uv ALWAYS handles the venv (no system pip).
        // If the file ships hashes, --require-hashes; otherwise --no-deps is
        // too strict (we'd miss transitive deps). Detect:
        const reqPath = path.join(appDir, 'requirements.txt');
        const hasHashes = /^\s*--hash=/m.test(fs.readFileSync(reqPath, 'utf8'));
        const venvCreate = [uv, 'venv', '--python', pyVer, '.venv'];
        const installFlags = hasHashes
          ? ['pip', 'install', '--require-hashes', '-r', 'requirements.txt']
          : ['pip', 'install', '-r', 'requirements.txt'];
        return [
          { argv: venvCreate },
          { argv: [uv, ...installFlags] },
        ];
      }
      default:
        throw new Error(`unsupported python package manager: ${pm}`);
    }
  },

  // ── Start ──────────────────────────────────────────────────────
  async start(spec, appDir, sanitizedEnv, onLog) {
    for (const cmd of (spec.preStart || [])) {
      await this._spawn(cmd.argv, { cwd: appDir, env: sanitizedEnv, onLog });
    }

    const startArgv = this._substitutePlaceholders(spec.start.argv, {
      APP_HOST:     `${spec._localSlug}.localhost`,
      PORT:         String(sanitizedEnv.PORT),
      APP_DIR:      appDir,
      BLOB_DIR:     sanitizedEnv.OS8_BLOB_DIR,
      OS8_BASE_URL: sanitizedEnv.OS8_BASE_URL,
      OS8_API_BASE: sanitizedEnv.OS8_API_BASE,
    });

    // Activate the venv via PATH prepend — the spawned process picks up
    // the right `python` and `streamlit` binaries automatically.
    const venvBin = path.join(appDir, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
    const env = { ...sanitizedEnv, PATH: `${venvBin}${path.delimiter}${sanitizedEnv.PATH || ''}` };

    const child = spawn(startArgv[0], startArgv.slice(1), {
      cwd: appDir, env, shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    let collected = '';
    child.stdout.on('data', d => { const s = d.toString(); collected += s; onLog?.('stdout', s); });
    child.stderr.on('data', d => { const s = d.toString(); collected += s; onLog?.('stderr', s); });
    child.on('exit', code => onLog?.('exit', `process exited code=${code}`));

    const ready = this._waitReady(spec, child, () => collected, env);

    return { pid: child.pid, port: parseInt(env.PORT, 10), ready, _child: child };
  },

  // ── Stop / readiness / watchFiles / detectVersion ──────────────
  // _waitReady, stop, watchFiles, detectVersion, _spawn,
  // _substitutePlaceholders, _writeEnvFile mirror node.js exactly.
  // (Same shape; same readiness 'http' | 'log-regex' branches; same
  //  tree-kill stop with 5s SIGTERM→SIGKILL escalation.)

  async detectVersion(spec, appDir) {
    return runCmd('git', ['-C', appDir, 'rev-parse', 'HEAD'], { timeout: 5000 }).then(s => s.trim());
  },
};

module.exports = PythonRuntimeAdapter;
```

### `ensureUv()` — auto-install with checksum verification

uv ships pre-built binaries per platform on its GitHub releases. Pin a specific stable release at PR-merge time; the version constant lives at the top of `python.js` so re-pinning is a one-line PR.

```js
// Pinned at PR 2.1 merge time. Bump in a follow-up PR with a fresh checksum.
const UV_VERSION = '0.5.5';                          // verify on https://github.com/astral-sh/uv/releases at PR time
const UV_CHECKSUMS = {
  // Hex SHA-256 of the .tar.gz / .zip from the release page's checksums.txt.
  // Each platform-arch tuple → checksum.
  'darwin-arm64':  'aaaaaa...',
  'darwin-x64':    'bbbbbb...',
  'linux-arm64':   'cccccc...',
  'linux-x64':     'dddddd...',
  'win32-x64':     'eeeeee...',
};

const UV_ASSET_NAME = {
  'darwin-arm64':  'uv-aarch64-apple-darwin.tar.gz',
  'darwin-x64':    'uv-x86_64-apple-darwin.tar.gz',
  'linux-arm64':   'uv-aarch64-unknown-linux-gnu.tar.gz',
  'linux-x64':     'uv-x86_64-unknown-linux-gnu.tar.gz',
  'win32-x64':     'uv-x86_64-pc-windows-msvc.zip',
};

async function ensureUv() {
  const target = path.join(OS8_BIN_DIR, process.platform === 'win32' ? 'uv.exe' : 'uv');
  if (fs.existsSync(target)) return target;

  // Try a host uv first — fast path if the user has uv installed system-wide.
  try {
    const { stdout } = await runCmd('uv', ['--version'], { timeout: 5000 });
    if (/^uv \d/.test(stdout)) return 'uv';   // host-installed; rely on PATH
  } catch { /* not installed; download */ }

  const platKey = `${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
  const asset = UV_ASSET_NAME[platKey];
  const sha   = UV_CHECKSUMS[platKey];
  if (!asset) throw new Error(`uv: no prebuilt for ${platKey}; install uv manually and retry`);

  const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset}`;
  const dl  = path.join(os.tmpdir(), `uv-${UV_VERSION}-${platKey}-${Date.now()}.bin`);

  await downloadWithVerify(url, dl, sha);          // throws on checksum mismatch

  fs.mkdirSync(OS8_BIN_DIR, { recursive: true });
  if (asset.endsWith('.tar.gz')) {
    const tar = require('tar');
    await tar.x({ file: dl, cwd: OS8_BIN_DIR, strip: 1, filter: p => /\/uv$/.test(p) || p === 'uv' });
  } else {
    // .zip — Windows path. Use PowerShell Expand-Archive (no Node dep).
    await runCmd('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -Path '${dl}' -DestinationPath '${OS8_BIN_DIR}' -Force`]);
  }
  fs.chmodSync(target, 0o755);
  fs.unlinkSync(dl);
  return target;
}
```

**No-network behavior.** `downloadWithVerify` aborts after 30s on connection failure with a structured error. `_runApprove` (PR 1.16) catches it, transitions the install job to `failed` with `error_message: "uv unavailable: cannot reach github.com"`, and the install plan UI surfaces a clear "OS8 needs to download uv from github.com — please check your network and retry" message. No silent fallback to a system Python (would defeat the manifest's pinned version requirement).

### `--ignore-scripts` policy for Python

Plan §10 decision 8 covers Node only. Python equivalents:

| Channel | Behavior |
|---|---|
| `verified` | Run package install scripts. `pyproject.toml` `[build-system]` PEP 517 builds (e.g. `setuptools` extension modules) execute normally — required for native deps like `numpy`/`torch`. |
| `community` | Same as `verified` for v2 (no equivalent of npm's `--ignore-scripts` exists in `uv`/`pip` for transitive deps; build steps are PEP 517 mandates). LLM review must surface any non-PEP-517 install hooks. |
| `developer-import` | Same as community. Mitigation is review-side, not adapter-side. (Phase 3 PR 3.6 supply-chain analyzer flags suspicious imports.) |

Manifest field: **no equivalent `allow_package_scripts` for python.** The adapter ignores it for kind=python. Document in `appspec-v1.json` description.

### Environment file generation

`.env` written at the staging dir same as the Node adapter (`_writeEnvFile`). Most Streamlit/Gradio/ComfyUI apps read `.env` via `python-dotenv` (auto-loaded by Streamlit; explicit `from dotenv import load_dotenv; load_dotenv()` for Gradio/Flask/FastAPI). The runtime adapter writes the file; the app loads it.

### Static-analysis extension to `app-review.js`

In `src/services/app-review.js:324` `_runStaticAnalysis`, add a Python branch parallel to the existing `package.json` branch:

```js
// After the existing Node `npm audit` block:
if (fs.existsSync(path.join(stagingDir, 'pyproject.toml')) ||
    fs.existsSync(path.join(stagingDir, 'requirements.txt'))) {
  try {
    // pip check requires deps to be installed; we don't install during review.
    // Instead, parse the lockfile for known-malicious package names (small
    // hardcoded list at v1; Phase 3 PR 3.6 wires safety/osv-scanner).
    const flags = await scanPythonDeps(stagingDir);   // new helper
    findings.push(...flags);
  } catch (e) {
    findings.push({
      severity: 'info', category: 'supply_chain', file: null, line: null,
      description: `python dep scan failed: ${e.message?.slice(0, 200) || 'unknown'}`,
      snippet: '',
    });
  }
}
```

`scanPythonDeps` reads `requirements.txt` / `uv.lock` / `poetry.lock`, extracts package names, cross-references against a small `KNOWN_MALICIOUS_PYTHON` constant (typosquats on `requests`/`numpy`/`torch`/`pandas` — list maintained in the same file as a future Phase 3 hook point). Surface findings as `severity: 'warning'` for matches; `severity: 'info'` summarizing direct + transitive count.

The system-prompt's Python-aware additions to the LLM call:
- `start.argv` should bind `--server.address 127.0.0.1` (Streamlit) or `server_name='127.0.0.1'` (Gradio).
- `permissions.os8_capabilities` cross-referenced against `urllib`/`requests`/`httpx` calls in source.

### IPC + routes

**No new IPC** for PR 2.1. Adapter selection is internal to `_installPostApproval` (PR 1.16) via `getAdapter('python')`.

### Test fixtures

`tests/runtime-adapters/python.test.js`:

| Fixture | Path under `tests/fixtures/` | Assertion |
|---|---|---|
| Streamlit hello | `streamlit-hello/` (`requirements.txt: streamlit==1.32.2`, `app.py: import streamlit as st; st.write("hello")`) | `detectPackageManager` returns `'pip'`; `install` creates `.venv/` with `streamlit` importable; `start` returns `{ pid, port, ready }`; `ready` resolves; `fetch http://127.0.0.1:port/` 200 |
| Gradio hello | `gradio-hello/` (`requirements.txt: gradio==4.44.0`, `app.py: import gradio as gr; gr.Interface(...).launch(server_port=int(os.environ['PORT']), server_name='127.0.0.1')`) | same shape |
| uv-locked project | `uv-fastapi/` with `uv.lock` and `pyproject.toml` | `detectPackageManager` returns `'uv'`; install runs `uv sync --frozen` |
| Poetry project | `poetry-flask/` with `poetry.lock` | install runs `poetry install --no-update --no-root` |
| `--require-hashes` requirements | `pip-hashed/` with hashed requirements.txt | `pip install --require-hashes` is the install cmd |
| Channel `verified` with `pyproject.toml` only (no lockfile) | n/a | `detectPackageManager` falls through to `'uv'` — but `_runStaticChecks` (already in app-review.js) catches the missing-lockfile case as critical for Verified |

`tests/runtime-adapters/python-uv-install.test.js`:

| Setup | Assertion |
|---|---|
| Fresh `OS8_BIN_DIR` (deleted) | `ensureUv()` downloads + verifies + extracts; subsequent call returns cached path immediately |
| Mock `https://github.com/.../uv-...tar.gz` returns wrong bytes | checksum mismatch → throws `uv checksum mismatch` |
| `process.platform === 'win32'` mocked | uses `.zip` asset + PowerShell Expand-Archive (mocked) |
| Network fails | throws `uv unavailable: cannot reach github.com` |

### API/IPC contracts

None new. The adapter is a strict implementation of the existing `RuntimeAdapter` interface from PR 1.11a.

### Acceptance criteria

- A hand-authored Streamlit manifest (slug `streamlit-hello`) goes through `POST /api/app-store/install` → review → approve → install → start. The page at `streamlit-hello.localhost:8888/` renders Streamlit's "hello" output.
- `~/os8/bin/uv` is created on first install when no host uv is present; subsequent installs reuse it.
- A user without internet (offline test) gets a clear "cannot reach github.com" error and a recoverable install-failed state — `app_install_jobs.status='failed'`, `error_message` populated, staging dir cleaned by `reapStaging` on next start.

### Cross-platform notes

- **macOS / Linux:** uv `.tar.gz`; `tar.x` extracts to `~/os8/bin/uv`. POSIX `chmod 0755`.
- **Windows:** uv `.zip`; PowerShell `Expand-Archive` extracts to `~/os8/bin/uv.exe`. No `chmod` needed.
- **arm64 (Apple Silicon / Spark / Linux ARM):** `uv-aarch64-{apple-darwin|unknown-linux-gnu}.tar.gz`. The repo runs on Spark (aarch64); CI must include an aarch64 macOS runner OR tests must mock the download. Same matrix as PR 1.11.
- **uv `python install`:** uv's `python install 3.12` downloads the official Python build from `python-build-standalone` releases. Cross-platform; cached under `~/.local/share/uv/python/`. No system Python required.
- **Poetry:** not auto-installed. PR 2.1 documents that poetry manifests require host Poetry; community-channel manifests fall through to uv if present.

### Spec deviations

- **Pipenv (`Pipfile.lock`) not supported.** Spec §3.4 lists `requirements.txt` only; pipenv was never declared. Document.
- **Poetry not auto-installed** (uv is). Verified-channel catalog manifests SHOULD use uv; poetry stays as a community-channel option. Update the catalog `CONTRIBUTING.md` (PR 2.4 makes this concrete).

### Depends on

PR 1.11a (RuntimeAdapter interface), PR 1.11b (start/stop/readiness scaffolding to mirror), PR 1.10 (sanitized env), PR 1.6 (review service to extend).

### Open sub-questions

None — uv-as-canonical-installer + tarball-with-checksum download path resolves the open Phase 2 design questions.

---

## PR 2.2 — Streamlit + Gradio framework defaults + **Phase 2 GATE smoke test**

**Goal.** Add framework defaults for `streamlit` and `gradio` to the runtime adapter (mirroring Vite's framework defaults in PR 1.11). Prove subdomain-mode reverse proxy carries Streamlit's Tornado WebSocket through `<slug>.localhost:8888`. **GATE PR 2.4's Streamlit/Gradio catalog manifests until this passes.**

### Files

- **Modify:** `/home/leo/Claude/os8/src/services/runtime-adapters/python.js` — add `applyFrameworkDefaults(spec)` helper + extend the framework defaults table
- **Modify:** `/home/leo/Claude/os8/src/services/runtime-adapters/index.js` — export a `applyFrameworkDefaults(spec)` shared helper (Node + Python both use it)
- **Create:** `/home/leo/Claude/os8/tests/e2e/streamlit-proxy-smoke.test.js` — the GATE smoke test
- **Create:** `/home/leo/Claude/os8/tests/fixtures/streamlit-smoke/` — a tiny Streamlit app: `app.py` (5 lines) + `requirements.txt` (`streamlit==1.32.2`)
- **Create:** `/home/leo/Claude/os8/tests/fixtures/gradio-smoke/` — a tiny Gradio app: `app.py` (10 lines) + `requirements.txt` (`gradio==4.44.0`)

### Framework defaults table (extends PR 1.11's Node table)

All v1 frameworks bind at `/` because external apps are routed at their own subdomain.

| Framework | Default `start.argv` injection | Readiness | HMR strategy |
|---|---|---|---|
| `streamlit` | append `["--", "run", "{{APP_DIR}}/app.py", "--server.port={{PORT}}", "--server.address=127.0.0.1", "--server.enableCORS=false", "--server.enableXsrfProtection=false", "--server.headless=true", "--browser.gatherUsageStats=false"]` to a base `["streamlit"]` argv when manifest only sets `["streamlit"]` | log-regex `You can now view your Streamlit app` (Streamlit binds before this banner; HTTP probe also works but log-regex is faster on cold start) | **Streamlit native re-run**: the framework re-runs the script on file change automatically and pushes a re-render frame over its `/_stcore/stream` WebSocket. No OS8 watcher needed. Dev-mode (PR 1.22) chokidar watcher is left disabled for `dev.hmr: streamlit`. |
| `gradio` | append `["app.py"]` (or whatever the manifest's entrypoint is) — Gradio is launched as a plain Python script. The script must read `os.environ['PORT']` and `gr.Blocks().launch(server_port=int(os.environ['PORT']), server_name='127.0.0.1')` | http GET `/` | **Gradio reload via watcher**: Gradio's CLI `gradio run app.py --reload` exists in 4.x but doesn't expose `--server-port`. The cleaner v1 path is OS8's chokidar watcher (PR 1.22) restarting the process on `.py` changes. Manifest declares `dev.hmr: watcher`; restart_on includes `**/*.py`. |

**Why `--server.enableCORS=false --server.enableXsrfProtection=false` for Streamlit.** Under subdomain mode, the page origin is `<slug>.localhost:8888` and Streamlit's API/WebSocket calls are same-origin from the page's perspective. But Streamlit's xsrf-protection middleware checks the `X-Streamlit-CSRF` header on POST requests — when a POST arrives via the OS8 proxy, the header may be stripped or rewritten by `http-proxy`'s `xfwd: true` path. The two flags disable both checks. Acceptable because the trust boundary is enforced at the OS8 layer (sanitized env, scoped capability surface, hardened BrowserView), not at Streamlit's middleware.

**Why `--server.headless=true`.** Suppresses Streamlit's auto-browser-open behavior (which would race with the OS8 BrowserView and open a system tab).

### Smoke test (the gate)

`tests/e2e/streamlit-proxy-smoke.test.js`:

```js
// Test plan — paraphrased; production code may diverge in mocking style.
// 1. Spawn `streamlit run tests/fixtures/streamlit-smoke/app.py
//      --server.port=<rand> --server.address=127.0.0.1
//      --server.enableCORS=false --server.enableXsrfProtection=false
//      --server.headless=true`.
// 2. Mount ReverseProxyService on a test Express; register
//      ReverseProxyService.register('smoke', 'app-fake', <streamlit_port>).
// 3. Open a Playwright browser to `http://smoke.localhost:<test_proxy_port>/`
//    (the test sets `127.0.0.1 smoke.localhost` in /etc/hosts on Linux CI;
//    macOS resolves natively).
// 4. Wait for `[data-testid="stApp"]` to render (Streamlit's app shell).
// 5. Assert WebSocket connection on `/_stcore/stream` is OPEN.
// 6. Edit fixture's app.py — change "Hello" → "Updated".
// 7. Wait <5s; assert page text contains "Updated" without a full reload
//    (page navigation event count stays at 1).
// 8. Tear down.
```

The test fixture `app.py`:

```python
import streamlit as st
st.title("Smoke")
st.write("Hello")
```

### What blocks downstream

If the smoke test fails on macOS or Linux:
- PR 2.4's Streamlit + Gradio + ComfyUI manifests do **not** merge.
- PR 2.4's static-only seed manifests (Hugo / Jekyll / plain HTML, gated behind 2.3) are independent and may merge.
- PR 2.5 (`docker` adapter + OpenWebUI) is independent and may merge.

The smoke test must stream-edit the fixture, not just verify HTTP — Streamlit's WS-driven re-render is the load-bearing claim.

### IPC + routes

None new.

### Test fixtures

Listed above. Both fixtures are < 15 lines of Python total.

### Acceptance criteria

- Smoke test passes on macOS + Linux.
- A manifest declaring `framework: streamlit` (just `framework`, no other defaults) installs and starts; the page renders Streamlit's chrome at `<slug>.localhost:8888/`.
- Editing the fixture's `app.py` triggers a re-render via `/_stcore/stream` WS within 5s.
- Gradio fixture loads at `<slug>.localhost:8888/`; `gr.Blocks` UI renders.

### Cross-platform notes

- **Windows:** Streamlit's WebSocket is plain `ws://`; no Windows-specific quirks. `127.0.0.1 streamlit-smoke.localhost` may need an explicit hosts entry on legacy Windows — see PR 1.16's pre-flight DNS check.
- **arm64:** Streamlit pip-installs `pyarrow` which has aarch64 wheels on PyPI ≥ Streamlit 1.30. Verified at PR-merge time.

### Spec deviations

- **`--server.enableCORS=false --server.enableXsrfProtection=false` is a Streamlit-default injected by OS8.** Document in the framework-defaults table. Manifest authors don't need to know.

### Depends on

PR 2.1 (Python adapter must run Streamlit before this can smoke-test it), PR 1.13 + 1.14 (proxy + Vite gate already passed), PR 1.12 (registry), PR 1.16 (install pipeline).

### Open sub-questions

None.

---

## PR 2.3 — `static` runtime adapter (Hugo / Jekyll / plain HTML)

**Goal.** Implement the `RuntimeAdapter` interface for `runtime.kind: static`. Two sub-paths:

1. **Has a dev server** (Hugo's `hugo serve`, Jekyll's `bundle exec jekyll serve --livereload`): treated like the Node adapter — adapter spawns, framework default flags inject `--port`/`--host`, readiness probe, watcher.
2. **No dev server** (plain HTML, pre-built `dist/`, Markdown files served as-is): OS8 itself serves the files via a **per-app static-files handler bound to `<slug>.localhost:8888`**.

The trust boundary is the browser origin in **both** sub-paths — every static app gets its own subdomain (and therefore its own origin). Plan §4 said "no proxy needed (static-mode bypass)"; we're committing to **option A** from the prompt: the trust-boundary parity is preserved by routing the subdomain to OS8's own static middleware rather than letting plain-HTML apps share `localhost:8888`.

### Files

- **Create:** `/home/leo/Claude/os8/src/services/runtime-adapters/static.js`
- **Modify:** `/home/leo/Claude/os8/src/services/runtime-adapters/index.js` — `register(require('./static'))`
- **Modify:** `/home/leo/Claude/os8/src/services/reverse-proxy.js` — add a `registerStatic(localSlug, appId, appDir)` companion to `register(localSlug, appId, port)`. The middleware checks both maps; static entries serve via `express.static(appDir)` instead of `proxy.web`.

### Static adapter shape

```js
const fs = require('fs');
const path = require('path');
const { spawn } = require('node:child_process');
const treeKill = require('tree-kill');

const StaticRuntimeAdapter = {
  kind: 'static',

  async ensureAvailable(spec) {
    if (spec.framework === 'hugo') {
      try { await runCmd('hugo', ['version'], { timeout: 5000 }); }
      catch { throw new Error('hugo not found on PATH; install hugo to run static-hugo apps'); }
    }
    if (spec.framework === 'jekyll') {
      try { await runCmd('bundle', ['--version'], { timeout: 5000 }); }
      catch { throw new Error('bundler not found on PATH; install ruby+bundler for jekyll apps'); }
    }
    // 'none' framework or no dev-server case: nothing to ensure.
  },

  detectPackageManager(_appDir, _hint) {
    // Hugo / Jekyll do their own dep mgmt (`hugo mod`, `bundle install`).
    // Plain-HTML apps have no deps. Return a sentinel.
    return 'static';
  },

  async install(spec, appDir, sanitizedEnv, onLog) {
    // Hugo: `hugo mod download` if go.mod exists.
    // Jekyll: `bundle install` if Gemfile exists.
    // Plain-HTML: no-op.
    if (spec.framework === 'hugo' && fs.existsSync(path.join(appDir, 'go.mod'))) {
      await this._spawn(['hugo', 'mod', 'download'], { cwd: appDir, env: sanitizedEnv, onLog });
    }
    if (spec.framework === 'jekyll' && fs.existsSync(path.join(appDir, 'Gemfile'))) {
      await this._spawn(['bundle', 'install', '--path', '.bundle'],
        { cwd: appDir, env: sanitizedEnv, onLog });
    }
    // postInstall (build the site once, e.g. `hugo --minify`).
    for (const cmd of (spec.postInstall || [])) {
      await this._spawn(cmd.argv, { cwd: appDir, env: sanitizedEnv, onLog });
    }
    this._writeEnvFile(appDir, spec.env || []);
  },

  async start(spec, appDir, sanitizedEnv, onLog) {
    // Two paths: dev-server (Hugo / Jekyll) vs OS8-served static.
    if (this._hasDevServer(spec)) {
      return this._startDevServer(spec, appDir, sanitizedEnv, onLog);
    }
    return this._startOS8Served(spec, appDir);
  },

  _hasDevServer(spec) {
    return spec.framework === 'hugo' || spec.framework === 'jekyll' ||
           (Array.isArray(spec.start?.argv) && spec.start.argv[0] !== 'os8:static');
  },

  async _startDevServer(spec, appDir, sanitizedEnv, onLog) {
    // Same shape as Node adapter's start: argv substitution, spawn, readiness.
    // Framework defaults inject the right --port/--host pairs:
    //   hugo  → ['hugo', 'serve', '--port', '{{PORT}}', '--bind', '127.0.0.1', '--baseURL', 'http://{{APP_HOST}}:{{OS8_PORT}}/']
    //   jekyll → ['bundle', 'exec', 'jekyll', 'serve', '--port', '{{PORT}}', '--host', '127.0.0.1', '--livereload']
    // (full impl mirrors PythonRuntimeAdapter.start)
    /* … */
  },

  async _startOS8Served(_spec, appDir) {
    // Sentinel return: NO child process. The Express side serves files.
    // The route argv 'os8:static' tells the install pipeline to call
    // ReverseProxyService.registerStatic instead of register(...).
    return {
      pid:  null,
      port: null,
      ready: Promise.resolve(),
      _staticDir: path.join(appDir, /* spec.start.dir || */ 'dist'),
      _kind: 'static',
    };
  },

  async stop(processInfo) {
    if (processInfo._kind === 'static') return;       // no process to kill
    return new Promise((resolve) => {
      treeKill(processInfo.pid, 'SIGTERM', (err) => {
        if (err) setTimeout(() => treeKill(processInfo.pid, 'SIGKILL', () => resolve()), 5000);
        else resolve();
      });
    });
  },

  watchFiles(spec, appDir, onChange) { /* chokidar for plain-HTML; Hugo/Jekyll do their own */ },

  async detectVersion(_spec, appDir) {
    return runCmd('git', ['-C', appDir, 'rev-parse', 'HEAD'], { timeout: 5000 }).then(s => s.trim());
  },
};
```

### `ReverseProxyService.registerStatic` extension

Spec §6.2.3 keys the proxy by `localSlug`. The static branch needs the same keying but resolves to a directory rather than a port. Add a **second registry** (or extend the existing `_proxies` map's value shape):

```js
// /home/leo/Claude/os8/src/services/reverse-proxy.js — additions
const express = require('express');
const _staticServers = new Map();   // localSlug -> { appId, appDir, handler }

ReverseProxyService.registerStatic = function(localSlug, appId, appDir) {
  // appDir is the root the per-app static handler serves.
  const handler = express.static(appDir, {
    fallthrough: false,             // 404 from THIS app, not from OS8
    index: ['index.html', 'index.htm'],
    dotfiles: 'deny',               // never serve .env, .git, etc.
    setHeaders: (res, _filePath) => {
      // Treat as own-origin; don't cache aggressively at dev time.
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    },
  });
  _staticServers.set(localSlug, { appId, appDir, handler });
};

ReverseProxyService.unregisterStatic = function(localSlug) {
  _staticServers.delete(localSlug);
};

// Update middleware() to dispatch:
ReverseProxyService.middleware = function() {
  return (req, res, next) => {
    const host = (req.headers.host || '').toLowerCase();
    const m = host.match(SUBDOMAIN_HOST_RE);
    if (!m) return next();
    const slug = m[1];

    // 1. Static-served apps win.
    const staticEntry = _staticServers.get(slug);
    if (staticEntry) {
      try { require('./app-process-registry').get().markHttpActive(staticEntry.appId); } catch {}
      return staticEntry.handler(req, res, next);
    }

    // 2. Proxied dev-server apps.
    const proxyEntry = _proxies.get(slug);
    if (!proxyEntry) return next();
    try { require('./app-process-registry').get().markHttpActive(proxyEntry.appId); } catch {}
    proxy.web(req, res, { target: `http://127.0.0.1:${proxyEntry.port}` });
  };
};
```

**WebSocket upgrades for static apps.** Plain-HTML and Hugo/Jekyll-built sites don't ship WebSockets (Jekyll's `--livereload` does, but it's served by `jekyll serve` which is the dev-server path, not the static-bypass path). `attachUpgradeHandler(server)` continues to dispatch on `_proxies` only. Static-served apps that try to open a WS get a clean socket close; manifest LLM review (PR 2.1's extension) flags the case as `framework_mismatch`.

### Install pipeline hook (PR 1.16's `_installPostApproval`)

After `await adapter.install(...)`, the pipeline registers the proxy entry. For `runtime.kind: static`:

```js
// In src/services/app-installer.js _runApprove (PR 1.16):
const adapterInfo = await adapter.start(manifest, appDir, env, onLog);
if (adapterInfo._kind === 'static') {
  ReverseProxyService.registerStatic(localSlug, app.id, adapterInfo._staticDir);
} else {
  ReverseProxyService.register(localSlug, app.id, adapterInfo.port);
}
```

PR 1.19's launch path (`POST /api/apps/:id/processes/start`) makes the same dispatch.

### Framework defaults table (extends PR 1.11 + 2.2)

| Framework | Default `start.argv` injection | Readiness | Static path |
|---|---|---|---|
| `hugo` | append `["serve", "--port", "{{PORT}}", "--bind", "127.0.0.1", "--baseURL", "http://{{APP_HOST}}:{{OS8_PORT}}/"]` to base `["hugo"]` | http GET `/` | n/a (uses dev server) |
| `jekyll` | append `["exec", "jekyll", "serve", "--port", "{{PORT}}", "--host", "127.0.0.1", "--livereload"]` to base `["bundle"]` | http GET `/` | n/a |
| `none` (plain HTML, with `start.argv: ["os8:static", "--dir", "dist"]`) | adapter dispatches to OS8-served path; no spawn | ready immediately | `appDir/<dir>` |

`os8:static` is a **sentinel argv[0]**, not an actual binary. The static adapter recognizes it and skips the spawn path. Document in `appspec-v1.json` description.

### Test fixtures

`tests/fixtures/static-html/`:
- `index.html` — `<h1>Hello, OS8</h1>`

Manifest snippet:
```yaml
runtime: { kind: static, version: "0" }
framework: none
start:
  argv: ["os8:static", "--dir", "."]
  port: detect            # ignored for static
  readiness: { type: http, path: / }
```

`tests/fixtures/hugo-quickstart/`: a 5-page Hugo skeleton (`hugo new site .` + `hugo new posts/hello.md`). Manifest declares `framework: hugo`.

### Tests

`tests/runtime-adapters/static.test.js`:

| Scenario | Assertion |
|---|---|
| Plain-HTML fixture | `start` returns `{ _kind: 'static', _staticDir }`; `registerStatic` then `GET <slug>.localhost:port/` returns 200 with the index.html body |
| Plain-HTML with `dotfiles` request (`/.env`) | 403/404 (not served) |
| Hugo fixture | `install` runs `hugo mod download`; `start` spawns `hugo serve`; `ready` resolves; HTTP 200 |
| `attachUpgradeHandler` for a static-only entry | upgrade socket destroyed |

### Acceptance criteria

- A manifest with `runtime.kind: static, framework: none, start.argv: ["os8:static"]` installs, opens at `<slug>.localhost:8888/`, serves `index.html`.
- A Hugo manifest installs, runs `hugo serve`, hot-reloads on file change (Hugo's own websocket survives the proxy — same as Streamlit's; no separate gate test, but covered as a test case in `static.test.js`).
- `.env` and `.git` paths return 404 (the `dotfiles: 'deny'` setting).

### Cross-platform notes

- **Hugo** is a single static binary; Hugo manifests should declare `runtime.arch: [arm64, x86_64]` and verify via `_runStaticChecks`.
- **Jekyll** requires Ruby + Bundler. Verified channel manifests should NOT declare jekyll without a `runtime.system_packages` field — but `system_packages` doesn't exist in v1. **For v1, jekyll is a community-channel framework only**; document in `CONTRIBUTING.md` (the catalog repo) and reject jekyll-Verified manifests via a new `_runStaticChecks` rule in `app-review.js`.

### Spec deviations

- **`os8:static` argv sentinel** is a new convention introduced here. Document in `appspec-v1.json` description for `start.argv`.
- **`registerStatic` is a new ReverseProxyService method.** Phase 1's PR 1.13 ships only `register`; Phase 2 PR 2.3 extends it. Idempotent extension; does not break PR 1.13's contract.
- **Plan §4 said "static-mode bypass — no proxy needed."** Resolved as **Option A** from the prompt: every external app gets a subdomain, including static apps; the "bypass" is that OS8 serves the files itself rather than proxying to a separate dev server. Trust boundary parity preserved.

### Depends on

PR 1.11a (interface), PR 1.13 (proxy primitive), PR 1.16 (install pipeline). Independent of PR 2.1.

### Open sub-questions

None.

---

## PR 2.4 — Catalog seed (Streamlit, Gradio, ComfyUI, OpenWebUI)

**Goal.** Add concrete manifests to `os8ai/os8-catalog/apps/` for each new runtime. Streamlit + Gradio prove the Python + framework-defaults path. ComfyUI proves a real-world Python app. OpenWebUI proves the Docker path. Demo manifests for static (`hello-static`) prove PR 2.3.

### Files (all in the **catalog repo**, `os8ai/os8-catalog/`)

- `apps/streamlit-hello/manifest.yaml` + `icon.png` + `screenshots/01.png` + `README.md`
- `apps/gradio-hello/manifest.yaml` + assets
- `apps/comfyui/manifest.yaml` + assets (large icon: ComfyUI's own logo, license-permitting)
- `apps/openwebui/manifest.yaml` + assets (**gated behind PR 2.5 + appspec-v2.json**)
- `apps/hello-static/manifest.yaml` + assets

Each manifest passes Phase 0 CI (`validate.yml`, `resolve-refs.yml`, `lockfile-gate.yml`).

### Streamlit + Gradio demo manifests

These are tiny — their job is to prove the framework path works without dragging in a real-world Python app's CVE/license complexity.

```yaml
# apps/streamlit-hello/manifest.yaml
schemaVersion: 1
slug: streamlit-hello
name: "Streamlit Hello"
publisher: os8-curators
icon: ./icon.png
screenshots: [./screenshots/01.png]
category: dev-tools
description: "Minimal Streamlit demo — proves the runtime."

upstream:
  git: https://github.com/os8ai/streamlit-hello.git
  ref: v1.0.0                # resolved to SHA at sync time

framework: streamlit

runtime:
  kind: python
  version: "3.12"
  arch: [arm64, x86_64]
  package_manager: uv
  dependency_strategy: frozen

install:
  # PR 2.1 adapter auto-runs `uv sync --frozen --python 3.12` from
  # framework defaults; this manifest field stays empty.
  []

start:
  argv: ["streamlit", "run", "{{APP_DIR}}/app.py",
         "--server.port={{PORT}}", "--server.address=127.0.0.1",
         "--server.enableCORS=false", "--server.enableXsrfProtection=false",
         "--server.headless=true", "--browser.gatherUsageStats=false"]
  port: detect
  readiness:
    type: log-regex
    regex: "You can now view your Streamlit app"
    timeout_seconds: 60

surface:
  kind: web
  preview_name: "Streamlit Hello"

dev:
  hmr: streamlit
  editable: true

permissions:
  network: { outbound: false, inbound: false }
  filesystem: app-private
  os8_capabilities: []
  secrets: []

resources:
  memory_limit_mb: 512
  gpu: none
  disk_mb: 200

legal:
  license: MIT
  commercial_use: unrestricted

review:
  channel: verified
  reviewed_at: 2026-04-29
  reviewer: os8-curators
  risk: low
```

The upstream repo `os8ai/streamlit-hello` is a fixture repo created by PR 2.4. Contents: `app.py` (the 3-line demo), `requirements.txt: streamlit==1.32.2`, `uv.lock` (committed; generated via `uv lock` against streamlit-1.32.2).

Gradio demo follows the same shape with `framework: gradio`; the upstream's `app.py` reads `os.environ['PORT']`.

### ComfyUI manifest (verified upstream state)

Verified at audit time:
- **Repo:** `comfyanonymous/ComfyUI` (redirects to `Comfy-Org/ComfyUI`)
- **Latest stable:** `v0.20.1` (published 2026-04-27)
- **Resolved SHA for `v0.20.1`:** `64b8457f55cd7fb54ca7a956d9c73b505e903e0c` (verified via `GET /repos/Comfy-Org/ComfyUI/git/refs/tags/v0.20.1`)
- **License:** GPL-3.0
- **Default branch:** `master`
- **Package manager:** ships `requirements.txt` (PyTorch, transformers, tokenizers, safetensors, aiohttp, …); no uv.lock
- **Default port:** 8188 (we override to `{{PORT}}` via `--port` flag)
- **WebSocket:** uses aiohttp's WS for live progress updates; plain `ws://`, no special CORS configuration. Survives the proxy (same as Streamlit; covered indirectly by PR 2.2's gate).

```yaml
# apps/comfyui/manifest.yaml
schemaVersion: 1
slug: comfyui
name: "ComfyUI"
publisher: comfy-org
icon: ./icon.png
screenshots:
  - ./screenshots/01-graph.png
  - ./screenshots/02-output.png
category: ai-experiments
description: "Powerful diffusion-model GUI with a graph/nodes interface."

upstream:
  git: https://github.com/comfyanonymous/ComfyUI.git
  ref: v0.20.1
  # Sync resolves to SHA 64b8457f55cd7fb54ca7a956d9c73b505e903e0c.

framework: none                # ComfyUI is its own thing; not streamlit/gradio.
                               # The adapter doesn't apply framework defaults.

runtime:
  kind: python
  version: "3.12"
  arch: [arm64, x86_64]
  package_manager: pip         # requirements.txt path
  dependency_strategy: frozen

install: []                    # adapter runs `uv venv` + `uv pip install -r requirements.txt`

start:
  # ComfyUI's --output-directory / --input-directory / --user-directory flags
  # (verified in v0.20.1 main.py:104-127) redirect generated artifacts, uploads,
  # and saved workflows into OS8_BLOB_DIR. This keeps the source/data split
  # consistent with v1: source under ~/os8/apps/<id>/, data under ~/os8/blob/<id>/.
  # PR 1.24's tiered uninstall, PR 1.23's auto-commit, and the per-app blob
  # capability surface all assume this split.
  argv: ["python", "main.py",
         "--listen", "127.0.0.1",
         "--port", "{{PORT}}",
         "--output-directory", "{{BLOB_DIR}}",
         "--input-directory",  "{{BLOB_DIR}}/inputs",
         "--user-directory",   "{{BLOB_DIR}}/user"]
  port: detect
  readiness:
    type: log-regex
    regex: "To see the GUI go to:"
    timeout_seconds: 120        # cold-start downloads PyTorch wheels; allow

surface:
  kind: web
  preview_name: "ComfyUI"

dev:
  hmr: none                    # ComfyUI is a server-only app; reload restarts it
  editable: true               # source is at ~/os8/apps/<id>/ — Claude Code can edit
  restart_on: ["main.py", "execution.py", "server.py", "comfy/**/*.py"]

permissions:
  network:
    outbound: true             # ComfyUI fetches model files from huggingface, civitai
    inbound: false
  filesystem: app-private
  os8_capabilities: []         # no window.os8.* calls — ComfyUI uses its own
                               # filesystem APIs, redirected to BLOB_DIR via
                               # --output-directory etc. above. Sibling apps that
                               # want to read ComfyUI's outputs declare blob.readonly
                               # against this app's blob scope (Phase 3 cross-app
                               # blob sharing — out of scope for v1).
  secrets: []

resources:
  memory_limit_mb: 16384       # advisory — diffusion models are heavy
  gpu: optional                # CPU mode works but slow
  disk_mb: 50000               # models + dependencies

legal:
  license: GPL-3.0
  commercial_use: restricted
  notes: "GPL-3.0 — modifying ComfyUI for commercial use requires releasing source under GPL."

review:
  channel: verified
  reviewed_at: 2026-04-29
  reviewer: os8-curators
  risk: medium                 # large dep tree; surfaces in install plan UI
```

**Per-OS8 ComfyUI vs catalog ComfyUI.** OS8 already ships a `comfyui-client.js` that talks to a launcher-managed ComfyUI instance on `localhost:8188` (Phase 3 §4.5 image generation). The catalog ComfyUI is a **separate installation** at a registry-allocated port (4xxxx range) on `comfyui.localhost:8888`. The two coexist:
- The launcher-managed instance is the OS8 shell's image-gen backend (used by `imagegen` capability under the hood, agents call `window.os8.imagegen`).
- The catalog ComfyUI is a user-visible app for hands-on workflow editing, with its own blob storage scope.

Document this in the manifest's README.

**Output redirection — first-class CLI flags (no postInstall needed).** ComfyUI v0.20.1's `main.py:104-127` exposes `--output-directory`, `--input-directory`, and `--user-directory` as documented CLI flags that call into `folder_paths.set_output_directory(...)` etc. The manifest above passes them in `start.argv` with `{{BLOB_DIR}}` substitution — the runtime adapter (PR 1.11's `_substitutePlaceholders`, mirrored in PR 2.1's Python adapter) resolves these to `~/os8/blob/<id>/` at start time.

**Why CLI flags, not env vars or `extra_model_paths.yaml` or symlinks.** ComfyUI does NOT read a `COMFYUI_OUTPUT_DIRECTORY` env var. `extra_model_paths.yaml` redirects only *model* directories (checkpoints, loras, vae) — not the output directory. Symlinks fail on Windows without elevation and interact poorly with PR 1.23's git auto-commit. The CLI flag is the upstream's stable, documented API for exactly this use case.

**Why `os8_capabilities: []` rather than `blob.readwrite`.** ComfyUI writes to `BLOB_DIR` via its own `os.path` filesystem calls (redirected by the CLI flags above), NOT via `window.os8.blob.*` calls. The `os8_capabilities` field declares the scoped HTTP API surface the app's *web frontend* may call from `<slug>.localhost:8888/_os8/api/*` — ComfyUI's frontend doesn't call those. The trust model is unchanged: the runtime adapter's sanitized env (PR 1.10) sets `OS8_BLOB_DIR`, the start argv passes that path to ComfyUI, and the OS process can write to that directory because it owns it (file-system permissions, not capability gating). Capability gating is for the *cross-origin HTTP* surface, which ComfyUI doesn't use.

**The `{{BLOB_DIR}}` template variable.** Spec §3.2 lists `{{BLOB_DIR}}` (Absolute path to `~/os8/blob/<id>/`) as a valid argv substitution. The Python adapter's `_substitutePlaceholders` (PR 2.1) substitutes from `sanitizedEnv.OS8_BLOB_DIR` — same wiring as the Node adapter. Tests in `tests/runtime-adapters/python.test.js` should include a fixture asserting `{{BLOB_DIR}}` substitution lands the right absolute path.

### OpenWebUI manifest (gated behind PR 2.5)

Verified at audit time:
- **Repo:** `open-webui/open-webui`
- **Latest stable:** `v0.9.2`
- **License:** "Other" (BSD-3-Clause-Clear, per repo LICENSE file at audit)
- **Architecture:** **hybrid Python (FastAPI backend) + SvelteKit frontend.** The frontend is built into the backend's static-files dir during install. A single Python process serves both.
- **Build system:** `pyproject.toml` (uv) for backend; `package.json` (npm) for frontend. Build = `npm install && npm run build && uv sync`.
- **Default port:** 8080.
- **Recommended runtime:** **Docker.** OpenWebUI's official install path is `docker run -d -p 3000:8080 ghcr.io/open-webui/open-webui:main` — and the upstream Dockerfile is the canonical install method.

OpenWebUI as a Verified-channel **`runtime.kind: python`** manifest is feasible but exercises the full hybrid build path (npm + uv). For PR 2.4's seed, **OpenWebUI ships as `runtime.kind: docker` (pulled image, not built locally)** — much smaller install surface, much higher reliability. PR 2.5 ships the Docker adapter; PR 2.4's OpenWebUI manifest is gated behind 2.5.

```yaml
# apps/openwebui/manifest.yaml
schemaVersion: 2                  # PR 2.5 introduces v2 schema for docker runtime
slug: openwebui
name: "Open WebUI"
publisher: open-webui
icon: ./icon.png
screenshots: [./screenshots/01.png, ./screenshots/02.png]
category: ai-experiments
description: "User-friendly AI Interface (Supports Ollama, OpenAI API, ...)."

upstream:
  git: https://github.com/open-webui/open-webui.git
  ref: v0.9.2

# No framework — runtime.kind: docker pulls a published image.

runtime:
  kind: docker
  version: "1"                    # docker engine major required
  arch: [arm64, x86_64]
  image: "ghcr.io/open-webui/open-webui:v0.9.2"   # NEW v2 field, pinned
  image_digest: "sha256:<resolved-at-sync>"        # NEW v2 field, set by sync
  internal_port: 8080             # what the container exposes

env:
  - name: WEBUI_AUTH
    value: "false"
    description: "Disable login UI (single-user OS8 install)"

start:
  # No argv needed for docker — adapter generates `docker run -d -p host:internal …`.
  argv: []
  port: detect
  readiness:
    type: http
    path: /health
    timeout_seconds: 60

surface:
  kind: web
  preview_name: "Open WebUI"

dev:
  hmr: none
  editable: false                 # docker image is opaque; no source edit

permissions:
  network: { outbound: true, inbound: false }
  filesystem: app-private
  os8_capabilities: []
  secrets: []

resources:
  memory_limit_mb: 4096
  gpu: optional
  disk_mb: 8000

legal:
  license: BSD-3-Clause-Clear
  commercial_use: unrestricted

review:
  channel: verified
  reviewed_at: 2026-04-29
  reviewer: os8-curators
  risk: medium
```

The `runtime.image_digest` is resolved by the catalog sync job (Phase 0 PR 0.8 + a new "resolve docker digest" step in PR 2.5's CI workflow extension): when the manifest declares `image: ghcr.io/...:v0.9.2`, sync calls `docker manifest inspect ghcr.io/...:v0.9.2` (or the registry's HTTP API) and stores the resulting digest. Install always pulls **by digest**, never by tag — same supply-chain hygiene as `upstream_resolved_commit` for Git refs.

### Static demo manifest

```yaml
# apps/hello-static/manifest.yaml
schemaVersion: 1
slug: hello-static
name: "Hello Static"
publisher: os8-curators
icon: ./icon.png
screenshots: [./screenshots/01.png]
category: dev-tools
description: "Trivial static-HTML app — proves the static runtime."

upstream:
  git: https://github.com/os8ai/hello-static.git
  ref: v1.0.0
framework: none
runtime: { kind: static, version: "0", arch: [arm64, x86_64] }
install: []
start:
  argv: ["os8:static", "--dir", "."]
  port: detect
  readiness: { type: http, path: /, timeout_seconds: 5 }
surface: { kind: web, preview_name: "Hello Static" }
permissions:
  network: { outbound: false, inbound: false }
  filesystem: app-private
  os8_capabilities: []
  secrets: []
legal: { license: MIT, commercial_use: unrestricted }
review: { channel: verified, risk: low }
```

### IPC + routes

None new. All paths flow through the existing install pipeline.

### Test fixtures

The "test fixtures" for Phase 2 manifests live in `tests/fixtures/streamlit-smoke/` and `tests/fixtures/gradio-smoke/` (already covered in PR 2.2). PR 2.4's catalog manifests are tested by Phase 0's `validate.yml` + `resolve-refs.yml` + `lockfile-gate.yml` workflows — same as worldmonitor in Phase 0.

### Acceptance criteria

- All 5 manifests pass catalog CI (PR 0.2 + 0.3 + 0.4).
- Each demo manifest installs end-to-end via `POST /api/app-store/install` (after Phase 1's pipeline + the relevant Phase 2 adapter merges).
- ComfyUI installs and renders its graph UI at `comfyui.localhost:8888/` (CPU-only; GPU optional). Generated outputs land under `~/os8/blob/<id>/`.
- OpenWebUI launches at `openwebui.localhost:8888/` (after PR 2.5).
- `hello-static` renders its `index.html` at `hello-static.localhost:8888/`.

### Cross-platform notes

- ComfyUI's PyTorch wheels exist for arm64 macOS (MPS) and arm64 Linux (CPU); Windows arm64 is rough — Verified manifest declares `arch: [arm64, x86_64]` to match where it's stable.
- OpenWebUI Docker image: `ghcr.io/open-webui/open-webui:v0.9.2` is multi-arch (linux/amd64 + linux/arm64). Install surfaces a clear error on Windows when Docker Desktop isn't installed (handled in PR 2.5's `ensureAvailable`).

### Spec deviations

- **`runtime.image` and `runtime.image_digest` are new schema v2 fields** introduced by PR 2.5.
- **`framework: none` + `runtime.kind: docker`** are the canonical OpenWebUI shape — `framework` doesn't apply to Docker apps.

### Depends on

PR 2.1 (Streamlit, Gradio, ComfyUI installs), PR 2.2 (Streamlit gate; gates Streamlit + Gradio + ComfyUI manifests), PR 2.3 (hello-static install), PR 2.5 (OpenWebUI install + schema bump).

### Open sub-questions

1. **OpenWebUI as `python` manifest instead of `docker`?** Could ship a hybrid-build path (`npm install && npm run build && uv sync`). Higher install reliability via Docker; higher edit-ability via Python. **Recommendation:** ship docker first (PR 2.4), maintain a community-channel `openwebui-source` manifest for users who want editability — defer to Phase 3 community channel.

---

## PR 2.5 — `docker` runtime adapter + `appspec-v2.json` schema bump

**Goal.** Implement the `RuntimeAdapter` interface for `runtime.kind: docker`. Detect Docker availability; surface a clean install hint when missing. Spawn containers via the `docker` CLI (no `dockerode` SDK — see rationale). Wire the OpenWebUI install path. **Bump the manifest schema to v2** to un-reject `docker` and add `runtime.image` + `runtime.image_digest`.

### Files

- **Create:** `/home/leo/Claude/os8/src/services/runtime-adapters/docker.js`
- **Modify:** `/home/leo/Claude/os8/src/services/runtime-adapters/index.js` — `register(require('./docker'))`
- **Create:** `/home/leo/Claude/os8/src/data/appspec-v2.json` — v2 schema (extends v1)
- **Modify:** `/home/leo/Claude/os8/src/services/manifest-validator.js` — dispatch on `manifest.schemaVersion ∈ {1, 2}`
- **Modify:** `/home/leo/Claude/os8/src/services/app-review.js` — Docker-aware static checks (no curl|sh test on argv since there is no install argv; image-digest pin check)
- **Modify:** `/home/leo/Claude/os8/src/renderer/install-plan-modal.js` — surface "Docker not installed — see install guide" when `_runStaticChecks` returns the `docker_unavailable` finding (PR 1.17's findings panel handles this generically)
- **In the catalog repo:** `os8ai/os8-catalog/schema/appspec-v2.json`, plus extend `validate.yml` (PR 0.2) to dispatch on `schemaVersion`. Catalog-side change documented; desktop file is byte-identical.

### `appspec-v2.json` (delta from v1)

Schema v2 extends v1 by:
1. `runtime.kind` enum gains `"docker"`.
2. New optional fields under `runtime` when `kind === 'docker'`: `image` (required when docker), `image_digest` (set by sync), `internal_port` (required when docker), `gpu_passthrough` (boolean, default false).
3. `runtime.version` for docker means "Docker Engine major version" (informational).
4. `framework`, `package_manager`, `dependency_strategy`, `install`, `postInstall`, `preStart`, `dev.hmr`, `dev.watch`, `dev.editable` all become **optional** when `kind === 'docker'` (they don't apply).

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://os8.ai/schema/appspec-v2.json",
  "title": "OS8 AppSpec v2",
  "allOf": [
    { "$ref": "https://os8.ai/schema/appspec-v1.json" }
  ],
  "type": "object",
  "properties": {
    "schemaVersion": { "const": 2 },
    "runtime": {
      "type": "object",
      "properties": {
        "kind":           { "enum": ["node", "python", "static", "docker"] },
        "image":          { "type": "string", "pattern": "^[a-z0-9.-]+(\\.[a-z0-9.-]+)*(/[a-z0-9_.-]+)+(:[A-Za-z0-9_.-]+)?$" },
        "image_digest":   { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" },
        "internal_port":  { "type": "integer", "minimum": 1, "maximum": 65535 },
        "gpu_passthrough":{ "type": "boolean", "default": false }
      },
      "if":   { "properties": { "kind": { "const": "docker" } } },
      "then": { "required": ["kind", "version", "image", "internal_port"] }
    }
  }
}
```

The `allOf: [{ $ref: appspec-v1 }]` inheritance keeps every v1 invariant (slug regex, surface=web, filesystem=app-private, secrets shape, …). v2 only differs in the runtime branch.

### `manifest-validator.js` dispatch

```js
// /home/leo/Claude/os8/src/services/manifest-validator.js — extension
const SCHEMA_V1 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'appspec-v1.json'), 'utf8'));
const SCHEMA_V2 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'appspec-v2.json'), 'utf8'));
ajv.addSchema(SCHEMA_V1, SCHEMA_V1.$id);
const validateV1 = ajv.compile(SCHEMA_V1);
const validateV2 = ajv.compile(SCHEMA_V2);

function pickValidator(manifest) {
  return manifest?.schemaVersion === 2 ? validateV2 : validateV1;
}

// In validateManifest(...):
const validate = pickValidator(manifest);
if (!validate(manifest)) { /* errors */ }
```

The existing v1 invariant block stays in place but only applies when `schemaVersion === 1`. The "docker rejected" check moves to a v1-only branch:
```js
if (manifest?.schemaVersion === 1 && manifest?.runtime?.kind === 'docker') {
  errors.push({ kind: 'invariant', path: '/runtime/kind',
                message: 'docker runtime requires schemaVersion: 2' });
}
```

### Docker adapter shape

```js
// /home/leo/Claude/os8/src/services/runtime-adapters/docker.js
const { spawn } = require('node:child_process');
const path = require('path');
const { APPS_DIR, BLOB_DIR } = require('../../config');

const DockerRuntimeAdapter = {
  kind: 'docker',

  async ensureAvailable(spec) {
    // `docker info` returns 0 only when the daemon is reachable.
    try {
      await runCmd('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 5000 });
    } catch {
      const err = new Error(
        'Docker is not installed or the daemon is not running. ' +
        'Install Docker Desktop (https://docs.docker.com/get-docker/) and try again.'
      );
      err.code = 'docker_unavailable';
      throw err;
    }
    if (spec.runtime.gpu_passthrough) {
      // Detect nvidia-container-toolkit: `docker info` lists Runtimes.
      const { stdout } = await runCmd('docker', ['info', '--format', '{{json .Runtimes}}'], { timeout: 5000 });
      if (!/nvidia/i.test(stdout)) {
        throw new Error(
          'Manifest declares gpu_passthrough but nvidia-container-toolkit is not installed. ' +
          'See https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html'
        );
      }
    }
  },

  detectPackageManager(_appDir, _hint) { return 'docker'; },   // sentinel

  async install(spec, _appDir, sanitizedEnv, onLog) {
    // No filesystem clone for docker apps — staging clone is the manifest only.
    // Pull the image (by digest if available, else by tag).
    const imageRef = spec.runtime.image_digest
      ? `${spec.runtime.image.split(':')[0]}@${spec.runtime.image_digest}`
      : spec.runtime.image;
    await this._spawn(['docker', 'pull', imageRef], { onLog });
  },

  async start(spec, appDir, sanitizedEnv, onLog) {
    const imageRef = spec.runtime.image_digest
      ? `${spec.runtime.image.split(':')[0]}@${spec.runtime.image_digest}`
      : spec.runtime.image;

    const containerName = `os8-app-${sanitizedEnv.OS8_APP_ID}`;
    // Idempotent: if a stale container with this name exists, remove it.
    await runCmd('docker', ['rm', '-f', containerName], { timeout: 10_000 }).catch(() => {});

    const args = [
      'run', '-d',
      '--name', containerName,
      '-p', `127.0.0.1:${sanitizedEnv.PORT}:${spec.runtime.internal_port}`,
      '--mount', `type=bind,source=${path.join(APPS_DIR, sanitizedEnv.OS8_APP_ID)},target=/app`,
      '--mount', `type=bind,source=${path.join(BLOB_DIR, sanitizedEnv.OS8_APP_ID)},target=/data`,
      '--restart', 'no',
    ];
    // GPU passthrough.
    if (spec.runtime.gpu_passthrough) args.push('--gpus', 'all');
    // Sanitized env → -e KEY=VALUE for each. PORT inside the container = internal_port.
    const containerEnv = { ...sanitizedEnv, PORT: String(spec.runtime.internal_port) };
    for (const [k, v] of Object.entries(containerEnv)) {
      // Skip OS8_APP_DIR / OS8_BLOB_DIR — inside the container they're /app and /data.
      if (k === 'OS8_APP_DIR') args.push('-e', `OS8_APP_DIR=/app`);
      else if (k === 'OS8_BLOB_DIR') args.push('-e', `OS8_BLOB_DIR=/data`);
      else args.push('-e', `${k}=${v}`);
    }
    args.push(imageRef);

    const { stdout } = await runCmd('docker', args, { onLog, timeout: 60_000 });
    const containerId = stdout.trim();

    // Stream container logs to onLog (mirrors stdout from a normal child).
    const tail = spawn('docker', ['logs', '-f', containerId], { shell: false });
    tail.stdout.on('data', d => onLog?.('stdout', d.toString()));
    tail.stderr.on('data', d => onLog?.('stderr', d.toString()));

    const ready = this._waitReady(spec, sanitizedEnv);   // http on 127.0.0.1:host_port
    return {
      pid: null,                                         // no pid — container has its own pid 1
      port: parseInt(sanitizedEnv.PORT, 10),
      ready,
      _kind: 'docker',
      _containerId: containerId,
      _containerName: containerName,
      _logTail: tail,
    };
  },

  async stop(processInfo) {
    if (processInfo._kind !== 'docker') return;
    try { processInfo._logTail?.kill('SIGTERM'); } catch {}
    await runCmd('docker', ['stop', '--time', '5', processInfo._containerName], { timeout: 15_000 }).catch(() => {});
    await runCmd('docker', ['rm',                        processInfo._containerName], { timeout: 10_000 }).catch(() => {});
  },

  watchFiles(_spec, _appDir, _onChange) { return () => {}; },   // no-op for docker (image is opaque)

  async detectVersion(spec, _appDir) {
    return spec.runtime.image_digest || spec.runtime.image;
  },

  async _waitReady(spec, env) {
    const probe = spec.start.readiness || { type: 'http', path: '/' };
    const timeoutMs = (probe.timeout_seconds ?? 60) * 1000;
    const deadline = Date.now() + timeoutMs;
    const url = `http://127.0.0.1:${env.PORT}${probe.path || '/'}`;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(1000) });
        if (r.status >= 200 && r.status < 500) return;
      } catch {}
      await sleep(500);
    }
    throw new Error(`docker readiness http timeout: ${url}`);
  },
};
```

### Why the `docker` CLI, not `dockerode`

- **Trust:** the user has already trusted `docker` on their system. Adding a 2.5MB Node SDK that ships its own gRPC client is more attack surface for no gain — the CLI is the canonical interface.
- **Cross-platform parity:** `dockerode` requires the daemon socket (`/var/run/docker.sock` POSIX, `\\.\pipe\docker_engine` Windows). The CLI handles platform plumbing.
- **Phase 1 pattern parity:** Node adapter (PR 1.11) shells out to `npm`/`pnpm`/`git`. Python adapter (PR 2.1) shells out to `uv`/`poetry`. Docker fits the same model.

### Install pipeline integration (PR 1.16's `_installPostApproval`)

For `runtime.kind: docker`:
1. **Skip the git clone step entirely** in PR 1.5's flow when `manifest.runtime.kind === 'docker'`. The manifest's upstream is for documentation/license attribution; the binary artifact is the image. PR 1.5's clone is gated on a check; clarify in PR 2.5's plan: extend `app-installer.js` `_run` to skip cloning when kind is docker, transition straight from `pending → reviewing` (review the manifest, image-digest pin, etc.).
2. **`apps_staging/<jobId>/`** still gets created (so `staging_dir` is non-null on the job row); it stays empty for docker apps (no source).
3. **`atomicMove(staging, ~/os8/apps/<id>)`** still runs — moves an empty dir. The blob dir at `~/os8/blob/<id>/` is mounted into the container as `/data`.
4. **No git init / no fork-on-first-edit** for docker apps. Manifest declares `dev.editable: false`.

These pipeline tweaks are minor and mostly conditional on `runtime.kind === 'docker'` — extend PR 1.16's `_runApprove` with the dispatch.

### Review-service additions (`app-review.js`)

```js
// PR 2.5 extension to _runStaticChecks when manifest.schemaVersion === 2
//                                       && manifest.runtime.kind === 'docker':

// 1. Image must be pinned by digest (Verified channel).
if (channel === 'verified' && !manifest.runtime.image_digest) {
  findings.push({
    severity: 'critical', category: 'supply_chain',
    file: null, line: null,
    description: 'verified channel: docker manifest must pin image by digest (image_digest field)',
    snippet: '',
  });
}
// 2. image must NOT use `:latest` even when digest is present (defense-in-depth).
if (manifest.runtime.image && /:latest$/.test(manifest.runtime.image)) {
  findings.push({
    severity: 'warning', category: 'supply_chain',
    file: null, line: null,
    description: 'docker image tag :latest discouraged — pin to a versioned tag',
    snippet: manifest.runtime.image,
  });
}
// 3. internal_port must be 1024-65535 (no privileged ports).
if (manifest.runtime.internal_port < 1024) {
  findings.push({
    severity: 'critical', category: 'other',
    file: null, line: null,
    description: `internal_port ${manifest.runtime.internal_port} is privileged; use ≥1024`,
    snippet: '',
  });
}
```

### IPC + routes

None new. Install pipeline + launch path are runtime-blind (dispatch by adapter kind).

### Test fixtures

`tests/runtime-adapters/docker.test.js`:

| Fixture | Assertion |
|---|---|
| Manifest with `image: nginx:alpine` (small public image) | `install` runs `docker pull`; `start` returns `{ port, ready, _containerId }`; `fetch http://127.0.0.1:port/` returns nginx welcome |
| Manifest with `image_digest: sha256:abc...` | `install` runs `docker pull image@sha256:...` |
| `docker info` mocked to fail | `ensureAvailable` throws with `code: 'docker_unavailable'`; install plan UI surfaces the install hint |
| `gpu_passthrough: true` on a host without nvidia runtime | `ensureAvailable` throws clear error |
| `stop` after `start` | `docker ps -aq` shows no `os8-app-<id>` container |

Smoke test on a real installable manifest:

`tests/e2e/openwebui-docker-smoke.test.js` (manual, optional in CI): pulls + starts OpenWebUI, asserts `/health` returns 200 within 60s, tears down. Skipped on CI runners without Docker.

### Acceptance criteria

- A docker-runtime manifest installs end-to-end. `docker ps` shows a running `os8-app-<id>` container.
- The container's port is mapped to `127.0.0.1:<host_port>`; `<slug>.localhost:8888/` proxies to it.
- Stopping the app (close tab + idle reap, or `POST /api/apps/:id/processes/stop`) calls `docker stop` + `docker rm`.
- `docker info` failing surfaces a clean error in the install plan modal with a link to docker.com/get-docker.
- `appspec-v2.json` validates OpenWebUI's manifest; the v1 schema rejects it (correct).

### Cross-platform notes

- **macOS:** Docker Desktop required. `--gpus all` does not work (Docker Desktop's Linux VM doesn't pass through host GPUs). Manifest's `gpu_passthrough: true` should declare `arch: [x86_64, arm64]` minus macOS; reviewer flags as warning if Mac-incompatible.
- **Linux:** native Docker daemon. `--gpus all` requires `nvidia-container-toolkit`.
- **Windows:** Docker Desktop required. `--gpus all` requires WSL2 + nvidia-container-toolkit on the WSL side.
- **Bind mounts on Windows:** `C:\Users\<u>\os8\apps\<id>` translates to `/c/Users/<u>/os8/apps/<id>` inside the container. The adapter passes the absolute path verbatim; Docker Desktop's path translation handles it.

### Spec deviations

- **Schema bump to v2** (vs spec §3.5's "v1 rejects docker"). Plan §10 is silent on this — Phase 2's mandate is to enable docker. Bumping schemaVersion is the cleaner option vs back-patching v1.
- **No git clone for docker manifests.** PR 1.5's state machine accommodates by short-circuiting when kind is docker. Document in updated `phase-1-plan.md` (PR 1.16 cross-reference, ideally as a follow-up doc PR).
- **No `dockerode` dep.** Spec §6.1 is silent; this is an implementation choice, justified above.

### Depends on

PR 1.11a (interface), PR 1.16 (pipeline; needs the docker-aware short-circuit), PR 1.6 (review service to extend). Independent of PR 2.1, 2.2, 2.3.

### Open sub-questions

None. (`gpu_passthrough` granularity — `--gpus all` vs specific device — deferred to Phase 3 if a manifest needs `--gpus device=0`.)

---

## PR 2.6 — Folded into PR 2.5

**Plan §4 lists PR 2.6 as "Docker fallback for apps needing system packages (CUDA, ffmpeg)."** This is not a separate runtime — it's the natural use case of `runtime.kind: docker`. PR 2.5 ships the runtime; PR 2.4 ships an OpenWebUI manifest as the canonical example. A follow-up catalog PR can add e.g. a Whisper-WebUI manifest using the same docker shape — that's catalog work, not adapter work.

**No code in PR 2.6.** Listed in the index for plan-tracking parity.

---

## 4. Phase 2 acceptance criteria

The following observable outcomes prove Phase 2 ships:

1. **Python apps install and run.** Streamlit-hello and Gradio-hello catalog manifests install via `POST /api/app-store/install` → review → approve → start. Pages render at `<slug>.localhost:8888/`.
2. **Streamlit WS gates 2.4's Python catalog seed.** PR 2.2's smoke test passes on macOS + Linux; the `/_stcore/stream` WebSocket survives the proxy; live re-render works.
3. **ComfyUI runs.** Real-world Python manifest installs (cold-start ≤ 2 min on warm pip cache + warm uv cache); CPU-only mode renders the graph UI; outputs land under `~/os8/blob/<id>/`.
4. **Static apps install and serve.** `hello-static` renders its `index.html` at `hello-static.localhost:8888/` via OS8's `express.static` middleware. Trust isolation parity with proxied apps preserved.
5. **OpenWebUI runs as a docker app.** Pulls `ghcr.io/open-webui/open-webui:v0.9.2` by digest; container exposes port 8080; `openwebui.localhost:8888/` proxies to it; `/health` returns 200.
6. **`appspec-v2.json` is the canonical schema for docker manifests.** Catalog CI dispatches on `schemaVersion`; desktop validator dispatches identically. v1 manifests are unchanged.
7. **Five new manifests are live in `os8ai/os8-catalog`** (Streamlit demo, Gradio demo, ComfyUI, OpenWebUI, hello-static), pinned to immutable SHAs (or image digests for docker).

### What flows into Phase 3

- **Developer Import (Phase 3 PR 3.1)** auto-detects framework + runtime from upstream files. Phase 2's framework-defaults table (Streamlit, Gradio, Hugo, Jekyll, plus Phase 1's Vite, Next, SvelteKit, Astro) is the lookup target. PR 3.1 adds `dockerfile_present → runtime.kind: docker` heuristic.
- **Community channel manifests** can declare `runtime.kind: python | docker | static` immediately. Phase 3 PR 3.3 (`os8ai/os8-catalog-community` repo) reuses Phase 2's schema unchanged.
- **Supply-chain analyzer (PR 3.6)** plugs into `app-review.js`'s `_runStaticAnalysis` Python branch added in PR 2.1 (replaces the v1 stub `scanPythonDeps` with `safety` / `osv-scanner` calls).
- **Resource enforcement (deferred per spec §11):** `resources.gpu: required` already routes to PR 2.5's `gpu_passthrough` flag; `resources.memory_limit_mb` becomes Docker's `--memory` flag when enforcement lands.

### What does **not** carry forward

- Pipenv (`Pipfile.lock`) is not supported in v1; Phase 3 may revisit if a real manifest needs it.
- Yarn-on-Python doesn't exist; no analogue.
- The `os8:static` argv sentinel is a Phase 2 convention; Phase 3 may add a more general "no-process" runtime kind if multiple no-process patterns emerge (PWAs, single HTML files).

---

## 5. Decisions log (Phase 2)

| # | Decision | Resolved in |
|---|---|---|
| 1 | uv install path: download from astral.sh GitHub releases to `~/os8/bin/uv` with SHA-256 verification; fall back to host `uv` if present | PR 2.1 |
| 2 | Python lockfile precedence: `uv.lock > poetry.lock > requirements.txt` | PR 2.1 |
| 3 | Pipenv (`Pipfile.lock`) not supported in v1 | PR 2.1 |
| 4 | Poetry not auto-installed; verified-channel python manifests prefer uv | PR 2.1 |
| 5 | Streamlit framework defaults inject `--server.enableCORS=false --server.enableXsrfProtection=false --server.headless=true` | PR 2.2 |
| 6 | Gradio uses chokidar watcher restart (not Gradio's `--reload` CLI) under `dev.hmr: watcher` | PR 2.2 |
| 7 | Phase 2 GATE = Streamlit-through-proxy smoke test | PR 2.2 |
| 8 | Static-runtime trust-boundary parity: own subdomain via OS8's `express.static` middleware (Option A) | PR 2.3 |
| 9 | `os8:static` argv sentinel triggers OS8-served path (no spawn) | PR 2.3 |
| 10 | Jekyll is community-channel only in v1 (Ruby/Bundler not auto-installed) | PR 2.3 |
| 11 | OpenWebUI ships as `runtime.kind: docker` (not python hybrid build) | PR 2.4 |
| 12 | ComfyUI catalog app coexists with launcher-managed ComfyUI on different ports | PR 2.4 |
| 13 | Schema bump to `appspec-v2.json` for `runtime.kind: docker` (vs back-patch v1) | PR 2.5 |
| 14 | Docker via CLI (`child_process.spawn('docker', ...)`); no `dockerode` SDK dep | PR 2.5 |
| 15 | Docker images pinned by digest; `:latest` produces a warning finding | PR 2.5 |
| 16 | Container lifecycle through `AppProcessRegistry` unchanged: `start` returns `{ port, ready }`; `stop` does `docker stop` + `docker rm` | PR 2.5 |
| 17 | PR 2.6 folded into PR 2.5 (no separate adapter; the use-case is just `runtime.kind: docker` for system-package needs) | (this doc) |
| 18 | ComfyUI output redirection → use upstream's CLI flags (`--output-directory {{BLOB_DIR}} --input-directory {{BLOB_DIR}}/inputs --user-directory {{BLOB_DIR}}/user`) in `start.argv`. Verified in ComfyUI v0.20.1 `main.py:104-127`. No env var, no `extra_model_paths.yaml` (which only redirects model paths), no symlink (Windows-hostile). Establishes the v1 pattern for Python catalog apps that do their own filesystem I/O. | PR 2.4 (ComfyUI manifest); cross-references app-store-plan §10 decision 12 (two paths to per-app blob storage) |

---

*End of plan.*
