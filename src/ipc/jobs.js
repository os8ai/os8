/**
 * IPC Handlers for Jobs domain
 * Handles: jobsFile:* (JSON-based timed job management)
 */

const { ipcMain } = require('electron');

function registerJobsHandlers({ db, services, helpers }) {
  const { JobsFileService, JobSchedulerService } = services;
  const { startJobsWatcher, stopJobsWatcher } = helpers;

  // Helper to trigger scheduler rearm after CRUD operations
  const triggerSchedulerRearm = () => {
    if (JobSchedulerService && JobSchedulerService.isStarted) {
      JobSchedulerService.tickDebounced();
    }
  };

  // Jobs CRUD (with scheduler rearm) — agentId is optional for backward compat
  ipcMain.handle('jobsFile:getJobs', (event, appId, agentId) => JobsFileService.getJobs(appId, agentId));
  ipcMain.handle('jobsFile:getJob', (event, appId, agentId, jobId) => JobsFileService.getJob(appId, agentId, jobId));

  ipcMain.handle('jobsFile:createJob', (event, appId, agentId, jobData) => {
    const result = JobsFileService.createJob(appId, agentId, jobData);
    triggerSchedulerRearm();
    return result;
  });

  ipcMain.handle('jobsFile:updateJob', (event, appId, agentId, jobId, updates) => {
    const result = JobsFileService.updateJob(appId, agentId, jobId, updates);
    triggerSchedulerRearm();
    return result;
  });

  ipcMain.handle('jobsFile:deleteJob', (event, appId, agentId, jobId) => {
    const result = JobsFileService.deleteJob(appId, agentId, jobId);
    triggerSchedulerRearm();
    return result;
  });

  ipcMain.handle('jobsFile:toggleJob', (event, appId, agentId, jobId) => {
    const result = JobsFileService.toggleJob(appId, agentId, jobId);
    triggerSchedulerRearm();
    return result;
  });

  // Run log
  ipcMain.handle('jobsFile:getRuns', (event, appId, agentId, jobId, limit) => JobsFileService.getRuns(appId, agentId, jobId, limit));
  ipcMain.handle('jobsFile:addRun', (event, appId, agentId, jobId, runData) => JobsFileService.addRun(appId, agentId, jobId, runData));

  // Scheduling helpers
  ipcMain.handle('jobsFile:getUpcomingJobs', (event, appId, agentId) => JobsFileService.getUpcomingJobs(appId, agentId));
  ipcMain.handle('jobsFile:getDueJobs', (event, appId, agentId) => JobsFileService.getDueJobs(appId, agentId));
  ipcMain.handle('jobsFile:getStats', (event, appId, agentId) => JobsFileService.getStats(appId, agentId));

  // File watcher
  ipcMain.handle('jobsFile:watch', (event, appId, agentId) => startJobsWatcher(appId, agentId));
  ipcMain.handle('jobsFile:unwatch', () => stopJobsWatcher());

  // Get available capabilities for an agent context — APIs + DB skills + agent-local
  ipcMain.handle('jobsFile:getSkills', (event, appId, agentId) => {
    const { CapabilityService } = require('../services/capability');
    return CapabilityService.getSkillsForAgent(db, appId, agentId);
  });
}

module.exports = registerJobsHandlers;
