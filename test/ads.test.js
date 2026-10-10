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
import { createMetaAdsClient, metaAdsSpec, adAccountId, summarizeMetaAds, META_ADS_TOOLS } from '../sidecar/connectors/meta-ads.js';
import { createGoogleAdsClient, googleAdsSpec, customerId, microsToMajor, majorToMicros, summarizeGoogleAds, GOOGLE_ADS_TOOLS, GOOGLE_ADS_SCOPES, CAMPAIGN_QUERY } from '../sidecar/connectors/google-ads.js';
import { ENV_VARS, setKey } from '../sidecar/providers/keys.js';
import { OBJECT_KINDS, defaultLayout, allGrantsFor } from '../shared/world.js';
import { defaultLeash, TOOL_DOMAINS } from '../shared/leash.js';
import { startFakeMetaAds } from './helpers/fake-meta-ads.js';
import { startFakeGoogleAds } from './helpers/fake-google-ads.js';
import { startTestServer } from './helpers/test-server.js';
import { fakeProvider, fakeClock, text, toolCall, end, waitUntil } from './helpers/fake-provider.js';

test('Meta client: act_ prefix, bearer token, cursor paging, insights at campaign level, create and update, Graph-shaped errors', async () => {
  assert.equal(adAccountId('123'), 'act_123');
  assert.equal(adAccountId('act_9'), 'act_9');
  assert.equal(adAccountId(''), null);
  assert.throws(() => createMetaAdsClient({ accessToken: 'x' }), (e) => e.code === 'NO_AD_ACCOUNT');
  const fake = await startFakeMetaAds({ pageSize: 1 });
  try {
    await assert.rejects(createMetaAdsClient({ accessToken: 'bad', adAccountId: '123', baseUrl: fake.url }).accountInfo(), (e) => e.code === 'HTTP_401' && /Invalid OAuth access token/.test(e.message));
    const client = createMetaAdsClient({ accessToken: fake.accessToken, adAccountId: '123', baseUrl: fake.url });
    assert.equal((await client.accountInfo()).currency, 'USD');
    assert.match(fake.state.calls.at(-1).path, /fields=id%2Cname%2Ccurrency/);
    const campaigns = await client.campaigns();
    assert.deepEqual(campaigns.map((c) => c.id), ['c1', 'c2']);
    assert.equal(fake.state.calls.filter((c) => c.path.includes('/campaigns?')).length, 2, 'two pages of one');
    assert.match(fake.state.calls.at(-1).path, /after=1/);
    const insights = await client.insights();
    assert.equal(insights[0].spend, '84.50');
    assert.match(fake.state.calls.at(-1).path, /level=campaign.*date_preset=last_7d/);
    const created = await client.createCampaign({ name: 'New', objective: 'OUTCOME_TRAFFIC', status: 'PAUSED', daily_budget: 500, special_ad_categories: [] });
    assert.equal(created.id, 'c11');
    await assert.rejects(client.createCampaign({ name: 'x', objective: 'OUTCOME_TRAFFIC' }), (e) => e.code === 'HTTP_400' && /special_ad_categories/.test(e.message));
    assert.deepEqual(await client.updateCampaign('c1', { status: 'PAUSED' }), { success: true });
    await assert.rejects(client.updateCampaign('nope', { status: 'PAUSED' }), (e) => e.code === 'HTTP_404');
    fake.state.fail = { status: 500, message: 'An unknown error occurred' };
    await assert.rejects(client.accountInfo(), (e) => e.code === 'HTTP_500');
    fake.state.fail = null;
  } finally {
    await fake.close();
  }
});

