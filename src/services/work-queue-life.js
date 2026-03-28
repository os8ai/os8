/**
 * Specialized job executors for agent life simulation and motivations updates.
 * Extracted from work-queue.js — these orchestrate SimService, prompt builders,
 * and CLI spawning for life-related scheduled jobs.
 */

const path = require('path');
const fs = require('fs');
const { JobsFileService } = require('./jobs-file');
const AgentService = require('./agent');
const SimService = require('./sim');
const TelegramService = require('./telegram');
const ConversationService = require('./conversation');
const { buildLifePrompt, buildMotivationsUpdatePrompt } = require('./work-queue-prompts');
const { validateLifeOutput } = require('./work-queue-validators');

/**
 * Execute a combined agent-life job using server-side orchestration.
 * One CLI spawn → reverie + journal + portrait.
 * @param {{ appId: string, agentId: string, jobId: string, claimId: string, job: object }} payload
 * @param {number} runStartedAtMs - When the run started (for validation)
 * @param {{ getDb: function, spawnTextOnlyCli: function, extractJsonFromResponse: function, onJobComplete: function }} ctx
 */
async function executeLifeJob(payload, runStartedAtMs, ctx) {
  const { appId, agentId, jobId, claimId, job } = payload;
  const db = ctx.getDb ? ctx.getDb() : null;

  console.log(`[WorkQueue] Agent-life job — server-side orchestration`);

  const agent = db ? AgentService.getById(db, agentId) : null;
  const paths = agent ? AgentService.getPaths(appId, agentId) : AgentService.getPaths(appId, agentId);

  // 1. Get combined life context
  const port = 8888;
  const lifeContext = SimService.getLifeContext(db, agentId, port);

  // 2. Load MYSELF brief for personality (agentDir, not blobDir — that's where MYSELF.md lives)
  const myselfBrief = SimService._loadMyselfBrief(paths.agentDir);

  // 3. Load MOTIVATIONS.md if it exists (lives in agentDir, not blobDir)
  let motivationsContent = null;
  const motivationsPath = path.join(paths.agentDir, 'MOTIVATIONS.md');
  try {
    if (fs.existsSync(motivationsPath)) {
      const content = fs.readFileSync(motivationsPath, 'utf-8').trim();
      if (content) motivationsContent = content;
    }
  } catch (e) {
    console.warn('[WorkQueue] Failed to read MOTIVATIONS.md:', e.message);
  }

  // 4. Build combined prompt
  const prompt = buildLifePrompt(lifeContext, myselfBrief, motivationsContent);
  console.log(`[WorkQueue] Life prompt: ${prompt.length} chars`);

  // 4. Record job trigger
  if (db) {
    try {
      ConversationService.addEntry(db, agentId, {
        type: 'conversation',
        speaker: 'system',
        role: 'user',
        channel: 'job',
        content: `[Timed Job: ${job.name}] ${job.description || 'Agent life routine'}`,
        metadata: { jobId, jobName: job.name }
      });
    } catch (convErr) {
      console.warn('[WorkQueue] Failed to record life job trigger:', convErr.message);
    }
  }

  // 5. Spawn CLI in text-only mode — ONE spawn
  const rawResponse = await ctx.spawnTextOnlyCli(agentId, prompt);
  console.log(`[WorkQueue] Life LLM response: ${rawResponse.length} chars`);

  // 6. Extract JSON from response
  const lifeData = ctx.extractJsonFromResponse(rawResponse);

  // Validate required fields
  if (!lifeData.currentState) {
    throw new Error('LLM response missing required field: currentState');
  }
  if (!lifeData.narrative) {
    throw new Error('LLM response missing required field: narrative');
  }

  // 7. Call SimService.executeLife() — stores reverie + writes journal + generates portrait
  const result = await SimService.executeLife(db, agentId, lifeData, port);

  // 8. Build completion notes
  const noteParts = [];
  if (result.reverie) {
    noteParts.push(`${result.reverie.entries.length} reflections`);
  }
  if (result.journal) {
    noteParts.push(`Journal entry #${result.journal.entryId}`);
  }
  if (result.portrait) {
    noteParts.push(`Portrait: ${result.portrait.filename} (${result.portrait.provider})`);
  }
  let notes = `Agent-life complete. ${noteParts.join('. ')}.`;
  let status = 'completed';

  // 9. Record assistant response
  if (db) {
    try {
      const agentName = ConversationService.getAgentName(agentId);
      ConversationService.addEntry(db, agentId, {
        type: 'conversation',
        speaker: agentName,
        role: 'assistant',
        channel: 'job',
        content: `[JOB_COMPLETE: ${notes}]`,
        metadata: { jobId, jobName: job.name }
      });
    } catch (convErr) {
      console.warn('[WorkQueue] Failed to record life job response:', convErr.message);
    }
  }

  // 10. Validate portrait output
  const validation = validateLifeOutput(paths.agentBlobDir, runStartedAtMs);
  if (!validation.ok) {
    status = 'could_not_complete';
    notes = `Validation failed: ${validation.failures.join('; ')}`;
    console.warn(`[WorkQueue] Life validation failed: ${validation.failures.join('; ')}`);
  } else if (validation.summary) {
    notes = `${notes}\n\nValidation: ${validation.summary}`;
  }

  // 12. Mark completed
  const marked = await JobsFileService.markCompleted(appId, agentId, jobId, claimId, status, notes);
  if (!marked) {
    throw new Error(`Failed to mark life job ${jobId} as ${status}; claim ownership likely lost`);
  }
  console.log(`[WorkQueue] Life job marked as ${status}`);

  if (ctx.onJobComplete) {
    ctx.onJobComplete(agentId, jobId, claimId, status, notes);
  }
}

