/**
 * IPC Handlers for Onboarding domain
 * Handles: onboarding:*
 */

const { ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');

function registerOnboardingHandlers({ db, mainWindow, services }) {
  const { SettingsService, EnvService, BillingService } = services;

  // Get onboarding status
  ipcMain.handle('onboarding:status', () => {
    const complete = SettingsService.get(db, 'onboarding_complete') || '0';
    const step = SettingsService.get(db, 'onboarding_step') || '0';
    return { complete, step };
  });

  // Update current step
  ipcMain.handle('onboarding:set-step', (event, step) => {
    SettingsService.set(db, 'onboarding_step', String(step));
  });

  // Mark onboarding complete
  ipcMain.handle('onboarding:complete', () => {
    SettingsService.set(db, 'onboarding_complete', '1');
    SettingsService.set(db, 'onboarding_step', '6');
  });

  // Find npm binary — must succeed before CLI install or core setup
  ipcMain.handle('onboarding:find-npm', () => {
    const { findNpm } = require('../utils/npm-path');
    return findNpm();
  });

  // Install all 4 CLI backends globally — each installed individually so one
  // failure doesn't block the others (npm exits non-zero on any 404 in a batch)
  ipcMain.handle('onboarding:install-clis', async (event, npmPath) => {
    const { CLI_PACKAGES, findCli, getExpandedPath } = require('../utils/cli-path');
    const { execSync } = require('child_process');
    const npm = npmPath || 'npm';
    const env = { ...process.env, PATH: getExpandedPath() };

    const send = (data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('onboarding:cli-progress', data);
      }
    };

    send({ status: 'installing', message: 'Installing CLI backends...' });

    const results = {};
    for (const [cmd, pkg] of Object.entries(CLI_PACKAGES)) {
      // Skip if already installed
      if (findCli(cmd)) {
        results[cmd] = true;
        continue;
      }

      send({ status: 'installing', message: `Installing ${cmd}...` });
      try {
        execSync(`${npm} install -g ${pkg}`, { encoding: 'utf-8', timeout: 120000, env });
        results[cmd] = !!findCli(cmd);
      } catch (e) {
        console.warn(`[Onboarding] Failed to install ${cmd} (${pkg}):`, e.message);
        results[cmd] = false;
      }
    }

    const allInstalled = Object.values(results).every(Boolean);

    if (allInstalled) {
      send({ status: 'complete', message: 'CLI backends installed' });
    } else {
      const failed = Object.entries(results).filter(([, ok]) => !ok).map(([cmd]) => cmd);
      console.warn('[Onboarding] CLI install results:', results);
      send({ status: 'error', message: `Failed to install: ${failed.join(', ')}` });
    }

    return { success: allInstalled, results, allInstalled };
  });

  // Detect all provider statuses (logins + API keys)
  ipcMain.handle('onboarding:detect-providers', async () => {
    // Run billing checks to populate ai_account_status
    try {
      await BillingService.checkAll(db);
    } catch (e) {
      console.warn('[Onboarding] Billing check error:', e.message);
    }

    // Read account status for all providers
    const statuses = {};
    const providers = ['anthropic', 'google', 'openai', 'xai'];

    for (const providerId of providers) {
      const row = db.prepare('SELECT * FROM ai_account_status WHERE provider_id = ?').get(providerId);
      const envKey = db.prepare('SELECT api_key_env FROM ai_providers WHERE id = ?').get(providerId);
      const hasApiKey = envKey ? !!(EnvService.get(db, envKey.api_key_env) || process.env[envKey.api_key_env]) : false;

      statuses[providerId] = {
        login: row?.login_status === 'active',
        apiKey: hasApiKey,
        apiStatus: row?.api_status || 'unknown',
        loginStatus: row?.login_status || 'unknown',
        planTier: row?.plan_tier || null
      };
    }

    // Check ElevenLabs (voice - not in ai_providers)
    statuses.elevenlabs = {
      apiKey: !!(EnvService.get(db, 'ELEVENLABS_API_KEY') || process.env.ELEVENLABS_API_KEY)
    };

    return statuses;
  });

  // Check if a specific CLI command is installed (uses expanded PATH)
  ipcMain.handle('onboarding:check-cli-installed', (event, command) => {
    const { findCli } = require('../utils/cli-path');
    return !!findCli(command);
  });

  // Install a single CLI package globally
  ipcMain.handle('onboarding:install-single-cli', async (event, command) => {
    const { installCli, findCli } = require('../utils/cli-path');
    const result = await installCli(command);
    return { ...result, installed: !!findCli(command) };
  });
}

module.exports = registerOnboardingHandlers;