test('Google Ads client: customer id normalised, developer token and bearer headers, GAQL through searchStream, mutates, Google-shaped errors with the detail', async () => {
  assert.equal(customerId('123-456-7890'), '1234567890');
  assert.equal(customerId(''), null);
  assert.equal(microsToMajor('15000000'), 15);
  assert.equal(majorToMicros(2.5), 2_500_000);
  assert.throws(() => createGoogleAdsClient({ accessToken: 'x', developerToken: 'd' }), (e) => e.code === 'NO_CUSTOMER');
  assert.throws(() => createGoogleAdsClient({ accessToken: 'x', customerId: '1' }), (e) => e.code === 'NO_DEVELOPER_TOKEN');
  const fake = await startFakeGoogleAds();
  try {
    await assert.rejects(createGoogleAdsClient({ accessToken: 'ya29.seed', developerToken: 'wrong', customerId: fake.customerId, baseUrl: fake.baseUrl }).search(CAMPAIGN_QUERY), (e) => e.code === 'HTTP_401' && /DEVELOPER_TOKEN_INVALID/.test(e.message));
    await assert.rejects(createGoogleAdsClient({ accessToken: 'expired', developerToken: fake.developerToken, customerId: fake.customerId, baseUrl: fake.baseUrl }).search(CAMPAIGN_QUERY), (e) => e.code === 'HTTP_401' && /invalid authentication/.test(e.message));
    const client = createGoogleAdsClient({ accessToken: 'ya29.seed', developerToken: fake.developerToken, customerId: '123-456-7890', loginCustomerId: '999-999-9999', baseUrl: fake.baseUrl });
    const rows = await client.search(CAMPAIGN_QUERY);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].campaignBudget.amountMicros, '15000000');
    const call = fake.state.calls.at(-1);
    assert.equal(call.headers['developer-token'], fake.developerToken);
    assert.equal(call.headers['login-customer-id'], '9999999999');
    assert.match(call.path, /\/customers\/1234567890\/googleAds:searchStream$/);
    assert.equal(call.body.query, CAMPAIGN_QUERY);
    await assert.rejects(client.search('SELECT nothing FROM nowhere'), (e) => e.code === 'HTTP_400' && /Unrecognized field/.test(e.message));
    const b = await client.mutateBudgets([{ create: { name: 'b', amountMicros: '1000000' } }]);
    assert.match(b.results[0].resourceName, /campaignBudgets\/b3$/);
    await assert.rejects(client.mutateCampaigns([{ create: { name: 'x' } }]), (e) => e.code === 'HTTP_400' && /campaign_budget/.test(e.message));
    await assert.rejects(createGoogleAdsClient({ accessToken: 'ya29.seed', developerToken: fake.developerToken, customerId: '42', baseUrl: fake.baseUrl }).search(CAMPAIGN_QUERY), (e) => e.code === 'HTTP_403');
  } finally {
    await fake.close();
  }
});

async function harness({ meta, google, leash: leashPatch = {} } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-ads-'));
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
  if (meta) Object.assign(env, { META_ACCESS_TOKEN: meta.accessToken, META_AD_ACCOUNT_ID: '123' });
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
  const gate = createToolGate({ getLayout: layoutState.get, agentId: 'mia', workspaceDir: path.join(dir, 'ws', 'mia'), registry: { ...connectors.tools }, grants: allGrantsFor, toolContext: { connectors }, getLeash: () => leashState.get(), ledger, submit: { submit: (item) => gateQueue.submit({ ...item, runId: 'run-1', agentId: 'mia' }), log: (item) => gateQueue.log({ ...item, runId: 'run-1', agentId: 'mia' }) } });
  const ofType = (t) => events.filter((e) => e.type === t).map((e) => e.payload);
  const call = (id, name, input) => gate.execute({ id, name, input }, { runId: 'run-1' });
  return { dir, events, ofType, clock, gateQueue, ledger, leashState, keystorePath, connectors, gate, call, cleanup: async () => { await connectors.close(); await fsp.rm(dir, { recursive: true, force: true }); } };
}

