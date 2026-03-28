const fs = require('fs');
const path = require('path');
const { generateId } = require('../utils');
const { SKILLS_DIR } = require('../config');

/**
 * SkillCatalogService — manages the external skill registry index.
 *
 * The catalog is a local SQLite index of skills available from external
 * registries (ClawHub, etc.). It stores metadata only — name, description,
 * author, downloads, trust signals, embeddings. The actual SKILL.md files
 * are only downloaded when a user chooses to install.
 *
 * On first boot, a bundled snapshot seeds the catalog so skill suggestions
 * work immediately without an API call.
 */
class SkillCatalogService {

  /**
   * Seed the catalog from the bundled JSON snapshot.
   * Only runs if the catalog is empty (first boot).
   */
  static seedFromSnapshot(db) {
    const count = db.prepare('SELECT COUNT(*) as cnt FROM skill_catalog').get().cnt;
    if (count > 0) return 0;

    const snapshotPath = path.join(__dirname, '..', 'data', 'skill-catalog-snapshot.json');
    if (!fs.existsSync(snapshotPath)) {
      console.warn('[SkillCatalog] No snapshot file found at', snapshotPath);
      return 0;
    }

    let skills;
    try {
      skills = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
    } catch (e) {
      console.warn('[SkillCatalog] Failed to parse snapshot:', e.message);
      return 0;
    }

    if (!Array.isArray(skills) || skills.length === 0) return 0;

    const insert = db.prepare(`
      INSERT OR IGNORE INTO skill_catalog
        (id, name, description, version, author, source, source_url,
         download_count, verified, official, rating, categories, compatibility, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((items) => {
      let inserted = 0;
      for (const s of items) {
        try {
          insert.run(
            s.id || generateId(),
            s.name,
            s.description || '',
            s.version || null,
            s.author || null,
            s.source || 'snapshot',
            s.source_url || null,
            s.download_count || 0,
            s.verified ? 1 : 0,
            s.official ? 1 : 0,
            s.rating || null,
            s.categories ? JSON.stringify(s.categories) : null,
            s.compatibility || null,
            s.metadata ? JSON.stringify(s.metadata) : null
          );
          inserted++;
        } catch (e) {
          // Skip duplicates or bad entries
        }
      }
      return inserted;
    });

    const inserted = insertMany(skills);
    console.log(`[SkillCatalog] Seeded ${inserted} skills from snapshot`);
    return inserted;
  }

  /**
   * Sync the catalog from the ClawHub API.
   * Paginates through all skills and upserts into skill_catalog.
   * Returns { synced, added, updated }.
   */
  static async sync(db) {
    const BASE_URL = 'https://clawhub.ai/api/v1/skills';
    const LIMIT = 200;
    let cursor = null;
    let totalSynced = 0;
    let page = 0;

    // Track what existed before to distinguish adds vs updates
    const existingIds = new Set(
      db.prepare("SELECT id FROM skill_catalog WHERE source = 'clawhub'").all().map(r => r.id)
    );
    let added = 0;
    let updated = 0;

    const upsert = db.prepare(`
      INSERT OR REPLACE INTO skill_catalog
        (id, name, description, version, author, source, source_url,
         download_count, verified, official, rating, categories, compatibility, metadata, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    // Find max stars across all pages for normalization (we'll do a second pass)
    let allItems = [];

    try {
      while (true) {
        const url = new URL(BASE_URL);
        url.searchParams.set('limit', LIMIT);
        url.searchParams.set('sort', 'downloads');
        if (cursor) url.searchParams.set('cursor', cursor);

        const resp = await fetch(url.toString(), {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(15000)
        });

        if (!resp.ok) {
          console.warn(`[SkillCatalog] API returned ${resp.status} on page ${page + 1}, stopping sync`);
          break;
        }

        const data = await resp.json();
        const items = data.skills || data.items || data.data || [];

        if (items.length === 0) break;

        allItems.push(...items);
        page++;
        console.log(`[SkillCatalog] Fetched page ${page} (${items.length} skills, ${allItems.length} total)`);

        cursor = data.nextCursor || null;
        if (!cursor) break;
      }
    } catch (err) {
      console.warn(`[SkillCatalog] Sync fetch error after ${page} pages (${allItems.length} skills):`, err.message);
      // Continue with whatever we have so far
    }

    if (allItems.length === 0) {
      console.warn('[SkillCatalog] No skills fetched from ClawHub, keeping existing data');
      return { synced: 0, added: 0, updated: 0 };
    }

    // Normalize stars to 0-5 rating
    const maxStars = Math.max(...allItems.map(s => s.stats?.stars || 0), 1);

    // Upsert in a single transaction
    const upsertAll = db.transaction((items) => {
      for (const s of items) {
        try {
          const id = 'clawhub:' + (s.slug || s.id);
          const stars = s.stats?.stars || 0;
          const rating = Math.round((stars / maxStars) * 5 * 100) / 100;
          const verified = (s.stats?.installsCurrent || 0) > 100 ? 1 : 0;
          const sourceUrl = s.slug ? `https://clawhub.ai/skills/${s.slug}` : null;

          if (existingIds.has(id)) {
            updated++;
          } else {
            added++;
          }

          upsert.run(
            id,
            s.displayName || s.name || s.slug,
            s.summary || s.description || '',
            s.latestVersion?.version || null,
            s.owner?.handle || null,
            'clawhub',
            sourceUrl,
            s.stats?.downloads || 0,
            verified,
            0, // official
            rating || null,
            s.categories ? JSON.stringify(s.categories) : null,
            null, // compatibility
            null  // metadata
          );
          totalSynced++;
        } catch (e) {
          // Skip bad entries
        }
      }
    });

    upsertAll(allItems);

    // Rebuild FTS index (content-synced table requires the special 'rebuild' command)
    try {
      db.exec("INSERT INTO skill_catalog_fts(skill_catalog_fts) VALUES('rebuild')");
    } catch (e) {
      console.warn('[SkillCatalog] FTS rebuild warning:', e.message);
    }

    console.log(`[SkillCatalog] Synced ${totalSynced} skills from ClawHub (${added} added, ${updated} updated)`);
    return { synced: totalSynced, added, updated };
  }

  /**
   * Search the catalog using text matching.
   * When embeddings are available, uses hybrid vector + FTS5.
   * Falls back to FTS5-only search.
   */
  static async search(db, query, options = {}) {
    const {
      topK = 15,
      trustWeight = true
    } = options;

    if (!query || !query.trim()) return [];

    // Extract meaningful words (drop short/common words for better FTS matching)
    const STOP_WORDS = new Set(['the','a','an','and','or','for','to','in','on','of','is','are','was','with','your','you','its','can','has','be','as','at','by','from']);
    const words = query
      .replace(/['"*(){}[\]^~\\:!@#$%&,./;]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w.toLowerCase()));

    let results = [];

    // Try FTS5 search with OR (matches any keyword)
    if (words.length > 0) {
      const ftsQuery = words.join(' OR ');
      try {
        results = db.prepare(`
          SELECT sc.*, skill_catalog_fts.rank as fts_rank
          FROM skill_catalog sc
          JOIN skill_catalog_fts ON sc.rowid = skill_catalog_fts.rowid
          WHERE skill_catalog_fts MATCH ?
          ORDER BY skill_catalog_fts.rank
          LIMIT ?
        `).all(ftsQuery, topK * 3);
      } catch (e) {
        // FTS match failure — fall back to LIKE search
      }
    }

    // Fallback: LIKE search if FTS returned nothing
    if (results.length === 0) {
      // Use first few meaningful words for LIKE
      const likeWords = words.slice(0, 3);
      if (likeWords.length > 0) {
        const conditions = likeWords.map(() => '(name LIKE ? OR description LIKE ?)').join(' OR ');
        const params = likeWords.flatMap(w => [`%${w}%`, `%${w}%`]);
        results = db.prepare(`
          SELECT * FROM skill_catalog
          WHERE ${conditions}
          ORDER BY download_count DESC
          LIMIT ?
        `).all(...params, topK * 3);
      }
    }

    // Apply trust-weighted ranking
    if (trustWeight && results.length > 0) {
      const maxDownloads = Math.max(...results.map(r => r.download_count || 0), 1);

      results = results.map((r, i) => {
        const searchScore = 1 / (20 + i + 1); // RRF-style position score
        const downloadScore = Math.log(1 + (r.download_count || 0)) / Math.log(1 + maxDownloads);
        const trustScore = (r.verified ? 0.5 : 0) + (r.official ? 0.5 : 0);
        const ratingScore = r.rating ? r.rating / 5.0 : 0;

        const score =
          0.50 * searchScore +
          0.25 * downloadScore +
          0.15 * trustScore +
          0.10 * ratingScore;

        return {
          ...this._parseRow(r),
          score
        };
      });

      results.sort((a, b) => b.score - a.score);
    } else {
      results = results.map(r => this._parseRow(r));
    }

    return results.slice(0, topK);
  }

  /**
   * Get a single catalog entry by ID.
   */
  static getById(db, id) {
    const row = db.prepare('SELECT * FROM skill_catalog WHERE id = ?').get(id);
    return row ? this._parseRow(row) : null;
  }

  /**
   * Get catalog stats.
   */
  static getStats(db) {
    return db.prepare(`
      SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN verified = 1 THEN 1 END) as verified,
        COUNT(CASE WHEN official = 1 THEN 1 END) as official,
        MAX(synced_at) as last_synced
      FROM skill_catalog
    `).get();
  }

  /**
   * Install a skill from the catalog.
   * Downloads the real SKILL.md from GitHub (openclaw/skills repo),
   * falls back to generating a stub from catalog metadata if download fails.
   */
  static async install(db, catalogId) {
    const CapabilitySyncService = require('./capability-sync');
    const catalogEntry = this.getById(db, catalogId);
    if (!catalogEntry) throw new Error('Catalog entry not found');

    // Check if already installed
    const existing = db.prepare(
      'SELECT id FROM capabilities WHERE catalog_id = ?'
    ).get(catalogId);
    if (existing) return { skillId: existing.id, alreadyInstalled: true };

    // Resolve the ClawHub slug — clawhub:slug format or search by name
    let slug = catalogId.startsWith('clawhub:') ? catalogId.slice(8) : null;

    // Download the full skill directory from ClawHub/GitHub
    let skillMd = null;
    let extraFiles = []; // Additional files beyond SKILL.md
    try {
      // If no slug from ID, search ClawHub by name to find the matching skill
      if (!slug) {
        const searchResp = await fetch(
          `https://clawhub.ai/api/v1/skills?limit=5&sort=downloads`,
          { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(10000) }
        );
        if (searchResp.ok) {
          const searchData = await searchResp.json();
          const items = searchData.skills || searchData.items || searchData.data || [];
          const match = items.find(s =>
            s.slug === catalogEntry.name ||
            s.displayName?.toLowerCase() === catalogEntry.name.toLowerCase()
          );
          if (match) slug = match.slug;
        }
        // Also try the name directly as a slug (common pattern)
        if (!slug) slug = catalogEntry.name.toLowerCase().replace(/\s+/g, '-');
      }

      // Step 1: Get the owner handle from ClawHub detail API
      const detailResp = await fetch(`https://clawhub.ai/api/v1/skills/${encodeURIComponent(slug)}`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000)
      });
      if (detailResp.ok) {
        const detail = await detailResp.json();
        const owner = detail.owner?.handle || detail.skill?.owner?.handle;
        const resolvedSlug = detail.skill?.slug || slug;
        if (owner) {
          // Step 2: Try full directory download first
          const dirResult = await this.downloadSkillDirectory(owner, resolvedSlug);
          if (dirResult.fullDirectory && dirResult.files.length > 0) {
            const skillMdFile = dirResult.files.find(f => f.name === 'SKILL.md');
            if (skillMdFile) {
              skillMd = skillMdFile.content;
              extraFiles = dirResult.files.filter(f => f.name !== 'SKILL.md');
              console.log(`[SkillCatalog] Downloaded full directory for ${resolvedSlug} (${dirResult.files.length} files)`);
            }
          }

          // Fallback: download just SKILL.md
          if (!skillMd) {
            const rawUrl = `https://raw.githubusercontent.com/openclaw/skills/main/skills/${encodeURIComponent(owner)}/${encodeURIComponent(resolvedSlug)}/SKILL.md`;
            const rawResp = await fetch(rawUrl, { signal: AbortSignal.timeout(10000) });
            if (rawResp.ok) {
              skillMd = await rawResp.text();
              console.log(`[SkillCatalog] Downloaded SKILL.md for ${resolvedSlug} from ${owner}`);
            }
          }
        }
      }
    } catch (e) {
      console.warn(`[SkillCatalog] Failed to download for ${slug || catalogEntry.name}:`, e.message);
    }

    // Fallback: generate stub from catalog metadata
    if (!skillMd) {
      console.log(`[SkillCatalog] Using generated stub for ${slug}`);
      skillMd = this._generateSkillMd(catalogEntry);
    }

    // Create skill directory
    const shortId = generateId().split('-')[0];
    const dirName = `${catalogEntry.name}-${shortId}`;
    const skillDir = path.join(SKILLS_DIR, dirName);
    const tmpDir = path.join(SKILLS_DIR, `.tmp-${shortId}`);

    try {
      // Write to temp directory
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'SKILL.md'), skillMd);

      // Write extra files (scripts, etc.)
      for (const file of extraFiles) {
        fs.writeFileSync(path.join(tmpDir, file.name), file.content);
      }

      // Step 2: Parse and validate
      const parsed = CapabilitySyncService.parseSkillMd(skillMd);
      if (!parsed.frontmatter.name) throw new Error('Invalid SKILL.md: missing name');

      // Step 3: Move to final location
      fs.renameSync(tmpDir, skillDir);

      // Step 4: Sync this specific skill into DB
      const result = CapabilitySyncService.syncSkills(db);

      // Find the newly inserted capability
      const newSkill = db.prepare(
        'SELECT id FROM capabilities WHERE base_path = ?'
      ).get(skillDir);

      if (newSkill) {
        // Update with catalog reference — quarantined until review + approval
        db.prepare(`
          UPDATE capabilities SET catalog_id = ?, source = 'catalog', quarantine = 1, review_status = 'pending'
          WHERE id = ?
        `).run(catalogId, newSkill.id);

        return { skillId: newSkill.id, alreadyInstalled: false, reviewStatus: 'pending' };
      }

      throw new Error('Skill was created but not found in DB after sync');
    } catch (e) {
      // Cleanup on failure
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
      try { fs.rmSync(skillDir, { recursive: true, force: true }); } catch (_) {}
      throw e;
    }
  }

