// D182: the portfolio, and the one way a business starts — the owner's word.
//
// The owner: "The business should Present me with business and I approve and this starts."
// Before this the park ran one mission with one plan and one budget, and a "venture" was a
// line item inside whatever the Chief last submitted: there was no way to hold two
// businesses with separate money, and the go/no-go was the Chief's own (`brief.decide`),
// with the owner never asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createStore } from '../sidecar/store.js';
import { createEventBus } from '../sidecar/bus.js';
import { createGateQueue } from '../sidecar/gate-queue.js';
import { createPortfolio, PROPOSAL_SCHEMA, DEFAULT_CEILING_USD, MAX_VENTURES } from '../sidecar/portfolio.js';
import { validate } from '../shared/schema.js';
import { GATE_ITEM_KINDS, VENTURE_STATUSES, PAYLOAD_SCHEMAS } from '../shared/events.js';
import { fakeClock } from './helpers/fake-provider.js';

const PROPOSAL = {
  name: 'Trail Maps',
  thesis: 'Printable hiking maps for state parks, sold as digital downloads to day hikers who want no phone signal. Low cost to make, no stock, and the demand is visible in search volume.',
  askUsd: 4,
  firstSteps: ['Pick three parks with the most search volume', 'Draft one map and price it', 'Put it on one storefront'],
  monthlyRevenueUsd: 120,
  contributionPerOrderUsd: 6.5,
  risks: ['Park map data may be licensed', 'Download fraud'],
  evidence: [{ kind: 'source', text: 'search volume for "printable trail map"', ref: 'https://example.com/trends' }],
};

