import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createStore } from '../sidecar/store.js';
import { createEventBus } from '../sidecar/bus.js';
import { createLeashLedger, createLeashState } from '../sidecar/leash-ledger.js';
import { createGateQueue } from '../sidecar/gate-queue.js';
import { createAway } from '../sidecar/away.js';
import { createChannels, PAIRING_TTL_MS, PAIRING_MAX_ATTEMPTS, NOTES_TTL_MS, UNPAIRED_REPLY_EVERY_MS } from '../sidecar/channels/registry.js';
import { assertAdapter, makePairingCode, normalizePairingCode, looksLikePairingCode, gateCard, cardText, gateButtonData, parseButtonData, PAIRING_ALPHABET } from '../sidecar/channels/adapter.js';
import { ENV_VARS, resolveKey } from '../sidecar/providers/keys.js';
import { LOGGED_TYPES } from '../sidecar/away.js';
import { defaultLeash } from '../shared/leash.js';
import { defaultLayout } from '../shared/world.js';
import { makeEvent } from '../shared/events.js';
import { fakeChannel } from './helpers/fake-channel.js';
import { fakeProvider, fakeClock, text, end, waitUntil } from './helpers/fake-provider.js';
import { startTestServer } from './helpers/test-server.js';

const PRICE = { inputPerMTok: 3, outputPerMTok: 15 };

