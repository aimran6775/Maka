// Regression tests for docs/SECURITY_REVIEW_2026-10-10.md, one block per finding. Each
// reproduces the failure scenario the review describes; the fix makes it pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { TOOLS } from '../sidecar/capability/tools.js';
import { webReadTool } from '../sidecar/research/read.js';
import { BROWSER_TOOLS } from '../sidecar/browser/tools.js';
import { createBrowserControl } from '../sidecar/browser/control.js';
import { createEventBus } from '../sidecar/bus.js';
import { createNetGuard, guardedFetch, isPrivateAddress, isBlockedHostname } from '../sidecar/netguard.js';
import { createStore } from '../sidecar/store.js';
import { createLayoutState } from '../sidecar/server.js';
import { createLeashLedger, createLeashState } from '../sidecar/leash-ledger.js';
import { createGateQueue } from '../sidecar/gate-queue.js';
import { createScheduler } from '../sidecar/scheduler.js';
import { createToolGate } from '../sidecar/capability/gate.js';
import { createConnectors } from '../sidecar/connectors/registry.js';
import { metaAdsSpec } from '../sidecar/connectors/meta-ads.js';
import { googleAdsSpec, GOOGLE_ADS_SCOPES } from '../sidecar/connectors/google-ads.js';
import { setKey } from '../sidecar/providers/keys.js';
import { defaultLayout, allGrantsFor } from '../shared/world.js';
import { defaultLeash } from '../shared/leash.js';
import { startFakeMetaAds } from './helpers/fake-meta-ads.js';
import { startFakeGoogleAds } from './helpers/fake-google-ads.js';
import { fakeClock, waitUntil } from './helpers/fake-provider.js';

// A Ranger in a Marketing camp with a Notice board, the ad connectors against the fakes,
// and a gate over the connector tools (the shape of test/ads.test.js, kept small).
async function adsHarness({ meta, google, leash: leashPatch = {}, registry: extraTools = {} } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-safety-ads-'));
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
  const registry = { ...connectors.tools, ...extraTools };
  const grants = (l, id) => [...allGrantsFor(l, id), ...Object.keys(extraTools)];
  const gate = createToolGate({ getLayout: layoutState.get, agentId: 'mia', workspaceDir: path.join(dir, 'ws', 'mia'), registry, grants, toolContext: { connectors }, getLeash: () => leashState.get(), ledger, submit: { submit: (item) => gateQueue.submit({ ...item, runId: 'run-1', agentId: 'mia' }), log: (item) => gateQueue.log({ ...item, runId: 'run-1', agentId: 'mia' }) } });
  const call = (id, name, input) => gate.execute({ id, name, input }, { runId: 'run-1' });
  return { dir, events, clock, gateQueue, ledger, leashState, connectors, gate, call, cleanup: async () => { await connectors.close(); await fsp.rm(dir, { recursive: true, force: true }); } };
}

// ---------- H1: Rangers may not reach loopback, private or the sidecar's own addresses ----------

const FAKE_DNS = {
  'public.example': ['93.184.216.34'],
  'public6.example': ['2606:2800:220:1:248:1893:25c8:1946'],
  'evil.example': ['127.0.0.1'],
  'evil6.example': ['::1'],
  'mapped.example': ['::ffff:127.0.0.1'],
  'lan.example': ['93.184.216.34', '10.0.0.5'],
  'metadata.example': ['169.254.169.254'],
  'self.example': ['203.0.113.7'],
};
const fakeLookup = async (host) => {
  if (!FAKE_DNS[host]) {
    const err = new Error(`getaddrinfo ENOTFOUND ${host}`);
    err.code = 'ENOTFOUND';
    throw err;
  }
  return FAKE_DNS[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};
// 203.0.113.7 is documentation space (refused by the range rule anyway); 198.41.0.4 stands
// in for a public address this machine happens to own.
const fakeInterfaces = () => ({ en0: [{ address: '198.41.0.4', family: 'IPv4' }, { address: 'fe80::1%en0', family: 'IPv6' }], lo0: [{ address: '127.0.0.1', family: 'IPv4' }] });
const strictGuard = () => createNetGuard({ lookup: fakeLookup, interfaces: fakeInterfaces });

test('H1 rules: private, loopback, link-local, mapped and own addresses are refused; local names never resolve', () => {
  for (const ip of ['127.0.0.1', '127.9.9.9', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1', 'ff02::1', '2001:db8::1', 'nonsense']) {
    assert.equal(isPrivateAddress(ip), true, `${ip} is private`);
  }
  for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '172.15.0.1', '11.0.0.1', '2606:2800:220:1:248:1893:25c8:1946', '::ffff:93.184.216.34']) {
    assert.equal(isPrivateAddress(ip), false, `${ip} is public`);
  }
  for (const h of ['localhost', 'LOCALHOST', 'foo.localhost', 'printer.local', 'db.internal', 'router.home.arpa', 'nas', 'ip6-localhost', '']) assert.equal(isBlockedHostname(h), true, h);
  for (const h of ['example.com', 'sub.example.org', 'localhost.example.com']) assert.equal(isBlockedHostname(h), false, h);
});

