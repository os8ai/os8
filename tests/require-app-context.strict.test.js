/**
 * Phase 4 PR 4.6 — strict requireAppContext middleware tests.
 *
 * Exercises the post-flip behavior:
 *   - Header path always wins.
 *   - Origin: localhost:8888 → trusted (shell + native React).
 *   - Origin: subdomain → 403.
 *   - Internal token header → trusted (server→server fetches).
 *   - Permissive escape hatch (env) → v1 behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let middleware;
let originIsTrusted;

function loadMiddleware() {
  delete require.cache[require.resolve('../src/middleware/require-app-context')];
  const m = require('../src/middleware/require-app-context');
  middleware = m;
  originIsTrusted = m.originIsTrusted;
}

function makeReqRes(opts = {}) {
  const req = {
    method: opts.method || 'GET',
    path: opts.path || '/api/apps',
    headers: opts.headers || {},
  };
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return { req, res };
}

describe('originIsTrusted (PR 4.6)', () => {
  beforeEach(() => loadMiddleware());

  it('localhost on the OS8 port is trusted', () => {
    process.env.OS8_PORT = '8888';
    expect(originIsTrusted('http://localhost:8888')).toBe(true);
  });
  it('127.0.0.1 on the OS8 port is trusted', () => {
    process.env.OS8_PORT = '8888';
    expect(originIsTrusted('http://127.0.0.1:8888')).toBe(true);
  });
  it('localhost on a different port is NOT trusted', () => {
    process.env.OS8_PORT = '8888';
    expect(originIsTrusted('http://localhost:7777')).toBe(false);
  });
  it('subdomain.localhost is NOT trusted', () => {
    process.env.OS8_PORT = '8888';
    expect(originIsTrusted('http://worldmonitor.localhost:8888')).toBe(false);
  });
  it('arbitrary external origin is NOT trusted', () => {
    process.env.OS8_PORT = '8888';
    expect(originIsTrusted('http://attacker.example')).toBe(false);
  });
  it('honors OS8_PORT env override', () => {
    process.env.OS8_PORT = '9999';
    expect(originIsTrusted('http://localhost:9999')).toBe(true);
    expect(originIsTrusted('http://localhost:8888')).toBe(false);
  });
  it('returns false for empty / malformed origin', () => {
    process.env.OS8_PORT = '8888';
    expect(originIsTrusted('')).toBe(false);
    expect(originIsTrusted('not-a-url')).toBe(false);
    expect(originIsTrusted(undefined)).toBe(false);
  });
});

describe('requireAppContext middleware — strict (PR 4.6)', () => {
  let prevPermissive;
  let prevToken;
  let prevPort;
  let prevDebug;

  beforeEach(() => {
    prevPermissive = process.env.OS8_REQUIRE_APP_CONTEXT_PERMISSIVE;
    prevToken = process.env.OS8_INTERNAL_CALL_TOKEN;
    prevPort = process.env.OS8_PORT;
    prevDebug = process.env.OS8_DEBUG;
    delete process.env.OS8_REQUIRE_APP_CONTEXT_PERMISSIVE;
    delete process.env.OS8_INTERNAL_CALL_TOKEN;
    process.env.OS8_PORT = '8888';
    delete process.env.OS8_DEBUG;
    loadMiddleware();
  });
  afterEach(() => {
    if (prevPermissive === undefined) delete process.env.OS8_REQUIRE_APP_CONTEXT_PERMISSIVE;
    else process.env.OS8_REQUIRE_APP_CONTEXT_PERMISSIVE = prevPermissive;
    if (prevToken === undefined) delete process.env.OS8_INTERNAL_CALL_TOKEN;
    else process.env.OS8_INTERNAL_CALL_TOKEN = prevToken;
    if (prevPort === undefined) delete process.env.OS8_PORT;
    else process.env.OS8_PORT = prevPort;
    if (prevDebug === undefined) delete process.env.OS8_DEBUG;
    else process.env.OS8_DEBUG = prevDebug;
  });

  it('header path: X-OS8-App-Id sets req.callerAppId and passes', () => {
    const { req, res } = makeReqRes({ headers: { 'x-os8-app-id': 'app-xyz' } });
    const next = vi.fn();
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.callerAppId).toBe('app-xyz');
    expect(res.statusCode).toBe(null);
  });

  it('origin path: bare-localhost passes without header', () => {
    const { req, res } = makeReqRes({ headers: { origin: 'http://localhost:8888' } });
    const next = vi.fn();
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(null);
  });

  it('origin path: subdomain origin is rejected with 403', () => {
    const { req, res } = makeReqRes({ headers: { origin: 'http://worldmonitor.localhost:8888' } });
    const next = vi.fn();
    middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/app context/);
  });

  it('origin path: arbitrary external origin is rejected with 403', () => {
    const { req, res } = makeReqRes({ headers: { origin: 'http://attacker.example' } });
    const next = vi.fn();
    middleware(req, res, next);
    expect(res.statusCode).toBe(403);
  });

  it('no origin + no header + no token → 403', () => {
    const { req, res } = makeReqRes({});
    const next = vi.fn();
    middleware(req, res, next);
    expect(res.statusCode).toBe(403);
  });

  it('internal token path: matching X-OS8-Internal-Token passes', () => {
    process.env.OS8_INTERNAL_CALL_TOKEN = 'secret-abc';
    loadMiddleware();
    const { req, res } = makeReqRes({ headers: { 'x-os8-internal-token': 'secret-abc' } });
    const next = vi.fn();
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('internal token path: wrong token is rejected', () => {
    process.env.OS8_INTERNAL_CALL_TOKEN = 'secret-abc';
    loadMiddleware();
    const { req, res } = makeReqRes({ headers: { 'x-os8-internal-token': 'wrong' } });
    const next = vi.fn();
    middleware(req, res, next);
    expect(res.statusCode).toBe(403);
  });

  it('internal token path: unset token rejects even matching empty', () => {
    // OS8_INTERNAL_CALL_TOKEN unset → empty token → header check requires
    // a non-empty match, so an attacker setting the header doesn't slip through.
    const { req, res } = makeReqRes({ headers: { 'x-os8-internal-token': '' } });
    const next = vi.fn();
    middleware(req, res, next);
    expect(res.statusCode).toBe(403);
  });

  it('permissive escape hatch: OS8_REQUIRE_APP_CONTEXT_PERMISSIVE=1 restores v1 behavior', () => {
    process.env.OS8_REQUIRE_APP_CONTEXT_PERMISSIVE = '1';
    loadMiddleware();
    const { req, res } = makeReqRes({}); // no header, no origin
    const next = vi.fn();
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(null);
  });

  it('header path wins even when origin is hostile', () => {
    const { req, res } = makeReqRes({
      headers: {
        'x-os8-app-id': 'app-trusted',
        origin: 'http://attacker.example',
      },
    });
    const next = vi.fn();
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.callerAppId).toBe('app-trusted');
  });

  it('referer falls back when origin is missing', () => {
    const { req, res } = makeReqRes({
      headers: { referer: 'http://localhost:8888/foo' },
    });
    const next = vi.fn();
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
