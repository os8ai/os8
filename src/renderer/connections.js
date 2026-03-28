/**
 * Connections and OAuth wizard management for OS8
 */

import {
  getConnections, setConnections,
  getProviders, setProviders,
  getWizardState, setWizardState, updateWizardState
} from './state.js';

// Wizard step definitions
const WIZARD_STEPS = [
  { title: 'Choose Provider', key: 'provider' },
  { title: 'Setup Guide', key: 'guide' },
  { title: 'Enter Credentials', key: 'credentials' },
  { title: 'Add Test User', key: 'testuser' },
  { title: 'Select Permissions', key: 'scopes' },
  { title: 'Connected!', key: 'success' }
];

/**
 * Load providers from the API
 */
export async function loadProviders() {
  setProviders(await window.os8.connections.getProviders());
}

/**
 * Load connections from the API and render the list
 */
export async function loadConnections() {
  setConnections(await window.os8.connections.list());
  renderConnectionsList();
}

/**
 * Render the connections list in settings
 */
export function renderConnectionsList() {
  const container = document.getElementById('connectionsList');
  if (!container) return;

  if (getConnections().length === 0) {
    container.innerHTML = '<div class="empty-connections">No connections yet. Add one to get started.</div>';
    return;
  }

  container.innerHTML = getConnections().map(conn => {
    const providerConfig = getProviders()[conn.provider] || { name: conn.provider, icon: '' };
    const scopeNames = conn.scopes.map(s => providerConfig.scopes?.[s]?.name || s).join(', ');
    return `
      <div class="surface-lg connection-item" data-connection-id="${conn.id}">
        <div class="connection-icon">${providerConfig.icon || ''}</div>
        <div class="connection-info">
          <div class="connection-account">${conn.account_id || 'Connected'}</div>
          <div class="connection-scopes">${scopeNames || 'No specific permissions'}</div>
        </div>
        <button class="connection-disconnect" data-connection-id="${conn.id}">Disconnect</button>
      </div>
    `;
  }).join('');

  // Add disconnect handlers
  container.querySelectorAll('.connection-disconnect').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const connId = btn.dataset.connectionId;
      if (confirm('Disconnect this account? Apps using this connection will lose access.')) {
        await window.os8.connections.delete(connId);
        await loadConnections();
      }
    });
  });
}

/**
 * Open the connection wizard modal
 */
export function openConnectionWizard() {
  setWizardState({
    step: 0,
    provider: null,
    credentials: { clientId: '', clientSecret: '' },
    selectedScopes: [],
    connectionResult: null
  });
  renderWizardStep();
  document.getElementById('connectionWizardModal').classList.add('active');
}

/**
 * Close the connection wizard modal
 */
export function closeConnectionWizard() {
  document.getElementById('connectionWizardModal').classList.remove('active');
}

/**
 * Render the current wizard step
 */
export function renderWizardStep() {
  const stepConfig = WIZARD_STEPS[getWizardState().step];

  // Update step indicator
  const indicatorEl = document.getElementById('wizardStepIndicator');
  indicatorEl.innerHTML = WIZARD_STEPS.map((_, i) => {
    let cls = 'wizard-step-dot';
    if (i < getWizardState().step) cls += ' completed';
    if (i === getWizardState().step) cls += ' active';
    return `<div class="${cls}"></div>`;
  }).join('');

  // Update title
  document.getElementById('wizardTitle').textContent = stepConfig.title;

  // Render content
  const contentEl = document.getElementById('wizardContent');
  const actionsEl = document.getElementById('wizardActions');

  switch (stepConfig.key) {
    case 'provider':
      renderProviderStep(contentEl, actionsEl);
      break;
    case 'guide':
      renderGuideStep(contentEl, actionsEl);
      break;
    case 'credentials':
      renderCredentialsStep(contentEl, actionsEl);
      break;
    case 'testuser':
      renderTestUserStep(contentEl, actionsEl);
      break;
    case 'scopes':
      renderScopesStep(contentEl, actionsEl);
      break;
    case 'success':
      renderSuccessStep(contentEl, actionsEl);
      break;
  }
}

