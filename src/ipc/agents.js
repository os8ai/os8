/**
 * IPC handlers for multi-agent management
 * Uses AgentService (SQLite-backed) for all agent operations
 */

const { ipcMain } = require('electron');
const { getDefaultAgentId, setDefaultAgentId, removeAgentState } = require('../services/agent-state');

function registerAgentsHandlers({ db, services }) {
  const { AgentService, AppService, scaffoldAssistantApp, generateAssistantClaudeMd } = services;

  ipcMain.handle('agents:list', (event, options) => {
    const filter = options?.filter;
    const agents = filter === 'visible' ? AgentService.getVisible(db) : AgentService.getAll(db);
    const defaultAgent = AgentService.getDefault(db);
    const defaultId = defaultAgent?.id || getDefaultAgentId();

    return agents.map(agent => {
      const config = AgentService.getConfig(db, agent.id) || {};
      return {
        id: agent.id,
        name: config.assistantName || agent.name,
        slug: agent.slug,
        backend: agent.backend || config.agentBackend || 'claude',
        model: agent.model || config.agentModel || null,
        color: agent.color,
        visibility: agent.visibility || 'visible',
        isDefault: agent.id === defaultId
      };
    });
  });

  ipcMain.handle('agents:get', (event, id) => {
    const agent = AgentService.getById(db, id);
    if (!agent) return null;

    const config = AgentService.getConfig(db, agent.id) || {};
    const defaultAgent = AgentService.getDefault(db);
    return {
      id: agent.id,
      name: config.assistantName || agent.name,
      slug: agent.slug,
      backend: agent.backend || config.agentBackend || 'claude',
      model: agent.model || config.agentModel || null,
      color: agent.color,
      isDefault: agent.id === defaultAgent?.id,
      config
    };
  });

  ipcMain.handle('agents:create', (event, name, ownerName, options) => {
    // Find parent app
    const appId = AgentService.getParentAppId(db);
    if (!appId) return { error: 'No agent system app found' };

    const agent = AgentService.create(db, {
      appId,
      name,
      ownerName: ownerName || '',
      backend: options?.backend || 'claude',
      model: options?.model || null,
      color: options?.color || '#8b5cf6'
    });

    // IPC-created agents are fully scaffolded here — mark setup complete immediately
    AgentService.update(db, agent.id, { setup_complete: 1 });

    // Scaffold agent filesystem (dirs, blob subdirs, identity folders, instruction files)
    AgentService.scaffold(db, agent, {
      name,
      ownerName: ownerName || '',
      scaffoldFn: scaffoldAssistantApp,
      generateInstructionsFn: generateAssistantClaudeMd
    });

    return agent;
  });

  ipcMain.handle('agents:update', (event, id, updates) => {
    const agent = AgentService.getById(db, id);
    if (!agent) return { error: 'Agent not found' };

    const configUpdates = {};
    if (updates.name !== undefined) configUpdates.assistantName = updates.name;
    if (updates.backend !== undefined) configUpdates.agentBackend = updates.backend;
    if (updates.model !== undefined) configUpdates.agentModel = updates.model;

    // Pass through other config keys
    for (const [key, value] of Object.entries(updates)) {
      if (!['name', 'backend', 'model', 'color'].includes(key) && value !== undefined) {
        configUpdates[key] = value;
      }
    }

    if (updates.color !== undefined) {
      AgentService.update(db, id, { color: updates.color });
    }

    if (Object.keys(configUpdates).length > 0) {
      AgentService.updateConfig(db, id, configUpdates);
    }

    // Regenerate instruction files (matches PATCH /api/agents/:id behavior)
    const updatedAgent = AgentService.getById(db, id);
    const config = AgentService.getConfig(db, id);
    const appLike = { id: updatedAgent.id, name: updatedAgent.name, slug: updatedAgent.slug };
    generateAssistantClaudeMd(db, appLike, config);

    return updatedAgent;
  });

  ipcMain.handle('agents:delete', (event, id) => {
    const allAgents = AgentService.getAll(db);
    if (allAgents.length <= 1) {
      return { error: 'Cannot delete the last agent' };
    }

    const agent = AgentService.getById(db, id);
    if (!agent) return { error: 'Agent not found' };

    if (id === (AgentService.getDefault(db)?.id || getDefaultAgentId())) {
      const newDefault = allAgents.find(a => a.id !== id);
      if (newDefault) {
        AgentService.setDefault(db, newDefault.id);
        setDefaultAgentId(newDefault.id);
      }
    }

    removeAgentState(id);

    // Hard delete: remove all DB data + filesystem
    AgentService.deleteWithCleanup(db, id, agent.app_id);

    return { success: true };
  });

  ipcMain.handle('agents:set-default', (event, id) => {
    AgentService.setDefault(db, id);
    setDefaultAgentId(id);
    return { success: true, defaultAgentId: id };
  });

  ipcMain.handle('agents:get-default', () => {
    const defaultAgent = AgentService.getDefault(db);
    return defaultAgent?.id || getDefaultAgentId();
  });
}

module.exports = registerAgentsHandlers;
