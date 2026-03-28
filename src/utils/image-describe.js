/**
 * Image Description Service
 *
 * Generates text descriptions of images using Gemini 2.5 Flash vision API.
 * Used by backends that don't support image inputs (e.g., Grok) to provide
 * the agent with visual context as text instead of base64 images.
 */

const crypto = require('crypto');
const EnvService = require('../services/env');

// In-memory cache: hash → { description, timestamp }
const descriptionCache = new Map();

// Cache TTL: 30 minutes for present-moment images (they change periodically)
const CACHE_TTL_MS = 30 * 60 * 1000;

// Gemini vision model (fast, free tier, good vision)
const VISION_MODEL = 'gemini-2.5-flash';

// Per-image-type prompts
const PROMPTS = {
  portrait: 'Describe this person\'s appearance in 2-3 sentences: clothing, hair, pose, expression, and setting. Be specific about colors and details.',
  pov: 'Describe this first-person view in 2-3 sentences: what objects, furniture, and surfaces are visible, the lighting, and the spatial layout.',
  panorama: 'This is a 3x3 contact sheet showing a panoramic sweep from left to right. Describe what\'s visible in each row: top row (left periphery), middle row (center/ahead), bottom row (right periphery). 3-4 sentences total.',
  owner: 'Describe this person\'s appearance briefly in 1-2 sentences.',
  timeline: 'Describe this image briefly in 1 sentence.'
};

/**
 * Hash an image buffer for cache keying
 * @param {string} base64Data - Base64-encoded image data
 * @returns {string} MD5 hash
 */
function hashImage(base64Data) {
  return crypto.createHash('md5').update(base64Data).digest('hex');
}

/**
 * Call Gemini vision API to describe an image
 * @param {string} apiKey - Google API key
 * @param {string} base64Data - Base64-encoded image data
 * @param {string} mediaType - MIME type (image/jpeg, image/png)
 * @param {string} prompt - Description prompt
 * @returns {Promise<string>} Text description
 */
