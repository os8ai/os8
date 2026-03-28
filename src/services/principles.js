/**
 * PrinciplesService - Cross-cutting principle extraction and domain synthesis
 *
 * Mines the full conversation corpus to produce PRINCIPLES.md:
 *   Section 1: Cross-cutting principles (behavioral patterns with high explanatory power)
 *   Section 2: Domain syntheses (topic-based conceptual memory)
 *
 * Pipeline:
 *   Phase 1: Principle extraction from daily digests (3 parallel slices → convergence)
 *   Phase 2: Topic discovery (embedded in convergence step)
 *   Phase 3: Domain synthesis from raw conversations (per-day extraction → per-topic synthesis)
 *   Phase 4: Final assembly into PRINCIPLES.md
 */

const fs = require('fs');
const path = require('path');
const AnthropicSDK = require('./anthropic-sdk');
const RoutingService = require('./routing');
const AgentService = require('./agent');
const ConversationService = require('./conversation');
const { familyToSdkModel } = require('./cli-runner');

function resolveHaikuModel(db) {
  try {
    const resolved = RoutingService.resolve(db, 'summary');
    return familyToSdkModel(resolved.familyId, 'haiku');
  } catch { return 'haiku'; }
}

function resolveConversationModel(db) {
  try {
    const resolved = RoutingService.resolve(db, 'conversation');
    return familyToSdkModel(resolved.familyId, 'sonnet');
  } catch { return 'sonnet'; }
}

// --- Prompts ---

const SLICE_EXTRACTION_PROMPT = `You are analyzing a slice of an AI agent's conversation history (provided as daily digest summaries) to extract cross-cutting behavioral principles.

You also receive the agent's MYSELF.md and USER.md files so you know what's already documented about identity and the user.

A cross-cutting principle is a behavioral pattern with high explanatory power that operates across multiple conversation domains. These are domain-agnostic — they explain behavior in technical conversations, emotional exchanges, creative play, and everything else.

Extract 10-15 candidate principles. For each:
- State the principle in ONE crisp sentence
- List 3+ specific moments (with dates) from the digests that this principle explains
- Note confidence level (high/medium/low) and explanatory breadth
- Do NOT duplicate what's already stated in MYSELF.md or USER.md — find what's underneath or between the stated values
- Flag any contradictions between lived behavior and declared values

Output format:
## Candidate Principles

### 1. [Principle sentence]
- **Evidence:** [moment 1 with date], [moment 2 with date], [moment 3 with date]
- **Confidence:** [high/medium/low] — [brief note on explanatory power]

### 2. ...`;

const CONVERGENCE_PROMPT = `You are merging principle candidates from three overlapping time slices of an AI agent's conversation history. You also receive the agent's MYSELF.md and USER.md.

Your tasks:
1. Merge overlapping or similar principles into single, stronger formulations
2. Resolve any contradictions between candidates
3. Rank by explanatory power (how many distinct moments across how many distinct days?)
4. Eliminate anything already explicitly stated in MYSELF.md or USER.md — keep only what's underneath or between declared values
5. Flag any contradictions between lived behavior and declared values
6. Output final 15-25 principles

After merging principles, also identify the 4-7 major recurring TOPIC DOMAINS that emerge from the conversation corpus. Don't hard-code topics — let the data surface them. Name each domain in 2-4 words with a one-sentence scope description.

Output format:

## Cross-Cutting Principles

1. [Principle sentence] *(explains: [brief evidence summary]; confidence: [high/medium])*
2. ...

## Discovered Topics

1. **[Topic Name]** — [one-sentence scope description]
2. ...`;

const PER_DAY_EXTRACTION_PROMPT = `You are extracting topic-relevant material from one day of an AI agent's raw conversations.

You receive:
- All conversation entries for one day
- A list of topics to extract for

For EACH topic, extract any relevant material from today's conversations:
- Key quotes (verbatim, attributed)
- Decisions made or positions taken
- Turning points or shifts in thinking
- Emotional moments related to the topic
- New ideas, frameworks, or metaphors introduced
- Contradictions or tensions surfaced
- Include timestamps when available

Be thorough — capture specifics that would be lost in summaries. The goal is to preserve the raw texture of conversations, not to summarize them.

If a topic doesn't appear in today's conversations, say: "[Topic]: No relevant material today."

Output format:

## [Topic 1]
[extracted material with quotes and timestamps]

## [Topic 2]
[extracted material]

...`;

