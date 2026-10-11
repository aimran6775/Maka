// Phase 4 step 10: the Scout's memory. Pure scoring, the memory over a fake results engine,
// and through the sidecar: a Scout's brief recorded with the judge reading the history, the
// Chief's brief.decide, the next Scout run carrying "what we learned".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createStore } from '../sidecar/store.js';
import { createEventBus } from '../sidecar/bus.js';
import { createScoutMemory, scoreEstimate, outcomeOf, BRIEF_CHANNELS, OUTCOME_MIN_DAYS } from '../sidecar/scout-memory.js';
import { VENTURE_BRIEF_SCHEMA } from '../sidecar/research/brief.js';
import { roleGrants } from '../shared/world.js';
import { validate } from '../shared/schema.js';
import { initialState, applySnapshot, applyEvent } from '../frontend/state.js';
import { defaultLayout } from '../shared/world.js';
import { makeEvent } from '../shared/events.js';
import { fakeProvider, fakeClock, text, end, toolCall } from './helpers/fake-provider.js';
import { startTestServer } from './helpers/test-server.js';
import { startFakeResearch } from './helpers/fake-research.js';

const BRIEF = {
  ventureId: 'lantern-co',
  title: 'Paper lanterns on Etsy',
  summary: 'Handmade paper lanterns, $25 each, sold on Etsy with small ad budgets.',
  opportunity: 'Lantern sales grew 40 % this year on handmade marketplaces; makers report waiting lists.',
  evidence: [
    { claim: 'Lanterns sold 40 % more this year', source: 'https://stats.example/report-2026', date: '2026-09-01' },
    { claim: 'Makers have waiting lists of weeks', source: 'https://trailtimes.example/lanterns', date: '2026-09-30' },
  ],
  costs: [{ item: 'Materials per lantern', usd: 6, basis: 'Trail Times quotes a unit cost near $6', recurring: 'per_unit' }],
  revenueModel: '$25 per lantern, 30 a month at first.',
  risks: ['Seasonal demand'],
  recommendation: 'go',
  confidence: 0.7,
  niche: 'Garden Lanterns',
  channel: 'etsy',
  estimates: { monthlyRevenueUsd: 750, ordersPerMonth: 30, monthlyAdSpendUsd: 100, contributionPerOrderUsd: 15 },
};

test('scoreEstimate scales monthly figures to the observed days; an unknown actual stays unknown', () => {
  assert.deepEqual(scoreEstimate(300, 100, { days: 15 }), { expected: 150, actual: 100, ratio: 0.6667, precision: 0.6667, unknown: false });
  assert.deepEqual(scoreEstimate(15, 15, { days: 3, monthly: false }), { expected: 15, actual: 15, ratio: 1, precision: 1, unknown: false });
  assert.equal(scoreEstimate(300, null, { days: 15 }).unknown, true);
  assert.equal(scoreEstimate(300, null, { days: 15 }).expected, 150);
  assert.equal(scoreEstimate(0, 0).precision, 1);
  assert.equal(scoreEstimate(100, 0).precision, 0);
  assert.equal(scoreEstimate('x', 1), null);
});

test('outcomeOf: not launched, too early, held, missed, unknown without revenue data', () => {
  assert.equal(outcomeOf('go', null), 'not launched');
  assert.match(outcomeOf('no_go', null), /no outcome to score/);
  assert.equal(outcomeOf('go', { daysObserved: 3, all: { net: 5 } }), `too early (3 of ${OUTCOME_MIN_DAYS} days)`);
  assert.equal(outcomeOf('go', { daysObserved: 20, all: { net: 5 } }), 'held');
  assert.equal(outcomeOf('go', { daysObserved: 20, all: { net: -5 } }), 'missed');
  assert.equal(outcomeOf('go', { daysObserved: 20, all: { net: null } }), 'unknown (no revenue data)');
  assert.match(outcomeOf('no_go', { daysObserved: 20, all: { net: 5 } }), /^missed/);
  assert.match(outcomeOf('no_go', { daysObserved: 20, all: { net: -5 } }), /^held/);
});

