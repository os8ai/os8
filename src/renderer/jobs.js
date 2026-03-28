/**
 * Jobs Renderer Module
 * Handles timed jobs UI in the tasks panel
 */

import {
  getCurrentApp,
  getAgentScope,
  getEffectiveAgentId,
  getPanelMode,
  setPanelMode,
  getJobsView,
  setJobsView,
  getJobsFilterView,
  setJobsFilterView,
  getSelectedJobId,
  setSelectedJobId
} from './state.js';
import { elements } from './elements.js';
import { hideAllPreviews, updatePreviewBounds } from './preview.js';
import { scopedJobsFile } from './helpers.js';

// ============================================
// CORE FUNCTIONS
// ============================================

/**
 * Load and render jobs for the current app
 */
export async function loadJobs() {
  const app = getCurrentApp();
  if (!app) return;

  // System Level has no jobs — show empty state
  if (getAgentScope() === 'system') {
    renderJobsList([]);
    return;
  }

  try {
    const scoped = scopedJobsFile();
    const jobs = await scoped.getJobs();
    const view = getJobsView();

    if (view === 'list') {
      renderJobsList(jobs);
    } else if (view === 'detail' || view === 'runs') {
      const selectedId = getSelectedJobId();
      const job = jobs.find(j => j.id === selectedId);
      if (job) {
        if (view === 'detail') {
          renderJobDetail(job);
        } else {
          const runs = await scoped.getRuns(job.id, 50);
          renderRunsLog(job, runs);
        }
      } else {
        // Job was deleted, go back to list
        setJobsView('list');
        setSelectedJobId(null);
        renderJobsList(jobs);
      }
    }
  } catch (err) {
    console.error('Error loading jobs:', err);
    renderJobsList([]);
  }
}

/**
 * Render the jobs list view
 */
export function renderJobsList(jobs) {
  const container = elements.jobsList;
  if (!container) return;

  const filterView = getJobsFilterView();

  // Filter by archive status
  const filteredJobs = jobs.filter(job => {
    if (filterView === 'archive') {
      return job.archived === true;
    } else {
      return job.archived !== true;
    }
  });

  if (filteredJobs.length === 0) {
    const emptyMsg = filterView === 'archive' ? 'No archived jobs' : 'No timed jobs yet';
    const hintMsg = filterView === 'archive' ? '' : '<p class="jobs-empty-hint">Click "+ Job" to create one</p>';
    container.innerHTML = `
      <div class="jobs-empty">
        <p>${emptyMsg}</p>
        ${hintMsg}
      </div>
    `;
    return;
  }

  // Sort by nextRun (soonest first), jobs without nextRun at end
  const sorted = [...filteredJobs].sort((a, b) => {
    if (!a.nextRun) return 1;
    if (!b.nextRun) return -1;
    return new Date(a.nextRun) - new Date(b.nextRun);
  });

  container.innerHTML = sorted.map(job => `
    <div class="job-item${job.enabled === false ? ' disabled' : ''}" data-job-id="${job.id}">
      <div class="job-status-icon">${getJobStatusIcon(job)}</div>
      <div class="job-info">
        <div class="job-name">${escapeHtml(job.name)}</div>
        <div class="job-schedule">${formatScheduleSummary(job)}</div>
      </div>
      <label class="job-toggle toggle-switch-sm" title="${job.enabled === false ? 'Enable' : 'Disable'}">
        <input type="checkbox" class="job-toggle-input" data-job-id="${job.id}" ${job.enabled !== false ? 'checked' : ''}>
        <span class="toggle-slider-sm"></span>
      </label>
    </div>
  `).join('');

  // Attach click handlers
  container.querySelectorAll('.job-item').forEach(el => {
    el.addEventListener('click', (e) => {
      // Don't navigate if clicking the toggle
      if (e.target.closest('.job-toggle')) return;
      handleJobClick(el.dataset.jobId);
    });
  });

  // Attach toggle handlers
  container.querySelectorAll('.job-toggle-input').forEach(input => {
    input.addEventListener('change', (e) => {
      e.stopPropagation();
      handleToggleJob(input.dataset.jobId);
    });
  });
}

/**
 * Render job detail view
 */
