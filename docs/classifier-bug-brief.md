# Classifier Bug Brief

## What the classifier does

When a user sends a message to an agent, the system first classifies the message as **CONVERSATIONAL** or **TOOL_USE** before deciding how to handle it.

- **CONVERSATIONAL** → runs through the subconscious context curation pipeline (lightweight, no CLI tools)
- **TOOL_USE** → spawns the full CLI agent (planning cascade, tool access, heavier)

This classification happens in `SubconsciousService.classifyAction()` at `src/services/subconscious.js:252`.

The caller is `src/assistant/message-handler.js:219` (and `:1231` for the chat path). If classification fails or is unavailable, it **defaults to TOOL_USE** — the safe but expensive path.

## How it's supposed to work

1. Resolve the **summary cascade** from OS8 Settings → AI Models to get the model and auth method (login vs API key)
2. Send the classification prompt as a **system message** with recent conversation as the **user message**
3. The model outputs one word: `TOOL_USE` or `CONVERSATIONAL`
4. Parse the output — if it contains "CONVERSATIONAL", route to subconscious; otherwise route to CLI

The classification prompt (`CLASSIFY_PROMPT` at line 213):

```
You are an action classifier. Given a short conversation snippet, classify the user's MOST RECENT message.

- TOOL_USE: The message requests action — building apps, creating things, generating images, editing code, API calls, web searches, calendar lookups, file operations, memory writes, planning, or any operation beyond producing text.
- CONVERSATIONAL: The message is purely conversational — chatting, reflecting, opinions, feelings, stories, or questions answerable from memory.

Output exactly one word: TOOL_USE or CONVERSATIONAL

When in doubt, output TOOL_USE.
```

The user message sent alongside is a snippet of the last 5 conversation turns (each truncated to 300 chars) plus the current message:

```
Agent: [last reply truncated]
User: [previous message truncated]
Agent: [last reply truncated]
User: Hi
```

## The two bugs

### Bug 1: Not respecting the summary cascade auth method

The classifier originally used `AnthropicSDK.sendMessage()` — a direct Anthropic API call that requires `ANTHROPIC_API_KEY`. It ignored the routing cascade's `accessMethod` entirely.

When the user's API credits ran out (or they configure Anthropic to login-only in OS8 Settings), the SDK call fails with a 400 billing error. The classifier catches the error and defaults to TOOL_USE, so every message gets routed to the heavy CLI path.

**What needs to happen:** The classifier should resolve the summary cascade via `RoutingService.resolve(db, 'summary')` and use whatever model + auth method is at the top. If that's `claude-haiku via login`, it should use the CLI with login auth — not the SDK.

The current code (after our changes) does resolve the summary cascade and branches:
- `accessMethod === 'api'` → SDK path (works when API key has credits)
- else → CLI path with `--system-prompt` flag

### Bug 2: CLI path may not be feeding the prompt correctly

When using the CLI path (login auth), we need to send the classification prompt as a **system prompt**, not as part of the user message. Claude CLI has `--system-prompt <prompt>` for this.

The current code passes `systemPrompt: CLASSIFY_PROMPT` to `backend.buildArgs()`, which maps to `--system-prompt`. The snippet goes as the positional arg (user message).

**The concern:** We haven't been able to verify this actually works end-to-end. The CLI path was classifying "Hi" as TOOL_USE, which is wrong. Possible issues:

1. **`--system-prompt` may be overridden** by Claude Code's own system prompt, or the flag may behave as `--append-system-prompt` rather than replacing the system prompt entirely. If Claude Code's agentic system prompt (which describes coding tools) is still present, the model sees tool definitions and may bias toward TOOL_USE.

2. **`--max-turns 0`** — we pass this to prevent tool use, but it's unclear if Claude CLI supports `0` as a value. If it errors or gets ignored, the model might attempt tool calls.

3. **`streamJson: true` + `attachStreamParser`** — the response parsing assumes stream-json format. If the CLI outputs something unexpected in this mode (especially with `--max-turns 0` and no `--dangerously-skip-permissions`), the parser might not capture the output correctly, leaving `outputText` empty. Empty string → `!output.includes('CONVERSATIONAL')` → TOOL_USE.

4. **`skipPermissions: false`** — without `--dangerously-skip-permissions`, Claude CLI may prompt for permission or behave differently in headless `-p` mode.

## Key files

| File | What's there |
|------|-------------|
| `src/services/subconscious.js` | `classifyAction()` (line ~252), `CLASSIFY_PROMPT` (line 213), `isAvailable()`, `process()` |
| `src/services/anthropic-sdk.js` | `sendMessage()` — direct API, needs `ANTHROPIC_API_KEY`, can set system prompt cleanly |
| `src/services/routing.js` | `resolve(db, 'summary')` — walks summary cascade, returns `{ familyId, backendId, modelArg, accessMethod }` |
| `src/services/backend-adapter.js` | `buildArgs()` — builds CLI flags including `--system-prompt` (line ~116) |
| `src/services/cli-runner.js` | `prepareSpawnEnv()`, `createProcess()`, `attachStreamParser()` |
| `src/services/digest-engine.js` | Also uses summary cascade + SDK for memory digests — same auth issue |
| `src/assistant/message-handler.js` | Calls `classifyAction()` at lines 219 and 1231 |

## Debugging approach

1. Add `console.log` to the CLI path in `classifyAction()` to print the exact args array being passed to `createProcess`, and the raw `outputText` before parsing
2. Try running the equivalent claude command manually in terminal:
   ```
   claude -p --system-prompt "You are an action classifier..." --model haiku --output-format stream-json --max-turns 0 "User: Hi"
   ```
3. Check if `--system-prompt` actually replaces or appends to Claude Code's default system prompt
4. Check if `--max-turns 0` is valid / what happens without `--dangerously-skip-permissions`
5. If the CLI approach can't work cleanly, consider an alternative: the Anthropic SDK with the user's API key should work when credits are available — the billing error may just need the user to verify their key in OS8 Settings → Environment Variables matches their funded account

## Digest engine (`src/services/digest-engine.js`)

Same underlying issue. The digest engine uses `AnthropicSDK.sendMessage()` to compress conversation blocks into summaries. When the summary cascade routes to login, the SDK can't authenticate.

Current state: we added a check that skips the digest tick when summary routing is login-only (`accessMethod !== 'api'`). This prevents error spam but means **no digests are created** when on login auth. The digest engine would need the same CLI-with-`--system-prompt` treatment if we want it to work with login, though digests are less latency-sensitive so CLI overhead is acceptable.
