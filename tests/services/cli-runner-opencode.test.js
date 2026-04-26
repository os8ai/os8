import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Test the createOpenCodeProcess ensureModel + spawn integration. Mocks
// LauncherClient (ensure/touch) and child_process.spawn so we can inspect the
// command/args/env without launching real opencode binaries.
//
// Phase B / B7 — confirms the dispatcher branch in createProcess that fires
// when backend.id==='opencode' && launcherModel.

const LauncherClient = require('../../src/services/launcher-client');
const { getBackend } = require('../../src/services/backend-adapter');
const realChildProcess = require('child_process');

// Build a FakeChildProcess that emits stdout/close AFTER listeners are
// attached. The trick: emission is scheduled via setImmediate at the moment
// spawn is called (inside spawnSpy.mockImplementation), so the listeners
// added synchronously *after* spawn returns get there before the emission.
function makeFakeChild({ stdoutChunks = [], exitCode = 0, exitError = null } = {}) {
  const fake = {
    stdoutListeners: [],
    stderrListeners: [],
    closeListeners: [],
    errorListeners: [],
    pid: 12345,
    killed: false,
    stdin: { write: vi.fn(), end: vi.fn() }
  };
  fake.stdout = {
    on: (ev, cb) => { if (ev === 'data') fake.stdoutListeners.push(cb); }
  };
  fake.stderr = {
    on: (ev, cb) => { if (ev === 'data') fake.stderrListeners.push(cb); }
  };
  fake.on = (ev, cb) => {
    if (ev === 'close') fake.closeListeners.push(cb);
    if (ev === 'error') fake.errorListeners.push(cb);
  };
  fake.kill = () => { fake.killed = true; };
  fake.__emit = () => {
    for (const chunk of stdoutChunks) {
      for (const l of fake.stdoutListeners) l(Buffer.from(chunk));
    }
    if (exitError) {
      for (const l of fake.errorListeners) l(exitError);
    } else {
      for (const l of fake.closeListeners) l(exitCode);
    }
  };
  return fake;
}

function loadCliRunner() {
  delete require.cache[require.resolve('../../src/services/cli-runner')];
  return require('../../src/services/cli-runner');
}

function drainProcess(proc) {
  const chunks = [];
  proc.onData(chunk => chunks.push(chunk));
  return new Promise(resolve => {
    proc.onExit(info => resolve({ stdout: chunks.join(''), exitInfo: info }));
  });
}

// Schedule the fake's emission to happen AFTER the synchronous listener-
// attachment that follows spawn() in cli-runner. setImmediate works because
// the listener-attach is synchronous, so by the time the next setImmediate
// fires the listeners are in place.
function scheduleEmit(fake) {
  setImmediate(() => fake.__emit());
}

