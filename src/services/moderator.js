/**
 * ModeratorService - Hidden turn-taking moderator for threads
 *
 * Uses the summary routing cascade to decide which agents should speak next.
 * Supports both API (Anthropic SDK) and CLI paths.
 * Used for group threads (3+ participants) and agent-to-agent DMs (no human).
 * User-involved DMs use simple ping-pong (no moderator needed).
 */

const RoutingService = require('./routing');
const AIRegistryService = require('./ai-registry');
const { familyToSdkModel, sendTextPrompt } = require('./cli-runner');

const SYSTEM_PROMPT = 'You are a conversation moderator. Respond ONLY with valid JSON.';

const ModeratorService = {
  /**
   * Decide which agents should speak next in a group thread
   *
   * @param {object} db - SQLite database instance
   * @param {object} thread - Thread record
   * @param {Array} recentMessages - Last ~15 messages
   * @param {Array} agents - Participant agent records
   * @param {object} [options]
   * @returns {Array<{ agentId: string, agentName: string, focusHint: string }>}
   */
  async decideNextSpeakers(db, thread, recentMessages, agents, options = {}) {
    const isFollowUp = options.isFollowUp || false;
    const userName = options.userName || '';
    const agentOnly = options.agentOnly || false;
    const prompt = agentOnly
      ? this._buildAgentOnlyPrompt(thread, recentMessages, agents, isFollowUp)
      : this._buildPrompt(thread, recentMessages, agents, isFollowUp, userName);

    // Walk the summary cascade — retry on timeout/error
    const cascade = RoutingService.getCascade(db, 'summary');

    for (const entry of cascade) {
      if (!entry.enabled) continue;
      if (!RoutingService.isAvailable(db, entry.family_id, entry.access_method)) continue;

      const family = AIRegistryService.getFamily(db, entry.family_id);
      if (!family) continue;

      const resolved = {
        familyId: entry.family_id,
        backendId: family.container_id,
        modelArg: AIRegistryService.resolveModelArg(db, entry.family_id),
        accessMethod: entry.access_method
      };

      try {
        const text = await this._callLLM(db, resolved, prompt);
        return this._parseResponse(text, agents);
      } catch (err) {
        console.warn(`[Moderator] ${resolved.familyId} via ${resolved.accessMethod} failed: ${err.message}, trying next`);
        continue;
      }
    }

    // All cascade entries exhausted
    console.warn('[Moderator] All cascade entries failed');
    return isFollowUp ? [] : this._fallback(recentMessages, agents);
  },

  /**
   * Single LLM call attempt — SDK or CLI path. Returns text or throws.
   */
  async _callLLM(db, resolved, prompt) {
    const text = await sendTextPrompt(db, resolved, prompt, {
      systemPrompt: SYSTEM_PROMPT,
      maxTokens: 300,
      timeout: 15000,
      sdkFallback: 'haiku'
    });
    const label = familyToSdkModel(resolved.familyId, 'haiku');
    console.log(`[Moderator] Response (${label}): ${(text || '').substring(0, 200)}`);
    return text;
  },

  /**
   * Extract the speaking order from the last round of agent responses.
   * A "round" is the most recent contiguous block of agent messages
   * (after the last user message, or from the tail if no user message).
   * Returns agent names in the order they spoke, e.g. ["Alice", "Bob"].
   */
  _getPreviousSpeakingOrder(recentMessages, agents) {
    const agentIds = new Set(agents.map(a => a.id));
    const order = [];

    // Walk backwards from the end to find the last round of agent responses
    for (let i = recentMessages.length - 1; i >= 0; i--) {
      const msg = recentMessages[i];
      if (msg.sender_app_id === 'user' || msg.sender_app_id === 'system') break;
      if (agentIds.has(msg.sender_app_id)) {
        order.unshift(msg.sender_name);
      }
    }
    return order;
  },

  /**
   * Extract names mentioned or addressed in the last message content.
   * Catches patterns like "Alice, ..." or "Alice you ..." (not just @mentions).
   */
  _getNameAddressed(content, agents) {
    if (!content) return [];
    const addressed = [];
    for (const agent of agents) {
      // Match agent name at start of message, after comma, or followed by comma/question
      const namePattern = new RegExp(
        `(?:^|\\b)${agent.name}(?:\\s*[,:]|\\s+you\\b|\\s+can\\b|\\s+what\\b|\\s+do\\b|\\s+tell\\b|\\s+go\\b|\\s+answer\\b)`,
        'i'
      );
      if (namePattern.test(content)) {
        addressed.push(agent.id);
      }
    }
    return addressed;
  },

  /**
   * Build the moderator prompt
   */
  _buildPrompt(thread, recentMessages, agents, isFollowUp = false, userName = '') {
    const userLabel = userName || 'User';

    const participantList = [
      `- ${userLabel} (the human user — NOT a selectable speaker)`,
      ...agents.map(a => `- ${a.name} (id: ${a.id})`)
    ].join('\n');

    const messageHistory = recentMessages.slice(-15).map(m => {
      const label = m.sender_app_id === 'user' ? userLabel : m.sender_name;
      return `${label}: ${m.content.substring(0, 200)}`;
    }).join('\n');

    const lastMessage = recentMessages[recentMessages.length - 1];
    const lastSenderId = lastMessage?.sender_app_id;

    // Check for @mentions in the last message
    const mentionPattern = /@(\w+)/g;
    const mentions = [];
    let match;
    while ((match = mentionPattern.exec(lastMessage?.content || '')) !== null) {
      // Check if @mention targets the user
      if (userName && match[1].toLowerCase() === userName.toLowerCase()) {
        mentions.push('user');
        continue;
      }
      const mentionedAgent = agents.find(a =>
        a.name.toLowerCase() === match[1].toLowerCase() ||
        a.slug?.replace('agent-', '') === match[1].toLowerCase()
      );
      if (mentionedAgent) mentions.push(mentionedAgent.id);
    }

    // Also detect name-addressing (e.g., "Alice, what do you think?")
    const nameAddressed = this._getNameAddressed(lastMessage?.content, agents);
    for (const id of nameAddressed) {
      if (!mentions.includes(id)) mentions.push(id);
    }

    const userMentioned = mentions.includes('user');
    const agentMentions = mentions.filter(m => m !== 'user');

    // Build speaking-order context
    const prevOrder = this._getPreviousSpeakingOrder(recentMessages, agents);
    const orderLine = prevOrder.length > 0
      ? `Previous round speaking order: ${prevOrder.join(' → ')}\n`
      : '';

    return `Group thread: "${thread.name || 'Untitled'}"

Participants:
${participantList}

Recent messages:
${messageHistory}

Last speaker: ${lastSenderId === 'user' ? userLabel : (lastMessage?.sender_name || 'unknown')}
${orderLine}${userMentioned ? `The last message @mentions ${userLabel} (the user).\n` : ''}${agentMentions.length > 0 ? `@mentioned agents: ${agentMentions.join(', ')}\n` : ''}
Rules (priority order):
1. If the last message asks ${userLabel} a direct question → return empty speakers (wait for user)
2. If @mention or name-addressing targets an agent → that agent MUST be included and should speak FIRST
3. Don't select the agent who just spoke (unless @mentioned)
4. Select 0-3 agents. Order them thoughtfully: if a participant was directly addressed, named, or is the clear subject, put them first. Otherwise, vary the speaking order — don't repeat the same order as the previous round
5. Include a brief focus hint per agent (what they should address)
6. If conversation reached a natural conclusion → empty speakers

${userLabel} is the human participant. They cannot be selected as a speaker.

Respond with JSON: {"speakers": [{"agentId": "...", "agentName": "...", "focusHint": "..."}]}
Return empty speakers array if no one should respond.${isFollowUp ? `

IMPORTANT: This is a FOLLOW-UP evaluation — agents have just finished responding.
Only select speakers if an agent's message directly addresses, questions, or requires a response from another agent.
If the conversation is simply waiting for ${userLabel} to speak next, return empty speakers.
Err on the side of returning empty speakers — only continue if there is clear agent-to-agent interaction that would be unnatural to ignore.` : ''}`;
  },

  /**
   * Build prompt for agent-to-agent conversations (no human in the loop).
   * Conservative by default — stops unless there's a clear reason to continue.
   */
  _buildAgentOnlyPrompt(thread, recentMessages, agents, isFollowUp = false) {
    const threadLabel = thread.name ? ` "${thread.name}"` : '';

    const participantList = agents.map(a => `- ${a.name} (id: ${a.id})`).join('\n');

    const messageHistory = recentMessages.slice(-15).map(m => {
      return `${m.sender_name}: ${m.content.substring(0, 200)}`;
    }).join('\n');

    const lastMessage = recentMessages[recentMessages.length - 1];

    // Check for @mentions targeting agents
    const mentionPattern = /@(\w+)/g;
    const agentMentions = [];
    let match;
    while ((match = mentionPattern.exec(lastMessage?.content || '')) !== null) {
      const mentionedAgent = agents.find(a =>
        a.name.toLowerCase() === match[1].toLowerCase() ||
        a.slug?.replace('agent-', '') === match[1].toLowerCase()
      );
      if (mentionedAgent) agentMentions.push(mentionedAgent.id);
    }

    // Also detect name-addressing
    const nameAddressed = this._getNameAddressed(lastMessage?.content, agents);
    for (const id of nameAddressed) {
      if (!agentMentions.includes(id)) agentMentions.push(id);
    }

    // Build speaking-order context
    const prevOrder = this._getPreviousSpeakingOrder(recentMessages, agents);
    const orderLine = prevOrder.length > 0
      ? `Previous round speaking order: ${prevOrder.join(' → ')}\n`
      : '';

    return `Agent-to-agent DM${threadLabel}

Participants:
${participantList}

Recent messages:
${messageHistory}

Last speaker: ${lastMessage?.sender_name || 'unknown'}
${orderLine}${agentMentions.length > 0 ? `@mentioned/addressed agents: ${agentMentions.join(', ')}\n` : ''}
This is an AUTONOMOUS agent-to-agent conversation with NO human moderator.

Rules (priority order):
1. If @mention or name-addressing targets a specific agent → that agent MUST respond
2. Don't select the agent who just spoke (unless @mentioned)
3. If the last message contains a question, asks for input, shares something that invites a reaction, or leaves a topic open → the other agent should respond
4. If the last message is a closing statement, sign-off, thanks, or agreement with no question or open thread → EMPTY speakers
5. When in doubt, return EMPTY speakers

Respond with JSON: {"speakers": [{"agentId": "...", "agentName": "...", "focusHint": "..."}]}
Return empty speakers array if no one should respond.${isFollowUp ? `

IMPORTANT: This is a FOLLOW-UP evaluation after an agent just responded.
Default: return EMPTY speakers (end the exchange).
However, if the last message asks a question or raises something new that clearly invites a reply, the other agent should respond — it would be rude not to.
Conversations should be finite, not open-ended.` : ''}`;
  },

  /**
   * Parse the moderator response
   */
  _parseResponse(text, agents) {
    try {
      // Extract JSON from potential markdown code blocks
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed.speakers)) return [];

      // Validate agent IDs exist
      const validAgentIds = new Set(agents.map(a => a.id));
      return parsed.speakers
        .filter(s => validAgentIds.has(s.agentId))
        .slice(0, 3);
    } catch (err) {
      console.warn('[Moderator] Failed to parse response:', err.message);
      return [];
    }
  },

  /**
   * Fallback: select all participants except the last sender, in shuffled order
   */
  _fallback(recentMessages, agents) {
    const lastMessage = recentMessages[recentMessages.length - 1];
    const lastSenderId = lastMessage?.sender_app_id;

    const speakers = agents
      .filter(a => a.id !== lastSenderId)
      .map(a => ({ agentId: a.id, agentName: a.name, focusHint: '' }));

    // Fisher-Yates shuffle so fallback order isn't always the same
    for (let i = speakers.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [speakers[i], speakers[j]] = [speakers[j], speakers[i]];
    }
    return speakers;
  }
};

module.exports = ModeratorService;
