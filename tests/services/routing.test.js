import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const RoutingService = require('../../src/services/routing');

// Test data
const FAMILIES = [
  { id: 'claude-opus', container_id: 'claude', name: 'Opus', display_name: 'Claude Opus', cli_model_arg: 'opus', cost_tier: 5, cap_chat: 4, cap_jobs: 5, cap_planning: 5, cap_coding: 5 },
  { id: 'claude-sonnet', container_id: 'claude', name: 'Sonnet', display_name: 'Claude Sonnet', cli_model_arg: 'sonnet', cost_tier: 3, cap_chat: 4, cap_jobs: 4, cap_planning: 3, cap_coding: 4 },
  { id: 'claude-haiku', container_id: 'claude', name: 'Haiku', display_name: 'Claude Haiku', cli_model_arg: 'haiku', cost_tier: 1, cap_chat: 2, cap_jobs: 2, cap_planning: 2, cap_coding: 2 },
  { id: 'gemini-pro', container_id: 'gemini', name: 'Pro', display_name: 'Gemini Pro', cli_model_arg: 'gemini-2.5-pro', cost_tier: 4, cap_chat: 4, cap_jobs: 4, cap_planning: 4, cap_coding: 4 },
  { id: 'grok', container_id: 'grok', name: 'Grok', display_name: 'Grok', cli_model_arg: 'grok-4-0709', cost_tier: 4, cap_chat: 3, cap_jobs: 3, cap_planning: 3, cap_coding: 3 },
];

const CONTAINERS = {
  claude: { id: 'claude', provider_id: 'anthropic', has_login: 1 },
  gemini: { id: 'gemini', provider_id: 'google', has_login: 1 },
  grok: { id: 'grok', provider_id: 'xai', has_login: 0 }
};

const PROVIDERS = {
  anthropic: { id: 'anthropic', api_key_env: 'ANTHROPIC_API_KEY' },
  google: { id: 'google', api_key_env: 'GOOGLE_API_KEY' },
  xai: { id: 'xai', api_key_env: 'XAI_API_KEY' }
};

// Monkey-patch AIRegistryService
const AIRegistryService = require('../../src/services/ai-registry');
const originals = {
  getFamily: AIRegistryService.getFamily,
  getContainer: AIRegistryService.getContainer,
  getProvider: AIRegistryService.getProvider,
  getFamilies: AIRegistryService.getFamilies,
  resolveModelArg: AIRegistryService.resolveModelArg,
};

function setupMocks() {
  AIRegistryService.getFamily = (_, id) => FAMILIES.find(f => f.id === id) || null;
  AIRegistryService.getContainer = (_, id) => CONTAINERS[id] || null;
  AIRegistryService.getProvider = (_, id) => PROVIDERS[id] || null;
  AIRegistryService.getFamilies = () => FAMILIES;
  AIRegistryService.resolveModelArg = (_, familyId) => {
    const f = FAMILIES.find(ff => ff.id === familyId);
    return f?.cli_model_arg || null;
  };
}

function teardownMocks() {
  Object.assign(AIRegistryService, originals);
}

