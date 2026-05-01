// ===== Install Plan Modal (PR 1.4 shell + PR 1.17 interactivity) =====
//
// Renders a manifest-driven install plan and drives the install pipeline:
//   open modal  ── kicks off `appStore.install(...)` ──> jobId
//   subscribes to `appStore.onJobUpdate(...)` events from the main process
//   transitions: pending → cloning → reviewing → awaiting_approval
//      ↳ review report renders into the Review panel; gate evaluates
//      ↳ Install button enables when gates pass + secrets valid
//   approve  ──> `appStore.approve(jobId, secrets)` → installing → installed
//      ↳ progress streams into the log panel
//      ↳ on installed: success state + auto-close
//
// PR 1.18 adds the `os8://install` deeplink-driven entry point.

const MODAL_ID = 'installPlanModal';

// Module-level subscription handle so we can clean up across re-renders.
let _activeUnsubscribe = null;
let _activeState = null;   // { jobId, entry, secrets, review, errors[], statusHistory[] }

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

function getHostArch() {
  if (typeof process !== 'undefined' && process.arch) return process.arch;
  const ua = navigator.userAgent || '';
  if (/aarch64|arm64/i.test(ua)) return 'arm64';
  if (/x86_64|x64|win64|wow64/i.test(ua)) return 'x64';
  return 'unknown';
}

function archMatches(architectures, hostArch) {
  if (!Array.isArray(architectures) || architectures.length === 0) return true;
  const aliases = {
    arm64: ['arm64', 'aarch64'], aarch64: ['arm64', 'aarch64'],
    x86_64: ['x86_64', 'x64'],   x64: ['x86_64', 'x64'],
  }[hostArch] || [hostArch];
  return architectures.some(d => aliases.includes(d));
}

function renderArchBadge(architectures, hostArch) {
  if (!Array.isArray(architectures) || architectures.length === 0) return '';
  const compatible = archMatches(architectures, hostArch);
  const cls = compatible
    ? 'install-plan-modal__arch-compatible'
    : 'install-plan-modal__arch-incompatible';
  const text = compatible
    ? `Compatible with this host (${hostArch})`
    : `Not compatible with this host (${hostArch}). Supported: ${architectures.join(', ')}`;
  return `<div class="${cls}">${escapeHtml(text)}</div>`;
}

