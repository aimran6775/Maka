// The Ledger desk (phase 4 step 16): the fixture, its one read-only tool over the results
// engine's rows and today's leash ledger, and the grant through the capability gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLedgerDesk, LEDGER_DESK_TOOL_NAMES, LEDGER_READ_MAX_DAYS } from '../sidecar/ledger-desk.js';
import { emptyRow } from '../sidecar/results.js';
import { OBJECT_KINDS, PEAK_REFUSED_KINDS, defaultLayout, grantsFor, allGrantsFor } from '../shared/world.js';
import { TOOL_DOMAINS, defaultLeash } from '../shared/leash.js';
import { createToolGate } from '../sidecar/capability/gate.js';

const clock = { now: () => Date.UTC(2026, 9, 11, 9) };

// A results engine as `ledger.read` sees it: three days, one venture, one Ranger.
function fakeResults() {
  const row = (over) => ({ ...emptyRow(), ...over });
  const days = [
    { day: '2026-10-09', park: row({ revenue: 100, fees: 3, orders: 4, modelSpend: 0.5 }), ventures: { 'lantern-co': row({ revenue: 100, fees: 3, orders: 4, modelSpend: 0.5 }) }, agents: { books: row({ modelSpend: 0.1 }) } },
    { day: '2026-10-10', park: row({ revenue: 50, fees: 1.5, orders: 2, modelSpend: 0.25, adSpend: 10 }), ventures: { 'lantern-co': row({ revenue: 50, fees: 1.5, orders: 2, modelSpend: 0.25, adSpend: 10 }) }, agents: {} },
    { day: '2026-10-11', park: row({ modelSpend: 0.05 }), ventures: { 'lantern-co': row({ modelSpend: 0.05 }) }, agents: { books: row({ modelSpend: 0.05 }) } },
  ];
  return {
    full: () => ({
      at: clock.now(),
      today: '2026-10-11',
      days,
      ventures: [{ id: 'lantern-co', name: 'Lantern Co', budgetUsd: 20, crew: ['books'], spentUsd: 10.8, proposal: { verdict: 'hold', because: ['too early'] } }],
      sources: { shopify: false, etsy: true, stripe: true, meta_ads: false, google_ads: false, mail: true },
      lastRollup: { at: clock.now() - 60000, reason: 'sync', day: '2026-10-11' },
    }),
  };
}

const fakeLedger = { summary: () => ({ day: '2026-10-11', domains: { research: { usd: 0, actions: 7 }, money_out: { usd: 10, actions: 1 } }, agents: { books: { research: { usd: 0, actions: 3 } }, ads: { money_out: { usd: 10, actions: 1 } } }, judge: { usd: 0.02, calls: 2 }, hosted: { calls: 1, tokens: 500 }, streaks: {}, earnApprovals: 5 }) };

function layoutWithDesk(withDesk = true) {
  const layout = defaultLayout();
  layout.rooms.push({ id: 'finance', name: 'Finance Camp', kind: 'finance', x: 21, y: 1, w: 8, h: 6 });
  if (withDesk) layout.objects.push({ id: 'desk', kind: 'ledger_desk', roomId: 'finance', x: 22, y: 2 });
  layout.agents.push({ id: 'books', name: 'Bo', roomId: 'finance', x: 21, y: 1, role: 'ranger', specialty: 'books', venture: 'lantern-co' });
  return layout;
}

test('the Ledger desk is a fixture that grants ledger.read alone, a research read allowed at the Peak', () => {
  assert.deepEqual(OBJECT_KINDS.ledger_desk.grants, ['ledger.read']);
  assert.equal(OBJECT_KINDS.ledger_desk.label, 'Ledger desk');
  assert.match(OBJECT_KINDS.ledger_desk.hint, /no data/);
  assert.deepEqual(LEDGER_DESK_TOOL_NAMES, ['ledger.read']);
  assert.equal(TOOL_DOMAINS['ledger.read'], 'research');
  assert.ok(!PEAK_REFUSED_KINDS.includes('ledger_desk'), 'a read moves no money');
  assert.deepEqual(grantsFor(layoutWithDesk(true), 'books'), ['ledger.read']);
  assert.deepEqual(grantsFor(layoutWithDesk(false), 'books'), []);
});

