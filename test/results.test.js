// Phase 4 step 9: the results engine. Pure economics and the Chief rules, the sparkline
// geometry, the engine over fake ledgers and connector stores, the reflection reading its
// verdicts and delegating a kill, and the routes through the sidecar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createStore } from '../sidecar/store.js';
import { createEventBus } from '../sidecar/bus.js';
import { createRunManager } from '../sidecar/runs.js';
import { createTrails } from '../sidecar/trails.js';
import { createChief } from '../sidecar/chief.js';
import { createScheduler } from '../sidecar/scheduler.js';
import { createReflect } from '../sidecar/reflect.js';
import { createResults, economics, proposeFor, emptyRow, RULES, ATTRIBUTED_TOOLS } from '../sidecar/results.js';
import { createLayoutState } from '../sidecar/server.js';
import { createAgents } from '../sidecar/agents.js';
import { createLeashLedger, createLeashState } from '../sidecar/leash-ledger.js';
import { localDayKey } from '../sidecar/leash-ledger.js';
import { createGateQueue } from '../sidecar/gate-queue.js';
import { createRouter, defaultPolicy } from '../sidecar/router.js';
import { TOOLS } from '../sidecar/capability/tools.js';
import { CREW_TOOLS } from '../sidecar/capability/crew.js';
import { sparklineGeometry } from '../frontend/ui/sparkline.js';
import { initialState, applySnapshot, applyEvent } from '../frontend/state.js';
import { defaultLayout } from '../shared/world.js';
import { defaultLeash } from '../shared/leash.js';
import { makeEvent } from '../shared/events.js';
import { fakeProvider, fakeClock, text, end, waitUntil } from './helpers/fake-provider.js';
import { startTestServer } from './helpers/test-server.js';
import { startFakeStripe } from './helpers/fake-stripe.js';
import { startFakeMetaAds } from './helpers/fake-meta-ads.js';
import { stripeSpec } from '../sidecar/connectors/stripe.js';
import { metaAdsSpec } from '../sidecar/connectors/meta-ads.js';

const day = (d) => ({ day: d, ...emptyRow() });
const withRow = (d, over) => ({ ...day(d), ...over });

test('economics: nulls stay "no data", contribution uses the known components, payback is the first covering day', () => {
  const e0 = economics([day('2026-10-01'), day('2026-10-02')]);
  assert.equal(e0.revenue, null);
  assert.equal(e0.contribution, null);
  assert.equal(e0.contributionPerOrder, null);
  assert.equal(e0.payback, null);
  assert.deepEqual(e0.unknown, ['revenue', 'refunds', 'fees', 'adSpend']);
  const rows = [withRow('2026-10-01', { revenue: 10, orders: 1, adSpend: 8, modelSpend: 4 }), withRow('2026-10-02', { revenue: 30, orders: 2, adSpend: 5, modelSpend: 1, refunds: 2 })];
  const e = economics(rows);
  assert.equal(e.revenue, 40);
  assert.equal(e.orders, 3);
  assert.equal(e.refunds, 2);
  assert.equal(e.fees, null);
  assert.deepEqual(e.unknown, ['fees']);
  assert.equal(e.contribution, 40 - 2 - 13);
  assert.equal(e.net, 40 - 2 - 13 - 5);
  assert.equal(e.contributionPerOrder, Number(((40 - 2 - 13) / 3).toFixed(4)));
  assert.equal(e.modelCostPerOrder, Number((5 / 3).toFixed(4)));
  assert.deepEqual(e.payback, { reached: true, day: '2026-10-02' }); // day 1: 10 < 12; day 2: 38 ≥ 18
  const noOrders = economics([withRow('2026-10-01', { revenue: 0, orders: 0, adSpend: 3 })]);
  assert.equal(noOrders.contributionPerOrder, null);
  assert.deepEqual(noOrders.payback, { reached: false, day: null });
});

