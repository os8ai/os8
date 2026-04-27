/**
 * Terminal management for OS8
 *
 * @see agent-panel.js for agent chat panel (createAgentInstance)
 */

import { elements } from './elements.js';
import {
  getCurrentApp, getActiveTabId,
  getPtyHandlersInitialized, setPtyHandlersInitialized,
  getTerminalInstanceBySessionId,
  addTerminalInstance, removeTerminalInstance,
  getTerminalInstances, getTerminalInstancesForActiveTab,
  incrementTerminalIdCounter
} from './state.js';
import * as voice from './voice.js';
import { createVoiceClickHandler } from '../shared/voice-click-handler.js';

// Lazy import to avoid circular dependency (agent-panel imports from terminal)
let _createAgentInstance = null;
async function getCreateAgentInstance() {
  if (!_createAgentInstance) {
    const mod = await import('./agent-panel.js');
    _createAgentInstance = mod.createAgentInstance;
  }
  return _createAgentInstance;
}

export const terminalTheme = {
  background: '#0f172a',
  foreground: '#e2e8f0',
  cursor: '#e2e8f0',
  cursorAccent: '#0f172a',
  selectionBackground: 'rgba(59, 130, 246, 0.3)',
  black: '#1e293b',
  red: '#ef4444',
  green: '#22c55e',
  yellow: '#eab308',
  blue: '#3b82f6',
  magenta: '#a855f7',
  cyan: '#06b6d4',
  white: '#e2e8f0',
  brightBlack: '#475569',
  brightRed: '#f87171',
  brightGreen: '#4ade80',
  brightYellow: '#facc15',
  brightBlue: '#60a5fa',
  brightMagenta: '#c084fc',
  brightCyan: '#22d3ee',
  brightWhite: '#f8fafc',
};

// Terminal container options are fetched fresh each time — the server filters
// by current ai_mode, so caching would leave stale options after a mode flip.
export async function getTerminalSelectOptions() {
  const port = await window.os8.server.getPort();
  const res = await fetch(`http://localhost:${port}/api/ai/containers/terminal`);
  const containers = await res.json();
  return containers.map(c =>
    `<option value="${c.id}">${c.name}</option>`
  ).join('') + '<option value="terminal">Command Line</option><option value="agent">Agent</option>';
}

/**
 * Pick a sensible default terminal type for a fresh panel.
 *
 * 0.4.14 hard coupling: the launcher's recommended_client for the running
 * chat model dictates the local-mode CLI. No per-agent override.
 *
 * Resolution:
 *   1. Proprietary mode → 'claude' (historical default)
 *   2. Local mode → status.recommended_chat_client (Cascade-2 → 'openhands';
 *      Qwen/AEON → 'opencode')
 *   3. Local-mode fallback (status unreachable / field missing) → 'opencode'
 */
export async function resolveDefaultTerminalType() {
  try {
    const port = await window.os8.server.getPort();
    const status = await fetch(`http://localhost:${port}/api/ai/local-status`).then(r => r.ok ? r.json() : null);
    const isLocal = status?.ai_mode === 'local';
    if (!isLocal) return 'claude';
    const cli = status.recommended_chat_client;
    return (cli === 'opencode' || cli === 'openhands') ? cli : 'opencode';
  } catch (_e) {
    return 'opencode';
  }
}

export function fitTerminalInstance(instance) {
  if (instance.isBuildStatus || instance.isAgentPanel) return; // Non-xterm panels
  if (instance.fitAddon && instance.terminal) {
    try {
      instance.fitAddon.fit();
      if (instance.sessionId) {
        window.os8.terminal.resize(instance.sessionId, instance.terminal.cols, instance.terminal.rows);
      }
    } catch (e) {
      // Ignore fit errors
    }
  }
}

export function fitAllTerminals(terminalInstances) {
  terminalInstances.forEach(instance => fitTerminalInstance(instance));
}

// For backwards compatibility
export function fitTerminal() {
  fitAllTerminals(getTerminalInstancesForActiveTab());
}

/**
 * Attach copy/paste/select-all key handling to an xterm instance.
 * By default xterm.js swallows Cmd+C / Cmd+V and sends them as ^C / ^V to the PTY,
 * so we intercept them and route through the system clipboard instead.
 */
