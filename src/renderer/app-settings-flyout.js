// Phase 4 PR 4.2 — per-app settings flyout (right-click → Settings).
//
// Renders a small modal with three sections:
//   1. Updates: Auto-Update toggle (Verified-channel only)
//   2. Idle reaping: KEEP RUNNING override (PR 4.2 placeholder; the
//      idle reaper itself is wired in earlier phases)
//   3. Lifecycle: Uninstall button
//
// Closes on Escape, click-outside, or the close button. Returns a
// disposer.

const FLYOUT_ID = 'appSettingsFlyout';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function ensureFlyoutEl() {
  let el = document.getElementById(FLYOUT_ID);
  if (el) return el;
  el = document.createElement('div');
  el.id = FLYOUT_ID;
  el.className = 'app-settings-flyout';
  el.hidden = true;
  document.body.appendChild(el);
  return el;
}

function renderFlyout(app) {
  const isVerified = app.channel === 'verified';
  const channelLabel = app.channel || 'unknown';
  const autoUpdateChecked = !!app.auto_update;
  return `
    <div class="app-settings-flyout__panel">
      <header>
        <strong>${escapeHtml(app.name || app.external_slug || 'App')}</strong>
        <span class="app-settings-flyout__channel">${escapeHtml(channelLabel)}</span>
        <button class="close" data-action="close" aria-label="Close">×</button>
      </header>

      <section class="app-settings-flyout__section">
        <h3>Updates</h3>
        <label class="app-settings-flyout__toggle">
          <input type="checkbox"
                 id="appSettingsAutoUpdate"
                 ${autoUpdateChecked ? 'checked' : ''}
                 ${isVerified ? '' : 'disabled'} />
          <span>Auto-update from catalog</span>
        </label>
        <p class="app-settings-flyout__hint">
          ${isVerified
            ? `When the Verified catalog publishes a new version, OS8
               fetches and applies it automatically — but
               <strong>only</strong> if you haven't edited this app
               locally. Edits surface in the home-screen banner instead
               so you can resolve the merge by hand.`
            : `Auto-update is Verified-channel only. This app installs
               from <code>${escapeHtml(channelLabel)}</code>; manual
               update via the home-screen banner stays available.`}
        </p>
      </section>

      <section class="app-settings-flyout__section app-settings-flyout__section--danger">
        <h3>Lifecycle</h3>
        <button class="action-button action-button--danger"
                data-action="uninstall">Uninstall…</button>
      </section>
    </div>
  `;
}

let activeDisposer = null;

export function openAppSettingsFlyout(app, anchorEl, opts = {}) {
  if (typeof activeDisposer === 'function') activeDisposer();

  const el = ensureFlyoutEl();
  el.innerHTML = renderFlyout(app);
  el.hidden = false;

  // Position next to the anchor when provided; default to right-edge.
  if (anchorEl?.getBoundingClientRect) {
    const r = anchorEl.getBoundingClientRect();
    el.style.position = 'fixed';
    el.style.top = `${Math.min(window.innerHeight - 240, r.top)}px`;
    el.style.left = `${Math.min(window.innerWidth - 360, r.right + 12)}px`;
  }

  // Auto-update toggle.
  const cb = el.querySelector('#appSettingsAutoUpdate');
  cb?.addEventListener('change', async () => {
    const next = cb.checked;
    try {
      const r = await fetch(`/api/apps/${encodeURIComponent(app.id)}/auto-update`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-OS8-App-Id': 'shell' },
        body: JSON.stringify({ enabled: next }),
      });
      if (!r.ok) {
        cb.checked = !next;
        const body = await r.json().catch(() => ({}));
        if (typeof opts.onError === 'function') opts.onError(body.error || `HTTP ${r.status}`);
        return;
      }
      app.auto_update = next ? 1 : 0;
      if (typeof opts.onChange === 'function') opts.onChange({ autoUpdate: next });
    } catch (e) {
      cb.checked = !next;
      if (typeof opts.onError === 'function') opts.onError(e.message);
    }
  });

  el.querySelector('[data-action="uninstall"]')?.addEventListener('click', () => {
    if (typeof opts.onUninstall === 'function') opts.onUninstall(app);
    closeAppSettingsFlyout();
  });

  el.querySelector('[data-action="close"]')?.addEventListener('click', () => {
    closeAppSettingsFlyout();
  });

  function onKey(e) {
    if (e.key === 'Escape') closeAppSettingsFlyout();
  }
  function onClickOutside(e) {
    if (!el.contains(e.target)) closeAppSettingsFlyout();
  }
  document.addEventListener('keydown', onKey);
  // Defer click-outside binding past the current event so the opening
  // click doesn't immediately close it.
  setTimeout(() => document.addEventListener('mousedown', onClickOutside), 0);

  activeDisposer = () => {
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('mousedown', onClickOutside);
    el.hidden = true;
    el.innerHTML = '';
    activeDisposer = null;
  };
  return activeDisposer;
}

export function closeAppSettingsFlyout() {
  if (typeof activeDisposer === 'function') activeDisposer();
}
