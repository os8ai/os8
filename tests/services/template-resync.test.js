import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { resyncAppShellFiles, isShellOwned, renderTemplate } = require('../../src/services/template-resync');

describe('isShellOwned', () => {
  it('accepts src/ subtree', () => {
    expect(isShellOwned('src/components/Chat.jsx')).toBe(true);
    expect(isShellOwned('src/hooks/useTTSStream.js')).toBe(true);
    expect(isShellOwned('src/App.jsx')).toBe(true);
  });
  it('accepts index.html exactly', () => {
    expect(isShellOwned('index.html')).toBe(true);
  });
  it('rejects top-level state files', () => {
    expect(isShellOwned('USER.md')).toBe(false);
    expect(isShellOwned('MYSELF.md')).toBe(false);
    expect(isShellOwned('claude-user.md')).toBe(false);
    expect(isShellOwned('assistant-config.json')).toBe(false);
    expect(isShellOwned('tasks.json')).toBe(false);
  });
});

describe('renderTemplate', () => {
  it('substitutes {{VAR}} placeholders', () => {
    expect(renderTemplate('hi {{NAME}}', { NAME: 'world' })).toBe('hi world');
    expect(renderTemplate('{{A}}-{{B}}-{{A}}', { A: 'x', B: 'y' })).toBe('x-y-x');
  });
  it('leaves unknown variables alone', () => {
    expect(renderTemplate('{{UNKNOWN}}', { NAME: 'x' })).toBe('{{UNKNOWN}}');
  });
});

describe('resyncAppShellFiles', () => {
  let tmpRoot;
  let templatesDir;
  let appDir;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-resync-'));
    templatesDir = path.join(tmpRoot, 'templates');
    appDir = path.join(tmpRoot, 'app');

    // Build a fixture template tree: templates/base + templates/mytmpl
    mkdirs(templatesDir, 'base/src');
    mkdirs(templatesDir, 'mytmpl/src/components');
    fs.writeFileSync(path.join(templatesDir, 'base/index.html'), '<title>{{APP_NAME}}</title>');
    fs.writeFileSync(path.join(templatesDir, 'base/src/main.jsx'), 'basename="/{{ID}}"');
    fs.writeFileSync(path.join(templatesDir, 'mytmpl/src/components/Chat.jsx'), 'new Chat v2');
    // User-owned file at top level — should NOT be resynced.
    fs.writeFileSync(path.join(templatesDir, 'mytmpl/USER.md'), 'Owner: {{OWNER_NAME}}');

    fs.mkdirSync(appDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('creates files on a freshly empty app dir (no backups)', () => {
    const r = resyncAppShellFiles({
      appDir,
      templateName: 'mytmpl',
      variables: { APP_NAME: 'Hello', ID: 'abc123', OWNER_NAME: 'Leo' },
      templatesDir
    });
    expect(r.created.sort()).toEqual(
      ['index.html', path.join('src', 'components', 'Chat.jsx'), path.join('src', 'main.jsx')].sort()
    );
    expect(r.updated).toEqual([]);
    expect(r.backupRoot).toBeNull();
    expect(fs.readFileSync(path.join(appDir, 'index.html'), 'utf-8')).toBe('<title>Hello</title>');
    expect(fs.readFileSync(path.join(appDir, 'src/main.jsx'), 'utf-8')).toBe('basename="/abc123"');
    expect(fs.readFileSync(path.join(appDir, 'src/components/Chat.jsx'), 'utf-8')).toBe('new Chat v2');
  });

  it('skips files that already match rendered content', () => {
    // Pre-populate appDir with files that match the (rendered) template.
    mkdirs(appDir, 'src/components');
    fs.writeFileSync(path.join(appDir, 'index.html'), '<title>Hello</title>');
    fs.writeFileSync(path.join(appDir, 'src/main.jsx'), 'basename="/abc123"');
    fs.writeFileSync(path.join(appDir, 'src/components/Chat.jsx'), 'new Chat v2');

    const r = resyncAppShellFiles({
      appDir,
      templateName: 'mytmpl',
      variables: { APP_NAME: 'Hello', ID: 'abc123', OWNER_NAME: 'Leo' },
      templatesDir
    });

    expect(r.updated).toEqual([]);
    expect(r.created).toEqual([]);
    expect(r.skipped.length).toBe(3);
    expect(r.backupRoot).toBeNull();
  });

  it('backs up and overwrites differing files', () => {
    mkdirs(appDir, 'src/components');
    fs.writeFileSync(path.join(appDir, 'src/components/Chat.jsx'), 'OLD Chat content');

    const r = resyncAppShellFiles({
      appDir,
      templateName: 'mytmpl',
      variables: { APP_NAME: 'Hello', ID: 'abc123', OWNER_NAME: 'Leo' },
      templatesDir
    });

    expect(r.updated).toEqual([path.join('src', 'components', 'Chat.jsx')]);
    expect(r.backupRoot).toBeTruthy();
    expect(fs.readFileSync(path.join(r.backupRoot, 'src/components/Chat.jsx'), 'utf-8'))
      .toBe('OLD Chat content');
    expect(fs.readFileSync(path.join(appDir, 'src/components/Chat.jsx'), 'utf-8'))
      .toBe('new Chat v2');
  });

  it('leaves user-owned top-level files untouched even if they differ', () => {
    fs.writeFileSync(path.join(appDir, 'USER.md'), 'my personal notes');
    const r = resyncAppShellFiles({
      appDir,
      templateName: 'mytmpl',
      variables: { APP_NAME: 'Hello', ID: 'abc123', OWNER_NAME: 'Leo' },
      templatesDir
    });
    expect(r.updated.concat(r.created)).not.toContain('USER.md');
    expect(fs.readFileSync(path.join(appDir, 'USER.md'), 'utf-8')).toBe('my personal notes');
  });

  it('template layer dedups with later layer winning (mytmpl beats base)', () => {
    // Override base/src/main.jsx in mytmpl — mytmpl's should win.
    fs.writeFileSync(path.join(templatesDir, 'mytmpl/src/main.jsx'), 'FROM MYTMPL {{ID}}');
    const r = resyncAppShellFiles({
      appDir,
      templateName: 'mytmpl',
      variables: { APP_NAME: 'Hello', ID: 'abc123', OWNER_NAME: 'Leo' },
      templatesDir
    });
    expect(fs.readFileSync(path.join(appDir, 'src/main.jsx'), 'utf-8')).toBe('FROM MYTMPL abc123');
    expect(r.created).toContain(path.join('src', 'main.jsx'));
  });
});

function mkdirs(root, rel) {
  fs.mkdirSync(path.join(root, rel), { recursive: true });
}
