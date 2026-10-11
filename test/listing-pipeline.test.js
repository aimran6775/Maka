// Phase 4 step 13: the listing pipeline end to end, driven by the starter recipe
// "launch-etsy-listing" against a fake Etsy, a fake Hugging Face and a fake judge: product
// data → copy (judge) → image (judge) → draft listing (Gate, publishing) → price (Gate,
// money in) → publish (Gate, publishing). Every link is read from an event or a file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { defaultLayout, OBJECT_KINDS } from '../shared/world.js';
import { ETSY_SCOPES, etsySpec } from '../sidecar/connectors/etsy.js';
import { fakeProvider, text, end, toolCall } from './helpers/fake-provider.js';
import { startTestServer } from './helpers/test-server.js';
import { startFakeEtsy } from './helpers/fake-etsy.js';
import { startFakeHfImages } from './helpers/fake-hf-images.js';

const FACTS = 'hand-folded rice paper over a bamboo frame, 25 cm tall, ships in 2 days, keep away from open flame';

// The Rangers' worker, one script for every run: it answers by the recipe step named in the
// brief and by the turn (the previous tool's result is the last message).
function listingWorker(seen) {
  const stepOf = (req) => (/step ([a-z-]+) "/.exec(req.messages[0].content[0].text) || [])[1] || null;
  const lastResult = (req) => { try { return JSON.parse(String(req.messages.at(-1).content[0].content).split('\n')[0]); } catch { return null; } };
  return fakeProvider(Array(40).fill((req) => {
    const step = stepOf(req);
    const turn = req.messages.length;
    seen.push(`${step}:${turn}`);
    if (step === 'product-data') {
      if (turn === 1) return [...toolCall('pd1', 'fs.write', { path: 'outbox/listings/lantern-co/product.json', content: JSON.stringify({ product: 'Paper lantern, red', facts: FACTS, price: 25, quantity: 5, venture: 'lantern-co' }) }), end('tool_use')];
      if (turn === 3) return [...toolCall('pd2', 'fs.write', { path: 'outbox/listings/lantern-co/product.md', content: `# Paper lantern, red\n\n${FACTS}\n` }), end('tool_use')];
      return [text('Product data written.'), end()];
    }
    if (step === 'copy') {
      if (turn === 1) return [...toolCall('cp1', 'creative.copy', { venture: 'lantern-co', name: 'lantern-co-listing', platform: 'generic', product: FACTS, variants: [{ headline: 'Red paper lantern, hand-folded rice paper on bamboo, 25 cm', description: 'A hand-folded rice paper lantern on a bamboo frame, 25 cm tall. Ships in 2 days. Keep away from open flame.' }, { headline: 'Hand-folded red rice paper lantern, 25 cm', description: 'Rice paper over bamboo, 25 cm, ships in 2 days; keep away from open flame.' }] }), end('tool_use')];
      if (turn === 3) return [...toolCall('cp2', 'fs.write', { path: 'outbox/listings/lantern-co/copy.md', content: '# Recommended: variant 1\n\nRed paper lantern, hand-folded rice paper on bamboo, 25 cm\n\nTags: lantern, paper, bamboo, red\n' }), end('tool_use')];
      return [text('Copy written and reviewed.'), end()];
    }
    if (step === 'image') {
      if (turn === 1) return [...toolCall('im1', 'creative.image', { venture: 'lantern-co', name: 'lantern-co-listing', prompt: 'a red paper lantern on a plain wooden table, soft daylight', style: 'photo', size: 'square' }), end('tool_use')];
      return [text('Image generated.'), end()];
    }
    if (step === 'draft-listing') {
      if (turn === 1) return [...toolCall('dl1', 'etsy.create_listing', { title: 'Red paper lantern, hand-folded rice paper on bamboo, 25 cm', description: 'A hand-folded rice paper lantern on a bamboo frame, 25 cm tall. Ships in 2 days. Keep away from open flame.', price: 20, quantity: 5, whoMade: 'i_did', whenMade: 'made_to_order', taxonomyId: 1, tags: ['lantern', 'paper', 'bamboo', 'red'] }), end('tool_use')];
      if (turn === 3) { const r = lastResult(req); return [...toolCall('dl2', 'fs.write', { path: 'outbox/listings/lantern-co/listing.json', content: JSON.stringify({ listingId: r && r.listingId, state: r && r.state, price: 20 }) }), end('tool_use')]; }
      return [text('Draft listing created.'), end()];
    }
    if (step === 'price') {
      if (turn === 1) return [...toolCall('rd1', 'fs.read', { path: 'outbox/listings/lantern-co/listing.json' }), end('tool_use')];
      if (turn === 3) { const text0 = String(req.messages.at(-1).content[0].content); const id = Number((/\\?"listingId\\?":\s*(\d+)/.exec(text0) || [])[1]); return [...toolCall('pr1', 'etsy.set_price', { listingId: id, price: 25 }), end('tool_use')]; }
      return [text('Price set to 25.'), end()];
    }
    if (step === 'publish') {
      if (turn === 1) return [...toolCall('rd2', 'fs.read', { path: 'outbox/listings/lantern-co/listing.json' }), end('tool_use')];
      if (turn === 3) { const text0 = String(req.messages.at(-1).content[0].content); const id = Number((/\\?"listingId\\?":\s*(\d+)/.exec(text0) || [])[1]); return [...toolCall('pb1', 'etsy.update_listing', { listingId: id, state: 'active' }), end('tool_use')]; }
      return [text('Published.'), end()];
    }
    return [text('Nothing to do.'), end()];
  }));
}

test('the Park Store grants creative.copy; the recipe asks for it on the copy step', async () => {
  assert.ok(OBJECT_KINDS.park_store.grants.includes('creative.copy'));
  assert.ok(!OBJECT_KINDS.park_store.grants.includes('creative.image'));
  const recipe = JSON.parse(await fsp.readFile(path.join(process.cwd(), 'recipes', 'starter', 'launch-etsy-listing.json'), 'utf8'));
  assert.deepEqual(recipe.steps.find((s) => s.id === 'copy').fixtures, ['supply_cache', 'park_store']);
  assert.deepEqual(recipe.steps.find((s) => s.id === 'image').fixtures, ['supply_cache', 'notice_board']);
});

test('the listing pipeline end to end: six steps along the trails, the judge on copy and image, the Gate on the draft, the price and the activation, a live listing on the fake Etsy, every file in place', async () => {
  const etsy = await startFakeEtsy();
  const hf = await startFakeHfImages();
  const layout = defaultLayout();
  layout.rooms.push({ id: 'listings', name: 'Listings Camp', kind: 'product_listings', x: 21, y: 1, w: 8, h: 6 });
  layout.rooms.push({ id: 'marketing', name: 'Marketing Camp', kind: 'marketing', x: 31, y: 1, w: 8, h: 6 });
  layout.objects.push({ id: 'cache-l', kind: 'supply_cache', roomId: 'listings', x: 22, y: 2 }, { id: 'store', kind: 'park_store', roomId: 'listings', x: 23, y: 2 });
  layout.objects.push({ id: 'cache-m', kind: 'supply_cache', roomId: 'marketing', x: 32, y: 2 }, { id: 'board', kind: 'notice_board', roomId: 'marketing', x: 33, y: 2 });
  layout.agents.push({ id: 'sam', name: 'Sam', roomId: 'listings', x: 21, y: 1, role: 'ranger', specialty: 'storefront', venture: 'lantern-co' });
  layout.agents.push({ id: 'ada', name: 'Ada', roomId: 'marketing', x: 31, y: 1, role: 'ranger', specialty: 'ads', venture: 'lantern-co' });
  const seen = [];
  const worker = listingWorker(seen);
  const judgeCalls = [];
  const judgeProvider = async (name, opts) => ({ provider: fakeProvider(Array(30).fill((req) => { judgeCalls.push(req.messages[0].content[0].text.slice(0, 120)); return [text('{"verdict":"approve","notes":"grounded in the facts"}'), end('end_turn', { inputTokens: 200, outputTokens: 20 })]; }), { name }), model: opts.model || 'judge', price: { inputPerMTok: 2, outputPerMTok: 10 } });
  const srv = await startTestServer({
    layout,
    withChief: true,
    makeProvider: async () => ({ provider: worker, model: 'm', price: null }),
    judgeProvider,
    env: { HF_TOKEN: hf.token },
    keys: { etsyClientId: etsy.clientId, etsy: { accessToken: 'at_seed', refreshToken: 'rt_seed', expiresAt: Date.now() + 3600_000, scope: ETSY_SCOPES.join(' '), tokenType: 'Bearer' } },
    connectors: [etsySpec({ baseUrl: etsy.baseUrl, authorizeUrl: etsy.authorizeUrl, tokenUrl: etsy.tokenUrl })],
    connectorConfig: { oauthPort: 0 },
    creative: { hfImagesBaseUrl: hf.baseUrl, imageModel: 'test/tiny-model' },
    permissionTimeoutMs: 5000,
  });
  // The Superintendent at the Gate: allows every file write, approves every Gate item.
  const decided = [];
  const stopApprover = srv.bus.listen((e) => {
    if (e.type === 'permission.prompt') srv.post('/api/permission', { promptId: e.payload.promptId, runId: e.payload.runId, allow: true }).catch(() => {});
    if (e.type === 'gate.item' && e.payload.status === 'pending' && e.payload.kind === 'action') {
      decided.push({ tool: e.payload.tool, domain: e.payload.domain, amountUsd: e.payload.amountUsd ?? null, agentId: e.payload.agentId });
      srv.post(`/api/gate/${e.payload.itemId}`, { decision: 'approve', notes: 'reviewed' }).catch(() => {});
    }
  });
  try {
    await srv.connectors.booted;
    assert.equal((await srv.get('/api/connectors')).body.find((c) => c.kind === 'etsy').connected, true, 'Etsy connected from the seeded keystore');
    const before = etsy.state.listings.length;
    const stream = await srv.sse();
    // The plan is clean: every step has its Ranger and its fixtures; publishing and money_in are at draft (the recipe asks draft).
    const plan = (await srv.post('/api/recipes/launch-etsy-listing/plan', { ventureId: 'lantern-co', params: { venture: 'lantern-co', product: 'Paper lantern, red', facts: FACTS, price: '25' } })).body;
    assert.equal(plan.ok, true, JSON.stringify(plan.problems));
    assert.deepEqual(plan.order, ['product-data', 'copy', 'image', 'draft-listing', 'price', 'publish']);
    assert.equal(plan.assignments.copy.agentId, 'sam');
    assert.equal(plan.assignments.image.agentId, 'ada');
    assert.deepEqual(plan.notes, []);
    assert.equal(plan.params.quantity, '5', 'the default');
    const run = await srv.post('/api/recipes/launch-etsy-listing/run', { ventureId: 'lantern-co', params: { venture: 'lantern-co', product: 'Paper lantern, red', facts: FACTS, price: '25' } });
    assert.equal(run.status, 202, JSON.stringify(run.body));
    const finished = await stream.waitFor((e) => e.type === 'recipe.run' && e.payload.recipeRunId === run.body.id && ['done', 'failed'].includes(e.payload.status), 60000);
    const record = (await srv.get(`/api/recipe-runs/${run.body.id}`)).body;
    assert.equal(finished.payload.status, 'done', JSON.stringify({ notes: record.notes, steps: Object.fromEntries(Object.entries(record.steps).map(([k, v]) => [k, [v.status, v.summary.slice(0, 120)]])), seen }));
    await srv.runs.waitForIdle();
    // The order of the steps along the trails: both copy and image after the product data.
    const stepEvents = stream.events.filter((e) => e.type === 'recipe.run' && e.payload.recipeRunId === run.body.id).map((e) => e.payload.stepId || e.payload.status);
    assert.deepEqual(stepEvents, ['started', 'product-data', 'copy', 'image', 'draft-listing', 'price', 'publish', 'done']);
    for (const [id, to] of [['product-data', 'sam'], ['copy', 'sam'], ['image', 'ada'], ['draft-listing', 'sam'], ['price', 'sam'], ['publish', 'sam']]) assert.equal(record.steps[id].agentId, to, id);
    assert.ok(stream.events.some((e) => e.type === 'work.handoff' && e.payload.toAgentId === 'ada' && e.payload.toRoomId === 'marketing'), 'the image step walked the trail to the Marketing camp');
    // The judge reviewed the copy against the facts and the image prompt under the policy.
    const verdicts = stream.events.filter((e) => e.type === 'judge.verdict' && e.payload.tools);
    assert.ok(verdicts.some((v) => v.payload.tools[0] === 'creative.copy' && v.payload.verdict === 'approve'), 'copy reviewed');
    assert.ok(verdicts.some((v) => v.payload.tools[0] === 'creative.image' && v.payload.verdict === 'approve'), 'image prompt reviewed');
    assert.ok(judgeCalls.some((q) => /ad copy|product facts/i.test(q)) || verdicts.length >= 2);
    // The Gate saw the draft listing and the activation as publishing and the price as money in, each from Sam.
    const toolLog = stream.events.filter((e) => e.type === 'agent.tool_result' && /^(rd|pr|pb)/.test(e.payload.callId)).map((e) => `${e.payload.callId}: ok=${e.payload.ok} ${(e.payload.error || e.payload.output || '').slice(0, 160)}`);
    assert.deepEqual(decided.map((d) => [d.tool, d.domain, d.agentId]), [['etsy.create_listing', 'publishing', 'sam'], ['etsy.set_price', 'money_in', 'sam'], ['etsy.update_listing', 'publishing', 'sam']], JSON.stringify({ toolLog, seen }));
    assert.equal(decided[1].amountUsd, 0, 'a price change moves no money: a proven $0 at the Gate');
    // The fake Etsy holds the new listing: created as a draft, price 25 through the inventory, active after the approval.
    assert.equal(etsy.state.listings.length, before + 1);
    const created = etsy.state.listings[0];
    assert.equal(created.title, 'Red paper lantern, hand-folded rice paper on bamboo, 25 cm');
    assert.equal(created.state, 'active');
    assert.equal(Number(created.price.amount) / created.price.divisor, 25);
    const calls = etsy.state.calls.map((c) => `${c.method} ${c.path.replace(/^\/v3\/application/, '').replace(/\?.*/, '')}`);
    assert.ok(calls.includes(`POST /shops/${etsy.state.shop.shop_id}/listings`));
    assert.ok(calls.includes(`PUT /listings/${created.listing_id}/inventory`));
    assert.ok(calls.includes(`PATCH /shops/${etsy.state.shop.shop_id}/listings/${created.listing_id}`));
    const order = ['POST /shops', 'PUT /listings', 'PATCH /shops'].map((k) => calls.findIndex((c) => c.startsWith(k)));
    assert.ok(order[0] < order[1] && order[1] < order[2], 'draft, then price, then activation');
    // Files: the product sheet, the copy and the listing record in Sam's outbox; the copy kit and the image in the creative folders.
    const sam = path.join(srv.workspaceRoot, 'sam', 'outbox');
    const listing = JSON.parse(await fsp.readFile(path.join(sam, 'listings', 'lantern-co', 'listing.json'), 'utf8'));
    assert.equal(listing.listingId, created.listing_id);
    assert.equal(listing.state, 'draft', 'the record was written when the listing was still a draft');
    assert.match(await fsp.readFile(path.join(sam, 'listings', 'lantern-co', 'copy.md'), 'utf8'), /Recommended: variant 1/);
    const copies = (await srv.get('/api/creatives?kind=copy')).body;
    assert.equal(copies.length, 1);
    assert.equal(copies[0].agentId, 'sam');
    assert.equal(copies[0].venture, 'lantern-co');
    const images = (await srv.get('/api/creatives?kind=image')).body;
    assert.equal(images.length, 1);
    assert.equal(images[0].agentId, 'ada');
    assert.ok(await fsp.stat(path.join(srv.workspaceRoot, images[0].path)), 'the image path is relative to the workspace root');
    assert.equal(hf.prompts().length, 1);
    // The success check and the deliverables.
    assert.equal(record.success.ok, true);
    assert.deepEqual(record.success.missing, []);
    assert.deepEqual(record.steps['product-data'].deliverables.sort(), ['outbox/listings/lantern-co/product.json', 'outbox/listings/lantern-co/product.md']);
    assert.deepEqual(record.steps['draft-listing'].deliverables, ['outbox/listings/lantern-co/listing.json']);
    // The results engine attributed the listing to Lantern Co through Sam's own write.
    assert.equal(srv.results.attribution().etsy.listing[String(created.listing_id)].venture, 'lantern-co');
    // Nothing published without the Gate: every write to Etsy followed an approval.
    const approvals = stream.events.filter((e) => e.type === 'gate.item' && e.payload.status === 'approved').length;
    assert.equal(approvals, 3);
    stream.close();
  } finally {
    stopApprover();
    await srv.close();
    await etsy.close();
    await hf.close();
  }
});
