import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter, defaultPolicy, validatePolicy, STEP_KINDS, TIERS } from '../sidecar/router.js';
import { runLoop } from '../sidecar/loop.js';
import { fakeProvider, fakeClock, recorder, fakeTools, text, toolCall, end } from './helpers/fake-provider.js';

test('default policy validates and routes routine turns to the worker, quality steps to the judge', () => {
  const policy = defaultPolicy();
  assert.equal(validatePolicy(policy).ok, true);
  const router = createRouter(policy);
  assert.deepEqual(router.route({ kind: 'turn' }), { tier: 'worker', provider: 'ollama', model: null });
  for (const kind of ['plan', 'review', 'ambiguity', 'gate_action', 'reflect']) {
    assert.equal(router.route({ kind }).tier, 'judge', kind);
    assert.equal(router.route({ kind }).provider, 'anthropic');
  }
  assert.equal(router.route({ kind: 'review' }).model, 'claude-sonnet-5-5', 'the judge reviews on sonnet');
  assert.equal(router.route({ kind: 'plan' }).model, 'claude-opus-5-5', 'the Chief plans on opus');
  assert.equal(router.route({ kind: 'reflect' }).model, 'claude-opus-5-5');
  assert.deepEqual(router.caps(), { judgeCallsPerRun: 20, judgeCallsPerDay: 500, judgeUsdPerDay: 10, hostedWorkerCallsPerDay: 2000 });
  assert.deepEqual(router.route(), router.route({ kind: 'turn' }));
  assert.deepEqual([...STEP_KINDS], ['turn', 'plan', 'review', 'ambiguity', 'gate_action', 'reflect']);
  assert.deepEqual([...TIERS], ['worker', 'judge', 'hosted_worker']);
});

