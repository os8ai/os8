// Developer Import dialog (PR 3.1).
//
// Paste a public GitHub URL → spinner while we draft an AppSpec → install
// plan modal opens with the auto-generated manifest. The user reviews +
// (PR 3.2) toggles permissions and acknowledges risks before approval.
//
// v1 uses a styled overlay with a single text input + URL validation;
// errors render inline rather than using window.alert.

import { openInstallPlanModalFromManifest } from './install-plan-modal.js';

const DIALOG_ID = 'devImportDialog';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function ensureRoot() {
  let root = document.getElementById(DIALOG_ID);
  if (root) return root;
  root = document.createElement('div');
  root.id = DIALOG_ID;
  root.className = 'modal-overlay';
  document.body.appendChild(root);
  return root;
}

function close(root) {
  root.classList.remove('active');
  root.style.display = 'none';
  root.innerHTML = '';
}

function render(root, { busy = false, error = null, url = '' } = {}) {
  root.innerHTML = `
    <div class="install-plan-modal" role="dialog" aria-labelledby="dev-import-title" style="max-width: 560px;">
      <div class="install-plan-modal__header">
        <div class="install-plan-modal__icon"></div>
        <div class="install-plan-modal__title">
          <h2 id="dev-import-title">Import from GitHub</h2>
          <div class="install-plan-modal__publisher">Build a draft manifest from any public GitHub repo</div>
        </div>
      </div>

      <div class="install-plan-modal__section">
        <p style="margin: 0 0 12px 0;">
          Paste a public GitHub repo URL. OS8 will fetch the repo metadata,
          detect the framework, and open the install plan modal with a draft
          manifest you can review before installing.
        </p>
        <label style="display:block; font-weight:600; margin-bottom: 6px;">GitHub URL</label>
        <input type="url"
          data-input="dev-import-url"
          placeholder="https://github.com/owner/repo"
          value="${escapeHtml(url)}"
          ${busy ? 'disabled' : ''}
          style="width: 100%; padding: 6px 10px; box-sizing: border-box;" />

        ${busy ? '<p style="margin-top: 12px;">Fetching repo metadata…</p>' : ''}
        ${error ? `<div class="install-plan-modal__validation-errors" style="margin-top: 12px;">
          <strong>Could not import:</strong> ${escapeHtml(error)}
        </div>` : ''}
      </div>

      <div class="install-plan-modal__footer">
        <span style="margin-right: auto; color: var(--color-text-secondary); font-size: 12px;">
          ${busy ? '' : 'Only public github.com repos are supported in v1.'}
        </span>
        <button data-action="cancel" type="button" ${busy ? 'disabled' : ''}>Cancel</button>
        <button data-action="import" type="button" class="primary" ${busy ? 'disabled' : ''}>Import</button>
      </div>
    </div>
  `;
}

function wireEvents(root, state) {
  root.querySelector('[data-action="cancel"]')?.addEventListener('click', () => close(root));

  root.addEventListener('click', e => {
    if (e.target === root && !state.busy) close(root);
  });

  const input = root.querySelector('[data-input="dev-import-url"]');
  input?.addEventListener('input', () => { state.url = input.value; });
  input?.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      kickImport(root, state);
    }
  });
  input?.focus();

  root.querySelector('[data-action="import"]')?.addEventListener('click', () =>
    kickImport(root, state)
  );
}

async function kickImport(root, state) {
  const url = (state.url || '').trim();
  if (!url) {
    state.error = 'paste a https://github.com/<owner>/<repo> URL';
    render(root, state);
    wireEvents(root, state);
    return;
  }
  if (!/^https?:\/\/github\.com\/[^/]+\/[^/]+/.test(url)) {
    state.error = 'only public GitHub repos are supported (https://github.com/...)';
    render(root, state);
    wireEvents(root, state);
    return;
  }

  state.busy = true;
  state.error = null;
  render(root, state);
  wireEvents(root, state);

  try {
    const r = await window.os8.appStore.devImportDraft(url);
    if (!r?.ok) throw new Error(r?.error || 'unknown error');
    close(root);
    await openInstallPlanModalFromManifest(r.manifest, {
      upstreamResolvedCommit: r.upstreamResolvedCommit,
      importMeta: r.importMeta,
    });
  } catch (e) {
    state.busy = false;
    state.error = e.message || 'import failed';
    render(root, state);
    wireEvents(root, state);
  }
}

export function openDevImportDialog() {
  const root = ensureRoot();
  const state = { busy: false, error: null, url: '' };
  render(root, state);
  wireEvents(root, state);
  root.classList.add('active');
  root.style.display = 'flex';
}