  /**
   * Generate embeddings for catalog entries that need them.
   */
  static async generateEmbeddings(db) {
    const { getEmbedder, getTextHash, embeddingToBuffer, bufferToEmbedding, MODEL_NAME } = require('../assistant/memory');

    const entries = db.prepare(
      'SELECT id, name, description, search_description FROM skill_catalog WHERE embedding IS NULL LIMIT 100'
    ).all();

    if (entries.length === 0) return 0;

    const embed = await getEmbedder();
    let count = 0;

    for (const entry of entries) {
      try {
        const text = entry.search_description || entry.description || entry.name;
        const hash = getTextHash(text);

        // Check embedding cache
        const cached = db.prepare(
          'SELECT embedding FROM embedding_cache WHERE text_hash = ? AND model = ?'
        ).get(hash, MODEL_NAME);

        let embedding;
        if (cached) {
          embedding = bufferToEmbedding(cached.embedding);
        } else {
          const output = await embed(text, { pooling: 'mean', normalize: true });
          embedding = new Float32Array(output.data);
          db.prepare(
            'INSERT OR REPLACE INTO embedding_cache (text_hash, model, embedding) VALUES (?, ?, ?)'
          ).run(hash, MODEL_NAME, embeddingToBuffer(embedding));
        }

        db.prepare('UPDATE skill_catalog SET embedding = ? WHERE id = ?')
          .run(embeddingToBuffer(embedding), entry.id);
        count++;
      } catch (e) {
        console.warn(`[SkillCatalog] Embedding failed for ${entry.name}:`, e.message);
      }
    }

    if (count) console.log(`[SkillCatalog] Generated embeddings for ${count} catalog entries`);
    return count;
  }

