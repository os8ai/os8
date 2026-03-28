import { describe, it, expect } from 'vitest';

const { CapabilityService } = require('../../src/services/capability');
const CapabilitySyncService = require('../../src/services/capability-sync');

// ─── parseSkillMd ──────────────────────────────────────

describe('CapabilitySyncService.parseSkillMd', () => {
  it('parses inline JSON metadata (clawaifu style)', () => {
    const content = `---
name: clawaifu - OpenClaw Waifu
description: Your AI waifu companion
homepage: https://github.com/swancho/clawaifu
metadata: {"openclaw":{"requires":{"env":["FAL_KEY","BOT_TOKEN","TELEGRAM_CHAT_ID"]},"primaryEnv":"FAL_KEY"}}
---
# Body here`;

    const { frontmatter: fm } = CapabilitySyncService.parseSkillMd(content);
    expect(fm.name).toBe('clawaifu - OpenClaw Waifu');
    expect(fm.homepage).toBe('https://github.com/swancho/clawaifu');
    expect(fm.metadata.openclaw.requires.env).toEqual(['FAL_KEY', 'BOT_TOKEN', 'TELEGRAM_CHAT_ID']);
    expect(fm.metadata.openclaw.primaryEnv).toBe('FAL_KEY');
  });

  it('parses inline JSON metadata (clawdbot bins style)', () => {
    const content = `---
name: yahoo-finance
description: Stock data
metadata: {"clawdbot":{"requires":{"bins":["jq","yf"]}}}
---
# Body`;

    const { frontmatter: fm } = CapabilitySyncService.parseSkillMd(content);
    expect(fm.metadata.clawdbot.requires.bins).toEqual(['jq', 'yf']);
  });

  it('parses nested YAML metadata (todoist style)', () => {
    const content = `---
name: todoist
description: Manage tasks
metadata:
  clawdbot:
    emoji: "✅"
    requires:
      bins: ["todoist"]
      env: ["TODOIST_API_TOKEN"]
---
# Body`;

    const { frontmatter: fm } = CapabilitySyncService.parseSkillMd(content);
    expect(fm.metadata.clawdbot.requires.bins).toEqual(['todoist']);
    expect(fm.metadata.clawdbot.requires.env).toEqual(['TODOIST_API_TOKEN']);
  });

  it('parses openclaw with os array and user-invocable', () => {
    const content = `---
name: daily-briefing
description: Daily briefing
metadata: {"openclaw":{"requires":{"os":["darwin"],"bins":["curl","bash"]}}}
user-invocable: true
---
# Body`;

    const { frontmatter: fm } = CapabilitySyncService.parseSkillMd(content);
    expect(fm.metadata.openclaw.requires.os).toEqual(['darwin']);
    expect(fm.metadata.openclaw.requires.bins).toEqual(['curl', 'bash']);
    expect(fm['user-invocable']).toBe('true');
  });

  it('parses nested YAML openclaw with bins (frontend-design style)', () => {
    const content = `---
name: frontend-design-ultimate
description: Create static sites
homepage: https://github.com/example
metadata:
  openclaw:
    emoji: "🎨"
    requires:
      bins: ["node", "npm"]
---
# Body`;

    const { frontmatter: fm } = CapabilitySyncService.parseSkillMd(content);
    expect(fm.metadata.openclaw.requires.bins).toEqual(['node', 'npm']);
    expect(fm.metadata.openclaw.emoji).toBe('🎨');
    expect(fm.homepage).toBe('https://github.com/example');
  });

  it('preserves body content', () => {
    const content = `---
name: test
description: desc
---
# Title

Some body content here.`;

    const { body } = CapabilitySyncService.parseSkillMd(content);
    expect(body).toContain('# Title');
    expect(body).toContain('Some body content here.');
  });
});

// ─── _mergeEnvRequired ─────────────────────────────────

describe('CapabilitySyncService._mergeEnvRequired', () => {
  it('returns null when all sources are empty', () => {
    expect(CapabilitySyncService._mergeEnvRequired(null, null, null)).toBeNull();
  });

  it('handles os8.env string', () => {
    expect(CapabilitySyncService._mergeEnvRequired('API_KEY', null, null)).toBe('API_KEY');
  });

  it('handles openclaw env array', () => {
    const result = CapabilitySyncService._mergeEnvRequired(null, ['KEY_A', 'KEY_B'], null);
    expect(result).toBe('KEY_A,KEY_B');
  });

  it('handles clawdbot env array', () => {
    const result = CapabilitySyncService._mergeEnvRequired(null, null, ['CB_KEY']);
    expect(result).toBe('CB_KEY');
  });

  it('merges and deduplicates across all three sources', () => {
    const result = CapabilitySyncService._mergeEnvRequired(
      'SHARED_KEY,UNIQUE_A',
      ['SHARED_KEY', 'UNIQUE_B'],
      ['UNIQUE_C']
    );
    const keys = result.split(',');
    expect(keys).toContain('SHARED_KEY');
    expect(keys).toContain('UNIQUE_A');
    expect(keys).toContain('UNIQUE_B');
    expect(keys).toContain('UNIQUE_C');
    expect(keys.length).toBe(4); // no duplicates
  });

  it('handles comma-separated string from os8.env', () => {
    const result = CapabilitySyncService._mergeEnvRequired('KEY_1,KEY_2', null, null);
    const keys = result.split(',');
    expect(keys).toContain('KEY_1');
    expect(keys).toContain('KEY_2');
  });

  it('trims whitespace', () => {
    const result = CapabilitySyncService._mergeEnvRequired(' KEY_1 , KEY_2 ', null, null);
    const keys = result.split(',');
    expect(keys).toContain('KEY_1');
    expect(keys).toContain('KEY_2');
  });
});

