/**
 * PR 1.28 — End-to-end acceptance test.
 *
 * The promoted vitest version of tests/acceptance/phase-1a.js. Drives the
 * full install pipeline against the real `github.com/koala73/worldmonitor`
 * v2.5.23 via OS8's Express layer (no Electron — the hardened-BrowserView
 * + window.os8 wires are validated by tests/preview-external.test.js +
 * tests/preload-external-app.test.js).
 *
 * Why opt-in: this test does a real `npm ci` of 26+18 deps (~1.3GB,
 * 30-60s wall time post-cache), so we don't run it in the default
 * `vitest run` loop. CI flips OS8_E2E=1 to enable it; locally,
 * `OS8_E2E=1 npx vitest run tests/e2e/app-store-worldmonitor.test.js`.
 *
 * Validates Phase 1A invariants + Phase 1B additions:
 *   - migrator runs cleanly through 0.5.0
 *   - install pipeline transitions cloning → reviewing → awaiting_approval
 *     → installing → installed
 *   - apps row created with app_type='external', status='active'
 *   - per-app blob dir + node_modules present
 *   - CLAUDE.md + os8-sdk.d.ts + .os8/manifest.yaml shipped (PR 1.21)
 *   - POST /processes/start spawns Vite, proxy registers
 *   - GET via subdomain Host hits Vite's index.html (HMR client present)
 *   - sanitized env: ANTHROPIC/OPENAI/etc. absent from /proc/<pid>/environ
 *   - reapStaging is a no-op after a successful install (PR 1.29)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const SHOULD_RUN = process.env.OS8_E2E === '1';

const SLUG = 'worldmonitor';
const COMMIT = 'e51058e1765ef2f0c83ccb1d08d984bc59d23f10';   // tag v2.5.23
const UPSTREAM = 'https://github.com/koala73/worldmonitor.git';

const MANIFEST_YAML = `
schemaVersion: 1
slug: worldmonitor
name: World Monitor
publisher: koala73
description: Real-time global intelligence dashboard.
upstream:
  git: ${UPSTREAM}
  ref: v2.5.23
framework: vite
runtime:
  kind: node
  version: "20"
  arch: [arm64, x86_64]
  package_manager: npm
  dependency_strategy: frozen
install:
  - argv: ["true"]
start:
  argv: ["npx", "vite", "--port", "{{PORT}}", "--host", "127.0.0.1", "--strictPort"]
  port: detect
  readiness:
    type: http
    path: /
    timeout_seconds: 60
surface:
  kind: web
permissions:
  network:
    outbound: true
    inbound: false
  filesystem: app-private
  os8_capabilities: []
legal:
  license: AGPL-3.0-only
  commercial_use: restricted
review:
  channel: verified
  risk: low
`.trim();

function fetchJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + (u.search || ''),
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, body }); }
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

function fetchRaw(url, host) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + (u.search || ''),
      method: 'GET',
      headers: host ? { Host: host } : undefined,
      timeout: 5000,
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
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function pollUntil(predicate, { timeoutMs, stepMs = 500, label }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await predicate();
    if (v) return v;
    await new Promise(r => setTimeout(r, stepMs));
  }
  throw new Error(`pollUntil("${label}") timed out after ${timeoutMs}ms`);
}

describe.skipIf(!SHOULD_RUN)('PR 1.28 — worldmonitor end-to-end (OS8_E2E=1)', () => {
  let OS8_HOME, db, port, APR;
  let serverHandle = null;
  let externalAppId = null;

  beforeAll(async () => {
    OS8_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-e2e-'));
    process.env.OS8_HOME = OS8_HOME;

    // Reset all caches so config picks up the fresh OS8_HOME.
    [
      '../../src/config',
      '../../src/db',
      '../../src/services/migrator',
      '../../src/server',
      '../../src/services/app-process-registry',
      '../../src/services/app-catalog',
    ].forEach(p => { delete require.cache[require.resolve(p)]; });

    const { initDatabase } = require('../../src/db');
    db = initDatabase();

    const migrator = require('../../src/services/migrator');
    await migrator.run({ db, logger: { log: () => {}, warn: () => {}, error: console.error } });

    // Seed the catalog row directly.
    const sha = crypto.createHash('sha256').update(MANIFEST_YAML).digest('hex');
    db.prepare(`
      INSERT INTO app_catalog (
        id, slug, name, description, publisher, channel, category, icon_url,
        screenshots, manifest_yaml, manifest_sha, catalog_commit_sha,
        upstream_declared_ref, upstream_resolved_commit, license, runtime_kind,
        framework, architectures, risk_level, install_count, synced_at
      ) VALUES (
        'wm-1', ?, 'World Monitor', 'Real-time global intelligence dashboard.',
        'koala73', 'verified', 'intelligence',
        'https://raw.githubusercontent.com/koala73/worldmonitor/v2.5.23/new-world-monitor.png',
        '[]', ?, ?, '0000000000000000000000000000000000000000', 'v2.5.23', ?,
        'AGPL-3.0-only', 'node', 'vite', '["arm64","x86_64"]', 'low', 0,
        datetime('now')
      )
    `).run(SLUG, MANIFEST_YAML, sha, COMMIT);

    const { startServer, getPort, stopServer } = require('../../src/server');
    await startServer(null, db);
    port = getPort();
    serverHandle = { stopServer };

    APR = require('../../src/services/app-process-registry');
    APR.init({ db, getOS8Port: getPort });
  }, 120_000);

  afterAll(async () => {
    try {
      if (externalAppId && APR) {
        const inst = APR.get();
        await inst.stop(externalAppId, { reason: 'e2e cleanup' });
      }
      if (APR) await APR.get().stopAll();
    } catch (_) { /* ignore */ }
    if (serverHandle?.stopServer) {
      try { await serverHandle.stopServer(); } catch (_) {}
    }
    if (db) { try { db.close(); } catch (_) {} }
    if (OS8_HOME && fs.existsSync(OS8_HOME)) {
      fs.rmSync(OS8_HOME, { recursive: true, force: true });
    }
  }, 30_000);

  it('install → review → approve → installed → run → proxy → no env leak', async () => {
    const startRes = await fetchJson(`http://127.0.0.1:${port}/api/app-store/install`, {
      method: 'POST',
      body: { slug: SLUG, commit: COMMIT, channel: 'verified', source: 'e2e' },
    });
    expect(startRes.status).toBe(202);
    const jobId = startRes.body.jobId;

    // Wait for awaiting_approval.
    const awaiting = await pollUntil(async () => {
      const r = await fetchJson(`http://127.0.0.1:${port}/api/app-store/jobs/${jobId}`);
      if (r.body.status === 'failed') throw new Error(`pre-approval failed: ${r.body.errorMessage}`);
      return r.body.status === 'awaiting_approval' ? r.body : null;
    }, { timeoutMs: 90_000, label: 'awaiting_approval' });
    expect(awaiting.reviewReport).toBeTruthy();
    expect(['low', 'medium', 'high', 'unknown']).toContain(awaiting.reviewReport.riskLevel);

    // Approve. This kicks off the real `npm ci`.
    const approveRes = await fetchJson(
      `http://127.0.0.1:${port}/api/app-store/jobs/${jobId}/approve`,
      { method: 'POST', body: { secrets: {} } }
    );
    expect(approveRes.status).toBe(202);

    // Wait for installed (10 minutes — npm ci of 26+18 deps).
    const installed = await pollUntil(async () => {
      const r = await fetchJson(`http://127.0.0.1:${port}/api/app-store/jobs/${jobId}`);
      if (r.body.status === 'failed') throw new Error(`install failed: ${r.body.errorMessage}`);
      return r.body.status === 'installed' ? r.body : null;
    }, { timeoutMs: 10 * 60_000, stepMs: 2000, label: 'installed' });
    externalAppId = installed.appId;

    // Verify apps row.
    const appRow = db.prepare(
      `SELECT id, slug, app_type, status, channel FROM apps WHERE external_slug = ?`
    ).get(SLUG);
    expect(appRow).toMatchObject({
      app_type: 'external',
      status: 'active',
      channel: 'verified',
      slug: SLUG,
    });

    const appDir = path.join(OS8_HOME, 'apps', appRow.id);
    expect(fs.existsSync(path.join(appDir, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(appDir, 'node_modules'))).toBe(true);

    // PR 1.21 — auto-generated CLAUDE.md, os8-sdk.d.ts, .os8/manifest.yaml.
    expect(fs.existsSync(path.join(appDir, 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(appDir, 'os8-sdk.d.ts'))).toBe(true);
    expect(fs.existsSync(path.join(appDir, '.os8', 'manifest.yaml'))).toBe(true);

    // Start the Vite dev server through the registry.
    const startProc = await fetchJson(
      `http://127.0.0.1:${port}/api/apps/${appRow.id}/processes/start`,
      { method: 'POST' }
    );
    expect(startProc.status).toBe(200);
    expect(startProc.body.url).toMatch(new RegExp(`^http://${SLUG}\\.localhost:${port}/`));

    // Hit the proxy via Host header (RFC 6761 says *.localhost resolves to
    // 127.0.0.1, but explicit Host avoids depending on resolver behavior).
    const proxyRes = await pollUntil(async () => {
      try {
        const r = await fetchRaw(`http://127.0.0.1:${port}/`, `${SLUG}.localhost:${port}`);
        return (r.status === 200 || r.status === 304) ? r : null;
      } catch (_) { return null; }
    }, { timeoutMs: 60_000, label: 'proxy 200' });
    expect(proxyRes.body).toMatch(/<\s*script[^>]*\/@vite\/client/);   // Vite HMR client present

    // Sanitized env: confirm /proc/<pid>/environ doesn't leak host secrets.
    if (process.platform === 'linux') {
      const procInfo = APR.get().get(appRow.id);
      expect(procInfo?.pid).toBeTruthy();
      const envFile = `/proc/${procInfo.pid}/environ`;
      if (fs.existsSync(envFile)) {
        const env = fs.readFileSync(envFile, 'utf8').split('\0').filter(Boolean);
        const obj = Object.fromEntries(env.map(e => {
          const i = e.indexOf('=');
          return [e.slice(0, i), e.slice(i + 1)];
        }));
        expect(obj.OS8_APP_ID).toBe(appRow.id);
        expect(obj.OS8_API_BASE).toBe(`http://${SLUG}.localhost:${port}/_os8/api`);
        expect(obj.PORT).toBeTruthy();
        for (const leakedKey of [
          'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY',
          'XAI_API_KEY', 'ELEVENLABS_API_KEY', 'OS8_HOME',
        ]) {
          expect(obj[leakedKey]).toBeUndefined();
        }
      }
    }

    // PR 1.29 — reapStaging is a no-op after success (the staging dir was
    // moved into apps/ by atomicMove, so there's nothing to clean).
    const AppCatalogService = require('../../src/services/app-catalog');
    const reaped = AppCatalogService.reapStaging(db);
    expect(reaped.removed).toBe(0);
    expect(reaped.markedFailed).toBe(0);
  }, 12 * 60_000);
});
