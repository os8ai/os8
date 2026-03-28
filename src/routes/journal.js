/**
 * Journal API Route
 * Handles POST /api/assistant/journal for real-time journal entry recording
 * Also handles migration of historical journal entries
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const ConversationService = require('../services/conversation');
const { BLOB_DIR, APPS_DIR } = require('../config');
const AgentService = require('../services/agent');

/**
 * Format journal entry content from structured JSON
 * @param {object} entry - Journal entry data
 * @returns {string} Formatted content string
 */
function formatJournalContent(entry) {
  const lines = [];

  // Activity (handles both string and {primary, secondary} object formats)
  if (entry.activity) {
    let activity;
    if (typeof entry.activity === 'string') {
      activity = entry.activity;
    } else {
      activity = entry.activity.secondary
        ? `${entry.activity.primary}; ${entry.activity.secondary}`
        : entry.activity.primary;
    }
    lines.push(`**Activity:** ${activity}`);
  }

  // Location (handles both string and {place, details} object formats)
  if (entry.location) {
    let location;
    if (typeof entry.location === 'string') {
      location = entry.location;
    } else {
      location = entry.location.details
        ? `${entry.location.place} — ${entry.location.details}`
        : entry.location.place;
    }
    lines.push(`**Location:** ${location}`);
  }

  // Appearance
  if (entry.appearance) {
    const parts = [];
    if (entry.appearance.outfit) parts.push(entry.appearance.outfit);
    if (entry.appearance.top) parts.push(entry.appearance.top);
    if (entry.appearance.bottom) parts.push(entry.appearance.bottom);
    if (entry.appearance.shoes) parts.push(entry.appearance.shoes);
    if (entry.appearance.hair) parts.push(entry.appearance.hair);
    if (entry.appearance.makeup) parts.push(entry.appearance.makeup);
    if (entry.appearance.accessories) parts.push(entry.appearance.accessories);
    if (parts.length > 0) {
      lines.push(`**Appearance:** ${parts.join(', ')}`);
    }
  }

  // Food/Drink
  if (entry.food_drink) {
    lines.push(`**Food/Drink:** ${entry.food_drink}`);
  }

  // Mood
  if (entry.mood) {
    lines.push(`**Mood:** ${entry.mood}`);
  }

  // Weather
  if (entry.weather_outside) {
    lines.push(`**Weather:** ${entry.weather_outside}`);
  }

  // Narrative (separated by blank line)
  if (entry.narrative) {
    lines.push('');
    lines.push(entry.narrative);
  }

  return lines.join('\n');
}

/**
 * Create journal router
 * @param {object} db - Database instance
 * @param {object} deps - Dependencies
 * @returns {Router} Express router
 */
/**
 * Resolve the agent for this request.
 * Uses req.agentId (agent-scoped route) when available, falls back to default agent.
 */
function resolveAgent(db, req, AppService) {
  if (req.agentId) {
    const agent = AgentService.getById(db, req.agentId);
    if (agent) return agent;
  }
  return AgentService.getDefault(db) || AppService.getAssistant(db);
}

