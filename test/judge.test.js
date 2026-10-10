import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createJudge, parseVerdict, needsActionReview, JUDGE_SYSTEM_PROMPT } from '../sidecar/judge.js';
import { createRouter, defaultPolicy } from '../sidecar/router.js';
import { createEventBus } from '../sidecar/bus.js';
import { createStore } from '../sidecar/store.js';
import { createLeashLedger, createLeashState } from '../sidecar/leash-ledger.js';
import { createGateQueue } from '../sidecar/gate-queue.js';
import { createToolGate } from '../sidecar/capability/gate.js';
import { TOOLS } from '../sidecar/capability/tools.js';
import { runLoop } from '../sidecar/loop.js';
import { defaultLeash } from '../shared/leash.js';
import { defaultLayout } from '../shared/world.js';
import { fakeProvider, fakeClock, text, toolCall, end } from './helpers/fake-provider.js';

const PRICE = { inputPerMTok: 2, outputPerMTok: 10 };
const verdictTurn = (verdict, notes = '', usage = { inputTokens: 1000, outputTokens: 100 }) => [text(`Sure. ${JSON.stringify({ verdict, notes })}`), end('end_turn', usage)];

const post = {
  name: 'social.post',
  description: 'publish a post',
  inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
  domain: 'publishing',
  run: async (i) => ({ ok: true, output: `posted ${i.text}` }),
};
const REGISTRY = { ...TOOLS, 'social.post': post };

