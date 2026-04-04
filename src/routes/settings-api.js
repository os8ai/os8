/**
 * Settings, env, and backend auth API routes
 *
 * Extracted from server.js — these were inline endpoint definitions
 * for settings management, environment variables, and backend auth.
 *
 * Mounted at /api so each handler uses the full sub-path
 * (endpoints span /api/settings/*, /api/env/*, /api/backend/*, /api/open-external).
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const { CONFIG_DIR } = require('../config');
const RoutingService = require('../services/routing');

const userImageUpload = multer({
  storage: multer.diskStorage({
    destination: CONFIG_DIR,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || '.png';
      cb(null, `user-image${ext}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, /^image\/(png|jpeg|jpg|webp)$/.test(file.mimetype));
  }
});

function createSettingsApiRouter(db, deps) {
  const {
    SettingsService,
    EnvService,
    AgentService,
    AIRegistryService,
    ensureTelegramWatchers,
    agentState,
    DEFAULT_CLAUDE_TIMEOUT_MS
  } = deps;

  const router = express.Router();

  // ============ Settings ============

  // Legacy backend-auth endpoint (now handled by routing cascade)
  router.get('/settings/backend-auth', (req, res) => {
    res.json({ claude: true, gemini: true, codex: true, grok: true });
  });

  // User settings
  router.get('/settings/user', (req, res) => {
    res.json({ firstName: SettingsService.get(db, 'user_first_name') || '' });
  });
  router.post('/settings/user', (req, res) => {
    if (req.body.firstName !== undefined) {
      const oldName = SettingsService.get(db, 'user_first_name') || '';
      const newName = req.body.firstName.trim();
      SettingsService.set(db, 'user_first_name', newName);

      // Regenerate instruction files when name changes so agents see the updated owner name
      if (newName !== oldName) {
        const { generateAssistantClaudeMd } = require('../services/app');
        const { generateUserMd } = require('../assistant/config-handler');
        const agents = AgentService.getAll(db);
        for (const agent of agents) {
          const config = AgentService.getConfig(db, agent.id);
          const appLike = { id: agent.id, name: agent.name, slug: agent.slug };
          generateAssistantClaudeMd(db, appLike, config);
          generateUserMd(db, agent.id);
        }
      }
    }
    res.json({ ok: true });
  });

  // User image upload
  router.post('/settings/user-image', userImageUpload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No image provided' });
    res.json({ ok: true, path: req.file.path });
  });

  router.get('/settings/user-image', (req, res) => {
    for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
      const p = path.join(CONFIG_DIR, `user-image${ext}`);
      if (fs.existsSync(p)) {
        return res.sendFile(p);
      }
    }
    res.status(404).json({ error: 'No user image set' });
  });

  router.delete('/settings/user-image', (req, res) => {
    for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
      const p = path.join(CONFIG_DIR, `user-image${ext}`);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    res.json({ ok: true });
  });

  // Time settings (timezone)
  router.get('/settings/time', (req, res) => {
    const timezone = SettingsService.get(db, 'timezone') || 'America/New_York';
    res.json({ timezone });
  });
  router.post('/settings/time', (req, res) => {
    if (req.body.timezone) {
      SettingsService.set(db, 'timezone', req.body.timezone);
    }
    res.json({ ok: true });
  });

  // Global Telegram monitoring toggle
  router.get('/settings/telegram', (req, res) => {
    const raw = SettingsService.get(db, 'telegramEnabled');
    res.json({ enabled: raw !== 'false' }); // default true
  });
  router.post('/settings/telegram', (req, res) => {
    const enabled = !!req.body.enabled;
    SettingsService.set(db, 'telegramEnabled', String(enabled));

    if (enabled) {
      // Start watchers for all agents with tokens
      ensureTelegramWatchers(db);
    } else {
      // Stop all active watchers
      const allAgentIds = agentState.getAllAgentIds();
      for (const agentId of allAgentIds) {
        const aState = agentState.getAgentState(agentId);
        if (aState.telegramWatcher) {
          aState.telegramWatcher.stop();
          aState.telegramWatcher = null;
          console.log(`Telegram: Stopped watcher for agent ${agentId}`);
        }
      }
    }

    res.json({ success: true });
  });

  // Global response timeout setting
  router.get('/settings/response-timeout', (req, res) => {
    const raw = SettingsService.get(db, 'responseTimeoutMs');
    res.json({ timeoutMs: raw !== null ? parseInt(raw) : DEFAULT_CLAUDE_TIMEOUT_MS });
  });
  router.post('/settings/response-timeout', (req, res) => {
    const timeoutMs = parseInt(req.body.timeoutMs);
    if (isNaN(timeoutMs) || timeoutMs < 0) {
      return res.status(400).json({ error: 'Invalid timeout value' });
    }
    SettingsService.set(db, 'responseTimeoutMs', String(timeoutMs));
    res.json({ success: true });
  });

  // Agent chat settings (daily limit, circuit breaker)
  router.get('/settings/agent-chat', (req, res) => {
    const dailyLimit = SettingsService.get(db, 'agentChatDailyLimit') || '20';
    const circuitBreakerLimit = SettingsService.get(db, 'agentChatCircuitBreakerLimit') || '50';
    res.json({ dailyLimit: parseInt(dailyLimit), circuitBreakerLimit: parseInt(circuitBreakerLimit) });
  });
  router.post('/settings/agent-chat', (req, res) => {
    if (req.body.dailyLimit !== undefined) {
      SettingsService.set(db, 'agentChatDailyLimit', String(req.body.dailyLimit));
    }
    if (req.body.circuitBreakerLimit !== undefined) {
      SettingsService.set(db, 'agentChatCircuitBreakerLimit', String(req.body.circuitBreakerLimit));
    }
    res.json({ success: true });
  });

  // ============ Environment Variables ============

  const ALLOWED_ENV_KEYS = new Set(AIRegistryService.getAllowedEnvKeys(db));

  router.get('/env/check/:key', (req, res) => {
    const { key } = req.params;
    if (!ALLOWED_ENV_KEYS.has(key)) {
      return res.status(400).json({ error: 'Key not whitelisted' });
    }
    const envVar = EnvService.get(db, key);
    const inProcess = !!process.env[key];
    res.json({ exists: !!(envVar || inProcess) });
  });

  router.post('/env/set', (req, res) => {
    const { key, value } = req.body;
    if (!key || !value) {
      return res.status(400).json({ error: 'key and value required' });
    }
    if (!ALLOWED_ENV_KEYS.has(key)) {
      return res.status(400).json({ error: 'Key not whitelisted' });
    }
    EnvService.set(db, key, value);
    res.json({ success: true });
  });

  // ============ Backend Auth ============

  // Validate an API key by making a lightweight test call to the backend
  router.post('/backend/validate-key', async (req, res) => {
    const { backend, key } = req.body;
    if (!backend || !key) {
      return res.status(400).json({ error: 'Missing backend or key' });
    }

    try {
      const container = AIRegistryService.getContainer(db, backend);
      if (!container) return res.status(400).json({ error: 'Unknown backend' });

      const provider = AIRegistryService.getProvider(db, container.provider_id);
      if (!provider || !provider.validation_url) {
        return res.status(400).json({ error: 'No validation available for this backend' });
      }

      const headers = {};
      let url = provider.validation_url;

      // Apply auth style
      if (provider.validation_auth_style === 'x-api-key') {
        headers['x-api-key'] = key;
      } else if (provider.validation_auth_style === 'bearer') {
        headers['Authorization'] = `Bearer ${key}`;
      } else if (provider.validation_auth_style === 'query') {
        url += `?key=${encodeURIComponent(key)}`;
      }

      // Apply extra validation headers (e.g. anthropic-version)
      if (provider.validation_headers) {
        try {
          Object.assign(headers, JSON.parse(provider.validation_headers));
        } catch (e) {}
      }

      const resp = await fetch(url, { headers });
      const valid = resp.ok;
      res.json({ valid, error: valid ? null : `Invalid API key (${resp.status})` });
    } catch (err) {
      res.json({ valid: false, error: `Connection failed: ${err.message}` });
    }
  });

  // Open URL in system browser (apps run in BrowserView, can't access shell.openExternal)
  router.post('/open-external', (req, res) => {
    const { url } = req.body;
    if (!url || typeof url !== 'string' || !url.startsWith('https://')) {
      return res.status(400).json({ error: 'Invalid URL' });
    }
    const { exec: execCmd } = require('child_process');
    execCmd(`open "${url.replace(/"/g, '')}"`);
    res.json({ success: true });
  });

  router.get('/backend/auth-status/:backend', (req, res) => {
    const { backend } = req.params;
    const container = AIRegistryService.getContainer(db, backend);
    if (!container) {
      return res.status(400).json({ error: 'Unknown backend' });
    }

    const provider = AIRegistryService.getProvider(db, container.provider_id);
    const envKey = provider.api_key_env;
    const envVar = EnvService.get(db, envKey);
    const inProcess = !!process.env[envKey];
    const hasApiKey = !!(envVar || inProcess);

    // Detect login state via CLI status check or file-based auth
    let loggedIn = false;
    if (container.auth_status_command) {
      try {
        const statusCmd = JSON.parse(container.auth_status_command);
        const { execSync } = require('child_process');
        const statusEnv = { ...process.env };
        delete statusEnv.CLAUDECODE;
        const output = execSync(`${statusCmd.cmd} ${statusCmd.args.join(' ')}`, {
          env: statusEnv,
          timeout: 5000,
          encoding: 'utf-8'
        });
        const statusData = JSON.parse(output.trim());
        loggedIn = !!statusData.loggedIn;
      } catch (e) {
        // CLI not available or status check failed
      }
    }
    if (!loggedIn && container.auth_file_path) {
      try {
        loggedIn = fs.existsSync(path.join(os.homedir(), container.auth_file_path));
      } catch (e) {}
    }

    // Ready if either login or API key is available
    const ready = loggedIn || hasApiKey;

    res.json({
      hasApiKey,
      loggedIn,
      ready
    });
  });

  // Backend login — spawns `claude auth login` (or equivalent) which opens browser for OAuth
  router.post('/backend/login/:backend', (req, res) => {
    const { backend } = req.params;
    const container = AIRegistryService.getContainer(db, backend);
    if (!container || !container.has_login) {
      return res.status(400).json({ error: 'Backend does not support login' });
    }

    // Determine login command and args
    const loginArgs = container.login_trigger_args
      ? JSON.parse(container.login_trigger_args)
      : (container.login_command || '').split(' ').slice(1);
    const loginCmd = container.command;

    // Check if CLI exists before spawning — prevents indefinite hang
    const { execSync, spawn: spawnProcess } = require('child_process');
    try {
      execSync(`which ${loginCmd}`, { encoding: 'utf-8', timeout: 5000 });
    } catch {
      return res.status(400).json({ error: `${loginCmd} CLI not found. Please install it first.` });
    }

    // Strip CLAUDECODE env var — OS8 runs inside Electron which may set it,
    // and Claude CLI refuses to launch if it detects a parent Claude session
    const loginEnv = { ...process.env };
    delete loginEnv.CLAUDECODE;
    const child = spawnProcess(loginCmd, loginArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: loginEnv
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (exitCode) => {
      // Check file-based auth as fallback (e.g. Gemini exit code 1 can still mean success)
      const fileAuthOk = container.auth_file_path &&
        fs.existsSync(path.join(os.homedir(), container.auth_file_path));

      if (exitCode === 0 || fileAuthOk) {
        // Update account status so routing cascade knows login is available
        RoutingService.updateAccountStatus(db, container.provider_id, {
          login_status: 'active',
          last_checked_at: new Date().toISOString()
        });

        if (!res.headersSent) res.json({ success: true });
      } else {
        if (!res.headersSent) res.status(500).json({ error: 'Login failed', stderr: stderr.trim(), stdout: stdout.trim() });
      }
    });

    child.on('error', (err) => {
      if (!res.headersSent) {
        res.status(500).json({ error: `Failed to start ${loginCmd}: ${err.message}` });
      }
    });

    // Timeout after 90 seconds
    setTimeout(() => {
      try { child.kill(); } catch (e) {}
      if (!res.headersSent) {
        res.status(504).json({ error: 'Login timed out. Try using an API key instead.' });
      }
    }, 90 * 1000);
  });

  return router;
}

module.exports = createSettingsApiRouter;
