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
import { createReflect, parseReflection, groundedNote, reflectionMarkdown, THRESHOLDS, REFLECT_SYSTEM_PROMPT } from '../sidecar/reflect.js';
import { createLayoutState } from '../sidecar/server.js';
import { createAgents } from '../sidecar/agents.js';
import { createLeashLedger, createLeashState } from '../sidecar/leash-ledger.js';
import { createGateQueue } from '../sidecar/gate-queue.js';
import { createRouter, defaultPolicy } from '../sidecar/router.js';
import { TOOLS } from '../sidecar/capability/tools.js';
import { CREW_TOOLS } from '../sidecar/capability/crew.js';
import { defaultLayout } from '../shared/world.js';
import { defaultLeash } from '../shared/leash.js';
import { fakeProvider, fakeClock, text, end, waitUntil } from './helpers/fake-provider.js';

const PRICE = { inputPerMTok: 4, outputPerMTok: 20 };
const REFLECTION = {
  portfolio: 'Lantern Co spent $0.00 of $3.00 and finished 1 of 2 tasks; revenue is unknown because no store is connected.',
  ventures: [
    { id: 'lantern-co', worked: ['1 work item done with 1 deliverable'], didNot: ['0 listings drafted yet'], planStillRight: false, revisions: ['Add a task to connect the Etsy store before drafting listings'], morale: 'Ada delivered 1 research file on budget ($0.00 of $1.00).' },
    { id: 'ghost', worked: [], didNot: [], planStillRight: true, revisions: [], morale: 'great job team!' },
  ],
  briefings: [{ zoneId: 'research', text: 'Research: 1 item done; next, verify the 5 shops with URLs.' }, { zoneId: 'nowhere', text: 'dropped' }],
};

