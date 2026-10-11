// Regression tests for docs/SECURITY_REVIEW_2026-10-11.md (the phase 4 safety review).
// One block per finding, each reproducing the review's failure scenario; every test here
// failed on 4733a1e / f8bcda6 before its fix. Nothing here weakens a fix from
// docs/SECURITY_REVIEW_2026-10-10.md (test/safety.test.js holds those).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp, readFileSync } from 'node:fs';
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
import { createComputerControl } from '../sidecar/computer/control.js';
import { MAKA_BUNDLE_ID, BROWSER_BUNDLE_IDS, SENSITIVE_APPS, isSensitiveApp, namesLoopback } from '../sidecar/computer/policy.js';
import { startFakeShell } from './helpers/fake-shell.js';

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

// ---------------------------------------------------------------------------------------
// H2: computer control never drives Maka's own window, a browser, or a local web UI.
// ---------------------------------------------------------------------------------------

test('H2: Maka, the browsers and a window naming a loopback host are sensitive in the sidecar policy', () => {
  assert.equal(MAKA_BUNDLE_ID, 'com.makapark.maka');
  assert.ok(SENSITIVE_APPS.bundleIds.includes('com.makapark.maka'));
  assert.ok(SENSITIVE_APPS.names.includes('maka'));
  assert.match(isSensitiveApp({ bundleId: 'com.makapark.maka', name: 'Maka' }).why, /Maka \(com\.makapark\.maka\) is on the list/);
  assert.equal(isSensitiveApp({ bundleId: 'com.makapark.maka.dev', name: '' }).sensitive, true, 'a bundle id under Maka\'s');
  assert.equal(isSensitiveApp({ bundleId: 'com.example.x', name: 'Maka' }).sensitive, true, 'the name alone');
  assert.equal(isSensitiveApp({ bundleId: 'com.example.x', name: 'Makaroni' }).sensitive, false, 'a word inside a word is not a match');
  for (const [id, name] of [['com.apple.Safari', 'Safari'], ['com.google.Chrome', 'Google Chrome'], ['org.mozilla.firefox', 'Firefox'], ['com.microsoft.edgemac', 'Microsoft Edge'], ['com.brave.Browser', 'Brave Browser'], ['company.thebrowser.Browser', 'Arc']]) {
    assert.equal(isSensitiveApp({ bundleId: id, name }).sensitive, true, `${name} is a browser: the web is driven through the browser tools`);
    assert.ok(BROWSER_BUNDLE_IDS.includes(id));
  }
  assert.equal(isSensitiveApp({ bundleId: 'com.apple.Notes', name: 'Notes' }).sensitive, false);
  // The window rule: a title or URL naming a loopback host, or the sidecar's own address.
  assert.equal(namesLoopback('Maka — 127.0.0.1:4777'), '127.0.0.1');
  assert.equal(namesLoopback('http://localhost:4777/park'), 'localhost');
  assert.equal(namesLoopback('http://[::1]:4777/'), '[::1]');
  assert.equal(namesLoopback('http://127.1.2.3/'), '127.1.2.3');
  assert.equal(namesLoopback('http://studio.local/'), 'studio.local');
  assert.equal(namesLoopback('https://example.com/localhosting'), null, 'a word inside a word is not a host');
  assert.equal(namesLoopback('Shopping list'), null);
  assert.equal(namesLoopback('Maka 192.168.1.9:4777', ['192.168.1.9:4777']), '192.168.1.9:4777');
  assert.equal(isSensitiveApp({ bundleId: 'com.apple.Notes', name: 'Notes', window: { title: 'Shopping list', url: '' } }).sensitive, false);
  assert.match(isSensitiveApp({ bundleId: 'com.example.kiosk', name: 'Kiosk', window: { title: 'Gate', url: 'http://127.0.0.1:4777/' } }).why, /url names 127\.0\.0\.1/);
  assert.match(isSensitiveApp({ bundleId: 'com.example.kiosk', name: 'Kiosk', window: { title: 'localhost:3000 — dashboard', url: '' } }).why, /title names localhost/);
  assert.match(isSensitiveApp({ bundleId: 'com.example.kiosk', name: 'Kiosk', window: { title: 'Maka 127.0.0.1:4777' } }, { ownHosts: ['127.0.0.1:4777'] }).why, /names 127\.0\.0\.1/);
  // The shell keeps the same lists (its own lock): the Rust source names Maka and the browsers.
  const rs = readFileSync(new URL('../src-tauri/src/computer_policy.rs', import.meta.url), 'utf8');
  assert.match(rs, /pub const MAKA_BUNDLE_ID: &str = "com\.makapark\.maka"/);
  assert.match(rs, /MAKA_BUNDLE_ID,\s*\n\s*"com\.apple\.Safari"/);
  assert.match(rs, /"maka", "safari", "chrome"/);
  assert.match(rs, /pub fn loopback_window_reason\(/);
  const control = readFileSync(new URL('../src-tauri/src/computer.rs', import.meta.url), 'utf8');
  assert.match(control, /loopback_window_reason\(&app\.window_title, &app\.window_url/);
  assert.match(control, /"window": app\.window_json\(\)/);
});

async function computerHarness(shell) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-safety4-computer-'));
  const bus = createEventBus();
  const events = [];
  bus.listen((e) => events.push(e));
  let t = Date.UTC(2026, 9, 11, 10);
  const clock = { now: () => (t += 1) };
  const workspaceRoot = path.join(dir, 'ws');
  await fsp.mkdir(path.join(workspaceRoot, 'ranger'), { recursive: true });
  const computer = await createComputerControl({ bus, env: shell.env, workspaceRoot, clock, ownHosts: ['127.0.0.1:4777'], log: { error() {} } }).init();
  const actions = () => events.filter((e) => e.type === 'computer.action').map((e) => e.payload);
  return { computer, actions, cleanup: async () => { await computer.close(); await fsp.rm(dir, { recursive: true, force: true }); } };
}

test('H2: with Maka in front the Ranger\'s click hands off and the shell never clicks; a browser in front and a window naming 127.0.0.1 do the same; focus on Maka or a browser is refused before the shell', async () => {
  // The fake shell's own list does not know Maka: the sidecar's policy alone must stop it.
  const shell = await startFakeShell({ sensitiveIds: ['com.apple.Terminal'] });
  const h = await computerHarness(shell);
  try {
    shell.state.frontmost = { bundleId: 'com.makapark.maka', name: 'Maka', pid: 50 };
    const pending = h.computer.act({ agentId: 'ranger', runId: 'run-1', action: 'click', input: { x: 10, y: 10 } });
    const waiting = await waitUntil(() => h.computer.handoffs({ pendingOnly: true })[0]);
    assert.equal(waiting.kind, 'sensitive_app');
    assert.match(waiting.reason, /Maka \(com\.makapark\.maka\) is on the list of apps a Ranger never drives/);
    h.computer.returnHandoff(waiting.handoffId, { notes: 'that was my Gate' });
    await assert.rejects(pending, (e) => e.code === 'SENSITIVE_APP' && /did not run/.test(e.message));
    assert.ok(!shell.state.actions.some((x) => x.action === 'click' || x.action === 'screenshot'), 'no click, no screenshot of Maka');
    assert.equal(h.actions().at(-1).status, 'handoff');
    assert.equal(h.actions().at(-1).app, 'Maka (com.makapark.maka)');
    // The next action in Maka is refused outright.
    await assert.rejects(h.computer.act({ agentId: 'ranger', runId: 'run-1', action: 'locate', input: { query: 'Approve' } }), (e) => e.code === 'SENSITIVE_APP' && /already handled/.test(e.message));
    assert.ok(!shell.state.actions.some((x) => x.action === 'locate'));
    // A browser in front: the same handoff (the web goes through the browser tools).
    shell.state.frontmost = { bundleId: 'com.apple.Safari', name: 'Safari', pid: 60 };
    const p2 = h.computer.act({ agentId: 'ranger', runId: 'run-1', action: 'type', input: { text: 'http://127.0.0.1:4777' } });
    const w2 = await waitUntil(() => h.computer.handoffs({ pendingOnly: true })[0]);
    assert.match(w2.reason, /Safari \(com\.apple\.Safari\) is on the list/);
    h.computer.returnHandoff(w2.handoffId, {});
    await assert.rejects(p2, (e) => e.code === 'SENSITIVE_APP');
    assert.ok(!shell.state.actions.some((x) => x.action === 'type'));
    // An app not on any list whose front window names the sidecar: the window rule.
    shell.state.frontmost = { bundleId: 'com.example.kiosk', name: 'Kiosk', pid: 70 };
    shell.state.window = { title: 'Maka', url: 'http://127.0.0.1:4777/' };
    const p3 = h.computer.act({ agentId: 'ranger', runId: 'run-1', action: 'key', input: { chord: 'return' } });
    const w3 = await waitUntil(() => h.computer.handoffs({ pendingOnly: true })[0]);
    assert.match(w3.reason, /url names 127\.0\.0\.1/);
    h.computer.returnHandoff(w3.handoffId, {});
    await assert.rejects(p3, (e) => e.code === 'SENSITIVE_APP');
    assert.ok(!shell.state.actions.some((x) => x.action === 'key'));
    // The same app with an ordinary window is driven.
    shell.state.window = { title: 'Kiosk — orders', url: 'https://supplier.example/orders' };
    const ok = await h.computer.act({ agentId: 'ranger', runId: 'run-1', action: 'key', input: { chord: 'return' } });
    assert.equal(ok.app, 'Kiosk (com.example.kiosk)');
    assert.ok(shell.state.actions.some((x) => x.action === 'key'));
    // focus on Maka or a browser is refused before the shell hears of it.
    const before = shell.state.actions.length;
    await assert.rejects(h.computer.act({ agentId: 'ranger', runId: 'run-1', action: 'focus', input: { bundleId: 'com.makapark.maka' } }), (e) => e.code === 'BAD_INPUT' && /never brings it to the front/.test(e.message));
    await assert.rejects(h.computer.act({ agentId: 'ranger', runId: 'run-1', action: 'focus', input: { name: 'Google Chrome' } }), (e) => e.code === 'BAD_INPUT');
    assert.ok(!shell.state.actions.slice(before).some((x) => x.action === 'focus'));
  } finally {
    await h.cleanup();
    await shell.close();
  }
});
