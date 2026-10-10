// Maka sidecar entry point: one Node process serving HTTP + SSE and the static frontend.
//
//   node sidecar/index.js
//   PORT=8790  HOST=127.0.0.1  MAKA_HOME=./.maka  MAKA_WORKSPACE=~/Maka/workspace
//   $MAKA_HOME/config.json may set { "workspaceRoot": "/Volumes/LaCie/Maka/workspace",
//   "maxConcurrentRuns": 4 }; the env var wins over the file for the root. The root may go away (external drive): runs pause.
//
// Everything here is wiring; behaviour lives in loop.js, capability/, providers/, runs.js,
// server.js and store.js, all of which are tested with fakes.

import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { createStore } from './store.js';
import { createWorkspaceWatcher } from './workspace.js';
import { createEventBus } from './bus.js';
import { createRunManager } from './runs.js';
import { createLeashLedger, createLeashState } from './leash-ledger.js';
import { createGateQueue } from './gate-queue.js';
import { createJudge } from './judge.js';
import { createAgents } from './agents.js';
import { createTrails } from './trails.js';
import { createChief } from './chief.js';
import { TOOLS } from './capability/tools.js';
import { CREW_TOOLS } from './capability/crew.js';
import { createRouter } from './router.js';
import { createApp, createHttpServer, createLayoutState } from './server.js';
import { providerStatus } from './providers/provider.js';
import { keystoreStatus, defaultKeystorePath } from './providers/keys.js';
import { defaultLayout, LAYOUT_SCHEMA, DEFAULT_SEED } from '../shared/world.js';
import { defaultLeash, validateLeash } from '../shared/leash.js';
import { defaultPolicy, validatePolicy } from './router.js';
import { validate } from '../shared/schema.js';
import { readJson } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..');

export async function boot({ env = process.env, port = Number(env.PORT) || 8790, host = env.HOST || '127.0.0.1', log = console } = {}) {
  const home = path.resolve(env.MAKA_HOME || path.join(process.cwd(), '.maka'));
  const keystorePath = defaultKeystorePath({ MAKA_HOME: home });
  const config = await loadOrDefault(path.join(home, 'config.json'), validateConfig, () => ({}), log, 'config.json');
  const workspaceRoot = path.resolve(env.MAKA_WORKSPACE || config.workspaceRoot || path.join(os.homedir(), 'Maka', 'workspace'));

  const store = createStore({ root: home });
  await store.init();
  const bus = createEventBus();

  let layout = await store.loadLayout(null);
  if (!layout || !validate(LAYOUT_SCHEMA, layout).ok) {
    if (layout) log.warn(`layout.json is invalid; starting from the default layout (the file is left untouched until the next change)`);
    layout = defaultLayout();
  }
  if (!layout.seed) layout = { ...layout, seed: DEFAULT_SEED };
  const layoutState = createLayoutState({ initial: layout, store, bus });

  // Optional operator files in MAKA_HOME. Invalid files are reported and ignored, never
  // silently "fixed". There is no UI to edit them in phase 1.
  const policy = await loadOrDefault(path.join(home, 'policy.json'), validatePolicy, defaultPolicy, log, 'policy.json');
  const leash = await loadOrDefault(path.join(home, 'leash.json'), validateLeash, defaultLeash, log, 'leash.json');
  // leash.json is both the operator file and where approved loosening proposals land.
  const leashState = createLeashState({ initial: leash, store });
  const ledger = await createLeashLedger({ store, earnApprovals: leash.earn && leash.earn.approvals }).init();
  const gateQueue = await createGateQueue({ bus, store, ledger, leashState, getLayout: layoutState.get }).init();

  const workspace = createWorkspaceWatcher({ root: workspaceRoot, bus, onOffline: () => runs.cancel() });
  const judge = createJudge({ router: createRouter(policy), ledger, bus, env, keystorePath, log });
  const agents = createAgents({ layoutState, leashState, bus, activeRunFor: (id) => (runs ? runs.activeFor(id) : null) });
  await agents.ensureChief(); // the Chief Ranger is a singleton at the Mountain Peak (D45)
  const toolContext = {};
  const registry = { ...TOOLS, ...CREW_TOOLS }; // chief tools join below; the gate reads it at call time
  const router = createRouter(policy);
  const runs = createRunManager({ bus, store, getLayout: layoutState.get, workspaceRoot, env, keystorePath, policy, leashState, ledger, gateQueue, judge, agents, toolContext, registry, maxConcurrent: config.maxConcurrentRuns || undefined, workspaceOnline: () => workspace.state().online });
  const trails = await createTrails({ bus, store, runs, agents, getLayout: layoutState.get, workspaceRoot }).init();
  toolContext.trails = trails;
  const chief = await createChief({ bus, store, runs, agents, trails, ledger, router, getLayout: layoutState.get, workspaceRoot, log }).init();
  Object.assign(registry, chief.tools);
  try {
    await fsp.mkdir(workspaceRoot, { recursive: true });
  } catch (err) {
    log.warn(`workspace root ${workspaceRoot} cannot be created (${err.message}); runs stay paused until it exists`);
  }
  await workspace.start();

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
    workspace,
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
  log.info(`  workspaces: ${workspaceRoot} (${workspace.state().online ? 'online' : `OFFLINE: ${workspace.state().reason}`})`);
  const providers = await providerStatus({ env, keystorePath });
  for (const [name, s] of Object.entries(providers)) {
    if (s.local) log.info(`  provider ${name}: ${s.reachable ? `reachable at ${s.host}, models: ${s.models.join(', ') || '(none installed)'}` : `not reachable at ${s.host} (start Ollama or set OLLAMA_HOST)`}`);
    else log.info(`  provider ${name}: ${s.configured ? 'key configured' : `not wired (set ${s.envVar} or add to ${keystorePath})`}`);
  }
  log.info(`  gate: ${gateQueue.pending().length} item(s) waiting; leash day ${ledger.dayKey()}`);
  log.info(`  crew: ${agents.list().map((a) => `${a.name} (${a.role})`).join(', ')}; up to ${runs.maxConcurrent} runs at once`);
  log.info(`  routing: worker=${policy.tiers.worker.provider}${policy.tiers.worker.model ? '/' + policy.tiers.worker.model : ''} judge=${judge.route.provider}/${judge.route.model || 'default'} (cap $${judge.caps.judgeUsdPerDay}/day, $${ledger.judgeToday().usd.toFixed(2)} used today)`);

  async function close() {
    workspace.stop();
    runs.cancel();
    await runs.waitForIdle();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }

  return { server, url, port: addr.port, home, workspaceRoot, bus, store, runs, layoutState, leashState, ledger, gateQueue, agents, trails, chief, close };
}

function validateConfig(data) {
  return validate({ type: 'object', additionalProperties: false, properties: { workspaceRoot: { type: 'string', minLength: 1 }, maxConcurrentRuns: { type: 'integer', minimum: 1 } } }, data);
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
