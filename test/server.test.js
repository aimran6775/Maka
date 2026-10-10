import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { startTestServer } from './helpers/test-server.js';
import { fakeProvider, text, toolCall, end } from './helpers/fake-provider.js';
import { validateEvent } from '../shared/events.js';
import { boot } from '../sidecar/index.js';
import os from 'node:os';

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

test('run lifecycle over HTTP: events stream, persistence, spend, 409 while active, cancel', async () => {
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
    const again = await srv.post('/api/run', { prompt: 'again' });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'RUN_ACTIVE');
    const state = await srv.get('/api/state');
    assert.equal(state.body.activeRun.runId, runId);
    await stream.waitFor((e) => e.type === 'agent.token');
    release();
    const endEv = await stream.waitFor((e) => e.type === 'agent.run.end');
    assert.equal(endEv.payload.reason, 'completed');
    assert.equal(endEv.payload.finalText, 'thinking done');
    const types = stream.events.filter((e) => !e.type.startsWith('workspace.')).map((e) => e.type);
    assert.deepEqual(types, ['agent.run.start', 'agent.token', 'agent.token', 'cost.estimate', 'agent.run.end']);
    const cost = stream.events.find((e) => e.type === 'cost.estimate').payload;
    assert.equal(cost.usd, (1000 * 1 + 500 * 2) / 1e6);
    assert.equal(cost.reconciled, true);

    await srv.runs.waitForIdle();
    const after = await srv.get('/api/state');
    assert.equal(after.body.activeRun, null);
    assert.equal(after.body.spend.totalUsd, cost.usd);
    assert.equal(after.body.spend.reconciledTurns, 1);
    assert.equal(after.body.runs[0].runId, runId);
    assert.equal(after.body.runs[0].status, 'ended');
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
