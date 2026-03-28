/**
 * SimService — Server-side heavy lifting for agent simulation
 *
 * Pushes all deterministic/mechanical work out of the LLM:
 * - Reverie: context pre-fetch + storage
 * - Journal: context pre-fetch + markdown write + DB storage
 * - Snapshot: journal + image generation pipeline (reference selection, prompt construction, generate.js)
 *
 * The LLM only provides creative content; the server does everything else.
 *
 * Implementation split across:
 * - sim-helpers.js    — identity, myself/schedule loading, time formatting, DB context
 * - sim-portrait.js   — portrait prompt building, reference images, image generation, DB storage
 * - sim-life-items.js — life items CRUD, seed defaults, life entry queries
 */

const fs = require('fs');
const path = require('path');
const AgentService = require('./agent');
const ConversationService = require('./conversation');

// Extracted modules
const {
  buildIdentity, loadMyselfBrief, loadWeeklySchedule, getCurrentScheduleSlot,
  getLastJournalEntry, getRecentReveries, getRecentConversations,
  formatTimestamp, formatTimeDisplay, computeGapInfo
} = require('./sim-helpers');

const {
  buildPortraitPrompt, buildGrokPortraitPrompt,
  generatePortrait, findSimpleRefs, storeImageInDb
} = require('./sim-portrait');

const {
  getLifeItems, createLifeItem, updateLifeItem, deleteLifeItem,
  seedDefaultLifeItems, getLatestLifeEntry
} = require('./sim-life-items');

