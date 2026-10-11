// Supplier purchasing through the browser (phase 4 step 17): the pure rules, the ledger's
// holds, the purchase.request tool through the leash and the Gate, the browser's refusal to
// write on a payment page during a purchase, the receipt settling the hold, cancel and
// failure releasing it, reconciliation against connector charges, and the whole chain over
// HTTP with a Ranger's fake worker driving a fake supplier site.
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
import { createToolGate } from '../sidecar/capability/gate.js';
import { createBrowserControl } from '../sidecar/browser/control.js';
import { createNetGuard } from '../sidecar/netguard.js';
import { createPurchases, supplierHost, pickExecutor, purchaseBrief, matchCharge, PURCHASE_TOOL_NAMES, RECONCILE_WINDOW_DAYS } from '../sidecar/purchases.js';
import { defaultLayout, allGrantsFor, OBJECT_KINDS } from '../shared/world.js';
import { defaultLeash, TOOL_DOMAINS } from '../shared/leash.js';
import { fakeBrowserDriver, SUPPLIER } from './helpers/fake-browser-driver.js';
import { startTestServer } from './helpers/test-server.js';
import { fakeProvider, text, end, toolCall } from './helpers/fake-provider.js';
import { makeEvent } from '../shared/events.js';

const REQUEST = { venture: 'lantern-co', supplierUrl: `${SUPPLIER}/`, items: [{ name: 'Rice paper roll', qty: 2, unitUsd: 15 }, { name: 'Bamboo frame', qty: 1 }], amountUsd: 42 };

// A clock that moves only when told, so holds and days are checked exactly.
function fakeClock(start) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function layoutWithOffice() {
  const layout = defaultLayout();
  layout.objects.push({ id: 'office', kind: 'field_office', roomId: 'ranger-station', x: 2, y: 2 });
  layout.agents.push({ id: 'driver', name: 'Dee', roomId: 'ranger-station', x: 4, y: 2, role: 'ranger', venture: 'lantern-co' });
  return layout;
}

const waitUntil = async (fn, { tries = 200, ms = 10 } = {}) => {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, ms));
  }
  throw new Error('condition not met');
};

// A trails stand-in: records delegations, hands back an item, cancels on request.
function fakeTrails() {
  const items = [];
  return {
    items,
    cancelled: [],
    async delegate(spec, { by }) { const item = { id: `work-${items.length + 1}`, status: 'queued', runId: null, ...spec, by }; items.push(item); return item; },
    get: (id) => items.find((i) => i.id === id) || null,
    async cancel(id) { this.cancelled.push(id); const it = items.find((i) => i.id === id); if (it) it.status = 'cancelled'; return it; },
  };
}

async function harness({ leashLevel = 'draft', capUsd = null, layout = layoutWithOffice(), connectors = null } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-purchase-'));
  const store = createStore({ root: path.join(dir, 'home') });
  await store.init();
  const bus = createEventBus();
  const events = [];
  bus.listen((e) => events.push(e));
  const clock = fakeClock(Date.UTC(2026, 9, 11, 10));
  const layoutState = createLayoutState({ initial: layout, store, bus, clock });
  const ledger = await createLeashLedger({ store, clock }).init();
  const leash = defaultLeash();
  leash.domains.money_out = capUsd === null ? { level: leashLevel } : { level: leashLevel, dailyCapUsd: capUsd };
  leash.domains.browser_control = { level: 'act_free' };
  const leashState = createLeashState({ initial: leash, store });
  const gateQueue = await createGateQueue({ bus, store, ledger, leashState, getLayout: layoutState.get, clock }).init();
  const workspaceRoot = path.join(dir, 'ws');
  for (const a of layout.agents) await fsp.mkdir(path.join(workspaceRoot, a.id), { recursive: true });
  const netGuard = createNetGuard({ allowLocal: true });
  const driver = fakeBrowserDriver();
  const browser = await createBrowserControl({ bus, workspaceRoot, env: {}, config: { headless: true }, clock, driver, netGuard, log: { error() {} } }).init();
  const trails = fakeTrails();
  const purchases = await createPurchases({ bus, store, trails, ledger, browser, getLayout: layoutState.get, getConnectors: connectors ? () => connectors : null, netGuard, workspaceRoot, clock, log: { error() {} } }).init();
  const registry = { ...browser.tools, ...purchases.tools };
  const gateFor = (agentId, { runId = 'run-1' } = {}) => ({
    gate: createToolGate({ getLayout: layoutState.get, agentId, workspaceDir: path.join(workspaceRoot, agentId), registry, grants: allGrantsFor, toolContext: { browser, netGuard }, getLeash: () => leashState.get(), ledger, submit: { submit: (item) => gateQueue.submit({ ...item, runId, agentId }), log: (item) => gateQueue.log({ ...item, runId, agentId }) } }),
    ctx: { runId, turn: 1 },
  });
  const ofType = (t) => events.filter((e) => e.type === t).map((e) => e.payload);
  return { dir, store, bus, events, ofType, clock, ledger, leashState, gateQueue, trails, browser, driver, purchases, workspaceRoot, gateFor, cleanup: async () => { await purchases.close(); await browser.close(); await fsp.rm(dir, { recursive: true, force: true }); } };
}

