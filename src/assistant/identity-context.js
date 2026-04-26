/**
 * Identity context builder for assistant messages
 * Builds MYSELF.md, USER.md, current images, and system time context for Claude
 *
 * @see identity-images.js for image loading, compression, and image context formatting
 */

const fs = require('fs');
const path = require('path');
const { APPS_DIR } = require('../config');
const ConversationService = require('../services/conversation');
const BuzzService = require('../services/buzz');
const EmbodiedService = require('../services/embodiment');
const { loadJSON } = require('../utils/file-helpers');
const { describeImagesForContext, buildImageDescriptionsContext, buildTimelineDescriptionItems } = require('../utils/image-describe');
const AgentService = require('../services/agent');
const { getEffectiveContextBudget } = require('../services/context-limits');
const {
  detectImageMediaType,
  findCurrentImages,
  loadPresentMomentImages,
  loadOwnerImage,
  loadParticipantImage,
} = require('./identity-images');

const MAX_FILE_CHARS = 20000;
const DEFAULT_TOTAL_BUDGET_TOKENS = 200000;  // 200K context window
const CHARS_PER_TOKEN = 3.2;  // Conservative estimate with 20% buffer
const PRESENT_MOMENT_IMAGE_TOKENS = 1000;  // ~1000 tokens per image at 1024px (present moment tier)
const OWNER_IMAGE_TOKENS = 300;             // ~300 tokens for owner image at 384px (memory-tier compression)
const CHAT_IMAGE_TOKENS = 300;              // ~300 tokens per chat image at 384px (memory-tier compression)

/**
 * Build the system time context string
 * @param {string} [timezone] - IANA timezone (e.g. 'America/New_York'). Falls back to OS default.
 * @returns {string} Formatted system time XML tag
 */
function buildTimeContext(timezone) {
  const now = new Date();
  const timeOptions = {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  };
  if (timezone) {
    timeOptions.timeZone = timezone;
  }
  const formattedTime = now.toLocaleString('en-US', timeOptions);
  return `<system_time description="Current local date and time">${formattedTime}</system_time>\n\n`;
}

/**
 * Read and truncate a file's contents if needed
 * @param {string} filePath - Path to the file
 * @param {number} maxChars - Maximum characters to include
 * @returns {string|null} File contents or null if not found
 */
function readFileTruncated(filePath, maxChars = MAX_FILE_CHARS) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  let content = fs.readFileSync(filePath, 'utf-8');
  if (content.length > maxChars) {
    content = content.substring(0, maxChars) + '\n[truncated]';
  }
  return content;
}

/**
 * Build the MYSELF.md context (assistant's identity)
 * @param {string} appPath - Path to the assistant app directory
 * @returns {string} MYSELF context or empty string
 */
function buildMyselfContext(appPath) {
  const myselfPath = path.join(appPath, 'MYSELF.md');
  const content = readFileTruncated(myselfPath);
  if (!content) return '';
  return `<myself description="This is who YOU are - your identity, personality, and values">\n${content}\n</myself>\n\n`;
}

/**
 * Extract just the structural identity from MYSELF.md (preamble + Identity + Current Model + Appearance).
 * Used when subconscious memory is active — narrative identity is handled by the summarizer.
 */