async function harness({ leash = defaultLeash(), judgeTurns = [], policy = defaultPolicy(), judgeFails = false } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-judge-'));
  const store = createStore({ root: dir });
  await store.init();
  const bus = createEventBus();
  const events = [];
  bus.listen((e) => events.push(e));
  const clock = fakeClock();
  const ledger = await createLeashLedger({ store, clock }).init();
  const leashState = createLeashState({ initial: leash, store });
  const queue = await createGateQueue({ bus, store, ledger, leashState, getLayout: defaultLayout, clock }).init();
  const judgeProvider = fakeProvider(judgeTurns, { name: 'anthropic' });
  const makeProvider = async (name, opts) => {
    if (judgeFails) { const e = new Error('no API key for anthropic'); e.code = 'NO_KEY'; throw e; }
    return { provider: judgeProvider, model: opts.model, price: PRICE };
  };
  const router = createRouter(policy);
  const judge = createJudge({ router, makeProvider, ledger, bus, clock, env: {}, log: { error() {} } });
  const submit = { submit: (item) => queue.submit({ ...item, runId: 'run-1' }), log: (item) => queue.log({ ...item, runId: 'run-1' }) };
  const gate = createToolGate({ getLayout: defaultLayout, agentId: 'ranger', workspaceDir: dir, registry: REGISTRY, grants: () => ['social.post', 'fs.read'], getLeash: () => leashState.get(), ledger, submit });
  return { dir, bus, events, clock, ledger, queue, judge, judgeProvider, gate, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

test('parseVerdict reads the JSON object out of prose and refuses nonsense', () => {
  assert.deepEqual(parseVerdict('Here you go: {"verdict": "Approve", "notes": "fine"} thanks'), { verdict: 'approve', notes: 'fine' });
  assert.deepEqual(parseVerdict('{"verdict":"revise","notes":"add the price"}'), { verdict: 'revise', notes: 'add the price' });
  assert.deepEqual(parseVerdict('{"verdict":"reject"}'), { verdict: 'reject', notes: '' });
  assert.equal(parseVerdict('{"verdict":"maybe"}'), null);
  assert.equal(parseVerdict('no json here'), null);
  assert.equal(parseVerdict('{"notes":"x"}'), null);
  assert.match(JUDGE_SYSTEM_PROMPT, /"verdict": "approve" \| "revise" \| "reject"/);
});

test('needsActionReview picks only non-research calls at act_capped / act_free', () => {
  const gate = { leashFor: (n) => ({ 'a': { domain: 'publishing', level: 'act_free' }, 'b': { domain: 'research', level: 'act_free' }, 'c': { domain: 'money_out', level: 'draft' }, 'd': { domain: 'money_out', level: 'act_capped' } }[n] || null) };
  assert.deepEqual(needsActionReview(gate, [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }, { name: 'fs.write' }]).map((n) => n.name), ['a', 'd']);
});

test('judge reviews act_free actions and the final answer; emits judge.verdict + judge cost; revise goes back to the worker; ledger counts judge spend', async () => {
  const leash = defaultLeash();
  leash.domains.publishing = { level: 'act_free' };
  const h = await harness({ leash, judgeTurns: [verdictTurn('revise', 'add a hashtag'), verdictTurn('approve', 'good'), verdictTurn('approve', 'done')] });
  try {
    const worker = fakeProvider([
      [text('Posting.'), ...toolCall('c1', 'social.post', { text: 'hello' }), end('tool_use')],
      [text('Posting again.'), ...toolCall('c2', 'social.post', { text: 'hello #maka' }), end('tool_use')],
      [text('All posted.'), end()],
    ]);
    const review = h.judge.forRun({ runId: 'run-1', agentId: 'ranger', gate: h.gate, brief: 'post a greeting' });
    const out = await runLoop({ runId: 'run-1', agentId: 'ranger', provider: worker, model: 'w', tier: 'worker', prompt: 'post a greeting', tools: h.gate, emit: (e) => h.bus.emit(e), clock: h.clock, review, price: null });
    assert.equal(out.reason, 'completed');
    const results = h.events.filter((e) => e.type === 'agent.tool_result').map((e) => e.payload);
    assert.equal(results[0].ok, false);
    assert.match(results[0].error, /sent back for revision by review: add a hashtag/);
    assert.deepEqual([results[1].ok, results[1].output], [true, 'posted hello #maka']);
    const verdicts = h.events.filter((e) => e.type === 'judge.verdict').map((e) => e.payload);
    assert.deepEqual(verdicts.map((v) => [v.turn, v.scope, v.verdict, v.notes]), [[1, 'action', 'revise', 'add a hashtag'], [2, 'action', 'approve', 'good'], [3, 'final', 'approve', 'done']]);
    assert.equal(verdicts[0].model, 'claude-sonnet-5-5');
    assert.equal(verdicts[0].usd, (1000 * 2 + 100 * 10) / 1e6);
    assert.equal(verdicts[0].reconciled, true);
    assert.deepEqual(verdicts[0].tools, ['social.post']);
    const judgeCosts = h.events.filter((e) => e.type === 'cost.estimate' && e.payload.tier === 'judge');
    assert.equal(judgeCosts.length, 3);
    assert.equal(judgeCosts[0].payload.turn, 1);
    assert.equal(h.ledger.judgeToday().calls, 3);
    assert.ok(Math.abs(h.ledger.judgeToday().usd - 3 * verdicts[0].usd) < 1e-12);
    assert.ok(Math.abs(out.spentUsd - 3 * verdicts[0].usd) < 1e-12, 'judge cost counts against the run budget');
    const judgeReq = h.judgeProvider.requests[0];
    assert.equal(judgeReq.system, JUDGE_SYSTEM_PROMPT);
    assert.match(judgeReq.messages[0].content[0].text, /post a greeting/);
    assert.match(judgeReq.messages[0].content[0].text, /social.post \[domain publishing, leash act_free\]: \{"text":"hello"\}/);
    assert.match(h.judgeProvider.requests[2].messages[0].content[0].text, /SCOPE: the worker is about to finish/);
    assert.equal(h.events.filter((e) => e.type === 'gate.item').length, 1, 'the approved action is logged as allowed at the Gate');
    assert.equal(h.events.find((e) => e.type === 'gate.item').payload.status, 'allowed');
    assert.equal(h.judge.status().wired, true);
  } finally {
    await h.cleanup();
  }
});

test('judge is silent for research and draft-level calls; at the daily USD cap it is skipped and the action falls back to the Gate; no key behaves the same', async () => {
  const leash = defaultLeash();
  leash.domains.publishing = { level: 'act_free' };
  const policy = defaultPolicy();
  policy.caps.judgeUsdPerDay = 0.001;
  const h = await harness({ leash, policy, judgeTurns: [verdictTurn('approve', 'ok'), verdictTurn('approve', 'ok')] });
  try {
    await fsp.writeFile(path.join(h.dir, 'n.txt'), 'x');
    const review = h.judge.forRun({ runId: 'run-1', agentId: 'ranger', gate: h.gate, brief: 'b' });
    // Research only: no judge call, no event.
    assert.equal(await review({ runId: 'run-1', turn: 1, content: [], toolUses: [{ id: 'c0', name: 'fs.read', input: { path: 'n.txt' } }], final: false }), null);
    assert.equal(h.events.filter((e) => e.type === 'judge.verdict').length, 0);
    // First act_free action: judged (and the cap is now spent).
    const first = await review({ runId: 'run-1', turn: 1, content: [], toolUses: [{ id: 'c1', name: 'social.post', input: { text: 'a' } }], final: false });
    assert.equal(first.verdict, 'approve');
    assert.ok(first.usd > 0.001);
    // Second: skipped at cap, escalated.
    const second = await review({ runId: 'run-1', turn: 2, content: [], toolUses: [{ id: 'c2', name: 'social.post', input: { text: 'b' } }], final: false });
    assert.deepEqual(second, { verdict: 'approve', escalate: true, reason: 'judge daily cap reached: $0.00 of $0.001' });
    const skipped = h.events.filter((e) => e.type === 'judge.verdict' && e.payload.verdict === 'skipped');
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].payload.usd, null);
    // Through the loop the escalated call waits at the Gate as a pending item.
    const worker = fakeProvider([[...toolCall('c3', 'social.post', { text: 'c' }), end('tool_use')], [text('ok'), end()]]);
    const run = runLoop({ runId: 'run-1', agentId: 'ranger', provider: worker, model: 'w', prompt: 'b', tools: h.gate, emit: (e) => h.bus.emit(e), clock: h.clock, review });
    await new Promise((r) => setTimeout(r, 20));
    const pending = h.queue.pending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].reason, 'judge daily cap reached: $0.00 of $0.001');
    assert.equal(pending[0].level, 'act_free');
    await h.queue.resolve(pending[0].itemId, { decision: 'approve' });
    const out = await run;
    assert.equal(out.reason, 'completed');
    assert.equal(h.events.filter((e) => e.type === 'agent.tool_result')[0].payload.output, 'posted c');
    const finalSkipped = h.events.filter((e) => e.type === 'judge.verdict' && e.payload.scope === 'final');
    assert.equal(finalSkipped.length, 1);
    assert.equal(finalSkipped[0].payload.verdict, 'skipped');

    // No key: the judge is not wired, every action escalates.
    const nokey = await harness({ leash, judgeFails: true });
    try {
      const r = nokey.judge.forRun({ runId: 'run-1', agentId: 'ranger', gate: nokey.gate, brief: 'b' });
      const v = await r({ runId: 'run-1', turn: 1, content: [], toolUses: [{ id: 'c1', name: 'social.post', input: { text: 'a' } }], final: false });
      assert.equal(v.escalate, true);
      assert.match(v.reason, /judge not wired: no API key for anthropic/);
      assert.equal(nokey.judge.status().wired, false);
    } finally {
      await nokey.cleanup();
    }
  } finally {
    await h.cleanup();
  }
});

