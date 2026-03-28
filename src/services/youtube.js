/**
 * YouTubeService - YouTube video info and transcript extraction
 *
 * Uses yt-dlp to fetch video metadata and captions/subtitles
 * without downloading the actual video.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

class YouTubeService {
  /**
   * Check if yt-dlp is available
   */
  static async hasYtDlp() {
    return new Promise((resolve) => {
      const proc = spawn('yt-dlp', ['--version']);
      let output = '';
      proc.stdout.on('data', (d) => { output += d.toString(); });
      proc.on('close', (code) => resolve(code === 0 ? output.trim() : false));
      proc.on('error', () => resolve(false));
    });
  }

  /**
   * Get service status
   */
  static async getStatus() {
    const version = await this.hasYtDlp();
    return {
      ready: !!version,
      hasYtDlp: !!version,
      version: version || null
    };
  }

  /**
   * Validate and normalize a YouTube URL
   */
  static validateUrl(url) {
    if (!url || typeof url !== 'string') return false;
    // Accept youtube.com, youtu.be, and m.youtube.com URLs
    return /^https?:\/\/(www\.)?(youtube\.com|youtu\.be|m\.youtube\.com)\/.+/.test(url);
  }

  /**
   * Get video metadata (title, description, channel, duration, etc.)
   * @param {string} url - YouTube video URL
   * @returns {Promise<object>} Video metadata
   */
  static async getInfo(url) {
    return new Promise((resolve, reject) => {
      const proc = spawn('yt-dlp', [
        '--dump-json',
        '--no-download',
        '--no-warnings',
        url
      ]);

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        if (code !== 0) {
          return reject(new Error(`yt-dlp failed: ${stderr.trim().slice(-300) || 'Unknown error'}`));
        }

        try {
          const raw = JSON.parse(stdout);
          resolve({
            id: raw.id,
            title: raw.title,
            description: raw.description,
            channel: raw.channel || raw.uploader,
            channelUrl: raw.channel_url || raw.uploader_url,
            duration: raw.duration,
            durationString: raw.duration_string,
            viewCount: raw.view_count,
            likeCount: raw.like_count,
            uploadDate: raw.upload_date,
            thumbnail: raw.thumbnail,
            tags: raw.tags || [],
            categories: raw.categories || [],
            url: raw.webpage_url
          });
        } catch (e) {
          reject(new Error(`Failed to parse yt-dlp output: ${e.message}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`yt-dlp not found or failed to start: ${err.message}`));
      });
    });
  }

  /**
   * Get video transcript/captions
   * @param {string} url - YouTube video URL
   * @param {object} options
   * @param {string} options.lang - Language code (default: "en")
   * @returns {Promise<object>} Transcript with segments
   */
  static async getTranscript(url, options = {}) {
    const { lang = 'en' } = options;
    const tempDir = os.tmpdir();
    const tempId = Date.now() + '-' + Math.random().toString(36).slice(2);
    const tempBase = path.join(tempDir, `yt-subs-${tempId}`);

    try {
      // Download subtitles to temp file
      await new Promise((resolve, reject) => {
        const proc = spawn('yt-dlp', [
          '--write-sub',
          '--write-auto-sub',
          '--sub-lang', lang,
          '--sub-format', 'json3',
          '--skip-download',
          '--no-warnings',
          '-o', tempBase,
          url
        ]);

        let stderr = '';
        proc.stderr.on('data', (data) => { stderr += data.toString(); });

        proc.on('close', (code) => {
          if (code !== 0) {
            return reject(new Error(`yt-dlp subtitle extraction failed: ${stderr.trim().slice(-300) || 'Unknown error'}`));
          }
          resolve();
        });

        proc.on('error', (err) => {
          reject(new Error(`yt-dlp not found or failed to start: ${err.message}`));
        });
      });

      // Find the subtitle file (yt-dlp adds .LANG.json3 suffix)
      const dir = path.dirname(tempBase);
      const base = path.basename(tempBase);
      const files = fs.readdirSync(dir).filter(f => f.startsWith(base) && f.endsWith('.json3'));

      if (files.length === 0) {
        throw new Error(`No captions available for this video in language: ${lang}`);
      }

      const subFile = path.join(dir, files[0]);
      const raw = JSON.parse(fs.readFileSync(subFile, 'utf-8'));

      // Parse json3 format into segments
      const events = raw.events || [];
      const segments = [];
      let fullText = '';

      for (const event of events) {
        if (!event.segs) continue;
        const text = event.segs.map(s => s.utf8 || '').join('').trim();
        if (!text || text === '\n') continue;

        const startMs = event.tStartMs || 0;
        const durationMs = event.dDurationMs || 0;

        segments.push({
          start: startMs / 1000,
          end: (startMs + durationMs) / 1000,
          text
        });

        fullText += (fullText ? ' ' : '') + text;
      }

      // Clean up temp files
      for (const f of files) {
        try { fs.unlinkSync(path.join(dir, f)); } catch {}
      }

      return {
        text: fullText,
        segments,
        language: lang,
        source: 'youtube-captions'
      };

    } catch (err) {
      // Clean up any temp files on error
      const dir = path.dirname(tempBase);
      const base = path.basename(tempBase);
      try {
        const files = fs.readdirSync(dir).filter(f => f.startsWith(base));
        for (const f of files) {
          try { fs.unlinkSync(path.join(dir, f)); } catch {}
        }
      } catch {}

      throw err;
    }
  }
}

module.exports = YouTubeService;
