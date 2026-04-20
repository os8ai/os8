/**
 * Unified CLI spawn + response parsing for all backends (Claude, Gemini, Codex, Grok).
 *
 * Consolidates the duplicated patterns across work-queue.js, message-handler.js,
 * server-telegram.js, app-builder.js, and call-stream.js into shared utilities.
 *
 * Design: callback-based — consumers keep their unique streaming/SSE/TTS logic
 * in callbacks; only env prep, spawn, parsing, and buffer flush are consolidated.
 */

const { spawn } = require('child_process');
const os = require('os');
const pty = require('node-pty');
const { getBackend, stripDisabledApiKeys } = require('./backend-adapter');
const AIRegistryService = require('./ai-registry');
const EnvService = require('./env');
const AnthropicSDK = require('./anthropic-sdk');
const LauncherClient = require('./launcher-client');

/**
 * Prepare the shell environment for a CLI backend.
 * 3-step pattern: merge DB env vars → strip API keys if login auth → backend prepareEnv.
 *
 * @param {object} db - SQLite database
 * @param {string} backendId - 'claude', 'gemini', 'codex', 'grok'
 * @param {string} [accessMethod] - 'login' or 'api'
 * @returns {object} Environment variables ready for spawn
 */
function prepareSpawnEnv(db, backendId, accessMethod) {
  let baseEnv = process.env;
  if (db) {
    baseEnv = { ...process.env, ...EnvService.asObject(db) };
  }
  if (accessMethod === 'login' && db) {
    const apiKeyMap = AIRegistryService.getApiKeyMapForContainers(db);
    baseEnv = stripDisabledApiKeys(baseEnv, backendId, { [backendId]: false }, apiKeyMap);
  }
  return getBackend(backendId).prepareEnv(baseEnv);
}

/**
 * Parse a single JSON line from CLI output and return a structured result.
 * Handles all 4 backend formats:
 *   - Claude: stream_event (content_block_delta) + result
 *   - Gemini: message with delta=true
 *   - Codex: item.completed with agent_message
 *   - Grok: {role:"assistant", content:"..."} (JSONL, replace not append)
 *
 * @param {string} line - A single line of output
 * @returns {{ type: 'delta'|'replace'|'result'|'other', text: string|null, raw: object }|null}
 */
function parseResponseLine(line) {
  if (!line.trim()) return null;
  try {
    const json = JSON.parse(line);

    // Claude: streaming content delta
    if (json.type === 'stream_event' && json.event?.type === 'content_block_delta') {
      return { type: 'delta', text: json.event?.delta?.text || '', raw: json };
    }
    // All backends: final result
    if (json.type === 'result') {
      return { type: 'result', text: json.result || '', raw: json };
    }
    // Gemini: message delta
    if (json.type === 'message' && json.delta && json.role === 'assistant') {
      return { type: 'delta', text: json.content || '', raw: json };
    }
    // Codex: completed agent message
    if (json.type === 'item.completed' && json.item?.type === 'agent_message' && json.item?.text) {
      return { type: 'delta', text: json.item.text, raw: json };
    }
    // Grok: role-based JSONL — replaces fullResponse (each message is complete)
    if (!json.type && json.role === 'assistant' && json.content
        && !json.tool_calls?.length
        && !/^Using tools/i.test(json.content.trim())) {
      return { type: 'replace', text: json.content, raw: json };
    }
    // Recognized JSON but not a content line (e.g. stream_event with other event types)
    return { type: 'other', text: null, raw: json };
  } catch (e) {
    return null; // Not valid JSON
  }
}

/**
 * Parse batch CLI output (non-streaming). Handles single JSON object or JSONL.
 * Used by app-builder and work-queue for non-streaming paths.
 *
 * @param {string} stdout - Complete stdout from CLI process
 * @returns {string} Extracted text response
 */
