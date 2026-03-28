/**
 * Shared helpers for message handler endpoints.
 * Extracted from message-handler.js — environment preparation and image storage.
 */

const fs = require('fs');
const { compressImageBuffer } = require('../utils/image-compress');
const ConversationService = require('../services/conversation');
const { prepareSpawnEnv } = require('../services/cli-runner');

/**
 * Prepare the shell environment for the agent backend.
 * Thin wrapper around cli-runner's prepareSpawnEnv for backward compatibility.
 */
function prepareAgentEnv(backendId, db, accessMethod) {
  return prepareSpawnEnv(db, backendId || 'claude', accessMethod);
}

// Legacy alias
function prepareClaudeEnv() {
  return prepareAgentEnv('claude');
}

/**
 * Store chat images in the conversation DB (memory-tier compression: 384px, ~15KB)
 * @param {Database} db - SQLite database instance
 * @param {string} appId - Application ID
 * @param {Array} images - Array of image objects with file paths or base64 data
 * @param {object} opts - { imageView, speaker, role, channel }
 * @param {string} opts.imageView - 'chat_user' or 'chat_agent'
 * @param {string} opts.speaker - Speaker name
 * @param {string} opts.role - 'user' or 'assistant'
 * @param {string} opts.channel - 'desktop'
 */
async function storeChatImages(db, appId, images, { imageView, speaker, role, channel }) {
  for (const img of images) {
    try {
      let buffer;
      if (img.filePath) {
        // Read from original file on disk
        if (!fs.existsSync(img.filePath)) continue;
        buffer = fs.readFileSync(img.filePath);
      } else if (img.originalFilePath) {
        // Prefer original file over already-compressed base64
        if (!fs.existsSync(img.originalFilePath)) continue;
        buffer = fs.readFileSync(img.originalFilePath);
      } else if (img.data) {
        // Fallback: decode base64 (may be pre-compressed)
        buffer = Buffer.from(img.data, 'base64');
      } else {
        continue;
      }

      const compressed = await compressImageBuffer(buffer);
      const sizeKB = Math.round(compressed.compressedSize / 1024);
      console.log(`[Chat Image DB] ${img.filename || 'image'}: ${sizeKB} KB (${imageView})`);

      ConversationService.addImageEntry(db, appId, {
        imageData: compressed.data,
        mediaType: compressed.mediaType,
        imageView,
        timestamp: new Date().toISOString(),
        originalFilename: img.filename || null,
        speaker,
        role,
        channel
      });
    } catch (err) {
      console.warn(`Failed to store chat image:`, err.message);
    }
  }
}

module.exports = {
  prepareAgentEnv,
  prepareClaudeEnv,
  storeChatImages
};
