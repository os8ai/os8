/**
 * Model Discovery Service
 * Checks provider APIs for new model versions and updates the ai_models table.
 */

const EnvService = require('./env');

/**
 * Provider-specific model list API configurations.
 * Each entry describes how to fetch and parse the model list for a provider.
 */
const PROVIDER_CONFIGS = {
  anthropic: {
    url: 'https://api.anthropic.com/v1/models',
    buildHeaders(apiKey) {
      return {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      };
    },
    envKey: 'ANTHROPIC_API_KEY',
    parseModels(data) {
      // Returns array of { id, created_at }
      return (data.data || []).map(m => ({
        apiModelId: m.id,
        createdAt: m.created_at ? new Date(m.created_at * 1000).toISOString() : null
      }));
    },
    /**
     * Parse a model ID to determine its family.
     * e.g. 'claude-opus-4-6' → 'claude-opus'
     * e.g. 'claude-sonnet-4-5-20250929' → 'claude-sonnet'
     */
    resolveFamily(apiModelId) {
      const match = apiModelId.match(/^claude-(opus|sonnet|haiku)/);
      if (match) return `claude-${match[1]}`;
      return null;
    }
  },

  google: {
    url: 'https://generativelanguage.googleapis.com/v1beta/models',
    buildHeaders() { return {}; },
    buildUrl(baseUrl, apiKey) {
      return `${baseUrl}?key=${apiKey}`;
    },
    envKey: 'GOOGLE_API_KEY',
    parseModels(data) {
      return (data.models || []).map(m => ({
        apiModelId: m.name?.replace('models/', '') || m.baseModelId,
        createdAt: null,
        version: m.version
      }));
    },
    resolveFamily(apiModelId) {
      if (/gemini.*pro/i.test(apiModelId)) return 'gemini-pro';
      if (/gemini.*flash.*lite/i.test(apiModelId)) return 'gemini-flash-lite';
      if (/gemini.*flash/i.test(apiModelId)) return 'gemini-flash';
      return null;
    }
  },

  openai: {
    url: 'https://api.openai.com/v1/models',
    buildHeaders(apiKey) {
      return { 'Authorization': `Bearer ${apiKey}` };
    },
    envKey: 'OPENAI_API_KEY',
    parseModels(data) {
      return (data.data || []).map(m => ({
        apiModelId: m.id,
        createdAt: m.created ? new Date(m.created * 1000).toISOString() : null
      }));
    },
    resolveFamily(apiModelId) {
      if (/gpt.*codex/i.test(apiModelId)) return 'gpt-codex';
      if (/^gpt-/i.test(apiModelId)) return 'gpt-chat';
      return null;
    }
  },

  xai: {
    url: 'https://api.x.ai/v1/models',
    buildHeaders(apiKey) {
      return { 'Authorization': `Bearer ${apiKey}` };
    },
    envKey: 'XAI_API_KEY',
    parseModels(data) {
      return (data.data || data.models || []).map(m => ({
        apiModelId: m.id,
        createdAt: m.created ? new Date(m.created * 1000).toISOString() : null
      }));
    },
    resolveFamily(apiModelId) {
      if (/grok-code-fast/i.test(apiModelId)) return 'grok-code-fast';
      if (/grok.*fast/i.test(apiModelId)) return 'grok-fast';
      if (/grok/i.test(apiModelId)) return 'grok';
      return null;
    }
  }
};