test('H1 guard: checks after DNS resolution, every address, the machine\'s own interfaces and the sidecar\'s host; allowLocal is the test switch', async () => {
  const g = strictGuard();
  assert.equal((await g.check('https://public.example/page')).ok, true);
  assert.equal((await g.check('https://public6.example/')).ok, true);
  for (const url of ['http://127.0.0.1:8790/api/state', 'http://localhost:8790/api/gate/x', 'http://[::1]:8790/', 'http://0.0.0.0:8790/', 'http://10.0.0.1/', 'http://192.168.0.10/', 'http://169.254.169.254/latest/meta-data/', 'http://[::ffff:127.0.0.1]/', 'http://evil.example/', 'http://evil6.example/', 'http://mapped.example/', 'http://lan.example/', 'http://metadata.example/', 'http://self.example/', 'http://198.41.0.4/', 'http://printer.local/', 'http://unknown.example/', 'http://0x7f000001/', 'http://127.1/', 'http://2130706433/', 'ftp://public.example/']) {
    const v = await g.check(url);
    assert.equal(v.ok, false, `${url} is refused`);
    assert.ok(v.reason, url);
  }
  assert.match((await g.check('http://self.example/')).reason, /private|own/);
  assert.match((await g.check('http://198.41.0.4/')).reason, /own addresses/);
  await assert.rejects(g.assert('http://127.0.0.1/'), (e) => e.code === 'NET_GUARD');
  const off = createNetGuard({ lookup: fakeLookup, interfaces: fakeInterfaces, allowLocal: true });
  assert.equal(off.allowLocal, true);
  assert.equal((await off.check('http://127.0.0.1:1/')).ok, true, 'tests and the demo turn the guard off explicitly');
  assert.equal((await off.check('ftp://x/')).ok, false, 'the scheme rule still holds');
  // the real resolver: literals need no DNS
  const real = createNetGuard();
  assert.equal((await real.check('http://127.0.0.1:8790/')).ok, false);
  assert.equal((await real.check('http://[fe80::1]/')).ok, false);
});

test('H1 guardedFetch: a public page may not redirect a Ranger onto the sidecar; hops are bounded', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, redirect: init.redirect });
    if (url === 'https://public.example/go') return new Response('', { status: 302, headers: { location: 'http://127.0.0.1:8790/api/gate/g1' } });
    if (url === 'https://public.example/loop') return new Response('', { status: 301, headers: { location: 'https://public.example/loop' } });
    if (url === 'https://public.example/hop') return new Response('', { status: 307, headers: { location: '/landed' } });
    return new Response('landed', { status: 200, headers: { 'content-type': 'text/plain' } });
  };
  const guard = strictGuard();
  await assert.rejects(guardedFetch('https://public.example/go', {}, { fetch: fetchImpl, guard }), (e) => e.code === 'NET_GUARD' && /127\.0\.0\.1/.test(e.message));
  assert.deepEqual(calls.map((c) => c.url), ['https://public.example/go'], 'the loopback hop was never requested');
  assert.ok(calls.every((c) => c.redirect === 'manual'));
  calls.length = 0;
  const ok = await guardedFetch('https://public.example/hop', {}, { fetch: fetchImpl, guard });
  assert.equal(await ok.text(), 'landed');
  assert.deepEqual(calls.map((c) => c.url), ['https://public.example/hop', 'https://public.example/landed']);
  await assert.rejects(guardedFetch('https://public.example/loop', {}, { fetch: fetchImpl, guard, maxRedirects: 3 }), (e) => e.code === 'TOO_MANY_REDIRECTS');
  await assert.rejects(guardedFetch('http://127.0.0.1:8790/api/state', {}, { fetch: fetchImpl, guard }), (e) => e.code === 'NET_GUARD');
});

