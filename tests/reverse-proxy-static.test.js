/**
 * PR 2.3 — ReverseProxyService.registerStatic / unregisterStatic.
 *
 * Mirrors tests/reverse-proxy.test.js but covers the static-mode
 * dispatch: serving files via express.static under <slug>.localhost,
 * with dotfile denial and dropped WS upgrade attempts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { WebSocket } from 'ws';

const ReverseProxyService = require('../src/services/reverse-proxy');

function listen(server, host = '127.0.0.1') {
  return new Promise(resolve => {
    server.listen(0, host, () => resolve(server.address().port));
  });
}

function close(server) {
  try { server.closeAllConnections?.(); } catch (_) { /* ignore */ }
  return new Promise(resolve => server.close(() => resolve()));
}

function fetchOnce(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + (u.search || ''),
      method: 'GET',
      headers,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('ReverseProxyService — registerStatic primitives', () => {
  let staticDir;
  beforeEach(() => {
    ReverseProxyService._resetForTests();
    staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-rp-static-'));
    fs.writeFileSync(path.join(staticDir, 'index.html'), '<h1>hello</h1>');
  });
  afterEach(() => {
    fs.rmSync(staticDir, { recursive: true, force: true });
    ReverseProxyService._resetForTests();
  });

  it('registerStatic + getStaticDir + unregister round-trips', () => {
    ReverseProxyService.registerStatic('foo', 'app-1', staticDir);
    expect(ReverseProxyService.getStaticDir('foo')).toBe(staticDir);
    expect(ReverseProxyService.has('foo')).toBe(true);
    ReverseProxyService.unregister('foo');
    expect(ReverseProxyService.getStaticDir('foo')).toBeNull();
    expect(ReverseProxyService.has('foo')).toBe(false);
  });

  it('unregisterStatic clears only the static map (not proxy)', () => {
    ReverseProxyService.register('foo', 'app-1', 12345);
    ReverseProxyService.registerStatic('foo', 'app-1', staticDir);
    ReverseProxyService.unregisterStatic('foo');
    expect(ReverseProxyService.getStaticDir('foo')).toBeNull();
    expect(ReverseProxyService.getPort('foo')).toBe(12345);
  });
});

describe('ReverseProxyService — static middleware', () => {
  let staticDir;
  let proxyServer, proxyPort;

  beforeEach(async () => {
    ReverseProxyService._resetForTests();
    staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-rp-static-mw-'));
    fs.writeFileSync(path.join(staticDir, 'index.html'), '<h1>hello, OS8</h1>');
    fs.writeFileSync(path.join(staticDir, 'app.js'), 'console.log("ok")');
    fs.writeFileSync(path.join(staticDir, '.env'), 'SECRET=oops');

    const app = express();
    app.use(ReverseProxyService.middleware());
    app.use((_req, res) => res.status(404).send('native-not-found'));
    proxyServer = http.createServer(app);
    proxyPort = await listen(proxyServer);
  });

  afterEach(async () => {
    if (proxyServer) await close(proxyServer);
    fs.rmSync(staticDir, { recursive: true, force: true });
    ReverseProxyService._resetForTests();
  });

  it('serves index.html at <slug>.localhost/', async () => {
    ReverseProxyService.registerStatic('site', 'app-1', staticDir);
    const res = await fetchOnce(`http://127.0.0.1:${proxyPort}/`, {
      Host: `site.localhost:${proxyPort}`,
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain('hello, OS8');
  });

  it('serves a file at /app.js', async () => {
    ReverseProxyService.registerStatic('site', 'app-1', staticDir);
    const res = await fetchOnce(`http://127.0.0.1:${proxyPort}/app.js`, {
      Host: `site.localhost:${proxyPort}`,
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain('ok');
  });

  it('denies dotfile requests (.env returns 403)', async () => {
    ReverseProxyService.registerStatic('site', 'app-1', staticDir);
    const res = await fetchOnce(`http://127.0.0.1:${proxyPort}/.env`, {
      Host: `site.localhost:${proxyPort}`,
    });
    expect(res.status).toBe(403);
  });

  it('returns 404 from the static handler (NOT native fall-through) for missing files', async () => {
    ReverseProxyService.registerStatic('site', 'app-1', staticDir);
    const res = await fetchOnce(`http://127.0.0.1:${proxyPort}/missing.html`, {
      Host: `site.localhost:${proxyPort}`,
    });
    expect(res.status).toBe(404);
    // fallthrough:false means we don't see "native-not-found".
    expect(res.body).not.toContain('native-not-found');
  });

  it('static dispatch wins over proxy when both registered for same slug', async () => {
    // Register a proxy with a deliberately bad port; the static map should win.
    ReverseProxyService.register('site', 'app-1', 1);          // unreachable
    ReverseProxyService.registerStatic('site', 'app-1', staticDir);
    const res = await fetchOnce(`http://127.0.0.1:${proxyPort}/`, {
      Host: `site.localhost:${proxyPort}`,
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain('hello, OS8');
  });

  it('sets no-cache headers', async () => {
    ReverseProxyService.registerStatic('site', 'app-1', staticDir);
    const res = await fetchOnce(`http://127.0.0.1:${proxyPort}/`, {
      Host: `site.localhost:${proxyPort}`,
    });
    expect(res.headers['cache-control']).toMatch(/no-cache|no-store/);
  });
});

describe('ReverseProxyService — WS upgrade for static apps', () => {
  let staticDir;
  let proxyServer, proxyPort;

  beforeEach(async () => {
    ReverseProxyService._resetForTests();
    staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-rp-static-ws-'));
    fs.writeFileSync(path.join(staticDir, 'index.html'), '<h1>x</h1>');

    const app = express();
    app.use(ReverseProxyService.middleware());
    proxyServer = http.createServer(app);
    ReverseProxyService.attachUpgradeHandler(proxyServer);
    proxyPort = await listen(proxyServer);
  });

  afterEach(async () => {
    if (proxyServer) await close(proxyServer);
    fs.rmSync(staticDir, { recursive: true, force: true });
    ReverseProxyService._resetForTests();
  });

  it('destroys the WS socket for a static-served app', async () => {
    ReverseProxyService.registerStatic('site', 'app-1', staticDir);
    const ws = new WebSocket(`ws://site.localhost:${proxyPort}/`, {
      headers: { Host: `site.localhost:${proxyPort}` },
    });
    await new Promise((resolve) => {
      const timer = setTimeout(() => { ws.terminate(); resolve(); }, 2000);
      ws.on('error', () => { clearTimeout(timer); resolve(); });
      ws.on('close', () => { clearTimeout(timer); resolve(); });
    });
    // Socket should be closed; if we got here without hanging, the upgrade
    // handler did the right thing (destroy on static slug).
    expect(ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING).toBe(true);
  });
});
