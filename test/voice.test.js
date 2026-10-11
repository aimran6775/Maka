// Phase 4 step 14: voice. The sidecar's relay to Hugging Face's recogniser (bytes in, text
// out, nothing kept), its refusals, the hosted cap, the routes' guards, "heard" and the
// Peak question route; the page's pure parts (which way speech goes, what the park says).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { createVoice, AUDIO_LIMIT_BYTES, AUDIO_TYPES, HF_ASR_DEFAULT_MODEL } from '../sidecar/voice.js';
import { createEventBus } from '../sidecar/bus.js';
import { createNetGuard } from '../sidecar/netguard.js';
import { createStore } from '../sidecar/store.js';
import { createLeashLedger } from '../sidecar/leash-ledger.js';
import { voicePath, sentenceFor, speakable, SPEAK_MAX_CHARS } from '../frontend/ui/voice.js';
import { initialState, applySnapshot } from '../frontend/state.js';
import { defaultLayout } from '../shared/world.js';
import { makeEvent } from '../shared/events.js';
import { fakeProvider, text, end } from './helpers/fake-provider.js';
import { startTestServer } from './helpers/test-server.js';
import { startFakeHfAsr } from './helpers/fake-hf-asr.js';

const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2000, 7)]);

test('the page: which way speech goes, what the park says, how long it speaks', () => {
  assert.deepEqual(voicePath({ tauri: true }), { path: 'shell', label: 'macOS Speech in the app (on the device)' });
  assert.equal(voicePath({ tauri: false, mediaRecorder: true, asrWired: true }).path, 'browser');
  assert.match(voicePath({ mediaRecorder: true, asrWired: false }).label, /no HF_TOKEN/);
  assert.match(voicePath({}).label, /cannot record audio/);
  assert.equal(speakable('**Lantern Co**: 3 orders, see https://example.com/x today'), 'Lantern Co: 3 orders, see a link today');
  assert.ok(speakable('x'.repeat(1000)).length <= SPEAK_MAX_CHARS + 1);
  assert.ok(speakable(`${'a'.repeat(200)}. ${'b'.repeat(300)}`).endsWith('.…'));
  assert.equal(speakable(''), '');
  const gate = makeEvent('gate.item', { itemId: 'g1', agentId: 'sam', kind: 'action', domain: 'money_out', tool: 'stripe.refund', summary: 'refund $5.00 of charge ch_3', status: 'pending', amountUsd: 5 });
  assert.equal(sentenceFor(gate), 'sam waits at the Gate: refund $5.00 of charge ch_3, 5.00 dollars, under money out.');
  assert.equal(sentenceFor({ ...gate, payload: { ...gate.payload, status: 'approved' } }), null, 'a decision is not spoken');
  assert.match(sentenceFor(makeEvent('gate.item', { itemId: 'g2', agentId: 'sam', kind: 'proposal', domain: 'publishing', tool: 'leash', summary: 'loosen publishing to Act with cap', status: 'pending' })), /^A proposal waits at the Gate/);
  assert.match(sentenceFor(makeEvent('reflection.posted', { reflectionId: 'r', reason: 'manual', status: 'posted', portfolio: 'Lantern Co sold 3.' })), /posted a reflection\. Lantern Co sold 3\./);
  assert.match(sentenceFor(makeEvent('reflection.posted', { reflectionId: 'r', reason: 'manual', status: 'skipped', skipReason: 'judge cap' })), /skipped: judge cap/);
  assert.match(sentenceFor(makeEvent('browser.handoff', { handoffId: 'h', agentId: 'sam', status: 'waiting', kind: 'two_factor', url: 'https://shop.example/login' })), /needs you in the browser: two factor/);
  assert.equal(sentenceFor(makeEvent('browser.handoff', { handoffId: 'h', agentId: 'sam', status: 'returned', kind: 'login' })), null);
  assert.match(sentenceFor(makeEvent('recipe.run', { recipeRunId: 'rr', recipeId: 'two-step', version: 1, status: 'failed', by: 'me', reason: 'step note failed' })), /Recipe two-step failed: step note failed/);
  assert.equal(sentenceFor(makeEvent('recipe.run', { recipeRunId: 'rr', recipeId: 'two-step', version: 1, status: 'step', by: 'me' })), null);
  assert.equal(sentenceFor(makeEvent('agent.token', { runId: 'r', turn: 1, text: 'hi' })), null);
  assert.equal(sentenceFor(null), null);
  const s = applySnapshot(initialState(), { seq: 0, providers: {}, keystore: { path: '/x', problem: null }, layout: defaultLayout(), objectKinds: {}, activeRun: null, spend: { totalUsd: 0, reconciledTurns: 0, unreconciledTurns: 0 }, voice: { asr: 'huggingface', asrKey: true } });
  assert.equal(s.voice.asrKey, true);
});