function parseBatchOutput(stdout) {
  if (!stdout?.trim()) return '';

  // Try single JSON object first (Claude --json, Gemini)
  try {
    const response = JSON.parse(stdout);
    if (response.result) return response.result;
    if (response.response) return response.response;  // Gemini --output-format json
    if (response.content && Array.isArray(response.content)) {
      return response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    }
    if (typeof response === 'string') return response;
  } catch (e) {
    // Not single JSON — fall through to JSONL
  }

  // JSONL line-by-line (Codex, Grok, stream-json output)
  const lines = stdout.split('\n').filter(l => l.trim());
  let result = '';
  let geminiDelta = '';
  for (const line of lines) {
    const parsed = parseResponseLine(line);
    if (!parsed) continue;
    if (parsed.type === 'result') { result = parsed.text; break; }
    if (parsed.type === 'replace') result = parsed.text;
    if (parsed.type === 'delta') {
      // Gemini accumulates deltas; Codex last item wins
      if (parsed.raw?.type === 'message') geminiDelta += parsed.text;
      else result = parsed.text;
    }
  }
  return result || geminiDelta || '';
}

/**
 * Create a CLI process with the correct spawn method (PTY vs child_process.spawn).
 * Returns a unified interface with onData/onExit/kill regardless of spawn method.
 *
 * Decision tree:
 *   - Claude without images → PTY (native terminal support)
 *   - Claude with images → spawn (needs stdin pipe for stream-json)
 *   - Non-Claude → spawn (PTY adds ANSI codes that break JSON parsing)
 *   - forcePipe=true → spawn (caller needs piped stdio regardless of backend)
 *
 * @param {object} backend - Backend definition from getBackend()
 * @param {string[]} args - CLI arguments
 * @param {object} opts
 * @param {string} opts.cwd - Working directory
 * @param {object} opts.env - Environment variables
 * @param {boolean} [opts.useImages] - Whether images are being sent via stdin
 * @param {boolean} [opts.forcePipe] - Force spawn (no PTY) regardless of backend
 * @param {string} [opts.stdinData] - Data to write to stdin before closing
 * @param {boolean} [opts.promptViaStdin] - Backend uses stdin for prompt (Codex)
 * @returns {{ onData: Function, onExit: Function, kill: Function, pid: number }}
 */
function createProcess(backend, args, { cwd, env, useImages, forcePipe, stdinData, promptViaStdin, model, taskType, launcherBackend }) {
  // HTTP backends have no CLI to spawn — route to the launcher HTTP path.
  // The returned object exposes the same { onData, onExit, kill } shape so
  // message-handler.js's stream loop doesn't need to know the difference.
  if (backend.type === 'http') {
    return createHttpProcess(backend, {
      prompt: promptViaStdin || stdinData || '',
      model,
      launcherBackend,
      taskType: taskType || 'conversation'
    });
  }

  const usePty = backend.id === 'claude' && !useImages && !forcePipe;

  if (usePty) {
    const proc = pty.spawn(backend.command, args, {
      name: 'xterm-256color', cols: 120, rows: 30, cwd, env
    });
    return proc; // PTY already has onData/onExit/kill interface
  }

  // spawn path
  const child = spawn(backend.command, args, {
    cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe']
  });

  let stderrBuf = '';
  child.stderr.on('data', d => { stderrBuf += d.toString(); });

  if (stdinData) {
    child.stdin.write(stdinData);
    child.stdin.end();
  } else if (!promptViaStdin) {
    // End stdin immediately unless caller will write to it
    child.stdin.end();
  }

  return {
    onData: (cb) => {
      child.stdout.on('data', d => cb(d.toString()));
      // Include stderr in data stream when using images (matches existing behavior)
      if (useImages) {
        child.stderr.on('data', d => cb(d.toString()));
      }
    },
    onExit: (cb) => {
      child.on('close', exitCode => cb({ exitCode, stderr: stderrBuf }));
    },
    kill: () => child.kill(),
    pid: child.pid,
    // Expose stdin for callers that need to write prompt separately (Codex)
    stdin: child.stdin
  };
}

