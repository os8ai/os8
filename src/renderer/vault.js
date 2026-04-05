/**
 * Vault Panel — OS8 Knowledge Layer UI
 *
 * Shell-native panel for creating, editing, and browsing notes.
 * Communicates with the backend via fetch to /api/vault/* endpoints.
 *
 * @see vault-editor.js for CodeMirror 6 integration
 */

import { elements } from './elements.js';
import { createVaultTab } from './tabs.js';
import { attachModalBehavior } from './helpers.js';
import { showContextMenu, hideContextMenu } from './tasks.js';
import {
  createEditor, setContent, getContent, focusEditor, destroyEditor,
  refreshKnownTitles, setReadOnly
} from './vault-editor.js';

// ============================================================
// State (module-scoped — vault is self-contained)
// ============================================================

let port = null;
let currentNoteId = null;
let currentNote = null;
let notesList = [];
let folderTree = [];
let tagList = [];
let sidebarSection = 'all'; // 'all' | 'daily' | 'pinned' | 'recent' | 'folders' | 'tags'
let activeFolderId = null;
let activeTagId = null;
let isDirty = false;
let saveTimeout = null;
let searchTimeout = null;
let searchMode = 'hybrid'; // 'keyword' | 'semantic' | 'hybrid'
let searchResults = null;  // null = normal note list, array = search results view
let scopeList = [];
let sourceList = [];
let indexStatus = null;
let activeScopeId = null;
let indexPollInterval = null;
let initialized = false;
let templateList = [];
let viewingVersion = false;
let viewingVersionNoteId = null;
let viewingVersionId = null;
let calendarYear = new Date().getFullYear();
let calendarMonth = new Date().getMonth();
let dailyNoteDates = new Set();
let graphMode = false;
let graphSimulation = null;
let expandedScopeIds = new Set();
let scopeFilesCache = new Map(); // scopeId → array of source items

const AUTO_SAVE_DELAY = 1500; // ms

// ============================================================
// API helpers
// ============================================================

async function getPort() {
  if (!port) port = await window.os8.server.getPort();
  return port;
}

async function vaultFetch(path, options = {}) {
  const p = await getPort();
  const url = `http://localhost:${p}/api/vault${path}`;
  const headers = { ...options.headers };
  if (options.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Vault API error: ${res.status}`);
  }
  return res.json();
}

// ============================================================
// Sidebar rendering
// ============================================================

function renderNav() {
  const nav = elements.vaultNav;
  if (!nav) return;

  const sections = [
    { id: 'all', label: 'All Notes', icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>' },
    { id: 'daily', label: 'Daily', icon: '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>' },
    { id: 'pinned', label: 'Pinned', icon: '<path d="M12 17v5M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.89A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.89A2 2 0 0 0 5 15.24z"/>' },
    { id: 'recent', label: 'Recent', icon: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>' },
    { id: 'folders', label: 'Folders', icon: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v11z"/>' },
    { id: 'tags', label: 'Tags', icon: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>' },
    { id: 'graph', label: 'Graph', icon: '<circle cx="5" cy="6" r="2"/><circle cx="12" cy="4" r="2"/><circle cx="19" cy="7" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="17" cy="17" r="2"/><line x1="7" y1="6" x2="10" y2="5" stroke-width="1"/><line x1="14" y1="5" x2="17" y2="6" stroke-width="1"/><line x1="6" y1="8" x2="6" y2="16" stroke-width="1"/><line x1="8" y1="18" x2="15" y2="17" stroke-width="1"/><line x1="18" y1="9" x2="17" y2="15" stroke-width="1"/>' },
    { id: 'indexed', label: 'Indexed Files', icon: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v11z"/><path d="M12 11v6"/><path d="M9 14l3-3 3 3"/>' },
  ];

  nav.innerHTML = sections.map(s => `
    <button class="vault-nav-item ${sidebarSection === s.id ? 'active' : ''}" data-section="${s.id}">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${s.icon}</svg>
      <span>${s.label}</span>
      ${s.id === 'all' && notesList.length ? `<span class="vault-nav-badge">${notesList.length}</span>` : ''}
    </button>
    ${s.id === 'folders' && sidebarSection === 'folders' ? renderFolderChildren() : ''}
    ${s.id === 'tags' && sidebarSection === 'tags' ? renderTagChildren() : ''}
    ${s.id === 'indexed' && sidebarSection === 'indexed' ? renderIndexedChildren() : ''}
  `).join('');

  // Attach click handlers
  nav.querySelectorAll('.vault-nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const prevSection = sidebarSection;
      const section = item.dataset.section;
      sidebarSection = section;
      activeFolderId = null;
      activeTagId = null;

      // Handle graph view toggle
      if (prevSection === 'graph' && section !== 'graph') {
        hideGraphView();
      }
      if (section === 'graph') {
        renderNav();
        showGraphView();
        return;
      }

      renderNav();
      loadNotes();
    });
  });

  // Folder sub-item click handlers
  nav.querySelectorAll('.vault-nav-sub-item[data-folder-id]').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      activeFolderId = item.dataset.folderId;
      sidebarSection = 'folders';
      renderNav();
      loadNotes();
    });

    // Context menu on folders
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const folderId = item.dataset.folderId;
      const name = item.querySelector('.vault-folder-name')?.textContent || '';
      showContextMenu(e.clientX, e.clientY, [
        { label: 'New Note Here', icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>', action: () => createNote({ folder_id: folderId }) },
        { label: 'New Subfolder', icon: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v11z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>', action: () => showCreateFolderModal(folderId) },
        { label: 'Export Folder', icon: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>', action: async () => { const p = await getPort(); window.open(`http://localhost:${p}/api/vault/export/${folderId}`, '_blank'); } },
        { divider: true },
        { label: 'Rename', icon: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>', action: () => showRenameFolderModal(folderId, name) },
        { divider: true },
        { label: 'Delete', icon: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14"/>', danger: true, action: () => deleteFolderWithConfirm(folderId) },
      ]);
    });

    // Drag-drop target for notes
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      item.classList.add('vault-drag-over');
    });
    item.addEventListener('dragleave', () => {
      item.classList.remove('vault-drag-over');
    });
    item.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      item.classList.remove('vault-drag-over');
      const noteId = e.dataTransfer.getData('text/plain');
      if (noteId) {
        await moveNoteToFolder(noteId, item.dataset.folderId);
      }
    });
  });

  // Folder expand/collapse arrows
  nav.querySelectorAll('.vault-folder-arrow').forEach(arrow => {
    arrow.addEventListener('click', (e) => {
      e.stopPropagation();
      const node = arrow.closest('.vault-folder-node');
      if (node) node.classList.toggle('collapsed');
    });
  });

  // Create folder button
  nav.querySelector('.vault-folder-create-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    showCreateFolderModal();
  });

  // Tag sub-item handlers
  nav.querySelectorAll('.vault-nav-sub-item[data-tag-id]').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      activeTagId = item.dataset.tagId;
      sidebarSection = 'tags';
      renderNav();
      loadNotes();
    });

    // Context menu on tags
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const tagId = item.dataset.tagId;
      const tag = tagList.find(t => t.id === tagId);
      if (!tag) return;
      showContextMenu(e.clientX, e.clientY, [
        { label: 'Rename', icon: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>', action: () => showRenameTagModal(tagId, tag.name) },
        { divider: true },
        { label: 'Delete', icon: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14"/>', danger: true, action: () => deleteTagWithConfirm(tagId) },
      ]);
    });
  });

  // Create tag button
  nav.querySelector('.vault-tag-create-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    showCreateTagModal();
  });

  // Scope node handlers — arrow toggles expand/collapse, name click selects
  nav.querySelectorAll('.vault-scope-node').forEach(node => {
    const scopeId = node.dataset.scopeId;
    const arrow = node.querySelector('.vault-folder-arrow');
    const nameBtn = node.querySelector('.vault-nav-sub-item[data-scope-id]');

    // Arrow click: toggle expand/collapse + lazy load files
    if (arrow) {
      arrow.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (expandedScopeIds.has(scopeId)) {
          expandedScopeIds.delete(scopeId);
        } else {
          expandedScopeIds.add(scopeId);
          // Lazy-load files if not cached
          if (!scopeFilesCache.has(scopeId)) {
            try {
              const data = await vaultFetch(`/sources?scope_id=${scopeId}&limit=200`);
              scopeFilesCache.set(scopeId, data.sources || []);
            } catch (err) {
              scopeFilesCache.set(scopeId, []);
            }
          }
        }
        renderNav();
      });
    }

    // Name click: select scope (loads files in note list area)
    if (nameBtn) {
      nameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        // Ignore clicks on the expand/collapse arrow
        if (e.target.closest('.vault-folder-arrow')) return;
        activeScopeId = scopeId;
        sidebarSection = 'indexed';
        renderNav();
        loadSources();
      });

      nameBtn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showContextMenu(e.clientX, e.clientY, [
          { label: 'Rescan', icon: '<path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>', action: () => rescanScope(scopeId) },
          { divider: true },
          { label: 'Remove', icon: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14"/>', danger: true, action: () => removeScopeWithConfirm(scopeId) },
        ]);
      });
    }
  });

  // Scope refresh button clicks
  nav.querySelectorAll('.vault-scope-refresh-btn[data-scope-id]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const scopeId = btn.dataset.scopeId;
      scopeFilesCache.delete(scopeId);
      rescanScope(scopeId);
    });
  });

  // Scope file item clicks
  nav.querySelectorAll('.vault-scope-file-item[data-source-id]').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      loadSourceDetail(item.dataset.sourceId);
    });
  });

  // Add directory button
  nav.querySelector('.vault-scope-add-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    showAddScopeModal();
  });
}

function renderFolderTree(folders, depth = 0) {
  return folders.map(f => {
    const hasChildren = f.children && f.children.length > 0;
    const isActive = activeFolderId === f.id;
    const indent = 12 + depth * 16;
    const arrow = hasChildren
      ? '<svg class="vault-folder-arrow" width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>'
      : '<span style="width:10px;display:inline-block;"></span>';
    return `
      <div class="vault-folder-node ${isActive ? 'active' : ''}" data-folder-id="${f.id}">
        <button class="vault-nav-sub-item" style="padding-left:${indent}px;" data-folder-id="${f.id}">
          ${arrow}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" opacity="0.5"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
          <span class="vault-folder-name">${escapeHtml(f.name)}</span>
          <span class="vault-nav-badge">${f.note_count || ''}</span>
        </button>
        ${hasChildren ? `<div class="vault-folder-children">${renderFolderTree(f.children, depth + 1)}</div>` : ''}
      </div>
    `;
  }).join('');
}

function renderFolderChildren() {
  return `<div class="vault-nav-children" style="display:block;">
    <button class="vault-folder-create-btn vault-nav-sub-item">+ New Folder</button>
    ${folderTree.length ? renderFolderTree(folderTree) : '<div class="vault-list-empty">No folders</div>'}
  </div>`;
}

