/**
 * IPC Handlers for Assistant domain
 * Handles: assistant:chat, assistant:reset-session, assistant:session-status
 */

const { ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const { loadJSON, saveJSON } = require('../utils/file-helpers');
const { getBackend } = require('../services/backend-adapter');
const AgentService = require('../services/agent');

// Session state
let assistantSessionId = null;

function registerAssistantHandlers({ mainWindow, db, services }) {
  const { APPS_DIR } = services;

  // Helper to get default agent and its paths
  function getDefaultAgentWithPaths() {
    const agent = db ? AgentService.getDefault(db) : null;
    if (!agent) return null;
    const paths = AgentService.getPaths(agent.app_id || agent.id, agent.id);
    return { agent, ...paths };
  }

  // Send a message to the assistant and get a response
  ipcMain.handle('assistant:chat', async (event, message) => {
    const result = getDefaultAgentWithPaths();
    if (!result) {
      throw new Error('Assistant not found. Create it first.');
    }

    const appPath = result.agentDir;
    const agentBlobDir = result.agentBlobDir;

    // Read backend from assistant config
    const assistantConfig = loadJSON(path.join(appPath, 'assistant-config.json'), {});
    const backendId = assistantConfig.agentBackend || 'claude';
    const agentModel = assistantConfig.agentModel || undefined;
    const backend = getBackend(backendId);

    return new Promise((resolve, reject) => {
      // Build args via backend adapter
      const args = backend.buildArgs({
        print: true,
        json: true,
        skipPermissions: true,
        appPath,
        blobDir: agentBlobDir,
        model: agentModel,
      });
      args.push(...backend.buildPromptArgs(message));

      // If we have a previous session, continue it (Claude only)
      if (assistantSessionId && backendId === 'claude') {
        args.unshift('--continue');
      }

      console.log(`Running ${backend.command} with args:`, args.join(' '));

      let assistantBaseEnv = process.env;
      if (db) {
        const EnvService = require('../services/env');
        assistantBaseEnv = { ...process.env, ...EnvService.asObject(db) };
      }
      const claude = spawn(backend.command, args, {
        cwd: appPath,
        env: backend.prepareEnv(assistantBaseEnv),
        shell: true
      });

      let stdout = '';
      let stderr = '';

      claude.stdout.on('data', (data) => {
        stdout += data.toString();
        // Stream partial updates to the renderer
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('assistant:stream', { data: data.toString() });
        }
      });

      claude.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      claude.on('close', (code) => {
        if (code !== 0) {
          console.error(`${backend.label} exited with code`, code, stderr);
          // If no stdout at all, reject as error
          if (!stdout.trim()) {
            reject(new Error(`${backend.label} exited with code ${code}: ${stderr}`));
            return;
          }
          // Otherwise fall through and try to parse whatever we got
          console.warn(`${backend.label} crashed but has output, attempting to parse`);
        }

        try {
          // Parse JSON response
          const response = JSON.parse(stdout);

          // Extract the session ID for continuation
          if (response.session_id) {
            assistantSessionId = response.session_id;
          }

          // Extract the text response
          let textResponse = '';
          if (response.result) {
            textResponse = response.result;
          } else if (response.content) {
            // Handle array of content blocks
            textResponse = response.content
              .filter(block => block.type === 'text')
              .map(block => block.text)
              .join('\n');
          } else if (typeof response === 'string') {
            textResponse = response;
          }

          resolve({
            text: textResponse,
            sessionId: assistantSessionId,
            raw: response
          });
        } catch (parseErr) {
          // If JSON parsing fails, return raw stdout
          console.warn('Could not parse JSON response, returning raw:', parseErr);
          resolve({
            text: stdout.trim(),
            sessionId: assistantSessionId,
            raw: null
          });
        }
      });

      claude.on('error', (err) => {
        reject(err);
      });
    });
  });

  // Reset assistant session (start fresh conversation)
  ipcMain.handle('assistant:reset-session', () => {
    assistantSessionId = null;
    return { success: true };
  });

  // Get assistant session status
  ipcMain.handle('assistant:session-status', () => {
    return {
      hasSession: !!assistantSessionId,
      sessionId: assistantSessionId
    };
  });

}

module.exports = registerAssistantHandlers;
