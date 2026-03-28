import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const RoutingService = require('../../src/services/routing');
const AIRegistryService = require('../../src/services/ai-registry');

// Same test data as routing.test.js
const FAMILIES = [
  { id: 'claude-opus', container_id: 'claude', name: 'Opus', display_name: 'Claude Opus', cli_model_arg: 'opus', cost_tier: 5, cap_chat: 4, cap_jobs: 5, cap_planning: 5, cap_coding: 5, cap_summary: 4 },
  { id: 'claude-sonnet', container_id: 'claude', name: 'Sonnet', display_name: 'Claude Sonnet', cli_model_arg: 'sonnet', cost_tier: 3, cap_chat: 4, cap_jobs: 4, cap_planning: 3, cap_coding: 4, cap_summary: 3 },
  { id: 'claude-haiku', container_id: 'claude', name: 'Haiku', display_name: 'Claude Haiku', cli_model_arg: 'haiku', cost_tier: 1, cap_chat: 2, cap_jobs: 2, cap_planning: 2, cap_coding: 2, cap_summary: 4 },
  { id: 'gemini-pro', container_id: 'gemini', name: 'Pro', display_name: 'Gemini Pro', cli_model_arg: 'gemini-2.5-pro', cost_tier: 4, cap_chat: 4, cap_jobs: 4, cap_planning: 4, cap_coding: 4, cap_summary: 3 },
  { id: 'grok', container_id: 'grok', name: 'Grok', display_name: 'Grok', cli_model_arg: 'grok-4-0709', cost_tier: 4, cap_chat: 3, cap_jobs: 3, cap_planning: 3, cap_coding: 3, cap_summary: 2 },
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

// Save/restore AIRegistryService mocks
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

// Mock db with exhaustion support
function createMockDb(opts = {}) {
  const statuses = opts.statuses || {
    anthropic: { login_status: 'active', api_status: 'valid', login_exhausted_until: null, api_exhausted_until: null },
    google: { login_status: 'active', api_status: 'valid', login_exhausted_until: null, api_exhausted_until: null },
    xai: { login_status: 'unknown', api_status: 'valid', login_exhausted_until: null, api_exhausted_until: null }
  };
  const cascades = opts.cascades || {};
  const settings = { routing_preference: opts.preference || 'balanced' };
  for (const [k, v] of Object.entries(opts.taskPreferences || {})) {
    settings[`routing_preference_${k}`] = v;
  }
  const constraints = opts.constraints || null;
  if (constraints) {
    settings['model_api_constraints'] = JSON.stringify(constraints);
  }

  return {
    prepare: (sql) => ({
      run: (...args) => {
        if (sql.includes('ai_account_status') && sql.includes('login_exhausted_until') && sql.includes('SET')) {
          const pid = args[args.length - 1];
          const val = sql.includes('login_exhausted_until = NULL') ? null : args[0];
          if (statuses[pid]) statuses[pid].login_exhausted_until = val;
        }
        if (sql.includes('ai_account_status') && sql.includes('api_exhausted_until') && sql.includes('SET') && !sql.includes('login_exhausted_until')) {
          const pid = args[args.length - 1];
          const val = sql.includes('api_exhausted_until = NULL') ? null : args[0];
          if (statuses[pid]) statuses[pid].api_exhausted_until = val;
        }
        if (sql.includes('settings') && sql.includes('INSERT OR REPLACE')) {
          settings[args[0]] = args[1];
        }
      },
      get: (...args) => {
        if (sql.includes('settings') && sql.includes('key = ?')) {
          const key = args[0];
          return settings[key] != null ? { value: settings[key] } : null;
        }
        if (sql.includes('settings') && sql.includes("key = 'routing_preference'")) {
          return settings.routing_preference ? { value: settings.routing_preference } : null;
        }
        if (sql.includes("key = 'model_api_constraints'")) {
          return settings['model_api_constraints'] ? { value: settings['model_api_constraints'] } : null;
        }
        if (sql.includes('ai_account_status') && sql.includes('provider_id')) {
          return statuses[args[0]] || null;
        }
        if (sql.includes('COUNT(*)')) {
          const total = Object.values(cascades).reduce((sum, arr) => sum + arr.length, 0);
          return { cnt: total };
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

describe('RoutingService — exhaustion and constraints', () => {
  beforeEach(() => { setupMocks(); });
  afterEach(() => { teardownMocks(); });

  describe('markExhausted', () => {
    it('sets login_exhausted_until for login access method', () => {
      const db = createMockDb();
      const before = Date.now();
      RoutingService.markExhausted(db, 'anthropic', 'login');

      const status = db.prepare('SELECT * FROM ai_account_status WHERE provider_id = ?').get('anthropic');
      const until = new Date(status.login_exhausted_until).getTime();
      // Default TTL is 1 hour
      expect(until).toBeGreaterThan(before + 3500000);
      expect(until).toBeLessThanOrEqual(before + 3700000);
    });

    it('sets api_exhausted_until for api access method', () => {
      const db = createMockDb();
      RoutingService.markExhausted(db, 'xai', 'api', 30 * 60 * 1000); // 30 min TTL

      const status = db.prepare('SELECT * FROM ai_account_status WHERE provider_id = ?').get('xai');
      const until = new Date(status.api_exhausted_until).getTime();
      expect(until).toBeGreaterThan(Date.now() + 29 * 60 * 1000);
    });

    it('makes previously available provider unavailable', () => {
      const db = createMockDb();
      expect(RoutingService.isAvailable(db, 'claude-opus', 'login')).toBe(true);

      RoutingService.markExhausted(db, 'anthropic', 'login');

      expect(RoutingService.isAvailable(db, 'claude-opus', 'login')).toBe(false);
    });
  });

  describe('clearExhaustion', () => {
    it('restores availability after clearing', () => {
      const far = new Date(Date.now() + 3600000).toISOString();
      const db = createMockDb({
        statuses: {
          anthropic: { login_status: 'active', api_status: 'valid', login_exhausted_until: far, api_exhausted_until: null },
          google: { login_status: 'active', api_status: 'valid', login_exhausted_until: null, api_exhausted_until: null },
          xai: { login_status: 'unknown', api_status: 'valid', login_exhausted_until: null, api_exhausted_until: null }
        }
      });

      expect(RoutingService.isAvailable(db, 'claude-opus', 'login')).toBe(false);

      RoutingService.clearExhaustion(db, 'anthropic', 'login');

      expect(RoutingService.isAvailable(db, 'claude-opus', 'login')).toBe(true);
    });
  });

  describe('resolve with full provider exhaustion', () => {
    it('skips fully exhausted provider, falls to next', () => {
      const far = new Date(Date.now() + 3600000).toISOString();
      const db = createMockDb({
        statuses: {
          anthropic: { login_status: 'active', api_status: 'valid', login_exhausted_until: far, api_exhausted_until: far },
          google: { login_status: 'active', api_status: 'valid', login_exhausted_until: null, api_exhausted_until: null },
          xai: { login_status: 'unknown', api_status: 'valid', login_exhausted_until: null, api_exhausted_until: null }
        },
        cascades: {
          conversation: [
            { family_id: 'claude-sonnet', access_method: 'login', enabled: 1, priority: 0 },
            { family_id: 'claude-sonnet', access_method: 'api', enabled: 1, priority: 1 },
            { family_id: 'gemini-pro', access_method: 'login', enabled: 1, priority: 2 },
          ]
        }
      });

      const result = RoutingService.resolve(db, 'conversation');
      expect(result.familyId).toBe('gemini-pro');
      expect(result.accessMethod).toBe('login');
    });

    it('expired exhaustion timestamp is treated as available', () => {
      const past = new Date(Date.now() - 1000).toISOString();
      const db = createMockDb({
        statuses: {
          anthropic: { login_status: 'active', api_status: 'valid', login_exhausted_until: past, api_exhausted_until: null },
          google: { login_status: 'active', api_status: 'valid', login_exhausted_until: null, api_exhausted_until: null },
          xai: { login_status: 'unknown', api_status: 'valid', login_exhausted_until: null, api_exhausted_until: null }
        },
        cascades: {
          conversation: [
            { family_id: 'claude-sonnet', access_method: 'login', enabled: 1, priority: 0 },
          ]
        }
      });

      const result = RoutingService.resolve(db, 'conversation');
      expect(result.familyId).toBe('claude-sonnet');
      expect(result.accessMethod).toBe('login');
    });
  });

  describe('generateCascade — summary task type', () => {
    it('summary cascade is API-only (like jobs)', () => {
      const db = createMockDb();
      const cascade = RoutingService.generateCascade(db, 'summary');
      const loginEntries = cascade.filter(e => e.access_method === 'login');
      expect(loginEntries.length).toBe(0);
      expect(cascade.length).toBeGreaterThan(0);
      cascade.forEach(e => expect(e.access_method).toBe('api'));
    });
  });

  describe('generateCascade — constraint enforcement', () => {
    it('api_only constraint removes login entries for that provider', () => {
      const db = createMockDb({
        constraints: {
          anthropic: { conversation: 'api' },
          google: { conversation: 'both' },
          xai: { conversation: 'both' },
        }
      });

      const cascade = RoutingService.generateCascade(db, 'conversation');
      const anthropicLogin = cascade.filter(e =>
        e.family_id.startsWith('claude-') && e.access_method === 'login'
      );
      expect(anthropicLogin.length).toBe(0);

      // Google login should still be there
      const googleLogin = cascade.filter(e => e.family_id === 'gemini-pro' && e.access_method === 'login');
      expect(googleLogin.length).toBe(1);
    });

    it('login_only constraint removes API entries for that provider', () => {
      const db = createMockDb({
        constraints: {
          anthropic: { conversation: 'login' },
          google: { conversation: 'both' },
          xai: { conversation: 'both' },
        }
      });

      const cascade = RoutingService.generateCascade(db, 'conversation');
      const anthropicApi = cascade.filter(e =>
        e.family_id.startsWith('claude-') && e.access_method === 'api'
      );
      expect(anthropicApi.length).toBe(0);

      // Claude login entries should still exist
      const anthropicLogin = cascade.filter(e =>
        e.family_id.startsWith('claude-') && e.access_method === 'login'
      );
      expect(anthropicLogin.length).toBe(3); // opus, sonnet, haiku
    });
  });
});