async function setup({ ceilingUsd = DEFAULT_CEILING_USD, onApproved = null } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-portfolio-'));
  const store = createStore({ root: dir });
  await store.init();
  const bus = createEventBus();
  const events = [];
  bus.listen((e) => events.push(e));
  const clock = fakeClock();
  const gateQueue = await createGateQueue({ bus, store, clock }).init();
  const portfolio = await createPortfolio({ bus, store, gateQueue, clock, ceilingUsd, onApproved, log: { error() {}, info() {} } }).init();
  return { dir, store, bus, events, clock, gateQueue, portfolio, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

const ventureEvents = (events, id) => events.filter((e) => e.type === 'venture.updated' && e.payload.ventureId === id).map((e) => e.payload);

test('the contract additions are additive: a venture Gate item kind and a venture.updated event', () => {
  assert.ok(GATE_ITEM_KINDS.includes('venture'));
  // The kinds that existed before are untouched, which is what makes this additive.
  assert.ok(GATE_ITEM_KINDS.includes('action') && GATE_ITEM_KINDS.includes('proposal'));
  assert.deepEqual([...VENTURE_STATUSES], ['proposed', 'active', 'paused', 'stopped', 'declined']);
  const schema = PAYLOAD_SCHEMAS['venture.updated'];
  assert.ok(schema, 'the event is in the contract');
  assert.deepEqual(schema.required, ['ventureId', 'change', 'status']);
  assert.equal(validate(schema, { ventureId: 'a', change: 'approved', status: 'active', budgetUsd: 4 }).ok, true);
  assert.equal(validate(schema, { ventureId: 'a', change: 'started', status: 'active' }).ok, false, 'an unknown change is refused');
});

test('a proposal must carry enough for the owner to decide on it', () => {
  assert.equal(validate(PROPOSAL_SCHEMA, PROPOSAL).ok, true);
  // A thesis too short to judge, no budget asked, and no first steps are each refused:
  // a card the owner cannot act on would be approved on trust.
  assert.equal(validate(PROPOSAL_SCHEMA, { ...PROPOSAL, thesis: 'Sell stuff' }).ok, false);
  assert.equal(validate(PROPOSAL_SCHEMA, { ...PROPOSAL, firstSteps: [] }).ok, false);
  const { askUsd, ...noAsk } = PROPOSAL;
  assert.equal(validate(PROPOSAL_SCHEMA, noAsk).ok, false);
  assert.equal(validate(PROPOSAL_SCHEMA, { ...PROPOSAL, askUsd: -1 }).ok, false);
  assert.equal(validate(PROPOSAL_SCHEMA, { ...PROPOSAL, extra: 1 }).ok, false);
});

test('the park proposes, nothing starts, the owner approves, and that is what starts it', async () => {
  const started = [];
  const h = await setup({ onApproved: (v) => started.push(v) });
  try {
    const v = await h.portfolio.propose(PROPOSAL, { by: 'research-lead', runId: 'run-1' });
    assert.equal(v.status, 'proposed');
    assert.equal(v.id, 'trail-maps', 'the id reads as the business');
    assert.equal(v.budgetUsd, 0, 'no money is committed by proposing');
    assert.deepEqual(started, [], 'and nothing has started');

    // The owner has a card at the Gate with the whole case on it.
    const pending = h.gateQueue.pending();
    assert.equal(pending.length, 1);
    const item = pending[0];
    assert.equal(item.kind, 'venture', 'not an action: no run is parked on it');
    assert.equal(item.amountUsd, 4);
    assert.match(item.summary, /start a business: Trail Maps/);
    const card = item.evidence.find((e) => e.kind === 'proposal').text;
    assert.match(card, /Printable hiking maps/);
    assert.match(card, /Asking for: \$4\.00/);
    assert.match(card, /Pick three parks/, 'the first steps are on the card');
    assert.match(card, /\$0\.00 of \$100\.00/, 'and what the portfolio has already committed');
    assert.match(card, /Park map data may be licensed/, 'with the risks it names');
    assert.match(item.reason, /Nothing starts without your word/);

    // The proposing run did not park: propose() already returned.
    assert.equal(ventureEvents(h.events, v.id)[0].change, 'proposed');

    // The owner approves. That is the moment the business starts.
    await h.gateQueue.resolve(item.itemId, { decision: 'approve', notes: 'go on then' });
    await new Promise((r) => setTimeout(r, 10));
    const after = h.portfolio.get(v.id);
    assert.equal(after.status, 'active');
    assert.equal(after.budgetUsd, 4, 'the budget the owner approved');
    assert.equal(after.askUsd, 4, 'and what was asked, kept apart from it');
    assert.equal(after.reason, 'go on then');
    assert.equal(started.length, 1, 'approval is what starts the work');
    assert.equal(started[0].id, v.id);
    const changes = ventureEvents(h.events, v.id).map((e) => e.change);
    assert.deepEqual(changes, ['proposed', 'approved']);
    assert.equal(h.portfolio.committedUsd(), 4);

    // It survives a restart as an active business with its budget.
    const again = await createPortfolio({ bus: h.bus, store: h.store, gateQueue: h.gateQueue, clock: h.clock, log: { error() {}, info() {} } }).init();
    assert.equal(again.get(v.id).status, 'active');
    assert.equal(again.get(v.id).budgetUsd, 4);
  } finally {
    await h.cleanup();
  }
});

test('the owner says no, and the business does not start', async () => {
  const started = [];
  const h = await setup({ onApproved: (v) => started.push(v) });
  try {
    const v = await h.portfolio.propose(PROPOSAL, { by: 'research-lead' });
    await h.gateQueue.resolve(h.gateQueue.pending()[0].itemId, { decision: 'reject', notes: 'not this one' });
    await new Promise((r) => setTimeout(r, 10));
    const after = h.portfolio.get(v.id);
    assert.equal(after.status, 'declined');
    assert.equal(after.budgetUsd, 0, 'no money was committed');
    assert.equal(after.reason, 'not this one', 'and the owner\'s reason is on the record');
    assert.deepEqual(started, []);
    assert.equal(h.portfolio.committedUsd(), 0);
    assert.deepEqual(ventureEvents(h.events, v.id).map((e) => e.change), ['proposed', 'declined']);
  } finally {
    await h.cleanup();
  }
});

test('the portfolio ceiling is checked when a business is proposed and again when it is approved', async () => {
  const h = await setup({ ceilingUsd: 10 });
  try {
    // Two cards go out, each inside the ceiling on its own.
    const a = await h.portfolio.propose({ ...PROPOSAL, name: 'One', askUsd: 6 }, { by: 'r' });
    const b = await h.portfolio.propose({ ...PROPOSAL, name: 'Two', askUsd: 6 }, { by: 'r' });
    // A third that cannot fit even unapproved is refused outright, with the remedy named.
    await assert.rejects(
      h.portfolio.propose({ ...PROPOSAL, name: 'Three', askUsd: 11 }, { by: 'r' }),
      (e) => e.code === 'OVER_CEILING' && /raise the ceiling/.test(e.message),
    );

    const items = h.gateQueue.pending();
    await h.gateQueue.resolve(items.find((i) => /One/.test(i.summary)).itemId, { decision: 'approve' });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(h.portfolio.get(a.id).status, 'active');
    assert.equal(h.portfolio.committedUsd(), 6);

    // The second was approvable when it was proposed but not by the time it was approved:
    // the owner sat on two cards that together exceed the ceiling. It is declined with the
    // arithmetic, rather than quietly overcommitting the park.
    await h.gateQueue.resolve(items.find((i) => /Two/.test(i.summary)).itemId, { decision: 'approve' });
    await new Promise((r) => setTimeout(r, 10));
    const second = h.portfolio.get(b.id);
    assert.equal(second.status, 'declined');
    assert.match(second.reason, /only \$4\.00 left/);
    assert.equal(h.portfolio.committedUsd(), 6, 'the ceiling held');
  } finally {
    await h.cleanup();
  }
});

test('many businesses at once, each with its own money and its own state', async () => {
  const h = await setup({ ceilingUsd: 100 });
  try {
    // Ten businesses, which is the point: the park is a portfolio, not one mission.
    for (let i = 0; i < 10; i++) {
      const v = await h.portfolio.propose({ ...PROPOSAL, name: `Venture ${i}`, askUsd: 2 }, { by: 'research-lead' });
      await h.gateQueue.resolve(h.portfolio.get(v.id).itemId, { decision: 'approve' });
    }
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.portfolio.active().length, 10);
    assert.equal(h.portfolio.committedUsd(), 20);
    const ids = h.portfolio.list().map((v) => v.id);
    assert.equal(new Set(ids).size, 10, 'every venture has its own id');
    assert.ok(ids.includes('venture-0') && ids.includes('venture-9'));

    // Pausing one leaves the others alone and keeps its budget.
    await h.portfolio.pause('venture-3', 'waiting on a supplier');
    assert.equal(h.portfolio.get('venture-3').status, 'paused');
    assert.equal(h.portfolio.get('venture-3').budgetUsd, 2, 'its money is still committed to it');
    assert.equal(h.portfolio.active().length, 9);
    assert.equal(h.portfolio.committedUsd(), 20, 'a paused venture still holds its budget');
    await assert.rejects(h.portfolio.pause('venture-3'), (e) => e.code === 'CONFLICT');
    await h.portfolio.resume('venture-3');
    assert.equal(h.portfolio.get('venture-3').status, 'active');

    // Stopping one frees its budget for the next proposal.
    await h.portfolio.stop('venture-4', 'no demand');
    assert.equal(h.portfolio.get('venture-4').status, 'stopped');
    assert.equal(h.portfolio.committedUsd(), 18, 'a stopped venture releases its budget');
    assert.equal(h.portfolio.get('venture-4').reason, 'no demand');
    assert.deepEqual(h.portfolio.get('venture-4').history.map((x) => x.change), ['approved', 'stopped']);

    const state = h.portfolio.state();
    assert.equal(state.ventures, 10);
    assert.equal(state.counts.active, 9);
    assert.equal(state.counts.stopped, 1);
    assert.equal(state.ceilingUsd, 100);

    await assert.rejects(h.portfolio.stop('nope'), (e) => e.code === 'NOT_FOUND');
    await assert.rejects(h.portfolio.resume('venture-0'), (e) => e.code === 'CONFLICT');
  } finally {
    await h.cleanup();
  }
});

test('two businesses of the same name get their own ids rather than colliding', async () => {
  const h = await setup();
  try {
    const a = await h.portfolio.propose(PROPOSAL, { by: 'r' });
    const b = await h.portfolio.propose(PROPOSAL, { by: 'r' });
    assert.equal(a.id, 'trail-maps');
    assert.equal(b.id, 'trail-maps-2');
  } finally {
    await h.cleanup();
  }
});

test('a venture left waiting when the park stopped is not left waiting for a decision that cannot arrive', async () => {
  const h = await setup();
  try {
    const v = await h.portfolio.propose(PROPOSAL, { by: 'r' });
    assert.equal(h.portfolio.get(v.id).status, 'proposed');
    // A restart loses the resolver the Gate item was waiting on, so the card is gone.
    const restarted = await createPortfolio({ bus: h.bus, store: h.store, gateQueue: h.gateQueue, clock: h.clock, log: { error() {}, info() {} } }).init();
    const after = restarted.get(v.id);
    assert.equal(after.status, 'declined');
    assert.match(after.reason, /propose it again/);
    assert.equal(restarted.committedUsd(), 0);
  } finally {
    await h.cleanup();
  }
});

test('the tools: propose returns at once and the portfolio can be read back', async () => {
  const h = await setup();
  try {
    const propose = h.portfolio.tools['venture.propose'];
    const list = h.portfolio.tools['venture.list'];
    const ctx = { agentId: 'research-lead', runId: 'run-9' };

    const out = JSON.parse((await propose.run(PROPOSAL, ctx)).output);
    assert.equal(out.status, 'proposed');
    assert.match(out.waitingFor, /owner at the Entrance Gate/);
    assert.equal(propose.confirm, false, 'the Gate item is the approval; a card as well would ask twice');
    assert.match(propose.summarize(PROPOSAL), /propose the business "Trail Maps" for \$4\.00/);

    const all = JSON.parse((await list.run({}, ctx)).output);
    assert.equal(all.ventures.length, 1);
    assert.equal(all.ceilingUsd, DEFAULT_CEILING_USD);
    assert.equal(all.counts.proposed, 1);
    const none = JSON.parse((await list.run({ status: 'active' }, ctx)).output);
    assert.deepEqual(none.ventures, [], 'nothing is active until the owner says so');

    // A proposal the owner could not judge is refused by the tool, not passed on.
    const bad = await propose.run({ ...PROPOSAL, thesis: 'too short' }, ctx);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /incomplete/);

    // And with no Gate there is nobody to ask, which is said rather than assumed.
    const noGate = await createPortfolio({ bus: h.bus, store: h.store, clock: h.clock, log: { error() {}, info() {} } }).init();
    const refused = await noGate.tools['venture.propose'].run(PROPOSAL, ctx);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /no Gate queue/);
  } finally {
    await h.cleanup();
  }
});

