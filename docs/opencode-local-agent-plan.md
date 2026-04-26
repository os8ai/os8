# OpenCode-as-Local-Agent Plan

**Goal.** Make OS8's local-mode chat as tool-capable as proprietary-mode (Opus + Claude Code), by spawning the **OpenCode CLI** as the agent runtime instead of doing single-shot HTTP calls to vLLM.

**Headline.** This isn't "tool use for chat" — it's tool use for *everything the agent does in local mode*. Today every capability the agent invokes via curl (image gen, Telegram, Google APIs, scheduling, skills, plans, …) is broken in local mode for one reason: no tool loop. OpenCode supplies the loop. The full coverage table is in §11.

**Symmetry target.**

| Mode | Model | Agent runtime | Loop runner |
|---|---|---|---|
| Proprietary (Opus / Sonnet) | Claude 4.x | Claude Code CLI | the CLI |
| Proprietary (Gemini / Codex / Grok) | their models | their CLIs | the CLI |
| Local (today) | AEON-7 / Qwen | OS8's `createHttpProcess` | nobody — broken |
| **Local (target)** | **AEON-7 / Qwen** | **OpenCode CLI** | **the CLI** |

OS8 stays in its existing role: spawn, capture stream-json, render via translator. No tool registry, no agent loop inside OS8.

---

## 1. Empirical pre-test results — **PASS**

Tested OpenCode 1.14.25 (already installed at `/home/leo/.opencode/bin/opencode`) against the running launcher (vLLM serving `aeon-7-gemma-4-26b` on port 8002, confirmed via `GET http://localhost:9000/api/status`).

**Invocation that works:**

```bash
OPENCODE_CONFIG_CONTENT='{"$schema":"https://opencode.ai/config.json",
  "provider":{"local":{
    "npm":"@ai-sdk/openai-compatible",
    "name":"OS8 Local",
    "options":{"baseURL":"http://localhost:8002/v1","apiKey":"dummy"},
    "models":{"aeon-7-gemma-4-26b":{"name":"aeon-7-gemma-4-26b"}}
  }},
  "model":"local/aeon-7-gemma-4-26b"
}' \
opencode run \
  --dangerously-skip-permissions \
  --format json \
  --model "local/aeon-7-gemma-4-26b" \
  "<message>"
```

This is the same env-var shape the launcher's manifest already uses (`os8-launcher/clients/opencode/manifest.yaml:18`) — we reuse it, computing `{port}` and `{served_model_name}` at OS8 spawn time from the launcher's `/api/status`.

**Functional results.** AEON-7 driven by OpenCode actually does tool use:

| Test prompt | What happened | Verdict |
|---|---|---|
| "Read `hello.txt` and tell me its contents." | `read({filePath:"hello.txt"})` → "Hello there from a file!" | ✅ |
| "Run `date +%Y-%m-%d` and tell me what today is." | `bash({command:"date +%Y-%m-%d"})` → "2026-04-26" | ✅ |
| "Curl `localhost:8888/api/system/time`, then tell me the time." | `bash({command:"curl …"})` → "10:11 AM EDT" | ✅ |
| "List files; then read `AGENTS.md`; then summarize." | `bash(ls)` → `read(AGENTS.md)` → text summary, three steps in one run | ✅ |
| "What's the secret token? (with `AGENTS.md` in cwd containing the token)" | Model included `ULTRA_SECRET_TOKEN_XJ4239` and obeyed instruction in `AGENTS.md` | ✅ |

**Instruction-file convention.** OpenCode auto-loads `AGENTS.md` from cwd as the system prompt — same convention as Codex (verified empirically: a freshly-named `test-instructions.md` was *not* loaded; renaming to `AGENTS.md` was). It does **not** load `CLAUDE.md`.

**Stdout format under `--format json`.** JSONL with these top-level shapes (one object per line, well-formed JSON, no ANSI):

```jsonc
// step boundary (open)
{"type":"step_start","sessionID":"ses_…","timestamp":…,
 "part":{"type":"step-start","id":"prt_…","messageID":"msg_…","sessionID":"ses_…"}}

// atomic tool call — already completed when emitted, with input AND output
{"type":"tool_use","sessionID":"ses_…","timestamp":…,
 "part":{"type":"tool","tool":"<read|bash|write|edit|…>","callID":"chatcmpl-tool-…",
  "state":{"status":"completed","input":{…args…},"output":"<string>",
           "metadata":{…},"title":"<short label>","time":{"start":…,"end":…}},
  "id":"prt_…","messageID":"msg_…","sessionID":"ses_…"}}

// step boundary (close)
{"type":"step_finish","sessionID":"ses_…","timestamp":…,
 "part":{"type":"step-finish","reason":"tool-calls"|"stop",
         "id":"prt_…","messageID":"msg_…",
         "tokens":{"total":…,"input":…,"output":…,"reasoning":…,"cache":{"write":…,"read":…}},
         "cost":…}}

// final assistant text — full text in one shot, NOT delta
{"type":"text","sessionID":"ses_…","timestamp":…,
 "part":{"type":"text","id":"prt_…","messageID":"msg_…","sessionID":"ses_…",
         "text":"<full message>","time":{"start":…,"end":…}}}
```

