# Supply-chain analysis tools (optional)

OS8's app-store install pipeline can run two external supply-chain scanners
during the security review phase. **Both are optional** — when neither is
on PATH, OS8 falls back to a small hardcoded typosquat list and the rest
of the review (manifest checks, npm audit, LLM review) runs unchanged.

## What gets installed

| Tool | What it covers | Install |
|---|---|---|
| [`osv-scanner`](https://google.github.io/osv-scanner/) | Node, Python, Go, Rust, Maven, and other ecosystems via the OSV.dev database | `brew install osv-scanner` (macOS) <br> `apt install osv-scanner` (Debian/Ubuntu, recent) <br> Direct binary: <https://github.com/google/osv-scanner/releases> |
| [`safety`](https://docs.pyup.io/docs/safety-cli) | Python deps (vs. PyUp's vulnerability database) | `pip install safety` |

Both ship arm64 binaries (relevant for Apple Silicon and the Spark dev box).

## How OS8 uses them

When you approve an install in the App Store, OS8 reviews the cloned source
in three phases (see `src/services/app-review.js`):

1. **Blocking static checks** — argv shape, lockfile match, arch compat.
2. **Advisory static analysis** — `npm audit` for Node, **then this scanner
   suite**, then a Python typosquat fallback when neither tool ran.
3. **LLM review** — manifest claims vs. observed code.

Phase 2's scanner step does:

- Detect `osv-scanner --version`. If present, run
  `osv-scanner scan source --format=json <stagingDir>` (90s timeout) and parse
  the JSON report.
- Detect `safety --version`. If present **and** the staging dir has a
  `requirements.txt`, run `safety check -r requirements.txt --json
  --continue-on-error` (60s timeout).
- If a Python lockfile is present (`pyproject.toml`, `requirements.txt`,
  `uv.lock`, `poetry.lock`) **and** neither tool ran, fall back to the
  typosquat list and surface an info finding pointing at this doc.

Each finding shows up in the install-plan modal's review panel.

## Severity mapping

| OSV report | OS8 finding severity | Effect on `riskLevel` |
|---|---|---|
| Advisory id starts with `MAL-` (or has a `MAL-*` alias) | `critical` | rolls to `high` |
| `database_specific.severity` HIGH or CRITICAL | `warning` | rolls to `medium` |
| `database_specific.severity` MODERATE / MEDIUM / LOW | `info` | no change |

| safety report | OS8 finding severity | Effect on `riskLevel` |
|---|---|---|
| Any reported vulnerability | `warning` | rolls to `medium` |

`safety`'s free tier doesn't expose CVSS scores, so OS8 uniformly maps its
findings to `warning` rather than overstating their severity. Users with
a paid safety key can `export SAFETY_API_KEY=...` and it flows through to
the subprocess via the inherited environment — no OS8 code change needed.

## Why they're optional

A clean install of OS8 should produce a working App Store with reasonable
security review **without** requiring users to install Go binaries or pip
packages. The fallback path (typosquat list at `app-review.js:KNOWN_MALICIOUS_PYTHON`)
is intentionally narrow — it's a defense-in-depth signal, not a real CVE
database.

For verified-channel apps (curator-reviewed), the canonical CI in
`os8ai/os8-catalog` runs these tools at submission time, so users
benefit even without local install. Local scanners matter most for
the **community** and **developer-import** channels (Phase 3 PRs 3.1–3.5).

## Verifying the integration locally

```bash
# Check tool detection
which osv-scanner safety

# Install one (macOS example)
brew install osv-scanner

# Install an app from a repo with known-vulnerable deps and watch the modal
# — warning findings should appear in the security review section.
```

If a tool is on PATH but errors at runtime (network down, malformed
lockfile), OS8 surfaces an `info` finding describing the failure and
continues. Scanner failures never block an install.

## Cross-platform notes

- **Linux:** verified during PR 3.6 development on the OS8 dev box (Spark, aarch64).
- **macOS:** unit + integration tests pass; manual verification expected post-merge.
- **Windows:** unit tests pass; manual verification informal only.

All three platforms use the same `execFile` invocation (no shell), so platform
behavior diverges only when the binaries themselves diverge.