test('purchases, pure: the supplier host, the executor choice, the brief that forbids paying, the charge matcher', () => {
  assert.equal(supplierHost('https://Supplier.Example/shop?x=1'), 'supplier.example');
  assert.equal(supplierHost('not a url'), null);
  const layout = layoutWithOffice();
  assert.equal(pickExecutor(layout, { venture: 'lantern-co', requesterId: 'ranger' }).agent.id, 'driver');
  assert.equal(pickExecutor(layout, { venture: 'other', requesterId: 'ranger' }).agent.id, 'driver', 'a Ranger of another venture still drives when none serves this one');
  assert.equal(pickExecutor(layout, { venture: 'lantern-co', requesterId: 'driver' }).agent.id, 'ranger', 'the station Ranger stands in the zone with the office');
  const alone = defaultLayout();
  alone.objects.push({ id: 'office', kind: 'field_office', roomId: 'ranger-station', x: 2, y: 2 });
  assert.match(pickExecutor(alone, { venture: 'x', requesterId: 'ranger' }).error.message, /other than the requester/);
  assert.match(pickExecutor(layout, { venture: 'x', requesterId: 'ranger', toAgentId: 'ranger' }).error.message, /not a Ranger standing in a Field office zone other than the requester/);
  assert.equal(pickExecutor(layout, { venture: 'x', toAgentId: 'ranger' }).agent.id, 'ranger', 'the Superintendent may name the station Ranger; it stands in the zone with the office');
  assert.match(pickExecutor(defaultLayout(), { venture: 'x' }).error.message, /place a Field office/);
  const brief = purchaseBrief({ id: 'buy-1', venture: 'lantern-co', supplierUrl: `${SUPPLIER}/`, items: REQUEST.items, amountUsd: 42, currency: 'USD', note: 'ship to the station' });
  assert.match(brief, /PURCHASE buy-1 for venture lantern-co/);
  assert.match(brief, /2 × Rice paper roll at \$15\.00/);
  assert.match(brief, /The cart, checkout and payment pages are NOT yours/);
  assert.match(brief, /refuses any click that reads like Buy now, Confirm, Submit, Place order, Pay or Checkout/);
  assert.match(brief, /refuses every click, type or upload on them/);
  assert.match(brief, /never try another way to pay/);
  assert.match(brief, /Note from the requester: ship to the station/);
  const paid = { receipt: { paidAt: '2026-10-11T10:00:00Z' }, paidUsd: 42.5, currency: 'USD', updatedAt: Date.UTC(2026, 9, 11, 10) };
  const now = Date.UTC(2026, 9, 12);
  assert.deepEqual(matchCharge({ receipt: null, paidUsd: null }, [], { now }), { status: 'pending', note: 'not paid yet' });
  assert.equal(matchCharge(paid, [{ id: 'ch_1', source: 'cards', amountUsd: 42.5, currency: 'USD', at: '2026-10-12T08:00:00Z' }], { now }).status, 'matched');
  assert.equal(matchCharge(paid, [{ id: 'ch_1', source: 'cards', amountUsd: 42.5, at: '2026-10-12T08:00:00Z' }, { id: 'ch_2', source: 'cards', amountUsd: 42.5, at: '2026-10-12T09:00:00Z' }], { now }).status, 'unmatched');
  assert.match(matchCharge(paid, [{ id: 'ch_1', source: 'cards', amountUsd: 42.5, at: '2026-10-12T08:00:00Z' }, { id: 'ch_2', source: 'cards', amountUsd: 42.5, at: '2026-10-12T09:00:00Z' }], { now }).note, /2 charges of the same amount/);
  assert.equal(matchCharge(paid, [{ id: 'ch_1', source: 'cards', amountUsd: 42.5, at: `2026-10-${11 + RECONCILE_WINDOW_DAYS + 2}T08:00:00Z` }], { now }).status, 'unmatched', 'outside the window');
  assert.equal(matchCharge(paid, [{ id: 'ch_1', source: 'cards', amountUsd: 40, at: '2026-10-12T08:00:00Z' }], { now }).note, 'no matching charge yet');
  assert.match(matchCharge(paid, [], { now: Date.UTC(2026, 11, 1) }).note, /no matching charge within 30 days/);
});

