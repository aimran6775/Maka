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
import { createToolGate } from '../sidecar/capability/gate.js';
import { createJudge } from '../sidecar/judge.js';
import { createRouter, defaultPolicy } from '../sidecar/router.js';
import { createResearch } from '../sidecar/research/index.js';
import { createBraveSearch, browserSearch } from '../sidecar/research/search.js';
import { extractReadable } from '../sidecar/research/read.js';
import { createTrends, slope } from '../sidecar/research/trends.js';
import { VENTURE_BRIEF_SCHEMA, renderBrief, totalCosts, listBriefs } from '../sidecar/research/brief.js';
import { createBrowserControl } from '../sidecar/browser/control.js';
import { validate } from '../shared/schema.js';
import { ENV_VARS } from '../sidecar/providers/keys.js';
import { OBJECT_KINDS, defaultLayout, allGrantsFor } from '../shared/world.js';
import { defaultLeash, TOOL_DOMAINS } from '../shared/leash.js';
import { startFakeResearch, ARTICLE_HTML } from './helpers/fake-research.js';
import { createNetGuard } from '../sidecar/netguard.js';
import { startTestServer } from './helpers/test-server.js';
import { fakeProvider, fakeClock, text, toolCall, end, waitUntil } from './helpers/fake-provider.js';

const BRIEF = {
  ventureId: 'lantern-co',
  title: 'Paper lanterns on Etsy',
  summary: 'Handmade paper lanterns, $25 each, sold on Etsy with small ad budgets.',
  opportunity: 'Lantern sales grew 40 % this year on handmade marketplaces; makers report waiting lists.',
  customer: 'Festival and wedding buyers in the US.',
  evidence: [
    { claim: 'Lanterns sold 40 % more this year', source: 'https://stats.example/report-2026', date: '2026-09-01' },
    { claim: 'Makers have waiting lists of weeks', source: 'https://trailtimes.example/lanterns', date: '2026-09-30', quote: 'their waiting lists run into weeks' },
  ],
  costs: [
    { item: 'Materials per lantern', usd: 6, basis: 'Trail Times quotes a unit cost near $6', recurring: 'per_unit' },
    { item: 'Etsy listing fees', usd: 0.2, basis: 'Etsy fee schedule', recurring: 'per_unit' },
    { item: 'Launch ads', usd: 100, basis: 'Two weeks at $7/day', recurring: 'one_off' },
  ],
  revenueModel: '$25 per lantern, 30 a month at first, margin about $15 after fees and shipping.',
  risks: ['Seasonal demand', 'Fragile shipping'],
  recommendation: 'go',
  confidence: 0.7,
  firstSteps: ['List three designs as drafts', 'Run a $7/day ad for two weeks'],
};

test('Brave search client and the browser fallback parse results; slope and the readable extractor are pure', async () => {
  assert.equal(ENV_VARS.braveSearch, 'BRAVE_SEARCH_API_KEY');
  assert.equal(slope([1, 1, 2, 2]), 1);
  assert.equal(slope([4, 4, 2, 2]), -0.5);
  assert.equal(slope([0, 0, 3, 3]), 1);
  assert.equal(slope([5]), 0);
  const doc = extractReadable(ARTICLE_HTML, 'https://trailtimes.example/lanterns');
  assert.equal(doc.title, 'Paper lanterns are back · Trail Times');
  assert.equal(doc.byline, 'R. Ranger');
  assert.equal(doc.published, '2026-09-30T10:00:00Z');
  assert.equal(doc.description, 'Why paper lanterns sell again');
  assert.match(doc.text, /sold 40 % more/);
  assert.match(doc.text, /waiting lists run into weeks/);
  assert.doesNotMatch(doc.text, /Subscribe to our newsletter|Sponsored|Home|About|Related: ten boots|© Trail Times/);
  assert.deepEqual(doc.links.map((l) => l.url), ['https://stats.example/report-2026', 'https://trailtimes.example/methodology']);
  assert.ok(doc.words > 50);
  assert.equal(extractReadable('<html><body><p>a</p></body></html>').title, '');
  const fake = await startFakeResearch();
  try {
    assert.throws(() => createBraveSearch({}), TypeError);
    await assert.rejects(createBraveSearch({ apiKey: 'wrong', baseUrl: fake.endpoints.braveBaseUrl }).search('x'), (e) => e.code === 'HTTP_401' && /Invalid API key/.test(e.message));
    const brave = createBraveSearch({ apiKey: fake.braveKey, baseUrl: fake.endpoints.braveBaseUrl });
    const r = await brave.search('paper lanterns', { count: 1, freshness: 'pm' });
    assert.equal(r.via, 'brave');
    assert.deepEqual(r.results, [{ title: 'Paper lantern trends 2026', url: 'https://trailtimes.example/lanterns', snippet: 'Why paper lanterns sell again', age: '2 weeks ago', source: 'brave' }]);
    assert.match(fake.state.calls.at(-1).path, /q=paper\+lanterns&count=1&freshness=pm/);
    assert.equal(fake.state.calls.at(-1).headers['x-subscription-token'], fake.braveKey);
  } finally {
    await fake.close();
  }
});

