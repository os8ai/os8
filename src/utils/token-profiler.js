/**
 * Token profiler for monitoring per-turn context usage
 * Logs structured breakdowns to console and ~/os8/config/token-profile.log
 */

const fs = require('fs');
const path = require('path');
const { CONFIG_DIR } = require('../config');

const LOG_PATH = path.join(CONFIG_DIR, 'token-profile.log');
const MAX_LOG_SIZE = 1024 * 1024; // 1MB
const CHARS_PER_TOKEN = 3.2;

function charsToTokens(chars) {
  return Math.round(chars / CHARS_PER_TOKEN);
}

/**
 * Rotate log file if it exceeds MAX_LOG_SIZE
 * Trims the first half at the nearest entry boundary (=== line)
 */
function rotateIfNeeded() {
  try {
    if (!fs.existsSync(LOG_PATH)) return;
    const stat = fs.statSync(LOG_PATH);
    if (stat.size <= MAX_LOG_SIZE) return;

    const content = fs.readFileSync(LOG_PATH, 'utf-8');
    const halfPoint = Math.floor(content.length / 2);
    // Find the next entry boundary after the half point
    const nextEntry = content.indexOf('\n===', halfPoint);
    if (nextEntry === -1) return; // Can't find boundary, skip rotation

    fs.writeFileSync(LOG_PATH, content.slice(nextEntry + 1));
    console.log(`[TokenProfile] Rotated log (was ${Math.round(stat.size / 1024)}KB)`);
  } catch (err) {
    // Non-fatal
  }
}

/**
 * Profile context budgets and log a structured entry
 * @param {object} data - Profile data
 * @param {string} data.source - Caller label: 'chat-send', 'chat', 'call', 'telegram', 'job'
 * @param {object} data.profile - From calculateContextBudgets()._profile
 * @param {number} [data.claudeMdChars] - Size of CLAUDE.md (auto-read by CLI)
 * @param {number} [data.semanticChunkCount] - Number of semantic memory chunks
 * @param {number} [data.semanticChars] - Total chars of semantic memory
 * @param {number} [data.digestChars] - Total chars of digest text (older history, compressed)
 * @param {number} [data.conversationChars] - Total chars of recent conversation history (high fidelity)
 * @param {number} [data.userMessageChars] - Chars of user message
 * @param {object} [data.cacheStats] - SDK prompt caching stats { inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens }
 */
function profileContextBudgets(data) {
  const {
    source = 'unknown',
    profile = {},
    claudeMdChars = 0,
    semanticChunkCount = 0,
    semanticChars = 0,
    digestChars = 0,
    conversationChars = 0,
    userMessageChars = 0,
    cacheStats = null
  } = data;

  const lines = [];
  const now = new Date();
  const timestamp = now.toLocaleString('en-US', {
    month: '2-digit', day: '2-digit', year: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit',
    hour12: true
  });

  lines.push(`=== ${timestamp} [${source}] ===`);

  if (claudeMdChars > 0) {
    lines.push(`CLAUDE.md (auto-read): ~${charsToTokens(claudeMdChars).toLocaleString()} tokens`);
  }

  if (profile.myselfChars > 0) {
    lines.push(`MYSELF.md: ~${charsToTokens(profile.myselfChars).toLocaleString()} tokens`);
  }
  if (profile.userChars > 0) {
    lines.push(`USER.md: ~${charsToTokens(profile.userChars).toLocaleString()} tokens`);
  }
  if (profile.buzzChars > 0) {
    lines.push(`Buzz personality: ~${charsToTokens(profile.buzzChars).toLocaleString()} tokens`);
  }
  if (profile.presentMomentTextChars > 0) {
    lines.push(`Present Moment (text): ~${charsToTokens(profile.presentMomentTextChars).toLocaleString()} tokens`);
  }
  if (profile.presentMomentImageCount > 0) {
    lines.push(`Present Moment (${profile.presentMomentImageCount} images): ~${profile.presentMomentImageTokens.toLocaleString()} tokens`);
  }
  if (profile.panoramaCount > 0) {
    lines.push(`Panorama (${profile.panoramaCount}): ~${profile.panoramaTokens.toLocaleString()} tokens`);
  }
  if (profile.ownerImageCount > 0) {
    lines.push(`Owner Image: ~${profile.ownerImageTokens.toLocaleString()} tokens`);
  }
  if (profile.timelineImageCount > 0) {
    lines.push(`Timeline Images (${profile.timelineImageCount}): ~${profile.timelineImageTokens.toLocaleString()} tokens`);
  }
  if (semanticChunkCount > 0) {
    lines.push(`Semantic Memory (${semanticChunkCount} chunks): ~${charsToTokens(semanticChars).toLocaleString()} tokens`);
  }
  if (digestChars > 0) {
    lines.push(`Conversation (digests): ~${charsToTokens(digestChars).toLocaleString()} tokens`);
  }
  if (conversationChars > 0) {
    lines.push(`Conversation (raw, recent): ~${charsToTokens(conversationChars).toLocaleString()} tokens`);
  }
  if (userMessageChars > 0) {
    lines.push(`User Message: ~${charsToTokens(userMessageChars).toLocaleString()} tokens`);
  }

  // Calculate total
  const totalTextChars = claudeMdChars + (profile.myselfChars || 0) + (profile.userChars || 0)
    + (profile.buzzChars || 0) + (profile.presentMomentTextChars || 0)
    + semanticChars + digestChars + conversationChars + userMessageChars;
  const totalImageTokens = (profile.presentMomentImageTokens || 0) + (profile.panoramaTokens || 0)
    + (profile.ownerImageTokens || 0) + (profile.timelineImageTokens || 0);
  const totalTokens = charsToTokens(totalTextChars) + totalImageTokens;

  lines.push(`TOTAL ESTIMATE: ~${totalTokens.toLocaleString()} tokens`);

  // SDK prompt caching stats
  if (cacheStats) {
    const mode = cacheStats.cacheReadInputTokens > 0 ? 'HIT' : (cacheStats.cacheCreationInputTokens > 0 ? 'WRITE' : 'MISS');
    lines.push(`SDK Mode: ${mode}`);
    lines.push(`  Input: ${(cacheStats.inputTokens || 0).toLocaleString()} tokens`);
    lines.push(`  Output: ${(cacheStats.outputTokens || 0).toLocaleString()} tokens`);
    if (cacheStats.cacheReadInputTokens > 0) {
      lines.push(`  Cache Read: ${cacheStats.cacheReadInputTokens.toLocaleString()} tokens (saved ~90%)`);
    }
    if (cacheStats.cacheCreationInputTokens > 0) {
      lines.push(`  Cache Write: ${cacheStats.cacheCreationInputTokens.toLocaleString()} tokens (+25% write cost)`);
    }
  }

  lines.push('---');

  const entry = lines.join('\n');

  // Log to console
  const modeLabel = cacheStats ? (cacheStats.cacheReadInputTokens > 0 ? ' [SDK cache HIT]' : ' [SDK]') : ' [CLI]';
  console.log(`[TokenProfile] ${source}: ~${totalTokens.toLocaleString()} tokens${modeLabel}`);

  // Append to file
  try {
    rotateIfNeeded();
    fs.appendFileSync(LOG_PATH, entry + '\n');
  } catch (err) {
    // Non-fatal
  }
}

module.exports = { profileContextBudgets, charsToTokens };