function renderPermissions(manifest, state) {
  // PR 3.2 — when dev-import mode, render interactive per-capability toggles.
  if (state?.devImportMode) return renderPermissionsDevImport(manifest);

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

// PR 3.2: per-capability toggles for developer-import. Groups by trust axis
// for scannability (the v1 capability list is 13 entries; flat is unreadable).
const DEV_IMPORT_CAP_GROUPS = [
  {
    label: 'Per-app storage',
    caps: ['blob.readwrite', 'blob.readonly', 'db.readwrite', 'db.readonly'],
  },
  {
    label: 'Communications',
    caps: ['telegram.send'],
  },
  {
    label: 'AI services',
    caps: ['imagegen', 'speak', 'youtube', 'x'],
  },
  {
    label: 'Google (read-only by default)',
    caps: ['google.calendar.readonly', 'google.calendar.readwrite',
           'google.drive.readonly',    'google.gmail.readonly'],
  },
  // mcp.<server>.<tool> deferred — wildcard form needs its own UI; user can
  // still hand-edit the manifest's permissions.os8_capabilities if needed.
];

function renderPermissionsDevImport(manifest) {
  const perms = manifest?.permissions || {};
  const declared = new Set(perms.os8_capabilities || []);
  const renderGroup = (g) => `
    <div class="install-plan-modal__perm-toggle-group">
      <strong>${escapeHtml(g.label)}</strong>
      ${g.caps.map(c => `
        <label class="install-plan-modal__perm-toggle">
          <input type="checkbox"
            data-cap-toggle="${escapeHtml(c)}"
            ${declared.has(c) ? 'checked' : ''} />
          <code>${escapeHtml(c)}</code>
        </label>
      `).join('')}
    </div>
  `;
  return `
    <div class="install-plan-modal__perm-toggle-group">
      <strong>Network</strong>
      <label class="install-plan-modal__perm-toggle">
        <input type="checkbox"
          data-perm-toggle="network.outbound"
          ${perms.network?.outbound ? 'checked' : ''} />
        <span><strong>Outbound</strong> — let this app make HTTP requests to the internet</span>
      </label>
      <label class="install-plan-modal__perm-toggle">
        <input type="checkbox"
          data-perm-toggle="network.inbound"
          ${perms.network?.inbound ? 'checked' : ''} />
        <span style="color: var(--color-danger-text);"><strong>Inbound (rare)</strong> — let this app's dev server be reachable beyond localhost</span>
      </label>
    </div>
    ${DEV_IMPORT_CAP_GROUPS.map(renderGroup).join('')}
  `;
}

function renderDevImportWarnings() {
  return `
    <div class="install-plan-modal__dev-import-warning">
      <strong>Developer Import — uncurated</strong>
      <p>This app's manifest was auto-generated from upstream files. No human
      curator has reviewed it. Capabilities below are off by default; tick
      only the ones you want this app to have.</p>
    </div>
  `;
}

function renderDevImportRiskAck(state) {
  return `
    <label class="install-plan-modal__dev-import-ack">
      <input type="checkbox" data-action="ack-dev-import-risks" ${state.devImportRisksAcknowledged ? 'checked' : ''} />
      I understand this app has <strong>not</strong> been reviewed by OS8 curators.
      I trust this source and accept the risks of installing it.
    </label>
  `;
}

function renderSecretInputs(manifest) {
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
      <input type="password"
        name="${escapeHtml(s.name)}"
        data-secret-input="${escapeHtml(s.name)}"
        ${s.pattern ? `data-pattern="${escapeHtml(s.pattern)}"` : ''}
        placeholder="${escapeHtml(s.prompt || s.name)}" />
    </div>
  `).join('');
}

function renderCommands(manifest) {
  const blocks = [];
  for (const key of ['install', 'postInstall', 'preStart']) {
    const cmds = manifest?.[key];
    if (!Array.isArray(cmds) || cmds.length === 0) continue;
    const lines = cmds
      .map(c => Array.isArray(c?.argv) ? JSON.stringify(c.argv) : '?')
      .join('\n');
    blocks.push(`<div><strong>${key}:</strong>\n<pre>${escapeHtml(lines)}</pre></div>`);
  }
  if (manifest?.start?.argv) {
    blocks.push(`<div><strong>start:</strong>\n<pre>${escapeHtml(JSON.stringify(manifest.start.argv))}</pre></div>`);
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

function renderReviewPanel(state) {
  const review = state.review;
  const status = state.lastStatus;
  if (!review) {
    if (status === 'cloning')   return `<p>Cloning upstream…</p>`;
    if (status === 'reviewing') return `<p>Running security review…</p>`;
    if (status === 'pending')   return `<p>Queued.</p>`;
    return `<p style="color: var(--color-text-secondary); font-size: 13px;">Click Install to begin the review.</p>`;
  }
  const riskColor = review.riskLevel === 'low'    ? '#065f46'
                  : review.riskLevel === 'medium' ? '#92400e'
                  : '#991b1b';
  const findingsBySeverity = { critical: [], warning: [], info: [] };
  for (const f of (review.findings || [])) {
    (findingsBySeverity[f.severity] || findingsBySeverity.info).push(f);
  }
  const renderFinding = (f) => `
    <li>
      <strong>[${escapeHtml(f.severity)}] ${escapeHtml(f.category || 'other')}</strong>
      ${f.file ? `<code>${escapeHtml(f.file)}${f.line ? ':' + f.line : ''}</code>` : ''}
      <div>${escapeHtml(f.description)}</div>
      ${f.snippet ? `<pre style="background: var(--color-bg-elevated); padding: 6px;">${escapeHtml(String(f.snippet).slice(0, 400))}</pre>` : ''}
    </li>`;
  const sections = [];
  if (findingsBySeverity.critical.length > 0) {
    sections.push(`<details open><summary>Critical (${findingsBySeverity.critical.length})</summary>
      <ul>${findingsBySeverity.critical.map(renderFinding).join('')}</ul></details>`);
  }
  if (findingsBySeverity.warning.length > 0) {
    sections.push(`<details><summary>Warnings (${findingsBySeverity.warning.length})</summary>
      <ul>${findingsBySeverity.warning.map(renderFinding).join('')}</ul></details>`);
  }
  if (findingsBySeverity.info.length > 0) {
    sections.push(`<details><summary>Info (${findingsBySeverity.info.length})</summary>
      <ul>${findingsBySeverity.info.map(renderFinding).join('')}</ul></details>`);
  }

  return `
    <div>
      <span style="display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:600; color: white; background: ${riskColor};">
        risk: ${escapeHtml(review.riskLevel)}
      </span>
      <p style="margin: 8px 0;">${escapeHtml(review.summary || '')}</p>
      ${sections.join('') || '<p>No findings.</p>'}
    </div>
  `;
}

function renderLogPanel(state) {
  if (!state.logs || state.logs.length === 0) {
    return state.lastStatus === 'installing'
      ? `<p>Running install…</p>`
      : '';
  }
  const tail = state.logs.slice(-30).join('');
  return `<pre class="install-plan-modal__commands" style="max-height: 200px; overflow:auto;">${escapeHtml(tail)}</pre>`;
}

function gateEvaluation(manifest, state, hostArch) {
  if (!archMatches(manifest?.runtime?.arch, hostArch)) return { ok: false, reason: 'arch incompatible with this host' };

  const required = (manifest?.permissions?.secrets || []).filter(s => s.required);
  for (const s of required) {
    const v = state.secrets?.[s.name];
    if (!v?.trim()) return { ok: false, reason: `${s.name} required` };
    if (s.pattern) {
      try {
        if (!new RegExp(s.pattern).test(v)) return { ok: false, reason: `${s.name} doesn't match expected format` };
      } catch (_) { /* bad regex in manifest — ignore */ }
    }
  }

  // PR 3.2: developer-import requires explicit risk acknowledgment. Apply
  // BEFORE the review-status gates below — for dev-import the modal opens
  // before any install job runs, so we never reach 'awaiting_approval'
  // unless the user can click Install to kick the job.
  if (state.devImportMode && !state.devImportRisksAcknowledged) {
    return { ok: false, reason: 'check "I understand the risks" to enable install' };
  }

  // PR 3.2 / hotfix: developer-import opens the modal BEFORE any install job
  // is started. The first Install click kicks the pipeline (the click
  // handler routes to `installFromManifest`). Verified deeplinks already
  // have a job in flight by the time the modal opens, so the
  // `awaiting_approval` gate below still applies for them.
  // We only short-circuit when no job AND no review exist — once a review
  // is present, we fall through to enforce critical-findings + risk-level.
  if (state.devImportMode && !state.jobId && !state.review) {
    return { ok: true };
  }

  if (state.lastStatus !== 'awaiting_approval') return { ok: false, reason: 'review not yet complete' };
  if (!state.review) return { ok: false, reason: 'review not yet available' };

  // PR 3.10 hotfix: scan results are ADVISORY across all channels — the user
  // is always the final authority over what installs on their machine. Every
  // severity now resolves to either ok:true (no findings) or ok:'override'
  // (findings present, user confirms via dialog). The only remaining hard
  // blocks are structural impossibilities (arch incompatibility, missing
  // required secrets, both checked above) and the dev-import ack flag. Even
  // MAL-* malware advisories from osv-scanner are overridable — the click-
  // handler's confirm dialog surfaces the offending findings (with an extra
  // KNOWN MALWARE warning when MAL-* is detected) so the user reads exactly
  // what they're overriding before clicking OK.
  const findings = state.review.findings || [];
  const criticals = findings.filter(f => f.severity === 'critical');
  if (criticals.length > 0 && !state.secondConfirmed) {
    const hasMalwareAdvisory = criticals.some(f => /\bMAL-\d/.test(f.description || ''));
    return {
      ok: 'override',
      reason: hasMalwareAdvisory
        ? `${criticals.length} CRITICAL findings (incl. malware advisory) — confirm to override`
        : `${criticals.length} critical finding${criticals.length === 1 ? '' : 's'} — confirm to override`,
    };
  }
  if (state.review.riskLevel === 'high' && !state.secondConfirmed) {
    return { ok: 'override', reason: 'high risk — confirm to override' };
  }
  if (state.review.riskLevel === 'medium' && !state.secondConfirmed) {
    return { ok: 'override', reason: 'medium risk — confirm to override' };
  }

  return { ok: true };
}

