/**
 * ComfyUI client (Phase 3 §4.5).
 *
 * Thin wrapper around ComfyUI's prompt-queue + history-poll API:
 *   POST /prompt {prompt: <workflow JSON>, client_id} → {prompt_id}
 *   GET  /history/{prompt_id} → {<prompt_id>: {outputs: {<node>: {images: [{filename, type, subfolder}]}}}}
 *   GET  /view?filename=&type=&subfolder= → binary PNG
 *
 * We poll /history (don't use the WebSocket progress channel) because
 *   a) Node 22's built-in WebSocket isn't ergonomic without an extra dep,
 *   b) Flux schnell completes in <5s on Spark — polling overhead is trivial,
 *   c) the launcher-side WS is ComfyUI's, not OS8's, so we'd need a separate
 *      progress relay to surface step deltas to OS8 SSE clients anyway.
 *
 * If progress UX becomes important, add a WebSocket variant later — the
 * /prompt + /history endpoints stay as the authoritative submit/result path.
 */

const LauncherClient = require('./launcher-client');

const DEFAULT_BASE = 'http://localhost:8188';
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_TIMEOUT_MS = 180_000;       // 3 minutes — Flux schnell <5s, dev <60s

/**
 * Resolve the ComfyUI base URL from the launcher's capabilities map. Falls
 * back to localhost:8188 when the launcher hasn't surfaced an `image-gen`
 * capability yet — same pattern as tts-kokoro.js.
 */
async function resolveBaseUrl() {
  try {
    const caps = await LauncherClient.getCapabilities();
    // Launcher uses 'image-gen' as the task name; OS8 uses 'image' internally.
    // The mapping is in launcher-client (Phase 3 §3.1) but we hit caps
    // directly here so the test mock for caps doesn't need to know about it.
    const entries = caps?.['image-gen'] || caps?.['image'];
    const entry = Array.isArray(entries) ? entries[0] : entries;
    if (entry?.base_url) return entry.base_url;
  } catch (_e) {
    // Launcher unreachable — fall through to default port.
  }
  return DEFAULT_BASE;
}

/**
 * Submit a workflow to ComfyUI's queue. Returns the prompt_id.
 *
 * @param {string} baseUrl
 * @param {object} workflow - the workflow graph (output of buildFluxText2ImageWorkflow)
 * @param {string} clientId - opaque client identifier (any uuid-ish string)
 * @returns {Promise<string>}
 */
async function submitWorkflow(baseUrl, workflow, clientId) {
  const res = await fetch(`${baseUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ComfyUI /prompt returned ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  if (data?.error) {
    const detail = typeof data.error === 'string' ? data.error : (data.error.message || JSON.stringify(data.error));
    throw new Error(`ComfyUI rejected prompt: ${detail.slice(0, 300)}`);
  }
  if (!data.prompt_id) {
    throw new Error(`ComfyUI /prompt returned no prompt_id: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data.prompt_id;
}

/**
 * Poll /history until the prompt completes. Returns the per-node outputs
 * when done, or throws on timeout / explicit execution error.
 *
 * Considered done when the entry exists in /history with a populated
 * `outputs` field. ComfyUI doesn't write the entry until execution finishes
 * (success or error), so the existence check is sufficient.
 *
 * @returns {Promise<object>} the outputs dict {nodeId: {images: [...]}}
 */
async function pollUntilDone(baseUrl, promptId, { intervalMs = DEFAULT_POLL_INTERVAL_MS, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/history/${encodeURIComponent(promptId)}`);
    if (!res.ok) {
      // Transient — keep polling. Persistent failures will surface via timeout.
      await sleep(intervalMs);
      continue;
    }
    const hist = await res.json().catch(() => ({}));
    const entry = hist?.[promptId];
    if (entry) {
      // ComfyUI sets `status.status_str` to 'success' or 'error'. On error,
      // surface it instead of returning empty outputs.
      const status = entry.status?.status_str;
      if (status === 'error') {
        const messages = entry.status?.messages || [];
        const errMsg = messages.find(m => m?.[0] === 'execution_error')?.[1]?.exception_message || 'execution failed';
        throw new Error(`ComfyUI execution error: ${String(errMsg).slice(0, 300)}`);
      }
      if (entry.outputs && Object.keys(entry.outputs).length > 0) {
        return entry.outputs;
      }
    }
    await sleep(intervalMs);
  }
  throw new Error(`ComfyUI poll timed out after ${timeoutMs}ms (prompt_id=${promptId})`);
}

/**
 * Fetch a generated image as a Buffer via /view.
 */
async function fetchImage(baseUrl, { filename, type = 'output', subfolder = '' }) {
  const url = new URL(`${baseUrl}/view`);
  url.searchParams.set('filename', filename);
  url.searchParams.set('type', type);
  url.searchParams.set('subfolder', subfolder);
  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`ComfyUI /view returned ${res.status} for ${filename}`);
  }
  const buf = await res.arrayBuffer();
  return Buffer.from(buf);
}

/**
 * Extract image refs from a /history outputs payload. Each ComfyUI SaveImage
 * node emits {images: [{filename, type, subfolder}, ...]}. We flatten across
 * all output nodes.
 */
function extractImageRefs(outputs) {
  const refs = [];
  for (const node of Object.values(outputs || {})) {
    if (Array.isArray(node?.images)) {
      for (const img of node.images) {
        if (img?.filename) refs.push(img);
      }
    }
  }
  return refs;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Upload a reference image to ComfyUI's `/upload/image` endpoint. Returns the
 * filename the Kontext workflow's LoadImage node should reference. ComfyUI's
 * response shape is `{ name, subfolder, type }`; we combine subfolder/name
 * into the form LoadImage expects (e.g. `sub/name.png`).
 *
 * Used by the Kontext path (v2 plan, LOCAL_MODELS_PLAN.md) because Kontext
 * requires a reference image. The Buffer/base64 data gets wrapped in a Blob
 * and POSTed as multipart/form-data — same shape as the launcher's image-gen
 * client.
 *
 * @param {string} baseUrl
 * @param {Buffer|string} imageData - either a Buffer of raw bytes, or a base64 string
 * @param {string} mimeType - e.g. 'image/png' / 'image/jpeg'
 * @param {string} [filename='reference.png'] - display filename (ComfyUI may rewrite on disk collision)
 * @returns {Promise<string>} the reference filename LoadImage should use
 */
async function uploadReference(baseUrl, imageData, mimeType = 'image/png', filename = 'reference.png') {
  const buffer = Buffer.isBuffer(imageData) ? imageData : Buffer.from(imageData, 'base64');
  const blob = new Blob([buffer], { type: mimeType });
  const form = new FormData();
  form.append('image', blob, filename);
  form.append('overwrite', 'true');

  const res = await fetch(`${baseUrl}/upload/image`, { method: 'POST', body: form });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ComfyUI /upload/image returned ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data?.name) {
    throw new Error(`ComfyUI /upload/image returned no filename: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

module.exports = {
  resolveBaseUrl,
  submitWorkflow,
  pollUntilDone,
  fetchImage,
  extractImageRefs,
  uploadReference,
  DEFAULT_BASE
};
