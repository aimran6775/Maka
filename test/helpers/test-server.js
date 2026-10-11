// Boots a full sidecar stack on an ephemeral port with a temp data dir and an injectable
// provider factory. Mirrors sidecar/index.js wiring without the process-level bits.
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createStore } from '../../sidecar/store.js';
import { createEventBus } from '../../sidecar/bus.js';
import { createRunManager } from '../../sidecar/runs.js';
import { createLeashLedger, createLeashState } from '../../sidecar/leash-ledger.js';
import { createGateQueue } from '../../sidecar/gate-queue.js';
import { createJudge } from '../../sidecar/judge.js';
import { createAgents } from '../../sidecar/agents.js';
import { createTrails } from '../../sidecar/trails.js';
import { createChief } from '../../sidecar/chief.js';
import { createScheduler } from '../../sidecar/scheduler.js';
import { createReflect } from '../../sidecar/reflect.js';
import { createAway } from '../../sidecar/away.js';
import { createMailSetup } from '../../sidecar/mail/setup.js';
import { createMailSystem } from '../../sidecar/mail/system.js';
import { createBrowserControl } from '../../sidecar/browser/control.js';
import { createNetGuard } from '../../sidecar/netguard.js';
import { createConnectors } from '../../sidecar/connectors/registry.js';
import { createResearch } from '../../sidecar/research/index.js';
import { createCreative } from '../../sidecar/creative/index.js';
import { createResults } from '../../sidecar/results.js';
import { createLedgerDesk } from '../../sidecar/ledger-desk.js';
import { createPurchases } from '../../sidecar/purchases.js';
import { createComputerControl } from '../../sidecar/computer/control.js';
import { createScoutMemory } from '../../sidecar/scout-memory.js';
import { createMemory } from '../../sidecar/memory/index.js';
import { createRecipes } from '../../sidecar/recipes/index.js';
import { createVoice } from '../../sidecar/voice.js';
import { createChannels } from '../../sidecar/channels/registry.js';
import { createMcpManager } from '../../sidecar/mcp/manager.js';
import { createOllama } from '../../sidecar/ollama.js';
import { createSetup } from '../../sidecar/setup.js';
import { createBackup } from '../../sidecar/backup/index.js';
import { TOOLS } from '../../sidecar/capability/tools.js';
import { CREW_TOOLS } from '../../sidecar/capability/crew.js';
import { createRouter, defaultPolicy } from '../../sidecar/router.js';
import { defaultLeash } from '../../shared/leash.js';
import { createWorkspaceWatcher } from '../../sidecar/workspace.js';
import { createApp, createHttpServer, createLayoutState } from '../../sidecar/server.js';
import { providerStatus } from '../../sidecar/providers/provider.js';
import { keystoreStatus, setKey } from '../../sidecar/providers/keys.js';
import { defaultLayout } from '../../shared/world.js';
import { REPO_ROOT } from '../../sidecar/index.js';

// `localFetch` stands in for the Ollama probe/requests so tests never touch a real server.
const refused = async () => { throw new Error('ECONNREFUSED (test)'); };

