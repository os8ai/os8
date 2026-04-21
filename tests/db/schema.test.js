import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('fs');
const path = require('path');
const os = require('os');

// Each test gets its own temp OS8_HOME so we init a fresh DB
let tmpDir;
let origOS8Home;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-test-'));
  origOS8Home = process.env.OS8_HOME;
  process.env.OS8_HOME = tmpDir;
  // Clear cached config so it picks up new OS8_HOME
  delete require.cache[require.resolve('../../src/config')];
  delete require.cache[require.resolve('../../src/db')];
});

afterEach(() => {
  if (origOS8Home !== undefined) {
    process.env.OS8_HOME = origOS8Home;
  } else {
    delete process.env.OS8_HOME;
  }
  // Clean up temp dir
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  // Clear caches for next test
  delete require.cache[require.resolve('../../src/config')];
  delete require.cache[require.resolve('../../src/db')];
});

// All tables that must exist after initDatabase()
// Excludes FTS shadow tables (*_config, *_data, *_docsize, *_idx) — those are created automatically
const EXPECTED_TABLES = [
  'agent_chat_budget',
  'agent_life_entries',
  'agent_life_items',
  'agent_messages',
  'agent_motivation_updates',
  'agent_pinned_capabilities',
  'agent_threads',
  'agents',
  'ai_account_status',
  'ai_containers',
  'ai_model_families',
  'ai_models',
  'ai_providers',
  'api_key_catalog',
  'app_env_variables',
  'apps',
  'capabilities',
  'capability_fts',
  'capability_usage',
  'claude_instructions',
  'connection_grants',
  'connections',
  'conversation_digests',
  'conversation_entries',
  'embedding_cache',
  'env_variables',
  'mcp_catalog',
  'mcp_catalog_fts',
  'mcp_servers',
  'memory_chunks',
  'memory_fts',
  'memory_sources',
  'plan_steps',
  'plans',
  'provider_credentials',
  'routing_cascade',
  'settings',
  'skill_catalog',
  'skill_catalog_fts',
  'tasks',
  'telegram_groups',
  'user_account',
];

// Key columns per table — not exhaustive, but covers columns added by migrations
// (the ones most likely to break during a split)
const EXPECTED_COLUMNS = {
  apps: ['id', 'name', 'slug', 'status', 'display_order', 'color', 'icon', 'text_color', 'archived_at', 'app_type', 'icon_image', 'icon_mode'],
  agents: [
    'id', 'app_id', 'name', 'slug', 'backend', 'model', 'status',
    // Migration-added columns
    'telegram_bot_token', 'telegram_chat_id', 'telegram_bot_username',
    'setup_complete', 'voice_id', 'voice_name', 'myself_content',
    'life_intensity', 'chat_reset_at', 'myself_custom', 'user_custom',
    'visibility', 'birth_date',
    'subconscious_memory', 'subconscious_direct', 'subconscious_depth',
    // Avatar columns
    'avatar_url', 'color', 'pronouns', 'voice_archetype', 'show_image',
    'gender', 'role', 'appearance', 'age', 'hair_color', 'skin_tone',
    'height', 'build', 'other_features',
  ],
  conversation_entries: ['id', 'app_id', 'type', 'content', 'timestamp', 'image_data', 'is_spark', 'internal_tag'],
  conversation_digests: ['id', 'app_id', 'content', 'level', 'date_key'],
  agent_threads: ['id', 'type', 'name', 'creator_id', 'moderator_model'],
  agent_messages: ['id', 'thread_id', 'content', 'triggered_by'],
  agent_life_items: ['id', 'agent_id', 'type', 'name', 'scene_prompt'],
  agent_life_entries: ['id', 'agent_id', 'mission_check'],
  ai_model_families: ['id', 'container_id', 'name', 'cost_tier', 'cap_chat', 'cap_jobs', 'cap_planning', 'cap_coding', 'cap_summary', 'eligible_tasks', 'launcher_model', 'launcher_backend', 'supports_vision'],
  ai_models: ['id', 'provider_id', 'container_id', 'family_id', 'api_model_id'],
  ai_providers: ['id', 'name', 'api_key_env', 'api_key_url', 'validation_url'],
  ai_containers: ['id', 'provider_id', 'type', 'command', 'has_login', 'api_key_aliases', 'auth_status_command', 'auth_file_path', 'login_trigger_args'],
  capabilities: ['id', 'type', 'name', 'quarantine', 'bins_required', 'homepage', 'review_status', 'review_risk_level', 'review_report', 'reviewed_at', 'approved_at'],
  routing_cascade: ['id', 'task_type', 'priority', 'family_id', 'access_method', 'enabled', 'mode'],
  env_variables: ['id', 'key', 'value', 'encrypted'],
  mcp_servers: ['id', 'name', 'transport', 'command', 'status', 'catalog_id'],
  mcp_catalog: ['id', 'name', 'description', 'source', 'transport', 'command'],
};