test('the brief schema takes niche, channel and checkable estimates, all optional; the Chief holds brief.decide', () => {
  assert.ok(validate(VENTURE_BRIEF_SCHEMA, BRIEF).ok);
  const { niche, channel, estimates, ...plain } = BRIEF;
  assert.ok(validate(VENTURE_BRIEF_SCHEMA, plain).ok);
  assert.ok(!validate(VENTURE_BRIEF_SCHEMA, { ...BRIEF, channel: 'tiktok' }).ok);
  assert.ok(!validate(VENTURE_BRIEF_SCHEMA, { ...BRIEF, estimates: { monthlyRevenueUsd: -1 } }).ok);
  assert.ok(!validate(VENTURE_BRIEF_SCHEMA, { ...BRIEF, estimates: { profit: 1 } }).ok);
  assert.ok(BRIEF_CHANNELS.includes('etsy'));
  assert.ok(roleGrants('chief_ranger').includes('brief.decide'));
  assert.ok(!roleGrants('ranger').includes('brief.decide'));
});

async function memoryHarness({ ventures = [] } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-scout-'));
  const store = createStore({ root: dir });
  await store.init();
  const bus = createEventBus();
  const events = [];
  bus.listen((e) => events.push(e));
  const clock = fakeClock();
  const results = { compute: () => ({ ventures }) };
  const memory = await createScoutMemory({ store, bus, getResults: () => results, clock, log: { error() {} } }).init();
  return { dir, store, bus, events, clock, memory, ventures, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

const venture = (id, { days, revenue, orders, adSpend, net, contributionPerOrder = null }) => ({ id, all: { revenue, orders, adSpend, modelSpend: 1, net, contributionPerOrder }, proposal: { numbers: { daysObserved: days } } });

test('the memory: a brief is recorded, the Chief decides, the venture\'s actuals score the estimates, history groups by niche and channel, the prompt says what was learned', async () => {
  const h = await memoryHarness({ ventures: [venture('lantern-co', { days: 15, revenue: 250, orders: 10, adSpend: 60, net: 90, contributionPerOrder: 14 })] });
  try {
    // Empty: the prompt says so and asks for checkable estimates.
    assert.match(h.memory.promptLines()[0], /no venture brief is recorded yet/);
    assert.match(h.memory.judgeScope(BRIEF), /SCOPE: the worker submitted a venture brief/);
    assert.match(h.memory.judgeScope(BRIEF), /no venture brief is recorded yet/);
    const rec = { id: 'brief-2026-10-11-aaaaa', agentId: 'scout', runId: 'r1', submittedAt: 1000, judge: { verdict: 'approve', notes: 'fine' }, brief: BRIEF, totals: { one_off: 0, monthly: 0, per_unit: 6 } };
    const e = await h.memory.record(rec);
    assert.equal(e.niche, 'garden lanterns', 'niches are normalised');
    assert.equal(e.channel, 'etsy');
    assert.deepEqual(e.estimates, BRIEF.estimates);
    assert.equal(e.decision, null);
    const recorded = h.events.find((ev) => ev.type === 'scout.brief');
    assert.equal(recorded.payload.change, 'recorded');
    assert.equal(recorded.payload.estimates, 4);
    assert.equal(recorded.payload.niche, 'garden lanterns');
    // Decisions: validated, must name a recorded brief.
    await assert.rejects(() => h.memory.decide({ briefId: 'nope', decision: 'go' }), /no brief nope/);
    await assert.rejects(() => h.memory.decide({ briefId: rec.id, decision: 'maybe' }), /bad decision/);
    const out = await h.memory.tools['brief.decide'].run({ briefId: rec.id, decision: 'go', ventureId: 'lantern-co', reason: 'evidence holds' }, { agentId: 'chief-ranger' });
    assert.ok(out.ok, out.error);
    assert.equal(JSON.parse(out.output).ventureId, 'lantern-co');
    assert.equal(h.events.filter((ev) => ev.type === 'scout.brief').at(-1).payload.decision, 'go');
    // Scored against the venture: 15 of 30 days → half the monthly estimates expected.
    const [row] = h.memory.list();
    assert.equal(row.joined, true);
    assert.equal(row.daysObserved, 15);
    assert.deepEqual(row.scores.monthlyRevenueUsd, { expected: 375, actual: 250, ratio: 0.6667, precision: 0.6667, unknown: false });
    assert.deepEqual(row.scores.ordersPerMonth, { expected: 15, actual: 10, ratio: 0.6667, precision: 0.6667, unknown: false });
    assert.deepEqual(row.scores.monthlyAdSpendUsd, { expected: 50, actual: 60, ratio: 1.2, precision: 0.8333, unknown: false });
    assert.deepEqual(row.scores.contributionPerOrderUsd, { expected: 15, actual: 14, ratio: 0.9333, precision: 0.9333, unknown: false });
    assert.equal(row.outcome, 'held');
    assert.equal(row.decision.by, 'chief-ranger');
    // A second brief in another niche, no go, never launched: no outcome, nothing joined.
    await h.memory.record({ id: 'brief-2026-10-11-bbbbb', agentId: 'scout', submittedAt: 2000, judge: { verdict: 'reject' }, brief: { ...BRIEF, title: 'Candles', ventureId: undefined, niche: 'scented candles', channel: 'shopify', recommendation: 'no_go', estimates: { monthlyRevenueUsd: 100 } } });
    const hist = h.memory.history();
    assert.deepEqual(hist.totals, { briefs: 2, go: 1, noGo: 1, needsMore: 0, joined: 1, decided: 1 });
    const lanterns = hist.byNiche.find((g) => g.niche === 'garden lanterns');
    assert.equal(lanterns.briefs, 1);
    assert.equal(lanterns.held, 1);
    assert.equal(lanterns.precision.monthlyRevenueUsd.mean, 0.6667);
    assert.equal(lanterns.precision.monthlyRevenueUsd.meanRatio, 0.6667);
    const candles = hist.byNiche.find((g) => g.niche === 'scented candles');
    assert.equal(candles.joined, 0);
    assert.deepEqual(candles.precision, {});
    assert.equal(hist.byChannel.find((g) => g.channel === 'etsy').go, 1);
    assert.equal(h.memory.history({ niche: 'Garden  Lanterns' }).totals.briefs, 1);
    assert.equal(h.memory.history({ channel: 'shopify' }).totals.briefs, 1);
    // The prompt: totals, the niche's precision in words, the ask for checkable estimates.
    const lines = h.memory.promptLines({ niche: 'garden lanterns', channel: 'etsy' });
    assert.match(lines[0], /2 venture brief\(s\) so far \(1 go, 1 no-go, 0 needs more evidence; 1 joined/);
    assert.match(lines.find((l) => /niche "garden lanterns"/.test(l)), /revenue estimates ran 1\.5× high \(precision 0\.67 over 1\)/);
    assert.match(lines.find((l) => /niche "garden lanterns"/.test(l)), /recommendations: 1 held, 0 missed, 0 too early/);
    assert.match(lines.find((l) => /niche "scented candles"/.test(l)), /none joined to a venture yet/);
    assert.match(lines.at(-1), /Give estimates you can check/);
    assert.match(h.memory.judgeScope({ niche: 'garden lanterns', channel: 'etsy' }), /ran 1\.5× high/);
    // The summary for the snapshot carries no id lists.
    const sum = h.memory.summary();
    assert.equal(sum.recent.find((r) => r.id === rec.id).outcome, 'held');
    assert.equal(sum.recent[0].id, 'brief-2026-10-11-bbbbb', 'newest first');
    assert.ok(!('ids' in sum.byNiche[0]));
    // Persistence: a fresh memory reads it back, decision included.
    const again = await createScoutMemory({ store: h.store, bus: createEventBus(), getResults: () => ({ compute: () => ({ ventures: h.ventures }) }), clock: h.clock }).init();
    assert.equal(again.list().find((r) => r.id === rec.id).decision.decision, 'go');
    assert.equal(again.list().length, 2);
    // Without a results engine every joined row is unjoined, never estimated.
    const blind = await createScoutMemory({ store: h.store, bus: createEventBus(), getResults: () => null, clock: h.clock }).init();
    assert.equal(blind.list()[1].joined, false);
    assert.equal(blind.list()[1].outcome, 'not launched');
    assert.equal(blind.list()[1].scores.monthlyRevenueUsd.unknown, true);
  } finally {
    await h.cleanup();
  }
});

test('too early and unknown outcomes are said as such', async () => {
  const h = await memoryHarness({ ventures: [venture('v-early', { days: 3, revenue: 10, orders: 1, adSpend: 0, net: 5 }), venture('v-blind', { days: 20, revenue: null, orders: null, adSpend: null, net: null })] });
  try {
    await h.memory.record({ id: 'b1', agentId: 's', submittedAt: 1, brief: { ...BRIEF, ventureId: 'v-early' } });
    await h.memory.record({ id: 'b2', agentId: 's', submittedAt: 2, brief: { ...BRIEF, ventureId: 'v-blind' } });
    const rows = h.memory.list();
    assert.equal(rows.find((r) => r.id === 'b1').outcome, `too early (3 of ${OUTCOME_MIN_DAYS} days)`);
    const blind = rows.find((r) => r.id === 'b2');
    assert.equal(blind.outcome, 'unknown (no revenue data)');
    assert.equal(blind.scores.monthlyRevenueUsd.unknown, true);
    assert.equal(blind.scores.monthlyRevenueUsd.expected, 500);
    assert.equal(h.memory.history().byNiche[0].tooEarly, 1);
  } finally {
    await h.cleanup();
  }
});

test('the frontend reducer keeps the snapshot summary and marks it stale on scout.brief', () => {
  const base = { seq: 0, providers: {}, keystore: { path: '/x', problem: null }, layout: defaultLayout(), objectKinds: {}, activeRun: null, spend: { totalUsd: 0, reconciledTurns: 0, unreconciledTurns: 0 } };
  let s = applySnapshot(initialState(), { ...base, scoutMemory: { totals: { briefs: 1, go: 1, noGo: 0, needsMore: 0, joined: 0, decided: 0 }, byNiche: [], byChannel: [], recent: [] } });
  assert.equal(s.scoutMemory.totals.briefs, 1);
  s = applyEvent(s, { ...makeEvent('scout.brief', { briefId: 'b', change: 'decided', decision: 'go' }, { ts: 9 }), seq: 1 });
  assert.equal(s.scoutMemory.stale, true);
  assert.equal(s.scoutMemory.latest.decision, 'go');
  assert.equal(s.scoutMemory.totals.briefs, 1);
});

test('through the sidecar: the judge reads the history, the brief lands in the memory, the Chief decides with brief.decide, the next Scout run carries what was learned', async () => {
  const fake = await startFakeResearch();
  const layout = defaultLayout();
  layout.rooms.push({ id: 'research', name: 'Research Camp', kind: 'research', x: 21, y: 1, w: 8, h: 6 });
  layout.objects.push({ id: 'sign', kind: 'trailhead_sign', roomId: 'research', x: 22, y: 2 });
  layout.agents.push({ id: 'scout', name: 'Sky', roomId: 'research', x: 21, y: 1, role: 'ranger', specialty: 'scout' });
  const worker = fakeProvider([
    [...toolCall('r1', 'brief.submit', BRIEF), end('tool_use')],
    [text('Brief submitted.'), end()],
    [text('Second run: nothing to do.'), end()],
  ]);
  let briefId = null; // filled once the Scout's brief is recorded; the Chief's script reads it
  const chiefScript = fakeProvider([
    () => [...toolCall('d1', 'brief.decide', { briefId, decision: 'go', ventureId: 'lantern-co', reason: 'the evidence holds' }), end('tool_use')],
    [text('Decided: go.'), end()],
  ], { name: 'anthropic' });
  const judgeScript = fakeProvider([
    [text('{"verdict":"approve","notes":"evidence cited, costs real"}'), end('end_turn', { inputTokens: 300, outputTokens: 20 })],
    [text('{"verdict":"approve","notes":"final answer fine"}'), end('end_turn', { inputTokens: 200, outputTokens: 10 })],
    [text('{"verdict":"approve","notes":"fine"}'), end('end_turn', { inputTokens: 200, outputTokens: 10 })],
    [text('{"verdict":"approve","notes":"fine"}'), end('end_turn', { inputTokens: 200, outputTokens: 10 })],
  ], { name: 'anthropic' });
  const judgeProvider = async (name, opts) => ({ provider: judgeScript, model: opts.model || 'm', price: { inputPerMTok: 2, outputPerMTok: 10 } });
  const srv = await startTestServer({ layout, withChief: true, makeProvider: async (name, opts) => (name === 'anthropic' ? { provider: chiefScript, model: opts.model || 'claude', price: { inputPerMTok: 2, outputPerMTok: 10 } } : { provider: worker, model: 'm', price: null }), judgeProvider, env: { BRAVE_SEARCH_API_KEY: fake.braveKey }, research: fake.endpoints });
  try {
    const empty = (await srv.get('/api/scout-memory')).body;
    assert.equal(empty.totals.briefs, 0);
    assert.match(empty.promptLines[0], /no venture brief is recorded yet/);
    const stream = await srv.sse();
    const r = await srv.post('/api/run', { prompt: 'Write the lantern brief.', agentId: 'scout' });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    // The Scout's system prompt carried the (empty) memory line.
    await stream.waitFor((e) => e.type === 'agent.run.end' && e.payload.runId === r.body.runId, 10000);
    assert.match(worker.requests[0].system, /What we learned: no venture brief is recorded yet/);
    // The judge's review of the brief carried the scope with the history.
    const judgeReq = judgeScript.requests[0];
    assert.match(judgeReq.messages[0].content[0].text, /SCOPE: the worker submitted a venture brief/);
    assert.match(judgeReq.messages[0].content[0].text, /no venture brief is recorded yet/);
    assert.match(judgeReq.messages[0].content[0].text, /Weigh the recommendation against this record/);
    await srv.runs.waitForIdle();
    const recorded = stream.events.find((e) => e.type === 'scout.brief');
    assert.equal(recorded.payload.change, 'recorded');
    assert.equal(recorded.payload.agentId, 'scout');
    briefId = recorded.payload.briefId;
    const mem = (await srv.get('/api/scout-memory')).body;
    assert.equal(mem.totals.briefs, 1);
    assert.equal(mem.briefs[0].id, briefId);
    assert.equal(mem.briefs[0].decision, null);
    assert.equal(mem.briefs[0].niche, 'garden lanterns');
    assert.equal(mem.briefs[0].joined, false, 'no plan names the venture yet');
    const briefs = (await srv.get('/api/briefs')).body;
    assert.equal(briefs[0].channel, 'etsy');
    assert.deepEqual(briefs[0].estimates, BRIEF.estimates);
    // The Chief decides through its own tool.
    const rc = await srv.runs.start({ agentId: 'chief-ranger', prompt: 'Decide on the lantern brief.', provider: 'anthropic' });
    await stream.waitFor((e) => e.type === 'agent.run.end' && e.payload.runId === rc.runId, 10000);
    const toolResult = stream.events.find((e) => e.type === 'agent.tool_result' && e.payload.runId === rc.runId);
    assert.ok(toolResult, 'the Chief called brief.decide');
    assert.ok(toolResult.payload.ok, toolResult.payload.error);
    await srv.runs.waitForIdle();
    const decided = stream.events.filter((e) => e.type === 'scout.brief').at(-1);
    assert.equal(decided.payload.change, 'decided');
    assert.equal(decided.payload.by, 'chief-ranger');
    const after = (await srv.get('/api/scout-memory')).body;
    assert.equal(after.briefs[0].decision.decision, 'go');
    assert.equal(after.totals.decided, 1);
    const state = (await srv.get('/api/state')).body;
    assert.equal(state.scoutMemory.totals.briefs, 1);
    assert.equal(state.scoutMemory.recent[0].decision, 'go');
    const saved = JSON.parse(await fsp.readFile(path.join(srv.home, 'scout-memory.json'), 'utf8'));
    assert.equal(saved.briefs[briefId].decision.ventureId, 'lantern-co');
    // The next Scout run's prompt carries the learned line; a non-Scout's does not.
    const r2 = await srv.post('/api/run', { prompt: 'Anything new?', agentId: 'scout' });
    await stream.waitFor((e) => e.type === 'agent.run.end' && e.payload.runId === r2.body.runId, 10000);
    assert.match(worker.requests.at(-1).system, /What we learned from 1 venture brief\(s\) so far \(1 go, 0 no-go/);
    assert.match(worker.requests.at(-1).system, /niche "garden lanterns": 1 brief\(s\)/);
    assert.ok(!/What we learned/.test(chiefScript.requests[0] ? chiefScript.requests[0].system : ''), "the Chief's prompt is not the Scout's");
    stream.close();
  } finally {
    await srv.close();
    await fake.close();
  }
});