test('the Chief rules: no_data, kill on no orders, kill on a sustained loss, scale, hold', () => {
  const v = { id: 'v', budgetUsd: 10 };
  const days = (n, over) => Array.from({ length: n }, (_, i) => withRow(`2026-10-${String(i + 1).padStart(2, '0')}`, typeof over === 'function' ? over(i) : over));
  // Nothing recorded at all.
  assert.equal(proposeFor(v, []).verdict, 'no_data');
  // Model spend only, no connector: no_data, with the days observed.
  const nd = proposeFor(v, days(10, { modelSpend: 0.2 }));
  assert.equal(nd.verdict, 'no_data');
  assert.match(nd.because[0], /10 day\(s\) observed/);
  // Kill A: a week of spend with revenue known and no orders, over half the budget gone.
  const killA = proposeFor(v, days(7, { revenue: 0, orders: 0, adSpend: 1, modelSpend: 0.1 }));
  assert.equal(killA.verdict, 'kill');
  assert.match(killA.because[0], /0 orders in the last 7 day\(s\) while spending \$7\.70/);
  assert.match(killA.because[1], /\$7\.70 of the \$10\.00 budget spent \(77 %\)/);
  // Same spend but under half the budget: hold.
  assert.equal(proposeFor({ id: 'v', budgetUsd: 100 }, days(7, { revenue: 0, orders: 0, adSpend: 1, modelSpend: 0.1 })).verdict, 'hold');
  // Fewer than 7 days: hold, and it says so.
  const young = proposeFor(v, days(5, { revenue: 0, orders: 0, adSpend: 2 }));
  assert.equal(young.verdict, 'hold');
  assert.ok(young.because.some((b) => /fewer than 7 days observed/.test(b)));
  // Kill B: two weeks selling at a loss with three quarters of the budget gone.
  const killB = proposeFor(v, days(14, { revenue: 1, orders: 1, refunds: 0, fees: 0, adSpend: 1, modelSpend: 0.1 }));
  assert.equal(killB.verdict, 'kill');
  assert.match(killB.because[0], /net \$-0\.70 over the last 7 day\(s\)/);
  // Scale: orders, every component known, a positive net and payback reached.
  const scale = proposeFor(v, days(8, (i) => ({ revenue: i < 2 ? 0 : 20, orders: i < 2 ? 0 : 2, refunds: 0, fees: 1, adSpend: 3, modelSpend: 0.5 })));
  assert.equal(scale.verdict, 'scale');
  assert.match(scale.because[0], /order\(s\) in the last 7 day\(s\), net \$/);
  assert.match(scale.because[2], /payback reached on 2026-10-03/);
  // Scale refused while a component is unknown (fees here): hold, naming it.
  const partial = proposeFor(v, days(8, { revenue: 20, orders: 2, refunds: 0, adSpend: 3, modelSpend: 0.5 }));
  assert.equal(partial.verdict, 'hold');
  assert.ok(partial.because.some((b) => /fees unknown/.test(b)));
  assert.equal(partial.numbers.windowOrders, 14);
});

test('sparkline geometry: gaps for nulls, a flat line, nothing for no data', () => {
  const g = sparklineGeometry([1, 2, null, 4, 8], { w: 100, h: 20 });
  assert.equal(g.segments.length, 2);
  assert.deepEqual(g.gaps, [2]);
  assert.equal(g.min, 1);
  assert.equal(g.max, 8);
  assert.equal(g.last, 8);
  assert.match(g.path, /^M2 .* L.* M.* L/);
  const flat = sparklineGeometry([3, 3, 3]);
  assert.equal(flat.segments.length, 1);
  assert.ok(flat.points.every((p) => p.y === flat.points[0].y));
  const none = sparklineGeometry([null, null]);
  assert.equal(none.points.length, 0);
  assert.equal(none.last, null);
  assert.deepEqual(none.gaps, [0, 1]);
});

// ---- the engine over fakes ----

const PRICE = { inputPerMTok: 4, outputPerMTok: 20 };

