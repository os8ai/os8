const { contextBridge, ipcRenderer, webUtils } = require('electron');

// window.os8 API surface — 24 namespaces, ~130 methods
// Shell renderer: apps, agents, assistant, build, call, claude, connections, core,
//   data, env, files, jobsFile, paths, preview, server, settings, tasksFile, terminal, voice
// Infrastructure (IPC handlers exist, not used by shell):
//   whisper, tts, transcribe, speak, inspect, mcp

contextBridge.exposeInMainWorld('os8', {
  // Apps
  apps: {
    list: () => ipcRenderer.invoke('apps:list'),
    listArchived: () => ipcRenderer.invoke('apps:list-archived'),
    get: (id) => ipcRenderer.invoke('apps:get', id),
    create: (name, color, icon, textColor) => ipcRenderer.invoke('apps:create', name, color, icon, textColor),
    update: (id, updates) => ipcRenderer.invoke('apps:update', id, updates),
    archive: (id) => ipcRenderer.invoke('apps:archive', id),
    restore: (id) => ipcRenderer.invoke('apps:restore', id),
    delete: (id) => ipcRenderer.invoke('apps:delete', id),
    getSystem: () => ipcRenderer.invoke('apps:get-system'),
    onCreated: (callback) => {
      ipcRenderer.on('apps:created', (event, data) => callback(data));
    },
    onUpdated: (callback) => {
      ipcRenderer.on('apps:updated', (event, data) => callback(data));
    },
  },

  // Personal Assistant
  assistant: {
    get: () => ipcRenderer.invoke('assistant:get'),
    create: (assistantName, ownerName) => ipcRenderer.invoke('assistant:create', assistantName, ownerName),
    chat: (message) => ipcRenderer.invoke('assistant:chat', message),
    resetSession: () => ipcRenderer.invoke('assistant:reset-session'),
    getSessionStatus: () => ipcRenderer.invoke('assistant:session-status'),
    onStream: (callback) => {
      ipcRenderer.on('assistant:stream', (event, data) => callback(data));
    },
    removeStreamListener: () => {
      ipcRenderer.removeAllListeners('assistant:stream');
    },
  },

  // Core Services (React/Vite/Tailwind environment)
  core: {
    getStatus: () => ipcRenderer.invoke('core:status'),
    setup: () => ipcRenderer.invoke('core:setup'),
    getPath: () => ipcRenderer.invoke('core:path'),
    onReady: (callback) => {
      ipcRenderer.on('core:ready', () => callback());
    },
  },

  // Tasks File (JSON-based) — agentId scopes to a specific agent's tasks
  tasksFile: {
    read: (appId, agentId) => ipcRenderer.invoke('tasksFile:read', appId, agentId),
    getTasks: (appId, agentId, projectId) => ipcRenderer.invoke('tasksFile:getTasks', appId, agentId, projectId),
    getProjects: (appId, agentId) => ipcRenderer.invoke('tasksFile:getProjects', appId, agentId),
    createProject: (appId, agentId, name) => ipcRenderer.invoke('tasksFile:createProject', appId, agentId, name),
    updateProject: (appId, agentId, projectId, updates) => ipcRenderer.invoke('tasksFile:updateProject', appId, agentId, projectId, updates),
    deleteProject: (appId, agentId, projectId) => ipcRenderer.invoke('tasksFile:deleteProject', appId, agentId, projectId),
    createTask: (appId, agentId, title, projectId) => ipcRenderer.invoke('tasksFile:createTask', appId, agentId, title, projectId),
    updateTask: (appId, agentId, taskId, updates) => ipcRenderer.invoke('tasksFile:updateTask', appId, agentId, taskId, updates),
    deleteTask: (appId, agentId, taskId) => ipcRenderer.invoke('tasksFile:deleteTask', appId, agentId, taskId),
    getStats: (appId, agentId) => ipcRenderer.invoke('tasksFile:getStats', appId, agentId),
    reorderTask: (appId, agentId, taskId, targetTaskId, targetProjectId, position) => ipcRenderer.invoke('tasksFile:reorderTask', appId, agentId, taskId, targetTaskId, targetProjectId, position),
    reorderProject: (appId, agentId, projectId, targetProjectId, position) => ipcRenderer.invoke('tasksFile:reorderProject', appId, agentId, projectId, targetProjectId, position),
    watch: (appId, agentId) => ipcRenderer.invoke('tasksFile:watch', appId, agentId),
    unwatch: () => ipcRenderer.invoke('tasksFile:unwatch'),
    onFileChanged: (callback) => {
      ipcRenderer.on('tasks:file-changed', () => callback());
    },
  },

  // Jobs File (JSON-based timed jobs) — agentId scopes to a specific agent's jobs
  jobsFile: {
    getJobs: (appId, agentId) => ipcRenderer.invoke('jobsFile:getJobs', appId, agentId),
    getJob: (appId, agentId, jobId) => ipcRenderer.invoke('jobsFile:getJob', appId, agentId, jobId),
    createJob: (appId, agentId, jobData) => ipcRenderer.invoke('jobsFile:createJob', appId, agentId, jobData),
    updateJob: (appId, agentId, jobId, updates) => ipcRenderer.invoke('jobsFile:updateJob', appId, agentId, jobId, updates),
    deleteJob: (appId, agentId, jobId) => ipcRenderer.invoke('jobsFile:deleteJob', appId, agentId, jobId),
    toggleJob: (appId, agentId, jobId) => ipcRenderer.invoke('jobsFile:toggleJob', appId, agentId, jobId),
    getRuns: (appId, agentId, jobId, limit) => ipcRenderer.invoke('jobsFile:getRuns', appId, agentId, jobId, limit),
    addRun: (appId, agentId, jobId, runData) => ipcRenderer.invoke('jobsFile:addRun', appId, agentId, jobId, runData),
    getUpcomingJobs: (appId, agentId) => ipcRenderer.invoke('jobsFile:getUpcomingJobs', appId, agentId),
    getDueJobs: (appId, agentId) => ipcRenderer.invoke('jobsFile:getDueJobs', appId, agentId),
    getStats: (appId, agentId) => ipcRenderer.invoke('jobsFile:getStats', appId, agentId),
    getSkills: (appId, agentId) => ipcRenderer.invoke('jobsFile:getSkills', appId, agentId),
    watch: (appId, agentId) => ipcRenderer.invoke('jobsFile:watch', appId, agentId),
    unwatch: () => ipcRenderer.invoke('jobsFile:unwatch'),
    onFileChanged: (callback) => {
      ipcRenderer.on('jobs:file-changed', () => callback());
    },
  },

  // Agents (multi-agent management)
  agents: {
    list: (options) => ipcRenderer.invoke('agents:list', options),
    get: (id) => ipcRenderer.invoke('agents:get', id),
    create: (name, ownerName, options) => ipcRenderer.invoke('agents:create', name, ownerName, options),
    update: (id, updates) => ipcRenderer.invoke('agents:update', id, updates),
    delete: (id) => ipcRenderer.invoke('agents:delete', id),
    setDefault: (id) => ipcRenderer.invoke('agents:set-default', id),
    getDefault: () => ipcRenderer.invoke('agents:get-default'),
    onChanged: (callback) => {
      ipcRenderer.on('agents:changed', (event, agent) => callback(agent));
    },
  },

  // Environment variables
  env: {
    list: () => ipcRenderer.invoke('env:list'),
    get: (key) => ipcRenderer.invoke('env:get', key),
    set: (key, value, description) => ipcRenderer.invoke('env:set', key, value, description),
    delete: (key) => ipcRenderer.invoke('env:delete', key),
  },

  // Connections (OAuth)
  connections: {
    getProviders: () => ipcRenderer.invoke('connections:get-providers'),
    getProviderCredentials: (provider) => ipcRenderer.invoke('connections:get-provider-credentials', provider),
    setProviderCredentials: (provider, clientId, clientSecret) => ipcRenderer.invoke('connections:set-provider-credentials', provider, clientId, clientSecret),
    deleteProviderCredentials: (provider) => ipcRenderer.invoke('connections:delete-provider-credentials', provider),
    list: () => ipcRenderer.invoke('connections:list'),
    get: (id) => ipcRenderer.invoke('connections:get', id),
    delete: (id) => ipcRenderer.invoke('connections:delete', id),
    startOAuth: (provider, scopes) => ipcRenderer.invoke('connections:start-oauth', provider, scopes),
    refreshToken: (connectionId) => ipcRenderer.invoke('connections:refresh-token', connectionId),
    getAppGrants: (appId) => ipcRenderer.invoke('connections:get-app-grants', appId),
    grantApp: (connectionId, appId, scopes) => ipcRenderer.invoke('connections:grant-app', connectionId, appId, scopes),
    revokeApp: (connectionId, appId) => ipcRenderer.invoke('connections:revoke-app', connectionId, appId),
    getToken: (connectionId, appId) => ipcRenderer.invoke('connections:get-token', connectionId, appId),
    onOAuthComplete: (callback) => {
      ipcRenderer.on('connections:oauth-complete', (event, data) => callback(data));
    },
  },

  // Preview - Multi-view support (appId required for all operations)
  preview: {
    create: (appId) => ipcRenderer.invoke('preview:create', appId),
    destroy: (appId) => ipcRenderer.invoke('preview:destroy', appId),
    destroyAll: () => ipcRenderer.invoke('preview:destroy-all'),
    setUrl: (appId, url) => ipcRenderer.invoke('preview:set-url', appId, url),
    getUrl: (appId) => ipcRenderer.invoke('preview:get-url', appId),
    refresh: (appId) => ipcRenderer.invoke('preview:refresh', appId),
    goBack: (appId) => ipcRenderer.invoke('preview:go-back', appId),
    goForward: (appId) => ipcRenderer.invoke('preview:go-forward', appId),
    canGoBack: (appId) => ipcRenderer.invoke('preview:can-go-back', appId),
    canGoForward: (appId) => ipcRenderer.invoke('preview:can-go-forward', appId),
    getNavState: (appId) => ipcRenderer.invoke('preview:get-nav-state', appId),
    setBounds: (appId, bounds) => ipcRenderer.invoke('preview:set-bounds', appId, bounds),
    hide: (appId) => ipcRenderer.invoke('preview:hide', appId),
    hideAll: () => ipcRenderer.invoke('preview:hide-all'),
    setMode: (appId, mode) => ipcRenderer.invoke('preview:set-mode', appId, mode),
    broadcastMode: (mode) => ipcRenderer.invoke('preview:broadcast-mode', mode),
    onUrlChanged: (callback) => {
      ipcRenderer.on('preview-url-changed', (event, data) => callback(data.appId, data.url));
    },
  },

  // Paths
  paths: {
    get: () => ipcRenderer.invoke('paths:get'),
  },

  // Server
  server: {
    getAppUrl: (slug) => ipcRenderer.invoke('server:get-app-url', slug),
    getPort: () => ipcRenderer.invoke('server:get-port'),
  },

  // Settings
  settings: {
    get: (key) => ipcRenderer.invoke('settings:get', key),
    set: (key, value) => ipcRenderer.invoke('settings:set', key, value),
    getAll: () => ipcRenderer.invoke('settings:get-all'),
    getOAuthPort: () => ipcRenderer.invoke('settings:get-oauth-port'),
    setOAuthPort: (port) => ipcRenderer.invoke('settings:set-oauth-port', port), // pass null to reset to default
    getTunnelUrl: () => ipcRenderer.invoke('settings:get-tunnel-url'),
    setTunnelUrl: (url) => ipcRenderer.invoke('settings:set-tunnel-url', url),
    getAppUi: (appId) => ipcRenderer.invoke('settings:get-app-ui', appId),
    setAppUi: (appId, settings) => ipcRenderer.invoke('settings:set-app-ui', appId, settings),
  },

  // Claude Instructions
  claude: {
    getInstructions: () => ipcRenderer.invoke('claude:get-instructions'),
    setInstructions: (content) => ipcRenderer.invoke('claude:set-instructions', content),
    generateMd: (appId) => ipcRenderer.invoke('claude:generate-md', appId),
  },

  // Files (read-only)
  files: {
    list: (appId, agentId) => ipcRenderer.invoke('files:list', appId, agentId),
    listBlob: (appId, agentId) => ipcRenderer.invoke('files:list-blob', appId, agentId),
    getPaths: (appId, agentId) => ipcRenderer.invoke('files:get-paths', appId, agentId),
    read: (filePath) => ipcRenderer.invoke('files:read', filePath),
    download: (filePath) => ipcRenderer.invoke('files:download', filePath),
    pickDirectory: (defaultPath) => ipcRenderer.invoke('files:pick-directory', defaultPath),
  },

  // Terminal (PTY)
  terminal: {
    create: (appId, type, opts) => ipcRenderer.invoke('terminal:create', appId, type, opts),
    write: (sessionId, data) => ipcRenderer.invoke('terminal:write', sessionId, data),
    resize: (sessionId, cols, rows) => ipcRenderer.invoke('terminal:resize', sessionId, cols, rows),
    kill: (sessionId) => ipcRenderer.invoke('terminal:kill', sessionId),
    getBuffer: (sessionId) => ipcRenderer.invoke('terminal:get-buffer', sessionId),
    list: () => ipcRenderer.invoke('terminal:list'),
    onOutput: (callback) => {
      ipcRenderer.on('terminal:output', (event, data) => callback(data));
    },
    onExit: (callback) => {
      ipcRenderer.on('terminal:exit', (event, data) => callback(data));
    },
  },

  // Voice (Speech-to-Text)
  voice: {
    transcribe: (audioBuffer, mimeType, language) => ipcRenderer.invoke('voice:transcribe', audioBuffer, mimeType, language),
    getSettings: () => ipcRenderer.invoke('voice:getSettings'),
    updateSettings: (settings) => ipcRenderer.invoke('voice:updateSettings', settings),
  },

  // Whisper (Local Speech-to-Text)
  whisper: {
    // Batch transcription (whisper.cpp CLI)
    status: () => ipcRenderer.invoke('whisper:status'),
    isReady: () => ipcRenderer.invoke('whisper:isReady'),
    setup: () => ipcRenderer.invoke('whisper:setup'),
    onSetupProgress: (callback) => {
      ipcRenderer.on('whisper:setup-progress', (event, progress) => callback(progress));
      return () => ipcRenderer.removeAllListeners('whisper:setup-progress');
    },

    // Streaming server (whisper-stream-server)
    streamStatus: () => ipcRenderer.invoke('whisper:stream-status'),
    streamStart: () => ipcRenderer.invoke('whisper:stream-start'),
    streamStop: () => ipcRenderer.invoke('whisper:stream-stop'),
    streamConfigure: (options) => ipcRenderer.invoke('whisper:stream-configure', options),
  },

  // TTS (Text-to-Speech with ElevenLabs)
  tts: {
    getSettings: () => ipcRenderer.invoke('tts:getSettings'),
    updateSettings: (settings) => ipcRenderer.invoke('tts:updateSettings', settings),
    getVoices: () => ipcRenderer.invoke('tts:getVoices'),
    isAvailable: () => ipcRenderer.invoke('tts:isAvailable'),
  },

  // Tunnel (Cloudflare remote access)
  tunnel: {
    status: () => ipcRenderer.invoke('tunnel:status'),
    isInstalled: () => ipcRenderer.invoke('tunnel:isInstalled'),
    setup: () => ipcRenderer.invoke('tunnel:setup'),
    getUrl: () => ipcRenderer.invoke('tunnel:getUrl'),
    onSetupProgress: (callback) => {
      ipcRenderer.on('tunnel:setup-progress', (event, progress) => callback(progress));
      return () => ipcRenderer.removeAllListeners('tunnel:setup-progress');
    },
  },

  // Video Transcription (video to text)
  transcribe: {
    status: () => ipcRenderer.invoke('transcribe:status'),
    file: (videoPath, options) => ipcRenderer.invoke('transcribe:file', videoPath, options),
    onProgress: (callback) => {
      ipcRenderer.on('transcribe:progress', (event, progress) => callback(progress));
      return () => ipcRenderer.removeAllListeners('transcribe:progress');
    },
  },

  // Speak (Text-to-Audio via ElevenLabs)
  speak: {
    status: () => ipcRenderer.invoke('speak:status'),
    generate: (text, options) => ipcRenderer.invoke('speak:generate', text, options),
    list: () => ipcRenderer.invoke('speak:list'),
    delete: (filename) => ipcRenderer.invoke('speak:delete', filename),
    cleanup: (olderThanDays) => ipcRenderer.invoke('speak:cleanup', olderThanDays),
  },

  // Call (Phone call state for desktop/phone mutual exclusion)
  call: {
    isActive: () => ipcRenderer.invoke('call:is-active'),
    onActive: (callback) => {
      ipcRenderer.on('call:active', (event, data) => callback(data));
    },
    onEnded: (callback) => {
      ipcRenderer.on('call:ended', (event, data) => callback(data));
    },
  },

  // App Inspection (screenshot + console capture)
  inspect: {
    capture: (appId, appUrl) => ipcRenderer.invoke('inspect:capture', appId, appUrl),
    console: (appId) => ipcRenderer.invoke('inspect:console', appId),
  },

  // Build events (app builder status)
  build: {
    onStarted: (callback) => {
      ipcRenderer.on('build:started', (event, data) => callback(data));
    },
  },

  // Account (OS8.ai identity)
  account: {
    get: () => ipcRenderer.invoke('account:get'),
    signIn: () => ipcRenderer.invoke('account:sign-in'),
    signOut: () => ipcRenderer.invoke('account:sign-out'),
    onSignedIn: (cb) => {
      ipcRenderer.on('account:signed-in', (e, data) => cb(data));
    },
  },

  // Data Storage (memory tables)
  data: {
    getSources: (appId) => ipcRenderer.invoke('data:getSources', appId),
    getChunks: (appId, source, limit, offset, sourceType) => ipcRenderer.invoke('data:getChunks', appId, source, limit, offset, sourceType),
    getChunk: (chunkId, scopeId) => ipcRenderer.invoke('data:getChunk', chunkId, scopeId),
    getStats: (appId) => ipcRenderer.invoke('data:getStats', appId),
    deleteChunk: (chunkId, scopeId) => ipcRenderer.invoke('data:deleteChunk', chunkId, scopeId),
  },

  // MCP Servers
  mcp: {
    servers: {
      list: () => ipcRenderer.invoke('mcp:servers:list'),
      get: (id) => ipcRenderer.invoke('mcp:servers:get', id),
      add: (config) => ipcRenderer.invoke('mcp:servers:add', config),
      update: (id, updates) => ipcRenderer.invoke('mcp:servers:update', id, updates),
      remove: (id) => ipcRenderer.invoke('mcp:servers:remove', id),
      start: (id) => ipcRenderer.invoke('mcp:servers:start', id),
      stop: (id) => ipcRenderer.invoke('mcp:servers:stop', id),
      tools: (id) => ipcRenderer.invoke('mcp:servers:tools', id),
      status: (id) => ipcRenderer.invoke('mcp:servers:status', id),
    },
    catalog: {
      search: (query, options) => ipcRenderer.invoke('mcp:catalog:search', query, options),
      get: (id) => ipcRenderer.invoke('mcp:catalog:get', id),
      install: (catalogId) => ipcRenderer.invoke('mcp:catalog:install', catalogId),
      stats: () => ipcRenderer.invoke('mcp:catalog:stats'),
    },
  },

  // Onboarding
  onboarding: {
    getStatus: () => ipcRenderer.invoke('onboarding:status'),
    setStep: (step) => ipcRenderer.invoke('onboarding:set-step', step),
    complete: () => ipcRenderer.invoke('onboarding:complete'),
    ensureNode: () => ipcRenderer.invoke('onboarding:ensure-node'),
    findNpm: () => ipcRenderer.invoke('onboarding:find-npm'),
    onNodeProgress: (cb) => {
      ipcRenderer.on('onboarding:node-progress', (e, d) => cb(d));
    },
    installClis: (npmPath) => ipcRenderer.invoke('onboarding:install-clis', npmPath),
    detectProviders: () => ipcRenderer.invoke('onboarding:detect-providers'),
    checkCliInstalled: (cmd) => ipcRenderer.invoke('onboarding:check-cli-installed', cmd),
    installSingleCli: (cmd) => ipcRenderer.invoke('onboarding:install-single-cli', cmd),
    onCliProgress: (cb) => {
      ipcRenderer.on('onboarding:cli-progress', (e, d) => cb(d));
    },
    removeCliProgressListener: () => {
      ipcRenderer.removeAllListeners('onboarding:cli-progress');
    },
  },

  // Zoom
  zoom: {
    getFactor: () => ipcRenderer.invoke('zoom:get-factor'),
    onChanged: (callback) => {
      ipcRenderer.on('zoom:changed', (event, factor) => callback(factor));
    },
  },

  // Utilities
  utils: {
    getPathForFile: (file) => webUtils.getPathForFile(file),
  },
});
