import { describe, it, expect } from 'vitest';

const XService = require('../../src/services/x');
const {
  MAX_LIMIT,
  DEFAULT_LIMIT,
  DEFAULT_MAX_TOOL_CALLS,
  MAX_TOOL_CALLS_CEILING,
  XAIKeyMissingError,
} = XService;

// ─── clampLimit ───────────────────────────────────────────

describe('XService.clampLimit', () => {
  it('returns default when input is missing or invalid', () => {
    expect(XService.clampLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(XService.clampLimit(null)).toBe(DEFAULT_LIMIT);
    expect(XService.clampLimit('abc')).toBe(DEFAULT_LIMIT);
    expect(XService.clampLimit(0)).toBe(DEFAULT_LIMIT);
    expect(XService.clampLimit(-5)).toBe(DEFAULT_LIMIT);
  });

  it('passes through valid values', () => {
    expect(XService.clampLimit(3)).toBe(3);
    expect(XService.clampLimit('10')).toBe(10);
  });

  it('hard-caps at MAX_LIMIT', () => {
    expect(XService.clampLimit(1000)).toBe(MAX_LIMIT);
    expect(XService.clampLimit(MAX_LIMIT + 1)).toBe(MAX_LIMIT);
  });
});

// ─── clampMaxToolCalls ───────────────────────────────────

describe('XService.clampMaxToolCalls', () => {
  it('defaults when input missing/invalid', () => {
    expect(XService.clampMaxToolCalls(undefined)).toBe(DEFAULT_MAX_TOOL_CALLS);
    expect(XService.clampMaxToolCalls('abc')).toBe(DEFAULT_MAX_TOOL_CALLS);
    expect(XService.clampMaxToolCalls(0)).toBe(DEFAULT_MAX_TOOL_CALLS);
  });

  it('caps at ceiling', () => {
    expect(XService.clampMaxToolCalls(100)).toBe(MAX_TOOL_CALLS_CEILING);
  });

  it('passes valid values through', () => {
    expect(XService.clampMaxToolCalls(5)).toBe(5);
  });
});

// ─── search() clamps posts[] to limit and forwards maxToolCalls ──

describe('XService.search() post clamping and tool-call cap', () => {
  it('clamps posts[] to the requested limit', async () => {
    const fakeDb = { prepare: () => ({ get: () => ({ value: 'k' }) }) };
    const svc = new XService(fakeDb);

    // Stub fetch to return 10 citations
    const origFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'grok-4.20-reasoning',
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'answer',
                annotations: Array.from({ length: 10 }, (_, i) => ({
                  type: 'url_citation',
                  url: `https://x.com/user${i}/status/${i}`,
                  title: String(i),
                })),
              },
            ],
          },
        ],
      }),
    });

    try {
      const result = await svc.search({ query: 'test', limit: 3 });
      expect(result.posts).toHaveLength(3);
    } finally {
      global.fetch = origFetch;
    }
  });

  it('forwards max_tool_calls in the request body', async () => {
    const fakeDb = { prepare: () => ({ get: () => ({ value: 'k' }) }) };
    const svc = new XService(fakeDb);
    let capturedBody = null;

    const origFetch = global.fetch;
    global.fetch = async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => ({ output: [] }) };
    };

    try {
      await svc.search({ query: 'test', maxToolCalls: 5 });
      expect(capturedBody.max_tool_calls).toBe(5);

      await svc.search({ query: 'test' });
      expect(capturedBody.max_tool_calls).toBe(DEFAULT_MAX_TOOL_CALLS);

      await svc.search({ query: 'test', maxToolCalls: 999 });
      expect(capturedBody.max_tool_calls).toBe(MAX_TOOL_CALLS_CEILING);
    } finally {
      global.fetch = origFetch;
    }
  });
});

// ─── _buildXSearchTool ────────────────────────────────────

