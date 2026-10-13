import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createStore } from '../sidecar/store.js';
import { createEventBus } from '../sidecar/bus.js';
import { createLayoutState } from '../sidecar/server.js';
import { createAgents } from '../sidecar/agents.js';
import { createLeashLedger, createLeashState } from '../sidecar/leash-ledger.js';
import { createGateQueue } from '../sidecar/gate-queue.js';
import { createToolGate } from '../sidecar/capability/gate.js';
import { TOOLS } from '../sidecar/capability/tools.js';
import { createMailSystem } from '../sidecar/mail/system.js';
import { MAIL_TOOLS } from '../sidecar/mail/tools.js';
import { parseClassification, createClassifier, CLASSIFY_SYSTEM_PROMPT } from '../sidecar/mail/classify.js';
import { createRouter, defaultPolicy } from '../sidecar/router.js';
import { needsActionReview } from '../sidecar/judge.js';
import { OBJECT_KINDS, defaultLayout, allGrantsFor } from '../shared/world.js';
import { defaultLeash, TOOL_DOMAINS } from '../shared/leash.js';
import { startFakeResend } from './helpers/fake-resend.js';
import { fakeProvider, fakeClock, text, end, waitUntil } from './helpers/fake-provider.js';

async function setup({ classifyScripts = null } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-mailtools-'));
  const store = createStore({ root: path.join(dir, 'home') });
  await store.init();
  const bus = createEventBus();
  const events = [];
  bus.listen((e) => events.push(e));
  const clock = fakeClock(1_700_000_000_000);
  const layout = defaultLayout();
  layout.rooms.push({ id: 'mountain-peak', name: 'Peak', kind: 'mountain_peak', x: 0, y: 0, w: 2, h: 2 });
  layout.rooms.push({ id: 'ops', name: 'Support', kind: 'operations_support', x: 31, y: 1, w: 8, h: 6 });
  layout.rooms.push({ id: 'visitor-center', name: 'Visitor Center', kind: 'visitor_center', x: 21, y: 1, w: 8, h: 6 });
  layout.objects.push({ id: 'tower', kind: 'radio_tower', roomId: 'ops', x: 33, y: 2 });
  layout.objects.push({ id: 'peak-tower', kind: 'radio_tower', roomId: 'mountain-peak', x: 1, y: 1 });
  layout.agents.push({ id: 'chief-ranger', name: 'Chief', roomId: 'mountain-peak', x: 0, y: 0, role: 'chief_ranger' });
  layout.agents.push({ id: 'ada', name: 'Ada', roomId: 'ops', x: 31, y: 1, role: 'ranger', venture: 'lantern-co', specialty: 'support' });
  const layoutState = createLayoutState({ initial: layout, store, bus, clock });
  const agents = createAgents({ layoutState, bus, clock });
  const ledger = await createLeashLedger({ store, clock }).init();
  const leash = defaultLeash();
  const leashState = createLeashState({ initial: leash, store });
  const gateQueue = await createGateQueue({ bus, store, ledger, leashState, getLayout: layoutState.get, clock }).init();
  const rs = await startFakeResend();
  const scripts = classifyScripts || {};
  const makeProvider = async (name, opts) => {
    const script = scripts[name];
    if (!script) { const e = new Error(name === 'ollama' ? 'ollama unreachable (test)' : `no API key for ${name}`); e.code = name === 'ollama' ? 'OLLAMA_UNREACHABLE' : 'NO_KEY'; throw e; }
    return { provider: fakeProvider(script(), { name }), model: opts.model || 'm', price: name === 'anthropic' ? { inputPerMTok: 2, outputPerMTok: 10 } : null };
  };
  const mail = await createMailSystem({ bus, store, getLayout: layoutState.get, env: { RESEND_API_KEY: rs.apiKey }, clock, workspaceRoot: path.join(dir, 'ws'), resendBaseUrl: rs.url, router: createRouter(defaultPolicy()), makeProvider, ledger, classify: Boolean(classifyScripts), log: { error() {} } }).init();
  const registry = { ...TOOLS, ...mail.tools };
  const gateFor = (agentId) => createToolGate({ getLayout: layoutState.get, agentId, workspaceDir: path.join(dir, 'ws', agentId), registry, grants: allGrantsFor, toolContext: { agents, mail }, getLeash: () => leashState.get(), ledger, submit: { submit: (item) => gateQueue.submit({ ...item, runId: 'run-1' }), log: (item) => gateQueue.log({ ...item, runId: 'run-1' }) } });
  await fsp.mkdir(path.join(dir, 'ws', 'ada'), { recursive: true });
  return { dir, bus, events, clock, layoutState, agents, ledger, leashState, gateQueue, rs, mail, registry, gateFor, cleanup: async () => { await fsp.rm(dir, { recursive: true, force: true }); await rs.close(); } };
}

