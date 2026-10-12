// Run manager: starts the loop for an agent, wires the gate, permission prompts, the Gate
// queue and the judge, tracks reconciled spend, and persists the run record through the
// store.
//
//   createRunManager({ bus, store, getLayout, workspaceRoot, env, keystorePath, fetch,
//                      clock, makeProvider, policy, leash | leashState, ledger, gateQueue,
//                      judge, agents, maxConcurrent })
//     -> { start(opts), cancel(runId), answer(permissionResponse), active(), queued(),
//          pending(), budgetFor(agentId), policy, judge(), leash, route(), waitForIdle(),
//          onRunEnd(fn) }
//
// Concurrency (phase 2 step 4, docs/DECISIONS.md D48): N runs at once, one per agent, each
// in its own workspace `<root>/<agentId>/`. A run for a busy agent, or when `maxConcurrent`
// slots are taken, is accepted and queued (agent.run.queued) and starts when a slot frees,
// in arrival order. The model and provider are resolved when the run is queued, so a
// missing key or an unreachable Ollama is still a 400 before anything is emitted.
//
// Model choice: an explicit { provider, model } in start() wins; then `step` (a router step
// kind such as 'plan', used for the Chief Ranger's judge-tier runs); then the agent's own
// policy.worker; otherwise the router picks the worker tier. The tier is recorded on every
// cost event. Every cost.estimate on the bus, whatever emitted it, updates spend.json
// once (the per-run record keeps its own copy). The gate for every run reads the live leash policy, checks daily caps against
// the ledger and parks draft-level actions in the Gate queue; when the run ends, its
// pending Gate items expire. `judge` supplies the loop's review hook per run.

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
import { agentOf, allGrantsFor, roomOf, OBJECT_KINDS, PEAK_REFUSED_KINDS } from '../shared/world.js';
import { defaultLeash } from '../shared/leash.js';

export const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

// The grants a run gets: fixtures plus role, less every tool a connector fixture would
// grant at the Mountain Peak (safety L5: a hand-edited layout.json cannot arm the
// unjudged Chief with a money tool; the server refuses to place one there too).
export function grantsForRun(layout, agentId) {
  const base = allGrantsFor(layout, agentId);
  const agent = agentOf(layout, agentId);
  const room = agent ? roomOf(layout, agent.roomId) : null;
  if (!room || room.kind !== 'mountain_peak') return base;
  const withheld = new Set();
  for (const kind of PEAK_REFUSED_KINDS) for (const t of OBJECT_KINDS[kind].grants) withheld.add(t);
  // a tool another fixture at the Peak also grants (connector.status / sync come with every connector fixture) stays withheld: nothing a connector fixture brings is the Chief's
  return base.filter((t) => !withheld.has(t));
}
export const DEFAULT_MAX_CONCURRENT = 4;
function safeExtras(fn, agent, info) {
  if (typeof fn !== 'function') return [];
  try {
    const out = fn(agent, info);
    return Array.isArray(out) ? out.filter((x) => typeof x === 'string' && x.trim()) : [];
  } catch (err) {
    console.error('system extras failed:', err);
    return [];
  }
}
const FLUSH_DEBOUNCE_MS = 400;

