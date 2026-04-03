/**
 * Data Storage view for OS8
 * Auto-discovers and displays all agent-scoped database tables
 */

import { elements } from './elements.js';
import { getCurrentApp, getEffectiveAgentId } from './state.js';
import { hideAllPreviews } from './preview.js';

// Track expanded sources
const expandedSources = new Set();

/**
 * Humanize a snake_case table name → "Agent Life Items"
 */
function humanizeName(name) {
  // Strip memory/ prefix for memory sources
  if (name.startsWith('memory/')) return name.replace(/^memory\//, '');
  return name
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Load and render the data storage view
 */
export async function loadDataStorage() {
  const app = getCurrentApp();
  if (!app) return;

  const tree = elements.dataStorageTree;
  if (!tree) return;

  // Show loading state
  tree.innerHTML = '<div class="data-storage-loading">Loading...</div>';

  const agentId = getEffectiveAgentId();
  const scopeId = agentId || app.id;
  const sources = await window.os8.data.getSources(scopeId);

  if (!sources || sources.length === 0) {
    tree.innerHTML = `
      <div class="data-storage-empty">
        <div class="storage-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <ellipse cx="12" cy="5" rx="9" ry="3"/>
            <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
            <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
          </svg>
        </div>
        <p>No data</p>
        <span class="data-storage-hint">Agent data will appear here as it is generated</span>
      </div>
    `;
    return;
  }

  // Render sources
  tree.innerHTML = sources.map(source => renderSourceItem(source)).join('');

  // Attach click handlers for source folders
  tree.querySelectorAll('.data-source-item').forEach(item => {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const folder = item.closest('.data-source-folder');
      const sourceName = folder.dataset.source;
      const sourceType = folder.dataset.sourceType;

      if (folder.classList.contains('collapsed')) {
        // Expand - load chunks if not already loaded
        folder.classList.remove('collapsed');
        expandedSources.add(sourceName);
        const chunksContainer = folder.querySelector('.data-source-chunks');
        if (chunksContainer.children.length === 0) {
          await loadChunksForSource(sourceName, chunksContainer, sourceType);
        }
      } else {
        // Collapse
        folder.classList.add('collapsed');
        expandedSources.delete(sourceName);
      }
    });
  });
}

/**
 * Render a source folder item
 */
function renderSourceItem(source) {
  const isExpanded = expandedSources.has(source.source);
  const collapsedClass = isExpanded ? '' : 'collapsed';
  const displayName = humanizeName(source.source);

  // Different icon for tables vs memory sources
  const isTable = source.type === 'table' || source.type === 'appdb';
  const icon = isTable
    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="3" width="18" height="18" rx="2"/>
        <line x1="3" y1="9" x2="21" y2="9"/>
        <line x1="3" y1="15" x2="21" y2="15"/>
        <line x1="9" y1="3" x2="9" y2="21"/>
      </svg>`
    : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14,2 14,8 20,8"/>
      </svg>`;

  return `
    <div class="data-source-folder ${collapsedClass}" data-source="${escapeHtml(source.source)}" data-source-type="${escapeHtml(source.type)}">
      <div class="data-source-item">
        <span class="data-source-arrow">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
            <path d="M7 10l5 5 5-5z"/>
          </svg>
        </span>
        <span class="data-source-icon">${icon}</span>
        <span class="data-source-name">${escapeHtml(displayName)}</span>
        <span class="data-source-badge">${source.chunk_count}</span>
      </div>
      <div class="data-source-chunks">
        <!-- Chunks loaded on expand -->
      </div>
    </div>
  `;
}

/**
 * Load chunks for a source
 */
