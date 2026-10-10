// Maka sidecar entry point: one Node process serving HTTP + SSE and the static frontend.
//
//   node sidecar/index.js            (PORT=8790, MAKA_HOME=./.maka, MAKA_WORKSPACE=./workspace)
//
// Everything here is wiring; behaviour lives in loop.js, capability/, providers/, runs.js,
// server.js and store.js, all of which are tested with fakes.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.js';
import { createEventBus } from './bus.js';
import { createRunManager } from './runs.js';
import { createApp, createHttpServer, createLayoutState } from './server.js';
import { providerStatus } from './providers/provider.js';
import { keystoreStatus, defaultKeystorePath } from './providers/keys.js';
import { defaultLayout, LAYOUT_SCHEMA } from '../shared/world.js';
import { defaultLeash, validateLeash } from '../shared/leash.js';
import { defaultPolicy, validatePolicy } from './router.js';
import { validate } from '../shared/schema.js';
import { readJson } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..');

export async function boot({ env = process.env, port = Number(env.PORT) || 8790, host = env.HOST || '127.0.0.1', log = console } = {}) {
  const home = path.resolve(env.MAKA_HOME || path.join(process.cwd(), '.maka'));
  const workspaceRoot = path.resolve(env.MAKA_WORKSPACE || path.join(process.cwd(), 'workspace'));
  const keystorePath = defaultKeystorePath({ MAKA_HOME: home });

  const store = createStore({ root: home });
  await store.init();
  const bus = createEventBus();

  let layout = await store.loadLayout(null);
  if (!layout || !validate(LAYOUT_SCHEMA, layout).ok) {
    if (layout) log.warn(`layout.json is invalid; starting from the default layout (the file is left untouched until the next change)`);
    layout = defaultLayout();
  }
  const layoutState = createLayoutState({ initial: layout, store, bus });

  // Optional operator files in MAKA_HOME. Invalid files are reported and ignored, never
  // silently "fixed". There is no UI to edit them in phase 1.
  const policy = await loadOrDefault(path.join(home, 'policy.json'), validatePolicy, defaultPolicy, log, 'policy.json');
  const leash = await loadOrDefault(path.join(home, 'leash.json'), validateLeash, defaultLeash, log, 'leash.json');
  const leashState = { get: () => leash };

  const runs = createRunManager({ bus, store, getLayout: layoutState.get, workspaceRoot, env, keystorePath, policy, leash });

  const app = createApp({
    bus,
    store,
    runs,
    layoutState,
    leashState,
    providerStatus: () => providerStatus({ env, keystorePath }),
    keystoreStatus: () => keystoreStatus({ env, keystorePath }),
    staticRoot: path.join(REPO_ROOT, 'frontend'),
    sharedRoot: path.join(REPO_ROOT, 'shared'),
    home,
    workspaceRoot,
  });

  const server = createHttpServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const addr = server.address();
  const url = `http://${host}:${addr.port}`;
  log.info(`Maka sidecar listening on ${url}`);
  log.info(`  data: ${home}`);
  log.info(`  workspaces: ${workspaceRoot}`);
  const providers = await providerStatus({ env, keystorePath });
  for (const [name, s] of Object.entries(providers)) {
    if (s.local) log.info(`  provider ${name}: ${s.reachable ? `reachable at ${s.host}, models: ${s.models.join(', ') || '(none installed)'}` : `not reachable at ${s.host} (start Ollama or set OLLAMA_HOST)`}`);
    else log.info(`  provider ${name}: ${s.configured ? 'key configured' : `not wired (set ${s.envVar} or add to ${keystorePath})`}`);
  }
  log.info(`  routing: worker=${policy.tiers.worker.provider}${policy.tiers.worker.model ? '/' + policy.tiers.worker.model : ''} judge=${policy.tiers.judge.provider}${policy.tiers.judge.model ? '/' + policy.tiers.judge.model : ''}`);

  async function close() {
    runs.cancel();
    await runs.waitForIdle();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }

  return { server, url, port: addr.port, home, workspaceRoot, bus, store, runs, layoutState, close };
}

async function loadOrDefault(file, validateFn, defaultFn, log, label) {
  let data = null;
  try {
    data = await readJson(file, null);
  } catch (err) {
    log.warn(`${label} could not be read (${err.message}); using defaults`);
    return defaultFn();
  }
  if (data === null) return defaultFn();
  const r = validateFn(data);
  if (!r.ok) {
    log.warn(`${label} is invalid (${r.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}); using defaults`);
    return defaultFn();
  }
  return data;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  boot().then(({ close }) => {
    const stop = () => {
      console.info('shutting down');
      close().then(() => process.exit(0));
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
