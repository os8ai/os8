/**
 * Settings management for OS8
 */

import {
  getCurrentSettingsSection, setCurrentSettingsSection,
  getOauthPortInfo, setOauthPortInfo
} from './state.js';
import { loadApiKeys, initApiKeysListeners } from './api-keys.js';

// Re-export for main.js
export { loadApiKeys };


/**
 * Switch to a different settings section
 */
export async function switchSettingsSection(sectionId) {
  setCurrentSettingsSection(sectionId);

  // Update nav items
  document.querySelectorAll('.settings-nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.section === sectionId);
  });

  // Update sections
  document.querySelectorAll('.settings-section').forEach(section => {
    section.classList.toggle('active', section.id === `section-${sectionId}`);
  });

  // Reload section data when switching (handles API key changes)
  if (sectionId === 'account') {
    const { loadAccountSection } = await import('./account.js');
    await loadAccountSection();
  } else if (sectionId === 'user') {
    await loadUserSettings();
  } else if (sectionId === 'time') {
    await loadTimeSettings();
  } else if (sectionId === 'ai-models') {
    await loadAIModelsSettings();
  } else if (sectionId === 'capabilities') {
    const { loadCapabilities } = await import('./capabilities.js');
    await loadCapabilities();
  } else if (sectionId === 'privacy') {
    await loadPrivacySettings();
  } else if (sectionId === 'app-store') {
    await loadAppStoreSettings();
  }
}


/**
 * Load User settings
 */
async function loadUserSettings() {
  try {
    const serverPort = await window.os8.server.getPort();
    const res = await fetch(`http://localhost:${serverPort}/api/settings/user`);
    const data = await res.json();
    const input = document.getElementById('userFirstNameInput');
    if (input) input.value = data.firstName || '';

    // Load user photo preview
    const img = document.getElementById('userPhotoPreview');
    if (img) {
      img.src = `http://localhost:${serverPort}/api/settings/user-image?t=${Date.now()}`;
      img.onload = () => { img.style.display = 'block'; };
      img.onerror = () => { img.style.display = 'none'; };
    }
  } catch (err) {
    console.error('Failed to load user settings:', err);
  }
}

/**
 * Load System settings (timezone, paths)
 */
async function loadTimeSettings() {
  try {
    const serverPort = await window.os8.server.getPort();
    const res = await fetch(`http://localhost:${serverPort}/api/settings/time`);
    const data = await res.json();
    const select = document.getElementById('timezoneSelect');
    if (select) select.value = data.timezone || 'America/New_York';

    // Load paths + version
    const paths = await window.os8.paths.get();
    const versionEl = document.getElementById('os8VersionDisplay');
    const installPathEl = document.getElementById('installPathDisplay');
    const userDataPathEl = document.getElementById('userDataPathDisplay');
    if (versionEl) versionEl.textContent = paths.version ? `v${paths.version}` : '—';
    if (installPathEl) installPathEl.textContent = paths.install || '—';
    if (userDataPathEl) userDataPathEl.textContent = paths.userData || '—';
  } catch (err) {
    console.error('Failed to load system settings:', err);
  }
}

/**
 * Load OAuth port setting
 */
export async function loadOAuthPortSetting() {
  const oauthPortInput = document.getElementById('oauthPortInput');

  setOauthPortInfo(await window.os8.settings.getOAuthPort());
  oauthPortInput.value = getOauthPortInfo().current;
  updateOAuthPortWarning();
}

/**
 * Update OAuth port warning display
 */
export function updateOAuthPortWarning() {
  const oauthPortInput = document.getElementById('oauthPortInput');
  const oauthPortWarning = document.getElementById('oauthPortWarning');
  const oauthRedirectUri = document.getElementById('oauthRedirectUri');

  const currentPort = parseInt(oauthPortInput.value, 10);
  const isCustom = currentPort !== getOauthPortInfo().default;

  if (isCustom) {
    oauthRedirectUri.textContent = `http://127.0.0.1:${currentPort}/oauth/callback`;
    oauthPortWarning.style.display = 'flex';
  } else {
    oauthPortWarning.style.display = 'none';
  }
}

/**
 * Load tunnel URL setting
 */
export async function loadTunnelUrlSetting() {
  const tunnelUrlInput = document.getElementById('tunnelUrlInput');
  const tunnelUrlHint = document.getElementById('tunnelUrlHint');

  // Get tunnel status and current URL
  const status = await window.os8.tunnel.status();
  const tunnelUrl = await window.os8.settings.getTunnelUrl();

  if (tunnelUrl) {
    tunnelUrlInput.value = tunnelUrl;
    tunnelUrlInput.placeholder = '';
    tunnelUrlHint.innerHTML = 'Tunnel active - voice calls work from anywhere';
  } else if (status.ready) {
    tunnelUrlInput.value = '';
    tunnelUrlInput.placeholder = 'Starting tunnel...';
    tunnelUrlHint.innerHTML = 'cloudflared installed, tunnel starting...';
  } else {
    tunnelUrlInput.value = '';
    tunnelUrlInput.placeholder = 'Installing cloudflared...';
    tunnelUrlHint.innerHTML = 'First-time setup in progress...';
  }
}

/**
 * Copy tunnel URL to clipboard
 */
export async function copyTunnelUrl() {
  const tunnelUrlInput = document.getElementById('tunnelUrlInput');
  const tunnelUrlCopy = document.getElementById('tunnelUrlCopy');
  const tunnelUrlStatus = document.getElementById('tunnelUrlStatus');
  const tunnelUrlStatusText = document.getElementById('tunnelUrlStatusText');

  if (!tunnelUrlInput.value) {
    tunnelUrlStatusText.textContent = 'No tunnel URL to copy';
    tunnelUrlStatus.style.display = 'flex';
    setTimeout(() => {
      tunnelUrlStatus.style.display = 'none';
    }, 2000);
    return;
  }

  try {
    await navigator.clipboard.writeText(tunnelUrlInput.value);
    const originalText = tunnelUrlCopy.textContent;
    tunnelUrlCopy.textContent = 'Copied!';
    setTimeout(() => {
      tunnelUrlCopy.textContent = originalText;
    }, 1500);
  } catch (err) {
    tunnelUrlStatusText.textContent = 'Failed to copy';
    tunnelUrlStatus.style.display = 'flex';
    setTimeout(() => {
      tunnelUrlStatus.style.display = 'none';
    }, 2000);
  }
}

