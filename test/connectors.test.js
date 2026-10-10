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
import { pkcePair, createOAuthFlow, refreshTokens, normalizeTokens, DEFAULT_OAUTH_PORT } from '../sidecar/connectors/oauth.js';
import { createConnectors, DEFAULT_SYNC_MS } from '../sidecar/connectors/registry.js';
import { CONNECTOR_SPECS } from '../sidecar/connectors/kinds.js';
import { resolveKey, keystoreStatus } from '../sidecar/providers/keys.js';
import { OBJECT_KINDS, defaultLayout, allGrantsFor } from '../shared/world.js';
import { defaultLeash, TOOL_DOMAINS } from '../shared/leash.js';
import { startFakeConnector, fakeSpec } from './helpers/fake-connector.js';
import { startTestServer } from './helpers/test-server.js';
import { fakeProvider, fakeClock, text, toolCall, end, waitUntil } from './helpers/fake-provider.js';

test('PKCE pairs are S256 and unique; token responses normalise; a refresh keeps the old refresh token when none comes back', async () => {
  const a = pkcePair();
  const b = pkcePair();
  assert.notEqual(a.verifier, b.verifier);
  assert.match(a.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(a.challenge, /^[A-Za-z0-9_-]{43}$/);
  const t = normalizeTokens({ access_token: 'x', expires_in: 60, scope: 'a b' }, 1000);
  assert.deepEqual(t, { accessToken: 'x', refreshToken: null, expiresAt: 61000, scope: 'a b', tokenType: 'Bearer' });
  assert.throws(() => normalizeTokens({}, 0), (e) => e.code === 'BAD_TOKEN_RESPONSE');
  const fetchImpl = async () => new Response(JSON.stringify({ access_token: 'new', expires_in: 10 }), { status: 200 });
  const r = await refreshTokens({ tokenUrl: 'http://t', clientId: 'c', refreshToken: 'old', fetch: fetchImpl, clock: { now: () => 0 } });
  assert.equal(r.accessToken, 'new');
  assert.equal(r.refreshToken, 'old');
  await assert.rejects(refreshTokens({ tokenUrl: 'http://t', clientId: 'c', refreshToken: null, fetch: fetchImpl }), (e) => e.code === 'NO_REFRESH_TOKEN');
  await assert.rejects(refreshTokens({ tokenUrl: 'http://t', clientId: 'c', refreshToken: 'x', fetch: async () => new Response('{"error":"invalid_grant"}', { status: 400 }) }), (e) => e.code === 'HTTP_400' && /invalid_grant/.test(e.message));
  await assert.rejects(refreshTokens({ tokenUrl: 'http://t', clientId: 'c', refreshToken: 'x', fetch: async () => { throw new Error('ECONNREFUSED'); } }), (e) => e.code === 'NETWORK');
  assert.equal(DEFAULT_OAUTH_PORT, 8765);
});

test('the OAuth flow: a local callback on 127.0.0.1, state checked, the code exchanged with the verifier, errors and cancels are coded', async () => {
  const fake = await startFakeConnector();
  try {
    const flow = createOAuthFlow({ authorizeUrl: `${fake.url}/oauth/authorize`, tokenUrl: `${fake.url}/oauth/token`, clientId: fake.clientId, scopes: ['read_items'], redirectPort: 0, fetch: globalThis.fetch, clock: { now: () => 5000 } });
    const started = await flow.start();
    assert.match(started.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    const a = fake.authorize(started.authorizeUrl);
    assert.equal(a.method, 'S256');
    assert.equal(a.clientId, 'app-1');
    assert.equal(a.state, started.state);
    // a wrong state is refused and the flow stays open
    const bad = await fetch(`${started.redirectUri}?code=${a.code}&state=nope`);
    assert.equal(bad.status, 400);
    const other = await fetch(`http://127.0.0.1:${started.port}/elsewhere`);
    assert.equal(other.status, 404);
    const ok = await fetch(`${started.redirectUri}?code=${a.code}&state=${a.state}`);
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /Connected/);
    const tokens = await flow.finished;
    assert.equal(tokens.accessToken, 'at_1');
    assert.equal(tokens.refreshToken, 'rt_1');
    assert.equal(tokens.expiresAt, 5000 + 3600 * 1000);
    assert.equal(tokens.scope, 'read_items');
    const tokenCall = fake.state.calls.find((c) => c.path === '/oauth/token');
    assert.equal(tokenCall.body.grant_type, 'authorization_code');
    assert.equal(tokenCall.body.redirect_uri, started.redirectUri);
    await assert.rejects(fetch(`${started.redirectUri}?code=x&state=${a.state}`), 'the callback server is closed after the exchange');
    // the platform refusing
    const f2 = createOAuthFlow({ authorizeUrl: `${fake.url}/oauth/authorize`, tokenUrl: `${fake.url}/oauth/token`, clientId: fake.clientId, redirectPort: 0 });
    const s2 = await f2.start();
    const denied = await fetch(`${s2.redirectUri}?error=access_denied&error_description=The+user+said+no&state=${s2.state}`);
    assert.equal(denied.status, 400);
    await assert.rejects(f2.finished, (e) => e.code === 'OAUTH_DENIED' && /said no/.test(e.message));
    // a bad code fails the exchange with the platform's words
    const f3 = createOAuthFlow({ authorizeUrl: `${fake.url}/oauth/authorize`, tokenUrl: `${fake.url}/oauth/token`, clientId: fake.clientId, redirectPort: 0 });
    const s3 = await f3.start();
    assert.equal((await fetch(`${s3.redirectUri}?code=bogus&state=${s3.state}`)).status, 502);
    await assert.rejects(f3.finished, (e) => e.code === 'HTTP_400' && /unknown code/.test(e.message));
    // cancel and timeout
    const f4 = createOAuthFlow({ authorizeUrl: `${fake.url}/oauth/authorize`, tokenUrl: `${fake.url}/oauth/token`, clientId: fake.clientId, redirectPort: 0 });
    await f4.start();
    f4.cancel();
    await assert.rejects(f4.finished, (e) => e.code === 'OAUTH_CANCELLED');
    const f5 = createOAuthFlow({ authorizeUrl: `${fake.url}/oauth/authorize`, tokenUrl: `${fake.url}/oauth/token`, clientId: fake.clientId, redirectPort: 0, timeoutMs: 20 });
    await f5.start();
    await assert.rejects(f5.finished, (e) => e.code === 'OAUTH_TIMEOUT');
    assert.throws(() => createOAuthFlow({ authorizeUrl: 'x' }), TypeError);
  } finally {
    await fake.close();
  }
});

async function harness({ env = {}, specs = null, fake } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-conn-'));
  const store = createStore({ root: path.join(dir, 'home') });
  await store.init();
  const bus = createEventBus();
  const events = [];
  bus.listen((e) => events.push(e));
  const clock = fakeClock(1_700_000_000_000);
  const layout = defaultLayout();
  layout.objects.push({ id: 'shop', kind: 'park_store', roomId: 'ranger-station', x: 2, y: 2 });
  const layoutState = createLayoutState({ initial: layout, store, bus, clock });
  const ledger = await createLeashLedger({ store, clock }).init();
  const leashState = createLeashState({ initial: defaultLeash(), store });
  const gateQueue = await createGateQueue({ bus, store, ledger, leashState, getLayout: layoutState.get, clock }).init();
  const scheduler = await createScheduler({ store, clock, tickMs: 60_000, log: { error() {} } }).init();
  const keystorePath = path.join(dir, 'home', 'keystore.json');
  const connectors = createConnectors({ bus, store, scheduler, gateQueue, env, keystorePath, clock, fetch: globalThis.fetch, config: { oauthPort: 0 }, log: { error() {}, warn() {} } });
  for (const spec of specs || [fakeSpec({ baseUrl: fake.url })]) connectors.define(spec);
  await connectors.init();
  const gate = createToolGate({ getLayout: layoutState.get, agentId: 'ranger', workspaceDir: path.join(dir, 'ws', 'ranger'), registry: { ...connectors.tools }, grants: allGrantsFor, toolContext: { connectors }, getLeash: () => leashState.get(), ledger, submit: { submit: (item) => gateQueue.submit({ ...item, runId: 'run-1', agentId: 'ranger' }), log: (item) => gateQueue.log({ ...item, runId: 'run-1', agentId: 'ranger' }) } });
  await fsp.mkdir(path.join(dir, 'ws', 'ranger'), { recursive: true });
  const ofType = (t) => events.filter((e) => e.type === t).map((e) => e.payload);
  return { dir, store, bus, events, ofType, clock, gateQueue, scheduler, keystorePath, connectors, gate, cleanup: async () => { await connectors.close(); await fsp.rm(dir, { recursive: true, force: true }); } };
}

test('an API key given through the UI is a Gate item: approve stores it 0600, connects, syncs and wires the job; reject stores nothing', async () => {
  const fake = await startFakeConnector();
  const h = await harness({ fake });
  try {
    assert.deepEqual(h.connectors.kinds(), ['fakeshop']);
    assert.deepEqual([...CONNECTOR_SPECS], [], 'no platform is wired in step 14');
    const before = h.connectors.status('fakeshop');
    assert.equal(before.connected, false);
    assert.equal(before.auth, 'api_key');
    assert.equal(before.summary, '0 item(s)');
    await assert.rejects(h.connectors.connect('fakeshop', {}), (e) => e.code === 'BAD_REQUEST');
    await assert.rejects(h.connectors.client('fakeshop'), (e) => e.code === 'NOT_CONNECTED');
    await assert.rejects(h.connectors.sync('fakeshop'), (e) => e.code === 'NOT_CONNECTED');
    assert.equal(h.ofType('connector.error').at(-1).stage, 'sync');
    const r = await h.connectors.connect('fakeshop', { apiKey: 'wrong-key' });
    assert.equal(r.status, 'pending');
    const item = h.gateQueue.pending().find((it) => it.itemId === r.itemId);
    assert.equal(item.domain, 'account_settings');
    assert.equal(item.agentId, 'superintendent');
    assert.equal(item.summary, 'connect Fake Shop with an API key');
    assert.ok(!JSON.stringify(item).includes('wrong-key'), 'the key never appears in the Gate item');
    assert.match(item.evidence[0].text, /ending in …-key/);
    await assert.rejects(h.connectors.connect('fakeshop', { apiKey: 'x' }), (e) => e.code === 'PENDING');
    await h.gateQueue.resolve(item.itemId, { decision: 'reject', notes: 'not now' });
    await waitUntil(() => h.ofType('connector.error').some((e) => e.stage === 'connect'));
    assert.equal(await resolveKey('fakeshop', { env: {}, keystorePath: h.keystorePath }), null, 'nothing stored');
    assert.equal(h.connectors.status('fakeshop').connected, false);
    // approve with a key the platform refuses: connected (the key is stored), first sync fails plainly
    const r2 = await h.connectors.connect('fakeshop', { apiKey: 'wrong-key' });
    await h.gateQueue.resolve(r2.itemId, { decision: 'approve' });
    await waitUntil(() => h.ofType('connector.sync').some((e) => e.status === 'failed'));
    const st = h.connectors.status('fakeshop');
    assert.equal(st.connected, true);
    assert.equal(st.by, 'keystore');
    assert.equal(st.lastSync.ok, false);
    assert.match(st.lastSync.error, /401/);
    assert.equal(h.ofType('connector.status').at(-1).change, 'connected');
    assert.equal(((await fsp.stat(h.keystorePath)).mode & 0o777), 0o600);
    assert.deepEqual((await keystoreStatus({ env: {}, keystorePath: h.keystorePath })).providers, ['fakeshop']);
    // a good key: the Superintendent "connects" again (a new key replaces the old one)
    const r3 = await h.connectors.connect('fakeshop', { apiKey: fake.apiKey });
    await h.gateQueue.resolve(r3.itemId, { decision: 'approve' });
    await waitUntil(() => h.ofType('connector.sync').some((e) => e.status === 'done'));
    const done = h.ofType('connector.sync').find((e) => e.status === 'done');
    assert.deepEqual(done.counts, { items: 1, new: 1 });
    assert.equal(done.reason, 'connected');
    assert.equal(h.connectors.status('fakeshop').summary, '1 item(s)');
    assert.deepEqual(h.connectors.data('fakeshop').items, [{ id: 'i1', amount: 500 }]);
    assert.ok(h.connectors.data('fakeshop').syncedAt);
    assert.deepEqual((await h.store.loadConnector('fakeshop', null)).items, [{ id: 'i1', amount: 500 }], 'persisted');
    assert.ok(h.scheduler.state()['connector-fakeshop'], 'a sync job is scheduled');
    assert.deepEqual(h.scheduler.state()['connector-fakeshop'].spec, { everyMs: 60_000 });
    assert.equal(DEFAULT_SYNC_MS, 15 * 60 * 1000);
    // the job runs the sync; a manual sync reports counts; a platform failure is an error event
    fake.state.items.push({ id: 'i2', amount: 700 });
    await h.scheduler.trigger('connector-fakeshop', 'test');
    await waitUntil(() => h.connectors.status('fakeshop').summary === '2 item(s)');
    assert.deepEqual((await h.connectors.sync('fakeshop')).counts, { items: 2, new: 0 });
    fake.state.fail = { status: 503, message: 'maintenance' };
    await assert.rejects(h.connectors.sync('fakeshop'), (e) => e.code === 'HTTP_503');
    assert.equal(h.ofType('connector.error').at(-1).code, 'HTTP_503');
    assert.equal(h.connectors.status('fakeshop').lastError.stage, 'sync');
    assert.equal(h.connectors.status('fakeshop').connected, true, 'a failed sync does not disconnect');
    fake.state.fail = null;
    // disconnect through the Gate removes the key and the job
    const d = await h.connectors.disconnect('fakeshop');
    const dItem = h.gateQueue.pending().find((it) => it.itemId === d.itemId);
    assert.equal(dItem.summary, 'disconnect Fake Shop');
    await h.gateQueue.resolve(d.itemId, { decision: 'approve' });
    await waitUntil(() => h.ofType('connector.status').some((e) => e.change === 'disconnected'));
    assert.equal(h.connectors.status('fakeshop').connected, false);
    assert.equal(await resolveKey('fakeshop', { env: {}, keystorePath: h.keystorePath }), null);
    assert.equal(h.scheduler.state()['connector-fakeshop'], undefined);
    assert.deepEqual(h.connectors.data('fakeshop').items.length, 2, 'the synced history stays');
    await assert.rejects(h.connectors.disconnect('fakeshop'), (e) => e.code === 'NOT_CONNECTED');
    assert.equal(h.connectors.status('nope'), null);
    assert.throws(() => h.connectors.data('nope'), (e) => e.code === 'UNKNOWN_CONNECTOR');
  } finally {
    await h.cleanup();
    await fake.close();
  }
});

test('an environment variable connects without the Gate; init restores a keystore connection; OAuth connect → Gate → sign-in → tokens stored → sync; expired tokens refresh', async () => {
  const fake = await startFakeConnector();
  // env key
  const h = await harness({ fake, env: { FAKESHOP_API_KEY: fake.apiKey } });
  try {
    const st = h.connectors.status('fakeshop');
    assert.equal(st.connected, true);
    assert.equal(st.by, 'env');
    assert.ok(h.scheduler.state()['connector-fakeshop']);
    assert.deepEqual((await h.connectors.sync('fakeshop', 'manual')).counts, { items: 1, new: 1 });
  } finally {
    await h.cleanup();
  }
  // OAuth
  const h2 = await harness({ fake, specs: [fakeSpec({ kind: 'oshop', label: 'OAuth Shop', auth: 'oauth2', baseUrl: fake.url, envVar: 'OSHOP_TOKEN' })], env: {} });
  try {
    await assert.rejects(h2.connectors.connect('oshop', {}), (e) => e.code === 'NO_CLIENT_ID', 'the app client id must exist first');
    const h3 = await harness({ fake, specs: [fakeSpec({ kind: 'oshop', label: 'OAuth Shop', auth: 'oauth2', baseUrl: fake.url, envVar: 'OSHOP_TOKEN' })], env: { OSHOPCLIENTID: 'ignored' } });
    await h3.cleanup();
    const { setKey } = await import('../sidecar/providers/keys.js');
    await setKey('oshopClientId', fake.clientId, { env: {}, keystorePath: h2.keystorePath });
    const r = await h2.connectors.connect('oshop', {});
    const item = h2.gateQueue.pending().find((it) => it.itemId === r.itemId);
    assert.equal(item.summary, 'connect OAuth Shop by signing in (OAuth)');
    assert.match(item.evidence[0].text, /read_items write_items/);
    await h2.gateQueue.resolve(item.itemId, { decision: 'approve' });
    const authz = await waitUntil(() => h2.ofType('connector.status').find((e) => e.change === 'authorizing'));
    assert.match(authz.authorizeUrl, /\/oauth\/authorize\?/);
    assert.equal(h2.connectors.status('oshop').authorizeUrl, authz.authorizeUrl);
    await assert.rejects(h2.connectors.connect('oshop', {}), (e) => e.code === 'PENDING');
    // the Superintendent signs in on the platform, which redirects to the local callback
    const a = fake.authorize(authz.authorizeUrl);
    assert.equal((await fetch(`${a.redirectUri}?code=${a.code}&state=${a.state}`)).status, 200);
    await waitUntil(() => h2.ofType('connector.sync').some((e) => e.status === 'done'));
    const st = h2.connectors.status('oshop');
    assert.equal(st.connected, true);
    assert.equal(st.auth, 'oauth2');
    assert.equal(st.authorizeUrl, null);
    const stored = JSON.parse(await resolveKey('oshop', { env: {}, keystorePath: h2.keystorePath }));
    assert.equal(stored.accessToken, 'at_1');
    assert.equal(stored.refreshToken, 'rt_1');
    // a restart finds the token and reconnects without a Gate item
    const h4 = await harness({ fake, specs: [fakeSpec({ kind: 'oshop', label: 'OAuth Shop', auth: 'oauth2', baseUrl: fake.url })], env: {} });
    try {
      await setKey('oshop', JSON.stringify({ ...stored, expiresAt: h4.clock.now() - 1 }), { env: {}, keystorePath: h4.keystorePath });
      await setKey('oshopClientId', fake.clientId, { env: {}, keystorePath: h4.keystorePath });
      const c2 = createConnectors({ bus: h4.bus, store: h4.store, scheduler: h4.scheduler, gateQueue: h4.gateQueue, env: {}, keystorePath: h4.keystorePath, clock: h4.clock, config: { oauthPort: 0 }, log: { error() {}, warn() {} } });
      c2.define(fakeSpec({ kind: 'oshop', label: 'OAuth Shop', auth: 'oauth2', baseUrl: fake.url }));
      await c2.init();
      assert.equal(c2.status('oshop').connected, true);
      assert.equal(c2.status('oshop').by, 'keystore');
      assert.deepEqual((await c2.sync('oshop')).counts.items, 1, 'an expired token is refreshed before the call');
      assert.equal(fake.state.refreshes, 1);
      const renewed = JSON.parse(await resolveKey('oshop', { env: {}, keystorePath: h4.keystorePath }));
      assert.notEqual(renewed.accessToken, 'at_1');
      assert.ok(renewed.expiresAt > h4.clock.now());
      await c2.close();
    } finally {
      await h4.cleanup();
    }
  } finally {
    await h2.cleanup();
    await fake.close();
  }
});

test('the Park Store grants the framework tools (research): connector.status and connector.sync through the gate', async () => {
  assert.deepEqual(OBJECT_KINDS.park_store.grants, ['connector.status', 'connector.sync']);
  assert.equal(TOOL_DOMAINS['connector.status'], 'research');
  assert.equal(TOOL_DOMAINS['connector.sync'], 'research');
  const fake = await startFakeConnector();
  const h = await harness({ fake, env: { FAKESHOP_API_KEY: fake.apiKey } });
  try {
    assert.deepEqual(h.gate.definitions().map((d) => d.name), ['connector.status', 'connector.sync']);
    const st = JSON.parse((await h.gate.execute({ id: 'c1', name: 'connector.status', input: {} }, { runId: 'run-1' })).output);
    assert.equal(st[0].kind, 'fakeshop');
    assert.equal(st[0].connected, true);
    assert.equal(st[0].syncedAt, null);
    const sync = await h.gate.execute({ id: 'c2', name: 'connector.sync', input: { kind: 'fakeshop' } }, { runId: 'run-1' });
    assert.equal(sync.ok, true, sync.error);
    assert.deepEqual(JSON.parse(sync.output).counts, { items: 1, new: 1 });
    assert.equal((await h.gate.execute({ id: 'c3', name: 'connector.sync', input: { kind: 'nope' } }, { runId: 'run-1' })).code, 'UNKNOWN_CONNECTOR');
    assert.equal(h.gateQueue.recent(10).filter((it) => it.domain === 'research').length, 0, 'research actions are not logged at the Gate (D38)');
  } finally {
    await h.cleanup();
    await fake.close();
  }
});

test('HTTP: /api/connectors rows and data, connect and disconnect are 202 Gate items, sync returns counts, errors are coded; the snapshot carries connectors', async () => {
  const fake = await startFakeConnector();
  const layout = defaultLayout();
  layout.objects.push({ id: 'shop', kind: 'park_store', roomId: 'ranger-station', x: 2, y: 2 });
  const provider = fakeProvider([[...toolCall('s1', 'connector.status', {}), end('tool_use')], [text('checked'), end()]]);
  const srv = await startTestServer({ layout, makeProvider: async () => ({ provider, model: 'm', price: null }), connectors: [fakeSpec({ baseUrl: fake.url })], connectorConfig: { oauthPort: 0 } });
  try {
    assert.ok((await srv.get('/api/state')).body.objectKinds.park_store);
    const list = await srv.get('/api/connectors');
    assert.equal(list.status, 200);
    assert.equal(list.body[0].kind, 'fakeshop');
    assert.equal(list.body[0].connected, false);
    assert.deepEqual((await srv.get('/api/state')).body.connectors.map((c) => c.kind), ['fakeshop']);
    assert.equal((await srv.get('/api/connectors/nope')).status, 404);
    assert.equal((await srv.post('/api/connectors/nope/sync', {})).status, 404);
    assert.equal((await srv.post('/api/connectors/fakeshop/sync', {})).status, 409, 'not connected');
    assert.equal((await srv.post('/api/connectors/fakeshop/connect', {})).status, 400);
    const stream = await srv.sse();
    const c = await srv.post('/api/connectors/fakeshop/connect', { apiKey: fake.apiKey });
    assert.equal(c.status, 202, JSON.stringify(c.body));
    assert.equal((await srv.get('/api/gate')).body.pending[0].itemId, c.body.itemId);
    assert.equal((await srv.get('/api/connectors')).body[0].pendingItemId, c.body.itemId);
    assert.equal((await srv.post(`/api/gate/${c.body.itemId}`, { decision: 'approve' })).status, 200);
    await stream.waitFor((e) => e.type === 'connector.sync' && e.payload.status === 'done');
    const one = await srv.get('/api/connectors/fakeshop');
    assert.equal(one.body.connected, true);
    assert.deepEqual(one.body.data.items, [{ id: 'i1', amount: 500 }]);
    assert.ok(!JSON.stringify(one.body).includes(fake.apiKey), 'no secret in the API');
    fake.state.items.push({ id: 'i2', amount: 1 });
    const s = await srv.post('/api/connectors/fakeshop/sync', {});
    assert.equal(s.status, 200);
    assert.deepEqual(s.body.counts, { items: 2, new: 1 });
    fake.state.fail = { status: 500 };
    const bad = await srv.post('/api/connectors/fakeshop/sync', {});
    assert.equal(bad.status, 502);
    assert.equal(bad.body.code, 'HTTP_500');
    fake.state.fail = null;
    // a Ranger with the Park Store reads the status through a run
    const r = await srv.post('/api/run', { prompt: 'check connectors' });
    assert.equal(r.status, 202);
    const start = await stream.waitFor((e) => e.type === 'agent.run.start' && e.payload.runId === r.body.runId);
    assert.ok(start.payload.tools.includes('connector.status'));
    const result = await stream.waitFor((e) => e.type === 'agent.tool_result' && e.payload.callId === 's1');
    assert.match(result.payload.output, /"connected":true/);
    await stream.waitFor((e) => e.type === 'agent.run.end' && e.payload.runId === r.body.runId);
    const d = await srv.post('/api/connectors/fakeshop/disconnect', {});
    assert.equal(d.status, 202);
    await srv.post(`/api/gate/${d.body.itemId}`, { decision: 'approve' });
    await stream.waitFor((e) => e.type === 'connector.status' && e.payload.change === 'disconnected');
    assert.equal((await srv.get('/api/connectors')).body[0].connected, false);
    stream.close();
  } finally {
    await srv.close();
    await fake.close();
  }
});
