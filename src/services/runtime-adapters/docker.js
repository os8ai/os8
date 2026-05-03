/**
 * DockerRuntimeAdapter — installs and runs container-based external apps.
 *
 * Spec §6.2.2 + plan §3 PR 2.5. Schema v2 un-rejects `runtime.kind: docker`
 * and adds `runtime.image`, `runtime.image_digest`, `runtime.internal_port`,
 * `runtime.gpu_passthrough`.
 *
 * Implementation invariants:
 *   - All commands spawn with `shell: false` and argv arrays. Shell out to
 *     the host `docker` CLI (no dockerode SDK — plan §5 decision 14).
 *   - Pull by digest when `runtime.image_digest` is set. Verified-channel
 *     manifests are required to pin by digest.
 *   - Bind mounts: ~/os8/apps/<id> → /app, ~/os8/blob/<id> → /data.
 *     Inside the container, OS8_APP_DIR=/app, OS8_BLOB_DIR=/data.
 *   - Container name: `os8-app-<appId>`. Idempotent: stale containers with
 *     the same name are removed before `docker run`.
 *   - GPU passthrough via `--gpus all` when `runtime.gpu_passthrough: true`.
 *     Only on Linux + nvidia-container-toolkit (verified at ensureAvailable).
 *   - watchFiles is a no-op (the image is opaque). Manifests should declare
 *     `dev.editable: false`.
 */

const { spawn } = require('node:child_process');
const path = require('path');

const { APPS_DIR, BLOB_DIR } = require('../../config');
const { POSIX_WHITELIST, WINDOWS_WHITELIST } = require('../sanitized-env');

// Host env keys that buildSanitizedEnv() inherits for native (node/python)
// adapters but MUST NOT cross into a container — the container has its own
// PATH/HOME/USER/etc. baked into the image. Inheriting host PATH (e.g.
// `/home/leo/.nvm/versions/node/...`) clobbers the image's PATH and the
// container can't find its own `supervisord`/`uwsgi`/`python` etc.
//
// Repro: linkding 1.45.0 smoke (2026-05-03) — container exited with
// `supervisord: command not found` because host PATH was passed through.
//
// We use the union of both whitelists so a Linux-built container that
// happens to receive a Windows host's env (or vice versa under WSL) also
// gets stripped cleanly.
const HOST_ONLY_KEYS = new Set([...POSIX_WHITELIST, ...WINDOWS_WHITELIST]);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function defaultSpawnPromise(argv, opts = {}) {
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

// Test seam — swap _spawnImpl via _internal._setSpawn(fn) to mock the
// docker CLI without actually shelling out.
let _spawnImpl = defaultSpawnPromise;
function spawnPromise(argv, opts) { return _spawnImpl(argv, opts); }

function imageRefFor(spec) {
  // Pull by digest when available; tag fallback for community-channel
  // manifests not yet sync-resolved.
  if (spec?.runtime?.image_digest) {
    const base = (spec.runtime.image || '').split(':')[0];
    return `${base}@${spec.runtime.image_digest}`;
  }
  return spec?.runtime?.image;
}

/**
 * PR 4.1 — compact `docker pull` progress lines into one human-readable
 * line per layer per emission. The default `docker pull` output uses
 * carriage-returns + ANSI cursor moves to overwrite a per-layer status
 * block; once the lines are split on `\n` (after CR collapse in the log
 * buffer) we still see things like:
 *
 *   "abc123def456: Downloading [=====>     ] 12.34MB/45.67MB"
 *   "abc123def456: Pull complete"
 *   "Status: Downloaded newer image for nginx:latest"
 *
 * The first form gets compacted to "abc123def456: Downloading 27% (12.3MB / 45.6MB)";
 * the rest pass through unchanged. Returns the (possibly transformed) line.
 */
function compactDockerPullLine(line) {
  if (typeof line !== 'string') return line;
  // ^<sha 12+>: <Status> [bar] <current><unit>/<total><unit>
  const m = line.match(
    /^([0-9a-f]{12,}):\s*(Downloading|Extracting|Pushing|Verifying|Pulling)\s*(?:\[[^\]]*\])?\s*([\d.]+)\s*([KMGT]?B)\s*\/\s*([\d.]+)\s*([KMGT]?B)/i
  );
  if (!m) return line;
  const [, sha, status, currentNum, currentUnit, totalNum, totalUnit] = m;
  const cur = parseFloat(currentNum);
  const tot = parseFloat(totalNum);
  if (!isFinite(cur) || !isFinite(tot) || tot <= 0) return line;
  // Normalize to bytes for the percentage so "100KB / 1MB" reads correctly.
  const unitToBytes = (n, u) => {
    const factor = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[u.toUpperCase()] || 1;
    return n * factor;
  };
  const pct = Math.round((unitToBytes(cur, currentUnit) / unitToBytes(tot, totalUnit)) * 100);
  return `${sha}: ${status} ${pct}% (${currentNum}${currentUnit} / ${totalNum}${totalUnit})`;
}