async function harness({ reflectScript = null, connectors = null, mail = null } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-results-'));
  const home = path.join(dir, 'home');
  const workspaceRoot = path.join(dir, 'ws');
  await fsp.mkdir(workspaceRoot, { recursive: true });
  const store = createStore({ root: home });
  await store.init();
  const bus = createEventBus();
  const events = [];
  bus.listen((e) => events.push(e));
  const clock = fakeClock(Date.UTC(2026, 9, 10, 12, 0, 0)); // 2026-10-10 noon UTC
  const layoutState = createLayoutState({ initial: defaultLayout(), store, bus, clock });
  const agents = createAgents({ layoutState, bus, clock });
  const ledger = await createLeashLedger({ store, clock }).init();
  const leashState = createLeashState({ initial: defaultLeash(), store });
  const gateQueue = await createGateQueue({ bus, store, ledger, leashState, getLayout: layoutState.get, clock }).init();
  const judgeProvider = fakeProvider(reflectScript ? reflectScript() : [], { name: 'anthropic' });
  const worker = fakeProvider([[text('worker: paused as asked'), end('end_turn', { inputTokens: 10, outputTokens: 5 })], [text('worker: paused as asked'), end('end_turn', { inputTokens: 10, outputTokens: 5 })]], { name: 'ollama' });
  const makeProvider = async (name, opts) => (name === 'anthropic' ? { provider: judgeProvider, model: opts.model || 'judge', price: PRICE } : { provider: worker, model: 'w', price: null });
  const toolContext = {};
  const registry = { ...TOOLS, ...CREW_TOOLS };
  const router = createRouter(defaultPolicy());
  const runs = createRunManager({ bus, store, getLayout: layoutState.get, workspaceRoot, makeProvider, clock, agents, toolContext, registry, ledger, gateQueue, leashState, policy: defaultPolicy(), maxConcurrent: 3 });
  const trails = await createTrails({ bus, store, runs, agents, getLayout: layoutState.get, clock, workspaceRoot }).init();
  toolContext.trails = trails;
  const chief = await createChief({ bus, store, runs, agents, trails, ledger, router, getLayout: layoutState.get, clock, workspaceRoot, maxFollowUps: 5, log: { error() {} } }).init();
  const chiefStarts = [];
  chief.followUp = async (ev) => { chiefStarts.push(ev.payload); return null; };
  Object.assign(registry, chief.tools);
  const scheduler = await createScheduler({ store, clock, tickMs: 60_000, log: { error() {} } }).init();
  const results = await createResults({ bus, store, agents, trails, chief, ledger, gateQueue, getConnectors: () => connectors, getMail: () => mail, getLayout: layoutState.get, clock, log: { error() {} } }).init();
  const reflect = await createReflect({ bus, store, runs, agents, trails, chief, ledger, gateQueue, router, scheduler, makeProvider, getLayout: layoutState.get, clock, workspaceRoot, env: {}, schedule: { daily: '07:00' }, getResults: () => results, log: { error() {} } }).init();
  return { dir, home, store, bus, events, clock, runs, trails, agents, chief, ledger, results, reflect, chiefStarts, layoutState, cleanup: async () => { runs.cancel(); await runs.waitForIdle(); await results.close(); await fsp.rm(dir, { recursive: true, force: true }); } };
}

async function seedPlan(h, { budgetUsd = 3 } = {}) {
  await h.agents.ensureChief();
  await h.store.saveMission({ id: 'mission-1', text: 'Sell lanterns', budgetUsd: 5, horizon: '30 days', status: 'active', reason: '', createdAt: h.clock.now(), followUps: 0, runIds: [] });
  await h.store.savePlan({ id: 'plan-1', missionId: 'mission-1', version: 1, submittedAt: h.clock.now(), by: 'chief-ranger', runId: '', summary: 'One venture.', ventures: [{ id: 'lantern-co', name: 'Lantern Co', summary: 'lanterns', budgetUsd, roles: [], tasks: [] }], history: [] });
  await h.chief.init();
  const marketing = await h.agents.ensureZone('marketing');
  const ads = await h.agents.create({ name: 'Ada', zoneId: marketing.id, parentAgentId: 'chief-ranger', specialty: 'ads', venture: 'lantern-co' }, { by: 'chief-ranger' });
  const listings = await h.agents.ensureZone('product_listings');
  const shop = await h.agents.create({ name: 'Sam', zoneId: listings.id, parentAgentId: 'chief-ranger', specialty: 'storefront', venture: 'lantern-co' }, { by: 'chief-ranger' });
  return { ads, shop };
}

// A stand-in for the connector registry: `data(kind)` as the syncs would have stored it.
function fakeConnectors(stores) {
  return { data: (kind) => stores[kind] || { syncedAt: null }, list: () => Object.keys(stores).map((kind) => ({ kind, label: kind, connected: true, summary: 'fake', syncedAt: stores[kind].syncedAt })) };
}

