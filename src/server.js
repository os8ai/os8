const express = require('express');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { APPS_DIR, CORE_DIR, AVATARS_DIR, BLOB_DIR, AppService, AgentService, CoreService, SettingsService, ConnectionsService, CapabilityService, EnvService, PROVIDERS } = require('./db');
const { TTSService, JobsFileService, JobSchedulerService } = require('./services');
const CapabilitySyncService = require('./services/capability-sync');
const DigestEngine = require('./services/digest-engine');
const { MemoryService } = require('./assistant/memory');
const ConversationService = require('./services/conversation');
const { MemoryWatcher } = require('./assistant/memory-watcher');
const { AssistantProcess } = require('./assistant/process');
const { ensureTelegramWatchers, startTelegramWatcherForAgent } = require('./server-telegram');
const createSystemRouter = require('./routes/system');
const createSkillsRouter = require('./routes/skills');
const createOAuthRouter = require('./routes/oauth');
const createConnectionsRouter = require('./routes/connections');
const createGoogleRouter = require('./routes/google');
const createAssistantRouter = require('./routes/assistant');
const createVoiceRouter = require('./routes/voice');
const createVoiceStreamHandler = require('./routes/voice-stream');
const createTTSStreamHandler = require('./routes/tts-stream');
const createTranscribeRouter = require('./routes/transcribe');
const createSpeakRouter = require('./routes/speak');
const createImageGenRouter = require('./routes/imagegen');
const createVoiceMessageRouter = require('./routes/voicemessage');
const createCallRouter = require('./routes/call');
const createCallStreamHandler = require('./routes/call-stream');
const createJobsRouter = require('./routes/jobs');
const createAgentJobsRouter = require('./routes/agent-jobs');
const createBuzzRouter = require('./routes/buzz');
const createEmbodimentRouter = require('./routes/embodiment');
const createJournalRouter = require('./routes/journal');
const createImagesRouter = require('./routes/images');
const createSimRouter = require('./routes/sim');
const createYouTubeRouter = require('./routes/youtube');
const createXRouter = require('./routes/x');
const createTelegramRouter = require('./routes/telegram');
const createAppDbRouter = require('./routes/app-db');
const createAppBlobRouter = require('./routes/app-blob');
const createIconRouter = require('./routes/icons');
const createAIRegistryRouter = require('./routes/ai-registry');
const AIRegistryService = require('./services/ai-registry');
const BillingService = require('./services/billing');
const createSettingsApiRouter = require('./routes/settings-api');
const assistantState = require('./routes/assistant-state');
const agentState = require('./services/agent-state');
const createAgentsRouter = require('./routes/agents');
const WhisperService = require('./services/whisper');
const WhisperStreamService = require('./services/whisper-stream');
const AppDbService = require('./services/app-db');
const McpServerService = require('./services/mcp-server');
const TunnelService = require('./services/tunnel');
const pages = require('./templates/pages');

const DEFAULT_PORT = 8888;
let currentPort = DEFAULT_PORT;
let server = null;
let db = null;
let viteServer = null;

// Global memory service for cache pre-loading
let globalMemoryService = null;
let memoryCacheRefreshTimer = null;
let catalogSyncTimer = null;

// OAuth callback handler (set by main.js to notify renderer)
let oauthCompleteCallback = null;

function setOAuthCompleteCallback(callback) {
  oauthCompleteCallback = callback;
}

// App created callback handler (set by main.js to notify renderer)
let appCreatedCallback = null;

function setAppCreatedCallback(callback) {
  appCreatedCallback = callback;
}

// App updated callback handler (set by main.js to notify renderer)
let appUpdatedCallback = null;

function setAppUpdatedCallback(callback) {
  appUpdatedCallback = callback;
}

// Agent changed callback handler (set by main.js to notify renderer)
let agentChangedCallback = null;

function setAgentChangedCallback(callback) {
  agentChangedCallback = callback;
}

// Build event callbacks (set by main.js to notify renderer)
let buildStartedCallback = null;
let buildCompletedCallback = null;

function setBuildStartedCallback(callback) {
  buildStartedCallback = callback;
}

function setBuildCompletedCallback(callback) {
  buildCompletedCallback = callback;
}

/**
 * Pre-load memory cache at startup for all agents
 * This makes the first agent message fast instead of waiting for chunk loading
 */
function preloadMemoryCache() {
  if (!db) return;

  const agents = AgentService.getAll(db);
  if (agents.length === 0) {
    console.log('[Memory] No agents found, skipping cache pre-load');
    return;
  }

  for (const agent of agents) {
    const { agentDir } = AgentService.getPaths(agent.app_id, agent.id);
    try {
      const memory = new MemoryService(agentDir, db, agent.id);
      console.log(`[Memory] Cache pre-loaded for ${agent.name} (${agent.id})`);

      // Store in per-agent state
      const agentStateObj = agentState.getAgentState(agent.id);
      agentStateObj.memory = memory;
    } catch (err) {
      console.warn(`[Memory] Failed to pre-load cache for ${agent.name}:`, err.message);
    }
  }

  // Also set the default agent's memory via the legacy shim
  const defaultAgent = AgentService.getDefault(db);
  if (defaultAgent) {
    const defaultState = agentState.getAgentState(defaultAgent.id);
    if (defaultState.memory) {
      globalMemoryService = defaultState.memory;
    }
  }
}

