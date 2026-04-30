/**
 * AppCatalogService — local mirror of os8.ai's app catalog.
 *
 * Spec §6.2.1 + plan §3 PR 1.3. Mirrors SkillCatalogService shape:
 *
 *   - seedFromSnapshot(db)     — first-boot bootstrap (no-op when populated)
 *   - sync(db, opts)           — pull from os8.ai → upsert app_catalog rows
 *   - search(db, query, opts)  — FTS5 + LIKE fallback, filterable
 *   - get(db, slug, opts)      — single-row fetch, lazy-hydrates manifestYaml
 *   - fetchManifest(slug, …)   — re-fetch from os8.ai when local row is sparse
 *
 * Sync semantics (spec §5.3):
 *   - Listing endpoint (PR 0.9) returns {apps: AppListing[]} without
 *     manifestYaml — keeps the response compact.
 *   - Detail endpoint (PR 0.10) returns the full manifest YAML.
 *   - Sync stores listing fields with manifest_yaml=NULL; get() lazy-loads
 *     the YAML on first detail fetch and writes it back.
 *   - Change detection: skip rows whose (manifestSha, catalogCommitSha) pair
 *     hasn't changed.
 *   - Soft-delete: any local slug missing from the remote response gets
 *     deleted_at set; existing app_install_jobs and apps rows are unaffected.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const crypto = require('crypto');

const SNAPSHOT_PATH = path.join(__dirname, '..', 'data', 'app-catalog-snapshot.json');

// os8.ai endpoint base (overridable for tests). Phase 0 PR 0.9 ships
// /api/apps?channel=verified, PR 0.10 ships /api/apps/[slug].
const DEFAULT_API_BASE = process.env.OS8_CATALOG_API_BASE || 'https://os8.ai';

function genId() {
  // Match the rest of OS8 — timestamp + random hex.
  return `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function rowToEntry(row) {
  if (!row) return null;
  let manifest = null;
  if (row.manifest_yaml) {
    try { manifest = yaml.load(row.manifest_yaml); }
    catch (_) { /* leave manifest=null; caller handles */ }
  }
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    publisher: row.publisher,
    channel: row.channel,
    category: row.category,
    iconUrl: row.icon_url,
    screenshots: row.screenshots ? safeJson(row.screenshots, []) : [],
    manifestYaml: row.manifest_yaml,
    manifest,
    manifestSha: row.manifest_sha,
    catalogCommitSha: row.catalog_commit_sha,
    upstreamDeclaredRef: row.upstream_declared_ref,
    upstreamResolvedCommit: row.upstream_resolved_commit,
    license: row.license,
    runtimeKind: row.runtime_kind,
    framework: row.framework,
    architectures: row.architectures ? safeJson(row.architectures, []) : [],
    riskLevel: row.risk_level,
    installCount: row.install_count ?? 0,
    rating: row.rating,
    syncedAt: row.synced_at,
    deletedAt: row.deleted_at,
  };
}

function safeJson(text, fallback) {
  try { return JSON.parse(text); }
  catch (_) { return fallback; }
}

function nowIso() { return new Date().toISOString(); }

// Pull listing fields from a remote AppListing object (PR 0.9 contract).
function listingToColumns(listing) {
  return {
    id: listing.id || genId(),
    slug: listing.slug,
    name: listing.name,
    description: listing.description ?? null,
    publisher: listing.publisher ?? null,
    channel: listing.channel,
    category: listing.category ?? null,
    icon_url: listing.iconUrl ?? null,
    screenshots: JSON.stringify(listing.screenshots || []),
    manifest_yaml: listing.manifestYaml ?? null,        // present only on detail endpoint
    manifest_sha: listing.manifestSha,
    catalog_commit_sha: listing.catalogCommitSha,
    upstream_declared_ref: listing.upstreamDeclaredRef,
    upstream_resolved_commit: listing.upstreamResolvedCommit,
    license: listing.license ?? null,
    runtime_kind: listing.runtimeKind ?? null,
    framework: listing.framework ?? null,
    architectures: JSON.stringify(listing.architectures || ['arm64', 'x86_64']),
    risk_level: listing.riskLevel ?? null,
    install_count: listing.installCount ?? 0,
    rating: listing.rating ?? null,
    synced_at: nowIso(),
    deleted_at: null,
  };
}

