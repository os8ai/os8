import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { makeLogBuffer, splitLinesWithCarriageReturnCollapse } = require('../src/services/install-log-buffer');

describe('splitLinesWithCarriageReturnCollapse', () => {
  it('splits on \\n', () => {
    const r = splitLinesWithCarriageReturnCollapse('a\nb\nc\n');
    expect(r.lines).toEqual(['a', 'b', 'c']);
    expect(r.residual).toBe('');
  });

  it('preserves trailing residual without \\n', () => {
    const r = splitLinesWithCarriageReturnCollapse('a\nb');
    expect(r.lines).toEqual(['a']);
    expect(r.residual).toBe('b');
  });

  it('normalizes CRLF to LF', () => {
    const r = splitLinesWithCarriageReturnCollapse('a\r\nb\r\n');
    expect(r.lines).toEqual(['a', 'b']);
  });

  it('collapses \\r-overwriting progress to last segment per line', () => {
    // Simulates pip download progress: "10%\r20%\r30%\n50%\r100%\n"
    const r = splitLinesWithCarriageReturnCollapse('10%\r20%\r30%\n50%\r100%\n');
    expect(r.lines).toEqual(['30%', '100%']);
  });

  it('handles empty chunk', () => {
    const r = splitLinesWithCarriageReturnCollapse('');
    expect(r.lines).toEqual([]);
    expect(r.residual).toBe('');
  });
});

describe('makeLogBuffer', () => {
  let onFlush;
  beforeEach(() => {
    vi.useFakeTimers();
    onFlush = vi.fn();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes after the configured interval', () => {
    const buf = makeLogBuffer({ flushIntervalMs: 200, onFlush });
    buf.push('stdout', 'a\n');
    expect(onFlush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(199);
    expect(onFlush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0][0].logs).toEqual([
      expect.objectContaining({ stream: 'stdout', line: 'a' }),
    ]);
  });

  it('coalesces 100 synchronous pushes into a single flush', () => {
    const buf = makeLogBuffer({ flushIntervalMs: 200, onFlush });
    for (let i = 0; i < 100; i++) buf.push('stdout', `line ${i}\n`);
    expect(onFlush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0][0].logs).toHaveLength(100);
  });

  it('preserves stream attribution', () => {
    const buf = makeLogBuffer({ flushIntervalMs: 200, onFlush });
    buf.push('stdout', 'out1\n');
    buf.push('stderr', 'err1\n');
    buf.push('stdout', 'out2\n');
    vi.advanceTimersByTime(200);
    const logs = onFlush.mock.calls[0][0].logs;
    expect(logs.map(l => l.stream)).toEqual(['stdout', 'stderr', 'stdout']);
  });

  it('truncates lines longer than lineLimit', () => {
    const buf = makeLogBuffer({ flushIntervalMs: 200, lineLimit: 10, onFlush });
    buf.push('stdout', 'x'.repeat(50) + '\n');
    vi.advanceTimersByTime(200);
    expect(onFlush.mock.calls[0][0].logs[0].line.length).toBe(10);
  });

  it('flushNow drains pending and cancels the timer', () => {
    const buf = makeLogBuffer({ flushIntervalMs: 200, onFlush });
    buf.push('stdout', 'a\n');
    buf.flushNow();
    expect(onFlush).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    // Should not fire again — the timer was cancelled.
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it('flushNow emits trailing residual without a newline', () => {
    const buf = makeLogBuffer({ flushIntervalMs: 200, onFlush });
    buf.push('stdout', 'incomplete'); // no \n
    buf.flushNow();
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0][0].logs).toEqual([
      expect.objectContaining({ stream: 'stdout', line: 'incomplete' }),
    ]);
  });

  it('held residual joins with next chunk', () => {
    const buf = makeLogBuffer({ flushIntervalMs: 200, onFlush });
    buf.push('stdout', 'half ');         // no \n; held
    buf.push('stdout', 'line\n');        // completes "half line"
    vi.advanceTimersByTime(200);
    expect(onFlush.mock.calls[0][0].logs).toEqual([
      expect.objectContaining({ line: 'half line' }),
    ]);
  });

  it('residual is per-stream (stdout chunk does not clobber stderr tail)', () => {
    const buf = makeLogBuffer({ flushIntervalMs: 200, onFlush });
    buf.push('stderr', 'err-half ');
    buf.push('stdout', 'out\n');         // flushes stdout line; stderr tail held
    buf.push('stderr', 'rest\n');
    vi.advanceTimersByTime(200);
    const logs = onFlush.mock.calls[0][0].logs;
    expect(logs.map(l => `${l.stream}:${l.line}`)).toEqual([
      'stdout:out',
      'stderr:err-half rest',
    ]);
  });

  it('throws when onFlush is missing', () => {
    expect(() => makeLogBuffer({})).toThrow(/onFlush/);
  });

  it('stop drops pending and cancels timer', () => {
    const buf = makeLogBuffer({ flushIntervalMs: 200, onFlush });
    buf.push('stdout', 'x\n');
    buf.stop();
    vi.advanceTimersByTime(1000);
    expect(onFlush).not.toHaveBeenCalled();
  });

  it('handles null/undefined chunks gracefully', () => {
    const buf = makeLogBuffer({ flushIntervalMs: 200, onFlush });
    buf.push('stdout', null);
    buf.push('stdout', undefined);
    buf.push('stdout', '');
    vi.advanceTimersByTime(200);
    expect(onFlush).not.toHaveBeenCalled();
  });
});
