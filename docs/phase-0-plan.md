# OS8 App Store — Phase 0 Implementation Plan

**Companions:** [`app-store-spec.md`](./app-store-spec.md) (Draft v2) and [`app-store-plan.md`](./app-store-plan.md).
**Audience:** Engineers implementing PRs 0.1 – 0.11.
**This document:** the concrete contract for each Phase 0 PR — schemas, workflow YAML, route signatures, env vars, edge cases. Reference the spec/plan for *why*; this file is *how*.

---

## Scope

Phase 0 ships browse-only on os8.ai. After 0.11 merges, you can:

- Open a PR against `os8ai/os8-catalog` adding a manifest → CI validates, posts a resolved SHA comment, gates Verified-channel manifests on lockfile presence.
- Merge that PR → GitHub webhook fires → os8.ai mirrors the manifest into Postgres with assets pinned to the catalog commit SHA.
- Visit `os8.ai/apps` → browse, filter, search; click an app → detail page with screenshots and README.
- Click **Install** → emit `os8://install?...` deeplink (anonymous OK); for signed-in users, also create a `PendingInstall` row.

What Phase 0 does **not** ship: the desktop install pipeline (Phase 1), Community channel (Phase 3), Developer Import (Phase 3), Python / Docker runtimes (Phase 2). The only desktop-side change Phase 0 *needs* is the optional `allow_package_scripts` field landed in the JSON Schema so manifests can declare it before the Phase 1 adapter consumes it (plan §10 Q8).

## Audit findings that shape every PR

Three findings from the live `/home/leo/Claude/os8dotai/` codebase change how PR 0.7 and 0.8 must be written. Engineers writing those PRs must know all three:

1. **`@prisma/adapter-neon` and `@neondatabase/serverless` are dependencies but are not wired.** `prisma/schema.prisma` has no `previewFeatures = ["driverAdapters"]` and `src/db/index.ts` instantiates `new PrismaClient()` plainly. PR 0.7 enables the adapter — without it, the sync endpoint and `/apps` page pages will exhaust Neon's connection pool from cold-start serverless invocations.
2. **No `prisma/migrations/` directory exists.** The current schema (`User`, `DesktopAuthCode`) was deployed via `prisma db push`, not `prisma migrate`. PR 0.7 must initialize the migrations system — `prisma migrate dev --name init_app_store` will both capture the existing tables as a baseline migration *and* add the new ones in the same migration file unless we explicitly baseline first. The right sequence is documented in PR 0.7.
3. **No `vercel.json`, no `.github/`, no scripts directory in os8dotai.** PR 0.8 creates `vercel.json` from scratch with the cron entry. There is no existing CI to extend. GitHub webhook configuration is a one-time manual step on the catalog repo's Settings → Webhooks page (documented in PR 0.8 deployment notes), not an Action.

A fourth finding shapes how PR 0.5/0.6 author manifests: the upstream `koala73/worldmonitor` repo **exists, is a real Vite project on `vite@5`, has `package-lock.json`, license AGPL-3.0**, and the latest stable annotated tag `v2.5.23` dereferences to commit SHA `e51058e1765ef2f0c83ccb1d08d984bc59d23f10`. No fake repos needed. Annotated tags require `^{commit}` dereferencing — PR 0.3 and PR 0.8 both go through `GET /repos/{owner}/{repo}/commits/{ref}` (which auto-dereferences) rather than `git/refs/tags/{tag}` (which returns the tag object SHA, not the commit).

---

## PR 0.1 — Bootstrap `os8ai/os8-catalog` repo + JSON Schema

### Goal

New GitHub repo at `os8ai/os8-catalog` with the schema that everything else in Phase 0 ingests. This is the load-bearing artifact: it locks the AppSpec contract before any tooling depends on it.

### Files to create

```
os8ai/os8-catalog/
├── README.md
├── CONTRIBUTING.md
├── LICENSE                            # MIT (the catalog itself; manifests carry their own license)
├── schema/
│   └── appspec-v1.json
├── apps/
│   └── .gitkeep
└── .github/
    └── CODEOWNERS
```

### `schema/appspec-v1.json` (full canonical schema)

Use JSON Schema draft 2020-12. Walk this against spec §3 field-by-field — every field that can be validated mechanically is validated here.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://os8.ai/schema/appspec-v1.json",
  "title": "OS8 AppSpec v1",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion", "slug", "name", "publisher", "icon", "category",
    "description", "upstream", "runtime", "install", "start", "surface",
    "permissions", "legal", "review"
  ],
  "properties": {
    "schemaVersion": { "const": 1 },

    "slug": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{1,39}$",
      "description": "Globally unique within channel; immutable after publish; reserved prefix `os8-` is for first-party apps."
    },

    "name":        { "type": "string", "minLength": 1, "maxLength": 60 },
    "publisher":   { "type": "string", "minLength": 1, "maxLength": 60 },
    "description": { "type": "string", "minLength": 1, "maxLength": 280 },

    "icon": {
      "type": "string",
      "pattern": "^\\./[A-Za-z0-9_./-]+\\.(png|svg)$",
      "description": "Relative to the manifest folder. Image checks (256x256 ≤100KB for png) enforced in PR 0.2."
    },

    "screenshots": {
      "type": "array",
      "minItems": 0,
      "maxItems": 5,
      "items": {
        "type": "string",
        "pattern": "^\\./[A-Za-z0-9_./-]+\\.(png|jpg|jpeg|webp)$"
      }
    },

    "category": {
      "enum": ["productivity", "intelligence", "media", "dev-tools", "data", "ai-experiments", "utilities"]
    },

    "upstream": {
      "type": "object",
      "additionalProperties": false,
      "required": ["git", "ref"],
      "properties": {
        "git": {
          "type": "string",
          "pattern": "^https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(\\.git)?$"
        },
        "ref": {
          "type": "string",
          "oneOf": [
            { "pattern": "^[0-9a-f]{40}$",                "title": "40-char commit SHA" },
            { "pattern": "^v\\d+\\.\\d+\\.\\d+(-[A-Za-z0-9.-]+)?$", "title": "semver tag (e.g. v1.2.3, v1.2.3-rc.1)" }
          ],
          "description": "Branch names rejected. Sync resolves tags to SHAs."
        }
      }
    },

    "framework": {
      "enum": ["vite", "nextjs", "sveltekit", "astro", "streamlit", "gradio", "hugo", "jekyll", "none"]
    },

    "runtime": {
      "type": "object",
      "additionalProperties": false,
      "required": ["kind", "version"],
      "properties": {
        "kind":             { "enum": ["node", "python", "static"] },
        "version":          { "type": "string", "pattern": "^[0-9.]+$" },
        "arch":             { "type": "array", "items": { "enum": ["arm64", "x86_64"] }, "default": ["arm64", "x86_64"] },
        "package_manager":  { "enum": ["auto", "npm", "pnpm", "yarn", "bun", "pip", "uv", "poetry"], "default": "auto" },
        "dependency_strategy": { "enum": ["frozen", "strict", "best-effort"], "default": "frozen" }
      }
    },

    "env": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["name", "value"],
        "properties": {
          "name":        { "type": "string", "pattern": "^[A-Z][A-Z0-9_]*$" },
          "value":       { "type": "string" },
          "description": { "type": "string" }
        }
      }
    },

    "install":     { "$ref": "#/$defs/commandList" },
    "postInstall": { "$ref": "#/$defs/commandList" },
    "preStart":    { "$ref": "#/$defs/commandList" },

    "start": {
      "type": "object",
      "additionalProperties": false,
      "required": ["argv"],
      "properties": {
        "argv":       { "$ref": "#/$defs/argv" },
        "shell":      { "const": false, "default": false },
        "port":       { "oneOf": [{ "const": "detect" }, { "type": "string", "pattern": "^fixed:[0-9]{2,5}$" }] },
        "readiness": {
          "type": "object",
          "additionalProperties": false,
          "required": ["type"],
          "properties": {
            "type":            { "enum": ["http", "log-regex"] },
            "path":            { "type": "string" },
            "regex":           { "type": "string" },
            "timeout_seconds": { "type": "integer", "minimum": 1, "maximum": 600, "default": 30 }
          }
        }
      }
    },

    "allow_package_scripts": {
      "type": "boolean",
      "default": false,
      "description": "Opt-in to running package.json postinstall/preinstall scripts during install. Verified channel: ignored (always allowed; LLM review flags). Community channel: required to run scripts. Developer Import: ignored (always blocked). See plan §10 Q8."
    },

    "surface": {
      "type": "object",
      "additionalProperties": false,
      "required": ["kind"],
      "properties": {
        "kind":                { "const": "web" },
        "preview_name":        { "type": "string", "maxLength": 60 }
      }
    },

    "dev": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "hmr":        { "enum": ["vite", "next", "streamlit", "gradio", "watcher", "none"] },
        "watch":      { "type": "array", "items": { "type": "string" } },
        "editable":   { "type": "boolean", "default": true },
        "restart_on": { "type": "array", "items": { "type": "string" } }
      }
    },

    "permissions": {
      "type": "object",
      "additionalProperties": false,
      "required": ["network", "filesystem"],
      "properties": {
        "network": {
          "type": "object",
          "additionalProperties": false,
          "required": ["outbound", "inbound"],
          "properties": {
            "outbound": { "type": "boolean" },
            "inbound":  { "type": "boolean" }
          }
        },
        "filesystem": { "const": "app-private" },
        "os8_capabilities": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^(blob\\.(readwrite|readonly)|db\\.(readwrite|readonly)|telegram\\.send|imagegen|speak|youtube|x|google\\.(calendar\\.(readonly|readwrite)|drive\\.readonly|gmail\\.readonly)|mcp\\.[a-z0-9_-]+\\.[a-z0-9_*-]+)$"
          }
        },
        "secrets": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["name"],
            "properties": {
              "name":     { "type": "string", "pattern": "^[A-Z][A-Z0-9_]*$" },
              "required": { "type": "boolean", "default": true },
              "prompt":   { "type": "string" },
              "pattern":  { "type": "string" }
            }
          }
        }
      }
    },

    "resources": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "memory_limit_mb": { "type": "integer", "minimum": 64, "maximum": 65536 },
        "gpu":             { "enum": ["required", "optional", "none"] },
        "disk_mb":         { "type": "integer", "minimum": 1, "maximum": 1048576 }
      }
    },

    "legal": {
      "type": "object",
      "additionalProperties": false,
      "required": ["license"],
      "properties": {
        "license":         { "type": "string", "pattern": "^[A-Za-z0-9.+-]+( WITH .+)?$", "description": "SPDX expression" },
        "commercial_use":  { "enum": ["unrestricted", "restricted", "prohibited"] },
        "notes":           { "type": "string" }
      }
    },

    "review": {
      "type": "object",
      "additionalProperties": false,
      "required": ["channel"],
      "properties": {
        "channel":     { "enum": ["verified", "community", "developer-import"] },
        "reviewed_at": { "type": "string", "format": "date" },
        "reviewer":    { "type": "string" },
        "risk":        { "enum": ["low", "medium", "high"] }
      }
    }
  },

  "allOf": [
    {
      "if":   { "properties": { "review": { "properties": { "channel": { "const": "verified" } } } } },
      "then": { "properties": { "runtime": { "properties": { "dependency_strategy": { "const": "frozen" } } } } }
    }
  ],

  "$defs": {
    "argv": {
      "type": "array",
      "minItems": 1,
      "items": { "type": "string", "minLength": 1 }
    },
    "commandList": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["argv"],
        "properties": {
          "argv":  { "$ref": "#/$defs/argv" },
          "shell": { "const": false, "default": false }
        }
      }
    }
  }
}
```

**Notes on the schema** (these are the contract decisions worth highlighting before implementation):

- `runtime.kind` excludes `docker` syntactically — a v1 invariant. Phase 2 PR 2.5 will publish `appspec-v2.json` (or extend) when docker is added.
- `surface.kind` is `const: "web"` — schema-level v1 invariant.
- **`surface.base_path_strategy` is intentionally absent from the schema.** Phase 1 routes every external app at `<slug>.localhost:8888` (subdomain mode); path mode (`localhost:8888/<slug>/`) was rejected during execution planning for sharing one browser origin across all installed apps and for taxing manifest authors with per-framework base-path config. See app-store-plan.md §10 decision 11 and spec §1 "Why subdomain mode." Manifests that include `base_path_strategy` are rejected by `additionalProperties: false`. If path mode ever resurfaces as a legitimate need, add the field in a future schema version.
- `permissions.filesystem` is `const: "app-private"` — schema-level v1 invariant.
- Command-list items use `{argv: [...], shell: false}` shape. `shell` is permitted to set explicitly to `false` for clarity; the schema disallows `shell: true` outright via `const: false`. **The spec §3.3 "shell: true exception"** is therefore not expressible in the schema and is dropped — Verified channel rejects it anyway, and Community/Developer-Import don't need a shell-string escape hatch in v1. If a future manifest genuinely needs it, add an explicit `unsafe_shell` flag in v2 with curator-only override.
- `allow_package_scripts: boolean` is included now (per plan §10 Q8) so manifests written in Phase 0 can land valid manifests that the Phase 1 adapter will consume.
- The `allOf` rule pins Verified channel → `dependency_strategy: frozen`. Lockfile presence is a separate check that requires fetching the upstream repo and is enforced by `lockfile-gate.yml` (PR 0.4), not the schema.
- `os8_capabilities` regex enumerates v1 capabilities exactly. `mcp.<server>.<tool>` is fine-grained; supports `*` as the tool component for wildcard (plan §10 Q5 — non-breaking forward compat).
- `upstream.ref` regex: 40-char SHA OR `vX.Y.Z` semver. **No branch names.** This is a hard supply-chain rule from spec §3.5.

### `README.md` outline

```
# OS8 Catalog

