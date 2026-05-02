/**
 * Apps API Routes
 * GET  /api/apps                          — List active apps (id, name, slug, icon, color)
 * POST /api/apps                          — Create a new app (plan-step context → direct, spec → auto-propose)
 * POST /api/apps/propose                  — Propose a new app build (pending approval)
 * POST /api/apps/propose/:id/approve      — Approve proposal → create app + start build
 * POST /api/apps/propose/:id/reject       — Reject proposal
 * POST /api/apps/:id/build                — Dispatch headless builder (existing app, no gate)
 * PATCH /api/apps/:id                      — Update app properties (icon, name, color, textColor)
 * GET  /api/apps/:id/build/status         — Poll build status
 */

const express = require('express');
const path = require('path');
const { APPS_DIR } = require('../config');
const agentState = require('../services/agent-state');
const { broadcast, CUSTOM } = require('../shared/agui-events');

function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

function createAppsRouter(db, deps) {
  const {
    AppService,
    generateClaudeMd,
    scaffoldApp,
    AppBuilderService,
    appCreatedCallback,
    appUpdatedCallback,
    getPort,
    getAssistantAppId
  } = deps;

  const router = express.Router();

  // GET /api/apps — List active apps
  router.get('/', (req, res) => {
    try {
      const apps = AppService.getActive(db);
      const q = req.query.q ? req.query.q.toLowerCase() : null;
      const results = (q ? apps.filter(a => a.name.toLowerCase().includes(q)) : apps)
        .map(a => ({ id: a.id, name: a.name, slug: a.slug, icon: a.icon, color: a.color, textColor: a.textColor, iconMode: a.iconMode }));
      res.json(results);
    } catch (err) {
      console.error('[Apps API] List error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/apps — Create a new app
  // With planId+stepId: direct creation (plan step already approved by user)
  // With spec (no planId): auto-creates a proposal (user must approve before app is created)
  // Without spec or planId: rejected
  router.post('/', (req, res) => {
    try {
      const { name, color, icon, textColor, planId, stepId, spec, backend, model, maxTurns, timeoutMinutes, agentId } = req.body;
      console.log(`[Apps API] POST /api/apps: name="${name}", planId=${planId || 'none'}, spec=${spec ? spec.length + ' chars' : 'none'}`);
      if (!name || !name.trim()) {
        return res.status(400).json({ error: 'App name is required' });
      }

      // Path 1: Plan-step context — direct creation (user already approved the plan)
      if (planId && stepId) {
        const plan = db.prepare('SELECT status FROM plans WHERE id = ?').get(planId);
        if (!plan || plan.status !== 'executing') {
          return res.status(403).json({ error: 'Plan is not in executing state' });
        }
        const step = db.prepare('SELECT status FROM plan_steps WHERE id = ? AND plan_id = ?').get(stepId, planId);
        if (!step || step.status !== 'running') {
          return res.status(403).json({ error: 'Plan step is not running' });
        }

        const app = AppService.create(db, name.trim(), color, icon, textColor);
        generateClaudeMd(db, { id: app.id, name: app.name, slug: app.slug });

        const cb = appCreatedCallback();
        if (cb) {
          cb({ id: app.id, name: app.name, slug: app.slug, color: app.color, icon: app.icon, textColor: app.textColor });
        }

        const port = getPort();
        return res.json({
          success: true,
          app: {
            id: app.id, name: app.name, slug: app.slug,
            color: app.color, icon: app.icon, textColor: app.textColor,
            path: app.path, blobPath: app.blobPath,
            url: `http://localhost:${port}/${app.id}/`
          }
        });
      }

      // Path 2: No plan context — reject with guidance
      return res.status(400).json({
        error: 'Direct app creation is not allowed. Write a plan file and use POST /api/apps/propose instead.',
        hint: 'Write your plan to ~/os8/plans/YYYYMMDDHHMM-app-name.json, then POST /api/apps/propose with { planFile, agentId }'
      });
    } catch (err) {
      console.error('[Apps API] Create error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/apps/propose — Submit a build plan for user approval
  // Reads plan from a JSON file written by the agent. App is NOT created until approved.
  router.post('/propose', (req, res) => {
    try {
      const { planFile, backend, model, maxTurns, timeoutMinutes, agentId, autoApprove } = req.body;
      console.log(`[Apps API] POST /api/apps/propose: planFile="${planFile}", agentId=${agentId || 'none'}, autoApprove=${!!autoApprove}`);

      if (!planFile) {
        return res.status(400).json({ error: 'planFile is required — path to the JSON plan file' });
      }

      const timeoutMs = timeoutMinutes ? timeoutMinutes * 60 * 1000 : undefined;

      const proposal = AppBuilderService.propose({
        planFile,
        backend,
        model,
        maxTurns,
        timeoutMs,
        agentId,
        autoApprove: !!autoApprove
      });

      // Auto-approve: skip the UI gate, immediately create app and start build
      if (autoApprove) {
        const result = AppBuilderService.approveProposal(proposal.id, db, {
          AppService, generateClaudeMd, appCreatedCallback, getPort, getAssistantAppId
        });
        return res.json(result);
      }

      // Also send SSE event directly to agent's stream (backup to IPC chain)
      if (agentId) {
        const state = agentState.getAgentState(agentId);
        broadcast(state.responseClients, CUSTOM, {
          name: 'build-proposal',
          value: {
            proposalId: proposal.id,
            appName: proposal.appName,
            appColor: proposal.appColor,
            appIcon: proposal.appIcon,
            spec: proposal.spec
          }
        });
      }

      res.json({
        proposalId: proposal.id,
        status: 'pending_approval',
        message: 'Build plan submitted for user review. The user will see your plan and can Approve, Propose Changes, or Reject. Do NOT create the app — it will be created automatically when approved. Wait for notification.'
      });
    } catch (err) {
      console.error('[Apps API] Propose error:', err.message);
      res.status(400).json({ error: err.message });
    }
  });

  // POST /api/apps/propose/:id/approve — Approve a proposal
  // The body's `localCli` field is ACCEPTED for back-compat (older renderers
  // may still send it) but IGNORED as of 0.4.14 — the launcher's recommended_client
  // dictates the build CLI for hard-coupling. We log a deprecation note when
  // a value is sent so we can spot stragglers in the wild.
  router.post('/propose/:id/approve', (req, res) => {
    try {
      if (req.body?.localCli) {
        console.log(`[Apps API] propose/approve: ignoring deprecated localCli='${req.body.localCli}' (0.4.14 hard-couples CLI to the launcher's recommended_client)`);
      }
      const result = AppBuilderService.approveProposal(req.params.id, db, {
        AppService, generateClaudeMd, appCreatedCallback, getPort, getAssistantAppId
      });
      res.json(result);
    } catch (err) {
      console.error('[Apps API] Approve error:', err.message);
      res.status(400).json({ error: err.message });
    }
  });

  // POST /api/apps/propose/:id/changes — Request changes to a proposal
  router.post('/propose/:id/changes', async (req, res) => {
    try {
      const { comments } = req.body;
      if (!comments || !comments.trim()) {
        return res.status(400).json({ error: 'comments are required' });
      }

      const result = AppBuilderService.requestChanges(req.params.id, comments.trim());

      // Send change request to the agent as an internal message
      if (result.agentId) {
        const port = getPort();
        const assistantAppId = getAssistantAppId ? getAssistantAppId() : null;
        if (assistantAppId) {
          const message = `[internal: build-changes-requested] User wants changes to "${result.appName}" plan: ${comments.trim()}`;
          try {
            await fetch(`http://localhost:${port}/api/assistant/chat`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ message, appId: assistantAppId })
            });
          } catch (err) {
            console.error('[Apps API] Failed to notify agent of changes:', err.message);
          }
        }
      }

      res.json(result);
    } catch (err) {
      console.error('[Apps API] Changes error:', err.message);
      res.status(400).json({ error: err.message });
    }
  });

  // POST /api/apps/propose/:id/reject — Reject a proposal (deletes plan file)
  router.post('/propose/:id/reject', (req, res) => {
    try {
      const result = AppBuilderService.rejectProposal(req.params.id);
      res.json(result);
    } catch (err) {
      console.error('[Apps API] Reject error:', err.message);
      res.status(400).json({ error: err.message });
    }
  });

  // PATCH /api/apps/:id — Update app properties (icon, name, color, textColor)
  router.patch('/:id', (req, res) => {
    try {
      const app = AppService.getById(db, req.params.id);
      if (!app) {
        return res.status(404).json({ error: 'App not found' });
      }

      const { icon, name, color, textColor, iconImage, iconMode } = req.body;
      if (icon === undefined && name === undefined && color === undefined && textColor === undefined && iconImage === undefined && iconMode === undefined) {
        return res.status(400).json({ error: 'No updatable fields provided. Supported: icon, name, color, textColor, iconImage, iconMode' });
      }

      const updates = {};
      if (icon !== undefined) updates.icon = icon;
      if (name !== undefined) updates.name = name;
      if (color !== undefined) updates.color = color;
      if (textColor !== undefined) updates.textColor = textColor;
      if (iconImage !== undefined) updates.iconImage = iconImage;
      if (iconMode !== undefined) updates.iconMode = iconMode;

      const updated = AppService.update(db, req.params.id, updates);

      const cb = appUpdatedCallback();
      if (cb) cb(updated);

      res.json({ success: true, app: updated });
    } catch (err) {
      console.error('[Apps API] Update error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/apps/:id/build — Dispatch headless builder for existing app (no approval gate)
  // Used for fix-iteration builds and plan step execution
  router.post('/:id/build', (req, res) => {
    try {
      const { id } = req.params;
      const { spec, backend, model, maxTurns, timeoutMinutes, agentId } = req.body;

      if (!spec || !spec.trim()) {
        return res.status(400).json({ error: 'Build spec is required' });
      }

      const app = AppService.getById(db, id);
      if (!app) {
        return res.status(404).json({ error: 'App not found' });
      }

      const timeoutMs = timeoutMinutes ? timeoutMinutes * 60 * 1000 : undefined;
      const port = getPort();

      const result = AppBuilderService.startBuild({
        appId: id,
        appName: app.name,
        spec: spec.trim(),
        backend, model, maxTurns, timeoutMs, agentId,
        onComplete: async (buildState) => {
          const assistantAppId = getAssistantAppId ? getAssistantAppId() : null;
          if (!assistantAppId) return;

          const elapsed = formatElapsed(new Date(buildState.completedAt) - new Date(buildState.startedAt));
          const message = buildState.status === 'completed'
            ? `[internal: build-complete] The app "${buildState.appName}" has been built successfully by ${buildState.backend}. Build took ${elapsed}. The app is live at http://localhost:${port}/${buildState.appId}/. Let the user know their app is ready.`
            : `[internal: build-failed] The build of "${buildState.appName}" failed after ${elapsed}. Error: ${buildState.error || 'Unknown error'}. Let the user know and suggest next steps.`;

          try {
            await fetch(`http://localhost:${port}/api/assistant/chat`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ message, appId: assistantAppId })
            });
          } catch (err) {
            console.error('[AppBuilder] Failed to notify agent:', err.message);
          }
        }
      }, db);

      res.json(result);
    } catch (err) {
      console.error('[Apps API] Build error:', err.message);
      res.status(400).json({ error: err.message });
    }
  });

  // GET /api/apps/:id/build/status — Poll build status
  router.get('/:id/build/status', (req, res) => {
    try {
      const { id } = req.params;
      const since = parseInt(req.query.since, 10) || 0;
      const stdoutSince = parseInt(req.query.stdoutSince, 10) || 0;

      const build = AppBuilderService.getLatestBuildForApp(id);
      if (!build) {
        return res.json({ status: 'none' });
      }

      const status = AppBuilderService.getStatus(build.id, { since, stdoutSince });

      const result = {
        buildId: status.id,
        status: status.status,
        backend: status.backend,
        model: status.model || null,
        appName: status.appName,
        startedAt: status.startedAt,
        completedAt: status.completedAt,
        elapsedMs: status.completedAt
          ? new Date(status.completedAt) - new Date(status.startedAt)
          : Date.now() - new Date(status.startedAt).getTime(),
        stderrLines: status.stderrLines,
        stderrCount: status.stderrCount,
        stdoutLines: status.stdoutLines,
        stdoutCount: status.stdoutCount
      };

      if (status.status !== 'running') {
        result.output = status.output;
        result.error = status.error;
      }

      res.json(result);
    } catch (err) {
      console.error('[Apps API] Status error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // External-app process lifecycle (PR 1.19).
  // POST /api/apps/:id/processes/start — start the dev server, register
  // the proxy, return the URL the BrowserView should load.
  //
  // On failure, response body carries the structured error detail used by
  // the renderer's failure modal (Tier 3A): code, stderrTail, hints.
  // Pre-Tier-3A clients still see the same `error` string.
  router.post('/:id/processes/start', async (req, res) => {
    try {
      const app = AppService.getById(db, req.params.id);
      if (!app) return res.status(404).json({ error: 'app not found' });
      if (app.app_type !== 'external') {
        return res.status(400).json({ error: 'not an external app' });
      }

      const APR = require('../services/app-process-registry').get();
      const ReverseProxyService = require('../services/reverse-proxy');

      const entry = await APR.start(app.id);
      // PR 2.3: dispatch on adapter kind. Static apps register a directory
      // (no upstream port); proxied apps register a port.
      if (entry?._adapterInfo?._kind === 'static') {
        ReverseProxyService.registerStatic(app.slug, app.id, entry._adapterInfo._staticDir);
      } else {
        ReverseProxyService.register(app.slug, app.id, entry.port);
      }

      const os8Port = require('../server').getPort();
      res.json({
        url: `http://${app.slug}.localhost:${os8Port}/?__os8_app_id=${encodeURIComponent(app.id)}`,
        slug: app.slug,
        port: os8Port,
        upstreamPort: entry.port,
      });
    } catch (err) {
      console.error('[Apps API] processes/start error:', err.message);
      const { matchHints, parseStartError } = require('../services/failure-hints');
      const parsed = parseStartError(err.message);
      res.status(500).json({
        error: parsed.summary || err.message,
        errorDetail: {
          code: parsed.code,
          stderrTail: parsed.stderrTail,
          hints: matchHints(parsed.stderrTail || err.message),
        },
      });
    }
  });

  // Tier 3A — retry-start. Stops the existing process if any (so a
  // half-started state from a previous crash doesn't linger), then runs
  // the same start path. Used by the failure modal's "Retry start"
  // action after the user has fixed something on disk (downloaded
  // weights, edited app.py, etc.). Returns the same shape as
  // processes/start.
  router.post('/:id/processes/retry-start', async (req, res) => {
    try {
      const app = AppService.getById(db, req.params.id);
      if (!app) return res.status(404).json({ error: 'app not found' });
      if (app.app_type !== 'external') {
        return res.status(400).json({ error: 'not an external app' });
      }

      const APR = require('../services/app-process-registry').get();
      const ReverseProxyService = require('../services/reverse-proxy');

      // Best-effort stop. APR.stop is idempotent; ignore "not running" errors.
      try { await APR.stop(app.id); } catch (_) { /* ignore */ }
      try { ReverseProxyService.unregister(app.slug); } catch (_) { /* ignore */ }

      const entry = await APR.start(app.id);
      if (entry?._adapterInfo?._kind === 'static') {
        ReverseProxyService.registerStatic(app.slug, app.id, entry._adapterInfo._staticDir);
      } else {
        ReverseProxyService.register(app.slug, app.id, entry.port);
      }

      const os8Port = require('../server').getPort();
      res.json({
        url: `http://${app.slug}.localhost:${os8Port}/?__os8_app_id=${encodeURIComponent(app.id)}`,
        slug: app.slug,
        port: os8Port,
        upstreamPort: entry.port,
      });
    } catch (err) {
      console.error('[Apps API] processes/retry-start error:', err.message);
      const { matchHints, parseStartError } = require('../services/failure-hints');
      const parsed = parseStartError(err.message);
      res.status(500).json({
        error: parsed.summary || err.message,
        errorDetail: {
          code: parsed.code,
          stderrTail: parsed.stderrTail,
          hints: matchHints(parsed.stderrTail || err.message),
        },
      });
    }
  });

  // POST /api/apps/:id/update (PR 1.25). Body: { commit?: string }.
  // Defaults to apps.update_to_commit (set by sync's detectUpdates).
  // Returns { kind: 'updated' | 'conflict', commit, files? }.
  router.post('/:id/update', express.json(), async (req, res) => {
    try {
      const app = AppService.getById(db, req.params.id);
      if (!app) return res.status(404).json({ error: 'app not found' });
      if (app.app_type !== 'external') {
        return res.status(400).json({ error: 'not an external app' });
      }
      const target = (req.body && req.body.commit) || app.update_to_commit;
      if (!target) {
        return res.status(400).json({ error: 'no target commit (no update available)' });
      }
      const AppCatalogService = require('../services/app-catalog');
      const result = await AppCatalogService.update(db, app.id, target);
      res.json(result);
    } catch (err) {
      console.error('[Apps API] update error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/apps/:id/uninstall (PR 1.24). Body: { deleteData: bool }.
  // Default keeps blob/db/secrets so reinstall can offer "restore data."
  router.post('/:id/uninstall', express.json(), async (req, res) => {
    try {
      const deleteData = !!(req.body && req.body.deleteData);
      const result = await AppService.uninstall(db, req.params.id, { deleteData });
      res.json(result);
    } catch (err) {
      console.error('[Apps API] uninstall error:', err.message);
      res.status(400).json({ error: err.message });
    }
  });

  // GET /api/apps/:id/git/check (PR 1.23) — inspect working-tree state on
  // dev-mode activation. Returns { kind: 'clean' | 'dirty', branch, status,
  // untracked }.
  router.get('/:id/git/check', async (req, res) => {
    try {
      const app = AppService.getById(db, req.params.id);
      if (!app) return res.status(404).json({ error: 'app not found' });
      if (app.app_type !== 'external') {
        return res.status(400).json({ error: 'not an external app' });
      }
      const { APPS_DIR } = require('../config');
      const path = require('path');
      const AppGit = require('../services/app-git');
      const result = await AppGit.checkOnActivation(path.join(APPS_DIR, app.id));
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/apps/:id/git/recover (PR 1.23) — apply one of the three
  // recovery actions: continue / reset / stash.
  router.post('/:id/git/recover', express.json(), async (req, res) => {
    try {
      const app = AppService.getById(db, req.params.id);
      if (!app) return res.status(404).json({ error: 'app not found' });
      if (app.app_type !== 'external') {
        return res.status(400).json({ error: 'not an external app' });
      }
      const action = String(req.body?.action || '');
      if (!['continue', 'reset', 'stash'].includes(action)) {
        return res.status(400).json({ error: 'action must be continue|reset|stash' });
      }
      const { APPS_DIR } = require('../config');
      const path = require('path');
      const AppGit = require('../services/app-git');
      const appDir = path.join(APPS_DIR, app.id);
      if (action === 'continue') await AppGit.continueOnDirty(appDir);
      else if (action === 'reset') await AppGit.resetToManifest(appDir, app.upstream_resolved_commit);
      else if (action === 'stash') await AppGit.stashAndContinue(appDir);
      res.json({ ok: true, action });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/apps/:id/dev-mode (PR 1.22) — toggle dev mode for an external
  // app. When ON, the next process start wires the chokidar watcher per
  // manifest.dev.watch (PR 1.11b). The toggle persists to apps.dev_mode.
  router.post('/:id/dev-mode', express.json(), async (req, res) => {
    try {
      const enabled = !!(req.body && req.body.enabled);
      const app = AppService.setDevMode(db, req.params.id, enabled);

      // If the process is currently running, restart it so the watcher is
      // re-installed in the desired state. Cheap and obvious — beats a
      // late-binding "rebuild watcher" path that has to handle in-flight
      // edits during the swap.
      const APR = require('../services/app-process-registry').get();
      if (APR.get(app.id)) {
        const ReverseProxyService = require('../services/reverse-proxy');
        await APR.stop(app.id, { reason: 'dev-mode-toggle' });
        ReverseProxyService.unregister(app.slug);
        const entry = await APR.start(app.id, { devMode: enabled });
        if (entry?._adapterInfo?._kind === 'static') {
          ReverseProxyService.registerStatic(app.slug, app.id, entry._adapterInfo._staticDir);
        } else {
          ReverseProxyService.register(app.slug, app.id, entry.port);
        }
      }

      res.json({
        id: app.id,
        slug: app.slug,
        devMode: !!app.dev_mode,
      });
    } catch (err) {
      console.error('[Apps API] dev-mode error:', err.message);
      res.status(400).json({ error: err.message });
    }
  });

  // POST /api/apps/:id/processes/stop — stop the dev server + unregister
  // the proxy. Used by tab-close and "Stop" in the dev mode panel (PR 1.22).
  router.post('/:id/processes/stop', async (req, res) => {
    try {
      const app = AppService.getById(db, req.params.id);
      if (!app) return res.status(404).json({ error: 'app not found' });

      const APR = require('../services/app-process-registry').get();
      const ReverseProxyService = require('../services/reverse-proxy');

      await APR.stop(app.id);
      ReverseProxyService.unregister(app.slug);
      res.json({ success: true });
    } catch (err) {
      console.error('[Apps API] processes/stop error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createAppsRouter;

module.exports.meta = {
  name: 'apps',
  description: `App lookup and management — list apps, find an app by name, update app properties.

Use this API to find an app's ID when you know its name, or to list all apps the user has.

**List all apps:** GET /api/apps — returns every active app with its id, name, slug, icon, color, textColor, and iconMode.

**Search by name:** GET /api/apps?q=contacts — filters apps whose name contains the query (case-insensitive).

**Update app properties:** PATCH /api/apps/{id} with JSON body containing any of: icon, name, color, textColor, iconImage, iconMode.

**Example — find an app by name:**
curl http://localhost:8888/api/apps?q=contacts

**Example — update an app's icon:**
curl -X PATCH http://localhost:8888/api/apps/{id} -H "Content-Type: application/json" -d '{"icon": "📇"}'`,
  basePath: '/api/apps',
  endpoints: [
    { method: 'GET', path: '/api/apps', description: 'List active apps (optional ?q= to filter by name)' },
    { method: 'PATCH', path: '/api/apps/:id', description: 'Update app properties (icon, name, color, textColor, iconImage, iconMode)' }
  ]
};
