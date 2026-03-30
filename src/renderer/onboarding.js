/**
 * Onboarding Module
 *
 * First-run experience: splash screen (core + CLI install) → 6-step wizard.
 * Steps: Identity → AI Backend → Image AI → Voice → OS8 Account → Agent Handoff
 */

import { setCoreReady } from './state.js';

// --- Constants ---
const STEPS = [
  { num: 1, label: null },
  { num: 2, label: null },
  { num: 3, label: null },
  { num: 4, label: 'Recommended' },
  { num: 5, label: 'Optional' },
  { num: 6, label: null }
];

// Provider definitions
const PROVIDERS = {
  anthropic: {
    name: 'Anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    hasLogin: true,
    cliCommand: 'claude',
    loginLabel: 'Log in with Claude Code',
    imageCapable: false,
    placeholder: 'sk-ant-...',
    url: 'https://console.anthropic.com/settings/keys',
    urlLabel: 'console.anthropic.com'
  },
  google: {
    name: 'Google',
    envKey: 'GOOGLE_API_KEY',
    hasLogin: true,
    cliCommand: 'gemini',
    loginLabel: 'Log in with Gemini CLI',
    imageCapable: true,
    placeholder: 'AIza...',
    url: 'https://aistudio.google.com/apikey',
    urlLabel: 'aistudio.google.com'
  },
  openai: {
    name: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    hasLogin: true,
    cliCommand: 'codex',
    loginLabel: 'Log in with Codex CLI',
    imageCapable: true,
    placeholder: 'sk-...',
    url: 'https://platform.openai.com/api-keys',
    urlLabel: 'platform.openai.com'
  },
  xai: {
    name: 'xAI',
    envKey: 'XAI_API_KEY',
    hasLogin: false,
    cliCommand: 'grok',
    loginLabel: null,
    imageCapable: true,
    placeholder: 'xai-...',
    url: 'https://console.x.ai/team/default/api-keys',
    urlLabel: 'console.x.ai'
  }
};

const VOICE_PROVIDERS = {
  elevenlabs: {
    name: 'ElevenLabs',
    envKey: 'ELEVENLABS_API_KEY',
    placeholder: 'sk_...',
    url: 'https://elevenlabs.io/app/settings/api-keys',
    urlLabel: 'elevenlabs.io'
  },
  openai: {
    name: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    placeholder: 'sk-...',
    url: 'https://platform.openai.com/api-keys',
    urlLabel: 'platform.openai.com'
  }
};

// --- State ---
let currentStep = 0; // 0 = splash, 1-6 = wizard steps
let providerStatuses = {};
let userName = '';
let splashState = { core: false, cli: false };
let accountSignedIn = false;

// --- DOM refs ---
const els = () => ({
  overlay: document.getElementById('onboardingOverlay'),
  splash: document.getElementById('onboardingSplash'),
  wizard: document.getElementById('onboardingWizard'),
  indicator: document.getElementById('onboardingStepIndicator'),
  content: document.getElementById('onboardingContent'),
  actions: document.getElementById('onboardingActions')
});

// --- Public API ---

/**
 * Check if onboarding is needed and start if so.
 * Called from main.js init().
 */
export async function checkOnboarding() {
  const status = await window.os8.onboarding.getStatus();
  if (status.complete === '1') return;

  const { overlay } = els();
  overlay.style.display = 'flex';

  const step = parseInt(status.step) || 0;

  if (step === 0) {
    await showSplash();
  } else {
    // Resume — skip splash, go to stored step
    currentStep = step;
    // Load existing data
    const existing = await window.os8.settings.get('user_first_name');
    if (existing) userName = existing;
    providerStatuses = await window.os8.onboarding.detectProviders();
    showWizard(step);
  }
}

// --- Splash Screen ---

