const path = require('path');
const os = require('os');
const fs = require('fs');

// OS8 data directory paths (override with OS8_HOME env var)
const OS8_DIR = process.env.OS8_HOME || path.join(os.homedir(), 'os8');
const CONFIG_DIR = path.join(OS8_DIR, 'config');
const APPS_DIR = path.join(OS8_DIR, 'apps');
const BLOB_DIR = path.join(OS8_DIR, 'blob');
const CORE_DIR = path.join(OS8_DIR, 'core');
const SKILLS_DIR = path.join(OS8_DIR, 'skills');
const MODELS_DIR = path.join(OS8_DIR, 'models');
const AVATARS_DIR = path.join(MODELS_DIR, 'avatars');
const ICONS_DIR = path.join(BLOB_DIR, 'icons');
const DB_PATH = path.join(CONFIG_DIR, 'os8.db');

// Ensure all OS8 directories exist
function ensureDirectories() {
  [OS8_DIR, CONFIG_DIR, APPS_DIR, BLOB_DIR, CORE_DIR, SKILLS_DIR, MODELS_DIR, AVATARS_DIR, ICONS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
  // Also create core/shared for future shared components
  const sharedDir = path.join(CORE_DIR, 'shared');
  if (!fs.existsSync(sharedDir)) {
    fs.mkdirSync(sharedDir, { recursive: true });
  }
}

module.exports = {
  OS8_DIR,
  CONFIG_DIR,
  APPS_DIR,
  BLOB_DIR,
  CORE_DIR,
  SKILLS_DIR,
  MODELS_DIR,
  AVATARS_DIR,
  ICONS_DIR,
  DB_PATH,
  ensureDirectories
};