test('judge call failure and unreadable verdicts are honest: skipped+escalate, and reject with the raw text', async () => {
  const leash = defaultLeash();
  leash.domains.publishing = { level: 'act_capped', dailyCapActions: 10 };
  const h = await harness({ leash, judgeTurns: [() => { const e = new Error('upstream 529'); e.code = 'HTTP_529'; throw e; }, [text('I think so?'), end()]] });
  try {
    const review = h.judge.forRun({ runId: 'run-1', agentId: 'ranger', gate: h.gate, brief: 'b' });
    const call = { runId: 'run-1', turn: 1, content: [{ type: 'text', text: 'posting' }], toolUses: [{ id: 'c1', name: 'social.post', input: { text: 'a' } }], final: false };
    const failed = await review(call);
    assert.equal(failed.escalate, true);
    assert.match(failed.reason, /judge call failed: upstream 529/);
    const unreadable = await review({ ...call, turn: 2 });
    assert.equal(unreadable.verdict, 'reject');
    assert.match(unreadable.notes, /did not return a readable verdict \(I think so\?\)/);
    assert.equal(h.ledger.judgeToday().calls, 1, 'a failed call is not counted; an unreadable one is');
    const perRun = defaultPolicy();
    perRun.caps.judgeCallsPerRun = 1;
    const h2 = await harness({ leash, policy: perRun, judgeTurns: [verdictTurn('approve')] });
    try {
      const r2 = h2.judge.forRun({ runId: 'run-1', agentId: 'ranger', gate: h2.gate, brief: 'b' });
      assert.equal((await r2(call)).verdict, 'approve');
      assert.match((await r2({ ...call, turn: 2 })).reason, /1 call\(s\) per run/);
    } finally {
      await h2.cleanup();
    }
  } finally {
    await h.cleanup();
  }
});