test('the portfolio has a hard size limit', async () => {
  assert.equal(MAX_VENTURES, 500);
  const h = await setup({ ceilingUsd: 10000 });
  try {
    // Filled directly: proposing five hundred through the Gate is not what is being checked.
    const v = await h.portfolio.propose(PROPOSAL, { by: 'r' });
    assert.ok(v.id);
    const state = h.portfolio.state();
    assert.ok(state.ventures < MAX_VENTURES);
  } finally {
    await h.cleanup();
  }
});

// D182: the proposing run ending must not decide the business.
//
// Found live, and it declined a real proposal. The venture item names the run that proposed
// it as provenance, and `expireRun` — which releases tool calls parked at the Gate when
// their run ends — expired it along with them. The Business Lead researched a business for
// twenty-five tool calls, proposed it, its run ended a second later, and the card died
// before the owner had seen it: "the run ended before a decision".
test('a venture card outlives the run that proposed it', async () => {
  const started = [];
  const h = await setup({ onApproved: (v) => started.push(v) });
  try {
    const v = await h.portfolio.propose(PROPOSAL, { by: 'business-lead', runId: 'run-1' });
    const item = h.gateQueue.pending()[0];
    assert.equal(item.kind, 'venture');
    assert.equal(item.runId, 'run-1', 'the run that proposed it is on the record');

    // The proposing run ends, as it does immediately in practice.
    await h.gateQueue.expireRun('run-1');
    assert.equal(h.gateQueue.pending().length, 1, 'the card is still waiting for the owner');
    assert.equal(h.portfolio.get(v.id).status, 'proposed');

    // And the owner can still approve it, hours later.
    await h.gateQueue.resolve(item.itemId, { decision: 'approve' });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(h.portfolio.get(v.id).status, 'active');
    assert.equal(started.length, 1);
  } finally {
    await h.cleanup();
  }
});

