/**
 * Vault API routes — /api/vault
 *
 * Notes, folders, tags, links, versions, graph.
 */

const express = require('express');

/**
 * Build YAML frontmatter string for note export.
 */
function buildFrontmatter(note, tagNames) {
  const entries = [];
  if (tagNames && tagNames.length) {
    entries.push('tags:');
    for (const t of tagNames) entries.push(`  - ${t}`);
  }
  if (note.created_at) entries.push(`created: ${note.created_at}`);
  if (note.updated_at) entries.push(`updated: ${note.updated_at}`);
  if (note.is_pinned) entries.push('pinned: true');
  if (note.is_daily && note.daily_date) entries.push(`daily_date: ${note.daily_date}`);
  if (!entries.length) return '';
  return '---\n' + entries.join('\n') + '\n---';
}

function createVaultRouter(db, deps) {
  const { VaultService, VaultIndexerService, VaultGraphService } = deps;
  const router = express.Router();

  // ===========================================================
  // Notes
  // ===========================================================

  router.get('/notes/daily/:date', (req, res) => {
    try {
      const note = VaultService.getDailyNote(db, req.params.date);
      if (!note) return res.status(404).json({ error: 'Daily note not found' });
      res.json(note);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/notes/daily', (req, res) => {
    try {
      const note = VaultService.getOrCreateDailyNote(db, req.query.date || null);
      res.json(note);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/notes', (req, res) => {
    try {
      const result = VaultService.listNotes(db, req.query);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/notes/:id', (req, res) => {
    try {
      const note = VaultService.getNote(db, req.params.id);
      if (!note) return res.status(404).json({ error: 'Note not found' });
      res.json(note);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/notes', (req, res) => {
    try {
      const { title, content, folder_id, tags, template_id } = req.body;
      if (!title) return res.status(400).json({ error: 'Title is required' });
      const note = VaultService.createNote(db, { title, content, folder_id, tags });
      res.status(201).json(note);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.patch('/notes/:id', (req, res) => {
    try {
      const note = VaultService.updateNote(db, req.params.id, req.body);
      res.json(note);
    } catch (e) {
      if (e.message === 'Note not found') return res.status(404).json({ error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  router.delete('/notes/:id', (req, res) => {
    try {
      VaultService.deleteNote(db, req.params.id, { hard: req.query.hard === 'true' });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Versions
  router.get('/notes/:id/versions', (req, res) => {
    try {
      const versions = VaultService.getVersions(db, req.params.id);
      res.json(versions);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/notes/:id/restore/:versionId', (req, res) => {
    try {
      const note = VaultService.restoreVersion(db, req.params.id, req.params.versionId);
      res.json(note);
    } catch (e) {
      if (e.message === 'Version not found') return res.status(404).json({ error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  // Backlinks
  router.get('/notes/:id/backlinks', (req, res) => {
    try {
      const backlinks = VaultService.getBacklinks(db, req.params.id);
      res.json(backlinks);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Note tags
  router.post('/notes/:id/tags', (req, res) => {
    try {
      const { tag_ids } = req.body;
      if (!Array.isArray(tag_ids)) return res.status(400).json({ error: 'tag_ids array is required' });
      VaultService.addTagsToNote(db, req.params.id, tag_ids);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.delete('/notes/:id/tags/:tagId', (req, res) => {
    try {
      VaultService.removeTagFromNote(db, req.params.id, req.params.tagId);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ===========================================================
  // Folders
  // ===========================================================

  router.get('/folders', (req, res) => {
    try {
      const folders = VaultService.listFolders(db);
      res.json(folders);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/folders', (req, res) => {
    try {
      const { name, parent_id, icon } = req.body;
      if (!name) return res.status(400).json({ error: 'Folder name is required' });
      const folder = VaultService.createFolder(db, { name, parent_id, icon });
      res.status(201).json(folder);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.patch('/folders/:id', (req, res) => {
    try {
      const folder = VaultService.updateFolder(db, req.params.id, req.body);
      res.json(folder);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.delete('/folders/:id', (req, res) => {
    try {
      VaultService.deleteFolder(db, req.params.id);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ===========================================================
  // Tags
  // ===========================================================

  router.get('/tags', (req, res) => {
    try {
      const tags = VaultService.listTags(db);
      res.json(tags);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/tags', (req, res) => {
    try {
      const { name, color } = req.body;
      if (!name) return res.status(400).json({ error: 'Tag name is required' });
      const tag = VaultService.createTag(db, { name, color });
      res.status(201).json(tag);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.patch('/tags/:id', (req, res) => {
    try {
      const tag = VaultService.updateTag(db, req.params.id, req.body);
      res.json(tag);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.delete('/tags/:id', (req, res) => {
    try {
      VaultService.deleteTag(db, req.params.id);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ===========================================================
  // Templates
  // ===========================================================

  // Seed default templates on first load
  VaultService.seedDefaultTemplates(db);

  router.get('/templates', (req, res) => {
    try {
      const templates = VaultService.listTemplates(db);
      res.json(templates);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/templates/:id', (req, res) => {
    try {
      const template = VaultService.getTemplate(db, req.params.id);
      if (!template) return res.status(404).json({ error: 'Template not found' });
      res.json(template);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/templates', (req, res) => {
    try {
      const { name, content } = req.body;
      if (!name) return res.status(400).json({ error: 'Template name is required' });
      const template = VaultService.createTemplate(db, { name, content });
      res.status(201).json(template);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.patch('/templates/:id', (req, res) => {
    try {
      const template = VaultService.updateTemplate(db, req.params.id, req.body);
      res.json(template);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.delete('/templates/:id', (req, res) => {
    try {
      VaultService.deleteTemplate(db, req.params.id);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ===========================================================
  // Links & Graph
  // ===========================================================

  router.post('/links', (req, res) => {
    try {
      const { source_note_id, target_note_id, link_type, context } = req.body;
      if (!source_note_id || !target_note_id) {
        return res.status(400).json({ error: 'source_note_id and target_note_id are required' });
      }
      const link = VaultService.createLink(db, { source_note_id, target_note_id, link_type, context });
      res.status(201).json(link);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.delete('/links/:id', (req, res) => {
    try {
      VaultService.deleteLink(db, req.params.id);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/graph', (req, res) => {
    try {
      const includeSources = req.query.includeSources !== 'false';
      const scope_id = req.query.scope_id || null;
      const notesOnly = req.query.notesOnly === 'true';
      const graph = VaultGraphService
        ? VaultGraphService.getGraphWithEdges(db, { includeSources, scope_id, notesOnly })
        : VaultService.getGraph(db);
      res.json(graph);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/graph/:noteId', (req, res) => {
    try {
      const depth = parseInt(req.query.depth) || 2;
      const docType = req.query.docType || 'note';
      const graph = VaultGraphService
        ? VaultGraphService.getLocalGraphWithEdges(db, docType, req.params.noteId, Math.min(depth, 3))
        : VaultService.getLocalGraph(db, req.params.noteId, Math.min(depth, 3));
      res.json(graph);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/graph/rebuild-semantic', async (req, res) => {
    try {
      if (!VaultGraphService) return res.status(501).json({ error: 'Graph service not available' });
      const { scope_id } = req.body || {};
      res.json({ status: 'started' });
      // Run in background — don't block the response
      VaultGraphService.rebuildAllSemanticEdges(db, {
        threshold: 0.60,
        maxEdges: 10,
        scope_id: scope_id || null,
      }).then(result => {
        console.log(`[Vault] Semantic edges rebuilt: ${result.edgesCreated} edges across ${result.documentsProcessed} documents`);
      }).catch(err => {
        console.error('[Vault] Semantic edge rebuild failed:', err.message);
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/graph/status', (req, res) => {
    try {
      if (!VaultGraphService) return res.json({ documents: {}, edges: {}, concepts: 0 });
      res.json(VaultGraphService.getStatus(db));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ===========================================================
  // Search
  // ===========================================================

  router.get('/search', async (req, res) => {
    try {
      const { q, mode, folder_id, tag, is_daily, is_archived, limit, offset } = req.query;
      if (!q) return res.status(400).json({ error: 'Query parameter q is required' });

      const result = await VaultService.search(db, q, {
        mode: mode || 'hybrid',
        folder_id,
        tag,
        is_daily: is_daily !== undefined ? parseInt(is_daily) : undefined,
        is_archived: is_archived !== undefined ? parseInt(is_archived) : undefined,
        limit: parseInt(limit) || 20,
        offset: parseInt(offset) || 0,
      });

      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ===========================================================
  // Scopes (filesystem indexing)
  // ===========================================================

  router.get('/scopes', (req, res) => {
    try {
      const scopes = VaultService.listScopes(db);
      res.json(scopes);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/scopes', (req, res) => {
    try {
      const { path: scopePath, label, recursive, file_extensions } = req.body;
      if (!scopePath) return res.status(400).json({ error: 'path is required' });
      const scope = VaultService.createScope(db, { path: scopePath, label, recursive, file_extensions });
      res.status(201).json(scope);

      // Trigger initial scan in the background
      VaultIndexerService.scanScope(db, scope.id).catch(err =>
        console.error('[Vault] Initial scope scan failed:', err.message)
      );
    } catch (e) {
      if (e.message.includes('already indexed') || e.message.includes('does not exist') ||
          e.message.includes('system directories') || e.message.includes('not a directory')) {
        return res.status(400).json({ error: e.message });
      }
      res.status(500).json({ error: e.message });
    }
  });

  router.patch('/scopes/:id', (req, res) => {
    try {
      const scope = VaultService.updateScope(db, req.params.id, req.body);
      res.json(scope);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.delete('/scopes/:id', (req, res) => {
    try {
      VaultIndexerService.removeScope(db, req.params.id);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/scopes/:id/rescan', (req, res) => {
    try {
      res.json({ status: 'scanning' });
      VaultIndexerService.scanScope(db, req.params.id).catch(err =>
        console.error('[Vault] Rescan error:', err.message)
      );
    } catch (e) {
      if (!res.headersSent) {
        res.status(500).json({ error: e.message });
      }
    }
  });

  // ===========================================================
  // Sources (indexed files)
  // ===========================================================

  router.get('/sources', (req, res) => {
    try {
      const result = VaultService.listSources(db, req.query);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/sources/:id', (req, res) => {
    try {
      const source = VaultService.getSource(db, req.params.id);
      if (!source) return res.status(404).json({ error: 'Source not found' });
      res.json(source);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.delete('/sources/:id', (req, res) => {
    try {
      VaultIndexerService.removeSource(db, req.params.id);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ===========================================================
  // Index status
  // ===========================================================

  router.get('/index/status', (req, res) => {
    try {
      res.json(VaultIndexerService.getStatus());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ===========================================================
  // Agent Integration
  // ===========================================================

  router.post('/agent/search', async (req, res) => {
    try {
      const { query, agent_id, conversation_id, folder_id, tag, limit } = req.body;
      if (!query) return res.status(400).json({ error: 'query is required' });
      if (!agent_id) return res.status(400).json({ error: 'agent_id is required' });

      const results = await VaultService.searchForAgent(db, query, {
        agent_id,
        conversation_id,
        folder_id,
        tag,
        limit: limit ? parseInt(limit) : 5,
        mode: 'active',
      });

      res.json({ results });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/agent/inject', (req, res) => {
    try {
      const { agent_id, agent_name, title, content, folder_id } = req.body;
      if (!agent_id) return res.status(400).json({ error: 'agent_id is required' });
      if (!agent_name) return res.status(400).json({ error: 'agent_name is required' });
      if (!title) return res.status(400).json({ error: 'title is required' });

      const note = VaultService.injectAgentNote(db, { agent_id, agent_name, title, content, folder_id });
      res.status(201).json(note);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/agent/reads/:agentId', (req, res) => {
    try {
      const result = VaultService.getAgentReads(db, req.params.agentId, {
        limit: parseInt(req.query.limit) || 50,
        offset: parseInt(req.query.offset) || 0,
      });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ===========================================================
  // Import
  // ===========================================================

  router.post('/import/markdown', (req, res) => {
    try {
      const { path: dirPath } = req.body;
      if (!dirPath) return res.status(400).json({ error: 'path is required' });

      const status = VaultService.getImportStatus();
      if (status.isImporting) return res.status(409).json({ error: 'An import is already in progress' });

      res.json({ status: 'started' });

      // Run in background
      VaultService.importMarkdownDirectory(db, dirPath).catch(err =>
        console.error('[Vault] Markdown import error:', err.message)
      );
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/import/obsidian', (req, res) => {
    try {
      const { path: dirPath } = req.body;
      if (!dirPath) return res.status(400).json({ error: 'path is required' });

      const status = VaultService.getImportStatus();
      if (status.isImporting) return res.status(409).json({ error: 'An import is already in progress' });

      res.json({ status: 'started' });

      // Run in background
      VaultService.importObsidianVault(db, dirPath).catch(err =>
        console.error('[Vault] Obsidian import error:', err.message)
      );
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/import/status', (req, res) => {
    try {
      res.json(VaultService.getImportStatus());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ===========================================================
  // Export
  // ===========================================================

  router.get('/export/:folderId', (req, res) => {
    try {
      const archiver = require('archiver');
      const data = VaultService.exportVault(db, { folderId: req.params.folderId });

      const date = new Date().toISOString().slice(0, 10);
      res.set('Content-Type', 'application/zip');
      res.set('Content-Disposition', `attachment; filename="vault-export-${date}.zip"`);

      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.on('error', (err) => { if (!res.headersSent) res.status(500).json({ error: err.message }); });
      archive.pipe(res);

      for (const note of data.notes) {
        const frontmatter = buildFrontmatter(note, note.tagNames);
        const content = frontmatter ? frontmatter + '\n\n' + note.content : note.content;
        const dir = note.folderPath ? note.folderPath + '/' : '';
        archive.append(content, { name: `${dir}${note.slug}.md` });
      }

      archive.append(JSON.stringify(data.manifest, null, 2), { name: 'manifest.json' });
      archive.finalize();
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });

  router.get('/export', (req, res) => {
    try {
      const archiver = require('archiver');
      const data = VaultService.exportVault(db);

      const date = new Date().toISOString().slice(0, 10);
      res.set('Content-Type', 'application/zip');
      res.set('Content-Disposition', `attachment; filename="vault-export-${date}.zip"`);

      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.on('error', (err) => { if (!res.headersSent) res.status(500).json({ error: err.message }); });
      archive.pipe(res);

      for (const note of data.notes) {
        const frontmatter = buildFrontmatter(note, note.tagNames);
        const content = frontmatter ? frontmatter + '\n\n' + note.content : note.content;
        const dir = note.folderPath ? note.folderPath + '/' : '';
        archive.append(content, { name: `${dir}${note.slug}.md` });
      }

      archive.append(JSON.stringify(data.manifest, null, 2), { name: 'manifest.json' });
      archive.finalize();
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = createVaultRouter;

module.exports.meta = {
  name: 'vault',
  description: 'Knowledge vault — search notes and indexed files, create notes. Use for deep retrieval across all user knowledge.',
  basePath: '/api/vault',
  endpoints: [
    { method: 'POST', path: '/agent/search', description: 'Search all vault knowledge (notes + indexed files). Returns ranked chunks with relevance scores.',
      params: { query: 'string, required — search query', agent_id: 'string, required', folder_id: 'string, optional — filter to folder', tag: 'string, optional — filter by tag name', limit: 'number, optional (default 5)' } },
    { method: 'POST', path: '/agent/inject', description: 'Create a vault note tagged with your agent name',
      params: { agent_id: 'string, required', agent_name: 'string, required', title: 'string, required', content: 'string, required — markdown body', folder_id: 'string, optional' } },
    { method: 'GET', path: '/agent/reads/:agentId', description: 'Audit log of vault content this agent has accessed' },
    { method: 'GET', path: '/search', description: 'Hybrid search across vault notes and indexed files',
      params: { q: 'string, required — search query', mode: 'keyword|semantic|hybrid (default: hybrid)' } },
  ],
};
