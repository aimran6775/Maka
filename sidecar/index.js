// Maka sidecar entry point: one Node process serving HTTP + SSE and the static frontend.
//
//   node sidecar/index.js
//   PORT=8790  HOST=127.0.0.1  MAKA_HOME=./.maka  MAKA_WORKSPACE=~/Maka/workspace
//   $MAKA_HOME/config.json may set { "workspaceRoot": "/Volumes/LaCie/Maka/workspace",
//   "maxConcurrentRuns": 4, "reflectAt": "07:00", "mailDomain": "makapark.com",
//   "resendRegion": "us-east-1", "mailPollMs": 60000,
//   "mailCeilings": { "perAgentPerHour": 30, "perStationPerHour": 120, "campaignRecipientsPerHour": 500 },
//   "browser": { "chromiumPath": "/Applications/Chromium.app/Contents/MacOS/Chromium", "headless": false },
//   "backup": { "enabled": true, "at": "03:00", "bucket": "maka-backups", "prefix": "maka" },
//   "connectors": { "syncEveryMs": 900000, "oauthPort": 8765, "shopify": { "shop": "lanterns.myshopify.com" },
//                   "meta_ads": { "adAccountId": "act_123", "pageId": "1234567890" }, "google_ads": { "customerId": "123-456-7890" } } };
//   the env var wins over the file for the root. The root may go away (external drive): runs pause.
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
import { createPortfolio } from './portfolio.js';
import { createCharters } from './charters.js';
import { createBlockers } from './blockers.js';
import { createScheduler } from './scheduler.js';
import { createReflect } from './reflect.js';
import { createAway } from './away.js';
import { createMailSetup } from './mail/setup.js';
import { createMailSystem } from './mail/system.js';
import { createBrowserControl } from './browser/control.js';
import { createNetGuard } from './netguard.js';
import { createConnectors } from './connectors/registry.js';
import { CONNECTOR_SPECS } from './connectors/kinds.js';
import { createResearch } from './research/index.js';
import { createCreative } from './creative/index.js';
import { createResults } from './results.js';
import { createLedgerDesk } from './ledger-desk.js';
import { createPurchases } from './purchases.js';
import { createComputerControl } from './computer/control.js';
import { createImporter } from './import/homes.js';
import { createScoutMemory } from './scout-memory.js';
import { createMemory } from './memory/index.js';
import { createRecipes } from './recipes/index.js';
import { createVoice } from './voice.js';
import { createChannels } from './channels/registry.js';
import { createTelegramAdapter } from './channels/telegram.js';
import { createIMessageAdapter } from './channels/imessage.js';
import { createDiscordAdapter } from './channels/discord.js';
import { createSlackAdapter } from './channels/slack.js';
import { createMcpManager } from './mcp/manager.js';
import { createOllama } from './ollama.js';
import { createSetup } from './setup.js';
import { createBackup } from './backup/index.js';
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
import { startOrphanWatch } from './orphan.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..');

