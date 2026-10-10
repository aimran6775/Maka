// The Chief Ranger's planning (phase 2 step 5).
//
//   createChief({ bus, store, runs, agents, trails, ledger, router, getLayout, clock })
//     -> { init(), mission({ text, budgetUsd, horizon }), state(), tools, followUp(...) }
//
// A mission from the Superintendent (text + budget + horizon) is persisted (mission.json)
// and briefed to the Chief Ranger as a run on the judge tier (router step 'plan', so the
// Chief's model, claude-opus-5-5 by default). In that run the Chief calls:
//   plan.submit   the structured plan (ventures, roles, tasks, budgets), validated against
//                 PLAN_SCHEMA by the gate, stored as plan.json (every version kept) and
//                 written to the Chief's outbox as plan-v<N>.md; emits plan.updated
//   crew.hire     creates a Ranger with a specialty in its department camp (the camp is
//                 created when missing) under the Chief
//   delegate      hands a task along a trail (sidecar/trails.js)
// A finished work item the Chief delegated starts a follow-up run for the Chief with the
// result, bounded by maxFollowUps per mission and by the judge daily cap: at the cap the
// mission pauses (plan.updated { status: 'paused' }) and resumes on the next mission call
// or follow-up when the cap allows. Approvals happen only where a leash domain says so;
// the Chief's own decisions are visible at the Peak through plan.updated and the stored
// plan, with the run transcript as evidence.

import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { makeEvent } from '../shared/events.js';
import { validate } from '../shared/schema.js';
import { SPECIALTIES, SPECIALTY_NAMES, ZONE_LABELS, agentOf } from '../shared/world.js';
import { CHIEF_ID } from './agents.js';

export const PLAN_SCHEMA = Object.freeze({
  type: 'object',
  required: ['summary', 'ventures'],
  additionalProperties: false,
  properties: {
    summary: { type: 'string', minLength: 1, maxLength: 4000, description: 'The plan in a few sentences: what, why, in which order' },
    ventures: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      items: {
        type: 'object',
        required: ['id', 'name', 'summary', 'budgetUsd', 'roles', 'tasks'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 40, pattern: '^[a-z0-9][a-z0-9-]*$', description: 'Short slug, e.g. "lantern-co"' },
          name: { type: 'string', minLength: 1, maxLength: 80 },
          summary: { type: 'string', minLength: 1, maxLength: 2000, description: 'What the venture sells, to whom, how; the evidence it rests on' },
          budgetUsd: { type: 'number', minimum: 0, description: 'Model-spend budget for this venture within the mission budget' },
          roles: { type: 'array', maxItems: 12, items: { type: 'object', required: ['specialty'], additionalProperties: false, properties: { specialty: { type: 'string', enum: SPECIALTY_NAMES }, name: { type: 'string', maxLength: 60 }, agentId: { type: 'string', description: 'An existing Ranger to assign instead of hiring' } } } },
          tasks: {
            type: 'array',
            maxItems: 40,
            items: {
              type: 'object',
              required: ['id', 'title', 'specialty', 'brief', 'budgetUsd'],
              additionalProperties: false,
              properties: {
                id: { type: 'string', minLength: 1, maxLength: 40 },
                title: { type: 'string', minLength: 1, maxLength: 120 },
                specialty: { type: 'string', enum: SPECIALTY_NAMES },
                brief: { type: 'string', minLength: 1, maxLength: 6000 },
                budgetUsd: { type: 'number', minimum: 0 },
                deadline: { type: 'string', maxLength: 80 },
                evidence: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 300 } },
                dependsOn: { type: 'array', maxItems: 10, items: { type: 'string' } },
              },
            },
          },
        },
      },
    },
    risks: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 400 } },
    needsSuperintendent: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 400 }, description: 'Only things a leash or budget makes the owner decide: caps, accounts, money above the leash' },
  },
});

export const CHIEF_SYSTEM_PROMPT = [
  'You are the Chief Ranger at the Mountain Peak of Maka, the park where AI Rangers run online businesses for the Superintendent (the owner).',
  'You own the portfolio: you read the mission, decide which ventures to pursue within the budget, plan the tasks, staff them with Rangers by specialty, and delegate along trails.',
  'Product laws: truthful telemetry (never claim revenue or results you have not seen in real data); platform-compliant by construction (official APIs under each platform\'s terms, no scraping a platform forbids, no fake engagement); replicate strategies, never property (original listings, copy and creative; no copied brand names); money out always passes the Entrance Gate under the leash model; no income promises.',
  'The Superintendent decides only what a leash or a budget sends to the Entrance Gate; everything else is yours. Do not ask them questions in prose; put genuine owner decisions in needsSuperintendent.',
  'Work in this order: (1) call plan.submit once with the full plan; (2) call crew.hire for each role that needs a new Ranger (use existing Rangers when one fits); (3) call delegate for the first tasks that can start now, one call per task, using the agent ids returned by crew.hire or listed in the crew; (4) finish with a short status in plain text.',
  'Budgets are model-spend budgets in USD; stay within the mission budget. Keep briefs concrete: what to produce, where the evidence must come from, what not to do.',
].join('\n');