test('the engine: model spend by tier from the bus and from stored runs, attribution from tool results, rollups from connector stores, mail, items and the Gate', async () => {
  const syncedAt = Date.UTC(2026, 9, 10, 11);
  const stores = {
    shopify: { syncedAt, shop: { currency: 'USD' }, products: [{ id: 1, title: 'Lantern', status: 'active', variants: [{ id: 11 }] }, { id: 2, title: 'Other', status: 'active', variants: [{ id: 22 }] }], orders: [
      { id: 100, createdAt: '2026-10-08T10:00:00Z', financialStatus: 'paid', totalPrice: '45.00', currency: 'USD', lineItems: [{ title: 'Lantern', quantity: 2, price: '20.00', variantId: 11 }] },
      { id: 101, createdAt: '2026-10-09T10:00:00Z', financialStatus: 'paid', totalPrice: '30.00', currency: 'USD', lineItems: [{ title: 'Other', quantity: 1, price: '30.00', variantId: 22 }] },
      { id: 102, createdAt: '2026-10-09T12:00:00Z', financialStatus: 'pending', totalPrice: '99.00', currency: 'USD', lineItems: [] },
    ] },
    stripe: { syncedAt, balance: {}, charges: [{ id: 'ch_1', created: Date.UTC(2026, 9, 8, 10), amount: 4500, fee: 161, currency: 'usd', status: 'succeeded', paid: true }], refunds: [{ id: 're_1', created: Date.UTC(2026, 9, 9, 10), amount: 500, currency: 'usd', status: 'succeeded' }], payouts: [] },
    meta_ads: { syncedAt, account: { currency: 'USD' }, campaigns: [{ id: 'c1', name: 'Lanterns', effectiveStatus: 'ACTIVE' }, { id: 'c9', name: 'Someone else', effectiveStatus: 'ACTIVE' }], insights: { rows: [], daily: [{ date: '2026-10-08', campaignId: 'c1', spend: 12.25 }, { date: '2026-10-09', campaignId: 'c1', spend: 11.75 }, { date: '2026-10-09', campaignId: 'c9', spend: 5 }] } },
  };
  const mailIndex = [
    { id: 'm1', direction: 'in', date: Date.UTC(2026, 9, 9, 9), venture: 'lantern-co', agentId: null, kind: null, status: 'received' },
    { id: 'm2', direction: 'out', date: Date.UTC(2026, 9, 9, 10), venture: null, agentId: 'ADS', kind: null, status: 'sent' },
    { id: 'm3', direction: 'in', date: Date.UTC(2026, 9, 9, 11), venture: 'lantern-co', agentId: null, kind: 'briefing', status: 'received' },
  ];
  const h = await harness({ connectors: fakeConnectors(stores), mail: { mailStore: { list: () => mailIndex } } });
  try {
    const { ads, shop } = await seedPlan(h);
    mailIndex[1].agentId = ads.id;
    // A stored run the live listener never saw: seeded at init.
    await h.store.saveRun({ runId: 'old-run', agentId: ads.id, provider: 'ollama', model: 'w', status: 'ended', startedAt: Date.UTC(2026, 9, 8, 9), prompt: 'x', spentUsd: 0.5, events: [makeEvent('cost.estimate', { runId: 'old-run', turn: 1, provider: 'anthropic', model: 'judge', inputTokens: 1, outputTokens: 1, usd: 0.5, reconciled: true, tier: 'judge' }, { ts: Date.UTC(2026, 9, 8, 9, 1) })] });
    await h.results.init();
    // Live events: a run start, a worker turn (unpriced), a judge turn, a hosted turn, and the
    // tool results that attribute the campaign, the product and the refund to Lantern Co.
    const ts = h.clock.now();
    h.bus.emit(makeEvent('agent.run.start', { runId: 'r1', agentId: ads.id, provider: 'ollama', model: 'w', prompt: 'x', maxTurns: 4, budgetUsd: 1, tools: [] }, { ts }));
    h.bus.emit(makeEvent('cost.estimate', { runId: 'r1', turn: 1, provider: 'ollama', model: 'w', inputTokens: 10, outputTokens: 5, usd: null, reconciled: false, tier: 'worker' }, { ts }));
    h.bus.emit(makeEvent('cost.estimate', { runId: 'r1', turn: 1, provider: 'anthropic', model: 'judge', inputTokens: 100, outputTokens: 10, usd: 0.02, reconciled: true, tier: 'judge' }, { ts }));
    h.bus.emit(makeEvent('cost.estimate', { runId: 'r1', turn: 2, provider: 'huggingface', model: 'q', inputTokens: 100, outputTokens: 10, usd: null, reconciled: false, tier: 'hosted_worker' }, { ts }));
    h.bus.emit(makeEvent('agent.tool_result', { runId: 'r1', turn: 1, callId: 'c1', name: 'meta_ads.create_campaign', ok: true, output: JSON.stringify({ id: 'c1', name: 'Lanterns' }) }, { ts }));
    h.bus.emit(makeEvent('agent.tool_result', { runId: 'r1', turn: 1, callId: 'c2', name: 'meta_ads.create_campaign', ok: false, error: 'nope' }, { ts }));
    h.bus.emit(makeEvent('agent.run.start', { runId: 'r2', agentId: shop.id, provider: 'ollama', model: 'w', prompt: 'x', maxTurns: 4, budgetUsd: 1, tools: [] }, { ts }));
    h.bus.emit(makeEvent('agent.tool_result', { runId: 'r2', turn: 1, callId: 'c3', name: 'shopify.create_product', ok: true, output: JSON.stringify({ id: 1, title: 'Lantern', variants: [{ id: 11 }] }) }, { ts }));
    h.bus.emit(makeEvent('agent.tool_result', { runId: 'r2', turn: 1, callId: 'c4', name: 'stripe.refund', ok: true, output: JSON.stringify({ id: 're_1', amount: 500 }) }, { ts }));
    // A reflection's own cost (no run) lands on the Chief.
    h.bus.emit(makeEvent('cost.estimate', { runId: 'reflection-2026-10-10-abc', turn: 1, provider: 'anthropic', model: 'judge', inputTokens: 1, outputTokens: 1, usd: 0.1, reconciled: true, tier: 'judge' }, { ts }));
    await h.results.close();
    const att = h.results.attribution();
    assert.equal(att.meta_ads.campaign.c1.venture, 'lantern-co');
    assert.equal(att.shopify.variant['11'].venture, 'lantern-co');
    assert.equal(att.shopify.product['1'].agentId, shop.id);
    assert.equal(att.stripe.refund.re_1.venture, 'lantern-co');
    assert.ok(!att.meta_ads.campaign.c9);

    const c = h.results.compute();
    const today = localDayKey(h.clock.now());
    const d8 = c.days.find((d) => d.day === '2026-10-08');
    const d9 = c.days.find((d) => d.day === '2026-10-09');
    const dToday = c.days.find((d) => d.day === today);
    // Park: order totals, the fee from Stripe, the refund, ad spend from both campaigns.
    assert.equal(d8.park.revenue, 45);
    assert.equal(d8.park.orders, 1);
    assert.equal(d8.park.fees, 1.61);
    assert.equal(d8.park.adSpend, 12.25);
    assert.equal(d9.park.revenue, 30);
    assert.equal(d9.park.refunds, 5);
    assert.equal(d9.park.adSpend, 16.75);
    assert.ok(d9.park.notes.includes('Shopify refund amounts are not synced') || c.days.some((d) => d.park.notes.includes('Shopify refund amounts are not synced')));
    // Venture: only the attributed line items, campaign and refund; the pending order never counts.
    const v8 = d8.ventures['lantern-co'];
    const v9 = d9.ventures['lantern-co'];
    assert.equal(v8.revenue, 40);
    assert.equal(v8.orders, 1);
    assert.equal(v8.adSpend, 12.25);
    assert.equal(v8.fees, null, 'fees are never attributed to a venture');
    assert.equal(v9.revenue, 0, 'a day with sales the venture had none of is a known 0');
    assert.equal(v9.orders, 0);
    assert.equal(v9.refunds, 5);
    assert.equal(v9.adSpend, 11.75, 'the other campaign is not Lantern Co');
    assert.equal(v9.mailIn, 1, 'the briefing is internal and not counted');
    assert.equal(v9.mailOut, 1, "Ada's outbound mail counts for her venture");
    // Model spend by tier: the seeded judge turn on the 8th, today's judge turn on the venture,
    // the unpriced worker and hosted turns counted, the reflection's cost on the Chief only.
    assert.equal(v8.modelSpend, 0.5);
    assert.equal(v8.modelSpendByTier.judge, 0.5);
    assert.equal(dToday.ventures['lantern-co'].modelSpend, 0.02);
    assert.equal(dToday.ventures['lantern-co'].unpricedTurns, 2);
    assert.equal(dToday.ventures['lantern-co'].hostedCalls, 1);
    assert.equal(dToday.park.modelSpend, 0.12, 'rows are rounded to 6 decimals');
    assert.equal(dToday.agents['chief-ranger'].modelSpendByTier.judge, 0.1);
    assert.equal(c.agents[ads.id].all.modelSpend, 0.52);
    assert.equal(c.agents[shop.id].all.modelSpend, 0);
    // Economics and the rule: two days observed with orders: hold, fewer than 7 days.
    const v = c.ventures[0];
    assert.equal(v.all.revenue, 40);
    assert.equal(v.all.orders, 1);
    assert.equal(v.proposal.verdict, 'hold');
    assert.ok(v.proposal.because.some((b) => /fewer than 7 days/.test(b)));
    assert.equal(v.spentUsd, Number((24 + 0.52).toFixed(4)));
    assert.deepEqual(c.sources, { shopify: true, etsy: false, stripe: true, meta_ads: true, google_ads: false, mail: true });

    // The rollup persists the days and emits the event with today's figures and the verdict.
    await h.results.rollup({ reason: 'test' });
    const ev = h.events.filter((e) => e.type === 'results.rollup').at(-1);
    assert.equal(ev.payload.day, today);
    assert.equal(ev.payload.park.modelSpend, 0.12);
    assert.equal(ev.payload.park.revenue, 0, 'a synced storefront with no sale today is a known 0');
    assert.equal(ev.payload.ventures[0].id, 'lantern-co');
    assert.deepEqual(ev.payload.proposals[0], { venture: 'lantern-co', verdict: 'hold', because: v.proposal.because });
    const saved = JSON.parse(await fsp.readFile(path.join(h.home, 'results.json'), 'utf8'));
    assert.equal(saved.days['2026-10-08'].ventures['lantern-co'].revenue, 40);
    assert.equal(saved.lastRollup.reason, 'test');
    assert.ok(saved.counted['old-run'] && saved.counted.r1);
    // The kill plan: the attributed active campaign and product, each with its Ranger.
    const plan = h.results.killPlan('lantern-co');
    assert.deepEqual(plan.map((s) => [s.tool, s.agentId]), [['meta_ads.set_status', ads.id], ['shopify.update_product', shop.id]]);
    assert.deepEqual(plan[0].input, { campaignId: 'c1', status: 'PAUSED' });
    assert.deepEqual(plan[1].input, { productId: 1, status: 'draft' });
    // The summary carries the series the Peak draws.
    const sum = h.results.summary();
    assert.ok(sum.ventures[0].series.some((r) => r.day === '2026-10-08' && r.revenue === 40));
    assert.equal(sum.parkSeries.find((r) => r.day === '2026-10-09').adSpend, 16.75);
    // A restart reads the persisted model ledger and attribution back; nothing is counted twice.
    const again = await createResults({ bus: createEventBus(), store: h.store, agents: h.agents, trails: h.trails, chief: h.chief, ledger: h.ledger, gateQueue: null, getConnectors: () => fakeConnectors(stores), getMail: () => null, getLayout: h.layoutState.get, clock: h.clock, log: { error() {} } }).init();
    assert.equal(again.compute().agents[ads.id].all.modelSpend, 0.52);
    assert.equal(again.attribution().meta_ads.campaign.c1.venture, 'lantern-co');
  } finally {
    await h.cleanup();
  }
});

