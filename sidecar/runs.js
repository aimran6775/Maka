// Run manager: starts the loop for an agent, wires the gate and permission prompts, tracks
// reconciled spend, and persists the run record through the store.
//
//   createRunManager({ bus, store, getLayout, workspaceRoot, env, keystorePath, fetch,
//                      clock, makeProvider, policy, leash | leashState, ledger, gateQueue, judge })
//     -> { start(opts), cancel(runId), answer(permissionResponse), active(), pending(), policy }
//
// Leash (phase 2 step 1): the gate for every run reads the live leash policy (leashState),
// checks daily caps against the ledger and parks draft-level actions in the Gate queue.
// When the run ends, its pending Gate items expire. `judge` (sidecar/judge.js) supplies the
// loop's review hook per run; without one, no turn is reviewed.
//
// Model choice: an explicit { provider, model } in start() wins; otherwise the router picks
// the worker tier from the policy (phase 1 runs are routine 'turn' steps). The tier is
// recorded on every cost event. One run at a time in phase 1 (docs/DECISIONS.md D3).

import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runLoop, DEFAULT_MAX_TURNS, DEFAULT_BUDGET_USD } from './loop.js';
import { createToolGate } from './capability/gate.js';
import { TOOLS } from './capability/tools.js';
import { CREW_TOOLS } from './capability/crew.js';
import { personaLines } from './agents.js';
import { createProvider as defaultMakeProvider } from './providers/provider.js';
import { createRouter, defaultPolicy } from './router.js';
import { makeEvent } from '../shared/events.js';
import { agentOf, allGrantsFor } from '../shared/world.js';
import { defaultLeash } from '../shared/leash.js';

export const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;
const FLUSH_DEBOUNCE_MS = 400;

export const DEFAULT_SYSTEM_PROMPT = [
  'You are an agent in Maka, a local desktop harness. You work inside a private workspace directory.',
  'Only the tools listed are available; a tool you do not see is not granted in your room.',
  'When something is ambiguous, ask one concrete question instead of guessing.',
  'Put finished deliverables under outbox/ in the workspace using fs.write when you have it.',
  'Keep responses concise.',
].join(' ');

