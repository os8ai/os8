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
        const sseData = JSON.stringify({
          type: 'build-proposal',
          proposalId: proposal.id,
          appName: proposal.appName,
          appColor: proposal.appColor,
          appIcon: proposal.appIcon,
          spec: proposal.spec
        });
        state.responseClients.forEach(client => {
          try { client.write(`data: ${sseData}\n\n`); } catch {}
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
  router.post('/propose/:id/approve', (req, res) => {
    try {
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
