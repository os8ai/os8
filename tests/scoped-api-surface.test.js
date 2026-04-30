import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const Database = require('better-sqlite3');
const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

const FOO_MANIFEST_YAML = (caps) => `
schemaVersion: 1
slug: foo
name: Foo
publisher: tester
upstream:
  git: https://example.test/foo.git
  ref: v1.0.0
framework: vite
runtime:
  kind: node
  arch: [arm64, x86_64]
  package_manager: npm
  dependency_strategy: frozen
install: []
start:
  argv: ["npm", "run", "dev"]
  port: detect
surface:
  kind: web
permissions:
  network:
    outbound: true
    inbound: false
  filesystem: app-private
  os8_capabilities: ${JSON.stringify(caps)}
legal:
  license: MIT
  commercial_use: unrestricted
review:
  channel: verified
`.trim();

describe('scoped-api-surface — resolveCapability', () => {
  let resolveCapability;
  beforeEach(() => {
    delete require.cache[require.resolve('../src/services/scoped-api-surface')];
    ({ resolveCapability } = require('../src/services/scoped-api-surface'));
  });

  it('GET /blob/* requires read or write', () => {
    expect(resolveCapability('/blob/x', 'GET')).toEqual(['blob.readonly', 'blob.readwrite']);
  });
  it('PUT /blob/* requires write', () => {
    expect(resolveCapability('/blob/x', 'PUT')).toEqual(['blob.readwrite']);
  });
  it('DELETE /blob/* requires write', () => {
    expect(resolveCapability('/blob/x', 'DELETE')).toEqual(['blob.readwrite']);
  });
  it('POST /db/query requires read or write', () => {
    expect(resolveCapability('/db/query', 'POST')).toEqual(['db.readonly', 'db.readwrite']);
  });
  it('POST /db/execute requires write', () => {
    expect(resolveCapability('/db/execute', 'POST')).toEqual(['db.readwrite']);
  });
  it('telegram/send requires telegram.send', () => {
    expect(resolveCapability('/telegram/send', 'POST')).toEqual(['telegram.send']);
  });
  it('imagegen/* requires imagegen', () => {
    expect(resolveCapability('/imagegen/draw', 'POST')).toEqual(['imagegen']);
  });
  it('GET google/calendar/* allows readonly OR readwrite', () => {
    expect(resolveCapability('/google/calendar/events', 'GET')).toEqual([
      'google.calendar.readonly', 'google.calendar.readwrite',
    ]);
  });
  it('POST google/calendar/* requires readwrite', () => {
    expect(resolveCapability('/google/calendar/events', 'POST')).toEqual([
      'google.calendar.readwrite',
    ]);
  });
  it('mcp/<server>/<tool> resolves to fine-grained + wildcard', () => {
    expect(resolveCapability('/mcp/tavily/search', 'POST')).toEqual([
      'mcp.tavily.search', 'mcp.tavily.*',
    ]);
  });
  it('returns null for unknown paths', () => {
    expect(resolveCapability('/unknown/foo', 'GET')).toBeNull();
    expect(resolveCapability('/', 'GET')).toBeNull();
  });
});

describe('scoped-api-surface — isCapabilityAllowed', () => {
  let isCapabilityAllowed;
  beforeEach(() => {
    delete require.cache[require.resolve('../src/services/scoped-api-surface')];
    ({ isCapabilityAllowed } = require('../src/services/scoped-api-surface'));
  });

  it('exact match passes', () => {
    expect(isCapabilityAllowed(['blob.readwrite'], ['blob.readwrite'])).toBe(true);
  });
  it('any-of: at least one match passes', () => {
    expect(isCapabilityAllowed(['blob.readonly', 'blob.readwrite'], ['blob.readonly'])).toBe(true);
  });
  it('no overlap rejects', () => {
    expect(isCapabilityAllowed(['blob.readwrite'], ['blob.readonly'])).toBe(false);
  });
  it('mcp wildcard declared permits any tool', () => {
    expect(isCapabilityAllowed(['mcp.tavily.search', 'mcp.tavily.*'], ['mcp.tavily.*'])).toBe(true);
  });
  it('mcp specific declared does NOT permit other tools', () => {
    expect(isCapabilityAllowed(['mcp.tavily.extract', 'mcp.tavily.*'], ['mcp.tavily.search'])).toBe(false);
  });
  it('empty declared rejects everything', () => {
    expect(isCapabilityAllowed(['blob.readwrite'], [])).toBe(false);
  });
});

