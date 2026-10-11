// Regression tests for docs/SECURITY_REVIEW_2026-10-11.md (the phase 4 safety review).
// One block per finding, each reproducing the review's failure scenario; every test here
// failed on 4733a1e / f8bcda6 before its fix. Nothing here weakens a fix from
// docs/SECURITY_REVIEW_2026-10-10.md (test/safety.test.js holds those).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createStore } from '../sidecar/store.js';
import { createEventBus } from '../sidecar/bus.js';
import { createLeashLedger, createLeashState } from '../sidecar/leash-ledger.js';
import { createGateQueue } from '../sidecar/gate-queue.js';
import { createChannels } from '../sidecar/channels/registry.js';
import { gateButtonData } from '../sidecar/channels/adapter.js';
import { createTelegramAdapter } from '../sidecar/channels/telegram.js';
import { createSlackAdapter } from '../sidecar/channels/slack.js';
import { createDiscordAdapter } from '../sidecar/channels/discord.js';
import { createNetGuard } from '../sidecar/netguard.js';
import { defaultLeash } from '../shared/leash.js';
import { defaultLayout } from '../shared/world.js';
import { fakeChannel } from './helpers/fake-channel.js';
import { fakeClock, waitUntil } from './helpers/fake-provider.js';
import { startFakeTelegram } from './helpers/fake-telegram.js';
import { startFakeSlack } from './helpers/fake-slack.js';
import { startFakeDiscord } from './helpers/fake-discord.js';

const local = createNetGuard({ allowLocal: true });
const quiet = { warn() {}, error() {} };

// ---------------------------------------------------------------------------------------
// H1: pairing trusts the user, not the chat.
// ---------------------------------------------------------------------------------------

async function channelHarness() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-safety4-'));
  const store = createStore({ root: path.join(dir, 'home') });
  await store.init();
  const bus = createEventBus();
  const events = [];
  bus.listen((e) => events.push(e));
  const clock = fakeClock(1_700_000_000_000);
  const ledger = await createLeashLedger({ store, clock }).init();
  const leashState = createLeashState({ initial: defaultLeash(), store });
  const gateQueue = await createGateQueue({ bus, store, ledger, leashState, getLayout: defaultLayout, clock, isAway: () => false }).init();
  let seed = 0;
  const random = (n) => { seed += 1; return Buffer.from(Array.from({ length: n }, (_, i) => (seed * 7 + i * 13) % 251)); };
  const warnings = [];
  const channels = await createChannels({ bus, store, gateQueue, env: { TELEGRAM_BOT_TOKEN: 'tok' }, keystorePath: path.join(dir, 'home', 'keystore.json'), clock, random, log: { error() {}, warn: (m) => warnings.push(m) } }).init();
  const fake = fakeChannel();
  channels.register(fake);
  await channels.start();
  const inbound = () => events.filter((e) => e.type === 'channel.inbound').map((e) => e.payload);
  return { channels, fake, gateQueue, clock, inbound, warnings, cleanup: async () => { await channels.close(); await fsp.rm(dir, { recursive: true, force: true }); } };
}

