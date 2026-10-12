import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createStore } from '../sidecar/store.js';
import { createEventBus } from '../sidecar/bus.js';
import { createRunManager } from '../sidecar/runs.js';
import { createTrails, briefFor } from '../sidecar/trails.js';
import { createLayoutState } from '../sidecar/server.js';
import { createAgents } from '../sidecar/agents.js';
import { CREW_TOOLS, deptDirectory, deptRequest } from '../sidecar/capability/crew.js';
import { defaultLayout, roleGrants } from '../shared/world.js';
import { fakeProvider, fakeClock, text, toolCall, end, waitUntil } from './helpers/fake-provider.js';

async function setup({ maxConcurrent = 2, scripts = {} } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-trails-'));
  const home = path.join(dir, 'home');
  const workspaceRoot = path.join(dir, 'ws');
  await fsp.mkdir(workspaceRoot, { recursive: true });
  const store = createStore({ root: home });
  await store.init();
  const bus = createEventBus();
  const events = [];
  bus.listen((e) => events.push(e));
  const clock = fakeClock();
  const layout = defaultLayout();
  layout.objects.push({ id: 'sc', kind: 'supply_cache', roomId: 'ranger-station', x: 2, y: 2 });
  layout.rooms.push({ id: 'mountain-peak', name: 'Mountain Peak', kind: 'mountain_peak', x: 0, y: 0, w: 2, h: 2 });
  layout.rooms.push({ id: 'camp', name: 'Camp', kind: 'marketing', x: 20, y: 1, w: 6, h: 6 });
  layout.objects.push({ id: 'sc2', kind: 'supply_cache', roomId: 'camp', x: 22, y: 2 });
  layout.agents.push({ id: 'chief-ranger', name: 'Chief', roomId: 'mountain-peak', x: 0, y: 0, role: 'chief_ranger' });
  layout.agents.push({ id: 'mark', name: 'Mark', roomId: 'camp', x: 20, y: 1, role: 'ranger', parentAgentId: 'chief-ranger' });
  layout.agents.push({ id: 'jr', name: 'Jr', roomId: 'camp', x: 21, y: 1, role: 'junior_ranger', parentAgentId: 'mark' });
  layout.agents.push({ id: 'jr2', name: 'Jr2', roomId: 'ranger-station', x: 4, y: 4, role: 'junior_ranger', parentAgentId: 'ranger' });
  const layoutState = createLayoutState({ initial: layout, store, bus, clock });
  const providers = [];
  const makeProvider = async (name, opts) => {
    const script = scripts[opts.agentHint] || scripts.default || (() => [[text('ok'), end()]]);
    const p = fakeProvider(script(), { name });
    providers.push(p);
    return { provider: p, model: 'm', price: null };
  };
  const agents = createAgents({ layoutState, bus, clock });
  const toolContext = {};
  const runs = createRunManager({ bus, store, getLayout: layoutState.get, workspaceRoot, makeProvider, clock, agents, toolContext, maxConcurrent, permissionTimeoutMs: 50 });
  const trails = await createTrails({ bus, store, runs, agents, getLayout: layoutState.get, clock, workspaceRoot }).init();
  // What the Chief module wires in production (safety L4): the Chief delegates from the mission budget.
  trails.setMissionBudget(() => ({ budgetUsd: 100, createdAt: 0 }));
  toolContext.trails = trails;
  const cleanup = async () => {
    runs.cancel();
    await runs.waitForIdle();
    await trails.flushed();
    for (let i = 0; i < 5; i++) {
      try {
        await fsp.rm(dir, { recursive: true, force: true });
        return;
      } catch (err) {
        if (err.code !== 'ENOTEMPTY') throw err;
        await new Promise((r) => setTimeout(r, 20));
      }
    }
  };
  return { dir, home, workspaceRoot, store, bus, events, clock, runs, trails, agents, layoutState, providers, cleanup };
}

