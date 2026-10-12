import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createStore } from '../sidecar/store.js';
import { createEventBus } from '../sidecar/bus.js';
import { createRunManager } from '../sidecar/runs.js';
import { createTrails } from '../sidecar/trails.js';
import { createChief, PLAN_SCHEMA, CHIEF_SYSTEM_PROMPT, planMarkdown } from '../sidecar/chief.js';
import { createLayoutState } from '../sidecar/server.js';
import { createAgents } from '../sidecar/agents.js';
import { createLeashLedger } from '../sidecar/leash-ledger.js';
import { createRouter, defaultPolicy } from '../sidecar/router.js';
import { TOOLS } from '../sidecar/capability/tools.js';
import { CREW_TOOLS } from '../sidecar/capability/crew.js';
import { defaultLayout, roleGrants, freeZoneRect, ZONE_LABELS } from '../shared/world.js';
import { validate } from '../shared/schema.js';
import { fakeProvider, fakeClock, text, toolCall, end } from './helpers/fake-provider.js';

const PRICE = { inputPerMTok: 4, outputPerMTok: 20 };
const PLAN = {
  summary: 'Start one venture: handmade lanterns on Etsy. Scout the niche first, then draft listings.',
  ventures: [
    {
      id: 'lantern-co',
      name: 'Lantern Co',
      summary: 'Handmade paper lanterns for weddings, sold on Etsy. Evidence: three comparable shops with 1k+ sales.',
      budgetUsd: 3,
      roles: [{ specialty: 'scout', name: 'Ada' }, { specialty: 'storefront', name: 'Ben' }],
      tasks: [
        { id: 't1', title: 'Niche research', specialty: 'scout', brief: 'Find five comparable shops and their price points.', budgetUsd: 1, evidence: ['shop URLs'] },
        { id: 't2', title: 'Draft three listings', specialty: 'storefront', brief: 'Write three original listings.', budgetUsd: 1.5, deadline: 'in 3 days', dependsOn: ['t1'] },
      ],
    },
  ],
  risks: ['Etsy fees eat margin on cheap items'],
  needsSuperintendent: ['An Etsy account (account_creation)'],
};

