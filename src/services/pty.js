/**
 * PTYService — PTY session lifecycle, env assembly, event forwarding.
 *
 * Instance-based: holds sessions Map, mainWindow ref, db ref.
 * Services can emit to renderer (precedent: AppInspectorService holds _mainWindow).
 */

const path = require('path');
const fs = require('fs');
const pty = require('node-pty');

const BUFFER_MAX_SIZE = 50 * 1024; // 50KB buffer per session

class PTYService {
  /**
   * @param {object} opts
   * @param {object} opts.db - Database connection
   * @param {object} opts.mainWindow - Electron BrowserWindow
   * @param {Map} opts.sessions - Shared sessions Map
   * @param {object} opts.services - { AppService, EnvService, APPS_DIR }
   */
  constructor({ db, mainWindow, sessions, services }) {
    this._db = db;
    this._mainWindow = mainWindow;
    this._sessions = sessions;
    this._AppService = services.AppService;
    this._EnvService = services.EnvService;
    this._APPS_DIR = services.APPS_DIR;
  }

  /**
   * Build environment for a PTY session.
   * Merges DB-stored API keys, maps XAI→GROK, strips auth conflicts.
   */
  _buildEnv(type) {
    const dbEnv = this._EnvService.asObject(this._db);
    const env = {
      ...process.env,
      ...dbEnv,
      TERM: 'xterm-256color',
      SHELL_SESSIONS_DISABLE: '1',
    };

    // Map XAI_API_KEY → GROK_API_KEY (OS8 stores as XAI_API_KEY, Grok CLI expects GROK_API_KEY)
    if (env.XAI_API_KEY && !env.GROK_API_KEY) {
      env.GROK_API_KEY = env.XAI_API_KEY;
    }

    // Strip API key when provider login is active to avoid CLI auth conflict warnings
    if (['claude', 'gemini', 'codex', 'grok'].includes(type)) {
      try {
        const container = this._db.prepare(
          "SELECT c.provider_id, p.api_key_env FROM ai_containers c JOIN ai_providers p ON p.id = c.provider_id WHERE c.id = ?"
        ).get(type);
        if (container?.api_key_env) {
          const status = this._db.prepare(
            "SELECT login_status FROM ai_account_status WHERE provider_id = ?"
          ).get(container.provider_id);
          if (status?.login_status === 'active') {
            delete env[container.api_key_env];
            if (container.api_key_env === 'XAI_API_KEY') delete env.GROK_API_KEY;
          }
        }
      } catch (e) {
        // Non-fatal — keep API key if lookup fails
      }
    }

    return env;
  }

  /**
   * Get initial command for a terminal type.
   */
  _getInitialCommand(type) {
    if (type === 'claude') return 'clear && claude';
    if (type === 'gemini') return 'clear && gemini';
    if (type === 'codex') return 'clear && codex';
    if (type === 'grok') return 'clear && grok';
    if (type === 'opencode') return 'clear && opencode';
    if (type === 'terminal') return 'clear';
    return null;
  }

  /**
   * Create a new PTY session.
   * @param {string} appId - App ID (for cwd resolution)
   * @param {string} [type='terminal'] - Session type (terminal, claude, gemini, codex, grok)
   * @returns {{id: string, type: string, cwd: string}|{error: string}}
   */
  create(appId, type = 'terminal') {
    const app = this._AppService.getById(this._db, appId);
    if (!app) return { error: 'App not found' };

    const cwd = path.join(this._APPS_DIR, appId);
    if (!fs.existsSync(cwd)) {
      fs.mkdirSync(cwd, { recursive: true });
    }

    const sessionId = `${appId}-${Date.now()}`;
    const env = this._buildEnv(type);
    const initialCommand = this._getInitialCommand(type);
    const shell = process.env.SHELL || '/bin/zsh';

    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env,
    });

    const session = {
      id: sessionId,
      pty: ptyProcess,
      cwd,
      type,
      buffer: '',
      createdAt: new Date(),
    };

    // Handle PTY output
    ptyProcess.onData((data) => {
      session.buffer += data;
      if (session.buffer.length > BUFFER_MAX_SIZE) {
        session.buffer = session.buffer.slice(-BUFFER_MAX_SIZE);
      }

      if (this._mainWindow && !this._mainWindow.isDestroyed()) {
        this._mainWindow.webContents.send('terminal:output', { id: sessionId, data });
      }
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode, signal }) => {
      this._sessions.delete(sessionId);
      if (this._mainWindow && !this._mainWindow.isDestroyed()) {
        this._mainWindow.webContents.send('terminal:exit', { id: sessionId, exitCode, signal });
      }
    });

    this._sessions.set(sessionId, session);

    if (initialCommand) {
      setTimeout(() => {
        ptyProcess.write(initialCommand + '\r');
      }, 300);
    }

    return { id: sessionId, type, cwd };
  }

  write(sessionId, data) {
    const session = this._sessions.get(sessionId);
    if (session) {
      session.pty.write(data);
      return true;
    }
    return false;
  }

  resize(sessionId, cols, rows) {
    const session = this._sessions.get(sessionId);
    if (session) {
      session.pty.resize(cols, rows);
      return true;
    }
    return false;
  }

  kill(sessionId) {
    const session = this._sessions.get(sessionId);
    if (session) {
      session.pty.kill();
      this._sessions.delete(sessionId);
      return true;
    }
    return false;
  }

  killAll() {
    for (const [id, session] of this._sessions) {
      session.pty.kill();
    }
    this._sessions.clear();
  }

  getBuffer(sessionId) {
    const session = this._sessions.get(sessionId);
    return session ? session.buffer : null;
  }

  list() {
    const sessions = [];
    for (const [id, session] of this._sessions) {
      sessions.push({
        id,
        type: session.type,
        cwd: session.cwd,
        createdAt: session.createdAt,
      });
    }
    return sessions;
  }
}

module.exports = PTYService;