function renderEntry(state) {
  const entry = state.entry;
  const m = entry.manifest || {};
  const hostArch = getHostArch();
  const channelClass = entry.channel === 'community'
    ? 'install-plan-modal__channel-badge--community'
    : entry.channel === 'developer-import'
      ? 'install-plan-modal__channel-badge--developer-import'
      : '';
  const gate = gateEvaluation(m, state, hostArch);
  const installLabel = state.lastStatus === 'installing'    ? 'Installing…'
                     : state.lastStatus === 'installed'     ? 'Installed'
                     : gate.ok === 'override'              ? 'Install (override)'
                     : 'Install';
  const installDisabled = state.lastStatus === 'installing'
    || state.lastStatus === 'installed'
    || (gate.ok !== true && gate.ok !== 'override');

  // PR 3.2: dev-import reorders sections to surface the security review
  // before permissions (so the user reads findings before granting capabilities).
  const sections = [];

  if (state.devImportMode) sections.push(renderDevImportWarnings());

  sections.push(`
    <div class="install-plan-modal__section">
      <h3>About</h3>
      <p>${escapeHtml(entry.description || m.description || '')}</p>
      ${m.upstream?.git ? `<div class="install-plan-modal__field">
        <span class="install-plan-modal__field-label">Source</span>
        <span class="install-plan-modal__field-value">${escapeHtml(m.upstream.git)}</span>
      </div>` : ''}
      ${state.devImportMode && entry.upstreamResolvedCommit ? `<div class="install-plan-modal__field">
        <span class="install-plan-modal__field-label">Commit</span>
        <span class="install-plan-modal__field-value"><code>${escapeHtml(entry.upstreamResolvedCommit)}</code></span>
      </div>` : ''}
      ${state.devImportMode && state.devImportMeta?.refLabel ? `<div class="install-plan-modal__field">
        <span class="install-plan-modal__field-label">Ref</span>
        <span class="install-plan-modal__field-value">${escapeHtml(state.devImportMeta.refLabel)} (${escapeHtml(state.devImportMeta.refKind || '')})</span>
      </div>` : ''}
    </div>
  `);

  if (state.devImportMode) {
    sections.push(`
      <div class="install-plan-modal__section" data-panel="review">
        <h3>Security review</h3>
        ${renderReviewPanel(state)}
      </div>
    `);
    sections.push(`
      <div class="install-plan-modal__section">
        <h3>Permissions (off by default)</h3>
        ${renderPermissions(m, state)}
      </div>
    `);
    sections.push(`
      <div class="install-plan-modal__section">
        <h3>Secrets</h3>
        ${renderSecretInputs(m)}
      </div>
    `);
    sections.push(`
      <div class="install-plan-modal__section">
        <h3>Install commands</h3>
        ${renderCommands(m)}
      </div>
    `);
    sections.push(`
      <details class="install-plan-modal__section">
        <summary><h3 style="display:inline-block; margin: 0;">Architecture &amp; License</h3></summary>
        ${renderArchBadge(entry.architectures, hostArch)}
        <div class="install-plan-modal__field">
          <span class="install-plan-modal__field-label">License</span>
          <span class="install-plan-modal__field-value">${escapeHtml(entry.license || m.legal?.license || 'unknown')}</span>
        </div>
        <div class="install-plan-modal__field">
          <span class="install-plan-modal__field-label">Commercial use</span>
          <span class="install-plan-modal__field-value">${escapeHtml(m.legal?.commercial_use || 'unknown')}</span>
        </div>
      </details>
    `);
  } else {
    sections.push(`
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
      </div>
      <div class="install-plan-modal__section">
        <h3>Permissions</h3>
        ${renderPermissions(m, state)}
      </div>
      <div class="install-plan-modal__section">
        <h3>Secrets</h3>
        ${renderSecretInputs(m)}
      </div>
      <div class="install-plan-modal__section">
        <h3>Install commands</h3>
        ${renderCommands(m)}
      </div>
      <div class="install-plan-modal__section" data-panel="review">
        <h3>Security review</h3>
        ${renderReviewPanel(state)}
      </div>
    `);
  }

  return `
    <div class="install-plan-modal" role="dialog" aria-labelledby="install-plan-title">
      <div class="install-plan-modal__header">
        ${entry.iconUrl ? `<img class="install-plan-modal__icon" src="${escapeHtml(entry.iconUrl)}" alt="" />` : '<div class="install-plan-modal__icon"></div>'}
        <div class="install-plan-modal__title">
          <h2 id="install-plan-title">${escapeHtml(entry.name)}<span class="install-plan-modal__channel-badge ${channelClass}">${escapeHtml(entry.channel || 'verified')}</span></h2>
          <div class="install-plan-modal__publisher">by ${escapeHtml(entry.publisher || 'unknown')} · ${escapeHtml(entry.framework || entry.runtimeKind || '')}</div>
        </div>
      </div>

      ${renderValidationErrors(state.validation)}

      ${sections.join('')}

      <div class="install-plan-modal__section" data-panel="logs">
        ${renderLogPanel(state)}
      </div>

      ${state.error ? `<div class="install-plan-modal__validation-errors"><strong>Install failed:</strong> ${escapeHtml(state.error)}</div>` : ''}

      ${state.devImportMode ? renderDevImportRiskAck(state) : ''}

      <div class="install-plan-modal__footer">
        <span style="margin-right: auto; color: var(--color-text-secondary); font-size: 12px;">
          ${gate.ok === true ? '' : escapeHtml(gate.reason || '')}
        </span>
        <button data-action="cancel" type="button">${state.lastStatus === 'installed' ? 'Close' : 'Cancel'}</button>
        <button data-action="install" type="button" class="primary"
          ${installDisabled ? 'disabled' : ''}
          ${gate.ok === 'override' ? 'data-override="1"' : ''}>${escapeHtml(installLabel)}</button>
      </div>
    </div>
  `;
}

