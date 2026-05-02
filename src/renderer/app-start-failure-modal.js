/**
 * Tier 3A — App start failure modal.
 *
 * When an external app fails to start (process exited before ready, code
 * ≠ 0, etc.), tabs.js used to surface this with a `window.alert(...)`
 * which truncated the actual error to a one-liner and offered no recovery
 * path. This modal replaces that flow: shows the structured error
 * (code + stderr tail), a small set of heuristic hints from the server's
 * failure-hints matcher, and an actionable Retry button.
 *
 * Usage:
 *   import { openAppStartFailureModal } from './app-start-failure-modal.js';
 *   openAppStartFailureModal(app, errorPayload, { onRetry: async () => {...} });
 *
 * The modal is dismissed on:
 *   - Close button
 *   - Successful retry (caller's onRetry resolves; modal closes itself)
 *   - Escape key
 */

const MODAL_ID = 'os8-app-start-failure-modal';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function ensureRoot() {
  let root = document.getElementById(MODAL_ID);
  if (root) return root;
  root = document.createElement('div');
  root.id = MODAL_ID;
  // Reuse the existing `.modal-overlay` rules (modals.css): position:fixed,
  // inset:0, z-index:100, display:none → display:flex when .active is added.
  // The original PR #34 used a made-up `install-plan-modal-root` class that
  // had no CSS, so the modal rendered as an in-flow div somewhere off-screen
  // and looked like nothing happened on app launch failure.
  root.className = 'modal-overlay';
  root.style.display = 'none';
  document.body.appendChild(root);
  return root;
}

function renderHints(hints) {
  if (!Array.isArray(hints) || hints.length === 0) return '';
  const cards = hints.map(h => `
    <div class="install-plan-modal__hint-card">
      <div class="install-plan-modal__hint-title">${escapeHtml(h.title)}</div>
      <div class="install-plan-modal__hint-body">${escapeHtml(h.body)}</div>
    </div>
  `).join('');
  return `
    <div class="install-plan-modal__section">
      <h3>Diagnoses</h3>
      ${cards}
    </div>
  `;
}

function renderModal(app, errorPayload, state) {
  const detail = errorPayload?.errorDetail || {};
  const code = detail.code ?? '?';
  const stderrTail = detail.stderrTail || '';
  const hints = Array.isArray(detail.hints) ? detail.hints : [];
  const summary = errorPayload?.error || 'process exited before ready';

  return `
    <div class="install-plan-modal" role="dialog" aria-labelledby="app-start-failure-title">
      <div class="install-plan-modal__header">
        <div class="install-plan-modal__icon"></div>
        <div class="install-plan-modal__title">
          <h2 id="app-start-failure-title">${escapeHtml(app?.name || 'App')} failed to start</h2>
          <div class="install-plan-modal__publisher">exit code ${escapeHtml(String(code))}</div>
        </div>
      </div>

      <div class="install-plan-modal__section">
        <h3>Error</h3>
        <p style="font-family: monospace; white-space: pre-wrap; margin: 0;">${escapeHtml(summary)}</p>
      </div>

      ${stderrTail ? `
        <div class="install-plan-modal__section">
          <h3>Last process output</h3>
          <pre class="install-plan-modal__stderr-tail" style="
            background: var(--color-bg-tertiary, #1a1a1a);
            color: var(--color-text-primary, #e0e0e0);
            padding: 12px;
            border-radius: 4px;
            max-height: 320px;
            overflow: auto;
            font-size: 12px;
            white-space: pre-wrap;
            word-break: break-word;
          ">${escapeHtml(stderrTail)}</pre>
        </div>
      ` : ''}

      ${renderHints(hints)}

      ${state.retrying ? `
        <div class="install-plan-modal__section">
          <p style="color: var(--color-text-secondary, #999);">Retrying start…</p>
        </div>
      ` : ''}

      ${state.retryError ? `
        <div class="install-plan-modal__validation-errors">
          <strong>Retry failed:</strong> ${escapeHtml(state.retryError)}
        </div>
      ` : ''}

      <div class="install-plan-modal__footer">
        <button data-action="close" type="button">Close</button>
        <button data-action="retry" type="button" class="primary"
                ${state.retrying ? 'disabled' : ''}>
          ${state.retrying ? 'Retrying…' : 'Retry start'}
        </button>
      </div>
    </div>
  `;
}

let _activeKeyHandler = null;

/**
 * Show the failure modal.
 *
 * @param {{ id: string, name: string, slug: string }} app
 * @param {{ error: string, errorDetail?: { code, stderrTail, hints } }} errorPayload
 * @param {{ onRetry: () => Promise<{ok: boolean, errorPayload?: object}> }} opts
 */
export function openAppStartFailureModal(app, errorPayload, opts = {}) {
  const root = ensureRoot();
  const state = { retrying: false, retryError: null };

  function paint() {
    root.innerHTML = renderModal(app, errorPayload, state);
    root.classList.add('active');
    root.style.display = 'flex';
    bind();
  }

  function close() {
    root.classList.remove('active');
    root.style.display = 'none';
    root.innerHTML = '';
    if (_activeKeyHandler) {
      document.removeEventListener('keydown', _activeKeyHandler);
      _activeKeyHandler = null;
    }
  }

  function bind() {
    root.querySelector('[data-action="close"]')?.addEventListener('click', close);
    root.querySelector('[data-action="retry"]')?.addEventListener('click', async () => {
      if (state.retrying) return;
      state.retrying = true;
      state.retryError = null;
      paint();
      try {
        const r = await (opts.onRetry?.() || Promise.resolve({ ok: false, error: 'no retry handler' }));
        if (r?.ok) {
          close();
          return;
        }
        // Surface the new failure (might be the same root cause, might be
        // different after the user's manual fix).
        if (r?.errorPayload) errorPayload = r.errorPayload;
        state.retrying = false;
        state.retryError = r?.error || 'retry failed';
        paint();
      } catch (e) {
        state.retrying = false;
        state.retryError = e?.message || String(e);
        paint();
      }
    });
  }

  _activeKeyHandler = (e) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', _activeKeyHandler);

  paint();
}

export function closeAppStartFailureModal() {
  const root = document.getElementById(MODAL_ID);
  if (root) {
    root.classList.remove('active');
    root.style.display = 'none';
    root.innerHTML = '';
  }
  if (_activeKeyHandler) {
    document.removeEventListener('keydown', _activeKeyHandler);
    _activeKeyHandler = null;
  }
}
