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
  streamlit:  { pyDeps: ['streamlit'] },
  gradio:     { pyDeps: ['gradio'] },
  hugo:       { files: ['hugo.toml', 'hugo.yaml', 'config.toml'] },
  jekyll:     { files: ['_config.yml', 'Gemfile'] },
};

function detectFramework({ pkg, pyproject, requirementsTxt, topLevel }) {
  const npmDeps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  for (const [fw, hint] of Object.entries(FRAMEWORK_HINTS)) {
    if (hint.deps?.some(d => d in npmDeps)) return fw;
    if (hint.pyDeps) {
      const t = (requirementsTxt || '').toLowerCase();
      const ppt = (pyproject || '').toLowerCase();
      if (hint.pyDeps.some(d => t.includes(d) || ppt.includes(d))) return fw;
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

function defaultStartArgv(framework, runtimeKind, pkg) {
  switch (framework) {
    case 'vite':
      return ['npm', 'run', 'dev', '--', '--port', '{{PORT}}', '--host', '127.0.0.1'];
    case 'nextjs':
      return ['npm', 'run', 'dev', '--', '--port', '{{PORT}}', '--hostname', '127.0.0.1'];
    case 'sveltekit':
      return ['npm', 'run', 'dev', '--', '--port', '{{PORT}}', '--host', '127.0.0.1'];
    case 'astro':
      return ['npm', 'run', 'dev', '--', '--port', '{{PORT}}', '--host', '127.0.0.1'];
    case 'streamlit':
      return [
        'streamlit', 'run', 'app.py',
        '--server.port={{PORT}}', '--server.address=127.0.0.1',
        '--server.enableCORS=false', '--server.enableXsrfProtection=false',
        '--server.headless=true', '--browser.gatherUsageStats=false',
      ];
    case 'gradio':
      return ['python', 'app.py'];
    case 'hugo':
      return ['hugo', 'serve', '--port', '{{PORT}}', '--bind', '127.0.0.1'];
    case 'jekyll':
      return ['bundle', 'exec', 'jekyll', 'serve', '--port', '{{PORT}}', '--host', '127.0.0.1'];
    default:
      if (runtimeKind === 'static') return ['os8:static', '--dir', '.'];
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

  const [pkgRaw, pyprojectRaw, requirementsRaw] = await Promise.all([
    Importer.fetchRawFile({ ...parsed, sha: refResolution.sha, path: 'package.json' }),
    Importer.fetchRawFile({ ...parsed, sha: refResolution.sha, path: 'pyproject.toml' }),
    Importer.fetchRawFile({ ...parsed, sha: refResolution.sha, path: 'requirements.txt' }),
  ]);
  let pkg = null;
  try { pkg = pkgRaw ? JSON.parse(pkgRaw) : null; }
  catch (_) { /* malformed package.json — treat as missing for detection */ }

  const runtime = detectRuntime({ pkg, pyproject: pyprojectRaw, requirementsTxt: requirementsRaw, topLevel });
  const framework = detectFramework({ pkg, pyproject: pyprojectRaw, requirementsTxt: requirementsRaw, topLevel });
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
    upstream: { git: meta.clone_url, ref: refResolution.ref },
    framework,
    runtime: {
      kind: runtime.kind,
      version: runtime.version,
      arch: ['arm64', 'x86_64'],
      package_manager: pm,
      dependency_strategy: 'best-effort',
    },
    install: runtime.kind === 'node'
      ? [{ argv: ['npm', 'install', '--ignore-scripts'] }]
      : [],
    start: {
      argv: defaultStartArgv(framework, runtime.kind, pkg),
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
    },
  };
}

module.exports = {
  draft,
  detectFramework,
  detectRuntime,
  detectPackageManager,
  defaultStartArgv,
  buildSlug,
};
