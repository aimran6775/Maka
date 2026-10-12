// On-disk persistence with atomic writes.
//
// Every write goes: temp file in the target directory → fsync(file) → rename → fsync(dir).
// A crash at any point leaves either the old file or the new file, never a torn one.
//
// Layout on disk (root = MAKA_HOME or ./.maka):
//   layout.json            the world layout (shared/world.js LAYOUT_SCHEMA)
//   spend.json             reconciled spend totals
//   leash.json             the leash policy (shared/leash.js); also the operator file
//   leash-ledger.json      daily per-domain action totals, approval streaks, judge spend
//   gate-items.json        the Entrance Gate queue (recent items, pending first)
//   work-items.json        delegated work items (trails)
//   mission.json           the Superintendent's mission to the Chief Ranger
//   plan.json              the Chief Ranger's current plan (every version kept)
//   scheduler.json         last run / next run per scheduled job
//   away.json              away mode: flag, since, counters, last digest
//   mail-addresses.json    mail routing rules (station addresses, Ranger aliases)
//   channels.json          owner channels: the pairing code and the paired chats (phase 4)
//   mcp-servers.json       MCP servers configured at the Peak (no secret values; phase 4)
//   recipe-runs.json       recipe runs: the steps' work items and outcomes (phase 4 step 12)
//   memory.json            Ranger memory items: facts, preferences, procedures per agent / venture / station (phase 4 step 11)
//   scout-memory.json      every venture brief with its estimates, the Chief's go / no-go (phase 4 step 10)
//   results.json           the results engine: daily rollups, model spend by day / agent / tier,
//                          attribution of connector objects to ventures (phase 4 step 9)
//   connectors/<kind>.json what a connector's last syncs brought in (phase 2 step 14)
//   reflections/<id>.json  reflection documents (the Peak's history)
//   runs/<runId>.json      one record per run: metadata + every event + final messages

import { promises as fsp } from 'node:fs';
import path from 'node:path';

export async function writeJsonAtomic(file, data, { fs = fsp } = {}) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  const handle = await fs.open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(JSON.stringify(data, null, 2) + '\n', 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  // fsync the directory so the rename itself is durable.
  let dh = null;
  try {
    dh = await fs.open(dir, 'r');
    await dh.sync();
  } catch {
    // Some platforms refuse to fsync a directory; the rename is still atomic.
  } finally {
    if (dh) await dh.close();
  }
}

export async function readJson(file, fallback, { fs = fsp } = {}) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

