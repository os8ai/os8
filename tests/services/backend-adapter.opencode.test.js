import { describe, it, expect } from 'vitest';

const { BACKENDS, getBackend, getCommand, getInstructionFile } = require('../../src/services/backend-adapter');

describe('BACKENDS.opencode — adapter shape', () => {
  const oc = BACKENDS.opencode;

  it('is registered under id "opencode"', () => {
    expect(oc).toBeDefined();
    expect(oc.id).toBe('opencode');
    expect(getBackend('opencode')).toBe(oc);
  });

  it('uses the "opencode" command and AGENTS.md instruction file', () => {
    expect(oc.command).toBe('opencode');
    expect(oc.instructionFile).toBe('AGENTS.md');
    expect(getCommand('opencode')).toBe('opencode');
    expect(getInstructionFile('opencode')).toBe('AGENTS.md');
  });

  it('declares no native image input (vision turns route to HTTP local)', () => {
    expect(oc.supportsImageInput).toBe(false);
    expect(oc.supportsImageViaFile).toBe(false);
    expect(oc.supportsImageDescriptions).toBe(false);
  });

  it('shares the NON_ANTHROPIC_IDENTITY_PREAMBLE with codex', () => {
    expect(typeof oc.identityPreamble).toBe('string');
    expect(oc.identityPreamble).toBe(BACKENDS.codex.identityPreamble);
    expect(oc.identityPreamble).toContain('{{ASSISTANT_NAME}}');
    expect(oc.identityPreamble).toContain('{{OWNER_NAME}}');
    // Broadened model-name list to cover both codex (GPT) and opencode contexts.
    expect(oc.identityPreamble).toMatch(/Codex.*GPT.*OpenCode/);
  });
});

