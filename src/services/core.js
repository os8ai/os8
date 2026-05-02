const fs = require('fs');
const path = require('path');
const { CORE_DIR, ensureDirectories } = require('../config');

// vite.config.js template. Kept as a function so the migration runner can
// call rewriteViteConfig() to update existing installs without duplicating
// the template inline.
//
// The watch.ignored list keeps Vite from crawling external-app Python venvs
// + bytecode caches. Without these, an external Gradio/Streamlit app's
// `.venv/lib/.../package/templates/index.html` triggers HMR storms on first
// launch (the page-reload events spam the modal and slow down the dev
// server's discovery pass). v0.5.0 shipped without these ignores; the
// 0.5.1-vite-watch-ignored migration backfills the file for upgraders.
function viteConfigTemplate() {
  return `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';

const coreDir = __dirname;
const appsDir = path.resolve(coreDir, '../apps');
const coreNodeModules = path.resolve(coreDir, 'node_modules');

// Get list of apps dynamically
function getAppEntries() {
  if (!fs.existsSync(appsDir)) return {};

  const entries = {};
  const apps = fs.readdirSync(appsDir);
  apps.forEach(appId => {
    const appPath = path.join(appsDir, appId);
    const indexPath = path.join(appPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      entries[appId] = indexPath;
    }
  });
  return entries;
}

export default defineConfig({
  plugins: [react()],
  root: appsDir,
  resolve: {
    alias: {
      '@os8/shared': path.resolve(coreDir, 'shared'),
      // Point React imports to Core's node_modules
      'react': path.resolve(coreNodeModules, 'react'),
      'react-dom': path.resolve(coreNodeModules, 'react-dom'),
      'react-router-dom': path.resolve(coreNodeModules, 'react-router-dom')
    }
  },
  optimizeDeps: {
    // Tell Vite where to find dependencies
    esbuildOptions: {
      resolveExtensions: ['.js', '.jsx', '.ts', '.tsx'],
    }
  },
  server: {
    middlewareMode: true,
    hmr: {
      port: 5174
    },
    watch: {
      // Don't crawl Python venvs, bytecode caches, or .git inside external
      // apps. External-app .venv/ contains shipped HTML (gradio/streamlit
      // templates) which would otherwise trigger HMR storms on first launch.
      ignored: [
        '**/.venv/**',
        '**/__pycache__/**',
        '**/.git/**',
        '**/node_modules/**',
        '**/.pytest_cache/**',
        '**/.mypy_cache/**'
      ]
    }
  },
  build: {
    rollupOptions: {
      input: getAppEntries()
    }
  },
  css: {
    postcss: path.resolve(coreDir, 'postcss.config.js')
  }
});
`;
}

// Rewrite ~/os8/core/vite.config.js to the current template. Used by both
// initialize() (fresh installs) and the migration (upgrades). Backs up any
// existing file with content that differs from the new template, so users
// who hand-edited their config don't silently lose changes.
function rewriteViteConfig() {
  const target = path.join(CORE_DIR, 'vite.config.js');
  const next = viteConfigTemplate();
  if (fs.existsSync(target)) {
    const current = fs.readFileSync(target, 'utf8');
    if (current === next) return { changed: false, backup: null };
    const backup = `${target}.${Date.now()}.bak`;
    fs.copyFileSync(target, backup);
    fs.writeFileSync(target, next, 'utf8');
    return { changed: true, backup };
  }
  fs.writeFileSync(target, next, 'utf8');
  return { changed: true, backup: null };
}