// `judgeProvider`: a (name, opts) => { provider, model, price } factory for the judge tier; when
// absent no judge is wired, so runs are not reviewed (the phase 1 behaviour).
// `netGuard`: the outbound URL guard the tools and the browser use (sidecar/netguard.js).
// The fakes every suite talks to listen on 127.0.0.1, so the default here turns the guard
// off; a test of the guard itself passes a strict one. The sidecar never turns it off.
export async function startTestServer({ makeProvider, env = {}, layout = defaultLayout(), permissionTimeoutMs, clock, localFetch = refused, policy, leash, judgeProvider = null, withChief = false, maxConcurrent, mail = {}, browser = null, connectors: connectorSpecs = null, connectorConfig = {}, research: researchEndpoints = null, creative: creativeOpts = null, ollama: ollamaUrl = null, setup: setupOpts = null, backup: backupOpts = null, channels: channelAdapters = null, mcp: mcpOpts = null, recipes: recipeOpts = null, keys = null, voice: voiceOpts = null, netGuard = createNetGuard({ allowLocal: true }) } = {}) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-srv-'));
  const home = path.join(tmp, 'home');
  const workspaceRoot = path.join(tmp, 'workspace');
  const keystorePath = path.join(home, 'keystore.json');
  const store = createStore({ root: home });
  await store.init();
  const bus = createEventBus();
  const layoutState = createLayoutState({ initial: layout, store, bus, clock });
  await store.saveLayout(layout);
  await fsp.mkdir(workspaceRoot, { recursive: true });
  let runsRef = null;
  let connectors = null;
  const leashState = createLeashState({ initial: leash || defaultLeash(), store });
  const ledger = await createLeashLedger({ store, clock, earnApprovals: leash && leash.earn && leash.earn.approvals }).init();
  let away = null;
  const gateQueue = await createGateQueue({ bus, store, ledger, leashState, getLayout: layoutState.get, clock, isAway: () => Boolean(away && away.state().away) }).init();
  const workspace = createWorkspaceWatcher({ root: workspaceRoot, bus, intervalMs: 60000, onOffline: () => runsRef && runsRef.cancel() });
  const judge = judgeProvider ? createJudge({ router: createRouter(policy || defaultPolicy()), makeProvider: judgeProvider, ledger, bus, clock, env, keystorePath, log: { error() {} } }) : null;
  const agents = createAgents({ layoutState, leashState, bus, clock, activeRunFor: (id) => (runsRef ? runsRef.activeFor(id) : null) });
  if (withChief) {
    await agents.ensureChief();
    await agents.ensureZone('visitor_center');
  }
  const toolContext = { netGuard };
  const registry = { ...TOOLS, ...CREW_TOOLS };
  let scoutMemory = null;
  let recipes = null;
  // Phase 4 step 11: Ranger memory, always wired (writes need the judge).
  const memory = await createMemory({ store, bus, agents, getLayout: layoutState.get, judge, clock, log: { error() {} } }).init();
  Object.assign(registry, memory.tools);
  const runs = createRunManager({ bus, store, getLayout: layoutState.get, workspaceRoot, env, keystorePath, makeProvider, permissionTimeoutMs, clock, policy, leashState, ledger, gateQueue, judge, agents, toolContext, registry, maxConcurrent, fetch: localFetch, workspaceOnline: () => workspace.state().online, systemExtras: (agent, info) => [...(recipes ? recipes.skillLines(agent) : []), ...(agent && agent.specialty === 'scout' && scoutMemory ? scoutMemory.promptLines() : []), ...(recipes ? recipes.recipeLines(agent) : []), ...memory.promptLines(agent, info || {})] });
  runsRef = runs;
  const trails = await createTrails({ bus, store, runs, agents, getLayout: layoutState.get, clock, workspaceRoot }).init();
  toolContext.trails = trails;
  // Phase 4 step 12: recipes and skills; `recipes: { starterDir }` points at a library
  // (default: the repo's starter library; `false` seeds nothing).
  recipes = await createRecipes({ store, bus, trails, agents, getLayout: layoutState.get, leashState, workspaceRoot, starterDir: recipeOpts === false ? null : (recipeOpts && recipeOpts.starterDir) || path.join(REPO_ROOT, 'recipes', 'starter'), clock, log: { error() {}, warn() {} } }).init();
  Object.assign(registry, recipes.tools);
  const chief = await createChief({ bus, store, runs, agents, trails, ledger, router: createRouter(policy || defaultPolicy()), getLayout: layoutState.get, clock, workspaceRoot, log: { error() {} } }).init();
  Object.assign(registry, chief.tools);
  const scheduler = await createScheduler({ store, clock, tickMs: 60_000, log: { error() {} } }).init();
  away = await createAway({ bus, store, gateQueue, workspaceRoot, clock, log: { error() {} } }).init();
  const mailSetup = createMailSetup({ bus, gateQueue, env, keystorePath, clock, fetch: globalThis.fetch, log: { error() {} }, ...mail });
  const mailSystem = await createMailSystem({ bus, store, scheduler, getLayout: layoutState.get, env, keystorePath, clock, workspaceRoot, log: { error() {} }, resendBaseUrl: mail.resendBaseUrl, router: createRouter(policy || defaultPolicy()), makeProvider: mail.classifyProvider || null, ledger, classify: Boolean(mail.classifyProvider) }).init();
  Object.assign(registry, mailSystem.tools);
  toolContext.mail = mailSystem;
  // `browser`: { driver } injects a fake page factory; { real: true } launches a headless
  // Chromium (tests skip when none is installed). Absent: no browser control is wired.
  const browserControl = browser ? await createBrowserControl({ bus, env, workspaceRoot, clock, config: { headless: true, chromiumPath: browser.chromiumPath }, driver: browser.driver, netGuard, log: { error() {} } }).init() : null;
  if (browserControl) {
    Object.assign(registry, browserControl.tools);
    toolContext.browser = browserControl;
  }
  // `connectors`: an array of connector specs to define (tests pass fakes pointing at
  // fake servers); absent → no connector framework is wired.
  // `keys`: { name: value } seeded into the 0600 keystore before anything reads it (a connector
  // token, an OAuth client id), so a test can start connected without the sign-in dance.
  if (keys) for (const [name, value] of Object.entries(keys)) await setKey(name, typeof value === 'string' ? value : JSON.stringify(value), { env, keystorePath });
  connectors = connectorSpecs ? createConnectors({ bus, store, scheduler, gateQueue, env, keystorePath, clock, fetch: globalThis.fetch, config: connectorConfig, log: { error() {}, warn() {} } }) : null;
  if (connectors) {
    for (const spec of connectorSpecs) connectors.define(spec);
    await connectors.init();
    Object.assign(registry, connectors.tools);
    toolContext.connectors = connectors;
  }
  // Phase 4 step 9: the results engine, always wired (ledgers only until a connector syncs).
  const results = await createResults({ bus, store, agents, trails, chief, ledger, gateQueue, getConnectors: () => connectors, getMail: () => mailSystem, getLayout: layoutState.get, clock, log: { error() {} } }).init();
  const ledgerDesk = createLedgerDesk({ results, ledger, getLayout: layoutState.get, clock });
  Object.assign(registry, ledgerDesk.tools);
  const purchases = await createPurchases({ bus, store, trails, ledger, browser: browserControl, getLayout: layoutState.get, getConnectors: () => connectors, knownVentures: () => (chief && chief.state().plan ? chief.state().plan.ventures.map((v) => v.id) : []), netGuard, workspaceRoot, clock, log: { error() {} } }).init();
  Object.assign(registry, purchases.tools);
  const computer = await createComputerControl({ bus, env, workspaceRoot, clock, log: { error() {} } }).init();
  Object.assign(registry, computer.tools);
  const reflect = await createReflect({ bus, store, runs, agents, trails, chief, ledger, gateQueue, router: createRouter(policy || defaultPolicy()), scheduler, makeProvider: judgeProvider || makeProvider, getLayout: layoutState.get, clock, workspaceRoot, env, keystorePath, getConnectors: () => connectors, getMail: () => mailSystem, getResults: () => results, log: { error() {} } }).init();
  await workspace.check();
  // `research`: endpoints for the fakes ({ braveBaseUrl, duckBaseUrl, wikiApi, wikiRest, hnApi });
  // absent → no research kit is wired.
  // Phase 4 step 10: the Scout's memory, always wired; brief.submit records into it.
  scoutMemory = await createScoutMemory({ store, bus, getResults: () => results, clock, log: { error() {} } }).init();
  Object.assign(registry, scoutMemory.tools);
  const research = researchEndpoints ? createResearch({ env, keystorePath, judge, memory: scoutMemory, workspaceRoot, endpoints: researchEndpoints, clock }) : null;
  if (research) {
    Object.assign(registry, research.tools);
    toolContext.judge = judge;
  }
  // `creative`: { hfImagesBaseUrl, imageModel } points the image generator at a fake Hugging
  // Face; absent → no creative kit is wired.
  const creative = creativeOpts ? createCreative({ env, keystorePath, netGuard, judge, ledger, caps: createRouter(policy || defaultPolicy()).caps(), bus, workspaceRoot, config: creativeOpts, clock }) : null;
  if (creative) {
    Object.assign(registry, creative.tools);
    toolContext.judge = judge;
  }
  // `ollama`: a fake Ollama's URL wires the manager; `setup`: { verifyUrls, restart, platform, fs }
  // wires the first-run flow (absent → neither exists, as before phase 3).
  const ollama = ollamaUrl ? createOllama({ env: { ...env, OLLAMA_HOST: ollamaUrl }, bus, clock, log: { error() {} } }) : null;
  const restartCalls = [];
  const setup = setupOpts ? await createSetup({ home, workspaceRoot, env, keystorePath, bus, ollama, chief, agents, providerStatus: () => providerStatus({ env, keystorePath, fetch: localFetch, probeLocal: false }), restart: setupOpts.restart || (() => restartCalls.push(clock ? clock.now() : Date.now())), fetch: globalThis.fetch, fs: setupOpts.fs, platform: setupOpts.platform, clock, verifyUrls: setupOpts.verifyUrls, log: { error() {} } }).init() : null;
  // `voice`: { hfAsrBaseUrl, model } points the relay at a fake recogniser; absent → the real endpoint (no key in tests: "not wired").
  const voice = createVoice({ env, keystorePath, netGuard, ledger, caps: createRouter(policy || defaultPolicy()).caps(), bus, clock, baseUrl: voiceOpts ? voiceOpts.hfAsrBaseUrl : undefined, model: voiceOpts ? voiceOpts.model : null, log: { error() {} } });
  // `mcp`: { oauthPort } wires the MCP manager (servers are added through the routes / the Gate).
  const mcp = mcpOpts ? await createMcpManager({ bus, store, gateQueue, env, keystorePath, netGuard, registry, getLayout: layoutState.get, clock, fetch: globalThis.fetch, oauthPort: mcpOpts.oauthPort, log: { error() {}, warn() {} } }).init() : null;
  if (mcp) {
    toolContext.mcp = mcp;
    layoutState.setObjectCheck((o) => mcp.checkPlacement(o));
  }
  // `channels`: adapters to register (fakes); absent → no channel registry is wired.
  const channels = channelAdapters ? await createChannels({ bus, store, gateQueue, chief, reflect, away, env, keystorePath, clock, log: { error() {}, warn() {} } }).init() : null;
  if (channels) {
    for (const a of channelAdapters) channels.register(a);
    await channels.start();
  }
  // `backup`: { endpoint, config } wires the R2 backup against a fake S3 endpoint.
  const backup = backupOpts ? await createBackup({ store, scheduler, bus, home, workspaceRoot, env, keystorePath, config: backupOpts.config || {}, fetch: globalThis.fetch, clock, hostname: backupOpts.hostname || 'test-mac', endpoint: backupOpts.endpoint, log: { error() {} } }).init() : null;
  const app = createApp({
    bus,
    store,
    runs,
    layoutState,
    leashState,
    ledger,
    gateQueue,
    agents,
    trails,
    chief,
    reflect,
    away,
    mailSetup,
    mail: mailSystem,
    browser: browserControl,
    connectors,
    channels,
    mcp,
    research,
    creative,
    results,
    purchases,
    computer,
    scoutMemory,
    memory,
    recipes,
    voice,
    setup,
    ollama,
    backup,
    restart: setup ? (setupOpts.restart || (() => restartCalls.push(clock ? clock.now() : Date.now()))) : null,
    workspace,
    providerStatus: () => providerStatus({ env, keystorePath, fetch: localFetch }),
    keystoreStatus: () => keystoreStatus({ env, keystorePath }),
    staticRoot: path.join(REPO_ROOT, 'frontend'),
    sharedRoot: path.join(REPO_ROOT, 'shared'),
    home,
    workspaceRoot,
  });
  const server = createHttpServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  const api = {
    url,
    home,
    workspaceRoot,
    store,
    bus,
    runs,
    layoutState,
    leashState,
    ledger,
    gateQueue,
    agents,
    trails,
    purchases,
    computer,
    chief,
    scheduler,
    reflect,
    away,
    mailSetup,
    mail: mailSystem,
    browser: browserControl,
    connectors,
    channels,
    mcp,
    research,
    results,
    scoutMemory,
    memory,
    recipes,
    voice,
    setup,
    ollama,
    backup,
    restartCalls,
    workspace,
    keystorePath,
    async get(p) {
      const res = await fetch(url + p);
      return { status: res.status, body: await res.json() };
    },
    async patch(p, body) {
      return api.send('PATCH', p, body);
    },
    async del(p) {
      return api.send('DELETE', p);
    },
    // The per-boot token (safety M4); send() carries it like the park page does.
    token: app.token,
    async send(method, p, body) {
      const res = await fetch(url + p, { method, headers: { 'content-type': 'application/json', 'x-maka-token': app.token }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    },
    post: (p, body) => api.send('POST', p, body),
    put: (p, body) => api.send('PUT', p, body),
    // Opens the SSE stream and resolves with a collector of parsed events.
    async sse(since = 0) {
      const ac = new AbortController();
      const res = await fetch(`${url}/api/events?since=${since}`, { signal: ac.signal });
      const events = [];
      const waiters = [];
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf('\n\n')) !== -1) {
              const frame = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
              if (!data) continue;
              const ev = JSON.parse(data);
              events.push(ev);
              for (const w of [...waiters]) if (w.pred(ev)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(ev); }
            }
          }
        } catch {
          /* aborted */
        }
      })();
      return {
        events,
        close: () => ac.abort(),
        waitFor(pred, timeoutMs = 5000) {
          const hit = events.find(pred);
          if (hit) return Promise.resolve(hit);
          return new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('timed out waiting for event')), timeoutMs);
            waiters.push({ pred, resolve: (e) => { clearTimeout(t); resolve(e); } });
          });
        },
      };
    },
    async close() {
      workspace.stop();
      runs.cancel();
      await runs.waitForIdle();
      if (browserControl) await browserControl.close();
      await computer.close();
      if (connectors) await connectors.close();
      if (channels) await channels.close();
      if (mcp) await mcp.close();
      await results.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      // A run record flushed by a follow-up that started during the cancel can land while the
      // directory is being removed; the remove is retried, as test/trails.test.js does.
      for (let i = 0; ; i++) {
        try {
          await fsp.rm(tmp, { recursive: true, force: true });
          return;
        } catch (err) {
          if (err.code !== 'ENOTEMPTY' || i >= 5) throw err;
          await new Promise((r) => setTimeout(r, 25));
        }
      }
    },
  };
  return api;
}