function renderTagChildren() {
  return `<div class="vault-nav-children" style="display:block;">
    <button class="vault-tag-create-btn vault-nav-sub-item">+ New Tag</button>
    ${tagList.length ? tagList.map(t => `
      <button class="vault-nav-sub-item ${activeTagId === t.id ? 'active' : ''}" data-tag-id="${t.id}">
        #${escapeHtml(t.name)}
        <span class="vault-nav-badge">${t.note_count || ''}</span>
      </button>
    `).join('') : '<div class="vault-list-empty">No tags</div>'}
  </div>`;
}

function renderIndexedChildren() {
  const scopeItems = scopeList.map(s => {
    const isExpanded = expandedScopeIds.has(s.id);
    const isActive = activeScopeId === s.id;
    const statusBadge = s.pending_count > 0
      ? `<span class="vault-nav-badge vault-index-pending">${s.pending_count}</span>`
      : `<span class="vault-nav-badge">${s.file_count || 0}</span>`;
    const cachedFiles = scopeFilesCache.get(s.id);
    const filesHtml = isExpanded && cachedFiles
      ? cachedFiles.slice(0, 50).map(f => `
          <button class="vault-nav-sub-item vault-scope-file-item" data-source-id="${f.id}" style="padding-left:36px;">
            <span class="vault-folder-name">${escapeHtml(f.filename)}</span>
            <span class="vault-source-ext">${f.file_extension}</span>
          </button>
        `).join('') + (cachedFiles.length > 50 ? `<span class="vault-nav-sub-item" style="padding-left:36px;color:var(--color-text-muted);font-size:var(--text-xs);">+${cachedFiles.length - 50} more...</span>` : '')
      : isExpanded ? '<span class="vault-nav-sub-item" style="padding-left:36px;color:var(--color-text-muted);font-size:var(--text-xs);">Loading...</span>' : '';

    return `
      <div class="vault-scope-node ${isExpanded ? '' : 'collapsed'}" data-scope-id="${s.id}">
        <button class="vault-nav-sub-item ${isActive ? 'active' : ''}" data-scope-id="${s.id}">
          <svg class="vault-folder-arrow" width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" opacity="0.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v11z"/><path d="M12 11v6" stroke="currentColor" stroke-width="2" fill="none"/><path d="M9 14l3-3 3 3" stroke="currentColor" stroke-width="2" fill="none"/></svg>
          <span class="vault-folder-name">${escapeHtml(s.label || pathBasename(s.path))}</span>
          ${statusBadge}
          <span class="vault-scope-refresh-btn" data-scope-id="${s.id}" title="Refresh directory">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
          </span>
        </button>
        <div class="vault-scope-children">${filesHtml}</div>
      </div>
    `;
  }).join('');

  return `<div class="vault-nav-children" style="display:block;">
    <button class="vault-scope-add-btn vault-nav-sub-item">+ Add Directory</button>
    ${scopeItems || '<div class="vault-list-empty">No indexed directories</div>'}
    ${renderIndexProgress()}
  </div>`;
}

function pathBasename(p) {
  if (!p) return '';
  const parts = p.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}

function renderIndexProgress() {
  if (!indexStatus || !indexStatus.isIndexing) return '';
  const pct = indexStatus.total > 0 ? Math.round((indexStatus.processed / indexStatus.total) * 100) : 0;
  return `
    <div class="vault-index-progress">
      <div class="vault-index-progress-bar" style="width:${pct}%"></div>
      <span class="vault-index-progress-text">${indexStatus.processed}/${indexStatus.total} files (${pct}%)</span>
    </div>
  `;
}

// ============================================================
// Note list rendering
// ============================================================

function renderNoteList() {
  const list = elements.vaultNoteList;
  if (!list) return;

  if (!notesList.length) {
    list.innerHTML = '<div class="vault-list-empty">No notes</div>';
    return;
  }

  list.innerHTML = notesList.map(note => {
    const isActive = note.id === currentNoteId;
    const excerpt = (note.content_plain || '').slice(0, 80);
    const date = formatDate(note.updated_at || note.created_at);
    return `
      <div class="vault-note-item ${isActive ? 'active' : ''}" data-note-id="${note.id}" draggable="true">
        <div class="vault-note-meta">
          <span class="vault-note-title">${escapeHtml(note.title || 'Untitled')}</span>
          ${note.is_pinned ? '<span class="vault-note-pin">&#128204;</span>' : ''}
        </div>
        <span class="vault-note-excerpt">${escapeHtml(excerpt)}</span>
        <span class="vault-note-date">${date}</span>
      </div>
    `;
  }).join('');

  // Attach click handlers
  list.querySelectorAll('.vault-note-item').forEach(item => {
    item.addEventListener('click', () => {
      const noteId = item.dataset.noteId;
      if (noteId !== currentNoteId) {
        loadNote(noteId);
      }
    });

    // Drag handlers for moving notes to folders
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', item.dataset.noteId);
      e.dataTransfer.effectAllowed = 'move';
      item.classList.add('dragging');
      e.stopPropagation();
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      // Clean up any drag-over states
      document.querySelectorAll('.vault-drag-over').forEach(el => el.classList.remove('vault-drag-over'));
    });
  });
}

// ============================================================
// Note loading and CRUD
// ============================================================

async function loadNotes() {
  // If viewing indexed files, load sources instead
  if (sidebarSection === 'indexed') {
    if (activeScopeId) loadSources();
    return;
  }

  // If search results are showing, don't replace them
  if (searchResults !== null && elements.vaultSearchInput?.value?.trim()) {
    return;
  }
  searchResults = null;

  try {
    const params = new URLSearchParams();
    params.set('limit', '200');
    params.set('is_archived', '0');

    if (sidebarSection === 'pinned') {
      params.set('is_pinned', '1');
    } else if (sidebarSection === 'daily') {
      params.set('is_daily', '1');
      params.set('sort', 'created');
      params.set('order', 'desc');
    } else if (sidebarSection === 'recent') {
      params.set('sort', 'updated');
      params.set('order', 'desc');
      params.set('limit', '30');
    } else if (sidebarSection === 'folders' && activeFolderId) {
      params.set('folder_id', activeFolderId);
    } else if (sidebarSection === 'tags' && activeTagId) {
      const tag = tagList.find(t => t.id === activeTagId);
      if (tag) params.set('tag', tag.name);
    }

    // Search
    const query = elements.vaultSearchInput?.value?.trim();
    if (query) {
      params.set('search', query);
    }

    const data = await vaultFetch(`/notes?${params.toString()}`);
    notesList = data.notes || data;

    if (sidebarSection === 'daily') {
      dailyNoteDates = new Set(notesList.filter(n => n.daily_date).map(n => n.daily_date));
      renderDailyView();
    } else {
      renderNoteList();
    }
  } catch (err) {
    console.error('Failed to load vault notes:', err);
  }
}

async function loadFolders() {
  try {
    folderTree = await vaultFetch('/folders');
  } catch (err) {
    console.error('Failed to load vault folders:', err);
    folderTree = [];
  }
}

async function loadTags() {
  try {
    tagList = await vaultFetch('/tags');
  } catch (err) {
    console.error('Failed to load vault tags:', err);
    tagList = [];
  }
}

async function loadNote(noteId) {
  // Exit version view if active
  if (viewingVersion) exitVersionView();

  // Save current note if dirty
  if (isDirty && currentNoteId) {
    await saveCurrentNote();
  }

  try {
    const note = await vaultFetch(`/notes/${noteId}`);
    currentNoteId = noteId;
    currentNote = note;
    isDirty = false;

    // Show editor, hide empty state
    elements.vaultEditorHeader.style.display = '';
    elements.vaultEmptyState.style.display = 'none';
    elements.vaultEditorBody.style.display = '';

    // Set title (re-enable in case we were viewing a source)
    elements.vaultTitleInput.value = note.title || '';
    elements.vaultTitleInput.disabled = false;

    // Update pin button
    updatePinButton();

    // Set editor content
    setContent(note.content || '');

    // Update save indicator
    updateSaveIndicator();

    // Update inspector
    renderInspector(note);

    // Update note list highlight
    renderNoteList();
  } catch (err) {
    console.error('Failed to load note:', err);
  }
}

async function saveCurrentNote() {
  if (!currentNoteId) return;
  clearTimeout(saveTimeout);

  const content = getContent();
  const title = elements.vaultTitleInput?.value?.trim() || 'Untitled';

  try {
    const updated = await vaultFetch(`/notes/${currentNoteId}`, {
      method: 'PATCH',
      body: { title, content },
    });
    isDirty = false;
    currentNote = { ...currentNote, ...updated };
    updateSaveIndicator();

    // Refresh note list to reflect title/excerpt changes
    await loadNotes();
    // Refresh editor's known titles cache for wikilink decorations
    refreshKnownTitles();
  } catch (err) {
    console.error('Failed to save note:', err);
  }
}

async function createNote(options = {}) {
  try {
    const note = await vaultFetch('/notes', {
      method: 'POST',
      body: {
        title: options.title || 'Untitled',
        content: options.content || '',
        folder_id: options.folder_id || activeFolderId || undefined,
      },
    });

    ensureEditor();

    // Reload list and open the new note
    await loadNotes();
    await loadNote(note.id);

    // Focus title for renaming
    elements.vaultTitleInput?.focus();
    elements.vaultTitleInput?.select();
  } catch (err) {
    console.error('Failed to create note:', err);
  }
}

async function deleteCurrentNote() {
  if (!currentNoteId) return;

  try {
    await vaultFetch(`/notes/${currentNoteId}`, { method: 'DELETE' });

    // Clear current note
    currentNoteId = null;
    currentNote = null;
    isDirty = false;
    clearTimeout(saveTimeout);

    // Show empty state
    showEmptyState();

    // Reload list
    await loadNotes();
  } catch (err) {
    console.error('Failed to delete note:', err);
  }
}

async function togglePinNote() {
  if (!currentNoteId || !currentNote) return;

  try {
    const updated = await vaultFetch(`/notes/${currentNoteId}`, {
      method: 'PATCH',
      body: { is_pinned: currentNote.is_pinned ? 0 : 1 },
    });
    currentNote = { ...currentNote, ...updated };
    updatePinButton();
    await loadNotes();
  } catch (err) {
    console.error('Failed to toggle pin:', err);
  }
}

// ============================================================
// Inspector
// ============================================================

