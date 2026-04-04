/**
 * Vault Editor — CodeMirror 6 integration for Markdown editing.
 *
 * Uses the pre-built window.CodeMirror global from vendor/codemirror.js.
 * Provides a clean API for vault.js to mount, read, and control the editor.
 */

// Lazy-init: defer access to window.CodeMirror so a missing vendor bundle
// doesn't crash the module at import time and take down the entire renderer.
let _CM = null;
function getCM() {
  if (!_CM) {
    _CM = window.CodeMirror;
    if (!_CM) throw new Error('CodeMirror not loaded — vendor/codemirror.js may be missing');
  }
  return _CM;
}

let _readOnlyCompartment = null;
function getReadOnlyCompartment() {
  if (!_readOnlyCompartment) _readOnlyCompartment = new (getCM().Compartment)();
  return _readOnlyCompartment;
}

let editorView = null;
let onSaveCallback = null;
let onChangeCallback = null;

// Port cache for API calls
let _port = null;
async function getPort() {
  if (!_port) _port = await window.os8.server.getPort();
  return _port;
}

// ============================================================
// Known note titles cache (for wikilink decorations)
// ============================================================

let knownTitles = new Set();
let titlesRefreshTimer = null;

export async function refreshKnownTitles() {
  try {
    const p = await getPort();
    const res = await fetch(`http://localhost:${p}/api/vault/notes?limit=1000&is_archived=0`);
    const data = await res.json();
    knownTitles = new Set((data.notes || []).map(n => n.title.toLowerCase()));
    // Trigger decoration refresh if editor is active
    if (editorView) {
      editorView.dispatch({ effects: [] }); // trigger update cycle
    }
  } catch (e) {
    console.warn('[Vault] Failed to refresh known titles:', e.message);
  }
}

// ============================================================
// OS8 dark theme
// ============================================================

// Theme and highlighting are built lazily (getCM() defers until first use)
let _os8Theme = null;
function getOs8Theme() {
  if (!_os8Theme) _os8Theme = getCM().EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    color: '#e2e8f0',
    fontSize: '13px',
  },
  '.cm-content': {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    padding: '16px 24px',
    maxWidth: '720px',
    margin: '0 auto',
    caretColor: '#3b82f6',
    lineHeight: '1.7',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#3b82f6' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'rgba(59, 130, 246, 0.3)',
  },
  '.cm-gutters': { display: 'none' },
  '.cm-activeLine': { backgroundColor: 'rgba(255, 255, 255, 0.03)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    color: '#94a3b8',
    border: 'none',
  },
  '.cm-tooltip': {
    backgroundColor: '#1e293b',
    border: '1px solid #334155',
    color: '#e2e8f0',
  },
  '.cm-panels': {
    backgroundColor: '#1e293b',
    color: '#e2e8f0',
  },
  '.cm-panels.cm-panels-top': {
    borderBottom: '1px solid #334155',
  },
  '.cm-search label': {
    color: '#94a3b8',
  },
  '.cm-textfield': {
    backgroundColor: '#0f172a',
    border: '1px solid #334155',
    color: '#e2e8f0',
    borderRadius: '4px',
    fontSize: '12px',
  },
  '.cm-button': {
    backgroundColor: '#334155',
    color: '#e2e8f0',
    border: 'none',
    borderRadius: '4px',
  },
  // Autocomplete tooltip styling
  '.cm-tooltip-autocomplete': {
    backgroundColor: '#1e293b',
    border: '1px solid #334155',
    borderRadius: '6px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
  },
  '.cm-tooltip-autocomplete > ul': {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  '.cm-tooltip-autocomplete > ul > li': {
    padding: '4px 8px',
    color: '#e2e8f0',
    fontSize: '12px',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: '#334155',
    color: '#f8fafc',
  },
  '.cm-completionDetail': {
    color: '#64748b',
    fontSize: '11px',
    marginLeft: '8px',
  },
  // Wikilink decoration styling
  '.cm-wikilink-resolved': {
    color: '#60a5fa',
    borderBottom: '1px solid rgba(96, 165, 250, 0.3)',
  },
  '.cm-wikilink-unresolved': {
    color: '#64748b',
    borderBottom: '1px dashed #475569',
  },
  }, { dark: true });
  return _os8Theme;
}

