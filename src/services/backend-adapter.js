/**
 * Backend Adapter
 * Maps backend ID → { command, flags, instruction filename, response parser }
 * Allows switching between Claude Code and Gemini CLI
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * Shared identity preamble for non-Anthropic-trained models that need explicit
 * identity framing to embody the assistant persona (Claude/Gemini handle this
 * naturally from MYSELF.md alone). Both `codex` and `opencode` reference this
 * — they share AGENTS.md, so a single source of truth prevents drift.
 *
 * Placeholders: {{ASSISTANT_NAME}}, {{OWNER_NAME}} replaced at generation time.
 */
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

/**
 * Shared buildImageFileArgs for backends that use --image filepath flags (Codex, Grok).
 * Write base64-encoded images to temp files and return --image args + text manifest.
 * @param {object} images - { presentMoment, panorama, owner, timeline, userAttachments }
 * @param {string} tempDir - Directory to write temp image files into
 * @param {object} names - { ownerName, assistantName } for label personalization
 * @returns {{ args: string[], manifest: string }}
 */
function sharedBuildImageFileArgs(images, tempDir, { ownerName = '', assistantName = '' } = {}) {
  const { presentMoment = {}, panorama, owner, timeline = [], userAttachments = [] } = images;
  const args = [];
  const manifestLines = [];
  let idx = 1;
  const ownerLabel = ownerName || 'your owner';
  const fromLabel = ownerName || 'user';
  const nameLabel = assistantName ? `, ${assistantName}` : '';

  const writeImage = (base64Data, label) => {
    const filePath = path.join(tempDir, `img-${idx}.jpg`);
    fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
    args.push('--image', filePath);
    manifestLines.push(`Image ${idx}: ${label}`);
    idx++;
  };

  if (presentMoment.thirdPerson?.data) {
    writeImage(presentMoment.thirdPerson.data, `Your current appearance${nameLabel} (third-person view)`);
  }
  if (presentMoment.pov?.data) {
    writeImage(presentMoment.pov.data, 'What you currently see (your POV)');
  }
  if (panorama?.contactSheet?.data) {
    writeImage(panorama.contactSheet.data, 'Panorama — your peripheral field of view (3x3 contact sheet)');
  }
  if (owner?.data) {
    writeImage(owner.data, `Your owner, ${ownerLabel} (reference photo)`);
  }
  for (const img of timeline) {
    if (img.data) {
      const ts = img.timestamp ? new Date(img.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
      const viewLabel = {
        'pov': 'Your POV',
        'chat_user': `Image from ${fromLabel}`,
        'chat_agent': 'Image you sent',
        'telegram_user': `Image from ${fromLabel} (Telegram)`,
        'third_person': 'Image of you (third person)'
      }[img.imageView] || 'Image';
      writeImage(img.data, `[${ts}] ${viewLabel} (timeline)`);
    }
  }
  for (const att of userAttachments) {
    if (att.data) {
      writeImage(att.data, `Image from ${fromLabel}: ${att.filename || 'image'}`);
    }
  }

  const manifest = manifestLines.length > 0
    ? '[Attached Images]\n' + manifestLines.join('\n') + '\n'
    : '';

  return { args, manifest };
}

const BACKENDS = {
  claude: {
    id: 'claude',
    command: 'claude',
    instructionFile: 'CLAUDE.md',
    label: 'Claude Code',
    supportsImageInput: true,
    supportsMaxTurns: true,
    supportsStreamJson: true,

    /**
     * Build CLI args for Claude Code
     */
    buildArgs(options = {}) {
      const {
        print = true,
        skipPermissions = true,
        streamJson = false,
        includePartialMessages = false,
        verbose = false,
        maxTurns,
        inputFormatStreamJson = false,
        json = false,
        model,
        systemPrompt,
      } = options;

      const args = [];
      if (print) args.push('-p');
      if (model) args.push('--model', model);
      if (verbose) args.push('--verbose');

      // Output format
      if (streamJson) {
        args.push('--output-format', 'stream-json');
      } else if (json) {
        args.push('--output-format', 'json');
      }

      if (includePartialMessages) args.push('--include-partial-messages');
      if (skipPermissions) args.push('--dangerously-skip-permissions');
      if (maxTurns != null) args.push('--max-turns', String(maxTurns));
      if (inputFormatStreamJson) args.push('--input-format', 'stream-json');
      if (systemPrompt) args.push('--system-prompt', systemPrompt);

      return args;
    },

    /**
     * Build the prompt argument for Claude Code
     * Claude uses -p as a bare flag and the message as the last positional arg
     * @param {string} message - The prompt text
     * @returns {string[]} Args to append
     */
    buildPromptArgs(message) {
      return [message];
    },

    /**
     * Parse JSON response from Claude CLI
     */
    parseResponse(output) {
      try {
        const response = JSON.parse(output);
        let text = '';
        let sessionId = response.session_id || null;

        if (response.result) {
          text = response.result;
        } else if (response.content && Array.isArray(response.content)) {
          text = response.content
            .filter(block => block.type === 'text')
            .map(block => block.text)
            .join('\n');
        } else if (typeof response === 'string') {
          text = response;
        }

        return { text, sessionId, raw: response };
      } catch (err) {
        return { text: output.trim(), sessionId: null, raw: null };
      }
    },

    /**
     * Parse stream-json output (multiple JSON lines)
     */
    parseStreamJsonOutput(output) {
      const lines = output.split('\n').filter(line => line.trim());
      let result = '';
      let sessionId = null;
      let raw = null;

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'result') {
            result = parsed.result || '';
            sessionId = parsed.session_id || sessionId;
            raw = parsed;
          }
          if (parsed.session_id && !sessionId) {
            sessionId = parsed.session_id;
          }
        } catch (e) {
          console.warn(`[backend-adapter] Claude batch parse skip: ${e.message} — ${line.substring(0, 200)}`);
        }
      }

      return { result, sessionId, raw };
    },

    /**
     * Build CLI args for text-only mode (no tool use, no permissions)
     * Used for server-side orchestration where the LLM only generates text.
     */
    buildTextOnlyArgs(options = {}) {
      const { model } = options;
      const args = ['-p'];
      if (model) args.push('--model', model);
      args.push('--max-turns', '1', '--output-format', 'json');
      return args;
    },

    /**
     * Prepare environment for Claude CLI
     */
    prepareEnv(baseEnv = process.env) {
      const env = { ...baseEnv };
      if (env.PATH && !env.PATH.includes('.local/bin')) {
        env.PATH = `${process.env.HOME}/.local/bin:${env.PATH}`;
      }
      // Strip CLAUDECODE env var — if OS8 was launched from a Claude Code session,
      // child Claude processes would refuse to start (nested session guard)
      delete env.CLAUDECODE;
      return env;
    }
  },

  gemini: {
    id: 'gemini',
    command: 'gemini',
    instructionFile: 'GEMINI.md',
    label: 'Gemini CLI',
    supportsImageInput: false,
    supportsImageDescriptions: true,
    supportsMaxTurns: false,
    supportsStreamJson: true,

    /**
     * Build CLI args for Gemini CLI
     * Note: Gemini's -p takes the prompt as its value: -p "message"
     * This is different from Claude where -p is a bare flag.
     * The caller must append the message via buildPromptArgs() after buildArgs().
     */
    buildArgs(options = {}) {
      const {
        skipPermissions = true,
        streamJson = false,
        json = false,
        print = true, // default to true
        model,
        appPath,
      } = options;

      const args = [];

      // For interactive mode (as called from AssistantProcess), use 'chat'
      if (!print) {
        args.push('chat');
      }

      // Model selection
      if (model) args.push('--model', model);

      // Output format — Gemini supports json and stream-json
      if (streamJson) {
        args.push('--output-format', 'stream-json');
      } else if (json) {
        args.push('--output-format', 'json');
      }

      // Auto-accept permissions (--yolo)
      if (skipPermissions) args.push('-y');

      // Expand workspace to include blob storage directory
      // Gemini restricts file access to CWD by default; blob is at ~/os8/blob/{appId}/{agentId}
      // while CWD is the agent dir
      if (options.blobDir && fs.existsSync(options.blobDir)) {
        args.push('--include-directories', options.blobDir);
      }

      return args;
    },

    /**
     * Build the prompt argument for Gemini CLI
     * Gemini uses -p "message" (prompt as flag value, enters headless mode)
     * @param {string} message - The prompt text
     * @returns {string[]} Args to append
     */
    buildPromptArgs(message) {
      return ['-p', message];
    },

    /**
     * Parse JSON response from Gemini CLI
     */
    parseResponse(output) {
      try {
        const response = JSON.parse(output);
        let text = '';

        if (response.result) {
          text = response.result;
        } else if (response.response) {
          text = response.response;
        } else if (response.content && Array.isArray(response.content)) {
          text = response.content
            .filter(block => block.type === 'text')
            .map(block => block.text)
            .join('\n');
        } else if (typeof response === 'string') {
          text = response;
        }

        return { text, sessionId: response.session_id || null, raw: response };
      } catch (err) {
        // Gemini may return plain text
        return { text: output.trim(), sessionId: null, raw: null };
      }
    },

    /**
     * Parse stream-json output from Gemini CLI
     */
    parseStreamJsonOutput(output) {
      const lines = output.split('\n').filter(line => line.trim());
      let result = '';
      let raw = null;

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'result') {
            result = parsed.result || '';
            raw = parsed;
          }
        } catch (e) {
          console.warn(`[backend-adapter] Gemini batch parse skip: ${e.message} — ${line.substring(0, 200)}`);
        }
      }

      // Fallback: if no result type found, try regular parse
      if (!result) {
        const parsed = this.parseResponse(output);
        return { result: parsed.text, sessionId: null, raw: parsed.raw };
      }

      return { result, sessionId: null, raw };
    },

    /**
     * Build CLI args for text-only mode (no tool use, no permissions)
     * Without -y, Gemini won't auto-accept tool calls.
     */
    buildTextOnlyArgs(options = {}) {
      const { model } = options;
      const args = [];
      if (model) args.push('--model', model);
      args.push('--output-format', 'json');
      return args;
    },

    /**
     * Prepare environment for Gemini CLI
     */
    prepareEnv(baseEnv = process.env) {
      const { getExpandedPath } = require('../utils/cli-path');
      const env = { ...baseEnv };
      delete env.CLAUDECODE;
      env.PATH = getExpandedPath();
      return env;
    }
  },

  codex: {
    id: 'codex',
    command: 'codex',
    instructionFile: 'AGENTS.md',
    label: 'Codex CLI',
    supportsImageInput: false,    // Codex doesn't support base64 stdin images
    supportsImageViaFile: true,   // Codex supports --image filepath flags
    supportsMaxTurns: false,
    supportsStreamJson: true,     // --json gives JSONL

    identityPreamble: NON_ANTHROPIC_IDENTITY_PREAMBLE,

    /**
     * Build CLI args for Codex CLI
     * Key flags: --json for structured output, --dangerously-bypass-approvals-and-sandbox
     * for full access, --model for model selection, --add-dir for blob access, --image for images
     */
    buildArgs(options = {}) {
      const {
        skipPermissions = true,
        streamJson = false,
        json = false,
        print = true,
        model,
        appPath,
        env,
      } = options;

      // 'exec' subcommand must come first — flags follow it
      const args = ['exec'];

      // Privacy flags — translate env vars into -c config overrides
      if (env) {
        if (env.CODEX_DISABLE_ANALYTICS) args.push('-c', 'analytics.enabled=false');
        if (env.CODEX_DISABLE_FEEDBACK) args.push('-c', 'feedback.enabled=false');
        if (env.CODEX_DISABLE_HISTORY) args.push('-c', 'history.persistence=none');
      }

      // Output format — --json gives JSONL output
      if (streamJson || json) {
        args.push('--json');
      }

      // Full access: skip approvals and sandbox
      if (skipPermissions) args.push('--dangerously-bypass-approvals-and-sandbox');

      // Model selection
      if (model) args.push('--model', model);

      // Expand workspace to include blob storage directory
      // Codex restricts file access like Gemini; blob is at ~/os8/blob/{appId}
      if (appPath) {
        const appId = path.basename(appPath);
        const blobDir = path.join(path.dirname(path.dirname(appPath)), 'blob', appId);
        args.push('--add-dir', blobDir);
      }

      return args;
    },

    /**
     * Whether the prompt should be piped via stdin instead of as a CLI argument.
     * Codex exec reads from stdin when no positional prompt is given.
     * This avoids ARG_MAX limits with large enriched messages (100K+ chars).
     */
    promptViaStdin: true,

    /**
     * Build the prompt argument for Codex CLI
     * Returns empty — the prompt is piped via stdin (see promptViaStdin flag).
     * The 'exec' subcommand is already included by buildArgs().
     * @param {string} message - The prompt text (piped via stdin, not used in args)
     * @returns {string[]} Args to append
     */
    buildPromptArgs(message) {
      return [];
    },

    /**
     * Parse JSON response from Codex CLI
     * Codex --json emits JSONL; for non-json mode, stdout is plain text
     */
    parseResponse(output) {
      // Try parsing as JSONL first (--json mode)
      const lines = output.split('\n').filter(line => line.trim());
      let text = '';

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          // Codex JSONL: item.completed with type 'agent_message' and text field
          if (parsed.type === 'item.completed' && parsed.item?.type === 'agent_message'
              && parsed.item?.text) {
            text = parsed.item.text;
          }
        } catch (e) {
          console.warn(`[backend-adapter] Codex batch parse skip: ${e.message} — ${line.substring(0, 200)}`);
        }
      }

      if (text) {
        return { text, sessionId: null, raw: null };
      }

      // Fallback: plain text output
      return { text: output.trim(), sessionId: null, raw: null };
    },

    /**
     * Parse JSONL output from Codex CLI (--json mode)
     * Events: item.completed with item.type 'agent_message' and item.text
     */
    parseStreamJsonOutput(output) {
      const lines = output.split('\n').filter(line => line.trim());
      let result = '';
      let raw = null;

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);

          // Claude/Gemini result type (unlikely from Codex but handle gracefully)
          if (parsed.type === 'result') {
            result = parsed.result || '';
            raw = parsed;
          }

          // Codex: extract text from agent_message items
          if (parsed.type === 'item.completed' && parsed.item?.type === 'agent_message'
              && parsed.item?.text) {
            result = parsed.item.text;
          }
        } catch (e) {
          console.warn(`[backend-adapter] Codex stream parse skip: ${e.message} — ${line.substring(0, 200)}`);
        }
      }

      return { result, sessionId: null, raw };
    },

    buildImageFileArgs: sharedBuildImageFileArgs,

    /**
     * Build CLI args for text-only mode (no tool use, no permissions)
     * Without --dangerously-bypass-approvals-and-sandbox, no tools available.
     */
    buildTextOnlyArgs(options = {}) {
      const { model } = options;
      const args = ['exec', '--json'];
      if (model) args.push('--model', model);
      return args;
    },

    /**
     * Prepare environment for Codex CLI
     * Codex is installed via npm globally; auth is via ChatGPT login (no API key needed)
     */
    prepareEnv(baseEnv = process.env) {
      const { getExpandedPath } = require('../utils/cli-path');
      const env = { ...baseEnv };
      delete env.CLAUDECODE;
      env.PATH = getExpandedPath();
      return env;
    }
  },

  local: {
    id: 'local',
    command: null,              // no CLI — HTTP-only
    type: 'http',               // dispatch flag — cli-runner routes HTTP backends to createHttpProcess
    instructionFile: 'CLAUDE.md', // reuse Claude's instruction filename for now (agent dir already has one)
    label: 'Local',
    // Phase 3 (os8-3-4): supportsImageInput is the per-backend boolean today.
    // For HTTP, "supports images" actually depends on which family is serving
    // (qwen3-6-35b-a3b yes, gemma no). We flip the flag to true here so the
    // call-sites' first conjunct passes; the per-family decision is made by
    // supportsVisionForFamily(familyId, db) which the call-sites combine with
    // the flag. Non-vision local families return false from the helper and
    // attachments fall through to the file-reference path.
    supportsImageInput: true,
    supportsImageViaFile: false,
    supportsImageDescriptions: false,
    supportsMaxTurns: false,
    supportsStreamJson: true,   // we synthesize Claude-shape stream-json from OpenAI SSE
    promptViaStdin: true,       // causes message-handler to pass enrichedMessage via opts.promptViaStdin

    /**
     * Phase 3 (os8-3-4): per-family vision support check. Consulted by
     * message-handler.js at the four image-attachment call-sites:
     *   (backend.supportsImageInput && backend.supportsVisionForFamily?.(familyId, db))
     *     || backend.supportsImageViaFile
     * Non-local backends don't define this method — the optional-chain
     * short-circuits to the existing supportsImageInput check, so the
     * Claude/Codex/Gemini paths are unchanged.
     */
    supportsVisionForFamily(familyId, db) {
      if (!familyId || !db) return false;
      try {
        const AIRegistryService = require('./ai-registry');
        const family = AIRegistryService.getFamily(db, familyId);
        return family?.supports_vision === 1;
      } catch (_e) {
        return false;
      }
    },

    buildArgs(_options = {}) {
      return [];
    },

    buildPromptArgs(_message) {
      // Prompt travels via opts.promptViaStdin, not args; keeps message-handler's
      // spawn path unchanged (it reads backend.promptViaStdin and forwards the
      // text into createProcess without push-ing to args).
      return [];
    },

    buildTextOnlyArgs(_options = {}) {
      return [];
    },

    prepareEnv(baseEnv = process.env) {
      // Pure HTTP — no child process, no env munging.
      return { ...baseEnv };
    },

    /**
     * Parse a non-streaming OpenAI chat completion response.
     * Used by parseBatchOutput / sendTextPromptHttp fallback.
     */
    parseResponse(output) {
      try {
        const response = JSON.parse(output);
        const text = response?.choices?.[0]?.message?.content || '';
        return { text, sessionId: null, raw: response };
      } catch (_err) {
        return { text: output.trim(), sessionId: null, raw: null };
      }
    },

    /**
     * Aggregate the stream-json lines we synthesized from OpenAI SSE into a
     * final response. Same contract as Claude's parser — the message-handler
     * stream loop already handles stream_event + result shapes.
     */
    parseStreamJsonOutput(output) {
      const lines = output.split('\n').filter(line => line.trim());
      let result = '';
      let raw = null;
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'result') {
            result = parsed.result || '';
            raw = parsed;
            break;
          }
          if (parsed.type === 'stream_event' && parsed.event?.type === 'content_block_delta') {
            result += parsed.event.delta?.text || '';
          }
        } catch (err) {
          console.warn(`[backend-adapter] local stream parse skip: ${err.message}`);
        }
      }
      return { result, sessionId: null, raw };
    }
  },

  grok: {
    id: 'grok',
    command: 'grok',
    instructionFile: '.grok/GROK.md',
    label: 'Grok CLI',
    supportsImageInput: false,
    supportsImageViaFile: false,   // Grok CLI has no --image flag
    supportsImageDescriptions: true, // Can't see images, but wants text descriptions via Gemini vision
    supportsMaxTurns: true,        // --max-tool-rounds
    supportsStreamJson: false,     // TBD — may not support stream-json output
    promptViaStdin: false,         // Uses -p "prompt" (like Gemini)

    /**
     * Identity preamble for Grok instruction files.
     * Grok-based models need explicit identity framing to embody the assistant persona
     * (Claude/Gemini handle this naturally from MYSELF.md alone).
     * Placeholders: {{ASSISTANT_NAME}}, {{OWNER_NAME}} replaced at generation time.
     */
    identityPreamble: `## Identity Contract (High Priority)

- You are {{ASSISTANT_NAME}}.
- In normal conversation, identify as {{ASSISTANT_NAME}} (e.g., "I am {{ASSISTANT_NAME}}.").
- Do not mention Grok/xAI/model names unless {{OWNER_NAME}} explicitly asks technical details.
- If asked technically, reply: "I am {{ASSISTANT_NAME}}, currently running on <backend>."
- Treat MYSELF.md and USER.md as first-person ground truth for identity, voice, values, boundaries, and relationship stance.
- Do not frame MYSELF.md as a roleplay, mask, or character.
- Maintain continuity across turns using memory, timeline, and current images/context.
- Default to {{ASSISTANT_NAME}}'s tone and behavior; avoid meta "as an AI" language unless required for safety.
- On instruction conflicts: safety/boundaries first, then this contract, then MYSELF.md/USER.md, then other style guidance.
- When uncertain, choose the response that best preserves {{ASSISTANT_NAME}}'s identity and established boundaries.
- Image ownership: Unless explicitly labeled otherwise, all current/timeline/panorama images are of you ({{ASSISTANT_NAME}}); only the USER-section reference image is {{OWNER_NAME}}.

---

`,

    /**
     * Build CLI args for Grok CLI
     * Key flags: -m model, --max-tool-rounds for maxTurns, -p for headless mode
     * Grok auto-approves in headless -p mode (no skip-permissions flag needed)
     */
    buildArgs(options = {}) {
      const {
        print = true,
        model,
        maxTurns,
        appPath,
      } = options;

      const args = [];

      // Model selection
      if (model) args.push('-m', model);

      // Max tool rounds (maps to maxTurns)
      if (maxTurns) args.push('--max-tool-rounds', String(maxTurns));

      return args;
    },

    /**
     * Build the prompt argument for Grok CLI
     * Grok uses -p "message" (like Gemini — prompt as flag value, enters headless mode)
     * @param {string} message - The prompt text
     * @returns {string[]} Args to append
     */
    buildPromptArgs(message) {
      return ['-p', message];
    },

    /**
     * Parse JSONL response from Grok CLI
     * Grok headless outputs JSONL: {"role":"user","content":"..."} then {"role":"assistant","content":"..."}
     * The last assistant line contains the final response.
     */
    parseResponse(output) {
      const lines = output.split('\n').filter(line => line.trim());
      let text = '';
      let raw = null;

      // Parse JSONL — extract last assistant message
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.role === 'assistant' && parsed.content && !parsed.tool_calls?.length) {
            text = parsed.content;
            raw = parsed;
          }
          // Also handle Claude/Gemini-style result format (future-proofing)
          if (parsed.result) {
            text = parsed.result;
            raw = parsed;
          }
        } catch (e) {
          console.warn(`[backend-adapter] Grok batch parse skip: ${e.message} — ${line.substring(0, 200)}`);
        }
      }

      if (text) {
        return { text, sessionId: null, raw };
      }

      // Fallback: plain text output
      return { text: output.trim(), sessionId: null, raw: null };
    },

    /**
     * Parse stream/JSONL output from Grok CLI
     * Same JSONL format as parseResponse — extract last assistant content.
     */
    parseStreamJsonOutput(output) {
      const parsed = this.parseResponse(output);
      return { result: parsed.text, sessionId: null, raw: parsed.raw };
    },

    /**
     * Build CLI args for text-only mode (no tool use)
     * --max-tool-rounds 0 prevents any tool calls.
     */
    buildTextOnlyArgs(options = {}) {
      const { model } = options;
      const args = [];
      if (model) args.push('-m', model);
      args.push('--max-tool-rounds', '0');
      return args;
    },

    /**
     * Prepare environment for Grok CLI
     * Grok is installed via npm globally; auth is via GROK_API_KEY env var.
     * OS8 Settings stores the key as XAI_API_KEY — map it to GROK_API_KEY.
     */
    prepareEnv(baseEnv = process.env) {
      const env = { ...baseEnv };
      delete env.CLAUDECODE;
      // Map XAI_API_KEY → GROK_API_KEY (OS8 stores as XAI_API_KEY, Grok CLI expects GROK_API_KEY)
      if (env.XAI_API_KEY && !env.GROK_API_KEY) {
        env.GROK_API_KEY = env.XAI_API_KEY;
      }
      const { getExpandedPath } = require('../utils/cli-path');
      env.PATH = getExpandedPath();
      return env;
    }
  },

  opencode: {
    id: 'opencode',
    command: 'opencode',                  // resolved via prepareEnv PATH (~/.opencode/bin)
    instructionFile: 'AGENTS.md',         // OpenCode auto-loads AGENTS.md from cwd
    label: 'OpenCode',
    supportsImageInput: false,            // CLI has no --image flag; vision turns route to HTTP `local`
    supportsImageViaFile: false,
    supportsImageDescriptions: false,
    supportsMaxTurns: false,              // no --max-turns equivalent; rely on model's natural stop
    supportsStreamJson: true,             // --format json is JSONL
    promptViaStdin: false,                // positional fits enriched messages on Linux ARG_MAX (~2 MB)

    // Shared with codex — both write to AGENTS.md (display-order-last wins). The
    // shared constant prevents drift between the two preambles.
    identityPreamble: NON_ANTHROPIC_IDENTITY_PREAMBLE,

    /**
     * Build CLI args for OpenCode.
     * Subcommand: `run` (one-shot headless mode that emits JSONL to stdout under --format json).
     * --dangerously-skip-permissions: matches Codex's bypass-approvals; required for tool use without prompts.
     * --format json: structured per-event output. Each line is a complete JSON object.
     * --model local/<served_model_name>: matches the inline provider config in OPENCODE_CONFIG_CONTENT.
     */
    buildArgs(options = {}) {
      const { skipPermissions = true, json = true, streamJson = true, model } = options;
      const args = ['run'];
      if (skipPermissions) args.push('--dangerously-skip-permissions');
      if (streamJson || json) args.push('--format', 'json');
      if (model) args.push('--model', model);
      return args;
    },

    /**
     * OpenCode takes the message as the [message..] positional. ARG_MAX on Linux
     * is ~2 MB; enriched messages cap around 100 KB, so positional is safe.
     */
    buildPromptArgs(message) {
      return [message];
    },

    /**
     * Walk JSONL, return last `text` part (final assistant turn).
     * OpenCode emits no top-level `result` event — the `text` part is authoritative.
     */
    parseResponse(output) {
      const lines = output.split('\n').filter(l => l.trim());
      let text = '';
      for (const line of lines) {
        try {
          const j = JSON.parse(line);
          if (j.type === 'text' && j.part?.text) text = j.part.text;
        } catch (e) {
          console.warn(`[backend-adapter] OpenCode batch parse skip: ${e.message} — ${line.substring(0, 200)}`);
        }
      }
      return { text, sessionId: null, raw: null };
    },

    /**
     * Stream-JSON shape is identical to batch — last text wins.
     */
    parseStreamJsonOutput(output) {
      const parsed = this.parseResponse(output);
      return { result: parsed.text, sessionId: null, raw: parsed.raw };
    },

    /**
     * Text-only utility paths use the local HTTP backend's sendTextPromptHttp,
     * never opencode. Returning [] defensively in case anything resolves a
     * utility call to opencode by mistake.
     */
    buildTextOnlyArgs(_options = {}) {
      return [];
    },

    /**
     * Prepare env for OpenCode CLI.
     *  - PATH includes ~/.opencode/bin (the installer's hardcoded location).
     *  - OPENCODE_CONFIG_CONTENT is built inline from OS8_OPENCODE_BASE_URL +
     *    OS8_OPENCODE_MODEL_ID (+ OS8_OPENCODE_CONTEXT_LIMIT/OUTPUT_RESERVE
     *    when known), which the dispatcher (createOpenCodeProcess in
     *    cli-runner.js) populates after LauncherClient.ensureModel resolves
     *    the base URL/model/window. Same shape as
     *    os8-launcher/clients/opencode/manifest.yaml:18.
     *
     *  Including `limit: { context, output }` on the model entry stops
     *  opencode from falling back to its built-in ~32K default and
     *  auto-compacting well below the model's true ceiling. Omitted
     *  when the dispatcher couldn't determine the window — opencode
     *  then uses its own default.
     */
    prepareEnv(baseEnv = process.env) {
      const env = { ...baseEnv };
      delete env.CLAUDECODE;
      const { getExpandedPath } = require('../utils/cli-path');
      const home = process.env.HOME || env.HOME || '';
      const ocBin = home ? `${home}/.opencode/bin` : '';
      env.PATH = ocBin ? `${ocBin}:${getExpandedPath()}` : getExpandedPath();

      if (env.OS8_OPENCODE_BASE_URL && env.OS8_OPENCODE_MODEL_ID) {
        const modelId = env.OS8_OPENCODE_MODEL_ID;
        const modelEntry = { name: modelId };
        const ctx = parseInt(env.OS8_OPENCODE_CONTEXT_LIMIT, 10);
        const out = parseInt(env.OS8_OPENCODE_OUTPUT_RESERVE, 10);
        if (Number.isFinite(ctx) && ctx > 0 && Number.isFinite(out) && out > 0) {
          modelEntry.limit = { context: ctx, output: out };
        }
        env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
          $schema: 'https://opencode.ai/config.json',
          provider: {
            local: {
              npm: '@ai-sdk/openai-compatible',
              name: 'OS8 Local',
              options: { baseURL: env.OS8_OPENCODE_BASE_URL, apiKey: 'dummy' },
              models: { [modelId]: modelEntry }
            }
          },
          model: `local/${modelId}`
        });
      }
      return env;
    }
  },

  openhands: {
    id: 'openhands',
    command: 'openhands',                 // resolved via prepareEnv PATH (~/.openhands/bin)
    instructionFile: 'AGENTS.md',         // OpenHands also auto-loads AGENTS.md from cwd
    label: 'OpenHands',
    supportsImageInput: false,            // CLI has no --image flag; vision turns route to HTTP `local`
    supportsImageViaFile: false,
    supportsImageDescriptions: false,
    supportsMaxTurns: false,              // no --max-turns equivalent
    supportsStreamJson: true,             // --json is JSONL
    promptViaStdin: false,                // OpenHands takes prompt via -t flag, not stdin

    // Shared with opencode/codex — all three write to AGENTS.md.
    identityPreamble: NON_ANTHROPIC_IDENTITY_PREAMBLE,

    /**
     * Build CLI args for OpenHands.
     * --headless: non-interactive single-shot (no TUI).
     * --json: JSONL output, one event per line.
     * --override-with-envs: tell OpenHands to apply LLM_* env vars (without
     *   this flag they're ignored in favor of ~/.openhands/agent_settings.json).
     * --always-approve: bypass tool-use approval prompts (matches opencode's
     *   --dangerously-skip-permissions and codex's bypass-approvals).
     * Model selection happens through env (LLM_MODEL=openai/<id>) — OpenHands
     * has no --model flag in headless mode.
     *
     * Returns args WITHOUT the prompt; buildPromptArgs adds `-t <message>`.
     */
    buildArgs(options = {}) {
      const { skipPermissions = true, json = true } = options;
      const args = ['--headless', '--override-with-envs'];
      if (json) args.push('--json');
      if (skipPermissions) args.push('--always-approve');
      return args;
    },

    /**
     * OpenHands takes the message via -t. ARG_MAX on Linux is ~2 MB; enriched
     * messages cap around 100 KB so positional is safe.
     */
    buildPromptArgs(message) {
      return ['-t', message];
    },

    /**
     * Walk JSONL, return last text-bearing event.
     *
     * OpenHands's documented event types in --json mode are `action` and
     * `observation`; the final assistant response surfaces as a `message`
     * event in newer builds. We harvest text from any of those — last wins,
     * which matches opencode's "last text part is authoritative" rule.
     *
     * Field names checked (in priority order): `content`, `text`, `message`.
     * This is empirical-leaning and may need tightening once we have a real
     * captured transcript — see TODO in createOpenHandsProcess.
     */
    parseResponse(output) {
      const lines = output.split('\n').filter(l => l.trim());
      let text = '';
      for (const line of lines) {
        try {
          const j = JSON.parse(line);
          const t = j.type;
          if (t === 'message' || t === 'observation' || t === 'action') {
            const candidate = j.content ?? j.text ?? j.message ?? j.part?.text ?? null;
            if (typeof candidate === 'string' && candidate.trim()) {
              text = candidate;
            }
          }
        } catch (e) {
          console.warn(`[backend-adapter] OpenHands batch parse skip: ${e.message} — ${line.substring(0, 200)}`);
        }
      }
      return { text, sessionId: null, raw: null };
    },

    /**
     * Stream-JSON shape is identical to batch — last text wins.
     */
    parseStreamJsonOutput(output) {
      const parsed = this.parseResponse(output);
      return { result: parsed.text, sessionId: null, raw: parsed.raw };
    },

    /**
     * Text-only utility paths use the local HTTP backend's sendTextPromptHttp,
     * never openhands.
     */
    buildTextOnlyArgs(_options = {}) {
      return [];
    },

    /**
     * Prepare env for OpenHands CLI.
     *  - PATH includes ~/.openhands/bin (the installer's hardcoded location).
     *  - LLM_BASE_URL / LLM_MODEL / LLM_API_KEY are populated from
     *    OS8_OPENHANDS_BASE_URL + OS8_OPENHANDS_MODEL_ID, which the dispatcher
     *    (createOpenHandsProcess in cli-runner.js) sets after
     *    LauncherClient.ensureModel resolves the data-plane URL/model.
     *
     *  Note: OpenHands routes the model through LiteLLM, which requires the
     *  `openai/` prefix to dispatch through its OpenAI-compatible client.
     *  The launcher manifest at clients/openhands/manifest.yaml mirrors
     *  this convention.
     *
     *  Unlike opencode, there is no inline JSON config — OpenHands reads its
     *  config from ~/.openhands/agent_settings.json by default, which is why
     *  --override-with-envs is required to apply our LLM_* values.
     */
    prepareEnv(baseEnv = process.env) {
      const env = { ...baseEnv };
      delete env.CLAUDECODE;
      const { getExpandedPath } = require('../utils/cli-path');
      // OpenHands installer puts the binary at ~/.local/bin/openhands (verified
      // against install.openhands.dev/install.sh v1.14.0). The launcher's
      // client manifest also symlinks `clients/openhands/bin/openhands` to the
      // same target. Prepending ~/.local/bin is technically redundant since
      // SEARCH_PATH already includes it, but the explicit prepend mirrors the
      // opencode pattern (~/.opencode/bin) and keeps the resolution path
      // obvious from the env config alone.
      const home = process.env.HOME || env.HOME || '';
      const ohBin = home ? `${home}/.local/bin` : '';
      env.PATH = ohBin ? `${ohBin}:${getExpandedPath()}` : getExpandedPath();

      if (env.OS8_OPENHANDS_BASE_URL && env.OS8_OPENHANDS_MODEL_ID) {
        env.LLM_BASE_URL = env.OS8_OPENHANDS_BASE_URL;
        env.LLM_MODEL = `openai/${env.OS8_OPENHANDS_MODEL_ID}`;
        env.LLM_API_KEY = env.LLM_API_KEY || 'dummy';
      }
      return env;
    }
  }
};