function createJournalRouter(db, deps) {
  const { AppService, APPS_DIR } = deps;
  const router = express.Router();

  /**
   * POST /api/assistant/journal
   * Record a journal entry to the conversation database
   */
  router.post('/', (req, res) => {
    const entry = req.body;

    // Validate required fields
    if (!entry.narrative) {
      return res.status(400).json({ error: 'narrative is required' });
    }

    // Get assistant app
    const assistant = db ? resolveAgent(db, req, AppService) : null;
    if (!assistant) {
      return res.status(404).json({ error: 'Assistant not found' });
    }

    // Get agent name
    const agentName = ConversationService.getAgentName(assistant.id);

    // Format content
    const content = formatJournalContent(entry);

    // Build metadata (store full structured data for future queryability)
    const metadata = {
      activity: entry.activity || null,
      location: entry.location || null,
      appearance: entry.appearance || null,
      food_drink: entry.food_drink || null,
      mood: entry.mood || null,
      weather_outside: entry.weather_outside || null
    };

    try {
      const result = ConversationService.addEntry(db, assistant.id, {
        type: 'journal',
        speaker: agentName,
        role: 'assistant',
        channel: 'journal',
        content,
        metadata
      });

      res.json({
        success: true,
        entryId: result.id
      });
    } catch (err) {
      console.error('Failed to record journal entry:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/assistant/journal/migrate-conversations
   * Migrate historical conversation entries from memory MD files to database
   */
  router.post('/migrate-conversations', (req, res) => {
    const dryRun = req.query.dryRun === 'true';

    const assistant = db ? resolveAgent(db, req, AppService) : null;
    if (!assistant) {
      return res.status(404).json({ error: 'Assistant not found' });
    }

    const agentName = ConversationService.getAgentName(assistant.id);
    const { agentDir } = AgentService.getPaths(assistant.app_id || assistant.id, assistant.id);
    const memoryDir = path.join(agentDir, 'memory');

    if (!fs.existsSync(memoryDir)) {
      return res.json({ success: true, message: 'No memory directory found', entriesMigrated: 0 });
    }

    const files = fs.readdirSync(memoryDir)
      .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.md$/))
      .sort();

    let totalEntries = 0;
    let migratedDates = 0;
    let skippedDates = 0;
    const details = [];

    for (const filename of files) {
      const dateKey = filename.replace('.md', '');
      const filePath = path.join(memoryDir, filename);

      // Check if already migrated
      const existingCount = db.prepare(`
        SELECT COUNT(*) as count FROM conversation_entries
        WHERE app_id = ? AND date_key = ? AND type = 'conversation'
      `).get(assistant.id, dateKey);

      if (existingCount.count > 0) {
        details.push({ date: dateKey, status: 'skipped', reason: 'already migrated' });
        skippedDates++;
        continue;
      }

      const entries = parseConversationFile(filePath, dateKey, agentName);

      if (entries.length === 0) {
        details.push({ date: dateKey, status: 'skipped', reason: 'no conversations found' });
        continue;
      }

      if (!dryRun) {
        for (const entry of entries) {
          try {
            ConversationService.addEntry(db, assistant.id, entry);
          } catch (err) {
            console.error(`Migration error for ${dateKey}:`, err.message);
          }
        }
      }

      details.push({ date: dateKey, status: dryRun ? 'would migrate' : 'migrated', entries: entries.length });
      totalEntries += entries.length;
      migratedDates++;
    }

    res.json({
      success: true,
      dryRun,
      migratedDates,
      skippedDates,
      totalEntries,
      details
    });
  });

  /**
   * POST /api/assistant/journal/migrate
   * Migrate historical journal entries from MD files to database
   */
  router.post('/migrate', (req, res) => {
    const dryRun = req.query.dryRun === 'true';

    // Get assistant app
    const assistant = db ? resolveAgent(db, req, AppService) : null;
    if (!assistant) {
      return res.status(404).json({ error: 'Assistant not found' });
    }

    const agentName = ConversationService.getAgentName(assistant.id);
    const { agentBlobDir } = AgentService.getPaths(assistant.app_id || assistant.id, assistant.id);
    const journalDir = path.join(agentBlobDir, 'journal');

    if (!fs.existsSync(journalDir)) {
      return res.json({ success: true, message: 'No journal directory found', entriesMigrated: 0 });
    }

    // Get all journal files
    const files = fs.readdirSync(journalDir)
      .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.md$/))
      .sort();

    let totalEntries = 0;
    let migratedDates = 0;
    let skippedDates = 0;
    const details = [];

    for (const filename of files) {
      const dateKey = filename.replace('.md', '');
      const filePath = path.join(journalDir, filename);

      // Check if already migrated
      const existingCount = db.prepare(`
        SELECT COUNT(*) as count FROM conversation_entries
        WHERE app_id = ? AND date_key = ? AND type = 'journal'
      `).get(assistant.id, dateKey);

      if (existingCount.count > 0) {
        details.push({ date: dateKey, status: 'skipped', reason: 'already migrated' });
        skippedDates++;
        continue;
      }

      // Parse the file
      const entries = parseJournalFile(filePath, dateKey, agentName);

      if (entries.length === 0) {
        details.push({ date: dateKey, status: 'skipped', reason: 'no entries found' });
        continue;
      }

      if (!dryRun) {
        for (const entry of entries) {
          try {
            ConversationService.addEntry(db, assistant.id, entry);
          } catch (err) {
            console.error(`Migration error for ${dateKey}:`, err.message);
          }
        }
      }

      details.push({ date: dateKey, status: dryRun ? 'would migrate' : 'migrated', entries: entries.length });
      totalEntries += entries.length;
      migratedDates++;
    }

    res.json({
      success: true,
      dryRun,
      migratedDates,
      skippedDates,
      totalEntries,
      details
    });
  });

  return router;
}

/**
 * Parse time from header like "### 1:07 AM"
 */
