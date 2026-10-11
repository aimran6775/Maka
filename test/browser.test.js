import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { promises as fsp } from 'node:fs';
import { createStore } from '../sidecar/store.js';
import { createEventBus } from '../sidecar/bus.js';
import { createLayoutState } from '../sidecar/server.js';
import { createAgents } from '../sidecar/agents.js';
import { createLeashLedger, createLeashState } from '../sidecar/leash-ledger.js';
import { createGateQueue } from '../sidecar/gate-queue.js';
import { createToolGate } from '../sidecar/capability/gate.js';
import { detectHandoff, HANDOFF_KINDS } from '../sidecar/browser/detect.js';
import { findChromium, launchChromium, chromiumArgs, connectCdp, openPage, CHROMIUM_CANDIDATES } from '../sidecar/browser/cdp.js';
import { createBrowserControl, TRACE_DIR, TRACE_FILE, PROFILE_DIR } from '../sidecar/browser/control.js';
import { BROWSER_TOOLS } from '../sidecar/browser/tools.js';
import { OBJECT_KINDS, defaultLayout, allGrantsFor } from '../shared/world.js';
import { defaultLeash, TOOL_DOMAINS } from '../shared/leash.js';
import { startFakeCdp } from './helpers/fake-cdp.js';
import { createNetGuard } from '../sidecar/netguard.js';
import { startTestServer } from './helpers/test-server.js';
import { fakeProvider, fakeClock, text, toolCall, end, waitUntil } from './helpers/fake-provider.js';

const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures');

// ---------- heuristics ----------

test('detectHandoff: captcha, 2FA, payment and login pages, in that priority; plain pages pass', () => {
  assert.deepEqual([...HANDOFF_KINDS], ['login', 'two_factor', 'captcha', 'payment']);
  assert.equal(detectHandoff({ url: 'https://shop.example/', title: 'Shop', text: 'Paper lanterns for every trail' }), null);
  assert.equal(detectHandoff(null), null);
  assert.equal(detectHandoff({ url: 'https://shop.example/login', title: 'Sign in', password: true, text: 'Email Password Sign in' }).kind, 'login');
  assert.equal(detectHandoff({ url: 'https://shop.example/account/login', title: 'Sign in', text: 'Please log in to continue' }).kind, 'login', 'a sign-in URL with sign-in text, no field yet');
  assert.equal(detectHandoff({ url: 'https://shop.example/account/login', title: 'Help', text: 'Lantern care tips' }), null, 'a sign-in URL alone is not enough');
  assert.equal(detectHandoff({ url: 'https://x', text: 'Enter the verification code we sent to your phone' }).kind, 'two_factor');
  assert.equal(detectHandoff({ url: 'https://x', otp: true, password: true, text: '' }).kind, 'two_factor', 'an OTP field wins over a password field');
  assert.equal(detectHandoff({ url: 'https://x', text: 'Please prove you are human', password: true }).kind, 'captcha', 'a captcha blocks everything else');
  assert.equal(detectHandoff({ url: 'https://x', captcha: true, payment: true }).kind, 'captcha');
  assert.equal(detectHandoff({ url: 'https://x', payment: true, text: '' }).kind, 'payment');
  assert.equal(detectHandoff({ url: 'https://x/checkout', text: 'Card number CVC Expiry Place order' }).kind, 'payment');
  assert.equal(detectHandoff({ url: 'https://x/checkout', text: 'Card number CVC', password: true }).kind, 'login', 'a password field on a checkout text page is a login first');
});

// ---------- launcher ----------

function fakeChild({ announce = true, exitCode = null, delay = 5 } = {}) {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stderr = new EventEmitter();
  child.stdout = new EventEmitter();
  child.killed = [];
  child.kill = (sig) => child.killed.push(sig);
  setTimeout(() => {
    if (announce) child.stderr.emit('data', Buffer.from('\nDevTools listening on ws://127.0.0.1:9333/devtools/browser/abc\n'));
    if (exitCode !== null) child.emit('exit', exitCode, null);
  }, delay);
  return child;
}

test('launchChromium parses the DevTools endpoint from a spawned Chromium, fails plainly on an early exit, a timeout or a missing binary', async () => {
  const spawned = [];
  const spawn = (bin, args, opts) => {
    spawned.push({ bin, args, opts });
    return fakeChild();
  };
  const proc = await launchChromium({ bin: '/fake/chromium', profileDir: '/tmp/p', headless: true, spawn });
  assert.equal(proc.wsUrl, 'ws://127.0.0.1:9333/devtools/browser/abc');
  assert.equal(proc.pid, 4242);
  assert.ok(spawned[0].args.includes('--headless=new') && spawned[0].args.includes('--user-data-dir=/tmp/p') && spawned[0].args.includes('--remote-debugging-port=0'));
  assert.ok(!chromiumArgs({ profileDir: '/p', headless: false }).includes('--headless=new'), 'a windowed browser for handoffs');
  assert.ok(!chromiumArgs({ profileDir: '/p', headless: true, noSandbox: false }).includes('--no-sandbox'), 'the sandbox stays on for a normal user');
  assert.ok(chromiumArgs({ profileDir: '/p', headless: true, noSandbox: true }).includes('--no-sandbox'));
  proc.kill();
  await assert.rejects(launchChromium({ bin: '/fake/chromium', profileDir: '/tmp/p', spawn: () => fakeChild({ announce: false, exitCode: 1 }) }), (e) => e.code === 'LAUNCH_FAILED' && /exited with 1/.test(e.message));
  await assert.rejects(launchChromium({ bin: '/fake/chromium', profileDir: '/tmp/p', spawn: () => fakeChild({ announce: false }), timeoutMs: 30 }), (e) => e.code === 'LAUNCH_TIMEOUT');
  await assert.rejects(launchChromium({ bin: null, profileDir: '/tmp/p', spawn }), (e) => e.code === 'NO_CHROMIUM');
  await assert.rejects(launchChromium({ bin: '/fake/chromium', profileDir: '/tmp/p', spawn: () => { throw new Error('ENOENT'); } }), (e) => e.code === 'LAUNCH_FAILED');
});