/**
 * Save OAuth port setting
 */
export async function saveOAuthPort() {
  const oauthPortInput = document.getElementById('oauthPortInput');
  const oauthPortUnlock = document.getElementById('oauthPortUnlock');
  const oauthPortSave = document.getElementById('oauthPortSave');

  const port = parseInt(oauthPortInput.value, 10);
  if (port < 1024 || port > 65535) {
    alert('Port must be between 1024 and 65535');
    return;
  }

  await window.os8.settings.setOAuthPort(port);
  const portInfo = getOauthPortInfo();
  portInfo.current = port;
  portInfo.isCustom = port !== portInfo.default;
  setOauthPortInfo(portInfo);

  // Reset UI state
  oauthPortUnlock.checked = false;
  oauthPortInput.disabled = true;
  oauthPortSave.disabled = true;

  updateOAuthPortWarning();
}


/**
 * Load voice settings
 */
export async function loadVoiceSettings() {
  try {
    const settings = await window.os8.voice.getSettings();

    document.getElementById('voiceSilenceNormal').value = settings.silenceDurationNormal;
    document.getElementById('voiceSilenceShort').value = settings.silenceDurationShort;
    document.getElementById('voiceContextWindow').value = settings.contextWindowLength;
    document.getElementById('voiceVadSilence').value = settings.vadSilence;

    // Update display values
    updateVoiceDisplayValues();
  } catch (err) {
    console.error('Failed to load voice settings:', err);
  }
}

/**
 * Update voice slider display values
 */
function updateVoiceDisplayValues() {
  const silenceNormal = document.getElementById('voiceSilenceNormal');
  const silenceShort = document.getElementById('voiceSilenceShort');
  const contextWindow = document.getElementById('voiceContextWindow');
  const vadSilence = document.getElementById('voiceVadSilence');

  if (silenceNormal) {
    document.getElementById('voiceSilenceNormalValue').textContent = `${(silenceNormal.value / 1000).toFixed(1)}s`;
  }
  if (silenceShort) {
    document.getElementById('voiceSilenceShortValue').textContent = `${(silenceShort.value / 1000).toFixed(1)}s`;
  }
  if (contextWindow) {
    document.getElementById('voiceContextWindowValue').textContent = `${(contextWindow.value / 1000).toFixed(0)}s`;
  }
  if (vadSilence) {
    document.getElementById('voiceVadSilenceValue').textContent = `${(vadSilence.value / 1000).toFixed(1)}s`;
  }
}

/**
 * Save voice settings
 */
export async function saveVoiceSettings() {
  const voiceSaveBtn = document.getElementById('voiceSaveBtn');
  const voiceSaveStatus = document.getElementById('voiceSaveStatus');

  voiceSaveBtn.disabled = true;
  voiceSaveStatus.textContent = '';
  voiceSaveStatus.className = 'voice-save-status';

  try {
    const settings = {
      silenceDurationNormal: parseInt(document.getElementById('voiceSilenceNormal').value, 10),
      silenceDurationShort: parseInt(document.getElementById('voiceSilenceShort').value, 10),
      contextWindowLength: parseInt(document.getElementById('voiceContextWindow').value, 10),
      vadSilence: parseInt(document.getElementById('voiceVadSilence').value, 10),
    };

    await window.os8.voice.updateSettings(settings);

    voiceSaveStatus.textContent = 'Settings saved (restart whisper server to apply server-side changes)';
  } catch (err) {
    voiceSaveStatus.textContent = 'Failed to save settings';
    voiceSaveStatus.className = 'voice-save-status error';
  }

  voiceSaveBtn.disabled = false;
}


/**
 * Load Privacy settings (Claude Code telemetry toggles)
 */
async function loadPrivacySettings() {
  const toggles = [
    { id: 'privacyTelemetry', envKey: 'DISABLE_TELEMETRY' },
    { id: 'privacyErrorReporting', envKey: 'DISABLE_ERROR_REPORTING' },
    { id: 'privacyFeedbackSurvey', envKey: 'CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY' },
    { id: 'privacyCodexAnalytics', envKey: 'CODEX_DISABLE_ANALYTICS' },
    { id: 'privacyCodexFeedback', envKey: 'CODEX_DISABLE_FEEDBACK' },
    { id: 'privacyCodexHistory', envKey: 'CODEX_DISABLE_HISTORY' },
    { id: 'privacyGeminiTelemetry', envKey: 'GEMINI_TELEMETRY_ENABLED', invert: true },
    { id: 'privacyGeminiPromptLogging', envKey: 'GEMINI_TELEMETRY_LOG_PROMPTS', invert: true },
  ];
  for (const { id, envKey, invert } of toggles) {
    const el = document.getElementById(id);
    if (el) {
      const val = await window.os8.env.get(envKey);
      if (invert) {
        // Inverted: env var present with 'false' means toggle is ON (disabled)
        el.checked = val && val.value === 'false';
      } else {
        el.checked = !!val;
      }
    }
  }
}

/**
 * App Store channel settings (PR 3.5).
 * Toggles control which channels the desktop syncs and whether the Developer
 * Import button is shown. Storage keys are plain strings in `settings`.
 */
function readBoolSetting(value, defaultBool) {
  if (value === undefined || value === null) return defaultBool;
  return value === 'true' || value === true;
}

async function loadAppStoreSettings() {
  try {
    const verified  = await window.os8.settings.get('app_store.channel.verified.enabled');
    const community = await window.os8.settings.get('app_store.channel.community.enabled');
    const devImport = await window.os8.settings.get('app_store.channel.developer-import.enabled');
    const idleMs    = await window.os8.settings.get('app_store.idle_timeout_ms');

    const $verified  = document.getElementById('appStoreChannelVerified');
    const $community = document.getElementById('appStoreChannelCommunity');
    const $devImport = document.getElementById('appStoreChannelDevImport');
    const $idle      = document.getElementById('appStoreIdleTimeout');

    if ($verified)  $verified.checked  = readBoolSetting(verified,  true);
    if ($community) $community.checked = readBoolSetting(community, false);
    if ($devImport) $devImport.checked = readBoolSetting(devImport, true);
    if ($idle && idleMs != null) $idle.value = String(idleMs);
  } catch (err) {
    console.error('Failed to load App Store settings:', err);
  }
}