// Mock db
function createMockDb(opts = {}) {
  const statuses = opts.statuses || {
    anthropic: { login_status: 'active', api_status: 'valid', login_exhausted_until: null, api_exhausted_until: null },
    google: { login_status: 'active', api_status: 'valid', login_exhausted_until: null, api_exhausted_until: null },
    xai: { login_status: 'unknown', api_status: 'valid', login_exhausted_until: null, api_exhausted_until: null }
  };
  const cascades = opts.cascades || {};
  let preference = opts.preference || 'balanced';
  const taskPreferences = opts.taskPreferences || {};
  const settings = { routing_preference: preference };
  for (const [k, v] of Object.entries(taskPreferences)) {
    settings[`routing_preference_${k}`] = v;
  }

  return {
    prepare: (sql) => ({
      run: (...args) => {
        if (sql.includes('ai_account_status') && sql.includes('SET')) {
          if (sql.includes('login_exhausted_until')) {
            const pid = args[args.length - 1];
            if (statuses[pid]) statuses[pid].login_exhausted_until = args[0];
          }
          if (sql.includes('api_exhausted_until') && !sql.includes('login_exhausted_until')) {
            const pid = args[args.length - 1];
            if (statuses[pid]) statuses[pid].api_exhausted_until = args[0];
          }
        }
        if (sql.includes('settings') && sql.includes('INSERT OR REPLACE')) {
          settings[args[0]] = args[1];
        }
        if (sql.includes('routing_cascade') && sql.includes('DELETE') && sql.includes('task_type')) {
          cascades[args[0]] = [];
        }
        if (sql.includes('routing_cascade') && sql.includes('INSERT')) {
          const taskType = args[0];
          if (!cascades[taskType]) cascades[taskType] = [];
          cascades[taskType].push({ task_type: taskType, priority: args[1], family_id: args[2], access_method: args[3], enabled: 1, is_auto_generated: 1 });
        }
      },
      get: (...args) => {
        if (sql.includes('COUNT(*)')) {
          const total = Object.values(cascades).reduce((sum, arr) => sum + arr.length, 0);
          return { cnt: total };
        }
        if (sql.includes('settings') && sql.includes('key = ?')) {
          const key = args[0];
          return settings[key] != null ? { value: settings[key] } : null;
        }
        if (sql.includes('settings') && sql.includes("key = 'routing_preference'")) {
          return settings.routing_preference ? { value: settings.routing_preference } : null;
        }
        if (sql.includes('ai_account_status') && sql.includes('provider_id')) {
          return statuses[args[0]] || null;
        }
        return null;
      },
      all: (...args) => {
        if (sql.includes('routing_cascade') && sql.includes('task_type')) {
          return cascades[args[0]] || [];
        }
        if (sql.includes('ai_providers')) {
          return Object.keys(PROVIDERS).map(id => ({ id }));
        }
        return [];
      }
    }),
    exec: () => {},
    transaction: (fn) => function(...args) { return fn.apply(this, args); }
  };
}

