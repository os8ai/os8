/**
 * Failure hint matcher (Tier 3A of the dev-import resilience plan).
 *
 * Given a tail of process output (stderr + tail-end stdout) from a failed
 * external-app start, return zero or more "hints" the renderer can show
 * the user. Each hint has a short title and a body that points the user
 * at the most likely fix — without prescribing a specific edit, so it
 * stays useful even when the underlying app is something we've never
 * seen before.
 *
 * Patterns are conservative — false-negative >> false-positive. The
 * raw stderr is always rendered alongside the hints, so a missed hint
 * isn't catastrophic; a wrong hint pushes users toward the wrong fix.
 *
 * Adding a hint: append a `{ name, test, title, body }` object below.
 * `test` is a RegExp; `body` may be a string or `(match) => string`
 * to interpolate captures.
 */

const HINTS = [
  {
    name: 'missing-model-weights',
    test: /\b(?:weights?|checkpoint|\.onnx|\.pt|\.safetensors|\.bin|未找到|model not found|state_dict)\b/i,
    title: 'Looks like missing model files',
    body:
      "This app references model files that aren't on disk. Look for a setup or download script in the upstream repo " +
      "(commonly scripts/download_model.py, download_models.py, or a Makefile target named download/setup) and run it " +
      "before re-launching. For Developer Import installs, you can include the script as a postInstall step on the next " +
      "import.",
  },
  {
    name: 'unexpected-kwarg',
    test: /unexpected keyword argument ['"]([\w_]+)['"]/,
    title: 'Upstream API mismatch',
    body: (m) =>
      `The app passed kwarg '${m[1]}' to a library function that doesn't accept it — usually a deprecated parameter ` +
      `removed in a newer library version. Try pinning the framework (gradio, streamlit, transformers, …) to an older ` +
      `version in the install commands, or update the app's call site if you have edit access.`,
  },
  {
    name: 'module-not-found',
    test: /(?:ModuleNotFoundError|No module named) ['"]?([\w.]+)['"]?/,
    title: 'Missing Python dependency',
    body: (m) =>
      `Python can't find the '${m[1]}' module. It isn't installed in the app's venv. Add it to requirements.txt ` +
      `(or the install commands in the manifest) and re-import — or run \`uv pip install ${m[1]}\` inside the app's ` +
      `.venv if you just want to retry once.`,
  },
  {
    name: 'cannot-import-name',
    test: /ImportError: cannot import name ['"]([\w_]+)['"] from ['"]([\w.]+)['"]/,
    title: 'Library version mismatch',
    body: (m) =>
      `Tried to import '${m[1]}' from '${m[2]}', but it isn't there. Almost always means a newer version of ${m[2]} ` +
      `removed or renamed the symbol. Pin ${m[2]} to a known-compatible version in the install commands.`,
  },
  {
    name: 'port-in-use',
    test: /(?:address already in use|EADDRINUSE|bind.*Address already in use)/i,
    title: 'Port already in use',
    body:
      "Something is occupying the port OS8 allocated for this app. Restart OS8, or find the conflicting process with " +
      "`lsof -i :<port>` (Linux/macOS) and kill it.",
  },
  {
    name: 'localhost-not-accessible',
    test: /localhost is not accessible/i,
    title: 'Framework localhost reachability check failed',
    body:
      "Some Gradio versions (notably 4.x) self-test localhost reachability before launching and fail in certain " +
      "container/VM configurations. Try pinning gradio to a different major version (5.x or 6.x) in the install commands.",
  },
  {
    name: 'permission-denied',
    test: /Permission denied|EACCES/i,
    title: 'Permission denied',
    body:
      "The app process couldn't read or execute a file. If you ran a setup script as root or downloaded files outside " +
      "the app dir, those permissions might not match OS8's user. Re-running the app's install often fixes this.",
  },
  {
    name: 'disk-full',
    test: /No space left on device|ENOSPC/i,
    title: 'Disk full',
    body: 'No space left on device. Free up disk and retry.',
  },
  {
    name: 'gpu-required',
    test: /\bCUDA out of memory\b|\bnvidia-smi\b|cuDNN error|CUDA error|requires a (?:GPU|CUDA)/i,
    title: 'App requires a GPU',
    body:
      "This app failed because it expected GPU/CUDA. CPU-only installs are sometimes possible by editing imports " +
      "(switch from `torch.cuda` to CPU device) but most ML apps don't run usefully without a GPU.",
  },
];

/**
 * Match `text` (typically last ~1500 chars of stderr) against the hint
 * pattern table. Returns the first 2 matches (de-duplicated by `name`)
 * to avoid overwhelming the failure view with a wall of guesses.
 *
 * @param {string} text - process output to scan
 * @returns {Array<{name: string, title: string, body: string}>}
 */
function matchHints(text) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  const seen = new Set();
  for (const hint of HINTS) {
    const m = text.match(hint.test);
    if (!m) continue;
    if (seen.has(hint.name)) continue;
    seen.add(hint.name);
    out.push({
      name: hint.name,
      title: hint.title,
      body: typeof hint.body === 'function' ? hint.body(m) : hint.body,
    });
    if (out.length >= 2) break;
  }
  return out;
}

/**
 * Parse the structured stderr tail out of an exitedBeforeReady() error
 * message (Tier 1 format). Returns the original message + the extracted
 * tail (or null if the marker is absent — older error format).
 *
 * @param {string} message - error.message
 * @returns {{ summary: string, code: number|null, stderrTail: string|null }}
 */
function parseStartError(message) {
  if (typeof message !== 'string') return { summary: String(message || ''), code: null, stderrTail: null };
  const codeMatch = message.match(/code=(\d+)/);
  const code = codeMatch ? parseInt(codeMatch[1], 10) : null;
  const sep = '\n--- last process output ---\n';
  const idx = message.indexOf(sep);
  if (idx < 0) {
    return { summary: message, code, stderrTail: null };
  }
  const summary = message.slice(0, idx).trim();
  const stderrTail = message.slice(idx + sep.length).trim();
  return { summary, code, stderrTail };
}

module.exports = { matchHints, parseStartError, HINTS };
