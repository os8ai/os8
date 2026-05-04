// Phase 5 PR 5.4 — merge-conflict banner.
//
// Surfaces at the top of an external app's source view (and, optionally,
// as a top-of-modal banner when the app is opened from the home screen)
// when AppCatalogService.update produced { kind: 'conflict' } during an
// auto-update tick. Reads live state from /api/apps/:id/merge-state and
// drives the user through resolution: open files in the editor, "Mark
// resolved" once everything's clean, "Abort the update" to revert.
//
// "Resolve with Claude" copies a structured prompt to the clipboard the
// user can paste into Claude Code (or any AI agent) — sidesteps the
// "freeze on `<<<<<<<` markers" failure mode for non-git-fluent users
// without invoking an LLM from the renderer.

const SHORT_SHA = sha => (sha ? String(sha).slice(0, 7) : '(unknown)');

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function escapeAttr(s) {
  return escapeHtml(s);
}

function conflictStatusLabel(code) {
  switch (code) {
    case 'UU': return 'both modified';
    case 'AA': return 'both added';
    case 'DD': return 'both deleted';
    case 'AU': return 'added by us';
    case 'UA': return 'added by them';
    case 'DU': return 'deleted by us';
    case 'UD': return 'deleted by them';
    default:   return code || 'conflict';
  }
}

async function fetchPort() {
  try {
    return await window.os8?.server?.getPort?.() || 8888;
  } catch (_) { return 8888; }
}

async function fetchState(app) {
  const port = await fetchPort();
  const r = await fetch(`http://localhost:${port}/api/apps/${encodeURIComponent(app.id)}/merge-state`, {
    method: 'GET',
    headers: { 'X-OS8-App-Id': 'native-shell' },
  });
  return r.json();
}

/**
 * Render the banner HTML for an app. Returns '' when there's no
 * conflict — caller can append the result unconditionally.
 *
 * Usage:
 *   const html = await renderMergeConflictBanner(app);
 *   container.insertAdjacentHTML('afterbegin', html);
 *   wireMergeConflictBanner(container, app, { onChanged });
 */
export async function renderMergeConflictBanner(app) {
  if (!app || app.app_type !== 'external') return '';
  // Cheap pre-check from the apps row: skip the API call if the row
  // doesn't even claim a conflict. The route still re-verifies via git.
  if (app.update_status !== 'conflict') return '';

  let state;
  try {
    state = await fetchState(app);
  } catch (e) {
    // Network glitch — render a minimal banner so the user knows
    // something's up; they can refresh to retry.
    return `
      <div class="merge-conflict-banner merge-conflict-banner--error">
        <strong>Merge conflict</strong>
        <span> — couldn't load conflict state: ${escapeHtml(e.message)}</span>
      </div>
    `;
  }
  if (!state?.ok || state.status !== 'conflict') return '';

  const files = Array.isArray(state.files) ? state.files : [];
  const targetSha = SHORT_SHA(state.targetCommit);
  const fileItems = files.length === 0
    ? '<li><em>No files reported by git status — try refreshing.</em></li>'
    : files.map(f => `
        <li>
          <code class="merge-conflict-banner__path">${escapeHtml(f.path)}</code>
          <span class="merge-conflict-banner__status">${escapeHtml(conflictStatusLabel(f.status))}</span>
          <button class="action-button action-button--small"
                  data-action="open-file"
                  data-path="${escapeAttr(f.path)}">Open</button>
        </li>
      `).join('');

  return `
    <div class="merge-conflict-banner" data-app-id="${escapeAttr(app.id)}">
      <div class="merge-conflict-banner__header">
        <strong>Update conflict</strong>
        <span class="merge-conflict-banner__sub">
          OS8 tried to update this app to <code>${escapeHtml(targetSha)}</code>;
          ${files.length} file${files.length === 1 ? '' : 's'} need your attention.
        </span>
      </div>
      <ul class="merge-conflict-banner__files">${fileItems}</ul>
      <div class="merge-conflict-banner__actions">
        <button class="action-button action-button--primary" data-action="mark-resolved">
          I've resolved all conflicts — commit
        </button>
        <button class="action-button" data-action="resolve-with-claude">
          Resolve with Claude
        </button>
        <button class="action-button" data-action="abort-merge">
          Abort the update
        </button>
      </div>
      <p class="merge-conflict-banner__hint">
        Open each conflicted file (or click <strong>Resolve with Claude</strong> to
        copy a ready-to-paste prompt for your AI agent). Look for
        <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code> markers; remove them, keep the
        version you want, and save. Then click "I've resolved all conflicts."
      </p>
    </div>
  `;
}

