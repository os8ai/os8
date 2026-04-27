import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const Database = require('better-sqlite3');

// Reload routing fresh per test so the in-process launcher-chat cache
// doesn't leak between cases.
function loadRouting() {
  delete require.cache[require.resolve('../../src/services/routing')];
  delete require.cache[require.resolve('../../src/services/launcher-client')];
  return require('../../src/services/routing');
}

// Minimum DB schema RoutingService.resolve() touches in local mode.
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
      eligible_tasks TEXT,
      launcher_model TEXT,
      launcher_backend TEXT,
      supports_vision INTEGER DEFAULT 0,
      display_order INTEGER DEFAULT 0
    );
    CREATE TABLE ai_containers (
      id TEXT PRIMARY KEY, provider_id TEXT, type TEXT, has_login INTEGER DEFAULT 0
    );
    CREATE TABLE ai_account_status (provider_id TEXT PRIMARY KEY);
    CREATE TABLE routing_cascade (
      task_type TEXT, mode TEXT, family_id TEXT, access_method TEXT,
      enabled INTEGER DEFAULT 1, priority INTEGER DEFAULT 0
    );
  `);
  // Two chat-eligible local families. display_order picks the fallback
  // when the launcher hasn't replied yet.
  const insert = db.prepare(`
    INSERT INTO ai_model_families
      (id, container_id, name, display_name, cli_model_arg, cap_chat, eligible_tasks, launcher_model, launcher_backend, supports_vision, display_order)
    VALUES (?, 'local', ?, ?, ?, 4, ?, ?, 'vllm', ?, ?)
  `);
  insert.run('local-qwen3-6-35b-a3b', 'Qwen3.6-35B', 'Qwen3.6 35B', 'qwen3-6-35b-a3b',
             'conversation,summary,planning,coding,jobs', 'qwen3-6-35b-a3b', 1, 6);
  insert.run('local-aeon-7-gemma-4-26b', 'AEON-7 Gemma-4-26B', 'AEON-7 Gemma 4 26B', 'aeon-7-gemma-4-26b',
             'conversation,summary,planning,coding,jobs', 'aeon-7-gemma-4-26b', 0, 7);

  db.prepare(`INSERT INTO ai_containers (id, provider_id, type, has_login) VALUES ('local', 'local', 'http', 0)`).run();
  db.prepare(`INSERT INTO settings (key, value) VALUES ('ai_mode', 'local')`).run();
  return db;
}

async function tick() { await new Promise(r => setTimeout(r, 50)); }

describe('RoutingService.resolve — local-mode chat short-circuit reads launcher chooser', () => {
  let originalFetch;
  let RoutingService;

  beforeEach(() => {
    originalFetch = global.fetch;
    RoutingService = loadRouting();
  });
  afterEach(() => { global.fetch = originalFetch; });

  it('falls back to first chat-capable local family by display_order before the launcher replies', async () => {
    // fetch never resolves before we call resolve() — exercises the cold-cache path.
    global.fetch = vi.fn(() => new Promise(() => {}));
    const db = makeDb();
    const r = RoutingService.resolve(db, 'conversation');
    expect(r.familyId).toBe('local-qwen3-6-35b-a3b');
    expect(r.source).toBe('local_launcher_selection');
    expect(r.launcher_model).toBe('qwen3-6-35b-a3b');
    db.close();
  });

  it('routes to AEON-7 once the launcher reports it as the active chat selection', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        chat:      { selected: 'aeon-7-gemma-4-26b', options: [{model: 'qwen3-6-35b-a3b'}, {model: 'aeon-7-gemma-4-26b'}] },
        'image-gen': { selected: 'flux1-kontext-dev', options: [{model: 'flux1-kontext-dev'}] },
        tts:       { selected: 'kokoro-v1', options: [{model: 'kokoro-v1'}] }
      })
    }));
    const db = makeDb();
    // First call kicks off the async refresh; returns the fallback.
    RoutingService.resolve(db, 'conversation');
    await tick();
    // Subsequent call should pick up the cached launcher selection.
    const r = RoutingService.resolve(db, 'conversation');
    expect(r.familyId).toBe('local-aeon-7-gemma-4-26b');
    expect(r.launcher_model).toBe('aeon-7-gemma-4-26b');
    db.close();
  });

  it('applies the same launcher-driven family to all chat tasks (planning, coding, jobs, summary)', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        chat: { selected: 'aeon-7-gemma-4-26b', options: [{model: 'aeon-7-gemma-4-26b'}] }
      })
    }));
    const db = makeDb();
    RoutingService.resolve(db, 'conversation');
    await tick();
    for (const task of ['conversation', 'summary', 'planning', 'coding', 'jobs']) {
      const r = RoutingService.resolve(db, task);
      expect(r.familyId, `task=${task}`).toBe('local-aeon-7-gemma-4-26b');
    }
    db.close();
  });

  it('falls back gracefully when the launcher reports a model OS8 doesn\'t know about', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ chat: { selected: 'some-other-model' } })
    }));
    const db = makeDb();
    RoutingService.resolve(db, 'conversation');
    await tick();
    const r = RoutingService.resolve(db, 'conversation');
    // Unknown launcher_model → fall back to the lowest display_order chat family.
    expect(r.familyId).toBe('local-qwen3-6-35b-a3b');
    expect(r.source).toBe('local_launcher_selection');
    db.close();
  });

  it('does not short-circuit for image tasks under local mode', async () => {
    global.fetch = vi.fn(() => new Promise(() => {}));
    const db = makeDb();
    // 'image' is not in CHAT_TASKS — should fall through to cascade walk
    // (which is empty in this test, so it'll hit the local fallback at the
    // bottom of resolve()). Either way the source should NOT be
    // 'local_launcher_selection'.
    const r = RoutingService.resolve(db, 'image');
    expect(r.source).not.toBe('local_launcher_selection');
    db.close();
  });

  it('launcher selection wins over per-agent override in local mode + chat tasks', async () => {
    // The launcher chooser is the single source of truth in local mode —
    // a stale agentModel pin (e.g. local-qwen3-6-35b-a3b saved before the
    // multi-option chooser shipped) must NOT override the user's current
    // launcher selection. Otherwise users see "AEON-7 selected" in the
    // launcher but their agents still hit Qwen.
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        chat: { selected: 'aeon-7-gemma-4-26b', options: [{model: 'aeon-7-gemma-4-26b'}, {model: 'qwen3-6-35b-a3b'}] }
      })
    }));
    const db = makeDb();
    // Prime cache with launcher's selection.
    RoutingService.resolve(db, 'conversation');
    await tick();
    // Agent has Qwen pinned (legacy default). Resolve should still return AEON-7.
    const r = RoutingService.resolve(db, 'conversation', 'local-qwen3-6-35b-a3b');
    expect(r.familyId).toBe('local-aeon-7-gemma-4-26b');
    expect(r.source).toBe('local_launcher_selection');
    db.close();
  });

});

describe('RoutingService.resolve — purpose=agentSpawn switches local backend to opencode', () => {
  let originalFetch;
  let RoutingService;

  beforeEach(() => {
    originalFetch = global.fetch;
    RoutingService = loadRouting();
  });
  afterEach(() => { global.fetch = originalFetch; });

  it('returns backendId="local" (HTTP) for utility purpose under local mode chat tasks', async () => {
    global.fetch = vi.fn(() => new Promise(() => {}));
    const db = makeDb();
    // Default purpose='utility' — subconscious classifier, plan generator, etc.
    const r = RoutingService.resolve(db, 'summary');
    expect(r.backendId).toBe('local');
    expect(r.source).toBe('local_launcher_selection');
    db.close();
  });

  it('returns backendId="opencode" (CLI) for purpose=agentSpawn under local mode chat tasks', async () => {
    // Launcher fetch hangs → recommended_client falls back to 'opencode' (the safe default).
    // Source string switched from `_selection_` to `_recommended_` in 0.4.14 to reflect
    // that the launcher's per-model recommended_client field is now authoritative.
    global.fetch = vi.fn(() => new Promise(() => {}));
    const db = makeDb();
    const r = RoutingService.resolve(db, 'planning', null, { purpose: 'agentSpawn' });
    expect(r.backendId).toBe('opencode');
    expect(r.source).toBe('local_launcher_recommended_opencode');
  });

  it('preserves the family resolution when switching to opencode (same launcher_model)', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        chat: { selected: 'aeon-7-gemma-4-26b', options: [{model: 'aeon-7-gemma-4-26b'}] }
      })
    }));
    const db = makeDb();
    RoutingService.resolve(db, 'conversation');
    await tick();
    const utility = RoutingService.resolve(db, 'conversation');
    const agent = RoutingService.resolve(db, 'conversation', null, { purpose: 'agentSpawn' });
    // Same family + launcher_model — only the backend differs.
    expect(utility.familyId).toBe(agent.familyId);
    expect(utility.launcher_model).toBe(agent.launcher_model);
    expect(utility.backendId).toBe('local');
    expect(agent.backendId).toBe('opencode');
    db.close();
  });

  it('agentSpawn applies to every CHAT_TASKS member (conversation, summary, planning, coding, jobs)', async () => {
    global.fetch = vi.fn(() => new Promise(() => {}));
    const db = makeDb();
    for (const task of ['conversation', 'summary', 'planning', 'coding', 'jobs']) {
      const r = RoutingService.resolve(db, task, null, { purpose: 'agentSpawn' });
      expect(r.backendId, `task=${task}`).toBe('opencode');
    }
    db.close();
  });

  it('does not apply opencode swap to non-chat tasks (image stays on cascade)', async () => {
    global.fetch = vi.fn(() => new Promise(() => {}));
    const db = makeDb();
    const r = RoutingService.resolve(db, 'image', null, { purpose: 'agentSpawn' });
    // 'image' is not in CHAT_TASKS — short-circuit doesn't fire, opencode swap
    // never happens, falls through to cascade/fallback.
    expect(r.backendId).not.toBe('opencode');
  });

  it('does not affect proprietary-mode resolution (purpose flag is local-only)', async () => {
    global.fetch = vi.fn(() => new Promise(() => {}));
    const db = makeDb();
    db.prepare(`UPDATE settings SET value='proprietary' WHERE key='ai_mode'`).run();
    // No cascade rows in this test schema, no agent override, no families
    // matching proprietary — falls through to the hard fallback. Result
    // should be the same regardless of purpose flag.
    const utility = RoutingService.resolve(db, 'conversation');
    const agent = RoutingService.resolve(db, 'conversation', null, { purpose: 'agentSpawn' });
    expect(utility.backendId).toBe(agent.backendId);
    expect(utility.familyId).toBe(agent.familyId);
    db.close();
  });
});
