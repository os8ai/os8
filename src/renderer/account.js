/**
 * Account settings section — OS8.ai user identity
 */

/**
 * Load and render the account section in settings
 */
export async function loadAccountSection() {
  const container = document.getElementById('section-account');
  if (!container) return;

  try {
    const account = await window.os8.account.get();

    if (account) {
      renderSignedIn(container, account);
    } else {
      renderSignedOut(container);
    }
  } catch (err) {
    console.error('[Account] Failed to load:', err);
    renderSignedOut(container);
  }
}

function renderSignedOut(container) {
  container.innerHTML = `
    <div class="setting-group">
      <label class="setting-label">OS8 Account</label>
      <p class="setting-description">Sign in with your os8.ai account to publish and share agents and apps.</p>
      <button id="accountSignInBtn" class="account-signin-btn">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>
          <polyline points="10 17 15 12 10 7"/>
          <line x1="15" y1="12" x2="3" y2="12"/>
        </svg>
        Sign in with OS8.ai
      </button>
    </div>
  `;

  const btn = document.getElementById('accountSignInBtn');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Opening browser...';

    try {
      const result = await window.os8.account.signIn();
      if (result.success) {
        loadAccountSection();
      } else {
        btn.disabled = false;
        btn.textContent = 'Sign in with OS8.ai';
        alert('Sign-in failed: ' + (result.error || 'Unknown error'));
      }
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Sign in with OS8.ai';
    }
  });
}

function renderSignedIn(container, account) {
  const avatarHtml = account.avatar_url
    ? `<img src="${escapeHtml(account.avatar_url)}" alt="" class="account-avatar" />`
    : `<div class="account-avatar-placeholder">${(account.display_name || account.email || '?')[0].toUpperCase()}</div>`;

  const usernameHtml = account.username
    ? `<div class="account-username">@${escapeHtml(account.username)}</div>`
    : `<a href="https://os8.ai/claim-username" target="_blank" class="account-claim-link">Claim your username on os8.ai</a>`;

  // Phase 5 PR 5.1 — render the toggle as default-on (matches the
  // server-side default and the column's INTEGER DEFAULT 1). `account.share_installed_apps`
  // is undefined on databases that haven't applied the 0.7.0 migration yet — treat
  // as enabled.
  const shareEnabled = account.share_installed_apps == null
    ? true
    : account.share_installed_apps !== 0;

  container.innerHTML = `
    <div class="setting-group">
      <label class="setting-label">OS8 Account</label>
      <div class="account-card">
        ${avatarHtml}
        <div class="account-info">
          <div class="account-name">${escapeHtml(account.display_name || '')}</div>
          <div>${usernameHtml}</div>
          <div class="account-email">${escapeHtml(account.email || '')}</div>
        </div>
      </div>
    </div>
    <div class="setting-group">
      <label class="setting-label" style="display:flex;align-items:center;gap:8px;cursor:pointer;">
        <input type="checkbox" id="accountShareInstalledApps" ${shareEnabled ? 'checked' : ''} />
        <span>Share installed apps with os8.ai</span>
      </label>
      <p class="setting-description">
        Lets os8.ai detail pages show "Update available" badges on the apps you have installed.
        Turning this off clears the cached session and stops the heartbeat —
        sign in again to re-enable.
      </p>
    </div>
    <div class="setting-group">
      <button id="accountSignOutBtn" class="account-signout-btn">Sign Out</button>
    </div>
  `;

  const signOutBtn = document.getElementById('accountSignOutBtn');
  signOutBtn.addEventListener('click', async () => {
    await window.os8.account.signOut();
    loadAccountSection();
  });

  const shareToggle = document.getElementById('accountShareInstalledApps');
  shareToggle.addEventListener('change', async () => {
    try {
      await window.os8.account.setShareInstalledApps(shareToggle.checked);
    } catch (err) {
      console.error('[Account] setShareInstalledApps failed:', err);
    }
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Wire the account:signed-in event to refresh the UI
 */
export function initAccountListeners() {
  window.os8.account.onSignedIn(() => {
    loadAccountSection();
  });
}