export const DEFAULT_SYSTEM_PROMPT = [
  'You are an agent in Maka, a local desktop harness. You work inside a private workspace directory.',
  'Only the tools listed are available; a tool you do not see is not granted in your room.',
  'When something is ambiguous, ask one concrete question instead of guessing.',
  'Put finished deliverables under outbox/ in the workspace using fs.write when you have it.',
  'Keep responses concise.',
].join(' ');

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

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
  alwaysConfirm = [], // D180: tools the Superintendent wants a per-call card for anyway
  systemPrompt = DEFAULT_SYSTEM_PROMPT,
  systemExtras = null, // (agentRecord, { prompt, runId }) => string[] appended to the system prompt (phase 4 step 10: the Scout's memory; step 11: recalled memory)
  policy = defaultPolicy(),
  leash = defaultLeash(),
  leashState = null, // { get() } live policy; wins over the static `leash`
  ledger = null, // sidecar/leash-ledger.js
  gateQueue = null, // sidecar/gate-queue.js
  judge = null, // sidecar/judge.js
  agents = null, // sidecar/agents.js, for crew tools and personas
  registry = { ...TOOLS, ...CREW_TOOLS },
  toolContext = {}, // extra context handed to every tool (trails, mail, ... in later steps)
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
  workspaceOnline = () => true, // the watcher's view; a run never starts while offline
} = {}) {
  if (!bus || !store || typeof getLayout !== 'function' || !workspaceRoot) {
    throw new TypeError('createRunManager needs bus, store, getLayout and workspaceRoot');
  }

  const router = createRouter(policy); // throws POLICY_INVALID
  const extrasFor = (agent, info) => safeExtras(systemExtras, agent, info);
  const running = new Map(); // runId -> { runId, agentId, abort, record, flush, done }
  const queue = []; // [{ runId, agentId, launch, record, ... }] in arrival order
  const pendingPrompts = new Map(); // promptId -> { resolve, timer, runId }
  const endListeners = new Set();
  const inflight = new Set(); // persistence promises still writing (drained by waitForIdle)
  let idle = Promise.resolve();
  let idleResolve = null;

  const track = (promise) => {
    const settled = Promise.resolve(promise).catch(() => {});
    inflight.add(settled);
    settled.then(() => inflight.delete(settled));
    return promise;
  };

  function emit(type, payload) {
    return bus.emit(makeEvent(type, payload, { ts: clock.now() }));
  }
  const currentLeash = () => (leashState ? leashState.get() : leash);
  const workspaceFor = (agentId) => path.join(workspaceRoot, agentId);
  const busy = (agentId) => [...running.values()].some((r) => r.agentId === agentId) || queue.some((q) => q.agentId === agentId);

  function trackIdle() {
    if (running.size === 0 && queue.length === 0) {
      if (idleResolve) {
        idleResolve();
        idleResolve = null;
      }
    } else if (!idleResolve) {
      idle = new Promise((resolve) => {
        idleResolve = resolve;
      });
    }
  }

  let spendChain = Promise.resolve();
  function applySpend(event) {
    const p = event.payload;
    spendChain = spendChain
      .then(async () => {
        const spend = await store.loadSpend();
        if (p.reconciled && typeof p.usd === 'number') {
          spend.totalUsd += p.usd;
          spend.reconciledTurns += 1;
          spend.byRun[p.runId] = (spend.byRun[p.runId] || 0) + p.usd;
        } else {
          spend.unreconciledTurns += 1;
        }
        await store.saveSpend(spend);
      })
      .catch((err) => console.error('spend update failed:', err));
    return track(spendChain);
  }
  // One global listener: spend is a fact about the park, not about one run. Hosted worker
  // turns are counted in the ledger against their daily call cap.
  bus.listen((event) => {
    if (event.type !== 'cost.estimate') return;
    applySpend(event);
    if (event.payload.tier === 'hosted_worker' && ledger) track(ledger.recordHosted({ tokens: (event.payload.inputTokens || 0) + (event.payload.outputTokens || 0) }).catch((err) => console.error('hosted ledger failed:', err)));
  });

  // Starts queued runs while slots are free and their agents are idle.
  function pump() {
    for (let i = 0; i < queue.length; ) {
      const q = queue[i];
      if (running.size >= maxConcurrent) break;
      const agentBusy = [...running.values()].some((r) => r.agentId === q.agentId);
      if (agentBusy || !workspaceOnline()) {
        i += 1;
        continue;
      }
      queue.splice(i, 1);
      q.launch();
    }
    trackIdle();
  }

  const api = {
    policy: router.policy,
    judge: () => (judge ? judge.status() : null),
    get leash() {
      return currentLeash();
    },
    route: (step) => router.route(step),
    maxConcurrent,
    onRunEnd(fn) {
      endListeners.add(fn);
      return () => endListeners.delete(fn);
    },
    active: () => [...running.values()].map((r) => ({ runId: r.runId, agentId: r.agentId, startedAt: r.record.startedAt, workItemId: r.record.workItemId || null })),
    queued: () => queue.map((q, i) => ({ runId: q.runId, agentId: q.agentId, position: i, workItemId: q.record.workItemId || null })),
    activeFor: (agentId) => api.active().find((r) => r.agentId === agentId) || null,
    // The active run's budget and spend for an agent (safety L4: what it may delegate from).
    budgetFor(agentId) {
      const r = [...running.values()].find((x) => x.agentId === agentId);
      if (!r) return null;
      return { runId: r.runId, budgetUsd: r.record.budgetUsd, spentUsd: r.record.spentUsd || 0, startedAt: r.record.startedAt, workItemId: r.record.workItemId || null };
    },
    pending: () => [...pendingPrompts.entries()].map(([promptId, p]) => ({ promptId, runId: p.runId })),

    // `grants` (internal, never from /api/run): replaces the fixture + role grants for this
    // run; the Chief's answer to a question from a channel runs with none (phase 4 step 1).
    async start({ agentId = 'ranger', prompt, provider: providerName, model, step = null, maxTurns = DEFAULT_MAX_TURNS, budgetUsd = DEFAULT_BUDGET_USD, workItemId = null, system = null, review: wantReview = true, grants = null } = {}) {
      if (typeof prompt !== 'string' || !prompt.trim()) throw fail('BAD_REQUEST', 'prompt is required');
      if (!workspaceOnline()) throw fail('WORKSPACE_OFFLINE', `workspace root ${workspaceRoot} is offline; runs are paused until it is back`);
      const layout = getLayout();
      const agentRecord = agentOf(layout, agentId);
      if (!agentRecord) throw fail('BAD_REQUEST', `unknown agent "${agentId}"`);
      if (agentRecord.paused) throw fail('AGENT_PAUSED', `${agentId} is paused; resume it from its card first`);
      if (!Number.isInteger(maxTurns) || maxTurns < 1) throw fail('BAD_REQUEST', 'maxTurns must be a positive integer');
      if (typeof budgetUsd !== 'number' || !(budgetUsd >= 0)) throw fail('BAD_REQUEST', 'budgetUsd must be a non-negative number');

      // Explicit provider/model wins; then the agent's own worker policy; otherwise the
      // router's worker tier. Throws NO_KEY / NO_MODEL / OLLAMA_UNREACHABLE /
      // UNKNOWN_PROVIDER before anything is persisted or emitted.
      let routed = router.route({ kind: step || 'turn' });
      const own = !step && agentRecord.policy && agentRecord.policy.worker;
      let tier = providerName ? null : routed.tier;
      const wantProvider = providerName || (own && own.provider) || routed.provider;
      const wantModel = model || (providerName ? undefined : (own && own.model) || routed.model || undefined);
      const hostedCapReached = () => { const h = ledger && ledger.hostedToday(); return Boolean(h) && h.calls + (h.reserved || 0) >= router.caps().hostedWorkerCallsPerDay; }; // in-flight reservations count (safety 2026-10-11 L4)
      if ((tier === 'hosted_worker' || wantProvider === 'huggingface') && hostedCapReached()) throw fail('HOSTED_CAP', `the hosted worker reached its daily cap of ${router.caps().hostedWorkerCallsPerDay} call(s)`);
      let made;
      try {
        made = await makeProvider(wantProvider, { model: wantModel, env, keystorePath, fetch: fetchImpl });
      } catch (err) {
        // Opt-in fallback (policy.fallback.worker): a local worker that is unreachable hands
        // routine turns to the hosted worker, recorded as such (D19 stays: nothing silent).
        const fb = !providerName && !own && tier === 'worker' && err.code === 'OLLAMA_UNREACHABLE' ? router.fallbackFor('worker') : null;
        if (!fb) throw err;
        if (hostedCapReached()) throw fail('HOSTED_CAP', `ollama is unreachable and the hosted worker reached its daily cap of ${router.caps().hostedWorkerCallsPerDay} call(s)`);
        routed = router.route({ tier: fb });
        tier = fb;
        made = await makeProvider(routed.provider, { model: routed.model || undefined, env, keystorePath, fetch: fetchImpl });
      }
      const { provider, model: chosenModel, price } = made;

      const runId = `run-${new Date(clock.now()).toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
      const workspaceDir = workspaceFor(agentId);
      await fsp.mkdir(path.join(workspaceDir, 'outbox'), { recursive: true });

      const record = {
        version: 1,
        runId,
        agentId,
        provider: provider.name,
        model: chosenModel,
        tier,
        step: step || 'turn',
        prompt,
        maxTurns,
        budgetUsd,
        workItemId,
        status: 'queued',
        reason: null,
        queuedAt: clock.now(),
        startedAt: null,
        endedAt: null,
        spentUsd: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
        events: [],
        messages: null,
      };
      const ac = new AbortController();
      const entry = { runId, agentId, record, abort: () => ac.abort(), starting: false };

      entry.launch = () => {
        entry.starting = true;
        record.status = 'running';
        record.startedAt = clock.now();

        let flushTimer = null;
        let flushing = Promise.resolve();
        const flush = () => {
          flushing = flushing.then(() => store.saveRun(record)).catch((err) => console.error('saveRun failed:', err));
          return track(flushing);
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
          if (event.type === 'cost.estimate' && p.reconciled && typeof p.usd === 'number') record.spentUsd += p.usd;
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
          workspaceRoot, // D178: so `_teams/<department>/` resolves
          alwaysConfirm, // D180: tools the Superintendent wants a card for anyway
          fetch: fetchImpl,
          ask,
          registry,
          grants: typeof grants === 'function' ? grants : (l, a) => [...grantsForRun(l, a), ...(toolContext.mcp && typeof toolContext.mcp.grantsFor === 'function' ? toolContext.mcp.grantsFor(l, a) : [])],
          toolContext: { agents, runs: api, ...toolContext, brief: prompt }, // the brief reaches tools that review against it (brief.submit, memory.write)
          getLeash: currentLeash,
          ledger,
          submit: gateQueue ? { submit: (item) => gateQueue.submit({ ...item, runId, agentId }), log: (item) => gateQueue.log({ ...item, runId, agentId }) } : null,
        });
        // The Chief plans on the judge tier already; a judge reviewing the judge is spend
        // without a decision (docs/DECISIONS.md D51), so the Chief's runs skip review.
        const review = judge && wantReview && (agentRecord.role || 'ranger') !== 'chief_ranger' ? judge.forRun({ runId, agentId, gate, brief: prompt }) : null;
        const active = { runId, agentId, abort: () => ac.abort(), record, flush };
        running.set(runId, active);

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
          running.delete(runId);
          await flush();
          for (const fn of endListeners) {
            try {
              await fn({ runId, agentId, record, outcome, workspaceDir });
            } catch (err) {
              console.error('run end listener failed:', err);
            }
          }
          pump();
        };

        const done = (async () => {
          await flush();
          let outcome;
          try {
            outcome = await runLoop({
              runId,
              agentId,
              provider,
              model: chosenModel,
              tier,
              system: [system || systemPrompt, ...personaLines(agentOf(getLayout(), agentId) || agentRecord), ...extrasFor(agentOf(getLayout(), agentId) || agentRecord, { prompt, runId })].join(' '),
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
        // The run leaves `running` before its end listeners are awaited, so another run's
        // pump() can resolve `idle` while this one's listeners (the trails closing a work
        // item, say) still work; tracking the whole lifecycle keeps waitForIdle honest.
        track(done);
        active.done = done;
        entry.done = done;
        return done;
      };

      const settled = new Promise((resolve) => {
        entry.whenDone = resolve;
      });
      const wrapLaunch = entry.launch;
      entry.launch = () => wrapLaunch().then(entry.whenDone, entry.whenDone);

      queue.push(entry);
      trackIdle();
      pump();
      const queuedNow = queue.includes(entry);
      if (queuedNow) {
        const payload = { runId, agentId, position: queue.indexOf(entry) };
        if (workItemId) payload.workItemId = workItemId;
        emit('agent.run.queued', payload);
        await track(store.saveRun(record));
      }
      return { runId, agentId, provider: provider.name, model: chosenModel, tier, queued: queuedNow, done: settled.then(() => entry.done) };
    },

    // Cancels every run (active or queued) of one agent. Returns how many.
    cancelFor(agentId) {
      let n = 0;
      for (const q of queue.filter((x) => x.agentId === agentId)) {
        queue.splice(queue.indexOf(q), 1);
        cancelQueued(q);
        n += 1;
      }
      for (const r of running.values()) {
        if (r.agentId === agentId) {
          r.abort();
          n += 1;
        }
      }
      pump();
      return n;
    },

    // Cancels one run (active or queued) or, with no id, everything.
    cancel(runId) {
      if (!runId) {
        let any = false;
        for (const q of queue.splice(0)) {
          any = true;
          cancelQueued(q);
        }
        for (const r of running.values()) {
          any = true;
          r.abort();
        }
        return any;
      }
      const qi = queue.findIndex((q) => q.runId === runId);
      if (qi !== -1) {
        cancelQueued(queue.splice(qi, 1)[0]);
        pump();
        return true;
      }
      const r = running.get(runId);
      if (!r) return false;
      r.abort();
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
      await idle;
      while (inflight.size) await Promise.all([...inflight]);
    },
  };

  function cancelQueued(q) {
    q.record.status = 'ended';
    q.record.reason = 'cancelled';
    q.record.endedAt = clock.now();
    const saved = track(store.saveRun(q.record).catch((err) => console.error('saveRun failed:', err)));
    // The end event follows the persisted record so a reader of /api/runs/:id after the
    // event sees the cancellation.
    saved.then(() => {
      emit('agent.run.end', { runId: q.runId, reason: 'cancelled', turns: 0, finalText: '', usage: { inputTokens: 0, outputTokens: 0 } });
      if (q.whenDone) q.whenDone();
      trackIdle();
    });
  }

  return api;
}
