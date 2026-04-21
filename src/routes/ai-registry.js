/**
 * AI Registry routes
 * Read-only endpoints for providers, containers, and models
 */

const express = require('express');
const AIRegistryService = require('../services/ai-registry');
const ModelDiscoveryService = require('../services/model-discovery');
const RoutingService = require('../services/routing');
const BillingService = require('../services/billing');

function createAIRegistryRouter(db) {
  const router = express.Router();

  router.get('/providers', (req, res) => {
    try {
      res.json(AIRegistryService.getProviders(db));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/containers', (req, res) => {
    try {
      res.json(AIRegistryService.getContainers(db));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/containers/terminal', (req, res) => {
    try {
      res.json(AIRegistryService.getTerminalContainers(db));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/containers/auth-list', (req, res) => {
    try {
      const containers = AIRegistryService.getContainers(db);
      res.json(containers.map(c => ({
        id: c.id,
        name: c.name,
        hasLogin: !!c.has_login,
        providerName: c.provider_name
      })));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/models/options', (req, res) => {
    try {
      const families = AIRegistryService.getFamilies(db);
      const containers = AIRegistryService.getContainers(db);
      const containerMap = {};
      for (const c of containers) {
        containerMap[c.id] = c;
      }
      // Only show families eligible for conversation (chat)
      const chatFamilies = families.filter(f => {
        if (f.eligible_tasks) {
          const eligible = f.eligible_tasks.split(',').map(s => s.trim());
          if (!eligible.includes('conversation')) return false;
        }
        return (f.cap_chat || 0) > 0;
      });
      res.json(chatFamilies.map(f => ({
        value: f.id,
        label: f.display_name,
        backend: f.container_id,
        loginCmd: containerMap[f.container_id]?.login_command || null,
        hasLogin: !!containerMap[f.container_id]?.has_login
      })));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/models', (req, res) => {
    try {
      res.json(AIRegistryService.getModels(db));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/registry', (req, res) => {
    try {
      res.json(AIRegistryService.getRegistry(db));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api-keys', (req, res) => {
    try {
      const catalog = AIRegistryService.getApiKeyCatalog(db);
      res.json(catalog.map(row => ({
        key: row.env_key,
        label: row.label,
        description: row.description,
        link: row.url,
        linkText: row.url_label,
        placeholder: row.placeholder,
        providerId: row.provider_id,
        displayOrder: row.display_order
      })));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/models/check', async (req, res) => {
    try {
      const results = await ModelDiscoveryService.checkAll(db);
      res.json(results);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/models/versions', (req, res) => {
    try {
      res.json(ModelDiscoveryService.getVersionsByFamily(db));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/families', (req, res) => {
    try {
      res.json(AIRegistryService.getFamilies(db));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/backend-keys', (req, res) => {
    try {
      const rows = db.prepare(`
        SELECT c.id AS container_id, p.api_key_env, k.url
        FROM ai_containers c
        JOIN ai_providers p ON p.id = c.provider_id
        LEFT JOIN api_key_catalog k ON k.env_key = p.api_key_env
      `).all();
      const map = {};
      for (const row of rows) {
        map[row.container_id] = {
          envKeyName: row.api_key_env,
          apiKeyUrl: row.url
        };
      }
      res.json(map);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Readiness Check ---

  router.get('/ready', (req, res) => {
    try {
      const resolved = RoutingService.resolve(db, 'conversation');
      res.json({ ready: resolved.source !== 'fallback' || RoutingService.isAvailable(db, resolved.familyId, resolved.accessMethod) });
    } catch (err) {
      res.json({ ready: false });
    }
  });

  // --- Account Status ---

  router.get('/account-status', (req, res) => {
    try {
      res.json(RoutingService.getAccountStatuses(db));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch('/account-status/:providerId', (req, res) => {
    try {
      RoutingService.updateAccountStatus(db, req.params.providerId, req.body);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Billing ---

  router.post('/billing/check', async (req, res) => {
    try {
      await BillingService.checkAll(db);
      res.json(RoutingService.getAccountStatuses(db));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Routing ---

  router.get('/routing/preference', (req, res) => {
    try {
      const preferences = {};
      for (const tt of RoutingService.TASK_TYPES) {
        preferences[tt] = RoutingService.getPreference(db, tt);
      }
      // Backward compat: preference = conversation default
      res.json({ preference: preferences.conversation, preferences });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/routing/preference', (req, res) => {
    try {
      const { preference, taskType } = req.body;
      RoutingService.setPreference(db, preference, taskType || null);
      res.json({ success: true, preference });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/routing/constraints', (req, res) => {
    try {
      res.json(RoutingService.getConstraints(db));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/routing/constraints', (req, res) => {
    try {
      const { constraints } = req.body;
      RoutingService.setConstraints(db, constraints);
      // Regenerate all cascades to reflect new constraints
      db.prepare('DELETE FROM routing_cascade').run();
      RoutingService.regenerateAll(db);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/routing/:taskType', (req, res) => {
    try {
      const { taskType } = req.params;
      if (!RoutingService.TASK_TYPES.includes(taskType)) {
        return res.status(400).json({ error: `Invalid task type: ${taskType}` });
      }
      const cascade = RoutingService.getCascade(db, taskType);
      // Enrich with family + container + account status info
      const families = AIRegistryService.getFamilies(db);
      const familyMap = {};
      for (const f of families) { familyMap[f.id] = f; }
      const statuses = RoutingService.getAccountStatuses(db);
      const statusMap = {};
      for (const s of statuses) { statusMap[s.provider_id] = s; }
      const enriched = cascade.map(c => {
        const family = familyMap[c.family_id] || null;
        const container = family ? AIRegistryService.getContainer(db, family.container_id) : null;
        const accountStatus = container ? statusMap[container.provider_id] : null;
        return { ...c, family, accountStatus };
      });
      res.json(enriched);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/routing/:taskType', (req, res) => {
    try {
      const { taskType } = req.params;
      if (!RoutingService.TASK_TYPES.includes(taskType)) {
        return res.status(400).json({ error: `Invalid task type: ${taskType}` });
      }
      RoutingService.updateCascade(db, taskType, req.body.entries);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/routing/regenerate', (req, res) => {
    try {
      // Clear all cascades first to allow regeneration
      db.prepare('DELETE FROM routing_cascade').run();
      RoutingService.regenerateAll(db);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Mode (Phase 3 §4.2) ---

  router.get('/routing/mode', (req, res) => {
    try {
      res.json({ mode: RoutingService.getMode(db), validModes: RoutingService.VALID_MODES });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/routing/mode', (req, res) => {
    try {
      const { mode } = req.body;
      if (!RoutingService.VALID_MODES.includes(mode)) {
        return res.status(400).json({ error: `Invalid mode: ${mode}. Expected one of: ${RoutingService.VALID_MODES.join(', ')}` });
      }
      RoutingService.setMode(db, mode);
      // TODO(phase-4): broadcast a CUSTOM `mode-switch` ag-ui event to all open
      // agent SSE streams so the UI re-renders model badges. Requires a global
      // broadcaster that doesn't exist yet (per-agent state.responseClients is
      // the only broadcast channel today).
      res.json({ success: true, mode });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Local status (Phase 3 §0 acceptance #7) ---

  /**
   * GET /api/ai/local-status — surface every local family's serving status
   * tied to LauncherClient.getCapabilities(). Used by Settings UI and the
   * onboarding preflight (Phase 4) to give the user an honest picture of
   * what's actually serving vs what's seeded but offline.
   *
   * Shape:
   *   {
   *     ai_mode: 'proprietary' | 'local',
   *     launcher: { reachable: boolean, base_url: string | null },
   *     families: [
   *       { id, launcher_model, launcher_backend, supports_vision,
   *         eligible_tasks, serving: boolean, served_tasks: string[] }
   *     ]
   *   }
   */
  router.get('/local-status', async (req, res) => {
    try {
      const LauncherClient = require('../services/launcher-client');
      const families = db.prepare(`
        SELECT id, launcher_model, launcher_backend, supports_vision, eligible_tasks
        FROM ai_model_families
        WHERE container_id = 'local'
        ORDER BY display_order ASC
      `).all();

      const reachable = await LauncherClient.isReachable();
      let caps = null;
      let baseUrl = LauncherClient.DEFAULT_BASE;
      if (reachable) {
        try { caps = await LauncherClient.getCapabilities(); } catch (_e) { caps = null; }
      }

      // Build a launcher_model → served_tasks index from the capabilities map.
      // Launcher's caps payload is { taskType: [{instance_id, model, base_url}, ...] }
      // OR { taskType: {model, base_url} } depending on launcher version.
      const servingByModel = new Map();
      if (caps) {
        for (const [taskType, entries] of Object.entries(caps)) {
          const list = Array.isArray(entries) ? entries : [entries];
          for (const entry of list) {
            const model = entry?.model || entry?.model_id;
            if (!model) continue;
            if (!servingByModel.has(model)) servingByModel.set(model, []);
            servingByModel.get(model).push(taskType);
          }
        }
      }

      const enriched = families.map(f => {
        const tasks = servingByModel.get(f.launcher_model) || [];
        return {
          id: f.id,
          launcher_model: f.launcher_model,
          launcher_backend: f.launcher_backend,
          supports_vision: !!f.supports_vision,
          eligible_tasks: f.eligible_tasks || null,
          serving: tasks.length > 0,
          served_tasks: tasks
        };
      });

      res.json({
        ai_mode: RoutingService.getMode(db),
        launcher: { reachable, base_url: baseUrl },
        families: enriched
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createAIRegistryRouter;
