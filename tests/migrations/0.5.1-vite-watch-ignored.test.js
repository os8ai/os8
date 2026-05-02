import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

describe('migration 0.5.1 — Vite watch.ignored backfill', () => {
  let tmpHome;
  let prevHome;
  let MIGRATION;
  let coreDir;

  beforeEach(() => {
    // Stage OS8_HOME under a temp dir; reset module cache so config + core
    // re-read OS8_HOME (the constants capture env at require time).
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-mig-0.5.1-'));
    prevHome = process.env.OS8_HOME;
    process.env.OS8_HOME = tmpHome;
    delete require.cache[require.resolve('../../src/config')];
    delete require.cache[require.resolve('../../src/services/core')];
    delete require.cache[require.resolve('../../src/migrations/0.5.1-vite-watch-ignored')];
    MIGRATION = require('../../src/migrations/0.5.1-vite-watch-ignored');

    coreDir = path.join(tmpHome, 'core');
    fs.mkdirSync(coreDir, { recursive: true });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.OS8_HOME;
    else process.env.OS8_HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('declares version 0.5.1 and a description', () => {
    expect(MIGRATION.version).toBe('0.5.1');
    expect(typeof MIGRATION.description).toBe('string');
    expect(MIGRATION.description.length).toBeGreaterThan(0);
  });

  it('no-op when ~/os8/core/vite.config.js does not exist (fresh install)', async () => {
    // Pre-condition: file is absent.
    const target = path.join(coreDir, 'vite.config.js');
    expect(fs.existsSync(target)).toBe(false);

    await MIGRATION.up({ logger: silentLogger });

    // Migration must not create the file (initialize() owns fresh-install setup).
    expect(fs.existsSync(target)).toBe(false);
  });

  it('rewrites a pre-0.5.1 vite.config.js (no watch.ignored) to the new template', async () => {
    const target = path.join(coreDir, 'vite.config.js');
    const before = `import { defineConfig } from 'vite';
export default defineConfig({
  server: {
    middlewareMode: true,
    hmr: { port: 5174 }
  }
});
`;
    fs.writeFileSync(target, before);

    await MIGRATION.up({ logger: silentLogger });

    const after = fs.readFileSync(target, 'utf8');
    expect(after).toContain("'**/.venv/**'");
    expect(after).toContain("'**/__pycache__/**'");
    expect(after).toContain("'**/.git/**'");
    expect(after).toContain("'**/node_modules/**'");
    expect(after).toContain("'**/.pytest_cache/**'");
    expect(after).toContain("'**/.mypy_cache/**'");

    // Backup of the previous (different) file should exist.
    const backups = fs.readdirSync(coreDir).filter(f => /^vite\.config\.js\.\d+\.bak$/.test(f));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(coreDir, backups[0]), 'utf8')).toBe(before);
  });

  it('is a no-op when watch.ignored already present', async () => {
    const target = path.join(coreDir, 'vite.config.js');
    // Embed the marker the migration looks for.
    const already = `// already migrated
export default {
  server: { watch: { ignored: ['**/.venv/**', '**/.git/**'] } }
};
`;
    fs.writeFileSync(target, already);

    await MIGRATION.up({ logger: silentLogger });

    expect(fs.readFileSync(target, 'utf8')).toBe(already);
    // No backup created.
    const backups = fs.readdirSync(coreDir).filter(f => /\.bak$/.test(f));
    expect(backups).toHaveLength(0);
  });

  it('idempotent — running twice produces the same state', async () => {
    const target = path.join(coreDir, 'vite.config.js');
    fs.writeFileSync(target, '// stale config without ignored\n');

    await MIGRATION.up({ logger: silentLogger });
    const afterFirst = fs.readFileSync(target, 'utf8');

    await MIGRATION.up({ logger: silentLogger });
    const afterSecond = fs.readFileSync(target, 'utf8');

    expect(afterSecond).toBe(afterFirst);

    // Only one backup (from the first run) — second run shouldn't re-back-up.
    const backups = fs.readdirSync(coreDir).filter(f => /\.bak$/.test(f));
    expect(backups).toHaveLength(1);
  });

  it('preserves a hand-edited config by writing a backup before overwrite', async () => {
    const target = path.join(coreDir, 'vite.config.js');
    const handEdited = `// User hand-edited this for their custom alias
import { defineConfig } from 'vite';
export default defineConfig({
  resolve: { alias: { '@my-special': '/somewhere' } },
  server: { middlewareMode: true, hmr: { port: 5174 } }
});
`;
    fs.writeFileSync(target, handEdited);

    await MIGRATION.up({ logger: silentLogger });

    // New file has the ignored list.
    expect(fs.readFileSync(target, 'utf8')).toContain("'**/.venv/**'");

    // Old file is backed up byte-for-byte.
    const backups = fs.readdirSync(coreDir).filter(f => /^vite\.config\.js\.\d+\.bak$/.test(f));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(coreDir, backups[0]), 'utf8')).toBe(handEdited);
  });
});
