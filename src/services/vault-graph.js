/**
 * VaultGraphService — Knowledge Graph Layer
 *
 * Computes and manages relationships between vault documents (notes + indexed files).
 * Two edge types:
 *   - semantic: auto-discovered similarity from existing embeddings
 *   - concept-mediated: LLM-extracted (Phase 9B, not yet implemented)
 *
 * All methods are static with `db` as first parameter.
 */

const { generateId } = require('../utils');
const { bufferToEmbedding, embeddingToBuffer, cosineSimilarity } = require('../assistant/memory-embeddings');

// ============================================================
// Internal helpers
// ============================================================

/**
 * Compute a document-level embedding by averaging its chunk embeddings.
 * Returns null if the document has no embedded chunks.
 */
function computeDocumentEmbedding(db, docType, docId) {
  const colName = docType === 'note' ? 'note_id' : 'source_id';
  const chunks = db.prepare(
    `SELECT embedding FROM vault_chunks WHERE ${colName} = ? AND embedding IS NOT NULL`
  ).all(docId);

  if (!chunks.length) return null;

  // Average embeddings
  const dim = 384;
  const avg = new Float32Array(dim);
  for (const chunk of chunks) {
    const emb = bufferToEmbedding(chunk.embedding);
    for (let i = 0; i < dim; i++) {
      avg[i] += emb[i];
    }
  }

  // Normalize: divide by count, then L2-normalize
  const count = chunks.length;
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    avg[i] /= count;
    norm += avg[i] * avg[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) {
      avg[i] /= norm;
    }
  }

  return avg;
}

/**
 * Load all document embeddings into a Map.
 * Key: "note:{id}" or "source:{id}", Value: Float32Array
 */
function loadAllDocumentEmbeddings(db, { scope_id = null } = {}) {
  const docMap = new Map();

  // Group note chunks by note_id (skip if scope-bounded — notes don't belong to scopes)
  if (!scope_id) {
    const noteChunks = db.prepare(`
      SELECT c.note_id, c.embedding
      FROM vault_chunks c
      JOIN vault_notes n ON n.id = c.note_id
      WHERE c.embedding IS NOT NULL AND c.note_id IS NOT NULL AND n.is_archived = 0
    `).all();

    const noteGroups = new Map();
    for (const c of noteChunks) {
      if (!noteGroups.has(c.note_id)) noteGroups.set(c.note_id, []);
      noteGroups.get(c.note_id).push(bufferToEmbedding(c.embedding));
    }

    for (const [noteId, embeddings] of noteGroups) {
      const avg = averageEmbeddings(embeddings);
      if (avg) docMap.set(`note:${noteId}`, { type: 'note', id: noteId, embedding: avg });
    }
  }

  // Group source chunks by source_id (optionally filtered by scope)
  const sourceQuery = scope_id
    ? `SELECT c.source_id, c.embedding
       FROM vault_chunks c
       JOIN vault_sources s ON s.id = c.source_id
       WHERE c.embedding IS NOT NULL AND c.source_id IS NOT NULL
         AND s.is_stale = 0 AND s.extraction_status = 'extracted' AND s.scope_id = ?`
    : `SELECT c.source_id, c.embedding
       FROM vault_chunks c
       JOIN vault_sources s ON s.id = c.source_id
       WHERE c.embedding IS NOT NULL AND c.source_id IS NOT NULL
         AND s.is_stale = 0 AND s.extraction_status = 'extracted'`;

  const sourceChunks = scope_id
    ? db.prepare(sourceQuery).all(scope_id)
    : db.prepare(sourceQuery).all();

  const sourceGroups = new Map();
  for (const c of sourceChunks) {
    if (!sourceGroups.has(c.source_id)) sourceGroups.set(c.source_id, []);
    sourceGroups.get(c.source_id).push(bufferToEmbedding(c.embedding));
  }

  for (const [sourceId, embeddings] of sourceGroups) {
    const avg = averageEmbeddings(embeddings);
    if (avg) docMap.set(`source:${sourceId}`, { type: 'source', id: sourceId, embedding: avg });
  }

  return docMap;
}