describe('XService._buildXSearchTool', () => {
  it('builds a bare tool when no options given', () => {
    const tool = XService._buildXSearchTool();
    expect(tool).toEqual({ type: 'x_search' });
  });

  it('maps allowedHandles → allowed_x_handles (max 10)', () => {
    const handles = Array.from({ length: 15 }, (_, i) => `user${i}`);
    const tool = XService._buildXSearchTool({ allowedHandles: handles });
    expect(tool.allowed_x_handles).toHaveLength(10);
    expect(tool.allowed_x_handles[0]).toBe('user0');
  });

  it('uses excludedHandles when allowedHandles is empty', () => {
    const tool = XService._buildXSearchTool({
      allowedHandles: [],
      excludedHandles: ['spam'],
    });
    expect(tool.allowed_x_handles).toBeUndefined();
    expect(tool.excluded_x_handles).toEqual(['spam']);
  });

  it('prefers allowed over excluded when both supplied (xAI forbids both)', () => {
    const tool = XService._buildXSearchTool({
      allowedHandles: ['keeper'],
      excludedHandles: ['dropper'],
    });
    expect(tool.allowed_x_handles).toEqual(['keeper']);
    expect(tool.excluded_x_handles).toBeUndefined();
  });

  it('passes through date range and media understanding flags', () => {
    const tool = XService._buildXSearchTool({
      fromDate: '2026-04-01',
      toDate: '2026-04-11',
      analyzeImages: true,
      analyzeVideos: true,
    });
    expect(tool.from_date).toBe('2026-04-01');
    expect(tool.to_date).toBe('2026-04-11');
    expect(tool.enable_image_understanding).toBe(true);
    expect(tool.enable_video_understanding).toBe(true);
  });
});

// ─── _windowToFromDate ────────────────────────────────────

describe('XService._windowToFromDate', () => {
  it('returns a YYYY-MM-DD string', () => {
    const result = XService._windowToFromDate('7d');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('maps 24h to ~1 day ago', () => {
    const result = XService._windowToFromDate('24h');
    const now = Date.now();
    const parsed = new Date(result + 'T00:00:00Z').getTime();
    // Should be within ~2 days of now
    expect(now - parsed).toBeLessThan(2 * 24 * 60 * 60 * 1000);
  });

  it('defaults to 7d for unknown windows', () => {
    const a = XService._windowToFromDate('bogus');
    const b = XService._windowToFromDate('7d');
    expect(a).toBe(b);
  });
});

// ─── parseResponse ────────────────────────────────────────

describe('XService.parseResponse', () => {
  it('returns empty shape for null/undefined/garbage', () => {
    const a = XService.parseResponse(null);
    expect(a.answer).toBe('');
    expect(a.posts).toEqual([]);
    expect(a.toolCalls).toEqual([]);

    const b = XService.parseResponse('not an object');
    expect(b.posts).toEqual([]);
  });

  it('extracts answer text from assistant message output', () => {
    const raw = {
      model: 'grok-4.20-reasoning',
      output: [
        {
          type: 'message',
          content: [
            { type: 'output_text', text: 'Hello from X.' },
          ],
        },
      ],
    };
    const parsed = XService.parseResponse(raw);
    expect(parsed.answer).toBe('Hello from X.');
    expect(parsed.model).toBe('grok-4.20-reasoning');
  });

  it('ignores reasoning blocks when building the answer', () => {
    const raw = {
      output: [
        {
          type: 'reasoning',
          content: [{ text: 'Let me think about this...' }],
        },
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'Final answer.' }],
        },
      ],
    };
    const parsed = XService.parseResponse(raw);
    expect(parsed.answer).toBe('Final answer.');
    expect(parsed.answer).not.toContain('think');
  });

  it('captures tool calls with parsed JSON args', () => {
    const raw = {
      output: [
        {
          type: 'custom_tool_call',
          name: 'x_keyword_search',
          input: '{"query":"xAI","limit":"3","mode":"Latest"}',
        },
      ],
    };
    const parsed = XService.parseResponse(raw);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].name).toBe('x_keyword_search');
    expect(parsed.toolCalls[0].args).toEqual({
      query: 'xAI',
      limit: '3',
      mode: 'Latest',
    });
  });

  it('extracts handle from x.com URL when not provided explicitly', () => {
    const raw = {
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: 'See post.',
              annotations: [
                {
                  type: 'url_citation',
                  url: 'https://x.com/xiongmao_ai/status/2042034118670872985',
                  title: '1',
                },
              ],
            },
          ],
        },
      ],
    };
    const parsed = XService.parseResponse(raw);
    expect(parsed.posts).toHaveLength(1);
    expect(parsed.posts[0].handle).toBe('@xiongmao_ai');
    // Numeric "title" field should not leak into `text`.
    expect(parsed.posts[0].text).toBeNull();
  });

  it('ignores non-profile x.com paths when deriving handle', () => {
    const raw = {
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: 'x',
              annotations: [
                { type: 'url_citation', url: 'https://x.com/search?q=xai', title: '1' },
              ],
            },
          ],
        },
      ],
    };
    const parsed = XService.parseResponse(raw);
    expect(parsed.posts[0].handle).toBeNull();
  });

  it('extracts usage info including x_search_calls and cost', () => {
    const raw = {
      model: 'grok-4.20-reasoning',
      output: [],
      usage: {
        input_tokens: 100,
        output_tokens: 200,
        total_tokens: 300,
        output_tokens_details: { reasoning_tokens: 150 },
        cost_in_usd_ticks: 230984000, // 2.30984e-2 USD
        server_side_tool_usage_details: {
          x_search_calls: 2,
          web_search_calls: 0,
        },
      },
    };
    const parsed = XService.parseResponse(raw);
    expect(parsed.usage).toEqual({
      inputTokens: 100,
      outputTokens: 200,
      totalTokens: 300,
      reasoningTokens: 150,
      xSearchCalls: 2,
      webSearchCalls: 0,
      costUsd: 0.0230984,
    });
  });

  it('usage is null when response has no usage block', () => {
    expect(XService.parseResponse({ output: [] }).usage).toBeNull();
  });

  it('extracts posts from annotations', () => {
    const raw = {
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: 'See these posts.',
              annotations: [
                {
                  type: 'url_citation',
                  url: 'https://x.com/vlhadus/status/1',
                  handle: '@vlhadus',
                  text: 'My hope is xAI.',
                  posted_at: '2026-04-10',
                },
              ],
            },
          ],
        },
      ],
    };
    const parsed = XService.parseResponse(raw);
    expect(parsed.posts).toHaveLength(1);
    expect(parsed.posts[0].handle).toBe('@vlhadus');
    expect(parsed.posts[0].url).toBe('https://x.com/vlhadus/status/1');
    expect(parsed.posts[0].text).toBe('My hope is xAI.');
  });

  it('dedupes posts by URL', () => {
    const cite = { url: 'https://x.com/a/1', text: 'dup', handle: '@a' };
    const raw = {
      output: [
        {
          type: 'message',
          content: [
            { type: 'output_text', text: 'x', annotations: [cite, cite] },
          ],
        },
      ],
      citations: [cite],
    };
    const parsed = XService.parseResponse(raw);
    expect(parsed.posts).toHaveLength(1);
  });

  it('falls back to raw.output_text when no message blocks found', () => {
    const raw = { output: [], output_text: 'Direct answer.' };
    const parsed = XService.parseResponse(raw);
    expect(parsed.answer).toBe('Direct answer.');
  });

  it('always returns the raw response for debugging', () => {
    const raw = { weird: 'shape' };
    const parsed = XService.parseResponse(raw);
    expect(parsed.raw).toBe(raw);
  });

  it('tolerates a completely unknown shape without throwing', () => {
    expect(() => XService.parseResponse({ output: [{ nonsense: true }] })).not.toThrow();
    expect(() => XService.parseResponse({ output: 'not-array' })).not.toThrow();
  });
});

