import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRecord, desiredRecords, planDns, applyPlan, createCloudflare, createResendDomains, planFor } from '../sidecar/mail/dns.js';
import { createMailSetup } from '../sidecar/mail/setup.js';
import { createEventBus } from '../sidecar/bus.js';
import { startFakeCloudflare } from './helpers/fake-cloudflare.js';
import { startFakeResend, SAMPLE_RECORDS } from './helpers/fake-resend.js';
import { fakeClock, waitUntil } from './helpers/fake-provider.js';

const D = 'makapark.com';

test('normalisation: names are qualified, TXT unquoted, MX lower-cased with priority', () => {
  assert.deepEqual(normalizeRecord({ type: 'txt', name: '@', value: '"v=spf1 include:amazonses.com ~all"' }, D), { type: 'TXT', name: D, content: 'v=spf1 include:amazonses.com ~all', ttl: 1 });
  assert.deepEqual(normalizeRecord({ type: 'MX', name: 'send', content: 'Feedback-SMTP.example.', priority: '10', ttl: 'Auto' }, D), { type: 'MX', name: `send.${D}`, content: 'feedback-smtp.example', ttl: 1, priority: 10 });
  assert.equal(normalizeRecord({ type: 'TXT', name: `resend._domainkey.${D}`, content: 'p=abc' }, D).name, `resend._domainkey.${D}`);
});

test('desired records: Resend records plus a DMARC record; the plan diffs by type and name, replaces foreign MX, keeps other TXT', () => {
  const resendDomain = { id: 'dom1', name: D, records: SAMPLE_RECORDS(D) };
  const desired = desiredRecords(resendDomain, { domain: D });
  assert.equal(desired.length, 5);
  const dmarc = desired.find((r) => r.name === `_dmarc.${D}`);
  assert.equal(dmarc.content, `v=DMARC1; p=none; rua=mailto:gate@${D}`);
  assert.equal(dmarc.source, 'maka:dmarc');
  assert.equal(desiredRecords({ records: [{ type: 'TXT', name: '_dmarc', value: 'v=DMARC1; p=reject' }] }, { domain: D }).length, 1, 'a DMARC from Resend is kept as is');
  const existing = [
    { id: 'e1', ...normalizeRecord({ type: 'MX', name: D, content: 'old.mail.example', priority: 20 }, D) },
    { id: 'e2', ...normalizeRecord({ type: 'TXT', name: `send.${D}`, content: '"v=spf1 include:old.example ~all"' }, D) },
    { id: 'e3', ...normalizeRecord({ type: 'TXT', name: D, content: 'google-site-verification=abc' }, D) },
    { id: 'e4', ...normalizeRecord({ type: 'TXT', name: `resend._domainkey.${D}`, content: 'p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC-test' }, D) },
  ];
  const plan = planDns(desired, existing);
  assert.deepEqual(plan.create.map((r) => `${r.type} ${r.name}`), [`MX send.${D}`, `MX ${D}`, `TXT _dmarc.${D}`]);
  assert.deepEqual(plan.update.map((r) => [r.id, r.previous, r.content]), [['e2', 'v=spf1 include:old.example ~all', 'v=spf1 include:amazonses.com ~all']]);
  assert.deepEqual(plan.remove.map((r) => r.id), ['e1'], 'the foreign MX at the root goes');
  assert.deepEqual(plan.unchanged.map((r) => r.id), ['e4']);
  assert.ok(!plan.remove.some((r) => r.id === 'e3') && !plan.update.some((r) => r.id === 'e3'), 'the verification TXT is untouched');
  const again = planDns(desired, [...existing.filter((e) => e.id !== 'e1'), ...plan.create.map((r, i) => ({ ...r, id: `n${i}` })), { ...plan.update[0] }]);
  assert.deepEqual([again.create.length, again.update.length, again.remove.length, again.unchanged.length], [0, 0, 0, 5], 'idempotent once applied');
});

