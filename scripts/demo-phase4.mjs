#!/usr/bin/env node
// The phase 4 demo against the fakes (docs/PHASE4_BRIEF.md step 20 "Done means"): boots a
// test sidecar with scripted providers and fake services (research, Etsy, Hugging Face
// images, Meta Ads, the Telegram Bot API), then walks the chain and checks each link with
// real events: mission → the Scout's brief, judged against the Scout's memory and decided by
// the Chief → the listing pipeline recipe to a draft listing on the fake Etsy → an ad set
// and a creative from the Marketing camp wait at the Entrance Gate → the Gate card on the
// paired Telegram chat, Approve through the fake Bot API → the results rollup → the
// reflection's briefing lands in station mail. Nothing is simulated: every check reads an
// event, a fake server's log or a file the sidecar wrote. Exit 1 on the first broken link.
//
//   node scripts/demo-phase4.mjs

import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { startTestServer } from '../test/helpers/test-server.js';
import { fakeProvider, text, toolCall, end, waitUntil } from '../test/helpers/fake-provider.js';
import { startFakeResearch } from '../test/helpers/fake-research.js';
import { startFakeEtsy } from '../test/helpers/fake-etsy.js';
import { startFakeHfImages } from '../test/helpers/fake-hf-images.js';
import { startFakeMetaAds } from '../test/helpers/fake-meta-ads.js';
import { startFakeTelegram } from '../test/helpers/fake-telegram.js';
import { createTelegramAdapter } from '../sidecar/channels/telegram.js';
import { createNetGuard } from '../sidecar/netguard.js';
import { ETSY_SCOPES, etsySpec } from '../sidecar/connectors/etsy.js';
import { metaAdsSpec } from '../sidecar/connectors/meta-ads.js';
import { defaultLayout } from '../shared/world.js';

const CHIEF_PRICE = { inputPerMTok: 4, outputPerMTok: 20 };
const CHIEF_USAGE = { inputTokens: 1000, outputTokens: 100 };
const JUDGE_USAGE = { inputTokens: 300, outputTokens: 20 };
const FACTS = 'hand-folded rice paper over a bamboo frame, 25 cm tall, ships in 2 days, keep away from open flame';
const PLAN = {
  summary: 'One venture: Lantern Co. Scout the niche, launch the first listing, then a small ad set.',
  ventures: [{ id: 'lantern-co', name: 'Lantern Co', summary: 'Paper lanterns sold on Etsy with small Meta ad budgets.', budgetUsd: 5, roles: [{ specialty: 'scout', name: 'Sky' }], tasks: [{ id: 't1', title: 'Scout the lantern niche', specialty: 'scout', brief: 'Write the venture brief for paper lanterns on Etsy.', budgetUsd: 1 }] }],
  risks: ['Seasonal demand'],
  needsSuperintendent: [],
};
const BRIEF = {
  ventureId: 'lantern-co',
  title: 'Paper lanterns on Etsy',
  summary: 'Handmade paper lanterns, $25 each, sold on Etsy with small ad budgets.',
  opportunity: 'Lantern sales grew 40 % this year on handmade marketplaces; makers report waiting lists.',
  evidence: [
    { claim: 'Lanterns sold 40 % more this year', source: 'https://stats.example/report-2026', date: '2026-09-01' },
    { claim: 'Makers have waiting lists of weeks', source: 'https://trailtimes.example/lanterns', date: '2026-09-30' },
  ],
  costs: [{ item: 'Materials per lantern', usd: 6, basis: 'Trail Times quotes a unit cost near $6', recurring: 'per_unit' }],
  revenueModel: '$25 per lantern, 30 a month at first.',
  risks: ['Seasonal demand'],
  recommendation: 'go',
  confidence: 0.7,
  niche: 'Garden Lanterns',
  channel: 'etsy',
  estimates: { monthlyRevenueUsd: 750, ordersPerMonth: 30, monthlyAdSpendUsd: 100, contributionPerOrderUsd: 15 },
};
const REFLECTION = {
  portfolio: 'Lantern Co: the brief is a go, the first listing is live on Etsy, one ad set waits paused; results so far come from the ledgers only.',
  ventures: [{ id: 'lantern-co', worked: ['brief recorded and decided', 'listing pipeline done', 'ad set created paused'], didNot: ['no orders yet'], planStillRight: true, revisions: [], morale: 'Sky, Sam, Ada and Mia finished their tasks on budget.' }],
  briefings: [{ zoneId: 'marketing', text: 'Marketing: one ad set created paused at $20 a day; keep it paused until the listing has its first order.' }],
};