test('H1: a second user in a paired chat cannot approve, revise, command or ask; the refusal names the real sender', async () => {
  const h = await channelHarness();
  try {
    const code = (await h.channels.newPairingCode()).code;
    await h.fake.receive({ chatId: '555', userId: 'owner', text: code, updateId: 'p1' });
    assert.deepEqual(h.channels.list()[0].paired.map((c) => [c.chatId, c.userId]), [['555', 'owner']]);
    const decided = h.gateQueue.submit({ agentId: 'books', domain: 'money_out', tool: 'stripe.refund', summary: 'refund $900', runId: 'r1', callId: 'c1', level: 'draft', amountUsd: 900 });
    const itemId = h.gateQueue.pending()[0].itemId;
    await waitUntil(() => h.fake.sentTo('555').some((m) => m.kind === 'card'));
    // The review's scenario: another member of the chat presses Approve on the money card.
    await h.fake.receive({ chatId: '555', userId: 'intruder', callback: { data: gateButtonData(itemId, 'approve'), messageId: '100' }, updateId: 'x1' });
    assert.equal(h.gateQueue.get(itemId).status, 'pending', 'the item still waits');
    let ev = h.inbound().at(-1);
    assert.deepEqual(ev, { channel: 'fakechat', chatId: '555', userId: 'intruder', messageId: '100', action: 'gate', paired: false, outcome: 'refused: not the paired user', itemId, decision: 'approve' });
    assert.ok(h.warnings.some((w) => /not the paired user in paired chat 555: user intruder \(paired user owner\) tried to approve/.test(w)));
    assert.match(h.fake.sentTo('555').at(-1).text, /Only the user who paired this chat/);
    // The slash command, a question and revise notes from the other user are refused too.
    await h.fake.receive({ chatId: '555', userId: 'intruder', text: `/approve ${itemId}`, updateId: 'x2' });
    assert.equal(h.gateQueue.get(itemId).status, 'pending');
    ev = h.inbound().at(-1);
    assert.deepEqual([ev.userId, ev.action, ev.paired, ev.outcome, ev.text], ['intruder', 'command', false, 'refused: not the paired user', `/approve ${itemId}`]);
    await h.fake.receive({ chatId: '555', userId: 'intruder', text: 'what is the balance?', updateId: 'x3' });
    ev = h.inbound().at(-1);
    assert.deepEqual([ev.userId, ev.action, ev.outcome], ['intruder', 'ask', 'refused: not the paired user']);
    await h.fake.receive({ chatId: '555', userId: 'owner', callback: { data: gateButtonData(itemId, 'revise'), messageId: '100' }, updateId: 'o1' });
    assert.equal(h.inbound().at(-1).outcome, 'notes requested');
    await h.fake.receive({ chatId: '555', userId: 'intruder', text: 'approve it instead', updateId: 'x4' });
    assert.equal(h.inbound().at(-1).outcome, 'refused: not the paired user');
    assert.equal(h.gateQueue.get(itemId).status, 'pending', 'the intruder\'s words are not the owner\'s notes');
    // A message without a sender id is refused as well.
    await h.fake.receive({ chatId: '555', userId: '', callback: { data: gateButtonData(itemId, 'approve'), messageId: '100' }, updateId: 'x5' });
    assert.deepEqual([h.inbound().at(-1).userId, h.inbound().at(-1).outcome], ['unknown', 'refused: not the paired user']);
    // The owner's own decision goes through and is attributed to the owner.
    await h.fake.receive({ chatId: '555', userId: 'owner', text: 'use the smaller amount', updateId: 'o2' });
    const d = await decided;
    assert.deepEqual([d.decision, d.notes], ['revise', 'use the smaller amount']);
    assert.deepEqual([h.inbound().at(-1).userId, h.inbound().at(-1).outcome], ['owner', 'accepted']);
  } finally {
    await h.cleanup();
  }
});

test('H1: pairing is refused from a chat that is not private; a right code seen by a group is revoked; a paired chat that turns non-private is refused', async () => {
  const h = await channelHarness();
  try {
    const issued = (await h.channels.newPairingCode()).code;
    // A group member sends the right code: no pairing, the code is revoked (it was exposed).
    await h.fake.receive({ chatId: '-100', userId: 'u1', text: issued, updateId: 'g1', chatType: 'supergroup' });
    assert.equal(h.channels.list()[0].paired.length, 0);
    assert.equal(h.channels.pairing(), null, 'the exposed code is revoked');
    assert.deepEqual([h.inbound().at(-1).action, h.inbound().at(-1).paired, h.inbound().at(-1).outcome], ['pair', false, 'refused: not a private chat (supergroup); the code was exposed here and is revoked']);
    assert.match(h.fake.sentTo('-100').at(-1).text, /only from a private chat/);
    assert.ok(h.warnings.some((w) => /cannot pair/.test(w)));
    // A wrong code from a group: refused, nothing counted against the code.
    const fresh = (await h.channels.newPairingCode()).code;
    await h.fake.receive({ chatId: '-100', userId: 'u1', text: fresh.endsWith('A') ? `${fresh.slice(0, -1)}B` : `${fresh.slice(0, -1)}A`, updateId: 'g2', chatType: 'group' });
    assert.equal(h.inbound().at(-1).outcome, 'refused: not a private chat (group)');
    assert.equal(h.channels.pairing().code, fresh, 'the code stands');
    // A chat with no type at all cannot pair either (the adapter must say it is private).
    await h.fake.receive({ chatId: '556', userId: 'u6', text: fresh, updateId: 'n1', chatType: null });
    assert.equal(h.inbound().at(-1).outcome, 'refused: not a private chat (type unknown); the code was exposed here and is revoked');
    assert.equal(h.channels.pairing(), null);
    // No sender id: cannot pair.
    const third = (await h.channels.newPairingCode()).code;
    await h.fake.receive({ chatId: '557', userId: '', text: third, updateId: 'n2' });
    assert.equal(h.inbound().at(-1).outcome, 'refused: no sender id; the code was exposed here and is revoked');
    // A private chat pairs; the same chat reporting a non-private type later is refused.
    const fourth = (await h.channels.newPairingCode()).code;
    await h.fake.receive({ chatId: '555', userId: 'owner', text: fourth, updateId: 'p1' });
    assert.equal(h.inbound().at(-1).outcome, 'paired');
    h.gateQueue.submit({ agentId: 'books', domain: 'money_out', tool: 'stripe.refund', summary: 'refund $5', runId: 'r1', callId: 'c1', level: 'draft', amountUsd: 5 });
    const itemId = h.gateQueue.pending()[0].itemId;
    await h.fake.receive({ chatId: '555', userId: 'owner', callback: { data: gateButtonData(itemId, 'approve'), messageId: '1' }, updateId: 'p2', chatType: 'group' });
    assert.equal(h.gateQueue.get(itemId).status, 'pending');
    assert.equal(h.inbound().at(-1).outcome, 'refused: not a private chat (group)');
    await h.gateQueue.resolve(itemId, { decision: 'reject' });
  } finally {
    await h.cleanup();
  }
});