  /**
   * Download the full skill directory from GitHub (not just SKILL.md).
   * Lists directory via GitHub API, downloads each file.
   * Falls back to SKILL.md-only if API fails (rate limit, etc.).
   * @returns {{ files: Array<{ name: string, content: string }>, fullDirectory: boolean }}
   */
  static async downloadSkillDirectory(owner, slug) {
    const files = [];
    const SKIP_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.zip', '.tar', '.gz']);
    const MAX_FILE_SIZE = 500 * 1024; // 500KB

    try {
      // List directory via GitHub API
      const apiUrl = `https://api.github.com/repos/openclaw/skills/contents/skills/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`;
      const listResp = await fetch(apiUrl, {
        headers: { 'Accept': 'application/vnd.github.v3+json' },
        signal: AbortSignal.timeout(10000)
      });

      if (!listResp.ok) {
        console.warn(`[SkillCatalog] GitHub API returned ${listResp.status} for directory listing`);
        return { files: [], fullDirectory: false };
      }

      const entries = await listResp.json();
      if (!Array.isArray(entries)) return { files: [], fullDirectory: false };

      // Download each file
      for (const entry of entries) {
        if (entry.type !== 'file') continue;
        if (entry.name.startsWith('.')) continue;
        if (entry.size > MAX_FILE_SIZE) continue;

        const ext = path.extname(entry.name).toLowerCase();
        if (SKIP_EXTENSIONS.has(ext)) continue;

        try {
          const rawUrl = `https://raw.githubusercontent.com/openclaw/skills/main/skills/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}/${entry.name}`;
          const fileResp = await fetch(rawUrl, { signal: AbortSignal.timeout(10000) });
          if (fileResp.ok) {
            const content = await fileResp.text();
            files.push({ name: entry.name, content });
          }
        } catch (e) {
          console.warn(`[SkillCatalog] Failed to download ${entry.name}:`, e.message);
        }
      }

      console.log(`[SkillCatalog] Downloaded ${files.length} files from ${owner}/${slug}`);
      return { files, fullDirectory: true };
    } catch (e) {
      console.warn(`[SkillCatalog] Directory download failed, falling back to SKILL.md-only:`, e.message);
      return { files: [], fullDirectory: false };
    }
  }

  // ──────────────────────────────────────────────
  // Internal helpers
  // ──────────────────────────────────────────────

  /**
   * Generate a SKILL.md from catalog metadata.
   * Used when installing from catalog (pre-registry download).
   */
  static _generateSkillMd(entry) {
    let md = '---\n';
    md += `name: ${entry.name}\n`;
    md += `description: ${entry.description}\n`;
    if (entry.version) md += `version: ${entry.version}\n`;
    if (entry.compatibility) md += `compatibility: ${entry.compatibility}\n`;
    md += '---\n\n';
    md += `# ${entry.name}\n\n`;
    md += `${entry.description}\n\n`;
    if (entry.author) md += `**Author:** ${entry.author}\n`;
    if (entry.source_url) md += `**Source:** ${entry.source_url}\n`;
    md += '\n*This skill was installed from the OS8 skill catalog. Full documentation may be available at the source URL above.*\n';
    return md;
  }

  /**
   * Parse a DB row — deserialize JSON fields.
   */
  static _parseRow(row) {
    if (!row) return null;
    return {
      ...row,
      categories: row.categories ? JSON.parse(row.categories) : null,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      embedding: undefined
    };
  }
}

module.exports = SkillCatalogService;
