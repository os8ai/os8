/**
 * TranscribeService - Video to text transcription
 *
 * Extracts audio from video files using ffmpeg, then transcribes
 * using WhisperService (local whisper.cpp).
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WhisperService = require('./whisper');

class TranscribeService {
  /**
   * Check if ffmpeg is available
   */
  static async hasFfmpeg() {
    return new Promise((resolve) => {
      const proc = spawn('ffmpeg', ['-version']);
      proc.on('close', (code) => resolve(code === 0));
      proc.on('error', () => resolve(false));
    });
  }

  /**
   * Get service status
   */
  static async getStatus() {
    const hasFfmpeg = await this.hasFfmpeg();
    const whisperStatus = WhisperService.getStatus();

    return {
      ready: hasFfmpeg && whisperStatus.ready,
      hasFfmpeg,
      whisperReady: whisperStatus.ready,
      whisperHasBinary: whisperStatus.hasBinary,
      whisperHasModel: whisperStatus.hasModel
    };
  }

  /**
   * Get video duration using ffprobe
   */
  static async getVideoDuration(videoPath) {
    return new Promise((resolve, reject) => {
      const proc = spawn('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        videoPath
      ]);

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        if (code === 0) {
          const duration = parseFloat(stdout.trim());
          resolve(isNaN(duration) ? null : duration);
        } else {
          // ffprobe failed, duration unknown but not fatal
          resolve(null);
        }
      });

      proc.on('error', () => resolve(null));
    });
  }

  /**
   * Extract audio from video to a temporary WAV file
   * @param {string} videoPath - Path to video file
   * @param {function} onProgress - Progress callback (0-1)
   * @returns {Promise<string>} Path to temporary WAV file
   */
  static async extractAudio(videoPath, onProgress) {
    const tempDir = os.tmpdir();
    const tempId = Date.now() + '-' + Math.random().toString(36).slice(2);
    const wavPath = path.join(tempDir, `transcribe-${tempId}.wav`);

    return new Promise((resolve, reject) => {
      // ffmpeg args: extract audio, convert to 16kHz mono WAV (whisper.cpp requirement)
      const args = [
        '-i', videoPath,
        '-vn',              // No video
        '-ar', '16000',     // 16kHz sample rate
        '-ac', '1',         // Mono
        '-c:a', 'pcm_s16le', // 16-bit PCM
        '-y',               // Overwrite
        wavPath
      ];

      // Add progress tracking if we know the duration
      if (onProgress) {
        args.unshift('-progress', 'pipe:1');
      }

      const proc = spawn('ffmpeg', args);

      let stderr = '';
      let lastProgress = 0;

      proc.stdout.on('data', (data) => {
        // Parse ffmpeg progress output
        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (line.startsWith('out_time_ms=')) {
            const ms = parseInt(line.split('=')[1], 10);
            if (!isNaN(ms) && onProgress) {
              // We don't know total duration here, so emit raw ms
              // Caller can calculate percentage if they have duration
              onProgress({ type: 'extracting', ms });
            }
          }
        }
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(wavPath);
        } else {
          reject(new Error(`FFmpeg failed to extract audio: ${stderr.slice(-500)}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`FFmpeg not found or failed to start: ${err.message}`));
      });
    });
  }

  /**
   * Transcribe a video file
   * @param {string} videoPath - Path to video file
   * @param {object} options - Transcription options
   * @param {function} onProgress - Progress callback
   * @returns {Promise<{text: string, segments: Array, duration: number, source: string}>}
   */
  static async transcribe(videoPath, options = {}, onProgress) {
    // Validate file exists
    if (!fs.existsSync(videoPath)) {
      throw new Error(`Video file not found: ${videoPath}`);
    }

    // Check dependencies
    const status = await this.getStatus();
    if (!status.hasFfmpeg) {
      throw new Error('FFmpeg not found. Please install ffmpeg to transcribe videos.');
    }
    if (!status.whisperReady) {
      throw new Error('Whisper not ready. Run whisper setup first.');
    }

    const {
      language = 'en',
      wordTimestamps = false,
      suppressNonSpeech = false,
      prompt
    } = options;

    let wavPath = null;

    try {
      // Get video duration for progress tracking
      onProgress?.({ phase: 'analyzing', progress: 0 });
      const duration = await this.getVideoDuration(videoPath);

      // Extract audio
      onProgress?.({ phase: 'extracting', progress: 0.1 });
      wavPath = await this.extractAudio(videoPath, (extractProgress) => {
        if (duration && extractProgress.ms) {
          const extractPct = Math.min((extractProgress.ms / 1000000) / duration, 1);
          onProgress?.({ phase: 'extracting', progress: 0.1 + extractPct * 0.3 });
        }
      });
      onProgress?.({ phase: 'extracting', progress: 0.4 });

      // Transcribe with Whisper
      onProgress?.({ phase: 'transcribing', progress: 0.5 });
      const result = await WhisperService.transcribe(wavPath, {
        language,
        wordTimestamps,
        suppressNonSpeech,
        prompt
      });
      onProgress?.({ phase: 'transcribing', progress: 0.95 });

      // Format response
      const response = {
        text: result.text,
        segments: result.segments.map(seg => ({
          start: seg.offsets?.from ? seg.offsets.from / 1000 : seg.t0 || 0,
          end: seg.offsets?.to ? seg.offsets.to / 1000 : seg.t1 || 0,
          text: seg.text?.trim() || ''
        })),
        duration: duration || null,
        source: 'whisper-local'
      };

      onProgress?.({ phase: 'complete', progress: 1 });
      return response;

    } finally {
      // Clean up temp WAV file
      if (wavPath && fs.existsSync(wavPath)) {
        try {
          fs.unlinkSync(wavPath);
        } catch (e) {
          console.error('Failed to clean up temp file:', e.message);
        }
      }
    }
  }
}

module.exports = TranscribeService;
