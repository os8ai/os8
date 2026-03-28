/**
 * Initialization utilities for OS8
 *
 * Note: Full initialization orchestration remains in index.html due to
 * callback registration order dependencies between modules. This module
 * exports cleanly extractable initialization functions.
 */

import { setCoreReady } from './state.js';

/**
 * Initialize Core Services (Vite/React shared environment)
 * Handles setup of ~/os8/core/ which provides React, Tailwind, etc.
 *
 * @param {HTMLButtonElement} newAppBtn - The "New App" button to enable/disable
 */
export async function initCoreServices(newAppBtn) {
  const status = await window.os8.core.getStatus();

  if (status === 'ready') {
    setCoreReady(true);
    newAppBtn.disabled = false;
    return;
  }

  // Core not ready - disable New App button and start setup
  newAppBtn.disabled = true;

  if (status === 'installing') {
    // Already installing, wait for completion
    window.os8.core.onReady(() => {
      setCoreReady(true);
      newAppBtn.disabled = false;
    });
    return;
  }

  // Need to initialize and install
  window.os8.core.onReady(() => {
    setCoreReady(true);
    newAppBtn.disabled = false;
  });

  try {
    await window.os8.core.setup();
  } catch (err) {
    console.error('Core setup failed:', err);
    // Keep button disabled but show error state
    newAppBtn.title = 'Setup failed - check console';
  }
}

