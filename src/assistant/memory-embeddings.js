/**
 * Embedding primitives, text chunking, hashing, and keyword extraction.
 * Extracted from memory.js — pure functions, no MemoryService dependency.
 */

const crypto = require('crypto');

// Lazy load transformers to avoid startup delay
let pipeline = null;
let embedder = null;

const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_DIMS = 384;

async function getEmbedder() {
  if (embedder) return embedder;

  if (!pipeline) {
    const transformers = await import('@xenova/transformers');
    pipeline = transformers.pipeline;
  }

  // Use all-MiniLM-L6-v2 - small, fast, good quality
  embedder = await pipeline('feature-extraction', MODEL_NAME);
  return embedder;
}

// Chunk text into ~450 token segments (roughly 4 chars per token)
// Overlap prevents topic loss at chunk boundaries
function chunkText(text, maxChars = 1800, overlapChars = 200) {
  const chunks = [];
  const paragraphs = text.split(/\n\n+/);

  let currentChunk = '';

  for (const para of paragraphs) {
    if (currentChunk.length + para.length > maxChars && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      // Start next chunk with overlap: take tail paragraphs that fit within overlapChars
      if (overlapChars > 0) {
        const tailParas = currentChunk.split(/\n\n+/);
        let overlap = '';
        for (let j = tailParas.length - 1; j >= 0; j--) {
          const candidate = tailParas[j] + (overlap ? '\n\n' + overlap : '');
          if (candidate.length > overlapChars) break;
          overlap = candidate;
        }
        currentChunk = overlap ? overlap + '\n\n' + para : para;
      } else {
        currentChunk = para;
      }
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + para;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

// Compute cosine similarity between two vectors
function cosineSimilarity(a, b) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Convert Float32Array to Buffer for SQLite storage
function embeddingToBuffer(embedding) {
  return Buffer.from(embedding.buffer);
}

// Convert Buffer from SQLite to Float32Array
// CRITICAL: Must use byteOffset and length to avoid garbage bytes
function bufferToEmbedding(buffer) {
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
}

// Normalize text before hashing for cache consistency
function normalizeForHashing(text) {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

// Get SHA256 hash of text
function getTextHash(text) {
  const normalized = normalizeForHashing(text);
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

// Categorize source file by type
function categorize(source) {
  if (source === 'MYSELF.md' || source === 'USER.md') return 'identity';
  if (source === 'MEMORY.md') return 'curated';
  if (source.startsWith('memory/')) return 'daily';
  return 'other';
}

// Strip formatting noise before embedding for better semantic matching
// Raw text is preserved in DB for display; this is only used for embedding generation and search queries
function cleanTextForEmbedding(text) {
  return text
    // Timestamps: [12:34:56 PM], [01/15/2026, 2:30:45 PM], etc.
    .replace(/\[\d{1,2}\/\d{1,2}\/\d{2,4},?\s*\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?\]/gi, '')
    .replace(/\[\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?\]/gi, '')
    // Speaker labels: **User:**, **Assistant:**
    .replace(/\*\*(User|Assistant|Owner|Agent):\*\*/gi, '')
    // Section headers: ## Conversations, # 2026-02-04
    .replace(/^#{1,3}\s+.+$/gm, '')
    // Markdown bold/italic
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
    // Code fences
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    // Badges like [journal], via telegram
    .replace(/\[(journal|via\s+\w+)\]/gi, '')
    // Excess whitespace
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// Stopwords for keyword extraction (common English + conversational filler)
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'could', 'should', 'can', 'may', 'might', 'shall',
  'ok', 'okay', 'yeah', 'yes', 'no', 'sure', 'right', 'just', 'like', 'think', 'know',
  'want', 'need', 'got', 'get', 'let', 'well', 'also', 'really', 'very', 'pretty', 'quite',
  'maybe', 'probably', 'actually', 'basically', 'literally', 'thing', 'things',
  'stuff', 'something', 'anything', 'that', 'this', 'what', 'how', 'when', 'where', 'why',
  'for', 'with', 'from', 'about', 'into', 'but', 'not', 'and', 'or', 'so', 'if', 'then',
  'than', 'too', 'here', 'there', 'they', 'them', 'their', 'its', 'it', 'he', 'she', 'we',
  'you', 'your', 'my', 'me', 'our', 'his', 'her', 'who', 'which', 'each', 'all', 'both',
  'some', 'any', 'more', 'most', 'much', 'many', 'such', 'own', 'same', 'other', 'only',
  'just', 'going', 'gonna', 'make', 'made', 'take', 'took', 'see', 'saw', 'say', 'said',
  'tell', 'told', 'come', 'came', 'go', 'went', 'give', 'gave', 'one', 'two', 'new',
  'now', 'way', 'use', 'used', 'try', 'tried', 'put', 'still', 'back', 'even', 'being',
  'been', 'between', 'after', 'before', 'over', 'under', 'again', 'further', 'once',
  'don', 'doesn', 'didn', 'won', 'wouldn', 'couldn', 'shouldn', 'haven', 'hasn', 'hadn',
  'isn', 'aren', 'wasn', 'weren', 'hm', 'hmm', 'haha', 'lol', 'oh', 'ah', 'uh', 'um',
  'hey', 'hi', 'hello', 'bye', 'thanks', 'thank', 'please', 'sorry', 'great', 'good',
  'nice', 'cool', 'awesome', 'fine', 'alright'
]);

/**
 * Extract keywords from recent conversation entries for composite search queries.
 * Pure function — no DB or LLM calls.
 * @param {Array} entries - Conversation entries with { speaker, role, content }
 * @param {object} [options]
 * @param {number} [options.topK=15] - Number of keywords to return
 * @returns {Array<string>} Top keywords by weighted frequency
 */
function extractKeywords(entries, options = {}) {
  const { topK = 15 } = options;
  if (!entries || entries.length === 0) return [];

  const freq = new Map();       // word → count
  const userWords = new Set();   // words used by user
  const agentWords = new Set();  // words used by agent
  const properNouns = new Set(); // mid-sentence capitalized words

  for (const entry of entries) {
    const content = entry.content || '';
    const words = content.split(/[^a-zA-Z0-9_-]+/).filter(w => w.length > 1);

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const lower = word.toLowerCase();

      // Skip stopwords and very short words
      if (STOPWORDS.has(lower) || lower.length < 2) continue;

      // Track frequency
      freq.set(lower, (freq.get(lower) || 0) + 1);

      // Track which role used the word
      if (entry.role === 'user') userWords.add(lower);
      else agentWords.add(lower);

      // Detect proper nouns (capitalized mid-sentence, not first word)
      if (i > 0 && word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase()) {
        properNouns.add(lower);
      }
    }
  }

  // Apply boosts and score
  const scored = [];
  for (const [word, count] of freq) {
    let score = count;
    // Shared-topic boost: words used by both user and agent
    if (userWords.has(word) && agentWords.has(word)) {
      score *= 2;
    }
    // Proper noun boost
    if (properNouns.has(word)) {
      score *= 1.5;
    }
    scored.push({ word, score });
  }

  // Sort by score descending, take top K
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map(s => s.word);
}

module.exports = {
  getEmbedder,
  chunkText,
  cosineSimilarity,
  embeddingToBuffer,
  bufferToEmbedding,
  normalizeForHashing,
  getTextHash,
  categorize,
  cleanTextForEmbedding,
  extractKeywords,
  STOPWORDS,
  MODEL_NAME,
  EMBEDDING_DIMS
};