function buildStructuralIdentity(appPath) {
  const myselfPath = path.join(appPath, 'MYSELF.md');
  const content = readFileTruncated(myselfPath);
  if (!content) return '';

  // Extract everything up to and including the Appearance section
  // MYSELF.md structure: # MYSELF.md → preamble → ## Identity → ## Current Model → ## Appearance → [narrative content]
  // We want to stop after the Appearance block ends (next ## heading or narrative content start)
  const lines = content.split('\n');
  const result = [];
  let inAppearance = false;

  for (const line of lines) {
    if (inAppearance) {
      // After Appearance: only keep bullet lines and blank lines
      if (line.startsWith('-') || !line.trim()) {
        result.push(line);
        continue;
      }
      // Anything else (headings, narrative text) means we've left the structural section
      break;
    }

    result.push(line);

    if (/^## Appearance/.test(line)) inAppearance = true;
  }

  return result.join('\n').trim() + '\n';
}

/**
 * Load the "current moment" from agent_life_entries with LEFT JOINs to agent_life_items.
 * Provides richer context than journal metadata (outfit, hairstyle, makeup, body position, surroundings).
 * Falls back to loadCurrentMomentFromJournal if no life entries exist.
 * @param {object} db - SQLite database instance
 * @param {string} appId - Application ID (agent ID)
 * @returns {{ text: string, timestamp: string, surroundings: string|null } | null}
 */
function loadCurrentMoment(db, appId) {
  if (!db) return null;

  try {
    const row = db.prepare(`
      SELECT
        le.*,
        o.name AS outfit_name, o.description AS outfit_desc,
        s.name AS setting_name, s.description AS setting_desc, s.panoramic AS setting_panoramic, s.scene_prompt AS setting_scene_prompt,
        h.name AS hairstyle_name, h.description AS hairstyle_desc
      FROM agent_life_entries le
      LEFT JOIN agent_life_items o ON le.outfit_id = o.id
      LEFT JOIN agent_life_items s ON le.setting_id = s.id
      LEFT JOIN agent_life_items h ON le.hairstyle_id = h.id
      WHERE le.agent_id = ?
      ORDER BY le.timestamp DESC
      LIMIT 1
    `).get(appId);

    if (!row) return loadCurrentMomentFromJournal(db, appId);

    const lines = [];
    if (row.activity) lines.push(`Current moment: ${row.activity}`);
    if (row.setting_name) lines.push(`Location: ${row.setting_name}`);
    if (row.mood) lines.push(`Mood: ${row.mood}`);
    if (row.weather) lines.push(`Weather: ${row.weather}`);
    if (row.food_drink) lines.push(`Food/drink: ${row.food_drink}`);
    if (row.outfit_name) lines.push(`Outfit: ${row.outfit_name} — ${row.outfit_desc || ''}`);
    if (row.hairstyle_name) lines.push(`Hair: ${row.hairstyle_name} — ${row.hairstyle_desc || ''}`);
    if (row.makeup) lines.push(`Makeup: ${row.makeup}`);
    if (row.body_position) lines.push(`Position: ${row.body_position}`);

    if (lines.length === 0) return loadCurrentMomentFromJournal(db, appId);

    return {
      text: lines.join('\n'),
      timestamp: row.timestamp,
      surroundings: row.setting_panoramic || null
    };
  } catch (err) {
    // Table may not exist yet — fall back
    console.warn('[CurrentMoment] agent_life_entries query failed, falling back to journal:', err.message);
    return loadCurrentMomentFromJournal(db, appId);
  }
}

/**
 * Load the "current moment" from the most recent journal entry's metadata.
 * Extracts activity, location, mood, weather_outside, food_drink.
 * @param {object} db - SQLite database instance
 * @param {string} appId - Application ID
 * @returns {{ text: string, timestamp: string } | null}
 */
function loadCurrentMomentFromJournal(db, appId) {
  if (!db) return null;

  try {
    const stmt = db.prepare(`
      SELECT metadata, timestamp FROM conversation_entries
      WHERE type = 'journal' AND app_id = ?
      ORDER BY timestamp DESC LIMIT 1
    `);
    const row = stmt.get(appId);
    if (!row || !row.metadata) return null;

    const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
    const lines = [];

    if (meta.activity) lines.push(`Current moment: ${meta.activity}`);
    if (meta.location) lines.push(`Location: ${meta.location}`);
    if (meta.mood) lines.push(`Mood: ${meta.mood}`);
    if (meta.weather_outside) lines.push(`Weather: ${meta.weather_outside}`);
    if (meta.food_drink) lines.push(`Food/drink: ${meta.food_drink}`);

    if (lines.length === 0) return null;

    return { text: lines.join('\n'), timestamp: row.timestamp };
  } catch (err) {
    console.warn('[CurrentMoment] Failed to load from journal:', err.message);
    return null;
  }
}

/**
 * Build the present moment context section
 * @param {object} presentMomentImageData - { thirdPerson } image data or null
 * @param {string|null} currentMomentText - Current moment text from latest journal entry
 * @param {string} assistantName - The assistant's name (e.g. 'Assistant')
 * @returns {string} Present moment XML section
 */
function buildPresentMomentContext(presentMomentImageData, currentMomentText = null, assistantName = '', surroundingsText = null, timezone = null) {
  let context = '<present_moment description="This is RIGHT NOW — your current state and perspective">\n';
  context += buildTimeContext(timezone);

  if (presentMomentImageData?.thirdPerson) {
    const nameLabel = assistantName ? `, ${assistantName}` : '';
    context += `Image: Current image of you${nameLabel} (third-person view) — attached above in high fidelity\n`;
  }

  if (currentMomentText) {
    context += '\n' + currentMomentText + '\n';
  }

  if (surroundingsText) {
    context += '\n<surroundings>' + surroundingsText + '</surroundings>\n';
  }

  context += '</present_moment>\n\n';
  return context;
}

/**
 * Build the USER.md context (owner information)
 * @param {string} appPath - Path to the assistant app directory
 * @returns {string} USER context or empty string
 */
function buildUserContext(appPath) {
  const userPath = path.join(appPath, 'USER.md');
  const content = readFileTruncated(userPath);
  if (!content) return '';
  return `<user description="This is your owner - the person you serve and communicate with">\n${content}\n</user>\n\n`;
}

/**
 * Build principles context from PRINCIPLES.md if it exists
 * @param {string} appPath - Path to the assistant app directory (agent dir)
 * @returns {string} Principles context wrapped in XML tags, or empty string
 */
function buildPrinciplesContext(appPath) {
  const principlesPath = path.join(appPath, 'PRINCIPLES.md');
  if (!fs.existsSync(principlesPath)) return '';

  try {
    const content = fs.readFileSync(principlesPath, 'utf-8').trim();
    if (!content) return '';
    return '\n<principles description="Cross-cutting behavioral principles and domain syntheses extracted from the full conversation history. Conceptual compressions — they explain WHY things happened, not WHAT happened. Most will be dormant in any given conversation; the contextualizer surfaces what\'s relevant.">\n'
      + content
      + '\n</principles>\n\n';
  } catch {
    return '';
  }
}

function buildMotivationsContext(appPath) {
  const motivationsPath = path.join(appPath, 'MOTIVATIONS.md');
  if (!fs.existsSync(motivationsPath)) return '';

  try {
    const content = fs.readFileSync(motivationsPath, 'utf-8').trim();
    if (!content) return '';
    return '\n<motivations description="Active missions, enduring commitments, and appraisal framework. Defines what the agent cares about and what\'s at stake. Most missions will be background in any given conversation; the contextualizer surfaces what\'s live.">\n'
      + content
      + '\n</motivations>\n\n';
  } catch {
    return '';
  }
}

/**
 * Build context from the agent's instruction file (CLAUDE.md, GEMINI.md, etc.)
 * This ensures the agent sees its constitution and capabilities on all paths,
 * including the CONVERSATIONAL path where the CLI is not spawned.
 * @param {string} appPath - Path to the agent directory
 * @param {object|null} backend - Backend config from backend-adapter (has instructionFile)
 * @returns {string} Instruction file content wrapped in XML tags, or empty string
 */
function buildInstructionFileContext(appPath, backend = null) {
  if (!backend || !backend.instructionFile) return '';
  try {
    const filePath = path.join(appPath, backend.instructionFile);
    if (!fs.existsSync(filePath)) return '';
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    if (!content) return '';
    const fileName = backend.instructionFile;
    return `<system_instructions source="${fileName}">\n` + content + '\n</system_instructions>\n\n';
  } catch {
    return '';
  }
}

/**
 * Build the complete identity context for a message
 * @param {string} appPath - Path to the assistant app directory
 * @returns {string} Combined identity context (time + myself + user)
 */
function buildIdentityContext(appPath, timezone = null) {
  const appId = path.basename(appPath);
  let context = '';
  context += buildTimeContext(timezone);
  context += buildMyselfContext(appPath);
  context += BuzzService.getContextInjection(appPath);
  context += EmbodiedService.getContextInjection(appPath);
  context += buildUserContext(appPath);
  context += buildPrinciplesContext(appPath);
  context += buildMotivationsContext(appPath);
  return context;
}

/**
 * Enrich a message with identity context
 * @param {string} message - The original message
 * @param {string} identityContext - The identity context to prepend
 * @returns {string} Enriched message with context
 */
function enrichMessageWithContext(message, identityContext) {
  if (!identityContext || !identityContext.trim()) {
    return message;
  }
  return `[Context]\n${identityContext}[Message]\n${message}`;
}

/**
 * Build agent thread context for injection into identity context
 * Shows recent DM and group threads this agent participates in
 */
function buildAgentThreadContext(db, agentId) {
  try {
    const AgentChatService = require('../services/agent-chat');
    const threads = AgentChatService.getThreads(db, agentId);
    if (!threads || threads.length === 0) return '';

    let context = '\n## Recent Agent Threads\n';
    for (const thread of threads.slice(0, 5)) {
      const messages = AgentChatService.getMessages(db, thread.id, 8);
      if (messages.length === 0) continue;

      const threadType = thread.type === 'group' ? 'Group' : 'DM';
      const threadLabel = thread.name ? ` "${thread.name}"` : '';
      context += `### ${threadType}${threadLabel}\n`;

      const lines = messages.map(m => {
        const label = m.sender_app_id === 'user' ? 'User' : m.sender_name;
        return `  ${label}: ${m.content}`;
      });
      context += lines.join('\n') + '\n';
    }
    return context;
  } catch {
    return '';
  }
}

// Keep backward compatibility alias
const buildAgentDMContext = buildAgentThreadContext;

/**
 * Calculate memory budgets after accounting for identity context
 * Context ordering: myself → grok → present_moment → user → semantic → conversation+timeline
 *
 * Token budget resolution order:
 *   1. Caller passes an explicit `totalBudgetTokens` → use it as-is
 *   2. Caller passes `options.resolved` and we have a `db` → look up the
 *      per-mode setting via getEffectiveContextBudget, which subtracts the
 *      CLI's own request envelope (system prompt + tool schemas) from the
 *      user-configured budget so we don't overflow the model's input window
 *      when opencode/claude/etc. add their overhead on top of our context
 *   3. Fall back to DEFAULT_TOTAL_BUDGET_TOKENS (preserves legacy behavior)
 *
 * @param {string} appPath - Path to the assistant app directory
 * @param {object} db - Database instance (optional, falls back to file-based if not provided)
 * @param {number|null} totalBudgetTokens - Explicit override; null/undefined defers to settings
 * @param {object} options
 * @param {object} [options.resolved] - RoutingService.resolve() output; used to pick local vs. proprietary limit
 * @returns {object} Context components and budget allocations
 */
async function calculateContextBudgets(appPath, db = null, totalBudgetTokens = null, options = {}) {
  const { includeImages = true, backend = null, threadParticipantIds = null, resolved = null } = options;
  if (totalBudgetTokens == null) {
    totalBudgetTokens = (db && resolved)
      ? getEffectiveContextBudget(db, resolved)
      : DEFAULT_TOTAL_BUDGET_TOKENS;
  }
  const appId = path.basename(appPath);

  // Look up agent to get parent app_id for correct path resolution
  const ctxAgent = db ? AgentService.getById(db, appId) : null;
  const agentAppId = ctxAgent ? ctxAgent.app_id : null;

  // Read assistant config for identity names (prefer AgentService, fallback to disk)
  const assistantConfig = (db && AgentService.getConfig(db, appId)) || loadJSON(path.join(appPath, 'assistant-config.json'), {});
  const assistantName = assistantConfig.assistantName || '';
  const ownerName = assistantConfig.ownerName || '';

  // Read configured timezone
  const { getConfiguredTimezone } = require('../routes/system');
  const timezone = getConfiguredTimezone(db);

  // Build identity text components
  const myselfContext = buildMyselfContext(appPath);
  const buzzContext = BuzzService.getContextInjection(appPath);
  const embodiedContext = EmbodiedService.getContextInjection(appPath);
  const userContext = buildUserContext(appPath);

  // Load images only when requested (calls skip images to save tokens)
  let presentMomentImageData = { thirdPerson: null };
  let ownerImage = null;
  let timelineImages = [];

  if (includeImages) {
    // Load present moment images from original files on disk (high fidelity: 1024px, 85%)
    presentMomentImageData = await loadPresentMomentImages(appId, agentAppId);

    // Fall back to DB images if originals not available
    if (!presentMomentImageData.thirdPerson && db) {
      const dbImages = ConversationService.getCurrentImages(db, appId);
      if (dbImages.thirdPerson?.image_data) {
        const base64String = dbImages.thirdPerson.image_data;
        const buffer = Buffer.from(base64String, 'base64');
        const mediaType = detectImageMediaType(buffer);
        presentMomentImageData.thirdPerson = { data: base64String, mediaType };
        console.log(`[PresentMoment] thirdPerson: fallback to DB (384px)`);
      }
    }

    // Load owner reference image (compressed + cached) — check app-level shared dir first
    const appDir = agentAppId ? path.join(APPS_DIR, agentAppId) : null;
    ownerImage = await loadOwnerImage(appPath, ownerName, appDir);

    // Load recent chat images (user uploads + agent-sent) — last 6 images
    if (db) {
      const chatImages = ConversationService.getRecentChatImages(db, appId, 6);
      if (chatImages.length > 0) {
        timelineImages = chatImages.map(img => {
          const buffer = Buffer.from(img.image_data, 'base64');
          const mediaType = detectImageMediaType(buffer);
          return {
            data: img.image_data,
            mediaType,
            timestamp: img.timestamp,
            imageView: img.metadata?.image_view,
            speaker: img.speaker
          };
        });
        console.log(`[ChatImages] Loaded ${timelineImages.length} recent chat images`);
      }
    }
  }

  // Load participant images for group thread context
  let participantImages = [];
  if (includeImages && threadParticipantIds && threadParticipantIds.length > 0) {
    const selfId = appId;
    for (const pid of threadParticipantIds) {
      if (pid === 'user' || pid === selfId) continue;
      const pAgent = db ? AgentService.getById(db, pid) : null;
      if (!pAgent) continue;
      const img = await loadParticipantImage(pid, db);
      if (img) {
        participantImages.push({
          agentId: pid,
          agentName: pAgent.name,
          data: img.data,
          mediaType: img.mediaType
        });
        console.log(`[ParticipantImage] Loaded ${pAgent.name} (${pid})`);
      }
    }
  }

  // Generate text descriptions for backends that can't see images (e.g., Grok)
  let imageDescriptions = null;
  if (includeImages && backend?.supportsImageDescriptions && db) {
    const anyImages = presentMomentImageData.thirdPerson
      || ownerImage;
    if (anyImages) {
      imageDescriptions = await describeImagesForContext(db, {
        presentMomentImageData,
        ownerImage,
        participantImages,
        timelineImages: []
      }, { ownerName, assistantName });
    }
  }

  // Load current moment from life entries (falls back to journal metadata)
  const currentMoment = loadCurrentMoment(db, appId);
  if (currentMoment) {
    const source = currentMoment.surroundings !== undefined ? 'life_entries' : 'journal';
    console.log(`[CurrentMoment] Loaded from ${source} (${formatTimeFromISO(currentMoment.timestamp)})`);
  }

  // Surroundings come from the life entry JOIN (or null)
  const surroundingsText = currentMoment?.surroundings || null;

  // Build present moment context section (includes current moment + surroundings if available)
  const presentMomentContext = buildPresentMomentContext(presentMomentImageData, currentMoment?.text, assistantName, surroundingsText, timezone);

  const ownerLabel = ownerName || 'your user';
  const ownerImageMarker = ownerImage ? `${ownerLabel}'s image:\n` : '';

  // Principles context (cross-cutting principles & domain syntheses)
  const principlesContext = buildPrinciplesContext(appPath);

  // Motivations context (active missions, stakes, appraisal framework)
  const motivationsContext = buildMotivationsContext(appPath);

  // Instruction file context (CLAUDE.md / GEMINI.md / etc. — system instructions + capabilities)
  const instructionFileContext = buildInstructionFileContext(appPath, backend);

  // System instructions first, then identity: myself → grok → embodied → present_moment → user → principles → motivations → owner marker
  const identityContext = instructionFileContext + myselfContext + buzzContext + embodiedContext + presentMomentContext + userContext + principlesContext + motivationsContext + ownerImageMarker;

  // Calculate image tokens with separate tiers
  const presentMomentCount = presentMomentImageData.thirdPerson ? 1 : 0;
  const ownerImageCount = ownerImage ? 1 : 0;
  const chatImageCount = timelineImages.length;
  const participantImageCount = participantImages.length;
  const imageTokens = (presentMomentCount * PRESENT_MOMENT_IMAGE_TOKENS)
    + (ownerImageCount * OWNER_IMAGE_TOKENS)
    + (chatImageCount * CHAT_IMAGE_TOKENS)
    + (participantImageCount * CHAT_IMAGE_TOKENS);

  // Calculate remaining budget after identity text and images
  const totalBudgetChars = Math.floor(totalBudgetTokens * CHARS_PER_TOKEN);
  const identityChars = identityContext.length;
  const imageCharsEquivalent = Math.floor(imageTokens * CHARS_PER_TOKEN);
  const remainingChars = Math.max(0, totalBudgetChars - identityChars - imageCharsEquivalent);

  // Split remaining 65/35 between conversation (digests + raw) and semantic search
  // Digests are denser than raw entries, so conversation needs proportionally more budget
  const conversationBudgetChars = Math.floor(remainingChars * 0.65);
  const semanticBudgetChars = Math.floor(remainingChars * 0.35);

  const totalImageCount = presentMomentCount + ownerImageCount + chatImageCount;
  console.log(`Context budget: ${totalBudgetTokens} tokens (${totalBudgetChars} chars)`);
  console.log(`  Identity: ${identityChars} chars (myself: ${myselfContext.length}, user: ${userContext.length})`);
  console.log(`  Images: ${totalImageCount} total (${presentMomentCount} present @1024px, ${ownerImageCount} owner, ${chatImageCount} chat @384px) ~${imageTokens} tokens`);
  console.log(`  Remaining: ${remainingChars} chars → conversation: ${conversationBudgetChars}, semantic: ${semanticBudgetChars}`);

  // Build profile for token profiler
  const presentMomentImageTokens = presentMomentCount * PRESENT_MOMENT_IMAGE_TOKENS;
  const ownerImageTokens = ownerImageCount * OWNER_IMAGE_TOKENS;

  return {
    identityContext,
    identityChars,
    imageCount: totalImageCount,
    imageTokens,
    presentMomentImageData,  // High fidelity: { thirdPerson }
    timelineImages,          // Recent chat images (user uploads + agent-sent, 384px)
    ownerImage,              // { data, mediaType } or null
    participantImages,       // [{ agentId, agentName, data, mediaType }] for group thread members
    imageDescriptions,       // Text descriptions for non-vision backends (or null)
    conversationBudgetChars,
    semanticBudgetChars,
    totalBudgetChars,
    ownerName,               // From assistant-config.json
    assistantName,           // From assistant-config.json
    // Individual components for SDK system/user message split
    myselfContext,
    buzzContext,
    embodiedContext,
    userContext,
    presentMomentContext,
    _profile: {
      myselfChars: myselfContext.length,
      userChars: userContext.length,
      buzzChars: buzzContext.length,
      embodiedChars: embodiedContext.length,
      presentMomentTextChars: presentMomentContext.length,
      presentMomentImageCount: presentMomentCount,
      presentMomentImageTokens,
      ownerImageCount,
      ownerImageTokens
    }
  };
}

/**
 * Format time from ISO timestamp for display
 * @param {string} isoTimestamp - ISO 8601 timestamp
 * @returns {string} Formatted time like "10:30 AM"
 */
function formatTimeFromISO(isoTimestamp) {
  if (!isoTimestamp) return '';
  const date = new Date(isoTimestamp);
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/**
 * Build memory context from conversation history and relevant memory chunks
 * Used by non-image path. For image path, use buildSemanticMemoryContext + interleaving.
 * Supports both new 4-tier format (sessionDigests/dailyDigests) and legacy format (digestText).
 * @param {object} memoryContext - Context object from MemoryService.getContextForMessage
 * @returns {string} Formatted memory context string
 */
function buildMemoryContext(memoryContext) {
  let result = '';

  // Semantic memory first (so conversation history is at the end for recency)
  result += buildSemanticMemoryContext(memoryContext);

  // Tier 3: Daily digests (oldest tier)
  if (memoryContext.dailyDigests && memoryContext.dailyDigests.trim()) {
    result += '<daily_summaries description="Day-level summaries of past conversations (7-day window). High-level themes and outcomes.">\n';
    result += memoryContext.dailyDigests;
    result += '\n</daily_summaries>\n\n';
  }

  // Tier 2: Session digests
  if (memoryContext.sessionDigests && memoryContext.sessionDigests.trim()) {
    result += '<session_summaries description="Session-level summaries of recent conversations (24h window). More detail than daily summaries.">\n';
    result += memoryContext.sessionDigests;
    result += '\n</session_summaries>\n\n';
  }

  // Legacy fallback: if no new-format digests, use digestText
  if (!memoryContext.sessionDigests && !memoryContext.dailyDigests && memoryContext.digestText && memoryContext.digestText.trim()) {
    result += '<earlier_today description="Digested summaries of earlier conversations. These are compressed — the original exchanges happened but are summarized here.">\n';
    result += memoryContext.digestText;
    result += '\n</earlier_today>\n\n';
  }

  // Tier 1: Recent conversation history (high fidelity)
  if (memoryContext.conversationHistory && memoryContext.conversationHistory.trim()) {
    result += '<recent_history description="Full conversation and visual timeline (last few hours), in chronological order. Most recent exchange is at the end.">\n';
    result += memoryContext.conversationHistory;
    result += '\n</recent_history>\n\n';
  }

  return result;
}

/**
 * Build just the semantic memory context (relevant memory chunks from search)
 * @param {object} memoryContext - Context object from MemoryService.getContextForMessage
 * @returns {string} Formatted semantic memory string
 */
function buildSemanticMemoryContext(memoryContext) {
  if (!memoryContext.relevantMemory || memoryContext.relevantMemory.length === 0) {
    return '';
  }

  const hasVaultResults = memoryContext.relevantMemory.some(c => c.category === 'vault');
  const vaultCitation = hasVaultResults
    ? ' When citing information from vault knowledge sources, mention the source naturally (e.g., "Based on your notes about X..." or "From your document Y...").'
    : '';

  let result = `<relevant_memory description="Semantically relevant past conversations and information retrieved from long-term memory.${vaultCitation}">\n`;
  for (const chunk of memoryContext.relevantMemory) {
    // Label drill-down entries clearly
    let label = chunk.source;
    if (chunk._drilldown && chunk.source.startsWith('drilldown:')) {
      label = 'full conversation (drill-down from summary above)';
    } else if (chunk.category === 'daily_digest') {
      label = 'daily summary';
    } else if (chunk.category === 'session_digest') {
      label = 'session summary';
    } else if (chunk.category === 'vault') {
      label = `vault: ${chunk.source.replace(/^vault:/, '')}`;
    }
    result += `[${label}] ${chunk.text}\n\n`;
  }
  result += '</relevant_memory>\n\n';
  return result;
}

/**
 * Format a single conversation entry for display
 * @param {object} entry - Raw conversation entry from DB
 * @returns {string} Formatted entry text
 */
function formatConversationEntry(entry) {
  const ts = new Date(entry.timestamp);
  const time = ts.toLocaleString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  });

  let badge = '';
  if (entry.type === 'journal') {
    badge = ' [journal]';
  } else if (entry.channel !== 'desktop') {
    badge = ` via ${entry.channel}`;
  }

  return `[${time}${badge}]\n${entry.speaker}: ${entry.content}`;
}