async function setup({ chiefScript, workerScript, policy = defaultPolicy(), judgeUsdToday = 0 } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-chief-'));
  const home = path.join(dir, 'home');
  const workspaceRoot = path.join(dir, 'ws');
  await fsp.mkdir(workspaceRoot, { recursive: true });
  const store = createStore({ root: home });
  await store.init();
  const bus = createEventBus();
  const events = [];
  bus.listen((e) => events.push(e));
  const clock = fakeClock();
  const layoutState = createLayoutState({ initial: defaultLayout(), store, bus, clock });
  const agents = createAgents({ layoutState, bus, clock });
  const ledger = await createLeashLedger({ store, clock }).init();
  if (judgeUsdToday) await ledger.recordJudge({ usd: judgeUsdToday });
  const seen = [];
  // One scripted Chief provider shared by every Chief run, so a follow-up run continues
  // the script instead of replaying the planning turns.
  const chiefProvider = fakeProvider(chiefScript(), { name: 'anthropic' });
  const makeProvider = async (name, opts) => {
    seen.push({ name, model: opts.model });
    if (name === 'anthropic') return { provider: chiefProvider, model: opts.model || 'judge', price: PRICE };
    const script = workerScript || (() => [[text('worker done'), end()]]);
    return { provider: fakeProvider(script(), { name }), model: opts.model || 'w', price: null };
  };
  const toolContext = {};
  const registry = { ...TOOLS, ...CREW_TOOLS };
  const router = createRouter(policy);
  const runs = createRunManager({ bus, store, getLayout: layoutState.get, workspaceRoot, makeProvider, clock, agents, toolContext, registry, ledger, policy, maxConcurrent: 3 });
  const trails = await createTrails({ bus, store, runs, agents, getLayout: layoutState.get, clock, workspaceRoot }).init();
  toolContext.trails = trails;
  const chief = await createChief({ bus, store, runs, agents, trails, ledger, router, getLayout: layoutState.get, clock, workspaceRoot, maxFollowUps: 2, log: { error() {} } }).init();
  Object.assign(registry, chief.tools);
  return { dir, home, workspaceRoot, store, bus, events, runs, trails, agents, chief, ledger, seen, layoutState, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

test('plan schema, markdown and zone grid helpers', () => {
  assert.equal(validate(PLAN_SCHEMA, PLAN).ok, true);
  assert.equal(validate(PLAN_SCHEMA, { ...PLAN, ventures: [] }).ok, false);
  assert.equal(validate(PLAN_SCHEMA, { ...PLAN, ventures: [{ ...PLAN.ventures[0], id: 'Bad Id' }] }).ok, false);
  const md = planMarkdown({ ...PLAN, version: 2 }, { id: 'm1', text: 'sell lanterns', budgetUsd: 5, horizon: '30 days' });
  assert.match(md, /^# Plan v2 for mission m1/);
  assert.match(md, /## Lantern Co \(lantern-co\) · \$3.00/);
  assert.match(md, /- \[t2\] Draft three listings → storefront · \$1.50 · by in 3 days · after t1/);
  assert.match(md, /## Needs the Superintendent/);
  assert.deepEqual(roleGrants('chief_ranger'), ['crew.spawn_junior', 'delegate', 'work.check', 'plan.submit', 'plan.read', 'crew.hire', 'crew.retire', 'brief.decide', 'memory.recall', 'memory.write', 'recipe.run']);
  const layout = defaultLayout();
  assert.deepEqual(freeZoneRect(layout), { x: 21, y: 1, w: 8, h: 6 }, 'to the right of the station');
  assert.deepEqual(freeZoneRect({ rooms: [{ x: 1, y: 1, w: 12, h: 8 }, { x: 21, y: 1, w: 8, h: 6 }, { x: 31, y: 1, w: 8, h: 6 }] }), { x: 41, y: 1, w: 8, h: 6 });
  assert.equal(ZONE_LABELS.research, 'Research Camp');
  assert.match(CHIEF_SYSTEM_PROMPT, /plan.submit/);
});

test('a mission runs the Chief on the plan step: plan.submit stores and writes the plan, crew.hire staffs camps, delegate starts work, work.done triggers a follow-up, judge spend is counted', async () => {
  let planCalls = 0;
  const chiefScript = () => [
    // Planning run: an over-budget plan first (rejected by the tool), then a good one, hires, delegation, status.
    [text('Planning.'), ...toolCall('p0', 'plan.submit', { ...PLAN, ventures: [{ ...PLAN.ventures[0], budgetUsd: 9 }] }), end('tool_use', { inputTokens: 1000, outputTokens: 200 })],
    [...toolCall('p1', 'plan.submit', PLAN), end('tool_use', { inputTokens: 1000, outputTokens: 200 })],
    [...toolCall('h1', 'crew.hire', { name: 'Ada', specialty: 'scout', venture: 'lantern-co' }, 0), ...toolCall('h2', 'crew.hire', { name: 'Ben', specialty: 'storefront', venture: 'lantern-co', persona: 'Prefers plain copy.' }, 1), end('tool_use', { inputTokens: 500, outputTokens: 100 })],
    (req) => {
      const hires = req.messages.at(-1).content.map((b) => JSON.parse(b.content));
      planCalls += 1;
      return [...toolCall('d1', 'delegate', { toAgentId: hires[0].agentId, brief: 'Find five comparable shops.', budgetUsd: 1, evidence: ['shop URLs'] }), end('tool_use', { inputTokens: 500, outputTokens: 100 })];
    },
    [text('Plan v1 is in motion: Ada scouts first.'), end('end_turn', { inputTokens: 300, outputTokens: 50 })],
    // Follow-up run after Ada's work.done.
    [text('Ada is done; next Ben.'), end('end_turn', { inputTokens: 300, outputTokens: 50 })],
  ];
  const h = await setup({ chiefScript });
  try {
    await assert.rejects(h.chief.mission({ text: '', budgetUsd: 5 }), /mission text is required/);
    await assert.rejects(h.chief.mission({ text: 'x', budgetUsd: -1 }), /budgetUsd/);
    assert.equal(h.chief.state().mission, null);
    const started = await h.chief.mission({ text: 'Sell handmade lanterns online.', budgetUsd: 5, horizon: '30 days' });
    assert.equal(started.mission.status, 'planning');
    assert.equal(started.queued, false);
    assert.equal(h.seen[0].name, 'anthropic', 'the Chief plans on the judge tier');
    assert.equal(h.seen[0].model, 'claude-opus-5-5', 'on the plan step model');
    assert.ok(h.agents.get('chief-ranger'), 'the Chief exists');
    await assert.rejects(h.chief.mission({ text: 'again', budgetUsd: 1 }), /already in a run/);
    await h.runs.waitForIdle();

    const planEvents = h.events.filter((e) => e.type === 'plan.updated').map((e) => e.payload);
    assert.deepEqual(planEvents.map((p) => [p.change, p.status]), [['status', 'planning'], ['submitted', 'active']]);
    assert.equal(planEvents[1].version, 1);
    assert.deepEqual(planEvents[1].ventures, [{ id: 'lantern-co', name: 'Lantern Co', budgetUsd: 3, taskCount: 2, summary: PLAN.ventures[0].summary.slice(0, 200) }]);
    const rejected = h.events.find((e) => e.type === 'agent.tool_result' && e.payload.callId === 'p0').payload;
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /over the mission budget/);
    const st = h.chief.state();
    assert.equal(st.mission.status, 'active');
    assert.equal(st.plan.version, 1);
    assert.equal(st.plan.by, 'chief-ranger');
    assert.deepEqual(JSON.parse(await fsp.readFile(path.join(h.home, 'plan.json'), 'utf8')).ventures[0].id, 'lantern-co');
    assert.match(await fsp.readFile(path.join(h.workspaceRoot, 'chief-ranger', 'outbox', 'plan-v1.md'), 'utf8'), /# Plan v1 for mission/);

    // Staffing: camps were created and Rangers hired under the Chief with specialty personas.
    const layout = h.layoutState.get();
    assert.deepEqual(layout.rooms.map((r) => r.kind), ['ranger_station', 'mountain_peak', 'trailhead', 'research', 'product_listings']);
    const trailhead = layout.rooms.find((r) => r.kind === 'trailhead');
    assert.deepEqual([trailhead.id, trailhead.venture, trailhead.name, trailhead.w], ['trailhead-lantern-co', 'lantern-co', 'Lantern Co Trailhead', 4]);
    const ada = layout.agents.find((a) => a.name === 'Ada');
    const ben = layout.agents.find((a) => a.name === 'Ben');
    assert.equal(ada.roomId, 'research');
    assert.equal(ada.parentAgentId, 'chief-ranger');
    assert.equal(ada.venture, 'lantern-co');
    assert.match(ben.persona, /Prefers plain copy\./);
    assert.equal(ben.roomId, 'product-listings');

    // Delegation went along the trail and Ada's run finished; the Chief followed up once.
    const handoff = h.events.find((e) => e.type === 'work.handoff').payload;
    assert.equal(handoff.toAgentId, ada.id);
    assert.equal(handoff.fromRoomId, 'mountain-peak');
    const done = h.events.find((e) => e.type === 'work.done').payload;
    assert.equal(done.status, 'done');
    assert.equal(done.summary, 'worker done');
    const chiefRuns = h.events.filter((e) => e.type === 'agent.run.start' && e.payload.agentId === 'chief-ranger');
    assert.equal(chiefRuns.length, 2, 'planning run + one follow-up');
    assert.match(chiefRuns[1].payload.prompt, /has finished: done/);
    assert.match(chiefRuns[1].payload.prompt, /Summary from the Ranger: worker done/);
    assert.equal(h.chief.state().mission.followUps, 1);
    assert.deepEqual(h.chief.state().mission.runIds.length, 2);
    // The Chief's runs are judge-tier spend: counted in the ledger, no judge review of the Chief.
    const chiefCost = h.events.filter((e) => e.type === 'cost.estimate' && e.payload.tier === 'judge');
    assert.ok(chiefCost.length >= 6);
    assert.ok(h.ledger.judgeToday().usd > 0);
    assert.equal(h.events.filter((e) => e.type === 'judge.verdict').length, 0);
    assert.equal(h.events.filter((e) => e.type === 'cost.estimate' && e.payload.runId === chiefRuns[0].payload.runId).length, 5);
    const spend = await h.store.loadSpend();
    assert.ok(Math.abs(spend.totalUsd - h.ledger.judgeToday().usd) < 1e-9, 'spend.json counts the Chief once');
    assert.equal(h.events.find((e) => e.type === 'agent.run.start' && e.payload.agentId === 'chief-ranger').payload.tools.includes('plan.submit'), true);
    assert.equal(h.events.find((e) => e.type === 'agent.run.start' && e.payload.agentId === ada.id).payload.tools.includes('plan.submit'), false, 'Rangers do not plan');

    // A second mission re-briefs with the previous plan; the plan version grows.
    const h2script = () => [[...toolCall('p2', 'plan.submit', { ...PLAN, summary: 'Revised: lanterns plus candles.' }), end('tool_use', { inputTokens: 10, outputTokens: 5 })], [text('ok'), end()]];
    const first = h.seen.length;
    void first;
    h.chief.tools; // keep closure
    const m2 = await (async () => {
      // swap the chief script by re-pointing makeProvider's script through a new harness is heavy; instead reuse: push a new mission with same provider factory scripts exhausted → fake throws, so use the second harness below
      return null;
    })();
    void m2;
    const again = await setup({ chiefScript: h2script });
    try {
      await again.store.savePlan({ ...h.chief.state().plan });
      const chief2 = again.chief;
      await chief2.init();
      assert.equal(chief2.state().plan.version, 1, 'a plan survives a restart');
      await chief2.mission({ text: 'Add candles.', budgetUsd: 4 });
      await again.runs.waitForIdle();
      assert.equal(chief2.state().plan.version, 2);
      assert.equal(chief2.state().plan.history.length, 1);
      assert.match(again.events.find((e) => e.type === 'agent.run.start').payload.prompt, /A previous plan exists \(v1\)/);
    } finally {
      await again.cleanup();
    }
  } finally {
    await h.cleanup();
  }
});

test('at the judge daily cap the mission pauses instead of spending; the follow-up cap pauses too; no key pauses with the reason', async () => {
  const policy = defaultPolicy();
  policy.caps.judgeUsdPerDay = 1;
  const h = await setup({ chiefScript: () => [[text('never'), end()]], policy, judgeUsdToday: 1 });
  try {
    const r = await h.chief.mission({ text: 'Sell lanterns.', budgetUsd: 5 });
    assert.equal(r.runId, null);
    assert.equal(r.mission.status, 'paused');
    assert.match(r.mission.reason, /judge daily cap reached: \$1.00 of \$1/);
    assert.equal(h.events.filter((e) => e.type === 'agent.run.start').length, 0);
    assert.deepEqual(h.events.filter((e) => e.type === 'plan.updated').map((e) => e.payload.status), ['planning', 'paused']);
  } finally {
    await h.cleanup();
  }
  const h2 = await setup({ chiefScript: () => [[text('plan later'), end()], [text('follow 1'), end()], [text('follow 2'), end()]] });
  try {
    await h2.chief.mission({ text: 'x', budgetUsd: 1 });
    await h2.runs.waitForIdle();
    for (let i = 0; i < 3; i++) {
      await h2.chief.followUp({ payload: { workItemId: 'w', toAgentId: 'ranger', status: 'done', deliverables: [], summary: 's', spentUsd: 0 } });
      await h2.runs.waitForIdle();
    }
    assert.equal(h2.chief.state().mission.followUps, 2);
    assert.equal(h2.chief.state().mission.status, 'paused');
    assert.match(h2.chief.state().mission.reason, /follow-up cap reached: 2/);
  } finally {
    await h2.cleanup();
  }
  const nokey = await setup({ chiefScript: () => [] });
  try {
    nokey.seen; // provider factory throws for anthropic below
    const broken = await createChief({ bus: nokey.bus, store: nokey.store, runs: { ...nokey.runs, start: async () => { const e = new Error('no API key for anthropic'); e.code = 'NO_KEY'; throw e; } }, agents: nokey.agents, trails: nokey.trails, router: createRouter(defaultPolicy()), getLayout: nokey.layoutState.get, workspaceRoot: nokey.workspaceRoot }).init();
    await assert.rejects(broken.mission({ text: 'x', budgetUsd: 1 }), (e) => e.code === 'NO_KEY');
  } finally {
    await nokey.cleanup();
  }
});

// D176: the Chief could submit a plan but never read one back, and could hire but never
// retire. Both gaps showed up live: asked to revise plan v2, the Chief refused rather than
// overwrite real venture budgets with remembered ones, and it could see twelve Rangers on
// one $2.50 venture without being able to do anything about it.
test('plan.read returns the stored plan so a revision is an edit, and crew.retire undoes a hire', async () => {
  // The mission run itself does nothing here: the tools are driven directly below so each
  // guard is checked on its own.
  const s = await setup({ chiefScript: () => [[text('noted'), end()]] });
  try {
    const read = s.chief.tools['plan.read'];
    const submit = s.chief.tools['plan.submit'];
    const retire = s.chief.tools['crew.retire'];
    const hire = s.chief.tools['crew.hire'];
    const ctx = { agentId: 'chief-ranger', runId: 'r-test' };

    // Before a mission there is nothing to read, and the tool says so instead of inventing one.
    assert.equal((await read.run({}, ctx)).ok, false);

    await s.chief.mission({ text: 'sell lanterns', budgetUsd: 5, horizon: '30 days' });
    // A mission with no plan yet is still not a plan: no empty skeleton comes back.
    const none = await read.run({}, ctx);
    assert.equal(none.ok, false);
    assert.match(none.error, /no plan has been submitted/);

    assert.equal((await submit.run(PLAN, ctx)).ok, true);
    const got = await read.run({}, ctx);
    assert.equal(got.ok, true);
    const out = JSON.parse(got.output);
    // The whole plan, not a summary: this is the shape plan.submit takes back.
    assert.equal(out.version, 1);
    assert.deepEqual(out.ventures, PLAN.ventures, 'every venture, task and budget comes back intact');
    assert.equal(out.summary, PLAN.summary);
    assert.equal(out.missionBudgetUsd, 5, 'and the ceiling a revision has to stay under');

    // The point of reading: a revision that changes one field keeps the rest exactly.
    const revised = { ...out.ventures[0], name: 'Lantern Co (revised)' };
    assert.equal((await submit.run({ summary: out.summary, ventures: [revised, ...out.ventures.slice(1)] }, ctx)).ok, true);
    const v2 = JSON.parse((await read.run({}, ctx)).output);
    assert.equal(v2.version, 2);
    assert.equal(v2.ventures[0].name, 'Lantern Co (revised)');
    assert.deepEqual(v2.ventures[0].tasks, PLAN.ventures[0].tasks, 'the tasks were not re-guessed');
    assert.equal(v2.history.length, 1, 'and v1 is still on the record');

    // crew.retire: hire one, retire it, and it is gone from the park.
    const hired = JSON.parse((await hire.run({ name: 'Surplus', specialty: 'scout', venture: 'lantern-co' }, ctx)).output);
    assert.ok(s.agents.get(hired.agentId), 'hired');
    const bye = await retire.run({ agentId: hired.agentId, reason: 'more scouts than the work needs' }, ctx);
    assert.equal(bye.ok, true);
    assert.equal(JSON.parse(bye.output).retired, hired.agentId);
    assert.ok(!s.agents.get(hired.agentId), 'retired for real');
    assert.ok(s.events.some((e) => e.type === 'crew.agent' && e.payload.change === 'removed' && e.payload.agentId === hired.agentId), 'and it is on the record');

    // The guards. The Chief may not retire itself, however it names itself.
    assert.equal((await retire.run({ agentId: 'chief-ranger' }, ctx)).ok, false);
    assert.equal((await retire.run({ agentId: ctx.agentId }, ctx)).ok, false);
    // A Ranger with reports is refused rather than orphaning them.
    const parent = JSON.parse((await hire.run({ name: 'Parent', specialty: 'scout', venture: 'lantern-co' }, ctx)).output);
    const child = await s.agents.create({ name: 'Junior', role: 'junior_ranger', parentAgentId: parent.agentId, zoneId: 'ranger-station' }, { by: 'chief-ranger' });
    const refused = await retire.run({ agentId: parent.agentId }, ctx);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /reports/);
    assert.ok(s.agents.get(parent.agentId), 'still there');
    // An id that was never an agent is an error, not a silent success.
    assert.equal((await retire.run({ agentId: 'not-an-agent' }, ctx)).ok, false);
    assert.ok(child.id);
  } finally {
    await s.cleanup();
  }
});
