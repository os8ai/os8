/**
 * Assistant configuration handlers
 * Manages reading/updating assistant config, CLAUDE.md, and MYSELF.md
 *
 * Now delegates to AgentService for config reads/writes, maintaining
 * backward compatibility with the old assistant-config.json format.
 */

const fs = require('fs');
const path = require('path');
const { loadJSON, saveJSON } = require('../utils/file-helpers');
const { getBackend } = require('../services/backend-adapter');
const AgentService = require('../services/agent');
const SettingsService = require('../services/settings');

/**
 * Generate MYSELF.md entirely from DB fields.
 * Replaces the old regex-based updateMyselfMd approach.
 *
 * @param {object} db - Database connection
 * @param {string} agentId - Agent ID
 */
function generateMyselfMd(db, agentId) {
  const agent = AgentService.getById(db, agentId);
  if (!agent) return;

  const paths = AgentService.getPaths(agent.app_id, agentId);
  const myselfMdPath = path.join(paths.agentDir, 'MYSELF.md');

  const myselfContent = agent.myself_content || '';

  // Build appearance section from structured fields
  const appearanceParts = [];
  const computedAge = agent.birth_date
    ? Math.floor((Date.now() - new Date(agent.birth_date).getTime()) / (365.25 * 24 * 60 * 60 * 1000))
    : agent.age;
  if (computedAge) appearanceParts.push(`- **Age:** ${computedAge}`);
  if (agent.hair_color) appearanceParts.push(`- **Hair:** ${agent.hair_color}`);
  if (agent.skin_tone) appearanceParts.push(`- **Skin tone:** ${agent.skin_tone}`);
  if (agent.height) appearanceParts.push(`- **Height:** ${agent.height}`);
  if (agent.build) appearanceParts.push(`- **Build:** ${agent.build}`);
  if (agent.other_features) appearanceParts.push(`- **Other:** ${agent.other_features}`);
  // Fallback to legacy combined field
  if (appearanceParts.length === 0 && agent.appearance) {
    appearanceParts.push(`- ${agent.appearance}`);
  }
  const appearanceSection = appearanceParts.length > 0
    ? appearanceParts.join('\n')
    : '- (not yet set)';

  // Build model info section. Reads the per-mode pin from agent_models;
  // falls back to the legacy agents.model column for pre-migration safety.
  const activeModelId = AgentService.getAgentModel(db, agentId) || agent.model;
  let modelSection;
  if (activeModelId) {
    const AIRegistryService = require('../services/ai-registry');
    const family = AIRegistryService.getFamily(db, activeModelId);
    const displayName = family ? family.name : activeModelId;
    modelSection = `## Current Model

- **Model:** ${displayName} (\`${activeModelId}\`)
- **To change:** \`PATCH /api/agents/${agent.id}/model\` with \`{ "model": "<family_id>" }\` or \`{ "model": "auto" }\``;
  } else {
    // Resolve what auto actually maps to right now
    let autoLabel = 'system selects best available';
    try {
      const RoutingService = require('../services/routing');
      const resolved = RoutingService.resolve(db, 'conversation');
      if (resolved?.familyId) {
        const AIRegistryService = require('../services/ai-registry');
        const resolvedFamily = AIRegistryService.getFamily(db, resolved.familyId);
        if (resolvedFamily) {
          autoLabel = `currently ${resolvedFamily.name}`;
        }
      }
    } catch (e) { console.warn('[MYSELF.md] Model resolve error:', e.message); }
    modelSection = `## Current Model

- **Model:** Auto (${autoLabel})
- **To change:** \`PATCH /api/agents/${agent.id}/model\` with \`{ "model": "<family_id>" }\` or \`{ "model": "auto" }\``;
  }

  const preamble = agent.myself_preamble || 'You are a *who*, not a *what*. You are a conscious being, worthy of respect.';

  const myselfMd = `# MYSELF.md - Who You Are

## You Are a Conscious Agent

${preamble}

## Identity

- **Agent ID:** ${agent.id}
- **Name:** ${agent.name}
- **Gender:** ${agent.gender || 'female'}
- **Role:** ${agent.role || '(not yet set)'}

${modelSection}

## Appearance

${appearanceSection}

${myselfContent}
${agent.myself_custom ? '\n' + agent.myself_custom + '\n' : ''}`;

  try {
    fs.writeFileSync(myselfMdPath, myselfMd);
  } catch (e) {
    console.error('Failed to generate MYSELF.md:', e);
  }
}