async function harness({ fake, env = {}, judgeScripts = null } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-research-'));
  const store = createStore({ root: path.join(dir, 'home') });
  await store.init();
  const bus = createEventBus();
  const events = [];
  bus.listen((e) => events.push(e));
  const clock = fakeClock(Date.UTC(2026, 9, 10, 12));
  const layout = defaultLayout();
  layout.rooms.push({ id: 'research', name: 'Research Camp', kind: 'research', x: 21, y: 1, w: 8, h: 6 });
  layout.objects.push({ id: 'sign', kind: 'trailhead_sign', roomId: 'research', x: 22, y: 2 });
  layout.agents.push({ id: 'scout', name: 'Sky', roomId: 'research', x: 21, y: 1, role: 'ranger', specialty: 'scout' });
  const layoutState = createLayoutState({ initial: layout, store, bus, clock });
  const ledger = await createLeashLedger({ store, clock }).init();
  const leashState = createLeashState({ initial: defaultLeash(), store });
  const gateQueue = await createGateQueue({ bus, store, ledger, leashState, getLayout: layoutState.get, clock }).init();
  const keystorePath = path.join(dir, 'home', 'keystore.json');
  const judge = judgeScripts ? createJudge({ router: createRouter(defaultPolicy()), makeProvider: async (name, opts) => ({ provider: fakeProvider(judgeScripts(), { name }), model: opts.model || 'm', price: { inputPerMTok: 2, outputPerMTok: 10 } }), ledger, bus, clock, env, keystorePath, log: { error() {} } }) : null;
  const workspaceRoot = path.join(dir, 'ws');
  await fsp.mkdir(path.join(workspaceRoot, 'scout'), { recursive: true });
  const research = createResearch({ env, keystorePath, judge, workspaceRoot, endpoints: fake.endpoints, clock });
  const gateFor = (toolContext = {}) => createToolGate({ getLayout: layoutState.get, agentId: 'scout', workspaceDir: path.join(workspaceRoot, 'scout'), registry: { ...research.tools }, grants: allGrantsFor, toolContext: { judge, netGuard: createNetGuard({ allowLocal: true }), ...toolContext }, getLeash: () => leashState.get(), ledger, submit: { submit: (item) => gateQueue.submit({ ...item, runId: 'run-1', agentId: 'scout' }), log: (item) => gateQueue.log({ ...item, runId: 'run-1', agentId: 'scout' }) } });
  const gate = gateFor();
  const ofType = (t) => events.filter((e) => e.type === t).map((e) => e.payload);
  const call = (id, name, input, g = gate) => g.execute({ id, name, input }, { runId: 'run-1', turn: 1 });
  return { dir, bus, events, ofType, clock, gateQueue, ledger, keystorePath, workspaceRoot, research, judge, gate, gateFor, call, cleanup: async () => fsp.rm(dir, { recursive: true, force: true }) };
}

