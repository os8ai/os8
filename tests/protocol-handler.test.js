import { describe, it, expect } from 'vitest';

const { parseProtocolUrl } = require('../src/services/protocol-handler');

const VALID_SHA = 'e51058e1765ef2f0c83ccb1d08d984bc59d23f10';

describe('parseProtocolUrl', () => {
  it('accepts a valid os8://install with all fields', () => {
    const r = parseProtocolUrl(`os8://install?slug=worldmonitor&commit=${VALID_SHA}&channel=verified&source=os8.ai`);
    expect(r).toEqual({
      ok: true,
      action: 'install',
      slug: 'worldmonitor',
      commit: VALID_SHA,
      channel: 'verified',
      source: 'os8.ai',
    });
  });

  it('defaults source to null when missing', () => {
    const r = parseProtocolUrl(`os8://install?slug=worldmonitor&commit=${VALID_SHA}&channel=verified`);
    expect(r.ok).toBe(true);
    expect(r.source).toBeNull();
  });

  it('defaults channel to verified when missing', () => {
    const r = parseProtocolUrl(`os8://install?slug=worldmonitor&commit=${VALID_SHA}`);
    expect(r.ok).toBe(true);
    expect(r.channel).toBe('verified');
  });

  it('accepts the community channel', () => {
    const r = parseProtocolUrl(`os8://install?slug=worldmonitor&commit=${VALID_SHA}&channel=community`);
    expect(r.ok).toBe(true);
    expect(r.channel).toBe('community');
  });

  it('accepts developer-import channel', () => {
    const r = parseProtocolUrl(`os8://install?slug=worldmonitor&commit=${VALID_SHA}&channel=developer-import`);
    expect(r.ok).toBe(true);
    expect(r.channel).toBe('developer-import');
  });

  it('rejects bad channel value', () => {
    const r = parseProtocolUrl(`os8://install?slug=worldmonitor&commit=${VALID_SHA}&channel=enterprise`);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('bad channel');
  });

  it('rejects when commit is a tag instead of SHA', () => {
    const r = parseProtocolUrl(`os8://install?slug=worldmonitor&commit=v1.4.2&channel=verified`);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('bad commit');
  });

  it('rejects when commit is the wrong length', () => {
    const r = parseProtocolUrl(`os8://install?slug=worldmonitor&commit=${VALID_SHA.slice(0, 39)}&channel=verified`);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('bad commit');
  });

  it('rejects bad slug — uppercase', () => {
    const r = parseProtocolUrl(`os8://install?slug=Bad-Slug&commit=${VALID_SHA}`);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('bad slug');
  });

  it('rejects bad slug — starts with digit', () => {
    const r = parseProtocolUrl(`os8://install?slug=2much&commit=${VALID_SHA}`);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('bad slug');
  });

  it('rejects unsupported actions', () => {
    const r = parseProtocolUrl(`os8://uninstall?slug=worldmonitor`);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unsupported action');
  });

  it('rejects wrong protocol', () => {
    const r = parseProtocolUrl(`https://os8.ai/apps/worldmonitor`);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('wrong protocol');
  });

  it('rejects empty input', () => {
    expect(parseProtocolUrl('').error).toBe('invalid url');
    expect(parseProtocolUrl(null).error).toBe('invalid url');
    expect(parseProtocolUrl(undefined).error).toBe('invalid url');
  });

  it('rejects malformed URLs', () => {
    expect(parseProtocolUrl('not a url').error).toBe('invalid url');
  });
});