/**
 * Render the provider selection step
 */
function renderProviderStep(contentEl, actionsEl) {
  const providerList = Object.entries(getProviders());

  contentEl.innerHTML = `
    <div class="provider-grid">
      ${providerList.map(([key, config]) => `
        <div class="provider-option ${getWizardState().provider === key ? 'selected' : ''}" data-provider="${key}">
          <div class="provider-icon">${config.icon}</div>
          <div class="provider-name">${config.name}</div>
        </div>
      `).join('')}
      <div class="provider-option disabled">
        <div class="provider-icon" style="background: #334155; color: #64748b;">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>
          </svg>
        </div>
        <div class="provider-name">More Coming</div>
        <div class="provider-status">Soon</div>
      </div>
    </div>
  `;

  // Add click handlers
  contentEl.querySelectorAll('.provider-option:not(.disabled)').forEach(opt => {
    opt.addEventListener('click', () => {
      updateWizardState({ provider: opt.dataset.provider });
      contentEl.querySelectorAll('.provider-option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      updateWizardButtons();
    });
  });

  actionsEl.innerHTML = `
    <div></div>
    <button class="wizard-btn wizard-btn-next" id="wizardNext" ${!getWizardState().provider ? 'disabled' : ''}>Next</button>
  `;

  setupWizardNavigation();
}

/**
 * Render the setup guide step
 */
function renderGuideStep(contentEl, actionsEl) {
  const providerConfig = getProviders()[getWizardState().provider];
  const guide = providerConfig.setupGuide;

  contentEl.innerHTML = `
    <p style="margin-bottom: 16px; color: #94a3b8; font-size: 13px;">
      Follow these steps to set up your ${providerConfig.name} OAuth app:
    </p>
    <div class="setup-checklist">
      ${guide.steps.map((step, i) => `
        <div class="setup-step">
          <div class="setup-step-number">${i + 1}</div>
          <div class="setup-step-text">
            ${step.link ? `<a href="${step.link}" target="_blank">${step.text}</a>` : step.text}
          </div>
        </div>
      `).join('')}
    </div>
  `;

  actionsEl.innerHTML = `
    <button class="wizard-btn wizard-btn-back" id="wizardBack">Back</button>
    <button class="wizard-btn wizard-btn-next" id="wizardNext">Next</button>
  `;

  setupWizardNavigation();
}

/**
 * Render the credentials entry step
 */
async function renderCredentialsStep(contentEl, actionsEl) {
  // Check if credentials already exist
  const existing = await window.os8.connections.getProviderCredentials(getWizardState().provider);
  getWizardState().existingCredentials = existing; // Track for later
  if (existing) {
    getWizardState().credentials.clientId = existing.client_id;
    getWizardState().credentials.clientSecret = existing.client_secret;
  }

  const existingSecret = existing ? existing.client_secret : '';

  contentEl.innerHTML = `
    <div class="credentials-form">
      <div class="credentials-field">
        <label>Client ID</label>
        <input type="text" class="surface" id="credentialClientId" placeholder="Enter your OAuth Client ID" value="${getWizardState().credentials.clientId}">
      </div>
      <div class="credentials-field">
        <label>Client Secret</label>
        <div class="password-input-wrapper">
          <input type="password" class="surface" id="credentialClientSecret" placeholder="Enter your OAuth Client Secret">
          <button type="button" class="password-toggle" id="toggleSecretVisibility" title="Show/hide secret">
            <svg class="eye-open" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
            </svg>
            <svg class="eye-closed" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display:none;">
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  `;

  // Input handlers
  const clientIdInput = document.getElementById('credentialClientId');
  const clientSecretInput = document.getElementById('credentialClientSecret');

  // Set secret value via JS (avoids HTML escaping issues with special chars)
  if (existingSecret) {
    clientSecretInput.value = existingSecret;
  }

  // Prevent click events from bubbling to modal overlay
  [clientIdInput, clientSecretInput].forEach(input => {
    input.addEventListener('mousedown', (e) => e.stopPropagation());
    input.addEventListener('click', (e) => e.stopPropagation());
  });

  clientIdInput.addEventListener('input', () => {
    getWizardState().credentials.clientId = clientIdInput.value;
    updateWizardButtons();
  });

  clientSecretInput.addEventListener('input', () => {
    getWizardState().credentials.clientSecret = clientSecretInput.value;
    updateWizardButtons();
  });

  // Password visibility toggle
  const toggleBtn = document.getElementById('toggleSecretVisibility');
  const eyeOpen = toggleBtn.querySelector('.eye-open');
  const eyeClosed = toggleBtn.querySelector('.eye-closed');

  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isPassword = clientSecretInput.type === 'password';
    clientSecretInput.type = isPassword ? 'text' : 'password';
    eyeOpen.style.display = isPassword ? 'none' : 'block';
    eyeClosed.style.display = isPassword ? 'block' : 'none';
  });

  const hasExisting = !!existing;
  const canProceed = getWizardState().credentials.clientId && (getWizardState().credentials.clientSecret || hasExisting);

  actionsEl.innerHTML = `
    <button class="wizard-btn wizard-btn-back" id="wizardBack">Back</button>
    <button class="wizard-btn wizard-btn-next" id="wizardNext" ${!canProceed ? 'disabled' : ''}>Next</button>
  `;

  setupWizardNavigation();
}