// ─── _getApiKey / availability ───────────────────────────

describe('XService key handling', () => {
  const fakeDb = () => ({
    prepare: () => ({
      get: () => null,
      all: () => [],
    }),
  });

  it('throws XAIKeyMissingError when no key is present', () => {
    // Ensure no env var leak
    const saved = process.env.XAI_API_KEY;
    delete process.env.XAI_API_KEY;
    try {
      const svc = new XService(fakeDb());
      expect(() => svc._getApiKey()).toThrow(XAIKeyMissingError);
    } finally {
      if (saved !== undefined) process.env.XAI_API_KEY = saved;
    }
  });

  it('falls back to process.env.XAI_API_KEY when DB has none', () => {
    const saved = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = 'env-fallback-key';
    try {
      const svc = new XService(fakeDb());
      expect(svc._getApiKey()).toBe('env-fallback-key');
    } finally {
      if (saved === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = saved;
    }
  });

  it('isAvailable() reflects key presence', () => {
    const saved = process.env.XAI_API_KEY;
    delete process.env.XAI_API_KEY;
    try {
      expect(XService.isAvailable(fakeDb())).toBe(false);
      process.env.XAI_API_KEY = 'x';
      expect(XService.isAvailable(fakeDb())).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = saved;
    }
  });
});

// ─── search() input validation ───────────────────────────

describe('XService input validation', () => {
  const fakeDb = () => ({ prepare: () => ({ get: () => ({ value: 'fake-key' }) }) });

  it('search() rejects missing query', async () => {
    const svc = new XService(fakeDb());
    await expect(svc.search({})).rejects.toThrow(/query is required/);
  });

  it('userPosts() rejects empty handles', async () => {
    const svc = new XService(fakeDb());
    await expect(svc.userPosts({ handles: [] })).rejects.toThrow(/handles/);
  });

  it('summarizeTopic() rejects missing topic', async () => {
    const svc = new XService(fakeDb());
    await expect(svc.summarizeTopic({})).rejects.toThrow(/topic is required/);
  });
});
