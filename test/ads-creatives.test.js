import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createStore } from '../sidecar/store.js';
import { createEventBus } from '../sidecar/bus.js';
import { createLayoutState } from '../sidecar/server.js';
import { createLeashLedger, createLeashState } from '../sidecar/leash-ledger.js';
import { createGateQueue } from '../sidecar/gate-queue.js';
import { createScheduler } from '../sidecar/scheduler.js';
import { createToolGate } from '../sidecar/capability/gate.js';
import { createConnectors } from '../sidecar/connectors/registry.js';
import { metaAdsSpec, META_ADS_TOOLS } from '../sidecar/connectors/meta-ads.js';
import { META_ADSET_TOOLS, adsetBudget, targetingSpec, IMAGE_LIMIT_BYTES } from '../sidecar/connectors/meta-ads-sets.js';
import { googleAdsSpec, GOOGLE_ADS_TOOLS, GOOGLE_ADS_SCOPES } from '../sidecar/connectors/google-ads.js';
import { GOOGLE_AD_GROUP_TOOLS, rsaProblem, RSA_LIMITS } from '../sidecar/connectors/google-ads-groups.js';
import { setKey } from '../sidecar/providers/keys.js';
import { OBJECT_KINDS, defaultLayout, allGrantsFor } from '../shared/world.js';
import { defaultLeash, TOOL_DOMAINS } from '../shared/leash.js';
import { startFakeMetaAds } from './helpers/fake-meta-ads.js';
import { startFakeGoogleAds } from './helpers/fake-google-ads.js';
import { fakeClock, waitUntil } from './helpers/fake-provider.js';

// A 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function harness({ meta, google, leash: leashPatch = {}, pageId = '777' } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-creatives-'));
  const store = createStore({ root: path.join(dir, 'home') });
  await store.init();
  const bus = createEventBus();
  const events = [];
  bus.listen((e) => events.push(e));
  const clock = fakeClock(1_700_000_000_000);
  const layout = defaultLayout();
  layout.rooms.push({ id: 'marketing', name: 'Marketing Camp', kind: 'marketing', x: 21, y: 1, w: 8, h: 6 });
  layout.objects.push({ id: 'board', kind: 'notice_board', roomId: 'marketing', x: 22, y: 2 });
  layout.agents.push({ id: 'mia', name: 'Mia', roomId: 'marketing', x: 21, y: 1, role: 'ranger', specialty: 'ads' });
  const layoutState = createLayoutState({ initial: layout, store, bus, clock });
  const ledger = await createLeashLedger({ store, clock }).init();
  const leash = defaultLeash();
  Object.assign(leash.domains, leashPatch);
  const leashState = createLeashState({ initial: leash, store });
  const gateQueue = await createGateQueue({ bus, store, ledger, leashState, getLayout: layoutState.get, clock }).init();
  const scheduler = await createScheduler({ store, clock, tickMs: 60_000, log: { error() {} } }).init();
  const keystorePath = path.join(dir, 'home', 'keystore.json');
  const env = {};
  if (meta) Object.assign(env, { META_ACCESS_TOKEN: meta.accessToken, META_AD_ACCOUNT_ID: '123', ...(pageId ? { META_PAGE_ID: pageId } : {}) });
  if (google) {
    await setKey('googleAdsClientId', google.clientId, { env: {}, keystorePath });
    await setKey('googleAdsClientSecret', google.clientSecret, { env: {}, keystorePath });
    await setKey('googleAdsDeveloperToken', google.developerToken, { env: {}, keystorePath });
    await setKey('googleAds', JSON.stringify({ accessToken: 'ya29.seed', refreshToken: '1//seed', expiresAt: clock.now() + 3600_000, scope: GOOGLE_ADS_SCOPES.join(' '), tokenType: 'Bearer' }), { env: {}, keystorePath });
    env.GOOGLE_ADS_CUSTOMER_ID = google.customerId;
  }
  const connectors = createConnectors({ bus, store, scheduler, gateQueue, env, keystorePath, clock, config: { oauthPort: 0, syncOnBoot: false }, log: { error() {}, warn() {} } });
  if (meta) connectors.define(metaAdsSpec({ baseUrl: meta.url }));
  if (google) connectors.define(googleAdsSpec({ baseUrl: google.baseUrl, authorizeUrl: google.authorizeUrl, tokenUrl: google.tokenUrl }));
  await connectors.init();
  const workspaceDir = path.join(dir, 'ws', 'mia');
  await fsp.mkdir(path.join(workspaceDir, 'outbox'), { recursive: true });
  await fsp.writeFile(path.join(workspaceDir, 'outbox', 'hero.png'), PNG);
  await fsp.writeFile(path.join(workspaceDir, 'outbox', 'copy.txt'), 'not an image');
  const gate = createToolGate({ getLayout: layoutState.get, agentId: 'mia', workspaceDir, registry: { ...connectors.tools }, grants: allGrantsFor, toolContext: { connectors }, getLeash: () => leashState.get(), ledger, submit: { submit: (item) => gateQueue.submit({ ...item, runId: 'run-1', agentId: 'mia' }), log: (item) => gateQueue.log({ ...item, runId: 'run-1', agentId: 'mia' }) } });
  const call = (id, name, input) => gate.execute({ id, name, input }, { runId: 'run-1' });
  // Runs a call that must park at the Gate; returns { item, result }.
  const viaGate = async (id, name, input, decision = 'approve') => {
    const p = call(id, name, input);
    const item = await waitUntil(() => gateQueue.pending().find((it) => it.callId === id));
    await gateQueue.resolve(item.itemId, { decision });
    return { item, result: await p };
  };
  return { dir, workspaceDir, events, clock, gateQueue, ledger, leashState, connectors, gate, call, viaGate, cleanup: async () => { await connectors.close(); await fsp.rm(dir, { recursive: true, force: true }); } };
}

