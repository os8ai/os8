import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const Database = require('better-sqlite3');
const { buildUserContent } = require('../../src/services/cli-runner');
const { getBackend } = require('../../src/services/backend-adapter');

// In-memory DB just for the supportsVisionForFamily helper, which queries
// ai_model_families.supports_vision via AIRegistryService.getFamily.
function makeDb(rows = []) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ai_model_families (
      id TEXT PRIMARY KEY,
      container_id TEXT NOT NULL,
      name TEXT NOT NULL,
      supports_vision INTEGER DEFAULT 0
    );
  `);
  for (const r of rows) {
    db.prepare(`INSERT INTO ai_model_families (id, container_id, name, supports_vision) VALUES (?, ?, ?, ?)`)
      .run(r.id, r.container_id || 'local', r.name || r.id, r.supports_vision ? 1 : 0);
  }
  return db;
}

describe('buildUserContent — multimodal request body (Phase 3 §4.6)', () => {
  it('returns plain string when there are no attachments', () => {
    expect(buildUserContent('hello', null)).toBe('hello');
    expect(buildUserContent('hello', [])).toBe('hello');
  });

  it('returns array with image_url part(s) followed by text part', () => {
    const content = buildUserContent('describe', [
      { mimeType: 'image/png', data: 'AAAA' }
    ]);
    expect(Array.isArray(content)).toBe(true);
    expect(content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      { type: 'text', text: 'describe' }
    ]);
  });

  it('handles multiple images, text part appears last', () => {
    const content = buildUserContent('compare', [
      { mimeType: 'image/jpeg', data: 'IMG1' },
      { mimeType: 'image/png',  data: 'IMG2' }
    ]);
    expect(content).toHaveLength(3);
    expect(content[0].type).toBe('image_url');
    expect(content[1].type).toBe('image_url');
    expect(content[2]).toEqual({ type: 'text', text: 'compare' });
  });

  it('skips attachments missing mimeType or data (defensive)', () => {
    const content = buildUserContent('q', [
      { mimeType: 'image/png', data: 'OK' },
      { mimeType: 'image/png' },                  // missing data
      { data: 'ZZ' },                             // missing mimeType
      null
    ]);
    // Only the well-formed entry survives, plus the text part.
    expect(content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,OK' } },
      { type: 'text', text: 'q' }
    ]);
  });
});

describe('local backend supportsVisionForFamily (Phase 3 §4.6)', () => {
  let db;

  beforeEach(() => {
    db = makeDb([
      { id: 'local-gemma-4-31b',     supports_vision: false },
      { id: 'local-qwen3-6-35b-a3b', supports_vision: true }
    ]);
  });
  afterEach(() => db.close());

  it('returns true for a vision-capable family', () => {
    const local = getBackend('local');
    expect(local.supportsVisionForFamily('local-qwen3-6-35b-a3b', db)).toBe(true);
  });

  it('returns false for a non-vision family', () => {
    const local = getBackend('local');
    expect(local.supportsVisionForFamily('local-gemma-4-31b', db)).toBe(false);
  });

  it('returns false for unknown family id', () => {
    const local = getBackend('local');
    expect(local.supportsVisionForFamily('does-not-exist', db)).toBe(false);
  });

  it('returns false when args are missing (defensive)', () => {
    const local = getBackend('local');
    expect(local.supportsVisionForFamily(null, db)).toBe(false);
    expect(local.supportsVisionForFamily('local-qwen3-6-35b-a3b', null)).toBe(false);
  });

  it('local backend now has supportsImageInput=true (the per-backend gate)', () => {
    const local = getBackend('local');
    expect(local.supportsImageInput).toBe(true);
    // Non-local backends are unchanged.
    expect(getBackend('claude').supportsImageInput).toBe(true);   // Claude still true
    expect(getBackend('codex').supportsImageInput).toBe(false);   // Codex still uses --image
    expect(getBackend('gemini').supportsImageInput).toBe(false);  // Gemini unchanged
    expect(getBackend('grok').supportsImageInput).toBe(false);    // Grok unchanged
  });

  it('non-local backends do not define supportsVisionForFamily — optional-chain returns undefined', () => {
    expect(getBackend('claude').supportsVisionForFamily).toBeUndefined();
    expect(getBackend('codex').supportsVisionForFamily).toBeUndefined();
    expect(getBackend('gemini').supportsVisionForFamily).toBeUndefined();
    expect(getBackend('grok').supportsVisionForFamily).toBeUndefined();
  });
});
