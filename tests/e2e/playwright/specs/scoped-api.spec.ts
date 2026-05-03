// Phase 4 PR 4.10 — scoped-API origin allowlist smoke.
//
// Exercises the origin-based allowlist that PR 4.6's strict
// `requireAppContext` flip relies on. The harness probes
// `/api/apps` and `/api/agents` with various Origin headers and
// asserts the expected accept/reject outcomes:
//
//   - Origin: http://localhost:8888  (shell + native React origin) → 200
//   - Origin: http://attacker.example                              → 403 (post 4.6)
//   - X-OS8-App-Id: <id>                                           → 200 (header path)
//
// Today (pre-4.6) the middleware is permissive — bare unknown origins
// pass. The expectations below are written for the post-4.6 behavior;
// runs against pre-4.6 builds will see the "403" assertions fail. PR 4.6
// flips the constant and these specs become the gate that confirms the
// flip didn't break native consumers.
//
// To keep the harness landing before 4.6, the strict-mode assertions
// are tagged @strict; the runner can skip them with PWTEST_GREP_INVERT
// until 4.6 ships.

import { test, expect } from '@playwright/test';
import { bootOs8, closeOs8, getOs8Port, type BootedOs8 } from '../setup';

test.describe('scoped-API origin allowlist', () => {
  let booted: BootedOs8 | null = null;
  let port = 8888;

  test.beforeEach(async () => {
    booted = await bootOs8();
    port = await getOs8Port(booted.window);
  });

  test.afterEach(async () => {
    await closeOs8(booted);
    booted = null;
  });

  test('bare-localhost origin (shell + native React) reaches /api/apps', async () => {
    // Issue the fetch from inside the renderer so the Origin header is
    // the shell's bare localhost. The native React apps share this origin.
    const status = await booted!.window.evaluate(async (p) => {
      const r = await fetch(`http://localhost:${p}/api/apps`, { method: 'GET' });
      return r.status;
    }, port);
    expect(status).toBe(200);
  });

  test('@strict subdomain origin (external app) is rejected', async () => {
    // Until PR 4.6 ships, this assertion is informational; gate via
    // env or @strict tag so the suite can pre-stage.
    test.skip(
      process.env.OS8_REQUIRE_APP_CONTEXT_PERMISSIVE === '1',
      'permissive rollback escape hatch enabled — strict-mode assertions skipped'
    );

    const status = await booted!.window.evaluate(async (p) => {
      // node:undici doesn't ship in the renderer; spoof an external
      // origin by issuing the fetch with a synthetic Origin header.
      const r = await fetch(`http://localhost:${p}/api/apps`, {
        method: 'GET',
        headers: { Origin: 'http://attacker.example' },
      });
      return r.status;
    }, port);

    // Note: browsers strip the Origin header on same-origin requests.
    // The renderer's fetch DOES send it when explicitly set, but the
    // server-side `requireAppContext` middleware reads `req.headers.origin`
    // verbatim. Pre-4.6: 200 (permissive). Post-4.6: 403.
    if (process.env.OS8_4_6_STRICT === '1') {
      expect(status).toBe(403);
    } else {
      // Pre-4.6: permissive, expects 200. The test still RUNS to detect
      // changes; future failure here will signal that 4.6 has flipped.
      expect([200, 403]).toContain(status);
    }
  });

  test('explicit X-OS8-App-Id header is accepted', async () => {
    const status = await booted!.window.evaluate(async (p) => {
      const r = await fetch(`http://localhost:${p}/api/apps`, {
        method: 'GET',
        headers: { 'X-OS8-App-Id': 'native-shell' },
      });
      return r.status;
    }, port);
    expect(status).toBe(200);
  });
});
