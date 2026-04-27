/**
 * LOCAL_TRIPLET — the three local-model slots OS8 uses under ai_mode='local'.
 *
 * The launcher is the source of truth for what's actually serving each
 * slot. `resolveTriplet()` fetches /api/triplet/roles and returns the
 * launcher's currently-selected option for each role.
 *
 * `STATIC_FALLBACK` mirrors the launcher's config.yaml defaults so OS8 can
 * still render a sensible triplet when the launcher is unreachable or
 * running an older build that doesn't expose /api/triplet/roles. Keep it
 * in sync with `roles:` in os8-launcher/config.yaml.
 *
 * Slot keys (chat|image|voice) are OS8-internal labels — they map to the
 * launcher's role names via SLOT_TO_ROLE.
 */

const STATIC_FALLBACK = {
  chat:  { model: 'qwen3-6-35b-a3b',   backend: 'vllm',    label: 'Chat'  },
  image: { model: 'flux1-kontext-dev', backend: 'comfyui', label: 'Image' },
  voice: { model: 'kokoro-v1',         backend: 'kokoro',  label: 'Voice' }
};

const SLOT_TO_ROLE = { chat: 'chat', image: 'image-gen', voice: 'tts' };
const SLOT_ORDER = ['chat', 'image', 'voice'];

/**
 * Fetch the active triplet from the launcher and return one entry per slot:
 *   { model, backend, label, options?, selected?, needs_apply? }
 * The optional fields are populated when the launcher reports them so the
 * settings UI can show what the active selection is and whether the user
 * has a pending change waiting for Stop & Apply in the launcher.
 *
 * Always resolves — never throws — so callers can render unconditionally.
 * On any failure (launcher down, old launcher, network error) returns the
 * static fallback so OS8 still functions in offline-launcher scenarios.
 */
async function resolveTriplet() {
  let roles;
  try {
    const LauncherClient = require('./launcher-client');
    roles = await LauncherClient.getRoles();
  } catch {
    return { ...STATIC_FALLBACK };
  }
  const out = {};
  for (const slot of SLOT_ORDER) {
    const roleKey = SLOT_TO_ROLE[slot];
    const role = roles ? roles[roleKey] : null;
    if (!role || !Array.isArray(role.options) || role.options.length === 0) {
      out[slot] = STATIC_FALLBACK[slot];
      continue;
    }
    const opt = role.options.find(o => o.model === role.selected) || role.options[0];
    out[slot] = {
      model: opt.model,
      backend: opt.backend || STATIC_FALLBACK[slot].backend,
      label: opt.label || STATIC_FALLBACK[slot].label,
      options: role.options,
      selected: role.selected,
      default: role.default,
      needs_apply: !!role.needs_apply,
      running_model: role.running_model || null,
      // Port the running instance listens on. OS8's terminal-tab path uses
      // this to build LLM_BASE_URL for OpenHands sessions without having to
      // cross-reference /api/status. null when nothing is running for this slot.
      running_port: role.running_port || null,
      // 0.4.14: pass through the launcher's per-model recommended_client
      // (chat slot only — image-gen / tts don't have CLI clients).
      recommended_client: role.recommended_client || null,
    };
  }
  return out;
}

module.exports = { resolveTriplet, STATIC_FALLBACK, SLOT_ORDER, SLOT_TO_ROLE };