function renderInspector(note) {
  const content = elements.vaultInspectorContent;
  if (!content) return;

  const tags = (note.tags || []).map(t =>
    `<span class="vault-tag-badge">
      #${escapeHtml(t.name)}
      <button class="vault-tag-remove" data-tag-id="${t.id}" title="Remove tag">&times;</button>
    </span>`
  ).join('');

  const forwardLinks = (note.links || []).map(l =>
    `<a class="vault-backlink-item" data-note-id="${l.target_note_id}">${escapeHtml(l.target_title || 'Untitled')}</a>`
  ).join('');

  const backlinks = (note.backlinks || []).map(bl =>
    `<a class="vault-backlink-item" data-note-id="${bl.source_note_id}">${escapeHtml(bl.source_title || 'Untitled')}</a>`
  ).join('');

  const folderName = note.folder_id ? getFolderName(note.folder_id) : '';

  content.innerHTML = `
    <div class="vault-inspector-section">
      <div class="vault-inspector-section-title">Tags</div>
      ${tags || '<span style="font-size: var(--text-xs); color: var(--color-text-muted);">No tags</span>'}
      <div class="vault-tag-input-wrapper">
        <input class="vault-tag-input" placeholder="Add tag..." data-note-id="${note.id}">
        <div class="vault-tag-suggestions"></div>
      </div>
    </div>
    <div class="vault-inspector-section">
      <div class="vault-inspector-section-title">Links</div>
      ${forwardLinks || '<span style="font-size: var(--text-xs); color: var(--color-text-muted);">No links</span>'}
    </div>
    <div class="vault-inspector-section">
      <div class="vault-inspector-section-title">Backlinks</div>
      ${backlinks || '<span style="font-size: var(--text-xs); color: var(--color-text-muted);">No backlinks</span>'}
    </div>
    <div class="vault-inspector-section">
      <div class="vault-inspector-section-title">Info</div>
      <dl class="vault-inspector-meta">
        <dt>Words: </dt><dd>${note.word_count || 0}</dd><br>
        <dt>Created: </dt><dd>${formatDate(note.created_at)}</dd><br>
        <dt>Updated: </dt><dd>${formatDate(note.updated_at)}</dd><br>
        <dt>Folder: </dt><dd><button class="vault-folder-move-btn" data-note-id="${note.id}">${escapeHtml(folderName) || 'None'} &#9662;</button></dd><br>
      </dl>
    </div>
    <div class="vault-inspector-section">
      <div class="vault-inspector-section-title">Versions</div>
      <div class="vault-version-list" data-note-id="${note.id}">
        <span style="font-size:var(--text-xs);color:var(--color-text-muted);">Loading...</span>
      </div>
    </div>
  `;

  // Load versions for this note
  loadVersionsForInspector(note.id);

  // Link click handlers (forward + backlinks)
  content.querySelectorAll('.vault-backlink-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const noteId = item.dataset.noteId;
      if (noteId) loadNote(noteId);
    });
  });

  // Tag remove handlers
  content.querySelectorAll('.vault-tag-remove').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const tagId = btn.dataset.tagId;
      try {
        await vaultFetch(`/notes/${note.id}/tags/${tagId}`, { method: 'DELETE' });
        const updated = await vaultFetch(`/notes/${note.id}`);
        currentNote = updated;
        renderInspector(updated);
        await loadTags();
        renderNav();
      } catch (err) {
        console.error('Failed to remove tag:', err);
      }
    });
  });

  // Add tag input
  const tagInput = content.querySelector('.vault-tag-input');
  const tagSuggestions = content.querySelector('.vault-tag-suggestions');
  if (tagInput) {
    let suggestTimeout = null;
    tagInput.addEventListener('input', () => {
      clearTimeout(suggestTimeout);
      suggestTimeout = setTimeout(() => showTagSuggestions(tagInput, tagSuggestions, note), 150);
    });
    tagInput.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const name = tagInput.value.trim();
        if (!name) return;
        await addTagToCurrentNote(note.id, name);
        tagInput.value = '';
        tagSuggestions.innerHTML = '';
        tagSuggestions.classList.remove('visible');
      }
      if (e.key === 'Escape') {
        tagInput.value = '';
        tagSuggestions.innerHTML = '';
        tagSuggestions.classList.remove('visible');
      }
    });
    tagInput.addEventListener('blur', () => {
      // Delay to allow click on suggestions
      setTimeout(() => {
        tagSuggestions.innerHTML = '';
        tagSuggestions.classList.remove('visible');
      }, 200);
    });
  }

  // Folder move button
  const folderMoveBtn = content.querySelector('.vault-folder-move-btn');
  if (folderMoveBtn) {
    folderMoveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showFolderPicker(folderMoveBtn, note.id, note.folder_id);
    });
  }
}

function getFolderName(folderId) {
  // Search recursively through folder tree
  function find(folders) {
    for (const f of folders) {
      if (f.id === folderId) return f.name;
      if (f.children) {
        const found = find(f.children);
        if (found) return found;
      }
    }
    return '';
  }
  return find(folderTree);
}

/**
 * Flatten folder tree for dropdown pickers.
 */
function flattenFolders(folders, depth = 0) {
  const result = [];
  for (const f of folders) {
    result.push({ ...f, depth });
    if (f.children) result.push(...flattenFolders(f.children, depth + 1));
  }
  return result;
}

// ============================================================
// Folder CRUD
// ============================================================

function showCreateFolderModal(parentId = null) {
  const overlay = document.createElement('div');
  overlay.className = 'task-input-overlay';
  overlay.innerHTML = `
    <div class="task-input-modal">
      <div class="task-input-title">${parentId ? 'New Subfolder' : 'New Folder'}</div>
      <input type="text" class="task-input-field" id="vaultFolderInput" placeholder="Folder name..." autofocus>
      <div class="task-input-buttons">
        <button class="task-input-btn cancel" id="vaultFolderCancel">Cancel</button>
        <button class="task-input-btn submit" id="vaultFolderSubmit">Create</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = document.getElementById('vaultFolderInput');
  const cancelBtn = document.getElementById('vaultFolderCancel');
  const submitBtn = document.getElementById('vaultFolderSubmit');

  const closeModal = () => overlay.remove();
  cancelBtn.addEventListener('click', closeModal);
  attachModalBehavior(overlay, input, submitBtn, closeModal);

  submitBtn.addEventListener('click', async () => {
    const name = input.value.trim();
    if (!name) return;
    try {
      await vaultFetch('/folders', { method: 'POST', body: { name, parent_id: parentId } });
      closeModal();
      await loadFolders();
      renderNav();
    } catch (err) {
      console.error('Failed to create folder:', err);
    }
  });

  input.focus();
}

function showRenameFolderModal(folderId, currentName) {
  const overlay = document.createElement('div');
  overlay.className = 'task-input-overlay';
  overlay.innerHTML = `
    <div class="task-input-modal">
      <div class="task-input-title">Rename Folder</div>
      <input type="text" class="task-input-field" id="vaultFolderInput" value="${escapeHtml(currentName)}">
      <div class="task-input-buttons">
        <button class="task-input-btn cancel" id="vaultFolderCancel">Cancel</button>
        <button class="task-input-btn submit" id="vaultFolderSubmit">Rename</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = document.getElementById('vaultFolderInput');
  const cancelBtn = document.getElementById('vaultFolderCancel');
  const submitBtn = document.getElementById('vaultFolderSubmit');
  input.select();

  const closeModal = () => overlay.remove();
  cancelBtn.addEventListener('click', closeModal);
  attachModalBehavior(overlay, input, submitBtn, closeModal);

  submitBtn.addEventListener('click', async () => {
    const name = input.value.trim();
    if (!name) return;
    try {
      await vaultFetch(`/folders/${folderId}`, { method: 'PATCH', body: { name } });
      closeModal();
      await loadFolders();
      renderNav();
    } catch (err) {
      console.error('Failed to rename folder:', err);
    }
  });
}

async function deleteFolderWithConfirm(folderId) {
  if (!confirm('Delete this folder? Notes will be moved to root.')) return;
  try {
    await vaultFetch(`/folders/${folderId}`, { method: 'DELETE' });
    if (activeFolderId === folderId) activeFolderId = null;
    await loadFolders();
    renderNav();
    await loadNotes();
  } catch (err) {
    console.error('Failed to delete folder:', err);
  }
}

async function moveNoteToFolder(noteId, folderId) {
  try {
    await vaultFetch(`/notes/${noteId}`, { method: 'PATCH', body: { folder_id: folderId } });
    await Promise.all([loadNotes(), loadFolders()]);
    renderNav();
    if (currentNoteId === noteId) {
      currentNote = { ...currentNote, folder_id: folderId };
      renderInspector(currentNote);
    }
  } catch (err) {
    console.error('Failed to move note:', err);
  }
}

// ============================================================
// Scope & Source management
// ============================================================

async function loadScopes() {
  try {
    scopeList = await vaultFetch('/scopes');
  } catch (err) {
    console.error('Failed to load vault scopes:', err);
    scopeList = [];
  }
}

async function loadSources() {
  if (!activeScopeId) return;
  try {
    const data = await vaultFetch(`/sources?scope_id=${activeScopeId}&limit=200`);
    sourceList = data.sources || [];
    renderSourceList();
  } catch (err) {
    console.error('Failed to load sources:', err);
    sourceList = [];
  }
}

async function loadIndexStatus() {
  try {
    indexStatus = await vaultFetch('/index/status');
  } catch {
    indexStatus = null;
  }
}

function renderSourceList() {
  const list = elements.vaultNoteList;
  if (!list) return;

  if (!sourceList.length) {
    list.innerHTML = '<div class="vault-list-empty">No indexed files</div>';
    return;
  }

  list.innerHTML = sourceList.map(s => {
    const statusClass = s.extraction_status === 'extracted' ? 'extracted'
      : s.extraction_status === 'failed' ? 'failed'
      : s.extraction_status === 'skipped' ? 'skipped'
      : 'pending';
    const size = formatFileSize(s.size_bytes);
    return `
      <div class="vault-note-item vault-source-item" data-source-id="${s.id}">
        <div class="vault-note-meta">
          <span class="vault-note-title">${escapeHtml(s.filename)}</span>
          <span class="vault-source-ext">${s.file_extension}</span>
          <span class="vault-source-status vault-source-status-${statusClass}">${statusClass}</span>
        </div>
        <span class="vault-note-excerpt">${escapeHtml(truncatePath(s.file_path, 60))}</span>
        <span class="vault-note-date">${size} &middot; ${formatDate(s.updated_at)}</span>
      </div>
    `;
  }).join('');

  list.querySelectorAll('.vault-source-item').forEach(item => {
    item.addEventListener('click', () => loadSourceDetail(item.dataset.sourceId));

    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        { label: 'Remove from Index', icon: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14"/>', danger: true, action: async () => {
          await vaultFetch(`/sources/${item.dataset.sourceId}`, { method: 'DELETE' });
          await loadSources();
        }},
      ]);
    });
  });
}

async function loadSourceDetail(sourceId) {
  try {
    const source = await vaultFetch(`/sources/${sourceId}`);

    currentNoteId = null;
    currentNote = null;

    elements.vaultEditorHeader.style.display = '';
    elements.vaultEmptyState.style.display = 'none';
    elements.vaultEditorBody.style.display = '';

    elements.vaultTitleInput.value = source.filename;
    elements.vaultTitleInput.disabled = true;

    const text = source.extracted_text || '(No extracted text)';
    setContent(text);

    renderSourceInspector(source);
  } catch (err) {
    console.error('Failed to load source:', err);
  }
}

function renderSourceInspector(source) {
  const content = elements.vaultInspectorContent;
  if (!content) return;

  content.innerHTML = `
    <div class="vault-inspector-section">
      <div class="vault-inspector-section-title">File Info</div>
      <dl class="vault-inspector-meta">
        <dt>Path: </dt><dd style="word-break:break-all;">${escapeHtml(source.file_path)}</dd><br>
        <dt>Type: </dt><dd>${escapeHtml(source.file_extension)}</dd><br>
        <dt>Size: </dt><dd>${formatFileSize(source.size_bytes)}</dd><br>
        <dt>Status: </dt><dd>${source.extraction_status}</dd><br>
        <dt>Words: </dt><dd>${source.extracted_word_count || 0}</dd><br>
        <dt>Indexed: </dt><dd>${formatDate(source.indexed_at)}</dd><br>
        <dt>Modified: </dt><dd>${formatDate(source.file_modified_at)}</dd><br>
      </dl>
    </div>
  `;
}

function formatFileSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function truncatePath(p, maxLen) {
  if (!p || p.length <= maxLen) return p;
  return '...' + p.slice(p.length - maxLen + 3);
}

function showAddScopeModal() {
  const overlay = document.createElement('div');
  overlay.className = 'task-input-overlay';
  overlay.innerHTML = `
    <div class="task-input-modal">
      <div class="task-input-title">Add Directory to Index</div>
      <div style="display:flex;gap:6px;align-items:center;">
        <input type="text" class="task-input-field" id="vaultScopePathInput" placeholder="/Users/you/Documents" style="flex:1;">
        <button class="task-input-btn submit" id="vaultScopeBrowse" style="white-space:nowrap;flex-shrink:0;">Browse...</button>
      </div>
      <label style="display:flex;align-items:center;gap:6px;margin:8px 0;font-size:var(--text-xs);color:var(--color-text-secondary);">
        <input type="checkbox" id="vaultScopeRecursive" checked> Include subdirectories
      </label>
      <div class="task-input-buttons">
        <button class="task-input-btn cancel" id="vaultScopeCancel">Cancel</button>
        <button class="task-input-btn submit" id="vaultScopeSubmit">Add & Index</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = document.getElementById('vaultScopePathInput');
  const browseBtn = document.getElementById('vaultScopeBrowse');
  const recursiveCheckbox = document.getElementById('vaultScopeRecursive');
  const cancelBtn = document.getElementById('vaultScopeCancel');
  const submitBtn = document.getElementById('vaultScopeSubmit');

  const closeModal = () => overlay.remove();
  cancelBtn.addEventListener('click', closeModal);
  attachModalBehavior(overlay, input, submitBtn, closeModal);

  browseBtn.addEventListener('click', async () => {
    const result = await window.os8.files.pickDirectory(input.value || undefined);
    if (!result.canceled && result.path) {
      input.value = result.path;
      input.focus();
    }
  });

  submitBtn.addEventListener('click', async () => {
    const scopePath = input.value.trim();
    if (!scopePath) return;
    try {
      await vaultFetch('/scopes', {
        method: 'POST',
        body: { path: scopePath, recursive: recursiveCheckbox.checked },
      });
      closeModal();
      await loadScopes();
      renderNav();
      pollIndexProgress();
    } catch (err) {
      alert(err.message);
    }
  });

  input.focus();
}

async function rescanScope(scopeId) {
  try {
    await vaultFetch(`/scopes/${scopeId}/rescan`, { method: 'POST' });
    pollIndexProgress();
  } catch (err) {
    console.error('Failed to rescan:', err);
  }
}

async function removeScopeWithConfirm(scopeId) {
  if (!confirm('Remove this directory from the index? Indexed data will be deleted. Original files are not affected.')) return;
  try {
    await vaultFetch(`/scopes/${scopeId}`, { method: 'DELETE' });
    if (activeScopeId === scopeId) activeScopeId = null;
    await loadScopes();
    renderNav();
  } catch (err) {
    console.error('Failed to remove scope:', err);
  }
}

function pollIndexProgress() {
  if (indexPollInterval) return;

  indexPollInterval = setInterval(async () => {
    await loadIndexStatus();

    // Update only the progress bar instead of rebuilding the entire sidebar
    const progressContainer = document.querySelector('.vault-index-progress');
    if (progressContainer && indexStatus?.isIndexing) {
      const pct = indexStatus.total > 0 ? Math.round((indexStatus.processed / indexStatus.total) * 100) : 0;
      const bar = progressContainer.querySelector('.vault-index-progress-bar');
      const text = progressContainer.querySelector('.vault-index-progress-text');
      if (bar) bar.style.width = `${pct}%`;
      if (text) text.textContent = `${indexStatus.processed}/${indexStatus.total} files (${pct}%)`;
    } else if (!progressContainer && indexStatus?.isIndexing) {
      // Progress bar not yet in DOM — do a full render once to create it
      renderNav();
    }

    if (!indexStatus || !indexStatus.isIndexing) {
      clearInterval(indexPollInterval);
      indexPollInterval = null;
      // Full refresh only when done
      if (activeScopeId) {
        scopeFilesCache.delete(activeScopeId);
        await loadSources();
      }
      await loadScopes();
      renderNav();
    }
  }, 2000);
}

// ============================================================
// Tag CRUD
// ============================================================

function showCreateTagModal() {
  const overlay = document.createElement('div');
  overlay.className = 'task-input-overlay';
  overlay.innerHTML = `
    <div class="task-input-modal">
      <div class="task-input-title">New Tag</div>
      <input type="text" class="task-input-field" id="vaultTagInput" placeholder="Tag name..." autofocus>
      <div class="task-input-buttons">
        <button class="task-input-btn cancel" id="vaultTagCancel">Cancel</button>
        <button class="task-input-btn submit" id="vaultTagSubmit">Create</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = document.getElementById('vaultTagInput');
  const cancelBtn = document.getElementById('vaultTagCancel');
  const submitBtn = document.getElementById('vaultTagSubmit');

  const closeModal = () => overlay.remove();
  cancelBtn.addEventListener('click', closeModal);
  attachModalBehavior(overlay, input, submitBtn, closeModal);

  submitBtn.addEventListener('click', async () => {
    const name = input.value.trim();
    if (!name) return;
    try {
      await vaultFetch('/tags', { method: 'POST', body: { name } });
      closeModal();
      await loadTags();
      renderNav();
    } catch (err) {
      console.error('Failed to create tag:', err);
    }
  });

  input.focus();
}

function showRenameTagModal(tagId, currentName) {
  const overlay = document.createElement('div');
  overlay.className = 'task-input-overlay';
  overlay.innerHTML = `
    <div class="task-input-modal">
      <div class="task-input-title">Rename Tag</div>
      <input type="text" class="task-input-field" id="vaultTagInput" value="${escapeHtml(currentName)}">
      <div class="task-input-buttons">
        <button class="task-input-btn cancel" id="vaultTagCancel">Cancel</button>
        <button class="task-input-btn submit" id="vaultTagSubmit">Rename</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = document.getElementById('vaultTagInput');
  const cancelBtn = document.getElementById('vaultTagCancel');
  const submitBtn = document.getElementById('vaultTagSubmit');
  input.select();

  const closeModal = () => overlay.remove();
  cancelBtn.addEventListener('click', closeModal);
  attachModalBehavior(overlay, input, submitBtn, closeModal);

  submitBtn.addEventListener('click', async () => {
    const name = input.value.trim();
    if (!name) return;
    try {
      await vaultFetch(`/tags/${tagId}`, { method: 'PATCH', body: { name } });
      closeModal();
      await loadTags();
      renderNav();
    } catch (err) {
      console.error('Failed to rename tag:', err);
    }
  });
}

async function deleteTagWithConfirm(tagId) {
  if (!confirm('Delete this tag? It will be removed from all notes.')) return;
  try {
    await vaultFetch(`/tags/${tagId}`, { method: 'DELETE' });
    if (activeTagId === tagId) activeTagId = null;
    await loadTags();
    renderNav();
  } catch (err) {
    console.error('Failed to delete tag:', err);
  }
}

// ============================================================
// Inspector tag input helpers
// ============================================================

function showTagSuggestions(input, container, note) {
  const query = input.value.trim().toLowerCase();
  if (!query) {
    container.innerHTML = '';
    container.classList.remove('visible');
    return;
  }

  const noteTagIds = new Set((note.tags || []).map(t => t.id));
  const filtered = tagList.filter(t =>
    t.name.toLowerCase().includes(query) && !noteTagIds.has(t.id)
  ).slice(0, 8);

  if (!filtered.length) {
    container.innerHTML = `<div class="vault-tag-suggestion-item vault-tag-suggestion-create">Create "#${escapeHtml(query)}"</div>`;
  } else {
    container.innerHTML = filtered.map(t =>
      `<div class="vault-tag-suggestion-item" data-tag-id="${t.id}">#${escapeHtml(t.name)} <span class="vault-nav-badge">${t.note_count || 0}</span></div>`
    ).join('');
  }
  container.classList.add('visible');

  // Click handlers
  container.querySelectorAll('.vault-tag-suggestion-item').forEach(item => {
    item.addEventListener('mousedown', async (e) => {
      e.preventDefault();
      const tagId = item.dataset.tagId;
      if (tagId) {
        // Existing tag
        await addTagToCurrentNoteById(note.id, tagId);
      } else {
        // Create new tag
        await addTagToCurrentNote(note.id, query);
      }
      input.value = '';
      container.innerHTML = '';
      container.classList.remove('visible');
    });
  });
}

async function addTagToCurrentNote(noteId, tagName) {
  try {
    const tag = await vaultFetch('/tags', { method: 'POST', body: { name: tagName } });
    await vaultFetch(`/notes/${noteId}/tags`, { method: 'POST', body: { tag_ids: [tag.id] } });
    const updated = await vaultFetch(`/notes/${noteId}`);
    currentNote = updated;
    renderInspector(updated);
    await loadTags();
    renderNav();
  } catch (err) {
    console.error('Failed to add tag:', err);
  }
}

async function addTagToCurrentNoteById(noteId, tagId) {
  try {
    await vaultFetch(`/notes/${noteId}/tags`, { method: 'POST', body: { tag_ids: [tagId] } });
    const updated = await vaultFetch(`/notes/${noteId}`);
    currentNote = updated;
    renderInspector(updated);
    await loadTags();
    renderNav();
  } catch (err) {
    console.error('Failed to add tag:', err);
  }
}

// ============================================================
// Templates
// ============================================================

async function loadTemplates() {
  try {
    templateList = await vaultFetch('/templates');
  } catch (err) {
    console.error('Failed to load templates:', err);
    templateList = [];
  }
}

