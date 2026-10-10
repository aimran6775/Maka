// Frontend state: a pure reducer over validated events plus the /api/state snapshot.
// No DOM here, so it is tested with node --test (test/frontend-state.test.js).
//
// Truthful telemetry rules enforced in this file:
//   - an agent's visual state changes only on an event about a run of that agent;
//   - spend sums reconciled cost events only, and never counts an event twice;
//   - nothing is marked "done" or "error" without the matching run.end / run.error.

import { validateEvent } from '../shared/events.js';

export const AGENT_STATES = Object.freeze(['idle', 'thinking', 'tool-running', 'waiting', 'done', 'error']);

export function initialState() {
  return {
    connected: false,
    snapshotSeq: 0,
    lastSeq: 0,
    providers: {},
    policy: null, // router policy from the snapshot (worker / judge tiers)
    keystore: { path: '', problem: null },
    layout: { version: 1, rooms: [], objects: [], agents: [] },
    objectKinds: {},
    activeRun: null, // { runId, agentId, startedAt }
    runs: {}, // runId -> run view (see newRunView)
    runOrder: [], // newest last
    agentStates: {}, // agentId -> AGENT_STATES
    agentRuns: {}, // agentId -> runId of the run that last touched it
    pendingPrompts: [], // [{ promptId, runId, callId, tool, reason, input }]
    spend: { totalUsd: 0, reconciledTurns: 0, unreconciledTurns: 0 },
    invalidEvents: 0,
  };
}

function newRunView(payload) {
  return {
    runId: payload.runId,
    agentId: payload.agentId,
    provider: payload.provider,
    model: payload.model,
    prompt: payload.prompt,
    tools: payload.tools,
    maxTurns: payload.maxTurns,
    budgetUsd: payload.budgetUsd,
    status: 'running', // running | ended | error
    reason: null,
    turns: 0,
    items: [], // ordered transcript items: {kind:'text', text} | {kind:'tool', callId, name, input, result?} | {kind:'note', text} | {kind:'cost', ...}
    usage: { inputTokens: 0, outputTokens: 0 },
    spentUsd: 0,
    unreconciledTurns: 0,
    error: null,
  };
}

// Applies the /api/state snapshot. Replaces layout/providers/spend and marks the seq the
// snapshot already accounts for, so replayed cost events are not summed twice.
export function applySnapshot(state, snap) {
  const next = { ...state };
  next.snapshotSeq = snap.seq || 0;
  next.lastSeq = Math.max(state.lastSeq, next.snapshotSeq);
  next.providers = snap.providers || {};
  next.policy = snap.policy || null;
  next.keystore = snap.keystore || { path: '', problem: null };
  next.layout = snap.layout;
  next.objectKinds = snap.objectKinds || {};
  next.activeRun = snap.activeRun || null;
  next.spend = {
    totalUsd: snap.spend ? snap.spend.totalUsd : 0,
    reconciledTurns: snap.spend ? snap.spend.reconciledTurns : 0,
    unreconciledTurns: snap.spend ? snap.spend.unreconciledTurns : 0,
  };
  next.agentStates = { ...state.agentStates };
  for (const a of next.layout.agents) {
    if (!next.agentStates[a.id]) next.agentStates[a.id] = 'idle';
  }
  // The snapshot only knows that a run is active, not what it has done; the SSE replay
  // fills the detail. Until then the agent is "thinking" because a run.start happened.
  if (next.activeRun && next.agentStates[next.activeRun.agentId] === 'idle') {
    next.agentStates[next.activeRun.agentId] = 'thinking';
    next.agentRuns = { ...state.agentRuns, [next.activeRun.agentId]: next.activeRun.runId };
  }
  return next;
}

function setAgent(state, agentId, agentState, runId) {
  return {
    ...state,
    agentStates: { ...state.agentStates, [agentId]: agentState },
    agentRuns: { ...state.agentRuns, [agentId]: runId },
  };
}

function updateRun(state, runId, fn) {
  const run = state.runs[runId];
  if (!run) return state;
  return { ...state, runs: { ...state.runs, [runId]: fn(run) } };
}

