import { describe, it, expect } from 'vitest';

const { buildFluxKontextWorkflow, KONTEXT_DEFAULTS, KONTEXT_PATHS } = require('../../src/services/comfyui-workflows/flux-kontext-edit');

describe('flux-kontext-edit workflow (v2 plan)', () => {
  it('builds a 10-node graph with the expected node types', () => {
    const wf = buildFluxKontextWorkflow({
      prompt: 'add a hat',
      referenceFilename: 'ref.png',
      seed: 42
    });
    // Node IDs match the launcher's reference implementation.
    expect(Object.keys(wf).sort()).toEqual(['1','10','11','12','13','2','3','4','5','7','8','9']);
    expect(wf['1'].class_type).toBe('UNETLoader');
    expect(wf['2'].class_type).toBe('DualCLIPLoader');
    expect(wf['3'].class_type).toBe('VAELoader');
    expect(wf['10'].class_type).toBe('LoadImage');
    expect(wf['11'].class_type).toBe('FluxKontextImageScale');
    expect(wf['12'].class_type).toBe('VAEEncode');
    expect(wf['13'].class_type).toBe('ReferenceLatent');
    expect(wf['7'].class_type).toBe('KSampler');
    expect(wf['9'].class_type).toBe('SaveImage');
  });

  it('wires the reference through LoadImage → FluxKontextImageScale → VAEEncode → ReferenceLatent', () => {
    const wf = buildFluxKontextWorkflow({ prompt: 'x', referenceFilename: 'r.png', seed: 0 });
    expect(wf['10'].inputs.image).toBe('r.png');
    expect(wf['11'].inputs.image).toEqual(['10', 0]);
    expect(wf['12'].inputs.pixels).toEqual(['11', 0]);
    expect(wf['13'].inputs.latent).toEqual(['12', 0]);
    // Positive conditioning is ReferenceLatent's output, not the raw text encode.
    expect(wf['7'].inputs.positive).toEqual(['13', 0]);
  });

  it('embeds the prompt in both clip_l and t5xxl of the positive encode', () => {
    const wf = buildFluxKontextWorkflow({ prompt: 'add a blue scarf', referenceFilename: 'r.png', seed: 0 });
    expect(wf['4'].inputs.clip_l).toBe('add a blue scarf');
    expect(wf['4'].inputs.t5xxl).toBe('add a blue scarf');
    // Negative conditioning is empty.
    expect(wf['5'].inputs.clip_l).toBe('');
  });

  it('uses Kontext-specific model file paths (Comfy-Org packaging)', () => {
    const wf = buildFluxKontextWorkflow({ prompt: 'x', referenceFilename: 'r.png', seed: 0 });
    expect(wf['1'].inputs.unet_name).toBe(KONTEXT_PATHS.unet);
    expect(wf['1'].inputs.unet_name).toMatch(/split_files\/diffusion_models/);
    expect(wf['3'].inputs.vae_name).toBe(KONTEXT_PATHS.vae);
  });

  it('defaults to 28 steps and denoise=1.0', () => {
    const wf = buildFluxKontextWorkflow({ prompt: 'x', referenceFilename: 'r.png', seed: 0 });
    expect(wf['7'].inputs.steps).toBe(28);
    expect(wf['7'].inputs.denoise).toBe(1.0);
    expect(KONTEXT_DEFAULTS['flux1-kontext-dev'].steps).toBe(28);
  });

  it('randomizes seed when seed is negative', () => {
    const wf1 = buildFluxKontextWorkflow({ prompt: 'x', referenceFilename: 'r.png', seed: -1 });
    const wf2 = buildFluxKontextWorkflow({ prompt: 'x', referenceFilename: 'r.png', seed: -1 });
    expect(wf1['7'].inputs.seed).not.toBe(wf2['7'].inputs.seed);
    expect(wf1['7'].inputs.seed).toBeGreaterThanOrEqual(0);
  });

  it('rejects missing prompt or referenceFilename — Kontext requires both', () => {
    expect(() => buildFluxKontextWorkflow({ referenceFilename: 'r.png' })).toThrow(/prompt/);
    expect(() => buildFluxKontextWorkflow({ prompt: 'x' })).toThrow(/referenceFilename/);
    expect(() => buildFluxKontextWorkflow({ prompt: 'x', referenceFilename: '' })).toThrow(/referenceFilename/);
  });
});