async function relayHarness({ env = {}, fakeOpts = {} } = {}) {
  const fake = await startFakeHfAsr(fakeOpts);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-voice-'));
  const store = createStore({ root: dir });
  await store.init();
  const bus = createEventBus();
  const events = [];
  bus.listen((e) => events.push(e));
  const ledger = await createLeashLedger({ store }).init();
  const voice = createVoice({ env: { HF_TOKEN: fake.token, ...env }, keystorePath: path.join(dir, 'keystore.json'), netGuard: createNetGuard({ allowLocal: true }), ledger, caps: { hostedWorkerCallsPerDay: 2 }, bus, baseUrl: fake.baseUrl, log: { error() {} } });
  return { fake, dir, bus, events, ledger, voice, cleanup: async () => { await fake.close(); await fsp.rm(dir, { recursive: true, force: true }); } };
}

test('the relay: bytes to the recogniser with the bearer, text back, one hosted call counted, nothing kept, the words out of the event', async () => {
  const h = await relayHarness();
  try {
    const st = await h.voice.status();
    assert.equal(st.asr, 'huggingface');
    assert.equal(st.model, HF_ASR_DEFAULT_MODEL);
    assert.equal(st.hostedCap, 2);
    const r = await h.voice.transcribe({ bytes: WEBM, contentType: 'audio/webm;codecs=opus' });
    assert.equal(r.text, 'what did the scout find this week');
    assert.equal(r.via, 'huggingface');
    assert.equal(r.bytes, WEBM.length);
    assert.equal(h.fake.state.calls.length, 1);
    assert.equal(h.fake.state.calls[0].model, HF_ASR_DEFAULT_MODEL);
    assert.equal(h.fake.state.calls[0].bytes, WEBM.length);
    assert.equal(h.fake.state.calls[0].contentType, 'audio/webm');
    assert.equal(h.fake.state.calls[0].authorization, `Bearer ${h.fake.token}`);
    const ev = h.events.find((e) => e.type === 'voice.transcript');
    assert.equal(ev.payload.via, 'huggingface');
    assert.equal(ev.payload.chars, r.text.length);
    assert.equal(ev.payload.accepted, false);
    assert.ok(!JSON.stringify(ev).includes('scout find'), 'the words stay out of the event');
    const cost = h.events.find((e) => e.type === 'cost.estimate');
    assert.equal(cost.payload.tier, 'hosted_worker');
    assert.equal(cost.payload.usd, null);
    assert.equal(cost.payload.reconciled, false);
    // Nothing of the audio on disk: the home holds the ledger alone.
    const files = await fsp.readdir(h.dir);
    assert.ok(files.every((f) => !/audio|webm|wav|voice/.test(f)), files.join(','));
    // `heard`: what the Superintendent did with a transcript, as its length.
    const heard = h.voice.heard({ via: 'shell', text: 'brief the chief to sell lanterns', accepted: true, use: 'mission' });
    assert.deepEqual(heard, { ok: true, via: 'shell', chars: 32, accepted: true });
    const hev = h.events.filter((e) => e.type === 'voice.transcript').at(-1);
    assert.equal(hev.payload.use, 'mission');
    assert.ok(!JSON.stringify(hev).includes('lanterns'));
    assert.throws(() => h.voice.heard({ via: 'phone', text: 'x' }), /via must be one of/);
  } finally {
    await h.cleanup();
  }
});

