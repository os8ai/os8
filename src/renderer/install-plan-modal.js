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
        ${renderCapabilityListItems(caps)}
      </ul>
    </li>`);
  }
  return `<ul class="install-plan-modal__permissions">${parts.join('')}</ul>`;
}

// PR 4.7: group MCP capabilities by server. A `mcp.<server>.*` wildcard
// renders as one row with explanatory copy ("all current and future tools")
// so the user understands the trust grant scopes to the server, not a
// snapshot of its current toolset.
function renderCapabilityListItems(caps) {
  const nonMcp = [];
  const mcpByServer = new Map();
  for (const c of caps) {
    const m = typeof c === 'string' ? c.match(/^mcp\.([^.]+)\.(.+)$/) : null;
    if (!m) {
      nonMcp.push(c);
      continue;
    }
    const [, server, tool] = m;
    if (!mcpByServer.has(server)) mcpByServer.set(server, []);
    mcpByServer.get(server).push(tool);
  }
  const lines = [];
  for (const c of nonMcp) {
    lines.push(`<li><span class="install-plan-modal__permission-cap">${escapeHtml(c)}</span></li>`);
  }
  for (const [server, tools] of mcpByServer.entries()) {
    if (tools.includes('*')) {
      lines.push(`<li>
        <span class="install-plan-modal__permission-cap">mcp.${escapeHtml(server)}.*</span>
        — <strong>all current and future tools</strong> on the
        <code>${escapeHtml(server)}</code> MCP server.
      </li>`);
    } else {
      lines.push(`<li>
        <span class="install-plan-modal__permission-cap">mcp.${escapeHtml(server)}</span>:
        ${tools.map(t => `<code>${escapeHtml(t)}</code>`).join(', ')}
      </li>`);
    }
  }
  return lines.join('');
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

// Tier 2A: render the opt-in setup-script panel. One row per candidate
// with a checkbox, the file path, a one-line summary, the exact command
// that will run, and a collapsible source preview.
// Tier 2A follow-up: when the drafter detects argparse `choices=[...]`
// on a candidate script, the modal renders a <select> per flag so the
// user can pick a value without leaving the modal. Until every flag has
// a value, the candidate's checkbox stays disabled (the script can't
// run with no args; ticking the box would just queue a known-failing
// postInstall).
function setupScriptHasUnpickedChoices(s, chosenForScript) {
  const flags = Object.keys(s.argChoices || {});
  if (flags.length === 0) return false;
  for (const flag of flags) {
    if (!chosenForScript || !chosenForScript[flag]) return true;
  }
  return false;
}

function renderSetupScripts(setupScripts, checkedPaths, setupScriptArgChoices = {}) {
  const rows = setupScripts.map((s, i) => {
    const chosenForScript = setupScriptArgChoices[s.path] || {};
    const hasUnpicked = setupScriptHasUnpickedChoices(s, chosenForScript);
    const checked = checkedPaths.has(s.path) && !hasUnpicked;
    const summary = s.summary || `Will run: ${s.argv.join(' ')}`;
    const previewBlock = s.source ? `
      <details class="install-plan-modal__setup-script-preview">
        <summary>Preview source</summary>
        <pre><code>${escapeHtml(s.source)}</code></pre>
      </details>
    ` : '';
    // Warn when the script's argparse / shell argv requires arguments —
    // running with no args would fail (e.g. download_model.py needs
    // `--models all`). The drafter sets requiresArgs; the modal renders
    // a warning + leaves the checkbox unchecked by default. When
    // argChoices are also present the dropdown handles the value pick;
    // the warning still renders so the user knows the box stays
    // disabled until they make a selection.
    const warningBlock = s.requiresArgs ? `
      <div class="install-plan-modal__setup-script-warning"
           style="color: var(--color-warning, #d97706); font-size: 12px; margin-top: 4px;">
        ⚠ This script declares required arguments. Review the source preview
        and uncheck if you don't know what values to pass — running it with
        no args will fail.
      </div>
    ` : '';
    const flagEntries = Object.entries(s.argChoices || {});
    const choicesBlock = flagEntries.length > 0 ? `
      <div class="install-plan-modal__setup-script-choices"
           style="margin-top: 6px; display: flex; flex-direction: column; gap: 4px;">
        ${flagEntries.map(([flag, values]) => `
          <label style="font-size: 12px; display: flex; align-items: center; gap: 6px;">
            <code>${escapeHtml(flag)}</code>
            <select data-setup-script-choice="${escapeHtml(s.path)}"
                    data-flag="${escapeHtml(flag)}">
              <option value="">— pick a value —</option>
              ${values.map(v => {
                const selected = chosenForScript[flag] === v ? 'selected' : '';
                return `<option value="${escapeHtml(v)}" ${selected}>${escapeHtml(v)}</option>`;
              }).join('')}
            </select>
          </label>
        `).join('')}
      </div>
    ` : '';
    return `
      <div class="install-plan-modal__setup-script">
        <label class="install-plan-modal__setup-script-row">
          <input type="checkbox"
                 data-setup-script="${escapeHtml(s.path)}"
                 ${checked ? 'checked' : ''}
                 ${hasUnpicked ? 'disabled' : ''}
                 aria-describedby="setup-script-cmd-${i}">
          <div class="install-plan-modal__setup-script-body">
            <div class="install-plan-modal__setup-script-path"><code>${escapeHtml(s.path)}</code></div>
            ${summary ? `<div class="install-plan-modal__setup-script-summary">${escapeHtml(summary)}</div>` : ''}
            <div id="setup-script-cmd-${i}" class="install-plan-modal__setup-script-cmd">
              Will run: <code>${escapeHtml(assembleSetupArgv(s, chosenForScript).join(' '))}</code>
            </div>
            ${choicesBlock}
            ${warningBlock}
            ${previewBlock}
          </div>
        </label>
      </div>
    `;
  });
  return rows.join('');
}

// Pure helper — exported for direct unit tests. Merges chosen flag/value
// pairs into the candidate's argv. Skipped flags (empty/missing values)
// are dropped from the merge; the renderer disables the row's checkbox
// in that case so the partial-argv state never reaches Install.
export function assembleSetupArgv(scriptCandidate, chosenForScript) {
  const argv = [...scriptCandidate.argv];
  const choices = scriptCandidate.argChoices || {};
  for (const flag of Object.keys(choices)) {
    const value = chosenForScript && chosenForScript[flag];
    if (value) argv.push(flag, value);
  }
  return argv;
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

// PR 4.1: log panel renders the buffered adapter output as scrollable,
// stream-classified rows. Last LOG_LINES_RENDERED_MAX kept in DOM so the
// modal stays responsive on long installs; full state.logs buffer is
// preserved for "Download Logs". Lines are kept as
// `{ stream: 'stdout'|'stderr'|'info', line, ts }` objects.
const LOG_LINES_RENDERED_MAX = 500;

function formatLogTs(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"'`=]/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;', '=': '&#61;'
  }[c]));
}

