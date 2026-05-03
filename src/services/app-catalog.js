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

// Shared upsert SQL — used by sync() (bulk path) and get() (lazy-fetch
// single-row path). One INSERT … ON CONFLICT keeps both write paths
// consistent: same column set, same conflict resolution.
//
// manifest_yaml semantics (the subtle part):
//   - When the new manifest_sha MATCHES the existing row's, the manifest
//     content hasn't changed; preserve any previously-populated YAML
//     (the listing endpoint omits manifest_yaml to keep responses small,
//     so an excluded.manifest_yaml of NULL on a same-sha sync should not
//     wipe a populated cached YAML).
//   - When the new manifest_sha DIFFERS, the manifest content has changed
//     upstream; accept the new (possibly NULL) value. NULL here is a
//     deliberate signal that the cached YAML is stale and the next get()
//     should lazy-fetch fresh from the detail endpoint.
//
// Without this CASE, a `COALESCE(excluded.manifest_yaml, app_catalog.manifest_yaml)`
// preserved stale YAML across content changes — cache went silently
// out-of-sync with the catalog. Repro that surfaced this: hivisionidphotos
// shipped a postInstall update (huggingface_hub<1 pin); local catalogs
// kept the old manifest_yaml indefinitely; new installs ran the old
// postInstall and broke at runtime.
const UPSERT_SQL = `
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
    manifest_yaml = CASE
      WHEN excluded.manifest_sha = app_catalog.manifest_sha
        THEN COALESCE(excluded.manifest_yaml, app_catalog.manifest_yaml)
      ELSE excluded.manifest_yaml
    END,
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
`;

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

    const upsert = db.prepare(UPSERT_SQL);

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

    // PR 1.25 — recompute update_available flags now that the catalog has
    // moved. Cheap (only runs against installed external apps).
    const flagged = AppCatalogService.detectUpdates(db);

    return {
      synced: added + updated,
      added,
      updated,
      removed,
      unchanged,
      flaggedForUpdate: flagged,
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
   * Single-row lookup by slug. Two lazy-fetch behaviors layered on top of
   * the local cache:
   *
   *   1. Row missing entirely → fetch from os8.ai, INSERT, return. This makes
   *      deeplink installs (`os8://install/<channel>/<slug>`) work without
   *      the user manually triggering a sync first. The local catalog is a
   *      write-through cache for browse/update-detection — it should not be
   *      the source of truth for "does this app exist". Fetching on miss +
   *      writing back keeps the cache populated for subsequent reads
   *      (including detectUpdates()).
   *
   *   2. Row exists but manifest_yaml is NULL (listing-only sync) → fetch
   *      the detail endpoint, write back the YAML, return.
   *
   * In both branches a remote 404 / network failure returns null (case 1)
   * or a yaml-less entry (case 2) — same semantics as before, just no
   * longer requires a prior sync to discover the slug.
   */
  async get(db, slug, { channel = 'verified', apiBase = DEFAULT_API_BASE } = {}) {
    const selectStmt = db.prepare(
      `SELECT * FROM app_catalog WHERE slug = ? AND channel = ? AND deleted_at IS NULL`
    );
    const row = selectStmt.get(slug, channel);

    if (!row) {
      // Don't lazy-fetch if a soft-deleted row exists — soft-delete records
      // a sync-time observation that upstream removed the app, and silently
      // re-inserting on a single-row fetch would erase that signal.
      const tombstone = db.prepare(
        `SELECT 1 FROM app_catalog WHERE slug = ? AND channel = ? AND deleted_at IS NOT NULL`
      ).get(slug, channel);
      if (tombstone) return null;

      // Lazy-fetch on row-missing. If os8.ai has the slug, insert it locally
      // and return. If 404 / network failure, return null (legitimately
      // not in catalog).
      let fetched;
      try {
        fetched = await AppCatalogService.fetchManifest(slug, channel, { apiBase });
      } catch (_) {
        return null;
      }
      if (!fetched || !fetched.slug) return null;
      try {
        const cols = listingToColumns({ ...fetched, channel });
        db.prepare(UPSERT_SQL).run(cols);
      } catch (_) {
        // Insert failure (constraint, etc.) — fall through to the in-memory
        // entry built from the fetched payload so the install can still
        // proceed; the next sync will repair the row.
        return rowToEntry({
          ...listingToColumns({ ...fetched, channel }),
          rating: null,
        });
      }
      const newRow = selectStmt.get(slug, channel);
      return rowToEntry(newRow);
    }

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

  /**
   * PR 1.25 — flag installed apps whose catalog row has moved to a newer
   * commit. Returns the count of newly-flagged apps.
   */
  detectUpdates(db) {
    const candidates = db.prepare(`
      SELECT a.id, a.upstream_resolved_commit AS installed_commit,
             c.upstream_resolved_commit AS catalog_commit
      FROM apps a
      JOIN app_catalog c ON c.slug = a.external_slug AND c.channel = a.channel
      WHERE a.app_type = 'external'
        AND a.status = 'active'
        AND a.upstream_resolved_commit IS NOT NULL
        AND c.upstream_resolved_commit IS NOT NULL
        AND c.deleted_at IS NULL
        AND a.upstream_resolved_commit != c.upstream_resolved_commit
    `).all();

    let flagged = 0;
    const update = db.prepare(`
      UPDATE apps SET update_available = 1, update_to_commit = ?,
             updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND (update_available != 1 OR update_to_commit != ?)
    `);
    for (const c of candidates) {
      const r = update.run(c.catalog_commit, c.id, c.catalog_commit);
      if (r.changes > 0) flagged++;
    }
    return flagged;
  },

  /**
   * PR 1.25 — apply an available update. Semantics:
   *   - apps.user_branch is null → fast-forward user/main onto targetCommit.
   *   - apps.user_branch set → merge targetCommit into user/main; on
   *     conflict, set apps.update_status='conflict' and return
   *     { kind: 'conflict', files }. The renderer drives per-file resolution.
   *
   * On success, clears apps.update_available + update_to_commit and bumps
   * apps.upstream_resolved_commit. Re-running adapter install + restart is
   * the renderer's responsibility (the install pipeline can be reused).
   */
  async update(db, appId, targetCommit) {
    if (!/^[0-9a-f]{40}$/.test(targetCommit || '')) {
      throw new Error('targetCommit must be a 40-char SHA');
    }
    const { AppService } = require('./app');
    const app = AppService.getById(db, appId);
    if (!app) throw new Error(`app ${appId} not found`);
    if (app.app_type !== 'external') throw new Error('not an external app');

    const pathmod = require('path');
    const { APPS_DIR } = require('../config');
    const { spawn } = require('node:child_process');
    const appDir = pathmod.join(APPS_DIR, appId);

    function run(args, opts = {}) {
      return new Promise((resolve, reject) => {
        const child = spawn('git', ['-C', appDir, ...args], {
          shell: false, stdio: ['ignore', 'pipe', 'pipe'], ...opts,
        });
        let stdout = '', stderr = '';
        child.stdout.on('data', d => { stdout += d.toString(); });
        child.stderr.on('data', d => { stderr += d.toString(); });
        child.on('error', reject);
        child.on('exit', code => {
          if (code === 0) resolve({ stdout, stderr });
          else reject(new Error(`git ${args.join(' ')} exited ${code}: ${stderr.trim().slice(-300)}`));
        });
      });
    }

    // 1. Best-effort fetch — the user's clone may already have the SHA.
    try { await run(['fetch', '--depth', '50', 'origin', targetCommit]); }
    catch (_) { /* fall through; we'll catch a missing-commit error below */ }
    try { await run(['cat-file', '-e', `${targetCommit}^{commit}`]); }
    catch (e) {
      throw new Error(`target commit ${targetCommit.slice(0, 8)} not in repo: ${e.message}`);
    }

    // 2. Apply.
    if (!app.user_branch) {
      await run(['checkout', '-q', '-B', 'user/main', targetCommit]);
    } else {
      await run(['checkout', '-q', 'user/main']);
      try {
        await run(['-c', 'user.email=os8@os8.local', '-c', 'user.name=OS8',
                   'merge', '--no-edit', targetCommit]);
      } catch (e) {
        const { stdout } = await run(['status', '--porcelain']);
        const files = stdout.split('\n')
          .filter(line => /^(UU|AA|DD|UA|AU|DU|UD) /.test(line))
          .map(line => line.slice(3));
        db.prepare(
          `UPDATE apps SET update_status = 'conflict', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
        ).run(appId);
        return { kind: 'conflict', files, error: e.message };
      }
    }

    // 3. Bump the apps row.
    db.prepare(`
      UPDATE apps
        SET upstream_resolved_commit = ?,
            update_available = 0,
            update_to_commit = NULL,
            update_status = NULL,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(targetCommit, appId);

    return { kind: 'updated', commit: targetCommit, hadUserEdits: !!app.user_branch };
  },

  /**
   * PR 1.29 — clean up orphaned staging dirs on startup.
   *
   * Walks ~/os8/apps_staging/ and removes any directory whose corresponding
   * app_install_jobs row is:
   *   - missing entirely (orphan dir)
   *   - in a terminal status (failed | cancelled | installed)
   *   - older than 24h in a non-terminal status (mid-flight crash)
   *
   * For mid-flight rows, also marks the row failed with a "reaped on startup"
   * error_message so the install plan UI can surface the reason if it's
   * subscribed.
   *
   * Also cleans up `.<id>.installing` markers in ~/os8/apps/ (left over by
   * the cross-mount EXDEV fallback when copy-then-delete crashed midway).
   *
   * @returns {{ removed: number, markedFailed: number, markersRemoved: number }}
   */
  reapStaging(db, { now = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
    const fsLocal = require('fs');
    const pathLocal = require('path');
    const { APPS_STAGING_DIR, APPS_DIR } = require('../config');

    const result = { removed: 0, markedFailed: 0, markersRemoved: 0 };

    if (fsLocal.existsSync(APPS_STAGING_DIR)) {
      let entries = [];
      try { entries = fsLocal.readdirSync(APPS_STAGING_DIR); }
      catch (_) { entries = []; }

      const failStmt = db.prepare(
        `UPDATE app_install_jobs SET status = 'failed',
                error_message = COALESCE(error_message, 'reaped on startup'),
                updated_at = datetime('now')
         WHERE id = ?`
      );

      for (const dirName of entries) {
        const job = db.prepare(
          `SELECT id, status, created_at FROM app_install_jobs WHERE id = ?`
        ).get(dirName);

        let drop = false;
        if (!job) drop = true;
        else if (['failed', 'cancelled', 'installed'].includes(job.status)) drop = true;
        else {
          const created = job.created_at ? new Date(job.created_at).getTime() : 0;
          if (now - created > maxAgeMs) drop = true;
        }

        if (drop) {
          const dirPath = pathLocal.join(APPS_STAGING_DIR, dirName);
          try {
            fsLocal.rmSync(dirPath, { recursive: true, force: true });
            result.removed++;
          } catch (e) {
            console.warn(`[reapStaging] rm ${dirName}: ${e.message}`);
          }
          if (job && !['installed', 'failed', 'cancelled'].includes(job.status)) {
            failStmt.run(job.id);
            result.markedFailed++;
          }
        }
      }
    }

    // Also clean any orphan .<id>.installing markers in APPS_DIR. The
    // corresponding partial dir would be at APPS_DIR/<id>; if the marker
    // exists it means atomicMove crashed mid-copy, so we drop both.
    if (fsLocal.existsSync(APPS_DIR)) {
      let entries = [];
      try { entries = fsLocal.readdirSync(APPS_DIR); }
      catch (_) { entries = []; }

      for (const f of entries) {
        if (!f.startsWith('.') || !f.endsWith('.installing')) continue;
        const markerPath = pathLocal.join(APPS_DIR, f);
        // Marker filename is `.<appId>.installing` — the partial dir is `<appId>`.
        const partialId = f.slice(1, -('.installing'.length));
        const partialDir = pathLocal.join(APPS_DIR, partialId);

        try { fsLocal.unlinkSync(markerPath); result.markersRemoved++; }
        catch (_) { /* ignore */ }
        if (partialId && fsLocal.existsSync(partialDir)) {
          try { fsLocal.rmSync(partialDir, { recursive: true, force: true }); }
          catch (e) { console.warn(`[reapStaging] rm partial ${partialId}: ${e.message}`); }
        }
      }
    }

    return result;
  },

  /**
   * Reap orphaned developer-import catalog rows (PR 3.1).
   *
   * A dev-import row is an orphan when:
   *   - no apps row references its slug as external_slug, AND
   *   - no app_install_jobs row in non-terminal status references its slug, AND
   *   - the row was synced more than `maxAgeMs` ago (default 24h — don't
   *     race in-flight imports the user is still considering).
   *
   * @param {object} db
   * @param {{ now?: number, maxAgeMs?: number, slug?: string }} [opts]
   *        slug: when supplied, ONLY consider that slug (used by
   *        _rollbackInstall + cancel for same-session cleanup, which
   *        bypasses the time cutoff).
   * @returns {{ removed: number }}
   */
  reapDeveloperImportOrphans(db, { now = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000, slug = null } = {}) {
    const cutoffIso = new Date(now - maxAgeMs).toISOString();
    let stmt;
    let result;
    if (slug) {
      // Eager same-session cleanup — skip the time gate.
      stmt = db.prepare(`
        DELETE FROM app_catalog
        WHERE channel = 'developer-import'
          AND slug = ?
          AND slug NOT IN (SELECT external_slug FROM apps WHERE external_slug IS NOT NULL)
          AND slug NOT IN (
            SELECT external_slug FROM app_install_jobs
            WHERE status IN ('pending','cloning','reviewing','awaiting_approval','installing')
          )
      `);
      result = stmt.run(slug);
    } else {
      stmt = db.prepare(`
        DELETE FROM app_catalog
        WHERE channel = 'developer-import'
          AND synced_at < ?
          AND slug NOT IN (SELECT external_slug FROM apps WHERE external_slug IS NOT NULL)
          AND slug NOT IN (
            SELECT external_slug FROM app_install_jobs
            WHERE status IN ('pending','cloning','reviewing','awaiting_approval','installing')
          )
      `);
      result = stmt.run(cutoffIso);
    }
    return { removed: result.changes };
  },

  /**
   * PR 4.3 — heartbeat installed external apps to os8.ai so the public
   * detail page can show "Update available" badges to the signed-in
   * user. Best-effort: 10s timeout; never throws to the scheduler.
   *
   * Authentication: posts a session cookie when one is present in
   * AccountService's stored bag (set by the os8.ai sign-in flow). When
   * no session exists (anonymous OS8 instance), the heartbeat no-ops
   * before the network call so we don't waste a request on a guaranteed
   * 401. A long-lived os8.ai session-token mechanism for desktop is a
   * follow-up; the endpoint is in place either way (PR 4.3 os8dotai #16).
   *
   * Endpoint: ${OS8_API_BASE_URL || 'https://os8.ai'}/api/account/installed-apps
   */
  async reportInstalledApps(db, { fetchImpl = fetch, getSessionCookie = null } = {}) {
    const cookie = typeof getSessionCookie === 'function' ? getSessionCookie() : null;
    if (!cookie) {
      return { ok: false, reason: 'no os8.ai session — heartbeat skipped' };
    }

    // Quote `commit` — SQLite parses it as a reserved word in the SELECT
    // alias position. Using a quoted identifier keeps the JSON shape
    // (`{ slug, commit, channel }`) the os8.ai endpoint expects.
    const apps = db.prepare(`
      SELECT external_slug AS slug,
             upstream_resolved_commit AS "commit",
             channel
        FROM apps
       WHERE app_type = 'external'
         AND status = 'active'
         AND external_slug IS NOT NULL
         AND upstream_resolved_commit IS NOT NULL
    `).all();

    const base = process.env.OS8_API_BASE_URL || 'https://os8.ai';
    const url = `${base}/api/account/installed-apps`;
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': cookie,
        },
        body: JSON.stringify({ apps }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        return { ok: false, status: res.status };
      }
      const body = await res.json().catch(() => ({}));
      return { ok: true, count: body?.count ?? apps.length, removed: body?.removed ?? 0 };
    } catch (err) {
      // Network error / timeout / abort. Best-effort; next tick retries.
      return { ok: false, reason: err.message };
    }
  },
};

module.exports = AppCatalogService;