async function showSplash() {
  const { splash, wizard } = els();
  splash.style.display = 'flex';
  wizard.style.display = 'none';

  splash.innerHTML = `
    <div class="onboarding-splash-logo">OS8</div>
    <div class="onboarding-splash-status">Setting up your environment...</div>
    <div class="onboarding-splash-progress">
      <div class="onboarding-splash-progress-bar indeterminate"></div>
    </div>
    <div class="onboarding-splash-tasks">
      <div class="onboarding-splash-task" id="splashTaskCore">
        <span class="task-icon">&#9675;</span>
        <span>Development environment</span>
      </div>
      <div class="onboarding-splash-task" id="splashTaskCli">
        <span class="task-icon">&#9675;</span>
        <span>AI backends</span>
      </div>
    </div>
  `;

  // Check what's already done
  const coreStatus = await window.os8.core.getStatus();
  splashState.core = coreStatus === 'ready';

  const claudeInstalled = await window.os8.onboarding.checkCliInstalled('claude');
  // If claude is installed, assume others may be too (they install together)
  splashState.cli = claudeInstalled;

  if (splashState.core) markSplashTask('splashTaskCore');
  if (splashState.cli) markSplashTask('splashTaskCli');

  if (splashState.core && splashState.cli) {
    splashComplete();
    return;
  }

  // Start installations in parallel
  const tasks = [];

  if (!splashState.core) {
    tasks.push(
      (async () => {
        window.os8.core.onReady(() => {
          splashState.core = true;
          setCoreReady(true);
          markSplashTask('splashTaskCore');
          checkSplashDone();
        });
        try {
          await window.os8.core.setup();
        } catch (e) {
          console.error('Core setup failed:', e);
          // Mark as done anyway — user can retry from settings
          splashState.core = true;
          markSplashTask('splashTaskCore');
          checkSplashDone();
        }
      })()
    );
  }

  if (!splashState.cli) {
    tasks.push(
      (async () => {
        try {
          await window.os8.onboarding.installClis();
        } catch (e) {
          console.error('CLI install failed:', e);
        }
        splashState.cli = true;
        markSplashTask('splashTaskCli');
        checkSplashDone();
      })()
    );
  }
}

function markSplashTask(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('complete');
  el.querySelector('.task-icon').innerHTML = '&#10003;';
}

function checkSplashDone() {
  if (splashState.core && splashState.cli) {
    splashComplete();
  }
}

async function splashComplete() {
  // Small delay so user sees the completed state
  await new Promise(r => setTimeout(r, 600));
  currentStep = 1;
  await window.os8.onboarding.setStep(1);
  providerStatuses = await window.os8.onboarding.detectProviders();
  showWizard(1);
}

// --- Wizard ---

function showWizard(step) {
  const { splash, wizard } = els();
  splash.style.display = 'none';
  wizard.style.display = 'flex';
  currentStep = step;
  renderStep();
}

function renderStep() {
  renderStepIndicator();
  renderStepContent();
  renderStepActions();
}

// --- Step Indicator ---

function renderStepIndicator() {
  const { indicator } = els();
  const parts = [];

  for (let i = 0; i < STEPS.length; i++) {
    const s = STEPS[i];
    let cls = 'onboarding-step-dot';
    if (s.num === currentStep) cls += ' active';
    else if (s.num < currentStep) cls += ' completed';
    else cls += ' future';

    // Always show the number
    parts.push(`<div class="${cls}">${s.num}</div>`);

    if (i < STEPS.length - 1) {
      const connCls = s.num < currentStep ? 'onboarding-step-connector completed' : 'onboarding-step-connector';
      parts.push(`<div class="${connCls}"></div>`);
    }
  }

  indicator.innerHTML = parts.join('');
}

// --- Step Content ---

function renderStepContent() {
  const { content } = els();
  switch (currentStep) {
    case 1: renderStep1Identity(content); break;
    case 2: renderStep2Backend(content); break;
    case 3: renderStep3Image(content); break;
    case 4: renderStep4Voice(content); break;
    case 5: renderStep5Account(content); break;
    case 6: renderStep6Handoff(content); break;
  }
}

// Step 1: Identity
function renderStep1Identity(container) {
  container.innerHTML = `
    <h2>What's your first name?</h2>
    <p class="onboarding-subtitle">Your agent will use this to address you.</p>
    <input type="text" class="onboarding-input" id="onboardingNameInput"
      placeholder="Enter your first name" value="${escapeHtml(userName)}" autofocus>
  `;

  const input = container.querySelector('#onboardingNameInput');
  input.addEventListener('input', () => {
    userName = input.value.trim();
    updateContinueButton();
  });

  // Focus after render
  setTimeout(() => input.focus(), 50);
}

