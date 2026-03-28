const fs = require('fs');
const path = require('path');
const { CORE_DIR, ensureDirectories } = require('../config');

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

    // Create vite.config.js
    const viteConfig = `import { defineConfig } from 'vite';
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
    fs.writeFileSync(path.join(CORE_DIR, 'vite.config.js'), viteConfig);

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
      const npmInstall = spawn('npm', ['install'], {
        cwd: CORE_DIR,
        shell: true,
        stdio: 'pipe'
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
