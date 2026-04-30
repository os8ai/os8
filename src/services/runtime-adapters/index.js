/**
 * Runtime adapter registry.
 *
 * Spec §6.2.2 + plan §3 PR 1.11. Adapters implement `install` / `start` /
 * `stop` / `watchFiles` for a `runtime.kind`. v1 ships only `node`; PR 2.1
 * adds `python`, PR 2.3 adds `static`, PR 2.5 adds `docker`.
 */

const adapters = new Map();

function register(adapter) {
  if (!adapter?.kind) throw new Error('adapter.kind required');
  adapters.set(adapter.kind, adapter);
}

function getAdapter(kind) {
  const a = adapters.get(kind);
  if (!a) throw new Error(`no runtime adapter for kind=${kind}`);
  return a;
}

function listKinds() {
  return Array.from(adapters.keys());
}

// Register the v1 adapters at module load.
register(require('./node'));

module.exports = { register, getAdapter, listKinds };
