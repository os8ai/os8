# Vault Knowledge Graph — Specification

**Date:** April 4, 2026
**Status:** Draft
**Depends on:** Vault Phases 1-7 (complete)

---

## 1. Problem

Vault indexes files and stores notes, but treats every document as an island. The only connections are explicit `[[wikilinks]]` that users manually create between notes. Indexed files have zero connections to anything.

When you upload a project directory with 200 files, the graph view says "No linked notes yet." Semantic search can find individual documents by text similarity, but it has no understanding of *how documents relate to each other*. It can't tell you that `stripe-webhook.js` implements the payment API described in `ARCHITECTURE.md`, or that three files in different folders all deal with the same authentication concept.

The agent retrieval pipeline (Tier 4) suffers from the same limitation. It finds chunks that textually match the query, but misses structurally related content. If you ask about "billing" and the billing logic lives in a file that never uses that word, it's invisible — even though the knowledge graph would show a clear path from "billing" → "payment processing" → `stripe-webhook.js`.

---

## 2. What This Adds

A persistent knowledge graph layer over existing vault content. Documents (notes and indexed files) are connected through two mechanisms:

1. **Semantic edges** — Auto-discovered similarity relationships between documents based on existing embeddings. Zero-cost, computed from what we already have.

2. **Concept edges** — LLM-extracted entities and typed relationships. A file doesn't just "relate to" another file — it *implements*, *references*, *contradicts*, or *extends* it, connected through named concepts.

Both edge types are stored in SQLite, queryable via recursive CTEs, and integrated into the retrieval pipeline so agents automatically benefit from graph-aware search.

---

## 3. Data Model

### 3.1 New Tables

```sql
-- Concepts — shared entities that connect documents
-- Examples: "authentication", "React component pattern", "User API", "billing system"
CREATE TABLE vault_concepts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'topic',  -- topic, entity, api, pattern, decision, technology
  description TEXT,                     -- One-line definition from extraction
  embedding BLOB,                       -- 384-dim embedding of name+description
  mention_count INTEGER DEFAULT 0,      -- Number of documents referencing this concept
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_vault_concepts_name ON vault_concepts(name);
CREATE INDEX idx_vault_concepts_type ON vault_concepts(type);

-- Concept references — which documents mention which concepts
CREATE TABLE vault_concept_refs (
  id TEXT PRIMARY KEY,
  concept_id TEXT NOT NULL REFERENCES vault_concepts(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL,          -- 'note' or 'source'
  document_id TEXT NOT NULL,            -- vault_notes.id or vault_sources.id
  relationship TEXT NOT NULL DEFAULT 'mentions',  -- mentions, defines, implements, uses, contradicts, extends
  context TEXT,                         -- The sentence/passage where this concept appears
  confidence REAL DEFAULT 1.0,         -- Extraction confidence (0-1)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_vault_concept_refs_concept ON vault_concept_refs(concept_id);
CREATE INDEX idx_vault_concept_refs_document ON vault_concept_refs(document_type, document_id);

-- Edges — direct relationships between documents
-- Two types: 'semantic' (auto-computed) and 'concept' (LLM-extracted)
CREATE TABLE vault_edges (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,            -- 'note' or 'source'
  source_id TEXT NOT NULL,
  target_type TEXT NOT NULL,            -- 'note' or 'source'
  target_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,              -- 'semantic', 'references', 'implements', 'contradicts', 'extends', 'uses', 'related'
  score REAL,                           -- Similarity score (semantic edges) or confidence (concept edges)
  label TEXT,                           -- Human-readable: "both discuss authentication" or "implements User API"
  via_concept_id TEXT REFERENCES vault_concepts(id) ON DELETE SET NULL,  -- NULL for semantic edges
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_type, source_id, target_type, target_id, edge_type)
);

CREATE INDEX idx_vault_edges_source ON vault_edges(source_type, source_id);
CREATE INDEX idx_vault_edges_target ON vault_edges(target_type, target_id);
CREATE INDEX idx_vault_edges_type ON vault_edges(edge_type);
CREATE INDEX idx_vault_edges_concept ON vault_edges(via_concept_id);

-- FTS5 for concept name search
CREATE VIRTUAL TABLE vault_concepts_fts USING fts5(
  name, description,
  content='vault_concepts',
  content_rowid='rowid'
);

-- Tracks which documents have been analyzed for concepts
CREATE TABLE vault_graph_status (
  document_type TEXT NOT NULL,          -- 'note' or 'source'
  document_id TEXT NOT NULL,
  content_hash TEXT,                    -- To detect when re-analysis is needed
  semantic_edges_at TEXT,               -- When semantic edges were last computed
  concepts_extracted_at TEXT,           -- When LLM extraction last ran
  PRIMARY KEY (document_type, document_id)
);
```