// Step 2: AI Backend Setup
function renderStep2Backend(container) {
  const providerOrder = ['anthropic', 'google', 'openai', 'xai'];
  container.innerHTML = `
    <h2>Connect your AI providers</h2>
    <p class="onboarding-subtitle">You'll need at least one to get started. Logins are free with an existing subscription.</p>
    <div class="onboarding-providers">
      ${providerOrder.map(id => renderProviderCard(id, id === 'anthropic')).join('')}
    </div>
  `;
  attachProviderCardListeners(container, providerOrder);
}

// Step 3: Image AI Setup
// Only Google login works for images (OAuth token covers Imagen API).
// OpenAI and xAI require API keys for image generation.
function renderStep3Image(container) {
  const imageProviders = ['google', 'openai', 'xai'];
  const configured = imageProviders.filter(id => {
    if (id === 'google') return providerStatuses[id]?.login || providerStatuses[id]?.apiKey;
    return providerStatuses[id]?.apiKey;
  });

  let html = `<h2>Image Generation</h2>`;

  if (configured.length > 0) {
    const names = configured.map(id => {
      const name = PROVIDERS[id].name;
      if (id === 'google' && providerStatuses[id]?.login && !providerStatuses[id]?.apiKey) return `${name} (login)`;
      return name;
    }).join(', ');
    html += `
      <div class="onboarding-allset">
        <span class="onboarding-allset-icon">&#10003;</span>
        <span>You're all set &mdash; ${names} can generate images.</span>
      </div>
    `;
    const unconfigured = imageProviders.filter(id => !configured.includes(id));
    if (unconfigured.length > 0) {
      html += `<p class="onboarding-add-more">Would you like to add others?</p>
        <div class="onboarding-providers">
          ${unconfigured.map(id => renderProviderCard(id, false)).join('')}
        </div>`;
    }
  } else {
    html += `
      <p class="onboarding-subtitle">Image generation requires a Google login or an API key for Google, OpenAI, or xAI.</p>
      <div class="onboarding-providers">
        ${imageProviders.map(id => renderProviderCard(id, id === 'google')).join('')}
      </div>
    `;
  }

  container.innerHTML = html;
  attachProviderCardListeners(container, imageProviders);
}

