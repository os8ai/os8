/**
 * VideoGenService - AI Video Generation (Image-to-Video)
 *
 * Generates videos from images using fal.ai (Kling proxy).
 * Primary use: camera pan videos for panoramic contact sheets.
 * Follows the ImageGenService pattern (static class, db first param).
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const EnvService = require('./env');

// fal.ai API
const FAL_API_BASE = 'https://queue.fal.run';
const FAL_KLING_MODEL = 'fal-ai/kling-video/v2.1/pro/image-to-video';

// Poll configuration
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_WAIT_MS = 10 * 60 * 1000; // 10 minutes max (fal can be slower)

class VideoGenService {
  /**
   * Check if video generation providers are available
   * @param {Database} db - SQLite database
   * @returns {{ ready: boolean, providers: object, defaultProvider: string }}
   */
  static getStatus(db) {
    const falKey = EnvService.get(db, 'FAL_API_KEY');
    const hasFal = !!(falKey?.value);

    let defaultProvider = null;
    if (hasFal) defaultProvider = 'fal';

    return {
      ready: hasFal,
      providers: {
        fal: {
          available: hasFal,
          model: FAL_KLING_MODEL,
          ...(hasFal ? {} : { error: 'FAL_API_KEY not configured' })
        }
      },
      defaultProvider
    };
  }

  /**
   * Generate a video from an image with camera pan
   * @param {Database} db - SQLite database
   * @param {string} imagePath - Path to source image
   * @param {object} options - Generation options
   * @param {string} options.direction - 'left' or 'right'
   * @param {string} options.provider - 'fal' or 'auto'
   * @param {string} options.duration - Video duration: '5' or '10' (default: '5')
   * @param {string} options.aspectRatio - Aspect ratio (default: '1:1')
   * @returns {Promise<{ videoPath: string, provider: string, requestId: string }>}
   */
  static async generate(db, imagePath, options = {}) {
    if (!imagePath || !fs.existsSync(imagePath)) {
      throw new Error(`Source image not found: ${imagePath}`);
    }

    const status = this.getStatus(db);
    if (!status.ready) {
      throw new Error('No video generation providers configured. Add FAL_API_KEY in Settings.');
    }

    return this.generateWithFal(db, imagePath, options);
  }

  /**
   * Generate video with fal.ai (Kling proxy)
   * Uses queue-based async API: submit → poll → download
   * @param {Database} db - SQLite database
   * @param {string} imagePath - Path to source image
   * @param {object} options - Generation options
   * @returns {Promise<{ videoPath: string, provider: string, requestId: string }>}
   */
  static async generateWithFal(db, imagePath, options = {}) {
    const apiKey = EnvService.get(db, 'FAL_API_KEY').value;
    const direction = options.direction || 'right';
    const duration = options.duration || '5';
    const aspectRatio = options.aspectRatio || '1:1';

    // Read image and create data URI for fal.ai
    const imageBuffer = fs.readFileSync(imagePath);
    const ext = path.extname(imagePath).toLowerCase();
    const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
    const imageBase64 = imageBuffer.toString('base64');
    const imageDataUri = `data:${mimeType};base64,${imageBase64}`;

    // Build prompt for camera direction
    const panDirection = direction === 'left' ? 'left' : 'right';
    const prompt = `Smooth slow camera pan to the ${panDirection}, maintaining scene consistency and lighting`;

    console.log(`VideoGen: Submitting fal.ai Kling image2video - direction: ${direction}, duration: ${duration}s, aspect: ${aspectRatio}`);

    // Submit to fal.ai queue
    const response = await fetch(`${FAL_API_BASE}/${FAL_KLING_MODEL}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Key ${apiKey}`
      },
      body: JSON.stringify({
        prompt,
        image_url: imageDataUri,
        duration,
        aspect_ratio: aspectRatio
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage;
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.detail || errorJson.message || errorJson.error || errorText;
      } catch {
        errorMessage = errorText;
      }

      if (response.status === 422) {
        throw new Error(`fal.ai validation error: ${errorMessage}`);
      }
      if (response.status === 429) {
        throw new Error('Rate limited by fal.ai. Try again later.');
      }
      throw new Error(`fal.ai API error (${response.status}): ${errorMessage}`);
    }

    const result = await response.json();

    // fal.ai queue returns request_id plus status_url/response_url for polling
    const requestId = result.request_id;
    if (!requestId) {
      // Synchronous response — video is already ready
      if (result.video?.url) {
        return this.downloadVideo(result.video.url, 'sync', 'fal');
      }
      throw new Error('fal.ai did not return a request_id or video');
    }

    // Use URLs from the response (fal.ai returns different base paths for polling vs submit)
    const statusUrl = result.status_url;
    const responseUrl = result.response_url;
    console.log(`VideoGen: fal.ai request submitted: ${requestId}`);

    // Poll for completion
    const videoUrl = await this.pollFalTask(apiKey, statusUrl, responseUrl);

    // Download video
    return this.downloadVideo(videoUrl, requestId, 'fal');
  }

  /**
   * Poll a fal.ai request until completion
   * @param {string} apiKey - fal.ai API key
   * @param {string} statusUrl - fal.ai status URL (from submit response)
   * @param {string} responseUrl - fal.ai response URL (from submit response)
   * @returns {Promise<string>} Video download URL
   */
  static async pollFalTask(apiKey, statusUrl, responseUrl) {
    const startTime = Date.now();

    while (Date.now() - startTime < MAX_POLL_WAIT_MS) {
      const response = await fetch(statusUrl, {
        headers: {
          'Authorization': `Key ${apiKey}`
        }
      });

      const responseText = await response.text();
      let result;
      try {
        result = JSON.parse(responseText);
      } catch {
        console.log(`VideoGen: non-JSON poll response (${response.status}): ${responseText.substring(0, 200)}`);
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
        continue;
      }

      const status = result.status;
      const elapsed = Math.round((Date.now() - startTime) / 1000);

      if (status === 'COMPLETED') {
        // Fetch the actual result using response URL from submit
        const resultResp = await fetch(responseUrl, {
          headers: { 'Authorization': `Key ${apiKey}` }
        });

        if (!resultResp.ok) {
          throw new Error(`fal.ai result fetch error: ${resultResp.status}`);
        }

        const resultData = await resultResp.json();
        const videoUrl = resultData.video?.url;
        if (!videoUrl) {
          throw new Error('fal.ai completed but returned no video URL');
        }

        console.log(`VideoGen: fal.ai request completed in ${elapsed}s`);
        return videoUrl;
      }

      if (status === 'FAILED') {
        const error = result.error || 'Unknown error';
        throw new Error(`fal.ai video generation failed: ${error}`);
      }

      // Still processing (IN_QUEUE or IN_PROGRESS)
      const queuePos = result.queue_position != null ? ` (queue: ${result.queue_position})` : '';
      process.stdout.write(`  VideoGen: ${status}${queuePos} (${elapsed}s)\r`);
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new Error(`fal.ai request timed out after ${MAX_POLL_WAIT_MS / 1000}s`);
  }

  /**
   * Download a video from URL to temp directory
   * @param {string} videoUrl - URL to download
   * @param {string} id - ID for filename
   * @param {string} provider - Provider name
   * @returns {Promise<{ videoPath: string, provider: string, requestId: string }>}
   */
  static async downloadVideo(videoUrl, id, provider) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videogen-'));
    const videoPath = path.join(tempDir, `${id}.mp4`);

    console.log(`VideoGen: Downloading video...`);
    const videoResponse = await fetch(videoUrl);
    if (!videoResponse.ok) {
      throw new Error(`Failed to download video: ${videoResponse.status}`);
    }

    const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
    fs.writeFileSync(videoPath, videoBuffer);
    const sizeMB = (videoBuffer.length / 1024 / 1024).toFixed(2);
    console.log(`VideoGen: Downloaded ${sizeMB}MB video to ${videoPath}`);

    return {
      videoPath,
      provider,
      requestId: id
    };
  }
}

module.exports = VideoGenService;