// Core Services - manages shared React/Vite/Tailwind environment
const CoreService = {
  // Check if Core is set up (node_modules exists)
  isReady() {
    return fs.existsSync(path.join(CORE_DIR, 'node_modules'));
  },

  // Check if Core is currently installing
  isInstalling() {
    return fs.existsSync(path.join(CORE_DIR, '.installing'));
  },

  // Get Core setup status
  getStatus() {
    if (this.isReady()) return 'ready';
    if (this.isInstalling()) return 'installing';
    return 'not_initialized';
  },

  // Initialize Core Services (creates config files)
  initialize() {
    ensureDirectories();

    // Create package.json
    const packageJson = {
      name: "os8-core",
      version: "1.0.0",
      private: true,
      type: "module",
      dependencies: {
        "react": "^18.2.0",
        "react-dom": "^18.2.0",
        "react-router-dom": "^6.20.0"
      },
      devDependencies: {
        "vite": "^5.0.0",
        "esbuild": "^0.25.0",
        "@vitejs/plugin-react": "^4.2.0",
        "tailwindcss": "^3.3.0",
        "postcss": "^8.4.0",
        "autoprefixer": "^10.4.0"
      }
    };
    fs.writeFileSync(
      path.join(CORE_DIR, 'package.json'),
      JSON.stringify(packageJson, null, 2)
    );

    // Create / refresh vite.config.js (extracted to rewriteViteConfig so the
    // migration runner can update existing installs without duplicating the
    // template).
    rewriteViteConfig();

    // Create tailwind.config.js with absolute paths
    const tailwindConfig = `import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appsDir = path.resolve(__dirname, '../apps');

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    \`\${appsDir}/**/index.html\`,
    \`\${appsDir}/**/src/**/*.{js,jsx,ts,tsx}\`
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};
`;
    fs.writeFileSync(path.join(CORE_DIR, 'tailwind.config.js'), tailwindConfig);

    // Create postcss.config.js with explicit config path
    const postcssConfig = `import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default {
  plugins: {
    tailwindcss: {
      config: path.resolve(__dirname, 'tailwind.config.js')
    },
    autoprefixer: {},
  },
};
`;
    fs.writeFileSync(path.join(CORE_DIR, 'postcss.config.js'), postcssConfig);

    // Create placeholder in shared directory
    const sharedIndex = `// OS8 Shared Components & Utilities
// Add shared React components here as patterns emerge

export {};
`;
    fs.writeFileSync(path.join(CORE_DIR, 'shared', 'index.js'), sharedIndex);

    return true;
  },

  // Install dependencies (runs npm install)
  async install() {
    const { spawn } = require('child_process');

    // Mark as installing
    fs.writeFileSync(path.join(CORE_DIR, '.installing'), Date.now().toString());

    return new Promise((resolve, reject) => {
      // Electron's process environment (DYLD_*, NODE_OPTIONS, etc.) causes native
      // binary crashes (SIGILL/SIGKILL) when npm runs postinstall scripts like
      // esbuild's binary validation. Use --ignore-scripts to bypass this — the
      // binaries are valid and work fine at runtime without the validation step.
      const os = require('os');
      const { findNpm, SEARCH_PATH } = require('../utils/npm-path');
      const systemNpm = findNpm();
      if (!systemNpm) {
        reject(new Error('npm not found. Please install Node.js (https://nodejs.org) and ensure npm is on your PATH.'));
        return;
      }

      const cleanEnv = {
        PATH: SEARCH_PATH,
        HOME: os.homedir(),
        USER: os.userInfo().username,
        SHELL: process.env.SHELL || '/bin/sh',
        TMPDIR: os.tmpdir(),
        LANG: process.env.LANG || 'en_US.UTF-8',
      };

      const npmInstall = spawn(systemNpm, ['install', '--ignore-scripts'], {
        cwd: CORE_DIR,
        shell: false,
        stdio: 'pipe',
        env: cleanEnv
      });

      let output = '';
      npmInstall.stdout.on('data', (data) => {
        output += data.toString();
      });
      npmInstall.stderr.on('data', (data) => {
        output += data.toString();
      });

      npmInstall.on('close', (code) => {
        // Remove installing marker
        const installingPath = path.join(CORE_DIR, '.installing');
        if (fs.existsSync(installingPath)) {
          fs.unlinkSync(installingPath);
        }

        if (code === 0) {
          resolve({ success: true, output });
        } else {
          reject(new Error(`npm install failed with code ${code}: ${output}`));
        }
      });

      npmInstall.on('error', (err) => {
        const installingPath = path.join(CORE_DIR, '.installing');
        if (fs.existsSync(installingPath)) {
          fs.unlinkSync(installingPath);
        }
        reject(err);
      });
    });
  },

  // Full setup: initialize + install
  async setup() {
    this.initialize();
    return await this.install();
  },

  // Get path to Core directory
  getPath() {
    return CORE_DIR;
  }
};

module.exports = CoreService;
module.exports.rewriteViteConfig = rewriteViteConfig;
module.exports.viteConfigTemplate = viteConfigTemplate;
