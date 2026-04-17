/**
 * Assistant API routes
 * Thin router that delegates to handler modules
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { loadJSON, saveJSON } = require('../utils/file-helpers');
const { BLOB_DIR } = require('../config');
const ConversationService = require('../services/conversation');
const DigestService = require('../services/digest');
const {
  broadcast,
  RUN_FINISHED,
  TEXT_MESSAGE_CONTENT,
  newRunId,
  newMessageId
} = require('../shared/agui-events');

// Handler modules
const { getConfig, updateConfig } = require('../assistant/config-handler');
const { handleSend, handleChat } = require('../assistant/message-handler');

function createAssistantRouter(db, deps) {
  const {
    AppService,
    APPS_DIR,
    MemoryService,
    AssistantProcess,
    SettingsService,
    state,
    DEFAULT_CLAUDE_TIMEOUT_MS,
  } = deps;

  const router = express.Router();
  const { getAgentState } = require('../services/agent-state');

  /**
   * Resolve the agent for this request.
   * If req.agentId is set (from /api/agent/:agentId/ middleware), use that.
   * Otherwise fall back to default agent (backward compat for /api/assistant/).
   */
  function resolveAgent(req) {
    if (req.agentId) {
      return AgentService.getById(db, req.agentId);
    }
    return AgentService.getDefault(db) || AppService.getAssistant(db);
  }

  /**
   * Wrap a raw agent-state object in the same getter/setter API as assistant-state shim.
   * This lets message handlers use state.getMemory(), state.getResponseClients(), etc.
   * uniformly regardless of whether state came from the legacy shim or per-agent map.
   */
  function wrapAgentState(raw) {
    return {
      getSessionId: () => raw.sessionId,
      setSessionId: (id) => { raw.sessionId = id; },
      getMemory: () => raw.memory,
      setMemory: (mem) => { raw.memory = mem; },
      getMemoryWatcher: () => raw.memoryWatcher,
      setMemoryWatcher: (w) => { raw.memoryWatcher = w; },
      getProcess: () => raw.process,
      setProcess: (proc) => { raw.process = proc; },
      getResponseClients: () => raw.responseClients,
      addResponseClient: (client) => { raw.responseClients.push(client); },
      removeResponseClient: (client) => {
        raw.responseClients = raw.responseClients.filter(c => c !== client);
      },
    };
  }

  /**
   * Get the per-agent state for this request.
   * If req.agentId is set, use per-agent state; otherwise use default (via shim).
   * Always returns an object with the same getter/setter API (getMemory, setMemory, etc.)
   */
  function resolveState(req) {
    if (req.agentId) {
      return wrapAgentState(getAgentState(req.agentId));
    }
    return state; // the assistant-state shim (delegates to default agent)
  }

  // Build dependencies object for handlers
  const handlerDeps = {
    AppService,
    APPS_DIR,
    MemoryService,
    SettingsService,
    resolveState,
    DEFAULT_CLAUDE_TIMEOUT_MS,
    db
  };

  // ============ Assistant Config ============
  const AgentService = require('../services/agent');
  router.get('/config', getConfig({ AgentService, AppService, APPS_DIR, db }));
  router.post('/config', updateConfig({ AgentService, AppService, APPS_DIR, db }));

  // ============ UI State Persistence ============
  // Merges assistant app UI state into the existing appUi:{appId} settings blob
  // (preserves shell-owned keys like terminalLayout, panelMode, storageView)

  function resolveAppId(req) {
    const agent = resolveAgent(req);
    return agent?.app_id || null;
  }

  router.get('/ui-state', (req, res) => {
    const appId = resolveAppId(req);
    if (!appId) return res.json({});
    const json = SettingsService.get(db, `appUi:${appId}`);
    if (!json) return res.json({});
    try { res.json(JSON.parse(json)); }
    catch { res.json({}); }
  });

  router.put('/ui-state', (req, res) => {
    const appId = resolveAppId(req);
    if (!appId) return res.status(400).json({ error: 'Could not resolve app' });

    let existing = {};
    const json = SettingsService.get(db, `appUi:${appId}`);
    if (json) try { existing = JSON.parse(json); } catch {}

    const merged = { ...existing, ...req.body };
    SettingsService.set(db, `appUi:${appId}`, JSON.stringify(merged));
    res.json({ success: true });
  });

  // ============ Motivations File ============

  router.get('/motivations', (req, res) => {
    const agent = resolveAgent(req);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const paths = AgentService.getPaths(agent.app_id, agent.id);
    const filePath = path.join(paths.agentDir, 'MOTIVATIONS.md');
    try {
      if (!fs.existsSync(filePath)) return res.json({ content: '' });
      res.json({ content: fs.readFileSync(filePath, 'utf-8') });
    } catch (e) {
      res.json({ content: '' });
    }
  });

  router.put('/motivations', (req, res) => {
    const agent = resolveAgent(req);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const paths = AgentService.getPaths(agent.app_id, agent.id);
    const filePath = path.join(paths.agentDir, 'MOTIVATIONS.md');
    const { content } = req.body;

    fs.writeFileSync(filePath, content || '');

    // Auto-provision missing motivation jobs whenever content exists
    if (content?.trim()) {
      try {
        const JobsFileService = require('../services/jobs-file');
        const existing = JobsFileService.getAll(paths.agentDir);

        if (!existing.some(j => j.skill === 'motivations-update' || (j.name || '').toLowerCase().includes('motivations update'))) {
          JobsFileService.create(paths.agentDir, {
            name: 'Motivations Update',
            description: 'Periodic mission assessment, goal-setting, and accountability reporting',
            type: 'recurring',
            schedule: { frequency: 'daily', time: '08:00' },
            onMissed: 'run',
            skill: 'motivations-update',
            enabled: true
          });
        }
        if (!existing.some(j => j.skill === 'action-planner' || (j.name || '').toLowerCase().includes('action planner'))) {
          JobsFileService.create(paths.agentDir, {
            name: 'Action Planner',
            description: 'Reviews missions, checks schedule, creates one concrete timed job per mission',
            type: 'recurring',
            schedule: { frequency: 'daily', time: '09:00' },
            onMissed: 'run',
            skill: 'action-planner',
            skillScope: 'system',
            enabled: true
          });
        }
      } catch (e) {
        console.warn('[Motivations] Failed to auto-provision jobs:', e.message);
      }
    }

    res.json({ success: true });
  });

  // ============ Persistent Assistant Process ============
  router.post('/start', async (req, res) => {
    const assistant = db ? resolveAgent(req) : null;
    if (!assistant) {
      return res.status(404).json({ error: 'Assistant not found' });
    }

    const currentProcess = state.getProcess();
    if (currentProcess && currentProcess.isRunning()) {
      return res.json({ success: true, message: 'Already running' });
    }

    const { agentDir: appPath, agentBlobDir } = AgentService.getPaths(assistant.app_id, assistant.id);
    const assistantProcess = new AssistantProcess(appPath);

    // Per-process run/message IDs reused across all stream/done events from this process
    const procRunId = newRunId();
    const procMessageId = newMessageId();

    assistantProcess.on('stream', (text) => {
      broadcast(state.getResponseClients(), TEXT_MESSAGE_CONTENT, {
        runId: procRunId,
        messageId: procMessageId,
        delta: text
      });
    });

    assistantProcess.on('response', (text) => {
      broadcast(state.getResponseClients(), RUN_FINISHED, {
        runId: procRunId,
        messageId: procMessageId,
        result: text
      });
    });

    try {
      await assistantProcess.start();
      state.setProcess(assistantProcess);
      res.json({ success: true, message: 'Assistant started' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/stop', (req, res) => {
    const currentProcess = state.getProcess();
    if (currentProcess) {
      currentProcess.stop();
      state.setProcess(null);
    }
    res.json({ success: true });
  });

  router.get('/process-status', (req, res) => {
    const agentState = resolveState(req);
    const currentProcess = agentState.getProcess();
    res.json({
      running: currentProcess ? currentProcess.isRunning() : false
    });
  });

  // SSE endpoint for streaming responses
  router.get('/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const agentState = resolveState(req);
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
    agentState.addResponseClient(res);

    // Keepalive heartbeat — prevents browser/proxy timeout during long operations
    const heartbeat = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch {}
    }, 30000);

    req.on('close', () => {
      clearInterval(heartbeat);
      agentState.removeResponseClient(res);
    });
  });

  // ============ Context Debug Viewer ============
  router.get('/context', (req, res) => {
    const assistant = db ? resolveAgent(req) : null;
    if (!assistant) {
      return res.status(404).json({ error: 'Assistant not found' });
    }
    const agentRaw = getAgentState(assistant.id);
    if (agentRaw.lastContext) {
      return res.json(agentRaw.lastContext);
    }
    // Fall back to persisted cache from prior session
    try {
      const row = db.prepare('SELECT context_json FROM agent_context_cache WHERE agent_id = ?').get(assistant.id);
      if (row) {
        const cached = JSON.parse(row.context_json);
        agentRaw.lastContext = cached;
        return res.json(cached);
      }
    } catch (_e) { /* parse error — treat as no cache */ }
    res.status(404).json({ error: 'No context cached yet. Send a message first.' });
  });

  // ============ Message Endpoints ============
  router.post('/send', handleSend(handlerDeps));
  router.post('/chat', handleChat(handlerDeps));

  // ============ File Upload ============
  const uploadStorage = multer.diskStorage({
    destination: (req, file, cb) => {
      const assistant = db ? resolveAgent(req) : null;
      if (!assistant) return cb(new Error('Assistant not found'));
      const { agentBlobDir: uploadBlobDir } = AgentService.getPaths(assistant.app_id, assistant.id);
      const dir = path.join(uploadBlobDir, 'chat-attachments');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      cb(null, `${Date.now()}-${file.originalname}`);
    }
  });
  const upload = multer({ storage: uploadStorage, limits: { fileSize: 20 * 1024 * 1024 } });

  router.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    const filename = req.file.filename;
    const mimeType = req.file.mimetype;
    res.json({
      filename,
      url: `/blob/chat-attachments/${filename}`,
      mimeType,
      size: req.file.size
    });
  });

  // ============ Chat History ============

  /**
   * GET /api/assistant/history
   * Load recent chat history from conversation_entries for display in the chat UI.
   * Respects chat_reset_at boundary from the agents table.
   * Query params:
   *   - limit: max messages (default 50, max 200)
   */
  router.get('/history', (req, res) => {
    const assistant = db ? resolveAgent(req) : null;
    if (!assistant) {
      return res.status(404).json({ error: 'Assistant not found' });
    }

    const limit = Math.min(parseInt(req.query.limit) || 50, 200);

    try {
      // Get the agent's chat_reset_at boundary
      const agent = AgentService.getById(db, assistant.id);
      const resetAt = agent?.chat_reset_at || null;

      let sql = `
        SELECT id, role, speaker, content, timestamp
        FROM conversation_entries
        WHERE app_id = ?
          AND channel = 'desktop'
          AND type = 'conversation'
          AND internal_tag IS NULL
      `;
      const params = [assistant.id];

      if (resetAt) {
        sql += ' AND timestamp >= ?';
        params.push(resetAt);
      }

      sql += ' ORDER BY timestamp DESC LIMIT ?';
      params.push(limit);

      const rows = db.prepare(sql).all(...params);

      // Reverse for chronological order, strip internal notes, and extract file attachments
      const { stripInternalNotes, stripReaction, extractFileAttachments, stripFileAttachments } = require('../utils/internal-notes');
      const entries = rows.reverse().map(row => {
        const stripped = stripInternalNotes(row.content);
        const attachments = extractFileAttachments(stripped);
        const content = stripReaction(stripFileAttachments(stripped));
        return {
          id: row.id,
          role: row.role,
          speaker: row.speaker,
          content,
          attachments: attachments.length > 0 ? attachments : undefined,
          timestamp: row.timestamp
        };
      });

      // Check if there are more messages beyond this limit
      let countSql = `
        SELECT COUNT(*) as total
        FROM conversation_entries
        WHERE app_id = ?
          AND channel = 'desktop'
          AND type = 'conversation'
          AND internal_tag IS NULL
      `;
      const countParams = [assistant.id];
      if (resetAt) {
        countSql += ' AND timestamp >= ?';
        countParams.push(resetAt);
      }
      const { total } = db.prepare(countSql).get(...countParams);

      res.json({
        entries,
        resetAt,
        hasMore: total > limit
      });
    } catch (err) {
      console.error('History error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Reset session — sets a display boundary so older messages are hidden from chat UI
  router.post('/reset', (req, res) => {
    const agentState = resolveState(req);
    agentState.setSessionId(null);

    // Set chat_reset_at on the agent so history is hidden before this point
    const assistant = db ? resolveAgent(req) : null;
    const resetAt = new Date().toISOString();
    if (assistant) {
      AgentService.update(db, assistant.id, { chat_reset_at: resetAt });
    }

    res.json({ success: true, resetAt });
  });

  // Get session status
  router.get('/status', (req, res) => {
    const sessionId = state.getSessionId();
    res.json({
      hasSession: !!sessionId,
      sessionId: sessionId
    });
  });

  // ============ Memory API ============
  router.get('/memory/status', async (req, res) => {
    const assistant = db ? resolveAgent(req) : null;
    if (!assistant) {
      return res.status(404).json({ error: 'Assistant not found' });
    }

    const agentState = resolveState(req);
    const memory = agentState.getMemory();
    const watcher = agentState.getMemoryWatcher();

    // Get stats from memory service
    const stats = memory ? memory.getStats() : null;

    res.json({
      watcher: watcher ? watcher.getStatus() : { running: false },
      stats: stats ? {
        totalChunks: stats.totalChunks,
        totalSources: stats.totalSources,
        lastIndexedAt: stats.lastIndexedAt,
        cacheHitRate: stats.cacheHitRate
      } : null
    });
  });

  router.post('/memory/index', async (req, res) => {
    const assistant = db ? resolveAgent(req) : null;
    if (!assistant) {
      return res.status(404).json({ error: 'Assistant not found' });
    }

    const { agentDir: appPath, agentBlobDir } = AgentService.getPaths(assistant.app_id, assistant.id);

    const memState = resolveState(req);
    let memory = memState.getMemory();
    if (!memory) {
      memory = new MemoryService(appPath, db, assistant.id);
      memState.setMemory(memory);
    }

    try {
      const stats = await memory.indexAllMemory();
      res.json({ success: true, message: 'Memory indexed successfully', stats });
    } catch (err) {
      console.error('Memory indexing error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/memory/force-reindex', async (req, res) => {
    const assistant = db ? resolveAgent(req) : null;
    if (!assistant) {
      return res.status(404).json({ error: 'Assistant not found' });
    }

    const { agentDir: appPath, agentBlobDir } = AgentService.getPaths(assistant.app_id, assistant.id);

    const reindexState = resolveState(req);
    let memory = reindexState.getMemory();
    if (!memory) {
      memory = new MemoryService(appPath, db, assistant.id);
      reindexState.setMemory(memory);
    }

    try {
      const stats = await memory.forceReindexAll();
      res.json({ success: true, message: 'Memory force re-indexed successfully', stats });
    } catch (err) {
      console.error('Memory force re-index error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/assistant/memory/search
   * Semantic search over memory chunks (MYSELF.md, MEMORY.md, daily notes)
   * Query params:
   *   - q: search query (required)
   *   - limit: max results (default 5)
   *   - source: filter by source file (optional, e.g. 'MEMORY.md')
   *   - category: filter by category (optional: 'identity', 'curated', 'daily', 'other')
   */
  router.get('/memory/search', async (req, res) => {
    const { q, source, category } = req.query;

    if (!q) {
      return res.status(400).json({ error: 'Query parameter q is required' });
    }

    const assistant = db ? resolveAgent(req) : null;
    if (!assistant) {
      return res.status(404).json({ error: 'Assistant not found' });
    }

    const { agentDir: appPath, agentBlobDir } = AgentService.getPaths(assistant.app_id, assistant.id);

    const searchState = resolveState(req);
    let memory = searchState.getMemory();
    if (!memory) {
      memory = new MemoryService(appPath, db, assistant.id);
      searchState.setMemory(memory);
    }

    try {
      const topK = parseInt(req.query.limit) || 5;
      let results = await memory.search(q, topK * 3);

      // Post-filter by source or category if specified
      if (source) {
        results = results.filter(r => r.source === source || r.source.includes(source));
      }
      if (category) {
        results = results.filter(r => r.category === category);
      }

      res.json({ results: results.slice(0, topK) });
    } catch (err) {
      console.error('Memory search error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ============ Conversation Search API ============

  /**
   * GET /api/assistant/conversation/search
   * Search conversation history with filters
   * Query params:
   *   - q: search text (optional, uses SQL LIKE)
   *   - since: ISO date or YYYY-MM-DD start (optional)
   *   - until: ISO date or YYYY-MM-DD end (optional)
   *   - channel: filter by channel (optional)
   *   - speaker: filter by speaker (optional)
   *   - role: filter by role (optional)
   *   - type: filter by type (optional)
   *   - limit: max results (default 50, max 200)
   *   - offset: skip N results (default 0)
   */
  router.get('/conversation/search', (req, res) => {
    const assistant = db ? resolveAgent(req) : null;
    if (!assistant) {
      return res.status(404).json({ error: 'Assistant not found' });
    }

    const { q, since, until, channel, speaker, role, type } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;

    try {
      let sql = `
        SELECT id, type, speaker, role, channel, content, timestamp, date_key, metadata
        FROM conversation_entries
        WHERE app_id = ?
      `;
      const params = [assistant.id];

      if (q) {
        sql += ' AND content LIKE ?';
        params.push(`%${q}%`);
      }
      if (since) {
        sql += ' AND timestamp >= ?';
        params.push(since.length === 10 ? `${since}T00:00:00.000Z` : since);
      }
      if (until) {
        sql += ' AND timestamp <= ?';
        params.push(until.length === 10 ? `${until}T23:59:59.999Z` : until);
      }
      if (channel) {
        sql += ' AND channel = ?';
        params.push(channel);
      }
      if (speaker) {
        sql += ' AND speaker = ?';
        params.push(speaker);
      }
      if (role) {
        sql += ' AND role = ?';
        params.push(role);
      }
      if (type) {
        sql += ' AND type = ?';
        params.push(type);
      }

      // Exclude image_data from results (can be very large)
      sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);

      const rows = db.prepare(sql).all(...params);

      // Get total count for pagination
      let countSql = sql.replace(
        /SELECT id, type, speaker, role, channel, content, timestamp, date_key, metadata/,
        'SELECT COUNT(*) as total'
      ).replace(/ ORDER BY timestamp DESC LIMIT \? OFFSET \?/, '');
      const countParams = params.slice(0, -2);
      const { total } = db.prepare(countSql).get(...countParams);

      const entries = rows.map(row => ({
        ...row,
        metadata: row.metadata ? JSON.parse(row.metadata) : null
      }));

      res.json({ entries, total, limit, offset });
    } catch (err) {
      console.error('Conversation search error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/assistant/conversation/stats
   * Get conversation statistics
   * Query params:
   *   - since: ISO date or YYYY-MM-DD (optional)
   *   - until: ISO date or YYYY-MM-DD (optional)
   *   - groupBy: 'day' | 'channel' | 'speaker' | 'type' (default: 'day')
   */
  router.get('/conversation/stats', (req, res) => {
    const assistant = db ? resolveAgent(req) : null;
    if (!assistant) {
      return res.status(404).json({ error: 'Assistant not found' });
    }

    const { since, until } = req.query;
    const groupBy = req.query.groupBy || 'day';

    const validGroups = { day: 'date_key', channel: 'channel', speaker: 'speaker', type: 'type' };
    const groupCol = validGroups[groupBy];
    if (!groupCol) {
      return res.status(400).json({ error: `Invalid groupBy. Valid: ${Object.keys(validGroups).join(', ')}` });
    }

    try {
      let sql = `
        SELECT ${groupCol} as group_key, COUNT(*) as count
        FROM conversation_entries
        WHERE app_id = ?
      `;
      const params = [assistant.id];

      if (since) {
        sql += ' AND timestamp >= ?';
        params.push(since.length === 10 ? `${since}T00:00:00.000Z` : since);
      }
      if (until) {
        sql += ' AND timestamp <= ?';
        params.push(until.length === 10 ? `${until}T23:59:59.999Z` : until);
      }

      sql += ` GROUP BY ${groupCol} ORDER BY ${groupCol}`;

      const rows = db.prepare(sql).all(...params);

      // Also get overall totals
      let totalSql = `
        SELECT COUNT(*) as total,
               MIN(timestamp) as earliest,
               MAX(timestamp) as latest
        FROM conversation_entries
        WHERE app_id = ?
      `;
      const totalParams = [assistant.id];
      if (since) {
        totalSql += ' AND timestamp >= ?';
        totalParams.push(since.length === 10 ? `${since}T00:00:00.000Z` : since);
      }
      if (until) {
        totalSql += ' AND timestamp <= ?';
        totalParams.push(until.length === 10 ? `${until}T23:59:59.999Z` : until);
      }

      const totals = db.prepare(totalSql).get(...totalParams);

      res.json({
        groupBy,
        groups: rows,
        total: totals.total,
        earliest: totals.earliest,
        latest: totals.latest
      });
    } catch (err) {
      console.error('Conversation stats error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/assistant/conversation/:id
   * Get a single conversation entry by ID
   */
  router.get('/conversation/:id', (req, res) => {
    const assistant = db ? resolveAgent(req) : null;
    if (!assistant) {
      return res.status(404).json({ error: 'Assistant not found' });
    }

    try {
      const row = db.prepare(`
        SELECT id, type, speaker, role, channel, content, timestamp, date_key, metadata
        FROM conversation_entries
        WHERE app_id = ? AND id = ?
      `).get(assistant.id, req.params.id);

      if (!row) {
        return res.status(404).json({ error: 'Entry not found' });
      }

      res.json({
        ...row,
        metadata: row.metadata ? JSON.parse(row.metadata) : null
      });
    } catch (err) {
      console.error('Conversation get error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ============ Digest API ============

  /**
   * GET /api/assistant/digest/pending
   * Returns undigested conversation blocks for the agent to summarize.
   * Query params:
   *   - olderThan: hours (default 4) — only digest entries older than this
   *   - blockSize: hours (default 2) — group entries into blocks of this size
   */
  router.get('/digest/pending', (req, res) => {
    const assistant = db ? resolveAgent(req) : null;
    if (!assistant) {
      return res.status(404).json({ error: 'Assistant not found' });
    }

    const olderThanHours = parseFloat(req.query.olderThan) || 4;
    const blockSizeHours = parseFloat(req.query.blockSize) || 2;
    const olderThanMs = olderThanHours * 60 * 60 * 1000;
    const blockSizeMs = blockSizeHours * 60 * 60 * 1000;

    try {
      const blocks = DigestService.getPendingDigestBlocks(db, assistant.id, olderThanMs, blockSizeMs);

      const formatted = blocks.map(block => ({
        timeStart: block.timeStart,
        timeEnd: block.timeEnd,
        entryCount: block.entries.length,
        text: DigestService.formatBlockForDigest(block)
      }));

      res.json({ blocks: formatted, totalBlocks: formatted.length });
    } catch (err) {
      console.error('Digest pending error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/assistant/digest/save
   * Agent saves a completed digest for a time block.
   * Body: { timeStart, timeEnd, content, entryCount?, metadata? }
   */
  router.post('/digest/save', (req, res) => {
    const assistant = db ? resolveAgent(req) : null;
    if (!assistant) {
      return res.status(404).json({ error: 'Assistant not found' });
    }

    const { timeStart, timeEnd, content, entryCount, metadata } = req.body;

    if (!timeStart || !timeEnd || !content) {
      return res.status(400).json({ error: 'timeStart, timeEnd, and content are required' });
    }

    try {
      const digest = DigestService.saveDigest(db, assistant.id, {
        timeStart, timeEnd, content, entryCount, metadata
      });
      res.json({ success: true, digest });
    } catch (err) {
      console.error('Digest save error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/assistant/digest/status
   * Returns digest coverage health check.
   */
  router.get('/digest/status', (req, res) => {
    const assistant = db ? resolveAgent(req) : null;
    if (!assistant) {
      return res.status(404).json({ error: 'Assistant not found' });
    }

    try {
      const status = DigestService.getDigestStatus(db, assistant.id);
      res.json(status);
    } catch (err) {
      console.error('Digest status error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/assistant/digest/backfill
   * One-time backfill of all historical session + daily digests.
   * Query params:
   *   - agentId: optional, only backfill this agent (default: all agents)
   */
  router.post('/digest/backfill', async (req, res) => {
    try {
      const DigestEngine = require('../services/digest-engine');
      const agentId = req.query.agentId || null;
      const logs = [];
      const result = await DigestEngine.backfill(db, agentId, (msg) => {
        logs.push(msg);
        console.log(msg);
      });
      res.json({ ...result, logs });
    } catch (err) {
      console.error('Digest backfill error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ============ Image View API ============

  /**
   * GET /api/assistant/latest-image
   * Get the latest image filename from a folder in the assistant's blob storage
   * Query params:
   *   - folder: folder name relative to assistant's blob (e.g., 'current-image')
   */
  router.get('/latest-image', (req, res) => {
    const { folder, type } = req.query;

    if (!folder) {
      return res.status(400).json({ error: 'folder parameter required' });
    }

    // Get assistant app
    const assistant = db ? resolveAgent(req) : null;
    if (!assistant) {
      return res.status(404).json({ error: 'Assistant not found' });
    }

    // Build path to the folder in assistant's blob storage
    const { agentBlobDir: listBlobDir } = AgentService.getPaths(assistant.app_id, assistant.id);
    const folderPath = path.join(listBlobDir, folder);

    try {
      if (!fs.existsSync(folderPath)) {
        return res.status(404).json({ error: 'Folder not found' });
      }

      // Get all files, filter for images
      let files = fs.readdirSync(folderPath)
        .filter(f => /\.(png|jpg|jpeg|gif|webp)$/i.test(f));

      // Apply type filter if specified
      if (type === 'third-person') {
        files = files.filter(f => !f.includes('-pov.'));
      } else if (type === 'pov') {
        files = files.filter(f => f.includes('-pov.'));
      }

      // Sort descending (Z-A for latest first)
      files.sort((a, b) => b.localeCompare(a));

      if (files.length === 0) {
        // Fallback: check for headshot in reference-images (sibling of current-image)
        const refDir = path.join(listBlobDir, 'reference-images');
        if (fs.existsSync(refDir)) {
          const headshot = fs.readdirSync(refDir)
            .find(f => /^headshot\.(png|jpg|jpeg|gif|webp)$/i.test(f));
          if (headshot) {
            return res.json({ filename: headshot, folder: 'reference-images', count: 1 });
          }
        }
        return res.status(404).json({ error: 'No images found' });
      }

      res.json({ filename: files[0], count: files.length });
    } catch (err) {
      console.error('Error reading image folder:', err);
      res.status(500).json({ error: 'Failed to read folder' });
    }
  });

  return router;
}

module.exports = createAssistantRouter;

module.exports.meta = {
  name: 'assistant',
  description: 'Agent conversation, memory search, and digest management',
  basePath: '/api/assistant',
  endpoints: [
    { method: 'GET', path: '/memory/search', description: 'Semantic memory search',
      params: { q: 'string, required', limit: 'number, optional' } },
    { method: 'GET', path: '/conversation/search', description: 'Search conversation history',
      params: { q: 'string, optional', startDate: 'ISO date, optional', endDate: 'ISO date, optional' } },
    { method: 'GET', path: '/conversation/stats', description: 'Conversation statistics' },
    { method: 'GET', path: '/digest/pending', description: 'Get entries pending digest compression' },
    { method: 'POST', path: '/digest/save', description: 'Save a digest summary' },
    { method: 'GET', path: '/digest/status', description: 'Digest system status' },
    { method: 'GET', path: '/latest-image', description: 'Get most recent agent image' }
  ]
};