**Format gotchas worth noting now:**

1. Tool calls are **atomic** — `tool_use` arrives once, already with `state.status: "completed"`, `state.input`, and `state.output`. There's no Claude-style streaming `START → ARGS → END → RESULT`. Translator collapses to `TOOL_CALL_START` + `TOOL_CALL_END` + `TOOL_CALL_RESULT` in one beat (same shape as `CodexTranslator._handleItemStarted/Completed` in `src/services/backend-events.js:479-543`).
2. Text is **not streamed** — final text arrives as a single `text` event per step. Translator collapses `TEXT_MESSAGE_START + CONTENT + END` into one beat (same shape as `CodexTranslator` for `agent_message`).
3. There's **no top-level `result` event**. The run ends when the last `step_finish` has `reason: "stop"`. Translator must synthesize `RUN_FINISHED` on process exit (or on detecting the terminal `step_finish` with `reason: "stop"`).
4. `sessionID` (`ses_*`) is on every event from the first one — translator captures it as `runId` immediately.
5. Tool names observed: `read`, `bash`. OpenCode's standard set also includes `write`, `edit`, `glob`, `grep`, `webfetch`, `task` — the translator should pass `toolCallName` through verbatim regardless of name.

**Conclusion.** Premise is verified. AEON-7 + OpenCode genuinely drives multi-step tool use against a real OS8 endpoint. Plan below proceeds.

---

## 2. Backend adapter — `BACKENDS.opencode` in `src/services/backend-adapter.js`

Modeled on **`codex`** (`src/services/backend-adapter.js:360-546`) — closest cousin: OpenAI-shape API under the hood, identity preamble for non-Anthropic models, atomic JSONL events.

**Backend ID.** `opencode` — matches the existing `ai_containers` row at `src/db/seeds.js:36`, matches `pty.js:80`'s terminal entry, follows the `backendId === containerId` convention used by every other backend.

```js
opencode: {
  id: 'opencode',
  command: 'opencode',                 // resolved via prepareEnv PATH (~/.opencode/bin)
  instructionFile: 'AGENTS.md',        // confirmed empirically — opencode auto-loads this
  label: 'OpenCode',
  supportsImageInput: false,           // CLI has no --image flag; multimodal would need rework
  supportsImageViaFile: false,
  supportsImageDescriptions: false,    // see §4 — vision turns fall back to HTTP `local`
  supportsMaxTurns: false,             // no --max-turns equivalent; rely on model's natural stop
  supportsStreamJson: true,            // --format json is JSONL
  promptViaStdin: false,               // positional fits; revisit if ARG_MAX bites

  // Reused from a shared NON_ANTHROPIC_IDENTITY_PREAMBLE constant (§3) so
  // codex and opencode never drift — they share AGENTS.md.
  identityPreamble: NON_ANTHROPIC_IDENTITY_PREAMBLE,

  buildArgs(options = {}) {
    const { skipPermissions = true, json = true, streamJson = true, model } = options;
    const args = ['run'];
    if (skipPermissions) args.push('--dangerously-skip-permissions');
    if (streamJson || json) args.push('--format', 'json');
    if (model) args.push('--model', model);   // model arg shape: "local/<served_model_name>"
    return args;
  },

  buildPromptArgs(message) {
    // OpenCode takes the message as positional [message..]. ARG_MAX on the
    // Spark is ~2 MB; enriched messages cap around 100 KB, so positional is
    // safe. Switch to stdin if/when we hit limits.
    return [message];
  },

  parseResponse(output) {
    // Walk JSONL — last `text` part wins (final assistant turn).
    const lines = output.split('\n').filter(l => l.trim());
    let text = '';
    for (const line of lines) {
      try {
        const j = JSON.parse(line);
        if (j.type === 'text' && j.part?.text) text = j.part.text;
      } catch (_) {}
    }
    return { text, sessionId: null, raw: null };
  },

  parseStreamJsonOutput(output) {
    const parsed = this.parseResponse(output);
    return { result: parsed.text, sessionId: null, raw: parsed.raw };
  },

  buildTextOnlyArgs(_options = {}) {
    // Not applicable — text-only utility paths use the local HTTP backend's
    // sendTextPromptHttp, NEVER opencode. Return [] defensively.
    return [];
  },

  prepareEnv(baseEnv = process.env) {
    const env = { ...baseEnv };
    delete env.CLAUDECODE;
    const { getExpandedPath } = require('../utils/cli-path');
    env.PATH = getExpandedPath() + ':' + (process.env.HOME || '') + '/.opencode/bin';
    // Provider config — point opencode at the launcher's currently-serving vLLM port.
    // Computed by the dispatcher at spawn time (see §6) and passed through here.
    if (env.OS8_OPENCODE_BASE_URL && env.OS8_OPENCODE_MODEL_ID) {
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        provider: { local: {
          npm: '@ai-sdk/openai-compatible',
          name: 'OS8 Local',
          options: { baseURL: env.OS8_OPENCODE_BASE_URL, apiKey: 'dummy' },
          models: { [env.OS8_OPENCODE_MODEL_ID]: { name: env.OS8_OPENCODE_MODEL_ID } }
        } },
        model: `local/${env.OS8_OPENCODE_MODEL_ID}`
      });
    }
    return env;
  }
}
```

