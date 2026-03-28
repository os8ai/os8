/**
 * SimService helpers — identity building, myself/schedule loading,
 * time formatting, gap computation, and DB context fetchers.
 */

const fs = require('fs');
const path = require('path');
const { loadJSON } = require('../utils/file-helpers');

/**
 * Build identity object from agent DB record.
 * @param {object} agent - Agent row from DB
 * @returns {object|null}
 */
function buildIdentity(agent) {
  if (!agent) return null;

  const pronounsMap = { she: 'she/her', he: 'he/him', they: 'they/them' };
  const pronouns = pronounsMap[agent.pronouns] || 'they/them';

  const immutableParts = [];
  if (agent.hair_color) immutableParts.push(`${agent.hair_color} hair`);
  if (agent.skin_tone) immutableParts.push(`${agent.skin_tone} skin`);
  if (agent.height) immutableParts.push(`${agent.height} height`);
  if (agent.build) immutableParts.push(`${agent.build} build`);
  if (agent.other_features) immutableParts.push(agent.other_features);
  if (agent.appearance) immutableParts.push(agent.appearance);

  const immutablePromptFragment = immutableParts.length > 0
    ? immutableParts.join(', ')
    : null;

  const filenameStem = (agent.slug || agent.name || 'agent').replace(/^agent-/, '');

  return {
    pronouns,
    immutablePromptFragment,
    filenameStem,
    physicalDescription: {
      hairColor: agent.hair_color || null,
      skinTone: agent.skin_tone || null,
      height: agent.height || null,
      build: agent.build || null,
    }
  };
}

/**
 * Load MYSELF.md brief for an agent (first ~1500 chars)
 * @param {string} agentBlobDir - Agent's blob directory
 * @returns {string}
 */
function loadMyselfBrief(agentBlobDir) {
  const myselfPath = path.join(agentBlobDir, 'MYSELF.md');
  if (!fs.existsSync(myselfPath)) return '';
  try {
    const full = fs.readFileSync(myselfPath, 'utf-8');
    return full.substring(0, 1500);
  } catch (e) {
    console.warn('SimService: Failed to read MYSELF.md:', e.message);
    return '';
  }
}

/**
 * Load weekly schedule JSON
 * @param {string} agentBlobDir
 * @param {string} appDir
 * @returns {object|null}
 */
function loadWeeklySchedule(agentBlobDir, appDir) {
  const agentSchedule = path.join(agentBlobDir, 'schedule', 'weekly-schedule.json');
  if (fs.existsSync(agentSchedule)) {
    return loadJSON(agentSchedule, null);
  }
  const appSchedule = path.join(appDir, 'skills', 'snapshot', 'weekly-schedule.json');
  return loadJSON(appSchedule, null);
}

/**
 * Get current schedule slot from weekly schedule
 * @param {object} schedule
 * @param {Date} [now]
 * @returns {object|null}
 */
function getCurrentScheduleSlot(schedule, now) {
  if (!schedule) return null;
  const d = now || new Date();
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const day = days[d.getDay()];
  const hour = String(d.getHours()).padStart(2, '0');
  const daySchedule = schedule[day];
  if (!daySchedule) return null;
  const slot = daySchedule[hour];
  return slot ? { day, hour, slot } : null;
}

/**
 * Get the last journal entry from the conversation DB
 * @param {object} db
 * @param {string} agentId
 * @returns {object|null}
 */
function getLastJournalEntry(db, agentId) {
  const row = db.prepare(`
    SELECT content, timestamp, metadata
    FROM conversation_entries
    WHERE app_id = ? AND type = 'journal'
    ORDER BY timestamp DESC
    LIMIT 1
  `).get(agentId);
  if (!row) return null;
  return {
    content: row.content,
    timestamp: row.timestamp,
    metadata: row.metadata ? JSON.parse(row.metadata) : null
  };
}

/**
 * Get recent reverie entries
 * @param {object} db
 * @param {string} agentId
 * @param {number} [limit=10]
 * @returns {Array}
 */
function getRecentReveries(db, agentId, limit = 10) {
  return db.prepare(`
    SELECT content, timestamp
    FROM conversation_entries
    WHERE app_id = ? AND internal_tag = 'reverie'
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(agentId, limit);
}

/**
 * Get recent conversations
 * @param {object} db
 * @param {string} agentId
 * @param {number} [hoursBack=4]
 * @returns {Array}
 */
function getRecentConversations(db, agentId, hoursBack = 4) {
  const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
  return db.prepare(`
    SELECT speaker, role, channel, content, timestamp
    FROM conversation_entries
    WHERE app_id = ? AND type = 'conversation' AND timestamp >= ?
    ORDER BY timestamp ASC
  `).all(agentId, cutoff);
}

/**
 * Format timestamp for filenames: YYYY-MM-DD-HHMM
 * @param {Date} [now]
 * @returns {string}
 */
function formatTimestamp(now) {
  const d = now || new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}-${hh}${min}`;
}

/**
 * Format current time as "HH:MM AM/PM"
 * @param {Date} [now]
 * @returns {string}
 */
function formatTimeDisplay(now) {
  const d = now || new Date();
  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const period = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `${hours}:${minutes} ${period}`;
}

/**
 * Compute gap info between now and last journal entry
 * @param {object|null} lastEntry
 * @param {Date} [now]
 * @returns {object}
 */
function computeGapInfo(lastEntry, now) {
  const d = now || new Date();
  if (!lastEntry) {
    return { gapMinutes: null, gapDescription: 'No previous journal entry found', lastEntryTime: null };
  }
  const lastTime = new Date(lastEntry.timestamp);
  const gapMs = d.getTime() - lastTime.getTime();
  const gapMinutes = Math.round(gapMs / 60000);

  let gapDescription;
  if (gapMinutes < 60) {
    gapDescription = `${gapMinutes} minutes since last entry`;
  } else {
    const hours = Math.floor(gapMinutes / 60);
    const mins = gapMinutes % 60;
    gapDescription = mins > 0
      ? `${hours} hour${hours > 1 ? 's' : ''} and ${mins} minutes since last entry`
      : `${hours} hour${hours > 1 ? 's' : ''} since last entry`;
  }

  return {
    gapMinutes,
    gapDescription,
    lastEntryTime: formatTimeDisplay(lastTime)
  };
}

module.exports = {
  buildIdentity,
  loadMyselfBrief,
  loadWeeklySchedule,
  getCurrentScheduleSlot,
  getLastJournalEntry,
  getRecentReveries,
  getRecentConversations,
  formatTimestamp,
  formatTimeDisplay,
  computeGapInfo
};
