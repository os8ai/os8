/**
 * Tier 3A follow-up — guard against the modal-class regression.
 *
 * PR #34's failure modal used `class="install-plan-modal-root"` which
 * doesn't exist in any stylesheet, so the modal rendered as an
 * unstyled in-flow div appended to <body> — invisible. The fix uses
 * `.modal-overlay` from styles/modals.css, which has the
 * position:fixed + inset:0 + z-index + display:flex-on-active rules
 * the modal needs to actually appear.
 *
 * No JSDOM dep available in this project, and adding one for one test
 * is overkill — instead this is a static check on the source file that
 * the right class string is in there. If a future refactor switches
 * back to a class without CSS, this fails and points at the regression.
 *
 * Companion to the manual smoke (which is what surfaced the original
 * bug; this test is the floor that prevents re-regression).
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MODAL_PATH = path.join(__dirname, '..', 'src', 'renderer', 'app-start-failure-modal.js');
const MODALS_CSS = path.join(__dirname, '..', 'styles', 'modals.css');

describe('app-start-failure-modal — root container CSS class', () => {
  it("uses className = 'modal-overlay' (the class with real CSS)", () => {
    const src = fs.readFileSync(MODAL_PATH, 'utf8');
    expect(src).toMatch(/root\.className\s*=\s*['"]modal-overlay['"]/);
  });

  it("does not use the no-css 'install-plan-modal-root' class", () => {
    const src = fs.readFileSync(MODAL_PATH, 'utf8');
    expect(src).not.toMatch(/['"]install-plan-modal-root['"]/);
  });

  it("'.modal-overlay' has the position:fixed + display:flex-on-active rules", () => {
    const css = fs.readFileSync(MODALS_CSS, 'utf8');
    // .modal-overlay must declare position:fixed and inset:0 so the
    // modal covers the whole viewport instead of sitting in-flow.
    expect(css).toMatch(/\.modal-overlay\s*\{[\s\S]*?position\s*:\s*fixed/);
    expect(css).toMatch(/\.modal-overlay\s*\{[\s\S]*?inset\s*:\s*0/);
    // .modal-overlay.active must flip display from none to flex.
    expect(css).toMatch(/\.modal-overlay\.active\s*\{[\s\S]*?display\s*:\s*flex/);
  });

  it('toggles .active class on show + clears it on close', () => {
    // The modal opens by adding 'active' (which the .modal-overlay.active
    // CSS rule keys on). Closing must remove it, otherwise the next
    // open from a different module would see a leftover active class.
    const src = fs.readFileSync(MODAL_PATH, 'utf8');
    expect(src).toMatch(/classList\.add\(['"]active['"]\)/);
    expect(src).toMatch(/classList\.remove\(['"]active['"]\)/);
  });
});