// `restart` (optional): called when the first-run flow changes the workspace root or
// POST /api/restart is hit; the entry point below closes and boots again in-process.
export async function boot({ env = process.env, port = Number(env.PORT) || 8790, host = env.HOST || '127.0.0.1', log = console, restart = null } = {}) {
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
  let away = null;
  const gateQueue = await createGateQueue({ bus, store, ledger, leashState, getLayout: layoutState.get, isAway: () => Boolean(away && away.state().away) }).init();

  const workspace = createWorkspaceWatcher({ root: workspaceRoot, bus, onOffline: () => runs.cancel() });
  const judge = createJudge({ router: createRouter(policy), ledger, bus, env, keystorePath, log });
  const agents = createAgents({ layoutState, leashState, bus, activeRunFor: (id) => (runs ? runs.activeFor(id) : null) });
  await agents.ensureChief(); // the Chief Ranger is a singleton at the Mountain Peak (D45)
  await agents.ensureZone('visitor_center'); // the front door: deliverables walk here (D56)
  // Safety H1: every Ranger-facing network tool checks its target against this guard
  // (public internet only; never loopback, the LAN or this machine).
  const netGuard = createNetGuard();
  const toolContext = { netGuard };
  const registry = { ...TOOLS, ...CREW_TOOLS }; // chief tools join below; the gate reads it at call time
  const router = createRouter(policy);
  let scoutMemory = null;
  let recipes = null;
  let charters = null; // D184: declared here so the run manager's systemExtras can read it
  // Phase 4 step 11: Ranger memory. Items are redacted and judge-accepted before storage;
  // the top matches for a run's brief go into its system prompt; 👍 / 👎 on the Ranger card.
  const memory = await createMemory({ store, bus, agents, getLayout: layoutState.get, judge, log }).init();
  Object.assign(registry, memory.tools);
  const runs = createRunManager({ bus, store, getLayout: layoutState.get, workspaceRoot, env, keystorePath, policy, leashState, ledger, gateQueue, judge, agents, toolContext, registry, maxConcurrent: config.maxConcurrentRuns || undefined, alwaysConfirm: config.confirmTools || [], workspaceOnline: () => workspace.state().online, systemExtras: (agent, info) => [...(charters ? charters.remitLines(agent) : []), ...(recipes ? recipes.skillLines(agent) : []), ...(agent && agent.specialty === 'scout' && scoutMemory ? scoutMemory.promptLines() : []), ...(recipes ? recipes.recipeLines(agent) : []), ...memory.promptLines(agent, info || {})] });
  const trails = await createTrails({ bus, store, runs, agents, getLayout: layoutState.get, workspaceRoot }).init();
  toolContext.trails = trails;
  // Phase 4 step 12: recipes (versioned playbooks run as work items along the trails, the
  // starter library seeded from recipes/starter/) and skills on Rangers' personas.
  recipes = await createRecipes({ store, bus, trails, agents, getLayout: layoutState.get, leashState, workspaceRoot, starterDir: path.join(REPO_ROOT, 'recipes', 'starter'), log }).init();
  Object.assign(registry, recipes.tools);
  const chief = await createChief({ bus, store, runs, agents, trails, ledger, router, getLayout: layoutState.get, workspaceRoot, log }).init();
  Object.assign(registry, chief.tools);
  // D182: the portfolio. The park proposes a business, the owner approves it at the
  // Entrance Gate, and that approval is what starts it — `onApproved` hands the approved
  // venture to the Chief to staff and begin. The portfolio records the decision and the
  // money; it does none of the work itself.
  const portfolio = await createPortfolio({
    bus,
    store,
    gateQueue,
    ceilingUsd: typeof config.portfolioCeilingUsd === 'number' ? config.portfolioCeilingUsd : undefined,
    onApproved: (venture) => chief.startVenture(venture),
    log,
  }).init();
  Object.assign(registry, portfolio.tools);
  // D185: the park runs itself, and when it cannot it says so from the Peak. Clearing a
  // blocker tells the Chief, so the work that was waiting starts again instead of waiting
  // for someone to remember it.
  const blockers = await createBlockers({
    bus,
    store,
    agents,
    getLayout: layoutState.get,
    onResolved: (b) => chief.blockerCleared(b),
    log,
  }).init();
  Object.assign(registry, blockers.tools);
  // D183: work that belongs to a venture draws on the budget the owner approved for that
  // business, not on the single mission budget. Only an active venture has a pool: a
  // paused or stopped one funds nothing.
  if (typeof trails.setVentureBudget === 'function') {
    trails.setVentureBudget((ventureId) => {
      const v = portfolio.get(ventureId);
      return v && v.status === 'active' ? { budgetUsd: v.budgetUsd, createdAt: v.startedAt || v.decidedAt || 0 } : null;
    });
  }
  const scheduler = await createScheduler({ store, log }).init();
  // D184: department charters — a standing remit each head carries into every run, and
  // duties the scheduler hands it on a cadence, so the park works unwatched. Each duty is
  // bounded by its own budget and its department's daily cap, and nothing above the judge's
  // own daily cap runs at all.
  charters = await createCharters({
    bus,
    store,
    scheduler,
    trails,
    agents,
    getLayout: layoutState.get,
    ledger,
    judgeCap: () => {
      const caps = router.caps();
      const today = ledger ? ledger.judgeToday() : null;
      if (!today) return null;
      if (today.usd >= caps.judgeUsdPerDay) return `the park's judge daily cap is reached ($${today.usd.toFixed(2)} of $${caps.judgeUsdPerDay})`;
      return null;
    },
    log,
  }).init();
  Object.assign(registry, charters.tools);
  let connectors = null;
  // Phase 4 step 9: the results engine reads the ledgers and the connector stores; the
  // reflection rolls it up first and reads the Chief rules' verdicts from it.
  const results = await createResults({ bus, store, agents, trails, chief, ledger, gateQueue, getConnectors: () => connectors, getMail: () => mail, getLayout: layoutState.get, log }).init();
  // Phase 4 step 16: the Ledger desk grants ledger.read, a read of the engine's rows and today's ledger.
  Object.assign(registry, createLedgerDesk({ results, ledger, getLayout: layoutState.get }).tools);
  const reflect = await createReflect({ bus, store, runs, agents, trails, chief, ledger, gateQueue, router, scheduler, getLayout: layoutState.get, workspaceRoot, env, keystorePath, schedule: { daily: config.reflectAt || '07:00' }, getConnectors: () => connectors, getMail: () => mail, getResults: () => results, log }).init();
  scheduler.start();
  away = await createAway({ bus, store, gateQueue, workspaceRoot, log }).init();
  const mailSetup = createMailSetup({ bus, gateQueue, env, keystorePath, domain: config.mailDomain || undefined, region: config.resendRegion || undefined, log });
  const mail = await createMailSystem({ bus, store, scheduler, getLayout: layoutState.get, env, keystorePath, workspaceRoot, domain: config.mailDomain || undefined, pollMs: config.mailPollMs || undefined, ceilings: config.mailCeilings || {}, router, ledger, log }).init();
  Object.assign(registry, mail.tools);
  toolContext.mail = mail;
  const browser = await createBrowserControl({ bus, env, workspaceRoot, config: config.browser || {}, netGuard, log }).init();
  Object.assign(registry, browser.tools);
  toolContext.browser = browser;
  connectors = createConnectors({ bus, store, scheduler, gateQueue, env, keystorePath, config: config.connectors || {}, log });
  for (const spec of CONNECTOR_SPECS) connectors.define(spec);
  await connectors.init();
  Object.assign(registry, connectors.tools);
  toolContext.connectors = connectors;
  // Phase 4 step 17: supplier purchases through the browser, the amount held in the ledger.
  const purchases = await createPurchases({ bus, store, trails, ledger, browser, getLayout: layoutState.get, getConnectors: () => connectors, knownVentures: () => (chief.state().plan ? chief.state().plan.ventures.map((v) => v.id) : []), netGuard, workspaceRoot, log }).init();
  Object.assign(registry, purchases.tools);
  // Phase 4 step 18: this Mac through the shell's socket; not wired without the app.
  const computer = await createComputerControl({ bus, env, workspaceRoot, ownHosts: [`${host}:${port}`, `localhost:${port}`], log }).init();
  Object.assign(registry, computer.tools);
  // Phase 4 step 19: another agent's home (OpenClaw, Hermes) imported as a Ranger.
  const importer = createImporter({ agents, memory, skills: recipes, getLayout: layoutState.get, workspaceRoot, bus, log });
  // A finished connector sync or work item rolls the day up (debounced), so the Peak's
  // results follow the syncs without a reflection.
  let rollupTimer = null;
  bus.listen((event) => {
    if (!((event.type === 'connector.sync' && event.payload.status === 'done') || event.type === 'work.done')) return;
    clearTimeout(rollupTimer);
    rollupTimer = setTimeout(() => results.rollup({ reason: event.type === 'work.done' ? 'work.done' : `sync ${event.payload.connector}` }).catch((err) => log.error('results rollup failed:', err)), 1500);
    if (rollupTimer.unref) rollupTimer.unref();
  });
  // Phase 4 step 10: the Scout's memory: every brief recorded, joined to the results engine's
  // actuals, the scored history in the Scout's prompt and the judge's review; the Chief's
  // go / no-go through brief.decide.
  scoutMemory = await createScoutMemory({ store, bus, getResults: () => results, log }).init();
  Object.assign(registry, scoutMemory.tools);
  const research = createResearch({ env, keystorePath, judge, memory: scoutMemory, workspaceRoot });
  // Phase 4 step 8: ad copy and images as outbox deliverables; images through Hugging Face
  // under the hosted worker cap, the judge checks every prompt for faces and logos first.
  const creative = createCreative({ env, keystorePath, netGuard, judge, ledger, caps: router.caps(), bus, workspaceRoot, config: config.creative || {}, log });
  // Phase 4 step 4: MCP servers configured at the Peak; their tools reach Rangers through
  // Outposts. HTTP servers go through the outbound guard like every other network path.
  // Phase 4 step 14: voice. Recognition happens in the shell (on device) or, outside it, in
  // the browser with the sidecar relaying audio to Hugging Face; the sidecar keeps text only.
  const voice = createVoice({ env, keystorePath, netGuard, ledger, caps: router.caps(), bus, model: config.voice && config.voice.asrModel, log });
  const mcp = await createMcpManager({ bus, store, gateQueue, env, keystorePath, netGuard, registry, getLayout: layoutState.get, oauthPort: (config.connectors && config.connectors.oauthPort) || undefined, log }).init();
  toolContext.mcp = mcp;
  layoutState.setObjectCheck((o) => mcp.checkPlacement(o));
  // Phase 4 step 1: the owner channels. Adapters (Telegram, Discord, Slack) register here
  // as they arrive; a channel whose token is not wired says so at the Peak.
  const channels = await createChannels({ bus, store, gateQueue, chief, reflect, away, blockers, env, keystorePath, log, permissions: { answer: (a) => runs.answer(a) } }).init();
  // D170: iMessage first — the owner's channel on their own Mac, no bot, no token.
  if (process.platform === 'darwin') channels.register(createIMessageAdapter({ log }));
  channels.register(createTelegramAdapter({ netGuard, log })); // step 2: TELEGRAM_BOT_TOKEN or the keystore
  channels.register(createDiscordAdapter({ netGuard, log })); // step 3: DISCORD_BOT_TOKEN
  channels.register(createSlackAdapter({ netGuard, log })); // step 3: SLACK_BOT_TOKEN + SLACK_APP_TOKEN
  await channels.start();
  Object.assign(registry, research.tools);
  toolContext.judge = judge;
  Object.assign(registry, creative.tools);
  const backup = await createBackup({ store, scheduler, bus, home, workspaceRoot, env, keystorePath, config: config.backup || {}, log }).init();
  // D191: `ollamaModels` in config.json says where the weights live (the LaCie here), and
  // the park passes it to the server it starts.
  const ollama = createOllama({ env, bus, modelsPath: env.OLLAMA_MODELS || config.ollamaModels || null, log });
  ollama.status().catch(() => {});
  const setup = await createSetup({ home, configPath: path.join(home, 'config.json'), workspaceRoot, env, keystorePath, bus, ollama, chief, agents, providerStatus: () => providerStatus({ env, keystorePath, probeLocal: false }), restart, log }).init();
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
    portfolio,
    charters,
    blockers,
    reflect,
    away,
    mailSetup,
    mail,
    browser,
    connectors,
    channels,
    mcp,
    research,
    creative,
    results,
    purchases,
    computer,
    importer,
    scoutMemory,
    memory,
    recipes,
    voice,
    setup,
    ollama,
    backup,
    restart,
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
  if (away.state().away) log.info(`  away since ${new Date(away.state().since).toISOString()}: ${away.state().actions} action(s) so far, ${away.state().waiting} waiting`);
  const mailStatus = await mailSetup.status();
  const mailSys = await mail.status();
  const connectorRows = connectors.list();
  log.info(`  connectors: ${connectorRows.length ? connectorRows.map((c) => `${c.label} ${c.connected ? `connected (${c.by})` : 'not connected'}`).join(' · ') : 'none defined yet'}`);
  const mcpRows = mcp.list();
  log.info(`  mcp: ${mcpRows.length ? mcpRows.map((s) => `${s.label} ${s.status}${s.status === 'connected' ? ` (${s.tools.length} tool(s))` : ''}`).join(' · ') : 'no servers configured (add one at the Peak)'}`);
  const channelRows = channels.list();
  log.info(`  channels: ${channelRows.length ? channelRows.map((c) => `${c.label} ${c.status === 'up' ? `up (${c.by}${c.detail ? `, ${c.detail}` : ''})` : c.status === 'not_wired' ? `not wired (${c.missing.join(', ')})` : c.status}, ${c.paired.length} paired chat(s)`).join(' · ') : 'none registered yet'}`);
  const researchStatus = await research.status();
  log.info(`  research: search via ${researchStatus.search} · trends ${researchStatus.trends.join(', ')}`);
  const creativeStatus = await creative.status();
  log.info(`  creative: images via ${creativeStatus.images}${creativeStatus.imageKey ? ` (${creativeStatus.model})` : ''} · judge ${creativeStatus.judge ? 'checks prompts and copy' : 'not wired: no images'}`);
  const browserStatus = await browser.status();
  log.info(`  browser: ${browserStatus.chromium ? `${browserStatus.chromium} (${browserStatus.headless ? 'headless' : 'windowed'})` : 'not wired (no Chromium found; set browser.chromiumPath or CHROMIUM)'}`);
  log.info(`  mail: ${mailStatus.domain} · resend ${mailStatus.keys.resend ? 'key configured' : 'not wired (RESEND_API_KEY)'} · cloudflare ${mailStatus.keys.cloudflare ? 'token configured' : 'not wired (CLOUDFLARE_API_TOKEN)'} · webhook ${mailSys.keys.webhook ? 'secret configured' : 'not wired (RESEND_WEBHOOK_SECRET)'} · ${mailSys.addresses} address(es), ${mailSys.counts.messages} message(s), poll every ${mailSys.sync.pollMs / 1000}s`);
  const resultsNow = results.summary();
  log.info(`  results: ${resultsNow.lastRollup ? `last rollup ${new Date(resultsNow.lastRollup.at).toISOString()} (${resultsNow.lastRollup.reason})` : 'no rollup yet'} · sources: ${Object.entries(resultsNow.sources).filter(([, v]) => v).map(([k]) => k).join(', ') || 'ledgers only (no connector synced)'}`);
  const voiceStatus = await voice.status();
  log.info(`  voice: recognition outside the app via ${voiceStatus.asr}${voiceStatus.asrKey ? ` (${voiceStatus.model})` : ''} · in the app: ${voiceStatus.shell}`);
  const rec = recipes.summary();
  log.info(`  recipes: ${rec.recipes} recipe(s), ${rec.skills} skill(s), ${rec.grants} grant(s) · runs: ${rec.runs.running} running, ${rec.runs.done} done, ${rec.runs.failed} failed`);
  const mem = memory.summary();
  log.info(`  memory: ${mem.items} item(s) (${mem.byScope.agent} agent, ${mem.byScope.venture} venture, ${mem.byScope.station} station; ${mem.muted} muted) · writes ${mem.judge ? 'accepted by the judge' : 'refused: no judge wired'}`);
  const sm = scoutMemory.summary();
  log.info(`  scout memory: ${sm.totals.briefs} brief(s) recorded (${sm.totals.go} go, ${sm.totals.noGo} no-go, ${sm.totals.decided} decided by the Chief, ${sm.totals.joined} joined to results)`);
  log.info(`  reflection: daily at ${config.reflectAt || '07:00'}, next ${new Date(scheduler.state().reflection.nextRunAt).toISOString()}${reflect.latest() ? `, last ${reflect.latest().id} (${reflect.latest().status})` : ', none yet'}`);
  log.info(`  routing: worker=${policy.tiers.worker.provider}${policy.tiers.worker.model ? '/' + policy.tiers.worker.model : ''} judge=${judge.route.provider}/${judge.route.model || 'default'} (cap $${judge.caps.judgeUsdPerDay}/day, $${ledger.judgeToday().usd.toFixed(2)} used today)`);

  async function close() {
    clearTimeout(rollupTimer);
    scheduler.stop();
    backup.close();
    workspace.stop();
    runs.cancel();
    await runs.waitForIdle();
    await browser.close();
    await connectors.close();
    await channels.close();
    await mcp.close();
    await results.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }

  const backupStatus = await backup.status();
  log.info(`  backup: ${backupStatus.wired ? `R2 bucket ${backupStatus.bucket} under ${backupStatus.prefix}/` : `not wired (${backupStatus.missing.join(', ')})`} · ${backupStatus.enabled ? `daily at ${backupStatus.at}` : 'disabled'}${backupStatus.last ? ` · last ${backupStatus.last.status} ${new Date(backupStatus.last.at).toISOString()}` : ''}`);
  const setupState = await setup.state();
  log.info(`  first run: ${setupState.firstRun ? 'yes (the park shows the first-run card)' : `done ${new Date(setupState.completedAt).toISOString()}${setupState.skipped ? ' (skipped)' : ''}`} · worker ${ollama.summary().worker}`);

  return { server, url, port: addr.port, home, workspaceRoot, bus, store, runs, layoutState, leashState, ledger, gateQueue, agents, trails, chief, scheduler, reflect, away, mailSetup, mail, browser, connectors, channels, mcp, research, results, scoutMemory, memory, recipes, voice, setup, ollama, backup, close };
}