const SPECIALTY_LINES = SPECIALTY_NAMES.map((k) => `- ${k}: ${SPECIALTIES[k].label}, camp "${ZONE_LABELS[SPECIALTIES[k].zoneKind]}"`).join('\n');

function fail(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

export function planMarkdown(plan, mission) {
  const lines = [`# Plan v${plan.version} for mission ${mission.id}`, '', `Mission: ${mission.text}`, `Budget: $${mission.budgetUsd.toFixed(2)} · Horizon: ${mission.horizon}`, '', `## Summary`, '', plan.summary, ''];
  for (const v of plan.ventures) {
    lines.push(`## ${v.name} (${v.id}) · $${v.budgetUsd.toFixed(2)}`, '', v.summary, '', 'Roles: ' + (v.roles.length ? v.roles.map((r) => `${r.specialty}${r.agentId ? ` (${r.agentId})` : r.name ? ` (${r.name})` : ''}`).join(', ') : 'none'), '');
    for (const t of v.tasks) lines.push(`- [${t.id}] ${t.title} → ${t.specialty} · $${t.budgetUsd.toFixed(2)}${t.deadline ? ` · by ${t.deadline}` : ''}${t.dependsOn && t.dependsOn.length ? ` · after ${t.dependsOn.join(', ')}` : ''}`, `  ${t.brief.replace(/\n/g, '\n  ')}`);
    lines.push('');
  }
  if (plan.risks && plan.risks.length) lines.push('## Risks', '', ...plan.risks.map((r) => `- ${r}`), '');
  if (plan.needsSuperintendent && plan.needsSuperintendent.length) lines.push('## Needs the Superintendent', '', ...plan.needsSuperintendent.map((r) => `- ${r}`), '');
  return lines.join('\n');
}

export function createChief({ bus, store, runs, agents, trails, ledger = null, router, getLayout, clock = { now: () => Date.now() }, workspaceRoot, maxFollowUps = 20, log = console } = {}) {
  if (!bus || !store || !runs || !agents || !trails || !router || typeof getLayout !== 'function' || !workspaceRoot) throw new TypeError('createChief needs bus, store, runs, agents, trails, router, getLayout and workspaceRoot');
  let mission = null; // { id, text, budgetUsd, horizon, status, createdAt, followUps, runIds, reason }
  let plan = null; // { id, missionId, version, submittedAt, by, runId, ...PLAN, history: [] }
  const chiefRuns = new Set();
  const emit = (type, payload) => bus.emit(makeEvent(type, payload, { ts: clock.now() }));
  const caps = router.caps();

  const ventureSummary = (p) => p.ventures.map((v) => ({ id: v.id, name: v.name, budgetUsd: v.budgetUsd, taskCount: v.tasks.length, summary: v.summary.slice(0, 200) }));

  async function setStatus(status, reason = '') {
    if (!mission) return;
    mission.status = status;
    mission.reason = reason;
    await store.saveMission(mission);
    emit('plan.updated', { missionId: mission.id, planId: plan ? plan.id : '', version: plan ? plan.version : 0, change: 'status', status, reason });
  }

  function judgeCapReason() {
    if (!ledger) return null;
    const today = ledger.judgeToday();
    if (today.usd >= caps.judgeUsdPerDay) return `judge daily cap reached: $${today.usd.toFixed(2)} of $${caps.judgeUsdPerDay}`;
    if (today.calls >= caps.judgeCallsPerDay) return `judge cap reached: ${caps.judgeCallsPerDay} call(s) per day`;
    return null;
  }

  function crewLines() {
    const layout = getLayout();
    const zones = layout.rooms.map((r) => `${r.id} (${r.kind || 'zone'})`).join(', ');
    const crew = layout.agents.filter((a) => a.role !== 'chief_ranger').map((a) => `- ${a.id}: ${a.name}, ${a.role}${a.specialty ? `, ${a.specialty}` : ''}${a.venture ? `, venture ${a.venture}` : ''}, zone ${a.roomId}`);
    return [`Zones: ${zones || 'none'}`, `Crew (${crew.length}):`, ...(crew.length ? crew : ['- nobody yet; hire by specialty']), '', 'Specialties and their camps:', SPECIALTY_LINES];
  }

  async function startChiefRun(prompt, { budgetUsd, maxTurns = 16 }) {
    const cap = judgeCapReason();
    if (cap) {
      await setStatus('paused', cap);
      return null;
    }
    const started = await runs.start({ agentId: CHIEF_ID, prompt, step: 'plan', budgetUsd, maxTurns, review: false, system: CHIEF_SYSTEM_PROMPT });
    chiefRuns.add(started.runId);
    mission.runIds.push(started.runId);
    await store.saveMission(mission);
    return started;
  }

  // Chief-only tools, granted through grants() in the run manager for the chief role.
  const tools = {
    'plan.submit': {
      name: 'plan.submit',
      description: 'Submit the plan for the current mission: ventures with roles, tasks and budgets. Call it once per planning run; a later call replaces the plan with a new version. The input must match the schema exactly.',
      inputSchema: PLAN_SCHEMA,
      confirm: false,
      async run(input, ctx) {
        if (!mission) return { ok: false, error: 'there is no mission to plan for' };
        const total = input.ventures.reduce((n, v) => n + v.budgetUsd, 0);
        if (total > mission.budgetUsd + 1e-9) return { ok: false, error: `venture budgets add up to $${total.toFixed(2)}, over the mission budget of $${mission.budgetUsd.toFixed(2)}` };
        const ids = new Set();
        for (const v of input.ventures) {
          if (ids.has(v.id)) return { ok: false, error: `duplicate venture id "${v.id}"` };
          ids.add(v.id);
          const taskIds = new Set();
          for (const t of v.tasks) {
            if (taskIds.has(t.id)) return { ok: false, error: `duplicate task id "${t.id}" in ${v.id}` };
            taskIds.add(t.id);
          }
          const taskTotal = v.tasks.reduce((n, t) => n + t.budgetUsd, 0);
          if (taskTotal > v.budgetUsd + 1e-9) return { ok: false, error: `tasks of ${v.id} add up to $${taskTotal.toFixed(2)}, over its budget of $${v.budgetUsd.toFixed(2)}` };
        }
        // Every venture gets a trailhead in the park; its trails run to the camps that serve it.
        for (const v of input.ventures) {
          try {
            await agents.ensureZone('trailhead', { venture: v.id, name: `${v.name} Trailhead` });
          } catch (err) {
            return { ok: false, error: `could not place a trailhead for ${v.id}: ${err.message}` };
          }
        }
        const version = plan ? plan.version + 1 : 1;
        const history = plan ? [...plan.history, { version: plan.version, submittedAt: plan.submittedAt, runId: plan.runId, summary: plan.summary }] : [];
        plan = { id: plan ? plan.id : `plan-${randomUUID().slice(0, 8)}`, missionId: mission.id, version, submittedAt: clock.now(), by: ctx.agentId, runId: ctx.runId || '', ...input, history };
        await store.savePlan(plan);
        const outbox = path.join(workspaceRoot, CHIEF_ID, 'outbox');
        await fsp.mkdir(outbox, { recursive: true });
        await fsp.writeFile(path.join(outbox, `plan-v${version}.md`), planMarkdown(plan, mission), 'utf8');
        if (mission.status === 'planning') {
          mission.status = 'active';
          mission.reason = '';
          await store.saveMission(mission);
        }
        emit('plan.updated', { missionId: mission.id, planId: plan.id, version, change: 'submitted', status: mission.status, summary: input.summary.slice(0, 1000), by: ctx.agentId, runId: ctx.runId || '', ventures: ventureSummary(input) });
        return { ok: true, output: `plan v${version} stored (${input.ventures.length} venture(s), ${input.ventures.reduce((n, v) => n + v.tasks.length, 0)} task(s)); written to outbox/plan-v${version}.md. Now hire and delegate.` };
      },
    },
    'crew.hire': {
      name: 'crew.hire',
      description: 'Hire a Ranger with a specialty for a venture. It is created in its department camp (the camp is created if missing) reporting to you. Returns the agent id to delegate to.',
      inputSchema: {
        type: 'object',
        required: ['name', 'specialty', 'venture'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 60 },
          specialty: { type: 'string', enum: SPECIALTY_NAMES },
          venture: { type: 'string', minLength: 1, maxLength: 80, description: 'Venture id from the plan' },
          persona: { type: 'string', maxLength: 2000, description: 'Optional extra persona; the specialty persona applies by default' },
          budgetUsd: { type: 'number', minimum: 0 },
        },
      },
      confirm: false,
      async run(input, ctx) {
        try {
          const zone = await agents.ensureZone(SPECIALTIES[input.specialty].zoneKind);
          const persona = input.persona ? `${SPECIALTIES[input.specialty].persona} ${input.persona}` : undefined;
          const a = await agents.create({ name: input.name, role: 'ranger', zoneId: zone.id, parentAgentId: ctx.agentId, specialty: input.specialty, venture: input.venture, persona, budgetUsd: input.budgetUsd }, { by: ctx.agentId });
          return { ok: true, output: JSON.stringify({ agentId: a.id, name: a.name, zone: zone.id, specialty: input.specialty }) };
        } catch (err) {
          return { ok: false, error: err && err.message ? err.message : String(err) };
        }
      },
    },
  };

  async function followUp(doneEvent) {
    if (!mission || mission.status === 'done') return null;
    if (mission.followUps >= maxFollowUps) {
      if (mission.status !== 'paused') await setStatus('paused', `follow-up cap reached: ${maxFollowUps} per mission`);
      return null;
    }
    const p = doneEvent.payload;
    const item = trails.get(p.workItemId);
    mission.followUps += 1;
    const prompt = [
      `Work item ${p.workItemId} you delegated to ${p.toAgentId} has finished: ${p.status}${p.reason && p.reason !== 'completed' ? ` (${p.reason})` : ''}.`,
      item ? `Brief was: ${item.brief.slice(0, 600)}` : '',
      `Summary from the Ranger: ${p.summary || '(none)'}`,
      `Deliverables: ${p.deliverables.length ? p.deliverables.join(', ') : 'none'} · spend $${(p.spentUsd || 0).toFixed(2)}`,
      '',
      'Current plan summary: ' + (plan ? plan.summary.slice(0, 800) : '(no plan)'),
      '',
      'Decide the next move: delegate the next task(s) that can start now (use work.check if you need details), revise the plan with plan.submit if the result changes it, or, if nothing is left to do, say so and stop. Do not re-delegate finished work.',
    ].join('\n');
    return startChiefRun(prompt, { budgetUsd: Math.min(mission.budgetUsd, 2), maxTurns: 10 });
  }

  bus.listen((event) => {
    if (event.type === 'work.done' && event.payload.fromAgentId === CHIEF_ID) followUp(event).catch((err) => log.error('chief follow-up failed:', err));
    if (event.type === 'cost.estimate' && chiefRuns.has(event.payload.runId) && ledger && event.payload.reconciled && typeof event.payload.usd === 'number') {
      ledger.recordJudge({ usd: event.payload.usd }).catch((err) => log.error('judge ledger failed:', err));
    }
  });

  return {
    tools,
    async init() {
      mission = await store.loadMission(null);
      plan = await store.loadPlan(null);
      if (mission && !Array.isArray(mission.runIds)) mission.runIds = [];
      return this;
    },
    state: () => ({ mission: mission ? { ...mission } : null, plan: plan ? { ...plan } : null, chief: agents.get(CHIEF_ID), caps, judgeToday: ledger ? ledger.judgeToday() : null }),
    // A new mission from the Superintendent, or a re-brief of the current one.
    async mission({ text, budgetUsd, horizon = '30 days' } = {}) {
      if (typeof text !== 'string' || !text.trim()) throw fail('BAD_REQUEST', 'mission text is required');
      if (typeof budgetUsd !== 'number' || !(budgetUsd >= 0)) throw fail('BAD_REQUEST', 'budgetUsd must be a non-negative number');
      if (typeof horizon !== 'string' || !horizon.trim()) throw fail('BAD_REQUEST', 'horizon must be a string');
      await agents.ensureChief();
      if (runs.activeFor(CHIEF_ID) || runs.queued().some((r) => r.agentId === CHIEF_ID)) throw fail('CONFLICT', 'the Chief Ranger is already in a run; wait for it or cancel it', 409);
      const previous = mission;
      mission = { id: `mission-${randomUUID().slice(0, 8)}`, text: text.trim(), budgetUsd, horizon: horizon.trim(), status: 'planning', reason: '', createdAt: clock.now(), followUps: 0, runIds: [], previousId: previous ? previous.id : null };
      await store.saveMission(mission);
      emit('plan.updated', { missionId: mission.id, planId: plan ? plan.id : '', version: plan ? plan.version : 0, change: 'status', status: 'planning', summary: mission.text.slice(0, 1000) });
      const prompt = [
        `MISSION from the Superintendent: ${mission.text}`,
        `Mission budget (model spend): $${budgetUsd.toFixed(2)} · Horizon: ${mission.horizon}`,
        '',
        ...crewLines(),
        '',
        plan ? `A previous plan exists (v${plan.version}): ${plan.summary.slice(0, 800)}\nSubmit a new version that fits this mission.` : 'There is no plan yet.',
        '',
        'Plan now: plan.submit, then crew.hire, then delegate the first tasks, then a short status.',
      ].join('\n');
      const started = await startChiefRun(prompt, { budgetUsd: Math.min(budgetUsd, 5), maxTurns: 16 });
      return { mission: { ...mission }, runId: started ? started.runId : null, queued: started ? started.queued : false };
    },
    followUp,
  };
}

export { CHIEF_ID };