test('run manager: one run per agent, global cap, FIFO start, cancel of queued and active, waitForIdle', async () => {
  const holds = [];
  const h = await setup({ maxConcurrent: 2, scripts: { default: () => [[text('a'), async () => { await new Promise((r) => holds.push(r)); }, text('b'), end()]] } });
  try {
    const r1 = await h.runs.start({ agentId: 'ranger', prompt: 'one' });
    const r2 = await h.runs.start({ agentId: 'ranger', prompt: 'two' });
    const r3 = await h.runs.start({ agentId: 'mark', prompt: 'three' });
    const r4 = await h.runs.start({ agentId: 'jr', prompt: 'four' });
    assert.deepEqual([r1.queued, r2.queued, r3.queued, r4.queued], [false, true, false, true]);
    assert.deepEqual(h.runs.active().map((r) => r.agentId), ['ranger', 'mark']);
    assert.deepEqual(h.runs.queued().map((r) => [r.runId, r.position]), [[r2.runId, 0], [r4.runId, 1]]);
    assert.equal(h.runs.activeFor('ranger').runId, r1.runId);
    assert.equal(h.events.filter((e) => e.type === 'agent.run.queued').length, 2);
    assert.equal((await h.store.loadRun(r2.runId)).status, 'queued');
    assert.equal(h.runs.cancel(r2.runId), true, 'cancel a queued run');
    await waitUntil(() => h.events.some((e) => e.type === 'agent.run.end' && e.payload.runId === r2.runId));
    assert.equal(h.events.at(-1).type, 'agent.run.end');
    assert.equal(h.events.at(-1).payload.runId, r2.runId);
    assert.equal(h.runs.queued().length, 1);
    holds.forEach((r) => r());
    await r1.done;
    await waitUntil(() => h.events.some((e) => e.type === 'agent.run.start' && e.payload.runId === r4.runId));
    assert.ok(h.runs.active().some((r) => r.runId === r4.runId) || h.events.some((e) => e.type === 'agent.run.start' && e.payload.runId === r4.runId), 'the queued jr run started when a slot freed');
    holds.splice(0).forEach((r) => r());
    await h.runs.waitForIdle();
    assert.deepEqual(h.runs.active(), []);
    assert.deepEqual(h.runs.queued(), []);
    const ends = h.events.filter((e) => e.type === 'agent.run.end').map((e) => e.payload.reason);
    assert.deepEqual(ends.sort(), ['cancelled', 'completed', 'completed', 'completed']);
    assert.equal(h.runs.cancel('nope'), false);
    await assert.rejects(h.runs.start({ agentId: 'ranger', prompt: 'x', maxTurns: 0 }), /maxTurns/);
    await assert.rejects(h.runs.start({ agentId: 'ranger', prompt: 'x', budgetUsd: -1 }), /budgetUsd/);
    // cancel() with no id empties everything.
    const r5 = await h.runs.start({ agentId: 'ranger', prompt: 'five' });
    const r6 = await h.runs.start({ agentId: 'ranger', prompt: 'six' });
    assert.equal(h.runs.cancel(), true);
    await h.runs.waitForIdle();
    assert.deepEqual([(await h.store.loadRun(r5.runId)).reason, (await h.store.loadRun(r6.runId)).reason], ['cancelled', 'cancelled']);
  } finally {
    await h.cleanup();
  }
});