**Notable contrasts with `codex`:**

| Aspect | codex | opencode |
|---|---|---|
| Subcommand | `exec` | `run` |
| Output flag | `--json` | `--format json` |
| Skip-permission flag | `--dangerously-bypass-approvals-and-sandbox` | `--dangerously-skip-permissions` |
| Prompt delivery | stdin (`promptViaStdin: true`) | positional |
| Image flags | `--image <path>` (file) | none — vision turns route to HTTP `local` (§4) |
| Provider config | OS env (OPENAI_API_KEY) | inline JSON via `OPENCODE_CONFIG_CONTENT` env |
| Workspace expansion | `--add-dir <blob>` | not needed — OpenCode reads cwd freely |

---

## 3. Instruction file: `AGENTS.md`, shared with codex

`AIRegistryService.getContainers(db)` returns the `opencode` container at `display_order=5` with `instruction_file='AGENTS.md'` (after the seed change in §9). `writeAllBackendFiles` (`src/claude-md.js:51-68`) iterates containers in display order and writes each one's instruction file. Both `codex` (display_order=2) and `opencode` (display_order=5) map to the same `AGENTS.md`; the **last writer wins**.

**Resolution: shared `NON_ANTHROPIC_IDENTITY_PREAMBLE` constant** at the top of `src/services/backend-adapter.js`. `BACKENDS.codex.identityPreamble` and `BACKENDS.opencode.identityPreamble` both reference it. This eliminates drift without changing the loop's semantics:

```js
// src/services/backend-adapter.js — top of file
const NON_ANTHROPIC_IDENTITY_PREAMBLE = `## Identity Contract (High Priority)

- You are {{ASSISTANT_NAME}}.
- In normal conversation, identify as {{ASSISTANT_NAME}} (e.g., "I am {{ASSISTANT_NAME}}.").
- Do not mention the underlying model or runtime (Codex/ChatGPT/GPT/OpenCode/local model names) unless {{OWNER_NAME}} explicitly asks technical details.
- If asked technically, reply: "I am {{ASSISTANT_NAME}}, currently running on <backend>."
- Treat MYSELF.md and USER.md as first-person ground truth for identity, voice, values, boundaries, and relationship stance.
- Do not frame MYSELF.md as a roleplay, mask, or character.
- Maintain continuity across turns using memory, timeline, and current images/context.
- Default to {{ASSISTANT_NAME}}'s tone and behavior; avoid meta "as an AI" language unless required for safety.
- On instruction conflicts: safety/boundaries first, then this contract, then MYSELF.md/USER.md, then other style guidance.
- When uncertain, choose the response that best preserves {{ASSISTANT_NAME}}'s identity and established boundaries.
- Image ownership: Unless explicitly labeled otherwise, all current/timeline/panorama images are of you ({{ASSISTANT_NAME}}); only the USER-section reference image is {{OWNER_NAME}}.

---

`;

// later
codex:    { …, identityPreamble: NON_ANTHROPIC_IDENTITY_PREAMBLE, … }
opencode: { …, identityPreamble: NON_ANTHROPIC_IDENTITY_PREAMBLE, … }
```

The model-name list in line 3 is broadened to cover both Codex/GPT and OpenCode/local model names, so the constraint "don't out yourself as the underlying model" applies whichever backend is active.

---

## 4. Routing — split `resolve()` for agent-spawn vs. utility

**The problem.** `RoutingService.resolve(db, taskType, agentOverride)` is called from many places:

