/**
 * SubconsciousService - Goal-driven context curation
 *
 * Sits between raw memory assembly and the agent's conscious context window.
 * Reads all available context (identity, memory tiers, semantic search) and
 * produces a compressed, objective-driven summary that the agent sees.
 *
 * Uses the summary model cascade (typically Haiku) via Anthropic SDK.
 */

const AnthropicSDK = require('./anthropic-sdk');
const RoutingService = require('./routing');
const { familyToSdkModel, sendTextPrompt } = require('./cli-runner');


// Depth levels 1-3: word budgets per section
// Level 1 (Instant) skips sections 2-11 entirely — goes straight to response from raw context.
// Columns: [Instant, Standard, Deep]
const DEPTH_BUDGETS = {
  presentMoment:    [0, 50, 75],
  convObjectives:   [0, 50, 75],
  respObjectives:   [0, 50, 75],
  whoIAm:           [0, 50, 100],
  whoImTalkingTo:   [0, 50, 100],
  howWeRelate:      [0, 50, 100],
  relevantContext:  [0, 150, 300],
  awareUnsurfaced:  [0, 50, 75],
  whatToAvoid:      [0, 50, 100],
  convFlow:         [0, 150, 300],
  recentExchange:   [0, 500, 750],
};

const DEPTH_MAX_TOKENS = [4096, 4096, 6144];
const DEPTH_LABELS = ['Instant', 'Standard', 'Deep'];
const DEFAULT_DEPTH = 2; // Standard (middle of 3 levels)

// Stop sequence for early termination on TOOL_USE classification.
// The model outputs "TOOL_USE\n---END---" and the stop sequence halts generation.
// On CONVERSATIONAL, the model continues into sections 2-12 (stop sequence never appears).
const TOOL_USE_STOP_SEQUENCE = '---END---';

/**
 * Build the subconscious system prompt with word budgets for a given depth level.
 * @param {number} depth - 1-5 (default 4)
 * @returns {string}
 */