function attachCopyPasteHandler(terminal) {
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
  terminal.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (!mod) return true;
    const key = e.key.toLowerCase();
    // Cmd/Ctrl+C: copy selection (fall through to ^C if nothing selected)
    if (key === 'c' && terminal.hasSelection()) {
      const text = terminal.getSelection();
      if (text) {
        navigator.clipboard.writeText(text).catch(() => {});
      }
      return false;
    }
    // Cmd/Ctrl+V: paste from clipboard
    if (key === 'v') {
      navigator.clipboard.readText().then((text) => {
        if (text) terminal.paste(text);
      }).catch(() => {});
      return false;
    }
    // Cmd/Ctrl+A: select all terminal content
    if (key === 'a') {
      terminal.selectAll();
      return false;
    }
    return true;
  });
}

export function initPtyHandlers() {
  if (getPtyHandlersInitialized()) return;
  setPtyHandlersInitialized(true);

  window.os8.terminal.onOutput(({ id, data }) => {
    const instance = getTerminalInstanceBySessionId(id);
    if (instance && instance.terminal) {
      instance.terminal.write(data);
    }
  });

  window.os8.terminal.onExit(({ id, exitCode }) => {
    const instance = getTerminalInstanceBySessionId(id);
    if (instance && instance.terminal) {
      instance.terminal.writeln(`\r\n\x1b[90m[Session ended with code ${exitCode}]\x1b[0m`);
      instance.sessionId = null;
    }
  });
}

export function updateCloseButtonVisibility() {
  // Per-tab — the X button hides when only one instance remains in the
  // current tab (preventing the user from closing their last terminal),
  // independent of how many instances exist in other tabs' parks.
  const instances = getTerminalInstancesForActiveTab();
  const showClose = instances.length > 1;
  instances.forEach(instance => {
    const closeBtn = instance.element.querySelector('.close-terminal-btn');
    if (closeBtn) {
      closeBtn.style.display = showClose ? 'block' : 'none';
    }
  });
}

async function createSessionForInstance(instance, type) {
  if (!getCurrentApp()) return;

  // Kill existing session AND fully reset xterm.js display state.
  // terminal.reset() switches back from alternate screen, clears scrollback,
  // resets SGR attributes, and resets the parser state. Without this, a TUI
  // app killed mid-session (OpenCode, vim, less) leaves xterm stuck on its
  // alternate screen with corrupted parser state — subsequent ANSI bytes
  // render as literal text and the previous frame bleeds through.
  if (instance.sessionId) {
    await window.os8.terminal.kill(instance.sessionId);
    instance.sessionId = null;
  }
  if (instance.terminal) {
    instance.terminal.reset();
  }

  // For local CLIs, pre-fetch the launcher's running chat-slot endpoint so
  // pty.js can wire OPENCODE_CONFIG_CONTENT (opencode) or LLM_BASE_URL+MODEL
  // (openhands) before the PTY spawns. Without this the TUI launches with no
  // model configured and fails / drops into a setup wizard.
  let envOverrides = null;
  if (type === 'opencode' || type === 'openhands') {
    envOverrides = await resolveLauncherEnvForLocalCli(type);
  }

  const result = await window.os8.terminal.create(
    getCurrentApp().id,
    type,
    envOverrides ? { envOverrides } : undefined,
  );
  if (result.error) {
    console.error('Failed to create terminal session:', result.error);
    instance.terminal.writeln(`\x1b[31mError: ${result.error}\x1b[0m`);
    return;
  }

  instance.sessionId = result.id;
  instance.activeType = type;
  instance.switchBtn.style.display = 'none';

  setTimeout(() => {
    fitTerminalInstance(instance);
    instance.terminal.focus();
  }, 100);
}

/**
 * Pre-fetch the launcher's running chat slot so pty.js can build the right
 * env vars for an opencode/openhands terminal session. Returns the OS8_*_*
 * env hints the BACKENDS.<type>.prepareEnv path expects, or null when the
 * launcher is unreachable / nothing is running (in which case pty.js falls
 * through and the TUI launches without a model — visible failure beats
 * silent default).
 */
async function resolveLauncherEnvForLocalCli(type) {
  try {
    const port = await window.os8.server.getPort();
    const res = await fetch(`http://localhost:${port}/api/ai/local-status`);
    if (!res.ok) return null;
    const status = await res.json();
    if (status?.ai_mode !== 'local') return null;

    // The chat slot's running model + port live in the slots array.
    const chatSlot = (status.slots || []).find(s => s.slot === 'chat');
    if (!chatSlot) return null;
    const runningModel = chatSlot.running_model;
    const runningPort = chatSlot.running_port;
    if (!runningModel || !runningPort) return null;

    const baseUrl = `http://localhost:${runningPort}/v1`;
    if (type === 'openhands') {
      return {
        OS8_OPENHANDS_BASE_URL: baseUrl,
        OS8_OPENHANDS_MODEL_ID: runningModel,
      };
    }
    if (type === 'opencode') {
      return {
        OS8_OPENCODE_BASE_URL: baseUrl,
        OS8_OPENCODE_MODEL_ID: runningModel,
      };
    }
    return null;
  } catch (_e) {
    return null;
  }
}