function patchModal(state) {
  const root = document.getElementById(MODAL_ID);
  if (!root) return;
  // Cheap full-rerender — modal isn't large and patch frequency is low.
  // Preserve secret values across rerender so the user doesn't lose typing.
  root.innerHTML = renderEntry(state);
  wireEvents(state);
  // Restore secret input values.
  for (const [name, value] of Object.entries(state.secrets || {})) {
    const inp = root.querySelector(`[data-secret-input="${CSS.escape(name)}"]`);
    if (inp) inp.value = value;
  }
}

function wireEvents(state) {
  const root = document.getElementById(MODAL_ID);
  if (!root) return;

  root.querySelector('[data-action="cancel"]')?.addEventListener('click', async () => {
    if (state.jobId && state.lastStatus !== 'installed' && state.lastStatus !== 'failed' && state.lastStatus !== 'cancelled') {
      try { await window.os8.appStore.cancel(state.jobId); }
      catch (_) { /* ignore — job may have advanced */ }
    }
    closeInstallPlanModal();
  });

  root.querySelector('[data-action="install"]')?.addEventListener('click', async () => {
    const btn = root.querySelector('[data-action="install"]');
    if (btn?.disabled) return;

    if (btn?.getAttribute('data-override') === '1' && !state.secondConfirmed) {
      const review = state.review || {};
      const riskLevel = review.riskLevel || 'medium';
      const findings = review.findings || [];
      const criticals = findings.filter(f => f.severity === 'critical');
      const hasMalwareAdvisory = criticals.some(f => /\bMAL-\d/.test(f.description || ''));

      let warning;
      if (criticals.length > 0) {
        const malwareHeader = hasMalwareAdvisory
          ? '⚠ KNOWN MALWARE WARNING\n\n' +
            'The security scan found dependencies flagged as known-malicious in the OSV malware advisory database (MAL-* IDs). Installing this app may compromise your machine.\n\n'
          : '';
        const lines = criticals.map((f, i) => {
          const desc = (f.description || '').slice(0, 240);
          return `${i + 1}. [${f.category || 'other'}] ${desc}`;
        }).join('\n\n');
        warning =
          malwareHeader +
          `This app has ${criticals.length} CRITICAL finding${criticals.length === 1 ? '' : 's'}:\n\n` +
          lines +
          (review.summary ? `\n\nReview summary:\n${review.summary}` : '') +
          '\n\nInstall anyway?';
      } else if (review.summary) {
        warning =
          `This app has ${riskLevel}-risk findings.\n\n` +
          `Review summary:\n${review.summary}\n\n` +
          'Install anyway?';
      } else {
        warning = `This app has ${riskLevel}-risk findings. Install anyway?`;
      }

      const ok = window.confirm(warning);
      if (!ok) return;
      state.secondConfirmed = true;
      patchModal(state);
      return;
    }

    if (state.lastStatus === 'awaiting_approval') {
      const r = await window.os8.appStore.approve(state.jobId, state.secrets || {});
      if (!r?.ok) {
        state.error = r?.error || 'approve failed';
        patchModal(state);
      }
    } else if (!state.jobId) {
      // No job yet — this happens when the modal was opened by-slug and no
      // prior `appStore.install(...)` was issued. Kick the install now.
      const r = state.devImportMode
        ? await window.os8.appStore.installFromManifest(
            state.entry.manifest,
            state.entry.upstreamResolvedCommit,
            'modal'
          )
        : await window.os8.appStore.install(
            state.entry.slug,
            state.entry.upstreamResolvedCommit,
            state.entry.channel,
            'modal'
          );
      if (!r?.ok) {
        state.error = r?.error || 'install failed';
        patchModal(state);
        return;
      }
      state.jobId = r.jobId;
      patchModal(state);
    }
  });

  // Secret inputs — store and re-evaluate the gate on every keystroke.
  for (const inp of root.querySelectorAll('[data-secret-input]')) {
    inp.addEventListener('input', () => {
      state.secrets = state.secrets || {};
      state.secrets[inp.dataset.secretInput] = inp.value;
      // Just patch the footer's Install button enable/disable — full rerender
      // would clobber focus.
      const installBtn = root.querySelector('[data-action="install"]');
      const gate = gateEvaluation(state.entry.manifest, state, getHostArch());
      const inactive = state.lastStatus === 'installing' || state.lastStatus === 'installed';
      installBtn.disabled = inactive || (gate.ok !== true && gate.ok !== 'override');
      installBtn.textContent = gate.ok === 'override' ? 'Install (override)' : 'Install';
      installBtn.toggleAttribute('data-override', gate.ok === 'override');
      const reasonEl = root.querySelector('.install-plan-modal__footer span');
      if (reasonEl) reasonEl.textContent = gate.ok === true ? '' : (gate.reason || '');
    });
  }

  // PR 3.2 — developer-import per-capability toggles. Mutate the manifest
  // in place so the toggled values flow through to startFromManifest's
  // synthetic catalog row, the security review, and the running app's
  // capability surface.
  for (const cb of root.querySelectorAll('[data-perm-toggle]')) {
    cb.addEventListener('change', () => {
      const path = cb.dataset.permToggle.split('.');
      const perms = state.entry.manifest.permissions = state.entry.manifest.permissions || {};
      let target = perms;
      for (let i = 0; i < path.length - 1; i++) {
        target[path[i]] = target[path[i]] || {};
        target = target[path[i]];
      }
      target[path[path.length - 1]] = cb.checked;
      patchModal(state);
    });
  }
  for (const cb of root.querySelectorAll('[data-cap-toggle]')) {
    cb.addEventListener('change', () => {
      const cap = cb.dataset.capToggle;
      const perms = state.entry.manifest.permissions = state.entry.manifest.permissions || {};
      const list = perms.os8_capabilities = perms.os8_capabilities || [];
      const idx = list.indexOf(cap);
      if (cb.checked && idx < 0) list.push(cap);
      else if (!cb.checked && idx >= 0) list.splice(idx, 1);
      patchModal(state);
    });
  }
  // PR 3.2 — risk acknowledgment checkbox.
  const ackCb = root.querySelector('[data-action="ack-dev-import-risks"]');
  if (ackCb) {
    ackCb.addEventListener('change', () => {
      state.devImportRisksAcknowledged = ackCb.checked;
      patchModal(state);
    });
  }

  // PR 3.10 hotfix: click-on-overlay no longer dismisses. The install-plan
  // modal drives a state machine (review job in flight, secrets entered,
  // ack ticked, etc.) — a stray click on the dimmed backdrop should not
  // abort progress or lose state. Users dismiss via the explicit Cancel
  // button.
}

