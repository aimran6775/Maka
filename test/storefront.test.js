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
import { createShopifyClient, shopifySpec, shopDomain, summarizeShopify, SHOPIFY_TOOLS } from '../sidecar/connectors/shopify.js';
import { createEtsyClient, etsySpec, etsyMoney, summarizeEtsy, ETSY_TOOLS, ETSY_SCOPES } from '../sidecar/connectors/etsy.js';
import { ENV_VARS, setKey } from '../sidecar/providers/keys.js';
import { OBJECT_KINDS, defaultLayout, allGrantsFor } from '../shared/world.js';
import { defaultLeash, TOOL_DOMAINS } from '../shared/leash.js';
import { startFakeShopify } from './helpers/fake-shopify.js';
import { startFakeEtsy } from './helpers/fake-etsy.js';
import { startTestServer } from './helpers/test-server.js';
import { fakeProvider, fakeClock, text, toolCall, end, waitUntil } from './helpers/fake-provider.js';

test('Shopify client: shop domain, access-token header, Link pagination without filters on later pages, JSON writes, Shopify-shaped errors', async () => {
  assert.equal(shopDomain('lanterns'), 'lanterns.myshopify.com');
  assert.equal(shopDomain('https://Lanterns.myshopify.com/admin'), 'lanterns.myshopify.com');
  assert.equal(shopDomain(''), null);
  assert.throws(() => createShopifyClient({ accessToken: 'x' }), (e) => e.code === 'NO_SHOP');
  const fake = await startFakeShopify({ pageSize: 1 });
  try {
    const bad = createShopifyClient({ shop: 'lanterns', accessToken: 'nope', baseUrl: fake.url });
    await assert.rejects(bad.shopInfo(), (e) => e.code === 'HTTP_401' && /Invalid API key/.test(e.message));
    const client = createShopifyClient({ shop: 'lanterns', accessToken: fake.accessToken, baseUrl: fake.url });
    assert.equal((await client.shopInfo()).name, 'Lantern Co');
    assert.equal(fake.state.calls.at(-1).headers['x-shopify-access-token'], fake.accessToken);
    assert.match(fake.state.calls.at(-1).path, /^\/admin\/api\/2024-10\/shop\.json/);
    const products = await client.products();
    assert.deepEqual(products.map((p) => p.id), [101, 102]);
    const pages = fake.state.calls.filter((c) => c.path.includes('products.json'));
    assert.equal(pages.length, 2);
    assert.match(pages[1].path, /page_info=1/);
    const orders = await client.orders();
    assert.equal(orders.length, 2, 'status=any brings refunded orders too');
    assert.match(fake.state.calls.find((c) => c.path.includes('orders.json')).path, /status=any/);
    assert.ok(!fake.state.calls.filter((c) => c.path.includes('orders.json'))[1].path.includes('status='), 'filters do not ride along with page_info');
    const created = await client.createProduct({ title: 'Lantern, green', variants: [{ price: '22.00', sku: 'LAN-GRN' }] });
    assert.equal(created.handle, 'lantern-green');
    assert.equal(fake.state.calls.at(-1).headers['content-type'], 'application/json');
    await assert.rejects(client.createProduct({ title: '' }), (e) => e.code === 'HTTP_422' && /can't be blank/.test(e.message));
    const v = await client.updateVariant(1001, { price: '27.50' });
    assert.equal(v.price, '27.50');
    await assert.rejects(client.updateVariant(1, { price: '1' }), (e) => e.code === 'HTTP_404');
    fake.state.fail = { status: 429, message: 'Exceeded 2 calls per second' };
    await assert.rejects(client.shopInfo(), (e) => e.code === 'HTTP_429');
    fake.state.fail = null;
  } finally {
    await fake.close();
  }
});

test('Etsy client: keystring and bearer headers, shop id from users/me, offset pagination by state, inventory round trip, Etsy-shaped errors', async () => {
  assert.equal(etsyMoney({ amount: 2500, divisor: 100 }), 25);
  assert.equal(etsyMoney(null), null);
  assert.throws(() => createEtsyClient({ accessToken: 'x' }), (e) => e.code === 'NO_CLIENT_ID');
  const fake = await startFakeEtsy({ pageSize: 1 });
  try {
    await assert.rejects(createEtsyClient({ clientId: 'wrong', accessToken: 'at_seed', baseUrl: fake.baseUrl }).me(), (e) => e.code === 'HTTP_401');
    await assert.rejects(createEtsyClient({ clientId: fake.clientId, accessToken: 'expired', baseUrl: fake.baseUrl }).me(), (e) => e.code === 'HTTP_401' && /expired/.test(e.message));
    const client = createEtsyClient({ clientId: fake.clientId, accessToken: 'at_seed', baseUrl: fake.baseUrl });
    assert.equal(await client.shopId(), 55);
    assert.equal((await client.shop()).shop_name, 'LanternCo');
    assert.equal(fake.state.calls.at(-1).headers['x-api-key'], fake.clientId);
    assert.equal(fake.state.calls.at(-1).headers.authorization, 'Bearer at_seed');
    assert.equal(fake.state.calls.filter((c) => c.path.endsWith('/users/me') && c.headers.authorization === 'Bearer at_seed' && c.headers['x-api-key'] === fake.clientId).length, 1, 'the shop id is cached');
    assert.deepEqual((await client.listings('active')).map((l) => l.listing_id), [501]);
    assert.deepEqual((await client.listings('draft')).map((l) => l.listing_id), [502]);
    const receipts = await client.receipts();
    assert.equal(receipts.length, 2, 'offset pages of one');
    assert.equal(fake.state.calls.filter((c) => c.path.includes('/receipts')).length, 2);
    const inv = await client.inventory(501);
    assert.equal(inv.products[0].offerings[0].price.amount, 2500);
    const put = await client.updateInventory(501, { products: [{ sku: 'LAN-RED', property_values: [], offerings: [{ price: 27.5, quantity: 12, is_enabled: true }] }] });
    assert.equal(put.products[0].offerings[0].price.amount, 2750);
    await assert.rejects(client.inventory(999), (e) => e.code === 'HTTP_404');
    const draft = await client.createDraftListing({ quantity: 2, title: 'Lantern, green', description: 'Green paper lantern', price: 22, who_made: 'i_did', when_made: 'made_to_order', taxonomy_id: 1 });
    assert.equal(draft.state, 'draft');
    await assert.rejects(client.createDraftListing({ title: 'x' }), (e) => e.code === 'HTTP_400' && /quantity is required/.test(e.message));
    assert.equal((await client.updateListing(502, { state: 'active' })).state, 'active');
  } finally {
    await fake.close();
  }
});

async function harness({ shopify, etsy, env = {}, leash: leashPatch = {} } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-storefront-'));
  const store = createStore({ root: path.join(dir, 'home') });
  await store.init();
  const bus = createEventBus();
  const events = [];
  bus.listen((e) => events.push(e));
  const clock = fakeClock(1_700_000_000_000);
  const layout = defaultLayout();
  layout.rooms.push({ id: 'listings', name: 'Listings Camp', kind: 'product_listings', x: 21, y: 1, w: 8, h: 6 });
  layout.objects.push({ id: 'shop', kind: 'park_store', roomId: 'listings', x: 22, y: 2 });
  layout.agents.push({ id: 'sam', name: 'Sam', roomId: 'listings', x: 21, y: 1, role: 'ranger', specialty: 'storefront' });
  const layoutState = createLayoutState({ initial: layout, store, bus, clock });
  const ledger = await createLeashLedger({ store, clock }).init();
  const leash = defaultLeash();
  Object.assign(leash.domains, leashPatch);
  const leashState = createLeashState({ initial: leash, store });
  const gateQueue = await createGateQueue({ bus, store, ledger, leashState, getLayout: layoutState.get, clock }).init();
  const scheduler = await createScheduler({ store, clock, tickMs: 60_000, log: { error() {} } }).init();
  const keystorePath = path.join(dir, 'home', 'keystore.json');
  if (etsy) {
    await setKey('etsyClientId', etsy.clientId, { env: {}, keystorePath });
    await setKey('etsy', JSON.stringify({ accessToken: 'at_seed', refreshToken: 'rt_seed', expiresAt: clock.now() + 3600_000, scope: ETSY_SCOPES.join(' '), tokenType: 'Bearer' }), { env: {}, keystorePath });
  }
  const connectors = createConnectors({ bus, store, scheduler, gateQueue, env: { ...(shopify ? { SHOPIFY_ACCESS_TOKEN: shopify.accessToken, SHOPIFY_SHOP: 'lanterns' } : {}), ...env }, keystorePath, clock, config: { oauthPort: 0, syncOnBoot: false }, log: { error() {}, warn() {} } });
  if (shopify) connectors.define(shopifySpec({ baseUrl: shopify.url }));
  if (etsy) connectors.define(etsySpec({ baseUrl: etsy.baseUrl, authorizeUrl: etsy.authorizeUrl, tokenUrl: etsy.tokenUrl }));
  await connectors.init();
  const gate = createToolGate({ getLayout: layoutState.get, agentId: 'sam', workspaceDir: path.join(dir, 'ws', 'sam'), registry: { ...connectors.tools }, grants: allGrantsFor, toolContext: { connectors }, getLeash: () => leashState.get(), ledger, submit: { submit: (item) => gateQueue.submit({ ...item, runId: 'run-1', agentId: 'sam' }), log: (item) => gateQueue.log({ ...item, runId: 'run-1', agentId: 'sam' }) } });
  const ofType = (t) => events.filter((e) => e.type === t).map((e) => e.payload);
  const call = (id, name, input) => gate.execute({ id, name, input }, { runId: 'run-1' });
  return { dir, events, ofType, clock, gateQueue, ledger, leashState, keystorePath, connectors, gate, call, cleanup: async () => { await connectors.close(); await fsp.rm(dir, { recursive: true, force: true }); } };
}

test('the Park Store grants the storefront tools with their domains; Shopify syncs products, orders and stock; reads from the store; writes through the leash (publishing at Draft, money_in)', async () => {
  assert.equal(ENV_VARS.shopify, 'SHOPIFY_ACCESS_TOKEN');
  assert.equal(ENV_VARS.etsyClientId, 'ETSY_CLIENT_ID');
  assert.deepEqual(OBJECT_KINDS.park_store.grants, ['connector.status', 'connector.sync', ...Object.keys(SHOPIFY_TOOLS), ...Object.keys(ETSY_TOOLS)]);
  for (const name of [...Object.keys(SHOPIFY_TOOLS), ...Object.keys(ETSY_TOOLS)]) {
    const expected = /create|update/.test(name) ? 'publishing' : /set_price/.test(name) ? 'money_in' : 'research';
    assert.equal(TOOL_DOMAINS[name], expected, name);
  }
  assert.equal(summarizeShopify(null), null);
  const fake = await startFakeShopify();
  const h = await harness({ shopify: fake });
  try {
    const st = h.connectors.status('shopify');
    assert.equal(st.connected, true);
    assert.deepEqual(st.zoneKinds, ['product_listings', 'sales']);
    assert.equal(st.zoneKind, 'product_listings');
    const sync = await h.connectors.sync('shopify', 'manual');
    assert.deepEqual(sync.counts, { products: 2, orders: 2, newOrders: 2 });
    const data = h.connectors.data('shopify');
    assert.deepEqual(data.shop, { id: 1, name: 'Lantern Co', domain: 'lanterns.myshopify.com', currency: 'USD' });
    assert.equal(data.products[1].variants[1].compareAtPrice, '35.00');
    assert.equal(data.orders[0].customer, 'Ada L');
    assert.equal(data.orders[0].fulfillmentStatus, 'unfulfilled');
    assert.match(h.connectors.status('shopify').summary, /^Lantern Co · 2 product\(s\) · 2 order\(s\) · last 7 days: 1 paid, 25\.00 USD$/);
    const products = JSON.parse((await h.call('c1', 'shopify.products', { query: 'blu' })).output);
    assert.equal(products.count, 1);
    assert.equal(products.products[0].id, 102);
    assert.equal(JSON.parse((await h.call('c2', 'shopify.products', { status: 'active' })).output).count, 1);
    const orders = JSON.parse((await h.call('c3', 'shopify.orders', { sinceDays: 7 })).output);
    assert.equal(orders.count, 1);
    assert.equal(orders.total, 25);
    assert.equal(JSON.parse((await h.call('c4', 'shopify.orders', { financialStatus: 'refunded' })).output).orders[0].name, '#1002');
    const low = JSON.parse((await h.call('c5', 'shopify.inventory', { lowStockBelow: 5 })).output);
    assert.deepEqual(low.inventory.map((r) => [r.sku, r.quantity]), [['LAN-BLU-S', 0], ['LAN-BLU-L', 3]]);
    assert.equal(JSON.parse((await h.call('c6', 'shopify.inventory', { sku: 'LAN-RED' })).output).inventory[0].quantity, 12);
    assert.equal(h.gateQueue.recent(20).length, 0, 'reads are research');
    // publishing at Draft: the create waits at the Gate; approve posts it and the store updates
    const pending = h.call('w1', 'shopify.create_product', { title: 'Paper lantern, green', body: '<p>Green.</p>', status: 'draft', variants: [{ price: 22, sku: 'LAN-GRN', inventoryQuantity: 5 }] });
    const item = await waitUntil(() => h.gateQueue.pending()[0]);
    assert.equal(item.domain, 'publishing');
    assert.equal(item.summary, 'create the Shopify product "Paper lantern, green" (draft, 1 variant(s) from 22.00)');
    await h.gateQueue.resolve(item.itemId, { decision: 'approve' });
    const created = JSON.parse((await pending).output);
    assert.equal(created.handle, 'paper-lantern-green');
    assert.equal(created.variants[0].inventoryQuantity, 5);
    assert.equal(fake.state.calls.find((c) => c.method === 'POST').body.product.variants[0].price, '22.00');
    assert.equal(h.connectors.data('shopify').products[0].id, created.id, 'the store knows it at once');
    await waitUntil(() => h.ofType('connector.sync').some((e) => e.reason === 'after-write' && e.status === 'done'));
    // money_in at act_free: the price change goes straight through and the ledger counts the action
    await h.leashState.set({ ...h.leashState.get(), domains: { ...h.leashState.get().domains, money_in: { level: 'act_free' }, publishing: { level: 'act_free' } } });
    const priced = JSON.parse((await h.call('w2', 'shopify.set_price', { variantId: 1001, price: 27.5, compareAtPrice: 30 })).output);
    assert.equal(priced.variant.price, '27.50');
    assert.equal(priced.product, 'Paper lantern, red');
    assert.equal(h.ledger.summary().domains.money_in.actions, 1);
    assert.equal(h.gateQueue.recent(20).find((it) => it.callId === 'w2').status, 'allowed');
    assert.equal((await h.call('w3', 'shopify.set_price', { variantId: 42, price: 1 })).code, 'NOT_FOUND');
    const updated = JSON.parse((await h.call('w4', 'shopify.update_product', { productId: 102, status: 'active', tags: 'lantern, blue, sale' })).output);
    assert.equal(updated.status, 'active');
    assert.match((await h.call('w5', 'shopify.update_product', { productId: 102 })).error, /at least one/);
    fake.state.fail = { status: 422, message: 'Title has already been taken' };
    const dup = await h.call('w6', 'shopify.create_product', { title: 'Paper lantern, red', variants: [{ price: 25 }] });
    assert.equal(dup.code, 'HTTP_422');
    assert.match(dup.error, /already been taken/);
    fake.state.fail = null;
  } finally {
    await h.cleanup();
    await fake.close();
  }
});

test('Etsy over OAuth: the keystore token and keystring connect at init, the sync brings the shop, listings by state and receipts; drafts created and activated (publishing), prices through the inventory (money_in), expired tokens refreshed', async () => {
  assert.equal(summarizeEtsy(null), null);
  const fake = await startFakeEtsy();
  const h = await harness({ etsy: fake });
  try {
    const st = h.connectors.status('etsy');
    assert.equal(st.connected, true);
    assert.equal(st.auth, 'oauth2');
    const sync = await h.connectors.sync('etsy', 'manual');
    assert.deepEqual(sync.counts, { listings: 2, drafts: 1, receipts: 2, newReceipts: 2 });
    const data = h.connectors.data('etsy');
    assert.equal(data.shop.name, 'LanternCo');
    assert.equal(data.listings[1].state, 'draft');
    assert.equal(data.receipts[0].grandTotal, 25);
    assert.equal(data.receipts[0].items[0].listingId, 501);
    assert.match(h.connectors.status('etsy').summary, /^LanternCo · 2 listing\(s\) · 2 receipt\(s\) · last 7 days: 1 paid, 25\.00 USD$/);
    assert.equal(JSON.parse((await h.call('c1', 'etsy.listings', { state: 'draft' })).output).listings[0].listingId, 502);
    assert.equal(JSON.parse((await h.call('c2', 'etsy.listings', { query: 'red' })).output).count, 1);
    const toShip = JSON.parse((await h.call('c3', 'etsy.receipts', { unshippedOnly: true })).output);
    assert.equal(toShip.count, 1);
    assert.equal(toShip.receipts[0].buyer, 'Ada L');
    assert.equal(JSON.parse((await h.call('c4', 'etsy.receipts', { sinceDays: 7 })).output).total, 25);
    assert.deepEqual(JSON.parse((await h.call('c5', 'etsy.inventory', { lowStockBelow: 5 })).output).inventory.map((r) => r.listingId), [502]);
    // writes at act_free for publishing and money_in
    await h.leashState.set({ ...h.leashState.get(), domains: { ...h.leashState.get().domains, money_in: { level: 'act_free' }, publishing: { level: 'act_free' } } });
    const draft = JSON.parse((await h.call('w1', 'etsy.create_listing', { title: 'Paper lantern, green', description: 'Green paper lantern, hand folded.', price: 22, quantity: 4, whoMade: 'i_did', whenMade: 'made_to_order', taxonomyId: 1234, tags: ['lantern', 'green'] })).output);
    assert.equal(draft.state, 'draft');
    assert.equal(draft.price, 22);
    const post = fake.state.calls.find((c) => c.method === 'POST' && c.path.endsWith('/listings'));
    assert.equal(post.body.who_made, 'i_did');
    assert.equal(post.body.type, 'physical');
    assert.ok(h.connectors.data('etsy').listings.some((l) => l.listingId === draft.listingId), 'the store knows the draft at once');
    const live = JSON.parse((await h.call('w2', 'etsy.update_listing', { listingId: draft.listingId, state: 'active' })).output);
    assert.equal(live.state, 'active');
    assert.equal(h.gateQueue.recent(20).filter((it) => it.domain === 'publishing' && it.status === 'allowed').length, 2);
    const priced = JSON.parse((await h.call('w3', 'etsy.set_price', { listingId: 501, price: 27.5 })).output);
    assert.equal(priced.offerings, 1);
    const put = fake.state.calls.find((c) => c.method === 'PUT');
    assert.equal(put.body.products[0].offerings[0].price, 27.5);
    assert.equal(put.body.products[0].sku, 'LAN-RED');
    assert.equal(fake.state.listings.find((l) => l.listing_id === 501).price.amount, 2750);
    assert.equal(h.connectors.data('etsy').listings.find((l) => l.listingId === 501).price, 27.5);
    assert.equal(h.ledger.summary().domains.money_in.actions, 1);
    assert.equal((await h.call('w4', 'etsy.set_price', { listingId: 999, price: 1 })).code, 'NOT_FOUND');
    // an expired token is refreshed before the next call
    await setKey('etsy', JSON.stringify({ accessToken: 'at_seed', refreshToken: 'rt_seed', expiresAt: h.clock.now() - 1, scope: '', tokenType: 'Bearer' }), { env: {}, keystorePath: h.keystorePath });
    assert.equal((await h.connectors.sync('etsy', 'manual')).counts.listings, 3);
    assert.equal(fake.state.refreshes, 1);
    assert.equal(fake.state.calls.find((c) => c.path.includes('/oauth/token')).body.client_id, fake.clientId);
  } finally {
    await h.cleanup();
    await fake.close();
  }
});

test('through the sidecar: a Storefront Ranger lists the drafts, a listing update waits at the Gate under publishing, the Listings and Sales camps read /api/connectors; the OAuth sign-in for Etsy runs end to end', async () => {
  const shopify = await startFakeShopify();
  const etsy = await startFakeEtsy();
  const layout = defaultLayout();
  layout.rooms.push({ id: 'listings', name: 'Listings Camp', kind: 'product_listings', x: 21, y: 1, w: 8, h: 6 });
  layout.objects.push({ id: 'shop', kind: 'park_store', roomId: 'listings', x: 22, y: 2 });
  layout.agents.push({ id: 'sam', name: 'Sam', roomId: 'listings', x: 21, y: 1, role: 'ranger', specialty: 'storefront' });
  const provider = fakeProvider([
    [...toolCall('s1', 'shopify.products', { status: 'draft' }), end('tool_use')],
    [...toolCall('s2', 'shopify.update_product', { productId: 102, status: 'active' }), end('tool_use')],
    [text('activated the blue lantern'), end()],
  ]);
  const srv = await startTestServer({ layout, makeProvider: async () => ({ provider, model: 'm', price: null }), env: { SHOPIFY_ACCESS_TOKEN: shopify.accessToken, ETSY_CLIENT_ID: etsy.clientId }, connectors: [shopifySpec({ baseUrl: shopify.url }), etsySpec({ baseUrl: etsy.baseUrl, authorizeUrl: etsy.authorizeUrl, tokenUrl: etsy.tokenUrl })], connectorConfig: { oauthPort: 0, shopify: { shop: 'lanterns' } } });
  try {
    const rows = (await srv.get('/api/connectors')).body;
    assert.deepEqual(rows.map((c) => [c.kind, c.connected]), [['shopify', true], ['etsy', false]]);
    await srv.connectors.booted;
    assert.ok((await srv.get('/api/connectors/shopify')).body.data.syncedAt, 'a connected store syncs at boot');
    const stream = await srv.sse();
    const r = await srv.post('/api/run', { prompt: 'activate the blue lantern', agentId: 'sam' });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const item = await stream.waitFor((e) => e.type === 'gate.item' && e.payload.status === 'pending' && e.payload.tool === 'shopify.update_product');
    assert.equal(item.payload.domain, 'publishing');
    assert.equal(item.payload.agentId, 'sam');
    await srv.post(`/api/gate/${item.payload.itemId}`, { decision: 'approve' });
    await stream.waitFor((e) => e.type === 'agent.run.end' && e.payload.runId === r.body.runId);
    await srv.runs.waitForIdle();
    const read = await stream.waitFor((e) => e.type === 'agent.tool_result' && e.payload.callId === 's1');
    assert.match(read.payload.output, /Paper lantern, blue/);
    const shop = (await srv.get('/api/connectors/shopify')).body;
    assert.equal(shop.data.products.find((p) => p.id === 102).status, 'active');
    assert.equal(shopify.state.products.find((p) => p.id === 102).status, 'active');
    // Etsy: connect → Gate → authorize URL → the platform redirects to the local callback → synced
    const c = await srv.post('/api/connectors/etsy/connect', {});
    assert.equal(c.status, 202, JSON.stringify(c.body));
    await srv.post(`/api/gate/${c.body.itemId}`, { decision: 'approve' });
    const authz = await stream.waitFor((e) => e.type === 'connector.status' && e.payload.change === 'authorizing');
    const a = etsy.authorize(authz.payload.authorizeUrl);
    assert.equal(a.scope, ETSY_SCOPES.join(' '));
    assert.equal((await fetch(`${a.redirectUri}?code=${a.code}&state=${a.state}`)).status, 200);
    await stream.waitFor((e) => e.type === 'connector.sync' && e.payload.connector === 'etsy' && e.payload.status === 'done');
    const et = (await srv.get('/api/connectors/etsy')).body;
    assert.equal(et.connected, true);
    assert.equal(et.data.shop.name, 'LanternCo');
    assert.ok(!JSON.stringify(et).includes('at_'), 'no token in the API');
    stream.close();
  } finally {
    await srv.close();
    await shopify.close();
    await etsy.close();
  }
});
