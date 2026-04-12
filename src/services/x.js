/**
 * XService — Search X (Twitter) via the xAI Grok API.
 *
 * Uses the xAI Responses API (POST /v1/responses) with the built-in
 * `x_search` tool. Auth uses the same XAI_API_KEY that OS8 already
 * stores for Grok chat/imagegen.
 *
 * Docs: https://docs.x.ai/developers/tools/x-search
 *
 * This is a search-plus-LLM-synthesis flow: Grok decides when to call
 * x_keyword_search / x_semantic_search under the hood, and returns a
 * final answer plus citations. We parse both into a normalized shape.
 */

const EnvService = require('./env');

const XAI_RESPONSES_URL = 'https://api.x.ai/v1/responses';
const DEFAULT_MODEL = 'grok-4.20-reasoning';

// Hard cap to keep tool-call costs bounded. xAI bills per tool invocation,
// so we clamp `limit` rather than letting agents ask for thousands of posts.
const MAX_LIMIT = 25;
const DEFAULT_LIMIT = 5;

// Cap we pass as xAI's `max_tool_calls`. Note: in practice xAI only applies
// this to user-defined function tools, NOT server-side tools like x_search,
// so Grok can and often does make 5–8 internal searches for a single query.
// We set it anyway in case xAI starts honoring it for built-in tools. The
// real cost visibility comes from `usage.xSearchCalls` and `usage.costUsd`
// in the parsed response — agents should check those rather than trusting
// this cap as a hard guarantee.
const DEFAULT_MAX_TOOL_CALLS = 3;
const MAX_TOOL_CALLS_CEILING = 10;

class XAIKeyMissingError extends Error {
  constructor() {
    super('XAI_API_KEY not configured. Add a Grok API key in Settings → API Keys.');
    this.code = 'XAI_KEY_MISSING';
  }
}

class XService {
  /**
   * @param {import('better-sqlite3').Database} db
   */
  constructor(db) {
    this.db = db;
  }

  _getApiKey() {
    const record = EnvService.get(this.db, 'XAI_API_KEY');
    const key = record?.value || process.env.XAI_API_KEY;
    if (!key) throw new XAIKeyMissingError();
    return key;
  }