export function renderJobDetail(job) {
  const container = elements.jobsList;
  if (!container) return;

  const isArchived = job.archived === true;
  const scopeLabels = { system: 'System', app: 'App', agent: 'Agent' };
  const skillScopeLabel = scopeLabels[job.skillScope] || 'Agent';
  container.innerHTML = `
    <div class="job-detail">
      <div class="job-detail-header">
        <button class="job-back-btn icon-btn xs" title="Back to list">←</button>
        <span class="job-detail-name">${escapeHtml(job.name)}</span>
        <div class="job-detail-actions">
          <label class="toggle-switch-sm" title="${job.enabled === false ? 'Enable' : 'Disable'}">
            <input type="checkbox" class="job-detail-toggle" ${job.enabled !== false ? 'checked' : ''}>
            <span class="toggle-slider-sm"></span>
          </label>
          <button class="job-archive-btn icon-btn xs" title="${isArchived ? 'Unarchive' : 'Archive'}">${isArchived ? '📤' : '📥'}</button>
          <button class="job-edit-btn icon-btn xs" title="Edit">✎</button>
          <button class="job-delete-btn icon-btn xs" title="Delete">🗑</button>
        </div>
      </div>
      <div class="job-detail-body">
        ${job.skill ? `
          <div class="job-detail-section">
            <label>Linked Skill</label>
            <p>${skillScopeLabel}</p>
            <p><code>${escapeHtml(job.skillPath || `skills/${job.skill}/SKILL.md`)}</code></p>
          </div>
        ` : ''}
        ${job.description ? `
          <div class="job-detail-section">
            <label>Description</label>
            <p>${escapeHtml(job.description)}</p>
          </div>
        ` : ''}
        <div class="job-detail-section">
          <label>Schedule</label>
          <p>${formatScheduleDetail(job)}</p>
        </div>
        <div class="job-detail-section">
          <label>If missed</label>
          <p>${job.onMissed === 'run' ? 'Run when app opens' : 'Skip and wait for next'}</p>
        </div>
        ${Array.isArray(job.completionChecks) && job.completionChecks.length > 0 ? `
          <div class="job-detail-section">
            <label>Success checks</label>
            <p>${escapeHtml(job.completionChecks.join(' | '))}</p>
          </div>
        ` : ''}
        <div class="job-detail-section">
          <label>Last run</label>
          <p>${formatLastRun(job)}</p>
        </div>
        ${job.type === 'recurring' ? `
          <div class="job-detail-section">
            <label>Next run</label>
            <p>${formatNextRun(job)}</p>
          </div>
        ` : ''}
      </div>
      <div class="job-runs-section">
        <div class="job-runs-header">
          <h4>Recent Runs</h4>
          <button class="job-view-all-runs-btn">View All</button>
        </div>
        <div class="job-runs-preview" id="jobRunsPreview">
          <p class="loading">Loading...</p>
        </div>
      </div>
    </div>
  `;

  // Attach handlers
  container.querySelector('.job-back-btn').addEventListener('click', handleBackToList);
  container.querySelector('.job-detail-toggle').addEventListener('change', () => handleToggleJob(job.id));
  container.querySelector('.job-archive-btn').addEventListener('click', () => handleArchiveJob(job.id, !isArchived));
  container.querySelector('.job-edit-btn').addEventListener('click', () => showEditJobModal(job.id));
  container.querySelector('.job-delete-btn').addEventListener('click', () => handleDeleteJob(job.id));
  container.querySelector('.job-view-all-runs-btn').addEventListener('click', () => {
    setJobsView('runs');
    loadJobs();
  });

  // Load recent runs preview
  loadRunsPreview(job.id);
}

/**
 * Load and render runs preview (last 5)
 */
async function loadRunsPreview(jobId) {
  const app = getCurrentApp();
  const container = document.getElementById('jobRunsPreview');
  if (!container || !app) return;

  try {
    const runs = await scopedJobsFile().getRuns(jobId, 5);
    if (runs.length === 0) {
      container.innerHTML = '<p class="jobs-empty-hint">No runs yet</p>';
    } else {
      container.innerHTML = runs.map(run => `
        <div class="job-run-item ${run.notes ? 'has-notes' : ''}">
          <div class="job-run-header">
            <span class="run-status ${run.status}">${getRunStatusIcon(run.status)}</span>
            <span class="run-time">${formatRunTime(run)}</span>
          </div>
          ${run.notes ? `<div class="run-notes">${escapeHtml(truncateNotes(run.notes, 100))}</div>` : ''}
        </div>
      `).join('');
    }
  } catch (err) {
    container.innerHTML = '<p class="error">Failed to load runs</p>';
  }
}

