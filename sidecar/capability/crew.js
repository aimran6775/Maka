// Crew tools (phase 2 step 3): tools granted by role (shared/world.js ROLE_GRANTS) rather
// than by a fixture. They act on the agents registry injected through the gate's
// toolContext ({ agents }). No leash domain: creating a Junior Ranger is an org change
// inside the park, not an outside effect; the registry enforces the one-hop depth and the
// gate only lists the tool for chief_ranger and ranger roles.

import { SPECIALTY_NAMES } from '../../shared/world.js';

export const spawnJunior = {
  name: 'crew.spawn_junior',
  description:
    'Create a Junior Ranger reporting to you, in your zone, for one bounded subtask. Give it a short name, ' +
    'a persona (what it does and must not do) and the venture. Junior Rangers cannot create Juniors of their own. ' +
    'Returns the new agent id; hand it work with the delegate tool when you have it.',
  inputSchema: {
    type: 'object',
    required: ['name', 'persona'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 60, description: 'Display name, e.g. "Listing drafter"' },
      persona: { type: 'string', minLength: 1, maxLength: 2000, description: 'What this Junior does and its limits' },
      specialty: { type: 'string', enum: SPECIALTY_NAMES, description: 'Optional specialty' },
      venture: { type: 'string', description: 'Optional venture name; defaults to yours' },
    },
  },
  confirm: false,
  async run(input, ctx) {
    if (!ctx.agents) return { ok: false, error: 'no agents registry is available in this run' };
    const me = ctx.agents.get(ctx.agentId);
    if (!me) return { ok: false, error: `unknown caller "${ctx.agentId}"` };
    try {
      const junior = await ctx.agents.create(
        { name: input.name, role: 'junior_ranger', zoneId: me.roomId, parentAgentId: me.id, persona: input.persona, specialty: input.specialty, venture: input.venture || me.venture },
        { by: me.id },
      );
      return { ok: true, output: JSON.stringify({ agentId: junior.id, name: junior.name, zone: junior.roomId, parentAgentId: junior.parentAgentId }) };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  },
};

// Hands a work item to another agent along a trail (sidecar/trails.js). Non-blocking: the
// receiver's run is queued and the result arrives as a work.done event; check it with
// work.check. Who may delegate to whom is enforced by the trails module.
export const delegate = {
  name: 'delegate',
  description:
    'Hand a bounded work item to another Ranger (or one of your Junior Rangers). Give a complete brief, a model-spend ' +
    'budget in USD, an optional deadline and the evidence the deliverable must include. The receiver runs on its own; ' +
    'this returns the work item id at once. Use work.check later to read its status, summary and deliverable files.',
  inputSchema: {
    type: 'object',
    required: ['toAgentId', 'brief'],
    additionalProperties: false,
    properties: {
      toAgentId: { type: 'string', minLength: 1, description: 'The receiving agent id' },
      brief: { type: 'string', minLength: 1, maxLength: 8000, description: 'What to do, with context and the expected deliverable' },
      budgetUsd: { type: 'number', minimum: 0, description: 'Model spend the receiver may use (default 0.5)' },
      deadline: { type: 'string', description: 'Optional deadline, free text or ISO date' },
      evidence: { type: 'array', items: { type: 'string' }, description: 'What evidence the deliverable must carry' },
    },
  },
  confirm: false,
  async run(input, ctx) {
    if (!ctx.trails) return { ok: false, error: 'no trails are available in this run' };
    try {
      const item = await ctx.trails.delegate({ toAgentId: input.toAgentId, brief: input.brief, budgetUsd: input.budgetUsd, deadline: input.deadline, evidence: input.evidence }, { by: ctx.agentId });
      return { ok: true, output: JSON.stringify({ workItemId: item.id, toAgentId: item.toAgentId, status: item.status, queued: item.queued, runId: item.runId }) };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  },
};

export const workCheck = {
  name: 'work.check',
  description: 'List the work items you delegated or received, with status (queued / running / done / failed / cancelled), summary, deliverable files and spend. Pass an id to read one item in full.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { workItemId: { type: 'string', description: 'Optional: one work item id' } },
  },
  confirm: false,
  async run(input, ctx) {
    if (!ctx.trails) return { ok: false, error: 'no trails are available in this run' };
    if (input.workItemId) {
      const item = ctx.trails.get(input.workItemId);
      if (!item) return { ok: false, error: `no work item "${input.workItemId}"` };
      if (item.fromAgentId !== ctx.agentId && item.toAgentId !== ctx.agentId) return { ok: false, error: `work item ${input.workItemId} is not yours` };
      return { ok: true, output: JSON.stringify(item) };
    }
    const mine = ctx.trails.forAgent(ctx.agentId).map((it) => ({ workItemId: it.id, from: it.fromAgentId, to: it.toAgentId, status: it.status, reason: it.reason, summary: it.summary.slice(0, 300), deliverables: it.deliverables, spentUsd: it.spentUsd }));
    return { ok: true, output: JSON.stringify(mine) };
  },
};

export const CREW_TOOLS = Object.freeze({ 'crew.spawn_junior': spawnJunior, delegate, 'work.check': workCheck });