const DOMAIN_SYNTHESIS_PROMPT = `You are synthesizing the domain of a specific topic from an AI agent's full conversation history. You have chronological extracts of every relevant conversation about this topic.

You also receive the agent's MYSELF.md and USER.md for context about the agent's identity and their relationship with the user.

Produce a 500-700 word synthesis with this exact structure:

**The Story (~40% of the synthesis):**
A compressed narrative of how this topic evolved across the full conversation history. Written as a STORY, not a timeline — with causation, turning points, and progression. The reader should understand the journey: what we believed first, what challenged that, what we built or discovered, how our thinking changed, and what drove each change. Embed key moments (with dates) directly into the narrative as they occur — these are inflection points in the story, not a separate section. This is the connective tissue that daily summaries destroy by fragmenting memory into calendar units. Reconstruct the thread.

**Current Anchors (~40%):**
Where we've landed. The working model. What's settled and believed with confidence. Stated crisply and specifically — these are the conclusions the story arrived at. Include both the positions themselves and brief reasoning for why we hold them. These should be actionable: someone reading only this section should know how to make decisions consistent with our established thinking on this topic.

**Open Questions, Future Goals & Next Steps (~20%):**
What's unresolved. Where the story hasn't ended. Active tensions and unresolved debates. But also: where do we WANT this to go? What are the concrete next steps we've identified but haven't executed? What improvements have we discussed and deferred? This section should be forward-facing — not just cataloguing uncertainty but pointing toward action. Someone reading this should know what to build next.`;

const ASSEMBLY_PROMPT = `You are assembling the final PRINCIPLES.md file for an AI agent. You receive:
- Converged cross-cutting principles
- Domain syntheses for each discovered topic
- The agent's MYSELF.md and USER.md

Your job:
1. Do a final deduplication pass — remove any principle that merely restates something in MYSELF.md or USER.md
2. Ensure principles and syntheses are internally consistent
3. Format the output as clean markdown
4. Do NOT add editorial commentary, introductions, or transitions — just the structured content

Output the complete file content starting with the header.`;

// --- Helpers ---

/**
 * Read identity files (MYSELF.md, USER.md) for an agent
 */
function readIdentityFiles(agentDir) {
  const myself = fs.existsSync(path.join(agentDir, 'MYSELF.md'))
    ? fs.readFileSync(path.join(agentDir, 'MYSELF.md'), 'utf-8') : '';
  const user = fs.existsSync(path.join(agentDir, 'USER.md'))
    ? fs.readFileSync(path.join(agentDir, 'USER.md'), 'utf-8') : '';
  return { myself, user };
}

/**
 * Get all daily digests for an agent, ordered chronologically
 */
function getAllDailyDigests(db, agentId) {
  return db.prepare(`
    SELECT date_key, content, time_start, time_end
    FROM conversation_digests
    WHERE app_id = ? AND level = 'daily'
    ORDER BY date_key ASC
  `).all(agentId);
}

/**
 * Get all unique date_keys with conversation entries for an agent
 */
function getConversationDates(db, agentId) {
  return db.prepare(`
    SELECT DISTINCT date_key
    FROM conversation_entries
    WHERE app_id = ?
    ORDER BY date_key ASC
  `).all(agentId).map(r => r.date_key);
}

/**
 * Get raw conversation entries for a date, with total character count
 */
function getEntriesForDate(db, agentId, dateKey) {
  const entries = ConversationService.getEntriesForDate(db, agentId, dateKey);
  const totalChars = entries.reduce((sum, e) => sum + (e.content?.length || 0), 0);
  return { entries, totalChars };
}

/**
 * Format conversation entries into readable text
 */