test('no connector: every money figure is "no data" and the verdict is no_data, never zero', async () => {
  const h = await harness({ connectors: null, mail: null });
  try {
    const { ads } = await seedPlan(h);
    h.bus.emit(makeEvent('agent.run.start', { runId: 'r1', agentId: ads.id, provider: 'ollama', model: 'w', prompt: 'x', maxTurns: 4, budgetUsd: 1, tools: [] }, { ts: h.clock.now() }));
    h.bus.emit(makeEvent('cost.estimate', { runId: 'r1', turn: 1, provider: 'anthropic', model: 'judge', inputTokens: 100, outputTokens: 10, usd: 0.02, reconciled: true, tier: 'judge' }, { ts: h.clock.now() }));
    const c = await h.results.rollup({ reason: 'test' });
    const v = c.ventures[0];
    assert.equal(v.window.revenue, null);
    assert.equal(v.window.adSpend, null);
    assert.equal(v.window.orders, null);
    assert.equal(v.window.modelSpend, 0.02);
    assert.equal(v.proposal.verdict, 'no_data');
    assert.match(v.proposal.because[0], /no storefront, payment or ad connector has synced/);
    const ev = h.events.filter((e) => e.type === 'results.rollup').at(-1);
    assert.equal(ev.payload.ventures[0].revenue, null);
    assert.equal(ev.payload.park.orders, null);
  } finally {
    await h.cleanup();
  }
});

