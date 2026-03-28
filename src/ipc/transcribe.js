/**
 * IPC Handlers for Video Transcription
 * Handles: transcribe:* (video to text conversion)
 */

const { ipcMain } = require('electron');
const TranscribeService = require('../services/transcribe');

function registerTranscribeHandlers({ services }) {
  /**
   * Get transcription service status
   * Returns: { ready, hasFfmpeg, whisperReady, ... }
   */
  ipcMain.handle('transcribe:status', async () => {
    return TranscribeService.getStatus();
  });

  /**
   * Transcribe a video file
   * Sends progress events via transcribe:progress channel
   *
   * @param {string} videoPath - Path to video file
   * @param {object} options - { language?, wordTimestamps? }
   * @returns {{ success: boolean, result?: object, error?: string }}
   */
  ipcMain.handle('transcribe:file', async (event, videoPath, options = {}) => {
    try {
      const result = await TranscribeService.transcribe(
        videoPath,
        options,
        (progress) => {
          // Send progress updates to renderer
          event.sender.send('transcribe:progress', progress);
        }
      );

      return { success: true, result };
    } catch (err) {
      console.error('Transcribe IPC error:', err);
      return { success: false, error: err.message };
    }
  });
}

module.exports = registerTranscribeHandlers;