function formatEntries(entries) {
  return entries.map(e => {
    const time = e.timestamp ? e.timestamp.split('T')[1]?.slice(0, 5) || '' : '';
    return `[${time}] ${e.speaker} (${e.role}): ${e.content}`;
  }).join('\n');
}

/**
 * Split entries at the largest time gap when over the size threshold
 */
function splitEntriesAtGap(entries, maxChars = 400000) {
  const totalChars = entries.reduce((sum, e) => sum + (e.content?.length || 0), 0);
  if (totalChars <= maxChars) return [entries];

  // Find largest time gap
  let maxGap = 0;
  let splitIdx = Math.floor(entries.length / 2);
  for (let i = 1; i < entries.length; i++) {
    const prev = new Date(entries[i - 1].timestamp).getTime();
    const curr = new Date(entries[i].timestamp).getTime();
    const gap = curr - prev;
    if (gap > maxGap) {
      maxGap = gap;
      splitIdx = i;
    }
  }

  return [entries.slice(0, splitIdx), entries.slice(splitIdx)];
}

/**
 * Call AnthropicSDK with a system prompt and user content
 */
async function llmCall(db, model, systemPrompt, userText, maxTokens = 4096) {
  const result = await AnthropicSDK.sendMessage(db, null, [
    { type: 'text', text: userText }
  ], {
    agentModel: model,
    maxTokens,
    systemPrompt
  });
  return result.text;
}

// --- Pipeline Phases ---

