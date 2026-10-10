import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createStore } from '../sidecar/store.js';
import { createEventBus } from '../sidecar/bus.js';
import { createMailStore } from '../sidecar/mail/store.js';
import { createAddresses } from '../sidecar/mail/addresses.js';
import { createResendMail, createMailSync } from '../sidecar/mail/resend.js';
import { createMailPolicy, DEFAULT_CEILINGS, KIND_DOMAINS } from '../sidecar/mail/send.js';
import { startFakeResend } from './helpers/fake-resend.js';
import { defaultLayout } from '../shared/world.js';
import { fakeClock } from './helpers/fake-provider.js';

const D = 'makapark.com';

async function setup({ ceilings } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-mailpolicy-'));
  const store = createStore({ root: path.join(dir, 'home') });
  await store.init();
  const bus = createEventBus();
  const events = [];
  bus.listen((e) => events.push(e));
  let now = 1_700_000_000_000;
  const clock = { now: () => (now += 1), advance: (ms) => (now += ms) };
  const layout = defaultLayout();
  layout.rooms.push({ id: 'mountain-peak', name: 'Peak', kind: 'mountain_peak', x: 0, y: 0, w: 2, h: 2 });
  layout.rooms.push({ id: 'ops', name: 'Support', kind: 'operations_support', x: 31, y: 1, w: 8, h: 6 });
  layout.rooms.push({ id: 'visitor-center', name: 'Visitor Center', kind: 'visitor_center', x: 21, y: 1, w: 8, h: 6 });
  layout.agents.push({ id: 'chief-ranger', name: 'Chief', roomId: 'mountain-peak', x: 0, y: 0, role: 'chief_ranger' });
  layout.agents.push({ id: 'ada', name: 'Ada', roomId: 'ops', x: 31, y: 1, role: 'ranger', venture: 'lantern-co' });
  const rs = await startFakeResend();
  const mailStore = await createMailStore({ root: path.join(dir, 'mail'), clock }).init();
  const addresses = await createAddresses({ store, bus, domain: D, clock }).init();
  await addresses.ensureStations(layout);
  await addresses.createAlias({ local: 'support-lantern-co', agentId: 'ada', venture: 'lantern-co', station: 'ops' }, { by: 'chief-ranger' });
  const resend = createResendMail({ apiKey: rs.apiKey, fetch, baseUrl: rs.url });
  const sync = createMailSync({ store: mailStore, addresses, getResend: async () => resend, bus, clock, domain: D, log: { error() {} } });
  const policy = createMailPolicy({ mailStore, addresses, sync, getLayout: () => layout, clock, domain: D, ceilings });
  return { dir, rs, events, clock, mailStore, addresses, sync, policy, layout, cleanup: async () => { await fsp.rm(dir, { recursive: true, force: true }); await rs.close(); } };
}

test('allowed from-addresses per principal; kinds map to leash domains', async () => {
  const h = await setup();
  try {
    assert.deepEqual(h.policy.allowedFrom('ada').sort(), ['support-lantern-co@makapark.com', 'support@makapark.com']);
    assert.deepEqual(h.policy.allowedFrom('ranger'), ['rangers@makapark.com']);
    assert.ok(h.policy.allowedFrom('chief-ranger').includes('peak@makapark.com') && h.policy.allowedFrom('chief-ranger').includes('support@makapark.com'));
    assert.ok(!h.policy.allowedFrom('chief-ranger').includes('unsubscribe@makapark.com'));
    assert.ok(h.policy.allowedFrom('superintendent').includes('gate@makapark.com'));
    assert.deepEqual(h.policy.allowedFrom('ghost'), []);
    assert.equal(h.policy.kindOf({ inReplyTo: '<x>' }), 'reply');
    assert.equal(h.policy.kindOf({ to: 'a@x' }), 'notification');
    assert.equal(h.policy.kindOf({ to: ['a@x', 'b@y'] }), 'campaign');
    assert.equal(h.policy.kindOf({ kind: 'campaign', to: 'a@x' }), 'campaign');
    assert.deepEqual(KIND_DOMAINS, { reply: 'outbound_messages', notification: 'outbound_messages', campaign: 'publishing' });
    assert.equal(h.policy.domainFor('weird'), 'outbound_messages');
    assert.deepEqual(DEFAULT_CEILINGS, { perAgentPerHour: 30, perStationPerHour: 120, campaignRecipientsPerHour: 500 });
  } finally {
    await h.cleanup();
  }
});