test('ledger.read: the park, a venture and a Ranger over N days, economics from the engine, absent data named under noData, today from the leash ledger', () => {
  const layout = layoutWithDesk();
  const desk = createLedgerDesk({ results: fakeResults(), ledger: fakeLedger, getLayout: () => layout, clock });
  const park = desk.read({});
  assert.equal(park.scope, 'park');
  assert.equal(park.days, 3);
  assert.deepEqual(park.window, { from: '2026-10-09', to: '2026-10-11' });
  assert.equal(park.economics.revenue, 150);
  assert.equal(park.economics.fees, 4.5);
  assert.equal(park.economics.adSpend, 10);
  assert.equal(park.economics.orders, 6);
  assert.equal(park.economics.modelSpend, 0.8);
  assert.equal(park.economics.refunds, null, 'no source holds refunds');
  assert.deepEqual(park.noData, ['refunds']);
  assert.equal(park.economics.contribution, 135.5);
  assert.deepEqual(park.sources, { shopify: false, etsy: true, stripe: true, meta_ads: false, google_ads: false, mail: true });
  assert.equal(park.today.day, '2026-10-11');
  assert.deepEqual(park.today.domains.money_out, { usd: 10, actions: 1 });
  assert.deepEqual(Object.keys(park.today.agents), ['books', 'ads']);
  assert.deepEqual(park.today.judge, { usd: 0.02, calls: 2 });
  assert.equal(park.lastRollup.reason, 'sync');
  assert.equal(park.asOf, '2026-10-11T09:00:00.000Z');
  assert.equal(park.series, undefined, 'summary has no day rows');

  const venture = desk.read({ scope: 'venture', venture: 'lantern-co', days: 2, detail: 'days' });
  assert.deepEqual(venture.venture, { id: 'lantern-co', name: 'Lantern Co', budgetUsd: 20, spentUsd: 10.8, crew: ['books'] });
  assert.deepEqual(venture.proposal, { verdict: 'hold', because: ['too early'] });
  assert.equal(venture.days, 2);
  assert.deepEqual(venture.window, { from: '2026-10-10', to: '2026-10-11' });
  assert.equal(venture.economics.revenue, 50);
  assert.equal(venture.series.length, 2);
  assert.equal(venture.series[0].day, '2026-10-10');
  assert.equal(venture.series[0].adSpend, 10);
  assert.equal(venture.series[1].revenue, null);
  assert.deepEqual(Object.keys(venture.series[0]), ['day', 'revenue', 'refunds', 'fees', 'adSpend', 'orders', 'modelSpend', 'modelSpendByTier', 'unpricedTurns', 'hostedCalls', 'mailIn', 'mailOut', 'itemsDone', 'itemsFailed', 'gateApproved', 'gateRejected', 'currencies', 'notes']);

  const agent = desk.read({ scope: 'agent', agentId: 'books' });
  assert.deepEqual(agent.agent, { id: 'books', name: 'Bo', specialty: 'books', venture: 'lantern-co' });
  assert.equal(agent.economics.modelSpend, 0.15, 'the day without a row counts as empty');
  assert.equal(agent.economics.revenue, null);
  assert.deepEqual(Object.keys(agent.today.agents), ['books'], 'only this Ranger\'s ledger line');

  assert.throws(() => desk.read({ scope: 'venture', venture: 'nope' }), /no venture "nope" in the plan; known: lantern-co/);
  assert.throws(() => desk.read({ scope: 'agent', agentId: 'nobody' }), /no Ranger "nobody"/);
  assert.throws(() => desk.read({ scope: 'everything' }), /scope must be one of park, venture, agent/);
  assert.equal(desk.read({ days: 1000 }).days, 3, `days are clamped to ${LEDGER_READ_MAX_DAYS} and to what exists`);
  assert.equal(desk.read({ days: 0 }).days, 3, 'a zero reads the default');
});

test('ledger.read as a tool: granted through the desk in the zone, answers through the gate without a Gate item, refuses outside the schema and reports an unknown venture as a failed call', async () => {
  const layout = layoutWithDesk();
  const desk = createLedgerDesk({ results: fakeResults(), ledger: fakeLedger, getLayout: () => layout, clock });
  const tool = desk.tools['ledger.read'];
  assert.equal(tool.confirm, false);
  assert.equal(tool.summarize({ scope: 'venture', venture: 'lantern-co' }), 'read the books (venture lantern-co, 30 days)');
  assert.equal(tool.summarize({}), 'read the books (park, 30 days)');
  const bad = await tool.run({ scope: 'venture', venture: 'nope' });
  assert.deepEqual(bad, { ok: false, code: 'UNKNOWN_VENTURE', error: 'no venture "nope" in the plan; known: lantern-co' });
  const submitted = [];
  const gate = createToolGate({ getLayout: () => layout, agentId: 'books', workspaceDir: '/tmp/none', registry: { ...desk.tools }, grants: allGrantsFor, toolContext: {}, getLeash: () => defaultLeash(), ledger: { checkCap: () => ({ ok: true }), reserve: () => ({ ok: true, commit() {}, release() {} }), recordAction: async () => {}, streak: () => ({ approvals: 0 }) }, submit: { submit: (item) => submitted.push(item), log: (item) => submitted.push(item) } });
  assert.deepEqual(gate.definitions().map((d) => d.name), ['ledger.read']);
  const r = await gate.execute({ id: 'c1', name: 'ledger.read', input: { scope: 'park', days: 7 } }, { runId: 'run-1', turn: 1 });
  assert.equal(r.ok, true, r.error);
  const out = JSON.parse(r.output);
  assert.equal(out.scope, 'park');
  assert.equal(out.economics.revenue, 150);
  assert.deepEqual(submitted.filter((i) => i.kind === 'action' && i.status === 'pending'), [], 'a read never waits at the Gate');
  const refused = await gate.execute({ id: 'c2', name: 'ledger.read', input: { scope: 'park', budget: 'all' } }, { runId: 'run-1', turn: 2 });
  assert.equal(refused.ok, false);
  const noDesk = createToolGate({ getLayout: () => layoutWithDesk(false), agentId: 'books', workspaceDir: '/tmp/none', registry: { ...desk.tools }, grants: allGrantsFor, toolContext: {}, getLeash: () => defaultLeash(), ledger: fakeLedger, submit: { submit() {}, log() {} } });
  assert.deepEqual(noDesk.definitions(), [], 'no desk, no read');
});