test('the Notice board grants the new tools with the right domains; ad set budgets and RSA copy limits are pure', () => {
  assert.deepEqual(OBJECT_KINDS.notice_board.grants, ['connector.status', 'connector.sync', ...Object.keys(META_ADS_TOOLS), ...Object.keys(GOOGLE_ADS_TOOLS), 'creative.copy', 'creative.image']);
  assert.deepEqual(Object.keys(META_ADSET_TOOLS), ['meta_ads.adsets', 'meta_ads.ads', 'meta_ads.creatives', 'meta_ads.create_adset', 'meta_ads.set_adset_budget', 'meta_ads.set_adset_status', 'meta_ads.upload_image', 'meta_ads.create_creative', 'meta_ads.create_ad', 'meta_ads.set_ad_status']);
  assert.deepEqual(Object.keys(GOOGLE_AD_GROUP_TOOLS), ['google_ads.ad_groups', 'google_ads.ads', 'google_ads.assets', 'google_ads.create_ad_group', 'google_ads.set_ad_group_status', 'google_ads.create_rsa', 'google_ads.set_ad_status', 'google_ads.upload_image_asset']);
  for (const name of ['meta_ads.create_adset', 'meta_ads.set_adset_budget', 'meta_ads.set_adset_status', 'meta_ads.set_ad_status', 'google_ads.set_ad_group_status', 'google_ads.set_ad_status']) assert.equal(TOOL_DOMAINS[name], 'money_out', name);
  for (const name of ['meta_ads.upload_image', 'meta_ads.create_creative', 'meta_ads.create_ad', 'google_ads.create_ad_group', 'google_ads.create_rsa', 'google_ads.upload_image_asset']) assert.equal(TOOL_DOMAINS[name], 'publishing', name);
  for (const name of ['meta_ads.adsets', 'meta_ads.ads', 'meta_ads.creatives', 'google_ads.ad_groups', 'google_ads.ads', 'google_ads.assets']) assert.equal(TOOL_DOMAINS[name], 'research', name);
  assert.equal(adsetBudget({ dailyBudget: 20 }), 20);
  assert.equal(adsetBudget({ dailyBudget: null, lifetimeBudget: 500 }), 500);
  assert.equal(adsetBudget({ dailyBudget: 0 }), null);
  assert.equal(adsetBudget(null), null);
  assert.deepEqual(targetingSpec({ countries: ['us', 'CA'], ageMin: 25, ageMax: 54, genders: [2], interests: [{ id: '6003', name: 'Camping' }] }), { geo_locations: { countries: ['US', 'CA'] }, age_min: 25, age_max: 54, genders: [2], flexible_spec: [{ interests: [{ id: '6003', name: 'Camping' }] }] });
  assert.equal(rsaProblem({ headlines: ['a', 'b', 'c'], descriptions: ['d', 'e'] }), null);
  assert.match(rsaProblem({ headlines: ['a', 'b'], descriptions: ['d', 'e'] }), /3 to 15 headlines/);
  assert.match(rsaProblem({ headlines: ['a', 'b', 'x'.repeat(31)], descriptions: ['d', 'e'] }), /over 30 characters/);
  assert.match(rsaProblem({ headlines: ['a', 'b', 'c'], descriptions: ['d'] }), /2 to 4 descriptions/);
  assert.match(rsaProblem({ headlines: ['a', 'b', 'c'], descriptions: ['d', 'x'.repeat(91)] }), /over 90 characters/);
  assert.match(rsaProblem({ headlines: ['a', 'A', 'c'], descriptions: ['d', 'e'] }), /distinct/);
  assert.match(rsaProblem({ headlines: ['a', 'b', 'c'], descriptions: ['d', 'e'], path1: 'has space' }), /path/);
  assert.match(rsaProblem({ headlines: ['a', 'b', 'c'], descriptions: ['d', 'e'], path2: 'x' }), /path2 needs path1/);
  assert.equal(RSA_LIMITS.headlines.chars, 30);
});

