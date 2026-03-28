/**
 * Claude Protocol
 * Claude-specific argument construction, output parsing, and mode definitions
 */

const { spawnProcess, createPty, prepareEnv } = require('./process-runner');
const { getBackend } = require('./backend-adapter');

/**
 * Claude execution modes
 */
const MODES = {
  BATCH: 'batch',           // Non-interactive, returns JSON
  INTERACTIVE: 'interactive', // Long-running interactive session
  STREAMING: 'streaming'    // PTY-based for real-time output
};

/**
 * Build Claude CLI arguments based on mode and options
 * @param {object} options
 * @param {string} options.mode - Execution mode (batch, interactive, streaming)
 * @param {string} options.message - Message to send (for batch mode)
 * @param {string} options.sessionId - Session ID for continuation
 * @param {boolean} options.skipPermissions - Use --dangerously-skip-permissions
 * @param {boolean} options.json - Output JSON format
 * @param {boolean} options.print - Use print mode (-p)
 * @param {boolean} options.streamJson - Use stream-json format
 * @param {string[]} options.files - File paths to attach with -f flag
 * @returns {string[]} Array of CLI arguments
 */
function buildArgs(options = {}) {
  const {
    mode = MODES.BATCH,
    message,
    sessionId,
    skipPermissions = false,
    json = true,
    print = true,
    streamJson = false,
    files = []
  } = options;

  const args = [];

  // Session continuation
  if (sessionId) {
    args.push('--continue');
  }

  // Mode-specific args
  if (mode === MODES.BATCH) {
    if (print) args.push('-p');
    if (json) args.push('--output-format', 'json');
  } else if (mode === MODES.STREAMING) {
    if (streamJson) args.push('--output-format', 'stream-json');
  }

  // Permissions
  if (skipPermissions) {
    args.push('--dangerously-skip-permissions');
  }

  // File attachments (must come before message)
  if (files && files.length > 0) {
    for (const file of files) {
      if (file) {
        args.push('-f', file);
      }
    }
  }

  // Message (must be last for batch mode)
  if (message && mode === MODES.BATCH) {
    args.push(message);
  }

  return args;
}

/**
 * Parse Claude JSON response
 * Handles various response formats from Claude CLI
 * @param {string} output - Raw stdout from Claude
 * @returns {object} Parsed response with text, sessionId, raw
 */
function parseResponse(output) {
  try {
    const response = JSON.parse(output);

    let text = '';
    let sessionId = response.session_id || null;

    // Handle different response formats
    if (response.result) {
      text = response.result;
    } else if (response.content && Array.isArray(response.content)) {
      text = response.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n');
    } else if (typeof response === 'string') {
      text = response;
    }

    return { text, sessionId, raw: response };
  } catch (err) {
    // If JSON parsing fails, return raw output
    return { text: output.trim(), sessionId: null, raw: null };
  }
}

/**
 * Parse stream-json format line by line
 * @param {string} line - Single line of stream-json output
 * @returns {object|null} Parsed event or null if not parseable
 */