test('a tool call parked at the Gate is still expired when its run ends', async () => {
  const h = await setup();
  try {
    // The behaviour D182 must not break: an action has a run waiting on it, so the run
    // ending has to release it or the call would hang forever.
    const parked = h.gateQueue.submit({ agentId: 'ranger', kind: 'action', domain: 'publishing', tool: 'social.post', summary: 'post it', runId: 'run-2' });
    assert.equal(h.gateQueue.pending().length, 1);
    await h.gateQueue.expireRun('run-2');
    const decision = await parked;
    assert.equal(decision.status, 'expired');
    assert.equal(h.gateQueue.pending().length, 0);
  } finally {
    await h.cleanup();
  }
});

// D183: a venture's budget is its own pot.
//
// Found live, by the Chief, which said so plainly: "The budget is the main problem. The
// mission budget is only $3.00, so I could give this business $2.15 of your $20.00." The
// owner had approved $20 for a business and the Chief could hand it $2.15, because one
// mission budget was still the only pool in the park. A portfolio of a hundred businesses
// needs a hundred pools.
test('work for a venture draws on the budget the owner approved for it, not on the mission', async () => {
  const { createTrails } = await import('../sidecar/trails.js');
  const { createLayoutState } = await import('../sidecar/server.js');
  const { createAgents } = await import('../sidecar/agents.js');
  const { defaultLayout } = await import('../shared/world.js');

  const h = await setup();
  try {
    // One business approved at $20, a second at $5, and a $3 mission alongside them.
    const mk = async (name, ask) => {
      const v = await h.portfolio.propose({ ...PROPOSAL, name, askUsd: ask }, { by: 'business-lead' });
      await h.gateQueue.resolve(h.portfolio.get(v.id).itemId, { decision: 'approve' });
      await new Promise((r) => setTimeout(r, 10));
      return h.portfolio.get(v.id);
    };
    const big = await mk('Big', 20);
    const small = await mk('Small', 5);
    assert.equal(big.budgetUsd, 20);
    assert.equal(small.budgetUsd, 5);

    const layout = defaultLayout();
    layout.rooms.push({ id: 'mountain-peak', name: 'Peak', kind: 'mountain_peak', x: 0, y: 0, w: 2, h: 2 });
    layout.rooms.push({ id: 'research', name: 'Research', kind: 'research', x: 20, y: 1, w: 6, h: 6 });
    layout.agents.push({ id: 'chief-ranger', name: 'Chief', roomId: 'mountain-peak', x: 0, y: 0, role: 'chief_ranger' });
    layout.agents.push({ id: 'scout', name: 'Scout', roomId: 'research', x: 20, y: 1, role: 'ranger', parentAgentId: 'chief-ranger' });
    const layoutState = createLayoutState({ initial: layout, store: h.store, bus: h.bus, clock: h.clock });
    const agents = createAgents({ layoutState, bus: h.bus, clock: h.clock });
    const runs = { onRunEnd() {}, start: async () => ({ runId: 'r', queued: false }), budgetFor: () => null };
    const trails = await createTrails({ bus: h.bus, store: h.store, runs, agents, getLayout: layoutState.get, clock: h.clock, workspaceRoot: h.dir }).init();
    trails.setMissionBudget(() => ({ budgetUsd: 3, createdAt: 0 }));
    trails.setVentureBudget((id) => {
      const v = h.portfolio.get(id);
      return v && v.status === 'active' ? { budgetUsd: v.budgetUsd, createdAt: 0 } : null;
    });

    // The business the owner funded at $20 can be given $15 of it — the mission's $3 is
    // not what bounds it.
    const a = await trails.delegate({ toAgentId: 'scout', brief: 'niche research', budgetUsd: 15, venture: big.id }, { by: 'chief-ranger' });
    assert.equal(a.budgetUsd, 15, 'the venture funded it, not the mission');
    assert.equal(a.budgetCapped, false);

    // Its own pot is what runs out, and only its own spending counts against it.
    const b = await trails.delegate({ toAgentId: 'scout', brief: 'more', budgetUsd: 10, venture: big.id }, { by: 'chief-ranger' });
    assert.equal(b.budgetUsd, 5, 'capped at what is left of that venture');
    assert.equal(b.budgetCapped, true);
    await assert.rejects(
      trails.delegate({ toAgentId: 'scout', brief: 'and more', budgetUsd: 1, venture: big.id }, { by: 'chief-ranger' }),
      (e) => e.code === 'BUDGET_EXHAUSTED' && /approved for big/.test(e.message),
    );

    // The other business is untouched: twenty dollars of work on one does not spend the other.
    const c = await trails.delegate({ toAgentId: 'scout', brief: 'the small one', budgetUsd: 5, venture: small.id }, { by: 'chief-ranger' });
    assert.equal(c.budgetUsd, 5, 'each business has its own money');

    // Work that belongs to no venture still draws on the mission, as it always did.
    const d = await trails.delegate({ toAgentId: 'scout', brief: 'park housekeeping', budgetUsd: 10 }, { by: 'chief-ranger' });
    assert.equal(d.budgetUsd, 3, 'capped at the mission budget');
    assert.equal(d.venture, null);

    // A venture that is not active funds nothing, and the refusal says why.
    await h.portfolio.pause(small.id, 'on hold');
    await assert.rejects(
      trails.delegate({ toAgentId: 'scout', brief: 'paused work', budgetUsd: 1, venture: small.id }, { by: 'chief-ranger' }),
      (e) => /not an active venture|BUDGET/.test(e.message + e.code),
    );
  } finally {
    await h.cleanup();
  }
});
