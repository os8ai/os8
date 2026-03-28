/**
 * IPC Handlers for Speak (Text-to-Audio)
 * Handles: speak:* (audio generation)
 */

const { ipcMain } = require('electron');
const SpeakService = require('../services/speak');

function registerSpeakHandlers({ db, services }) {
  /**
   * Get speak service status
   * Returns: { ready, hasApiKey }
   */
  ipcMain.handle('speak:status', () => {
    return SpeakService.getStatus(db);
  });

  /**
   * Generate audio from text
   * @param {string} text - Text to convert to speech
   * @param {object} options - { voiceId?, model?, stability?, similarityBoost?, returnBase64? }
   * @returns {{ success: boolean, filePath?: string, base64?: string, error?: string }}
   */
  ipcMain.handle('speak:generate', async (event, text, options = {}) => {
    try {
      const result = await SpeakService.generateAudio(db, text, options);
      return result;
    } catch (err) {
      console.error('Speak IPC error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * List generated audio files
   * Returns: { files: Array }
   */
  ipcMain.handle('speak:list', () => {
    try {
      const files = SpeakService.listFiles();
      return { success: true, files };
    } catch (err) {
      console.error('Speak IPC list error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Delete an audio file
   * @param {string} filename - Filename to delete
   */
  ipcMain.handle('speak:delete', (event, filename) => {
    try {
      SpeakService.deleteFile(filename);
      return { success: true };
    } catch (err) {
      console.error('Speak IPC delete error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Clean up old audio files
   * @param {number} olderThanDays - Delete files older than this many days (default 7)
   */
  ipcMain.handle('speak:cleanup', (event, olderThanDays = 7) => {
    try {
      const result = SpeakService.cleanup(olderThanDays);
      return { success: true, ...result };
    } catch (err) {
      console.error('Speak IPC cleanup error:', err);
      return { success: false, error: err.message };
    }
  });
}

module.exports = registerSpeakHandlers;
