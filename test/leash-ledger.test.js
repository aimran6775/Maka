import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createStore } from '../sidecar/store.js';
import { createEventBus } from '../sidecar/bus.js';
import { createLeashLedger, createLeashState, localDayKey } from '../sidecar/leash-ledger.js';
import { createGateQueue } from '../sidecar/gate-queue.js';
import { createToolGate, summarizeCall } from '../sidecar/capability/gate.js';
import { TOOLS } from '../sidecar/capability/tools.js';
import { defaultLeash, withAgentLeash, resolveLeash } from '../shared/leash.js';
import { defaultLayout } from '../shared/world.js';
import { fakeClock, waitUntil } from './helpers/fake-provider.js';

async function tmpHome() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-ledger-'));
  const store = createStore({ root: dir });
  await store.init();
  return { dir, store, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

// Test-only tools with leash domains (phase 2 connectors declare theirs the same way).
const pay = {
  name: 'pay.supplier',
  description: 'pay a supplier',
  inputSchema: { type: 'object', required: ['usd'], additionalProperties: false, properties: { usd: { type: 'number', minimum: 0 } } },
  domain: 'money_out',
  amountUsd: (i) => i.usd,
  summarize: (i) => `pay a supplier $${i.usd}`,
  run: async (i) => ({ ok: true, output: `paid ${i.usd}` }),
};
const post = {
  name: 'social.post',
  description: 'publish a post',
  inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
  domain: 'publishing',
  run: async (i) => ({ ok: true, output: `posted ${i.text}` }),
};
const REGISTRY = { ...TOOLS, 'pay.supplier': pay, 'social.post': post };
const allGranted = () => ['pay.supplier', 'social.post', 'fs.read', 'fs.write'];

test('ledger: daily caps count executed actions and money, days roll over, judge spend is separate, persisted', async () => {
  const { dir, store, cleanup } = await tmpHome();
  try {
    const clock = fakeClock(1_700_000_000_000);
    const ledger = await createLeashLedger({ store, clock }).init();
    assert.equal(ledger.dayKey(), localDayKey(clock.now()));
    assert.deepEqual(ledger.spentToday('money_out'), { usd: 0, actions: 0 });
    assert.equal(ledger.checkCap({ domain: 'money_out', amountUsd: 0, dailyCapUsd: 0 }).ok, true, 'a free action passes a $0 cap');
    assert.equal(ledger.checkCap({ domain: 'money_out', amountUsd: 0.01, dailyCapUsd: 0 }).ok, false, 'a priced action does not');
    assert.equal(ledger.checkCap({ domain: 'money_out', amountUsd: 5, dailyCapUsd: null }).ok, true, 'no cap is no cap');
    await ledger.recordAction({ domain: 'money_out', amountUsd: 4 });
    assert.deepEqual(ledger.spentToday('money_out'), { usd: 4, actions: 1 });
    const over = ledger.checkCap({ domain: 'money_out', amountUsd: 2, dailyCapUsd: 5 });
    assert.equal(over.ok, false);
    assert.match(over.reason, /daily cap for money_out is \$5; \$4.00 used today, this action is \$2.00/);
    assert.equal(ledger.checkCap({ domain: 'money_out', amountUsd: 1, dailyCapUsd: 5 }).ok, true);
    await ledger.recordAction({ domain: 'outbound_messages' });
    assert.equal(ledger.checkCap({ domain: 'outbound_messages', dailyCapActions: 1 }).ok, false);
    assert.equal(ledger.checkCap({ domain: 'outbound_messages', dailyCapActions: 2 }).ok, true);
    await assert.rejects(ledger.recordAction({ domain: 'piloting' }), /unknown domain/);

    assert.deepEqual(await ledger.recordJudge({ usd: 0.2 }), { usd: 0.2, calls: 1 });
    assert.deepEqual(ledger.judgeToday(), { usd: 0.2, calls: 1 });
    const summary = ledger.summary();
    assert.equal(summary.domains.money_out.usd, 4);
    assert.equal(summary.judge.calls, 1);

    // Reload from disk.
    const again = await createLeashLedger({ store, clock }).init();
    assert.deepEqual(again.spentToday('money_out'), { usd: 4, actions: 1 });
    assert.ok(JSON.parse(await fsp.readFile(path.join(dir, 'leash-ledger.json'), 'utf8')).days);

    // The next day starts clean.
    const tomorrow = fakeClock(1_700_000_000_000 + 24 * 3600 * 1000 + 1000);
    const next = await createLeashLedger({ store, clock: tomorrow }).init();
    assert.deepEqual(next.spentToday('money_out'), { usd: 0, actions: 0 });
    assert.deepEqual(next.judgeToday(), { usd: 0, calls: 0 });
  } finally {
    await cleanup();
  }
});

test('ledger streaks: N approvals in a row propose a loosening; a rejection resets', async () => {
  const { store, cleanup } = await tmpHome();
  try {
    const ledger = await createLeashLedger({ store, earnApprovals: 3 }).init();
    assert.deepEqual(await ledger.recordDecision({ agentId: 'a', domain: 'publishing', decision: 'approve' }), { approvals: 1, propose: false });
    assert.deepEqual(await ledger.recordDecision({ agentId: 'a', domain: 'publishing', decision: 'reject' }), { approvals: 0, propose: false });
    await ledger.recordDecision({ agentId: 'a', domain: 'publishing', decision: 'approve' });
    await ledger.recordDecision({ agentId: 'a', domain: 'publishing', decision: 'approve' });
    assert.equal(ledger.streak('a', 'publishing'), 2);
    assert.deepEqual(await ledger.recordDecision({ agentId: 'a', domain: 'publishing', decision: 'approve' }), { approvals: 0, propose: true });
    assert.equal(ledger.streak('b', 'publishing'), 0, 'streaks are per agent');
  } finally {
    await cleanup();
  }
});

test('leash state validates, persists to leash.json and applies agent overrides', async () => {
  const { dir, store, cleanup } = await tmpHome();
  try {
    const state = createLeashState({ initial: defaultLeash(), store });
    await assert.rejects(state.set({ version: 1, domains: { nope: { level: 'draft' } } }), /leash invalid/);
    await state.update((l) => withAgentLeash(l, 'ranger', 'money_out', { level: 'act_capped', dailyCapUsd: 20 }));
    const onDisk = JSON.parse(await fsp.readFile(path.join(dir, 'leash.json'), 'utf8'));
    assert.deepEqual(onDisk.agents.ranger.domains.money_out, { level: 'act_capped', dailyCapUsd: 20 });
    assert.equal(resolveLeash(state.get(), { agentId: 'ranger' }, 'money_out').level, 'act_capped');
    assert.equal(resolveLeash(state.get(), { agentId: 'other' }, 'money_out').level, 'draft');
  } finally {
    await cleanup();
  }
});

test('gate queue: submit parks an item, resolve answers it, decisions feed streaks into a proposal, expiry, persistence', async () => {
  const { store, cleanup } = await tmpHome();
  try {
    const bus = createEventBus();
    const clock = fakeClock();
    const ledger = await createLeashLedger({ store, clock, earnApprovals: 2 }).init();
    const leashState = createLeashState({ initial: defaultLeash(), store });
    const queue = await createGateQueue({ bus, store, ledger, leashState, getLayout: defaultLayout, clock }).init();
    const events = [];
    bus.listen((e) => events.push(e));

    const item = { agentId: 'ranger', domain: 'publishing', tool: 'social.post', summary: 'post hello', runId: 'run-1', callId: 'c1', turn: 1, level: 'draft', evidence: [{ kind: 'said', text: 'posting' }] };
    const decision = queue.submit(item);
    const pending = queue.pending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].status, 'pending');
    assert.deepEqual(events.map((e) => e.type), ['gate.item', 'agent.waiting']);
    assert.equal(events[0].payload.status, 'pending');
    assert.equal(events[0].payload.kind, 'action');
    assert.deepEqual(events[1].payload, { runId: 'run-1', agentId: 'ranger', itemId: pending[0].itemId, domain: 'publishing', tool: 'social.post' });

    await assert.rejects(queue.resolve('nope', { decision: 'approve' }), /no Gate item/);
    await assert.rejects(queue.resolve(pending[0].itemId, { decision: 'maybe' }), /decision must be/);
    const resolved = await queue.resolve(pending[0].itemId, { decision: 'revise', notes: 'shorter' });
    assert.equal(resolved.status, 'revised');
    assert.deepEqual(await decision, { decision: 'revise', notes: 'shorter', status: 'revised' });
    await assert.rejects(queue.resolve(pending[0].itemId, { decision: 'approve' }), /already revised/);
    assert.equal(queue.pending().length, 0);
    assert.equal(queue.recent()[0].status, 'revised');

    // Two approvals in a row (earnApprovals: 2) raise a proposal to loosen publishing.
    const d1 = queue.submit({ ...item, callId: 'c2' });
    await queue.resolve(queue.pending()[0].itemId, { decision: 'approve' });
    assert.equal((await d1).decision, 'approve');
    assert.equal(queue.pending().length, 0, 'one approval is not yet a proposal');
    const d2 = queue.submit({ ...item, callId: 'c3' });
    await queue.resolve(queue.pending()[0].itemId, { decision: 'approve' });
    await d2;
    const proposals = queue.pending();
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].kind, 'proposal');
    assert.deepEqual(proposals[0].proposal, { from: 'draft', to: 'act_capped' });
    assert.match(proposals[0].summary, /loosen ranger from Draft for review to Act with cap/);
    await assert.rejects(queue.resolve(proposals[0].itemId, { decision: 'revise' }), /approved or rejected/);
    await queue.resolve(proposals[0].itemId, { decision: 'approve' });
    assert.equal(resolveLeash(leashState.get(), { agentId: 'ranger' }, 'publishing').level, 'act_capped', 'approval applied the override');
    assert.equal(resolveLeash(leashState.get(), { agentId: 'someone-else' }, 'publishing').level, 'draft');

    // Logged decisions and expiry on run end.
    await queue.log({ ...item, status: 'allowed', reason: 'act_free' });
    assert.equal(events.at(-1).payload.status, 'allowed');
    const d3 = queue.submit({ ...item, runId: 'run-2', callId: 'c4' });
    assert.equal(await queue.expireRun('run-2'), true);
    assert.deepEqual(await d3, { decision: 'reject', notes: '', status: 'expired' });
    assert.equal(await queue.expireRun('run-2'), false);

    // A second queue over the same store sees the history; a pending action left behind expires.
    const d4 = queue.submit({ ...item, runId: 'run-3', callId: 'c5' });
    await queue.flushed();
    const reloaded = await createGateQueue({ bus, store, ledger, leashState, clock }).init();
    assert.equal(reloaded.pending().length, 0);
    assert.equal(reloaded.get(queue.pending()[0].itemId).status, 'expired');
    assert.ok(reloaded.items().length >= 6);
    void d4;
  } finally {
    await cleanup();
  }
});

