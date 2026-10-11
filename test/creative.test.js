// Phase 4 step 8: the creative kit. Ad copy variants the Ranger wrote, checked against the
// platform limits and reviewed by the judge; ad images through a fake Hugging Face endpoint
// after the judge's no-faces / no-logos check of the prompt, metered under the hosted
// worker cap. Both land in outbox/creative/ and nowhere else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import { createStore } from '../sidecar/store.js';
import { createEventBus } from '../sidecar/bus.js';
import { createLayoutState } from '../sidecar/server.js';
import { createLeashLedger, createLeashState } from '../sidecar/leash-ledger.js';
import { createGateQueue } from '../sidecar/gate-queue.js';
import { createToolGate } from '../sidecar/capability/gate.js';
import { createJudge } from '../sidecar/judge.js';
import { createRouter, defaultPolicy } from '../sidecar/router.js';
import { createCreative, listCreatives, CREATIVE_TOOL_NAMES, CREATIVE_DIR } from '../sidecar/creative/index.js';
import { COPY_SCHEMA, COPY_LIMITS, copyProblem, renderCopy, COPY_REVIEW_SCOPE } from '../sidecar/creative/copy.js';
import { createImageGenerator, imageType, fullPrompt, POLICY_SUFFIX, POLICY_SCOPE, NEGATIVE_PROMPT, IMAGE_SIZES, HF_IMAGES_BASE_URL, HF_IMAGE_DEFAULT_MODEL, IMAGE_LIMIT_BYTES } from '../sidecar/creative/images.js';
import { slugOf, newId } from '../sidecar/creative/paths.js';
import { createNetGuard } from '../sidecar/netguard.js';
import { validate } from '../shared/schema.js';
import { ENV_VARS } from '../sidecar/providers/keys.js';
import { OBJECT_KINDS, defaultLayout, allGrantsFor } from '../shared/world.js';
import { defaultLeash, TOOL_DOMAINS } from '../shared/leash.js';
import { startFakeHfImages, TINY_PNG } from './helpers/fake-hf-images.js';
import { startTestServer } from './helpers/test-server.js';
import { fakeProvider, fakeClock, text, toolCall, end } from './helpers/fake-provider.js';

const COPY = {
  venture: 'lantern-co',
  name: 'Lantern launch',
  platform: 'meta',
  product: 'Handmade paper lanterns, $25 each, three designs, ships flat in the US within 5 days.',
  audience: 'Wedding and garden-party planners in the US.',
  landingUrl: 'https://lanterns.example/shop',
  variants: [
    { headline: 'Paper lanterns, made by hand', primaryText: 'Three designs, $25 each, shipped flat to your door in five days.', description: 'Handmade in small batches.', cta: 'SHOP_NOW' },
    { headline: 'Light up the garden party', primaryText: 'Handmade paper lanterns in three designs. $25 each, US shipping in five days.', cta: 'SHOP_NOW' },
  ],
};
const IMAGE = { venture: 'lantern-co', name: 'Lantern hero', prompt: 'A paper lantern glowing at dusk on a wooden garden table, warm light, soft background', style: 'photo', size: 'landscape' };