/**
 * Wire the banner's three buttons + per-file Open links. Re-render on
 * action via `opts.onChanged` so the banner updates state without a
 * full refresh.
 */
export function wireMergeConflictBanner(root, app, opts = {}) {
  const banner = root.querySelector?.('.merge-conflict-banner');
  if (!banner) return;
  const { onChanged, openFile } = opts;

  banner.querySelectorAll('[data-action="open-file"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const filePath = btn.getAttribute('data-path');
      if (typeof openFile === 'function') {
        try { openFile(filePath); } catch (_) { /* best-effort */ }
      } else {
        // Fallback: ask the user where the file lives.
        try {
          if (window.prompt) {
            window.alert(`Open this file in your editor:\n\n${app.id}/${filePath}`);
          }
        } catch (_) { /* noop */ }
      }
    });
  });

  banner.querySelector('[data-action="mark-resolved"]')?.addEventListener('click', async () => {
    const btn = banner.querySelector('[data-action="mark-resolved"]');
    btn.disabled = true;
    btn.textContent = 'Committing…';
    try {
      const port = await fetchPort();
      const r = await fetch(
        `http://localhost:${port}/api/apps/${encodeURIComponent(app.id)}/merge-state/mark-resolved`,
        { method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-OS8-App-Id': 'native-shell',
          },
          body: JSON.stringify({ resolvedBy: 'user' }),
        }
      );
      const body = await r.json().catch(() => ({}));
      if (!r.ok || !body?.ok) {
        if (body?.code === 'STILL_CONFLICTED') {
          window.alert(
            'Some files still have conflict markers. Save your changes ' +
            'and try again.\n\nFiles still conflicted:\n' +
            (body.files || []).map(f => `  - ${f.path}`).join('\n')
          );
        } else {
          window.alert(`Couldn't mark resolved: ${body?.error || r.status}`);
        }
        return;
      }
      try { onChanged?.(); } catch (_) { /* noop */ }
    } finally {
      btn.disabled = false;
      btn.textContent = "I've resolved all conflicts — commit";
    }
  });

  banner.querySelector('[data-action="abort-merge"]')?.addEventListener('click', async () => {
    if (!window.confirm('Abort the update? Your edits stay; the merge in progress reverts.')) return;
    const btn = banner.querySelector('[data-action="abort-merge"]');
    btn.disabled = true;
    btn.textContent = 'Aborting…';
    try {
      const port = await fetchPort();
      const r = await fetch(
        `http://localhost:${port}/api/apps/${encodeURIComponent(app.id)}/merge-state/abort`,
        { method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-OS8-App-Id': 'native-shell',
          },
        }
      );
      const body = await r.json().catch(() => ({}));
      if (!r.ok || !body?.ok) {
        window.alert(`Couldn't abort: ${body?.error || r.status}`);
        return;
      }
      try { onChanged?.(); } catch (_) { /* noop */ }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Abort the update';
    }
  });

  banner.querySelector('[data-action="resolve-with-claude"]')?.addEventListener('click', async () => {
    let state;
    try { state = await fetchState(app); }
    catch (_) { state = { files: [], targetCommit: null }; }
    const files = Array.isArray(state.files) ? state.files : [];
    const targetSha = SHORT_SHA(state.targetCommit);
    const lines = [
      `I'm hitting a git merge conflict in this OS8 app. The auto-updater tried to merge upstream commit \`${targetSha}\` onto my edits, but ${files.length} file${files.length === 1 ? '' : 's'} need resolution:`,
      '',
      ...files.map(f => `- \`${f.path}\` (${conflictStatusLabel(f.status)})`),
      '',
      'For each file, please:',
      '1. Read the file and find the `<<<<<<<` / `=======` / `>>>>>>>` conflict markers.',
      '2. Decide which side to keep (or merge both intents).',
      '3. Remove all conflict markers.',
      '4. Save.',
      '',
      'When you\'re done, return to the OS8 app banner and click "I\'ve resolved all conflicts."',
    ];
    const text = lines.join('\n');
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch (_) { /* clipboard may be blocked in some contexts */ }
    if (copied) {
      try {
        const { showToast } = await import('./toast.js');
        showToast({
          kind: 'info',
          title: 'Resolution prompt copied',
          message: 'Paste into Claude Code (or your AI agent) to drive the resolution.',
          durationMs: 5000,
        });
      } catch (_) {
        window.alert('Resolution prompt copied to clipboard. Paste into Claude Code (or your AI agent).');
      }
    } else {
      // Fallback: render the prompt in an alert so the user can manually copy.
      window.alert(`Couldn't access the clipboard. Copy this prompt manually:\n\n${text}`);
    }
  });
}