The official catalog of apps installable through OS8.

## Adding an app
1. Read CONTRIBUTING.md.
2. Open a PR adding `apps/<your-slug>/manifest.yaml` + assets.
3. CI runs schema validation, slug uniqueness, image checks, tag→SHA resolution, and (for Verified channel) lockfile gate.
4. A curator reviews; on merge, the app appears on os8.ai.

## Repo layout
... (mirrors spec §4.1)

## Schema
The AppSpec v1 schema is at `schema/appspec-v1.json`. Editor support: VS Code's YAML extension auto-loads the schema via the `# yaml-language-server: $schema=` comment at the top of each manifest.

## License
MIT (the catalog itself). Each app declares its own upstream license in `legal.license`.
```

### `CONTRIBUTING.md` outline

```
# Contributing to the OS8 Catalog

## Sections
1. **Before you open a PR** — pick a slug, prepare assets, ensure upstream has a lockfile (Verified channel), pin a tag or SHA.
2. **Manifest fields** — concise rundown of required fields, with links to spec §3.4.
3. **Asset requirements** — icon 256x256 ≤100KB; screenshots ≤500KB each, max 5; png/jpg/webp.
4. **CI checks** — what each workflow does, how to read failures, common fixes.
5. **Review process** — what curators look at, average turnaround, what gets pushed back.
6. **Updating an app** — bumping `upstream.ref`, image refresh, withdrawing.
7. **Channels** — Verified vs Community (Phase 3) vs Developer Import (desktop only).
```

### `.github/CODEOWNERS` shape

Per-app ownership: a global team owns everything by default; per-app entries override so the named curator(s) get auto-assigned to PRs touching that app's folder.

```
# Default — global curator team approves everything
*               @os8ai/curators

# Schema and CI are protected — only senior curators
/schema/        @os8ai/curators-senior
/.github/       @os8ai/curators-senior

# Per-app owners (added when an app lands)
# /apps/worldmonitor/   @koala73 @os8ai/curators
# /apps/excalidraw/     @os8ai/curators
# /apps/<slug>/         @<author> @os8ai/curators
```

The pattern: global team owns `*`, then per-app entries add the manifest author as a second required reviewer. Senior-curators own the schema and CI so a malicious manifest author can't relax CI in their own PR.

### Tests

None for PR 0.1 — schema is exercised by the workflows in 0.2 and the seed manifest in 0.5.

### Acceptance criteria

- Repo `os8ai/os8-catalog` exists, public.
- `schema/appspec-v1.json` validates the example in spec §3.1 (sanity-check by running `ajv validate -s schema/appspec-v1.json -d <(yaml-to-json spec-example.yaml)` locally before opening the PR).
- `CODEOWNERS` includes the global team rule.
- A manual `ajv` run rejects a manifest with `runtime.kind: docker` and a manifest with `upstream.ref: main`.

### Environment variables

None. (Workflows in 0.2/0.3/0.4 introduce `secrets.GITHUB_TOKEN` — implicitly supplied by GitHub Actions.)

### Dependencies

None (foundation PR).

### Open sub-questions

None. The `shell: true` exception in spec §3.3 is dropped from the schema, as noted above.

---

## PR 0.2 — `validate.yml` CI workflow

### Goal

Mechanical validation on every PR touching `apps/`: ajv schema conformance, slug uniqueness, image dimensions and sizes, no `runtime.kind: docker`, no shell-string command fields. Run on push and pull_request.

### Files to create

- `.github/workflows/validate.yml`
- `.github/scripts/validate-manifests.js` (Node 20)
- `package.json` at repo root with `ajv-cli`, `js-yaml`, `sharp`, `glob` (workflow dependencies)
- `package-lock.json` from `npm install`

### `.github/workflows/validate.yml`

```yaml
name: validate

on:
  pull_request:
    paths:
      - 'apps/**'
      - 'schema/**'
      - '.github/scripts/validate-manifests.js'
  push:
    branches: [main]
    paths:
      - 'apps/**'
      - 'schema/**'

permissions:
  contents: read
  pull-requests: write   # needed only for the comment job; restricted

concurrency:
  group: validate-${{ github.ref }}
  cancel-in-progress: true

jobs:
  schema:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # for changed-file detection on push

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: npm

      - name: Install
        run: npm ci

      - name: Validate manifests
        id: validate
        run: node .github/scripts/validate-manifests.js
        # Script writes a JSON report to $GITHUB_STEP_SUMMARY and exits non-zero on failure.

      - name: Upload report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: validation-report
          path: validation-report.json
          if-no-files-found: ignore
```

### `.github/scripts/validate-manifests.js` (behavior, not full code)

What the script does, in order:

1. Find all `apps/*/manifest.yaml` files (glob).
2. For each:
   - `js-yaml.load()` the file (safe variant, never `loadAll`).
   - Validate against `schema/appspec-v1.json` using ajv with `strict: true, allErrors: true, formats: { date: true }`.
   - Confirm folder slug matches `manifest.slug`.
   - Confirm `apps/<slug>/icon.png` exists; check dimensions via `sharp(buffer).metadata()` → must be 256x256 PNG; check `fs.statSync().size <= 100*1024`.
   - For each `screenshots[i]`: confirm file exists; size ≤ 500KB; format png/jpg/webp.
   - Confirm `manifest.icon === './icon.png'` (or `./icon.svg`) — relative path matches the actual file.
3. Across all manifests: confirm slug uniqueness.
4. Reject if any manifest has `shell: true` anywhere (defensive double-check beyond schema).
5. Reject if `runtime.kind === 'docker'` (defensive double-check).
6. Write `validation-report.json` with `{ ok: bool, manifests: [{ slug, ok, errors: [...] }] }`.
7. `console.log` a markdown summary; append to `$GITHUB_STEP_SUMMARY`.
8. `process.exit(0)` if all OK; `process.exit(1)` if any failed.

### Tests (CI fixtures)

Create `apps/_test-fixtures/` (named `_test-fixtures` so it doesn't conflict with real apps; the script skips folders starting with `_`):

| Fixture | Content | Expected result |
|---|---|---|
| `valid-vite/manifest.yaml` | minimal valid Vite manifest | ✅ pass |
| `bad-docker/manifest.yaml` | `runtime.kind: docker` | ❌ fail with "runtime.kind must be one of node/python/static" |
| `bad-shell/manifest.yaml` | `install: [{argv: ["sh"], shell: true}]` | ❌ fail |
| `bad-branch-ref/manifest.yaml` | `upstream.ref: main` | ❌ fail with "ref does not match SHA or semver" |
| `bad-slug-mismatch/manifest.yaml` | folder is `bad-slug-mismatch`, manifest.slug is `other` | ❌ fail |
| `bad-image-too-big/icon.png` | 200KB icon | ❌ fail with "icon ≤ 100KB" |

The script must skip `apps/_*` folders in production validation.

### Acceptance criteria

- PR adding `apps/_test-fixtures/bad-docker/` → CI red, comment includes the schema error.
- PR adding `apps/_test-fixtures/valid-vite/` → CI green.
- Workflow runs in <60s for a catalog with ≤50 apps.

### Environment variables

None. `secrets.GITHUB_TOKEN` is implicit and read-only here.

### Dependencies

PR 0.1 (schema must exist).

### Open sub-questions

None.

---

## PR 0.3 — `resolve-refs.yml` CI workflow

### Goal

For every changed manifest in a PR, if `upstream.ref` is a tag, resolve it to the immutable commit SHA via the GitHub API and post a comment on the PR with the resolved SHA. Curator reviews against the resolved SHA, not the tag string.

### Files to create

- `.github/workflows/resolve-refs.yml`
- `.github/scripts/resolve-refs.js`

### `.github/workflows/resolve-refs.yml`

```yaml
name: resolve-refs

on:
  pull_request:
    paths:
      - 'apps/**/manifest.yaml'

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: resolve-refs-${{ github.ref }}
  cancel-in-progress: true