test('H1: the adapters report the chat type: Telegram chat.type, Slack channel_type / directmessage, Discord guild_id', async () => {
  const telegram = await startFakeTelegram();
  try {
    const tg = createTelegramAdapter({ baseUrl: telegram.url, netGuard: local, pollTimeoutS: 1, log: quiet });
    const inbound = [];
    await tg.start({ keys: { telegramBot: telegram.token }, onInbound: async (m) => inbound.push(m) });
    telegram.message({ chatId: 42, text: 'hi' });
    telegram.message({ chatId: -500, userId: 7, text: 'hi all', chatType: 'supergroup' });
    telegram.press({ chatId: -500, userId: 7, data: gateButtonData('gate-1', 'approve'), chatType: 'group' });
    await waitUntil(() => inbound.length === 3);
    assert.deepEqual(inbound.map((m) => m.chatType), ['private', 'supergroup', 'group']);
    await tg.stop();
  } finally {
    await telegram.close();
  }
  const slack = await startFakeSlack();
  try {
    const sl = createSlackAdapter({ apiUrl: slack.apiUrl, netGuard: local, log: quiet });
    const inbound = [];
    await sl.start({ keys: { slackBot: slack.botToken, slackApp: slack.appToken }, onInbound: async (m) => inbound.push(m) });
    await waitUntil(() => sl.connected());
    slack.message({ chatId: 'D1', userId: 'U1', text: 'hi' });
    slack.message({ chatId: 'C1', userId: 'U2', text: 'hi all', channelType: 'channel' });
    slack.press({ chatId: 'C1', userId: 'U2', data: gateButtonData('gate-1', 'approve'), channelName: 'general' });
    slack.press({ chatId: 'D1', userId: 'U1', data: gateButtonData('gate-1', 'approve') });
    await waitUntil(() => inbound.length === 4);
    assert.deepEqual(inbound.map((m) => m.chatType), ['private', 'channel', 'channel', 'private']);
    await sl.stop();
  } finally {
    await slack.close();
  }
  const discord = await startFakeDiscord();
  try {
    const dc = createDiscordAdapter({ restUrl: discord.restUrl, netGuard: local, log: quiet });
    const inbound = [];
    await dc.start({ keys: { discordBot: discord.token }, onInbound: async (m) => inbound.push(m) });
    await waitUntil(() => discord.state.identifies.length === 1 && dc.connected());
    discord.message({ chatId: '700', userId: '42', text: 'hi' });
    discord.message({ chatId: '800', userId: '43', text: 'hi all', guildId: 'G1' });
    discord.press({ chatId: '800', userId: '43', data: gateButtonData('gate-1', 'approve'), guildId: 'G1' });
    await waitUntil(() => inbound.length === 3);
    assert.deepEqual(inbound.map((m) => [m.chatType, m.userId]), [['private', '42'], ['guild', '43'], ['guild', '43']]);
    await dc.stop();
  } finally {
    await discord.close();
  }
});