/**
 * Render full runs log view
 */
export function renderRunsLog(job, runs) {
  const container = elements.jobsList;
  if (!container) return;

  container.innerHTML = `
    <div class="job-runs-view">
      <div class="job-detail-header">
        <button class="job-back-btn icon-btn xs" title="Back to details">←</button>
        <span class="job-detail-name">${escapeHtml(job.name)} - Run History</span>
      </div>
      <div class="job-runs-list">
        ${runs.length === 0 ? '<p class="jobs-empty-hint">No runs yet</p>' : runs.map(run => `
          <div class="job-run-item ${run.notes ? 'has-notes' : ''}">
            <div class="job-run-header">
              <span class="run-status ${run.status}">${getRunStatusIcon(run.status)}</span>
              <span class="run-time">${formatRunTime(run)}</span>
              <span class="run-status-label">${formatStatusLabel(run.status)}</span>
            </div>
            ${run.notes ? `<div class="run-notes">${escapeHtml(run.notes)}</div>` : ''}
          </div>
        `).join('')}
      </div>
    </div>
  `;

  container.querySelector('.job-back-btn').addEventListener('click', () => {
    setJobsView('detail');
    loadJobs();
  });
}

/**
 * Format status as a human-readable label
 */
function formatStatusLabel(status) {
  switch (status) {
    case 'completed': return 'Completed';
    case 'skipped': return 'Skipped';
    case 'failed': return 'Failed';
    case 'could_not_complete': return 'Could not complete';
    default: return status;
  }
}

// ============================================
// MODAL FUNCTIONS
// ============================================

/**
 * Load and populate skills dropdown
 */
async function loadSkillsDropdown(selectedSkill = '', selectedSkillScope = 'agent') {
  const app = getCurrentApp();
  const skillSelect = document.getElementById('jobSkill');
  if (!skillSelect || !app) return;

  try {
    const scope = getAgentScope();
    const agentId = (scope && scope !== 'system') ? scope : null;
    const skills = await window.os8.jobsFile.getSkills(app.id, agentId);

    // Reset dropdown
    skillSelect.innerHTML = '<option value="">None (use description only)</option>';

    const addSkillGroup = (label, groupSkills) => {
      if (groupSkills.length === 0) return;
      const optgroup = document.createElement('optgroup');
      optgroup.label = label;

      for (const skill of groupSkills) {
        const option = document.createElement('option');
        option.value = skill.id;
        option.textContent = skill.name;
        option.dataset.path = skill.path;
        option.dataset.scope = skill.scope;
        option.dataset.type = skill.type || 'skill';
        if (skill.skill_id) option.dataset.skillId = skill.skill_id;
        if (skill.id === selectedSkill && skill.scope === (selectedSkillScope || 'agent')) {
          option.selected = true;
        }
        optgroup.appendChild(option);
      }
      skillSelect.appendChild(optgroup);
    };

    addSkillGroup('APIs', skills.filter(skill => skill.scope === 'api'));
    addSkillGroup('System Skills', skills.filter(skill => skill.scope === 'system'));
    addSkillGroup('Installed Skills', skills.filter(skill => skill.scope === 'installed'));
    addSkillGroup('App Skills', skills.filter(skill => skill.scope === 'app'));
    addSkillGroup('Agent Skills', skills.filter(skill => skill.scope === 'agent'));

    // Backward compatibility for jobs missing skillScope
    if (selectedSkill && !skillSelect.value) {
      const fallback = Array.from(skillSelect.options).find(option => option.value === selectedSkill);
      if (fallback) fallback.selected = true;
    }

    // Show/hide hint based on selection
    updateSkillHint();
  } catch (err) {
    console.error('Error loading skills:', err);
    skillSelect.innerHTML = '<option value="">None (use description only)</option>';
  }
}

/**
 * Update skill hint visibility
 */
function updateSkillHint() {
  const skillSelect = document.getElementById('jobSkill');
  const skillHint = document.getElementById('jobSkillHint');
  if (skillSelect && skillHint) {
    skillHint.style.display = skillSelect.value ? 'block' : 'none';
  }
}

