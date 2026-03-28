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

  // Install all 4 CLI backends globally
  ipcMain.handle('onboarding:install-clis', () => {
    return new Promise((resolve) => {
      const packages = [
        '@anthropic-ai/claude-code',
        '@google-ai/gemini-cli',
        '@vibe-kit/codex-cli',
        '@vibe-kit/grok-cli'
      ];

      const send = (data) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('onboarding:cli-progress', data);
        }
      };

      send({ status: 'installing', message: 'Installing CLI backends...' });

      const child = spawn('npm', ['install', '-g', ...packages], {
        env: { ...process.env },
        shell: true
      });

      let output = '';

      child.stdout.on('data', (data) => {
        output += data.toString();
        send({ status: 'installing', message: data.toString().trim() });
      });

      child.stderr.on('data', (data) => {
        output += data.toString();
      });

      child.on('close', (code) => {
        if (code === 0) {
          send({ status: 'complete', message: 'CLI backends installed' });
          resolve({ success: true });
        } else {
          console.warn('[Onboarding] CLI install exited with code', code);
          send({ status: 'error', message: 'Some CLI backends may not have installed correctly' });
          // Resolve (not reject) — partial installs are OK, detection handles gaps
          resolve({ success: false, output });
        }
      });

      child.on('error', (err) => {
        console.error('[Onboarding] CLI install error:', err);
        send({ status: 'error', message: err.message });
        resolve({ success: false, error: err.message });
      });
    });
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

  // Check if a specific CLI command is installed
  ipcMain.handle('onboarding:check-cli-installed', async (event, command) => {
    const { execSync } = require('child_process');
    try {
      execSync(`which ${command}`, { encoding: 'utf-8', timeout: 5000 });
      return true;
    } catch {
      // Try npm global bin fallback
      try {
        const npmRoot = execSync('npm root -g', { encoding: 'utf-8', timeout: 5000 }).trim();
        const binDir = path.join(npmRoot, '..', 'bin');
        const fs = require('fs');
        return fs.existsSync(path.join(binDir, command));
      } catch {
        return false;
      }
    }
  });
}

module.exports = registerOnboardingHandlers;
