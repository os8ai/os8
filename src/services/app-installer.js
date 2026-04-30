/**
 * AppInstaller — the orchestrator that drives the install state machine.
 *
 * Spec §6.2.1 + plan §3 PR 1.5. PR 1.5 ships:
 *   - clone the upstream repo (no install commands run)
 *   - HEAD-SHA verification
 *   - state machine: pending → cloning → reviewing → awaiting_approval
 *   - review hook (PR 1.6 plugs in AppReviewService)
 *
 * PR 1.16 fills in `awaiting_approval → installing → installed | failed`,
 * including atomic staging→apps move + apps row insert + secrets save.
 *
 * Subscribers ride a tiny pub/sub keyed by jobId so the SSE log stream
 * (routes/app-store.js) and the install-plan modal (PR 1.17) can reflect
 * progress in real time.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('node:child_process');
const { APPS_STAGING_DIR } = require('../config');
const InstallJobs = require('./app-install-jobs');
const AppCatalogService = require('./app-catalog');

// --- pub/sub for job updates -------------------------------------------------

const _subscribers = new Map();   // jobId -> Set<fn>

function subscribe(jobId, fn) {
  if (!_subscribers.has(jobId)) _subscribers.set(jobId, new Set());
  _subscribers.get(jobId).add(fn);
  return () => {
    const set = _subscribers.get(jobId);
    if (!set) return;
    set.delete(fn);
    if (set.size === 0) _subscribers.delete(jobId);
  };
}

function publish(jobId, event) {
  const set = _subscribers.get(jobId);
  if (!set) return;
  for (const fn of set) {
    try { fn(event); } catch (_) { /* subscriber failures shouldn't break the install */ }
  }
}

// --- spawn helpers (no shell strings) ----------------------------------------

function spawnPromise(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const err = new Error(`${cmd} ${args.join(' ')} exited ${code}: ${stderr.trim().slice(-500)}`);
        err.code = code;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

async function gitClone(gitUrl, commit, dir) {
  // Fast path — git ≥2.5 supports --branch <40-char SHA> when the upstream
  // allows uploadpack of arbitrary SHAs (default on github.com).
  try {
    await spawnPromise('git',
      ['clone', '--depth', '1', '--branch', commit, gitUrl, dir]);
    return;
  } catch (e) {
    // The upstream rejected fetching by SHA, OR the ref isn't reachable from
    // the default branch as a 1-deep clone. Fall back: shallow init, fetch
    // the specific SHA, checkout. Slightly more network round-trips but works
    // against any halfway-modern git server.
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    await spawnPromise('git', ['-C', dir, 'init']);
    await spawnPromise('git', ['-C', dir, 'remote', 'add', 'origin', gitUrl]);
    await spawnPromise('git', ['-C', dir, 'fetch', '--depth', '1', 'origin', commit]);
    await spawnPromise('git', ['-C', dir, 'checkout', '--detach', 'FETCH_HEAD']);
  }
}

async function gitHead(dir) {
  const { stdout } = await spawnPromise('git', ['-C', dir, 'rev-parse', 'HEAD']);
  return stdout.trim();
}

// --- the orchestrator --------------------------------------------------------

const AppInstaller = {
  // Test/PR 1.6 hook — PR 1.6 sets this to AppReviewService.review.
  // Must accept (db, stagingDir, manifest) → Promise<reviewReport>.
  _review: null,

  // Test/PR 1.16 hook — PR 1.16 sets this to the install pipeline.
  _installPostApproval: null,

  subscribe,

  /**
   * POST /api/app-store/install entry point. Returns immediately with the
   * pending row; the heavy lifting runs async in `_run`.
   */
  async start(db, { slug, commit, channel, secrets = {}, source = 'manual' }) {
    const job = InstallJobs.create(db, {
      externalSlug: slug,
      upstreamResolvedCommit: commit,
      channel,
    });
    setImmediate(() => AppInstaller._run(db, job.id, { secrets, source })
      .catch(err => {
        InstallJobs.fail(db, job.id, err.message);
        publish(job.id, { kind: 'failed', message: err.message });
      })
    );
    return job;
  },

  /**
   * The state-machine driver. Each `transition` call atomically advances the
   * row, and we publish progress events between them so subscribers see the
   * intermediate states.
   */
  async _run(db, jobId, { secrets: _secrets, source: _source }) {
    let job = InstallJobs.transition(db, jobId, { from: 'pending', to: 'cloning' });
    publish(jobId, { kind: 'status', status: 'cloning', job });

    // 1. Resolve manifest from local catalog.
    const entry = await AppCatalogService.get(db, job.external_slug, { channel: job.channel });
    if (!entry) {
      throw new Error(`app '${job.external_slug}' not in local catalog (run sync first)`);
    }
    if (entry.upstreamResolvedCommit !== job.upstream_resolved_commit) {
      throw new Error(
        `commit mismatch — catalog has ${entry.upstreamResolvedCommit}, requested ${job.upstream_resolved_commit}`
      );
    }
    if (!entry.manifest?.upstream?.git) {
      throw new Error(`catalog row for ${job.external_slug} lacks upstream.git`);
    }

    // 2. Clone into staging.
    const stagingDir = path.join(APPS_STAGING_DIR, jobId);
    if (fs.existsSync(stagingDir)) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
    fs.mkdirSync(stagingDir, { recursive: true });
    publish(jobId, { kind: 'log', message: `cloning ${entry.manifest.upstream.git}@${job.upstream_resolved_commit}` });
    await gitClone(entry.manifest.upstream.git, job.upstream_resolved_commit, stagingDir);

    // 3. Verify HEAD matches the declared commit (defense against ref drift).
    const headSha = await gitHead(stagingDir);
    if (headSha !== job.upstream_resolved_commit) {
      throw new Error(`HEAD ${headSha} != declared ${job.upstream_resolved_commit}`);
    }

    job = InstallJobs.transition(db, jobId, {
      from: 'cloning',
      to: 'reviewing',
      patches: { staging_dir: stagingDir },
    });
    publish(jobId, { kind: 'status', status: 'reviewing', job });

    // 4. Run security review. PR 1.6 plugs in AppReviewService; PR 1.5 ships
    //    a stub so the state machine still advances.
    const reviewReport = AppInstaller._review
      ? await AppInstaller._review(db, stagingDir, entry.manifest)
      : {
          riskLevel: 'unknown',
          findings: [],
          summary: 'review service not yet wired (PR 1.5 stub — PR 1.6 plugs in)',
        };

    job = InstallJobs.transition(db, jobId, {
      from: 'reviewing',
      to: 'awaiting_approval',
      patches: { review_report: JSON.stringify(reviewReport) },
    });
    publish(jobId, { kind: 'status', status: 'awaiting_approval', job });

    // PR 1.16 fills in the rest. _installPostApproval, when set, gets called
    // by routes/app-store.js's POST /jobs/:id/approve handler — not here.
  },

  /**
   * Cancel from awaiting_approval. Cleans the staging dir best-effort.
   */
  cancel(db, jobId) {
    const job = InstallJobs.cancel(db, jobId);
    if (job?.staging_dir && fs.existsSync(job.staging_dir)) {
      try { fs.rmSync(job.staging_dir, { recursive: true, force: true }); }
      catch (_) { /* leave for reapStaging (PR 1.29) */ }
    }
    publish(jobId, { kind: 'status', status: 'cancelled', job });
    return job;
  },

  // Test seam — exposed for unit tests that want to bypass setImmediate.
  _runNow(db, jobId, opts) { return AppInstaller._run(db, jobId, opts); },
};

module.exports = AppInstaller;
