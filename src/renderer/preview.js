/**
 * Preview (BrowserView) management for OS8
 */

import { elements } from './elements.js';
import {
  getCurrentMode, getCurrentApp, getAppTabs,
  getTabById, getActiveTabId, getEffectiveViewMode
} from './state.js';

// Track which apps have active previews
export const activePreviewApps = new Set();

function scaleBoundsForZoom(rect, zoomFactor) {
  return {
    x: Math.round(rect.left * zoomFactor),
    y: Math.round(rect.top * zoomFactor),
    width: Math.round(rect.width * zoomFactor),
    height: Math.round(rect.height * zoomFactor),
  };
}

export async function ensurePreviewForApp(app) {
  if (!activePreviewApps.has(app.id)) {
    if (app.app_type === 'external') {
      await window.os8.preview.createExternal(app.id, app.slug);
    } else {
      await window.os8.preview.create(app.id);
    }
    activePreviewApps.add(app.id);
  }
}

export async function loadPreviewForApp(app, subPath = '') {
  await ensurePreviewForApp(app);
  if (app.app_type === 'external') {
    // PR 1.19: external apps live at <slug>.localhost:<port>/. The URL is
    // composed by the server when /processes/start fires; tabs.js stores it
    // on tab.state.externalUrl and passes it via loadPreview().
    const tab = getTabById(getActiveTabId());
    const externalUrl = tab?.state?.externalUrl;
    if (externalUrl) {
      await window.os8.preview.setUrl(app.id, externalUrl);
      return;
    }
  }
  const port = await window.os8.server.getPort();
  const fullUrl = `http://localhost:${port}/${app.slug}/${subPath}`;
  await window.os8.preview.setUrl(app.id, fullUrl);
}

export async function hidePreviewForApp(appId) {
  await window.os8.preview.hide(appId);
}

export async function destroyPreviewForApp(appId) {
  await window.os8.preview.destroy(appId);
  activePreviewApps.delete(appId);
}

export async function hideAllPreviews() {
  await window.os8.preview.hideAll();
}

export async function updatePreviewBounds() {
  const zoomFactor = await window.os8.zoom.getFactor();
  if (getCurrentMode() === 'user') {
    // User mode: position previews in split view panels
    await updateUserModePreviewBounds(zoomFactor);
  } else {
    // Developer mode: single preview in previewArea
    if (getCurrentApp()) {
      const rect = elements.previewArea.getBoundingClientRect();
      await window.os8.preview.setBounds(getCurrentApp().id, scaleBoundsForZoom(rect, zoomFactor));
    }
  }
}

export async function updateUserModePreviewBounds(zoomFactor = 1) {
  const appTabs = getAppTabs();
  const effectiveMode = getEffectiveViewMode();

  // Position primary app preview
  const activeTab = getTabById(getActiveTabId());
  if (activeTab && activeTab.type === 'app') {
    const primaryContent = document.getElementById('splitPrimaryContent');
    if (primaryContent) {
      const rect = primaryContent.getBoundingClientRect();
      await window.os8.preview.setBounds(activeTab.app.id, scaleBoundsForZoom(rect, zoomFactor));
    }
  }

  // Position secondary app previews (only in split mode)
  const secondaryTabs = appTabs.filter(t => t.id !== getActiveTabId());
  if (effectiveMode === 'split') {
    for (const tab of secondaryTabs) {
      const panelContent = document.querySelector(`.split-panel[data-tab-id="${tab.id}"] .split-panel-content`);
      if (panelContent) {
        const rect = panelContent.getBoundingClientRect();
        await window.os8.preview.setBounds(tab.app.id, scaleBoundsForZoom(rect, zoomFactor));
      }
    }
  } else {
    // Focus mode: hide secondary previews
    for (const tab of secondaryTabs) {
      await window.os8.preview.hide(tab.app.id);
    }
  }
}

export async function loadPreview() {
  if (!getCurrentApp()) return;
  const port = await window.os8.server.getPort();
  const subPath = elements.previewUrlInput.value.trim();
  // Use appId for actual URL (slug is only displayed cosmetically in previewUrlPrefix)
  const fullUrl = `http://localhost:${port}/${getCurrentApp().id}/${subPath}`;
  await ensurePreviewForApp(getCurrentApp());
  await window.os8.preview.setUrl(getCurrentApp().id, fullUrl);
  await updatePreviewBounds();
}
