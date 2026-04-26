/**
 * Stream parsing utilities for multi-backend CLI output.
 * Extracted from message-handler.js — pure functions, no external state.
 */

/**
 * Check if buffer ends with a partial match to a pattern prefix
 * Returns the length of the partial match, or 0 if none
 */
function findPartialMatch(text, pattern) {
  const lowerText = text.toLowerCase();
  for (let len = Math.min(pattern.length - 1, text.length); len > 0; len--) {
    const suffix = lowerText.slice(-len);
    const prefix = pattern.slice(0, len);
    if (suffix === prefix) {
      return len;
    }
  }
  return 0;
}

/**
 * Check if buffer ends with a partial match to "[internal:" or "[react:"
 * Returns the length of the longest partial match, or 0 if none
 */
function findPartialInternalMatch(text) {
  return Math.max(
    findPartialMatch(text, '[internal:'),
    findPartialMatch(text, '[react:')
  );
}

/**
 * Parse stream-json output from Claude CLI
 * Extracts the result and session_id from multiple JSON lines
 * @param {string} output - Raw stdout with multiple JSON lines
 * @returns {object} { result, sessionId, raw }
 */
function parseStreamJsonOutput(output) {
  const lines = output.split('\n').filter(line => line.trim());
  let result = '';
  let sessionId = null;
  let raw = null;
  let geminiDeltaContent = '';  // Accumulate Gemini's delta messages
  let codexContent = '';  // Accumulate Codex agent_message text
  let opencodeContent = '';  // Last OpenCode `text` part wins (single-shot)

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);

      // Claude + Gemini: Look for result type (final response)
      if (parsed.type === 'result') {
        result = parsed.result || '';
        sessionId = parsed.session_id || sessionId;
        raw = parsed;
      }
      // Gemini: Accumulate delta messages (type: "message" with delta: true)
      if (parsed.type === 'message' && parsed.delta && parsed.role === 'assistant' && parsed.content) {
        geminiDeltaContent += parsed.content;
      }
      // Codex: Extract text from agent_message items
      if (parsed.type === 'item.completed' && parsed.item?.type === 'agent_message'
          && parsed.item?.text) {
        codexContent = parsed.item.text;
      }
      // OpenCode: text part arrives once at the final step; last one wins.
      if (parsed.type === 'text' && parsed.part?.type === 'text' && typeof parsed.part?.text === 'string') {
        opencodeContent = parsed.part.text;
      }
      // OpenCode: capture sessionID as a sessionId fallback for callers.
      if (parsed.sessionID && !sessionId) {
        sessionId = parsed.sessionID;
      }
      // Grok: {"role":"assistant","content":"..."} — last assistant message wins
      // Skip tool-call progress messages ("Using tools to help you...")
      // Skip messages with tool_calls array (intermediate tool-use messages)
      if (!parsed.type && parsed.role === 'assistant' && parsed.content
          && !parsed.tool_calls?.length
          && !/^Using tools/i.test(parsed.content.trim())) {
        result = parsed.content;
      }
      // Also capture session_id from init or assistant messages
      if (parsed.session_id && !sessionId) {
        sessionId = parsed.session_id;
      }
    } catch (e) {
      // Skip non-JSON lines
    }
  }

  // If no result from result event, use accumulated delta content
  if (!result && geminiDeltaContent) {
    result = geminiDeltaContent;
  }
  if (!result && codexContent) {
    result = codexContent;
  }
  if (!result && opencodeContent) {
    result = opencodeContent;
  }

  return { result, sessionId, raw };
}

module.exports = {
  findPartialMatch,
  findPartialInternalMatch,
  parseStreamJsonOutput
};
