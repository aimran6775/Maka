import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNetGuard } from '../sidecar/netguard.js';
import { createDiscordAdapter, DISCORD_API, INTENT_DIRECT_MESSAGES } from '../sidecar/channels/discord.js';
import { createSlackAdapter, SLACK_API } from '../sidecar/channels/slack.js';
import { openGuardedSocket, backoffAt } from '../sidecar/channels/ws.js';
import { gateButtonData, gateCard } from '../sidecar/channels/adapter.js';
import { startFakeDiscord } from './helpers/fake-discord.js';
import { startFakeSlack } from './helpers/fake-slack.js';
import { startTestServer } from './helpers/test-server.js';
import { fakeProvider, text, end, waitUntil } from './helpers/fake-provider.js';

const local = createNetGuard({ allowLocal: true });
const quiet = { warn() {}, error() {} };

test('the guarded socket: a non-public gateway is refused before it opens, ws(s) only, JSON frames both ways, backoff steps', async () => {
  const fake = await startFakeSlack();
  try {
    await assert.rejects(openGuardedSocket(fake.wsUrl, { netGuard: createNetGuard(), onMessage() {} }), (e) => e.code === 'NET_GUARD');
    await assert.rejects(openGuardedSocket(fake.httpUrl, { netGuard: local, onMessage() {} }), (e) => e.code === 'BAD_SCHEME');
    await assert.rejects(openGuardedSocket(fake.wsUrl, { netGuard: local, WebSocketImpl: null, onMessage() {} }), (e) => e.code === 'NO_WEBSOCKET');
    const got = [];
    const ws = await openGuardedSocket(fake.wsUrl, { netGuard: local, onMessage: (m) => got.push(m) });
    await waitUntil(() => got.length === 1);
    assert.equal(got[0].type, 'hello');
    ws.send({ envelope_id: 'x' });
    await waitUntil(() => fake.state.acks.includes('x'));
    const closed = await ws.close();
    assert.equal(ws.closed, true);
    assert.ok(closed.code === 1000 || closed.code === 1005);
    assert.throws(() => ws.send({}), (e) => e.code === 'WS_CLOSED');
    assert.deepEqual([backoffAt(0), backoffAt(1), backoffAt(3), backoffAt(99)], [1000, 1000, 5000, 30000]);
  } finally {
    await fake.close();
  }
});