test('the Radio tower grants the mail tools; domains per tool; the chief and ranger scopes', async () => {
  assert.deepEqual(OBJECT_KINDS.radio_tower.grants, ['mail.search', 'mail.read', 'mail.draft', 'mail.send', 'mail.create_address']);
  for (const name of OBJECT_KINDS.radio_tower.grants) assert.ok(name in TOOL_DOMAINS && name in MAIL_TOOLS, name);
  assert.equal(TOOL_DOMAINS['mail.draft'], null);
  const h = await setup();
  try {
    const gate = h.gateFor('ada');
    assert.deepEqual(gate.definitions().map((d) => d.name), ['mail.create_address', 'mail.draft', 'mail.read', 'mail.search', 'mail.send'], 'this registry holds the phase 1 and mail tools');
    assert.equal(gate.leashFor('mail.send', { kind: 'campaign' }).domain, 'publishing');
    assert.equal(gate.leashFor('mail.send', { kind: 'reply' }).domain, 'publishing', 'a declared "reply" to no known message is a campaign (safety review M5; a real reply is covered in test/safety.test.js)');
    assert.equal(gate.leashFor('mail.search').domain, 'research');
    assert.equal(gate.leashFor('mail.create_address').domain, 'account_creation');
    assert.equal(h.gateFor('ranger').definitions().some((d) => d.name === 'mail.search'), false, 'no tower in the Ranger Station');
    // Seed mail: one for ops, one for visitors.
    h.rs.receive({ id: 'r1', from: 'Buyer <buyer@example.com>', to: ['support@makapark.com'], subject: 'Broken lantern', text: 'It arrived broken, order 42.' });
    h.rs.receive({ id: 'r2', from: 'Someone <s@example.com>', to: ['visitors@makapark.com'], subject: 'General', text: 'hello' });
    await h.mail.poll();
    const search = JSON.parse((await gate.execute({ id: 'c1', name: 'mail.search', input: { unreadOnly: true } }, { runId: 'run-1' })).output);
    assert.equal(search.count, 1, 'Ada sees her station only');
    assert.equal(search.messages[0].subject, 'Broken lantern');
    const chiefSearch = JSON.parse((await h.gateFor('chief-ranger').execute({ id: 'c2', name: 'mail.search', input: {} }, { runId: 'run-1' })).output);
    assert.equal(chiefSearch.count, 2, 'the Chief sees everything');
    const read = JSON.parse((await gate.execute({ id: 'c3', name: 'mail.read', input: { id: search.messages[0].id } }, { runId: 'run-1' })).output);
    assert.match(read.text, /order 42/);
    assert.ok(read.labels.includes('read'));
    assert.match((await gate.execute({ id: 'c4', name: 'mail.read', input: { id: h.mail.mailStore.byResendId('r2').id } }, { runId: 'run-1' })).error, /not? .*your mail|no message/);
    const thread = JSON.parse((await gate.execute({ id: 'c5', name: 'mail.read', input: { threadId: read.threadId } }, { runId: 'run-1' })).output);
    assert.equal(thread.length, 1);
    assert.match((await gate.execute({ id: 'c6', name: 'mail.read', input: {} }, { runId: 'run-1' })).error, /id or threadId/);
    assert.equal(JSON.parse((await gate.execute({ id: 'c7', name: 'mail.search', input: { query: 'nothing-matches' } }, { runId: 'run-1' })).output).count, 0);
  } finally {
    await h.cleanup();
  }
});

