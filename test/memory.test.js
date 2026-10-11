// Phase 4 step 11: Ranger memory. Redaction, lexical recall, the memory over a fake judge,
// and through the sidecar: a Ranger's write accepted by the judge, automatic recall into the
// next run, the Superintendent's feedback and forget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createStore } from '../sidecar/store.js';
import { createEventBus } from '../sidecar/bus.js';
import { createLayoutState } from '../sidecar/server.js';
import { createAgents } from '../sidecar/agents.js';
import { createMemory, MEMORY_SCOPES, MEMORY_KINDS, WRITE_REVIEW_SCOPE } from '../sidecar/memory/index.js';
import { redact, hasSecrets } from '../sidecar/memory/redact.js';
import { tokenize, stem, recall, isMuted } from '../sidecar/memory/recall.js';
import { roleGrants, defaultLayout } from '../shared/world.js';
import { initialState, applySnapshot, applyEvent } from '../frontend/state.js';
import { makeEvent } from '../shared/events.js';
import { fakeProvider, fakeClock, text, end, toolCall } from './helpers/fake-provider.js';
import { startTestServer } from './helpers/test-server.js';

test('redact removes secrets and personal data and says what it removed', () => {
  const r = redact('Use key sk-ant-fakeFAKEfake for Anthropic, Stripe sk_live_fakeFAKE12, token xoxb-1234-fakeFAKE, mail jane.doe@example.com, call +1 (415) 555-2671, card 4242 4242 4242 4242, Bearer abcdefghijklmnopqrstuvwxyz0123456789.');
  assert.ok(!/sk-ant|sk_live|xoxb|jane\.doe|555-2671|4242 4242|abcdefghijklmnopqrstuvwxyz0123456789/.test(r.text), r.text);
  assert.match(r.text, /\[redacted api key\] for Anthropic, Stripe \[redacted api key\]/);
  assert.match(r.text, /mail \[redacted email\]/);
  assert.match(r.text, /call \[redacted phone number\]/);
  assert.match(r.text, /card \[redacted card number\]/);
  assert.match(r.text, /\[redacted bearer token\]/);
  assert.deepEqual(r.redactions.map((x) => x.kind).sort(), ['api key', 'bearer token', 'card number', 'email', 'phone number']);
  assert.equal(r.redactions.find((x) => x.kind === 'api key').count, 3);
  // Assignments keep the name and lose the value; JWTs, AWS keys, bot tokens, IBANs, SSNs.
  assert.equal(redact('password=hunter2secret and api_key: "ABCDEF123456"').text, 'password=[redacted secret assignment] and api_key: [redacted secret assignment]');
  assert.match(redact('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlc2lnbmF0dXJl').text, /jwt \[redacted jwt\]/);
  assert.match(redact('AKIAFAKEFAKEFAKEFAKE').text, /\[redacted api key\]/);
  assert.match(redact('bot 123456789:FAKEfakeFAKEfakeFAKEfakeFAKEfake').text, /\[redacted bot token\]/);
  assert.match(redact('iban GB82 WEST 1234 5698 7654 32').text, /\[redacted iban\]/);
  assert.match(redact('ssn 123-45-6789').text, /\[redacted national id\]/);
  // Ordinary text survives: prices, dates, counts, short ids, plain words.
  const plain = redact('Etsy charges $0.20 per listing and 6.5 % per sale; ship in 2 days; order #1042 on 2026-10-09 had 3 lanterns.');
  assert.deepEqual(plain.redactions, []);
  assert.equal(plain.text, 'Etsy charges $0.20 per listing and 6.5 % per sale; ship in 2 days; order #1042 on 2026-10-09 had 3 lanterns.');
  assert.equal(redact('a 16-digit number that is not a card: 1234 5678 9012 3456').redactions.length, 0, 'Luhn fails: not a card');
  assert.equal(hasSecrets('key sk_test_fakeFAKE12'), true);
  assert.equal(hasSecrets('mail jane@example.com'), false);
  assert.equal(redact(null).text, '');
});