/**
 * Format a timeline image label for display
 * @param {object} img - Timeline image with timestamp and imageView
 * @returns {string} Formatted label like "[3:45 PM] Image of you (third person)"
 */
function formatTimelineImageLabel(img, ownerName = '') {
  const ts = formatTimeFromISO(img.timestamp);
  const fromLabel = ownerName || 'user';
  const viewLabel = {
    'chat_user': `Image from ${fromLabel}`,
    'chat_agent': 'Image you sent',
    'telegram_user': `Image from ${fromLabel} (Telegram)`,
    'third_person': 'Image of you (third person)'
  };
  return `[${ts}] ${viewLabel[img.imageView] || 'Image'}`;
}

/**
 * Interleave conversation entries with timeline images chronologically
 * Keeps newest entries within budget, drops oldest when over budget.
 * @param {Array} entries - Raw conversation entries from DB
 * @param {Array} images - Timeline images with timestamps
 * @param {number} budgetChars - Text character budget for conversation
 * @param {string} ownerName - Owner's name for image labels
 * @returns {object} { blocks: Array<content block>, truncated: boolean }
 */
function interleaveConversationAndImages(entries, images, budgetChars, ownerName = '') {
  // Build text items from conversation entries
  const textItems = entries.map(entry => ({
    type: 'text',
    timestamp: new Date(entry.timestamp).getTime(),
    text: formatConversationEntry(entry),
  }));

  // Build image items from timeline
  const imageItems = images.filter(img => img.data).map(img => ({
    type: 'image',
    timestamp: new Date(img.timestamp).getTime(),
    imageData: { data: img.data, mediaType: img.mediaType },
    label: formatTimelineImageLabel(img, ownerName),
  }));

  // Merge and sort chronologically
  const allItems = [...textItems, ...imageItems].sort((a, b) => a.timestamp - b.timestamp);

  // Walk backwards from newest to find cutoff within text budget
  let textChars = 0;
  let cutoffIndex = 0;

  for (let i = allItems.length - 1; i >= 0; i--) {
    const item = allItems[i];
    if (item.type === 'text') {
      if (textChars + item.text.length > budgetChars) {
        cutoffIndex = i + 1;
        break;
      }
      textChars += item.text.length;
    }
    // Images don't count toward text budget (tokens counted separately)
  }

  // Build content blocks from cutoff to end (chronological)
  const blocks = [];
  const truncated = cutoffIndex > 0;

  if (truncated) {
    blocks.push({ type: 'text', text: '[...earlier conversation truncated...]\n\n' });
  }

  for (let i = cutoffIndex; i < allItems.length; i++) {
    const item = allItems[i];
    if (item.type === 'text') {
      blocks.push({ type: 'text', text: item.text });
    } else {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: item.imageData.mediaType, data: item.imageData.data }
      });
      blocks.push({ type: 'text', text: item.label });
    }
  }

  return { blocks, truncated };
}

