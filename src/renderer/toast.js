// Phase 4 PR 4.2 — bottom-right toast notifier.
//
// Lightweight, no library. The renderer's existing vault.js had its own
// per-panel toast; this module surfaces a shell-level toast suitable
// for events that aren't tied to a specific panel (auto-update apply,
// auto-update failure).

const TOAST_CONTAINER_ID = 'os8ToastContainer';
const TOAST_DEFAULT_MS = 6000;
const TOAST_FAIL_MS = 8000;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function ensureContainer() {
  let el = document.getElementById(TOAST_CONTAINER_ID);
  if (el) return el;
  el = document.createElement('div');
  el.id = TOAST_CONTAINER_ID;
  el.className = 'os8-toast-container';
  document.body.appendChild(el);
  return el;
}

/**
 * Show a generic toast. Auto-dismisses after `durationMs`.
 *
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.message]
 * @param {'info'|'success'|'warning'|'error'} [opts.kind='info']
 * @param {{ label: string, onClick: () => void }} [opts.action]
 * @param {number} [opts.durationMs=6000]
 */
export function showToast({ title, message = '', kind = 'info', action, durationMs = TOAST_DEFAULT_MS }) {
  const container = ensureContainer();
  const el = document.createElement('div');
  el.className = `os8-toast os8-toast--${kind}`;
  el.innerHTML = `
    <div class="os8-toast__body">
      <strong class="os8-toast__title">${escapeHtml(title)}</strong>
      ${message ? `<div class="os8-toast__message">${escapeHtml(message)}</div>` : ''}
    </div>
    ${action ? `<button class="os8-toast__action" type="button">${escapeHtml(action.label)}</button>` : ''}
    <button class="os8-toast__close" type="button" aria-label="Dismiss">×</button>
  `;
  container.appendChild(el);

  let timer = null;
  const dismiss = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    el.classList.add('os8-toast--leaving');
    setTimeout(() => el.remove(), 200);
  };

  el.querySelector('.os8-toast__close')?.addEventListener('click', dismiss);
  if (action) {
    el.querySelector('.os8-toast__action')?.addEventListener('click', () => {
      try { action.onClick(); } catch (_) { /* noop */ }
      dismiss();
    });
  }
  timer = setTimeout(dismiss, durationMs);

  return dismiss;
}

/**
 * Auto-update event toast. Routes apply/fail/conflict to the right
 * styling. Phase 5 PR 5.4 added the `conflict` kind — fires when an
 * auto-update hits a merge conflict and the user needs to resolve it
 * manually via the merge-conflict banner.
 *
 * @param {{ kind: 'applied'|'failed'|'conflict', appId, slug,
 *           newCommit?, error?, conflictFileCount?,
 *           onResolve?: () => void }} event
 */
export function showAutoUpdateToast(event) {
  if (event.kind === 'applied') {
    return showToast({
      kind: 'success',
      title: `${event.slug} updated`,
      message: event.newCommit
        ? `Now on ${String(event.newCommit).slice(0, 7)}.`
        : 'Auto-update applied.',
      durationMs: TOAST_DEFAULT_MS,
    });
  }
  if (event.kind === 'conflict') {
    const n = event.conflictFileCount || 0;
    return showToast({
      kind: 'warning',
      title: `${event.slug} needs your help`,
      message: n > 0
        ? `Auto-update hit a merge conflict in ${n} file${n === 1 ? '' : 's'}. Open the app to review.`
        : 'Auto-update hit a merge conflict. Open the app to review.',
      action: event.onResolve ? { label: 'Resolve', onClick: event.onResolve } : undefined,
      durationMs: TOAST_FAIL_MS,
    });
  }
  if (event.kind === 'failed') {
    return showToast({
      kind: 'warning',
      title: `${event.slug} auto-update failed`,
      message: event.error || 'See logs for details.',
      durationMs: TOAST_FAIL_MS,
    });
  }
}