test('the relay refuses honestly: no audio, too large, a wrong type, a bad token, a loading model, a server error, the hosted cap; the guard', async () => {
  const h = await relayHarness();
  try {
    await assert.rejects(() => h.voice.transcribe({ bytes: Buffer.alloc(0) }), { code: 'NO_AUDIO' });
    await assert.rejects(() => h.voice.transcribe({ bytes: Buffer.alloc(AUDIO_LIMIT_BYTES + 1), contentType: 'audio/webm' }), { code: 'TOO_LARGE' });
    await assert.rejects(() => h.voice.transcribe({ bytes: WEBM, contentType: 'text/plain' }), { code: 'BAD_TYPE' });
    assert.ok(AUDIO_TYPES.includes('audio/wav'));
    h.fake.state.fail = 401;
    await assert.rejects(() => h.voice.transcribe({ bytes: WEBM, contentType: 'audio/webm' }), (err) => err.code === 'HF_AUTH' && !err.message.includes(h.fake.token));
    h.fake.state.fail = 503;
    await assert.rejects(() => h.voice.transcribe({ bytes: WEBM, contentType: 'audio/webm' }), { code: 'MODEL_LOADING' });
    h.fake.state.fail = 500;
    await assert.rejects(() => h.voice.transcribe({ bytes: WEBM, contentType: 'audio/webm' }), { code: 'HF_ERROR' });
    h.fake.state.fail = null;
    h.fake.state.body = 'not json';
    await assert.rejects(() => h.voice.transcribe({ bytes: WEBM, contentType: 'audio/webm' }), { code: 'BAD_RESPONSE' });
    h.fake.state.body = null;
    assert.equal(h.events.filter((e) => e.type === 'cost.estimate').length, 0, 'a failed relay is not a hosted call');
    // The cap: two calls today, the third waits for tomorrow.
    await h.voice.transcribe({ bytes: WEBM, contentType: 'audio/webm' });
    await h.ledger.recordHosted({});
    await h.ledger.recordHosted({});
    await assert.rejects(() => h.voice.transcribe({ bytes: WEBM, contentType: 'audio/webm' }), { code: 'HOSTED_CAP' });
  } finally {
    await h.cleanup();
  }
  // Without a key: not wired, and said so.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-voice-'));
  try {
    const bare = createVoice({ env: {}, keystorePath: path.join(dir, 'keystore.json'), netGuard: createNetGuard({ allowLocal: true }), bus: createEventBus() });
    assert.equal((await bare.status()).asr, 'not wired (HF_TOKEN)');
    await assert.rejects(() => bare.transcribe({ bytes: WEBM, contentType: 'audio/webm' }), { code: 'NOT_WIRED' });
    // The strict guard refuses the loopback fake before any request.
    const fake = await startFakeHfAsr();
    try {
      const strict = createVoice({ env: { HF_TOKEN: fake.token }, keystorePath: path.join(dir, 'keystore.json'), netGuard: createNetGuard(), bus: createEventBus(), baseUrl: fake.baseUrl });
      await assert.rejects(() => strict.transcribe({ bytes: WEBM, contentType: 'audio/webm' }), { code: 'NET_GUARD' });
      assert.equal(fake.state.calls.length, 0);
    } finally {
      await fake.close();
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('through the sidecar: the audio route needs the token and an audio type, relays and answers; heard; the Peak question; the state', async () => {
  const fake = await startFakeHfAsr({ text: 'how many orders did lantern co take' });
  const chiefScript = fakeProvider([[text('Lantern Co took 0 orders: no storefront has synced.'), end('end_turn', { inputTokens: 100, outputTokens: 20 })]], { name: 'anthropic' });
  const srv = await startTestServer({ withChief: true, makeProvider: async (name, opts) => (name === 'anthropic' ? { provider: chiefScript, model: opts.model || 'claude', price: { inputPerMTok: 2, outputPerMTok: 10 } } : { provider: fakeProvider([[text('w'), end()]]), model: 'w', price: null }), env: { HF_TOKEN: fake.token }, voice: { hfAsrBaseUrl: fake.baseUrl } });
  try {
    const st = (await srv.get('/api/voice')).body;
    assert.equal(st.asr, 'huggingface');
    assert.equal((await srv.get('/api/state')).body.voice.asrKey, true);
    // No token: refused before any relay; a JSON content type on the audio route is a bad type.
    const bare = await fetch(`${srv.url}/api/voice/transcribe`, { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: WEBM });
    assert.equal(bare.status, 403);
    assert.equal(fake.state.calls.length, 0);
    const wrongOrigin = await fetch(`${srv.url}/api/voice/transcribe`, { method: 'POST', headers: { 'content-type': 'audio/webm', 'x-maka-token': srv.token, origin: 'http://evil.example' }, body: WEBM });
    assert.equal(wrongOrigin.status, 403);
    const stream = await srv.sse();
    const ok = await fetch(`${srv.url}/api/voice/transcribe`, { method: 'POST', headers: { 'content-type': 'audio/webm', 'x-maka-token': srv.token }, body: WEBM });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.text, 'how many orders did lantern co take');
    assert.equal(fake.state.calls.length, 1);
    const ev = await stream.waitFor((e) => e.type === 'voice.transcript');
    assert.equal(ev.payload.chars, body.text.length);
    const typed = await fetch(`${srv.url}/api/voice/transcribe`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-maka-token': srv.token }, body: '{}' });
    assert.equal(typed.status, 415);
    // Heard: the Superintendent used it as a question.
    const heard = await srv.post('/api/voice/heard', { via: 'huggingface', text: body.text, accepted: true, use: 'ask' });
    assert.equal(heard.status, 200);
    assert.equal(heard.body.chars, body.text.length);
    // The Peak answers the question with a tool-less Chief run.
    const asked = await srv.post('/api/peak/ask', { question: body.text });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.match(asked.body.answer, /0 orders/);
    assert.ok(asked.body.runId);
    const start = stream.events.find((e) => e.type === 'agent.run.start' && e.payload.runId === asked.body.runId);
    assert.deepEqual(start.payload.tools, [], 'a question runs with no tools');
    assert.equal(start.payload.agentId, 'chief-ranger');
    assert.equal((await srv.post('/api/peak/ask', { question: '' })).status, 400);
    assert.equal((await srv.post('/api/voice/heard', { via: 'phone', text: 'x' })).status, 400);
    stream.close();
  } finally {
    await srv.close();
    await fake.close();
  }
});