test('lexical recall: tokens, stems, idf, feedback and muting', () => {
  assert.deepEqual(tokenize('The Lanterns were SHIPPED from Etsy; fees: $0.20/listing!'), ['lantern', 'ship', 'etsy', 'fee', '0.20', 'list']);
  assert.equal(stem('listing'), 'list');
  assert.equal(stem('listings'), 'list');
  assert.equal(stem('running'), 'run');
  assert.equal(stem('charges'), 'charge');
  assert.equal(stem('charge'), 'charge');
  assert.equal(stem('boxes'), 'box');
  assert.equal(stem('glass'), 'glass');
  assert.equal(stem('listings'), 'list');
  assert.equal(stem('policies'), 'policy');
  assert.equal(stem('fees'), 'fee');
  assert.equal(stem('ads'), 'ads', 'short words are left alone');
  const items = [
    { id: 'a', text: 'Etsy charges $0.20 per listing', kind: 'fact', tags: ['etsy', 'fees'], createdAt: 1000, feedback: { up: 0, down: 0 } },
    { id: 'b', text: 'The Superintendent prefers lantern photos on a garden table', kind: 'preference', tags: [], createdAt: 2000, feedback: { up: 0, down: 0 } },
    { id: 'c', text: 'Pause a Meta campaign before changing its budget', kind: 'procedure', tags: ['meta_ads'], createdAt: 3000, feedback: { up: 0, down: 0 } },
    { id: 'd', text: 'Etsy listing fees are refunded on cancellation (wrong)', kind: 'fact', tags: ['etsy'], createdAt: 4000, feedback: { up: 0, down: 1 }, forgotten: false },
    { id: 'e', text: 'Etsy old note', kind: 'fact', tags: [], createdAt: 500, feedback: { up: 0, down: 0 }, forgotten: true },
  ];
  const got = recall(items, 'what are the Etsy listing fees?', { k: 3, now: 10_000 });
  assert.deepEqual(got.map((r) => r.item.id), ['a'], 'the muted item and the forgotten one never come back; unrelated items score 0');
  assert.deepEqual(got[0].matched.sort(), ['etsy', 'fee', 'list']);
  assert.equal(isMuted(items[3]), true);
  assert.equal(isMuted({ feedback: { up: 1, down: 1 } }), false);
  assert.deepEqual(recall(items, 'lantern photos', { k: 5 }).map((r) => r.item.id), ['b']);
  assert.deepEqual(recall(items, 'the and of', { k: 5 }), [], 'a query of stopwords recalls nothing');
  // A thumbs-up breaks a tie in favour of the liked item.
  const tied = [{ id: 'x', text: 'ship lanterns in boxes', createdAt: 1, feedback: { up: 0, down: 0 } }, { id: 'y', text: 'ship lanterns in crates', createdAt: 1, feedback: { up: 2, down: 0 } }];
  assert.equal(recall(tied, 'ship lanterns', { now: 2 })[0].item.id, 'y');
});

test('scopes, kinds and the grants', () => {
  assert.deepEqual([...MEMORY_SCOPES], ['agent', 'venture', 'station']);
  assert.deepEqual([...MEMORY_KINDS], ['fact', 'preference', 'procedure']);
  assert.ok(roleGrants('ranger').includes('memory.write'));
  assert.ok(roleGrants('junior_ranger').includes('memory.recall'));
  assert.ok(!roleGrants('junior_ranger').includes('memory.write'));
  assert.ok(roleGrants('chief_ranger').includes('memory.write'));
  assert.match(WRITE_REVIEW_SCOPE, /no secret and no personal data/);
});