/**
 * Show create job modal
 */
export async function showCreateJobModal() {
  const modal = document.getElementById('jobModal');
  if (!modal) return;

  // Hide preview so modal appears on top
  hideAllPreviews();

  // Reset form
  document.getElementById('jobName').value = '';
  document.getElementById('jobDescription').value = '';
  document.getElementById('jobCompletionChecks').value = '';
  document.querySelector('input[name="jobType"][value="recurring"]').checked = true;
  document.getElementById('jobFrequency').value = 'daily';
  document.getElementById('jobOnMissed').value = 'run';

  // Set default date/time to tomorrow at 9am
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  document.getElementById('jobDate').value = tomorrow.toISOString().split('T')[0];
  document.getElementById('jobTime').value = '09:00';

  // Load skills dropdown
  await loadSkillsDropdown('', 'agent');

  // Show recurring schedule by default
  updateScheduleVisibility('recurring');
  updateFrequencyOptions('daily');

  // Update modal title and button
  modal.querySelector('.modal-header h3').textContent = 'New Timed Job';
  document.getElementById('jobModalSave').textContent = 'Create Job';
  document.getElementById('jobModalSave').dataset.mode = 'create';
  delete document.getElementById('jobModalSave').dataset.jobId;

  modal.classList.add('active');
}

/**
 * Show edit job modal
 */
export async function showEditJobModal(jobId) {
  const app = getCurrentApp();
  const modal = document.getElementById('jobModal');
  if (!modal || !app) return;

  // Hide preview so modal appears on top
  hideAllPreviews();

  const job = await scopedJobsFile().getJob(jobId);
  if (!job) return;

  // Populate form
  document.getElementById('jobName').value = job.name;
  document.getElementById('jobDescription').value = job.description || '';
  document.getElementById('jobCompletionChecks').value = (job.completionChecks || []).join('\n');
  document.querySelector(`input[name="jobType"][value="${job.type}"]`).checked = true;
  document.getElementById('jobOnMissed').value = job.onMissed || 'run';

  // Load skills dropdown with current selection
  await loadSkillsDropdown(job.skill || '', job.skillScope || 'agent');

  if (job.type === 'one-time') {
    const dt = new Date(job.schedule.datetime);
    document.getElementById('jobDate').value = dt.toISOString().split('T')[0];
    document.getElementById('jobTime').value = dt.toTimeString().slice(0, 5);
  } else {
    document.getElementById('jobFrequency').value = job.schedule.frequency;
    updateFrequencyOptions(job.schedule.frequency, job.schedule);
  }

  updateScheduleVisibility(job.type);

  // Update modal title and button
  modal.querySelector('.modal-header h3').textContent = 'Edit Timed Job';
  document.getElementById('jobModalSave').textContent = 'Save Changes';
  document.getElementById('jobModalSave').dataset.mode = 'edit';
  document.getElementById('jobModalSave').dataset.jobId = jobId;

  modal.classList.add('active');
}

/**
 * Hide job modal
 */
export function hideJobModal() {
  const modal = document.getElementById('jobModal');
  if (modal) modal.classList.remove('active');
  // Restore preview
  updatePreviewBounds();
}

/**
 * Save job (create or update)
 */
