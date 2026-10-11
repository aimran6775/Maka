// The results engine (phase 4 step 9).
//
//   createResults({ bus, store, agents, trails, chief, ledger, gateQueue, getConnectors, getMail,
//                   getLayout, clock, log })
//     -> { init(), rollup({ reason }), compute(), summary(), full(), proposals(), killPlan(id),
//          attribution(), close() }
//
// Per venture and per Ranger, from real ledgers and connector syncs only:
//   revenue, refunds, fees, ad spend   from the connectors' local stores (what their syncs
//                                      brought in; Stripe's own fee when it was synced)
//   model spend by tier                from every cost.estimate on the bus (worker, judge,
//                                      hosted), seeded from persisted run records at boot
//   mail volume                        from the mail store (internal briefings excluded)
//   orders                             storefront orders (Shopify, Etsy); Stripe charges
//                                      only when no storefront is connected
//   work items, Gate decisions         from the trails and the Gate queue
// Unit economics per venture and for the park: contribution per order (revenue less
// refunds, fees and ad spend over orders), model cost per order, and payback (the first
// rolled-up day on which recorded contribution covered recorded ad and model spend).
// Nothing is projected: a figure no source holds is null and the UI says "no data".
//
// Attribution (docs/DECISIONS.md D139): a connector figure belongs to a venture only through
// an object a Ranger of that venture created with a Maka tool (the campaign, the product's
// variants, the listing, the refund), recorded here from the tool's own result. Everything
// else is park-level. Stripe charges are never attributed (nothing links them to a venture).
//
// Daily rollups are persisted in results.json (bounded) and every rollup emits
// results.rollup with the day's figures and the Chief rules' proposals: scale / hold /
// kill / no_data per venture, each with the numbers that drove it (`proposeFor`, pure). A
// kill is a list of pauses (`killPlan`) that the reflection delegates to the venture's own
// Rangers, whose tools pass the Gate as usual.

import { makeEvent } from '../shared/events.js';
import { localDayKey } from './leash-ledger.js';
import { CHIEF_ID } from './agents.js';

export const RESULTS_KEEP_DAYS = 400;
export const RULES = Object.freeze({
  windowDays: 7, // the window the rules read
  killMinDays: 7, // kill A: this many observed days with no order while spending
  killSpendFraction: 0.5, // … and at least this share of the venture budget spent
  killLossMinDays: 14, // kill B: this many observed days with a negative net
  killLossSpendFraction: 0.75, // … and at least this share of the venture budget spent
  scaleMinOrders: 5, // scale: at least this many orders in the window, with a positive net and payback reached
});
export const VERDICTS = Object.freeze(['scale', 'hold', 'kill', 'no_data']);

// Tool results that attribute a platform object to the venture of the Ranger that made it.
export const ATTRIBUTED_TOOLS = Object.freeze({
  'meta_ads.create_campaign': (row) => [{ kind: 'meta_ads', type: 'campaign', id: row.id }],
  'google_ads.create_campaign': (row) => [{ kind: 'google_ads', type: 'campaign', id: row.id }],
  'shopify.create_product': (row) => [{ kind: 'shopify', type: 'product', id: row.id }, ...(row.variants || []).map((v) => ({ kind: 'shopify', type: 'variant', id: v.id }))],
  'etsy.create_listing': (row) => [{ kind: 'etsy', type: 'listing', id: row.listingId }],
  'stripe.refund': (row) => [{ kind: 'stripe', type: 'refund', id: row.id || (row.refund && row.refund.id) }],
});

const TIERS = ['worker', 'judge', 'hosted_worker'];
const round = (n) => (n === null || n === undefined ? null : Number(n.toFixed(4)));
const add = (a, b) => (a === null ? (b === null ? null : b) : b === null ? a : a + b);

export function emptyRow() {
  return { revenue: null, refunds: null, fees: null, adSpend: null, orders: null, modelSpend: 0, modelSpendByTier: { worker: 0, judge: 0, hosted_worker: 0 }, unpricedTurns: 0, hostedCalls: 0, mailIn: 0, mailOut: 0, itemsDone: 0, itemsFailed: 0, gateApproved: 0, gateRejected: 0, currencies: [], notes: [] };
}

function emptyState() {
  return { version: 1, model: {}, counted: {}, attribution: {}, days: {}, lastRollup: null };
}