async function saveAppStoreSettings() {
  try {
    const wasCommunity = readBoolSetting(
      await window.os8.settings.get('app_store.channel.community.enabled'),
      false
    );

    const verified  = !!document.getElementById('appStoreChannelVerified')?.checked;
    const community = !!document.getElementById('appStoreChannelCommunity')?.checked;
    const devImport = !!document.getElementById('appStoreChannelDevImport')?.checked;
    const idleMs    = document.getElementById('appStoreIdleTimeout')?.value || '1800000';

    await window.os8.settings.set('app_store.channel.verified.enabled',         String(verified));
    await window.os8.settings.set('app_store.channel.community.enabled',        String(community));
    await window.os8.settings.set('app_store.channel.developer-import.enabled', String(devImport));
    await window.os8.settings.set('app_store.idle_timeout_ms',                  String(idleMs));

    // Re-evaluate the daily catalog scheduler.
    if (window.os8.appStore?.rescheduleSyncs) {
      try { await window.os8.appStore.rescheduleSyncs(); }
      catch (e) { console.warn('rescheduleSyncs failed:', e); }
    }

    // First-time enable: kick an immediate community sync so the user sees
    // listings without waiting for the daily timer.
    let inlineMsg = 'Saved.';
    if (!wasCommunity && community && window.os8.appStore?.syncChannelNow) {
      try {
        const r = await window.os8.appStore.syncChannelNow('community');
        if (r?.ok) {
          const added = r.added ?? 0;
          inlineMsg = `Saved. Synced community channel (+${added} new).`;
        } else {
          inlineMsg = `Saved. Community sync warning: ${r?.error || 'unknown'}`;
        }
      } catch (e) {
        inlineMsg = `Saved. Community sync error: ${e.message}`;
      }
    }

    // Re-render the home action bar so the Import button hides/shows.
    document.dispatchEvent(new CustomEvent('app-store:settings-changed'));

    const status = document.getElementById('appStoreSaveStatus');
    if (status) {
      status.textContent = inlineMsg;
      status.hidden = false;
      setTimeout(() => { status.hidden = true; }, 4000);
    }
  } catch (err) {
    console.error('Failed to save App Store settings:', err);
    const status = document.getElementById('appStoreSaveStatus');
    if (status) {
      status.textContent = `Error: ${err.message}`;
      status.hidden = false;
    }
  }
}

/**
 * Load AI Models (backend auth) settings
 */
export async function loadAIModelsSettings() {
  try {
    const serverPort = await window.os8.server.getPort();
    // Mode toggle + local-slots panel (Phase B). Load first so the user sees
    // it at the top of the section without waiting for the provider tables.
    await loadLocalModePanel(serverPort);
    // Memory context limit (per-mode token budget). Sits between the mode
    // toggle and the provider tables.
    await loadContextLimitsPanel(serverPort);
    // Load routing UI (provider status, preference, cascades)
    await loadRoutingUI(serverPort);
  } catch (err) {
    console.error('Failed to load AI models settings:', err);
  }
}

// --- Local mode toggle + slot status (Phase B) ---

let _localStatusPoller = null;
let _localPollTickHandler = null;

function stopLocalStatusPoller() {
  if (_localStatusPoller) {
    clearInterval(_localStatusPoller);
    _localStatusPoller = null;
  }
}

function renderSlots(slots) {
  const container = document.getElementById('localSlots');
  if (!container || !Array.isArray(slots)) return;
  for (const entry of slots) {
    const row = container.querySelector(`.local-slot[data-slot="${entry.slot}"]`);
    if (!row) continue;
    const statusEl = row.querySelector('.slot-status');
    const modelEl = row.querySelector('.slot-model');

    if (statusEl) {
      let label, state;
      if (entry.serving) { label = 'Serving'; state = 'serving'; }
      else if (entry.loading) { label = 'Loading…'; state = 'loading'; }
      else { label = 'Offline'; state = 'offline'; }
      statusEl.textContent = label;
      statusEl.dataset.status = state;
    }

    // Surface the launcher's currently-active option so the user can confirm
    // which model their local-mode dispatch will hit. The model is chosen in
    // os8-launcher (read-only here per design); for multi-option roles we
    // also flag a pending Stop & Apply waiting in the launcher.
    if (modelEl) {
      const opt = Array.isArray(entry.options)
        ? entry.options.find(o => o.model === entry.selected)
        : null;
      const displayLabel = opt?.label || entry.model || '';
      let suffix = '';
      if (entry.needs_apply && entry.running_model && entry.running_model !== entry.selected) {
        suffix = '  · pending in launcher';
      }
      modelEl.textContent = displayLabel + suffix;
      const hasChoice = Array.isArray(entry.options) && entry.options.length > 1;
      modelEl.title = hasChoice
        ? 'Selected in os8-launcher → click to open the chooser'
        : 'Set by os8-launcher';
      if (hasChoice) {
        modelEl.style.cursor = 'pointer';
        modelEl.style.textDecoration = 'underline dotted';
        modelEl.onclick = async () => {
          // Open the launcher's triplet chooser in the user's default browser
          // via the existing OS8 server endpoint (same pattern as onboarding.js).
          try {
            const port = await window.os8.server.getPort();
            await fetch(`http://localhost:${port}/api/open-external`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url: 'http://localhost:9000/triplet.html' })
            });
          } catch (e) {
            console.warn('Failed to open launcher chooser:', e.message);
          }
        };
      } else {
        modelEl.style.cursor = '';
        modelEl.style.textDecoration = '';
        modelEl.onclick = null;
      }
    }
  }
}

function renderReachabilityError(reachable) {
  const el = document.getElementById('aiModeError');
  if (!el) return;
  if (reachable === false) {
    el.hidden = false;
    el.textContent = 'Launcher unreachable — start os8-launcher to use local mode.';
  } else {
    el.hidden = true;
    el.textContent = '';
  }
}

