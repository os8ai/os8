/**
 * Anthropic SDK Service
 * Direct API access with prompt caching for static identity content.
 *
 * When ANTHROPIC_API_KEY is set in env_variables, this service provides
 * a direct SDK path that caches ~12K tokens of static identity content
 * (MYSELF.md, USER.md, Grok personality) for 90% cost reduction on cache hits.
 *
 * Falls back to CLI when API key is not set.
 */

const fs = require('fs');
const path = require('path');
const EnvService = require('./env');
const SettingsService = require('./settings');
const BuzzService = require('./buzz');
const EmbodiedService = require('./embodiment');
const AIRegistryService = require('./ai-registry');
const { buildMyselfContext, buildUserContext, buildSemanticMemoryContext, interleaveConversationAndImages } = require('../assistant/identity-context');

const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';
const DEFAULT_MAX_TOKENS = 8192;

/**
 * Resolve model alias to API model ID
 * @param {string|undefined} agentModel - 'opus', 'sonnet', 'haiku', or undefined
 * @param {object} db - Database for settings fallback
 * @returns {string} API model ID
 */
function resolveModel(agentModel, db) {
  const MODEL_MAP = db ? AIRegistryService.getClaudeModelMap(db) : {};
  if (agentModel && MODEL_MAP[agentModel]) {
    return MODEL_MAP[agentModel];
  }
  // Fallback to settings, then default
  const settingsModel = db ? SettingsService.get(db, 'anthropic_model') : null;
  return settingsModel || DEFAULT_MODEL;
}

// Singleton client — re-created if API key changes
let _client = null;
let _lastApiKey = null;

/**
 * Check if SDK mode is available (ANTHROPIC_API_KEY set in DB)
 * @param {object} db - SQLite database instance
 * @returns {boolean}
 */
function isAvailable(db) {
  if (!db) return false;
  try {
    const record = EnvService.get(db, 'ANTHROPIC_API_KEY');
    return !!(record && record.value && record.value.trim());
  } catch {
    return false;
  }
}

/**
 * Get or create singleton Anthropic client.
 * Re-creates if API key changes.
 * @param {object} db - SQLite database instance
 * @returns {object|null} Anthropic client or null
 */
function getClient(db) {
  if (!db) return null;

  const record = EnvService.get(db, 'ANTHROPIC_API_KEY');
  const apiKey = record?.value?.trim();
  if (!apiKey) return null;

  if (_client && apiKey === _lastApiKey) {
    return _client;
  }

  // Lazy require to avoid import errors when SDK not installed
  const Anthropic = require('@anthropic-ai/sdk');
  _client = new Anthropic({ apiKey });
  _lastApiKey = apiKey;
  return _client;
}

/**
 * Build system message array with cache_control breakpoint.
 * Combines CLAUDE.md + MYSELF.md + Grok personality + USER.md into a single
 * cached block that stays warm across turns.
 *
 * @param {string} appPath - Path to the assistant app directory
 * @returns {Array<object>} System content blocks
 */
function buildCachedSystemMessage(appPath) {
  const appId = path.basename(appPath);

  // Read CLAUDE.md (the instruction file Claude CLI auto-reads)
  const claudeMdPath = path.join(appPath, 'CLAUDE.md');
  let claudeMd = '';
  if (fs.existsSync(claudeMdPath)) {
    claudeMd = fs.readFileSync(claudeMdPath, 'utf-8');
    if (claudeMd.length > 20000) {
      claudeMd = claudeMd.substring(0, 20000) + '\n[truncated]';
    }
  }

  // Build static identity components
  const myselfContext = buildMyselfContext(appPath);
  const buzzContext = BuzzService.getContextInjection(appPath);
  const embodiedContext = EmbodiedService.getContextInjection(appPath);
  const userContext = buildUserContext(appPath);

  // Combine all static content into one cached block
  const staticContent = [claudeMd, myselfContext, buzzContext, embodiedContext, userContext]
    .filter(s => s && s.trim())
    .join('\n');

  return [{
    type: 'text',
    text: staticContent,
    cache_control: { type: 'ephemeral' }
  }];
}

/**
 * Build user message content blocks from dynamic context components.
 * These change every turn and are NOT cached.
 *
 * @param {object} opts - Context components
 * @returns {Array<object>} Content blocks for user message
 */
