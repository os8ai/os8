/**
 * Image loading, compression, and context formatting for identity context.
 * Handles present-moment portraits, owner reference photos, and timeline images.
 *
 * @see identity-context.js for text context builders and orchestration
 */

const fs = require('fs');
const path = require('path');
const { compressForClaude, compressForPresentMoment, compressImageBuffer, shouldCompress } = require('../utils/image-compress');
const AgentService = require('../services/agent');

// Cached owner reference images keyed by appPath (different agents may have different owner images)
const cachedOwnerImages = new Map();

/**
 * Detect actual image media type from file header bytes
 * @param {Buffer} buffer - First few bytes of the file
 * @returns {string} Media type (image/png or image/jpeg)
 */
function detectImageMediaType(buffer) {
  // PNG magic bytes: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return 'image/png';
  }
  // JPEG magic bytes: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return 'image/jpeg';
  }
  // Default to png if unknown
  return 'image/png';
}

/**
 * Read an image file and return base64-encoded data with media type
 * @param {string} filePath - Path to the image file
 * @returns {{ data: string, mediaType: string }|null} Base64 data and media type, or null if not found
 */
function readImageAsBase64(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }

  try {
    const buffer = fs.readFileSync(filePath);
    const mediaType = detectImageMediaType(buffer);
    const data = buffer.toString('base64');
    return { data, mediaType };
  } catch (err) {
    console.warn('Failed to read image:', filePath, err.message);
    return null;
  }
}

/**
 * Read an image file, compress if large, and return base64-encoded data
 * Uses chat-quality compression (1024px, 85% JPEG) for images > 100KB
 * @param {string} filePath - Path to the image file
 * @returns {Promise<{ data: string, mediaType: string }|null>} Base64 data and media type, or null if not found
 */
async function readImageAsBase64Compressed(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }

  try {
    const buffer = fs.readFileSync(filePath);
    const originalSizeKB = Math.round(buffer.length / 1024);

    if (shouldCompress(buffer.length)) {
      const result = await compressForClaude(buffer);
      const compressedSizeKB = Math.round(result.compressedSize / 1024);
      console.log(`[Image Compress] ${path.basename(filePath)}: ${originalSizeKB} KB → ${compressedSizeKB} KB`);
      return { data: result.data, mediaType: result.mediaType };
    }

    // Small image, return as-is
    const mediaType = detectImageMediaType(buffer);
    const data = buffer.toString('base64');
    console.log(`[Image Compress] ${path.basename(filePath)}: ${originalSizeKB} KB (no compression needed)`);
    return { data, mediaType };
  } catch (err) {
    console.warn('Failed to read/compress image:', filePath, err.message);
    return null;
  }
}

/**
 * Find the most recent image files in current-image folder
 * @param {string} appId - The agent ID
 * @param {string} [agentAppId] - The parent app ID (if different from appId)
 * @returns {{ thirdPerson: string|null }} Path to most recent portrait image
 */
function findCurrentImages(appId, agentAppId) {
  const { agentBlobDir } = agentAppId ? AgentService.getPaths(agentAppId, appId) : AgentService.getPaths(appId);
  const imageDir = path.join(agentBlobDir, 'current-image');

  if (!fs.existsSync(imageDir)) {
    return { thirdPerson: null };
  }

  const files = fs.readdirSync(imageDir);

  // Match any image starting with yyyy-mm-dd-hhmm- date prefix
  const datePattern = /^\d{4}-\d{2}-\d{2}-\d{4}-.+\.(png|jpe?g)$/i;

  const thirdPersonFiles = files
    .filter(f => datePattern.test(f))
    .sort()
    .reverse();

  return {
    thirdPerson: thirdPersonFiles[0] ? path.join(imageDir, thirdPersonFiles[0]) : null
  };
}

/**
 * Load present moment images from original files on disk at high fidelity (1024px, 85%)
 * Falls back to DB images at memory tier if originals aren't available
 * @param {string} appId - The assistant app ID
 * @param {string} [agentAppId] - The parent app ID
 * @returns {Promise<{thirdPerson: {data, mediaType}|null}>}
 */
async function loadPresentMomentImages(appId, agentAppId) {
  const images = findCurrentImages(appId, agentAppId);
  const result = { thirdPerson: null };

  if (images.thirdPerson) {
    try {
      const buffer = fs.readFileSync(images.thirdPerson);
      const compressed = await compressForPresentMoment(buffer);
      result.thirdPerson = { data: compressed.data, mediaType: compressed.mediaType };
      console.log(`[PresentMoment] thirdPerson: ${Math.round(buffer.length / 1024)}KB → ${Math.round(compressed.compressedSize / 1024)}KB (1024px)`);
    } catch (err) {
      console.warn('[PresentMoment] Failed to load third person from disk:', err.message);
    }
  }

  return result;
}

/**
 * Load and compress the owner's reference image (cached after first load per appPath).
 * Looks for docs/{ownerSlug}-identity/*-reference.* or *reference.* in the app directory.
 * @param {string} appPath - Path to the agent directory
 * @param {string} [ownerName] - Owner's name for dynamic path resolution
 * @param {string} [appDir] - Path to the parent app directory (for shared owner image)
 * @returns {Promise<{data: string, mediaType: string}|null>} Compressed image data or null
 */