jobs:
  resolve:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: npm

      - run: npm ci

      - name: Resolve upstream refs
        id: resolve
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          PR_BASE_SHA:  ${{ github.event.pull_request.base.sha }}
          PR_HEAD_SHA:  ${{ github.event.pull_request.head.sha }}
          PR_NUMBER:    ${{ github.event.pull_request.number }}
        run: node .github/scripts/resolve-refs.js

      - name: Comment on PR
        if: always() && steps.resolve.outputs.comment != ''
        uses: actions/github-script@v7
        with:
          script: |
            const body = process.env.COMMENT_BODY;
            // Find existing bot comment to update; otherwise create.
            const { data: comments } = await github.rest.issues.listComments({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
            });
            const existing = comments.find(c =>
              c.user.type === 'Bot' && c.body.startsWith('<!-- resolve-refs-bot -->')
            );
            if (existing) {
              await github.rest.issues.updateComment({
                owner: context.repo.owner, repo: context.repo.repo,
                comment_id: existing.id, body
              });
            } else {
              await github.rest.issues.createComment({
                owner: context.repo.owner, repo: context.repo.repo,
                issue_number: context.issue.number, body
              });
            }
        env:
          COMMENT_BODY: ${{ steps.resolve.outputs.comment }}
```

### `.github/scripts/resolve-refs.js` (behavior)

1. Diff `PR_BASE_SHA..PR_HEAD_SHA` for changed `apps/*/manifest.yaml` paths via `git diff --name-only`.
2. For each changed manifest:
   - Parse YAML.
   - If `upstream.ref` is already a 40-char SHA, record as `resolved = ref` (already pinned).
   - Else (it's a `vX.Y.Z` tag): call `GET https://api.github.com/repos/{owner}/{repo}/commits/{ref}` with `Authorization: Bearer ${GITHUB_TOKEN}` and `Accept: application/vnd.github+json`. **This endpoint auto-dereferences annotated tags** — no need to two-step through `git/refs/tags/{tag}` then `git/tags/{sha}`. Validated against `koala73/worldmonitor` v2.5.23 (annotated) → `e51058e1...`.
   - If 404, record an error.
   - Confirm the resolved SHA matches `^[0-9a-f]{40}$`.
3. Build a markdown table:
   ```
   <!-- resolve-refs-bot -->
   ## Resolved upstream refs

   | Slug | Ref | Resolved SHA |
   |---|---|---|
   | worldmonitor | v2.5.23 | [e51058e1](https://github.com/koala73/worldmonitor/commit/e51058e1...) |

   _Curator: review the linked commit, not just the tag. Tags can mutate; this commit is immutable._
   ```
4. Set `outputs.comment` to the markdown via `core.setOutput('comment', ...)` (or via `$GITHUB_OUTPUT`).
5. Exit non-zero on resolution failure.

### Reconciliation with PR 0.8

Spec §3 calls for resolution at PR-comment time (here) and at sync time (PR 0.8). **The two resolutions reconcile via durable state on the os8.ai side, not via persisting PR 0.3's resolution back into the catalog repo.** Concretely: PR 0.8's sync logic compares current `upstreamResolvedCommit` against the prior `App.upstreamResolvedCommit` for the same `(slug, manifestSha)`. If `manifestSha` is unchanged but the resolved commit moved, the tag was rewritten between syncs — fire a supply-chain alarm (see PR 0.8 §"Tag mutation alarm"). PR 0.3's job is curator visibility (the SHA they're approving is the SHA that ships); durable cross-PR comparison happens server-side. This avoids the extra workflow complexity of having PR 0.3 commit the resolution back to the PR branch.

### Tests

| Fixture | Expected |
|---|---|
| `apps/_test-fixtures/valid-vite/` with `ref: v0.18.1` against a real upstream | comment posted with resolved 40-char SHA |
| `apps/_test-fixtures/bad-tag/` with `ref: v999.999.999` | CI red: "tag not found in upstream" |
| Manifest with `ref: deadbeef...` (already SHA) | comment shows "already pinned: deadbeef..." |

### Acceptance criteria

- Open a PR adding `apps/worldmonitor/manifest.yaml` with `ref: v2.5.23` → bot comment shows `e51058e1765ef2f0c83ccb1d08d984bc59d23f10`.
- Push a second commit to the same PR → existing bot comment is **updated**, not duplicated.
- A nonexistent tag turns CI red with a useful error.

### Environment variables

- `secrets.GITHUB_TOKEN` (auto-supplied by Actions; sufficient for cross-repo public-repo reads at the elevated 5000-req/h rate).

### Dependencies

PR 0.1.

### Open sub-questions

None.

---

## PR 0.4 — `lockfile-gate.yml` CI workflow

### Goal

For Verified-channel manifests, check out the upstream repo at `upstream.ref` (resolved if a tag) and assert at least one recognized lockfile is present. Block merge otherwise.

### Files to create

- `.github/workflows/lockfile-gate.yml`
- `.github/scripts/check-lockfile.js`

### `.github/workflows/lockfile-gate.yml`

```yaml
name: lockfile-gate

on:
  pull_request:
    paths:
      - 'apps/**/manifest.yaml'

permissions:
  contents: read

concurrency:
  group: lockfile-gate-${{ github.ref }}
  cancel-in-progress: true

jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: npm

      - run: npm ci

      - name: Run lockfile gate
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          PR_BASE_SHA:  ${{ github.event.pull_request.base.sha }}
          PR_HEAD_SHA:  ${{ github.event.pull_request.head.sha }}
        run: node .github/scripts/check-lockfile.js