/**
 * Build a stream-json formatted message with structured context
 *
 * Content block ordering:
 * 1. Present moment images (high fidelity, 1024px)
 * 2. User attachment images
 * 3. Identity text: myself → grok → present_moment → user (split at owner image marker)
 * 4. Owner reference photo (inline)
 * 5. Semantic memory text
 * 6. Interleaved conversation history + timeline images (chronological, most recent at end)
 * 7. User's message
 *
 * @param {object} options - Structured context components
 * @param {string} options.identityText - Myself + grok + present_moment + user + owner marker
 * @param {object} options.presentMomentImages - { thirdPerson } high fidelity image data
 * @param {object} options.panoramaData - { contactSheet: { data, mediaType }, settingPath } or null
 * @param {object} options.ownerImage - { data, mediaType } or null
 * @param {string} options.semanticMemoryText - Formatted semantic search results
 * @param {string} options.digestText - Formatted digest text (older history, compressed)
 * @param {Array} options.rawConversationEntries - Raw DB entries with timestamps for interleaving
 * @param {Array} options.timelineImages - Timeline images with timestamps (6h, memory-tier)
 * @param {string} options.userMessage - The actual user message text
 * @param {Array} options.userAttachments - User-uploaded image attachments
 * @param {number} options.conversationBudgetChars - Character budget for conversation text
 * @returns {string} JSON string for stream-json input
 */