test('the Notice board grants the ad tools; Meta Ads syncs the account, campaigns and 7-day insights; reads from the store; a new campaign is money_out with its daily budget, created PAUSED; budget and status changes carry their amounts', async () => {
  assert.equal(ENV_VARS.metaAds, 'META_ACCESS_TOKEN');
  assert.equal(ENV_VARS.googleAdsDeveloperToken, 'GOOGLE_ADS_DEVELOPER_TOKEN');
  assert.deepEqual(OBJECT_KINDS.notice_board.grants, ['connector.status', 'connector.sync', ...Object.keys(META_ADS_TOOLS), ...Object.keys(GOOGLE_ADS_TOOLS)]);
  for (const name of [...Object.keys(META_ADS_TOOLS), ...Object.keys(GOOGLE_ADS_TOOLS)]) assert.equal(TOOL_DOMAINS[name], /create|set_/.test(name) ? 'money_out' : 'research', name);
  assert.equal(summarizeMetaAds(null), null);
  const fake = await startFakeMetaAds();
  const h = await harness({ meta: fake });
  try {
    assert.equal(h.connectors.status('meta_ads').connected, true);
    assert.deepEqual((await h.connectors.sync('meta_ads', 'manual')).counts, { campaigns: 2, active: 1, insightRows: 1, spend7d: 84.5 });
    const data = h.connectors.data('meta_ads');
    assert.equal(data.account.amountSpent, 123.45);
    assert.equal(data.campaigns[0].dailyBudget, 20);
    assert.equal(data.campaigns[1].lifetimeBudget, 500);
    assert.deepEqual(data.insights.rows[0].results, [{ type: 'purchase', value: 6 }]);
    assert.equal(h.connectors.status('meta_ads').summary, 'Lantern Co Ads · 2 campaign(s) (1 active) · last 7 days: spend 84.50 USD, 240 click(s), 12000 impression(s)');
    assert.equal(JSON.parse((await h.call('c1', 'meta_ads.campaigns', { status: 'ACTIVE' })).output).campaigns[0].id, 'c1');
    assert.equal(JSON.parse((await h.call('c2', 'meta_ads.campaigns', { query: 'aware' })).output).count, 1);
    const ins = JSON.parse((await h.call('c3', 'meta_ads.insights', {})).output);
    assert.equal(ins.totalSpend, 84.5);
    assert.equal(ins.preset, 'last_7d');
    assert.equal(h.gateQueue.recent(20).length, 0, 'reads are research');
    // a new campaign at Draft: the Gate sees the daily budget as the amount; approved → created PAUSED
    const pending = h.call('w1', 'meta_ads.create_campaign', { name: 'Lanterns – Autumn', objective: 'OUTCOME_SALES', dailyBudget: 15 });
    const item = await waitUntil(() => h.gateQueue.pending()[0]);
    assert.equal(item.domain, 'money_out');
    assert.equal(item.amountUsd, 15);
    assert.equal(item.summary, 'create the Meta Ads campaign "Lanterns – Autumn" (OUTCOME_SALES, 15.00/day, paused)');
    await h.gateQueue.resolve(item.itemId, { decision: 'approve' });
    const created = JSON.parse((await pending).output);
    assert.equal(created.status, 'PAUSED');
    assert.equal(created.dailyBudget, 15);
    const post = fake.state.calls.find((c) => c.method === 'POST');
    assert.deepEqual(post.body, { name: 'Lanterns – Autumn', objective: 'OUTCOME_SALES', status: 'PAUSED', daily_budget: 1500, special_ad_categories: [] });
    assert.equal(h.ledger.summary().domains.money_out.usd, 15);
    await waitUntil(() => h.ofType('connector.sync').some((e) => e.reason === 'after-write' && e.status === 'done'));
    // act_capped at $40/day: a $20 budget change passes (15 + 20 ≤ 40); activating c1 ($20/day) parks (55 > 40); pausing is 0 and passes
    await h.leashState.set({ ...h.leashState.get(), domains: { ...h.leashState.get().domains, money_out: { level: 'act_capped', dailyCapUsd: 40 } } });
    const budget = JSON.parse((await h.call('w2', 'meta_ads.set_budget', { campaignId: created.id, dailyBudget: 20 })).output);
    assert.equal(budget.before, 15);
    assert.equal(budget.dailyBudget, 20);
    assert.equal(fake.state.campaigns.find((c) => c.id === created.id).daily_budget, '2000');
    assert.equal(h.gate.leashFor('meta_ads.set_status', { campaignId: 'c1', status: 'ACTIVE' }).level, 'act_capped');
    const activate = h.call('w3', 'meta_ads.set_status', { campaignId: created.id, status: 'ACTIVE' });
    const capped = await waitUntil(() => h.gateQueue.pending()[0]);
    assert.equal(capped.amountUsd, 20, 'activating counts the campaign\'s daily budget');
    assert.match(capped.reason, /cap/);
    await h.gateQueue.resolve(capped.itemId, { decision: 'reject', notes: 'not yet' });
    assert.equal((await activate).code, 'GATE_REJECT');
    const paused = JSON.parse((await h.call('w4', 'meta_ads.set_status', { campaignId: 'c1', status: 'PAUSED' })).output);
    assert.equal(paused.status, 'PAUSED');
    assert.equal(h.gateQueue.recent(20).find((it) => it.callId === 'w4').amountUsd, 0, 'pausing moves no money');
    assert.equal(fake.state.campaigns.find((c) => c.id === 'c1').status, 'PAUSED');
    await h.leashState.set({ ...h.leashState.get(), domains: { ...h.leashState.get().domains, money_out: { level: 'act_free' } } });
    assert.equal((await h.call('w5', 'meta_ads.set_budget', { campaignId: 'nope', dailyBudget: 1 })).code, 'NOT_FOUND');
    fake.state.fail = { status: 400, message: 'Invalid parameter' };
    const failed = await h.call('w6', 'meta_ads.set_budget', { campaignId: 'c1', dailyBudget: 1 });
    assert.equal(failed.code, 'HTTP_400');
    assert.match(failed.error, /Invalid parameter/);
    fake.state.fail = null;
  } finally {
    await h.cleanup();
    await fake.close();
  }
});