```

### `.github/scripts/check-lockfile.js` (behavior)

1. Diff base..head for changed `apps/*/manifest.yaml`.
2. For each changed manifest:
   - Parse YAML.
   - Skip if `review.channel !== 'verified'` (Community / Developer Import are checked elsewhere or not at all in v1).
   - Resolve `upstream.ref` via the same `GET /commits/{ref}` call from PR 0.3.
   - Hit `GET /repos/{owner}/{repo}/contents?ref=<sha>` with `Authorization: Bearer $GITHUB_TOKEN`, list root entries.
   - Look for any of these names: `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, `uv.lock`, `poetry.lock`, `requirements.txt` (note: `requirements.txt` counts as a lockfile only if `runtime.package_manager === 'pip'` — otherwise reject).
   - **`bun.lockb` validation is presence-only** — no content validation, since bun's binary lockfile format mutates between bun minor versions (resolves plan §10 Q6).
   - Cross-check: if `runtime.package_manager` is set explicitly (not `auto`), confirm a matching lockfile exists. If `auto`, any of the above counts.
3. Exit non-zero on failure with a clear message: `worldmonitor: review.channel=verified requires a lockfile in upstream koala73/worldmonitor@e51058e1; none of {package-lock.json, pnpm-lock.yaml, yarn.lock, bun.lockb} found.`

### Tests

| Fixture | Expected |
|---|---|
| Verified manifest pointing to a repo with `package-lock.json` | ✅ pass |
| Verified manifest pointing to a repo with no lockfile | ❌ fail, descriptive error |
| Community manifest with no lockfile | ⏭ skipped |
| `package_manager: pnpm` but only `package-lock.json` in upstream | ❌ fail (mismatch) |

### Acceptance criteria

- PR adding worldmonitor manifest (Verified, npm, package-lock.json present at v2.5.23) → green.
- PR adding a Verified manifest pointing at an upstream lacking any lockfile → red with a useful error.
- Workflow runs in <30s for a single-manifest PR.

### Environment variables

- `secrets.GITHUB_TOKEN`.

### Dependencies

PR 0.1, PR 0.3 (for the resolution helper — share the same `resolveRef()` from `.github/scripts/lib/`).

### Open sub-questions

None — `bun.lockb` presence-only check is the resolved decision (plan §10 Q6).

---

## PR 0.5 — Hand-author `worldmonitor` manifest

### Goal

The first real manifest in the catalog. Demonstrates the schema works end-to-end against a real upstream. CI for 0.2/0.3/0.4 must pass on this PR.

### Upstream verification (already done; embed in the PR)

| Field | Value | Source |
|---|---|---|
| Repo | `https://github.com/koala73/worldmonitor.git` | Verified at audit time. |
| Tag | `v2.5.23` | Latest semver tag at audit time. |
| Resolved SHA | `e51058e1765ef2f0c83ccb1d08d984bc59d23f10` | `GET /repos/koala73/worldmonitor/commits/v2.5.23` (auto-dereferences annotated tag). |
| License | `AGPL-3.0-only` | `package.json:license`, `LICENSE` file. |
| Lockfile | `package-lock.json` (npm) | Confirmed in repo root at the resolved SHA. |
| Framework | Vite (`"dev": "vite"` in scripts) | `package.json:scripts.dev`. |

### Files to create

```
apps/worldmonitor/
├── manifest.yaml
├── icon.png                          # 256x256 ≤ 100KB
├── screenshots/
│   ├── 01-dashboard.png              # ≤ 500KB
│   └── 02-detail.png                 # ≤ 500KB
└── README.md                         # editorial copy, rendered on detail page
```

### `apps/worldmonitor/manifest.yaml` (full)

```yaml
# yaml-language-server: $schema=../../schema/appspec-v1.json

schemaVersion: 1
slug: worldmonitor
name: "World Monitor"
publisher: koala73
icon: ./icon.png
screenshots:
  - ./screenshots/01-dashboard.png
  - ./screenshots/02-detail.png
category: intelligence
description: >-
  Real-time global intelligence dashboard. AI-powered news aggregation,
  geopolitical monitoring, and infrastructure tracking.

upstream:
  git: https://github.com/koala73/worldmonitor.git
  ref: v2.5.23

framework: vite

runtime:
  kind: node
  version: "20"
  arch: [arm64, x86_64]
  package_manager: npm
  dependency_strategy: frozen

env:
  - name: VITE_DEV_PORT
    value: "5173"
    description: "Internal dev server port (proxy translates from {{PORT}})."

install:
  - argv: ["npm", "ci"]

start:
  argv: ["npm", "run", "dev", "--", "--port", "{{PORT}}", "--host", "127.0.0.1"]
  port: detect
  readiness:
    type: http
    path: /
    timeout_seconds: 60

surface:
  kind: web
  preview_name: "World Monitor"
  # v1 routes every external app at <slug>.localhost:8888 — no base-path needed.

dev:
  hmr: vite
  editable: true
  restart_on:
    - vite.config.*
    - package.json

permissions:
  network:
    outbound: true
    inbound: false
  filesystem: app-private
  os8_capabilities: []
  secrets: []

resources:
  memory_limit_mb: 1024
  gpu: none
  disk_mb: 800

legal:
  license: AGPL-3.0-only
  commercial_use: restricted
  notes: "Personal use OK. Commercial use requires AGPL-3.0 compliance."

review:
  channel: verified
  reviewed_at: "2026-04-28"   # quoted — YAML auto-parses unquoted dates to date objects, schema requires string
  reviewer: os8ai/curators
  risk: low
```

### `apps/worldmonitor/README.md` outline

```
# World Monitor

A real-time global intelligence dashboard built with Vite + React + deck.gl.

## What it does
- Aggregates news, AIS shipping data, threat feeds, infrastructure status.
- Renders on an interactive 3D globe.

## Notes for OS8 users
- First launch downloads ~50MB of map tiles to `OS8_BLOB_DIR`.
- Default behavior is read-only (no API keys required); some feeds gracefully degrade.
- Outbound network: Convex backend, Sentry telemetry. No inbound listeners.

## Source
https://github.com/koala73/worldmonitor (AGPL-3.0)
```

### Acceptance criteria

- PR adding `apps/worldmonitor/` is green on `validate.yml`, `resolve-refs.yml`, `lockfile-gate.yml`.
- The bot comment from `resolve-refs.yml` shows `e51058e1765ef2f0c83ccb1d08d984bc59d23f10`.
- The merge fires the catalog→os8.ai webhook (per PR 0.8); after merge, `App` row exists in os8.ai DB with `slug = 'worldmonitor'`.

### Tests

The CI workflows from 0.2/0.3/0.4 are the test surface — no separate tests for this PR.

### Environment variables

None.

### Dependencies

PR 0.1 (schema), PR 0.2 (validate), PR 0.3 (resolve-refs), PR 0.4 (lockfile-gate).

### Open sub-questions

- Icon and screenshots need to be sourced from the upstream repo's branding or the catalog editor. If the upstream's logo is unavailable, an OS8-curator-provided placeholder is acceptable for v1; document the placeholder source in the PR description.

---

## PR 0.6 — 4 more seed manifests (5-app catalog total)

### Goal

Coverage across Vite, Next.js, Astro, SvelteKit; ≥5 apps in the catalog by Phase 0 close.

### Seed list (verified at audit time)

All five upstreams below were verified to exist, have a recognized lockfile at the chosen ref, and have a permissive or restricted-but-allowed license. The PR author re-verifies each at PR-author time and substitutes alternatives if any have moved.

| # | Slug | Upstream | Framework | Lockfile | License | Pin |
|---|---|---|---|---|---|---|
| 1 | `worldmonitor` | `koala73/worldmonitor` | vite | `package-lock.json` (npm) | AGPL-3.0 | `v2.5.23` → `e51058e1...` (PR 0.5) |
| 2 | `excalidraw` | `excalidraw/excalidraw` | vite | `yarn.lock` | MIT | `v0.18.1` → `a2ec2889babf7d2295469c6d90ebe77fae57df84` |
| 3 | `documenso` | `documenso/documenso` | nextjs | `package-lock.json` (npm) | AGPL-3.0 | `v2.9.1` → `8f3e1893c72333a5b138ddfbeb3dd676e4859459` |
| 4 | `svelte-realworld` | `sveltejs/realworld` | sveltekit | `pnpm-lock.yaml` | MIT | SHA-pin — repo has no formal release tags. Resolve at PR-author time via `GET /repos/sveltejs/realworld/commits/main`. |
| 5 | `astro-blog-tutorial` | `withastro/blog-tutorial-demo` | astro | check at author time | MIT | SHA-pin — sample/demo repo, likely no semver tags. |

The Astro and SvelteKit candidates do not have semver release tags, so their manifests pin a 40-char SHA in `upstream.ref`. The schema accepts SHAs (PR 0.1 schema's `oneOf`).

### Files

For each app:
```
apps/<slug>/
├── manifest.yaml
├── icon.png
├── screenshots/01-*.png
└── README.md
```

### Manifest authoring guidance

- Reuse the worldmonitor manifest shape from PR 0.5 as the template.
- For Excalidraw (yarn): `package_manager: yarn`. The Phase 1 adapter detects yarn1 vs yarn berry from `.yarnrc.yml` (plan §10 decision 7); manifest authors don't choose.
- For Documenso (Next.js with Postgres): declare `permissions.network.outbound: true`; Documenso requires a Postgres URL via `DATABASE_URL` — declare as a required secret. **Note for the curator review:** Documenso's full feature set needs a Postgres instance and Resend API; document in `apps/documenso/README.md` that v1 OS8 users will see graceful failures for email features. This is fine for Phase 0 (browse-only) and lands the realistic-secret-prompt example.
- For SvelteKit Realworld: pin a recent commit SHA; the project is a reference implementation and won't have semver tags.
- For Astro blog tutorial: minimal manifest; `os8_capabilities: []`.

### Acceptance criteria

- All four PRs (or one combined PR) pass all three CI workflows.
- Catalog has ≥5 apps after merge: worldmonitor, excalidraw, documenso, svelte-realworld, astro-blog-tutorial.
- `os8.ai/apps` (after PR 0.9) lists all five.

### Tests

CI workflows from 0.2/0.3/0.4.

### Environment variables

None.

### Dependencies

PR 0.1 – 0.5.

### Open sub-questions

- Whether to combine these 4 manifests into one PR or split into 4 separate PRs. Recommendation: **one PR per manifest** so each gets a focused curator review and the resolve-refs comment is per-PR. Cost is 4 PRs of routine review; benefit is cleaner audit trail.

---

## PR 0.7 — os8.ai Prisma schema additions

### Goal

Add the three new models per spec §5.1 to the os8.ai Postgres database, wire `@prisma/adapter-neon` for serverless connection pooling, and initialize the `prisma/migrations/` directory (currently absent).

### Files to create / modify

- **Modify** `prisma/schema.prisma` — extend with `App`, `PendingInstall`, `CatalogState`; back-link from `User`; add `previewFeatures = ["driverAdapters"]`.
- **Modify** `src/db/index.ts` — instantiate PrismaClient with the Neon adapter.
- **Create** `prisma/migrations/<timestamp>_init_app_store/migration.sql` — generated by `prisma migrate dev`.
- **Modify** `package.json` — add `db:migrate:deploy` script.
- **Modify** `.env.local` (untracked) and document in README — confirm `DATABASE_URL` is a Neon pooled URL (not the unpooled direct URL); for `prisma migrate deploy` use the unpooled URL via `DIRECT_URL`.

### Migration system bootstrap (the load-bearing setup step)

The repo currently has no `prisma/migrations/` directory — the existing `User` and `DesktopAuthCode` tables were deployed via `prisma db push`. Before adding new tables we capture the current state as a baseline:

```bash
# In a working dev DB (or against a staging DB), one-time:
npx prisma migrate dev --name 0_baseline_pre_app_store \
  --create-only

# Inspect the generated migration; it will be the full DDL for User + DesktopAuthCode.
# Mark this migration as applied in production WITHOUT running its DDL:
npx prisma migrate resolve --applied 0_baseline_pre_app_store
```

Then in this PR:
```bash
npx prisma migrate dev --name 1_add_app_store
```
Generates the migration file containing only the new App / PendingInstall / CatalogState DDL.

Document this two-step in the PR description so reviewers and the deploy operator understand why there's a baseline migration with no production DDL change.

### `prisma/schema.prisma` diff (full)

```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["driverAdapters"]
}

datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}

model User {
  id          String   @id @default(uuid())
  googleId    String   @unique @map("google_id")
  email       String
  username    String?  @unique
  displayName String?  @map("display_name")
  avatarUrl   String?  @map("avatar_url")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  desktopAuthCodes DesktopAuthCode[]
  pendingInstalls  PendingInstall[]

  @@map("users")
}

model DesktopAuthCode {
  code          String   @id
  userId        String   @map("user_id")
  redirectPort  Int      @map("redirect_port")
  codeChallenge String?  @map("code_challenge")
  createdAt     DateTime @default(now()) @map("created_at")
  used          Boolean  @default(false)

  user User @relation(fields: [userId], references: [id])

  @@map("desktop_auth_codes")
}

model App {
  id                       String   @id @default(cuid())
  slug                     String   @unique
  name                     String
  description              String   @db.Text
  publisher                String
  channel                  String                                          // "verified" | "community"
  category                 String

  iconUrl                  String   @map("icon_url")                       // pinned to catalog commit SHA
  screenshots              String[] @default([])

  // Manifest version tracking — four distinct fields per spec §5.1.
  manifestSha              String   @map("manifest_sha")                   // SHA-256 of manifest YAML content
  catalogCommitSha         String   @map("catalog_commit_sha")             // catalog repo SHA at sync time
  upstreamDeclaredRef      String   @map("upstream_declared_ref")          // e.g. "v2.5.23"
  upstreamResolvedCommit   String   @map("upstream_resolved_commit")       // 40-char SHA the tag pointed to

  manifestYaml             String   @db.Text @map("manifest_yaml")
  license                  String
  runtimeKind              String   @map("runtime_kind")
  framework                String?                                         // scalar — "vite" | "nextjs" | …
  architectures            String[] @default(["arm64", "x86_64"])
  riskLevel                String   @map("risk_level")                     // "low" | "medium" | "high"

  installCount             Int      @default(0) @map("install_count")
  syncedAt                 DateTime @map("synced_at")
  publishedAt              DateTime @map("published_at")
  updatedAt                DateTime @updatedAt @map("updated_at")
  deletedAt                DateTime? @map("deleted_at")

  pendingInstalls          PendingInstall[]

  @@index([channel, category])
  @@index([publishedAt])
  @@index([deletedAt])
  @@map("apps")
}

model PendingInstall {
  id                       String    @id @default(cuid())
  userId                   String    @map("user_id")
  user                     User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  appSlug                  String    @map("app_slug")
  app                      App       @relation(fields: [appSlug], references: [slug], onDelete: Cascade)

  upstreamResolvedCommit   String    @map("upstream_resolved_commit")
  channel                  String

  status                   String    @default("pending")                   // "pending" | "consumed" | "expired"
  createdAt                DateTime  @default(now()) @map("created_at")
  consumedAt               DateTime? @map("consumed_at")
  expiresAt                DateTime  @map("expires_at")                    // createdAt + 7 days

  @@index([userId, status])
  @@index([expiresAt])
  @@map("pending_installs")
}

model CatalogState {
  id              String   @id                                              // "verified-singleton" | "community-singleton"
  channel         String   @unique
  lastSyncedSha   String   @map("last_synced_sha")
  lastSyncedAt    DateTime @map("last_synced_at")
  appCount        Int      @default(0) @map("app_count")

  @@map("catalog_state")
}
```

**Notes on the schema** (load-bearing decisions):

- `framework` is a **scalar `String?`** — single value per app. `architectures` is `String[]` — multiple values. The user explicitly flagged this distinction; do not over-generalize. Spec §5.1 confirms.
- `App.slug` is `@unique` (singular slug across both channels in v1). `channel` differentiates Community apps from Verified — but the slug namespace is shared. Phase 3's Community channel will need either slug-prefix conventions or a composite `(slug, channel)` unique key; for v1 with only `verified` populated, `@unique slug` is correct.
- `App.deletedAt` is the soft-delete sentinel. Sync sets it; never hard-deletes. PendingInstalls reference apps by slug, and `onDelete: Cascade` would still hard-delete pending installs — but we never hard-delete apps in v1, so the cascade is dormant. Leave as-is.
- `PendingInstall.expiresAt` indexed for the cleanup cron (PR 0.11).
- `CatalogState.id` is a deterministic singleton key per channel so upserts are race-safe (`upsert(where: {id: 'verified-singleton'}, ...)`).

### `src/db/index.ts` rewrite

```typescript
import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { Pool } from "@neondatabase/serverless";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

function makePrisma(): PrismaClient {
  // In production (Vercel serverless), use the Neon adapter — pooled, WebSocket-driver,
  // no per-invocation connection exhaustion.
  // In local development, the adapter is fine too; DATABASE_URL just needs to be a
  // Neon pooled URL.
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaNeon(pool);
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? makePrisma();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
```

### Tests

A single integration test in `tests/db.test.ts` (or a TypeScript script in a `prisma/seed-check.ts`) that:

1. Runs `prisma migrate deploy` against a test DB.
2. Inserts a sample `App` row, asserts unique-slug constraint, asserts `architectures` defaults to `["arm64", "x86_64"]`.
3. Inserts a `PendingInstall`, asserts cascade on `App` soft-delete (deletedAt set, PendingInstall remains valid until `expiresAt`).
4. Asserts `CatalogState.id` upsert by deterministic key works.

The simplest reliable harness is a `vitest` (not currently in the repo) or a Node script run via `tsx`. Vitest adds dev dep weight; for Phase 0 the recommended path is a single `prisma/migration-smoke.ts` script invoked manually before deploy.

### Acceptance criteria

- `npx prisma migrate deploy` against the production Neon URL succeeds.
- `npx prisma studio` against the same URL shows three new tables: `apps`, `pending_installs`, `catalog_state`.
- `prisma db pull` round-trip against the deployed schema produces the same `schema.prisma` (no drift).
- `src/app/api/account/route.ts` (existing route) still works — adapter wiring doesn't break the existing User reads.

### Environment variables

| Name | Where | Purpose |
|---|---|---|
| `DATABASE_URL` | Vercel + local | Neon **pooled** connection string. |
| `DIRECT_URL` | Vercel + local | Neon **unpooled** direct URL — used only by `prisma migrate`, not at runtime. |

Both are already issued by Neon when you provision a database; the existing `DATABASE_URL` may be either pooled or unpooled — confirm in the dev's Neon console before running `migrate deploy`.

### Deployment notes

- Vercel: function bundle size is fine; `@prisma/adapter-neon` + `@neondatabase/serverless` are already installed.
- Neon: free tier is fine for Phase 0 traffic.
- Migrations run via `npx prisma migrate deploy` as part of Vercel's build step. Add a `vercel-build` script: `"vercel-build": "prisma migrate deploy && next build"`. (PR 0.8 adds the cron config to `vercel.json`; this script change can land in 0.7 or 0.8.)

### Dependencies

None within Phase 0. (Foundational for 0.8, 0.9, 0.10, 0.11.)

### Open sub-questions

- Whether to add `App.tags String[]` for free-form keyword search beyond `category`. Recommendation: **defer** — `category` + `description` (full-text searchable on the client via minisearch) are enough for v1 with ≤50 apps. Add `tags` if the catalog grows past ~100 apps.

---

## PR 0.8 — Sync endpoint + cron + HMAC + tag-resolve + asset URL pinning

### Goal

A single Next.js Route Handler that ingests the catalog repo's state into Postgres. Triggered two ways: **GitHub webhook** on `push` to `main` (HMAC-signed, primary) and **Vercel Cron** every 30 minutes (Bearer-token-authed, safety net for missed webhooks).

### Files to create / modify

- `src/app/api/internal/catalog/sync/route.ts` — the route handler (GET handler accepts cron, POST accepts webhook).
- `src/lib/catalog-sync.ts` — the core sync logic, framework-agnostic.
- `src/lib/hmac.ts` — small timing-safe HMAC verifier.
- `src/lib/github.ts` — thin wrappers over the GitHub Trees / Contents / Commits APIs with rate-limit handling.
- `vercel.json` — new file with cron config.
- `package.json` — add `js-yaml` (manifest parsing) and `ajv` + `ajv-formats` (server-side schema validation). Already-installed `@prisma/client` + `@neondatabase/serverless` carry through.
- `.env.local.example` — document new env vars.

### Route signature (`src/app/api/internal/catalog/sync/route.ts`)

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { syncCatalog, SyncTrigger } from '@/lib/catalog-sync';
import { verifyGithubWebhook } from '@/lib/hmac';

export const runtime = 'nodejs';     // Edge can't run Prisma+Neon adapter; pin to Node.
export const maxDuration = 60;       // Vercel hobby tier max; Pro allows 300s if catalog grows.

// Webhook entry: GitHub push event signed with X-Hub-Signature-256.
export async function POST(req: NextRequest) {
  const raw = await req.text();
  const signature = req.headers.get('x-hub-signature-256');
  if (!signature) {
    return NextResponse.json({ error: 'missing signature' }, { status: 401 });
  }
  if (!verifyGithubWebhook(raw, signature, process.env.CATALOG_WEBHOOK_SECRET!)) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }

  // GitHub push event payload — we only care that *something* changed under the catalog repo.
  const event = req.headers.get('x-github-event');
  if (event === 'ping') return NextResponse.json({ ok: true, ping: true });
  if (event !== 'push') return NextResponse.json({ ok: true, ignored: event });

  const payload = JSON.parse(raw);
  if (payload.ref !== 'refs/heads/main') {
    return NextResponse.json({ ok: true, ignored: payload.ref });
  }

  const result = await syncCatalog({
    trigger:        SyncTrigger.Webhook,
    forceFullScan:  false,
    catalogHeadSha: payload.after,            // commit SHA of the catalog after the push
  });

  return NextResponse.json(result);
}

// Cron entry: Vercel Cron sends GET with Authorization: Bearer $CRON_SECRET.
export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const result = await syncCatalog({
    trigger:       SyncTrigger.Cron,
    forceFullScan: false,
  });

  return NextResponse.json(result);
}
```

### Sync core (`src/lib/catalog-sync.ts`) behavior

`syncCatalog({ trigger, forceFullScan, catalogHeadSha? })` returns `{ synced: number, added: number, updated: number, removed: number, alarms: Alarm[] }`. Concrete steps:

1. **Resolve current catalog HEAD SHA.** If `catalogHeadSha` was passed (from webhook payload), use it. Otherwise (cron), call `GET https://api.github.com/repos/os8ai/os8-catalog/branches/main` and read `commit.sha`.
2. **Read prior state.** `await prisma.catalogState.findUnique({ where: { id: 'verified-singleton' } })`. If absent (first run), treat `lastSyncedSha = ''` and force full scan.
3. **Determine changed manifests.**
   - If `forceFullScan || prior.lastSyncedSha === ''`: list all `apps/*/manifest.yaml` via `GET /repos/os8ai/os8-catalog/git/trees/{currentCatalogHead}?recursive=1`.
   - Else: `GET /repos/os8ai/os8-catalog/compare/{lastSyncedSha}...{currentCatalogHead}` and read `files[].filename` filtered to `apps/*/manifest.yaml`.
4. **For each changed manifest:**
   1. Fetch its YAML content via `GET /repos/os8ai/os8-catalog/contents/{path}?ref={currentCatalogHead}` (or via the trees blob lookup for efficiency).
   2. Parse with `js-yaml.load()` (safe variant; `loadAll` forbidden).
   3. Validate against `appspec-v1.json` via ajv. If invalid → log alarm, skip this manifest.
   4. Compute `manifestSha = sha256_hex(rawYamlContent)`.
   5. Resolve `upstream.ref` to a commit SHA via `GET /repos/{owner}/{repo}/commits/{ref}` (auto-dereferences annotated tags). Validate the result matches `^[0-9a-f]{40}$`. On 404 → alarm + skip.
   6. **Asset URL pinning:** rewrite `manifest.icon` (e.g. `./icon.png`) and each `manifest.screenshots[i]` from relative to absolute, pinned to the catalog commit SHA:
      ```
      iconUrl = `https://raw.githubusercontent.com/os8ai/os8-catalog/${currentCatalogHead}/apps/${slug}/${stripDotSlash(manifest.icon)}`
      ```
      Same shape for screenshots. Store in `App.iconUrl` and `App.screenshots[]`. The raw `manifestYaml` field stores the original (unrewritten) text.
   7. **Idempotency check:** read existing `App` by slug. If `existing && existing.manifestSha === manifestSha && existing.catalogCommitSha === currentCatalogHead`, skip (no-op, no DB write).
   8. **Tag-mutation alarm:**
      - If `existing && existing.manifestSha === manifestSha && existing.upstreamResolvedCommit !== resolvedCommit`: this is the supply-chain alarm. The manifest YAML did not change, but the tag now points to a different commit than the prior sync. Action:
        - Append to `result.alarms`: `{ kind: 'tag_mutation', slug, prior: existing.upstreamResolvedCommit, current: resolvedCommit, manifestSha }`.
        - Soft-delete: `App.update({ where: { slug }, data: { deletedAt: new Date() } })`.
        - Do **not** upsert the new commit — block new installs until a curator opens a fresh PR with an explicit tag bump (which changes `manifestSha` and clears the alarm path).
        - Log to console.error with severity tag for log-aggregation alerts. (Email/Slack notification deferred — Phase 0 keeps the alert pipeline local; v1 add a webhook to a curator Slack channel.)
      - Continue to next manifest.
   9. **Upsert.** `App.upsert({ where: { slug }, create: {...}, update: {...} })` with all fields populated. Set `publishedAt = existing?.publishedAt ?? new Date()` (preserve original publish date on updates), `syncedAt = new Date()`, `updatedAt = new Date()` (Prisma auto-handles `@updatedAt`).
5. **Soft-delete removed manifests.** Compute the set of slugs in the current catalog tree; any `App` row not in that set (and `deletedAt` null) → set `deletedAt = now()`. Soft-delete only; never hard-delete.
6. **Update `CatalogState`.** `prisma.catalogState.upsert({ where: { id: 'verified-singleton' }, create: {...}, update: { lastSyncedSha: currentCatalogHead, lastSyncedAt: new Date(), appCount: <count> } })`.
7. **Return `{ synced, added, updated, removed, alarms }`.**

### HMAC verification (`src/lib/hmac.ts`)

```typescript
import crypto from 'node:crypto';

export function verifyGithubWebhook(rawBody: string, header: string, secret: string): boolean {
  // header shape: "sha256=<64-hex>"
  if (!header.startsWith('sha256=')) return false;

  const provided = Buffer.from(header.slice('sha256='.length), 'hex');
  if (provided.length !== 32) return false;            // SHA-256 = 32 bytes

  const computed = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest();

  // crypto.timingSafeEqual throws on length mismatch — guard above prevents that.
  return crypto.timingSafeEqual(provided, computed);
}
```

The cron path uses a **separate** `Authorization: Bearer $CRON_SECRET` token (Vercel's standard cron auth), not HMAC. GitHub HMAC is for GitHub's signature only; conflating the two would force the cron to compute an HMAC over a synthetic payload, which adds no security. (User confirmed this approach.)

### GitHub API rate-limit handling (`src/lib/github.ts`)

- All requests carry `Authorization: Bearer ${GITHUB_TOKEN}` and `Accept: application/vnd.github+json`.
- Read `X-RateLimit-Remaining` from each response.
- If response is 403 with body `"X-RateLimit-Remaining: 0"`, parse `X-RateLimit-Reset` (Unix seconds) and `await sleep(reset - now + 1)` then retry once. Beyond that, throw — the sync run will fail and the cron will retry in 30 min.
- If response is 5xx, retry with exponential backoff (3 attempts, 500ms / 2s / 8s).
- Use the GitHub Contents API for individual blobs <1MB; for larger payloads use the Trees+Blobs path. Most manifests are <10KB so Contents is fine.

### Edge cases

| Case | Handling |
|---|---|
| Manifest YAML is malformed | ajv fails → alarm `{ kind: 'invalid_yaml', slug, error }` → skip; do not soft-delete the existing row (transient parse error shouldn't take down a known-good app). |
| Tag points to a deleted ref upstream | `GET /commits/{ref}` returns 404 → alarm `{ kind: 'upstream_ref_404', slug, ref }` → skip; do not soft-delete on first occurrence; if same alarm fires 3 times in a row (track in CatalogState? — too heavy for v1; simpler: log only). |
| Asset file (icon.png) referenced by manifest doesn't exist in the catalog at the pinned SHA | The asset URL is rewritten optimistically; the catalog repo's `validate.yml` (PR 0.2) already enforces presence at PR-merge time, so this can only happen if the catalog was edited out-of-band (force-pushed). Acceptable to leave the dead URL in place and surface a 404 to users; sync doesn't re-validate asset existence. |
| Webhook delivers a `push` for a force-push that rewrote history | `payload.after` is the new tip; sync pulls compare against `lastSyncedSha` which may now be unreachable from the new history. `GET /compare/{base}...{head}` will return 404. Fall back to a full scan of the new tip; log a `force_push_detected` alarm. |
| Two webhooks fire concurrently (two PRs merged seconds apart) | Sync is idempotent at the manifest-sha level; the second run sees the first run's writes and only processes new diffs. Use `prisma.$transaction([...])` for the App upserts within a single sync run, but **don't** wrap the whole sync in a single transaction (it'd block long-running GitHub fetches). The CatalogState upsert is the last write — slight race window where two concurrent runs each do most of the work and both write CatalogState; acceptable. |
| Rate limit on GitHub raw URLs from end-user browsers | Tracked separately — see "Asset CDN rate limits" below. |

### `vercel.json`

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "crons": [
    {
      "path": "/api/internal/catalog/sync",
      "schedule": "*/30 * * * *"
    }
  ]
}
```

Vercel's cron runs hit the GET path with `Authorization: Bearer ${CRON_SECRET}` automatically when `CRON_SECRET` is set in env vars.

### Environment variables (Phase 0 introduces these on os8.ai)

| Name | Where | Purpose |
|---|---|---|
| `CATALOG_WEBHOOK_SECRET` | Vercel | HMAC secret shared with the catalog repo's webhook config. 32-byte random; rotate via Vercel UI. |
| `CRON_SECRET` | Vercel | Bearer token Vercel injects on cron-triggered requests. Set to a 32-byte random; Vercel docs: https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs. |
| `GITHUB_TOKEN` | Vercel | Fine-grained PAT (read-only public repo access; OK to use a no-scopes token for public-repo reads — the GitHub API gives 5000 req/h authenticated vs 60 req/h anonymous). Owner: a service account, not a person. |

On the **`os8ai/os8-catalog` repo's GitHub Settings → Webhooks** (manual one-time setup, documented in PR 0.8 README):

| Webhook setting | Value |
|---|---|
| Payload URL | `https://os8.ai/api/internal/catalog/sync` |
| Content type | `application/json` |
| Secret | (matches `CATALOG_WEBHOOK_SECRET`) |
| Events | Push events only |
| Active | yes |