// PR 4.4 — first-install consent moment. Surfaces the telemetry opt-in
// once, on the very first install. Defaults to checked (the user can
// uncheck before approving). After the first install, `consent_shown`
// is flipped and this block hides forever; the permanent toggle in
// Settings → App Store is the only place to change it later.
function renderFirstInstallConsent(state) {
  if (!state.firstInstallConsent) return '';
  const checked = state.firstInstallConsentAccepted !== false;
  return `
    <div class="install-plan-modal__consent">
      <label>
        <input type="checkbox"
               data-action="consent-toggle"
               ${checked ? 'checked' : ''} />
        <strong>Help OS8 by sending anonymous install telemetry</strong>
      </label>
      <p class="install-plan-modal__consent-hint">
        We send adapter / framework / channel / a failure-line fingerprint
        — never raw logs, paths, secrets, hostnames, or your username.
        You can change this any time in Settings → App Store.
      </p>
    </div>
  `;
}

function renderLogPanel(state) {
  const lines = state.logs || [];
  if (lines.length === 0) {
    return state.lastStatus === 'installing'
      ? `<p>Running install — no output yet.</p>`
      : '';
  }
  const totalLines = lines.length;
  const visibleStart = Math.max(0, totalLines - LOG_LINES_RENDERED_MAX);
  const visible = lines.slice(visibleStart);
  const truncationNotice = visibleStart > 0
    ? `<div class="install-plan-modal__log-truncation">… ${visibleStart} earlier line${visibleStart === 1 ? '' : 's'} hidden (Download Logs to see full output)</div>`
    : '';
  const showDownload = totalLines > 0;
  return `
    ${truncationNotice}
    <div class="install-plan-modal__logs"
         data-auto-scroll="${state.logsAutoScroll === false ? 'false' : 'true'}">
      ${visible.map(l => `
        <div class="install-plan-modal__log-line install-plan-modal__log-line--${escapeAttr(l.stream || 'info')}">
          <span class="install-plan-modal__log-ts">${escapeHtml(formatLogTs(l.ts))}</span>
          <span class="install-plan-modal__log-text">${escapeHtml(l.line || '')}</span>
        </div>
      `).join('')}
    </div>
    ${showDownload ? `
      <div class="install-plan-modal__log-actions">
        <button type="button" data-action="download-logs">Download logs</button>
        <span class="install-plan-modal__log-count">${totalLines} line${totalLines === 1 ? '' : 's'}</span>
      </div>
    ` : ''}
  `;
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

/**
 * Phase 5 PR 5.5 — "Previous data found" section. Renders only when
 * the renderPlan IPC found a matching uninstalled-but-preserved row
 * for this slug+channel. Default-on checkbox; on uncheck the install
 * proceeds fresh and the orphan row is archived. Hides when the
 * orphan was deleted (deleteData uninstall) — orphan is null in that
 * case from the IPC.
 */
function renderOrphanSection(state) {
  const o = state.orphan;
  if (!o) return '';
  const fmtBytes = (n) => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  };
  const fmtDate = (iso) => {
    if (!iso) return 'an unknown time ago';
    try {
      const d = new Date(iso);
      const days = Math.max(0, Math.round((Date.now() - d.getTime()) / 86_400_000));
      if (days === 0) return 'earlier today';
      if (days === 1) return 'yesterday';
      if (days < 30) return `${days} days ago`;
      return d.toLocaleDateString();
    } catch (_) { return 'an unknown time ago'; }
  };
  const totalBytes = (o.blobSize || 0) + (o.dbSize || 0);
  return `
    <div class="install-plan-modal__section install-plan-modal__orphan">
      <h3>Previous data found</h3>
      <p>
        You previously installed <strong>${escapeHtml(state.entry.name)}</strong> and uninstalled it ${escapeHtml(fmtDate(o.uninstalledAt))}.
        OS8 preserved your data on disk.
      </p>
      <ul class="install-plan-modal__orphan-list">
        <li><strong>${escapeHtml(fmtBytes(o.blobSize || 0))}</strong> in blob storage</li>
        <li><strong>${escapeHtml(fmtBytes(o.dbSize || 0))}</strong> in the per-app database</li>
        <li><strong>${o.secretCount || 0}</strong> saved secret${o.secretCount === 1 ? '' : 's'}${o.secretCount > 0 ? ' — values preserved; will not re-prompt' : ''}</li>
      </ul>
      <label class="install-plan-modal__orphan-toggle" style="display:flex; align-items:center; gap:8px; cursor:pointer; margin-top:12px;">
        <input type="checkbox" data-action="restore-orphan-toggle" ${state.restoreOrphan ? 'checked' : ''} />
        <span>Restore my previous data</span>
      </label>
      <p class="install-plan-modal__hint" style="font-size:12px; margin-top:8px; color: var(--color-text-secondary, #94a3b8);">
        ${state.restoreOrphan
          ? `OS8 will reuse your previous app slot (<code>${escapeHtml(o.appId)}</code>) and keep ${escapeHtml(fmtBytes(totalBytes))} of preserved data.`
          : `OS8 will install fresh. Your previous data stays on disk under <code>${escapeHtml(o.blobDir)}</code> until you manually delete it.`}
      </p>
    </div>
  `;
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

  // PR 5.5 — surface "Previous data found" up top so the user sees the
  // restore prompt before they scroll through the install plan. No-op
  // when the renderPlan IPC didn't find an orphan.
  const orphanHtml = renderOrphanSection(state);
  if (orphanHtml) sections.push(orphanHtml);

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
    // Tier 2A: opt-in setup scripts detected in the upstream repo. Render
    // only when the drafter found candidates — quiet otherwise.
    {
      const ss = state.devImportMeta?.setupScripts || [];
      if (ss.length > 0) {
        sections.push(`
          <div class="install-plan-modal__section">
            <h3>Setup scripts (optional)</h3>
            <p class="install-plan-modal__hint">
              This repo has scripts that aren't in the install commands above. Some apps
              need them to download models, weights, or fixtures before first launch.
              Checked items will run after install completes.
            </p>
            ${renderSetupScripts(ss, state.setupScriptsChecked, state.setupScriptArgChoices)}
          </div>
        `);
      }
    }
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

      ${renderFirstInstallConsent(state)}

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

    // PR 4.4 — write the first-install consent decision before kicking
    // the install (or approving an existing job). Only flips on the
    // very first install ever; subsequent clicks no-op since
    // consent_shown is true.
    if (state.firstInstallConsent && window.os8?.settings?.set) {
      try {
        await window.os8.settings.set(
          'app_store.telemetry.opt_in',
          state.firstInstallConsentAccepted ? 'true' : 'false',
        );
        await window.os8.settings.set('app_store.telemetry.consent_shown', 'true');
      } catch (_) { /* never block install on consent persistence */ }
      state.firstInstallConsent = false; // hide block on patchModal
    }

    if (state.lastStatus === 'awaiting_approval') {
      // Phase 5 PR 5.5 — pass restoreOrphan choice through to the installer
      // so it can revive the orphan apps row (preserving blob/db/secrets)
      // instead of creating a fresh row.
      const r = await window.os8.appStore.approve(
        state.jobId,
        state.secrets || {},
        { restoreOrphan: !!state.restoreOrphan }
      );
      if (!r?.ok) {
        state.error = r?.error || 'approve failed';
        patchModal(state);
      }
    } else if (!state.jobId) {
      // No job yet — this happens when the modal was opened by-slug and no
      // prior `appStore.install(...)` was issued. Kick the install now.
      // Tier 2A: assemble the manifest with any opt-in setup-script entries
      // prepended to postInstall. We mutate state.entry.manifest so the
      // displayed "Install commands" panel keeps showing the live state if
      // the modal is patched after this click. Verified/community paths
      // skip this — setup scripts only apply to dev-import.
      let manifestToInstall = state.entry.manifest;
      if (state.devImportMode) {
        const ss = state.devImportMeta?.setupScripts || [];
        const additions = ss
          .filter(s => state.setupScriptsChecked.has(s.path))
          .map(s => ({
            argv: assembleSetupArgv(s, state.setupScriptArgChoices?.[s.path] || {}),
          }));
        if (additions.length > 0) {
          manifestToInstall = {
            ...state.entry.manifest,
            postInstall: [
              ...additions,
              ...(state.entry.manifest.postInstall || []),
            ],
          };
          state.entry.manifest = manifestToInstall;
        }
      }
      const r = state.devImportMode
        ? await window.os8.appStore.installFromManifest(
            manifestToInstall,
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

  // Tier 2A — setup-script opt-in checkboxes. Track in state; the actual
  // injection into manifest.postInstall happens at Install click time.
  for (const cb of root.querySelectorAll('[data-setup-script]')) {
    cb.addEventListener('change', () => {
      const path = cb.dataset.setupScript;
      if (cb.checked) state.setupScriptsChecked.add(path);
      else state.setupScriptsChecked.delete(path);
    });
  }

  // Tier 2A follow-up — argparse choices dropdowns. Update state, then
  // patch the modal so the row's "Will run:" line + the checkbox enabled
  // state both reflect the new selection. Clearing a value force-unticks
  // the row (assembleSetupArgv would emit a partial argv otherwise).
  for (const sel of root.querySelectorAll('[data-setup-script-choice]')) {
    sel.addEventListener('change', () => {
      const path = sel.dataset.setupScriptChoice;
      const flag = sel.dataset.flag;
      const value = sel.value;
      state.setupScriptArgChoices = state.setupScriptArgChoices || {};
      state.setupScriptArgChoices[path] = state.setupScriptArgChoices[path] || {};
      if (value) {
        state.setupScriptArgChoices[path][flag] = value;
      } else {
        delete state.setupScriptArgChoices[path][flag];
        // Clearing a required-arg flag must also untick the row — the
        // checkbox is about to be re-disabled by patchModal anyway, but
        // this prevents the brief frame where the box is checked + the
        // dropdown is empty from leaking into setupScriptsChecked.
        state.setupScriptsChecked.delete(path);
      }
      patchModal(state);
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

  // PR 4.4 — telemetry consent checkbox (first install only).
  const consentCb = root.querySelector('[data-action="consent-toggle"]');
  if (consentCb) {
    consentCb.addEventListener('change', () => {
      state.firstInstallConsentAccepted = consentCb.checked;
    });
  }

  // PR 5.5 — restore-orphan checkbox. patchModal re-renders the hint
  // text below the checkbox to reflect the new choice (preserved data
  // path vs fresh install path).
  const restoreOrphanCb = root.querySelector('[data-action="restore-orphan-toggle"]');
  if (restoreOrphanCb) {
    restoreOrphanCb.addEventListener('change', () => {
      state.restoreOrphan = restoreOrphanCb.checked;
      patchModal(state);
    });
  }

  // PR 4.1 — auto-scroll the log panel only while the user is at-or-near
  // the bottom. Scrolling up pauses auto-scroll; scrolling back to bottom
  // resumes it. State persists across renders via state.logsAutoScroll.
  const logsEl = root.querySelector('.install-plan-modal__logs');
  if (logsEl) {
    if (state.logsAutoScroll !== false) {
      logsEl.scrollTop = logsEl.scrollHeight;
    }
    logsEl.addEventListener('scroll', () => {
      const distanceFromBottom = logsEl.scrollHeight - logsEl.scrollTop - logsEl.clientHeight;
      state.logsAutoScroll = distanceFromBottom < 16;
    });
  }

  // PR 4.1 — Download Logs button.
  const dlBtn = root.querySelector('[data-action="download-logs"]');
  if (dlBtn) {
    dlBtn.addEventListener('click', async () => {
      const slug = state.entry?.slug || state.entry?.manifest?.slug || 'install';
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `os8-install-${slug}-${ts}.log`;
      const lines = (state.logs || []).map(l => {
        const stamp = l.ts ? new Date(l.ts).toISOString() : '';
        const stream = l.stream ? `[${l.stream}]` : '';
        return `${stamp} ${stream} ${l.line || ''}`.trim();
      });
      const content = lines.join('\n') + '\n';
      try {
        await window.os8.appStore.saveInstallLog?.(filename, content);
      } catch (e) {
        console.warn('[install-plan] saveInstallLog failed:', e);
      }
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
    // PR 4.1 — single-message announcements (e.g. "running install in /tmp/...")
    // are kept as 'info' stream rows so they render alongside adapter output.
    state.logs = state.logs || [];
    const line = String(payload.message ?? payload.chunk ?? '').replace(/\r?\n+$/, '');
    if (line) {
      state.logs.push({ stream: payload.stream || 'info', line, ts: Date.now() });
    }
  } else if (payload.kind === 'log-batch') {
    // PR 4.1 — buffered relay from app-installer.js makeLogBuffer.
    state.logs = state.logs || [];
    if (Array.isArray(payload.logs)) {
      for (const l of payload.logs) {
        if (l && (l.line || l.line === '')) {
          state.logs.push({
            stream: l.stream || 'stdout',
            line: l.line,
            ts: l.ts || Date.now(),
          });
        }
      }
    }
  } else if (payload.kind === 'failed') {
    state.error = payload.message || 'install failed';
  }

  patchModal(state);
}

function startState(entry, validation, opts = {}) {
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
    // PR 5.5 — orphan = { appId, blobDir, blobSize, dbPath, dbSize,
    // secretCount, uninstalledAt } when the renderPlan IPC found a
    // matching uninstalled-but-preserved row, else null. restoreOrphan
    // tracks the user's checkbox state — defaults true when the orphan
    // section renders (matches the column default in user_account).
    orphan: opts.orphan || null,
    restoreOrphan: opts.orphan ? true : false,
    // PR 3.1: dev-import mode toggles strict modal styling + per-capability
    // opt-in toggles (PR 3.2). Off for verified/community installs.
    devImportMode: false,
    devImportRisksAcknowledged: false,
    devImportMeta: null,
    // Tier 2A: paths of detected setup scripts the user has opted into.
    // Default-checked at openInstallPlanModalFromManifest() if devImportMeta
    // includes setupScripts. Mutated via [data-setup-script] checkboxes;
    // injected into manifest.postInstall on Install.
    setupScriptsChecked: new Set(),
    // Tier 2A follow-up: chosen value per (script path, --flag) pair when
    // the drafter detected `argChoices` on a candidate. Shape:
    //   { 'scripts/download_model.py': { '--models': 'hivision_modnet' } }
    // The checkbox for a candidate stays disabled until every flag in
    // its argChoices map has a non-empty value here. assembleSetupArgv
    // merges these into the candidate's argv at Install-click time.
    setupScriptArgChoices: {},
    // PR 4.4 — first-install consent moment. Both null until
    // initialised by openInstallPlanModal*; consent_shown setting
    // controls whether the block renders.
    firstInstallConsent: false,
    firstInstallConsentAccepted: true,
  };
}

// PR 4.4 — read app_store.telemetry.consent_shown once per modal open.
// Returns true on first ever install (never seen before); state is
// flipped to 'true' when the user clicks Install.
async function maybeShowFirstInstallConsent(state) {
  try {
    if (!window.os8?.settings?.get) return;
    const seen = await window.os8.settings.get('app_store.telemetry.consent_shown');
    if (seen === 'true' || seen === true) return;
    state.firstInstallConsent = true;
    state.firstInstallConsentAccepted = true;
  } catch (_) { /* settings unavailable — skip prompt */ }
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
  const state = startState(result.entry, result.validation, { orphan: result.orphan });
  if (opts.jobId) state.jobId = opts.jobId;
  await maybeShowFirstInstallConsent(state);
  showModal(state);

  if (state.jobId) {
    // Caller already kicked an install job (e.g. catalog browse → install →
    // user cancelled mid-review → reopened). Pull current state so the
    // review report + status render immediately.
    fetchInitialReviewIfNeeded(state);
    return;
  }

  // Verified-deeplink path: kick the install pipeline now so the review
  // job runs and the gate transitions through pending → cloning →
  // reviewing → awaiting_approval. Without this the Install button stays
  // disabled forever (gate waits on a job that nothing started).
  try {
    const r = await window.os8.appStore.install(
      state.entry.slug,
      state.entry.upstreamResolvedCommit,
      state.entry.channel,
      opts.source || 'os8.ai'
    );
    if (r?.ok) {
      state.jobId = r.jobId;
      state.lastStatus = state.lastStatus || 'pending';
    } else {
      state.error = r?.error || 'Failed to start install';
    }
  } catch (e) {
    state.error = e?.message || String(e);
  }
  patchModal(state);
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
  await maybeShowFirstInstallConsent(state);
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
  // Tier 2A: pre-check the top setup-script candidate so the common case
  // (one well-named download_*.py) just works on Install. The user can
  // uncheck if they want to skip it; everything below the top is left
  // unchecked because false-positive risk is non-trivial for less obvious
  // candidates.
  //
  // Skip pre-check when the candidate's own argparse declares required
  // args without defaults — the drafter can't infer what values to pass,
  // so running with no args would fail (e.g. HivisionIDPhotos's
  // download_model.py needs `--models all`). The candidate still renders
  // with a warning; the user reads the source preview, edits the argv if
  // they want, and ticks the box explicitly.
  const ss = opts.importMeta?.setupScripts || [];
  if (ss.length > 0 && !ss[0].requiresArgs) state.setupScriptsChecked.add(ss[0].path);
  await maybeShowFirstInstallConsent(state);
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
