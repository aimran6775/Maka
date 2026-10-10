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
import { TOOLS } from '../../sidecar/capability/tools.js';
import { CREW_TOOLS } from '../../sidecar/capability/crew.js';
import { createRouter, defaultPolicy } from '../../sidecar/router.js';
import { defaultLeash } from '../../shared/leash.js';
import { createWorkspaceWatcher } from '../../sidecar/workspace.js';
import { createApp, createHttpServer, createLayoutState } from '../../sidecar/server.js';
import { providerStatus } from '../../sidecar/providers/provider.js';
import { keystoreStatus } from '../../sidecar/providers/keys.js';
import { defaultLayout } from '../../shared/world.js';
import { REPO_ROOT } from '../../sidecar/index.js';

// `localFetch` stands in for the Ollama probe/requests so tests never touch a real server.
const refused = async () => { throw new Error('ECONNREFUSED (test)'); };

// `judgeProvider`: a (name, opts) => { provider, model, price } factory for the judge tier; when
// absent no judge is wired, so runs are not reviewed (the phase 1 behaviour).
export async function startTestServer({ makeProvider, env = {}, layout = defaultLayout(), permissionTimeoutMs, clock, localFetch = refused, policy, leash, judgeProvider = null, withChief = false, maxConcurrent } = {}) {
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
  const toolContext = {};
  const registry = { ...TOOLS, ...CREW_TOOLS };
  const runs = createRunManager({ bus, store, getLayout: layoutState.get, workspaceRoot, env, keystorePath, makeProvider, permissionTimeoutMs, clock, policy, leashState, ledger, gateQueue, judge, agents, toolContext, registry, maxConcurrent, fetch: localFetch, workspaceOnline: () => workspace.state().online });
  runsRef = runs;
  const trails = await createTrails({ bus, store, runs, agents, getLayout: layoutState.get, clock, workspaceRoot }).init();
  toolContext.trails = trails;
  const chief = await createChief({ bus, store, runs, agents, trails, ledger, router: createRouter(policy || defaultPolicy()), getLayout: layoutState.get, clock, workspaceRoot, log: { error() {} } }).init();
  Object.assign(registry, chief.tools);
  const scheduler = await createScheduler({ store, clock, tickMs: 60_000, log: { error() {} } }).init();
  away = await createAway({ bus, store, gateQueue, workspaceRoot, clock, log: { error() {} } }).init();
  const reflect = await createReflect({ bus, store, runs, agents, trails, chief, ledger, gateQueue, router: createRouter(policy || defaultPolicy()), scheduler, makeProvider: judgeProvider || makeProvider, getLayout: layoutState.get, clock, workspaceRoot, env, keystorePath, log: { error() {} } }).init();
  await workspace.check();
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
    chief,
    scheduler,
    reflect,
    away,
    workspace,
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
    async send(method, p, body) {
      const res = await fetch(url + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
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
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await fsp.rm(tmp, { recursive: true, force: true });
    },
  };
  return api;
}