### Tests

Three test fixtures land in `tests/catalog-sync.test.ts` (vitest or a node-test script):

| Fixture | Setup | Assertion |
|---|---|---|
| `fresh_install_one_manifest` | Empty DB; mock GitHub API returns one valid manifest | After sync: 1 App row, `manifestSha` matches, `iconUrl` starts with `https://raw.githubusercontent.com/os8ai/os8-catalog/<currentHead>/apps/`, CatalogState updated. |
| `idempotent_re_sync` | DB has the manifest; mock GitHub returns identical state | After sync: 0 writes (no Prisma operations beyond reads), result `{ synced: 1, added: 0, updated: 0, removed: 0 }`. |
| `tag_mutation_alarm` | DB has the manifest with `upstreamResolvedCommit = AAA`; mock GitHub returns same `manifestSha` but `commits/{ref}` resolves to `BBB` | App soft-deleted, alarm logged with kind `tag_mutation`. |
| `manifest_removed` | DB has app `foo`; current catalog tree has no `apps/foo/manifest.yaml` | `App.foo.deletedAt` set; `App.foo` row not removed. |
| `bad_hmac` | POST to /api/internal/catalog/sync with `X-Hub-Signature-256: sha256=000...` | 401, no DB writes. |
| `cron_no_token` | GET /api/internal/catalog/sync with no `Authorization` header | 401. |
| `cron_with_token` | GET with `Authorization: Bearer <CRON_SECRET>` | 200, sync runs. |

