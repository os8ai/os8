/**
 * Portrait generation pipeline — prompt building, reference image finding,
 * image generation, and DB storage for agent simulation portraits.
 */

const fs = require('fs');
const path = require('path');
const ConversationService = require('./conversation');

/**
 * Build portrait prompt from identity and journal state (full version for Gemini/OpenAI)
 * @param {object} identity
 * @param {object} currentState
 * @param {object} [lifeItemData]
 * @returns {string}
 */
function buildPortraitPrompt(identity, currentState, lifeItemData = {}) {
  const parts = [];
  const subject = identity.pronouns === 'she/her' ? 'woman' : identity.pronouns === 'he/him' ? 'man' : 'person';

  parts.push(`Generate a medium close-up shot of the ${subject} in the reference photo.`);

  // Immutables
  if (identity.immutablePromptFragment) {
    parts.push(`IMMUTABLES (match EXACTLY to reference images): ${identity.immutablePromptFragment}`);
  }

  // Mutables
  const mutables = [];

  // Hair — prefer life item description, fall back to free-text
  if (lifeItemData.hairstyle) {
    mutables.push(`Hair style - ${lifeItemData.hairstyle.description}`);
  } else if (currentState.appearance?.hair) {
    mutables.push(`Hair style - ${currentState.appearance.hair}`);
  }

  if (currentState.mood) mutables.push(`Expression - ${currentState.mood}`);
  if (currentState.makeup) mutables.push(`Makeup - ${currentState.makeup}`);
  else if (currentState.appearance?.makeup) mutables.push(`Makeup - ${currentState.appearance.makeup}`);

  // Clothing — prefer life item description, fall back to free-text parts
  if (lifeItemData.outfit) {
    mutables.push(`Clothing - ${lifeItemData.outfit.description}`);
  } else {
    const clothingParts = [];
    if (currentState.appearance?.top) clothingParts.push(currentState.appearance.top);
    if (currentState.appearance?.bottom) clothingParts.push(currentState.appearance.bottom);
    if (currentState.appearance?.shoes) clothingParts.push(currentState.appearance.shoes);
    if (currentState.appearance?.accessories && currentState.appearance.accessories !== 'none') {
      clothingParts.push(currentState.appearance.accessories);
    }
    if (clothingParts.length > 0) mutables.push(`Clothing - ${clothingParts.join(', ')}`);
  }

  if (currentState.body_position) mutables.push(`Pose - ${currentState.body_position}`);
  if (currentState.activity) mutables.push(`Activity - ${currentState.activity}`);
  if (currentState.food_drink && currentState.food_drink !== 'none' && currentState.food_drink !== 'nothing') {
    mutables.push(`Props - ${currentState.food_drink}`);
  }

  // Setting — prefer life item scene_prompt, fall back to _scenePrompt or location
  const settingParts = [];
  if (lifeItemData.setting?.scene_prompt) {
    settingParts.push(lifeItemData.setting.scene_prompt);
  } else if (currentState._scenePrompt) {
    settingParts.push(currentState._scenePrompt);
  } else if (currentState.location) {
    settingParts.push(currentState.location);
  }
  if (currentState.weather_outside) settingParts.push(currentState.weather_outside);
  if (settingParts.length > 0) mutables.push(`Setting - ${settingParts.join(', ')}`);

  parts.push(`MUTABLES (vary for this scene): ${mutables.join('. ')}.`);

  return parts.join(' ');
}

/**
 * Build compact portrait prompt for Grok (max ~900 chars to stay under 1024 limit)
 * @param {object} identity
 * @param {object} currentState
 * @param {object} [lifeItemData]
 * @returns {string}
 */
