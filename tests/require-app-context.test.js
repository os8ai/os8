import { describe, it, expect } from 'vitest';

const requireAppContext = require('../src/middleware/require-app-context');

function fakeReqRes(headers = {}) {
  const req = { headers };
  let statusCode = 200, body = null;
  const res = {
    status(c) { statusCode = c; return res; },
    json(b)   { body = b; return res; },
  };
  let nextCalled = false;
  const next = () => { nextCalled = true; };
  return {
    req, res, next,
    get statusCode() { return statusCode; },
    get body() { return body; },
    get nextCalled() { return nextCalled; },
  };
}

describe('requireAppContext', () => {
  it('sets req.callerAppId from the X-OS8-App-Id header', () => {
    const r = fakeReqRes({ 'x-os8-app-id': 'app-123' });
    requireAppContext(r.req, r.res, r.next);
    expect(r.req.callerAppId).toBe('app-123');
    expect(r.nextCalled).toBe(true);
  });

  // PR 4.6 (Phase 4) — flipped to strict. Without a header AND without a
  // trusted origin AND without the internal-call-token, the request is
  // rejected. The full strict-mode surface is exercised in
  // tests/require-app-context.strict.test.js; these two cases are kept
  // here as the canonical "no plausible identity" regression test.
  it('rejects requests with no header / no origin / no token (strict)', () => {
    const prev = process.env.OS8_REQUIRE_APP_CONTEXT_PERMISSIVE;
    delete process.env.OS8_REQUIRE_APP_CONTEXT_PERMISSIVE;
    try {
      const r = fakeReqRes({});
      requireAppContext(r.req, r.res, r.next);
      expect(r.req.callerAppId).toBeUndefined();
      expect(r.nextCalled).toBe(false);
      expect(r.statusCode).toBe(403);
    } finally {
      if (prev === undefined) delete process.env.OS8_REQUIRE_APP_CONTEXT_PERMISSIVE;
      else process.env.OS8_REQUIRE_APP_CONTEXT_PERMISSIVE = prev;
    }
  });

  it('rejects an empty header same as missing (strict)', () => {
    const prev = process.env.OS8_REQUIRE_APP_CONTEXT_PERMISSIVE;
    delete process.env.OS8_REQUIRE_APP_CONTEXT_PERMISSIVE;
    try {
      const r = fakeReqRes({ 'x-os8-app-id': '' });
      requireAppContext(r.req, r.res, r.next);
      expect(r.req.callerAppId).toBeUndefined();
      expect(r.nextCalled).toBe(false);
      expect(r.statusCode).toBe(403);
    } finally {
      if (prev === undefined) delete process.env.OS8_REQUIRE_APP_CONTEXT_PERMISSIVE;
      else process.env.OS8_REQUIRE_APP_CONTEXT_PERMISSIVE = prev;
    }
  });

  it('does not transform truthy values (just passes through)', () => {
    const r = fakeReqRes({ 'x-os8-app-id': 'wm-1' });
    requireAppContext(r.req, r.res, r.next);
    expect(r.req.callerAppId).toBe('wm-1');
  });
});
