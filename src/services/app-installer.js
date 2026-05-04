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
const dns = require('node:dns');
const { promisify } = require('node:util');
const { spawn } = require('node:child_process');
const { APPS_DIR, APPS_STAGING_DIR } = require('../config');
const InstallJobs = require('./app-install-jobs');
const AppCatalogService = require('./app-catalog');
const InstallEvents = require('./install-events');
const { makeLogBuffer } = require('./install-log-buffer');
const AppTelemetry = require('./app-telemetry');

// PR 4.4: extract a stable framework hint from the manifest. Used by
// telemetry so the os8.ai dashboard can break failures down by framework.
function _resolveFramework(manifest) {
  return manifest?.framework || null;
}
function _resolveAdapterKind(manifest) {
  return manifest?.runtime?.kind || null;
}
function _readLastStderrLine(logPath) {
  if (!logPath) return null;
  try {
    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.trim().split('\n').filter(l => l.startsWith('[stderr] '));
    return lines.length ? lines[lines.length - 1].slice(9) : null;
  } catch {
    return null;
  }
}

const dnsLookup = promisify(dns.lookup);

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
  const payload = { jobId, ...event };
  // Per-job subscribers (SSE log stream).
  const set = _subscribers.get(jobId);
  if (set) {
    for (const fn of set) {
      try { fn(event); } catch (_) { /* subscriber failures shouldn't break the install */ }
    }
  }
  // Global emitter (IPC relays to the renderer).
  try { InstallEvents.emit('job-update', payload); }
  catch (_) { /* never break the install on emitter issues */ }
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

// Lazily-required so the installer module can load without the review
// service in place (early integration tests).
let AppReviewService = null;
function getAppReviewService() {
  if (!AppReviewService) AppReviewService = require('./app-review');
  return AppReviewService;
}

