/**
 * StreamStateTracker — Parse Claude stream-json events into execution steps
 *
 * Consumes raw stream-json lines and tracks block-level execution state.
 * Emits step events via callbacks for SSE broadcasting to the chat UI.
 *
 * V2 swap point: extractStepsFromResponse() wraps the Haiku post-hoc call
 * for non-Claude backends. Replace with routing-resolved model in v2.
 */

const AnthropicSDK = require('./anthropic-sdk');

/**
 * Map tool name + input to a human-readable label.
 * @param {string} toolName
 * @param {string} toolInput - First ~200 chars of input JSON
 * @returns {string} Human-readable label
 */
function labelStep(toolName, toolInput) {
  const filename = extractFilename(toolInput);

  switch (toolName) {
    case 'Bash': {
      const input = toolInput || '';
      if (/npm\s+test|jest|vitest/i.test(input)) return 'Running tests';
      if (/npm\s+install/i.test(input)) return 'Installing dependencies';
      if (/npm\s+run\s+build/i.test(input)) return 'Building project';
      if (/\bgit\b/.test(input)) {
        const sub = input.match(/\bgit\s+(\w+)/);
        return sub ? `Git: ${sub[1]}` : 'Running git command';
      }
      if (/\bcurl\b/.test(input)) return 'Making API request';
      if (/\bmkdir\b/.test(input)) return 'Creating directory';
      if (/\bls\b/.test(input)) return 'Listing files';
      // Show first meaningful portion of command
      const cmd = input.match(/"command"\s*:\s*"([^"]{1,60})/);
      if (cmd) return `Running: ${cmd[1]}`;
      return 'Running command';
    }
    case 'Read':
      return filename ? `Reading ${filename}` : 'Reading file';
    case 'Edit':
      return filename ? `Editing ${filename}` : 'Editing file';
    case 'Write':
      return filename ? `Creating ${filename}` : 'Creating file';
    case 'Glob':
      return 'Searching for files';
    case 'Grep':
      return 'Searching file contents';
    case 'Agent':
      return 'Delegating to sub-agent';
    default:
      return toolName || 'Working';
  }
}

/**
 * Extract a filename from tool input text.
 * Looks for path-like strings (containing / or .).
 * @param {string} input
 * @returns {string|null}
 */