test('Discord: token verified, gateway through the guard, DM intent only, heartbeats, messages and button presses in (presses acknowledged, bots skipped), cards with one action row, plain clipped text, reconnect on RECONNECT, coded errors without the token', async () => {
  const fake = await startFakeDiscord();
  try {
    assert.equal(DISCORD_API, 'https://discord.com/api/v10');
    const dc = createDiscordAdapter({ restUrl: fake.restUrl, netGuard: local, log: quiet });
    const inbound = [];
    const started = await dc.start({ keys: { discordBot: fake.token }, onInbound: async (m) => inbound.push(m) });
    assert.equal(started.detail, 'gateway as maka-bot (DMs only)');
    assert.deepEqual(fake.state.calls.slice(0, 2).map((c) => [c.path, c.authed]), [['/api/v10/users/@me', true], ['/api/v10/gateway/bot', true]]);
    await waitUntil(() => fake.state.identifies.length === 1);
    assert.equal(fake.state.identifies[0].intents, INTENT_DIRECT_MESSAGES);
    assert.equal(fake.state.identifies[0].token, fake.token);
    await waitUntil(() => dc.connected());
    await waitUntil(() => fake.state.heartbeats >= 1, { timeoutMs: 3000 });
    fake.message({ chatId: '700', userId: '42', text: 'hi there' });
    await waitUntil(() => inbound.length === 1);
    assert.deepEqual(inbound[0], { updateId: 'm-1', chatId: '700', userId: '42', chatType: 'private', text: 'hi there', messageId: 'm-1' });
    fake.botMessage({ chatId: '700', text: 'echo' });
    const iid = fake.press({ chatId: '700', userId: '42', data: gateButtonData('gate-1', 'reject'), messageId: '9000' });
    await waitUntil(() => inbound.length === 2);
    assert.deepEqual(inbound[1], { updateId: iid, chatId: '700', userId: '42', chatType: 'private', callback: { id: iid, data: 'gate:gate-1:reject', messageId: '9000' } });
    await waitUntil(() => fake.state.acks.some((a) => a.id === iid && a.type === 6));
    // A card and a text.
    const card = await dc.sendCard('700', gateCard({ itemId: 'gate-1', agentId: 'books', kind: 'action', domain: 'money_out', tool: 'stripe.refund', summary: 'refund $5', level: 'draft', amountUsd: 5 }));
    assert.equal(card.messageId, '9000');
    const sent = fake.sentTo('700')[0];
    assert.match(sent.content, /^Gate: refund \$5\nbooks · money_out · draft · \$5\.00$/);
    assert.deepEqual(sent.components[0].components.map((b) => [b.type, b.style, b.label, b.custom_id]), [[2, 3, 'Approve', 'gate:gate-1:approve'], [2, 1, 'Revise', 'gate:gate-1:revise'], [2, 4, 'Reject', 'gate:gate-1:reject']]);
    await dc.sendText('700', 'y'.repeat(2500));
    assert.equal(fake.sentTo('700').at(-1).content.length, 2000);
    await assert.rejects(dc.sendText('404', 'x'), (e) => e.code === 'HTTP_404' && /Unknown Channel/.test(e.message) && !e.message.includes(fake.token));
    // RECONNECT from the gateway: the socket is reopened and identifies again.
    fake.reconnectAll();
    await waitUntil(() => fake.state.identifies.length === 2, { timeoutMs: 5000 });
    await waitUntil(() => dc.connected());
    fake.message({ chatId: '700', userId: '42', text: 'after reconnect' });
    await waitUntil(() => inbound.length === 3);
    await dc.stop();
    assert.equal(dc.connected(), false);
    await assert.rejects(dc.sendText('700', 'x'), (e) => e.code === 'NOT_STARTED');
    // A wrong token fails start plainly; a strict guard refuses the local fake before any request.
    await assert.rejects(dc.start({ keys: { discordBot: 'nope' }, onInbound: async () => {} }), (e) => e.code === 'UNAUTHORIZED' && !e.message.includes('nope'));
    const strict = createDiscordAdapter({ restUrl: fake.restUrl, netGuard: createNetGuard(), log: quiet });
    const before = fake.state.calls.length;
    await assert.rejects(strict.start({ keys: { discordBot: fake.token }, onInbound: async () => {} }), (e) => e.code === 'NET_GUARD');
    assert.equal(fake.state.calls.length, before);
  } finally {
    await fake.close();
  }
});