export async function saveJob() {
  const app = getCurrentApp();
  if (!app) return;

  const saveBtn = document.getElementById('jobModalSave');
  const mode = saveBtn.dataset.mode;
  const jobId = saveBtn.dataset.jobId;

  const name = document.getElementById('jobName').value.trim();
  if (!name) {
    alert('Please enter a job name');
    return;
  }

  const description = document.getElementById('jobDescription').value.trim();
  const completionChecks = (document.getElementById('jobCompletionChecks').value || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 20);
  const type = document.querySelector('input[name="jobType"]:checked').value;
  const onMissed = document.getElementById('jobOnMissed').value;

  // Get skill selection
  const skillSelect = document.getElementById('jobSkill');
  const skill = skillSelect?.value || null;
  const selectedOption = skillSelect?.selectedOptions?.[0];
  const skillScope = skill ? (selectedOption?.dataset.scope || 'agent') : null;
  const skillPath = skill ? (selectedOption?.dataset.path || `skills/${skill}/SKILL.md`) : null;
  const skill_id = skill ? (selectedOption?.dataset.skillId || null) : null;

  let schedule;
  if (type === 'one-time') {
    const date = document.getElementById('jobDate').value;
    const time = document.getElementById('jobTime').value;
    if (!date || !time) {
      alert('Please select a date and time');
      return;
    }
    schedule = { datetime: `${date}T${time}:00` };
  } else {
    const frequency = document.getElementById('jobFrequency').value;
    schedule = { frequency };

    const timeInput = document.getElementById('freqTime');
    if (timeInput) schedule.time = timeInput.value;

    if (frequency === 'every-x-minutes' || frequency === 'every-x-hours') {
      const intervalInput = document.getElementById('freqInterval');
      const startDateInput = document.getElementById('freqStartDate');
      const startTimeInput = document.getElementById('freqStartTime');
      if (intervalInput) schedule.interval = parseInt(intervalInput.value) || (frequency === 'every-x-hours' ? 2 : 15);
      if (startDateInput) schedule.startDate = startDateInput.value;
      if (startTimeInput) schedule.startTime = startTimeInput.value;
    } else if (frequency === 'hourly') {
      const minuteInput = document.getElementById('freqMinute');
      if (minuteInput) schedule.minute = parseInt(minuteInput.value) || 0;
    } else if (frequency === 'weekly') {
      const dayInput = document.getElementById('freqDayOfWeek');
      if (dayInput) schedule.dayOfWeek = parseInt(dayInput.value);
    } else if (frequency === 'monthly') {
      const dayInput = document.getElementById('freqDayOfMonth');
      if (dayInput) schedule.dayOfMonth = parseInt(dayInput.value);
    } else if (frequency === 'annually') {
      const monthInput = document.getElementById('freqMonth');
      const dayInput = document.getElementById('freqDayOfMonth');
      if (monthInput) schedule.month = parseInt(monthInput.value);
      if (dayInput) schedule.dayOfMonth = parseInt(dayInput.value);
    }
  }

  try {
    const jobData = { name, description, type, schedule, onMissed, completionChecks, skill, skillScope, skillPath, skill_id };
    if (mode === 'create') {
      await scopedJobsFile().createJob(jobData);
    } else {
      await scopedJobsFile().updateJob(jobId, jobData);
    }
    hideJobModal();
    loadJobs();
  } catch (err) {
    console.error('Error saving job:', err);
    alert('Failed to save job');
  }
}

// ============================================
// EVENT HANDLERS
// ============================================

/**
 * Handle job click - show detail view
 */
export function handleJobClick(jobId) {
  setSelectedJobId(jobId);
  setJobsView('detail');
  loadJobs();
}

/**
 * Handle toggle job enabled/disabled
 */
export async function handleToggleJob(jobId) {
  const app = getCurrentApp();
  if (!app) return;

  try {
    await scopedJobsFile().toggleJob(jobId);
    loadJobs();
  } catch (err) {
    console.error('Error toggling job:', err);
  }
}

/**
 * Handle archive/unarchive job
 */
export async function handleArchiveJob(jobId, archive) {
  const app = getCurrentApp();
  if (!app) return;

  try {
    await scopedJobsFile().updateJob(jobId, { archived: archive });
    // Go back to list and switch to appropriate view
    setJobsView('list');
    setSelectedJobId(null);
    setJobsFilterView(archive ? 'archive' : 'active');
    // Update the dropdown
    if (elements.jobsFilterSelect) {
      elements.jobsFilterSelect.value = archive ? 'archive' : 'active';
    }
    loadJobs();
  } catch (err) {
    console.error('Error archiving job:', err);
  }
}

/**
 * Handle delete job
 */
export async function handleDeleteJob(jobId) {
  if (!confirm('Delete this job? This cannot be undone.')) return;

  const app = getCurrentApp();
  if (!app) return;

  try {
    await scopedJobsFile().deleteJob(jobId);
    setJobsView('list');
    setSelectedJobId(null);
    loadJobs();
  } catch (err) {
    console.error('Error deleting job:', err);
  }
}

/**
 * Handle back to list
 */
export function handleBackToList() {
  setJobsView('list');
  setSelectedJobId(null);
  loadJobs();
}

