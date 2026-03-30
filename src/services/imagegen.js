/**
 * ImageGenService - AI Image Generation
 *
 * Generates images from text prompts using OpenAI, xAI (Grok), or Google Gemini.
 * Supports reference images for image-to-image generation and editing.
 * Saves files to ~/os8/blob/imagegen/ for later use.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { BLOB_DIR } = require('../config');
const EnvService = require('./env');

// Image files directory
const IMAGEGEN_DIR = path.join(BLOB_DIR, 'imagegen');

// Default models
const DEFAULT_OPENAI_MODEL = 'gpt-image-1';
const DEFAULT_GROK_MODEL = 'grok-imagine-image';
const DEFAULT_GEMINI_MODEL = 'imagen-4.0-generate-001';
// Gemini model for image editing (supports reference images via generateContent)
const GEMINI_IMAGE_EDIT_MODEL = 'gemini-2.5-flash-image';

// Supported image MIME types
const IMAGE_MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
};

class ImageGenService {
  /**
   * Ensure imagegen directory exists
   */
  static ensureImageGenDir() {
    if (!fs.existsSync(IMAGEGEN_DIR)) {
      fs.mkdirSync(IMAGEGEN_DIR, { recursive: true });
    }
  }

  /**
   * Generate a short hash for filenames
   */
  static generateHash(text) {
    return crypto.createHash('md5').update(text).digest('hex').slice(0, 8);
  }

  /**
   * Load reference images from file paths
   * @param {string[]} filePaths - Array of file paths to load
   * @returns {Array<{data: string, mimeType: string, buffer: Buffer}>}
   */
  static loadReferenceImagesFromPaths(filePaths) {
    const images = [];

    for (const filePath of filePaths) {
      if (!fs.existsSync(filePath)) {
        throw new Error(`Reference image not found: ${filePath}`);
      }

      const ext = path.extname(filePath).toLowerCase();
      const mimeType = IMAGE_MIME_TYPES[ext];

      if (!mimeType) {
        throw new Error(`Unsupported image format: ${ext}. Use png, jpg, jpeg, gif, or webp.`);
      }

      const buffer = fs.readFileSync(filePath);
      const data = buffer.toString('base64');
      const sizeMB = (buffer.length / 1024 / 1024).toFixed(2);

      console.log(`ImageGen: Loaded reference image: ${path.basename(filePath)} (${sizeMB}MB, ${mimeType})`);

      images.push({ data, mimeType, buffer, filePath, size: buffer.length });
    }

    return images;
  }

  // --- Login credential readers ---

  /**
   * Read Gemini OAuth token from CLI auth file.
   * Synchronous — token refresh is handled proactively by BillingService.
   * @returns {{ type: 'bearer', token: string } | null}
   */
  static _getGeminiLoginAuth() {
    try {
      const authPath = path.join(os.homedir(), '.gemini', 'oauth_creds.json');
      if (!fs.existsSync(authPath)) return null;
      const creds = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
      if (!creds.access_token) return null;
      // If expired, return null instantly — proactive refresh should have handled it
      if (creds.expiry_date && Date.now() > creds.expiry_date - 60000) return null;
      return { type: 'bearer', token: creds.access_token };
    } catch {
      return null;
    }
  }

  /**
   * Refresh Gemini OAuth token using the refresh_token.
   * Writes updated credentials back to disk.
   * @returns {string|null} new access_token or null on failure
   */
  static async _refreshGeminiToken(authPath, creds) {
    try {
      // Extract client_id from id_token JWT payload
      let clientId;
      if (creds.id_token) {
        const payload = JSON.parse(Buffer.from(creds.id_token.split('.')[1], 'base64').toString());
        clientId = payload.azp;
      }
      if (!clientId) {
        console.warn('[ImageGen] Cannot refresh Gemini token: no client_id found');
        return null;
      }

      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          grant_type: 'refresh_token',
          refresh_token: creds.refresh_token
        }).toString()
      });

      if (!res.ok) {
        console.warn(`[ImageGen] Gemini token refresh failed: ${res.status}`);
        return null;
      }

      const data = await res.json();
      if (!data.access_token) return null;

      // Update credentials file
      const updated = {
        ...creds,
        access_token: data.access_token,
        expiry_date: Date.now() + (data.expires_in * 1000),
        ...(data.id_token ? { id_token: data.id_token } : {})
      };
      fs.writeFileSync(authPath, JSON.stringify(updated, null, 2));
      console.log('[ImageGen] Refreshed Gemini OAuth token');
      return data.access_token;
    } catch (e) {
      console.warn('[ImageGen] Gemini token refresh error:', e.message);
      return null;
    }
  }

  /**
   * Get auth credentials for a provider + access method
   * @param {Database} db
   * @param {string} provider - 'google', 'openai', 'xai'
   * @param {string} accessMethod - 'login' or 'api'
   * @returns {{ type: 'bearer'|'apikey', token: string } | null}
   */
  static getAuthForProvider(db, provider, accessMethod) {
    if (accessMethod === 'login') {
      // Only Google supports login for images (OAuth token covers Imagen API)
      // OpenAI login tokens lack DALL-E API scopes; xAI has no login
      if (provider === 'google') return this._getGeminiLoginAuth();
      return null;
    }
    // API key
    const keyMap = { google: 'GOOGLE_API_KEY', openai: 'OPENAI_API_KEY', xai: 'XAI_API_KEY' };
    const envKey = keyMap[provider];
    if (!envKey) return null;
    const record = EnvService.get(db, envKey);
    if (!record?.value) return null;
    return { type: 'apikey', token: record.value };
  }

  // --- Routing integration ---

  /**
   * Map family IDs to provider names used by imagegen
   */
  static _familyToProvider(familyId) {
    const map = { 'gemini-imagen': 'gemini', 'openai-dalle': 'openai', 'grok-imagine': 'grok' };
    return map[familyId] || null;
  }

  /**
   * Map family IDs to provider IDs used by routing
   */
  static _familyToProviderId(familyId) {
    const map = { 'gemini-imagen': 'google', 'openai-dalle': 'openai', 'grok-imagine': 'xai' };
    return map[familyId] || null;
  }

  /**
   * Resolve ordered list of available image providers from routing cascade
   * @param {Database} db
   * @returns {Array<{ provider: string, providerId: string, accessMethod: string, familyId: string }>}
   */
  static resolveImageProviders(db) {
    const RoutingService = require('./routing');
    const cascade = RoutingService.getCascade(db, 'image');
    const available = [];

    for (const entry of cascade) {
      if (!entry.enabled) continue;
      const provider = this._familyToProvider(entry.family_id);
      const providerId = this._familyToProviderId(entry.family_id);
      if (!provider || !providerId) continue;

      // Check availability via routing
      if (!RoutingService.isAvailable(db, entry.family_id, entry.access_method)) continue;

      available.push({
        provider,
        providerId,
        accessMethod: entry.access_method,
        familyId: entry.family_id
      });
    }

    return available;
  }

  /**
   * Check if providers are available (routing-aware)
   * @param {Database} db - SQLite database
   * @returns {{ ready: boolean, providers: object, defaultProvider: string }}
   */
  static getStatus(db) {
    const cascade = this.resolveImageProviders(db);

    // Build per-provider availability from cascade
    const providerAvail = { openai: false, grok: false, gemini: false };
    const providerMethods = { openai: [], grok: [], gemini: [] };
    let defaultProvider = null;

    for (const entry of cascade) {
      providerAvail[entry.provider] = true;
      providerMethods[entry.provider].push(entry.accessMethod);
      if (!defaultProvider) defaultProvider = entry.provider;
    }

    return {
      ready: cascade.length > 0,
      providers: {
        openai: {
          available: providerAvail.openai,
          models: providerAvail.openai ? [DEFAULT_OPENAI_MODEL, 'dall-e-3'] : [],
          accessMethods: providerMethods.openai,
          ...(!providerAvail.openai ? { error: 'No OpenAI API key available' } : {})
        },
        grok: {
          available: providerAvail.grok,
          models: providerAvail.grok ? [DEFAULT_GROK_MODEL] : [],
          accessMethods: providerMethods.grok,
          ...(!providerAvail.grok ? { error: 'No xAI API key available' } : {})
        },
        gemini: {
          available: providerAvail.gemini,
          models: providerAvail.gemini ? [DEFAULT_GEMINI_MODEL, 'imagen-4.0-fast-generate-001'] : [],
          accessMethods: providerMethods.gemini,
          ...(!providerAvail.gemini ? { error: 'No Gemini login or API key available' } : {})
        }
      },
      defaultProvider
    };
  }

  /**
   * Generate image(s) from prompt
   * @param {Database} db - SQLite database
   * @param {string} prompt - Text description
   * @param {object} options - Generation options
   * @returns {Promise<object>}
   */
  /**
   * Check if an error is a content policy / safety rejection
   */
  static isContentPolicyError(err) {
    const msg = (err.message || '').toLowerCase();
    return msg.includes('safety') || msg.includes('policy') || msg.includes('content_policy')
      || msg.includes('blocked') || msg.includes('harmful') || msg.includes('violat')
      || msg.includes('not allowed') || msg.includes('inappropriate')
      || msg.includes('responsible ai') || msg.includes('refused');
  }

  static async generate(db, prompt, options = {}) {
    if (!prompt || typeof prompt !== 'string') {
      throw new Error('prompt is required');
    }

    // Resolve provider cascade from routing
    const cascade = this.resolveImageProviders(db);
    if (cascade.length === 0) {
      throw new Error('No image generation providers available. Add an API key or log in to a provider in Settings.');
    }

    // Load reference images - support both base64 and file paths
    let referenceImages = options.referenceImages || [];
    const referenceImagePaths = options.referenceImagePaths || [];
    if (referenceImagePaths.length > 0) {
      const loadedImages = this.loadReferenceImagesFromPaths(referenceImagePaths);
      referenceImages = [...referenceImages, ...loadedImages];
    }

    const mask = options.mask || null;
    const genOptions = options.options || {};

    // Build provider order from cascade
    // If explicit provider requested, prioritize it but keep full cascade for fallback
    const explicitProvider = options.provider && options.provider !== 'auto';
    let providerOrder = cascade;
    if (explicitProvider) {
      const preferred = cascade.filter(e => e.provider === options.provider);
      if (preferred.length === 0) {
        throw new Error(`${options.provider} not available for image generation`);
      }
      const rest = cascade.filter(e => e.provider !== options.provider);
      providerOrder = [...preferred, ...rest];
    }

    const policyErrors = [];

    for (const entry of providerOrder) {
      const auth = this.getAuthForProvider(db, entry.providerId, entry.accessMethod);
      if (!auth) continue;

      const authLabel = `${entry.provider}/${entry.accessMethod}`;
      try {
        let result;
        if (entry.provider === 'openai') {
          result = await this.generateWithOpenAI(auth, prompt, referenceImages, mask, genOptions);
        } else if (entry.provider === 'grok') {
          result = await this.generateWithGrok(auth, prompt, referenceImages, genOptions);
        } else {
          result = await this.generateWithGemini(auth, prompt, referenceImages, genOptions);
        }

        // Copy to outputPath if requested
        let outputPath = null;
        let outputFilename = null;
        if (options.outputPath && result.images && result.images.length > 0) {
          const sourceFilename = result.images[0].filename;
          const sourcePath = path.join(IMAGEGEN_DIR, sourceFilename);
          if (fs.existsSync(sourcePath)) {
            const generatedExt = path.extname(sourceFilename).toLowerCase();
            const requestedExt = path.extname(options.outputPath).toLowerCase();
            let finalPath = options.outputPath;
            if (generatedExt && requestedExt && generatedExt !== requestedExt) {
              finalPath = options.outputPath.replace(new RegExp(`\\${requestedExt}$`), generatedExt);
            }
            const outputDir = path.dirname(finalPath);
            if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
            fs.copyFileSync(sourcePath, finalPath);
            outputPath = finalPath;
            outputFilename = path.basename(finalPath);
            console.log(`ImageGen: Copied to outputPath: ${finalPath}`);
          }
        }

        console.log(`ImageGen: Success via ${authLabel}`);
        return {
          success: true,
          ...result,
          provider: entry.provider,
          accessMethod: entry.accessMethod,
          ...(outputPath ? { outputPath, outputFilename } : {}),
          ...(policyErrors.length > 0 ? { fallbackFrom: policyErrors.map(e => e.provider) } : {})
        };
      } catch (err) {
        if (this.isContentPolicyError(err) && providerOrder.indexOf(entry) < providerOrder.length - 1) {
          console.log(`ImageGen: ${authLabel} rejected prompt (content policy), trying next...`);
          policyErrors.push({ provider: entry.provider, error: err.message });
          continue;
        }
        // Auth failure on login → try next entry in cascade silently
        if (entry.accessMethod === 'login' && (err.message?.includes('401') || err.message?.includes('403') || err.message?.includes('Unauthorized'))) {
          console.log(`ImageGen: ${authLabel} auth failed, trying next...`);
          continue;
        }
        if (policyErrors.length > 0) {
          throw new Error(`All providers rejected this prompt. ${policyErrors.map(e => `${e.provider}: ${e.error}`).join('; ')}; ${entry.provider}: ${err.message}`);
        }
        throw err;
      }
    }

    throw new Error('No image generation providers could fulfill the request.');
  }

  /**
   * Generate with OpenAI
   */
  static async generateWithOpenAI(auth, prompt, referenceImages, mask, options) {
    const apiKey = auth.token;

    const model = options.model || DEFAULT_OPENAI_MODEL;
    const size = options.size || '1024x1024';
    const quality = options.quality || 'medium';
    const n = Math.min(options.n || 1, 4);

    let response;
    let revisedPrompt;

    if (referenceImages.length > 0) {
      // Image editing endpoint (multipart/form-data)
      // OpenAI supports multiple reference images - reference them by index in your prompt
      // e.g., "Put the dog from image 2 into the scene from image 1"

      // Use native FormData with Blob for Node.js fetch compatibility
      const formData = new FormData();
      formData.append('model', model);
      formData.append('prompt', prompt);
      formData.append('n', String(n));
      formData.append('size', size);

      // Add all reference images
      for (let i = 0; i < referenceImages.length; i++) {
        const ref = referenceImages[i];
        const imageBuffer = ref.buffer || Buffer.from(ref.data, 'base64');
        const ext = ref.mimeType.split('/')[1] || 'png';
        const sizeMB = (imageBuffer.length / 1024 / 1024).toFixed(2);

        console.log(`ImageGen: Adding reference image ${i + 1}/${referenceImages.length}: ${sizeMB}MB (${ref.mimeType})`);

        const imageBlob = new Blob([imageBuffer], { type: ref.mimeType });
        // Use 'image[]' for multiple images, 'image' for single
        const fieldName = referenceImages.length > 1 ? 'image[]' : 'image';
        formData.append(fieldName, imageBlob, `reference_${i + 1}.${ext}`);
      }

      console.log(`ImageGen: Uploading to OpenAI edits endpoint - model: ${model}, ${referenceImages.length} image(s), size: ${size}`);

      // Add mask if provided
      if (mask) {
        const maskBuffer = Buffer.from(mask.data, 'base64');
        const maskBlob = new Blob([maskBuffer], { type: mask.mimeType || 'image/png' });
        formData.append('mask', maskBlob, 'mask.png');
      }

      response = await fetch('https://api.openai.com/v1/images/edits', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`
        },
        body: formData
      });
    } else {
      // Image generation endpoint (JSON)
      response = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          prompt,
          n,
          size,
          quality
        })
      });
    }

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage;
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error?.message || errorJson.error || errorText;
      } catch {
        errorMessage = errorText;
      }

      if (response.status === 429) {
        throw new Error(`Rate limited by OpenAI. Try again later.`);
      }
      throw new Error(`OpenAI API error (${response.status}): ${errorMessage}`);
    }

    const result = await response.json();
    revisedPrompt = result.data?.[0]?.revised_prompt;

    // Save images
    const images = await this.saveImages(result.data, prompt, 'openai', model);

    return {
      images,
      model,
      revisedPrompt
    };
  }

  /**
   * Generate with Grok (xAI) - OpenAI-compatible API
   * Supports reference images via /v1/images/edits endpoint with base64 data URI
   */
  static async generateWithGrok(auth, prompt, referenceImages, options) {
    const apiKey = auth.token;

    const n = Math.min(options.n || 1, 10);
    let response;

    if (referenceImages.length > 0) {
      // Use /v1/images/edits endpoint with grok-imagine-image model
      const ref = referenceImages[0];
      if (referenceImages.length > 1) {
        const usedName = path.basename(ref.filePath || 'unknown');
        const skippedNames = referenceImages.slice(1).map(r => path.basename(r.filePath || 'unknown')).join(', ');
        console.log(`ImageGen: Grok supports 1 reference image, using ${usedName} (skipped: ${skippedNames})`);
      }

      const imageData = ref.data || (ref.buffer ? ref.buffer.toString('base64') : null);
      if (!imageData) {
        throw new Error('Reference image has no data');
      }

      const sizeMB = (Buffer.from(imageData, 'base64').length / 1024 / 1024).toFixed(2);
      console.log(`ImageGen: Uploading to Grok edits endpoint: ${sizeMB}MB (${ref.mimeType})`);

      // Grok expects image as object with url field containing data URI
      response = await fetch('https://api.x.ai/v1/images/edits', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'grok-imagine-image',
          prompt,
          image: {
            url: `data:${ref.mimeType};base64,${imageData}`
          },
          n,
          response_format: 'b64_json'
        })
      });
    } else {
      // Text-to-image: use generations endpoint
      const model = options.model || DEFAULT_GROK_MODEL;

      response = await fetch('https://api.x.ai/v1/images/generations', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          prompt,
          n,
          response_format: 'b64_json'
        })
      });
    }

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage;
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error?.message || errorJson.error || errorText;
      } catch {
        errorMessage = errorText;
      }

      if (response.status === 429) {
        throw new Error(`Rate limited by Grok. Try again later.`);
      }
      throw new Error(`Grok API error (${response.status}): ${errorMessage}`);
    }

    const result = await response.json();
    const revisedPrompt = result.data?.[0]?.revised_prompt;

    // Determine which model was used
    const usedModel = referenceImages.length > 0 ? 'grok-imagine-image' : (options.model || DEFAULT_GROK_MODEL);

    // Save images
    const images = await this.saveImages(result.data, prompt, 'grok', usedModel);

    return {
      images,
      model: usedModel,
      revisedPrompt
    };
  }

  /**
   * Generate with Gemini
   * - Text-to-image: Uses Imagen API (predict endpoint)
   * - With reference images: Uses Gemini generateContent API
   */
  static async generateWithGemini(auth, prompt, referenceImages, options) {
    const n = Math.min(options.n || 1, 4);

    // Map size to aspect ratio
    let aspectRatio = '1:1';
    if (options.size) {
      if (options.size === '1792x1024' || options.size === '1536x1024') {
        aspectRatio = '16:9';
      } else if (options.size === '1024x1792' || options.size === '1024x1536') {
        aspectRatio = '9:16';
      }
    }

    if (referenceImages.length > 0) {
      // Use Gemini generateContent API for image editing
      return this.generateWithGeminiEdit(auth, prompt, referenceImages, options);
    }

    // Text-to-image: Use Imagen predict API
    const model = options.model || DEFAULT_GEMINI_MODEL;

    // Build URL and headers based on auth type
    const isBearer = auth.type === 'bearer';
    const url = isBearer
      ? `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict`
      : `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${auth.token}`;
    const headers = { 'Content-Type': 'application/json' };
    if (isBearer) headers['Authorization'] = `Bearer ${auth.token}`;

    const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          instances: [{ prompt }],
          parameters: {
            sampleCount: n,
            aspectRatio
          }
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage;
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error?.message || errorJson.error || errorText;
      } catch {
        errorMessage = errorText;
      }

      if (response.status === 429) {
        throw new Error(`Rate limited by Gemini. Try again later.`);
      }
      throw new Error(`Gemini API error (${response.status}): ${errorMessage}`);
    }

    const result = await response.json();

    // Extract images from Imagen response
    const predictions = result.predictions || [];
    if (predictions.length === 0) {
      throw new Error('Gemini/Imagen returned no results');
    }

    const imageParts = [];
    for (const prediction of predictions) {
      if (prediction.bytesBase64Encoded) {
        imageParts.push({
          b64_json: prediction.bytesBase64Encoded,
          mimeType: prediction.mimeType || 'image/png'
        });
      }
    }

    if (imageParts.length === 0) {
      throw new Error('Gemini/Imagen did not return any images. Try a different prompt.');
    }

    // Save images
    const images = await this.saveImages(imageParts, prompt, 'gemini', model);

    return {
      images,
      model
    };
  }

  /**
   * Generate with Gemini using generateContent API (supports reference images)
   * Uses gemini-2.0-flash-exp model which has native image generation
   */
  static async generateWithGeminiEdit(auth, prompt, referenceImages, options) {
    const model = GEMINI_IMAGE_EDIT_MODEL;

    console.log(`ImageGen: Using Gemini generateContent with ${referenceImages.length} reference image(s)`);

    // Build contents array with prompt and images
    const parts = [{ text: prompt }];

    for (let i = 0; i < referenceImages.length; i++) {
      const ref = referenceImages[i];
      const imageData = ref.data || (ref.buffer ? ref.buffer.toString('base64') : null);

      if (!imageData) {
        throw new Error(`Reference image ${i + 1} has no data`);
      }

      const sizeMB = (Buffer.from(imageData, 'base64').length / 1024 / 1024).toFixed(2);
      console.log(`ImageGen: Adding reference image ${i + 1}/${referenceImages.length}: ${sizeMB}MB (${ref.mimeType})`);

      parts.push({
        inlineData: {
          mimeType: ref.mimeType,
          data: imageData
        }
      });
    }

    // Build URL and headers based on auth type
    const isBearer = auth.type === 'bearer';
    const url = isBearer
      ? `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
      : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${auth.token}`;
    const headers = { 'Content-Type': 'application/json' };
    if (isBearer) headers['Authorization'] = `Bearer ${auth.token}`;

    const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            responseModalities: ['IMAGE']
          }
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage;
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error?.message || errorJson.error || errorText;
      } catch {
        errorMessage = errorText;
      }

      if (response.status === 429) {
        throw new Error(`Rate limited by Gemini. Try again later.`);
      }
      throw new Error(`Gemini API error (${response.status}): ${errorMessage}`);
    }

    const result = await response.json();

    // Extract images from generateContent response
    const imageParts = [];
    const candidates = result.candidates || [];

    for (const candidate of candidates) {
      const content = candidate.content || {};
      const responseParts = content.parts || [];

      for (const part of responseParts) {
        if (part.inlineData && part.inlineData.data) {
          imageParts.push({
            b64_json: part.inlineData.data,
            mimeType: part.inlineData.mimeType || 'image/png'
          });
        }
      }
    }

    if (imageParts.length === 0) {
      // Check if there's text response explaining why no image was generated
      let textResponse = '';
      for (const candidate of candidates) {
        const content = candidate.content || {};
        const responseParts = content.parts || [];
        for (const part of responseParts) {
          if (part.text) {
            textResponse += part.text;
          }
        }
      }

      if (textResponse) {
        throw new Error(`Gemini did not generate an image. Response: ${textResponse.slice(0, 200)}`);
      }
      throw new Error('Gemini did not return any images. Try a different prompt.');
    }

    // Save images
    const images = await this.saveImages(imageParts, prompt, 'gemini', model);

    return {
      images,
      model
    };
  }

  /**
   * Save generated images to disk
   */
  static async saveImages(data, prompt, provider, model) {
    this.ensureImageGenDir();
    const images = [];
    const timestamp = Date.now();
    const hash = this.generateHash(prompt);

    for (let i = 0; i < data.length; i++) {
      const item = data[i];
      const base64Data = item.b64_json;

      if (!base64Data) {
        console.warn(`ImageGen: Image ${i} has no base64 data, skipping`);
        continue;
      }

      const imageBuffer = Buffer.from(base64Data, 'base64');

      // Detect actual image format from magic bytes, then fall back to declared mimeType
      let mimeType = item.mimeType;
      if (!mimeType) {
        if (imageBuffer.length >= 3 && imageBuffer[0] === 0xFF && imageBuffer[1] === 0xD8 && imageBuffer[2] === 0xFF) {
          mimeType = 'image/jpeg';
        } else if (imageBuffer.length >= 4 && imageBuffer[0] === 0x89 && imageBuffer[1] === 0x50 && imageBuffer[2] === 0x4E && imageBuffer[3] === 0x47) {
          mimeType = 'image/png';
        } else if (imageBuffer.length >= 4 && imageBuffer[0] === 0x52 && imageBuffer[1] === 0x49 && imageBuffer[2] === 0x46 && imageBuffer[3] === 0x46) {
          mimeType = 'image/webp';
        } else {
          mimeType = 'image/png'; // default fallback
        }
      }
      const ext = mimeType === 'image/jpeg' ? 'jpg' : (mimeType.split('/')[1] || 'png');

      const suffix = data.length > 1 ? `-${i + 1}` : '';
      const filename = `${timestamp}-${hash}${suffix}.${ext}`;
      const filePath = path.join(IMAGEGEN_DIR, filename);

      // Save image
      fs.writeFileSync(filePath, imageBuffer);

      // Save metadata sidecar
      const metadata = {
        prompt,
        provider,
        model,
        created: new Date().toISOString(),
        size: imageBuffer.length
      };
      fs.writeFileSync(
        path.join(IMAGEGEN_DIR, `${timestamp}-${hash}${suffix}.json`),
        JSON.stringify(metadata, null, 2)
      );

      // Get image dimensions (basic check for PNG)
      let width, height;
      if (ext === 'png' && imageBuffer.length > 24) {
        width = imageBuffer.readUInt32BE(16);
        height = imageBuffer.readUInt32BE(20);
      }

      images.push({
        filename,
        url: `/api/imagegen/files/${filename}`,
        size: imageBuffer.length,
        ...(width && height ? { width, height } : {})
      });

      console.log(`ImageGen: Saved ${filename} (${imageBuffer.length} bytes) via ${provider}`);
    }

    return images;
  }

  /**
   * List generated images
   * @returns {Array<object>}
   */
  static listFiles() {
    this.ensureImageGenDir();

    const imageExtensions = ['.png', '.jpg', '.jpeg', '.webp'];
    const files = fs.readdirSync(IMAGEGEN_DIR)
      .filter(f => imageExtensions.some(ext => f.endsWith(ext)))
      .map(filename => {
        const filePath = path.join(IMAGEGEN_DIR, filename);
        const stats = fs.statSync(filePath);

        // Try to load metadata
        const baseName = filename.replace(/\.[^.]+$/, '');
        const metadataPath = path.join(IMAGEGEN_DIR, `${baseName}.json`);
        let metadata = {};
        if (fs.existsSync(metadataPath)) {
          try {
            metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
          } catch (e) {
            // Ignore metadata parse errors
          }
        }

        return {
          filename,
          url: `/api/imagegen/files/${filename}`,
          size: stats.size,
          created: stats.birthtime,
          ...metadata
        };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created)); // Newest first

    return files;
  }

  /**
   * Get a file path (for serving)
   * @param {string} filename
   * @returns {string|null}
   */
  static getFilePath(filename) {
    this.ensureImageGenDir();

    const filePath = path.join(IMAGEGEN_DIR, filename);

    // Security: ensure file is in imagegen directory
    if (!filePath.startsWith(IMAGEGEN_DIR)) {
      return null;
    }

    if (!fs.existsSync(filePath)) {
      return null;
    }

    return filePath;
  }

  /**
   * Delete an image file
   * @param {string} filename
   * @returns {{ success: boolean }}
   */
  static deleteFile(filename) {
    const filePath = path.join(IMAGEGEN_DIR, filename);

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filename}`);
    }

    // Security: ensure file is in imagegen directory
    if (!filePath.startsWith(IMAGEGEN_DIR)) {
      throw new Error('Invalid file path');
    }

    fs.unlinkSync(filePath);

    // Also delete metadata if exists
    const baseName = filename.replace(/\.[^.]+$/, '');
    const metadataPath = path.join(IMAGEGEN_DIR, `${baseName}.json`);
    if (fs.existsSync(metadataPath)) {
      fs.unlinkSync(metadataPath);
    }

    return { success: true };
  }
}

module.exports = ImageGenService;