describe('BACKENDS.opencode — buildArgs', () => {
  const oc = BACKENDS.opencode;

  it('emits the canonical run + json + skip-permissions form by default', () => {
    expect(oc.buildArgs({ model: 'local/aeon-7-gemma-4-26b' })).toEqual([
      'run',
      '--dangerously-skip-permissions',
      '--format', 'json',
      '--model', 'local/aeon-7-gemma-4-26b'
    ]);
  });

  it('omits --dangerously-skip-permissions when skipPermissions=false', () => {
    const args = oc.buildArgs({ skipPermissions: false, model: 'local/x' });
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('omits --format json when streamJson and json are both false', () => {
    const args = oc.buildArgs({ streamJson: false, json: false, model: 'local/x' });
    expect(args).not.toContain('--format');
  });

  it('omits --model when no model arg is passed', () => {
    const args = oc.buildArgs({});
    expect(args).not.toContain('--model');
  });

  it('buildTextOnlyArgs returns [] (utility paths use HTTP, not opencode)', () => {
    expect(oc.buildTextOnlyArgs({})).toEqual([]);
    expect(oc.buildTextOnlyArgs({ model: 'local/x' })).toEqual([]);
  });
});

describe('BACKENDS.opencode — buildPromptArgs', () => {
  const oc = BACKENDS.opencode;

  it('returns the message as a single positional element', () => {
    expect(oc.buildPromptArgs('hello')).toEqual(['hello']);
  });

  it('declares promptViaStdin=false (positional, not stdin)', () => {
    expect(oc.promptViaStdin).toBe(false);
  });
});

describe('BACKENDS.opencode — parseResponse', () => {
  const oc = BACKENDS.opencode;

  it('extracts the last text part from a JSONL stream', () => {
    const out = [
      JSON.stringify({ type: 'step_start', sessionID: 'ses_a', part: { type: 'step-start' } }),
      JSON.stringify({ type: 'tool_use', sessionID: 'ses_a', part: { type: 'tool', tool: 'bash', state: { status: 'completed', output: 'ok' } } }),
      JSON.stringify({ type: 'text', sessionID: 'ses_a', part: { type: 'text', text: 'first text' } }),
      JSON.stringify({ type: 'text', sessionID: 'ses_a', part: { type: 'text', text: 'final text wins' } })
    ].join('\n');

    const result = oc.parseResponse(out);
    expect(result.text).toBe('final text wins');
    expect(result.sessionId).toBe(null);
  });

  it('handles empty/malformed lines gracefully', () => {
    const out = '\n\n{not-json\n' + JSON.stringify({ type: 'text', part: { text: 'survived' } });
    const result = oc.parseResponse(out);
    expect(result.text).toBe('survived');
  });

  it('returns empty text when no text events are present', () => {
    const out = JSON.stringify({ type: 'step_start', part: {} });
    expect(oc.parseResponse(out).text).toBe('');
  });
});

describe('BACKENDS.opencode — parseStreamJsonOutput', () => {
  const oc = BACKENDS.opencode;

  it('returns { result, sessionId, raw } extracted from JSONL stream', () => {
    const out = JSON.stringify({ type: 'text', sessionID: 'ses_a', part: { type: 'text', text: 'hello' } });
    const r = oc.parseStreamJsonOutput(out);
    expect(r.result).toBe('hello');
    expect(r.sessionId).toBe(null);
  });
});

describe('BACKENDS.opencode — prepareEnv', () => {
  const oc = BACKENDS.opencode;

  it('sets OPENCODE_CONFIG_CONTENT when both base_url and model_id env vars are present', () => {
    const env = oc.prepareEnv({
      OS8_OPENCODE_BASE_URL: 'http://localhost:8002/v1',
      OS8_OPENCODE_MODEL_ID: 'aeon-7-gemma-4-26b'
    });
    expect(env.OPENCODE_CONFIG_CONTENT).toBeDefined();
    const cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    expect(cfg.model).toBe('local/aeon-7-gemma-4-26b');
    expect(cfg.provider.local.options.baseURL).toBe('http://localhost:8002/v1');
    expect(cfg.provider.local.options.apiKey).toBe('dummy');
    expect(cfg.provider.local.npm).toBe('@ai-sdk/openai-compatible');
    expect(cfg.provider.local.models['aeon-7-gemma-4-26b']).toBeDefined();
  });

  it('omits OPENCODE_CONFIG_CONTENT when base_url is missing', () => {
    const env = oc.prepareEnv({ OS8_OPENCODE_MODEL_ID: 'm' });
    expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
  });

  it('omits OPENCODE_CONFIG_CONTENT when model_id is missing', () => {
    const env = oc.prepareEnv({ OS8_OPENCODE_BASE_URL: 'http://localhost:8002/v1' });
    expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
  });

  it('strips CLAUDECODE so a parent claude session does not bleed through', () => {
    const env = oc.prepareEnv({ CLAUDECODE: '1', OS8_OPENCODE_BASE_URL: 'x', OS8_OPENCODE_MODEL_ID: 'y' });
    expect(env.CLAUDECODE).toBeUndefined();
  });

  it('prepends ~/.opencode/bin to PATH when HOME is set', () => {
    const env = oc.prepareEnv({ HOME: '/home/leo', PATH: '/usr/bin' });
    expect(env.PATH).toMatch(/^\/home\/leo\/\.opencode\/bin:/);
  });

  it('does not mutate the input env object', () => {
    const baseEnv = { OS8_OPENCODE_BASE_URL: 'x', OS8_OPENCODE_MODEL_ID: 'y' };
    oc.prepareEnv(baseEnv);
    expect(baseEnv.OPENCODE_CONFIG_CONTENT).toBeUndefined();
  });

  it('populates limit:{context,output} on the model entry when both env vars are valid integers', () => {
    const env = oc.prepareEnv({
      OS8_OPENCODE_BASE_URL: 'http://localhost:8002/v1',
      OS8_OPENCODE_MODEL_ID: 'aeon-7-gemma-4-26b',
      OS8_OPENCODE_CONTEXT_LIMIT: '65536',
      OS8_OPENCODE_OUTPUT_RESERVE: '4096'
    });
    const cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    const entry = cfg.provider.local.models['aeon-7-gemma-4-26b'];
    expect(entry.limit).toEqual({ context: 65536, output: 4096 });
  });

  it('omits the limit field when context-limit env vars are absent (opencode falls back to its default)', () => {
    const env = oc.prepareEnv({
      OS8_OPENCODE_BASE_URL: 'http://localhost:8002/v1',
      OS8_OPENCODE_MODEL_ID: 'aeon-7-gemma-4-26b'
    });
    const cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    const entry = cfg.provider.local.models['aeon-7-gemma-4-26b'];
    expect(entry.limit).toBeUndefined();
  });

  it('omits the limit field when context-limit env vars are non-numeric (defensive)', () => {
    const env = oc.prepareEnv({
      OS8_OPENCODE_BASE_URL: 'http://localhost:8002/v1',
      OS8_OPENCODE_MODEL_ID: 'aeon-7-gemma-4-26b',
      OS8_OPENCODE_CONTEXT_LIMIT: 'abc',
      OS8_OPENCODE_OUTPUT_RESERVE: '4096'
    });
    const cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    expect(cfg.provider.local.models['aeon-7-gemma-4-26b'].limit).toBeUndefined();
  });

  it('omits the limit field when only one of the two env vars is present', () => {
    const env = oc.prepareEnv({
      OS8_OPENCODE_BASE_URL: 'http://localhost:8002/v1',
      OS8_OPENCODE_MODEL_ID: 'aeon-7-gemma-4-26b',
      OS8_OPENCODE_CONTEXT_LIMIT: '65536'
      // OS8_OPENCODE_OUTPUT_RESERVE intentionally absent
    });
    const cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    expect(cfg.provider.local.models['aeon-7-gemma-4-26b'].limit).toBeUndefined();
  });
});
