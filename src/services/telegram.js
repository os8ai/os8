/**
 * Telegram Bot API client
 *
 * Stateless HTTP wrapper for Telegram Bot API.
 * Each agent has its own bot token — pass it per-call or create an instance.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://api.telegram.org';

/**
 * Make a Telegram Bot API request
 * @param {string} token - Bot token
 * @param {string} method - API method (e.g. 'sendMessage')
 * @param {object} params - Request parameters
 * @returns {Promise<object>} API response
 */
function apiRequest(token, method, params = {}) {
  return new Promise((resolve, reject) => {
    const url = `${BASE_URL}/bot${token}/${method}`;
    const body = JSON.stringify(params);

    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.ok) {
            resolve(parsed.result);
          } else {
            reject(new Error(`Telegram API error: ${parsed.description || 'Unknown error'} (${parsed.error_code})`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse Telegram response: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Upload a local file via multipart/form-data to Telegram Bot API.
 * Used for sendPhoto/sendDocument when the path is a local file.
 */
function apiUpload(token, method, fileField, filePath, params = {}) {
  return new Promise((resolve, reject) => {
    const url = `${BASE_URL}/bot${token}/${method}`;
    const boundary = '----TelegramUpload' + Date.now();
    const fileName = path.basename(filePath);

    // Build multipart body
    const parts = [];
    for (const [key, val] of Object.entries(params)) {
      if (val == null) continue;
      parts.push(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${val}\r\n`
      );
    }
    const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const fileTail = `\r\n--${boundary}--\r\n`;

    const fileData = fs.readFileSync(filePath);
    const head = Buffer.from(parts.join('') + fileHeader, 'utf8');
    const tail = Buffer.from(fileTail, 'utf8');
    const body = Buffer.concat([head, fileData, tail]);

    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.ok) {
            resolve(parsed.result);
          } else {
            reject(new Error(`Telegram API error: ${parsed.description || 'Unknown error'} (${parsed.error_code})`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse Telegram response: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Check if a string is a local file path (not a URL or Telegram file_id).
 */
function isLocalFile(str) {
  return str.startsWith('/') || str.startsWith('~') || str.startsWith('./');
}

/**
 * Long-poll for updates (used by TelegramWatcher)
 * @param {string} token - Bot token
 * @param {number} offset - Update offset
 * @param {number} timeout - Long-poll timeout in seconds
 * @param {AbortSignal} [signal] - Optional abort signal
 * @returns {Promise<Array>} Array of updates
 */
function getUpdates(token, offset, timeout = 30, signal) {
  return new Promise((resolve, reject) => {
    const url = `${BASE_URL}/bot${token}/getUpdates`;
    const body = JSON.stringify({
      offset,
      timeout,
      allowed_updates: ['message']
    });

    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: (timeout + 10) * 1000 // Socket timeout: long-poll timeout + 10s grace
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.ok) {
            resolve(parsed.result || []);
          } else {
            reject(new Error(`Telegram getUpdates error: ${parsed.description}`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse getUpdates response`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
    });

    req.on('error', (err) => {
      if (err.name === 'AbortError' || signal?.aborted) {
        resolve([]); // Graceful abort
      } else {
        reject(err);
      }
    });

    // Support abort signal
    if (signal) {
      signal.addEventListener('abort', () => {
        req.destroy();
        resolve([]);
      }, { once: true });
    }

    req.write(body);
    req.end();
  });
}

/**
 * Upload a local file via multipart/form-data (no external deps)
 * @param {string} token - Bot token
 * @param {string} method - API method (e.g. 'sendAudio')
 * @param {string} filePath - Local file path
 * @param {string} fileField - Form field name for the file (e.g. 'audio')
 * @param {object} params - Additional text fields (chat_id, caption, etc.)
 * @returns {Promise<object>} API response result
 */
function multipartUpload(token, method, filePath, fileField, params = {}) {
  return new Promise((resolve, reject) => {
    const boundary = `----OS8Boundary${Date.now()}`;
    const fileName = path.basename(filePath);
    const fileStream = fs.readFileSync(filePath);

    // Build multipart body
    const parts = [];

    // Text fields
    for (const [key, value] of Object.entries(params)) {
      parts.push(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${key}"\r\n\r\n` +
        `${value}\r\n`
      );
    }

    // File field
    const fileHeader =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`;
    const fileFooter = `\r\n--${boundary}--\r\n`;

    const headerBuf = Buffer.from(parts.join('') + fileHeader);
    const footerBuf = Buffer.from(fileFooter);
    const body = Buffer.concat([headerBuf, fileStream, footerBuf]);

    const url = `${BASE_URL}/bot${token}/${method}`;
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.ok) {
            resolve(parsed.result);
          } else {
            reject(new Error(`Telegram API error: ${parsed.description || 'Unknown error'} (${parsed.error_code})`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse Telegram response: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const TelegramService = {
  /**
   * Verify bot token and get bot info
   * @param {string} token
   * @returns {Promise<object>} Bot user object
   */
  async getMe(token) {
    return apiRequest(token, 'getMe');
  },

  /**
   * Send a text message
   * @param {string} token - Bot token
   * @param {string} chatId - Target chat ID
   * @param {string} text - Message text
   * @param {object} [options] - Additional options (parse_mode, etc.)
   * @returns {Promise<object>} Sent message
   */
  async send(token, chatId, text, options = {}) {
    // Telegram max message length is 4096 chars
    if (text.length > 4096) {
      // Split into chunks
      const chunks = [];
      for (let i = 0; i < text.length; i += 4096) {
        chunks.push(text.substring(i, i + 4096));
      }
      let lastResult;
      for (const chunk of chunks) {
        lastResult = await apiRequest(token, 'sendMessage', {
          chat_id: chatId,
          text: chunk,
          ...options
        });
        // Small delay between chunks to respect rate limits
        if (chunks.length > 1) {
          await new Promise(r => setTimeout(r, 100));
        }
      }
      return lastResult;
    }

    return apiRequest(token, 'sendMessage', {
      chat_id: chatId,
      text,
      ...options
    });
  },

  /**
   * Send a photo
   * @param {string} token - Bot token
   * @param {string} chatId - Target chat ID
   * @param {string} photoUrl - Photo URL or file_id
   * @param {string} [caption] - Optional caption
   * @returns {Promise<object>} Sent message
   */
  async sendPhoto(token, chatId, photoUrl, caption) {
    if (isLocalFile(photoUrl)) {
      const params = { chat_id: chatId };
      if (caption) params.caption = caption;
      return apiUpload(token, 'sendPhoto', 'photo', photoUrl, params);
    }
    const params = { chat_id: chatId, photo: photoUrl };
    if (caption) params.caption = caption;
    return apiRequest(token, 'sendPhoto', params);
  },

  /**
   * Send a document
   * @param {string} token - Bot token
   * @param {string} chatId - Target chat ID
   * @param {string} documentUrl - Document URL or file_id or local path
   * @param {string} [caption] - Optional caption
   * @returns {Promise<object>} Sent message
   */
  async sendDocument(token, chatId, documentUrl, caption) {
    if (isLocalFile(documentUrl)) {
      const params = { chat_id: chatId };
      if (caption) params.caption = caption;
      return apiUpload(token, 'sendDocument', 'document', documentUrl, params);
    }
    const params = { chat_id: chatId, document: documentUrl };
    if (caption) params.caption = caption;
    return apiRequest(token, 'sendDocument', params);
  },

  /**
   * Download a file from Telegram
   * @param {string} token - Bot token
   * @param {string} fileId - Telegram file ID
   * @param {string} destPath - Local destination path
   * @returns {Promise<string>} Saved file path
   */
  async downloadFile(token, fileId, destPath) {
    // Step 1: Get file path from Telegram
    const fileInfo = await apiRequest(token, 'getFile', { file_id: fileId });
    if (!fileInfo.file_path) {
      throw new Error('No file_path in Telegram response');
    }

    // Step 2: Download the file
    const fileUrl = `${BASE_URL}/file/bot${token}/${fileInfo.file_path}`;

    return new Promise((resolve, reject) => {
      const urlObj = new URL(fileUrl);
      https.get(urlObj, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }

        // Ensure destination directory exists
        const dir = path.dirname(destPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        const file = fs.createWriteStream(destPath);
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve(destPath);
        });
        file.on('error', (err) => {
          fs.unlinkSync(destPath);
          reject(err);
        });
      }).on('error', reject);
    });
  },

  /**
   * Send an audio file (local upload via multipart/form-data)
   * @param {string} token - Bot token
   * @param {string} chatId - Target chat ID
   * @param {string} filePath - Local path to audio file (MP3)
   * @param {string} [caption] - Optional caption
   * @returns {Promise<object>} Sent message
   */
  async sendAudio(token, chatId, filePath, caption) {
    return multipartUpload(token, 'sendAudio', filePath, 'audio', {
      chat_id: chatId,
      ...(caption ? { caption } : {})
    });
  },

  /**
   * Get updates (long-polling) — exposed for TelegramWatcher
   */
  getUpdates
};

module.exports = TelegramService;