function applyJobUpdate(state, payload) {
  if (!payload || payload.jobId !== state.jobId) return;

  if (payload.kind === 'status') {
    state.lastStatus = payload.status;
    state.statusHistory.push(payload.status);
    if (payload.job?.review_report) {
      try { state.review = JSON.parse(payload.job.review_report); }
      catch (_) { /* ignore */ }
    }
    if (payload.status === 'installed') {
      state.appId = payload.appId || state.appId;
      patchModal(state);
      // PR 3.11 hotfix: dev-import installs go through AppService.createExternal
      // which doesn't fire the `apps:created` IPC event that manual app
      // creation does — so the home grid is stale after install. Dispatch a
      // renderer-internal event main.js listens for; main.js's existing
      // loadApps() refreshes the grid + assistant button.
      document.dispatchEvent(new CustomEvent('os8:app-installed', {
        detail: { appId: state.appId },
      }));
      // Auto-close after a short success delay.
      setTimeout(() => closeInstallPlanModal(), 1500);
      return;
    }
    if (payload.status === 'failed') {
      state.error = payload.message || 'install failed';
    }
  } else if (payload.kind === 'log') {
    state.logs = state.logs || [];
    state.logs.push(payload.message || (payload.chunk ?? ''));
  } else if (payload.kind === 'failed') {
    state.error = payload.message || 'install failed';
  }

  patchModal(state);
}

