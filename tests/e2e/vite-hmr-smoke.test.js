/**
 * PR 1.14 — GATING Vite HMR smoke test through subdomain reverse proxy.
 *
 * Boots a real Vite + React fixture, mounts ReverseProxyService on its
 * own Express port, drives Chromium (via Playwright) to
 * `<slug>.localhost:<proxyPort>/`, edits a `.tsx` source file, and
 * asserts:
 *
 *   1. The page loads (200 from the proxy → Vite).
 *   2. At least one WebSocket is opened by the page (HMR client through proxy).
 *   3. The marker text changes after the file edit (HMR applied).
 *   4. The main frame's navigation count is unchanged (HMR did not fall back
 *      to a full reload).
 *
 * If 1.14 fails, downstream PRs 1.15 / 1.16 / 1.19 do not merge — see
 * docs/phase-1-plan.md §"Hard-fail recovery (architecture-level)" for the
 * library-flip recovery (the architecture stays).
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import express from 'express';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCb);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/vite-app');
const SLUG = 'smoke';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function tryFetch(url, host) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + (u.search || ''),
      method: 'GET',
      headers: host ? { Host: host } : undefined,
      timeout: 1000,
    }, res => {
      // Drain so the socket closes promptly.
      res.resume();
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 500, status: res.statusCode });
    });
    req.on('error', () => resolve({ ok: false, status: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0 }); });
    req.end();
  });
}

async function waitForHttp(url, { host, timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = { ok: false, status: 0 };
  while (Date.now() < deadline) {
    last = await tryFetch(url, host);
    if (last.ok) return;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`waitForHttp(${url}, host=${host}) timed out (last status=${last.status})`);
}

async function ensureFixtureInstalled() {
  // The fixture commits a package-lock.json so `npm ci` is deterministic.
  // Skip if node_modules already exists with the right shape (cheap heuristic:
  // vite binary present → install is good enough for the smoke test).
  const viteBin = path.join(FIXTURE_DIR, 'node_modules', '.bin', 'vite');
  if (fs.existsSync(viteBin)) return;
  await execFile('npm', ['ci'], { cwd: FIXTURE_DIR, timeout: 120_000 });
}

function spawnVite(viteAppPort, hmrClientPort) {
  const vite = spawn(
    path.join(FIXTURE_DIR, 'node_modules', '.bin', 'vite'),
    ['--port', String(viteAppPort), '--host', '127.0.0.1', '--strictPort'],
    {
      cwd: FIXTURE_DIR,
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        VITE_HMR_CLIENT_PORT: String(hmrClientPort),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  // Capture for diagnostics; not a hard error if it logs to stderr.
  const logs = [];
  vite.stdout.on('data', d => logs.push(`[vite-out] ${d.toString()}`));
  vite.stderr.on('data', d => logs.push(`[vite-err] ${d.toString()}`));
  vite._logs = logs;
  return vite;
}

async function killTree(child) {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 200));
  if (!child.killed) child.kill('SIGKILL');
}

// Chromium availability check — Playwright bundles Chromium per architecture
// (Linux ARM64 ships in 1.42+). If the binary is missing we skip rather than
// fail the suite, but the test must run in CI where browsers are installed.
let chromium;
try {
  ({ chromium } = require('@playwright/test'));
} catch {
  chromium = null;
}

const SHOULD_RUN = chromium !== null;

describe.skipIf(!SHOULD_RUN)('PR 1.14 — Vite HMR survives subdomain reverse proxy', () => {
  it('proxies Vite, opens HMR WebSocket, applies edits without a full reload', async () => {
    await ensureFixtureInstalled();

    const proxyPort = await freePort();
    const viteAppPort = await freePort();

    // Spawn Vite. HMR client is told to connect to the proxy port (so the
    // browser-side WebSocket goes through ReverseProxyService).
    const vite = spawnVite(viteAppPort, proxyPort);

    let server, browser;
    const appPath = path.join(FIXTURE_DIR, 'src', 'App.jsx');
    const original = fs.readFileSync(appPath, 'utf8');

    try {
      // Wait for Vite — direct connection to confirm it's up before the proxy is queried.
      await waitForHttp(`http://127.0.0.1:${viteAppPort}/`, { timeoutMs: 30_000 });

      // Mount ReverseProxyService on a fresh Express. require() the module
      // each test run so prior test state doesn't leak.
      delete require.cache[require.resolve('../../src/services/reverse-proxy')];
      const ReverseProxyService = require('../../src/services/reverse-proxy');
      ReverseProxyService.register(SLUG, 'smoke-app', viteAppPort);

      const app = express();
      app.use(ReverseProxyService.middleware());
      app.use((_req, res) => res.status(404).send('native-not-found'));

      server = http.createServer(app);
      ReverseProxyService.attachUpgradeHandler(server);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(proxyPort, '127.0.0.1', resolve);
      });

      // Sanity: proxy → Vite must serve Vite's index.html at the subdomain.
      // (RFC 6761 says *.localhost resolves to 127.0.0.1; the proxy cares only
      // about the Host header, not DNS, when we issue requests with explicit Host.)
      await waitForHttp(`http://127.0.0.1:${proxyPort}/`, {
        host: `${SLUG}.localhost:${proxyPort}`,
        timeoutMs: 10_000,
      });

      // Drive Chromium.
      browser = await chromium.launch({
        // --no-sandbox is harmless on bare Linux but required in some CI
        // sandboxes; the smoke test does not load untrusted content.
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      });
      const ctx = await browser.newContext();
      const page = await ctx.newPage();

      let frameNavigations = 0;
      page.on('framenavigated', frame => {
        if (frame === page.mainFrame()) frameNavigations++;
      });
      let websocketsSeen = 0;
      page.on('websocket', () => websocketsSeen++);

      // Navigate via the subdomain. The page origin will be `<slug>.localhost:<proxyPort>`,
      // so Vite's HMR client connects back to that origin (through the proxy).
      await page.goto(`http://${SLUG}.localhost:${proxyPort}/`, {
        waitUntil: 'networkidle',
        timeout: 20_000,
      });

      // Signal 1 — page loads.
      const initialText = await page.getByTestId('hmr-marker').textContent();
      expect(initialText).toBe('SMOKE_TEST_INITIAL');

      const initialNavCount = frameNavigations;

      // Signal 2 — HMR WebSocket opened (give it a beat to connect).
      await page.waitForTimeout(500);
      expect(websocketsSeen).toBeGreaterThanOrEqual(1);

      // Edit App.jsx. Vite watches src/, no manifest change.
      fs.writeFileSync(appPath, original.replace('SMOKE_TEST_INITIAL', 'SMOKE_TEST_PATCHED'));

      // Signal 3 — HMR patch applies (no full reload). Poll the marker.
      await expect.poll(
        async () => await page.getByTestId('hmr-marker').textContent(),
        { timeout: 10_000, interval: 200 }
      ).toBe('SMOKE_TEST_PATCHED');

      // Signal 4 — main-frame navigation count unchanged. This is the assertion
      // that distinguishes HMR (in-place patch) from a full reload fallback.
      expect(frameNavigations).toBe(initialNavCount);
    } finally {
      // Always restore the fixture file so subsequent runs are deterministic.
      fs.writeFileSync(appPath, original);

      if (browser) await browser.close().catch(() => {});
      if (server) await new Promise(r => server.close(r));
      await killTree(vite);

      // Surface vite output if the test failed — saves a debugging round-trip.
      if (process.env.OS8_HMR_SMOKE_DEBUG === '1' && vite._logs) {
        console.log(vite._logs.join(''));
      }
    }
  }, 180_000);
});
