/**
 * Migration 0.5.0 — App Store schema.
 *
 * Implements the schema additions in spec §6.1 (docs/app-store-spec.md).
 *
 *   1. Extends the `apps` table with 13 catalog/install columns so existing
 *      shell rows can hold metadata for `app_type='external'` apps without
 *      colliding with native rows.
 *   2. Adds `app_env_variables.description` so per-app secrets carry a
 *      human-readable hint (the install plan UI surfaces it).
 *   3. Creates `app_catalog` (mirror of skill_catalog) + FTS5 index +
 *      sync triggers so search hits stay current as catalog rows churn.
 *   4. Creates `app_install_jobs` — the install state machine (pending →
 *      cloning → reviewing → awaiting_approval → installing → installed,
 *      with failed/cancelled side branches). `review_report` stores the
 *      structured security review inline as JSON (plan §10 decision 3).
 *   5. Ensures `<OS8_HOME>/apps_staging/` exists for the clone-before-install
 *      flow.
 *
 * Idempotent: every ALTER is wrapped in try/catch on /duplicate column/i
 * and every CREATE uses IF NOT EXISTS, so re-running on an already-migrated
 * DB is a no-op (matches the seeds.js:265-266 pattern for runtime-added
 * columns).
 */

const fs = require('fs');
const path = require('path');
const { OS8_DIR } = require('../config');

const APPS_NEW_COLUMNS = [
  'external_slug TEXT',
  'channel TEXT',
  'framework TEXT',
  'manifest_yaml TEXT',
  'manifest_sha TEXT',
  'catalog_commit_sha TEXT',
  'upstream_declared_ref TEXT',
  'upstream_resolved_commit TEXT',
  'user_branch TEXT',
  'dev_mode INTEGER DEFAULT 0',
  'auto_update INTEGER DEFAULT 0',
  'update_available INTEGER DEFAULT 0',
  'update_to_commit TEXT',
  'update_status TEXT'
];

function tryAlter(db, sql) {
  try { db.exec(sql); }
  catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }
}

function tryCreate(db, sql) {
  try { db.exec(sql); }
  catch (e) {
    if (!/already exists/i.test(e.message)) throw e;
  }
}

module.exports = {
  version: '0.5.0',
  description: 'App Store schema: extend apps; add app_catalog + app_install_jobs',

  async up({ db, logger }) {
    // 1. Extend apps table.
    for (const colDef of APPS_NEW_COLUMNS) {
      tryAlter(db, `ALTER TABLE apps ADD COLUMN ${colDef}`);
    }

    // 2. app_env_variables gets a description column for the install-plan UI.
    tryAlter(db, 'ALTER TABLE app_env_variables ADD COLUMN description TEXT');

    // 3. app_catalog — mirrors skill_catalog shape (search/install lookup
    //    table for apps surfaced from os8.ai).
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_catalog (
        id                       TEXT PRIMARY KEY,
        slug                     TEXT NOT NULL UNIQUE,
        name                     TEXT NOT NULL,
        description              TEXT,
        publisher                TEXT,
        channel                  TEXT NOT NULL,
        category                 TEXT,
        icon_url                 TEXT,
        screenshots              TEXT,
        manifest_yaml            TEXT,
        manifest_sha             TEXT NOT NULL,
        catalog_commit_sha       TEXT NOT NULL,
        upstream_declared_ref    TEXT NOT NULL,
        upstream_resolved_commit TEXT NOT NULL,
        license                  TEXT,
        runtime_kind             TEXT,
        framework                TEXT,
        architectures            TEXT,
        risk_level               TEXT,
        install_count            INTEGER DEFAULT 0,
        rating                   REAL,
        synced_at                TEXT,
        deleted_at               TEXT
      );
    `);

    // 4. Indexes — `IF NOT EXISTS` is well-supported in SQLite ≥3.8.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_apps_external_slug    ON apps(external_slug);
      CREATE INDEX IF NOT EXISTS idx_apps_app_type         ON apps(app_type);
      CREATE INDEX IF NOT EXISTS idx_app_catalog_channel   ON app_catalog(channel);
      CREATE INDEX IF NOT EXISTS idx_app_catalog_category  ON app_catalog(category);
      CREATE INDEX IF NOT EXISTS idx_app_catalog_deleted   ON app_catalog(deleted_at);
    `);

    // 5. FTS5 + content-table triggers.
    //    Skill catalog uses bulk REBUILD after sync; app catalog churns row-by-row
    //    during installs as well, so triggers are the cleaner approach.
    tryCreate(db, `
      CREATE VIRTUAL TABLE IF NOT EXISTS app_catalog_fts USING fts5(
        slug, name, description, publisher, category, framework,
        content='app_catalog',
        content_rowid='rowid'
      );
    `);

    const triggers = [
      `CREATE TRIGGER IF NOT EXISTS app_catalog_ai AFTER INSERT ON app_catalog BEGIN
         INSERT INTO app_catalog_fts(rowid, slug, name, description, publisher, category, framework)
         VALUES (new.rowid, new.slug, new.name, new.description, new.publisher, new.category, new.framework);
       END`,
      `CREATE TRIGGER IF NOT EXISTS app_catalog_ad AFTER DELETE ON app_catalog BEGIN
         INSERT INTO app_catalog_fts(app_catalog_fts, rowid, slug, name, description, publisher, category, framework)
         VALUES ('delete', old.rowid, old.slug, old.name, old.description, old.publisher, old.category, old.framework);
       END`,
      `CREATE TRIGGER IF NOT EXISTS app_catalog_au AFTER UPDATE ON app_catalog BEGIN
         INSERT INTO app_catalog_fts(app_catalog_fts, rowid, slug, name, description, publisher, category, framework)
         VALUES ('delete', old.rowid, old.slug, old.name, old.description, old.publisher, old.category, old.framework);
         INSERT INTO app_catalog_fts(rowid, slug, name, description, publisher, category, framework)
         VALUES (new.rowid, new.slug, new.name, new.description, new.publisher, new.category, new.framework);
       END`
    ];
    for (const t of triggers) tryCreate(db, t);

    // 6. app_install_jobs — install-pipeline state machine.
    //    review_report stores the security review as inline JSON (plan §10 decision 3).
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_install_jobs (
        id                       TEXT PRIMARY KEY,
        app_id                   TEXT,
        external_slug            TEXT NOT NULL,
        upstream_resolved_commit TEXT NOT NULL,
        channel                  TEXT NOT NULL,
        status                   TEXT NOT NULL,
        staging_dir              TEXT,
        review_report            TEXT,
        error_message            TEXT,
        log_path                 TEXT,
        created_at               TEXT NOT NULL,
        updated_at               TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_install_jobs_status ON app_install_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_install_jobs_slug   ON app_install_jobs(external_slug);
    `);

    // 7. Ensure apps_staging/ exists (clone target for review-before-install).
    const stagingDir = path.join(OS8_DIR, 'apps_staging');
    if (!fs.existsSync(stagingDir)) {
      fs.mkdirSync(stagingDir, { recursive: true });
      logger.log(`[0.5.0] Created ${stagingDir}`);
    }

    logger.log('[0.5.0] App Store schema applied');
  }
};
