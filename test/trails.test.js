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
import { CREW_TOOLS } from '../sidecar/capability/crew.js';
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
    assert.deepEqual(roleGrants('chief_ranger'), ['crew.spawn_junior', 'delegate', 'work.check', 'plan.submit', 'crew.hire', 'brief.decide', 'memory.recall', 'memory.write']);
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
    // Allow the write (permission prompt) so the deliverable lands.
    const prompt = await waitUntil(() => h.events.find((e) => e.type === 'permission.prompt' && e.payload.runId === item.runId));
    h.runs.answer({ promptId: prompt.payload.promptId, runId: item.runId, allow: true });
    await h.runs.waitForIdle();
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
    const prompt2 = await waitUntil(() => h.events.find((e) => e.type === 'permission.prompt' && e.payload.runId === out.runId));
    h.runs.answer({ promptId: prompt2.payload.promptId, runId: out.runId, allow: false });
    releaseHold();
    await holding;
    await h.runs.waitForIdle();
    const mine = JSON.parse((await CREW_TOOLS['work.check'].run({}, ctx('mark'))).output);
    assert.deepEqual(mine.map((it) => [it.to, it.status]), [['jr', 'done'], ['mark', 'done']]);
    const one = JSON.parse((await CREW_TOOLS['work.check'].run({ workItemId: out.workItemId }, ctx('jr'))).output);
    assert.equal(one.deliverables.length, 0, 'the denied write produced no deliverable');
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
