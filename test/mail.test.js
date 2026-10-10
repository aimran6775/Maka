import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createStore } from '../sidecar/store.js';
import { createEventBus } from '../sidecar/bus.js';
import { createMailStore, normalizeAddress, addressList } from '../sidecar/mail/store.js';
import { createAddresses, STATION_LOCALS } from '../sidecar/mail/addresses.js';
import { createResendMail, createMailSync, verifyWebhook, signWebhook, unsubscribeFooter } from '../sidecar/mail/resend.js';
import { createMailSystem, MAIL_SYNC_JOB_ID } from '../sidecar/mail/system.js';
import { createScheduler } from '../sidecar/scheduler.js';
import { startFakeResend } from './helpers/fake-resend.js';
import { defaultLayout } from '../shared/world.js';
import { fakeClock } from './helpers/fake-provider.js';

const D = 'makapark.com';

async function setup() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-mail-'));
  const store = createStore({ root: path.join(dir, 'home') });
  await store.init();
  const bus = createEventBus();
  const events = [];
  bus.listen((e) => events.push(e));
  const clock = fakeClock(1_700_000_000_000);
  const mailStore = await createMailStore({ root: path.join(dir, 'mail'), clock }).init();
  const addresses = await createAddresses({ store, bus, domain: D, clock }).init();
  return { dir, store, bus, events, clock, mailStore, addresses, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

function layoutWithCamps() {
  const layout = defaultLayout();
  layout.rooms.push({ id: 'mountain-peak', name: 'Peak', kind: 'mountain_peak', x: 0, y: 0, w: 2, h: 2 });
  layout.rooms.push({ id: 'visitor-center', name: 'Visitor Center', kind: 'visitor_center', x: 21, y: 1, w: 8, h: 6 });
  layout.rooms.push({ id: 'ops', name: 'Support', kind: 'operations_support', x: 31, y: 1, w: 8, h: 6 });
  return layout;
}

test('helpers: address normalisation and lists', () => {
  assert.equal(normalizeAddress('Ada <Ada@MakaPark.com>'), 'ada@makapark.com');
  assert.equal(normalizeAddress(''), '');
  assert.deepEqual(addressList('a@x, b@y'), ['a@x', 'b@y']);
  assert.deepEqual(addressList(['a@x']), ['a@x']);
  assert.deepEqual(addressList(null), []);
  assert.match(unsubscribeFooter('unsubscribe@x'), /reply with UNSUBSCRIBE/);
});

test('mail store: add with threading, list / threads / search, labels, status, suppression, cursor, persistence', async () => {
  const h = await setup();
  try {
    const m1 = await h.mailStore.add({ direction: 'in', from: 'Buyer <buyer@example.com>', to: ['sales@makapark.com'], subject: 'Lanterns?', text: 'Do you ship to Spain?', messageId: '<a1@example.com>', station: 'sales', venture: 'lantern-co', resendId: 'rcv_1' });
    assert.match(m1.id, /^msg-/);
    assert.equal(m1.threadId, `thread-${m1.id.slice(4)}`);
    const m2 = await h.mailStore.add({ direction: 'out', from: 'sales@makapark.com', to: ['buyer@example.com'], subject: 'Re: Lanterns?', text: 'Yes we do.', inReplyTo: '<a1@example.com>', station: 'sales', venture: 'lantern-co', agentId: 'ben', resendId: 'em_1', kind: 'reply' });
    assert.equal(m2.threadId, m1.threadId, 'In-Reply-To joins the thread');
    const m3 = await h.mailStore.add({ direction: 'in', from: 'buyer@example.com', to: ['sales@makapark.com'], subject: 'Re: Lanterns?', text: 'Great, thanks', references: '<a1@example.com> <b2@makapark.com>', messageId: '<c3@example.com>', station: 'sales', venture: 'lantern-co', resendId: 'rcv_2' });
    assert.equal(m3.threadId, m1.threadId, 'References join the thread');
    await h.mailStore.add({ direction: 'in', from: 's@example.com', to: ['visitors@makapark.com'], subject: 'Hello?', text: 'anyone', station: 'visitor-center', labels: ['triage'], resendId: 'rcv_3' });
    await assert.rejects(h.mailStore.add({ direction: 'in', from: 'x', to: ['y'], subject: 'dup', station: 'sales', resendId: 'rcv_1' }), /already stored/);
    await assert.rejects(h.mailStore.add({ direction: 'up', station: 'sales' }), /direction/);
    assert.equal(h.mailStore.list({ station: 'sales' }).length, 3);
    assert.equal(h.mailStore.list({ station: 'sales', direction: 'out' })[0].id, m2.id);
    assert.equal(h.mailStore.list({ venture: 'lantern-co', agentId: 'ben' }).length, 1);
    const threads = h.mailStore.threads({ station: 'sales' });
    assert.equal(threads.length, 1);
    assert.deepEqual([threads[0].count, threads[0].unread, threads[0].lastDirection], [3, 2, 'in']);
    assert.deepEqual(threads[0].participants.sort(), ['buyer@example.com', 'sales@makapark.com']);
    assert.equal((await h.mailStore.thread(m1.threadId)).length, 3);
    assert.deepEqual(h.mailStore.search('spain').map((m) => m.id), [m1.id]);
    assert.deepEqual(await h.mailStore.setLabels(m1.id, { add: ['read', 'customer'] }), ['read', 'customer']);
    assert.equal(h.mailStore.threads({ station: 'sales' })[0].unread, 1);
    await h.mailStore.setClassification(m1.id, 'customer');
    assert.equal((await h.mailStore.get(m1.id)).classification, 'customer');
    assert.equal((await h.mailStore.setStatus({ resendId: 'em_1', status: 'delivered', event: 'delivered' })).status, 'delivered');
    assert.equal((await h.mailStore.get(m2.id)).events[0].event, 'delivered');
    assert.equal(await h.mailStore.setStatus({ resendId: 'nope', status: 'x' }), null);
    await h.mailStore.suppress('Gone <GONE@example.com>', 'bounced');
    assert.equal(h.mailStore.isSuppressed('gone@example.com'), true);
    assert.equal(h.mailStore.suppressions()[0].reason, 'bounced');
    assert.equal(await h.mailStore.unsuppress('gone@example.com'), true);
    assert.equal(h.mailStore.isSuppressed('gone@example.com'), false);
    await h.mailStore.setCursor('rcv_3');
    assert.equal(h.mailStore.cursor().received, 'rcv_3');
    const counts = h.mailStore.counts();
    assert.equal(counts.messages, 4);
    assert.deepEqual(counts.byStation.sales, { in: 2, out: 1 });
    await h.mailStore.flushed();
    const again = await createMailStore({ root: h.mailStore.root }).init();
    assert.equal(again.list({ station: 'sales' }).length, 3);
    assert.equal(again.cursor().received, 'rcv_3');
    assert.equal(again.byMessageId('<c3@example.com>').id, m3.id);
    assert.ok((await fsp.stat(path.join(h.mailStore.messagesDir, `${m1.id}.json`))).isFile());
  } finally {
    await h.cleanup();
  }
});

test('addresses: station rules from the layout, gate@ and unsubscribe@, aliases, resolution with the visitors@ fallback, events, persistence', async () => {
  const h = await setup();
  try {
    assert.equal(STATION_LOCALS.operations_support, 'support');
    const created = await h.addresses.ensureStations(layoutWithCamps());
    assert.deepEqual(created.map((r) => r.local).sort(), ['gate', 'peak', 'rangers', 'support', 'unsubscribe', 'visitors']);
    assert.equal(h.addresses.get('support@makapark.com').station, 'ops');
    assert.equal(h.addresses.get('gate@makapark.com').station, 'entrance-gate');
    assert.equal(h.addresses.get('unsubscribe@makapark.com').kind, 'system');
    assert.deepEqual(await h.addresses.ensureStations(layoutWithCamps()), [], 'idempotent');
    assert.equal(h.events.filter((e) => e.type === 'mail.address').length, 6);
    const alias = await h.addresses.createAlias({ local: 'Support-Lantern-Co', agentId: 'ada', venture: 'lantern-co', station: 'ops' }, { by: 'chief-ranger' });
    assert.equal(alias.address, 'support-lantern-co@makapark.com');
    assert.equal(h.events.at(-1).payload.venture, 'lantern-co');
    await assert.rejects(h.addresses.createAlias({ local: 'support-lantern-co', station: 'ops' }), /already exists/);
    await assert.rejects(h.addresses.createAlias({ local: 'no spaces', station: 'ops' }), /local part/);
    await assert.rejects(h.addresses.createAlias({ local: 'x' }), /needs the station/);
    assert.deepEqual(h.addresses.resolve('SUPPORT-LANTERN-CO@makapark.com').agentId, 'ada');
    const fb = h.addresses.resolve('whoever@makapark.com');
    assert.deepEqual([fb.local, fb.fallback], ['visitors', true]);
    assert.deepEqual(h.addresses.forAgent('ada', 'ops').map((r) => r.local).sort(), ['support', 'support-lantern-co']);
    assert.equal(h.addresses.forStation('ops').length, 2);
    await assert.rejects(h.addresses.remove('support@makapark.com'), /stays/);
    await assert.rejects(h.addresses.remove('nobody@makapark.com'), (e) => e.status === 404);
    await h.addresses.remove(alias.address);
    assert.equal(h.events.at(-1).payload.change, 'removed');
    await h.addresses.flushed();
    const again = await createAddresses({ store: h.store, bus: h.bus, domain: D }).init();
    assert.equal(again.list().length, 6);
  } finally {
    await h.cleanup();
  }
});

test('webhook verification: svix headers, HMAC over id.timestamp.body, tolerance, bad signatures', () => {
  const secret = 'whsec_' + Buffer.from('a-secret-of-some-length').toString('base64');
  const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'em_1' } });
  const now = 1_700_000_000_000;
  const headers = signWebhook({ secret, body, id: 'msg_1', timestamp: Math.floor(now / 1000) });
  assert.equal(verifyWebhook({ secret, headers, body, now }).type, 'email.delivered');
  assert.equal(verifyWebhook({ secret, headers: { ...headers, 'svix-signature': `v1,nope ${headers['svix-signature']}` }, body, now }).type, 'email.delivered', 'any matching signature in the list passes');
  assert.throws(() => verifyWebhook({ secret, headers, body: body + ' ', now }), /mismatch/);
  assert.throws(() => verifyWebhook({ secret: 'whsec_' + Buffer.from('other').toString('base64'), headers, body, now }), /mismatch/);
  assert.throws(() => verifyWebhook({ secret, headers, body, now: now + 10 * 60_000 }), /tolerance/);
  assert.throws(() => verifyWebhook({ secret, headers: {}, body, now }), /missing svix/);
  assert.throws(() => verifyWebhook({ secret: null, headers, body, now }), (e) => e.code === 'NO_SECRET');
  assert.throws(() => verifyWebhook({ secret, headers: signWebhook({ secret, body: 'not json', id: 'm', timestamp: Math.floor(now / 1000) }), body: 'not json', now }), /not JSON/);
});