// A marketing camp with a Notice board and an Ads Ranger; the gate runs the creative tools
// the way a run would, with the judge scripted per call.
async function harness({ fake, env = {}, judgeScripts = null, policy = defaultPolicy(), judgeProvider: judgeRef = {} } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-creative-'));
  const store = createStore({ root: path.join(dir, 'home') });
  await store.init();
  const bus = createEventBus();
  const events = [];
  bus.listen((e) => events.push(e));
  const clock = fakeClock(Date.UTC(2026, 9, 11, 12));
  const layout = defaultLayout();
  layout.rooms.push({ id: 'marketing', name: 'Marketing Camp', kind: 'marketing', x: 21, y: 1, w: 8, h: 6 });
  layout.objects.push({ id: 'board', kind: 'notice_board', roomId: 'marketing', x: 22, y: 2 });
  layout.agents.push({ id: 'ads', name: 'Ada', roomId: 'marketing', x: 21, y: 1, role: 'ranger', specialty: 'ads' });
  const layoutState = createLayoutState({ initial: layout, store, bus, clock });
  const ledger = await createLeashLedger({ store, clock }).init();
  const leashState = createLeashState({ initial: defaultLeash(), store });
  const gateQueue = await createGateQueue({ bus, store, ledger, leashState, getLayout: layoutState.get, clock }).init();
  const keystorePath = path.join(dir, 'home', 'keystore.json');
  const router = createRouter(policy);
  const judge = judgeScripts
    ? createJudge({
        router,
        makeProvider: async (name, opts) => {
          judgeRef.provider = fakeProvider(judgeScripts(), { name });
          return { provider: judgeRef.provider, model: opts.model || 'm', price: { inputPerMTok: 2, outputPerMTok: 10 } };
        },
        ledger,
        bus,
        clock,
        env,
        keystorePath,
        log: { error() {} },
      })
    : null;
  const workspaceRoot = path.join(dir, 'ws');
  await fsp.mkdir(path.join(workspaceRoot, 'ads'), { recursive: true });
  const creative = createCreative({ env, keystorePath, netGuard: createNetGuard({ allowLocal: true }), judge, ledger, caps: router.caps(), bus, workspaceRoot, config: { hfImagesBaseUrl: fake ? fake.baseUrl : undefined, imageModel: 'test/tiny-model' }, clock });
  const gateFor = (toolContext = {}, { netGuard = createNetGuard({ allowLocal: true }) } = {}) =>
    createToolGate({ getLayout: layoutState.get, agentId: 'ads', workspaceDir: path.join(workspaceRoot, 'ads'), registry: { ...creative.tools }, grants: allGrantsFor, toolContext: { judge, netGuard, ...toolContext }, getLeash: () => leashState.get(), ledger, submit: { submit: (item) => gateQueue.submit({ ...item, runId: 'run-1', agentId: 'ads' }), log: (item) => gateQueue.log({ ...item, runId: 'run-1', agentId: 'ads' }) } });
  const gate = gateFor();
  const ofType = (t) => events.filter((e) => e.type === t).map((e) => e.payload);
  const call = (id, name, input, g = gate) => g.execute({ id, name, input }, { runId: 'run-1', turn: 1 });
  return { dir, bus, events, ofType, clock, gateQueue, ledger, keystorePath, workspaceRoot, creative, judge, gate, gateFor, call, cleanup: async () => fsp.rm(dir, { recursive: true, force: true }) };
}

const out = (r) => JSON.parse(r.output.split('\n')[0]);