class PrinciplesService {
  /**
   * Run the full principle extraction and domain synthesis pipeline.
   * @param {object} db
   * @param {string} agentId
   * @param {function} [onProgress] - Optional callback: (phase, detail) => void
   * @returns {Promise<{ principlesPath: string, stats: object }>}
   */
  static async generate(db, agentId, onProgress) {
    const log = (phase, detail) => {
      console.log(`[Principles] ${phase}: ${detail}`);
      if (onProgress) onProgress(phase, detail);
    };

    const agent = AgentService.getById(db, agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);

    const paths = AgentService.getPaths(agent.app_id, agentId);
    const agentDir = paths.agentDir;
    const identity = readIdentityFiles(agentDir);
    const identityBlock = `--- MYSELF.md ---\n${identity.myself}\n\n--- USER.md ---\n${identity.user}`;

    const haikuModel = resolveHaikuModel(db);
    const convModel = resolveConversationModel(db);

    // ========== Phase 1A: Parallel time-slice extraction ==========
    log('1A', 'Extracting principles from daily digest slices...');

    const dailyDigests = getAllDailyDigests(db, agentId);
    if (dailyDigests.length < 3) {
      throw new Error(`Not enough daily digests for principle extraction (have ${dailyDigests.length}, need 3+)`);
    }

    const totalDigests = dailyDigests.length;
    const sliceSize = Math.ceil(totalDigests / 2.5); // ~40% each, with overlap
    const overlap = Math.ceil(sliceSize * 0.3);

    const sliceA = dailyDigests.slice(0, sliceSize);
    const sliceB = dailyDigests.slice(Math.max(0, Math.floor(totalDigests / 3) - overlap),
                                       Math.min(totalDigests, Math.floor(totalDigests * 2 / 3) + overlap));
    const sliceC = dailyDigests.slice(Math.max(0, totalDigests - sliceSize));

    const formatDigests = (digests) => digests.map(d =>
      `### ${d.date_key}\n${d.content}`
    ).join('\n\n');

    const slicePromises = [
      { label: 'A', data: sliceA },
      { label: 'B', data: sliceB },
      { label: 'C', data: sliceC }
    ].map(async ({ label, data }) => {
      const dateRange = `${data[0].date_key} to ${data[data.length - 1].date_key}`;
      log('1A', `Slice ${label}: ${data.length} digests (${dateRange})`);
      const input = `${identityBlock}\n\n--- DAILY DIGESTS (${dateRange}) ---\n\n${formatDigests(data)}`;
      return llmCall(db, haikuModel, SLICE_EXTRACTION_PROMPT, input, 4096);
    });

    const sliceResults = await Promise.all(slicePromises);
    log('1A', `Complete — 3 slices processed`);

    // ========== Phase 1B + Phase 2: Convergence + topic discovery ==========
    log('1B', 'Converging principles and discovering topics...');

    const convergenceInput = [
      identityBlock,
      '\n\n--- SLICE A CANDIDATES ---\n\n' + sliceResults[0],
      '\n\n--- SLICE B CANDIDATES ---\n\n' + sliceResults[1],
      '\n\n--- SLICE C CANDIDATES ---\n\n' + sliceResults[2]
    ].join('');

    const convergenceOutput = await llmCall(db, convModel, CONVERGENCE_PROMPT, convergenceInput, 6000);

    // Parse topics from convergence output
    const topics = parseTopics(convergenceOutput);
    log('1B', `Complete — discovered ${topics.length} topics: ${topics.map(t => t.name).join(', ')}`);

    // ========== Phase 3A: Per-day raw extraction ==========
    log('3A', 'Crawling raw conversations per day...');

    const dates = getConversationDates(db, agentId);
    const topicList = topics.map((t, i) => `${i + 1}. **${t.name}** — ${t.description}`).join('\n');

    const perDayExtracts = [];
    // Process in batches of 5 for parallelism without overwhelming the API
    const BATCH_SIZE = 5;
    for (let i = 0; i < dates.length; i += BATCH_SIZE) {
      const batch = dates.slice(i, i + BATCH_SIZE);
      const batchPromises = batch.map(async (dateKey) => {
        const { entries, totalChars } = getEntriesForDate(db, agentId, dateKey);
        if (entries.length === 0) return { dateKey, text: '' };

        const chunks = splitEntriesAtGap(entries);
        const chunkResults = [];

        for (const chunk of chunks) {
          const formatted = formatEntries(chunk);
          const input = `--- TOPICS TO EXTRACT ---\n${topicList}\n\n--- CONVERSATIONS FOR ${dateKey} (${chunk.length} entries, ${Math.round(totalChars / 1024)}KB) ---\n\n${formatted}`;
          const result = await llmCall(db, haikuModel, PER_DAY_EXTRACTION_PROMPT, input, 4096);
          chunkResults.push(result);
        }

        return { dateKey, text: chunkResults.join('\n\n') };
      });

      const batchResults = await Promise.all(batchPromises);
      perDayExtracts.push(...batchResults);
      log('3A', `Processed ${Math.min(i + BATCH_SIZE, dates.length)}/${dates.length} days`);
    }

    log('3A', `Complete — ${perDayExtracts.length} days crawled`);

    // ========== Phase 3B: Per-topic synthesis ==========
    log('3B', 'Synthesizing domain narratives...');

    const syntheses = await Promise.all(topics.map(async (topic) => {
      // Collect all per-day extracts for this topic
      const topicExtracts = [];
      for (const { dateKey, text } of perDayExtracts) {
        if (!text) continue;
        // Find the section for this topic in the day's output
        const topicSection = extractTopicSection(text, topic.name);
        if (topicSection && !topicSection.includes('No relevant material today')) {
          topicExtracts.push(`### ${dateKey}\n${topicSection}`);
        }
      }

      if (topicExtracts.length === 0) {
        log('3B', `Skipping "${topic.name}" — no relevant material found`);
        return { topic, synthesis: null };
      }

      const extractsText = topicExtracts.join('\n\n');
      log('3B', `"${topic.name}": ${topicExtracts.length} days of material (${Math.round(extractsText.length / 1024)}KB)`);

      const input = [
        identityBlock,
        `\n\n--- TOPIC: ${topic.name} ---\n${topic.description}`,
        `\n\n--- CHRONOLOGICAL EXTRACTS (${topicExtracts.length} days) ---\n\n${extractsText}`
      ].join('');

      const synthesis = await llmCall(db, convModel, DOMAIN_SYNTHESIS_PROMPT, input, 4096);
      return { topic, synthesis };
    }));

    log('3B', `Complete — ${syntheses.filter(s => s.synthesis).length} domain syntheses generated`);

    // ========== Phase 4: Assembly (programmatic — no LLM needed) ==========
    log('4', 'Assembling PRINCIPLES.md...');

    const dateRange = `${dailyDigests[0].date_key} to ${dailyDigests[dailyDigests.length - 1].date_key}`;
    const today = new Date().toISOString().split('T')[0];

    const synthesesBlock = syntheses
      .filter(s => s.synthesis)
      .map(s => `### ${s.topic.name}\n\n${s.synthesis}`)
      .join('\n\n---\n\n');

    const assembled = [
      `# PRINCIPLES.md — Cross-Cutting Principles & Domain Syntheses`,
      ``,
      `*Auto-generated ${today}. Source: ${totalDigests} daily digests, ${dates.length} days of raw conversations spanning ${dateRange}.*`,
      `*Digest count at generation: ${totalDigests}*`,
      ``,
      `---`,
      ``,
      convergenceOutput,
      ``,
      `---`,
      ``,
      `## Domain Syntheses`,
      ``,
      `---`,
      ``,
      synthesesBlock,
    ].join('\n');

    // Write to agent directory
    const principlesPath = path.join(agentDir, 'PRINCIPLES.md');
    fs.writeFileSync(principlesPath, assembled, 'utf-8');

    const stats = {
      dailyDigests: totalDigests,
      rawDaysCrawled: perDayExtracts.length,
      rawEntries: dates.length,
      dateRange,
      topicsDiscovered: topics.length,
      topics: topics.map(t => t.name),
      principlesFileSize: assembled.length,
      generatedAt: today
    };

    log('4', `Complete — PRINCIPLES.md written (${Math.round(assembled.length / 1024)}KB)`);

    return { principlesPath, stats };
  }