/**
 * Schedule memory cache refresh at 3am local time daily
 * This ensures cache is fresh when user wakes up
 */
const CACHE_REFRESH_HOUR = 3; // 3 AM local time

function scheduleMemoryCacheRefresh() {
  // Clear any existing timer
  if (memoryCacheRefreshTimer) {
    clearTimeout(memoryCacheRefreshTimer);
  }

  // Calculate ms until next 3am local time
  const now = new Date();
  const target = new Date(now);
  target.setHours(CACHE_REFRESH_HOUR, 0, 0, 0);

  // If it's past target hour today, schedule for tomorrow
  if (now >= target) {
    target.setDate(target.getDate() + 1);
  }

  const msUntilRefresh = target.getTime() - now.getTime();

  console.log(`[Memory] Scheduled cache refresh at ${CACHE_REFRESH_HOUR}am local time (in ${Math.round(msUntilRefresh / 3600000)}h)`);

  memoryCacheRefreshTimer = setTimeout(() => {
    console.log(`[Memory] ${CACHE_REFRESH_HOUR}am refresh triggered`);

    // Refresh the cache for all agents
    const allAgentIds = agentState.getAllAgentIds();
    for (const agentId of allAgentIds) {
      const aState = agentState.getAgentState(agentId);
      if (aState.memory) {
        aState.memory.invalidateChunkCache();
        aState.memory._preloadChunks();
      }
    }
    if (allAgentIds.length === 0) {
      preloadMemoryCache();
    }

    // Schedule next refresh
    scheduleMemoryCacheRefresh();
  }, msUntilRefresh);
}

/**
 * Schedule daily catalog sync at 4am local time.
 * Pulls the full ClawHub skill catalog into our local DB.
 */
const CATALOG_SYNC_HOUR = 4; // 4 AM local time

function scheduleCatalogSync() {
  if (catalogSyncTimer) {
    clearTimeout(catalogSyncTimer);
  }

  const now = new Date();
  const target = new Date(now);
  target.setHours(CATALOG_SYNC_HOUR, 0, 0, 0);

  if (now >= target) {
    target.setDate(target.getDate() + 1);
  }

  const msUntilSync = target.getTime() - now.getTime();

  console.log(`[SkillCatalog] Scheduled sync at ${CATALOG_SYNC_HOUR}am local time (in ${Math.round(msUntilSync / 3600000)}h)`);

  catalogSyncTimer = setTimeout(async () => {
    console.log(`[SkillCatalog] ${CATALOG_SYNC_HOUR}am sync triggered`);
    try {
      const SkillCatalogService = require('./services/skill-catalog');
      const result = await SkillCatalogService.sync(db);
      if (result.synced > 0) {
        // Generate embeddings for new entries in background
        SkillCatalogService.generateEmbeddings(db).catch(e =>
          console.warn('[SkillCatalog] Embedding generation error:', e.message)
        );
      }
    } catch (e) {
      console.warn('[SkillCatalog] Scheduled sync failed:', e.message);
    }

    // Schedule next sync
    scheduleCatalogSync();
  }, msUntilSync);
}

// Generate call URL (uses tunnel URL if configured, otherwise localhost)
function getCallUrl(callId, token) {
  const tunnelUrl = db ? SettingsService.get(db, 'tunnelUrl') : null;
  const baseUrl = tunnelUrl || `http://localhost:${currentPort}`;
  return `${baseUrl}/call/${callId}?token=${token}`;
}

// Default timing values
const DEFAULT_REFLECTION_DELAY_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_CLAUDE_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

// Reflection is now handled via timed jobs calling the reflection skill
// See ~/os8/skills/reflection/ for the skill implementation



/**
 * Start memory watcher for a specific agent
 * @param {object} agent - Agent app record
 * @returns {boolean} Whether watcher started successfully
 */
function startMemoryWatcherForAgent(agent) {
  const agentStateObj = agentState.getAgentState(agent.id);

  // Stop any existing watcher
  if (agentStateObj.memoryWatcher) {
    agentStateObj.memoryWatcher.stop();
    agentStateObj.memoryWatcher = null;
  }

  const { agentDir: appPath } = AgentService.getPaths(agent.app_id || agent.id, agent.id);

  // Initialize memory service if not exists
  let memory = agentStateObj.memory;
  if (!memory) {
    memory = new MemoryService(appPath, db, agent.id);
    agentStateObj.memory = memory;
  }

  // Check for JSON migration
  const jsonIndexPath = path.join(appPath, 'memory-index.json');
  if (fs.existsSync(jsonIndexPath)) {
    console.log(`Memory [${agent.name}]: Found legacy JSON index, migrating to SQLite...`);
    memory.migrateFromJson()
      .then((result) => {
        if (result) {
          console.log(`Memory [${agent.name}]: Migrated ${result.chunks} chunks from ${result.sources} sources`);
        }
      })
      .catch((err) => {
        console.error(`Memory [${agent.name}]: Migration failed:`, err.message);
      });
  }

  // Create and start watcher
  const watcher = new MemoryWatcher(memory, appPath, {
    onLog: (msg) => {
      console.log(`[Memory ${agent.name}] ${msg}`);
    },
    onError: (err) => {
      console.error(`[Memory ${agent.name}] ${err}`);
    }
  });

  try {
    watcher.start();
    agentStateObj.memoryWatcher = watcher;
    console.log(`Memory watcher started for ${agent.name}`);
    return true;
  } catch (err) {
    console.error(`Failed to start memory watcher for ${agent.name}:`, err.message);
    return false;
  }
}

