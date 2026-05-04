// Phase 4 PR 4.10 — native React app load smoke.
// Phase 5 PR 5.3 — un-skipped now that PR 4.6 (strict middleware) is
// production. This spec is the regression-class guard: if the strict
// allowlist accidentally rejects the bare-localhost origin for some
// reason, the native app's index returns 403 and this spec catches it.
//
// Verifies that with a fresh OS8_HOME, OS8 can scaffold a native React
// app via the existing `/api/apps` endpoint, and the resulting app
// loads at `localhost:<port>/<id>/`.

import { test, expect } from '@playwright/test';
import { bootOs8, closeOs8, getOs8Port, type BootedOs8 } from '../setup';

test.describe('native app loads under strict middleware', () => {
  let booted: BootedOs8 | null = null;

  test.afterEach(async () => {
    await closeOs8(booted);
    booted = null;
  });

  test('scaffolds a native app and loads its index', async () => {
    booted = await bootOs8();
    const port = await getOs8Port(booted.window);

    // Create a minimal native app via the existing IPC bridge.
    // window.os8.apps.create(name, color, icon, textColor) per preload.js:15.
    const appId = await booted.window.evaluate(async () => {
      const w = globalThis as unknown as {
        os8: { apps: { create: (
          name: string, color?: string, icon?: string, textColor?: string
        ) => Promise<{ id: string }> } };
      };
      const r = await w.os8.apps.create('E2E Test App');
      return r.id;
    });
    expect(appId).toMatch(/^\d{13}-/);

    // The native app loads at localhost:<port>/<id>/. Hitting that URL
    // exercises the bare-localhost origin path through Vite middleware
    // — the same path PR 4.6's strict allowlist must continue to allow.
    const html = await booted.window.evaluate(async (args) => {
      const r = await fetch(`http://localhost:${args.port}/${args.id}/`);
      return { status: r.status, contentType: r.headers.get('content-type') };
    }, { port, id: appId });
    expect(html.status).toBe(200);
    expect(html.contentType || '').toMatch(/text\/html/);
  });
});