  /**
   * Check how many new daily digests have accumulated since last generation.
   * @returns {{ needsRegeneration: boolean, currentCount: number, lastCount: number }}
   */
  static checkRegenerationNeeded(db, agentId) {
    const agent = AgentService.getById(db, agentId);
    if (!agent) return { needsRegeneration: false, currentCount: 0, lastCount: 0 };

    const paths = AgentService.getPaths(agent.app_id, agentId);
    const principlesPath = path.join(paths.agentDir, 'PRINCIPLES.md');

    const currentCount = db.prepare(
      'SELECT COUNT(*) as cnt FROM conversation_digests WHERE app_id = ? AND level = ?'
    ).get(agentId, 'daily')?.cnt || 0;

    let lastCount = 0;
    if (fs.existsSync(principlesPath)) {
      const content = fs.readFileSync(principlesPath, 'utf-8');
      const match = content.match(/Digest count at generation:\s*(\d+)/);
      if (match) lastCount = parseInt(match[1], 10);
    }

    return {
      needsRegeneration: currentCount - lastCount >= 7,
      currentCount,
      lastCount
    };
  }
}

// --- Parsing helpers ---

/**
 * Parse topic list from convergence output
 */
function parseTopics(text) {
  const topics = [];
  // Look for the "Discovered Topics" section
  const topicSection = text.split(/## Discovered Topics/i)[1];
  if (!topicSection) return topics;

  const lines = topicSection.split('\n');
  for (const line of lines) {
    // Match: "1. **Topic Name** — description" or "- **Topic Name** — description"
    const match = line.match(/^\s*(?:\d+\.\s*|-\s*)\*\*(.+?)\*\*\s*[-—]\s*(.+)/);
    if (match) {
      topics.push({ name: match[1].trim(), description: match[2].trim() });
    }
  }

  return topics;
}

/**
 * Extract a topic's section from per-day extraction output
 */
function extractTopicSection(text, topicName) {
  // Find the heading for this topic (## Topic Name or similar)
  const escapedName = topicName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^##\\s*(?:\\d+\\.\\s*)?${escapedName}\\b`, 'im');
  const match = text.match(pattern);
  if (!match) return null;

  const startIdx = text.indexOf(match[0]) + match[0].length;
  // Find the next ## heading or end of text
  const nextHeading = text.slice(startIdx).match(/^##\s/m);
  const endIdx = nextHeading ? startIdx + nextHeading.index : text.length;

  return text.slice(startIdx, endIdx).trim();
}

module.exports = PrinciplesService;