function parseStreamLine(line) {
  if (!line.trim()) return null;

  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * Run Claude in batch mode
 * Best for: Single-shot requests that return JSON
 * @param {string} message - Message to send
 * @param {string} cwd - Working directory
 * @param {object} options - Additional options
 * @returns {Promise<{text: string, sessionId: string, raw: object}>}
 */
async function runBatch(message, cwd, options = {}) {
  const {
    sessionId,
    skipPermissions = true,
    timeout = 5 * 60 * 1000,
    onStdout,
    files = [],
    backendId,
    model
  } = options;

  // If a backend is specified, use its adapter
  if (backendId) {
    const backend = getBackend(backendId);
    const args = backend.buildArgs({
      print: true,
      skipPermissions,
      json: true,
      appPath: cwd,
      model,
    });
    args.push(...backend.buildPromptArgs(message));

    // Backends that pipe prompt via stdin (Codex) need special handling
    if (backend.promptViaStdin) {
      const { spawn: spawnChild } = require('child_process');
      const result = await new Promise((resolve, reject) => {
        const proc = spawnChild(backend.command, args, {
          cwd,
          env: backend.prepareEnv(),
          stdio: ['pipe', 'pipe', 'pipe']
        });
        let stdout = '', stderr = '';
        proc.stdout.on('data', d => {
          stdout += d.toString();
          if (onStdout) onStdout(d.toString());
        });
        proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.stdin.write(message);
        proc.stdin.end();
        const timeoutId = timeout > 0 ? setTimeout(() => { proc.kill(); reject(new Error('Timeout')); }, timeout) : null;
        proc.on('close', code => { if (timeoutId) clearTimeout(timeoutId); resolve({ stdout, stderr, code }); });
        proc.on('error', err => { if (timeoutId) clearTimeout(timeoutId); reject(err); });
      });

      if (result.code !== 0) {
        if (result.stdout && result.stdout.trim()) {
          console.warn(`[runBatch] ${backend.label} exited with code ${result.code} but has output, attempting to parse`);
          try { return backend.parseResponse(result.stdout); } catch (parseErr) {
            console.warn(`[claude-protocol] Fallback parse failed after non-zero exit: ${parseErr.message}`);
          }
        }
        throw new Error(`${backend.label} exited with code ${result.code}: ${result.stderr}`);
      }
      return backend.parseResponse(result.stdout);
    }

    const result = await spawnProcess(backend.command, args, {
      cwd,
      env: backend.prepareEnv(),
      timeout,
      onStdout
    });

    if (result.code !== 0) {
      // Gemini may exit code 1 with valid output — try to parse before throwing
      if (result.stdout && result.stdout.trim()) {
        console.warn(`[runBatch] ${backend.label} exited with code ${result.code} but has output, attempting to parse`);
        try {
          return backend.parseResponse(result.stdout);
        } catch (parseErr) {
          // Fall through to throw
        }
      }
      throw new Error(`${backend.label} exited with code ${result.code}: ${result.stderr}`);
    }

    return backend.parseResponse(result.stdout);
  }

  // Default: Claude Code (backward compatible)
  const args = buildArgs({
    mode: MODES.BATCH,
    message,
    sessionId,
    skipPermissions,
    json: true,
    print: true,
    files
  });

  const result = await spawnProcess('claude', args, {
    cwd,
    env: prepareEnv(),
    timeout,
    onStdout
  });

  if (result.code !== 0) {
    throw new Error(`Claude exited with code ${result.code}: ${result.stderr}`);
  }

  return parseResponse(result.stdout);
}

/**
 * Create Claude PTY for streaming mode
 * Best for: Real-time streaming responses, interactive sessions
 * @param {string} cwd - Working directory
 * @param {object} options - PTY and Claude options
 * @returns {object} PTY interface with send, close methods
 */
function createStreaming(cwd, options = {}) {
  const {
    skipPermissions = true,
    streamJson = false,
    cols = 120,
    rows = 30,
    onData,
    onExit
  } = options;

  const args = buildArgs({
    mode: MODES.STREAMING,
    skipPermissions,
    streamJson
  });

  const pty = createPty('claude', args, {
    cwd,
    cols,
    rows,
    onData,
    onExit
  });

  return {
    ...pty,
    send: (message) => pty.write(message + '\n')
  };
}

/**
 * Create Claude PTY with initial message
 * Convenience for the common pattern of sending one message and getting response
 * @param {string} message - Initial message to send
 * @param {string} cwd - Working directory
 * @param {object} options - PTY options
 * @returns {object} PTY interface
 */
function createWithMessage(message, cwd, options = {}) {
  const {
    skipPermissions = true,
    sessionId,
    streamJson = true,
    cols = 120,
    rows = 30,
    onData,
    onExit
  } = options;

  const args = [];

  if (sessionId) {
    args.push('--continue');
  }

  if (streamJson) {
    args.push('--output-format', 'stream-json');
  }

  if (skipPermissions) {
    args.push('--dangerously-skip-permissions');
  }

  args.push(message);

  return createPty('claude', args, {
    cwd,
    cols,
    rows,
    onData,
    onExit
  });
}

module.exports = {
  MODES,
  buildArgs,
  parseResponse,
  parseStreamLine,
  runBatch,
  createStreaming,
  createWithMessage,
  prepareEnv
};