test('gate enforcement: observe refuses, draft waits at the Gate, act_capped runs under cap and waits over it, act_free runs and is logged', async () => {
  const { dir, store, cleanup } = await tmpHome();
  try {
    const bus = createEventBus();
    const clock = fakeClock();
    const events = [];
    bus.listen((e) => events.push(e));
    const ledger = await createLeashLedger({ store, clock }).init();
    const leash = defaultLeash();
    leash.domains.publishing = { level: 'observe' };
    leash.domains.money_out = { level: 'act_capped', dailyCapUsd: 10 };
    leash.agents = { ranger: { domains: { outbound_messages: { level: 'act_free' } } } };
    const leashState = createLeashState({ initial: leash, store });
    const queue = await createGateQueue({ bus, store, ledger, leashState, getLayout: defaultLayout, clock }).init();
    const submit = { submit: (item) => queue.submit({ ...item, runId: 'run-1' }), log: (item) => queue.log({ ...item, runId: 'run-1' }) };
    const gate = createToolGate({ getLayout: defaultLayout, agentId: 'ranger', workspaceDir: dir, registry: REGISTRY, grants: allGranted, getLeash: () => leashState.get(), ledger, submit });
    assert.deepEqual(gate.definitions().map((d) => d.name), ['fs.read', 'fs.write', 'pay.supplier', 'social.post']);
    assert.deepEqual(gate.leashFor('pay.supplier'), { domain: 'money_out', level: 'act_capped', dailyCapUsd: 10, dailyCapActions: null, scope: 'park' });
    assert.equal(gate.leashFor('fs.write'), null);

    // observe
    const refused = await gate.execute({ id: 'c1', name: 'social.post', input: { text: 'hi' } }, { runId: 'run-1', turn: 1, turnText: 'Posting now' });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'LEASH_OBSERVE');
    assert.match(refused.error, /publishing is at "Observe"/);
    assert.equal(events.at(-1).type, 'gate.item');
    assert.equal(events.at(-1).payload.status, 'refused');
    assert.equal(events.at(-1).payload.evidence[0].text, 'Posting now');

    // act_capped under the cap: runs, logged, counted
    const paid = await gate.execute({ id: 'c2', name: 'pay.supplier', input: { usd: 4 } }, { runId: 'run-1', turn: 1 });
    assert.deepEqual(paid, { ok: true, output: 'paid 4' });
    assert.equal(events.at(-1).payload.status, 'allowed');
    assert.equal(events.at(-1).payload.amountUsd, 4);
    assert.equal(events.at(-1).payload.summary, 'pay a supplier $4');
    assert.deepEqual(ledger.spentToday('money_out'), { usd: 4, actions: 1 });

    // act_capped over the cap: a Gate item; approve runs it and counts it
    const over = gate.execute({ id: 'c3', name: 'pay.supplier', input: { usd: 8 } }, { runId: 'run-1', turn: 2 });
    await waitUntil(() => queue.pending().length === 1);
    const pending = queue.pending();
    assert.equal(pending.length, 1);
    assert.match(pending[0].reason, /daily cap for money_out is \$10/);
    assert.equal(events.at(-1).type, 'agent.waiting');
    await queue.resolve(pending[0].itemId, { decision: 'approve' });
    assert.deepEqual(await over, { ok: true, output: 'paid 8' });
    assert.deepEqual(ledger.spentToday('money_out'), { usd: 12, actions: 2 });

    // draft (research stays act_free by default; switch money_out to draft): reject and revise
    await leashState.update((l) => ({ ...l, domains: { ...l.domains, money_out: { level: 'draft' } } }));
    const rej = gate.execute({ id: 'c4', name: 'pay.supplier', input: { usd: 1 } }, { runId: 'run-1', turn: 3 });
    await waitUntil(() => queue.pending().length === 1);
    await queue.resolve(queue.pending()[0].itemId, { decision: 'reject', notes: 'not this supplier' });
    const rejected = await rej;
    assert.equal(rejected.code, 'GATE_REJECT');
    assert.match(rejected.error, /rejected at the Entrance Gate: not this supplier/);
    const rev = gate.execute({ id: 'c5', name: 'pay.supplier', input: { usd: 1 } }, { runId: 'run-1', turn: 4 });
    await waitUntil(() => queue.pending().length === 1);
    await queue.resolve(queue.pending()[0].itemId, { decision: 'revise', notes: 'ask for a quote first' });
    assert.match((await rev).error, /sent back for revision at the Entrance Gate: ask for a quote first/);
    assert.deepEqual(ledger.spentToday('money_out'), { usd: 12, actions: 2 }, 'nothing ran');

    // act_free: outbound_messages via the agent override; and research reads are not logged at the Gate
    const before = events.length;
    await fsp.writeFile(path.join(dir, 'n.txt'), 'x');
    assert.deepEqual(await gate.execute({ id: 'c6', name: 'fs.read', input: { path: 'n.txt' } }, { runId: 'run-1' }), { ok: true, output: 'x' });
    assert.equal(events.length, before, 'research at act_free emits no gate.item');
    assert.equal(ledger.spentToday('research').actions, 1, 'but the ledger counts it');

    // No queue available: draft actions are refused with a typed result; no ledger: act_capped goes to the Gate.
    const bare = createToolGate({ getLayout: defaultLayout, agentId: 'ranger', workspaceDir: dir, registry: REGISTRY, grants: allGranted, leash: defaultLeash() });
    const unavailable = await bare.execute({ id: 'c7', name: 'social.post', input: { text: 'x' } }, {});
    assert.equal(unavailable.code, 'GATE_UNAVAILABLE');
    const capped = defaultLeash();
    capped.domains.publishing = { level: 'act_capped' };
    const noLedger = createToolGate({ getLayout: defaultLayout, agentId: 'ranger', workspaceDir: dir, registry: REGISTRY, grants: allGranted, leash: capped, submit: { submit: async () => ({ decision: 'approve', notes: '' }) } });
    assert.deepEqual(await noLedger.execute({ id: 'c8', name: 'social.post', input: { text: 'y' } }, {}), { ok: true, output: 'posted y' });

    // fs.write still confirms per call and carries no leash.
    const asks = [];
    const confirm = createToolGate({ getLayout: defaultLayout, agentId: 'ranger', workspaceDir: dir, registry: REGISTRY, grants: allGranted, leash: defaultLeash(), ask: async (q) => { asks.push(q); return true; } });
    assert.equal((await confirm.execute({ id: 'c9', name: 'fs.write', input: { path: 'w.txt', content: 'w' } }, { runId: 'r' })).ok, true);
    assert.equal(asks[0].leash, undefined);
    assert.equal(summarizeCall(post, { text: 'hello' }), 'social.post {"text":"hello"}');
  } finally {
    await cleanup();
  }
});