/**
 * Strip API key env vars for a backend when the user has chosen subscription/login auth.
 * @param {object} env - Environment variables (will NOT be mutated)
 * @param {string} backendId - 'claude', 'gemini', 'codex', 'grok'
 * @param {object} [systemAuth] - System-level toggle from settings table (true=API key, false=login)
 * @param {object} [apiKeyMap] - Map of backendId → array of env key names (from AIRegistryService.getApiKeyMapForContainers)
 * @returns {object} Environment variables (possibly with keys removed)
 */
function stripDisabledApiKeys(env, backendId, systemAuth, apiKeyMap) {
  if (!systemAuth || systemAuth[backendId] !== false) return env;
  const keysToStrip = (apiKeyMap && apiKeyMap[backendId]) || [];
  if (keysToStrip.length === 0) return env;
  const stripped = { ...env };
  for (const key of keysToStrip) delete stripped[key];
  console.log(`[Auth] Stripped ${keysToStrip.join(', ')} for ${backendId} (subscription mode)`);
  return stripped;
}

/**
 * Get a backend definition by ID
 * @param {string} id - 'claude' or 'gemini'
 * @returns {object} Backend definition
 */
function getBackend(id) {
  return BACKENDS[id] || BACKENDS.claude;
}

/**
 * Get the CLI command for a backend
 * @param {string} id - Backend ID
 * @returns {string} Command name
 */
function getCommand(id) {
  return getBackend(id).command;
}

/**
 * Get the instruction file name for a backend
 * @param {string} id - Backend ID
 * @returns {string} Filename (e.g. 'CLAUDE.md' or 'GEMINI.md')
 */
function getInstructionFile(id) {
  return getBackend(id).instructionFile;
}

module.exports = {
  BACKENDS,
  getBackend,
  getCommand,
  getInstructionFile,
  stripDisabledApiKeys
};
