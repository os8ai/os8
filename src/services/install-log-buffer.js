/**
 * Buffered log relay for the install pipeline (Phase 4 PR 4.1).
 *
 * Adapter onLog callbacks fire on every chunk boundary -- thousands of
 * times per second during `npm install` on a fast disk. A naive 1:1 IPC
 * relay floods the renderer; a debounce-only approach drops bursts. This
 * module batches lines into 200ms windows, splits on `\r?\n`, collapses
 * `\r`-overwriting progress bars (tqdm / pip), and truncates long lines.
 *
 * Pure module: no electron, no fs, no globals. Caller wires the flush
 * sink (publish to SSE in production; collector array in tests).
 *
 * Contract:
 *   const buf = makeLogBuffer({ flushIntervalMs, lineLimit, onFlush });
 *   buf.push('stdout', 'some chunk\n');
 *   buf.push('stderr', 'an error\n');
 *   buf.flushNow();   // emits any pending; cancels pending timer
 */

const DEFAULT_FLUSH_INTERVAL_MS = 200;
const DEFAULT_LINE_LIMIT = 2000;

function nowMs() {
  return Date.now();
}

/**
 * Split a chunk into lines, collapsing `\r`-overwrites.
 *
 * pip / tqdm use carriage returns to overwrite the same terminal line as
 * progress moves: "10% |==        |\r20% |====      |\r...". Without
 * collapse, a 30-second download produces hundreds of stale "10%" "20%"
 * lines in the modal. We keep only the rightmost `\r`-segment per line,
 * giving the user one updating line per progress bar.
 *
 * Returns { lines, residual }:
 *   - lines: complete newline-terminated content (last `\r`-segment kept)
 *   - residual: trailing bytes without a `\n` (held for the next chunk)
 */
function splitLinesWithCarriageReturnCollapse(chunk) {
  const lines = [];
  // Normalize CRLF → LF so the splitter behaves on Windows.
  const normalized = chunk.replace(/\r\n/g, '\n');
  let buffer = '';
  for (const ch of normalized) {
    if (ch === '\n') {
      // Collapse: \r segments on the buffered line. Keep last segment only.
      const segments = buffer.split('\r');
      lines.push(segments[segments.length - 1]);
      buffer = '';
    } else {
      buffer += ch;
    }
  }
  return { lines, residual: buffer };
}

/**
 * Build a buffered log emitter.
 *
 * @param {object} opts
 * @param {number} [opts.flushIntervalMs=200] - max latency from push to onFlush
 * @param {number} [opts.lineLimit=2000] - hard cap per line in bytes
 * @param {(batch: { logs: Array<{stream:string,line:string,ts:number}> }) => void} opts.onFlush
 * @returns {{ push(stream: string, chunk: string): void, flushNow(): void, stop(): void }}
 */
function makeLogBuffer(opts) {
  const flushIntervalMs = opts?.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const lineLimit = opts?.lineLimit ?? DEFAULT_LINE_LIMIT;
  const onFlush = opts?.onFlush;
  if (typeof onFlush !== 'function') {
    throw new Error('makeLogBuffer: onFlush callback is required');
  }

  // Held lines waiting for the next flush.
  let pending = [];
  // Per-stream residual (a chunk may end mid-line; hold the tail until \n).
  const residual = new Map();
  let timer = null;

  function scheduleFlush() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, flushIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function flush() {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    onFlush({ logs: batch });
  }

  function push(stream, chunk) {
    if (chunk == null) return;
    const text = String(chunk);
    if (text.length === 0) return;

    const carry = residual.get(stream) || '';
    const { lines, residual: newResidual } = splitLinesWithCarriageReturnCollapse(carry + text);

    if (lines.length > 0) {
      const ts = nowMs();
      for (const raw of lines) {
        const line = raw.length > lineLimit ? raw.slice(0, lineLimit) : raw;
        pending.push({ stream, line, ts });
      }
      scheduleFlush();
    }

    residual.set(stream, newResidual);
  }

  function flushNow() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    // Emit any stream-tail-without-newline we've been holding so the user sees
    // the trailing prompt or error line instead of losing it on completion.
    for (const [stream, tail] of residual.entries()) {
      if (!tail) continue;
      const line = tail.length > lineLimit ? tail.slice(0, lineLimit) : tail;
      pending.push({ stream, line, ts: nowMs() });
    }
    residual.clear();
    flush();
  }

  function stop() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pending = [];
    residual.clear();
  }

  return { push, flushNow, stop };
}

module.exports = {
  makeLogBuffer,
  splitLinesWithCarriageReturnCollapse,
  DEFAULT_FLUSH_INTERVAL_MS,
  DEFAULT_LINE_LIMIT,
};