- Subconscious classifier (`SubconsciousService.classifyAction`) — uses task type **`summary`** — wants HTTP for cheap text
- Plan generator (`PlanGenerator`) — wants HTTP for cheap text
- Various other utility text calls — same
- **Agent CLI spawn from `message-handler.js`** — should now want CLI (`opencode`)

A naïve "swap `local` → `opencode` whenever local-mode chat" inside `resolve()` would route the cheap subconscious classifier through OpenCode (a multi-second tool-loop spawn for every "hi"). That breaks the cheap-path optimization.

**The fix.** Add a `purpose` parameter to `resolve()`. Default `'utility'` keeps every existing caller's behavior. Only `message-handler.js` passes `'agentSpawn'`.

```js
// src/services/routing.js — modified resolve()
resolve(db, taskType, agentOverride = null, opts = {}) {
  const { purpose = 'utility' } = opts;
  // … existing local-mode chat short-circuit (lines 112-126) …
  if (this.getMode(db) === 'local' && CHAT_TASKS.has(taskType)) {
    const family = _resolveLocalChatFamily(db);
    if (family) {
      const base = {
        familyId: family.id,
        // KEY DIFF: 'utility' stays on HTTP; 'agentSpawn' switches to opencode CLI
        backendId: purpose === 'agentSpawn' ? 'opencode' : family.container_id,
        modelArg: AIRegistryService.resolveModelArg(db, family.id),
        accessMethod: 'api',
        source: purpose === 'agentSpawn'
          ? 'local_launcher_selection_opencode'
          : 'local_launcher_selection'
      };
      return _withLauncher(family, base);
    }
  }
  // … rest of resolve unchanged …
}
```

**Caller change.** Two sites in message-handler (`/send` and `/chat`):

```js
// src/assistant/message-handler.js:351 (and parallel /chat site near line 1234)
resolved = RoutingService.resolve(db, cliTaskType, agentOverride, { purpose: 'agentSpawn' });
```

Plus a new re-resolve when `cliTaskType === 'conversation' && useDirectResponse === false` (the rare CONVERSATIONAL-but-no-recommendedResponse path — without this, that path stays on HTTP `local` and never gets tool use). Details in §9.

**Vision dispatch interaction.** Decision: when an image is attached in local mode, **route to HTTP `local` for that turn** (existing path). Tool use is disabled for that turn; multimodal vision via `qwen3-6-35b-a3b` is preserved. Implementation: `maybeSwapForVision` (`src/services/routing.js:342`) keeps returning `backendId: 'local'`, and the `agentSpawn` swap to opencode does *not* override that. In code:

```js
// In message-handler, after maybeSwapForVision:
if (resolved.backendId !== 'local' /* i.e. vision-swap didn't fire */) {
  resolved = RoutingService.resolve(db, cliTaskType, agentOverride, { purpose: 'agentSpawn' });
}
```

This keeps the privacy/local-only promise and avoids the failure mode of a Gemini-vision text-description fallback that requires a cloud key.

---

## 5. Stream translator — `OpenCodeTranslator` in `src/services/backend-events.js`

Sibling of `ClaudeTranslator` / `GeminiTranslator` / `CodexTranslator`. Closest existing model: **`CodexTranslator`** (atomic tool calls, single-shot final text).

```js
class OpenCodeTranslator {
  constructor({ runId } = {}) {
    this.runId = runId || null;
    this._runStartedEmitted = false;
    this._runFinishedEmitted = false;
  }

  translate(event) {
    if (!event || typeof event !== 'object') return [];

    // Capture sessionID as runId on first sight (every event carries it).
    if (event.sessionID && !this.runId) {
      this.runId = event.sessionID;
    }

    const out = [];
    if (!this._runStartedEmitted && this.runId) {
      out.push({ type: RUN_STARTED, runId: this.runId });
      this._runStartedEmitted = true;
    }

    const part = event.part;
    if (!part) return out;

    switch (event.type) {
      case 'step_start':
      case 'step_finish':
        // step_finish with reason==='stop' is our cue to emit RUN_FINISHED
        // (no top-level result event in opencode).
        if (event.type === 'step_finish' && part.reason === 'stop' && !this._runFinishedEmitted) {
          out.push({ type: RUN_FINISHED, runId: this.runId, status: 'completed' });
          this._runFinishedEmitted = true;
        }
        return out;

      case 'tool_use': {
        // Atomic — START + END + RESULT in one beat (mirrors CodexTranslator).
        const toolCallId = part.callID;
        const toolCallName = part.tool;
        const args = part.state?.input;
        const output = part.state?.output;
        const isError = part.state?.status && part.state.status !== 'completed';
        out.push({
          type: TOOL_CALL_START,
          runId: this.runId,
          parentMessageId: part.messageID,
          toolCallId,
          toolCallName,
          args
        });
        out.push({ type: TOOL_CALL_END, runId: this.runId, toolCallId });
        out.push({
          type: TOOL_CALL_RESULT,
          runId: this.runId,
          toolCallId,
          content: output,
          isError
        });
        return out;
      }

      case 'text': {
        // Single-shot text — collapse START/CONTENT/END.
        const messageId = part.messageID || part.id;
        const text = part.text || '';
        out.push({ type: TEXT_MESSAGE_START, runId: this.runId, messageId, role: 'assistant' });
        out.push({ type: TEXT_MESSAGE_CONTENT, runId: this.runId, messageId, delta: text });
        out.push({ type: TEXT_MESSAGE_END, runId: this.runId, messageId });
        return out;
      }

      default:
        return out;
    }
  }

  reset() {
    this._runStartedEmitted = false;
    this._runFinishedEmitted = false;
  }
}
```