async function fetchLocalStatus(serverPort) {
  const res = await fetch(`http://localhost:${serverPort}/api/ai/local-status`);
  if (!res.ok) throw new Error(`local-status ${res.status}`);
  return res.json();
}

function allServing(slots) {
  return Array.isArray(slots) && slots.length > 0 && slots.every(s => s.serving);
}

async function pollTick(serverPort) {
  // Bail if user left the AI section — we poll lazily while visible.
  if (getCurrentSettingsSection() !== 'ai-models') {
    stopLocalStatusPoller();
    return;
  }
  try {
    const status = await fetchLocalStatus(serverPort);
    renderSlots(status.slots);
    renderReachabilityError(status.launcher?.reachable);
    // Back off to slow polling once everything is serving (residents stay up,
    // so churn is low). Full re-sync happens on re-entry to the section.
    if (allServing(status.slots) && _localStatusPoller) {
      stopLocalStatusPoller();
      _localStatusPoller = setInterval(() => pollTick(serverPort), 10000);
    }
  } catch (err) {
    // Transient — let the next tick retry. Don't flash errors on the UI.
    console.warn('local-status poll failed:', err.message);
  }
}

function startLocalStatusPoller(serverPort, intervalMs = 2000) {
  stopLocalStatusPoller();
  _localPollTickHandler = () => pollTick(serverPort);
  _localStatusPoller = setInterval(_localPollTickHandler, intervalMs);
  // Fire once immediately so the UI updates without waiting for the first tick.
  pollTick(serverPort);
}

/**
 * Show/hide AI-section children based on the active ai_mode.
 *
 * Local slots card follows the toggle — only visible under local mode.
 * Provider Status and Model API Constraints stay visible in both modes;
 * their row-level content is filtered in loadRoutingUI / loadConstraintsUI
 * via currentModeRowFilter() so local mode shows only the Local row and
 * proprietary mode shows only the cloud providers.
 */
function applyModeVisibility(mode) {
  const isLocal = mode === 'local';
  const slotsEl = document.getElementById('localSlots');
  if (slotsEl) slotsEl.hidden = !isLocal;
  // Context limit: show only the input matching the active mode.
  const localRow = document.getElementById('contextLimitLocalRow');
  const propRow = document.getElementById('contextLimitProprietaryRow');
  if (localRow) localRow.hidden = !isLocal;
  if (propRow) propRow.hidden = isLocal;
  // CLI overhead rows mirror the same split — opencode and openhands are
  // local CLIs (visible in local mode), the rest are proprietary.
  const localOverheadRows = ['Opencode', 'Openhands'];
  for (const cli of localOverheadRows) {
    const row = document.getElementById(`cliOverhead${cli}Row`);
    if (row) row.hidden = !isLocal;
  }
  const proprietaryOverheadRows = ['Claude', 'Gemini', 'Codex', 'Grok'];
  for (const cli of proprietaryOverheadRows) {
    const row = document.getElementById(`cliOverhead${cli}Row`);
    if (row) row.hidden = isLocal;
  }
}

/**
 * Returns a filter predicate that keeps the statuses matching the current
 * ai_mode: local mode → only provider_id === 'local'; proprietary mode →
 * everything except 'local'. Reads the toggle checkbox since it's the
 * authoritative UI-side source after loadLocalModePanel initializes it.
 */
function currentModeRowFilter() {
  const toggle = document.getElementById('aiModeToggle');
  const isLocal = !!toggle?.checked;
  return (s) => isLocal ? s.provider_id === 'local' : s.provider_id !== 'local';
}

async function loadLocalModePanel(serverPort) {
  const toggle = document.getElementById('aiModeToggle');
  const slotsEl = document.getElementById('localSlots');
  if (!toggle || !slotsEl) return;

  // Initial state from current ai_mode.
  let status;
  try {
    status = await fetchLocalStatus(serverPort);
  } catch (err) {
    console.warn('Initial local-status fetch failed:', err.message);
    status = { ai_mode: 'proprietary', launcher: { reachable: false }, slots: [] };
  }

  const isLocal = status.ai_mode === 'local';
  toggle.checked = isLocal;
  applyModeVisibility(status.ai_mode);
  renderSlots(status.slots || []);
  renderReachabilityError(status.launcher?.reachable);

  if (isLocal) {
    startLocalStatusPoller(serverPort);
  }

  // Rebind change handler (loadAIModelsSettings may fire multiple times).
  toggle.onchange = async () => {
    const wantLocal = toggle.checked;
    const endpoint = wantLocal ? 'start' : 'stop';
    // Disable during the flip to prevent double-clicks racing the ensure calls.
    toggle.disabled = true;
    try {
      const res = await fetch(
        `http://localhost:${serverPort}/api/ai/local-mode/${endpoint}`,
        { method: 'POST' }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `local-mode/${endpoint} ${res.status}`);
      }
      applyModeVisibility(wantLocal ? 'local' : 'proprietary');
      if (wantLocal) {
        startLocalStatusPoller(serverPort);
      } else {
        stopLocalStatusPoller();
        renderReachabilityError(true); // clear any banner
      }
      // Refresh the rest of the AI panel so Model Priority redraws against
      // the new cascade (local vs proprietary) and Provider Status/Constraints
      // rehydrate correctly if the user flips back.
      await loadRoutingUI(serverPort);
    } catch (err) {
      console.error('Toggle local mode failed:', err);
      // Revert the checkbox so UI doesn't lie about state.
      toggle.checked = !wantLocal;
      const errEl = document.getElementById('aiModeError');
      if (errEl) {
        errEl.hidden = false;
        errEl.textContent = `Could not ${wantLocal ? 'start' : 'stop'} local mode: ${err.message}`;
      }
    } finally {
      toggle.disabled = false;
    }
  };
}

// --- Memory Context Limit panel ---

