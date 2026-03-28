/**
 * Capabilities settings panel
 * Fetches from GET /api/skills/registry, renders inventory with type badges and availability
 */

let cachedCapabilities = null;
let currentFilter = 'all';
let filtersInitialized = false;
let serverPort = null;

async function getPort() {
  if (!serverPort) serverPort = await window.os8.server.getPort();
  return serverPort;
}

export async function loadCapabilities() {
  try {
    const port = await getPort();
    const res = await fetch(`http://localhost:${port}/api/skills/registry`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error(data.error || 'Unexpected response');
    cachedCapabilities = data;
    initCapabilityFilters();
    renderCapabilities();
  } catch (err) {
    console.error('Failed to load capabilities:', err);
    const container = document.getElementById('capabilitiesList');
    if (container) container.innerHTML = '<p class="setting-description">Failed to load capabilities.</p>';
  }
}

function renderCapabilities() {
  const container = document.getElementById('capabilitiesList');
  if (!container || !cachedCapabilities) return;

  const caps = cachedCapabilities
    .filter(c => currentFilter === 'all' || c.type === currentFilter)
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  if (caps.length === 0) {
    container.innerHTML = '<p class="setting-description">No capabilities found.</p>';
    return;
  }

  // Count how many need approval
  const needsApproval = caps.filter(c =>
    c.source === 'catalog' && c.quarantine &&
    (c.review_status === 'reviewed' || c.review_status === 'pending')
  );

  let html = '';

  // Info bar when there are skills needing approval
  if (needsApproval.length > 0) {
    const reviewedCount = needsApproval.filter(c => c.review_status === 'reviewed').length;
    const pendingCount = needsApproval.filter(c => c.review_status === 'pending').length;
    html += `<div style="font-size: 11px; color: #94a3b8; margin-bottom: 10px; padding: 6px 10px; background: rgba(234,179,8,0.08); border: 1px solid rgba(234,179,8,0.15); border-radius: 6px;">
      ${needsApproval.length} catalog skill${needsApproval.length !== 1 ? 's' : ''} quarantined
      &middot; ${reviewedCount} reviewed, ${pendingCount} still reviewing
      &middot; Review each skill individually below
    </div>`;
  }

  html += caps.map(cap => {
    const endpoints = cap.endpoints || [];
    const endpointCount = endpoints.length;
    const endpointSummary = endpointCount > 0 ? `${endpointCount} endpoint${endpointCount !== 1 ? 's' : ''}` : '';
    const source = cap.source === 'bundled' ? 'Built-in' : cap.source === 'catalog' ? 'Catalog' : cap.source === 'mcp' ? 'MCP Server' : '';

    // Review status badges
    let reviewBadge = '';
    if (cap.quarantine && cap.review_status === 'pending') {
      reviewBadge = '<span class="capability-badge capability-badge-review-pending" title="Pending Review">REVIEWING...</span>';
    } else if (cap.quarantine && cap.review_status === 'reviewed') {
      const riskColors = { low: 'review-low', medium: 'review-medium', high: 'review-high' };
      const riskClass = riskColors[cap.review_risk_level] || 'review-ready';
      reviewBadge = `<span class="capability-badge capability-badge-${riskClass}" title="Risk: ${cap.review_risk_level || 'unknown'}">${(cap.review_risk_level || 'REVIEWED').toUpperCase()} RISK</span>`;
    } else if (cap.quarantine && cap.review_status === 'rejected') {
      reviewBadge = '<span class="capability-badge capability-badge-review-rejected" title="Rejected">REJECTED</span>';
    } else if (cap.review_status === 'approved' && cap.review_risk_level) {
      const riskColors = { low: 'review-low', medium: 'review-medium', high: 'review-high' };
      const riskClass = riskColors[cap.review_risk_level] || '';
      reviewBadge = `<span class="capability-badge capability-badge-${riskClass}" title="Approved &middot; Risk: ${cap.review_risk_level}">${cap.review_risk_level.toUpperCase()} RISK</span>`;
    }

    // Action buttons for catalog skills with review
    let actions = '';
    if (cap.source === 'catalog' && cap.quarantine && cap.review_status !== 'rejected') {
      actions = `
        <div class="capability-actions">
          ${cap.review_status === 'reviewed' ? `<button class="capability-btn capability-btn-review" data-id="${cap.id}" title="View Review Report">View Report</button>` : ''}
          <button class="capability-btn capability-btn-approve" data-id="${cap.id}" title="Approve &mdash; unquarantine this skill">Approve</button>
          <button class="capability-btn capability-btn-reject" data-id="${cap.id}" title="Reject &mdash; keep quarantined">Reject</button>
        </div>`;
    } else if (cap.review_status === 'approved' && cap.review_risk_level) {
      actions = `
        <div class="capability-actions">
          <button class="capability-btn capability-btn-review" data-id="${cap.id}" title="View Review Report">View Report</button>
        </div>`;
    }

    return `<div class="capability-row">
      <div class="capability-info">
        <div class="capability-header">
          <span class="capability-name">${escapeHtml(cap.name)}</span>
          <span class="capability-badge capability-badge-${cap.type}">${cap.type.toUpperCase()}</span>
          ${cap.available ? '<span class="capability-status available" title="Available">&#9679;</span>' : '<span class="capability-status unavailable" title="Unavailable">&#9675;</span>'}
          ${source ? `<span class="capability-source">${source}</span>` : ''}
          ${reviewBadge}
        </div>
        <div class="capability-description">${escapeHtml(cap.description || '')}</div>
        <div class="capability-meta">
          ${cap.base_path ? `<span class="capability-path">${escapeHtml(cap.base_path)}</span>` : ''}
          ${endpointSummary ? `<span class="capability-endpoints">${endpointSummary}</span>` : ''}
        </div>
        ${actions}
      </div>
    </div>`;
  }).join('');

  container.innerHTML = html;

  // Attach event listeners
  container.querySelectorAll('.capability-btn-approve').forEach(btn => {
    btn.addEventListener('click', () => approveCapability(btn.dataset.id));
  });
  container.querySelectorAll('.capability-btn-reject').forEach(btn => {
    btn.addEventListener('click', () => rejectCapability(btn.dataset.id));
  });
  container.querySelectorAll('.capability-btn-review').forEach(btn => {
    btn.addEventListener('click', () => showReviewReport(btn.dataset.id));
  });

}

async function approveCapability(id) {
  try {
    const port = await getPort();
    const res = await fetch(`http://localhost:${port}/api/skills/${id}/approve`, { method: 'POST' });
    if (res.ok) {
      await loadCapabilities();
    } else {
      const data = await res.json();
      console.error('Approve failed:', data.error);
    }
  } catch (err) {
    console.error('Approve failed:', err);
  }
}

async function rejectCapability(id) {
  try {
    const port = await getPort();
    const res = await fetch(`http://localhost:${port}/api/skills/${id}/reject`, { method: 'POST' });
    if (res.ok) {
      await loadCapabilities();
    } else {
      const data = await res.json();
      console.error('Reject failed:', data.error);
    }
  } catch (err) {
    console.error('Reject failed:', err);
  }
}

async function showReviewReport(id) {
  try {
    const port = await getPort();
    const res = await fetch(`http://localhost:${port}/api/skills/${id}/review`);
    const data = await res.json();

    // Find the skill name
    const cap = cachedCapabilities?.find(c => c.id === id);
    const skillName = cap?.name || id;

    if (!data.report) {
      showReviewModal(skillName, {
        riskLevel: data.riskLevel || 'unknown',
        summary: data.status === 'pending' ? 'Review is still in progress...' : 'No review report available.',
        findings: []
      }, data.reviewedAt);
      return;
    }

    showReviewModal(skillName, data.report, data.reviewedAt);
  } catch (err) {
    console.error('Failed to load review:', err);
  }
}

function showReviewModal(skillName, report, reviewedAt) {
  // Remove existing modal if any
  const existing = document.querySelector('.review-modal-overlay');
  if (existing) existing.remove();

  const riskColors = {
    low: 'background: rgba(34,197,94,0.15); color: #4ade80;',
    medium: 'background: rgba(234,179,8,0.15); color: #facc15;',
    high: 'background: rgba(239,68,68,0.15); color: #f87171;',
    unknown: 'background: rgba(100,116,139,0.15); color: #94a3b8;'
  };

  const findingsHtml = (report.findings || []).map(f => {
    const severityClass = `review-finding-${f.severity || 'info'}`;
    return `<div class="review-finding ${severityClass}">
      <div class="review-finding-category">${escapeHtml(f.category || 'other')} &middot; ${f.severity || 'info'}</div>
      <div class="review-finding-desc">${escapeHtml(f.description || '')}</div>
      ${f.snippet ? `<div class="review-finding-snippet">${escapeHtml(f.snippet)}</div>` : ''}
    </div>`;
  }).join('');

  const overlay = document.createElement('div');
  overlay.className = 'review-modal-overlay';
  overlay.innerHTML = `
    <div class="review-modal">
      <h3>${escapeHtml(skillName)}</h3>
      <span class="review-modal-risk" style="${riskColors[report.riskLevel] || riskColors.unknown}">
        ${(report.riskLevel || 'unknown').toUpperCase()} RISK
      </span>
      ${reviewedAt ? `<span style="font-size: 11px; color: #64748b; margin-left: 8px;">Reviewed ${new Date(reviewedAt).toLocaleDateString()}</span>` : ''}
      <p class="review-modal-summary">${escapeHtml(report.summary || 'No summary available.')}</p>
      ${(report.findings || []).length > 0
        ? `<div style="margin-bottom: 8px; font-size: 12px; font-weight: 500; color: #94a3b8;">Findings (${report.findings.length})</div>${findingsHtml}`
        : '<div style="font-size: 12px; color: #4ade80; margin-bottom: 12px;">No security findings.</div>'}
      <button class="review-modal-close">Close</button>
    </div>
  `;

  // Close on overlay click or button
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.classList.contains('review-modal-close')) {
      overlay.remove();
    }
  });

  document.body.appendChild(overlay);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function initCapabilityFilters() {
  if (filtersInitialized) return;
  const tabs = document.getElementById('capabilityFilterTabs');
  if (!tabs) return;
  filtersInitialized = true;
  tabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.cascade-tab');
    if (!tab) return;
    tabs.querySelectorAll('.cascade-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentFilter = tab.dataset.filter;
    renderCapabilities();
  });
}
