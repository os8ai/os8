/**
 * Daily notes, file I/O, and reflection methods for MemoryService.
 * Extracted from memory.js — applied as a prototype mixin.
 */

const fs = require('fs');
const path = require('path');

/**
 * Apply daily-notes and reflection methods to MemoryService prototype.
 * @param {Function} MemoryService - The MemoryService class
 */
function applyNotesMixin(MemoryService) {

  // Ensure memory directory exists
  MemoryService.prototype.ensureMemoryDir = function() {
    if (!fs.existsSync(this.memoryDir)) {
      fs.mkdirSync(this.memoryDir, { recursive: true });
    }
  };

  // Get today's date string (local timezone)
  MemoryService.prototype.getTodayString = function() {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  // Get date string for any Date object (local timezone)
  MemoryService.prototype.getDateString = function(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  // Get path to daily note
  MemoryService.prototype.getDailyNotePath = function(date = null) {
    const dateStr = date || this.getTodayString();
    return path.join(this.memoryDir, `${dateStr}.md`);
  };

  // Read or create today's daily note
  MemoryService.prototype.getTodayNote = function() {
    this.ensureMemoryDir();
    const notePath = this.getDailyNotePath();

    if (fs.existsSync(notePath)) {
      return fs.readFileSync(notePath, 'utf-8');
    }

    // Create new daily note
    const template = `# ${this.getTodayString()}

## Conversations

## Notes

## Tasks Completed

## Important Events

`;
    fs.writeFileSync(notePath, template);
    return template;
  };

  // Clean up daily note by removing duplicate section headers
  // Keeps content but consolidates to single set of sections
  MemoryService.prototype.cleanupDailyNote = function() {
    const notePath = this.getDailyNotePath();
    if (!fs.existsSync(notePath)) return;

    let note = fs.readFileSync(notePath, 'utf-8');
    const sections = ['Conversations', 'Notes', 'Tasks Completed', 'Important Events'];

    for (const section of sections) {
      const header = `## ${section}`;
      const regex = new RegExp(`\\n${header}\\n`, 'g');
      const matches = note.match(regex);

      // If more than one occurrence, keep only the first
      if (matches && matches.length > 1) {
        let firstFound = false;
        note = note.replace(regex, (match) => {
          if (!firstFound) {
            firstFound = true;
            return match; // Keep the first
          }
          return '\n'; // Remove duplicates (replace with newline to preserve spacing)
        });
      }
    }

    fs.writeFileSync(notePath, note);
    return note;
  };

  // Append to today's note
  MemoryService.prototype.appendToTodayNote = function(section, content) {
    this.ensureMemoryDir();
    const notePath = this.getDailyNotePath();
    let note = this.getTodayNote();

    // Find the LAST occurrence of the section header to handle corrupted files
    // with duplicate sections
    const sectionHeader = `## ${section}`;
    let sectionIndex = -1;
    let searchStart = 0;

    // Find all occurrences and use the last one
    while (true) {
      const idx = note.indexOf(sectionHeader, searchStart);
      if (idx === -1) break;
      sectionIndex = idx;
      searchStart = idx + sectionHeader.length;
    }

    if (sectionIndex !== -1) {
      // For Conversations section, always insert before the LAST ## Notes
      // This ensures chronological order even with duplicate sections
      let insertIndex;

      if (section === 'Conversations') {
        // Find the last ## Notes to insert before it
        const lastNotesIndex = note.lastIndexOf('\n## Notes');
        if (lastNotesIndex !== -1 && lastNotesIndex > sectionIndex) {
          insertIndex = lastNotesIndex;
        } else {
          // Fallback: find next section after our section
          const nextSectionMatch = note.substring(sectionIndex + sectionHeader.length).match(/\n## /);
          insertIndex = nextSectionMatch
            ? sectionIndex + sectionHeader.length + nextSectionMatch.index
            : note.length;
        }
      } else {
        // For other sections, find the next section after the last occurrence
        const nextSectionMatch = note.substring(sectionIndex + sectionHeader.length).match(/\n## /);
        insertIndex = nextSectionMatch
          ? sectionIndex + sectionHeader.length + nextSectionMatch.index
          : note.length;
      }

      // Insert content at the determined position
      const timestamp = new Date().toLocaleTimeString();
      const entry = `\n[${timestamp}] ${content}\n`;
      note = note.slice(0, insertIndex) + entry + note.slice(insertIndex);
    }

    fs.writeFileSync(notePath, note);
    return note;
  };

  // Get recent daily notes (for context)
  MemoryService.prototype.getRecentNotes = function(days = 7) {
    this.ensureMemoryDir();
    const notes = [];
    const today = new Date();

    for (let i = 0; i < days; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = this.getDateString(date);
      const notePath = path.join(this.memoryDir, `${dateStr}.md`);

      if (fs.existsSync(notePath)) {
        notes.push({
          date: dateStr,
          content: fs.readFileSync(notePath, 'utf-8')
        });
      }
    }

    return notes;
  };

  // Extract conversation section from a daily note
  MemoryService.prototype.extractConversations = function(noteContent) {
    const conversationsMatch = noteContent.match(/## Conversations\n([\s\S]*?)(?=\n## |$)/);
    if (!conversationsMatch) return '';
    return conversationsMatch[1].trim();
  };

  // Legacy method: Parse conversation history from MD files
  // Kept for backward compatibility during migration period
  MemoryService.prototype._getLast24HoursConversationFromMd = function() {
    this.ensureMemoryDir();
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);

    const todayStr = this.getDateString(now);
    const yesterdayStr = this.getDateString(yesterday);

    let transcript = '';

    // Get yesterday's conversations (entries after current time yesterday)
    const yesterdayPath = path.join(this.memoryDir, `${yesterdayStr}.md`);
    if (fs.existsSync(yesterdayPath)) {
      const yesterdayContent = fs.readFileSync(yesterdayPath, 'utf-8');
      const yesterdayConvos = this.extractConversations(yesterdayContent);
      if (yesterdayConvos) {
        // Filter to only entries from after 24 hours ago
        const entries = yesterdayConvos.split(/(?=\n\[)/);
        const cutoffTime = now.toLocaleTimeString('en-US', { hour12: true, hour: 'numeric', minute: '2-digit', second: '2-digit' });

        for (const entry of entries) {
          // Extract timestamp from entry like "[12:34:56 PM]"
          const timeMatch = entry.match(/\[(\d{1,2}:\d{2}:\d{2}\s*[AP]M)\]/i);
          if (timeMatch) {
            // Include entries from yesterday that are AFTER the current time
            // (i.e., within the last 24 hours)
            const entryTime = timeMatch[1];
            // Simple comparison: if yesterday's entry time > current time, it's within 24h
            if (entryTime.toUpperCase() > cutoffTime.toUpperCase()) {
              transcript += `[${yesterdayStr} ${entryTime}]${entry.replace(/\[\d{1,2}:\d{2}:\d{2}\s*[AP]M\]/i, '').trim()}\n\n`;
            }
          }
        }
      }
    }

    // Get all of today's conversations
    const todayPath = path.join(this.memoryDir, `${todayStr}.md`);
    if (fs.existsSync(todayPath)) {
      const todayContent = fs.readFileSync(todayPath, 'utf-8');
      const todayConvos = this.extractConversations(todayContent);
      if (todayConvos) {
        const entries = todayConvos.split(/(?=\n\[)/);
        for (const entry of entries) {
          const trimmed = entry.trim();
          if (trimmed) {
            // Add date prefix to timestamp
            const withDate = trimmed.replace(/^\[(\d{1,2}:\d{2}:\d{2}\s*[AP]M)\]/i, `[${todayStr} $1]`);
            transcript += withDate + '\n\n';
          }
        }
      }
    }

    return transcript.trim();
  };

  // Build reflection prompt from recent conversations
  MemoryService.prototype.buildReflectionPrompt = function() {
    const todayNote = this.getTodayNote();

    // Read USER.md and MEMORY.md safely
    let userMd = '';
    let memoryMd = '';

    const userPath = path.join(this.appPath, 'USER.md');
    const memoryPath = path.join(this.appPath, 'MEMORY.md');

    if (fs.existsSync(userPath)) {
      userMd = fs.readFileSync(userPath, 'utf-8');
    }
    if (fs.existsSync(memoryPath)) {
      memoryMd = fs.readFileSync(memoryPath, 'utf-8');
    }

    return `[REFLECTION TASK]

Review today's conversations and extract important information.

## Today's Conversations
${todayNote}

## Current USER.md
${userMd}

## Current MEMORY.md
${memoryMd}

## Instructions

Analyze the conversations above and identify:
1. **New facts about the owner** (preferences, projects, family updates, schedule info)
2. **Important decisions or patterns** worth remembering long-term
3. **Action items or follow-ups** mentioned

Respond in this exact format:

[USER_FACTS]
- fact 1
- fact 2
[/USER_FACTS]

[MEMORY_ITEMS]
- important decision or pattern 1
- important decision or pattern 2
[/MEMORY_ITEMS]

[DAILY_NOTE]
Brief summary of what was discussed/accomplished today
[/DAILY_NOTE]

If nothing significant to extract, respond with just: REFLECTION_OK`;
  };

  // Parse reflection response and update memory files
  MemoryService.prototype.applyReflectionResults = async function(response) {
    const updates = { user: [], memory: [], daily: null };

    // Extract USER_FACTS
    const userMatch = response.match(/\[USER_FACTS\]([\s\S]*?)\[\/USER_FACTS\]/);
    if (userMatch) {
      updates.user = userMatch[1].trim().split('\n').filter(line => line.trim().startsWith('-'));
    }

    // Extract MEMORY_ITEMS
    const memoryMatch = response.match(/\[MEMORY_ITEMS\]([\s\S]*?)\[\/MEMORY_ITEMS\]/);
    if (memoryMatch) {
      updates.memory = memoryMatch[1].trim().split('\n').filter(line => line.trim().startsWith('-'));
    }

    // Extract DAILY_NOTE
    const dailyMatch = response.match(/\[DAILY_NOTE\]([\s\S]*?)\[\/DAILY_NOTE\]/);
    if (dailyMatch) {
      updates.daily = dailyMatch[1].trim();
    }

    // Apply updates
    if (updates.user.length > 0) {
      this.appendToFile('USER.md', '\n' + updates.user.join('\n'));
    }
    if (updates.memory.length > 0) {
      const today = this.getTodayString();
      this.appendToFile('MEMORY.md', `\n### ${today}\n${updates.memory.join('\n')}`);
    }
    if (updates.daily) {
      this.appendToTodayNote('Notes', updates.daily);
    }

    // Re-index after updates
    await this.indexAllMemory();

    return updates;
  };

  // Helper to append to any memory file
  MemoryService.prototype.appendToFile = function(filename, content) {
    const filePath = path.join(this.appPath, filename);

    // Create file if it doesn't exist
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, '');
    }

    fs.appendFileSync(filePath, content);
  };
}

module.exports = applyNotesMixin;
