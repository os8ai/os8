# OS8 E2E harness (Playwright + Electron)

Phase 4 PR 4.10. Drives a real OS8 Electron instance via Playwright's
Electron API. Each spec launches into a fresh `OS8_HOME` so runs don't
pollute the developer's `~/os8/` tree.

## Run locally

```bash
npm run test:e2e
```

Linux requires `xvfb` (headless display). On Ubuntu 22.04+:

```bash
sudo apt-get install -y xvfb
xvfb-run -a npm run test:e2e
```

macOS runs against the native window server; no extra setup.
Windows runs are gated behind PR 4.8 (matrix promotion).

## Layout

| File | Purpose |
|------|---------|
| `playwright.config.ts` | Test runner config — serial workers, 120s timeout, retain-on-failure traces |
| `setup.ts` | `bootOs8(opts)` / `closeOs8(booted)` / `getOs8Port(window)` |
| `specs/shell-boot.spec.ts` | OS8 launches; `#appsGrid` renders; clean shutdown |
| `specs/scoped-api.spec.ts` | Origin allowlist behaviors (PR 4.6 gate) |
| `specs/native-app-load.spec.ts` | Native app scaffold + load (skipped until PR 4.6) |

## Adding a spec

1. Drop a `*.spec.ts` under `specs/`.
2. Boot OS8 in `beforeEach`; close in `afterEach`.
3. Drive the renderer via `window.evaluate(...)` or click selectors.
4. Use `getOs8Port(window)` if you need to issue HTTP probes.

## Debugging failures

CI uploads HTML reports + traces to `playwright-report/` on failure.
Open `playwright-report/index.html` for the trace viewer.

## Known scope

Today's harness covers shell boot + scoped-API origin checks. The plan
§PR 4.10 also lists install-flow specs (worldmonitor end-to-end,
dev-import) and a full scoped-API capability call round-trip. Those
land in follow-up PRs once the scaffold is stable on at least
Linux + macOS CI.
