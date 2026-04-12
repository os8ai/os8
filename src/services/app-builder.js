/**
 * AppBuilderService
 * Dispatches a headless CLI subprocess to build an app from a spec.
 * Independent of WorkQueue — doesn't block agent messages during builds.
 * Build state is in-memory (transient — doesn't survive OS8 restart).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { generateId } = require('../utils');
const { getBackend } = require('./backend-adapter');
const RoutingService = require('./routing');
const SettingsService = require('./settings');
const { prepareSpawnEnv, parseBatchOutput, parseResponseLine } = require('./cli-runner');

const MAX_CONCURRENT_BUILDS = 3;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
const CLEANUP_AGE_MS = 60 * 60 * 1000; // 1 hour

const BUILDER_PROMPT = `Read CLAUDE.md and claude-user.md in this directory. Build the app described in claude-user.md. The project is already scaffolded with React, Tailwind CSS, and Vite. Edit src/App.jsx and create components in src/components/ as needed. Do not modify index.html or src/main.jsx.

IMPORTANT — there is no per-app build step. OS8 serves your app live through a shared Vite middleware. Do NOT run vite, vite build, npm, npx, pnpm, or yarn. Do NOT create package.json or node_modules in this directory. Do NOT symlink to or modify anything under ~/os8/core/ — that directory is shared by every app in OS8 and touching it will break the dev server for all of them.

When you believe the app is complete, verify it using the two HTTP endpoints documented in CLAUDE.md's "Verifying Your Work" section:
  1. Compile check (fast): POST /api/apps/{this app's id}/check — fix any entries in the response's errors[] array
  2. Runtime check (slower): POST /api/apps/{this app's id}/inspect — fix any entries in the response's consoleErrors[] array

Only declare the build complete when /check returns ok:true and /inspect returns an empty consoleErrors array. The full curl commands with the correct port and app ID are in CLAUDE.md.`;

// In-memory build state
const builds = new Map();

// Callbacks for IPC push events
let buildStartedCallback = null;
let buildCompletedCallback = null;

const AppBuilderService = {
  setBuildStartedCallback(cb) { buildStartedCallback = cb; },
  setBuildCompletedCallback(cb) { buildCompletedCallback = cb; },

  /**
   * Propose a build from a plan file.
   * Reads JSON plan file (name, color, icon, textColor, spec), stores in memory.
   * No app is created, no CLI is spawned. Returns a proposalId.
   */
  propose({ planFile, backend: backendId = 'codex', model, maxTurns = 25, timeoutMs = DEFAULT_TIMEOUT_MS, agentId, autoApprove = false }) {
    // Resolve ~ in path
    const resolvedPath = planFile.replace(/^~/, process.env.HOME || process.env.USERPROFILE);

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Plan file not found: ${resolvedPath}`);
    }

    // Read and parse the plan JSON
    let plan;
    try {
      plan = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'));
    } catch (err) {
      throw new Error(`Failed to parse plan file: ${err.message}`);
    }

    if (!plan.name || !plan.name.trim()) {
      throw new Error('Plan file missing required "name" field');
    }
    if (!plan.spec || !plan.spec.trim()) {
      throw new Error('Plan file missing required "spec" field');
    }

    const proposalId = generateId();
    const proposal = {
      id: proposalId,
      status: 'pending_approval',
      planFile: resolvedPath,
      appName: plan.name.trim(),
      appColor: plan.color || null,
      appIcon: plan.icon || null,
      appTextColor: plan.textColor || null,
      iconPrompt: plan.iconPrompt || null,
      spec: plan.spec.trim(),
      backend: backendId,
      model: model || null,
      maxTurns,
      timeoutMs,
      agentId: agentId || null,
      createdAt: new Date().toISOString()
    };
    builds.set(proposalId, proposal);
    console.log(`[AppBuilder] Proposal created from plan file: id=${proposalId}, app="${proposal.appName}", spec=${proposal.spec.length} chars, file=${resolvedPath}`);

    // Notify renderer — pending_approval triggers proposal card in agent chat
    // Skip when autoApprove — proposal will be immediately approved by the route
    if (!autoApprove) {
      if (buildStartedCallback) {
        buildStartedCallback({
          buildId: proposalId, appName: proposal.appName,
          appColor: proposal.appColor, appIcon: proposal.appIcon,
          backend: backendId, model: proposal.model,
          agentId: proposal.agentId,
          status: 'pending_approval', spec: proposal.spec
        });
      } else {
        console.warn(`[AppBuilder] No buildStartedCallback set — proposal card will NOT appear`);
      }
    }

    return proposal;
  },

  /**
   * Approve a proposal — create the app, transfer plan to claude-user.md, delete plan file, start build.
   * Returns { buildId, appId, app, status }.
   */
  approveProposal(proposalId, db, { AppService, generateClaudeMd, appCreatedCallback, getPort, getAssistantAppId, onComplete }) {
    const proposal = builds.get(proposalId);
    if (!proposal) throw new Error('Proposal not found');
    if (proposal.status !== 'pending_approval') throw new Error(`Proposal is ${proposal.status}, not pending_approval`);

    // Check concurrent build limit
    const activeCount = [...builds.values()].filter(b => b.status === 'running').length;
    if (activeCount >= MAX_CONCURRENT_BUILDS) {
      throw new Error(`Maximum concurrent builds (${MAX_CONCURRENT_BUILDS}) reached.`);
    }

    // 1. Create the app
    const app = AppService.create(db, proposal.appName, proposal.appColor, proposal.appIcon, proposal.appTextColor);
    generateClaudeMd(db, { id: app.id, name: app.name, slug: app.slug });

    // 2. Transfer spec to claude-user.md in the new app
    const { APPS_DIR } = require('../config');
    const specPath = path.join(APPS_DIR, app.id, 'claude-user.md');
    fs.writeFileSync(specPath, proposal.spec, 'utf-8');
    console.log(`[AppBuilder] Transferred plan to ${specPath}`);

    // 3. Delete the plan file (temporary — no longer needed)
    if (proposal.planFile && fs.existsSync(proposal.planFile)) {
      fs.unlinkSync(proposal.planFile);
      console.log(`[AppBuilder] Deleted plan file: ${proposal.planFile}`);
    }

    // 3b. Generate icon image from iconPrompt (fire-and-forget)
    if (proposal.iconPrompt) {
      (async () => {
        try {
          const ImageGenService = require('./imagegen');
          const sharp = require('sharp');
          const { ICONS_DIR, BLOB_DIR } = require('../config');
          const IMAGEGEN_DIR = path.join(BLOB_DIR, 'imagegen');

          const enhancedPrompt = `App icon, square, clean minimal design, no text: ${proposal.iconPrompt}`;
          console.log(`[AppBuilder] Generating icon for ${app.id}: "${proposal.iconPrompt.slice(0, 60)}"`);

          const result = await ImageGenService.generate(db, enhancedPrompt);
          if (result.images && result.images.length > 0) {
            const genPath = path.join(IMAGEGEN_DIR, result.images[0].filename);
            const buffer = fs.readFileSync(genPath);
            const metadata = await sharp(buffer).metadata();
            const hasAlpha = metadata.hasAlpha;

            let processed, ext;
            if (hasAlpha) {
              processed = await sharp(buffer).resize(128, 128, { fit: 'cover' }).png().toBuffer();
              ext = 'png';
            } else {
              processed = await sharp(buffer).resize(128, 128, { fit: 'cover' }).jpeg({ quality: 85 }).toBuffer();
              ext = 'jpg';
            }

            const filename = `${app.id}.${ext}`;
            fs.writeFileSync(path.join(ICONS_DIR, filename), processed);
            AppService.update(db, app.id, { iconImage: filename, iconMode: 'cover' });
            console.log(`[AppBuilder] Icon generated: ${filename}`);
          }
        } catch (err) {
          console.error(`[AppBuilder] Icon generation failed for ${app.id}:`, err.message);
        }
      })();
    }

    // Notify renderer — app created (triggers tab switch + agent panel)
    const cb = appCreatedCallback();
    if (cb) {
      cb({ id: app.id, name: app.name, slug: app.slug, color: app.color, icon: app.icon, textColor: app.textColor });
    }

    // 2. Convert proposal to a running build
    proposal.appId = app.id;
    proposal.status = 'running';
    proposal.startedAt = new Date().toISOString();
    proposal.completedAt = null;
    proposal.output = null;
    proposal.error = null;
    proposal.pid = null;
    proposal.stderrLines = [];
    proposal.stdoutLines = [];

    // Notify renderer — build started (triggers coder panel)
    if (buildStartedCallback) {
      buildStartedCallback({
        buildId: proposalId, appId: app.id, appName: app.name,
        backend: proposal.backend, model: proposal.model,
        agentId: proposal.agentId, status: 'running'
      });
    }

    // 3. Spawn builder
    const port = getPort();
    this._spawnBuilder(proposal, db, {
      spec: proposal.spec,
      model: proposal.model,
      maxTurns: proposal.maxTurns,
      timeoutMs: proposal.timeoutMs,
      onComplete: onComplete || (async (buildState) => {
        const assistantAppId = getAssistantAppId ? getAssistantAppId() : null;
        if (!assistantAppId) return;
        const elapsed = Math.round((new Date(buildState.completedAt) - new Date(buildState.startedAt)) / 1000);
        const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
        const message = buildState.status === 'completed'
          ? `[internal: build-complete] The app "${buildState.appName}" has been built successfully by ${buildState.backend}. Build took ${elapsedStr}. The app is live at http://localhost:${port}/${buildState.appId}/. Let the user know their app is ready.`
          : `[internal: build-failed] The build of "${buildState.appName}" failed after ${elapsedStr}. Error: ${buildState.error || 'Unknown error'}. Let the user know and suggest next steps.`;
        try {
          await fetch(`http://localhost:${port}/api/assistant/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message, appId: assistantAppId })
          });
        } catch (err) {
          console.error('[AppBuilder] Failed to notify agent:', err.message);
        }
      })
    }).catch(err => {
      console.error(`[AppBuilder] Build ${proposalId} spawn error:`, err.message);
      proposal.status = 'failed';
      proposal.error = err.message;
      proposal.completedAt = new Date().toISOString();
      this._fireComplete(proposal, onComplete);
    });

    return { buildId: proposalId, appId: app.id, app: { id: app.id, name: app.name, slug: app.slug, color: app.color, icon: app.icon, url: `http://localhost:${port}/${app.id}/` }, status: 'running' };
  },

  /**
   * Request changes to a proposal — sets status, returns info for notifying the agent.
   */
  requestChanges(proposalId, comments) {
    const proposal = builds.get(proposalId);
    if (!proposal) throw new Error('Proposal not found');
    if (proposal.status !== 'pending_approval') throw new Error(`Proposal is ${proposal.status}, not pending_approval`);
    proposal.status = 'changes_requested';
    proposal.completedAt = new Date().toISOString();
    return { proposalId, appName: proposal.appName, agentId: proposal.agentId, status: 'changes_requested' };
  },

  /**
   * Reject a proposal and delete the plan file.
   */
  rejectProposal(proposalId) {
    const proposal = builds.get(proposalId);
    if (!proposal) throw new Error('Proposal not found');
    if (proposal.status !== 'pending_approval') throw new Error(`Proposal is ${proposal.status}, not pending_approval`);
    proposal.status = 'rejected';
    proposal.completedAt = new Date().toISOString();

    // Delete the plan file
    if (proposal.planFile && fs.existsSync(proposal.planFile)) {
      fs.unlinkSync(proposal.planFile);
      console.log(`[AppBuilder] Deleted plan file on reject: ${proposal.planFile}`);
    }

    return { proposalId, status: 'rejected' };
  },

  /**
   * Start a build for an existing app (direct, no approval gate).
   * Used by plan executor steps and fix-iteration builds.
   */
  startBuild({ appId, appName, spec, backend: backendId = 'codex', model, maxTurns = 25, timeoutMs = DEFAULT_TIMEOUT_MS, agentId, onComplete }, db) {
    // Check concurrent build limit
    const activeCount = [...builds.values()].filter(b => b.status === 'running').length;
    if (activeCount >= MAX_CONCURRENT_BUILDS) {
      throw new Error(`Maximum concurrent builds (${MAX_CONCURRENT_BUILDS}) reached. Wait for a build to finish.`);
    }

    // Check no active build for this app
    const existing = this.getActiveBuildForApp(appId);
    if (existing) {
      throw new Error(`App ${appId} already has an active build (${existing.id})`);
    }

    const buildId = generateId();
    const buildState = {
      id: buildId,
      appId,
      appName: appName || appId,
      status: 'running',
      backend: backendId,
      agentId: agentId || null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      output: null,
      error: null,
      pid: null,
      stderrLines: [],
      stdoutLines: [],
      model: model || null
    };

    builds.set(buildId, buildState);

    // Notify renderer
    if (buildStartedCallback) {
      buildStartedCallback({ buildId, appId, appName: buildState.appName, backend: backendId, model: buildState.model, agentId: buildState.agentId, status: 'running' });
    }

    // Spawn async
    this._spawnBuilder(buildState, db, { spec, model, maxTurns, timeoutMs, onComplete }).catch(err => {
      console.error(`[AppBuilder] Build ${buildId} spawn error:`, err.message);
      buildState.status = 'failed';
      buildState.error = err.message;
      buildState.completedAt = new Date().toISOString();
      this._fireComplete(buildState, onComplete);
    });

    return { buildId, appId, status: 'running' };
  },

  _fireComplete(buildState, onComplete) {
    if (buildCompletedCallback) {
      buildCompletedCallback(buildState);
    }
    if (onComplete) {
      Promise.resolve().then(() => onComplete(buildState)).catch(e => {
        console.error('[AppBuilder] onComplete error:', e.message);
      });
    }
  },

  getStatus(buildId, { since = 0, stdoutSince = 0 } = {}) {
    const build = builds.get(buildId);
    if (!build) return null;
    return {
      ...build,
      stderrLines: build.stderrLines.slice(since),
      stderrCount: build.stderrLines.length,
      stdoutLines: build.stdoutLines.slice(stdoutSince),
      stdoutCount: build.stdoutLines.length
    };
  },

  getActiveBuildForApp(appId) {
    for (const build of builds.values()) {
      if (build.appId === appId && (build.status === 'running' || build.status === 'pending_approval')) {
        return build;
      }
    }
    return null;
  },

  getLatestBuildForApp(appId) {
    let latest = null;
    for (const build of builds.values()) {
      if (build.appId === appId) {
        if (!latest || build.startedAt > latest.startedAt) {
          latest = build;
        }
      }
    }
    return latest;
  },

  async _spawnBuilder(buildState, db, { spec, model, maxTurns, timeoutMs, onComplete }) {
    let { appId, backend: backendId } = buildState;
    const { APPS_DIR } = require('../config');
    const appPath = path.join(APPS_DIR, appId);

    // 1. Write spec to claude-user.md
    const specPath = path.join(appPath, 'claude-user.md');
    fs.writeFileSync(specPath, spec, 'utf-8');
    console.log(`[AppBuilder] Wrote spec to ${specPath} (${spec.length} chars)`);

    // 2. Get backend — use routing if no explicit model given
    let builderAccessMethod = 'api';
    if (!model && db) {
      const resolved = RoutingService.resolve(db, 'coding');
      backendId = resolved.backendId;
      model = resolved.modelArg;
      builderAccessMethod = resolved.accessMethod;
      console.log(`[Routing] coding/builder: ${resolved.familyId} via ${resolved.source} (${resolved.accessMethod})`);
    }
    const backend = getBackend(backendId);

    // Update build state with resolved backend/model (UI picks it up via polling)
    buildState.backend = backendId;
    buildState.model = model || null;

    // 3. Prepare env
    const env = prepareSpawnEnv(db, backendId, builderAccessMethod);

    // 4. Build args
    const args = backend.buildArgs({
      print: true,
      skipPermissions: true,
      json: true,
      maxTurns: backend.supportsMaxTurns ? maxTurns : undefined,
      appPath,
      model
    });

    // 5. Build prompt args or prepare for stdin
    const prompt = BUILDER_PROMPT;
    if (!backend.promptViaStdin) {
      args.push(...backend.buildPromptArgs(prompt));
    }

    console.log(`[AppBuilder] Spawning ${backend.command} for app ${appId} [backend: ${backendId}]`);

    // 6. Spawn
    const child = spawn(backend.command, args, {
      cwd: appPath,
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    buildState.pid = child.pid;

    // Write prompt to stdin for backends that need it
    if (backend.promptViaStdin) {
      child.stdin.write(prompt);
    }
    child.stdin.end();

    let stdout = '';
    let stderr = '';
    let stdoutBuffer = '';

    // Timeout
    const timeout = setTimeout(() => {
      console.error(`[AppBuilder] Build ${buildState.id} timed out after ${Math.round(timeoutMs / 60000)}m`);
      child.kill();
      buildState.status = 'timeout';
      buildState.completedAt = new Date().toISOString();
      buildState.error = `Build timed out after ${Math.round(timeoutMs / 60000)} minutes`;
      this._fireComplete(buildState, onComplete);
    }, timeoutMs);

    child.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;

      // Parse streaming lines for real-time UI updates
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || ''; // Keep incomplete last line
      for (const line of lines) {
        const parsed = parseResponseLine(line);
        if (parsed && parsed.text) {
          buildState.stdoutLines.push(parsed.text);
        }
      }
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      // Capture stderr lines for build status tab
      const lines = text.split('\n').filter(l => l.trim());
      buildState.stderrLines.push(...lines);
      if (text.trim()) {
        console.log(`[AppBuilder] ${backend.label} stderr: ${text.substring(0, 200)}`);
      }
    });

    return new Promise((resolve) => {
      child.on('close', (code) => {
        clearTimeout(timeout);

        // Flush remaining stdout buffer
        if (stdoutBuffer.trim()) {
          const parsed = parseResponseLine(stdoutBuffer);
          if (parsed && parsed.text) {
            buildState.stdoutLines.push(parsed.text);
          }
          stdoutBuffer = '';
        }

        // Don't overwrite timeout status
        if (buildState.status !== 'running') {
          resolve();
          return;
        }

        console.log(`[AppBuilder] ${backend.label} exited with code ${code}, stdout: ${stdout.length} chars`);

        // Parse output
        const output = this._parseOutput(stdout);
        buildState.output = output;

        if (code !== 0 && !output) {
          buildState.status = 'failed';
          buildState.error = `${backend.label} exited with code ${code}: ${stderr.substring(0, 500)}`;
        } else {
          buildState.status = 'completed';
        }

        buildState.completedAt = new Date().toISOString();
        buildState.pid = null;
        this._fireComplete(buildState, onComplete);
        resolve();
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        console.error(`[AppBuilder] Spawn error:`, err.message);
        buildState.status = 'failed';
        buildState.error = err.message;
        buildState.completedAt = new Date().toISOString();
        buildState.pid = null;
        this._fireComplete(buildState, onComplete);
        resolve();
      });
    });
  },

  /**
   * Parse output from different backends via shared cli-runner utility
   */
  _parseOutput(stdout) {
    if (!stdout?.trim()) return null;
    return parseBatchOutput(stdout) || stdout.substring(0, 2000);
  },

  /**
   * Remove builds completed more than 1 hour ago
   */
  cleanup() {
    const now = Date.now();
    for (const [id, build] of builds) {
      if (build.status !== 'running' && build.completedAt) {
        const age = now - new Date(build.completedAt).getTime();
        if (age > CLEANUP_AGE_MS) {
          builds.delete(id);
        }
      }
    }
  }
};

module.exports = AppBuilderService;