const ModelDiscoveryService = {
  /**
   * Check all providers for new models.
   * Only checks providers that have API keys configured.
   * @param {object} db - SQLite database
   * @returns {Promise<object>} Summary of discoveries
   */
  async checkAll(db) {
    const envVars = EnvService.asObject(db);
    const results = {};

    for (const [providerId, config] of Object.entries(PROVIDER_CONFIGS)) {
      const apiKey = envVars[config.envKey] || process.env[config.envKey];
      if (!apiKey) {
        results[providerId] = { skipped: true, reason: 'No API key' };
        continue;
      }

      try {
        const discovered = await this.checkProvider(db, providerId, config, apiKey);
        results[providerId] = discovered;
      } catch (err) {
        results[providerId] = { error: err.message };
        console.warn(`[ModelDiscovery] Error checking ${providerId}:`, err.message);
      }
    }

    return results;
  },

  /**
   * Check a single provider for new models.
   * @param {object} db - SQLite database
   * @param {string} providerId - Provider ID
   * @param {object} config - Provider config from PROVIDER_CONFIGS
   * @param {string} apiKey - API key
   * @returns {Promise<object>} { checked: number, newModels: string[], updated: string[] }
   */
  async checkProvider(db, providerId, config, apiKey) {
    const url = config.buildUrl ? config.buildUrl(config.url, apiKey) : config.url;
    const headers = config.buildHeaders(apiKey);

    const response = await fetch(url, {
      headers: { ...headers, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      throw new Error(`${providerId} API returned ${response.status}`);
    }

    const data = await response.json();
    const models = config.parseModels(data);

    const newModels = [];
    const updated = [];

    for (const model of models) {
      const familyId = config.resolveFamily(model.apiModelId);
      if (!familyId) continue; // Unknown model family, skip

      // Check if this exact model already exists
      const existing = db.prepare(
        'SELECT id FROM ai_models WHERE api_model_id = ?'
      ).get(model.apiModelId);

      if (existing) continue; // Already known

      // Check if family exists
      const family = db.prepare(
        'SELECT id FROM ai_model_families WHERE id = ?'
      ).get(familyId);

      if (!family) continue; // Unknown family, skip

      // Get container for this family
      const familyRow = db.prepare(
        'SELECT container_id FROM ai_model_families WHERE id = ?'
      ).get(familyId);

      // Insert new model
      const modelId = `${model.apiModelId.replace(/[^a-z0-9-]/g, '-')}`;
      db.prepare(`
        INSERT OR IGNORE INTO ai_models (id, provider_id, container_id, family_id, name, display_name, model_identifier, api_model_id, is_default, is_latest, released_at, discovered_at, display_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 99)
      `).run(
        modelId,
        providerId,
        familyRow.container_id,
        familyId,
        model.apiModelId,
        model.apiModelId,
        model.apiModelId,
        model.apiModelId,
        model.createdAt || null,
        new Date().toISOString()
      );

      newModels.push(model.apiModelId);
      console.log(`[ModelDiscovery] New model: ${model.apiModelId} (family: ${familyId})`);

      // Check if this is newer than current latest
      const currentLatest = db.prepare(
        'SELECT id, released_at, created_at FROM ai_models WHERE family_id = ? AND is_latest = 1'
      ).get(familyId);

      if (currentLatest && model.createdAt) {
        const currentDate = currentLatest.released_at || currentLatest.created_at;
        if (!currentDate || model.createdAt > currentDate) {
          // This model is newer — promote it
          db.prepare('UPDATE ai_models SET is_latest = 0 WHERE family_id = ? AND is_latest = 1').run(familyId);
          db.prepare('UPDATE ai_models SET is_latest = 1 WHERE id = ?').run(modelId);
          updated.push(`${familyId}: ${currentLatest.id} → ${modelId}`);
          console.log(`[ModelDiscovery] Updated latest for ${familyId}: ${modelId}`);
        }
      }
    }

    return { checked: models.length, newModels, updated };
  },

  /**
   * Get all model versions grouped by family.
   * @param {object} db - SQLite database
   * @returns {object} { familyId: { family, versions: [] } }
   */
  getVersionsByFamily(db) {
    const families = db.prepare(`
      SELECT f.*, c.name AS container_name
      FROM ai_model_families f
      JOIN ai_containers c ON c.id = f.container_id
      ORDER BY c.display_order, f.display_order
    `).all();

    const result = {};
    for (const family of families) {
      const versions = db.prepare(`
        SELECT id, name, display_name, api_model_id, model_identifier, is_latest, released_at, discovered_at, created_at
        FROM ai_models
        WHERE family_id = ?
        ORDER BY is_latest DESC, created_at DESC
      `).all(family.id);

      result[family.id] = {
        family: {
          id: family.id,
          name: family.name,
          displayName: family.display_name,
          container: family.container_name,
          cliModelArg: family.cli_model_arg
        },
        versions
      };
    }

    return result;
  }
};

module.exports = ModelDiscoveryService;
