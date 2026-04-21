import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { buildFluxText2ImageWorkflow, FLUX_MODEL_DEFAULTS } = require('../../src/services/comfyui-workflows/flux-text2image');
const ComfyUIClient = require('../../src/services/comfyui-client');

describe('comfyui-workflows/flux-text2image (Phase 3 §4.5)', () => {
  it('builds the schnell graph with the expected node skeleton', () => {
    const wf = buildFluxText2ImageWorkflow({
      modelName: 'flux1-schnell',
      prompt: 'a red apple',
      width: 1024, height: 1024, steps: 4, seed: 42
    });
    expect(Object.keys(wf).sort()).toEqual(['1','2','3','4','5','6','7','8','9']);
    expect(wf['1'].class_type).toBe('UNETLoader');
    expect(wf['2'].class_type).toBe('DualCLIPLoader');
    expect(wf['3'].class_type).toBe('VAELoader');
    expect(wf['7'].class_type).toBe('KSampler');
    expect(wf['9'].class_type).toBe('SaveImage');
  });

  it('embeds the prompt in CLIPTextEncodeFlux nodes', () => {
    const wf = buildFluxText2ImageWorkflow({
      modelName: 'flux1-schnell',
      prompt: 'an octopus reading a book',
      seed: 0
    });
    expect(wf['4'].inputs.clip_l).toBe('an octopus reading a book');
    expect(wf['4'].inputs.t5xxl).toBe('an octopus reading a book');
    // Negative prompt is empty.
    expect(wf['5'].inputs.clip_l).toBe('');
    expect(wf['5'].inputs.t5xxl).toBe('');
  });

  it('passes width/height to EmptySD3LatentImage', () => {
    const wf = buildFluxText2ImageWorkflow({
      modelName: 'flux1-schnell', prompt: 'x', width: 768, height: 512, seed: 0
    });
    expect(wf['6'].inputs.width).toBe(768);
    expect(wf['6'].inputs.height).toBe(512);
  });

  it('uses the explicit seed when >= 0', () => {
    const wf = buildFluxText2ImageWorkflow({
      modelName: 'flux1-schnell', prompt: 'x', seed: 12345
    });
    expect(wf['7'].inputs.seed).toBe(12345);
  });

  it('randomizes seed when seed is negative', () => {
    const wf1 = buildFluxText2ImageWorkflow({ modelName: 'flux1-schnell', prompt: 'x', seed: -1 });
    const wf2 = buildFluxText2ImageWorkflow({ modelName: 'flux1-schnell', prompt: 'x', seed: -1 });
    // Random seeds — astronomically unlikely to collide.
    expect(wf1['7'].inputs.seed).not.toBe(wf2['7'].inputs.seed);
    expect(wf1['7'].inputs.seed).toBeGreaterThanOrEqual(0);
  });

  it('uses model-specific paths for UNET/CLIP/VAE', () => {
    const wf = buildFluxText2ImageWorkflow({ modelName: 'flux1-dev', prompt: 'x', seed: 0 });
    expect(wf['1'].inputs.unet_name).toBe('flux1-dev/flux1-dev.safetensors');
    expect(wf['2'].inputs.clip_name1).toBe('flux1-dev/clip_l.safetensors');
    expect(wf['2'].inputs.clip_name2).toBe('flux1-dev/t5xxl_fp8_e4m3fn.safetensors');
    expect(wf['3'].inputs.vae_name).toBe('flux1-dev/ae.safetensors');
  });

  it('rejects missing modelName / prompt', () => {
    expect(() => buildFluxText2ImageWorkflow({ prompt: 'x' })).toThrow(/modelName/);
    expect(() => buildFluxText2ImageWorkflow({ modelName: 'flux1-schnell' })).toThrow(/prompt/);
  });

  it('FLUX_MODEL_DEFAULTS exports the per-model step counts', () => {
    expect(FLUX_MODEL_DEFAULTS['flux1-schnell'].steps).toBe(4);
    expect(FLUX_MODEL_DEFAULTS['flux1-dev'].steps).toBe(20);
  });
});

