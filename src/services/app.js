const fs = require('fs');
const path = require('path');
const { APPS_DIR, BLOB_DIR } = require('../config');
const { generateId, generateSlug } = require('../utils');
const { scaffoldFromTemplate } = require('../templates/loader');
const {
  generateAssistantClaudeMd: _generateAssistantClaudeMd,
  generateClaudeMd: _generateClaudeMd
} = require('../claude-md');
const { CapabilityService } = require('./capability');

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

    if (fields.length > 0) {
      fields.push('updated_at = CURRENT_TIMESTAMP');
      values.push(id);
      db.prepare(`UPDATE apps SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    }

    return this.getById(db, id);
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