test('sync against the fake: poll ingests after the cursor with routing, attachments and unsubscribe; webhook received and delivery events; sends with suppression, threading and campaign footer; status refresh', async () => {
  const rs = await startFakeResend();
  const h = await setup();
  try {
    await h.addresses.ensureStations(layoutWithCamps());
    await h.addresses.createAlias({ local: 'support-lantern-co', agentId: 'ada', venture: 'lantern-co', station: 'ops' }, { by: 'chief-ranger' });
    const resend = createResendMail({ apiKey: rs.apiKey, fetch, baseUrl: rs.url });
    const secret = 'whsec_' + Buffer.from('a-secret-of-some-length').toString('base64');
    const sync = createMailSync({ store: h.mailStore, addresses: h.addresses, getResend: async () => resend, bus: h.bus, clock: h.clock, domain: D, webhookSecret: secret, attachmentsLimit: 1000, log: { error() {} } });
    rs.receive({ id: 'rcv_1', from: 'Buyer <buyer@example.com>', to: ['support-lantern-co@makapark.com'], subject: 'Broken lantern', text: 'It arrived broken.', createdAt: '2026-10-10T10:00:00.000Z', attachments: [{ id: 'att1', filename: 'photo.jpg', content_type: 'image/jpeg', size: 5 }, { id: 'att2', filename: '../big.bin', content_type: 'application/octet-stream', size: 5000 }] }, { att1: 'JPEG!', att2: 'x' });
    rs.receive({ id: 'rcv_2', from: 'Stranger <s@example.com>', to: ['random@makapark.com'], subject: 'Hi', text: 'hello', createdAt: '2026-10-10T10:01:00.000Z' });
    rs.receive({ id: 'rcv_3', from: 'Tired <tired@example.com>', to: ['unsubscribe@makapark.com'], subject: 'unsubscribe', text: 'stop', createdAt: '2026-10-10T10:02:00.000Z' });
    const r1 = await sync.poll();
    assert.equal(r1.received, 3);
    assert.equal(h.mailStore.cursor().received, 'rcv_3', 'cursor at the newest');
    const broken = (await h.mailStore.get(h.mailStore.byResendId('rcv_1').id));
    assert.deepEqual([broken.station, broken.venture, broken.agentId, broken.kind], ['ops', 'lantern-co', 'ada', 'inbound']);
    assert.equal(broken.attachments[0].path, path.join('attachments', broken.id, 'photo.jpg'));
    assert.equal(await fsp.readFile(path.join(h.mailStore.root, broken.attachments[0].path), 'utf8'), 'JPEG!');
    assert.match(broken.attachments[1].problem, /limit 1000/);
    assert.equal(broken.attachments[1].path, null);
    const stranger = h.mailStore.byResendId('rcv_2');
    assert.deepEqual([stranger.station, stranger.labels], ['visitor-center', ['triage']]);
    assert.equal(h.mailStore.isSuppressed('tired@example.com'), true, 'unsubscribe@ suppresses the sender');
    assert.equal(h.mailStore.byResendId('rcv_3').kind, 'unsubscribe');
    assert.equal(h.events.filter((e) => e.type === 'mail.message' && e.payload.direction === 'in').length, 3);
    assert.deepEqual(await sync.poll(), { received: 0 }, 'nothing new after the cursor');
    rs.receive({ id: 'rcv_4', from: 'buyer@example.com', to: ['support@makapark.com'], subject: 'Again', text: 'more', createdAt: '2026-10-10T10:03:00.000Z' });
    assert.equal((await sync.poll()).received, 1);
    assert.equal(sync.state().received, 4);

    // Webhook: received → fetched and stored once; delivery events → status + suppression.
    rs.receive({ id: 'rcv_5', from: 'hook@example.com', to: ['visitors@makapark.com'], subject: 'via webhook', text: 'instant', createdAt: '2026-10-10T10:04:00.000Z' });
    const whBody = JSON.stringify({ type: 'email.received', created_at: 'x', data: { email_id: 'rcv_5', from: 'hook@example.com', to: ['visitors@makapark.com'], subject: 'via webhook' } });
    const r = await sync.handleWebhook({ headers: signWebhook({ secret, body: whBody, timestamp: Math.floor(h.clock.now() / 1000) }), rawBody: whBody });
    assert.equal(r.stored, true);
    const dup = await sync.handleWebhook({ headers: signWebhook({ secret, body: whBody, timestamp: Math.floor(h.clock.now() / 1000) }), rawBody: whBody });
    assert.equal(dup.stored, false, 'a webhook replay stores nothing twice');
    assert.equal((await sync.poll()).received, 0, 'the poll does not re-ingest what the webhook stored');
    const ignored = await sync.handleWebhook({ headers: signWebhook({ secret, body: '{"type":"domain.created"}', timestamp: Math.floor(h.clock.now() / 1000) }), rawBody: '{"type":"domain.created"}' });
    assert.equal(ignored.ignored, true);

    // Send: a reply keeps the thread; a suppressed recipient is dropped; a campaign gets the footer.
    const reply = await sync.send({ from: 'support-lantern-co@makapark.com', to: 'buyer@example.com', subject: 'Re: Broken lantern', text: 'Sorry, a replacement is on its way.', inReplyTo: broken.messageId, kind: 'reply', station: 'ops', venture: 'lantern-co', agentId: 'ada' });
    assert.equal(reply.threadId, broken.threadId);
    assert.ok(reply.resendId.startsWith('em_'));
    assert.deepEqual(reply.dropped, []);
    const sent = rs.state.emails[0];
    assert.equal(sent.headers['In-Reply-To'], broken.messageId);
    assert.equal(sent.headers.References, broken.messageId);
    assert.equal(h.events.at(-1).payload.direction, 'out');
    await assert.rejects(sync.send({ from: 'support@makapark.com', to: ['tired@example.com'], subject: 'x', text: 'y', station: 'ops' }), (e) => e.code === 'SUPPRESSED');
    const campaign = await sync.send({ from: 'marketing@makapark.com', to: ['one@example.com', 'tired@example.com'], subject: 'New lanterns', text: 'Have a look.', html: '<p>Have a look.</p>', kind: 'campaign', station: 'marketing' });
    assert.deepEqual(campaign.dropped, ['tired@example.com']);
    assert.deepEqual(campaign.labels, ['partial']);
    const c = rs.state.emails[1];
    assert.deepEqual(c.to, ['one@example.com']);
    assert.match(c.text, /reply with UNSUBSCRIBE or write to unsubscribe@makapark.com/);
    assert.match(c.html, /mailto:unsubscribe@makapark.com/);
    assert.equal(c.headers['List-Unsubscribe'], '<mailto:unsubscribe@makapark.com?subject=unsubscribe>');
    await assert.rejects(sync.send({ from: 'a@makapark.com', subject: 'x', station: 's' }), /needs from, to and subject/);
    rs.state.failSend = { status: 500, message: 'resend down' };
    await assert.rejects(sync.send({ from: 'support@makapark.com', to: ['z@example.com'], subject: 'x', text: 'y', station: 'ops' }), /resend HTTP 500: resend down/);
    rs.state.failSend = null;

    // Delivery events by webhook and by the status poll.
    const bounce = JSON.stringify({ type: 'email.bounced', created_at: 'x', data: { email_id: campaign.resendId, to: ['one@example.com'], bounce: { type: 'Permanent', subType: 'General', message: 'no mailbox' } } });
    const b = await sync.handleWebhook({ headers: signWebhook({ secret, body: bounce, timestamp: Math.floor(h.clock.now() / 1000) }), rawBody: bounce });
    assert.deepEqual([b.type, b.suppressed, b.messageId], ['bounced', true, campaign.id]);
    assert.equal(h.mailStore.isSuppressed('one@example.com'), true);
    assert.equal(h.events.at(-1).payload.event, 'bounced');
    const note = await sync.send({ from: 'support@makapark.com', to: ['buyer@example.com'], subject: 'Tracking', text: 'Your parcel is on its way.', kind: 'notification', station: 'ops' });
    const soft = JSON.stringify({ type: 'email.bounced', created_at: 'x', data: { email_id: note.resendId, to: ['buyer@example.com'], bounce: { type: 'Temporary', subType: 'MailboxFull', message: 'full' } } });
    await sync.handleWebhook({ headers: signWebhook({ secret, body: soft, timestamp: Math.floor(h.clock.now() / 1000) }), rawBody: soft });
    assert.equal(h.mailStore.isSuppressed('buyer@example.com'), false, 'a temporary bounce does not suppress');
    rs.setLastEvent(reply.resendId, 'delivered');
    const refreshed = await sync.refreshOutbound();
    assert.equal(refreshed.changed, 1);
    assert.equal(h.mailStore.byResendId(reply.resendId).status, 'delivered');
    assert.equal(sync.state().events, 3);
  } finally {
    await h.cleanup();
    await rs.close();
  }
});