// Auto-start memory watchers for all agents

function ensureMemoryWatcher() {
  console.log('ensureMemoryWatcher called');

  if (!db) return false;

  const agents = AgentService.getOperational(db);
  if (agents.length === 0) {
    console.log('No agents found, skipping memory watcher');
    return false;
  }

  let started = false;
  for (const agent of agents) {
    if (startMemoryWatcherForAgent(agent)) {
      started = true;
    }
  }

  // Keep backward compat: set on legacy shim for default agent
  const defaultAgent = AgentService.getDefault(db);
  if (defaultAgent) {
    const defaultState = agentState.getAgentState(defaultAgent.id);
    if (defaultState.memoryWatcher) {
      assistantState.setMemoryWatcher(defaultState.memoryWatcher);
    }
    if (defaultState.memory) {
      assistantState.setMemory(defaultState.memory);
    }
  }

  return started;
}

async function createServer() {
  // Initialize per-agent state manager with DB reference
  agentState.setDb(db);

  const app = express();

  // Parse JSON bodies for API endpoints
  app.use(express.json({ limit: '10mb' }));

  // Make db available to routes via app.locals
  app.locals.db = db;

  // ============ Route Modules ============
  app.use('/api/system', createSystemRouter(db));
  app.use('/api/ai', createAIRegistryRouter(db));
  const skillsRouter = createSkillsRouter(db, CapabilityService);
  app.use('/api/skills', skillsRouter);
  app.use('/api/capabilities', skillsRouter);
  app.use('/oauth', createOAuthRouter(db, {
    ConnectionsService,
    PROVIDERS,
    pages,
    getPort: () => currentPort,
    getOAuthCompleteCallback: () => oauthCompleteCallback
  }));
  app.use('/api/connections', createConnectionsRouter(db, { ConnectionsService, PROVIDERS }));
  app.use('/api/google', createGoogleRouter(db, { ConnectionsService, PROVIDERS }));
  app.use('/api', createSettingsApiRouter(db, {
    SettingsService,
    EnvService,
    AgentService,
    AIRegistryService,
    ensureTelegramWatchers,
    agentState,
    DEFAULT_CLAUDE_TIMEOUT_MS
  }));

  // Apps API (create + build)
  const createAppsRouter = require('./routes/apps');
  const AppBuilderService = require('./services/app-builder');

  // Wire build event callbacks to AppBuilderService
  AppBuilderService.setBuildStartedCallback((data) => {
    console.log(`[Server] buildStartedCallback relay: status=${data.status}, buildId=${data.buildId}, hasOuterCallback=${!!buildStartedCallback}`);
    if (buildStartedCallback) buildStartedCallback(data);
  });
  AppBuilderService.setBuildCompletedCallback((data) => {
    if (buildCompletedCallback) buildCompletedCallback(data);
  });

  app.use('/api/apps', createAppsRouter(db, {
    AppService,
    generateClaudeMd: require('./services/app').generateClaudeMd,
    scaffoldApp: require('./services/app').scaffoldApp,
    AppBuilderService,
    appCreatedCallback: () => appCreatedCallback,
    appUpdatedCallback: () => appUpdatedCallback,
    getPort,
    getAssistantAppId: () => {
      const assistant = AgentService.getDefault(db);
      return assistant ? assistant.app_id : null;
    }
  }));

  // App verification: /inspect (runtime, headless browser) + /check (compile, Vite graph walk)
  const createInspectRouter = require('./routes/inspect');
  const AppInspectorService = require('./services/app-inspector');
  const AppCheckerService = require('./services/app-checker');
  app.use('/api/apps', createInspectRouter(db, {
    AppService,
    AppInspectorService,
    AppCheckerService,
    getPort,
    getViteServer
  }));

  // Per-app SQLite database
  app.use('/api/apps/:appId/db', createAppDbRouter(db, { AppService, AppDbService }));

  // Per-app blob storage (file uploads, reads, listing)
  app.use('/api/apps/:appId/blob', createAppBlobRouter(db, { AppService }));

  // App icon images (upload, AI generation, serving)
  const ImageGenService = require('./services/imagegen');
  app.use('/api/icons', createIconRouter(db, { AppService, ImageGenService }));

  // Agent management
  const { generateAssistantClaudeMd, scaffoldAssistantApp } = require('./services/app');
  app.use('/api/agents', createAgentsRouter(db, {
    AgentService,
    AppService,
    SimService: require('./services/sim').SimService,
    JobsFileService,
    scaffoldAssistantApp,
    generateAssistantClaudeMd,
    onAgentChanged: (agent) => agentChangedCallback && agentChangedCallback(agent),
    onTelegramConfigChange: (updatedAgent) => {
      const freshAgent = AgentService.getById(db, updatedAgent.id);
      const globalEnabled = SettingsService.get(db, 'telegramEnabled');
      const isOperational = freshAgent && (freshAgent.visibility || 'visible') !== 'off';
      if (globalEnabled !== 'false' && isOperational && freshAgent.telegram_bot_token) {
        startTelegramWatcherForAgent(db, freshAgent);
      } else {
        // Stop watcher if global disabled, token removed, or agent turned off
        const aState = agentState.getAgentState(updatedAgent.id);
        if (aState.telegramWatcher) {
          aState.telegramWatcher.stop();
          aState.telegramWatcher = null;
          console.log(`Telegram: Stopped watcher for ${updatedAgent.name}`);
        }
      }
      // Also stop/start memory watcher based on visibility
      if (freshAgent) {
        const aState = agentState.getAgentState(freshAgent.id);
        if (!isOperational && aState.memoryWatcher) {
          aState.memoryWatcher.stop();
          aState.memoryWatcher = null;
          console.log(`Memory: Stopped watcher for ${freshAgent.name} (visibility off)`);
        } else if (isOperational && !aState.memoryWatcher) {
          startMemoryWatcherForAgent(freshAgent);
        }
      }
    }
  }));

  // Agent-to-agent messaging
  const { createAgentChatRouter, getThreadSSEClients } = require('./routes/agent-chat');
  const AgentChatService = require('./services/agent-chat');
  const { ThreadOrchestrator } = require('./services/thread-orchestrator');

  // Initialize thread orchestrator and recover any expired circuit breakers
  ThreadOrchestrator.init({ db, getThreadSSEClients });
  ThreadOrchestrator.recoverExpiredBreakers();

  app.use('/api/agent-chat', createAgentChatRouter(db, {
    AgentChatService,
    AgentService,
    SettingsService,
    ThreadOrchestrator,
    getAgentState: agentState.getAgentState
  }));

  // Agent-scoped assistant routes: /api/agent/:agentId/* → same handlers with req.agentId
  app.use('/api/agent/:agentId', (req, res, next) => {
    req.agentId = req.params.agentId;
    next();
  }, createAssistantRouter(db, {
    AppService,
    APPS_DIR,
    MemoryService,
    AssistantProcess,
    SettingsService,
    state: assistantState,
    DEFAULT_CLAUDE_TIMEOUT_MS,
  }));

  // Legacy assistant routes (backward compat) — uses default agent
  app.use('/api/assistant', createAssistantRouter(db, {
    AppService,
    APPS_DIR,
    MemoryService,
    AssistantProcess,
    SettingsService,
    state: assistantState,
    DEFAULT_CLAUDE_TIMEOUT_MS,
  }));
  app.use('/api/voice', createVoiceRouter(db, { EnvService, SettingsService }));
  app.use('/api/transcribe', createTranscribeRouter(db, {}));
  app.use('/api/youtube', createYouTubeRouter(db, {}));
  app.use('/api/x', createXRouter(db, {}));
  app.use('/api/speak', createSpeakRouter(db, { AgentService }));
  app.use('/api/imagegen', createImageGenRouter(db, {}));
  app.use('/api/telegram', createTelegramRouter(db, {
    AgentService,
    SettingsService,
    getTelegramWatcher: (agentId) => {
      const aState = agentState.getAgentState(agentId);
      return aState.telegramWatcher;
    }
  }));
  app.use('/api/voicemessage', createVoiceMessageRouter(db, { AgentService }));
  app.use('/api/call', createCallRouter(db, { getCallUrl }));
  app.use('/api/jobs', createJobsRouter(JobsFileService, JobSchedulerService, db));
  app.use('/api/buzz', createBuzzRouter(db, { AppService }));
  app.use('/api/embodiment', createEmbodimentRouter(db, { AppService }));
  app.use('/api/agent/:agentId/jobs', createAgentJobsRouter(db, { JobsFileService, JobSchedulerService }));
  app.use('/api/agent/:agentId/journal', (req, res, next) => { req.agentId = req.params.agentId; next(); }, createJournalRouter(db, { AppService, APPS_DIR }));
  app.use('/api/assistant/journal', createJournalRouter(db, { AppService, APPS_DIR }));
  app.use('/api/agent/:agentId/images', (req, res, next) => { req.agentId = req.params.agentId; next(); }, createImagesRouter(db, { AppService }));
  app.use('/api/assistant/images', createImagesRouter(db, { AppService }));

  // MCP routes (proxy + server management)
  const createMcpRouter = require('./routes/mcp');
  const McpCatalogService = require('./services/mcp-catalog');
  app.use('/api/mcp', createMcpRouter(db, { McpServerService, CapabilitySyncService, McpCatalogService }));

  // Plans routes (multi-step execution plans)
  const createPlansRouter = require('./routes/plans');
  const PlanService = require('./services/plan');
  const { PlanExecutorService } = require('./services/plan-executor');
  app.use('/api/plans', createPlansRouter(db, { PlanService, PlanExecutorService, AgentService }));

  // Sim routes (agent simulation: reverie, journal, snapshot)
  const SimService = require('./services/sim');
  app.use('/api/agent/:agentId/sim', (req, res, next) => { req.agentId = req.params.agentId; next(); }, createSimRouter(db, { SimService, SettingsService, getPort }));

  // Vault routes (knowledge layer)
  const createVaultRouter = require('./routes/vault');
  const VaultService = require('./services/vault');
  const VaultIndexerService = require('./services/vault-indexer');
  const VaultGraphService = require('./services/vault-graph');
  app.use('/api/vault', createVaultRouter(db, { VaultService, VaultIndexerService, VaultGraphService }));

  // Call page route - renders mobile-first call UI
  app.get('/call/:callId', (req, res) => {
    const { callId } = req.params;
    const token = req.query.token || '';

    // Get assistant info for display
    const assistant = db ? AgentService.getDefault(db) : null;
    let assistantName = 'Assistant';
    if (assistant) {
      const config = AgentService.getConfig(db, assistant.id) || {};
      assistantName = config.assistantName || 'Assistant';
    }

    res.send(pages.call({
      callId,
      token,
      assistantName,
      assistantEmoji: assistantName[0]?.toUpperCase() || 'A'
    }));
  });

  // Serve shared modules for apps (voice-stream-core, etc.)
  app.use('/shared', express.static(path.join(__dirname, 'shared')));

  // Serve blob files
  // 3+ segments: /blob/{agentId}/{folder}/.../{filename} — agent-specific
  // 2 segments:  /blob/{folder}/{filename} — searches default agent, then all
  app.get('/blob/*path', (req, res) => {
    const segments = req.params.path;
    if (!segments || segments.length === 0 || segments.some(s => s === '..')) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    if (segments.length >= 3) {
      // Agent-specific: first segment is agentId
      const agentId = segments[0];
      const subPath = segments.slice(1).join('/');
      const agent = AgentService.getById(db, agentId);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });

      const { agentBlobDir } = AgentService.getPaths(agent.app_id, agent.id);
      const filePath = path.join(agentBlobDir, subPath);
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
      return res.sendFile(filePath);
    }

    if (segments.length === 2) {
      // No agent ID — try default agent first, then search all
      const [folder, filename] = segments;

      const assistant = AgentService.getDefault(db);
      if (assistant) {
        const { agentBlobDir } = AgentService.getPaths(assistant.app_id, assistant.id);
        const filePath = path.join(agentBlobDir, folder, filename);
        if (fs.existsSync(filePath)) return res.sendFile(filePath);
      }

      const agents = AgentService.getAll(db);
      for (const agent of agents) {
        if (assistant && agent.id === assistant.id) continue;
        const { agentBlobDir } = AgentService.getPaths(agent.app_id, agent.id);
        const filePath = path.join(agentBlobDir, folder, filename);
        if (fs.existsSync(filePath)) return res.sendFile(filePath);
      }
    }

    return res.status(404).json({ error: 'File not found' });
  });

  // Serve static files from avatars directory
  app.use('/avatars', express.static(AVATARS_DIR, {
    setHeaders: (res, filePath) => {
      try {
        const stats = fs.statSync(filePath);
        res.setHeader('Content-Length', stats.size);
        if (filePath.endsWith('.glb')) {
          res.setHeader('Content-Type', 'model/gltf-binary');
        }
      } catch (e) {
        // File stats unavailable, proceed without headers
      }
    }
  }));

  // Check if Core is ready and set up Vite
  if (CoreService.isReady()) {
    try {
      // Kill any process holding Vite's HMR port (cleanup from crashed sessions)
      try {
        execSync('lsof -ti :5174 | xargs kill -9 2>/dev/null', { stdio: 'ignore' });
      } catch (e) {
        // Port is free, nothing to kill
      }

      // Dynamically load Vite from Core's node_modules
      const vitePath = path.join(CORE_DIR, 'node_modules', 'vite');
      const { createServer: createViteServer } = require(vitePath);

      // Create Vite server in middleware mode
      viteServer = await createViteServer({
        configFile: path.join(CORE_DIR, 'vite.config.js'),
        root: APPS_DIR,
        server: {
          middlewareMode: true,
          hmr: {
            port: 5174
          }
        },
        appType: 'custom'
      });

      // Use Vite's connect instance as middleware
      app.use(viteServer.middlewares);

      console.log('Vite middleware enabled for React/JSX support');
    } catch (err) {
      console.error('Failed to initialize Vite middleware:', err);
      console.log('Falling back to static file serving');
    }
  } else {
    console.log('Core not ready, using static file serving');
  }

  // Serve app HTML files with Vite transformation
  // Accepts both appId and slug for backwards compatibility (will remove slug fallback later)
  app.use('/:identifier', async (req, res, next) => {
    const identifier = req.params.identifier;

    // First try lookup by appId
    let appRecord = db ? AppService.getById(db, identifier) : null;

    // Fall back to slug lookup for backwards compatibility
    if (!appRecord) {
      appRecord = db ? AppService.getBySlug(db, identifier) : null;
    }

    if (!appRecord) {
      return next();
    }

    const appPath = path.join(APPS_DIR, appRecord.id);

    // Helper to serve index.html with Vite transformation
    async function serveAppHtml() {
      const indexPath = path.join(appPath, 'index.html');
      if (!fs.existsSync(indexPath)) return false;

      let html = fs.readFileSync(indexPath, 'utf-8');
      if (viteServer) {
        // Fix paths in HTML to be relative to the app's directory
        html = html.replace(/src="\/src\//g, `src="/${appRecord.id}/src/`);
        html = await viteServer.transformIndexHtml(`/${appRecord.id}/`, html);
      }
      res.setHeader('Content-Type', 'text/html');
      res.send(html);
      return true;
    }

    // Handle root request (serve index.html)
    if (req.path === '/' || req.path === '') {
      try {
        if (await serveAppHtml()) return;
      } catch (err) {
        console.error('Error serving HTML:', err);
        return next(err);
      }
    }

    // Check for direct file request
    const filePath = path.join(appPath, req.path);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return res.sendFile(filePath);
    }

    // SPA fallback: serve index.html for client-side routes (React Router)
    try {
      if (await serveAppHtml()) return;
    } catch (err) {
      console.error('Error serving SPA fallback:', err);
      return next(err);
    }

    next();
  });

  // Home page
  app.get('/', (req, res) => {
    res.send(pages.home());
  });

  // 404 handler
  app.use((req, res) => {
    res.status(404).send(pages.notFound());
  });

  // Global error safety net — catches unhandled errors from routes
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[Server] Unhandled route error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return app;
}

async function startServer(port = null, database = null) {
  db = database;

  // Use fixed port from settings (default 8888)
  const savedPort = db ? SettingsService.get(db, 'os8Port') : null;
  currentPort = savedPort ? parseInt(savedPort, 10) : DEFAULT_PORT;

  return new Promise(async (resolve, reject) => {
    try {
      const app = await createServer();
      server = app.listen(currentPort, () => {
        console.log(`OS8 server running at http://localhost:${currentPort}`);

        // Set up WebSocket handler for voice streaming
        const setupVoiceStream = createVoiceStreamHandler({
          services: { WhisperStreamService }
        });
        setupVoiceStream(server);

        // Set up WebSocket handler for TTS streaming
        const setupTTSStream = createTTSStreamHandler({
          db,
          services: { TTSService, EnvService }
        });
        setupTTSStream(server);

        // Set up WebSocket handler for voice calls
        const setupCallStream = createCallStreamHandler({
          db,
          services: { WhisperStreamService, TTSService, EnvService },
          APPS_DIR,
          AppService,
          state: assistantState
        });
        setupCallStream(server);

        // Auto-start services after a short delay
        setTimeout(() => {
          // Clean up incomplete agents from abandoned setup flows
          try {
            AgentService.cleanupIncomplete(db);
          } catch (e) {
            console.warn('[Startup] Agent cleanup error:', e.message);
          }

          // Sync bundled skills to ~/os8/skills/ and index into capabilities table
          try {
            const bundledSkillsDir = path.join(__dirname, '..', 'skills');
            CapabilitySyncService.installBundledSkills(bundledSkillsDir);
            CapabilitySyncService.syncSkills(db);
            const routeMetas = CapabilitySyncService.collectRouteMetas();
            CapabilitySyncService.syncApis(db, routeMetas);
            CapabilityService.rebuildFts(db);
            CapabilityService.refreshAvailability(db);
            CapabilityService.generateEmbeddings(db).catch(e =>
              console.warn('[Startup] Capabilities embedding generation error:', e.message)
            );

            // Resume any plans interrupted by crash/restart
            try {
              const stalePlans = PlanService.getByStatus(db, 'executing');
              if (stalePlans.length > 0) {
                console.log(`[Startup] Resuming ${stalePlans.length} interrupted plan(s)`);
                for (const plan of stalePlans) {
                  PlanExecutorService.resume(db, plan.id).catch(e =>
                    console.warn(`[Startup] Plan resume error for ${plan.id}:`, e.message)
                  );
                }
              }
            } catch (e) {
              console.warn('[Startup] Plan crash recovery error:', e.message);
            }

            // Auto-review pending catalog skills in background
            try {
              const SkillReviewService = require('./services/skill-review');
              const pendingSkills = db.prepare(
                "SELECT id, name FROM capabilities WHERE source = 'catalog' AND review_status = 'pending' AND type = 'skill'"
              ).all();
              if (pendingSkills.length > 0) {
                console.log(`[Startup] Queuing security reviews for ${pendingSkills.length} catalog skills`);
                // Review sequentially in background to avoid overwhelming the API
                (async () => {
                  for (const skill of pendingSkills) {
                    try {
                      await SkillReviewService.review(db, skill.id);
                    } catch (e) {
                      console.warn(`[Startup] Review failed for ${skill.name}:`, e.message);
                    }
                  }
                  console.log(`[Startup] Completed security reviews for ${pendingSkills.length} catalog skills`);
                })().catch(e => console.warn('[Startup] Background review error:', e.message));
              }
            } catch (e) {
              console.warn('[Startup] Skill review init error:', e.message);
            }

            // Seed catalog from bundled snapshot (first boot only)
            const SkillCatalogService = require('./services/skill-catalog');
            const catalogSeeded = SkillCatalogService.seedFromSnapshot(db);
            if (catalogSeeded > 0) {
              console.log(`[Startup] Seeded ${catalogSeeded} catalog entries from snapshot`);
              // Generate catalog embeddings in background
              SkillCatalogService.generateEmbeddings(db).catch(e =>
                console.warn('[Startup] Catalog embedding generation error:', e.message)
              );
            }

            // Initial ClawHub catalog sync — skip if synced within 12h
            const catalogStats = SkillCatalogService.getStats(db);
            const lastSynced = catalogStats.last_synced ? new Date(catalogStats.last_synced + 'Z') : null;
            const hoursSinceSync = lastSynced ? (Date.now() - lastSynced.getTime()) / 3600000 : Infinity;
            if (hoursSinceSync > 12) {
              SkillCatalogService.sync(db).then(result => {
                if (result.synced > 0) {
                  SkillCatalogService.generateEmbeddings(db).catch(e =>
                    console.warn('[Startup] Catalog embedding generation error:', e.message)
                  );
                }
              }).catch(e => {
                console.warn('[Startup] Catalog sync error:', e.message);
              });
            } else {
              console.log(`[SkillCatalog] Skipping startup sync (last synced ${Math.round(hoursSinceSync)}h ago)`);
            }

            // Schedule daily catalog sync at 4am
            scheduleCatalogSync();
          } catch (e) {
            console.warn('[Startup] Skills sync error:', e.message);
          }

          // Seed MCP catalog from snapshot (first boot only)
          try {
            const McpCatalogService = require('./services/mcp-catalog');
            const mcpSeeded = McpCatalogService.seedFromSnapshot(db);
            if (mcpSeeded > 0) {
              console.log(`[Startup] Seeded ${mcpSeeded} MCP catalog entries from snapshot`);
            }
          } catch (e) {
            console.warn('[Startup] MCP catalog seed error:', e.message);
          }

          // Auto-start MCP servers
          McpServerService.startAll(db).catch(e =>
            console.warn('[Startup] MCP auto-start error:', e.message)
          );

          // Regenerate agent instruction files to pick up any template changes
          AgentService.regenerateAllInstructions(db, require('./services/app').generateAssistantClaudeMd);

          // Sync assistant app template UI files to live app directory
          const parentAppId = AgentService.getParentAppId(db);
          if (parentAppId) {
            const liveAppDir = path.join(APPS_DIR, parentAppId);
            const templateDir = path.join(__dirname, 'templates', 'assistant');
            const filesToSync = [
              'src/constants.js',
              'src/components/SetupScreen.jsx',
              'src/components/SettingsPanel.jsx',
              'src/App.jsx',
            ];
            for (const file of filesToSync) {
              const src = path.join(templateDir, file);
              const dest = path.join(liveAppDir, file);
              if (fs.existsSync(src)) {
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.copyFileSync(src, dest);
              }
            }
            console.log('[Startup] Synced assistant template UI files to live app');
          }

          // Auto-start Telegram watchers for agents with bot tokens
          ensureTelegramWatchers(db);

          // Auto-start memory watcher if assistant exists
          if (ensureMemoryWatcher()) {
            console.log('Memory watcher auto-started');
          }

          // Pre-load memory cache so agent is fast from first message
          preloadMemoryCache();

          // Schedule 3am Eastern daily cache refresh
          scheduleMemoryCacheRefresh();

          // Pre-warm the routing service's launcher-chat cache so engines that
          // tick later (DigestEngine waits 30s) don't race the async refresh
          // and misroute their first request through the lowest-display_order
          // fallback. Fire-and-forget — 2s prewarm timeout vs 30s DigestEngine
          // delay leaves comfortable headroom. If the launcher is unreachable,
          // prewarm resolves and the resolver's existing fallback path still
          // works.
          const RoutingService = require('./services/routing');
          RoutingService.prewarm().catch(() => { /* best-effort */ });

          // Start digest engine (automatic session + daily digest generation)
          DigestEngine.start(db);

          // Auto-provision motivations-update jobs for agents with MOTIVATIONS.md
          try {
            const operationalAgents = AgentService.getOperational(db);
            for (const agent of operationalAgents) {
              const agentPaths = AgentService.getPaths(agent.app_id, agent.id);
              const motivationsPath = path.join(agentPaths.agentDir, 'MOTIVATIONS.md');
              if (!fs.existsSync(motivationsPath)) continue;

              const existingJobs = JobsFileService.read(agent.app_id, agent.id).jobs || [];
              const hasJob = existingJobs.some(j =>
                j.skill === 'motivations-update' || (j.name || '').toLowerCase() === 'motivations update'
              );
              if (hasJob) continue;

              JobsFileService.createJob(agent.app_id, agent.id, {
                name: 'Motivations Update',
                description: 'Periodic mission assessment, goal-setting, and accountability reporting',
                type: 'recurring',
                schedule: { frequency: 'daily', time: '08:00' },
                onMissed: 'run',
                skill: 'motivations-update'
              });
              console.log(`[Startup] Auto-provisioned motivations-update job for ${agent.name} (${agent.id})`);
            }
          } catch (e) {
            console.warn('[Startup] motivations-update auto-provision error:', e.message);
          }

          // Auto-provision action-planner jobs for agents with MOTIVATIONS.md
          try {
            const apAgents = AgentService.getOperational(db);
            for (const agent of apAgents) {
              const agentPaths = AgentService.getPaths(agent.app_id, agent.id);
              const motivationsPath = path.join(agentPaths.agentDir, 'MOTIVATIONS.md');
              if (!fs.existsSync(motivationsPath)) continue;

              const existingJobs = JobsFileService.read(agent.app_id, agent.id).jobs || [];
              const hasJob = existingJobs.some(j =>
                j.skill === 'action-planner' || (j.name || '').toLowerCase() === 'action planner'
              );
              if (hasJob) continue;

              JobsFileService.createJob(agent.app_id, agent.id, {
                name: 'Action Planner',
                description: 'Reviews missions, checks schedule, creates one concrete timed job per mission',
                type: 'recurring',
                schedule: { frequency: 'daily', time: '09:00' },
                onMissed: 'run',
                skill: 'action-planner',
                skillScope: 'system'
              });
              console.log(`[Startup] Auto-provisioned action-planner job for ${agent.name} (${agent.id})`);
            }
          } catch (e) {
            console.warn('[Startup] action-planner auto-provision error:', e.message);
          }

          // Initial billing/status check (non-blocking)
          BillingService.checkAll(db).catch(e =>
            console.warn('[Startup] Billing check error:', e.message)
          );

          // Periodic billing check every 4 hours
          setInterval(() => {
            BillingService.checkAll(db).catch(e =>
              console.warn('[Periodic] Billing check error:', e.message)
            );
          }, 4 * 60 * 60 * 1000);
        }, 1000); // Small delay to ensure everything is initialized

        // Auto-setup local whisper (one-time, runs in background)
        if (!WhisperService.isReady()) {
          console.log('Whisper: Setting up local speech-to-text (one-time setup)...');
          WhisperService.setup((progress) => {
            console.log(`Whisper: Setup ${Math.round(progress * 100)}%`);
          }).then(() => {
            console.log('Whisper: Ready! Local speech-to-text enabled.');
          }).catch((err) => {
            console.error('Whisper: Setup failed:', err.message);
            console.log('Whisper: Will use OpenAI API fallback for voice input.');
          });
        } else {
          console.log('Whisper: Local speech-to-text ready.');
        }

        // Auto-start whisper streaming server if installed
        if (WhisperStreamService.isInstalled()) {
          // Kill any orphaned whisper-stream-server from previous session (clean slate)
          console.log('WhisperStream: Checking for orphaned processes...');
          try {
            execSync('pkill -f whisper-stream-server', { stdio: 'ignore' });
            console.log('WhisperStream: Killed orphaned process from previous session');
          } catch (e) {
            console.log('WhisperStream: No orphaned process found');
          }

          console.log('WhisperStream: Starting streaming server...');
          WhisperStreamService.start()
            .then(() => {
              console.log('WhisperStream: Ready! Real-time voice transcription enabled.');
            })
            .catch((err) => {
              console.error('WhisperStream: Failed to start:', err.message);
              console.log('WhisperStream: Batch transcription available as fallback.');
            });
        } else {
          console.log('WhisperStream: Streaming server not installed, using batch mode.');
        }

        // Auto-setup and start Cloudflare tunnel for remote access
        if (!TunnelService.isInstalled()) {
          console.log('Tunnel: Installing cloudflared (one-time setup)...');
          TunnelService.setup((progress) => {
            console.log(`Tunnel: Setup ${Math.round(progress * 100)}%`);
          }).then(() => {
            console.log('Tunnel: cloudflared installed, starting tunnel...');
            return TunnelService.start(currentPort, (url) => {
              SettingsService.set(db, 'tunnelUrl', url);
              console.log('Tunnel: URL saved to settings');
            });
          }).catch((err) => {
            console.error('Tunnel: Setup failed:', err.message);
            console.log('Tunnel: Voice calls will only work on local network.');
          });
        } else {
          TunnelService.start(currentPort, (url) => {
            SettingsService.set(db, 'tunnelUrl', url);
            console.log('Tunnel: URL saved to settings');
          }).catch((err) => {
            console.log('Tunnel: Not started -', err.message);
          });
        }

        resolve(server);
      });
      server.on('error', reject);
    } catch (err) {
      reject(err);
    }
  });
}

