/**
 * Agent Management API Routes
 * CRUD for AI agents using AgentService (SQLite-backed)
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const { getAgentState, removeAgentState, setDefaultAgentId, getDefaultAgentId } = require('../services/agent-state');
const { generateMyselfMd, generateUserMd } = require('../assistant/config-handler');
const { SKILLS_DIR } = require('../config');
const { broadcast, CUSTOM } = require('../shared/agui-events');

function createAgentsRouter(db, deps) {
  const { AgentService, AppService, scaffoldAssistantApp, generateAssistantClaudeMd, onAgentChanged, onTelegramConfigChange, SimService, JobsFileService } = deps;
  const router = express.Router();

  // GET /api/agents — List all agents (or ?filter=visible for UI selectors)
  router.get('/', (req, res) => {
    try {
      const filter = req.query.filter;
      const agents = filter === 'visible' ? AgentService.getVisible(db) : AgentService.getAll(db);
      const defaultAgent = AgentService.getDefault(db);
      // Only use in-memory defaultAgentId if it's in the active agents list
      const fallbackId = getDefaultAgentId();
      const defaultId = defaultAgent?.id || (agents.some(a => a.id === fallbackId) ? fallbackId : agents[0]?.id || null);

      const result = agents.map(agent => ({
        id: agent.id,
        name: agent.name,
        slug: agent.slug,
        backend: agent.backend || 'claude',
        // Per-mode model pin — reflects the current ai_mode's selection.
        model: AgentService.getAgentModel(db, agent.id) || agent.model || null,
        color: agent.color,
        visibility: agent.visibility || 'visible',
        isDefault: agent.id === defaultId
      }));

      res.json({ agents: result, defaultAgentId: defaultId });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/agents — Create agent
  router.post('/', (req, res) => {
    const { name, backend, model, color } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    try {
      // Clean up any previously abandoned incomplete agents before creating a new one
      AgentService.cleanupIncomplete(db);

      // Auto-populate user name from OS8 settings
      const SettingsService = require('../services/settings');
      const userName = SettingsService.get(db, 'user_first_name') || '';

      // Find the parent agent system app
      const appId = AgentService.getParentAppId(db);
      if (!appId) {
        return res.status(400).json({ error: 'No agent system app found. Create assistant first.' });
      }

      // Create agent in DB
      const agent = AgentService.create(db, {
        appId,
        name,
        ownerName: userName,
        backend: backend || 'claude',
        model: model || null,
        color: color || '#8b5cf6'
      });

      // Scaffold agent subfolder (not a separate app)
      const paths = AgentService.getPaths(appId, agent.id);
      fs.mkdirSync(paths.agentDir, { recursive: true });
      scaffoldAssistantApp(paths.agentDir, agent.id, name, agent.slug, name, userName);

      // Remove app UI files that only belong at the parent level (not per-agent)
      for (const dead of ['src', 'index.html']) {
        const p = path.join(paths.agentDir, dead);
        if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
      }

      // Create blob dir with standard subdirectories
      fs.mkdirSync(paths.agentBlobDir, { recursive: true });
      const blobSubdirs = [
        'current-image', 'reference-images',
        'chat-attachments', 'telegram-attachments',
        'journal', 'calendar'
      ];
      for (const sub of blobSubdirs) {
        fs.mkdirSync(path.join(paths.agentBlobDir, sub), { recursive: true });
      }

      // Copy calendar template
      const calendarTemplate = path.join(SKILLS_DIR, 'calendar-template.md');
      const calendarDest = path.join(paths.agentBlobDir, 'calendar', 'calendar.md');
      if (fs.existsSync(calendarTemplate)) {
        fs.copyFileSync(calendarTemplate, calendarDest);
      }

      // Ensure app-level shared user docs directory exists
      fs.mkdirSync(path.join(paths.appDir, 'docs', 'user'), { recursive: true });

      // Create identity doc folders
      const agentSlug = agent.slug.replace('agent-', '');
      fs.mkdirSync(path.join(paths.agentDir, 'docs', `${agentSlug}-identity`), { recursive: true });
      if (userName) {
        const userSlug = userName.toLowerCase().replace(/\s+/g, '-');
        fs.mkdirSync(path.join(paths.agentDir, 'docs', `${userSlug}-identity`), { recursive: true });
      }

      // Generate instruction file
      const config = AgentService.getConfig(db, agent.id);
      const appLike = { id: agent.id, name, slug: agent.slug };
      generateAssistantClaudeMd(db, appLike, config);

      // Notify shell renderer about the new agent
      if (onAgentChanged) onAgentChanged(agent);

      res.json({ success: true, agent });
    } catch (err) {
      console.error('Failed to create agent:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/agents/voices/status — Check if TTS provider is configured
  router.get('/voices/status', (req, res) => {
    const TTSService = require('../services/tts');
    const status = TTSService.isAvailable(db);
    res.json({ ready: status.available, provider: status.provider });
  });

  // GET /api/agents/voices — List available TTS voices
  router.get('/voices', async (req, res) => {
    const TTSService = require('../services/tts');
    const status = TTSService.isAvailable(db);
    if (!status.available) {
      return res.json({ ready: false, voices: [], provider: status.provider });
    }
    try {
      const voices = await TTSService.getVoices(db);
      res.json({ ready: true, voices, provider: status.provider });
    } catch (err) {
      console.error('Failed to fetch voices:', err.message);
      res.json({ ready: false, voices: [], error: err.message });
    }
  });

  // GET /api/agents/voices/preview/:voiceId — Generate on-demand voice preview (OpenAI)
  router.get('/voices/preview/:voiceId', async (req, res) => {
    const TTSService = require('../services/tts');
    const apiKey = TTSService.getApiKey(db);
    const providerName = TTSService.getProviderName(db);
    if (!apiKey || providerName !== 'openai') {
      return res.status(400).json({ error: 'OpenAI TTS not configured' });
    }
    try {
      const { generateAudio } = require('../services/tts-openai');
      const buffer = await generateAudio(apiKey, 'Hi there, this is what I sound like.', req.params.voiceId);
      res.set('Content-Type', 'audio/mpeg');
      res.send(buffer);
    } catch (err) {
      console.error('Voice preview error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/agents/:id/status — Lightweight status check (is agent currently working?)
  // Used by agent-panel and Chat.jsx to recover loading state after tab switch.
  router.get('/:id/status', (req, res) => {
    const state = getAgentState(req.params.id);
    res.json({ working: !!state.working });
  });

  // GET /api/agents/:id/self — Self-info endpoint for agents to look up their own config
  router.get('/:id/self', (req, res) => {
    const agent = AgentService.getById(db, req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const config = AgentService.getConfig(db, agent.id);
    const paths = AgentService.getPaths(agent.app_id, agent.id);

    res.json({
      agentId: agent.id,
      name: agent.name,
      slug: agent.slug,
      gender: agent.gender || 'female',
      role: agent.role || '',
      appearance: agent.appearance || '',
      backend: agent.backend || 'claude',
      model: AgentService.getAgentModel(db, agent.id) || agent.model || null,
      color: agent.color,
      ownerName: config?.ownerName || '',
      pronouns: agent.pronouns || 'she',
      agentDir: paths.agentDir,
      agentBlobDir: paths.agentBlobDir,
      config
    });
  });

  // GET /api/agents/:id — Get agent info + config
  router.get('/:id', (req, res) => {
    const agent = AgentService.getById(db, req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const config = AgentService.getConfig(db, agent.id);
    const defaultAgent = AgentService.getDefault(db);

    res.json({
      id: agent.id,
      name: agent.name,
      slug: agent.slug,
      backend: agent.backend || 'claude',
      model: AgentService.getAgentModel(db, agent.id) || agent.model || null,
      color: agent.color,
      isDefault: agent.id === defaultAgent?.id,
      config
    });
  });

  // PATCH /api/agents/:id — Update agent config
  router.patch('/:id', async (req, res) => {
    const agent = AgentService.getById(db, req.params.id);
    if (!agent) {
      console.error(`[Agents PATCH] Agent not found: id=${req.params.id}`,
        'DB check:', db.prepare('SELECT id, status, setup_complete FROM agents WHERE id = ?').get(req.params.id) || 'no row');
      return res.status(404).json({ error: 'Agent not found' });
    }

    const { name, backend, model, color, ...rest } = req.body;

    // Build updates object using config key names
    const configUpdates = {};
    if (name !== undefined) configUpdates.assistantName = name;
    if (backend !== undefined) configUpdates.agentBackend = backend;
    if (model !== undefined) configUpdates.agentModel = model;
    if (color !== undefined) {
      // Color is on agents table directly
      AgentService.update(db, agent.id, { color });
    }
    // Handle visibility changes with edge case guards (before writing to DB)
    if (rest.visibility !== undefined && (rest.visibility === 'hidden' || rest.visibility === 'off')) {
      // Prevent setting the last visible agent to hidden/off
      const visibleAgents = AgentService.getVisible(db);
      const isLastVisible = visibleAgents.length === 1 && visibleAgents[0].id === agent.id;
      if (isLastVisible) {
        return res.status(400).json({ error: 'Cannot hide the last visible agent' });
      }
      // If setting default agent to hidden/off, reassign default to first visible agent
      const defaultAgent = AgentService.getDefault(db);
      if (agent.id === defaultAgent?.id) {
        const newDefault = visibleAgents.find(a => a.id !== agent.id);
        if (newDefault) {
          AgentService.setDefault(db, newDefault.id);
          setDefaultAgentId(newDefault.id);
        }
      }
    }
    // Visibility is a direct DB column, not a config key
    if (rest.visibility !== undefined) {
      AgentService.update(db, agent.id, { visibility: rest.visibility });
      delete rest.visibility;
    }

    // Convert age → birth_date
    if (rest.age !== undefined && rest.age !== null) {
      const currentYear = new Date().getFullYear();
      configUpdates.birthDate = `${currentYear - Number(rest.age)}-01-01`;
    }

    // Pass through other config keys (pronouns, timeouts, etc.)
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) configUpdates[key] = value;
    }

    // Auto-derive pronouns from gender
    if (rest.gender !== undefined) {
      configUpdates.pronouns = rest.gender === 'male' ? 'he' : 'she';
    }

    // If avatarUrl provided, copy image to agent's reference-images/headshot and discard the field
    // Compress to 1024px JPEG to keep reference images fast for body generation APIs
    if (configUpdates.avatarUrl && configUpdates.avatarUrl.startsWith('/api/imagegen/files/')) {
      try {
        const sourceFilename = configUpdates.avatarUrl.replace('/api/imagegen/files/', '');
        const ImageGenService = require('../services/imagegen');
        const sourcePath = ImageGenService.getFilePath(sourceFilename);
        if (sourcePath && fs.existsSync(sourcePath)) {
          const agentPaths = AgentService.getPaths(agent.app_id, agent.id);
          const destDir = path.join(agentPaths.agentBlobDir, 'reference-images');
          fs.mkdirSync(destDir, { recursive: true });
          // Remove old headshot files (any extension) before copying new one
          try {
            for (const f of fs.readdirSync(destDir)) {
              if (/^headshot\./i.test(f)) fs.unlinkSync(path.join(destDir, f));
            }
          } catch (e) { /* ignore cleanup errors */ }
          // Compress large images to 1024px JPEG before saving as reference
          const sourceBuffer = fs.readFileSync(sourcePath);
          const MAX_REF_SIZE = 300 * 1024; // 300KB threshold
          if (sourceBuffer.length > MAX_REF_SIZE) {
            const sharp = require('sharp');
            const compressed = await sharp(sourceBuffer)
              .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 85 })
              .toBuffer();
            fs.writeFileSync(path.join(destDir, 'headshot.jpg'), compressed);
            console.log(`Agent headshot compressed: ${(sourceBuffer.length / 1024).toFixed(0)}KB → ${(compressed.length / 1024).toFixed(0)}KB`);
          } else {
            const ext = path.extname(sourceFilename) || '.png';
            fs.copyFileSync(sourcePath, path.join(destDir, `headshot${ext}`));
          }
        }
      } catch (e) {
        console.warn('Failed to copy avatar to agent blob:', e.message);
      }
      delete configUpdates.avatarUrl;
    }

    // If bodyUrl provided, copy image to agent's reference-images/body-reference and discard the field
    // Compress to 1024px JPEG if large, same as headshot
    if (configUpdates.bodyUrl && configUpdates.bodyUrl.startsWith('/api/imagegen/files/')) {
      try {
        const sourceFilename = configUpdates.bodyUrl.replace('/api/imagegen/files/', '');
        const ImageGenService = require('../services/imagegen');
        const sourcePath = ImageGenService.getFilePath(sourceFilename);
        if (sourcePath && fs.existsSync(sourcePath)) {
          const agentPaths = AgentService.getPaths(agent.app_id, agent.id);
          const destDir = path.join(agentPaths.agentBlobDir, 'reference-images');
          fs.mkdirSync(destDir, { recursive: true });
          // Remove old body-reference files (any extension) before copying new one
          try {
            for (const f of fs.readdirSync(destDir)) {
              if (/^body-reference\./i.test(f)) fs.unlinkSync(path.join(destDir, f));
            }
          } catch (e) { /* ignore cleanup errors */ }
          const sourceBuffer = fs.readFileSync(sourcePath);
          const MAX_REF_SIZE = 300 * 1024;
          if (sourceBuffer.length > MAX_REF_SIZE) {
            const sharp = require('sharp');
            const compressed = await sharp(sourceBuffer)
              .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 85 })
              .toBuffer();
            fs.writeFileSync(path.join(destDir, 'body-reference.jpg'), compressed);
            console.log(`Agent body-reference compressed: ${(sourceBuffer.length / 1024).toFixed(0)}KB → ${(compressed.length / 1024).toFixed(0)}KB`);
          } else {
            const ext = path.extname(sourceFilename) || '.png';
            fs.copyFileSync(sourcePath, path.join(destDir, `body-reference${ext}`));
          }
        }
      } catch (e) {
        console.warn('Failed to copy body reference to agent blob:', e.message);
      }
      delete configUpdates.bodyUrl;
    }

    if (Object.keys(configUpdates).length > 0) {
      AgentService.updateConfig(db, agent.id, configUpdates);
    }

    // If voice was updated, also save to agent_voices for current provider
    if (configUpdates.voiceId !== undefined) {
      const TTSService = require('../services/tts');
      const currentProvider = TTSService.getProviderName(db);
      if (currentProvider) {
        TTSService.saveAgentVoice(
          db, agent.id, currentProvider,
          configUpdates.voiceId, configUpdates.voiceName || null
        );
      }
    }

    // On setup completion: seed life items (job created later when lifeFrequency is received)
    if (rest.setupComplete && !agent.setup_complete && SimService) {
      try {
        const gender = rest.gender || agent.gender || 'female';
        const role = rest.role || '';
        SimService.seedDefaultLifeItems(db, agent.id, role, gender);
      } catch (e) {
        console.warn('[Setup] Failed to seed life items:', e.message);
      }
    }

    // Create Agent Life job when lifeFrequency is received (from setup wizard step 5)
    if (rest.lifeFrequency !== undefined && JobsFileService) {
      try {
        // Only create if no Agent Life job exists yet
        const existingJobs = JobsFileService.getJobs(agent.app_id, agent.id);
        const hasLifeJob = existingJobs.some(j => j.skill === 'agent-life');
        if (!hasLifeJob) {
          const isOff = rest.lifeFrequency === 'off';
          const interval = isOff ? 4 : parseInt(rest.lifeFrequency, 10);
          JobsFileService.createJob(agent.app_id, agent.id, {
            name: 'Agent Life',
            description: 'Combined life routine: reverie + journal + portrait',
            type: 'recurring',
            schedule: { frequency: 'every-x-hours', interval, startTime: '08:00' },
            onMissed: 'run',
            skill: 'agent-life',
            enabled: !isOff
          });
        }
      } catch (e) {
        console.warn('[Setup] Failed to create Agent Life job:', e.message);
      }
    }

    // Regenerate instruction file and MYSELF.md (non-critical — don't block Telegram/response)
    const updatedAgent = AgentService.getById(db, agent.id);
    try {
      const config = AgentService.getConfig(db, agent.id);
      const appLike = { id: agent.id, name: updatedAgent.name, slug: updatedAgent.slug };
      generateAssistantClaudeMd(db, appLike, config);
      generateMyselfMd(db, updatedAgent.id);
      generateUserMd(db, updatedAgent.id);
    } catch (e) {
      console.warn('[Agents PATCH] Failed to regenerate instruction files:', e.message);
    }

    // Notify shell renderer about the agent change
    if (onAgentChanged) onAgentChanged(updatedAgent);

    // If Telegram bot token or visibility changed, start/stop watcher
    if (rest.telegramBotToken !== undefined || req.body.visibility !== undefined) {
      if (onTelegramConfigChange) {
        onTelegramConfigChange(updatedAgent);
      }
    }

    res.json({ success: true });
  });

  // DELETE /api/agents/:id — Delete agent
  router.delete('/:id', (req, res) => {
    const agent = AgentService.getById(db, req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // If deleting the default, pick a new default
    const allAgents = AgentService.getAll(db);
    const defaultAgent = AgentService.getDefault(db);
    if (agent.id === defaultAgent?.id) {
      const newDefault = allAgents.find(a => a.id !== agent.id);
      if (newDefault) {
        AgentService.setDefault(db, newDefault.id);
        setDefaultAgentId(newDefault.id);
      }
    }

    // Cleanup per-agent state
    removeAgentState(agent.id);

    // Hard delete: remove all DB data + filesystem
    const paths = AgentService.getPaths(agent.app_id, agent.id);
    AgentService.hardDelete(db, agent.id);
    try {
      if (fs.existsSync(paths.agentDir)) {
        fs.rmSync(paths.agentDir, { recursive: true, force: true });
      }
      if (fs.existsSync(paths.agentBlobDir)) {
        fs.rmSync(paths.agentBlobDir, { recursive: true, force: true });
      }
    } catch (e) {
      console.warn('Agent file cleanup failed:', e.message);
    }

    // Notify shell about deletion
    if (onAgentChanged) onAgentChanged({ ...agent, _deleted: true });

    res.json({ success: true });
  });

  // PATCH /api/agents/:id/model — Change agent's chat model
  router.patch('/:id/model', (req, res) => {
    const agent = AgentService.getById(db, req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const { model } = req.body;
    if (model === undefined) {
      return res.status(400).json({ error: 'model is required' });
    }

    const AIRegistryService = require('../services/ai-registry');

    // "auto" or null resets to cascade default
    if (model === 'auto' || model === null) {
      AgentService.updateConfig(db, agent.id, { agentModel: null });
      generateMyselfMd(db, agent.id);

      // Notify agent's SSE clients so UI updates immediately
      const state = getAgentState(agent.id);
      if (state.responseClients) {
        broadcast(state.responseClients, CUSTOM, { name: 'config-changed', value: {} });
      }

      return res.json({ success: true, model: 'auto', label: 'Auto (system selects best available)' });
    }

    // Validate against known model families
    const families = AIRegistryService.getFamilies(db);
    const match = families.find(f => f.id === model);
    if (!match) {
      const validIds = families.map(f => f.id);
      return res.status(400).json({ error: `Unknown model: "${model}". Valid: ${validIds.join(', ')}` });
    }

    AgentService.updateConfig(db, agent.id, { agentModel: model });
    generateMyselfMd(db, agent.id);

    // Notify agent's SSE clients so UI updates immediately
    const state = getAgentState(agent.id);
    if (state.responseClients) {
      broadcast(state.responseClients, CUSTOM, { name: 'config-changed', value: {} });
    }

    res.json({ success: true, model: match.id, label: match.name });
  });

  // POST /api/agents/:id/default — Set as default agent
  // POST /api/agents/:id/principles/generate — Run principles extraction pipeline
  router.post('/:id/principles/generate', async (req, res) => {
    const PrinciplesService = require('../services/principles');
    const agent = AgentService.getById(db, req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    try {
      const { principlesPath, stats } = await PrinciplesService.generate(db, agent.id, (phase, detail) => {
        console.log(`[Principles API] ${phase}: ${detail}`);
      });
      res.json({ success: true, principlesPath, stats });
    } catch (err) {
      console.error('[Principles API] Generation failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/agents/:id/principles/status — Check regeneration status
  router.get('/:id/principles/status', (req, res) => {
    const PrinciplesService = require('../services/principles');
    const agent = AgentService.getById(db, req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const paths = AgentService.getPaths(agent.app_id, agent.id);
    const principlesPath = require('path').join(paths.agentDir, 'PRINCIPLES.md');
    const exists = require('fs').existsSync(principlesPath);

    const status = PrinciplesService.checkRegenerationNeeded(db, agent.id);
    res.json({ exists, ...status });
  });

  router.post('/:id/default', (req, res) => {
    const agent = AgentService.getById(db, req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    AgentService.setDefault(db, agent.id);
    setDefaultAgentId(agent.id);
    res.json({ success: true, defaultAgentId: agent.id });
  });

  return router;
}

module.exports = createAgentsRouter;

module.exports.meta = {
  name: 'agents',
  description: 'Agent configuration and self-info',
  basePath: '/api/agents',
  endpoints: [
    { method: 'GET', path: '/:id/self', description: 'Get own agent config (for agent introspection)',
      returns: { agentId: 'string', name: 'string', gender: 'string', role: 'string', config: 'object' } },
    { method: 'PATCH', path: '/:id/model', description: 'Change agent chat model',
      body: { model: 'string (family_id or "auto")' },
      returns: { success: 'boolean', model: 'string', label: 'string' } }
  ]
};