function startState(entry, validation) {
  return {
    entry,
    validation,
    secrets: {},
    review: null,
    lastStatus: null,
    statusHistory: [],
    logs: [],
    error: null,
    secondConfirmed: false,
    jobId: null,
    appId: null,
    // PR 3.1: dev-import mode toggles strict modal styling + per-capability
    // opt-in toggles (PR 3.2). Off for verified/community installs.
    devImportMode: false,
    devImportRisksAcknowledged: false,
    devImportMeta: null,
  };
}

function fetchInitialReviewIfNeeded(state) {
  // If the modal opens with an existing job (e.g. from `os8://install`), pull
  // the current state once so we display review report + status immediately.
  if (!state.jobId) return;
  window.os8.appStore.getJob(state.jobId).then(r => {
    if (!r?.ok || !r.job) return;
    state.lastStatus = r.job.status;
    if (r.job.reviewReport) state.review = r.job.reviewReport;
    patchModal(state);
  }).catch(() => {});
}

export async function openInstallPlanModalBySlug(slug, channel = 'verified', opts = {}) {
  const result = await window.os8.appStore.renderPlan(slug, channel);
  if (!result?.ok) {
    console.warn('[install-plan] renderPlan failed:', result?.error);
    alert(`Could not load install plan: ${result?.error || 'unknown error'}`);
    return;
  }
  const state = startState(result.entry, result.validation);
  if (opts.jobId) state.jobId = opts.jobId;
  showModal(state);
  fetchInitialReviewIfNeeded(state);
}