const RUN_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export function createStore({ root, fs = fsp }) {
  if (!root) throw new TypeError('createStore needs root');
  const layoutFile = path.join(root, 'layout.json');
  const spendFile = path.join(root, 'spend.json');
  const leashFile = path.join(root, 'leash.json');
  const ledgerFile = path.join(root, 'leash-ledger.json');
  const gateFile = path.join(root, 'gate-items.json');
  const workFile = path.join(root, 'work-items.json');
  const missionFile = path.join(root, 'mission.json');
  // D182: the portfolio — every venture the park has been asked to run, each with its own
  // state and budget, so the park is not one mission at a time.
  const portfolioFile = path.join(root, 'portfolio.json');
  const planFile = path.join(root, 'plan.json');
  const schedulerFile = path.join(root, 'scheduler.json');
  const awayFile = path.join(root, 'away.json');
  const mailAddressesFile = path.join(root, 'mail-addresses.json');
  const channelsFile = path.join(root, 'channels.json');
  const mcpFile = path.join(root, 'mcp-servers.json');
  const resultsFile = path.join(root, 'results.json');
  const scoutMemoryFile = path.join(root, 'scout-memory.json');
  const memoryFile = path.join(root, 'memory.json');
  const recipeRunsFile = path.join(root, 'recipe-runs.json');
  const purchasesFile = path.join(root, 'purchases.json');
  const reflectionsDir = path.join(root, 'reflections');
  const runsDir = path.join(root, 'runs');

  const runFile = (runId) => {
    if (!RUN_ID_RE.test(runId)) throw new Error(`bad runId ${runId}`);
    return path.join(runsDir, `${runId}.json`);
  };

  return {
    root,
    async init() {
      await fs.mkdir(runsDir, { recursive: true });
      await fs.mkdir(reflectionsDir, { recursive: true });
    },
    loadScheduler: (fallback) => readJson(schedulerFile, fallback, { fs }),
    loadAway: (fallback) => readJson(awayFile, fallback, { fs }),
    loadMailAddresses: (fallback) => readJson(mailAddressesFile, fallback, { fs }),
    saveMailAddresses: (rules) => writeJsonAtomic(mailAddressesFile, rules, { fs }),
    loadChannels: (fallback) => readJson(channelsFile, fallback, { fs }),
    saveChannels: (state) => writeJsonAtomic(channelsFile, state, { fs }),
    loadMcpServers: (fallback) => readJson(mcpFile, fallback, { fs }),
    loadResults: (fallback) => readJson(resultsFile, fallback, { fs }),
    loadScoutMemory: (fallback) => readJson(scoutMemoryFile, fallback, { fs }),
    loadMemory: (fallback) => readJson(memoryFile, fallback, { fs }),
    loadRecipeRuns: (fallback) => readJson(recipeRunsFile, fallback, { fs }),
    loadPurchases: (fallback) => readJson(purchasesFile, fallback, { fs }),
    savePurchases: (state) => writeJsonAtomic(purchasesFile, state, { fs }),
    saveRecipeRuns: (state) => writeJsonAtomic(recipeRunsFile, state, { fs }),
    saveMemory: (state) => writeJsonAtomic(memoryFile, state, { fs }),
    saveScoutMemory: (state) => writeJsonAtomic(scoutMemoryFile, state, { fs }),
    saveResults: (state) => writeJsonAtomic(resultsFile, state, { fs }),
    saveMcpServers: (state) => writeJsonAtomic(mcpFile, state, { fs }),
    loadConnector: (kind, fallback) => readJson(path.join(root, 'connectors', `${kind}.json`), fallback, { fs }),
    saveConnector: (kind, data) => writeJsonAtomic(path.join(root, 'connectors', `${kind}.json`), data, { fs }),
    saveAway: (state) => writeJsonAtomic(awayFile, state, { fs }),
    saveScheduler: (state) => writeJsonAtomic(schedulerFile, state, { fs }),
    saveReflection: (doc) => {
      if (!RUN_ID_RE.test(doc.id)) throw new Error(`bad reflection id ${doc.id}`);
      return writeJsonAtomic(path.join(reflectionsDir, `${doc.id}.json`), doc, { fs });
    },
    loadReflection: (id) => (RUN_ID_RE.test(id) ? readJson(path.join(reflectionsDir, `${id}.json`), null, { fs }) : Promise.resolve(null)),
    async listReflections() {
      let names = [];
      try {
        names = await fs.readdir(reflectionsDir);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      const out = [];
      for (const name of names) {
        if (!name.endsWith('.json') || name.startsWith('.')) continue;
        const doc = await readJson(path.join(reflectionsDir, name), null, { fs });
        if (doc) out.push({ id: doc.id, at: doc.at, reason: doc.reason, status: doc.status, missionId: doc.missionId || null, portfolio: (doc.portfolio || '').slice(0, 300), ventures: (doc.ventures || []).map((v) => v.id), usd: doc.usd ?? null });
      }
      out.sort((a, b) => b.at - a.at);
      return out;
    },
    loadLayout: (fallback) => readJson(layoutFile, fallback, { fs }),
    saveLayout: (layout) => writeJsonAtomic(layoutFile, layout, { fs }),
    loadSpend: () => readJson(spendFile, { version: 1, totalUsd: 0, reconciledTurns: 0, unreconciledTurns: 0, byRun: {} }, { fs }),
    saveSpend: (spend) => writeJsonAtomic(spendFile, spend, { fs }),
    loadLeash: (fallback) => readJson(leashFile, fallback, { fs }),
    saveLeash: (leash) => writeJsonAtomic(leashFile, leash, { fs }),
    loadLeashLedger: (fallback) => readJson(ledgerFile, fallback, { fs }),
    saveLeashLedger: (ledger) => writeJsonAtomic(ledgerFile, ledger, { fs }),
    loadGateItems: (fallback) => readJson(gateFile, fallback, { fs }),
    saveGateItems: (items) => writeJsonAtomic(gateFile, items, { fs }),
    loadWorkItems: (fallback) => readJson(workFile, fallback, { fs }),
    saveWorkItems: (items) => writeJsonAtomic(workFile, items, { fs }),
    loadMission: (fallback) => readJson(missionFile, fallback, { fs }),
    saveMission: (mission) => writeJsonAtomic(missionFile, mission, { fs }),
    loadPortfolio: (fallback) => readJson(portfolioFile, fallback, { fs }),
    savePortfolio: (portfolio) => writeJsonAtomic(portfolioFile, portfolio, { fs }),
    loadPlan: (fallback) => readJson(planFile, fallback, { fs }),
    savePlan: (plan) => writeJsonAtomic(planFile, plan, { fs }),
    saveRun: async (record) => writeJsonAtomic(runFile(record.runId), record, { fs }),
    loadRun: async (runId) => readJson(runFile(runId), null, { fs }),
    async listRuns() {
      let names = [];
      try {
        names = await fs.readdir(runsDir);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      const out = [];
      for (const name of names) {
        if (!name.endsWith('.json') || name.startsWith('.')) continue;
        const rec = await readJson(path.join(runsDir, name), null, { fs });
        if (rec) {
          out.push({
            runId: rec.runId,
            agentId: rec.agentId,
            provider: rec.provider,
            model: rec.model,
            status: rec.status,
            reason: rec.reason || null,
            startedAt: rec.startedAt,
            endedAt: rec.endedAt || null,
            prompt: rec.prompt,
            spentUsd: rec.spentUsd || 0,
          });
        }
      }
      out.sort((a, b) => b.startedAt - a.startedAt);
      return out;
    },
  };
}