const SimService = {
  // Re-export extracted functions with _ prefix for backward compatibility
  _buildIdentity: buildIdentity,
  _loadMyselfBrief: loadMyselfBrief,
  _loadWeeklySchedule: loadWeeklySchedule,
  _getCurrentScheduleSlot: getCurrentScheduleSlot,
  _getLastJournalEntry: getLastJournalEntry,
  _getRecentReveries: getRecentReveries,
  _getRecentConversations: getRecentConversations,
  _formatTimestamp: formatTimestamp,
  _formatTimeDisplay: formatTimeDisplay,
  _computeGapInfo: computeGapInfo,
  _buildPortraitPrompt: buildPortraitPrompt,
  _buildGrokPortraitPrompt: buildGrokPortraitPrompt,
  _generatePortrait: generatePortrait,
  _findSimpleRefs: findSimpleRefs,
  _storeImageInDb: storeImageInDb,

  // Re-export life items as direct methods (no underscore — these are public API)
  getLifeItems,
  createLifeItem,
  updateLifeItem,
  deleteLifeItem,
  seedDefaultLifeItems,
  getLatestLifeEntry,

  // ═══════════════════════════════════════════════
  // REVERIE
  // ═══════════════════════════════════════════════

  /**
   * Get reverie context for an agent
   * @param {object} db - Database
   * @param {string} agentId - Agent ID
   * @returns {object} Context for reverie generation
   */
  getReverieContext(db, agentId) {
    const agent = AgentService.getById(db, agentId);
    if (!agent) throw new Error('Agent not found');

    const { agentBlobDir, appDir } = AgentService.getPaths(agent.app_id, agentId);
    const schedule = loadWeeklySchedule(agentBlobDir, appDir);
    const scheduleSlot = getCurrentScheduleSlot(schedule);
    const recentConvos = getRecentConversations(db, agentId, 4);
    const lastJournal = getLastJournalEntry(db, agentId);
    const recentRevs = getRecentReveries(db, agentId, 6);

    return {
      currentTime: formatTimeDisplay(),
      scheduleSlot,
      recentConversations: recentConvos.map(c => ({
        speaker: c.speaker,
        channel: c.channel,
        content: c.content.substring(0, 500),
        timestamp: c.timestamp
      })),
      lastJournal: lastJournal ? {
        content: lastJournal.content.substring(0, 1000),
        timestamp: lastJournal.timestamp,
        metadata: lastJournal.metadata
      } : null,
      recentReveries: recentRevs.map(r => ({
        content: r.content,
        timestamp: r.timestamp
      }))
    };
  },

  /**
   * Store reverie reflections
   * @param {object} db - Database
   * @param {string} agentId - Agent ID
   * @param {string[]} reflections - Array of 3 reflection strings
   * @returns {object} { entries: Array<{ id, timestamp }> }
   */
  executeReverie(db, agentId, reflections) {
    const agent = AgentService.getById(db, agentId);
    if (!agent) throw new Error('Agent not found');

    if (!Array.isArray(reflections) || reflections.length === 0) {
      throw new Error('reflections must be a non-empty array of strings');
    }

    const agentName = agent.name.toLowerCase();
    const entries = [];

    for (const reflection of reflections) {
      const content = `[internal: (reverie) ${reflection}]`;
      const entry = ConversationService.addEntry(db, agentId, {
        type: 'conversation',
        speaker: agentName,
        role: 'assistant',
        channel: 'job',
        content
      });
      entries.push({ id: entry.id, timestamp: entry.timestamp });
    }

    return { entries };
  },

  // ═══════════════════════════════════════════════
  // JOURNAL
  // ═══════════════════════════════════════════════

  /**
   * Get journal context for an agent
   * @param {object} db - Database
   * @param {string} agentId - Agent ID
   * @returns {object} Context for journal generation
   */
  getJournalContext(db, agentId) {
    const agent = AgentService.getById(db, agentId);
    if (!agent) throw new Error('Agent not found');

    const { agentBlobDir, appDir } = AgentService.getPaths(agent.app_id, agentId);
    const schedule = loadWeeklySchedule(agentBlobDir, appDir);
    const scheduleSlot = getCurrentScheduleSlot(schedule);
    const lastJournal = getLastJournalEntry(db, agentId);
    const gapInfo = computeGapInfo(lastJournal);
    const recentConvos = getRecentConversations(db, agentId, 4);

    // Read calendar.md for today's events
    let calendarContent = null;
    const calendarPath = path.join(agentBlobDir, 'calendar', 'calendar.md');
    if (fs.existsSync(calendarPath)) {
      try {
        calendarContent = fs.readFileSync(calendarPath, 'utf-8');
      } catch (e) {
        console.warn('SimService: Failed to read calendar.md:', e.message);
      }
    }

    return {
      currentTime: formatTimeDisplay(),
      scheduleSlot,
      lastJournal: lastJournal ? {
        content: lastJournal.content,
        timestamp: lastJournal.timestamp,
        metadata: lastJournal.metadata
      } : null,
      gapInfo,
      recentConversations: recentConvos.map(c => ({
        speaker: c.speaker,
        channel: c.channel,
        content: c.content.substring(0, 500),
        timestamp: c.timestamp
      })),
      calendar: calendarContent
    };
  },

  /**
   * Execute a journal entry: format markdown, write to file, store in DB
   * @param {object} db - Database
   * @param {string} agentId - Agent ID
   * @param {object} journalData - { reconstructedHistory, currentState, narrative }
   * @returns {object} { entryId, filePath, timestamp }
   */
  executeJournal(db, agentId, journalData) {
    const agent = AgentService.getById(db, agentId);
    if (!agent) throw new Error('Agent not found');

    const { reconstructedHistory, currentState, narrative } = journalData;

    if (!currentState) throw new Error('currentState is required');
    if (!narrative) throw new Error('narrative is required');

    const now = new Date();

    // Format content for DB
    const dbLines = [];
    if (currentState.activity) dbLines.push(`**Activity:** ${typeof currentState.activity === 'string' ? currentState.activity : currentState.activity.primary}`);
    if (currentState.location) dbLines.push(`**Location:** ${typeof currentState.location === 'string' ? currentState.location : currentState.location.place}`);
    if (currentState.appearance) {
      const parts = [];
      for (const key of ['outfit', 'top', 'bottom', 'shoes', 'hair', 'makeup', 'accessories']) {
        if (currentState.appearance[key]) parts.push(currentState.appearance[key]);
      }
      if (parts.length > 0) dbLines.push(`**Appearance:** ${parts.join(', ')}`);
    }
    if (currentState.food_drink) dbLines.push(`**Food/Drink:** ${currentState.food_drink}`);
    if (currentState.mood) dbLines.push(`**Mood:** ${currentState.mood}`);
    if (currentState.weather_outside) dbLines.push(`**Weather:** ${currentState.weather_outside}`);
    dbLines.push('');
    dbLines.push(narrative);

    const dbContent = dbLines.join('\n');

    // Store in conversation DB
    const agentName = agent.name.toLowerCase();
    const entry = ConversationService.addEntry(db, agentId, {
      type: 'journal',
      speaker: agentName,
      role: 'assistant',
      channel: 'journal',
      content: dbContent,
      timestamp: now.toISOString(),
      metadata: {
        activity: currentState.activity || null,
        location: currentState.location || null,
        appearance: currentState.appearance || null,
        body_position: currentState.body_position || null,
        food_drink: currentState.food_drink || null,
        mood: currentState.mood || null,
        weather_outside: currentState.weather_outside || null
      }
    });

    return {
      entryId: entry.id,
      timestamp: entry.timestamp
    };
  },

  // ═══════════════════════════════════════════════
  // SNAPSHOT (Combined Journal + Image)
  // ═══════════════════════════════════════════════

  /**
   * Get snapshot context: journal context + identity info
   * @param {object} db - Database
   * @param {string} agentId - Agent ID
   * @param {number} [port=8888] - Server port
   * @returns {object} Full context for snapshot
   */
  getSnapshotContext(db, agentId, port = 8888) {
    const agent = AgentService.getById(db, agentId);
    if (!agent) throw new Error('Agent not found');

    // Journal context
    const journalContext = this.getJournalContext(db, agentId);

    // Identity check — built from DB, no longer needs a file
    const identity = buildIdentity(agent);

    return {
      ...journalContext,
      hasIdentity: !!identity
    };
  },

  /**
   * Execute full snapshot: journal write + portrait generation
   * Delegates to executeLife() for the actual image pipeline.
   * @param {object} db - Database
   * @param {string} agentId - Agent ID
   * @param {object} snapshotData - { journal }
   * @param {number} [port=8888] - Server port
   * @returns {Promise<object>} { journal, portrait }
   */
  async executeSnapshot(db, agentId, snapshotData, port = 8888) {
    const { journal: journalData } = snapshotData || {};

    // Delegate to executeLife with journal data mapped to its expected shape
    const lifeData = {};
    if (journalData) {
      lifeData.currentState = journalData.currentState;
      lifeData.narrative = journalData.narrative;
      lifeData.reconstructedHistory = journalData.reconstructedHistory;
    }

    return this.executeLife(db, agentId, lifeData, port);
  },

  // ═══════════════════════════════════════════════
  // AGENT LIFE — Combined routine
  // ═══════════════════════════════════════════════

  /**
   * Get combined life context for an agent (reverie + journal + snapshot context merged)
   * @param {object} db - Database
   * @param {string} agentId - Agent ID
   * @param {number} [port=8888] - Server port
   * @returns {object} Combined context for life routine
   */
  getLifeContext(db, agentId, port = 8888) {
    const agent = AgentService.getById(db, agentId);
    if (!agent) throw new Error('Agent not found');

    const { agentBlobDir, appDir } = AgentService.getPaths(agent.app_id, agentId);
    const schedule = loadWeeklySchedule(agentBlobDir, appDir);
    const scheduleSlot = getCurrentScheduleSlot(schedule);
    const lastJournal = getLastJournalEntry(db, agentId);
    const gapInfo = computeGapInfo(lastJournal);
    const recentConvos = getRecentConversations(db, agentId, 4);
    const recentRevs = getRecentReveries(db, agentId, 6);

    // Read calendar.md
    let calendarContent = null;
    const calendarPath = path.join(agentBlobDir, 'calendar', 'calendar.md');
    if (fs.existsSync(calendarPath)) {
      try { calendarContent = fs.readFileSync(calendarPath, 'utf-8'); } catch (e) {}
    }

    // Load life items from DB (outfits, settings, hairstyles)
    const lifeItems = { outfits: [], settings: [], hairstyles: [] };
    try {
      const rows = db.prepare(
        'SELECT * FROM agent_life_items WHERE agent_id = ? ORDER BY type, display_order'
      ).all(agentId);
      for (const row of rows) {
        const parsed = {
          id: row.id,
          name: row.name,
          description: row.description,
          panoramic: row.panoramic || null,
          scene_prompt: row.scene_prompt || null,
          tags: row.tags ? JSON.parse(row.tags) : [],
          isDefault: !!row.is_default
        };
        if (row.type === 'outfit') lifeItems.outfits.push(parsed);
        else if (row.type === 'setting') lifeItems.settings.push(parsed);
        else if (row.type === 'hairstyle') lifeItems.hairstyles.push(parsed);
      }
    } catch (e) {
      console.warn('SimService: Failed to load life items:', e.message);
    }

    // Load last life entry so the LLM sees what it picked last time
    let lastLifeEntry = null;
    try {
      lastLifeEntry = getLatestLifeEntry(db, agentId);
    } catch (e) {
      // Table may not exist yet on first run
    }

    // Build requiredFields — tells the agent exactly what must be populated
    const requiredFields = {};
    if (lifeItems.outfits.length > 0) {
      requiredFields.outfit_id = {
        required: true,
        available: lifeItems.outfits.map(o => ({ id: o.id, name: o.name })),
        instruction: 'Select one outfit_id from the available items. Do not leave null.'
      };
    }
    if (lifeItems.settings.length > 0) {
      requiredFields.setting_id = {
        required: true,
        available: lifeItems.settings.map(s => ({ id: s.id, name: s.name })),
        instruction: 'Select one setting_id from the available items. Do not leave null.'
      };
    }
    if (lifeItems.hairstyles.length > 0) {
      requiredFields.hairstyle_id = {
        required: true,
        available: lifeItems.hairstyles.map(h => ({ id: h.id, name: h.name })),
        instruction: 'Select one hairstyle_id from the available items. Do not leave null.'
      };
    }

    return {
      requiredFields,
      currentTime: formatTimeDisplay(),
      scheduleSlot,
      lastJournal: lastJournal ? {
        content: lastJournal.content,
        timestamp: lastJournal.timestamp,
        metadata: lastJournal.metadata
      } : null,
      gapInfo,
      recentConversations: recentConvos.map(c => ({
        speaker: c.speaker,
        channel: c.channel,
        content: c.content.substring(0, 500),
        timestamp: c.timestamp
      })),
      recentReveries: recentRevs.map(r => ({
        content: r.content,
        timestamp: r.timestamp
      })),
      calendar: calendarContent,
      lifeItems,
      lastLifeEntry: lastLifeEntry ? {
        outfit_id: lastLifeEntry.outfit_id,
        setting_id: lastLifeEntry.setting_id,
        hairstyle_id: lastLifeEntry.hairstyle_id,
        activity: lastLifeEntry.activity,
        mood: lastLifeEntry.mood,
        body_position: lastLifeEntry.body_position,
        food_drink: lastLifeEntry.food_drink,
        weather: lastLifeEntry.weather,
        makeup: lastLifeEntry.makeup,
        timestamp: lastLifeEntry.timestamp
      } : null,
      agent: {
        name: agent.name,
        pronouns: agent.pronouns || 'they',
        gender: agent.gender || 'female'
      }
    };
  },

  /**
   * Execute combined life routine: reverie + journal + portrait
   * @param {object} db - Database
   * @param {string} agentId - Agent ID
   * @param {object} lifeData - { reflections, currentState, narrative, reconstructedHistory }
   * @param {number} [port=8888] - Server port
   * @returns {Promise<object>} { reverie, journal, portrait }
   */
  async executeLife(db, agentId, lifeData, port = 8888) {
    const agent = AgentService.getById(db, agentId);
    if (!agent) throw new Error('Agent not found');

    const { agentBlobDir } = AgentService.getPaths(agent.app_id, agentId);
    const now = new Date();

    // Step 1: Store reverie reflections
    let reverieResult = null;
    if (Array.isArray(lifeData.reflections) && lifeData.reflections.length > 0) {
      reverieResult = this.executeReverie(db, agentId, lifeData.reflections);
    }

    // Step 2: Write journal entry
    let journalResult = null;
    if (lifeData.currentState && lifeData.narrative) {
      journalResult = this.executeJournal(db, agentId, {
        reconstructedHistory: lifeData.reconstructedHistory || null,
        currentState: lifeData.currentState,
        narrative: lifeData.narrative
      });
    }

    // Step 3: Look up life item data for portrait prompt enrichment
    let portraitResult = null;
    const currentState = lifeData.currentState;
    const lifeItemData = {};
    if (currentState) {
      try {
        if (currentState.outfit_id) {
          lifeItemData.outfit = db.prepare("SELECT * FROM agent_life_items WHERE id = ? AND agent_id = ?").get(currentState.outfit_id, agentId);
        }
        if (currentState.setting_id) {
          lifeItemData.setting = db.prepare("SELECT * FROM agent_life_items WHERE id = ? AND agent_id = ?").get(currentState.setting_id, agentId);
        }
        if (currentState.hairstyle_id) {
          lifeItemData.hairstyle = db.prepare("SELECT * FROM agent_life_items WHERE id = ? AND agent_id = ?").get(currentState.hairstyle_id, agentId);
        }
      } catch (e) {
        console.warn('SimService: Failed to look up life items:', e.message);
      }

      // Enrich currentState with scene_prompt — prefer setting_id, fall back to name match
      if (!currentState._scenePrompt) {
        if (lifeItemData.setting?.scene_prompt) {
          currentState._scenePrompt = lifeItemData.setting.scene_prompt;
        } else if (currentState.location) {
          try {
            const matchingSetting = db.prepare(
              "SELECT scene_prompt FROM agent_life_items WHERE agent_id = ? AND type = 'setting' AND name = ? AND scene_prompt IS NOT NULL"
            ).get(agentId, currentState.location);
            if (matchingSetting) {
              currentState._scenePrompt = matchingSetting.scene_prompt;
            }
          } catch (e) {
            // Non-fatal
          }
        }
      }

      // Generate portrait
      const identity = buildIdentity(agent);
      if (identity) {
        const refs = findSimpleRefs(agentBlobDir);
        const stem = identity.filenameStem || 'agent';
        const ts = formatTimestamp(now);
        const outputDir = path.join(agentBlobDir, 'current-image');
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

        const portraitPrompt = buildPortraitPrompt(identity, currentState, lifeItemData);
        const allRefs = [refs.headshot, refs.body].filter(Boolean);
        const portraitOutputBase = path.join(outputDir, `${ts}-${stem}`);

        // Provider selection: use requested provider first, fall back to the other
        const preferredProvider = lifeData.provider || 'gemini';
        const fallbackProvider = preferredProvider === 'grok' ? 'gemini' : 'grok';

        const tryProvider = async (provider) => {
          const isGrok = provider === 'grok';
          const prompt = isGrok ? buildGrokPortraitPrompt(identity, currentState, lifeItemData) : portraitPrompt;
          if (isGrok && allRefs.length > 1) {
            console.log(`SimService: Grok supports 1 reference image, using first of ${allRefs.length} (${path.basename(allRefs[0])})`);
          }
          return generatePortrait(db, {
            prompt,
            provider,
            refs: allRefs,
            output: `${portraitOutputBase}.png`,
          });
        };

        try {
          portraitResult = await tryProvider(preferredProvider);
        } catch (err) {
          console.warn(`SimService: ${preferredProvider} portrait failed (${err.message}), trying ${fallbackProvider}`);
          try {
            portraitResult = await tryProvider(fallbackProvider);
          } catch (fallbackErr) {
            console.error(`SimService: Portrait generation failed entirely: ${fallbackErr.message}`);
          }
        }

        // Store portrait in DB if generated
        if (portraitResult) {
          const portraitPath = portraitResult.savedTo || `${portraitOutputBase}.png`;
          const portraitFilename = path.basename(portraitPath);
          await storeImageInDb(db, agentId, portraitPath, portraitFilename, 'third_person', now);

          portraitResult = {
            path: portraitPath,
            filename: portraitFilename,
            fileTag: `[file: current-image/${portraitFilename}]`,
            provider: portraitResult.provider
          };
        }
      }
    }

    // Step 4: Validate life item IDs, then write agent_life_entries row
    if (currentState) {
      // Reject null IDs when matching items exist
      const missingFields = [];
      try {
        const countByType = db.prepare(
          "SELECT type, COUNT(*) as cnt FROM agent_life_items WHERE agent_id = ? GROUP BY type"
        ).all(agentId);
        const typeCounts = {};
        for (const row of countByType) typeCounts[row.type] = row.cnt;

        if (typeCounts['outfit'] > 0 && !currentState.outfit_id) {
          const available = db.prepare(
            "SELECT id, name FROM agent_life_items WHERE agent_id = ? AND type = 'outfit'"
          ).all(agentId);
          missingFields.push({ field: 'outfit_id', count: typeCounts['outfit'], available });
        }
        if (typeCounts['setting'] > 0 && !currentState.setting_id) {
          const available = db.prepare(
            "SELECT id, name FROM agent_life_items WHERE agent_id = ? AND type = 'setting'"
          ).all(agentId);
          missingFields.push({ field: 'setting_id', count: typeCounts['setting'], available });
        }
        if (typeCounts['hairstyle'] > 0 && !currentState.hairstyle_id) {
          const available = db.prepare(
            "SELECT id, name FROM agent_life_items WHERE agent_id = ? AND type = 'hairstyle'"
          ).all(agentId);
          missingFields.push({ field: 'hairstyle_id', count: typeCounts['hairstyle'], available });
        }
      } catch (e) {
        // Non-fatal — proceed without validation if query fails
        console.warn('SimService: Life item validation check failed:', e.message);
      }

      if (missingFields.length > 0) {
        const details = missingFields.map(f =>
          `${f.field} is null but ${f.count} ${f.field.replace('_id', '')} items exist. Available: ${f.available.map(a => `${a.name} (${a.id})`).join(', ')}`
        ).join('; ');
        throw new Error(`Life item IDs required in currentState: ${details}`);
      }

      try {
        const dateKey = now.toISOString().split('T')[0];
        // Serialize missionCheck if present and has non-null values
        const missionCheckJson = lifeData.missionCheck
          && Object.values(lifeData.missionCheck).some(v => v != null)
          ? JSON.stringify(lifeData.missionCheck)
          : null;
        db.prepare(`
          INSERT INTO agent_life_entries (
            agent_id, outfit_id, setting_id, hairstyle_id,
            activity, mood, body_position, food_drink, weather, makeup,
            narrative, reflections, reconstructed_history,
            mission_check,
            image_filename, image_provider,
            timestamp, date_key
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          agentId,
          currentState.outfit_id || null,
          currentState.setting_id || null,
          currentState.hairstyle_id || null,
          currentState.activity || null,
          currentState.mood || null,
          currentState.body_position || null,
          currentState.food_drink || null,
          currentState.weather_outside || null,
          currentState.makeup || null,
          lifeData.narrative || null,
          lifeData.reflections ? JSON.stringify(lifeData.reflections) : null,
          lifeData.reconstructedHistory || null,
          missionCheckJson,
          portraitResult?.filename || null,
          portraitResult?.provider || null,
          now.toISOString(),
          dateKey
        );
        console.log(`SimService: Wrote agent_life_entries row for ${agentId}`);
      } catch (e) {
        console.error('SimService: Failed to write agent_life_entries:', e.message);
      }
    }

    return {
      reverie: reverieResult,
      journal: journalResult,
      portrait: portraitResult
    };
  }
};

module.exports = SimService;