**Factory wiring** (`src/services/backend-events.js:557-571`):

```js
function createTranslator(backendId, opts = {}) {
  switch (backendId) {
    case 'claude':   return new ClaudeTranslator(opts);
    case 'local':    return new ClaudeTranslator(opts);   // existing — HTTP synth path
    case 'gemini':   return new GeminiTranslator(opts);
    case 'codex':    return new CodexTranslator(opts);
    case 'opencode': return new OpenCodeTranslator(opts); // NEW
    default: return null;
  }
}
```

**In-band line-parse path in message-handler.** The streaming loop (`src/assistant/message-handler.js:929-1095`) extracts a `streamingText` per JSON line for the [internal:] / [react:] tag-stripping display buffer. Add an opencode branch keyed on `event.type === 'text'` that mirrors the Codex `item.completed/agent_message` branch. Then on process exit, when `backendId === 'opencode'`, run the existing `result`-cleanup block as if a `result` event arrived (strip notes, extract reactions, broadcast `RUN_FINISHED` if not already done) — since OpenCode emits no top-level `result`. This is the most fiddly part of the implementation.

---

## 6. Config plumbing — env vars at spawn time

**What OpenCode needs to know about the launcher:**

- vLLM `baseURL` — `http://localhost:<port>/v1`
- Served model name — same string the OpenAI `model` field expects

**Where these come from in OS8.** `routing.js::_withLauncher` already attaches `launcher_model` + `launcher_backend` to the resolved object for local families (`src/services/routing.js:35-38`). Then `cli-runner.js::createHttpProcess` calls `LauncherClient.ensureModel({model:launcher_model, backend:launcher_backend})` and gets back `{ base_url, model, instance_id, status }` (`src/services/cli-runner.js:312-353`).

For the `opencode` backend, dispatch lives in `cli-runner.js::createProcess` (the spawn path, not the http path). We need the same ensure-then-spawn flow. Concretely:

**Modify `createProcess`** (`src/services/cli-runner.js:149`) to handle a new branch *before* the PTY/spawn fork:

```js
if (backend.id === 'opencode' && launcherModel) {
  return createOpenCodeProcess(backend, args, {
    cwd, env, launcherModel, launcherBackend, model, stdinData, promptViaStdin
  });
}
```

`createOpenCodeProcess` is a small async wrapper that:

1. Calls `LauncherClient.ensureModel(...)` (with the same loading-poll loop as `createHttpProcess`, `cli-runner.js:325-349`). On `MODEL_LOAD_TIMEOUT` or other launcher errors, emits the same `launcher_error:` exit code so existing UI pickup works.
2. Augments `env` with `OS8_OPENCODE_BASE_URL=<base_url>` and `OS8_OPENCODE_MODEL_ID=<model_id>`.
3. Sets the `--model` arg to `local/<model_id>` (matching the inline provider config in `OPENCODE_CONFIG_CONTENT`).
4. Spawns `opencode run …` via `child_process.spawn` (no PTY — `--format json` produces clean JSONL on a piped stdout, but a PTY would inject ANSI on the TUI default).
5. Returns the same `{ onData, onExit, kill, pid, stdin }` shape as `createProcess`'s spawn branch.
6. `LauncherClient.touch(instance_id)` on exit, fire-and-forget (matches HTTP path).

**Why an inline wrapper instead of reusing `createHttpProcess`.** The HTTP path emits synthesized stream-json itself; the OpenCode path delegates streaming to the actual CLI. Same ensure-model logic, different transport — copy the ensure-loop, don't reuse it (it's ~50 lines and pulling it into a shared helper is a separate refactor).

---

## 7. Local container's `show_in_terminal` and the assistant chat-model selector

`src/db/seeds.js:151` already sets `show_in_terminal = 0` for the `local` container. The new `opencode` container stays hidden the same way (`show_in_terminal = 0`). Rationale: the launcher dashboard already provides a way to launch opencode interactively, and the principle that "the launcher chooses what's local-mode active" stays clean. Users who want a debug REPL launch it from `./launcher` directly.