/**
 * Create a "process" that POSTs to the launcher's OpenAI-compatible endpoint
 * and emits Claude-shape stream-json lines via onData. Returns the same
 * { onData, onExit, kill } interface as createProcess's PTY/spawn paths, so
 * message-handler.js's streaming loop works unchanged.
 *
 * Wire: OpenAI `data: {..choices[0].delta.content..}` chunks →
 *       `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"text":"..."}}}` line
 * On completion:
 *       `{"type":"result","result":"<accumulated>"}` line, then exit code 0.
 *
 * This shape is the lowest-common-denominator that cli-runner's parseResponseLine
 * and message-handler.js both already handle. No translator changes required.
 *
 * @param {object} backend - The local backend definition
 * @param {object} opts
 * @param {string} opts.prompt - Enriched user message (full context already baked in)
 * @param {string} [opts.model] - Model ID to send as OpenAI `model` field
 * @param {string} [opts.taskType='conversation'] - Used to pick the right launcher-reported base_url
 */
function createHttpProcess(backend, { prompt, model, launcherBackend = null, taskType = 'conversation' } = {}) {
  const dataCallbacks = [];
  const exitCallbacks = [];
  let aborted = false;
  let controller = null;

  const emitLine = (obj) => {
    const line = JSON.stringify(obj) + '\n';
    for (const cb of dataCallbacks) {
      try { cb(line); } catch (err) { console.warn('[local-http] onData callback threw:', err.message); }
    }
  };

  const finish = ({ exitCode = 0, stderr = '' } = {}) => {
    for (const cb of exitCallbacks) {
      try { cb({ exitCode, stderr }); } catch (err) { console.warn('[local-http] onExit callback threw:', err.message); }
    }
  };

  // Emit a code-tagged error event just before exit so the SSE consumer
  // (Chat.jsx / agent-panel.js) can branch on the machine code without
  // parsing free-form stderr. The `exitCode: 1` on finish still surfaces
  // the failure via the existing error plumbing; the system_error event
  // carries the richer signal.
  const finishWithError = (code, message) => {
    emitLine({ type: 'system_error', code, message });
    finish({ exitCode: 1, stderr: `${code}: ${message}` });
  };

  // Kick off the request asynchronously. We yield a tick so the caller can
  // attach onData/onExit handlers before any bytes arrive.
  setImmediate(() => { _runHttp().catch((err) => {
    if (aborted) return;
    console.error('[local-http] request failed:', err.message);
    finishWithError('START_FAILED', err.message);
  }); });

  async function _runHttp() {
    // Phase 2: discover base_url via ensureModel so we implicitly start
    // the backend if it isn't running, rather than 404ing. `model` here
    // is the family's cli_model_arg — which equals the launcher's
    // model name (launcher serves /v1/chat/completions with
    // --served-model-name {model_name}). `launcherBackend` comes from
    // ai_model_families.launcher_backend, null for cloud families (but
    // we only get here for HTTP containers, so it should be set).
    let ensureResult;
    try {
      ensureResult = await LauncherClient.ensureModel({
        model,
        backend: launcherBackend,
        wait: false,
      });
    } catch (err) {
      if (aborted) return;
      // LauncherError carries code directly; generic errors fall back.
      const code = err?.code || 'LAUNCHER_UNREACHABLE';
      finishWithError(code, err.message);
      return;
    }

    let baseUrl = ensureResult?.base_url || null;
    const instanceId = ensureResult?.instance_id || null;

    // If the launcher just scheduled a start, poll status until healthy.
    // Bounded by a minute-scale timeout — a real cold start (model load)
    // can take 30–60s; NIM is longer but rare and has its own path.
    if (ensureResult?.status === 'loading' || !baseUrl) {
      emitLine({
        type: 'system_notice',
        code: 'MODEL_LOADING',
        message: `Loading ${model}…`,
        instance_id: instanceId,
      });
      const deadline = Date.now() + 120_000;
      while (!aborted && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 1500));
        let info;
        try {
          info = await LauncherClient.getInstanceStatus(instanceId);
        } catch (_err) {
          // Transient — keep polling, the launcher may be serializing a start.
          continue;
        }
        if (info && info.health === 'healthy') {
          baseUrl = info.base_url || baseUrl;
          break;
        }
      }
      if (aborted) return;
      if (!baseUrl) {
        finishWithError('START_FAILED', `Timed out waiting for ${model} to become healthy.`);
        return;
      }
    }

    const modelId = model || ensureResult?.model_id || ensureResult?.model;

    const body = {
      model: modelId,
      messages: [{ role: 'user', content: prompt }],
      stream: true
    };

    controller = new AbortController();
    let response;
    try {
      response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (err) {
      if (aborted) return;
      finishWithError('START_FAILED', `fetch failed: ${err.message}`);
      return;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      finishWithError('START_FAILED', `${baseUrl} returned ${response.status}: ${text.slice(0, 500)}`);
      return;
    }

    // Emit a minimal system/init so any downstream translator that expects a
    // session_id gets something. We use a pseudo runId since local has no real
    // session concept. Claude's translator tolerates missing session_id when a
    // runId is pre-assigned by the caller.
    emitLine({ type: 'system', subtype: 'init', session_id: `local-${Date.now()}`, model: modelId });

    const decoder = new TextDecoder();
    let buffer = '';
    let accumulated = '';

    try {
      for await (const chunk of response.body) {
        if (aborted) return;
        buffer += decoder.decode(chunk, { stream: true });
        // Parse SSE frames: events end with blank line; each non-empty line
        // starts with "data: ". Multi-line "data: " prefixes concatenate.
        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const dataLines = frame
            .split('\n')
            .map(l => l.trim())
            .filter(l => l.startsWith('data:'))
            .map(l => l.slice(5).trim());
          if (dataLines.length === 0) continue;
          const payload = dataLines.join('');
          if (payload === '[DONE]') {
            // vLLM/OpenAI terminator — ignore here, we finalize on stream close.
            continue;
          }
          let json;
          try {
            json = JSON.parse(payload);
          } catch (err) {
            console.warn(`[local-http] SSE parse skip: ${err.message} — ${payload.slice(0, 120)}`);
            continue;
          }
          const delta = json?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length > 0) {
            accumulated += delta;
            emitLine({
              type: 'stream_event',
              event: { type: 'content_block_delta', delta: { type: 'text_delta', text: delta } }
            });
          }
          const finishReason = json?.choices?.[0]?.finish_reason;
          if (finishReason) {
            // Emit nothing here — the stream will end naturally; we finalize below.
          }
        }
      }
    } catch (err) {
      if (aborted) return;
      finishWithError('START_FAILED', `stream read failed: ${err.message}`);
      return;
    }

    // Flush any trailing bytes (unlikely with OpenAI SSE but defensive).
    if (buffer.trim().startsWith('data:')) {
      const payload = buffer.trim().slice(5).trim();
      if (payload && payload !== '[DONE]') {
        try {
          const json = JSON.parse(payload);
          const delta = json?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length > 0) {
            accumulated += delta;
            emitLine({
              type: 'stream_event',
              event: { type: 'content_block_delta', delta: { type: 'text_delta', text: delta } }
            });
          }
        } catch (_e) {}
      }
    }

    emitLine({ type: 'result', subtype: 'success', result: accumulated });
    finish({ exitCode: 0, stderr: '' });

    // Fire-and-forget LRU touch so the launcher can prefer evicting
    // actually-cold instances. A failing touch is a hint loss, not worth
    // surfacing to the user.
    if (instanceId) {
      LauncherClient.touch(instanceId).catch(() => {});
    }
  }

  return {
    onData: (cb) => { dataCallbacks.push(cb); },
    onExit: (cb) => { exitCallbacks.push(cb); },
    kill: () => {
      aborted = true;
      if (controller) {
        try { controller.abort(); } catch (_e) {}
      }
      finish({ exitCode: 130, stderr: 'killed' });
    },
    pid: null
  };
}

