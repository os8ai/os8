// Phase 4 PR 4.10 — native React app load smoke.
//
// Verifies that with a fresh OS8_HOME, OS8 can scaffold a native React
// app via the existing `/api/apps` endpoint, and the resulting app
// loads at `localhost:<port>/<id>/`. This is the "native app still
// works after the strict-mode flip" piece of PR 4.6's gate (G3 in the
// plan §6).
//
// Skipped today; native-app scaffold path is exercised by unit tests
// elsewhere. Re-enable when PR 4.6 lands so we have a regression-class
// guard: if the strict middleware rejects the bare-localhost origin
// for some reason, this spec catches it.

import { test, expect } from '@playwright/test';
import { bootOs8, closeOs8, getOs8Port, type BootedOs8 } from '../setup';

test.describe.skip('native app loads under strict middleware', () => {
  let booted: BootedOs8 | null = null;

  test.afterEach(async () => {
    await closeOs8(booted);
    booted = null;
  });

  test('scaffolds a native app and loads its index', async () => {
    booted = await bootOs8();
    const port = await getOs8Port(booted.window);

    // Create a minimal native app via the existing IPC bridge.
    // window.os8.apps.create() is the renderer-side helper.
    const appId = await booted.window.evaluate(async () => {
      const w = globalThis as unknown as {
        os8: { apps: { create: (opts: { name: string; slug?: string }) => Promise<{ id: string }> } };
      };
      const r = await w.os8.apps.create({ name: 'E2E Test App' });
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