test('validate and send: from rule, suppression, new external recipients, ceilings per hour, campaign domain', async () => {
  const h = await setup({ ceilings: { perAgentPerHour: 2, perStationPerHour: 3, campaignRecipientsPerHour: 3 } });
  try {
    await assert.rejects(h.policy.validate({ from: 'support@makapark.com', to: 'x@example.com', subject: 's' }), /sender \(by\)/);
    await assert.rejects(h.policy.validate({ from: 'rangers@makapark.com', to: 'x@example.com', subject: 's' }, { by: 'ada' }), (e) => e.status === 403 && /may not send from/.test(e.message));
    await assert.rejects(h.policy.validate({ from: 'support@makapark.com', subject: 's' }, { by: 'ada' }), /from, to and subject/);
    const v = await h.policy.validate({ from: 'Support <SUPPORT-lantern-co@makapark.com>', to: 'new@example.com', subject: 'Hi' }, { by: 'ada' });
    assert.deepEqual([v.kind, v.domain, v.station, v.venture, v.agentId, v.newExternal], ['notification', 'outbound_messages', 'ops', 'lantern-co', 'ada', ['new@example.com']]);
    assert.equal(h.policy.judgeAtDraft({ to: 'new@example.com' }), true);
    assert.equal(h.policy.judgeAtDraft({ to: 'rangers@makapark.com' }), false, 'on-domain is never external');
    // After one exchange the address is known.
    await h.mailStore.add({ direction: 'in', from: 'Known <known@example.com>', to: ['support@makapark.com'], subject: 'q', text: 'q', station: 'ops', resendId: 'r1' });
    assert.equal(h.policy.isNewExternal('known@example.com'), false);
    assert.equal(h.policy.judgeAtDraft({ to: ['known@example.com', 'new@example.com'] }), true, 'any new recipient counts');
    // Sends count toward the ceilings: Ada may send 2 per hour; her station 3.
    const s1 = await h.policy.send({ from: 'support-lantern-co@makapark.com', to: 'known@example.com', subject: 'Re: q', text: 'a', inReplyTo: '<x@example.com>' }, { by: 'ada' });
    assert.deepEqual([s1.kind, s1.agentId, s1.venture, s1.station], ['reply', 'ada', 'lantern-co', 'ops']);
    await h.policy.send({ from: 'support@makapark.com', to: 'other@example.com', subject: 'n', text: 'b' }, { by: 'ada' });
    await assert.rejects(h.policy.send({ from: 'support@makapark.com', to: 'third@example.com', subject: 'n', text: 'c' }, { by: 'ada' }), (e) => e.code === 'CEILING' && /ada sent 2 message/.test(e.message));
    assert.equal(h.policy.sentLastHour({ agentId: 'ada', station: 'ops' }).agent, 2);
    // The Chief uses the same station: the station ceiling (3) bites after one more.
    await h.policy.send({ from: 'support@makapark.com', to: 'fourth@example.com', subject: 'n', text: 'd' }, { by: 'chief-ranger' });
    await assert.rejects(h.policy.send({ from: 'support@makapark.com', to: 'fifth@example.com', subject: 'n', text: 'e' }, { by: 'chief-ranger' }), /ops sent 3 message/);
    assert.equal((await assert.rejects(h.policy.send({ from: 'support@makapark.com', to: 'x@example.com', subject: 'n', text: 'e' }, { by: 'superintendent' }), /ops sent 3/), undefined), undefined, 'the Superintendent still respects station ceilings');
    h.clock.advance(3600 * 1000 + 5);
    assert.equal(h.policy.checkCeiling({ agentId: 'ada', station: 'ops' }).ok, true, 'an hour later the window is clear');
    // Campaign recipients per hour and the publishing domain.
    const c = await h.policy.send({ from: 'rangers@makapark.com', to: ['a@example.com', 'b@example.com'], subject: 'News', text: 'x', kind: 'campaign' }, { by: 'ranger' });
    assert.equal(c.kind, 'campaign');
    assert.match(c.text, /UNSUBSCRIBE/);
    await assert.rejects(h.policy.send({ from: 'rangers@makapark.com', to: ['c@example.com', 'd@example.com'], subject: 'News', text: 'x', kind: 'campaign' }, { by: 'ranger' }), /campaigns reached 2 recipient/);
    await h.mailStore.suppress('dead@example.com', 'test');
    await assert.rejects(h.policy.validate({ from: 'rangers@makapark.com', to: 'dead@example.com', subject: 's' }, { by: 'ranger' }), (e) => e.code === 'SUPPRESSED');
    assert.equal(h.policy.status().lastHour.campaignRecipients, 2);
  } finally {
    await h.cleanup();
  }
});