/**
 * Update voice button UI based on current state
 */
function updateVoiceButtonUI(voiceBtn, state) {
  if (!voiceBtn) return

  const mutedIcon = voiceBtn.querySelector('.voice-icon-muted')
  const activeIcon = voiceBtn.querySelector('.voice-icon-active')
  const spinnerIcon = voiceBtn.querySelector('.voice-icon-spinner')
  const badge = voiceBtn.querySelector('.voice-badge')

  // Reset classes
  voiceBtn.classList.remove('streaming', 'listening', 'connecting', 'transcribing', 'continuous', 'continuous-waiting', 'continuous-speaking')

  // Hide all icons first
  mutedIcon.style.display = 'none'
  activeIcon.style.display = 'none'
  spinnerIcon.style.display = 'none'
  badge.style.display = 'none'

  if (state.isConnecting || state.isTranscribing) {
    spinnerIcon.style.display = 'block'
    voiceBtn.classList.add(state.isConnecting ? 'connecting' : 'transcribing')

    // Show infinity badge even while connecting if in continuous mode
    if (state.mode === 'continuous') {
      badge.textContent = '\u221e'
      badge.style.display = 'flex'
      voiceBtn.classList.add('continuous')
    }
  } else if (state.isStreaming) {
    activeIcon.style.display = 'block'
    voiceBtn.classList.add('streaming')

    if (state.mode === 'continuous') {
      badge.textContent = '\u221e'
      badge.style.display = 'flex'
      voiceBtn.classList.add('continuous')

      // Check if waiting (no transcript) or speaking (has transcript)
      if (state.committedText || state.unstableText) {
        voiceBtn.classList.add('continuous-speaking')
      } else {
        voiceBtn.classList.add('continuous-waiting')
      }
    }
  } else if (state.isListening) {
    activeIcon.style.display = 'block'
    voiceBtn.classList.add('listening')
  } else {
    // Idle - show muted icon
    mutedIcon.style.display = 'block'
  }
}

/**
 * Set up voice button with click handler for a terminal instance
 */
async function setupVoiceButton(voiceBtn, instance) {
  if (!voiceBtn) return

  // Lazy-load whisper setup dialog
  let whisperChecked = false;
  let whisperReady = false;

  const originalHandleClick = createVoiceClickHandler({
    getState: () => voice.getState(),
    onStop: () => {
      voice.stopStreaming()
      updateVoiceButtonUI(voiceBtn, { isStreaming: false })
    },
    onStartContinuous: () => {
      voice.startContinuous({
        onResult: (text, isFinal) => {
          if (isFinal && instance.sessionId) {
            window.os8.terminal.write(instance.sessionId, text)
          }
        },
        onTranscript: () => {},
        onStateChange: (state) => updateVoiceButtonUI(voiceBtn, state),
        onError: (err) => {
          console.error('Voice error:', err)
          updateVoiceButtonUI(voiceBtn, { isStreaming: false })
        }
      })
    },
    onStartOneShot: () => {
      voice.startOneShot({
        onResult: (text, isFinal) => {
          if (isFinal && instance.sessionId) {
            window.os8.terminal.write(instance.sessionId, text)
          }
        },
        onTranscript: () => {},
        onStateChange: (state) => updateVoiceButtonUI(voiceBtn, state),
        onError: (err) => {
          console.error('Voice error:', err)
          updateVoiceButtonUI(voiceBtn, { isStreaming: false })
        }
      })
    }
  })

  // Wrap click handler to check whisper readiness on first use
  const handleClick = async () => {
    if (!whisperChecked) {
      try {
        const status = await window.os8.whisper.status();
        whisperReady = status.ready;
      } catch {
        whisperReady = false;
      }

      if (!whisperReady) {
        const { checkWhisperAndPrompt } = await import('./whisper-setup-dialog.js');
        const ready = await checkWhisperAndPrompt();
        if (!ready) return;
        whisperReady = true;
      }
      whisperChecked = true;
    }
    originalHandleClick();
  }

  voiceBtn.addEventListener('click', handleClick)
}