// Indexes that must exist
const EXPECTED_INDEXES = [
  'idx_agents_app',
  'idx_agents_status',
  'idx_agent_messages_thread',
  'idx_chat_budget_date',
  'idx_life_entries_agent',
  'idx_life_items_agent',
  'idx_motivation_updates_agent',
  'idx_ai_model_families_container',
  'idx_ai_models_container',
  'idx_ai_models_family',
  'idx_ai_models_provider',
  'idx_capabilities_agent',
  'idx_capabilities_available',
  'idx_capabilities_name',
  'idx_capabilities_source',
  'idx_capabilities_type',
  'idx_capability_usage_agent',
  'idx_capability_usage_cap',
  'idx_conv_app_date',
  'idx_conv_app_time',
  'idx_conv_app_type',
  'idx_digest_app_time',
  'idx_digest_date',
  'idx_digest_level',
  'idx_mcp_catalog_name',
  'idx_memory_chunks_app',
  'idx_memory_chunks_category',
  'idx_memory_chunks_source',
  'idx_memory_chunks_text_hash',
  'idx_memory_sources_app',
  'idx_plan_steps_plan',
  'idx_plans_agent',
  'idx_plans_status',
  'idx_skill_catalog_name',
  'idx_skill_catalog_source',
];

function getTableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
}

function getColumnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
}

function getIndexNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
}

describe('initDatabase — schema verification', () => {
  it('creates all expected tables', () => {
    const { initDatabase } = require('../../src/db');
    const db = initDatabase();
    try {
      const tables = getTableNames(db);
      for (const expected of EXPECTED_TABLES) {
        expect(tables, `missing table: ${expected}`).toContain(expected);
      }
    } finally {
      db.close();
    }
  });

  it('creates all expected columns (including migration-added ones)', () => {
    const { initDatabase } = require('../../src/db');
    const db = initDatabase();
    try {
      for (const [table, expectedCols] of Object.entries(EXPECTED_COLUMNS)) {
        const actualCols = getColumnNames(db, table);
        for (const col of expectedCols) {
          expect(actualCols, `missing column: ${table}.${col}`).toContain(col);
        }
      }
    } finally {
      db.close();
    }
  });

  it('creates all expected indexes', () => {
    const { initDatabase } = require('../../src/db');
    const db = initDatabase();
    try {
      const indexes = getIndexNames(db);
      for (const expected of EXPECTED_INDEXES) {
        expect(indexes, `missing index: ${expected}`).toContain(expected);
      }
    } finally {
      db.close();
    }
  });

  it('seeds AI provider/model data', () => {
    const { initDatabase } = require('../../src/db');
    const db = initDatabase();
    try {
      // Providers
      const providers = db.prepare('SELECT id FROM ai_providers').all().map(r => r.id);
      expect(providers).toContain('anthropic');
      expect(providers).toContain('google');
      expect(providers).toContain('openai');
      expect(providers).toContain('xai');

      // Containers
      const containers = db.prepare('SELECT id FROM ai_containers').all().map(r => r.id);
      expect(containers).toContain('claude');
      expect(containers).toContain('gemini');
      expect(containers).toContain('codex');
      expect(containers).toContain('grok');

      // Families
      const families = db.prepare('SELECT id FROM ai_model_families').all().map(r => r.id);
      expect(families).toContain('claude-opus');
      expect(families).toContain('claude-sonnet');
      expect(families).toContain('claude-haiku');
      expect(families).toContain('gemini-pro');
      expect(families).toContain('gpt-codex');
      expect(families).toContain('gpt-chat');
      expect(families).toContain('grok');

      // Models exist
      const modelCount = db.prepare('SELECT COUNT(*) as count FROM ai_models').get();
      expect(modelCount.count).toBeGreaterThan(0);

      // Routing cascades seeded
      const cascadeCount = db.prepare('SELECT COUNT(*) as count FROM routing_cascade').get();
      expect(cascadeCount.count).toBeGreaterThan(0);

      // Privacy defaults seeded
      const privacyCount = db.prepare("SELECT COUNT(*) as count FROM env_variables WHERE description = 'Privacy setting'").get();
      expect(privacyCount.count).toBe(8);
    } finally {
      db.close();
    }
  });
});

