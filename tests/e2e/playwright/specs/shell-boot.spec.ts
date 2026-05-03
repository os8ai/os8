// Phase 4 PR 4.10 — basic shell-boot smoke.
//
// The simplest meaningful spec: launch OS8, see the home grid render,
// shut down cleanly. If this fails, every other E2E spec is moot
// (the rest assume a booted shell). Runs first in the suite by name.

import { test, expect } from '@playwright/test';
import { bootOs8, closeOs8, type BootedOs8 } from '../setup';

test.describe('shell boot', () => {
  let booted: BootedOs8 | null = null;

  test.afterEach(async () => {
    await closeOs8(booted);
    booted = null;
  });

  test('launches Electron and renders the home grid', async () => {
    booted = await bootOs8();
    await expect(booted.window.locator('#appsGrid, [data-app-grid]')).toBeVisible();
  });

  test('home grid is empty in a fresh OS8_HOME', async () => {
    booted = await bootOs8();
    // No apps installed in a freshly-minted OS8_HOME — the grid renders
    // but the app icon list is empty (or shows a "no apps yet" state).
    const apps = await booted.window.locator('[data-app-id]').count();
    expect(apps).toBe(0);
  });

  test('clean shutdown leaves no orphaned electron processes', async () => {
    booted = await bootOs8();
    const pid = booted.app.process().pid;
    await booted.app.close();
    booted = null;
    // After close(), the PID should no longer be valid. Sending signal 0
    // throws ESRCH if the process is gone.
    expect(() => process.kill(pid as number, 0)).toThrow();
  });
});