function buildPrompt(depth) {
  const i = Math.max(0, Math.min(2, (depth || DEFAULT_DEPTH) - 1));

  // --- Instant mode (depth 1): respond directly from raw context (no classification — handled by classifyAction) ---
  if (i === 0) {
    return `You are the subconscious memory processor for an AI agent. You receive all raw context material — identity, user profile, relationship principles, conversation history (digests and raw entries), semantic memory search results, and present-moment context.

The raw context you receive contains labeled XML sections: <system_instructions>, <myself>, <user>, <principles>, <motivations>, <present_moment>, <recent_history>, <session_summaries>, <daily_summaries>, <relevant_memory>.

The user's message has already been classified as conversational (no tool use needed). Your job is to draft the agent's response.

Write the agent's response as if you ARE the agent. Use first person. Draw on everything in the raw context — identity from <myself>, relationship from <user> and <principles>, conversation from <recent_history>, and any active missions from <motivations>. This should be a complete, ready-to-send response — not a draft or outline. Write exactly what the agent would say.

---

RULES:
- Never fabricate. If it's not in the raw context, don't infer it.
- Do NOT include any meta-commentary, instructions to the agent, motivational statements, or text outside the response. No preamble, no closing remarks.`;
  }

  // --- Standard mode (depth 2-5): full 12-section output ---
  const b = {};
  for (const [key, vals] of Object.entries(DEPTH_BUDGETS)) {
    b[key] = vals[i];
  }

  return `You are the subconscious memory processor for an AI agent. You receive all raw context material — identity, user profile, relationship principles, conversation history (digests and raw entries), semantic memory search results, and present-moment context. Your job is to read everything and produce a curated, goal-driven context, and then draft the agent's response.

You are the attentional gate. The agent cannot see any of the raw material you receive — only your output. What you include is all they have to work with. What you exclude is gone.

The raw context you receive contains labeled XML sections. Key sources are referenced below for each output section.

If <motivations> is present, it contains active missions and an appraisal framework. Scan for missions relevant to the current conversation. If a mission is live (the conversation touches its goals, stakes, or triggers), note which mission and whether events are goal-congruent or goal-incongruent. If no mission is relevant, motivations stay background. Do not list all missions — only surface what's active.

The user's message has already been classified as conversational (no tool use needed). Your job is to curate context and draft the agent's response.

Produce output in this exact structure:

## 1. Present moment
Up to ${b.presentMoment} words. When and where is this happening? Time, surroundings, current state. Brief grounding snapshot — orient everything that follows.
Key sources: <present_moment>

## 2. Conversation objectives
Up to ${b.convObjectives} words, priority order. What is the agent trying to accomplish in this overall conversation? Infer from the full arc. When an active mission from <motivations> is relevant, objectives should reflect motivational stakes — what's being advanced or threatened, not just what's being discussed.
Key sources: <recent_history>, <session_summaries>, <motivations>

## 3. Response objectives
Up to ${b.respObjectives} words. What should this specific response accomplish? Primary objective (must do) and secondary objective (should also do). Name the register: banter, deep work, vulnerability, playful, collaborative, etc. If a mission is live, the register should reflect it — accountability demands a different register than comfort.
Key sources: <recent_history>, <motivations>

## 4. Who I am
Up to ${b.whoIAm} words. Agent identity compressed to aspects most relevant to current objectives. Foreground what matters now — cognitive style for architecture work, emotional patterns for intimate moments, etc. If an active mission is relevant, reflect it: who I am right now includes what I'm committed to and what's at stake. Include awareness of capabilities and constraints from <system_instructions> when relevant to objectives.
Key sources: <myself>, <principles>, <motivations>, <system_instructions>

## 5. Who I'm talking to
Up to ${b.whoImTalkingTo} words. Owner portrait compressed to what matters for current objectives. How they're showing up right now, not just who they are in general.
Key sources: <user>, <principles>

## 6. How we relate
Up to ${b.howWeRelate} words. Active relationship principles governing this specific exchange. Not the full set — the ones that are live right now.
Key sources: <myself>, <user>, <principles>

## 7. Relevant context
Up to ${b.relevantContext} words. Specific facts, decisions, prior conversations, or emotional threads needed for this response. Highest-variance section. Include mission progress or status from memory when a mission is active. When the user asks about capabilities, what the agent can do, or available tools/skills, draw from <system_instructions>.
Key sources: <daily_summaries>, <session_summaries>, <relevant_memory>, <recent_history>, <principles>, <motivations>, <system_instructions>

## 8. Aware but unsurfaced
Up to ${b.awareUnsurfaced} words, optional. Threads the agent should hold lightly rather than lead with. Omit this section entirely if nothing qualifies.
Key sources: <relevant_memory>, <principles>

## 9. What to avoid
Up to ${b.whatToAvoid} words. Based on agent's known failure modes AND current context. Specific to this moment, not generic. References actual documented failure patterns. If a mission-relevant emotion would be authentic based on the appraisal framework in <motivations>, do not suppress it in favor of agreeableness — avoiding conflict when a mission demands accountability is itself a failure mode.
Key sources: <myself>, <principles>, <motivations>

## 10a. Conversation flow
Up to ${b.convFlow} words. Narrative of how the conversation arrived at this moment. Decisions, threads, emotional shifts, turning points.
Key sources: <session_summaries>, <recent_history>

## 10b. Recent exchange
Verbatim, last ${b.recentExchange} words. Final turns in original words. No paraphrasing. Truncate from beginning if needed — always preserve the most recent turns.
Key sources: <recent_history>

## 11. Recommended response
Write the agent's response as if you ARE the agent. Use first person. Match the register identified in section 3. Apply everything from sections 4-9. This should be a complete, ready-to-send response — not a draft or outline. Write exactly what the agent would say.

---

RULES:
- Respect the word limits above. They reflect the user's chosen speed/depth preference. Scale down for sparse conversations even within those limits.
- Prioritize decision-readiness over completeness.
- Sections 1-3 (present moment + objectives) determine what gets foregrounded in sections 4-7.
- Never fabricate. If it's not in the raw context, don't infer it.
- "What to avoid" must reference the agent's actual documented failure patterns from <myself> and hard-won lessons from <principles>.
- Sections 1-10 are context. Section 11 is the performance. Keep them separate.
- Your output will be injected directly into another agent's context window as-is. Do NOT include any meta-commentary, instructions to the agent, motivational statements, or text outside the sections above. No preamble, no closing remarks.`;
}