async function stopServer() {
  return new Promise(async (resolve) => {
    // Stop all agent watchers and services
    const allAgentIds = agentState.getAllAgentIds();
    for (const agentId of allAgentIds) {
      const aState = agentState.getAgentState(agentId);
      if (aState.memoryWatcher) {
        console.log(`Memory: Stopping watcher for agent ${agentId}...`);
        aState.memoryWatcher.stop();
        aState.memoryWatcher = null;
      }
      if (aState.telegramWatcher) {
        console.log(`Telegram: Stopping watcher for agent ${agentId}...`);
        aState.telegramWatcher.stop();
        aState.telegramWatcher = null;
      }
    }

    // Legacy cleanup (in case something was set on the shim directly)
    const memoryWatcher = assistantState.getMemoryWatcher();
    if (memoryWatcher) {
      memoryWatcher.stop();
      assistantState.setMemoryWatcher(null);
    }

    // Stop digest engine
    DigestEngine.stop();

    // Clear scheduled timers
    if (catalogSyncTimer) {
      clearTimeout(catalogSyncTimer);
      catalogSyncTimer = null;
    }

    // Stop Cloudflare tunnel
    if (TunnelService.isRunning()) {
      console.log('Tunnel: Stopping...');
      TunnelService.stop();
    }

    // Close per-app database connections
    AppDbService.closeAll();

    // Stop MCP servers
    McpServerService.stopAll();

    // Stop whisper streaming server
    if (WhisperStreamService.isRunning()) {
      console.log('WhisperStream: Stopping streaming server...');
      WhisperStreamService.stop();
    }

    // Close Vite server if running
    if (viteServer) {
      await viteServer.close();
      viteServer = null;
    }

    if (server) {
      server.close(() => {
        console.log('OS8 server stopped');
        server = null;
        db = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

// Restart server (called when Core becomes ready)
async function restartServer() {
  const oldPort = currentPort;
  const oldDb = db;

  await stopServer();
  await startServer(oldPort, oldDb);

  return currentPort;
}

function getAppUrl(slug) {
  return `http://localhost:${currentPort}/${slug}/`;
}

function getPort() {
  return currentPort;
}

function getViteServer() {
  return viteServer;
}

module.exports = {
  startServer,
  stopServer,
  restartServer,
  getAppUrl,
  getCallUrl,
  getPort,
  getViteServer,
  setOAuthCompleteCallback,
  setAppCreatedCallback,
  setAppUpdatedCallback,
  setAgentChangedCallback,
  setBuildStartedCallback,
  setBuildCompletedCallback,
  DEFAULT_PORT
};