test('Slack: the bot token signs the Web API and the app token opens Socket Mode, envelopes acknowledged, human messages and block_actions in (bots and subtypes skipped), cards as plain_text blocks with an actions row, mrkdwn off, reconnect on disconnect, coded errors', async () => {
  const fake = await startFakeSlack();
  try {
    assert.equal(SLACK_API, 'https://slack.com/api');
    const sl = createSlackAdapter({ apiUrl: fake.apiUrl, netGuard: local, log: quiet });
    const inbound = [];
    const started = await sl.start({ keys: { slackBot: fake.botToken, slackApp: fake.appToken }, onInbound: async (m) => inbound.push(m) });
    assert.equal(started.detail, 'socket mode as maka in Maka');
    assert.deepEqual(fake.state.calls.map((c) => [c.method, c.bearer]), [['auth.test', 'bot'], ['apps.connections.open', 'app']]);
    await waitUntil(() => sl.connected());
    const env1 = fake.message({ chatId: 'D123', userId: 'U77', text: 'hello' });
    await waitUntil(() => inbound.length === 1);
    assert.ok(fake.state.acks.includes(env1), 'every envelope is acknowledged');
    assert.deepEqual([inbound[0].chatId, inbound[0].userId, inbound[0].text, inbound[0].updateId], ['D123', 'U77', 'hello', 'cm-1']);
    const envBot = fake.botMessage({ chatId: 'D123', text: 'echo' });
    await waitUntil(() => fake.state.acks.includes(envBot));
    assert.equal(inbound.length, 1, 'the bot\'s own message is skipped');
    const envPress = fake.press({ chatId: 'D123', userId: 'U77', data: gateButtonData('gate-2', 'approve'), messageTs: '1700000000.0005' });
    await waitUntil(() => inbound.length === 2);
    assert.deepEqual(inbound[1], { updateId: envPress, chatId: 'D123', userId: 'U77', chatType: 'private', callback: { id: envPress, data: 'gate:gate-2:approve', messageId: '1700000000.0005' } });
    // A card and a text.
    const card = await sl.sendCard('D123', gateCard({ itemId: 'gate-2', agentId: 'books', kind: 'action', domain: 'money_out', tool: 'stripe.refund', summary: 'refund $5', level: 'draft', amountUsd: 5 }));
    assert.match(card.messageId, /^\d+\.\d{4}$/);
    const sent = fake.sentTo('D123')[0];
    assert.equal(sent.mrkdwn, false);
    assert.match(sent.text, /Reply: \/approve gate-2/);
    assert.deepEqual(sent.blocks.map((b) => b.type), ['section', 'section', 'actions']);
    assert.equal(sent.blocks[0].text.type, 'plain_text');
    assert.deepEqual(sent.blocks[2].elements.map((b) => [b.text.text, b.value, b.style || null]), [['Approve', 'gate:gate-2:approve', 'primary'], ['Revise', 'gate:gate-2:revise', null], ['Reject', 'gate:gate-2:reject', 'danger']]);
    await sl.sendText('D123', 'plain');
    assert.deepEqual([fake.sentTo('D123').at(-1).text, fake.sentTo('D123').at(-1).mrkdwn, fake.sentTo('D123').at(-1).blocks], ['plain', false, null]);
    await assert.rejects(sl.sendText('C404', 'x'), (e) => e.code === 'SLACK_CHANNEL_NOT_FOUND');
    // Slack asks to reconnect: a new connection is opened.
    fake.disconnectAll();
    await waitUntil(() => fake.state.opens === 2, { timeoutMs: 5000 });
    await waitUntil(() => sl.connected());
    fake.message({ chatId: 'D123', userId: 'U77', text: 'after' });
    await waitUntil(() => inbound.length === 3);
    await sl.stop();
    assert.equal(sl.connected(), false);
    await assert.rejects(sl.start({ keys: { slackBot: 'xoxb-wrong', slackApp: fake.appToken }, onInbound: async () => {} }), (e) => e.code === 'UNAUTHORIZED');
    await assert.rejects(sl.start({ keys: { slackBot: fake.botToken, slackApp: 'xapp-wrong' }, onInbound: async () => {} }), (e) => e.code === 'UNAUTHORIZED');
    const strict = createSlackAdapter({ apiUrl: fake.apiUrl, netGuard: createNetGuard(), log: quiet });
    await assert.rejects(strict.start({ keys: { slackBot: fake.botToken, slackApp: fake.appToken }, onInbound: async () => {} }), (e) => e.code === 'NET_GUARD');
  } finally {
    await fake.close();
  }
});