### Acceptance criteria

- `curl -X POST https://os8.ai/api/internal/catalog/sync -H 'X-Hub-Signature-256: sha256=...' -d '<push_payload>'` with a valid signature inserts/updates apps.
- After the worldmonitor PR (PR 0.5) merges in `os8ai/os8-catalog`, the webhook fires and within ~30s `prisma.app.findUnique({ where: { slug: 'worldmonitor' } })` returns a row with `iconUrl = https://raw.githubusercontent.com/os8ai/os8-catalog/<merge-commit>/apps/worldmonitor/icon.png`.
- A second push to the catalog that touches only README files (no manifests) fires the webhook; sync sees no changed manifests; CatalogState is updated; no App rows are touched.
- Vercel cron logs show 200 responses every 30 minutes.

### Deployment notes

- Pin runtime to `nodejs` (not Edge) — Prisma+Neon adapter requires Node.
- `maxDuration: 60` is enough for ≤50 apps; if the catalog grows past ~200 apps, bump to Pro tier (300s) or split sync into batches.
- Prisma+Neon connection pooling: with the adapter wired in PR 0.7, each serverless invocation reuses the pool; no extra config here.
- The webhook payload body MUST be read raw before JSON-parsing (HMAC verification is over raw bytes). The route handler does this with `req.text()` then `JSON.parse(raw)`.

### Asset CDN rate limits (resolves spec §11.8 / decision Q8)

GitHub raw URLs (`raw.githubusercontent.com`) impose rate limits ~5000 req/h per IP for unauthenticated reads, with caching behavior subject to GitHub's CDN. Phase 0 watches via:

