/**
 * AppCatalogService — local mirror of os8.ai's app catalog.
 *
 * Spec §6.2.1 + plan §3 PR 1.3. Mirrors SkillCatalogService shape.
 *
 * **Phase 1A scope.** Only `get()` is wired right now — the slice
 * acceptance script (docs/phase-1-plan.md §"Phase 1A acceptance") inserts
 * a row directly into `app_catalog` via SQL, then drives install via
 * `POST /api/app-store/install`. The route handler (PR 1.5) and the
 * manifest-render IPC (PR 1.4) call `get()` to look up the manifest by slug.
 *
 * **PR 1.3 (full implementation)** ships sync from `https://os8.ai/api/apps`,
 * search, lazy fetchManifest, and a daily 4am scheduled sync. The shape is
 * defined here so PR 1.3 only adds bodies.
 */

const yaml = require('js-yaml');

function rowToEntry(row) {
  if (!row) return null;
  let manifest = null;
  if (row.manifest_yaml) {
    try { manifest = yaml.load(row.manifest_yaml); }
    catch (e) { /* leave manifest=null; caller handles */ }
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
    screenshots: row.screenshots ? JSON.parse(row.screenshots) : [],
    manifestYaml: row.manifest_yaml,
    manifest,
    manifestSha: row.manifest_sha,
    catalogCommitSha: row.catalog_commit_sha,
    upstreamDeclaredRef: row.upstream_declared_ref,
    upstreamResolvedCommit: row.upstream_resolved_commit,
    license: row.license,
    runtimeKind: row.runtime_kind,
    framework: row.framework,
    architectures: row.architectures ? JSON.parse(row.architectures) : [],
    riskLevel: row.risk_level,
    installCount: row.install_count ?? 0,
    rating: row.rating,
    syncedAt: row.synced_at,
    deletedAt: row.deleted_at,
  };
}

const AppCatalogService = {
  /**
   * Look up a single catalog entry by slug. Returns the entry with the
   * manifest YAML parsed into `manifest`, or null if not found.
   *
   * If the local row has `manifest_yaml IS NULL`, PR 1.3 falls through to
   * `fetchManifest(slug, channel)` which re-pulls from os8.ai. For Phase 1A
   * the slice script seeds the YAML directly so this fallthrough is unused.
   *
   * @param {object} db
   * @param {string} slug
   * @param {{channel?: string}} [opts]
   */
  async get(db, slug, { channel = 'verified' } = {}) {
    const row = db.prepare(
      `SELECT * FROM app_catalog WHERE slug = ? AND channel = ? AND deleted_at IS NULL`
    ).get(slug, channel);
    if (!row) return null;

    if (!row.manifest_yaml && typeof AppCatalogService.fetchManifest === 'function') {
      // PR 1.3 hook — re-fetch from os8.ai when local row was sync'd via the
      // listing endpoint (which omits manifest_yaml for response size). Stub
      // implementation in this PR; real fetch lands in PR 1.3.
      try {
        const fetched = await AppCatalogService.fetchManifest(slug, channel);
        if (fetched?.manifestYaml) {
          db.prepare(`UPDATE app_catalog SET manifest_yaml = ? WHERE id = ?`)
            .run(fetched.manifestYaml, row.id);
          row.manifest_yaml = fetched.manifestYaml;
        }
      } catch (_) { /* leave manifest=null; caller handles */ }
    }

    return rowToEntry(row);
  },

  /**
   * Stub for PR 1.3 — daily sync from os8.ai. Phase 1A doesn't exercise it
   * (no os8.ai endpoint), but the shape is locked so PR 1.3 only fills in
   * the body.
   */
  async sync(_db, _opts = {}) {
    return { synced: 0, added: 0, updated: 0, removed: 0, alarms: ['sync not yet wired (PR 1.3)'] };
  },

  /**
   * Stub for PR 1.3 — FTS5 search.
   */
  search(_db, _query, _opts = {}) {
    return [];
  },

  /**
   * Stub for PR 1.3 — single-row re-fetch from os8.ai.
   * Defined as a property (not a method body) so test suites can monkey-patch.
   */
  fetchManifest: undefined,
};

module.exports = AppCatalogService;