describe('scoped-api-surface — middleware end-to-end', () => {
  let db, tmpHome, prevHome, MIGRATION, scopedApiMiddleware;
  let middleware;

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-scoped-'));
    prevHome = process.env.OS8_HOME;
    process.env.OS8_HOME = tmpHome;
    [
      '../src/config',
      '../src/migrations/0.5.0-app-store',
      '../src/services/scoped-api-surface',
      '../src/services/app',
    ].forEach(p => { delete require.cache[require.resolve(p)]; });

    MIGRATION = require('../src/migrations/0.5.0-app-store');
    ({ scopedApiMiddleware } = require('../src/services/scoped-api-surface'));

    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE apps (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        status TEXT DEFAULT 'active',
        display_order INTEGER DEFAULT 0,
        color TEXT DEFAULT '#6366f1',
        icon TEXT,
        text_color TEXT DEFAULT '#ffffff',
        archived_at TEXT,
        app_type TEXT DEFAULT 'regular',
        created_at TEXT, updated_at TEXT
      );
      CREATE TABLE app_env_variables (
        id TEXT PRIMARY KEY,
        app_id TEXT REFERENCES apps(id) ON DELETE CASCADE,
        key TEXT NOT NULL, value TEXT NOT NULL,
        UNIQUE(app_id, key)
      );
    `);
    await MIGRATION.up({ db, logger: silentLogger });
    middleware = scopedApiMiddleware(db);
  });

  afterEach(() => {
    db.close();
    if (prevHome === undefined) delete process.env.OS8_HOME;
    else process.env.OS8_HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function seedExternal(slug, caps) {
    const id = `id-${slug}`;
    db.prepare(`
      INSERT INTO apps (id, name, slug, app_type, status, manifest_yaml)
      VALUES (?, ?, ?, 'external', 'active', ?)
    `).run(id, slug, slug, FOO_MANIFEST_YAML(caps));
    return id;
  }

  function fakeReqRes({ host, method = 'GET', urlPath } = {}) {
    const req = { headers: { host }, method, url: urlPath, path: urlPath };
    let statusCode = 200, body = null, ended = false;
    const res = {
      status(c) { statusCode = c; return res; },
      json(b)   { body = b; ended = true; return res; },
    };
    let nextCalled = false;
    const next = () => { nextCalled = true; };
    return { req, res, next, get statusCode() { return statusCode; }, get body() { return body; },
             get nextCalled() { return nextCalled; }, get ended() { return ended; } };
  }

  it('passes through bare-localhost requests', () => {
    seedExternal('foo', ['blob.readonly']);
    const r = fakeReqRes({ host: 'localhost:8888', urlPath: '/_os8/api/blob/x', method: 'GET' });
    middleware(r.req, r.res, r.next);
    expect(r.nextCalled).toBe(true);
    // No rewrite happened.
    expect(r.req.url).toBe('/_os8/api/blob/x');
  });

  it('passes through subdomain non-API requests (proxy claims them)', () => {
    seedExternal('foo', ['blob.readonly']);
    const r = fakeReqRes({ host: 'foo.localhost:8888', urlPath: '/some/page' });
    middleware(r.req, r.res, r.next);
    expect(r.nextCalled).toBe(true);
    expect(r.req.url).toBe('/some/page');
  });

  it('GET /_os8/api/blob/x with blob.readonly → rewritten + req.callerAppId set', () => {
    const id = seedExternal('foo', ['blob.readonly']);
    const r = fakeReqRes({ host: 'foo.localhost:8888', urlPath: '/_os8/api/blob/x', method: 'GET' });
    middleware(r.req, r.res, r.next);
    expect(r.nextCalled).toBe(true);
    expect(r.req.url).toBe(`/api/apps/${id}/blob/x`);
    expect(r.req.callerAppId).toBe(id);
    expect(r.req.headers['x-os8-app-id']).toBe(id);
  });

  it('PUT /_os8/api/blob/x with only blob.readonly → 403', () => {
    seedExternal('foo', ['blob.readonly']);
    const r = fakeReqRes({ host: 'foo.localhost:8888', urlPath: '/_os8/api/blob/x', method: 'PUT' });
    middleware(r.req, r.res, r.next);
    expect(r.nextCalled).toBe(false);
    expect(r.statusCode).toBe(403);
    expect(r.body.error).toBe('capability not declared');
    expect(r.body.required).toEqual(['blob.readwrite']);
  });

  it('regular (non-external) app → 404', () => {
    db.prepare(`
      INSERT INTO apps (id, name, slug, app_type) VALUES ('reg-1', 'Reg', 'reg', 'regular')
    `).run();
    const r = fakeReqRes({ host: 'reg.localhost:8888', urlPath: '/_os8/api/blob/x' });
    middleware(r.req, r.res, r.next);
    expect(r.statusCode).toBe(404);
    expect(r.body.error).toBe('not an external app');
  });

  it('unknown subdomain → 404', () => {
    const r = fakeReqRes({ host: 'unknown.localhost:8888', urlPath: '/_os8/api/blob/x' });
    middleware(r.req, r.res, r.next);
    expect(r.statusCode).toBe(404);
  });

  it('mcp wildcard: declared mcp.tavily.* permits POST /_os8/api/mcp/tavily/search', () => {
    const id = seedExternal('foo', ['mcp.tavily.*']);
    const r = fakeReqRes({ host: 'foo.localhost:8888', urlPath: '/_os8/api/mcp/tavily/search', method: 'POST' });
    middleware(r.req, r.res, r.next);
    expect(r.nextCalled).toBe(true);
    expect(r.req.url).toBe(`/api/mcp/tavily/search`);
    expect(r.req.callerAppId).toBe(id);
  });

  it('mcp specific: declared mcp.tavily.search rejects /tavily/extract', () => {
    seedExternal('foo', ['mcp.tavily.search']);
    const r = fakeReqRes({ host: 'foo.localhost:8888', urlPath: '/_os8/api/mcp/tavily/extract', method: 'POST' });
    middleware(r.req, r.res, r.next);
    expect(r.statusCode).toBe(403);
  });

  it('shared route /_os8/api/imagegen/draw rewrites to /api/imagegen/draw', () => {
    const id = seedExternal('foo', ['imagegen']);
    const r = fakeReqRes({ host: 'foo.localhost:8888', urlPath: '/_os8/api/imagegen/draw', method: 'POST' });
    middleware(r.req, r.res, r.next);
    expect(r.nextCalled).toBe(true);
    expect(r.req.url).toBe('/api/imagegen/draw');
    expect(r.req.callerAppId).toBe(id);
  });

  it('unknown api path → 404', () => {
    seedExternal('foo', ['blob.readwrite']);
    const r = fakeReqRes({ host: 'foo.localhost:8888', urlPath: '/_os8/api/nonsense' });
    middleware(r.req, r.res, r.next);
    expect(r.statusCode).toBe(404);
    expect(r.body.error).toBe('unknown scoped api path');
  });
});