let _markdownHighlighting = null;
function getMarkdownHighlighting() {
  if (!_markdownHighlighting) {
    const CM = getCM();
    _markdownHighlighting = CM.HighlightStyle.define([
      { tag: CM.tags.heading1, fontWeight: '700', fontSize: '1.5em', color: '#e2e8f0' },
      { tag: CM.tags.heading2, fontWeight: '600', fontSize: '1.3em', color: '#e2e8f0' },
      { tag: CM.tags.heading3, fontWeight: '600', fontSize: '1.15em', color: '#e2e8f0' },
      { tag: CM.tags.heading4, fontWeight: '600', color: '#e2e8f0' },
      { tag: CM.tags.strong, fontWeight: '600', color: '#f8fafc' },
      { tag: CM.tags.emphasis, fontStyle: 'italic', color: '#cbd5e1' },
      { tag: CM.tags.link, color: '#60a5fa', textDecoration: 'underline' },
      { tag: CM.tags.url, color: '#60a5fa' },
      { tag: CM.tags.monospace, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '0.9em',
        backgroundColor: 'rgba(255, 255, 255, 0.06)', borderRadius: '3px', padding: '1px 4px' },
      { tag: CM.tags.quote, color: '#94a3b8', fontStyle: 'italic' },
      { tag: CM.tags.strikethrough, textDecoration: 'line-through', color: '#64748b' },
      { tag: CM.tags.processingInstruction, color: '#64748b' }, // Markdown markup chars
      { tag: CM.tags.list, color: '#94a3b8' },
    ]);
  }
  return _markdownHighlighting;
}

// ============================================================
// Format helpers
// ============================================================

function wrapSelection(view, marker) {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);

  if (selected.startsWith(marker) && selected.endsWith(marker) && selected.length > marker.length * 2) {
    view.dispatch({
      changes: { from, to, insert: selected.slice(marker.length, -marker.length) }
    });
  } else if (from >= marker.length && to + marker.length <= view.state.doc.length) {
    const before = view.state.sliceDoc(from - marker.length, from);
    const after = view.state.sliceDoc(to, to + marker.length);
    if (before === marker && after === marker) {
      view.dispatch({
        changes: [
          { from: from - marker.length, to: from, insert: '' },
          { from: to, to: to + marker.length, insert: '' }
        ]
      });
      return true;
    }
    view.dispatch({
      changes: [
        { from, insert: marker },
        { from: to, insert: marker }
      ],
      selection: { anchor: from + marker.length, head: to + marker.length }
    });
  } else {
    view.dispatch({
      changes: [
        { from, insert: marker },
        { from: to, insert: marker }
      ],
      selection: { anchor: from + marker.length, head: to + marker.length }
    });
  }
  return true;
}

function toggleBold(view) { return wrapSelection(view, '**'); }
function toggleItalic(view) { return wrapSelection(view, '_'); }
function toggleStrikethrough(view) { return wrapSelection(view, '~~'); }
function toggleInlineCode(view) { return wrapSelection(view, '`'); }

// ============================================================
// Autocomplete: Wikilinks
// ============================================================

function wikilinkCompletion(context) {
  const match = context.matchBefore(/\[\[([^\]]*)$/);
  if (!match) return null;

  const query = match.text.slice(2); // strip [[
  const from = match.from;

  return fetchNoteSuggestions(query).then(notes => ({
    from,
    options: notes.map(n => ({
      label: `[[${n.title}]]`,
      apply: `[[${n.title}]]`,
      detail: n.updated_at ? formatRelDate(n.updated_at) : '',
    })),
    filter: false,
  }));
}

async function fetchNoteSuggestions(query) {
  try {
    const p = await getPort();
    const params = new URLSearchParams({ limit: '10', is_archived: '0' });
    if (query) params.set('search', query);
    const res = await fetch(`http://localhost:${p}/api/vault/notes?${params}`);
    const data = await res.json();
    return data.notes || data || [];
  } catch (e) {
    return [];
  }
}

function formatRelDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + (dateStr.includes('Z') ? '' : 'Z'));
  const diff = Date.now() - d;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ============================================================
// Autocomplete: Tags
// ============================================================

function tagCompletion(context) {
  const match = context.matchBefore(/(?:^|\s)#([a-zA-Z][a-zA-Z0-9_-]*)$/);
  if (!match) return null;

  const hashPos = match.text.lastIndexOf('#');
  const from = match.from + hashPos;
  const query = match.text.slice(hashPos + 1).toLowerCase();

  return fetchTagSuggestions(query).then(tags => ({
    from,
    options: tags.map(t => ({
      label: `#${t.name}`,
      apply: `#${t.name}`,
      detail: `${t.note_count || 0} notes`,
    })),
    filter: false,
  }));
}

async function fetchTagSuggestions(query) {
  try {
    const p = await getPort();
    const res = await fetch(`http://localhost:${p}/api/vault/tags`);
    const tags = await res.json();
    if (!query) return tags.slice(0, 10);
    return tags.filter(t => t.name.toLowerCase().includes(query)).slice(0, 10);
  } catch (e) {
    return [];
  }
}

// ============================================================
// Wikilink decorations (resolved vs unresolved)
// ============================================================

const wikilinkRegex = /\[\[([^\]]+)\]\]/g;

