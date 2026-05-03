import { defineConfig } from '@playwright/test';
import path from 'node:path';

// Phase 4 PR 4.10 — Playwright-Electron E2E install harness.
//
// Tests live alongside this config under ./specs. Each spec launches a
// fresh Electron via `bootOs8` (setup.ts) into a temp OS8_HOME so runs
// don't pollute the developer's real ~/os8/ tree.
//
// Local run:
//   npm run test:e2e
//
// CI run (.github/workflows/e2e.yml): Linux + macOS only initially.
// Windows joins the matrix once PR 4.8 lands and the existing
// hosts-file / DNS / NSIS surface is verified there.

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

export default defineConfig({
  testDir: './specs',
  // Cold installs take time; ML model fetches even more. Per-spec budget
  // generous; per-test timeouts inside specs override when needed.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,           // each Electron launch is heavy; serialize.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: path.join(REPO_ROOT, 'playwright-report') }]],
  outputDir: path.join(REPO_ROOT, 'test-results'),

  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Most specs interact with the Electron BrowserWindow; setup.ts
    // returns an `app` + `window` pair to spec code, so we don't rely
    // on Playwright's `page` fixture here.
  },
});
