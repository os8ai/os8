/**
 * IPC Handlers for Whisper domain
 * Handles: whisper:* (batch transcription setup)
 * Handles: whisper:stream-* (streaming server lifecycle)
 */

const { ipcMain } = require('electron');

function registerWhisperHandlers({ services }) {
  const { WhisperService, WhisperStreamService } = services;

  // ============================================
  // Batch Whisper (whisper.cpp CLI)
  // ============================================

  /**
   * Get whisper status (ready, hasBinary, hasModel)
   */
  ipcMain.handle('whisper:status', async () => {
    return WhisperService.getStatus();
  });

  /**
   * Check if whisper is ready
   */
  ipcMain.handle('whisper:isReady', async () => {
    return WhisperService.isReady();
  });

  /**
   * Setup whisper (download binary and model)
   * This can take a while - compiles whisper.cpp and downloads ~142MB model
   */
  ipcMain.handle('whisper:setup', async (event) => {
    try {
      const status = await WhisperService.setup((progress) => {
        // Send progress updates to renderer
        event.sender.send('whisper:setup-progress', progress);
      });
      return { success: true, status };
    } catch (err) {
      console.error('Whisper setup error:', err);
      return { success: false, error: err.message };
    }
  });

  // ============================================
  // Streaming Server (whisper-stream-server)
  // ============================================

  /**
   * Get streaming server status
   */
  ipcMain.handle('whisper:stream-status', () => {
    return WhisperStreamService.getStatus();
  });

  /**
   * Start the streaming server
   */
  ipcMain.handle('whisper:stream-start', async () => {
    try {
      await WhisperStreamService.start();
      return { success: true, url: WhisperStreamService.getWebSocketUrl() };
    } catch (err) {
      console.error('WhisperStream start error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Stop the streaming server
   */
  ipcMain.handle('whisper:stream-stop', () => {
    WhisperStreamService.stop();
    return { success: true };
  });

  /**
   * Configure streaming server (call before start)
   */
  ipcMain.handle('whisper:stream-configure', (event, options) => {
    WhisperStreamService.configure(options);
    return { success: true };
  });
}

module.exports = registerWhisperHandlers;