// Step 4: Voice Setup
function renderStep4Voice(container) {
  const openaiConfigured = providerStatuses.openai?.apiKey || providerStatuses.openai?.login;
  const elevenConfigured = providerStatuses.elevenlabs?.apiKey;

  let html = `
    <h2>Voice</h2>
    <p class="onboarding-subtitle">Give your agents a voice. Highly recommended for the full experience.</p>
  `;

  if (openaiConfigured || elevenConfigured) {
    const names = [];
    if (elevenConfigured) names.push('ElevenLabs');
    if (openaiConfigured) names.push('OpenAI');
    html += `
      <div class="onboarding-allset">
        <span class="onboarding-allset-icon">&#10003;</span>
        <span>${names.join(' & ')} available for voice.</span>
      </div>
    `;
  }

  // ElevenLabs card
  if (!elevenConfigured) {
    html += `
      <div class="onboarding-providers">
        <div class="onboarding-provider-card${elevenConfigured ? ' configured' : ''}" data-voice-provider="elevenlabs">
          <div class="onboarding-provider-header">
            <div class="onboarding-provider-info">
              <span class="onboarding-provider-name">ElevenLabs</span>
              <span class="onboarding-provider-badge best">Best quality</span>
            </div>
            ${elevenConfigured ?
              '<span class="onboarding-provider-status connected">&#10003; Connected</span>' :
              '<span class="onboarding-provider-status not-connected">Not connected</span>'
            }
          </div>
          ${!elevenConfigured ? `
            <div class="onboarding-apikey-section visible">
              <div class="onboarding-apikey-row">
                <input type="password" placeholder="${VOICE_PROVIDERS.elevenlabs.placeholder}" id="onboardingElevenKey">
                <button onclick="this.closest('.onboarding-provider-card').querySelector('.save-btn').click()">Save</button>
              </div>
              <button class="save-btn" style="display:none" data-env-key="ELEVENLABS_API_KEY"></button>
              <a class="onboarding-apikey-link" href="#" data-url="${VOICE_PROVIDERS.elevenlabs.url}">${VOICE_PROVIDERS.elevenlabs.urlLabel}</a>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }

  // OpenAI status if not configured
  if (!openaiConfigured) {
    html += `
      <div class="onboarding-providers" style="margin-top: 8px;">
        <div class="onboarding-provider-card" data-voice-provider="openai">
          <div class="onboarding-provider-header">
            <div class="onboarding-provider-info">
              <span class="onboarding-provider-name">OpenAI</span>
            </div>
            <span class="onboarding-provider-status not-connected">Not connected</span>
          </div>
          <div class="onboarding-apikey-section visible">
            <div class="onboarding-apikey-row">
              <input type="password" placeholder="${VOICE_PROVIDERS.openai.placeholder}" id="onboardingOpenaiVoiceKey">
              <button onclick="this.closest('.onboarding-provider-card').querySelector('.save-btn').click()">Save</button>
            </div>
            <button class="save-btn" style="display:none" data-env-key="OPENAI_API_KEY"></button>
            <a class="onboarding-apikey-link" href="#" data-url="${VOICE_PROVIDERS.openai.url}">${VOICE_PROVIDERS.openai.urlLabel}</a>
          </div>
        </div>
      </div>
    `;
  }

  if (openaiConfigured && elevenConfigured) {
    html += `<p class="onboarding-add-more" style="text-align: center; margin-top: 20px;">Both voice providers configured.</p>`;
  }

  container.innerHTML = html;

  // Attach voice key save handlers
  container.querySelectorAll('.save-btn[data-env-key]').forEach(btn => {
    const card = btn.closest('.onboarding-provider-card');
    const input = card.querySelector('input[type="password"]');
    const saveBtn = card.querySelector('.onboarding-apikey-row button');

    saveBtn.addEventListener('click', async () => {
      const key = input.value.trim();
      if (!key) return;
      const envKey = btn.dataset.envKey;
      await window.os8.env.set(envKey, key, 'Set during onboarding');

      if (envKey === 'ELEVENLABS_API_KEY') {
        providerStatuses.elevenlabs = { apiKey: true };
        // Set as TTS provider
        await window.os8.settings.set('tts_provider', 'elevenlabs');
      } else if (envKey === 'OPENAI_API_KEY') {
        providerStatuses.openai = { ...providerStatuses.openai, apiKey: true };
        // Set OpenAI as TTS provider if no ElevenLabs
        if (!providerStatuses.elevenlabs?.apiKey) {
          await window.os8.settings.set('tts_provider', 'openai');
        }
      }

      renderStep();
    });
  });

  // Attach URL click handlers
  container.querySelectorAll('.onboarding-apikey-link[data-url]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      openExternal(link.dataset.url);
    });
  });
}

// Step 5: OS8 Account
function renderStep5Account(container) {
  container.innerHTML = `
    <div class="onboarding-account">
      <h2>Join OS8</h2>
      <p class="onboarding-subtitle" style="text-align: center;">Create an account to share agents and apps with the OS8 community.</p>
      <ul class="onboarding-account-features">
        <li>Share and discover agents</li>
        <li>Publish and install apps</li>
        <li>Access the OS8 skill catalog</li>
      </ul>
      ${accountSignedIn ?
        '<div class="onboarding-allset"><span class="onboarding-allset-icon">&#10003;</span><span>Signed in</span></div>' :
        '<button class="onboarding-btn-google" id="onboardingGoogleBtn">Sign in with Google</button>'
      }
    </div>
  `;

  const googleBtn = container.querySelector('#onboardingGoogleBtn');
  if (googleBtn) {
    googleBtn.addEventListener('click', async () => {
      try {
        await window.os8.account.signIn();
        accountSignedIn = true;
        renderStep();
      } catch (e) {
        console.error('Sign-in failed:', e);
      }
    });
  }

  // Listen for sign-in completion (may come from browser redirect)
  window.os8.account.onSignedIn(() => {
    accountSignedIn = true;
    if (currentStep === 5) renderStep();
  });
}

// Step 6: Handoff
function renderStep6Handoff(container) {
  container.innerHTML = `
    <div class="onboarding-handoff">
      <div class="onboarding-handoff-icon">&#10024;</div>
      <h2>You're all set</h2>
      <p>Let's create your first agent.</p>
    </div>
  `;
}

// --- Provider Card Rendering ---

