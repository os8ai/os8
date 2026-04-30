// ===== Install Plan Modal (PR 1.4 shell) =====
// Renders an install plan from a catalog slug or a raw manifest YAML.
// PR 1.4 only — Approval gate, secrets validation, review findings, and
// post-approval log streaming arrive in PR 1.17.

const MODAL_ID = 'installPlanModal';

function ensureRoot() {
  let root = document.getElementById(MODAL_ID);
  if (root) return root;
  root = document.createElement('div');
  root.id = MODAL_ID;
  root.className = 'modal-overlay';
  document.body.appendChild(root);
  return root;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderArchBadge(architectures, hostArch) {
  if (!Array.isArray(architectures) || architectures.length === 0) return '';
  const compatible = architectures.includes(hostArch) ||
    (hostArch === 'arm64' && architectures.includes('arm64')) ||
    (hostArch === 'x64'   && architectures.includes('x86_64'));
  const cls = compatible
    ? 'install-plan-modal__arch-compatible'
    : 'install-plan-modal__arch-incompatible';
  const text = compatible
    ? `Compatible with this host (${hostArch})`
    : `Not compatible with this host (${hostArch}). Supported: ${architectures.join(', ')}`;
  return `<div class="${cls}">${escapeHtml(text)}</div>`;
}

function renderPermissions(manifest) {
  const perms = manifest?.permissions || {};
  const parts = [];

  if (perms.network) {
    parts.push(`<li><strong>Network outbound:</strong> ${perms.network.outbound ? 'allowed' : 'denied'}</li>`);
    if (perms.network.inbound) {
      parts.push(`<li style="color: var(--color-danger-text, #991b1b);"><strong>Network inbound:</strong> dev server reachable beyond localhost (rare)</li>`);
    }
  }
  parts.push(`<li><strong>Filesystem:</strong> ${escapeHtml(perms.filesystem || 'app-private')}</li>`);

  const caps = perms.os8_capabilities || [];
  if (caps.length === 0) {
    parts.push(`<li><strong>OS8 capabilities:</strong> none requested</li>`);
  } else {
    parts.push(`<li><strong>OS8 capabilities requested:</strong>
      <ul style="margin-top: 4px;">
        ${caps.map(c => `<li><span class="install-plan-modal__permission-cap">${escapeHtml(c)}</span></li>`).join('')}
      </ul>
    </li>`);
  }

  return `<ul class="install-plan-modal__permissions">${parts.join('')}</ul>`;
}

function renderSecrets(manifest) {
  const secrets = manifest?.permissions?.secrets || [];
  if (secrets.length === 0) {
    return `<p style="color: var(--color-text-secondary); font-size: 13px;">No secrets required.</p>`;
  }
  return secrets.map(s => `
    <div class="install-plan-modal__secret-row" data-secret-name="${escapeHtml(s.name)}">
      <label>
        <strong>${escapeHtml(s.name)}</strong>
        ${s.required ? ' <span style="color: var(--color-danger-text, #991b1b);">(required)</span>' : ''}
      </label>
      ${s.prompt ? `<span class="secret-prompt">${escapeHtml(s.prompt)}</span>` : ''}
      <input type="password" name="${escapeHtml(s.name)}"
        ${s.pattern ? `pattern="${escapeHtml(s.pattern)}"` : ''}
        placeholder="${escapeHtml(s.prompt || s.name)}"
        disabled />
    </div>
  `).join('');
}

function renderCommands(manifest) {
  const blocks = [];
  for (const key of ['install', 'postInstall', 'preStart']) {
    const cmds = manifest?.[key];
    if (!Array.isArray(cmds) || cmds.length === 0) continue;
    const lines = cmds
      .map(c => Array.isArray(c?.argv) ? c.argv.map(escapeHtml).join(' ') : '?')
      .join('\n');
    blocks.push(`<div><strong>${key}:</strong>\n<pre>${lines}</pre></div>`);
  }
  if (manifest?.start?.argv) {
    blocks.push(`<div><strong>start:</strong>\n<pre>${manifest.start.argv.map(escapeHtml).join(' ')}</pre></div>`);
  }
  if (blocks.length === 0) return '<p>No install commands.</p>';
  return `<div class="install-plan-modal__commands">${blocks.join('\n\n')}</div>`;
}

function renderValidationErrors(validation) {
  if (!validation || validation.ok) return '';
  return `
    <div class="install-plan-modal__validation-errors">
      <strong>Manifest does not pass v1 validation:</strong>
      <ul>
        ${validation.errors.map(e =>
          `<li><code>${escapeHtml(e.path)}</code>: ${escapeHtml(e.message)} <em>(${e.kind})</em></li>`
        ).join('')}
      </ul>
    </div>
  `;
}

function renderEntry(entry, validation, hostArch) {
  const m = entry.manifest || {};
  const channelClass = entry.channel === 'community'
    ? 'install-plan-modal__channel-badge--community'
    : entry.channel === 'developer-import'
      ? 'install-plan-modal__channel-badge--developer-import'
      : '';

  return `
    <div class="install-plan-modal">
      <div class="install-plan-modal__header">
        ${entry.iconUrl ? `<img class="install-plan-modal__icon" src="${escapeHtml(entry.iconUrl)}" alt="" />` : '<div class="install-plan-modal__icon"></div>'}
        <div class="install-plan-modal__title">
          <h2>${escapeHtml(entry.name)}<span class="install-plan-modal__channel-badge ${channelClass}">${escapeHtml(entry.channel)}</span></h2>
          <div class="install-plan-modal__publisher">by ${escapeHtml(entry.publisher || 'unknown')} · ${escapeHtml(entry.framework || entry.runtimeKind || '')}</div>
        </div>
      </div>

      ${renderValidationErrors(validation)}

      <div class="install-plan-modal__section">
        <h3>About</h3>
        <p>${escapeHtml(entry.description || m.description || '')}</p>
        ${m.upstream?.git ? `<div class="install-plan-modal__field">
          <span class="install-plan-modal__field-label">Source</span>
          <a href="#" class="install-plan-modal__field-value" data-external-href="${escapeHtml(m.upstream.git)}">${escapeHtml(m.upstream.git)}</a>
        </div>` : ''}
      </div>

      <div class="install-plan-modal__section">
        <h3>Architecture</h3>
        ${renderArchBadge(entry.architectures, hostArch)}
      </div>

      <div class="install-plan-modal__section">
        <h3>License</h3>
        <div class="install-plan-modal__field">
          <span class="install-plan-modal__field-label">License</span>
          <span class="install-plan-modal__field-value">${escapeHtml(entry.license || m.legal?.license || 'unknown')}</span>
        </div>
        <div class="install-plan-modal__field">
          <span class="install-plan-modal__field-label">Commercial use</span>
          <span class="install-plan-modal__field-value">${escapeHtml(m.legal?.commercial_use || 'unknown')}</span>
        </div>
        ${m.legal?.notes ? `<div class="install-plan-modal__field">
          <span class="install-plan-modal__field-label">Notes</span>
          <span class="install-plan-modal__field-value">${escapeHtml(m.legal.notes)}</span>
        </div>` : ''}
      </div>

      <div class="install-plan-modal__section">
        <h3>Permissions</h3>
        ${renderPermissions(m)}
      </div>

      <div class="install-plan-modal__section">
        <h3>Secrets</h3>
        ${renderSecrets(m)}
      </div>

      <div class="install-plan-modal__section">
        <h3>Install commands</h3>
        ${renderCommands(m)}
      </div>

      <div class="install-plan-modal__section">
        <h3>Review</h3>
        <p style="color: var(--color-text-secondary); font-size: 13px;">
          Security review wires in PR 1.6; the Install button arrives in PR 1.17.
        </p>
      </div>

      <div class="install-plan-modal__footer">
        <button data-action="cancel" type="button">Cancel</button>
        <button data-action="install" type="button" class="primary" disabled
          title="Approval gate enabled in PR 1.17">Install</button>
      </div>
    </div>
  `;
}

function getHostArch() {
  // process.arch is exposed on the renderer's `process` if nodeIntegration; in
  // OS8 the renderer is contextIsolated so we use navigator.userAgentData when
  // available, falling back to navigator.platform. This is approximate; the
  // canonical value comes from main process if needed (pending IPC channel).
  if (typeof process !== 'undefined' && process.arch) return process.arch;
  const ua = navigator.userAgent || '';
  if (/aarch64|arm64/i.test(ua)) return 'arm64';
  if (/x86_64|x64|win64|wow64/i.test(ua)) return 'x64';
  return 'unknown';
}

export async function openInstallPlanModalBySlug(slug, channel = 'verified') {
  const result = await window.os8.appStore.renderPlan(slug, channel);
  if (!result?.ok) {
    console.warn('[install-plan] renderPlan failed:', result?.error);
    alert(`Could not load install plan: ${result?.error || 'unknown error'}`);
    return;
  }
  renderModal(result.entry, result.validation);
}

export async function openInstallPlanModalFromYaml(yamlText, opts = {}) {
  const result = await window.os8.appStore.validateManifest(yamlText, opts);
  if (!result?.ok) {
    alert(`Manifest parse failed: ${result?.error}`);
    return;
  }
  // Synthetic entry — no catalog row.
  const entry = {
    slug: result.manifest.slug,
    name: result.manifest.name,
    publisher: result.manifest.publisher,
    channel: result.manifest.review?.channel || 'verified',
    iconUrl: null,
    description: result.manifest.description,
    license: result.manifest.legal?.license,
    runtimeKind: result.manifest.runtime?.kind,
    framework: result.manifest.framework,
    architectures: result.manifest.runtime?.arch || [],
    manifest: result.manifest,
  };
  renderModal(entry, result.validation);
}

function renderModal(entry, validation) {
  const root = ensureRoot();
  root.innerHTML = renderEntry(entry, validation, getHostArch());
  root.classList.add('active');
  root.style.display = 'flex';

  // Cancel + external link wiring.
  root.querySelector('[data-action="cancel"]').addEventListener('click', closeInstallPlanModal);
  root.addEventListener('click', e => {
    // Click on the overlay (outside the modal box) closes; click on the box does not.
    if (e.target === root) closeInstallPlanModal();
  });
  for (const a of root.querySelectorAll('[data-external-href]')) {
    a.addEventListener('click', ev => {
      ev.preventDefault();
      // External browser open is shell-only here; an IPC call lands in PR 1.17.
      // For now, stop default — clicking does nothing visible.
    });
  }
}

export function closeInstallPlanModal() {
  const root = document.getElementById(MODAL_ID);
  if (!root) return;
  root.classList.remove('active');
  root.style.display = 'none';
  root.innerHTML = '';
}