// Adds `b` into `a` (both rows); nulls stay null unless the other side has a number.
function addRow(a, b) {
  for (const k of ['revenue', 'refunds', 'fees', 'adSpend', 'orders']) a[k] = add(a[k], b[k]);
  a.modelSpend += b.modelSpend;
  for (const t of TIERS) a.modelSpendByTier[t] += b.modelSpendByTier[t];
  for (const k of ['unpricedTurns', 'hostedCalls', 'mailIn', 'mailOut', 'itemsDone', 'itemsFailed', 'gateApproved', 'gateRejected']) a[k] += b[k];
  for (const c of b.currencies) if (!a.currencies.includes(c)) a.currencies.push(c);
  for (const n of b.notes) if (!a.notes.includes(n)) a.notes.push(n);
  return a;
}

// Unit economics over a list of day rows. `unknown` names the components no source
// holds; contribution is computed from the known ones and says so.
export function economics(rows) {
  const sum = rows.reduce((acc, r) => addRow(acc, JSON.parse(JSON.stringify(r))), emptyRow());
  const unknown = [];
  for (const k of ['revenue', 'refunds', 'fees', 'adSpend']) if (sum[k] === null) unknown.push(k);
  const known = (k) => (sum[k] === null ? 0 : sum[k]);
  const contribution = sum.revenue === null ? null : sum.revenue - known('refunds') - known('fees') - known('adSpend');
  const orders = sum.orders;
  const net = contribution === null ? null : contribution - sum.modelSpend;
  // Payback: the first day on which cumulative contribution covered cumulative ad + model spend.
  let cum = { contribution: 0, cost: 0 };
  let paybackDay = null;
  let anyRevenue = false;
  for (const r of rows) {
    if (r.revenue !== null) anyRevenue = true;
    cum.contribution += (r.revenue || 0) - (r.refunds || 0) - (r.fees || 0);
    cum.cost += (r.adSpend || 0) + r.modelSpend;
    if (paybackDay === null && anyRevenue && cum.cost > 0 && cum.contribution >= cum.cost) paybackDay = r.day || null;
  }
  return {
    days: rows.length,
    revenue: round(sum.revenue),
    refunds: round(sum.refunds),
    fees: round(sum.fees),
    adSpend: round(sum.adSpend),
    modelSpend: round(sum.modelSpend),
    modelSpendByTier: Object.fromEntries(TIERS.map((t) => [t, round(sum.modelSpendByTier[t])])),
    orders,
    mailIn: sum.mailIn,
    mailOut: sum.mailOut,
    itemsDone: sum.itemsDone,
    itemsFailed: sum.itemsFailed,
    gateApproved: sum.gateApproved,
    gateRejected: sum.gateRejected,
    contribution: round(contribution),
    net: round(net),
    contributionPerOrder: contribution !== null && orders ? round(contribution / orders) : null,
    modelCostPerOrder: orders ? round(sum.modelSpend / orders) : null,
    payback: anyRevenue ? { reached: paybackDay !== null, day: paybackDay } : null,
    unknown,
    currencies: sum.currencies,
    notes: sum.notes,
  };
}

