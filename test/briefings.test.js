import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { INTERNAL_KINDS } from '../sidecar/mail/system.js';
import { startTestServer } from './helpers/test-server.js';
import { fakeProvider, text, end, waitUntil } from './helpers/fake-provider.js';

const PRICE = { inputPerMTok: 4, outputPerMTok: 20 };

test('a reflection\'s briefings land in station mail: internal mail from peak@ to the camp\'s station address, kind briefing, no Resend, no footer, not classified; the notes file stays; the camp\'s threads show it', async () => {
  const reflectionJson = { portfolio: 'Nothing has run yet; 0 items done.', ventures: [], briefings: [{ zoneId: 'ranger-station', text: 'Rangers: start with 1 scouting task tomorrow.' }, { zoneId: 'visitor-center', text: 'Visitors: 0 threads to answer.' }] };
  const judgeProvider = async (name, opts) => ({ provider: fakeProvider([[text(JSON.stringify(reflectionJson)), end('end_turn', { inputTokens: 200, outputTokens: 50 })]], { name }), model: opts.model, price: PRICE });
  const classifyCalls = [];
  const classifyProvider = async (name) => { classifyCalls.push(name); return { provider: fakeProvider([[text('{"classification":"customer","confidence":0.9}'), end()]], { name }), model: 'w', price: null }; };
  const srv = await startTestServer({ makeProvider: async (name) => ({ provider: fakeProvider([[text('x'), end()]], { name }), model: 'w', price: null }), judgeProvider, withChief: true, mail: { classifyProvider } });
  try {
    assert.deepEqual([...INTERNAL_KINDS], ['briefing']);
    const stream = await srv.sse();
    assert.equal((await srv.post('/api/reflect', { reason: 'test' })).status, 202);
    const posted = await stream.waitFor((e) => e.type === 'reflection.posted');
    assert.deepEqual(posted.payload.briefings, ['ranger-station', 'visitor-center']);
    assert.equal(posted.payload.mailed, 2);
    const mails = stream.events.filter((e) => e.type === 'mail.message');
    assert.equal(mails.length, 2);
    const rangers = mails.find((e) => e.payload.station === 'ranger-station').payload;
    assert.deepEqual([rangers.direction, rangers.from, rangers.to, rangers.kind], ['in', 'peak@makapark.com', ['rangers@makapark.com'], 'briefing']);
    assert.equal(rangers.subject, `Briefing from the Mountain Peak (${posted.payload.reflectionId})`);
    const list = await srv.get('/api/mail/messages?station=ranger-station');
    assert.equal(list.body.length, 1);
    assert.deepEqual([list.body[0].kind, list.body[0].status, list.body[0].labels, list.body[0].classification], ['briefing', 'received', ['internal'], null]);
    const full = await srv.get(`/api/mail/messages/${list.body[0].id}`);
    assert.equal(full.body.text, 'Rangers: start with 1 scouting task tomorrow.');
    assert.equal(full.body.text.includes('UNSUBSCRIBE'), false, 'no campaign footer');
    assert.equal(full.body.headers['X-Maka-Ref'], posted.payload.reflectionId);
    assert.match(full.body.messageId, /^<briefing-.*@makapark\.com>$/);
    const threads = await srv.get('/api/mail/threads?station=ranger-station');
    assert.equal(threads.body[0].kind, 'briefing');
    assert.equal(threads.body[0].unread, 1);
    await srv.mail.classified();
    assert.deepEqual(classifyCalls, [], 'internal mail is not classified');
    assert.equal(stream.events.filter((e) => e.type === 'mail.classified').length, 0);
    const doc = await srv.get(`/api/reflections/${posted.payload.reflectionId}`);
    assert.deepEqual(doc.body.briefingMail.map((m) => [m.zoneId, m.to]), [['ranger-station', 'rangers@makapark.com'], ['visitor-center', 'visitors@makapark.com']]);
    assert.equal(doc.body.briefingFiles.length, 2, 'the notes files stay the on-disk copy');
    assert.ok((await fsp.stat(path.join(srv.workspaceRoot, doc.body.briefingFiles[0]))).isFile());
    assert.equal((await srv.get('/api/state')).body.reflection.latest.mailed, 2);
    assert.equal((await srv.get('/api/mail')).body.counts.messages, 2);
    assert.equal((await srv.get('/api/mail')).body.sync.sent, 0, 'nothing went through Resend');
    stream.close();
  } finally {
    await srv.close();
  }
});

test('deliverInternal refuses anything that is not station-to-station: an external recipient, an alias sender, a foreign kind', async () => {
  const srv = await startTestServer({ makeProvider: async (name) => ({ provider: fakeProvider([[text('x'), end()]], { name }), model: 'w', price: null }), withChief: true });
  try {
    const mail = srv.mail;
    await assert.rejects(mail.deliverInternal({ from: 'peak@makapark.com', to: 'customer@example.com', subject: 's', text: 't' }), (e) => e.code === 'INTERNAL_ONLY');
    await assert.rejects(mail.deliverInternal({ from: 'peak@makapark.com', to: ['rangers@makapark.com', 'nobody@elsewhere.org'], subject: 's', text: 't' }), (e) => e.code === 'INTERNAL_ONLY' && /nobody@elsewhere\.org/.test(e.message));
    await assert.rejects(mail.deliverInternal({ from: 'peak@makapark.com', to: 'unsubscribe@makapark.com', subject: 's', text: 't' }), (e) => e.code === 'INTERNAL_ONLY', 'the system address is not a station');
    await assert.rejects(mail.deliverInternal({ from: 'someone@makapark.com', to: 'rangers@makapark.com', subject: 's', text: 't' }), (e) => e.code === 'INTERNAL_ONLY');
    await assert.rejects(mail.deliverInternal({ from: 'peak@makapark.com', to: 'rangers@makapark.com', subject: 's', text: 't', kind: 'campaign' }), (e) => e.code === 'BAD_REQUEST');
    await assert.rejects(mail.deliverInternal({ from: 'peak@makapark.com', to: 'rangers@makapark.com', subject: '', text: 't' }), (e) => e.code === 'BAD_REQUEST');
    assert.equal((await srv.get('/api/mail')).body.counts.messages, 0, 'nothing stored by a refused delivery');
    const [rec] = await mail.deliverInternal({ from: 'peak@makapark.com', to: 'rangers@makapark.com', subject: 'ok', text: 'fine', ref: 'r-1' });
    assert.equal(rec.station, 'ranger-station');
    // Internal mail is not mail history for the policy: a briefing makes no external address known and counts toward no ceiling.
    assert.equal(mail.policy.sentLastHour({ station: 'ranger-station' }).station, 0);
  } finally {
    await srv.close();
  }
});