export async function openInstallPlanModalFromYaml(yamlText, opts = {}) {
  const result = await window.os8.appStore.validateManifest(yamlText, opts);
  if (!result?.ok) {
    alert(`Manifest parse failed: ${result?.error}`);
    return;
  }
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
    upstreamResolvedCommit: opts.upstreamResolvedCommit || null,
    manifest: result.manifest,
  };
  const state = startState(entry, result.validation);
  showModal(state);
}

/**
 * Open the install plan modal with a manifest object directly (PR 3.1).
 * Used by Developer Import to skip the YAML round-trip — the drafter
 * produces a parsed manifest that we feed straight in.
 *
 * @param {object} manifest - parsed AppSpec
 * @param {{ upstreamResolvedCommit?: string, importMeta?: object }} [opts]
 */
export async function openInstallPlanModalFromManifest(manifest, opts = {}) {
  // Re-validate via the parsed-object IPC path (no YAML round-trip needed
  // since the drafter already produces a structured manifest).
  const result = await window.os8.appStore.validateManifestObject(manifest, {
    upstreamResolvedCommit: opts.upstreamResolvedCommit,
  });
  if (!result?.ok) {
    alert(`Manifest validation failed: ${result?.error || 'unknown'}`);
    return;
  }
  const entry = {
    slug: manifest.slug,
    name: manifest.name,
    publisher: manifest.publisher,
    channel: 'developer-import',
    iconUrl: null,
    description: manifest.description,
    license: manifest.legal?.license,
    runtimeKind: manifest.runtime?.kind,
    framework: manifest.framework,
    architectures: manifest.runtime?.arch || [],
    upstreamResolvedCommit: opts.upstreamResolvedCommit || null,
    manifest: result.manifest,
    devImportMeta: opts.importMeta || null,
  };
  const state = startState(entry, result.validation);
  state.devImportMode = true;            // PR 3.2 reads this for strict-modal styling
  state.devImportMeta = opts.importMeta || null;
  showModal(state);
}

function showModal(state) {
  const root = ensureRoot();
  _activeState = state;
  patchModal(state);
  root.classList.add('active');
  root.style.display = 'flex';

  // Subscribe to job updates from the main process. The IPC layer relays
  // every InstallEvents emit; we filter by jobId in applyJobUpdate.
  if (window.os8?.appStore?.onJobUpdate) {
    if (_activeUnsubscribe) _activeUnsubscribe();
    _activeUnsubscribe = window.os8.appStore.onJobUpdate(payload =>
      applyJobUpdate(state, payload));
  }
}

export function closeInstallPlanModal() {
  if (_activeUnsubscribe) {
    try { _activeUnsubscribe(); } catch (_) { /* ignore */ }
    _activeUnsubscribe = null;
  }
  _activeState = null;

  const root = document.getElementById(MODAL_ID);
  if (!root) return;
  root.classList.remove('active');
  root.style.display = 'none';
  root.innerHTML = '';
}

// Export the gate function for unit tests.
export { gateEvaluation };
