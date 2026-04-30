/**
 * Global EventEmitter that AppInstaller fans-out to. Lets the IPC layer
 * (src/ipc/app-store.js) relay every job update to the renderer without
 * subscribing to each job individually.
 *
 * AppInstaller wires `subscribe(jobId, ...)` into per-job pub/sub for SSE
 * streams; this emitter mirrors the same payloads onto a single global
 * channel for the desktop UI's "currently-installing app" widget (PR 1.17).
 */

const { EventEmitter } = require('node:events');

const InstallEvents = new EventEmitter();
// The desktop has at most one install plan modal open at a time, but multiple
// SSE streams are fine — bump the limit so we don't spam stderr in tests.
InstallEvents.setMaxListeners(50);

module.exports = InstallEvents;
