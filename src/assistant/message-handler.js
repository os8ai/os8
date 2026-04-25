/**
 * Message handlers for assistant chat
 * Handles /send (PTY-based streaming) and /chat (spawn-based) endpoints
 *
 * Implementation split across:
 * - message-handler-parse.js   — stream parsing utilities (findPartialMatch, parseStreamJsonOutput)
 * - message-handler-helpers.js  — env preparation, image storage
 * - message-handler-plan.js     — plan command interception (/plan, /approve, /cancel, /reject, /modify)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { createProcess } = require('../services/cli-runner');
const {
  buildMemoryContext,
  buildSemanticMemoryContext,
  enrichMessageWithContext,
  buildAgentDMContext,
  buildStructuralIdentity,
  calculateContextBudgets,
  buildStreamJsonMessage,
  buildImageDescriptionsContext,
  buildTimelineDescriptionItems
} = require('./identity-context');
const { readImageAsBase64Compressed } = require('./identity-images');
const { stripInternalNotes, stripToolCallXml, extractReaction, stripReaction, extractFileAttachments, stripFileAttachments } = require('../utils/internal-notes');
const ConversationService = require('../services/conversation');
const { BLOB_DIR } = require('../config');
const { getBackend } = require('../services/backend-adapter');
const AIRegistryService = require('../services/ai-registry');
const RoutingService = require('../services/routing');
const { loadJSON } = require('../utils/file-helpers');
const { profileContextBudgets } = require('../utils/token-profiler');
const SubconsciousService = require('../services/subconscious');
const AnthropicSDK = require('../services/anthropic-sdk');
const AgentService = require('../services/agent');
const AccountService = require('../services/account');
const { CapabilityService } = require('../services/capability');
const { StreamStateTracker, extractStepsFromResponse } = require('../services/stream-tracker');
const PlanService = require('../services/plan');
const {
  broadcast,
  RUN_FINISHED,
  TEXT_MESSAGE_START,
  TEXT_MESSAGE_CONTENT,
  TEXT_MESSAGE_END,
  STEP_STARTED,
  STEP_FINISHED,
  CUSTOM,
  newRunId,
  newMessageId
} = require('../shared/agui-events');
const { createTranslator } = require('../services/backend-events');

function getUserSpeakerLabel(db) {
  if (!db) return 'user';
  const acct = AccountService.getAccount(db);
  const name = acct?.display_name || acct?.username || 'user';
  return `${name.toLowerCase()} (user)`;
}

// Extracted modules
const { findPartialInternalMatch, parseStreamJsonOutput } = require('./message-handler-parse');
const { prepareAgentEnv, prepareClaudeEnv, storeChatImages, persistContextCache } = require('./message-handler-helpers');
const { handleSendPlanCommand, handleChatPlanCommand, _activePlanByAgent } = require('./message-handler-plan');

/**
 * Handle /send endpoint - PTY-based streaming message
 * @param {object} deps - Dependencies
 * @returns {function} Express route handler
 */