describe('createProcess(opencode) — dispatcher branch', () => {
  let originalEnsure, originalTouch, originalSpawn;
  let cliRunner;
  let spawnSpy;

  beforeEach(() => {
    originalEnsure = LauncherClient.ensureModel;
    originalTouch = LauncherClient.touch;
    originalSpawn = realChildProcess.spawn;
    spawnSpy = vi.fn();
    realChildProcess.spawn = spawnSpy;
    cliRunner = loadCliRunner();
  });

  afterEach(() => {
    LauncherClient.ensureModel = originalEnsure;
    LauncherClient.touch = originalTouch;
    realChildProcess.spawn = originalSpawn;
  });

  it('ensures the launcher model, then spawns opencode with --model local/<modelId>', async () => {
    LauncherClient.ensureModel = vi.fn(async () => ({
      status: 'ready',
      instance_id: 'vllm-aeon-7-gemma-4-26b',
      base_url: 'http://localhost:8002',
      model: 'aeon-7-gemma-4-26b',
      backend: 'vllm'
    }));
    LauncherClient.touch = vi.fn();

    spawnSpy.mockImplementation(() => {
      const fake = makeFakeChild({
        stdoutChunks: [
          JSON.stringify({ type: 'text', sessionID: 'ses_x', part: { type: 'text', text: 'hello' } }) + '\n'
        ],
        exitCode: 0
      });
      scheduleEmit(fake);
      return fake;
    });

    const opencode = getBackend('opencode');
    const args = opencode.buildArgs({ model: 'local/aeon-7-gemma-4-26b' });
    const proc = cliRunner.createProcess(opencode, args, {
      cwd: '/tmp/agent-dir',
      env: { HOME: '/home/leo' },
      launcherModel: 'aeon-7-gemma-4-26b',
      launcherBackend: 'vllm'
    });
    const { stdout, exitInfo } = await drainProcess(proc);

    expect(LauncherClient.ensureModel).toHaveBeenCalledWith({
      model: 'aeon-7-gemma-4-26b', backend: 'vllm'
    });
    expect(spawnSpy).toHaveBeenCalledTimes(1);

    const [command, spawnArgs, spawnOpts] = spawnSpy.mock.calls[0];
    expect(command).toBe('opencode');
    expect(spawnArgs).toContain('run');
    expect(spawnArgs).toContain('--dangerously-skip-permissions');
    expect(spawnArgs).toContain('--format');
    expect(spawnArgs).toContain('json');
    expect(spawnArgs).toContain('--model');
    expect(spawnArgs[spawnArgs.indexOf('--model') + 1]).toBe('local/aeon-7-gemma-4-26b');
    expect(spawnOpts.cwd).toBe('/tmp/agent-dir');

    // OPENCODE_CONFIG_CONTENT must be set, with the correct base URL + model.
    const cfg = JSON.parse(spawnOpts.env.OPENCODE_CONFIG_CONTENT);
    expect(cfg.provider.local.options.baseURL).toBe('http://localhost:8002/v1');
    expect(cfg.model).toBe('local/aeon-7-gemma-4-26b');
    expect(cfg.provider.local.models['aeon-7-gemma-4-26b']).toBeDefined();

    expect(stdout).toContain('"type":"text"');
    expect(exitInfo.exitCode).toBe(0);
  });

  it('overrides --model in args with the canonical local/<modelId> form even if caller passed something else', async () => {
    LauncherClient.ensureModel = vi.fn(async () => ({
      status: 'ready',
      instance_id: 'i1',
      base_url: 'http://localhost:8002',
      model: 'aeon-7-gemma-4-26b'
    }));
    LauncherClient.touch = vi.fn();
    spawnSpy.mockImplementation(() => {
      const fake = makeFakeChild({ exitCode: 0 });
      scheduleEmit(fake);
      return fake;
    });

    const opencode = getBackend('opencode');
    // Caller passes a stale model — wrapper must overwrite it after ensureModel.
    const proc = cliRunner.createProcess(opencode, [
      'run', '--dangerously-skip-permissions', '--format', 'json',
      '--model', 'local/STALE'
    ], {
      cwd: '/tmp/agent', env: { HOME: '/home/leo' },
      launcherModel: 'aeon-7-gemma-4-26b', launcherBackend: 'vllm'
    });
    await drainProcess(proc);

    const spawnArgs = spawnSpy.mock.calls[0][1];
    expect(spawnArgs[spawnArgs.indexOf('--model') + 1]).toBe('local/aeon-7-gemma-4-26b');
  });

  it('polls ensureModel when the launcher reports loading, then proceeds when ready', async () => {
    let calls = 0;
    LauncherClient.ensureModel = vi.fn(async () => {
      calls++;
      if (calls === 1) return { status: 'loading', instance_id: 'i1', model: 'aeon-7-gemma-4-26b' };
      return { status: 'ready', instance_id: 'i1', base_url: 'http://localhost:8002', model: 'aeon-7-gemma-4-26b' };
    });
    LauncherClient.touch = vi.fn();
    spawnSpy.mockImplementation(() => {
      const fake = makeFakeChild({ exitCode: 0 });
      scheduleEmit(fake);
      return fake;
    });

    const opencode = getBackend('opencode');
    const proc = cliRunner.createProcess(opencode, opencode.buildArgs({ model: 'local/aeon-7-gemma-4-26b' }), {
      cwd: '/tmp/agent', env: { HOME: '/home/leo' },
      launcherModel: 'aeon-7-gemma-4-26b', launcherBackend: 'vllm'
    });
    const { exitInfo } = await drainProcess(proc);

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(spawnSpy).toHaveBeenCalled();
    expect(exitInfo.exitCode).toBe(0);
  }, 15_000);

  it('exits with launcher_error stderr when ensureModel throws', async () => {
    LauncherClient.ensureModel = vi.fn(async () => {
      const err = new Error('Launcher unreachable: ECONNREFUSED');
      err.code = 'LAUNCHER_UNREACHABLE';
      throw err;
    });
    LauncherClient.touch = vi.fn();

    const opencode = getBackend('opencode');
    const proc = cliRunner.createProcess(opencode, opencode.buildArgs({ model: 'local/x' }), {
      cwd: '/tmp/agent', env: {},
      launcherModel: 'aeon-7-gemma-4-26b', launcherBackend: 'vllm'
    });
    const { exitInfo } = await drainProcess(proc);

    expect(exitInfo.exitCode).toBe(1);
    expect(exitInfo.stderr).toMatch(/^launcher_error:LAUNCHER_UNREACHABLE: /);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('fires LauncherClient.touch on successful exit (LRU signal)', async () => {
    LauncherClient.ensureModel = vi.fn(async () => ({
      status: 'ready',
      instance_id: 'instance-X',
      base_url: 'http://localhost:8002',
      model: 'aeon-7-gemma-4-26b'
    }));
    LauncherClient.touch = vi.fn();
    spawnSpy.mockImplementation(() => {
      const fake = makeFakeChild({ exitCode: 0 });
      scheduleEmit(fake);
      return fake;
    });

    const opencode = getBackend('opencode');
    const proc = cliRunner.createProcess(opencode, opencode.buildArgs({ model: 'local/aeon-7-gemma-4-26b' }), {
      cwd: '/tmp/agent', env: { HOME: '/home/leo' },
      launcherModel: 'aeon-7-gemma-4-26b', launcherBackend: 'vllm'
    });
    await drainProcess(proc);

    expect(LauncherClient.touch).toHaveBeenCalledWith('instance-X');
  });

  it('does not take the opencode branch when launcherModel is missing (falls through to spawn path)', async () => {
    LauncherClient.ensureModel = vi.fn();
    spawnSpy.mockImplementation(() => {
      const fake = makeFakeChild({ exitCode: 0 });
      scheduleEmit(fake);
      return fake;
    });

    const opencode = getBackend('opencode');
    // No launcherModel — branch guard is `backend.id === 'opencode' && launcherModel`,
    // so this should hit the regular spawn fork (which still calls spawn but
    // skips the ensureModel preflight).
    const proc = cliRunner.createProcess(opencode, opencode.buildArgs({ model: 'local/x' }), {
      cwd: '/tmp/agent', env: { HOME: '/home/leo' }
      // no launcherModel
    });
    await drainProcess(proc);

    expect(LauncherClient.ensureModel).not.toHaveBeenCalled();
    expect(spawnSpy).toHaveBeenCalled();
  });

  it('forwards launcher max_model_len + output_reserve into OPENCODE_CONFIG_CONTENT.limit', async () => {
    LauncherClient.ensureModel = vi.fn(async () => ({
      status: 'ready',
      instance_id: 'vllm-aeon-7-gemma-4-26b',
      base_url: 'http://localhost:8002',
      model: 'aeon-7-gemma-4-26b',
      backend: 'vllm',
      max_model_len: 65536,
      output_reserve: 4096
    }));
    LauncherClient.touch = vi.fn();
    spawnSpy.mockImplementation(() => {
      const fake = makeFakeChild({ exitCode: 0 });
      scheduleEmit(fake);
      return fake;
    });

    const opencode = getBackend('opencode');
    const proc = cliRunner.createProcess(opencode, opencode.buildArgs({ model: 'local/aeon-7-gemma-4-26b' }), {
      cwd: '/tmp/agent', env: { HOME: '/home/leo' },
      launcherModel: 'aeon-7-gemma-4-26b', launcherBackend: 'vllm'
    });
    await drainProcess(proc);

    const [, , spawnOpts] = spawnSpy.mock.calls[0];
    expect(spawnOpts.env.OS8_OPENCODE_CONTEXT_LIMIT).toBe('65536');
    expect(spawnOpts.env.OS8_OPENCODE_OUTPUT_RESERVE).toBe('4096');
    const cfg = JSON.parse(spawnOpts.env.OPENCODE_CONFIG_CONTENT);
    expect(cfg.provider.local.models['aeon-7-gemma-4-26b'].limit).toEqual({ context: 65536, output: 4096 });
  });

  it('falls back to defensive defaults (32768 context, 4096 output) when launcher omits the fields', async () => {
    // Simulates an older launcher version that hasn't been updated to expose
    // max_model_len. The dispatcher still populates limit so opencode doesn't
    // silently fall back to its built-in default.
    LauncherClient.ensureModel = vi.fn(async () => ({
      status: 'ready',
      instance_id: 'vllm-aeon-7-gemma-4-26b',
      base_url: 'http://localhost:8002',
      model: 'aeon-7-gemma-4-26b',
      backend: 'vllm'
      // No max_model_len, no output_reserve.
    }));
    LauncherClient.touch = vi.fn();
    spawnSpy.mockImplementation(() => {
      const fake = makeFakeChild({ exitCode: 0 });
      scheduleEmit(fake);
      return fake;
    });

    const opencode = getBackend('opencode');
    const proc = cliRunner.createProcess(opencode, opencode.buildArgs({ model: 'local/aeon-7-gemma-4-26b' }), {
      cwd: '/tmp/agent', env: { HOME: '/home/leo' },
      launcherModel: 'aeon-7-gemma-4-26b', launcherBackend: 'vllm'
    });
    await drainProcess(proc);

    const [, , spawnOpts] = spawnSpy.mock.calls[0];
    expect(spawnOpts.env.OS8_OPENCODE_CONTEXT_LIMIT).toBe('32768');
    expect(spawnOpts.env.OS8_OPENCODE_OUTPUT_RESERVE).toBe('4096');
    const cfg = JSON.parse(spawnOpts.env.OPENCODE_CONFIG_CONTENT);
    expect(cfg.provider.local.models['aeon-7-gemma-4-26b'].limit).toEqual({ context: 32768, output: 4096 });
  });
});