function showTemplatePicker() {
  const overlay = document.createElement('div');
  overlay.className = 'task-input-overlay';

  const items = templateList.length ? templateList : [{ id: null, name: 'Blank', content: '' }];
  const itemsHtml = items.map(t => {
    const preview = (t.content || '').replace(/[#\-*[\]{}()`]/g, '').trim().slice(0, 60);
    return `
      <div class="vault-template-item" data-template-id="${t.id || ''}">
        <div class="vault-template-name">${escapeHtml(t.name)}</div>
        ${preview ? `<div class="vault-template-preview">${escapeHtml(preview)}</div>` : ''}
      </div>
    `;
  }).join('');

  overlay.innerHTML = `
    <div class="task-input-modal">
      <div class="task-input-title">New Note</div>
      <input type="text" class="task-input-field" id="vaultTemplateTitle" placeholder="Note title..." autofocus>
      <div class="vault-template-list">${itemsHtml}</div>
      <div class="task-input-buttons">
        <button class="task-input-btn cancel" id="vaultTemplateCancel">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const titleInput = document.getElementById('vaultTemplateTitle');
  const cancelBtn = document.getElementById('vaultTemplateCancel');

  const closeModal = () => overlay.remove();
  cancelBtn.addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
    if (e.key === 'Enter') {
      e.preventDefault();
      // Use blank template on Enter
      closeModal();
      const title = titleInput.value.trim() || 'Untitled';
      createNote({ title, content: '' });
    }
  });

  overlay.querySelectorAll('.vault-template-item').forEach(item => {
    item.addEventListener('click', () => {
      const templateId = item.dataset.templateId;
      const template = templateList.find(t => t.id === templateId);
      const title = titleInput.value.trim() || 'Untitled';
      const today = new Date().toISOString().split('T')[0];
      let content = (template?.content || '').replace(/\{\{date\}\}/g, today).replace(/\{\{title\}\}/g, title);
      closeModal();
      createNote({ title, content });
    });
  });

  titleInput.focus();
}

// ============================================================
// Version History
// ============================================================

async function loadVersionsForInspector(noteId) {
  const container = document.querySelector(`.vault-version-list[data-note-id="${noteId}"]`);
  if (!container) return;

  try {
    const versions = await vaultFetch(`/notes/${noteId}/versions`);
    if (!versions.length) {
      container.innerHTML = '<span style="font-size:var(--text-xs);color:var(--color-text-muted);">No versions</span>';
      return;
    }

    container.innerHTML = versions.slice(0, 20).map(v => `
      <div class="vault-version-item" data-version-id="${v.id}">
        <span class="vault-version-num">v${v.version_number}</span>
        <span class="vault-version-date">${formatDate(v.created_at)}</span>
        <button class="vault-version-btn vault-version-view-btn" data-version-id="${v.id}" data-version-num="${v.version_number}" title="View this version">View</button>
        <button class="vault-version-btn vault-version-restore-btn" data-version-id="${v.id}" data-note-id="${noteId}" title="Restore this version">Restore</button>
      </div>
    `).join('');

    // Wire view buttons
    container.querySelectorAll('.vault-version-view-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const versionId = btn.dataset.versionId;
        const versionNum = btn.dataset.versionNum;
        const version = versions.find(v => v.id === versionId);
        if (version) {
          enterVersionView(version.content, version.title, versionNum, noteId, versionId);
        }
      });
    });

    // Wire restore buttons
    container.querySelectorAll('.vault-version-restore-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const versionId = btn.dataset.versionId;
        const noteId = btn.dataset.noteId;
        await restoreVersion(noteId, versionId);
      });
    });
  } catch (err) {
    container.innerHTML = '<span style="font-size:var(--text-xs);color:var(--color-text-muted);">Failed to load</span>';
  }
}

function enterVersionView(content, title, versionNum, noteId, versionId) {
  viewingVersion = true;
  viewingVersionNoteId = noteId;
  viewingVersionId = versionId;

  // Set editor to read-only and show version content
  setReadOnly(true);
  setContent(content);

  // Insert banner before editor body
  let banner = document.querySelector('.vault-version-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'vault-version-banner';
    elements.vaultEditorBody.parentNode.insertBefore(banner, elements.vaultEditorBody);
  }
  banner.innerHTML = `
    <span>Viewing version ${escapeHtml(String(versionNum))}</span>
    <button class="vault-version-back-btn">Back to current</button>
    <button class="vault-version-restore-banner-btn">Restore this version</button>
  `;
  banner.style.display = '';

  banner.querySelector('.vault-version-back-btn').addEventListener('click', exitVersionView);
  banner.querySelector('.vault-version-restore-banner-btn').addEventListener('click', async () => {
    await restoreVersion(noteId, versionId);
  });
}

function exitVersionView() {
  if (!viewingVersion) return;
  viewingVersion = false;
  viewingVersionNoteId = null;
  viewingVersionId = null;

  // Remove banner
  const banner = document.querySelector('.vault-version-banner');
  if (banner) banner.style.display = 'none';

  // Restore editor
  setReadOnly(false);
  if (currentNote) {
    setContent(currentNote.content || '');
  }
}

async function restoreVersion(noteId, versionId) {
  try {
    exitVersionView();
    const updated = await vaultFetch(`/notes/${noteId}/restore/${versionId}`, { method: 'POST' });
    currentNote = { ...currentNote, ...updated };
    currentNoteId = noteId;
    setContent(updated.content || '');
    elements.vaultTitleInput.value = updated.title || '';
    isDirty = false;
    updateSaveIndicator();
    renderInspector(updated);
    await loadNotes();
  } catch (err) {
    console.error('Failed to restore version:', err);
  }
}

// ============================================================
// Folder picker (inspector move)
// ============================================================

function showFolderPicker(btn, noteId, currentFolderId) {
  // Remove any existing picker
  document.querySelector('.vault-folder-picker')?.remove();

  const picker = document.createElement('div');
  picker.className = 'vault-folder-picker';

  const flat = flattenFolders(folderTree);
  const items = [
    { id: null, name: 'None (root)', depth: 0 },
    ...flat,
  ];

  picker.innerHTML = items.map(f => `
    <div class="vault-folder-picker-item ${f.id === currentFolderId ? 'active' : ''}"
         data-folder-id="${f.id || ''}" style="padding-left:${8 + f.depth * 12}px;">
      ${escapeHtml(f.name)}
    </div>
  `).join('');

  // Position near the button
  const rect = btn.getBoundingClientRect();
  picker.style.position = 'fixed';
  picker.style.left = rect.left + 'px';
  picker.style.top = (rect.bottom + 2) + 'px';
  document.body.appendChild(picker);

  // Adjust if off-screen
  const pRect = picker.getBoundingClientRect();
  if (pRect.bottom > window.innerHeight) {
    picker.style.top = (rect.top - pRect.height - 2) + 'px';
  }

  picker.querySelectorAll('.vault-folder-picker-item').forEach(item => {
    item.addEventListener('click', async () => {
      const folderId = item.dataset.folderId || null;
      picker.remove();
      await moveNoteToFolder(noteId, folderId);
    });
  });

  // Close on click outside
  setTimeout(() => {
    document.addEventListener('click', function handler(e) {
      if (!picker.contains(e.target)) {
        picker.remove();
        document.removeEventListener('click', handler);
      }
    });
  }, 0);
}

// ============================================================
// UI helpers
// ============================================================

function showEmptyState() {
  elements.vaultEditorHeader.style.display = 'none';
  elements.vaultEditorBody.style.display = 'none';
  elements.vaultEmptyState.style.display = '';

  // Show onboarding for first-time users vs "no note selected"
  if (notesList.length === 0) {
    elements.vaultEmptyState.innerHTML = `
      <div class="vault-onboarding-empty">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-muted)" stroke-width="1.5">
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
        </svg>
        <h3>Welcome to the Vault</h3>
        <p>Your personal knowledge layer. Create notes, link ideas, and search across everything.</p>
        <div class="vault-empty-actions">
          <button class="vault-create-btn" id="vaultOnboardCreateBtn">Create First Note</button>
          <button class="vault-create-btn secondary" id="vaultOnboardImportBtn">Import Notes</button>
        </div>
      </div>
    `;
    elements.vaultEmptyState.querySelector('#vaultOnboardCreateBtn')?.addEventListener('click', () => showTemplatePicker());
    elements.vaultEmptyState.querySelector('#vaultOnboardImportBtn')?.addEventListener('click', () => showImportModal());
  } else {
    elements.vaultEmptyState.innerHTML = `
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-muted)" stroke-width="1.5">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
      </svg>
      <p>No note selected</p>
      <button class="vault-create-btn" id="vaultEmptyCreateBtn2">Create a note</button>
    `;
    elements.vaultEmptyState.querySelector('#vaultEmptyCreateBtn2')?.addEventListener('click', () => showTemplatePicker());
  }

  destroyEditor();
}

function updateSaveIndicator() {
  const el = elements.vaultSaveIndicator;
  if (!el) return;
  if (isDirty) {
    el.textContent = 'Unsaved';
    el.className = 'vault-save-indicator dirty';
  } else {
    el.textContent = 'Saved';
    el.className = 'vault-save-indicator';
  }
}

function updatePinButton() {
  const btn = elements.vaultPinNoteBtn;
  if (!btn) return;
  if (currentNote?.is_pinned) {
    btn.classList.add('vault-pin-active');
    btn.title = 'Unpin note';
  } else {
    btn.classList.remove('vault-pin-active');
    btn.title = 'Pin note';
  }
}

function onEditorChange() {
  if (viewingVersion) return; // Don't auto-save when viewing a version

  isDirty = true;
  updateSaveIndicator();

  // Auto-save after delay
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    saveCurrentNote();
  }, AUTO_SAVE_DELAY);
}

function onEditorSave() {
  saveCurrentNote();
}

function onTitleChange() {
  isDirty = true;
  updateSaveIndicator();

  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    saveCurrentNote();
  }, AUTO_SAVE_DELAY);
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + (dateStr.includes('Z') ? '' : 'Z'));
  const now = new Date();
  const diff = now - d;

  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;

  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============================================================
// Sidebar toggle
// ============================================================

function toggleSidebar() {
  const sidebar = elements.vaultSidebar;
  if (!sidebar) return;
  sidebar.classList.toggle('collapsed');
}

function toggleInspector() {
  const inspector = elements.vaultInspector;
  if (!inspector) return;
  inspector.classList.toggle('collapsed');
}

// ============================================================
// Search
// ============================================================

function onSearchInput() {
  clearTimeout(searchTimeout);
  const query = elements.vaultSearchInput?.value?.trim();

  if (!query) {
    searchResults = null;
    loadNotes();
    return;
  }

  searchTimeout = setTimeout(async () => {
    try {
      const data = await vaultFetch(`/search?${new URLSearchParams({
        q: query,
        mode: searchMode,
        limit: '30',
        is_archived: '0',
      })}`);
      searchResults = data.results || [];
      renderSearchResults();
    } catch (err) {
      console.error('Search failed:', err);
      searchResults = null;
      loadNotes();
    }
  }, 300);
}

function renderSearchResults() {
  const list = elements.vaultNoteList;
  if (!list) return;

  if (!searchResults || !searchResults.length) {
    list.innerHTML = '<div class="vault-list-empty">No results</div>';
    return;
  }

  list.innerHTML = searchResults.map(r => {
    const isActive = r.note_id === currentNoteId;
    const date = formatDate(r.updated_at);
    const badge = r.match_type === 'both' ? 'K+S'
      : r.match_type === 'keyword' ? 'K'
      : 'S';
    const snippet = r.snippet || '';
    const typeIndicator = r.result_type === 'source'
      ? '<span class="vault-search-type vault-search-type-source">File</span>'
      : '';
    const dataAttr = r.note_id ? `data-note-id="${r.note_id}"` : `data-source-id="${r.source_id}"`;
    return `
      <div class="vault-note-item vault-search-result ${isActive ? 'active' : ''}" ${dataAttr}>
        <div class="vault-note-meta">
          <span class="vault-note-title">${escapeHtml(r.title || 'Untitled')}</span>
          ${typeIndicator}
          <span class="vault-search-badge vault-search-badge-${r.match_type || 'keyword'}">${badge}</span>
        </div>
        <span class="vault-note-excerpt vault-search-snippet">${snippet}</span>
        <span class="vault-note-date">${date}</span>
      </div>
    `;
  }).join('');

  list.querySelectorAll('.vault-search-result').forEach(item => {
    item.addEventListener('click', () => {
      const noteId = item.dataset.noteId;
      const sourceId = item.dataset.sourceId;
      if (noteId && noteId !== currentNoteId) loadNote(noteId);
      else if (sourceId) loadSourceDetail(sourceId);
    });
  });
}

// ============================================================
// Graph View
// ============================================================

const D3 = window.D3;

const NODE_COLORS = [
  '#6366f1', '#3b82f6', '#06b6d4', '#10b981', '#84cc16',
  '#eab308', '#f97316', '#ef4444', '#ec4899', '#8b5cf6'
];

function showGraphView() {
  graphMode = true;

  // Hide editor
  elements.vaultEditorHeader.style.display = 'none';
  elements.vaultEditorBody.style.display = 'none';
  elements.vaultEmptyState.style.display = 'none';
  const banner = document.querySelector('.vault-version-banner');
  if (banner) banner.style.display = 'none';

  // Create graph container if not exists
  let container = elements.vaultEditorArea.querySelector('.vault-graph-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'vault-graph-container';
    container.innerHTML = `
      <div class="vault-graph-toolbar">
        <button class="vault-graph-mode-btn active" data-mode="global">Global</button>
        <button class="vault-graph-mode-btn" data-mode="local">Local</button>
        <select class="vault-graph-depth-select" title="Link depth">
          <option value="1">1</option>
          <option value="2" selected>2</option>
          <option value="3">3</option>
        </select>
        <select class="vault-graph-scope-select" title="Scope filter"></select>
        <button class="vault-graph-mode-btn vault-graph-rebuild-btn" title="Rebuild semantic edges from embeddings">Rebuild</button>
      </div>
      <svg></svg>
    `;
    elements.vaultEditorArea.appendChild(container);

    // Wire toolbar
    container.querySelectorAll('.vault-graph-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        container.querySelectorAll('.vault-graph-mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const mode = btn.dataset.mode;
        if (mode === 'local' && currentNoteId) {
          const depth = parseInt(container.querySelector('.vault-graph-depth-select').value) || 2;
          renderLocalGraph(currentNoteId, depth);
        } else {
          loadAndRenderGraph();
        }
      });
    });

    container.querySelector('.vault-graph-depth-select').addEventListener('change', (e) => {
      const localBtn = container.querySelector('.vault-graph-mode-btn[data-mode="local"]');
      if (localBtn.classList.contains('active') && currentNoteId) {
        renderLocalGraph(currentNoteId, parseInt(e.target.value) || 2);
      }
    });

    container.querySelector('.vault-graph-scope-select')?.addEventListener('change', () => {
      loadAndRenderGraph();
    });

    container.querySelector('.vault-graph-rebuild-btn')?.addEventListener('click', async () => {
      const btn = container.querySelector('.vault-graph-rebuild-btn');
      const scopeVal = container.querySelector('.vault-graph-scope-select')?.value || '';
      btn.textContent = 'Building...';
      btn.disabled = true;
      const body = {};
      if (scopeVal && scopeVal !== 'notes') body.scope_id = scopeVal;
      try {
        await vaultFetch('/graph/rebuild-semantic', { method: 'POST', body });
        // Poll for completion (edges are computed in background)
        let attempts = 0;
        const poll = setInterval(async () => {
          attempts++;
          const status = await vaultFetch('/graph/status');
          if (status.pending === 0 || attempts > 30) {
            clearInterval(poll);
            btn.textContent = 'Rebuild';
            btn.disabled = false;
            loadAndRenderGraph();
          }
        }, 2000);
      } catch (err) {
        console.error('Failed to rebuild edges:', err);
        btn.textContent = 'Rebuild';
        btn.disabled = false;
      }
    });
  }

  container.style.display = '';

  // Populate scope selector
  const scopeSelect = container.querySelector('.vault-graph-scope-select');
  if (scopeSelect) {
    scopeSelect.innerHTML = `
      <option value="">All</option>
      <option value="notes">Notes only</option>
      ${scopeList.map(s => `<option value="${s.id}">${escapeHtml(s.label || pathBasename(s.path))}</option>`).join('')}
    `;
  }

  loadAndRenderGraph();
}

function hideGraphView() {
  graphMode = false;
  destroyGraph();

  const container = elements.vaultEditorArea.querySelector('.vault-graph-container');
  if (container) container.style.display = 'none';

  // Restore editor
  if (currentNote) {
    elements.vaultEditorHeader.style.display = '';
    elements.vaultEditorBody.style.display = '';
  } else {
    elements.vaultEmptyState.style.display = '';
  }
}

async function loadAndRenderGraph() {
  try {
    const scopeSelect = document.querySelector('.vault-graph-scope-select');
    const scopeValue = scopeSelect?.value || '';
    let url = '/graph?includeSources=true';
    if (scopeValue === 'notes') url = '/graph?notesOnly=true';
    else if (scopeValue) url = `/graph?scope_id=${scopeValue}&includeSources=true`;
    const data = await vaultFetch(url);
    renderGraph(data);
  } catch (err) {
    console.error('Failed to load graph:', err);
  }
}

async function renderLocalGraph(noteId, depth, docType = 'note') {
  try {
    const data = await vaultFetch(`/graph/${noteId}?depth=${depth}&docType=${docType}`);
    renderGraph(data, noteId);
  } catch (err) {
    console.error('Failed to load local graph:', err);
  }
}

function renderGraph(data, focusNodeId = null) {
  destroyGraph();
  const t0 = Date.now();

  const container = elements.vaultEditorArea.querySelector('.vault-graph-container');
  if (!container || !D3) return;

  const svg = D3.select(container.querySelector('svg'));
  const rect = container.getBoundingClientRect();
  const width = rect.width || 600;
  const height = rect.height || 400;

  svg.attr('viewBox', `0 0 ${width} ${height}`);

  let { nodes, edges } = data;

  // Cap nodes for performance (keep most-connected)
  const MAX_GRAPH_NODES = 300;
  if (nodes.length > MAX_GRAPH_NODES && !focusNodeId) {
    // Count connections per node
    const connCount = new Map();
    for (const n of nodes) connCount.set(n.id, 0);
    for (const e of edges) {
      connCount.set(e.source, (connCount.get(e.source) || 0) + 1);
      connCount.set(e.target, (connCount.get(e.target) || 0) + 1);
    }
    nodes.sort((a, b) => (connCount.get(b.id) || 0) - (connCount.get(a.id) || 0));
    const kept = new Set(nodes.slice(0, MAX_GRAPH_NODES).map(n => n.id));
    nodes = nodes.filter(n => kept.has(n.id));
    edges = edges.filter(e => {
      const src = typeof e.source === 'object' ? e.source.id : e.source;
      const tgt = typeof e.target === 'object' ? e.target.id : e.target;
      return kept.has(src) && kept.has(tgt);
    });
    console.log(`[Vault:Perf] Graph capped to ${MAX_GRAPH_NODES} of ${data.nodes.length} nodes`);
  }

  if (!nodes.length) {
    svg.append('text')
      .attr('x', width / 2)
      .attr('y', height / 2)
      .attr('text-anchor', 'middle')
      .attr('fill', '#64748b')
      .attr('font-size', '14px')
      .text('No documents with embeddings yet. Index a directory first.');
    return;
  }

  // Build adjacency for connection counts
  const connectionCount = {};
  nodes.forEach(n => { connectionCount[n.id] = 0; });
  edges.forEach(e => {
    const srcId = e.source_id || e.source_note_id;
    const tgtId = e.target_id || e.target_note_id;
    connectionCount[srcId] = (connectionCount[srcId] || 0) + 1;
    connectionCount[tgtId] = (connectionCount[tgtId] || 0) + 1;
  });

  // Build folder color map
  const folderIds = [...new Set(nodes.filter(n => n.folder_id).map(n => n.folder_id))];
  const colorScale = D3.scaleOrdinal().domain(folderIds).range(NODE_COLORS);

  const SOURCE_COLOR = '#64748b';  // slate for files
  const EXT_COLORS = { '.js': '#eab308', '.ts': '#3b82f6', '.py': '#22c55e', '.md': '#a855f7', '.json': '#f97316', '.css': '#06b6d4', '.html': '#ef4444' };

  function nodeColor(n) {
    if (n.id === focusNodeId) return '#f59e0b';
    if (n.node_type === 'source') return EXT_COLORS[n.file_extension] || SOURCE_COLOR;
    if (n.is_daily) return '#eab308';
    if (n.is_pinned) return '#f97316';
    if (n.folder_id) return colorScale(n.folder_id);
    return '#6366f1';
  }

  function nodeRadius(n) {
    const count = connectionCount[n.id] || 0;
    return Math.max(4, Math.min(16, 4 + count * 1.5));
  }

  // Build simulation links — normalize edge format
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const simLinks = edges
    .map(e => {
      const srcId = e.source_id || e.source_note_id;
      const tgtId = e.target_id || e.target_note_id;
      return { source: srcId, target: tgtId, edge_type: e.edge_type || 'wikilink' };
    })
    .filter(e => nodeMap.has(e.source) && nodeMap.has(e.target));

  // Deduplicate links (same source+target)
  const linkKey = l => `${l.source}:${l.target}`;
  const seenLinks = new Set();
  const dedupedLinks = simLinks.filter(l => {
    const k = linkKey(l);
    const kr = `${l.target}:${l.source}`;
    if (seenLinks.has(k) || seenLinks.has(kr)) return false;
    seenLinks.add(k);
    return true;
  });

  // Faster convergence for large graphs
  const isLarge = nodes.length > 100;

  graphSimulation = D3.forceSimulation(nodes)
    .force('link', D3.forceLink(dedupedLinks).id(d => d.id).distance(isLarge ? 60 : 80))
    .force('charge', D3.forceManyBody().strength(isLarge ? -120 : -200))
    .force('center', D3.forceCenter(width / 2, height / 2))
    .force('collide', D3.forceCollide().radius(d => nodeRadius(d) + 4));

  if (isLarge) {
    graphSimulation.alphaDecay(0.05).velocityDecay(0.4);
  }

  console.log(`[Vault:Perf] Graph render setup: ${Date.now() - t0}ms (${nodes.length} nodes, ${dedupedLinks.length} edges)`);

  // Container group for zoom
  const g = svg.append('g');

  // Zoom
  const zoomBehavior = D3.zoom()
    .scaleExtent([0.1, 4])
    .on('zoom', (event) => g.attr('transform', event.transform));
  svg.call(zoomBehavior);

  // Edges — style by type
  const link = g.append('g')
    .selectAll('line')
    .data(dedupedLinks)
    .join('line')
    .attr('class', d => d.edge_type === 'semantic' ? 'vault-graph-edge vault-graph-edge-semantic' : 'vault-graph-edge');

  // Note nodes (circles)
  const noteNodes = nodes.filter(n => n.node_type !== 'source');
  const noteNode = g.append('g')
    .selectAll('circle')
    .data(noteNodes)
    .join('circle')
    .attr('class', 'vault-graph-node')
    .attr('r', d => nodeRadius(d))
    .attr('fill', d => nodeColor(d))
    .on('click', (event, d) => {
      event.stopPropagation();
      hideGraphView();
      sidebarSection = 'all';
      renderNav();
      loadNote(d.id);
    })
    .call(graphDragBehavior());

  // Source nodes (rounded rectangles)
  const sourceNodes = nodes.filter(n => n.node_type === 'source');
  const sourceNode = g.append('g')
    .selectAll('rect')
    .data(sourceNodes)
    .join('rect')
    .attr('class', 'vault-graph-node vault-graph-node-source')
    .attr('width', d => nodeRadius(d) * 2)
    .attr('height', d => nodeRadius(d) * 2)
    .attr('rx', 3)
    .attr('ry', 3)
    .attr('fill', d => nodeColor(d))
    .attr('opacity', 0.85)
    .on('click', (event, d) => {
      event.stopPropagation();
      hideGraphView();
      sidebarSection = 'indexed';
      renderNav();
      loadSourceDetail(d.id);
    })
    .call(graphDragBehavior());

  // Labels
  const showAllLabels = nodes.length <= 40;
  const minConn = nodes.length > 200 ? 4 : nodes.length > 100 ? 3 : 2;
  const labelData = nodes.filter(n => showAllLabels || (connectionCount[n.id] || 0) >= minConn);
  const label = g.append('g')
    .selectAll('text')
    .data(labelData)
    .join('text')
    .attr('class', 'vault-graph-label')
    .attr('dy', d => -nodeRadius(d) - 4)
    .attr('text-anchor', 'middle')
    .text(d => (d.title || 'Untitled').slice(0, 24));

  // Tick
  graphSimulation.on('tick', () => {
    link
      .attr('x1', d => d.source.x)
      .attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x)
      .attr('y2', d => d.target.y);

    noteNode
      .attr('cx', d => d.x)
      .attr('cy', d => d.y);

    sourceNode
      .attr('x', d => d.x - nodeRadius(d))
      .attr('y', d => d.y - nodeRadius(d));

    label
      .attr('x', d => d.x)
      .attr('y', d => d.y);
  });

  // Center on focus node after stabilization
  if (focusNodeId) {
    graphSimulation.on('end', () => {
      const focusNode = nodes.find(n => n.id === focusNodeId);
      if (focusNode) {
        const transform = D3.zoomIdentity
          .translate(width / 2, height / 2)
          .scale(1.2)
          .translate(-focusNode.x, -focusNode.y);
        svg.transition().duration(500).call(zoomBehavior.transform, transform);
      }
    });
  }
}

function graphDragBehavior() {
  return D3.drag()
    .on('start', (event, d) => {
      if (!event.active) graphSimulation.alphaTarget(0.3).restart();
      d.fx = d.x;
      d.fy = d.y;
    })
    .on('drag', (event, d) => {
      d.fx = event.x;
      d.fy = event.y;
    })
    .on('end', (event, d) => {
      if (!event.active) graphSimulation.alphaTarget(0);
      d.fx = null;
      d.fy = null;
    });
}

function destroyGraph() {
  if (graphSimulation) {
    graphSimulation.stop();
    graphSimulation = null;
  }
  const container = elements.vaultEditorArea?.querySelector('.vault-graph-container');
  if (container) {
    const svg = container.querySelector('svg');
    if (svg) svg.innerHTML = '';
  }
}

// ============================================================
// Daily Notes Calendar
// ============================================================

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function renderDailyView() {
  const list = elements.vaultNoteList;
  if (!list) return;

  const calendarHtml = buildCalendarGrid(calendarYear, calendarMonth);

  const notesHtml = notesList.length ? notesList.map(note => {
    const isActive = note.id === currentNoteId;
    const excerpt = (note.content_plain || '').slice(0, 80);
    return `
      <div class="vault-note-item ${isActive ? 'active' : ''}" data-note-id="${note.id}">
        <div class="vault-note-meta">
          <span class="vault-note-title">${escapeHtml(note.title || 'Untitled')}</span>
        </div>
        <span class="vault-note-excerpt">${escapeHtml(excerpt)}</span>
        <span class="vault-note-date">${formatDate(note.updated_at || note.created_at)}</span>
      </div>
    `;
  }).join('') : '<div class="vault-list-empty">No daily notes</div>';

  list.innerHTML = calendarHtml + notesHtml;

  // Wire calendar navigation
  list.querySelector('.vault-calendar-prev')?.addEventListener('click', () => navigateCalendarMonth(-1));
  list.querySelector('.vault-calendar-next')?.addEventListener('click', () => navigateCalendarMonth(1));
  list.querySelector('.vault-calendar-today-btn')?.addEventListener('click', () => {
    calendarYear = new Date().getFullYear();
    calendarMonth = new Date().getMonth();
    const todayStr = new Date().toISOString().split('T')[0];
    onCalendarDateClick(todayStr);
    renderDailyView();
  });

  // Wire calendar day clicks
  list.querySelectorAll('.vault-calendar-day[data-date]').forEach(day => {
    day.addEventListener('click', () => {
      onCalendarDateClick(day.dataset.date);
    });
  });

  // Wire note list clicks
  list.querySelectorAll('.vault-note-item[data-note-id]').forEach(item => {
    item.addEventListener('click', () => {
      const noteId = item.dataset.noteId;
      if (noteId !== currentNoteId) loadNote(noteId);
    });
  });
}

function buildCalendarGrid(year, month) {
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

  // First day of month (0=Sun, convert to Mon-based)
  const firstDay = new Date(year, month, 1);
  const startDow = (firstDay.getDay() + 6) % 7; // 0=Mon
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // Previous month fill
  const prevMonthDays = new Date(year, month, 0).getDate();

  const dowHtml = DOW_LABELS.map(d => `<div class="vault-calendar-dow">${d}</div>`).join('');

  let daysHtml = '';

  // Previous month padding
  for (let i = startDow - 1; i >= 0; i--) {
    const day = prevMonthDays - i;
    const prevMonth = month === 0 ? 11 : month - 1;
    const prevYear = month === 0 ? year - 1 : year;
    const dateStr = `${prevYear}-${String(prevMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const hasNote = dailyNoteDates.has(dateStr) ? ' has-note' : '';
    daysHtml += `<div class="vault-calendar-day other-month${hasNote}" data-date="${dateStr}">${day}</div>`;
  }

  // Current month days
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const isToday = dateStr === todayStr ? ' today' : '';
    const hasNote = dailyNoteDates.has(dateStr) ? ' has-note' : '';
    const isActive = currentNote?.daily_date === dateStr ? ' active' : '';
    daysHtml += `<div class="vault-calendar-day${isToday}${hasNote}${isActive}" data-date="${dateStr}">${d}</div>`;
  }

  // Next month padding (fill to 42 cells = 6 rows)
  const totalCells = startDow + daysInMonth;
  const remaining = totalCells <= 35 ? 35 - totalCells : 42 - totalCells;
  for (let d = 1; d <= remaining; d++) {
    const nextMonth = month === 11 ? 0 : month + 1;
    const nextYear = month === 11 ? year + 1 : year;
    const dateStr = `${nextYear}-${String(nextMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const hasNote = dailyNoteDates.has(dateStr) ? ' has-note' : '';
    daysHtml += `<div class="vault-calendar-day other-month${hasNote}" data-date="${dateStr}">${d}</div>`;
  }

  return `
    <div class="vault-calendar">
      <div class="vault-calendar-header">
        <button class="vault-calendar-nav vault-calendar-prev" title="Previous month">&lsaquo;</button>
        <span class="vault-calendar-title">${MONTH_NAMES[month]} ${year}</span>
        <button class="vault-calendar-today-btn">Today</button>
        <button class="vault-calendar-nav vault-calendar-next" title="Next month">&rsaquo;</button>
      </div>
      <div class="vault-calendar-grid">
        ${dowHtml}
        ${daysHtml}
      </div>
    </div>
  `;
}

async function onCalendarDateClick(dateStr) {
  try {
    const note = await vaultFetch(`/notes/daily?date=${dateStr}`);
    if (note?.id) {
      ensureEditor();
      await loadNote(note.id);
      // Update calendar active state
      document.querySelectorAll('.vault-calendar-day.active').forEach(el => el.classList.remove('active'));
      document.querySelector(`.vault-calendar-day[data-date="${dateStr}"]`)?.classList.add('active');
      // Add dot if new
      if (!dailyNoteDates.has(dateStr)) {
        dailyNoteDates.add(dateStr);
        document.querySelector(`.vault-calendar-day[data-date="${dateStr}"]`)?.classList.add('has-note');
      }
    }
  } catch (err) {
    console.error('Failed to open daily note:', err);
  }
}

function navigateCalendarMonth(delta) {
  calendarMonth += delta;
  if (calendarMonth < 0) { calendarMonth = 11; calendarYear--; }
  if (calendarMonth > 11) { calendarMonth = 0; calendarYear++; }
  renderDailyView();
}

// ============================================================
// Import / Export
// ============================================================

function showImportModal() {
  const overlay = document.createElement('div');
  overlay.className = 'task-input-overlay';
  overlay.innerHTML = `
    <div class="task-input-modal" style="width: 380px;">
      <div class="task-input-title">Import Notes</div>
      <p style="color: var(--color-text-muted); font-size: var(--font-xs); margin: 0 0 16px;">
        Select a folder to import. Subfolder structure, tags, and wikilinks will be preserved.
      </p>
      <div style="display: flex; flex-direction: column; gap: 8px;">
        <button class="vault-import-option" data-type="obsidian">
          <strong>Import Obsidian Vault</strong>
          <span style="color: var(--color-text-muted); font-size: var(--font-xs);">YAML frontmatter, aliases, folder structure</span>
        </button>
        <button class="vault-import-option" data-type="markdown">
          <strong>Import Markdown Folder</strong>
          <span style="color: var(--color-text-muted); font-size: var(--font-xs);">Any folder of .md files</span>
        </button>
      </div>
      <div class="task-input-buttons" style="margin-top: 16px;">
        <button class="task-input-btn cancel">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const closeModal = () => overlay.remove();
  overlay.querySelector('.cancel').addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  overlay.querySelectorAll('.vault-import-option').forEach(btn => {
    btn.addEventListener('click', async () => {
      const type = btn.dataset.type;
      const result = await window.os8.files.pickDirectory();
      if (result.canceled) return;
      closeModal();
      startImport(type, result.path);
    });
  });
}

let importPollInterval = null;

async function startImport(type, dirPath) {
  try {
    const p = await getPort();
    const endpoint = type === 'obsidian' ? '/import/obsidian' : '/import/markdown';
    await vaultFetch(endpoint, { method: 'POST', body: { path: dirPath } });
    showImportProgress();
  } catch (e) {
    showVaultToast(`Import failed: ${e.message}`, 'error');
  }
}

function showImportProgress() {
  // Create non-blocking inline banner at top of editor area
  let banner = elements.vaultEditorArea.querySelector('.vault-import-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'vault-import-banner';
    elements.vaultEditorArea.prepend(banner);
  }

  banner.innerHTML = `
    <div class="vault-import-banner-content">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
      </svg>
      <span class="vault-import-phase">Scanning files...</span>
      <span class="vault-import-detail"></span>
    </div>
    <div class="vault-import-progress"><div class="vault-import-progress-bar" style="width: 0%"></div></div>
  `;

  // Poll for status
  if (importPollInterval) clearInterval(importPollInterval);
  importPollInterval = setInterval(async () => {
    try {
      const status = await vaultFetch('/import/status');
      updateImportProgress(status);

      if (!status.isImporting) {
        clearInterval(importPollInterval);
        importPollInterval = null;
        // Show result briefly, then remove banner
        setTimeout(() => {
          const el = elements.vaultEditorArea.querySelector('.vault-import-banner');
          if (el) el.remove();
          // Refresh data
          Promise.all([loadNotes(), loadFolders(), loadTags()]).then(() => {
            renderNav();
            if (notesList.length > 0 && !currentNoteId) loadNote(notesList[0].id);
          });
        }, 2500);
      }
    } catch {
      clearInterval(importPollInterval);
      importPollInterval = null;
    }
  }, 2000);
}

function updateImportProgress(status) {
  const banner = elements.vaultEditorArea.querySelector('.vault-import-banner');
  if (!banner) return;

  const phaseEl = banner.querySelector('.vault-import-phase');
  const barEl = banner.querySelector('.vault-import-progress-bar');
  const detailEl = banner.querySelector('.vault-import-detail');

  const phaseLabels = {
    scanning: 'Scanning files...',
    importing: 'Importing notes...',
    linking: 'Resolving wikilinks...',
    embedding: 'Generating embeddings...',
    done: 'Import complete!',
    error: 'Import failed',
  };

  if (phaseEl) phaseEl.textContent = phaseLabels[status.phase] || status.phase || '';

  const pct = status.total > 0 ? Math.round((status.processed / status.total) * 100) : 0;
  if (barEl) barEl.style.width = `${pct}%`;

  if (detailEl) {
    if (status.phase === 'done' && status.result) {
      const r = status.result;
      detailEl.innerHTML = `<strong>${r.imported}</strong> notes imported` +
        (r.errors?.length ? ` &middot; <span style="color: var(--color-danger)">${r.errors.length} errors</span>` : '') +
        (r.warnings?.length ? ` &middot; ${r.warnings.length} warnings` : '');
    } else if (status.phase === 'error') {
      detailEl.innerHTML = `<span style="color: var(--color-danger)">${status.result?.error || 'Unknown error'}</span>`;
    } else if (status.currentFile) {
      detailEl.textContent = status.currentFile;
    } else {
      detailEl.textContent = status.total > 0 ? `${status.processed} / ${status.total}` : '';
    }
  }
}

function showExportModal() {
  const p = port;
  if (!p) { getPort().then(() => showExportModal()); return; }

  // If a folder is active, offer folder export too
  const hasFolderOption = activeFolderId && sidebarSection === 'folders';

  const overlay = document.createElement('div');
  overlay.className = 'task-input-overlay';
  overlay.innerHTML = `
    <div class="task-input-modal" style="width: 340px;">
      <div class="task-input-title">Export Vault</div>
      <p style="color: var(--color-text-muted); font-size: var(--font-xs); margin: 0 0 16px;">
        Download your notes as a ZIP of Markdown files with YAML frontmatter.
      </p>
      <div style="display: flex; flex-direction: column; gap: 8px;">
        <button class="vault-import-option" data-action="all">
          <strong>Export All Notes</strong>
        </button>
        ${hasFolderOption ? `
        <button class="vault-import-option" data-action="folder">
          <strong>Export Current Folder</strong>
        </button>` : ''}
      </div>
      <div class="task-input-buttons" style="margin-top: 16px;">
        <button class="task-input-btn cancel">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const closeModal = () => overlay.remove();
  overlay.querySelector('.cancel').addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  overlay.querySelectorAll('.vault-import-option').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      const url = action === 'folder'
        ? `http://localhost:${p}/api/vault/export/${activeFolderId}`
        : `http://localhost:${p}/api/vault/export`;
      window.open(url, '_blank');
      closeModal();
    });
  });
}

function showVaultToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `vault-toast ${type}`;
  toast.textContent = message;
  const panel = elements.vaultPanel || elements.vaultView;
  if (panel) {
    panel.style.position = 'relative';
    panel.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }
}

// ============================================================
// Keyboard shortcuts
// ============================================================

function isVaultActive() {
  return elements.vaultView?.classList.contains('active');
}

function handleVaultShortcuts(e) {
  if (!isVaultActive()) return;

  const isMeta = e.metaKey || e.ctrlKey;

  // Escape: close modals, exit version view, clear search
  if (e.key === 'Escape') {
    if (viewingVersion) { exitVersionView(); e.preventDefault(); return; }
    if (searchResults) {
      searchResults = null;
      if (elements.vaultSearchInput) elements.vaultSearchInput.value = '';
      renderNoteList();
      e.preventDefault();
      return;
    }
  }

  // Don't intercept when typing in an input (except for specific shortcuts)
  const tag = document.activeElement?.tagName;
  const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.closest('.cm-editor');

  if (isMeta && e.key === 'n' && !e.shiftKey) {
    e.preventDefault();
    showTemplatePicker();
    return;
  }

  if (isMeta && e.shiftKey && e.key === 'F') {
    e.preventDefault();
    elements.vaultSearchInput?.focus();
    return;
  }

  if (isMeta && e.key === 'd' && !e.shiftKey) {
    e.preventDefault();
    sidebarSection = 'daily';
    renderNav();
    loadNotes();
    return;
  }

  if (isMeta && e.key === '\\' && !e.shiftKey) {
    e.preventDefault();
    toggleSidebar();
    return;
  }

  if (isMeta && e.shiftKey && e.key === '|') { // Cmd+Shift+Backslash
    e.preventDefault();
    toggleInspector();
    return;
  }

  // ? key when not in input — show shortcut help
  if (e.key === '?' && !isInput) {
    e.preventDefault();
    showShortcutHelp();
    return;
  }
}

