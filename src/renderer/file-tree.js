/**
 * File tree management for OS8
 */

import { elements } from './elements.js';
import { getCurrentApp, getShowHiddenFiles, getAgentScope } from './state.js';
import { attachFileTreeHandlers } from './helpers.js';
import { hideAllPreviews } from './preview.js';
import { loadDataStorage } from './data-storage.js';

// Files to hide by default in the file tree
export const HIDDEN_FILES = ['CLAUDE.md', 'GEMINI.md', 'tasks.json'];

// Track currently viewed file for refresh
let currentViewedFile = { path: null, name: null };

export function getFileIcon(name, type) {
  if (type === 'directory') {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
    </svg>`;
  }
  // File icon
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
    <polyline points="14,2 14,8 20,8"/>
  </svg>`;
}

export function getFileIconClass(name) {
  const ext = name.split('.').pop().toLowerCase();
  const extMap = {
    'md': 'file-md',
    'js': 'file-js',
    'jsx': 'file-js',
    'ts': 'file-js',
    'tsx': 'file-js',
    'html': 'file-html',
    'css': 'file-css',
    'scss': 'file-css',
    'json': 'file-json',
    // Image files
    'png': 'file-image',
    'jpg': 'file-image',
    'jpeg': 'file-image',
    'gif': 'file-image',
    'webp': 'file-image',
    'svg': 'file-image',
    'ico': 'file-image',
    'bmp': 'file-image',
  };
  return extMap[ext] || 'file';
}

export function renderFileTreeItem(item, depth = 0, collapsedByDefault = true) {
  if (item.type === 'directory') {
    const childrenHtml = item.children.map(child => renderFileTreeItem(child, depth + 1, collapsedByDefault)).join('');
    const collapsedClass = collapsedByDefault ? ' collapsed' : '';
    return `
      <div class="file-tree-folder${collapsedClass}" data-path="${item.path}">
        <div class="file-tree-item" style="padding-left: ${12 + depth * 16}px">
          <span class="file-tree-icon folder">
            <svg class="folder-arrow" width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
              <path d="M7 10l5 5 5-5z"/>
            </svg>
          </span>
          <span class="file-tree-icon folder">${getFileIcon(item.name, 'directory')}</span>
          <span class="file-tree-name">${item.name}</span>
        </div>
        <div class="file-tree-children">${childrenHtml}</div>
      </div>
    `;
  } else {
    return `
      <div class="file-tree-item" style="padding-left: ${12 + depth * 16}px" data-path="${item.path}" data-name="${item.name}">
        <span class="file-tree-icon ${getFileIconClass(item.name)}">${getFileIcon(item.name, 'file')}</span>
        <span class="file-tree-name">${item.name}</span>
      </div>
    `;
  }
}

export function filterHiddenFiles(items, showHiddenFiles, hiddenFilesList) {
  return items
    .filter(item => showHiddenFiles || !hiddenFilesList.includes(item.name))
    .map(item => {
      if (item.type === 'directory' && item.children) {
        return { ...item, children: filterHiddenFiles(item.children, showHiddenFiles, hiddenFilesList) };
      }
      return item;
    });
}

export async function loadFileTree() {
  if (!getCurrentApp()) return;

  // For system apps, pass agent scope to get agent-specific or app-level file tree
  const scope = getAgentScope();
  const agentId = (scope && scope !== 'system') ? scope : undefined;
  const tree = await window.os8.files.list(getCurrentApp().id, agentId);
  if (!tree || !tree.children) {
    elements.fileTree.innerHTML = '<div class="placeholder-text">No files found</div>';
    return;
  }

  const filteredChildren = filterHiddenFiles(tree.children, getShowHiddenFiles(), HIDDEN_FILES);
  elements.fileTree.innerHTML = filteredChildren.map(item => renderFileTreeItem(item)).join('');

  attachFileTreeHandlers(elements.fileTree, viewFile);
}

export async function viewFile(filePath, fileName) {
  // Hide preview (BrowserView sits on top)
  hideAllPreviews();

  // Track current file for refresh
  currentViewedFile = { path: filePath, name: fileName };

  elements.fileViewerName.textContent = fileName;
  elements.fileViewerModal.classList.add('active');
  elements.downloadFileViewer.style.display = '';

  // Reset content area
  elements.fileViewerContent.className = 'file-viewer-content';
  elements.fileViewerContent.innerHTML = '<div class="file-viewer-loading">Loading...</div>';

  const result = await window.os8.files.read(filePath);

  if (result.error) {
    // Error state (binary, too large, etc.)
    elements.fileViewerContent.innerHTML = `<pre><code>${result.error}</code></pre>`;
    elements.fileViewerContent.classList.add('text-view');
  } else if (result.type === 'image') {
    // Image preview
    elements.fileViewerContent.innerHTML = `<img src="${result.dataUrl}" alt="${fileName}">`;
    elements.fileViewerContent.classList.add('image-view');
  } else {
    // Text content
    elements.fileViewerContent.innerHTML = '<pre><code></code></pre>';
    elements.fileViewerContent.classList.add('text-view');
    elements.fileViewerContent.querySelector('code').textContent = result.content;
  }
}

export async function refreshViewedFile() {
  if (currentViewedFile.path && currentViewedFile.name) {
    await viewFile(currentViewedFile.path, currentViewedFile.name);
  }
}

export async function downloadViewedFile() {
  if (currentViewedFile.path) {
    await window.os8.files.download(currentViewedFile.path);
  }
}

export function switchStorageView(view) {
  elements.systemFilesView.classList.remove('active');
  elements.dataStorageView.classList.remove('active');
  elements.blobStorageView.classList.remove('active');

  if (view === 'system') {
    elements.systemFilesView.classList.add('active');
  } else if (view === 'data') {
    elements.dataStorageView.classList.add('active');
  } else if (view === 'blob') {
    elements.blobStorageView.classList.add('active');
  }
}

export async function loadStorageView() {
  if (!getCurrentApp()) return;

  const view = elements.storageSelect.value;

  if (view === 'system') {
    // Regenerate CLAUDE.md before showing file tree
    await window.os8.claude.generateMd(getCurrentApp().id);
    await loadFileTree();
  } else if (view === 'data') {
    // Load data storage (memory tables)
    await loadDataStorage();
  } else if (view === 'blob') {
    await loadBlobTree();
  }
}

export async function loadBlobTree() {
  if (!getCurrentApp()) return;

  // For system apps, pass agent scope
  const scope = getAgentScope();
  const agentId = (scope && scope !== 'system') ? scope : undefined;
  const tree = await window.os8.files.listBlob(getCurrentApp().id, agentId);
  if (!tree || !tree.children || tree.children.length === 0) {
    elements.blobTree.innerHTML = '<div class="blob-empty"><p>No files in blob storage</p></div>';
    return;
  }

  elements.blobTree.innerHTML = tree.children.map(item => renderFileTreeItem(item)).join('');

  // Add click handlers for folders
  elements.blobTree.querySelectorAll('.file-tree-folder > .file-tree-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      item.parentElement.classList.toggle('collapsed');
    });
  });

  // Add click handlers for files
  elements.blobTree.querySelectorAll('.file-tree-item[data-name]').forEach(item => {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const filePath = item.dataset.path;
      const fileName = item.dataset.name;
      await viewFile(filePath, fileName);
    });
  });
}