test('Google Ads from a keystore token: the sync reads the customer, campaigns with budgets and 7-day metrics; a new campaign creates a budget then a PAUSED campaign; budget and status mutates; expired tokens refresh with the client secret', async () => {
  assert.equal(summarizeGoogleAds(null), null);
  const fake = await startFakeGoogleAds();
  const h = await harness({ google: fake, leash: { money_out: { level: 'act_free' } } });
  try {
    const st = h.connectors.status('google_ads');
    assert.equal(st.connected, true);
    assert.equal(st.auth, 'oauth2');
    assert.deepEqual((await h.connectors.sync('google_ads', 'manual')).counts, { campaigns: 2, enabled: 1, metricRows: 1, cost7d: 61.25 });
    const data = h.connectors.data('google_ads');
    assert.equal(data.customer.name, 'Lantern Co');
    assert.equal(data.campaigns[0].dailyBudget, 15);
    assert.equal(data.campaigns[0].budgetResource, `customers/${fake.customerId}/campaignBudgets/b1`);
    assert.equal(data.metrics.rows[0].conversions, 4);
    assert.equal(h.connectors.status('google_ads').summary, 'Lantern Co · 2 campaign(s) (1 enabled) · last 7 days: cost 61.25 USD, 310 click(s), 4 conversion(s)');
    assert.equal(JSON.parse((await h.call('c1', 'google_ads.campaigns', { status: 'PAUSED' })).output).campaigns[0].id, '9002');
    assert.equal(JSON.parse((await h.call('c2', 'google_ads.metrics', { campaignId: '9001' })).output).totalCost, 61.25);
    const created = JSON.parse((await h.call('w1', 'google_ads.create_campaign', { name: 'Lanterns – Autumn', channel: 'SEARCH', dailyBudget: 12 })).output);
    assert.equal(created.status, 'PAUSED');
    assert.equal(created.dailyBudget, 12);
    assert.match(created.budgetResource, /campaignBudgets\/b3$/);
    const budgetCall = fake.state.calls.find((c) => c.path.endsWith('campaignBudgets:mutate'));
    assert.equal(budgetCall.body.operations[0].create.amountMicros, '12000000');
    const campaignCall = fake.state.calls.find((c) => c.path.endsWith('campaigns:mutate'));
    assert.equal(campaignCall.body.operations[0].create.campaignBudget, created.budgetResource);
    assert.equal(campaignCall.body.operations[0].create.status, 'PAUSED');
    assert.equal(h.gateQueue.recent(20).find((it) => it.callId === 'w1').amountUsd, 12);
    const budget = JSON.parse((await h.call('w2', 'google_ads.set_budget', { campaignId: '9001', dailyBudget: 25 })).output);
    assert.equal(budget.before, 15);
    assert.equal(fake.state.budgets.get('b1').amountMicros, 25_000_000);
    const upd = fake.state.calls.filter((c) => c.path.endsWith('campaignBudgets:mutate')).at(-1).body.operations[0];
    assert.equal(upd.updateMask, 'amount_micros');
    assert.equal(h.connectors.data('google_ads').campaigns.find((x) => x.id === '9002').dailyBudget, 25, 'the shared budget moved every campaign on it');
    const enabled = JSON.parse((await h.call('w3', 'google_ads.set_status', { campaignId: '9002', status: 'ENABLED' })).output);
    assert.equal(enabled.status, 'ENABLED');
    assert.equal(h.gateQueue.recent(20).find((it) => it.callId === 'w3').amountUsd, 25, 'enabling counts the shared budget\'s daily amount');
    assert.equal(fake.state.campaigns.find((c) => c.id === '9002').status, 'ENABLED');
    assert.equal(h.ledger.summary().domains.money_out.usd, 62);
    assert.equal((await h.call('w4', 'google_ads.set_budget', { campaignId: 'nope', dailyBudget: 1 })).code, 'NOT_FOUND');
    // an expired token refreshes with the client secret in the body
    await setKey('googleAds', JSON.stringify({ accessToken: 'ya29.seed', refreshToken: '1//seed', expiresAt: h.clock.now() - 1, scope: '', tokenType: 'Bearer' }), { env: {}, keystorePath: h.keystorePath });
    assert.equal((await h.connectors.sync('google_ads', 'manual')).counts.campaigns, 3);
    assert.equal(fake.state.refreshes, 1);
    const tok = fake.state.calls.find((c) => c.path === '/token');
    assert.equal(tok.body.client_secret, fake.clientSecret);
    assert.equal(tok.body.grant_type, 'refresh_token');
  } finally {
    await h.cleanup();
    await fake.close();
  }
});