function step(n, label) { console.log(`\n[${n}] ${label}`); }
function check(cond, what) {
  if (!cond) { console.error(`    ✗ ${what}`); process.exit(1); }
  console.log(`    ✓ ${what}`);
}

// The Rangers' worker: one script for every run, dispatching on the Ranger and, for the
// recipe, on the step named in the brief.
function worker(seen) {
  const stepOf = (req) => (/step ([a-z-]+) "/.exec(req.messages[0].content[0].text) || [])[1] || null;
  const lastResult = (req) => { try { return JSON.parse(String(req.messages.at(-1).content[0].content).split('\n')[0]); } catch { return null; } };
  const listingId = (req) => Number((/\\?"listingId\\?":\s*(\d+)/.exec(String(req.messages.at(-1).content[0].content)) || [])[1]);
  return fakeProvider(Array(60).fill((req) => {
    const turn = req.messages.length;
    const step = stepOf(req);
    if (step) seen.push(`${step}:${turn}`);
    const prompt = req.messages[0].content[0].text || '';
    if (/venture brief/i.test(prompt)) {
      if (turn === 1) return [...toolCall('b1', 'brief.submit', BRIEF), end('tool_use')];
      return [text('Brief submitted.'), end()];
    }
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
      if (turn === 3) return [...toolCall('pr1', 'etsy.set_price', { listingId: listingId(req), price: 25 }), end('tool_use')];
      return [text('Price set to 25.'), end()];
    }
    if (step === 'publish') {
      if (turn === 1) return [...toolCall('rd2', 'fs.read', { path: 'outbox/listings/lantern-co/listing.json' }), end('tool_use')];
      if (turn === 3) return [...toolCall('pb1', 'etsy.update_listing', { listingId: listingId(req), state: 'active' }), end('tool_use')];
      return [text('Published.'), end()];
    }
    if (/first ad set/.test(prompt)) {
      if (turn === 1) return [...toolCall('ad1', 'meta_ads.create_adset', { campaignId: 'c1', name: 'Lanterns – US 25-54', dailyBudget: 20, targeting: { countries: ['US'], ageMin: 25, ageMax: 54 }, optimizationGoal: 'LINK_CLICKS', billingEvent: 'IMPRESSIONS' }), end('tool_use')];
      if (turn === 3) return [...toolCall('ad2', 'meta_ads.create_creative', { name: 'Lantern hero', message: 'Light your evenings with a hand-folded paper lantern.', headline: 'Handmade paper lanterns', description: 'Ships in 2 days', link: 'https://lanterns.example/red', imageHash: 'h1', callToAction: 'SHOP_NOW' }), end('tool_use')];
      return [text('Ad set created paused and the creative made; nothing is live.'), end()];
    }
    return [text('Nothing to do.'), end()];
  }));
}

