import { describe, it, expect, beforeEach, afterAll, afterEach } from 'vitest';
import http from 'http';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';

const ReverseProxyService = require('../src/services/reverse-proxy');

function listen(server, host = '127.0.0.1') {
  return new Promise(resolve => {
    server.listen(0, host, () => resolve(server.address().port));
  });
}

function close(server) {
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

describe('ReverseProxyService — registry primitives', () => {
  beforeEach(() => ReverseProxyService._resetForTests());

  it('register/getPort/unregister round-trips', () => {
    ReverseProxyService.register('foo', 'app-1', 12345);
    expect(ReverseProxyService.getPort('foo')).toBe(12345);
    expect(ReverseProxyService.has('foo')).toBe(true);

    ReverseProxyService.unregister('foo');
    expect(ReverseProxyService.getPort('foo')).toBeNull();
    expect(ReverseProxyService.has('foo')).toBe(false);
  });

  it('getPort returns null for unknown slug', () => {
    expect(ReverseProxyService.getPort('nope')).toBeNull();
  });

  it('register can overwrite an existing slug entry', () => {
    ReverseProxyService.register('foo', 'app-1', 11111);
    ReverseProxyService.register('foo', 'app-2', 22222);
    expect(ReverseProxyService.getPort('foo')).toBe(22222);
  });
});

describe('ReverseProxyService — host header dispatch', () => {
  beforeEach(() => ReverseProxyService._resetForTests());

  function fakeReq(host) {
    return { headers: { host } };
  }

  it('matches <slug>.localhost:<port>', () => {
    ReverseProxyService.register('foo', 'app-1', 12345);
    expect(ReverseProxyService._resolveByHost(fakeReq('foo.localhost:8888'))).toEqual({
      appId: 'app-1',
      port: 12345,
    });
  });

  it('matches <slug>.localhost (no port)', () => {
    ReverseProxyService.register('foo', 'app-1', 12345);
    expect(ReverseProxyService._resolveByHost(fakeReq('foo.localhost'))).toEqual({
      appId: 'app-1',
      port: 12345,
    });
  });

  it('returns null for bare localhost', () => {
    ReverseProxyService.register('foo', 'app-1', 12345);
    expect(ReverseProxyService._resolveByHost(fakeReq('localhost:8888'))).toBeNull();
  });

  it('returns null for unregistered subdomain', () => {
    expect(ReverseProxyService._resolveByHost(fakeReq('unknown.localhost:8888'))).toBeNull();
  });

  it('lowercases host before matching', () => {
    ReverseProxyService.register('foo', 'app-1', 12345);
    expect(ReverseProxyService._resolveByHost(fakeReq('FOO.LocalHost:8888'))).toEqual({
      appId: 'app-1',
      port: 12345,
    });
  });

  it('rejects non-localhost hosts (127.0.0.1, IP, real domain)', () => {
    ReverseProxyService.register('foo', 'app-1', 12345);
    expect(ReverseProxyService._resolveByHost(fakeReq('foo.example.com'))).toBeNull();
    expect(ReverseProxyService._resolveByHost(fakeReq('foo.127.0.0.1'))).toBeNull();
  });

  it('handles missing host header', () => {
    expect(ReverseProxyService._resolveByHost({ headers: {} })).toBeNull();
    expect(ReverseProxyService._resolveByHost({})).toBeNull();
  });
});

describe('ReverseProxyService — HTTP middleware', () => {
  let upstream, upstreamPort;
  let proxy, proxyPort;

  beforeEach(async () => {
    ReverseProxyService._resetForTests();
    upstream = http.createServer((req, res) => {
      // Echo the original Host so we can verify changeOrigin: false preserved it.
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`upstream-saw-host:${req.headers.host} path:${req.url}`);
    });
    upstreamPort = await listen(upstream);

    proxy = express();
    proxy.use(ReverseProxyService.middleware());
    // Native fall-through behavior: a plain handler after the middleware.
    // Express 5 dropped `'*'` route patterns; use a final use() instead.
    proxy.use((_req, res) => res.status(404).send('native-not-found'));

    const proxyServer = http.createServer(proxy);
    proxy._server = proxyServer;
    proxyPort = await listen(proxyServer);
  });

  afterEach(async () => {
    if (proxy?._server) await close(proxy._server);
    if (upstream) await close(upstream);
  });

  it('proxies to upstream when host matches a registered slug', async () => {
    ReverseProxyService.register('smoke', 'app-1', upstreamPort);
    const res = await fetchOnce(`http://127.0.0.1:${proxyPort}/some/path`, {
      Host: `smoke.localhost:${proxyPort}`,
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain('path:/some/path');
    // changeOrigin: false → upstream sees the original Host
    expect(res.body).toContain(`upstream-saw-host:smoke.localhost:${proxyPort}`);
  });

  it('falls through to next middleware on bare localhost host', async () => {
    ReverseProxyService.register('smoke', 'app-1', upstreamPort);
    const res = await fetchOnce(`http://127.0.0.1:${proxyPort}/x`, {
      Host: `localhost:${proxyPort}`,
    });
    expect(res.status).toBe(404);
    expect(res.body).toBe('native-not-found');
  });

  it('falls through on registered subdomain shape but no entry', async () => {
    const res = await fetchOnce(`http://127.0.0.1:${proxyPort}/x`, {
      Host: `unknown.localhost:${proxyPort}`,
    });
    expect(res.status).toBe(404);
  });

  it('returns 502 when the registered upstream is dead', async () => {
    // Pick a port we know is closed.
    const dead = http.createServer();
    const deadPort = await listen(dead);
    await close(dead);

    ReverseProxyService.register('smoke', 'app-1', deadPort);
    const res = await fetchOnce(`http://127.0.0.1:${proxyPort}/`, {
      Host: `smoke.localhost:${proxyPort}`,
    });
    expect(res.status).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('upstream unavailable');
  });
});

describe('ReverseProxyService — WebSocket upgrade pass-through', () => {
  let upstreamHttp, upstreamPort, wss;
  let proxy, proxyServer, proxyPort;

  beforeEach(async () => {
    ReverseProxyService._resetForTests();

    upstreamHttp = http.createServer();
    wss = new WebSocketServer({ server: upstreamHttp });
    wss.on('connection', socket => {
      socket.on('message', msg => socket.send(`echo:${msg}`));
      socket.send('hello');
    });
    upstreamPort = await listen(upstreamHttp);

    proxy = express();
    proxy.use(ReverseProxyService.middleware());
    proxyServer = http.createServer(proxy);
    ReverseProxyService.attachUpgradeHandler(proxyServer);
    proxyPort = await listen(proxyServer);
  });

  afterEach(async () => {
    wss?.close();
    if (proxyServer) await close(proxyServer);
    if (upstreamHttp) await close(upstreamHttp);
  });

  it('upgrades WebSocket and round-trips frames through the proxy', async () => {
    ReverseProxyService.register('smoke', 'app-1', upstreamPort);

    const ws = new WebSocket(`ws://smoke.localhost:${proxyPort}/`, {
      headers: { Host: `smoke.localhost:${proxyPort}` },
    });

    const messages = [];
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 5000);
      ws.on('message', m => {
        messages.push(m.toString());
        if (messages.length === 1) ws.send('ping');
        if (messages.length === 2) {
          clearTimeout(timer);
          ws.close();
          resolve();
        }
      });
      ws.on('error', err => { clearTimeout(timer); reject(err); });
    });

    expect(messages[0]).toBe('hello');
    expect(messages[1]).toBe('echo:ping');
  });

  it('destroys the socket when no slug entry matches', async () => {
    // No registration — handshake should fail.
    const ws = new WebSocket(`ws://unknown.localhost:${proxyPort}/`, {
      headers: { Host: `unknown.localhost:${proxyPort}` },
    });

    await new Promise(resolve => {
      let resolved = false;
      const finish = () => { if (!resolved) { resolved = true; resolve(); } };
      ws.on('error', finish);
      ws.on('close', finish);
      ws.on('unexpected-response', finish);
      setTimeout(finish, 3000);
    });

    expect(ws.readyState).not.toBe(WebSocket.OPEN);
  });
});
