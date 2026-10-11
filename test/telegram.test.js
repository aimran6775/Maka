import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNetGuard } from '../sidecar/netguard.js';
import { createTelegramAdapter, TELEGRAM_API, POLL_TIMEOUT_S } from '../sidecar/channels/telegram.js';
import { gateButtonData } from '../sidecar/channels/adapter.js';
import { startFakeTelegram } from './helpers/fake-telegram.js';
import { startTestServer } from './helpers/test-server.js';
import { fakeProvider, text, end, waitUntil } from './helpers/fake-provider.js';

const local = createNetGuard({ allowLocal: true });
const quiet = { warn() {}, error() {} };

test('the Telegram adapter: getMe verifies the token, long polling hands messages and button presses to the registry with the offset advancing, presses are answered, cards carry an inline keyboard, text is plain and clipped', async () => {
  const fake = await startFakeTelegram();
  try {
    const tg = createTelegramAdapter({ baseUrl: fake.url, netGuard: local, pollTimeoutS: 1, log: quiet, sleep: (ms, signal) => new Promise((r) => { const t = setTimeout(r, 5); if (signal) signal.addEventListener('abort', () => { clearTimeout(t); r(); }); }) });
    assert.equal(TELEGRAM_API, 'https://api.telegram.org');
    assert.equal(POLL_TIMEOUT_S, 25);
    const inbound = [];
    const started = await tg.start({ keys: { telegramBot: fake.token }, onInbound: async (m) => inbound.push(m) });
    assert.equal(started.detail, 'long polling as @maka_test_bot');
    assert.equal(fake.state.calls[0].method, 'getMe');
    fake.message({ chatId: 42, text: 'hello' });
    await waitUntil(() => inbound.length === 1);
    assert.deepEqual(inbound[0], { updateId: '1', chatId: '42', userId: '42', chatType: 'private', text: 'hello', messageId: '1' });
    fake.press({ chatId: 42, userId: 7, data: gateButtonData('gate-1', 'approve'), messageId: '501' });
    await waitUntil(() => inbound.length === 2);
    assert.deepEqual(inbound[1], { updateId: '2', chatId: '42', userId: '7', chatType: 'private', callback: { id: 'cb-2', data: 'gate:gate-1:approve', messageId: '501' } });
    await waitUntil(() => fake.state.answered.includes('cb-2'));
    assert.ok(tg.offset() >= 3, 'the offset moves past handled updates');
    const polls = fake.state.calls.filter((c) => c.method === 'getUpdates');
    assert.deepEqual(polls.at(-1).body.allowed_updates, ['message', 'callback_query']);
    assert.ok(polls.every((c) => c.token), 'the token travels in the path only');
    // Updates without a chat (an edited channel post, say) are skipped.
    fake.push({ edited_message: { message_id: 9 } });
    fake.message({ chatId: 42, text: 'after' });
    await waitUntil(() => inbound.length === 3);
    assert.equal(inbound[2].text, 'after');
    // A card: inline keyboard, one row of buttons, the title and lines as the text.
    const card = await tg.sendCard('42', { kind: 'gate_card', itemId: 'gate-1', title: 'Gate: refund $5', lines: ['books · money_out · draft · $5.00'], buttons: [{ label: 'Approve', data: 'gate:gate-1:approve' }, { label: 'Reject', data: 'gate:gate-1:reject' }] });
    assert.equal(card.messageId, '500');
    const sent = fake.sentTo('42').at(-1);
    assert.equal(sent.text, 'Gate: refund $5\nbooks · money_out · draft · $5.00');
    assert.deepEqual(sent.replyMarkup, { inline_keyboard: [[{ text: 'Approve', callback_data: 'gate:gate-1:approve' }, { text: 'Reject', callback_data: 'gate:gate-1:reject' }]] });
    assert.equal(sent.parseMode, null, 'plain text: a Ranger\'s words cannot break the message');
    const long = await tg.sendText('42', 'x'.repeat(5000));
    assert.equal(long.messageId, '501');
    assert.equal(fake.sentTo('42').at(-1).text.length, 4096);
    // Platform refusals are coded without the token in them.
    await assert.rejects(tg.sendText('404', 'hi'), (e) => e.code === 'HTTP_400' && /chat not found/.test(e.message) && !e.message.includes(fake.token));
    // A polling failure backs off and recovers.
    fake.state.fail = { status: 500 };
    await waitUntil(() => fake.state.calls.filter((c) => c.method === 'getUpdates').length > polls.length + 1);
    fake.state.fail = null;
    fake.message({ chatId: 42, text: 'recovered' });
    await waitUntil(() => inbound.length === 4);
    await tg.stop();
    const after = fake.state.calls.length;
    fake.message({ chatId: 42, text: 'late' });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(inbound.length, 4, 'nothing is handled after stop');
    assert.ok(fake.state.calls.length <= after + 1, 'polling stopped');
    await assert.rejects(tg.sendText('42', 'x'), (e) => e.code === 'NOT_STARTED');
  } finally {
    await fake.close();
  }
});