function buildUserContent(opts) {
  const {
    presentMomentImages = {},
    panoramaData = null,
    ownerImage = null,
    ownerName = '',
    presentMomentText = '',
    semanticMemoryText = '',
    digestText = '',
    rawConversationEntries = [],
    timelineImages = [],
    userMessage = '',
    userAttachments = [],
    conversationBudgetChars = 50000
  } = opts;

  const content = [];

  // 1. Present moment images (high fidelity)
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
  if (presentMomentImages.pov) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: presentMomentImages.pov.mediaType,
        data: presentMomentImages.pov.data
      }
    });
  }

  // 2. Panorama contact sheet
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

  // 3. User attachments
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

  // 4. Present moment text (time, location, mood)
  if (presentMomentText && presentMomentText.trim()) {
    content.push({ type: 'text', text: presentMomentText });
  }

  // 5. Owner image + label
  if (ownerImage) {
    const ownerLabel = ownerName || 'Owner';
    content.push({ type: 'text', text: `${ownerLabel}'s image:` });
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: ownerImage.mediaType,
        data: ownerImage.data
      }
    });
  }

  // 6. Semantic memory
  if (semanticMemoryText && semanticMemoryText.trim()) {
    content.push({ type: 'text', text: semanticMemoryText });
  }

  // 7. Digests (earlier_today)
  if (digestText && digestText.trim()) {
    content.push({
      type: 'text',
      text: '<earlier_today description="Digested summaries of earlier conversations. These are compressed — the original exchanges happened but are summarized here.">\n' + digestText + '\n</earlier_today>'
    });
  }

  // 8. Recent conversation + timeline images (interleaved)
  if (rawConversationEntries.length > 0 || timelineImages.length > 0) {
    const rawBudgetChars = digestText?.trim() ? Math.floor(conversationBudgetChars * 0.7) : conversationBudgetChars;

    content.push({
      type: 'text',
      text: '<recent_history description="Full conversation and visual timeline (last few hours), in chronological order. Most recent exchange is at the end.">'
    });

    const { blocks } = interleaveConversationAndImages(
      rawConversationEntries,
      timelineImages,
      rawBudgetChars
    );
    content.push(...blocks);

    content.push({ type: 'text', text: '</recent_history>' });
  }

  // 9. User message (always last)
  content.push({ type: 'text', text: `[Message]\n${userMessage}` });

  return content;
}

/**
 * Streaming message — async generator yielding text deltas.
 * Uses Anthropic SDK's streaming API with prompt caching.
 *
 * @param {object} db - SQLite database instance
 * @param {string} appPath - Path to the assistant app directory
 * @param {Array} userContent - Content blocks from buildUserContent()
 * @param {object} [opts] - Options
 * @param {function} [opts.onCacheStats] - Callback with cache usage stats
 * @param {string} [opts.model] - Override model (full API ID)
 * @param {string} [opts.agentModel] - Model alias from config ('opus', 'sonnet', 'haiku')
 * @param {number} [opts.maxTokens] - Override max tokens
 * @yields {{ type: 'text_delta', text: string } | { type: 'message_complete', text: string, usage: object }}
 */
async function* streamMessage(db, appPath, userContent, opts = {}) {
  const client = getClient(db);
  if (!client) throw new Error('Anthropic SDK not available');

  const model = opts.model || resolveModel(opts.agentModel, db);
  const maxTokens = opts.maxTokens || DEFAULT_MAX_TOKENS;

  const systemMessage = buildCachedSystemMessage(appPath);

  const stream = client.messages.stream({
    model,
    max_tokens: maxTokens,
    system: systemMessage,
    messages: [{
      role: 'user',
      content: userContent
    }]
  });

  let fullText = '';

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      const text = event.delta.text;
      fullText += text;
      yield { type: 'text_delta', text };
    }
  }

  // Get final message for usage stats
  const finalMessage = await stream.finalMessage();
  const usage = finalMessage.usage || {};

  // Report cache stats
  if (opts.onCacheStats && usage) {
    opts.onCacheStats({
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      cacheCreationInputTokens: usage.cache_creation_input_tokens || 0,
      cacheReadInputTokens: usage.cache_read_input_tokens || 0
    });
  }

  yield {
    type: 'message_complete',
    text: fullText,
    usage
  };
}

/**
 * Non-streaming message — returns complete response.
 * Uses Anthropic SDK with prompt caching.
 *
 * @param {object} db - SQLite database instance
 * @param {string} appPath - Path to the assistant app directory
 * @param {Array} userContent - Content blocks from buildUserContent()
 * @param {object} [opts] - Options
 * @param {string} [opts.model] - Override model (full API ID)
 * @param {string} [opts.agentModel] - Model alias from config ('opus', 'sonnet', 'haiku')
 * @param {number} [opts.maxTokens] - Override max tokens
 * @returns {{ text: string, usage: object }}
 */
async function sendMessage(db, appPath, userContent, opts = {}) {
  const client = getClient(db);
  if (!client) throw new Error('Anthropic SDK not available');

  const model = opts.model || resolveModel(opts.agentModel, db);
  const maxTokens = opts.maxTokens || DEFAULT_MAX_TOKENS;

  const createOpts = {
    model,
    max_tokens: maxTokens,
    messages: [{
      role: 'user',
      content: userContent
    }]
  };

  // Only include system message when an appPath is provided
  // (digest engine and other utility callers pass null)
  if (appPath) {
    createOpts.system = buildCachedSystemMessage(appPath);
  } else if (opts.systemPrompt) {
    createOpts.system = [{ type: 'text', text: opts.systemPrompt }];
  }

  // Stop sequences for early termination (e.g., subconscious TOOL_USE classification)
  if (opts.stopSequences && opts.stopSequences.length > 0) {
    createOpts.stop_sequences = opts.stopSequences;
  }

  const response = await client.messages.create(createOpts);

  const text = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');

  return {
    text,
    usage: response.usage || {}
  };
}

module.exports = {
  isAvailable,
  getClient,
  buildCachedSystemMessage,
  buildUserContent,
  streamMessage,
  sendMessage,
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS
};