/**
 * Render the test user step
 */
function renderTestUserStep(contentEl, actionsEl) {
  contentEl.innerHTML = `
    <div class="testuser-step">
      <div class="testuser-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
          <circle cx="9" cy="7" r="4"/>
          <path d="M22 21v-2a4 4 0 0 0-3-3.87"/>
          <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
      </div>
      <h3 style="margin: 16px 0 8px; color: #e2e8f0;">Add Yourself as a Test User</h3>
      <p style="color: #94a3b8; font-size: 13px; margin-bottom: 20px; line-height: 1.5;">
        Since your app is in testing mode, you need to add your email as an authorized test user.
      </p>
      <div class="testuser-steps">
        <div class="testuser-step-item">
          <span class="testuser-step-num">1</span>
          <span>Go to Google Auth Platform → Audience</span>
        </div>
        <div class="testuser-step-item">
          <span class="testuser-step-num">2</span>
          <span>Under "Test users", click Add Users</span>
        </div>
        <div class="testuser-step-item">
          <span class="testuser-step-num">3</span>
          <span>Enter your email address and save</span>
        </div>
      </div>
    </div>
  `;

  actionsEl.innerHTML = `
    <button class="wizard-btn wizard-btn-back" id="wizardBack">Back</button>
    <button class="wizard-btn wizard-btn-next" id="wizardNext">Next</button>
  `;

  setupWizardNavigation();
}

/**
 * Render the scopes selection step
 */
function renderScopesStep(contentEl, actionsEl) {
  const providerConfig = getProviders()[getWizardState().provider];
  const scopes = Object.entries(providerConfig.scopes);

  // Default: select all scopes if none selected yet
  if (getWizardState().selectedScopes.length === 0) {
    getWizardState().selectedScopes = scopes.map(([key]) => key);
  }

  contentEl.innerHTML = `
    <p style="margin-bottom: 16px; color: #94a3b8; font-size: 13px;">
      Select which permissions to grant. You can change these later.
    </p>
    <div class="scopes-grid">
      ${scopes.map(([key, scope]) => `
        <div class="surface scope-option ${getWizardState().selectedScopes.includes(key) ? 'selected' : ''}" data-scope="${key}">
          <div class="scope-checkbox">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </div>
          <div class="scope-info">
            <div class="scope-name">${scope.name}</div>
            <div class="scope-description">${scope.description}</div>
          </div>
        </div>
      `).join('')}
    </div>
  `;

  // Add click handlers
  contentEl.querySelectorAll('.scope-option').forEach(opt => {
    opt.addEventListener('click', () => {
      const scope = opt.dataset.scope;
      const idx = getWizardState().selectedScopes.indexOf(scope);
      if (idx >= 0) {
        getWizardState().selectedScopes.splice(idx, 1);
        opt.classList.remove('selected');
      } else {
        getWizardState().selectedScopes.push(scope);
        opt.classList.add('selected');
      }
      updateWizardButtons();
    });
  });

  actionsEl.innerHTML = `
    <button class="wizard-btn wizard-btn-back" id="wizardBack">Back</button>
    <button class="wizard-btn wizard-btn-next" id="wizardNext" ${getWizardState().selectedScopes.length === 0 ? 'disabled' : ''}>Connect</button>
  `;

  setupWizardNavigation();
}

