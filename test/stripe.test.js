import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createStore } from '../sidecar/store.js';
import { createEventBus } from '../sidecar/bus.js';
import { createLayoutState } from '../sidecar/server.js';
import { createLeashLedger, createLeashState } from '../sidecar/leash-ledger.js';
import { createGateQueue } from '../sidecar/gate-queue.js';
import { createScheduler } from '../sidecar/scheduler.js';
import { createToolGate } from '../sidecar/capability/gate.js';
import { createConnectors } from '../sidecar/connectors/registry.js';
import { createStripeClient, stripeSpec, major, minor, summarizeStripe, emptyStripeData, STRIPE_TOOLS } from '../sidecar/connectors/stripe.js';
import { ENV_VARS } from '../sidecar/providers/keys.js';
import { OBJECT_KINDS, defaultLayout, allGrantsFor } from '../shared/world.js';
import { defaultLeash, TOOL_DOMAINS } from '../shared/leash.js';
import { startFakeStripe } from './helpers/fake-stripe.js';
import { startTestServer } from './helpers/test-server.js';
import { fakeProvider, fakeClock, text, toolCall, end, waitUntil } from './helpers/fake-provider.js';

test('money helpers and the client: bearer key, form-encoded writes, cursor pagination, Stripe-shaped errors', async () => {
  assert.equal(major(2500, 'usd'), 25);
  assert.equal(major(2500, 'jpy'), 2500);
  assert.equal(minor(12.34, 'usd'), 1234);
  assert.equal(minor(500, 'JPY'), 500);
  assert.equal(summarizeStripe(null), null);
  assert.equal(summarizeStripe(emptyStripeData()), 'balance 0 available · 0 charge(s) · 0 payout(s) · 0 refund(s)');
  const fake = await startFakeStripe({ pageSize: 2 });
  try {
    assert.throws(() => createStripeClient({}), TypeError);
    const bad = createStripeClient({ apiKey: 'sk_wrong', baseUrl: fake.url });
    await assert.rejects(bad.balance(), (e) => e.code === 'HTTP_401' && /Invalid API Key/.test(e.message));
    const client = createStripeClient({ apiKey: fake.apiKey, baseUrl: fake.url });
    const bal = await client.balance();
    assert.equal(bal.available[0].amount, 12500);
    assert.equal(fake.state.calls.at(-1).headers.authorization, `Bearer ${fake.apiKey}`);
    const all = await client.listAll('charges');
    assert.deepEqual(all.map((c) => c.id), ['ch_3', 'ch_2', 'ch_1']);
    const pages = fake.state.calls.filter((c) => c.path.startsWith('/v1/charges'));
    assert.equal(pages.length, 2, 'two pages of two');
    assert.match(pages[1].path, /starting_after=ch_2/);
    assert.equal((await client.listAll('charges', {}, { maxPages: 1 })).length, 2, 'bounded');
    const r = await client.createRefund({ charge: 'ch_3', amount: 500, reason: 'duplicate', metadata: { by: 'maka:ranger' } });
    assert.equal(r.amount, 500);
    const post = fake.state.calls.at(-1);
    assert.equal(post.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.deepEqual(post.body, { charge: 'ch_3', amount: '500', reason: 'duplicate', 'metadata[by]': 'maka:ranger' });
    await assert.rejects(client.createRefund({ charge: 'ch_nope' }), (e) => e.code === 'HTTP_404' && /No such charge/.test(e.message) && e.status === 404);
    fake.state.fail = { status: 503, message: 'maintenance' };
    await assert.rejects(client.balance(), (e) => e.code === 'HTTP_503');
    fake.state.fail = null;
    const down = createStripeClient({ apiKey: 'x', baseUrl: 'http://127.0.0.1:1/v1' });
    await assert.rejects(down.balance(), (e) => e.code === 'NETWORK');
  } finally {
    await fake.close();
  }
});

async function harness({ fake, env, leash: leashPatch = {} } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-stripe-'));
  const store = createStore({ root: path.join(dir, 'home') });
  await store.init();
  const bus = createEventBus();
  const events = [];
  bus.listen((e) => events.push(e));
  const clock = fakeClock(1_700_000_000_000);
  const layout = defaultLayout();
  layout.rooms.push({ id: 'finance', name: 'Finance Camp', kind: 'finance', x: 21, y: 1, w: 8, h: 6 });
  layout.objects.push({ id: 'booth', kind: 'fee_booth', roomId: 'finance', x: 22, y: 2 });
  layout.agents.push({ id: 'books', name: 'Bea', roomId: 'finance', x: 21, y: 1, role: 'ranger', specialty: 'books' });
  const layoutState = createLayoutState({ initial: layout, store, bus, clock });
  const ledger = await createLeashLedger({ store, clock }).init();
  const leash = defaultLeash();
  Object.assign(leash.domains, leashPatch);
  const leashState = createLeashState({ initial: leash, store });
  const gateQueue = await createGateQueue({ bus, store, ledger, leashState, getLayout: layoutState.get, clock }).init();
  const scheduler = await createScheduler({ store, clock, tickMs: 60_000, log: { error() {} } }).init();
  const keystorePath = path.join(dir, 'home', 'keystore.json');
  const connectors = createConnectors({ bus, store, scheduler, gateQueue, env: env || { STRIPE_API_KEY: fake.apiKey }, keystorePath, clock, config: { syncOnBoot: false }, log: { error() {}, warn() {} } });
  connectors.define(stripeSpec({ baseUrl: fake.url }));
  await connectors.init();
  const gate = createToolGate({ getLayout: layoutState.get, agentId: 'books', workspaceDir: path.join(dir, 'ws', 'books'), registry: { ...connectors.tools }, grants: allGrantsFor, toolContext: { connectors }, getLeash: () => leashState.get(), ledger, submit: { submit: (item) => gateQueue.submit({ ...item, runId: 'run-1', agentId: 'books' }), log: (item) => gateQueue.log({ ...item, runId: 'run-1', agentId: 'books' }) } });
  const ofType = (t) => events.filter((e) => e.type === t).map((e) => e.payload);
  const call = (id, name, input) => gate.execute({ id, name, input }, { runId: 'run-1' });
  return { dir, events, ofType, clock, gateQueue, ledger, leashState, connectors, gate, call, cleanup: async () => { await connectors.close(); await fsp.rm(dir, { recursive: true, force: true }); } };
}

test('the Stripe sync brings balance, charges, payouts and refunds into the local store with counts; the Fee booth grants the tools; reads come from the store', async () => {
  assert.equal(ENV_VARS.stripe, 'STRIPE_API_KEY');
  assert.deepEqual(OBJECT_KINDS.fee_booth.grants, ['connector.status', 'connector.sync', ...Object.keys(STRIPE_TOOLS)]);
  for (const name of Object.keys(STRIPE_TOOLS)) assert.equal(TOOL_DOMAINS[name], name === 'stripe.refund' ? 'money_out' : 'research', name);
  const fake = await startFakeStripe();
  const h = await harness({ fake });
  try {
    assert.equal(h.connectors.status('stripe').connected, true);
    assert.equal(h.connectors.status('stripe').zoneKind, 'finance');
    // not synced yet: the balance tool says so
    const early = await h.call('c0', 'stripe.balance', {});
    assert.equal(early.ok, true, early.error);
    assert.equal(JSON.parse(early.output).syncedAt, null);
    const sync = await h.connectors.sync('stripe', 'manual');
    assert.deepEqual(sync.counts, { charges: 3, newCharges: 3, payouts: 1, refunds: 1, newRefunds: 1 });
    const data = h.connectors.data('stripe');
    assert.deepEqual(data.balance.available, [{ amount: 12500, currency: 'usd' }]);
    assert.equal(data.balance.livemode, false);
    assert.equal(data.charges[0].id, 'ch_3');
    assert.equal(data.charges[1].amountRefunded, 1000);
    assert.equal(data.payouts[0].status, 'paid');
    assert.equal(data.refunds[0].charge, 'ch_2');
    assert.equal(h.connectors.status('stripe').summary, 'balance 125.00 USD available · 3 charge(s) · 1 payout(s) · 1 refund(s)');
    assert.deepEqual(h.gate.definitions().map((d) => d.name).filter((n) => n.startsWith('stripe')), ['stripe.balance', 'stripe.charges', 'stripe.payouts', 'stripe.refund', 'stripe.refunds']);
    const bal = JSON.parse((await h.call('c1', 'stripe.balance', {})).output);
    assert.deepEqual(bal.available, [{ amount: 125, currency: 'usd' }]);
    assert.deepEqual(bal.pending, [{ amount: 40, currency: 'usd' }]);
    assert.ok(bal.syncedAt);
    const charges = JSON.parse((await h.call('c2', 'stripe.charges', { status: 'succeeded' })).output);
    assert.equal(charges.count, 2);
    assert.equal(charges.totalAmount, 65);
    assert.equal(charges.charges[0].amount, 25);
    assert.equal(charges.charges[1].amountRefunded, 10);
    const recent = JSON.parse((await h.call('c3', 'stripe.charges', { sinceDays: 3 })).output);
    assert.equal(recent.count, 2, 'the failed charge from 10 days ago is out');
    const payouts = JSON.parse((await h.call('c4', 'stripe.payouts', {})).output);
    assert.equal(payouts.payouts[0].amount, 60);
    assert.match(payouts.payouts[0].arrivalDate, /T/);
    const refunds = JSON.parse((await h.call('c5', 'stripe.refunds', {})).output);
    assert.equal(refunds.refunds[0].reason, 'requested_by_customer');
    // fresh: true syncs first
    fake.state.balance.available[0].amount = 99900;
    assert.deepEqual(JSON.parse((await h.call('c6', 'stripe.balance', { fresh: true })).output).available, [{ amount: 999, currency: 'usd' }]);
    assert.equal(h.ofType('connector.sync').filter((e) => e.status === 'done').length, 2);
    assert.equal(h.gateQueue.recent(20).length, 0, 'reads are research: nothing at the Gate');
  } finally {
    await h.cleanup();
    await fake.close();
  }
});

test('stripe.refund is money_out: Draft parks it at the Gate with the amount (full remaining by default); approve posts the refund; the daily cap at act_capped; bad amounts and unknown charges refused', async () => {
  const fake = await startFakeStripe();
  const h = await harness({ fake });
  try {
    await h.connectors.sync('stripe', 'manual');
    // no amount: the Gate sees the remaining $30 of ch_2
    const pending = h.call('r1', 'stripe.refund', { chargeId: 'ch_2', reason: 'requested_by_customer', note: 'arrived broken' });
    const item = await waitUntil(() => h.gateQueue.pending()[0]);
    assert.equal(item.domain, 'money_out');
    assert.equal(item.amountUsd, 30);
    assert.equal(item.summary, 'refund Stripe charge ch_2 (requested_by_customer)');
    assert.equal(h.gate.leashFor('stripe.refund', {}).level, 'draft');
    await h.gateQueue.resolve(item.itemId, { decision: 'approve' });
    const r = await pending;
    assert.equal(r.ok, true, r.error);
    const out = JSON.parse(r.output);
    assert.equal(out.amount, 30);
    assert.equal(out.charge, 'ch_2');
    assert.equal(out.status, 'succeeded');
    const post = fake.state.calls.find((c) => c.method === 'POST');
    assert.deepEqual(post.body, { charge: 'ch_2', amount: '3000', reason: 'requested_by_customer', 'metadata[note]': 'arrived broken', 'metadata[by]': 'maka:books' });
    assert.equal(h.ledger.summary().domains.money_out.usd, 30, 'the ledger counts the money');
    assert.equal(h.connectors.data('stripe').charges.find((c) => c.id === 'ch_2').refunded, true, 'the local store is updated at once');
    await waitUntil(() => h.ofType('connector.sync').some((e) => e.reason === 'after-refund' && e.status === 'done'));
    assert.equal(h.connectors.data('stripe').refunds.length, 2);
    // act_capped with a $10/day cap: $5 goes through (allowed, logged), $20 waits at the Gate
    await h.leashState.set({ ...h.leashState.get(), domains: { ...h.leashState.get().domains, money_out: { level: 'act_capped', dailyCapUsd: 35 } } });
    const small = await h.call('r4', 'stripe.refund', { chargeId: 'ch_3', amountUsd: 5, reason: 'duplicate' });
    assert.equal(small.ok, true, small.error);
    assert.equal(JSON.parse(small.output).amount, 5);
    assert.equal(h.gateQueue.recent(20).find((it) => it.callId === 'r4').status, 'allowed');
    const big = h.call('r5', 'stripe.refund', { chargeId: 'ch_3', amountUsd: 20 });
    const capped = await waitUntil(() => h.gateQueue.pending()[0]);
    assert.match(capped.reason, /cap/);
    await h.gateQueue.resolve(capped.itemId, { decision: 'reject', notes: 'too much' });
    assert.equal((await big).code, 'GATE_REJECT');
    // at act_free the tool's own checks answer: over the remaining amount, then the platform's words
    await h.leashState.set({ ...h.leashState.get(), domains: { ...h.leashState.get().domains, money_out: { level: 'act_free' } } });
    assert.equal((await h.call('r6', 'stripe.refund', { chargeId: 'ch_3', amountUsd: 500 })).code, 'BAD_AMOUNT', 'over the remaining amount');
    assert.equal((await h.call('r2', 'stripe.refund', { chargeId: 'ch_2' })).code, 'BAD_AMOUNT', 'refunded already: nothing remains');
    assert.equal((await h.call('r3', 'stripe.refund', { chargeId: 'ch_nope' })).code, 'NOT_FOUND');
    assert.equal(h.gate.leashFor('stripe.refund', { chargeId: 'ch_nope' }).domain, 'money_out');
    fake.state.fail = { status: 402, message: 'Insufficient funds' };
    const failed = await h.call('r7', 'stripe.refund', { chargeId: 'ch_3', amountUsd: 1 });
    assert.equal(failed.code, 'HTTP_402');
    assert.match(failed.error, /Insufficient funds/);
    fake.state.fail = null;
  } finally {
    await h.cleanup();
    await fake.close();
  }
});

test('through the sidecar: STRIPE_API_KEY connects at boot, the Finance camp reads /api/connectors/stripe, a Books Ranger refunds through the Gate, the reflection names the Stripe figures', async () => {
  const fake = await startFakeStripe();
  const layout = defaultLayout();
  layout.rooms.push({ id: 'finance', name: 'Finance Camp', kind: 'finance', x: 21, y: 1, w: 8, h: 6 });
  layout.objects.push({ id: 'booth', kind: 'fee_booth', roomId: 'finance', x: 22, y: 2 });
  layout.agents.push({ id: 'books', name: 'Bea', roomId: 'finance', x: 21, y: 1, role: 'ranger', specialty: 'books' });
  const provider = fakeProvider([
    [...toolCall('b1', 'stripe.balance', { fresh: true }), end('tool_use')],
    [...toolCall('b2', 'stripe.refund', { chargeId: 'ch_3', amountUsd: 5, reason: 'duplicate' }), end('tool_use')],
    [text('refunded $5'), end()],
  ]);
  const srv = await startTestServer({ layout, makeProvider: async () => ({ provider, model: 'm', price: null }), env: { STRIPE_API_KEY: fake.apiKey }, connectors: [stripeSpec({ baseUrl: fake.url })] });
  try {
    const list = (await srv.get('/api/connectors')).body;
    assert.equal(list[0].kind, 'stripe');
    assert.equal(list[0].connected, true);
    assert.equal(list[0].by, 'env');
    const stream = await srv.sse();
    const r = await srv.post('/api/run', { prompt: 'check the books', agentId: 'books' });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const start = await stream.waitFor((e) => e.type === 'agent.run.start' && e.payload.runId === r.body.runId);
    assert.ok(start.payload.tools.includes('stripe.refund'));
    const item = await stream.waitFor((e) => e.type === 'gate.item' && e.payload.status === 'pending' && e.payload.tool === 'stripe.refund');
    assert.equal(item.payload.amountUsd, 5);
    assert.equal(item.payload.domain, 'money_out');
    assert.equal((await srv.post(`/api/gate/${item.payload.itemId}`, { decision: 'approve' })).status, 200);
    await stream.waitFor((e) => e.type === 'agent.run.end' && e.payload.runId === r.body.runId);
    await srv.runs.waitForIdle();
    const stripe = (await srv.get('/api/connectors/stripe')).body;
    assert.equal(stripe.data.charges[0].amountRefunded, 500);
    assert.equal(stripe.summary.startsWith('balance '), true);
    assert.equal((await srv.get('/api/state')).body.ledger.domains.money_out.usd, 5);
    // the reflection's data names Stripe instead of "none wired"
    const data = await srv.reflect.gather();
    assert.match(data.connectors, /^Stripe: balance .* available · 3 charge\(s\)/);
    stream.close();
  } finally {
    await srv.close();
    await fake.close();
  }
});