function buildStreamJsonMessage(options) {
  const {
    identityText = '',
    presentMomentImages = {},
    panoramaData = null,
    ownerImage = null,
    semanticMemoryText = '',
    digestText = '',
    sessionDigests = '',
    dailyDigests = '',
    rawConversationEntries = [],
    timelineImages = [],
    userMessage = '',
    userAttachments = [],
    conversationBudgetChars = 50000,
    ownerName = '',
    agentDMContext = '',
    skillContext = '',
    participantImages = [],
  } = options;

  const content = [];
  const ownerLabel = ownerName || 'your user';
  const OWNER_IMAGE_MARKER = `${ownerLabel}'s image:\n`;

  // 1. Present moment portrait (high fidelity, at the very top)
  if (presentMomentImages.thirdPerson) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: presentMomentImages.thirdPerson.mediaType,
        data: presentMomentImages.thirdPerson.data
      }
    });
  }

  // 1b. Panorama contact sheet (right after portrait)
  if (panoramaData?.contactSheet) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: panoramaData.contactSheet.mediaType,
        data: panoramaData.contactSheet.data
      }
    });
  }

  // 2. User-uploaded attachments
  if (userAttachments && userAttachments.length > 0) {
    for (const att of userAttachments) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: att.mediaType,
          data: att.data
        }
      });
      content.push({
        type: 'text',
        text: `[User attached: ${att.filename}]`
      });
    }
  }

  // 3. Identity text, split at owner image marker if present
  // The identity text contains: [Context]\n + myself + grok + present_moment + user + "{owner}'s image:\n"
  // We split so the owner photo appears inline right after the marker
  if (ownerImage && identityText.includes(OWNER_IMAGE_MARKER)) {
    const markerIdx = identityText.indexOf(OWNER_IMAGE_MARKER);
    const beforeOwner = identityText.substring(0, markerIdx);
    const afterOwner = identityText.substring(markerIdx + OWNER_IMAGE_MARKER.length);

    // Identity context up to owner marker
    content.push({ type: 'text', text: beforeOwner + `Your owner, ${ownerLabel}:` });

    // 4. Owner's reference photo
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: ownerImage.mediaType,
        data: ownerImage.data
      }
    });

    // Any remaining identity text after the marker (typically empty)
    if (afterOwner.trim()) {
      content.push({ type: 'text', text: afterOwner });
    }
  } else {
    content.push({ type: 'text', text: identityText });
  }

  // 4b. Participant images (group thread members)
  if (participantImages.length > 0) {
    for (const p of participantImages) {
      content.push({ type: 'text', text: `${p.agentName}'s current appearance:` });
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: p.mediaType,
          data: p.data
        }
      });
    }
  }

  // 5. Semantic memory
  if (semanticMemoryText.trim()) {
    content.push({ type: 'text', text: semanticMemoryText });
  }

  // 5b. Agent DM context (inter-agent threads)
  if (agentDMContext && agentDMContext.trim()) {
    content.push({ type: 'text', text: agentDMContext });
  }

  // 5c. Available capabilities (pinned + suggested)
  if (skillContext && skillContext.trim()) {
    content.push({ type: 'text', text: skillContext });
  }

  // 6. Hierarchical conversation history (daily → session → raw)
  // Parse digestText into daily + session parts if both are present
  // (Callers pass combined digestText; we split if new-format fields are available)
  const dailyDigestText = options.dailyDigests || '';
  const sessionDigestText = options.sessionDigests || '';

  if (dailyDigestText.trim()) {
    content.push({
      type: 'text',
      text: '<daily_summaries description="Day-level summaries of past conversations (7-day window). High-level themes and outcomes.">\n' + dailyDigestText + '\n</daily_summaries>'
    });
  }

  if (sessionDigestText.trim()) {
    content.push({
      type: 'text',
      text: '<session_summaries description="Session-level summaries of recent conversations (24h window). More detail than daily summaries.">\n' + sessionDigestText + '\n</session_summaries>'
    });
  }

  // Legacy fallback: if no new-format fields, use digestText directly
  if (!dailyDigestText && !sessionDigestText && digestText.trim()) {
    content.push({
      type: 'text',
      text: '<earlier_today description="Digested summaries of earlier conversations. These are compressed — the original exchanges happened but are summarized here.">\n' + digestText + '\n</earlier_today>'
    });
  }

  // 6b. Recent high-fidelity conversation + timeline images (chronological)
  if (rawConversationEntries.length > 0 || timelineImages.length > 0) {
    // Budget for raw entries: reduced when digests are present above
    const hasAnyDigests = dailyDigestText.trim() || sessionDigestText.trim() || digestText.trim();
    const rawBudgetChars = hasAnyDigests ? Math.floor(conversationBudgetChars * 0.4) : conversationBudgetChars;

    content.push({
      type: 'text',
      text: '<recent_history description="Full conversation and visual timeline (last few hours), in chronological order. Most recent exchange is at the end.">'
    });

    const { blocks } = interleaveConversationAndImages(
      rawConversationEntries,
      timelineImages,
      rawBudgetChars,
      ownerName
    );

    content.push(...blocks);

    content.push({ type: 'text', text: '</recent_history>' });
  }

  // 7. User's actual message (at the very end for maximum recency weight)
  content.push({ type: 'text', text: `[Message]\n${userMessage}` });

  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content
    }
  });
}

// Re-export image functions for backward compatibility
const {
  readImageAsBase64,
  readImageAsBase64Compressed,
  buildCurrentImagesReminder,
} = require('./identity-images');

module.exports = {
  buildTimeContext,
  buildMyselfContext,
  buildUserContext,
  buildIdentityContext,
  buildMemoryContext,
  buildSemanticMemoryContext,
  buildCurrentImagesReminder,
  enrichMessageWithContext,
  buildAgentDMContext,
  buildStructuralIdentity,
  buildPrinciplesContext,
  buildMotivationsContext,
  buildInstructionFileContext,
  buildAgentThreadContext,
  calculateContextBudgets,
  buildStreamJsonMessage,
  interleaveConversationAndImages,
  readImageAsBase64,
  readImageAsBase64Compressed,
  formatTimeFromISO,
  MAX_FILE_CHARS,
  DEFAULT_TOTAL_BUDGET_TOKENS,
  CHARS_PER_TOKEN,
  buildImageDescriptionsContext,
  buildTimelineDescriptionItems
};
