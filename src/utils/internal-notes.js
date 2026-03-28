/**
 * Utility functions for handling internal notes in assistant responses
 *
 * Internal notes format: [internal: ...]
 * These are stripped from display/Telegram/TTS but kept in logs and memory
 *
 * Uses bracket-depth parsing (not regex) to handle nested brackets correctly.
 * e.g. [internal: talked about [HEART] and built it.] strips the entire note.
 */

const INTERNAL_TAG = '[internal:';

/**
 * Find all [internal: ...] spans in text using bracket-depth tracking.
 * Returns array of { start, end } indices (end is exclusive, includes trailing newline).
 */
function findInternalNoteSpans(text) {
  if (!text) return [];
  const spans = [];
  const lower = text.toLowerCase();
  let i = 0;

  while (i < lower.length) {
    if (lower.startsWith(INTERNAL_TAG, i)) {
      const start = i;
      i += INTERNAL_TAG.length;
      // Scan for matching close bracket with depth tracking
      let depth = 0;
      while (i < text.length) {
        if (text[i] === '[') {
          depth++;
        } else if (text[i] === ']') {
          if (depth === 0) {
            i++; // consume closing ]
            // Consume optional trailing whitespace + newline
            while (i < text.length && text[i] === ' ') i++;
            if (i < text.length && text[i] === '\n') i++;
            break;
          } else {
            depth--;
          }
        }
        i++;
      }
      spans.push({ start, end: i });
    } else {
      i++;
    }
  }
  return spans;
}

/**
 * Strip internal notes from text for display/sending
 * @param {string} text - Text that may contain internal notes
 * @returns {string} Text with internal notes removed
 */
function stripInternalNotes(text) {
  if (!text) return text;
  const spans = findInternalNoteSpans(text);
  if (spans.length === 0) return text;

  let result = '';
  let pos = 0;
  for (const { start, end } of spans) {
    result += text.slice(pos, start);
    pos = end;
  }
  result += text.slice(pos);
  return result.trim();
}

/**
 * Extract internal notes from text (for debugging/logging)
 * @param {string} text - Text that may contain internal notes
 * @returns {string[]} Array of internal note contents
 */
function extractInternalNotes(text) {
  if (!text) return [];
  const spans = findInternalNoteSpans(text);
  return spans.map(({ start, end }) => {
    // Extract content between [internal: and the closing ]
    let content = text.slice(start + INTERNAL_TAG.length, end);
    // Trim trailing ] and whitespace/newline
    content = content.replace(/\]\s*$/, '').trim();
    return content;
  });
}

/**
 * Check if text contains any internal notes
 * @param {string} text - Text to check
 * @returns {boolean} True if text contains internal notes
 */
function hasInternalNotes(text) {
  if (!text) return false;
  return text.toLowerCase().includes(INTERNAL_TAG);
}

/**
 * Regex to match agent file attachment tags: [file: chat-attachments/image.png]
 */
const FILE_TAG_REGEX = /\[file:\s*([^\]]+)\]/g;

/**
 * Infer MIME type from file extension
 */
function mimeFromExtension(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const types = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv'
  };
  return types[ext] || 'application/octet-stream';
}

/**
 * Extract file attachment references from text
 * @param {string} text - Text that may contain [file: ...] tags
 * @returns {Array<{url: string, filename: string, mimeType: string}>} Extracted attachments
 */
function extractFileAttachments(text) {
  if (!text) return [];
  const attachments = [];
  let match;
  const regex = new RegExp(FILE_TAG_REGEX.source, FILE_TAG_REGEX.flags);
  while ((match = regex.exec(text)) !== null) {
    const relativePath = match[1].trim();
    const filename = relativePath.split('/').pop();
    // API paths (e.g. /api/imagegen/files/...) are already valid URLs
    const url = relativePath.startsWith('/api/') ? relativePath : `/blob/${relativePath}`;
    attachments.push({
      url,
      filename,
      mimeType: mimeFromExtension(filename)
    });
  }
  return attachments;
}

/**
 * Strip [file: ...] tags from text for display
 * @param {string} text - Text that may contain file tags
 * @returns {string} Text with file tags removed
 */
function stripFileAttachments(text) {
  if (!text) return text;
  return text.replace(FILE_TAG_REGEX, '').trim();
}

/**
 * Regex to match agent tapback reactions: [react:heart], [react:thumbs-up], [react:haha]
 * Allows optional space after colon and flexible dash/space between "thumbs" and "up"
 */
const REACTION_REGEX = /\[react:\s*(heart|thumbs[-\s]up|haha)\](?:\s*\n)?/i;

/**
 * Normalize reaction key to canonical form
 */
function normalizeReactionKey(key) {
  const normalized = key.toLowerCase().replace(/\s+/g, '-');
  return normalized;
}

/**
 * Extract reaction key from text
 * @param {string} text - Text that may contain a reaction tag
 * @returns {string|null} Reaction key (heart, thumbs-up, haha) or null
 */
function extractReaction(text) {
  if (!text) return null;
  const match = text.match(REACTION_REGEX);
  if (match) return normalizeReactionKey(match[1]);
  // Log near-misses for debugging
  const nearMiss = text.match(/\[react:\s*([^\]]+)\]/i);
  if (nearMiss) {
    console.warn(`[Reaction] Unrecognized reaction format: [react:${nearMiss[1]}]`);
  }
  return null;
}

/**
 * Strip reaction tag from text for display
 * @param {string} text - Text that may contain a reaction tag
 * @returns {string} Text with reaction tag removed
 */
function stripReaction(text) {
  if (!text) return text;
  // Strip known reactions
  let result = text.replace(REACTION_REGEX, '').trim();
  // Also strip any unrecognized [react:...] to prevent leaking tags to display
  result = result.replace(/\[react:\s*[^\]]*\](?:\s*\n)?/gi, '').trim();
  return result;
}

/**
 * Extract the internal note subtype tag from content.
 * Matches: [internal: (type) content] where type is transient, structural, pulse, reverie, spark
 * @param {string} content - Entry content
 * @returns {string|null} Tag name or null
 */
function extractInternalTag(content) {
  if (!content) return null;
  // Match [internal: (type) ...] — case insensitive
  const match = content.match(/\[internal:\s*\((\w+)\)/i);
  if (!match) return null;
  const tag = match[1].toLowerCase();
  const validTags = ['transient', 'structural', 'pulse', 'reverie', 'spark'];
  return validTags.includes(tag) ? tag : null;
}

/**
 * Regex to match Grok CLI tool call XML blocks that leak into assistant content.
 * Format: [xai:function_call name='...'>...</xai:function_call>
 */
const TOOL_CALL_XML_REGEX = /\[xai:function_call[^\]]*>[\s\S]*?<\/xai:function_call>\s*/g;

/**
 * Strip Grok CLI tool call XML from text for display/sending
 * @param {string} text - Text that may contain tool call XML
 * @returns {string} Text with tool call XML removed
 */
function stripToolCallXml(text) {
  if (!text) return text;
  return text.replace(TOOL_CALL_XML_REGEX, '').trim();
}

module.exports = {
  stripInternalNotes,
  stripToolCallXml,
  extractInternalNotes,
  hasInternalNotes,
  extractReaction,
  stripReaction,
  extractFileAttachments,
  stripFileAttachments,
  extractInternalTag,
  REACTION_REGEX,
  FILE_TAG_REGEX
};