test('a wrong token fails start with UNAUTHORIZED and never leaks; the outbound guard refuses a Bot API host that is not public', async () => {
  const fake = await startFakeTelegram();
  try {
    const tg = createTelegramAdapter({ baseUrl: fake.url, netGuard: local, log: quiet });
    await assert.rejects(tg.start({ keys: { telegramBot: 'wrong:token' }, onInbound: async () => {} }), (e) => e.code === 'UNAUTHORIZED' && /Unauthorized/.test(e.message) && !e.message.includes('wrong:token'));
    const strict = createTelegramAdapter({ baseUrl: fake.url, netGuard: createNetGuard(), log: quiet });
    await assert.rejects(strict.start({ keys: { telegramBot: fake.token }, onInbound: async () => {} }), (e) => e.code === 'NET_GUARD');
    assert.equal(fake.state.calls.filter((c) => c.token).length, 0, 'the guard refused before any request');
  } finally {
    await fake.close();
  }
});

test('through the sidecar with the fake Bot API: TELEGRAM_BOT_TOKEN connects at boot, pairing from the chat, a Gate card with buttons, Approve resolves the item, an unpaired chat is refused, a replayed update id is dropped, Revise takes notes, a question is answered', async () => {
  const fake = await startFakeTelegram();
  const makeProvider = async (name, opts) => {
    if (name === 'anthropic') return { provider: fakeProvider([[text('Nothing has been spent yet: $0.00 of $5.00.'), end()]], { name }), model: opts.model || 'judge', price: { inputPerMTok: 3, outputPerMTok: 15 } };
    return { provider: fakeProvider([[text('worker'), end()]], { name }), model: 'w', price: null };
  };
  const tg = createTelegramAdapter({ baseUrl: fake.url, netGuard: local, pollTimeoutS: 1, log: quiet });
  const srv = await startTestServer({ makeProvider, withChief: true, env: { TELEGRAM_BOT_TOKEN: fake.token, ANTHROPIC_API_KEY: 'sk-test' }, channels: [tg] });
  try {
    const sse = await srv.sse();
    const row = (await srv.get('/api/channels')).body.adapters[0];
    assert.deepEqual([row.name, row.status, row.by, row.detail], ['telegram', 'up', 'env', 'long polling as @maka_test_bot']);
    const code = (await srv.post('/api/channels/pair', {})).body.code;
    fake.message({ chatId: 42, userId: 42, text: code });
    await sse.waitFor((e) => e.type === 'channel.inbound' && e.payload.outcome === 'paired');
    await waitUntil(() => fake.sentTo('42').some((m) => /Paired with the Mountain Peak/.test(m.text)));
    // A Gate item from a run: the card reaches the phone with buttons; Approve from the phone resolves it.
    const decided = srv.gateQueue.submit({ agentId: 'ranger', domain: 'money_out', tool: 'stripe.refund', summary: 'refund ch_9 $4.00', runId: 'run-x', callId: 'c1', level: 'draft', amountUsd: 4 });
    const itemId = srv.gateQueue.pending()[0].itemId;
    await waitUntil(() => fake.sentTo('42').some((m) => m.replyMarkup && m.text.startsWith('Gate: refund ch_9')));
    const card = fake.sentTo('42').find((m) => m.replyMarkup);
    assert.deepEqual(card.replyMarkup.inline_keyboard[0].map((b) => b.callback_data), [`gate:${itemId}:approve`, `gate:${itemId}:revise`, `gate:${itemId}:reject`]);
    // An unpaired chat pressing Approve on a forwarded card: refused and logged, the item still waits.
    const strangerUpdate = fake.press({ chatId: 99, userId: 99, data: `gate:${itemId}:approve`, messageId: card.messageId });
    const refused = await sse.waitFor((e) => e.type === 'channel.inbound' && e.payload.chatId === '99');
    assert.deepEqual([refused.payload.paired, refused.payload.outcome, refused.payload.itemId], [false, 'refused: not paired', itemId]);
    assert.equal(srv.gateQueue.get(itemId).status, 'pending');
    await waitUntil(() => fake.sentTo('99').some((m) => /not paired/.test(m.text)));
    // The owner approves; a replay of the same update id does nothing more.
    const approveUpdate = fake.press({ chatId: 42, userId: 42, data: `gate:${itemId}:approve`, messageId: card.messageId });
    const d = await decided;
    assert.equal(d.decision, 'approve');
    const accepted = await sse.waitFor((e) => e.type === 'channel.inbound' && e.payload.outcome === 'accepted');
    assert.equal(accepted.payload.itemId, itemId);
    await waitUntil(() => fake.sentTo('42').some((m) => /^Approved: refund ch_9/.test(m.text)));
    const inboundBefore = sse.events.filter((e) => e.type === 'channel.inbound').length;
    fake.push({ update_id: approveUpdate, callback_query: { id: 'cb-replay', from: { id: 42 }, message: { message_id: Number(card.messageId), chat: { id: 42 } }, data: `gate:${itemId}:approve` } });
    fake.message({ chatId: 42, userId: 42, text: '/status' });
    await sse.waitFor((e) => e.type === 'channel.inbound' && e.payload.action === 'command');
    assert.equal(sse.events.filter((e) => e.type === 'channel.inbound').length, inboundBefore + 1, 'the replayed press was dropped; only /status arrived');
    assert.ok(strangerUpdate < approveUpdate);
    // Revise: the button asks for notes; the next message carries them.
    const revised = srv.gateQueue.submit({ agentId: 'ranger', domain: 'publishing', tool: 'mail.send', summary: 'campaign to 12 subscribers', runId: 'run-y', callId: 'c2', level: 'draft' });
    const item2 = srv.gateQueue.pending()[0].itemId;
    await waitUntil(() => fake.sentTo('42').some((m) => m.replyMarkup && m.text.startsWith('Gate: campaign')));
    fake.press({ chatId: 42, userId: 42, data: `gate:${item2}:revise`, messageId: '600' });
    await waitUntil(() => fake.sentTo('42').some((m) => /reply with your notes/.test(m.text)));
    fake.message({ chatId: 42, userId: 42, text: 'drop the discount line' });
    const d2 = await revised;
    assert.deepEqual([d2.decision, d2.notes], ['revise', 'drop the discount line']);
    // A question for the Peak.
    fake.message({ chatId: 42, userId: 42, text: 'what did we spend?' });
    const answered = await sse.waitFor((e) => e.type === 'channel.delivery' && e.payload.kind === 'answer', 10000);
    assert.equal(answered.payload.status, 'sent');
    await waitUntil(() => fake.sentTo('42').some((m) => /^Nothing has been spent yet/.test(m.text)));
    assert.match(fake.sentTo('42').at(-1).text, /Evidence: run run-/);
    // Nothing anywhere carries the token.
    const dump = JSON.stringify(sse.events) + JSON.stringify((await srv.get('/api/state')).body.channels);
    assert.equal(dump.includes(fake.token), false);
    sse.close();
  } finally {
    await srv.close();
    await fake.close();
  }
});