let _resolvedDeco = null;
let _unresolvedDeco = null;
function getResolvedDeco() {
  if (!_resolvedDeco) _resolvedDeco = getCM().Decoration.mark({ class: 'cm-wikilink-resolved' });
  return _resolvedDeco;
}
function getUnresolvedDeco() {
  if (!_unresolvedDeco) _unresolvedDeco = getCM().Decoration.mark({ class: 'cm-wikilink-unresolved' });
  return _unresolvedDeco;
}

function buildWikilinkDecos(view) {
  const builder = [];
  const { from, to } = view.viewport;
  const text = view.state.doc.sliceString(from, to);

  let m;
  wikilinkRegex.lastIndex = 0;
  while ((m = wikilinkRegex.exec(text)) !== null) {
    const start = from + m.index;
    const end = start + m[0].length;
    const title = m[1].trim().toLowerCase();
    const deco = knownTitles.has(title) ? getResolvedDeco() : getUnresolvedDeco();
    builder.push(deco.range(start, end));
  }

  return getCM().Decoration.set(builder, true);
}

let _wikilinkDecoPlugin = null;
function getWikilinkDecoPlugin() {
  if (!_wikilinkDecoPlugin) {
    _wikilinkDecoPlugin = getCM().ViewPlugin.fromClass(class {
      constructor(view) {
        this.decorations = buildWikilinkDecos(view);
      }
      update(update) {
        if (update.docChanged || update.viewportChanged || update.transactions.length) {
          this.decorations = buildWikilinkDecos(update.view);
        }
      }
    }, { decorations: v => v.decorations });
  }
  return _wikilinkDecoPlugin;
}

// ============================================================
// Build extensions
// ============================================================

function buildExtensions() {
  const CM = getCM();
  const vaultKeymap = CM.keymap.of([
    { key: 'Mod-s', run: () => { if (onSaveCallback) onSaveCallback(); return true; } },
    { key: 'Mod-b', run: toggleBold },
    { key: 'Mod-i', run: toggleItalic },
    { key: 'Mod-Shift-x', run: toggleStrikethrough },
    { key: 'Mod-e', run: toggleInlineCode },
  ]);

  return [
    CM.highlightSpecialChars(),
    CM.history(),
    CM.drawSelection(),
    CM.highlightActiveLine(),
    CM.EditorState.allowMultipleSelections.of(true),
    CM.indentOnInput(),
    CM.bracketMatching(),
    CM.highlightSelectionMatches(),
    CM.markdown({ base: CM.markdownLanguage }),
    CM.syntaxHighlighting(getMarkdownHighlighting()),
    getOs8Theme(),
    CM.keymap.of([
      ...CM.defaultKeymap,
      ...CM.historyKeymap,
      ...CM.searchKeymap,
      ...CM.completionKeymap,
      CM.indentWithTab,
    ]),
    vaultKeymap,
    CM.autocompletion({
      override: [wikilinkCompletion, tagCompletion],
      activateOnTyping: true,
      closeOnBlur: true,
    }),
    getWikilinkDecoPlugin(),
    CM.EditorView.updateListener.of(update => {
      if (update.docChanged && onChangeCallback) {
        onChangeCallback();
      }
    }),
    CM.placeholder('Start writing...'),
    CM.EditorView.lineWrapping,
    getReadOnlyCompartment().of(CM.EditorState.readOnly.of(false)),
  ];
}

/**
 * Create a CM6 editor in the given container element.
 */
export function createEditor(container, { content = '', onChange = () => {}, onSave = () => {} } = {}) {
  destroyEditor();

  onSaveCallback = onSave;
  onChangeCallback = onChange;

  const CM = getCM();
  editorView = new CM.EditorView({
    state: CM.EditorState.create({
      doc: content,
      extensions: buildExtensions(),
    }),
    parent: container,
  });

  // Initialize known titles for wikilink decorations
  refreshKnownTitles();

  return editorView;
}

/**
 * Replace editor content (e.g., when switching notes).
 */
export function setContent(content) {
  if (!editorView) return;
  editorView.dispatch({
    changes: { from: 0, to: editorView.state.doc.length, insert: content },
  });
}

/**
 * Get current editor content.
 */
export function getContent() {
  if (!editorView) return '';
  return editorView.state.doc.toString();
}

/**
 * Focus the editor.
 */
export function focusEditor() {
  if (editorView) editorView.focus();
}

/**
 * Destroy the editor (cleanup).
 */
export function destroyEditor() {
  if (editorView) {
    editorView.destroy();
    editorView = null;
  }
  onSaveCallback = null;
  onChangeCallback = null;
}

/**
 * Toggle editor read-only mode (used for version history viewing).
 */
export function setReadOnly(readOnly) {
  if (!editorView) return;
  editorView.dispatch({
    effects: getReadOnlyCompartment().reconfigure(
      getCM().EditorState.readOnly.of(readOnly)
    ),
  });
}