function showShortcutHelp() {
  const shortcuts = [
    ['Cmd+N', 'New note'],
    ['Cmd+Shift+F', 'Search'],
    ['Cmd+D', "Today's daily note"],
    ['Cmd+S', 'Save note'],
    ['Cmd+\\', 'Toggle sidebar'],
    ['Cmd+Shift+\\', 'Toggle inspector'],
    ['Escape', 'Close / clear search'],
    ['?', 'Show this help'],
  ];

  const overlay = document.createElement('div');
  overlay.className = 'task-input-overlay';
  overlay.innerHTML = `
    <div class="task-input-modal" style="width: 320px;">
      <div class="task-input-title">Keyboard Shortcuts</div>
      <div class="vault-shortcut-list">
        ${shortcuts.map(([key, desc]) => `
          <div class="vault-shortcut-row">
            <span class="vault-shortcut-desc">${desc}</span>
            <kbd class="vault-shortcut-key">${key}</kbd>
          </div>
        `).join('')}
      </div>
      <div class="task-input-buttons" style="margin-top: 12px;">
        <button class="task-input-btn cancel">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const closeModal = () => overlay.remove();
  overlay.querySelector('.cancel').addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
}

// ============================================================
// Public API
// ============================================================

/**
 * Initialize vault panel — wire event handlers.
 * Called once from main.js on app boot.
 */
export function initVault() {
  if (initialized) return;
  initialized = true;

  // New note button
  elements.vaultNewNoteBtn?.addEventListener('click', () => showTemplatePicker());
  elements.vaultEmptyCreateBtn?.addEventListener('click', () => showTemplatePicker());

  // Import/Export buttons
  elements.vaultImportBtn?.addEventListener('click', () => showImportModal());
  elements.vaultExportBtn?.addEventListener('click', () => showExportModal());

  // Keyboard shortcuts
  document.addEventListener('keydown', handleVaultShortcuts);

  // Sidebar/inspector toggles
  elements.vaultToggleSidebar?.addEventListener('click', toggleSidebar);
  elements.vaultToggleInspector?.addEventListener('click', toggleInspector);

  // Delete
  elements.vaultDeleteNoteBtn?.addEventListener('click', deleteCurrentNote);

  // Pin
  elements.vaultPinNoteBtn?.addEventListener('click', togglePinNote);

  // Title input
  elements.vaultTitleInput?.addEventListener('input', onTitleChange);
  elements.vaultTitleInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      focusEditor();
    }
  });

  // Search
  elements.vaultSearchInput?.addEventListener('input', onSearchInput);

  // Search mode toggle
  elements.vaultSearchMode?.querySelectorAll('.vault-search-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      searchMode = btn.dataset.mode;
      elements.vaultSearchMode.querySelectorAll('.vault-search-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const query = elements.vaultSearchInput?.value?.trim();
      if (query) onSearchInput();
    });
  });
}

/**
 * Ensure the CM6 editor exists, creating it if necessary.
 */
function ensureEditor() {
  // Check if editor container has a CM editor already
  if (elements.vaultEditorBody.querySelector('.cm-editor')) return;
  createEditor(elements.vaultEditorBody, {
    content: '',
    onChange: onEditorChange,
    onSave: onEditorSave,
  });
}

/**
 * Show the vault panel — called when vault tab becomes active.
 * Loads data and mounts the editor if needed.
 */
export async function showVaultPanel() {
  // Load sidebar data
  await Promise.all([loadNotes(), loadFolders(), loadTags(), loadScopes(), loadTemplates()]);
  renderNav();

  // Always ensure editor exists first
  ensureEditor();

  // Mount editor if we have a current note
  if (currentNoteId && currentNote) {
    elements.vaultEditorHeader.style.display = '';
    elements.vaultEmptyState.style.display = 'none';
    elements.vaultEditorBody.style.display = '';

    setContent(currentNote.content || '');
    elements.vaultTitleInput.value = currentNote.title || '';
    updatePinButton();
    updateSaveIndicator();
    renderInspector(currentNote);
  } else if (notesList.length > 0) {
    // If there are notes but none selected, select the first one
    await loadNote(notesList[0].id);
  } else {
    showEmptyState();
  }
}

/**
 * Open the vault tab — creates it if it doesn't exist.
 * Called from the home screen vault button.
 */
export async function openVaultTab() {
  await createVaultTab();
}

/**
 * Clean up vault panel resources.
 * Called when vault tab is closed.
 */
export function cleanupVault() {
  // Save any pending changes
  if (isDirty && currentNoteId) {
    saveCurrentNote();
  }
  clearTimeout(saveTimeout);
  clearTimeout(searchTimeout);

  // Stop index polling
  if (indexPollInterval) {
    clearInterval(indexPollInterval);
    indexPollInterval = null;
  }

  // Destroy editor and graph
  destroyEditor();
  destroyGraph();
  if (viewingVersion) exitVersionView();
  graphMode = false;

  // Remove graph container
  const graphContainer = elements.vaultEditorArea?.querySelector('.vault-graph-container');
  if (graphContainer) graphContainer.remove();

  // Reset state
  currentNoteId = null;
  currentNote = null;
  isDirty = false;
  viewingVersion = false;
  if (elements.vaultTitleInput) elements.vaultTitleInput.disabled = false;

  // Reset UI
  showEmptyState();
}