/**
 * Average an array of Float32Arrays and L2-normalize.
 */
function averageEmbeddings(embeddings) {
  if (!embeddings.length) return null;
  const dim = 384;
  const avg = new Float32Array(dim);
  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) avg[i] += emb[i];
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    avg[i] /= embeddings.length;
    norm += avg[i] * avg[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) avg[i] /= norm;
  }
  return avg;
}

// ============================================================
// VaultGraphService
// ============================================================

const VaultGraphService = {

  // ----------------------------------------------------------
  // Semantic edge computation
  // ----------------------------------------------------------

  /**
   * Compute semantic edges for a single document against all others.
   * Deletes existing semantic edges for this doc, inserts new ones above threshold.
   */
  computeSemanticEdgesForDocument(db, docType, docId, { threshold = 0.60, maxEdges = 10 } = {}) {
    const docEmbedding = computeDocumentEmbedding(db, docType, docId);
    if (!docEmbedding) return 0;

    // Load all other document embeddings
    const allDocs = loadAllDocumentEmbeddings(db);
    const selfKey = `${docType}:${docId}`;

    // Score against all others
    const candidates = [];
    for (const [key, doc] of allDocs) {
      if (key === selfKey) continue;
      const score = cosineSimilarity(docEmbedding, doc.embedding);
      if (score >= threshold) {
        candidates.push({ type: doc.type, id: doc.id, score });
      }
    }

    // Sort and keep top N
    candidates.sort((a, b) => b.score - a.score);
    const topEdges = candidates.slice(0, maxEdges);

    // Delete existing semantic edges for this document (both directions)
    db.prepare(`
      DELETE FROM vault_edges
      WHERE edge_type = 'semantic'
        AND ((source_type = ? AND source_id = ?) OR (target_type = ? AND target_id = ?))
    `).run(docType, docId, docType, docId);

    // Insert new edges
    const insert = db.prepare(`
      INSERT OR IGNORE INTO vault_edges (id, source_type, source_id, target_type, target_id, edge_type, score)
      VALUES (?, ?, ?, ?, ?, 'semantic', ?)
    `);

    let created = 0;
    for (const edge of topEdges) {
      insert.run(generateId(), docType, docId, edge.type, edge.id, Math.round(edge.score * 1000) / 1000);
      created++;
    }

    // Update graph status
    db.prepare(`
      INSERT OR REPLACE INTO vault_graph_status (document_type, document_id, semantic_edges_at)
      VALUES (?, ?, datetime('now'))
    `).run(docType, docId);

    return created;
  },

  /**
   * Rebuild all semantic edges across all documents.
   * Precomputes all embeddings first for efficiency, then does pairwise comparison.
   */
  async rebuildAllSemanticEdges(db, { threshold = 0.60, maxEdges = 10, scope_id = null, onProgress } = {}) {
    const allDocs = loadAllDocumentEmbeddings(db, { scope_id });
    const docList = [...allDocs.values()];
    const total = docList.length;

    if (total === 0) return { documentsProcessed: 0, edgesCreated: 0 };

    // Clear existing semantic edges (scope-bounded or all)
    if (scope_id) {
      // Only delete edges involving sources in this scope
      const scopeSourceIds = db.prepare(
        'SELECT id FROM vault_sources WHERE scope_id = ?'
      ).all(scope_id).map(r => r.id);
      if (scopeSourceIds.length > 0) {
        const placeholders = scopeSourceIds.map(() => '?').join(',');
        db.prepare(`
          DELETE FROM vault_edges WHERE edge_type = 'semantic'
            AND ((source_type = 'source' AND source_id IN (${placeholders}))
              OR (target_type = 'source' AND target_id IN (${placeholders})))
        `).run(...scopeSourceIds, ...scopeSourceIds);
      }
    } else {
      db.prepare("DELETE FROM vault_edges WHERE edge_type = 'semantic'").run();
    }

    const insert = db.prepare(`
      INSERT OR IGNORE INTO vault_edges (id, source_type, source_id, target_type, target_id, edge_type, score)
      VALUES (?, ?, ?, ?, ?, 'semantic', ?)
    `);

    const statusInsert = db.prepare(`
      INSERT OR REPLACE INTO vault_graph_status (document_type, document_id, semantic_edges_at)
      VALUES (?, ?, datetime('now'))
    `);

    let edgesCreated = 0;
    let processed = 0;
    let compCount = 0;

    for (let i = 0; i < docList.length; i++) {
      const doc = docList[i];
      const candidates = [];

      for (let j = 0; j < docList.length; j++) {
        if (i === j) continue;
        const other = docList[j];
        const score = cosineSimilarity(doc.embedding, other.embedding);
        if (score >= threshold) {
          candidates.push({ type: other.type, id: other.id, score });
        }
        // Yield every 500 comparisons to keep the event loop responsive
        compCount++;
        if (compCount % 500 === 0) {
          await new Promise(r => setImmediate(r));
        }
      }

      candidates.sort((a, b) => b.score - a.score);
      for (const edge of candidates.slice(0, maxEdges)) {
        insert.run(generateId(), doc.type, doc.id, edge.type, edge.id, Math.round(edge.score * 1000) / 1000);
        edgesCreated++;
      }

      statusInsert.run(doc.type, doc.id);
      processed++;

      if (processed % 50 === 0) {
        if (onProgress) onProgress({ processed, total });
      }
    }

    if (onProgress) onProgress({ processed: total, total });
    return { documentsProcessed: total, edgesCreated };
  },

  // ----------------------------------------------------------
  // Graph traversal
  // ----------------------------------------------------------

  /**
   * Expand from seed documents via vault_edges (both directions).
   * Returns connected documents within maxDepth hops.
   */
  expandViaGraph(db, seedDocs, { maxDepth = 2, limit = 20 } = {}) {
    if (!seedDocs.length) return [];

    const results = [];
    const visited = new Set(seedDocs.map(d => `${d.type}:${d.id}`));
    let frontier = seedDocs.map(d => ({ doc_type: d.type, doc_id: d.id, depth: 0 }));

    for (let depth = 1; depth <= maxDepth; depth++) {
      const nextFrontier = [];

      for (const node of frontier) {
        // Forward edges
        const forward = db.prepare(`
          SELECT target_type as doc_type, target_id as doc_id, edge_type, score
          FROM vault_edges
          WHERE source_type = ? AND source_id = ?
        `).all(node.doc_type, node.doc_id);

        // Reverse edges
        const reverse = db.prepare(`
          SELECT source_type as doc_type, source_id as doc_id, edge_type, score
          FROM vault_edges
          WHERE target_type = ? AND target_id = ?
        `).all(node.doc_type, node.doc_id);

        for (const edge of [...forward, ...reverse]) {
          const key = `${edge.doc_type}:${edge.doc_id}`;
          if (visited.has(key)) continue;
          visited.add(key);

          const result = { doc_type: edge.doc_type, doc_id: edge.doc_id, depth, edge_type: edge.edge_type, score: edge.score };
          results.push(result);
          nextFrontier.push(result);

          if (results.length >= limit) break;
        }
        if (results.length >= limit) break;
      }

      frontier = nextFrontier;
      if (frontier.length === 0 || results.length >= limit) break;
    }

    return results.slice(0, limit);
  },

  // ----------------------------------------------------------
  // Graph data for visualization
  // ----------------------------------------------------------

  /**
   * Get full graph data including sources and semantic edges.
   */
  getGraphWithEdges(db, { includeSources = true, scope_id = null, notesOnly = false, edgeTypes = null } = {}) {
    // Notes-only mode: just notes + wikilinks
    if (notesOnly) {
      const noteNodes = db.prepare(`
        SELECT id, title, slug, folder_id, is_daily, is_pinned, 'note' as node_type
        FROM vault_notes WHERE is_archived = 0
      `).all();
      const wikilinkEdges = db.prepare(`
        SELECT id, source_note_id, target_note_id, link_type, 'wikilink' as edge_type
        FROM vault_links
      `).all().map(e => ({
        id: e.id, source_type: 'note', source_id: e.source_note_id,
        target_type: 'note', target_id: e.target_note_id, edge_type: 'wikilink', score: 1.0,
      }));
      return { nodes: noteNodes, edges: wikilinkEdges };
    }

    // Note nodes (skip if scope-bounded — only show that scope's files)
    const noteNodes = scope_id ? [] : db.prepare(`
      SELECT id, title, slug, folder_id, is_daily, is_pinned, 'note' as node_type
      FROM vault_notes WHERE is_archived = 0
    `).all();

    // Source nodes (optionally filtered by scope)
    let sourceNodes = [];
    if (includeSources) {
      sourceNodes = scope_id
        ? db.prepare(`
            SELECT id, filename as title, file_extension, scope_id, 'source' as node_type
            FROM vault_sources WHERE is_stale = 0 AND extraction_status = 'extracted' AND scope_id = ?
          `).all(scope_id)
        : db.prepare(`
            SELECT id, filename as title, file_extension, scope_id, 'source' as node_type
            FROM vault_sources WHERE is_stale = 0 AND extraction_status = 'extracted'
          `).all();
    }

    // Build set of valid node IDs for edge filtering
    const validIds = new Set([...noteNodes, ...sourceNodes].map(n => n.id));

    // Wikilink edges (only if notes are included)
    const wikilinkEdges = scope_id ? [] : db.prepare(`
      SELECT id, source_note_id, target_note_id, link_type, 'wikilink' as edge_type
      FROM vault_links
    `).all().map(e => ({
      id: e.id, source_type: 'note', source_id: e.source_note_id,
      target_type: 'note', target_id: e.target_note_id, edge_type: 'wikilink', score: 1.0,
    }));

    // Graph edges — filter to only edges between valid nodes
    let graphEdges;
    if (edgeTypes) {
      const placeholders = edgeTypes.map(() => '?').join(',');
      graphEdges = db.prepare(
        `SELECT * FROM vault_edges WHERE edge_type IN (${placeholders})`
      ).all(...edgeTypes);
    } else {
      graphEdges = db.prepare('SELECT * FROM vault_edges').all();
    }

    // Filter edges to only connect nodes in the current view
    graphEdges = graphEdges.filter(e =>
      validIds.has(e.source_id) && validIds.has(e.target_id)
    );

    return {
      nodes: [...noteNodes, ...sourceNodes],
      edges: [...wikilinkEdges, ...graphEdges],
    };
  },

  /**
   * Get local graph centered on a document, following both vault_links and vault_edges.
   */
  getLocalGraphWithEdges(db, docType, docId, depth = 2) {
    const visited = new Set();
    const nodes = [];
    const edges = [];

    const queue = [{ type: docType, id: docId, d: 0 }];

    while (queue.length > 0) {
      const { type, id, d } = queue.shift();
      const key = `${type}:${id}`;
      if (visited.has(key)) continue;
      visited.add(key);

      // Load node
      if (type === 'note') {
        const note = db.prepare(
          "SELECT id, title, slug, folder_id, is_daily, is_pinned, 'note' as node_type FROM vault_notes WHERE id = ?"
        ).get(id);
        if (note) nodes.push(note);
      } else {
        const source = db.prepare(
          "SELECT id, filename as title, file_extension, scope_id, 'source' as node_type FROM vault_sources WHERE id = ?"
        ).get(id);
        if (source) nodes.push(source);
      }

      if (d < depth) {
        // Wikilinks (if note)
        if (type === 'note') {
          const outLinks = db.prepare('SELECT * FROM vault_links WHERE source_note_id = ?').all(id);
          const inLinks = db.prepare('SELECT * FROM vault_links WHERE target_note_id = ?').all(id);
          for (const link of outLinks) {
            edges.push({ ...link, source_type: 'note', source_id: link.source_note_id, target_type: 'note', target_id: link.target_note_id, edge_type: 'wikilink', score: 1.0 });
            queue.push({ type: 'note', id: link.target_note_id, d: d + 1 });
          }
          for (const link of inLinks) {
            edges.push({ ...link, source_type: 'note', source_id: link.source_note_id, target_type: 'note', target_id: link.target_note_id, edge_type: 'wikilink', score: 1.0 });
            queue.push({ type: 'note', id: link.source_note_id, d: d + 1 });
          }
        }

        // Graph edges (both directions)
        const forward = db.prepare(
          'SELECT * FROM vault_edges WHERE source_type = ? AND source_id = ?'
        ).all(type, id);
        const reverse = db.prepare(
          'SELECT * FROM vault_edges WHERE target_type = ? AND target_id = ?'
        ).all(type, id);

        for (const edge of forward) {
          edges.push(edge);
          queue.push({ type: edge.target_type, id: edge.target_id, d: d + 1 });
        }
        for (const edge of reverse) {
          edges.push(edge);
          queue.push({ type: edge.source_type, id: edge.source_id, d: d + 1 });
        }
      }
    }

    // Deduplicate edges
    const edgeMap = new Map();
    for (const e of edges) edgeMap.set(e.id, e);

    return { nodes, edges: [...edgeMap.values()] };
  },

  // ----------------------------------------------------------
  // Status & maintenance
  // ----------------------------------------------------------

  getStatus(db) {
    const totalNotes = db.prepare("SELECT COUNT(*) as n FROM vault_notes WHERE is_archived = 0").get().n;
    const totalSources = db.prepare("SELECT COUNT(*) as n FROM vault_sources WHERE is_stale = 0 AND extraction_status = 'extracted'").get().n;
    const docsWithEdges = db.prepare("SELECT COUNT(DISTINCT document_id) as n FROM vault_graph_status WHERE semantic_edges_at IS NOT NULL").get().n;
    const edgesByType = db.prepare("SELECT edge_type, COUNT(*) as n FROM vault_edges GROUP BY edge_type").all();
    const totalEdges = db.prepare("SELECT COUNT(*) as n FROM vault_edges").get().n;
    const totalConcepts = db.prepare("SELECT COUNT(*) as n FROM vault_concepts").get().n;

    return {
      documents: { notes: totalNotes, sources: totalSources, total: totalNotes + totalSources },
      analyzed: docsWithEdges,
      pending: (totalNotes + totalSources) - docsWithEdges,
      edges: { total: totalEdges, byType: Object.fromEntries(edgesByType.map(r => [r.edge_type, r.n])) },
      concepts: totalConcepts,
    };
  },

  pruneStaleEdges(db) {
    // Remove edges pointing to archived notes
    db.prepare(`
      DELETE FROM vault_edges WHERE
        (source_type = 'note' AND source_id IN (SELECT id FROM vault_notes WHERE is_archived = 1))
        OR (target_type = 'note' AND target_id IN (SELECT id FROM vault_notes WHERE is_archived = 1))
    `).run();

    // Remove edges pointing to stale sources
    db.prepare(`
      DELETE FROM vault_edges WHERE
        (source_type = 'source' AND source_id IN (SELECT id FROM vault_sources WHERE is_stale = 1))
        OR (target_type = 'source' AND target_id IN (SELECT id FROM vault_sources WHERE is_stale = 1))
    `).run();

    // Remove orphaned graph status entries
    db.prepare(`
      DELETE FROM vault_graph_status WHERE
        (document_type = 'note' AND document_id NOT IN (SELECT id FROM vault_notes))
        OR (document_type = 'source' AND document_id NOT IN (SELECT id FROM vault_sources))
    `).run();
  },
};

module.exports = VaultGraphService;
