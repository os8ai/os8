/**
 * Phase 3 PR 3.1 — dev-import-drafter unit tests.
 *
 * github-importer is replaced module-wide with a fake that returns
 * canned responses for parseGithubUrl / getRepoMeta / resolveRef /
 * fetchRawFile / listTopLevel. The drafter then exercises the
 * detection branches (vite, streamlit, gradio, hugo, jekyll, static,
 * dockerfile-only-rejection, slug regex).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

function loadFresh() {
  delete require.cache[require.resolve('../src/services/github-importer')];
  delete require.cache[require.resolve('../src/services/dev-import-drafter')];
}

function installFakeImporter(fakes = {}) {
  delete require.cache[require.resolve('../src/services/github-importer')];
  const real = require('../src/services/github-importer');
  // Mutate the singleton — drafter requires it once and captures its
  // exports object reference.
  Object.assign(real, fakes);
}

const STAR_SHA = 'a'.repeat(40);

describe('dev-import-drafter — runtime + framework detection', () => {
  let Drafter;

  beforeEach(() => {
    loadFresh();
  });

  afterEach(() => {
    loadFresh();
  });

  it('detects vite via package.json dependency', async () => {
    installFakeImporter({
      parseGithubUrl: () => ({ owner: 'owner', repo: 'fix-vite', ref: null }),
      getRepoMeta: async () => ({
        clone_url: 'https://github.com/owner/fix-vite.git',
        default_branch: 'main',
        license: { spdx_id: 'MIT' },
        description: 'a vite app',
      }),
      resolveRef: async () => ({ ref: 'main', sha: STAR_SHA, kind: 'branch' }),
      listTopLevel: async () => ['package.json', 'package-lock.json', 'index.html'],
      fetchRawFile: async (_args) => {
        if (_args.path === 'package.json') return JSON.stringify({
          name: 'fix-vite',
          dependencies: { vite: '^5.0.0', react: '^18.0.0' },
          scripts: { dev: 'vite' },
        });
        return null;
      },
    });
    Drafter = require('../src/services/dev-import-drafter');
    const r = await Drafter.draft('https://github.com/owner/fix-vite');
    expect(r.manifest.framework).toBe('vite');
    expect(r.manifest.runtime.kind).toBe('node');
    expect(r.manifest.runtime.package_manager).toBe('npm');
    expect(r.manifest.start.argv).toContain('{{PORT}}');
    expect(r.upstreamResolvedCommit).toBe(STAR_SHA);
    expect(r.manifest.review.channel).toBe('developer-import');
  });

  it('detects streamlit via pyproject content + uses uv when uv.lock present', async () => {
    installFakeImporter({
      parseGithubUrl: () => ({ owner: 'owner', repo: 'streamlit-app', ref: null }),
      getRepoMeta: async () => ({
        clone_url: 'https://github.com/owner/streamlit-app.git',
        default_branch: 'main', license: null, description: '',
      }),
      resolveRef: async () => ({ ref: 'main', sha: STAR_SHA, kind: 'branch' }),
      listTopLevel: async () => ['pyproject.toml', 'uv.lock', 'app.py'],
      fetchRawFile: async ({ path }) => {
        if (path === 'pyproject.toml') return '[project]\nname="x"\ndependencies = ["streamlit"]\n';
        return null;
      },
    });
    Drafter = require('../src/services/dev-import-drafter');
    const r = await Drafter.draft('https://github.com/owner/streamlit-app');
    expect(r.manifest.framework).toBe('streamlit');
    expect(r.manifest.runtime.kind).toBe('python');
    expect(r.manifest.runtime.package_manager).toBe('uv');
    expect(r.manifest.start.argv[0]).toBe('streamlit');
  });

  it('detects gradio via requirements.txt', async () => {
    installFakeImporter({
      parseGithubUrl: () => ({ owner: 'owner', repo: 'g', ref: null }),
      getRepoMeta: async () => ({ clone_url: 'x', default_branch: 'main', license: null }),
      resolveRef: async () => ({ ref: 'main', sha: STAR_SHA, kind: 'branch' }),
      listTopLevel: async () => ['requirements.txt', 'app.py'],
      fetchRawFile: async ({ path }) => path === 'requirements.txt' ? 'gradio==4.0.0\n' : null,
    });
    Drafter = require('../src/services/dev-import-drafter');
    const r = await Drafter.draft('https://github.com/owner/g');
    expect(r.manifest.framework).toBe('gradio');
    expect(r.manifest.runtime.kind).toBe('python');
    expect(r.manifest.runtime.package_manager).toBe('pip');
  });

  it('detects hugo via config files (no package.json or python)', async () => {
    installFakeImporter({
      parseGithubUrl: () => ({ owner: 'owner', repo: 'site', ref: null }),
      getRepoMeta: async () => ({ clone_url: 'x', default_branch: 'main', license: null }),
      resolveRef: async () => ({ ref: 'main', sha: STAR_SHA, kind: 'branch' }),
      listTopLevel: async () => ['hugo.toml', 'content', 'index.md'],
      fetchRawFile: async () => null,
    });
    Drafter = require('../src/services/dev-import-drafter');
    const r = await Drafter.draft('https://github.com/owner/site');
    expect(r.manifest.framework).toBe('hugo');
    expect(r.manifest.runtime.kind).toBe('static');
    expect(r.manifest.start.argv[0]).toBe('hugo');
  });

  it('rejects Dockerfile-only repos with a clear error', async () => {
    installFakeImporter({
      parseGithubUrl: () => ({ owner: 'owner', repo: 'dockeronly', ref: null }),
      getRepoMeta: async () => ({ clone_url: 'x', default_branch: 'main', license: null }),
      resolveRef: async () => ({ ref: 'main', sha: STAR_SHA, kind: 'branch' }),
      listTopLevel: async () => ['Dockerfile', 'README.md'],
      fetchRawFile: async () => null,
    });
    Drafter = require('../src/services/dev-import-drafter');
    await expect(Drafter.draft('https://github.com/owner/dockeronly')).rejects.toThrow(/Dockerfile-only/);
  });

  it('throws when nothing recognisable is in the repo', async () => {
    installFakeImporter({
      parseGithubUrl: () => ({ owner: 'owner', repo: 'empty', ref: null }),
      getRepoMeta: async () => ({ clone_url: 'x', default_branch: 'main', license: null }),
      resolveRef: async () => ({ ref: 'main', sha: STAR_SHA, kind: 'branch' }),
      listTopLevel: async () => ['LICENSE'],
      fetchRawFile: async () => null,
    });
    Drafter = require('../src/services/dev-import-drafter');
    await expect(Drafter.draft('https://github.com/owner/empty')).rejects.toThrow(/could not detect runtime/);
  });

  it('falls back to npm script names when framework is generic', () => {
    Drafter = require('../src/services/dev-import-drafter');
    const argv = Drafter.defaultStartArgv('none', 'node', { scripts: { start: 'node server.js' } });
    expect(argv).toEqual(['npm', 'run', 'start']);
  });

  it('buildSlug normalises owner-repo and trims to 40 chars', () => {
    Drafter = require('../src/services/dev-import-drafter');
    expect(Drafter.buildSlug('Koala_73', 'WORLD-Monitor.app')).toBe('koala-73-world-monitor-app');
    const long = Drafter.buildSlug('a'.repeat(50), 'b'.repeat(50));
    expect(long.length).toBeLessThanOrEqual(40);
  });

  it('package_manager precedence respects pnpm > yarn > bun > npm', () => {
    Drafter = require('../src/services/dev-import-drafter');
    expect(Drafter.detectPackageManager({ topLevel: ['pnpm-lock.yaml', 'package-lock.json'], runtimeKind: 'node' })).toBe('pnpm');
    expect(Drafter.detectPackageManager({ topLevel: ['yarn.lock'], runtimeKind: 'node' })).toBe('yarn');
    expect(Drafter.detectPackageManager({ topLevel: ['bun.lockb'], runtimeKind: 'node' })).toBe('bun');
    expect(Drafter.detectPackageManager({ topLevel: ['package-lock.json'], runtimeKind: 'node' })).toBe('npm');
  });
});

describe('github-importer.parseGithubUrl', () => {
  let Importer;

  beforeEach(() => {
    delete require.cache[require.resolve('../src/services/github-importer')];
    Importer = require('../src/services/github-importer');
  });

  it('parses standard github.com URL', () => {
    expect(Importer.parseGithubUrl('https://github.com/owner/repo')).toEqual({
      owner: 'owner', repo: 'repo', ref: null,
    });
  });

  it('strips .git suffix', () => {
    expect(Importer.parseGithubUrl('https://github.com/owner/repo.git')).toEqual({
      owner: 'owner', repo: 'repo', ref: null,
    });
  });

  it('parses /tree/<ref> suffix', () => {
    expect(Importer.parseGithubUrl('https://github.com/owner/repo/tree/v1.2.3')).toEqual({
      owner: 'owner', repo: 'repo', ref: 'v1.2.3',
    });
  });

  it('rejects gist URLs', () => {
    expect(() => Importer.parseGithubUrl('https://gist.github.com/owner/abc123')).toThrow(/unsupported URL/);
  });

  it('rejects gitlab and other domains', () => {
    expect(() => Importer.parseGithubUrl('https://gitlab.com/owner/repo')).toThrow(/unsupported URL/);
  });

  it('rejects empty input', () => {
    expect(() => Importer.parseGithubUrl('')).toThrow(/unsupported URL/);
  });
});

describe('github-importer.resolveRef — annotated-tag dereferencing', () => {
  let Importer;
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    delete require.cache[require.resolve('../src/services/github-importer')];
    Importer = require('../src/services/github-importer');
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function mockFetch(handler) {
    global.fetch = (url, opts) => {
      const u = String(url);
      const result = handler(u, opts);
      if (!result) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      return Promise.resolve(result);
    };
  }

  it('returns 40-char COMMIT SHA when tag is annotated (regression: koala73/worldmonitor v2.5.23)', async () => {
    // Annotated tag — /git/refs/tags/<tag> returns object.type='tag' with the
    // tag-object SHA, NOT the commit SHA. /commits/{ref} resolves to the
    // underlying commit. We must use the latter.
    const TAG_OBJECT_SHA = '6417c972a840377cfc4327ae063fe9606c7d2f3b';
    const COMMIT_SHA     = 'e51058e1765ef2f0c83ccb1d08d984bc59d23f10';

    mockFetch((url) => {
      if (url.includes('/repos/koala73/worldmonitor/commits/v2.5.23')) {
        return { ok: true, status: 200, json: async () => ({ sha: COMMIT_SHA }) };
      }
      return null;
    });

    const r = await Importer.resolveRef({ owner: 'koala73', repo: 'worldmonitor', ref: 'v2.5.23' });
    expect(r.sha).toBe(COMMIT_SHA);
    expect(r.sha).not.toBe(TAG_OBJECT_SHA);
  });

  it('passes through 40-char SHA without an API call', async () => {
    let called = false;
    mockFetch(() => { called = true; return null; });
    const sha = 'a'.repeat(40);
    const r = await Importer.resolveRef({ owner: 'x', repo: 'y', ref: sha });
    expect(r.sha).toBe(sha);
    expect(called).toBe(false);
  });

  it('falls back to default branch when no ref + no releases', async () => {
    mockFetch((url) => {
      if (url.includes('/releases/latest')) return { ok: false, status: 404, json: async () => ({}) };
      if (url.endsWith('/repos/x/y'))        return { ok: true,  status: 200, json: async () => ({ default_branch: 'main' }) };
      if (url.includes('/commits/main'))     return { ok: true,  status: 200, json: async () => ({ sha: 'b'.repeat(40) }) };
      return null;
    });
    const r = await Importer.resolveRef({ owner: 'x', repo: 'y', ref: null });
    expect(r.sha).toBe('b'.repeat(40));
    expect(r.ref).toBe('main');
  });

  it('uses release tag_name when /releases/latest succeeds', async () => {
    mockFetch((url) => {
      if (url.includes('/releases/latest')) return { ok: true, status: 200, json: async () => ({ tag_name: 'v9.9.9' }) };
      if (url.includes('/commits/v9.9.9'))  return { ok: true, status: 200, json: async () => ({ sha: 'c'.repeat(40) }) };
      return null;
    });
    const r = await Importer.resolveRef({ owner: 'x', repo: 'y', ref: null });
    expect(r.sha).toBe('c'.repeat(40));
    expect(r.ref).toBe('v9.9.9');
    expect(r.kind).toBe('tag');
  });

  it('throws a clean error when ref resolves to 404', async () => {
    mockFetch((url) => {
      if (url.includes('/commits/nonexistent')) return { ok: false, status: 404, json: async () => ({}) };
      return null;
    });
    await expect(Importer.resolveRef({ owner: 'x', repo: 'y', ref: 'nonexistent' })).rejects.toThrow(/could not resolve ref/);
  });
});