test('mail system: composition, station addresses at init, the polling job skips without a key and polls with one', async () => {
  const rs = await startFakeResend();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-mailsys-'));
  try {
    const store = createStore({ root: path.join(dir, 'home') });
    await store.init();
    const bus = createEventBus();
    const clock = fakeClock();
    const scheduler = await createScheduler({ store, clock, log: { error() {} } }).init();
    const nokey = await createMailSystem({ bus, store, scheduler, getLayout: layoutWithCamps, env: {}, keystorePath: path.join(dir, 'none.json'), clock, workspaceRoot: path.join(dir, 'ws'), resendBaseUrl: rs.url, pollMs: 5000, log: { error() {} } }).init();
    assert.equal((await nokey.status()).addresses, 6);
    assert.equal((await nokey.status()).keys.resend, false);
    await assert.rejects(nokey.poll(), (e) => e.code === 'NO_KEY');
    await scheduler.trigger(MAIL_SYNC_JOB_ID, 'test');
    assert.match((await nokey.status()).sync.lastReason, /not wired/);
    scheduler.remove(MAIL_SYNC_JOB_ID);
    const withKey = await createMailSystem({ bus, store, scheduler, getLayout: layoutWithCamps, env: { RESEND_API_KEY: rs.apiKey }, clock, workspaceRoot: path.join(dir, 'ws'), resendBaseUrl: rs.url, pollMs: 5000, log: { error() {} } }).init();
    rs.receive({ from: 'a@example.com', to: ['peak@makapark.com'], subject: 'For the Chief', text: 'hello' });
    await scheduler.trigger(MAIL_SYNC_JOB_ID, 'test');
    const st = await withKey.status();
    assert.equal(st.sync.lastReason, 'polled: 1 new');
    assert.equal(st.counts.byStation['mountain-peak'].in, 1);
    assert.equal(st.sync.job.lastOk, true);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
    await rs.close();
  }
});