/**
 * Execute a motivations-update job — assess missions, set goals, deliver message.
 * Skips silently if agent has no MOTIVATIONS.md.
 * @param {{ appId: string, agentId: string, jobId: string, claimId: string, job: object }} payload
 * @param {{ getDb: function, spawnTextOnlyCli: function, extractJsonFromResponse: function, onJobComplete: function }} ctx
 */
async function executeMotivationsUpdateJob(payload, ctx) {
  const { appId, agentId, jobId, claimId, job } = payload;
  const db = ctx.getDb ? ctx.getDb() : null;

  const agent = db ? AgentService.getById(db, agentId) : null;
  const paths = agent ? AgentService.getPaths(appId, agentId) : AgentService.getPaths(appId, agentId);

  // Check for MOTIVATIONS.md — skip silently if absent
  const motivationsPath = path.join(paths.agentDir, 'MOTIVATIONS.md');
  if (!fs.existsSync(motivationsPath)) {
    console.log(`[WorkQueue] Motivations-update skipped — no MOTIVATIONS.md for ${agentId}`);
    await JobsFileService.markCompleted(appId, agentId, jobId, claimId, 'skipped', 'No MOTIVATIONS.md file');
    if (ctx.onJobComplete) ctx.onJobComplete(agentId, jobId, claimId, 'skipped', 'No MOTIVATIONS.md file');
    return;
  }

  const motivationsContent = fs.readFileSync(motivationsPath, 'utf-8').trim();
  const myselfBrief = SimService._loadMyselfBrief(paths.agentDir);

  // Load previous update
  let previousUpdate = null;
  if (db) {
    try {
      previousUpdate = db.prepare(
        'SELECT * FROM agent_motivation_updates WHERE agent_id = ? ORDER BY timestamp DESC LIMIT 1'
      ).get(agentId);
    } catch (e) {
      console.warn('[WorkQueue] Failed to load previous motivation update:', e.message);
    }
  }

  // Load recent missionCheck entries from agent_life_entries
  let recentMissionChecks = [];
  if (db) {
    try {
      recentMissionChecks = db.prepare(
        'SELECT mission_check, timestamp FROM agent_life_entries WHERE agent_id = ? AND mission_check IS NOT NULL ORDER BY timestamp DESC LIMIT 10'
      ).all(agentId);
    } catch (e) {
      console.warn('[WorkQueue] Failed to load missionCheck entries:', e.message);
    }
  }

  // Build prompt
  const prompt = buildMotivationsUpdatePrompt({
    motivationsContent,
    myselfBrief,
    previousUpdate,
    recentMissionChecks,
    agentName: agent?.name || 'Agent',
    period: job.schedule?.frequency === 'weekly' ? 'weekly' : 'daily'
  });
  console.log(`[WorkQueue] Motivations-update prompt: ${prompt.length} chars`);

  // Record job trigger
  if (db) {
    try {
      ConversationService.addEntry(db, agentId, {
        type: 'conversation', speaker: 'system', role: 'user', channel: 'job',
        content: `[Timed Job: ${job.name}] ${job.description || 'Motivations update'}`,
        metadata: { jobId, jobName: job.name }
      });
    } catch (e) { console.warn('[WorkQueue] Failed to record motivations job trigger:', e.message); }
  }

  // Spawn text-only CLI
  const rawResponse = await ctx.spawnTextOnlyCli(agentId, prompt);
  console.log(`[WorkQueue] Motivations-update response: ${rawResponse.length} chars`);

  const updateData = ctx.extractJsonFromResponse(rawResponse);

  if (!updateData.assessments || !updateData.goals) {
    throw new Error('LLM response missing required fields: assessments, goals');
  }

  // Store in DB
  if (db) {
    try {
      db.prepare(`
        INSERT INTO agent_motivation_updates (agent_id, period, assessments, goals, blockers, message, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        agentId,
        updateData.period || 'daily',
        JSON.stringify(updateData.assessments),
        JSON.stringify(updateData.goals),
        updateData.blockers ? JSON.stringify(updateData.blockers) : null,
        updateData.message || null,
        new Date().toISOString()
      );
      console.log(`[WorkQueue] Stored motivations update for ${agentId}`);
    } catch (e) {
      console.error('[WorkQueue] Failed to store motivations update:', e.message);
    }
  }

  // Deliver message
  const message = updateData.message;
  let deliveryMethod = 'none';
  if (message) {
    const config = db ? AgentService.getConfig(db, agentId) : {};
    if (config.telegramBotToken && config.telegramChatId) {
      try {
        await TelegramService.send(config.telegramBotToken, config.telegramChatId, message);
        deliveryMethod = 'telegram';
      } catch (e) {
        console.warn('[WorkQueue] Telegram delivery failed, falling back to chat:', e.message);
      }
    }
    // Fallback or primary: store as conversation entry
    if (deliveryMethod !== 'telegram' && db) {
      try {
        const agentName = ConversationService.getAgentName(agentId);
        ConversationService.addEntry(db, agentId, {
          type: 'conversation', speaker: agentName, role: 'assistant', channel: 'job',
          content: message,
          metadata: { jobId, jobName: job.name, type: 'motivations-update' }
        });
        deliveryMethod = 'chat';
      } catch (e) { console.warn('[WorkQueue] Chat delivery failed:', e.message); }
    }
  }

  // Record completion
  const notes = `Motivations update complete. Delivered via ${deliveryMethod}.`;
  if (db) {
    try {
      const agentName = ConversationService.getAgentName(agentId);
      ConversationService.addEntry(db, agentId, {
        type: 'conversation', speaker: agentName, role: 'assistant', channel: 'job',
        content: `[JOB_COMPLETE: ${notes}]`,
        metadata: { jobId, jobName: job.name }
      });
    } catch (e) { console.warn('[WorkQueue] Failed to record motivations job response:', e.message); }
  }

  const marked = await JobsFileService.markCompleted(appId, agentId, jobId, claimId, 'completed', notes);
  if (!marked) throw new Error(`Failed to mark motivations job ${jobId} as completed`);
  console.log(`[WorkQueue] Motivations-update job completed (${deliveryMethod})`);

  if (ctx.onJobComplete) ctx.onJobComplete(agentId, jobId, claimId, 'completed', notes);
}

module.exports = {
  executeLifeJob,
  executeMotivationsUpdateJob
};
