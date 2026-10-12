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
//   plan.read     the stored plan as it is, so a revision edits it instead of guessing it
//                 (D176: plan.submit replaces, and a replacing write needs a read)
//   crew.hire     creates a Ranger with a specialty in its department camp (the camp is
//                 created when missing) under the Chief
//   crew.retire   removes a Ranger that is no longer needed (D176), refusing one with
//                 reports, with a run in progress, or the Chief itself
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
import { SPECIALTIES, SPECIALTY_NAMES, ZONE_LABELS, agentOf, departmentOfAgent } from '../shared/world.js';
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
  'Work in this order: (1) call plan.submit once with the full plan — when a plan already exists, call plan.read first and send back that plan with your changes applied, because plan.submit replaces every venture, task and budget and anything you leave out is lost; (2) call crew.hire for each role that needs a new Ranger (use existing Rangers when one fits) and crew.retire for any Ranger the work no longer needs, so the crew matches the plan in both directions; (3) call delegate for the first tasks that can start now, one call per task, using the agent ids returned by crew.hire or listed in the crew; (4) finish with a short status in plain text.',
  'Budgets are model-spend budgets in USD; stay within the mission budget. Keep briefs concrete: what to produce, where the evidence must come from, what not to do.',
].join('\n');

// Phase 4 step 1: "ask the Peak" from an owner channel. The Chief answers one question
// from the recorded data it is handed, with no tools (nothing can change from a chat
// message) and a small bound on turns and spend.
export const ASK_SYSTEM_PROMPT = [
  'You are the Chief Ranger at the Mountain Peak of Maka. The Superintendent (the owner) asks you a question from their phone.',
  'Answer from the recorded data below only. Where a figure is missing say "unknown"; never estimate revenue, orders or results, never promise outcomes.',
  'You have no tools in this run: you cannot plan, hire, delegate or change anything. If the question asks for an action, say what you would do and that it needs the park or a mission.',
  'Keep the answer short (a few sentences or a short list) and cite the numbers you use.',
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
    // D176: plan.submit replaces the plan outright, and until this tool existed nothing
    // could read one back — the Chief saw only an 800-character summary in its follow-up
    // prompt. So a revision meant rebuilding every venture, task and budget from memory,
    // and the Chief rightly refused to do it rather than overwrite real numbers with
    // guesses. Reading is the other half of a replacing write.
    'plan.read': {
      name: 'plan.read',
      description: 'Read the current plan for this mission exactly as it is stored: every venture with its roles, tasks and budgets, and the version history. Call this before plan.submit when you are revising, so a new version changes what you mean to change and carries the rest across unaltered.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      confirm: false,
      async run() {
        if (!mission) return { ok: false, error: 'there is no mission to read a plan for' };
        if (!plan) return { ok: false, error: 'no plan has been submitted for this mission yet; plan.submit creates v1' };
        // The shape plan.submit accepts, so a revision is an edit of what comes back here,
        // plus the read-only context needed to judge a change (version, budget, history).
        return {
          ok: true,
          output: JSON.stringify({
            version: plan.version,
            submittedAt: plan.submittedAt,
            missionBudgetUsd: mission.budgetUsd,
            summary: plan.summary,
            ventures: plan.ventures,
            history: (plan.history || []).map((h) => ({ version: h.version, submittedAt: h.submittedAt, summary: h.summary })),
          }),
        };
      },
    },
    // D176: crew.hire only ever grew the crew. Twelve Rangers accumulated on one $2.50
    // candle venture because there was no tool to undo a hire, and the Chief could see
    // that was wrong but not act on it. agents.remove already refuses an agent that has
    // reports or a run in progress; this adds the one guard it cannot know about, that the
    // Chief may not retire itself.
    'crew.retire': {
      name: 'crew.retire',
      description: 'Retire a Ranger you no longer need, by agent id. Refused if it has reports, if it has a run in progress, or if it is you. Its finished work and deliverables stay; only the Ranger goes. Retire surplus crew rather than leaving it idle.',
      inputSchema: {
        type: 'object',
        required: ['agentId'],
        additionalProperties: false,
        properties: {
          agentId: { type: 'string', minLength: 1, maxLength: 120, description: 'The id of the Ranger to retire' },
          reason: { type: 'string', maxLength: 500, description: 'Why it is no longer needed; recorded with the change' },
        },
      },
      confirm: false,
      async run(input, ctx) {
        if (input.agentId === ctx.agentId || input.agentId === CHIEF_ID) {
          return { ok: false, error: 'the Chief Ranger cannot retire itself' };
        }
        try {
          const a = agents.get ? agents.get(input.agentId) : null;
          await agents.remove(input.agentId, { by: ctx.agentId });
          return { ok: true, output: JSON.stringify({ retired: input.agentId, name: (a && a.name) || null, reason: input.reason || '' }) };
        } catch (err) {
          return { ok: false, error: err && err.message ? err.message : String(err) };
        }
      },
    },
    // D178: a head must be appointable, not only hireable. Without this the only head a
    // camp could ever have is one created with `crew.hire head: true`, so a camp staffed
    // before heads existed stays headless for good and nothing can be asked of it.
    'crew.set_head': {
      name: 'crew.set_head',
      description: 'Make one of your Rangers the head of its department, or stand the current head down. The head is who receives what other departments ask of that department (dept.request) and assigns it to the team. One head per camp: appointing a new one stands the previous one down. Only a Ranger standing in a department camp can head it.',
      inputSchema: {
        type: 'object',
        required: ['agentId'],
        additionalProperties: false,
        properties: {
          agentId: { type: 'string', minLength: 1, maxLength: 120, description: 'The Ranger to appoint' },
          head: { type: 'boolean', description: 'true to appoint (the default), false to stand the current head down' },
        },
      },
      confirm: false,
      async run(input, ctx) {
        const head = input.head !== false;
        try {
          const a = await agents.update(input.agentId, { head }, { by: ctx.agentId });
          const dept = departmentOfAgent(agents.layout(), input.agentId);
          return {
            ok: true,
            output: JSON.stringify({ agentId: a.id, name: a.name, department: dept ? dept.kind : null, head, ...(head && dept ? { nowHeads: dept.label } : {}) }),
          };
        } catch (err) {
          return { ok: false, error: err && err.message ? err.message : String(err) };
        }
      },
    },
    'crew.hire': {
      name: 'crew.hire',
      description: 'Hire a Ranger with a specialty. It is created in its department camp (the camp is created if missing) reporting to you. Name a venture only if this Ranger works on that one venture; a department head serves the whole park and takes none. Set head: true to make it the head of that department, which is who receives requests other departments send there (dept.request); appointing a head stands the previous one down. Returns the agent id to delegate to.',
      inputSchema: {
        type: 'object',
        required: ['name', 'specialty'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 60 },
          specialty: { type: 'string', enum: SPECIALTY_NAMES },
          // D179: a department is permanent and a venture passes through it, so a Ranger
          // hired to run a department takes no venture. Only a Ranger hired to work on one
          // venture names it. Requiring it meant every department head was stamped with
          // whichever venture happened to exist the day it was hired.
          venture: { type: 'string', minLength: 1, maxLength: 80, description: 'Venture id from the plan, for a Ranger working on that one venture. Leave it out for a department head or anyone whose work serves the whole park.' },
          persona: { type: 'string', maxLength: 2000, description: 'Optional extra persona; the specialty persona applies by default' },
          budgetUsd: { type: 'number', minimum: 0 },
          // D178: a department needs a head before another department can ask it for
          // anything, so hiring one is a single call rather than a hire and a patch.
          head: { type: 'boolean', description: 'Make this Ranger the head of its department (one per camp)' },
        },
      },
      confirm: false,
      async run(input, ctx) {
        try {
          const zone = await agents.ensureZone(SPECIALTIES[input.specialty].zoneKind);
          const persona = input.persona ? `${SPECIALTIES[input.specialty].persona} ${input.persona}` : undefined;
          const a = await agents.create({ name: input.name, role: 'ranger', zoneId: zone.id, parentAgentId: ctx.agentId, specialty: input.specialty, venture: input.venture, persona, budgetUsd: input.budgetUsd }, { by: ctx.agentId });
          // The head is set after the hire so the Ranger already stands in its camp, which
          // is the condition the registry checks before it will appoint one.
          let head = false;
          if (input.head) {
            await agents.update(a.id, { head: true }, { by: ctx.agentId });
            head = true;
          }
          return { ok: true, output: JSON.stringify({ agentId: a.id, name: a.name, zone: zone.id, specialty: input.specialty, ...(head ? { head: true } : {}) }) };
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
      p.deliverables.some((d) => /briefs\//.test(d)) ? 'A venture brief is among the deliverables (read it with work.check or fs.read): it carries the Scout\'s go / no-go, its evidence and the judge\'s verdict. Decide within the mission budget: go (delegate the first steps, hire if needed), no go, or more evidence; say which and why, and record it with brief.decide (the briefId is the file name under outbox/briefs/, a go names the venture it joins) so the Scout\'s estimates are scored against that venture\'s results.' : '',
      '',
      'Current plan summary: ' + (plan ? plan.summary.slice(0, 800) : '(no plan)'),
      '',
      'Decide the next move: delegate the next task(s) that can start now (use work.check if you need details), revise the plan if the result changes it (plan.read for the plan as it stands, then plan.submit with your changes applied — it replaces the whole plan, so carry the rest across unchanged), retire crew the remaining work does not need with crew.retire, or, if nothing is left to do, say so and stop. Do not re-delegate finished work.',
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
      // Safety L4: the Chief delegates from the mission budget, never past it.
      if (typeof trails.setMissionBudget === 'function') trails.setMissionBudget(() => (mission ? { budgetUsd: mission.budgetUsd, createdAt: mission.createdAt } : null));
      return this;
    },
    state: () => ({ mission: mission ? { ...mission } : null, plan: plan ? { ...plan } : null, chief: agents.get(CHIEF_ID), caps, judgeToday: ledger ? ledger.judgeToday() : null }),
    // D185: the owner cleared a blocker, so the work that was waiting on it starts again.
    // The brief says what was blocked and what the owner did, and nothing more: the Chief
    // decides what to pick up, and it may well be that the venture has moved on.
    async blockerCleared(blocker) {
      if (!blocker || !blocker.id) return null;
      const prompt = [
        `The owner has cleared a blocker: ${blocker.title}`,
        '',
        `What was blocked: ${blocker.blocking}`,
        ...(blocker.note ? ['', `What they said they did: ${blocker.note}`] : []),
        ...(blocker.ventureId ? ['', `It belonged to venture ${blocker.ventureId}.`] : []),
        `It was raised by ${blocker.raisedBy}${blocker.department ? ` in the ${blocker.department} department` : ''}.`,
        '',
        'Pick the work back up if it is still worth doing: check with work.check and venture.list what',
        'the park has moved on to, then delegate the step that was waiting. If it is no longer worth',
        'doing, say so and stop — a cleared blocker is not an instruction to resume.',
      ].join('\n');
      return startChiefRun(prompt, { budgetUsd: 1, maxTurns: 10 });
    },
    // D182: the owner approved a business, so it starts. The portfolio holds the decision
    // and the budget; this is the Chief being told to get on with it. The brief carries
    // only what the owner actually agreed to — the thesis they read and the first steps
    // they approved — so the Chief does not invent a different business from the one that
    // was approved.
    async startVenture(venture) {
      if (!venture || !venture.id) return null;
      const prompt = [
        `The owner approved a new business: ${venture.name} (${venture.id}).`,
        `They committed $${Number(venture.budgetUsd || 0).toFixed(2)} of model spend to it. Do not spend past that.`,
        '',
        'The thesis they approved:',
        venture.thesis,
        '',
        'The first steps they approved:',
        ...(venture.firstSteps || []).map((s, i) => `  ${i + 1}. ${s}`),
        ...(venture.risks && venture.risks.length ? ['', 'Risks the proposal named:', ...venture.risks.map((r) => `  · ${r}`)] : []),
        '',
        'Start it: open the camps it needs, hire or reuse Rangers (crew.hire names a venture only',
        'for a Ranger that works on this one business; a department head serves the whole park),',
        'and delegate the first step that can begin now. Stay inside the budget above, and do not',
        'widen the business beyond what the owner approved — anything bigger is a new proposal',
        'for them with venture.propose.',
      ].join('\n');
      return startChiefRun(prompt, { budgetUsd: Math.min(Number(venture.budgetUsd) || 0, 2), maxTurns: 14 });
    },
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
    // One question, one bounded tool-less run on the Chief's model; the answer resolves
    // when the run ends. `context` is reflect.gather()'s document when the caller has it.
    async ask({ question, context = null, by = 'channel' } = {}) {
      if (typeof question !== 'string' || !question.trim()) throw fail('BAD_REQUEST', 'a question is required');
      await agents.ensureChief();
      const cap = judgeCapReason();
      if (cap) throw fail('JUDGE_CAP', cap, 429);
      if (runs.activeFor(CHIEF_ID) || runs.queued().some((r) => r.agentId === CHIEF_ID)) throw fail('CONFLICT', 'the Chief Ranger is in a run; ask again when it ends', 409);
      const facts = [];
      if (mission) facts.push(`Mission ${mission.id} (${mission.status}${mission.reason ? `, ${mission.reason}` : ''}): ${mission.text.slice(0, 600)}; budget $${mission.budgetUsd.toFixed(2)}, horizon ${mission.horizon}.`);
      else facts.push('No mission has been given yet.');
      if (plan) facts.push(`Plan v${plan.version}: ${plan.summary.slice(0, 800)}`);
      if (context && typeof context === 'object') {
        if (typeof context.missionSpentUsd === 'number') facts.push(`Mission spend so far $${context.missionSpentUsd.toFixed(2)}; judge today $${context.judgeToday ? context.judgeToday.usd.toFixed(2) : '?'} of $${context.judgeCapUsd}; Gate items pending ${context.gatePending}.`);
        if (context.connectors) facts.push(`Connectors: ${context.connectors}.`);
        for (const v of context.ventures || []) facts.push(`Venture ${v.id} "${v.name}": budget $${v.budgetUsd.toFixed(2)}, spent $${v.spentUsd.toFixed(2)}; crew ${v.crew.map((c) => c.id).join(', ') || 'none'}; runs ${v.runs} (${v.runsFailed} failed); items done ${v.itemsDone}, failed ${v.itemsFailed}, open ${v.itemsOpen}; deliverables ${v.deliverables}; Gate approved ${v.gateApproved}, rejected ${v.gateRejected}, pending ${v.gatePending}; revenue ${v.revenue}.`);
      }
      facts.push(...crewLines());
      const prompt = ['RECORDED DATA:', ...facts, '', `QUESTION from the Superintendent (via ${by}): ${question.trim()}`].join('\n');
      const started = await runs.start({ agentId: CHIEF_ID, prompt, step: 'plan', budgetUsd: 1, maxTurns: 2, review: false, system: ASK_SYSTEM_PROMPT, grants: () => [] });
      chiefRuns.add(started.runId);
      const evidence = [];
      if (plan) evidence.push(`plan v${plan.version}`);
      if (mission) evidence.push(`mission ${mission.id}`);
      const answer = started.done.then((outcome) => (outcome ? { ok: outcome.reason === 'completed', reason: outcome.reason, text: outcome.finalText || '', usd: outcome.spentUsd || 0, evidence } : { ok: false, reason: 'cancelled', text: '', usd: 0, evidence })).catch((err) => ({ ok: false, reason: err.message, text: '', usd: 0, evidence }));
      return { runId: started.runId, queued: started.queued, answer };
    },
  };
}

export { CHIEF_ID };