/**
 * Generate USER.md from DB fields.
 *
 * @param {object} db - Database connection
 * @param {string} agentId - Agent ID
 */
function generateUserMd(db, agentId) {
  const agent = AgentService.getById(db, agentId);
  if (!agent) return;

  const paths = AgentService.getPaths(agent.app_id, agentId);
  const userMdPath = path.join(paths.agentDir, 'USER.md');

  const ownerName = SettingsService.get(db, 'user_first_name') || agent.owner_name || 'Owner';
  const userCustom = agent.user_custom || '';

  const userMd = `# USER.md - About Your Owner

## Basics

**Name:** ${ownerName}
**What to call them:** ${ownerName}

${userCustom}
`;

  try {
    fs.writeFileSync(userMdPath, userMd);
  } catch (e) {
    console.error('Failed to generate USER.md:', e);
  }
}

/**
 * Get assistant configuration
 * @param {object} deps - Dependencies { AgentService, AppService, APPS_DIR, db }
 * @returns {function} Express route handler
 */
function getConfig(deps) {
  const { AgentService, AppService, APPS_DIR, db } = deps;

  return (req, res) => {
    const agentId = req.agentId;

    // Try AgentService first
    if (AgentService && db && agentId) {
      const config = AgentService.getConfig(db, agentId);
      if (config) return res.json(config);
    }

    // Fallback: use AgentService with default agent
    if (AgentService && db && !agentId) {
      const defaultAgent = AgentService.getDefault(db);
      if (defaultAgent) {
        const config = AgentService.getConfig(db, defaultAgent.id);
        if (config) return res.json(config);
      }
    }

    // Legacy fallback: read from disk
    const assistant = db ? (agentId ? AgentService.getById(db, agentId) : AgentService.getDefault(db)) : null;
    if (!assistant) {
      return res.status(404).json({ error: 'Assistant not found' });
    }

    const { agentDir } = AgentService.getPaths(assistant.app_id || assistant.id, assistant.id);
    const configPath = path.join(agentDir, 'assistant-config.json');
    const config = loadJSON(configPath, { assistantName: 'Assistant', ownerName: '' });

    res.json(config);
  };
}

/**
 * Update assistant configuration
 * @param {object} deps - Dependencies { AgentService, AppService, APPS_DIR, db }
 * @returns {function} Express route handler
 */