// The Chief rules, pure. `rows` are the venture's day rows oldest first (every day from its
// first activity), `venture` carries budgetUsd. Returns { venture, verdict, because, numbers }.
export function proposeFor(venture, rows, rules = RULES) {
  const active = rows.filter((r) => r.modelSpend > 0 || r.orders || r.adSpend || r.revenue || r.itemsDone || r.mailOut);
  const firstIdx = active.length ? rows.indexOf(active[0]) : -1;
  const observed = firstIdx === -1 ? [] : rows.slice(firstIdx);
  const daysObserved = observed.length;
  const window = observed.slice(-rules.windowDays);
  const w = economics(window);
  const all = economics(observed);
  const spent = (all.adSpend || 0) + (all.modelSpend || 0);
  const budget = typeof venture.budgetUsd === 'number' ? venture.budgetUsd : 0;
  const money = (n) => (n === null || n === undefined ? 'no data' : `$${n.toFixed(2)}`);
  const numbers = { daysObserved, windowDays: window.length, windowOrders: w.orders, windowRevenue: w.revenue, windowAdSpend: w.adSpend, windowModelSpend: w.modelSpend, windowContribution: w.contribution, windowNet: w.net, spentUsd: round(spent), budgetUsd: budget, payback: all.payback, unknown: w.unknown };
  const out = (verdict, because) => ({ venture: venture.id, verdict, because, numbers });
  if (!daysObserved) return out('no_data', ['no activity recorded for this venture yet']);
  if (w.revenue === null && w.adSpend === null) return out('no_data', [`revenue, orders and ad spend are unknown: no storefront, payment or ad connector has synced (${daysObserved} day(s) observed, model spend ${money(all.modelSpend)})`]);
  const windowCost = (w.adSpend || 0) + (w.modelSpend || 0);
  if (daysObserved >= rules.killMinDays && w.revenue !== null && (w.orders || 0) === 0 && windowCost > 0 && budget > 0 && spent >= rules.killSpendFraction * budget) {
    return out('kill', [`0 orders in the last ${window.length} day(s) while spending ${money(windowCost)} (ads ${money(w.adSpend)}, models ${money(w.modelSpend)})`, `${money(spent)} of the $${budget.toFixed(2)} budget spent (${Math.round((spent / budget) * 100)} %) over ${daysObserved} day(s)`]);
  }
  if (daysObserved >= rules.killLossMinDays && w.net !== null && w.net < 0 && budget > 0 && spent >= rules.killLossSpendFraction * budget) {
    return out('kill', [`net ${money(w.net)} over the last ${window.length} day(s): revenue ${money(w.revenue)} less refunds ${money(w.refunds)}, fees ${money(w.fees)}, ads ${money(w.adSpend)}, models ${money(w.modelSpend)}${w.unknown.length ? ` (${w.unknown.join(', ')} unknown)` : ''}`, `${money(spent)} of the $${budget.toFixed(2)} budget spent (${Math.round((spent / budget) * 100)} %) over ${daysObserved} day(s)`]);
  }
  if (daysObserved >= rules.windowDays && (w.orders || 0) >= rules.scaleMinOrders && w.unknown.length === 0 && w.net !== null && w.net > 0 && all.payback && all.payback.reached) {
    return out('scale', [`${w.orders} order(s) in the last ${window.length} day(s), net ${money(w.net)} after refunds, fees, ads and models`, `contribution per order ${money(w.contributionPerOrder)}, model cost per order ${money(w.modelCostPerOrder)}`, `payback reached on ${all.payback.day}`]);
  }
  const why = [];
  why.push(`${daysObserved} day(s) observed, ${w.orders === null ? 'orders unknown' : `${w.orders} order(s)`} in the last ${window.length}, revenue ${money(w.revenue)}, ad spend ${money(w.adSpend)}, model spend ${money(w.modelSpend)}`);
  if (w.unknown.length) why.push(`${w.unknown.join(', ')} unknown: no source holds them`);
  if (all.payback) why.push(all.payback.reached ? `payback reached on ${all.payback.day}` : 'payback not reached yet');
  if (daysObserved < rules.windowDays) why.push(`fewer than ${rules.windowDays} days observed: no scale or kill before that`);
  return out('hold', why);
}