// ─── _extractBinsRequired ──────────────────────────────

describe('CapabilitySyncService._extractBinsRequired', () => {
  it('returns null when no bins', () => {
    expect(CapabilitySyncService._extractBinsRequired(null, null)).toBeNull();
  });

  it('extracts from openclaw array', () => {
    expect(CapabilitySyncService._extractBinsRequired(['jq', 'yf'], null)).toBe('jq,yf');
  });

  it('extracts from clawdbot array', () => {
    expect(CapabilitySyncService._extractBinsRequired(null, ['curl', 'bash'])).toBe('curl,bash');
  });

  it('merges and deduplicates openclaw and clawdbot bins', () => {
    const result = CapabilitySyncService._extractBinsRequired(['node', 'jq'], ['jq', 'curl']);
    const bins = result.split(',');
    expect(bins).toContain('node');
    expect(bins).toContain('jq');
    expect(bins).toContain('curl');
    expect(bins.length).toBe(3); // 'jq' deduped
  });

  it('handles empty arrays', () => {
    expect(CapabilitySyncService._extractBinsRequired([], [])).toBeNull();
  });
});

// ─── _extractOpenClawFields ────────────────────────────

describe('CapabilitySyncService._extractOpenClawFields', () => {
  it('extracts env from openclaw requires', () => {
    const fm = {
      metadata: { openclaw: { requires: { env: ['FAL_KEY'] } } }
    };
    const result = CapabilitySyncService._extractOpenClawFields(fm, {});
    expect(result.envRequired).toBe('FAL_KEY');
  });

  it('extracts bins from clawdbot requires', () => {
    const fm = {
      metadata: { clawdbot: { requires: { bins: ['jq', 'yf'] } } }
    };
    const result = CapabilitySyncService._extractOpenClawFields(fm, {});
    expect(result.binsRequired).toBe('jq,yf');
  });

  it('merges os8.env with openclaw env', () => {
    const fm = {
      metadata: { openclaw: { requires: { env: ['CLOUD_KEY'] } } }
    };
    const meta = { 'os8.env': 'LOCAL_KEY' };
    const result = CapabilitySyncService._extractOpenClawFields(fm, meta);
    const keys = result.envRequired.split(',');
    expect(keys).toContain('LOCAL_KEY');
    expect(keys).toContain('CLOUD_KEY');
  });

  it('extracts homepage from top-level frontmatter', () => {
    const fm = { homepage: 'https://example.com', metadata: {} };
    const result = CapabilitySyncService._extractOpenClawFields(fm, {});
    expect(result.homepage).toBe('https://example.com');
  });

  it('extracts homepage from openclaw metadata', () => {
    const fm = { metadata: { openclaw: { homepage: 'https://oc.example.com' } } };
    const result = CapabilitySyncService._extractOpenClawFields(fm, {});
    expect(result.homepage).toBe('https://oc.example.com');
  });

  it('prefers top-level homepage over openclaw homepage', () => {
    const fm = {
      homepage: 'https://top-level.com',
      metadata: { openclaw: { homepage: 'https://oc.example.com' } }
    };
    const result = CapabilitySyncService._extractOpenClawFields(fm, {});
    expect(result.homepage).toBe('https://top-level.com');
  });

  it('platformOk is true when no os restriction', () => {
    const fm = { metadata: {} };
    const result = CapabilitySyncService._extractOpenClawFields(fm, {});
    expect(result.platformOk).toBe(true);
  });

  it('platformOk is true when current platform is in os array', () => {
    const fm = { metadata: { openclaw: { os: [process.platform] } } };
    const result = CapabilitySyncService._extractOpenClawFields(fm, {});
    expect(result.platformOk).toBe(true);
  });

  it('platformOk is false when current platform is not in os array', () => {
    const fm = { metadata: { openclaw: { os: ['win32-fake-platform'] } } };
    const result = CapabilitySyncService._extractOpenClawFields(fm, {});
    expect(result.platformOk).toBe(false);
  });

  it('platformOk ignores non-array os values', () => {
    const fm = { metadata: { openclaw: { os: 'darwin' } } };
    const result = CapabilitySyncService._extractOpenClawFields(fm, {});
    expect(result.platformOk).toBe(true); // not an array, so no restriction
  });

  it('returns all null/true for empty metadata', () => {
    const fm = { metadata: {} };
    const result = CapabilitySyncService._extractOpenClawFields(fm, {});
    expect(result.envRequired).toBeNull();
    expect(result.binsRequired).toBeNull();
    expect(result.homepage).toBeNull();
    expect(result.platformOk).toBe(true);
  });
});

