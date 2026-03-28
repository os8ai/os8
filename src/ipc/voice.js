/**
 * IPC Handlers for Voice domain
 * Handles: voice:*
 * Uses local whisper.cpp when available, falls back to OpenAI API
 */

const { ipcMain } = require('electron');

function registerVoiceHandlers({ db, services }) {
  const { EnvService, WhisperService, SettingsService } = services;

  /**
   * Get voice settings
   */
  ipcMain.handle('voice:getSettings', () => {
    return SettingsService.getVoiceSettings(db);
  });

  /**
   * Update voice settings
   */
  ipcMain.handle('voice:updateSettings', (event, settings) => {
    return SettingsService.setVoiceSettings(db, settings);
  });

  /**
   * Transcribe audio using local whisper.cpp or OpenAI API fallback
   * @param {ArrayBuffer} audioBuffer - Raw audio data
   * @param {string} mimeType - Audio MIME type (e.g., 'audio/webm')
   * @param {string} language - Optional language code
   * @returns {Promise<{text: string, source: string} | {error: string}>}
   */
  ipcMain.handle('voice:transcribe', async (event, audioBuffer, mimeType, language) => {
    try {
      if (!audioBuffer || audioBuffer.byteLength === 0) {
        return { error: 'No audio data provided' };
      }

      // Try local whisper first
      if (WhisperService.isReady()) {
        console.log('Using local whisper.cpp for transcription...');

        const result = await WhisperService.transcribeBuffer(
          audioBuffer,
          mimeType || 'audio/webm',
          { language: language || 'en' }
        );

        return {
          text: result.text,
          source: 'local'
        };
      }

      // Fallback to OpenAI API
      console.log('Local whisper not ready, falling back to OpenAI API...');

      const apiKeyRecord = EnvService.get(db, 'OPENAI_API_KEY');
      if (!apiKeyRecord || !apiKeyRecord.value) {
        return {
          error: 'Local whisper not set up and no OpenAI API key configured.'
        };
      }

      const apiKey = apiKeyRecord.value;
      const extension = mimeType?.includes('webm') ? 'webm' : 'mp4';

      const formData = new FormData();
      const audioBlob = new Blob([audioBuffer], { type: mimeType || 'audio/webm' });
      formData.append('file', audioBlob, `recording.${extension}`);
      formData.append('model', 'whisper-1');

      if (language) {
        formData.append('language', language);
      }

      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
        body: formData
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error('Whisper API error:', response.status, errorData);
        return {
          error: errorData.error?.message || `Whisper API error: ${response.status}`
        };
      }

      const result = await response.json();
      return { text: result.text, source: 'api' };

    } catch (err) {
      console.error('Transcription error:', err);
      return { error: err.message || 'Transcription failed' };
    }
  });
}

module.exports = registerVoiceHandlers;