async function loadContextLimitsPanel(serverPort) {
  const localInput = document.getElementById('contextLimitLocalInput');
  const propInput = document.getElementById('contextLimitProprietaryInput');
  const errEl = document.getElementById('contextLimitError');
  if (!localInput || !propInput) return;

  // Per-CLI overhead inputs. Keyed by backendId so the bind function can map
  // input → settings key without a separate lookup.
  const overheadInputs = {
    opencode:  document.getElementById('cliOverheadOpencodeInput'),
    openhands: document.getElementById('cliOverheadOpenhandsInput'),
    claude:    document.getElementById('cliOverheadClaudeInput'),
    gemini:    document.getElementById('cliOverheadGeminiInput'),
    codex:     document.getElementById('cliOverheadCodexInput'),
    grok:      document.getElementById('cliOverheadGrokInput')
  };

  // Visibility is owned by applyModeVisibility(); load all values regardless
  // of current mode so flipping the toggle doesn't blank an input.
  try {
    const res = await fetch(`http://localhost:${serverPort}/api/settings/context-limits`);
    if (!res.ok) throw new Error(`context-limits ${res.status}`);
    const { localTokens, proprietaryTokens, cliOverhead = {} } = await res.json();
    localInput.value = localTokens;
    propInput.value = proprietaryTokens;
    for (const [backendId, input] of Object.entries(overheadInputs)) {
      if (input && cliOverhead[backendId] != null) input.value = cliOverhead[backendId];
    }
  } catch (err) {
    console.warn('Failed to load context limits:', err.message);
    return;
  }

  const showError = (msg) => {
    if (!errEl) return;
    errEl.hidden = false;
    errEl.textContent = msg;
  };
  const clearError = () => {
    if (!errEl) return;
    errEl.hidden = true;
    errEl.textContent = '';
  };

  // Save-on-blur for budget inputs. Each input PATCHes only its own field.
  // The server validates the range; on rejection we restore the previous value.
  const bindBudgetInput = (input, fieldName) => {
    let prev = input.value;
    input.addEventListener('focus', () => { prev = input.value; clearError(); });
    input.addEventListener('blur', async () => {
      const next = input.value.trim();
      if (next === prev) return;
      const n = parseInt(next, 10);
      if (!Number.isFinite(n)) {
        input.value = prev;
        showError('Enter a whole number.');
        return;
      }
      try {
        const res = await fetch(`http://localhost:${serverPort}/api/settings/context-limits`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [fieldName]: n })
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        const updated = await res.json();
        input.value = fieldName === 'localTokens' ? updated.localTokens : updated.proprietaryTokens;
        prev = input.value;
        clearError();
      } catch (err) {
        input.value = prev;
        showError(err.message);
      }
    });
  };

  // Save-on-blur for CLI overhead inputs. Same shape, different PATCH body.
  const bindOverheadInput = (input, backendId) => {
    let prev = input.value;
    input.addEventListener('focus', () => { prev = input.value; clearError(); });
    input.addEventListener('blur', async () => {
      const next = input.value.trim();
      if (next === prev) return;
      const n = parseInt(next, 10);
      if (!Number.isFinite(n)) {
        input.value = prev;
        showError('Enter a whole number.');
        return;
      }
      try {
        const res = await fetch(`http://localhost:${serverPort}/api/settings/context-limits`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cliOverhead: { [backendId]: n } })
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        const updated = await res.json();
        input.value = updated.cliOverhead?.[backendId] ?? n;
        prev = input.value;
        clearError();
      } catch (err) {
        input.value = prev;
        showError(err.message);
      }
    });
  };

  bindBudgetInput(localInput, 'localTokens');
  bindBudgetInput(propInput, 'proprietaryTokens');
  for (const [backendId, input] of Object.entries(overheadInputs)) {
    if (input) bindOverheadInput(input, backendId);
  }
}

// Current cascade task type for tab state
let currentCascadeTask = 'conversation';

