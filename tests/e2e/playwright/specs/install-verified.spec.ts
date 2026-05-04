// Phase 5 PR 5.3 — Verified install end-to-end smoke.
//
// Walks the full install pipeline from catalog sync through running
// app: trigger sync → find worldmonitor → call install IPC → wait for
// the install job to reach `installed` → verify the app row + apps:list
// reflect it. Catches regressions in the install pipeline as a whole
// (catalog get, install plan render, clone, npm install, atomic move,
// apps row insert).
//
// Spec runs against the live os8.ai catalog — per phase-5-plan §1
// open-question-1 ("ship with catalog because that's what regressions
// actually look like; fixture as a follow-up if catalog dependency
// causes flake"). When os8.ai is unreachable from the runner, the spec
// fails with a network-shaped error; CI retries should soak transient
// failures.
//
// Heavy: cold npm install in a CI runner can run 2-3 minutes. Spec
// timeout is generous; per-test timeout overrides the file default.

import { test, expect } from '@playwright/test';
import { bootOs8, closeOs8, type BootedOs8 } from '../setup';

const INSTALL_TIMEOUT_MS = 6 * 60_000; // 6 min — covers the slowest CI cold install.

test.describe('Verified install: worldmonitor end-to-end', () => {
  let booted: BootedOs8 | null = null;

  test.afterEach(async () => {
    await closeOs8(booted);
    booted = null;
  });

  test('catalog sync → install → app row visible', async () => {
    test.setTimeout(INSTALL_TIMEOUT_MS + 60_000);

    booted = await bootOs8();
    const window = booted.window;

    // 1. Trigger a sync of the verified channel so worldmonitor lands
    //    in the local app_catalog. PR 5.6 wired appStore.syncChannelNow.
    const syncResult = await window.evaluate(async () => {
      const w = globalThis as unknown as {
        os8: { appStore: { syncChannelNow: (channel: string) => Promise<{
          ok: boolean; added?: number; updated?: number; removed?: number; error?: string;
        }> } };
      };
      return await w.os8.appStore.syncChannelNow('verified');
    });
    // If sync fails (e.g. os8.ai unreachable from runner), surface the
    // failure clearly. Don't skip — that hides real regressions.
    expect(syncResult.ok, `catalog sync failed: ${syncResult.error}`).toBe(true);

    // 2. Resolve the worldmonitor catalog entry to get its current commit.
    const worldmonitor = await window.evaluate(async () => {
      const w = globalThis as unknown as {
        os8: { appStore: { renderPlan: (slug: string, channel: string) => Promise<{
          ok: boolean; entry?: { upstreamResolvedCommit: string; slug: string };
          error?: string;
        }> } };
      };
      return await w.os8.appStore.renderPlan('worldmonitor', 'verified');
    });
    expect(worldmonitor.ok, `renderPlan failed: ${worldmonitor.error}`).toBe(true);
    expect(worldmonitor.entry?.slug).toBe('worldmonitor');
    const commit = worldmonitor.entry!.upstreamResolvedCommit;
    expect(commit).toMatch(/^[0-9a-f]{40}$/);

    // 3. Kick off the install. The IPC returns immediately with a jobId;
    //    actual work happens in a background async pipeline.
    const installStart = await window.evaluate(async (args) => {
      const w = globalThis as unknown as {
        os8: { appStore: { install: (
          slug: string, commit: string, channel: string, source: string
        ) => Promise<{ ok: boolean; jobId?: string; status?: string; error?: string }> } };
      };
      return await w.os8.appStore.install(args.slug, args.commit, 'verified', 'e2e');
    }, { slug: 'worldmonitor', commit });
    expect(installStart.ok, `install start failed: ${installStart.error}`).toBe(true);
    expect(installStart.jobId).toBeTruthy();
    const jobId = installStart.jobId!;

    // 4. The install plan modal would prompt for approval in real UX;
    //    the IPC `appStore.approve` skips the modal and confirms in-process.
    //    Worldmonitor declares no required secrets, so we approve with {}.
    //    Loop until the job state machine moves past awaiting_approval.
    let approvedAt = Date.now();
    while (Date.now() - approvedAt < 30_000) {
      const job = await window.evaluate(async (id) => {
        const w = globalThis as unknown as {
          os8: { appStore: { getJob: (jid: string) => Promise<{
            ok: boolean; job?: { status: string }; error?: string;
          }> } };
        };
        return await w.os8.appStore.getJob(id);
      }, jobId);
      if (job.ok && job.job?.status === 'awaiting_approval') break;
      if (job.ok && (job.job?.status === 'failed' || job.job?.status === 'cancelled')) {
        throw new Error(`job died early: ${job.job?.status}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    const approveResult = await window.evaluate(async (id) => {
      const w = globalThis as unknown as {
        os8: { appStore: { approve: (jid: string, secrets: Record<string, string>) => Promise<{
          ok: boolean; error?: string;
        }> } };
      };
      return await w.os8.appStore.approve(id, {});
    }, jobId);
    expect(approveResult.ok, `approve failed: ${approveResult.error}`).toBe(true);

    // 5. Poll for terminal state. The deadline is generous because cold
    //    npm install in CI can run several minutes.
    const deadline = Date.now() + INSTALL_TIMEOUT_MS;
    let finalStatus = '';
    while (Date.now() < deadline) {
      const job = await window.evaluate(async (id) => {
        const w = globalThis as unknown as {
          os8: { appStore: { getJob: (jid: string) => Promise<{
            ok: boolean; job?: { status: string; error_message?: string }; error?: string;
          }> } };
        };
        return await w.os8.appStore.getJob(id);
      }, jobId);
      if (!job.ok) throw new Error(`getJob failed: ${job.error}`);
      finalStatus = job.job?.status || '';
      if (finalStatus === 'installed') break;
      if (finalStatus === 'failed' || finalStatus === 'cancelled') {
        throw new Error(`install ${finalStatus}: ${job.job?.error_message || '(no message)'}`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(finalStatus).toBe('installed');

    // 6. Confirm the apps:list reflects the new external app. PR 4.6's
    //    strict middleware is in force; the bare-localhost shell origin
    //    is allowlisted so this call succeeds without an X-OS8-App-Id.
    const apps = await window.evaluate(async () => {
      const w = globalThis as unknown as {
        os8: { apps: { list: () => Promise<Array<{ slug: string; status: string; app_type?: string }>> } };
      };
      return await w.os8.apps.list();
    });
    const installed = apps.find((a) => a.slug === 'worldmonitor');
    expect(installed, 'worldmonitor should appear in apps:list after install').toBeDefined();
    expect(installed!.status).toBe('active');
  });
});
