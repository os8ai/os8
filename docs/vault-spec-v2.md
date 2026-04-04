# Vault — OS8 Knowledge Layer

**Revised Specification**
**Date:** April 2, 2026
**Status:** Ready for review

---

## 1. Vision

Vault is the knowledge layer of OS8. It makes agents aware of what the user knows — both what they've written and what's already on their computer.

Vault has two sides:

- **Write side:** A personal knowledge base where users create, organize, and link notes. Markdown-native, with bidirectional links, tags, and folders.
- **Read side:** A filesystem index that understands the user's existing files — documents, PDFs, images, code — without duplicating them. Files stay where they are. Vault stores extracted text, chunks, and embeddings as a searchable overlay.

Both sides feed into the same retrieval surface. When an agent needs to know something, it searches one unified index that spans user-authored notes and indexed files alike.

Vault is a platform feature, not an app. It lives in the OS8 shell as a first-class panel. Every agent can read from it. Every app can write to it.

---

## 2. Core Concepts

| Concept | Description |
|---------|-------------|
| **Note** | A Markdown document with metadata. User-authored knowledge. Stored in SQLite. |
| **Source** | A pointer to a file on disk. Vault indexes it but never copies it. |
| **Folder** | Hierarchical container for notes. |
| **Tag** | Flat label applied to notes. Many-to-many. |
| **Link** | Bidirectional connection between two notes. Typed (reference, contradiction, builds-on, related). |
| **Scope** | A directory the user has opted into indexing. Vault only indexes scoped directories. |
| **Extraction** | Text content pulled from a source file (PDF text, OCR, transcription). Stored in SQLite. |
| **Chunk** | A ~300-500 token segment of a note or extraction, used for granular embedding and retrieval. |
| **Embedding** | Vector representation of a chunk, stored for semantic search. Uses the existing `all-MiniLM-L6-v2` pipeline. |
| **Version** | Immutable snapshot of a note's content. Auto-created on save. |
| **Daily Note** | Auto-created note for today's date. Quick capture entry point. |

---

## 3. Architecture

### 3.1 Where Vault Lives

Vault is a **shell-native panel**, not an app or BrowserView.

| Layer | File | Purpose |
|-------|------|---------|
| Service | `src/services/vault.js` | Notes CRUD, search, embedding orchestration |
| Service | `src/services/vault-indexer.js` | Filesystem scanning, text extraction, change detection |
| Routes | `src/routes/vault.js` | HTTP API for notes, search, agent integration |
| Renderer | `src/renderer/vault.js` | Shell panel UI |
| Renderer | `src/renderer/vault-editor.js` | CodeMirror 6 Markdown editor |
| DB | `src/db.js` | Schema additions to `os8.db` |

### 3.2 Integration with Existing Systems

**Embeddings:** Vault uses the existing embedding infrastructure in `src/assistant/memory-embeddings.js` — same model (`all-MiniLM-L6-v2`, 384 dimensions), same chunking utilities, same cosine similarity search. No parallel pipeline.

**Agent retrieval:** Vault chunks participate in the existing Tier 4 semantic search in `src/assistant/memory.js`. They appear alongside conversation memory and principle nodes in `searchHybrid()`, with a category boost (1.3x) so they surface when relevant. The subconscious service curates what makes it into agent context — no separate ambient injection pass, no fixed token budget for Vault.

**Active search:** Agents also get an explicit `vault_search` tool for on-demand deep retrieval with filters. This is the one new retrieval path.

**Blob storage:** Vault notes with pasted/uploaded images use the existing OS8 blob storage (`~/os8/blob/vault/`). Indexed filesystem files are never copied — Vault stores only extracted text and embeddings.

---

## 4. Data Model

### 4.1 SQL Schema