test('H1 web.fetch and web.read refuse Maka\'s own routes, private hosts and redirects onto them, before any request', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === 'https://public.example/bounce') return new Response('', { status: 302, headers: { location: 'http://localhost:8790/api/state' } });
    return new Response('<html><body><article><p>Public page with enough words to count as an article body for the reader.</p><p>Second paragraph.</p></article></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  };
  const netGuard = strictGuard();
  const fetchTool = TOOLS['web.fetch'];
  const readTool = webReadTool({ fetch: fetchImpl });
  for (const url of ['http://127.0.0.1:8790/api/state', 'http://localhost:8790/api/gate/g1', 'http://evil.example/', 'http://192.168.1.20/', 'http://[::1]:8790/']) {
    const f = await fetchTool.run({ url }, { fetch: fetchImpl, netGuard });
    assert.equal(f.ok, false, `web.fetch ${url}`);
    assert.equal(f.code, 'NET_GUARD', `web.fetch ${url}`);
    const r = await readTool.run({ url }, { netGuard });
    assert.equal(r.ok, false, `web.read ${url}`);
    assert.equal(r.code, 'NET_GUARD', `web.read ${url}`);
  }
  assert.deepEqual(calls, [], 'nothing was requested');
  const bounced = await fetchTool.run({ url: 'https://public.example/bounce' }, { fetch: fetchImpl, netGuard });
  assert.equal(bounced.ok, false);
  assert.equal(bounced.code, 'NET_GUARD');
  const bouncedRead = await readTool.run({ url: 'https://public.example/bounce' }, { netGuard });
  assert.equal(bouncedRead.ok, false);
  assert.equal(bouncedRead.code, 'NET_GUARD');
  assert.deepEqual(calls, ['https://public.example/bounce', 'https://public.example/bounce'], 'the redirect target was never requested');
  // without a guard in the context the strict default applies
  assert.equal((await fetchTool.run({ url: 'http://127.0.0.1:8790/api/state' }, { fetch: fetchImpl })).code, 'NET_GUARD');
  assert.equal((await readTool.run({ url: 'http://127.0.0.1:8790/api/state' }, {})).code, 'NET_GUARD');
  // public pages still work
  const ok = await fetchTool.run({ url: 'https://public.example/page' }, { fetch: fetchImpl, netGuard });
  assert.equal(ok.ok, true, ok.error);
  const okRead = await readTool.run({ url: 'https://public.example/page' }, { netGuard });
  assert.equal(okRead.ok, true, okRead.error);
});

function fakeBrowserDriver() {
  const state = { launched: 0, navigated: [] };
  const driver = {
    state,
    find: async () => '/fake/chromium',
    launch: async () => { state.launched += 1; return { wsUrl: 'ws://fake', pid: 1, kill() {} }; },
    connect: async () => ({ close() {}, closed: new Promise(() => {}) }),
    openPage: async () => {
      const p = { url: 'about:blank', title: '' };
      return {
        url: () => p.url,
        async navigate(u) { state.navigated.push(u); p.url = u; p.title = 'page'; return { url: u, title: p.title }; },
        async summary() { return { url: p.url, title: p.title }; },
        async facts() { return { url: p.url, title: p.title, text: 'Paper lanterns' }; },
        async text() { return `text of ${p.url}`; },
        async tree() { return []; },
        // a click on a public page that lands on the sidecar's own UI
        async click(t) { if (t.text === 'Open Maka') { p.url = 'http://127.0.0.1:8790/'; p.title = 'Maka'; } return { tag: 'a', text: t.text }; },
        async type() { return { tag: 'input', text: '' }; },
        async upload() { return {}; },
        async download(input, dir) { const f = path.join(dir, 'x.bin'); await fsp.writeFile(f, 'x'); return { path: f, bytes: 1, url: input.url }; },
        async screenshot() { return Buffer.from('\x89PNG fake'); },
        async bringToFront() {},
        async close() {},
      };
    },
  };
  return driver;
}

