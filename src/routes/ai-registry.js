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

  router.get('/containers/terminal', async (req, res) => {
    try {
      const mode = RoutingService.getMode(db);
      // Hard-coupling under local mode: ask launcher which CLI it recommends
      // for the running chat model and narrow the dropdown to just that CLI.
      // Falls back to both local CLIs when launcher is unreachable.
      let recommendedClient = null;
      if (mode === 'local') {
        try {
          const LauncherClient = require('../services/launcher-client');
          recommendedClient = await LauncherClient.getRecommendedChatClient();
        } catch (_e) { /* leave null → no narrowing */ }
      }
      res.json(AIRegistryService.getTerminalContainers(db, mode, { recommendedClient }));
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
      // Narrow by current ai_mode so the agent dropdown can only pick
      // families compatible with the master Local-mode toggle. Local mode →
      // container_id='local' only; proprietary mode → everything else. The
      // per-mode pin saved in agent_models preserves the other mode's choice
      // so a switch-back restores it.
      const mode = RoutingService.getMode(db);
      const modeMatches = (f) => mode === 'local'
        ? f.container_id === 'local'
        : f.container_id !== 'local';

      // Only show families eligible for conversation (chat) AND compatible
      // with the active mode.
      const chatFamilies = families.filter(f => {
        if (!modeMatches(f)) return false;
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
      // getDisplayCascade matches what resolve() actually dispatches to:
      // in local mode it collapses chat tasks to the single launcher-
      // selected family. The Model Priority UI renders rows from this
      // endpoint, so the table stays honest about which family is active.
      const cascade = RoutingService.getDisplayCascade(db, taskType);
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
      // Reconcile TTS state with the new mode so agents.voice_id and
      // tts.defaultVoice* flip from (say) Kokoro IDs to ElevenLabs IDs
      // immediately — otherwise the next agent reply would hit the TTS
      // provider with a voice ID from the previous mode and 404.
      try {
        const TTSService = require('../services/tts');
        TTSService.resolveActiveProvider(db);
      } catch (ttsErr) {
        console.warn('[mode-flip] TTS resolveActiveProvider failed:', ttsErr.message);
      }
      // TODO(phase-4): broadcast a CUSTOM `mode-switch` ag-ui event to all open
      // agent SSE streams so the UI re-renders model badges. Requires a global
      // broadcaster that doesn't exist yet (per-agent state.responseClients is
      // the only broadcast channel today).
      res.json({ success: true, mode });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Local mode lifecycle (Phase B) ---
  //
  // Flip + warm in one call. `start` fires ensureModel for each slot with
  // wait=false (returns immediately whether the launcher is preloading or
  // already serving) and writes ai_mode='local'. The UI polls /local-status
  // for per-slot progress rather than blocking on warm-up here.
  //
  // `stop` only flips the flag. We don't stop launcher residents: other tools
  // (Open WebUI, aider, etc.) may be hitting the launcher too, and the launcher
  // owns its own lifecycle policy. Per v2 plan.

  router.post('/local-mode/start', async (req, res) => {
    try {
      const { resolveTriplet, SLOT_ORDER } = require('../services/local-triplet');
      const LauncherClient = require('../services/launcher-client');

      // Snapshot the launcher's currently-active option per slot up-front so
      // every ensureModel hits a consistent target (the chooser could change
      // between calls otherwise).
      const triplet = await resolveTriplet();
      const results = await Promise.all(SLOT_ORDER.map(async (slot) => {
        const { model, backend } = triplet[slot];
        try {
          const out = await LauncherClient.ensureModel({ model, backend, wait: false });
          return { slot, model, status: out?.status || 'unknown' };
        } catch (err) {
          return { slot, model, status: 'error', error: { code: err.code, message: err.message } };
        }
      }));

      RoutingService.setMode(db, 'local');
      try {
        const TTSService = require('../services/tts');
        TTSService.resolveActiveProvider(db);
      } catch (ttsErr) {
        console.warn('[local-mode/start] TTS resolveActiveProvider failed:', ttsErr.message);
      }

      res.json({ success: true, mode: 'local', slots: results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/local-mode/stop', (req, res) => {
    try {
      RoutingService.setMode(db, 'proprietary');
      try {
        const TTSService = require('../services/tts');
        TTSService.resolveActiveProvider(db);
      } catch (ttsErr) {
        console.warn('[local-mode/stop] TTS resolveActiveProvider failed:', ttsErr.message);
      }
      res.json({ success: true, mode: 'proprietary' });
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

      // Phase B — triplet slot view. Cleaner shape for the Settings UI; the
      // `families` field above stays for consumers that want every local
      // family (onboarding preflight, debug views). Reads the launcher's
      // currently-selected option per slot so OS8 mirrors the chooser
      // without duplicating the source of truth.
      const { resolveTriplet, SLOT_ORDER } = require('../services/local-triplet');
      const triplet = await resolveTriplet();
      const slots = SLOT_ORDER.map(slot => {
        const entry = triplet[slot];
        const { model, label } = entry;
        const serving = servingByModel.has(model);
        return {
          slot,
          label,
          model,
          // Surface chooser metadata so the OS8 settings UI can render a
          // read-only "active model" line and (eventually) point users at
          // the launcher when there's a pending Stop & Apply waiting.
          options: entry.options || null,
          selected: entry.selected || null,
          needs_apply: !!entry.needs_apply,
          running_model: entry.running_model || null,
          serving,
          // `loading` is a best-effort inference: launcher is up, model isn't
          // serving yet. Could be mid-warm-up, could be "never started".
          // The start endpoint just fired ensureModel, so during the window
          // immediately after toggle-on this will correctly read as loading.
          loading: reachable && !serving,
          // Port the running instance listens on (used by terminal.js to build
          // LLM_BASE_URL / OPENCODE base URL for terminal-tab sessions).
          running_port: entry.running_port || null,
          // 0.4.14: launcher's recommended CLI for this slot's model. Chat
          // slot only; null for image-gen / tts.
          recommended_client: entry.recommended_client || null,
        };
      });

      // 0.4.14: surface the launcher's recommended_client for the chat slot
      // so the renderer can render the build-proposal "Building with: X" line
      // and resolveDefaultTerminalType in terminal.js without a separate fetch.
      // Read from the chat slot's already-resolved triplet entry.
      const chatSlot = (slots || []).find(s => s.slot === 'chat');
      const recommendedChatClient = chatSlot?.recommended_client || null;

      res.json({
        ai_mode: RoutingService.getMode(db),
        launcher: { reachable, base_url: baseUrl },
        slots,
        families: enriched,
        recommended_chat_client: recommendedChatClient
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createAIRegistryRouter;