```sql
-- ============================================================
-- NOTES (user-authored knowledge)
-- ============================================================

CREATE TABLE vault_folders (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES vault_folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  icon TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE vault_notes (
  id TEXT PRIMARY KEY,
  folder_id TEXT REFERENCES vault_folders(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  content_plain TEXT,
  is_daily INTEGER DEFAULT 0,
  daily_date TEXT,
  is_pinned INTEGER DEFAULT 0,
  is_archived INTEGER DEFAULT 0,
  word_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE vault_tags (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  color TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE vault_note_tags (
  note_id TEXT NOT NULL REFERENCES vault_notes(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES vault_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (note_id, tag_id)
);

CREATE TABLE vault_links (
  id TEXT PRIMARY KEY,
  source_note_id TEXT NOT NULL REFERENCES vault_notes(id) ON DELETE CASCADE,
  target_note_id TEXT NOT NULL REFERENCES vault_notes(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL DEFAULT 'reference',
  context TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_note_id, target_note_id)
);

CREATE TABLE vault_versions (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES vault_notes(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- FTS5 for full-text search on notes
CREATE VIRTUAL TABLE vault_notes_fts USING fts5(
  title, content_plain,
  content='vault_notes', content_rowid='rowid'
);

-- ============================================================
-- FILESYSTEM INDEX (read-only overlay on existing files)
-- ============================================================

CREATE TABLE vault_scopes (
  id TEXT PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,          -- absolute directory path
  label TEXT,                         -- user-friendly name
  recursive INTEGER DEFAULT 1,       -- index subdirectories
  enabled INTEGER DEFAULT 1,
  file_extensions TEXT,               -- JSON array of extensions to include, null = all supported
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE vault_sources (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL REFERENCES vault_scopes(id) ON DELETE CASCADE,
  file_path TEXT UNIQUE NOT NULL,     -- absolute path to the original file
  filename TEXT NOT NULL,
  file_extension TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER NOT NULL,
  content_hash TEXT NOT NULL,         -- SHA-256 of file content (for change detection)
  file_modified_at TEXT NOT NULL,     -- filesystem mtime
  extraction_status TEXT NOT NULL DEFAULT 'pending',  -- pending, extracted, failed, skipped
  extracted_text TEXT,                -- pulled text content (PDF text, OCR, etc.)
  extracted_word_count INTEGER DEFAULT 0,
  thumbnail_path TEXT,                -- blob path to generated thumbnail (images only)
  is_stale INTEGER DEFAULT 0,        -- 1 if file no longer exists at path
  indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- SHARED: Chunks and embeddings (used by both notes and sources)
-- ============================================================

CREATE TABLE vault_chunks (
  id TEXT PRIMARY KEY,
  note_id TEXT REFERENCES vault_notes(id) ON DELETE CASCADE,
  source_id TEXT REFERENCES vault_sources(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  token_count INTEGER,
  embedding BLOB,                     -- float32 array, 384 dimensions
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (note_id IS NOT NULL AND source_id IS NULL) OR
    (note_id IS NULL AND source_id IS NOT NULL)
  )
);

-- ============================================================
-- AGENT INTEGRATION
-- ============================================================

CREATE TABLE vault_agent_reads (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  note_id TEXT REFERENCES vault_notes(id) ON DELETE CASCADE,
  source_id TEXT REFERENCES vault_sources(id) ON DELETE CASCADE,
  chunk_id TEXT REFERENCES vault_chunks(id) ON DELETE CASCADE,
  conversation_id TEXT,
  relevance_score REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- NOTE TEMPLATES
-- ============================================================

CREATE TABLE vault_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX idx_vault_notes_folder ON vault_notes(folder_id);
CREATE INDEX idx_vault_notes_daily ON vault_notes(is_daily, daily_date);
CREATE INDEX idx_vault_notes_updated ON vault_notes(updated_at);
CREATE INDEX idx_vault_notes_slug ON vault_notes(slug);
CREATE INDEX idx_vault_note_tags_note ON vault_note_tags(note_id);
CREATE INDEX idx_vault_note_tags_tag ON vault_note_tags(tag_id);
CREATE INDEX idx_vault_links_source ON vault_links(source_note_id);
CREATE INDEX idx_vault_links_target ON vault_links(target_note_id);
CREATE INDEX idx_vault_versions_note ON vault_versions(note_id);
CREATE INDEX idx_vault_sources_scope ON vault_sources(scope_id);
CREATE INDEX idx_vault_sources_path ON vault_sources(file_path);
CREATE INDEX idx_vault_sources_hash ON vault_sources(content_hash);
CREATE INDEX idx_vault_sources_stale ON vault_sources(is_stale);
CREATE INDEX idx_vault_chunks_note ON vault_chunks(note_id);
CREATE INDEX idx_vault_chunks_source ON vault_chunks(source_id);
CREATE INDEX idx_vault_agent_reads_agent ON vault_agent_reads(agent_id);
```