`src/templates/assistant/src/components/SettingsPanel.jsx:288` (`backendValue = effectiveConfig.agentModel`) reads `agentModel`, which is a **family ID**, not a backend. The local-mode chat-model UI is already locked read-only by 0.4.8 (`src/migrations/0.4.8-resync-assistant-chat-model.js`), redirecting users to the launcher chooser. Nothing changes there.

---

## 8. Subconscious / utility paths — explicit "must not regress" checklist

**Classifier mechanics (per `src/services/subconscious.js:205-316`).** The classifier (`SubconsciousService.classifyAction`) runs on every chat turn when subconscious is enabled. It uses task type **`summary`** (not `conversation`), `maxTokens: 8`, 15s timeout, with `CLASSIFY_PROMPT` as system prompt — the model emits literally one word: `TOOL_USE` or `CONVERSATIONAL`. Fail-safe defaults to `TOOL_USE` on any error. The call goes through `sendTextPrompt` → `sendTextPromptHttp` (HTTP `local` backend) — never spawns a CLI.

| Path | Today's resolve | After change | Action needed |
|---|---|---|---|
| `SubconsciousService.classifyAction` | `resolve('summary')` → `local` (HTTP) | unchanged (default `purpose='utility'`) | none |
| `SubconsciousService.process` (recommended-response) | `resolve('conversation')` → `local` (HTTP) | unchanged | none |
| `PlanGenerator` (planning prompt) | `resolve('planning')` → `local` (HTTP) | unchanged | none |
| `cli-runner.js::sendTextPrompt` (utility text) | routes by `backend.type==='http'` to `sendTextPromptHttp` | unchanged — opencode has no `type:'http'`, so this branch never fires for opencode | none |
| `message-handler.js` agent CLI spawn (post-classifier `planning`) | `resolve('planning')` → `local` (HTTP, broken tool use) | `resolve('planning', …, {purpose:'agentSpawn'})` → `opencode` (CLI, real tool use) | edit at `message-handler.js:351` and the parallel `/chat` site |
| `message-handler.js` agent CLI spawn (no classifier OR CONVERSATIONAL-with-no-recommendedResponse) | original `resolve('conversation')` → `local` (HTTP, broken tool use) | re-resolve with `purpose:'agentSpawn'` whenever `useDirectResponse === false` | small refactor — see §9 step B4 |
| `message-handler.js` direct-response branch (CONVERSATIONAL + recommendedResponse) | no CLI spawn | unchanged | none |

**Same-model dual-call note for local mode.** Because the classifier uses `summary` (a CHAT_TASKS member) and the agent uses `planning`/`conversation` (also CHAT_TASKS), both resolve through the launcher's chat-role family in local mode — same model. Result: every turn invokes AEON-7 twice (classifier ~1s + agent loop). vLLM handles concurrency; no model-load thrash. The CLASSIFY_PROMPT's "OVERRIDE ALL OTHER INSTRUCTIONS" preamble is what keeps the persona model from responding in-character to its own classification call — sanity-test post-rollout to confirm AEON-7 + Qwen still respect that override under the new dispatch.

---

## 9. Sequencing & risk

### Phase A — adapter + translator + factory (low risk, isolated)

| Step | Files | Independent? | Risk |
|---|---|---|---|
| A1. Add `NON_ANTHROPIC_IDENTITY_PREAMBLE` constant; refactor `BACKENDS.codex.identityPreamble` to reference it; add `BACKENDS.opencode` entry referencing the same constant | `src/services/backend-adapter.js` | ✅ | Low — pure addition + tiny refactor; existing codex tests cover the preamble shape |
| A2. Add `OpenCodeTranslator` class + factory case | `src/services/backend-events.js` | ✅ | Low — pure addition |
| A3. Update `ai_containers` row: `instruction_file = 'AGENTS.md'` for `opencode`; new migration `0.4.9-opencode-agents-md.js` | `src/db/seeds.js`, `src/migrations/0.4.9-opencode-agents-md.js`, `package.json` (bump to 0.4.9) | ✅ | Low — DB row update only, idempotent |
| A4. Unit tests for `OpenCodeTranslator` (mirror `tests/services/backend-events.test.js` shape) | `tests/services/backend-events.test.js` | ✅ | Low |
| A5. Unit tests for `BACKENDS.opencode.parseResponse` and `parseStreamJsonOutput` | `tests/services/backend-adapter.opencode.test.js` (new) | ✅ | Low |

After Phase A the new code exists but nothing routes to it yet — safe to land.

### Phase B — dispatcher integration

