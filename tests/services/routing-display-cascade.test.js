import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const Database = require('better-sqlite3');

function loadRouting() {
  delete require.cache[require.resolve('../../src/services/routing')];
  delete require.cache[require.resolve('../../src/services/launcher-client')];
  return require('../../src/services/routing');
}

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE ai_model_families (
      id TEXT PRIMARY KEY,
      container_id TEXT,
      name TEXT,
      display_name TEXT,
      cli_model_arg TEXT,
      cap_chat INTEGER DEFAULT 0,
      cap_image INTEGER DEFAULT 0,
      eligible_tasks TEXT,
      launcher_model TEXT,
      launcher_backend TEXT,
      supports_vision INTEGER DEFAULT 0,
      display_order INTEGER DEFAULT 0
    );
    CREATE TABLE routing_cascade (
      task_type TEXT, mode TEXT, family_id TEXT, access_method TEXT,
      enabled INTEGER DEFAULT 1, priority INTEGER DEFAULT 0,
      is_auto_generated INTEGER DEFAULT 1
    );
  `);
  const insertFam = db.prepare(`
    INSERT INTO ai_model_families
      (id, container_id, name, display_name, cli_model_arg, cap_chat, cap_image, eligible_tasks, launcher_model, launcher_backend, supports_vision, display_order)
    VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?, 'vllm', ?, ?)
  `);
  insertFam.run('local-qwen3-6-35b-a3b', 'Qwen3.6-35B', 'Qwen3.6 35B', 'qwen3-6-35b-a3b', 4, 0,
                'conversation,summary,planning,coding,jobs', 'qwen3-6-35b-a3b', 1, 6);
  insertFam.run('local-aeon-7-gemma-4-26b', 'AEON-7 Gemma-4-26B', 'AEON-7 Gemma 4 26B', 'aeon-7-gemma-4-26b', 4, 0,
                'conversation,summary,planning,coding,jobs', 'aeon-7-gemma-4-26b', 0, 7);
  insertFam.run('local-flux1-kontext-dev', 'Flux Kontext', 'Flux Kontext', 'flux1-kontext-dev', 0, 4,
                'image', 'flux1-kontext-dev', 0, 10);

  // Seed a multi-row cascade in DB for both modes so we can verify
  // getDisplayCascade collapses it under local mode.
  const insertCasc = db.prepare(
    `INSERT INTO routing_cascade (task_type, mode, family_id, access_method, enabled, priority) VALUES (?, ?, ?, 'api', 1, ?)`
  );
  insertCasc.run('conversation', 'local', 'local-qwen3-6-35b-a3b', 0);
  insertCasc.run('conversation', 'local', 'local-aeon-7-gemma-4-26b', 1);
  insertCasc.run('image',        'local', 'local-flux1-kontext-dev', 0);

  db.prepare(`INSERT INTO settings (key, value) VALUES ('ai_mode', 'local')`).run();
  return db;
}

async function tick() { await new Promise(r => setTimeout(r, 50)); }

describe('RoutingService.getDisplayCascade — collapses to launcher selection in local-mode chat', () => {
  let originalFetch;
  let RoutingService;
  beforeEach(() => {
    originalFetch = global.fetch;
    RoutingService = loadRouting();
  });
  afterEach(() => { global.fetch = originalFetch; });

  it('returns a single row for chat tasks in local mode pointing at the launcher selection', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ chat: { selected: 'aeon-7-gemma-4-26b' } })
    }));
    const db = makeDb();
    // Warm cache.
    RoutingService.getDisplayCascade(db, 'conversation');
    await tick();
    const rows = RoutingService.getDisplayCascade(db, 'conversation');
    expect(rows).toHaveLength(1);
    expect(rows[0].family_id).toBe('local-aeon-7-gemma-4-26b');
    expect(rows[0].local_launcher_selection).toBe(true);
    expect(rows[0].enabled).toBe(1);
    db.close();
  });

  it('returns a single row pointing at Qwen when the launcher selects it', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ chat: { selected: 'qwen3-6-35b-a3b' } })
    }));
    const db = makeDb();
    RoutingService.getDisplayCascade(db, 'conversation');
    await tick();
    const rows = RoutingService.getDisplayCascade(db, 'conversation');
    expect(rows).toHaveLength(1);
    expect(rows[0].family_id).toBe('local-qwen3-6-35b-a3b');
    expect(rows[0].local_launcher_selection).toBe(true);
    db.close();
  });

  it('applies the same single-row collapse to all chat task types', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ chat: { selected: 'aeon-7-gemma-4-26b' } })
    }));
    const db = makeDb();
    RoutingService.getDisplayCascade(db, 'conversation');
    await tick();
    for (const task of ['conversation', 'summary', 'planning', 'coding', 'jobs']) {
      const rows = RoutingService.getDisplayCascade(db, task);
      expect(rows, `task=${task}`).toHaveLength(1);
      expect(rows[0].family_id, `task=${task}`).toBe('local-aeon-7-gemma-4-26b');
      expect(rows[0].task_type, `task=${task}`).toBe(task);
    }
    db.close();
  });

  it('returns the full cascade for image tasks under local mode (not collapsed)', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ chat: { selected: 'aeon-7-gemma-4-26b' } })
    }));
    const db = makeDb();
    const rows = RoutingService.getDisplayCascade(db, 'image');
    expect(rows).toHaveLength(1);
    expect(rows[0].family_id).toBe('local-flux1-kontext-dev');
    expect(rows[0].local_launcher_selection).toBeUndefined();
    db.close();
  });

  it('returns the full cascade under proprietary mode (no collapse)', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    const db = makeDb();
    db.prepare(`UPDATE settings SET value = 'proprietary' WHERE key = 'ai_mode'`).run();
    // Seed proprietary cascade with both rows.
    db.prepare(`
      INSERT INTO routing_cascade (task_type, mode, family_id, access_method, enabled, priority)
      VALUES ('conversation', 'proprietary', 'local-qwen3-6-35b-a3b', 'api', 1, 0),
             ('conversation', 'proprietary', 'local-aeon-7-gemma-4-26b', 'api', 1, 1)
    `).run();
    const rows = RoutingService.getDisplayCascade(db, 'conversation');
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.local_launcher_selection).toBeUndefined();
    }
    db.close();
  });
});