function renderProviderCard(providerId, isPrimary) {
  const p = PROVIDERS[providerId];
  const status = providerStatuses[providerId] || {};
  const isConfigured = status.login || status.apiKey;

  let statusHtml;
  if (status.login) {
    const tierLabel = status.planTier ? ` (${status.planTier})` : '';
    statusHtml = `<span class="onboarding-provider-status connected">&#10003; Logged in${tierLabel}</span>`;
  } else if (status.apiKey) {
    statusHtml = `<span class="onboarding-provider-status connected">&#10003; API key set</span>`;
  } else {
    statusHtml = `<span class="onboarding-provider-status not-connected">Not connected</span>`;
  }

  let badgeHtml = '';
  if (isPrimary) {
    badgeHtml = '<span class="onboarding-provider-badge recommended">Recommended</span>';
  }

  let actionsHtml = '';
  if (!isConfigured) {
    actionsHtml = '<div class="onboarding-provider-actions">';
    if (p.hasLogin) {
      actionsHtml += `<button class="btn btn-login" data-provider="${providerId}" data-action="login">${p.loginLabel}</button>`;
    }
    actionsHtml += `<button class="btn btn-apikey" data-provider="${providerId}" data-action="toggle-key">API Key</button>`;
    actionsHtml += '</div>';

    actionsHtml += `
      <div class="onboarding-apikey-section" data-provider-key="${providerId}">
        <div class="onboarding-apikey-row">
          <input type="password" placeholder="${p.placeholder}" data-provider-input="${providerId}">
          <button data-provider="${providerId}" data-action="save-key">Save</button>
        </div>
        <a class="onboarding-apikey-link" href="#" data-url="${p.url}">${p.urlLabel}</a>
      </div>
    `;
  }

  return `
    <div class="onboarding-provider-card${isConfigured ? ' configured' : ''}${isPrimary && !isConfigured ? ' primary' : ''}"
         data-provider-id="${providerId}">
      <div class="onboarding-provider-header">
        <div class="onboarding-provider-info">
          <span class="onboarding-provider-name">${p.name}</span>
          ${badgeHtml}
        </div>
        ${statusHtml}
      </div>
      ${actionsHtml}
    </div>
  `;
}

function attachProviderCardListeners(container, providerIds) {
  // Login buttons
  container.querySelectorAll('[data-action="login"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const providerId = btn.dataset.provider;
      await handleProviderLogin(providerId, btn);
    });
  });

  // Toggle API key section
  container.querySelectorAll('[data-action="toggle-key"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const section = container.querySelector(`[data-provider-key="${btn.dataset.provider}"]`);
      if (section) section.classList.toggle('visible');
    });
  });

  // Save API key
  container.querySelectorAll('[data-action="save-key"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const providerId = btn.dataset.provider;
      const input = container.querySelector(`[data-provider-input="${providerId}"]`);
      const key = input?.value.trim();
      if (!key) return;

      const p = PROVIDERS[providerId];
      await window.os8.env.set(p.envKey, key, `${p.name} API key`);
      providerStatuses[providerId] = { ...providerStatuses[providerId], apiKey: true };
      renderStep();
    });
  });

  // External URL links
  container.querySelectorAll('.onboarding-apikey-link[data-url]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      openExternal(link.dataset.url);
    });
  });
}

