/**
 * AI Registry Service
 * Read-only queries for ai_providers, ai_containers, and ai_models tables
 */

const AIRegistryService = {
  getProviders(db) {
    return db.prepare('SELECT * FROM ai_providers ORDER BY display_order').all();
  },

  getProvider(db, id) {
    return db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(id);
  },

  getContainers(db) {
    return db.prepare(`
      SELECT c.*, p.name AS provider_name
      FROM ai_containers c
      JOIN ai_providers p ON p.id = c.provider_id
      ORDER BY c.display_order
    `).all();
  },

  getContainer(db, id) {
    return db.prepare(`
      SELECT c.*, p.name AS provider_name
      FROM ai_containers c
      JOIN ai_providers p ON p.id = c.provider_id
      WHERE c.id = ?
    `).get(id);
  },

  getTerminalContainers(db) {
    return db.prepare(`
      SELECT c.*, p.name AS provider_name
      FROM ai_containers c
      JOIN ai_providers p ON p.id = c.provider_id
      WHERE c.show_in_terminal = 1
      ORDER BY c.display_order
    `).all();
  },

  getModels(db) {
    return db.prepare(`
      SELECT m.*, c.name AS container_name, c.type AS container_type, p.name AS provider_name
      FROM ai_models m
      JOIN ai_containers c ON c.id = m.container_id
      JOIN ai_providers p ON p.id = m.provider_id
      ORDER BY m.container_id, m.display_order
    `).all();
  },

  getModelsByContainer(db, containerId) {
    return db.prepare(`
      SELECT m.*, c.name AS container_name, c.type AS container_type, p.name AS provider_name
      FROM ai_models m
      JOIN ai_containers c ON c.id = m.container_id
      JOIN ai_providers p ON p.id = m.provider_id
      WHERE m.container_id = ?
      ORDER BY m.display_order
    `).all(containerId);
  },

  getModel(db, id) {
    return db.prepare(`
      SELECT m.*, c.name AS container_name, c.type AS container_type, p.name AS provider_name
      FROM ai_models m
      JOIN ai_containers c ON c.id = m.container_id
      JOIN ai_providers p ON p.id = m.provider_id
      WHERE m.id = ?
    `).get(id);
  },

  getRegistry(db) {
    return {
      providers: AIRegistryService.getProviders(db),
      containers: AIRegistryService.getContainers(db),
      models: AIRegistryService.getModels(db)
    };
  },

  // --- API Key Catalog methods ---

  getApiKeyCatalog(db) {
    return db.prepare('SELECT * FROM api_key_catalog ORDER BY display_order').all();
  },

  getAllowedEnvKeys(db) {
    return db.prepare('SELECT env_key FROM api_key_catalog ORDER BY display_order').all().map(r => r.env_key);
  },

  getApiKeyMapForContainers(db) {
    const rows = db.prepare('SELECT id, api_key_aliases FROM ai_containers').all();
    const map = {};
    for (const row of rows) {
      try {
        map[row.id] = JSON.parse(row.api_key_aliases || '[]');
      } catch (e) {
        map[row.id] = [];
      }
    }
    return map;
  },

  getBackendKeyMap(db) {
    const rows = db.prepare(`
      SELECT c.id AS container_id, p.api_key_env
      FROM ai_containers c
      JOIN ai_providers p ON p.id = c.provider_id
    `).all();
    const map = {};
    for (const row of rows) {
      map[row.container_id] = row.api_key_env;
    }
    return map;
  },

  /**
   * Get Claude model alias → full API model ID map
   * Used by anthropic-sdk.js and moderator.js to resolve 'opus' → 'claude-opus-4-6'
   * Resolves through families → latest ai_models.api_model_id
   */
  getClaudeModelMap(db) {
    const families = this.getFamiliesByContainer(db, 'claude');
    const map = {};
    for (const f of families) {
      const latest = db.prepare(
        'SELECT api_model_id FROM ai_models WHERE family_id = ? AND is_latest = 1 LIMIT 1'
      ).get(f.id);
      if (latest?.api_model_id) {
        map[f.name.toLowerCase()] = latest.api_model_id;
      }
    }
    // Fallback: if no families found yet, use legacy model rows directly
    if (Object.keys(map).length === 0) {
      const models = this.getModelsByContainer(db, 'claude');
      for (const m of models) {
        if (m.api_model_id) {
          map[m.name.toLowerCase()] = m.api_model_id;
        }
      }
    }
    return map;
  },

  // --- Model Family methods ---

  getFamilies(db) {
    return db.prepare(`
      SELECT f.*, c.name AS container_name
      FROM ai_model_families f
      JOIN ai_containers c ON c.id = f.container_id
      ORDER BY c.display_order, f.display_order
    `).all();
  },

  getFamily(db, id) {
    return db.prepare('SELECT * FROM ai_model_families WHERE id = ?').get(id);
  },

  getFamiliesByContainer(db, containerId) {
    return db.prepare(
      'SELECT * FROM ai_model_families WHERE container_id = ? ORDER BY display_order'
    ).all(containerId);
  },

  /**
   * Resolve a family ID to the CLI model argument.
   * Priority: family.cli_model_arg → latest ai_models.model_identifier
   * @param {object} db - SQLite database
   * @param {string} familyId - Family ID (e.g. 'claude-opus', 'gemini-pro')
   * @returns {string|null} CLI model arg (e.g. 'opus', 'gemini-2.5-pro')
   */
  resolveModelArg(db, familyId) {
    if (!familyId) return null;
    const family = db.prepare('SELECT * FROM ai_model_families WHERE id = ?').get(familyId);
    if (!family) {
      // Not a family ID — might be a legacy model_identifier, pass through
      return familyId;
    }
    if (family.cli_model_arg) return family.cli_model_arg;
    const latest = db.prepare(
      'SELECT model_identifier FROM ai_models WHERE family_id = ? AND is_latest = 1 LIMIT 1'
    ).get(familyId);
    return latest?.model_identifier || null;
  },

  /**
   * Resolve a family ID to the container/backend ID.
   * @param {object} db - SQLite database
   * @param {string} familyId - Family ID
   * @returns {string|null} Container ID (e.g. 'claude', 'gemini')
   */
  resolveBackend(db, familyId) {
    if (!familyId) return null;
    const family = db.prepare('SELECT container_id FROM ai_model_families WHERE id = ?').get(familyId);
    return family?.container_id || null;
  }
};

module.exports = AIRegistryService;