test('against the fakes: zone lookup, domain fetch, plan, apply writes and removes, auth errors, missing zone', async () => {
  const cf = await startFakeCloudflare({ records: [{ type: 'MX', name: D, content: 'old.mail.example', priority: 20 }, { type: 'TXT', name: D, content: '"google-site-verification=abc"' }] });
  const rs = await startFakeResend({ domains: [{ name: D }] });
  try {
    const cloudflare = createCloudflare({ token: cf.token, fetch, baseUrl: cf.url });
    const resend = createResendDomains({ apiKey: rs.apiKey, fetch, baseUrl: rs.url });
    assert.equal((await cloudflare.zone(D)).id, 'zone1');
    assert.equal(await cloudflare.zone('nope.example'), null);
    assert.equal((await resend.get(D)).records.length, 4);
    assert.equal(await resend.get('other.example'), null);
    const out = await planFor({ domain: D, resend, cloudflare });
    assert.equal(out.zoneId, 'zone1');
    assert.equal(out.existing, 2);
    assert.deepEqual([out.plan.create.length, out.plan.update.length, out.plan.remove.length], [5, 0, 1], "Resend's four records plus DMARC; the old MX goes");
    const result = await applyPlan(cloudflare, 'zone1', out.plan);
    assert.deepEqual(result, { created: 5, updated: 0, removed: 1, errors: [] });
    assert.equal(cf.state.records.length, 6, 'the verification TXT stays');
    const txt = cf.state.records.find((r) => r.type === 'TXT' && r.name === `send.${D}`);
    assert.equal(txt.content, '"v=spf1 include:amazonses.com ~all"', 'TXT content is quoted for Cloudflare');
    assert.equal(cf.state.records.find((r) => r.type === 'MX' && r.name === D).priority, 10);
    const second = await planFor({ domain: D, resend, cloudflare });
    assert.deepEqual([second.plan.create.length, second.plan.update.length, second.plan.remove.length, second.plan.unchanged.length], [0, 0, 0, 5]);
    // Errors are plain.
    const badCf = createCloudflare({ token: 'wrong', fetch, baseUrl: cf.url });
    await assert.rejects(badCf.zone(D), (e) => e.code === 'HTTP_403');
    const badRs = createResendDomains({ apiKey: 'wrong', fetch, baseUrl: rs.url });
    await assert.rejects(badRs.list(), /resend HTTP 401: API key is invalid/);
    await assert.rejects(planFor({ domain: 'missing.example', resend, cloudflare }), (e) => e.code === 'NO_ZONE');
    const fresh = await createResendDomains({ apiKey: rs.apiKey, fetch, baseUrl: rs.url }).create('new.example');
    assert.equal(fresh.name, 'new.example');
    await assert.rejects(resend.create('new.example'), /already exists/);
    const dead = createCloudflare({ token: 'x', fetch, baseUrl: 'http://127.0.0.1:1' });
    await assert.rejects(dead.zone(D), (e) => e.code === 'NETWORK');
  } finally {
    await cf.close();
    await rs.close();
  }
});

test('mail setup: plan emits mail.dns; apply parks a Gate item and writes only on approve; a reject writes nothing; a missing Resend domain is created on apply', async () => {
  const cf = await startFakeCloudflare();
  const rs = await startFakeResend();
  try {
    const bus = createEventBus();
    const events = [];
    bus.listen((e) => events.push(e));
    const clock = fakeClock();
    // A minimal Gate queue stand-in: records submissions and lets the test decide.
    const submissions = [];
    const gateQueue = { submit: (item) => new Promise((resolve) => submissions.push({ item: { ...item, itemId: `g${submissions.length + 1}` }, resolve })), pending: () => submissions.filter((s) => !s.done).map((s) => s.item) };
    const setup = createMailSetup({ bus, gateQueue, env: { RESEND_API_KEY: rs.apiKey, CLOUDFLARE_API_TOKEN: cf.token }, fetch, clock, resendBaseUrl: rs.url, cloudflareBaseUrl: cf.url, log: { error() {} } });
    assert.deepEqual((await setup.status()).keys, { resend: true, cloudflare: true });
    const plan = await setup.plan();
    assert.equal(plan.resend, null, 'not registered at Resend yet');
    assert.match(plan.notes[0], /not registered at Resend yet; apply will create it/);
    assert.deepEqual(plan.counts, { create: 0, update: 0, remove: 0, unchanged: 0 });
    assert.equal(events.at(-1).type, 'mail.dns');
    assert.equal(events.at(-1).payload.change, 'planned');
    const apply = await setup.apply();
    assert.equal(apply.status, 'pending');
    assert.equal(apply.itemId, 'g1');
    const sub = submissions[0];
    assert.equal(sub.item.domain, 'account_settings');
    assert.equal(sub.item.agentId, 'superintendent');
    assert.match(sub.item.summary, /register makapark.com at Resend/);
    await assert.rejects(setup.apply(), (e) => e.status === 409);
    sub.done = true;
    sub.resolve({ decision: 'reject', notes: 'not yet', status: 'rejected' });
    await waitUntil(() => events.some((e) => e.type === 'mail.dns' && e.payload.change === 'failed'));
    assert.match(events.at(-1).payload.message, /rejected at the Gate: not yet/);
    assert.equal(rs.state.domains.length, 0, 'nothing created on reject');
    assert.equal(setup.lastApply().status, 'declined');
    // Approve the next one: Resend domain created, records written, verification requested.
    const apply2 = await setup.apply();
    assert.equal(apply2.itemId, 'g2');
    submissions[1].done = true;
    submissions[1].resolve({ decision: 'approve', notes: '', status: 'approved' });
    await waitUntil(() => events.some((e) => e.type === 'mail.dns' && e.payload.change === 'applied'));
    const applied = events.at(-1).payload;
    assert.deepEqual([applied.create, applied.update, applied.remove, applied.unchanged], [5, 0, 0, 0]);
    assert.equal(rs.state.domains[0].name, D);
    assert.equal(rs.state.domains[0].status, 'pending', 'verify was requested');
    assert.equal(cf.state.records.length, 5);
    assert.equal(setup.lastApply().status, 'applied');
    assert.equal((await setup.status()).pendingItemId, null);
    const noKeys = createMailSetup({ bus, gateQueue, env: {}, keystorePath: '/nonexistent/keystore.json', fetch, clock });
    await assert.rejects(noKeys.plan(), (e) => e.code === 'NO_KEY');
    assert.deepEqual((await noKeys.status()).keys, { resend: false, cloudflare: false });
  } finally {
    await cf.close();
    await rs.close();
  }
});