test('draft, send (reply through the leash: draft waits at the Gate; act_free sends), judgeAtDraft for new recipients, create_address under account_creation', async () => {
  const h = await setup();
  try {
    const gate = h.gateFor('ada');
    h.rs.receive({ id: 'r1', from: 'Buyer <buyer@example.com>', to: ['support@makapark.com'], subject: 'Broken lantern', text: 'broken', messageId: '<m1@example.com>' });
    await h.mail.poll();
    const inbound = h.mail.mailStore.byResendId('r1');
    const draft = JSON.parse((await gate.execute({ id: 'd1', name: 'mail.draft', input: { to: ['buyer@example.com'], subject: 'Re: Broken lantern', text: 'So sorry, a replacement ships today.', inReplyTo: '<m1@example.com>' } }, { runId: 'run-1' })).output);
    assert.equal(draft.from, 'support@makapark.com', 'defaults to the station address');
    assert.equal(draft.threadId, inbound.threadId);
    assert.equal(draft.kind, 'reply');
    assert.equal((await h.mail.mailStore.get(draft.draftId)).status, 'draft');
    // outbound_messages is at Draft: the send waits at the Gate; approve sends it.
    const pending = gate.execute({ id: 's1', name: 'mail.send', input: { draftId: draft.draftId } }, { runId: 'run-1', turn: 1 });
    await waitUntil(() => h.gateQueue.pending().length === 1);
    const item = h.gateQueue.pending()[0];
    assert.equal(item.domain, 'outbound_messages');
    assert.match(item.summary, /send mail to draft/);
    await h.gateQueue.resolve(item.itemId, { decision: 'approve' });
    const sent = JSON.parse((await pending).output);
    assert.equal(sent.threadId, inbound.threadId);
    assert.equal(h.rs.state.emails[0].headers['In-Reply-To'], '<m1@example.com>');
    assert.ok((await h.mail.mailStore.get(draft.draftId)).labels.some((l) => l.startsWith('sent-as:')));
    // judgeAtDraft: a new external recipient asks for the judge; a known one does not.
    const tool = gate.tool('mail.send');
    assert.equal(tool.judgeAtDraft({ to: ['new@example.com'] }), true);
    assert.equal(tool.judgeAtDraft({ to: ['buyer@example.com'] }), false);
    assert.deepEqual(needsActionReview(gate, [{ name: 'mail.send', input: { to: ['new@example.com'], subject: 'x' } }]).map((n) => [n.name, n.reason]), [['mail.send', 'new external recipient']]);
    assert.deepEqual(needsActionReview(gate, [{ name: 'mail.send', input: { to: ['buyer@example.com'], subject: 'x' } }]), []);
    // A campaign is publishing; loosen it to act_free and the send goes straight out with the footer.
    await h.leashState.update((l) => ({ ...l, agents: { ada: { domains: { publishing: { level: 'act_free' } } } } }));
    const camp = await gate.execute({ id: 's2', name: 'mail.send', input: { to: ['one@example.com', 'two@example.com'], subject: 'New lanterns', text: 'Look!', kind: 'campaign' } }, { runId: 'run-1', turn: 2 });
    assert.equal(camp.ok, true);
    assert.match(h.rs.state.emails[1].text, /UNSUBSCRIBE/);
    assert.equal(h.events.filter((e) => e.type === 'gate.item' && e.payload.status === 'allowed' && e.payload.domain === 'publishing').length, 1);
    // Policy refusals come back as tool errors.
    const foreign = await gate.execute({ id: 's3', name: 'mail.send', input: { from: 'rangers@makapark.com', to: ['x@example.com'], subject: 'x', text: 'y', kind: 'campaign' } }, { runId: 'run-1' });
    assert.match(foreign.error, /may not send from/);
    // A bad draft id is judged as a campaign (publishing, loosened to act_free above): the tool answers at once.
    assert.equal(gate.leashFor('mail.send', { draftId: 'nope' }).domain, 'publishing');
    const bad = await gate.execute({ id: 's4', name: 'mail.send', input: { draftId: 'nope' } }, { runId: 'run-1', turn: 3 });
    assert.match(bad.error, /no draft/);
    // create_address: account_creation is at Draft → Gate; approve creates the alias.
    const creating = gate.execute({ id: 'a1', name: 'mail.create_address', input: { venture: 'Lantern Co' } }, { runId: 'run-1', turn: 3 });
    await waitUntil(() => h.gateQueue.pending().length === 1);
    const addrItem = h.gateQueue.pending()[0];
    assert.equal(addrItem.domain, 'account_creation');
    assert.match(addrItem.summary, /create address ranger-lantern-co@/, 'the card shows the normalised address (role defaults to "ranger" on the card; the tool uses the specialty)');
    await h.gateQueue.resolve(addrItem.itemId, { decision: 'approve' });
    const created = JSON.parse((await creating).output);
    assert.equal(created.address, 'support-lantern-co@makapark.com');
    assert.equal(h.mail.addresses.get(created.address).agentId, 'ada');
    assert.deepEqual(h.mail.policy.allowedFrom('ada').sort(), ['support-lantern-co@makapark.com', 'support@makapark.com']);
    const again = gate.execute({ id: 'a2', name: 'mail.create_address', input: { venture: 'lantern-co' } }, { runId: 'run-1', turn: 4 });
    await waitUntil(() => h.gateQueue.pending().length === 1);
    await h.gateQueue.resolve(h.gateQueue.pending()[0].itemId, { decision: 'approve' });
    assert.match((await again).error, /already exists/);
    assert.match((await MAIL_TOOLS['mail.search'].run({}, { agentId: 'ada' })).error, /not available/);
  } finally {
    await h.cleanup();
  }
});