test('Meta: the sync brings ad sets, ads and creatives; a new ad set is money_out with its set-level budget and created PAUSED with its targeting; activation counts the set budget (none provable → the Gate, then NO_BUDGET); images upload from the workspace only; creatives and ads are publishing; an active ad counts its set\'s budget', async () => {
  const fake = await startFakeMetaAds();
  const h = await harness({ meta: fake, leash: { money_out: { level: 'act_capped', dailyCapUsd: 50 } } });
  try {
    const sync = await h.connectors.sync('meta_ads', 'manual');
    assert.deepEqual([sync.counts.adsets, sync.counts.ads, sync.counts.creatives], [2, 1, 1]);
    const sets = JSON.parse((await h.call('r1', 'meta_ads.adsets', { campaignId: 'c1' })).output);
    assert.deepEqual(sets.adsets.map((s) => [s.id, s.dailyBudget, s.optimizationGoal, s.targeting.geo_locations.countries]), [['s1', 20, 'OFFSITE_CONVERSIONS', ['US']]]);
    const ads = JSON.parse((await h.call('r2', 'meta_ads.ads', {})).output);
    assert.deepEqual(ads.ads.map((a) => [a.id, a.adsetId, a.creativeId]), [['a1', 's1', 'cr1']]);
    const creatives = JSON.parse((await h.call('r3', 'meta_ads.creatives', {})).output);
    assert.deepEqual([creatives.creatives[0].headline, creatives.creatives[0].imageHash, creatives.creatives[0].callToAction], ['Lanterns, handmade', 'h1', 'SHOP_NOW']);
    assert.equal(h.ledger.summary().domains.research.actions, 3);
    // A new ad set: $20 under the $50 cap runs, PAUSED, with the targeting spec and the set-level budget.
    const created = await h.call('w1', 'meta_ads.create_adset', { campaignId: 'c1', name: 'US men 35+', dailyBudget: 20, targeting: { countries: ['us'], ageMin: 35, genders: [1] }, optimizationGoal: 'LINK_CLICKS', billingEvent: 'IMPRESSIONS', bidAmount: 1.5 });
    assert.equal(created.ok, true, created.error);
    const row = JSON.parse(created.output);
    assert.deepEqual([row.status, row.dailyBudget, row.campaignId], ['PAUSED', 20, 'c1']);
    const post = fake.state.calls.find((c) => c.method === 'POST' && c.path.endsWith('/adsets'));
    assert.deepEqual([post.body.status, post.body.daily_budget, post.body.bid_amount, post.body.targeting], ['PAUSED', 2000, 150, { geo_locations: { countries: ['US'] }, age_min: 35, genders: [1] }]);
    assert.equal(h.ledger.summary().domains.money_out.usd, 20);
    // $40 more would pass the cap: parked at the Gate with the lifetime budget as the amount.
    const big = await h.viaGate('w2', 'meta_ads.create_adset', { campaignId: 'c1', name: 'Lifetime', lifetimeBudget: 40, endTime: '2026-12-31T00:00:00+0000', targeting: { countries: ['CA'] }, optimizationGoal: 'REACH', billingEvent: 'IMPRESSIONS' }, 'reject');
    assert.deepEqual([big.item.amountUsd, big.item.domain, big.result.code], [40, 'money_out', 'GATE_REJECT']);
    assert.match((await h.call('w3', 'meta_ads.create_adset', { campaignId: 'c1', name: 'x', dailyBudget: 1, lifetimeBudget: 1, targeting: { countries: ['US'] }, optimizationGoal: 'REACH', billingEvent: 'IMPRESSIONS' })).error, /exactly one of/);
    const none = await h.viaGate('w4', 'meta_ads.create_adset', { campaignId: 'c1', name: 'x', targeting: { countries: ['US'] }, optimizationGoal: 'REACH', billingEvent: 'IMPRESSIONS' });
    assert.equal(none.item.amountUsd, undefined, 'no budget given: the amount cannot be proven, the Gate');
    assert.match(none.result.error, /exactly one of/);
    assert.match((await h.call('w5', 'meta_ads.create_adset', { campaignId: 'c1', name: 'x', lifetimeBudget: 5, targeting: { countries: ['US'] }, optimizationGoal: 'REACH', billingEvent: 'IMPRESSIONS' })).error, /endTime/);
    assert.equal((await h.call('w6', 'meta_ads.create_adset', { campaignId: 'nope', name: 'x', dailyBudget: 5, targeting: { countries: ['US'] }, optimizationGoal: 'REACH', billingEvent: 'IMPRESSIONS' })).code, 'NOT_FOUND');
    // Budget and status at set level.
    assert.equal(JSON.parse((await h.call('w7', 'meta_ads.set_adset_budget', { adsetId: 's1', dailyBudget: 25 })).output).before, 20);
    assert.equal(fake.state.adsets.find((s) => s.id === 's1').daily_budget, '2500');
    // s2 has no set-level budget: activating it is unknown-amount at every level and refused when approved (safety H2).
    const s2 = await h.viaGate('w8', 'meta_ads.set_adset_status', { adsetId: 's2', status: 'ACTIVE' });
    assert.equal(s2.item.amountUsd, undefined);
    assert.equal(s2.result.code, 'NO_BUDGET');
    assert.equal(fake.state.adsets.find((s) => s.id === 's2').status, 'PAUSED', 'nothing was activated');
    const pause = await h.call('w9', 'meta_ads.set_adset_status', { adsetId: 's1', status: 'PAUSED' });
    assert.equal(pause.ok, true);
    assert.equal(h.ledger.summary().domains.money_out.usd, 45, 'the pause moved $0; the budget change counted its $25');
    const act = await h.viaGate('w10', 'meta_ads.set_adset_status', { adsetId: 's1', status: 'ACTIVE' });
    assert.equal(act.item.amountUsd, 25, 'over the cap now: the Gate with the set budget as the amount');
    assert.equal(act.result.ok, true);
    // Images: workspace only, PNG / JPEG, bounded.
    // Publishing is at Draft here: every upload parks at the Gate first; approved, the tool still refuses what it must.
    assert.equal((await h.viaGate('i1', 'meta_ads.upload_image', { path: '../../etc/passwd' })).result.code, 'SANDBOX');
    assert.equal((await h.viaGate('i2', 'meta_ads.upload_image', { path: 'outbox/copy.txt' })).result.code, 'BAD_IMAGE');
    assert.equal((await h.viaGate('i3', 'meta_ads.upload_image', { path: 'outbox/missing.png' })).result.code, 'NOT_FOUND');
    await fsp.writeFile(path.join(h.workspaceDir, 'outbox', 'huge.png'), Buffer.alloc(IMAGE_LIMIT_BYTES + 1));
    assert.equal((await h.viaGate('i4', 'meta_ads.upload_image', { path: 'outbox/huge.png' })).result.code, 'TOO_LARGE');
    assert.equal(fake.state.images.length, 0, 'nothing reached Meta');
    const up = await h.viaGate('i5', 'meta_ads.upload_image', { path: 'outbox/hero.png' });
    assert.equal(up.item.domain, 'publishing');
    const img = JSON.parse(up.result.output);
    assert.deepEqual([img.hash, img.bytes], ['img1hash', PNG.length]);
    assert.equal(fake.state.images[0].bytes, PNG.length, 'the bytes reached Meta');
    // A creative from the Ranger's copy and the uploaded image; an ad from it, PAUSED.
    const cr = await h.viaGate('p1', 'meta_ads.create_creative', { name: 'Autumn hero', message: 'Light your evenings.', headline: 'Handmade lanterns', description: 'Free shipping', link: 'https://lanterns.example/autumn', imageHash: 'img1hash', callToAction: 'SHOP_NOW' });
    assert.equal(cr.item.domain, 'publishing');
    const creative = JSON.parse(cr.result.output);
    assert.equal(creative.pageId, '777');
    const spec = fake.state.calls.find((c) => c.method === 'POST' && c.path.endsWith('/adcreatives')).body.object_story_spec;
    assert.deepEqual(spec.link_data, { image_hash: 'img1hash', link: 'https://lanterns.example/autumn', message: 'Light your evenings.', name: 'Handmade lanterns', description: 'Free shipping', call_to_action: { type: 'SHOP_NOW', value: { link: 'https://lanterns.example/autumn' } } });
    assert.equal((await h.viaGate('p2', 'meta_ads.create_ad', { adsetId: 's1', name: 'x', creativeId: 'nope' })).result.code, 'NOT_FOUND');
    const ad = await h.viaGate('p3', 'meta_ads.create_ad', { adsetId: 's1', name: 'Autumn ad', creativeId: creative.id });
    assert.equal(ad.item.domain, 'publishing');
    const adRow = JSON.parse(ad.result.output);
    assert.deepEqual([adRow.status, adRow.campaignId, adRow.creativeId], ['PAUSED', 'c1', creative.id]);
    assert.equal(fake.state.ads.find((a) => a.id === adRow.id).status, 'PAUSED');
    // Activating the ad counts its set's budget ($25, over what is left of the cap → the Gate); an ad in a set with no budget is unknown.
    const on = await h.viaGate('p4', 'meta_ads.set_ad_status', { adId: adRow.id, status: 'ACTIVE' });
    assert.equal(on.item.amountUsd, 25);
    assert.equal(on.result.ok, true);
    assert.equal(fake.state.ads.find((a) => a.id === adRow.id).status, 'ACTIVE');
    fake.state.ads.push({ id: 'a-orphan', name: 'orphan', adset_id: 's2', campaign_id: 'c2', status: 'PAUSED', effective_status: 'PAUSED', creative: { id: 'cr1' } });
    await h.connectors.sync('meta_ads', 'manual');
    const orphan = await h.viaGate('p5', 'meta_ads.set_ad_status', { adId: 'a-orphan', status: 'ACTIVE' });
    assert.equal(orphan.item.amountUsd, undefined);
    assert.equal(orphan.result.code, 'NO_BUDGET');
    // The day's money_out total is past the cap by now, so even a $0 pause waits at the Gate (the cap holds whole); it carries its 0.
    const off = await h.viaGate('p6', 'meta_ads.set_ad_status', { adId: adRow.id, status: 'PAUSED' });
    assert.deepEqual([off.item.amountUsd, off.result.ok], [0, true]);
  } finally {
    await h.cleanup();
    await fake.close();
  }
  // Without a Page id a creative cannot be made, and says so.
  const fake2 = await startFakeMetaAds();
  const h2 = await harness({ meta: fake2, pageId: null, leash: { publishing: { level: 'act_free' } } });
  try {
    await h2.connectors.sync('meta_ads', 'manual');
    const r = await h2.call('c1', 'meta_ads.create_creative', { name: 'x', message: 'm', headline: 'h', link: 'https://x.example', imageHash: 'h1' });
    assert.equal(r.code, 'NO_PAGE');
  } finally {
    await h2.cleanup();
    await fake2.close();
  }
});

