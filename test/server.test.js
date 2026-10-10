import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { startTestServer } from './helpers/test-server.js';
import { fakeProvider, text, toolCall, end } from './helpers/fake-provider.js';
import { validateEvent } from '../shared/events.js';
import { boot } from '../sidecar/index.js';
import os from 'node:os';
import { startFakeCloudflare } from './helpers/fake-cloudflare.js';
import { startFakeResend } from './helpers/fake-resend.js';

const PRICE = { inputPerMTok: 1, outputPerMTok: 2 };
const scripted = (turns) => async () => ({ provider: fakeProvider(turns), model: 'fake-model', price: PRICE });

test('state, layout placement rules, events replay, static files', async () => {
  const srv = await startTestServer({ makeProvider: scripted([]) });
  try {
    const state = await srv.get('/api/state');
    assert.equal(state.status, 200);
    assert.equal(state.body.contractVersion, 1);
    assert.equal(state.body.providers.anthropic.configured, false);
    assert.equal(state.body.activeRun, null);
    assert.deepEqual(state.body.layout.objects, []);
    assert.ok(state.body.objectKinds.trailhead_sign);
    assert.equal(state.body.providers.ollama.reachable, false);
    assert.equal(state.body.policy.tiers.worker.provider, 'ollama');
    assert.equal(state.body.leash.domains.research.level, 'act_free');

    const bad = await srv.post('/api/layout/place', { kind: 'piano', roomId: 'ranger-station', x: 2, y: 2 });
    assert.equal(bad.status, 400);
    const outside = await srv.post('/api/layout/place', { kind: 'trailhead_sign', roomId: 'ranger-station', x: 99, y: 2 });
    assert.equal(outside.status, 400);
    const onAgent = await srv.post('/api/layout/place', { kind: 'trailhead_sign', roomId: 'ranger-station', x: 3, y: 4 });
    assert.equal(onAgent.status, 409);
    const placed = await srv.post('/api/layout/place', { kind: 'trailhead_sign', roomId: 'ranger-station', x: 2, y: 2 });
    assert.equal(placed.status, 201);
    assert.equal(placed.body.kind, 'trailhead_sign');
    const dup = await srv.post('/api/layout/place', { kind: 'supply_cache', roomId: 'ranger-station', x: 2, y: 2 });
    assert.equal(dup.status, 409);
    const withId = await srv.post('/api/layout/place', { kind: 'supply_cache', roomId: 'ranger-station', x: 5, y: 5, objectId: 'win-1' });
    assert.equal(withId.status, 201);
    assert.equal((await srv.post('/api/layout/place', { kind: 'supply_cache', roomId: 'ranger-station', x: 6, y: 5, objectId: 'win-1' })).status, 409);
    assert.equal((await srv.post('/api/layout/place', { kind: 'supply_cache', roomId: 'ranger-station', x: 6, y: 5, objectId: '' })).status, 201, 'empty id falls back to generated');

    const layout = await srv.get('/api/layout');
    assert.equal(layout.body.objects.length, 3);
    assert.deepEqual(JSON.parse(await fsp.readFile(path.join(srv.home, 'layout.json'), 'utf8')).objects.length, 3, 'persisted');

    const reclaimed = await srv.post('/api/layout/reclaim', { objectId: 'win-1' });
    assert.equal(reclaimed.status, 200);
    assert.equal((await srv.post('/api/layout/reclaim', { objectId: 'win-1' })).status, 404);

    const stream = await srv.sse(0);
    const ev = await stream.waitFor((e) => e.type === 'object.reclaim');
    assert.equal(ev.payload.objectId, 'win-1');
    const layoutEvents = stream.events.filter((e) => !e.type.startsWith('workspace.'));
    assert.deepEqual(stream.events[0].type, 'workspace.online', 'the watcher reports the root first');
    assert.deepEqual(layoutEvents.map((e) => e.type), ['object.place', 'object.place', 'object.place', 'object.reclaim']);
    for (const e of stream.events) assert.equal(validateEvent(e).ok, true);
    assert.deepEqual(layoutEvents.map((e) => e.seq), [2, 3, 4, 5]);
    stream.close();
    const partial = await srv.sse(4);
    await partial.waitFor((e) => e.seq === 5);
    assert.equal(partial.events.length, 1);
    partial.close();

    const rerolled = await srv.post('/api/layout/reroll', {});
    assert.equal(rerolled.status, 200);
    assert.ok(rerolled.body.seed >= 1);
    assert.equal((await srv.get('/api/layout')).body.seed, rerolled.body.seed);
    assert.deepEqual((await srv.post('/api/layout/reroll', { seed: 7 })).body, { seed: 7 });
    const seedStream = await srv.sse(0);
    await seedStream.waitFor((e) => e.type === 'layout.seed' && e.payload.seed === 7);
    seedStream.close();
    const put = await srv.put('/api/layout', { version: 1, rooms: [], objects: [], agents: [] });
    assert.equal(put.status, 200);
    assert.equal((await srv.put('/api/layout', { version: 2 })).status, 400);

    const html = await fetch(`${srv.url}/`);
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-type'), /text\/html/);
    const shared = await fetch(`${srv.url}/shared/events.js`);
    assert.equal(shared.status, 200);
    assert.match(shared.headers.get('content-type'), /javascript/);
    assert.equal((await fetch(`${srv.url}/shared/../package.json`)).status, 404);
    assert.equal((await fetch(`${srv.url}/..%2fpackage.json`)).status, 404);
    assert.equal((await fetch(`${srv.url}/api/nope`)).status, 404);
    assert.equal((await fetch(`${srv.url}/api/run`, { method: 'POST', body: '{not json' })).status, 400);
  } finally {
    await srv.close();
  }
});

