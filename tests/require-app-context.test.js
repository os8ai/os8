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

  it('passes through without the header (permissive v1)', () => {
    const r = fakeReqRes({});
    requireAppContext(r.req, r.res, r.next);
    expect(r.req.callerAppId).toBeUndefined();
    expect(r.nextCalled).toBe(true);
    expect(r.statusCode).toBe(200);   // never invoked res.status
  });

  it('preserves an empty header (treats as missing)', () => {
    const r = fakeReqRes({ 'x-os8-app-id': '' });
    requireAppContext(r.req, r.res, r.next);
    expect(r.req.callerAppId).toBeUndefined();
    expect(r.nextCalled).toBe(true);
  });

  it('does not transform truthy values (just passes through)', () => {
    const r = fakeReqRes({ 'x-os8-app-id': 'wm-1' });
    requireAppContext(r.req, r.res, r.next);
    expect(r.req.callerAppId).toBe('wm-1');
  });
});
