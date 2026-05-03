import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const Database = require('better-sqlite3');
const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );`);
  return db;
}

describe('app-telemetry — Phase 4 PR 4.4', () => {
  let db, tmpHome, prevHome;
  let AppTelemetry, SettingsService, MIGRATION;
  let originalFetch;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-tel-'));
    prevHome = process.env.OS8_HOME;
    process.env.OS8_HOME = tmpHome;
    [
      '../src/config',
      '../src/migrations/0.6.0-app-store-telemetry',
      '../src/services/app-telemetry',
      '../src/services/settings',
    ].forEach(p => { delete require.cache[require.resolve(p)]; });

    MIGRATION = require('../src/migrations/0.6.0-app-store-telemetry');
    AppTelemetry = require('../src/services/app-telemetry');
    SettingsService = require('../src/services/settings');

    db = makeDb();
    return MIGRATION.up({ db, logger: silentLogger });
  });

  afterEach(() => {
    AppTelemetry._resetFlushTimer();
    db.close();
    if (prevHome === undefined) delete process.env.OS8_HOME;
    else process.env.OS8_HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (originalFetch) globalThis.fetch = originalFetch;
    originalFetch = null;
    vi.restoreAllMocks();
  });

  function pendingCount() {
    return db.prepare('SELECT COUNT(*) AS c FROM app_telemetry_events WHERE sent_at IS NULL').get().c;
  }
  function sentCount() {
    return db.prepare('SELECT COUNT(*) AS c FROM app_telemetry_events WHERE sent_at IS NOT NULL').get().c;
  }
  function setOptIn(value) {
    SettingsService.set(db, 'app_store.telemetry.opt_in', value ? 'true' : 'false');
  }

  describe('isEnabled', () => {
    it('false by default (migration seeds opt_in=false)', () => {
      expect(AppTelemetry.isEnabled(db)).toBe(false);
    });
    it('true when opt_in is set to true', () => {
      setOptIn(true);
      expect(AppTelemetry.isEnabled(db)).toBe(true);
    });
    it('returns false when settings table is missing', () => {
      const bareDb = new Database(':memory:');
      expect(AppTelemetry.isEnabled(bareDb)).toBe(false);
      bareDb.close();
    });
  });

  describe('enqueue', () => {
    it('writes nothing when opted out', () => {
      AppTelemetry.enqueue(db, { kind: 'install_started', adapter: 'node' });
      expect(pendingCount()).toBe(0);
    });

    it('writes a row when opted in', () => {
      setOptIn(true);
      AppTelemetry.enqueue(db, { kind: 'install_started', adapter: 'node' });
      expect(pendingCount()).toBe(1);
    });

    it('sanitizer drops unknown keys', () => {
      setOptIn(true);
      AppTelemetry.enqueue(db, {
        kind: 'install_started',
        adapter: 'node',
        userEmail: 'leak@example.com',
        secret: 'shh',
      });
      const row = db.prepare('SELECT payload FROM app_telemetry_events').get();
      const payload = JSON.parse(row.payload);
      expect(payload).not.toHaveProperty('userEmail');
      expect(payload).not.toHaveProperty('secret');
      expect(payload.kind).toBe('install_started');
    });

    it('sanitizer pins os/arch from runtime', () => {
      setOptIn(true);
      AppTelemetry.enqueue(db, { kind: 'install_started', os: 'spoofed', arch: 'fake' });
      const row = db.prepare('SELECT payload FROM app_telemetry_events').get();
      const payload = JSON.parse(row.payload);
      expect(payload.os).toBe(process.platform);
      expect(payload.arch).toBe(process.arch);
    });

    it('refuses event without kind', () => {
      setOptIn(true);
      AppTelemetry.enqueue(db, { adapter: 'node' });
      expect(pendingCount()).toBe(0);
    });
  });

  describe('fingerprintFailure', () => {
    it('returns 16-char hex digest', () => {
      const fp = AppTelemetry.fingerprintFailure('npm ERR! 404 Not Found - https://registry.npmjs.org/foo');
      expect(fp).toMatch(/^[0-9a-f]{16}$/);
    });
    it('is deterministic for the same input', () => {
      const a = AppTelemetry.fingerprintFailure('cannot find module foo at /path/x.js');
      const b = AppTelemetry.fingerprintFailure('cannot find module foo at /path/x.js');
      expect(a).toBe(b);
    });
    it('strips path separators + numerics from the line before hashing', () => {
      // The strip rule replaces /\d/, /\//, /\\/ — so a path-only difference
      // would collapse, but residual filename text remains. This test just
      // confirms the strip happens by comparing two PIDs in identical messages
      // with different line numbers; the resulting hash matches.
      const a = AppTelemetry.fingerprintFailure('Error at line 42 of app.js');
      const b = AppTelemetry.fingerprintFailure('Error at line 99 of app.js');
      expect(a).toBe(b);
    });
    it('returns empty string for empty input', () => {
      expect(AppTelemetry.fingerprintFailure('')).toBe('');
      expect(AppTelemetry.fingerprintFailure(null)).toBe('');
    });
  });

  describe('getClientId / rotateClientId', () => {
    it('creates a UUID file on first call', () => {
      const id = AppTelemetry.getClientId();
      expect(id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(fs.existsSync(path.join(tmpHome, '.telemetry', 'client-id'))).toBe(true);
    });
    it('returns the same id on subsequent calls', () => {
      const a = AppTelemetry.getClientId();
      const b = AppTelemetry.getClientId();
      expect(a).toBe(b);
    });
    it('rotateClientId yields a different UUID', () => {
      const a = AppTelemetry.getClientId();
      const b = AppTelemetry.rotateClientId();
      expect(b).not.toBe(a);
      expect(AppTelemetry.getClientId()).toBe(b);
    });
  });

  describe('flush', () => {
    it('POSTs pending events when opted in', async () => {
      setOptIn(true);
      AppTelemetry.enqueue(db, { kind: 'install_started', adapter: 'node' });
      AppTelemetry.enqueue(db, { kind: 'install_succeeded', adapter: 'node', durationMs: 100 });

      originalFetch = globalThis.fetch;
      const fetchMock = vi.fn().mockResolvedValue(new Response(
        JSON.stringify({ ok: true, count: 2 }), { status: 200 }
      ));
      globalThis.fetch = fetchMock;

      const r = await AppTelemetry.flush(db);

      expect(r.sent).toBe(2);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe(AppTelemetry.TELEMETRY_ENDPOINT);
      const body = JSON.parse(opts.body);
      expect(body.clientId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(body.events).toHaveLength(2);
      expect(body.events.map(e => e.kind)).toEqual(['install_started', 'install_succeeded']);

      // Rows marked sent.
      expect(pendingCount()).toBe(0);
      expect(sentCount()).toBe(2);
    });

    it('drops pending events when opted out at flush time', async () => {
      setOptIn(true);
      AppTelemetry.enqueue(db, { kind: 'install_started', adapter: 'node' });
      // Toggle off mid-batch.
      setOptIn(false);
      const r = await AppTelemetry.flush(db);
      expect(r.sent).toBe(0);
      expect(r.dropped).toBe(1);
      expect(pendingCount()).toBe(0);
    });

    it('leaves rows unsent on network failure', async () => {
      setOptIn(true);
      AppTelemetry.enqueue(db, { kind: 'install_started', adapter: 'node' });

      originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      const r = await AppTelemetry.flush(db);
      expect(r.sent).toBe(0);
      expect(r.network).toBe('failed');
      expect(pendingCount()).toBe(1);
    });

    it('leaves rows unsent on HTTP 500', async () => {
      setOptIn(true);
      AppTelemetry.enqueue(db, { kind: 'install_started', adapter: 'node' });

      originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));

      const r = await AppTelemetry.flush(db);
      expect(r.sent).toBe(0);
      expect(r.status).toBe(500);
      expect(pendingCount()).toBe(1);
    });

    it('respects TELEMETRY_BATCH_SIZE', async () => {
      setOptIn(true);
      const total = AppTelemetry.TELEMETRY_BATCH_SIZE + 5;
      for (let i = 0; i < total; i++) {
        AppTelemetry.enqueue(db, { kind: 'install_started', adapter: 'node' });
      }

      originalFetch = globalThis.fetch;
      const fetchMock = vi.fn().mockResolvedValue(new Response(
        JSON.stringify({ ok: true }), { status: 200 }
      ));
      globalThis.fetch = fetchMock;

      const r = await AppTelemetry.flush(db);
      const sent = JSON.parse(fetchMock.mock.calls[0][1].body).events.length;
      expect(sent).toBe(AppTelemetry.TELEMETRY_BATCH_SIZE);
      expect(r.sent).toBe(AppTelemetry.TELEMETRY_BATCH_SIZE);
      // 5 still pending.
      expect(pendingCount()).toBe(5);
    });

    it('no-op when nothing pending', async () => {
      setOptIn(true);
      const r = await AppTelemetry.flush(db);
      expect(r).toEqual({ sent: 0, dropped: 0 });
    });
  });

  describe('sanitize (direct)', () => {
    it('drops every key not in the allowlist', () => {
      const out = AppTelemetry.sanitize({
        kind: 'install_started',
        adapter: 'node',
        userEmail: 'x@y',
        evil: 'sploit',
        framework: 'vite',
      });
      expect(Object.keys(out).sort()).toEqual(['adapter', 'arch', 'framework', 'kind', 'os']);
    });

    it('drops null and undefined values', () => {
      const out = AppTelemetry.sanitize({ kind: 'install_started', slug: null, commit: undefined });
      expect(out).not.toHaveProperty('slug');
      expect(out).not.toHaveProperty('commit');
    });
  });
});