### 4.2 Blob Storage

Vault's blob storage is minimal — only for content that originates in Vault and has no other home:

```
~/os8/blob/vault/
  /images/
    {note_id}/{filename}              -- images pasted/uploaded into notes
  /thumbnails/
    {source_id}-thumb.webp            -- thumbnails for indexed image files
```

Original files on disk are **never** copied into blob storage. Vault references them by path.

---

## 5. Filesystem Indexing

### 5.1 Scopes

Users explicitly choose which directories Vault indexes. No automatic whole-disk scanning.

**Default suggestions on first use:**
- `~/Documents`
- `~/Desktop`
- `~/Downloads`

Users can add or remove scopes at any time. Each scope can be toggled on/off, set to recursive or flat, and filtered by file extension.

### 5.2 Supported File Types

| Category | Extensions | Extraction Method |
|----------|-----------|-------------------|
| Text | `.md`, `.txt`, `.rtf` | Direct read |
| Documents | `.pdf` | pdf-parse / MarkItDown |
| Office | `.docx`, `.xlsx`, `.pptx` | MarkItDown |
| Code | `.js`, `.py`, `.ts`, `.go`, `.rs`, `.java`, `.c`, `.cpp`, `.rb`, `.sh`, `.css`, `.html`, `.json`, `.yaml`, `.toml` | Direct read (indexed as text, not chunked by function — simple and sufficient) |
| Images | `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.svg` | Metadata + optional OCR (Apple Vision on macOS). Thumbnail generated. |

**Not indexed:** Videos, audio, binaries, archives, node_modules, `.git`, build artifacts, caches. These are excluded by default via an ignore list similar to `.gitignore` patterns.

### 5.3 Indexing Pipeline

**Initial scan (on scope add):**
1. Walk directory tree, respecting scope settings and ignore patterns
2. For each supported file: record path, size, mtime, compute content hash
3. Queue for extraction (background, throttled to avoid pegging CPU)

**Extraction (async, per file):**
1. Read file → extract text based on type
2. Store extracted text in `vault_sources.extracted_text`
3. Chunk extracted text (~300-500 tokens, paragraph/heading boundaries)
4. Generate embedding per chunk via existing `memory-embeddings.js` pipeline
5. Store chunks + embeddings in `vault_chunks`