test('ledger holds: a hold counts as reserved money and one action in its domain across days and restarts until it is settled at the paid amount or released', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-holds-'));
  try {
    const store = createStore({ root: dir });
    await store.init();
    const clock = fakeClock(Date.UTC(2026, 9, 11, 10));
    let ledger = await createLeashLedger({ store, clock }).init();
    await ledger.hold({ id: 'buy-1', domain: 'money_out', amountUsd: 42, agentId: 'driver', note: 'purchase' });
    assert.deepEqual(ledger.reservedToday('money_out'), { usd: 42, actions: 1 });
    assert.deepEqual(ledger.reservedToday('money_out', { agentId: 'driver' }), { usd: 42, actions: 1 });
    assert.deepEqual(ledger.reservedToday('money_out', { agentId: 'other' }), { usd: 0, actions: 0 });
    assert.equal(ledger.checkCap({ domain: 'money_out', amountUsd: 70, dailyCapUsd: 100 }).ok, false, 'the hold counts against the cap');
    assert.match(ledger.checkCap({ domain: 'money_out', amountUsd: 70, dailyCapUsd: 100 }).reason, /\$42\.00 reserved by actions in flight/);
    assert.equal(ledger.checkCap({ domain: 'money_out', amountUsd: 50, dailyCapUsd: 100 }).ok, true);
    await assert.rejects(ledger.hold({ id: 'buy-1', domain: 'money_out', amountUsd: 1 }), /exists/);
    await assert.rejects(ledger.hold({ id: 'buy-2', domain: 'money_out', amountUsd: NaN }), /finite amount/);
    assert.equal(ledger.summary().holds.length, 1);
    await ledger.flushed();
    // A restart and a new day: the hold is still there (it is not a day's reservation).
    clock.advance(2 * 86_400_000);
    ledger = await createLeashLedger({ store, clock }).init();
    assert.deepEqual(ledger.reservedToday('money_out'), { usd: 42, actions: 1 });
    assert.deepEqual(ledger.spentToday('money_out'), { usd: 0, actions: 0 });
    await ledger.settleHold('buy-1', { amountUsd: 42.5 });
    assert.deepEqual(ledger.reservedToday('money_out'), { usd: 0, actions: 0 });
    assert.deepEqual(ledger.spentToday('money_out'), { usd: 42.5, actions: 1 }, 'spend lands on the day it is settled, at what was paid');
    assert.deepEqual(ledger.spentToday('money_out', { agentId: 'driver' }), { usd: 42.5, actions: 1 });
    await assert.rejects(ledger.settleHold('buy-1', { amountUsd: 1 }), /no hold/);
    await ledger.hold({ id: 'buy-3', domain: 'money_out', amountUsd: 5 });
    assert.equal(await ledger.releaseHold('buy-3'), true);
    assert.equal(await ledger.releaseHold('buy-3'), false);
    assert.deepEqual(ledger.reservedToday('money_out'), { usd: 0, actions: 0 });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('purchase.request through the leash: Observe refuses, Draft waits at the Gate with the amount, approval holds the amount and delegates to the Field office Ranger; Act with cap holds without spending and sends the one over the cap to the Gate', async () => {
  assert.deepEqual(PURCHASE_TOOL_NAMES, ['purchase.request', 'purchase.receipt']);
  assert.ok(OBJECT_KINDS.field_office.grants.includes('purchase.request'));
  assert.equal(TOOL_DOMAINS['purchase.request'], 'money_out');
  const h = await harness({ leashLevel: 'draft' });
  try {
    const { gate, ctx } = h.gateFor('ranger');
    assert.ok(gate.definitions().map((d) => d.name).includes('purchase.request'));
    const pending = gate.execute({ id: 'c1', name: 'purchase.request', input: REQUEST }, ctx);
    const item = await waitUntil(() => h.gateQueue.pending()[0]);
    assert.equal(item.domain, 'money_out');
    assert.equal(item.amountUsd, 42);
    assert.equal(item.summary, 'request a $42.00 purchase for lantern-co at supplier.test');
    await h.gateQueue.resolve(item.itemId, { decision: 'approve' });
    const r = await pending;
    assert.equal(r.ok, true, r.error);
    const out = JSON.parse(r.output);
    assert.equal(out.status, 'requested');
    assert.equal(out.executor, 'driver');
    assert.equal(out.workItemId, 'work-1');
    assert.equal(out.heldUsd, 42);
    assert.deepEqual(h.ledger.reservedToday('money_out'), { usd: 42, actions: 1 }, 'held, not spent');
    assert.deepEqual(h.ledger.spentToday('money_out'), { usd: 0, actions: 1 }, 'the request is an action at $0 (settles later)');
    assert.equal(h.trails.items[0].toAgentId, 'driver');
    assert.equal(h.trails.items[0].by, 'ranger');
    assert.match(h.trails.items[0].brief, /PURCHASE buy-/);
    assert.deepEqual(h.trails.items[0].evidence, [`outbox/purchases/${out.purchaseId}.json`]);
    const ev = h.ofType('purchase.update');
    assert.equal(ev.length, 1);
    assert.deepEqual(ev[0], { purchaseId: out.purchaseId, status: 'requested', venture: 'lantern-co', amountUsd: 42, currency: 'USD', supplierHost: 'supplier.test', by: 'ranger', agentId: 'driver', reconciliation: 'pending' }, 'the work item comes after the request event');
    assert.equal(h.purchases.summary().open, 1);
    assert.equal(h.purchases.summary().heldUsd, 42);
    // Validation inside the tool is a failed call, never a thrown gate.
    const bad = await gate.execute({ id: 'c2', name: 'purchase.request', input: { ...REQUEST, items: [] } }, ctx);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /items must list 1 to 50|invalid input/);
    // A supplier on loopback or the LAN is refused by the outbound guard (a strict guard here).
    const strict = await createPurchases({ bus: h.bus, store: h.store, trails: h.trails, ledger: h.ledger, browser: h.browser, getLayout: () => layoutWithOffice(), netGuard: createNetGuard(), workspaceRoot: h.workspaceRoot, clock: h.clock, log: { error() {} } }).init();
    await assert.rejects(strict.request({ ...REQUEST, supplierUrl: 'http://127.0.0.1:9/' }, { by: 'superintendent' }), /not on the public internet/);
    await assert.rejects(strict.request({ ...REQUEST, venture: '' }, { by: 'superintendent' }), /venture is required/);
    await assert.rejects(strict.request({ ...REQUEST, amountUsd: 20000 }, { by: 'superintendent' }), /at most 10000/);
    await assert.rejects(strict.request({ ...REQUEST, items: [{ name: 'x', qty: 0 }] }, { by: 'superintendent' }), /qty must be a whole number from 1/);
    await strict.close();
    assert.equal(h.purchases.summary().open, 1, 'nothing else was created');
  } finally {
    await h.cleanup();
  }
  const o = await harness({ leashLevel: 'observe' });
  try {
    const { gate, ctx } = o.gateFor('ranger');
    const r = await gate.execute({ id: 'c1', name: 'purchase.request', input: REQUEST }, ctx);
    assert.equal(r.code, 'LEASH_OBSERVE');
    assert.deepEqual(o.ledger.holds(), []);
    assert.equal(o.trails.items.length, 0);
  } finally {
    await o.cleanup();
  }
  const c = await harness({ leashLevel: 'act_capped', capUsd: 100 });
  try {
    const { gate, ctx } = c.gateFor('ranger');
    const r1 = await gate.execute({ id: 'c1', name: 'purchase.request', input: REQUEST }, ctx);
    assert.equal(r1.ok, true, r1.error);
    assert.deepEqual(c.ledger.reservedToday('money_out'), { usd: 42, actions: 1 });
    assert.deepEqual(c.ledger.spentToday('money_out'), { usd: 0, actions: 1 });
    assert.equal(c.gateQueue.pending().length, 0, 'under the cap: no Gate item');
    const second = gate.execute({ id: 'c2', name: 'purchase.request', input: { ...REQUEST, amountUsd: 70 } }, ctx);
    const item = await waitUntil(() => c.gateQueue.pending()[0]);
    assert.match(item.reason, /daily cap for money_out is \$100; \$0\.00 used today and \$42\.00 reserved by actions in flight, this action is \$70\.00/);
    await c.gateQueue.resolve(item.itemId, { decision: 'reject', notes: 'too much' });
    assert.equal((await second).code, 'GATE_REJECT');
    assert.equal(c.purchases.summary().open, 1);
  } finally {
    await c.cleanup();
  }
});

test('the payment page is the Superintendent\'s: on a purchase run the browser hands it off and refuses every write on it after the hand-back too; the receipt needs the hand-back, settles the hold at the paid amount and writes the outbox evidence', async () => {
  const h = await harness({ leashLevel: 'act_free' });
  try {
    const p = await h.purchases.request(REQUEST, { by: 'superintendent' });
    const PID1 = p.id;
    assert.equal(p.status, 'requested');
    // The run that drives it starts (the run manager would emit this; the brief names the purchase).
    h.bus.emit(makeEvent('agent.run.start', { runId: 'run-2', agentId: 'driver', provider: 'fake', model: 'm', prompt: `PURCHASE ${PID1} for venture lantern-co`, maxTurns: 10, budgetUsd: 0.6, tools: [] }, { ts: h.clock.now() }));
    await waitUntil(() => h.purchases.get(p.id).status === 'driving');
    assert.equal(h.purchases.isPurchaseRun('run-2'), true);
    assert.equal(h.purchases.isPurchaseRun('run-9'), false);
    const { gate, ctx } = h.gateFor('driver', { runId: 'run-2' });
    const early = await gate.execute({ id: 'r0', name: 'purchase.receipt', input: { purchaseId: p.id, orderId: 'LS-1001', totalUsd: 42.5 } }, ctx);
    assert.equal(early.code, 'NOT_PAID_BY_SUPERINTENDENT');
    assert.equal((await gate.execute({ id: 'b1', name: 'browser.open', input: { url: `${SUPPLIER}/` } }, ctx)).ok, true);
    // The cart URL alone hands off (safety 2026-10-11 H3): the Ranger's part ends at "Add to
    // cart"; the Superintendent checks out and pays in the window.
    const clicking = gate.execute({ id: 'b2', name: 'browser.click', input: { text: 'Add to cart' } }, ctx);
    const waiting = await waitUntil(() => h.browser.handoffs({ pendingOnly: true })[0]);
    assert.equal(waiting.kind, 'payment');
    assert.match(waiting.reason, /checkout, cart, order or payment page/);
    await waitUntil(() => h.purchases.get(p.id).status === 'handoff');
    assert.equal(h.ofType('purchase.update').at(-1).status, 'handoff');
    // The Superintendent pays in the window and hands the page back with notes.
    h.driver.state.pay();
    h.browser.returnHandoff(waiting.handoffId, { notes: 'paid with the park card, order LS-1001' });
    const clicked = await clicking;
    assert.equal(clicked.ok, true, 'the click that led there succeeded; the hand-back came after');
    await waitUntil(() => h.purchases.get(p.id).status === 'driving');
    // Back on the handed-back cart (the fake lets us) every write is refused, a read is not.
    h.driver.state.lastPage._p.url = `${SUPPLIER}/cart`;
    const typed = await gate.execute({ id: 'b4', name: 'browser.type', input: { selector: 'input[name=cardnumber]', value: '4242' } }, ctx);
    assert.equal(typed.ok, false);
    assert.equal(typed.code, 'PAYMENT_PAGE');
    assert.match(typed.error, /never clicks, types or uploads on it/);
    const placed = await gate.execute({ id: 'b5', name: 'browser.click', input: { text: 'Place order' } }, ctx);
    assert.equal(placed.code, 'PAYMENT_PAGE');
    assert.equal(h.driver.state.typed.length, 0, 'nothing reached the page');
    assert.equal(h.driver.state.clicked.filter((c) => c.target.text === 'Place order').length, 0);
    const read = await gate.execute({ id: 'b6', name: 'browser.read', input: {} }, ctx);
    assert.equal(read.ok, true, read.error);
    const trace = await h.browser.trace('driver');
    assert.ok(trace.some((e) => e.code === 'PAYMENT_PAGE' && e.action === 'type'), 'the refusal is in the trace');
    // The confirmation page: read, shoot, file the receipt.
    h.driver.state.pay();
    assert.equal((await gate.execute({ id: 'b7', name: 'browser.read', input: {} }, ctx)).ok, true);
    assert.equal((await gate.execute({ id: 'b8', name: 'browser.screenshot', input: {} }, ctx)).ok, true);
    const wrong = h.gateFor('ranger', { runId: 'run-3' });
    const layoutNow = h.purchases.get(p.id);
    assert.equal(layoutNow.agentId, 'driver');
    await assert.rejects(h.purchases.receipt({ purchaseId: p.id, orderId: 'LS-1001', totalUsd: 42.5 }, { agentId: 'ranger', runId: 'run-3' }), /driven by driver, not ranger/);
    assert.ok(wrong.gate);
    const filed = await gate.execute({ id: 'r1', name: 'purchase.receipt', input: { purchaseId: p.id, orderId: 'LS-1001', totalUsd: 42.5, currency: 'USD', paidAt: '2026-10-11T10:05:00Z' } }, ctx);
    assert.equal(filed.ok, true, filed.error);
    const out = JSON.parse(filed.output);
    assert.equal(out.status, 'paid');
    assert.equal(out.paidUsd, 42.5);
    assert.equal(out.receipt, `outbox/purchases/${p.id}.json`);
    assert.equal(out.reconciliation, 'no_source');
    const rec = h.purchases.get(p.id);
    assert.equal(rec.receipt.orderId, 'LS-1001');
    assert.equal(rec.receipt.differsFromDeclared, 0.5);
    assert.equal(rec.receipt.handoffNotes, 'paid with the park card, order LS-1001');
    assert.equal(rec.receipt.evidence.action, undefined);
    assert.equal(rec.receipt.evidence.url, `${SUPPLIER}/confirmation`);
    assert.match(rec.receipt.evidence.screenshot, /browser-trace/);
    assert.deepEqual(h.ledger.holds(), []);
    assert.deepEqual(h.ledger.spentToday('money_out'), { usd: 42.5, actions: 1 });
    assert.deepEqual(h.ledger.spentToday('money_out', { agentId: 'driver' }), { usd: 42.5, actions: 1 });
    const json = JSON.parse(await fsp.readFile(path.join(h.workspaceRoot, 'driver', 'outbox', 'purchases', `${p.id}.json`), 'utf8'));
    assert.equal(json.purchase.receipt.orderId, 'LS-1001');
    const md = await fsp.readFile(path.join(h.workspaceRoot, 'driver', 'outbox', 'purchases', `${p.id}.md`), 'utf8');
    assert.match(md, /Paid by the Superintendent in the browser window/);
    assert.match(md, /differs from the declared amount by 0\.5/);
    const paidEv = h.ofType('purchase.update').find((e) => e.status === 'paid');
    assert.equal(paidEv.paidUsd, 42.5);
    assert.equal(paidEv.receiptPath, `outbox/purchases/${p.id}.json`);
    assert.equal(paidEv.reconciliation, 'pending');
    assert.equal(rec.reconciliation.status, 'no_source');
    assert.match(rec.reconciliation.note, /no wired connector holds the owner's outgoing charges/);
    assert.equal(h.purchases.summary().paid, 1);
    assert.equal(h.purchases.summary().unreconciled, 1);
    const again = await gate.execute({ id: 'r2', name: 'purchase.receipt', input: { purchaseId: p.id, orderId: 'LS-1001', totalUsd: 42.5 } }, ctx);
    assert.equal(again.code, 'BAD_STATE');
  } finally {
    await h.cleanup();
  }
});

test('cancel releases the hold and cancels the work item; a run that ends without a receipt fails the purchase and releases the hold; a restart keeps the records and drops orphan holds', async () => {
  const h = await harness({ leashLevel: 'act_free' });
  try {
    const a = await h.purchases.request(REQUEST, { by: 'superintendent' });
    const b = await h.purchases.request({ ...REQUEST, amountUsd: 10, toAgentId: 'ranger' }, { by: 'superintendent' });
    const PID2 = b.id;
    assert.equal(b.agentId, 'ranger');
    assert.deepEqual(h.ledger.reservedToday('money_out'), { usd: 52, actions: 2 });
    const cancelled = await h.purchases.cancel(a.id, { by: 'superintendent', reason: 'found it cheaper' });
    assert.equal(cancelled.status, 'cancelled');
    assert.deepEqual(h.trails.cancelled, ['work-1']);
    assert.deepEqual(h.ledger.reservedToday('money_out'), { usd: 10, actions: 1 });
    await assert.rejects(h.purchases.cancel(a.id), /is cancelled/);
    await assert.rejects(h.purchases.cancel('buy-none'), /no purchase/);
    h.bus.emit(makeEvent('agent.run.start', { runId: 'run-5', agentId: 'ranger', provider: 'fake', model: 'm', prompt: `PURCHASE ${PID2} for venture lantern-co`, maxTurns: 10, budgetUsd: 0.6, tools: [] }, { ts: h.clock.now() }));
    await waitUntil(() => h.purchases.get(b.id).status === 'driving');
    h.bus.emit(makeEvent('work.done', { workItemId: 'work-2', fromAgentId: 'superintendent', toAgentId: 'ranger', runId: 'run-5', status: 'done', deliverables: [], summary: 'could not find the item', spentUsd: 0.1 }, { ts: h.clock.now() }));
    await waitUntil(() => h.purchases.get(b.id).status === 'failed');
    assert.match(h.purchases.get(b.id).reason, /ended without a receipt; the hold is released/);
    assert.deepEqual(h.ledger.holds(), []);
    assert.deepEqual(h.ofType('purchase.update').map((e) => e.status), ['requested', 'requested', 'cancelled', 'driving', 'failed']);
    // Restart: records persist; a hold without a purchase is dropped, one with an open purchase kept.
    const c = await h.purchases.request({ ...REQUEST, amountUsd: 7 }, { by: 'superintendent' });
    await h.ledger.hold({ id: 'buy-orphan', domain: 'money_out', amountUsd: 99 });
    await h.purchases.close();
    const again = await createPurchases({ bus: h.bus, store: h.store, trails: h.trails, ledger: h.ledger, browser: h.browser, getLayout: () => layoutWithOffice(), workspaceRoot: h.workspaceRoot, clock: h.clock, log: { error() {} } }).init();
    assert.equal(again.list().length, 3);
    assert.deepEqual(again.list().map((p) => p.status).sort(), ['cancelled', 'failed', 'requested']);
    assert.deepEqual(h.ledger.holds().map((x) => x.id), [c.id]);
    await again.close();
  } finally {
    await h.cleanup();
  }
});

test('reconciliation: a connector that exposes outgoing charges matches a paid purchase on amount and date and emits reconciled; none wired says no_source', async () => {
  const charges = [];
  const fakeRegistry = { kinds: () => ['cards'], spec: () => ({ kind: 'cards', outgoingCharges: () => charges }), data: () => ({}) };
  const h = await harness({ leashLevel: 'act_free', connectors: fakeRegistry });
  try {
    const p = await h.purchases.request(REQUEST, { by: 'superintendent' });
    const PID1 = p.id;
    h.bus.emit(makeEvent('agent.run.start', { runId: 'run-2', agentId: 'driver', provider: 'fake', model: 'm', prompt: `PURCHASE ${PID1} for venture lantern-co`, maxTurns: 10, budgetUsd: 0.6, tools: [] }, { ts: h.clock.now() }));
    await waitUntil(() => h.purchases.get(p.id).status === 'driving');
    const { gate, ctx } = h.gateFor('driver', { runId: 'run-2' });
    await gate.execute({ id: 'b1', name: 'browser.open', input: { url: `${SUPPLIER}/` } }, ctx);
    const clicking = gate.execute({ id: 'b3', name: 'browser.click', input: { text: 'Add to cart' } }, ctx);
    const waiting = await waitUntil(() => h.browser.handoffs({ pendingOnly: true })[0]);
    h.driver.state.pay();
    h.browser.returnHandoff(waiting.handoffId, { notes: 'paid' });
    await clicking;
    await gate.execute({ id: 'b7', name: 'browser.read', input: {} }, ctx);
    const filed = await gate.execute({ id: 'r1', name: 'purchase.receipt', input: { purchaseId: p.id, orderId: 'LS-1001', totalUsd: 42.5 } }, ctx);
    assert.equal(filed.ok, true, filed.error);
    assert.equal(h.purchases.get(p.id).reconciliation.status, 'unmatched', 'a source exists but holds no charge yet');
    charges.push({ id: 'card_tx_1', amountUsd: 42.5, currency: 'USD', at: new Date(h.clock.now() + 3600_000).toISOString(), description: 'LANTERN SUPPLY CO' });
    h.bus.emit(makeEvent('connector.sync', { connector: 'cards', status: 'done', reason: 'manual' }, { ts: h.clock.now() }));
    await waitUntil(() => h.purchases.get(p.id).reconciliation.status === 'matched');
    assert.equal(h.purchases.get(p.id).reconciliation.chargeId, 'card_tx_1');
    assert.equal(h.ofType('purchase.update').at(-1).status, 'reconciled');
    assert.equal(h.ofType('purchase.update').at(-1).reconciliation, 'matched');
    assert.equal(h.purchases.summary().unreconciled, 0);
    assert.deepEqual(h.purchases.summary().sources, ['cards']);
  } finally {
    await h.cleanup();
  }
});

test('over HTTP, end to end: the Superintendent requests a purchase, the Field office Ranger\'s worker drives the fake supplier to checkout, the payment page waits for the Superintendent, the receipt settles the ledger and the work item closes with the deliverable', async () => {
  const driver = fakeBrowserDriver();
  const layout = layoutWithOffice();
  const seen = [];
  const worker = fakeProvider(Array(12).fill((req) => {
    const turn = req.messages.length;
    seen.push(turn);
    if (turn === 1) return [...toolCall('t1', 'browser.open', { url: `${SUPPLIER}/` }), end('tool_use')];
    if (turn === 3) return [...toolCall('t2', 'browser.click', { text: 'Add to cart' }), end('tool_use')];
    if (turn === 5) return [...toolCall('t3', 'browser.click', { text: 'Checkout' }), end('tool_use')];
    if (turn === 7) return [...toolCall('t4', 'browser.type', { selector: 'input[name=cardnumber]', value: '4242' }), end('tool_use')];
    if (turn === 9) return [...toolCall('t5', 'browser.read', {}), end('tool_use')];
    if (turn === 11) {
      const id = (/PURCHASE (buy-[0-9a-f]+)/.exec(req.messages[0].content[0].text) || [])[1];
      return [...toolCall('t6', 'purchase.receipt', { purchaseId: id, orderId: 'LS-1001', totalUsd: 42.5, currency: 'USD' }), end('tool_use')];
    }
    return [text('Receipt filed.'), end()];
  }));
  const srv = await startTestServer({ makeProvider: async (name, opts) => ({ provider: worker, model: opts.model || 'm', price: { inputPerMTok: 1, outputPerMTok: 1 } }), layout, browser: { chromiumPath: '/fake/chromium', driver }, leash: (() => { const l = defaultLeash(); l.domains.browser_control = { level: 'act_free' }; l.domains.money_out = { level: 'act_capped', dailyCapUsd: 100 }; return l; })() });
  const events = [];
  srv.bus.listen((e) => events.push(e));
  try {
    const state0 = await srv.get('/api/state');
    assert.deepEqual(state0.body.purchases, { open: 0, heldUsd: 0, paid: 0, paidUsd: 0, unreconciled: 0, sources: [], recent: [] });
    const bad = await srv.post('/api/purchases', { ...REQUEST, amountUsd: 0 });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'BAD_REQUEST');
    const r = await srv.post('/api/purchases', { ...REQUEST, toAgentId: 'driver' });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const p = r.body;
    assert.ok(['requested', 'driving'].includes(p.status), 'the run may already have started when the answer comes back');
    assert.equal(p.agentId, 'driver');
    assert.ok(p.workItemId);
    assert.equal(srv.ledger.reservedToday('money_out').usd, 42);
    // The run drives to the payment page and parks there.
    const waiting = await waitUntil(() => events.find((e) => e.type === 'browser.handoff' && e.payload.status === 'waiting'), { tries: 500 });
    assert.equal(waiting.payload.kind, 'payment');
    assert.equal((await srv.get('/api/purchases')).body.purchases[0].status, 'handoff');
    assert.equal(driver.state.typed.length, 0);
    // The Superintendent hands the page back (still the payment page: the worker's next move
    // is a type on it, refused); the payment itself happens in the window once that refusal
    // is on the record, so the worker's read then finds the confirmation.
    srv.bus.listen((e) => { if (e.type === 'agent.tool_result' && e.payload.name === 'browser.type') driver.state.pay(); });
    const back = await srv.post(`/api/browser/handoff/${waiting.payload.handoffId}/return`, { notes: 'paid, order LS-1001' });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    await srv.runs.waitForIdle();
    const list = (await srv.get('/api/purchases')).body;
    assert.equal(list.purchases[0].status, 'paid', JSON.stringify(list.purchases[0].history));
    assert.equal(list.purchases[0].paidUsd, 42.5);
    assert.equal(list.purchases[0].reconciliation.status, 'no_source');
    assert.equal(list.paidUsd, 42.5);
    assert.deepEqual(srv.ledger.holds(), []);
    assert.deepEqual(srv.ledger.spentToday('money_out'), { usd: 42.5, actions: 1 });
    assert.equal(driver.state.typed.length, 0, 'the card number never reached the page');
    const results = events.filter((e) => e.type === 'agent.tool_result').map((e) => e.payload);
    const typeResult = results.find((e) => e.name === 'browser.type');
    assert.equal(typeResult.ok, false);
    assert.match(typeResult.error, /payment page is the Superintendent's/);
    const item = srv.trails.get(p.workItemId);
    assert.equal(item.status, 'done');
    assert.ok(item.deliverables.includes(`outbox/purchases/${p.id}.json`), JSON.stringify(item.deliverables));
    assert.deepEqual(events.filter((e) => e.type === 'purchase.update').map((e) => e.payload.status), ['requested', 'driving', 'handoff', 'driving', 'paid']);
    const state = await srv.get('/api/state');
    assert.equal(state.body.purchases.paid, 1);
    assert.equal(state.body.ledger.holds.length, 0);
    const reconciled = await srv.post('/api/purchases/reconcile', {});
    assert.equal(reconciled.status, 200);
    assert.equal(reconciled.body.unreconciled, 1);
    const cancelDone = await srv.post(`/api/purchases/${p.id}/cancel`, {});
    assert.equal(cancelDone.status, 409);
  } finally {
    await srv.close();
  }
});
