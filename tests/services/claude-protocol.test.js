import { describe, it, expect } from 'vitest';

const {
  MODES,
  buildArgs,
  parseResponse,
  parseStreamLine
} = require('../../src/services/claude-protocol');

describe('claude-protocol', () => {
  describe('MODES', () => {
    it('should define all execution modes', () => {
      expect(MODES.BATCH).toBe('batch');
      expect(MODES.INTERACTIVE).toBe('interactive');
      expect(MODES.STREAMING).toBe('streaming');
    });
  });

  describe('buildArgs', () => {
    it('should build batch mode args by default', () => {
      const args = buildArgs({ message: 'hello' });

      expect(args).toContain('-p');
      expect(args).toContain('--output-format');
      expect(args).toContain('json');
      expect(args).toContain('hello');
    });

    it('should add --continue for session continuation', () => {
      const args = buildArgs({ message: 'hello', sessionId: 'abc123' });

      expect(args).toContain('--continue');
    });

    it('should add --dangerously-skip-permissions when requested', () => {
      const args = buildArgs({ message: 'hello', skipPermissions: true });

      expect(args).toContain('--dangerously-skip-permissions');
    });

    it('should not add --dangerously-skip-permissions when not requested', () => {
      const args = buildArgs({ message: 'hello', skipPermissions: false });

      expect(args).not.toContain('--dangerously-skip-permissions');
    });

    it('should build streaming mode args', () => {
      const args = buildArgs({ mode: MODES.STREAMING, streamJson: true });

      expect(args).not.toContain('-p');
      expect(args).toContain('--output-format');
      expect(args).toContain('stream-json');
    });

    it('should not include message in streaming mode', () => {
      const args = buildArgs({ mode: MODES.STREAMING, message: 'hello' });

      expect(args).not.toContain('hello');
    });

    it('should place message last in batch mode', () => {
      const args = buildArgs({ message: 'hello', skipPermissions: true });

      expect(args[args.length - 1]).toBe('hello');
    });

    it('should handle empty options', () => {
      const args = buildArgs({});

      expect(args).toContain('-p');
      expect(args).toContain('json');
      expect(args).not.toContain('--continue');
      expect(args).not.toContain('--dangerously-skip-permissions');
    });
  });

  describe('parseResponse', () => {
    it('should parse response with result field', () => {
      const output = JSON.stringify({
        result: 'Hello, I am Claude!',
        session_id: 'session123'
      });

      const parsed = parseResponse(output);

      expect(parsed.text).toBe('Hello, I am Claude!');
      expect(parsed.sessionId).toBe('session123');
      expect(parsed.raw).toBeDefined();
    });

    it('should parse response with content blocks', () => {
      const output = JSON.stringify({
        content: [
          { type: 'text', text: 'First part. ' },
          { type: 'text', text: 'Second part.' }
        ],
        session_id: 'session456'
      });

      const parsed = parseResponse(output);

      expect(parsed.text).toBe('First part. \nSecond part.');
      expect(parsed.sessionId).toBe('session456');
    });

    it('should filter non-text content blocks', () => {
      const output = JSON.stringify({
        content: [
          { type: 'text', text: 'Text content' },
          { type: 'tool_use', name: 'some_tool' },
          { type: 'text', text: 'More text' }
        ]
      });

      const parsed = parseResponse(output);

      expect(parsed.text).toBe('Text content\nMore text');
    });

    it('should handle string response', () => {
      const output = JSON.stringify('Simple string response');

      const parsed = parseResponse(output);

      expect(parsed.text).toBe('Simple string response');
    });

    it('should handle invalid JSON gracefully', () => {
      const output = 'This is not JSON at all';

      const parsed = parseResponse(output);

      expect(parsed.text).toBe('This is not JSON at all');
      expect(parsed.sessionId).toBeNull();
      expect(parsed.raw).toBeNull();
    });

    it('should handle empty response', () => {
      const output = JSON.stringify({});

      const parsed = parseResponse(output);

      expect(parsed.text).toBe('');
    });

    it('should handle response with no session_id', () => {
      const output = JSON.stringify({ result: 'No session' });

      const parsed = parseResponse(output);

      expect(parsed.sessionId).toBeNull();
    });
  });

  describe('parseStreamLine', () => {
    it('should parse valid JSON line', () => {
      const line = JSON.stringify({ type: 'event', data: 'test' });

      const result = parseStreamLine(line);

      expect(result).toEqual({ type: 'event', data: 'test' });
    });

    it('should return null for empty line', () => {
      expect(parseStreamLine('')).toBeNull();
      expect(parseStreamLine('   ')).toBeNull();
    });

    it('should return null for invalid JSON', () => {
      const result = parseStreamLine('not json {{{');

      expect(result).toBeNull();
    });

    it('should parse stream event', () => {
      const line = JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { text: 'Hello' }
        }
      });

      const result = parseStreamLine(line);

      expect(result.type).toBe('stream_event');
      expect(result.event.delta.text).toBe('Hello');
    });

    it('should parse result event', () => {
      const line = JSON.stringify({
        type: 'result',
        result: 'Final answer',
        session_id: 'sess123'
      });

      const result = parseStreamLine(line);

      expect(result.type).toBe('result');
      expect(result.result).toBe('Final answer');
      expect(result.session_id).toBe('sess123');
    });
  });
});