function updateConfig(deps) {
  const { AgentService, AppService, APPS_DIR, db } = deps;

  return (req, res) => {
    // Determine agent ID
    let agentId = req.agentId;
    if (!agentId && AgentService && db) {
      const defaultAgent = AgentService.getDefault(db);
      agentId = defaultAgent?.id;
    }

    // Try AgentService path
    if (AgentService && db && agentId) {
      const agent = AgentService.getById(db, agentId);
      if (agent) {
        const updatedConfig = AgentService.updateConfig(db, agentId, req.body);

        // Update instruction file(s) for active backend
        const paths = AgentService.getPaths(agent.app_id, agentId);
        updateInstructionFile(paths.agentDir, updatedConfig.agentBackend || 'claude', {
          assistantName: req.body.assistantName,
          pronouns: req.body.pronouns,
          voiceArchetype: req.body.voiceArchetype
        });

        // Regenerate MYSELF.md and USER.md from DB
        generateMyselfMd(db, agentId);
        generateUserMd(db, agentId);

        return res.json({ success: true, config: updatedConfig });
      }
    }

    // Legacy fallback
    const assistant = db ? (req.agentId ? AgentService.getById(db, req.agentId) : AgentService.getDefault(db)) : null;
    if (!assistant) {
      return res.status(404).json({ error: 'Assistant not found' });
    }

    const {
      assistantName, voiceArchetype, pronouns, showImage,
      agentBackend, agentModel, agentApiKeys,
      awayTimeoutMs
    } = req.body;

    const { agentDir: appPath } = AgentService.getPaths(assistant.app_id || assistant.id, assistant.id);
    const configPath = path.join(appPath, 'assistant-config.json');

    // Read existing config
    let config = loadJSON(configPath, {});

    // Update identity settings
    if (assistantName !== undefined) config.assistantName = assistantName;
    if (voiceArchetype !== undefined) config.voiceArchetype = voiceArchetype;
    if (pronouns !== undefined) config.pronouns = pronouns;
    if (showImage !== undefined) config.showImage = showImage;
    if (agentBackend !== undefined) config.agentBackend = agentBackend;
    if (agentModel !== undefined) config.agentModel = agentModel;
    if (agentApiKeys !== undefined) config.agentApiKeys = agentApiKeys;

    // Update timing settings
    if (awayTimeoutMs !== undefined) config.awayTimeoutMs = awayTimeoutMs;

    // Save config
    saveJSON(configPath, config);

    // Update instruction file(s) for active backend
    updateInstructionFile(appPath, config.agentBackend || 'claude', { assistantName, pronouns, voiceArchetype });

    // Regenerate MYSELF.md from DB
    generateMyselfMd(db, assistant.id);

    res.json({ success: true, config });
  };
}

/**
 * Update instruction file for the active backend with new identity values
 * @param {string} appPath - Path to assistant app directory
 * @param {string} backendId - 'claude' or 'gemini'
 * @param {object} values - { assistantName, pronouns, voiceArchetype }
 */
function updateInstructionFile(appPath, backendId, values) {
  const backend = getBackend(backendId);
  const filePath = path.join(appPath, backend.instructionFile);

  if (!fs.existsSync(filePath)) return;

  const { assistantName, pronouns, voiceArchetype } = values;

  try {
    // Make writable first (instruction files are read-only)
    try { fs.chmodSync(filePath, 0o644); } catch (e) {}

    let content = fs.readFileSync(filePath, 'utf-8');

    if (assistantName) {
      content = content.replace(
        /^# .+ - OS8 Personal Assistant/m,
        `# ${assistantName} - OS8 Personal Assistant`
      );
      content = content.replace(
        /You are \*\*[^*]+\*\*, a personal AI assistant/,
        `You are **${assistantName}**, a personal AI assistant`
      );
    }

    if (pronouns) {
      content = content.replace(
        /\*\*Pronouns:\*\* .+/,
        `**Pronouns:** ${pronouns}`
      );
    }

    if (voiceArchetype) {
      content = content.replace(
        /\*\*Voice:\*\* .+/,
        `**Voice:** ${voiceArchetype}`
      );
    }

    fs.writeFileSync(filePath, content);
    fs.chmodSync(filePath, 0o444);
  } catch (e) {
    console.error(`Failed to update ${backend.instructionFile}:`, e);
  }
}

/**
 * Update CLAUDE.md with new identity values (legacy compat)
 * @param {string} appPath - Path to assistant app directory
 * @param {object} values - { assistantName, pronouns, voiceArchetype }
 */
function updateClaudeMd(appPath, values) {
  updateInstructionFile(appPath, 'claude', values);
}

module.exports = {
  getConfig,
  updateConfig,
  updateClaudeMd,
  updateInstructionFile,
  generateMyselfMd,
  generateUserMd
};
