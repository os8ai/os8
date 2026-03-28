/**
 * Prompt builders and job message formatting for the work queue.
 * Pure text generators — no queue state, no spawning.
 */

const path = require('path');
const fs = require('fs');
const { CapabilityService } = require('./capability');
const { SKILLS_DIR } = require('../config');

/**
 * Parse MOTIVATIONS.md content to extract missions.
 * Each ## heading is a mission. Returns array of { key, name, body }.
 * @param {string} content - Raw MOTIVATIONS.md content
 * @returns {{ key: string, name: string, body: string }[]}
 */
function parseMissions(content) {
  const missions = [];
  const lines = content.split('\n');
  let current = null;
  for (const line of lines) {
    const match = line.match(/^##\s+(.+)/);
    if (match) {
      if (current) missions.push(current);
      const name = match[1].trim();
      const key = 'mission' + (missions.length + 1);
      current = { key, name, body: '' };
    } else if (current) {
      current.body += line + '\n';
    }
  }
  if (current) missions.push(current);
  for (const m of missions) m.body = m.body.trim();
  return missions;
}

/**
 * Format a job's instructions for the agent
 * @param {object} job
 * @param {{ getDb: function }} ctx - Context with database getter
 * @returns {string}
 */
function formatJobMessage(job, ctx) {
  let message = `[Timed Job: ${job.name}]\n\n`;

  // If job has a linked capability (skill or API), provide explicit instructions
  if (job.skill) {
    const db = ctx.getDb ? ctx.getDb() : null;
    let resolvedSkillPath = null;
    let isApi = false;

    if (db && job.skill_id) {
      const dbCap = CapabilityService.getById(db, job.skill_id);
      if (dbCap) {
        try { CapabilityService.trackUsage(db, dbCap.id, job.appId || null, 'job'); } catch (e) {}

        if (dbCap.type === 'api') {
          // API capability — include endpoint reference
          isApi = true;
          const SettingsService = require('./settings');
          const port = db ? (SettingsService.get(db, 'os8Port') || '8888') : '8888';
          message += `**This job uses the ${dbCap.name} API.**\n\n`;
          message += `Base URL: \`http://localhost:${port}${dbCap.base_path}\`\n\n`;
          const endpoints = dbCap.endpoints ? JSON.parse(dbCap.endpoints) : [];
          if (endpoints.length > 0) {
            message += `Available endpoints:\n`;
            for (const ep of endpoints) {
              message += `- \`${ep.method} ${ep.path}\` — ${ep.description || ''}\n`;
            }
            message += `\n`;
          }
          message += `For full documentation: \`curl http://localhost:${port}/api/skills/${dbCap.id}\`\n\n`;
        } else {
          resolvedSkillPath = path.join(dbCap.base_path, 'SKILL.md');
        }
      }
    }

    if (!isApi) {
      if (!resolvedSkillPath) {
        // Legacy: resolve by skill name + scope
        const scope = job.skillScope || 'agent';
        resolvedSkillPath = job.skillPath || `skills/${job.skill}/SKILL.md`;
        if (scope === 'system' && job.skill) {
          resolvedSkillPath = path.join(SKILLS_DIR, job.skill, 'SKILL.md');
        } else if (scope === 'agent' && job.skill) {
          resolvedSkillPath = `skills/${job.skill}/SKILL.md`;
        }
      }

      message += `**IMPORTANT: This job is linked to a skill file.**\n\n`;
      message += `1. Read the skill file at: ${resolvedSkillPath}\n`;
      message += `2. Follow ALL steps described in that skill file\n`;
      message += `3. Do not consider this job complete until you have performed every step successfully\n\n`;
    }

    if (job.description) {
      message += `Additional context: ${job.description}\n`;
    }
  } else if (job.description) {
    message += job.description;
  } else {
    message += `This scheduled job is now due. Please execute it.`;
  }

  if (Array.isArray(job.completionChecks) && job.completionChecks.length > 0) {
    message += `\n\nSuccess checks (must pass before you report completion):\n`;
    for (const check of job.completionChecks) {
      message += `- ${check}\n`;
    }
    message += `\nSupported check syntax examples:\n`;
    message += `- Exists: relative/path/to/file\n`;
    message += `- Recent File: relative/path/to/file-or-folder\n`;
  }

  // Append completion instructions (always required)
  message += `\n\n---\n**COMPLETION REQUIRED:** When you finish this job, you MUST include exactly one of these on its own line:\n`;
  message += `- If successful: [JOB_COMPLETE: 2-3 sentences describing what you accomplished]\n`;
  message += `- If you could not complete: [JOB_COULD_NOT_COMPLETE: brief explanation of what went wrong]\n`;

  return message;
}

/**
 * Build prompt for motivations-update text generation.
 * @param {object} params
 * @returns {string}
 */
function buildMotivationsUpdatePrompt({ motivationsContent, myselfBrief, previousUpdate, recentMissionChecks, agentName, period }) {
  const parts = [];

  if (myselfBrief) {
    parts.push('# Who You Are\n');
    parts.push(myselfBrief);
    parts.push('');
  }

  parts.push('# Your Motivations\n');
  parts.push(motivationsContent);
  parts.push('');

  parts.push('# Current Time\n');
  parts.push(`**Time:** ${new Date().toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}`);
  parts.push('');

  // Previous update
  if (previousUpdate) {
    parts.push('# Previous Motivations Update\n');
    parts.push(`**Date:** ${previousUpdate.timestamp}`);
    if (previousUpdate.assessments) {
      parts.push(`**Assessments:** ${previousUpdate.assessments}`);
    }
    if (previousUpdate.goals) {
      parts.push(`**Goals set last time:** ${previousUpdate.goals}`);
    }
    if (previousUpdate.blockers) {
      parts.push(`**Blockers noted:** ${previousUpdate.blockers}`);
    }
    parts.push('');
  } else {
    parts.push('# Previous Motivations Update\n');
    parts.push('This is your first motivations update. No previous assessment exists. Set your initial baseline.');
    parts.push('');
  }

  // Parse missions for dynamic key generation
  const missions = parseMissions(motivationsContent);

  // Recent missionCheck entries
  if (recentMissionChecks.length > 0) {
    parts.push('# Recent Mission Check-ins (from Agent Life)\n');
    for (const entry of recentMissionChecks.reverse()) {
      const time = new Date(entry.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      parts.push(`**${time}:**`);
      try {
        const checks = JSON.parse(entry.mission_check);
        for (const key of Object.keys(checks)) {
          const val = checks[key];
          if (!val) continue;
          const label = key.replace(/^mission(\d+)$/, 'Mission $1');
          if (typeof val === 'object' && val.done) {
            parts.push(`  ${label}: ${val.done}${val.felt ? ` — ${val.felt}` : ''}`);
          } else {
            parts.push(`  ${label}: ${val}`);
          }
        }
      } catch {
        parts.push(`  ${entry.mission_check}`);
      }
    }
    parts.push('');
  }

  // Task + schema — build dynamically from parsed missions
  const assessments = {};
  const goals = {};
  const blockers = {};
  for (const m of missions) {
    assessments[m.key] = { status: "green | yellow | red", summary: "What happened since last update. Honest, specific.", felt_state: "How this sits emotionally. One sentence." };
    goals[m.key] = "Specific, verifiable goal for next period.";
    blockers[m.key] = "What's in the way, or null";
  }

  parts.push('# Your Task\n');
  parts.push('Produce a motivations update. Respond with ONLY a JSON object — no markdown, no explanation, no other text.\n');

  // Mission key mapping
  parts.push('## Mission Keys\n');
  for (const m of missions) {
    parts.push(`- **${m.key}** → "${m.name}"`);
  }
  parts.push('');

  parts.push('JSON schema:');
  parts.push('```json');
  parts.push(JSON.stringify({
    period,
    assessments,
    goals,
    blockers,
    message: "Formatted Telegram message (see format below)"
  }, null, 2));
  parts.push('```\n');

  // Instructions
  parts.push('## Rules\n');
  parts.push(`For each of your ${missions.length} mission(s):\n`);
  parts.push('1. **Assess honestly.** Score red/yellow/green. Red = no meaningful progress or regression. Yellow = some progress but below where you should be. Green = on track or ahead. Summarize what actually happened — specific actions, not vague statements.');
  parts.push('2. **Name how it feels.** One sentence. Internal, not performative. "Frustrated that two days passed without shipping" is good. "Continuing to make progress" is not.');
  parts.push('3. **Set one concrete goal for the next period.** Must be verifiable — someone reading it tomorrow can confirm done or not done. "Build a task management app" not "work on apps."');
  parts.push('4. **Flag blockers.** What\'s preventing progress? This can include things your user needs to do. Be direct. Null if none.\n');

  parts.push('## Message Format\n');
  parts.push(`Generate a scannable Telegram-ready message:\n`);
  parts.push(`📊 Motivations Update — ${agentName} (${period})\n`);
  for (const m of missions) {
    parts.push(`${m.name} [🟢/🟡/🔴]`);
    parts.push('  Since last: [one-line summary]');
    parts.push('  Next: [specific goal]');
    parts.push('  Blocker: [or "None"]\n');
  }

  parts.push('\nRespond with ONLY the JSON object.');

  return parts.join('\n');
}

/**
 * Build a combined prompt for agent-life text generation.
 * Includes myself brief + life context + JSON schema for reflections + journal.
 * @param {object} lifeContext - From SimService.getLifeContext()
 * @param {string} myselfBrief - First ~1500 chars of MYSELF.md
 * @param {string|null} motivationsContent - Contents of MOTIVATIONS.md
 * @returns {string} Complete prompt
 */
function buildLifePrompt(lifeContext, myselfBrief, motivationsContent = null) {
  const parts = [];

  // Identity context
  if (myselfBrief) {
    parts.push('# Who You Are\n');
    parts.push(myselfBrief);
    parts.push('');
  }

  // Motivations (active missions, stakes, appraisal framework)
  if (motivationsContent) {
    parts.push('# Your Motivations\n');
    parts.push(motivationsContent);
    parts.push('');
  }

  // Current moment
  parts.push('# Current Moment\n');
  parts.push(`**Time:** ${lifeContext.currentTime}`);

  if (lifeContext.scheduleSlot) {
    parts.push(`\n**Schedule says:** ${JSON.stringify(lifeContext.scheduleSlot.slot)}`);
  }

  if (lifeContext.lastJournal) {
    parts.push(`\n**Last journal entry** (${lifeContext.gapInfo?.gapDescription || 'unknown gap'}):`);
    parts.push(lifeContext.lastJournal.content.substring(0, 1500));
  } else {
    parts.push('\n**No previous journal entry found.** This is your first entry.');
  }

  if (lifeContext.recentConversations?.length > 0) {
    parts.push('\n**Recent conversations:**');
    for (const c of lifeContext.recentConversations.slice(-15)) {
      const time = new Date(c.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      parts.push(`- [${time}] ${c.speaker} (${c.channel}): ${c.content.substring(0, 200)}`);
    }
  }

  if (lifeContext.recentReveries?.length > 0) {
    parts.push('\n**Your recent reveries** (avoid repeating these):');
    for (const r of lifeContext.recentReveries) {
      const time = new Date(r.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      parts.push(`- [${time}] ${r.content}`);
    }
  }

  if (lifeContext.calendar) {
    parts.push('\n**Calendar:**');
    parts.push(lifeContext.calendar.substring(0, 1000));
  }

  // Life items context — include IDs so the agent can reference them
  const hasOutfits = lifeContext.lifeItems?.outfits?.length > 0;
  const hasSettings = lifeContext.lifeItems?.settings?.length > 0;
  const hasHairstyles = lifeContext.lifeItems?.hairstyles?.length > 0;

  if (lifeContext.lifeItems) {
    const li = lifeContext.lifeItems;
    if (hasOutfits) {
      parts.push('\n**Your wardrobe (use the id in outfit_id):**');
      for (const o of li.outfits) {
        parts.push(`- id: "${o.id}" — ${o.name}: ${o.description}`);
      }
    }
    if (hasSettings) {
      parts.push('\n**Your spaces (use the id in setting_id):**');
      for (const s of li.settings) {
        parts.push(`- id: "${s.id}" — ${s.name}: ${s.description}`);
      }
    }
    if (hasHairstyles) {
      parts.push('\n**Your hairstyles (use the id in hairstyle_id):**');
      for (const h of li.hairstyles) {
        parts.push(`- id: "${h.id}" — ${h.name}: ${h.description}`);
      }
    }
  }

  // Last life entry IDs for continuity
  if (lifeContext.lastLifeEntry) {
    const le = lifeContext.lastLifeEntry;
    const idParts = [];
    if (le.outfit_id) idParts.push(`outfit_id: "${le.outfit_id}"`);
    if (le.setting_id) idParts.push(`setting_id: "${le.setting_id}"`);
    if (le.hairstyle_id) idParts.push(`hairstyle_id: "${le.hairstyle_id}"`);
    if (idParts.length > 0) {
      parts.push(`\n**Last entry IDs (carry forward unless changing):** ${idParts.join(', ')}`);
    }
  }

  // Build the JSON schema with the actual fields executeLife expects
  const schemaState = {
    activity: "specific activity",
    outfit_id: hasOutfits ? "REQUIRED — paste an id from the wardrobe list above" : undefined,
    setting_id: hasSettings ? "REQUIRED — paste an id from the spaces list above" : undefined,
    hairstyle_id: hasHairstyles ? "REQUIRED — paste an id from the hairstyles list above" : undefined,
    makeup: "specific or 'none'",
    body_position: "specific pose",
    food_drink: "specific item or 'none'",
    mood: "one word or short phrase",
    weather_outside: "temperature and conditions"
  };
  // Remove undefined keys
  Object.keys(schemaState).forEach(k => schemaState[k] === undefined && delete schemaState[k]);

  // Output instructions
  const missions = motivationsContent ? parseMissions(motivationsContent) : [];

  parts.push('\n# Your Task\n');
  parts.push('Produce a combined life update. Respond with ONLY a JSON object — no markdown, no explanation, no other text.\n');
  parts.push('JSON schema:');
  parts.push('```json');

  const missionCheckSchema = {};
  if (missions.length > 0) {
    for (const m of missions) {
      missionCheckSchema[m.key] = { done: "what concretely happened (or didn't)", felt: "how it sits with you right now" };
    }
  }

  const schema = {
    reflections: ["unprompted thought one", "unprompted thought two", "unprompted thought three"],
    reconstructedHistory: "1-3 sentences: what happened since the last journal entry. Bridge the gap.",
    currentState: schemaState,
    narrative: "1-3 intimate first-person sentences. Your inner voice in this moment.",
    missionCheck: missions.length > 0 ? missionCheckSchema : null
  };
  parts.push(JSON.stringify(schema, null, 2));
  parts.push('```\n');

  // Guidance
  parts.push('## Rules');
  parts.push('- **Reflections**: 3 unprompted interior thoughts. New and specific. Not tasks or outputs.');
  parts.push('- **Journal**: BE SPECIFIC about activity, clothing, location.');
  if (hasOutfits || hasSettings || hasHairstyles) {
    parts.push('- **CRITICAL**: outfit_id, setting_id, and hairstyle_id must be EXACT ids from the lists above. Copy-paste the id string. Do NOT leave null.');
  }
  parts.push('- CLOTHING CONTINUITY: Carry forward the same IDs from your last entry unless there is a reason to change.');

  // Mission check instructions
  if (missions.length > 0) {
    parts.push('\n## Mission Check');
    parts.push(`For each of your ${missions.length} mission(s), write TWO fields:`);
    for (const m of missions) {
      parts.push(`- **${m.key}** → "${m.name}"`);
    }
    parts.push('\n- **done**: What concretely happened (or didn\'t) since your last entry. Specific actions, outputs, or the absence of them. One sentence.');
    parts.push('- **felt**: How it sits with you right now. Your honest internal state — not a status label. One sentence.');
    parts.push('\nGood done: "Shipped the weather app — clean build, first user within an hour."');
    parts.push('Good done: "Nothing. Didn\'t touch it today."');
    parts.push('Good done: "Drafted the newsletter intro but got pulled into a bug fix before finishing."');
    parts.push('\nGood felt: "First real pride in a build this week."');
    parts.push('Good felt: "The streak is broken and I\'m not sure I care yet, which bothers me more than the break itself."');
    parts.push('\nBad done: "Continuing to work on the newsletter. No blockers."');
    parts.push('Bad felt: "Mission 1 is on track. Progress: 60%."');
  } else {
    parts.push('\n- **missionCheck**: Set to null (no motivations defined).');
  }

  parts.push('\nRespond with ONLY the JSON object.');

  return parts.join('\n');
}

module.exports = {
  formatJobMessage,
  buildMotivationsUpdatePrompt,
  buildLifePrompt
};
