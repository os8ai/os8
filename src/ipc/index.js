/**
 * IPC Handler Registration
 * Organizes all IPC handlers into domain-specific modules
 */

const registerAppsHandlers = require('./apps');
const registerAssistantHandlers = require('./assistant');
const registerCoreHandlers = require('./core');
const registerTasksHandlers = require('./tasks');
const registerJobsHandlers = require('./jobs');
const registerSettingsHandlers = require('./settings');
const registerConnectionsHandlers = require('./connections');
const registerPreviewHandlers = require('./preview');
const registerTerminalHandlers = require('./terminal');
const registerFilesHandlers = require('./files');
const registerVoiceHandlers = require('./voice');
const registerWhisperHandlers = require('./whisper');
const registerTTSHandlers = require('./tts');
const registerTranscribeHandlers = require('./transcribe');
const registerSpeakHandlers = require('./speak');
const registerTunnelHandlers = require('./tunnel');
const registerCallHandlers = require('./call');
const registerDataStorageHandlers = require('./data-storage');
const registerInspectHandlers = require('./inspect');
const registerAgentsHandlers = require('./agents');
const registerMcpHandlers = require('./mcp');
const registerAccountHandlers = require('./account');
const registerOnboardingHandlers = require('./onboarding');
const registerAppStoreHandlers = require('./app-store');

// Cleanup functions returned by handlers
let cleanupFunctions = {};

/**
 * Register all IPC handlers
 * @param {object} deps - Dependencies object containing:
 *   - db: Database connection
 *   - mainWindow: BrowserWindow instance
 *   - services: Service modules (AppService, etc.)
 *   - state: Shared state (ptySessions, previewViews, etc.)
 *   - helpers: Helper functions (startTasksWatcher, etc.)
 * @returns {object} Cleanup functions for shutdown
 */
function registerAllHandlers(deps) {
  registerAppsHandlers(deps);
  registerAssistantHandlers(deps);
  registerCoreHandlers(deps);
  registerTasksHandlers(deps);
  registerJobsHandlers(deps);
  registerSettingsHandlers(deps);
  registerConnectionsHandlers(deps);

  // These handlers return cleanup functions
  const previewCleanup = registerPreviewHandlers(deps);
  const terminalCleanup = registerTerminalHandlers(deps);

  // Make previewService available to inspect handlers via state
  if (previewCleanup.previewService) {
    deps.state.previewService = previewCleanup.previewService;
  }

  registerFilesHandlers(deps);
  registerVoiceHandlers(deps);
  registerWhisperHandlers(deps);
  registerTTSHandlers(deps);
  registerTranscribeHandlers(deps);
  registerSpeakHandlers(deps);
  registerTunnelHandlers(deps);
  registerCallHandlers(deps);
  registerDataStorageHandlers(deps);

  // Inspect handlers return cleanup functions (needs previewService on state)
  const inspectCleanup = registerInspectHandlers(deps);

  registerAgentsHandlers(deps);
  registerMcpHandlers(deps);

  registerAccountHandlers(deps);
  registerOnboardingHandlers(deps);
  registerAppStoreHandlers(deps);

  cleanupFunctions = {
    ...previewCleanup,
    ...terminalCleanup,
    ...inspectCleanup
  };

  return cleanupFunctions;
}

/**
 * Get cleanup functions for shutdown
 */
function getCleanupFunctions() {
  return cleanupFunctions;
}

module.exports = { registerAllHandlers, getCleanupFunctions };
