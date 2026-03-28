/**
 * Database initialization — creates schema and seeds reference data.
 * This is the entry point; src/db.js re-exports from here for backward compatibility.
 */

const Database = require('better-sqlite3');

const {
  OS8_DIR,
  CONFIG_DIR,
  APPS_DIR,
  BLOB_DIR,
  CORE_DIR,
  SKILLS_DIR,
  AVATARS_DIR,
  DB_PATH,
  ensureDirectories
} = require('../config');

const { generateId, generateSlug } = require('../utils');

// Import services (for re-export)
const {
  ClaudeInstructionsService,
  SettingsService,
  EnvService
} = require('../services');
const { ConnectionsService, PROVIDERS } = require('../services/connections');
const CoreService = require('../services/core');
const TasksFileService = require('../services/tasks-file');
const {
  AppService,
  scaffoldApp,
  scaffoldAssistantApp,
  generateClaudeMd,
  generateAssistantClaudeMd
} = require('../services/app');
const AgentService = require('../services/agent');

const { createSchema } = require('./schema');
const { seedData } = require('./seeds');

function initDatabase() {
  ensureDirectories();

  const db = new Database(DB_PATH);

  db.pragma('foreign_keys = ON');

  createSchema(db);
  seedData(db);

  return db;
}

module.exports = {
  OS8_DIR,
  CONFIG_DIR,
  APPS_DIR,
  BLOB_DIR,
  CORE_DIR,
  SKILLS_DIR,
  AVATARS_DIR,
  initDatabase,
  generateId,
  generateSlug,
  generateClaudeMd,
  generateAssistantClaudeMd,
  scaffoldAssistantApp,
  AppService,
  AgentService,
  TasksFileService,
  EnvService,
  SettingsService,
  ClaudeInstructionsService,
  CoreService,
  CapabilityService: require('../services/capability').CapabilityService,
  PROVIDERS,
  ConnectionsService
};
