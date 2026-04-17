/**
 * Plans API Routes
 *
 * CRUD for plans and plan steps, approval/rejection/cancellation,
 * and SSE stream for plan progress.
 */

const express = require('express');
const { emit, STATE_SNAPSHOT } = require('../shared/agui-events');

/**
 * @param {object} db
 * @param {{ PlanService: object, PlanExecutorService: object|null, AgentService: object }} services
 */
function createPlansRouter(db, { PlanService, PlanExecutorService, AgentService }) {
  const router = express.Router();

  // POST / — Create a new plan
  router.post('/', (req, res) => {
    try {
      const { agentId, request, summary, steps } = req.body;

      if (!agentId || !request || !steps || !Array.isArray(steps) || steps.length === 0) {
        return res.status(400).json({ error: 'agentId, request, and steps (non-empty array) are required' });
      }

      // Validate agent exists
      const agent = AgentService.getById(db, agentId);
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }

      // Validate step agents exist
      for (const step of steps) {
        const stepAgentId = step.agentId || step.agent_id || step.agent;
        if (stepAgentId && stepAgentId !== 'self' && stepAgentId !== agentId) {
          const stepAgent = AgentService.getById(db, stepAgentId);
          if (!stepAgent) {
            return res.status(400).json({ error: `Agent ${stepAgentId} in step not found` });
          }
        }
      }

      const plan = PlanService.create(db, { agentId, request, summary, steps });
      res.json(plan);
    } catch (err) {
      console.error('Plan create error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /agent/:agentId — List agent's plans (before /:id to avoid capture)
  router.get('/agent/:agentId', (req, res) => {
    try {
      const { agentId } = req.params;
      const status = req.query.status || null;
      const limit = parseInt(req.query.limit) || 20;

      let plans;
      if (status) {
        plans = PlanService.getByAgent(db, agentId, limit)
          .filter(p => p.status === status);
      } else {
        plans = PlanService.getByAgent(db, agentId, limit);
      }

      res.json(plans);
    } catch (err) {
      console.error('Plan list error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /:id — Get plan with steps
  router.get('/:id', (req, res) => {
    try {
      const plan = PlanService.getById(db, req.params.id);
      if (!plan) return res.status(404).json({ error: 'Plan not found' });
      res.json(plan);
    } catch (err) {
      console.error('Plan get error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /:id/approve — Approve and trigger execution
  router.post('/:id/approve', (req, res) => {
    try {
      const plan = PlanService.getById(db, req.params.id);
      if (!plan) return res.status(404).json({ error: 'Plan not found' });
      if (plan.status !== 'draft') {
        return res.status(400).json({ error: `Cannot approve plan with status "${plan.status}"` });
      }

      // Validate dependencies before approval
      const validation = PlanService.validateDependencies(db, plan.id);
      if (!validation.valid) {
        return res.status(400).json({ error: 'Invalid dependencies', details: validation.errors });
      }

      PlanService.updateStatus(db, plan.id, 'approved');

      // Trigger execution if executor is wired
      if (PlanExecutorService) {
        // Fire-and-forget — execution is async
        PlanExecutorService.execute(db, plan.id).catch(err => {
          console.error(`[Plans] Execution error for ${plan.id}:`, err);
        });
      }

      res.json({ ok: true });
    } catch (err) {
      console.error('Plan approve error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /:id/reject — Reject a draft plan
  router.post('/:id/reject', (req, res) => {
    try {
      const plan = PlanService.getById(db, req.params.id);
      if (!plan) return res.status(404).json({ error: 'Plan not found' });
      if (plan.status !== 'draft') {
        return res.status(400).json({ error: `Cannot reject plan with status "${plan.status}"` });
      }

      PlanService.updateStatus(db, plan.id, 'rejected');
      res.json({ ok: true });
    } catch (err) {
      console.error('Plan reject error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /:id/cancel — Cancel an executing plan
  router.post('/:id/cancel', (req, res) => {
    try {
      const plan = PlanService.getById(db, req.params.id);
      if (!plan) return res.status(404).json({ error: 'Plan not found' });
      if (plan.status !== 'executing') {
        return res.status(400).json({ error: `Cannot cancel plan with status "${plan.status}"` });
      }

      if (PlanExecutorService) {
        PlanExecutorService.cancel(db, plan.id);
      } else {
        PlanService.updateStatus(db, plan.id, 'cancelled');
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('Plan cancel error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // PATCH /:id/steps/:stepId — Edit a step (draft only)
  router.patch('/:id/steps/:stepId', (req, res) => {
    try {
      const plan = PlanService.getById(db, req.params.id);
      if (!plan) return res.status(404).json({ error: 'Plan not found' });
      if (plan.status !== 'draft') {
        return res.status(400).json({ error: 'Can only edit steps in draft plans' });
      }

      const step = plan.steps.find(s => s.id === req.params.stepId);
      if (!step) return res.status(404).json({ error: 'Step not found' });

      const { description, agentId } = req.body;
      PlanService.editStep(db, req.params.stepId, { description, agentId });

      const updated = PlanService.getById(db, req.params.id);
      const updatedStep = updated.steps.find(s => s.id === req.params.stepId);
      res.json(updatedStep);
    } catch (err) {
      console.error('Step edit error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /:id/steps — Add a step (draft only)
  router.post('/:id/steps', (req, res) => {
    try {
      const plan = PlanService.getById(db, req.params.id);
      if (!plan) return res.status(404).json({ error: 'Plan not found' });
      if (plan.status !== 'draft') {
        return res.status(400).json({ error: 'Can only add steps to draft plans' });
      }

      const { description, agentId, dependsOn, seq } = req.body;
      if (!description) {
        return res.status(400).json({ error: 'description is required' });
      }

      const stepAgentId = agentId || plan.agent_id;
      const newStep = PlanService.addStep(db, plan.id, {
        description,
        agentId: stepAgentId,
        dependsOn,
        seq
      });
      res.json(newStep);
    } catch (err) {
      console.error('Step add error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /:id/steps/:stepId — Remove a step (draft only)
  router.delete('/:id/steps/:stepId', (req, res) => {
    try {
      const plan = PlanService.getById(db, req.params.id);
      if (!plan) return res.status(404).json({ error: 'Plan not found' });
      if (plan.status !== 'draft') {
        return res.status(400).json({ error: 'Can only remove steps from draft plans' });
      }

      const step = plan.steps.find(s => s.id === req.params.stepId);
      if (!step) return res.status(404).json({ error: 'Step not found' });

      PlanService.removeStep(db, req.params.stepId);
      res.json({ ok: true });
    } catch (err) {
      console.error('Step remove error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /:id/stream — SSE stream for plan progress
  router.get('/:id/stream', (req, res) => {
    const plan = PlanService.getById(db, req.params.id);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    // Send current state
    emit(
      res,
      STATE_SNAPSHOT,
      { snapshot: { plan } }
    );

    // Register for updates if executor is available
    if (PlanExecutorService) {
      const listener = (event) => {
        if (event.planId === req.params.id) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      };
      PlanExecutorService.addListener(listener);

      req.on('close', () => {
        PlanExecutorService.removeListener(listener);
      });
    }
  });

  // DELETE /:id — Hard delete a plan
  router.delete('/:id', (req, res) => {
    try {
      const plan = PlanService.getById(db, req.params.id);
      if (!plan) return res.status(404).json({ error: 'Plan not found' });

      PlanService.delete(db, plan.id);
      res.json({ ok: true });
    } catch (err) {
      console.error('Plan delete error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createPlansRouter;

module.exports.meta = {
  name: 'plans',
  description: 'Multi-step execution plan management',
  endpoints: [
    { method: 'POST', path: '/api/plans', description: 'Create a new plan' },
    { method: 'GET', path: '/api/plans/:id', description: 'Get plan with steps' },
    { method: 'GET', path: '/api/plans/agent/:agentId', description: 'List agent plans' },
    { method: 'POST', path: '/api/plans/:id/approve', description: 'Approve and execute' },
    { method: 'POST', path: '/api/plans/:id/reject', description: 'Reject a draft plan' },
    { method: 'POST', path: '/api/plans/:id/cancel', description: 'Cancel executing plan' },
    { method: 'PATCH', path: '/api/plans/:id/steps/:stepId', description: 'Edit a plan step' },
    { method: 'POST', path: '/api/plans/:id/steps', description: 'Add a plan step' },
    { method: 'DELETE', path: '/api/plans/:id/steps/:stepId', description: 'Remove a plan step' },
    { method: 'GET', path: '/api/plans/:id/stream', description: 'SSE stream for plan progress' }
  ]
};