test('H1 browser.open and browser.download refuse local targets before launching; a page that lands on the sidecar is left at once', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-safety-'));
  const bus = createEventBus();
  const driver = fakeBrowserDriver();
  const netGuard = strictGuard();
  const browser = await createBrowserControl({ bus, workspaceRoot: dir, env: {}, config: { headless: true }, driver, netGuard, log: { error() {} } }).init();
  try {
    const ctx = { browser, agentId: 'ranger', runId: 'run-1', workspaceDir: path.join(dir, 'ranger'), netGuard };
    await fsp.mkdir(ctx.workspaceDir, { recursive: true });
    for (const url of ['http://127.0.0.1:8790/', 'http://localhost:8790/api/state', 'http://evil.example/', 'http://10.0.0.1/', 'http://[::1]:8790/']) {
      const o = await BROWSER_TOOLS['browser.open'].run({ url }, ctx);
      assert.equal(o.ok, false, `open ${url}`);
      assert.equal(o.code, 'NET_GUARD', `open ${url}`);
      const d = await BROWSER_TOOLS['browser.download'].run({ url }, ctx);
      assert.equal(d.ok, false, `download ${url}`);
      assert.equal(d.code, 'NET_GUARD', `download ${url}`);
    }
    assert.equal(driver.state.launched, 0, 'no browser was launched for a refused URL');
    assert.deepEqual(driver.state.navigated, []);
    // the strict default applies when the context names no guard
    assert.equal((await BROWSER_TOOLS['browser.open'].run({ url: 'http://127.0.0.1:8790/' }, { ...ctx, netGuard: undefined })).code, 'NET_GUARD');
    // a public page opens; a click that lands on the sidecar's UI is refused and the page is left
    const open = await BROWSER_TOOLS['browser.open'].run({ url: 'https://public.example/' }, ctx);
    assert.equal(open.ok, true, open.error);
    const click = await BROWSER_TOOLS['browser.click'].run({ text: 'Open Maka' }, ctx);
    assert.equal(click.ok, false);
    assert.equal(click.code, 'NET_GUARD');
    const session = await browser.forAgent('ranger');
    assert.equal(session.page.url(), 'about:blank', 'the browser left the sidecar\'s page');
    assert.equal(driver.state.navigated.at(-1), 'about:blank');
  } finally {
    await browser.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ---------- H2: a money_out action whose amount cannot be proven is a Gate item ----------

test('H2 activating an ad campaign with no campaign-level daily budget is never $0: a lifetime budget counts in full, no budget at all goes to the Gate and is refused when approved', async () => {
  const meta = await startFakeMetaAds();
  const google = await startFakeGoogleAds();
  // c3: a paused campaign whose budgets live on its ad sets (no campaign-level budget)
  meta.state.campaigns.push({ id: 'c3', name: 'Lanterns – Adset budgets', status: 'PAUSED', effective_status: 'PAUSED', objective: 'OUTCOME_SALES', created_time: '2026-09-01T00:00:00+0000', updated_time: '2026-09-01T00:00:00+0000' });
  const h = await adsHarness({ meta, google, leash: { money_out: { level: 'act_capped', dailyCapUsd: 0 } } });
  try {
    await h.connectors.sync('meta_ads', 'manual');
    await h.connectors.sync('google_ads', 'manual');
    const c3 = h.connectors.data('meta_ads').campaigns.find((c) => c.id === 'c3');
    assert.equal(c3.dailyBudget, null);
    assert.equal(c3.lifetimeBudget, null);
    const posts = () => meta.state.calls.filter((c) => c.method === 'POST').length;
    // no budget at all: the amount cannot be proven → a Gate item with no amount, not a $0 pass
    const activate = h.call('a1', 'meta_ads.set_status', { campaignId: 'c3', status: 'ACTIVE' });
    const item = await waitUntil(() => h.gateQueue.pending()[0]);
    assert.equal(item.tool, 'meta_ads.set_status');
    assert.equal(item.amountUsd, undefined, 'no amount is claimed');
    assert.match(item.reason, /cannot be proven/);
    await h.gateQueue.resolve(item.itemId, { decision: 'approve' });
    const refused = await activate;
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'NO_BUDGET');
    assert.equal(posts(), 0, 'Meta never saw the activation');
    assert.equal(meta.state.campaigns.find((c) => c.id === 'c3').status, 'PAUSED');
    // a lifetime budget only: counted in full against the cap → waits at the Gate under the cap
    const lifetime = h.call('a2', 'meta_ads.set_status', { campaignId: 'c2', status: 'ACTIVE' });
    const capped = await waitUntil(() => h.gateQueue.pending()[0]);
    assert.equal(capped.amountUsd, 500, 'the lifetime budget is the amount');
    assert.match(capped.reason, /cap/);
    await h.gateQueue.resolve(capped.itemId, { decision: 'reject', notes: 'no' });
    assert.equal((await lifetime).code, 'GATE_REJECT');
    assert.equal(posts(), 0);
    // Google: a campaign whose budget the store does not know
    const g = h.connectors.data('google_ads').campaigns.find((c) => c.status === 'PAUSED');
    g.dailyBudget = null;
    const enable = h.call('a3', 'google_ads.set_status', { campaignId: g.id, status: 'ENABLED' });
    const gitem = await waitUntil(() => h.gateQueue.pending()[0]);
    assert.equal(gitem.amountUsd, undefined);
    assert.match(gitem.reason, /cannot be proven/);
    await h.gateQueue.resolve(gitem.itemId, { decision: 'approve' });
    assert.equal((await enable).code, 'NO_BUDGET');
    assert.equal(google.state.calls.filter((c) => c.path.endsWith('campaigns:mutate')).length, 0, 'Google never saw the enable');
    // pausing moves nothing and still passes under a $0 cap; a daily budget still counts
    const paused = await h.call('a4', 'meta_ads.set_status', { campaignId: 'c1', status: 'PAUSED' });
    assert.equal(paused.ok, true, paused.error);
    assert.equal(h.gateQueue.recent(20).find((it) => it.callId === 'a4').amountUsd, 0);
    assert.equal(h.ledger.summary().domains.money_out.usd, 0);
  } finally {
    await h.cleanup();
    await meta.close();
    await google.close();
  }
});

test('H2 the gate: a money_out tool whose amountUsd is unknown (null, non-finite or throwing) is a Gate item even at Act freely; a proven zero passes; an unknown amount approved at the Gate is counted as an action, not as money', async () => {
  const ran = [];
  const moneyTool = (name, amount) => ({ name, description: name, inputSchema: { type: 'object', additionalProperties: false, properties: {} }, confirm: false, domain: 'money_out', amountUsd: amount, summarize: () => name, async run() { ran.push(name); return { ok: true, output: 'done' }; } });
  const registry = { 'pay.unknown': moneyTool('pay.unknown', () => null), 'pay.nan': moneyTool('pay.nan', () => NaN), 'pay.throws': moneyTool('pay.throws', () => { throw new Error('no store'); }), 'pay.negative': moneyTool('pay.negative', () => -5), 'pay.zero': moneyTool('pay.zero', () => 0), 'pay.none': moneyTool('pay.none', undefined) };
  const h = await adsHarness({ leash: { money_out: { level: 'act_free' } }, registry });
  try {
    for (const name of ['pay.unknown', 'pay.nan', 'pay.throws', 'pay.negative', 'pay.none']) {
      const pending = h.call(name, name, {});
      const item = await waitUntil(() => h.gateQueue.pending()[0]);
      assert.equal(item.tool, name);
      assert.equal(item.amountUsd, undefined, `${name}: no amount is claimed`);
      assert.equal(item.level, 'act_free');
      assert.match(item.reason, /cannot be proven/);
      await h.gateQueue.resolve(item.itemId, { decision: 'reject', notes: 'no' });
      assert.equal((await pending).code, 'GATE_REJECT', name);
    }
    assert.deepEqual(ran, []);
    const zero = await h.call('z', 'pay.zero', {});
    assert.equal(zero.ok, true);
    assert.deepEqual(ran, ['pay.zero']);
    const approved = h.call('u2', 'pay.unknown', {});
    const item = await waitUntil(() => h.gateQueue.pending()[0]);
    await h.gateQueue.resolve(item.itemId, { decision: 'approve' });
    assert.equal((await approved).ok, true);
    assert.deepEqual(h.ledger.summary().domains.money_out, { usd: 0, actions: 2 }, 'the action is counted; no money is invented');
  } finally {
    await h.cleanup();
  }
});
