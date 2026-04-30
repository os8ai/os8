/**
 * PR 2.2 — Phase 2 GATE: Streamlit-through-proxy WebSocket smoke test.
 *
 * Streamlit re-runs the script on file change and pushes a re-render
 * frame over its `/_stcore/stream` WebSocket. The proxy (PR 1.13) ships
 * `ws: true` and PR 1.14 already proved Vite HMR survives the upgrade
 * path; this test re-proves it for Streamlit's Tornado WS.
 *
 * Until this passes on macOS + Linux, PR 2.4's Streamlit/Gradio/ComfyUI
 * manifests do not merge — see phase-2-plan.md §1.
 *
 * Cost: this test installs Streamlit into a temp venv via uv and
 * launches Chromium. Both are gated behind `OS8_STREAMLIT_SMOKE=1` so
 * the default test run is fast.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import express from 'express';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCb);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/streamlit-smoke');
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

async function killTree(child) {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 200));
  if (!child.killed) child.kill('SIGKILL');
}

let chromium;
try {
  ({ chromium } = require('@playwright/test'));
} catch {
  chromium = null;
}

// Skip unless explicitly opted in. Streamlit installs PyTorch-free, but the
// `pyarrow` dep is heavy and the test takes 1-2 min on a cold uv cache.
const OPTED_IN = process.env.OS8_STREAMLIT_SMOKE === '1';
const SHOULD_RUN = OPTED_IN && chromium !== null;

async function ensureStreamlitVenv() {
  // Use the bundled uv from PR 2.1 so the venv is created the same way the
  // PythonRuntimeAdapter would create it at install time.
  const PythonAdapter = require('../../src/services/runtime-adapters/python');
  const uvPath = await PythonAdapter._internal.ensureUv();

  const venvBin = path.join(FIXTURE_DIR, '.venv',
    process.platform === 'win32' ? 'Scripts' : 'bin');
  const streamlitBin = path.join(venvBin,
    process.platform === 'win32' ? 'streamlit.exe' : 'streamlit');
  if (fs.existsSync(streamlitBin)) return streamlitBin;

  await execFile(uvPath, ['venv', '--python', '3.12', '.venv'],
    { cwd: FIXTURE_DIR, timeout: 60_000 });
  await execFile(uvPath, ['pip', 'install', '-r', 'requirements.txt'],
    { cwd: FIXTURE_DIR, timeout: 300_000,
      env: { ...process.env, VIRTUAL_ENV: path.join(FIXTURE_DIR, '.venv') } });
  if (!fs.existsSync(streamlitBin)) {
    throw new Error(`venv setup did not produce ${streamlitBin}`);
  }
  return streamlitBin;
}

function spawnStreamlit(streamlitBin, port) {
  const child = spawn(streamlitBin, [
    'run', path.join(FIXTURE_DIR, 'app.py'),
    `--server.port=${port}`,
    '--server.address=127.0.0.1',
    '--server.enableCORS=false',
    '--server.enableXsrfProtection=false',
    '--server.headless=true',
    '--server.runOnSave=true',
    '--browser.gatherUsageStats=false',
  ], {
    cwd: FIXTURE_DIR,
    env: { ...process.env, FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', d => logs.push(`[streamlit-out] ${d.toString()}`));
  child.stderr.on('data', d => logs.push(`[streamlit-err] ${d.toString()}`));
  child._logs = logs;
  return child;
}

describe.skipIf(!SHOULD_RUN)('PR 2.2 — Streamlit WS through subdomain reverse proxy (Phase 2 GATE)', () => {
  it('proxies Streamlit, opens /_stcore/stream WebSocket, applies edits without a full reload', async () => {
    const streamlitBin = await ensureStreamlitVenv();

    const proxyPort = await freePort();
    const streamlitPort = await freePort();

    const streamlit = spawnStreamlit(streamlitBin, streamlitPort);

    let server, browser;
    const appPath = path.join(FIXTURE_DIR, 'app.py');
    const original = fs.readFileSync(appPath, 'utf8');

    try {
      // Streamlit takes a few seconds to bind on cold start.
      await waitForHttp(`http://127.0.0.1:${streamlitPort}/`, { timeoutMs: 60_000 });

      delete require.cache[require.resolve('../../src/services/reverse-proxy')];
      const ReverseProxyService = require('../../src/services/reverse-proxy');
      ReverseProxyService.register(SLUG, 'smoke-app', streamlitPort);

      const app = express();
      app.use(ReverseProxyService.middleware());
      app.use((_req, res) => res.status(404).send('native-not-found'));

      server = http.createServer(app);
      ReverseProxyService.attachUpgradeHandler(server);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(proxyPort, '127.0.0.1', resolve);
      });

      await waitForHttp(`http://127.0.0.1:${proxyPort}/`, {
        host: `${SLUG}.localhost:${proxyPort}`,
        timeoutMs: 10_000,
      });

      browser = await chromium.launch({
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      });
      const ctx = await browser.newContext();
      const page = await ctx.newPage();

      let frameNavigations = 0;
      page.on('framenavigated', frame => {
        if (frame === page.mainFrame()) frameNavigations++;
      });
      const websockets = [];
      page.on('websocket', ws => websockets.push(ws.url()));

      await page.goto(`http://${SLUG}.localhost:${proxyPort}/`, {
        waitUntil: 'networkidle',
        timeout: 30_000,
      });

      // Signal 1 — Streamlit's app shell renders. The data-testid hook is
      // stable across recent Streamlit versions; if it changes, the regex
      // fallback below catches the heading text.
      await Promise.race([
        page.waitForSelector('[data-testid="stApp"]', { timeout: 30_000 }),
        page.waitForSelector('text=/Hello/', { timeout: 30_000 }),
      ]);
      const initialNavCount = frameNavigations;

      // Signal 2 — at least one WebSocket opened on /_stcore/stream.
      await page.waitForTimeout(800);
      const stcore = websockets.some(u => /\/_stcore\/stream/.test(u));
      expect(stcore).toBe(true);

      // Signal 3 — edit the script; Streamlit re-runs and pushes a new
      // frame. The text "Updated" should appear without a full reload.
      fs.writeFileSync(appPath, original.replace('Hello', 'Updated'));
      await expect.poll(
        async () => await page.locator('text=/Updated/').count(),
        { timeout: 10_000, interval: 250 }
      ).toBeGreaterThan(0);

      // Signal 4 — main-frame navigation count unchanged. The script re-run
      // must come over the WS, not a full page reload.
      expect(frameNavigations).toBe(initialNavCount);
    } finally {
      fs.writeFileSync(appPath, original);
      if (browser) await browser.close().catch(() => {});
      if (server) await new Promise(r => server.close(r));
      await killTree(streamlit);

      if (process.env.OS8_STREAMLIT_SMOKE_DEBUG === '1' && streamlit._logs) {
        console.log(streamlit._logs.join(''));
      }
    }
  }, 600_000);
});