function handleSend(deps) {
  const {
    AppService,
    APPS_DIR,
    MemoryService,
    resolveState,
    DEFAULT_CLAUDE_TIMEOUT_MS,
    db
  } = deps;

  return async (req, res) => {
    try {
    const t0 = Date.now();
    const lap = (label) => console.log(`[TIMING] ${label}: ${Date.now() - t0}ms`);

    const { message, attachments } = req.body;
    const state = resolveState(req);

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Track working state so UI can recover loading indicator after tab switch
    state.working = true;

    const assistant = db ? (req.agentId ? AgentService.getById(db, req.agentId) : AgentService.getDefault(db)) : null;
    if (!assistant) {
      state.working = false;
      return res.status(404).json({ error: 'Assistant not found' });
    }

    const { agentDir: appPath, agentBlobDir } = AgentService.getPaths(assistant.app_id, assistant.id);
    const agentName = ConversationService.getAgentName(assistant.id);

    const runId = newRunId();
    const messageId = newMessageId();

    // --- Plan commands: /plan, /approve, /reject, /modify ---
    const trimmedMsg = message.trim();
    const planResult = await handleSendPlanCommand(trimmedMsg, { db, assistant, agentName, state, message, runId, messageId });
    if (planResult.handled) {
      return res.json(planResult.response);
    }

    // Resolve backend + model via routing cascade (initial resolution for context budgets)
    const assistantConfig = (db && AgentService.getConfig(db, assistant.id)) || loadJSON(path.join(appPath, 'assistant-config.json'), {});
    const agentOverride = assistantConfig.agentModel || null;
    let resolved = db ? RoutingService.resolve(db, 'conversation', agentOverride) : {
      familyId: null, backendId: assistantConfig.agentBackend || 'claude',
      modelArg: agentOverride, source: 'fallback'
    };
    let backendId = resolved.backendId;
    let agentModel = resolved.modelArg;
    let backend = getBackend(backendId);
    console.log(`[Routing] conversation/send: ${resolved.familyId} via ${resolved.source}`);

    // Phase 3 (os8-3-4): vision dispatch override. Under ai_mode='local' with
    // image attachments incoming, swap to a vision-capable local family
    // (qwen3-6-35b-a3b) before any attachment processing, so the support-flag
    // check downstream sees the swapped family and the images are read +
    // forwarded as multimodal content parts.
    const _hasUserImageAtts = (attachments || []).some(a => a?.mimeType?.startsWith('image/'));
    if (_hasUserImageAtts) {
      const swapped = RoutingService.maybeSwapForVision(db, resolved, true);
      if (swapped !== resolved) {
        resolved = swapped;
        backendId = resolved.backendId;
        backend = getBackend(backendId);
        agentModel = resolved.modelArg;
        console.log(`[Routing] vision_override → ${resolved.familyId}`);
      }
    }

    // Process user attachments - read and compress images for the agent
    const userImageAttachments = [];
    let messageWithFileRefs = message;
    if (attachments && attachments.length > 0) {
      for (const att of attachments) {
        if (att.mimeType && att.mimeType.startsWith('image/') && ((backend.supportsImageInput && (backend.supportsVisionForFamily?.(resolved.familyId, db) ?? true)) || backend.supportsImageViaFile)) {
          const fullPath = path.join(agentBlobDir, 'chat-attachments', att.filename);
          const imageResult = await readImageAsBase64Compressed(fullPath);
          if (imageResult) {
            userImageAttachments.push({ ...imageResult, filename: att.filename, originalFilePath: fullPath });
          }
        } else {
          // Non-image or backend doesn't support images: append file reference
          const fullPath = path.join(agentBlobDir, 'chat-attachments', att.filename);
          messageWithFileRefs += `\n[Attached file: ${fullPath} (${att.mimeType})]`;
        }
      }
    }

    // Record user message to conversation DB
    const userSpeaker = getUserSpeakerLabel(db);
    if (db) {
      try {
        ConversationService.addEntry(db, assistant.id, {
          type: 'conversation',
          speaker: userSpeaker,
          role: 'user',
          channel: 'desktop',
          content: message
        });
      } catch (convErr) {
        console.warn('Failed to record user message:', convErr.message);
      }

      // Store user image attachments in DB (memory-tier compression)
      if (userImageAttachments.length > 0) {
        storeChatImages(db, assistant.id, userImageAttachments, {
          imageView: 'chat_user',
          speaker: userSpeaker,
          role: 'user',
          channel: 'desktop'
        }).catch(err => console.warn('Failed to store user chat images:', err.message));
      }
    }

    lap('setup+db-write');

    // Get or initialize memory service
    let memory = state.getMemory();
    if (!memory) {
      memory = new MemoryService(appPath, db, assistant.id);
      state.setMemory(memory);
    }

    // Calculate unified budget: 100K tokens total, identity+images first, remaining 50/50
    const {
      identityContext,
      conversationBudgetChars,
      semanticBudgetChars,
      presentMomentImageData,
      panoramaData,
      timelineImages,
      ownerImage,
      ownerName,
      assistantName,
      presentMomentContext,
      imageDescriptions,
      _profile
    } = await calculateContextBudgets(appPath, db, undefined, { backend, resolved });
    lap('context-budgets');

    // Build memory context with allocated budgets
    let memoryContext = null;
    let semanticMemoryText = '';
    let rawConversationEntries = [];
    try {
      const forceSemanticSearch = assistant?.subconscious_memory === 1;
      memoryContext = await memory.getContextForMessage(message, {
        conversationBudgetChars,
        semanticBudgetChars,
        priorityOrder: ['identity', 'curated', 'daily'],
        forceSemanticSearch
      });
      semanticMemoryText = buildSemanticMemoryContext(memoryContext);
      rawConversationEntries = memoryContext.rawEntries || [];
    } catch (memErr) {
      console.warn('Memory context error:', memErr.message);
    }

    // Filter timeline images to raw conversation window — images from digested eras
    // should not appear in recent_history (they cause the agent to react to old attachments)
    if (rawConversationEntries.length > 0 && timelineImages.length > 0) {
      const oldestRawTs = new Date(rawConversationEntries[0].timestamp).getTime();
      const before = timelineImages.length;
      for (let i = timelineImages.length - 1; i >= 0; i--) {
        if (new Date(timelineImages[i].timestamp).getTime() < oldestRawTs) {
          timelineImages.splice(i, 1);
        }
      }
      if (timelineImages.length < before) {
        console.log(`[ChatImages] Filtered ${before} → ${timelineImages.length} (dropped ${before - timelineImages.length} outside raw window)`);
      }
    }

    lap('memory-assembly');

    // Token profiler: log per-turn context breakdown
    try {
      const claudeMdPath = path.join(appPath, backend.instructionFile);
      const claudeMdChars = fs.existsSync(claudeMdPath) ? fs.statSync(claudeMdPath).size : 0;
      const semanticChars = memoryContext?.relevantMemory?.reduce((sum, c) => sum + c.text.length, 0) || 0;
      profileContextBudgets({
        source: 'chat-send',
        profile: _profile,
        claudeMdChars,
        semanticChunkCount: memoryContext?.relevantMemory?.length || 0,
        semanticChars,
        digestChars: memoryContext?.digestText?.length || 0,
        conversationChars: memoryContext?.conversationHistory?.length || 0,
        userMessageChars: message.length
      });
    } catch (profileErr) {
      // Non-fatal
    }

    // --- Step 1: Active plan check ---
    const hasActivePlan = db && PlanService.hasExecutingPlan(db, assistant.id);
    if (hasActivePlan) {
      console.log(`[Planning] Active plan detected for ${assistant.id}, skipping classification + subconscious`);
    }

    // --- Step 2: Lightweight action classification (separate from subconscious) ---
    // Uses only last 5 conversation turns — no identity/memory/digest noise
    const canClassify = !hasActivePlan
      && assistant.subconscious_memory === 1
      && db && SubconsciousService.isAvailable(db)
      && userImageAttachments.length === 0;

    let classificationResult = null;
    lap('pre-classifier');
    if (canClassify) {
      try {
        classificationResult = await SubconsciousService.classifyAction(db, assistant.id, message, {
          agentModelOverride: assistantConfig.agentModel || null
        });
      } catch (classErr) {
        console.warn('[Classifier] Classification failed, defaulting to TOOL_USE:', classErr.message);
      }
    }

    lap('classifier');

    // Determine classification: active plan or explicit TOOL_USE or no classifier = TOOL_USE
    const classifiedAsToolUse = hasActivePlan
      || !classificationResult
      || classificationResult.requiresToolUse;

    // --- Step 3: Subconscious context curation (only on CONVERSATIONAL path) ---
    const useSubconscious = !classifiedAsToolUse;

    let subconsciousOutput = null;
    let subconsciousDuration = null;
    let rawContextForSummarizer = null;
    let subconsciousError = null;

    if (useSubconscious) {
      const agentDMContextForSub = (db && assistant) ? buildAgentDMContext(db, assistant.id) : '';
      rawContextForSummarizer = [
        identityContext,
        memoryContext ? buildMemoryContext(memoryContext) : '',
        semanticMemoryText,
        agentDMContextForSub,
      ].filter(s => s?.trim()).join('\n\n');

      try {
        const isSimple = message.length < 15
          || /^(hi|hey|hello|ok|thanks|thank you|yes|no|sure|yep|nope|k|lol|haha)\b/i.test(message.trim());
        const startTime = Date.now();
        subconsciousOutput = await SubconsciousService.process(db, rawContextForSummarizer, {
          isSimpleMessage: isSimple,
          agentModelOverride: assistantConfig.agentModel || null,
          depth: assistantConfig.subconsciousDepth || 2,
          agentId: assistant.id
        });
        subconsciousDuration = Date.now() - startTime;
        lap('subconscious');
        console.log(`[Subconscious] Processed in ${subconsciousDuration}ms (${subconsciousOutput.depthLabel}) | Input: ${Math.round(rawContextForSummarizer.length / 1024)}KB | Output: ${Math.round(subconsciousOutput.text.length / 1024)}KB`);
      } catch (subErr) {
        subconsciousError = subErr.message;
        console.warn('[Subconscious] Processing failed, falling back to raw context:', subErr.message);
      }
    }

    // Inject classification into subconsciousOutput for debug viewer compatibility
    if (subconsciousOutput) {
      subconsciousOutput.classification = classificationResult?.classification || 'CONVERSATIONAL';
      subconsciousOutput.requiresToolUse = false;
    }

    // --- Step 4: Re-resolve model for CLI spawn ---
    // TOOL_USE → planning cascade; CONVERSATIONAL → stays on conversation cascade
    const cliTaskType = classifiedAsToolUse ? 'planning' : 'conversation';
    if (cliTaskType !== 'conversation' && db) {
      const prevFamily = resolved.familyId;
      resolved = RoutingService.resolve(db, cliTaskType, agentOverride);
      backendId = resolved.backendId;
      agentModel = resolved.modelArg;
      backend = getBackend(backendId);
      const reason = hasActivePlan ? 'active plan' : classificationResult?.requiresToolUse ? 'TOOL_USE' : 'no classifier';
      console.log(`[Routing] ${cliTaskType}/send: ${resolved.familyId} via ${resolved.source} (reason: ${reason})`);

      // Notify terminal of model switch
      if (prevFamily !== resolved.familyId) {
        broadcast(
          state.getResponseClients(),
          CUSTOM,
          { name: 'model-switch', runId, value: { from: prevFamily, to: resolved.familyId, cascade: cliTaskType, reason } }
        );
      }
    }

    // --- Subconscious direct response mode ---
    // When classified CONVERSATIONAL and subconscious produced a response, use it directly (no CLI spawn)
    const useDirectResponse = useSubconscious
      && subconsciousOutput?.recommendedResponse
      && !classifiedAsToolUse
      && !subconsciousOutput.recommendedResponse.trimStart().startsWith('{');

    if (useDirectResponse) {
      lap('direct-response-start');
      console.log(`[Subconscious Direct] Using recommended response — classified ${subconsciousOutput.classification} (${subconsciousOutput.recommendedResponse.length} chars)`);

      const directResponse = subconsciousOutput.recommendedResponse;

      // Store context snapshot for debug viewer
      try {
        const { getAgentState } = require('../services/agent-state');
        const imgMeta = (img, label) => img ? { label, sizeKB: Math.round((img.data?.length || 0) * 3 / 4 / 1024), mediaType: img.mediaType } : null;
        getAgentState(assistant.id).lastContext = {
          timestamp: new Date().toISOString(),
          identityContext,
          memoryContext,
          skillContext: '',
          agentDMContext: '',
          fullContext: '(subconscious direct mode)',
          enrichedMessage: '(subconscious direct mode)',
          profile: _profile,
          images: [
            imgMeta(presentMomentImageData?.thirdPerson, 'Present Moment (3rd person)'),
            imgMeta(panoramaData?.contactSheet, 'Panorama'),
            imgMeta(ownerImage, `Owner (${ownerName || 'user'})`),
            ...timelineImages.map((img, i) => imgMeta(img, `Timeline ${i + 1}`)),
          ].filter(Boolean),
          imageDataUrls: [
            presentMomentImageData?.thirdPerson ? { label: 'Present Moment (3rd person)', dataUrl: `data:${presentMomentImageData.thirdPerson.mediaType};base64,${presentMomentImageData.thirdPerson.data}` } : null,
            panoramaData?.contactSheet ? { label: 'Panorama', dataUrl: `data:${panoramaData.contactSheet.mediaType};base64,${panoramaData.contactSheet.data}` } : null,
            ownerImage ? { label: `Owner (${ownerName || 'user'})`, dataUrl: `data:${ownerImage.mediaType};base64,${ownerImage.data}` } : null,
          ].filter(Boolean),
          semanticMemoryText,
          subconsciousEnabled: true,
          subconsciousDirect: true,
          subconsciousClassification: classificationResult?.classification || 'CONVERSATIONAL',
          subconsciousRequiresToolUse: false,
          classifierDurationMs: classificationResult?.durationMs || null,
          classifierUsage: classificationResult?.usage || null,
          subconsciousDepth: subconsciousOutput.depth,
          subconsciousDepthLabel: subconsciousOutput.depthLabel,
          subconsciousInput: rawContextForSummarizer,
          subconsciousOutput: subconsciousOutput.text,
          subconsciousContext: subconsciousOutput.context,
          subconsciousRecommendedResponse: subconsciousOutput.recommendedResponse,
          subconsciousDuration,
          subconsciousUsage: subconsciousOutput.usage,
          subconsciousError: null,
        };
        persistContextCache(db, assistant.id, getAgentState(assistant.id).lastContext);
      } catch (_e) { /* non-critical */ }

      // Send response via SSE (same pattern as CLI exit handler)
      const strippedText = stripInternalNotes(directResponse);
      const responseAttachments = extractFileAttachments(strippedText);
      const noFileTags = stripFileAttachments(strippedText);
      const noToolXml = stripToolCallXml(noFileTags);
      const reaction = extractReaction(noToolXml);
      const cleanResponse = stripReaction(noToolXml);

      // Send stream events first so TTS can speak the response, then done
      // Chunk the text to simulate streaming for more natural TTS pacing
      const CHUNK_SIZE = 80;
      const clients = state.getResponseClients();
      for (let i = 0; i < cleanResponse.length; i += CHUNK_SIZE) {
        const chunk = cleanResponse.slice(i, i + CHUNK_SIZE);
        broadcast(
          clients,
          TEXT_MESSAGE_CONTENT,
          { runId, messageId, delta: chunk }
        );
      }

      broadcast(
        clients,
        RUN_FINISHED,
        { runId, messageId, result: cleanResponse, reaction, attachments: responseAttachments }
      );
      state.working = false;

      // Record to conversation DB
      if (db) {
        try {
          ConversationService.addEntry(db, assistant.id, {
            type: 'conversation',
            speaker: agentName,
            role: 'assistant',
            channel: 'desktop',
            content: directResponse
          });
        } catch (convErr) {
          console.warn('Failed to record direct response:', convErr.message);
        }
      }

      lap('direct-response-done');
      return res.json({ success: true, text: cleanResponse, reaction, attachments: responseAttachments });
    }

    // --- SDK path: use Anthropic API directly with prompt caching ---
    // Disabled for desktop chat — SDK has no tool use, so agent can't call APIs,
    // read files, or execute skills. CLI path gives full tool access.
    // SDK remains active for voice calls (call-stream.js) where tool use isn't needed.
    const useSDK = false; // backendId === 'claude' && AnthropicSDK.isAvailable(db);
    if (useSDK) {
      try {
        const userContent = AnthropicSDK.buildUserContent({
          presentMomentImages: presentMomentImageData,
          panoramaData,
          ownerImage,
          ownerName,
          presentMomentText: presentMomentContext || '',
          semanticMemoryText,
          digestText: memoryContext?.digestText || '',
          rawConversationEntries,
          timelineImages,
          userMessage: messageWithFileRefs,
          userAttachments: userImageAttachments,
          conversationBudgetChars
        });

        let fullResponse = '';
        let displayBuffer = '';
        let insideInternalNote = false;
        let bracketDepth = 0;

        for await (const event of AnthropicSDK.streamMessage(db, appPath, userContent, {
          agentModel,
          onCacheStats: (stats) => {
            profileContextBudgets({
              source: 'chat-send-sdk',
              profile: _profile,
              claudeMdChars: 0, // included in system message
              semanticChunkCount: memoryContext?.relevantMemory?.length || 0,
              semanticChars: memoryContext?.relevantMemory?.reduce((sum, c) => sum + c.text.length, 0) || 0,
              digestChars: memoryContext?.digestText?.length || 0,
              conversationChars: memoryContext?.conversationHistory?.length || 0,
              userMessageChars: message.length,
              cacheStats: stats
            });
          }
        })) {
          if (event.type === 'text_delta') {
            fullResponse += event.text;

            // Reuse the same internal note filtering logic as the CLI path
            displayBuffer += event.text;
            let safeText = '';

            while (displayBuffer.length > 0) {
              if (insideInternalNote) {
                let found = false;
                for (let i = 0; i < displayBuffer.length; i++) {
                  if (displayBuffer[i] === '[') {
                    bracketDepth++;
                  } else if (displayBuffer[i] === ']') {
                    if (bracketDepth === 0) {
                      displayBuffer = displayBuffer.slice(i + 1);
                      insideInternalNote = false;
                      if (displayBuffer.startsWith('\n')) {
                        displayBuffer = displayBuffer.slice(1);
                      }
                      found = true;
                      break;
                    } else {
                      bracketDepth--;
                    }
                  }
                }
                if (!found) break;
              } else {
                const internalIdx = displayBuffer.toLowerCase().indexOf('[internal:');
                const reactIdx = displayBuffer.toLowerCase().indexOf('[react:');
                let openIdx = -1;
                let tagLength = 0;
                if (internalIdx !== -1 && (reactIdx === -1 || internalIdx <= reactIdx)) {
                  openIdx = internalIdx;
                  tagLength = '[internal:'.length;
                } else if (reactIdx !== -1) {
                  openIdx = reactIdx;
                  tagLength = '[react:'.length;
                }
                if (openIdx !== -1) {
                  safeText += displayBuffer.slice(0, openIdx);
                  displayBuffer = displayBuffer.slice(openIdx + tagLength);
                  insideInternalNote = true;
                  bracketDepth = 0;
                } else {
                  const partialMatch = findPartialInternalMatch(displayBuffer);
                  if (partialMatch > 0) {
                    safeText += displayBuffer.slice(0, -partialMatch);
                    displayBuffer = displayBuffer.slice(-partialMatch);
                    break;
                  } else {
                    safeText += displayBuffer;
                    displayBuffer = '';
                  }
                }
              }
            }

            if (safeText) {
              broadcast(
                state.getResponseClients(),
                TEXT_MESSAGE_CONTENT,
                { runId, messageId, delta: safeText }
              );
            }
          }
          // message_complete is handled after loop
        }

        // Send 'done' SSE event
        const displayResponse = stripInternalNotes(fullResponse);
        const responseAttachments = extractFileAttachments(displayResponse);
        const noFileTags = stripFileAttachments(displayResponse);
        const reaction = extractReaction(noFileTags);
        const cleanResponse = stripReaction(noFileTags);
        broadcast(
          state.getResponseClients(),
          RUN_FINISHED,
          { runId, messageId, result: cleanResponse, reaction, attachments: responseAttachments }
        );
        state.working = false;

        // Record assistant response to conversation DB
        if (db && fullResponse) {
          try {
            ConversationService.addEntry(db, assistant.id, {
              type: 'conversation',
              speaker: agentName,
              role: 'assistant',
              channel: 'desktop',
              content: fullResponse
            });
          } catch (convErr) {
            console.warn('Failed to record assistant response:', convErr.message);
          }

          // Store agent response images (from [file:] tags) in DB
          try {
            const agentAttachments = extractFileAttachments(stripInternalNotes(fullResponse));
            const agentImages = agentAttachments
              .filter(a => a.mimeType && a.mimeType.startsWith('image/'))
              .map(a => {
                const relPath = a.url.replace(/^\/blob\//, '');
                return {
                  filePath: path.join(agentBlobDir, relPath),
                  filename: a.filename
                };
              });
            if (agentImages.length > 0) {
              await storeChatImages(db, assistant.id, agentImages, {
                imageView: 'chat_agent',
                speaker: agentName,
                role: 'assistant',
                channel: 'desktop'
              });
            }
          } catch (imgErr) {
            console.warn('Failed to store agent response images:', imgErr.message);
          }
        }

        // Return stripped response
        const stripped = stripInternalNotes(fullResponse);
        const resAttachments = extractFileAttachments(stripped);
        const noTags = stripFileAttachments(stripped);
        return res.json({ success: true, text: stripReaction(noTags), reaction: extractReaction(noTags), attachments: resAttachments });
      } catch (sdkErr) {
        console.error('SDK error in handleSend:', sdkErr);
        return res.status(500).json({ error: `SDK error: ${sdkErr.message}` });
      }
    }

    // --- CLI path (unchanged) ---
    lap('cli-prep-start');
    const env = prepareAgentEnv(backendId, db, resolved.accessMethod);

    // Check if we have images to include
    const anyImages = presentMomentImageData?.thirdPerson || presentMomentImageData?.pov
      || panoramaData?.contactSheet || ownerImage || userImageAttachments.length > 0 || timelineImages.length > 0;
    // Phase 3 (os8-3-4): for HTTP backends, supportsImageInput is per-backend
    // but actual vision capability is per-family. supportsVisionForFamily
    // gates the local backend; non-local backends don't define it (the
    // optional-chain returns undefined → ?? true keeps current behavior).
    const _supportsImagesNow = backend.supportsImageInput
      && (backend.supportsVisionForFamily?.(resolved.familyId, db) ?? true);
    const hasImageStdin = _supportsImagesNow && anyImages;             // Claude: base64 via stream-json stdin; local: multimodal content parts
    const hasImageFiles = backend.supportsImageViaFile && anyImages;   // Codex: --image file paths
    const hasImageDescriptions = backend.supportsImageDescriptions && imageDescriptions; // Grok: text descriptions
    const hasImages = hasImageStdin || hasImageFiles;
    const presentCount = (presentMomentImageData?.thirdPerson ? 1 : 0) + (presentMomentImageData?.pov ? 1 : 0);
    console.log(`[Images] hasImages=${!!hasImages}, hasImageStdin=${!!hasImageStdin}, hasImageFiles=${!!hasImageFiles}, hasImageDescriptions=${!!hasImageDescriptions}, present=${presentCount}, owner=${!!ownerImage}, timeline=${timelineImages?.length || 0}, backend=${backendId}`);

    const args = backend.buildArgs({
      print: true,
      verbose: true,
      streamJson: true,
      includePartialMessages: backend.supportsStreamJson,
      skipPermissions: true,
      inputFormatStreamJson: hasImageStdin,
      appPath,
      blobDir: agentBlobDir,
      model: agentModel,
      env,
    });

    // No --resume: each invocation starts fresh. Conversation continuity
    // is provided by the memory context (real-time conversation DB + semantic search).

    // Write images to temp files for backends that support --image file paths (Codex)
    let codexTempDir = null;
    let imageManifest = '';
    if (hasImageFiles && backend.buildImageFileArgs) {
      codexTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-codex-img-'));
      const { args: imageArgs, manifest } = backend.buildImageFileArgs({
        presentMoment: presentMomentImageData,
        panorama: panoramaData,
        owner: ownerImage,
        timeline: timelineImages,
        userAttachments: userImageAttachments
      }, codexTempDir, { ownerName, assistantName });
      args.push(...imageArgs);
      imageManifest = manifest;
    }

    // Dynamic context shared by both image-stdin and text paths
    const agentDMContext = (db && assistant) ? buildAgentDMContext(db, assistant.id) : '';
    let skillContext = '';
    try {
      const { pinned, suggested } = await CapabilityService.getForContext(db, assistant?.id, message);
      skillContext = CapabilityService.formatForContext(db, pinned, suggested);
      if (skillContext) skillContext = '\n' + skillContext + '\n';
    } catch (e) {
      // Skills context is non-critical — don't block the message
    }

    // For non-image-stdin path, build enriched message with new ordering
    let enrichedMessage = '';
    if (!hasImageStdin) {
      // If we have image descriptions (Grok path), inject them into the context
      let imageDescContext = '';
      if (hasImageDescriptions) {
        imageDescContext = buildImageDescriptionsContext(imageDescriptions, { ownerName, assistantName });
      }
      // When subconscious classified TOOL_USE, pass full raw context to CLI (no summarized sections).
      // When subconscious classified CONVERSATIONAL, this path is not reached (direct response above).
      // When subconscious is off or failed, use the pre-subconscious raw context assembly.
      const fullContext = (subconsciousOutput && !subconsciousOutput.requiresToolUse && subconsciousOutput.context)
        ? buildStructuralIdentity(appPath) + '\n' + subconsciousOutput.context + imageDescContext + skillContext
        : identityContext + imageDescContext + (memoryContext ? buildMemoryContext(memoryContext) : '') + agentDMContext + skillContext;
      enrichedMessage = imageManifest + enrichMessageWithContext(messageWithFileRefs, fullContext);
      args.push(...backend.buildPromptArgs(enrichedMessage));
    }

    const fullCommand = `${backend.command} ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`;

    // Cache context snapshot for debug viewer
    try {
      const { getAgentState } = require('../services/agent-state');
      const imgMeta = (img, label) => img ? { label, sizeKB: Math.round((img.data?.length || 0) * 3 / 4 / 1024), mediaType: img.mediaType } : null;
      getAgentState(assistant.id).lastContext = {
        timestamp: new Date().toISOString(),
        identityContext,
        memoryContext,
        skillContext,
        agentDMContext,
        fullContext: hasImageStdin ? '(stream-json path — see enrichedMessage)' : (identityContext + (memoryContext ? buildMemoryContext(memoryContext) : '') + agentDMContext + skillContext),
        enrichedMessage: enrichedMessage || '(stream-json path)',
        profile: _profile,
        images: [
          imgMeta(presentMomentImageData?.thirdPerson, 'Present Moment (3rd person)'),
          imgMeta(panoramaData?.contactSheet, 'Panorama'),
          imgMeta(ownerImage, `Owner (${ownerName || 'user'})`),
          ...timelineImages.map((img, i) => imgMeta(img, `Timeline ${i + 1}`)),
        ].filter(Boolean),
        imageDataUrls: [
          presentMomentImageData?.thirdPerson ? { label: 'Present Moment (3rd person)', dataUrl: `data:${presentMomentImageData.thirdPerson.mediaType};base64,${presentMomentImageData.thirdPerson.data}` } : null,
          panoramaData?.contactSheet ? { label: 'Panorama', dataUrl: `data:${panoramaData.contactSheet.mediaType};base64,${panoramaData.contactSheet.data}` } : null,
          ownerImage ? { label: `Owner (${ownerName || 'user'})`, dataUrl: `data:${ownerImage.mediaType};base64,${ownerImage.data}` } : null,
        ].filter(Boolean),
        semanticMemoryText,
        subconsciousEnabled: !!canClassify,
        subconsciousDirect: false,
        subconsciousClassification: classificationResult?.classification || (classifiedAsToolUse ? 'TOOL_USE' : null),
        subconsciousRequiresToolUse: classifiedAsToolUse,
        classifierDurationMs: classificationResult?.durationMs || null,
        classifierUsage: classificationResult?.usage || null,
        subconsciousDepth: subconsciousOutput?.depth || null,
        subconsciousDepthLabel: subconsciousOutput?.depthLabel || null,
        subconsciousInput: rawContextForSummarizer,
        subconsciousOutput: subconsciousOutput?.text || null,
        subconsciousContext: subconsciousOutput?.context || null,
        subconsciousRecommendedResponse: subconsciousOutput?.recommendedResponse || null,
        subconsciousDuration,
        subconsciousUsage: subconsciousOutput?.usage || null,
        subconsciousError,
      };
      persistContextCache(db, assistant.id, getAgentState(assistant.id).lastContext);
    } catch (_e) { /* non-critical */ }

    // Use spawn instead of PTY when we have images (need stdin control)
    let ptyProcess;
    let debugPayloadSize = 0;  // Track payload size for error logging

    // Build stdin data for image case
    let stdinData = null;
    if (hasImageStdin) {
      // When subconscious classified TOOL_USE (or is off/failed), pass full raw context.
      // Only use summarized context when CONVERSATIONAL (which shouldn't reach this CLI path).
      const useSubconsciousSummary = subconsciousOutput && !subconsciousOutput.requiresToolUse && subconsciousOutput.context;
      const streamJsonMsg = buildStreamJsonMessage({
        identityText: useSubconsciousSummary
          ? `[Context]\n${buildStructuralIdentity(appPath)}\n${subconsciousOutput.context}`
          : `[Context]\n${identityContext}`,
        presentMomentImages: presentMomentImageData,
        panoramaData,
        ownerImage,
        semanticMemoryText: useSubconsciousSummary ? '' : semanticMemoryText,
        digestText: useSubconsciousSummary ? '' : (memoryContext?.digestText || ''),
        sessionDigests: useSubconsciousSummary ? '' : (memoryContext?.sessionDigests || ''),
        dailyDigests: useSubconsciousSummary ? '' : (memoryContext?.dailyDigests || ''),
        rawConversationEntries: useSubconsciousSummary ? [] : rawConversationEntries,
        timelineImages,
        userMessage: messageWithFileRefs,
        userAttachments: userImageAttachments,
        conversationBudgetChars,
        ownerName,
        agentDMContext: useSubconsciousSummary ? '' : agentDMContext,
        skillContext
      });
      const msgSizeKB = Math.round(streamJsonMsg.length / 1024);
      const totalImgCount = presentCount + (ownerImage ? 1 : 0) + timelineImages.length + userImageAttachments.length;
      const imgSizeKB = msgSizeKB - Math.round((identityContext.length + semanticMemoryText.length) / 1024);

      debugPayloadSize = msgSizeKB;  // Store for error logging
      console.log(`[Claude Input] Total: ${msgSizeKB} KB | Images: ${totalImgCount} (~${imgSizeKB} KB)`);

      stdinData = streamJsonMsg + '\n';
    }

    lap('cli-args-ready');

    // Unified spawn: PTY for Claude-no-images, spawn for everything else.
    // HTTP (local) backends route through createHttpProcess internally; the
    // model/taskType hints flow through so the launcher can pick the right
    // per-task endpoint (Phase 2+) — for Phase 1 the launcher only has one.
    ptyProcess = createProcess(backend, args, {
      cwd: appPath,
      env,
      useImages: hasImageStdin,
      stdinData,
      promptViaStdin: backend.promptViaStdin ? enrichedMessage : null,
      model: agentModel,
      taskType: 'conversation',
      // Phase 3 (os8-3-4): for HTTP backends, attachments become OpenAI
      // multimodal content parts in the request body. Non-HTTP backends
      // ignore this opt (their image paths use stdin or --image flags).
      attachments: (backend.type === 'http' && hasImageStdin) ? userImageAttachments : null,
      // Phase 2B: launcher metadata for ensureModel — set by routing.js on
      // local-container families. Non-local backends leave these undefined.
      launcherModel: resolved.launcher_model,
      launcherBackend: resolved.launcher_backend
    });

    lap('cli-spawned');
    let firstDataReceived = false;

    let fullResponse = '';
    let buffer = '';
    let responded = false;
    let doneSent = false; // Track if SSE "done" event has been sent (prevent duplicates)

    // Buffer for internal notes filtering in streaming mode
    // Accumulates text while inside [internal: ...] to avoid partial matches
    let displayBuffer = '';
    let insideInternalNote = false;
    let bracketDepth = 0; // Track nested brackets inside [internal: ...] / [react: ...]

    // Activity pulse: throttled SSE event for all backends to signal liveness
    let lastActivityBroadcast = 0;
    const broadcastActivity = () => {
      const now = Date.now();
      if (now - lastActivityBroadcast > 2000 && state.getResponseClients().length > 0) {
        lastActivityBroadcast = now;
        broadcast(
          state.getResponseClients(),
          CUSTOM,
          { name: 'activity-pulse', runId, value: {} }
        );
      }
    };

    // Stream transparency: track execution steps for Claude backends.
    // ClaudeTranslator emits REASONING_START/END with proper messageId, so the
    // thinking callbacks here are no-ops (kept for symmetry with the tracker shape).
    const tracker = (backendId === 'claude' && state.getResponseClients().length > 0)
      ? new StreamStateTracker({
          onStepStart: ({ blockIndex, blockType, toolName, toolInput, label, stepIndex }) => {
            broadcast(
              state.getResponseClients(),
              STEP_STARTED,
              { runId, stepName: label, blockIndex, toolName, stepIndex }
            );
          },
          onStepComplete: ({ blockIndex, durationMs, stepIndex }) => {
            broadcast(
              state.getResponseClients(),
              STEP_FINISHED,
              { runId, blockIndex, durationMs, stepIndex }
            );
          },
          onThinkingStart: () => {},
          onThinkingEnd: () => {}
        })
      : null;

    // Backend translator emits the rich ag-ui event stream alongside the tracker.
    // Skipped types are already emitted by other paths to avoid duplication:
    //   - TEXT_MESSAGE_*: emitted post-filter from the safeText path (translator sees raw deltas)
    //   - RUN_FINISHED: emitted from the done path with the full clean response
    // createTranslator returns null for unsupported backends (e.g. grok).
    const backendTranslator = (state.getResponseClients().length > 0)
      ? createTranslator(backendId, { runId })
      : null;
    const TRANSLATOR_SKIP = new Set([
      TEXT_MESSAGE_START,
      TEXT_MESSAGE_CONTENT,
      TEXT_MESSAGE_END,
      RUN_FINISHED
    ]);
    const emitTranslated = (json) => {
      if (!backendTranslator) return;
      const events = backendTranslator.translate(json);
      const clients = state.getResponseClients();
      for (const ev of events) {
        if (TRANSLATOR_SKIP.has(ev.type)) continue;
        broadcast(clients, ev.type, ev);
      }
    };

    const { SettingsService } = deps;
    const rawTimeout = (db && SettingsService) ? SettingsService.get(db, 'responseTimeoutMs') : null;
    const claudeTimeout = rawTimeout !== null ? parseInt(rawTimeout) : DEFAULT_CLAUDE_TIMEOUT_MS;

    // Only set timeout if claudeTimeout > 0
    const timeout = claudeTimeout > 0 ? setTimeout(() => {
      if (!responded) {
        responded = true;
        state.working = false;
        ptyProcess.kill();
        res.status(504).json({ error: `${backend.label} took too long to respond.` });
      }
    }, claudeTimeout) : null;

    ptyProcess.onData((data) => {
      if (!firstDataReceived) { firstDataReceived = true; lap('cli-first-data'); }
      buffer += data;

      // Broadcast activity pulse for all backends (throttled to every 2s)
      broadcastActivity();

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);

          // Feed stream events to tracker for step transparency
          if (tracker) tracker.processEvent(json);

          // Feed to ag-ui translator for rich event emission with native IDs
          emitTranslated(json);

          // Extract streaming text — Claude uses stream_event, Gemini uses message+delta,
          // Codex uses item events, Grok uses {role:"assistant",content:"..."}
          let streamingText = null;
          let isGrokReplace = false;  // Grok messages replace fullResponse (complete, not delta)
          if (json.type === 'stream_event' && json.event?.type === 'content_block_delta') {
            streamingText = json.event?.delta?.text;
          } else if (json.type === 'message' && json.delta && json.role === 'assistant') {
            streamingText = json.content;
          } else if (json.type === 'item.completed' && json.item?.type === 'agent_message'
                     && json.item?.text) {
            streamingText = json.item.text;
          } else if (!json.type && json.role === 'assistant' && json.content
                     && !json.tool_calls?.length) {
            // Grok: {"role":"assistant","content":"..."} — each line is a COMPLETE message
            // (not a delta). Grok emits multiple assistant messages as it works:
            // tool-call progress ("Using tools..."), intermediate results, then final response.
            // Skip tool-call progress and replace fullResponse with each real message.
            const grokContent = json.content;
            if (!/^Using tools/i.test(grokContent.trim())) {
              streamingText = grokContent;
              isGrokReplace = true;
            }
          }

          if (streamingText) {
            const text = streamingText;
            if (text) {
              if (isGrokReplace) {
                // Grok: replace (each line is a complete message, not a delta)
                fullResponse = text;
                displayBuffer = '';
              } else {
                // Claude/Gemini/Codex: append (streaming deltas)
                fullResponse += text;
              }

              // Buffer text to handle internal notes that span multiple chunks
              displayBuffer += text;

              // Process the buffer to extract safe-to-send text
              let safeText = '';

              while (displayBuffer.length > 0) {
                if (insideInternalNote) {
                  // Scan character-by-character tracking bracket depth
                  // so nested brackets like [HEART] inside [internal: ...] don't close early
                  let found = false;
                  for (let i = 0; i < displayBuffer.length; i++) {
                    if (displayBuffer[i] === '[') {
                      bracketDepth++;
                    } else if (displayBuffer[i] === ']') {
                      if (bracketDepth === 0) {
                        // This is the matching close bracket for the tag
                        displayBuffer = displayBuffer.slice(i + 1);
                        insideInternalNote = false;
                        // Also consume any trailing newline after the tag
                        if (displayBuffer.startsWith('\n')) {
                          displayBuffer = displayBuffer.slice(1);
                        }
                        found = true;
                        break;
                      } else {
                        bracketDepth--;
                      }
                    }
                  }
                  if (!found) {
                    // Still inside the tag, wait for more text
                    break;
                  }
                } else {
                  // Look for opening of internal note or reaction tag
                  const internalIdx = displayBuffer.toLowerCase().indexOf('[internal:');
                  const reactIdx = displayBuffer.toLowerCase().indexOf('[react:');
                  // Pick the earliest match
                  let openIdx = -1;
                  let tagLength = 0;
                  if (internalIdx !== -1 && (reactIdx === -1 || internalIdx <= reactIdx)) {
                    openIdx = internalIdx;
                    tagLength = '[internal:'.length;
                  } else if (reactIdx !== -1) {
                    openIdx = reactIdx;
                    tagLength = '[react:'.length;
                  }
                  if (openIdx !== -1) {
                    // Text before the tag is safe to send
                    safeText += displayBuffer.slice(0, openIdx);
                    displayBuffer = displayBuffer.slice(openIdx + tagLength);
                    insideInternalNote = true;
                    bracketDepth = 0;
                  } else {
                    // Check if buffer might have a partial match at the end
                    // e.g., "[intern" could be the start of "[internal:"
                    const partialMatch = findPartialInternalMatch(displayBuffer);
                    if (partialMatch > 0) {
                      // Send everything except the potential partial match
                      safeText += displayBuffer.slice(0, -partialMatch);
                      displayBuffer = displayBuffer.slice(-partialMatch);
                      break;
                    } else {
                      // No internal note patterns, all text is safe
                      safeText += displayBuffer;
                      displayBuffer = '';
                    }
                  }
                }
              }

              // Send safe text to clients (for display/TTS)
              if (safeText) {
                broadcast(
                  state.getResponseClients(),
                  TEXT_MESSAGE_CONTENT,
                  { runId, messageId, delta: safeText }
                );
              }
            }
          } else if (json.type === 'result') {
            fullResponse = json.result || fullResponse;
            // Handle error_max_turns: agent hit turn limit while trying to use tools
            if (json.subtype === 'error_max_turns' && !fullResponse) {
              fullResponse = "I tried to help but hit my tool-use turn limit before I could finish. Could you try again or rephrase your request?";
            }
            // Strip internal notes, tool call XML, file tags, and reaction for display
            const displayResponse = stripToolCallXml(stripInternalNotes(fullResponse));
            const responseAttachments = extractFileAttachments(displayResponse);
            const noFileTags = stripFileAttachments(displayResponse);
            const reaction = extractReaction(noFileTags);
            const cleanResponse = stripReaction(noFileTags);
            if (!doneSent) {
              doneSent = true;
              broadcast(
                state.getResponseClients(),
                RUN_FINISHED,
                { runId, messageId, result: cleanResponse, reaction, attachments: responseAttachments }
              );
            }
          }
        } catch (e) {
          // Not valid JSON
        }
      }
    });

    ptyProcess.onExit(async ({ exitCode, stderr }) => {
      lap('cli-exit');
      if (timeout) clearTimeout(timeout);

      // Clean up Codex temp image files
      if (codexTempDir) {
        try { fs.rmSync(codexTempDir, { recursive: true, force: true }); } catch (e) {}
      }

      if (responded) return;
      responded = true;

      // Flush any remaining data in the buffer (last line without trailing newline)
      if (buffer.trim()) {
        try {
          const json = JSON.parse(buffer);
          emitTranslated(json);
          if (json.type === 'result') {
            fullResponse = json.result || fullResponse;
            if (json.subtype === 'error_max_turns' && !fullResponse) {
              fullResponse = "I tried to help but hit my tool-use turn limit before I could finish. Could you try again or rephrase your request?";
            }
          } else if (json.type === 'message' && json.delta && json.role === 'assistant' && json.content) {
            fullResponse += json.content;
          } else if (json.type === 'item.completed' && json.item?.type === 'agent_message'
                     && json.item?.text) {
            fullResponse = json.item.text;
          } else if (!json.type && json.role === 'assistant' && json.content
                     && !json.tool_calls?.length
                     && !/^Using tools/i.test(json.content.trim())) {
            // Grok: replace (complete message, not delta)
            fullResponse = json.content;
          }
        } catch (e) { /* not valid JSON */ }
        buffer = '';
      }

      // Send "done" SSE event if we have a response but it wasn't sent during streaming
      // (happens when the result line was in the buffer or was never received)
      if (fullResponse && !doneSent) {
        doneSent = true;
        const displayResponse = stripToolCallXml(stripInternalNotes(fullResponse));
        const responseAttachments = extractFileAttachments(displayResponse);
        const noFileTags = stripFileAttachments(displayResponse);
        const reaction = extractReaction(noFileTags);
        const cleanResponse = stripReaction(noFileTags);
        broadcast(
          state.getResponseClients(),
          RUN_FINISHED,
          { runId, messageId, result: cleanResponse, reaction, attachments: responseAttachments }
        );
      }

      // Post-hoc step extraction for non-Claude backends
      if (!tracker && backendId !== 'claude' && fullResponse && fullResponse.length > 500 && db) {
        extractStepsFromResponse(db, fullResponse).then(steps => {
          if (steps.length > 0) {
            broadcast(
              state.getResponseClients(),
              CUSTOM,
              { name: 'steps-summary', runId, value: { steps } }
            );
          }
        }).catch(() => {}); // Best-effort
      }

      // Reset tracker
      if (tracker) tracker.reset();

      if (exitCode !== 0) {
        // Log any available error info
        if (!stderr && !fullResponse) {
          console.error(`[${backend.label} Error] Exit code ${exitCode} with no output. Payload was ${debugPayloadSize} KB`);
        }
        // Check for billing/rate errors and mark provider exhausted
        if (db && !fullResponse) {
          const errorOutput = (stderr || '') + (fullResponse || '');
          const container = AIRegistryService.getContainer(db, backendId);
          if (container && RoutingService.isBillingError(errorOutput, container.provider_id)) {
            RoutingService.markExhausted(db, container.provider_id, 'login');
            console.log(`[Routing] Marked ${container.provider_id} as exhausted due to billing error`);
          }
        }
      }
      // Treat as success if we have a response (exit 0, or non-zero with collected streaming content)
      if (exitCode === 0 || fullResponse) {
        if (fullResponse) {
          // Record assistant response to conversation DB
          if (db) {
            try {
              ConversationService.addEntry(db, assistant.id, {
                type: 'conversation',
                speaker: agentName,
                role: 'assistant',
                channel: 'desktop',
                content: fullResponse
              });
            } catch (convErr) {
              console.warn('Failed to record assistant response:', convErr.message);
            }

            // Store agent response images (from [file:] tags) in DB
            try {
              const responseAttachments = extractFileAttachments(stripInternalNotes(fullResponse));
              const agentImages = responseAttachments
                .filter(a => a.mimeType && a.mimeType.startsWith('image/'))
                .map(a => {
                  // url is /blob/chat-attachments/image.png — extract relative path after /blob/
                  const relPath = a.url.replace(/^\/blob\//, '');
                  return {
                    filePath: path.join(agentBlobDir, relPath),
                    filename: a.filename
                  };
                });
              if (agentImages.length > 0) {
                await storeChatImages(db, assistant.id, agentImages, {
                  imageView: 'chat_agent',
                  speaker: agentName,
                  role: 'assistant',
                  channel: 'desktop'
                });
              }
            } catch (imgErr) {
              console.warn('Failed to store agent response images:', imgErr.message);
            }
          }

        }

        // Return stripped response to client
        const stripped = stripToolCallXml(stripInternalNotes(fullResponse));
        const resAttachments = extractFileAttachments(stripped);
        const noTags = stripFileAttachments(stripped);
        res.json({ success: true, text: stripReaction(noTags), reaction: extractReaction(noTags), attachments: resAttachments });
      } else {
        // HTTP backends (local/launcher) fail for transient reasons — launcher
        // not running, model not serving, port blocked — none of which require
        // re-running the setup wizard. Avoid the "exited with code N" phrasing
        // because Chat.jsx's backend-error regex matches it and resets
        // setupComplete, bouncing the user to /new.
        const isHttp = backend.type === 'http';
        const errorMessage = isHttp
          ? `${backend.label} backend unavailable: ${(stderr || '').trim() || 'unknown error'}`
          : `${backend.label} exited with code ${exitCode}`;
        res.status(500).json({
          error: errorMessage,
          stderr: stderr ? stderr.substring(0, 1000) : null,
          output: fullResponse ? fullResponse.substring(0, 1000) : null
        });
      }
    }); // end ptyProcess.onExit
    } catch (err) {
      console.error('/send error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    }
  };
}

/**
 * Handle /chat endpoint - spawn-based message with memory context
 * @param {object} deps - Dependencies
 * @returns {function} Express route handler
 */
function handleChat(deps) {
  const {
    AppService,
    APPS_DIR,
    MemoryService,
    resolveState,
    DEFAULT_CLAUDE_TIMEOUT_MS,
    db
  } = deps;

  return async (req, res) => {
    const { message, attachments } = req.body;
    const state = resolveState(req);

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const assistant = db ? (req.agentId ? AgentService.getById(db, req.agentId) : AgentService.getDefault(db)) : null;
    if (!assistant) {
      return res.status(404).json({ error: 'Assistant not found. Create it first.' });
    }

    const { agentDir: appPath, agentBlobDir: chatBlobDir } = AgentService.getPaths(assistant.app_id, assistant.id);
    const agentName = ConversationService.getAgentName(assistant.id);

    const runId = newRunId();
    const messageId = newMessageId();

    // /plan interception — generate a structured plan via Opus
    const chatPlanResult = await handleChatPlanCommand(message, { db, assistant });
    if (chatPlanResult.handled) {
      if (chatPlanResult.error) {
        return res.status(500).json(chatPlanResult.response);
      }
      return res.json(chatPlanResult.response);
    }

    // Resolve backend + model via routing cascade (initial resolution for context budgets)
    const chatConfig = (db && AgentService.getConfig(db, assistant.id)) || loadJSON(path.join(appPath, 'assistant-config.json'), {});
    const chatAgentOverride = chatConfig.agentModel || null;
    let chatResolved = db ? RoutingService.resolve(db, 'conversation', chatAgentOverride) : {
      familyId: null, backendId: chatConfig.agentBackend || 'claude',
      modelArg: chatAgentOverride, source: 'fallback'
    };
    let chatBackendId = chatResolved.backendId;
    let chatAgentModel = chatResolved.modelArg;
    let chatBackend = getBackend(chatBackendId);
    console.log(`[Routing] conversation/chat: ${chatResolved.familyId} via ${chatResolved.source}`);

    // Phase 3 (os8-3-4): vision dispatch override (mirror of the first handler).
    const _hasUserImageAttsChat = (attachments || []).some(a => a?.mimeType?.startsWith('image/'));
    if (_hasUserImageAttsChat) {
      const swapped = RoutingService.maybeSwapForVision(db, chatResolved, true);
      if (swapped !== chatResolved) {
        chatResolved = swapped;
        chatBackendId = chatResolved.backendId;
        chatBackend = getBackend(chatBackendId);
        console.log(`[Routing] vision_override → ${chatResolved.familyId}`);
      }
    }

    // Process user attachments - read and compress images for the agent
    const userImageAttachments = [];
    let messageWithFileRefs = message;
    if (attachments && attachments.length > 0) {
      for (const att of attachments) {
        if (att.mimeType && att.mimeType.startsWith('image/') && ((chatBackend.supportsImageInput && (chatBackend.supportsVisionForFamily?.(chatResolved.familyId, db) ?? true)) || chatBackend.supportsImageViaFile)) {
          const fullPath = path.join(chatBlobDir, 'chat-attachments', att.filename);
          const imageResult = await readImageAsBase64Compressed(fullPath);
          if (imageResult) {
            userImageAttachments.push({ ...imageResult, filename: att.filename, originalFilePath: fullPath });
          }
        } else {
          const fullPath = path.join(chatBlobDir, 'chat-attachments', att.filename);
          messageWithFileRefs += `\n[Attached file: ${fullPath} (${att.mimeType})]`;
        }
      }
    }

    // Record user message to conversation DB
    const userSpeaker = getUserSpeakerLabel(db);
    if (db) {
      try {
        ConversationService.addEntry(db, assistant.id, {
          type: 'conversation',
          speaker: userSpeaker,
          role: 'user',
          channel: 'desktop',
          content: message
        });
      } catch (convErr) {
        console.warn('Failed to record user message:', convErr.message);
      }

      // Store user image attachments in DB (memory-tier compression)
      if (userImageAttachments.length > 0) {
        storeChatImages(db, assistant.id, userImageAttachments, {
          imageView: 'chat_user',
          speaker: userSpeaker,
          role: 'user',
          channel: 'desktop'
        }).catch(err => console.warn('Failed to store user chat images:', err.message));
      }
    }

    let memory = state.getMemory();
    if (!memory) {
      memory = new MemoryService(appPath, db, assistant.id);
      state.setMemory(memory);
    }

    try {
      // Calculate unified budget: 100K tokens total, identity+images first, remaining 50/50
      const {
        identityContext,
        conversationBudgetChars,
        semanticBudgetChars,
        presentMomentImageData,
        panoramaData,
        timelineImages,
        ownerImage,
        ownerName: chatOwnerName,
        assistantName: chatAssistantName,
        presentMomentContext: chatPresentMomentContext,
        imageDescriptions: chatImageDescriptions,
        _profile
      } = await calculateContextBudgets(appPath, db, undefined, { backend: chatBackend, resolved: chatResolved });

      // Build memory context with allocated budgets
      let memoryContext = null;
      let semanticMemoryText = '';
      let rawConversationEntries = [];
      try {
        const chatForceSemanticSearch = assistant?.subconscious_memory === 1;
        memoryContext = await memory.getContextForMessage(message, {
          conversationBudgetChars,
          semanticBudgetChars,
          priorityOrder: ['identity', 'curated', 'daily'],
          forceSemanticSearch: chatForceSemanticSearch
        });
        semanticMemoryText = buildSemanticMemoryContext(memoryContext);
        rawConversationEntries = memoryContext.rawEntries || [];
      } catch (memErr) {
        console.warn('Memory context error:', memErr.message);
      }

      // Filter timeline images to raw conversation window — images from digested eras
      // should not appear in recent_history (they cause the agent to react to old attachments)
      if (rawConversationEntries.length > 0 && timelineImages.length > 0) {
        const oldestRawTs = new Date(rawConversationEntries[0].timestamp).getTime();
        const before = timelineImages.length;
        for (let i = timelineImages.length - 1; i >= 0; i--) {
          if (new Date(timelineImages[i].timestamp).getTime() < oldestRawTs) {
            timelineImages.splice(i, 1);
          }
        }
        if (timelineImages.length < before) {
          console.log(`[ChatImages] Filtered ${before} → ${timelineImages.length} (dropped ${before - timelineImages.length} outside raw window)`);
        }
      }

      // --- Step 1: Active plan check ---
      const chatHasActivePlan = db && PlanService.hasExecutingPlan(db, assistant.id);
      if (chatHasActivePlan) {
        console.log(`[Planning] Active plan detected for ${assistant.id}, skipping classification + subconscious`);
      }

      // --- Step 2: Lightweight action classification ---
      const chatCanClassify = !chatHasActivePlan
        && assistant.subconscious_memory === 1
        && db && SubconsciousService.isAvailable(db)
        && userImageAttachments.length === 0;

      let chatClassificationResult = null;
      if (chatCanClassify) {
        try {
          chatClassificationResult = await SubconsciousService.classifyAction(db, assistant.id, message, {
            agentModelOverride: chatConfig.agentModel || null
          });
        } catch (classErr) {
          console.warn('[Classifier/chat] Classification failed, defaulting to TOOL_USE:', classErr.message);
        }
      }

      const chatClassifiedAsToolUse = chatHasActivePlan
        || !chatClassificationResult
        || chatClassificationResult.requiresToolUse;

      // --- Step 3: Subconscious context curation (only on CONVERSATIONAL path) ---
      const useChatSubconscious = !chatClassifiedAsToolUse;

      let chatSubconsciousOutput = null;
      let chatSubconsciousDuration = null;
      let chatRawContextForSummarizer = null;

      if (useChatSubconscious) {
        const chatAgentDMForSub = (db && assistant) ? buildAgentDMContext(db, assistant.id) : '';
        chatRawContextForSummarizer = [
          identityContext,
          memoryContext ? buildMemoryContext(memoryContext) : '',
          semanticMemoryText,
          chatAgentDMForSub,
        ].filter(s => s?.trim()).join('\n\n');

        try {
          const isSimple = message.length < 15
            || /^(hi|hey|hello|ok|thanks|thank you|yes|no|sure|yep|nope|k|lol|haha)\b/i.test(message.trim());
          const startTime = Date.now();
          chatSubconsciousOutput = await SubconsciousService.process(db, chatRawContextForSummarizer, {
            isSimpleMessage: isSimple,
            agentModelOverride: chatConfig.agentModel || null,
            depth: chatConfig.subconsciousDepth || 2,
            agentId: assistant.id
          });
          chatSubconsciousDuration = Date.now() - startTime;
          console.log(`[Subconscious/chat] Processed in ${chatSubconsciousDuration}ms (${chatSubconsciousOutput.depthLabel}) | Input: ${Math.round(chatRawContextForSummarizer.length / 1024)}KB | Output: ${Math.round(chatSubconsciousOutput.text.length / 1024)}KB`);
        } catch (subErr) {
          console.warn('[Subconscious/chat] Processing failed, falling back to raw context:', subErr.message);
        }
      }

      // Inject classification into subconscious output for debug viewer
      if (chatSubconsciousOutput) {
        chatSubconsciousOutput.classification = chatClassificationResult?.classification || 'CONVERSATIONAL';
        chatSubconsciousOutput.requiresToolUse = false;
      }

      // --- Step 4: Re-resolve model for CLI spawn ---
      const chatCliTaskType = chatClassifiedAsToolUse ? 'planning' : 'conversation';
      if (chatCliTaskType !== 'conversation' && db) {
        const chatPrevFamily = chatResolved.familyId;
        chatResolved = RoutingService.resolve(db, chatCliTaskType, chatAgentOverride);
        chatBackendId = chatResolved.backendId;
        chatAgentModel = chatResolved.modelArg;
        chatBackend = getBackend(chatBackendId);
        const chatReason = chatHasActivePlan ? 'active plan' : chatClassificationResult?.requiresToolUse ? 'TOOL_USE' : 'no classifier';
        console.log(`[Routing] ${chatCliTaskType}/chat: ${chatResolved.familyId} via ${chatResolved.source} (reason: ${chatReason})`);

        // Notify terminal of model switch
        if (chatPrevFamily !== chatResolved.familyId) {
          broadcast(
            state.getResponseClients(),
            CUSTOM,
            { name: 'model-switch', runId, value: { from: chatPrevFamily, to: chatResolved.familyId, cascade: chatCliTaskType, reason: chatReason } }
          );
        }
      }

      // --- SDK path for handleChat ---
      // Disabled — see handleSend comment. CLI needed for tool use.
      const useChatSDK = false; // chatBackendId === 'claude' && AnthropicSDK.isAvailable(db);
      if (useChatSDK) {
        try {
          const userContent = AnthropicSDK.buildUserContent({
            presentMomentImages: presentMomentImageData,
            panoramaData,
            ownerImage,
            ownerName: chatOwnerName,
            presentMomentText: chatPresentMomentContext || '',
            semanticMemoryText,
            digestText: memoryContext?.digestText || '',
            rawConversationEntries,
            timelineImages,
            userMessage: messageWithFileRefs,
            userAttachments: userImageAttachments,
            conversationBudgetChars
          });

          const result = await AnthropicSDK.sendMessage(db, appPath, userContent, { agentModel: chatAgentModel });

          // Record assistant response to conversation DB
          if (db && result.text) {
            try {
              ConversationService.addEntry(db, assistant.id, {
                type: 'conversation',
                speaker: agentName,
                role: 'assistant',
                channel: 'desktop',
                content: result.text
              });
            } catch (convErr) {
              console.warn('Failed to record assistant response:', convErr.message);
            }

            // Store agent response images
            try {
              const agentAttachments = extractFileAttachments(stripInternalNotes(result.text));
              const agentImages = agentAttachments
                .filter(a => a.mimeType && a.mimeType.startsWith('image/'))
                .map(a => {
                  const relPath = a.url.replace(/^\/blob\//, '');
                  return {
                    filePath: path.join(agentBlobDir, relPath),
                    filename: a.filename
                  };
                });
              if (agentImages.length > 0) {
                await storeChatImages(db, assistant.id, agentImages, {
                  imageView: 'chat_agent',
                  speaker: agentName,
                  role: 'assistant',
                  channel: 'desktop'
                });
              }
            } catch (imgErr) {
              console.warn('Failed to store agent response images:', imgErr.message);
            }
          }

          // Return stripped response
          const strippedText = stripInternalNotes(result.text);
          const chatResAttachments = extractFileAttachments(strippedText);
          const chatNoTags = stripFileAttachments(strippedText);
          return res.json({
            text: stripReaction(chatNoTags),
            reaction: extractReaction(chatNoTags),
            attachments: chatResAttachments,
            sessionId: state.getSessionId(),
            raw: null,
            usage: result.usage
          });
        } catch (sdkErr) {
          console.error('SDK error in handleChat:', sdkErr);
          return res.status(500).json({ error: `SDK error: ${sdkErr.message}` });
        }
      }

      // --- CLI path (unchanged) ---
      const chatEnv = prepareAgentEnv(chatBackendId, db, chatResolved.accessMethod);

      // Check if we have images to include
      const chatAnyImages = presentMomentImageData?.thirdPerson || presentMomentImageData?.pov
        || panoramaData?.contactSheet || ownerImage || userImageAttachments.length > 0 || timelineImages.length > 0;
      const _supportsImagesNowChat = chatBackend.supportsImageInput
        && (chatBackend.supportsVisionForFamily?.(chatResolved.familyId, db) ?? true);
      const hasImageStdin = _supportsImagesNowChat && chatAnyImages;   // Claude: base64 via stream-json stdin; local: multimodal content parts
      const hasImageFiles = chatBackend.supportsImageViaFile && chatAnyImages; // Codex: --image file paths
      const chatHasImageDescriptions = chatBackend.supportsImageDescriptions && chatImageDescriptions; // Grok: text descriptions
      const hasImages = hasImageStdin || hasImageFiles;

      const args = chatBackend.buildArgs({
        print: true,
        skipPermissions: true,
        verbose: hasImages,
        streamJson: hasImages,
        json: !hasImages,
        inputFormatStreamJson: hasImageStdin,
        appPath,
        blobDir: chatBlobDir,
        model: chatAgentModel,
        env: chatEnv,
      });

      // No --resume: conversation continuity provided by memory context.

      // Write images to temp files for backends that support --image file paths (Codex)
      let codexTempDir = null;
      let chatImageManifest = '';
      if (hasImageFiles && chatBackend.buildImageFileArgs) {
        codexTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-codex-img-'));
        const { args: imageArgs, manifest } = chatBackend.buildImageFileArgs({
          presentMoment: presentMomentImageData,
          panorama: panoramaData,
          owner: ownerImage,
          timeline: timelineImages,
          userAttachments: userImageAttachments
        }, codexTempDir, { ownerName: chatOwnerName, assistantName: chatAssistantName });
        args.push(...imageArgs);
        chatImageManifest = manifest;
      }

      // Dynamic context shared by both image-stdin and text paths
      const chatAgentDMContext = (db && assistant) ? buildAgentDMContext(db, assistant.id) : '';
      let chatSkillContext = '';
      try {
        const { pinned, suggested } = await CapabilityService.getForContext(db, assistant?.id, message);
        chatSkillContext = CapabilityService.formatForContext(db, pinned, suggested);
        if (chatSkillContext) chatSkillContext = '\n' + chatSkillContext + '\n';
      } catch (e) {
        // Skills context is non-critical
      }

      // For non-image-stdin path, build enriched message with reordered text
      let chatEnrichedMessage = '';
      if (!hasImageStdin) {
        let chatImageDescContext = '';
        if (chatHasImageDescriptions) {
          chatImageDescContext = buildImageDescriptionsContext(chatImageDescriptions, { ownerName: chatOwnerName, assistantName: chatAssistantName });
        }
        // When subconscious classified TOOL_USE, pass full raw context to CLI (no summarized sections).
        const fullContext = (chatSubconsciousOutput && !chatSubconsciousOutput.requiresToolUse && chatSubconsciousOutput.context)
          ? buildStructuralIdentity(appPath) + '\n' + chatSubconsciousOutput.context + chatImageDescContext + chatSkillContext
          : identityContext + chatImageDescContext + (memoryContext ? buildMemoryContext(memoryContext) : '') + chatAgentDMContext + chatSkillContext;
        chatEnrichedMessage = chatImageManifest + enrichMessageWithContext(messageWithFileRefs, fullContext);
        args.push(...chatBackend.buildPromptArgs(chatEnrichedMessage));
      }

      // Cache context snapshot for debug viewer
      try {
        const { getAgentState } = require('../services/agent-state');
        const imgMeta = (img, label) => img ? { label, sizeKB: Math.round((img.data?.length || 0) * 3 / 4 / 1024), mediaType: img.mediaType } : null;
        getAgentState(assistant.id).lastContext = {
          timestamp: new Date().toISOString(),
          identityContext,
          memoryContext,
          skillContext: chatSkillContext,
          agentDMContext: chatAgentDMContext,
          fullContext: hasImageStdin ? '(stream-json path)' : (identityContext + (memoryContext ? buildMemoryContext(memoryContext) : '') + chatAgentDMContext + chatSkillContext),
          enrichedMessage: chatEnrichedMessage || '(stream-json path)',
          profile: _profile,
          images: [
            imgMeta(presentMomentImageData?.thirdPerson, 'Present Moment (3rd person)'),
            imgMeta(panoramaData?.contactSheet, 'Panorama'),
            imgMeta(ownerImage, `Owner (${chatOwnerName || 'user'})`),
            ...timelineImages.map((img, i) => imgMeta(img, `Timeline ${i + 1}`)),
          ].filter(Boolean),
          imageDataUrls: [
            presentMomentImageData?.thirdPerson ? { label: 'Present Moment (3rd person)', dataUrl: `data:${presentMomentImageData.thirdPerson.mediaType};base64,${presentMomentImageData.thirdPerson.data}` } : null,
            panoramaData?.contactSheet ? { label: 'Panorama', dataUrl: `data:${panoramaData.contactSheet.mediaType};base64,${panoramaData.contactSheet.data}` } : null,
            ownerImage ? { label: `Owner (${chatOwnerName || 'user'})`, dataUrl: `data:${ownerImage.mediaType};base64,${ownerImage.data}` } : null,
          ].filter(Boolean),
          semanticMemoryText,
          subconsciousEnabled: !!chatCanClassify,
          subconsciousDirect: false,
          subconsciousClassification: chatClassificationResult?.classification || (chatClassifiedAsToolUse ? 'TOOL_USE' : null),
          subconsciousRequiresToolUse: chatClassifiedAsToolUse,
          classifierDurationMs: chatClassificationResult?.durationMs || null,
          classifierUsage: chatClassificationResult?.usage || null,
          subconsciousDepth: chatSubconsciousOutput?.depth || null,
          subconsciousDepthLabel: chatSubconsciousOutput?.depthLabel || null,
          subconsciousInput: chatRawContextForSummarizer,
          subconsciousOutput: chatSubconsciousOutput?.text || null,
          subconsciousContext: chatSubconsciousOutput?.context || null,
          subconsciousRecommendedResponse: chatSubconsciousOutput?.recommendedResponse || null,
          subconsciousDuration: chatSubconsciousDuration,
          subconsciousUsage: chatSubconsciousOutput?.usage || null,
        };
        persistContextCache(db, assistant.id, getAgentState(assistant.id).lastContext);
      } catch (_e) { /* non-critical */ }

      const claude = spawn(chatBackend.command, args, {
        cwd: appPath,
        env: chatEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: chatBackendId === 'claude' && !hasImages
      });

      // Send prompt via stdin
      if (hasImageStdin) {
        // Stream-json message with images via stdin (Claude)
        // When subconscious classified TOOL_USE (or is off/failed), pass full raw context.
        const chatUseSubconsciousSummary = chatSubconsciousOutput && !chatSubconsciousOutput.requiresToolUse && chatSubconsciousOutput.context;
        const streamJsonMsg = buildStreamJsonMessage({
          identityText: chatUseSubconsciousSummary
            ? `[Context]\n${buildStructuralIdentity(appPath)}\n${chatSubconsciousOutput.context}`
            : `[Context]\n${identityContext}`,
          presentMomentImages: presentMomentImageData,
          panoramaData,
          ownerImage,
          semanticMemoryText: chatUseSubconsciousSummary ? '' : semanticMemoryText,
          digestText: chatUseSubconsciousSummary ? '' : (memoryContext?.digestText || ''),
          sessionDigests: chatUseSubconsciousSummary ? '' : (memoryContext?.sessionDigests || ''),
          dailyDigests: chatUseSubconsciousSummary ? '' : (memoryContext?.dailyDigests || ''),
          rawConversationEntries: chatUseSubconsciousSummary ? [] : rawConversationEntries,
          timelineImages,
          userMessage: messageWithFileRefs,
          userAttachments: userImageAttachments,
          conversationBudgetChars,
          ownerName: chatOwnerName,
          agentDMContext: chatUseSubconsciousSummary ? '' : chatAgentDMContext,
          skillContext: chatSkillContext
        });
        claude.stdin.write(streamJsonMsg + '\n');
        claude.stdin.end();
      } else if (chatBackend.promptViaStdin && chatEnrichedMessage) {
        // Codex: pipe prompt via stdin (avoids ARG_MAX with large context)
        claude.stdin.write(chatEnrichedMessage);
        claude.stdin.end();
      }

      let stdout = '';
      let stderr = '';
      let responded = false;

      const { SettingsService: ChatSettingsService } = deps;
      const chatRawTimeout = (db && ChatSettingsService) ? ChatSettingsService.get(db, 'responseTimeoutMs') : null;
      const chatClaudeTimeout = chatRawTimeout !== null ? parseInt(chatRawTimeout) : DEFAULT_CLAUDE_TIMEOUT_MS;

      // Only set timeout if chatClaudeTimeout > 0
      const timeout = chatClaudeTimeout > 0 ? setTimeout(() => {
        if (!responded) {
          responded = true;
        state.working = false;
          claude.kill();
          res.status(504).json({ error: `${chatBackend.label} took too long to respond. Try a simpler message.` });
        }
      }, chatClaudeTimeout) : null;

      claude.stdout.on('data', (data) => {
        const text = data.toString();
        stdout += text;
      });

      claude.stderr.on('data', (data) => {
        const text = data.toString();
        stderr += text;
      });

      claude.on('close', async (code) => {
        if (timeout) clearTimeout(timeout);

        // Clean up Codex temp image files
        if (codexTempDir) {
          try { fs.rmSync(codexTempDir, { recursive: true, force: true }); } catch (e) {}
        }

        if (responded) return;
        responded = true;
        state.working = false;

        if (code !== 0) {
          console.error(`${chatBackend.label} exited with code`, code, stderr);
          // If no stdout at all, return error immediately
          if (!stdout.trim()) {
            return res.status(500).json({
              error: `${chatBackend.label} exited with code ${code}`,
              stderr: stderr
            });
          }
          // Otherwise fall through and try to parse whatever we got
        }

        try {
          let response, textResponse;

          if (hasImageStdin) {
            // Parse stream-json output (multiple lines)
            const parsed = parseStreamJsonOutput(stdout);
            response = parsed.raw;
            textResponse = parsed.result;
          } else {
            // Parse JSON output — single object for Claude/Gemini, JSONL for Codex
            try {
              response = JSON.parse(stdout);

              textResponse = '';
              if (response.result) {
                textResponse = response.result;
              } else if (response.content) {
                textResponse = response.content
                  .filter(block => block.type === 'text')
                  .map(block => block.text)
                  .join('\n');
              } else if (typeof response === 'string') {
                textResponse = response;
              }
            } catch (singleParseErr) {
              // Not a single JSON object — try JSONL (Codex emits one JSON per line)
              const parsed = parseStreamJsonOutput(stdout);
              response = parsed.raw;
              textResponse = parsed.result;
              if (!textResponse) throw singleParseErr;
            }
          }

          // Record assistant response to conversation DB
          if (db && textResponse) {
            try {
              ConversationService.addEntry(db, assistant.id, {
                type: 'conversation',
                speaker: agentName,
                role: 'assistant',
                channel: 'desktop',
                content: textResponse
              });
            } catch (convErr) {
              console.warn('Failed to record assistant response:', convErr.message);
            }

            // Store agent response images (from [file:] tags) in DB
            try {
              const agentAttachments = extractFileAttachments(stripInternalNotes(textResponse));
              const agentImages = agentAttachments
                .filter(a => a.mimeType && a.mimeType.startsWith('image/'))
                .map(a => {
                  // url is /blob/chat-attachments/image.png — extract relative path after /blob/
                  const relPath = a.url.replace(/^\/blob\//, '');
                  return {
                    filePath: path.join(agentBlobDir, relPath),
                    filename: a.filename
                  };
                });
              if (agentImages.length > 0) {
                await storeChatImages(db, assistant.id, agentImages, {
                  imageView: 'chat_agent',
                  speaker: agentName,
                  role: 'assistant',
                  channel: 'desktop'
                });
              }
            } catch (imgErr) {
              console.warn('Failed to store agent response images:', imgErr.message);
            }
          }

          // Return stripped response to client
          const strippedText = stripToolCallXml(stripInternalNotes(textResponse));
          const chatResAttachments = extractFileAttachments(strippedText);
          const chatNoTags = stripFileAttachments(strippedText);
          res.json({
            text: stripReaction(chatNoTags),
            reaction: extractReaction(chatNoTags),
            attachments: chatResAttachments,
            sessionId: state.getSessionId(),
            raw: response
          });
        } catch (parseErr) {
          console.warn('Could not parse JSON response:', parseErr.message);

          // Return stripped response to client
          const strippedFallback = stripToolCallXml(stripInternalNotes(stdout.trim()));
          const fallbackAttachments = extractFileAttachments(strippedFallback);
          const fallbackNoTags = stripFileAttachments(strippedFallback);
          res.json({
            text: stripReaction(fallbackNoTags),
            reaction: extractReaction(fallbackNoTags),
            attachments: fallbackAttachments,
            sessionId: state.getSessionId(),
            raw: null
          });
        }
      });

      claude.on('error', (err) => {
        if (timeout) clearTimeout(timeout);
        if (responded) return;
        responded = true;
        state.working = false;
        console.error(`Failed to spawn ${chatBackend.command}:`, err);
        res.status(500).json({ error: err.message });
      });

    } catch (err) {
      console.error('Chat error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    }
  };
}

module.exports = {
  handleSend,
  handleChat,
  prepareClaudeEnv
};