// ============================================
// UI HELPERS
// ============================================

/**
 * Update schedule section visibility based on job type
 */
export function updateScheduleVisibility(type) {
  const oneTime = document.getElementById('scheduleOneTime');
  const recurring = document.getElementById('scheduleRecurring');

  if (oneTime) oneTime.style.display = type === 'one-time' ? 'block' : 'none';
  if (recurring) recurring.style.display = type === 'recurring' ? 'block' : 'none';
}

/**
 * Update frequency-specific options
 */
export function updateFrequencyOptions(frequency, existingSchedule = {}) {
  const container = document.getElementById('frequencyOptions');
  if (!container) return;

  let html = '';

  switch (frequency) {
    case 'every-x-minutes': {
      const interval = existingSchedule.interval || 15;
      const startTime = existingSchedule.startTime || '09:00';
      const startDate = existingSchedule.startDate || new Date().toISOString().split('T')[0];
      html = `
        <label>Every</label>
        <select id="freqInterval">
          ${Array.from({ length: 59 }, (_, i) => {
            const val = i + 1;
            return `<option value="${val}" ${val === interval ? 'selected' : ''}>${val} minute${val > 1 ? 's' : ''}</option>`;
          }).join('')}
        </select>
        <label>Starting</label>
        <div class="schedule-inputs">
          <input type="date" id="freqStartDate" class="form-input" value="${startDate}">
          <input type="time" id="freqStartTime" class="form-input" value="${startTime}">
        </div>
      `;
      break;
    }

    case 'every-x-hours': {
      const interval = existingSchedule.interval || 2;
      const startTime = existingSchedule.startTime || '09:00';
      const startDate = existingSchedule.startDate || new Date().toISOString().split('T')[0];
      html = `
        <label>Every</label>
        <select id="freqInterval">
          ${Array.from({ length: 23 }, (_, i) => {
            const val = i + 1;
            return `<option value="${val}" ${val === interval ? 'selected' : ''}>${val} hour${val > 1 ? 's' : ''}</option>`;
          }).join('')}
        </select>
        <label>Starting</label>
        <div class="schedule-inputs">
          <input type="date" id="freqStartDate" class="form-input" value="${startDate}">
          <input type="time" id="freqStartTime" class="form-input" value="${startTime}">
        </div>
      `;
      break;
    }

    case 'hourly': {
      const minute = existingSchedule.minute || 0;
      html = `
        <label>At minute</label>
        <select id="freqMinute">
          ${Array.from({ length: 60 }, (_, i) => `<option value="${i}" ${i === minute ? 'selected' : ''}>${i.toString().padStart(2, '0')}</option>`).join('')}
        </select>
      `;
      break;
    }

    case 'daily':
      html = `
        <label>At time</label>
        <input type="time" id="freqTime" value="${existingSchedule.time || '09:00'}">
      `;
      break;

    case 'weekdays':
      html = `
        <label>At time</label>
        <input type="time" id="freqTime" value="${existingSchedule.time || '09:00'}">
      `;
      break;

    case 'weekly':
      const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const dayOfWeek = existingSchedule.dayOfWeek || 1;
      html = `
        <label>On</label>
        <select id="freqDayOfWeek">
          ${days.map((d, i) => `<option value="${i}" ${i === dayOfWeek ? 'selected' : ''}>${d}</option>`).join('')}
        </select>
        <label>At time</label>
        <input type="time" id="freqTime" value="${existingSchedule.time || '09:00'}">
      `;
      break;

    case 'monthly':
      const dayOfMonth = existingSchedule.dayOfMonth || 1;
      html = `
        <label>On day</label>
        <select id="freqDayOfMonth">
          ${Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}" ${(i + 1) === dayOfMonth ? 'selected' : ''}>${i + 1}</option>`).join('')}
        </select>
        <label>At time</label>
        <input type="time" id="freqTime" value="${existingSchedule.time || '09:00'}">
      `;
      break;

    case 'annually':
      const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      const month = existingSchedule.month || 1;
      const annualDay = existingSchedule.dayOfMonth || 1;
      html = `
        <label>On</label>
        <select id="freqMonth">
          ${months.map((m, i) => `<option value="${i + 1}" ${(i + 1) === month ? 'selected' : ''}>${m}</option>`).join('')}
        </select>
        <select id="freqDayOfMonth">
          ${Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}" ${(i + 1) === annualDay ? 'selected' : ''}>${i + 1}</option>`).join('')}
        </select>
        <label>At time</label>
        <input type="time" id="freqTime" value="${existingSchedule.time || '09:00'}">
      `;
      break;
  }

  container.innerHTML = html;
}

// ============================================
// FORMATTING HELPERS
// ============================================

function getJobStatusIcon(job) {
  if (job.type === 'one-time') {
    return job.lastRun ? '✓' : '◉';
  }
  return '⟳';  // Recurring job
}

function getRunStatusIcon(status) {
  switch (status) {
    case 'completed': return '✓';
    case 'skipped': return '–';
    case 'failed': return '✗';
    case 'could_not_complete': return '⚠';
    default: return '?';
  }
}

function formatScheduleSummary(job) {
  if (job.type === 'one-time') {
    const dt = new Date(job.schedule.datetime);
    return formatDateTime(dt);
  }

  const { frequency } = job.schedule;
  let base = '';

  switch (frequency) {
    case 'every-x-minutes':
      base = `Every ${job.schedule.interval || 15} min`;
      break;
    case 'every-x-hours':
      base = `Every ${job.schedule.interval || 2}h`;
      break;
    case 'hourly':
      base = `Hourly at :${(job.schedule.minute || 0).toString().padStart(2, '0')}`;
      break;
    case 'daily':
      base = `Daily at ${formatTime(job.schedule.time)}`;
      break;
    case 'weekdays':
      base = `Weekdays at ${formatTime(job.schedule.time)}`;
      break;
    case 'weekly':
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      base = `${days[job.schedule.dayOfWeek || 0]} at ${formatTime(job.schedule.time)}`;
      break;
    case 'monthly':
      base = `${ordinal(job.schedule.dayOfMonth || 1)} of month at ${formatTime(job.schedule.time)}`;
      break;
    case 'annually':
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      base = `${months[(job.schedule.month || 1) - 1]} ${job.schedule.dayOfMonth || 1} at ${formatTime(job.schedule.time)}`;
      break;
  }

  // Add next run info
  if (job.enabled && job.nextRun) {
    base += ` · Next: ${formatRelativeDate(new Date(job.nextRun))}`;
  }

  return base;
}

function formatScheduleDetail(job) {
  if (job.type === 'one-time') {
    const dt = new Date(job.schedule.datetime);
    return `One-time: ${formatDateTime(dt)}`;
  }

  const { frequency } = job.schedule;

  switch (frequency) {
    case 'every-x-minutes': {
      const interval = job.schedule.interval || 15;
      const startDate = job.schedule.startDate;
      const startTime = job.schedule.startTime || '09:00';
      let detail = `Every ${interval} minute${interval > 1 ? 's' : ''}`;
      if (startDate) {
        detail += ` starting ${formatDate(startDate)} at ${formatTime(startTime)}`;
      }
      return detail;
    }
    case 'every-x-hours': {
      const interval = job.schedule.interval || 2;
      const startDate = job.schedule.startDate;
      const startTime = job.schedule.startTime || '09:00';
      let detail = `Every ${interval} hour${interval > 1 ? 's' : ''}`;
      if (startDate) {
        detail += ` starting ${formatDate(startDate)} at ${formatTime(startTime)}`;
      }
      return detail;
    }
    case 'hourly':
      return `Every hour at minute ${job.schedule.minute || 0}`;
    case 'daily':
      return `Every day at ${formatTime(job.schedule.time)}`;
    case 'weekdays':
      return `Every weekday (Mon-Fri) at ${formatTime(job.schedule.time)}`;
    case 'weekly':
      const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      return `Every ${days[job.schedule.dayOfWeek || 0]} at ${formatTime(job.schedule.time)}`;
    case 'monthly':
      return `${ordinal(job.schedule.dayOfMonth || 1)} of every month at ${formatTime(job.schedule.time)}`;
    case 'annually':
      const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      return `Every year on ${months[(job.schedule.month || 1) - 1]} ${job.schedule.dayOfMonth || 1} at ${formatTime(job.schedule.time)}`;
  }

  return 'Unknown schedule';
}

function formatNextRun(job) {
  if (!job.nextRun) return 'None scheduled';
  return formatRelativeDate(new Date(job.nextRun));
}

function formatLastRun(job) {
  if (!job.lastRun) return 'Never';
  return formatRelativeDate(new Date(job.lastRun));
}

function formatRunTime(run) {
  const dt = new Date(run.ranAt || run.scheduledFor);
  return formatDateTime(dt);
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const dt = new Date(dateStr + 'T12:00:00'); // Noon to avoid timezone issues
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatTime(timeStr) {
  if (!timeStr) return '12:00 AM';
  const [h, m] = timeStr.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${m.toString().padStart(2, '0')} ${ampm}`;
}