**Change detection (on app launch + periodic):**
1. For each scope, walk directory tree
2. Compare file mtime + content hash against stored values
3. New files → queue for indexing
4. Changed files → re-extract, re-chunk, re-embed
5. Missing files → mark `is_stale = 1` (don't delete — user may have moved to external drive)

**Performance:** Indexing runs in the background with low priority. Initial scan of a large directory may take minutes. Incremental updates are fast (only changed files). The UI shows indexing progress.

### 5.4 Default Ignore Patterns

```
node_modules/
.git/
.svn/
__pycache__/
*.pyc
.DS_Store
Thumbs.db
build/
dist/
.next/
.cache/
*.min.js
*.min.css
*.map
*.lock
package-lock.json
yarn.lock
*.sqlite
*.db
*.wasm
*.dylib
*.so
*.o
```

---

## 6. Notes

### 6.1 On Note Save

1. Strip Markdown to plain text → store in `content_plain`, update FTS5 index
2. Compute `word_count`
3. Parse `[[wikilinks]]` → upsert into `vault_links`
4. Parse `#tags` in body → upsert into `vault_note_tags`
5. If content changed from last version → create new version snapshot (max 50 per note)
6. Re-chunk and re-embed (async, using existing embedding pipeline)

### 6.2 Daily Notes

Auto-created note for today's date. One per day. Title format: `YYYY-MM-DD`. Created on demand when the user opens the daily notes view or via API. Configurable template (default: `# {{date}}\n\n`).

### 6.3 Note Templates

User-defined templates for structured notes (meeting notes, project briefs, decision logs). Stored in `vault_templates`. Available from the "new note" menu.

### 6.4 Wikilinks

`[[Note Title]]` syntax creates bidirectional links. On save, the parser:
1. Finds all `[[...]]` patterns
2. Resolves each to an existing note by title (case-insensitive)
3. Creates a `vault_links` entry for each resolved link
4. Unresolved links are displayed differently in the editor (dimmed, clickable to create)

---

## 7. API Surface

All endpoints prefixed with `/api/vault`.

### 7.1 Notes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/notes` | List notes. Params: `folder_id`, `tag`, `search`, `is_daily`, `is_archived`, `is_pinned`, `sort`, `order`, `limit`, `offset` |
| `GET` | `/notes/:id` | Get note with tags, links, attachments |
| `POST` | `/notes` | Create note. Body: `{ title, content, folder_id?, tags?, template_id? }` |
| `PATCH` | `/notes/:id` | Update note. Body: `{ title?, content?, folder_id?, is_pinned?, is_archived? }` |
| `DELETE` | `/notes/:id` | Archive (soft-delete), or hard-delete with `?hard=true` |
| `GET` | `/notes/:id/versions` | List version history |
| `POST` | `/notes/:id/restore/:versionId` | Restore to a previous version (creates new version) |
| `GET` | `/notes/:id/backlinks` | Notes that link TO this note |
| `GET` | `/notes/daily` | Get or create today's daily note |
| `GET` | `/notes/daily/:date` | Get daily note for specific date |

### 7.2 Folders

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/folders` | List all folders as tree |
| `POST` | `/folders` | Create folder |
| `PATCH` | `/folders/:id` | Update folder |
| `DELETE` | `/folders/:id` | Delete folder (notes moved to root) |

### 7.3 Tags

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/tags` | List tags with note counts |
| `POST` | `/tags` | Create tag |
| `PATCH` | `/tags/:id` | Update tag |
| `DELETE` | `/tags/:id` | Delete tag (removed from notes, notes not deleted) |
| `POST` | `/notes/:id/tags` | Add tags to note |
| `DELETE` | `/notes/:id/tags/:tagId` | Remove tag from note |

### 7.4 Links

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/links` | Create link |
| `DELETE` | `/links/:id` | Delete link |
| `GET` | `/graph` | Full link graph: `{ nodes, edges }` |
| `GET` | `/graph/:noteId` | Local graph centered on note (configurable depth) |

### 7.5 Filesystem Index

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/scopes` | List indexed scopes with stats (file count, size, last scan) |
| `POST` | `/scopes` | Add scope. Body: `{ path, label?, recursive?, file_extensions? }` |
| `PATCH` | `/scopes/:id` | Update scope settings |
| `DELETE` | `/scopes/:id` | Remove scope (deletes index data, not files) |
| `POST` | `/scopes/:id/rescan` | Trigger rescan of a scope |
| `GET` | `/sources` | List indexed files. Params: `scope_id`, `extension`, `status`, `is_stale`, `search`, `limit`, `offset` |
| `GET` | `/sources/:id` | Get source metadata + extracted text |
| `DELETE` | `/sources/:id` | Remove from index (does not delete file) |
| `GET` | `/index/status` | Indexing progress (files queued, in progress, completed, failed) |

### 7.6 Search

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/search` | Hybrid search across notes AND sources. Params: `q`, `mode` (keyword, semantic, hybrid), `tags`, `folders`, `scopes`, `type` (note, source, daily), `date_from`, `date_to`, `limit`, `offset` |

Single search endpoint. Hybrid mode (default) merges FTS5 keyword results with semantic embedding results using weighted scoring (`0.4 * keyword + 0.6 * semantic`). Results include both user-authored notes and indexed files, distinguished by type.

### 7.7 Agent Integration

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/agent/search` | Active lookup. Body: `{ query, agent_id, mode?, limit?, min_relevance?, tags?, folders?, scopes? }`. Full search with filters. Used by agents via the `vault_search` tool. |
| `GET` | `/agent/reads/:agentId` | Audit log: what has this agent accessed? |
| `POST` | `/agent/inject` | Agent writes a note. Body: `{ title, content, folder_id?, tags?, agent_id }`. Auto-tagged with `agent:{name}`. |

Note: There is no separate ambient query endpoint. Vault chunks participate in the existing memory pipeline's semantic search (Tier 4). The subconscious service handles relevance curation.

### 7.8 Templates

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/templates` | List templates |
| `POST` | `/templates` | Create template |
| `PATCH` | `/templates/:id` | Update template |
| `DELETE` | `/templates/:id` | Delete template |

### 7.9 Import / Export

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/import/markdown` | Import folder of `.md` files. Preserves `[[wikilinks]]` and `#tags`. |
| `POST` | `/import/obsidian` | Import Obsidian vault (frontmatter, links, tags, folder structure) |
| `GET` | `/export` | Export vault as ZIP (Markdown + blob attachments + manifest) |
| `GET` | `/export/:folderId` | Export single folder |

---

## 8. Agent Integration

### 8.1 Passive Retrieval (Via Existing Memory Pipeline)

Vault chunks are indexed alongside conversation memory in the existing semantic search. When an agent processes a message:

1. `memory.js` runs Tier 4 semantic search as usual
2. Vault chunks are included in the search corpus
3. Vault results get a category boost (1.3x) so they surface when relevant
4. The subconscious service curates what appears in agent context — it decides whether a Vault chunk, a conversation memory, or a principle node is most relevant for this turn

This means: agents passively benefit from Vault content with zero new retrieval infrastructure. The subconscious handles the "is this worth including" decision, weighing Vault against all other memory sources.

### 8.2 Active Lookup (vault_search Tool)

Agents have an explicit tool for deeper retrieval:

```
Tool: vault_search
Parameters:
  query: string         -- natural language or keyword query
  mode: "semantic" | "keyword" | "hybrid"  (default: "hybrid")
  limit: number         (default: 10)
  min_relevance: number (default: 0.65)
  tags: string[]        -- filter by tags (notes only)
  folders: string[]     -- filter by folders (notes only)
  scopes: string[]      -- filter by index scopes (sources only)
```

Returns ranked results with source metadata (title/filename, folder/path, tags, date, content excerpt).

**When agents should use this:**
- User asks about something not in current context
- User says "check my notes" / "what did I write about X" / "find that document about Y"
- Agent is generating content that should reference the user's own knowledge

**Transparency:** Agents cite their sources — *"Based on your note 'Project Brief' from March..."* or *"I found a PDF in your Documents folder about this..."*

### 8.3 Agent Write-Back

Agents write to Vault via `POST /api/vault/agent/inject` when:
- The user asks them to save something
- The agent produces a summary, decision log, or research output worth persisting

Agent-created notes are auto-tagged `agent:{agent_name}`. This keeps them visible and filterable.

### 8.4 Agent-Scoped Relevance

Agents can have preferred folders, tags, or scopes that boost retrieval relevance for their domain. A coding agent gets boosted results from code-heavy scopes; a research agent gets boosted results from document folders. This is a lightweight preference, not hard filtering — implemented as additional category boosts in the semantic search.

---

## 9. Search Architecture

### 9.1 Full-Text Search

SQLite FTS5 on `vault_notes_fts`. Indexed columns: `title`, `content_plain`. Supports boolean operators, phrase search, prefix matching, column weighting (title > body), and snippet extraction.

For indexed files, FTS5 searches `vault_sources.extracted_text`.

### 9.2 Semantic Search

Uses the existing embedding pipeline:
1. Embed query using `memory-embeddings.js`
2. Cosine similarity against all `vault_chunks` embeddings
3. Return top-N above threshold
4. Group by note/source, return best chunk as excerpt

### 9.3 Hybrid Search (Default)

1. FTS5 keyword matches → score set A
2. Semantic search → score set B
3. Weighted merge: `0.4 * keyword + 0.6 * semantic`
4. Deduplicate by note/source
5. Return merged, ranked results

---

## 10. UI

### 10.1 Shell Integration

Vault is a tab type in the OS8 shell, like apps and agent chat. Opening Vault creates a tab that takes the main content area. The panel uses OS8's vanilla CSS and design system — no React, no Tailwind.

### 10.2 Layout

```
+-----------------------------------------------------------+
|  [Sidebar]        [Editor / Content]        [Inspector]   |
|                                                           |
|  Search [______]  +-------------------------+  Backlinks  |
|                   |                         |  - Note A   |
|  > Daily Notes    |  # Meeting Notes        |  - Note B   |
|  > Folders        |                         |             |
|    > Work         |  Discussed the vault    |  Tags       |
|    > Personal     |  architecture with...   |  [#design]  |
|  > Tags           |                         |  [#os8]     |
|  > Recent         |  ## Decisions           |             |
|  > Pinned         |  - Reference model...   |  Versions   |
|  > Graph          |                         |  v3 (now)   |
|  > Indexed Files  |                         |  v2 (1h ago)|
|                   |                         |  v1 (2h ago)|
|  Index Status     +-------------------------+             |
|  [====    ] 62%                                           |
+-----------------------------------------------------------+
```

Sidebar and inspector are collapsible. Editor takes remaining space.

### 10.3 Views

**Editor** — CodeMirror 6 with Markdown mode. Features:
- `[[wikilinks]]` with autocomplete from note titles
- `#tags` with autocomplete from existing tags
- Live preview toggle (edit / preview / split)
- Drag-and-drop image upload
- Clipboard image paste
- Code blocks with syntax highlighting
- Keyboard shortcuts for formatting

**Folder View** — Tree with drag-drop reordering, context menus, note counts.

**Tag View** — List with counts. Click to filter. Bulk operations (rename, merge, delete).

**Graph View** — D3.js force-directed graph of explicitly linked notes. Click to navigate. Zoom/pan. Local mode centered on a note with configurable depth (1-3 hops). Color by folder or tag.

**Daily Notes** — Calendar picker. Auto-creates note for selected date. Yesterday/tomorrow navigation.

**Search Results** — Unified results across notes and indexed files, with highlighted snippets. Type indicator (note vs. file). Filter by tags, folders, scopes, date.

**Indexed Files** — Browse indexed scopes. See extraction status, file types, stale files. Manage scopes (add, remove, rescan). This is the "read side" management view.

**Recent** — Chronological list of recently viewed/edited notes.

**Pinned** — Quick access to pinned notes.

### 10.4 Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+N` | New note |
| `Cmd+O` | Quick open (fuzzy search by title) |
| `Cmd+K` | Insert wikilink |
| `Cmd+Shift+F` | Search |
| `Cmd+D` | Today's daily note |
| `Cmd+S` | Save (creates version) |
| `Cmd+P` | Toggle preview |
| `Cmd+\` | Toggle sidebar |
| `Cmd+Shift+\` | Toggle inspector |
| `Cmd+Shift+G` | Graph view |
| `Cmd+[` / `Cmd+]` | Navigate back / forward |

Note: These shortcuts are scoped to the Vault panel — they only apply when Vault has focus. No conflict with shell shortcuts.

---

## 11. Configuration

Stored in OS8 settings:

```json
{
  "vault": {
    "chunk_size_tokens": 400,
    "chunk_overlap_tokens": 50,
    "auto_embed_on_save": true,
    "max_versions_per_note": 50,
    "daily_note_template": "# {{date}}\n\n",
    "default_folder": null,
    "graph_max_nodes": 500,
    "search_mode": "hybrid",
    "search_keyword_weight": 0.4,
    "search_semantic_weight": 0.6,
    "index_on_launch": true,
    "index_ignore_patterns": [
      "node_modules/", ".git/", "__pycache__/", "*.min.js",
      "*.lock", "*.sqlite", "*.db", "*.wasm", ".DS_Store"
    ],
    "ocr_enabled": true
  }
}
```

---

## 12. Performance Targets

| Metric | Target |
|--------|--------|
| Note open | < 100ms |
| Save + version | < 200ms |
| Full-text search (10k notes) | < 300ms |
| Semantic search (10k notes + 50k source chunks) | < 500ms |
| Graph render (1k nodes) | < 1s |
| Embedding generation (single note) | < 2s |
| Filesystem scan (10k files) | < 30s |
| Text extraction (single PDF) | < 5s |
| Incremental re-index (changed files only) | < 10s |

---

## 13. Security & Privacy

- All data local. No cloud sync. No external API calls except user-initiated actions.
- Indexed file paths are stored in SQLite — sensitive path names are visible in the database. Users should be aware when scoping directories.
- Agent access logged in `vault_agent_reads` for audit.
- Export always available. Notes export as standard Markdown with `[[wikilinks]]` preserved. No lock-in.
- Stale file references (moved/deleted files) are flagged, not silently removed — the user decides.

---

## 14. What's Explicitly Out of Scope

These may be added later but are not part of this build:

| Feature | Why deferred |
|---------|-------------|
| Web clipper | Better as a skill/capability. Agents can clip URLs via the existing skill system. |
| Auto-discovered connections | Semantic search already surfaces related content on demand. Precomputing pairwise similarity is O(n^2) with marginal benefit. |
| Video/audio transcription for indexing | Expensive and slow. The Whisper and Transcribe services exist — integration can come later. |
| Notion import, Apple Notes import, CSV import | Niche formats. Obsidian + Markdown covers most users. Others can be skills. |
| Watched folders (live filesystem monitoring) | File watchers are unreliable at scale. Periodic rescan on launch + manual rescan is sufficient. |
| Side-by-side version diffs | Version snapshots with one-click restore is enough. Diff rendering is UI luxury. |
| Saved/smart searches | Low usage feature. Can be added to the search UI later. |
| Multi-vault / vault sharing | Assuming single vault per OS8 instance. |

---

## 15. Open Questions

1. **CodeMirror 6 bundle size** — CM6 is modular. Need to measure the bundle with Markdown mode + autocomplete + keybindings to ensure it's reasonable for a shell panel (not loaded via Vite/Core). May need to serve it as a separate script.
2. **Embedding quantization** — At scale (50k+ chunks), float32 embeddings use ~75 MB. Int8 quantization halves this with minimal quality loss. Worth doing from the start?
3. **FTS5 on extracted text** — Should `vault_sources.extracted_text` get its own FTS5 virtual table, or share with notes? Separate tables allow different column weighting.
4. **OCR default** — Should Apple Vision OCR be opt-in or opt-out for indexed images? OCR adds extraction time but makes images searchable.
5. **Index size visibility** — Should the UI show how much disk space the Vault index is consuming? Helps users make informed scoping decisions.