- Vercel function logs for upstream 429s in any code path that fetches raw URLs (the sync uses Trees / Contents API, not raw — but the `/apps` page links direct to raw URLs from the user's browser).
- An optional per-deployment counter in CatalogState (e.g. `assetRequestCount` — defer; not urgent for v1).

**Migration trigger:** when GitHub raw 429s start showing in a non-trivial fraction of users' browser DevTools Network tabs (anecdotal threshold; instrument in v2 with Real User Monitoring), or when GitHub's rate-limit-reduction emails arrive at the org owner. Mitigation: add a `vercel.json` route that proxies + caches `https://os8.ai/api/cdn/{slug}/{file}` → raw URL with `Cache-Control: public, max-age=86400, immutable` (the URL is pinned to a commit SHA, so immutable is correct). Switch `App.iconUrl` to point through the proxy at sync time. One-line URL rewrite in the sync core; no DB migration.

### Dependencies

PR 0.7 (Prisma schema), PR 0.1 (catalog schema for ajv).

### Open sub-questions

None at the contract level. Operationally: the webhook secret rotation runbook (how often, who) is a v1.5 operational doc, not a code question.

---

## PR 0.9 — `/apps` browse page + JSON listing API

### Goal

Server-rendered Next.js page at `/apps` that lists all non-deleted apps with category / channel / framework filters and full-text search. Plus a public JSON listing at `/api/apps` for Phase 1 desktop consumption (spec §5.2).

### Files to create / modify

- `src/app/apps/page.tsx` — server component, ISR.
- `src/app/apps/AppGrid.tsx` — client component, renders cards from props.
- `src/app/apps/SearchFilter.tsx` — client component, owns search input + filter pills, syncs to URL via `useSearchParams`.
- `src/lib/apps-query.ts` — server-side Prisma query helpers.
- `src/app/apps/loading.tsx` — Suspense fallback skeleton.
- `src/app/apps/page.module.css` (or Tailwind classes — inspect existing styles).
- `src/app/api/apps/route.ts` — GET, returns JSON listing. Public, no auth. Cached at the CDN layer (`Cache-Control: public, s-maxage=60, stale-while-revalidate=300`).

### Data fetching shape

```typescript
// src/app/apps/page.tsx
import { prisma } from '@/db';
import { AppGrid } from './AppGrid';
import { SearchFilter } from './SearchFilter';

export const revalidate = 60;        // ISR: 60s; can drop to 30 if sync cadence demands

type SearchParams = {
  channel?: string;
  category?: string;
  framework?: string;
  q?: string;
};

export default async function AppsPage({
  searchParams
}: {
  searchParams: Promise<SearchParams>
}) {
  const sp = await searchParams;

  // Always fetch the full set; client filters in-memory via minisearch.
  // For ≤500 apps this is fine; beyond that, paginate server-side.
  const apps = await prisma.app.findMany({
    where: {
      deletedAt: null,
      channel: 'verified',                  // v1: only verified visible
    },
    orderBy: { publishedAt: 'desc' },
    select: {
      id: true, slug: true, name: true, description: true, publisher: true,
      category: true, channel: true, framework: true, iconUrl: true,
      installCount: true, riskLevel: true, publishedAt: true,
    }
  });

  const categories  = [...new Set(apps.map(a => a.category))].sort();
  const frameworks  = [...new Set(apps.map(a => a.framework).filter(Boolean))] as string[];

  return (
    <main className="…">
      <SearchFilter
        initial={sp}
        categories={categories}
        frameworks={frameworks}
      />
      <AppGrid apps={apps} initial={sp} />
    </main>
  );
}
```

### `GET /api/apps` (JSON listing)

Phase 1 PR 1.3 (`AppCatalogService.sync` on the desktop) consumes this. Contract:

```typescript
// src/app/api/apps/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/db';

export const revalidate = 60;

type Query = { channel?: string; category?: string; framework?: string; q?: string };

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const channel   = sp.get('channel')   ?? 'verified';
  const category  = sp.get('category')  ?? undefined;
  const framework = sp.get('framework') ?? undefined;
  const q         = sp.get('q')         ?? undefined;

  const apps = await prisma.app.findMany({
    where: {
      deletedAt: null,
      channel,
      ...(category  ? { category }                                   : {}),
      ...(framework ? { framework }                                  : {}),
      ...(q         ? {
        OR: [
          { name:        { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
          { publisher:   { contains: q, mode: 'insensitive' } },
        ]
      } : {}),
    },
    orderBy: { publishedAt: 'desc' },
    select: {
      slug: true, name: true, description: true, publisher: true, channel: true,
      category: true, framework: true, iconUrl: true, screenshots: true,
      license: true, runtimeKind: true, architectures: true, riskLevel: true,
      installCount: true, manifestSha: true, catalogCommitSha: true,
      upstreamDeclaredRef: true, upstreamResolvedCommit: true,
      publishedAt: true, syncedAt: true,
    },
  });

  return NextResponse.json({ apps }, {
    headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' }
  });
}
```

Note: `manifestYaml` is **not** in the listing payload (it'd bloat the response). Detail endpoint (PR 0.10) returns it.

### Search index (client-side)

Build the minisearch index in `AppGrid.tsx` once on mount (matches the existing pattern in `src/app/elon-graph/components/Search.tsx`):

```typescript
const index = useMemo(() => {
  const ms = new MiniSearch<App>({
    fields: ['name', 'description', 'publisher', 'category', 'framework'],
    storeFields: ['id', 'slug', 'name', 'description', 'publisher', 'category',
                  'channel', 'framework', 'iconUrl', 'installCount', 'riskLevel'],
    searchOptions: { boost: { name: 3, publisher: 2, description: 1 }, prefix: true, fuzzy: 0.2 }
  });
  ms.addAll(apps);
  return ms;
}, [apps]);
```

For ≤200 apps the index builds in <50ms client-side; no server prebuild needed. If catalog grows past ~500 apps, ship a precomputed `/apps/search-index.json` from a sync-time post-step.

### Filter URL state

Filters live in URL query string so links are shareable:

- `?category=intelligence` — single category pill
- `?framework=vite&category=intelligence` — multiple
- `?q=worldmonitor` — search query
- `?channel=community` — Phase 3 only

`SearchFilter.tsx` reads via `useSearchParams()`, writes via `router.replace()` (no scroll, no history spam). Apply filters client-side over the already-fetched `apps` array.

### Card layout

Per app card:
- Icon (lazy-loaded `<Image src={app.iconUrl} width={64} height={64} unoptimized />` — `unoptimized` because the URL is already a CDN-pinned commit SHA; running Next/Image's optimizer on it adds latency for no benefit).
- Name (h3).
- Publisher (small, dim).
- Single-line description (truncated with `line-clamp-2`).
- Category pill.
- Framework badge (if set).
- Install count (small, "↓ 12").

Card click → `<Link href={\`/apps/${app.slug}\`}>` — Next handles navigation.

### Empty / loading states

- Loading: `loading.tsx` shows a 6-card skeleton grid.
- Empty (no apps in DB): "Catalog is being populated. Check back soon."
- Filter-empty (filters too narrow): "No matches for \<query\>. Try fewer filters."

### Tests

- `tests/apps-page.test.ts` (Playwright, against a local Vercel dev): visits `/apps`, asserts ≥5 cards rendered (after PR 0.6 lands), filters to `?category=intelligence`, asserts only worldmonitor visible.
- Snapshot test on `AppGrid.tsx` with mock data.

### Acceptance criteria

- `https://os8.ai/apps` loads in <500ms first byte (ISR cached).
- Filtering by category updates the URL and the visible cards in <100ms (client-side).
- Search "world" surfaces worldmonitor; clicking the card navigates to `/apps/worldmonitor`.
- Page renders correctly with 0 apps in DB (graceful empty state).

### Environment variables

None new.

### Deployment notes

- ISR with `revalidate = 60` is the default. Watch Vercel cache hit ratio after first deploy; if stale-revalidation lag exceeds 2 min, drop to 30 (plan §10 Q2).
- `unoptimized` images bypass Next/Image optimization; the alternative (proxy through Vercel's image CDN) costs imageoptim invocations per app per ISR refresh — not worth it for fixed-size 64x64 icons. Keep `unoptimized`.

### Dependencies

PR 0.7 (App rows must exist), PR 0.6 (need ≥5 apps for a real grid).

### Open sub-questions

None.

---

## PR 0.10 — `/apps/[slug]` detail page + JSON detail API

### Goal

Per-app detail: screenshots carousel, README rendering, license, manifest commit SHA, source repo link, install count, install button. Plus a JSON detail endpoint at `/api/apps/[slug]` (spec §5.2) — Phase 1 PR 1.3 calls this when re-fetching a single manifest.

### Files to create / modify

- `src/app/apps/[slug]/page.tsx` — server component, ISR.
- `src/app/apps/[slug]/Screenshots.tsx` — client component, embla-carousel.
- `src/app/apps/[slug]/InstallButton.tsx` — client component (extended in PR 0.11).
- `src/app/apps/[slug]/Sidebar.tsx` — server component, license / SHA / repo link / install count.
- `src/lib/markdown.ts` — minimal markdown renderer.
- `src/app/apps/[slug]/loading.tsx` — Suspense fallback.
- `src/app/api/apps/[slug]/route.ts` — GET, JSON detail (includes `manifestYaml`).
- `package.json` — add `embla-carousel-react`, `marked` (markdown renderer), `isomorphic-dompurify`.

### Data fetching

```typescript
// src/app/apps/[slug]/page.tsx
import { notFound } from 'next/navigation';
import { prisma } from '@/db';

export const revalidate = 60;

export async function generateStaticParams() {
  // Pre-render all known apps at build time; ISR fills in new ones.
  const apps = await prisma.app.findMany({
    where: { deletedAt: null, channel: 'verified' },
    select: { slug: true }
  });
  return apps.map(a => ({ slug: a.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const app = await prisma.app.findUnique({ where: { slug } });
  if (!app) return {};
  return {
    title: `${app.name} — OS8 Apps`,
    description: app.description,
    openGraph: { images: [app.iconUrl] }
  };
}

export default async function AppDetailPage({
  params
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params;
  const app = await prisma.app.findUnique({
    where: { slug, deletedAt: null }
  });
  if (!app) notFound();

  // Fetch the app's README from the catalog (pinned to the catalog commit SHA).
  const readmeUrl = `https://raw.githubusercontent.com/os8ai/os8-catalog/${app.catalogCommitSha}/apps/${app.slug}/README.md`;
  const readmeRes = await fetch(readmeUrl, { next: { revalidate: 3600 } });
  const readmeMd = readmeRes.ok ? await readmeRes.text() : '';

  return (
    <main>
      <header>{/* icon, name, publisher, channel badge */}</header>
      <Screenshots urls={app.screenshots} />
      <article>{/* description + rendered README */}</article>
      <Sidebar app={app} />
      <InstallButton slug={app.slug} commit={app.upstreamResolvedCommit} channel={app.channel} />
    </main>
  );
}
```

### Screenshot carousel choice

`embla-carousel-react`. Reasons:
- 8KB gzipped, no peer-dep heaviness.
- Server-render the first slide, hydrate the rest — no layout shift.
- Works without JS for the first image (graceful degradation).

Alternatives considered: `swiper` (heavier, 60KB), `react-responsive-carousel` (older, less maintained), pure-CSS scroll-snap (no autoplay, no nav buttons — fine but more bespoke). Embla is the right balance for v1.

### Markdown rendering

`marked` with `gfm: true, breaks: false`. Sanitize via `dompurify` before injecting? **Yes** — README is from a third-party repo (the manifest publisher), so render to HTML then sanitize. Add `isomorphic-dompurify` or run `marked` then `DOMPurify.sanitize()` server-side via `jsdom`.

Recommendation: use `marked` for parse, `isomorphic-dompurify` for sanitize (works in both server and client). Add both to `dependencies`.

```typescript
// src/lib/markdown.ts
import { marked } from 'marked';
import DOMPurify from 'isomorphic-dompurify';

marked.setOptions({ gfm: true, breaks: false });

export async function renderMarkdown(md: string): Promise<string> {
  const html = await marked.parse(md);
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'h1', 'h2', 'h3', 'h4', 'a', 'ul', 'ol', 'li', 'code',
                   'pre', 'em', 'strong', 'blockquote', 'hr', 'br', 'img', 'table',
                   'thead', 'tbody', 'tr', 'th', 'td'],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'rel'],
    ALLOW_DATA_ATTR: false,
  });
}
```

### `GET /api/apps/[slug]` (JSON detail)

```typescript
// src/app/api/apps/[slug]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/db';

export const revalidate = 60;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const app = await prisma.app.findUnique({
    where: { slug, deletedAt: null },
    // Full payload — Phase 1 desktop sync needs `manifestYaml`.
    omit: { id: true, deletedAt: true },
  });
  if (!app) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return NextResponse.json({ app }, {
    headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' }
  });
}
```

### Sidebar contents

- **License** — `legal.license` (parsed from manifest YAML once at sync time? Or re-parse here? Re-parse is fine — manifestYaml is stored).
- **Architectures** — `arm64`, `x86_64` badges.
- **Framework** — pill.
- **Manifest commit** — link to `https://github.com/os8ai/os8-catalog/commit/${app.catalogCommitSha}` (the catalog commit, not the upstream commit).
- **Source repo** — link to upstream parsed from `manifest.upstream.git`.
- **Upstream commit** — link to `https://github.com/{owner}/{repo}/commit/${app.upstreamResolvedCommit}` truncated to 8 chars.
- **Install count** — `↓ ${app.installCount.toLocaleString()}`.
- **Risk level** — colored pill (`low` green, `medium` yellow, `high` red).

### Tests

- Playwright: visit `/apps/worldmonitor` after PR 0.5 lands, assert page loads with title, screenshots, README content.
- Snapshot: `Sidebar.tsx` with mock app data.
- 404: `/apps/nonexistent` returns 404.

### Acceptance criteria

- `https://os8.ai/apps/worldmonitor` renders with screenshots, README, sidebar.
- Soft-deleted apps return 404 (not stale-but-cached).
- ISR refreshes within 60s of a sync update.

### Environment variables

None new.

### Deployment notes

- `generateStaticParams` produces a pre-rendered set at deploy; new apps published via sync get rendered on first hit then cached for 60s. Watch for cold-start latency on the first visit to a new slug.
- README fetch is cached at `next: { revalidate: 3600 }` — 1 hour. Acceptable since README only changes when a new manifest version syncs.

### Dependencies

PR 0.7, PR 0.5 (need at least one app for visual confirmation).

### Open sub-questions

None.

---

## PR 0.11 — Install button + track-install + pending-installs + protocol fallback

### Goal

The install button on the detail page wires up four flows: (a) emit `os8://install` deeplink (always); (b) for signed-in users, also create a `PendingInstall` row; (c) increment `App.installCount` (anonymous OK, rate-limited per IP/day); (d) graceful fallback widget for users whose OS8 install hasn't registered the protocol handler yet.

### Files to create / modify

- **Modify** `src/app/apps/[slug]/InstallButton.tsx` (created in PR 0.10, extended here).
- **Create** `src/app/api/apps/[slug]/install/route.ts` — POST creates PendingInstall for signed-in users.
- **Create** `src/app/api/apps/[slug]/track-install/route.ts` — POST increments installCount, IP-rate-limited.
- **Create** `src/app/api/account/pending-installs/route.ts` — GET lists current user's pending installs.
- **Create** `src/app/api/account/pending-installs/[id]/consume/route.ts` — POST marks consumed (called by desktop after successful install).
- **Create** `src/lib/rate-limit.ts` — small Upstash-Redis-backed sliding-window limiter.
- **Modify** `package.json` — add `@upstash/redis` and `@upstash/ratelimit`.
- **Modify** `.env.local.example` — document new env vars.

### `InstallButton.tsx` shape