test('the contract: the Notice board grants creative.copy and creative.image, both without a leash domain; the copy limits, the prompt policy suffix and the image sniffing are pure', () => {
  assert.deepEqual([...CREATIVE_TOOL_NAMES], ['creative.copy', 'creative.image']);
  for (const t of CREATIVE_TOOL_NAMES) {
    assert.ok(OBJECT_KINDS.notice_board.grants.includes(t), `${t} granted by the Notice board`);
    assert.equal(TOOL_DOMAINS[t], null, `${t} has no domain`);
    assert.ok(t in TOOL_DOMAINS);
  }
  assert.ok(!OBJECT_KINDS.park_store.grants.includes('creative.image'), 'only the ads camp generates ad images');
  assert.equal(ENV_VARS.huggingface, 'HF_TOKEN');
  assert.equal(HF_IMAGES_BASE_URL, 'https://router.huggingface.co/hf-inference/models');
  assert.equal(HF_IMAGE_DEFAULT_MODEL, 'black-forest-labs/FLUX.1-schnell');
  assert.equal(IMAGE_LIMIT_BYTES, 8 * 1024 * 1024);
  assert.deepEqual(IMAGE_SIZES.landscape, [1152, 640]);
  // copy limits
  assert.equal(validate(COPY_SCHEMA, COPY).ok, true);
  assert.equal(validate(COPY_SCHEMA, { ...COPY, variants: [COPY.variants[0]] }).ok, false, 'at least two variants');
  assert.equal(copyProblem(COPY), null);
  assert.match(copyProblem({ ...COPY, variants: [{ headline: 'x'.repeat(41), primaryText: 'p' }, COPY.variants[1]] }), /variant 1: the headline is 41 characters; meta allows 40/);
  assert.match(copyProblem({ ...COPY, variants: [{ headline: 'No primary text' }, COPY.variants[1]] }), /variant 1 needs a primaryText for meta/);
  assert.match(copyProblem({ ...COPY, platform: 'google', variants: [{ headline: 'Paper lanterns by hand', description: 'd' }, { headline: 'Thirty-one characters long head', description: 'd' }] }), /variant 2: the headline is 31 characters; google allows 30/);
  assert.match(copyProblem({ ...COPY, platform: 'google', variants: [{ headline: 'Lanterns', description: 'd', primaryText: 'nope' }, { headline: 'Lanterns 2', description: 'd' }] }), /google ads have no primaryText/);
  assert.match(copyProblem({ ...COPY, platform: 'google', variants: [{ headline: 'Lanterns' }, { headline: 'Lanterns 2', description: 'd' }] }), /variant 1 needs a description for google/);
  assert.equal(COPY_LIMITS.google.description, 90);
  const md = renderCopy({ id: 'copy-2026-10-11-abcde', agentId: 'ads', createdAt: Date.UTC(2026, 9, 11), judge: { verdict: 'approve', notes: 'grounded' }, copy: COPY });
  assert.match(md, /^# Ad copy: Lantern launch \(meta\)/);
  assert.match(md, /Judge: approve — grounded/);
  assert.match(md, /## Product facts\n\nHandmade paper lanterns/);
  assert.match(md, /### 1\. Paper lanterns, made by hand\n\nThree designs/);
  assert.match(md, /CTA: SHOP_NOW/);
  // images
  assert.equal(imageType(TINY_PNG), 'image/png');
  assert.equal(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(imageType(Buffer.from('{"error":"x"}')), null);
  const p = fullPrompt(IMAGE);
  assert.ok(p.startsWith('A paper lantern glowing at dusk on a wooden garden table, warm light, soft background, a clean product photograph'));
  assert.ok(p.endsWith(`. ${POLICY_SUFFIX}`));
  assert.equal(fullPrompt({ prompt: 'A lantern.' }), `A lantern. ${POLICY_SUFFIX}`);
  assert.match(POLICY_SCOPE, /no human faces.*no brand logos.*reject/);
  assert.match(NEGATIVE_PROMPT, /face.*logo/);
  assert.equal(slugOf('Lantern Hero! (v2)'), 'lantern-hero-v2');
  assert.equal(slugOf('', 'general'), 'general');
  assert.match(newId('image', Date.UTC(2026, 9, 11), () => 0.123456789), /^image-2026-10-11-[a-z0-9]{5}$/);
  assert.equal(CREATIVE_DIR, path.join('outbox', 'creative'));
  assert.throws(() => createImageGenerator({}), /needs keyFor/);
});

test('creative.copy: platform limits are refused before the judge; the judge reviews the variants against the product facts with its own scope; the deliverable lands in outbox/creative with the verdict and nothing reaches the Gate', async () => {
  const judgeRef = {};
  const h = await harness({ judgeScripts: () => [[text('{"verdict":"revise","notes":"variant 2 says five days; the facts say within 5 days in the US only"}'), end('end_turn', { inputTokens: 400, outputTokens: 30 })], [text('{"verdict":"approve","notes":"every line is in the facts"}'), end('end_turn', { inputTokens: 400, outputTokens: 20 })]], judgeProvider: judgeRef });
  try {
    const bad = await h.call('c0', 'creative.copy', { ...COPY, variants: [{ headline: 'x'.repeat(41), primaryText: 'p' }, COPY.variants[1]] });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'COPY_LIMIT');
    assert.equal(h.ofType('judge.verdict').length, 0, 'a limit problem never reaches the judge');
    const r1 = await h.call('c1', 'creative.copy', COPY);
    assert.equal(r1.ok, true, r1.error);
    const o1 = out(r1);
    assert.match(o1.id, /^copy-2026-10-11-[a-z0-9]{5}$/);
    assert.equal(o1.path, path.join('outbox', 'creative', 'lantern-co', o1.id, 'copy.md'));
    assert.equal(o1.judge.verdict, 'revise');
    assert.match(r1.output, /The judge says revise: variant 2 says five days.*Fix what the judge named and submit again\./);
    const v = h.ofType('judge.verdict');
    assert.equal(v.length, 1);
    assert.deepEqual(v[0].tools, ['creative.copy']);
    assert.equal(v[0].scope, 'action');
    assert.equal(v[0].agentId, 'ads');
    assert.equal(h.ledger.judgeToday().calls, 1);
    const asked = judgeRef.provider.requests[0].messages[0].content[0].text;
    assert.ok(asked.includes(COPY_REVIEW_SCOPE), 'the judge is asked the copy question, not the brief question');
    assert.ok(!asked.includes('go / no-go'));
    assert.ok(asked.includes('## Product facts'));
    const dir = path.join(h.workspaceRoot, 'ads', 'outbox', 'creative', 'lantern-co', o1.id);
    const rec = JSON.parse(await fsp.readFile(path.join(dir, 'copy.json'), 'utf8'));
    assert.equal(rec.kind, 'copy');
    assert.equal(rec.copy.variants.length, 2);
    assert.equal(rec.judge.notes, 'variant 2 says five days; the facts say within 5 days in the US only');
    assert.match(await fsp.readFile(path.join(dir, 'copy.md'), 'utf8'), /Judge: revise — variant 2/);
    const meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8'));
    assert.deepEqual([meta.kind, meta.platform, meta.variants, meta.agentId, meta.runId, meta.venture], ['copy', 'meta', 2, 'ads', 'run-1', 'lantern-co']);
    const r2 = await h.call('c2', 'creative.copy', { ...COPY, name: 'Lantern launch v2', variants: [{ ...COPY.variants[0] }, { ...COPY.variants[1], primaryText: 'Handmade paper lanterns in three designs. $25 each, shipped flat in the US within five days.' }] });
    assert.equal(out(r2).judge.verdict, 'approve');
    const list = await h.creative.list();
    assert.equal(list.length, 2);
    assert.equal(list[0].name, 'Lantern launch v2', 'newest first');
    assert.equal(list[0].judge.verdict, 'approve');
    assert.equal(list[0].path, path.join('ads', 'outbox', 'creative', 'lantern-co', list[0].id, 'copy.md'));
    assert.equal((await h.creative.list({ kind: 'image' })).length, 0);
    assert.deepEqual(await listCreatives(path.join(h.dir, 'nowhere')), []);
    assert.equal(h.gateQueue.recent(10).length, 0, 'no domain: nothing at the Gate');
    assert.deepEqual(h.ledger.summary().domains, {}, 'and no domain counted');
    // no judge: the deliverable still lands, marked unreviewed, for the Gate to read
    const noJudge = await h.call('c3', 'creative.copy', COPY, h.gateFor({ judge: null }));
    assert.equal(noJudge.ok, true);
    assert.equal(out(noJudge).judge.reason, 'no judge wired');
    assert.match(noJudge.output, /did not review it \(no judge wired\); the Gate will read it/);
  } finally {
    await h.cleanup();
  }
});

test('creative.image: not wired without HF_TOKEN; the judge checks the prompt first and a rejection or a missing judge means no call; an approved prompt generates through the fake with the policy suffix, lands as PNG with its hash, and is metered as a hosted worker call', async () => {
  const fake = await startFakeHfImages();
  const judgeRef = {};
  const scripts = [
    [text('{"verdict":"reject","notes":"the prompt asks for a smiling couple: faces"}'), end('end_turn', { inputTokens: 200, outputTokens: 20 })],
    [text('{"verdict":"approve","notes":"a lantern on a table, no people, no marks"}'), end('end_turn', { inputTokens: 200, outputTokens: 20 })],
    [text('{"verdict":"approve","notes":"fine"}'), end('end_turn', { inputTokens: 200, outputTokens: 20 })],
    [text('{"verdict":"approve","notes":"fine"}'), end('end_turn', { inputTokens: 200, outputTokens: 20 })],
    [text('{"verdict":"approve","notes":"fine"}'), end('end_turn', { inputTokens: 200, outputTokens: 20 })],
    [text('{"verdict":"approve","notes":"fine"}'), end('end_turn', { inputTokens: 200, outputTokens: 20 })],
  ];
  const cold = await harness({ fake, judgeScripts: () => scripts, judgeProvider: judgeRef });
  try {
    assert.deepEqual(await cold.creative.status(), { images: 'not wired (HF_TOKEN)', imageKey: false, model: 'test/tiny-model', judge: true, hostedToday: 0, hostedCap: 2000 });
    const r = await cold.call('i0', 'creative.image', IMAGE);
    assert.equal(r.code, 'NOT_WIRED');
    assert.match(r.error, /set HF_TOKEN/);
    assert.equal(cold.ofType('judge.verdict').length, 0, 'no key: the judge is not spent');
    assert.equal(fake.state.calls.length, 0);
  } finally {
    await cold.cleanup();
  }
  const h = await harness({ fake, env: { HF_TOKEN: fake.token }, judgeScripts: () => scripts, judgeProvider: judgeRef });
  try {
    assert.equal((await h.creative.status()).images, 'huggingface');
    // the policy check refuses faces before any call
    const faces = await h.call('i1', 'creative.image', { ...IMAGE, prompt: 'A smiling couple holding a paper lantern at their wedding' });
    assert.equal(faces.ok, false);
    assert.equal(faces.code, 'POLICY_REJECTED');
    assert.match(faces.error, /no-faces \/ no-logos policy: the prompt asks for a smiling couple: faces\. Rewrite the prompt/);
    assert.equal(fake.state.calls.length, 0, 'nothing was sent to Hugging Face');
    const v1 = h.ofType('judge.verdict')[0];
    assert.deepEqual([v1.verdict, v1.tools[0], v1.scope], ['reject', 'creative.image', 'action']);
    const asked = judgeRef.provider.requests[0].messages[0].content[0].text;
    assert.ok(asked.includes(POLICY_SCOPE));
    assert.ok(asked.includes(`A smiling couple holding a paper lantern at their wedding, a clean product photograph, soft natural light, shallow depth of field. ${POLICY_SUFFIX}`), 'the judge sees the prompt as the model will');
    assert.ok(asked.includes(`Negative prompt: ${NEGATIVE_PROMPT}`));
    // approved: one call, PNG written, metered
    const ok = await h.call('i2', 'creative.image', IMAGE);
    assert.equal(ok.ok, true, ok.error);
    const o = out(ok);
    assert.match(o.id, /^image-2026-10-11-[a-z0-9]{5}$/);
    assert.equal(o.path, path.join('outbox', 'creative', 'lantern-co', o.id, 'lantern-hero.png'));
    assert.deepEqual([o.width, o.height, o.bytes, o.model], [1152, 640, TINY_PNG.length, 'test/tiny-model']);
    assert.deepEqual(o.policy, { verdict: 'approve', notes: 'a lantern on a table, no people, no marks', checkedBy: 'judge', scope: 'prompt', usd: o.policy.usd });
    assert.ok(o.policy.usd > 0);
    assert.match(ok.output, /the image itself was not inspected\. Upload it only through meta_ads.upload_image or google_ads.upload_image_asset, which wait at the Gate under publishing/);
    assert.equal(fake.state.calls.length, 1);
    const c = fake.state.calls[0];
    assert.equal(c.model, 'test/tiny-model');
    assert.equal(c.headers.authorization, `Bearer ${fake.token}`);
    assert.equal(c.headers.accept, 'image/png');
    assert.equal(c.body.inputs, fullPrompt(IMAGE));
    assert.deepEqual(c.body.parameters, { negative_prompt: NEGATIVE_PROMPT, width: 1152, height: 640 });
    const bytes = await fsp.readFile(path.join(h.workspaceRoot, 'ads', o.path));
    assert.ok(bytes.equals(TINY_PNG));
    const meta = JSON.parse(await fsp.readFile(path.join(h.workspaceRoot, 'ads', 'outbox', 'creative', 'lantern-co', o.id, 'meta.json'), 'utf8'));
    assert.equal(meta.kind, 'image');
    assert.equal(meta.sha256, createHash('sha256').update(TINY_PNG).digest('hex'));
    assert.equal(meta.prompt, IMAGE.prompt);
    assert.equal(meta.fullPrompt, fullPrompt(IMAGE));
    assert.equal(meta.provider, 'huggingface');
    assert.deepEqual(meta.policy.scope, 'prompt');
    assert.deepEqual(meta.files, ['lantern-hero.png']);
    const cost = h.ofType('cost.estimate').filter((e) => e.tier === 'hosted_worker');
    assert.equal(cost.length, 1);
    assert.deepEqual([cost[0].provider, cost[0].model, cost[0].usd, cost[0].reconciled, cost[0].runId, cost[0].turn], ['huggingface', 'test/tiny-model', null, false, 'run-1', 1]);
    assert.equal(h.ledger.judgeToday().calls, 2, 'two policy checks');
    assert.equal(h.gateQueue.recent(10).length, 0, 'no domain: nothing at the Gate');
    const list = await h.creative.list({ kind: 'image' });
    assert.equal(list.length, 1);
    assert.deepEqual([list[0].kind, list[0].name, list[0].model, list[0].bytes, list[0].judge.verdict, list[0].path], ['image', 'Lantern hero', 'test/tiny-model', TINY_PNG.length, 'approve', path.join('ads', o.path)]);
    // the platform's failures are named and never carry the token
    fake.state.fail = { status: 503, estimatedTime: 12.3 };
    const loading = await h.call('i3', 'creative.image', IMAGE);
    assert.equal(loading.code, 'MODEL_LOADING');
    assert.match(loading.error, /test\/tiny-model is loading on Hugging Face \(about 13 s\)/);
    fake.state.fail = { status: 500, message: 'boom' };
    const err = await h.call('i4', 'creative.image', IMAGE);
    assert.equal(err.code, 'HF_ERROR');
    assert.match(err.error, /answered 500: \{"error":"boom"\}/);
    fake.state.fail = null;
    fake.state.body = JSON.stringify({ error: 'not an image after all' });
    fake.state.contentType = 'application/json';
    const notImage = await h.call('i5', 'creative.image', IMAGE);
    assert.equal(notImage.code, 'NOT_AN_IMAGE');
    fake.state.body = null;
    fake.state.contentType = 'image/png';
    assert.equal(h.ofType('cost.estimate').filter((e) => e.tier === 'hosted_worker').length, 1, 'a failed call is not metered');
    assert.equal((await h.creative.list()).length, 1, 'a failed call leaves no deliverable');
    for (const r of [loading, err, notImage]) assert.ok(!r.error.includes(fake.token), 'the token never leaks into an error');
    // a wrong token
    const wrong = await harness({ fake, env: { HF_TOKEN: 'hf-wrong' }, judgeScripts: () => [[text('{"verdict":"approve","notes":"fine"}'), end()]] });
    try {
      const r = await wrong.call('i6', 'creative.image', IMAGE);
      assert.equal(r.code, 'HF_AUTH');
      assert.match(r.error, /refused the token \(HF_TOKEN\)/);
      assert.ok(!r.error.includes('hf-wrong'));
    } finally {
      await wrong.cleanup();
    }
    // no judge at all, or a judge that could not review: no image (stricter than the brief)
    const unchecked = await h.call('i7', 'creative.image', IMAGE, h.gateFor({ judge: null }));
    assert.equal(unchecked.code, 'POLICY_UNCHECKED');
    assert.match(unchecked.error, /no judge is wired to check the prompt/);
    const skipped = await h.call('i8', 'creative.image', IMAGE, h.gateFor({ judge: { reviewDocument: async () => ({ verdict: 'skipped', reason: 'judge cap reached: test' }) } }));
    assert.equal(skipped.code, 'POLICY_UNCHECKED');
    assert.match(skipped.error, /could not check the prompt \(judge cap reached: test\)/);
    const revise = await h.call('i9', 'creative.image', IMAGE, h.gateFor({ judge: { reviewDocument: async () => ({ verdict: 'revise', notes: 'maybe' }) } }));
    assert.equal(revise.code, 'POLICY_REJECTED', 'only approve generates');
    assert.equal(fake.state.calls.length, 5, 'i2, i3, i4, i5 and the wrong-token i6 reached the fake; nothing else did');
    // the outbound guard applies: a strict guard refuses the loopback fake before any request
    const guarded = await h.call('i10', 'creative.image', IMAGE, h.gateFor({ judge: { reviewDocument: async () => ({ verdict: 'approve', notes: 'fine' }) } }, { netGuard: createNetGuard() }));
    assert.equal(guarded.ok, false);
    assert.equal(guarded.code, 'NET_GUARD');
    assert.equal(fake.state.calls.length, 5);
  } finally {
    await h.cleanup();
    await fake.close();
  }
  // the strict guard inside the generator itself
  const fake2 = await startFakeHfImages();
  try {
    const strict = createImageGenerator({ keyFor: async () => fake2.token, netGuard: createNetGuard(), baseUrl: fake2.baseUrl, model: 'm' });
    await assert.rejects(strict.generate({ prompt: 'a lantern', width: 64, height: 64 }), (err) => err.code === 'NET_GUARD');
    assert.equal(fake2.state.calls.length, 0);
    const open = createImageGenerator({ keyFor: async () => fake2.token, netGuard: createNetGuard({ allowLocal: true }), baseUrl: `${fake2.baseUrl}/`, model: 'owner/model' });
    const made = await open.generate({ prompt: 'a lantern', width: 64, height: 64 });
    assert.equal(made.contentType, 'image/png');
    assert.equal(fake2.state.calls[0].path, '/models/owner/model');
    fake2.state.body = Buffer.concat([TINY_PNG, Buffer.alloc(IMAGE_LIMIT_BYTES)]);
    await assert.rejects(open.generate({ prompt: 'a lantern', width: 64, height: 64 }), (err) => err.code === 'TOO_LARGE');
  } finally {
    await fake2.close();
  }
});

test('the hosted worker cap covers images: at the cap the call is refused before the judge is spent', async () => {
  const fake = await startFakeHfImages();
  const policy = { ...defaultPolicy(), caps: { ...defaultPolicy().caps, hostedWorkerCallsPerDay: 1 } };
  const h = await harness({ fake, env: { HF_TOKEN: fake.token }, policy, judgeScripts: () => [[text('{"verdict":"approve","notes":"fine"}'), end()]] });
  try {
    assert.equal((await h.creative.status()).hostedCap, 1);
    await h.ledger.recordHosted({ tokens: 10 }); // a hosted worker turn earlier today
    const r = await h.call('i1', 'creative.image', IMAGE);
    assert.equal(r.code, 'HOSTED_CAP');
    assert.match(r.error, /daily cap of 1 call\(s\); image generation counts against it/);
    assert.equal(h.ofType('judge.verdict').length, 0);
    assert.equal(fake.state.calls.length, 0);
    assert.equal((await h.creative.status()).hostedToday, 1);
  } finally {
    await h.cleanup();
    await fake.close();
  }
});

test('through the sidecar: an Ads Ranger writes copy and generates an image in one run; the image is counted in the ledger as a hosted call; /api/creative, /api/creatives and the snapshot show them; nothing waits at the Gate', async () => {
  const fake = await startFakeHfImages();
  const layout = defaultLayout();
  layout.rooms.push({ id: 'marketing', name: 'Marketing Camp', kind: 'marketing', x: 21, y: 1, w: 8, h: 6 });
  layout.objects.push({ id: 'board', kind: 'notice_board', roomId: 'marketing', x: 22, y: 2 });
  layout.agents.push({ id: 'ads', name: 'Ada', roomId: 'marketing', x: 21, y: 1, role: 'ranger', specialty: 'ads' });
  const worker = fakeProvider([
    [...toolCall('t1', 'creative.copy', COPY), end('tool_use')],
    [...toolCall('t2', 'creative.image', IMAGE), end('tool_use')],
    [text('Copy and image are in outbox/creative; upload needs the Gate.'), end()],
  ]);
  const judgeProvider = async (name, opts) => ({ provider: fakeProvider([[text('{"verdict":"approve","notes":"grounded"}'), end('end_turn', { inputTokens: 300, outputTokens: 20 })], [text('{"verdict":"approve","notes":"no people, no marks"}'), end('end_turn', { inputTokens: 300, outputTokens: 20 })], [text('{"verdict":"approve","notes":"final answer fine"}'), end('end_turn', { inputTokens: 200, outputTokens: 10 })]], { name }), model: opts.model || 'm', price: { inputPerMTok: 2, outputPerMTok: 10 } });
  const srv = await startTestServer({ layout, makeProvider: async () => ({ provider: worker, model: 'm', price: null }), judgeProvider, env: { HF_TOKEN: fake.token }, creative: { hfImagesBaseUrl: fake.baseUrl, imageModel: 'test/tiny-model' } });
  try {
    const st = await srv.get('/api/creative');
    assert.deepEqual(st.body, { images: 'huggingface', imageKey: true, model: 'test/tiny-model', judge: true, hostedToday: 0, hostedCap: 2000 });
    assert.equal((await srv.get('/api/state')).body.creative.imageKey, true);
    assert.deepEqual((await srv.get('/api/creatives')).body, []);
    const stream = await srv.sse();
    const r = await srv.post('/api/run', { prompt: 'Write two copy variants and one hero image for the lanterns.', agentId: 'ads' });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const start = await stream.waitFor((e) => e.type === 'agent.run.start' && e.payload.runId === r.body.runId);
    for (const t of ['creative.copy', 'creative.image']) assert.ok(start.payload.tools.includes(t), t);
    await stream.waitFor((e) => e.type === 'agent.run.end' && e.payload.runId === r.body.runId, 10000);
    await srv.runs.waitForIdle();
    const results = stream.events.filter((e) => e.type === 'agent.tool_result').map((e) => e.payload);
    assert.match(results.find((x) => x.callId === 't1').output, /The judge says approve: grounded/);
    assert.match(results.find((x) => x.callId === 't2').output, /lantern-hero\.png/);
    const verdicts = stream.events.filter((e) => e.type === 'judge.verdict').map((e) => e.payload);
    assert.deepEqual(verdicts.map((v) => v.tools && v.tools[0]).filter(Boolean), ['creative.copy', 'creative.image']);
    const hosted = stream.events.filter((e) => e.type === 'cost.estimate' && e.payload.tier === 'hosted_worker');
    assert.equal(hosted.length, 1);
    assert.equal(hosted[0].payload.runId, r.body.runId);
    const state = (await srv.get('/api/state')).body;
    assert.equal(state.ledger.hosted.calls, 1, 'the run manager counted the image as a hosted call');
    assert.equal(state.creative.hostedToday, 1);
    const rows = (await srv.get('/api/creatives')).body;
    assert.deepEqual(rows.map((x) => x.kind), ['image', 'copy']);
    assert.equal(rows[0].agentId, 'ads');
    assert.equal(rows[0].runId, r.body.runId);
    assert.equal((await srv.get('/api/creatives?kind=copy')).body.length, 1);
    assert.deepEqual((await srv.get('/api/gate')).body.pending, []);
    assert.equal(fake.prompts().length, 1);
    assert.ok(fake.prompts()[0].endsWith(POLICY_SUFFIX));
    stream.close();
  } finally {
    await srv.close();
    await fake.close();
  }
});
