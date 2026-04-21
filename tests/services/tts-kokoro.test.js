import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const Kokoro = require('../../src/services/tts-kokoro');
const TTSService = require('../../src/services/tts');

describe('tts-kokoro — module shape (Phase 3 §4.4)', () => {
  it('exports the same shape as tts-openai for facade parity', () => {
    expect(Kokoro.PROVIDER_ID).toBe('kokoro');
    expect(Kokoro.API_KEY_ENV).toBe(null);  // local — no auth
    expect(Kokoro.DEFAULT_VOICES).toBeDefined();
    expect(Kokoro.DEFAULT_VOICES.female.id).toBe('af_bella');
    expect(Kokoro.DEFAULT_VOICES.male.id).toBe('am_adam');
    expect(Kokoro.DEFAULTS.model).toBe('kokoro');
    expect(Kokoro.DEFAULTS.format).toBe('mp3');
    // Functions
    for (const fn of ['getVoices', 'generateAudio', 'streamAudio', 'streamAudioChunked', 'getDefaultVoices', 'getWebSocketUrl']) {
      expect(typeof Kokoro[fn]).toBe('function');
    }
  });

  it('getWebSocketUrl returns null (Kokoro uses HTTP streaming)', () => {
    expect(Kokoro.getWebSocketUrl()).toBe(null);
  });

  it('getDefaultVoices returns the gendered defaults', () => {
    const v = Kokoro.getDefaultVoices();
    expect(v.female.id).toBe('af_bella');
    expect(v.male.id).toBe('am_adam');
  });
});

describe('tts-kokoro — voice-id helpers', () => {
  it('humanizeVoiceId strips the language+gender prefix', () => {
    expect(Kokoro.humanizeVoiceId('af_bella')).toBe('Bella');
    expect(Kokoro.humanizeVoiceId('am_adam')).toBe('Adam');
    expect(Kokoro.humanizeVoiceId('bf_emma')).toBe('Emma');
  });

  it('humanizeVoiceId is defensive for malformed ids', () => {
    expect(Kokoro.humanizeVoiceId('')).toBe('');
    expect(Kokoro.humanizeVoiceId('plain')).toBe('plain');
    expect(Kokoro.humanizeVoiceId(null)).toBe('');
  });

  it('kokoroCategoryOf maps the language prefix to a name', () => {
    expect(Kokoro.kokoroCategoryOf('af_bella')).toBe('American');
    expect(Kokoro.kokoroCategoryOf('bf_alice')).toBe('British');
    expect(Kokoro.kokoroCategoryOf('jf_yuki')).toBe('Japanese');
    expect(Kokoro.kokoroCategoryOf('xx_alien')).toBe('Other');
  });

  it('kokoroLabelsOf maps the gender slot to female/male', () => {
    expect(Kokoro.kokoroLabelsOf('af_bella')).toEqual({ gender: 'female' });
    expect(Kokoro.kokoroLabelsOf('am_adam')).toEqual({ gender: 'male' });
    expect(Kokoro.kokoroLabelsOf('aq_unknown')).toEqual({ gender: 'unknown' });
  });
});

describe('tts-kokoro — getVoices (mocked fetch)', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('normalizes Kokoro-FastAPI voice list to TTSService voice shape', async () => {
    global.fetch = vi.fn(async (url) => {
      if (url.endsWith('/api/status/capabilities')) {
        return { ok: true, json: async () => ({ tts: [{ base_url: 'http://localhost:8880' }] }) };
      }
      if (url.endsWith('/v1/audio/voices')) {
        return { ok: true, json: async () => ({ voices: ['af_bella', 'am_adam', 'bf_emma'] }) };
      }
      return { ok: false, status: 404, text: async () => 'not found' };
    });

    const voices = await Kokoro.getVoices();
    expect(voices).toHaveLength(3);
    expect(voices[0]).toEqual({
      voiceId: 'af_bella',
      name: 'Bella (American)',  // category suffixed for disambiguation
      category: 'American',
      labels: { gender: 'female' },
      previewUrl: null
    });
    expect(voices[2].category).toBe('British');
    expect(voices[2].name).toBe('Emma (British)');
    expect(voices[2].labels.gender).toBe('female');
  });

  it('disambiguates names that collide with OpenAI voice names', async () => {
    // The reason we suffix the category at all: Kokoro borrowed several voice
    // names from OpenAI (am_echo, am_onyx, af_alloy, af_nova). Without the
    // suffix, the picker would show a bare "Echo" identical to OpenAI's Echo.
    global.fetch = vi.fn(async (url) => {
      if (url.endsWith('/api/status/capabilities')) {
        return { ok: true, json: async () => ({}) };
      }
      if (url.endsWith('/v1/audio/voices')) {
        return { ok: true, json: async () => ({ voices: ['am_echo', 'am_onyx', 'af_nova'] }) };
      }
    });
    const voices = await Kokoro.getVoices();
    expect(voices.map(v => v.name)).toEqual(['Echo (American)', 'Onyx (American)', 'Nova (American)']);
  });

  it('throws a clear error when Kokoro returns non-OK', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    global.fetch = vi.fn(async (url) => {
      if (url.endsWith('/api/status/capabilities')) {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: false, status: 503, text: async () => 'service unavailable' };
    });

    await expect(Kokoro.getVoices()).rejects.toThrow(/503/);
  });

  it('falls back to localhost:8880 when launcher capabilities is unreachable', async () => {
    global.fetch = vi.fn(async (url) => {
      if (url.endsWith('/api/status/capabilities')) {
        throw new Error('ECONNREFUSED');
      }
      if (url.startsWith('http://localhost:8880/v1/audio/voices')) {
        return { ok: true, json: async () => ({ voices: ['af_bella'] }) };
      }
      return { ok: false, status: 404, text: async () => 'not found' };
    });

    const voices = await Kokoro.getVoices();
    expect(voices).toHaveLength(1);
    expect(voices[0].voiceId).toBe('af_bella');
  });
});