test('trails: delegation rules, briefs, work.handoff → run → work.done with outbox deliverables, work.check and delegate tools, persistence', async () => {
  // A run whose prompt is 'hold' stays open until released: Mark delegates from inside it (safety L4: a Ranger delegates from its active run).
  let releaseHold;
  const hold = new Promise((r) => { releaseHold = r; });
  const h = await setup({
    maxConcurrent: 3,
    scripts: {
      default: () => [(request) => (request.messages[0] && request.messages[0].content === 'hold' ? hold.then(() => [text('held'), end()]) : [text('writing'), ...toolCall('c1', 'fs.write', { path: 'outbox/plan.md', content: '# plan' }), end('tool_use')]), [text('plan written'), end()]],
    },
  });
  try {
    assert.deepEqual(roleGrants('chief_ranger'), ['crew.spawn_junior', 'delegate', 'work.check', 'plan.submit', 'plan.read', 'crew.hire', 'crew.retire', 'crew.set_head', 'brief.decide', 'memory.recall', 'memory.write', 'recipe.run', 'dept.directory', 'dept.request']);
    await assert.rejects(h.trails.delegate({ toAgentId: 'mark', brief: 'x' }, {}), /needs a delegating agent/);
    await assert.rejects(h.trails.delegate({ toAgentId: 'mark', brief: '' }, { by: 'chief-ranger' }), /brief is required/);
    await assert.rejects(h.trails.delegate({ toAgentId: 'ghost', brief: 'x' }, { by: 'chief-ranger' }), /unknown receiver/);
    await assert.rejects(h.trails.delegate({ toAgentId: 'mark', brief: 'x' }, { by: 'ghost' }), /unknown delegator/);
    await assert.rejects(h.trails.delegate({ toAgentId: 'mark', brief: 'x' }, { by: 'jr' }), /Junior Rangers cannot delegate/);
    await assert.rejects(h.trails.delegate({ toAgentId: 'chief-ranger', brief: 'x' }, { by: 'mark' }), /not delegated to the Chief/);
    await assert.rejects(h.trails.delegate({ toAgentId: 'jr2', brief: 'x' }, { by: 'mark' }), /not mark's Junior/);
    await assert.rejects(h.trails.delegate({ toAgentId: 'mark', brief: 'x' }, { by: 'mark' }), /itself/);
    await assert.rejects(h.trails.delegate({ toAgentId: 'mark', brief: 'x', budgetUsd: -1 }, { by: 'chief-ranger' }), /budgetUsd/);
    await assert.rejects(h.trails.delegate({ toAgentId: 'mark', brief: 'x', evidence: [1] }, { by: 'chief-ranger' }), /evidence/);

    // The Chief hands Mark a brief; the mailbox of events shows the trail.
    await fsp.mkdir(path.join(h.workspaceRoot, 'mark', 'outbox'), { recursive: true });
    await fsp.writeFile(path.join(h.workspaceRoot, 'mark', 'outbox', 'old.md'), 'before');
    const item = await h.trails.delegate({ toAgentId: 'mark', brief: 'Write the launch plan', budgetUsd: 0.3, deadline: 'Friday', evidence: ['numbers from the ledger'] }, { by: 'chief-ranger' });
    assert.equal(item.status, 'running');
    assert.equal(item.trailId, 'trail:mountain-peak:camp');
    assert.equal(item.queued, false);
    const handoff = h.events.find((e) => e.type === 'work.handoff');
    assert.deepEqual(handoff.payload, { fromAgentId: 'chief-ranger', toAgentId: 'mark', fromRoomId: 'mountain-peak', toRoomId: 'camp', trailId: 'trail:mountain-peak:camp', workItemId: item.id, summary: 'Write the launch plan' });
    const start = await waitUntil(() => h.events.find((e) => e.type === 'agent.run.start' && e.payload.agentId === 'mark'));
    assert.equal(start.payload.prompt, briefFor({ ...item, budgetUsd: 0.3 }));
    assert.match(start.payload.prompt, /Deadline: Friday/);
    assert.deepEqual(h.trails.inTransit().map((it) => it.id), [item.id]);
    // D180: the deliverable lands on its own — no prompt to answer, which is what lets a
    // standing duty run overnight.
    await h.runs.waitForIdle();
    assert.equal(h.events.filter((e) => e.type === 'permission.prompt').length, 0);
    const done = h.events.find((e) => e.type === 'work.done');
    assert.deepEqual(done.payload, { workItemId: item.id, fromAgentId: 'chief-ranger', toAgentId: 'mark', runId: item.runId, status: 'done', reason: 'completed', deliverables: ['outbox/plan.md'], summary: 'plan written', spentUsd: 0 });
    assert.equal(h.trails.get(item.id).status, 'done');
    assert.deepEqual(h.trails.forAgent('mark').map((it) => it.id), [item.id]);
    assert.deepEqual(h.trails.forAgent('chief-ranger').map((it) => it.id), [item.id]);

    // Tools: delegate from Mark to its Junior; work.check from both sides; a stranger is refused.
    const ctx = (agentId) => ({ agentId, trails: h.trails, runId: 'r' });
    const idle = await CREW_TOOLS.delegate.run({ toAgentId: 'jr', brief: 'Draft three captions', budgetUsd: 0.1 }, ctx('mark'));
    assert.match(idle.error, /no budget to delegate from/, 'outside a run a Ranger has nothing to delegate from (safety L4)');
    const holding = h.runs.start({ agentId: 'mark', prompt: 'hold', budgetUsd: 1 });
    await waitUntil(() => h.runs.activeFor('mark'));
    const d = await CREW_TOOLS.delegate.run({ toAgentId: 'jr', brief: 'Draft three captions', budgetUsd: 0.1 }, ctx('mark'));
    assert.equal(d.ok, true, d.error);
    const out = JSON.parse(d.output);
    assert.equal(out.budgetUsd, 0.1, 'within the run\'s budget, so not capped');
    assert.equal(out.toAgentId, 'jr');
    assert.equal(out.status, 'running');
    const refused = await CREW_TOOLS.delegate.run({ toAgentId: 'mark', brief: 'x' }, ctx('jr'));
    assert.match(refused.error, /cannot delegate/);
    releaseHold();
    await holding;
    await h.runs.waitForIdle();
    const mine = JSON.parse((await CREW_TOOLS['work.check'].run({}, ctx('mark'))).output);
    assert.deepEqual(mine.map((it) => [it.to, it.status]), [['jr', 'done'], ['mark', 'done']]);
    const one = JSON.parse((await CREW_TOOLS['work.check'].run({ workItemId: out.workItemId }, ctx('jr'))).output);
    // D180: this write used to be denied by nobody answering its card, so the Junior's
    // work item carried no deliverable. It lands now, which is the whole point.
    assert.equal(one.deliverables.length, 1, 'the Junior\'s write landed without anyone being asked');
    assert.match((await CREW_TOOLS['work.check'].run({ workItemId: out.workItemId }, ctx('ranger'))).error, /not yours/);
    assert.match((await CREW_TOOLS['work.check'].run({ workItemId: 'nope' }, ctx('ranger'))).error, /no work item/);
    assert.match((await CREW_TOOLS['work.check'].run({}, { agentId: 'x' })).error, /no trails/);

    // A failing receiver: the item fails with the reason; cancel of a running item; persistence and restart.
    const h2 = await setup({ scripts: { default: () => [() => { const e = new Error('upstream'); e.code = 'HTTP_500'; throw e; }] } });
    try {
      const it = await h2.trails.delegate({ toAgentId: 'mark', brief: 'fail' }, { by: 'chief-ranger' });
      await h2.runs.waitForIdle();
      const d2 = h2.events.find((e) => e.type === 'work.done');
      assert.deepEqual([d2.payload.status, d2.payload.reason, d2.payload.summary], ['failed', 'error', 'upstream']);
      await assert.rejects(h2.trails.cancel(it.id), /already failed/);
      await assert.rejects(h2.trails.cancel('nope'), (e) => e.status === 404);
      await h2.trails.flushed();
      const onDisk = JSON.parse(await fsp.readFile(path.join(h2.home, 'work-items.json'), 'utf8'));
      assert.equal(onDisk.items[0].status, 'failed');
      // Simulate a restart with an item left running.
      onDisk.items[0].status = 'running';
      await h2.store.saveWorkItems(onDisk);
      const again = await createTrails({ bus: h2.bus, store: h2.store, runs: h2.runs, getLayout: h2.layoutState.get, workspaceRoot: h2.workspaceRoot }).init();
      assert.equal(again.get(it.id).status, 'failed');
      assert.equal(again.get(it.id).reason, 'sidecar restarted');
    } finally {
      await h2.cleanup();
    }
  } finally {
    await h.cleanup();
  }
});

test('pause: a paused agent gets no new runs, cancelFor stops its active and queued runs, resume restores it', async () => {
  const holds = [];
  const h = await setup({ maxConcurrent: 2, scripts: { default: () => [[text('a'), async () => { await new Promise((r) => holds.push(r)); }, text('b'), end()]] } });
  try {
    const r1 = await h.runs.start({ agentId: 'mark', prompt: 'one' });
    const r2 = await h.runs.start({ agentId: 'mark', prompt: 'two' });
    assert.equal(r2.queued, true);
    await h.agents.setPaused('mark', true);
    assert.equal(h.agents.get('mark').paused, true);
    assert.equal(h.events.at(-1).payload.agent.paused, true, 'crew.agent carries the pause');
    assert.equal(h.runs.cancelFor('mark'), 2);
    await h.runs.waitForIdle();
    assert.deepEqual([(await h.store.loadRun(r1.runId)).reason, (await h.store.loadRun(r2.runId)).reason], ['cancelled', 'cancelled']);
    await assert.rejects(h.runs.start({ agentId: 'mark', prompt: 'three' }), (e) => e.code === 'AGENT_PAUSED');
    await assert.rejects(h.trails.delegate({ toAgentId: 'mark', brief: 'x' }, { by: 'chief-ranger' }), (e) => e.code === 'AGENT_PAUSED');
    assert.equal(h.trails.list()[0].status, 'failed');
    await h.agents.setPaused('mark', false);
    assert.equal('paused' in h.layoutState.get().agents.find((a) => a.id === 'mark'), false);
    holds.splice(0); // the cancelled runs' holds are dead; wait for the new run's own
    const r3 = await h.runs.start({ agentId: 'mark', prompt: 'three' });
    await waitUntil(() => holds.length >= 1);
    holds.splice(0).forEach((r) => r());
    await h.runs.waitForIdle();
    assert.equal((await h.store.loadRun(r3.runId)).reason, 'completed');
    assert.equal(h.runs.cancelFor('nobody'), 0);
    await assert.rejects(h.agents.setPaused('ghost', true), (e) => e.status === 404);
  } finally {
    await h.cleanup();
  }
});

// D178: "if any problems or need anything, it goes through the departments". A Ranger that
// needs something asks a department, not a person: the request lands with that
// department's head, who triages it and assigns it to the team. Before this, a Ranger had
// to already know the agent id of whoever could help.
test('a request addressed to a department reaches its head, who can assign it onward', async () => {
  const h = await setup();
  try {
    // The marketing camp from the harness gets a head; a second camp is opened for finance
    // so there are two departments to route between.
    await h.agents.update('mark', { specialty: 'marketing', head: true }, { by: 'chief-ranger' });
    const finance = await h.agents.ensureZone('finance');
    const books = await h.agents.create({ name: 'Books', role: 'ranger', zoneId: finance.id, specialty: 'books', parentAgentId: 'chief-ranger' }, { by: 'chief-ranger' });
    const helper = await h.agents.create({ name: 'Helper', role: 'junior_ranger', zoneId: finance.id, parentAgentId: books.id }, { by: 'chief-ranger' });

    const ctx = { agentId: 'mark', agents: h.agents, trails: h.trails };

    // The directory says what exists, who answers, and plainly which camps are unbuilt.
    const dir = JSON.parse((await deptDirectory.run({}, ctx)).output);
    assert.equal(dir.yours, 'marketing', 'a Ranger knows its own department');
    const byKind = Object.fromEntries(dir.departments.map((d) => [d.department, d]));
    assert.equal(byKind.marketing.head, 'Mark (mark)');
    assert.equal(byKind.marketing.camp, 'camp');
    assert.equal(byKind.finance.camp, 'finance');
    assert.equal(byKind.finance.head, null, 'finance has Rangers but no head yet');
    assert.equal(byKind.sales.camp, 'not built yet', 'and an unbuilt camp says so rather than reading empty');
    assert.equal(byKind.marketing.folder, '_teams/marketing/');
    assert.deepEqual(byKind.marketing.teams, ['ads', 'marketing'], 'one camp can house two teams');

    // A department with Rangers but no head cannot take a request, and the error says to
    // appoint one rather than leaving the caller to retry.
    const headless = await deptRequest.run({ department: 'finance', need: 'what did we spend on ads last week?' }, ctx);
    assert.equal(headless.ok, false);
    assert.match(headless.error, /no head/);
    assert.match(headless.error, /Chief Ranger/);

    // An unbuilt camp is refused differently: it needs opening, not staffing.
    const unbuilt = await deptRequest.run({ department: 'legal', need: 'may we say "non-toxic"?' }, ctx);
    assert.equal(unbuilt.ok, false);
    assert.match(unbuilt.error, /has not been built yet/);

    // Give finance a head. A request still needs a run to be delegated from: a Ranger
    // spends its own run's budget, which is what safety L4 bounds (the Chief spends the
    // mission's). Outside a run the tool says so rather than opening unfunded work.
    await h.agents.update(books.id, { head: true }, { by: 'chief-ranger' });
    const unfunded = await deptRequest.run({ department: 'finance', need: 'anything' }, ctx);
    assert.equal(unfunded.ok, false);
    assert.match(unfunded.error, /no budget to delegate from/);

    // Inside a run it goes through. The Ranger's own run is what pays for it.
    const asking = await h.runs.start({ agentId: 'mark', prompt: 'set the budget', budgetUsd: 2 });
    const sent = await deptRequest.run({
      department: 'finance',
      need: 'I need last week\'s ad spend to set this month\'s budget.',
      budgetUsd: 0.25,
      evidence: ['the figure with the date range it covers'],
    }, { ...ctx, runId: asking.runId });
    assert.equal(sent.ok, true, sent.error);
    const out = JSON.parse(sent.output);
    assert.equal(out.toAgentId, books.id, 'it went to the head, not to the Junior');
    assert.equal(out.department, 'finance');
    assert.equal(out.triagedBy, 'head');

    // The brief the head receives says it is the head and that it may assign the work on.
    const item = h.trails.get(out.workItemId);
    assert.match(item.brief, /Request from mark \(Marketing Camp\) to the Finance Camp/);
    assert.match(item.brief, /You are the head of this department/);
    assert.match(item.brief, /assign it to one of your team with delegate/);
    assert.match(item.brief, /last week's ad spend/);
    assert.match(item.brief, /the figure with the date range it covers/);
    assert.match(item.brief, /_teams\/finance\//, 'and where to keep what the department should keep');

    // A head asking its own department is told to handle it rather than looping to itself,
    // and that check comes before any budget question.
    const self = await deptRequest.run({ department: 'finance', need: 'anything' }, { ...ctx, agentId: books.id });
    assert.equal(self.ok, false);
    assert.match(self.error, /you head the Finance Camp/);

    // One head per camp: appointing another stands the first down.
    const second = await h.agents.create({ name: 'Books2', role: 'ranger', zoneId: finance.id, specialty: 'books', parentAgentId: 'chief-ranger' }, { by: 'chief-ranger' });
    await h.agents.update(second.id, { head: true }, { by: 'chief-ranger' });
    assert.equal(h.agents.get(books.id).head, undefined, 'the previous head stood down');
    assert.equal(h.agents.get(second.id).head, true);
    const after = JSON.parse((await deptDirectory.run({ department: 'finance' }, ctx)).output);
    assert.equal(after.departments.length, 1, 'asking for one department answers for one');
    assert.match(after.departments[0].head, new RegExp(second.id));

    // Only a Ranger standing in a department camp can head one. A Junior and the Chief
    // both fail on their role; a Ranger at the Ranger Station fails on its camp, because
    // the Station is the park's own HQ and not a department.
    await assert.rejects(h.agents.update(helper.id, { head: true }, { by: 'chief-ranger' }), /only a Ranger can head/);
    await assert.rejects(h.agents.update('chief-ranger', { head: true }, { by: 'chief-ranger' }), /only a Ranger can head/);
    await assert.rejects(h.agents.update('ranger', { head: true }, { by: 'chief-ranger' }), /does not stand in a department camp/);
    // Standing a head down is always allowed and leaves the camp headless.
    await h.agents.update(second.id, { head: false }, { by: 'chief-ranger' });
    assert.equal(h.agents.get(second.id).head, undefined);
    assert.equal(JSON.parse((await deptDirectory.run({ department: 'finance' }, ctx)).output).departments[0].head, null);
  } finally {
    await h.cleanup();
  }
});
