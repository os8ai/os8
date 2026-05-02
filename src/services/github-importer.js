/**
 * GitHub repo metadata fetcher used by Developer Import (PR 3.1).
 *
 * Calls the public GitHub REST API. Anonymous access gets 60 requests/hour
 * per IP; setting `GITHUB_TOKEN` (read-only is enough) raises this to 5000.
 * Each draft touches ~5 endpoints so the anonymous quota is comfortable
 * for normal use; we surface a clear "rate-limited" error on 403.
 *
 * All calls are best-effort with aggressive timeouts so a hung GitHub
 * doesn't stall the install plan modal.
 */

const GITHUB_API_BASE = 'https://api.github.com';
const ACCEPT_RAW = 'application/vnd.github.raw+json';
const ACCEPT_JSON = 'application/vnd.github+json';

function ghHeaders(extra = {}) {
  const h = {
    'Accept': ACCEPT_JSON,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'OS8-DevImport/1.0',
    ...extra,
  };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

function rateLimitMessage(status) {
  if (status === 403 || status === 429) {
    return 'GitHub rate-limited this request. Set GITHUB_TOKEN (read-only is fine) for headroom (5000 req/hr vs. anonymous 60/hr).';
  }
  return null;
}

function parseGithubUrl(url) {
  // Accept:
  //   https://github.com/<owner>/<repo>
  //   https://github.com/<owner>/<repo>.git
  //   https://github.com/<owner>/<repo>/tree/<ref>
  // Reject: gists, gitlab, ssh URLs, raw paths.
  const m = String(url || '').trim().match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+(?:\/[^/]+)*))?\/?$/
  );
  if (!m) {
    throw new Error(`unsupported URL: ${url || '(empty)'} — only https://github.com/<owner>/<repo> works`);
  }
  return { owner: m[1], repo: m[2], ref: m[3] || null };
}

async function ghFetch(url, opts = {}) {
  const r = await fetch(url, { headers: ghHeaders(), signal: AbortSignal.timeout(15_000), ...opts });
  if (r.status === 404) {
    const e = new Error(`not found: ${url}`);
    e.status = 404;
    throw e;
  }
  if (!r.ok) {
    const rate = rateLimitMessage(r.status);
    const e = new Error(rate || `github returned ${r.status} for ${url}`);
    e.status = r.status;
    throw e;
  }
  return r;
}

async function getRepoMeta({ owner, repo }) {
  try {
    const r = await ghFetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}`);
    return r.json();
  } catch (e) {
    if (e.status === 404) throw new Error(`repo not found: ${owner}/${repo} (private or doesn't exist)`);
    throw e;
  }
}

/**
 * Resolve a ref to an immutable 40-char commit SHA.
 *
 * Strategy:
 *   1. If ref is already a 40-char SHA → return as-is.
 *   2. If no ref → use `releases/latest` tag_name when present, else the
 *      default branch.
 *   3. Resolve via `/repos/:owner/:repo/commits/:ref` — this endpoint
 *      auto-dereferences both lightweight AND annotated tags, returning
 *      the commit they point to.
 *
 * Why /commits and not /git/refs/tags/{ref}: `/git/refs/tags/{tag}` returns
 * the *tag object*'s SHA for annotated tags, NOT the commit SHA — feeding
 * that SHA into `/git/trees/{sha}` then 422s. The verified catalog's
 * `resolve-refs.js` learned this against `koala73/worldmonitor v2.5.23`
 * (an annotated tag); we use the same fix.
 */
async function resolveRef({ owner, repo, ref }) {
  if (ref && /^[0-9a-f]{40}$/.test(ref)) {
    return { ref, sha: ref, kind: 'sha' };
  }

  let resolvedRef = ref;
  let kindHint = null;

  if (!resolvedRef) {
    try {
      const r = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/releases/latest`, {
        headers: ghHeaders(),
        signal: AbortSignal.timeout(10_000),
      });
      if (r.ok) {
        const j = await r.json();
        if (j?.tag_name) {
          resolvedRef = j.tag_name;
          kindHint = 'tag';
        }
      }
    } catch (_) { /* fall through to default branch */ }
  }

  if (!resolvedRef) {
    const meta = await getRepoMeta({ owner, repo });
    resolvedRef = meta.default_branch;
    kindHint = 'branch';
  }

  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/commits/${encodeURIComponent(resolvedRef)}`;
  const r = await fetch(url, {
    headers: ghHeaders(),
    signal: AbortSignal.timeout(10_000),
  });
  if (r.status === 404 || r.status === 422) {
    throw new Error(`could not resolve ref '${resolvedRef}' to a commit in ${owner}/${repo} (status ${r.status})`);
  }
  if (!r.ok) {
    const rate = rateLimitMessage(r.status);
    throw new Error(rate || `github returned ${r.status} resolving ref '${resolvedRef}'`);
  }
  const j = await r.json();
  const sha = j?.sha;
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`unexpected commit response for '${resolvedRef}': missing 40-char SHA`);
  }
  return { ref: resolvedRef, sha, kind: kindHint || 'ref' };
}

async function fetchRawFile({ owner, repo, sha, path }) {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${sha}`;
  const r = await fetch(url, {
    headers: ghHeaders({ 'Accept': ACCEPT_RAW }),
    signal: AbortSignal.timeout(10_000),
  });
  if (r.status === 404) return null;       // file not present — caller decides
  if (!r.ok) {
    const rate = rateLimitMessage(r.status);
    throw new Error(rate || `github raw fetch ${path}: ${r.status}`);
  }
  return r.text();
}

/**
 * List the top-level entries of a repo at a given commit. Useful for
 * detecting Dockerfile / config.toml / _config.yml without fetching them.
 * Returns an array of paths (top-level only — no recursion).
 */
async function listTopLevel({ owner, repo, sha }) {
  const r = await ghFetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/git/trees/${sha}`);
  const j = await r.json();
  return Array.isArray(j.tree) ? j.tree.map(t => t.path) : [];
}

/**
 * List entries of a single subdirectory at a commit. Used by the drafter's
 * setup-script detection (Tier 2A) to look for `scripts/download_*.py`,
 * `scripts/setup_*.sh`, etc. without recursing.
 *
 * Returns array of `{ name, type }` (type ∈ 'blob' | 'tree'). Returns `[]`
 * if the directory is missing rather than throwing — callers shouldn't
 * have to special-case "no scripts/ dir".
 */
async function listSubdir({ owner, repo, sha, dir }) {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${encodeURIComponent(dir)}?ref=${sha}`;
  const r = await fetch(url, {
    headers: ghHeaders(),
    signal: AbortSignal.timeout(10_000),
  });
  if (r.status === 404) return [];           // dir absent — caller treats as empty
  if (!r.ok) {
    const rate = rateLimitMessage(r.status);
    throw new Error(rate || `github subdir fetch ${dir}: ${r.status}`);
  }
  const j = await r.json();
  if (!Array.isArray(j)) return [];
  return j.map(e => ({ name: e.name, type: e.type === 'dir' ? 'tree' : 'blob' }));
}

module.exports = {
  parseGithubUrl,
  getRepoMeta,
  resolveRef,
  fetchRawFile,
  listTopLevel,
  listSubdir,
  // exposed for tests
  _internal: { ghHeaders, rateLimitMessage },
};