test('classification: worker first, judge when unsure or unreadable, unclassified when nothing is reachable; wired on inbound mail', async () => {
  assert.deepEqual(parseClassification('{"classification":"customer","confidence":0.95,"reason":"asks about an order"}'), { classification: 'customer', confidence: 0.95, reason: 'asks about an order' });
  assert.equal(parseClassification('{"classification":"royalty"}'), null);
  assert.equal(parseClassification('nope'), null);
  assert.equal(parseClassification('{"classification":"spam","confidence":7}').confidence, 1);
  assert.match(CLASSIFY_SYSTEM_PROMPT, /platform_notice/);
  const worker = () => [
    [text('{"classification":"customer","confidence":0.92,"reason":"order question"}'), end('end_turn', { inputTokens: 50, outputTokens: 10 })],
    [text('{"classification":"supplier","confidence":0.3,"reason":"unsure"}'), end()],
    [text('I am not sure what this is'), end()],
  ];
  const judge = () => [
    [text('{"classification":"platform_notice","confidence":0.8,"reason":"automated notice"}'), end('end_turn', { inputTokens: 500, outputTokens: 20 })],
    [text('{"classification":"spam","confidence":0.99,"reason":"phishing"}'), end('end_turn', { inputTokens: 500, outputTokens: 20 })],
  ];
  const h = await setup({ classifyScripts: { ollama: worker, anthropic: judge } });
  try {
    h.rs.receive({ id: 'r1', from: 'buyer@example.com', to: ['support@makapark.com'], subject: 'Order 42', text: 'where is it' });
    h.rs.receive({ id: 'r2', from: 'vendor@example.com', to: ['support@makapark.com'], subject: 'Invoice', text: 'attached' });
    h.rs.receive({ id: 'r3', from: 'win@example.com', to: ['visitors@makapark.com'], subject: 'You won', text: 'click here' });
    await h.mail.poll();
    await h.mail.classified();
    const classes = h.events.filter((e) => e.type === 'mail.classified').map((e) => [e.payload.classification, e.payload.by]);
    assert.deepEqual(classes, [['customer', 'worker'], ['platform_notice', 'judge'], ['spam', 'judge']]);
    assert.match(h.events.filter((e) => e.type === 'mail.classified')[1].payload.reason, /worker unsure \(0.30\)/);
    assert.match(h.events.filter((e) => e.type === 'mail.classified')[2].payload.reason, /worker answer unreadable/);
    assert.equal(h.mail.mailStore.byResendId('r1').classification, 'customer');
    assert.equal(h.mail.mailStore.byResendId('r3').classification, 'spam');
    const costs = h.events.filter((e) => e.type === 'cost.estimate' && e.payload.runId.startsWith('classify-'));
    assert.equal(costs.length, 5);
    assert.equal(costs[0].payload.usd, 0, 'worker on ollama is a known $0');
    assert.equal(costs[0].payload.tier, 'worker');
    assert.equal(h.ledger.judgeToday().calls, 2);
    assert.equal((await h.mail.status()).classify.done, 3);
  } finally {
    await h.cleanup();
  }
  // Nothing reachable: unclassified, by none, no guess.
  const bus = createEventBus();
  const events = [];
  bus.listen((e) => events.push(e));
  const dead = createClassifier({ router: createRouter(defaultPolicy()), makeProvider: async (name) => { const e = new Error(`${name} down`); e.code = 'OLLAMA_UNREACHABLE'; throw e; }, bus, env: {}, log: { error() {} } });
  const r = await dead.classify({ id: 'msg-x', from: 'a', to: ['b'], subject: 's', text: 't' });
  assert.deepEqual([r.classification, r.by], ['unclassified', 'none']);
  assert.match(r.reason, /worker unavailable: ollama down; judge unavailable: anthropic down/);
  assert.equal(events.at(-1).payload.by, 'none');
});