function buildGrokPortraitPrompt(identity, currentState, lifeItemData = {}) {
  const subject = identity.pronouns === 'she/her' ? 'woman' : identity.pronouns === 'he/him' ? 'man' : 'person';
  const phys = identity.physicalDescription || {};

  const traits = [phys.hairColor, phys.eyeColor, phys.skinTone, phys.build].filter(Boolean).join(', ');

  const parts = [];
  parts.push(`Medium close-up photo of the ${subject} from the reference. Match face, body, and features exactly.`);
  if (traits) parts.push(`Key traits: ${traits}.`);

  if (lifeItemData.hairstyle) {
    parts.push(`Hair: ${lifeItemData.hairstyle.description}.`);
  } else if (currentState.appearance?.hair) {
    parts.push(`Hair: ${currentState.appearance.hair}.`);
  }
  if (currentState.mood) parts.push(`Expression: ${currentState.mood}.`);

  if (lifeItemData.outfit) {
    parts.push(`Wearing: ${lifeItemData.outfit.description}.`);
  } else {
    const clothes = [currentState.appearance?.top, currentState.appearance?.bottom, currentState.appearance?.shoes]
      .filter(Boolean).join(', ');
    if (clothes) parts.push(`Wearing: ${clothes}.`);
  }

  if (currentState.body_position) parts.push(`Pose: ${currentState.body_position}.`);
  if (currentState.activity) parts.push(`Doing: ${currentState.activity}.`);
  if (currentState.food_drink && currentState.food_drink !== 'none' && currentState.food_drink !== 'nothing') {
    parts.push(`With: ${currentState.food_drink}.`);
  }
  if (lifeItemData.setting?.scene_prompt) {
    parts.push(`Location: ${lifeItemData.setting.scene_prompt}.`);
  } else if (currentState._scenePrompt) {
    parts.push(`Location: ${currentState._scenePrompt}.`);
  } else if (currentState.location) {
    parts.push(`Location: ${currentState.location}.`);
  }

  let prompt = parts.join(' ');

  if (prompt.length > 1000) {
    prompt = prompt.substring(0, 997) + '...';
  }

  return prompt;
}

/**
 * Generate a portrait image via ImageGenService
 * @param {object} db
 * @param {object} opts - { prompt, provider, refs, output }
 * @returns {Promise<object>}
 */
async function generatePortrait(db, opts) {
  const ImageGenService = require('./imagegen');

  console.log(`SimService: Generating portrait — provider: ${opts.provider || 'auto'}, refs: ${(opts.refs || []).length}, output: ${opts.output || '(none)'}`);

  const result = await ImageGenService.generate(db, opts.prompt, {
    provider: opts.provider || 'auto',
    referenceImagePaths: opts.refs || [],
    outputPath: opts.output || null,
  });

  if (!result.images || result.images.length === 0) {
    throw new Error('No images returned from ImageGenService');
  }

  return {
    savedTo: result.outputPath || null,
    provider: result.provider,
    filename: result.outputFilename || result.images[0].filename,
  };
}

/**
 * Find simple reference images: headshot + body only
 * @param {string} agentBlobDir
 * @returns {{ headshot: string|null, body: string|null }}
 */
function findSimpleRefs(agentBlobDir) {
  const refDir = path.join(agentBlobDir, 'reference-images');
  const result = { headshot: null, body: null };

  if (!fs.existsSync(refDir)) return result;

  try {
    const files = fs.readdirSync(refDir);
    const headshotFile = files.find(f =>
      /headshot/i.test(f) || (/reference/i.test(f) && !/body/i.test(f))
    );
    if (headshotFile) result.headshot = path.join(refDir, headshotFile);

    const bodyFile = files.find(f => /body/i.test(f));
    if (bodyFile) result.body = path.join(refDir, bodyFile);
  } catch (e) {
    console.warn('SimService: Failed to scan reference images:', e.message);
  }

  return result;
}

/**
 * Store an image file in the conversation DB
 * @param {object} db
 * @param {string} agentId
 * @param {string} filePath
 * @param {string} filename
 * @param {string} imageView - 'third_person' or 'pov'
 * @param {Date} now
 * @returns {object|null}
 */
async function storeImageInDb(db, agentId, filePath, filename, imageView, now) {
  if (!fs.existsSync(filePath)) return null;

  try {
    const { compressImageBuffer, shouldCompress } = require('../utils/image-compress');
    const buffer = fs.readFileSync(filePath);

    let imageData, mediaType;
    if (shouldCompress(buffer.length)) {
      const compressed = await compressImageBuffer(buffer);
      imageData = compressed.data;
      mediaType = compressed.mediaType;
    } else {
      if (buffer[0] === 0x89 && buffer[1] === 0x50) {
        mediaType = 'image/png';
      } else if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
        mediaType = 'image/jpeg';
      } else {
        mediaType = 'image/png';
      }
      imageData = buffer.toString('base64');
    }

    return ConversationService.addImageEntry(db, agentId, {
      imageData,
      mediaType,
      imageView,
      timestamp: now.toISOString(),
      originalFilename: filename
    });
  } catch (err) {
    console.error(`SimService: Failed to store ${imageView} image in DB:`, err.message);
    return null;
  }
}

module.exports = {
  buildPortraitPrompt,
  buildGrokPortraitPrompt,
  generatePortrait,
  findSimpleRefs,
  storeImageInDb
};
