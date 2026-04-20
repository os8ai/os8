/**
 * Agent chat panel for OS8
 * Two-way chat UI with agents, scoped to the current app.
 *
 * @see terminal.js for terminal/PTY management and shared utilities
 */

import { elements } from './elements.js';
import {
  getCurrentApp,
  addTerminalInstance, removeTerminalInstance, incrementTerminalIdCounter
} from './state.js';
import {
  initPtyHandlers, escapeHtmlStr, getTerminalSelectOptions,
  updateCloseButtonVisibility, closeTerminalInstance, createTerminalInstance
} from './terminal.js';
import { AgUiReducer } from '../shared/agui-client.js';

/**
 * Create an agent chat panel — a two-way chat with an agent, scoped to the current app.
 * Replaces xterm with a chat UI: agent picker, messages, input field.
 */
export async function createAgentInstance(appId, options = {}) {
  if (!appId) appId = getCurrentApp()?.id;
  if (!appId) return;

  initPtyHandlers();

  const instanceId = incrementTerminalIdCounter();
  const port = await window.os8.server.getPort();

  // Fetch agents list
  let agents = [];
  try {
    agents = await window.os8.agents.list({ filter: 'visible' });
  } catch (e) {
    console.error('Failed to load agents:', e);
  }

  // Sort agents: default agent first, then alphabetical
  agents.sort((a, b) => {
    if (a.is_default && !b.is_default) return -1;
    if (!a.is_default && b.is_default) return 1;
    return (a.name || '').localeCompare(b.name || '');
  });

  // Pre-select specific agent if requested, otherwise use default
  const preselectedId = options.agentId;
  const selectedAgent = (preselectedId && agents.find(a => a.id === preselectedId))
    || agents.find(a => a.is_default)
    || agents[0];
  const agentOptions = agents.map(a =>
    `<option value="${a.id}" ${a.id === selectedAgent?.id ? 'selected' : ''}>${escapeHtmlStr(a.name)}</option>`
  ).join('');

  // Create DOM
  const instanceEl = document.createElement('div');
  instanceEl.className = 'terminal-instance agent-instance';
  instanceEl.dataset.instanceId = instanceId;
  const terminalOpts = await getTerminalSelectOptions();
  instanceEl.innerHTML = `
    <div class="panel-bar terminal-instance-toolbar">
      <select class="panel-select terminal-select">
        ${terminalOpts.replace('<option value="agent">', '<option value="agent" selected>')}
      </select>
      <select class="agent-chat-agent-select panel-select">${agentOptions}</select>
      <div class="terminal-instance-actions">
        <button class="close-terminal-btn" title="Close">&times;</button>
      </div>
    </div>
    <div class="agent-chat-container">
      <div class="agent-status-bar">
        <span class="agent-status-dot"></span>
        <span class="agent-status-label">Working...</span>
        <span class="agent-status-timer"></span>
      </div>
      <div class="agent-chat-messages"></div>
      <div class="agent-chat-attachments" style="display:none;"></div>
      <div class="agent-chat-input-row">
        <input type="text" class="agent-chat-input" placeholder="Message the agent about this app..." />
        <button class="agent-chat-send-btn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
        </button>
      </div>
    </div>
  `;

  elements.terminalsContainer.appendChild(instanceEl);

  const select = instanceEl.querySelector('.terminal-select');
  const closeBtn = instanceEl.querySelector('.close-terminal-btn');
  const agentSelect = instanceEl.querySelector('.agent-chat-agent-select');
  const messagesEl = instanceEl.querySelector('.agent-chat-messages');
  const inputEl = instanceEl.querySelector('.agent-chat-input');
  const sendBtn = instanceEl.querySelector('.agent-chat-send-btn');
  const attachmentsEl = instanceEl.querySelector('.agent-chat-attachments');
  const chatContainer = instanceEl.querySelector('.agent-chat-container');
  const statusBar = instanceEl.querySelector('.agent-status-bar');
  const statusLabel = instanceEl.querySelector('.agent-status-label');
  const statusTimer = instanceEl.querySelector('.agent-status-timer');

  let currentAgentId = selectedAgent?.id;
  let eventSource = null;
  let streamingEl = null;
  let isLoading = false;
  let pendingAttachments = [];
  let skipNextDone = false; // Suppress 'done' text after plan card (it's redundant markdown)
  let typingEl = null;
  let workingStartTime = null;
  let timerInterval = null;
  let staleTimeout = null;
  let errorTimeout = null;

  // ag-ui reducer: ingests structured events (RUN_STARTED, TOOL_CALL_*, etc.) in parallel with
  // legacy event handlers below. State is maintained for future UI use (live tool cards,
  // structured tool result panels, run history) but not yet rendered. Legacy handlers remain
  // the source of truth for current rendering. Attached to `instance` lower in this function.
  const aguiReducer = new AgUiReducer();

  function showWorking(label) {
    workingStartTime = Date.now();
    statusBar.className = 'agent-status-bar active';
    statusLabel.textContent = label || 'Working...';
    statusTimer.textContent = '0s';
    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - workingStartTime) / 1000);
      statusTimer.textContent = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
    }, 1000);
    // Stale after 60s, error after 180s
    clearTimeout(staleTimeout);
    clearTimeout(errorTimeout);
    staleTimeout = setTimeout(() => {
      statusBar.classList.add('stale');
      statusLabel.textContent = 'Still working...';
    }, 60000);
    errorTimeout = setTimeout(() => {
      statusBar.classList.remove('stale');
      statusBar.classList.add('error');
      statusLabel.textContent = 'May be stuck...';
    }, 180000);
  }

  function hideWorking() {
    statusBar.className = 'agent-status-bar';
    clearInterval(timerInterval);
    clearTimeout(staleTimeout);
    clearTimeout(errorTimeout);
    timerInterval = null;
    workingStartTime = null;
  }

  function showTypingIndicator() {
    if (typingEl) return;
    typingEl = document.createElement('div');
    typingEl.className = 'agent-typing-indicator';
    typingEl.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
    messagesEl.appendChild(typingEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function hideTypingIndicator() {
    if (typingEl) {
      typingEl.remove();
      typingEl = null;
    }
  }

  // Connect SSE stream for the selected agent
  function connectStream() {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    if (!currentAgentId) return;

    eventSource = new EventSource(`http://localhost:${port}/api/agent/${currentAgentId}/stream`);

    // Recover state after tab switch: check if agent is working, and reload
    // history to catch any responses that arrived while disconnected.
    fetch(`http://localhost:${port}/api/agents/${currentAgentId}/status`)
      .then(r => r.json())
      .then(({ working }) => {
        if (working && !isLoading) {
          isLoading = true;
          inputEl.disabled = true;
          sendBtn.disabled = true;
          showWorking('Working...');
          showTypingIndicator();
        } else if (!working) {
          // Agent finished while we were away — reload history to show missed response
          loadHistory();
        }
      })
      .catch(() => {}); // Best-effort

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        // Maintain reducer state for future use (debug / Phase 6 features).
        try { aguiReducer.ingest(data); } catch {}

        // CUSTOM events: routed by `name` field
        if (data.type === 'CUSTOM') {
          if (data.name === 'model-switch') {
            const v = data.value || {};
            const notice = document.createElement('div');
            notice.className = 'agent-model-switch-notice';
            notice.textContent = `Model: ${v.from || '?'} → ${v.to || '?'} (${v.reason || v.cascade})`;
            messagesEl.appendChild(notice);
            messagesEl.scrollTop = messagesEl.scrollHeight;
          } else if (data.name === 'activity-pulse') {
            // Liveness pulse — reset stale/error escalation
            if (isLoading) {
              statusBar.classList.remove('stale', 'error');
              if (!statusLabel.textContent.startsWith('Working') && !statusLabel.textContent.startsWith('Still'))
                return; // don't overwrite step label
              statusLabel.textContent = 'Working...';
              clearTimeout(staleTimeout);
              clearTimeout(errorTimeout);
              staleTimeout = setTimeout(() => {
                statusBar.classList.add('stale');
                statusLabel.textContent = 'Still working...';
              }, 60000);
              errorTimeout = setTimeout(() => {
                statusBar.classList.remove('stale');
                statusBar.classList.add('error');
                statusLabel.textContent = 'May be stuck...';
              }, 180000);
            }
          } else if (data.name === 'build-proposal') {
            const v = data.value || {};
            if (v.proposalId) {
              hideTypingIndicator();
              console.warn(`[AgentPanel] SSE build-proposal received: ${v.proposalId}, rendering card`);
              renderBuildProposal({ proposalId: v.proposalId, appName: v.appName, appColor: v.appColor, appIcon: v.appIcon, spec: v.spec });
              skipNextDone = true;
            }
          } else if (data.name === 'local-notice') {
            // Local backend transient status (MODEL_LOADING). Drive the
            // existing status line rather than introducing a new surface.
            const v = data.value || {};
            if (v.code === 'MODEL_LOADING' && isLoading) {
              statusBar.classList.remove('stale', 'error');
              statusLabel.textContent = v.message || 'Loading local model…';
            }
          } else if (data.name === 'local-error') {
            // Launcher-side error — show a notice in the message stream
            // so the user sees why the agent didn't reply. Response-path
            // cleanup (RUN_ERROR / RUN_FINISHED) handles isLoading reset.
            const v = data.value || {};
            const copy = {
              LAUNCHER_UNREACHABLE: "os8-launcher isn't running. Start it to use local models.",
              MODEL_NOT_DOWNLOADED: "Local model isn't downloaded yet.",
              BUDGET_EXCEEDED: 'Local GPU is full — stop an idle model or raise the launcher budget.',
              START_FAILED: 'Local backend failed to start. Check launcher logs.',
            }[v.code] || v.message || 'Local backend error.';
            const notice = document.createElement('div');
            notice.className = 'agent-model-switch-notice local-error';
            notice.textContent = copy;
            messagesEl.appendChild(notice);
            messagesEl.scrollTop = messagesEl.scrollHeight;
          }
        } else if (data.type === 'STEP_STARTED') {
          // Tool execution started — show step label
          if (isLoading && data.stepName) {
            statusBar.classList.remove('stale', 'error');
            statusLabel.textContent = data.stepName;
          }
        } else if (data.type === 'STEP_FINISHED') {
          // Tool execution finished — revert to generic working
          if (isLoading) {
            statusLabel.textContent = 'Working...';
          }
        } else if (data.type === 'REASONING_START') {
          if (isLoading) {
            statusBar.classList.remove('stale', 'error');
            statusLabel.textContent = 'Thinking...';
          }
        } else if (data.type === 'REASONING_END') {
          if (isLoading) {
            statusLabel.textContent = 'Working...';
          }
        } else if (data.type === 'STATE_SNAPSHOT' && data.snapshot?.plan?.planId) {
          // Plan proposal — render approval card, skip the redundant done text
          hideTypingIndicator();
          renderPlanCard(data.snapshot.plan);
          skipNextDone = true;
        } else if (data.type === 'TEXT_MESSAGE_CONTENT' && data.delta) {
          // Streaming text chunk — remove typing indicator on first chunk
          hideTypingIndicator();
          if (!streamingEl) {
            streamingEl = appendMessage('agent', '', agentSelect.selectedOptions[0]?.textContent?.trim() || 'Agent');
          }
          const textEl = streamingEl.querySelector('.agent-msg-text');
          textEl.textContent += data.delta;
          messagesEl.scrollTop = messagesEl.scrollHeight;
        } else if (data.type === 'RUN_FINISHED') {
          hideTypingIndicator();
          hideWorking();
          // Skip redundant done text after plan card
          if (skipNextDone) {
            skipNextDone = false;
            streamingEl = null;
            isLoading = false;
            inputEl.disabled = false;
            sendBtn.disabled = false;
            return;
          }
          // Response complete — replace streaming content with final, or create new message
          const agentLabel = agentSelect.selectedOptions[0]?.textContent?.trim() || 'Agent';
          const finalText = data.result;
          if (streamingEl && finalText) {
            const textEl = streamingEl.querySelector('.agent-msg-text');
            textEl.textContent = finalText;
            if (data.attachments && data.attachments.length > 0) {
              const attDiv = document.createElement('div');
              attDiv.className = 'agent-msg-attachments';
              attDiv.innerHTML = data.attachments.map(att => {
                if (att.mimeType && att.mimeType.startsWith('image/')) {
                  return `<img src="http://localhost:${port}${att.url}" class="agent-msg-image" alt="${escapeHtmlStr(att.filename)}" />`;
                }
                return `<span class="agent-msg-file">${escapeHtmlStr(att.filename)}</span>`;
              }).join('');
              streamingEl.appendChild(attDiv);
            }
          } else if (finalText) {
            appendMessage('agent', finalText, agentLabel, data.attachments);
          }
          streamingEl = null;
          isLoading = false;
          inputEl.disabled = false;
          sendBtn.disabled = false;
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }
      } catch (e) {}
    };
  }

  function appendMessage(role, text, label, attachments) {
    const msgEl = document.createElement('div');
    msgEl.className = `agent-msg agent-msg-${role}`;
    let attachHtml = '';
    if (attachments && attachments.length > 0) {
      attachHtml = '<div class="agent-msg-attachments">' + attachments.map(att => {
        if (att.mimeType && att.mimeType.startsWith('image/')) {
          return `<img src="http://localhost:${port}${att.url}" class="agent-msg-image" alt="${escapeHtmlStr(att.filename)}" />`;
        }
        return `<span class="agent-msg-file">${escapeHtmlStr(att.filename)}</span>`;
      }).join('') + '</div>';
    }
    msgEl.innerHTML = `
      <div class="agent-msg-label">${escapeHtmlStr(label)}</div>
      <div class="agent-msg-text">${escapeHtmlStr(text)}</div>
      ${attachHtml}
    `;
    messagesEl.appendChild(msgEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return msgEl;
  }

  /**
   * Send a slash command to the agent (e.g. /approve, /reject) without showing it in chat.
   */
  async function sendCommand(command) {
    if (!currentAgentId) return;
    try {
      await fetch(`http://localhost:${port}/api/agent/${currentAgentId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: command })
      });
    } catch (err) {
      appendMessage('system', `Failed to send: ${err.message}`, 'System');
    }
  }

  /**
   * Render a plan approval card in the chat messages area.
   */
  function renderPlanCard(data) {
    const cardEl = document.createElement('div');
    cardEl.className = 'agent-plan-card';

    const stepsHtml = (data.steps || []).map((step, i) =>
      `<div class="agent-plan-step">
        <span class="agent-plan-step-num">${i + 1}</span>
        <span class="agent-plan-step-desc">${escapeHtmlStr(step.description)}</span>
      </div>`
    ).join('');

    cardEl.innerHTML = `
      <div class="agent-plan-header">Plan</div>
      <div class="agent-plan-summary">${escapeHtmlStr(data.summary || '')}</div>
      <div class="agent-plan-steps">${stepsHtml}</div>
      <div class="agent-plan-actions">
        <button class="agent-plan-btn agent-plan-approve">Approve</button>
        <button class="agent-plan-btn agent-plan-reject">Reject</button>
      </div>
    `;

    messagesEl.appendChild(cardEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    const approveBtn = cardEl.querySelector('.agent-plan-approve');
    const rejectBtn = cardEl.querySelector('.agent-plan-reject');
    const actionsEl = cardEl.querySelector('.agent-plan-actions');

    approveBtn.addEventListener('click', () => {
      actionsEl.innerHTML = '<span class="agent-plan-status approved">Approved</span>';
      isLoading = true;
      inputEl.disabled = true;
      sendBtn.disabled = true;
      sendCommand('/approve');
    });

    rejectBtn.addEventListener('click', () => {
      actionsEl.innerHTML = '<span class="agent-plan-status rejected">Rejected</span>';
      sendCommand('/reject');
    });
  }

  async function sendMessage() {
    const text = inputEl.value.trim();
    if ((!text && pendingAttachments.length === 0) || isLoading || !currentAgentId) return;

    // Capture and clear attachments before send
    const currentAttachments = [...pendingAttachments];
    pendingAttachments = [];
    renderPendingAttachments();

    isLoading = true;
    inputEl.value = '';
    inputEl.disabled = true;
    sendBtn.disabled = true;

    // Show user message
    const displayText = text || '[Attached files]';
    appendMessage('user', displayText, 'You', currentAttachments);

    // Show working indicators
    showWorking('Working...');
    showTypingIndicator();

    // Send to agent with app context
    const currentApp = getCurrentApp();
    const contextPrefix = currentApp
      ? `[internal: app-dev appId=${currentApp.id}] User is viewing "${currentApp.name}" in dev mode. Their message: `
      : '';

    try {
      await fetch(`http://localhost:${port}/api/agent/${currentAgentId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: contextPrefix + (text || '[Attached files]'),
          attachments: currentAttachments.length > 0 ? currentAttachments : undefined
        })
      });
    } catch (err) {
      hideTypingIndicator();
      hideWorking();
      appendMessage('system', `Failed to send: ${err.message}`, 'System');
      isLoading = false;
      inputEl.disabled = false;
      sendBtn.disabled = false;
    }
  }

  // --- Attachment support ---
  function renderPendingAttachments() {
    if (pendingAttachments.length === 0) {
      attachmentsEl.style.display = 'none';
      attachmentsEl.innerHTML = '';
      return;
    }
    attachmentsEl.style.display = 'flex';
    attachmentsEl.innerHTML = pendingAttachments.map((att, i) => {
      const isImage = att.mimeType && att.mimeType.startsWith('image/');
      if (isImage) {
        return `<div class="agent-attach-item" data-index="${i}">
          <img src="http://localhost:${port}${att.url}" class="agent-attach-thumb" alt="${escapeHtmlStr(att.filename)}" />
          <button class="agent-attach-remove" data-index="${i}">&times;</button>
        </div>`;
      }
      return `<div class="agent-attach-item agent-attach-file" data-index="${i}">
        <span class="agent-attach-name">${escapeHtmlStr(att.filename)}</span>
        <button class="agent-attach-remove" data-index="${i}">&times;</button>
      </div>`;
    }).join('');

    attachmentsEl.querySelectorAll('.agent-attach-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.index, 10);
        pendingAttachments.splice(idx, 1);
        renderPendingAttachments();
      });
    });
  }

  async function uploadFile(file) {
    if (!currentAgentId) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
      const resp = await fetch(`http://localhost:${port}/api/agent/${currentAgentId}/upload`, {
        method: 'POST',
        body: formData
      });
      if (resp.ok) {
        const result = await resp.json();
        pendingAttachments.push(result);
        renderPendingAttachments();
      }
    } catch (err) {
      console.error('Upload error:', err);
    }
  }

  // Drag-and-drop on chat container
  let dragCounter = 0;
  chatContainer.addEventListener('dragenter', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter++;
    chatContainer.classList.add('agent-chat-dragover');
  });
  chatContainer.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      chatContainer.classList.remove('agent-chat-dragover');
    }
  });
  chatContainer.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  });
  chatContainer.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter = 0;
    chatContainer.classList.remove('agent-chat-dragover');
    const files = Array.from(e.dataTransfer.files);
    for (const file of files) {
      uploadFile(file);
    }
  });

  // Wire events
  sendBtn.addEventListener('click', sendMessage);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Load chat history from server for the current agent
  async function loadHistory() {
    if (!currentAgentId) return;
    messagesEl.innerHTML = '';
    streamingEl = null;
    try {
      const response = await fetch(`http://localhost:${port}/api/agent/${currentAgentId}/history?limit=30`);
      if (response.ok) {
        const data = await response.json();
        for (const entry of data.entries) {
          const role = entry.role === 'user' ? 'user' : 'agent';
          const label = entry.role === 'user' ? (entry.speaker || 'You') : (agentSelect.selectedOptions[0]?.textContent?.trim() || entry.speaker || 'Agent');
          appendMessage(role, entry.content, label, entry.attachments);
        }
      }
    } catch (err) {
      console.warn('Failed to load agent history:', err);
    }
  }

  agentSelect.addEventListener('change', () => {
    currentAgentId = agentSelect.value;
    instance.agentId = currentAgentId;
    messagesEl.innerHTML = '';
    streamingEl = null;
    isLoading = false;
    inputEl.disabled = false;
    sendBtn.disabled = false;
    pendingAttachments = [];
    renderPendingAttachments();
    hideWorking();
    aguiReducer.reset();
    hideTypingIndicator();
    connectStream();
    loadHistory();
  });

  // Type dropdown: switch away from agent
  select.addEventListener('change', async () => {
    if (select.value !== 'agent') {
      // Clean up agent panel, replace with terminal
      cleanup();
      instance.element.remove();
      removeTerminalInstance(instanceId);
      await createTerminalInstance(select.value);
      return;
    }
  });

  closeBtn.addEventListener('click', async () => {
    cleanup();
    await closeTerminalInstance(instanceId);
  });

  // Listen for build proposals dispatched via IPC → CustomEvent
  function onBuildProposal(e) {
    const { proposalId, appName, appColor, appIcon, spec } = e.detail;
    console.warn(`[AgentPanel] IPC build-proposal CustomEvent received: ${proposalId}, "${appName}", rendering card`);
    renderBuildProposal({ proposalId, appName, appColor, appIcon, spec });
  }
  document.addEventListener('build-proposal', onBuildProposal);

  function renderBuildProposal({ proposalId, appName, appColor, appIcon, spec }) {
    const cardEl = document.createElement('div');
    cardEl.className = 'agent-plan-card';

    // Build icon preview if we have color/icon
    const iconPreview = (appColor || appIcon)
      ? `<span class="build-proposal-icon" style="background:${appColor || '#334155'};color:${appIcon ? '#fff' : '#fff'}">${escapeHtmlStr(appIcon || '?')}</span> `
      : '';

    cardEl.innerHTML = `
      <div class="agent-plan-header">Build Plan</div>
      <div class="agent-plan-summary">${iconPreview}<strong>${escapeHtmlStr(appName)}</strong></div>
      <div class="agent-plan-spec">${escapeHtmlStr(spec || '')}</div>
      <div class="agent-plan-actions">
        <button class="agent-plan-btn agent-plan-approve">Approve</button>
        <button class="agent-plan-btn agent-plan-changes">Propose Changes</button>
        <button class="agent-plan-btn agent-plan-reject">Reject</button>
      </div>
    `;

    messagesEl.appendChild(cardEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    const approveBtn = cardEl.querySelector('.agent-plan-approve');
    const changesBtn = cardEl.querySelector('.agent-plan-changes');
    const rejectBtn = cardEl.querySelector('.agent-plan-reject');
    const actionsEl = cardEl.querySelector('.agent-plan-actions');

    approveBtn.addEventListener('click', async () => {
      actionsEl.innerHTML = '<span class="agent-plan-status approved">Approved — building...</span>';
      try {
        await fetch(`http://localhost:${port}/api/apps/propose/${proposalId}/approve`, { method: 'POST' });
      } catch (err) {
        actionsEl.innerHTML = `<span class="agent-plan-status rejected">Error: ${escapeHtmlStr(err.message)}</span>`;
      }
    });

    changesBtn.addEventListener('click', () => {
      actionsEl.innerHTML = `
        <textarea class="build-changes-input" placeholder="What changes would you like?" rows="3"></textarea>
        <div class="build-changes-btns">
          <button class="agent-plan-btn agent-plan-changes-submit">Send</button>
          <button class="agent-plan-btn agent-plan-changes-cancel">Cancel</button>
        </div>
      `;
      const textarea = actionsEl.querySelector('.build-changes-input');
      const submitBtn = actionsEl.querySelector('.agent-plan-changes-submit');
      const cancelBtn = actionsEl.querySelector('.agent-plan-changes-cancel');
      textarea.focus();

      submitBtn.addEventListener('click', async () => {
        const comments = textarea.value.trim();
        if (!comments) return;
        actionsEl.innerHTML = '<span class="agent-plan-status changes">Changes requested — waiting for revision...</span>';
        try {
          await fetch(`http://localhost:${port}/api/apps/propose/${proposalId}/changes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ comments })
          });
        } catch (err) {
          actionsEl.innerHTML = `<span class="agent-plan-status rejected">Error: ${escapeHtmlStr(err.message)}</span>`;
        }
      });

      cancelBtn.addEventListener('click', () => {
        actionsEl.innerHTML = `
          <button class="agent-plan-btn agent-plan-approve">Approve</button>
          <button class="agent-plan-btn agent-plan-changes">Propose Changes</button>
          <button class="agent-plan-btn agent-plan-reject">Reject</button>
        `;
        // Re-wire buttons (recursive call)
        wireProposalButtons(cardEl, proposalId);
      });
    });

    rejectBtn.addEventListener('click', async () => {
      actionsEl.innerHTML = '<span class="agent-plan-status rejected">Rejected</span>';
      try {
        await fetch(`http://localhost:${port}/api/apps/propose/${proposalId}/reject`, { method: 'POST' });
      } catch {}
    });
  }

  function wireProposalButtons(cardEl, proposalId) {
    const approveBtn = cardEl.querySelector('.agent-plan-approve');
    const changesBtn = cardEl.querySelector('.agent-plan-changes');
    const rejectBtn = cardEl.querySelector('.agent-plan-reject');
    if (!approveBtn) return;
    // Trigger a fresh renderBuildProposal-style wiring by simulating the same click handlers
    // Easiest: just re-render the card content via the parent render function
    // But since we only need the button wiring, extract and bind:
    const actionsEl = cardEl.querySelector('.agent-plan-actions');
    const appName = cardEl.querySelector('.agent-plan-summary strong')?.textContent || '';
    const spec = cardEl.querySelector('.agent-plan-spec')?.textContent || '';

    approveBtn.addEventListener('click', async () => {
      actionsEl.innerHTML = '<span class="agent-plan-status approved">Approved — building...</span>';
      try {
        await fetch(`http://localhost:${port}/api/apps/propose/${proposalId}/approve`, { method: 'POST' });
      } catch (err) {
        actionsEl.innerHTML = `<span class="agent-plan-status rejected">Error: ${escapeHtmlStr(err.message)}</span>`;
      }
    });

    changesBtn.addEventListener('click', () => {
      // Same changes flow as above
      actionsEl.innerHTML = `
        <textarea class="build-changes-input" placeholder="What changes would you like?" rows="3"></textarea>
        <div class="build-changes-btns">
          <button class="agent-plan-btn agent-plan-changes-submit">Send</button>
          <button class="agent-plan-btn agent-plan-changes-cancel">Cancel</button>
        </div>
      `;
      const textarea = actionsEl.querySelector('.build-changes-input');
      const submitBtn = actionsEl.querySelector('.agent-plan-changes-submit');
      const cancelBtn = actionsEl.querySelector('.agent-plan-changes-cancel');
      textarea.focus();

      submitBtn.addEventListener('click', async () => {
        const comments = textarea.value.trim();
        if (!comments) return;
        actionsEl.innerHTML = '<span class="agent-plan-status changes">Changes requested — waiting for revision...</span>';
        try {
          await fetch(`http://localhost:${port}/api/apps/propose/${proposalId}/changes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ comments })
          });
        } catch (err) {
          actionsEl.innerHTML = `<span class="agent-plan-status rejected">Error: ${escapeHtmlStr(err.message)}</span>`;
        }
      });

      cancelBtn.addEventListener('click', () => {
        actionsEl.innerHTML = `
          <button class="agent-plan-btn agent-plan-approve">Approve</button>
          <button class="agent-plan-btn agent-plan-changes">Propose Changes</button>
          <button class="agent-plan-btn agent-plan-reject">Reject</button>
        `;
        wireProposalButtons(cardEl, proposalId);
      });
    });

    rejectBtn.addEventListener('click', async () => {
      actionsEl.innerHTML = '<span class="agent-plan-status rejected">Rejected</span>';
      try {
        await fetch(`http://localhost:${port}/api/apps/propose/${proposalId}/reject`, { method: 'POST' });
      } catch {}
    });
  }

  function cleanup() {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    hideWorking();
    hideTypingIndicator();
    document.removeEventListener('build-proposal', onBuildProposal);
  }

  // Create instance object
  const instance = {
    id: instanceId,
    element: instanceEl,
    terminal: null,
    fitAddon: null,
    sessionId: null,
    activeType: 'agent',
    isAgentPanel: true,
    agentId: currentAgentId,
    select,
    switchBtn: null,
    _cleanup: cleanup,
    _agentSelect: agentSelect,
    aguiReducer
  };

  addTerminalInstance(instance);

  // Start streaming and load history
  connectStream();
  loadHistory().then(() => {
    // Ensure scroll to bottom after history renders and layout settles
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  });

  // Focus input
  setTimeout(() => inputEl.focus(), 100);

  updateCloseButtonVisibility();
  return instance;
}
