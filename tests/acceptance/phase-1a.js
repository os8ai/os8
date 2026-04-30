#!/usr/bin/env node
/**
 * Phase 1A acceptance harness.
 *
 * Boots OS8's Express server against an isolated OS8_HOME, seeds the
 * app_catalog with a worldmonitor manifest pointing at github.com/koala73/
 * worldmonitor @ v2.5.23, drives the install pipeline end-to-end, then
 * starts the dev server and verifies the proxy + sanitized env.
 *
 * Skips Electron — exercises the architecture from the server side only.
 * The hardened-BrowserView wiring is validated by the unit tests in
 * tests/preview-external.test.js (and the manual smoke test in PR 1.19).
 *
 * Usage:
 *   OS8_HOME=/tmp/os8-acceptance node scripts/acceptance-phase1a.js
 *
 * Stages:
 *   1. Init DB + run migrator
 *   2. Seed app_catalog
 *   3. Start Express server
 *   4. Init AppProcessRegistry
 *   5. POST /api/app-store/install → wait for awaiting_approval
 *   6. POST /jobs/:id/approve → wait for installed (this runs `npm ci`!)
 *   7. POST /api/apps/:id/processes/start → wait for upstream ready
 *   8. curl http://worldmonitor.localhost:<port>/ → expect 200
 *   9. ps -o command= the worldmonitor process → confirm no API keys
 *  10. Clean shutdown
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');

const OS8_HOME = process.env.OS8_HOME || '/tmp/os8-acceptance';
process.env.OS8_HOME = OS8_HOME;

const SLUG = 'worldmonitor';
const COMMIT = 'e51058e1765ef2f0c83ccb1d08d984bc59d23f10';   // v2.5.23 resolved
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
  preview_name: World Monitor
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

function step(n, msg) { console.log(`\n[${n}] ${msg}`); }

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

async function main() {
  if (!fs.existsSync(path.join(OS8_HOME, 'config'))) {
    fs.mkdirSync(path.join(OS8_HOME, 'config'), { recursive: true });
  }

  // 1. Init DB + run migrator.
  step(1, `Initialize DB at ${OS8_HOME}/config/os8.db`);
  const { initDatabase } = require(path.join(__dirname, '..', 'src', 'db'));
  const db = initDatabase();

  step(1, 'Running migrator');
  const migrator = require(path.join(__dirname, '..', 'src', 'services', 'migrator'));
  const migResult = await migrator.run({ db, logger: console });
  console.log('   migrator:', migResult);

  // 2. Seed app_catalog.
  step(2, 'Seeding app_catalog with worldmonitor manifest');
  const sha = crypto.createHash('sha256').update(MANIFEST_YAML).digest('hex');
  db.prepare(`DELETE FROM app_catalog WHERE slug = ?`).run(SLUG);
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

  // 3. Start the Express server (no Electron).
  step(3, 'Starting OS8 Express server (no Electron)');
  const { startServer, getPort, stopServer } = require(path.join(__dirname, '..', 'src', 'server'));
  await startServer(null, db);
  const port = getPort();
  console.log(`   server up on http://localhost:${port}`);

  // 4. Init AppProcessRegistry (main.js does this in the Electron path).
  step(4, 'Initializing AppProcessRegistry');
  const APR = require(path.join(__dirname, '..', 'src', 'services', 'app-process-registry'));
  APR.init({ db, getOS8Port: getPort });

  let result = { passed: false };
  let externalAppId = null;

  try {
    // 5. POST /api/app-store/install
    step(5, 'POST /api/app-store/install');
    const startRes = await fetchJson(`http://127.0.0.1:${port}/api/app-store/install`, {
      method: 'POST',
      body: { slug: SLUG, commit: COMMIT, channel: 'verified', source: 'manual' },
    });
    console.log(`   ${startRes.status} ${JSON.stringify(startRes.body)}`);
    if (startRes.status !== 202) throw new Error(`install rejected: ${JSON.stringify(startRes.body)}`);
    const jobId = startRes.body.jobId;

    step(5, 'Polling for awaiting_approval (clone + review)');
    const deadline1 = Date.now() + 90_000;
    let lastStatus;
    while (Date.now() < deadline1) {
      const job = await fetchJson(`http://127.0.0.1:${port}/api/app-store/jobs/${jobId}`);
      if (job.body?.status !== lastStatus) {
        lastStatus = job.body.status;
        console.log(`   status=${lastStatus}` +
          (job.body.reviewReport ? ` riskLevel=${job.body.reviewReport.riskLevel}` : ''));
      }
      if (job.body.status === 'awaiting_approval') break;
      if (job.body.status === 'failed') throw new Error(`pre-approval failed: ${job.body.errorMessage}`);
      await new Promise(r => setTimeout(r, 500));
    }
    if (lastStatus !== 'awaiting_approval') throw new Error(`timed out waiting for awaiting_approval (last=${lastStatus})`);

    // 6. POST /jobs/:id/approve. Worldmonitor declares no required secrets.
    step(6, 'POST /jobs/:id/approve (this triggers npm ci — patience!)');
    const approveRes = await fetchJson(
      `http://127.0.0.1:${port}/api/app-store/jobs/${jobId}/approve`,
      { method: 'POST', body: { secrets: {} } }
    );
    console.log(`   ${approveRes.status} ${JSON.stringify(approveRes.body)}`);
    if (approveRes.status !== 202) throw new Error(`approve rejected: ${JSON.stringify(approveRes.body)}`);

    step(6, 'Polling for installed');
    const deadline2 = Date.now() + 600_000;     // 10 min — npm ci of 26+18 deps
    lastStatus = null;
    while (Date.now() < deadline2) {
      const job = await fetchJson(`http://127.0.0.1:${port}/api/app-store/jobs/${jobId}`);
      if (job.body?.status !== lastStatus) {
        lastStatus = job.body.status;
        console.log(`   [${new Date().toISOString().slice(11,19)}] status=${lastStatus}` +
          (job.body.errorMessage ? ` error=${job.body.errorMessage.slice(0, 200)}` : ''));
      }
      if (job.body.status === 'installed') {
        externalAppId = job.body.appId;
        break;
      }
      if (job.body.status === 'failed') throw new Error(`install failed: ${job.body.errorMessage}`);
      await new Promise(r => setTimeout(r, 2000));
    }
    if (lastStatus !== 'installed') throw new Error(`timed out waiting for installed (last=${lastStatus})`);

    // 7. Verify apps row.
    step(7, 'Verify apps row');
    const appRow = db.prepare(
      `SELECT id, slug, app_type, status, channel FROM apps WHERE external_slug = ?`
    ).get(SLUG);
    console.log('   row:', appRow);
    if (!appRow || appRow.app_type !== 'external' || appRow.status !== 'active') {
      throw new Error(`apps row not in expected state: ${JSON.stringify(appRow)}`);
    }

    const appDir = path.join(OS8_HOME, 'apps', appRow.id);
    if (!fs.existsSync(path.join(appDir, 'package.json'))) {
      throw new Error(`app dir missing package.json: ${appDir}`);
    }
    if (!fs.existsSync(path.join(appDir, 'node_modules'))) {
      throw new Error(`node_modules missing — npm ci didn't run?`);
    }
    console.log(`   appDir=${appDir} (has node_modules ✓)`);

    // 8. Start the dev server via /processes/start.
    step(8, `POST /api/apps/${appRow.id}/processes/start`);
    const startProc = await fetchJson(
      `http://127.0.0.1:${port}/api/apps/${appRow.id}/processes/start`,
      { method: 'POST' }
    );
    console.log(`   ${startProc.status} ${JSON.stringify(startProc.body)}`);
    if (startProc.status !== 200) throw new Error(`start failed: ${JSON.stringify(startProc.body)}`);

    // 9. curl http://worldmonitor.localhost:<port>/ via the proxy.
    step(9, 'GET http://worldmonitor.localhost:<port>/ via reverse proxy');
    let proxyRes;
    for (let i = 0; i < 60; i++) {
      try {
        proxyRes = await fetchRaw(
          `http://127.0.0.1:${port}/`,
          `${SLUG}.localhost:${port}`
        );
        if (proxyRes.status === 200 || proxyRes.status === 304) break;
      } catch (_) { /* retry */ }
      await new Promise(r => setTimeout(r, 500));
    }
    console.log(`   status=${proxyRes?.status} body[0..200]=${(proxyRes?.body || '').slice(0, 200)}`);
    if (!proxyRes || proxyRes.status !== 200) throw new Error(`proxy did not return 200`);

    // 10. Sanitized env: confirm the worldmonitor process didn't inherit API keys.
    step(10, 'Verify sanitized env via /proc/<pid>/environ');
    const procInfo = APR.get().get(appRow.id);
    if (!procInfo?.pid) throw new Error('no pid for running process');
    const envFile = `/proc/${procInfo.pid}/environ`;
    let leaked = [];
    if (fs.existsSync(envFile)) {
      const env = fs.readFileSync(envFile, 'utf8').split('\0').filter(Boolean);
      const envObj = Object.fromEntries(env.map(e => {
        const i = e.indexOf('=');
        return [e.slice(0, i), e.slice(i + 1)];
      }));
      const dangerKeys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY',
                          'ELEVENLABS_API_KEY', 'GOOGLE_API_KEY', 'OS8_HOME'];
      leaked = dangerKeys.filter(k => envObj[k] !== undefined);
      console.log(`   env keys total=${Object.keys(envObj).length}`);
      console.log(`   OS8_APP_ID=${envObj.OS8_APP_ID}`);
      console.log(`   OS8_API_BASE=${envObj.OS8_API_BASE}`);
      console.log(`   PORT=${envObj.PORT}`);
      console.log(`   leaked sensitive vars: ${leaked.length === 0 ? '(none)' : leaked.join(', ')}`);
    } else {
      console.log(`   /proc not available — skip env leak check`);
    }
    if (leaked.length > 0) throw new Error(`env leak: ${leaked.join(', ')}`);

    result.passed = true;
    console.log('\n=================================================');
    console.log('  Phase 1A acceptance: PASSED');
    console.log('=================================================');
  } catch (err) {
    console.error('\n=================================================');
    console.error('  Phase 1A acceptance: FAILED');
    console.error(`  ${err.message}`);
    console.error('=================================================');
    if (err.stack) console.error(err.stack.split('\n').slice(0, 6).join('\n'));
  } finally {
    // Cleanup.
    try {
      const inst = APR.get();
      if (externalAppId) await inst.stop(externalAppId, { reason: 'acceptance-cleanup' });
      await inst.stopAll();
    } catch (_) { /* ignore */ }
    try { await stopServer(); } catch (_) { /* ignore */ }
    try { db.close(); } catch (_) { /* ignore */ }
    // Force exit so any lingering listeners don't keep us alive.
    setTimeout(() => process.exit(result.passed ? 0 : 1), 1000).unref();
  }
}

main().catch(err => {
  console.error('Harness crash:', err);
  process.exit(2);
});