function formatDateTime(dt) {
  const now = new Date();
  const isToday = dt.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = dt.toDateString() === tomorrow.toDateString();

  const time = dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  if (isToday) return `Today at ${time}`;
  if (isTomorrow) return `Tomorrow at ${time}`;

  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ` at ${time}`;
}

function formatRelativeDate(dt) {
  const now = new Date();
  const diff = dt - now;
  const diffMins = Math.floor(diff / 60000);
  const diffHours = Math.floor(diff / 3600000);
  const diffDays = Math.floor(diff / 86400000);

  if (diff < 0) {
    // Past
    const ago = -diff;
    const agoMins = Math.floor(ago / 60000);
    const agoHours = Math.floor(ago / 3600000);
    const agoDays = Math.floor(ago / 86400000);

    if (agoMins < 1) return 'Just now';
    if (agoMins < 60) return `${agoMins}m ago`;
    if (agoHours < 24) return `${agoHours}h ago`;
    if (agoDays === 1) return 'Yesterday';
    return `${agoDays} days ago`;
  }

  // Future
  if (diffMins < 1) return 'Now';
  if (diffMins < 60) return `In ${diffMins}m`;
  if (diffHours < 24) return `In ${diffHours}h`;
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  return `In ${diffDays} days`;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

function truncateNotes(str, maxLen) {
  if (!str || str.length <= maxLen) return str;
  return str.substring(0, maxLen).trim() + '...';
}

// ============================================
// INITIALIZATION
// ============================================

/**
 * Initialize jobs module event listeners
 */
export function initJobs() {
  // Panel mode change handler is set up in tasks.js/main.js

  // Jobs filter dropdown change
  const filterSelect = elements.jobsFilterSelect;
  if (filterSelect) {
    filterSelect.addEventListener('change', async () => {
      setJobsFilterView(filterSelect.value);
      setJobsView('list');
      setSelectedJobId(null);
      loadJobs();

      // Persist setting for assistant app
      const app = getCurrentApp();
      if (app && app.app_type === 'system') {
        const storageSelect = document.getElementById('storageSelect');
        const uiSettings = {
          panelMode: getPanelMode(),
          storageView: storageSelect?.value || 'system',
          jobsFilterView: filterSelect.value
        };
        try {
          await window.os8.settings.setAppUi(app.id, uiSettings);
        } catch (err) {
          console.warn('Failed to save assistant UI settings:', err);
        }
      }
    });
  }

  // Job type radio change
  document.querySelectorAll('input[name="jobType"]').forEach(radio => {
    radio.addEventListener('change', () => updateScheduleVisibility(radio.value));
  });

  // Frequency change
  const freqSelect = document.getElementById('jobFrequency');
  if (freqSelect) {
    freqSelect.addEventListener('change', () => updateFrequencyOptions(freqSelect.value));
  }

  // Skill selection change
  const skillSelect = document.getElementById('jobSkill');
  if (skillSelect) {
    skillSelect.addEventListener('change', updateSkillHint);
  }

  // Modal save button
  const saveBtn = document.getElementById('jobModalSave');
  if (saveBtn) {
    saveBtn.addEventListener('click', saveJob);
  }

  // Modal cancel button
  const cancelBtn = document.getElementById('jobModalCancel');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', hideJobModal);
  }

  // Modal close button
  const closeBtn = document.querySelector('#jobModal .modal-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', hideJobModal);
  }

  // Close modal on backdrop click
  const modal = document.getElementById('jobModal');
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) hideJobModal();
    });
  }

  // Add job button
  const addJobBtn = document.getElementById('addJobBtn');
  if (addJobBtn) {
    addJobBtn.addEventListener('click', showCreateJobModal);
  }
}