const AppCatalogService = {
  /**
   * Bootstrap from the bundled snapshot on first boot. No-op when the table
   * already has rows. Mirrors SkillCatalogService.seedFromSnapshot.
   */
  seedFromSnapshot(db) {
    const existing = db.prepare(`SELECT COUNT(*) AS n FROM app_catalog`).get();
    if (existing && existing.n > 0) return 0;

    let entries = [];
    try {
      const text = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) entries = parsed;
    } catch (_) { /* missing or malformed — start empty */ }

    const insert = db.prepare(`
      INSERT INTO app_catalog (
        id, slug, name, description, publisher, channel, category, icon_url,
        screenshots, manifest_yaml, manifest_sha, catalog_commit_sha,
        upstream_declared_ref, upstream_resolved_commit, license, runtime_kind,
        framework, architectures, risk_level, install_count, rating,
        synced_at, deleted_at
      ) VALUES (
        @id, @slug, @name, @description, @publisher, @channel, @category, @icon_url,
        @screenshots, @manifest_yaml, @manifest_sha, @catalog_commit_sha,
        @upstream_declared_ref, @upstream_resolved_commit, @license, @runtime_kind,
        @framework, @architectures, @risk_level, @install_count, @rating,
        @synced_at, @deleted_at
      )
    `);
    const tx = db.transaction((rows) => {
      for (const r of rows) insert.run(r);
    });
    const cols = entries.map(listingToColumns);
    tx(cols);
    return cols.length;
  },

  /**
   * Sync from os8.ai. Returns { synced, added, updated, removed, alarms }.
   */
  async sync(db, { channel = 'verified', force: _force = false, apiBase = DEFAULT_API_BASE } = {}) {
    const url = `${apiBase}/api/apps?channel=${encodeURIComponent(channel)}`;
    let resp;
    try {
      resp = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      return { synced: 0, added: 0, updated: 0, removed: 0,
               alarms: [`fetch failed: ${e.message}`] };
    }
    if (!resp.ok) {
      return { synced: 0, added: 0, updated: 0, removed: 0,
               alarms: [`os8.ai returned ${resp.status}`] };
    }

    let body;
    try { body = await resp.json(); }
    catch (e) {
      return { synced: 0, added: 0, updated: 0, removed: 0,
               alarms: [`json parse failed: ${e.message}`] };
    }

    const remote = Array.isArray(body?.apps) ? body.apps : [];

    // Existing rows (live + soft-deleted) for change detection + soft-delete.
    const existingRows = db.prepare(
      `SELECT id, slug, manifest_sha, catalog_commit_sha, deleted_at FROM app_catalog WHERE channel = ?`
    ).all(channel);
    const existingBySlug = new Map(existingRows.map(r => [r.slug, r]));

    let added = 0;
    let updated = 0;
    let unchanged = 0;
    const alarms = [];

    const upsert = db.prepare(`
      INSERT INTO app_catalog (
        id, slug, name, description, publisher, channel, category, icon_url,
        screenshots, manifest_yaml, manifest_sha, catalog_commit_sha,
        upstream_declared_ref, upstream_resolved_commit, license, runtime_kind,
        framework, architectures, risk_level, install_count, rating,
        synced_at, deleted_at
      ) VALUES (
        @id, @slug, @name, @description, @publisher, @channel, @category, @icon_url,
        @screenshots, @manifest_yaml, @manifest_sha, @catalog_commit_sha,
        @upstream_declared_ref, @upstream_resolved_commit, @license, @runtime_kind,
        @framework, @architectures, @risk_level, @install_count, @rating,
        @synced_at, @deleted_at
      )
      ON CONFLICT(slug) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        publisher = excluded.publisher,
        category = excluded.category,
        icon_url = excluded.icon_url,
        screenshots = excluded.screenshots,
        manifest_yaml = COALESCE(excluded.manifest_yaml, app_catalog.manifest_yaml),
        manifest_sha = excluded.manifest_sha,
        catalog_commit_sha = excluded.catalog_commit_sha,
        upstream_declared_ref = excluded.upstream_declared_ref,
        upstream_resolved_commit = excluded.upstream_resolved_commit,
        license = excluded.license,
        runtime_kind = excluded.runtime_kind,
        framework = excluded.framework,
        architectures = excluded.architectures,
        risk_level = excluded.risk_level,
        install_count = excluded.install_count,
        rating = excluded.rating,
        synced_at = excluded.synced_at,
        deleted_at = NULL
    `);

    const tx = db.transaction((listings) => {
      for (const listing of listings) {
        if (!listing?.slug) {
          alarms.push('listing missing slug');
          continue;
        }
        const existing = existingBySlug.get(listing.slug);
        const cols = listingToColumns({ ...listing, channel });

        if (existing
            && existing.manifest_sha === cols.manifest_sha
            && existing.catalog_commit_sha === cols.catalog_commit_sha
            && !existing.deleted_at) {
          unchanged++;
          continue;
        }

        upsert.run(cols);
        if (existing) updated++;
        else added++;
      }
    });
    tx(remote);

    // Soft-delete rows missing from the remote response.
    let removed = 0;
    const remoteSlugs = new Set(remote.map(r => r.slug).filter(Boolean));
    const softDeleteStmt = db.prepare(
      `UPDATE app_catalog SET deleted_at = ?, synced_at = ? WHERE slug = ? AND channel = ? AND deleted_at IS NULL`
    );
    for (const e of existingRows) {
      if (!remoteSlugs.has(e.slug) && !e.deleted_at) {
        const r = softDeleteStmt.run(nowIso(), nowIso(), e.slug, channel);
        if (r.changes > 0) removed++;
      }
    }

    return {
      synced: added + updated,
      added,
      updated,
      removed,
      unchanged,
      alarms,
    };
  },

  /**
   * Search the local catalog. FTS5 first; falls back to LIKE if FTS errors
   * (e.g. invalid query syntax).
   */
  search(db, query, { channel, category, framework, limit = 50 } = {}) {
    const q = (query || '').trim();
    let rows;

    if (q.length > 0) {
      try {
        // FTS5 path. Sanitize the user input — FTS rejects unbalanced quotes
        // and special chars. Wrap in dquotes for phrase match.
        const safe = q.replace(/[^a-z0-9 .\-_]/gi, ' ').trim();
        if (safe.length === 0) throw new Error('empty');
        const ftsQuery = safe.split(/\s+/).map(t => `${t}*`).join(' ');
        rows = db.prepare(`
          SELECT app_catalog.* FROM app_catalog
          INNER JOIN app_catalog_fts ON app_catalog.rowid = app_catalog_fts.rowid
          WHERE app_catalog_fts MATCH ?
            AND app_catalog.deleted_at IS NULL
            ${channel    ? `AND app_catalog.channel = '${String(channel).replace(/'/g, "''")}'` : ''}
            ${category   ? `AND app_catalog.category = '${String(category).replace(/'/g, "''")}'` : ''}
            ${framework  ? `AND app_catalog.framework = '${String(framework).replace(/'/g, "''")}'` : ''}
          ORDER BY app_catalog_fts.rank
          LIMIT ?
        `).all(ftsQuery, limit);
      } catch (_) {
        rows = null;
      }
    }

    if (!rows) {
      // LIKE fallback — slower but always valid.
      const like = `%${q.toLowerCase()}%`;
      const args = [like, like];
      const where = ['deleted_at IS NULL', '(LOWER(slug) LIKE ? OR LOWER(name) LIKE ?)'];
      if (channel)   { where.push('channel = ?');   args.push(channel); }
      if (category)  { where.push('category = ?');  args.push(category); }
      if (framework) { where.push('framework = ?'); args.push(framework); }
      args.push(limit);
      rows = db.prepare(`
        SELECT * FROM app_catalog
        WHERE ${where.join(' AND ')}
        ORDER BY install_count DESC, name ASC
        LIMIT ?
      `).all(...args);
    }

    return rows.map(rowToEntry);
  },

  /**
   * Single-row lookup by slug. If the row exists but `manifest_yaml` is NULL
   * (sync-with-no-detail case), this lazily fetches the manifest from os8.ai
   * and writes it back so subsequent calls hit the cache.
   */
  async get(db, slug, { channel = 'verified', apiBase = DEFAULT_API_BASE } = {}) {
    const row = db.prepare(
      `SELECT * FROM app_catalog WHERE slug = ? AND channel = ? AND deleted_at IS NULL`
    ).get(slug, channel);
    if (!row) return null;

    if (!row.manifest_yaml) {
      try {
        const fetched = await AppCatalogService.fetchManifest(slug, channel, { apiBase });
        if (fetched?.manifestYaml) {
          db.prepare(`UPDATE app_catalog SET manifest_yaml = ? WHERE id = ?`)
            .run(fetched.manifestYaml, row.id);
          row.manifest_yaml = fetched.manifestYaml;
        }
      } catch (_) {
        // Network failure — return whatever we have. The install plan modal
        // can show validation errors if the manifest is required but missing.
      }
    }

    return rowToEntry(row);
  },

  /**
   * Fetch a single manifest from os8.ai's detail endpoint.
   * Throws on 404; returns the parsed AppListing on success.
   */
  async fetchManifest(slug, channel = 'verified', { apiBase = DEFAULT_API_BASE } = {}) {
    const url = `${apiBase}/api/apps/${encodeURIComponent(slug)}?channel=${encodeURIComponent(channel)}`;
    const resp = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (resp.status === 404) {
      throw new Error(`app ${slug} not found in catalog`);
    }
    if (!resp.ok) {
      throw new Error(`os8.ai returned ${resp.status}`);
    }
    const body = await resp.json();
    // PR 0.10's contract: { app: { …listing fields…, manifestYaml } }
    return body?.app || body;
  },
};

module.exports = AppCatalogService;