test('through the sidecar: Discord and Slack register beside Telegram; Slack needs both tokens; a Gate item reaches a paired Discord DM and a paired Slack channel, each decides its own; the Peak lists every channel with its pairing state', async () => {
  const discord = await startFakeDiscord();
  const slack = await startFakeSlack();
  const makeProvider = async (name) => ({ provider: fakeProvider([[text('worker'), end()]], { name }), model: 'w', price: null });
  const dc = createDiscordAdapter({ restUrl: discord.restUrl, netGuard: local, log: quiet });
  const sl = createSlackAdapter({ apiUrl: slack.apiUrl, netGuard: local, log: quiet });
  const srv = await startTestServer({ makeProvider, withChief: true, env: { DISCORD_BOT_TOKEN: discord.token, SLACK_BOT_TOKEN: slack.botToken }, channels: [dc, sl] });
  try {
    const sse = await srv.sse();
    let rows = (await srv.get('/api/channels')).body.adapters;
    assert.deepEqual(rows.map((r) => [r.name, r.status]), [['discord', 'up'], ['slack', 'not_wired']]);
    assert.deepEqual(rows[1].missing, ['SLACK_APP_TOKEN'], 'Slack without the app token is not wired and says which');
    assert.equal((await srv.post('/api/channels/slack/connect', { token: 'x' })).status, 400, 'two-token channels take their tokens from the environment or the keystore');
    // Pair a Discord DM.
    const code = (await srv.post('/api/channels/pair', {})).body.code;
    await waitUntil(() => dc.connected());
    discord.message({ chatId: '700', userId: '42', text: code });
    await sse.waitFor((e) => e.type === 'channel.inbound' && e.payload.outcome === 'paired');
    await waitUntil(() => discord.sentTo('700').some((m) => /Paired with the Mountain Peak/.test(m.content)));
    // A Gate item: the card reaches Discord with buttons; Approve from the DM resolves it.
    const decided = srv.gateQueue.submit({ agentId: 'ranger', domain: 'publishing', tool: 'mail.send', summary: 'campaign to 9', runId: 'run-a', callId: 'c1', level: 'draft' });
    const itemId = srv.gateQueue.pending()[0].itemId;
    await waitUntil(() => discord.sentTo('700').some((m) => m.components && m.content.startsWith('Gate: campaign')));
    const card = discord.sentTo('700').find((m) => m.components);
    discord.press({ chatId: '700', userId: '42', data: `gate:${itemId}:approve`, messageId: card.id });
    const d = await decided;
    assert.equal(d.decision, 'approve');
    await waitUntil(() => discord.sentTo('700').some((m) => /^Approved: campaign to 9/.test(m.content)));
    rows = (await srv.get('/api/state')).body.channels.adapters;
    assert.deepEqual(rows[0].paired.map((c) => [c.chatId, c.userId]), [['700', '42']]);
    assert.equal(rows[0].detail, 'gateway as maka-bot (DMs only)');
    sse.close();
  } finally {
    await srv.close();
    await discord.close();
    await slack.close();
  }
  // Slack with both tokens, through the sidecar.
  const slack2 = await startFakeSlack();
  const sl2 = createSlackAdapter({ apiUrl: slack2.apiUrl, netGuard: local, log: quiet });
  const srv2 = await startTestServer({ makeProvider, withChief: true, env: { SLACK_BOT_TOKEN: slack2.botToken, SLACK_APP_TOKEN: slack2.appToken }, channels: [sl2] });
  try {
    const sse = await srv2.sse();
    const row = (await srv2.get('/api/channels')).body.adapters[0];
    assert.deepEqual([row.name, row.status, row.by, row.detail], ['slack', 'up', 'env', 'socket mode as maka in Maka']);
    const code = (await srv2.post('/api/channels/pair', {})).body.code;
    await waitUntil(() => sl2.connected());
    slack2.message({ chatId: 'D9', userId: 'U1', text: code });
    await sse.waitFor((e) => e.type === 'channel.inbound' && e.payload.outcome === 'paired');
    const decided = srv2.gateQueue.submit({ agentId: 'ranger', domain: 'money_out', tool: 'stripe.refund', summary: 'refund $2', runId: 'run-b', callId: 'c2', level: 'draft', amountUsd: 2 });
    const itemId = srv2.gateQueue.pending()[0].itemId;
    await waitUntil(() => slack2.sentTo('D9').some((m) => m.blocks && /refund \$2/.test(m.text)));
    slack2.press({ chatId: 'D9', userId: 'U1', data: `gate:${itemId}:reject`, messageTs: slack2.sentTo('D9').at(-1).ts });
    const d = await decided;
    assert.equal(d.decision, 'reject');
    await waitUntil(() => slack2.sentTo('D9').some((m) => /^Rejected: refund \$2/.test(m.text)));
    // An unpaired Slack channel pressing a button is refused.
    slack2.press({ chatId: 'D-other', userId: 'U2', data: `gate:${itemId}:approve` });
    const refused = await sse.waitFor((e) => e.type === 'channel.inbound' && e.payload.chatId === 'D-other');
    assert.equal(refused.payload.outcome, 'refused: not paired');
    sse.close();
  } finally {
    await srv2.close();
    await slack2.close();
  }
});