### 3.2 Relationship Types

| Edge Type | Source | Meaning | Example |
|-----------|--------|---------|---------|
| `semantic` | Auto-computed | Documents have similar embedding vectors | Two files both about database queries |
| `references` | LLM-extracted | Document A explicitly mentions Document B | README links to API spec |
| `implements` | LLM-extracted | Document A is a concrete realization of Document B | Code file implements spec |
| `uses` | LLM-extracted | Document A depends on/imports Document B | Component uses utility |
| `extends` | LLM-extracted | Document A builds on or expands Document B | v2 spec extends v1 |
| `contradicts` | LLM-extracted | Documents make incompatible claims about the same concept | Doc says Postgres, config says MySQL |
| `related` | LLM-extracted | Catch-all for meaningful connections that don't fit above | |

### 3.3 Concept Types

| Type | Examples |
|------|---------|
| `topic` | "authentication", "billing", "error handling" |
| `entity` | "User", "Order", "PaymentIntent" |
| `api` | "REST API v2", "GraphQL schema", "Stripe webhook" |
| `pattern` | "observer pattern", "middleware chain", "component composition" |
| `decision` | "switch to GraphQL", "deprecate legacy auth" |
| `technology` | "React", "PostgreSQL", "Redis" |

---

## 4. Computation Pipeline

### 4.1 Semantic Edges (Option A)

Triggered automatically after indexing completes or when a note is saved.

**Algorithm:**