/**
 * Attach a streaming response parser to a process.
 * Handles line buffering, per-line parsing via parseResponseLine(), and buffer flush on exit.
 *
 * Callbacks let each consumer keep its unique logic (SSE, TTS, internal notes, etc.)
 *
 * @param {object} proc - Process with onData/onExit interface
 * @param {object} callbacks
 * @param {Function} [callbacks.onDelta] - (text, raw) Streaming text delta (append)
 * @param {Function} [callbacks.onReplace] - (text, raw) Complete replacement (Grok)
 * @param {Function} [callbacks.onResult] - (fullResponse, raw) Final result received
 * @param {Function} [callbacks.onRaw] - (line, raw) Non-content JSON line
 * @param {Function} [callbacks.onExit] - ({ exitCode, stderr, fullResponse }) Process exited
 */
function attachStreamParser(proc, { onDelta, onReplace, onResult, onRaw, onExit }) {
  let buffer = '';
  let fullResponse = '';

  proc.onData((data) => {
    buffer += data;
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // Keep incomplete last line

    for (const line of lines) {
      const parsed = parseResponseLine(line);
      if (!parsed) { onRaw?.(line, null); continue; }

      if (parsed.type === 'delta') {
        fullResponse += parsed.text;
        onDelta?.(parsed.text, parsed.raw);
      } else if (parsed.type === 'replace') {
        fullResponse = parsed.text;
        onReplace?.(parsed.text, parsed.raw);
      } else if (parsed.type === 'result') {
        fullResponse = parsed.text || fullResponse;
        onResult?.(fullResponse, parsed.raw);
      } else {
        onRaw?.(line, parsed.raw);
      }
    }
  });

  proc.onExit(({ exitCode, stderr }) => {
    // Flush remaining buffer (last line without trailing newline)
    if (buffer.trim()) {
      const parsed = parseResponseLine(buffer);
      if (parsed) {
        if (parsed.type === 'result') fullResponse = parsed.text || fullResponse;
        else if (parsed.type === 'replace') fullResponse = parsed.text;
        else if (parsed.type === 'delta') fullResponse += parsed.text;
      }
      buffer = '';
    }
    onExit?.({ exitCode, stderr, fullResponse });
  });

  // Return accessor for current fullResponse (useful for consumers that need it mid-stream)
  return { getFullResponse: () => fullResponse };
}

