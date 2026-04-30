/**
 * Unit tests for the hardened-BrowserView helpers (PR 1.19).
 *
 * The full BrowserView lifecycle requires Electron and isn't easily
 * exercised in Node-only vitest. The two pure helpers are exported on
 * the PreviewService module so we can exercise them directly:
 *
 *   - externalWebPreferences(preloadPath?) — returns the hardened
 *     webPreferences object.
 *   - isAllowedExternalNavigation(url, host, port) — the will-navigate
 *     gate that distinguishes intra-app navigation (allow) from
 *     external links (deny + open externally).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// PreviewService imports `electron`, which isn't available in the test
// runtime. Stub it before requiring the module.
vi.mock('electron', () => ({
  BrowserView: class {},
  shell: { openExternal: vi.fn() },
}));

const { externalWebPreferences, isAllowedExternalNavigation } = require('../src/services/preview');

describe('externalWebPreferences', () => {
  it('returns the hardened defaults', () => {
    const prefs = externalWebPreferences();
    expect(prefs).toMatchObject({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      enableBlinkFeatures: '',
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      backgroundThrottling: false,
    });
  });

  it('omits preload when none is provided', () => {
    const prefs = externalWebPreferences();
    expect(prefs.preload).toBeUndefined();
  });

  it('includes preload when provided', () => {
    const prefs = externalWebPreferences('/abs/path/to/preload.js');
    expect(prefs.preload).toBe('/abs/path/to/preload.js');
  });
});

describe('isAllowedExternalNavigation', () => {
  const HOST = 'worldmonitor.localhost';
  const PORT = 8888;

  it('allows same-host same-port navigation', () => {
    expect(isAllowedExternalNavigation('http://worldmonitor.localhost:8888/', HOST, PORT)).toBe(true);
    expect(isAllowedExternalNavigation('http://worldmonitor.localhost:8888/foo/bar', HOST, PORT)).toBe(true);
  });

  it('allows same-host without an explicit port (browser default 80/443)', () => {
    // No port specified — browser uses default; the gate accepts it.
    expect(isAllowedExternalNavigation('http://worldmonitor.localhost/foo', HOST, PORT)).toBe(true);
  });

  it('denies a different external app subdomain', () => {
    expect(isAllowedExternalNavigation('http://other-app.localhost:8888/', HOST, PORT)).toBe(false);
  });

  it('denies the OS8 main shell at bare localhost', () => {
    expect(isAllowedExternalNavigation('http://localhost:8888/api/apps', HOST, PORT)).toBe(false);
  });

  it('denies external HTTPS sites', () => {
    expect(isAllowedExternalNavigation('https://google.com/search?q=foo', HOST, PORT)).toBe(false);
  });

  it('denies the wrong port on the right host', () => {
    expect(isAllowedExternalNavigation('http://worldmonitor.localhost:9999/', HOST, PORT)).toBe(false);
  });

  it('denies non-http(s) protocols', () => {
    expect(isAllowedExternalNavigation('file:///etc/passwd', HOST, PORT)).toBe(false);
    expect(isAllowedExternalNavigation('javascript:alert(1)', HOST, PORT)).toBe(false);
    expect(isAllowedExternalNavigation('os8://install?slug=x', HOST, PORT)).toBe(false);
  });

  it('denies malformed URLs', () => {
    expect(isAllowedExternalNavigation('not a url', HOST, PORT)).toBe(false);
    expect(isAllowedExternalNavigation('', HOST, PORT)).toBe(false);
  });

  it('treats expectedPort as a string for comparison (URL.port is a string)', () => {
    expect(isAllowedExternalNavigation('http://worldmonitor.localhost:8888/', HOST, '8888')).toBe(true);
    expect(isAllowedExternalNavigation('http://worldmonitor.localhost:8888/', HOST, 8888)).toBe(true);
  });
});
