// Boots a full sidecar stack on an ephemeral port with a temp data dir and an injectable
// provider factory. Mirrors sidecar/index.js wiring without the process-level bits.
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createStore } from '../../sidecar/store.js';
import { createEventBus } from '../../sidecar/bus.js';
import { createRunManager } from '../../sidecar/runs.js';
import { createWorkspaceWatcher } from '../../sidecar/workspace.js';
import { createApp, createHttpServer, createLayoutState } from '../../sidecar/server.js';
import { providerStatus } from '../../sidecar/providers/provider.js';
import { keystoreStatus } from '../../sidecar/providers/keys.js';
import { defaultLayout } from '../../shared/world.js';
import { REPO_ROOT } from '../../sidecar/index.js';

// `localFetch` stands in for the Ollama probe/requests so tests never touch a real server.
const refused = async () => { throw new Error('ECONNREFUSED (test)'); };

export async function startTestServer({ makeProvider, env = {}, layout = defaultLayout(), permissionTimeoutMs, clock, localFetch = refused, policy, leash } = {}) {
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
  const workspace = createWorkspaceWatcher({ root: workspaceRoot, bus, intervalMs: 60000, onOffline: () => runsRef && runsRef.cancel() });
  const runs = createRunManager({ bus, store, getLayout: layoutState.get, workspaceRoot, env, keystorePath, makeProvider, permissionTimeoutMs, clock, policy, leash, fetch: localFetch, workspaceOnline: () => workspace.state().online });
  runsRef = runs;
  await workspace.check();
  const app = createApp({
    bus,
    store,
    runs,
    layoutState,
    leashState: { get: () => runs.leash || null },
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
    workspace,
    async get(p) {
      const res = await fetch(url + p);
      return { status: res.status, body: await res.json() };
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
