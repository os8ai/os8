/**
 * Database schema definitions — all CREATE TABLE, CREATE INDEX, and FTS setup.
 * Extracted mechanically from src/db.js with no logic changes.
 */

function createSchema(db) {
  // Create tables
  db.exec(`
    -- Apps registry
    CREATE TABLE IF NOT EXISTS apps (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'active',
      display_order INTEGER DEFAULT 0,
      color TEXT DEFAULT '#6366f1',
      icon TEXT,
      text_color TEXT DEFAULT '#ffffff',
      archived_at TEXT,
      app_type TEXT DEFAULT 'regular',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Centralized environment variables
    CREATE TABLE IF NOT EXISTS env_variables (
      id TEXT PRIMARY KEY,
      key TEXT UNIQUE NOT NULL,
      value TEXT NOT NULL,
      description TEXT,
      encrypted INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- App-specific env overrides
    CREATE TABLE IF NOT EXISTS app_env_variables (
      id TEXT PRIMARY KEY,
      app_id TEXT REFERENCES apps(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      UNIQUE(app_id, key)
    );

    -- Tasks
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      app_id TEXT REFERENCES apps(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'pending',
      priority INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Settings
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Global Claude instructions
    CREATE TABLE IF NOT EXISTS claude_instructions (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      content TEXT NOT NULL,
      version INTEGER DEFAULT 1,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Provider credentials (user's OAuth app)
    CREATE TABLE IF NOT EXISTS provider_credentials (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL UNIQUE,
      client_id TEXT NOT NULL,
      client_secret TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- OAuth connections (access tokens)
    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      account_id TEXT,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expires_at TEXT,
      scopes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Connection grants (which apps can access which connections)
    CREATE TABLE IF NOT EXISTS connection_grants (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      app_id TEXT NOT NULL,
      scopes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(connection_id, app_id)
    );

    -- Memory sources (bookkeeping for reindex tracking)
    CREATE TABLE IF NOT EXISTS memory_sources (
      source TEXT NOT NULL,
      app_id TEXT NOT NULL,
      type TEXT,
      source_hash TEXT,
      last_indexed_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (app_id, source)
    );

    CREATE INDEX IF NOT EXISTS idx_memory_sources_app ON memory_sources(app_id);

    -- Memory chunks with embeddings
    CREATE TABLE IF NOT EXISTS memory_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id TEXT NOT NULL,
      text TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      source TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      category TEXT,
      embedding BLOB,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(app_id, source, chunk_index)
    );

    CREATE INDEX IF NOT EXISTS idx_memory_chunks_app ON memory_chunks(app_id);
    CREATE INDEX IF NOT EXISTS idx_memory_chunks_source ON memory_chunks(app_id, source);
    CREATE INDEX IF NOT EXISTS idx_memory_chunks_category ON memory_chunks(app_id, category);
    CREATE INDEX IF NOT EXISTS idx_memory_chunks_text_hash ON memory_chunks(text_hash);

    -- Embedding cache (shared across all apps)
    -- Composite primary key allows multiple models per text hash
    CREATE TABLE IF NOT EXISTS embedding_cache (
      text_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      embedding BLOB NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (text_hash, model)
    );

    -- Conversation entries (real-time chat memory)
    CREATE TABLE IF NOT EXISTS conversation_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id TEXT NOT NULL,
      type TEXT NOT NULL,           -- 'conversation', 'journal', 'event'
      speaker TEXT NOT NULL,        -- agent name or 'user'
      role TEXT NOT NULL,           -- 'user', 'assistant' (Claude API terminology)
      channel TEXT NOT NULL,        -- 'desktop', 'telegram', 'phone', 'job'
      content TEXT NOT NULL,
      image_data TEXT,
      is_spark INTEGER DEFAULT 0,
      internal_tag TEXT,
      timestamp TEXT NOT NULL,      -- ISO 8601
      date_key TEXT NOT NULL,       -- 'YYYY-MM-DD' for partitioning/backup
      metadata TEXT,                -- JSON blob for future flexibility
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_conv_app_date ON conversation_entries(app_id, date_key);
    CREATE INDEX IF NOT EXISTS idx_conv_app_time ON conversation_entries(app_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_conv_app_type ON conversation_entries(app_id, type);

    -- Conversation digests (compressed summaries of older conversation windows)
    CREATE TABLE IF NOT EXISTS conversation_digests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id TEXT NOT NULL,
      time_start TEXT NOT NULL,
      time_end TEXT NOT NULL,
      content TEXT NOT NULL,
      spark_entries TEXT,
      entry_count INTEGER DEFAULT 0,
      level TEXT DEFAULT 'session',
      date_key TEXT,
      metadata TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_digest_app_time ON conversation_digests(app_id, time_end);
    CREATE INDEX IF NOT EXISTS idx_digest_level ON conversation_digests(app_id, level);
    CREATE INDEX IF NOT EXISTS idx_digest_date ON conversation_digests(app_id, date_key);

    -- Plans (multi-step execution plans)
    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      request TEXT NOT NULL,
      summary TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS plan_steps (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      description TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      depends_on TEXT DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      result TEXT,
      started_at TEXT,
      completed_at TEXT,
      FOREIGN KEY (plan_id) REFERENCES plans(id)
    );

    CREATE INDEX IF NOT EXISTS idx_plan_steps_plan ON plan_steps(plan_id);
    CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status);
    CREATE INDEX IF NOT EXISTS idx_plans_agent ON plans(agent_id);
  `);

  // Create FTS5 virtual table for memory search (must be outside main exec due to conditional creation)
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        text,
        content='memory_chunks',
        content_rowid='id'
      );

      -- Triggers to keep FTS in sync
      CREATE TRIGGER IF NOT EXISTS memory_fts_insert AFTER INSERT ON memory_chunks BEGIN
        INSERT INTO memory_fts(rowid, text) VALUES (new.id, new.text);
      END;

      CREATE TRIGGER IF NOT EXISTS memory_fts_delete AFTER DELETE ON memory_chunks BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, text) VALUES('delete', old.id, old.text);
      END;

      CREATE TRIGGER IF NOT EXISTS memory_fts_update AFTER UPDATE ON memory_chunks BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, text) VALUES('delete', old.id, old.text);
        INSERT INTO memory_fts(rowid, text) VALUES (new.id, new.text);
      END;
    `);
  } catch (e) {
    // FTS5 tables/triggers may already exist, ignore error
    if (!e.message.includes('already exists')) {
      console.warn('FTS5 setup warning:', e.message);
    }
  }

  // Create agents table
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      color TEXT DEFAULT '#8b5cf6',
      backend TEXT DEFAULT 'claude',
      model TEXT,
      owner_name TEXT DEFAULT '',
      pronouns TEXT DEFAULT 'they',
      voice_archetype TEXT,
      show_image INTEGER DEFAULT 0,
      gender TEXT DEFAULT 'female',
      role TEXT DEFAULT '',
      appearance TEXT DEFAULT '',
      age INTEGER DEFAULT NULL,
      birth_date TEXT DEFAULT NULL,
      hair_color TEXT DEFAULT '',
      skin_tone TEXT DEFAULT '',
      height TEXT DEFAULT '',
      build TEXT DEFAULT '',
      other_features TEXT DEFAULT '',
      avatar_url TEXT DEFAULT '',
      telegram_bot_token TEXT,
      telegram_chat_id TEXT,
      telegram_bot_username TEXT,
      telegram_owner_user_id TEXT,
      voice_id TEXT,
      voice_name TEXT,
      myself_content TEXT,
      myself_preamble TEXT,
      life_intensity TEXT DEFAULT 'medium',
      chat_reset_at TEXT,
      myself_custom TEXT,
      user_custom TEXT,
      visibility TEXT DEFAULT 'visible',
      subconscious_memory INTEGER DEFAULT 1,
      subconscious_direct INTEGER DEFAULT 0,
      subconscious_depth INTEGER DEFAULT 1,
      setup_complete INTEGER DEFAULT 0,
      is_default INTEGER DEFAULT 0,
      display_order INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_agents_app ON agents(app_id);
    CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
  `);

  // Per-provider voice persistence for agents
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_voices (
      agent_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      voice_id TEXT,
      voice_name TEXT,
      PRIMARY KEY (agent_id, provider),
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );
  `);

  // Create agent-to-agent messaging tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_threads (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT,
      participants TEXT NOT NULL,
      creator_id TEXT,
      moderator_model TEXT,
      turn_count INTEGER DEFAULT 0,
      breaker_cooldown INTEGER DEFAULT 60,
      breaker_last_tripped TEXT,
      last_message_at TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS agent_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL REFERENCES agent_threads(id),
      sender_app_id TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      content TEXT NOT NULL,
      message_type TEXT DEFAULT 'chat',
      triggered_by TEXT DEFAULT 'agent',
      metadata TEXT,
      timestamp TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_agent_messages_thread ON agent_messages(thread_id, timestamp);
  `);

  // Create telegram_groups table (maps Telegram groups to agent_threads)
  db.exec(`
    CREATE TABLE IF NOT EXISTS telegram_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_chat_id TEXT NOT NULL UNIQUE,
      thread_id TEXT REFERENCES agent_threads(id),
      chat_title TEXT,
      agent_ids TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Create agent_life_items table (life simulation: outfits, settings, hairstyles)
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_life_items (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      panoramic TEXT,
      scene_prompt TEXT,
      tags TEXT,
      is_default INTEGER DEFAULT 0,
      display_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_life_items_agent ON agent_life_items(agent_id, type);
  `);

  // Create agent_life_entries table (structured per-tick state + image reference)
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_life_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      outfit_id TEXT,
      setting_id TEXT,
      hairstyle_id TEXT,
      activity TEXT,
      mood TEXT,
      body_position TEXT,
      food_drink TEXT,
      weather TEXT,
      makeup TEXT,
      narrative TEXT,
      reflections TEXT,
      reconstructed_history TEXT,
      mission_check TEXT,
      image_filename TEXT,
      image_provider TEXT,
      timestamp TEXT NOT NULL,
      date_key TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_life_entries_agent ON agent_life_entries(agent_id, timestamp);
  `);

  // Create agent_motivation_updates table (periodic mission assessment + goals)
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_motivation_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      period TEXT NOT NULL,
      assessments TEXT,
      goals TEXT,
      blockers TEXT,
      message TEXT,
      timestamp TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_motivation_updates_agent ON agent_motivation_updates(agent_id, timestamp);
  `);

  // Create agent chat budget tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_chat_budget (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date_key TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      triggered_by TEXT NOT NULL,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_chat_budget_date ON agent_chat_budget(date_key, agent_id);
  `);

  // ================================================
  // Skills system tables (Day 2 launch sprint)
  // ================================================

  // Skill catalog (synced from external registries like ClawHub)
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_catalog (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      search_description TEXT,
      version TEXT,
      author TEXT,
      source TEXT NOT NULL,
      source_url TEXT,
      download_count INTEGER DEFAULT 0,
      verified INTEGER DEFAULT 0,
      official INTEGER DEFAULT 0,
      rating REAL,
      categories TEXT,
      compatibility TEXT,
      metadata TEXT,
      embedding BLOB,
      synced_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_skill_catalog_name ON skill_catalog(name);
    CREATE INDEX IF NOT EXISTS idx_skill_catalog_source ON skill_catalog(source);
  `);

  // FTS5 indexes for keyword search on skill catalog
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS skill_catalog_fts USING fts5(
        name, description, search_description,
        content='skill_catalog',
        content_rowid='rowid'
      );
    `);
  } catch (e) {
    if (!e.message.includes('already exists')) {
      console.warn('skill_catalog_fts setup warning:', e.message);
    }
  }

  // ================================================
  // Capabilities system tables (unified API + skill registry)
  // ================================================

  db.exec(`
    CREATE TABLE IF NOT EXISTS capabilities (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'system',
      agent_id TEXT,
      env_required TEXT,
      connection TEXT,
      connection_scopes TEXT,
      available INTEGER DEFAULT 1,
      base_path TEXT,
      endpoints TEXT,
      documentation TEXT,
      search_description TEXT,
      version TEXT,
      license TEXT,
      metadata TEXT,
      source TEXT DEFAULT 'local',
      source_url TEXT,
      catalog_id TEXT,
      bins_required TEXT,
      homepage TEXT,
      body_hash TEXT,
      quarantine INTEGER DEFAULT 0,
      review_status TEXT,
      review_risk_level TEXT,
      review_report TEXT,
      reviewed_at TEXT,
      approved_at TEXT,
      embedding BLOB,
      usage_count INTEGER DEFAULT 0,
      last_used_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_capabilities_type ON capabilities(type);
    CREATE INDEX IF NOT EXISTS idx_capabilities_name ON capabilities(name);
    CREATE INDEX IF NOT EXISTS idx_capabilities_source ON capabilities(source);
    CREATE INDEX IF NOT EXISTS idx_capabilities_available ON capabilities(available);
    CREATE INDEX IF NOT EXISTS idx_capabilities_agent ON capabilities(agent_id);

    -- Agent pinned capabilities (max 5 per agent, always in context)
    CREATE TABLE IF NOT EXISTS agent_pinned_capabilities (
      agent_id TEXT NOT NULL,
      capability_id TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      pinned_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (agent_id, capability_id),
      FOREIGN KEY (capability_id) REFERENCES capabilities(id) ON DELETE CASCADE
    );

    -- Capability usage tracking (feeds ranking algorithm)
    CREATE TABLE IF NOT EXISTS capability_usage (
      id TEXT PRIMARY KEY,
      capability_id TEXT NOT NULL,
      agent_id TEXT,
      used_at TEXT DEFAULT CURRENT_TIMESTAMP,
      context TEXT,
      FOREIGN KEY (capability_id) REFERENCES capabilities(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_capability_usage_cap ON capability_usage(capability_id);
    CREATE INDEX IF NOT EXISTS idx_capability_usage_agent ON capability_usage(agent_id);
  `);

  // FTS5 index for capabilities
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS capability_fts USING fts5(
        name, description, search_description,
        content='capabilities',
        content_rowid='rowid'
      );
    `);
  } catch (e) {
    if (!e.message.includes('already exists')) {
      console.warn('capability_fts setup warning:', e.message);
    }
  }

  // Drop legacy skills tables (replaced by capabilities)
  try {
    const capCount = db.prepare("SELECT COUNT(*) as n FROM capabilities WHERE type = 'skill'").get();
    if (capCount && capCount.n > 0) {
      db.exec('DROP TABLE IF EXISTS skill_fts');
      db.exec('DROP TABLE IF EXISTS skill_usage');
      db.exec('DROP TABLE IF EXISTS agent_pinned_skills');
      db.exec('DROP TABLE IF EXISTS skills');
    }
  } catch (e) {
    // Tables may already be gone — safe to ignore
  }

  // AI Provider / Container / Model reference tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      api_key_env TEXT,
      api_key_url TEXT,
      validation_url TEXT,
      validation_auth_style TEXT,
      validation_headers TEXT,
      display_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ai_containers (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL REFERENCES ai_providers(id),
      type TEXT NOT NULL DEFAULT 'cli',
      name TEXT NOT NULL,
      command TEXT NOT NULL,
      instruction_file TEXT NOT NULL,
      has_login INTEGER DEFAULT 0,
      login_command TEXT,
      show_in_terminal INTEGER DEFAULT 1,
      api_key_aliases TEXT,
      auth_status_command TEXT,
      auth_file_path TEXT,
      login_trigger_args TEXT,
      display_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ai_model_families (
      id TEXT PRIMARY KEY,
      container_id TEXT NOT NULL REFERENCES ai_containers(id),
      name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      cli_model_arg TEXT,
      cost_tier INTEGER DEFAULT 3,
      cap_chat INTEGER DEFAULT 3,
      cap_jobs INTEGER DEFAULT 3,
      cap_planning INTEGER DEFAULT 3,
      cap_coding INTEGER DEFAULT 3,
      cap_summary INTEGER DEFAULT 3,
      eligible_tasks TEXT DEFAULT NULL,
      is_default INTEGER DEFAULT 0,
      display_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_ai_model_families_container ON ai_model_families(container_id);

    CREATE TABLE IF NOT EXISTS ai_models (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL REFERENCES ai_providers(id),
      container_id TEXT NOT NULL REFERENCES ai_containers(id),
      family_id TEXT REFERENCES ai_model_families(id),
      name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      model_identifier TEXT,
      api_model_id TEXT,
      is_default INTEGER DEFAULT 0,
      is_latest INTEGER DEFAULT 0,
      released_at TEXT,
      discovered_at TEXT,
      display_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_ai_models_container ON ai_models(container_id);
    CREATE INDEX IF NOT EXISTS idx_ai_models_provider ON ai_models(provider_id);
    CREATE INDEX IF NOT EXISTS idx_ai_models_family ON ai_models(family_id);
  `);

  // API Key Catalog — single source of truth for key metadata
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_key_catalog (
      env_key TEXT PRIMARY KEY,
      provider_id TEXT REFERENCES ai_providers(id),
      label TEXT NOT NULL,
      description TEXT,
      url TEXT,
      url_label TEXT,
      placeholder TEXT,
      display_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Create ai_account_status table
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_account_status (
      provider_id TEXT PRIMARY KEY REFERENCES ai_providers(id),
      login_status TEXT DEFAULT 'unknown',
      plan_tier TEXT,
      plan_source TEXT DEFAULT 'user',
      api_status TEXT DEFAULT 'unknown',
      api_balance REAL,
      api_balance_updated_at TEXT,
      login_exhausted_until TEXT,
      api_exhausted_until TEXT,
      last_checked_at TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Create routing_cascade table
  db.exec(`
    CREATE TABLE IF NOT EXISTS routing_cascade (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_type TEXT NOT NULL,
      priority INTEGER NOT NULL,
      family_id TEXT NOT NULL REFERENCES ai_model_families(id),
      access_method TEXT NOT NULL DEFAULT 'api',
      enabled INTEGER DEFAULT 1,
      is_auto_generated INTEGER DEFAULT 1,
      UNIQUE(task_type, priority)
    );
  `);

  // MCP Catalog table — browsable/installable MCP servers from registries
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_catalog (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      search_description TEXT,
      version TEXT,
      author TEXT,
      source TEXT NOT NULL DEFAULT 'snapshot',
      source_url TEXT,
      transport TEXT DEFAULT 'stdio',
      command TEXT,
      args TEXT,
      npm_package TEXT,
      download_count INTEGER DEFAULT 0,
      verified INTEGER DEFAULT 0,
      official INTEGER DEFAULT 0,
      rating REAL,
      categories TEXT,
      metadata TEXT,
      embedding BLOB,
      synced_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_mcp_catalog_name ON mcp_catalog(name);
  `);

  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS mcp_catalog_fts USING fts5(
        name, description, search_description,
        content='mcp_catalog', content_rowid='rowid'
      );
    `);
  } catch (e) {
    if (!e.message.includes('already exists')) {
      console.warn('mcp_catalog_fts setup warning:', e.message);
    }
  }

  // MCP Servers table — stores MCP server configurations
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      transport TEXT NOT NULL DEFAULT 'stdio',
      command TEXT,
      args TEXT,
      env TEXT,
      url TEXT,
      auto_start INTEGER DEFAULT 0,
      status TEXT DEFAULT 'stopped',
      error_message TEXT,
      source TEXT DEFAULT 'local',
      catalog_id TEXT,
      installed_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_started_at TEXT
    );
  `);

  // User account table — single-row design for local user identity
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_account (
      id TEXT PRIMARY KEY DEFAULT 'local',
      os8_user_id TEXT,
      username TEXT,
      display_name TEXT,
      avatar_url TEXT,
      email TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

module.exports = { createSchema };