/**
 * Render the success step
 */
function renderSuccessStep(contentEl, actionsEl) {
  const result = getWizardState().connectionResult;

  contentEl.innerHTML = `
    <div class="wizard-success">
      <div class="wizard-success-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      </div>
      <div class="wizard-success-title">Connected Successfully!</div>
      <div class="wizard-success-email">${result?.accountId || 'Account connected'}</div>
    </div>
  `;

  actionsEl.innerHTML = `
    <div></div>
    <button class="wizard-btn wizard-btn-next" id="wizardFinish">Done</button>
  `;

  document.getElementById('wizardFinish').addEventListener('click', async () => {
    closeConnectionWizard();
    await loadConnections();
  });
}

/**
 * Update wizard button states based on current step
 */
export function updateWizardButtons() {
  const nextBtn = document.getElementById('wizardNext');
  if (!nextBtn) return;

  const stepKey = WIZARD_STEPS[getWizardState().step].key;
  let canProceed = false;

  switch (stepKey) {
    case 'provider':
      canProceed = !!getWizardState().provider;
      break;
    case 'guide':
      canProceed = true;
      break;
    case 'credentials':
      // Can proceed if clientId exists AND (new secret entered OR existing credentials exist)
      canProceed = getWizardState().credentials.clientId &&
        (getWizardState().credentials.clientSecret || getWizardState().existingCredentials);
      break;
    case 'testuser':
      canProceed = true;
      break;
    case 'scopes':
      canProceed = getWizardState().selectedScopes.length > 0;
      break;
  }

  nextBtn.disabled = !canProceed;
}

/**
 * Setup wizard navigation button handlers
 */
export function setupWizardNavigation() {
  const backBtn = document.getElementById('wizardBack');
  const nextBtn = document.getElementById('wizardNext');

  if (backBtn) {
    backBtn.addEventListener('click', () => {
      if (getWizardState().step > 0) {
        getWizardState().step--;
        renderWizardStep();
      }
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', async () => {
      const stepKey = WIZARD_STEPS[getWizardState().step].key;

      // Handle special actions before advancing
      if (stepKey === 'credentials') {
        // Save credentials
        const newSecret = getWizardState().credentials.clientSecret;
        const existingSecret = getWizardState().existingCredentials?.client_secret;
        const secretToSave = newSecret || existingSecret;

        if (getWizardState().credentials.clientId && secretToSave) {
          await window.os8.connections.setProviderCredentials(
            getWizardState().provider,
            getWizardState().credentials.clientId,
            secretToSave
          );
        }
      } else if (stepKey === 'scopes') {
        // Start OAuth flow
        nextBtn.disabled = true;
        nextBtn.textContent = 'Connecting...';

        try {
          const result = await window.os8.connections.startOAuth(
            getWizardState().provider,
            getWizardState().selectedScopes
          );

          if (result.error) {
            alert('Connection failed: ' + result.error);
            nextBtn.disabled = false;
            nextBtn.textContent = 'Connect';
            return;
          }

          getWizardState().connectionResult = result;
        } catch (err) {
          alert('Connection failed: ' + err.message);
          nextBtn.disabled = false;
          nextBtn.textContent = 'Connect';
          return;
        }
      }

      // Advance to next step
      if (getWizardState().step < WIZARD_STEPS.length - 1) {
        getWizardState().step++;
        renderWizardStep();
      }
    });
  }
}