describe('comfyui-client — submit + poll + fetch (mocked fetch)', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it('submitWorkflow POSTs to /prompt and returns prompt_id', async () => {
    let captured = null;
    global.fetch = vi.fn(async (url, opts) => {
      if (url.endsWith('/prompt')) {
        captured = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ prompt_id: 'abc-123' }) };
      }
    });
    const id = await ComfyUIClient.submitWorkflow('http://localhost:8188', { '1': { class_type: 'X' } }, 'cid-x');
    expect(id).toBe('abc-123');
    expect(captured).toEqual({ prompt: { '1': { class_type: 'X' } }, client_id: 'cid-x' });
  });

  it('submitWorkflow throws when ComfyUI returns an error payload', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ error: { message: 'bad node' } })
    }));
    await expect(ComfyUIClient.submitWorkflow('http://x', {}, 'c')).rejects.toThrow(/bad node/);
  });

  it('submitWorkflow throws on non-OK response', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 500, text: async () => 'boom' }));
    await expect(ComfyUIClient.submitWorkflow('http://x', {}, 'c')).rejects.toThrow(/500.*boom/);
  });

  it('pollUntilDone returns outputs when /history reports the prompt with outputs', async () => {
    const outputs = { '9': { images: [{ filename: 'Flux_00001.png', type: 'output', subfolder: '' }] } };
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ 'p1': { outputs } })
    }));
    const result = await ComfyUIClient.pollUntilDone('http://x', 'p1', { intervalMs: 1, timeoutMs: 1000 });
    expect(result).toEqual(outputs);
  });

  it('pollUntilDone surfaces ComfyUI execution errors from /history status', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        'p1': {
          status: { status_str: 'error', messages: [['execution_error', { exception_message: 'KSampler crashed' }]] }
        }
      })
    }));
    await expect(ComfyUIClient.pollUntilDone('http://x', 'p1', { intervalMs: 1, timeoutMs: 1000 }))
      .rejects.toThrow(/KSampler crashed/);
  });

  it('pollUntilDone times out when prompt never appears', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    await expect(ComfyUIClient.pollUntilDone('http://x', 'p1', { intervalMs: 5, timeoutMs: 30 }))
      .rejects.toThrow(/timed out/);
  });

  it('fetchImage returns Buffer of /view content', async () => {
    global.fetch = vi.fn(async (url) => {
      expect(url).toMatch(/\/view\?filename=Flux_00001\.png&type=output&subfolder=/);
      return { ok: true, arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4E, 0x47]).buffer };
    });
    const buf = await ComfyUIClient.fetchImage('http://x', { filename: 'Flux_00001.png', type: 'output', subfolder: '' });
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBe(4);
    expect(buf[0]).toBe(0x89);  // PNG magic byte
  });

  it('extractImageRefs flattens images across multiple SaveImage nodes', () => {
    const outputs = {
      '9':  { images: [{ filename: 'a.png', type: 'output', subfolder: '' }] },
      '11': { images: [{ filename: 'b.png', type: 'output', subfolder: 'sub' }] },
      '12': { other_data: 'no images here' }
    };
    const refs = ComfyUIClient.extractImageRefs(outputs);
    expect(refs).toHaveLength(2);
    expect(refs.map(r => r.filename).sort()).toEqual(['a.png', 'b.png']);
  });

  it('resolveBaseUrl falls back to localhost:8188 when launcher unreachable', async () => {
    global.fetch = vi.fn(async (url) => {
      if (url.endsWith('/api/status/capabilities')) {
        throw new Error('ECONNREFUSED');
      }
    });
    const url = await ComfyUIClient.resolveBaseUrl();
    expect(url).toBe('http://localhost:8188');
  });

  it('resolveBaseUrl reads image-gen capability when present', async () => {
    global.fetch = vi.fn(async (url) => {
      if (url.endsWith('/api/status/capabilities')) {
        return { ok: true, json: async () => ({ 'image-gen': [{ base_url: 'http://localhost:9188' }] }) };
      }
    });
    const url = await ComfyUIClient.resolveBaseUrl();
    expect(url).toBe('http://localhost:9188');
  });
});

describe('imagegen — ComfyUI dispatch (Phase 3 §4.5)', () => {
  it('_familyToProvider routes local-flux1-* to comfyui', () => {
    const ImageGenService = require('../../src/services/imagegen');
    expect(ImageGenService._familyToProvider('local-flux1-schnell')).toBe('comfyui');
    expect(ImageGenService._familyToProvider('local-flux1-dev')).toBe('comfyui');
    expect(ImageGenService._familyToProvider('gemini-imagen')).toBe('gemini');
    expect(ImageGenService._familyToProvider('unknown')).toBe(null);
  });

  it('_familyToProviderId routes local-flux1-* to local', () => {
    const ImageGenService = require('../../src/services/imagegen');
    expect(ImageGenService._familyToProviderId('local-flux1-schnell')).toBe('local');
    expect(ImageGenService._familyToProviderId('local-flux1-dev')).toBe('local');
    expect(ImageGenService._familyToProviderId('gemini-imagen')).toBe('google');
  });

  it('getAuthForProvider returns no-auth sentinel for local', async () => {
    const ImageGenService = require('../../src/services/imagegen');
    const auth = await ImageGenService.getAuthForProvider({}, 'local', 'api');
    expect(auth).toEqual({ type: 'none', token: null });
  });
});