async function loadRoutingUI(serverPort) {
  try {
    const [statusRes, prefRes] = await Promise.all([
      fetch(`http://localhost:${serverPort}/api/ai/account-status`),
      fetch(`http://localhost:${serverPort}/api/ai/routing/preference`)
    ]);
    const statuses = await statusRes.json();
    const { preferences } = await prefRes.json();

    // Filter rows by current ai_mode — local mode shows only the Local
    // provider; proprietary mode shows only the cloud providers.
    const displayedStatuses = statuses.filter(currentModeRowFilter());

    // Provider status table
    const bodyEl = document.getElementById('providerStatusBody');
    if (bodyEl) {
      bodyEl.innerHTML = displayedStatuses.map(s => {
        const hasLogin = !!s.has_login;

        // Login column
        let loginIcon, loginTip, loginClickable;
        if (!hasLogin) {
          loginIcon = '—';
          loginTip = 'API-only (no login)';
          loginClickable = false;
        } else if (s.login_status === 'active') {
          loginIcon = '🟢';
          loginTip = 'Logged in' + (s.plan_tier ? ` (${s.plan_tier})` : '') + ' — click to re-login';
          loginClickable = true;
        } else if (s.login_status === 'unknown') {
          loginIcon = '🟡';
          loginTip = 'Not checked — click to log in';
          loginClickable = true;
        } else {
          loginIcon = '🔴';
          loginTip = (s.login_status === 'not_configured' ? 'Not logged in' : 'Login inactive') + ' — click to log in';
          loginClickable = true;
        }

        // API column
        const apiIcon = s.api_status === 'valid' ? '🟢'
          : s.api_status === 'unknown' ? '🟡'
          : '🔴';
        const apiTip = s.api_status === 'valid' ? 'Key valid' + (s.api_balance != null ? ` ($${s.api_balance.toFixed(2)})` : '') + ' — click to manage'
          : s.api_status === 'no_key' ? 'No key set — click to add'
          : s.api_status === 'invalid' ? 'Key invalid — click to fix'
          : 'Unknown — click to manage';

        const loginClass = loginClickable ? 'provider-login-link' : '';
        return `<tr>
          <td class="provider-row-name">${s.provider_name}</td>
          <td class="provider-row-status ${loginClass}" title="${loginTip}" data-backend="${s.container_id || ''}">${loginIcon}</td>
          <td class="provider-row-status provider-api-link" title="${apiTip}" data-provider="${s.provider_id}">${apiIcon}</td>
        </tr>`;
      }).join('');

      // Make login cells clickable → trigger login flow
      bodyEl.querySelectorAll('.provider-login-link').forEach(cell => {
        cell.style.cursor = 'pointer';
        cell.onclick = async () => {
          const backend = cell.dataset.backend;
          if (!backend) return;
          const origContent = cell.innerHTML;
          cell.innerHTML = '⏳';
          cell.title = 'Logging in...';
          try {
            const resp = await fetch(`http://localhost:${serverPort}/api/backend/login/${backend}`, { method: 'POST' });
            if (resp.ok) {
              cell.innerHTML = '🟢';
              cell.title = 'Logged in — refreshing...';
              await loadRoutingUI(serverPort);
            } else {
              const err = await resp.json().catch(() => ({}));
              cell.innerHTML = '🔴';
              cell.title = `Login failed: ${err.error || 'unknown error'}`;
            }
          } catch (e) {
            cell.innerHTML = origContent;
            cell.title = `Login error: ${e.message}`;
          }
        };
      });

      // Make API cells clickable → navigate to API Keys section
      bodyEl.querySelectorAll('.provider-api-link').forEach(cell => {
        cell.onclick = () => {
          document.querySelectorAll('.settings-nav-item').forEach(nav => {
            nav.classList.toggle('active', nav.dataset.section === 'apikeys');
          });
          document.querySelectorAll('.settings-section').forEach(sec => sec.classList.remove('active'));
          const apiSection = document.getElementById('section-apikeys');
          if (apiSection) apiSection.classList.add('active');
        };
      });
    }

    // Billing check button
    const checkBtn = document.getElementById('billingCheckBtn');
    if (checkBtn) {
      checkBtn.onclick = async () => {
        checkBtn.textContent = 'Checking...';
        checkBtn.disabled = true;
        try {
          await fetch(`http://localhost:${serverPort}/api/ai/billing/check`, { method: 'POST' });
          await loadRoutingUI(serverPort);
        } finally {
          checkBtn.textContent = 'Check All';
          checkBtn.disabled = false;
        }
      };
    }

    // Store per-task preferences
    const taskPreferences = preferences || {};

    // Helper to update preference dropdown for current task
    function updatePrefSelect(taskType) {
      const select = document.getElementById('routingPreferenceSelect');
      if (!select) return;
      select.value = taskPreferences[taskType] || 'balanced';
    }

    // Preference dropdown — sets per-task preference
    const prefSelect = document.getElementById('routingPreferenceSelect');
    if (prefSelect) {
      prefSelect.onchange = async () => {
        const pref = prefSelect.value;
        taskPreferences[currentCascadeTask] = pref;
        await fetch(`http://localhost:${serverPort}/api/ai/routing/preference`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ preference: pref, taskType: currentCascadeTask })
        });
        await loadCascade(serverPort, currentCascadeTask);
      };
    }

    // Set initial dropdown state
    updatePrefSelect(currentCascadeTask);

    // Cascade tabs
    const tabsEl = document.getElementById('cascadeTabs');
    if (tabsEl) {
      tabsEl.querySelectorAll('.cascade-tab').forEach(tab => {
        tab.onclick = () => {
          tabsEl.querySelectorAll('.cascade-tab').forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
          currentCascadeTask = tab.dataset.task;
          updatePrefSelect(currentCascadeTask);
          loadCascade(serverPort, currentCascadeTask);
        };
      });
    }

    // Regenerate button
    const regenBtn = document.getElementById('cascadeRegenerateBtn');
    if (regenBtn) {
      regenBtn.onclick = async () => {
        await fetch(`http://localhost:${serverPort}/api/ai/routing/regenerate`, { method: 'POST' });
        await loadCascade(serverPort, currentCascadeTask);
      };
    }

    // Load constraints table (same row filter as Provider Status).
    await loadConstraintsUI(serverPort, displayedStatuses);

    // Load initial cascade
    await loadCascade(serverPort, currentCascadeTask);
  } catch (err) {
    console.error('Failed to load routing UI:', err);
  }
}

async function loadConstraintsUI(serverPort, statuses) {
  try {
    const res = await fetch(`http://localhost:${serverPort}/api/ai/routing/constraints`);
    const constraints = await res.json();
    const bodyEl = document.getElementById('apiConstraintsBody');
    if (!bodyEl) return;

    const taskTypes = [
      { key: 'conversation', label: 'Chat' },
      { key: 'jobs', label: 'Jobs' },
      { key: 'planning', label: 'Planning' },
      { key: 'coding', label: 'Coding' },
      { key: 'summary', label: 'Summary' },
      { key: 'image', label: 'Image' }
    ];
    const options = [
      { value: 'both', label: 'Login & API' },
      { value: 'api', label: 'API only' },
      { value: 'login', label: 'Login only' }
    ];

    bodyEl.innerHTML = statuses.map(s => {
      const cells = taskTypes.map(tt => {
        const current = constraints[s.provider_id]?.[tt.key] || 'both';
        const opts = options.map(o =>
          `<option value="${o.value}"${o.value === current ? ' selected' : ''}>${o.label}</option>`
        ).join('');
        return `<td style="text-align:center;padding:5px 4px;"><select class="constraint-select" data-provider="${s.provider_id}" data-task="${tt.key}">${opts}</select></td>`;
      }).join('');
      return `<tr><td class="provider-row-name">${s.provider_name}</td>${cells}</tr>`;
    }).join('');

    bodyEl.querySelectorAll('.constraint-select').forEach(sel => {
      sel.onchange = async () => {
        const newConstraints = {};
        bodyEl.querySelectorAll('.constraint-select').forEach(s => {
          const pid = s.dataset.provider;
          const tt = s.dataset.task;
          if (!newConstraints[pid]) newConstraints[pid] = {};
          newConstraints[pid][tt] = s.value;
        });
        await fetch(`http://localhost:${serverPort}/api/ai/routing/constraints`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ constraints: newConstraints })
        });
        await loadCascade(serverPort, currentCascadeTask);
      };
    });
  } catch (err) {
    console.error('Failed to load constraints UI:', err);
  }
}