test('run lifecycle over HTTP: events stream, persistence, spend, a second run queues, cancel', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const makeProvider = async () => ({
    provider: fakeProvider([
      [text('thinking '), async () => { await gate; }, text('done'), end('end_turn', { inputTokens: 1000, outputTokens: 500 })],
    ]),
    model: 'fake-model',
    price: PRICE,
  });
  const srv = await startTestServer({ makeProvider });
  try {
    assert.equal((await srv.post('/api/run', {})).status, 400);
    assert.equal((await srv.post('/api/run', { prompt: 'x', agentId: 'ghost' })).status, 400);
    const stream = await srv.sse();
    const started = await srv.post('/api/run', { prompt: 'say done', budgetUsd: 0.5 });
    assert.equal(started.status, 202);
    const { runId } = started.body;
    assert.match(runId, /^run-/);
    assert.equal(started.body.queued, false);
    const again = await srv.post('/api/run', { prompt: 'again' });
    assert.equal(again.status, 202);
    assert.equal(again.body.queued, true, 'one run per agent at a time: the second waits');
    const queuedEv = await stream.waitFor((e) => e.type === 'agent.run.queued');
    assert.deepEqual(queuedEv.payload, { runId: again.body.runId, agentId: 'ranger', position: 0 });
    const state = await srv.get('/api/state');
    assert.equal(state.body.activeRun.runId, runId);
    assert.deepEqual(state.body.queuedRuns.map((r) => r.runId), [again.body.runId]);
    assert.deepEqual((await srv.post('/api/cancel', { runId: again.body.runId })).body, { cancelled: true });
    const cancelledQueued = await stream.waitFor((e) => e.type === 'agent.run.end' && e.payload.runId === again.body.runId);
    assert.equal(cancelledQueued.payload.reason, 'cancelled');
    assert.equal((await srv.get(`/api/runs/${again.body.runId}`)).body.reason, 'cancelled');
    await stream.waitFor((e) => e.type === 'agent.token');
    release();
    const endEv = await stream.waitFor((e) => e.type === 'agent.run.end' && e.payload.runId === runId);
    assert.equal(endEv.payload.reason, 'completed');
    assert.equal(endEv.payload.finalText, 'thinking done');
    const types = stream.events.filter((e) => !e.type.startsWith('workspace.') && (!e.payload.runId || e.payload.runId === runId)).map((e) => e.type);
    assert.deepEqual(types, ['agent.run.start', 'agent.token', 'agent.token', 'cost.estimate', 'agent.run.end']);
    const cost = stream.events.find((e) => e.type === 'cost.estimate').payload;
    assert.equal(cost.usd, (1000 * 1 + 500 * 2) / 1e6);
    assert.equal(cost.reconciled, true);

    await srv.runs.waitForIdle();
    const after = await srv.get('/api/state');
    assert.equal(after.body.activeRun, null);
    assert.equal(after.body.spend.totalUsd, cost.usd);
    assert.equal(after.body.spend.reconciledTurns, 1);
    assert.equal(after.body.runs.find((r) => r.runId === runId).status, 'ended');
    const rec = await srv.get(`/api/runs/${runId}`);
    assert.equal(rec.status, 200);
    assert.equal(rec.body.events.length, 5);
    assert.equal(rec.body.reason, 'completed');
    assert.equal(rec.body.spentUsd, cost.usd);
    assert.equal(rec.body.messages.length, 2);
    assert.equal((await srv.get('/api/runs/nope')).status, 404);
    assert.ok((await fsp.stat(path.join(srv.workspaceRoot, 'ranger', 'outbox'))).isDirectory());
    stream.close();

    // Cancel a second run mid-stream.
    const hold = new Promise(() => {});
    const srv2 = await startTestServer({ makeProvider: async () => ({ provider: fakeProvider([[text('a'), async () => { await hold; }]]), model: 'm', price: PRICE }) });
    try {
      const s2 = await srv2.sse();
      const r2 = await srv2.post('/api/run', { prompt: 'hang' });
      await s2.waitFor((e) => e.type === 'agent.token');
      assert.deepEqual((await srv2.post('/api/cancel', { runId: 'wrong' })).body, { cancelled: false });
      assert.deepEqual((await srv2.post('/api/cancel', { runId: r2.body.runId })).body, { cancelled: true });
      const e2 = await s2.waitFor((e) => e.type === 'agent.run.end');
      assert.equal(e2.payload.reason, 'cancelled');
      s2.close();
    } finally {
      await srv2.close();
    }
  } finally {
    await srv.close();
  }
});

test('permission round trip over HTTP: fs.write prompts, the answer gates the write; timeout denies', async () => {
  const layout = (await import('../shared/world.js')).defaultLayout();
  layout.objects.push({ id: 'wb', kind: 'supply_cache', roomId: 'ranger-station', x: 2, y: 2 });
  const turns = [
    [...toolCall('c1', 'fs.write', { path: 'outbox/hello.txt', content: 'hi' }), end('tool_use')],
    [...toolCall('c2', 'fs.write', { path: 'outbox/denied.txt', content: 'no' }), end('tool_use')],
    [...toolCall('c3', 'fs.write', { path: 'outbox/late.txt', content: 'late' }), end('tool_use')],
    [text('finished'), end()],
  ];
  const srv = await startTestServer({ layout, makeProvider: scripted(turns), permissionTimeoutMs: 150 });
  try {
    const stream = await srv.sse();
    const { body: { runId } } = await srv.post('/api/run', { prompt: 'write hello' });
    const p1 = await stream.waitFor((e) => e.type === 'permission.prompt');
    assert.equal(p1.payload.tool, 'fs.write');
    assert.deepEqual(p1.payload.input, { path: 'outbox/hello.txt', content: 'hi' });
    assert.deepEqual((await srv.get('/api/state')).body.pendingPrompts, [{ promptId: p1.payload.promptId, runId }]);
    assert.equal((await srv.post('/api/permission', { promptId: p1.payload.promptId, allow: true })).status, 400, 'schema validated');
    assert.equal((await srv.post('/api/permission', { promptId: 'nope', runId, allow: true })).status, 404);
    assert.equal((await srv.post('/api/permission', { promptId: p1.payload.promptId, runId, allow: true })).status, 200);
    const r1 = await stream.waitFor((e) => e.type === 'agent.tool_result' && e.payload.callId === 'c1');
    assert.equal(r1.payload.ok, true);
    assert.equal(await fsp.readFile(path.join(srv.workspaceRoot, 'ranger', 'outbox', 'hello.txt'), 'utf8'), 'hi');

    const p2 = await stream.waitFor((e) => e.type === 'permission.prompt' && e.payload.callId === 'c2');
    await srv.post('/api/permission', { promptId: p2.payload.promptId, runId, allow: false });
    const r2 = await stream.waitFor((e) => e.type === 'agent.tool_result' && e.payload.callId === 'c2');
    assert.equal(r2.payload.ok, false);
    assert.match(r2.payload.error, /denied/);
    await assert.rejects(fsp.stat(path.join(srv.workspaceRoot, 'ranger', 'outbox', 'denied.txt')));

    const r3 = await stream.waitFor((e) => e.type === 'agent.tool_result' && e.payload.callId === 'c3');
    assert.equal(r3.payload.ok, false, 'unanswered prompt times out as a denial');
    const endEv = await stream.waitFor((e) => e.type === 'agent.run.end');
    assert.equal(endEv.payload.reason, 'completed');
    const responses = stream.events.filter((e) => e.type === 'permission.response').map((e) => e.payload.allow);
    assert.deepEqual(responses, [true, false]);
    stream.close();
  } finally {
    await srv.close();
  }
});