async function main() {
  const research = await startFakeResearch();
  const etsy = await startFakeEtsy();
  const hf = await startFakeHfImages();
  const meta = await startFakeMetaAds();
  const telegram = await startFakeTelegram();
  const layout = defaultLayout();
  layout.rooms.push({ id: 'research', name: 'Research Camp', kind: 'research', x: 21, y: 1, w: 8, h: 6 });
  layout.rooms.push({ id: 'listings', name: 'Listings Camp', kind: 'product_listings', x: 31, y: 1, w: 8, h: 6 });
  layout.rooms.push({ id: 'marketing', name: 'Marketing Camp', kind: 'marketing', x: 41, y: 1, w: 8, h: 6 });
  layout.objects.push({ id: 'sign', kind: 'trailhead_sign', roomId: 'research', x: 22, y: 2 });
  layout.objects.push({ id: 'cache-l', kind: 'supply_cache', roomId: 'listings', x: 32, y: 2 }, { id: 'store', kind: 'park_store', roomId: 'listings', x: 33, y: 2 });
  layout.objects.push({ id: 'cache-m', kind: 'supply_cache', roomId: 'marketing', x: 42, y: 2 }, { id: 'board', kind: 'notice_board', roomId: 'marketing', x: 43, y: 2 });
  layout.agents.push({ id: 'sky', name: 'Sky', roomId: 'research', x: 21, y: 1, role: 'ranger', specialty: 'scout', venture: 'lantern-co' });
  layout.agents.push({ id: 'sam', name: 'Sam', roomId: 'listings', x: 31, y: 1, role: 'ranger', specialty: 'storefront', venture: 'lantern-co' });
  layout.agents.push({ id: 'ada', name: 'Ada', roomId: 'marketing', x: 41, y: 1, role: 'ranger', specialty: 'ads', venture: 'lantern-co' });
  layout.agents.push({ id: 'mia', name: 'Mia', roomId: 'marketing', x: 42, y: 1, role: 'ranger', specialty: 'ads', venture: 'lantern-co' });

  let briefId = null;
  // The Chief dispatches on what it is asked: the mission (plan, then delegate), the brief
  // decision, the reflection; every follow-up after a finished work item is a short note.
  let planned = false;
  const chief = fakeProvider(Array(30).fill((req) => {
    const prompt = req.messages[0].content[0].text || '';
    const turn = req.messages.length;
    if (/Decide on the lantern brief/.test(prompt)) {
      if (turn === 1) return [...toolCall('g1', 'brief.decide', { briefId, decision: 'go', ventureId: 'lantern-co', reason: 'the evidence holds and the costs are real' }), end('tool_use', CHIEF_USAGE)];
      return [text('Decided: go.'), end('end_turn', CHIEF_USAGE)];
    }
    if (!planned) {
      if (turn === 1) return [...toolCall('p1', 'plan.submit', PLAN), end('tool_use', CHIEF_USAGE)];
      if (turn === 3) return [...toolCall('d1', 'delegate', { toAgentId: 'sky', brief: PLAN.ventures[0].tasks[0].brief, budgetUsd: 1 }), end('tool_use', CHIEF_USAGE)];
      planned = true;
      return [text('Delegated the brief to Sky.'), end('end_turn', CHIEF_USAGE)];
    }
    return [text('Noted.'), end('end_turn', CHIEF_USAGE)];
  }), { name: 'anthropic' });
  const judgeCalls = [];
  // The judge tier reviews every brief, copy, image prompt and action; the reflection runs
  // on the same tier and answers with the document.
  const judge = fakeProvider(Array(40).fill((req) => {
    judgeCalls.push(req.messages[0].content[0].text);
    if (/reflecting on the portfolio/.test(req.system || '')) return [text(`Reflection: ${JSON.stringify(REFLECTION)}`), end('end_turn', { inputTokens: 2000, outputTokens: 400 })];
    return [text('{"verdict":"approve","notes":"grounded in the evidence"}'), end('end_turn', JUDGE_USAGE)];
  }), { name: 'anthropic' });
  const seen = [];
  const rangers = worker(seen);
  const makeProvider = async (name, opts) => (name === 'anthropic' ? { provider: chief, model: opts.model || 'claude-opus-5-5', price: CHIEF_PRICE } : { provider: rangers, model: 'local-worker', price: null });
  const judgeProvider = async (name, opts) => ({ provider: judge, model: opts.model || 'judge', price: { inputPerMTok: 2, outputPerMTok: 10 } });
  const tg = createTelegramAdapter({ baseUrl: telegram.url, netGuard: createNetGuard({ allowLocal: true }), pollTimeoutS: 1, log: { warn() {}, error() {} } });
  const srv = await startTestServer({
    layout, makeProvider, judgeProvider, withChief: true, maxConcurrent: 3,
    env: { HF_TOKEN: hf.token, META_ACCESS_TOKEN: meta.accessToken, META_PAGE_ID: '777', TELEGRAM_BOT_TOKEN: telegram.token, BRAVE_SEARCH_API_KEY: research.braveKey },
    research: research.endpoints,
    keys: { etsyClientId: etsy.clientId, etsy: { accessToken: 'at_seed', refreshToken: 'rt_seed', expiresAt: Date.now() + 3600_000, scope: ETSY_SCOPES.join(' '), tokenType: 'Bearer' } },
    connectors: [etsySpec({ baseUrl: etsy.baseUrl, authorizeUrl: etsy.authorizeUrl, tokenUrl: etsy.tokenUrl }), metaAdsSpec({ baseUrl: meta.url })],
    connectorConfig: { oauthPort: 0, syncOnBoot: false, meta_ads: { adAccountId: '123' } },
    creative: { hfImagesBaseUrl: hf.baseUrl, imageModel: 'demo/tiny-model' },
    channels: [tg],
    permissionTimeoutMs: 10000,
  });
  const stream = await srv.sse();
  const waitFor = (pred, label, ms = 20000) => stream.waitFor(pred, ms).catch(() => {
    console.error(`    ✗ timed out waiting for ${label}`);
    for (const e of stream.events.slice(-12)) console.error(`      ${e.type} ${JSON.stringify(e.payload).slice(0, 300)}`);
    process.exit(1);
  });
  // The Superintendent at the Gate for the pipeline only: file writes are allowed, and the
  // pipeline's own Gate items (publishing, money in) are approved from the Peak. The ad
  // set's money out is left for the phone.
  const approvedFromPeak = [];
  const stopApprover = srv.bus.listen((e) => {
    if (e.type === 'permission.prompt') srv.post('/api/permission', { promptId: e.payload.promptId, runId: e.payload.runId, allow: true }).catch(() => {});
    if (e.type === 'gate.item' && e.payload.status === 'pending' && e.payload.kind === 'action' && /^etsy\./.test(e.payload.tool)) {
      approvedFromPeak.push([e.payload.tool, e.payload.domain]);
      srv.post(`/api/gate/${e.payload.itemId}`, { decision: 'approve', notes: 'reviewed at the Peak' }).catch(() => {});
    }
  });
  try {
    step(1, 'Four camps, the fakes connected: Etsy from the keystore, Meta Ads and the Telegram bot from the environment');
    await srv.connectors.booted;
    const connectors = (await srv.get('/api/connectors')).body;
    check(connectors.find((c) => c.kind === 'etsy').connected && connectors.find((c) => c.kind === 'meta_ads').connected, 'Etsy and Meta Ads connected');
    await srv.post('/api/connectors/meta_ads/sync', {});
    const chan = (await srv.get('/api/channels')).body.adapters[0];
    check(chan.name === 'telegram' && chan.status === 'up', `Telegram ${chan.detail}`);
    const code = (await srv.post('/api/channels/pair', {})).body.code;
    telegram.message({ chatId: 42, userId: 42, text: code });
    await waitFor((e) => e.type === 'channel.inbound' && e.payload.outcome === 'paired', 'pairing');
    check(true, 'the phone is paired with the Peak through the pairing code');
    const memory0 = (await srv.get('/api/scout-memory')).body;
    check(memory0.totals.briefs === 0 && /no venture brief is recorded yet/.test(memory0.promptLines[0]), "the Scout's memory is empty");

    step(2, 'Mission → the Chief plans on the judge tier and delegates the brief to Sky, the Scout');
    const mission = await srv.post('/api/mission', { text: 'Run Lantern Co: scout, list, then a small ad set.', budgetUsd: 10, horizon: '30 days' });
    check(mission.status === 202, `mission accepted (${mission.body.mission && mission.body.mission.id})`);
    const plan = await waitFor((e) => e.type === 'plan.updated' && e.payload.change === 'submitted', 'plan.updated');
    check(plan.payload.version === 1 && plan.payload.ventures[0].id === 'lantern-co', 'plan v1 submitted with Lantern Co');
    const handoff = await waitFor((e) => e.type === 'work.handoff' && e.payload.toAgentId === 'sky', 'work.handoff to Sky');
    check(handoff.payload.toRoomId === 'research', `work item ${handoff.payload.workItemId} handed to Sky in the Research camp`);

    step(3, "Sky's brief: judged against the Scout's memory, recorded, decided by the Chief");
    const recorded = await waitFor((e) => e.type === 'scout.brief' && e.payload.change === 'recorded', 'scout.brief recorded');
    briefId = recorded.payload.briefId;
    check(recorded.payload.agentId === 'sky', `brief ${briefId} recorded from Sky`);
    const briefReview = judgeCalls.find((q) => /SCOPE: the worker submitted a venture brief/.test(q));
    check(Boolean(briefReview) && /no venture brief is recorded yet/.test(briefReview), "the judge's review carried the memory's history (empty so far)");
    check(/What we learned: no venture brief is recorded yet/.test(rangers.requests[0].system), "Sky's prompt carried the memory line");
    await waitFor((e) => e.type === 'work.done' && e.payload.workItemId === handoff.payload.workItemId, 'work.done for the brief');
    await srv.runs.waitForIdle();
    const rc = await srv.runs.start({ agentId: 'chief-ranger', prompt: 'Decide on the lantern brief.', provider: 'anthropic' });
    const decided = await waitFor((e) => e.type === 'scout.brief' && e.payload.change === 'decided', 'scout.brief decided');
    check(decided.payload.decision === 'go' && decided.payload.by === 'chief-ranger', 'the Chief decided go with brief.decide');
    await waitFor((e) => e.type === 'agent.run.end' && e.payload.runId === rc.runId, "the Chief's decision run");
    const memory1 = (await srv.get('/api/scout-memory')).body;
    check(memory1.totals.briefs === 1 && memory1.briefs[0].decision.decision === 'go' && memory1.briefs[0].joined === true && /^too early/.test(memory1.briefs[0].outcome), `memory: 1 brief, go, joined to the plan's venture, outcome "${memory1.briefs[0].outcome}" (nothing projected)`);

    step(4, 'The listing pipeline recipe: product data → copy (judge) → image (judge) → draft listing (Gate) → price (Gate) → publish (Gate)');
    const run = await srv.post('/api/recipes/launch-etsy-listing/run', { ventureId: 'lantern-co', params: { venture: 'lantern-co', product: 'Paper lantern, red', facts: FACTS, price: '25' } });
    check(run.status === 202, `recipe run ${run.body.id} started`);
    const draft = await waitFor((e) => e.type === 'agent.tool_result' && e.payload.callId === 'dl1', 'the draft listing');
    check(draft.payload.ok && /"state":"draft"/.test(draft.payload.output), 'a draft listing exists on the fake Etsy');
    const finished = await waitFor((e) => e.type === 'recipe.run' && e.payload.recipeRunId === run.body.id && ['done', 'failed'].includes(e.payload.status), 'recipe.run done', 60000);
    const record = (await srv.get(`/api/recipe-runs/${run.body.id}`)).body;
    check(finished.payload.status === 'done', `recipe done: ${Object.keys(record.steps).join(' → ')}`);
    check(approvedFromPeak.length === 3 && approvedFromPeak.every(([t, d]) => /^etsy\./.test(t) && ['publishing', 'money_in'].includes(d)), `three Etsy writes each waited at the Gate (${approvedFromPeak.map((a) => a[1]).join(', ')})`);
    const listing = etsy.state.listings[0];
    check(listing && listing.state === 'active' && Number(listing.price.amount) / listing.price.divisor === 25, `listing ${listing && listing.listing_id} is active at $25 on the fake Etsy`);
    check((await srv.get('/api/creatives?kind=image')).body.length === 1 && hf.prompts().length === 1, 'one image came from the fake Hugging Face');
    await srv.runs.waitForIdle();

    step(5, "Mia's ad set ($20 a day, money out at Draft) waits at the Gate; the card reaches the phone; Approve through the fake Bot API");
    const ads = await srv.post('/api/run', { prompt: 'Create the first ad set for the lantern listing and its creative.', agentId: 'mia' });
    check(ads.status === 202, `Mia's run ${ads.body.runId} started`);
    const item = await waitFor((e) => e.type === 'gate.item' && e.payload.status === 'pending' && e.payload.tool === 'meta_ads.create_adset', 'gate.item for the ad set');
    check(item.payload.domain === 'money_out' && item.payload.amountUsd === 20, `Gate item ${item.payload.itemId}: ${item.payload.summary} ($${item.payload.amountUsd})`);
    const cardFor = (itemId) => telegram.sentTo('42').find((m) => m.replyMarkup && m.replyMarkup.inline_keyboard[0].some((b) => b.callback_data === `gate:${itemId}:approve`));
    await waitUntil(() => Boolean(cardFor(item.payload.itemId)), 10000);
    const card = cardFor(item.payload.itemId);
    check(card.replyMarkup.inline_keyboard[0].map((b) => b.text).join(' / ') === 'Approve / Revise / Reject' && /\$20/.test(card.text), `the Gate card reached the paired chat: "${card.text.split('\n')[0]}"`);
    telegram.press({ chatId: 42, userId: 42, data: `gate:${item.payload.itemId}:approve`, messageId: card.messageId });
    const accepted = await waitFor((e) => e.type === 'channel.inbound' && e.payload.outcome === 'accepted' && e.payload.itemId === item.payload.itemId, 'the approval from the phone');
    check(accepted.payload.paired === true, 'the press came from the paired chat and resolved the item');
    const created = await waitFor((e) => e.type === 'agent.tool_result' && e.payload.callId === 'ad1', 'meta_ads.create_adset result');
    check(created.payload.ok && /"status":"PAUSED"/.test(created.payload.output), 'the ad set was created PAUSED on the fake Meta');
    const post = meta.state.calls.find((c) => c.method === 'POST' && c.path.endsWith('/adsets'));
    check(post && post.body.daily_budget === 2000 && post.body.status === 'PAUSED', 'the fake Meta saw POST /adsets daily_budget=2000 status=PAUSED');
    const creativeItem = await waitFor((e) => e.type === 'gate.item' && e.payload.status === 'pending' && e.payload.tool === 'meta_ads.create_creative', 'gate.item for the creative');
    check(creativeItem.payload.domain === 'publishing', 'the creative waits at the Gate as publishing');
    await waitUntil(() => Boolean(cardFor(creativeItem.payload.itemId)), 10000);
    const card2 = cardFor(creativeItem.payload.itemId);
    telegram.press({ chatId: 42, userId: 42, data: `gate:${creativeItem.payload.itemId}:approve`, messageId: card2.messageId });
    const madeCreative = await waitFor((e) => e.type === 'agent.tool_result' && e.payload.callId === 'ad2', 'meta_ads.create_creative result');
    check(madeCreative.payload.ok && /"pageId":"777"/.test(madeCreative.payload.output), 'the creative was made against the Page from the environment');
    await waitFor((e) => e.type === 'agent.run.end' && e.payload.runId === ads.body.runId, "Mia's run end");
    await srv.runs.waitForIdle();
    const ledger = (await srv.get('/api/state')).body.ledger;
    check(ledger.domains.money_out.usd === 20 && ledger.domains.money_out.actions === 1, 'leash ledger: money_out $20.00 in 1 action');

    step(6, 'The results rollup: real figures from the ledgers, no data where no source has it');
    const rollup = await srv.post('/api/results/rollup', {});
    check(rollup.status === 200, 'POST /api/results/rollup');
    const rolled = await waitFor((e) => e.type === 'results.rollup', 'results.rollup');
    const full = (await srv.get('/api/results')).body;
    const lantern = full.ventures.find((v) => v.id === 'lantern-co');
    check(Boolean(lantern) && rolled.payload.ventures.some((v) => v.id === 'lantern-co'), 'Lantern Co is in the rollup');
    check(lantern.all.adSpend === 0, 'ad spend $0.00: Meta synced and the one attributed set is paused (a known zero, not a guess)');
    check(lantern.all.orders === 0 && lantern.all.revenue === 0, 'orders 0, revenue $0.00: Etsy synced and the new listing has no receipt yet');
    check(lantern.all.modelSpend > 0, `model spend $${lantern.all.modelSpend.toFixed(4)} from the priced judge turns`);
    check(lantern.proposal.verdict === 'hold' && lantern.proposal.because.some((b) => /fewer than 7 days/.test(b)), `proposal: ${lantern.proposal.verdict} (${lantern.proposal.because.at(-1)})`);
    check(full.sources.etsy === true && full.sources.meta_ads === true && full.sources.stripe === false, 'sources: Etsy and Meta Ads synced; Stripe, Shopify and Google Ads absent');

    step(7, "The reflection posts from real data; its briefing lands in the Marketing camp's station mail");
    const reflect = await srv.post('/api/reflect', { reason: 'demo' });
    check(reflect.status === 202, 'reflection started');
    const posted = await waitFor((e) => e.type === 'reflection.posted', 'reflection.posted');
    if (posted.payload.status !== 'posted') { console.error(`    ✗ reflection ${posted.payload.status}: ${JSON.stringify(posted.payload).slice(0, 600)}`); process.exit(1); }
    check(posted.payload.status === 'posted' && posted.payload.briefings.includes('marketing'), `reflection ${posted.payload.reflectionId} posted; briefed: ${posted.payload.briefings.join(', ')}`);
    check(posted.payload.mailed === 1, 'one briefing was mailed');
    const mail = stream.events.find((e) => e.type === 'mail.message' && e.payload.kind === 'briefing');
    check(mail && mail.payload.station === 'marketing' && mail.payload.from === 'peak@makapark.com', `station mail from ${mail && mail.payload.from} to ${mail && mail.payload.to.join(', ')}`);
    const inbox = (await srv.get('/api/mail/messages?station=marketing')).body;
    check(inbox.length === 1 && /Briefing from the Mountain Peak/.test(inbox[0].subject), `the Marketing camp's inbox holds "${inbox[0] && inbox[0].subject}"`);
    const notes = await fsp.readdir(path.join(srv.workspaceRoot, '_stations', 'marketing', 'notes')).catch(() => []);
    check(notes.length >= 1, `briefing written to _stations/marketing/notes/ (${notes[0] || 'none'})`);
    const reflectionPrompt = judge.requests.find((r) => /reflecting on the portfolio/.test(r.system || ''));
    check(Boolean(reflectionPrompt) && /results, last/.test(reflectionPrompt.messages[0].content[0].text), 'the reflection saw the results rollup');
    await srv.runs.waitForIdle();
    const dump = JSON.stringify(stream.events);
    check(!dump.includes(telegram.token) && !dump.includes(meta.accessToken) && !dump.includes(hf.token), 'no token anywhere in the event stream');

    console.log('\nDEMO OK: mission → Scout brief scored against memory → listing pipeline → ad set + creative at the Gate → Telegram approve → results rollup → reflection briefing in station mail, all from recorded events.');
  } finally {
    stopApprover();
    stream.close();
    await srv.close();
    await Promise.all([research.close(), etsy.close(), hf.close(), meta.close(), telegram.close()]);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