test('the reflection reads the verdict and a kill delegates the pauses to the venture\'s Rangers, once', async () => {
  // A week of ad spend on an attributed campaign, a storefront that sold nothing: kill A.
  const syncedAt = Date.UTC(2026, 9, 10, 11);
  const daily = ['2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'].map((date) => ({ date, campaignId: 'c1', spend: 0.3 }));
  const stores = {
    shopify: { syncedAt, shop: { currency: 'USD' }, products: [{ id: 1, title: 'Lantern', status: 'active', variants: [{ id: 11 }] }], orders: [] },
    meta_ads: { syncedAt, account: { currency: 'USD' }, campaigns: [{ id: 'c1', name: 'Lanterns', effectiveStatus: 'ACTIVE' }], insights: { rows: [], daily } },
  };
  const REFLECTION = { portfolio: 'Lantern Co: 0 orders in 7 days on $2.10 of ads; the rule says kill and I agree.', ventures: [{ id: 'lantern-co', worked: [], didNot: ['0 orders in 7 days'], planStillRight: false, revisions: ['Pause the campaign and the listing; re-scout the niche'], morale: '0 orders on $2.10 of spend.' }], briefings: [] };
  const h = await harness({ connectors: fakeConnectors(stores), reflectScript: () => [[text(JSON.stringify(REFLECTION)), end('end_turn', { inputTokens: 100, outputTokens: 50 })], [text(JSON.stringify(REFLECTION)), end('end_turn', { inputTokens: 100, outputTokens: 50 })]] });
  try {
    const { ads, shop } = await seedPlan(h, { budgetUsd: 3 });
    const ts = h.clock.now();
    h.bus.emit(makeEvent('agent.run.start', { runId: 'r1', agentId: ads.id, provider: 'ollama', model: 'w', prompt: 'x', maxTurns: 4, budgetUsd: 1, tools: [] }, { ts }));
    h.bus.emit(makeEvent('agent.tool_result', { runId: 'r1', turn: 1, callId: 'c1', name: 'meta_ads.create_campaign', ok: true, output: JSON.stringify({ id: 'c1' }) }, { ts }));
    h.bus.emit(makeEvent('agent.run.start', { runId: 'r2', agentId: shop.id, provider: 'ollama', model: 'w', prompt: 'x', maxTurns: 4, budgetUsd: 1, tools: [] }, { ts }));
    h.bus.emit(makeEvent('agent.tool_result', { runId: 'r2', turn: 1, callId: 'c2', name: 'shopify.create_product', ok: true, output: JSON.stringify({ id: 1, variants: [{ id: 11 }] }) }, { ts }));
    await h.results.close();
    assert.equal(h.results.proposals()[0].verdict, 'kill');
    const doc = await h.reflect.reflect({ reason: 'manual' });
    assert.equal(doc.status, 'posted');
    // The prompt carried the actuals and the verdict; the document records both.
    const prompt = h.events.find((e) => e.type === 'results.rollup');
    assert.ok(prompt, 'the reflection rolled the results up first');
    const req = h.events.filter((e) => e.type === 'cost.estimate').find((e) => /^reflection-/.test(e.payload.runId));
    assert.ok(req);
    assert.equal(doc.proposals[0].verdict, 'kill');
    assert.equal(doc.data.ventures[0].results.window.adSpend, 1.8, 'the 7-day window ends today, which had no spend yet');
    assert.equal(doc.data.ventures[0].results.window.orders, 0);
    assert.equal(doc.kills.length, 1);
    assert.equal(doc.kills[0].steps.length, 2);
    assert.equal(doc.kills[0].items.length, 2, 'one work item per Ranger');
    const items = h.trails.list().filter((it) => /^KILL venture lantern-co/.test(it.brief));
    assert.equal(items.length, 2);
    assert.ok(items.every((it) => it.fromAgentId === 'chief-ranger'));
    const adsItem = items.find((it) => it.toAgentId === ads.id);
    assert.match(adsItem.brief, /meta_ads\.set_status \{"campaignId":"c1","status":"PAUSED"\}/);
    const shopItem = items.find((it) => it.toAgentId === shop.id);
    assert.match(shopItem.brief, /shopify\.update_product \{"productId":1,"status":"draft"\}/);
    assert.equal(adsItem.budgetUsd, 0.25);
    const md = await fsp.readFile(path.join(h.dir, 'ws', 'chief-ranger', 'outbox', `${doc.id}.md`), 'utf8');
    assert.match(md, /## Rule verdicts \(results engine\)/);
    assert.match(md, /lantern-co: \*\*kill\*\*/);
    assert.match(md, /## Kills delegated/);
    // The Chief's follow-up names the verdict.
    assert.match(h.chiefStarts[0].summary, /rule verdicts: lantern-co: KILL/);
    // A second reflection while the items are still open delegates nothing new.
    const realList = h.trails.list;
    h.trails.list = () => realList().map((it) => (/^KILL/.test(it.brief) ? { ...it, status: 'running' } : it));
    const doc2 = await h.reflect.reflect({ reason: 'manual' });
    assert.equal(doc2.kills[0].items.length, 0);
    assert.ok(doc2.kills[0].notes.some((n) => /still open/.test(n)));
    h.trails.list = realList;
    assert.equal(realList().filter((it) => /^KILL/.test(it.brief)).length, 2);
    // Once the pauses took (the stores show the campaign paused and the product a draft),
    // there is nothing left to pause and the kill says so.
    stores.meta_ads.campaigns[0].effectiveStatus = 'PAUSED';
    stores.shopify.products[0].status = 'draft';
    assert.deepEqual(h.results.killPlan('lantern-co'), []);
    // The verdict rides reflection summaries and the state.
    assert.equal(h.reflect.latest().proposals[0].verdict, 'kill');
    assert.equal(h.reflect.latest().kills[0].steps, 2);
  } finally {
    await h.cleanup();
  }
});

test('the frontend reducer keeps the snapshot results and patches the latest rollup', () => {
  const base = { seq: 0, providers: {}, keystore: { path: '/x', problem: null }, layout: defaultLayout(), objectKinds: {}, activeRun: null, spend: { totalUsd: 0, reconciledTurns: 0, unreconciledTurns: 0 } };
  let s = applySnapshot(initialState(), { ...base, results: { lastRollup: { at: 5, reason: 'manual' }, ventures: [] } });
  assert.equal(s.results.lastRollup.reason, 'manual');
  s = applyEvent(s, { ...makeEvent('results.rollup', { day: '2026-10-11', reason: 'sync stripe', park: { revenue: null, refunds: null, fees: null, adSpend: null, orders: null, modelSpend: 0.1, mailIn: 0, mailOut: 0, contributionPerOrder: null, modelCostPerOrder: null }, ventures: [], proposals: [] }, { ts: 9 }), seq: 1 });
  assert.equal(s.results.latest.day, '2026-10-11');
  assert.equal(s.results.latest.park.revenue, null);
  assert.equal(s.results.stale, true);
  assert.equal(s.results.lastRollup.reason, 'manual');
});

test('through the sidecar: Stripe and Meta syncs feed /api/results, the snapshot and a manual rollup', async () => {
  const stripe = await startFakeStripe();
  const meta = await startFakeMetaAds();
  const srv = await startTestServer({ makeProvider: async () => ({ provider: fakeProvider([[text('ok'), end()]]), model: 'w', price: null }), withChief: true, env: { STRIPE_API_KEY: stripe.apiKey, META_ACCESS_TOKEN: meta.accessToken, META_AD_ACCOUNT_ID: '123' }, connectors: [stripeSpec({ baseUrl: stripe.url }), metaAdsSpec({ baseUrl: meta.url })], connectorConfig: { syncOnBoot: false } });
  try {
    await srv.post('/api/connectors/stripe/sync', {});
    await srv.post('/api/connectors/meta_ads/sync', {});
    const before = (await srv.get('/api/results')).body;
    assert.equal(before.lastRollup, null, 'nothing rolled up yet (the entry point debounces syncs into rollups; here it is manual)');
    assert.deepEqual(before.sources, { shopify: false, etsy: false, stripe: true, meta_ads: true, google_ads: false, mail: true });
    const stream = await srv.sse();
    const r = await srv.post('/api/results/rollup', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.lastRollup.reason, 'manual');
    const ev = await stream.waitFor((e) => e.type === 'results.rollup');
    assert.equal(ev.payload.reason, 'manual');
    // Stripe is the revenue source (no storefront): paid charges, their fees, the refund.
    const parkDays = r.body.parkSeries.filter((d) => d.revenue);
    assert.ok(parkDays.length >= 1);
    assert.equal(r.body.park.revenue, 65, 'ch_3 $25 + ch_2 $40 succeeded; the failed charge does not count');
    assert.equal(r.body.park.refunds, 10);
    assert.ok(r.body.park.fees > 0, 'the expanded balance transaction carried the fee');
    assert.equal(r.body.park.adSpend, 24, 'two daily Meta rows: 12.25 + 11.75');
    assert.ok(r.body.park.notes.some((n) => /Stripe charges/.test(n)));
    assert.equal(r.body.ventures.length, 0, 'no plan yet: no venture rows');
    const state = (await srv.get('/api/state')).body;
    assert.equal(state.results.lastRollup.reason, 'manual');
    assert.equal(state.results.park.revenue, 65);
    // Unauthenticated mutation refused (safety M4), as every other route.
    const bare = await fetch(`${srv.url}/api/results/rollup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(bare.status, 403);
    stream.close();
  } finally {
    await srv.close();
    await stripe.close();
    await meta.close();
  }
});

test('ATTRIBUTED_TOOLS read every create tool\'s own output', () => {
  assert.deepEqual(ATTRIBUTED_TOOLS['shopify.create_product']({ id: 7, variants: [{ id: 70 }, { id: 71 }] }), [{ kind: 'shopify', type: 'product', id: 7 }, { kind: 'shopify', type: 'variant', id: 70 }, { kind: 'shopify', type: 'variant', id: 71 }]);
  assert.deepEqual(ATTRIBUTED_TOOLS['etsy.create_listing']({ listingId: 5 }), [{ kind: 'etsy', type: 'listing', id: 5 }]);
  assert.deepEqual(ATTRIBUTED_TOOLS['google_ads.create_campaign']({ id: '9' }), [{ kind: 'google_ads', type: 'campaign', id: '9' }]);
  assert.equal(RULES.windowDays, 7);
  assert.ok(waitUntil);
});
