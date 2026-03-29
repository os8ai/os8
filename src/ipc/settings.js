/**
 * IPC Handlers for Settings domain
 * Handles: settings:*, env:*, claude:*
 */

const { ipcMain } = require('electron');
const path = require('path');
const { loadJSON } = require('../utils/file-helpers');

function registerSettingsHandlers({ db, services, helpers }) {
  const { EnvService, SettingsService, ClaudeInstructionsService, AppService, APPS_DIR } = services;
  const { generateClaudeMd, generateAssistantClaudeMd } = services;
  const { restartServer, DEFAULT_PORT } = helpers;

  // Environment variables
  ipcMain.handle('env:list', () => EnvService.getAll(db));
  ipcMain.handle('env:get', (event, key) => EnvService.get(db, key));
  ipcMain.handle('env:set', (event, key, value, description) => EnvService.set(db, key, value, description));
  ipcMain.handle('env:delete', (event, key) => EnvService.delete(db, key));

  // Settings
  ipcMain.handle('settings:get', (event, key) => SettingsService.get(db, key));
  ipcMain.handle('settings:set', (event, key, value) => SettingsService.set(db, key, value));
  ipcMain.handle('settings:get-all', () => SettingsService.getAll(db));

  // OS8 Port Setting (used for both server and OAuth callbacks)
  ipcMain.handle('settings:get-oauth-port', () => {
    const current = SettingsService.get(db, 'os8Port');
    return {
      current: current ? parseInt(current, 10) : DEFAULT_PORT,
      default: DEFAULT_PORT,
      isCustom: !!current && parseInt(current, 10) !== DEFAULT_PORT
    };
  });

  // Consolidated: pass null to reset to default
  ipcMain.handle('settings:set-oauth-port', async (event, port) => {
    const effectivePort = port ?? DEFAULT_PORT;
    SettingsService.set(db, 'os8Port', String(effectivePort));
    // Restart server with new port
    await restartServer();
    return { success: true, port: effectivePort, requiresRestart: false };
  });

  // Tunnel URL Setting (for remote access via Cloudflare Tunnel, etc.)
  ipcMain.handle('settings:get-tunnel-url', () => {
    return SettingsService.get(db, 'tunnelUrl') || '';
  });

  ipcMain.handle('settings:set-tunnel-url', (event, url) => {
    // Normalize: remove trailing slash, validate if provided
    let normalizedUrl = url ? url.trim().replace(/\/+$/, '') : '';

    if (normalizedUrl && !normalizedUrl.match(/^https?:\/\//)) {
      return { success: false, error: 'URL must start with http:// or https://' };
    }

    SettingsService.set(db, 'tunnelUrl', normalizedUrl);
    return { success: true, url: normalizedUrl };
  });

  // App UI Settings (persisted per-app UI state)
  ipcMain.handle('settings:get-app-ui', (event, appId) => {
    const json = SettingsService.get(db, `appUi:${appId}`);
    if (!json) return {};
    try {
      return JSON.parse(json);
    } catch {
      return {};
    }
  });

  ipcMain.handle('settings:set-app-ui', (event, appId, settings) => {
    let existing = {};
    const json = SettingsService.get(db, `appUi:${appId}`);
    if (json) try { existing = JSON.parse(json); } catch {}
    const merged = { ...existing, ...settings };
    SettingsService.set(db, `appUi:${appId}`, JSON.stringify(merged));
    return { success: true };
  });

  // Claude Instructions
  ipcMain.handle('claude:get-instructions', () => ClaudeInstructionsService.get(db));
  ipcMain.handle('claude:set-instructions', (event, content) => ClaudeInstructionsService.set(db, content));
  ipcMain.handle('claude:generate-md', (event, appId) => {
    const app = AppService.getById(db, appId);
    if (app) {
      // Use assistant-specific CLAUDE.md for the personal assistant
      if (app.app_type === 'system') {
        // Read config from AgentService (DB + disk merged)
        const AgentService = require('../services/agent');
        const config = AgentService.getConfig(db, app.id) || loadJSON(path.join(APPS_DIR, app.id, 'assistant-config.json'), {});
        return generateAssistantClaudeMd(db, app, config);
      }
      return generateClaudeMd(db, app);
    }
    return null;
  });
}

module.exports = registerSettingsHandlers;