async function setup({ reflectScript, policy = defaultPolicy(), judgeUsdToday = 0 } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-reflect-'));
  const home = path.join(dir, 'home');
  const workspaceRoot = path.join(dir, 'ws');
  await fsp.mkdir(workspaceRoot, { recursive: true });
  const store = createStore({ root: home });
  await store.init();
  const bus = createEventBus();
  const events = [];
  bus.listen((e) => events.push(e));
  const clock = fakeClock();
  const layoutState = createLayoutState({ initial: defaultLayout(), store, bus, clock });
  const agents = createAgents({ layoutState, bus, clock });
  const ledger = await createLeashLedger({ store, clock }).init();
  if (judgeUsdToday) await ledger.recordJudge({ usd: judgeUsdToday });
  const leashState = createLeashState({ initial: defaultLeash(), store });
  const gateQueue = await createGateQueue({ bus, store, ledger, leashState, getLayout: layoutState.get, clock }).init();
  const judgeProvider = fakeProvider(reflectScript(), { name: 'anthropic' });
  const chiefStarts = [];
  const makeProvider = async (name, opts) => (name === 'anthropic' ? { provider: judgeProvider, model: opts.model || 'judge', price: PRICE } : { provider: fakeProvider([[text('worker done'), end('end_turn', { inputTokens: 10, outputTokens: 5 })]], { name }), model: 'w', price: { inputPerMTok: 100, outputPerMTok: 100 } });
  const toolContext = {};
  const registry = { ...TOOLS, ...CREW_TOOLS };
  const router = createRouter(policy);
  const runs = createRunManager({ bus, store, getLayout: layoutState.get, workspaceRoot, makeProvider, clock, agents, toolContext, registry, ledger, gateQueue, leashState, policy, maxConcurrent: 3 });
  const trails = await createTrails({ bus, store, runs, agents, getLayout: layoutState.get, clock, workspaceRoot }).init();
  toolContext.trails = trails;
  const chief = await createChief({ bus, store, runs, agents, trails, ledger, router, getLayout: layoutState.get, clock, workspaceRoot, maxFollowUps: 5, log: { error() {} } }).init();
  // Stub the Chief's follow-up so the reflection test does not need a scripted Chief run.
  const realFollowUp = chief.followUp;
  chief.followUp = async (ev) => { chiefStarts.push(ev.payload); return null; };
  Object.assign(registry, chief.tools);
  const scheduler = await createScheduler({ store, clock, tickMs: 60_000, log: { error() {} } }).init();
  const reflect = await createReflect({ bus, store, runs, agents, trails, chief, ledger, gateQueue, router, scheduler, makeProvider, getLayout: layoutState.get, clock, workspaceRoot, env: {}, schedule: { daily: '07:00' }, log: { error() {} } }).init();
  return { dir, home, workspaceRoot, store, bus, events, clock, runs, trails, agents, chief, ledger, scheduler, reflect, judgeProvider, chiefStarts, layoutState, realFollowUp, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

// Seeds a mission with a plan and one venture crew without running the Chief.
async function seedPlan(h) {
  await h.agents.ensureChief();
  await h.store.saveMission({ id: 'mission-1', text: 'Sell lanterns', budgetUsd: 5, horizon: '30 days', status: 'active', reason: '', createdAt: h.clock.now(), followUps: 0, runIds: [] });
  await h.store.savePlan({ id: 'plan-1', missionId: 'mission-1', version: 1, submittedAt: h.clock.now(), by: 'chief-ranger', runId: '', summary: 'One venture.', ventures: [{ id: 'lantern-co', name: 'Lantern Co', summary: 'lanterns', budgetUsd: 3, roles: [], tasks: [{ id: 't1', title: 'Research', specialty: 'scout', brief: 'b', budgetUsd: 1 }, { id: 't2', title: 'Listings', specialty: 'storefront', brief: 'b', budgetUsd: 1 }] }], history: [] });
  await h.chief.init();
  const zone = await h.agents.ensureZone('research');
  const ada = await h.agents.create({ name: 'Ada', zoneId: zone.id, parentAgentId: 'chief-ranger', specialty: 'scout', venture: 'lantern-co' }, { by: 'chief-ranger' });
  return ada;
}

test('parsing, grounded notes and markdown', () => {
  assert.equal(parseReflection('x {"portfolio":"p","ventures":[]} y').portfolio, 'p');
  assert.equal(parseReflection('{"ventures":[]}'), null);
  assert.equal(parseReflection('nope'), null);
  assert.equal(groundedNote('Ada delivered 1 file.'), 'Ada delivered 1 file.');
  assert.match(groundedNote('Great job everyone!'), /no grounded note/);
  assert.equal(groundedNote(''), '(no note)');
  const md = reflectionMarkdown({ id: 'r1', reason: 'manual', at: 0, missionId: 'm', model: 'x', usd: 0.5, portfolio: 'P', ventures: [{ id: 'v', name: 'V', spentUsd: 1, budgetUsd: 2, itemsDone: 1, itemsFailed: 0, itemsOpen: 0, deliverables: 1, gateApproved: 0, gateRejected: 0, gatePending: 0, planStillRight: false, worked: ['a'], didNot: [], revisions: ['r'], morale: 'm 1' }], briefings: [{ zoneId: 'z', text: 't' }] });
  assert.match(md, /# Reflection r1 \(manual\)/);
  assert.match(md, /revenue unknown \(no connector\)/);
  assert.match(md, /### z/);
  assert.deepEqual([...THRESHOLDS], [0.8, 1]);
  assert.match(REFLECT_SYSTEM_PROMPT, /never estimate revenue/);
});

test('a reflection gathers real data, calls the reflect model, writes the document and briefings, emits reflection.posted and hands the Chief a follow-up', async () => {
  const h = await setup({ reflectScript: () => [[text(`Here: ${JSON.stringify(REFLECTION)}`), end('end_turn', { inputTokens: 2000, outputTokens: 400 })]] });
  try {
    const ada = await seedPlan(h);
    // One real delegated item for Ada that completes with a deliverable.
    await fsp.mkdir(path.join(h.workspaceRoot, ada.id, 'outbox'), { recursive: true });
    const item = await h.trails.delegate({ toAgentId: ada.id, brief: 'Find shops', budgetUsd: 1 }, { by: 'superintendent' }); // not from the Chief: its own follow-up would consume the script
    await h.runs.waitForIdle();
    assert.equal(h.trails.get(item.id).status, 'done');
    const data = await h.reflect.gather();
    assert.equal(data.mission.id, 'mission-1');
    assert.equal(data.ventures.length, 1);
    assert.equal(data.ventures[0].itemsDone, 1);
    assert.equal(data.ventures[0].runs, 1);
    assert.equal(data.ventures[0].crew[0].id, ada.id);
    assert.match(data.connectors, /none wired/);
    assert.ok(data.zones.some((z) => z.id === 'research'));

    const doc = await h.reflect.reflect({ reason: 'scheduled' });
    assert.equal(doc.status, 'posted', doc.skipReason);
    assert.equal(doc.model, 'claude-opus-5-5', 'the reflect step model');
    assert.equal(doc.ventures.length, 1, 'unknown ventures are dropped');
    assert.equal(doc.ventures[0].planStillRight, false);
    assert.deepEqual(doc.ventures[0].revisions, ['Add a task to connect the Etsy store before drafting listings']);
    assert.equal(doc.ventures[0].morale, 'Ada delivered 1 research file on budget ($0.00 of $1.00).');
    assert.equal(doc.ventures[0].itemsDone, 1, 'numbers come from the data, not the model');
    assert.deepEqual(doc.briefings.map((b) => b.zoneId), ['research'], 'briefings for unknown zones are dropped');
    assert.equal(doc.usd, (2000 * 4 + 400 * 20) / 1e6);
    const prompt = h.judgeProvider.requests[0].messages[0].content[0].text;
    assert.match(prompt, /VENTURE lantern-co "Lantern Co"/);
    assert.match(prompt, /work items done 1, failed 0, in flight 0; deliverables 0/);
    assert.match(prompt, /Connectors: none wired/);
    assert.equal(h.judgeProvider.requests[0].system, REFLECT_SYSTEM_PROMPT);
    const md = await fsp.readFile(path.join(h.workspaceRoot, doc.path), 'utf8');
    assert.match(md, /## Lantern Co \(lantern-co\)/);
    assert.equal(doc.briefingFiles.length, 1);
    assert.match(await fsp.readFile(path.join(h.workspaceRoot, doc.briefingFiles[0]), 'utf8'), /Briefing from the Mountain Peak/);
    assert.ok(await h.store.loadReflection(doc.id));
    assert.equal((await h.reflect.list())[0].id, doc.id);
    assert.equal(h.reflect.latest().id, doc.id);
    const posted = h.events.find((e) => e.type === 'reflection.posted').payload;
    assert.equal(posted.status, 'posted');
    assert.deepEqual(posted.briefings, ['research']);
    assert.deepEqual(posted.ventures[0], { id: 'lantern-co', planStillRight: false, spentUsd: 0.0015, budgetUsd: 3, itemsDone: 1, itemsFailed: 0 }, 'the worker turn cost 15 tokens at $100/MTok');
    assert.ok(h.events.some((e) => e.type === 'cost.estimate' && e.payload.tier === 'judge' && e.payload.runId === doc.id));
    assert.equal(h.ledger.judgeToday().calls, 1);
    await waitUntil(() => h.chiefStarts.length === 1);
    assert.equal(h.chiefStarts.length, 1, 'the Chief is asked to revise the plan');
    assert.match(h.chiefStarts[0].summary, /Revisions: lantern-co: Add a task/);
    assert.equal(h.chiefStarts[0].workItemId, doc.id);
    // Restart: the latest reflection is known again.
    const again = await createReflect({ bus: h.bus, store: h.store, runs: h.runs, agents: h.agents, trails: h.trails, chief: h.chief, ledger: h.ledger, router: createRouter(defaultPolicy()), scheduler: h.scheduler, getLayout: h.layoutState.get, clock: h.clock, workspaceRoot: h.workspaceRoot, log: { error() {} } }).init();
    assert.equal(again.latest().id, doc.id);
    assert.ok(again.state().spentByAgent[ada.id] > 0, 'spend seeded from persisted runs');
  } finally {
    await h.cleanup();
  }
});

test('skips are honest: judge cap, no key, unreadable answer; budget thresholds fire once and trigger a reflection at 100 %', async () => {
  const policy = defaultPolicy();
  policy.caps.judgeUsdPerDay = 1;
  const capped = await setup({ reflectScript: () => [], policy, judgeUsdToday: 1 });
  try {
    await seedPlan(capped);
    const doc = await capped.reflect.reflect({ reason: 'manual' });
    assert.equal(doc.status, 'skipped');
    assert.match(doc.skipReason, /judge daily cap reached/);
    assert.equal(capped.events.find((e) => e.type === 'reflection.posted').payload.status, 'skipped');
    assert.ok(await capped.store.loadReflection(doc.id), 'a skip is still recorded');
  } finally {
    await capped.cleanup();
  }
  const unreadable = await setup({ reflectScript: () => [[text('I would rather not.'), end()]] });
  try {
    await seedPlan(unreadable);
    const doc = await unreadable.reflect.reflect({ reason: 'manual' });
    assert.equal(doc.status, 'skipped');
    assert.match(doc.skipReason, /did not return a readable document \(I would rather not\.\)/);
    assert.equal(unreadable.ledger.judgeToday().calls, 1, 'the call was made and is counted');
  } finally {
    await unreadable.cleanup();
  }
  // Budget thresholds: a venture budget of $0.0015 crosses 80 % and 100 % after one worker turn ($0.0015).
  const budget = await setup({ reflectScript: () => [[text(JSON.stringify({ portfolio: 'Over budget: $0.00 left.', ventures: [], briefings: [] })), end()]] });
  try {
    const ada = await seedPlan(budget);
    const plan = await budget.store.loadPlan(null);
    plan.ventures[0].budgetUsd = 0.0015;
    await budget.store.savePlan(plan);
    await budget.chief.init();
    budget.chief.followUp = async () => null;
    await budget.trails.delegate({ toAgentId: ada.id, brief: 'spend', budgetUsd: 1 }, { by: 'superintendent' });
    await budget.runs.waitForIdle();
    await waitUntil(() => budget.events.some((e) => e.type === 'reflection.posted'));
    const alerts = budget.events.filter((e) => e.type === 'budget.threshold').map((e) => e.payload);
    assert.deepEqual(alerts.map((a) => [a.scope, a.id, a.threshold]), [['venture', 'lantern-co', 0.8], ['venture', 'lantern-co', 1]]);
    assert.ok(alerts[1].fraction >= 1);
    const posted = budget.events.find((e) => e.type === 'reflection.posted');
    assert.ok(posted, 'crossing 100 % ran a reflection');
    assert.match(posted.payload.reason, /budget: venture lantern-co at 100 %/);
    budget.reflect.checkThresholds();
    assert.equal(budget.events.filter((e) => e.type === 'budget.threshold').length, 2, 'once per threshold');
  } finally {
    await budget.cleanup();
  }
});