function validateConfig(data) {
  return validate({ type: 'object', additionalProperties: false, properties: { workspaceRoot: { type: 'string', minLength: 1 }, ollamaModels: { type: 'string', minLength: 1 }, confirmTools: { type: 'array', items: { type: 'string', minLength: 1 } }, portfolioCeilingUsd: { type: 'number', minimum: 0 }, maxConcurrentRuns: { type: 'integer', minimum: 1 }, reflectAt: { type: 'string', pattern: '^\\d{1,2}:\\d{2}$' }, mailDomain: { type: 'string', minLength: 1 }, resendRegion: { type: 'string', minLength: 1 }, mailPollMs: { type: 'integer', minimum: 5000 }, mailCeilings: { type: 'object', additionalProperties: false, properties: { perAgentPerHour: { type: 'integer', minimum: 0 }, perStationPerHour: { type: 'integer', minimum: 0 }, campaignRecipientsPerHour: { type: 'integer', minimum: 0 } } }, browser: { type: 'object', additionalProperties: false, properties: { chromiumPath: { type: 'string', minLength: 1 }, headless: { type: 'boolean' } } }, backup: { type: 'object', additionalProperties: false, properties: { enabled: { type: 'boolean' }, at: { type: 'string', pattern: '^\\d{1,2}:\\d{2}$' }, bucket: { type: 'string', minLength: 3 }, prefix: { type: 'string', minLength: 1 } } }, creative: { type: 'object', additionalProperties: false, properties: { imageModel: { type: 'string', minLength: 1 } } }, voice: { type: 'object', additionalProperties: false, properties: { asrModel: { type: 'string', minLength: 1 } } }, connectors: { type: 'object', additionalProperties: true, properties: { syncEveryMs: { type: 'integer', minimum: 60000 }, oauthPort: { type: 'integer', minimum: 0, maximum: 65535 }, shopify: { type: 'object', additionalProperties: false, properties: { shop: { type: 'string', minLength: 1 } } }, meta_ads: { type: 'object', additionalProperties: false, properties: { adAccountId: { type: 'string', minLength: 1 }, pageId: { type: 'string', minLength: 1 } } }, google_ads: { type: 'object', additionalProperties: false, properties: { customerId: { type: 'string', minLength: 1 }, loginCustomerId: { type: 'string', minLength: 1 } } } } } } }, data);
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
  // The entry point can restart the sidecar in-process (the first-run flow's workspace
  // change): close everything, boot again on the same port, keep the process and its
  // environment (the shell's credential broker handle included).
  startOrphanWatch();
  let app = null;
  let restarting = false;
  const restart = () => {
    if (restarting || !app) return;
    restarting = true;
    setTimeout(async () => {
      console.info('restarting the sidecar in-process');
      try {
        await app.close();
        app = await boot({ restart });
      } catch (err) {
        console.error('restart failed:', err);
        process.exit(1);
      } finally {
        restarting = false;
      }
    }, 150);
  };
  boot({ restart }).then((booted) => {
    app = booted;
    const stop = () => {
      console.info('shutting down');
      (app ? app.close() : Promise.resolve()).then(() => process.exit(0));
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