describe('initDatabase — idempotency', () => {
  it('can be called twice on the same database without errors', () => {
    const { initDatabase } = require('../../src/db');
    const db1 = initDatabase();
    const tablesFirstRun = getTableNames(db1);
    const columnsFirstRun = {};
    for (const table of Object.keys(EXPECTED_COLUMNS)) {
      columnsFirstRun[table] = getColumnNames(db1, table);
    }
    const indexesFirstRun = getIndexNames(db1);
    db1.close();

    // Clear require cache so initDatabase re-runs all logic
    delete require.cache[require.resolve('../../src/config')];
    delete require.cache[require.resolve('../../src/db')];

    const { initDatabase: initDatabase2 } = require('../../src/db');
    const db2 = initDatabase2();
    try {
      const tablesSecondRun = getTableNames(db2);
      expect(tablesSecondRun).toEqual(tablesFirstRun);

      for (const [table, firstRunCols] of Object.entries(columnsFirstRun)) {
        const secondRunCols = getColumnNames(db2, table);
        expect(secondRunCols, `columns changed on second run for ${table}`).toEqual(firstRunCols);
      }

      const indexesSecondRun = getIndexNames(db2);
      expect(indexesSecondRun).toEqual(indexesFirstRun);
    } finally {
      db2.close();
    }
  });

  it('seed data counts do not double on second run', () => {
    const { initDatabase } = require('../../src/db');
    const db1 = initDatabase();
    const counts1 = {
      providers: db1.prepare('SELECT COUNT(*) as c FROM ai_providers').get().c,
      containers: db1.prepare('SELECT COUNT(*) as c FROM ai_containers').get().c,
      families: db1.prepare('SELECT COUNT(*) as c FROM ai_model_families').get().c,
      models: db1.prepare('SELECT COUNT(*) as c FROM ai_models').get().c,
      cascades: db1.prepare('SELECT COUNT(*) as c FROM routing_cascade').get().c,
      privacy: db1.prepare("SELECT COUNT(*) as c FROM env_variables WHERE description = 'Privacy setting'").get().c,
    };
    db1.close();

    delete require.cache[require.resolve('../../src/config')];
    delete require.cache[require.resolve('../../src/db')];

    const { initDatabase: initDatabase2 } = require('../../src/db');
    const db2 = initDatabase2();
    try {
      const counts2 = {
        providers: db2.prepare('SELECT COUNT(*) as c FROM ai_providers').get().c,
        containers: db2.prepare('SELECT COUNT(*) as c FROM ai_containers').get().c,
        families: db2.prepare('SELECT COUNT(*) as c FROM ai_model_families').get().c,
        models: db2.prepare('SELECT COUNT(*) as c FROM ai_models').get().c,
        cascades: db2.prepare('SELECT COUNT(*) as c FROM routing_cascade').get().c,
        privacy: db2.prepare("SELECT COUNT(*) as c FROM env_variables WHERE description = 'Privacy setting'").get().c,
      };
      expect(counts2).toEqual(counts1);
    } finally {
      db2.close();
    }
  });
});

describe('initDatabase — exports verification', () => {
  it('exports all expected keys with correct types', () => {
    const dbModule = require('../../src/db');

    // String path constants
    for (const key of ['OS8_DIR', 'CONFIG_DIR', 'APPS_DIR', 'BLOB_DIR', 'CORE_DIR', 'SKILLS_DIR', 'AVATARS_DIR']) {
      expect(typeof dbModule[key], `${key} should be a string`).toBe('string');
    }

    // Functions
    for (const key of ['initDatabase', 'generateId', 'generateSlug', 'generateClaudeMd', 'generateAssistantClaudeMd', 'scaffoldAssistantApp']) {
      expect(typeof dbModule[key], `${key} should be a function`).toBe('function');
    }

    // Service objects (they export static methods)
    for (const key of ['AppService', 'AgentService', 'TasksFileService', 'EnvService', 'SettingsService', 'ClaudeInstructionsService', 'CoreService', 'CapabilityService', 'ConnectionsService']) {
      expect(dbModule[key], `${key} should be defined`).toBeDefined();
      expect(typeof dbModule[key], `${key} should be an object or function`).toMatch(/object|function/);
    }

    // PROVIDERS constant
    expect(dbModule.PROVIDERS, 'PROVIDERS should be defined').toBeDefined();
  });
});
