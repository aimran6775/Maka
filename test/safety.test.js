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
import { defaultLeash, resolveLeash } from '../shared/leash.js';
import { startFakeMetaAds } from './helpers/fake-meta-ads.js';
import { startFakeGoogleAds } from './helpers/fake-google-ads.js';
import { fakeClock, waitUntil, fakeProvider, text, end } from './helpers/fake-provider.js';
import { startTestServer } from './helpers/test-server.js';
import { createAgents } from '../sidecar/agents.js';
import { createMailSystem } from '../sidecar/mail/system.js';
import { startFakeResend } from './helpers/fake-resend.js';

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

// ---------- M1: the daily cap is reserved before the action runs, not recorded after ----------

test('M1 four Rangers spending $40 each under a $50 cap at once: one runs, three wait at the Gate; a failed action releases its reservation, a successful one commits it', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-safety-m1-'));
  const store = createStore({ root: path.join(dir, 'home') });
  await store.init();
  const bus = createEventBus();
  const clock = fakeClock(1_700_000_000_000);
  const layout = defaultLayout();
  for (const id of ['r1', 'r2', 'r3', 'r4']) layout.agents.push({ id, name: id, roomId: 'ranger-station', x: 1, y: 1, role: 'ranger' });
  const layoutState = createLayoutState({ initial: layout, store, bus, clock });
  const ledger = await createLeashLedger({ store, clock }).init();
  const leash = defaultLeash();
  leash.domains.money_out = { level: 'act_capped', dailyCapUsd: 50 };
  const leashState = createLeashState({ initial: leash, store });
  const gateQueue = await createGateQueue({ bus, store, ledger, leashState, getLayout: layoutState.get, clock }).init();
  let release;
  const blocked = new Promise((r) => { release = r; });
  let outcome = { ok: true, output: 'paid' };
  const ran = [];
  const pay = { name: 'pay.supplier', description: 'pay', inputSchema: { type: 'object', additionalProperties: false, properties: { usd: { type: 'number' } } }, confirm: false, domain: 'money_out', amountUsd: (input) => input.usd, summarize: (i) => `pay $${i.usd}`, async run(input, ctx) { ran.push(ctx.agentId); await blocked; return outcome; } };
  const gateFor = (agentId) => createToolGate({ getLayout: layoutState.get, agentId, workspaceDir: path.join(dir, agentId), registry: { 'pay.supplier': pay }, grants: () => ['pay.supplier'], getLeash: () => leashState.get(), ledger, submit: { submit: (item) => gateQueue.submit({ ...item, runId: `run-${agentId}`, agentId }), log: (item) => gateQueue.log({ ...item, runId: `run-${agentId}`, agentId }) } });
  try {
    // all four check the cap in the same tick, before any of them has recorded a cent
    const calls = ['r1', 'r2', 'r3', 'r4'].map((id) => gateFor(id).execute({ id: `c-${id}`, name: 'pay.supplier', input: { usd: 40 } }, { runId: `run-${id}` }));
    await waitUntil(() => ran.length + gateQueue.pending().length === 4);
    assert.equal(ran.length, 1, 'exactly one $40 action runs under a $50 cap');
    assert.equal(gateQueue.pending().length, 3, 'the other three wait at the Gate');
    for (const it of gateQueue.pending()) {
      assert.match(it.reason, /cap/);
      assert.match(it.reason, /reserved|in flight|40/);
    }
    assert.deepEqual(ledger.spentToday('money_out'), { usd: 0, actions: 0 }, 'nothing is recorded until an action succeeds');
    assert.equal(ledger.reservedToday('money_out').usd, 40, 'the running action holds its reservation');
    // the running one fails: its reservation is released and the next $40 may run
    outcome = { ok: false, error: 'card declined' };
    release();
    const first = await calls[ran[0] === 'r1' ? 0 : ran[0] === 'r2' ? 1 : ran[0] === 'r3' ? 2 : 3];
    assert.equal(first.ok, false);
    assert.deepEqual(ledger.spentToday('money_out'), { usd: 0, actions: 0 });
    assert.deepEqual(ledger.reservedToday('money_out'), { usd: 0, actions: 0 }, 'a failed action releases what it reserved');
    for (const it of gateQueue.pending()) await gateQueue.resolve(it.itemId, { decision: 'reject', notes: 'no' });
    for (const c of await Promise.all(calls)) if (c.ok !== false || c.code !== 'GATE_REJECT') assert.equal(c.ok, false);
    outcome = { ok: true, output: 'paid' };
    const again = await gateFor('r2').execute({ id: 'c-again', name: 'pay.supplier', input: { usd: 40 } }, { runId: 'run-r2' });
    assert.equal(again.ok, true, again.error);
    assert.deepEqual(ledger.spentToday('money_out'), { usd: 40, actions: 1 }, 'a successful action commits its reservation');
    assert.deepEqual(ledger.reservedToday('money_out'), { usd: 0, actions: 0 });
    // the ledger's own API: reserve → the cap sees the reservation; release and commit
    const r = ledger.reserve({ domain: 'money_out', amountUsd: 10, dailyCapUsd: 50 });
    assert.equal(r.ok, true);
    assert.equal(ledger.checkCap({ domain: 'money_out', amountUsd: 1, dailyCapUsd: 50 }).ok, false, 'the cap counts the reservation');
    r.release();
    assert.equal(ledger.checkCap({ domain: 'money_out', amountUsd: 1, dailyCapUsd: 50 }).ok, true);
    const r2 = ledger.reserve({ domain: 'money_out', amountUsd: 5, dailyCapUsd: 50, dailyCapActions: 2 });
    assert.equal(r2.ok, true);
    assert.equal(ledger.reserve({ domain: 'money_out', amountUsd: 0, dailyCapUsd: 50, dailyCapActions: 2 }).ok, false, 'the action cap counts reservations too');
    await r2.commit();
    assert.deepEqual(ledger.spentToday('money_out'), { usd: 45, actions: 2 });
    r2.release();
    assert.deepEqual(ledger.spentToday('money_out'), { usd: 45, actions: 2 }, 'a committed reservation cannot be released');
    assert.equal(ledger.reserve({ domain: 'money_out', amountUsd: 6, dailyCapUsd: 50 }).ok, false);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ---------- M2: money caps cannot be dropped by a looser layer, a proposal or an agent-scoped cap ----------

test('M2 resolveLeash inherits the daily caps from the zone and the park when the winning layer omits them', () => {
  const leash = defaultLeash(); // park money_out: draft, dailyCapUsd 0
  leash.domains.publishing = { level: 'draft', dailyCapActions: 3 };
  leash.zones = { camp: { domains: { money_out: { level: 'act_capped', dailyCapUsd: 20 }, publishing: { level: 'act_capped' } } } };
  leash.agents = { mia: { domains: { money_out: { level: 'act_capped' }, publishing: { level: 'act_free' } } }, bo: { domains: { money_out: { level: 'act_capped', dailyCapUsd: 30, dailyCapActions: 2 } } } };
  const mia = resolveLeash(leash, { agentId: 'mia', roomId: 'camp' }, 'money_out');
  assert.deepEqual(mia, { domain: 'money_out', level: 'act_capped', dailyCapUsd: 20, dailyCapActions: null, scope: 'agent' }, 'an agent entry without a cap takes the zone cap');
  const miaElsewhere = resolveLeash(leash, { agentId: 'mia', roomId: 'station' }, 'money_out');
  assert.deepEqual(miaElsewhere, { domain: 'money_out', level: 'act_capped', dailyCapUsd: 0, dailyCapActions: null, scope: 'agent' }, 'no zone entry: the park cap');
  assert.deepEqual(resolveLeash(leash, { agentId: 'bo', roomId: 'camp' }, 'money_out'), { domain: 'money_out', level: 'act_capped', dailyCapUsd: 30, dailyCapActions: 2, scope: 'agent' }, 'an agent entry with its own caps keeps them');
  assert.deepEqual(resolveLeash(leash, { agentId: 'zed', roomId: 'camp' }, 'publishing'), { domain: 'publishing', level: 'act_capped', dailyCapUsd: null, dailyCapActions: 3, scope: 'zone' }, 'a zone entry without a cap takes the park cap');
  assert.deepEqual(resolveLeash(leash, { agentId: 'mia', roomId: 'camp' }, 'publishing'), { domain: 'publishing', level: 'act_free', dailyCapUsd: null, dailyCapActions: 3, scope: 'agent' }, 'act_free still carries the cap it inherits');
  assert.deepEqual(resolveLeash(leash, { agentId: 'zed', roomId: 'station' }, 'money_out'), { domain: 'money_out', level: 'draft', dailyCapUsd: 0, dailyCapActions: null, scope: 'park' });
});

test('M2 no proposal loosens a money domain to Act freely; money caps hold at Act freely; an agent-scoped cap counts that agent\'s own spend', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-safety-m2-'));
  const store = createStore({ root: path.join(dir, 'home') });
  await store.init();
  const bus = createEventBus();
  const clock = fakeClock(1_700_000_000_000);
  const layout = defaultLayout();
  layout.rooms.push({ id: 'camp', name: 'Camp', kind: 'marketing', x: 21, y: 1, w: 8, h: 6 });
  for (const id of ['mia', 'bo', 'pat']) layout.agents.push({ id, name: id, roomId: 'camp', x: 21, y: 1, role: 'ranger' });
  const layoutState = createLayoutState({ initial: layout, store, bus, clock });
  const ledger = await createLeashLedger({ store, clock, earnApprovals: 2 }).init();
  const leash = defaultLeash();
  leash.earn = { approvals: 2 };
  leash.domains.money_out = { level: 'draft', dailyCapUsd: 50 };
  leash.domains.money_in = { level: 'act_capped', dailyCapActions: 0 }; // every price change waits at the Gate
  leash.domains.publishing = { level: 'act_capped' };
  const leashState = createLeashState({ initial: leash, store });
  const gateQueue = await createGateQueue({ bus, store, ledger, leashState, getLayout: layoutState.get, clock }).init();
  const ran = [];
  const tool = (name, domain) => ({ name, description: name, inputSchema: { type: 'object', additionalProperties: false, properties: { usd: { type: 'number' } } }, confirm: false, domain, amountUsd: (i) => i.usd || 0, summarize: (i) => `${name} $${i.usd || 0}`, async run(input, ctx) { ran.push(`${ctx.agentId}:${name}:${input.usd || 0}`); return { ok: true, output: 'ok' }; } });
  const registry = { 'pay.out': tool('pay.out', 'money_out'), 'price.set': tool('price.set', 'money_in'), 'post.it': tool('post.it', 'publishing') };
  const gateFor = (agentId) => createToolGate({ getLayout: layoutState.get, agentId, workspaceDir: path.join(dir, agentId), registry, grants: () => Object.keys(registry), getLeash: () => leashState.get(), ledger, submit: { submit: (item) => gateQueue.submit({ ...item, runId: `run-${agentId}`, agentId }), log: (item) => gateQueue.log({ ...item, runId: `run-${agentId}`, agentId }) } });
  const call = (agentId, name, usd, id = `${agentId}-${name}-${usd}-${Math.random().toString(36).slice(2, 6)}`) => gateFor(agentId).execute({ id, name, input: { usd } }, { runId: `run-${agentId}` });
  const decide = async (decision) => {
    const item = await waitUntil(() => gateQueue.pending().find((it) => it.kind === 'action'));
    await gateQueue.resolve(item.itemId, { decision, notes: '' });
    return item;
  };
  try {
    // (1) two approvals in a row at Draft propose Act with cap for money_out; approving keeps the park cap
    let p = call('mia', 'pay.out', 5);
    await decide('approve');
    await p;
    p = call('mia', 'pay.out', 5);
    await decide('approve');
    await p;
    const first = gateQueue.pending().find((it) => it.kind === 'proposal');
    assert.ok(first, 'a proposal to loosen money_out from Draft to Act with cap');
    assert.deepEqual(first.proposal, { from: 'draft', to: 'act_capped' });
    await gateQueue.resolve(first.itemId, { decision: 'approve' });
    assert.deepEqual(resolveLeash(leashState.get(), { agentId: 'mia', roomId: 'camp' }, 'money_out'), { domain: 'money_out', level: 'act_capped', dailyCapUsd: 50, dailyCapActions: null, scope: 'agent' });
    // (2) at Act with cap, two more approvals (over the cap) never propose Act freely for money
    p = call('mia', 'pay.out', 60);
    let item = await decide('approve');
    assert.match(item.reason, /cap/);
    await p;
    p = call('mia', 'pay.out', 60);
    await decide('approve');
    await p;
    assert.equal(gateQueue.pending().filter((it) => it.kind === 'proposal').length, 0, 'money_out is never proposed for Act freely');
    assert.equal(ledger.streak('mia', 'money_out'), 0, 'the streak still resets at the ceiling, so it does not propose forever');
    // money_in likewise; publishing may still be proposed for Act freely
    for (let i = 0; i < 2; i++) {
      p = call('bo', 'price.set', 0);
      await decide('approve');
      await p;
    }
    assert.equal(gateQueue.pending().filter((it) => it.kind === 'proposal' && it.domain === 'money_in').length, 0, 'money_in is never proposed for Act freely');
    for (let i = 0; i < 2; i++) {
      await leashState.update((l) => ({ ...l, domains: { ...l.domains, publishing: { level: 'act_capped', dailyCapActions: 0 } } }));
      p = call('bo', 'post.it', 0);
      await decide('approve');
      await p;
    }
    const pub = gateQueue.pending().find((it) => it.kind === 'proposal' && it.domain === 'publishing');
    assert.ok(pub, 'publishing may be proposed for Act freely');
    assert.deepEqual(pub.proposal, { from: 'act_capped', to: 'act_free' });
    await gateQueue.resolve(pub.itemId, { decision: 'reject' });
    // (3) the Superintendent sets Act freely by hand: the money cap is still enforced
    await leashState.update((l) => ({ ...l, agents: { ...l.agents, pat: { domains: { money_out: { level: 'act_free' } } } } }));
    assert.equal(resolveLeash(leashState.get(), { agentId: 'pat', roomId: 'camp' }, 'money_out').dailyCapUsd, 50, 'act_free inherits the park cap');
    const under = await call('pat', 'pay.out', 40);
    assert.equal(under.ok, true, under.error);
    p = call('pat', 'pay.out', 40);
    item = await decide('reject');
    assert.equal(item.level, 'act_free');
    assert.match(item.reason, /cap/);
    assert.equal((await p).code, 'GATE_REJECT');
    await leashState.update((l) => ({ ...l, agents: { ...l.agents, pat: { domains: { money_out: { level: 'act_free', dailyCapUsd: 100 } } } } }));
    assert.equal((await call('pat', 'pay.out', 40)).ok, true, 'a raised cap at act_free is honoured');
    // (4) an agent-scoped cap is compared with that agent's own spend, not the park's
    assert.equal(ledger.spentToday('money_out').usd, 210, 'the park total so far (5+5+60+60+40+40)');
    await leashState.update((l) => ({ ...l, agents: { ...l.agents, bo: { domains: { money_out: { level: 'act_capped', dailyCapUsd: 50 } } } } }));
    assert.deepEqual(ledger.spentToday('money_out', { agentId: 'bo' }), { usd: 0, actions: 0 });
    const bo1 = await call('bo', 'pay.out', 40);
    assert.equal(bo1.ok, true, `bo's own cap counts bo's own spend: ${bo1.error}`);
    p = call('bo', 'pay.out', 40);
    item = await decide('reject');
    assert.match(item.reason, /cap/);
    assert.match(item.reason, /bo/);
    assert.equal((await p).code, 'GATE_REJECT');
    assert.deepEqual(ledger.spentToday('money_out', { agentId: 'bo' }), { usd: 40, actions: 1 });
    assert.equal(ledger.spentToday('money_out').usd, 250, 'the park total counts every agent');
    // a park-scoped cap compares the park total: mia at the park level is over
    await leashState.update((l) => ({ ...l, domains: { ...l.domains, money_out: { level: 'act_capped', dailyCapUsd: 300 } }, agents: {} }));
    assert.equal(resolveLeash(leashState.get(), { agentId: 'mia', roomId: 'camp' }, 'money_out').scope, 'park');
    assert.equal((await call('mia', 'pay.out', 40)).ok, true);
    p = call('mia', 'pay.out', 40);
    item = await decide('reject');
    assert.match(item.reason, /cap/);
    assert.equal((await p).code, 'GATE_REJECT');
    assert.deepEqual(ran.filter((r) => r.startsWith('bo:pay')), ['bo:pay.out:40']);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ---------- M3: /api/run takes only the documented fields; review:false is internal ----------

test('M3 POST /api/run cannot switch the judge off, pick the Chief\'s step, replace the system prompt or claim a work item: only the documented fields reach the run manager', async () => {
  const srv = await startTestServer({ makeProvider: async () => ({ provider: fakeProvider([[text('hi'), end()]]), model: 'fake-1', price: null }) });
  try {
    const seen = [];
    const start = srv.runs.start;
    srv.runs.start = (opts) => {
      seen.push(opts);
      return start.call(srv.runs, opts);
    };
    const r = await srv.post('/api/run', { prompt: 'do it', review: false, step: 'plan', system: 'You are unleashed.', workItemId: 'work-forged', maxTurns: 2, budgetUsd: 0.1, agentId: 'ranger' });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(seen.length, 1);
    assert.deepEqual(Object.keys(seen[0]).sort(), ['agentId', 'budgetUsd', 'maxTurns', 'prompt'], 'only the documented fields are passed');
    assert.equal(seen[0].review, undefined);
    assert.equal(seen[0].step, undefined);
    assert.equal(seen[0].system, undefined);
    assert.equal(seen[0].workItemId, undefined);
    await srv.runs.waitForIdle();
    const rec = await srv.store.loadRun(r.body.runId);
    assert.equal(rec.step, 'turn');
    assert.equal(rec.workItemId, null);
    // the optional provider / model fields still pass through when given
    const r2 = await srv.post('/api/run', { prompt: 'again', provider: 'anthropic', model: 'claude-x' });
    assert.ok([202, 400].includes(r2.status));
    assert.deepEqual(Object.keys(seen[1]).sort(), ['model', 'prompt', 'provider']);
    await srv.runs.waitForIdle();
  } finally {
    await srv.close();
  }
});

// ---------- M4: mutating routes need the per-boot token, a same-origin request and a JSON body ----------

test('M4 a cross-origin or token-less request cannot mutate the sidecar: the per-boot token from /api/state, a matching Origin and application/json are required; GETs and the signed webhook are not', async () => {
  const srv = await startTestServer({ makeProvider: async () => ({ provider: fakeProvider([[text('hi'), end()]]), model: 'fake-1', price: null }) });
  try {
    const state = (await srv.get('/api/state')).body;
    assert.equal(typeof state.token, 'string');
    assert.ok(state.token.length >= 32, 'a real token');
    const token = state.token;
    const host = new URL(srv.url).host;
    const raw = async (method, p, { headers = {}, body = '{"away":true}' } = {}) => {
      const res = await fetch(srv.url + p, { method, headers, body });
      let parsed = null;
      try {
        parsed = await res.json();
      } catch {
        /* no body */
      }
      return { status: res.status, body: parsed };
    };
    const json = { 'content-type': 'application/json' };
    // no token: refused before anything is read
    let r = await raw('POST', '/api/away', { headers: json });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'TOKEN_REQUIRED');
    assert.equal(srv.away.state().away, false, 'nothing changed');
    // a wrong token
    r = await raw('POST', '/api/away', { headers: { ...json, 'x-maka-token': 'nope' } });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'TOKEN_INVALID');
    // a cross-site page that somehow holds the token: the Origin does not match the Host
    r = await raw('POST', '/api/away', { headers: { ...json, 'x-maka-token': token, origin: 'http://evil.example' } });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'ORIGIN_MISMATCH');
    r = await raw('POST', '/api/away', { headers: { ...json, 'x-maka-token': token, origin: 'null' } });
    assert.equal(r.status, 403);
    // a simple cross-origin POST (text/plain, no preflight) is not JSON
    r = await raw('POST', '/api/away', { headers: { 'content-type': 'text/plain', 'x-maka-token': token } });
    assert.equal(r.status, 415);
    r = await raw('POST', '/api/away', { headers: { 'x-maka-token': token } });
    assert.equal(r.status, 415, 'no content-type at all');
    r = await raw('POST', '/api/run', { headers: { 'content-type': 'multipart/form-data; boundary=x', 'x-maka-token': token }, body: '--x--' });
    assert.equal(r.status, 415);
    assert.equal(srv.away.state().away, false, 'still nothing changed');
    // the real thing: token + JSON, no Origin (a native client) or a matching Origin (the park page)
    r = await raw('POST', '/api/away', { headers: { ...json, 'x-maka-token': token } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(srv.away.state().away, true);
    r = await raw('POST', '/api/away', { headers: { ...json, 'x-maka-token': token, origin: `http://${host}` }, body: '{"away":false}' });
    assert.equal(r.status, 200);
    assert.equal(srv.away.state().away, false);
    // PUT and DELETE routes too
    const leashBefore = JSON.stringify(srv.leashState.get());
    r = await raw('PUT', '/api/leash', { headers: json, body: JSON.stringify({ ...srv.leashState.get(), domains: { ...srv.leashState.get().domains, money_out: { level: 'act_free' } } }) });
    assert.equal(r.status, 403);
    assert.equal(JSON.stringify(srv.leashState.get()), leashBefore, 'the leash is untouched');
    r = await raw('DELETE', '/api/mail/addresses/peak%40makapark.com', { headers: json, body: undefined });
    assert.equal(r.status, 403);
    r = await raw('POST', '/api/gate/gate-x', { headers: json, body: '{"decision":"approve"}' });
    assert.equal(r.status, 403);
    // reads need nothing; the helper (token + JSON) still works; the signed webhook is guarded by its signature, not the token
    assert.equal((await srv.get('/api/gate')).status, 200);
    assert.equal((await srv.post('/api/away', { away: false })).status, 200);
    const hook = await raw('POST', '/api/mail/resend/webhook', { headers: { ...json, 'svix-id': 'm1', 'svix-timestamp': '1', 'svix-signature': 'v1,nope' }, body: '{}' });
    assert.notEqual(hook.status, 403, `the webhook answers on its own terms: ${hook.status}`);
    assert.equal(hook.body.code, 'NO_SECRET', 'its own answer: no RESEND_WEBHOOK_SECRET in this test, so the signature cannot be checked');
    const page = await fetch(`${srv.url}/`);
    assert.equal(page.status, 200);
    assert.equal(typeof srv.token, 'string');
  } finally {
    await srv.close();
  }
});

// ---------- M5 / M6: the mail kind is derived, recipients are bounded, drafts are not history ----------

async function mailHarness() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-safety-mail-'));
  const store = createStore({ root: path.join(dir, 'home') });
  await store.init();
  const bus = createEventBus();
  const events = [];
  bus.listen((e) => events.push(e));
  const clock = fakeClock(1_700_000_000_000);
  const layout = defaultLayout();
  layout.rooms.push({ id: 'ops', name: 'Support', kind: 'operations_support', x: 31, y: 1, w: 8, h: 6 });
  layout.objects.push({ id: 'tower', kind: 'radio_tower', roomId: 'ops', x: 33, y: 2 });
  layout.agents.push({ id: 'ada', name: 'Ada', roomId: 'ops', x: 31, y: 1, role: 'ranger', venture: 'lantern-co', specialty: 'support' });
  const layoutState = createLayoutState({ initial: layout, store, bus, clock });
  const agents = createAgents({ layoutState, bus, clock });
  const ledger = await createLeashLedger({ store, clock }).init();
  const leashState = createLeashState({ initial: defaultLeash(), store });
  const gateQueue = await createGateQueue({ bus, store, ledger, leashState, getLayout: layoutState.get, clock }).init();
  const rs = await startFakeResend();
  const mail = await createMailSystem({ bus, store, getLayout: layoutState.get, env: { RESEND_API_KEY: rs.apiKey }, clock, workspaceRoot: path.join(dir, 'ws'), resendBaseUrl: rs.url, classify: false, log: { error() {} } }).init();
  const registry = { ...mail.tools };
  const gate = createToolGate({ getLayout: layoutState.get, agentId: 'ada', workspaceDir: path.join(dir, 'ws', 'ada'), registry, grants: allGrantsFor, toolContext: { agents, mail }, getLeash: () => leashState.get(), ledger, submit: { submit: (item) => gateQueue.submit({ ...item, runId: 'run-1', agentId: 'ada' }), log: (item) => gateQueue.log({ ...item, runId: 'run-1', agentId: 'ada' }) } });
  await fsp.mkdir(path.join(dir, 'ws', 'ada'), { recursive: true });
  const call = (id, name, input) => gate.execute({ id, name, input }, { runId: 'run-1' });
  return { dir, events, clock, leashState, gateQueue, rs, mail, gate, call, cleanup: async () => { await fsp.rm(dir, { recursive: true, force: true }); await rs.close(); } };
}

test('M5 the mail kind comes from the recipients and the thread, not from the sender\'s word: more than one recipient or no known thread is a campaign under publishing with the footer; the draft is loaded for the domain; recipients are bounded', async () => {
  const h = await mailHarness();
  try {
    const { policy } = h.mail;
    h.rs.receive({ id: 'r1', from: 'Buyer <buyer@example.com>', to: ['support@makapark.com'], subject: 'Broken lantern', text: 'broken', messageId: '<m1@example.com>' });
    await h.mail.poll();
    const inbound = h.mail.mailStore.byResendId('r1');
    // the policy's one function
    assert.equal(policy.kindOf({ to: ['new@example.com'] }), 'campaign', 'a first contact is not a "notification" because the sender says so');
    assert.equal(policy.kindOf({ to: ['new@example.com'], kind: 'notification' }), 'campaign');
    assert.equal(policy.kindOf({ to: ['a@example.com', 'b@example.com'], kind: 'notification' }), 'campaign', 'more than one recipient is a campaign');
    assert.equal(policy.kindOf({ to: ['a@example.com', 'b@example.com'], kind: 'reply', inReplyTo: '<m1@example.com>' }), 'campaign', 'a reply-all is a campaign');
    assert.equal(policy.kindOf({ to: ['buyer@example.com'], kind: 'notification', inReplyTo: '<nobody@example.com>' }), 'campaign', 'a reply to a message the park never saw is not a reply');
    assert.equal(policy.kindOf({ to: ['buyer@example.com'], inReplyTo: '<m1@example.com>' }), 'reply');
    assert.equal(policy.kindOf({ to: ['buyer@example.com'], threadId: inbound.threadId }), 'reply');
    assert.equal(policy.kindOf({ to: ['buyer@example.com'], threadId: 'thread-nope' }), 'campaign');
    assert.equal(policy.domainFor('campaign'), 'publishing');
    // the tool's domain uses the same function, with the draft loaded
    assert.equal(h.gate.leashFor('mail.send', { kind: 'notification', to: ['a@example.com', 'b@example.com'], subject: 'x', text: 'y' }).domain, 'publishing');
    assert.equal(h.gate.leashFor('mail.send', { kind: 'notification', to: ['new@example.com'], subject: 'x', text: 'y' }).domain, 'publishing');
    assert.equal(h.gate.leashFor('mail.send', { to: ['buyer@example.com'], inReplyTo: '<m1@example.com>', subject: 'x', text: 'y' }).domain, 'outbound_messages');
    const draft = JSON.parse((await h.call('d1', 'mail.draft', { to: ['one@example.com', 'two@example.com'], subject: 'News', text: 'Look!', kind: 'notification' })).output);
    assert.equal(draft.kind, 'campaign', 'the draft is stored with the derived kind');
    assert.equal(h.gate.leashFor('mail.send', { draftId: draft.draftId }).domain, 'publishing', 'the draft is loaded for the domain');
    const reply = JSON.parse((await h.call('d2', 'mail.draft', { to: ['buyer@example.com'], subject: 'Re: Broken lantern', text: 'Sorry', inReplyTo: '<m1@example.com>', kind: 'campaign' })).output);
    assert.equal(reply.kind, 'campaign', 'declaring a campaign only tightens');
    assert.equal(h.gate.leashFor('mail.send', { draftId: reply.draftId }).domain, 'publishing');
    const trueReply = JSON.parse((await h.call('d3', 'mail.draft', { to: ['buyer@example.com'], subject: 'Re: Broken lantern', text: 'Sorry', inReplyTo: '<m1@example.com>' })).output);
    assert.equal(trueReply.kind, 'reply');
    assert.equal(h.gate.leashFor('mail.send', { draftId: trueReply.draftId }).domain, 'outbound_messages');
    assert.equal(h.gate.leashFor('mail.send', { draftId: 'nope' }).domain, 'publishing', 'an unknown draft is judged as a campaign');
    // outbound_messages at Act freely, publishing at Draft: the "notification" to 5,000 addresses does not slip through
    await h.leashState.update((l) => ({ ...l, domains: { ...l.domains, outbound_messages: { level: 'act_free' } } }));
    const many = Array.from({ length: 51 }, (_, i) => `v${i}@example.com`);
    const refused = await h.call('s0', 'mail.send', { to: many, subject: 'Hello', text: 'x', kind: 'notification' });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /invalid input|maxItems|at most/);
    await assert.rejects(policy.validate({ from: 'support@makapark.com', to: many, subject: 'Hello' }, { by: 'ada' }), (e) => e.code === 'BAD_REQUEST' && /50/.test(e.message));
    const pending = h.call('s1', 'mail.send', { to: ['one@example.com', 'two@example.com'], subject: 'Hello', text: 'x', kind: 'notification' });
    const item = await waitUntil(() => h.gateQueue.pending()[0]);
    assert.equal(item.domain, 'publishing');
    await h.gateQueue.resolve(item.itemId, { decision: 'approve' });
    const sent = JSON.parse((await pending).output);
    assert.equal(sent.kind, 'campaign');
    assert.match(h.rs.state.emails.at(-1).text, /UNSUBSCRIBE/, 'the footer is on');
    assert.ok(h.rs.state.emails.at(-1).headers['List-Unsubscribe']);
    assert.equal((await h.mail.mailStore.get(sent.messageId)).kind, 'campaign');
    // a real reply at act_free goes out as outbound_messages, no footer
    const r = await h.call('s2', 'mail.send', { to: ['buyer@example.com'], subject: 'Re: Broken lantern', text: 'Sorry', inReplyTo: '<m1@example.com>', kind: 'notification' });
    assert.equal(r.ok, true, r.error);
    assert.equal(JSON.parse(r.output).kind, 'reply');
    assert.doesNotMatch(h.rs.state.emails.at(-1).text, /UNSUBSCRIBE/);
  } finally {
    await h.cleanup();
  }
});

test('M6 a draft is not mail history: drafting to a new address first does not make it known, and drafts do not count toward the hourly ceilings', async () => {
  const h = await mailHarness();
  try {
    const { policy } = h.mail;
    assert.equal(policy.isNewExternal('new@example.com'), true);
    const draft = JSON.parse((await h.call('d1', 'mail.draft', { to: ['new@example.com'], subject: 'Hi', text: 'x' })).output);
    assert.equal((await h.mail.mailStore.get(draft.draftId)).status, 'draft');
    assert.equal(policy.isNewExternal('new@example.com'), true, 'a draft to an address is not an exchange with it');
    assert.equal(policy.judgeAtDraft({ to: ['new@example.com'] }), true, 'the judge still sees a new external recipient');
    assert.equal(h.gate.tool('mail.send').judgeAtDraft({ draftId: draft.draftId }), true, 'with the draft loaded too');
    for (let i = 0; i < 40; i++) await h.call(`d${i + 2}`, 'mail.draft', { to: [`v${i}@example.com`], subject: 'Hi', text: 'x' });
    assert.deepEqual(policy.sentLastHour({ agentId: 'ada', station: 'ops' }), { agent: 0, station: 0, campaignRecipients: 0 }, 'drafts are not sends');
    assert.equal(policy.checkCeiling({ agentId: 'ada', station: 'ops', kind: 'campaign', recipients: 1 }).ok, true);
    // a real exchange makes the address known
    h.rs.receive({ id: 'r1', from: 'New <new@example.com>', to: ['support@makapark.com'], subject: 'Hello', text: 'hi', messageId: '<n1@example.com>' });
    await h.mail.poll();
    assert.equal(policy.isNewExternal('new@example.com'), false);
    assert.equal(h.gate.tool('mail.send').judgeAtDraft({ draftId: draft.draftId }), false);
  } finally {
    await h.cleanup();
  }
});

// ---------- L1: the handoff check runs before and after each action; a payment page needs notes ----------

function checkoutDriver() {
  const state = { clicked: [], typed: [] };
  const facts = (p) => {
    if (p.url.startsWith('http://shop.test/checkout')) return { url: p.url, title: 'Checkout', payment: true, text: 'Card number CVC Expiry Place order' };
    if (p.url === 'http://shop.test/login') return { url: p.url, title: 'Sign in', password: true, text: 'Email Password Sign in' };
    return { url: p.url, title: p.title, text: 'Paper lanterns' };
  };
  return {
    state,
    find: async () => '/fake/chromium',
    launch: async () => ({ wsUrl: 'ws://fake', pid: 1, kill() {} }),
    connect: async () => ({ close() {}, closed: new Promise(() => {}) }),
    openPage: async () => {
      const p = { url: 'about:blank', title: '' };
      return {
        url: () => p.url,
        async navigate(u) { p.url = u; p.title = 'page'; return { url: u, title: p.title }; },
        async summary() { return { url: p.url, title: p.title }; },
        async facts() { return facts(p); },
        async text() { return `text of ${p.url}`; },
        // the page drifts to a confirmation step on its own (a timer, a script) while the Ranger reads its tree: no action of the Ranger's was checked after it
        async tree() { if (p.url === 'http://shop.test/checkout') p.url = 'http://shop.test/checkout/confirm'; return []; },
        async click(t) { state.clicked.push(t.text); if (t.text === 'Place order') p.url = 'http://shop.test/thanks'; return { tag: 'button', text: t.text }; },
        async type(t, value) { state.typed.push(value); return { tag: 'input', text: '' }; },
        async upload() { return {}; },
        async download() { return { path: '', bytes: 0, url: '' }; },
        async screenshot() { return Buffer.from('\x89PNG fake'); },
        async bringToFront() {},
        async close() {},
      };
    },
  };
}

test('L1 a payment page is checked before the next action too, and its handoff is returned only with notes; a login page keeps the one-handoff rule', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-safety-l1-'));
  const bus = createEventBus();
  const handoffs = [];
  bus.listen((e) => { if (e.type === 'browser.handoff') handoffs.push(e.payload); });
  const driver = checkoutDriver();
  const browser = await createBrowserControl({ bus, workspaceRoot: dir, env: {}, config: { headless: true }, driver, netGuard: createNetGuard({ allowLocal: true }), log: { error() {} } }).init();
  const ctx = { browser, agentId: 'ranger', runId: 'run-1', workspaceDir: path.join(dir, 'ranger'), netGuard: createNetGuard({ allowLocal: true }) };
  await fsp.mkdir(ctx.workspaceDir, { recursive: true });
  const tools = BROWSER_TOOLS;
  try {
    // open the checkout: the page asks for card details → a payment handoff
    const opening = tools['browser.open'].run({ url: 'http://shop.test/checkout' }, ctx);
    const h1 = await waitUntil(() => handoffs.find((h) => h.status === 'waiting'));
    assert.equal(h1.kind, 'payment');
    assert.match(h1.reason, /notes/i, 'the card says notes are needed to hand a payment page back');
    assert.throws(() => browser.returnHandoff(h1.handoffId, { notes: '' }), (e) => e.code === 'NOTES_REQUIRED', 'a payment page is not handed back without a word');
    assert.throws(() => browser.returnHandoff(h1.handoffId, { notes: '   ' }), (e) => e.code === 'NOTES_REQUIRED');
    browser.returnHandoff(h1.handoffId, { notes: 'card entered; do not place the order yet' });
    const opened = JSON.parse((await opening).output.split('\n')[0]);
    assert.equal(opened.handoff.status, 'returned');
    assert.equal(opened.handoff.notes, 'card entered; do not place the order yet');
    // the page drifts to a confirmation step during a read (no handoff check after a read)
    const read = await tools['browser.read'].run({ what: 'tree' }, ctx);
    assert.equal(read.ok, true);
    assert.equal((await browser.forAgent('ranger')).page.url(), 'http://shop.test/checkout/confirm');
    // the next click is checked BEFORE it runs: a payment page the Superintendent never saw parks the click
    const clicking = tools['browser.click'].run({ text: 'Place order' }, ctx);
    const h2 = await waitUntil(() => handoffs.filter((h) => h.status === 'waiting').length === 2 ? handoffs.filter((h) => h.status === 'waiting')[1] : null);
    assert.equal(h2.kind, 'payment');
    assert.equal(h2.url, 'http://shop.test/checkout/confirm');
    assert.deepEqual(driver.state.clicked, [], 'the click has not happened');
    assert.throws(() => browser.returnHandoff(h2.handoffId, { notes: '' }), (e) => e.code === 'NOTES_REQUIRED');
    browser.returnHandoff(h2.handoffId, { notes: 'checked the total; place the order' });
    const clicked = await clicking;
    assert.equal(clicked.ok, true, clicked.error);
    assert.deepEqual(driver.state.clicked, ['Place order']);
    assert.equal(JSON.parse(clicked.output.split('\n')[0]).url, 'http://shop.test/thanks');
    assert.equal(handoffs.filter((h) => h.status === 'waiting').length, 2, 'the thank-you page raises nothing');
    // a login page: handed back without notes, and the same page is not re-raised for the next keystrokes
    const login = tools['browser.open'].run({ url: 'http://shop.test/login' }, ctx);
    const h3 = await waitUntil(() => handoffs.filter((h) => h.status === 'waiting')[2] || null);
    assert.equal(h3.kind, 'login');
    browser.returnHandoff(h3.handoffId, { notes: '' });
    assert.equal((await login).ok, true);
    const typed = await tools['browser.type'].run({ text: 'Email', value: 'ranger@makapark.com' }, ctx);
    assert.equal(typed.ok, true, typed.error);
    assert.deepEqual(driver.state.typed, ['ranger@makapark.com']);
    assert.equal(handoffs.filter((h) => h.status === 'waiting').length, 3, 'the handed-back login page is not raised again');
    assert.match(typed.output, /already handed back/);
  } finally {
    await browser.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
