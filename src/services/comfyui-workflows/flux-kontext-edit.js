/**
 * ComfyUI workflow template — Flux Kontext reference-conditioned edit
 * (v2 plan — LOCAL_MODELS_PLAN.md).
 *
 * Mirrors `os8-launcher/clients/image-gen/static/index.html::buildKontextWorkflow`.
 * Kontext is image-to-image: it REQUIRES a reference image. The graph is
 * meaningfully different from the text-to-image schnell/dev one:
 *
 *   UNETLoader → DualCLIPLoader → VAELoader
 *   LoadImage → FluxKontextImageScale → VAEEncode
 *   ↘ ReferenceLatent (injects reference into positive conditioning)
 *   KSampler (denoise=1.0, starts from reference latent) → VAEDecode → SaveImage
 *
 * The reference filename is what ComfyUI's LoadImage node resolves — the
 * caller must have uploaded the reference via POST /upload/image first
 * (imagegen.js handles that).
 *
 * Kontext uses Comfy-Org's packaging layout, so file paths include the
 * `split_files/diffusion_models/` subpath for the UNet. Text encoders
 * and VAE sit at the top of the weights dir (the launcher's manifest
 * pulls them from separate HF repos and drops them into the same
 * flux1-kontext-dev/ folder).
 */

const KONTEXT_PATHS = Object.freeze({
  unet:  'flux1-kontext-dev/split_files/diffusion_models/flux1-dev-kontext_fp8_scaled.safetensors',
  clipL: 'flux1-kontext-dev/clip_l.safetensors',
  t5:    'flux1-kontext-dev/t5xxl_fp8_e4m3fn.safetensors',
  vae:   'flux1-kontext-dev/ae.safetensors'
});

function buildFluxKontextWorkflow({ prompt, referenceFilename, steps = 28, seed = -1 }) {
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('buildFluxKontextWorkflow: prompt is required');
  }
  if (!referenceFilename || typeof referenceFilename !== 'string') {
    throw new Error('buildFluxKontextWorkflow: referenceFilename is required (Kontext is reference-conditioned)');
  }

  const finalSeed = seed >= 0 ? seed : Math.floor(Math.random() * (2 ** 32));

  return {
    '1': {
      class_type: 'UNETLoader',
      inputs: { unet_name: KONTEXT_PATHS.unet, weight_dtype: 'default' }
    },
    '2': {
      class_type: 'DualCLIPLoader',
      inputs: { clip_name1: KONTEXT_PATHS.clipL, clip_name2: KONTEXT_PATHS.t5, type: 'flux' }
    },
    '3': {
      class_type: 'VAELoader',
      inputs: { vae_name: KONTEXT_PATHS.vae }
    },
    '4': {
      class_type: 'CLIPTextEncodeFlux',
      inputs: { clip: ['2', 0], clip_l: prompt, t5xxl: prompt, guidance: 2.5 }
    },
    '5': {
      class_type: 'CLIPTextEncodeFlux',
      inputs: { clip: ['2', 0], clip_l: '', t5xxl: '', guidance: 2.5 }
    },
    '10': {
      class_type: 'LoadImage',
      inputs: { image: referenceFilename }
    },
    '11': {
      class_type: 'FluxKontextImageScale',
      inputs: { image: ['10', 0] }
    },
    '12': {
      class_type: 'VAEEncode',
      inputs: { pixels: ['11', 0], vae: ['3', 0] }
    },
    '13': {
      class_type: 'ReferenceLatent',
      inputs: { conditioning: ['4', 0], latent: ['12', 0] }
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
        positive: ['13', 0],
        negative: ['5', 0],
        latent_image: ['12', 0],
        denoise: 1.0
      }
    },
    '8': {
      class_type: 'VAEDecode',
      inputs: { samples: ['7', 0], vae: ['3', 0] }
    },
    '9': {
      class_type: 'SaveImage',
      inputs: { images: ['8', 0], filename_prefix: 'FluxKontext' }
    }
  };
}

// Per-model defaults — Kontext needs more steps than schnell (4) because
// it's denoising from a reference latent, not pure noise.
const KONTEXT_DEFAULTS = Object.freeze({
  'flux1-kontext-dev': { steps: 28 }
});

module.exports = {
  buildFluxKontextWorkflow,
  KONTEXT_DEFAULTS,
  KONTEXT_PATHS
};