async function handleProviderLogin(providerId, btn) {
  const p = PROVIDERS[providerId];
  const originalText = btn.textContent;
  btn.textContent = 'Logging in...';
  btn.disabled = true;

  try {
    // For CLI-based logins, we need to spawn the login command
    // This will open a browser window for OAuth
    const port = await window.os8.server.getPort();
    const response = await fetch(`http://localhost:${port}/api/backend/login/${p.cliCommand}`, {
      method: 'POST'
    });

    if (response.ok) {
      // Re-detect after login
      providerStatuses = await window.os8.onboarding.detectProviders();
      renderStep();
    } else {
      btn.textContent = 'Login failed - try API key';
      btn.disabled = false;
      // Show API key section as fallback
      const section = btn.closest('.onboarding-provider-card')
        ?.querySelector(`[data-provider-key="${providerId}"]`);
      if (section) section.classList.add('visible');
    }
  } catch (e) {
    console.error(`Login failed for ${providerId}:`, e);
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

// --- Step Actions ---

function renderStepActions() {
  const { actions } = els();

  const showBack = currentStep > 1;
  const showSkip = currentStep === 4;
  const isHandoff = currentStep === 6;
  const continueLabel = isHandoff ? "Let's go" : 'Continue';

  actions.innerHTML = `
    <div class="onboarding-actions-left">
      ${showBack ? '<button class="onboarding-btn onboarding-btn-back" id="onboardingBack">Back</button>' : ''}
    </div>
    <div class="onboarding-actions-right">
      ${showSkip ? '<button class="onboarding-btn-skip" id="onboardingSkip">Skip for now</button>' : ''}
      <button class="onboarding-btn onboarding-btn-primary" id="onboardingContinue"
        ${isStepSatisfied() ? '' : 'disabled'}>${continueLabel}</button>
    </div>
  `;

  const backBtn = actions.querySelector('#onboardingBack');
  const skipBtn = actions.querySelector('#onboardingSkip');
  const continueBtn = actions.querySelector('#onboardingContinue');

  if (backBtn) backBtn.addEventListener('click', prevStep);
  if (skipBtn) skipBtn.addEventListener('click', nextStep);
  if (continueBtn) continueBtn.addEventListener('click', handleContinue);
}

function updateContinueButton() {
  const btn = document.getElementById('onboardingContinue');
  if (btn) btn.disabled = !isStepSatisfied();
}

// --- Gate Logic ---

function isStepSatisfied() {
  switch (currentStep) {
    case 1:
      return userName.length > 0;
    case 2: {
      // At least one AI provider configured
      const aiProviders = ['anthropic', 'google', 'openai', 'xai'];
      return aiProviders.some(id => providerStatuses[id]?.login || providerStatuses[id]?.apiKey);
    }
    case 3: {
      // At least one image-capable provider configured
      // Only Google login works for images; OpenAI and xAI need API keys
      const imageProviders = ['google', 'openai', 'xai'];
      return imageProviders.some(id => {
        if (id === 'google') return providerStatuses[id]?.login || providerStatuses[id]?.apiKey;
        return providerStatuses[id]?.apiKey;
      });
    }
    case 4:
      // Recommended but not required
      return true;
    case 5:
      // Optional
      return true;
    case 6:
      return true;
    default:
      return false;
  }
}

// --- Navigation ---

async function handleContinue() {
  if (!isStepSatisfied()) return;

  // Save step-specific data
  if (currentStep === 1) {
    await window.os8.settings.set('user_first_name', userName);
  }

  if (currentStep === 6) {
    await completeOnboarding();
    return;
  }

  await nextStep();
}

async function nextStep() {
  if (currentStep < 6) {
    currentStep++;
    await window.os8.onboarding.setStep(currentStep);

    // Refresh provider statuses when entering steps that depend on them
    if (currentStep === 3 || currentStep === 4) {
      providerStatuses = await window.os8.onboarding.detectProviders();
    }

    renderStep();
  }
}

function prevStep() {
  if (currentStep > 1) {
    currentStep--;
    renderStep();
  }
}

async function completeOnboarding() {
  await window.os8.onboarding.complete();

  // Hide overlay
  const { overlay } = els();
  overlay.style.display = 'none';

  // Enable New App button if core is ready
  const newAppBtn = document.getElementById('newAppBtn');
  if (newAppBtn) {
    const coreStatus = await window.os8.core.getStatus();
    if (coreStatus === 'ready') {
      setCoreReady(true);
      newAppBtn.disabled = false;
    }
  }

  // Reload apps to ensure assistant app exists in state
  const { loadApps } = await import('./apps.js');
  await loadApps();

  // Open assistant app and force preview load
  try {
    const { getAssistantApp } = await import('./state.js');
    const { createAppTab } = await import('./tabs.js');
    const { loadPreview, ensurePreviewForApp } = await import('./preview.js');
    const assistantApp = getAssistantApp();
    if (assistantApp) {
      await createAppTab(assistantApp);
      // Force preview to load after tab is fully set up —
      // the assistant React app handles agent creation wizard
      setTimeout(async () => {
        await ensurePreviewForApp(assistantApp);
        const port = await window.os8.server.getPort();
        await window.os8.preview.setUrl(assistantApp.id, `http://localhost:${port}/${assistantApp.id}/`);
      }, 500);
    }
  } catch (e) {
    console.error('Failed to open assistant after onboarding:', e);
  }
}

// --- Helpers ---

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function openExternal(url) {
  try {
    const port = await window.os8.server.getPort();
    await fetch(`http://localhost:${port}/api/open-external`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
  } catch (e) {
    console.error('Failed to open URL:', e);
  }
}