/**
 * Map a routing family ID to an Anthropic SDK model alias.
 * Non-Anthropic families return the fallback.
 * @param {string} familyId - e.g. 'claude-opus', 'claude-sonnet', 'gemini-pro'
 * @param {string} [fallback='haiku'] - SDK alias if family is non-Anthropic
 * @returns {string} 'opus', 'sonnet', 'haiku', or the fallback
 */
function familyToSdkModel(familyId, fallback = 'haiku') {
  const MAP = { 'claude-opus': 'opus', 'claude-sonnet': 'sonnet', 'claude-haiku': 'haiku' };
  return MAP[familyId] || fallback;
}

/**
 * Send a text-only prompt through a resolved routing entry.
 * Picks SDK (API key) or CLI (login/non-Anthropic) automatically.
 *
 * @param {object} db - SQLite database
 * @param {object} resolved - From RoutingService.resolve() or manual cascade entry
 *   { familyId, backendId, modelArg, accessMethod }
 * @param {string} prompt - User/content text to send
 * @param {object} [opts]
 * @param {string} [opts.systemPrompt] - System prompt (SDK: passed directly; CLI: prepended to prompt)
 * @param {number} [opts.maxTokens=4096] - Max output tokens
 * @param {number} [opts.timeout=120000] - CLI timeout in ms
 * @param {string} [opts.sdkFallback='haiku'] - SDK model alias if family is non-Anthropic
 * @param {string[]} [opts.stopSequences] - Stop sequences (SDK only)
 * @param {function} [opts.onCliClose] - Custom handler for CLI close: (parsed, code) => string|null
 *     Return text to override default, or null to use default parsing.
 * @returns {Promise<string>} LLM response text
 */