function extractFilename(input) {
  if (!input) return null;

  // Match path-like strings
  const match = input.match(/(?:["'])?([\/\w._-]+(?:\/[\w._-]+)+(?:\.\w+)?)(?:["'])?/);
  if (!match) {
    // Try just a filename with extension
    const fileMatch = input.match(/(?:["'])?(\w[\w._-]*\.\w+)(?:["'])?/);
    if (!fileMatch) return null;
    return fileMatch[1];
  }

  const fullPath = match[1];
  if (fullPath.length > 40) {
    // Truncate to basename
    const parts = fullPath.split('/');
    return parts[parts.length - 1];
  }
  return fullPath;
}

/**
 * StreamStateTracker — stateful parser for Claude stream-json events.
 *
 * @param {object} callbacks
 * @param {function} callbacks.onStepStart - ({ blockIndex, blockType, toolName, toolInput, label }) => void
 * @param {function} callbacks.onStepComplete - ({ blockIndex, durationMs }) => void
 * @param {function} callbacks.onThinkingStart - ({ blockIndex }) => void
 * @param {function} callbacks.onThinkingEnd - ({ blockIndex }) => void
 */
class StreamStateTracker {
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    this.currentBlock = null;
    this._inputBuffer = '';
    this.stepCount = 0;
  }

  /**
   * Process a single stream-json event object.
   * Events arrive wrapped: { type: 'stream_event', event: { type: '...', ... } }
   * @param {object} json - Parsed JSON from the stream
   */
  processEvent(json) {
    // Unwrap stream_event wrapper
    if (json.type !== 'stream_event' || !json.event) return;

    const event = json.event;

    switch (event.type) {
      case 'content_block_start':
        this._handleBlockStart(event);
        break;

      case 'content_block_delta':
        this._handleBlockDelta(event);
        break;

      case 'content_block_stop':
        this._handleBlockStop(event);
        break;
    }
  }

  _handleBlockStart(event) {
    const block = event.content_block;
    if (!block) return;

    const blockType = block.type; // 'thinking', 'tool_use', 'text'
    const blockIndex = event.index ?? 0;

    this.currentBlock = {
      blockIndex,
      blockType,
      toolName: block.name || null,
      startedAt: Date.now()
    };
    this._inputBuffer = '';

    if (blockType === 'thinking') {
      this.callbacks.onThinkingStart?.({ blockIndex });
    } else if (blockType === 'tool_use') {
      // Emit step-start immediately with tool name; label may refine once input arrives
      this.stepCount++;
      const label = labelStep(block.name, '');
      this.callbacks.onStepStart?.({
        blockIndex,
        blockType,
        toolName: block.name,
        toolInput: '',
        label,
        stepIndex: this.stepCount
      });
    }
    // Text blocks don't emit step events
  }

  _handleBlockDelta(event) {
    if (!this.currentBlock) return;

    const delta = event.delta;
    if (!delta) return;

    // Accumulate tool input for labeling
    if (delta.type === 'input_json_delta' && delta.partial_json) {
      this._inputBuffer += delta.partial_json;

      // Emit refined label once when we have enough input (avoids noisy re-emissions)
      if (!this.currentBlock.refined && this._inputBuffer.length >= 150
          && this.currentBlock.blockType === 'tool_use') {
        this.currentBlock.refined = true;
        const label = labelStep(this.currentBlock.toolName, this._inputBuffer);
        this.callbacks.onStepStart?.({
          blockIndex: this.currentBlock.blockIndex,
          blockType: this.currentBlock.blockType,
          toolName: this.currentBlock.toolName,
          toolInput: this._inputBuffer.substring(0, 200),
          label,
          stepIndex: this.stepCount
        });
      }
    }
  }

  _handleBlockStop(event) {
    if (!this.currentBlock) return;

    const blockIndex = this.currentBlock.blockIndex;
    const blockType = this.currentBlock.blockType;
    const durationMs = Date.now() - this.currentBlock.startedAt;

    if (blockType === 'thinking') {
      this.callbacks.onThinkingEnd?.({ blockIndex });
    } else if (blockType === 'tool_use') {
      this.callbacks.onStepComplete?.({ blockIndex, durationMs, stepIndex: this.stepCount });
    }

    this.currentBlock = null;
    this._inputBuffer = '';
  }

  /**
   * Reset tracker state between executions.
   */
  reset() {
    this.currentBlock = null;
    this._inputBuffer = '';
    this.stepCount = 0;
  }
}

/**
 * Extract execution steps from a non-Claude response via Haiku post-hoc.
 * V2 swap point: replace AnthropicSDK call with routing-resolved model.
 *
 * @param {object} db
 * @param {string} response - Full agent response text
 * @returns {Promise<Array<{ description: string, status: string }>>}
 */
async function extractStepsFromResponse(db, response) {
  if (!response || response.length < 500) return [];
  if (!AnthropicSDK.isAvailable(db)) return [];

  try {
    const prompt = `Extract the execution steps from this AI assistant response. Return a JSON array:
[{"description": "what was done", "status": "completed"}]
Only include concrete actions taken (file edits, commands run, searches performed).
Do not include planning or thinking steps. Maximum 10 steps.

Response:
${response.substring(0, 8000)}`;

    const result = await AnthropicSDK.sendMessage(db, null, prompt, { agentModel: 'haiku' });
    if (!result?.text) return [];

    // Extract JSON array from response
    const match = result.text.match(/\[[\s\S]*\]/);
    if (!match) return [];

    const steps = JSON.parse(match[0]);
    return Array.isArray(steps) ? steps.slice(0, 10) : [];
  } catch (err) {
    console.warn('[StreamTracker] Post-hoc extraction failed:', err.message);
    return [];
  }
}

module.exports = { StreamStateTracker, labelStep, extractStepsFromResponse };