test('the Trailhead sign grants the kit (research; the brief has no domain); web.search uses the Brave key when set, else the browser on DuckDuckGo, else says what is missing; web.read and web.trends answer from the fakes', async () => {
  assert.deepEqual(OBJECT_KINDS.trailhead_sign.grants, ['web.fetch', 'web.search', 'web.read', 'web.trends', 'brief.submit']);
  for (const t of ['web.search', 'web.read', 'web.trends']) assert.equal(TOOL_DOMAINS[t], 'research');
  assert.equal(TOOL_DOMAINS['brief.submit'], null);
  const fake = await startFakeResearch();
  const h = await harness({ fake, env: { BRAVE_SEARCH_API_KEY: fake.braveKey } });
  try {
    assert.deepEqual(h.gate.definitions().map((d) => d.name), ['brief.submit', 'web.read', 'web.search', 'web.trends'], 'web.fetch lives in the phase 1 registry');
    assert.deepEqual(await h.research.status(), { search: 'brave', searchKey: true, trends: ['wikipedia', 'hacker_news'], judge: false });
    const s = JSON.parse((await h.call('c1', 'web.search', { query: 'paper lanterns', count: 2 })).output);
    assert.equal(s.via, 'brave');
    assert.equal(s.results.length, 2);
    const read = JSON.parse((await h.call('c2', 'web.read', { url: `${fake.url}/site/lanterns` })).output);
    assert.equal(read.title, 'Paper lanterns are back · Trail Times');
    assert.equal(read.url, 'https://trailtimes.example/lanterns', 'the canonical URL');
    assert.match(read.text, /unit cost near \$6/);
    assert.equal(read.links.length, 2);
    const plain = JSON.parse((await h.call('c3', 'web.read', { url: `${fake.url}/site/plain.txt` })).output);
    assert.equal(plain.text, 'just text\nline two');
    assert.equal((await h.call('c4', 'web.read', { url: `${fake.url}/site/missing` })).code, 'HTTP_404');
    assert.match((await h.call('c5', 'web.read', { url: 'ftp://x' })).error, /only http and https/);
    const short = JSON.parse((await h.call('c6', 'web.read', { url: `${fake.url}/site/lanterns`, maxChars: 500 })).output);
    assert.match(short.text, /\[truncated: \d+ characters in total\]$/);
    const tr = JSON.parse((await h.call('c7', 'web.trends', { topic: 'paper lantern', days: 14 })).output);
    assert.equal(tr.wikipedia.article, 'Paper lantern');
    assert.equal(tr.wikipedia.daily.length, 14);
    assert.ok(tr.wikipedia.change > 0, 'views rise in the fake');
    assert.equal(tr.hackerNews.stories, 2);
    assert.equal(tr.hackerNews.top[0].points, 120);
    assert.deepEqual(tr.sources, ['https://en.wikipedia.org/wiki/Paper_lantern', 'https://hn.algolia.com/?q=paper%20lantern']);
    assert.match(fake.state.calls.find((c) => c.path.includes('/wikirest/')).path, /\/daily\/20260926\/20261009$/, '14 days ending yesterday');
    const none = JSON.parse((await h.call('c8', 'web.trends', { topic: 'nothing here' })).output);
    assert.equal(none.wikipedia.article, null);
    fake.state.failWiki = { status: 503 };
    const partial = JSON.parse((await h.call('c9', 'web.trends', { topic: 'paper lantern' })).output);
    assert.match(partial.wikipedia.error, /503/);
    assert.equal(partial.hackerNews.stories, 2, 'one source down still answers');
    fake.state.failHn = { status: 500 };
    assert.equal((await h.call('c10', 'web.trends', { topic: 'paper lantern' })).code, 'TRENDS_UNAVAILABLE');
    fake.state.failWiki = null;
    fake.state.failHn = null;
    assert.equal(h.gateQueue.recent(20).length, 0, 'research is not logged at the Gate');
    assert.equal(h.ledger.summary().domains.research.actions, 7, 'but the seven that succeeded count in the ledger');
  } finally {
    await h.cleanup();
    await fake.close();
  }
  // no key, no browser → a plain refusal; no key + browser → DuckDuckGo through the trace
  const fake2 = await startFakeResearch();
  const h2 = await harness({ fake: fake2 });
  try {
    assert.equal((await h2.research.status()).search, 'browser fallback (no BRAVE_SEARCH_API_KEY)');
    const no = await h2.call('s1', 'web.search', { query: 'x' });
    assert.equal(no.code, 'NO_SEARCH');
    assert.match(no.error, /BRAVE_SEARCH_API_KEY/);
    const pages = [];
    const driver = { find: async () => '/fake/chromium', launch: async () => ({ wsUrl: 'ws://fake', kill() {} }), connect: async () => ({ close() {}, closed: new Promise(() => {}) }), openPage: async () => { const p = { url: 'about:blank' }; const page = { url: () => p.url, async navigate(u) { p.url = u; return { url: u, title: 'DuckDuckGo' }; }, async summary() { return { url: p.url, title: 'DuckDuckGo' }; }, async facts() { return { url: p.url, title: 'DuckDuckGo', text: 'results' }; }, async evaluate(expr) { const res = await fetch(p.url); const html = await res.text(); return [...html.matchAll(/class="result__a" href="([^"]+)">([^<]+)<\/a>/g)].map((m) => { const u = new URL(m[1].replace(/^\/\//, 'https://')); return { title: m[2], url: u.searchParams.get('uddg') || u.toString(), snippet: '' }; }).slice(0, Number(/\((\d+)\)$/.exec(expr)[1])); }, async screenshot() { return Buffer.from('png'); }, async bringToFront() {}, async close() {} }; pages.push(page); return page; } };
    const browser = await createBrowserControl({ bus: h2.bus, workspaceRoot: h2.workspaceRoot, env: {}, config: { headless: true }, clock: h2.clock, driver, netGuard: createNetGuard({ allowLocal: true }), log: { error() {} } }).init();
    const g = h2.gateFor({ browser });
    const r = await h2.call('s2', 'web.search', { query: 'paper lanterns', count: 2 }, g);
    assert.equal(r.ok, true, r.error);
    const out = JSON.parse(r.output);
    assert.equal(out.via, 'browser');
    assert.match(out.note, /DuckDuckGo/);
    assert.deepEqual(out.results.map((x) => x.url), ['https://trailtimes.example/lanterns', 'https://stats.example/report-2026']);
    assert.equal(out.results[0].source, 'duckduckgo');
    const trace = await browser.trace('scout');
    assert.equal(trace[0].action, 'search');
    assert.deepEqual(trace[0].input, { query: 'paper lanterns' });
    assert.match(pages[0].url(), /\/duck\/\?q=paper%20lanterns$/);
    await browser.close();
  } finally {
    await h2.cleanup();
    await fake2.close();
  }
});

test('brief.submit validates, asks the judge, writes JSON and Markdown into outbox/briefs/, and the Peak lists them; no judge → skipped and said so', async () => {
  assert.equal(validate(VENTURE_BRIEF_SCHEMA, BRIEF).ok, true);
  assert.equal(validate(VENTURE_BRIEF_SCHEMA, { ...BRIEF, evidence: [{ claim: 'x', source: 'not a url' }] }).ok, false, 'sources are URLs');
  assert.equal(validate(VENTURE_BRIEF_SCHEMA, { ...BRIEF, recommendation: 'maybe' }).ok, false);
  assert.deepEqual(totalCosts(BRIEF), { one_off: 100, monthly: 0, per_unit: 6.2 });
  const md = renderBrief(BRIEF, { id: 'brief-1', agentId: 'scout', submittedAt: 0, judge: { verdict: 'approve', notes: 'solid' } });
  assert.match(md, /^# Paper lanterns on Etsy/);
  assert.match(md, /\*\*Recommendation: go\*\* \(confidence 70 %\)/);
  assert.match(md, /Judge: approve — solid/);
  assert.match(md, /- Lanterns sold 40 % more this year — https:\/\/stats.example\/report-2026 \(2026-09-01\)/);
  assert.match(md, /> their waiting lists run into weeks/);
  assert.match(md, /One-off \$100.00 · monthly \$0.00 · per unit \$6.20/);
  assert.match(md, /1\. List three designs as drafts/);
  const fake = await startFakeResearch();
  const verdicts = [];
  const h = await harness({ fake, judgeScripts: () => [[text('{"verdict":"revise","notes":"the 40 % claim needs the report page, not the summary"}'), end('end_turn', { inputTokens: 500, outputTokens: 30 })], [text('{"verdict":"approve","notes":"evidence and costs hold"}'), end('end_turn', { inputTokens: 500, outputTokens: 20 })]] });
  try {
    const bad = await h.call('b0', 'brief.submit', { ...BRIEF, evidence: [BRIEF.evidence[0]] });
    assert.match(bad.error, /invalid input|not complete/);
    const r1 = await h.call('b1', 'brief.submit', BRIEF);
    assert.equal(r1.ok, true, r1.error);
    const o1 = JSON.parse(r1.output.split('\n')[0]);
    assert.match(o1.id, /^brief-2026-\d\d-\d\d-[a-z0-9]{5}$/);
    assert.equal(o1.path, path.join('outbox', 'briefs', `${o1.id}.md`));
    assert.equal(o1.judge.verdict, 'revise');
    assert.match(r1.output, /The judge says revise: the 40 % claim needs the report page.*Fix what the judge named and submit again\./);
    const v = h.ofType('judge.verdict');
    assert.equal(v.length, 1);
    assert.equal(v[0].scope, 'action');
    assert.deepEqual(v[0].tools, ['brief.submit']);
    assert.equal(v[0].runId, 'run-1');
    assert.equal(v[0].agentId, 'scout');
    assert.ok(v[0].usd > 0);
    assert.equal(h.ofType('cost.estimate')[0].tier, 'judge');
    assert.ok(h.ledger.judgeToday().calls === 1);
    const rec = JSON.parse(await fsp.readFile(path.join(h.workspaceRoot, 'scout', 'outbox', 'briefs', `${o1.id}.json`), 'utf8'));
    assert.equal(rec.brief.title, BRIEF.title);
    assert.equal(rec.judge.notes, 'the 40 % claim needs the report page, not the summary');
    const mdFile = await fsp.readFile(path.join(h.workspaceRoot, 'scout', o1.path), 'utf8');
    assert.match(mdFile, /Judge: revise — the 40 % claim/);
    const r2 = await h.call('b2', 'brief.submit', { ...BRIEF, evidence: [...BRIEF.evidence, { claim: 'Report page confirms 40 %', source: 'https://stats.example/report-2026/lanterns', date: '2026-09-01' }] });
    assert.equal(JSON.parse(r2.output.split('\n')[0]).judge.verdict, 'approve');
    const list = await h.research.listBriefs();
    assert.equal(list.length, 2);
    assert.equal(list[0].judge.verdict, 'approve', 'newest first');
    assert.equal(list[0].evidence, 3);
    assert.equal(list[0].agentId, 'scout');
    assert.equal(list[0].path, path.join('scout', 'outbox', 'briefs', `${list[0].id}.md`));
    assert.equal(list[1].id, o1.id);
    assert.deepEqual(await listBriefs(path.join(h.dir, 'nowhere')), []);
    // judge at its cap: skipped, the brief still lands
    const capped = await h.call('b3', 'brief.submit', BRIEF, h.gateFor({ judge: { reviewDocument: async () => ({ verdict: 'skipped', reason: 'judge cap reached: test' }) } }));
    assert.match(capped.output, /did not review it \(judge cap reached: test\); the Chief will read it as is/);
    assert.equal(h.gateQueue.recent(10).length, 0, 'no domain: nothing at the Gate');
  } finally {
    await h.cleanup();
    await fake.close();
  }
  const fake2 = await startFakeResearch();
  const h2 = await harness({ fake: fake2 });
  try {
    const r = await h2.call('b1', 'brief.submit', BRIEF);
    assert.equal(JSON.parse(r.output.split('\n')[0]).judge.reason, 'no judge wired');
    assert.match(r.output, /no judge wired/);
  } finally {
    await h2.cleanup();
    await fake2.close();
  }
});

test('through the sidecar: a Scout searches, reads, checks the trend and submits a brief; the judge verdict and the brief deliverable reach the Chief; /api/research and /api/briefs', async () => {
  const fake = await startFakeResearch();
  const layout = defaultLayout();
  layout.rooms.push({ id: 'research', name: 'Research Camp', kind: 'research', x: 21, y: 1, w: 8, h: 6 });
  layout.objects.push({ id: 'sign', kind: 'trailhead_sign', roomId: 'research', x: 22, y: 2 });
  layout.agents.push({ id: 'scout', name: 'Sky', roomId: 'research', x: 21, y: 1, role: 'ranger', specialty: 'scout' });
  const worker = fakeProvider([
    [...toolCall('r1', 'web.search', { query: 'paper lanterns 2026' }), end('tool_use')],
    [...toolCall('r2', 'web.read', { url: `${fake.url}/site/lanterns` }), end('tool_use')],
    [...toolCall('r3', 'web.trends', { topic: 'paper lantern' }), end('tool_use')],
    [...toolCall('r4', 'brief.submit', BRIEF), end('tool_use')],
    [text('Brief submitted: go, judge approved.'), end()],
  ]);
  const judgeProvider = async (name, opts) => ({ provider: fakeProvider([[text('{"verdict":"approve","notes":"evidence cited, costs real"}'), end('end_turn', { inputTokens: 300, outputTokens: 20 })], [text('{"verdict":"approve","notes":"final answer fine"}'), end('end_turn', { inputTokens: 200, outputTokens: 10 })]], { name }), model: opts.model || 'm', price: { inputPerMTok: 2, outputPerMTok: 10 } });
  const srv = await startTestServer({ layout, makeProvider: async () => ({ provider: worker, model: 'm', price: null }), judgeProvider, env: { BRAVE_SEARCH_API_KEY: fake.braveKey }, research: fake.endpoints });
  try {
    const st = await srv.get('/api/research');
    assert.equal(st.body.search, 'brave');
    assert.equal(st.body.judge, true);
    assert.equal((await srv.get('/api/state')).body.research.searchKey, true);
    assert.deepEqual((await srv.get('/api/briefs')).body, []);
    const stream = await srv.sse();
    const r = await srv.post('/api/run', { prompt: 'Research paper lanterns and write a venture brief.', agentId: 'scout' });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const start = await stream.waitFor((e) => e.type === 'agent.run.start' && e.payload.runId === r.body.runId);
    for (const t of ['web.search', 'web.read', 'web.trends', 'brief.submit', 'web.fetch']) assert.ok(start.payload.tools.includes(t), t);
    const verdict = await stream.waitFor((e) => e.type === 'judge.verdict' && e.payload.tools && e.payload.tools[0] === 'brief.submit', 10000);
    assert.equal(verdict.payload.verdict, 'approve');
    assert.equal(verdict.payload.runId, r.body.runId);
    await stream.waitFor((e) => e.type === 'agent.run.end' && e.payload.runId === r.body.runId, 10000);
    await srv.runs.waitForIdle();
    const briefs = (await srv.get('/api/briefs')).body;
    assert.equal(briefs.length, 1);
    assert.equal(briefs[0].recommendation, 'go');
    assert.equal(briefs[0].judge.verdict, 'approve');
    assert.equal(briefs[0].agentId, 'scout');
    const results = stream.events.filter((e) => e.type === 'agent.tool_result').map((e) => e.payload);
    assert.ok(results.find((x) => x.callId === 'r1').output.includes('"via":"brave"'));
    assert.ok(results.find((x) => x.callId === 'r3').output.includes('"article":"Paper lantern"'));
    assert.match(results.find((x) => x.callId === 'r4').output, /The judge says approve/);
    assert.ok((await srv.get('/api/state')).body.ledger.domains.research.actions >= 3);
    stream.close();
  } finally {
    await srv.close();
    await fake.close();
  }
});
