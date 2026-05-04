// Phase 4 PR 4.10 — scoped-API origin allowlist smoke.
// Phase 5 PR 5.3 — strict middleware (PR 4.6) is now the production
// behavior. The previously-tagged `@strict` assertion now runs
// unconditionally; the only env-gated path is the rollback escape
// hatch (OS8_REQUIRE_APP_CONTEXT_PERMISSIVE=1) where the legacy
// permissive behavior re-engages.
//
// Exercises the origin-based allowlist that PR 4.6's strict
// `requireAppContext` flip relies on. The harness probes
// `/api/apps` and `/api/agents` with various Origin headers and
// asserts the expected accept/reject outcomes:
//
//   - Origin: http://localhost:8888  (shell + native React origin) → 200
//   - Origin: http://attacker.example                              → 403
//   - X-OS8-App-Id: <id>                                           → 200 (header path)

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

  test('untrusted origin (external app) is rejected', async () => {
    // PR 5.3 — strict middleware is now production; this assertion no
    // longer needs the OS8_4_6_STRICT env gate. Only skipped when the
    // operator has explicitly enabled the rollback escape hatch.
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

    // Server-side `requireAppContext` middleware reads `req.headers.origin`
    // verbatim. Strict-mode (PR 4.6, production): 403.
    expect(status).toBe(403);
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
