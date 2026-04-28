#!/usr/bin/env node
// Spawn-time shim that lets us run Grok CLI without crossing Linux's
// MAX_ARG_STRLEN (~128 KB per single argv string). cli-runner writes the
// enriched prompt to a temp file, spawns this shim with the file path in
// OS8_GROK_PROMPT_FILE, and the shim splices the prompt into argv in-process
// before dynamic-importing the Grok CLI entrypoint (passed via
// OS8_GROK_ENTRYPOINT). Grok CLI sees `-p <prompt>` and runs normally.
//
// .mjs because @vibe-kit/grok-cli is ESM ("type":"module").

import { readFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const promptFile = process.env.OS8_GROK_PROMPT_FILE;
const entrypoint = process.env.OS8_GROK_ENTRYPOINT;

if (!promptFile || !entrypoint) {
  console.error('[grok-shim] Missing OS8_GROK_PROMPT_FILE or OS8_GROK_ENTRYPOINT');
  process.exit(1);
}

const prompt = readFileSync(promptFile, 'utf8');

process.on('exit', () => {
  try { rmSync(promptFile, { force: true }); } catch {}
});

// xAI deprecated the `search_parameters` field on Chat Completions (HTTP 410
// "Live search is deprecated. Please switch to the Agent Tools API"). The
// installed @vibe-kit/grok-cli still attaches `search_parameters: {mode}` on
// every request — including `mode: "off"` — so the API rejects them all.
// Strip the field at the fetch layer before grok-cli imports the OpenAI SDK
// so the SDK never sees it. Patch survives until grok-cli ships a fix.
const origFetch = globalThis.fetch;
globalThis.fetch = async function strippingFetch(input, init) {
  const url =
    typeof input === 'string' ? input :
    input instanceof URL ? input.href :
    input?.url;
  if (url?.includes('api.x.ai/') && init?.body && typeof init.body === 'string') {
    try {
      const body = JSON.parse(init.body);
      if (body && typeof body === 'object' && 'search_parameters' in body) {
        delete body.search_parameters;
        return origFetch.call(this, input, { ...init, body: JSON.stringify(body) });
      }
    } catch {
      // Body wasn't JSON — leave it alone.
    }
  }
  return origFetch.call(this, input, init);
};

const passthroughArgs = process.argv.slice(2);
process.argv = [process.argv[0], entrypoint, '-p', prompt, ...passthroughArgs];

await import(pathToFileURL(entrypoint).href);