  static clampLimit(n) {
    const parsed = Number.parseInt(n, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
    return Math.min(parsed, MAX_LIMIT);
  }

  static clampMaxToolCalls(n) {
    const parsed = Number.parseInt(n, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_TOOL_CALLS;
    return Math.min(parsed, MAX_TOOL_CALLS_CEILING);
  }

  /**
   * Build the xAI tool descriptor from caller options.
   * Keeps the xAI schema isolated so routes can pass friendly camelCase.
   */
  static _buildXSearchTool({
    allowedHandles,
    excludedHandles,
    fromDate,
    toDate,
    analyzeImages,
    analyzeVideos,
  } = {}) {
    const tool = { type: 'x_search' };

    // xAI forbids setting both allow and exclude in the same request.
    if (Array.isArray(allowedHandles) && allowedHandles.length) {
      tool.allowed_x_handles = allowedHandles.slice(0, 10).map(String);
    } else if (Array.isArray(excludedHandles) && excludedHandles.length) {
      tool.excluded_x_handles = excludedHandles.slice(0, 10).map(String);
    }

    if (fromDate) tool.from_date = String(fromDate);
    if (toDate) tool.to_date = String(toDate);
    if (analyzeImages) tool.enable_image_understanding = true;
    if (analyzeVideos) tool.enable_video_understanding = true;

    return tool;
  }

  /**
   * Low-level: POST to xAI Responses API with an x_search tool attached.
   * Returns raw xAI response object.
   */
  async _callResponsesApi({ prompt, tool, model = DEFAULT_MODEL, maxToolCalls, signal }) {
    const apiKey = this._getApiKey();

    const body = {
      model,
      input: [{ role: 'user', content: prompt }],
      tools: [tool],
      max_tool_calls: XService.clampMaxToolCalls(maxToolCalls),
    };

    let res;
    try {
      res = await fetch(XAI_RESPONSES_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw new Error(`xAI request failed: ${err.message}`);
    }

    if (!res.ok) {
      let detail = '';
      try { detail = await res.text(); } catch {}
      throw new Error(`xAI ${res.status}: ${detail.slice(0, 400) || res.statusText}`);
    }

    try {
      return await res.json();
    } catch (err) {
      throw new Error(`xAI returned unparseable JSON: ${err.message}`);
    }
  }

  /**
   * Tolerant parser for xAI Responses API output.
   *
   * The shape is new and xAI iterates on it frequently. We defensively
   * walk `output[]` and collect:
   *   - Final synthesized text (from any assistant message / output_text item)
   *   - Citations (from any nested `annotations` or `citations` arrays)
   *   - Tool-call summaries (names + args) so callers can see what happened
   *
   * If the shape changes in a breaking way, we still return `raw` so the
   * caller isn't left empty-handed.
   */
  static parseResponse(raw) {
    const result = {
      answer: '',
      posts: [],
      toolCalls: [],
      model: raw?.model || null,
      usage: XService._extractUsage(raw),
      raw,
    };

    if (!raw || typeof raw !== 'object') return result;

    const output = Array.isArray(raw.output) ? raw.output : [];
    const answerParts = [];
    const seenUrls = new Set();

    // Extract @handle from an x.com / twitter.com URL (e.g. https://x.com/elonmusk/status/123).
    const handleFromUrl = (url) => {
      if (!url || typeof url !== 'string') return null;
      const m = url.match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([^/?#]+)/i);
      if (!m) return null;
      const h = m[1];
      // Filter out non-profile paths
      if (['i', 'home', 'search', 'explore', 'notifications', 'messages'].includes(h.toLowerCase())) return null;
      return '@' + h;
    };

    const pushPost = (c) => {
      if (!c || typeof c !== 'object') return;
      const url = c.url || c.citation_url || c.source_url || null;
      const handle = c.handle || c.author || c.username || c.x_handle || handleFromUrl(url);
      // xAI url_citations use `title` as a numeric index (e.g. "1"), not post text —
      // prefer explicit text fields and ignore a title that's just a number.
      const rawText = c.text || c.snippet || null;
      const title = typeof c.title === 'string' && !/^\d+$/.test(c.title) ? c.title : null;
      const text = rawText || title;
      const postedAt = c.posted_at || c.date || c.timestamp || null;
      if (!url && !handle && !text) return;
      const dedupeKey = url || `${handle}::${(text || '').slice(0, 80)}`;
      if (seenUrls.has(dedupeKey)) return;
      seenUrls.add(dedupeKey);
      result.posts.push({ handle, url, text, postedAt });
    };

    const walkAnnotations = (arr) => {
      if (!Array.isArray(arr)) return;
      for (const a of arr) {
        if (!a || typeof a !== 'object') continue;
        // Common shapes: {type:'url_citation', url, title}, {type:'x_citation', handle, text}
        pushPost(a);
      }
    };

    for (const item of output) {
      if (!item || typeof item !== 'object') continue;

      // Tool invocations — capture for visibility.
      if (item.type === 'custom_tool_call' || item.type === 'tool_call') {
        let args = item.input;
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch {}
        }
        result.toolCalls.push({
          name: item.name || (item.function && item.function.name) || 'unknown',
          args: args ?? null,
        });
        continue;
      }

      // Assistant messages / output blocks — both 4.x and Responses-style shapes.
      const content = Array.isArray(item.content) ? item.content : [];
      for (const c of content) {
        if (!c || typeof c !== 'object') continue;

        // Collect text. We want the user-facing answer, not reasoning scratchpad.
        if (typeof c.text === 'string' && item.type !== 'reasoning') {
          answerParts.push(c.text);
        } else if (typeof c.output_text === 'string') {
          answerParts.push(c.output_text);
        }

        // Citations can live on either the content entry or its annotations.
        walkAnnotations(c.annotations);
        walkAnnotations(c.citations);
      }

      // Top-level citations on some item variants.
      walkAnnotations(item.annotations);
      walkAnnotations(item.citations);
    }

    // Some responses put citations at the top level of the response.
    walkAnnotations(raw.citations);
    walkAnnotations(raw.annotations);

    // Fallback: if we still have no answer text, use raw.output_text (some variants).
    if (!answerParts.length && typeof raw.output_text === 'string') {
      answerParts.push(raw.output_text);
    }

    result.answer = answerParts.join('\n').trim();
    return result;
  }

  // ─── Public methods ────────────────────────────────────────────

  /**
   * General-purpose X search. Agents should use this for almost everything.
   *
   * @param {object} opts
   * @param {string} opts.query                Natural-language query or keywords
   * @param {string[]} [opts.allowedHandles]   Restrict to these handles (max 10)
   * @param {string[]} [opts.excludedHandles]  Exclude these handles (max 10)
   * @param {string} [opts.fromDate]           ISO date "YYYY-MM-DD"
   * @param {string} [opts.toDate]             ISO date "YYYY-MM-DD"
   * @param {number} [opts.limit]              Max posts to request (clamped to 25)
   * @param {boolean} [opts.analyzeImages]     Enable image understanding
   * @param {boolean} [opts.analyzeVideos]     Enable video understanding
   * @param {string} [opts.model]              Override model
   */
  async search(opts = {}) {
    const { query } = opts;
    if (!query || typeof query !== 'string') {
      throw new Error('query is required');
    }

    const limit = XService.clampLimit(opts.limit);
    const tool = XService._buildXSearchTool(opts);

    // We bake the limit into the prompt rather than the tool spec because
    // xAI's x_search tool doesn't expose a `limit` param — Grok decides
    // internally how many posts to fetch. Making it explicit keeps costs
    // predictable.
    const prompt = [
      `Search X (Twitter) for: ${query}`,
      `Return at most ${limit} posts.`,
      `For each post include: the author handle (with @), the post text, the post URL, and the posted date if known.`,
      `If you cannot find relevant posts, say so clearly — do not fabricate.`,
    ].join('\n');

    const raw = await this._callResponsesApi({
      prompt,
      tool,
      model: opts.model,
      maxToolCalls: opts.maxToolCalls,
    });
    const parsed = XService.parseResponse(raw);
    // Clamp supporting citations to the requested limit. The `answer` field is
    // already bounded by the prompt; `posts[]` is just the dedup'd citation set.
    if (parsed.posts.length > limit) {
      parsed.posts = parsed.posts.slice(0, limit);
    }
    return parsed;
  }

  /**
   * Recent posts from one or more specific handles.
   * Convenience wrapper over search() using allowed_x_handles.
   */
  async userPosts(opts = {}) {
    const { handles, topic } = opts;
    if (!Array.isArray(handles) || !handles.length) {
      throw new Error('handles array is required');
    }
    const limit = XService.clampLimit(opts.limit);
    const handleList = handles.map((h) => (h.startsWith('@') ? h : `@${h}`)).join(', ');
    const topicClause = topic ? ` about "${topic}"` : '';

    return this.search({
      query: `Recent posts from ${handleList}${topicClause}`,
      allowedHandles: handles.map((h) => h.replace(/^@/, '')),
      fromDate: opts.fromDate,
      toDate: opts.toDate,
      limit,
      analyzeImages: opts.analyzeImages,
      analyzeVideos: opts.analyzeVideos,
      model: opts.model,
      maxToolCalls: opts.maxToolCalls,
    });
  }

  /**
   * "What is X saying about Y right now?" — synthesis-focused.
   * Returns a summary paragraph plus supporting post citations.
   */
  async summarizeTopic(opts = {}) {
    const { topic } = opts;
    if (!topic || typeof topic !== 'string') {
      throw new Error('topic is required');
    }
    const window = opts.window || '7d';
    const stance = opts.stance || 'neutral';
    const limit = XService.clampLimit(opts.limit);

    const fromDate = opts.fromDate || XService._windowToFromDate(window);
    const stanceClause = {
      neutral: 'Give a balanced summary of what people are saying.',
      pro: 'Focus on positive / supportive takes.',
      critical: 'Focus on critical / skeptical takes.',
    }[stance] || 'Give a balanced summary of what people are saying.';

    const query = [
      `Summarize recent X discussion about "${topic}".`,
      stanceClause,
      `Ground the summary in at most ${limit} representative posts and cite each one with @handle and URL.`,
    ].join(' ');

    return this.search({
      query,
      fromDate,
      toDate: opts.toDate,
      limit,
      model: opts.model,
      maxToolCalls: opts.maxToolCalls,
    });
  }

  /**
   * Extract usage/cost info from the xAI response.
   * Exposes token counts and (crucially) x_search_calls so callers can
   * see exactly how many billable search invocations happened.
   */
  static _extractUsage(raw) {
    const u = raw?.usage;
    if (!u || typeof u !== 'object') return null;
    const tools = u.server_side_tool_usage_details || {};
    // cost_in_usd_ticks is in 1e-10 USD units (billionths) — convert to dollars.
    const ticks = typeof u.cost_in_usd_ticks === 'number' ? u.cost_in_usd_ticks : null;
    return {
      inputTokens: u.input_tokens ?? null,
      outputTokens: u.output_tokens ?? null,
      totalTokens: u.total_tokens ?? null,
      reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? null,
      xSearchCalls: tools.x_search_calls ?? 0,
      webSearchCalls: tools.web_search_calls ?? 0,
      costUsd: ticks != null ? ticks / 1e10 : null,
    };
  }

  /**
   * Convert a friendly window string to a from_date.
   */
  static _windowToFromDate(window) {
    const now = new Date();
    const days = {
      '24h': 1, '1d': 1, '3d': 3, '7d': 7, '1w': 7, '30d': 30, '1m': 30,
    }[window] ?? 7;
    const d = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
  }

  /**
   * Availability check — does this instance have a usable key?
   */
  static isAvailable(db) {
    try {
      const record = EnvService.get(db, 'XAI_API_KEY');
      return !!(record?.value || process.env.XAI_API_KEY);
    } catch {
      return false;
    }
  }
}

module.exports = XService;
module.exports.XService = XService;
module.exports.XAIKeyMissingError = XAIKeyMissingError;
module.exports.MAX_LIMIT = MAX_LIMIT;
module.exports.DEFAULT_LIMIT = DEFAULT_LIMIT;
module.exports.DEFAULT_MAX_TOOL_CALLS = DEFAULT_MAX_TOOL_CALLS;
module.exports.MAX_TOOL_CALLS_CEILING = MAX_TOOL_CALLS_CEILING;
