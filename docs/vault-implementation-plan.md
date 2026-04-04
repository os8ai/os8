# Vault — Implementation Plan

**Reference:** [vault-spec-v2.md](vault-spec-v2.md)

---

## Phase 1: Schema & Service Foundation

**Goal:** Database tables exist, core service has basic notes CRUD, routes are mounted.

**Files to create:**
- `src/services/vault.js` — VaultService with static methods for notes, folders, tags, links
- `src/routes/vault.js` — Express router factory, mounted at `/api/vault`

**Files to modify:**
- `src/db.js` — Add all `vault_*` table creation statements and indexes
- `src/server.js` — Mount vault routes
- `src/services/index.js` — Export VaultService

**Work:**
1. Add full schema to `src/db.js` (all tables from spec section 4.1 — notes, folders, tags, links, versions, scopes, sources, chunks, agent_reads, templates)
2. Create `VaultService` with notes CRUD:
   - `createNote(db, { title, content, folder_id, tags })`
   - `getNote(db, id)` — returns note with tags and links
   - `updateNote(db, id, fields)` — triggers content_plain generation, word count, wikilink parsing, tag extraction, version creation
   - `deleteNote(db, id, { hard })` — archive or hard delete
   - `listNotes(db, filters)` — with folder_id, tag, is_daily, is_archived, is_pinned, sort, limit, offset
   - `getOrCreateDailyNote(db, date)`
   - Slug generation from title (unique, URL-safe)
3. Create route factory with notes endpoints (GET/POST/PATCH/DELETE `/notes`, `/notes/:id`, `/notes/daily`)
4. Mount routes in server.js
5. Add FTS5 virtual table, keep it in sync on note create/update/delete via triggers or explicit service calls

**Delivers:** Working notes API. Can create, read, update, delete notes. Full-text search index populated.

---

## Phase 2: Shell Panel Scaffold

**Goal:** Vault appears as a tab in the OS8 shell with a basic working UI — note list, note editor, sidebar navigation.

**Files to create:**
- `src/renderer/vault.js` — Main vault panel module (sidebar, content area, inspector skeleton)
- `src/renderer/vault-editor.js` — CodeMirror 6 integration for Markdown editing
- `styles/vault.css` — Vault panel styles using OS8 CSS variables

**Files to modify:**
- `src/renderer/main.js` — Register vault panel, add tab creation
- `src/renderer/tabs.js` — Support vault tab type
- `styles.css` — Import vault.css
- `index.html` — Add vault panel container
- `preload.js` — Add `window.os8.vault` namespace if any IPC needed (likely all HTTP though)

**Work:**
1. Add vault panel container to `index.html`
2. Build sidebar with sections: Search, Daily Notes, All Notes, Pinned, Recent
3. Note list view — fetch from `/api/vault/notes`, render as scrollable list with title, date, excerpt
4. Integrate CodeMirror 6:
   - Install CM6 packages (serve as bundled script for shell, not via Vite)
   - Markdown mode with syntax highlighting
   - Basic keybindings (bold, italic, headings)
   - Save handler → PATCH `/api/vault/notes/:id`
5. Note creation flow — "New Note" button, title input, opens editor
6. Tab integration — clicking Vault in shell opens/focuses vault tab
7. Style everything with OS8 CSS variables (dark theme, surfaces, borders)

**Delivers:** Users can open Vault, create notes, edit Markdown, see a list of their notes. Functional but minimal.

---

## Phase 3: Folders, Tags & Links

**Goal:** Notes can be organized. Wikilinks create connections. Tags are searchable.

**Files to modify:**
- `src/services/vault.js` — Add folder, tag, link CRUD methods
- `src/routes/vault.js` — Add folder, tag, link, graph endpoints
- `src/renderer/vault.js` — Folder tree in sidebar, tag view, inspector panel with backlinks/tags
- `src/renderer/vault-editor.js` — Wikilink autocomplete, tag autocomplete

**Work:**
1. **Folders:** CRUD methods + tree assembly (recursive CTE query). Drag-drop reorder in sidebar. Context menu (rename, delete, new subfolder, new note).
2. **Tags:** CRUD methods + note-tag junction management. Tag picker component with autocomplete and inline creation. Tag view in sidebar showing all tags with counts.
3. **Wikilinks:** On note save, parse `[[...]]` patterns → resolve to note IDs by title → upsert `vault_links`. In editor, `[[` triggers autocomplete dropdown searching note titles. Unresolved links styled differently (dimmed), clicking creates the note.
4. **Inspector panel:** Right sidebar showing backlinks (notes that link TO this note), tags on current note, metadata (word count, created/updated dates).
5. **Link endpoints:** `POST /links`, `DELETE /links/:id`, `GET /graph`, `GET /graph/:noteId`