// D190: mail keeps arriving, poll after poll.
//
// Found in production the first time the park ever had inbound mail. Resend lists received
// mail NEWEST first and `after` is its pagination cursor walking *older* — not "newer than
// this". The park stored the newest id it had seen and asked for everything after it, which
// the provider read as "older than the newest" and answered with nothing. So the first test
// message landed and the second never did, and no test caught it because the fake had
// `after` backwards: it returned newer, which is what the park wanted to believe.
test('a second message arrives, and a third, and nothing is ingested twice', async () => {
  const h = await setup();
  try {
    // First arrival, on a park with no cursor at all.
    h.rs.receive({ id: 'in-1', from: 'first@example.com', to: ['support@makapark.com'], subject: 'One', text: 'the first' });
    assert.deepEqual(await h.mail.poll(), { received: 1 });
    assert.equal(h.mail.mailStore.byResendId('in-1').subject, 'One');

    // The one that used to vanish. The cursor now means "I have everything to here".
    h.rs.receive({ id: 'in-2', from: 'second@example.com', to: ['support@makapark.com'], subject: 'Two', text: 'the second' });
    assert.deepEqual(await h.mail.poll(), { received: 1 }, 'the second message arrives');
    assert.equal(h.mail.mailStore.byResendId('in-2').subject, 'Two');

    // And a third, and two at once.
    h.rs.receive({ id: 'in-3', from: 'third@example.com', to: ['support@makapark.com'], subject: 'Three', text: 'the third' });
    h.rs.receive({ id: 'in-4', from: 'fourth@example.com', to: ['support@makapark.com'], subject: 'Four', text: 'the fourth' });
    assert.deepEqual(await h.mail.poll(), { received: 2 });

    // Polling again with nothing new brings nothing, rather than everything again.
    assert.deepEqual(await h.mail.poll(), { received: 0 });
    const all = h.mail.mailStore.list({ direction: 'in', limit: 50 });
    assert.equal(all.length, 4, 'four messages, each held once');
    assert.equal(new Set(all.map((m) => m.resendId)).size, 4);

    // Oldest first, so a reply can find the message it answers. The store keeps the index
    // oldest-first, so reading it back in order shows the order they were ingested.
    assert.deepEqual([...all].reverse().map((m) => m.subject), ['One', 'Two', 'Three', 'Four']);

    // A cursor lost to a restore does not duplicate everything: the messages themselves say
    // what the park already holds.
    await h.mail.mailStore.setCursor(null);
    assert.deepEqual(await h.mail.poll(), { received: 0 }, 'nothing is ingested twice');
    assert.equal(h.mail.mailStore.list({ direction: 'in', limit: 50 }).length, 4);
  } finally {
    await h.cleanup();
  }
});
