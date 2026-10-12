// Crew tools (phase 2 step 3): tools granted by role (shared/world.js ROLE_GRANTS) rather
// than by a fixture. They act on the agents registry injected through the gate's
// toolContext ({ agents }). No leash domain: creating a Junior Ranger is an org change
// inside the park, not an outside effect; the registry enforces the one-hop depth and the
// gate only lists the tool for chief_ranger and ranger roles.

import { SPECIALTY_NAMES, DEPARTMENT_KINDS, ZONE_LABELS, departments, departmentOf, departmentOfAgent } from '../../shared/world.js';

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
      budgetUsd: { type: 'number', minimum: 0, description: 'Model spend the receiver may use (default 0.5); capped at what you have left (the mission budget for the Chief, your run\'s budget otherwise)' },
      deadline: { type: 'string', description: 'Optional deadline, free text or ISO date' },
      evidence: { type: 'array', items: { type: 'string' }, description: 'What evidence the deliverable must carry' },
    },
  },
  confirm: false,
  async run(input, ctx) {
    if (!ctx.trails) return { ok: false, error: 'no trails are available in this run' };
    try {
      const item = await ctx.trails.delegate({ toAgentId: input.toAgentId, brief: input.brief, budgetUsd: input.budgetUsd, deadline: input.deadline, evidence: input.evidence }, { by: ctx.agentId });
      return { ok: true, output: JSON.stringify({ workItemId: item.id, toAgentId: item.toAgentId, status: item.status, queued: item.queued, runId: item.runId, budgetUsd: item.budgetUsd, ...(item.budgetCapped ? { budgetCapped: true, note: `the budget was capped at $${item.budgetUsd.toFixed(2)}, what you have left to delegate` } : {}) }) };
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

// D178: the park replicates a company, so a Ranger that needs something asks a department
// rather than hunting for an agent id. `delegate` names one agent and always did; these two
// name a department and let the park find the person — which is what "it goes through the
// departments" means. The owner chose head triage: a request lands with the department's
// head, who assigns it to its team.

export const deptDirectory = {
  name: 'dept.directory',
  description:
    'List the park\'s departments: what each one is for, whether its camp exists, who heads it and who is on its team. ' +
    'Read this before asking another department for something, so you address a department that exists and know who will answer.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { department: { type: 'string', enum: DEPARTMENT_KINDS, description: 'Optional: just this one' } },
  },
  confirm: false,
  async run(input, ctx) {
    if (!ctx.agents || typeof ctx.agents.layout !== 'function') return { ok: false, error: 'no crew registry is available in this run' };
    const layout = ctx.agents.layout();
    const list = input.department ? [departmentOf(layout, input.department)].filter(Boolean) : departments(layout);
    const mine = departmentOfAgent(layout, ctx.agentId);
    const name = (id) => {
      const a = ctx.agents.get(id);
      return a ? `${a.name} (${id})` : id;
    };
    return {
      ok: true,
      output: JSON.stringify({
        yours: mine ? mine.kind : null,
        departments: list.map((d) => ({
          department: d.kind,
          label: d.label,
          teams: d.specialties,
          // The difference between a camp that was never built and one standing empty
          // changes the answer, so it is said plainly rather than left to be inferred.
          camp: d.roomId ? d.roomId : 'not built yet',
          head: d.head ? name(d.head) : null,
          staff: d.staff.map(name),
          folder: `_teams/${d.kind}/`,
        })),
      }),
    };
  },
};

export const deptRequest = {
  name: 'dept.request',
  description:
    'Ask another department for something you need: a decision, a number, a check, a piece of work. ' +
    'It goes to that department\'s head, who triages it and assigns it to their team, so you do not need to know who is on it. ' +
    'Say exactly what you need and why, and what you will do with the answer. Returns the work item id; read it later with work.check. ' +
    'Use dept.directory first if you are unsure which department owns the question.',
  inputSchema: {
    type: 'object',
    required: ['department', 'need'],
    additionalProperties: false,
    properties: {
      department: { type: 'string', enum: DEPARTMENT_KINDS, description: 'The department you are asking' },
      need: { type: 'string', minLength: 1, maxLength: 8000, description: 'What you need, why, and what you will do with the answer' },
      budgetUsd: { type: 'number', minimum: 0, description: 'Model spend the department may use on this (default 0.5); capped at what you have left' },
      deadline: { type: 'string', description: 'Optional deadline, free text or ISO date' },
      evidence: { type: 'array', items: { type: 'string' }, description: 'What the answer must show to be usable' },
    },
  },
  confirm: false,
  async run(input, ctx) {
    if (!ctx.trails) return { ok: false, error: 'no trails are available in this run' };
    if (!ctx.agents || typeof ctx.agents.layout !== 'function') return { ok: false, error: 'no crew registry is available in this run' };
    const layout = ctx.agents.layout();
    const dept = departmentOf(layout, input.department);
    if (!dept) return { ok: false, error: `"${input.department}" is not a department of the park` };
    // A department with no camp or no head cannot take a request. Saying which of the two
    // it is tells the caller whether to ask the Chief for a camp or for a head, instead of
    // leaving it to retry the same thing.
    if (!dept.roomId) return { ok: false, error: `the ${dept.label} has not been built yet; ask the Chief Ranger to open it before sending work there` };
    if (!dept.head) {
      return {
        ok: false,
        error: dept.staff.length
          ? `the ${dept.label} has no head, so there is nobody to triage this; ask the Chief Ranger to make one of its ${dept.staff.length} Ranger(s) the head`
          : `the ${dept.label} is empty; ask the Chief Ranger to staff it`,
      };
    }
    const from = departmentOfAgent(layout, ctx.agentId);
    if (dept.head === ctx.agentId) return { ok: false, error: `you head the ${dept.label}: handle this yourself or delegate it to your team` };
    const brief = [
      `Request from ${ctx.agentId}${from ? ` (${from.label})` : ''} to the ${dept.label}.`,
      '',
      'You are the head of this department. Decide whether to answer it yourself or assign it to one of your team with delegate.',
      '',
      'WHAT THEY NEED:',
      input.need,
      ...(input.evidence && input.evidence.length ? ['', `The answer must show: ${input.evidence.join('; ')}`] : []),
      '',
      `Reply by finishing with the answer, and put anything your department should keep in _teams/${dept.kind}/.`,
    ].join('\n');
    try {
      const item = await ctx.trails.delegate(
        { toAgentId: dept.head, brief, budgetUsd: input.budgetUsd, deadline: input.deadline, evidence: input.evidence },
        { by: ctx.agentId },
      );
      return {
        ok: true,
        output: JSON.stringify({
          workItemId: item.id,
          department: dept.kind,
          toAgentId: item.toAgentId,
          triagedBy: 'head',
          status: item.status,
          queued: item.queued,
          budgetUsd: item.budgetUsd,
          ...(item.budgetCapped ? { budgetCapped: true, note: `the budget was capped at $${item.budgetUsd.toFixed(2)}, what you have left` } : {}),
        }),
      };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  },
};

export const CREW_TOOLS = Object.freeze({ 'crew.spawn_junior': spawnJunior, delegate, 'work.check': workCheck, 'dept.directory': deptDirectory, 'dept.request': deptRequest });
