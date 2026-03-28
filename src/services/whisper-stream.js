/**
 * WhisperStreamService - Real-time streaming transcription server management
 *
 * Manages the whisper-stream-server process lifecycle.
 * Server is at ~/os8/models/whisper/server/
 * Uses WebSocket for real-time audio streaming (not IPC).
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { MODELS_DIR } = require('../config');

const WHISPER_DIR = path.join(MODELS_DIR, 'whisper');
const STREAM_SERVER_DIR = path.join(WHISPER_DIR, 'server');
const STREAM_SERVER_BIN = path.join(STREAM_SERVER_DIR, 'build', 'whisper-stream-server');
const MODEL_PATH = path.join(WHISPER_DIR, 'ggml-base.bin');
const VAD_MODEL_PATH = path.join(WHISPER_DIR, 'ggml-silero-vad.bin');

// Default streaming parameters (tuned for M2 + base model)
const DEFAULT_CONFIG = {
  port: 9090,
  step: 250,      // Update every 250ms (feels live)
  length: 10000,  // 10 second context window (allows longer utterances)
  keep: 300,      // 300ms overlap
  threads: 4,     // 4 threads for M2
  vadSilence: 1800, // 1.8 seconds silence triggers final (allows natural pauses)
  language: 'en'
};

class WhisperStreamService {
  static process = null;
  static restartAttempts = 0;
  static maxRestarts = 3;
  static config = { ...DEFAULT_CONFIG };

  /**
   * Check if streaming server binary exists
   */
  static isInstalled() {
    return fs.existsSync(STREAM_SERVER_BIN) &&
           fs.existsSync(MODEL_PATH) &&
           fs.existsSync(VAD_MODEL_PATH);
  }

  /**
   * Check if streaming server is currently running
   */
  static isRunning() {
    return this.process !== null && !this.process.killed;
  }

  /**
   * Check if ready to accept connections
   */
  static isReady() {
    return this.isInstalled() && this.isRunning();
  }

  /**
   * Get status information
   */
  static getStatus() {
    return {
      installed: this.isInstalled(),
      running: this.isRunning(),
      ready: this.isReady(),
      serverPath: STREAM_SERVER_BIN,
      modelPath: MODEL_PATH,
      vadModelPath: VAD_MODEL_PATH,
      port: this.config.port,
      hasBinary: fs.existsSync(STREAM_SERVER_BIN),
      hasModel: fs.existsSync(MODEL_PATH),
      hasVadModel: fs.existsSync(VAD_MODEL_PATH)
    };
  }

  /**
   * Update configuration (call before start)
   */
  static configure(options = {}) {
    this.config = { ...DEFAULT_CONFIG, ...options };
  }

  /**
   * Start the streaming server
   * Async for I/O operations
   */
  static async start() {
    if (this.process) {
      console.log('WhisperStream: Server already running');
      return;
    }

    if (!this.isInstalled()) {
      const missing = [];
      if (!fs.existsSync(STREAM_SERVER_BIN)) missing.push('server binary');
      if (!fs.existsSync(MODEL_PATH)) missing.push('whisper model');
      if (!fs.existsSync(VAD_MODEL_PATH)) missing.push('VAD model');
      throw new Error(`Whisper stream server not installed. Missing: ${missing.join(', ')}`);
    }

    const args = [
      '-m', MODEL_PATH,
      '--vad-model', VAD_MODEL_PATH,
      '-p', String(this.config.port),
      '--step', String(this.config.step),
      '--length', String(this.config.length),
      '--keep', String(this.config.keep),
      '-t', String(this.config.threads),
      '--vad-silence', String(this.config.vadSilence),
      '-l', this.config.language
    ];

    return new Promise((resolve, reject) => {
      console.log('WhisperStream: Starting server...');
      console.log('WhisperStream: Command:', STREAM_SERVER_BIN, args.join(' '));

      this.process = spawn(STREAM_SERVER_BIN, args, {
        cwd: STREAM_SERVER_DIR,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let startupOutput = '';
      let resolved = false;

      const onData = (data) => {
        const str = data.toString();
        startupOutput += str;
        console.log('WhisperStream:', str.trim());

        // Check for successful startup
        if (!resolved && str.includes('Listening on')) {
          resolved = true;
          this.restartAttempts = 0;
          resolve();
        }
      };

      this.process.stdout.on('data', onData);
      this.process.stderr.on('data', onData);

      this.process.on('error', (err) => {
        console.error('WhisperStream: Server error:', err);
        this.process = null;
        if (!resolved) {
          reject(err);
        } else {
          this.handleCrash();
        }
      });

      this.process.on('exit', (code) => {
        console.log('WhisperStream: Server exited with code:', code);
        this.process = null;
        if (!resolved) {
          reject(new Error(`Server failed to start. Exit code: ${code}\n${startupOutput}`));
        } else if (code !== 0) {
          this.handleCrash();
        }
      });

      // Timeout if server doesn't start within 10 seconds
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          if (this.process) {
            this.process.kill();
            this.process = null;
          }
          reject(new Error(`Server startup timeout.\n${startupOutput}`));
        }
      }, 10000);
    });
  }

  /**
   * Handle server crash with auto-restart
   */
  static handleCrash() {
    this.process = null;
    if (this.restartAttempts < this.maxRestarts) {
      this.restartAttempts++;
      console.log(`WhisperStream: Restarting server (attempt ${this.restartAttempts}/${this.maxRestarts})`);
      setTimeout(() => {
        this.start().catch((err) => {
          console.error('WhisperStream: Restart failed:', err.message);
        });
      }, 1000 * this.restartAttempts); // Exponential backoff
    } else {
      console.error('WhisperStream: Server failed too many times, giving up. Batch mode available as fallback.');
    }
  }

  /**
   * Stop the streaming server
   */
  static stop() {
    if (this.process) {
      console.log('WhisperStream: Stopping server...');
      this.process.kill('SIGTERM');

      // Force kill after 5 seconds if still running
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          console.log('WhisperStream: Force killing server...');
          this.process.kill('SIGKILL');
        }
      }, 5000);

      this.process = null;
    }
  }

  /**
   * Get the WebSocket URL for connecting to the streaming server
   * Uses 127.0.0.1 instead of localhost to avoid IPv6 resolution issues
   */
  static getWebSocketUrl() {
    return `ws://127.0.0.1:${this.config.port}`;
  }
}

module.exports = WhisperStreamService;