const DockerRuntimeAdapter = {
  kind: 'docker',

  // ── Availability ────────────────────────────────────────────────────────────
  async ensureAvailable(spec) {
    try {
      await spawnPromise(['docker', 'info', '--format', '{{.ServerVersion}}'], { timeout: 5000 });
    } catch {
      const err = new Error(
        'Docker is not installed or the daemon is not running. ' +
        'Install Docker Desktop (https://docs.docker.com/get-docker/) and try again.'
      );
      err.code = 'docker_unavailable';
      throw err;
    }
    if (spec?.runtime?.gpu_passthrough) {
      const { stdout } = await spawnPromise(
        ['docker', 'info', '--format', '{{json .Runtimes}}'],
        { timeout: 5000 }
      );
      if (!/nvidia/i.test(stdout)) {
        throw new Error(
          'Manifest declares gpu_passthrough but nvidia-container-toolkit is not installed. ' +
          'See https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html'
        );
      }
    }
  },

  detectPackageManager(_appDir, _hint) { return 'docker'; },     // sentinel

  // ── Install ─────────────────────────────────────────────────────────────────
  async install(spec, _appDir, _sanitizedEnv, onLog) {
    const ref = imageRefFor(spec);
    if (!ref) throw new Error('docker manifest missing runtime.image');
    onLog?.('stdout', `+ docker pull ${ref}\n`);
    // PR 4.1: compact docker pull progress lines (one per layer per emission)
    // before they hit the log buffer. The wrapper preserves stream attribution
    // and only transforms recognizable progress lines; everything else
    // passes through unchanged.
    const compactingOnLog = onLog
      ? (stream, chunk) => {
          if (stream !== 'stdout' && stream !== 'stderr') return onLog(stream, chunk);
          const text = String(chunk);
          // Process line-by-line so we don't mangle multi-line buffers; preserve
          // the trailing newline (if any) so downstream splitting still works.
          const compacted = text.split('\n').map((l, i, arr) => {
            const isLast = i === arr.length - 1;
            // Last element after split may be empty (text ended with \n) — pass through.
            return isLast && l === '' ? l : compactDockerPullLine(l);
          }).join('\n');
          return onLog(stream, compacted);
        }
      : undefined;
    await spawnPromise(['docker', 'pull', ref], { onLog: compactingOnLog, timeout: 600_000 });
  },

  // ── Start ───────────────────────────────────────────────────────────────────
  async start(spec, _appDir, sanitizedEnv, onLog) {
    const ref = imageRefFor(spec);
    if (!ref) throw new Error('docker manifest missing runtime.image');
    if (!spec?.runtime?.internal_port) {
      throw new Error('docker manifest missing runtime.internal_port');
    }

    const appId = sanitizedEnv.OS8_APP_ID;
    if (!appId) throw new Error('docker adapter requires OS8_APP_ID in sanitized env');
    const containerName = `os8-app-${appId}`;

    // Idempotent: nuke any stale container with our name. `docker rm -f` is
    // safe on a non-existent container — exits non-zero, we ignore.
    await spawnPromise(['docker', 'rm', '-f', containerName], { timeout: 10_000 })
      .catch(() => { /* nothing to remove */ });

    const hostPort = parseInt(sanitizedEnv.PORT, 10);
    if (!Number.isFinite(hostPort)) throw new Error('docker adapter: invalid PORT');

    const args = [
      'run', '-d',
      '--name', containerName,
      '-p', `127.0.0.1:${hostPort}:${spec.runtime.internal_port}`,
      '--mount', `type=bind,source=${path.join(APPS_DIR, appId)},target=/app`,
      '--mount', `type=bind,source=${path.join(BLOB_DIR, appId)},target=/data`,
      '--restart', 'no',
    ];
    if (spec.runtime.gpu_passthrough) args.push('--gpus', 'all');

    // Container env: strip the host-OS whitelist (PATH/HOME/USER/...) that
    // buildSanitizedEnv inherits for native adapters; the container has
    // its own. Then layer on PORT (= internal_port) and rewrite
    // OS8_APP_DIR/OS8_BLOB_DIR to the bind targets (host paths don't
    // exist in-container).
    const containerEnv = { ...sanitizedEnv };
    for (const k of HOST_ONLY_KEYS) delete containerEnv[k];
    containerEnv.PORT = String(spec.runtime.internal_port);
    containerEnv.OS8_APP_DIR = '/app';
    containerEnv.OS8_BLOB_DIR = '/data';
    for (const [k, v] of Object.entries(containerEnv)) {
      args.push('-e', `${k}=${v}`);
    }
    args.push(ref);

    onLog?.('stdout', `+ docker ${args.join(' ')}\n`);
    const { stdout } = await spawnPromise(['docker', ...args], { onLog, timeout: 60_000 });
    const containerId = stdout.trim();

    // Stream container logs to onLog (mirrors the stdout/stderr pattern of
    // a normal child). The tail process is killed in stop().
    const tail = spawn('docker', ['logs', '-f', containerId], { shell: false });
    tail.stdout?.on('data', d => onLog?.('stdout', d.toString()));
    tail.stderr?.on('data', d => onLog?.('stderr', d.toString()));
    tail.on('error', () => { /* ignore — container may already be gone */ });

    const ready = this._waitReady(spec, sanitizedEnv);
    return {
      pid: null,                            // no pid — container has its own pid 1
      port: hostPort,
      ready,
      _kind: 'docker',
      _containerId: containerId,
      _containerName: containerName,
      _logTail: tail,
    };
  },

  async _waitReady(spec, env) {
    const probe = spec?.start?.readiness || { type: 'http', path: '/' };
    const timeoutMs = (probe.timeout_seconds ?? 60) * 1000;
    const deadline = Date.now() + timeoutMs;
    if (probe.type !== 'http') {
      // Docker readiness MUST be HTTP — log-regex isn't observable through
      // `docker logs -f` in time-bounded fashion across all images.
      throw new Error('docker readiness: only http probes supported');
    }
    const url = `http://127.0.0.1:${env.PORT}${probe.path || '/'}`;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(1000) });
        if (r.status >= 200 && r.status < 500) return;
      } catch { /* retry */ }
      await sleep(500);
    }
    throw new Error(`docker readiness http timeout: ${url}`);
  },

  // ── Stop ────────────────────────────────────────────────────────────────────
  async stop(processInfo) {
    if (processInfo?._kind !== 'docker') return;
    try { processInfo._logTail?.kill('SIGTERM'); } catch (_) { /* already dead */ }
    if (processInfo._containerName) {
      await spawnPromise(['docker', 'stop', '--time', '5', processInfo._containerName],
        { timeout: 15_000 }).catch(() => { /* already stopped */ });
      await spawnPromise(['docker', 'rm', processInfo._containerName],
        { timeout: 10_000 }).catch(() => { /* already removed */ });
    }
  },

  watchFiles(_spec, _appDir, _onChange) { return () => {}; },     // no-op for docker

  async detectVersion(spec, _appDir) {
    return spec?.runtime?.image_digest || spec?.runtime?.image || null;
  },

  // Test helpers.
  _internal: {
    get spawnPromise() { return _spawnImpl; },
    set spawnPromise(fn) { _spawnImpl = fn; },
    imageRefFor,
    compactDockerPullLine,
    _setSpawn: (fn) => { _spawnImpl = fn; },
    _resetSpawn: () => { _spawnImpl = defaultSpawnPromise; },
  },
};

module.exports = DockerRuntimeAdapter;
