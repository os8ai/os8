/**
 * IPC Handlers for TTS (Text-to-Speech) domain
 * Handles: tts:*
 * Provides settings management and voice list retrieval via active TTS provider
 */

const { ipcMain } = require('electron')

function registerTTSHandlers({ db, services }) {
  const { TTSService } = services

  /**
   * Get TTS settings
   */
  ipcMain.handle('tts:getSettings', () => {
    return TTSService.getSettings(db)
  })

  /**
   * Update TTS settings
   */
  ipcMain.handle('tts:updateSettings', (event, settings) => {
    return TTSService.setSettings(db, settings)
  })

  /**
   * Get available voices from active TTS provider
   */
  ipcMain.handle('tts:getVoices', async () => {
    try {
      const voices = await TTSService.getVoices(db)
      return { voices }
    } catch (err) {
      console.error('Failed to get TTS voices:', err)
      return { error: err.message }
    }
  })

  /**
   * Check if TTS is available (provider configured + API key present)
   */
  ipcMain.handle('tts:isAvailable', () => {
    return TTSService.isAvailable(db)
  })
}

module.exports = registerTTSHandlers