async function callGeminiVision(apiKey, base64Data, mediaType, prompt) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${VISION_MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType: mediaType,
                data: base64Data
              }
            }
          ]
        }]
      })
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini vision API error (${response.status}): ${errorText.substring(0, 200)}`);
  }

  const result = await response.json();
  const candidates = result.candidates || [];
  for (const candidate of candidates) {
    const parts = candidate.content?.parts || [];
    for (const part of parts) {
      if (part.text) {
        return part.text.trim();
      }
    }
  }

  return '(no description available)';
}

/**
 * Describe a single image, with caching
 * @param {string} apiKey - Google API key
 * @param {string} base64Data - Base64-encoded image data
 * @param {string} mediaType - MIME type
 * @param {string} label - Image type key (portrait, pov, panorama, owner, timeline)
 * @returns {Promise<string>} Text description
 */
async function describeImage(apiKey, base64Data, mediaType, label) {
  const hash = hashImage(base64Data);
  const cacheKey = `${label}:${hash}`;

  // Check cache
  const cached = descriptionCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
    console.log(`[ImageDescribe] Cache hit: ${label}`);
    return cached.description;
  }

  const prompt = PROMPTS[label] || PROMPTS.timeline;

  try {
    const description = await callGeminiVision(apiKey, base64Data, mediaType, prompt);
    descriptionCache.set(cacheKey, { description, timestamp: Date.now() });
    console.log(`[ImageDescribe] Described ${label}: ${description.substring(0, 80)}...`);
    return description;
  } catch (err) {
    console.warn(`[ImageDescribe] Failed to describe ${label}:`, err.message);
    return null;
  }
}

/**
 * Describe all images in a context set, returning text descriptions
 * @param {object} db - SQLite database (for reading GOOGLE_API_KEY)
 * @param {object} imageSet - Same structure as calculateContextBudgets output
 * @param {object} imageSet.presentMomentImageData - { thirdPerson, pov } with { data, mediaType }
 * @param {object|null} imageSet.panoramaData - { contactSheet: { data, mediaType } }
 * @param {object|null} imageSet.ownerImage - { data, mediaType }
 * @param {Array} imageSet.timelineImages - [{ data, mediaType, timestamp, imageView }]
 * @param {object} names - { ownerName, assistantName }
 * @returns {Promise<object>} { portrait, pov, panorama, owner, timeline: [{description, timestamp, imageView}] }
 */
async function describeImagesForContext(db, imageSet, names = {}) {
  const apiKeyRecord = EnvService.get(db, 'GOOGLE_API_KEY');
  if (!apiKeyRecord?.value) {
    console.warn('[ImageDescribe] No GOOGLE_API_KEY configured, skipping image descriptions');
    return null;
  }
  const apiKey = apiKeyRecord.value;

  const { presentMomentImageData = {}, panoramaData, ownerImage, participantImages = [], timelineImages = [] } = imageSet;
  const result = {
    portrait: null,
    pov: null,
    panorama: null,
    owner: null,
    participants: [],
    timeline: []
  };

  // Describe images in parallel (present moment + panorama + owner)
  const promises = [];

  if (presentMomentImageData.thirdPerson?.data) {
    promises.push(
      describeImage(apiKey, presentMomentImageData.thirdPerson.data, presentMomentImageData.thirdPerson.mediaType, 'portrait')
        .then(desc => { result.portrait = desc; })
    );
  }

  if (presentMomentImageData.pov?.data) {
    promises.push(
      describeImage(apiKey, presentMomentImageData.pov.data, presentMomentImageData.pov.mediaType, 'pov')
        .then(desc => { result.pov = desc; })
    );
  }

  if (panoramaData?.contactSheet?.data) {
    promises.push(
      describeImage(apiKey, panoramaData.contactSheet.data, panoramaData.contactSheet.mediaType, 'panorama')
        .then(desc => { result.panorama = desc; })
    );
  }

  if (ownerImage?.data) {
    promises.push(
      describeImage(apiKey, ownerImage.data, ownerImage.mediaType, 'owner')
        .then(desc => { result.owner = desc; })
    );
  }

  // Wait for non-timeline images first
  await Promise.all(promises);

  // Describe participant images (sequentially to avoid rate limits)
  for (const p of participantImages) {
    if (p.data) {
      const desc = await describeImage(apiKey, p.data, p.mediaType, 'owner');
      if (desc) {
        result.participants.push({ name: p.agentName, description: desc });
      }
    }
  }

  // Describe timeline images (sequentially to avoid rate limits)
  for (const img of timelineImages) {
    if (img.data) {
      const desc = await describeImage(apiKey, img.data, img.mediaType, 'timeline');
      result.timeline.push({
        description: desc,
        timestamp: img.timestamp,
        imageView: img.imageView
      });
    }
  }

  const totalDescribed = [result.portrait, result.pov, result.panorama, result.owner]
    .filter(Boolean).length + result.participants.length + result.timeline.length;
  console.log(`[ImageDescribe] Generated ${totalDescribed} descriptions`);

  return result;
}

/**
 * Build text context from image descriptions, matching the ordering of buildStreamJsonMessage
 * @param {object} descriptions - Output of describeImagesForContext
 * @param {object} names - { ownerName, assistantName }
 * @returns {string} Formatted text context with image descriptions
 */
function buildImageDescriptionsContext(descriptions, names = {}) {
  if (!descriptions) return '';

  const { assistantName = '', ownerName = '' } = names;
  let context = '';

  if (descriptions.portrait) {
    const nameLabel = assistantName ? `, ${assistantName}` : '';
    context += `[Image: Third-person portrait of you${nameLabel}]\n${descriptions.portrait}\n\n`;
  }

  if (descriptions.pov) {
    context += `[Image: Your current POV — what you see right now]\n${descriptions.pov}\n\n`;
  }

  if (descriptions.panorama) {
    context += `[Image: Panorama — your peripheral field of view (3x3 contact sheet)]\n${descriptions.panorama}\n\n`;
  }

  if (descriptions.owner) {
    const ownerLabel = ownerName || 'your owner';
    context += `[Image: ${ownerLabel}'s reference photo]\n${descriptions.owner}\n\n`;
  }

  if (descriptions.participants?.length > 0) {
    for (const p of descriptions.participants) {
      context += `[Image: ${p.name}'s current appearance]\n${p.description}\n\n`;
    }
  }

  return context;
}

/**
 * Build timeline image descriptions for interleaving with conversation history
 * @param {Array} timelineDescs - [{description, timestamp, imageView}]
 * @param {string} ownerName - Owner's name for labels
 * @returns {Array} [{text, timestamp}] for interleaving
 */
function buildTimelineDescriptionItems(timelineDescs, ownerName = '') {
  const fromLabel = ownerName || 'user';
  return timelineDescs.filter(d => d.description).map(d => {
    const ts = d.timestamp ? new Date(d.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
    const viewLabel = {
      'pov': 'Your POV',
      'chat_user': `Image from ${fromLabel}`,
      'chat_agent': 'Image you sent',
      'telegram_user': `Image from ${fromLabel} (Telegram)`,
      'third_person': 'Image of you (third person)'
    }[d.imageView] || 'Image';
    return {
      text: `[Image: ${viewLabel} — ${ts}] ${d.description}`,
      timestamp: d.timestamp
    };
  });
}

module.exports = {
  describeImagesForContext,
  buildImageDescriptionsContext,
  buildTimelineDescriptionItems
};
