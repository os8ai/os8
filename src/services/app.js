const fs = require('fs');
const path = require('path');
const { APPS_DIR, BLOB_DIR, ICONS_DIR, CONFIG_DIR } = require('../config');
const { generateId, generateSlug } = require('../utils');
const { scaffoldFromTemplate } = require('../templates/loader');
const {
  generateAssistantClaudeMd: _generateAssistantClaudeMd,
  generateClaudeMd: _generateClaudeMd
} = require('../claude-md');
const { CapabilityService } = require('./capability');

/**
 * Recursive directory size in bytes. Best-effort: stat failures on
 * individual entries are skipped silently so a permission glitch on
 * one file doesn't tank the whole walk. Used by getOrphan (PR 5.5)
 * to inform the "Previous data found" prompt without an extra IPC.
 */
function _dirSize(dir) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return 0; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += _dirSize(full);
      else if (entry.isFile()) total += fs.statSync(full).size;
    } catch (_) { /* skip unreadable entries */ }
  }
  return total;
}

// Scaffold a new app from templates
function scaffoldApp(appPath, id, name, slug = '', color = '#6366f1', textColor = '#ffffff') {
  scaffoldFromTemplate(appPath, 'standard', {
    APP_NAME: name,
    APP_NAME_JS: name.replace(/\\/g, '\\\\').replace(/'/g, "\\'"),
    ID: id,
    SLUG: slug,
    COLOR: color,
    TEXT_COLOR: textColor
  });
}

// Scaffold the Personal Assistant app (system app with special structure)
function scaffoldAssistantApp(appPath, id, name, slug, assistantName = 'Assistant', ownerName = '') {
  const today = new Date().toISOString().split('T')[0];

  // Use template system with assistant-specific variables
  scaffoldFromTemplate(appPath, 'assistant', {
    APP_NAME: name,
    ID: id,
    SLUG: slug,
    ASSISTANT_NAME: assistantName,
    OWNER_NAME: ownerName || '(not yet known)',
    TODAY: today
  });

  // Remove .gitkeep files (they're just placeholders for empty dirs in templates)
  const gitkeepPath = path.join(appPath, 'skills', '.gitkeep');
  if (fs.existsSync(gitkeepPath)) {
    fs.unlinkSync(gitkeepPath);
  }
}

// Wrapper functions for CLAUDE.md generators (pass CapabilityService dependency)
function generateAssistantClaudeMd(db, app, config = {}) {
  return _generateAssistantClaudeMd(db, app, config, CapabilityService);
}

function generateClaudeMd(db, app) {
  return _generateClaudeMd(db, app, scaffoldApp, CapabilityService);
}

// App CRUD operations
const AppService = {
  getAll(db) {
    return db.prepare('SELECT * FROM apps WHERE status != ? ORDER BY display_order, name').all('deleted');
  },

  getActive(db) {
    return db.prepare('SELECT * FROM apps WHERE status = ? ORDER BY display_order, name').all('active');
  },

  getArchived(db) {
    return db.prepare('SELECT * FROM apps WHERE status = ? ORDER BY display_order, name').all('archived');
  },

  getSystemApps(db) {
    return db.prepare('SELECT * FROM apps WHERE app_type = ? AND status = ? ORDER BY display_order, name').all('system', 'active');
  },

  getById(db, id) {
    return db.prepare('SELECT * FROM apps WHERE id = ?').get(id);
  },

  getBySlug(db, slug) {
    return db.prepare('SELECT * FROM apps WHERE slug = ?').get(slug);
  },

  /**
   * Get the agent system app (the parent app that contains all agents).
   * Legacy fallback — prefer AgentService.getDefault() for agent resolution.
   */
  getAssistant(db) {
    // Return the first system app (there should only be one)
    const systemApps = this.getSystemApps(db);
    if (systemApps.length > 0) return systemApps[0];
    // Final fallback: legacy slug lookup
    return db.prepare('SELECT * FROM apps WHERE app_type = ? AND slug = ?').get('system', 'assistant');
  },

  create(db, name, color = '#6366f1', icon = null, textColor = '#ffffff') {
    const id = generateId();
    let slug = generateSlug(name);

    // Ensure slug is unique by appending a number if needed
    const existingSlug = db.prepare('SELECT id FROM apps WHERE slug = ?').get(slug);
    if (existingSlug) {
      let counter = 2;
      while (db.prepare('SELECT id FROM apps WHERE slug = ?').get(`${slug}-${counter}`)) {
        counter++;
      }
      slug = `${slug}-${counter}`;
    }

    const appPath = path.join(APPS_DIR, id);
    const blobPath = path.join(BLOB_DIR, id);

    // Create directories (using id, not slug)
    fs.mkdirSync(appPath, { recursive: true });
    fs.mkdirSync(blobPath, { recursive: true });

    // Scaffold basic app files
    scaffoldApp(appPath, id, name, slug, color, textColor);

    // Get the next display order (max + 1)
    const maxOrder = db.prepare('SELECT MAX(display_order) as max_order FROM apps WHERE status = ?').get('active');
    const displayOrder = (maxOrder?.max_order ?? -1) + 1;

    // Insert into database
    db.prepare(`
      INSERT INTO apps (id, name, slug, status, display_order, color, icon, text_color)
      VALUES (?, ?, ?, 'active', ?, ?, ?, ?)
    `).run(id, name, slug, displayOrder, color, icon, textColor);

    return { id, name, slug, displayOrder, color, icon, textColor, path: appPath, blobPath };
  },

  update(db, id, updates) {
    const fields = [];
    const values = [];

    if (updates.name !== undefined) {
      fields.push('name = ?');
      values.push(updates.name);
      // Also update slug when name changes (ensure uniqueness)
      let newSlug = generateSlug(updates.name);
      const existingSlug = db.prepare('SELECT id FROM apps WHERE slug = ? AND id != ?').get(newSlug, id);
      if (existingSlug) {
        let counter = 2;
        while (db.prepare('SELECT id FROM apps WHERE slug = ? AND id != ?').get(`${newSlug}-${counter}`, id)) {
          counter++;
        }
        newSlug = `${newSlug}-${counter}`;
      }
      fields.push('slug = ?');
      values.push(newSlug);
    }

    if (updates.displayOrder !== undefined) {
      fields.push('display_order = ?');
      values.push(updates.displayOrder);
    }

    if (updates.color !== undefined) {
      fields.push('color = ?');
      values.push(updates.color);
    }

    if (updates.icon !== undefined) {
      fields.push('icon = ?');
      values.push(updates.icon);
    }

    if (updates.textColor !== undefined) {
      fields.push('text_color = ?');
      values.push(updates.textColor);
    }

    if (updates.iconImage !== undefined) {
      fields.push('icon_image = ?');
      values.push(updates.iconImage);
    }

    if (updates.iconMode !== undefined) {
      fields.push('icon_mode = ?');
      values.push(updates.iconMode);
    }

    if (updates.status !== undefined) {
      fields.push('status = ?');
      values.push(updates.status);
    }

    if (fields.length > 0) {
      fields.push('updated_at = CURRENT_TIMESTAMP');
      values.push(id);
      db.prepare(`UPDATE apps SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    }

    return this.getById(db, id);
  },

  // PR 4.2 — auto-update opt-in for Verified-channel external apps.
  // The schema column lands in migration 0.5.0; this is a thin convenience
  // around the toggle so callers don't have to spell out the column name
  // (and so we can later add validation / channel checks centrally).
  setAutoUpdate(db, appId, enabled) {
    const app = this.getById(db, appId);
    if (!app) throw new Error(`app ${appId} not found`);
    if (app.app_type !== 'external') {
      throw new Error('auto-update only applies to external apps');
    }
    if (enabled && app.channel !== 'verified') {
      // Spec §6.9 — auto-update is Verified-channel only. Refuse to enable
      // on community/dev-import apps so a misconfigured UI can't slip past.
      throw new Error('auto-update is Verified-channel only');
    }
    const value = enabled ? 1 : 0;
    db.prepare(
      `UPDATE apps SET auto_update = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(value, appId);
    return this.getById(db, appId);
  },

  getAutoUpdate(db, appId) {
    const row = db.prepare('SELECT auto_update FROM apps WHERE id = ?').get(appId);
    return row?.auto_update === 1;
  },

  /**
   * Phase 5 PR 5.5 — find the most recent uninstalled-but-preserved app
   * matching `(external_slug, channel)`. Returns null if none.
   *
   * Channel-scoped (Verified orphan ≠ Community reinstall) because trust
   * grants differ across channels — cross-channel restoration would
   * silently elevate trust. Plan §1 deviation: documented in PR 5.D1.
   *
   * Returns size info too so the install plan modal can render an
   * informative "Previous data found" prompt without an extra IPC call.
   * Sizes are best-effort: errors return 0 rather than throw.
   */
  getOrphan(db, externalSlug, channel) {
    if (!externalSlug || !channel) return null;
    const row = db.prepare(`
      SELECT id, external_slug, channel, updated_at
        FROM apps
       WHERE app_type = 'external'
         AND status = 'uninstalled'
         AND external_slug = ?
         AND channel = ?
       ORDER BY updated_at DESC
       LIMIT 1
    `).get(externalSlug, channel);
    if (!row) return null;

    const appId = row.id;
    const blobDir = path.join(BLOB_DIR, appId);
    const dbPath = path.join(CONFIG_DIR, 'app_db', `${appId}.db`);

    let blobSize = 0;
    try { blobSize = _dirSize(blobDir); } catch (_) { /* missing dir → 0 */ }

    let dbSize = 0;
    try {
      if (fs.existsSync(dbPath)) dbSize = fs.statSync(dbPath).size;
    } catch (_) { /* permission / race → 0 */ }

    let secretCount = 0;
    try {
      secretCount = db.prepare(
        `SELECT COUNT(*) AS n FROM app_env_variables WHERE app_id = ?`
      ).get(appId)?.n ?? 0;
    } catch (_) { /* table missing → 0 */ }

    return {
      appId,
      blobDir, blobSize,
      dbPath, dbSize,
      secretCount,
      uninstalledAt: row.updated_at,
    };
  },

  /**
   * Phase 5 PR 5.5 — revive a previously-uninstalled apps row in place.
   * Caller must have verified `getOrphan(db, externalSlug, channel) ===
   * { appId, ... }` first; this method assumes the row exists and is in
   * `status='uninstalled'`.
   *
   * Refreshes the catalog/install metadata to the new install's manifest
   * (so the user sees the new commit, etc.) but preserves the appId,
   * slug, blob/db dirs, and per-app secrets. Returns the same shape as
   * createExternal so the installer's caller-side code is identical.
   */
  reviveOrphan(db, orphanAppId, {
    name, externalSlug, channel, framework,
    manifestYaml, manifestSha, catalogCommitSha,
    upstreamDeclaredRef, upstreamResolvedCommit,
    statusOverride = 'installing',
  }) {
    const existing = this.getById(db, orphanAppId);
    if (!existing) throw new Error(`orphan app ${orphanAppId} not found`);
    if (existing.status !== 'uninstalled') {
      throw new Error(`app ${orphanAppId} is not uninstalled (status=${existing.status})`);
    }

    db.prepare(`
      UPDATE apps SET
        name = ?,
        status = ?,
        external_slug = ?,
        channel = ?,
        framework = ?,
        manifest_yaml = ?,
        manifest_sha = ?,
        catalog_commit_sha = ?,
        upstream_declared_ref = ?,
        upstream_resolved_commit = ?,
        archived_at = NULL,
        update_status = NULL,
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(
      name, statusOverride, externalSlug, channel,
      framework || null, manifestYaml || null, manifestSha || null,
      catalogCommitSha || null, upstreamDeclaredRef || null,
      upstreamResolvedCommit || null, orphanAppId
    );

    return {
      id: orphanAppId,
      name, slug: existing.slug,
      channel, externalSlug,
      path: path.join(APPS_DIR, orphanAppId),
      blobPath: path.join(BLOB_DIR, orphanAppId),
    };
  },

  /**
   * Phase 5 PR 5.5 — mark an uninstalled row archived. Used when the
   * user reinstalls but DECLINES to restore (we keep the data on disk
   * but stop proposing it as a restore candidate). Also stops the
   * archived row from masking a fresh install (`getOrphan` filters on
   * `status='uninstalled'` only).
   */
  archiveOrphan(db, orphanAppId) {
    db.prepare(`
      UPDATE apps SET status = 'archived', archived_at = CURRENT_TIMESTAMP,
                       updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'uninstalled'
    `).run(orphanAppId);
  },

  // PR 1.24 — uninstall an external app.
  //
  // Tiered: by default the source tree is removed but blob storage,
  // per-app SQLite, and per-app secrets are preserved (the user can
  // change their mind without losing data). With { deleteData: true },
  // everything goes — irreversible.
  //
  // Sets apps.status='uninstalled' rather than deleting the row so
  // PR 1.16's reinstall path can detect the orphan and offer a
  // "restore previous data" checkbox in the install plan modal.
  async uninstall(db, appId, { deleteData = false } = {}) {
    const app = this.getById(db, appId);
    if (!app) throw new Error(`app ${appId} not found`);
    if (app.app_type !== 'external') {
      throw new Error('only external apps support uninstall');
    }

    // 1. Stop the dev server + unregister the proxy. Best-effort: a missing
    //    registry entry just means the app wasn't running.
    try {
      const APR = require('./app-process-registry').get();
      if (APR.get(appId)) await APR.stop(appId, { reason: 'uninstall' });
    } catch (_) { /* registry not initialized — nothing to stop */ }
    try {
      require('./reverse-proxy').unregister(app.slug);
    } catch (_) { /* proxy module not loaded — nothing to unregister */ }

    // 2. Remove the source tree.
    const appDir = path.join(APPS_DIR, appId);
    if (fs.existsSync(appDir)) {
      fs.rmSync(appDir, { recursive: true, force: true });
    }

    // 3. Optionally remove per-app data.
    if (deleteData) {
      const blobDir = path.join(BLOB_DIR, appId);
      if (fs.existsSync(blobDir)) {
        fs.rmSync(blobDir, { recursive: true, force: true });
      }
      // Per-app SQLite (created lazily by AppDbService on first execute).
      const dbPath = path.join(CONFIG_DIR, 'app_db', `${appId}.db`);
      if (fs.existsSync(dbPath)) {
        try { fs.unlinkSync(dbPath); }
        catch (e) { console.warn(`[AppService.uninstall] db unlink: ${e.message}`); }
      }
      db.prepare('DELETE FROM app_env_variables WHERE app_id = ?').run(appId);
    }

    // 4. Mark uninstalled (preserves the row for orphan detection).
    db.prepare(
      `UPDATE apps SET status = 'uninstalled', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(appId);

    return { ok: true, appId, dataDeleted: !!deleteData };
  },

  // PR 1.22 — toggle apps.dev_mode for an external app. The runtime watcher
  // is wired into AppProcessRegistry by the start path; toggling at runtime
  // restarts the process so the watcher is re-installed (cheap and obvious).
  setDevMode(db, id, enabled) {
    const app = this.getById(db, id);
    if (!app) throw new Error(`app ${id} not found`);
    if (app.app_type !== 'external') {
      throw new Error('dev_mode is only meaningful for external apps');
    }
    db.prepare(`UPDATE apps SET dev_mode = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(enabled ? 1 : 0, id);
    return this.getById(db, id);
  },

  // Stable, content-uniqueness-aware slug generator. Returns `baseSlug` if
  // free; otherwise `baseSlug-2`, `baseSlug-3`, ... Used by createExternal so
  // multiple installs of the same app get distinct subdomains.
  uniqueSlug(db, baseSlug) {
    if (!db.prepare('SELECT id FROM apps WHERE slug = ?').get(baseSlug)) return baseSlug;
    let n = 2;
    while (db.prepare('SELECT id FROM apps WHERE slug = ?').get(`${baseSlug}-${n}`)) n++;
    return `${baseSlug}-${n}`;
  },

  // Insert a row for an installed external app. Mirrors the existing
  // `create()` shape but persists all the catalog/install fields PR 1.1
  // added. The on-disk app directory is NOT created here — the installer
  // produces it via atomic move from apps_staging/<jobId>/.
  createExternal(db, {
    name, slug, externalSlug, channel, framework,
    manifestYaml, manifestSha, catalogCommitSha,
    upstreamDeclaredRef, upstreamResolvedCommit,
    color = '#6366f1', icon = null, textColor = '#ffffff',
    statusOverride = 'active',
  }) {
    const id = generateId();
    const blobPath = path.join(BLOB_DIR, id);
    fs.mkdirSync(blobPath, { recursive: true });

    const maxOrder = db
      .prepare('SELECT MAX(display_order) AS n FROM apps WHERE status = ?')
      .get('active');
    const order = (maxOrder?.n ?? -1) + 1;

    db.prepare(`
      INSERT INTO apps (
        id, name, slug, status, display_order, color, icon, text_color, app_type,
        external_slug, channel, framework, manifest_yaml, manifest_sha,
        catalog_commit_sha, upstream_declared_ref, upstream_resolved_commit
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'external', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, name, slug, statusOverride, order, color, icon, textColor,
      externalSlug, channel, framework || null, manifestYaml || null, manifestSha || null,
      catalogCommitSha || null, upstreamDeclaredRef || null, upstreamResolvedCommit || null
    );

    return {
      id, name, slug, channel, externalSlug,
      path: path.join(APPS_DIR, id),
      blobPath,
    };
  },

  archive(db, id) {
    // Prevent archiving system apps
    const app = this.getById(db, id);
    if (app && app.app_type === 'system') {
      throw new Error('Cannot archive system apps');
    }
    db.prepare('UPDATE apps SET status = ?, archived_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run('archived', id);
  },

  // Create the Personal Assistant (system app)
  createAssistant(db, assistantName = 'Assistant', ownerName = '') {
    // Check if assistant already exists
    const existing = this.getAssistant(db);
    if (existing) {
      return existing;
    }

    const id = generateId();
    const name = 'Personal Assistant';
    const slug = 'assistant';
    const color = '#8b5cf6'; // Purple
    const textColor = '#ffffff';
    const icon = null;
    const appPath = path.join(APPS_DIR, id);
    const blobPath = path.join(BLOB_DIR, id);

    // Create directories
    fs.mkdirSync(appPath, { recursive: true });
    fs.mkdirSync(blobPath, { recursive: true });

    // Scaffold the assistant app
    scaffoldAssistantApp(appPath, id, name, slug, assistantName, ownerName);

    // Insert into database as system app
    db.prepare(`
      INSERT INTO apps (id, name, slug, status, display_order, color, icon, text_color, app_type)
      VALUES (?, ?, ?, 'active', -1, ?, ?, ?, 'system')
    `).run(id, name, slug, color, icon, textColor);

    // Get the created app
    const app = this.getById(db, id);

    // Generate CLAUDE.md
    generateAssistantClaudeMd(db, app, { assistantName, ownerName });

    return { id, name, slug, color, icon, textColor, appType: 'system', path: appPath, blobPath };
  },

  restore(db, id) {
    db.prepare('UPDATE apps SET status = ?, archived_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run('active', id);
  },

  delete(db, id) {
    const app = this.getById(db, id);
    if (app) {
      // Close any open app database connection before removing files
      const AppDbService = require('./app-db');
      AppDbService.closeConnection(id);

      const appPath = path.join(APPS_DIR, id);
      const blobPath = path.join(BLOB_DIR, id);

      // Remove directories (using id, not slug)
      if (fs.existsSync(appPath)) {
        fs.rmSync(appPath, { recursive: true });
      }
      if (fs.existsSync(blobPath)) {
        fs.rmSync(blobPath, { recursive: true });
      }

      // Remove icon image if present
      for (const ext of ['png', 'jpg']) {
        const iconPath = path.join(ICONS_DIR, `${id}.${ext}`);
        if (fs.existsSync(iconPath)) fs.unlinkSync(iconPath);
      }

      // Remove from database
      db.prepare('DELETE FROM apps WHERE id = ?').run(id);
    }
  },

  // Get paths for an app
  getPaths(id) {
    return {
      app: path.join(APPS_DIR, id),
      blob: path.join(BLOB_DIR, id),
    };
  }
};

module.exports = {
  scaffoldApp,
  scaffoldAssistantApp,
  generateClaudeMd,
  generateAssistantClaudeMd,
  AppService
};
