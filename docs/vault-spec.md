# Vault — OS8 Personal Knowledge Base

**Full Specification Document**
**Author:** Penny Archer, CNO
**Date:** April 2, 2026
**Status:** Spec complete. Ready for Claude Code implementation.

---

## 1. Vision

Vault is the native knowledge layer of OS8. It gives every user a searchable, linkable, agent-aware second brain — notes, documents, clippings, images, PDFs, and files — all connected by bidirectional links, tags, and semantic embeddings. The differentiator: Vault uses a hybrid agent integration model — high-confidence content is auto-injected into agent context (ambient layer), while agents also have an explicit search tool for deeper on-demand retrieval (active layer). Agents get smarter the more the user writes, without wasting context on weak matches.

Vault is not an app. It is a platform feature. Every agent can read from it. Every app can write to it.

---

## 2. Core Concepts

| Concept | Description |
|---------|-------------|
| **Note** | A Markdown document with metadata. The atomic unit of knowledge. |
| **Folder** | Hierarchical container for notes. Supports nesting. |
| **Tag** | Flat label applied to notes. Many-to-many. |
| **Link** | Bidirectional connection between two notes. Typed (reference, contradiction, builds-on, related). |
| **Attachment** | Binary file (image, PDF, audio, video) stored in blob, referenced by a note. |
| **Version** | Immutable snapshot of a note's content at a point in time. Auto-created on save. |
| **Bookmark** | A clipped URL with extracted content, stored as a note with source metadata. |
| **Daily Note** | Auto-created note for today's date. One per day. Entry point for quick capture. |
| **Embedding** | Vector representation of a note's content, stored for semantic search. |
| **Chunk** | Semantic subdivision of a long note (~300-500 tokens) for granular embedding and retrieval. |

---

## 3. Data Model

### 3.1 SQL Schema