async function sendTextPrompt(db, resolved, prompt, opts = {}) {
  const {
    systemPrompt = null,
    maxTokens = 4096,
    timeout = 120000,
    sdkFallback = 'haiku',
    stopSequences = null,
    onCliClose = null
  } = opts;

  const sdkModel = familyToSdkModel(resolved.familyId, sdkFallback);

  // HTTP path: local launcher-backed backend — no CLI, no SDK, just POST.
  const httpBackend = getBackend(resolved.backendId);
  if (httpBackend?.type === 'http') {
    return sendTextPromptHttp(resolved, prompt, { systemPrompt, maxTokens });
  }

  // SDK path: API access method + Anthropic API key available
  if (resolved.accessMethod === 'api' && AnthropicSDK.isAvailable(db)) {
    const sdkOpts = { agentModel: sdkModel, maxTokens };
    if (systemPrompt) sdkOpts.systemPrompt = systemPrompt;
    if (stopSequences?.length) sdkOpts.stopSequences = stopSequences;
    const result = await AnthropicSDK.sendMessage(db, null, [
      { type: 'text', text: prompt }
    ], sdkOpts);
    return result.text;
  }

  // CLI path
  const backend = getBackend(resolved.backendId);
  if (!backend) throw new Error(`Backend ${resolved.backendId} not found`);

  const env = prepareSpawnEnv(db, resolved.backendId, resolved.accessMethod);
  const args = backend.buildTextOnlyArgs({ model: resolved.modelArg });
  const cliPrompt = systemPrompt ? (systemPrompt + '\n\n---\n\n' + prompt) : prompt;
  args.push(...backend.buildPromptArgs(cliPrompt));

  return new Promise((promiseResolve, reject) => {
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error(`CLI timeout (${timeout}ms)`));
    }, timeout);

    const child = spawn(backend.command, args, {
      cwd: os.tmpdir(),
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    if (backend.promptViaStdin && cliPrompt) {
      child.stdin.write(cliPrompt);
    }
    child.stdin.end();

    let stdout = '';
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const parsed = backend.parseResponse(stdout);
      if (onCliClose) {
        const result = onCliClose(parsed, code);
        if (result !== null && result !== undefined) {
          promiseResolve(result);
          return;
        }
      }
      promiseResolve(parsed.text || stdout.trim());
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`CLI error: ${err.message}`));
    });
  });
}

/**
 * Text-only prompt through an HTTP (local launcher) backend. Non-streaming —
 * returns the final completion string. Used by sendTextPrompt() when the
 * resolved backend has type === 'http'.
 *
 * @param {object} resolved - { familyId, backendId, modelArg, accessMethod }
 * @param {string} prompt - Prompt text
 * @param {object} [opts]
 * @param {string} [opts.systemPrompt] - Optional system message
 * @param {number} [opts.maxTokens=4096]
 * @param {string} [opts.taskType='conversation']
 * @returns {Promise<string>}
 */
async function sendTextPromptHttp(resolved, prompt, opts = {}) {
  const { systemPrompt = null, maxTokens = 4096 } = opts;

  // Ensure the instance is running before hitting /v1/chat/completions.
  // wait:true keeps this function synchronous — callers of
  // sendTextPrompt expect a single round-trip Promise<string>, not a
  // loading banner. The launcher side bounds the wait via health_timeout.
  let ensureResult;
  try {
    ensureResult = await LauncherClient.ensureModel({
      model: resolved.modelArg,
      backend: resolved.launcherBackend || null,
      wait: true,
    });
  } catch (err) {
    // Propagate LauncherError.code through the thrown message so the
    // routing cascade / caller can distinguish admission from transport
    // failures.
    const code = err?.code || 'LAUNCHER_UNREACHABLE';
    throw new Error(`[${code}] ${err.message}`);
  }
  const baseUrl = ensureResult?.base_url;
  const instanceId = ensureResult?.instance_id;
  if (!baseUrl) {
    throw new Error(`[START_FAILED] Launcher returned no base_url for ${resolved.modelArg}`);
  }

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: resolved.modelArg || ensureResult.model_id,
      messages,
      stream: false,
      max_tokens: maxTokens
    })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`[START_FAILED] Launcher ${baseUrl} returned ${res.status}: ${text.slice(0, 500)}`);
  }
  const json = await res.json();
  if (instanceId) {
    LauncherClient.touch(instanceId).catch(() => {});
  }
  return json?.choices?.[0]?.message?.content || '';
}

module.exports = {
  prepareSpawnEnv,
  parseResponseLine,
  parseBatchOutput,
  createProcess,
  attachStreamParser,
  familyToSdkModel,
  sendTextPrompt,
  sendTextPromptHttp
};