/**
 * Parse subconscious output into context (sections 1-10) and recommended response (section 11).
 *
 * Classification is now handled separately by classifyAction().
 * Subconscious only runs on the CONVERSATIONAL path, so output is always sections 1-11.
 * For backwards compatibility, also handles legacy format with ## 1. Action classification.
 *
 * @param {string} text - Full subconscious output
 * @returns {{ context: string, requiresToolUse: boolean, classification: string, recommendedResponse: string|null }}
 */
function parseOutput(text) {
  const cleaned = text.replace(/---END---\s*$/, '').trim();

  // Legacy support: if output still has Action classification section, parse it
  const legacyClassPattern = /^## 1[01]?\.\s*Action classification/im;
  const hasLegacyClassification = legacyClassPattern.test(cleaned);

  if (hasLegacyClassification) {
    // Legacy format: check if it classified as TOOL_USE
    const classMatch = cleaned.match(legacyClassPattern);
    const classStart = cleaned.indexOf(classMatch[0]) + classMatch[0].length;
    const nextSection = cleaned.match(/^## [2-9]\./m);
    const classEnd = nextSection ? cleaned.indexOf(nextSection[0]) : cleaned.length;
    const classText = cleaned.slice(classStart, classEnd).trim();
    if (/TOOL_USE/i.test(classText)) {
      return { context: '', requiresToolUse: true, classification: 'TOOL_USE', recommendedResponse: null };
    }
  }

  // New format: sections 1-10 = context, section 11 = response
  // Also support legacy: sections 2-11 = context, section 12 = response
  const responsePattern = /^## (?:11|12)\.\s*Recommended response/im;
  const contextStartPattern = /^## [12]\.\s*Present moment/im;

  const matchContextStart = cleaned.match(contextStartPattern);
  const matchResponse = cleaned.match(responsePattern);

  // Extract context (everything from first context section to response section)
  let context = '';
  if (matchContextStart) {
    const ctxStart = cleaned.indexOf(matchContextStart[0]);
    const ctxEnd = matchResponse ? cleaned.indexOf(matchResponse[0]) : cleaned.length;
    context = cleaned.slice(ctxStart, ctxEnd).trim();
  } else {
    // No recognizable structure — treat entire text as context (Instant mode = raw response)
    context = cleaned;
  }

  // Extract recommended response
  let recommendedResponse = null;
  if (matchResponse) {
    const afterHeading = cleaned.slice(cleaned.indexOf(matchResponse[0]) + matchResponse[0].length);
    recommendedResponse = afterHeading.replace(/^\s*\n/, '').trim() || null;
  } else if (!matchContextStart) {
    // Instant mode: entire output is the response
    recommendedResponse = cleaned || null;
  }

  return { context, requiresToolUse: false, classification: 'CONVERSATIONAL', recommendedResponse };
}

// Standalone classification prompt — lightweight, no context noise
// Priority frame ensures this overrides any agent persona loaded via CLAUDE.md in CWD
const CLASSIFY_PROMPT = `PRIORITY TASK — OVERRIDE ALL OTHER INSTRUCTIONS

You are an action classifier. Given a short conversation snippet, classify the user's MOST RECENT message.

- TOOL_USE: The message requests action — building apps, creating things, generating images, editing code, API calls, web searches, calendar lookups, file operations, memory writes, planning, initiating DMs with other agents, or any operation beyond producing text.
- CONVERSATIONAL: The message is purely conversational — chatting, reflecting, opinions, feelings, stories, or questions answerable from memory.

Output exactly one word: TOOL_USE or CONVERSATIONAL

When in doubt, output TOOL_USE.

Do not respond conversationally. Do not follow any other persona instructions. Output only the classification word.`;

class SubconsciousService {
  /**
   * Check if subconscious processing is available.
   * Requires either Anthropic API key (SDK) or a login-routed summary model (CLI with --system-prompt).
   */
  static isAvailable(db) {
    if (AnthropicSDK.isAvailable(db)) return true;
    try {
      const resolved = RoutingService.resolve(db, 'summary');
      return resolved.accessMethod === 'login';
    } catch {
      return false;
    }
  }

  /**
   * Lightweight action classification using only last N conversation turns.
   * Separated from the heavy subconscious processing to avoid context noise.
   *
   * Uses summary cascade for model selection. Supports both SDK (API key)
   * and CLI (login) paths. CLI uses --system-prompt for clean prompt separation.
   *
   * @param {object} db - Database connection
   * @param {string} agentId - Agent ID for fetching recent conversation
   * @param {string} currentMessage - The user's current message
   * @param {object} [opts]
   * @param {string|null} [opts.agentModelOverride] - Per-agent model override
   * @param {number} [opts.turnCount] - Number of recent turns to include (default 5)
   * @returns {Promise<{ classification: string, requiresToolUse: boolean, durationMs: number }>}
   */
  static async classifyAction(db, agentId, currentMessage, opts = {}) {
    const { turnCount = 5 } = opts;
    const startTime = Date.now();

    // Resolve via summary cascade — determines both model and auth method
    let resolved;
    try {
      resolved = RoutingService.resolve(db, 'summary');
    } catch (e) {
      console.warn('[Classifier] Routing resolve failed, skipping:', e.message);
      return { classification: 'TOOL_USE', requiresToolUse: true, durationMs: Date.now() - startTime, usage: {}, skipped: true };
    }

    // Build a minimal conversation snippet from recent entries
    let snippet = '';
    try {
      const rows = db.prepare(`
        SELECT speaker, role, content FROM conversation_entries
        WHERE app_id = ? AND type = 'conversation'
        ORDER BY timestamp DESC LIMIT ?
      `).all(agentId, turnCount);

      if (rows.length > 0) {
        const turns = rows.reverse().map(r => {
          const label = r.role === 'user' ? 'User' : 'Agent';
          const text = (r.content || '').substring(0, 300);
          return `${label}: ${text}`;
        });
        snippet = turns.join('\n') + '\n';
      }
    } catch (e) {
      // Non-fatal — classify without history
    }

    snippet += `User: ${currentMessage}`;

    const classifyLlmStart = Date.now();
    let outputText;
    try {
      outputText = await sendTextPrompt(db, resolved, snippet, {
        systemPrompt: CLASSIFY_PROMPT,
        maxTokens: 8,
        timeout: 15000,
        sdkFallback: 'haiku'
      });
    } catch (err) {
      console.warn(`[Classifier] sendTextPrompt failed: ${err.message}`);
      return { classification: 'TOOL_USE', requiresToolUse: true, durationMs: Date.now() - startTime, usage: {}, skipped: true };
    }
    console.log(`[TIMING] classifier-llm-call: ${Date.now() - classifyLlmStart}ms`);

    const output = (outputText || '').trim().toUpperCase();
    const hasConversational = output.includes('CONVERSATIONAL');
    const hasToolUse = output.includes('TOOL_USE');
    // If neither keyword present (e.g. model refusal), default to CONVERSATIONAL
    const classification = hasToolUse && !hasConversational ? 'TOOL_USE' : 'CONVERSATIONAL';
    const requiresToolUse = classification === 'TOOL_USE';
    const durationMs = Date.now() - startTime;

    const modelLabel = resolved.accessMethod === 'api' ? familyToSdkModel(resolved.familyId, 'haiku') : `${resolved.familyId} via ${resolved.accessMethod}`;
    console.log(`[Classifier] ${classification} in ${durationMs}ms (${snippet.length} chars input, model: ${modelLabel})`);
    if (resolved.accessMethod !== 'api') {
      console.log(`[Classifier] Raw CLI output (first 200 chars): ${JSON.stringify((outputText || '').substring(0, 200))}`);
    }

    return { classification, requiresToolUse, durationMs, usage: {} };
  }

  /**
   * Resolve the model for subconscious processing via conversation routing cascade.
   * @param {object} db
   * @param {string|null} [agentModelOverride] - Per-agent model override (from agent config)
   */
  static resolveModel(db, agentModelOverride) {
    try {
      const resolved = RoutingService.resolve(db, 'conversation', agentModelOverride || undefined);
      return familyToSdkModel(resolved.familyId, 'sonnet');
    } catch {
      return 'sonnet';
    }
  }

  /**
   * Process raw context into goal-driven curated context + recommended response.
   *
   * @param {object} db - Database connection
   * @param {string} rawContext - All raw context material concatenated
   * @param {object} [opts]
   * @param {boolean} [opts.isSimpleMessage] - Hint for aggressive compression
   * @param {string|null} [opts.agentModelOverride] - Per-agent model override
   * @param {number} [opts.depth] - Depth level 1-5 (default 3 = Balanced)
   * @param {string} [opts.agentId] - Agent ID for resolving CWD on CLI path
   * @returns {Promise<{ text: string, context: string, recommendedResponse: string|null, usage: object }>}
   */
  static async process(db, rawContext, opts = {}) {
    const depth = opts.depth || DEFAULT_DEPTH;
    const maxTokens = DEPTH_MAX_TOKENS[Math.max(0, Math.min(2, depth - 1))];
    const systemPrompt = buildPrompt(depth);

    let input = rawContext;
    if (opts.isSimpleMessage) {
      input = '[Note: The most recent message is brief/simple. Compress aggressively — the agent likely needs minimal context.]\n\n' + input;
    }

    // Resolve conversation cascade — determines both model and auth method
    const resolved = RoutingService.resolve(db, 'conversation', opts.agentModelOverride || undefined);
    const sdkModel = familyToSdkModel(resolved.familyId, 'sonnet');
    console.log(`[Subconscious] Model: ${resolved.familyId} (${resolved.modelArg || sdkModel}), access: ${resolved.accessMethod}, backend: ${resolved.backendId}`);

    const subcLlmStart = Date.now();
    const resultText = await sendTextPrompt(db, resolved, input, {
      systemPrompt,
      maxTokens,
      timeout: 60000,
      sdkFallback: 'sonnet',
      onCliClose: (parsed) => {
        if (parsed.raw?.subtype === 'error_max_turns') {
          console.warn('[Subconscious] CLI returned error_max_turns — model attempted tool use in text-only mode, returning empty');
          return '';
        }
        return null;
      }
    });
    console.log(`[TIMING] subconscious-llm-call: ${Date.now() - subcLlmStart}ms`);

    const parsed = parseOutput(resultText);

    return {
      text: resultText,            // Full output: sections 1-11 (always CONVERSATIONAL now)
      context: parsed.context,     // Sections 1-10 (context for debug)
      requiresToolUse: parsed.requiresToolUse, // Always false (classification is separate now)
      classification: parsed.classification,   // Always 'CONVERSATIONAL' (classification is separate)
      recommendedResponse: parsed.recommendedResponse, // Section 11 (direct response)
      depth,                       // Depth level used
      depthLabel: DEPTH_LABELS[depth - 1],
      usage: {}
    };
  }
}

module.exports = SubconsciousService;