test('findChromium: configured path, then $CHROMIUM, then known locations; directories are searched; nothing found is null', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-chromium-'));
  try {
    await fsp.mkdir(path.join(dir, 'chromium-1', 'chrome-linux'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'chromium-1', 'chrome-linux', 'chrome'), '#!/bin/sh\n');
    assert.equal(await findChromium({ env: {}, configured: dir }), path.join(dir, 'chromium-1', 'chrome-linux', 'chrome'));
    assert.equal(await findChromium({ env: { CHROMIUM: path.join(dir, 'chromium-1') }, configured: null }), path.join(dir, 'chromium-1', 'chrome-linux', 'chrome'));
    const missing = { stat: async () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; }, readdir: async () => [] };
    assert.equal(await findChromium({ env: {}, configured: '/nowhere', fs: missing }), null);
    assert.ok(CHROMIUM_CANDIDATES.length >= 5);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ---------- CDP client over the fake endpoint ----------

test('connectCdp: replies by id, protocol errors are coded, events reach once() with session routing, a dropped socket rejects what is pending', async () => {
  const cdp = await startFakeCdp({ handlers: {
    'Browser.getVersion': () => ({ product: 'FakeChrome/0' }),
    'Target.attachToTarget': (p) => ({ sessionId: `s-${p.targetId}` }),
    'Page.navigate': (p, sid, { emit }) => { setTimeout(() => emit('Page.loadEventFired', { timestamp: 1 }, sid), 5); return { frameId: 'f1' }; },
    'Slow.call': () => undefined,
  } });
  try {
    const client = await connectCdp(cdp.wsUrl);
    assert.equal(client.open, true);
    assert.deepEqual(await client.send('Browser.getVersion'), { product: 'FakeChrome/0' });
    assert.deepEqual(await client.send('Target.attachToTarget', { targetId: 't1' }), { sessionId: 's-t1' });
    assert.equal(cdp.calls.at(-1).params.targetId, 't1');
    await assert.rejects(client.send('Nope.method'), (e) => e.code === 'CDP_ERROR' && /wasn't found/.test(e.message));
    const load = client.once((m, p, sid) => m === 'Page.loadEventFired' && sid === 's-t1', { label: 'load' });
    await client.send('Page.navigate', { url: 'http://x' }, 's-t1');
    assert.equal((await load).timestamp, 1);
    assert.equal(cdp.calls.at(-1).sessionId, 's-t1', 'flat sessions carry the sessionId');
    await assert.rejects(client.once(() => false, { timeoutMs: 20, label: 'nothing' }), (e) => e.code === 'CDP_TIMEOUT');
    const pending = client.send('Slow.call');
    cdp.dropAll();
    await assert.rejects(pending, (e) => e.code === 'CDP_CLOSED');
    await client.closed;
    assert.equal(client.open, false);
    await assert.rejects(client.send('Browser.getVersion'), (e) => e.code === 'CDP_CLOSED');
  } finally {
    await cdp.close();
  }
  await assert.rejects(connectCdp('ws://127.0.0.1:1/nothing', { timeoutMs: 500 }), (e) => e.code === 'CDP_CONNECT');
  await assert.rejects(connectCdp('ws://x', { WebSocket: null }), (e) => e.code === 'NO_WEBSOCKET');
});

test('openPage speaks the protocol: target + session, navigate waits for the load, locate/click/type/upload/download/screenshot send the expected methods', async () => {
  const state = { url: 'about:blank', title: '' };
  let evalResults = [];
  const cdp = await startFakeCdp({ handlers: {
    'Target.createTarget': () => ({ targetId: 't1' }),
    'Target.attachToTarget': () => ({ sessionId: 's1' }),
    'Target.closeTarget': () => ({ success: true }),
    'Page.enable': () => ({}), 'Runtime.enable': () => ({}), 'DOM.enable': () => ({}),
    'Page.navigate': (p, sid, { emit }) => { state.url = p.url; state.title = 'Loaded'; if (p.url.includes('bad')) return { frameId: 'f', errorText: 'net::ERR_NAME_NOT_RESOLVED' }; setTimeout(() => emit('Page.loadEventFired', {}, sid), 5); return { frameId: 'f' }; },
    'Runtime.evaluate': (p) => {
      if (p.expression === 'location.href') return { result: { value: state.url } };
      if (p.expression.startsWith('({ url: location.href')) return { result: { value: { url: state.url, title: state.title } } };
      if (p.expression.includes('innerText) || ""')) return { result: { value: 'Hello page' } };
      if (p.expression.includes('throw')) return { exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: boom' } } };
      if (evalResults.length) return { result: { value: evalResults.shift() } };
      return { result: { value: null } };
    },
    'Accessibility.getFullAXTree': () => ({ nodes: [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Shop' }, childIds: ['2', '3', '5'] },
      { nodeId: '2', parentId: '1', role: { value: 'heading' }, name: { value: 'Maka' }, childIds: [] },
      { nodeId: '3', parentId: '1', role: { value: 'generic' }, childIds: ['4'] },
      { nodeId: '4', parentId: '3', role: { value: 'link' }, name: { value: 'About' }, childIds: [] },
      { nodeId: '5', parentId: '1', role: { value: 'textbox' }, name: { value: 'Search' }, value: { value: 'lan' }, childIds: [] },
    ] }),
    'Input.dispatchMouseEvent': () => ({}), 'Input.insertText': () => ({}), 'Input.dispatchKeyEvent': () => ({}),
    'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
    'DOM.querySelector': (p) => ({ nodeId: p.selector === '#file' ? 7 : 0 }),
    'DOM.setFileInputFiles': () => ({}),
    'Browser.setDownloadBehavior': () => ({}),
    'Page.captureScreenshot': () => ({ data: Buffer.from('PNGDATA').toString('base64') }),
    'Page.bringToFront': () => ({}),
  } });
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-dl-'));
  try {
    const client = await connectCdp(cdp.wsUrl);
    const page = await openPage(client);
    assert.equal(page.sessionId, 's1');
    const methods = () => cdp.calls.map((c) => c.method);
    assert.deepEqual(methods().slice(0, 5), ['Target.createTarget', 'Target.attachToTarget', 'Page.enable', 'Runtime.enable', 'DOM.enable']);
    assert.deepEqual(await page.navigate('http://shop.test/'), { url: 'http://shop.test/', title: 'Loaded' });
    assert.equal(page.url(), 'http://shop.test/');
    await assert.rejects(page.navigate('http://bad.test/'), (e) => e.code === 'NAVIGATE_FAILED');
    assert.equal(await page.text(), 'Hello page');
    assert.deepEqual(await page.tree(), ['RootWebArea "Shop"', '  heading "Maka"', '  link "About"', '  textbox "Search" = lan'], 'generic wrappers are flattened out');
    await assert.rejects(page.evaluate('throw 1'), (e) => e.code === 'PAGE_SCRIPT');
    // click: locate (evaluate) then three mouse events at the centre
    evalResults = [{ x: 10, y: 20, tag: 'button', text: 'Go', editable: false }];
    const before = cdp.calls.length;
    const clicked = await page.click({ text: 'Go' });
    assert.equal(clicked.tag, 'button');
    const mouse = cdp.calls.slice(before).filter((c) => c.method === 'Input.dispatchMouseEvent').map((c) => c.params.type);
    assert.deepEqual(mouse, ['mouseMoved', 'mousePressed', 'mouseReleased']);
    assert.ok(cdp.calls.slice(before).every((c) => c.sessionId === 's1'));
    evalResults = [null];
    await assert.rejects(page.click({ selector: '#nope' }), (e) => e.code === 'NOT_FOUND');
    // type: locate, click, focus/select, insertText, Enter on submit
    evalResults = [{ x: 1, y: 2, tag: 'input', text: '', editable: true }, true];
    const b2 = cdp.calls.length;
    await page.type({ selector: '#q' }, 'lantern', { submit: true });
    const typed = cdp.calls.slice(b2).map((c) => c.method);
    assert.ok(typed.includes('Input.insertText') && typed.filter((m) => m === 'Input.dispatchKeyEvent').length === 2);
    assert.equal(cdp.calls.slice(b2).find((c) => c.method === 'Input.insertText').params.text, 'lantern');
    evalResults = [{ x: 1, y: 2, tag: 'div', text: 'x', editable: false }];
    await assert.rejects(page.type({ selector: 'div' }, 'x'), (e) => e.code === 'NOT_EDITABLE');
    // upload
    assert.deepEqual(await page.upload('#file', ['/tmp/a.txt']), { count: 1 });
    assert.deepEqual(cdp.calls.at(-1).params, { nodeId: 7, files: ['/tmp/a.txt'] });
    await assert.rejects(page.upload('#missing', ['/tmp/a.txt']), (e) => e.code === 'NOT_FOUND');
    // download: allowAndName, then the begin/progress events, then the rename
    await fsp.writeFile(path.join(dir, 'guid-1'), 'a,b\n1,2\n');
    const dl = page.download({ url: 'http://shop.test/report.csv' }, dir, { timeoutMs: 2000 });
    await waitUntil(() => cdp.calls.some((c) => c.method === 'Page.navigate' && c.params.url.endsWith('report.csv')));
    cdp.emit('Browser.downloadWillBegin', { guid: 'guid-1', suggestedFilename: 'report.csv', url: 'http://shop.test/report.csv' });
    cdp.emit('Browser.downloadProgress', { guid: 'guid-1', state: 'completed' });
    const got = await dl;
    assert.equal(got.path, path.join(dir, 'report.csv'));
    assert.equal(got.bytes, 8);
    assert.equal(cdp.calls.find((c) => c.method === 'Browser.setDownloadBehavior').params.behavior, 'allowAndName');
    // screenshot
    assert.equal((await page.screenshot()).toString(), 'PNGDATA');
    await page.close();
    assert.equal(cdp.calls.at(-1).method, 'Target.closeTarget');
    client.close();
  } finally {
    await cdp.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ---------- control + tools with a fake driver ----------

function fakeDriver({ pages = {} } = {}) {
  const state = { launched: [], killed: 0, pagesOpened: 0 };
  const titles = { 'http://shop.test/': 'Maka test shop', 'http://shop.test/login': 'Sign in', 'http://shop.test/account': 'Your account' };
  const driver = {
    state,
    find: async () => '/fake/chromium',
    launch: async (opts) => { state.launched.push(opts); return { wsUrl: 'ws://fake', pid: 1, kill() { state.killed += 1; } }; },
    connect: async () => ({ close() {}, closed: new Promise(() => {}) }),
    openPage: async () => {
      state.pagesOpened += 1;
      const p = { url: 'about:blank', title: '', typed: [], clicked: [], closed: false };
      const page = {
        url: () => p.url,
        async navigate(u) { if (u.includes('broken')) { const e = new Error(`${u}: net::ERR_CONNECTION_REFUSED`); e.code = 'NAVIGATE_FAILED'; throw e; } p.url = u; p.title = titles[u] || 'page'; return { url: u, title: p.title }; },
        async summary() { return { url: p.url, title: p.title }; },
        async facts() { return pages.facts ? pages.facts(p) : { url: p.url, title: p.title, password: p.url.endsWith('/login'), text: p.url.endsWith('/login') ? 'Email Password Sign in' : 'Paper lanterns' }; },
        async text(limit = 100) { return `text of ${p.url}`.slice(0, limit); },
        async tree() { return ['RootWebArea "x"', '  link "About"']; },
        async click(t) { p.clicked.push(t); if (t.text === 'Sign in') { p.url = 'http://shop.test/login'; p.title = 'Sign in'; } return { tag: 'a', text: t.text || t.selector }; },
        async type(t, value, opts) { p.typed.push({ t, value, opts }); return { tag: 'input', text: '' }; },
        async upload(sel, files) { p.uploaded = files; return { count: files.length }; },
        async download(input, dir) { const f = path.join(dir, 'report.csv'); await fsp.writeFile(f, 'a,b\n'); return { path: f, bytes: 4, url: input.url || 'http://shop.test/report.csv' }; },
        async screenshot() { return Buffer.from('\x89PNG fake'); },
        async bringToFront() { p.front = (p.front || 0) + 1; },
        async close() { p.closed = true; },
        _p: p,
      };
      state.lastPage = page;
      return page;
    },
  };
  return driver;
}

async function harness({ driver = fakeDriver(), leashLevel = 'act_free' } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-browser-'));
  const store = createStore({ root: path.join(dir, 'home') });
  await store.init();
  const bus = createEventBus();
  const events = [];
  bus.listen((e) => events.push(e));
  const clock = fakeClock(1_700_000_000_000);
  const layout = defaultLayout();
  layout.objects.push({ id: 'office', kind: 'field_office', roomId: 'ranger-station', x: 2, y: 2 });
  const layoutState = createLayoutState({ initial: layout, store, bus, clock });
  const agents = createAgents({ layoutState, bus, clock });
  const ledger = await createLeashLedger({ store, clock }).init();
  const leash = defaultLeash();
  leash.domains.browser_control = { level: leashLevel };
  const leashState = createLeashState({ initial: leash, store });
  const gateQueue = await createGateQueue({ bus, store, ledger, leashState, getLayout: layoutState.get, clock }).init();
  const workspaceRoot = path.join(dir, 'ws');
  await fsp.mkdir(path.join(workspaceRoot, 'ranger'), { recursive: true });
  // The fakes live on made-up hosts and loopback: the outbound guard (test/safety.test.js) is off here.
  const netGuard = createNetGuard({ allowLocal: true });
  const browser = await createBrowserControl({ bus, workspaceRoot, env: {}, config: { headless: true }, clock, driver, netGuard, log: { error() {} } }).init();
  const registry = { ...browser.tools };
  const gateFor = (agentId, { runId = 'run-1', signal } = {}) => ({
    gate: createToolGate({ getLayout: layoutState.get, agentId, workspaceDir: path.join(workspaceRoot, agentId), registry, grants: allGrantsFor, toolContext: { agents, browser, netGuard }, getLeash: () => leashState.get(), ledger, submit: { submit: (item) => gateQueue.submit({ ...item, runId, agentId }), log: (item) => gateQueue.log({ ...item, runId, agentId }) } }),
    ctx: { runId, signal },
  });
  return { dir, bus, events, clock, layoutState, leashState, gateQueue, ledger, workspaceRoot, browser, driver, gateFor, cleanup: async () => { await browser.close(); await fsp.rm(dir, { recursive: true, force: true }); } };
}

test('the Field office grants the seven browser tools, all under browser_control; at Draft every action waits at the Gate', async () => {
  // Phase 4 step 17: the Field office also grants the two purchase tools (money_out / none).
  assert.deepEqual(OBJECT_KINDS.field_office.grants, [...Object.keys(BROWSER_TOOLS), 'purchase.request', 'purchase.receipt']);
  for (const name of Object.keys(BROWSER_TOOLS)) assert.equal(TOOL_DOMAINS[name], 'browser_control', name);
  assert.equal(TOOL_DOMAINS['purchase.request'], 'money_out');
  assert.equal(TOOL_DOMAINS['purchase.receipt'], null);
  const h = await harness({ leashLevel: 'draft' });
  try {
    const { gate, ctx } = h.gateFor('ranger');
    assert.deepEqual(gate.definitions().map((d) => d.name), ['browser.click', 'browser.download', 'browser.open', 'browser.read', 'browser.screenshot', 'browser.type', 'browser.upload']);
    assert.equal(gate.leashFor('browser.read').domain, 'browser_control');
    const pending = gate.execute({ id: 'c1', name: 'browser.open', input: { url: 'http://shop.test/' } }, ctx);
    const item = await waitUntil(() => h.gateQueue.pending()[0]);
    assert.equal(item.domain, 'browser_control');
    assert.equal(item.summary, 'open http://shop.test/ in the browser');
    await h.gateQueue.resolve(item.itemId, { decision: 'reject', notes: 'not that site' });
    const r = await pending;
    assert.equal(r.code, 'GATE_REJECT');
    assert.equal(h.driver.state.launched.length, 0, 'nothing launched for a rejected action');
    const notGranted = h.gateFor('ranger');
    await h.layoutState.replace({ ...h.layoutState.get(), objects: [] });
    assert.match((await notGranted.gate.execute({ id: 'c2', name: 'browser.read', input: {} }, ctx)).error, /not granted/);
  } finally {
    await h.cleanup();
  }
});

test('open/read/click/type/upload/download/screenshot through the tools: one profile per Ranger, a trace line with a screenshot per action, the sandbox on uploads', async () => {
  const h = await harness();
  try {
    const { gate, ctx } = h.gateFor('ranger');
    assert.match((await gate.execute({ id: 'c0', name: 'browser.open', input: { url: 'ftp://x' } }, ctx)).error, /http\(s\) URL/);
    const open = await gate.execute({ id: 'c1', name: 'browser.open', input: { url: 'http://shop.test/' } }, ctx);
    assert.equal(open.ok, true, open.error);
    const o = JSON.parse(open.output);
    assert.equal(o.title, 'Maka test shop');
    assert.equal(o.url, 'http://shop.test/');
    assert.match(o.text, /text of http:\/\/shop.test/);
    assert.equal(o.handoff, null);
    assert.ok(o.screenshot && o.screenshot.includes(path.join('ranger', TRACE_DIR)) && o.screenshot.endsWith('-open.png'));
    assert.equal(h.driver.state.launched.length, 1);
    assert.equal(h.driver.state.launched[0].profileDir, path.join(h.workspaceRoot, 'ranger', PROFILE_DIR));
    assert.equal(h.driver.state.launched[0].headless, true);
    const read = JSON.parse((await gate.execute({ id: 'c2', name: 'browser.read', input: { what: 'both' } }, ctx)).output);
    assert.match(read.text, /text of/);
    assert.match(read.tree, /link "About"/);
    assert.equal(h.driver.state.launched.length, 1, 'the same browser serves the next action');
    const click = JSON.parse((await gate.execute({ id: 'c3', name: 'browser.click', input: { text: 'About' } }, ctx)).output);
    assert.equal(click.clicked.text, 'About');
    assert.match((await gate.execute({ id: 'c3b', name: 'browser.click', input: {} }, ctx)).error, /selector or the visible text/);
    const typed = JSON.parse((await gate.execute({ id: 'c4', name: 'browser.type', input: { text: 'Search products', value: 'lantern', submit: true } }, ctx)).output);
    assert.equal(typed.typed.tag, 'input');
    assert.deepEqual(h.driver.state.lastPage._p.typed[0], { t: { text: 'Search products', value: 'lantern', submit: true }, value: 'lantern', opts: { submit: true, clear: true } });
    // upload: inside the workspace only
    await fsp.writeFile(path.join(h.workspaceRoot, 'ranger', 'photo.txt'), 'img');
    const up = JSON.parse((await gate.execute({ id: 'c5', name: 'browser.upload', input: { selector: '#file', paths: ['photo.txt'] } }, ctx)).output);
    assert.equal(up.count, 1);
    assert.deepEqual(h.driver.state.lastPage._p.uploaded, [path.join(h.workspaceRoot, 'ranger', 'photo.txt')]);
    const outside = await gate.execute({ id: 'c6', name: 'browser.upload', input: { selector: '#file', paths: ['../../home/keystore.json'] } }, ctx);
    assert.equal(outside.code, 'SANDBOX');
    assert.equal((await gate.execute({ id: 'c7', name: 'browser.upload', input: { selector: '#file', paths: ['missing.txt'] } }, ctx)).code, 'NOT_FOUND');
    const dl = JSON.parse((await gate.execute({ id: 'c8', name: 'browser.download', input: { url: 'http://shop.test/report.csv' } }, ctx)).output);
    assert.equal(dl.path, path.join('downloads', 'report.csv'));
    assert.equal(await fsp.readFile(path.join(h.workspaceRoot, 'ranger', 'downloads', 'report.csv'), 'utf8'), 'a,b\n');
    const shot = JSON.parse((await gate.execute({ id: 'c9', name: 'browser.screenshot', input: {} }, ctx)).output);
    assert.ok(shot.screenshot.endsWith('-screenshot.png'));
    assert.equal((await fsp.readFile(shot.screenshot)).toString(), '\x89PNG fake');
    const failed = await gate.execute({ id: 'c10', name: 'browser.open', input: { url: 'http://broken.test/' } }, ctx);
    assert.equal(failed.code, 'NAVIGATE_FAILED');
    // the trace: one line per action, newest first through the API
    const trace = await h.browser.trace('ranger');
    assert.deepEqual(trace.map((t) => t.action), ['open', 'screenshot', 'download', 'upload', 'type', 'click', 'read', 'open']);
    assert.equal(trace[0].ok, false);
    assert.equal(trace[0].code, 'NAVIGATE_FAILED');
    assert.equal(trace.at(-1).url, 'http://shop.test/');
    assert.equal(trace.at(-1).runId, 'run-1');
    assert.ok(trace.every((t) => t.screenshot && t.ts && t.agentId === 'ranger'));
    const raw = await fsp.readFile(path.join(h.workspaceRoot, 'ranger', TRACE_DIR, TRACE_FILE), 'utf8');
    assert.equal(raw.trim().split('\n').length, 8);
    assert.equal((await h.browser.trace('nobody')).length, 0);
    assert.equal(h.ledger.summary().domains.browser_control.actions, 7, 'seven actions in the ledger: the failed open is not an executed action');
    const st = await h.browser.status();
    assert.equal(st.wired, true);
    assert.deepEqual(st.sessions.map((s) => s.agentId), ['ranger']);
    assert.equal(st.pending.length, 0);
    assert.equal(await h.browser.closeAgent('ranger'), true);
    assert.equal(h.driver.state.killed, 1);
    assert.equal(h.driver.state.lastPage._p.closed, true);
    assert.equal(await h.browser.closeAgent('ranger'), false);
  } finally {
    await h.cleanup();
  }
});

test('BROWSER HANDOFF: a login page parks the action, emits browser.handoff waiting, the return route resumes it; a cancelled run abandons it; a handed-back page is not re-raised; read never raises', async () => {
  const h = await harness();
  try {
    const { gate, ctx } = h.gateFor('ranger');
    const pending = gate.execute({ id: 'c1', name: 'browser.open', input: { url: 'http://shop.test/login' } }, ctx);
    const ev = await waitUntil(() => h.events.find((e) => e.type === 'browser.handoff'));
    assert.equal(ev.payload.status, 'waiting');
    assert.equal(ev.payload.kind, 'login');
    assert.equal(ev.payload.agentId, 'ranger');
    assert.equal(ev.payload.runId, 'run-1');
    assert.equal(ev.payload.url, 'http://shop.test/login');
    assert.equal(ev.payload.headless, true);
    assert.match(ev.payload.reason, /password/);
    assert.equal(h.driver.state.lastPage._p.front, 1, 'the window came to the front');
    assert.equal(h.browser.handoffs({ pendingOnly: true }).length, 1);
    assert.equal((await h.browser.status()).pending[0].handoffId, ev.payload.handoffId);
    assert.throws(() => h.browser.returnHandoff('hand-nope'), (e) => e.code === 'NOT_FOUND');
    const returned = h.browser.returnHandoff(ev.payload.handoffId, { notes: 'signed in for you' });
    assert.equal(returned.status, 'returned');
    assert.throws(() => h.browser.returnHandoff(ev.payload.handoffId), (e) => e.code === 'NOT_WAITING');
    const r = await pending;
    assert.equal(r.ok, true);
    const out = JSON.parse(r.output.split('\n')[0]);
    assert.deepEqual(out.handoff, { id: ev.payload.handoffId, kind: 'login', status: 'returned', notes: 'signed in for you' });
    assert.match(r.output, /BROWSER HANDOFF login: the Superintendent completed the step and handed the page back: signed in for you/);
    const done = h.events.filter((e) => e.type === 'browser.handoff');
    assert.equal(done.length, 2);
    assert.equal(done[1].payload.status, 'returned');
    assert.equal(done[1].payload.notes, 'signed in for you');
    // Still on the login page (the human left it): the next action does not re-raise.
    const again = JSON.parse((await gate.execute({ id: 'c2', name: 'browser.click', input: { text: 'Sign in' } }, ctx)).output.split('\n')[0]);
    assert.equal(again.handoff.status, 'returned');
    assert.equal(h.events.filter((e) => e.type === 'browser.handoff').length, 2, 'no third event');
    const trace = await h.browser.trace('ranger');
    assert.deepEqual(trace.map((t) => t.action), ['click', 'handoff', 'open']);
    assert.equal(trace[1].status, 'returned');
    // read never checks for a handoff
    await h.driver.state.lastPage.navigate('http://shop.test/login');
    const read = await gate.execute({ id: 'c3', name: 'browser.read', input: { what: 'text' } }, ctx);
    assert.equal(JSON.parse(read.output).handoff, null);
    // a new run on a fresh page: the run is cancelled while the handoff waits -> abandoned
    await h.browser.closeAgent('ranger');
    const ac = new AbortController();
    const g2 = h.gateFor('ranger', { runId: 'run-2', signal: ac.signal });
    const p2 = g2.gate.execute({ id: 'c4', name: 'browser.open', input: { url: 'http://shop.test/login' } }, g2.ctx);
    const w2 = await waitUntil(() => h.events.filter((e) => e.type === 'browser.handoff' && e.payload.status === 'waiting')[1]);
    assert.equal(w2.payload.runId, 'run-2');
    ac.abort();
    const r2 = await p2;
    assert.equal(r2.ok, false);
    assert.equal(r2.code, 'HANDOFF_ABANDONED');
    assert.equal(h.events.filter((e) => e.type === 'browser.handoff').at(-1).payload.status, 'abandoned');
    assert.equal(h.browser.handoffs().length, 2);
    assert.equal(h.browser.handoffs({ pendingOnly: true }).length, 0);
  } finally {
    await h.cleanup();
  }
});

test('the control closes a Ranger\'s browser when its run ends, and the HTTP routes expose status, handoffs, the return and the trace', async () => {
  const driver = fakeDriver();
  const layout = defaultLayout();
  layout.objects.push({ id: 'office', kind: 'field_office', roomId: 'ranger-station', x: 2, y: 2 });
  const leash = defaultLeash();
  leash.domains.browser_control = { level: 'act_free' };
  const provider = fakeProvider([
    [...toolCall('b1', 'browser.open', { url: 'http://shop.test/login' }), end('tool_use')],
    [text('signed in, done'), end()],
  ]);
  const srv = await startTestServer({ layout, leash, makeProvider: async () => ({ provider, model: 'm', price: null }), browser: { driver } });
  try {
    assert.ok((await srv.get('/api/state')).body.objectKinds.field_office);
    const st = await srv.get('/api/browser');
    assert.equal(st.status, 200);
    assert.equal(st.body.wired, true);
    assert.equal(st.body.headless, true);
    assert.equal((await srv.get('/api/state')).body.browser.wired, true);
    const stream = await srv.sse();
    const r = await srv.post('/api/run', { prompt: 'sign in' });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const start = await stream.waitFor((e) => e.type === 'agent.run.start');
    assert.ok(start.payload.tools.includes('browser.open'));
    const waiting = await stream.waitFor((e) => e.type === 'browser.handoff' && e.payload.status === 'waiting');
    assert.equal(waiting.payload.runId, r.body.runId);
    assert.equal((await srv.get('/api/state')).body.browser.pending.length, 1);
    assert.equal((await srv.get('/api/browser/handoffs')).body[0].status, 'waiting');
    assert.equal((await srv.post('/api/browser/handoff/hand-nope/return', {})).status, 404);
    const ret = await srv.post(`/api/browser/handoff/${waiting.payload.handoffId}/return`, { notes: 'done' });
    assert.equal(ret.status, 200, JSON.stringify(ret.body));
    assert.equal(ret.body.status, 'returned');
    assert.equal((await srv.post(`/api/browser/handoff/${waiting.payload.handoffId}/return`, {})).status, 409);
    await stream.waitFor((e) => e.type === 'agent.run.end' && e.payload.runId === r.body.runId);
    await srv.runs.waitForIdle();
    await waitUntil(() => driver.state.killed === 1);
    assert.equal((await srv.get('/api/browser')).body.sessions.length, 0, 'closed with the run');
    const trace = await srv.get('/api/browser/trace/ranger?limit=5');
    assert.equal(trace.status, 200);
    assert.deepEqual(trace.body.map((t) => t.action), ['handoff', 'open']);
    assert.equal(trace.body[1].runId, r.body.runId);
    const toolResult = (await srv.get(`/api/runs/${r.body.runId}`)).body;
    assert.ok(JSON.stringify(toolResult).includes('handed the page back'), 'the Ranger saw the handoff outcome');
    assert.equal((await srv.get('/api/browser/trace/nobody')).body.length, 0);
    stream.close();
  } finally {
    await srv.close();
  }
});

// ---------- the real thing (skipped when no Chromium is installed) ----------

async function serveFixtures() {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const map = { '/': 'browser-page.html', '/index.html': 'browser-page.html', '/login.html': 'browser-login.html', '/account.html': 'browser-account.html', '/about.html': 'browser-account.html' };
    if (u.pathname === '/report.csv') {
      res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="report.csv"' });
      return res.end('sku,sold\nlantern,12\n');
    }
    const file = map[u.pathname];
    if (!file) {
      res.writeHead(404);
      return res.end('no');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(await fsp.readFile(path.join(FIXTURES, file)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

test('real Chromium: the tools drive a page served locally, detect a login page, and keep the profile', { timeout: 90_000 }, async (t) => {
  const bin = await findChromium({ env: process.env });
  if (!bin) {
    t.skip('no Chromium installed (set CHROMIUM)');
    return;
  }
  const site = await serveFixtures();
  const h = await harness({ driver: undefined });
  const netGuard = createNetGuard({ allowLocal: true }); // the fixture site is on loopback
  const real = await createBrowserControl({ bus: h.bus, workspaceRoot: h.workspaceRoot, env: process.env, config: { headless: true, chromiumPath: bin }, clock: h.clock, netGuard, log: { error() {} } }).init();
  const gate = createToolGate({ getLayout: h.layoutState.get, agentId: 'ranger', workspaceDir: path.join(h.workspaceRoot, 'ranger'), registry: { ...real.tools }, grants: allGrantsFor, toolContext: { browser: real, netGuard }, getLeash: () => h.leashState.get(), ledger: h.ledger });
  const ctx = { runId: 'run-real' };
  const call = async (id, name, input) => {
    const r = await gate.execute({ id, name, input }, ctx);
    assert.equal(r.ok, true, `${name}: ${r.error}`);
    return JSON.parse(r.output.split('\n')[0]);
  };
  try {
    const open = await call('r1', 'browser.open', { url: `${site.url}/` });
    assert.equal(open.title, 'Maka test shop');
    assert.match(open.text, /Paper lanterns for every trail/);
    assert.equal(open.handoff, null);
    const read = await call('r2', 'browser.read', { what: 'both' });
    assert.match(read.tree, /link "About the shop"/);
    assert.match(read.tree, /textbox "Search products"/);
    assert.match(read.text, /Click me/);
    const typed = await call('r3', 'browser.type', { text: 'Search products', value: 'lantern', submit: true });
    assert.equal(typed.typed.tag, 'input');
    assert.match((await call('r4', 'browser.read', { what: 'text' })).text, /You searched for lantern/);
    await call('r5', 'browser.click', { text: 'Click me' });
    assert.match((await call('r6', 'browser.read', { what: 'text' })).text, /Clicked 1 time\(s\)/);
    await fsp.writeFile(path.join(h.workspaceRoot, 'ranger', 'photo.txt'), 'twelve bytes');
    await call('r7', 'browser.upload', { selector: '#file', paths: ['photo.txt'] });
    assert.match((await call('r8', 'browser.read', { what: 'text' })).text, /photo\.txt:12/);
    const dl = await call('r9', 'browser.download', { text: 'Download the sales report' });
    assert.equal(dl.path, path.join('downloads', 'report.csv'));
    assert.equal(await fsp.readFile(path.join(h.workspaceRoot, 'ranger', dl.path), 'utf8'), 'sku,sold\nlantern,12\n');
    const shot = await call('r10', 'browser.screenshot', {});
    assert.equal((await fsp.readFile(shot.screenshot)).subarray(1, 4).toString(), 'PNG');
    const nav = await call('r11', 'browser.click', { text: 'About the shop' });
    assert.match(nav.url, /about\.html$/);
    // the login page raises a handoff; hand it back and the Ranger reads the page it is on
    const pending = gate.execute({ id: 'r12', name: 'browser.open', input: { url: `${site.url}/login.html` } }, ctx);
    const ev = await waitUntil(() => h.events.find((e) => e.type === 'browser.handoff'), { timeoutMs: 20_000 });
    assert.equal(ev.payload.kind, 'login');
    assert.match(ev.payload.url, /login\.html$/);
    // the Superintendent "signs in": submit the form from outside, as a human would
    await real.forAgent('ranger').then((s) => s.page.evaluate("document.getElementById('login').requestSubmit()"));
    real.returnHandoff(ev.payload.handoffId, { notes: 'signed in' });
    const r = await pending;
    assert.equal(r.ok, true, r.error);
    // the submitted form is still navigating when the handoff comes back: wait for the account page before reading it
    const session = await real.forAgent('ranger');
    await waitUntil(async () => /account\.html$/.test(session.page.url()) && /Welcome back/.test(await session.page.text(400).catch(() => '')), { timeoutMs: 15_000, stepMs: 50 });
    assert.match((await call('r13', 'browser.read', { what: 'text' })).text, /Welcome back, Ranger/);
    const trace = await real.trace('ranger');
    assert.ok(trace.length >= 13);
    assert.ok(trace.every((e) => e.action === 'handoff' || (e.screenshot && e.url)));
    assert.ok((await fsp.stat(path.join(h.workspaceRoot, 'ranger', PROFILE_DIR))).isDirectory(), 'the profile lives in the workspace');
  } finally {
    await real.close();
    await site.close();
    await h.cleanup();
  }
});