export async function createTerminalInstance(type = null) {
  if (!getCurrentApp()) return;

  initPtyHandlers();

  // Caller may pass a specific type (e.g. when reopening a parked instance);
  // when null, resolve from current ai_mode + default agent's local_cli pin
  // so the freshly-created panel matches the dropdown options.
  if (type == null) {
    type = await resolveDefaultTerminalType();
  }

  const instanceId = incrementTerminalIdCounter();
  const terminalOptions = await getTerminalSelectOptions();

  // Create DOM structure
  const instanceEl = document.createElement('div');
  instanceEl.className = 'terminal-instance';
  instanceEl.dataset.instanceId = instanceId;
  instanceEl.innerHTML = `
    <div class="panel-bar terminal-instance-toolbar">
      <select class="panel-select terminal-select">
        ${terminalOptions}
      </select>
      <button class="terminal-switch-btn" style="display: none;">Exit & Switch</button>
      <div class="terminal-instance-actions">
        ${voice.isSupported() ? `<button class="terminal-voice-btn" title="Click: one-shot, Double-click: continuous">
          <span class="voice-badge" style="display:none;"></span>
          <svg class="voice-icon-muted" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 1a4 4 0 00-4 4v6a4 4 0 008 0V5a4 4 0 00-4-4z"/>
            <path d="M6 11a1 1 0 00-2 0 8 8 0 0014.93 4.03l-1.5-1.5A6 6 0 016 11z"/>
            <path d="M12 17a5.98 5.98 0 01-3.58-1.18l-1.43 1.43A7.97 7.97 0 0011 18.93V21H8a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07a7.97 7.97 0 001.76-.35l-1.44-1.44A5.97 5.97 0 0112 17z"/>
            <path d="M3.71 2.29a1 1 0 00-1.42 1.42l18 18a1 1 0 001.42-1.42l-18-18z"/>
          </svg>
          <svg class="voice-icon-active" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 20 20" fill="currentColor" style="display:none;">
            <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8 7a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1V8a1 1 0 00-1-1H8z" clip-rule="evenodd"/>
          </svg>
          <svg class="voice-icon-spinner" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display:none;">
            <circle cx="12" cy="12" r="10" stroke-opacity="0.25"/>
            <path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"/>
          </svg>
        </button>` : ''}
        <button class="close-terminal-btn" title="Close terminal">&times;</button>
      </div>
    </div>
    <div class="terminal-instance-container"></div>
  `;

  elements.terminalsContainer.appendChild(instanceEl);

  const container = instanceEl.querySelector('.terminal-instance-container');
  const select = instanceEl.querySelector('.terminal-select');
  const switchBtn = instanceEl.querySelector('.terminal-switch-btn');
  const closeBtn = instanceEl.querySelector('.close-terminal-btn');
  const voiceBtn = instanceEl.querySelector('.terminal-voice-btn');

  // Set initial selection
  select.value = type;

  // Create xterm instance
  const terminal = new Terminal({
    theme: terminalTheme,
    fontFamily: 'Menlo, Monaco, "Cascadia Code", monospace',
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 5000,
  });

  const fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);
  attachCopyPasteHandler(terminal);

  // Create instance object. tabId pins this instance to its owning tab so
  // park/unpark and per-tab queries (close-button visibility, fit-all,
  // cleanup-on-tab-close) can find the right set without scanning DOM.
  const instance = {
    id: instanceId,
    tabId: getActiveTabId(),
    element: instanceEl,
    terminal,
    fitAddon,
    sessionId: null,
    activeType: type,
    select,
    switchBtn
  };

  addTerminalInstance(instance);

  // Handle terminal input
  terminal.onData((data) => {
    if (instance.sessionId) {
      instance.hasInput = true;
      window.os8.terminal.write(instance.sessionId, data);
    }
  });

  // Create PTY session
  await createSessionForInstance(instance, type);

  // Event listeners
  select.addEventListener('change', () => {
    if (select.value !== instance.activeType) {
      switchBtn.style.display = 'inline-block';
    } else {
      switchBtn.style.display = 'none';
    }
  });

  switchBtn.addEventListener('click', async () => {
    if (select.value === 'agent') {
      // Switch to agent panel — replace this terminal instance
      if (instance.sessionId) await window.os8.terminal.kill(instance.sessionId);
      if (instance.terminal) instance.terminal.dispose();
      instance.element.remove();
      removeTerminalInstance(instanceId);
      const createAgent = await getCreateAgentInstance();
      await createAgent();
      return;
    }
    await createSessionForInstance(instance, select.value);
  });

  closeBtn.addEventListener('click', async () => {
    await closeTerminalInstance(instanceId);
  });

  // Voice input (streaming mode with double-click for continuous)
  setupVoiceButton(voiceBtn, instance);

  // Drag-and-drop: write dropped file paths into PTY stdin
  // Use capture phase on instanceEl — xterm's internal layers swallow events otherwise
  instanceEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, true);
  instanceEl.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!instance.sessionId) return;
    const files = Array.from(e.dataTransfer.files);
    const paths = files.map(f => window.os8.utils.getPathForFile(f)).filter(Boolean);
    if (paths.length > 0) {
      const quoted = paths.map(p => p.includes(' ') ? `"${p}"` : p);
      window.os8.terminal.write(instance.sessionId, quoted.join(' '));
    }
  }, true);

  // Focus and fit
  setTimeout(() => {
    fitTerminalInstance(instance);
    terminal.focus();
  }, 100);

  // Update close button visibility
  updateCloseButtonVisibility();

  return instance;
}

