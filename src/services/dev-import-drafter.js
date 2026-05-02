/**
 * Developer Import drafter (PR 3.1).
 *
 * Calls github-importer to fetch repo metadata + a few key files, then
 * produces a draft AppSpec object that the install-plan modal can present
 * to the user. The user reviews and (in PR 3.2) toggles capabilities and
 * acknowledges risks before approval.
 *
 * Detection is conservative:
 *   - permissions.network.outbound: false  (LLM review surfaces domains)
 *   - permissions.os8_capabilities: []     (user opts in per capability)
 *   - dependency_strategy: 'best-effort'   (verified-channel gate is bypassed
 *                                           per channel-tiered manifest-validator)
 *   - review.risk: 'high'                  (review pipeline may downgrade)
 */

const Importer = require('./github-importer');

const FRAMEWORK_HINTS = {
  vite:       { deps: ['vite'] },
  nextjs:     { deps: ['next'] },
  sveltekit:  { deps: ['@sveltejs/kit'] },
  astro:      { deps: ['astro'] },
  // Streamlit Cloud convention: `streamlit_app.py` at repo root. The dep
  // hint alone misses real-world apps whose requirements.txt omits
  // `streamlit` (e.g. streamlit/30days expects Cloud to inject it).
  streamlit:  { pyDeps: ['streamlit'], files: ['streamlit_app.py'] },
  gradio:     { pyDeps: ['gradio'] },
  hugo:       { files: ['hugo.toml', 'hugo.yaml', 'config.toml'] },
  jekyll:     { files: ['_config.yml', 'Gemfile'] },
};

function detectFramework({ pkg, pyproject, requirementsTxt, requirementsFiles, topLevel }) {
  const npmDeps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  // Apps like HivisionIDPhotos split deps across requirements.txt +
  // requirements-app.txt; detection scans the union of every
  // `requirements*.txt` we fetched (including dev/test files — those
  // sometimes pin the framework too).
  let pyText;
  if (requirementsFiles && Object.keys(requirementsFiles).length > 0) {
    pyText = Object.values(requirementsFiles).map(s => (s || '').toLowerCase()).join('\n');
  } else {
    pyText = (requirementsTxt || '').toLowerCase();
  }
  const ppt = (pyproject || '').toLowerCase();
  for (const [fw, hint] of Object.entries(FRAMEWORK_HINTS)) {
    if (hint.deps?.some(d => d in npmDeps)) return fw;
    if (hint.pyDeps) {
      if (hint.pyDeps.some(d => pyText.includes(d) || ppt.includes(d))) return fw;
    }
    if (hint.files?.some(f => topLevel.includes(f))) return fw;
  }
  return 'none';
}

function detectRuntime({ pkg, pyproject, requirementsTxt, topLevel }) {
  // Dockerfile-only repos: NOT supported in v1 Developer Import. The v2
  // schema (PR 2.5) requires image + image_digest + internal_port — fields
  // a Dockerfile alone doesn't provide. Building locally is out of scope
  // for v1 (would require `docker build` orchestration).
  if (topLevel.includes('Dockerfile') && !pkg && !pyproject && !requirementsTxt) {
    throw new Error(
      'Dockerfile-only repos are not supported in v1 Developer Import. ' +
      'Either install via the Community channel after a manifest is contributed, ' +
      'or ask the upstream to publish a pinned image to ghcr.io / Docker Hub.'
    );
  }
  if (pkg) {
    const node = pkg.engines?.node?.match(/(\d+)/)?.[1] || '20';
    return { kind: 'node', version: node, schemaVersion: 1 };
  }
  if (pyproject || requirementsTxt) {
    return { kind: 'python', version: '3.12', schemaVersion: 1 };
  }
  if (topLevel.some(f => /\.(html?|md)$/i.test(f))) {
    return { kind: 'static', version: '0', schemaVersion: 1 };
  }
  throw new Error('could not detect runtime — repo has no package.json, pyproject.toml, requirements.txt, or HTML files');
}