**Delivers:** Full note organization. Users can file notes in folders, tag them, link them with `[[wikilinks]]`, and see backlinks.

---

## Phase 4: Search & Embeddings

**Goal:** Notes are searchable by keyword and semantically. Chunks and embeddings are generated using the existing pipeline.

**Files to modify:**
- `src/services/vault.js` — Add search methods, chunk/embed orchestration
- `src/assistant/memory-embeddings.js` — Ensure chunking/embedding utilities are reusable (may need minor refactoring to decouple from agent-specific assumptions)
- `src/routes/vault.js` — Add search endpoint
- `src/renderer/vault.js` — Search results view with highlighted snippets

**Work:**
1. **FTS5 search:** `searchKeyword(db, query, filters)` — queries `vault_notes_fts`, returns ranked results with snippet extraction. Support boolean operators, phrase search, prefix matching.
2. **Chunking on save:** When a note is created/updated, chunk its `content_plain` into ~400-token segments using the existing chunking logic from `memory-embeddings.js`. Store in `vault_chunks` with `note_id`.
3. **Embedding on save:** Generate embedding per chunk using existing `all-MiniLM-L6-v2` pipeline. Store as BLOB in `vault_chunks.embedding`. Run async (don't block save).
4. **Semantic search:** `searchSemantic(db, query, filters)` — embed the query, cosine similarity against all `vault_chunks` embeddings, return top-N above threshold, grouped by note.
5. **Hybrid search:** `search(db, query, filters)` — run both, merge with weighted scoring (0.4 keyword + 0.6 semantic), deduplicate by note.
6. **Search UI:** Search input in sidebar. Results view with highlighted snippets, type indicators, filters (tags, folders, date range). Toggle between keyword/semantic/hybrid modes.

**Delivers:** Users can find any note by content or meaning. The embedding infrastructure is proven and ready for filesystem indexing.

---

## Phase 5: Filesystem Indexing

**Goal:** Users can point Vault at directories on their computer. Files are scanned, text is extracted, chunks are embedded. Indexed content appears in search alongside notes.

**Files to create:**
- `src/services/vault-indexer.js` — VaultIndexerService (scanning, extraction, change detection)

**Files to modify:**
- `src/services/vault.js` — Add scope CRUD, source queries, integrate indexed content into search
- `src/routes/vault.js` — Add scope and source endpoints, index status
- `src/renderer/vault.js` — "Indexed Files" view in sidebar, scope management UI, index progress indicator

**Work:**
1. **Scope management:** CRUD for `vault_scopes`. Validation (path exists, not a system directory, not already scoped). Default suggestions on first use (~/Documents, ~/Desktop, ~/Downloads).
2. **File scanner:** Walk scope directory tree recursively. Respect ignore patterns. Filter by supported extensions. For each file: record path, size, mtime, compute SHA-256 content hash. Throttled to avoid blocking.
3. **Text extraction pipeline:**
   - `.md`, `.txt`, `.rtf` → direct read
   - `.pdf` → pdf-parse or MarkItDown
   - `.docx`, `.xlsx`, `.pptx` → MarkItDown
   - Code files → direct read
   - Images → metadata only (OCR deferred, configurable)
   - Store extracted text in `vault_sources.extracted_text`
4. **Chunk + embed:** Same pipeline as notes — chunk extracted text, generate embeddings, store in `vault_chunks` with `source_id`.
5. **Change detection:** On app launch (if `index_on_launch` enabled) and on manual rescan: walk scopes, compare mtime + hash, queue changed/new files for re-extraction, mark missing files as stale.
6. **Progress UI:** Show indexing status in sidebar footer — files queued, in progress, completed, failed. Per-scope stats.
7. **Indexed files view:** Browse by scope. See file list with extraction status, type, size, last indexed. Click to view extracted text. Option to remove individual files from index.
8. **Unified search:** Extend search methods to query both `vault_notes` and `vault_sources` chunks. Results indicate type (note vs. file) and show file path for sources.

**Delivers:** Vault understands what's on the user's computer. Search returns results from both notes and indexed files. The core value proposition is functional.

---

## Phase 6: Agent Integration

**Goal:** Agents can passively benefit from Vault content and actively search it. Agents can write notes.

**Files to modify:**
- `src/assistant/memory.js` — Include vault chunks in Tier 4 semantic search
- `src/assistant/memory-embeddings.js` — Add vault chunk source to search corpus
- `src/services/vault.js` — Agent search method, agent inject method, reads logging
- `src/routes/vault.js` — Agent endpoints
- Backend adapter or capability registration — Register `vault_search` as an agent tool

**Work:**
1. **Tier 4 integration:** Modify `searchHybrid()` in `memory.js` to include vault chunks in the search corpus. Add a `vault` category with 1.3x boost. Vault results appear alongside conversation memory and principle nodes. The subconscious curates as usual.
2. **vault_search tool:** Register as a capability. When an agent calls it, execute `POST /api/vault/agent/search` with the agent's query and filters. Return ranked results with source metadata. Log access in `vault_agent_reads`.
3. **Agent write-back:** `POST /api/vault/agent/inject` creates a note tagged `agent:{name}`. Standard note creation flow (chunked, embedded, searchable).
4. **Agent-scoped relevance:** Optional per-agent config — preferred folders, tags, or scopes that apply additional boost during retrieval. Stored in agent config.
5. **Read audit:** `GET /api/vault/agent/reads/:agentId` returns what the agent has accessed, grouped by note/source, with timestamps and relevance scores.
6. **Transparency prompting:** Update agent identity context to instruct citing Vault sources when used — *"Based on your note 'X'..."* or *"I found in your document 'Y'..."*

**Delivers:** Agents are aware of the user's knowledge. The more the user writes and indexes, the smarter agents get. The core differentiator is live.

---

## Phase 7: Graph, Versions, Daily Notes, Templates

**Goal:** Remaining UI features that enhance the note-taking experience.

**Files to modify:**
- `src/renderer/vault.js` — Graph view, daily notes view, version history, template picker
- `src/services/vault.js` — Version restore, template CRUD
- `src/routes/vault.js` — Template and version endpoints

**Work:**
1. **Graph view:** D3.js force-directed graph. Nodes = notes, edges = explicit links. Node size by connection count, color by folder or tag. Click to navigate. Zoom/pan. Local mode (centered on one note, depth 1-3). Rendered in a canvas/SVG area within the vault panel.
2. **Version history:** List versions in inspector panel with timestamps. Click to view content. "Restore" creates a new version with the old content (non-destructive). No diff rendering — just full content view.
3. **Daily notes view:** Calendar picker. Click date → open or create daily note. Yesterday/tomorrow navigation arrows. List of recent daily notes.
4. **Templates:** CRUD via settings area. Template picker in "new note" flow. Default templates: blank, daily note, meeting notes.

**Delivers:** Full note-taking experience. Graph visualization for exploring connections. Version safety net. Daily notes workflow.

---

## Phase 8: Import/Export & Polish

**Goal:** Users can bring existing knowledge in, take it out, and the whole thing feels solid.

**Work:**
1. **Obsidian import:** Parse `.md` files with YAML frontmatter. Preserve `[[wikilinks]]`, `#tags`, folder structure. Map Obsidian folders → vault folders. Handle attachments (reference by original path if still on disk, or import to blob if bundled in export).
2. **Markdown folder import:** Recursive directory → vault folders, files → notes. Parse wikilinks and tags.
3. **Export:** ZIP containing all notes as `.md` files, organized by folder. YAML frontmatter with tags, dates. Blob attachments included. `manifest.json` with metadata.
4. **UI polish:** Loading states, empty states, error handling, transitions. Keyboard shortcut help. Onboarding for first-time Vault users (explain scopes, suggest defaults).
5. **Performance tuning:** Measure against targets. Optimize FTS5 queries, embedding search with large corpora, graph rendering with many nodes.

**Delivers:** Complete feature. Users can migrate from Obsidian, export their data, and everything feels production-quality.

---

## Dependency Graph

```
Phase 1 (Schema + Service)
  │
  ├──> Phase 2 (Shell Panel)
  │      │
  │      └──> Phase 3 (Folders, Tags, Links)
  │             │
  │             └──> Phase 7 (Graph, Versions, Daily, Templates)
  │
  ├──> Phase 4 (Search + Embeddings)
  │      │
  │      ├──> Phase 5 (Filesystem Indexing)
  │      │
  │      └──> Phase 6 (Agent Integration)
  │             │
  │             └──> Phase 8 (Import/Export + Polish)
  │
  (Phases 2-3 and 4-5 can run in parallel)
```

**Parallelization:** Phases 2-3 (UI) and Phase 4 (search/embeddings) are independent after Phase 1. If working with two streams, one can build the UI while the other builds the search infrastructure. They converge at Phase 5 (filesystem indexing needs both the UI to manage scopes and the embedding pipeline to index files).

---

## Estimated Scope Per Phase

| Phase | New Files | Modified Files | Rough Size |
|-------|-----------|---------------|------------|
| 1. Schema + Service | 2 | 3 | Medium |
| 2. Shell Panel | 3 | 5 | Large (CM6 integration) |
| 3. Folders, Tags, Links | 0 | 4 | Medium |
| 4. Search + Embeddings | 0 | 4 | Medium |
| 5. Filesystem Indexing | 1 | 3 | Large |
| 6. Agent Integration | 0 | 5 | Medium |
| 7. Graph, Versions, etc. | 0 | 3 | Medium |
| 8. Import/Export + Polish | 0 | 3 | Medium |