test('a custom policy is plain data: models per tier, step overrides, missing steps fall back', () => {
  const policy = {
    version: 1,
    tiers: { worker: { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b' }, judge: { provider: 'anthropic', model: 'claude-opus-5-5' } },
    steps: { turn: 'judge' },
  };
  const router = createRouter(policy);
  assert.deepEqual(router.route({ kind: 'turn' }), { tier: 'judge', provider: 'anthropic', model: 'claude-opus-5-5' });
  assert.deepEqual(router.route({ kind: 'plan' }), { tier: 'judge', provider: 'anthropic', model: 'claude-opus-5-5' });
  assert.deepEqual(router.caps(), { judgeCallsPerRun: 20, judgeCallsPerDay: 500, judgeUsdPerDay: 10, hostedWorkerCallsPerDay: 2000 }, 'missing caps use the defaults');
  assert.equal(router.policy, policy);
  assert.equal(validatePolicy({ ...policy, stepModels: { dance: 'x' } }).ok, false);
  assert.equal(validatePolicy({ ...policy, caps: { judgeUsdPerDay: -1 } }).ok, false);
  assert.throws(() => router.route({ kind: 'dance' }), /unknown step kind/);
});

test('invalid policies are refused with POLICY_INVALID', () => {
  assert.equal(validatePolicy({ version: 1, tiers: { worker: { provider: 'x' } }, steps: {} }).ok, false, 'judge tier required');
  assert.equal(validatePolicy({ version: 1, tiers: { worker: { provider: 'x' }, judge: { provider: 'y' } }, steps: { turn: 'boss' } }).ok, false, 'tier enum');
  assert.equal(validatePolicy({ version: 2, tiers: { worker: { provider: 'x' }, judge: { provider: 'y' } }, steps: {} }).ok, false, 'version');
  assert.throws(() => createRouter({ version: 1 }), (e) => e.code === 'POLICY_INVALID');
});

test('loop records the tier on every cost event', async () => {
  const provider = fakeProvider([[text('hi'), end()]]);
  const rec = recorder();
  await runLoop({ runId: 'r', agentId: 'a', provider, model: 'm', tier: 'worker', prompt: 'x', tools: fakeTools(), emit: rec.emit, clock: fakeClock(), price: { inputPerMTok: 0, outputPerMTok: 0 } });
  const cost = rec.ofType('cost.estimate')[0].payload;
  assert.equal(cost.tier, 'worker');
  assert.equal(cost.usd, 0);
  assert.equal(cost.reconciled, true);
  const rec2 = recorder();
  await runLoop({ runId: 'r', agentId: 'a', provider: fakeProvider([[text('hi'), end()]]), model: 'm', prompt: 'x', tools: fakeTools(), emit: rec2.emit, clock: fakeClock() });
  assert.equal('tier' in rec2.ofType('cost.estimate')[0].payload, false, 'no tier when none was routed');
});

test('review hook: approve runs tools; revise/reject answer every call with the notes and do not run tools; a throwing hook rejects', async () => {
  const turns = () => [
    [...toolCall('c1', 't', { a: 1 }, 0), ...toolCall('c2', 't', { a: 2 }, 1), end('tool_use')],
    [text('after'), end()],
  ];
  const seen = [];
  const run = async (review) => {
    const tools = fakeTools({ t: async (input) => ({ ok: true, output: `ran ${input.a}` }) });
    const rec = recorder();
    const provider = fakeProvider(turns());
    const out = await runLoop({ runId: 'r', agentId: 'a', provider, model: 'm', prompt: 'x', tools, emit: rec.emit, clock: fakeClock(), review });
    return { out, rec, tools, provider };
  };

  const approved = await run(async (ctx) => { seen.push(ctx); return { verdict: 'approve' }; });
  assert.equal(approved.tools.calls.length, 2);
  assert.equal(seen[0].turn, 1);
  assert.equal(seen[0].final, false);
  assert.deepEqual(seen[0].toolUses.map((c) => c.id), ['c1', 'c2']);
  assert.equal(seen[0].content.length, 2);
  assert.equal(seen[1].final, true, 'the closing answer is reviewed too');
  assert.deepEqual(seen[1].toolUses, []);

  const onActions = (v) => async (ctx) => (ctx.final ? { verdict: 'approve' } : v());
  const revised = await run(onActions(() => ({ verdict: 'revise', notes: 'cite the source' })));
  assert.equal(revised.tools.calls.length, 0);
  const results = revised.rec.ofType('agent.tool_result').map((e) => e.payload);
  assert.equal(results.length, 2, 'every tool_call still gets a tool_result');
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /sent back for revision by review: cite the source/);
  assert.equal(revised.provider.requests[1].messages[2].content[1].is_error, true, 'the worker sees the verdict next turn');
  assert.equal(revised.out.reason, 'completed');

  const rejected = await run(onActions(() => ({ verdict: 'reject', notes: 'unsafe' })));
  assert.match(rejected.rec.ofType('agent.tool_result')[0].payload.error, /rejected by review: unsafe/);

  const thrown = await run(onActions(() => { throw new Error('judge offline'); }));
  assert.match(thrown.rec.ofType('agent.tool_result')[0].payload.error, /rejected by review: review failed: judge offline/);
  assert.equal(thrown.tools.calls.length, 0);

  const weird = await run(onActions(() => ({ verdict: 'maybe' })));
  assert.match(weird.rec.ofType('agent.tool_result')[0].payload.error, /unknown verdict "maybe"/);

  const none = await run(undefined);
  assert.equal(none.tools.calls.length, 2);

  // The review's cost counts against the run budget, and escalate reaches the tools as ctx.review.
  const ctxSeen = [];
  const tools = { definitions: () => [{ name: 't', description: '', inputSchema: { type: 'object' } }], execute: async (call, ctx) => { ctxSeen.push(ctx.review); return { ok: true, output: 'ok' }; } };
  const rec = recorder();
  const out = await runLoop({ runId: 'r', agentId: 'a', provider: fakeProvider(turns()), model: 'm', prompt: 'x', tools, emit: rec.emit, clock: fakeClock(), budgetUsd: 1, review: async (ctx) => (ctx.final ? { verdict: 'approve', usd: 0.25 } : { verdict: 'approve', usd: 0.5, escalate: true, reason: 'cap' }) });
  assert.equal(out.spentUsd, 0.75);
  assert.deepEqual(ctxSeen[0], { verdict: 'approve', notes: '', escalate: true, reason: 'cap' });
});

test('final review: revise sends the notes back as a new turn, bounded by maxReviewRetries', async () => {
  const provider = fakeProvider([[text('draft 1'), end()], [text('draft 2'), end()], [text('draft 3'), end()], [text('never')]]);
  const rec = recorder();
  const verdicts = [];
  const out = await runLoop({ runId: 'r', agentId: 'a', provider, model: 'm', prompt: 'write', tools: fakeTools(), emit: rec.emit, clock: fakeClock(), maxTurns: 10, review: async (ctx) => { verdicts.push(ctx.turn); return { verdict: 'revise', notes: 'tighter' }; } });
  assert.equal(out.reason, 'completed');
  assert.equal(out.turns, 3, 'two retries, then it ends');
  assert.deepEqual(verdicts, [1, 2]);
  assert.equal(out.finalText, 'draft 3');
  assert.match(provider.requests[1].messages[2].content[0].text, /\[Judge review: your answer was sent back for revision: tighter/);
  assert.equal(provider.requests.length, 3);
  const once = await runLoop({ runId: 'r', agentId: 'a', provider: fakeProvider([[text('a'), end()], [text('b'), end()]]), model: 'm', prompt: 'x', tools: fakeTools(), emit: recorder().emit, clock: fakeClock(), maxReviewRetries: 1, review: async () => ({ verdict: 'reject', notes: 'no' }) });
  assert.equal(once.turns, 2);
  assert.equal(once.finalText, 'b');
});
