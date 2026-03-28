/**
 * Process Runner
 * Low-level spawn/pty management utilities
 */

const { spawn } = require('child_process');
const pty = require('node-pty');

/**
 * Prepare environment with Claude-friendly PATH
 * Ensures ~/.local/bin is in PATH (where Claude CLI is installed)
 */
function prepareEnv(baseEnv = process.env) {
  const env = { ...baseEnv };

  // Ensure ~/.local/bin is in PATH for Claude CLI
  if (env.PATH && !env.PATH.includes('.local/bin')) {
    env.PATH = `${process.env.HOME}/.local/bin:${env.PATH}`;
  }

  // Strip CLAUDECODE env var — if OS8 was launched from inside a Claude Code
  // session, child Claude processes would refuse to start (nested session guard)
  delete env.CLAUDECODE;

  return env;
}

/**
 * Spawn a process and collect output
 * @param {string} command - Command to run
 * @param {string[]} args - Command arguments
 * @param {object} options - Spawn options
 * @param {string} options.cwd - Working directory
 * @param {object} options.env - Environment variables
 * @param {number} options.timeout - Timeout in ms (default: 5 minutes)
 * @param {function} options.onStdout - Callback for stdout data
 * @param {function} options.onStderr - Callback for stderr data
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
function spawnProcess(command, args, options = {}) {
  const {
    cwd = process.cwd(),
    env = prepareEnv(),
    timeout = 5 * 60 * 1000,
    onStdout,
    onStderr
  } = options;

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      env,
      shell: true
    });

    let stdout = '';
    let stderr = '';
    let timeoutId;

    if (timeout > 0) {
      timeoutId = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`Process timed out after ${timeout}ms`));
      }, timeout);
    }

    proc.stdout.on('data', (data) => {
      const str = data.toString();
      stdout += str;
      if (onStdout) onStdout(str);
    });

    proc.stderr.on('data', (data) => {
      const str = data.toString();
      stderr += str;
      if (onStderr) onStderr(str);
    });

    proc.on('close', (code) => {
      if (timeoutId) clearTimeout(timeoutId);
      resolve({ stdout, stderr, code });
    });

    proc.on('error', (err) => {
      if (timeoutId) clearTimeout(timeoutId);
      reject(err);
    });
  });
}

/**
 * Create a PTY process for interactive/streaming use
 * @param {string} command - Command to run
 * @param {string[]} args - Command arguments
 * @param {object} options - PTY options
 * @param {string} options.cwd - Working directory
 * @param {object} options.env - Environment variables
 * @param {number} options.cols - Terminal columns (default: 120)
 * @param {number} options.rows - Terminal rows (default: 30)
 * @param {function} options.onData - Callback for PTY data
 * @param {function} options.onExit - Callback for PTY exit
 * @returns {object} PTY process with write, resize, kill methods
 */
function createPty(command, args, options = {}) {
  const {
    cwd = process.cwd(),
    env = prepareEnv(),
    cols = 120,
    rows = 30,
    onData,
    onExit
  } = options;

  const ptyProcess = pty.spawn(command, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env
  });

  if (onData) {
    ptyProcess.onData(onData);
  }

  if (onExit) {
    ptyProcess.onExit(onExit);
  }

  return {
    process: ptyProcess,
    write: (data) => ptyProcess.write(data),
    resize: (cols, rows) => ptyProcess.resize(cols, rows),
    kill: () => ptyProcess.kill()
  };
}

/**
 * Run a simple command and return stdout
 * Convenience wrapper for quick one-shot commands
 */
async function run(command, args, cwd) {
  const result = await spawnProcess(command, args, { cwd });
  if (result.code !== 0) {
    throw new Error(`Command failed with code ${result.code}: ${result.stderr}`);
  }
  return result.stdout;
}

module.exports = {
  prepareEnv,
  spawnProcess,
  createPty,
  run
};