test('through the sidecar: an Ads Ranger\'s budget change waits at the Gate under money_out with its amount; the Marketing camp reads both connectors; the Google sign-in asks for offline access', async () => {
  const meta = await startFakeMetaAds();
  const google = await startFakeGoogleAds();
  const layout = defaultLayout();
  layout.rooms.push({ id: 'marketing', name: 'Marketing Camp', kind: 'marketing', x: 21, y: 1, w: 8, h: 6 });
  layout.objects.push({ id: 'board', kind: 'notice_board', roomId: 'marketing', x: 22, y: 2 });
  layout.agents.push({ id: 'mia', name: 'Mia', roomId: 'marketing', x: 21, y: 1, role: 'ranger', specialty: 'ads' });
  const provider = fakeProvider([
    [...toolCall('a1', 'meta_ads.insights', {}), end('tool_use')],
    [...toolCall('a2', 'meta_ads.set_budget', { campaignId: 'c1', dailyBudget: 30 }), end('tool_use')],
    [text('raised the budget'), end()],
  ]);
  const srv = await startTestServer({ layout, makeProvider: async () => ({ provider, model: 'm', price: null }), env: { META_ACCESS_TOKEN: meta.accessToken, GOOGLE_ADS_CLIENT_ID: google.clientId, GOOGLE_ADS_CLIENT_SECRET: google.clientSecret, GOOGLE_ADS_DEVELOPER_TOKEN: google.developerToken, GOOGLE_ADS_CUSTOMER_ID: google.customerId }, connectors: [metaAdsSpec({ baseUrl: meta.url }), googleAdsSpec({ baseUrl: google.baseUrl, authorizeUrl: google.authorizeUrl, tokenUrl: google.tokenUrl })], connectorConfig: { oauthPort: 0, meta_ads: { adAccountId: '123' } } });
  try {
    await srv.connectors.booted;
    const rows = (await srv.get('/api/connectors')).body;
    assert.deepEqual(rows.map((c) => [c.kind, c.connected, c.zoneKinds]), [['meta_ads', true, ['marketing']], ['google_ads', false, ['marketing']]]);
    assert.ok((await srv.get('/api/connectors/meta_ads')).body.data.syncedAt, 'synced at boot');
    const stream = await srv.sse();
    const r = await srv.post('/api/run', { prompt: 'raise the sales budget', agentId: 'mia' });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const item = await stream.waitFor((e) => e.type === 'gate.item' && e.payload.status === 'pending' && e.payload.tool === 'meta_ads.set_budget');
    assert.equal(item.payload.domain, 'money_out');
    assert.equal(item.payload.amountUsd, 30);
    await srv.post(`/api/gate/${item.payload.itemId}`, { decision: 'approve' });
    await stream.waitFor((e) => e.type === 'agent.run.end' && e.payload.runId === r.body.runId);
    await srv.runs.waitForIdle();
    assert.equal(meta.state.campaigns.find((c) => c.id === 'c1').daily_budget, '3000');
    assert.equal((await srv.get('/api/state')).body.ledger.domains.money_out.usd, 30);
    const c = await srv.post('/api/connectors/google_ads/connect', {});
    assert.equal(c.status, 202, JSON.stringify(c.body));
    await srv.post(`/api/gate/${c.body.itemId}`, { decision: 'approve' });
    const authz = await stream.waitFor((e) => e.type === 'connector.status' && e.payload.change === 'authorizing');
    const a = google.authorize(authz.payload.authorizeUrl);
    assert.equal(a.scope, GOOGLE_ADS_SCOPES[0]);
    assert.equal(a.accessType, 'offline');
    assert.equal(a.prompt, 'consent');
    assert.equal((await fetch(`${a.redirectUri}?code=${encodeURIComponent(a.code)}&state=${a.state}`)).status, 200);
    await stream.waitFor((e) => e.type === 'connector.sync' && e.payload.connector === 'google_ads' && e.payload.status === 'done');
    const g = (await srv.get('/api/connectors/google_ads')).body;
    assert.equal(g.connected, true);
    assert.equal(g.data.customer.name, 'Lantern Co');
    assert.ok(!JSON.stringify(g).includes('ya29'), 'no token in the API');
    const reflect = await srv.reflect.gather();
    assert.match(reflect.connectors, /Meta Ads: Lantern Co Ads .*; Google Ads: Lantern Co/);
    stream.close();
  } finally {
    await srv.close();
    await meta.close();
    await google.close();
  }
});