async function loadOwnerImage(appPath, ownerName, appDir) {
  if (cachedOwnerImages.has(appPath)) {
    return cachedOwnerImages.get(appPath);
  }

  let imagePath = null;

  // Try global user image first (~/os8/config/user-image.*)
  const { CONFIG_DIR: configDir } = require('../config');
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
    const globalPath = path.join(configDir, `user-image${ext}`);
    if (fs.existsSync(globalPath)) {
      imagePath = globalPath;
      break;
    }
  }

  // Try app-level shared owner image (docs/owner/)
  if (!imagePath && appDir) {
    const sharedOwnerDir = path.join(appDir, 'docs', 'owner');
    if (fs.existsSync(sharedOwnerDir)) {
      const files = fs.readdirSync(sharedOwnerDir);
      const refFile = files.find(f => /reference\.(png|jpg|jpeg)$/i.test(f));
      if (refFile) {
        imagePath = path.join(sharedOwnerDir, refFile);
      }
    }
  }

  // Fallback: agent-level dynamic path based on ownerName
  if (!imagePath && ownerName) {
    const ownerSlug = ownerName.toLowerCase().replace(/\s+/g, '-');
    const identityDir = path.join(appPath, 'docs', `${ownerSlug}-identity`);
    if (fs.existsSync(identityDir)) {
      const files = fs.readdirSync(identityDir);
      const refFile = files.find(f => /reference\.(png|jpg|jpeg)$/i.test(f));
      if (refFile) {
        imagePath = path.join(identityDir, refFile);
      }
    }
  }

  if (!imagePath) {
    cachedOwnerImages.set(appPath, null);
    return null;
  }

  try {
    const buffer = fs.readFileSync(imagePath);
    const result = await compressImageBuffer(buffer);
    const cached = { data: result.data, mediaType: result.mediaType };
    cachedOwnerImages.set(appPath, cached);
    const sizeKB = Math.round(result.compressedSize / 1024);
    console.log(`[OwnerImage] Loaded and compressed ${path.basename(imagePath)}: ${Math.round(buffer.length / 1024)}KB → ${sizeKB}KB`);
    return cached;
  } catch (err) {
    console.warn('[OwnerImage] Failed to load:', err.message);
    cachedOwnerImages.set(appPath, null);
    return null;
  }
}

/**
 * Build the current images context
 * @param {string} appId - The assistant app ID
 * @returns {string} Image context with file paths or empty string
 */
function buildCurrentImagesContext(appId) {
  const images = findCurrentImages(appId);

  if (!images.thirdPerson) {
    return '';
  }

  let context = '<current_images description="Your current visual appearance (image attached below)">\n';
  context += 'Image 1: Current image of you (third person view)\n';
  context += '</current_images>\n\n';

  return context;
}

/**
 * Build the current images context from DB entries
 * @param {object} currentImages - { thirdPerson: entry|null }
 * @returns {string} Image context text
 */
function buildCurrentImagesContextFromDB(currentImages) {
  if (!currentImages.thirdPerson) {
    return '';
  }

  const { formatTimeFromISO } = require('./identity-context');
  let context = '<current_images description="Your current visual appearance (image attached)">\n';
  const ts = formatTimeFromISO(currentImages.thirdPerson.timestamp);
  context += `Image 1: Current image of you (third person view) - ${ts}\n`;
  context += '</current_images>\n\n';

  return context;
}

/**
 * Build the current images reminder for end of context
 * @param {object} currentImages - { thirdPerson: entry|null }
 * @returns {string} Reminder context text
 */
function buildCurrentImagesReminder(currentImages) {
  if (!currentImages.thirdPerson) {
    return '';
  }

  const { formatTimeFromISO } = require('./identity-context');
  let context = '\n<current_visual_reminder description="Your current appearance (for reference before responding)">\n';
  const ts = formatTimeFromISO(currentImages.thirdPerson.timestamp);
  context += `[Third person view - ${ts}] attached above\n`;
  context += '</current_visual_reminder>';

  return context;
}

/**
 * Load another agent's current image at memory tier (384px).
 * Used for group thread participant images.
 * @param {string} agentId - The participant agent ID
 * @param {object} db - SQLite database
 * @returns {Promise<{data: string, mediaType: string}|null>}
 */
async function loadParticipantImage(agentId, db) {
  const agent = db ? AgentService.getById(db, agentId) : null;
  const agentAppId = agent?.app_id || null;
  const images = findCurrentImages(agentId, agentAppId);

  if (images.thirdPerson) {
    try {
      const buffer = fs.readFileSync(images.thirdPerson);
      const compressed = await compressImageBuffer(buffer);
      return { data: compressed.data, mediaType: compressed.mediaType };
    } catch (err) {
      console.warn(`[ParticipantImage] Failed to load from disk for ${agentId}:`, err.message);
    }
  }

  // Fallback to DB
  if (db) {
    const ConversationService = require('../services/conversation');
    const dbImages = ConversationService.getCurrentImages(db, agentId);
    if (dbImages.thirdPerson?.image_data) {
      const buffer = Buffer.from(dbImages.thirdPerson.image_data, 'base64');
      const mediaType = detectImageMediaType(buffer);
      return { data: dbImages.thirdPerson.image_data, mediaType };
    }
  }

  return null;
}

module.exports = {
  detectImageMediaType,
  readImageAsBase64,
  readImageAsBase64Compressed,
  findCurrentImages,
  loadPresentMomentImages,
  loadOwnerImage,
  loadParticipantImage,
  buildCurrentImagesContext,
  buildCurrentImagesContextFromDB,
  buildCurrentImagesReminder,
};
