/**
 * ComfyUI workflow templates — Flux text-to-image (Phase 3 §4.5).
 *
 * Mirrors `os8-launcher/clients/image-gen/static/index.html::buildWorkflow`,
 * the canonical reference for the schnell/dev pipeline:
 *   UNETLoader → DualCLIPLoader → VAELoader
 *   ↘ CLIPTextEncodeFlux (positive + negative)
 *   ↘ EmptySD3LatentImage → KSampler → VAEDecode → SaveImage
 *
 * The launcher's ComfyUI container bind-mounts each model's weights into
 * /app/models/{diffusion_models,text_encoders,vae}/<modelName>/, so file
 * paths are always `<modelName>/<file>` regardless of the schnell-vs-dev
 * variant. Steps are caller-controlled (schnell: 4, dev: 20).
 *
 * Returns a fresh object each call so the seed is randomized per invocation.
 */

function buildFluxText2ImageWorkflow({ modelName, prompt, width = 1024, height = 1024, steps = 4, seed = -1 }) {
  if (!modelName) throw new Error('buildFluxText2ImageWorkflow: modelName is required');
  if (!prompt || typeof prompt !== 'string') throw new Error('buildFluxText2ImageWorkflow: prompt is required');

  const finalSeed = seed >= 0 ? seed : Math.floor(Math.random() * (2 ** 32));

  return {
    '1': {
      class_type: 'UNETLoader',
      inputs: {
        unet_name: `${modelName}/${modelName}.safetensors`,
        weight_dtype: 'default'
      }
    },
    '2': {
      class_type: 'DualCLIPLoader',
      inputs: {
        clip_name1: `${modelName}/clip_l.safetensors`,
        clip_name2: `${modelName}/t5xxl_fp8_e4m3fn.safetensors`,
        type: 'flux'
      }
    },
    '3': {
      class_type: 'VAELoader',
      inputs: { vae_name: `${modelName}/ae.safetensors` }
    },
    '4': {
      class_type: 'CLIPTextEncodeFlux',
      inputs: {
        clip: ['2', 0],
        clip_l: prompt,
        t5xxl: prompt,
        guidance: 3.5
      }
    },
    '5': {
      class_type: 'CLIPTextEncodeFlux',
      // Empty negative prompt — Flux guidance does the work.
      inputs: { clip: ['2', 0], clip_l: '', t5xxl: '', guidance: 3.5 }
    },
    '6': {
      class_type: 'EmptySD3LatentImage',
      inputs: { width, height, batch_size: 1 }
    },
    '7': {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0],
        seed: finalSeed,
        steps,
        cfg: 1.0,
        sampler_name: 'euler',
        scheduler: 'simple',
        positive: ['4', 0],
        negative: ['5', 0],
        latent_image: ['6', 0],
        denoise: 1.0
      }
    },
    '8': {
      class_type: 'VAEDecode',
      inputs: { samples: ['7', 0], vae: ['3', 0] }
    },
    '9': {
      class_type: 'SaveImage',
      inputs: { images: ['8', 0], filename_prefix: 'Flux' }
    }
  };
}

// Per-model defaults so callers (imagegen.js) can pass through to the workflow
// builder with sensible step counts.
const FLUX_MODEL_DEFAULTS = {
  'flux1-schnell': { steps: 4 },
  'flux1-dev':     { steps: 20 }
};

module.exports = {
  buildFluxText2ImageWorkflow,
  FLUX_MODEL_DEFAULTS
};
