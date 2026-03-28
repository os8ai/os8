/**
 * WhisperService - Local speech-to-text using whisper.cpp
 *
 * Models are stored in ~/os8/models/whisper/
 * Uses whisper.cpp binary for fast transcription on Apple Silicon
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { MODELS_DIR } = require('../config');

const WHISPER_DIR = path.join(MODELS_DIR, 'whisper');
const WHISPER_BINARY = path.join(WHISPER_DIR, 'whisper-cpp');
const MODEL_PATH_SMALL = path.join(WHISPER_DIR, 'ggml-small.bin');
const MODEL_PATH_BASE = path.join(WHISPER_DIR, 'ggml-base.bin');
const MODEL_PATH = fs.existsSync(MODEL_PATH_SMALL) ? MODEL_PATH_SMALL : MODEL_PATH_BASE;

// Download URLs
const WHISPER_CPP_URL = 'https://github.com/ggerganov/whisper.cpp/releases/download/v1.5.4/whisper-blas-bin-x64.zip';
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin';

class WhisperService {
  /**
   * Check if whisper.cpp is ready to use
   */
  static isReady() {
    return fs.existsSync(WHISPER_BINARY) && fs.existsSync(MODEL_PATH);
  }

  /**
   * Get setup status
   */
  static getStatus() {
    return {
      ready: this.isReady(),
      hasBinary: fs.existsSync(WHISPER_BINARY),
      hasModel: fs.existsSync(MODEL_PATH),
      modelPath: MODEL_PATH,
      binaryPath: WHISPER_BINARY
    };
  }

  /**
   * Ensure whisper directory exists
   */
  static ensureDir() {
    if (!fs.existsSync(WHISPER_DIR)) {
      fs.mkdirSync(WHISPER_DIR, { recursive: true });
    }
  }

  /**
   * Download a file with progress callback
   */
  static async downloadFile(url, destPath, onProgress) {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(destPath);

      const request = (url) => {
        https.get(url, (response) => {
          // Handle redirects
          if (response.statusCode === 301 || response.statusCode === 302) {
            request(response.headers.location);
            return;
          }

          if (response.statusCode !== 200) {
            reject(new Error(`Download failed: ${response.statusCode}`));
            return;
          }

          const totalSize = parseInt(response.headers['content-length'], 10);
          let downloadedSize = 0;

          response.on('data', (chunk) => {
            downloadedSize += chunk.length;
            if (onProgress && totalSize) {
              onProgress(downloadedSize / totalSize);
            }
          });

          response.pipe(file);

          file.on('finish', () => {
            file.close();
            resolve();
          });
        }).on('error', (err) => {
          fs.unlink(destPath, () => {});
          reject(err);
        });
      };

      request(url);
    });
  }

  /**
   * Download and setup whisper.cpp binary
   * For macOS, we'll compile from source or use homebrew
   */
  static async setupBinary(onProgress) {
    this.ensureDir();

    // On macOS, the easiest approach is to build whisper.cpp
    // For now, we'll create a shell script that uses the system's whisper.cpp
    // or downloads and builds it

    const setupScript = path.join(WHISPER_DIR, 'setup.sh');
    const scriptContent = `#!/bin/bash
set -e
cd "${WHISPER_DIR}"

# Check if already built
if [ -f "whisper-cpp" ]; then
  echo "Already installed"
  exit 0
fi

# Clone if src doesn't exist
if [ ! -d "src" ]; then
  echo "Cloning whisper.cpp..."
  git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git src
fi

echo "Building whisper.cpp with cmake (static linking)..."
cd src
cmake -B build -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_EXAMPLES=ON
cmake --build build --config Release -j4

echo "Copying binary..."
cp build/bin/whisper-cli "${WHISPER_DIR}/whisper-cpp"

echo "Cleaning up..."
cd "${WHISPER_DIR}"
rm -rf src

echo "Done!"
`;

    fs.writeFileSync(setupScript, scriptContent, { mode: 0o755 });

    return new Promise((resolve, reject) => {
      const proc = spawn('bash', [setupScript], {
        cwd: WHISPER_DIR,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let output = '';
      proc.stdout.on('data', (data) => {
        output += data.toString();
        console.log('Whisper setup:', data.toString().trim());
      });
      proc.stderr.on('data', (data) => {
        output += data.toString();
        console.log('Whisper setup:', data.toString().trim());
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Setup failed with code ${code}: ${output}`));
        }
      });

      proc.on('error', reject);
    });
  }

  /**
   * Download the whisper model
   */
  static async downloadModel(onProgress) {
    this.ensureDir();

    if (fs.existsSync(MODEL_PATH)) {
      console.log('Model already exists');
      return;
    }

    console.log('Downloading whisper base model...');
    await this.downloadFile(MODEL_URL, MODEL_PATH, onProgress);
    console.log('Model downloaded successfully');
  }

  /**
   * Full setup - binary and model
   */
  static async setup(onProgress) {
    const steps = { binary: 0.5, model: 0.5 };
    let currentProgress = 0;

    // Setup binary
    if (!fs.existsSync(WHISPER_BINARY)) {
      await this.setupBinary((p) => {
        onProgress?.(p * steps.binary);
      });
      currentProgress = steps.binary;
    } else {
      currentProgress = steps.binary;
    }

    // Download model
    if (!fs.existsSync(MODEL_PATH)) {
      await this.downloadModel((p) => {
        onProgress?.(currentProgress + p * steps.model);
      });
    }

    onProgress?.(1);
    return this.getStatus();
  }

  /**
   * Transcribe an audio file
   * @param {string} audioPath - Path to audio file (wav, mp3, etc.)
   * @param {object} options - Transcription options
   * @returns {Promise<{text: string, segments: Array}>}
   */
  static async transcribe(audioPath, options = {}) {
    if (!this.isReady()) {
      throw new Error('Whisper not ready. Run setup first.');
    }

    const {
      language = 'en',
      wordTimestamps = false,
      outputFormat = 'json',
      suppressNonSpeech = false,
      prompt = null
    } = options;

    // Output file path
    const outputPath = audioPath.replace(/\.[^.]+$/, '');

    const args = [
      '-m', MODEL_PATH,
      '-f', audioPath,
      '-l', language,
      '--output-json',
      '-oj', // Output JSON
      '-of', outputPath
    ];

    if (wordTimestamps) {
      args.push('--max-len', '1'); // Enable word-level timestamps
    }

    if (suppressNonSpeech) {
      args.push('--suppress-nst'); // Suppress [MUSIC], [APPLAUSE] etc. — transcribe vocals instead
    }

    if (prompt) {
      args.push('--prompt', prompt);
    }

    return new Promise((resolve, reject) => {
      console.log('Running whisper:', WHISPER_BINARY, args.join(' '));

      const proc = spawn(WHISPER_BINARY, args, {
        cwd: WHISPER_DIR
      });

      let stderr = '';

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Whisper failed: ${stderr}`));
          return;
        }

        // Read the JSON output
        const jsonPath = outputPath + '.json';
        try {
          const result = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

          // Clean up output file
          fs.unlinkSync(jsonPath);

          // Extract text from segments
          const text = result.transcription
            ?.map(s => s.text)
            .join(' ')
            .trim() || '';

          resolve({
            text,
            segments: result.transcription || []
          });
        } catch (err) {
          reject(new Error(`Failed to read whisper output: ${err.message}`));
        }
      });

      proc.on('error', reject);
    });
  }

  /**
   * Transcribe audio buffer directly
   * Converts buffer to temp wav file, transcribes, cleans up
   */
  static async transcribeBuffer(buffer, mimeType = 'audio/webm', options = {}) {
    if (!this.isReady()) {
      throw new Error('Whisper not ready. Run setup first.');
    }

    const tempDir = path.join(WHISPER_DIR, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const tempId = Date.now() + '-' + Math.random().toString(36).slice(2);
    const inputExt = mimeType.includes('webm') ? 'webm' : 'mp4';
    const inputPath = path.join(tempDir, `input-${tempId}.${inputExt}`);
    const wavPath = path.join(tempDir, `audio-${tempId}.wav`);

    try {
      // Write buffer to temp file
      fs.writeFileSync(inputPath, Buffer.from(buffer));

      // Convert to WAV using ffmpeg (16kHz mono, required by whisper.cpp)
      await new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
          '-i', inputPath,
          '-ar', '16000',
          '-ac', '1',
          '-c:a', 'pcm_s16le',
          '-y',
          wavPath
        ]);

        let stderr = '';
        ffmpeg.stderr.on('data', (d) => stderr += d.toString());

        ffmpeg.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`FFmpeg failed: ${stderr}`));
        });
        ffmpeg.on('error', reject);
      });

      // Transcribe
      const result = await this.transcribe(wavPath, options);

      return result;

    } finally {
      // Clean up temp files
      try { fs.unlinkSync(inputPath); } catch (e) {}
      try { fs.unlinkSync(wavPath); } catch (e) {}
    }
  }
}

module.exports = WhisperService;
