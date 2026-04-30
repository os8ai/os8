/**
 * Shared LLM-call helper for security review services.
 *
 * Spec §6.2.5 + plan §10 decision 1. Both `skill-review.js` (existing) and
 * `app-review.js` (PR 1.6) call `runReview` to dispatch to Anthropic's API
 * with the appropriate model resolved through RoutingService. The system
 * prompt and user message are caller-supplied so the caller's review
 * concerns stay private to that service.
 *
 * Returns parsed JSON. Bad JSON throws `LLMReviewError`; callers apply
 * field defaults / fallbacks per their service's needs.
 */

const AnthropicSDK = require('./anthropic-sdk');
const AIRegistryService = require('./ai-registry');
const RoutingService = require('./routing');

class LLMReviewError extends Error {
  constructor(msg) { super(msg); this.name = 'LLMReviewError'; }
}

const Shared = {
  /**
   * @param {object} db
   * @param {object} opts
   * @param {string} opts.systemPrompt
   * @param {string} opts.userMessage
   * @param {number} [opts.maxTokens=4096]
   * @param {string} [opts.routingTask='planning']
   * @returns {Promise<object>} parsed JSON from the model
   */
  async runReview(db, { systemPrompt, userMessage, maxTokens = 4096, routingTask = 'planning' }) {
    const client = AnthropicSDK.getClient(db);
    if (!client) throw new LLMReviewError('Anthropic API key not configured');

    const claudeModels = AIRegistryService.getClaudeModelMap(db);
    const resolved = RoutingService.resolve(db, routingTask);
    const model = claudeModels[resolved.modelArg]
               || claudeModels['sonnet']
               || 'claude-sonnet-4-5-20250929';

    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    return Shared.parseStructuredResponse(text);
  },

  /**
   * Parse an LLM response that's expected to be JSON. Strips fenced code
   * blocks if present, then attempts JSON.parse on the body.
   */
  parseStructuredResponse(text) {
    // Prefer a fenced ```json``` block when present; otherwise treat the
    // whole response as JSON.
    const m = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
    let body = (m ? m[1] : text).trim();

    // Some models return prose before the JSON; greedy match a {...} block
    // as a last resort.
    if (!m) {
      const objMatch = body.match(/\{[\s\S]*\}/);
      if (objMatch) body = objMatch[0];
    }

    try {
      return JSON.parse(body);
    } catch (e) {
      throw new LLMReviewError(
        `model returned non-JSON: ${e.message}; body=${body.slice(0, 200)}`
      );
    }
  },
};

module.exports = { Shared, LLMReviewError };
