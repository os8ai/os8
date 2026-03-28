/**
 * Image compression utilities for memory storage
 * Compresses images before storing in database to reduce payload size
 */

const sharp = require('sharp');

// Memory storage: 384px keeps ~15KB per image for larger timeline capacity
const MAX_DIMENSION = 384;
// JPEG quality (0-100) - 70 balances size vs quality at smaller dimensions
const JPEG_QUALITY = 70;

// Chat attachments: 768px at 75% hits ~75KB while preserving enough detail for Claude
const CHAT_MAX_DIMENSION = 768;
const CHAT_JPEG_QUALITY = 75;

// Present moment: 1024px at 85% for high-fidelity current state images (~50-80KB)
const PRESENT_MAX_DIMENSION = 1024;
const PRESENT_JPEG_QUALITY = 85;

/**
 * Compress an image buffer for storage
 * - Resizes to max 384px (maintaining aspect ratio)
 * - Converts to JPEG with 70% quality
 * - Returns base64-encoded result (~12KB per image)
 *
 * @param {Buffer} inputBuffer - Raw image buffer (PNG or JPEG)
 * @returns {Promise<{data: string, mediaType: string, originalSize: number, compressedSize: number}>}
 */
async function compressImageBuffer(inputBuffer) {
  const originalSize = inputBuffer.length;

  const compressedBuffer = await sharp(inputBuffer)
    .resize(MAX_DIMENSION, MAX_DIMENSION, {
      fit: 'inside',           // Maintain aspect ratio, fit within bounds
      withoutEnlargement: true // Don't upscale small images
    })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();

  const compressedSize = compressedBuffer.length;
  const data = compressedBuffer.toString('base64');

  return {
    data,
    mediaType: 'image/jpeg',
    originalSize,
    compressedSize
  };
}

/**
 * Compress a base64-encoded image
 *
 * @param {string} base64Data - Base64-encoded image data
 * @returns {Promise<{data: string, mediaType: string, originalSize: number, compressedSize: number}>}
 */
async function compressBase64Image(base64Data) {
  const inputBuffer = Buffer.from(base64Data, 'base64');
  return compressImageBuffer(inputBuffer);
}

/**
 * Compress an image buffer for Claude chat attachments
 * Higher quality than memory storage - preserves detail for analysis
 * - Resizes to max 768px (maintaining aspect ratio)
 * - Converts to JPEG with 75% quality
 * - Expected output: ~75KB per image
 *
 * @param {Buffer} inputBuffer - Raw image buffer (PNG or JPEG)
 * @returns {Promise<{data: string, mediaType: string, originalSize: number, compressedSize: number}>}
 */
async function compressForClaude(inputBuffer) {
  const originalSize = inputBuffer.length;

  const compressedBuffer = await sharp(inputBuffer)
    .resize(CHAT_MAX_DIMENSION, CHAT_MAX_DIMENSION, {
      fit: 'inside',
      withoutEnlargement: true
    })
    .jpeg({ quality: CHAT_JPEG_QUALITY })
    .toBuffer();

  const compressedSize = compressedBuffer.length;
  const data = compressedBuffer.toString('base64');

  return {
    data,
    mediaType: 'image/jpeg',
    originalSize,
    compressedSize
  };
}

/**
 * Compress an image buffer for present moment context
 * Highest quality tier — these are the agent's "right now" images
 * - Resizes to max 1024px (maintaining aspect ratio)
 * - Converts to JPEG with 85% quality
 * - Expected output: ~50-80KB per image
 *
 * @param {Buffer} inputBuffer - Raw image buffer (PNG or JPEG)
 * @returns {Promise<{data: string, mediaType: string, originalSize: number, compressedSize: number}>}
 */
async function compressForPresentMoment(inputBuffer) {
  const originalSize = inputBuffer.length;

  const compressedBuffer = await sharp(inputBuffer)
    .resize(PRESENT_MAX_DIMENSION, PRESENT_MAX_DIMENSION, {
      fit: 'inside',
      withoutEnlargement: true
    })
    .jpeg({ quality: PRESENT_JPEG_QUALITY })
    .toBuffer();

  const compressedSize = compressedBuffer.length;
  const data = compressedBuffer.toString('base64');

  return {
    data,
    mediaType: 'image/jpeg',
    originalSize,
    compressedSize
  };
}

/**
 * Check if an image should be compressed based on size
 * Skip compression for already-small images
 *
 * @param {number} sizeBytes - Image size in bytes
 * @returns {boolean} True if image should be compressed
 */
function shouldCompress(sizeBytes) {
  // Compress images larger than 100KB
  return sizeBytes > 100 * 1024;
}

module.exports = {
  compressImageBuffer,
  compressBase64Image,
  compressForClaude,
  compressForPresentMoment,
  shouldCompress,
  MAX_DIMENSION,
  JPEG_QUALITY,
  CHAT_MAX_DIMENSION,
  CHAT_JPEG_QUALITY,
  PRESENT_MAX_DIMENSION,
  PRESENT_JPEG_QUALITY
};
