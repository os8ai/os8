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

  // Regression for streamlit/30days: requirements.txt doesn't list streamlit
  // (Streamlit Cloud injects it). Drafter must still detect framework=streamlit
  // via streamlit_app.py file presence and synthesize a venv-aware install
  // command for streamlit itself.
  it('detects streamlit via streamlit_app.py filename even without dep match', () => {
    Drafter = require('../src/services/dev-import-drafter');
    const fw = Drafter.detectFramework({
      pkg: null,
      pyproject: null,
      requirementsTxt: 'pandas\nclick==8.0\n',
      topLevel: ['streamlit_app.py', 'requirements.txt'],
    });
    expect(fw).toBe('streamlit');
  });

  it('streamlit start.argv picks streamlit_app.py when present', () => {
    Drafter = require('../src/services/dev-import-drafter');
    const argv = Drafter.defaultStartArgv('streamlit', 'python', null,
      ['streamlit_app.py', 'requirements.txt']);
    expect(argv[0]).toBe('streamlit');
    expect(argv[1]).toBe('run');
    expect(argv[2]).toBe('streamlit_app.py');
  });

  it('streamlit start.argv falls back to app.py when streamlit_app.py absent', () => {
    Drafter = require('../src/services/dev-import-drafter');
    const argv = Drafter.defaultStartArgv('streamlit', 'python', null,
      ['app.py', 'requirements.txt']);
    expect(argv[2]).toBe('app.py');
  });

  it('python+none does NOT fall through to npm fallback', () => {
    Drafter = require('../src/services/dev-import-drafter');
    const argv = Drafter.defaultStartArgv('none', 'python', null, ['main.py']);
    expect(argv[0]).toBe('python');
    expect(argv[1]).toBe('main.py');
  });

  it('install argv synthesises uv pip install streamlit when not in requirements.txt', () => {
    Drafter = require('../src/services/dev-import-drafter');
    const cmds = Drafter.defaultInstallArgv('streamlit', 'python', 'pandas\nclick==8.0\n');
    expect(cmds).toEqual([{ argv: ['uv', 'pip', 'install', 'streamlit'] }]);
  });

  it('install argv is empty when streamlit IS in requirements.txt (no double-install)', () => {
    Drafter = require('../src/services/dev-import-drafter');
    const cmds = Drafter.defaultInstallArgv('streamlit', 'python', 'streamlit==1.32\npandas\n');
    expect(cmds).toEqual([]);
  });

  it('install argv synthesises uv pip install gradio when not in requirements.txt', () => {
    Drafter = require('../src/services/dev-import-drafter');
    const cmds = Drafter.defaultInstallArgv('gradio', 'python', 'numpy\n');
    expect(cmds).toEqual([{ argv: ['uv', 'pip', 'install', 'gradio'] }]);
  });

  // Regression for Zeyi-Lin/HivisionIDPhotos: gradio is in requirements-app.txt,
  // not requirements.txt. Detection must scan the union of all
  // `requirements*.txt` files we fetched so framework=gradio is set,
  // and the install step must reference the file that actually pins
  // gradio (so its sibling deps like fastapi land in the venv too).
  it('detects gradio via requirements-app.txt when requirements.txt is silent', () => {
    Drafter = require('../src/services/dev-import-drafter');
    const fw = Drafter.detectFramework({
      pkg: null,
      pyproject: null,
      requirementsFiles: {
        'requirements.txt': 'opencv-python\nonnxruntime\n',
        'requirements-app.txt': 'gradio>=4.43.0\nfastapi\n',
      },
      topLevel: ['requirements.txt', 'requirements-app.txt', 'app.py'],
    });
    expect(fw).toBe('gradio');
  });

  it('install argv installs the secondary requirements file holding the framework dep', () => {
    Drafter = require('../src/services/dev-import-drafter');
    const cmds = Drafter.defaultInstallArgv('gradio', 'python', 'opencv-python\nonnxruntime\n', {
      'requirements.txt': 'opencv-python\nonnxruntime\n',
      'requirements-app.txt': 'gradio>=4.43.0\nfastapi\n',
      'requirements-dev.txt': 'pytest\n',
    });
    // requirements-dev.txt is filtered out (dev/test heuristic); the
    // app-overlay file is preferred over a bare `pip install gradio` so
    // sibling deps (fastapi here) land in the venv with the correct version
    // constraints.
    expect(cmds).toEqual([{ argv: ['uv', 'pip', 'install', '-r', 'requirements-app.txt'] }]);
  });

  it('install argv falls back to bare pip install when no sibling file holds the dep', () => {
    Drafter = require('../src/services/dev-import-drafter');
    const cmds = Drafter.defaultInstallArgv('gradio', 'python', 'numpy\n', {
      'requirements.txt': 'numpy\n',
      'requirements-dev.txt': 'pytest\n',
    });
    expect(cmds).toEqual([{ argv: ['uv', 'pip', 'install', 'gradio'] }]);
  });

  // Regression: if the entry script declares `--port` (and ideally `--host`)
  // via argparse — like HivisionIDPhotos's app.py — pass them so the server
  // binds to the OS8-allocated port. Without this the script's argparse
  // default (typically 7860) wins and the BrowserView 502s. Apps that
  // *don't* declare the flags get a bare `python app.py`; the python
  // adapter sets GRADIO_SERVER_PORT/GRADIO_SERVER_NAME defensively for
  // those.
  it('gradio start.argv adds --port + --host when entry source declares argparse flags', () => {
    Drafter = require('../src/services/dev-import-drafter');
    const argv = Drafter.defaultStartArgv('gradio', 'python', null, ['app.py'], {
      'app.py': `
        argparser.add_argument("--port", type=int, default=7860, help="The port number")
        argparser.add_argument("--host", type=str, default="127.0.0.1", help="The host")
        demo.launch(server_name=args.host, server_port=args.port)
      `,
    });
    expect(argv).toEqual(['python', 'app.py', '--port', '{{PORT}}', '--host', '127.0.0.1']);
  });

  it('gradio start.argv stays bare when entry source does not declare --port', () => {
    Drafter = require('../src/services/dev-import-drafter');
    const argv = Drafter.defaultStartArgv('gradio', 'python', null, ['app.py'], {
      'app.py': `import gradio as gr\ndemo = gr.Interface(...)\ndemo.launch()\n`,
    });
    expect(argv).toEqual(['python', 'app.py']);
  });

  // ─── Tier 2A: setup-script detection ──────────────────────────────────────
  it('detects root-level download_models.py as a setup-script candidate', () => {
    Drafter = require('../src/services/dev-import-drafter');
    const candidates = Drafter.detectSetupScripts({
      topLevel: ['download_models.py', 'requirements.txt'],
      scriptsDirEntries: [],
      sourceFor: (p) => p === 'download_models.py' ? '"""Fetch model weights to weights/."""\nimport requests\n' : null,
      makefileText: null,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].path).toBe('download_models.py');
    expect(candidates[0].argv).toEqual(['python', 'download_models.py']);
    expect(candidates[0].summary).toContain('Fetch model weights');
  });

  it('detects scripts/download_*.py via subdirectory listing', () => {
    Drafter = require('../src/services/dev-import-drafter');
    const candidates = Drafter.detectSetupScripts({
      topLevel: ['scripts', 'requirements.txt'],
      scriptsDirEntries: [
        { name: 'download_model.py', type: 'blob' },
        { name: 'build_pypi.py', type: 'blob' },         // not a setup script
        { name: '__pycache__',     type: 'tree' },        // dir, ignored
      ],
      sourceFor: (p) => p === 'scripts/download_model.py' ? '# Download ONNX weights for matting\nimport os\n' : null,
      makefileText: null,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].path).toBe('scripts/download_model.py');
    expect(candidates[0].argv).toEqual(['python', 'scripts/download_model.py']);
    expect(candidates[0].summary).toContain('Download ONNX weights');
  });

  it('detects scripts/setup_*.sh as a shell candidate (bash invocation)', () => {
    Drafter = require('../src/services/dev-import-drafter');
    const candidates = Drafter.detectSetupScripts({
      topLevel: ['scripts'],
      scriptsDirEntries: [{ name: 'setup_env.sh', type: 'blob' }],
      sourceFor: () => '#!/bin/bash\n# Initialise environment + fetch fixtures\n',
      makefileText: null,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe('shell');
    expect(candidates[0].argv).toEqual(['bash', 'scripts/setup_env.sh']);
  });

  it('detects Makefile targets matching download/setup/init/prepare/fetch', () => {
    Drafter = require('../src/services/dev-import-drafter');
    const makefile = `
.PHONY: build clean download setup test

build:
\tcc -o foo foo.c

download:
\tcurl -O https://example.com/weights.bin

setup: download
\t./bootstrap.sh

test:
\tpytest

clean:
\trm -rf build/
`;
    const candidates = Drafter.detectSetupScripts({
      topLevel: ['Makefile'],
      scriptsDirEntries: [],
      sourceFor: () => null,
      makefileText: makefile,
    });
    expect(candidates).toHaveLength(2);
    expect(candidates.map(c => c.path)).toEqual(['Makefile:download', 'Makefile:setup']);
    expect(candidates[0].argv).toEqual(['make', 'download']);
  });

  it('caps the candidate list at 3 to keep the modal scannable', () => {
    Drafter = require('../src/services/dev-import-drafter');
    const candidates = Drafter.detectSetupScripts({
      topLevel: ['download_models.py', 'download_weights.py', 'fetch_models.py', 'setup_models.py', 'prepare_models.py'],
      scriptsDirEntries: [],
      sourceFor: () => '',
      makefileText: null,
    });
    expect(candidates).toHaveLength(3);
  });

  it('ignores Django manage.py / setuptools setup.py at root (false-positive guard)', () => {
    Drafter = require('../src/services/dev-import-drafter');
    const candidates = Drafter.detectSetupScripts({
      topLevel: ['manage.py', 'setup.py', 'requirements.txt'],
      scriptsDirEntries: [],
      sourceFor: () => '',
      makefileText: null,
    });
    expect(candidates).toEqual([]);
  });

  it('parseMakefileTargets skips .PHONY, comments, indented lines, and macro defs', () => {
    Drafter = require('../src/services/dev-import-drafter');
    const makefile = `
# Comment line
.PHONY: build clean

VAR := value           # not a target
build: deps
\trecipe-line
clean :
\tcleanup-recipe
target_with_underscore:
\trun
`;
    const targets = Drafter.parseMakefileTargets(makefile);
    expect(targets).toContain('build');
    expect(targets).toContain('clean');
    expect(targets).toContain('target_with_underscore');
    expect(targets).not.toContain('.PHONY');
    expect(targets).not.toContain('recipe-line');
    expect(targets).not.toContain('VAR');
  });

  it('summariseScript extracts python triple-quoted docstring', () => {
    Drafter = require('../src/services/dev-import-drafter');
    const src = `"""Download ONNX matting weights for HivisionIDPhotos.

Drops weights into hivision/creator/weights/.
"""
import os
`;
    const s = Drafter.summariseScript(src, 'python');
    expect(s).toContain('Download ONNX matting weights');
  });

  it('summariseScript falls back to top-of-file # comment block', () => {
    Drafter = require('../src/services/dev-import-drafter');
    const src = `#!/bin/bash
# Fetch model weights into ./weights
# Used by ComfyUI's first-run flow

set -e
`;
    const s = Drafter.summariseScript(src, 'shell');
    expect(s).toContain('Fetch model weights');
  });

  it('end-to-end: HivisionIDPhotos-shaped repo surfaces scripts/download_model.py in importMeta.setupScripts', async () => {
    installFakeImporter({
      parseGithubUrl: () => ({ owner: 'Zeyi-Lin', repo: 'HivisionIDPhotos', ref: null }),
      getRepoMeta: async () => ({
        clone_url: 'https://github.com/Zeyi-Lin/HivisionIDPhotos.git',
        default_branch: 'master',
        license: { spdx_id: 'Apache-2.0' },
        description: 'AI ID photos',
      }),
      resolveRef: async () => ({ ref: 'v1.3.1', sha: STAR_SHA, kind: 'tag' }),
      listTopLevel: async () => [
        'app.py', 'requirements.txt', 'requirements-app.txt', 'scripts',
      ],
      listSubdir: async ({ dir }) => dir === 'scripts' ? [
        { name: 'download_model.py', type: 'blob' },
        { name: 'build_pypi.py',     type: 'blob' },
      ] : [],
      fetchRawFile: async ({ path }) => {
        if (path === 'requirements.txt') return 'opencv-python\nonnxruntime\n';
        if (path === 'requirements-app.txt') return 'gradio>=4.43.0\n';
        if (path === 'app.py') return `argparser.add_argument("--port", type=int, default=7860)\nargparser.add_argument("--host", type=str, default="127.0.0.1")\n`;
        if (path === 'scripts/download_model.py') return '# Download ONNX matting weights into hivision/creator/weights/\nimport requests\n';
        return null;
      },
    });
    Drafter = require('../src/services/dev-import-drafter');
    const r = await Drafter.draft('https://github.com/Zeyi-Lin/HivisionIDPhotos');
    expect(r.importMeta.setupScripts).toBeDefined();
    expect(r.importMeta.setupScripts).toHaveLength(1);
    expect(r.importMeta.setupScripts[0].path).toBe('scripts/download_model.py');
    expect(r.importMeta.setupScripts[0].argv).toEqual(['python', 'scripts/download_model.py']);
    expect(r.importMeta.setupScripts[0].summary).toContain('Download ONNX matting weights');
  });

  it('end-to-end: HivisionIDPhotos-shaped repo produces gradio framework + secondary-file install + --port flags', async () => {
    installFakeImporter({
      parseGithubUrl: () => ({ owner: 'Zeyi-Lin', repo: 'HivisionIDPhotos', ref: null }),
      getRepoMeta: async () => ({
        clone_url: 'https://github.com/Zeyi-Lin/HivisionIDPhotos.git',
        default_branch: 'master',
        license: { spdx_id: 'Apache-2.0' },
        description: 'AI ID photos',
      }),
      resolveRef: async () => ({ ref: 'v1.3.1', sha: STAR_SHA, kind: 'tag' }),
      listTopLevel: async () => [
        'app.py', 'inference.py', 'requirements.txt',
        'requirements-app.txt', 'requirements-dev.txt', 'README.md',
      ],
      fetchRawFile: async ({ path }) => {
        if (path === 'requirements.txt') return 'opencv-python>=4.8.1.78\nonnxruntime>=1.15.0\nnumpy<=1.26.4\n';
        if (path === 'requirements-app.txt') return 'gradio>=4.43.0\nfastapi\n';
        if (path === 'requirements-dev.txt') return 'pytest\n';
        if (path === 'app.py') return `
          argparser = argparse.ArgumentParser()
          argparser.add_argument("--port", type=int, default=7860)
          argparser.add_argument("--host", type=str, default="127.0.0.1")
          demo.launch(server_name=args.host, server_port=args.port)
        `;
        return null;
      },
    });
    Drafter = require('../src/services/dev-import-drafter');
    const r = await Drafter.draft('https://github.com/Zeyi-Lin/HivisionIDPhotos');
    expect(r.manifest.framework).toBe('gradio');
    expect(r.manifest.runtime.kind).toBe('python');
    expect(r.manifest.install).toEqual([
      { argv: ['uv', 'pip', 'install', '-r', 'requirements-app.txt'] },
    ]);
    expect(r.manifest.start.argv).toEqual([
      'python', 'app.py', '--port', '{{PORT}}', '--host', '127.0.0.1',
    ]);
  });

  // Regression: when resolveRef fell back to a branch name like `master`
  // (no input ref + no releases), the drafter wrote `upstream.ref: master`
  // which fails the v1 schema (requires SHA or vX.Y.Z). Branch refs are
  // mutable too — pinning to SHA is correct on both counts.
  it('upstream.ref is pinned to SHA when resolveRef returned a branch name', async () => {
    installFakeImporter({
      parseGithubUrl: () => ({ owner: 'streamlit', repo: '30days', ref: null }),
      resolveRef: async () => ({ ref: 'master', sha: 'a'.repeat(40), kind: 'branch' }),
      getRepoMeta: async () => ({
        clone_url: 'https://github.com/streamlit/30days.git',
        description: 'demo', license: { spdx_id: 'Apache-2.0' },
      }),
      listTopLevel: async () => ['streamlit_app.py', 'requirements.txt'],
      fetchRawFile: async ({ path }) => path === 'requirements.txt' ? 'pandas\nclick==8.0\n' : null,
    });
    Drafter = require('../src/services/dev-import-drafter');
    const result = await Drafter.draft('https://github.com/streamlit/30days');
    // Branch name 'master' must NOT leak into upstream.ref; SHA wins.
    expect(result.manifest.upstream.ref).toBe('a'.repeat(40));
    expect(result.upstreamResolvedCommit).toBe('a'.repeat(40));
  });

  it('upstream.ref preserves a semver tag when resolveRef returned one', async () => {
    installFakeImporter({
      parseGithubUrl: () => ({ owner: 'streamlit', repo: 'streamlit-app', ref: null }),
      resolveRef: async () => ({ ref: 'v1.2.3', sha: 'b'.repeat(40), kind: 'tag' }),
      getRepoMeta: async () => ({
        clone_url: 'https://github.com/streamlit/streamlit-app.git',
        description: 'demo', license: { spdx_id: 'Apache-2.0' },
      }),
      listTopLevel: async () => ['streamlit_app.py', 'requirements.txt'],
      fetchRawFile: async ({ path }) => path === 'requirements.txt' ? 'streamlit\n' : null,
    });
    Drafter = require('../src/services/dev-import-drafter');
    const result = await Drafter.draft('https://github.com/streamlit/streamlit-app');
    // Semver tag is acceptable per schema and more human-readable than a SHA.
    expect(result.manifest.upstream.ref).toBe('v1.2.3');
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