function parseTime(timeHeader) {
  const match = timeHeader.match(/###\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const period = match[3].toUpperCase();

  if (period === 'PM' && hours !== 12) hours += 12;
  else if (period === 'AM' && hours === 12) hours = 0;

  return { hours, minutes };
}

/**
 * Parse a journal MD file and extract entries
 */
function parseJournalFile(filePath, dateKey, agentName) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const entries = [];

  // Split by entry separator
  const sections = content.split(/\n---\n/);

  for (const section of sections) {
    const timeMatch = section.match(/###\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!timeMatch) continue;

    const timeObj = parseTime(timeMatch[0]);
    if (!timeObj) continue;

    const jsonMatch = section.match(/```json\s*([\s\S]*?)```/);
    if (!jsonMatch) continue;

    let json;
    try {
      json = JSON.parse(jsonMatch[1]);
    } catch (e) {
      continue;
    }

    // Extract narrative (text after JSON, excluding [internal: ...])
    const afterJson = section.slice(section.indexOf('```', section.indexOf('```json') + 7) + 3);
    let narrative = afterJson.replace(/\[internal:[\s\S]*?\]/gi, '').trim();
    if (!narrative || narrative === '---') narrative = null;

    // Build timestamp
    const timestamp = new Date(
      parseInt(dateKey.slice(0, 4), 10),
      parseInt(dateKey.slice(5, 7), 10) - 1,
      parseInt(dateKey.slice(8, 10), 10),
      timeObj.hours,
      timeObj.minutes,
      0
    ).toISOString();

    // Format content
    const formattedContent = formatJournalContent({ ...json, narrative });

    entries.push({
      type: 'journal',
      speaker: agentName,
      role: 'assistant',
      channel: 'journal',
      content: formattedContent,
      timestamp,
      date_key: dateKey,
      metadata: {
        activity: json.activity || null,
        location: json.location || null,
        appearance: json.appearance || null,
        food_drink: json.food_drink || null,
        mood: json.mood || null,
        weather_outside: json.weather_outside || null
      }
    });
  }

  return entries;
}

/**
 * Parse a conversation MD file and extract entries
 */
function parseConversationFile(filePath, dateKey, agentName) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const entries = [];

  // Find the Conversations section
  const convMatch = content.match(/## Conversations\s*\n([\s\S]*?)(?=\n## |\n---|\Z|$)/);
  if (!convMatch) return entries;

  const convSection = convMatch[1];

  // Match entries: [time] **User:** ... **Assistant:** ...
  const pattern = /\[(\d{1,2}:\d{2}:\d{2}\s*(?:AM|PM))\]\s*\*\*User:\*\*\s*([\s\S]*?)\*\*Assistant:\*\*\s*([\s\S]*?)(?=\[\d{1,2}:\d{2}:\d{2}|$)/gi;

  let match;
  while ((match = pattern.exec(convSection)) !== null) {
    const timeStr = match[1];
    const userContent = match[2].trim();
    const assistantContent = match[3].trim();

    const timeObj = parseConversationTime(timeStr);
    if (!timeObj) continue;

    // Build timestamp
    const timestamp = new Date(
      parseInt(dateKey.slice(0, 4), 10),
      parseInt(dateKey.slice(5, 7), 10) - 1,
      parseInt(dateKey.slice(8, 10), 10),
      timeObj.hours,
      timeObj.minutes,
      timeObj.seconds
    ).toISOString();

    // Detect channel from prefix
    const { channel, cleanContent } = detectChannel(userContent);

    // User entry
    entries.push({
      type: 'conversation',
      speaker: 'user',
      role: 'user',
      channel,
      content: cleanContent,
      timestamp,
      date_key: dateKey
    });

    // Assistant entry (1 second later for ordering)
    const assistantTimestamp = new Date(
      parseInt(dateKey.slice(0, 4), 10),
      parseInt(dateKey.slice(5, 7), 10) - 1,
      parseInt(dateKey.slice(8, 10), 10),
      timeObj.hours,
      timeObj.minutes,
      timeObj.seconds + 1
    ).toISOString();

    entries.push({
      type: 'conversation',
      speaker: agentName,
      role: 'assistant',
      channel,
      content: assistantContent,
      timestamp: assistantTimestamp,
      date_key: dateKey
    });
  }

  return entries;
}

/**
 * Parse time from conversation format "10:30:45 AM"
 */
function parseConversationTime(timeStr) {
  const match = timeStr.match(/(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)/i);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const seconds = parseInt(match[3], 10);
  const period = match[4].toUpperCase();

  if (period === 'PM' && hours !== 12) hours += 12;
  else if (period === 'AM' && hours === 12) hours = 0;

  return { hours, minutes, seconds };
}

/**
 * Detect channel from message prefix
 */
function detectChannel(content) {
  if (content.startsWith('[Chat]')) {
    return { channel: 'desktop', cleanContent: content.slice(6).trim() };
  }
  if (content.startsWith('[Phone Call]')) {
    return { channel: 'phone', cleanContent: content.slice(12).trim() };
  }
  const jobMatch = content.match(/^\[Timed Job:\s*[^\]]+\]/i);
  if (jobMatch) {
    return { channel: 'job', cleanContent: content.slice(jobMatch[0].length).trim() };
  }
  return { channel: 'desktop', cleanContent: content };
}

module.exports = createJournalRouter;

module.exports.meta = {
  name: 'journal',
  description: 'Journal entry recording and conversation migration',
  basePath: '/api/journal',
  endpoints: [
    { method: 'POST', path: '/', description: 'Record a journal entry',
      params: { content: 'string, required', type: 'string, optional' } },
    { method: 'POST', path: '/migrate', description: 'Migrate historical journal entries' },
    { method: 'POST', path: '/migrate-conversations', description: 'Migrate conversation entries to journal format' }
  ]
};