describe('RoutingService', () => {
  beforeEach(() => { setupMocks(); });
  afterEach(() => { teardownMocks(); });

  describe('resolve', () => {
    it('returns cascade entry with access_method', () => {
      const db = createMockDb({
        cascades: {
          conversation: [
            { family_id: 'claude-sonnet', access_method: 'login', enabled: 1, priority: 0 },
            { family_id: 'claude-sonnet', access_method: 'api', enabled: 1, priority: 1 }
          ]
        }
      });
      const result = RoutingService.resolve(db, 'conversation');
      expect(result.source).toBe('cascade');
      expect(result.familyId).toBe('claude-sonnet');
      expect(result.accessMethod).toBe('login');
      expect(result.modelArg).toBe('sonnet');
    });

    it('skips login entry when login exhausted, falls to API', () => {
      const far = new Date(Date.now() + 3600000).toISOString();
      const db = createMockDb({
        statuses: {
          anthropic: { login_status: 'active', api_status: 'valid', login_exhausted_until: far, api_exhausted_until: null },
          google: { login_status: 'active', api_status: 'valid', login_exhausted_until: null, api_exhausted_until: null },
          xai: { login_status: 'unknown', api_status: 'valid', login_exhausted_until: null, api_exhausted_until: null }
        },
        cascades: {
          conversation: [
            { family_id: 'claude-sonnet', access_method: 'login', enabled: 1, priority: 0 },
            { family_id: 'claude-sonnet', access_method: 'api', enabled: 1, priority: 1 }
          ]
        }
      });
      const result = RoutingService.resolve(db, 'conversation');
      expect(result.familyId).toBe('claude-sonnet');
      expect(result.accessMethod).toBe('api');
    });

    it('respects agent override for conversation (tries login first)', () => {
      const db = createMockDb({
        cascades: { conversation: [{ family_id: 'claude-sonnet', access_method: 'login', enabled: 1, priority: 0 }] }
      });
      const result = RoutingService.resolve(db, 'conversation', 'claude-haiku');
      expect(result.familyId).toBe('claude-haiku');
      expect(result.source).toBe('agent_override');
      expect(result.accessMethod).toBe('login');
    });

    it('agent override falls to API when login unavailable', () => {
      const db = createMockDb({
        statuses: {
          anthropic: { login_status: 'not_configured', api_status: 'valid', login_exhausted_until: null, api_exhausted_until: null },
          google: { login_status: 'active', api_status: 'valid', login_exhausted_until: null, api_exhausted_until: null },
          xai: { login_status: 'unknown', api_status: 'valid', login_exhausted_until: null, api_exhausted_until: null }
        },
        cascades: { conversation: [{ family_id: 'claude-sonnet', access_method: 'login', enabled: 1, priority: 0 }] }
      });
      const result = RoutingService.resolve(db, 'conversation', 'claude-haiku');
      expect(result.familyId).toBe('claude-haiku');
      expect(result.accessMethod).toBe('api');
      expect(result.source).toBe('agent_override');
    });

    it('ignores agent override for jobs (uses cascade)', () => {
      const db = createMockDb({
        cascades: { jobs: [{ family_id: 'claude-haiku', access_method: 'api', enabled: 1, priority: 0 }] }
      });
      const result = RoutingService.resolve(db, 'jobs', 'claude-opus');
      expect(result.source).toBe('cascade');
      expect(result.familyId).toBe('claude-haiku');
      expect(result.accessMethod).toBe('api');
    });

    it('treats auto as cascade', () => {
      const db = createMockDb({
        cascades: { conversation: [{ family_id: 'claude-sonnet', access_method: 'login', enabled: 1, priority: 0 }] }
      });
      const result = RoutingService.resolve(db, 'conversation', 'auto');
      expect(result.source).toBe('cascade');
    });

    it('skips disabled entries', () => {
      const db = createMockDb({
        cascades: {
          conversation: [
            { family_id: 'claude-opus', access_method: 'login', enabled: 0, priority: 0 },
            { family_id: 'claude-sonnet', access_method: 'api', enabled: 1, priority: 1 }
          ]
        }
      });
      const result = RoutingService.resolve(db, 'conversation');
      expect(result.familyId).toBe('claude-sonnet');
      expect(result.accessMethod).toBe('api');
    });

    it('falls back to claude-sonnet API when nothing available', () => {
      const far = new Date(Date.now() + 3600000).toISOString();
      const db = createMockDb({
        statuses: {
          anthropic: { login_exhausted_until: far, api_exhausted_until: far, login_status: 'active', api_status: 'valid' },
          google: { login_exhausted_until: far, api_exhausted_until: far, login_status: 'active', api_status: 'valid' },
          xai: { login_exhausted_until: far, api_exhausted_until: far, login_status: 'unknown', api_status: 'valid' }
        },
        cascades: { conversation: [{ family_id: 'claude-opus', access_method: 'login', enabled: 1, priority: 0 }] }
      });
      const result = RoutingService.resolve(db, 'conversation');
      expect(result.source).toBe('fallback');
      expect(result.familyId).toBe('claude-sonnet');
      expect(result.accessMethod).toBe('api');
    });
  });

  describe('isAvailable', () => {
    it('returns true for login when provider login is active', () => {
      const db = createMockDb();
      expect(RoutingService.isAvailable(db, 'claude-opus', 'login')).toBe(true);
    });

    it('returns false for login when has_login is 0', () => {
      const db = createMockDb();
      expect(RoutingService.isAvailable(db, 'grok', 'login')).toBe(false);
    });

    it('returns false for login when login is exhausted', () => {
      const far = new Date(Date.now() + 3600000).toISOString();
      const db = createMockDb({
        statuses: {
          anthropic: { login_status: 'active', api_status: 'valid', login_exhausted_until: far, api_exhausted_until: null },
          google: { login_status: 'active', api_status: 'valid', login_exhausted_until: null, api_exhausted_until: null },
          xai: { login_status: 'unknown', api_status: 'valid', login_exhausted_until: null, api_exhausted_until: null }
        }
      });
      expect(RoutingService.isAvailable(db, 'claude-opus', 'login')).toBe(false);
    });

    it('returns true for API when key is valid', () => {
      const db = createMockDb();
      expect(RoutingService.isAvailable(db, 'grok', 'api')).toBe(true);
    });

    it('returns false for API when api_status is no_key', () => {
      const db = createMockDb({
        statuses: {
          anthropic: { login_status: 'active', api_status: 'valid', login_exhausted_until: null, api_exhausted_until: null },
          google: { login_status: 'active', api_status: 'valid', login_exhausted_until: null, api_exhausted_until: null },
          xai: { login_status: 'unknown', api_status: 'no_key', login_exhausted_until: null, api_exhausted_until: null }
        }
      });
      expect(RoutingService.isAvailable(db, 'grok', 'api')).toBe(false);
    });

    it('returns false for unknown family', () => {
      const db = createMockDb();
      expect(RoutingService.isAvailable(db, 'nonexistent', 'api')).toBe(false);
    });

    it('returns false for login when not_configured', () => {
      const db = createMockDb({
        statuses: {
          anthropic: { login_status: 'not_configured', api_status: 'valid', login_exhausted_until: null, api_exhausted_until: null },
          google: { login_status: 'active', api_status: 'valid', login_exhausted_until: null, api_exhausted_until: null },
          xai: { login_status: 'unknown', api_status: 'valid', login_exhausted_until: null, api_exhausted_until: null }
        }
      });
      expect(RoutingService.isAvailable(db, 'claude-opus', 'login')).toBe(false);
    });
  });

  describe('isBillingError', () => {
    it('detects anthropic billing errors', () => {
      expect(RoutingService.isBillingError('Error: credit balance is too low', 'anthropic')).toBe(true);
      expect(RoutingService.isBillingError('rate_limit_error: too many requests', 'anthropic')).toBe(true);
    });

    it('detects google quota errors', () => {
      expect(RoutingService.isBillingError('RESOURCE_EXHAUSTED: quota exceeded', 'google')).toBe(true);
    });

    it('returns false for non-billing errors', () => {
      expect(RoutingService.isBillingError('connection refused', 'anthropic')).toBe(false);
    });

    it('returns false for unknown providers', () => {
      expect(RoutingService.isBillingError('rate_limit_error', 'unknown_provider')).toBe(false);
    });
  });

  describe('generateCascade', () => {
    it('generates login + API entries for has_login containers', () => {
      const db = createMockDb();
      const cascade = RoutingService.generateCascade(db, 'conversation');
      // claude (3 families × 2) + gemini (1 family × 2) + grok (1 family × 1 api-only) = 9
      const loginEntries = cascade.filter(e => e.access_method === 'login');
      const apiEntries = cascade.filter(e => e.access_method === 'api');
      expect(loginEntries.length).toBe(4); // claude-opus, claude-sonnet, claude-haiku, gemini-pro
      expect(apiEntries.length).toBe(5); // all 5 families
      expect(cascade.length).toBe(9);
    });

    it('login entries have discounted cost', () => {
      const db = createMockDb();
      const cascade = RoutingService.generateCascade(db, 'conversation');
      const opusLogin = cascade.find(e => e.family_id === 'claude-opus' && e.access_method === 'login');
      const opusApi = cascade.find(e => e.family_id === 'claude-opus' && e.access_method === 'api');
      // Opus cost_tier=5, login discount = ceil(5/2) = 3
      expect(opusLogin.cost_display).toBe(3);
      expect(opusApi.cost_display).toBe(5);
      // Login should score higher (lower cost = better)
      expect(opusLogin.score).toBeGreaterThan(opusApi.score);
    });

    it('sorted by score descending', () => {
      const db = createMockDb();
      const cascade = RoutingService.generateCascade(db, 'conversation');
      for (let i = 1; i < cascade.length; i++) {
        expect(cascade[i - 1].score).toBeGreaterThanOrEqual(cascade[i].score);
      }
    });

    it('best_quality puts high-cap login entries near top', () => {
      const db = createMockDb({ preference: 'best_quality' });
      const cascade = RoutingService.generateCascade(db, 'conversation');
      // All top entries should be login (cheaper) with high capability
      // Opus login and Sonnet login both have cap_chat=4
      const opusLoginIdx = cascade.findIndex(e => e.family_id === 'claude-opus' && e.access_method === 'login');
      const opusApiIdx = cascade.findIndex(e => e.family_id === 'claude-opus' && e.access_method === 'api');
      // Login variant always beats API variant of same family (same cap, lower cost)
      expect(opusLoginIdx).toBeLessThan(opusApiIdx);
      // High-cap entries above low-cap entries
      const haikuIdx = cascade.findIndex(e => e.family_id === 'claude-haiku' && e.access_method === 'api');
      expect(opusLoginIdx).toBeLessThan(haikuIdx);
    });

    it('minimize_cost puts cheap login entries first', () => {
      const db = createMockDb({ preference: 'minimize_cost' });
      const cascade = RoutingService.generateCascade(db, 'conversation');
      // Haiku login should be near top (cap 2, cost 1 → discounted cost 1)
      const haikuLoginIdx = cascade.findIndex(e => e.family_id === 'claude-haiku' && e.access_method === 'login');
      const opusApiIdx = cascade.findIndex(e => e.family_id === 'claude-opus' && e.access_method === 'api');
      expect(haikuLoginIdx).toBeLessThan(opusApiIdx);
    });

    it('grok has no login entry', () => {
      const db = createMockDb();
      const cascade = RoutingService.generateCascade(db, 'conversation');
      const grokLogin = cascade.filter(e => e.family_id === 'grok' && e.access_method === 'login');
      const grokApi = cascade.filter(e => e.family_id === 'grok' && e.access_method === 'api');
      expect(grokLogin.length).toBe(0);
      expect(grokApi.length).toBe(1);
    });

    it('jobs cascade has API entries only (no login per ToS)', () => {
      const db = createMockDb();
      const cascade = RoutingService.generateCascade(db, 'jobs');
      const loginEntries = cascade.filter(e => e.access_method === 'login');
      expect(loginEntries.length).toBe(0);
      expect(cascade.length).toBeGreaterThan(0);
      cascade.forEach(e => expect(e.access_method).toBe('api'));
    });
  });

  describe('preference', () => {
    it('gets default preference', () => {
      const db = createMockDb();
      expect(RoutingService.getPreference(db)).toBe('balanced');
    });

    it('rejects invalid preference', () => {
      const db = createMockDb();
      expect(() => RoutingService.setPreference(db, 'invalid')).toThrow('Invalid routing preference');
    });

    it('gets per-task preference', () => {
      const db = createMockDb({ taskPreferences: { conversation: 'best_quality', jobs: 'minimize_cost' } });
      expect(RoutingService.getPreference(db, 'conversation')).toBe('best_quality');
      expect(RoutingService.getPreference(db, 'jobs')).toBe('minimize_cost');
    });

    it('falls back to global when per-task not set', () => {
      const db = createMockDb({ preference: 'best_quality' });
      expect(RoutingService.getPreference(db, 'planning')).toBe('best_quality');
    });

    it('sets per-task preference without affecting others', () => {
      const db = createMockDb({ taskPreferences: { conversation: 'balanced', jobs: 'balanced' } });
      RoutingService.setPreference(db, 'best_quality', 'conversation');
      expect(RoutingService.getPreference(db, 'conversation')).toBe('best_quality');
      expect(RoutingService.getPreference(db, 'jobs')).toBe('balanced');
    });

    it('sets all task types when no taskType specified', () => {
      const db = createMockDb();
      RoutingService.setPreference(db, 'minimize_cost');
      expect(RoutingService.getPreference(db, 'conversation')).toBe('minimize_cost');
      expect(RoutingService.getPreference(db, 'jobs')).toBe('minimize_cost');
      expect(RoutingService.getPreference(db, 'planning')).toBe('minimize_cost');
      expect(RoutingService.getPreference(db, 'coding')).toBe('minimize_cost');
    });

    it('rejects invalid task type', () => {
      const db = createMockDb();
      expect(() => RoutingService.setPreference(db, 'balanced', 'invalid_task')).toThrow('Invalid task type');
    });
  });

  describe('generateCascade with per-task preferences', () => {
    it('uses per-task preference for scoring', () => {
      const db = createMockDb({ taskPreferences: { conversation: 'best_quality', jobs: 'minimize_cost' } });
      const convCascade = RoutingService.generateCascade(db, 'conversation');
      const jobsCascade = RoutingService.generateCascade(db, 'jobs');
      // Best quality: high-cap models first; Minimize cost: low-cost first
      // Conversation should have opus near top, jobs should have haiku near top
      const convOpusIdx = convCascade.findIndex(e => e.family_id === 'claude-opus');
      const convHaikuIdx = convCascade.findIndex(e => e.family_id === 'claude-haiku');
      expect(convOpusIdx).toBeLessThan(convHaikuIdx);
      const jobsHaikuIdx = jobsCascade.findIndex(e => e.family_id === 'claude-haiku');
      const jobsOpusIdx = jobsCascade.findIndex(e => e.family_id === 'claude-opus');
      expect(jobsHaikuIdx).toBeLessThan(jobsOpusIdx);
    });
  });

  describe('mode (Phase 3 §4.2)', () => {
    // The shared mock's cascades dict is keyed by task_type only, not
    // (task_type, mode). That matches the SQL filter from the caller's
    // perspective for a single mode. For mode-specific tests we simulate the
    // target mode's rows via the cascades opt and set ai_mode accordingly.
    it('getMode defaults to proprietary when ai_mode unset', () => {
      const db = createMockDb();
      expect(RoutingService.getMode(db)).toBe('proprietary');
    });

    it('getMode returns local when setting is local', () => {
      const db = createMockDb();
      RoutingService.setMode(db, 'local');
      expect(RoutingService.getMode(db)).toBe('local');
    });

    it('getMode fails safe to proprietary on unknown values', () => {
      const db = createMockDb();
      // Write an invalid value directly to settings (bypass the validator).
      // Use the same parameterized shape setMode uses so the mock captures key+value.
      db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)").run('ai_mode', 'garbled');
      expect(RoutingService.getMode(db)).toBe('proprietary');
    });

    it('setMode rejects invalid modes', () => {
      const db = createMockDb();
      expect(() => RoutingService.setMode(db, 'hybrid')).toThrow(/Invalid ai_mode/);
    });

    it('resolve hard-fallback under ai_mode=local returns local-family (privacy promise)', () => {
      // Empty cascade + no agent override → hard fallback.
      const db = createMockDb({ cascades: { conversation: [] } });
      RoutingService.setMode(db, 'local');
      const result = RoutingService.resolve(db, 'conversation');
      expect(result.source).toBe('local_no_fallback');
      expect(result.familyId).toBe('local-gemma-4-31b');
      expect(result.backendId).toBe('local');
      // Critical: NEVER cloud-family under ai_mode=local.
      expect(result.familyId).not.toMatch(/^(claude|gemini|gpt|grok)/);
    });

    it('resolve hard-fallback under ai_mode=proprietary returns claude-sonnet (unchanged)', () => {
      const db = createMockDb({ cascades: { conversation: [] } });
      // mode is default 'proprietary'
      const result = RoutingService.resolve(db, 'conversation');
      expect(result.source).toBe('fallback');
      expect(result.familyId).toBe('claude-sonnet');
    });

    it('generateCascade(mode=proprietary) excludes HTTP containers', () => {
      // Inject an HTTP family into the mocked family list.
      const origFamilies = AIRegistryService.getFamilies;
      const origContainer = AIRegistryService.getContainer;
      AIRegistryService.getFamilies = () => [
        ...FAMILIES,
        { id: 'local-chat', container_id: 'local', name: 'Local', display_name: 'Local', cli_model_arg: 'x', cost_tier: 1, cap_chat: 5, cap_jobs: 5, cap_planning: 5, cap_coding: 5 }
      ];
      AIRegistryService.getContainer = (_, id) => id === 'local' ? { id: 'local', provider_id: 'local', type: 'http' } : CONTAINERS[id] || null;
      try {
        const db = createMockDb();
        const propCascade = RoutingService.generateCascade(db, 'conversation', 'proprietary');
        expect(propCascade.every(e => e.family_id !== 'local-chat')).toBe(true);
      } finally {
        AIRegistryService.getFamilies = origFamilies;
        AIRegistryService.getContainer = origContainer;
      }
    });

    it('generateCascade(mode=local) includes only HTTP containers', () => {
      const origFamilies = AIRegistryService.getFamilies;
      const origContainer = AIRegistryService.getContainer;
      const origProvider = AIRegistryService.getProvider;
      AIRegistryService.getFamilies = () => [
        ...FAMILIES,
        { id: 'local-chat', container_id: 'local', name: 'Local', display_name: 'Local', cli_model_arg: 'x', cost_tier: 1, cap_chat: 5, cap_jobs: 5, cap_planning: 5, cap_coding: 5 }
      ];
      AIRegistryService.getContainer = (_, id) => id === 'local' ? { id: 'local', provider_id: 'local', type: 'http', has_login: 0 } : CONTAINERS[id] || null;
      AIRegistryService.getProvider = (_, id) => id === 'local' ? { id: 'local', api_key_env: null } : PROVIDERS[id] || null;
      try {
        const db = createMockDb();
        // Constraints need a `local` entry for the mode-local path to emit the API entry.
        db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('model_api_constraints', ?, CURRENT_TIMESTAMP)")
          .run(JSON.stringify({ ...RoutingService._defaultConstraints() }));
        const localCascade = RoutingService.generateCascade(db, 'conversation', 'local');
        expect(localCascade.length).toBeGreaterThan(0);
        expect(localCascade.every(e => e.family_id === 'local-chat')).toBe(true);
      } finally {
        AIRegistryService.getFamilies = origFamilies;
        AIRegistryService.getContainer = origContainer;
        AIRegistryService.getProvider = origProvider;
      }
    });

    it('_defaultConstraints includes local pseudo-provider', () => {
      const constraints = RoutingService._defaultConstraints();
      expect(constraints.local).toBeDefined();
      for (const tt of RoutingService.TASK_TYPES) {
        expect(constraints.local[tt]).toBe('api');
      }
    });

    it('VALID_MODES is exposed and contains the two modes', () => {
      expect(RoutingService.VALID_MODES).toEqual(['proprietary', 'local']);
    });
  });

  describe('nextInCascade (Phase 3 §4.3 — jobs escalation)', () => {
    it('returns the next entry under the current mode', () => {
      const db = createMockDb({
        cascades: {
          jobs: [
            { family_id: 'local-qwen3-coder-30b', access_method: 'api', enabled: 1, priority: 0 },
            { family_id: 'local-qwen3-coder-next', access_method: 'api', enabled: 1, priority: 1 }
          ]
        }
      });
      const next = RoutingService.nextInCascade(db, 'jobs', 'local-qwen3-coder-30b', 'api');
      expect(next).toBeDefined();
      expect(next.family_id).toBe('local-qwen3-coder-next');
    });

    it('returns null when the current entry is the last in the cascade', () => {
      const db = createMockDb({
        cascades: {
          jobs: [
            { family_id: 'local-qwen3-coder-30b', access_method: 'api', enabled: 1, priority: 0 },
            { family_id: 'local-qwen3-coder-next', access_method: 'api', enabled: 1, priority: 1 }
          ]
        }
      });
      const next = RoutingService.nextInCascade(db, 'jobs', 'local-qwen3-coder-next', 'api');
      expect(next).toBe(null);
    });

    it('returns null when the current familyId is not in the cascade', () => {
      const db = createMockDb({
        cascades: {
          jobs: [
            { family_id: 'local-qwen3-coder-30b', access_method: 'api', enabled: 1, priority: 0 }
          ]
        }
      });
      expect(RoutingService.nextInCascade(db, 'jobs', 'unknown-family', 'api')).toBe(null);
    });

    it('skips disabled entries on the way down', () => {
      const db = createMockDb({
        cascades: {
          jobs: [
            { family_id: 'a', access_method: 'api', enabled: 1, priority: 0 },
            { family_id: 'b', access_method: 'api', enabled: 0, priority: 1 },
            { family_id: 'c', access_method: 'api', enabled: 1, priority: 2 }
          ]
        }
      });
      const next = RoutingService.nextInCascade(db, 'jobs', 'a', 'api');
      expect(next.family_id).toBe('c');
    });

    it('matches access_method as well as family_id', () => {
      const db = createMockDb({
        cascades: {
          conversation: [
            { family_id: 'claude-sonnet', access_method: 'login', enabled: 1, priority: 0 },
            { family_id: 'claude-sonnet', access_method: 'api',   enabled: 1, priority: 1 },
            { family_id: 'gemini-pro',    access_method: 'api',   enabled: 1, priority: 2 }
          ]
        }
      });
      // Starting at the API entry, next is gemini-pro — not the login entry above.
      const next = RoutingService.nextInCascade(db, 'conversation', 'claude-sonnet', 'api');
      expect(next.family_id).toBe('gemini-pro');
    });
  });

  describe('maybeSwapForVision (Phase 3 §4.6)', () => {
    // The shared mock's getFamily uses FAMILIES; we add vision-capable family
    // for these specific tests via a local override.
    function setupVisionMocks(visionFamilies) {
      const orig = AIRegistryService.getFamily;
      AIRegistryService.getFamily = (_, id) => {
        const found = visionFamilies.find(f => f.id === id);
        if (found) return found;
        return FAMILIES.find(f => f.id === id) || null;
      };
      return () => { AIRegistryService.getFamily = orig; };
    }

    function dbWithVisionFamily(visionRow, opts = {}) {
      const db = createMockDb(opts);
      db.prepare = ((origPrepare) => (sql) => {
        if (sql.includes('supports_vision = 1')) {
          return { get: () => visionRow || null, all: () => [] };
        }
        return origPrepare(sql);
      })(db.prepare.bind(db));
      return db;
    }

    it('returns the resolved object unchanged when no attachments', () => {
      const db = createMockDb();
      const resolved = { familyId: 'claude-sonnet', backendId: 'claude', source: 'cascade' };
      expect(RoutingService.maybeSwapForVision(db, resolved, false)).toBe(resolved);
    });

    it('returns unchanged under ai_mode=proprietary even with attachments', () => {
      const db = createMockDb();
      // Default mode is proprietary
      const resolved = { familyId: 'claude-sonnet', backendId: 'claude', source: 'cascade' };
      expect(RoutingService.maybeSwapForVision(db, resolved, true)).toBe(resolved);
    });

    it('returns unchanged when current family already supports vision', () => {
      const restore = setupVisionMocks([
        { id: 'local-qwen3-6-35b-a3b', container_id: 'local', supports_vision: 1, cli_model_arg: 'qwen3-6-35b-a3b' }
      ]);
      try {
        const db = createMockDb();
        RoutingService.setMode(db, 'local');
        const resolved = { familyId: 'local-qwen3-6-35b-a3b', backendId: 'local', source: 'cascade' };
        expect(RoutingService.maybeSwapForVision(db, resolved, true)).toBe(resolved);
      } finally { restore(); }
    });

    it('swaps to vision family under ai_mode=local with attachments', () => {
      const restore = setupVisionMocks([
        { id: 'local-qwen3-6-35b-a3b', container_id: 'local', supports_vision: 1, cli_model_arg: 'qwen3-6-35b-a3b' }
      ]);
      try {
        const db = dbWithVisionFamily({ id: 'local-qwen3-6-35b-a3b', container_id: 'local' });
        RoutingService.setMode(db, 'local');
        const resolved = { familyId: 'local-gemma-4-31b', backendId: 'local', source: 'cascade' };
        const swapped = RoutingService.maybeSwapForVision(db, resolved, true);
        expect(swapped).not.toBe(resolved);
        expect(swapped.familyId).toBe('local-qwen3-6-35b-a3b');
        expect(swapped.backendId).toBe('local');
        expect(swapped.source).toBe('vision_override');
      } finally { restore(); }
    });

    it('returns unchanged when no vision-capable local family exists', () => {
      const db = dbWithVisionFamily(null);  // SELECT returns no row
      RoutingService.setMode(db, 'local');
      const resolved = { familyId: 'local-gemma-4-31b', backendId: 'local', source: 'cascade' };
      expect(RoutingService.maybeSwapForVision(db, resolved, true)).toBe(resolved);
    });
  });
});