function detectPackageManager({ topLevel, runtimeKind }) {
  // Match the runtime adapter's lockfile precedence (PR 1.11 / 2.1).
  if (runtimeKind === 'node') {
    if (topLevel.includes('pnpm-lock.yaml')) return 'pnpm';
    if (topLevel.includes('yarn.lock'))      return 'yarn';
    if (topLevel.includes('bun.lockb') || topLevel.includes('bun.lock')) return 'bun';
    return 'npm';
  }
  if (runtimeKind === 'python') {
    if (topLevel.includes('uv.lock'))     return 'uv';
    if (topLevel.includes('poetry.lock')) return 'poetry';
    return 'pip';
  }
  return 'auto';
}

// AppSpec v1 schema accepts only `^[0-9a-f]{40}$` (SHA) or
// `^v\d+\.\d+\.\d+(-.+)?$` (semver tag) for upstream.ref. A branch name
// like `master` or `main` is mutable and rejected by the schema. When
// resolveRef fell back to a branch (no tag, no input ref), we'd otherwise
// generate an invalid manifest — pin to the resolved SHA instead, which
// gives the manifest immutability for free.
function pinnedRef(refResolution) {
  const SHA_RE = /^[0-9a-f]{40}$/;
  const TAG_RE = /^v\d+\.\d+\.\d+(-.+)?$/;
  const ref = refResolution.ref;
  if (typeof ref === 'string' && (SHA_RE.test(ref) || TAG_RE.test(ref))) {
    return ref;
  }
  return refResolution.sha;
}

function defaultInstallArgv(framework, runtimeKind, requirementsTxt, requirementsFiles) {
  if (runtimeKind === 'node') {
    return [{ argv: ['npm', 'install', '--ignore-scripts'] }];
  }
  if (runtimeKind === 'python') {
    // Detected-but-not-listed framework deps: many Streamlit/Gradio repos
    // expect their host (Streamlit Cloud / HF Spaces) to inject the framework,
    // so requirements.txt may omit it. We have three cases:
    //   1. Framework dep is in requirements.txt → base install handles it.
    //   2. Framework dep is in another `requirements-*.txt` (e.g.
    //      HivisionIDPhotos's requirements-app.txt) → install that file
    //      explicitly so we pick up its full set of deps (gradio + fastapi
    //      + …), not just `pip install gradio` alone.
    //   3. Not declared anywhere → synthesize a bare `uv pip install <fw>`.
    const baseReqs = (requirementsTxt || requirementsFiles?.['requirements.txt'] || '').toLowerCase();
    const cmds = [];
    const dep = framework === 'streamlit' ? 'streamlit'
              : framework === 'gradio'    ? 'gradio'
              : null;
    if (!dep) return cmds;
    if (baseReqs.includes(dep)) return cmds;

    // Look for the dep in a sibling requirements-*.txt; skip files that
    // smell like dev/test overlays which would pull noise into the venv.
    if (requirementsFiles) {
      for (const [name, content] of Object.entries(requirementsFiles)) {
        if (name === 'requirements.txt') continue;
        if (/-(dev|test|tests)\.txt$/i.test(name)) continue;
        if ((content || '').toLowerCase().includes(dep)) {
          cmds.push({ argv: ['uv', 'pip', 'install', '-r', name] });
          return cmds;
        }
      }
    }
    cmds.push({ argv: ['uv', 'pip', 'install', dep] });
    return cmds;
  }
  return [];
}