// ─── End-to-end: parseSkillMd → _extractOpenClawFields ─

describe('parseSkillMd → _extractOpenClawFields integration', () => {
  it('clawaifu: extracts env requirements from inline JSON metadata', () => {
    const content = `---
name: clawaifu
description: Waifu skill
homepage: https://github.com/swancho/clawaifu
metadata: {"openclaw":{"requires":{"env":["FAL_KEY","BOT_TOKEN","TELEGRAM_CHAT_ID"]},"primaryEnv":"FAL_KEY"}}
---
# Body`;

    const { frontmatter: fm } = CapabilitySyncService.parseSkillMd(content);
    const meta = fm.metadata || {};
    const result = CapabilitySyncService._extractOpenClawFields(fm, meta);
    expect(result.envRequired).toContain('FAL_KEY');
    expect(result.envRequired).toContain('BOT_TOKEN');
    expect(result.envRequired).toContain('TELEGRAM_CHAT_ID');
    expect(result.homepage).toBe('https://github.com/swancho/clawaifu');
  });

  it('yahoo-finance: extracts bins from clawdbot JSON metadata', () => {
    const content = `---
name: yahoo-finance
description: Stock data
metadata: {"clawdbot":{"requires":{"bins":["jq","yf"]}}}
---
# Body`;

    const { frontmatter: fm } = CapabilitySyncService.parseSkillMd(content);
    const meta = fm.metadata || {};
    const result = CapabilitySyncService._extractOpenClawFields(fm, meta);
    expect(result.binsRequired).toBe('jq,yf');
  });

  it('todoist: extracts both bins and env from nested YAML clawdbot', () => {
    const content = `---
name: todoist
description: Manage tasks
metadata:
  clawdbot:
    requires:
      bins: ["todoist"]
      env: ["TODOIST_API_TOKEN"]
---
# Body`;

    const { frontmatter: fm } = CapabilitySyncService.parseSkillMd(content);
    const meta = fm.metadata || {};
    const result = CapabilitySyncService._extractOpenClawFields(fm, meta);
    expect(result.binsRequired).toBe('todoist');
    expect(result.envRequired).toBe('TODOIST_API_TOKEN');
  });

  it('daily-briefing: detects wrong platform', () => {
    const wrongPlatform = process.platform === 'darwin' ? 'linux' : 'darwin';
    const content = `---
name: daily-briefing
description: Daily briefing
metadata: {"openclaw":{"requires":{"os":["${wrongPlatform}"],"bins":["curl"]}}}
---
# Body`;

    const { frontmatter: fm } = CapabilitySyncService.parseSkillMd(content);
    const meta = fm.metadata || {};
    const result = CapabilitySyncService._extractOpenClawFields(fm, meta);
    expect(result.platformOk).toBe(false);
    expect(result.binsRequired).toBe('curl');
  });

  it('frontend-design: extracts bins from nested YAML openclaw', () => {
    const content = `---
name: frontend-design-ultimate
description: Create sites
homepage: https://github.com/example
metadata:
  openclaw:
    requires:
      bins: ["node", "npm"]
---
# Body`;

    const { frontmatter: fm } = CapabilitySyncService.parseSkillMd(content);
    const meta = fm.metadata || {};
    const result = CapabilitySyncService._extractOpenClawFields(fm, meta);
    expect(result.binsRequired).toBe('node,npm');
    expect(result.homepage).toBe('https://github.com/example');
  });

  it('video-transcript: handles complex inline JSON with multiple requirement types', () => {
    const content = `---
name: video-transcript
description: Extract transcripts
homepage: https://transcriptapi.com
user-invocable: true
metadata: {"openclaw":{"emoji":"🎬","requires":{"env":["TRANSCRIPT_API_KEY"],"bins":["node"]},"primaryEnv":"TRANSCRIPT_API_KEY"}}
---
# Body`;

    const { frontmatter: fm } = CapabilitySyncService.parseSkillMd(content);
    const meta = fm.metadata || {};
    const result = CapabilitySyncService._extractOpenClawFields(fm, meta);
    expect(result.envRequired).toBe('TRANSCRIPT_API_KEY');
    expect(result.binsRequired).toBe('node');
    expect(result.homepage).toBe('https://transcriptapi.com');
  });

  it('no metadata: returns safe defaults', () => {
    const content = `---
name: simple-skill
description: No metadata
---
# Body`;

    const { frontmatter: fm } = CapabilitySyncService.parseSkillMd(content);
    const meta = fm.metadata || {};
    const result = CapabilitySyncService._extractOpenClawFields(fm, meta);
    expect(result.envRequired).toBeNull();
    expect(result.binsRequired).toBeNull();
    expect(result.homepage).toBeNull();
    expect(result.platformOk).toBe(true);
  });
});