async function loadChunksForSource(sourceName, container, sourceType) {
  const app = getCurrentApp();
  if (!app) return;

  container.innerHTML = '<div class="data-chunks-loading">Loading chunks...</div>';

  const agentId = getEffectiveAgentId();
  const scopeId = agentId || app.id;
  const chunks = await window.os8.data.getChunks(scopeId, sourceName, 100, 0, sourceType);

  if (!chunks || chunks.length === 0) {
    container.innerHTML = '<div class="data-chunks-empty">No rows</div>';
    return;
  }

  // Render chunk table header
  const headerHtml = `
    <div class="data-chunk-header">
      <span class="data-chunk-index">#</span>
      <span class="data-chunk-text">Preview</span>
      <span class="data-chunk-category">Type</span>
    </div>
  `;

  // Render chunk rows
  const rowsHtml = chunks.map(chunk => renderChunkRow(chunk)).join('');

  container.innerHTML = headerHtml + rowsHtml;

  // Attach click handlers for chunk rows
  container.querySelectorAll('.data-chunk-row').forEach(row => {
    row.addEventListener('click', async (e) => {
      e.stopPropagation();
      // Ignore clicks on the delete button
      if (e.target.closest('.data-chunk-delete')) return;
      const chunkId = row.dataset.chunkId;
      const agentId = getEffectiveAgentId();
      const currentApp = getCurrentApp();
      const scopeId = agentId || currentApp.id;
      await viewChunkDetails(chunkId, scopeId);
    });
  });

  // Attach delete handlers
  container.querySelectorAll('.data-chunk-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const row = btn.closest('.data-chunk-row');
      const chunkId = row.dataset.chunkId;
      const agentId = getEffectiveAgentId();
      const app = getCurrentApp();
      const scopeId = agentId || app.id;
      const result = await window.os8.data.deleteChunk(chunkId, scopeId);
      if (result === true || (result && result.deleted)) {
        row.remove();
        // Update the source badge count
        const folder = container.closest('.data-source-folder');
        if (folder) {
          const badge = folder.querySelector('.data-source-badge');
          if (badge) {
            const count = Math.max(0, parseInt(badge.textContent, 10) - 1);
            badge.textContent = count;
          }
        }
      }
    });
  });
}

/**
 * Render a chunk row
 */
function renderChunkRow(chunk) {
  const textPreview = truncateText(chunk.text, 60);
  const category = chunk.category || '-';

  return `
    <div class="data-chunk-row" data-chunk-id="${escapeHtml(String(chunk.id))}">
      <span class="data-chunk-index">${chunk.chunk_index}</span>
      <span class="data-chunk-text">${escapeHtml(textPreview)}</span>
      <span class="data-chunk-category">${escapeHtml(category)}</span>
      <span class="data-chunk-delete" title="Delete">×</span>
    </div>
  `;
}

/**
 * View chunk details in modal
 */
async function viewChunkDetails(chunkId, scopeId) {
  const chunk = await window.os8.data.getChunk(chunkId, scopeId);
  if (!chunk) return;

  // Hide preview (BrowserView sits on top)
  hideAllPreviews();

  let content;
  let title;

  if (chunk._fields) {
    // Generic table row — show all fields
    title = `${humanizeName(chunk._table)} Row`;
    const lines = [];
    for (const [key, val] of Object.entries(chunk._fields)) {
      const displayVal = val === null ? '(null)' : String(val);
      // Truncate very long values for readability
      const truncated = displayVal.length > 2000
        ? displayVal.substring(0, 2000) + '...'
        : displayVal;
      lines.push(`${humanizeName(key)}: ${truncated}`);
    }
    content = lines.join('\n\n');
  } else {
    // Legacy memory chunk
    title = `Chunk #${chunk.id}`;
    content = `Source: ${chunk.source}
Index: ${chunk.chunk_index}
Category: ${chunk.category || '(none)'}
Created: ${chunk.created_at}
Updated: ${chunk.updated_at}

--- Text ---
${chunk.text}`;
  }

  elements.fileViewerName.textContent = title;
  elements.fileViewerModal.classList.add('active');
  elements.downloadFileViewer.style.display = 'none';

  // Reset content area
  elements.fileViewerContent.className = 'file-viewer-content';
  elements.fileViewerContent.innerHTML = '<pre><code></code></pre>';
  elements.fileViewerContent.classList.add('text-view');
  elements.fileViewerContent.querySelector('code').textContent = content;
}

/**
 * Truncate text with ellipsis
 */
function truncateText(text, maxLength) {
  if (!text) return '';
  // Remove newlines for preview
  const singleLine = text.replace(/\n/g, ' ').trim();
  if (singleLine.length <= maxLength) return singleLine;
  return singleLine.substring(0, maxLength) + '...';
}

/**
 * Escape HTML special characters
 */
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
