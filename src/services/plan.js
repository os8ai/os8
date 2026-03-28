/**
 * PlanService — CRUD for plans and plan steps
 *
 * Plans are multi-step execution plans created by the planning skill.
 * Steps execute sequentially via the WorkQueue with dependency tracking.
 */

const { generateId } = require('../utils');

const TERMINAL_STATUSES = ['completed', 'failed', 'rejected', 'cancelled'];

const PlanService = {
  /**
   * Create a new plan from Phase 1 output.
   * @param {object} db
   * @param {{ agentId: string, request: string, summary: string, steps: Array<{ description: string, agent?: string, agentId?: string, completion_criteria?: string, depends_on?: string[] }> }} data
   * @returns {object} Plan with steps array
   */
  create(db, { agentId, request, summary, steps }) {
    const now = new Date().toISOString();
    const planId = `plan_${generateId()}`;

    db.prepare(`
      INSERT INTO plans (id, agent_id, request, summary, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'draft', ?, ?)
    `).run(planId, agentId, request, summary || '', now, now);

    const insertStep = db.prepare(`
      INSERT INTO plan_steps (id, plan_id, seq, description, agent_id, depends_on, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')
    `);

    // First pass: generate step IDs and collect metadata
    const stepMetas = steps.map((step, i) => ({
      id: `step_${generateId()}`,
      seq: i + 1,
      description: step.description,
      agentId: step.agentId || step.agent_id || (step.agent === 'self' ? agentId : step.agent) || agentId,
      rawDependsOn: step.depends_on || []
    }));

    // Build seq-number → step-ID map for translating Opus depends_on references
    const seqToId = {};
    for (const m of stepMetas) seqToId[m.seq] = m.id;

    // Second pass: insert with resolved dependency IDs
    const createdSteps = [];
    for (const m of stepMetas) {
      // Translate depends_on: Opus emits 1-indexed seq numbers, DB needs step IDs
      const resolvedDeps = m.rawDependsOn.map(dep => {
        if (typeof dep === 'number' && seqToId[dep]) return seqToId[dep];
        if (typeof dep === 'string' && dep.startsWith('step_')) return dep; // already an ID
        return seqToId[dep] || dep; // try numeric string
      });

      insertStep.run(m.id, planId, m.seq, m.description, m.agentId, JSON.stringify(resolvedDeps));
      createdSteps.push({
        id: m.id,
        plan_id: planId,
        seq: m.seq,
        description: m.description,
        agent_id: m.agentId,
        depends_on: resolvedDeps,
        status: 'pending',
        result: null,
        started_at: null,
        completed_at: null
      });
    }

    return {
      id: planId,
      agent_id: agentId,
      request,
      summary: summary || '',
      status: 'draft',
      created_at: now,
      updated_at: now,
      completed_at: null,
      steps: createdSteps
    };
  },

  /**
   * Get plan by ID with all steps ordered by seq.
   * @param {object} db
   * @param {string} planId
   * @returns {object|null} Plan with steps array, or null
   */
  getById(db, planId) {
    const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
    if (!plan) return null;

    const steps = db.prepare('SELECT * FROM plan_steps WHERE plan_id = ? ORDER BY seq').all(planId);
    plan.steps = steps.map(s => ({
      ...s,
      depends_on: JSON.parse(s.depends_on || '[]')
    }));
    return plan;
  },

  /**
   * Check if an agent has a plan currently in 'executing' status.
   * @param {object} db
   * @param {string} agentId
   * @returns {boolean}
   */
  hasExecutingPlan(db, agentId) {
    const row = db.prepare('SELECT 1 FROM plans WHERE agent_id = ? AND status = ? LIMIT 1').get(agentId, 'executing');
    return !!row;
  },

  /**
   * Get all plans with a given status.
   * @param {object} db
   * @param {string} status
   * @returns {Array} Plans without steps
   */
  getByStatus(db, status) {
    return db.prepare('SELECT * FROM plans WHERE status = ? ORDER BY created_at DESC').all(status);
  },

  /**
   * Get recent plans for an agent.
   * @param {object} db
   * @param {string} agentId
   * @param {number} [limit=20]
   * @returns {Array} Plans without steps
   */
  getByAgent(db, agentId, limit = 20) {
    return db.prepare('SELECT * FROM plans WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?').all(agentId, limit);
  },

  /**
   * Update plan status. Sets updated_at. Sets completed_at on terminal statuses.
   * @param {object} db
   * @param {string} planId
   * @param {string} status
   */
  updateStatus(db, planId, status) {
    const now = new Date().toISOString();
    const completedAt = TERMINAL_STATUSES.includes(status) ? now : null;

    if (completedAt) {
      db.prepare('UPDATE plans SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?')
        .run(status, now, completedAt, planId);
    } else {
      db.prepare('UPDATE plans SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, now, planId);
    }
  },

  /**
   * Update a single step's fields.
   * @param {object} db
   * @param {string} stepId
   * @param {object} fields - { status?, result?, started_at?, completed_at? }
   */
  updateStep(db, stepId, fields) {
    const sets = [];
    const values = [];

    for (const [key, value] of Object.entries(fields)) {
      if (['status', 'result', 'started_at', 'completed_at'].includes(key)) {
        sets.push(`${key} = ?`);
        values.push(value);
      }
    }

    if (sets.length === 0) return;

    values.push(stepId);
    db.prepare(`UPDATE plan_steps SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  },

  /**
   * Edit step description or agent assignment (pre-approval).
   * @param {object} db
   * @param {string} stepId
   * @param {{ description?: string, agentId?: string }} fields
   */
  editStep(db, stepId, { description, agentId }) {
    const sets = [];
    const values = [];

    if (description !== undefined) {
      sets.push('description = ?');
      values.push(description);
    }
    if (agentId !== undefined) {
      sets.push('agent_id = ?');
      values.push(agentId);
    }

    if (sets.length === 0) return;

    values.push(stepId);
    db.prepare(`UPDATE plan_steps SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  },

  /**
   * Add a step to an existing draft plan.
   * @param {object} db
   * @param {string} planId
   * @param {{ description: string, agentId: string, dependsOn?: string[], seq?: number }} data
   * @returns {object} The created step
   */
  addStep(db, planId, { description, agentId, dependsOn, seq }) {
    // If no seq provided, append at end
    if (seq === undefined || seq === null) {
      const max = db.prepare('SELECT MAX(seq) as maxSeq FROM plan_steps WHERE plan_id = ?').get(planId);
      seq = (max?.maxSeq || 0) + 1;
    } else {
      // Shift existing steps to make room
      db.prepare('UPDATE plan_steps SET seq = seq + 1 WHERE plan_id = ? AND seq >= ?').run(planId, seq);
    }

    const stepId = `step_${generateId()}`;
    db.prepare(`
      INSERT INTO plan_steps (id, plan_id, seq, description, agent_id, depends_on, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')
    `).run(stepId, planId, seq, description, agentId, JSON.stringify(dependsOn || []));

    // Update plan timestamp
    db.prepare('UPDATE plans SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), planId);

    return {
      id: stepId,
      plan_id: planId,
      seq,
      description,
      agent_id: agentId,
      depends_on: dependsOn || [],
      status: 'pending'
    };
  },

  /**
   * Remove a step from a draft plan. Recomputes seq values and cleans depends_on references.
   * @param {object} db
   * @param {string} stepId
   */
  removeStep(db, stepId) {
    const step = db.prepare('SELECT * FROM plan_steps WHERE id = ?').get(stepId);
    if (!step) return;

    // Remove the step
    db.prepare('DELETE FROM plan_steps WHERE id = ?').run(stepId);

    // Recompute seq values
    const remaining = db.prepare('SELECT id FROM plan_steps WHERE plan_id = ? ORDER BY seq').all(step.plan_id);
    const updateSeq = db.prepare('UPDATE plan_steps SET seq = ? WHERE id = ?');
    remaining.forEach((s, i) => updateSeq.run(i + 1, s.id));

    // Clean depends_on references in siblings
    const siblings = db.prepare('SELECT id, depends_on FROM plan_steps WHERE plan_id = ?').all(step.plan_id);
    const updateDeps = db.prepare('UPDATE plan_steps SET depends_on = ? WHERE id = ?');
    for (const sibling of siblings) {
      const deps = JSON.parse(sibling.depends_on || '[]');
      if (deps.includes(stepId)) {
        const cleaned = deps.filter(d => d !== stepId);
        updateDeps.run(JSON.stringify(cleaned), sibling.id);
      }
    }

    // Update plan timestamp
    db.prepare('UPDATE plans SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), step.plan_id);
  },

  /**
   * Validate dependency integrity (cycle detection via topological sort).
   * @param {object} db
   * @param {string} planId
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validateDependencies(db, planId) {
    const steps = db.prepare('SELECT * FROM plan_steps WHERE plan_id = ? ORDER BY seq').all(planId);
    const errors = [];
    const stepIds = new Set(steps.map(s => s.id));

    // Check all referenced deps exist
    for (const step of steps) {
      const deps = JSON.parse(step.depends_on || '[]');
      for (const dep of deps) {
        if (!stepIds.has(dep)) {
          errors.push(`Step "${step.description}" depends on non-existent step ${dep}`);
        }
      }
    }

    if (errors.length > 0) return { valid: false, errors };

    // Topological sort for cycle detection (Kahn's algorithm)
    const inDegree = new Map();
    const adjacency = new Map();

    for (const step of steps) {
      inDegree.set(step.id, 0);
      adjacency.set(step.id, []);
    }

    for (const step of steps) {
      const deps = JSON.parse(step.depends_on || '[]');
      inDegree.set(step.id, deps.length);
      for (const dep of deps) {
        adjacency.get(dep).push(step.id);
      }
    }

    const queue = [];
    for (const [id, degree] of inDegree) {
      if (degree === 0) queue.push(id);
    }

    let processed = 0;
    while (queue.length > 0) {
      const current = queue.shift();
      processed++;
      for (const neighbor of adjacency.get(current)) {
        inDegree.set(neighbor, inDegree.get(neighbor) - 1);
        if (inDegree.get(neighbor) === 0) queue.push(neighbor);
      }
    }

    if (processed !== steps.length) {
      errors.push('Circular dependency detected in plan steps');
      return { valid: false, errors };
    }

    return { valid: true, errors: [] };
  },

  /**
   * Hard delete a plan and its steps.
   * @param {object} db
   * @param {string} planId
   */
  delete(db, planId) {
    db.prepare('DELETE FROM plan_steps WHERE plan_id = ?').run(planId);
    db.prepare('DELETE FROM plans WHERE id = ?').run(planId);
  }
};

module.exports = PlanService;