export function createRunManager({
  bus,
  store,
  getLayout,
  workspaceRoot,
  env = process.env,
  keystorePath,
  fetch: fetchImpl,
  clock = { now: () => Date.now() },
  makeProvider = defaultMakeProvider,
  permissionTimeoutMs = PERMISSION_TIMEOUT_MS,
  systemPrompt = DEFAULT_SYSTEM_PROMPT,
  policy = defaultPolicy(),
  leash = defaultLeash(),
  leashState = null, // { get() } live policy; wins over the static `leash`
  ledger = null, // sidecar/leash-ledger.js
  gateQueue = null, // sidecar/gate-queue.js
  judge = null, // sidecar/judge.js
  agents = null, // sidecar/agents.js, for crew tools and personas
  registry = { ...TOOLS, ...CREW_TOOLS },
  workspaceOnline = () => true, // the watcher's view; a run never starts while offline
} = {}) {
  if (!bus || !store || typeof getLayout !== 'function' || !workspaceRoot) {
    throw new TypeError('createRunManager needs bus, store, getLayout and workspaceRoot');
  }

  const router = createRouter(policy); // throws POLICY_INVALID
  let active = null; // { runId, agentId, abort, record, flush }
  let lastDone = Promise.resolve(); // completion (including final flush) of the latest run
  const pendingPrompts = new Map(); // promptId -> { resolve, timer, runId }

  function emit(type, payload) {
    return bus.emit(makeEvent(type, payload, { ts: clock.now() }));
  }

  function workspaceFor(agentId) {
    return path.join(workspaceRoot, agentId);
  }

  async function applySpend(event) {
    const p = event.payload;
    const spend = await store.loadSpend();
    if (p.reconciled && typeof p.usd === 'number') {
      spend.totalUsd += p.usd;
      spend.reconciledTurns += 1;
      spend.byRun[p.runId] = (spend.byRun[p.runId] || 0) + p.usd;
    } else {
      spend.unreconciledTurns += 1;
    }
    await store.saveSpend(spend);
  }

  return {
    active: () => (active ? { runId: active.runId, agentId: active.agentId, startedAt: active.record.startedAt } : null),
    pending: () => [...pendingPrompts.entries()].map(([promptId, p]) => ({ promptId, runId: p.runId })),

    policy: router.policy,
    judge: () => (judge ? judge.status() : null),
    get leash() {
      return leashState ? leashState.get() : leash;
    },
    route: (step) => router.route(step),

    async start({ agentId = 'ranger', prompt, provider: providerName, model, maxTurns = DEFAULT_MAX_TURNS, budgetUsd = DEFAULT_BUDGET_USD } = {}) {
      if (active) {
        const err = new Error(`run ${active.runId} is still active`);
        err.code = 'RUN_ACTIVE';
        throw err;
      }
      if (typeof prompt !== 'string' || !prompt.trim()) {
        const err = new Error('prompt is required');
        err.code = 'BAD_REQUEST';
        throw err;
      }
      if (!workspaceOnline()) {
        const err = new Error(`workspace root ${workspaceRoot} is offline; runs are paused until it is back`);
        err.code = 'WORKSPACE_OFFLINE';
        throw err;
      }
      const layout = getLayout();
      const agentRecord = agentOf(layout, agentId);
      if (!agentRecord) {
        const err = new Error(`unknown agent "${agentId}"`);
        err.code = 'BAD_REQUEST';
        throw err;
      }
      // Explicit provider/model wins; then the agent's own worker policy; otherwise the
      // router's worker tier runs the turns.
      const routed = router.route({ kind: 'turn' });
      const own = agentRecord.policy && agentRecord.policy.worker;
      const tier = providerName ? null : routed.tier;
      const wantProvider = providerName || (own && own.provider) || routed.provider;
      const wantModel = model || (providerName ? undefined : (own && own.model) || routed.model || undefined);
      // Throws NO_KEY / NO_MODEL / OLLAMA_UNREACHABLE / UNKNOWN_PROVIDER before anything is
      // persisted or emitted.
      const { provider, model: chosenModel, price } = await makeProvider(wantProvider, { model: wantModel, env, keystorePath, fetch: fetchImpl });

      const runId = `run-${new Date(clock.now()).toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
      const workspaceDir = workspaceFor(agentId);
      await fsp.mkdir(path.join(workspaceDir, 'outbox'), { recursive: true });

      const ac = new AbortController();
      const record = {
        version: 1,
        runId,
        agentId,
        provider: provider.name,
        model: chosenModel,
        tier,
        prompt,
        maxTurns,
        budgetUsd,
        status: 'running',
        reason: null,
        startedAt: clock.now(),
        endedAt: null,
        spentUsd: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
        events: [],
        messages: null,
      };

      let flushTimer = null;
      let flushing = Promise.resolve();
      const flush = () => {
        flushing = flushing.then(() => store.saveRun(record)).catch((err) => console.error('saveRun failed:', err));
        return flushing;
      };
      const scheduleFlush = () => {
        if (flushTimer) return;
        flushTimer = setTimeout(() => {
          flushTimer = null;
          flush();
        }, FLUSH_DEBOUNCE_MS);
      };

      const stopListening = bus.listen((event) => {
        const p = event.payload;
        if (!p || p.runId !== runId) return;
        record.events.push(event);
        if (event.type === 'cost.estimate') {
          if (p.reconciled && typeof p.usd === 'number') record.spentUsd += p.usd;
          applySpend(event).catch((err) => console.error('spend update failed:', err));
        }
        if (event.type === 'agent.token') scheduleFlush();
        else flush();
      });

      const ask = ({ callId, tool, reason, input, leash: leashInfo }) =>
        new Promise((resolve) => {
          const promptId = `perm-${randomUUID().slice(0, 8)}`;
          const timer = setTimeout(() => {
            if (pendingPrompts.delete(promptId)) resolve(false);
          }, permissionTimeoutMs);
          pendingPrompts.set(promptId, { resolve, timer, runId });
          const payload = { promptId, runId, callId, tool, reason, input };
          if (leashInfo) payload.leash = leashInfo;
          emit('permission.prompt', payload);
        });

      const gate = createToolGate({
        getLayout,
        agentId,
        workspaceDir,
        fetch: fetchImpl,
        ask,
        registry,
        grants: allGrantsFor,
        toolContext: { agents },
        getLeash: () => (leashState ? leashState.get() : leash),
        ledger,
        submit: gateQueue ? { submit: (item) => gateQueue.submit({ ...item, runId, agentId }), log: (item) => gateQueue.log({ ...item, runId, agentId }) } : null,
      });

      const review = judge ? judge.forRun({ runId, agentId, gate, brief: prompt }) : null;
      active = { runId, agentId, abort: () => ac.abort(), record, flush };
      await flush();

      const finish = async (outcome) => {
        record.status = outcome.reason === 'error' ? 'error' : 'ended';
        record.reason = outcome.reason;
        record.endedAt = clock.now();
        record.usage = outcome.usage || record.usage;
        record.messages = outcome.messages || null;
        if (outcome.error) record.error = { message: outcome.error.message, code: outcome.error.code || null };
        for (const [promptId, p] of pendingPrompts) {
          if (p.runId === runId) {
            clearTimeout(p.timer);
            pendingPrompts.delete(promptId);
            p.resolve(false);
          }
        }
        if (gateQueue) await gateQueue.expireRun(runId).catch((err) => console.error('gate expire failed:', err));
        stopListening();
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        active = null;
        await flush();
      };

      // Run in the background; the caller gets the runId right away. `done` is exposed for
      // tests and for a graceful shutdown.
      const done = (async () => {
        let outcome;
        try {
          outcome = await runLoop({
            runId,
            agentId,
            provider,
            model: chosenModel,
            tier,
            system: [systemPrompt, ...personaLines(agentRecord)].join(' '),
            prompt,
            tools: gate,
            emit: (ev) => bus.emit(ev),
            clock,
            signal: ac.signal,
            maxTurns,
            budgetUsd,
            price,
            review,
          });
        } catch (err) {
          // runLoop itself failed (a bug or an emit failure). Report it as a run error.
          console.error('runLoop crashed:', err);
          try {
            emit('agent.run.error', { runId, turn: 0, message: `harness failure: ${err.message}`, code: 'HARNESS' });
          } catch {
            /* nothing more we can do */
          }
          outcome = { reason: 'error', error: err, usage: record.usage, messages: null };
        }
        await finish(outcome);
        return outcome;
      })();
      active.done = done;
      lastDone = done.catch(() => {});

      return { runId, agentId, provider: provider.name, model: chosenModel, tier, done };
    },

    cancel(runId) {
      if (!active || (runId && active.runId !== runId)) return false;
      active.abort();
      return true;
    },

    // Accepts a validated permission.response payload. Returns false if nothing was pending.
    answer({ promptId, runId, allow }) {
      const p = pendingPrompts.get(promptId);
      if (!p || p.runId !== runId) return false;
      clearTimeout(p.timer);
      pendingPrompts.delete(promptId);
      emit('permission.response', { promptId, runId, allow: Boolean(allow) });
      p.resolve(Boolean(allow));
      return true;
    },

    async waitForIdle() {
      await lastDone;
    },
  };
}
