/**
 * LOCAL_TRIPLET — the three local-model slots OS8 uses under ai_mode='local'.
 *
 * Mirrors the `roles:` map in os8-launcher/config.yaml. Keep the two in sync:
 * the launcher is the source of truth for what models exist; OS8 is the source
 * of truth for which subset powers the three active slots.
 *
 * Keyed by slot name (chat|image|voice). Each entry:
 *   - model: launcher model id (matches config.yaml roles.<role>.model)
 *   - backend: launcher backend id (matches config.yaml roles.<role>.backend)
 *   - label: user-facing slot label rendered in Settings
 */
const LOCAL_TRIPLET = {
  chat:  { model: 'qwen3-6-35b-a3b',   backend: 'vllm',    label: 'Chat'  },
  image: { model: 'flux1-kontext-dev', backend: 'comfyui', label: 'Image' },
  voice: { model: 'kokoro-v1',         backend: 'kokoro',  label: 'Voice' }
};

const SLOT_ORDER = ['chat', 'image', 'voice'];

module.exports = { LOCAL_TRIPLET, SLOT_ORDER };