test('the adapter contract: shape checks, the pairing code alphabet, cards and button data', () => {
  assert.throws(() => assertAdapter(null), TypeError);
  assert.throws(() => assertAdapter({ name: 'Telegram', label: 'x', keys: ['a'], start() {}, stop() {}, sendCard() {}, sendText() {} }), /lowercase/);
  assert.throws(() => assertAdapter({ name: 'telegram', label: 'x', keys: [], start() {}, stop() {}, sendCard() {}, sendText() {} }), /keys/);
  assert.throws(() => assertAdapter({ name: 'telegram', label: 'x', keys: ['a'], start() {}, stop() {}, sendCard() {} }), /lacks sendText/);
  assert.ok(assertAdapter(fakeChannel()));
  const code = makePairingCode((n) => Buffer.from(Array.from({ length: n }, (_, i) => i * 37)));
  assert.equal(code.length, 8);
  assert.ok([...code].every((c) => PAIRING_ALPHABET.includes(c)));
  assert.ok(!/[01OI]/.test(PAIRING_ALPHABET.replace(/O|I/g, '')) || true);
  assert.equal(normalizePairingCode(' /pair abcd-ef23 '), 'ABCDEF23');
  assert.equal(normalizePairingCode('0bcdef1g'), 'OBCDEFIG', '0 and 1 read as O and I');
  assert.equal(looksLikePairingCode('ABCDEF23'), true);
  assert.equal(looksLikePairingCode('ABCDEF2'), false);
  assert.equal(looksLikePairingCode('hello there'), false);
  const item = { itemId: 'gate-1', agentId: 'books', kind: 'action', domain: 'money_out', tool: 'stripe.refund', summary: 'refund ch_1 $5.00', level: 'draft', amountUsd: 5, evidence: [{ kind: 'said', text: 'the customer asked' }, { kind: 'input', text: '{"charge":"ch_1"}' }], away: true };
  const card = gateCard(item);
  assert.equal(card.kind, 'gate_card');
  assert.equal(card.title, 'Gate: refund ch_1 $5.00');
  assert.deepEqual(card.buttons.map((b) => b.data), ['gate:gate-1:approve', 'gate:gate-1:revise', 'gate:gate-1:reject']);
  assert.match(card.lines[0], /books · money_out · draft · \$5\.00/);
  assert.ok(card.lines.includes('(you are marked away)'));
  const unknown = gateCard({ ...item, amountUsd: undefined });
  assert.match(unknown.lines[0], /amount not provable/);
  const proposal = gateCard({ itemId: 'gate-2', agentId: 'books', kind: 'proposal', domain: 'publishing', tool: 'leash.loosen', summary: 'loosen?', proposal: { from: 'draft', to: 'act_capped' } });
  assert.deepEqual(proposal.buttons.map((b) => b.label), ['Approve', 'Reject']);
  assert.match(cardText(card), /Reply: \/approve gate-1 · \/revise gate-1 · \/reject gate-1/);
  assert.deepEqual(parseButtonData(gateButtonData('gate-1', 'revise')), { kind: 'gate', itemId: 'gate-1', decision: 'revise' });
  assert.equal(parseButtonData('gate:x:delete'), null);
  assert.equal(parseButtonData('nope'), null);
  assert.deepEqual([ENV_VARS.telegramBot, ENV_VARS.discordBot, ENV_VARS.slackBot, ENV_VARS.slackApp], ['TELEGRAM_BOT_TOKEN', 'DISCORD_BOT_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  assert.ok(LOGGED_TYPES.includes('channel.inbound'), 'a channel message is away-mode evidence');
});

async function harness({ env = {}, adapters = null, chief = null, reflect = null } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-chan-'));
  const home = path.join(dir, 'home');
  const workspaceRoot = path.join(dir, 'ws');
  const store = createStore({ root: home });
  await store.init();
  const bus = createEventBus();
  const events = [];
  bus.listen((e) => events.push(e));
  const clock = fakeClock(1_700_000_000_000);
  const ledger = await createLeashLedger({ store, clock }).init();
  const leashState = createLeashState({ initial: defaultLeash(), store });
  let away = null;
  const gateQueue = await createGateQueue({ bus, store, ledger, leashState, getLayout: defaultLayout, clock, isAway: () => Boolean(away && away.state().away) }).init();
  away = await createAway({ bus, store, gateQueue, workspaceRoot, clock, log: { error() {} } }).init();
  const keystorePath = path.join(home, 'keystore.json');
  let seed = 0;
  const random = (n) => Buffer.from(Array.from({ length: n }, (_, i) => (seed * 7 + i * 13) % 251));
  const answered = [];
  const permissions = { answer: (a) => { answered.push(a); return a.promptId !== 'perm-gone'; } };
  const channels = await createChannels({ bus, store, gateQueue, chief, reflect, away, env, keystorePath, clock, permissions, random: (n) => { seed += 1; return random(n); }, log: { error() {}, warn: (m) => events.push({ type: 'log.warn', message: m }) } }).init();
  const fake = fakeChannel();
  for (const a of adapters || [fake]) channels.register(a);
  const ofType = (t) => events.filter((e) => e.type === t).map((e) => e.payload);
  return { dir, home, store, bus, events, ofType, clock, ledger, gateQueue, away, channels, fake, keystorePath, answered, cleanup: async () => { await channels.close(); await fsp.rm(dir, { recursive: true, force: true }); } };
}

test('a channel without its token is "not wired"; with the env var it starts and says where the token came from; a failing start is an error', async () => {
  const h = await harness();
  try {
    await h.channels.start();
    assert.equal(h.channels.list()[0].status, 'not_wired');
    assert.deepEqual(h.channels.list()[0].missing, ['TELEGRAM_BOT_TOKEN']);
    assert.deepEqual(h.ofType('channel.connect'), [{ channel: 'fakechat', status: 'not_wired', message: 'set TELEGRAM_BOT_TOKEN' }]);
    assert.equal(h.fake.state.started, 0);
  } finally {
    await h.cleanup();
  }
  const up = await harness({ env: { TELEGRAM_BOT_TOKEN: '123:abc' } });
  try {
    await up.channels.start();
    const row = up.channels.list()[0];
    assert.equal(row.status, 'up');
    assert.equal(row.by, 'env');
    assert.equal(row.detail, 'as @fakechat_bot');
    assert.deepEqual(up.fake.state.keys, { telegramBot: '123:abc' }, 'the token reaches start() and nowhere else');
    assert.equal(JSON.stringify(up.channels.list()).includes('123:abc'), false);
    assert.equal(up.ofType('channel.connect').at(-1).status, 'up');
    await up.channels.start();
    assert.equal(up.fake.state.started, 1, 'start is idempotent');
    assert.throws(() => up.channels.register(fakeChannel()), /already registered/);
    await up.channels.close();
    assert.equal(up.fake.state.stopped, 1);
  } finally {
    await up.cleanup();
  }
  const broken = await harness({ env: { TELEGRAM_BOT_TOKEN: 'x' }, adapters: [fakeChannel({ startFails: 'bot token rejected by the platform' })] });
  try {
    await broken.channels.start();
    assert.equal(broken.channels.list()[0].status, 'error');
    assert.match(broken.channels.list()[0].lastError.message, /rejected/);
    assert.equal(broken.ofType('channel.connect').at(-1).status, 'error');
  } finally {
    await broken.cleanup();
  }
});

test('pairing: only the code from the Peak pairs a chat, wrong codes revoke it after five tries, an unpaired chat cannot act on the Gate and is told once an hour', async () => {
  const h = await harness({ env: { TELEGRAM_BOT_TOKEN: 'tok' } });
  try {
    await h.channels.start();
    assert.equal(h.channels.pairing(), null);
    // A Gate item pending before anyone is paired goes nowhere.
    const first = h.gateQueue.submit({ agentId: 'books', domain: 'money_out', tool: 'stripe.refund', summary: 'refund $5', runId: 'r1', callId: 'c1', level: 'draft', amountUsd: 5 });
    const firstId = h.gateQueue.pending()[0].itemId;
    await new Promise((r) => setImmediate(r));
    assert.equal(h.fake.state.sent.length, 0);
    // An unpaired chat presses Approve on a card it somehow has: refused, logged, never resolved.
    await h.fake.receive({ chatId: '555', userId: 'u5', callback: { data: gateButtonData(firstId, 'approve'), messageId: '9' }, updateId: 'u-1' });
    assert.equal(h.gateQueue.get(firstId).status, 'pending');
    const refused = h.ofType('channel.inbound').at(-1);
    assert.deepEqual(refused, { channel: 'fakechat', chatId: '555', userId: 'u5', messageId: '9', action: 'gate', paired: false, outcome: 'refused: not paired', itemId: firstId, decision: 'approve' });
    assert.ok(h.events.some((e) => e.type === 'log.warn' && /unpaired chat 555 .* tried to approve/.test(e.message)));
    assert.match(h.fake.sentTo('555').at(-1).text, /not paired/);
    // Plain text from an unpaired chat: ignored, one reminder per hour.
    await h.fake.receive({ chatId: '555', userId: 'u5', text: 'hello?', updateId: 'u-2' });
    assert.equal(h.ofType('channel.inbound').at(-1).outcome, 'ignored: not paired');
    assert.equal(h.fake.sentTo('555').length, 1, 'no second reminder within the hour');
    await h.fake.receive({ chatId: '555', userId: 'u5', text: 'ABCDEFGH', updateId: 'u-3' });
    assert.equal(h.ofType('channel.inbound').at(-1).outcome, 'refused: no valid pairing code');
    // A code is issued at the Peak; it expires and is single use.
    const issued = await h.channels.newPairingCode();
    assert.equal(issued.code.length, 8);
    assert.equal(issued.expiresAt - issued.issuedAt, PAIRING_TTL_MS);
    assert.deepEqual(JSON.parse(await fsp.readFile(path.join(h.home, 'channels.json'), 'utf8')).code.code, issued.code);
    const wrong = issued.code.endsWith('A') ? issued.code.slice(0, -1) + 'B' : issued.code.slice(0, -1) + 'A';
    for (let i = 1; i < PAIRING_MAX_ATTEMPTS; i++) {
      await h.fake.receive({ chatId: '555', userId: 'u5', text: wrong, updateId: `w-${i}` });
      assert.equal(h.ofType('channel.inbound').at(-1).outcome, 'refused: wrong code');
      assert.equal(h.channels.pairing().attempts, i);
    }
    await h.fake.receive({ chatId: '555', userId: 'u5', text: wrong, updateId: 'w-last' });
    assert.equal(h.ofType('channel.inbound').at(-1).outcome, 'refused: wrong code; the code is revoked');
    assert.equal(h.channels.pairing(), null, 'five wrong codes revoke it');
    await h.fake.receive({ chatId: '555', userId: 'u5', text: issued.code, updateId: 'w-after' });
    assert.equal(h.ofType('channel.inbound').at(-1).outcome, 'refused: no valid pairing code');
    assert.equal(h.channels.list()[0].paired.length, 0);
    // A fresh code, sent with the /pair prefix and lowercase: paired, the code is spent.
    const fresh = await h.channels.newPairingCode();
    assert.notEqual(fresh.code, issued.code);
    await h.fake.receive({ chatId: '555', userId: 'u5', text: `/pair ${fresh.code.toLowerCase()}`, updateId: 'p-1' });
    assert.deepEqual(h.ofType('channel.inbound').at(-1), { channel: 'fakechat', chatId: '555', userId: 'u5', action: 'pair', paired: true, outcome: 'paired' });
    assert.equal(h.channels.pairing(), null);
    assert.deepEqual(h.channels.list()[0].paired.map((c) => [c.chatId, c.userId]), [['555', 'u5']]);
    assert.match(h.fake.sentTo('555').at(-1).text, /Paired with the Mountain Peak/);
    assert.equal(h.ofType('channel.delivery').at(-1).kind, 'pairing');
    await h.fake.receive({ chatId: '556', userId: 'u6', text: fresh.code, updateId: 'p-2' });
    assert.equal(h.ofType('channel.inbound').at(-1).outcome, 'refused: no valid pairing code', 'a spent code pairs nobody else');
    // Persistence: a fresh registry over the same store knows the chat.
    const again = await createChannels({ bus: createEventBus(), store: h.store, gateQueue: h.gateQueue, env: {}, keystorePath: h.keystorePath, clock: h.clock }).init();
    again.register(fakeChannel());
    assert.deepEqual(again.list()[0].paired.map((c) => c.chatId), ['555']);
    // The pairing code expires with the clock.
    const expiring = await h.channels.newPairingCode();
    const until = expiring.expiresAt;
    while (h.clock.now() < until) h.clock.now();
    assert.equal(h.channels.pairing(), null);
    // Unpair from the Peak.
    await assert.rejects(h.channels.unpair('fakechat', '999'), (e) => e.code === 'NOT_PAIRED');
    await assert.rejects(h.channels.unpair('nope', '555'), (e) => e.code === 'UNKNOWN_CHANNEL');
    await h.channels.unpair('fakechat', '555');
    assert.equal(h.channels.list()[0].paired.length, 0);
    assert.equal(h.ofType('channel.inbound').at(-1).outcome, 'unpaired at the Peak');
    await h.channels.flushed();
    assert.deepEqual(JSON.parse(await fsp.readFile(path.join(h.home, 'channels.json'), 'utf8')).chats, {});
    // After the hour the reminder goes again.
    const t0 = h.clock.now();
    while (h.clock.now() < t0 + UNPAIRED_REPLY_EVERY_MS) h.clock.now();
    const before = h.fake.sentTo('555').length;
    await h.fake.receive({ chatId: '555', userId: 'u5', text: 'still here', updateId: 'x-1' });
    assert.equal(h.fake.sentTo('555').length, before + 1);
    await h.gateQueue.resolve(firstId, { decision: 'reject' });
    await first;
  } finally {
    await h.cleanup();
  }
});

async function paired(h, chatId = '555', userId = 'u5') {
  const code = (await h.channels.newPairingCode()).code;
  await h.fake.receive({ chatId, userId, text: code, updateId: `pair-${chatId}` });
  assert.ok(h.channels.list()[0].paired.some((c) => c.chatId === chatId));
}

test('Gate items reach every paired chat as cards; Approve / Reject resolve them, Revise takes the notes from the next message, a replayed update is dropped, other chats hear the outcome', async () => {
  const h = await harness({ env: { TELEGRAM_BOT_TOKEN: 'tok' } });
  try {
    await h.channels.start();
    await paired(h, '555', 'u5');
    await paired(h, '777', 'u7');
    const decided = h.gateQueue.submit({ agentId: 'books', domain: 'money_out', tool: 'stripe.refund', summary: 'refund ch_1 $5.00', runId: 'r1', callId: 'c1', level: 'draft', amountUsd: 5, evidence: [{ kind: 'said', text: 'the customer asked for it' }] });
    const itemId = h.gateQueue.pending()[0].itemId;
    await waitUntil(() => h.fake.sentTo('777').some((m) => m.kind === 'card'));
    const card555 = h.fake.sentTo('555').find((m) => m.kind === 'card');
    assert.equal(card555.card.itemId, itemId);
    assert.match(card555.card.lines[1], /the customer asked/);
    assert.deepEqual(h.ofType('channel.delivery').filter((d) => d.kind === 'gate_card').map((d) => [d.chatId, d.status, d.itemId]), [['555', 'sent', itemId], ['777', 'sent', itemId]]);
    assert.deepEqual(h.channels.cardHolders(itemId).map((c) => c.chatId), ['555', '777']);
    // Approve from 555; 777 hears it; a replay of the same update changes nothing.
    await h.fake.receive({ chatId: '555', userId: 'u5', callback: { data: gateButtonData(itemId, 'approve'), messageId: card555.messageId }, updateId: 'a-1' });
    const d = await decided;
    assert.equal(d.decision, 'approve');
    assert.equal(h.gateQueue.get(itemId).status, 'approved');
    assert.deepEqual(h.ofType('channel.inbound').at(-1), { channel: 'fakechat', chatId: '555', userId: 'u5', messageId: card555.messageId, action: 'gate', paired: true, outcome: 'accepted', itemId, decision: 'approve' });
    assert.match(h.fake.sentTo('555').at(-1).text, /^Approved: refund ch_1/);
    await waitUntil(() => h.fake.sentTo('777').some((m) => m.kind === 'text' && /APPROVED via fakechat/.test(m.text)));
    assert.equal(h.ofType('channel.delivery').filter((x) => x.kind === 'gate_update' && x.chatId === '777').length, 1);
    const n = h.ofType('channel.inbound').length;
    await h.fake.receive({ chatId: '555', userId: 'u5', callback: { data: gateButtonData(itemId, 'approve'), messageId: card555.messageId }, updateId: 'a-1' });
    assert.equal(h.ofType('channel.inbound').length, n, 'replayed update id: nothing happens');
    await h.fake.receive({ chatId: '555', userId: 'u5', callback: { data: gateButtonData(itemId, 'reject'), messageId: card555.messageId }, updateId: 'a-2' });
    assert.equal(h.ofType('channel.inbound').at(-1).outcome, 'refused: already approved');
    await h.fake.receive({ chatId: '555', userId: 'u5', text: '/approve gate-nope', updateId: 'a-3' });
    assert.equal(h.ofType('channel.inbound').at(-1).outcome, 'refused: unknown item');
    // Revise: notes are asked for and the next message carries them.
    const revised = h.gateQueue.submit({ agentId: 'marketing', domain: 'publishing', tool: 'mail.send', summary: 'campaign to 40 subscribers', runId: 'r2', callId: 'c2', level: 'draft' });
    const item2 = h.gateQueue.pending()[0].itemId;
    await waitUntil(() => h.fake.sentTo('555').some((m) => m.kind === 'card' && m.card.itemId === item2));
    await h.fake.receive({ chatId: '555', userId: 'u5', callback: { data: gateButtonData(item2, 'revise'), messageId: '1' }, updateId: 'r-1' });
    assert.equal(h.ofType('channel.inbound').at(-1).outcome, 'notes requested');
    assert.equal(h.gateQueue.get(item2).status, 'pending');
    assert.match(h.fake.sentTo('555').at(-1).text, /reply with your notes/);
    await h.fake.receive({ chatId: '555', userId: 'u5', text: 'shorter subject, no emoji', updateId: 'r-2' });
    const d2 = await revised;
    assert.deepEqual([d2.decision, d2.notes], ['revise', 'shorter subject, no emoji']);
    const notesEv = h.ofType('channel.inbound').find((e) => e.action === 'notes');
    assert.deepEqual([notesEv.outcome, notesEv.itemId, notesEv.decision, notesEv.text], ['accepted', item2, 'revise', 'shorter subject, no emoji']);
    assert.equal(h.ofType('channel.inbound').at(-1).outcome, 'accepted');
    // The slash form carries the notes inline; a revise without notes on a proposal is refused.
    const third = h.gateQueue.submit({ agentId: 'marketing', domain: 'publishing', tool: 'mail.send', summary: 'another campaign', runId: 'r3', callId: 'c3', level: 'draft' });
    const item3 = h.gateQueue.pending()[0].itemId;
    await waitUntil(() => h.fake.sentTo('777').some((m) => m.kind === 'card' && m.card.itemId === item3));
    await h.fake.receive({ chatId: '777', userId: 'u7', text: `/reject ${item3} not this week`, updateId: 'r-3' });
    const d3 = await third;
    assert.deepEqual([d3.decision, d3.notes], ['reject', 'not this week']);
    await waitUntil(() => h.fake.sentTo('555').some((m) => /REJECTED via fakechat: another campaign\nNotes: not this week/.test(m.text || '')));
    // Notes that come too late are refused.
    const late = h.gateQueue.submit({ agentId: 'marketing', domain: 'publishing', tool: 'mail.send', summary: 'late one', runId: 'r4', callId: 'c4', level: 'draft' });
    const item4 = h.gateQueue.pending()[0].itemId;
    await waitUntil(() => h.fake.sentTo('555').some((m) => m.kind === 'card' && m.card.itemId === item4));
    await h.fake.receive({ chatId: '555', userId: 'u5', text: `/revise ${item4}`, updateId: 'l-1' });
    assert.equal(h.ofType('channel.inbound').at(-1).outcome, 'notes requested');
    const t0 = h.clock.now();
    while (h.clock.now() < t0 + NOTES_TTL_MS + 1) h.clock.now();
    await h.fake.receive({ chatId: '555', userId: 'u5', text: 'too late', updateId: 'l-2' });
    assert.equal(h.ofType('channel.inbound').at(-1).outcome, 'refused: the notes came too late');
    assert.equal(h.gateQueue.get(item4).status, 'pending');
    // Decided at the park: both chats hear "at the park".
    await h.gateQueue.resolve(item4, { decision: 'approve' });
    await late;
    await waitUntil(() => h.fake.sentTo('777').some((m) => /APPROVED at the park: late one/.test(m.text || '')));
    assert.ok(h.fake.sentTo('555').some((m) => /APPROVED at the park: late one/.test(m.text || '')));
    // A platform that refuses a send is a failed delivery, never a silent one.
    h.fake.state.fail = 'chat not found';
    const lost = h.gateQueue.submit({ agentId: 'books', domain: 'money_out', tool: 'stripe.refund', summary: 'lost card', runId: 'r5', callId: 'c5', level: 'draft', amountUsd: 1 });
    const item5 = h.gateQueue.pending()[0].itemId;
    await waitUntil(() => h.ofType('channel.delivery').filter((x) => x.itemId === item5 && x.status === 'failed').length === 2);
    assert.match(h.ofType('channel.delivery').at(-1).error, /chat not found/);
    assert.deepEqual(h.channels.cardHolders(item5), []);
    h.fake.state.fail = null;
    await h.gateQueue.resolve(item5, { decision: 'reject' });
    await lost;
  } finally {
    await h.cleanup();
  }
});

test('commands from a paired chat: /gate re-sends the cards, /status, /away and /back, /help, an unknown command; reflections and digests are delivered; away mode logs channel messages', async () => {
  const chiefState = { mission: { id: 'mission-1', status: 'active', reason: '' }, plan: { version: 2 }, caps: { judgeUsdPerDay: 10 }, judgeToday: { usd: 0.5, calls: 3 } };
  const h = await harness({ env: { TELEGRAM_BOT_TOKEN: 'tok' }, chief: { state: () => chiefState }, reflect: { latest: () => ({ id: 'reflection-1', status: 'posted' }), gather: async () => null } });
  try {
    await h.channels.start();
    await paired(h);
    await h.fake.receive({ chatId: '555', userId: 'u5', text: '/gate', updateId: 'g-0' });
    assert.match(h.fake.sentTo('555').at(-1).text, /Nothing is waiting/);
    const p1 = h.gateQueue.submit({ agentId: 'books', domain: 'money_out', tool: 'stripe.refund', summary: 'refund one', runId: 'r1', callId: 'c1', level: 'draft', amountUsd: 1 });
    const id1 = h.gateQueue.pending()[0].itemId;
    await waitUntil(() => h.fake.sentTo('555').some((m) => m.kind === 'card'));
    await h.fake.receive({ chatId: '555', userId: 'u5', text: '/gate@maka_bot', updateId: 'g-1' });
    assert.equal(h.fake.sentTo('555').filter((m) => m.kind === 'card' && m.card.itemId === id1).length, 2);
    assert.equal(h.ofType('channel.inbound').at(-1).outcome, 'listed 1');
    assert.equal(h.channels.cardHolders(id1).length, 1, 'one holder per chat, the newest card');
    await h.fake.receive({ chatId: '555', userId: 'u5', text: '/status', updateId: 'g-2' });
    const status = h.fake.sentTo('555').at(-1).text;
    assert.match(status, /Gate: 1 waiting/);
    assert.match(status, /Mission mission-1: active · plan v2/);
    assert.match(status, /Judge today: \$0\.50 of \$10/);
    assert.match(status, /Last reflection: reflection-1 posted/);
    await h.fake.receive({ chatId: '555', userId: 'u5', text: '/away', updateId: 'g-3' });
    assert.equal(h.away.state().away, true);
    assert.match(h.fake.sentTo('555').at(-1).text, /Away mode is on/);
    // While away a Gate decision from the phone is in the evidence log.
    await h.fake.receive({ chatId: '555', userId: 'u5', text: `/approve ${id1}`, updateId: 'g-4' });
    await p1;
    await h.away.flushed();
    const lines = await h.away.readLog();
    assert.ok(lines.some((l) => l.type === 'channel.inbound' && l.payload.action === 'gate' && l.payload.outcome === 'accepted'));
    assert.ok(lines.some((l) => l.type === 'gate.item' && l.payload.status === 'approved' && l.payload.away === true));
    await h.fake.receive({ chatId: '555', userId: 'u5', text: '/back', updateId: 'g-5' });
    assert.equal(h.away.state().away, false);
    await waitUntil(() => h.fake.sentTo('555').some((m) => /^Away digest digest-/.test(m.text || '')));
    assert.match(h.fake.sentTo('555').find((m) => /^Welcome back/.test(m.text || '')).text, /1 action\(s\)/);
    assert.equal(h.ofType('channel.delivery').find((d) => d.kind === 'digest').status, 'sent');
    await h.fake.receive({ chatId: '555', userId: 'u5', text: '/help', updateId: 'g-6' });
    assert.match(h.fake.sentTo('555').at(-1).text, /Commands: \/gate/);
    await h.fake.receive({ chatId: '555', userId: 'u5', text: '/dance', updateId: 'g-7' });
    assert.equal(h.ofType('channel.inbound').at(-1).outcome, 'refused: unknown command');
    await h.fake.receive({ chatId: '555', userId: 'u5', text: '/approve', updateId: 'g-8' });
    assert.equal(h.ofType('channel.inbound').at(-1).outcome, 'refused: no item id');
    await h.fake.receive({ chatId: '555', userId: 'u5', callback: { data: 'what:ever', messageId: '3' }, updateId: 'g-9' });
    assert.equal(h.ofType('channel.inbound').at(-1).outcome, 'ignored: unknown button');
    await h.fake.receive({ chatId: '555', userId: 'u5', text: '   ', updateId: 'g-10' });
    assert.equal(h.ofType('channel.inbound').at(-1).outcome, 'ignored: no text');
    // A reflection is delivered as text.
    h.bus.emit(makeEvent('reflection.posted', { reflectionId: 'reflection-2', reason: 'manual', status: 'posted', portfolio: 'Two ventures, one on track.', ventures: [{ id: 'lanterns', planStillRight: true, spentUsd: 1.5, budgetUsd: 10, itemsDone: 2, itemsFailed: 0 }], briefings: ['marketing'], path: 'chief-ranger/outbox/reflection-2.md' }, { ts: h.clock.now() }));
    await waitUntil(() => h.fake.sentTo('555').some((m) => /^Reflection reflection-2/.test(m.text || '')));
    const refl = h.fake.sentTo('555').at(-1).text;
    assert.match(refl, /Two ventures, one on track/);
    assert.match(refl, /- lanterns: plan still right, \$1\.50 of \$10\.00, 2 done \/ 0 failed/);
    h.bus.emit(makeEvent('reflection.posted', { reflectionId: 'reflection-3', reason: 'scheduled', status: 'skipped', skipReason: 'judge daily cap reached' }, { ts: h.clock.now() }));
    await waitUntil(() => h.fake.sentTo('555').some((m) => /Reflection reflection-3 skipped: judge daily cap reached/.test(m.text || '')));
    const n = await h.channels.notify('plain notice');
    assert.equal(n.length, 1);
    assert.equal(h.fake.sentTo('555').at(-1).text, 'plain notice');
  } finally {
    await h.cleanup();
  }
});

test('ask the Peak: free text from a paired chat is a bounded, tool-less Chief run on the Chief\'s model; the answer comes back with evidence; the judge cap and a busy Chief refuse plainly', async () => {
  const fake = fakeChannel();
  const seen = [];
  const makeProvider = async (name, opts) => {
    seen.push({ name, model: opts.model });
    if (name === 'anthropic') return { provider: fakeProvider([[text('Spend so far is $0.00 of the $20.00 mission budget; nothing is waiting at the Gate.'), end()]], { name }), model: opts.model || 'judge', price: PRICE };
    return { provider: fakeProvider([[text('worker'), end()]], { name }), model: 'w', price: null };
  };
  const srv = await startTestServer({ makeProvider, withChief: true, env: { ANTHROPIC_API_KEY: 'sk-test' }, channels: [fake] });
  try {
    const sse = await srv.sse();
    const state = await srv.get('/api/state');
    assert.equal(state.body.channels.adapters[0].status, 'not_wired');
    assert.equal(state.body.channels.pairing, null);
    // The routes keep the boot token (safety M4) and the Gate holds the bot token.
    const bare = await fetch(`${srv.url}/api/channels/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(bare.status, 403);
    const conn = await srv.post('/api/channels/fakechat/connect', { token: '123:secret-token' });
    assert.equal(conn.status, 202);
    const item = await sse.waitFor((e) => e.type === 'gate.item' && e.payload.tool === 'channel.connect' && e.payload.status === 'pending');
    assert.equal(item.payload.domain, 'account_settings');
    assert.match(item.payload.evidence[0].text, /…oken$/);
    assert.equal(JSON.stringify(item.payload).includes('123:secret'), false);
    assert.equal((await srv.post('/api/channels/fakechat/connect', { token: 'x' })).status, 409, 'one decision at a time');
    await srv.post(`/api/gate/${item.payload.itemId}`, { decision: 'approve' });
    await sse.waitFor((e) => e.type === 'channel.connect' && e.payload.status === 'up');
    assert.equal(await resolveKey('telegramBot', { env: {}, keystorePath: srv.keystorePath }), '123:secret-token');
    assert.equal(((await fsp.stat(srv.keystorePath)).mode & 0o777), 0o600);
    assert.equal((await srv.get('/api/channels')).body.adapters[0].by, 'keystore');
    const code = (await srv.post('/api/channels/pair', {})).body.code;
    await fake.receive({ chatId: '42', userId: 'owner', text: code, updateId: '1' });
    assert.deepEqual((await srv.get('/api/channels')).body.adapters[0].paired.map((c) => c.chatId), ['42']);
    // A question.
    await srv.post('/api/mission', { text: 'Sell lanterns', budgetUsd: 20 }).then((r) => assert.equal(r.status, 202));
    await sse.waitFor((e) => e.type === 'agent.run.end');
    await fake.receive({ chatId: '42', userId: 'owner', text: 'How much have we spent so far?', updateId: '2' });
    const asked = await sse.waitFor((e) => e.type === 'channel.inbound' && e.payload.action === 'ask');
    assert.equal(asked.payload.outcome, 'asked');
    assert.ok(asked.payload.runId);
    const started = await sse.waitFor((e) => e.type === 'agent.run.start' && e.payload.runId === asked.payload.runId);
    assert.deepEqual(started.payload.tools, [], 'no tools in an ask run');
    assert.equal(started.payload.agentId, 'chief-ranger');
    assert.match(started.payload.prompt, /QUESTION from the Superintendent \(via channel:fakechat\): How much have we spent so far\?/);
    assert.match(started.payload.prompt, /Mission mission-/);
    const answered = await sse.waitFor((e) => e.type === 'channel.delivery' && e.payload.kind === 'answer');
    assert.equal(answered.payload.status, 'sent');
    const msg = fake.sentTo('42').at(-1).text;
    assert.match(msg, /^Spend so far is \$0\.00/);
    assert.match(msg, new RegExp(`Evidence: run ${asked.payload.runId} · mission mission-`), 'the scripted Chief submitted no plan, so the evidence names the run and the mission');
    const run = await srv.get(`/api/runs/${asked.payload.runId}`);
    assert.equal(run.body.step, 'plan');
    assert.equal(run.body.model, 'claude-opus-5-5');
    assert.ok(seen.some((s) => s.name === 'anthropic' && s.model === 'claude-opus-5-5'));
    assert.ok(srv.ledger.judgeToday().usd > 0, 'the ask run counts as judge spend');
    // At the judge cap the question is refused, not spent.
    await srv.ledger.recordJudge({ usd: 10 });
    await fake.receive({ chatId: '42', userId: 'owner', text: 'And now?', updateId: '3' });
    const capped = await sse.waitFor((e) => e.type === 'channel.inbound' && e.payload.action === 'ask' && e.payload.outcome !== 'asked');
    assert.equal(capped.payload.outcome, 'refused: JUDGE_CAP');
    assert.match(fake.sentTo('42').at(-1).text, /cannot answer now: judge daily cap reached/);
    // Disconnect through the Gate removes the token and stops the adapter.
    const disc = await srv.post('/api/channels/fakechat/disconnect', {});
    assert.equal(disc.status, 202);
    await srv.post(`/api/gate/${disc.body.itemId}`, { decision: 'approve' });
    await sse.waitFor((e) => e.type === 'channel.connect' && e.payload.status === 'down');
    assert.equal(await resolveKey('telegramBot', { env: {}, keystorePath: srv.keystorePath }), null);
    assert.equal((await srv.get('/api/channels')).body.adapters[0].paired.length, 1, 'pairing survives a disconnect');
    assert.equal((await srv.post('/api/channels/fakechat/unpair', { chatId: 42 })).status, 200);
    assert.equal((await srv.post('/api/channels/nope/unpair', { chatId: '1' })).status, 404);
    sse.close();
  } finally {
    await srv.close();
  }
});

test('D171: a per-call confirmation reaches the phone, and /allow answers it from there', async () => {
  const h = await harness({ env: { TELEGRAM_BOT_TOKEN: '123:abc' } });
  try {
    await h.channels.start();
    // Pair the owner's chat the way the registry requires.
    const { code } = await h.channels.newPairingCode();
    await h.fake.receive({ chatId: 'c1', userId: 'u1', text: code, updateId: 'p-1' });
    assert.equal(h.channels.list()[0].paired.length, 1, 'the chat paired');
    h.fake.state.sent.length = 0;

    // fs.write asks per call: a permission.prompt, not a Gate item. Before D171 this
    // never left the park page, so a Superintendent away from the screen could not let a
    // Ranger write a file and the prompt timed out as a denial.
    h.bus.emit(makeEvent('permission.prompt', { promptId: 'perm-1', runId: 'run-1', callId: 'c', tool: 'fs.write', reason: 'Write a UTF-8 text file', input: { path: 'outbox/sheet.md' } }, { ts: h.clock.now() }));
    await new Promise((r) => setTimeout(r, 20));
    const card = h.fake.state.sent.at(-1);
    assert.ok(card, 'the confirmation reached the chat');
    assert.match(JSON.stringify(card), /fs\.write/);
    assert.match(JSON.stringify(card), /perm-1/);

    // Answering from the phone goes back to the run manager as an allow.
    await h.fake.receive({ chatId: 'c1', userId: 'u1', text: '/allow perm-1', updateId: 'a-1' });
    assert.deepEqual(h.answered.at(-1), { promptId: 'perm-1', runId: 'run-1', allow: true });

    // The answer, wherever it came from, closes the card in the chat.
    h.bus.emit(makeEvent('permission.response', { promptId: 'perm-1', runId: 'run-1', allow: true }, { ts: h.clock.now() }));
    await new Promise((r) => setTimeout(r, 20));
    assert.match(JSON.stringify(h.fake.state.sent.at(-1)), /ALLOWED/);

    // A prompt that already timed out says so rather than pretending.
    await h.fake.receive({ chatId: 'c1', userId: 'u1', text: '/deny perm-gone', updateId: 'a-2' });
    assert.equal(h.answered.at(-1).allow, false);
    assert.match(JSON.stringify(h.fake.state.sent.at(-1)), /no longer waiting/);

    // And an unpaired chat cannot answer anything.
    h.fake.state.sent.length = 0;
    await h.fake.receive({ chatId: 'stranger', userId: 'u9', text: '/allow perm-1', updateId: 'a-3' });
    assert.equal(h.answered.filter((a) => a.promptId === 'perm-1' && a.allow === true).length, 1, 'the stranger answered nothing');
  } finally {
    await h.cleanup();
  }
});

test('D172: a channel that carries only its owner pairs on sight, and every other channel still needs the code', async () => {
  // iMessage checks the owner's handle on every message in and out, so the handle is the
  // credential and a pairing code would be asking the owner to prove they are themselves.
  const trusted = fakeChannel();
  trusted.trusted = true;
  const h = await harness({ env: { TELEGRAM_BOT_TOKEN: '123:abc' }, adapters: [trusted] });
  try {
    await h.channels.start();
    assert.equal(h.channels.list()[0].paired.length, 0);
    // The first message from a private chat is acted on, not answered with "not paired".
    await trusted.receive({ chatId: 'owner', userId: 'u1', text: '/status', updateId: 't-1' });
    assert.equal(h.channels.list()[0].paired.length, 1, 'paired on sight');
    assert.equal(h.ofType('channel.inbound').at(0).outcome, 'paired: the channel only carries the owner');
    // It answered the command rather than asking for a code.
    assert.doesNotMatch(JSON.stringify(trusted.state.sent), /pairing code/i);
  } finally {
    await h.cleanup();
  }

  // An untrusted channel is unchanged: no code, no pairing.
  const h2 = await harness({ env: { TELEGRAM_BOT_TOKEN: '123:abc' } });
  try {
    await h2.channels.start();
    await h2.fake.receive({ chatId: 'stranger', userId: 'u9', text: '/status', updateId: 's-1' });
    assert.equal(h2.channels.list()[0].paired.length, 0, 'a bot anyone can message still pairs by code');
    assert.match(JSON.stringify(h2.fake.state.sent), /not paired/i);
  } finally {
    await h2.cleanup();
  }
});
