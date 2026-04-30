import { describe, it, expect, beforeEach, vi } from 'vitest';

const { parseProtocolUrl, handleProtocolUrl, setProtocolDeps } = require('../src/services/protocol-handler');

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

describe('handleProtocolUrl — dispatch (PR 1.18)', () => {
  let send, mainWindow, db, AppCatalogService;

  beforeEach(() => {
    send = vi.fn();
    mainWindow = {
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: vi.fn(),
      focus: vi.fn(),
      webContents: { send },
    };
    db = {};
    AppCatalogService = {
      get: vi.fn(),
      fetchManifest: vi.fn(),
    };
    // Reset deps to a known state.
    setProtocolDeps(null);
  });

  it('warns and returns on rejected URL', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setProtocolDeps({ db, AppCatalogService });
    await handleProtocolUrl('os8://wat?bad=y', mainWindow);
    expect(warn).toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('queues the URL when deps not set, drains on setProtocolDeps', async () => {
    const url = `os8://install?slug=worldmonitor&commit=${VALID_SHA}&channel=verified`;
    AppCatalogService.get.mockResolvedValue({
      slug: 'worldmonitor',
      upstreamResolvedCommit: VALID_SHA,
    });
    // No deps yet — handler queues.
    await handleProtocolUrl(url, mainWindow);
    expect(send).not.toHaveBeenCalled();

    // Setting deps drains the queue.
    setProtocolDeps({ db, AppCatalogService });
    // Drain dispatch is async via Promise; wait a tick.
    await new Promise(r => setTimeout(r, 5));
    expect(send).toHaveBeenCalledWith('app-store:open-install-plan', expect.objectContaining({
      slug: 'worldmonitor',
      commit: VALID_SHA,
      channel: 'verified',
    }));
  });

  it('emits open-install-plan on local catalog hit', async () => {
    setProtocolDeps({ db, AppCatalogService });
    AppCatalogService.get.mockResolvedValue({
      slug: 'worldmonitor',
      upstreamResolvedCommit: VALID_SHA,
    });
    await handleProtocolUrl(
      `os8://install?slug=worldmonitor&commit=${VALID_SHA}&channel=verified&source=os8.ai`,
      mainWindow
    );
    expect(send).toHaveBeenCalledWith('app-store:open-install-plan', {
      slug: 'worldmonitor',
      commit: VALID_SHA,
      channel: 'verified',
      source: 'os8.ai',
    });
  });

  it('falls back to fetchManifest when local catalog misses', async () => {
    setProtocolDeps({ db, AppCatalogService });
    AppCatalogService.get.mockResolvedValue(null);
    AppCatalogService.fetchManifest.mockResolvedValue({
      slug: 'worldmonitor',
      upstreamResolvedCommit: VALID_SHA,
      manifestYaml: 'slug: worldmonitor\n',
    });
    await handleProtocolUrl(
      `os8://install?slug=worldmonitor&commit=${VALID_SHA}&channel=verified`,
      mainWindow
    );
    expect(AppCatalogService.fetchManifest).toHaveBeenCalledWith('worldmonitor', 'verified');
    expect(send).toHaveBeenCalledWith('app-store:open-install-plan', expect.objectContaining({
      slug: 'worldmonitor',
    }));
  });

  it('emits protocol-error when fetchManifest fails', async () => {
    setProtocolDeps({ db, AppCatalogService });
    AppCatalogService.get.mockResolvedValue(null);
    AppCatalogService.fetchManifest.mockRejectedValue(new Error('offline'));
    await handleProtocolUrl(
      `os8://install?slug=missingapp&commit=${VALID_SHA}&channel=verified`,
      mainWindow
    );
    expect(send).toHaveBeenCalledWith('app-store:protocol-error', expect.objectContaining({
      slug: 'missingapp',
    }));
    const errPayload = send.mock.calls[0][1];
    expect(errPayload.error).toMatch(/offline/);
  });

  it('refuses on commit mismatch', async () => {
    setProtocolDeps({ db, AppCatalogService });
    AppCatalogService.get.mockResolvedValue({
      slug: 'worldmonitor',
      upstreamResolvedCommit: 'b'.repeat(40),
    });
    await handleProtocolUrl(
      `os8://install?slug=worldmonitor&commit=${VALID_SHA}&channel=verified`,
      mainWindow
    );
    expect(send).toHaveBeenCalledWith('app-store:protocol-error', expect.objectContaining({
      slug: 'worldmonitor',
    }));
    expect(send.mock.calls[0][1].error).toMatch(/Commit mismatch/);
  });

  it('focuses the window on dispatch', async () => {
    setProtocolDeps({ db, AppCatalogService });
    AppCatalogService.get.mockResolvedValue({
      slug: 'worldmonitor',
      upstreamResolvedCommit: VALID_SHA,
    });
    mainWindow.isMinimized = () => true;
    await handleProtocolUrl(
      `os8://install?slug=worldmonitor&commit=${VALID_SHA}&channel=verified`,
      mainWindow
    );
    expect(mainWindow.restore).toHaveBeenCalled();
    expect(mainWindow.focus).toHaveBeenCalled();
  });
});