function defaultStartArgv(framework, runtimeKind, pkg, topLevel = [], appSources = {}) {
  switch (framework) {
    case 'vite':
      return ['npm', 'run', 'dev', '--', '--port', '{{PORT}}', '--host', '127.0.0.1'];
    case 'nextjs':
      return ['npm', 'run', 'dev', '--', '--port', '{{PORT}}', '--hostname', '127.0.0.1'];
    case 'sveltekit':
      return ['npm', 'run', 'dev', '--', '--port', '{{PORT}}', '--host', '127.0.0.1'];
    case 'astro':
      return ['npm', 'run', 'dev', '--', '--port', '{{PORT}}', '--host', '127.0.0.1'];
    case 'streamlit': {
      // Pick whichever entry file the repo actually has. Streamlit Cloud's
      // convention is `streamlit_app.py`; older / custom apps use `app.py`.
      const entry = ['streamlit_app.py', 'app.py', 'streamlit.py', 'main.py']
        .find(f => topLevel.includes(f)) || 'streamlit_app.py';
      return [
        'streamlit', 'run', entry,
        '--server.port={{PORT}}', '--server.address=127.0.0.1',
        '--server.enableCORS=false', '--server.enableXsrfProtection=false',
        '--server.headless=true', '--browser.gatherUsageStats=false',
      ];
    }
    case 'gradio': {
      const entry = ['app.py', 'main.py', 'demo.py'].find(f => topLevel.includes(f)) || 'app.py';
      // Two world conventions for binding the port in a Gradio app:
      //   (A) argparse with --port/--host flags piped into demo.launch(...)
      //       — common in CLI-aware repos like HivisionIDPhotos.
      //   (B) bare demo.launch() that reads GRADIO_SERVER_PORT/_NAME from
      //       env — common in HF Spaces-style demos.
      // We pick (A) when the entry source declares --port via argparse;
      // otherwise (B), which the python adapter handles defensively by
      // setting the env vars at start time. Adding --port to an app that
      // doesn't accept it would crash argparse with "unrecognized arguments",
      // so we only add the flags when we've seen them declared.
      const src = appSources[entry] || '';
      const hasPortFlag = /add_argument\(\s*['"]--port['"]/.test(src);
      const hasHostFlag = /add_argument\(\s*['"]--host['"]/.test(src);
      if (hasPortFlag) {
        const argv = ['python', entry, '--port', '{{PORT}}'];
        if (hasHostFlag) argv.push('--host', '127.0.0.1');
        return argv;
      }
      return ['python', entry];
    }
    case 'hugo':
      return ['hugo', 'serve', '--port', '{{PORT}}', '--bind', '127.0.0.1'];
    case 'jekyll':
      return ['bundle', 'exec', 'jekyll', 'serve', '--port', '{{PORT}}', '--host', '127.0.0.1'];
    default:
      if (runtimeKind === 'static') return ['os8:static', '--dir', '.'];
      if (runtimeKind === 'python') {
        // No recognized framework but it's a Python repo. Pick a likely entry
        // file rather than the npm fallback (which is just wrong for Python).
        const entry = ['main.py', 'app.py', '__main__.py'].find(f => topLevel.includes(f));
        if (entry) return ['python', entry];
        return ['python', '-c', "print('No entry file detected — edit start.argv in the manifest.')"];
      }
      // node + no recognized framework: prefer a real script the repo declares
      // over a guess. The user's review surfaces the actual argv before install.
      if (runtimeKind === 'node' && pkg?.scripts) {
        for (const candidate of ['dev', 'start', 'serve']) {
          if (pkg.scripts[candidate]) return ['npm', 'run', candidate];
        }
      }
      return ['npm', 'run', 'dev'];
  }
}

// ─── Setup-script detection (Tier 2A) ──────────────────────────────────────────
//
// Some apps require a one-time setup step before first launch — e.g.
// HivisionIDPhotos's `scripts/download_model.py` fetches ONNX weights into
// `hivision/creator/weights/`, ComfyUI's `scripts/download_models.py`,
// many HF Spaces clones, etc. The dev-import drafter can't know about
// these scripts in general, but a conservative heuristic catches the
// common cases: an explicit allowlist of filename patterns at the repo
// root and inside `scripts/`, plus Makefile targets matching
// download/setup/fetch.
//
// Output is consumed by the install-plan modal (importMeta.setupScripts),
// which renders one checkbox per candidate. Checked items become
// `manifest.postInstall` entries on approve. False positives are
// mitigated by opt-in: the user reviews each candidate (with source
// preview) before approving.
//
// Cap at 3 candidates to keep the modal scannable. We sort by likelihood
// (root > scripts/ > Makefile), but the cap is a heuristic — agents that
// genuinely need 5 setup scripts will surface the failure via Tier 3A's
// "missing model files" hint and the user can edit the manifest there.

const ROOT_PYTHON_PATTERNS = [
  // Specific allowlist — these names are highly likely to be setup
  // scripts in their domains. Anything more generic (e.g. `setup.py`)
  // is risky: setup.py at root is setuptools, not a setup script.
  'download_models.py',
  'download_weights.py',
  'download_ckpts.py',
  'fetch_models.py',
  'setup_models.py',
  'prepare_models.py',
];

const SCRIPTS_DIR_PATTERNS = [
  // Inside scripts/, names matching these regex match are candidates.
  /^download_.*\.py$/i,
  /^setup_.*\.py$/i,
  /^fetch_.*\.py$/i,
  /^download_model\.py$/i,
  /^download_models\.py$/i,
  /^download_weights\.py$/i,
  /^prepare_data\.py$/i,
  /^download_.*\.sh$/i,
  /^setup_.*\.sh$/i,
];

function isLikelySetupTarget(target) {
  return /^(download|setup|init|prepare|fetch)([_-]?\w*)?$/i.test(target)
      || /^(install_|fetch_|get_)?models?$/i.test(target);
}

// Best-effort Makefile target parser. Captures lines that look like
// `target:` or `target: deps` at column 0. Skips `.PHONY` lines,
// commented lines, and indented recipe content. Doesn't handle
// every GNU make corner case — only the common patterns we'd see
// in research repos.
function parseMakefileTargets(makefileText) {
  if (!makefileText) return [];
  const targets = [];
  for (const line of makefileText.split('\n')) {
    if (line.startsWith('\t') || line.startsWith(' ')) continue;
    if (line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:(?!=)/);
    if (m) {
      const name = m[1];
      if (name === '.PHONY' || name === 'PHONY') continue;
      if (!targets.includes(name)) targets.push(name);
    }
  }
  return targets;
}

// Heuristic: does this Python script have an argparse argument that is
// required and missing a default? Used to flag setup-script candidates
// that can't be safely auto-checked in the install-plan modal.
//
// Triggers on:
//   - add_argument(..., required=True, ...)
//   - add_argument(..., nargs='+', ...) without a default= (positional or
//     option-form — argparse treats nargs='+' / '*' without default as
//     required when there's no default and the user doesn't pass any)
//
// Conservative: false-negative is fine (user gets a foot-gun on Install).
// False-positive is also fine (user just re-checks the box explicitly).
// Doesn't try to parse Python source; regex against `add_argument(...)`
// call expressions is good enough for the common cases.
function pythonScriptRequiresArgs(content) {
  if (!content || typeof content !== 'string') return false;
  // Match each add_argument(...) call across reasonable line spans.
  // Capture body up to the matching ')' is awkward in regex; settle for
  // capturing up to the next 100 chars after `add_argument(`.
  const calls = content.match(/add_argument\([\s\S]{0,300}?\)/g) || [];
  for (const call of calls) {
    if (/required\s*=\s*True\b/.test(call)) return true;
    // nargs='+' or nargs='*' — treated as required when no default is
    // supplied AND the argument has a `--`-style name (positionals would
    // also count, but argparse's required positionals are universal).
    if (/nargs\s*=\s*['"]\+['"]/.test(call) && !/default\s*=/.test(call)) return true;
  }
  return false;
}

// First-pass summary: grab a docstring or top-of-file comment so the
// modal can render a one-liner without making the user expand source.
function summariseScript(content, kind = 'python') {
  if (!content) return '';
  // Python docstring at top of module: `"""..."""` or `'''...'''`
  const docstring = content.match(/^\s*(?:#[^\n]*\n\s*)*("""([^]*?)"""|'''([^]*?)''')/);
  if (docstring) {
    const body = (docstring[2] || docstring[3] || '').trim();
    return body.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 2).join(' ').slice(0, 200);
  }
  // Comment block at top of file: `# ...` (python/shell) or `// ...` (rare here)
  const commentLines = [];
  for (const line of content.split('\n').slice(0, 20)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#!')) continue; // shebang
    if (trimmed.startsWith('#')) {
      commentLines.push(trimmed.replace(/^#+\s*/, ''));
      continue;
    }
    if (trimmed === '' && commentLines.length === 0) continue;
    if (trimmed === '' && commentLines.length > 0) break;
    if (commentLines.length > 0) break;
    if (kind === 'python' && (trimmed.startsWith('import ') || trimmed.startsWith('from '))) break;
  }
  return commentLines.filter(Boolean).slice(0, 2).join(' ').slice(0, 200);
}

// Returns array of { path, kind, argv, summary, source }, capped at 3.
// Caller fetches source files separately (e.g. inside draft()).
function detectSetupScripts({ topLevel, scriptsDirEntries, sourceFor, makefileText }) {
  const candidates = [];

  // (1) Root-level python files matching the allowlist.
  for (const name of ROOT_PYTHON_PATTERNS) {
    if (topLevel.includes(name)) {
      const src = sourceFor(name) || '';
      candidates.push({
        path: name,
        kind: 'python',
        argv: ['python', name],
        summary: summariseScript(src, 'python'),
        source: src.slice(0, 1000),
        requiresArgs: pythonScriptRequiresArgs(src),
      });
    }
  }

  // (2) scripts/ subdirectory python or shell scripts.
  for (const entry of (scriptsDirEntries || [])) {
    if (entry.type !== 'blob') continue;
    const matches = SCRIPTS_DIR_PATTERNS.some(re => re.test(entry.name));
    if (!matches) continue;
    const rel = `scripts/${entry.name}`;
    const isShell = entry.name.endsWith('.sh');
    const src = sourceFor(rel) || '';
    candidates.push({
      path: rel,
      kind: isShell ? 'shell' : 'python',
      argv: isShell ? ['bash', rel] : ['python', rel],
      summary: summariseScript(src, isShell ? 'shell' : 'python'),
      source: src.slice(0, 1000),
      // Shell scripts: we can't reliably detect required args without a
      // real parser. Flag them as requiresArgs=true conservatively so
      // they default unchecked and the user explicitly opts in.
      requiresArgs: isShell ? true : pythonScriptRequiresArgs(src),
    });
  }

  // (3) Makefile targets matching download/setup/init/prepare/fetch/models.
  if (topLevel.includes('Makefile') && makefileText) {
    const targets = parseMakefileTargets(makefileText);
    for (const t of targets) {
      if (!isLikelySetupTarget(t)) continue;
      candidates.push({
        path: `Makefile:${t}`,
        kind: 'make',
        argv: ['make', t],
        summary: `Runs the \`make ${t}\` target`,
        source: '',
        requiresArgs: false,  // make targets are self-contained by construction
      });
    }
  }

  return candidates.slice(0, 3);
}

function buildSlug(owner, repo) {
  return `${owner.toLowerCase()}-${repo.toLowerCase()}`
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/--+/g, '-')
    .slice(0, 40)
    .replace(/-+$/, '');
}

async function draft(url) {
  const parsed = Importer.parseGithubUrl(url);
  const meta = await Importer.getRepoMeta(parsed);
  const refResolution = await Importer.resolveRef({ ...parsed, ref: parsed.ref });
  const topLevel = await Importer.listTopLevel({ ...parsed, sha: refResolution.sha });

  const fetch = (path) => Importer.fetchRawFile({ ...parsed, sha: refResolution.sha, path });

  // Discover sibling requirements-*.txt files (HivisionIDPhotos splits
  // gradio/fastapi out into requirements-app.txt) and likely Python entry
  // sources (so the gradio default-argv check can see argparse flags).
  const secondaryReqNames = topLevel.filter(
    f => /^requirements.*\.txt$/i.test(f) && f !== 'requirements.txt'
  );
  const entryNames = ['app.py', 'main.py', 'demo.py'].filter(f => topLevel.includes(f));

  // Setup-script detection (Tier 2A): root-level allowlist + scripts/
  // subdir + Makefile targets. We fetch the actual source so the modal
  // can show a one-line summary and a "Preview source" expansion.
  const rootSetupNames = ROOT_PYTHON_PATTERNS.filter(f => topLevel.includes(f));
  const hasMakefile = topLevel.includes('Makefile');
  const hasScriptsDir = topLevel.includes('scripts');
  const scriptsDirEntries = hasScriptsDir
    ? await Importer.listSubdir({ ...parsed, sha: refResolution.sha, dir: 'scripts' })
    : [];
  const scriptsCandidatePaths = scriptsDirEntries
    .filter(e => e.type === 'blob' && SCRIPTS_DIR_PATTERNS.some(re => re.test(e.name)))
    .map(e => `scripts/${e.name}`);

  const [pkgRaw, pyprojectRaw, requirementsRaw, ...rest] = await Promise.all([
    fetch('package.json'),
    fetch('pyproject.toml'),
    fetch('requirements.txt'),
    ...secondaryReqNames.map(fetch),
    ...entryNames.map(fetch),
    ...rootSetupNames.map(fetch),
    ...scriptsCandidatePaths.map(fetch),
    hasMakefile ? fetch('Makefile') : Promise.resolve(null),
  ]);

  const requirementsFiles = {};
  if (requirementsRaw) requirementsFiles['requirements.txt'] = requirementsRaw;
  secondaryReqNames.forEach((name, i) => {
    if (rest[i]) requirementsFiles[name] = rest[i];
  });
  const appSources = {};
  entryNames.forEach((name, i) => {
    const content = rest[secondaryReqNames.length + i];
    if (content) appSources[name] = content;
  });
  // Build a sourceFor() lookup for setup-script detection — covers both
  // root-level and scripts/ paths fetched above.
  const setupSources = {};
  const setupBase = secondaryReqNames.length + entryNames.length;
  rootSetupNames.forEach((name, i) => {
    const content = rest[setupBase + i];
    if (content) setupSources[name] = content;
  });
  scriptsCandidatePaths.forEach((relPath, i) => {
    const content = rest[setupBase + rootSetupNames.length + i];
    if (content) setupSources[relPath] = content;
  });
  const makefileText = hasMakefile
    ? rest[setupBase + rootSetupNames.length + scriptsCandidatePaths.length]
    : null;

  let pkg = null;
  try { pkg = pkgRaw ? JSON.parse(pkgRaw) : null; }
  catch (_) { /* malformed package.json — treat as missing for detection */ }

  const runtime = detectRuntime({ pkg, pyproject: pyprojectRaw, requirementsTxt: requirementsRaw, topLevel });
  const framework = detectFramework({ pkg, pyproject: pyprojectRaw, requirementsTxt: requirementsRaw, requirementsFiles, topLevel });
  const pm = detectPackageManager({ topLevel, runtimeKind: runtime.kind });

  const slug = buildSlug(parsed.owner, parsed.repo);
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(slug)) {
    throw new Error(
      `derived slug "${slug}" doesn't satisfy AppSpec slug regex; pick a different repo or rename`
    );
  }

  const manifest = {
    schemaVersion: runtime.schemaVersion,
    slug,
    name: pkg?.name || parsed.repo,
    publisher: parsed.owner,
    description: pkg?.description || meta.description || `Imported from ${parsed.owner}/${parsed.repo}`,
    upstream: { git: meta.clone_url, ref: pinnedRef(refResolution) },
    framework,
    runtime: {
      kind: runtime.kind,
      version: runtime.version,
      arch: ['arm64', 'x86_64'],
      package_manager: pm,
      dependency_strategy: 'best-effort',
    },
    install: defaultInstallArgv(framework, runtime.kind, requirementsRaw, requirementsFiles),
    start: {
      argv: defaultStartArgv(framework, runtime.kind, pkg, topLevel, appSources),
      port: 'detect',
      readiness: { type: 'http', path: '/', timeout_seconds: 60 },
    },
    surface: { kind: 'web', preview_name: pkg?.name || parsed.repo },
    permissions: {
      network: { outbound: false, inbound: false },
      filesystem: 'app-private',
      os8_capabilities: [],
      secrets: [],
    },
    legal: {
      license: meta.license?.spdx_id || 'UNKNOWN',
      commercial_use: 'restricted',
      notes: 'Auto-generated from upstream LICENSE; review before commercial use.',
    },
    review: {
      channel: 'developer-import',
      reviewed_at: new Date().toISOString().slice(0, 10),
      reviewer: 'self',
      risk: 'high',
    },
  };

  // Detect setup scripts AFTER all fetches so we can pass real source
  // through to summariseScript without another round-trip.
  const setupScripts = detectSetupScripts({
    topLevel,
    scriptsDirEntries,
    sourceFor: (p) => setupSources[p],
    makefileText,
  });

  return {
    manifest,
    upstreamResolvedCommit: refResolution.sha,
    importMeta: {
      owner: parsed.owner,
      repo: parsed.repo,
      refKind: refResolution.kind,
      refLabel: refResolution.ref,
      stars: meta.stargazers_count,
      defaultBranch: meta.default_branch,
      hasDockerfile: topLevel.includes('Dockerfile'),
      // Tier 2A: opt-in setup script candidates — modal renders one
      // checkbox per entry; checked items become postInstall on approve.
      setupScripts,
    },
  };
}

module.exports = {
  draft,
  detectFramework,
  detectRuntime,
  detectPackageManager,
  defaultStartArgv,
  defaultInstallArgv,
  buildSlug,
  // Tier 2A
  detectSetupScripts,
  parseMakefileTargets,
  summariseScript,
  pythonScriptRequiresArgs,
};