describe('tts-kokoro — generateAudio (mocked fetch)', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it('POSTs OpenAI-shape body to /v1/audio/speech and returns Buffer', async () => {
    let captured = null;
    global.fetch = vi.fn(async (url, opts) => {
      if (url.endsWith('/api/status/capabilities')) {
        return { ok: true, json: async () => ({ tts: [{ base_url: 'http://localhost:8880' }] }) };
      }
      if (url.endsWith('/v1/audio/speech')) {
        captured = JSON.parse(opts.body);
        return {
          ok: true,
          arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer
        };
      }
    });

    const buf = await Kokoro.generateAudio(null, 'hello world', 'af_bella', { speed: 1.2, format: 'mp3' });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBe(4);
    expect(captured).toEqual({
      model: 'kokoro',
      input: 'hello world',
      voice: 'af_bella',
      speed: 1.2,
      response_format: 'mp3'
    });
  });

  it('uses default voice when voiceId is empty', async () => {
    let captured = null;
    global.fetch = vi.fn(async (url, opts) => {
      if (url.endsWith('/api/status/capabilities')) {
        return { ok: true, json: async () => ({}) };
      }
      if (url.endsWith('/v1/audio/speech')) {
        captured = JSON.parse(opts.body);
        return { ok: true, arrayBuffer: async () => new Uint8Array([0]).buffer };
      }
    });

    await Kokoro.generateAudio(null, 'hi', null);
    expect(captured.voice).toBe('af_bella');
  });

  it('throws clear error on non-OK response', async () => {
    global.fetch = vi.fn(async (url) => {
      if (url.endsWith('/api/status/capabilities')) {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: false, status: 500, text: async () => '{"detail":"bad voice"}' };
    });

    await expect(Kokoro.generateAudio(null, 'x', 'unknown')).rejects.toThrow(/Kokoro TTS error \(500\).*bad voice/);
  });
});

describe('TTSService facade — Kokoro integration (Phase 3 §4.4)', () => {
  it('PROVIDERS map includes kokoro', () => {
    expect(TTSService.PROVIDERS.kokoro).toBeDefined();
    expect(TTSService.PROVIDERS.kokoro.PROVIDER_ID).toBe('kokoro');
    expect(TTSService.PROVIDERS.elevenlabs).toBeDefined();
    expect(TTSService.PROVIDERS.openai).toBeDefined();
  });

  it('isAvailable returns true for kokoro without an API key', () => {
    // Mock db that reports tts_provider=kokoro
    const settings = { tts_provider: 'kokoro' };
    const db = {
      prepare: () => ({
        get: (...args) => {
          const key = args[args.length - 1] || args[0];
          if (typeof key === 'string' && settings[key] != null) {
            return { value: settings[key] };
          }
          return null;
        }
      })
    };
    const result = TTSService.isAvailable(db);
    expect(result.available).toBe(true);
    expect(result.provider).toBe('kokoro');
  });

  it('getApiKey returns null for kokoro (signals "no auth needed", not "missing")', () => {
    const settings = { tts_provider: 'kokoro' };
    const db = {
      prepare: () => ({
        get: () => settings.tts_provider ? { value: settings.tts_provider } : null
      })
    };
    expect(TTSService.getApiKey(db)).toBe(null);
  });

  it('getProviderDefaults("kokoro") returns Kokoro\'s gendered defaults', () => {
    const defaults = TTSService.getProviderDefaults('kokoro');
    expect(defaults.female.id).toBe('af_bella');
    expect(defaults.male.id).toBe('am_adam');
  });
});
