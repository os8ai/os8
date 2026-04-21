import { describe, it, expect } from 'vitest';

const TTSService = require('../../src/services/tts');

describe('TTSService PROVIDER_LABELS / PROVIDER_HELP — single source of truth', () => {
  it('every provider in PROVIDERS has a label', () => {
    for (const id of Object.keys(TTSService.PROVIDERS)) {
      expect(TTSService.PROVIDER_LABELS[id], `missing label for provider ${id}`).toBeDefined();
      expect(typeof TTSService.PROVIDER_LABELS[id]).toBe('string');
      expect(TTSService.PROVIDER_LABELS[id].length).toBeGreaterThan(0);
    }
  });

  it('every provider in PROVIDERS has help text', () => {
    for (const id of Object.keys(TTSService.PROVIDERS)) {
      expect(TTSService.PROVIDER_HELP[id], `missing help for provider ${id}`).toBeDefined();
      expect(typeof TTSService.PROVIDER_HELP[id]).toBe('string');
    }
  });

  it('PROVIDER_LABELS has no extras beyond PROVIDERS', () => {
    const providerIds = new Set(Object.keys(TTSService.PROVIDERS));
    for (const id of Object.keys(TTSService.PROVIDER_LABELS)) {
      expect(providerIds.has(id), `stale label for non-existent provider ${id}`).toBe(true);
    }
  });

  it('Kokoro label flags it as local so the user knows', () => {
    expect(TTSService.PROVIDER_LABELS.kokoro.toLowerCase()).toContain('local');
  });
});