async function harness({ judge = 'approve' } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-memory-'));
  const store = createStore({ root: dir });
  await store.init();
  const bus = createEventBus();
  const events = [];
  bus.listen((e) => events.push(e));
  const clock = fakeClock();
  const layout = defaultLayout();
  layout.rooms.push({ id: 'listings', name: 'Listings Camp', kind: 'product_listings', x: 21, y: 1, w: 8, h: 6 });
  layout.agents.push({ id: 'sam', name: 'Sam', roomId: 'listings', x: 21, y: 1, role: 'ranger', specialty: 'storefront', venture: 'lantern-co' });
  layout.agents.push({ id: 'ada', name: 'Ada', roomId: 'listings', x: 22, y: 1, role: 'ranger', specialty: 'ads', venture: 'lantern-co' });
  layout.agents.push({ id: 'zed', name: 'Zed', roomId: 'ranger-station', x: 2, y: 2, role: 'ranger', specialty: 'books' });
  const layoutState = createLayoutState({ initial: layout, store, bus, clock });
  const agents = createAgents({ layoutState, bus, clock });
  const reviews = [];
  const fakeJudge = judge === null ? null : {
    async reviewDocument(args) {
      reviews.push(args);
      if (typeof judge === 'function') return judge(args);
      return { verdict: judge, notes: judge === 'approve' ? 'fine' : 'not durable' };
    },
  };
  const memory = await createMemory({ store, bus, agents, getLayout: layoutState.get, judge: fakeJudge, clock, caps: { perOwner: 3 }, log: { error() {} } }).init();
  return { dir, store, bus, events, clock, memory, reviews, layoutState, agents, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

test('the memory: writes are redacted and judge-accepted, scopes decide who recalls what, feedback mutes, forget removes, everything persists', async () => {
  const h = await harness();
  try {
    const w = await h.memory.write({ agentId: 'sam', scope: 'venture', kind: 'fact', text: 'Etsy charges $0.20 per listing; the shop login is sam@lanterns.example with password hunter2secret', tags: ['Etsy', 'fees'], runId: 'r1' });
    assert.equal(w.stored, true);
    assert.equal(w.item.text, 'Etsy charges $0.20 per listing; the shop login is [redacted email] with password [redacted secret assignment]');
    assert.deepEqual(w.item.tags, ['etsy', 'fees']);
    assert.equal(w.item.owner, 'lantern-co');
    // The judge saw the redacted text under the memory scope, never the raw one.
    assert.equal(h.reviews.length, 1);
    assert.equal(h.reviews[0].tool, 'memory.write');
    assert.equal(h.reviews[0].scope, WRITE_REVIEW_SCOPE);
    assert.ok(!/hunter2secret|sam@lanterns/.test(h.reviews[0].text));
    assert.match(h.reviews[0].text, /redacted before review: 1 secret assignment, 1 email/);
    const stored = h.events.find((e) => e.type === 'memory.write');
    assert.equal(stored.payload.status, 'stored');
    assert.equal(stored.payload.redactions, 2);
    assert.ok(!/hunter2secret/.test(JSON.stringify(stored)));
    // Station and agent scopes; a Ranger of another camp sees none of them.
    await h.memory.write({ agentId: 'sam', scope: 'station', kind: 'procedure', text: 'Photograph lanterns on the garden table before listing them', runId: 'r1' });
    await h.memory.write({ agentId: 'ada', scope: 'agent', kind: 'preference', text: 'Ada keeps Meta campaigns paused until the creative is approved', runId: 'r2' });
    assert.deepEqual(h.memory.itemsFor('sam').map((m) => m.scope).sort(), ['station', 'venture']);
    assert.deepEqual(h.memory.itemsFor('ada').map((m) => m.scope).sort(), ['agent', 'station', 'venture']);
    assert.deepEqual(h.memory.itemsFor('zed'), []);
    // Refusals: a duplicate, a venture scope without a venture, the per-owner cap, a bad scope.
    const dup = await h.memory.write({ agentId: 'sam', scope: 'station', kind: 'procedure', text: 'Photograph lanterns on the garden table before listing them' });
    assert.equal(dup.stored, false);
    assert.match(dup.reason, /identical item/);
    await assert.rejects(() => h.memory.write({ agentId: 'zed', scope: 'venture', kind: 'fact', text: 'x' }), /serves no venture/);
    await assert.rejects(() => h.memory.write({ agentId: 'zed', scope: 'global', kind: 'fact', text: 'x' }), /scope must be/);
    await assert.rejects(() => h.memory.write({ agentId: 'zed', scope: 'agent', kind: 'rumour', text: 'x' }), /kind must be/);
    await h.memory.write({ agentId: 'sam', scope: 'venture', kind: 'fact', text: 'two' });
    await h.memory.write({ agentId: 'sam', scope: 'venture', kind: 'fact', text: 'three' });
    const full = await h.memory.write({ agentId: 'sam', scope: 'venture', kind: 'fact', text: 'four' });
    assert.equal(full.stored, false);
    assert.match(full.reason, /memory full for venture lantern-co: 3 item/);
    assert.equal(h.events.filter((e) => e.type === 'memory.write' && e.payload.status === 'refused').length, 2);
    // Recall by scope and query; uses are counted; the event names the items.
    const got = h.memory.recallFor({ agentId: 'ada', query: 'what does Etsy charge per listing?', runId: 'r3' });
    assert.equal(got.length, 2, 'the fee (etsy, charge, per, listing) and the photo procedure (listing only)');
    assert.match(got[0].text, /Etsy charges/);
    assert.deepEqual(got[0].matched.sort(), ['charge', 'etsy', 'list', 'per']);
    assert.match(got[1].text, /Photograph/);
    assert.equal(h.memory.get(got[0].id).uses, 1);
    const recallEv = h.events.filter((e) => e.type === 'memory.recall').at(-1);
    assert.deepEqual(recallEv.payload.itemIds, got.map((g) => g.id));
    assert.equal(recallEv.payload.automatic, false);
    assert.deepEqual(h.memory.recallFor({ agentId: 'zed', query: 'Etsy listing' }), [], 'another camp recalls nothing of it');
    // Automatic recall into a run's prompt.
    const lines = h.memory.promptLines(h.agents.get('sam'), { prompt: 'List the new lanterns on Etsy with photos', runId: 'r4' });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /Memory recalled for this brief \(2 item\(s\)/);
    assert.match(lines[0], /\[fact, venture\] Etsy charges/);
    assert.match(lines[0], /\[procedure, station\] Photograph lanterns/);
    assert.equal(h.events.filter((e) => e.type === 'memory.recall').at(-1).payload.automatic, true);
    const before = h.events.filter((e) => e.type === 'memory.recall').length;
    assert.deepEqual(h.memory.promptLines(h.agents.get('sam'), { prompt: 'nothing in common here' }), []);
    assert.equal(h.events.filter((e) => e.type === 'memory.recall').length, before, 'an automatic recall that finds nothing is not an event');
    assert.deepEqual(h.memory.promptLines(null, { prompt: 'x' }), []);
    // Feedback: a thumbs-down mutes (net −1); listed but never recalled; a thumbs-up restores.
    const id = got[0].id;
    const fb = await h.memory.feedback(id, { vote: 'down' });
    assert.equal(fb.muted, true);
    assert.equal(h.events.filter((e) => e.type === 'memory.feedback').at(-1).payload.muted, true);
    assert.deepEqual(h.memory.recallFor({ agentId: 'sam', query: 'what does Etsy charge?' }), [], 'muted: the fee item is never recalled');
    assert.equal(h.memory.itemsFor('sam').find((m) => m.id === id).muted, true);
    await h.memory.feedback(id, { vote: 'up' });
    assert.equal(h.memory.get(id).muted, false);
    await assert.rejects(() => h.memory.feedback(id, { vote: 'meh' }), /up or down/);
    await assert.rejects(() => h.memory.feedback('mem-nope', { vote: 'up' }), /no memory item/);
    // Forget: gone from recall and the list, kept as forgotten on disk, the event says who.
    await h.memory.forget(id, { by: 'superintendent' });
    assert.equal(h.memory.get(id), null);
    assert.ok(!h.memory.itemsFor('sam').some((m) => m.id === id));
    assert.equal(h.events.filter((e) => e.type === 'memory.forget').at(-1).payload.by, 'superintendent');
    await assert.rejects(() => h.memory.forget(id), /no memory item/);
    await h.memory.flushed();
    const saved = JSON.parse(await fsp.readFile(path.join(h.dir, 'memory.json'), 'utf8'));
    assert.equal(saved.items.find((it) => it.id === id).forgotten, true);
    assert.ok(!JSON.stringify(saved).includes('hunter2secret'));
    assert.ok(!JSON.stringify(saved).includes('_terms'));
    // Restart: the same items, the same muting and uses.
    const again = await createMemory({ store: h.store, bus: createEventBus(), agents: h.agents, getLayout: h.layoutState.get, judge: null, clock: h.clock }).init();
    assert.equal(again.list().length, 4);
    assert.equal(again.summary().items, 4);
    assert.deepEqual(again.summary().byScope, { agent: 1, venture: 2, station: 1 });
    assert.equal(again.summary().judge, false);
  } finally {
    await h.cleanup();
  }
});

test('no judge, a judge that says revise, or a failed judge: nothing is stored and the Ranger is told', async () => {
  const none = await harness({ judge: null });
  try {
    const r = await none.memory.write({ agentId: 'sam', scope: 'agent', kind: 'fact', text: 'a thing' });
    assert.equal(r.stored, false);
    assert.match(r.reason, /no judge is wired/);
    assert.equal(none.memory.list().length, 0);
    assert.equal(none.events.find((e) => e.type === 'memory.write').payload.status, 'refused');
  } finally {
    await none.cleanup();
  }
  const revise = await harness({ judge: 'revise' });
  try {
    const out = await revise.memory.tools['memory.write'].run({ scope: 'agent', kind: 'fact', text: 'Lanterns sell best in winter maybe' }, { agentId: 'sam', runId: 'r1', brief: 'list lanterns' });
    assert.equal(out.ok, false);
    assert.equal(out.code, 'MEMORY_REFUSED');
    assert.match(out.error, /the judge said revise: not durable/);
    assert.equal(revise.reviews[0].brief, 'list lanterns');
    assert.equal(revise.memory.list().length, 0);
  } finally {
    await revise.cleanup();
  }
  const broken = await harness({ judge: () => { throw new Error('boom'); } });
  try {
    const r = await broken.memory.write({ agentId: 'sam', scope: 'agent', kind: 'fact', text: 'a thing' });
    assert.equal(r.stored, false);
    assert.match(r.reason, /could not review it \(judge failed: boom\)/);
    const skipped = await harness({ judge: () => ({ verdict: 'skipped', reason: 'judge daily cap reached' }) });
    try {
      const s = await skipped.memory.write({ agentId: 'sam', scope: 'agent', kind: 'fact', text: 'a thing' });
      assert.equal(s.stored, false);
      assert.match(s.reason, /judge daily cap reached/);
    } finally {
      await skipped.cleanup();
    }
  } finally {
    await broken.cleanup();
  }
});

test('the frontend reducer keeps the memory counts and marks them stale on every memory event', () => {
  const base = { seq: 0, providers: {}, keystore: { path: '/x', problem: null }, layout: defaultLayout(), objectKinds: {}, activeRun: null, spend: { totalUsd: 0, reconciledTurns: 0, unreconciledTurns: 0 } };
  let s = applySnapshot(initialState(), { ...base, memory: { items: 2, muted: 0, byScope: { agent: 2, venture: 0, station: 0 }, byKind: {}, judge: true } });
  assert.equal(s.memory.items, 2);
  s = applyEvent(s, { ...makeEvent('memory.write', { memoryId: 'mem-1', agentId: 'a', scope: 'agent', owner: 'a', kind: 'fact', status: 'stored' }, { ts: 9 }), seq: 1 });
  assert.equal(s.memory.stale, true);
  assert.equal(s.memory.latest.status, 'stored');
  assert.equal(s.memory.items, 2, 'counts come from the snapshot, never guessed');
  s = applyEvent(s, { ...makeEvent('memory.feedback', { memoryId: 'mem-1', vote: 'down', by: 'superintendent', up: 0, down: 1 }, { ts: 10 }), seq: 2 });
  assert.equal(s.memory.latest.type, 'memory.feedback');
});

test('through the sidecar: a Ranger writes with the judge\'s approval, the next run recalls it automatically, the Superintendent votes and forgets', async () => {
  const layout = defaultLayout();
  layout.rooms.push({ id: 'listings', name: 'Listings Camp', kind: 'product_listings', x: 21, y: 1, w: 8, h: 6 });
  layout.agents.push({ id: 'sam', name: 'Sam', roomId: 'listings', x: 21, y: 1, role: 'ranger', specialty: 'storefront', venture: 'lantern-co' });
  layout.agents.push({ id: 'jun', name: 'Jun', roomId: 'listings', x: 22, y: 1, role: 'junior_ranger', parentAgentId: 'sam', venture: 'lantern-co' });
  const worker = fakeProvider([
    [...toolCall('m1', 'memory.write', { scope: 'venture', kind: 'fact', text: 'Etsy charges $0.20 per listing; contact support at help@etsy.example', tags: ['etsy'] }), end('tool_use')],
    [text('Remembered the Etsy fee.'), end()],
    [...toolCall('m2', 'memory.recall', { query: 'etsy listing fee' }), end('tool_use')],
    [text('Recalled.'), end()],
    [text('Nothing to do.'), end()],
  ]);
  const judgeScript = fakeProvider([
    [text('{"verdict":"approve","notes":"durable, no secrets"}'), end('end_turn', { inputTokens: 100, outputTokens: 10 })], // memory.write review
    [text('{"verdict":"approve","notes":"fine"}'), end('end_turn', { inputTokens: 100, outputTokens: 10 })], // final review, run 1
    [text('{"verdict":"approve","notes":"fine"}'), end('end_turn', { inputTokens: 100, outputTokens: 10 })], // final review, run 2
    [text('{"verdict":"approve","notes":"fine"}'), end('end_turn', { inputTokens: 100, outputTokens: 10 })], // final review, run 3
  ], { name: 'anthropic' });
  const srv = await startTestServer({ layout, makeProvider: async () => ({ provider: worker, model: 'm', price: null }), judgeProvider: async (name, opts) => ({ provider: judgeScript, model: opts.model || 'm', price: { inputPerMTok: 2, outputPerMTok: 10 } }) });
  try {
    const state0 = (await srv.get('/api/state')).body;
    assert.equal(state0.memory.items, 0);
    assert.equal(state0.memory.judge, true);
    const stream = await srv.sse();
    const r1 = await srv.post('/api/run', { prompt: 'Note the Etsy listing fee for the crew.', agentId: 'sam' });
    assert.equal(r1.status, 202, JSON.stringify(r1.body));
    const start = await stream.waitFor((e) => e.type === 'agent.run.start' && e.payload.runId === r1.body.runId);
    assert.ok(start.payload.tools.includes('memory.write') && start.payload.tools.includes('memory.recall'));
    await stream.waitFor((e) => e.type === 'agent.run.end' && e.payload.runId === r1.body.runId, 10000);
    const written = stream.events.find((e) => e.type === 'memory.write');
    assert.equal(written.payload.status, 'stored');
    assert.equal(written.payload.owner, 'lantern-co');
    assert.equal(written.payload.redactions, 1);
    assert.match(written.payload.text, /\[redacted email\]/);
    const verdict = stream.events.find((e) => e.type === 'judge.verdict' && e.payload.tools && e.payload.tools[0] === 'memory.write');
    assert.equal(verdict.payload.verdict, 'approve');
    assert.match(judgeScript.requests[0].messages[0].content[0].text, /SCOPE: the worker proposes to store a memory item/);
    assert.ok(!/help@etsy/.test(judgeScript.requests[0].messages[0].content[0].text), 'the judge never sees the raw address');
    const toolOut = stream.events.find((e) => e.type === 'agent.tool_result' && e.payload.name === 'memory.write');
    assert.ok(toolOut.payload.ok);
    assert.match(toolOut.payload.output, /Removed before storage: 1 email/);
    assert.ok(!/help@etsy/.test(toolOut.payload.output));
    // No Gate item and no leash row: memory has no domain.
    assert.equal((await srv.get('/api/gate')).body.pending.length, 0);
    await srv.runs.waitForIdle();
    // The next run of a crew member gets the item in its system prompt before any tool call.
    const r2 = await srv.post('/api/run', { prompt: 'What does Etsy charge per listing?', agentId: 'jun' });
    assert.equal(r2.status, 202, JSON.stringify(r2.body));
    await stream.waitFor((e) => e.type === 'agent.run.end' && e.payload.runId === r2.body.runId, 10000);
    const sys = worker.requests.at(-2).system;
    assert.match(sys, /Memory recalled for this brief \(1 item\(s\)/);
    assert.match(sys, /\[fact, venture\] Etsy charges \$0\.20 per listing/);
    const auto = stream.events.find((e) => e.type === 'memory.recall' && e.payload.automatic && e.payload.runId === r2.body.runId);
    assert.ok(auto, 'the automatic recall is an event with the run id');
    const manual = stream.events.find((e) => e.type === 'memory.recall' && !e.payload.automatic);
    assert.equal(manual.payload.count, 1);
    const recalled = stream.events.find((e) => e.type === 'agent.tool_result' && e.payload.name === 'memory.recall');
    assert.match(recalled.payload.output, /Etsy charges/);
    await srv.runs.waitForIdle();
    // The routes: the list, feedback that mutes, the state, forget.
    const list = (await srv.get('/api/memory?agentId=jun')).body;
    assert.equal(list.length, 1);
    assert.equal(list[0].uses, 2);
    const id = list[0].id;
    const down = await srv.post(`/api/memory/${id}/feedback`, { vote: 'down' });
    assert.equal(down.status, 200);
    assert.equal(down.body.muted, true);
    assert.equal((await srv.get('/api/state')).body.memory.muted, 1);
    const r3 = await srv.post('/api/run', { prompt: 'What does Etsy charge per listing?', agentId: 'sam' });
    await stream.waitFor((e) => e.type === 'agent.run.end' && e.payload.runId === r3.body.runId, 10000);
    assert.ok(!/Memory recalled/.test(worker.requests.at(-1).system), 'a muted item is never recalled');
    assert.equal((await srv.post(`/api/memory/${id}/feedback`, { vote: 'sideways' })).status, 400);
    const gone = await srv.del(`/api/memory/${id}`);
    assert.equal(gone.status, 200);
    assert.equal((await srv.get('/api/memory')).body.length, 0);
    assert.equal((await srv.del(`/api/memory/${id}`)).status, 404);
    assert.equal((await srv.get('/api/state')).body.memory.items, 0);
    // The token guard holds on the mutating routes.
    const bare = await fetch(`${srv.url}/api/memory/${id}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"vote":"up"}' });
    assert.equal(bare.status, 403);
    stream.close();
  } finally {
    await srv.close();
  }
});