test('Google Ads: the sync brings ad groups, ads and image assets; an ad group is publishing and PAUSED with its CPC bid; enabling a group or an ad counts the campaign\'s daily budget; a responsive search ad is checked against the copy limits and created PAUSED; an image asset uploads from the workspace', async () => {
  const fake = await startFakeGoogleAds();
  const h = await harness({ google: fake, leash: { money_out: { level: 'act_capped', dailyCapUsd: 20 }, publishing: { level: 'act_free' } } });
  try {
    const sync = await h.connectors.sync('google_ads', 'manual');
    assert.deepEqual([sync.counts.adGroups, sync.counts.ads, sync.counts.assets], [1, 1, 1]);
    const groups = JSON.parse((await h.call('r1', 'google_ads.ad_groups', { campaignId: '9001' })).output);
    assert.deepEqual(groups.adGroups.map((g) => [g.id, g.status, g.cpcBid, g.campaignId]), [['5001', 'ENABLED', 1.2, '9001']]);
    const ads = JSON.parse((await h.call('r2', 'google_ads.ads', { adGroupId: '5001' })).output);
    assert.deepEqual([ads.ads[0].headlines.length, ads.ads[0].descriptions.length, ads.ads[0].finalUrls], [3, 2, ['https://lanterns.example/shop']]);
    assert.equal(JSON.parse((await h.call('r3', 'google_ads.assets', {})).output).assets[0].bytes, 20480);
    // An ad group: publishing (act_free here), PAUSED, with the campaign resource and the bid in micros.
    const g = await h.call('w1', 'google_ads.create_ad_group', { campaignId: '9002', name: 'Shopping – lanterns', cpcBid: 0.8 });
    assert.equal(g.ok, true, g.error);
    const group = JSON.parse(g.output);
    assert.deepEqual([group.status, group.campaignId, group.cpcBid], ['PAUSED', '9002', 0.8]);
    const op = fake.state.calls.find((c) => c.path.endsWith('/adGroups:mutate')).body.operations[0].create;
    assert.deepEqual([op.status, op.campaign, op.cpcBidMicros], ['PAUSED', `customers/${fake.customerId}/campaigns/9002`, '800000']);
    assert.equal((await h.call('w2', 'google_ads.create_ad_group', { campaignId: 'nope', name: 'x', cpcBid: 1 })).code, 'NOT_FOUND');
    assert.equal(h.ledger.summary().domains.publishing.actions, 1);
    // Enabling the group counts the campaign's $15 daily budget: under the $20 cap it runs; a second one waits.
    const en = await h.call('w3', 'google_ads.set_ad_group_status', { adGroupId: group.id, status: 'ENABLED' });
    assert.equal(en.ok, true, en.error);
    assert.equal(h.ledger.summary().domains.money_out.usd, 15);
    assert.equal(fake.state.adGroups.find((x) => x.id === group.id).status, 'ENABLED');
    const second = await h.viaGate('w4', 'google_ads.set_ad_group_status', { adGroupId: '5001', status: 'ENABLED' }, 'reject');
    assert.deepEqual([second.item.amountUsd, second.result.code], [15, 'GATE_REJECT']);
    assert.equal((await h.call('w5', 'google_ads.set_ad_group_status', { adGroupId: group.id, status: 'PAUSED' })).ok, true, 'pausing moves nothing');
    // A responsive search ad: the copy limits, then PAUSED with the headlines wrapped as Google wants them.
    const bad = await h.call('a1', 'google_ads.create_rsa', { adGroupId: group.id, headlines: ['One', 'Two', 'Two'], descriptions: ['d1', 'd2'], finalUrls: ['https://lanterns.example'] });
    assert.deepEqual([bad.code, /distinct/.test(bad.error)], ['BAD_COPY', true]);
    const long = await h.call('a2', 'google_ads.create_rsa', { adGroupId: group.id, headlines: ['One', 'Two', 'x'.repeat(31)], descriptions: ['d1', 'd2'], finalUrls: ['https://lanterns.example'] });
    assert.match(long.error, /invalid input|over 30/);
    const rsa = await h.call('a3', 'google_ads.create_rsa', { adGroupId: group.id, name: 'Autumn RSA', headlines: ['Handmade Lanterns', 'Autumn Glow', 'Ships In Two Days'], descriptions: ['Hand-finished lanterns for porches and gardens.', 'Free shipping on every order.'], finalUrls: ['https://lanterns.example/autumn'], path1: 'lanterns', path2: 'autumn' });
    assert.equal(rsa.ok, true, rsa.error);
    const ad = JSON.parse(rsa.output);
    assert.deepEqual([ad.status, ad.adGroupId, ad.campaignId, ad.headlines.length, ad.path2], ['PAUSED', group.id, '9002', 3, 'autumn']);
    const create = fake.state.calls.find((c) => c.path.endsWith('/adGroupAds:mutate')).body.operations[0].create;
    assert.equal(create.status, 'PAUSED');
    assert.deepEqual(create.ad.responsiveSearchAd.headlines[0], { text: 'Handmade Lanterns' });
    assert.equal((await h.call('a4', 'google_ads.create_rsa', { adGroupId: 'nope', headlines: ['a', 'b', 'c'], descriptions: ['d', 'e'], finalUrls: ['https://x.example'] })).code, 'NOT_FOUND');
    // Enabling the ad counts its campaign's budget: $15 more is over the cap → the Gate with the amount.
    const adOn = await h.viaGate('a5', 'google_ads.set_ad_status', { adId: ad.id, status: 'ENABLED' });
    assert.deepEqual([adOn.item.amountUsd, adOn.result.ok], [15, true]);
    assert.equal(fake.state.ads.find((x) => x.id === ad.id).status, 'ENABLED');
    // A campaign the store knows no budget for: unknown amount, the Gate, then NO_BUDGET.
    fake.state.budgets.get('b1').amountMicros = 0;
    await h.connectors.sync('google_ads', 'manual');
    const unknown = await h.viaGate('a6', 'google_ads.set_ad_status', { adId: '7001', status: 'ENABLED' });
    assert.equal(unknown.item.amountUsd, undefined);
    assert.equal(unknown.result.code, 'NO_BUDGET');
    // An image asset from the workspace only.
    assert.equal((await h.call('m1', 'google_ads.upload_image_asset', { path: '/etc/passwd', name: 'x' })).code, 'SANDBOX');
    assert.equal((await h.call('m2', 'google_ads.upload_image_asset', { path: 'outbox/copy.txt', name: 'x' })).code, 'BAD_IMAGE');
    const asset = await h.call('m3', 'google_ads.upload_image_asset', { path: 'outbox/hero.png', name: 'Autumn hero' });
    assert.equal(asset.ok, true, asset.error);
    assert.deepEqual([JSON.parse(asset.output).type, JSON.parse(asset.output).bytes], ['IMAGE', PNG.length]);
    assert.equal(fake.state.assets[0].name, 'Autumn hero');
    assert.equal(Number(fake.state.assets[0].fileSize), PNG.length);
  } finally {
    await h.cleanup();
    await fake.close();
  }
});
