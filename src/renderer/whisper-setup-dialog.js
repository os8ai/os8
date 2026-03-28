/**
 * Whisper Setup Dialog
 *
 * On-demand whisper install triggered when user clicks mic button
 * and whisper is not installed. Offers local setup or cloud (OpenAI) fallback.
 */

// --- State ---
let isInstalling = false;
let cleanupProgress = null;

/**
 * Check if whisper is ready. If not, show setup dialog.
 * Returns true if voice input can proceed, false if blocked.
 */
export async function checkWhisperAndPrompt() {
  const status = await window.os8.whisper.status();
  if (status.ready) return true;

  // Check if OpenAI is available as cloud fallback
  const hasOpenAI = await hasOpenAIKey();

  return showWhisperSetupDialog(hasOpenAI);
}

// --- Dialog ---

function showWhisperSetupDialog(hasOpenAI) {
  return new Promise((resolve) => {
    const modal = document.getElementById('whisperSetupModal');
    const content = document.getElementById('whisperSetupContent');

    if (!modal || !content) {
      resolve(false);
      return;
    }

    if (hasOpenAI) {
      renderChoiceDialog(content, resolve);
    } else {
      renderLocalOnlyDialog(content, resolve);
    }

    modal.style.display = 'flex';
  });
}

function renderChoiceDialog(content, resolve) {
  content.innerHTML = `
    <h3>Voice Input</h3>
    <p>How would you like to use speech recognition?</p>
    <div class="whisper-setup-options">
      <button class="whisper-setup-option" id="whisperCloud">
        <div class="option-label">Use cloud speech recognition</div>
        <div class="option-desc">Works immediately via OpenAI</div>
      </button>
      <button class="whisper-setup-option" id="whisperLocal">
        <div class="option-label">Set up local speech recognition</div>
        <div class="option-desc">Takes a few minutes &mdash; runs on your machine</div>
      </button>
    </div>
    <button class="whisper-setup-dismiss" id="whisperDismiss">Not now</button>
  `;

  content.querySelector('#whisperCloud').addEventListener('click', () => {
    // Cloud mode — just close dialog, voice.js will use OpenAI API fallback
    closeDialog();
    resolve(true);
  });

  content.querySelector('#whisperLocal').addEventListener('click', () => {
    startLocalInstall(content, resolve);
  });

  content.querySelector('#whisperDismiss').addEventListener('click', () => {
    closeDialog();
    resolve(false);
  });
}

function renderLocalOnlyDialog(content, resolve) {
  content.innerHTML = `
    <h3>Voice Input</h3>
    <p>OS8 can set up speech recognition on your computer. This takes a few minutes &mdash; you can keep chatting while it installs.</p>
    <div class="whisper-setup-options">
      <button class="whisper-setup-option" id="whisperLocal">
        <div class="option-label">Set up voice input</div>
        <div class="option-desc">Downloads and compiles locally</div>
      </button>
    </div>
    <button class="whisper-setup-dismiss" id="whisperDismiss">Not now</button>
  `;

  content.querySelector('#whisperLocal').addEventListener('click', () => {
    startLocalInstall(content, resolve);
  });

  content.querySelector('#whisperDismiss').addEventListener('click', () => {
    closeDialog();
    resolve(false);
  });
}

async function startLocalInstall(content, resolve) {
  // Check for build tools
  const hasBuildTools = await checkBuildTools();

  if (!hasBuildTools) {
    const hasOpenAI = await hasOpenAIKey();
    content.innerHTML = `
      <h3>Developer Tools Required</h3>
      <p>Local speech recognition requires Xcode Command Line Tools (git and cmake). Install them first, then try again.</p>
      ${hasOpenAI ? `
        <div class="whisper-setup-options">
          <button class="whisper-setup-option" id="whisperCloudFallback">
            <div class="option-label">Use cloud speech recognition instead</div>
            <div class="option-desc">Works immediately via OpenAI</div>
          </button>
        </div>
      ` : ''}
      <button class="whisper-setup-dismiss" id="whisperDismiss" style="margin-top: 16px;">Close</button>
    `;

    const cloudBtn = content.querySelector('#whisperCloudFallback');
    if (cloudBtn) {
      cloudBtn.addEventListener('click', () => {
        closeDialog();
        resolve(true);
      });
    }

    content.querySelector('#whisperDismiss').addEventListener('click', () => {
      closeDialog();
      resolve(false);
    });
    return;
  }

  // Show progress
  isInstalling = true;
  content.innerHTML = `
    <h3>Setting Up Voice Input</h3>
    <div class="whisper-setup-progress">
      <div class="progress-text" id="whisperProgressText">Starting setup...</div>
      <div class="progress-bar"><div class="progress-fill"></div></div>
    </div>
  `;

  // Listen for progress events
  cleanupProgress = window.os8.whisper.onSetupProgress((progress) => {
    const textEl = document.getElementById('whisperProgressText');
    if (textEl && progress.message) {
      textEl.textContent = progress.message;
    }
  });

  try {
    await window.os8.whisper.setup();

    // Show success
    content.innerHTML = `
      <div class="whisper-setup-success">
        &#10003; Voice input ready!
      </div>
    `;

    // Auto-close after brief delay
    setTimeout(() => {
      closeDialog();
      resolve(true);
    }, 1200);

    // Auto-start whisper streaming server in background (for voice calls)
    try {
      const streamStatus = await window.os8.whisper.streamStatus();
      if (!streamStatus.installed) {
        // Will compile in background — no UI feedback needed
        window.os8.whisper.streamStart().catch(() => {});
      }
    } catch (e) {
      // Non-critical — streaming server is for calls, not basic mic input
    }

  } catch (e) {
    console.error('Whisper setup failed:', e);
    const hasOpenAI = await hasOpenAIKey();

    content.innerHTML = `
      <h3>Setup Failed</h3>
      <p>${e.message || 'An error occurred during setup.'}</p>
      ${hasOpenAI ? `
        <div class="whisper-setup-options">
          <button class="whisper-setup-option" id="whisperCloudFallback">
            <div class="option-label">Use cloud speech recognition instead</div>
            <div class="option-desc">Works immediately via OpenAI</div>
          </button>
        </div>
      ` : ''}
      <div style="display: flex; gap: 8px; margin-top: 12px;">
        <button class="whisper-setup-dismiss" id="whisperRetry">Retry</button>
        <button class="whisper-setup-dismiss" id="whisperDismiss">Close</button>
      </div>
    `;

    const cloudBtn = content.querySelector('#whisperCloudFallback');
    if (cloudBtn) {
      cloudBtn.addEventListener('click', () => {
        closeDialog();
        resolve(true);
      });
    }

    const retryBtn = content.querySelector('#whisperRetry');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        startLocalInstall(content, resolve);
      });
    }

    content.querySelector('#whisperDismiss')?.addEventListener('click', () => {
      closeDialog();
      resolve(false);
    });
  } finally {
    isInstalling = false;
    if (cleanupProgress) {
      cleanupProgress();
      cleanupProgress = null;
    }
  }
}

// --- Helpers ---

function closeDialog() {
  const modal = document.getElementById('whisperSetupModal');
  if (modal) modal.style.display = 'none';
}

async function hasOpenAIKey() {
  try {
    const key = await window.os8.env.get('OPENAI_API_KEY');
    return !!key;
  } catch {
    return false;
  }
}

async function checkBuildTools() {
  try {
    const hasGit = await window.os8.onboarding.checkCliInstalled('git');
    const hasCmake = await window.os8.onboarding.checkCliInstalled('cmake');
    return hasGit && hasCmake;
  } catch {
    return false;
  }
}