export function applyEvent(state, event) {
  const v = validateEvent(event);
  if (!v.ok) return { ...state, invalidEvents: state.invalidEvents + 1 };
  const seq = typeof event.seq === 'number' ? event.seq : state.lastSeq + 1;
  const alreadyCounted = seq <= state.snapshotSeq; // the snapshot's spend already includes it
  let next = { ...state, lastSeq: Math.max(state.lastSeq, seq) };
  const p = event.payload;

  switch (event.type) {
    case 'agent.run.start': {
      const run = newRunView(p);
      next.runs = { ...next.runs, [p.runId]: run };
      next.runOrder = [...next.runOrder.filter((id) => id !== p.runId), p.runId];
      next.activeRun = { runId: p.runId, agentId: p.agentId, startedAt: event.ts };
      next = setAgent(next, p.agentId, 'thinking', p.runId);
      break;
    }
    case 'agent.token': {
      next = updateRun(next, p.runId, (run) => {
        const items = [...run.items];
        const last = items[items.length - 1];
        if (last && last.kind === 'text' && last.turn === p.turn) items[items.length - 1] = { ...last, text: last.text + p.text };
        else items.push({ kind: 'text', turn: p.turn, text: p.text });
        return { ...run, items, turns: Math.max(run.turns, p.turn) };
      });
      const run = next.runs[p.runId];
      if (run) next = setAgent(next, run.agentId, 'thinking', p.runId);
      break;
    }
    case 'agent.tool_call': {
      next = updateRun(next, p.runId, (run) => ({
        ...run,
        turns: Math.max(run.turns, p.turn),
        items: [...run.items, { kind: 'tool', turn: p.turn, callId: p.callId, name: p.name, input: p.input, result: null }],
      }));
      const run = next.runs[p.runId];
      if (run) next = setAgent(next, run.agentId, 'tool-running', p.runId);
      break;
    }
    case 'agent.tool_result': {
      next = updateRun(next, p.runId, (run) => ({
        ...run,
        items: run.items.map((it) => (it.kind === 'tool' && it.callId === p.callId ? { ...it, result: { ok: p.ok, output: p.output, error: p.error } } : it)),
      }));
      const run = next.runs[p.runId];
      if (run) {
        const stillRunning = run.items.some((it) => it.kind === 'tool' && !it.result);
        next = setAgent(next, run.agentId, stillRunning ? 'tool-running' : 'thinking', p.runId);
      }
      break;
    }
    case 'agent.run.end': {
      next = updateRun(next, p.runId, (run) => ({ ...run, status: 'ended', reason: p.reason, turns: p.turns, usage: p.usage }));
      const run = next.runs[p.runId];
      if (run) next = setAgent(next, run.agentId, 'done', p.runId);
      if (next.activeRun && next.activeRun.runId === p.runId) next.activeRun = null;
      next.pendingPrompts = next.pendingPrompts.filter((q) => q.runId !== p.runId);
      break;
    }
    case 'agent.run.error': {
      next = updateRun(next, p.runId, (run) => ({ ...run, status: 'error', reason: 'error', error: { message: p.message, code: p.code || null } }));
      const run = next.runs[p.runId];
      if (run) next = setAgent(next, run.agentId, 'error', p.runId);
      if (next.activeRun && next.activeRun.runId === p.runId) next.activeRun = null;
      next.pendingPrompts = next.pendingPrompts.filter((q) => q.runId !== p.runId);
      break;
    }
    case 'cost.estimate': {
      next = updateRun(next, p.runId, (run) => ({
        ...run,
        spentUsd: p.reconciled && typeof p.usd === 'number' ? run.spentUsd + p.usd : run.spentUsd,
        unreconciledTurns: p.reconciled ? run.unreconciledTurns : run.unreconciledTurns + 1,
        items: [...run.items, { kind: 'cost', turn: p.turn, tier: p.tier || null, provider: p.provider, model: p.model, inputTokens: p.inputTokens, outputTokens: p.outputTokens, usd: p.usd, reconciled: p.reconciled }],
      }));
      if (!alreadyCounted) {
        next.spend = p.reconciled && typeof p.usd === 'number'
          ? { ...next.spend, totalUsd: next.spend.totalUsd + p.usd, reconciledTurns: next.spend.reconciledTurns + 1 }
          : { ...next.spend, unreconciledTurns: next.spend.unreconciledTurns + 1 };
      }
      break;
    }
    case 'permission.prompt': {
      if (!next.pendingPrompts.some((q) => q.promptId === p.promptId)) {
        next.pendingPrompts = [...next.pendingPrompts, { ...p }];
      }
      const run = next.runs[p.runId];
      if (run && run.status === 'running') next = setAgent(next, run.agentId, 'waiting', p.runId);
      break;
    }
    case 'permission.response': {
      next.pendingPrompts = next.pendingPrompts.filter((q) => q.promptId !== p.promptId);
      next = updateRun(next, p.runId, (run) => ({
        ...run,
        items: [...run.items, { kind: 'note', text: `${p.allow ? 'Allowed' : 'Denied'} at the Entrance Gate` }],
      }));
      const run = next.runs[p.runId];
      if (run && run.status === 'running' && !next.pendingPrompts.some((q) => q.runId === p.runId)) {
        next = setAgent(next, run.agentId, 'tool-running', p.runId);
      }
      break;
    }
    case 'object.place': {
      if (!next.layout.objects.some((o) => o.id === p.objectId)) {
        next.layout = { ...next.layout, objects: [...next.layout.objects, { id: p.objectId, kind: p.kind, roomId: p.roomId, x: p.x, y: p.y }] };
      }
      break;
    }
    case 'object.reclaim': {
      next.layout = { ...next.layout, objects: next.layout.objects.filter((o) => o.id !== p.objectId) };
      break;
    }
    default:
      break;
  }
  return next;
}

// Tools granted to an agent by the current layout (mirrors shared/world.js grantsFor, but
// uses the snapshot's objectKinds so the frontend never hardcodes the mapping).
export function grantedTools(state, agentId) {
  const agent = state.layout.agents.find((a) => a.id === agentId);
  if (!agent) return [];
  const out = new Set();
  for (const o of state.layout.objects) {
    if (o.roomId !== agent.roomId) continue;
    const kind = state.objectKinds[o.kind];
    if (kind) for (const t of kind.grants || []) out.add(t);
  }
  return [...out].sort();
}

export function currentRun(state) {
  const id = state.activeRun ? state.activeRun.runId : state.runOrder[state.runOrder.length - 1];
  return id ? state.runs[id] || null : null;
}