async function loadCascade(serverPort, taskType) {
  try {
    let res = await fetch(`http://localhost:${serverPort}/api/ai/routing/${taskType}`);
    let cascade = await res.json();

    // Auto-regenerate if cascade is empty
    if (Array.isArray(cascade) && cascade.length === 0) {
      await fetch(`http://localhost:${serverPort}/api/ai/routing/regenerate`, { method: 'POST' });
      res = await fetch(`http://localhost:${serverPort}/api/ai/routing/${taskType}`);
      cascade = await res.json();
    }

    const bodyEl = document.getElementById('cascadeBody');
    if (!bodyEl) return;

    const capCol = taskType === 'conversation' ? 'cap_chat' : `cap_${taskType}`;

    bodyEl.innerHTML = cascade.map((entry, idx) => {
      const f = entry.family;
      const s = entry.accountStatus;
      const capValue = f ? (f[capCol] || 0) : 0;
      const costValue = f ? (f.cost_tier || 3) : 3;
      // Login entries show discounted cost
      const displayCost = entry.access_method === 'login' ? Math.ceil(costValue / 2) : costValue;

      // Status dot based on access method + provider status
      let statusIcon;
      if (entry.access_method === 'login') {
        statusIcon = s?.login_status === 'active' ? '🟢' : s?.login_status === 'unknown' ? '🟡' : '🔴';
      } else {
        statusIcon = s?.api_status === 'valid' ? '🟢' : s?.api_status === 'unknown' ? '🟡' : '🔴';
      }

      const capDots = Array.from({ length: 5 }, (_, i) =>
        `<span class="cap-dot${i < capValue ? ' filled' : ''}"></span>`
      ).join('');
      const costDots = Array.from({ length: 5 }, (_, i) =>
        `<span class="cost-dot${i < displayCost ? ' filled' : ''}"></span>`
      ).join('');

      const name = f ? f.display_name : entry.family_id;
      const methodLabel = entry.access_method === 'login' ? 'Login' : 'API';
      const disabledClass = entry.enabled ? '' : ' cascade-row-disabled';
      const toggleChecked = entry.enabled ? 'checked' : '';
      // Local-mode chat tasks collapse to a single row that mirrors the
      // launcher's chooser. Lock it: dragging would do nothing with one
      // row, and disabling the toggle would leave dispatch with no target.
      const isLauncherRow = !!entry.local_launcher_selection;
      const draggableAttr = isLauncherRow ? 'false' : 'true';
      const toggleDisabledAttr = isLauncherRow ? 'disabled' : '';
      const toggleTitle = isLauncherRow
        ? ' title="Set in os8-launcher\'s triplet chooser"'
        : '';

      return `<tr class="cascade-row${disabledClass}" data-idx="${idx}" data-family="${entry.family_id}" data-method="${entry.access_method}" draggable="${draggableAttr}">
        <td class="cascade-td-rank">${idx + 1}</td>
        <td class="cascade-td-status">${statusIcon}</td>
        <td class="cascade-td-name">${name} <span class="cascade-method-label">${methodLabel}</span></td>
        <td class="cascade-td-cap">${capDots}</td>
        <td class="cascade-td-cost">${costDots}</td>
        <td class="cascade-td-toggle"${toggleTitle}><label class="cascade-switch"><input type="checkbox" ${toggleChecked} ${toggleDisabledAttr}><span class="cascade-slider"></span></label></td>
      </tr>`;
    }).join('');

    // Caption under the table when this is a launcher-driven row — gives
    // the user a path back to where the selection actually lives.
    const hasLauncherRow = cascade.some(c => c.local_launcher_selection);
    const captionEl = document.getElementById('cascadeCaption');
    if (captionEl) {
      if (hasLauncherRow) {
        captionEl.hidden = false;
        captionEl.innerHTML = 'Set in os8-launcher\'s triplet chooser. <a href="#" id="cascadeOpenChooser">Open chooser ↗</a>';
        const link = captionEl.querySelector('#cascadeOpenChooser');
        if (link) {
          link.onclick = async (e) => {
            e.preventDefault();
            try {
              const port = await window.os8.server.getPort();
              await fetch(`http://localhost:${port}/api/open-external`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: 'http://localhost:9000/triplet.html' })
              });
            } catch (err) {
              console.warn('Failed to open launcher chooser:', err.message);
            }
          };
        }
      } else {
        captionEl.hidden = true;
        captionEl.innerHTML = '';
      }
    }

    // Toggle handlers (skip launcher-locked rows — input is disabled anyway).
    bodyEl.querySelectorAll('.cascade-switch input:not([disabled])').forEach(input => {
      input.onchange = async () => {
        const row = input.closest('.cascade-row');
        row.classList.toggle('cascade-row-disabled', !input.checked);
        await saveCascade(serverPort, taskType);
      };
    });

    // Drag-and-drop reordering (skip launcher-locked rows — draggable=false on those).
    let dragIdx = null;
    bodyEl.querySelectorAll('.cascade-row[draggable="true"]').forEach(row => {
      row.addEventListener('dragstart', (e) => {
        dragIdx = parseInt(row.dataset.idx);
        e.dataTransfer.effectAllowed = 'move';
        row.style.opacity = '0.5';
      });
      row.addEventListener('dragend', () => {
        row.style.opacity = '1';
      });
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      });
      row.addEventListener('drop', async (e) => {
        e.preventDefault();
        const dropIdx = parseInt(row.dataset.idx);
        if (dragIdx === null || dragIdx === dropIdx) return;
        const rows = [...bodyEl.querySelectorAll('.cascade-row')];
        const draggedRow = rows[dragIdx];
        if (dragIdx < dropIdx) {
          row.after(draggedRow);
        } else {
          row.before(draggedRow);
        }
        bodyEl.querySelectorAll('.cascade-row').forEach((el, i) => {
          el.dataset.idx = i;
          el.querySelector('.cascade-td-rank').textContent = i + 1;
        });
        await saveCascade(serverPort, taskType);
        dragIdx = null;
      });
    });
  } catch (err) {
    console.error('Failed to load cascade:', err);
  }
}

