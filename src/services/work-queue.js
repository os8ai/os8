/**
 * Unified Work Queue
 *
 * Single queue for ALL agent work - user messages AND scheduled jobs.
 * Ensures only one task runs at a time, with priority-based ordering.
 *
 * Priority: User messages (100) > Scheduled jobs (50)
 * Within same priority: FIFO by createdAt
 */

const { Mutex } = require('async-mutex');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { JobsFileService } = require('./jobs-file');
const { calculateContextBudgets, buildMemoryContext, enrichMessageWithContext, buildStreamJsonMessage, buildImageDescriptionsContext } = require('../assistant/identity-context');
const { MemoryService } = require('../assistant/memory');
const ConversationService = require('./conversation');
const { getBackend } = require('./backend-adapter');
const RoutingService = require('./routing');
const { prepareSpawnEnv, parseBatchOutput } = require('./cli-runner');
const { loadJSON } = require('../utils/file-helpers');
const AgentService = require('./agent');
const { parseJobCompletion, parsePlanStepCompletion, validateJobCompletion } = require('./work-queue-validators');
const { formatJobMessage } = require('./work-queue-prompts');
const { executeLifeJob, executeMotivationsUpdateJob } = require('./work-queue-life');

// Priority constants
const PRIORITY_THREAD = 75;
const PRIORITY_PLAN_STEP = 60;
const PRIORITY_JOB = 50;
const CLAIM_RENEW_INTERVAL_MS = 60 * 1000;

