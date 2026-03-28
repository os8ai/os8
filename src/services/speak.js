/**
 * SpeakService - Text to audio generation
 *
 * Generates MP3 audio files from text using the active TTS provider.
 * Saves files to ~/os8/blob/speak/ for later use (e.g., Telegram voice messages).
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { BLOB_DIR } = require('../config');
const TTSService = require('./tts');

// Speak files directory
const SPEAK_DIR = path.join(BLOB_DIR, 'speak');

class SpeakService {
  /**
   * Ensure speak directory exists
   */
  static ensureSpeakDir() {
    if (!fs.existsSync(SPEAK_DIR)) {
      fs.mkdirSync(SPEAK_DIR, { recursive: true });
    }
  }

  /**
   * Check if service is available
   * @param {Database} db - SQLite database
   * @returns {{ ready: boolean, provider: string|null, reason?: string }}
   */
  static getStatus(db) {
    const status = TTSService.isAvailable(db);
    return {
      ready: status.available,
      hasApiKey: status.available,
      provider: status.provider,
      reason: status.reason
    };
  }

  /**
   * Generate a short hash for filenames
   */
  static generateHash(text) {
    return crypto.createHash('md5').update(text).digest('hex').slice(0, 8);
  }

  /**
   * Generate audio from text
   * @param {Database} db - SQLite database
   * @param {string} text - Text to convert to speech
   * @param {object} options - Generation options
   * @param {string} options.voiceId - Override voice ID
   * @param {string} options.model - Override model ID
   * @param {number} options.stability - Voice stability (0-1, ElevenLabs only)
   * @param {number} options.similarityBoost - Voice similarity boost (0-1, ElevenLabs only)
   * @param {number} options.speed - Speed (0.25-4.0)
   * @param {boolean} options.returnBase64 - Return audio as base64 instead of saving file
   * @returns {Promise<{ success: boolean, filePath?: string, base64?: string, duration?: number, voiceId: string, textLength: number }>}
   */
  static async generateAudio(db, text, options = {}) {
    // Validate input
    if (!text || typeof text !== 'string') {
      throw new Error('Text is required');
    }

    if (text.length > 5000) {
      throw new Error('Text exceeds maximum length of 5000 characters');
    }

    // Get provider and API key
    const provider = TTSService.getProvider(db);
    if (!provider) {
      throw new Error('No TTS provider configured. Set one in Settings.');
    }

    const apiKey = TTSService.getApiKey(db);
    if (!apiKey) {
      throw new Error(`${provider.PROVIDER_ID} API key not configured. Add it in Settings > API Keys.`);
    }

    // Get TTS settings as defaults
    const ttsSettings = TTSService.getSettings(db);
    const voiceId = options.voiceId || ttsSettings.voiceId;

    // Generate audio via provider
    const audioData = await provider.generateAudio(apiKey, text, voiceId, {
      model: options.model || ttsSettings.model,
      stability: options.stability ?? ttsSettings.stability,
      similarityBoost: options.similarityBoost ?? ttsSettings.similarityBoost,
      speed: options.speed ?? ttsSettings.speed
    });

    // Estimate duration (rough: MP3 at 128kbps = ~16KB per second)
    const estimatedDuration = Math.round((audioData.length / 16000) * 10) / 10;

    // Return as base64 if requested
    if (options.returnBase64) {
      return {
        success: true,
        base64: audioData.toString('base64'),
        mimeType: 'audio/mpeg',
        duration: estimatedDuration,
        voiceId,
        textLength: text.length
      };
    }

    // Save to file
    this.ensureSpeakDir();

    const timestamp = Date.now();
    const hash = this.generateHash(text);
    const filename = `${timestamp}-${hash}.mp3`;
    const filePath = path.join(SPEAK_DIR, filename);

    fs.writeFileSync(filePath, audioData);

    console.log(`Speak: Generated audio file ${filename} (${audioData.length} bytes, ~${estimatedDuration}s)`);

    return {
      success: true,
      filePath,
      filename,
      size: audioData.length,
      duration: estimatedDuration,
      voiceId,
      textLength: text.length
    };
  }

  /**
   * List generated audio files
   * @returns {Array<{ filename: string, filePath: string, size: number, created: Date }>}
   */
  static listFiles() {
    this.ensureSpeakDir();

    const files = fs.readdirSync(SPEAK_DIR)
      .filter(f => f.endsWith('.mp3'))
      .map(filename => {
        const filePath = path.join(SPEAK_DIR, filename);
        const stats = fs.statSync(filePath);
        return {
          filename,
          filePath,
          size: stats.size,
          created: stats.birthtime
        };
      })
      .sort((a, b) => b.created - a.created); // Newest first

    return files;
  }

  /**
   * Delete an audio file
   * @param {string} filename - Filename to delete
   * @returns {{ success: boolean }}
   */
  static deleteFile(filename) {
    const filePath = path.join(SPEAK_DIR, filename);

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filename}`);
    }

    // Security: ensure file is in speak directory
    if (!filePath.startsWith(SPEAK_DIR)) {
      throw new Error('Invalid file path');
    }

    fs.unlinkSync(filePath);
    return { success: true };
  }

  /**
   * Clean up old audio files (older than specified days)
   * @param {number} olderThanDays - Delete files older than this many days
   * @returns {{ deleted: number }}
   */
  static cleanup(olderThanDays = 7) {
    this.ensureSpeakDir();

    const cutoff = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);
    let deleted = 0;

    const files = fs.readdirSync(SPEAK_DIR).filter(f => f.endsWith('.mp3'));

    for (const filename of files) {
      const filePath = path.join(SPEAK_DIR, filename);
      const stats = fs.statSync(filePath);

      if (stats.birthtimeMs < cutoff) {
        fs.unlinkSync(filePath);
        deleted++;
      }
    }

    if (deleted > 0) {
      console.log(`Speak: Cleaned up ${deleted} old audio files`);
    }

    return { deleted };
  }
}

module.exports = SpeakService;