const AppInstaller = {
  // PR 1.6 plug-in. Defaults to a thunk that calls AppReviewService.review;
  // tests override by assigning `_review = null` or a mock.
  _review: async (db, stagingDir, manifest, opts) =>
    getAppReviewService().review(db, stagingDir, manifest, opts),

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
   * Developer Import entry point (PR 3.1). Bypasses the catalog lookup at
   * the top of `_run` by inserting a synthetic `app_catalog` row keyed by
   * `channel='developer-import'` before kicking off `start`. The state
   * machine, review pipeline, and atomic move all behave exactly as for a
   * verified install — only the catalog entry is local-only.
   *
   * The synthetic row uses ON CONFLICT(slug) DO UPDATE so re-importing the
   * same repo at a different commit refreshes the row. Abandoned rows get
   * reaped by `AppCatalogService.reapDeveloperImportOrphans` (24h cutoff)
   * or eagerly on rollback / cancel.
   */
  async startFromManifest(db, { manifest, upstreamResolvedCommit, secrets = {}, source = 'dev-import' } = {}) {
    if (manifest?.review?.channel !== 'developer-import') {
      throw new Error('startFromManifest is only valid for developer-import channel');
    }
    if (!/^[0-9a-f]{40}$/.test(String(upstreamResolvedCommit || ''))) {
      throw new Error('upstreamResolvedCommit must be a 40-char SHA');
    }

    // PR 3.5 — defense-in-depth: refuse Developer Import when the user has
    // disabled the channel in Settings → App Store. The home-screen button
    // is also hidden in that state, but DevTools could still reach this IPC.
    try {
      const SettingsService = require('./settings');
      const enabled = SettingsService.get(db, 'app_store.channel.developer-import.enabled');
      if (enabled === 'false' || enabled === false) {
        throw new Error('Developer Import is disabled in Settings → App Store');
      }
    } catch (e) {
      // Re-throw "disabled" errors verbatim; swallow lookup errors (e.g. test
      // fixtures without the settings table).
      if (/disabled in Settings/.test(e.message)) throw e;
    }

    const yaml = require('js-yaml');
    const crypto = require('crypto');
    const manifestYaml = yaml.dump(manifest);
    const manifestSha = crypto.createHash('sha256').update(manifestYaml).digest('hex');

    db.prepare(`
      INSERT INTO app_catalog (
        id, slug, name, description, publisher, channel, category, icon_url,
        screenshots, manifest_yaml, manifest_sha, catalog_commit_sha,
        upstream_declared_ref, upstream_resolved_commit, license, runtime_kind,
        framework, architectures, risk_level, install_count, rating,
        synced_at, deleted_at
      ) VALUES (
        ?, ?, ?, ?, ?, 'developer-import', ?, NULL,
        '[]', ?, ?, 'dev-import',
        ?, ?, ?, ?,
        ?, ?, 'high', 0, NULL,
        datetime('now'), NULL
      )
      ON CONFLICT(slug) DO UPDATE SET
        manifest_yaml = excluded.manifest_yaml,
        manifest_sha = excluded.manifest_sha,
        upstream_declared_ref = excluded.upstream_declared_ref,
        upstream_resolved_commit = excluded.upstream_resolved_commit,
        synced_at = excluded.synced_at,
        deleted_at = NULL
    `).run(
      `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      manifest.slug,
      manifest.name,
      manifest.description || '',
      manifest.publisher || '',
      manifest.category || 'utilities',
      manifestYaml,
      manifestSha,
      manifest.upstream?.ref || upstreamResolvedCommit,
      upstreamResolvedCommit,
      manifest.legal?.license || 'UNKNOWN',
      manifest.runtime?.kind || 'node',
      manifest.framework || null,
      JSON.stringify(manifest.runtime?.arch || ['arm64', 'x86_64']),
    );

    return AppInstaller.start(db, {
      slug: manifest.slug,
      commit: upstreamResolvedCommit,
      channel: 'developer-import',
      secrets,
      source,
    });
  },

  /**
   * The state-machine driver. Each `transition` call atomically advances the
   * row, and we publish progress events between them so subscribers see the
   * intermediate states.
   */
  async _run(db, jobId, { secrets: _secrets, source: _source }) {
    let job = InstallJobs.transition(db, jobId, { from: 'pending', to: 'cloning' });
    publish(jobId, { kind: 'status', status: 'cloning', job });

    // PR 3.5 — defense-in-depth: refuse community-channel installs when the
    // channel is disabled in Settings. Lookup is best-effort (test fixtures
    // without the settings table fall through silently). Verified is always
    // allowed at this layer; users can disable verified discovery in Settings,
    // but a job that's already been queued via deeplink should still install.
    if (job.channel === 'community') {
      try {
        const SettingsService = require('./settings');
        const enabled = SettingsService.get(db, 'app_store.channel.community.enabled');
        if (enabled !== 'true' && enabled !== true) {
          throw new Error('Community channel is disabled in Settings → App Store');
        }
      } catch (e) {
        if (/disabled in Settings/.test(e.message)) throw e;
      }
    }

    // 1. Resolve manifest from local catalog.
    // Phase 5 PR 5.6 — lazy-refresh when the cached row is older than 5
    // minutes. Symmetric with app-store:render-plan; a defense-in-depth
    // catch for the brief window between render-plan and install start.
    const entry = await AppCatalogService.get(db, job.external_slug, {
      channel: job.channel,
      refreshIfOlderThan: 5 * 60_000,
    });
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

    // 2. Clone into staging — unless the manifest declares runtime.kind: docker,
    //    in which case the binary artifact is the image and there's no source
    //    tree to clone. PR 2.5 leaves staging empty for docker manifests; the
    //    atomic move at step 5 in _runApprove still runs (moves an empty dir).
    const stagingDir = path.join(APPS_STAGING_DIR, jobId);
    if (fs.existsSync(stagingDir)) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
    fs.mkdirSync(stagingDir, { recursive: true });

    const isDocker = entry.manifest?.runtime?.kind === 'docker';
    if (isDocker) {
      publish(jobId, { kind: 'log',
        message: `runtime.kind=docker; skipping git clone (image: ${entry.manifest?.runtime?.image})` });
    } else {
      publish(jobId, { kind: 'log',
        message: `cloning ${entry.manifest.upstream.git}@${job.upstream_resolved_commit}` });
      await gitClone(entry.manifest.upstream.git, job.upstream_resolved_commit, stagingDir);

      // 3. Verify HEAD matches the declared commit (defense against ref drift).
      const headSha = await gitHead(stagingDir);
      if (headSha !== job.upstream_resolved_commit) {
        throw new Error(`HEAD ${headSha} != declared ${job.upstream_resolved_commit}`);
      }
    }

    job = InstallJobs.transition(db, jobId, {
      from: 'cloning',
      to: 'reviewing',
      patches: { staging_dir: stagingDir },
    });
    publish(jobId, { kind: 'status', status: 'reviewing', job });

    // 4. Run security review (PR 1.6). Tests can null out `_review` to skip;
    //    in production it dispatches to AppReviewService.review.
    const reviewReport = AppInstaller._review
      ? await AppInstaller._review(db, stagingDir, entry.manifest, {
          channel: job.channel,
          resolvedCommit: job.upstream_resolved_commit,
        })
      : {
          riskLevel: 'unknown',
          findings: [],
          summary: 'review service disabled by test override',
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
   * Approve a job in awaiting_approval. Transitions to `installing`
   * synchronously (so the route returns a fresh status) and runs the
   * post-approval pipeline async — clone-then-install-then-atomic-move.
   *
   * @param {object} db
   * @param {string} jobId
   * @param {{ secrets?: Object, getOS8Port?: () => number }} opts
   *        getOS8Port lets callers (tests, the route) inject the port
   *        used to compose OS8_API_BASE; defaults to 8888 when missing.
   */
  async approve(db, jobId, { secrets = {}, getOS8Port } = {}) {
    const current = InstallJobs.get(db, jobId);
    if (!current) throw new Error('job not found');
    if (current.status !== 'awaiting_approval') {
      throw new Error(`job in status ${current.status}; can only approve from awaiting_approval`);
    }
    const transitioned = InstallJobs.transition(db, jobId, {
      from: 'awaiting_approval',
      to: 'installing',
    });
    publish(jobId, { kind: 'status', status: 'installing', job: transitioned });

    // PR 4.4 — emit install_started telemetry. Adapter/framework/channel
    // are read from the manifest YAML on the job row; failures to parse
    // leave fields null (the sanitizer drops nulls anyway).
    const startTs = Date.now();
    try {
      const yaml = require('js-yaml');
      const entry = await AppCatalogService.get(db, current.external_slug, { channel: current.channel });
      const manifest = entry?.manifest || (current.staging_dir ? null : null);
      AppTelemetry.enqueue(db, {
        kind: 'install_started',
        adapter: _resolveAdapterKind(manifest),
        framework: _resolveFramework(manifest),
        channel: current.channel,
        slug: current.external_slug,
        commit: current.upstream_resolved_commit,
      });
    } catch (_) { /* telemetry failures never disrupt the install */ }

    setImmediate(() => AppInstaller._runApprove(db, jobId, secrets, { getOS8Port })
      .then(() => {
        // install_succeeded is emitted from _runApprove when the row is
        // activated (kind:'status', status:'installed'). Doing it there
        // avoids duplicates if approve() is wrapped by a retry helper.
      })
      .catch(async err => {
        publish(jobId, { kind: 'failed', message: err.message });

        // PR 4.4 — install_failed telemetry. Read the last stderr line
        // from the job's log file, fingerprint it (never the raw line),
        // and emit. Phase + duration come from the surface state.
        try {
          const failed = InstallJobs.get(db, jobId);
          const yaml = require('js-yaml');
          const entry = await AppCatalogService.get(db, current.external_slug, { channel: current.channel });
          const manifest = entry?.manifest;
          const lastErr = _readLastStderrLine(failed?.log_path) || err.message;
          AppTelemetry.enqueue(db, {
            kind: 'install_failed',
            adapter: _resolveAdapterKind(manifest),
            framework: _resolveFramework(manifest),
            channel: current.channel,
            slug: current.external_slug,
            commit: current.upstream_resolved_commit,
            failurePhase: err.failurePhase || 'install',
            failureFingerprint: AppTelemetry.fingerprintFailure(lastErr),
            durationMs: Date.now() - startTs,
          });
        } catch (_) { /* telemetry failures never disrupt rollback */ }

        await AppInstaller._rollbackInstall(db, jobId, err.message);
      })
    );

    return transitioned;
  },

  /**
   * The post-approval install pipeline. Mints the apps row, writes
   * secrets, runs the runtime adapter's install, atomically moves
   * staging→apps, sets up git for fork-on-first-edit, fires
   * track-install. Failures rollback via _rollbackInstall.
   */
  async _runApprove(db, jobId, secrets, { getOS8Port } = {}) {
    const job = InstallJobs.get(db, jobId);
    if (!job?.staging_dir) throw new Error('job missing staging_dir');

    const entry = await AppCatalogService.get(db, job.external_slug, { channel: job.channel });
    if (!entry || !entry.manifest) {
      throw new Error(`catalog row for ${job.external_slug} missing or has no manifest`);
    }
    const manifest = entry.manifest;

    // 1. Mint the apps row UPFRONT with status='installing'. We need its UUID
    //    to scope per-app secrets (and OS8_APP_ID in sanitized env).
    const { AppService } = require('./app');
    const localSlug = AppService.uniqueSlug(db, manifest.slug);
    const app = AppService.createExternal(db, {
      name: manifest.name,
      slug: localSlug,
      externalSlug: manifest.slug,
      channel: entry.channel,
      framework: manifest.framework || null,
      manifestYaml: entry.manifestYaml,
      manifestSha: entry.manifestSha,
      catalogCommitSha: entry.catalogCommitSha,
      upstreamDeclaredRef: entry.upstreamDeclaredRef,
      upstreamResolvedCommit: entry.upstreamResolvedCommit,
      statusOverride: 'installing',
    });
    db.prepare('UPDATE app_install_jobs SET app_id = ?, updated_at = ? WHERE id = ?')
      .run(app.id, new Date().toISOString(), jobId);
    publish(jobId, { kind: 'log', message: `apps row created (id=${app.id}, slug=${localSlug})` });

    // 2. Save per-app secrets BEFORE running install — some scripts read .env.
    const EnvService = require('./env');
    for (const [k, v] of Object.entries(secrets || {})) {
      const matchingDecl = (manifest.permissions?.secrets || [])
        .find(s => s.name === k);
      EnvService.set(db, k, v, {
        appId: app.id,
        description: matchingDecl?.prompt || `from install of ${manifest.slug}`,
      });
    }

    // 3. Pre-flight DNS check. RFC 6761: macOS / Linux / Win11 resolve
    //    *.localhost to 127.0.0.1 natively; legacy/AV-restricted Windows
    //    may not. Failure surfaces a clear error rather than a confusing
    //    mid-install crash later.
    await ensureSubdomainResolves(localSlug);

    // 4. Run the runtime adapter's install in the staging directory.
    const { getAdapter } = require('./runtime-adapters');
    const { buildSanitizedEnv } = require('./sanitized-env');
    const adapter = getAdapter(manifest.runtime.kind);
    await adapter.ensureAvailable(manifest);

    const port = typeof getOS8Port === 'function' ? getOS8Port() : 8888;
    const env = buildSanitizedEnv(db, {
      appId: app.id,
      allocatedPort: 0,    // unused during install — the dev server isn't running yet
      manifestEnv: manifest.env || [],
      localSlug,
      OS8_PORT: port,
    });
    manifest._localSlug = localSlug;

    publish(jobId, { kind: 'log', message: `running install in ${job.staging_dir}` });

    // PR 4.1: buffered SSE relay so a fast `npm install` (1000+ stdout
    // events/sec) doesn't flood IPC. Lines are split on `\r?\n`,
    // `\r`-progress-bar updates collapse to one line, and a 200ms cadence
    // batches into one event per window.
    const logBuffer = makeLogBuffer({
      onFlush: ({ logs }) => publish(jobId, { kind: 'log-batch', logs }),
    });
    try {
      await adapter.install(manifest, job.staging_dir, env, (stream, chunk) =>
        logBuffer.push(stream, chunk));
    } finally {
      logBuffer.flushNow();
    }

    // Diagnostic: list top-level staging entries post-install. If a runtime
    // adapter is supposed to produce a .venv / node_modules / build output
    // but it's missing here, the bug is in install (not atomic move).
    try {
      const before = fs.readdirSync(job.staging_dir).sort();
      console.log(`[installer] staging post-install (${job.staging_dir}): ${before.join(', ')}`);
    } catch (e) {
      console.log(`[installer] staging readdir failed: ${e.message}`);
    }

    // 5. Atomic move staging → apps.
    const finalDir = path.join(APPS_DIR, app.id);
    await atomicMove(job.staging_dir, finalDir);
    publish(jobId, { kind: 'log', message: `moved to ${finalDir}` });

    // Diagnostic: list top-level final entries post-move. Compared with
    // the post-install listing above, this tells us whether atomic move
    // dropped anything (it shouldn't — fs.renameSync is atomic).
    try {
      const after = fs.readdirSync(finalDir).sort();
      console.log(`[installer] apps post-move (${finalDir}): ${after.join(', ')}`);
    } catch (e) {
      console.log(`[installer] apps readdir failed: ${e.message}`);
    }

    // 6. git init for fork-on-first-edit (PR 1.23 wires the watcher; here
    //    we just create the user/main branch + .gitignore). Docker apps
    //    have no source tree to fork — skip.
    if (manifest?.runtime?.kind !== 'docker') {
      await gitInitFork(finalDir, manifest, entry.upstreamResolvedCommit);
    }

    // 7. CLAUDE.md generation lives in PR 1.21; defensive try/catch so a
    //    missing module doesn't break installs.
    try {
      const ext = require('../claude-md-external');
      ext?.generateForExternal?.(db, app);
    } catch (_) { /* PR 1.21 fills in */ }

    // 8. Activate.
    AppService.update(db, app.id, { status: 'active' });

    // 9. Final transition.
    InstallJobs.transition(db, jobId, {
      from: 'installing',
      to: 'installed',
      patches: { app_id: app.id },
    });
    publish(jobId, { kind: 'status', status: 'installed', appId: app.id });

    // PR 4.4 — install_succeeded telemetry. Duration is measured from
    // when the user clicked Install (created_at on the install job),
    // not the approve click; the dashboard shows total wall-clock cost.
    try {
      const job = InstallJobs.get(db, jobId);
      const startMs = job?.created_at ? new Date(job.created_at).getTime() : Date.now();
      AppTelemetry.enqueue(db, {
        kind: 'install_succeeded',
        adapter: _resolveAdapterKind(manifest),
        framework: _resolveFramework(manifest),
        channel: entry.channel,
        slug: entry.slug || manifest.slug,
        commit: entry.upstreamResolvedCommit,
        durationMs: Date.now() - startMs,
      });
    } catch (_) { /* never block install on telemetry */ }

    // 10. Fire-and-forget track-install. Anonymous, rate-limited per IP/day
    //     server-side. No await — the install finishes the moment the row
    //     activates, regardless of network. Skip for developer-import: the
    //     synthesized slug doesn't map to an os8.ai App row and the call
    //     would always 404.
    if (entry.channel !== 'developer-import') {
      fetch(`https://os8.ai/api/apps/${encodeURIComponent(manifest.slug)}/track-install`, {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
      }).catch(() => { /* best-effort */ });
    }
  },

  async _rollbackInstall(db, jobId, errorMessage) {
    InstallJobs.fail(db, jobId, errorMessage);
    const job = InstallJobs.get(db, jobId);
    if (!job) return;

    // Drop the apps row if we created it (it'll be in 'installing' status).
    if (job.app_id) {
      try {
        db.prepare(`DELETE FROM apps WHERE id = ? AND status = 'installing'`).run(job.app_id);
        // Also drop any per-app secrets we wrote — keep the credential
        // surface narrow on rollback.
        db.prepare(`DELETE FROM app_env_variables WHERE app_id = ?`).run(job.app_id);
      } catch (_) { /* best-effort */ }
    }

    // Best-effort cleanup of staging dir; reapStaging (PR 1.29) is the safety net.
    if (job.staging_dir && fs.existsSync(job.staging_dir)) {
      try { fs.rmSync(job.staging_dir, { recursive: true, force: true }); }
      catch (_) { /* leave for reapStaging */ }
    }

    // PR 3.1: developer-import synthetic catalog rows are local-only state;
    // drop them eagerly on rollback so an abandoned import doesn't sit in
    // app_catalog until the 24h reaper fires.
    if (job.channel === 'developer-import' && job.external_slug) {
      try { AppCatalogService.reapDeveloperImportOrphans(db, { slug: job.external_slug }); }
      catch (_) { /* best-effort */ }
    }
  },

  /**
   * Cancel from awaiting_approval. Cleans the staging dir best-effort.
   */
  cancel(db, jobId) {
    const before = InstallJobs.get(db, jobId);
    const job = InstallJobs.cancel(db, jobId);
    if (job?.staging_dir && fs.existsSync(job.staging_dir)) {
      try { fs.rmSync(job.staging_dir, { recursive: true, force: true }); }
      catch (_) { /* leave for reapStaging (PR 1.29) */ }
    }
    // PR 3.1: same-session orphan cleanup for developer-import.
    const channel = job?.channel || before?.channel;
    const slug = job?.external_slug || before?.external_slug;
    if (channel === 'developer-import' && slug) {
      try { AppCatalogService.reapDeveloperImportOrphans(db, { slug }); }
      catch (_) { /* best-effort */ }
    }
    publish(jobId, { kind: 'status', status: 'cancelled', job });
    return job;
  },

  // Test seam — exposed for unit tests that want to bypass setImmediate.
  _runNow(db, jobId, opts) { return AppInstaller._run(db, jobId, opts); },
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (1.16b)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Atomic-ish move from `srcDir` to `dstDir`. Uses fs.renameSync (atomic on
 * POSIX same-FS, atomic on Windows when destination doesn't exist). Falls back
 * to copy-then-delete with a transient marker on EXDEV (cross-mount).
 */
async function atomicMove(srcDir, dstDir) {
  if (fs.existsSync(dstDir)) {
    throw new Error(`atomic move target exists: ${dstDir}`);
  }
  // Make sure the parent of dstDir exists. ensureDirectories() in config.js
  // is the canonical call but tests sometimes skip it; either way this is
  // cheap and idempotent.
  fs.mkdirSync(path.dirname(dstDir), { recursive: true });
  try {
    fs.renameSync(srcDir, dstDir);
    return;
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
  }

  // Cross-mount fallback. Drop a marker so reapStaging can detect mid-move.
  const marker = path.join(path.dirname(dstDir), `.${path.basename(dstDir)}.installing`);
  fs.writeFileSync(marker, JSON.stringify({ src: srcDir, ts: Date.now() }));
  try {
    fs.cpSync(srcDir, dstDir, { recursive: true });
    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.unlinkSync(marker);
  } catch (err) {
    try { fs.rmSync(dstDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    throw err;
  }
}

/**
 * Set up the user/main branch + .gitignore for fork-on-first-edit (PR 1.23
 * wires the watcher). Works against either a freshly-cloned repo (the
 * upstream's history is present) or a non-git source tree (creates one).
 */
async function gitInitFork(appDir, manifest, resolvedCommit) {
  const isRepo = fs.existsSync(path.join(appDir, '.git'));

  if (!isRepo) {
    await spawnPromise('git', ['init', '-q'], { cwd: appDir });
    await spawnPromise('git', ['-C', appDir, 'config', 'user.email', 'os8@os8.local']);
    await spawnPromise('git', ['-C', appDir, 'config', 'user.name', 'OS8 Installer']);
    await spawnPromise('git', ['-C', appDir, 'add', '-A']);
    await spawnPromise('git', ['-C', appDir, 'commit', '-q', '-m',
      `OS8 install: ${manifest.slug} @ ${resolvedCommit || 'unknown'}`]);
    await spawnPromise('git', ['-C', appDir, 'checkout', '-q', '-b', 'user/main']);
  } else {
    // Cloned via PR 1.5 — HEAD is at resolvedCommit. Create user/main and a
    // tracking ref so PR 1.25's update flow can three-way-merge.
    await spawnPromise('git', ['-C', appDir, 'checkout', '-q', '-b', 'user/main']);
    if (resolvedCommit) {
      await spawnPromise('git', ['-C', appDir, 'branch', 'upstream/manifest', resolvedCommit]);
    }
  }

  // OS8 ignores. Append (don't overwrite) so upstream's .gitignore is preserved.
  const gi = path.join(appDir, '.gitignore');
  const blob = [
    '',
    '# OS8 auto-generated',
    'node_modules/',
    '.venv/',
    '__pycache__/',
    'dist/',
    'build/',
    '.next/',
    '.cache/',
    '.parcel-cache/',
    '.svelte-kit/',
    '.turbo/',
    '*.log',
    '',
    '# Local config — contains secrets',
    '.env',
    '.env.local',
    '.env.*.local',
    '',
    '# OS8 metadata',
    '.os8/',
    '',
  ].join('\n');
  fs.appendFileSync(gi, blob, 'utf8');
}

/**
 * Pre-flight DNS check: confirm <slug>.localhost resolves to 127.0.0.1.
 * Throws a descriptive error when it doesn't, so the install plan UI can
 * surface a hosts-entry prompt (PR 1.16's downstream UI piece on Windows).
 */
async function ensureSubdomainResolves(localSlug) {
  const host = `${localSlug}.localhost`;
  try {
    const { address } = await dnsLookup(host, { family: 4 });
    if (address === '127.0.0.1') return;
    throw new Error(
      `${host} resolves to ${address}, expected 127.0.0.1 — ` +
      `a hosts entry redirects *.localhost. Remove it before installing.`
    );
  } catch (err) {
    if (err?.code === 'ENOTFOUND' || err?.code === 'EAI_AGAIN') {
      throw new Error(
        `${host} does not resolve. macOS/Linux/Win11 should resolve *.localhost ` +
        `to 127.0.0.1 per RFC 6761. On legacy Windows, add an entry to your ` +
        `hosts file: 127.0.0.1\t${host}`
      );
    }
    throw err;
  }
}

// Test seam — exposed so PR 1.16 tests can stub or invoke the helpers.
AppInstaller._helpers = { atomicMove, gitInitFork, ensureSubdomainResolves };

module.exports = AppInstaller;