test('Entrance Gate over HTTP: a draft-level action waits as a gate.item, approve runs it, reject answers it, observe refuses, leash is editable', async () => {
  const layout = (await import('../shared/world.js')).defaultLayout();
  layout.objects.push({ id: 'sc', kind: 'supply_cache', roomId: 'ranger-station', x: 2, y: 2 });
  const leash = (await import('../shared/leash.js')).defaultLeash();
  leash.domains.research = { level: 'draft' };
  const turns = [
    [text('reading notes'), ...toolCall('c1', 'fs.read', { path: 'notes.txt' }), end('tool_use')],
    [...toolCall('c2', 'fs.read', { path: 'notes.txt' }), end('tool_use')],
    [...toolCall('c3', 'fs.read', { path: 'notes.txt' }), end('tool_use')],
    [text('finished'), end()],
  ];
  const srv = await startTestServer({ layout, leash, makeProvider: scripted(turns) });
  try {
    await fsp.mkdir(path.join(srv.workspaceRoot, 'ranger'), { recursive: true });
    await fsp.writeFile(path.join(srv.workspaceRoot, 'ranger', 'notes.txt'), 'milk');
    const stream = await srv.sse();
    const { body: { runId } } = await srv.post('/api/run', { prompt: 'read the notes' });
    const item = await stream.waitFor((e) => e.type === 'gate.item');
    assert.equal(item.payload.status, 'pending');
    assert.equal(item.payload.domain, 'research');
    assert.equal(item.payload.tool, 'fs.read');
    assert.equal(item.payload.level, 'draft');
    assert.equal(item.payload.runId, runId);
    assert.equal(item.payload.evidence[0].text, 'reading notes');
    const waiting = await stream.waitFor((e) => e.type === 'agent.waiting');
    assert.equal(waiting.payload.itemId, item.payload.itemId);
    const q = await srv.get('/api/gate');
    assert.equal(q.body.pending.length, 1);
    assert.equal(q.body.pending[0].itemId, item.payload.itemId);
    assert.equal(q.body.ledger.day, srv.ledger.dayKey());
    assert.equal((await srv.get('/api/state')).body.gate.pending.length, 1);
    assert.equal((await srv.post(`/api/gate/${item.payload.itemId}`, { decision: 'later' })).status, 400);
    assert.equal((await srv.post('/api/gate/nope', { decision: 'approve' })).status, 404);
    const ok = await srv.post(`/api/gate/${item.payload.itemId}`, { decision: 'approve' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.status, 'approved');
    assert.equal((await srv.post(`/api/gate/${item.payload.itemId}`, { decision: 'approve' })).status, 409);
    const r1 = await stream.waitFor((e) => e.type === 'agent.tool_result' && e.payload.callId === 'c1');
    assert.deepEqual([r1.payload.ok, r1.payload.output], [true, 'milk']);
    const approved = await stream.waitFor((e) => e.type === 'gate.item' && e.payload.status === 'approved');
    assert.equal(approved.payload.itemId, item.payload.itemId);

    const second = await stream.waitFor((e) => e.type === 'gate.item' && e.payload.callId === 'c2');
    await srv.post(`/api/gate/${second.payload.itemId}`, { decision: 'reject', notes: 'not now' });
    const r2 = await stream.waitFor((e) => e.type === 'agent.tool_result' && e.payload.callId === 'c2');
    assert.equal(r2.payload.ok, false);
    assert.match(r2.payload.error, /rejected at the Entrance Gate: not now/);

    // Tighten research to observe while the run is going: the third call is refused outright.
    const third = await stream.waitFor((e) => e.type === 'gate.item' && e.payload.callId === 'c3' && e.payload.status === 'pending');
    const tightened = { ...leash, domains: { ...leash.domains, research: { level: 'observe' } } };
    assert.equal((await srv.put('/api/leash', { version: 1, domains: { nope: { level: 'draft' } } })).status, 400);
    assert.equal((await srv.put('/api/leash', tightened)).status, 200);
    assert.equal((await srv.get('/api/leash')).body.domains.research.level, 'observe');
    assert.equal(JSON.parse(await fsp.readFile(path.join(srv.home, 'leash.json'), 'utf8')).domains.research.level, 'observe', 'persisted');
    // The pending item was created under draft; decide it so the run continues.
    await srv.post(`/api/gate/${third.payload.itemId}`, { decision: 'reject' });
    const endEv = await stream.waitFor((e) => e.type === 'agent.run.end');
    assert.equal(endEv.payload.reason, 'completed');
    await srv.runs.waitForIdle();
    const after = await srv.get('/api/gate');
    assert.equal(after.body.pending.length, 0);
    assert.deepEqual(after.body.recent.map((i) => i.status), ['rejected', 'rejected', 'approved']);
    assert.equal(after.body.ledger.domains.research.actions, 1, 'only the executed read is counted');
    const types = stream.events.map((e) => e.type);
    assert.ok(types.includes('agent.waiting'));
    for (const e of stream.events) assert.equal(validateEvent(e).ok, true);
    stream.close();
  } finally {
    await srv.close();
  }
});

test('judge over HTTP: an act_free action is reviewed on the judge tier; verdicts, judge cost and the ledger show up in the state', async () => {
  const layout = (await import('../shared/world.js')).defaultLayout();
  layout.objects.push({ id: 'sc', kind: 'supply_cache', roomId: 'ranger-station', x: 2, y: 2 });
  // Research at act_free is not judged (D38), so judge the final answer only, then check the judge cost is reconciled.
  const judgeProvider = async (name, opts) => ({ provider: fakeProvider([[text('{"verdict":"approve","notes":"fine"}'), end('end_turn', { inputTokens: 500, outputTokens: 20 })]], { name }), model: opts.model, price: PRICE });
  const srv = await startTestServer({ layout, makeProvider: scripted([[...toolCall('c1', 'fs.read', { path: 'notes.txt' }), end('tool_use')], [text('done'), end()]]), judgeProvider });
  try {
    await fsp.mkdir(path.join(srv.workspaceRoot, 'ranger'), { recursive: true });
    await fsp.writeFile(path.join(srv.workspaceRoot, 'ranger', 'notes.txt'), 'milk');
    const before = await srv.get('/api/state');
    assert.deepEqual(before.body.judge.today, { usd: 0, calls: 0 });
    assert.equal(before.body.judge.model, 'claude-sonnet-5-5');
    assert.equal(before.body.judge.wired, false);
    const stream = await srv.sse();
    const { body: { runId } } = await srv.post('/api/run', { prompt: 'read notes' });
    const verdict = await stream.waitFor((e) => e.type === 'judge.verdict');
    assert.deepEqual([verdict.payload.scope, verdict.payload.verdict, verdict.payload.notes, verdict.payload.turn], ['final', 'approve', 'fine', 2]);
    await stream.waitFor((e) => e.type === 'agent.run.end');
    await srv.runs.waitForIdle();
    const costs = stream.events.filter((e) => e.type === 'cost.estimate').map((e) => [e.payload.tier, e.payload.model]);
    assert.deepEqual(costs, [['worker', 'fake-model'], ['worker', 'fake-model'], ['judge', 'claude-sonnet-5-5']]);
    const after = await srv.get('/api/state');
    assert.equal(after.body.judge.today.calls, 1);
    assert.equal(after.body.judge.today.usd, (500 * 1 + 20 * 2) / 1e6);
    assert.equal(after.body.judge.wired, true);
    assert.equal(after.body.ledger.judge.calls, 1);
    const rec = await srv.get(`/api/runs/${runId}`);
    assert.ok(rec.body.events.some((e) => e.type === 'judge.verdict'), 'the verdict is in the run record');
    assert.ok(Math.abs(rec.body.spentUsd - ((500 * 1 + 20 * 2) / 1e6 + 2 * (10 * 1 + 5 * 2) / 1e6)) < 1e-12, 'run spend includes the judge call');
    stream.close();
  } finally {
    await srv.close();
  }
});

test('agents over HTTP: CRUD with the hierarchy rules, the Chief at the Peak, personas and per-agent policy drive the run', async () => {
  const seen = [];
  const makeProvider = async (name, opts) => {
    seen.push({ name, model: opts.model });
    return { provider: fakeProvider([[text('hello'), end()]], { name }), model: opts.model || 'picked', price: null };
  };
  const srv = await startTestServer({ makeProvider, withChief: true });
  try {
    const list = await srv.get('/api/agents');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.map((a) => a.role).sort(), ['chief_ranger', 'ranger']);
    assert.equal(list.body.find((a) => a.role === 'chief_ranger').zone.kind, 'mountain_peak');
    assert.equal((await srv.get('/api/state')).body.agents.length, 2);
    assert.equal((await srv.post('/api/agents', { name: 'Second Chief', role: 'chief_ranger' })).status, 409);
    assert.equal((await srv.post('/api/agents', { name: 'X', zoneId: 'nowhere' })).status, 400);
    const created = await srv.post('/api/agents', { name: 'Scout', zoneId: 'ranger-station', parentAgentId: 'chief-ranger', specialty: 'scout', venture: 'Lantern Co', policy: { worker: { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b' } } });
    assert.equal(created.status, 201);
    const scout = created.body;
    assert.equal((await srv.get(`/api/agents/${scout.id}`)).body.specialtyLabel, 'Scout Ranger');
    assert.equal((await srv.get('/api/agents/ghost')).status, 404);
    const stream = await srv.sse();
    const run = await srv.post('/api/run', { agentId: scout.id, prompt: 'scout' });
    assert.equal(run.status, 202);
    assert.deepEqual(seen.at(-1), { name: 'openrouter', model: 'meta-llama/llama-3.3-70b' }, 'the agent policy picks the worker');
    assert.equal(run.body.tier, 'worker');
    await stream.waitFor((e) => e.type === 'agent.run.end');
    await srv.runs.waitForIdle();
    const rec = await srv.get(`/api/runs/${run.body.runId}`);
    assert.ok(rec.body.events.find((e) => e.type === 'agent.run.start').payload.tools.includes('crew.spawn_junior'));
    const patched = await srv.patch(`/api/agents/${scout.id}`, { name: 'Scout Ada', leash: { domains: { publishing: { level: 'act_free' } } } });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.leash.publishing.scope, 'agent');
    assert.equal((await srv.get('/api/leash')).body.agents[scout.id].domains.publishing.level, 'act_free');
    assert.equal((await srv.patch(`/api/agents/${scout.id}`, { role: 'junior_ranger' })).status, 400);
    const junior = await srv.post('/api/agents', { name: 'Drafter', role: 'junior_ranger', zoneId: 'ranger-station', parentAgentId: scout.id, persona: 'drafts' });
    assert.equal(junior.status, 201);
    assert.equal((await srv.post('/api/agents', { name: 'Deeper', role: 'junior_ranger', zoneId: 'ranger-station', parentAgentId: junior.body.id })).status, 400);
    assert.equal((await srv.del(`/api/agents/${scout.id}`)).status, 409, 'has reports');
    assert.equal((await srv.del(`/api/agents/${junior.body.id}`)).status, 200);
    assert.equal((await srv.del(`/api/agents/${scout.id}`)).status, 200);
    assert.equal((await srv.del('/api/agents/ghost')).status, 404);
    const crew = stream.events.filter((e) => e.type === 'crew.agent').map((e) => e.payload.change);
    assert.deepEqual(crew, ['created', 'created', 'updated', 'created', 'removed', 'removed'], 'the Chief from boot is replayed first');
    // Pause / resume over HTTP.
    const paused = await srv.post('/api/agents/ranger/pause', {});
    assert.equal(paused.status, 200);
    assert.equal(paused.body.paused, true);
    assert.equal(paused.body.cancelledRuns, 0);
    const refused = await srv.post('/api/run', { agentId: 'ranger', prompt: 'x' });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, 'AGENT_PAUSED');
    const resumed = await srv.post('/api/agents/ranger/resume', {});
    assert.equal(resumed.body.paused, undefined);
    assert.equal((await srv.post('/api/agents/ghost/pause', {})).status, 404);
    assert.ok((await srv.get('/api/state')).body.layout.rooms.some((r) => r.kind === 'visitor_center'), 'the Visitor Center exists from boot');
    stream.close();
  } finally {
    await srv.close();
  }
});

test('concurrency and trails over HTTP: two Rangers run at once under the cap, the Chief delegates along a trail, work.done carries the outbox files', async () => {
  const holds = {};
  const release = (id) => holds[id] && holds[id]();
  const makeProvider = async (name, opts) => ({
    provider: fakeProvider([
      [text('working'), async (ctx) => { await new Promise((r) => { holds[opts.model] = r; }); }, ...toolCall('c1', 'fs.write', { path: 'outbox/result.md', content: 'done' }), end('tool_use')],
      [text('finished the job'), end()],
    ], { name }),
    model: opts.model || 'm',
    price: null,
  });
  const layout = (await import('../shared/world.js')).defaultLayout();
  layout.objects.push({ id: 'sc', kind: 'supply_cache', roomId: 'ranger-station', x: 2, y: 2 });
  layout.rooms.push({ id: 'research', name: 'Research', kind: 'research', x: 20, y: 1, w: 6, h: 6 });
  layout.objects.push({ id: 'sc2', kind: 'supply_cache', roomId: 'research', x: 22, y: 2 });
  layout.agents.push({ id: 'scout', name: 'Scout', roomId: 'research', x: 20, y: 1, role: 'ranger', policy: { worker: { provider: 'ollama', model: 'scout-model' } } });
  layout.agents[0].policy = { worker: { provider: 'ollama', model: 'ranger-model' } };
  const srv = await startTestServer({ layout, makeProvider, withChief: true, maxConcurrent: 2 });
  try {
    const stream = await srv.sse();
    assert.equal((await srv.get('/api/state')).body.maxConcurrent, 2);
    const a = await srv.post('/api/run', { agentId: 'ranger', prompt: 'a' });
    const b = await srv.post('/api/run', { agentId: 'scout', prompt: 'b' });
    assert.deepEqual([a.body.queued, b.body.queued], [false, false], 'two agents run at once');
    const c = await srv.post('/api/run', { agentId: 'chief-ranger', prompt: 'c', provider: 'ollama', model: 'chief-model' });
    assert.equal(c.body.queued, true, 'the cap holds the third');
    assert.equal((await srv.get('/api/state')).body.activeRuns.length, 2);
    await stream.waitFor((e) => e.type === 'agent.token' && e.payload.runId === b.body.runId);
    release('scout-model');
    const p1 = await stream.waitFor((e) => e.type === 'permission.prompt' && e.payload.runId === b.body.runId);
    await srv.post('/api/permission', { promptId: p1.payload.promptId, runId: b.body.runId, allow: true });
    await stream.waitFor((e) => e.type === 'agent.run.end' && e.payload.runId === b.body.runId);
    const started = await stream.waitFor((e) => e.type === 'agent.run.start' && e.payload.runId === c.body.runId);
    assert.equal(started.payload.agentId, 'chief-ranger', 'the queued run starts when a slot frees');
    release('ranger-model');
    release('chief-model');
    for (const r of [a, c]) {
      const pr = await stream.waitFor((e) => e.type === 'permission.prompt' && e.payload.runId === r.body.runId, 5000).catch(() => null);
      if (pr) await srv.post('/api/permission', { promptId: pr.payload.promptId, runId: r.body.runId, allow: true });
      await stream.waitFor((e) => (e.type === 'agent.run.end' || e.type === 'agent.run.error') && e.payload.runId === r.body.runId);
    }
    await srv.runs.waitForIdle();

    // The Superintendent delegates to the Scout; the Scout's run writes outbox/result.md.
    assert.equal((await srv.post('/api/work', { toAgentId: 'ghost', brief: 'x' })).status, 400);
    assert.equal((await srv.post('/api/work', { toAgentId: 'scout', brief: '' })).status, 400);
    const w = await srv.post('/api/work', { toAgentId: 'scout', brief: 'Find three niches', budgetUsd: 0.2, deadline: 'today', evidence: ['one source per niche'] });
    assert.equal(w.status, 202);
    assert.equal(w.body.status, 'running');
    assert.equal(w.body.fromAgentId, 'superintendent');
    const handoff = stream.events.find((e) => e.type === 'work.handoff' && e.payload.workItemId === w.body.id);
    assert.deepEqual([handoff.payload.toAgentId, handoff.payload.toRoomId, handoff.payload.trailId], ['scout', 'research', 'trail:entrance-gate:research']);
    const startEv = await stream.waitFor((e) => e.type === 'agent.run.start' && e.payload.runId === w.body.runId);
    assert.match(startEv.payload.prompt, /BRIEF:\nFind three niches/);
    assert.match(startEv.payload.prompt, /one source per niche/);
    assert.equal(startEv.payload.budgetUsd, 0.2);
    assert.equal((await srv.get('/api/state')).body.work.inTransit.length, 1);
    release('scout-model');
    const p2 = await stream.waitFor((e) => e.type === 'permission.prompt' && e.payload.runId === w.body.runId);
    await srv.post('/api/permission', { promptId: p2.payload.promptId, runId: w.body.runId, allow: true });
    const done = await stream.waitFor((e) => e.type === 'work.done' && e.payload.workItemId === w.body.id);
    assert.equal(done.payload.status, 'done');
    assert.deepEqual(done.payload.deliverables, ['outbox/result.md']);
    assert.equal(done.payload.summary, 'finished the job');
    const item = await srv.get(`/api/work/${w.body.id}`);
    assert.equal(item.body.status, 'done');
    assert.equal((await srv.get('/api/work')).body[0].id, w.body.id);
    assert.equal((await srv.get('/api/work/nope')).status, 404);
    assert.equal((await srv.post(`/api/work/${w.body.id}/cancel`)).status, 409);
    stream.close();
  } finally {
    await srv.close();
  }
});

test('mission over HTTP: the Superintendent briefs the Chief, the plan lands in the state and plan.updated streams', async () => {
  const plan = { summary: 'One venture.', ventures: [{ id: 'v1', name: 'Venture One', summary: 'sells things', budgetUsd: 1, roles: [], tasks: [] }] };
  const chiefProvider = fakeProvider([[...toolCall('p1', 'plan.submit', plan), end('tool_use', { inputTokens: 100, outputTokens: 10 })], [text('planned'), end()]], { name: 'anthropic' });
  const makeProvider = async (name, opts) => (name === 'anthropic' ? { provider: chiefProvider, model: opts.model, price: PRICE } : { provider: fakeProvider([[text('x'), end()]], { name }), model: 'w', price: null });
  const srv = await startTestServer({ makeProvider });
  try {
    assert.equal((await srv.get('/api/mission')).body.mission, null);
    assert.equal((await srv.post('/api/mission', { text: '', budgetUsd: 1 })).status, 400);
    const stream = await srv.sse();
    const r = await srv.post('/api/mission', { text: 'Sell lanterns.', budgetUsd: 2, horizon: '2 weeks' });
    assert.equal(r.status, 202);
    assert.equal(r.body.mission.status, 'planning');
    assert.ok(r.body.runId);
    assert.equal((await srv.post('/api/mission', { text: 'again', budgetUsd: 1 })).status, 409, 'the Chief is busy');
    const submitted = await stream.waitFor((e) => e.type === 'plan.updated' && e.payload.change === 'submitted');
    assert.equal(submitted.payload.ventures[0].name, 'Venture One');
    await stream.waitFor((e) => e.type === 'agent.run.end' && e.payload.runId === r.body.runId);
    await srv.runs.waitForIdle();
    const state = await srv.get('/api/state');
    assert.equal(state.body.mission.mission.status, 'active');
    assert.equal(state.body.mission.plan.version, 1);
    assert.equal(state.body.mission.chief.role, 'chief_ranger');
    assert.equal((await srv.get('/api/mission')).body.plan.ventures[0].id, 'v1');
    assert.ok(state.body.layout.rooms.some((room) => room.kind === 'mountain_peak'));
    assert.ok(state.body.spend.totalUsd > 0, 'the Chief\'s judge-tier spend is in spend.json');
    stream.close();
  } finally {
    await srv.close();
  }
});

test('reflection over HTTP: reflect now posts a document, lists it, and the state shows the schedule', async () => {
  const reflectionJson = { portfolio: 'Nothing has run yet; 0 items done.', ventures: [], briefings: [{ zoneId: 'ranger-station', text: 'Start with 1 scouting task.' }] };
  const judgeProvider = async (name, opts) => ({ provider: fakeProvider([[text(JSON.stringify(reflectionJson)), end('end_turn', { inputTokens: 200, outputTokens: 50 })]], { name }), model: opts.model, price: PRICE });
  const srv = await startTestServer({ makeProvider: scripted([]), judgeProvider, withChief: true });
  try {
    const before = await srv.get('/api/state');
    assert.equal(before.body.reflection.latest, null);
    assert.equal(before.body.reflection.schedule.daily, '07:00');
    assert.ok(before.body.reflection.job.nextRunAt > 0);
    assert.deepEqual((await srv.get('/api/reflections')).body, []);
    const stream = await srv.sse();
    assert.equal((await srv.post('/api/reflect', { reason: 'test' })).status, 202);
    const posted = await stream.waitFor((e) => e.type === 'reflection.posted');
    assert.equal(posted.payload.status, 'posted');
    assert.equal(posted.payload.reason, 'test');
    assert.deepEqual(posted.payload.briefings, ['ranger-station']);
    assert.equal(posted.payload.model, 'claude-opus-5-5', 'the reflect step model');
    const list = await srv.get('/api/reflections');
    assert.equal(list.body.length, 1);
    const doc = await srv.get(`/api/reflections/${posted.payload.reflectionId}`);
    assert.equal(doc.body.portfolio, reflectionJson.portfolio);
    assert.equal((await srv.get('/api/reflections/nope')).status, 404);
    assert.equal((await srv.get('/api/state')).body.reflection.latest.id, posted.payload.reflectionId);
    assert.ok((await fsp.stat(path.join(srv.workspaceRoot, '_stations', 'ranger-station', 'notes'))).isDirectory());
    assert.ok(stream.events.some((e) => e.type === 'cost.estimate' && e.payload.tier === 'judge' && e.payload.runId === posted.payload.reflectionId));
    stream.close();
  } finally {
    await srv.close();
  }
});

test('away mode over HTTP: Gate items are stamped and logged while away; return writes a digest', async () => {
  const layout = (await import('../shared/world.js')).defaultLayout();
  layout.objects.push({ id: 'sc', kind: 'supply_cache', roomId: 'ranger-station', x: 2, y: 2 });
  const leash = (await import('../shared/leash.js')).defaultLeash();
  leash.domains.research = { level: 'draft' };
  const srv = await startTestServer({ layout, leash, makeProvider: scripted([[...toolCall('c1', 'fs.read', { path: 'n.txt' }), end('tool_use')], [text('ok'), end()]]) });
  try {
    await fsp.mkdir(path.join(srv.workspaceRoot, 'ranger'), { recursive: true });
    await fsp.writeFile(path.join(srv.workspaceRoot, 'ranger', 'n.txt'), 'x');
    assert.equal((await srv.get('/api/away')).body.away, false);
    assert.equal((await srv.post('/api/away', { away: 'soon' })).status, 400);
    const stream = await srv.sse();
    const on = await srv.post('/api/away', { away: true });
    assert.equal(on.body.state.away, true);
    await stream.waitFor((e) => e.type === 'away.changed' && e.payload.away === true);
    const { body: { runId } } = await srv.post('/api/run', { prompt: 'read' });
    const item = await stream.waitFor((e) => e.type === 'gate.item' && e.payload.status === 'pending');
    assert.equal(item.payload.away, true, 'stamped while away');
    await srv.post(`/api/gate/${item.payload.itemId}`, { decision: 'approve' });
    await stream.waitFor((e) => e.type === 'agent.run.end' && e.payload.runId === runId);
    await srv.runs.waitForIdle();
    const mid = await srv.get('/api/away');
    assert.equal(mid.body.actions, 1);
    assert.equal((await srv.get('/api/state')).body.away.away, true);
    const back = await srv.post('/api/away', { away: false });
    assert.equal(back.body.state.away, false);
    assert.equal(back.body.digest.actions, 1);
    assert.deepEqual(back.body.digest.byStatus, { approved: 1 });
    const digest = await stream.waitFor((e) => e.type === 'away.digest');
    assert.match(digest.payload.summary, /1 Gate action\(s\)/);
    assert.match(await fsp.readFile(path.join(srv.workspaceRoot, back.body.digest.path), 'utf8'), /# Away digest/);
    const log = await srv.get('/api/away/log');
    assert.ok(log.body.length >= 2);
    assert.equal(log.body[0].type, 'gate.item');
    assert.equal((await srv.get('/api/away')).body.lastDigest.digestId, back.body.digest.digestId);
    stream.close();
  } finally {
    await srv.close();
  }
});

test('mail DNS over HTTP: no keys is a plain 400, plan is a dry run, apply waits at the Gate and writes on approve', async () => {
  const cf = await startFakeCloudflare({ records: [{ type: 'MX', name: 'makapark.com', content: 'old.mail.example', priority: 20 }] });
  const rs = await startFakeResend({ domains: [{ name: 'makapark.com' }] });
  const bare = await startTestServer({ makeProvider: scripted([]) });
  try {
    const st = await bare.get('/api/mail/dns');
    assert.deepEqual(st.body.keys, { resend: false, cloudflare: false });
    const r = await bare.post('/api/mail/dns/plan', {});
    assert.equal(r.status, 400, 'a missing key is a configuration error');
    assert.equal(r.body.code, 'NO_KEY');
    assert.match(r.body.error, /RESEND_API_KEY and CLOUDFLARE_API_TOKEN/);
  } finally {
    await bare.close();
  }
  const srv = await startTestServer({ makeProvider: scripted([]), env: { RESEND_API_KEY: rs.apiKey, CLOUDFLARE_API_TOKEN: cf.token }, mail: { resendBaseUrl: rs.url, cloudflareBaseUrl: cf.url } });
  try {
    assert.deepEqual((await srv.get('/api/state')).body.mail.keys, { resend: true, cloudflare: true });
    const stream = await srv.sse();
    const plan = await srv.post('/api/mail/dns/plan', {});
    assert.equal(plan.status, 200);
    assert.deepEqual(plan.body.counts, { create: 5, update: 0, remove: 1, unchanged: 0 });
    assert.equal(cf.state.records.length, 1, 'a plan writes nothing');
    const planned = await stream.waitFor((e) => e.type === 'mail.dns' && e.payload.change === 'planned');
    assert.equal(planned.payload.create, 5);
    const apply = await srv.post('/api/mail/dns/apply', {});
    assert.equal(apply.status, 202);
    assert.equal(apply.body.status, 'pending');
    const item = await stream.waitFor((e) => e.type === 'gate.item' && e.payload.tool === 'mail.dns.apply');
    assert.equal(item.payload.domain, 'account_settings');
    assert.equal(item.payload.agentId, 'superintendent');
    assert.match(item.payload.evidence[0].text, /\+ MX makapark.com inbound.resend.com/);
    assert.equal((await srv.post('/api/mail/dns/apply', {})).status, 409, 'one apply at a time');
    assert.equal(cf.state.records.length, 1, 'nothing written before the decision');
    await srv.post(`/api/gate/${item.payload.itemId}`, { decision: 'approve' });
    const applied = await stream.waitFor((e) => e.type === 'mail.dns' && e.payload.change !== 'planned');
    assert.equal(applied.payload.change, 'applied');
    assert.deepEqual([applied.payload.create, applied.payload.update, applied.payload.remove], [5, 0, 1]);
    assert.equal(cf.state.records.length, 5);
    assert.ok(cf.state.records.every((rec) => rec.content !== 'old.mail.example'), 'the old MX is gone');
    assert.ok(rs.state.calls.some((c) => c.method === 'POST' && /\/verify$/.test(c.path)), 'verification requested at Resend');
    assert.equal((await srv.get('/api/mail/dns')).body.lastApply.status, 'applied');
    stream.close();
  } finally {
    await srv.close();
    await cf.close();
    await rs.close();
  }
});

test('provider failure becomes agent.run.error and the run record says so; NO_KEY is a 400 before any event', async () => {
  const srv = await startTestServer({ makeProvider: async () => ({ provider: fakeProvider([() => { const e = new Error('upstream 500'); e.code = 'HTTP_500'; throw e; }]), model: 'm', price: null }) });
  try {
    const stream = await srv.sse();
    const { body: { runId } } = await srv.post('/api/run', { prompt: 'x' });
    const err = await stream.waitFor((e) => e.type === 'agent.run.error');
    assert.equal(err.payload.code, 'HTTP_500');
    await srv.runs.waitForIdle();
    const rec = await srv.get(`/api/runs/${runId}`);
    assert.equal(rec.body.status, 'error');
    assert.equal(rec.body.error.message, 'upstream 500');
    assert.equal(stream.events.some((e) => e.type === 'agent.run.end'), false);
    stream.close();
  } finally {
    await srv.close();
  }
  const real = await startTestServer({ env: {} });
  try {
    const r = await real.post('/api/run', { prompt: 'x' });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'OLLAMA_UNREACHABLE', 'the default route is the local worker');
    const r2 = await real.post('/api/run', { prompt: 'x', provider: 'anthropic' });
    assert.equal(r2.body.code, 'NO_KEY');
    assert.equal((await real.post('/api/run', { prompt: 'x', provider: 'bogus' })).body.code, 'UNKNOWN_PROVIDER');
    assert.ok(real.bus.recent(10).every((e) => e.type.startsWith('workspace.')), 'no run event was emitted');
  } finally {
    await real.close();
  }
});

test('boot() starts the real entry point on an ephemeral port with its own data dir', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-boot-'));
  const logs = [];
  const log = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
  const app = await boot({ env: { MAKA_HOME: path.join(tmp, 'home'), MAKA_WORKSPACE: path.join(tmp, 'ws'), PORT: '0' }, port: 0, log });
  try {
    const res = await fetch(`${app.url}/api/state`);
    const state = await res.json();
    assert.equal(state.layout.rooms[0].id, 'ranger-station');
    assert.equal(state.layout.seed, 20261010);
    assert.equal(state.home, path.join(tmp, 'home'));
    assert.ok(logs.some((l) => /not wired/.test(l)));
    assert.ok((await fsp.stat(path.join(tmp, 'home', 'runs'))).isDirectory());
  } finally {
    await app.close();
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('routing over HTTP: default run uses the worker tier and records it; explicit provider has no tier; leash rides the prompt', async () => {
  const seen = [];
  const makeProvider = async (name, opts) => {
    seen.push({ name, model: opts.model });
    return { provider: fakeProvider([[...toolCall('c1', 'fs.write', { path: 'outbox/a.txt', content: 'x' }), end('tool_use')], [text('ok'), end()]], { name }), model: opts.model || 'picked', price: null };
  };
  const layout = (await import('../shared/world.js')).defaultLayout();
  layout.objects.push({ id: 'sc', kind: 'supply_cache', roomId: 'ranger-station', x: 2, y: 2 });
  const policy = { version: 1, tiers: { worker: { provider: 'ollama', model: 'qwen2.5:7b' }, judge: { provider: 'anthropic' } }, steps: { turn: 'worker' } };
  const srv = await startTestServer({ makeProvider, layout, policy, permissionTimeoutMs: 100 });
  try {
    const stream = await srv.sse();
    const r = await srv.post('/api/run', { prompt: 'write a' });
    assert.equal(r.status, 202);
    assert.deepEqual(seen[0], { name: 'ollama', model: 'qwen2.5:7b' });
    assert.equal(r.body.tier, 'worker');
    const prompt = await stream.waitFor((e) => e.type === 'permission.prompt');
    assert.equal('leash' in prompt.payload, false, 'fs.write has no leash domain in phase 1');
    await srv.post('/api/permission', { promptId: prompt.payload.promptId, runId: r.body.runId, allow: true });
    await stream.waitFor((e) => e.type === 'agent.run.end');
    const tiers = stream.events.filter((e) => e.type === 'cost.estimate').map((e) => e.payload.tier);
    assert.deepEqual(tiers, ['worker', 'worker']);
    await srv.runs.waitForIdle();
    const rec = await srv.get(`/api/runs/${r.body.runId}`);
    assert.equal(rec.body.tier, 'worker');
    assert.equal(rec.body.provider, 'ollama');

    const r2 = await srv.post('/api/run', { prompt: 'again', provider: 'anthropic', model: 'claude-opus-5-5' });
    assert.equal(r2.body.tier, null);
    assert.deepEqual(seen[1], { name: 'anthropic', model: 'claude-opus-5-5' });
    await srv.runs.waitForIdle();
    stream.close();
  } finally {
    await srv.close();
  }
});

test('workspace offline: run refused with 503, active run stopped, online/offline events emitted', async () => {
  const hold = new Promise(() => {});
  const srv = await startTestServer({ makeProvider: async () => ({ provider: fakeProvider([[text('a'), async () => { await hold; }]]), model: 'm', price: PRICE }) });
  try {
    const stream = await srv.sse(0);
    await stream.waitFor((e) => e.type === 'workspace.online');
    assert.equal((await srv.get('/api/state')).body.workspace.online, true);
    const r = await srv.post('/api/run', { prompt: 'hang' });
    assert.equal(r.status, 202);
    await stream.waitFor((e) => e.type === 'agent.token');
    // The drive goes away.
    await fsp.rm(srv.workspaceRoot, { recursive: true, force: true });
    await srv.workspace.check();
    const off = await stream.waitFor((e) => e.type === 'workspace.offline');
    assert.equal(off.payload.root, srv.workspaceRoot);
    assert.match(off.payload.reason, /ENOENT/);
    const ended = await stream.waitFor((e) => e.type === 'agent.run.end');
    assert.equal(ended.payload.reason, 'cancelled');
    const refused = await srv.post('/api/run', { prompt: 'again' });
    assert.equal(refused.status, 503);
    assert.equal(refused.body.code, 'WORKSPACE_OFFLINE');
    assert.equal((await srv.get('/api/state')).body.workspace.online, false);
    // The drive comes back.
    await fsp.mkdir(srv.workspaceRoot, { recursive: true });
    await srv.workspace.check();
    await stream.waitFor((e) => e.type === 'workspace.online' && e.seq > off.seq);
    assert.equal((await srv.get('/api/state')).body.workspace.online, true);
    stream.close();
  } finally {
    await srv.close();
  }
});