```sql
-- Folders (hierarchical)
CREATE TABLE vault_folders (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES vault_folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  icon TEXT,                    -- emoji or icon name
  sort_order INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Notes (the core entity)
CREATE TABLE vault_notes (
  id TEXT PRIMARY KEY,
  folder_id TEXT REFERENCES vault_folders(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,     -- URL-safe, auto-generated from title
  content TEXT NOT NULL DEFAULT '',  -- Markdown body
  content_plain TEXT,            -- stripped text for full-text search
  is_daily INTEGER DEFAULT 0,   -- 1 if this is a daily note
  daily_date TEXT,               -- YYYY-MM-DD if daily note
  is_bookmark INTEGER DEFAULT 0,
  source_url TEXT,               -- original URL if bookmark
  is_pinned INTEGER DEFAULT 0,
  is_archived INTEGER DEFAULT 0,
  word_count INTEGER DEFAULT 0,
  reading_time_min REAL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  published_at TEXT              -- null = draft
);

-- Full-text search index
-- (implementation note: use SQLite FTS5)
-- CREATE VIRTUAL TABLE vault_notes_fts USING fts5(title, content_plain, content='vault_notes', content_rowid='rowid');

-- Tags
CREATE TABLE vault_tags (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  color TEXT,                    -- hex color for UI
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Note-Tag junction
CREATE TABLE vault_note_tags (
  note_id TEXT NOT NULL REFERENCES vault_notes(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES vault_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (note_id, tag_id)
);

-- Bidirectional links between notes
CREATE TABLE vault_links (
  id TEXT PRIMARY KEY,
  source_note_id TEXT NOT NULL REFERENCES vault_notes(id) ON DELETE CASCADE,
  target_note_id TEXT NOT NULL REFERENCES vault_notes(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL DEFAULT 'reference',  -- reference, contradiction, builds-on, related
  context TEXT,                  -- surrounding text where the link appears
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_note_id, target_note_id)
);

-- Attachments (binary files in blob storage)
CREATE TABLE vault_attachments (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES vault_notes(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  blob_path TEXT NOT NULL,       -- path in blob storage
  thumbnail_path TEXT,           -- path to generated thumbnail in blob
  width INTEGER,                 -- for images/video
  height INTEGER,                -- for images/video
  extracted_text TEXT,            -- OCR / PDF text extraction
  sort_order INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Version history
CREATE TABLE vault_versions (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES vault_notes(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  diff_from_previous TEXT,       -- unified diff from last version
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Semantic chunks for embedding-based retrieval
CREATE TABLE vault_chunks (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES vault_notes(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,  -- position within the note
  content TEXT NOT NULL,          -- the chunk text
  token_count INTEGER,
  byte_offset_start INTEGER,     -- pointer back to original note
  byte_offset_end INTEGER,
  embedding BLOB,                -- vector embedding (float32 array)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Discovered connections (auto-generated from embedding similarity)
CREATE TABLE vault_connections (
  id TEXT PRIMARY KEY,
  chunk_a_id TEXT NOT NULL REFERENCES vault_chunks(id) ON DELETE CASCADE,
  chunk_b_id TEXT NOT NULL REFERENCES vault_chunks(id) ON DELETE CASCADE,
  similarity_score REAL NOT NULL, -- cosine similarity
  is_dismissed INTEGER DEFAULT 0, -- user can dismiss false positives
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(chunk_a_id, chunk_b_id)
);

-- Saved searches / smart folders
CREATE TABLE vault_saved_searches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  query TEXT NOT NULL,            -- search query string
  filters TEXT,                   -- JSON: {tags: [], folders: [], dateRange: {}, type: []}
  sort_by TEXT DEFAULT 'relevance',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Agent access log (tracks which notes agents have seen)
CREATE TABLE vault_agent_reads (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  note_id TEXT REFERENCES vault_notes(id) ON DELETE CASCADE,
  chunk_id TEXT REFERENCES vault_chunks(id) ON DELETE CASCADE,
  conversation_id TEXT,          -- which conversation triggered the read
  relevance_score REAL,          -- how relevant the retrieval was
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX idx_notes_folder ON vault_notes(folder_id);
CREATE INDEX idx_notes_daily ON vault_notes(is_daily, daily_date);
CREATE INDEX idx_notes_updated ON vault_notes(updated_at);
CREATE INDEX idx_notes_slug ON vault_notes(slug);
CREATE INDEX idx_note_tags_note ON vault_note_tags(note_id);
CREATE INDEX idx_note_tags_tag ON vault_note_tags(tag_id);
CREATE INDEX idx_links_source ON vault_links(source_note_id);
CREATE INDEX idx_links_target ON vault_links(target_note_id);
CREATE INDEX idx_attachments_note ON vault_attachments(note_id);
CREATE INDEX idx_versions_note ON vault_versions(note_id);
CREATE INDEX idx_chunks_note ON vault_chunks(note_id);
CREATE INDEX idx_connections_a ON vault_connections(chunk_a_id);
CREATE INDEX idx_connections_b ON vault_connections(chunk_b_id);
CREATE INDEX idx_agent_reads_agent ON vault_agent_reads(agent_id);
CREATE INDEX idx_agent_reads_note ON vault_agent_reads(note_id);
```

### 3.2 Blob Storage Layout

```
/vault/
  /attachments/
    /{note_id}/
      {attachment_id}-{filename}       -- original file
      {attachment_id}-thumb.webp       -- generated thumbnail (images)
      {attachment_id}-preview.webp     -- larger preview (images)
  /exports/
    {export_id}.zip                    -- full vault exports
  /imports/
    {import_id}/                       -- staging area for imports
```

---

## 4. API Surface

All endpoints prefixed with `/api/vault`.