export function createResults({ bus, store, agents, trails = null, chief = null, ledger = null, gateQueue = null, getConnectors = null, getMail = null, getLayout, clock = { now: () => Date.now() }, log = console } = {}) {
  if (!bus || !store || !agents || typeof getLayout !== 'function') throw new TypeError('createResults needs bus, store, agents and getLayout');
  let data = emptyState();
  let saving = Promise.resolve();
  let pending = []; // in-flight async work to await in close()
  const runAgent = new Map(); // runId -> agentId (live)
  const emit = (type, payload) => bus.emit(makeEvent(type, payload, { ts: clock.now() }));
  const dayOf = (ms) => localDayKey(ms);

  const save = () => {
    saving = saving.then(() => store.saveResults(data)).catch((err) => log.error('results save failed:', err));
    return saving;
  };
  const track = (p) => {
    pending.push(p);
    p.finally(() => {
      pending = pending.filter((x) => x !== p);
    });
    return p;
  };

  // ---- model spend by day / agent / tier ----
  function modelRow(day, agentId) {
    const d = data.model[day] || (data.model[day] = {});
    return d[agentId] || (d[agentId] = { worker: 0, judge: 0, hosted_worker: 0, unpricedTurns: 0, hostedCalls: 0 });
  }
  function countCost(p, ts, agentId) {
    const row = modelRow(dayOf(ts), agentId);
    const tier = TIERS.includes(p.tier) ? p.tier : 'worker';
    if (p.reconciled && typeof p.usd === 'number') row[tier] += p.usd;
    else row.unpricedTurns += 1;
    if (p.tier === 'hosted_worker') row.hostedCalls += 1;
  }
  function agentOfRun(runId) {
    if (runAgent.has(runId)) return runAgent.get(runId);
    if (/^reflection-/.test(runId) || /^ask-/.test(runId)) return CHIEF_ID; // the Chief's own calls outside a run
    return null;
  }

  // The venture of the work item a run serves, when the item names one (safety 2026-10-11
  // M3): the trails set the item's runId as the run starts, so it is known by the time a
  // tool result arrives.
  const ventureOfItemRun = (runId) => {
    if (!runId || !trails || typeof trails.list !== 'function') return null;
    const item = trails.list().find((it) => it.runId === runId);
    return item && typeof item.venture === 'string' && item.venture ? item.venture : null;
  };
  bus.listen((event) => {
    if (event.type === 'agent.run.start') runAgent.set(event.payload.runId, event.payload.agentId);
    if (event.type === 'cost.estimate') {
      const agentId = agentOfRun(event.payload.runId) || CHIEF_ID;
      countCost(event.payload, event.ts, agentId);
      data.counted[event.payload.runId] = true;
      track(save());
    }
    if (event.type === 'agent.tool_result' && event.payload.ok && ATTRIBUTED_TOOLS[event.payload.name]) {
      const agentId = agentOfRun(event.payload.runId);
      const agent = agentId ? agents.get(agentId) : null;
      // The work item's venture first (M3: a Ranger of venture A working a venture B item
      // makes B's objects), else the Ranger's own.
      const venture = ventureOfItemRun(event.payload.runId) || (agent && agent.venture) || null;
      if (!agent || !venture) return;
      let row;
      try {
        row = JSON.parse(event.payload.output || '');
      } catch {
        return;
      }
      for (const o of ATTRIBUTED_TOOLS[event.payload.name](row || {})) {
        if (o.id === undefined || o.id === null) continue;
        const kind = data.attribution[o.kind] || (data.attribution[o.kind] = {});
        const type = kind[o.type] || (kind[o.type] = {});
        type[String(o.id)] = { venture, agentId, at: event.ts };
      }
      track(save());
    }
  });

  // Seeds the model ledger from persisted run records the live listener never saw.
  async function seedFromRuns() {
    let changed = false;
    for (const r of await store.listRuns()) {
      if (data.counted[r.runId]) continue;
      const rec = await store.loadRun(r.runId);
      if (!rec) continue;
      for (const e of rec.events || []) if (e.type === 'cost.estimate') countCost(e.payload, e.ts, rec.agentId);
      data.counted[r.runId] = true;
      changed = true;
    }
    if (changed) await save();
  }

  // ---- sources ----
  const attributed = (kind, type, id) => {
    const t = data.attribution[kind] && data.attribution[kind][type];
    return t && t[String(id)] ? t[String(id)].venture : null;
  };
  function connectorData(kind) {
    const reg = typeof getConnectors === 'function' ? getConnectors() : null;
    if (!reg) return null;
    try {
      const d = reg.data(kind);
      return d && d.syncedAt ? d : null;
    } catch {
      return null;
    }
  }

  // Builds the day rows for the park, every plan venture and every agent from the sources.
  function compute() {
    const layout = getLayout();
    const st = chief ? chief.state() : { mission: null, plan: null };
    const ventures = st.plan ? st.plan.ventures.map((v) => ({ id: v.id, name: v.name, budgetUsd: v.budgetUsd })) : [];
    const ventureIds = new Set(ventures.map((v) => v.id));
    const crewOf = (vid) => layout.agents.filter((a) => a.venture === vid).map((a) => a.id);
    const ventureOfAgent = (id) => {
      const a = layout.agents.find((x) => x.id === id);
      return a && ventureIds.has(a.venture) ? a.venture : null;
    };
    const days = new Map(); // day -> { park, ventures: {}, agents: {} }
    const dayRow = (day) => {
      if (!days.has(day)) days.set(day, { park: emptyRow(), ventures: Object.fromEntries(ventures.map((v) => [v.id, emptyRow()])), agents: {} });
      return days.get(day);
    };
    const agentRow = (day, agentId) => {
      const d = dayRow(day);
      return d.agents[agentId] || (d.agents[agentId] = emptyRow());
    };
    const vRow = (day, vid) => (vid && ventureIds.has(vid) ? dayRow(day).ventures[vid] : null);
    const bump = (row, k, n) => {
      if (!row) return;
      row[k] = (row[k] === null ? 0 : row[k]) + n;
    };
    const note = (row, text) => {
      if (row && !row.notes.includes(text)) row.notes.push(text);
    };
    const currency = (row, c) => {
      if (row && c && !row.currencies.includes(c)) row.currencies.push(c);
    };

    // Model spend.
    for (const [day, perAgent] of Object.entries(data.model)) {
      for (const [agentId, m] of Object.entries(perAgent)) {
        const a = agentRow(day, agentId);
        for (const t of TIERS) {
          a.modelSpendByTier[t] += m[t];
          a.modelSpend += m[t];
        }
        a.unpricedTurns += m.unpricedTurns;
        a.hostedCalls += m.hostedCalls;
        const targets = [dayRow(day).park, vRow(day, ventureOfAgent(agentId))];
        for (const r of targets) {
          if (!r) continue;
          for (const t of TIERS) r.modelSpendByTier[t] += m[t];
          r.modelSpend += TIERS.reduce((n, t) => n + m[t], 0);
          r.unpricedTurns += m.unpricedTurns;
          r.hostedCalls += m.hostedCalls;
        }
      }
    }

    // Storefronts: Shopify orders and Etsy receipts (revenue, orders), line items attributed.
    const shopify = connectorData('shopify');
    const etsy = connectorData('etsy');
    const stripe = connectorData('stripe');
    const storefront = Boolean(shopify || etsy);
    const markRevenueKnown = (day) => {
      const d = dayRow(day);
      if (d.park.revenue === null) d.park.revenue = 0;
      if (d.park.orders === null) d.park.orders = 0;
      for (const v of Object.values(d.ventures)) {
        if (v.revenue === null) v.revenue = 0;
        if (v.orders === null) v.orders = 0;
      }
    };
    if (shopify) {
      for (const o of shopify.orders || []) {
        if (!o.createdAt || !['paid', 'partially_refunded', 'refunded'].includes(o.financialStatus)) continue;
        const day = dayOf(Date.parse(o.createdAt));
        markRevenueKnown(day);
        const d = dayRow(day);
        bump(d.park, 'revenue', Number(o.totalPrice) || 0);
        bump(d.park, 'orders', 1);
        currency(d.park, o.currency || (shopify.shop && shopify.shop.currency));
        const touched = new Set();
        for (const li of o.lineItems || []) {
          const vid = attributed('shopify', 'variant', li.variantId);
          const r = vRow(day, vid);
          if (!r) continue;
          bump(r, 'revenue', (Number(li.price) || 0) * (li.quantity || 1));
          currency(r, o.currency || (shopify.shop && shopify.shop.currency));
          note(r, 'venture revenue is the attributed line items (no shipping or tax)');
          touched.add(vid);
        }
        for (const vid of touched) bump(vRow(day, vid), 'orders', 1);
      }
      note(dayRow(dayOf(shopify.syncedAt)).park, 'Shopify refund amounts are not synced');
    }
    if (etsy) {
      for (const r of etsy.receipts || []) {
        if (!r.createdAt || !r.paid) continue;
        const day = dayOf(r.createdAt);
        markRevenueKnown(day);
        const d = dayRow(day);
        bump(d.park, 'revenue', r.grandTotal || 0);
        bump(d.park, 'orders', 1);
        currency(d.park, r.currency || (etsy.shop && etsy.shop.currency));
        const touched = new Set();
        for (const it of r.items || []) {
          const vid = attributed('etsy', 'listing', it.listingId);
          const row = vRow(day, vid);
          if (!row) continue;
          bump(row, 'revenue', (it.price || 0) * (it.quantity || 1));
          currency(row, r.currency || (etsy.shop && etsy.shop.currency));
          note(row, 'venture revenue is the attributed line items (no shipping or tax)');
          touched.add(vid);
        }
        for (const vid of touched) bump(vRow(day, vid), 'orders', 1);
      }
    }
    if (stripe) {
      for (const c of stripe.charges || []) {
        if (!c.paid || c.status !== 'succeeded') continue;
        const day = dayOf(c.created);
        const d = dayRow(day);
        if (!storefront) {
          // No storefront: Stripe's paid charges are the revenue the park can prove.
          markRevenueKnown(day);
          bump(d.park, 'revenue', c.amount / 100);
          bump(d.park, 'orders', 1);
          currency(d.park, c.currency);
          note(d.park, 'revenue is Stripe charges (no storefront connected); not attributable to a venture');
        }
        if (typeof c.fee === 'number') bump(d.park, 'fees', c.fee / 100);
      }
      for (const r of stripe.refunds || []) {
        if (r.status && r.status !== 'succeeded') continue;
        const day = dayOf(r.created);
        const d = dayRow(day);
        bump(d.park, 'refunds', r.amount / 100);
        currency(d.park, r.currency);
        const row = vRow(day, attributed('stripe', 'refund', r.id));
        if (row) bump(row, 'refunds', r.amount / 100);
      }
      // A synced Stripe means refunds are known (0 when none) for every day it covers.
      for (const d of days.values()) if (d.park.refunds === null) d.park.refunds = 0;
      if (!(stripe.charges || []).some((c) => typeof c.fee === 'number')) note(dayRow(dayOf(stripe.syncedAt)).park, 'Stripe fees were not in the sync');
    }

    // Ad spend by day, attributed campaigns to their ventures.
    const adSources = [['meta_ads', connectorData('meta_ads'), (d) => (d.insights && d.insights.daily) || [], (r) => r.spend, (d) => d.account && d.account.currency], ['google_ads', connectorData('google_ads'), (d) => (d.metrics && d.metrics.daily) || [], (r) => r.cost, (d) => d.customer && d.customer.currency]];
    let anyAds = false;
    for (const [kind, src, rowsOf, spendOf, currencyOf] of adSources) {
      if (!src) continue;
      anyAds = true;
      for (const r of rowsOf(src)) {
        if (!r.date) continue;
        const d = dayRow(r.date);
        bump(d.park, 'adSpend', spendOf(r) || 0);
        currency(d.park, currencyOf(src));
        const row = vRow(r.date, attributed(kind, 'campaign', r.campaignId));
        if (row) {
          bump(row, 'adSpend', spendOf(r) || 0);
          currency(row, currencyOf(src));
        }
      }
    }
    if (anyAds) {
      for (const d of days.values()) {
        if (d.park.adSpend === null) d.park.adSpend = 0;
        for (const v of Object.values(d.ventures)) if (v.adSpend === null) v.adSpend = 0;
      }
    }
    // Known revenue days: ventures with no attributed sale that day have a known 0.
    // (markRevenueKnown did that per day; days without any sale stay null unless a
    // storefront or Stripe synced, in which case the park proved "nothing that day".)
    if (storefront || stripe) {
      for (const d of days.values()) {
        if (d.park.revenue === null) d.park.revenue = 0;
        if (d.park.orders === null) d.park.orders = 0;
        if (storefront) for (const v of Object.values(d.ventures)) {
          if (v.revenue === null) v.revenue = 0;
          if (v.orders === null) v.orders = 0;
        }
      }
    }

    // Mail volume (external only; briefings are internal).
    const mail = typeof getMail === 'function' ? getMail() : null;
    if (mail && mail.mailStore) {
      for (const m of mail.mailStore.list({ limit: 100000 })) {
        if (m.kind === 'briefing' || m.status === 'draft' || !m.date) continue;
        const day = dayOf(m.date);
        const k = m.direction === 'in' ? 'mailIn' : 'mailOut';
        dayRow(day).park[k] += 1;
        if (m.agentId) agentRow(day, m.agentId)[k] += 1;
        const vid = ventureIds.has(m.venture) ? m.venture : m.agentId ? ventureOfAgent(m.agentId) : null;
        const r = vRow(day, vid);
        if (r) r[k] += 1;
      }
    }

    // Work items and Gate decisions.
    if (trails) {
      for (const it of trails.list()) {
        if (!it.endedAt || !['done', 'failed', 'cancelled'].includes(it.status)) continue;
        const day = dayOf(it.endedAt);
        const k = it.status === 'done' ? 'itemsDone' : 'itemsFailed';
        dayRow(day).park[k] += 1;
        agentRow(day, it.toAgentId)[k] += 1;
        const r = vRow(day, ventureOfAgent(it.toAgentId));
        if (r) r[k] += 1;
      }
    }
    if (gateQueue) {
      for (const g of gateQueue.items()) {
        if (!g.decidedAt || !['approved', 'rejected', 'revised'].includes(g.status)) continue;
        const day = dayOf(g.decidedAt);
        const k = g.status === 'approved' ? 'gateApproved' : 'gateRejected';
        dayRow(day).park[k] += 1;
        if (g.agentId) agentRow(day, g.agentId)[k] += 1;
        const r = vRow(day, ventureOfAgent(g.agentId));
        if (r) r[k] += 1;
      }
    }

    const today = dayOf(clock.now());
    dayRow(today);
    // Money fields rounded to 6 decimals so sums of floats do not persist as 0.12000000000000001.
    const r6 = (n) => (n === null ? null : Number(n.toFixed(6)));
    const finish = (row) => {
      for (const k of ['revenue', 'refunds', 'fees', 'adSpend', 'modelSpend']) row[k] = r6(row[k]);
      for (const t of TIERS) row.modelSpendByTier[t] = r6(row.modelSpendByTier[t]);
    };
    for (const d of days.values()) {
      finish(d.park);
      for (const v of Object.values(d.ventures)) finish(v);
      for (const a of Object.values(d.agents)) finish(a);
    }
    const keys = [...days.keys()].sort().slice(-RESULTS_KEEP_DAYS);
    const out = { at: clock.now(), today, days: keys.map((day) => ({ day, ...days.get(day) })), ventures: ventures.map((v) => ({ ...v, crew: crewOf(v.id) })) };
    // Economics and proposals per venture and for the park.
    const seriesFor = (pick) => out.days.map((d) => ({ day: d.day, ...pick(d) }));
    out.park = economics(seriesFor((d) => d.park));
    out.parkWindow = economics(seriesFor((d) => d.park).slice(-RULES.windowDays));
    for (const v of out.ventures) {
      const series = seriesFor((d) => d.ventures[v.id]);
      v.all = economics(series);
      v.window = economics(series.slice(-RULES.windowDays));
      v.proposal = proposeFor(v, series);
      v.spentUsd = round((v.all.adSpend || 0) + (v.all.modelSpend || 0));
    }
    out.agents = {};
    for (const a of layout.agents) {
      const series = seriesFor((d) => d.agents[a.id] || emptyRow());
      out.agents[a.id] = { id: a.id, name: a.name, venture: a.venture || null, all: economics(series), window: economics(series.slice(-RULES.windowDays)) };
    }
    out.sources = { shopify: Boolean(shopify), etsy: Boolean(etsy), stripe: Boolean(stripe), meta_ads: Boolean(connectorData('meta_ads')), google_ads: Boolean(connectorData('google_ads')), mail: Boolean(mail) };
    return out;
  }

  const eventRow = (r) => ({ revenue: round(r.revenue), refunds: round(r.refunds), fees: round(r.fees), adSpend: round(r.adSpend), orders: r.orders, modelSpend: round(r.modelSpend), mailIn: r.mailIn, mailOut: r.mailOut, contributionPerOrder: r.contributionPerOrder ?? null, modelCostPerOrder: r.modelCostPerOrder ?? null });

  let rolling = null;
  async function rollup({ reason = 'manual' } = {}) {
    if (rolling) return rolling;
    rolling = (async () => {
      const computed = compute();
      const todayRow = computed.days.find((d) => d.day === computed.today);
      // Persist the day rows (the whole bounded history: sources are complete, so a
      // recompute is the truth and a stale day is corrected, not kept).
      data.days = Object.fromEntries(computed.days.map((d) => [d.day, { park: d.park, ventures: d.ventures, agents: d.agents }]));
      data.lastRollup = { at: clock.now(), reason, day: computed.today };
      await save();
      const park = eventRow({ ...todayRow.park, ...economics([todayRow.park]) });
      const ventures = computed.ventures.map((v) => ({ id: v.id, ...eventRow({ ...todayRow.ventures[v.id], ...economics([todayRow.ventures[v.id]]) }) }));
      emit('results.rollup', { day: computed.today, reason, park, ventures, proposals: computed.ventures.map((v) => ({ venture: v.id, verdict: v.proposal.verdict, because: v.proposal.because })) });
      return computed;
    })().finally(() => {
      rolling = null;
    });
    return rolling;
  }

  // What a kill means for a venture: every attributed campaign still running and every
  // attributed listing still live, each as the tool call that pauses it and the Ranger of
  // the venture whose specialty owns that tool. Nothing here runs; the reflection delegates
  // these as work items and the tools pass the Gate like any other call.
  function killPlan(ventureId) {
    const layout = getLayout();
    const crew = layout.agents.filter((a) => a.venture === ventureId);
    const att = data.attribution;
    const recordOf = (kind, type, id) => (att[kind] && att[kind][type] && att[kind][type][String(id)]) || null;
    // The venture's own Ranger of the specialty, else the Ranger that made the object (M3:
    // a venture B item worked by venture A's Ranger is still paused when B is killed).
    const owner = (specialty, kind, type, id) => {
      const own = crew.find((a) => a.specialty === specialty);
      if (own) return own.id;
      const rec = recordOf(kind, type, id);
      return rec && rec.agentId && layout.agents.some((a) => a.id === rec.agentId) ? rec.agentId : null;
    };
    const steps = [];
    const has = (kind, type, id) => Boolean(recordOf(kind, type, id)) && recordOf(kind, type, id).venture === ventureId;
    const meta = connectorData('meta_ads');
    if (meta) for (const c of meta.campaigns || []) if (has('meta_ads', 'campaign', c.id) && c.effectiveStatus === 'ACTIVE') steps.push({ connector: 'meta_ads', object: `campaign ${c.id} "${c.name}"`, tool: 'meta_ads.set_status', input: { campaignId: c.id, status: 'PAUSED' }, specialty: 'ads', agentId: owner('ads', 'meta_ads', 'campaign', c.id) });
    const google = connectorData('google_ads');
    if (google) for (const c of google.campaigns || []) if (has('google_ads', 'campaign', c.id) && c.status === 'ENABLED') steps.push({ connector: 'google_ads', object: `campaign ${c.id} "${c.name}"`, tool: 'google_ads.set_status', input: { campaignId: c.id, status: 'PAUSED' }, specialty: 'ads', agentId: owner('ads', 'google_ads', 'campaign', c.id) });
    const shopify = connectorData('shopify');
    if (shopify) for (const p of shopify.products || []) if (has('shopify', 'product', p.id) && p.status === 'active') steps.push({ connector: 'shopify', object: `product ${p.id} "${p.title}"`, tool: 'shopify.update_product', input: { productId: p.id, status: 'draft' }, specialty: 'storefront', agentId: owner('storefront', 'shopify', 'product', p.id) });
    const etsy = connectorData('etsy');
    if (etsy) for (const l of etsy.listings || []) if (has('etsy', 'listing', l.listingId) && l.state === 'active') steps.push({ connector: 'etsy', object: `listing ${l.listingId} "${l.title}"`, tool: 'etsy.update_listing', input: { listingId: l.listingId, state: 'inactive' }, specialty: 'storefront', agentId: owner('storefront', 'etsy', 'listing', l.listingId) });
    return steps;
  }

  function summary() {
    const computed = compute();
    const last = computed.days.slice(-30);
    return {
      lastRollup: data.lastRollup,
      today: computed.today,
      sources: computed.sources,
      park: computed.park,
      parkWindow: computed.parkWindow,
      ventures: computed.ventures.map((v) => ({ id: v.id, name: v.name, budgetUsd: v.budgetUsd, spentUsd: v.spentUsd, crew: v.crew, all: v.all, window: v.window, proposal: v.proposal, series: last.map((d) => ({ day: d.day, ...eventRow({ ...d.ventures[v.id], ...economics([d.ventures[v.id]]) }) })) })),
      parkSeries: last.map((d) => ({ day: d.day, ...eventRow({ ...d.park, ...economics([d.park]) }) })),
      agents: computed.agents,
    };
  }

  return {
    async init() {
      const loaded = await store.loadResults(null);
      if (loaded && loaded.version === 1 && loaded.model && loaded.days) data = { ...emptyState(), ...loaded };
      await seedFromRuns();
      return this;
    },
    rollup,
    compute,
    summary,
    full: () => ({ ...compute(), lastRollup: data.lastRollup }),
    proposals: () => compute().ventures.map((v) => v.proposal),
    killPlan,
    attribution: () => JSON.parse(JSON.stringify(data.attribution)),
    state: () => data,
    flushed: () => saving,
    async close() {
      await Promise.allSettled(pending);
      await saving;
    },
  };
}
