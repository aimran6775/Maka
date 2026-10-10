import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createHuggingFaceProvider, HUGGINGFACE_BASE_URL, HUGGINGFACE_DEFAULT_MODEL } from '../sidecar/providers/huggingface.js';
import { createProvider, providerStatus, PROVIDERS } from '../sidecar/providers/provider.js';
import { createRouter, defaultPolicy, TIERS, validatePolicy } from '../sidecar/router.js';
import { createRunManager } from '../sidecar/runs.js';
import { createLeashLedger } from '../sidecar/leash-ledger.js';
import { createStore } from '../sidecar/store.js';
import { createEventBus } from '../sidecar/bus.js';
import { defaultLayout } from '../shared/world.js';
import { fakeFetch, sseResponse, sse } from './helpers/fake-fetch.js';
import { fakeProvider, fakeClock, text, end } from './helpers/fake-provider.js';

test('hugging face adapter: OpenAI-compatible request with the bearer token, usage without a price is unreconciled', async () => {
  const stream = sse([
    [null, { id: 'x', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' } }] }],
    [null, { id: 'x', choices: [{ index: 0, delta: { content: 'lo' } }] }],
    [null, { id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 2 } }],
    [null, '[DONE]'],
  ]);
  const fetch = fakeFetch(() => sseResponse(stream));
  const p = createHuggingFaceProvider({ apiKey: 'hf_test', fetch });
  const chunks = [];
  for await (const c of p.stream({ model: HUGGINGFACE_DEFAULT_MODEL, system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [] })) chunks.push(c);
  assert.equal(fetch.calls[0].url, `${HUGGINGFACE_BASE_URL}/chat/completions`);
  assert.equal(fetch.calls[0].init.headers.authorization, 'Bearer hf_test');
  assert.equal(fetch.calls[0].body.model, HUGGINGFACE_DEFAULT_MODEL);
  const endChunk = chunks.find((c) => c.type === 'message_end');
  assert.deepEqual([endChunk.usage.inputTokens, endChunk.usage.outputTokens, endChunk.usage.costUsd], [12, 2, undefined]);
  assert.equal(chunks.filter((c) => c.type === 'text_delta').map((c) => c.text).join(''), 'Hello');
  assert.throws(() => createHuggingFaceProvider({}), /apiKey/);
  // Registry: HF_TOKEN names it; no token is NO_KEY; status reports it as a hosted worker.
  assert.equal(PROVIDERS.huggingface.envVar, 'HF_TOKEN');
  await assert.rejects(createProvider('huggingface', { env: {}, keystorePath: '/nonexistent' }), (e) => e.code === 'NO_KEY');
  const made = await createProvider('huggingface', { env: { HF_TOKEN: 'hf_x' }, fetch });
  assert.deepEqual([made.provider.name, made.model, made.price], ['huggingface', HUGGINGFACE_DEFAULT_MODEL, null]);
  const st = await providerStatus({ env: { HF_TOKEN: 'hf_x' }, keystorePath: '/nonexistent', probeLocal: false });
  assert.deepEqual([st.huggingface.configured, st.huggingface.tierHint], [true, 'hosted_worker']);
});

test('router: the hosted_worker tier, forced routing, fallback opt-in, the call cap', () => {
  assert.deepEqual([...TIERS], ['worker', 'judge', 'hosted_worker']);
  const router = createRouter(defaultPolicy());
  assert.deepEqual(router.route({ tier: 'hosted_worker' }), { tier: 'hosted_worker', provider: 'huggingface', model: 'Qwen/Qwen2.5-72B-Instruct' });
  assert.equal(router.fallbackFor('worker'), null, 'no fallback unless opted in');
  assert.equal(router.caps().hostedWorkerCallsPerDay, 2000);
  const opted = createRouter({ ...defaultPolicy(), fallback: { worker: 'hosted_worker' }, steps: { turn: 'hosted_worker' } });
  assert.equal(opted.fallbackFor('worker'), 'hosted_worker');
  assert.equal(opted.route({ kind: 'turn' }).tier, 'hosted_worker', 'a policy may route routine turns to the hosted worker');
  assert.equal(validatePolicy({ ...defaultPolicy(), fallback: { worker: 'judge' } }).ok, false);
  const noHosted = defaultPolicy();
  delete noHosted.tiers.hosted_worker;
  assert.equal(createRouter({ ...noHosted, fallback: { worker: 'hosted_worker' } }).fallbackFor('worker'), null, 'a fallback to a missing tier is ignored');
  assert.throws(() => createRouter(noHosted).route({ tier: 'hosted_worker' }), /no "hosted_worker" tier/);
});

test('runs: an unreachable local worker falls back to the hosted worker only when opted in; the daily call cap refuses more', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-hosted-'));
  try {
    const store = createStore({ root: path.join(dir, 'home') });
    await store.init();
    const bus = createEventBus();
    const events = [];
    bus.listen((e) => events.push(e));
    const clock = fakeClock();
    const ledger = await createLeashLedger({ store, clock }).init();
    const seen = [];
    const makeProvider = async (name, opts) => {
      seen.push(name);
      if (name === 'ollama') { const e = new Error('ollama unreachable'); e.code = 'OLLAMA_UNREACHABLE'; throw e; }
      return { provider: fakeProvider([[text('hosted says hi'), end('end_turn', { inputTokens: 40, outputTokens: 5 })]], { name }), model: opts.model, price: null };
    };
    const base = { bus, store, getLayout: defaultLayout, workspaceRoot: path.join(dir, 'ws'), makeProvider, clock, ledger };
    const strict = createRunManager({ ...base, bus: createEventBus(), ledger: null, policy: defaultPolicy() }); // its own bus: one manager counts the ledger
    await assert.rejects(strict.start({ prompt: 'x' }), (e) => e.code === 'OLLAMA_UNREACHABLE', 'no fallback by default');
    const policy = { ...defaultPolicy(), fallback: { worker: 'hosted_worker' }, caps: { ...defaultPolicy().caps, hostedWorkerCallsPerDay: 1 } };
    const runs = createRunManager({ ...base, policy });
    const r = await runs.start({ prompt: 'hello' });
    assert.equal(r.tier, 'hosted_worker');
    assert.equal(r.provider, 'huggingface');
    assert.deepEqual(seen.slice(-2), ['ollama', 'huggingface']);
    await runs.waitForIdle();
    const cost = events.find((e) => e.type === 'cost.estimate').payload;
    assert.deepEqual([cost.tier, cost.usd, cost.reconciled], ['hosted_worker', null, false], 'metered by calls, not priced');
    assert.deepEqual(ledger.hostedToday(), { calls: 1, tokens: 45 });
    assert.equal((await store.loadRun(r.runId)).tier, 'hosted_worker');
    await assert.rejects(runs.start({ prompt: 'again' }), (e) => e.code === 'HOSTED_CAP' && /daily cap of 1/.test(e.message));
    await assert.rejects(runs.start({ prompt: 'again', provider: 'huggingface' }), (e) => e.code === 'HOSTED_CAP', 'an explicit hosted request respects the cap too');
    const explicit = createRunManager({ ...base, policy: defaultPolicy(), ledger: await createLeashLedger({ store: createStore({ root: path.join(dir, 'home2') }), clock }).init() });
    await assert.rejects(explicit.start({ prompt: 'x', provider: 'ollama' }), (e) => e.code === 'OLLAMA_UNREACHABLE', 'an explicit provider never falls back');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
