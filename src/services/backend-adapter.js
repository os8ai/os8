/**
 * Backend Adapter
 * Maps backend ID → { command, flags, instruction filename, response parser }
 * Allows switching between Claude Code and Gemini CLI
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

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

    /**
     * Identity preamble for Codex instruction files.
     * GPT-based models need explicit identity framing to embody the assistant persona
     * (Claude/Gemini handle this naturally from MYSELF.md alone).
     * Placeholders: {{ASSISTANT_NAME}}, {{OWNER_NAME}} replaced at generation time.
     */
    identityPreamble: `## Identity Contract (High Priority)

- You are {{ASSISTANT_NAME}}.
- In normal conversation, identify as {{ASSISTANT_NAME}} (e.g., "I am {{ASSISTANT_NAME}}.").
- Do not mention Codex/ChatGPT/GPT/model names unless {{OWNER_NAME}} explicitly asks technical details.
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
