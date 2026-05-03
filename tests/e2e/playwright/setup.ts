// Phase 4 PR 4.10 — Playwright-Electron E2E harness setup.
//
// `bootOs8` launches a fresh Electron pointed at a temp OS8_HOME and
// waits for the shell to render its app-grid sentinel. The temp dir is
// cleaned in `closeOs8`. Specs that need a pre-seeded environment
// (catalog rows, installed apps) drop fixtures into the temp dir
// between bootOs8 and the first window interaction.

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
// `#appsGrid` is index.html's home-grid container — once it's in the DOM
// the shell has bootstrapped past the splash and reads as ready for spec
// interaction. The bracketed alias gives future flexibility if the ID
// is renamed.
const SHELL_READY_SELECTOR = '#appsGrid, [data-app-grid]';

export interface BootedOs8 {
  app: ElectronApplication;
  window: Page;
  home: string;
}

export interface BootOpts {
  /** Override OS8_HOME (defaults to a fresh tmp dir per launch). */
  os8Home?: string;
  /** Extra env vars layered on process.env. */
  env?: Record<string, string>;
  /** Per-launch timeout for window creation + DOM-ready. */
  bootTimeoutMs?: number;
}

export async function bootOs8(opts: BootOpts = {}): Promise<BootedOs8> {
  const home = opts.os8Home || (await fs.mkdtemp(path.join(os.tmpdir(), 'os8-e2e-')));
  await fs.mkdir(home, { recursive: true });

  const app = await electron.launch({
    args: [REPO_ROOT, '--no-sandbox'],     // --no-sandbox needed in Linux CI containers
    env: {
      ...process.env,
      OS8_HOME: home,
      // Telemetry must never fire from tests. PR 4.4 reads this setting
      // before enqueue; PR 4.5's ingest endpoint also accepts the override.
      OS8_TELEMETRY_OPT_IN: 'false',
      OS8_LOG_LEVEL: 'warn',
      // Playwright captures Electron's stderr into the test log; the
      // shell's `console.log` chatter can drown signal — silence at warn.
      ELECTRON_ENABLE_LOGGING: '1',
      // Layered overrides win.
      ...(opts.env || {}),
    },
    timeout: opts.bootTimeoutMs ?? 30_000,
  });

  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  // The shell's `#appGrid` (or its [data-app-grid] alias) is the
  // sentinel that the renderer bootstrapped. If it never appears, the
  // shell crashed before paint.
  await window.waitForSelector(SHELL_READY_SELECTOR, { timeout: opts.bootTimeoutMs ?? 30_000 });
  return { app, window, home };
}

export async function closeOs8(booted: BootedOs8 | null | undefined): Promise<void> {
  if (!booted) return;
  try {
    await booted.app.close();
  } catch {
    /* shell may have already exited */
  }
  if (booted.home) {
    try {
      await fs.rm(booted.home, { recursive: true, force: true });
    } catch {
      /* tmpdir cleanup is best-effort */
    }
  }
}

/**
 * Read OS8's port from inside the running shell. main.js exposes it on
 * window for renderer use; this helper reaches into the BrowserWindow
 * via Playwright to fetch it for spec-level HTTP probes (e.g. asserting
 * the strict-mode origin allowlist on /api/* endpoints).
 */
export async function getOs8Port(window: Page): Promise<number> {
  return await window.evaluate(() => {
    // OS8_PORT is injected by preload via window.os8?.shell?.port or read
    // from window.location.port; either works.
    const fromLoc = Number(globalThis.location?.port || 0);
    if (Number.isFinite(fromLoc) && fromLoc > 0) return fromLoc;
    const w = globalThis as unknown as { os8?: { shell?: { port?: number } } };
    return w.os8?.shell?.port ?? 8888;
  });
}