const WorkQueue = {
  queue: [],
  processing: false,
  mutex: new Mutex(),

  // Callbacks
  onJobComplete: null,       // (agentId, jobId, claimId, status, notes) => void
  onPlanStepComplete: null,  // (planId, stepId, response) => void
  getDb: null,               // () => db — getter to avoid storing db as property

  /**
   * Initialize the queue with execution callbacks
   * @param {{ onJobComplete: function, onPlanStepComplete?: function, getDb: function }} callbacks
   */
  init(callbacks) {
    this.onJobComplete = callbacks.onJobComplete;
    this.onPlanStepComplete = callbacks.onPlanStepComplete || null;
    this.getDb = callbacks.getDb || null;
  },

  /**
   * Enqueue a work item
   * @param {{ type: 'user'|'job', priority: number, payload: object, createdAt: number }} item
   */
  enqueue(item) {
    this.queue.push(item);

    // Sort by priority DESC, then createdAt ASC
    this.queue.sort((a, b) => {
      if (a.priority !== b.priority) {
        return b.priority - a.priority; // Higher priority first
      }
      return a.createdAt - b.createdAt; // Earlier first (FIFO)
    });

    console.log(`[WorkQueue] Enqueued ${item.type} task (priority=${item.priority}), queue size: ${this.queue.length}`);

    // Kick the queue processor
    this.kick();
  },

  /**
   * Enqueue a scheduled job (convenience method)
   * @param {{ appId: string, jobId: string, claimId: string, job: object }} payload
   */
  enqueueJob(payload) {
    this.enqueue({
      type: 'job',
      priority: PRIORITY_JOB,
      payload,
      createdAt: Date.now()
    });
  },

  /**
   * Process the queue serially
   */
  async kick() {
    // Acquire mutex to prevent re-entrant calls
    const release = await this.mutex.acquire();
    try {
      if (this.processing) return;
      this.processing = true;

      while (this.queue.length > 0) {
        const task = this.queue.shift();
        try {
          await this.executeOne(task);
        } catch (err) {
          console.error(`[WorkQueue] Error executing ${task.type} task:`, err);

          try {
            // If it's a job, mark it as failed
            if (task.type === 'job' && this.onJobComplete) {
              const { agentId: failedAgentId, jobId, claimId } = task.payload;
              this.onJobComplete(failedAgentId, jobId, claimId, 'failed', err.message);
            }

            // If it's a plan step, notify executor of failure
            if (task.type === 'plan-step' && this.onPlanStepComplete) {
              const { planId, stepId } = task.payload;
              this.onPlanStepComplete(planId, stepId, null);
            }
          } catch (handlerErr) {
            console.error(`[WorkQueue] Error in ${task.type} error handler:`, handlerErr);
          }
        }
      }
    } finally {
      this.processing = false;
      release();
    }
  },

  /**
   * Execute a single task
   * @param {{ type: 'thread'|'job', priority: number, payload: object }} task
   */
  async executeOne(task) {
    console.log(`[WorkQueue] Executing ${task.type} task`);

    if (task.type === 'thread') {
      // Execute thread response
      const { ThreadOrchestrator } = require('./thread-orchestrator');
      await ThreadOrchestrator.executeThreadResponse(task.payload);

    } else if (task.type === 'plan-step') {
      // Execute plan step
      await this.executePlanStep(task.payload);

    } else if (task.type === 'job') {
      // Execute scheduled job
      await this.executeJob(task.payload);
    }
  },

  /**
   * Execute a scheduled job
   * @param {{ appId: string, agentId: string, jobId: string, claimId: string, job: object }} payload
   */
  async executeJob(payload) {
    const { appId, agentId, jobId, claimId, job } = payload;
    const runStartedAtMs = Date.now();

    console.log(`[WorkQueue] Executing job: ${job.name}`);

    // Mark as running
    const started = await JobsFileService.markRunning(appId, agentId, jobId, claimId);
    if (!started) {
      console.warn(`[WorkQueue] Failed to mark job ${jobId} as running (claim may have expired)`);
      if (this.onJobComplete) {
        this.onJobComplete(agentId, jobId, claimId, 'failed', 'Failed to transition claim to running');
      }
      return;
    }

    // Keep lease alive while the agent is working so long jobs are not recovered as orphans.
    const renewTimer = setInterval(async () => {
      try {
        const renewed = await JobsFileService.renewClaim(appId, agentId, jobId, claimId);
        if (!renewed) {
          console.warn(`[WorkQueue] Failed to renew claim for job ${jobId}; ownership may be lost`);
        }
      } catch (err) {
        console.warn(`[WorkQueue] Claim renewal error for job ${jobId}: ${err.message}`);
      }
    }, CLAIM_RENEW_INTERVAL_MS);

    try {
      // Server-side orchestrated jobs (no tool use needed)
      const skillId = (job.skill || '').trim().toLowerCase();
      const jobName = (job.name || '').trim().toLowerCase();
      const lifeCtx = {
        getDb: this.getDb,
        spawnTextOnlyCli: this.spawnTextOnlyCli.bind(this),
        extractJsonFromResponse: this.extractJsonFromResponse.bind(this),
        onJobComplete: this.onJobComplete
      };
      if (skillId === 'agent-life' || jobName === 'agent life') {
        await executeLifeJob(payload, runStartedAtMs, lifeCtx);
        return;
      }
      if (skillId === 'motivations-update' || jobName === 'motivations update') {
        await executeMotivationsUpdateJob(payload, lifeCtx);
        return;
      }

      // Format the job message for the agent
      const message = formatJobMessage(job, { getDb: this.getDb });
      let response = '';

      // Record job trigger to conversation DB (job instruction as "user" entry)
      const db = this.getDb ? this.getDb() : null;
      if (db) {
        try {
          ConversationService.addEntry(db, agentId, {
            type: 'conversation',
            speaker: 'system',
            role: 'user',
            channel: 'job',
            content: `[Timed Job: ${job.name}] ${job.description || 'Scheduled task'}`,
            metadata: { jobId, jobName: job.name }
          });
        } catch (convErr) {
          console.warn('[WorkQueue] Failed to record job trigger:', convErr.message);
        }
      }

      // Spawn CLI directly for the job
      response = await this.spawnClaudeForJob(agentId, message);

      // Record assistant response to conversation DB
      if (db && response) {
        try {
          const agentName = ConversationService.getAgentName(agentId);
          ConversationService.addEntry(db, agentId, {
            type: 'conversation',
            speaker: agentName,
            role: 'assistant',
            channel: 'job',
            content: response,
            metadata: { jobId, jobName: job.name }
          });
        } catch (convErr) {
          console.warn('[WorkQueue] Failed to record job assistant response:', convErr.message);
        }
      }

      // Parse completion status and notes from agent response
      let { status, notes, hasMarker } = parseJobCompletion(response);
      console.log(`[WorkQueue] Job ${job.name} - agent status: ${status}, notes: ${notes ? notes.substring(0, 50) + '...' : 'none'}`);

      // Missing marker is treated as non-completion (no silent fallback).
      if (!hasMarker) {
        status = 'could_not_complete';
        notes = 'Missing required completion marker ([JOB_COMPLETE] or [JOB_COULD_NOT_COMPLETE]).';
      }

      // Validate outputs when agent reports success.
      if (status === 'completed') {
        const validation = validateJobCompletion(agentId, job, runStartedAtMs, { getDb: this.getDb });
        if (!validation.ok) {
          status = 'could_not_complete';
          notes = `Validation failed: ${validation.failures.join('; ')}`;
          console.warn(`[WorkQueue] Job ${job.name} validation failed: ${validation.failures.join('; ')}`);
        } else if (validation.summary) {
          notes = notes ? `${notes}\n\nValidation: ${validation.summary}` : `Validation: ${validation.summary}`;
        }
      }

      // Mark with agent-determined status
      const marked = await JobsFileService.markCompleted(appId, agentId, jobId, claimId, status, notes);
      if (!marked) {
        throw new Error(`Failed to mark job ${jobId} as ${status}; claim ownership likely lost`);
      }
      console.log(`[WorkQueue] Job ${job.name} marked as ${status}`);

      // Notify scheduler to rearm
      if (this.onJobComplete) {
        this.onJobComplete(agentId, jobId, claimId, status, notes);
      }

    } catch (err) {
      console.error(`[WorkQueue] Job ${job.name} failed:`, err);

      // Mark as failed
      const markedFailed = await JobsFileService.markCompleted(appId, agentId, jobId, claimId, 'failed', err.message);
      if (!markedFailed) {
        console.error(`[WorkQueue] Failed to mark job ${jobId} as failed; claim ownership likely lost`);
      }

      // Notify scheduler
      if (this.onJobComplete) {
        this.onJobComplete(agentId, jobId, claimId, 'failed', err.message);
      }
      // Error fully handled (marked failed + scheduler notified) — do NOT re-throw
      // Re-throwing causes double error handling in kick() and risks jamming the queue
    } finally {
      clearInterval(renewTimer);
    }
  },

  /**
   * Execute a plan step via CLI spawn.
   * @param {{ planId: string, stepId: string, agentId: string, prompt: string }} payload
   */
  async executePlanStep(payload) {
    const { planId, stepId, agentId, prompt } = payload;
    const db = this.getDb ? this.getDb() : null;

    console.log(`[WorkQueue] Executing plan step ${stepId} for plan ${planId}`);

    try {
      // Update step status to running
      if (db) {
        const PlanService = require('./plan');
        PlanService.updateStep(db, stepId, {
          status: 'running',
          started_at: new Date().toISOString()
        });
      }

      // Record plan step trigger to conversation DB
      if (db) {
        try {
          ConversationService.addEntry(db, agentId, {
            type: 'conversation',
            speaker: 'system',
            role: 'user',
            channel: 'plan',
            content: `[Plan Step] ${prompt.substring(0, 500)}`,
            metadata: { plan_id: planId, step_id: stepId },
            internal_tag: 'plan-step'
          });
        } catch (convErr) {
          console.warn('[WorkQueue] Failed to record plan step trigger:', convErr.message);
        }
      }

      // Spawn CLI for the step
      const response = await this.spawnClaudeForJob(agentId, prompt, {
        maxTurns: 10,
        timeoutMs: 10 * 60 * 1000,
        taskType: 'planning'
      });

      // Record assistant response
      if (db && response) {
        try {
          const stepAgentName = ConversationService.getAgentName(agentId);
          ConversationService.addEntry(db, agentId, {
            type: 'conversation',
            speaker: stepAgentName,
            role: 'assistant',
            channel: 'plan',
            content: response,
            metadata: { plan_id: planId, step_id: stepId },
            internal_tag: 'plan-step'
          });
        } catch (convErr) {
          console.warn('[WorkQueue] Failed to record plan step response:', convErr.message);
        }
      }

      // Parse completion status from response
      const { status, result } = parsePlanStepCompletion(response, stepId);

      // Update step status
      if (db) {
        const PlanService = require('./plan');
        PlanService.updateStep(db, stepId, {
          status,
          result,
          completed_at: new Date().toISOString()
        });
      }

      console.log(`[WorkQueue] Plan step ${stepId} ${status}: ${(result || '').substring(0, 100)}`);

      // Notify executor
      if (this.onPlanStepComplete) {
        this.onPlanStepComplete(planId, stepId, response);
      }
    } catch (err) {
      console.error(`[WorkQueue] Plan step ${stepId} failed:`, err);

      if (db) {
        const PlanService = require('./plan');
        PlanService.updateStep(db, stepId, {
          status: 'failed',
          result: err.message,
          completed_at: new Date().toISOString()
        });
      }

      if (this.onPlanStepComplete) {
        this.onPlanStepComplete(planId, stepId, null);
      }
    }
  },

  /**
   * Spawn Claude to execute a job message
   * Uses same approach as chat handler for reliability
   * @param {string} appId - The app ID (assistant app)
   * @param {string} jobMessage - The job message to send to Claude
   * @param {object} [opts] - Options
   * @param {number} [opts.maxTurns] - Max tool-use turns (default: 10)
   * @param {number} [opts.timeoutMs] - Timeout in ms (default: 10 min)
   * @param {boolean} [opts.skipSemanticSearch] - Skip expensive semantic memory search (default: false)
   */
  async spawnClaudeForJob(appId, jobMessage, opts = {}) {
    const {
      maxTurns = 10,
      timeoutMs = 10 * 60 * 1000,
      skipSemanticSearch = false,
      taskType = 'jobs',
      threadParticipantIds = null,
      threadAttachments = []
    } = opts;

    const db = this.getDb ? this.getDb() : null;
    const spawnAgent = db ? AgentService.getById(db, appId) : null;
    const { agentDir: appPath, agentBlobDir } = spawnAgent ? AgentService.getPaths(spawnAgent.app_id, appId) : AgentService.getPaths(appId);

    // Resolve backend + model via routing cascade (jobs = API-only per ToS)
    const assistantConfig = (db && AgentService.getConfig(db, appId)) || loadJSON(path.join(appPath, 'assistant-config.json'), {});
    const wqOverride = assistantConfig.agentModel || null;
    const wqResolved = db ? RoutingService.resolve(db, taskType, wqOverride) : {
      familyId: null, backendId: assistantConfig.agentBackend || 'claude',
      modelArg: wqOverride, source: 'fallback'
    };
    const backendId = wqResolved.backendId;
    const wqModel = wqResolved.modelArg;
    const backend = getBackend(backendId);
    console.log(`[Routing] ${taskType}/spawnClaudeForJob: ${wqResolved.familyId} via ${wqResolved.source}`);

    // Build full identity + memory context (same as chat/Telegram/calls)
    const {
      identityContext,
      conversationBudgetChars,
      semanticBudgetChars,
      presentMomentImageData: imageData,
      panoramaData,
      timelineImages,
      ownerImage,
      participantImages,
      ownerName: wqOwnerName,
      assistantName: wqAssistantName,
      imageDescriptions: wqImageDescriptions
    } = await calculateContextBudgets(appPath, db, undefined, { backend, threadParticipantIds });

    let memoryContext = '';
    if (db) {
      try {
        const memory = new MemoryService(appPath, db, appId);
        const context = await memory.getContextForMessage(jobMessage, {
          conversationBudgetChars,
          semanticBudgetChars,
          skipSemanticSearch,
          priorityOrder: ['identity', 'curated', 'daily']
        });
        memoryContext = buildMemoryContext(context);
        console.log('[WorkQueue] Built memory context for job');
      } catch (memErr) {
        console.warn('[WorkQueue] Memory context error:', memErr.message);
      }
    } else {
      console.log('[WorkQueue] No DB available, skipping memory context for job');
    }

    // Check if we have images to include
    const anyImages = imageData?.thirdPerson || panoramaData?.contactSheet || ownerImage || (participantImages && participantImages.length > 0);
    const hasImageStdin = backend.supportsImageInput && anyImages;   // Claude: base64 via stream-json stdin
    const hasImageFiles = backend.supportsImageViaFile && anyImages; // Codex: --image file paths
    const hasImages = hasImageStdin || hasImageFiles;

    // Include image descriptions for backends that can't see images (Grok)
    let imageDescContext = '';
    if (backend.supportsImageDescriptions && wqImageDescriptions) {
      imageDescContext = buildImageDescriptionsContext(wqImageDescriptions, { ownerName: wqOwnerName, assistantName: wqAssistantName });
      console.log(`[WorkQueue] Including image descriptions for ${backendId}`);
    }

    // Combine identity and memory context with job message
    const fullContext = identityContext + imageDescContext + memoryContext;

    // Cache context for debug viewer (thread responses)
    if (threadParticipantIds) {
      try {
        const { getAgentState } = require('./agent-state');
        const imgMeta = (img, label) => img ? { label, sizeKB: Math.round((img.data?.length || 0) * 3 / 4 / 1024), mediaType: img.mediaType } : null;
        getAgentState(appId).lastContext = {
          timestamp: new Date().toISOString(),
          identityContext,
          memoryContext,
          skillContext: '',
          agentDMContext: '',
          fullContext: fullContext.substring(0, 2000) + '...',
          enrichedMessage: (fullContext + jobMessage).substring(0, 2000) + '...',
          images: [
            imgMeta(imageData?.thirdPerson, 'Present Moment (3rd person)'),
            imgMeta(panoramaData?.contactSheet, 'Panorama'),
            imgMeta(ownerImage, `Owner (${wqOwnerName || 'user'})`),
            ...(participantImages || []).map(p => imgMeta(p, `Participant: ${p.agentName}`)),
          ].filter(Boolean),
          imageDataUrls: [
            imageData?.thirdPerson ? { label: 'Present Moment (3rd person)', dataUrl: `data:${imageData.thirdPerson.mediaType};base64,${imageData.thirdPerson.data}` } : null,
            panoramaData?.contactSheet ? { label: 'Panorama', dataUrl: `data:${panoramaData.contactSheet.mediaType};base64,${panoramaData.contactSheet.data}` } : null,
            ownerImage ? { label: `Owner (${wqOwnerName || 'user'})`, dataUrl: `data:${ownerImage.mediaType};base64,${ownerImage.data}` } : null,
            ...(participantImages || []).map(p => ({ label: `Participant: ${p.agentName}`, dataUrl: `data:${p.mediaType};base64,${p.data}` })),
          ].filter(Boolean),
          subconsciousEnabled: false,
        };
        const { persistContextCache } = require('../assistant/message-handler-helpers');
        persistContextCache(db, appId, getAgentState(appId).lastContext);
      } catch (_e) { /* non-critical */ }
    }

    return new Promise((resolve, reject) => {
      // Prepare environment with PATH + database env vars (API keys from Settings)
      const env = prepareSpawnEnv(db, backendId, wqResolved.accessMethod);

      // Build args via backend adapter
      const args = backend.buildArgs({
        print: true,
        skipPermissions: true,
        maxTurns: backend.supportsMaxTurns ? maxTurns : undefined,
        verbose: hasImages,
        streamJson: hasImages,
        json: !hasImages,
        inputFormatStreamJson: hasImageStdin,
        appPath,
        blobDir: agentBlobDir,
        model: wqModel,
        env,
      });

      // Write images to temp files for backends that support --image file paths (Codex)
      let codexTempDir = null;
      let jobImageManifest = '';
      if (hasImageFiles && backend.buildImageFileArgs) {
        codexTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-codex-img-'));
        const { args: imageArgs, manifest } = backend.buildImageFileArgs({
          presentMoment: imageData,
          panorama: panoramaData,
          owner: ownerImage,
          participants: participantImages,
          timeline: timelineImages,
          userAttachments: threadAttachments
        }, codexTempDir, { ownerName: wqOwnerName, assistantName: wqAssistantName });
        args.push(...imageArgs);
        jobImageManifest = manifest;
        console.log(`[WorkQueue] Codex images: ${imageArgs.length / 2} files written to ${codexTempDir}`);
      }

      const enrichedMessage = jobImageManifest + enrichMessageWithContext(jobMessage, fullContext);

      // For non-image-stdin path, pass message as CLI argument via buildPromptArgs
      // For image-stdin path (Claude only), message goes via stdin as stream-json
      if (!hasImageStdin) {
        args.push(...backend.buildPromptArgs(enrichedMessage));
      }

      console.log(`[WorkQueue] Spawning ${backend.command} for job in ${appPath} [backend: ${backendId}]`);
      console.log(`[WorkQueue] Job message: "${jobMessage.substring(0, 100)}..." (${enrichedMessage.length} chars)`);
      if (hasImageStdin) {
        console.log(`[WorkQueue] Including ${imageData.thirdPerson ? 1 : 0} images via stdin`);
      } else if (hasImageFiles) {
        console.log(`[WorkQueue] Including images via --image file paths`);
      }

      // Use spawn WITHOUT shell to avoid argument escaping issues
      const claude = spawn(backend.command, args, {
        cwd: appPath,
        env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // Write to stdin: images via stream-json, or prompt for backends that need stdin
      if (hasImageStdin) {
        const streamJsonMsg = buildStreamJsonMessage({
          identityText: enrichedMessage,
          presentMomentImages: imageData,
          panoramaData,
          ownerImage,
          participantImages,
          timelineImages,
          userMessage: '',
          userAttachments: threadAttachments,
          conversationBudgetChars: 0,
          ownerName: wqOwnerName
        });
        claude.stdin.write(streamJsonMsg + '\n');
      } else if (backend.promptViaStdin && enrichedMessage) {
        // Codex: pipe prompt via stdin (avoids ARG_MAX with large context)
        claude.stdin.write(enrichedMessage);
      }
      claude.stdin.end();

      let stdout = '';
      let stderr = '';

      // Timeout (configurable, default 10 min for jobs)
      const timeout = setTimeout(() => {
        console.error(`[WorkQueue] Timeout (${backend.label}) after ${Math.round(timeoutMs / 60000)}m - stdout so far: ${stdout.substring(0, 500)}`);
        claude.kill();
        reject(new Error(`Execution timed out after ${Math.round(timeoutMs / 60000)} minutes (${backend.label})`));
      }, timeoutMs);

      claude.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      claude.stderr.on('data', (data) => {
        const text = data.toString();
        stderr += text;
        // Log stderr for debugging
        if (text.trim()) {
          console.log(`[WorkQueue] ${backend.label} stderr: ${text.substring(0, 200)}`);
        }
      });

      claude.on('close', (code) => {
        clearTimeout(timeout);

        // Clean up Codex temp image files
        if (codexTempDir) {
          try { fs.rmSync(codexTempDir, { recursive: true, force: true }); } catch (e) {}
        }

        console.log(`[WorkQueue] ${backend.label} exited with code ${code}, stdout: ${stdout.length} chars`);

        if (code !== 0) {
          console.error(`[WorkQueue] ${backend.label} failed with exit code ${code}, stderr: ${stderr}`);
          // If no stdout at all, reject as error
          if (!stdout.trim()) {
            reject(new Error(`${backend.label} exited with code ${code}: ${stderr}`));
            return;
          }
          // Otherwise fall through and try to parse whatever we got
          console.log(`[WorkQueue] ${backend.label} crashed but has output, attempting to parse`);
        }

        // Parse response via shared utility (handles all backend formats)
        const textResponse = parseBatchOutput(stdout);
        if (textResponse) {
          console.log(`[WorkQueue] ${backend.label} response parsed: ${textResponse.length} chars`);
          resolve(textResponse);
        } else {
          console.error(`[WorkQueue] Failed to parse ${backend.label} response`);
          console.error(`[WorkQueue] Raw stdout (first 500 chars): ${stdout.substring(0, 500)}`);
          resolve(stdout);
        }
      });

      claude.on('error', (err) => {
        clearTimeout(timeout);
        // Clean up Codex temp image files
        if (codexTempDir) {
          try { fs.rmSync(codexTempDir, { recursive: true, force: true }); } catch (e) {}
        }
        console.error(`[WorkQueue] ${backend.label} spawn error: ${err.message}`);
        reject(err);
      });
    });
  },



  /**
   * Extract a JSON object from LLM text response.
   * Tries: direct parse → ```json code block → outermost { } braces
   * @param {string} text - Raw LLM response text
   * @returns {object} Parsed JSON
   */
  extractJsonFromResponse(text) {
    const trimmed = (text || '').trim();

    // 1. Direct parse
    try {
      return JSON.parse(trimmed);
    } catch (e) {
      console.warn(`[work-queue] JSON extract attempt 1 (direct parse) failed: ${e.message}`);
    }

    // 2. ```json code block
    const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (codeBlockMatch) {
      try {
        return JSON.parse(codeBlockMatch[1].trim());
      } catch (e) {
        console.warn(`[work-queue] JSON extract attempt 2 (code block) failed: ${e.message}`);
      }
    }

    // 3. Outermost { ... }
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(trimmed.substring(firstBrace, lastBrace + 1));
      } catch (e) {
        console.warn(`[work-queue] JSON extract attempt 3 (brace extract) failed: ${e.message}`);
      }
    }

    throw new Error(`Failed to extract JSON from LLM response: ${trimmed.substring(0, 200)}`);
  },

  /**
   * Spawn a CLI backend in text-only mode (no tool use).
   * Used for server-side orchestrated tasks where the LLM only generates text.
   * @param {string} appId - Agent/app ID
   * @param {string} prompt - The prompt to send
   * @param {object} [opts] - Options
   * @param {number} [opts.timeoutMs] - Timeout in ms (default: 5 min)
   * @returns {Promise<string>} Raw text response from the LLM
   */
  async spawnTextOnlyCli(appId, prompt, opts = {}) {
    const { timeoutMs = 5 * 60 * 1000 } = opts;

    const db = this.getDb ? this.getDb() : null;
    const agent = db ? AgentService.getById(db, appId) : null;
    const { agentDir: appPath } = agent ? AgentService.getPaths(agent.app_id, appId) : AgentService.getPaths(appId);

    // Resolve backend + model via routing cascade (jobs = API-only per ToS)
    const assistantConfig = (db && AgentService.getConfig(db, appId)) || loadJSON(path.join(appPath, 'assistant-config.json'), {});
    const textOverride = assistantConfig.agentModel || null;
    const textResolved = db ? RoutingService.resolve(db, 'jobs', textOverride) : {
      familyId: null, backendId: assistantConfig.agentBackend || 'claude',
      modelArg: textOverride, source: 'fallback'
    };
    const backendId = textResolved.backendId;
    const model = textResolved.modelArg;
    const backend = getBackend(backendId);
    console.log(`[Routing] jobs/spawnTextOnlyCli: ${textResolved.familyId} via ${textResolved.source}`);

    // HTTP backends (local launcher) have no CLI to spawn — route through
    // the HTTP path just like createHttpProcess does for streaming. Phase 2B
    // wired launcher_model/launcher_backend onto textResolved for local
    // families, so sendTextPromptHttp can ensureModel + POST without extra
    // lookups. Returns the completion text directly; bypasses the spawn
    // branch entirely.
    if (backend.type === 'http') {
      console.log(`[WorkQueue] HTTP dispatch (text-only) via ${textResolved.launcher_model || 'unknown'} [backend: ${backendId}]`);
      const { sendTextPromptHttp } = require('./cli-runner');
      try {
        // Wrap in a timeout so a hung launcher doesn't block the work-queue
        // executor indefinitely. `timeoutMs` is already bounded by the caller.
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`HTTP text-only timed out after ${Math.round(timeoutMs / 60000)} minutes`)), timeoutMs);
        });
        const text = await Promise.race([
          sendTextPromptHttp(textResolved, prompt, { taskType: 'jobs' }),
          timeoutPromise
        ]);
        return text;
      } catch (err) {
        throw new Error(`${backend.label} (text-only HTTP) failed: ${err.message}`);
      }
    }

    // Prepare environment
    const env = prepareSpawnEnv(db, backendId, textResolved.accessMethod);

    // Build text-only args
    const args = backend.buildTextOnlyArgs({ model });
    args.push(...backend.buildPromptArgs(prompt));

    console.log(`[WorkQueue] Spawning ${backend.command} (text-only) for snapshot [backend: ${backendId}]`);

    return new Promise((resolve, reject) => {
      const child = spawn(backend.command, args, {
        cwd: appPath,
        env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // Codex reads prompt via stdin
      if (backend.promptViaStdin && prompt) {
        child.stdin.write(prompt);
      }
      child.stdin.end();

      let stdout = '';
      let stderr = '';

      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`Text-only CLI timed out after ${Math.round(timeoutMs / 60000)} minutes (${backend.label})`));
      }, timeoutMs);

      child.stdout.on('data', (data) => { stdout += data.toString(); });
      child.stderr.on('data', (data) => { stderr += data.toString(); });

      child.on('close', (code) => {
        clearTimeout(timeout);

        if (code !== 0 && !stdout.trim()) {
          reject(new Error(`${backend.label} (text-only) exited with code ${code}: ${stderr}`));
          return;
        }

        // Parse response using backend's parser
        const parsed = backend.parseResponse(stdout);
        resolve(parsed.text || stdout.trim());
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to spawn ${backend.label} (text-only): ${err.message}`));
      });
    });
  },

  /**
   * Check if there are pending tasks for a specific thread
   * @param {string} threadId
   * @returns {boolean}
   */
  hasPendingForThread(threadId) {
    return this.queue.some(item =>
      item.type === 'thread' && item.payload.threadId === threadId
    );
  },

  /**
   * Get queue status (for debugging)
   */
  getStatus() {
    return {
      queueLength: this.queue.length,
      processing: this.processing,
      items: this.queue.map(item => ({
        type: item.type,
        priority: item.priority,
        createdAt: item.createdAt
      }))
    };
  },

  /**
   * Clear the queue (for testing/cleanup)
   */
  clear() {
    this.queue = [];
  }
};

module.exports = {
  WorkQueue,
  PRIORITY_THREAD,
  PRIORITY_PLAN_STEP,
  PRIORITY_JOB
};