| Step | Files | Depends on | Risk |
|---|---|---|---|
| B1. Add `purpose` param to `RoutingService.resolve()` | `src/services/routing.js` | A* | Medium — touches the central routing function. Mitigation: default `'utility'` keeps every existing caller untouched. |
| B2. Add `createOpenCodeProcess` (ensure-model + spawn) and a branch in `createProcess` | `src/services/cli-runner.js` | A1 | Medium — copies the ensure-loop from `createHttpProcess`. Mitigation: only fires when `backend.id === 'opencode'`. |
| B3. Pass `{purpose:'agentSpawn'}` at the message-handler resolve sites | `src/assistant/message-handler.js` | B1 | Medium — two sites in `/send`, two analogous sites in `/chat`. Test both paths. Skip the swap when vision-swap fired (preserves multimodal HTTP path). |
| B4. Re-resolve with `agentSpawn` whenever `useDirectResponse === false` (covers the CONVERSATIONAL-with-no-recommendedResponse fallthrough and the no-classifier path) | `src/assistant/message-handler.js` | B3 | Medium — alters existing control flow on a less-common path. |
| B5. Handle absent `result` event: synthesize cleanup-on-exit when `backendId === 'opencode'` | `src/assistant/message-handler.js` | A2, B3 | Medium — display-buffer / [internal:]-stripping path. |
| B6. Routing unit tests (purpose=agentSpawn returns opencode; default stays HTTP; vision-swap path doesn't get re-flipped) | `tests/services/routing.test.js`, `tests/services/routing-local-launcher-selection.test.js` | B1 | Low |
| B7. End-to-end-style test: spy on `createProcess` to confirm opencode invocation in local mode + assert the imagegen tool call lands | `tests/services/local-mode-route.test.js` | B2, B3 | Medium |

### Phase C — instruction file content

| Step | Files | Depends on | Risk |
|---|---|---|---|
| C1. Verified by code inspection: `AgentService.regenerateAllInstructions` runs on every server startup (`src/server.js:913`) and calls `generateAssistantClaudeMd` → `writeAllBackendFiles` → which after A3 includes opencode pointed at `AGENTS.md`. **No separate regen migration needed** — `AGENTS.md` is rewritten on the next OS8 restart. The 0.4.9 migration only updates the DB row. | none | A3 | Low |
| C2. Verify-after-restart pre-flight: open a freshly-restarted assistant agent dir, inspect `AGENTS.md`, confirm the imagegen capability is listed in the roster (per `generateCompactCapabilitiesRoster` at `claude-md.js:202`). | manual QA | C1 | Low |

`template-resync` does **not** apply here — `AGENTS.md` lives at the top level (user/agent-owned per `template-resync.js:23`'s `SHELL_OWNED_ROOTS = ['src', 'index.html']`). Instruction files are runtime-generated, not template-scaffolded.

### Phase D — soak / cleanup

| Step | Depends on | Notes |
|---|---|---|
| D1. Manual QA: tool use in local mode (Read/Bash/curl-OS8-API), multi-step chains, error path (opencode missing), launcher-down path | B*, C* | |
| D2. Capability tool-use coverage QA — exercise each row of §11's table once in local mode and confirm green | D1 | Special attention to **imagegen** (the user's primary motivating case) — see §12 |
| D3. Sanity-test the classifier post-OpenCode: confirm AEON-7 and Qwen still emit just `TOOL_USE`/`CONVERSATIONAL` from the CLASSIFY_PROMPT (no persona bleed) | D1 | Cheap check; just toggle `subconscious_memory` on, send a few messages, check `[Classifier]` log lines |
| D4. Drop the "broken tool use" line from any docs that mention local mode being chat-only | D1 | `README.md`, `docs/`, possibly `CLAUDE.md` |
| D5. Defer to a separate cleanup PR: remove the `tools` plumbing from `createHttpProcess` (`src/services/cli-runner.js:382-385`) — half-finished native tool-call path, now superseded by opencode for chat | D1 | Defer |

---

## 10. Locked design decisions (was: open questions)

All seven open questions resolved:

| # | Decision |
|---|---|
| 1 | **Backend ID = `opencode`.** Matches existing seed, terminal entry, and the `backendId === containerId` convention. |
| 2 | **Vision turns route to HTTP `local`.** Existing path — keeps multimodal vision via `qwen3-6-35b-a3b`, drops tool use for that single turn. Avoids cloud-key dependency that would contradict local-mode privacy. |
| 3 | **No separate regen migration.** `AgentService.regenerateAllInstructions` at `server.js:913` rewrites `AGENTS.md` for every agent on next OS8 startup. The 0.4.9 migration is DB-only. |
| 4 | **Shared `NON_ANTHROPIC_IDENTITY_PREAMBLE` constant** at top of `backend-adapter.js`. `codex` and `opencode` both reference it. Eliminates drift on the shared `AGENTS.md`. |
| 5 | **Classifier stays on the active chat model.** ~1s on AEON-7 is acceptable; a separate "classifier" role is a launcher-side question deferred as future work. |
| 6 | **Image gen IS in scope** as a primary beneficiary of OpenCode adoption (see §11, §12). Flux/ComfyUI HTTP service stays where it is; the agent's *call* to `/api/imagegen` becomes a real tool invocation under OpenCode. |
| 7 | **OpenCode container hidden from terminal dropdown** (`show_in_terminal=0`). Launcher dashboard owns interactive opencode launches. |

---

## 11. Capability tool-use coverage — what flips from broken to working

This is the headline benefit. Every capability the agent invokes via curl is broken in local mode today (no tool loop) and gets fixed by OpenCode adoption. No additional per-capability work is needed beyond the dispatcher change.

| Capability | What the agent does | Local mode today | After OpenCode |
|---|---|---|---|
| `imagegen` | `POST /api/imagegen` → Flux/ComfyUI generates → `[file:…]` tag in reply | ❌ | ✅ (see §12) |
| `telegram` | `POST /api/telegram/send-text` to DM owner | ❌ | ✅ |
| `google` | Calendar / Gmail / Drive REST | ❌ | ✅ |
| `youtube` | video info / transcript | ❌ | ✅ |
| `x` | search via Grok API (still cloud) | ❌ | ✅ |
| `speak` | `POST /api/speak` → audio file | ❌ | ✅ |
| `voicemessage` | voice DM via Telegram | ❌ | ✅ |
| `transcribe` | video → text via whisper | ❌ | ✅ |
| `app-db` / `app-blob` | per-app SQLite + file storage | ❌ | ✅ |
| `agent-jobs` | self-schedule timed jobs | ❌ | ✅ |
| `plan` | `/api/plans/*` create/approve/execute | ❌ | ✅ |
| `app-builder` / `app-enhancer` | scaffold + iterate apps | ❌ | ✅ |
| `skill-builder` | author new skills | ❌ | ✅ |
| `motivations-update`, `action-planner` | server-orchestrated agent jobs | ❌ | ✅ |
| MCP-discovered tools | `POST /api/mcp/{server}/{tool}` | ❌ | ✅ |
| Memory APIs (search, conversation stats, USER.md/MYSELF.md edits) | `/api/agent/:id/memory/*` | ❌ | ✅ |

Per Phase D2: exercise each row in local-mode QA before considering the change shipped.

---

## 12. Imagegen — locked decisions

Image generation is the user's primary motivating case. Three sub-decisions, all locked:

| Sub-decision | Locked choice | Rationale |
|---|---|---|
| **Default Flux variant for tool-driven calls** | `flux1-schnell` (4-step, ~3s) | Agent loop should stay snappy when an image is an aside in conversation. Users who specifically want `flux1-kontext-dev` (reference-image-conditioned, ~15s, higher quality) can pin it via the launcher's image-role chooser. |
| **Vision-introspection** ("describe what you generated") | **Don't try.** Agent returns the file tag without describing the result. | AEON-7 is text-only; auto-piping the result image through `qwen3-6-35b-a3b` for a description back to the chat model would add VRAM thrash and novel `ImageGenService` plumbing for a rare workflow. Users who need this can pin their agent to `qwen3-6-35b-a3b` and use the existing vision-swap helper. |
| **Capability roster verification** | **Pre-flight check in Phase C2.** Open a freshly-restarted assistant agent dir, inspect `AGENTS.md`, confirm imagegen is listed in the roster (per `generateCompactCapabilitiesRoster` at `claude-md.js:202`). | 30-second sanity check; the roster is dynamically generated, so a missing imagegen entry would mean the capability isn't installed/registered, not an OpenCode-specific bug. |

**End-to-end imagegen flow in local mode (post-rollout):**

1. User: "make me a sunset"
2. OpenCode (cwd = agent dir, `--model local/aeon-7-gemma-4-26b`) reads `AGENTS.md`, sees imagegen documented
3. AEON-7 emits a `bash` tool call: `curl -X POST http://localhost:8888/api/imagegen -d '{"prompt":"sunset","provider":"local"}'`
4. `ImageGenService` → `routing.resolve('image')` under local mode → picks `local-flux1-schnell` → ComfyUI generates → blob saved → URL returned
5. AEON-7 wraps the URL in `[file: chat-attachments/…]` → UI renders inline

No additional code lands for this beyond the dispatcher change in §4-§6. The flow falls out of the symmetry with Opus mode.