/**
 * Create a build status tab — an HTML panel (not xterm) showing live build progress.
 */
/**
 * Format a backend ID + model into a display label for the build tab.
 * e.g. "Coder (Codex)" or "Coder (gpt-5.3-codex)" when model is known.
 */
function formatCoderLabel(backend, model) {
  // Capitalize backend ID for display: codex → Codex, claude → Claude, etc.
  const backendLabel = backend ? backend.charAt(0).toUpperCase() + backend.slice(1) : 'Unknown';
  if (model) return `Coder (${model})`;
  return `Coder (${backendLabel})`;
}

export async function createBuildStatusTab(buildId, appId, appName, backend, model) {
  initPtyHandlers();

  const instanceId = incrementTerminalIdCounter();
  const port = await window.os8.server.getPort();

  const coderLabel = formatCoderLabel(backend, model);

  // Create DOM structure (HTML panel, not xterm)
  const instanceEl = document.createElement('div');
  instanceEl.className = 'terminal-instance';
  instanceEl.dataset.instanceId = instanceId;
  instanceEl.innerHTML = `
    <div class="panel-bar terminal-instance-toolbar">
      <span class="build-tab-label">
        <span class="build-tab-indicator"></span>
        <span class="build-tab-label-text">${escapeHtmlStr(coderLabel)}</span>
      </span>
      <div class="terminal-instance-actions">
        <span class="build-status-timer">0:00</span>
        <button class="close-terminal-btn" title="Close build tab">&times;</button>
      </div>
    </div>
    <div class="build-status-container">
      <div class="build-status-output"></div>
      <div class="build-status-summary" style="display:none;"></div>
    </div>
  `;

  elements.terminalsContainer.appendChild(instanceEl);

  const closeBtn = instanceEl.querySelector('.close-terminal-btn');
  const outputEl = instanceEl.querySelector('.build-status-output');
  const timerEl = instanceEl.querySelector('.build-status-timer');
  const summaryEl = instanceEl.querySelector('.build-status-summary');
  const indicatorEl = instanceEl.querySelector('.build-tab-indicator');
  const labelTextEl = instanceEl.querySelector('.build-tab-label-text');

  let lastStderrIdx = 0;
  let lastStdoutIdx = 0;
  const startTime = Date.now();

  // Update elapsed timer
  const timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    timerEl.textContent = `${m}:${s.toString().padStart(2, '0')}`;
  }, 1000);

  // Poll for status updates
  const pollInterval = setInterval(async () => {
    try {
      const resp = await fetch(`http://localhost:${port}/api/apps/${appId}/build/status?since=${lastStderrIdx}&stdoutSince=${lastStdoutIdx}`);
      const data = await resp.json();

      if (data.status === 'none') return;

      // Update label if model info arrived (from routing resolve)
      if (data.model && !model) {
        model = data.model;
        labelTextEl.textContent = formatCoderLabel(data.backend || backend, data.model);
      }

      let scrollNeeded = false;

      // Append new stdout lines (agent reasoning/actions — primary content)
      if (data.stdoutLines && data.stdoutLines.length > 0) {
        for (const text of data.stdoutLines) {
          const lineEl = document.createElement('div');
          lineEl.className = 'build-stdout-line';
          lineEl.textContent = text;
          outputEl.appendChild(lineEl);
        }
        lastStdoutIdx = data.stdoutCount;
        scrollNeeded = true;
      }

      // Append new stderr lines (CLI system messages — secondary)
      if (data.stderrLines && data.stderrLines.length > 0) {
        for (const line of data.stderrLines) {
          const lineEl = document.createElement('div');
          lineEl.className = 'build-stderr-line';
          lineEl.textContent = line;
          outputEl.appendChild(lineEl);
        }
        lastStderrIdx = data.stderrCount;
        scrollNeeded = true;
      }

      if (scrollNeeded) {
        outputEl.scrollTop = outputEl.scrollHeight;
      }

      // Check for completion
      if (data.status !== 'running') {
        clearInterval(pollInterval);
        clearInterval(timerInterval);

        // Update timer with final elapsed
        const elapsed = Math.floor(data.elapsedMs / 1000);
        const m = Math.floor(elapsed / 60);
        const s = elapsed % 60;
        timerEl.textContent = `${m}:${s.toString().padStart(2, '0')}`;

        // Stop pulsing indicator
        indicatorEl.classList.add('done');
        indicatorEl.classList.toggle('success', data.status === 'completed');
        indicatorEl.classList.toggle('failed', data.status !== 'completed');

        const backendDisplay = data.model || data.backend || backend;

        // Show summary card
        const isSuccess = data.status === 'completed';
        summaryEl.style.display = 'block';
        summaryEl.className = `build-status-summary ${isSuccess ? 'build-status-success' : 'build-status-failed'}`;
        summaryEl.innerHTML = `
          <div class="build-summary-icon">${isSuccess ? '&#10003;' : '&#10007;'}</div>
          <div class="build-summary-text">
            <div class="build-summary-title">${isSuccess ? 'Build Complete' : (data.status === 'timeout' ? 'Build Timed Out' : 'Build Failed')}</div>
            <div class="build-summary-detail">${escapeHtmlStr(appName)} &middot; ${m}m ${s}s &middot; ${escapeHtmlStr(backendDisplay)}</div>
            ${data.error ? `<div class="build-summary-error">${escapeHtmlStr(data.error.substring(0, 300))}</div>` : ''}
          </div>
        `;
      }
    } catch (err) {
      // Network error — will retry on next poll
    }
  }, 2000);

  // Create instance object (no xterm, no sessionId).
  // tabId pins the build panel to the tab that initiated it; polling and
  // timer intervals continue running while the tab is parked, so on
  // switch-back the user sees current state with no flash of stale content.
  const instance = {
    id: instanceId,
    tabId: getActiveTabId(),
    element: instanceEl,
    terminal: null,
    fitAddon: null,
    sessionId: null,
    activeType: 'build',
    isBuildStatus: true,
    buildId,
    _buildAppId: appId,
    _buildAppName: appName,
    _buildBackend: backend,
    _pollInterval: pollInterval,
    _timerInterval: timerInterval,
    select: null,
    switchBtn: null
  };

  addTerminalInstance(instance);

  closeBtn.addEventListener('click', async () => {
    await closeTerminalInstance(instanceId);
  });

  updateCloseButtonVisibility();
  return instance;
}