1. For each document that has chunks with embeddings, compute a **document-level embedding**: average of its chunk embeddings, L2-normalized.
2. Store document embeddings in a temporary in-memory map (not persisted — they're cheap to recompute from chunk embeddings).
3. For each new/changed document, compute cosine similarity against all other document embeddings.
4. Insert edges where similarity >= 0.60 (tunable threshold).
5. Cap at 10 edges per document (keep highest scoring) to prevent dense graphs.
6. Label: `"Both discuss {top shared keywords}"` — extracted by comparing the top TF-IDF terms of each document pair.

**Complexity:** O(n) per new document (compare against all others). O(n²) for full rebuild. Acceptable for <10k documents. For the full rebuild, process in batches of 100 with yielding.

**When it runs:**
- After `VaultIndexerService.scanScope()` completes — compute edges for newly indexed/changed files.
- After `VaultService.updateNote()` when content changes — recompute edges for that note.
- On demand via `POST /api/vault/graph/rebuild-semantic`.

### 4.2 Concept Extraction (Option B)

Triggered on demand by the user ("Analyze connections") or as a background job.

**Algorithm:**

For each document that hasn't been analyzed (or whose content has changed):

1. Take the document's extracted text (or `content_plain` for notes). If longer than 6000 chars, use the first and last 3000 chars.

2. Send to a lightweight LLM (Haiku-class — fast, cheap) with this prompt:

```
Analyze this document and extract:

1. CONCEPTS: Key topics, entities, APIs, patterns, decisions, or technologies discussed.
   For each: { name, type, relationship }
   Where relationship is how this document relates to the concept:
   - "defines" (this document is the authoritative source)
   - "implements" (this document is a concrete realization)
   - "uses" (this document depends on or references it)
   - "mentions" (passing reference)

2. CONNECTIONS: If this document explicitly references, implements, extends, or contradicts
   other documents or files, list them.
   For each: { target_name, relationship, reason }

Document title: {{title}}
Document path: {{path}}  (if indexed file)
Document type: {{type}}  (note, code, document, etc.)

Content:
{{content}}

Respond as JSON:
{
  "concepts": [
    { "name": "authentication", "type": "topic", "relationship": "implements", "context": "..." }
  ],
  "connections": [
    { "target_name": "auth-middleware.js", "relationship": "uses", "reason": "imports and calls auth check" }
  ]
}
```

3. For each extracted concept:
   - Fuzzy-match against existing `vault_concepts` by name (case-insensitive, with alias handling).
   - If no match, create new concept. Embed `name + description` for future matching.
   - Insert `vault_concept_refs` linking the document to the concept.

4. For each extracted connection:
   - Fuzzy-match `target_name` against note titles and source filenames.
   - If matched, insert a `vault_edge` with the specified relationship type.

5. After processing a document, create concept-mediated edges:
   - For each concept this document references, find other documents that reference the same concept.
   - Insert `vault_edges` with `via_concept_id` set, relationship inferred from the pair of relationships:
     - (defines, implements) → edge type `implements`
     - (defines, uses) → edge type `uses`
     - (implements, implements) → edge type `related`
     - etc.
   - Score = `min(confidence_a, confidence_b)`.

**Cost controls:**
- Use the cheapest capable model (Haiku/Flash tier via `CliRunnerService.sendTextPrompt()`).
- Batch: process up to 20 documents per run, then pause.
- Skip documents under 100 words (not enough content to extract meaningful concepts).
- Cache by `content_hash` in `vault_graph_status` — don't re-analyze unchanged documents.

**When it runs:**
- User clicks "Analyze" button on a scope or folder.
- Background job (if user enables) — processes unanalyzed documents at low priority.
- `POST /api/vault/graph/analyze` with optional `scope_id` or `folder_id` filter.

---

## 5. Graph Traversal Queries

All queries use SQLite recursive CTEs. No graph database needed.

### 5.1 Expand from Document (N hops)

```sql
WITH RECURSIVE connected(doc_type, doc_id, depth, path) AS (
  -- Seed: the starting document
  SELECT ?1, ?2, 0, ?2
  UNION ALL
  -- Forward edges
  SELECT e.target_type, e.target_id, c.depth + 1,
         c.path || ',' || e.target_id
  FROM vault_edges e
  JOIN connected c ON e.source_type = c.doc_type AND e.source_id = c.doc_id
  WHERE c.depth < ?3
    AND c.path NOT LIKE '%' || e.target_id || '%'
  UNION ALL
  -- Reverse edges
  SELECT e.source_type, e.source_id, c.depth + 1,
         c.path || ',' || e.source_id
  FROM vault_edges e
  JOIN connected c ON e.target_type = c.doc_type AND e.target_id = c.doc_id
  WHERE c.depth < ?3
    AND c.path NOT LIKE '%' || e.source_id || '%'
)
SELECT DISTINCT doc_type, doc_id, MIN(depth) as depth
FROM connected
GROUP BY doc_type, doc_id
ORDER BY depth;
```

### 5.2 Find Documents by Concept

```sql
SELECT cr.document_type, cr.document_id, cr.relationship, cr.confidence,
       CASE cr.document_type
         WHEN 'note' THEN (SELECT title FROM vault_notes WHERE id = cr.document_id)
         WHEN 'source' THEN (SELECT filename FROM vault_sources WHERE id = cr.document_id)
       END as title
FROM vault_concept_refs cr
WHERE cr.concept_id = ?
ORDER BY cr.confidence DESC;
```

### 5.3 Concept Neighborhood (for "show me everything related to X")

```sql
-- Find concept by name
WITH target_concept AS (
  SELECT id FROM vault_concepts WHERE name LIKE ? LIMIT 1
),
-- Find all documents referencing this concept
docs AS (
  SELECT document_type, document_id FROM vault_concept_refs
  WHERE concept_id = (SELECT id FROM target_concept)
),
-- Find all other concepts those documents reference
related_concepts AS (
  SELECT DISTINCT cr.concept_id, c.name, c.type, COUNT(*) as shared_docs
  FROM vault_concept_refs cr
  JOIN vault_concepts c ON c.id = cr.concept_id
  WHERE (cr.document_type, cr.document_id) IN (SELECT * FROM docs)
    AND cr.concept_id != (SELECT id FROM target_concept)
  GROUP BY cr.concept_id
  ORDER BY shared_docs DESC
  LIMIT 20
)
SELECT * FROM related_concepts;
```

---

## 6. Retrieval Pipeline Integration

### 6.1 Graph-Expanded Search

Modify `VaultService.searchForAgent()` to add a graph expansion step after initial embedding search.

**Current flow:**
```
Query → Embed → Score all chunks → Return top-K
```

**New flow:**
```
Query → Embed → Score all chunks → Take top-K as seed
  → Graph expand: follow vault_edges 1-2 hops from seed documents
  → Load chunks from expanded document set
  → Score expanded chunks against query embedding
  → Apply decay: hop_1 chunks get 0.85x, hop_2 get 0.70x
  → Merge with seed results, deduplicate, re-sort
  → Return top-K from merged set
```

**Implementation in `searchForAgent()`:**

```javascript
// After initial scoring...
const seedDocIds = scored.slice(0, 5).map(r => ({
  type: r.note_id ? 'note' : 'source',
  id: r.note_id || r.source_id,
}));

// Graph expansion (1-2 hops)
const expanded = this.expandViaGraph(db, seedDocIds, { maxDepth: 2, limit: 20 });

// Score expanded document chunks
for (const doc of expanded) {
  if (alreadyScored.has(doc.id)) continue;
  const chunks = db.prepare(
    'SELECT * FROM vault_chunks WHERE ?? = ? AND embedding IS NOT NULL'
  ).all(doc.type === 'note' ? 'note_id' : 'source_id', doc.id);

  for (const chunk of chunks) {
    const sim = cosineSimilarity(queryEmbedding, bufferToEmbedding(chunk.embedding));
    const decayedScore = sim * (doc.depth === 1 ? 0.85 : 0.70);
    if (decayedScore >= min_relevance) {
      scored.push({ ...chunk, score: decayedScore, via_graph: true });
    }
  }
}
```

### 6.2 Concept-Aware Search

When the query matches a known concept name (via FTS on `vault_concepts_fts`), pull all documents referencing that concept regardless of embedding similarity:

```javascript
// Check if query matches a concept
const conceptMatch = db.prepare(
  "SELECT id, name FROM vault_concepts WHERE name LIKE ? COLLATE NOCASE LIMIT 1"
).get(`%${queryTerms}%`);

if (conceptMatch) {
  const conceptDocs = db.prepare(`
    SELECT document_type, document_id, relationship, confidence
    FROM vault_concept_refs WHERE concept_id = ?
  `).all(conceptMatch.id);

  for (const doc of conceptDocs) {
    // Add with a concept-match score (boosted)
    conceptResults.push({
      ...doc,
      score: 0.75 * doc.confidence,  // Base score for concept match
      via_concept: conceptMatch.name,
    });
  }
}
```

### 6.3 Memory.js Integration

Modify `_searchVault()` in `memory.js` to pass a flag enabling graph expansion:

```javascript
async _searchVault(query, topK = 5) {
  const results = await VaultService.searchForAgent(this.db, query, {
    agent_id: this.appId,
    limit: topK,
    min_relevance: 0.40,
    mode: 'passive',
    graphExpand: true,    // ← NEW: enable graph expansion
    graphDepth: 1,        // ← Keep it shallow for passive retrieval
  });
  // ... rest unchanged
}
```

The `vault_search` active tool gets deeper expansion:

```javascript
// In route handler for POST /agent/search
graphExpand: true,
graphDepth: 2,           // Active search gets deeper graph traversal
```

### 6.4 Audit Trail

Extend `vault_agent_reads` to record when a result was found via graph expansion:

```sql
ALTER TABLE vault_agent_reads ADD COLUMN via_graph INTEGER DEFAULT 0;
ALTER TABLE vault_agent_reads ADD COLUMN via_concept_id TEXT;
```

This lets you see: "The agent found this document through the knowledge graph, not direct search."

---

## 7. Graph View Integration

### 7.1 Extended `getGraph()`

Currently returns only notes + wikilinks. Extend to:

```javascript
getGraph(db, { includeSource = true, edgeTypes = null } = {}) {
  // Notes as nodes
  const noteNodes = db.prepare(`
    SELECT id, title, slug, folder_id, is_daily, is_pinned, 'note' as node_type
    FROM vault_notes WHERE is_archived = 0
  `).all();

  // Sources as nodes (if enabled)
  const sourceNodes = includeSource ? db.prepare(`
    SELECT id, filename as title, file_extension, scope_id, 'source' as node_type
    FROM vault_sources WHERE is_stale = 0 AND extraction_status = 'extracted'
  `).all() : [];

  // Concept nodes (only those with 2+ references)
  const conceptNodes = db.prepare(`
    SELECT c.id, c.name as title, c.type, c.mention_count, 'concept' as node_type
    FROM vault_concepts c
    WHERE c.mention_count >= 2
  `).all();

  // All edge types: wikilinks + vault_edges
  const wikilinks = db.prepare(`...`).all();  // existing
  const graphEdges = db.prepare(`
    SELECT * FROM vault_edges
    ${edgeTypes ? `WHERE edge_type IN (${edgeTypes.map(() => '?').join(',')})` : ''}
  `).all(...(edgeTypes || []));

  // Concept reference edges (concept ↔ document)
  const conceptEdges = db.prepare(`
    SELECT concept_id, document_type, document_id, relationship
    FROM vault_concept_refs
    WHERE concept_id IN (SELECT id FROM vault_concepts WHERE mention_count >= 2)
  `).all();

  return {
    nodes: [...noteNodes, ...sourceNodes, ...conceptNodes],
    edges: [...wikilinks, ...graphEdges],
    conceptEdges,  // Rendered as lighter edges to concept nodes
  };
}
```

### 7.2 Visual Encoding

| Node Type | Shape | Default Color | Size |
|-----------|-------|---------------|------|
| Note | Circle | By folder (existing) | By connection count |
| Source (file) | Rounded square | By file extension | By connection count |
| Concept | Diamond | By concept type | By mention_count |

| Edge Type | Style | Color |
|-----------|-------|-------|
| Wikilink | Solid | White 12% opacity (existing) |
| Semantic | Dotted | White 8% opacity |
| References | Solid | Blue 20% |
| Implements | Solid, arrow | Green 20% |
| Contradicts | Dashed | Red 20% |
| Uses | Solid, arrow | Cyan 15% |
| Concept ref | Thin dotted | Purple 10% |

### 7.3 Graph Toolbar Additions

Add filters to the existing graph toolbar:

```
[Global] [Local]  |  Depth: [2▾]  |  Show: [Notes ✓] [Files ✓] [Concepts ✓]  |  Edges: [All▾]
```

---

## 8. API Surface

### 8.1 New Routes

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/vault/graph/rebuild-semantic` | Recompute all semantic edges. Body: `{ scope_id?, folder_id? }` |
| `POST` | `/api/vault/graph/analyze` | Run LLM concept extraction. Body: `{ scope_id?, folder_id?, limit? }` |
| `GET` | `/api/vault/graph/status` | Extraction status: documents analyzed, pending, edge counts |
| `GET` | `/api/vault/concepts` | List concepts. Params: `type, sort, limit, offset` |
| `GET` | `/api/vault/concepts/:id` | Concept detail with all referencing documents |
| `DELETE` | `/api/vault/concepts/:id` | Delete concept and its edges |
| `GET` | `/api/vault/concepts/search` | Search concepts by name. Params: `q, type, limit` |
| `GET` | `/api/vault/graph/neighborhood/:docType/:docId` | Graph neighborhood of a document (N hops) |

### 8.2 Modified Routes

| Route | Change |
|-------|--------|
| `GET /api/vault/graph` | Add `includeSource`, `edgeTypes` query params |
| `GET /api/vault/graph/:noteId` | Include source and concept nodes in local graph |
| `POST /api/vault/agent/search` | Add `graphExpand`, `graphDepth` body params |

---

## 9. Service Architecture

### 9.1 New File: `src/services/vault-graph.js`

`VaultGraphService` — static methods, `db` as first parameter.

| Method | Purpose |
|--------|---------|
| `computeDocumentEmbedding(db, docType, docId)` | Average chunk embeddings → L2 normalize |
| `computeSemanticEdges(db, docType, docId)` | Compare one document against all others, insert edges ≥ threshold |
| `rebuildSemanticEdges(db, filter)` | Full rebuild with batching and progress callback |
| `extractConcepts(db, docType, docId)` | LLM extraction for one document |
| `analyzeScope(db, scopeId, { limit, onProgress })` | Batch concept extraction for a scope |
| `analyzeFolder(db, folderId, { limit, onProgress })` | Batch concept extraction for a folder |
| `matchOrCreateConcept(db, name, type, description)` | Fuzzy dedup: find existing concept or create new |
| `buildConceptEdges(db, docType, docId)` | After extraction, create edges between documents sharing concepts |
| `expandViaGraph(db, seedDocs, { maxDepth, limit })` | Recursive CTE graph traversal returning connected documents |
| `getNeighborhood(db, docType, docId, depth)` | Full neighborhood with edges for graph view |
| `getStatus(db)` | Counts: documents total, analyzed, pending; edges by type; concepts by type |
| `pruneStaleEdges(db)` | Remove edges pointing to deleted/stale documents |

### 9.2 Modified Files

| File | Change |
|------|--------|
| `src/services/vault.js` | Add `graphExpand` path to `searchForAgent()` and `searchSemantic()` |
| `src/services/vault-indexer.js` | After `chunkAndEmbedSource()`, call `computeSemanticEdges()` |
| `src/assistant/memory.js` | Pass `graphExpand: true` to `_searchVault()` |
| `src/routes/vault.js` | Add new graph/concept routes |
| `src/renderer/vault.js` | Extend graph view to render 3 node types, edge types, filters, analyze button |
| `src/db/schema.js` | Add new tables |
| `src/services/index.js` | Export VaultGraphService |

---

## 10. Computation Costs

### 10.1 Semantic Edges

| Operation | Cost | Notes |
|-----------|------|-------|
| Document embedding | ~2ms | Average of existing chunk embeddings, no model call |
| Pairwise comparison (1 vs all) | O(n) × ~0.01ms per comparison | 10k docs = ~100ms |
| Full rebuild (10k docs) | ~15 minutes | O(n²/2) comparisons, batched with yielding |
| Incremental (1 new doc) | ~200ms | Compare against all existing |

### 10.2 Concept Extraction

| Operation | Cost | Notes |
|-----------|------|-------|
| LLM call per document | ~1-3 seconds (Haiku) | ~$0.0003 per doc at ~2k input tokens |
| Full scope (200 files) | ~5-10 minutes | Batched, 20 at a time with pauses |
| Concept matching | ~5ms per concept | FTS + embedding similarity |
| Edge creation | ~10ms per document | After extraction, create concept-mediated edges |

### 10.3 Graph Traversal

| Query | Cost | Notes |
|-------|------|-------|
| 2-hop expansion from 5 seed docs | ~5ms | Recursive CTE, indexed |
| Concept search + document lookup | ~2ms | FTS on concept names |
| Full graph load (1k nodes, 5k edges) | ~20ms | Single query + JSON serialization |

---

## 11. Configuration

Add to vault settings:

```json
{
  "vault": {
    "graph_semantic_threshold": 0.60,
    "graph_semantic_max_edges_per_doc": 10,
    "graph_expand_depth_passive": 1,
    "graph_expand_depth_active": 2,
    "graph_expand_decay_hop1": 0.85,
    "graph_expand_decay_hop2": 0.70,
    "graph_concept_extraction_model": "haiku",
    "graph_concept_min_doc_words": 100,
    "graph_auto_semantic_edges": true,
    "graph_auto_concept_extraction": false
  }
}
```

---

## 12. Implementation Phases

### Phase 9A: Schema + Semantic Edges

1. Add new tables to `src/db/schema.js`
2. Create `src/services/vault-graph.js` with semantic edge methods
3. Hook into `vault-indexer.js` post-indexing pipeline
4. Hook into `VaultService.updateNote()` for note changes
5. Add `POST /api/vault/graph/rebuild-semantic` route
6. Update `getGraph()` to include sources + semantic edges
7. Update renderer graph view to show source nodes with file-type styling

**Delivers:** Graph view shows all documents (notes + files) connected by topical similarity. Works immediately with existing embeddings.

### Phase 9B: Concept Extraction

1. Add concept extraction prompt + LLM call to `VaultGraphService`
2. Concept fuzzy matching + dedup logic
3. Concept-mediated edge creation
4. `POST /api/vault/graph/analyze` route with progress
5. Concept list/search/detail routes
6. UI: "Analyze" button on scope, progress indicator
7. Update graph view to show concept nodes (diamond shape)

**Delivers:** Rich, labeled connections between documents. Named concepts as navigable entities.

### Phase 9C: Retrieval Integration

1. Add `expandViaGraph()` to `VaultService.searchForAgent()`
2. Add concept-aware search path
3. Modify `memory.js` Tier 4 to enable graph expansion
4. Extend audit logging with `via_graph` / `via_concept_id`
5. Agent transparency: cite graph paths in source attribution

**Delivers:** Agents find structurally related content they couldn't find before. The knowledge graph actively improves retrieval quality.

### Phase 9D: Graph View Polish

1. Three node types with distinct shapes/colors
2. Edge type visual encoding (solid/dotted/dashed, colors)
3. Toolbar filters: node types, edge types
4. Concept detail panel (click concept → see all documents)
5. "Related to this note" in inspector (powered by graph neighborhood)

**Delivers:** The graph is a real exploration tool, not just a visualization.

---

## 13. What's Out of Scope

| Feature | Why deferred |
|---------|-------------|
| Graph database (Neo4j) | SQLite recursive CTEs handle the scale. Adding a server process is wrong for a desktop app. |
| Real-time file watching for edge updates | Same reason as vault spec: file watchers are unreliable. Rescan + rebuild on demand. |
| Cross-vault concept sharing | Single vault per OS8 instance. |
| Concept hierarchy/taxonomy | Flat concept space is sufficient. Hierarchy adds complexity with marginal benefit at this scale. |
| Community detection (Louvain) | Nice-to-have for graph clustering. Can be added later with `graphology` if needed. |
| PageRank for concept importance | `mention_count` is a good-enough proxy. |