### 4.1 Notes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/notes` | List notes. Query params: `folder_id`, `tag`, `search`, `is_daily`, `is_archived`, `is_pinned`, `sort` (updated, created, title, relevance), `order` (asc, desc), `limit`, `offset` |
| `GET` | `/notes/:id` | Get single note with metadata, tags, links, attachments |
| `POST` | `/notes` | Create note. Body: `{ title, content, folder_id?, tags?, is_daily?, daily_date?, source_url? }` |
| `PATCH` | `/notes/:id` | Update note. Body: `{ title?, content?, folder_id?, is_pinned?, is_archived? }` |
| `DELETE` | `/notes/:id` | Soft-delete (archive) or hard-delete with `?hard=true` |
| `GET` | `/notes/:id/versions` | List version history |
| `GET` | `/notes/:id/versions/:versionId` | Get specific version |
| `POST` | `/notes/:id/restore/:versionId` | Restore note to a previous version |
| `GET` | `/notes/:id/backlinks` | Get all notes that link TO this note |
| `GET` | `/notes/:id/connections` | Get semantically similar notes (via embeddings) |
| `GET` | `/notes/daily` | Get or create today's daily note |
| `GET` | `/notes/daily/:date` | Get daily note for specific date (YYYY-MM-DD) |

### 4.2 Folders

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/folders` | List all folders as tree structure |
| `POST` | `/folders` | Create folder. Body: `{ name, parent_id?, icon? }` |
| `PATCH` | `/folders/:id` | Update folder. Body: `{ name?, parent_id?, icon?, sort_order? }` |
| `DELETE` | `/folders/:id` | Delete folder. Notes within are moved to root (not deleted). |
| `POST` | `/folders/:id/move` | Move folder. Body: `{ parent_id }` |

### 4.3 Tags

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/tags` | List all tags with note counts |
| `POST` | `/tags` | Create tag. Body: `{ name, color? }` |
| `PATCH` | `/tags/:id` | Update tag. Body: `{ name?, color? }` |
| `DELETE` | `/tags/:id` | Delete tag (removes from all notes, doesn't delete notes) |
| `POST` | `/notes/:id/tags` | Add tags to note. Body: `{ tag_ids: [] }` |
| `DELETE` | `/notes/:id/tags/:tagId` | Remove tag from note |

### 4.4 Links

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/links` | Create link. Body: `{ source_note_id, target_note_id, link_type?, context? }` |
| `DELETE` | `/links/:id` | Delete link |
| `GET` | `/graph` | Get full link graph. Returns `{ nodes: [...], edges: [...] }` |
| `GET` | `/graph/:noteId` | Get local graph centered on a note (depth param for hops) |

### 4.5 Attachments

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/notes/:id/attachments` | Upload file. Multipart form data. |
| `GET` | `/attachments/:id` | Get attachment metadata |
| `GET` | `/attachments/:id/download` | Download attachment binary |
| `DELETE` | `/attachments/:id` | Delete attachment (removes from blob) |

### 4.6 Search

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/search` | Full-text search. Params: `q` (query), `tags`, `folders`, `date_from`, `date_to`, `type` (note, bookmark, daily), `limit`, `offset` |
| `GET` | `/search/semantic` | Semantic search via embeddings. Params: `q`, `limit`, `threshold` (min similarity) |
| `GET` | `/search/saved` | List saved searches |
| `POST` | `/search/saved` | Create saved search |
| `DELETE` | `/search/saved/:id` | Delete saved search |

### 4.7 Import / Export

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/import/markdown` | Import folder of .md files. Multipart or path reference. Preserves `[[wikilinks]]` and `#tags`. |
| `POST` | `/import/obsidian` | Import Obsidian vault (preserves frontmatter, links, tags, attachments) |
| `POST` | `/import/url` | Clip a URL. Body: `{ url }`. Extracts content via Readability, stores as bookmark note. |
| `GET` | `/export` | Export entire vault as ZIP (Markdown + attachments) |
| `GET` | `/export/:folderId` | Export single folder |

### 4.8 Embeddings & Connections

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/embeddings/generate` | Trigger embedding generation for all unembedded notes/chunks |
| `POST` | `/embeddings/generate/:noteId` | Generate embeddings for a specific note |
| `GET` | `/connections` | List discovered connections above threshold. Params: `min_similarity`, `limit` |
| `POST` | `/connections/:id/dismiss` | Dismiss a false-positive connection |

### 4.9 Agent Integration

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/agent/query` | **Ambient retrieval.** Body: `{ query, agent_id, conversation_id?, mode: "ambient" }`. Returns top-3 high-confidence chunks (≥0.85 similarity, max 500 tokens). Used by the system automatically on each message. |
| `POST` | `/agent/search` | **Active lookup.** Body: `{ query, agent_id, mode?: "semantic"\|"keyword"\|"hybrid", limit?, min_relevance?, tags?, folders?, date_range? }`. Full search with filters. Used by agents on-demand via the `vault_search` tool. |
| `GET` | `/agent/reads/:agentId` | What has this agent accessed? |
| `POST` | `/agent/inject` | Agent writes a note into vault. Body: `{ title, content, folder_id?, tags?, agent_id }` |

---

## 5. Embedding & Chunking Pipeline

### 5.1 On Note Save

1. Strip Markdown to plain text → store in `content_plain`
2. Compute `word_count` and `reading_time_min`
3. Parse `[[wikilinks]]` → upsert into `vault_links`
4. Parse `#tags` in body → upsert into `vault_note_tags`
5. Queue for async embedding

### 5.2 Async Embedding Job

Runs on note create/update, or triggered manually via API.

1. Split note into semantic chunks (~300-500 tokens), respecting paragraph/heading boundaries
2. Generate embedding per chunk (local model: `all-MiniLM-L6-v2` at 384 dimensions, or `nomic-embed-text` at 768 dimensions if available)
3. Store chunks and embeddings in `vault_chunks`
4. Run pairwise cosine similarity against existing chunks
5. Store connections above threshold (default 0.78) in `vault_connections`
6. Prune connections below threshold on re-embed

### 5.3 Attachment Processing

On upload:

| File Type | Processing |
|-----------|-----------|
| Image (png, jpg, webp, gif) | Generate thumbnail (200px) + preview (800px). Run OCR if text detected (Tesseract or Apple Vision). Store extracted text in `extracted_text`. Generate embedding from extracted text. |
| PDF | Extract text via MarkItDown or pdf-parse. Store in `extracted_text`. Generate embedding. Generate page thumbnail. |
| Audio (mp3, m4a, wav) | Transcribe via Whisper (local). Store transcript as `extracted_text`. Generate embedding. |
| Video (mp4, mov) | Extract keyframes. Transcribe audio track. Store transcript. Generate embedding. |
| Other | Store as-is. No embedding. |

---

## 6. UI Specification

### 6.1 Layout

```
┌─────────────────────────────────────────────────────────┐
│  ┌──────────┐  ┌────────────────────┐  ┌─────────────┐ │
│  │ Sidebar  │  │   Editor / View    │  │  Inspector  │ │
│  │          │  │                    │  │             │ │
│  │ - Search │  │   [Markdown]       │  │ - Backlinks │ │
│  │ - Daily  │  │                    │  │ - Tags      │ │
│  │ - Folders│  │                    │  │ - Links     │ │
│  │ - Tags   │  │                    │  │ - Versions  │ │
│  │ - Graph  │  │                    │  │ - Metadata  │ │
│  │ - Recent │  │                    │  │ - Similar   │ │
│  │ - Pinned │  │                    │  │             │ │
│  └──────────┘  └────────────────────┘  └─────────────┘ │
└─────────────────────────────────────────────────────────┘
```

Three-panel layout. Sidebar collapsible. Inspector collapsible. Editor takes remaining space.

### 6.2 Views

**Editor View** — Split-pane: Markdown source on left, live preview on right. Or toggle between edit/preview modes. Supports:
- Standard Markdown (CommonMark)
- `[[wikilinks]]` — auto-complete from note titles, creates link on save
- `#tags` — inline tag creation, auto-complete from existing tags
- `/commands` — slash menu for inserting blocks (table, code, image, callout, divider, date, checkbox list)
- Drag-and-drop file upload → creates attachment + inserts reference
- Image paste from clipboard
- Code blocks with syntax highlighting
- LaTeX math blocks
- Callout/admonition blocks (info, warning, tip, quote)
- Checkbox task lists
- Table editor (visual + Markdown)

**Folder View** — File tree with drag-and-drop reordering. Context menu: rename, move, delete, new note, new subfolder. Note count per folder. Expand/collapse.

**Tag View** — Tag cloud or list with counts. Click tag → filtered note list. Bulk tag operations (rename, merge, delete).

**Graph View** — Force-directed graph of all linked notes. Nodes = notes. Edges = links. Node size = connection count. Color by folder or tag. Click node → navigate to note. Hover → preview. Zoom, pan, filter by tag/folder/date. Local graph mode (centered on one note, configurable depth 1-3).

**Daily Notes View** — Calendar picker. Auto-creates note for selected date. Sequential navigation (← yesterday, tomorrow →). Aggregated view: what happened on this day across all years.

**Search Results View** — Shows matching notes with highlighted snippets. Toggle between full-text and semantic search. Filter sidebar: tags, folders, date range, type. Sort by relevance, date, title.

**Bookmark View** — Grid of clipped URLs with favicons, titles, excerpts. Filter by tag. Reader-mode view for cleaned article content.

**Recent View** — Chronological list of recently viewed/edited notes. Configurable time window.

**Pinned View** — User's pinned notes for quick access.

### 6.3 Theme

Consistent with OS8 design system. Dark mode default. Key colors:
- Background: `#0f0f14`
- Surface: `#1a1a24`
- Border: `#2a2a3a`
- Primary accent: `#6366f1` (indigo)
- Text: `#e2e2e8`
- Muted: `#6b6b80`
- Link color: `#818cf8`
- Tag pill: `#2a2a3a` bg with accent text

### 6.4 Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+N` | New note |
| `Cmd+Shift+N` | New note in current folder |
| `Cmd+O` | Quick open (fuzzy search by title) |
| `Cmd+K` | Insert link (search notes) |
| `Cmd+Shift+F` | Global search |
| `Cmd+D` | Open today's daily note |
| `Cmd+B` | Bold |
| `Cmd+I` | Italic |
| `Cmd+Shift+K` | Insert code block |
| `Cmd+Shift+L` | Toggle link to selected text |
| `Cmd+S` | Save (creates version) |
| `Cmd+P` | Toggle preview |
| `Cmd+\` | Toggle sidebar |
| `Cmd+Shift+\` | Toggle inspector |
| `Cmd+Shift+G` | Open graph view |
| `Cmd+Shift+T` | Add/edit tags |
| `Cmd+Shift+D` | Delete note |
| `Cmd+[` / `Cmd+]` | Navigate back / forward |
| `Cmd+1-9` | Switch to sidebar section |

---

## 7. Agent Integration (The Differentiator)

Agent integration uses a **hybrid model**: a lightweight ambient layer that auto-injects high-confidence context, plus an explicit API lookup tool agents can call when they need to dig deeper. This mirrors the five-step memory architecture — ambient injection handles the subconscious layer, active search handles the conscious one.

### 7.1 Ambient Injection (Auto, Lightweight)

On every user message, a fast pre-retrieval pass runs automatically:

1. Extract keywords + intent from the user's message
2. Call `POST /api/vault/agent/query` with `{ mode: "ambient" }` — fast, narrow, low token budget
3. Return only **top-3 chunks** above a high confidence threshold (default 0.85 similarity)
4. Inject as a small `<vault_context>` block in the agent's context window
5. Log in `vault_agent_reads`

**Design constraints:**
- Max **500 tokens** of injected Vault context per turn (keeps overhead minimal)
- Only fires if at least one chunk exceeds the confidence threshold — no injection on weak matches
- Zero latency impact on conversations where Vault has nothing relevant

This means: agents are passively smarter when the user has written about the topic at hand, with no cost when they haven't.

### 7.2 Active Lookup (On-Demand, Agent-Initiated)

Agents have an explicit **Vault Search tool** they can call when they recognize they need more information:

```
Tool: vault_search
Parameters:
  query: string        -- natural language or keyword query
  mode: "semantic" | "keyword" | "hybrid"  (default: "hybrid")
  limit: number        (default: 10)
  min_relevance: number (default: 0.65)
  tags: string[]       -- filter by tags
  folders: string[]    -- filter by folders
  date_range: { from, to }  -- filter by date
```

Returns: Ranked chunks with full source note metadata (title, folder, tags, created date, link to note).

**When agents should use this:**
- User asks about something the agent doesn't have in current context
- Agent recognizes a knowledge gap mid-response
- User explicitly says "check my notes" or "what did I write about X"
- Agent is generating a report or summary that should reference user's own writing

**Transparency:** When an agent uses active lookup, it should say so: *"Based on your note '{title}' from {date}..."* — the user sees when Vault is being consulted.

### 7.3 Agent Write-Back

Agents can write to Vault:
- Meeting notes from conversations
- Research summaries
- Decision logs
- Extracted action items
- Learned facts about the user

Each agent-created note is tagged with `agent:{agent_name}` automatically.

Via `POST /api/vault/agent/inject` with `{ title, content, folder_id?, tags?, agent_id }`.

### 7.4 Cross-Note Awareness

When an agent retrieves a Vault chunk (via ambient or active lookup), the response can include:
- "Based on your note '{title}' from {date}..."
- Links to related notes the user might not have connected
- Suggestions for new links between existing notes

### 7.5 Vault as Agent Memory Source

The embedding pipeline powers agent memory retrieval. When the contextualizer runs (step 3 of the memory pipeline):

- **Ambient Vault injection** runs alongside conversation memory and principle node injection — it's part of the same subconscious context assembly
- **Active Vault search** is available as an optional step 4 (active search) — firing when the contextualizer detects insufficient information

This unifies:
- What the user *wrote* (Vault — ambient + active)
- What the user *said* (conversations)
- What the agent *learned* (principle nodes)

Into a single retrieval surface, with two access patterns: automatic (ambient) and intentional (active).

---

## 8. Web Clipper

### 8.1 Clip Flow

1. User provides URL (via API, agent command, or UI button)
2. System fetches URL
3. Extracts clean content via Readability algorithm (Mozilla's)
4. Converts to Markdown via MarkItDown
5. Stores as a note with `is_bookmark = 1`, `source_url = {url}`
6. Extracts images → stores as attachments
7. Generates embedding
8. Auto-tags based on content (optional, via LLM)

### 8.2 Metadata Extraction

For clipped URLs:
- `og:title`, `og:description`, `og:image`
- Author, publish date
- Domain/favicon
- Reading time

---

## 9. Import / Export

### 9.1 Import Sources

| Source | Format | Notes |
|--------|--------|-------|
| Obsidian | .md + .obsidian/ | Preserves frontmatter, `[[wikilinks]]`, `#tags`, attachments, folder structure |
| Markdown folder | .md files | Recursive. Preserves directory structure as folders. |
| Notion | Export .zip | Parse Notion's Markdown export format |
| Apple Notes | via memo CLI | Extract and convert |
| Browser bookmarks | .html | Parse bookmark export, clip each URL |
| CSV | .csv | Map columns to title, content, tags, date |

### 9.2 Export

- **Full export:** ZIP containing all Markdown files + `/attachments/` folder + `manifest.json` with metadata
- **Folder export:** Same but scoped to a folder
- **Single note:** Download as .md with embedded attachment links
- **PDF export:** Render Markdown to styled PDF (uses note's rendered HTML)

### 9.3 Format Fidelity

On export, Vault notes are valid standard Markdown that opens in any editor. No proprietary syntax. `[[wikilinks]]` are preserved as-is (compatible with Obsidian). Tags in frontmatter YAML block.

---

## 10. Search Architecture

### 10.1 Full-Text Search

SQLite FTS5 on `vault_notes_fts` virtual table. Indexed columns: `title`, `content_plain`. Supports:
- Boolean operators (AND, OR, NOT)
- Phrase search (`"exact phrase"`)
- Prefix matching (`term*`)
- Column weighting (title matches ranked higher)
- Snippet extraction with highlighting

### 10.2 Semantic Search

1. Embed the query string using the same model as note chunks
2. Compute cosine similarity against all chunk embeddings
3. Return top-N chunks above threshold
4. Group by note, return note-level results with best-matching chunk as excerpt

### 10.3 Hybrid Search

Default search mode combines both:
1. Run FTS5 for keyword matches → score set A
2. Run semantic search → score set B
3. Merge with weighted combination: `0.4 * keyword_score + 0.6 * semantic_score`
4. Deduplicate by note
5. Return merged, ranked results

### 10.4 Filters

All search modes support filtering by:
- Folder (including recursive children)
- Tags (AND/OR)
- Date range (created or updated)
- Type (note, bookmark, daily)
- Has attachments
- Created by agent

---

## 11. Version Control

### 11.1 Auto-Versioning

On every save:
1. If content changed from last version → create new version
2. Compute unified diff from previous version
3. Store full content snapshot + diff
4. Increment version number
5. Max 100 versions per note (oldest pruned on exceed)

### 11.2 Version UI

- Timeline view showing all versions with timestamps
- Side-by-side diff view (old vs. new, highlighted changes)
- One-click restore to any previous version
- Restore creates a new version (non-destructive)

---

## 12. File Structure

```
/vault/
├── index.html                    -- entry point
├── manifest.json                 -- app manifest
├── css/
│   ├── vault.css                 -- main styles
│   ├── editor.css                -- Markdown editor styles
│   ├── graph.css                 -- graph view styles
│   └── theme.css                 -- color tokens
├── js/
│   ├── app.js                    -- main app, router, state
│   ├── api.js                    -- API client wrapper
│   ├── editor/
│   │   ├── markdown-editor.js    -- CodeMirror/textarea with Markdown support
│   │   ├── preview.js            -- Markdown → HTML renderer
│   │   ├── wikilink-parser.js    -- [[wikilink]] detection and autocomplete
│   │   ├── tag-parser.js         -- #tag detection and autocomplete
│   │   ├── slash-commands.js     -- /command menu
│   │   └── keybindings.js        -- keyboard shortcut handler
│   ├── views/
│   │   ├── note-view.js          -- single note display
│   │   ├── folder-view.js        -- folder tree
│   │   ├── tag-view.js           -- tag management
│   │   ├── graph-view.js         -- D3.js force graph
│   │   ├── daily-view.js         -- daily notes + calendar
│   │   ├── search-view.js        -- search results
│   │   ├── bookmark-view.js      -- bookmarks grid
│   │   ├── version-view.js       -- version history + diff
│   │   └── settings-view.js      -- vault settings
│   ├── components/
│   │   ├── sidebar.js            -- left sidebar
│   │   ├── inspector.js          -- right inspector panel
│   │   ├── note-list.js          -- sortable/filterable note list
│   │   ├── tag-picker.js         -- tag autocomplete + creation
│   │   ├── link-picker.js        -- note search for [[wikilinks]]
│   │   ├── breadcrumb.js         -- folder path breadcrumb
│   │   ├── modal.js              -- modal dialog
│   │   ├── toast.js              -- notification toasts
│   │   ├── context-menu.js       -- right-click menus
│   │   └── calendar-picker.js    -- date picker for daily notes
│   └── lib/
│       ├── marked.min.js         -- Markdown parser
│       ├── highlight.min.js      -- syntax highlighting
│       ├── d3.min.js             -- graph visualization
│       ├── katex.min.js          -- LaTeX math rendering
│       └── diff.min.js           -- text diff library
├── workers/
│   ├── embedding-worker.js       -- Web Worker for embedding generation
│   └── search-worker.js          -- Web Worker for search indexing
└── assets/
    ├── icons/                    -- UI icons (SVG)
    └── fonts/                    -- monospace + sans-serif
```

---

## 13. Performance Targets

| Metric | Target |
|--------|--------|
| Note open | < 100ms |
| Save + version | < 200ms |
| Full-text search (10k notes) | < 300ms |
| Semantic search (10k notes) | < 500ms |
| Graph render (1k nodes) | < 1s |
| Embedding generation (single note) | < 2s |
| Bulk import (1k notes) | < 60s |
| Agent context query | < 400ms |

---

## 14. Security & Privacy

- All data stored locally (SQLite + blob). No cloud sync unless user opts in.
- Attachments in blob storage inherit OS8's encryption (SQLCipher + OS-native encrypted folders).
- Agent access logged in `vault_agent_reads` — user can audit what agents have seen.
- No telemetry. No analytics. No external API calls except for web clipping (user-initiated).
- Export is always available. No lock-in. Standard Markdown.

---

## 15. Integration Points

| System | Integration |
|--------|-------------|
| **Agent Memory** | Hybrid: ambient auto-injection of high-confidence chunks + active `vault_search` tool for on-demand retrieval |
| **Agent Life** | Agents can write observations, summaries, research into Vault |
| **OS8 Apps** | Any app can read/write Vault notes via API (e.g., a recipe app stores recipes as Vault notes) |
| **Telegram** | Quick capture: "save this to vault" → agent creates a note from the message |
| **Calendar** | Daily notes linked to calendar events |
| **OS8 Search** | Global OS8 search includes Vault results |
| **File System** | Watch folders for new files → auto-import into Vault |

---

## 16. Configuration

Stored in app settings (not hardcoded):

```json
{
  "vault": {
    "embedding_model": "all-MiniLM-L6-v2",
    "embedding_dimensions": 384,
    "chunk_size_tokens": 400,
    "chunk_overlap_tokens": 50,
    "connection_threshold": 0.78,
    "max_versions_per_note": 100,
    "auto_embed_on_save": true,
    "auto_tag_bookmarks": true,
    "daily_note_template": "# {{date}}\n\n",
    "default_folder": null,
    "graph_max_nodes": 500,
    "search_mode": "hybrid",
    "search_keyword_weight": 0.4,
    "search_semantic_weight": 0.6,
    "watched_folders": [],
    "ocr_enabled": true,
    "ocr_engine": "apple-vision"
  }
}
```

---

## 17. Open Questions for Leo

1. **Embedding model preference** — `all-MiniLM-L6-v2` (384d, fast, good enough) vs. `nomic-embed-text` (768d, better quality, needs more compute)? This depends on the hardware decision.
2. **Graph library** — D3.js (maximum control, more code) vs. Cytoscape.js (purpose-built for graphs, less custom)?
3. **Editor engine** — Plain textarea with custom Markdown handling (simpler, less code) vs. CodeMirror 6 (richer editing, more dependencies)?
4. **Watched folders** — Should Vault auto-import files from user-specified directories on the filesystem, or is manual import sufficient?
5. **Multi-user** — Is Vault per-user (each OS8 user gets their own vault), or shared within a deployment? Assuming per-user.

---

*End of specification. This document is the complete blueprint. No phases. No MVP. The whole thing.*

*— Penny*