async function saveCascade(serverPort, taskType) {
  const bodyEl = document.getElementById('cascadeBody');
  if (!bodyEl) return;
  const entries = [...bodyEl.querySelectorAll('.cascade-row')].map(row => ({
    family_id: row.dataset.family,
    access_method: row.dataset.method,
    enabled: row.querySelector('.cascade-switch input').checked
  }));
  await fetch(`http://localhost:${serverPort}/api/ai/routing/${taskType}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries })
  });
}


/**
 * Initialize settings event listeners
 */
export function initSettingsListeners() {
  const oauthPortUnlock = document.getElementById('oauthPortUnlock');
  const oauthPortInput = document.getElementById('oauthPortInput');
  const oauthPortSave = document.getElementById('oauthPortSave');
  // Settings nav click handlers
  document.querySelectorAll('.settings-nav-item').forEach(item => {
    item.addEventListener('click', () => {
      switchSettingsSection(item.dataset.section);
    });
  });

  // Timezone change handler
  const timezoneSelect = document.getElementById('timezoneSelect');
  if (timezoneSelect) {
    timezoneSelect.addEventListener('change', async () => {
      const serverPort = await window.os8.server.getPort();
      fetch(`http://localhost:${serverPort}/api/settings/time`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timezone: timezoneSelect.value })
      }).catch(err => console.error('Failed to save timezone:', err));
      // Notify clock to update
      window.dispatchEvent(new CustomEvent('os8:timezone-changed', { detail: { timezone: timezoneSelect.value } }));
    });
  }

  // OAuth port handlers
  if (oauthPortUnlock) {
    oauthPortUnlock.addEventListener('change', () => {
      const unlocked = oauthPortUnlock.checked;
      oauthPortInput.disabled = !unlocked;
      oauthPortSave.disabled = !unlocked;
    });
  }

  if (oauthPortInput) {
    oauthPortInput.addEventListener('input', () => {
      updateOAuthPortWarning();
    });
  }

  if (oauthPortSave) {
    oauthPortSave.addEventListener('click', saveOAuthPort);
  }

  // PR 3.5 — App Store save button
  const appStoreSaveBtn = document.getElementById('appStoreSaveBtn');
  if (appStoreSaveBtn) {
    appStoreSaveBtn.addEventListener('click', saveAppStoreSettings);
  }

  // Tunnel URL handler
  const tunnelUrlCopy = document.getElementById('tunnelUrlCopy');
  if (tunnelUrlCopy) {
    tunnelUrlCopy.addEventListener('click', copyTunnelUrl);
  }

  // API Keys handlers (delegated to api-keys.js)
  initApiKeysListeners();

  // Voice settings handlers
  const voiceSaveBtn = document.getElementById('voiceSaveBtn');
  if (voiceSaveBtn) {
    voiceSaveBtn.addEventListener('click', saveVoiceSettings);
  }

  // Voice sliders update display values on input
  ['voiceSilenceNormal', 'voiceSilenceShort', 'voiceContextWindow', 'voiceVadSilence'].forEach(id => {
    const slider = document.getElementById(id);
    if (slider) {
      slider.addEventListener('input', updateVoiceDisplayValues);
    }
  });

  // User first name — debounced save
  const userFirstNameInput = document.getElementById('userFirstNameInput');
  if (userFirstNameInput) {
    let userNameTimer;
    userFirstNameInput.addEventListener('input', () => {
      clearTimeout(userNameTimer);
      userNameTimer = setTimeout(async () => {
        const serverPort = await window.os8.server.getPort();
        fetch(`http://localhost:${serverPort}/api/settings/user`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ firstName: userFirstNameInput.value })
        }).catch(err => console.error('Failed to save user name:', err));
      }, 500);
    });
  }

  // User photo upload
  const userPhotoInput = document.getElementById('userPhotoInput');
  if (userPhotoInput) {
    userPhotoInput.addEventListener('change', async () => {
      const file = userPhotoInput.files?.[0];
      if (!file) return;
      const formData = new FormData();
      formData.append('image', file);
      try {
        const serverPort = await window.os8.server.getPort();
        await fetch(`http://localhost:${serverPort}/api/settings/user-image`, { method: 'POST', body: formData });
        const img = document.getElementById('userPhotoPreview');
        if (img) { img.src = `http://localhost:${serverPort}/api/settings/user-image?t=${Date.now()}`; img.style.display = 'block'; }
      } catch (err) {
        console.error('Failed to upload user photo:', err);
      }
      userPhotoInput.value = '';
    });
  }

  // User photo remove
  const userPhotoRemove = document.getElementById('userPhotoRemove');
  if (userPhotoRemove) {
    userPhotoRemove.addEventListener('click', async () => {
      try {
        const serverPort = await window.os8.server.getPort();
        await fetch(`http://localhost:${serverPort}/api/settings/user-image`, { method: 'DELETE' });
        const img = document.getElementById('userPhotoPreview');
        if (img) img.style.display = 'none';
      } catch (err) {
        console.error('Failed to remove user photo:', err);
      }
    });
  }

  // AI Models toggle handlers are now bound dynamically in loadAIModelsSettings()

  // Privacy toggle handlers
  const privacyToggles = [
    { id: 'privacyTelemetry', envKey: 'DISABLE_TELEMETRY' },
    { id: 'privacyErrorReporting', envKey: 'DISABLE_ERROR_REPORTING' },
    { id: 'privacyFeedbackSurvey', envKey: 'CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY' },
    { id: 'privacyCodexAnalytics', envKey: 'CODEX_DISABLE_ANALYTICS' },
    { id: 'privacyCodexFeedback', envKey: 'CODEX_DISABLE_FEEDBACK' },
    { id: 'privacyCodexHistory', envKey: 'CODEX_DISABLE_HISTORY' },
    { id: 'privacyGeminiTelemetry', envKey: 'GEMINI_TELEMETRY_ENABLED', invert: true },
    { id: 'privacyGeminiPromptLogging', envKey: 'GEMINI_TELEMETRY_LOG_PROMPTS', invert: true },
  ];
  for (const { id, envKey, invert } of privacyToggles) {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', async () => {
        if (invert) {
          // Inverted: toggle ON → set to 'false' (disables the feature)
          if (el.checked) {
            await window.os8.env.set(envKey, 'false', 'Privacy setting');
          } else {
            await window.os8.env.delete(envKey);
          }
        } else {
          if (el.checked) {
            await window.os8.env.set(envKey, '1', 'Privacy setting');
          } else {
            await window.os8.env.delete(envKey);
          }
        }
      });
    }
  }

}