```typescript
'use client';
import { useState } from 'react';
import { useSession } from 'next-auth/react';

export function InstallButton({ slug, commit, channel }: {
  slug: string; commit: string; channel: string;
}) {
  const { data: session } = useSession();
  const [showFallback, setShowFallback] = useState(false);

  const deeplink = `os8://install?slug=${encodeURIComponent(slug)}`
                 + `&commit=${encodeURIComponent(commit)}`
                 + `&channel=${encodeURIComponent(channel)}`
                 + `&source=os8.ai`;

  async function handleClick() {
    // 1. For signed-in users, queue PendingInstall (cross-device install).
    if (session?.user?.os8UserId) {
      // Fire-and-forget — failure here doesn't block the deeplink.
      fetch(`/api/apps/${slug}/install`, { method: 'POST' })
        .catch(err => console.warn('PendingInstall queue failed:', err));
    }

    // 2. Increment install count (anonymous OK).
    fetch(`/api/apps/${slug}/track-install`, { method: 'POST' })
      .catch(err => console.warn('track-install failed:', err));

    // 3. Trigger the deeplink. Use <a href> with click() — more reliable than location.href.
    const a = document.createElement('a');
    a.href = deeplink;
    a.click();
  }

  return (
    <div>
      <button className="…" onClick={handleClick}>Install in OS8</button>

      <details className="mt-3 text-sm" onToggle={(e) => setShowFallback((e.target as HTMLDetailsElement).open)}>
        <summary className="cursor-pointer text-white/60 hover:text-white">
          OS8 not opening?
        </summary>
        <div className="mt-2 p-3 bg-charcoal/50 rounded">
          <p className="mb-2 text-white/70">
            Copy this commit hash and install via the OS8 catalog browser:
          </p>
          <code className="block break-all bg-black/30 p-2 rounded text-cyan">{commit}</code>
          <button onClick={() => navigator.clipboard.writeText(commit)}
                  className="mt-2 text-xs text-cyan hover:underline">
            Copy
          </button>
          <p className="mt-3 text-xs text-white/50">
            Don't have OS8? <a href="/#download" className="text-cyan underline">Download</a>
          </p>
        </div>
      </details>
    </div>
  );
}
```

The `<details>` widget is always present, low-visibility unless the user clicks it. No JS detection of registration success/failure (unreliable cross-browser, and Linux AppImage installs intentionally skip protocol registration unless the user accepts a first-run prompt — see Phase 1 PR 1.2).

### `POST /api/apps/[slug]/install` (signed-in PendingInstall)

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { prisma } from '@/db';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const session = await auth();
  if (!session?.user?.os8UserId) {
    // Anonymous: deeplink does the work; this endpoint no-ops with 200.
    return NextResponse.json({ ok: true, anonymous: true });
  }

  const { slug } = await params;
  const app = await prisma.app.findUnique({
    where: { slug, deletedAt: null },
    select: { slug: true, channel: true, upstreamResolvedCommit: true }
  });
  if (!app) {
    return NextResponse.json({ error: 'app not found' }, { status: 404 });
  }

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);   // 7 days
  const pending = await prisma.pendingInstall.create({
    data: {
      userId: session.user.os8UserId,
      appSlug: app.slug,
      upstreamResolvedCommit: app.upstreamResolvedCommit,
      channel: app.channel,
      expiresAt,
    }
  });

  return NextResponse.json({ ok: true, pendingInstallId: pending.id });
}
```

### `POST /api/apps/[slug]/track-install` (anonymous, rate-limited)

Rate-limit decision: **Vercel KV / Upstash Redis** (`@upstash/ratelimit` + `@upstash/redis`). Justification: in-memory rate limiting on Vercel serverless is broken — each invocation is a fresh process, so a per-instance map sees ~0% of repeat requests. Vercel KV is free for the volumes we'll see in v1 (Upstash free tier covers 10K requests/day). The dependency cost is small (<50KB) and the alternative (no rate limiting) opens us to install-count inflation by anyone who can curl. Spec §11.8 mentions migrating to Vercel KV later if rate limits become a problem; we just do it now since the alternative is genuinely broken.

```typescript
// src/lib/rate-limit.ts
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();      // reads UPSTASH_REDIS_REST_URL / _TOKEN

export const trackInstallLimiter = new Ratelimit({
  redis,
  // 1 increment per IP per app per day. Sliding window prevents calendar-day boundary games.
  limiter: Ratelimit.slidingWindow(1, '1 d'),
  analytics: false,
  prefix: 'rl:track-install',
});
```

```typescript
// src/app/api/apps/[slug]/track-install/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/db';
import { trackInstallLimiter } from '@/lib/rate-limit';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

  const { success } = await trackInstallLimiter.limit(`${slug}:${ip}`);
  if (!success) {
    return NextResponse.json({ ok: true, throttled: true });
  }

  // Atomic increment; misses on soft-deleted apps drop with 404.
  const result = await prisma.app.updateMany({
    where: { slug, deletedAt: null },
    data: { installCount: { increment: 1 } },
  });

  if (result.count === 0) {
    return NextResponse.json({ error: 'app not found' }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
```

### `GET /api/account/pending-installs`

Polled by the desktop on a 60s timer (Phase 1 PR 1.26). Returns the signed-in user's `pending` rows that haven't expired.

```typescript
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { prisma } from '@/db';

export async function GET() {
  const session = await auth();
  if (!session?.user?.os8UserId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const now = new Date();
  const pending = await prisma.pendingInstall.findMany({
    where: {
      userId: session.user.os8UserId,
      status: 'pending',
      expiresAt: { gt: now },
    },
    include: {
      app: {
        select: {
          slug: true, name: true, iconUrl: true,
          publisher: true, channel: true, framework: true,
          riskLevel: true, manifestYaml: true,
        }
      }
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  return NextResponse.json({
    pendingInstalls: pending.map(p => ({
      id:                     p.id,
      appSlug:                p.appSlug,
      app:                    p.app,
      upstreamResolvedCommit: p.upstreamResolvedCommit,
      channel:                p.channel,
      createdAt:              p.createdAt.toISOString(),
      expiresAt:              p.expiresAt.toISOString(),
    }))
  });
}
```

### `POST /api/account/pending-installs/[id]/consume`

```typescript
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { prisma } from '@/db';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.os8UserId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  // Ownership check + status guard in one update.
  const result = await prisma.pendingInstall.updateMany({
    where: {
      id,
      userId: session.user.os8UserId,
      status: 'pending',
    },
    data: { status: 'consumed', consumedAt: new Date() },
  });

  if (result.count === 0) {
    return NextResponse.json({ error: 'not found or already consumed' }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
```

### Pending-install TTL handling

Two paths:
1. **Soft expiry** (read-side): the GET endpoint filters `expiresAt > now`, so expired rows are invisible. No background job required for correctness.
2. **Hard cleanup** (background, optional): a Vercel Cron entry deletes rows where `status = 'pending' AND expiresAt < now() - 30d` (keep 30 days of expired rows for analytics, then delete).

For Phase 0 we ship only the soft expiry. Hard cleanup is a one-line cron addition once the table grows; defer.

### Environment variables (Phase 0 introduces these on os8.ai)

| Name | Where | Purpose |
|---|---|---|
| `UPSTASH_REDIS_REST_URL`   | Vercel | Provided by Vercel KV (or direct Upstash). |
| `UPSTASH_REDIS_REST_TOKEN` | Vercel | Provided by Vercel KV (or direct Upstash). |

### Tests

| Fixture | Assertion |
|---|---|
| Anonymous click on `/apps/worldmonitor` Install button | Deeplink fires; `installCount` increments by 1; first call within window succeeds, second within 24h is throttled (200 with `throttled: true`). |
| Signed-in click | Deeplink fires; `PendingInstall` row created with 7-day TTL; `installCount` increments. |
| `GET /api/account/pending-installs` for user with two pending | Returns both, ordered by createdAt desc. |
| `POST /api/account/pending-installs/<id>/consume` | Status flips to `consumed`, second call returns 404. |
| Track-install for soft-deleted app | 404. |
| Track-install rate-limit | 1st request → installCount + 1; 2nd within 24h → installCount unchanged. |

### Acceptance criteria

- Visiting `/apps/worldmonitor` and clicking Install:
  - Anonymous user: `prisma.app.findUnique({ where: { slug: 'worldmonitor' } }).installCount` increments by 1 (subject to rate limit).
  - Signed-in user: a `PendingInstall` row appears with `status: 'pending'`, `expiresAt = createdAt + 7d`.
- Without OS8 installed, the deeplink fails silently — the `<details>` "OS8 not opening?" widget is the user's escape hatch.
- A second click within 24 hours from the same IP does NOT double-count installCount.

### Deployment notes

- `next-auth` v5 client-side `useSession` requires the `<AuthProvider>` already in `src/app/layout.tsx`. No changes needed.
- The deeplink emission via `<a>.click()` works in all major browsers; Safari may show a permission prompt the first time. That's acceptable.
- Upstash Redis: Vercel's KV product is now Upstash; provision via the Vercel Storage tab in one click.

### Dependencies

PR 0.7 (App + PendingInstall schema), PR 0.10 (`InstallButton.tsx` exists).

### Open sub-questions

None at the contract level.

---

## What Phase 0 leaves behind for Phase 1

After all 11 PRs land, the desktop side has nothing to do yet. The artifacts that Phase 1 will consume:

1. **Stable schema contract:** `appspec-v1.json` is frozen as the source of truth. Phase 1 PR 1.4's manifest validator and PR 1.6's review service consume it.
2. **A populated `App` table + public JSON API:** Phase 1 PR 1.3's `AppCatalogService.sync` calls `GET https://os8.ai/api/apps?channel=verified` (added in PR 0.9) for the listing and `GET https://os8.ai/api/apps/<slug>` (added in PR 0.10) for full detail including `manifestYaml`.
3. **Working `os8://install` deeplinks:** PR 0.11's button emits the canonical URL. Phase 1 PR 1.2 registers the protocol; PR 1.18 wires the parsed URL into the install plan UI.
4. **Cross-device install pipeline:** PR 0.11's `PendingInstall` model and endpoints feed Phase 1 PR 1.26's polling on the desktop.
5. **`allow_package_scripts` on the schema:** Phase 1 PR 1.11's Node adapter consumes this when deciding whether to pass `--ignore-scripts` to the package manager.
6. **Subdomain-mode-only routing baked into the schema:** `surface.base_path_strategy` is intentionally absent. Phase 1 serves every external app at `<slug>.localhost:8888`, so `start.argv` in Phase 0 manifests must NOT include `--base /<slug>/` or equivalent path-prefix flags. Manifest authors target a framework binding at `/`. (See app-store-plan.md §10 decision 11 and spec §1 "Why subdomain mode" for the rationale.)

Phase 0 does **not** require any change to the OS8 desktop codebase. The first desktop PR (Phase 1 PR 1.13) is independently mergeable from any Phase 0 PR; only Phase 1 PR 1.3 has a hard dependency (it consumes os8.ai's catalog API, which means PR 0.7 + 0.8 must be live).

---

*End of phase-0-plan.md.*