export function escapeHtmlStr(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function closeTerminalInstance(instanceId) {
  const instance = getTerminalInstances().find(t => t.id === instanceId);
  if (!instance) return;

  // Don't remove if it's the last one in the OWNING tab (per-tab guard, not
  // global — closing the last terminal in tab A shouldn't be blocked just
  // because tab B has parked terminals).
  const siblingsInTab = getTerminalInstances().filter(t => t.tabId === instance.tabId);
  if (siblingsInTab.length <= 1) return;

  // Clean up build status polling
  if (instance.isBuildStatus) {
    clearInterval(instance._pollInterval);
    clearInterval(instance._timerInterval);
  }

  // Clean up agent panel
  if (instance.isAgentPanel && instance._cleanup) {
    instance._cleanup();
  }

  // Kill PTY session
  if (instance.sessionId) {
    await window.os8.terminal.kill(instance.sessionId);
  }

  // Dispose terminal
  if (instance.terminal) {
    instance.terminal.dispose();
  }

  // Remove from DOM
  instance.element.remove();

  // Remove from array
  removeTerminalInstance(instanceId);

  // Fit remaining terminals
  fitAllTerminals(getTerminalInstances());

  // Update close button visibility (hide if only one left)
  updateCloseButtonVisibility();
}

/**
 * Show a modal with the agent's last assembled memory context (debug viewer).
 */
